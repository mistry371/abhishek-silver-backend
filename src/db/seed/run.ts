import { env } from "@/config/env";
import { logger } from "@/lib/logger";
import { createConnection, setConnection } from "../client";
import { seedDatabase } from "./index";

/**
 * npm run db:seed                 → essentials + demo catalogue/content (local development)
 * npm run db:seed -- --essentials → roles, settings, locations, store contact & CMS pages only
 */
const connection = await createConnection({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR });
setConnection(connection);
try {
  await connection.migrate();
  await seedDatabase({ demo: !process.argv.includes("--essentials") });
} catch (error) {
  logger.error({ err: error }, "Seeding failed");
  process.exitCode = 1;
} finally {
  await connection.close();
}
