import { boolean, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./common";
import { adminUsers } from "./identity";
import { products } from "./catalog";

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for walk-in customers created by staff without an online account. */
    authUserId: uuid("auth_user_id").unique(),
    customerCode: text("customer_code").notNull().unique(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull().default(""),
    email: text("email"),
    phone: text("phone"),
    status: text("status").$type<"active" | "inactive" | "blocked">().notNull().default("active"),
    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    source: text("source").$type<"website" | "admin" | "walk_in">().notNull().default("website"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("customers_email_idx").on(t.email), index("customers_phone_idx").on(t.phone)],
);

export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    label: text("label"),
    fullName: text("full_name").notNull(),
    phone: text("phone").notNull(),
    line1: text("line1").notNull(),
    line2: text("line2"),
    landmark: text("landmark"),
    city: text("city").notNull(),
    state: text("state").notNull(),
    postalCode: text("postal_code").notNull(),
    country: text("country").notNull().default("India"),
    isDefaultShipping: boolean("is_default_shipping").notNull().default(false),
    isDefaultBilling: boolean("is_default_billing").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("customer_addresses_customer_idx").on(t.customerId)],
);

/** Internal staff notes — admin-only, never exposed to customer APIs. */
export const customerNotes = pgTable(
  "customer_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorAdminId: uuid("author_admin_id").references(() => adminUsers.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("customer_notes_customer_idx").on(t.customerId)],
);

export const wishlistItems = pgTable(
  "wishlist_items",
  {
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.productId] })],
);
