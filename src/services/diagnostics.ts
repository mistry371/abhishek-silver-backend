import { timingSafeEqual } from "node:crypto";
import { count, sql } from "drizzle-orm";
import { env } from "@/config/env";
import { db } from "@/db/client";
import { adminUsers, roles } from "@/db/schema";

/**
 * Deployment diagnostics (`GET /health?deep=1`, bearer = STOREFRONT_REVALIDATE_SECRET).
 * Reports only whether each dependency works — never keys, emails or data.
 */

let initialAdminIssue: string | null = null;

export function reportInitialAdminIssue(issue: string | null) {
  initialAdminIssue = issue;
}

export function diagnosticsAuthorised(header: string | undefined) {
  const secret = env.STOREFRONT_REVALIDATE_SECRET;
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function probeSupabase(path: string, key: string | undefined) {
  if (!env.SUPABASE_URL) return "SUPABASE_URL missing";
  if (!key) return "key missing";
  try {
    const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}${path}`, {
      headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return "ok";
    if (response.status === 401 || response.status === 403) return `rejected (${response.status}) — wrong key or key from another project`;
    return `unexpected status ${response.status}`;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error instanceof Error ? error.name : "error");
    return `unreachable (${cause}) — check SUPABASE_URL`;
  }
}

export async function runDiagnostics() {
  const report: Record<string, unknown> = {
    authProvider: env.AUTH_PROVIDER,
    storageProvider: env.STORAGE_PROVIDER,
    paymentProvider: env.PAYMENT_PROVIDER,
  };

  try {
    await db().execute(sql`select 1`);
    report.database = "ok";
    const [roleCount] = await db().select({ value: count() }).from(roles);
    const [adminCount] = await db().select({ value: count() }).from(adminUsers);
    report.rolesSeeded = (roleCount?.value ?? 0) > 0;
    report.adminAccounts = adminCount?.value ?? 0;
  } catch {
    report.database = "error";
  }

  if (env.AUTH_PROVIDER === "supabase") {
    // The project URL is public (it ships in client apps); keys are never reported.
    report.supabaseUrl = env.SUPABASE_URL;
    report.supabaseAnonKey = await probeSupabase("/auth/v1/settings", env.SUPABASE_ANON_KEY);
    report.supabaseServiceRoleKey = await probeSupabase("/auth/v1/admin/users?page=1&per_page=1", env.SUPABASE_SERVICE_ROLE_KEY);
  }

  report.initialAdminEmailSet = Boolean(env.INITIAL_ADMIN_EMAIL);
  report.initialAdminEmailLooksValid = env.INITIAL_ADMIN_EMAIL ? /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(env.INITIAL_ADMIN_EMAIL.trim()) : null;
  report.initialAdminPasswordSet = Boolean(env.INITIAL_ADMIN_PASSWORD);
  report.initialAdminIssue = initialAdminIssue;
  report.corsOrigins = env.CORS_ORIGINS;
  return report;
}
