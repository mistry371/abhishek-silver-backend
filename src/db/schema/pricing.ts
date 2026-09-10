import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { MakingChargeType, MetalType, PurityCode } from "@/contracts/common";
import { createdAt, decimal, money, updatedAt } from "./common";
import { categories } from "./catalog";
import { adminUsers } from "./identity";

export const metalRates = pgTable(
  "metal_rates",
  {
    metal: text("metal").$type<MetalType>().notNull(),
    purity: text("purity").$type<PurityCode>().notNull(),
    ratePerGram: money("rate_per_gram").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.metal, t.purity] })],
);

/** Singleton row (id = 1). */
export const pricingSettings = pgTable("pricing_settings", {
  id: integer("id").primaryKey().default(1),
  gstRate: decimal("gst_rate").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Default making-charge rule per jewellery category, used as a starting point for new products. */
export const makingChargeDefaults = pgTable("making_charge_defaults", {
  categoryId: uuid("category_id")
    .primaryKey()
    .references(() => categories.id, { onDelete: "cascade" }),
  type: text("type").$type<MakingChargeType>().notNull(),
  value: decimal("value").notNull(),
  updatedAt: updatedAt(),
});

export const chargeRates = pgTable("charge_rates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind").$type<"stone" | "other">().notNull(),
  unit: text("unit").$type<"per_carat" | "per_piece" | "fixed">().notNull(),
  rate: money("rate").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const pricingHistory = pgTable(
  "pricing_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<"metal_rate" | "gst" | "making_default" | "charge_rate">().notNull(),
    label: text("label").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    reason: text("reason").notNull(),
    affectedProducts: integer("affected_products").notNull().default(0),
    actorAdminId: uuid("actor_admin_id").references(() => adminUsers.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("pricing_history_created_idx").on(t.createdAt)],
);
