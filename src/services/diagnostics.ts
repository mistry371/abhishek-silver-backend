import { timingSafeEqual } from "node:crypto";
import { count, sql } from "drizzle-orm";
import { env } from "@/config/env";
import { db } from "@/db/client";
import { adminUsers, roles } from "@/db/schema";
import { instagramStatus } from "@/services/instagram";
import { describeStorageBuckets } from "@/services/storage";

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
    const failure = error as { name?: string; message?: string; cause?: { name?: string; code?: string; message?: string } };
    // Header errors can echo the key, so messages are only classified, never returned.
    if (/ByteString|header/i.test(`${failure.message} ${failure.cause?.message}`)) {
      return "key has characters that aren't allowed (line breaks or •••• from a masked key) — copy it again from Supabase";
    }
    return `unreachable (${failure.cause?.code ?? failure.cause?.name ?? failure.name ?? "error"}) — check SUPABASE_URL`;
  }
}

/** Describes a key without revealing it: type, length and paste problems. */
function keyFormat(name: "SUPABASE_ANON_KEY" | "SUPABASE_SERVICE_ROLE_KEY", key: string | undefined) {
  if (!key) return "missing";
  const raw = process.env[name] ?? "";
  const kind = key.startsWith("eyJ") ? "legacy JWT key" : key.startsWith("sb_publishable_") ? "publishable key" : key.startsWith("sb_secret_") ? "secret key" : "unrecognised key";
  const notes = [
    /\s/.test(raw.trim()) && "had spaces/line breaks (removed)",
    /[^\x20-\x7e\s]/.test(raw) && "has special characters such as •••• (masked copy)",
    name === "SUPABASE_SERVICE_ROLE_KEY" && kind === "publishable key" && "this is the public key — use the secret/service_role key",
    name === "SUPABASE_ANON_KEY" && kind === "secret key" && "this is the secret key — use the anon/publishable key",
  ].filter(Boolean);
  return [`${kind}, ${key.length} chars`, ...notes].join("; ");
}

export async function runDiagnostics() {
  const report: Record<string, unknown> = {
    // Render sets RENDER_GIT_COMMIT on every deploy, so this says exactly which build is running.
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "unknown",
    features: { imports: true },
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
    report.supabaseAnonKeyFormat = keyFormat("SUPABASE_ANON_KEY", env.SUPABASE_ANON_KEY);
    report.supabaseServiceRoleKeyFormat = keyFormat("SUPABASE_SERVICE_ROLE_KEY", env.SUPABASE_SERVICE_ROLE_KEY);
  }

  if (env.STORAGE_PROVIDER === "supabase") {
    report.storageBuckets = await describeStorageBuckets().catch(() => "unavailable");
  }

  report.instagram = await instagramStatus().catch(() => "unavailable");

  report.initialAdminEmailSet = Boolean(env.INITIAL_ADMIN_EMAIL);
  report.initialAdminEmailLooksValid = env.INITIAL_ADMIN_EMAIL ? /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(env.INITIAL_ADMIN_EMAIL.trim()) : null;
  report.initialAdminPasswordSet = Boolean(env.INITIAL_ADMIN_PASSWORD);
  report.initialAdminIssue = initialAdminIssue;
  report.corsOrigins = env.CORS_ORIGINS;
  return report;
}
