import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";
import { createRemoteJWKSet, decodeProtectedHeader, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import { env } from "@/config/env";
import { AppError, invalid, notFound, unauthorized } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { normalizeIndianMobile, toE164 } from "@/lib/phone";
import type { AuthIdentity, AuthProvider, AuthTokens } from "./types";

/**
 * SUPABASE AUTH PROVIDER
 * ------------------------------------------------------------------
 * Supabase owns credentials (passwords, SMS OTP). This API verifies Supabase
 * access tokens with jose — via the project's JWKS (asymmetric signing keys)
 * or SUPABASE_JWT_SECRET for legacy HS256 projects — and keeps customer
 * profiles, admin users, roles and permissions in our own tables.
 */

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/** A fresh client per call so no session state is shared between requests. */
const anonClient = () => createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, clientOptions);

let serviceClient: SupabaseClient | null = null;
const service = () => (serviceClient ??= createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, clientOptions));

interface SupabaseLikeError {
  name?: string;
  code?: string;
  status?: number;
  message?: string;
}

function mapError(error: SupabaseLikeError, context: string): AppError {
  switch (error.code) {
    case "invalid_credentials":
      return unauthorized("The email/mobile number or password you entered is incorrect.");
    case "email_exists":
    case "user_already_exists":
      return invalid({ email: "An account with this email already exists." });
    case "phone_exists":
      return invalid({ phone: "An account with this mobile number already exists." });
    case "weak_password":
      return invalid({ password: "Please choose a stronger password." });
    case "otp_expired":
    case "otp_disabled":
      return invalid({ otp: "The code you entered is incorrect or has expired." });
    case "user_not_found":
      return notFound("No account is linked to this mobile number. Please create an account.");
    case "over_request_rate_limit":
    case "over_sms_send_rate_limit":
    case "over_email_send_rate_limit":
      return new AppError("rate_limited");
    case "email_not_confirmed":
      return unauthorized("Please confirm your email address, then sign in.");
    default:
      if (error.status === 429) return new AppError("rate_limited");
      logger.error({ code: error.code, status: error.status, message: error.message, context }, "Supabase auth request failed");
      if (error.name === "AuthRetryableFetchError") {
        return new AppError("server_error", "The server can't reach the sign-in service (check SUPABASE_URL and the Supabase keys on the API). Please try again shortly.");
      }
      if (error.status === 401 || error.status === 403) {
        // Supabase rejected the project key itself (not the user's password).
        return new AppError("server_error", "Sign-in isn't configured correctly on the server (Supabase URL or keys). Please check the API settings.");
      }
      return new AppError("server_error");
  }
}

function identityOf(user: Pick<User, "id" | "email" | "phone">): AuthIdentity {
  return { userId: user.id, email: user.email ?? null, phone: user.phone ? normalizeIndianMobile(user.phone) : null };
}

function tokensOf(session: Session | null): AuthTokens {
  if (!session) throw new AppError("validation_error", "Please confirm your email address, then sign in.");
  const expiresAt = session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in;
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    identity: identityOf(session.user),
  };
}

export class SupabaseAuthProvider implements AuthProvider {
  readonly name = "supabase" as const;
  private readonly issuer = `${env.SUPABASE_URL!.replace(/\/$/, "")}/auth/v1`;
  private readonly jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  private readonly legacySecret = env.SUPABASE_JWT_SECRET ? new TextEncoder().encode(env.SUPABASE_JWT_SECRET) : null;

  async verifyAccessToken(token: string): Promise<AuthIdentity> {
    let payload: JWTPayload;
    try {
      const { alg } = decodeProtectedHeader(token);
      const options = { issuer: this.issuer, audience: "authenticated" };
      if (alg === "HS256") {
        if (!this.legacySecret) throw unauthorized();
        ({ payload } = await jwtVerify(token, this.legacySecret, { ...options, algorithms: ["HS256"] }));
      } else {
        ({ payload } = await jwtVerify(token, this.jwks, options));
      }
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) throw new AppError("session_expired");
      throw unauthorized();
    }
    if (!payload.sub || payload.role !== "authenticated") throw unauthorized();
    const phone = typeof payload.phone === "string" && payload.phone ? normalizeIndianMobile(payload.phone) : null;
    return { userId: payload.sub, email: typeof payload.email === "string" && payload.email ? payload.email : null, phone };
  }

  async signInWithPassword({ email, phone, password }: { email?: string; phone?: string; password: string }) {
    const credentials = email ? { email, password } : { phone: toE164(phone ?? ""), password };
    const { data, error } = await anonClient().auth.signInWithPassword(credentials);
    if (error) throw mapError(error, "signInWithPassword");
    return tokensOf(data.session);
  }

  async signUp({ email, phone, password }: { email: string; phone: string; password: string }) {
    // Created server-side so the phone identity exists for OTP sign-in later.
    // Email confirmation is not enforced here — change if the business requires it.
    await this.createUser({ email, phone, password });
    return this.signInWithPassword({ email, password });
  }

  async requestPhoneOtp(phone: string) {
    const { error } = await anonClient().auth.signInWithOtp({ phone: toE164(phone), options: { shouldCreateUser: false } });
    // Unknown numbers are reported at verification, so this response never reveals whether an account exists.
    if (error && error.code !== "otp_disabled" && error.code !== "user_not_found") throw mapError(error, "signInWithOtp");
    return { expiresInSeconds: 300 };
  }

  async verifyPhoneOtp(phone: string, code: string) {
    const { data, error } = await anonClient().auth.verifyOtp({ phone: toE164(phone), token: code.trim(), type: "sms" });
    if (error) throw mapError(error, "verifyOtp");
    return tokensOf(data.session);
  }

  async requestPasswordReset(email: string) {
    const { error } = await anonClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/account/reset-password`,
    });
    if (error && (error.status === 429 || error.code?.startsWith("over_"))) throw mapError(error, "resetPasswordForEmail");
  }

  async changePassword(identity: AuthIdentity, currentPassword: string, newPassword: string) {
    try {
      await this.signInWithPassword(identity.email ? { email: identity.email, password: currentPassword } : { phone: identity.phone ?? "", password: currentPassword });
    } catch (error) {
      if (error instanceof AppError && error.code === "unauthorized") {
        throw invalid({ currentPassword: "Your current password is incorrect." });
      }
      throw error;
    }
    await this.setPassword(identity.userId, newPassword);
  }

  async refresh(refreshToken: string) {
    const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw error.status === 400 || error.status === 401 ? new AppError("session_expired") : mapError(error, "refreshSession");
    return tokensOf(data.session);
  }

  async signOut(accessToken: string) {
    const { error } = await service().auth.admin.signOut(accessToken, "local");
    if (error) logger.warn({ code: error.code }, "Supabase sign-out failed");
  }

  async createUser({ email, password, phone }: { email: string; password: string; phone?: string | null }) {
    const { data, error } = await service().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      ...(phone ? { phone: toE164(phone) } : {}),
    });
    if (error || !data.user) throw mapError(error ?? {}, "admin.createUser");
    return identityOf(data.user);
  }

  async setPassword(userId: string, password: string) {
    const { error } = await service().auth.admin.updateUserById(userId, { password });
    if (error) throw mapError(error, "admin.updateUserById");
  }
}
