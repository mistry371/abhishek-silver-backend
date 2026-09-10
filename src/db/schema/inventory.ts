import { boolean, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt } from "./common";
import { products } from "./catalog";
import { adminUsers } from "./identity";

export const stockLocations = pgTable("stock_locations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: createdAt(),
});

export const inventoryLevels = pgTable(
  "inventory_levels",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    locationId: text("location_id")
      .notNull()
      .references(() => stockLocations.id),
    quantity: integer("quantity").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.locationId] })],
);

export type StockMovementType = "opening" | "purchase" | "sale" | "return" | "add" | "reduce" | "adjustment" | "transfer";

/**
 * Immutable stock ledger. Rows are only ever inserted — corrections are
 * recorded as new movements so history stays auditable.
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    type: text("type").$type<StockMovementType>().notNull(),
    quantityDelta: integer("quantity_delta").notNull(),
    locationId: text("location_id")
      .notNull()
      .references(() => stockLocations.id),
    toLocationId: text("to_location_id").references(() => stockLocations.id),
    totalBefore: integer("total_before").notNull(),
    totalAfter: integer("total_after").notNull(),
    locationBefore: integer("location_before").notNull(),
    locationAfter: integer("location_after").notNull(),
    toLocationBefore: integer("to_location_before"),
    toLocationAfter: integer("to_location_after"),
    reason: text("reason"),
    referenceType: text("reference_type").$type<"purchase" | "order" | "sale" | "return" | "manual" | "seed">(),
    referenceId: text("reference_id"),
    referenceLabel: text("reference_label"),
    actorAdminId: uuid("actor_admin_id").references(() => adminUsers.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("stock_movements_product_idx").on(t.productId, t.createdAt),
    index("stock_movements_type_idx").on(t.type),
    index("stock_movements_created_idx").on(t.createdAt),
  ],
);
