import { date, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { MetalType, PriceBreakdown, PurityCode } from "@/contracts/common";
import { createdAt, decimal, money, updatedAt, weight } from "./common";
import { products } from "./catalog";
import { orders, type PaymentStatus } from "./commerce";
import { customers } from "./customers";
import { adminUsers } from "./identity";
import { stockLocations } from "./inventory";

export const sales = pgTable(
  "sales",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleNumber: text("sale_number").notNull().unique(),
    channel: text("channel").$type<"online" | "manual">().notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone"),
    customerEmail: text("customer_email"),
    subtotal: money("subtotal").notNull(),
    discount: money("discount").notNull().default(0),
    taxableValue: money("taxable_value").notNull(),
    gst: money("gst").notNull(),
    grandTotal: money("grand_total").notNull(),
    paymentStatus: text("payment_status").$type<PaymentStatus | "partially_paid">().notNull(),
    paymentMethod: text("payment_method"),
    locationId: text("location_id").references(() => stockLocations.id),
    notes: text("notes"),
    createdById: uuid("created_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sales_created_idx").on(t.createdAt), index("sales_channel_idx").on(t.channel), index("sales_customer_idx").on(t.customerId)],
);

export const saleItems = pgTable(
  "sale_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    sku: text("sku").notNull(),
    size: text("size"),
    metal: text("metal").$type<MetalType>().notNull(),
    purity: text("purity").$type<PurityCode>().notNull(),
    quantity: integer("quantity").notNull(),
    grossWeight: weight("gross_weight").notNull(),
    netWeight: weight("net_weight").notNull(),
    unitPrice: money("unit_price").notNull(),
    discount: money("discount").notNull().default(0),
    gstRate: decimal("gst_rate").notNull(),
    gstAmount: money("gst_amount").notNull(),
    lineTotal: money("line_total").notNull(),
    priceSnapshot: jsonb("price_snapshot").$type<PriceBreakdown>().notNull(),
  },
  (t) => [index("sale_items_sale_idx").on(t.saleId)],
);

export type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "cancelled";

export interface InvoiceCustomerSnapshot {
  name: string;
  mobile?: string | null;
  email?: string | null;
  address?: string | null;
  gstin?: string | null;
}

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Assigned by the backend when the invoice is issued. Drafts have no number. */
    invoiceNumber: text("invoice_number").unique(),
    status: text("status").$type<InvoiceStatus>().notNull().default("draft"),
    source: text("source").$type<"online_order" | "manual_sale" | "manual">().notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    saleId: uuid("sale_id").references(() => sales.id, { onDelete: "set null" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    customer: jsonb("customer").$type<InvoiceCustomerSnapshot>().notNull(),
    subtotal: money("subtotal").notNull(),
    discount: money("discount").notNull().default(0),
    taxableValue: money("taxable_value").notNull(),
    gst: money("gst").notNull(),
    grandTotal: money("grand_total").notNull(),
    amountPaid: money("amount_paid").notNull().default(0),
    balanceDue: money("balance_due").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueDate: date("due_date", { mode: "string" }),
    notes: text("notes"),
    cancelReason: text("cancel_reason"),
    createdByName: text("created_by_name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("invoices_status_idx").on(t.status),
    index("invoices_customer_idx").on(t.customerId),
    index("invoices_issued_idx").on(t.issuedAt),
    index("invoices_order_idx").on(t.orderId),
  ],
);

export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    sku: text("sku"),
    size: text("size"),
    metal: text("metal").$type<MetalType | null>(),
    purity: text("purity").$type<PurityCode | null>(),
    quantity: integer("quantity").notNull(),
    grossWeight: weight("gross_weight"),
    netWeight: weight("net_weight"),
    unitPrice: money("unit_price").notNull(),
    discount: money("discount").notNull().default(0),
    taxableValue: money("taxable_value").notNull(),
    gstRate: decimal("gst_rate").notNull(),
    gstAmount: money("gst_amount").notNull(),
    lineTotal: money("line_total").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("invoice_items_invoice_idx").on(t.invoiceId)],
);

export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    amount: money("amount").notNull(),
    method: text("method").notNull(),
    reference: text("reference"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    recordedByName: text("recorded_by_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("invoice_payments_invoice_idx").on(t.invoiceId)],
);

export const invoiceEvents = pgTable(
  "invoice_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    note: text("note"),
    actorName: text("actor_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("invoice_events_invoice_idx").on(t.invoiceId)],
);
