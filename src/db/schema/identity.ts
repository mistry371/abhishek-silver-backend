import { boolean, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./common";

/**
 * Local development auth provider only (AUTH_PROVIDER=local).
 * With Supabase Auth these identities live in Supabase's `auth.users`.
 */
export const localAuthUsers = pgTable("auth_local_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").unique(),
  phone: text("phone").unique(),
  passwordHash: text("password_hash"),
  lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const otpChallenges = pgTable(
  "auth_otp_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("auth_otp_phone_idx").on(t.phone)],
);

/* ------------------------------------------------------------------ */
/* RBAC                                                                */
/* ------------------------------------------------------------------ */

export const roles = pgTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Supabase `auth.users.id` (or local provider id). */
    authUserId: uuid("auth_user_id").notNull().unique(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    mobile: text("mobile"),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id),
    status: text("status").$type<"active" | "disabled">().notNull().default("active"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("admin_users_role_idx").on(t.roleId)],
);
