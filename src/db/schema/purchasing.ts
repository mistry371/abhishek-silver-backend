import { date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { MetalType, PurityCode } from "@/contracts/common";
import { createdAt, money, updatedAt, weight } from "./common";
import { products } from "./catalog";
import { adminUsers } from "./identity";
import { stockLocations } from "./inventory";

/** Supplier/vendor master — confidential, admin-only. */
export const vendors = pgTable("vendors", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  contactPerson: text("contact_person"),
  mobile: text("mobile"),
  email: text("email"),
  gstin: text("gstin"),
  address: text("address"),
  status: text("status").$type<"active" | "inactive">().notNull().default("active"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type PurchaseStatus = "draft" | "pending_approval" | "approved" | "cancelled";

export const purchases = pgTable(
  "purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseNumber: text("purchase_number").notNull().unique(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    vendorInvoiceRef: text("vendor_invoice_ref"),
    purchaseDate: date("purchase_date", { mode: "string" }).notNull(),
    receivingLocationId: text("receiving_location_id")
      .notNull()
      .references(() => stockLocations.id),
    status: text("status").$type<PurchaseStatus>().notNull().default("draft"),
    totalQuantity: integer("total_quantity").notNull().default(0),
    totalGrossWeight: weight("total_gross_weight").notNull().default(0),
    totalNetWeight: weight("total_net_weight").notNull().default(0),
    subtotal: money("subtotal").notNull().default(0),
    taxAmount: money("tax_amount").notNull().default(0),
    total: money("total").notNull().default(0),
    notes: text("notes"),
    createdById: uuid("created_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedById: uuid("approved_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
    approvedByName: text("approved_by_name"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    cancelledByName: text("cancelled_by_name"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("purchases_vendor_idx").on(t.vendorId), index("purchases_status_idx").on(t.status), index("purchases_date_idx").on(t.purchaseDate)],
);

export const purchaseItems = pgTable(
  "purchase_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseId: uuid("purchase_id")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    sku: text("sku"),
    metal: text("metal").$type<MetalType>().notNull(),
    purity: text("purity").$type<PurityCode>().notNull(),
    quantity: integer("quantity").notNull(),
    grossWeight: weight("gross_weight").notNull(),
    netWeight: weight("net_weight").notNull(),
    ratePerGram: money("rate_per_gram").notNull(),
    makingCharges: money("making_charges").notNull().default(0),
    otherCharges: money("other_charges").notNull().default(0),
    lineTotal: money("line_total").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("purchase_items_purchase_idx").on(t.purchaseId)],
);
