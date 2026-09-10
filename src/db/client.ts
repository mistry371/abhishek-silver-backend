import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Database = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything that can run queries: the pool or an open transaction. */
export type Executor = Database | Tx;

export interface Connection {
  db: Database;
  driver: "pglite" | "postgres";
  migrate(): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS_FOLDER = resolve(process.cwd(), "drizzle");

/**
 * Supabase exposes the `public` schema through its Data API using the anon key.
 * Every read and write goes through this backend (which connects as the table
 * owner), so row-level security is enabled with no policies: direct anon or
 * authenticated access to these tables is denied.
 */
const ENABLE_RLS_SQL = `
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;`;

export interface ConnectOptions {
  /** PostgreSQL connection string (Supabase). When absent, embedded PGlite is used. */
  databaseUrl?: string;
  /** PGlite data directory, or "memory://" for an in-memory database. */
  pgliteDataDir?: string;
}

export async function createConnection({ databaseUrl, pgliteDataDir = ".pglite" }: ConnectOptions): Promise<Connection> {
  if (databaseUrl) {
    // `prepare: false` keeps the client compatible with Supabase's transaction pooler.
    const client = postgres(databaseUrl, { prepare: false, max: 10 });
    const db = drizzlePostgres(client, { schema }) as unknown as Database;
    return {
      db,
      driver: "postgres",
      migrate: async () => {
        await migratePostgres(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
        await client.unsafe(ENABLE_RLS_SQL);
      },
      close: () => client.end(),
    };
  }

  const client = pgliteDataDir === "memory://" ? new PGlite() : new PGlite(resolve(process.cwd(), pgliteDataDir));
  await client.waitReady;
  const db = drizzlePglite(client, { schema }) as unknown as Database;
  return {
    db,
    driver: "pglite",
    migrate: () => migratePglite(db as never, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => client.close(),
  };
}

let current: Connection | null = null;

export function setConnection(connection: Connection | null) {
  current = connection;
}

/** The active database. Call `setConnection` during startup first. */
export function db(): Database {
  if (!current) throw new Error("Database connection has not been initialised");
  return current.db;
}

export function connection(): Connection {
  if (!current) throw new Error("Database connection has not been initialised");
  return current;
}
