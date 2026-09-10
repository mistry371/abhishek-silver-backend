import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { auth } from "@/auth";
import { permissionGroups } from "@/auth/permissions";
import { db } from "@/db/client";
import { adminUsers } from "@/db/schema";
import { adminOf, bearerToken, loadAdminContext, requireAdmin } from "@/http/auth";
import { rateLimit } from "@/http/middleware";
import { AppError } from "@/lib/errors";
import { parse, zEmail } from "@/lib/validation";
import { actorOf, recordAudit } from "@/services/audit";
import { toAdminDto } from "./presenter";

export const adminAuthRouter = Router();

const limiter = rateLimit({ name: "admin-auth", windowMs: 15 * 60_000, max: 10 });

adminAuthRouter.post("/auth/login", limiter, async (req, res) => {
  const { email, password } = parse(z.object({ email: zEmail, password: z.string().min(1).max(200) }), req.body);
  try {
    const tokens = await auth().signInWithPassword({ email, password });
    const admin = await loadAdminContext(tokens.identity);
    await db().update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, admin.id));
    await recordAudit(db(), { ...actorOf(req), adminId: admin.id, name: admin.name, role: admin.roleName }, {
      module: "settings",
      action: "auth.login",
      entityType: "admin_user",
      entityId: admin.id,
      entityLabel: admin.email,
    });
    res.json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, admin: toAdminDto(admin) });
  } catch (error) {
    if (error instanceof AppError && (error.code === "unauthorized" || error.code === "forbidden")) {
      await recordAudit(db(), actorOf(req), {
        module: "settings",
        action: "auth.login_failed",
        entityType: "admin_user",
        entityLabel: email,
        sensitive: true,
      });
      // One message for wrong password and non-admin accounts, so staff emails can't be probed.
      throw new AppError("unauthorized", "The email or password is incorrect, or this account doesn't have admin access.");
    }
    throw error;
  }
});

adminAuthRouter.post("/auth/refresh", limiter, async (req, res) => {
  const { refreshToken } = parse(z.object({ refreshToken: z.string().min(1).max(4000) }), req.body);
  const tokens = await auth().refresh(refreshToken);
  const admin = await loadAdminContext(tokens.identity);
  res.json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, admin: toAdminDto(admin) });
});

adminAuthRouter.get("/auth/me", requireAdmin, (req, res) => {
  res.json({ admin: toAdminDto(adminOf(req)), permissionGroups });
});

adminAuthRouter.post("/auth/logout", async (req, res) => {
  const token = bearerToken(req);
  if (token) await auth().signOut(token);
  res.status(204).end();
});
