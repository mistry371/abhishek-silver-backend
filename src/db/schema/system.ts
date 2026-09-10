import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt } from "./common";
import { adminUsers } from "./identity";

/**
 * Append-only audit trail. Sensitive actions (stock adjustments, purchase
 * approval, invoice finalisation, price changes, order status changes,
 * customer edits, permission changes, expense approval) are flagged.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorAdminId: uuid("actor_admin_id").references(() => adminUsers.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull(),
    actorRole: text("actor_role"),
    module: text("module").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    entityLabel: text("entity_label"),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    reason: text("reason"),
    reference: text("reference"),
    sensitive: boolean("sensitive").notNull().default(false),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_created_idx").on(t.createdAt),
    index("audit_logs_module_idx").on(t.module, t.createdAt),
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_actor_idx").on(t.actorAdminId),
  ],
);

export type NotificationType =
  | "new_order"
  | "payment_failed"
  | "low_stock"
  | "out_of_stock"
  | "unusual_stock_change"
  | "stock_conflict"
  | "new_enquiry"
  | "purchase_pending"
  | "expense_submitted";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").$type<NotificationType>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    href: text("href"),
    /** Only admins holding this permission see the notification. */
    permission: text("permission").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_created_idx").on(t.createdAt)],
);

export const notificationReads = pgTable(
  "notification_reads",
  {
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    adminUserId: uuid("admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.notificationId, t.adminUserId] })],
);

/** Business configuration documents (general, inventory, billing, expenses). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedByName: text("updated_by_name").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Gap-free document numbering (orders, invoices, purchases, expenses…) incremented inside transactions. */
export const sequences = pgTable("sequences", {
  name: text("name").primaryKey(),
  value: integer("value").notNull().default(0),
});
