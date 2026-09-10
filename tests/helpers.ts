import request from "supertest";
import { createApp } from "@/app";
import { createConnection, setConnection } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { invalidateCatalog } from "@/modules/catalog/snapshot";

/** A fresh in-memory PostgreSQL (PGlite), migrated and seeded with the demo catalogue. */
export async function setupApp() {
  const connection = await createConnection({ pgliteDataDir: "memory://" });
  setConnection(connection);
  await connection.migrate();
  await seedDatabase({ demo: true });
  invalidateCatalog();
  const app = createApp();
  return { app, connection, api: () => request(app) };
}

export async function adminToken(app: Parameters<typeof request>[0], email: string) {
  const response = await request(app).post("/v1/admin/auth/login").send({ email, password: "Admin@12345" });
  if (response.status !== 200) throw new Error(`Admin login failed for ${email}: ${response.status}`);
  return response.body.accessToken as string;
}

export const address = {
  fullName: "Test Buyer",
  phone: "9876543210",
  line1: "1 Test Street",
  city: "Surat",
  state: "Gujarat",
  postalCode: "395003",
  country: "India",
};
