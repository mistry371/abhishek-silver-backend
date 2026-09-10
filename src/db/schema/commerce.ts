import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AddressSnapshot, ImageAsset, MetalType, PriceBreakdown, PurityCode } from "@/contracts/common";
import { createdAt, money, updatedAt, weight } from "./common";
import { products } from "./catalog";
import { customers } from "./customers";
import { adminUsers } from "./identity";
import { stockLocations } from "./inventory";

export type OrderStatus =
  | "new"
  | "confirmed"
  | "processing"
  | "packed"
  | "shipped"
  | "delivered"
  | "completed"
  | "cancelled"
  | "returned"
  | "refunded";

export type PaymentStatus = "pending" | "authorized" | "paid" | "failed" | "refunded";

export interface CartLineInput {
  productId: string;
  slug: string;
  size?: string;
  quantity: number;
  customization?: Record<string, string>;
}

/** Server-side cart for signed-in customers (guest carts are quoted statelessly). */
export const carts = pgTable("carts", {
  customerId: uuid("customer_id")
    .primaryKey()
    .references(() => customers.id, { onDelete: "cascade" }),
  items: jsonb("items").$type<CartLineInput[]>().notNull().default([]),
  couponCode: text("coupon_code"),
  updatedAt: updatedAt(),
});

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderNumber: text("order_number").notNull().unique(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerPhone: text("customer_phone").notNull(),
    status: text("status").$type<OrderStatus>().notNull().default("new"),
    paymentStatus: text("payment_status").$type<PaymentStatus>().notNull().default("pending"),
    itemCount: integer("item_count").notNull(),
    subtotal: money("subtotal").notNull(),
    productSavings: money("product_savings").notNull().default(0),
    couponCode: text("coupon_code"),
    couponDescription: text("coupon_description"),
    couponDiscount: money("coupon_discount").notNull().default(0),
    gst: money("gst").notNull(),
    shipping: money("shipping").notNull().default(0),
    grandTotal: money("grand_total").notNull(),
    shippingAddress: jsonb("shipping_address").$type<AddressSnapshot>().notNull(),
    billingAddress: jsonb("billing_address").$type<AddressSnapshot>().notNull(),
    customerNotes: text("customer_notes"),
    carrier: text("carrier"),
    trackingNumber: text("tracking_number"),
    paymentProvider: text("payment_provider").notNull(),
    providerOrderId: text("provider_order_id"),
    providerPaymentId: text("provider_payment_id"),
    paymentMethod: text("payment_method"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    stockCommitted: boolean("stock_committed").notNull().default(false),
    fulfilmentLocationId: text("fulfilment_location_id").references(() => stockLocations.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("orders_customer_idx").on(t.customerId),
    index("orders_status_idx").on(t.status),
    index("orders_created_idx").on(t.createdAt),
    index("orders_provider_order_idx").on(t.providerOrderId),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    sku: text("sku").notNull(),
    image: jsonb("image").$type<ImageAsset>().notNull(),
    metal: text("metal").$type<MetalType>().notNull(),
    purity: text("purity").$type<PurityCode>().notNull(),
    size: text("size"),
    customization: jsonb("customization").$type<Record<string, string> | null>(),
    grossWeight: weight("gross_weight").notNull(),
    netWeight: weight("net_weight").notNull(),
    quantity: integer("quantity").notNull(),
    unitPrice: money("unit_price").notNull(),
    lineTotal: money("line_total").notNull(),
    /** Historical price snapshot — never recalculated after the order is placed. */
    priceSnapshot: jsonb("price_snapshot").$type<PriceBreakdown>().notNull(),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

export const orderStatusEvents = pgTable(
  "order_status_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    status: text("status").$type<OrderStatus>().notNull(),
    note: text("note"),
    actorType: text("actor_type").$type<"system" | "admin" | "customer">().notNull(),
    actorName: text("actor_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("order_status_events_order_idx").on(t.orderId)],
);

export const orderNotes = pgTable(
  "order_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorAdminId: uuid("author_admin_id").references(() => adminUsers.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("order_notes_order_idx").on(t.orderId)],
);

export const orderCommunications = pgTable(
  "order_communications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    channel: text("channel").$type<"phone" | "whatsapp" | "email" | "sms" | "in_person">().notNull(),
    direction: text("direction").$type<"outbound" | "inbound">().notNull(),
    summary: text("summary").notNull(),
    authorName: text("author_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("order_communications_order_idx").on(t.orderId)],
);

export interface ReturnLine {
  orderItemId: string;
  productId: string | null;
  name: string;
  sku: string;
  quantity: number;
}

export const orderReturns = pgTable(
  "order_returns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    returnNumber: text("return_number").notNull().unique(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    status: text("status").$type<"requested" | "approved" | "received" | "rejected" | "closed">().notNull().default("requested"),
    reason: text("reason").notNull(),
    items: jsonb("items").$type<ReturnLine[]>().notNull(),
    restocked: boolean("restocked").notNull().default(false),
    restockLocationId: text("restock_location_id").references(() => stockLocations.id),
    notes: text("notes"),
    createdByName: text("created_by_name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("order_returns_order_idx").on(t.orderId)],
);

export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    refundNumber: text("refund_number").notNull().unique(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    returnId: uuid("return_id").references(() => orderReturns.id, { onDelete: "set null" }),
    amount: money("amount").notNull(),
    method: text("method").$type<"original_payment" | "bank_transfer" | "cash" | "upi">().notNull(),
    status: text("status").$type<"pending" | "processed" | "failed">().notNull().default("pending"),
    reference: text("reference"),
    reason: text("reason").notNull(),
    createdByName: text("created_by_name").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("refunds_order_idx").on(t.orderId)],
);
