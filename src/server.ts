import { count } from "drizzle-orm";
import { env } from "@/config/env";
import { createConnection, setConnection } from "@/db/client";
import { roles } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { logger } from "@/lib/logger";
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
}

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
