import { count } from "drizzle-orm";
import { auth } from "@/auth";
import { SUPER_ADMIN_ROLE } from "@/auth/permissions";
import { env } from "@/config/env";
import { createConnection, setConnection } from "@/db/client";
import { adminUsers, roles } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { reportInitialAdminIssue } from "@/services/diagnostics";
import { createApp } from "./app";

const connection = await createConnection({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR });
setConnection(connection);

if (connection.driver === "pglite") {
  // Local development convenience: embedded database is migrated (and seeded when empty) on start.
  await connection.migrate();
  const [{ value }] = await connection.db.select({ value: count() }).from(roles);
  if (value === 0) {
    logger.info("Empty local database — seeding demo data");
    await seedDatabase({ demo: true });
  }
} else if (env.MIGRATE_ON_START) {
  // Hosted deploys without a shell: tables, roles, settings and store content are prepared on start (idempotent).
  await connection.migrate();
  await seedDatabase({ demo: false });
  logger.info("Database migrated and essential data ensured");
}

/** Creates the first Super Admin from INITIAL_ADMIN_* when the business has no admin yet. */
async function ensureInitialAdmin() {
  if (!env.INITIAL_ADMIN_EMAIL || !env.INITIAL_ADMIN_PASSWORD) return;
  const [{ value }] = await connection.db.select({ value: count() }).from(adminUsers);
  if (value > 0) return;
  const email = env.INITIAL_ADMIN_EMAIL.trim().toLowerCase();
  const password = env.INITIAL_ADMIN_PASSWORD;
  try {
    let identity;
    try {
      identity = await auth().createUser({ email, password });
    } catch (error) {
      // The owner may already have a sign-in account with this email — link it when the password matches.
      if (!(error instanceof AppError && error.fieldErrors?.email)) throw error;
      try {
        identity = (await auth().signInWithPassword({ email, password })).identity;
      } catch {
        throw new Error("A Supabase user with INITIAL_ADMIN_EMAIL already exists with a different password. Reset it in Supabase (Authentication → Users) or use another email.");
      }
    }
    await connection.db.insert(adminUsers).values({ authUserId: identity.userId, name: env.INITIAL_ADMIN_NAME?.trim() || "Owner", email, roleId: SUPER_ADMIN_ROLE });
    reportInitialAdminIssue(null);
    logger.info({ email }, "Initial Super Admin created");
  } catch (error) {
    logger.error({ err: error, email }, "Could not create the initial Super Admin");
    const detail =
      error instanceof AppError && error.fieldErrors ? Object.values(error.fieldErrors).join(" ") : error instanceof Error ? error.message : "unknown error";
    reportInitialAdminIssue(detail);
  }
}
await ensureInitialAdmin();

const server = createApp().listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, prefix: env.API_PREFIX, database: connection.driver, auth: env.AUTH_PROVIDER, payments: env.PAYMENT_PROVIDER },
    "Abhishek Silver API listening",
  );
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  server.close(async () => {
    await connection.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
