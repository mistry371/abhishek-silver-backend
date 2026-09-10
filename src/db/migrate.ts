import { env } from "@/config/env";
import { logger } from "@/lib/logger";
import { createConnection } from "./client";

const connection = await createConnection({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR });
try {
  await connection.migrate();
  logger.info({ database: connection.driver }, "Migrations applied");
} finally {
  await connection.close();
}
