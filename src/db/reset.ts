import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { env } from "@/config/env";
import { logger } from "@/lib/logger";
import { createConnection, setConnection } from "./client";
import { seedDatabase } from "./seed";

/** Recreates the LOCAL embedded database. Refuses to touch a remote (Supabase) database. */
if (env.DATABASE_URL) {
  logger.error("db:reset only resets the local PGlite database. Unset DATABASE_URL to use it.");
  process.exit(1);
}

await rm(resolve(process.cwd(), env.PGLITE_DATA_DIR), { recursive: true, force: true });
const connection = await createConnection({ pgliteDataDir: env.PGLITE_DATA_DIR });
setConnection(connection);
try {
  await connection.migrate();
  await seedDatabase({ demo: !process.argv.includes("--essentials") });
  logger.info("Local database reset");
} finally {
  await connection.close();
}
