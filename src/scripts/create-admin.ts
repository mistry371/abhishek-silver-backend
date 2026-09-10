import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { env } from "@/config/env";
import { createConnection, setConnection } from "@/db/client";
import { adminUsers, roles } from "@/db/schema";
import { zEmail, zPassword } from "@/lib/validation";
import { SYSTEM_ACTOR, recordAudit } from "@/services/audit";

/**
 * Creates (or links) an admin account from the command line — used to add the
 * first Super Admin after connecting Supabase.
 *
 *   ADMIN_PASSWORD=... npm run admin:create -- --email owner@example.com --name "Owner"
 *   npm run admin:create -- --email owner@example.com --name "Owner" --auth-user-id <supabase user id>
 *
 * The password is read from the ADMIN_PASSWORD environment variable so it never
 * appears in shell history, and it is never printed or stored by this API.
 */
const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    role: { type: "string", default: "super_admin" },
    "auth-user-id": { type: "string" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!values.email || !values.name) {
  fail('Usage: npm run admin:create -- --email <email> --name "<name>" [--role super_admin] [--auth-user-id <uuid>]');
}

const email = zEmail.safeParse(values.email);
if (!email.success) fail("Enter a valid email address.");

const connection = await createConnection({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR });
setConnection(connection);

try {
  const [role] = await connection.db.select().from(roles).where(eq(roles.id, values.role!)).limit(1);
  if (!role) fail(`Unknown role "${values.role}". Run migrations and the essentials seed first (npm run db:seed -- --essentials).`);

  const [existing] = await connection.db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, email.data)).limit(1);
  if (existing) fail(`${email.data} is already an admin.`);

  let authUserId = values["auth-user-id"];
  if (!authUserId) {
    const password = zPassword.safeParse(process.env.ADMIN_PASSWORD ?? "");
    if (!password.success) {
      fail("Set ADMIN_PASSWORD (8+ characters with a letter and a number), or pass --auth-user-id for an existing Supabase user.");
    }
    authUserId = (await auth().createUser({ email: email.data, password: password.data })).userId;
  }

  const [user] = await connection.db.insert(adminUsers).values({ authUserId, name: values.name!, email: email.data, roleId: role.id }).returning();
  await recordAudit(connection.db, { ...SYSTEM_ACTOR, name: "Command line" }, {
    module: "settings",
    action: "user.create",
    entityType: "admin_user",
    entityId: user!.id,
    entityLabel: email.data,
    after: { roleId: role.id },
    sensitive: true,
  });
  console.log(`Created ${role.name} account for ${email.data}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await connection.close();
}
