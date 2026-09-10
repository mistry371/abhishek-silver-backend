import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { errors as joseErrors, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { env } from "@/config/env";
import { db } from "@/db/client";
import { localAuthUsers, otpChallenges } from "@/db/schema";
import { AppError, invalid, notFound, unauthorized } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { hashPassword, verifyPassword } from "./passwords";
import type { AuthIdentity, AuthProvider, AuthTokens } from "./types";

/**
 * LOCAL DEVELOPMENT AUTH PROVIDER
 * ------------------------------------------------------------------
 * Stands in for Supabase Auth until the Supabase project is created.
 * Tokens mirror Supabase's claim shape (sub, email, phone, role, aud) so
 * nothing else changes when AUTH_PROVIDER switches to "supabase".
 * Refused in production by env validation.
 */

const ISSUER = "abhishek-silver-local";
const ACCESS_AUDIENCE = "authenticated";
const REFRESH_AUDIENCE = "refresh";
const ACCESS_TTL_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const OTP_TTL_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 5;

const secret = () => new TextEncoder().encode(env.LOCAL_JWT_SECRET);

type LocalUser = typeof localAuthUsers.$inferSelect;

const identityOf = (user: LocalUser): AuthIdentity => ({ userId: user.id, email: user.email, phone: user.phone });

function otpHash(phone: string, code: string) {
  return createHmac("sha256", env.LOCAL_JWT_SECRET ?? "").update(`${phone}:${code}`).digest("hex");
}

export class LocalAuthProvider implements AuthProvider {
  readonly name = "local" as const;

  private async issue(user: LocalUser): Promise<AuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await new SignJWT({ email: user.email, phone: user.phone, role: "authenticated" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + ACCESS_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(secret());
    const refreshToken = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience(REFRESH_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + REFRESH_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(secret());
    await db().update(localAuthUsers).set({ lastSignInAt: new Date() }).where(eq(localAuthUsers.id, user.id));
    return {
      accessToken,
      refreshToken,
      expiresAt: new Date((now + ACCESS_TTL_SECONDS) * 1000).toISOString(),
      identity: identityOf(user),
    };
  }

  private async verify(token: string, audience: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, audience, algorithms: ["HS256"] });
      if (!payload.sub) throw unauthorized();
      return payload;
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) throw new AppError("session_expired");
      throw unauthorized();
    }
  }

  async verifyAccessToken(token: string): Promise<AuthIdentity> {
    const payload = await this.verify(token, ACCESS_AUDIENCE);
    const [user] = await db().select().from(localAuthUsers).where(eq(localAuthUsers.id, payload.sub!)).limit(1);
    if (!user) throw unauthorized();
    return identityOf(user);
  }

  async signInWithPassword({ email, phone, password }: { email?: string; phone?: string; password: string }) {
    const condition = email ? eq(localAuthUsers.email, email) : phone ? eq(localAuthUsers.phone, phone) : sql`false`;
    const [user] = await db().select().from(localAuthUsers).where(condition).limit(1);
    const ok = await verifyPassword(password, user?.passwordHash);
    if (!user || !ok) throw unauthorized("The email/mobile number or password you entered is incorrect.");
    return this.issue(user);
  }

  async signUp({ email, phone, password }: { email: string; phone: string; password: string }) {
    const identity = await this.createUser({ email, phone, password });
    const [user] = await db().select().from(localAuthUsers).where(eq(localAuthUsers.id, identity.userId)).limit(1);
    return this.issue(user!);
  }

  async requestPhoneOtp(phone: string) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await db()
      .insert(otpChallenges)
      .values({ phone, codeHash: otpHash(phone, code), expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000) });
    logger.info({ phone: `******${phone.slice(-4)}` }, "Local auth: OTP generated (no SMS is sent in development)");
    // Development only: returned so the storefront can show it. Supabase sends real SMS.
    return { expiresInSeconds: OTP_TTL_SECONDS, demoCode: code };
  }

  async verifyPhoneOtp(phone: string, code: string) {
    const wrongCode = () => invalid({ otp: "The code you entered is incorrect or has expired." });
    const [challenge] = await db()
      .select()
      .from(otpChallenges)
      .where(and(eq(otpChallenges.phone, phone), isNull(otpChallenges.consumedAt), gt(otpChallenges.expiresAt, new Date())))
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1);
    if (!challenge) throw wrongCode();
    if (challenge.attempts >= OTP_MAX_ATTEMPTS) throw new AppError("rate_limited");

    const expected = Buffer.from(challenge.codeHash, "hex");
    const actual = Buffer.from(otpHash(phone, code.trim()), "hex");
    if (!timingSafeEqual(expected, actual)) {
      await db()
        .update(otpChallenges)
        .set({ attempts: challenge.attempts + 1 })
        .where(eq(otpChallenges.id, challenge.id));
      throw wrongCode();
    }
    await db().update(otpChallenges).set({ consumedAt: new Date() }).where(eq(otpChallenges.id, challenge.id));

    const [user] = await db().select().from(localAuthUsers).where(eq(localAuthUsers.phone, phone)).limit(1);
    if (!user) throw notFound("No account is linked to this mobile number. Please create an account.");
    return this.issue(user);
  }

  async requestPasswordReset(email: string) {
    // No email delivery in local development. Response never reveals whether the account exists.
    logger.info({ email: email.replace(/^(.{2}).*(@.*)$/, "$1***$2") }, "Local auth: password reset requested (no email sent)");
  }

  async changePassword(identity: AuthIdentity, currentPassword: string, newPassword: string) {
    const [user] = await db().select().from(localAuthUsers).where(eq(localAuthUsers.id, identity.userId)).limit(1);
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw invalid({ currentPassword: "Your current password is incorrect." });
    }
    await this.setPassword(user.id, newPassword);
  }

  async refresh(refreshToken: string) {
    const payload = await this.verify(refreshToken, REFRESH_AUDIENCE);
    const [user] = await db().select().from(localAuthUsers).where(eq(localAuthUsers.id, payload.sub!)).limit(1);
    if (!user) throw unauthorized();
    return this.issue(user);
  }

  async signOut() {
    // Stateless tokens: the client discards them. They expire after ACCESS_TTL_SECONDS.
  }

  async createUser({ email, password, phone }: { email: string; password: string; phone?: string | null }) {
    const fieldErrors: Record<string, string> = {};
    const [byEmail] = await db().select({ id: localAuthUsers.id }).from(localAuthUsers).where(eq(localAuthUsers.email, email)).limit(1);
    if (byEmail) fieldErrors.email = "An account with this email already exists.";
    if (phone) {
      const [byPhone] = await db().select({ id: localAuthUsers.id }).from(localAuthUsers).where(eq(localAuthUsers.phone, phone)).limit(1);
      if (byPhone) fieldErrors.phone = "An account with this mobile number already exists.";
    }
    if (Object.keys(fieldErrors).length) throw invalid(fieldErrors);

    const [user] = await db()
      .insert(localAuthUsers)
      .values({ email, phone: phone ?? null, passwordHash: await hashPassword(password) })
      .returning();
    return identityOf(user!);
  }

  async setPassword(userId: string, password: string) {
    await db()
      .update(localAuthUsers)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(localAuthUsers.id, userId));
  }
}
