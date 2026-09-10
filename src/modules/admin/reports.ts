import type { Request } from "express";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, sql, type SQL } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";
import type { Permission } from "@/auth/permissions";
import { db } from "@/db/client";
import {
  categories,
  customers,
  expenseCategories,
  expenses,
  inventoryLevels,
  invoicePayments,
  invoices,
  orders,
  products,
  purchases,
  refunds,
  saleItems,
  sales,
  stockLocations,
  stockMovements,
  vendors,
} from "@/db/schema";
import { adminOf, can } from "@/http/auth";
import { forbidden, invalid, notFound } from "@/lib/errors";
import { istDate, istDateEnd, istDateStart } from "@/lib/dates";
import { round2 } from "@/lib/money";
import { parse, zDate, zUuid } from "@/lib/validation";
import { customerName } from "@/services/customers";
import { placedOrder } from "./dashboard";

/**
 * REPORTING & ANALYTICS — every figure is aggregated from recorded
 * transactions for the selected period (IST calendar dates).
 */
export const reportsRouter = Router();

type Format = "number" | "currency" | "percent" | "weight" | "date" | "text";
interface Column {
  key: string;
  label: string;
  format?: Format;
}
interface Section {
  key: string;
  title: string;
  columns: Column[];
  rows: Record<string, unknown>[];
}
interface ReportBody {
  summary: { label: string; value: number | string | null; format?: Format }[];
  sections: Section[];
  charts: { key: string; title: string; format?: Format; points: { label: string; value: number }[] }[];
}
interface Ctx {
  req: Request;
  from: string;
  to: string;
  start: Date;
  end: Date;
  groupBy: "day" | "month";
  customerId?: string;
}

/* ------------------------------------------------------------------ */
/* SQL helpers                                                         */
/* ------------------------------------------------------------------ */

const formatFor = (groupBy: Ctx["groupBy"]) => sql.raw(`'${groupBy === "day" ? "YYYY-MM-DD" : "YYYY-MM"}'`);
const bucket = (column: PgColumn, groupBy: Ctx["groupBy"]) => sql<string>`to_char(${column} at time zone 'Asia/Kolkata', ${formatFor(groupBy)})`;
const dateBucket = (column: PgColumn, groupBy: Ctx["groupBy"]) => sql<string>`to_char(${column}, ${formatFor(groupBy)})`;
const total = (column: PgColumn | SQL) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
const totalIf = (column: PgColumn, condition: SQL | undefined) => sql<number>`coalesce(sum(${column}) filter (where ${condition}), 0)`.mapWith(Number);
const countAll = () => sql<number>`count(*)`.mapWith(Number);
const countIf = (condition: SQL | undefined) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
const between = (column: PgColumn, c: Ctx) => and(gte(column, c.start), lt(column, c.end));
const sumOf = <T>(rows: T[], pick: (row: T) => number) => round2(rows.reduce((s, r) => s + (pick(r) || 0), 0));

/** Ensures every bucket in the period appears (zero-filled) so charts don't skip days. */
function periods(c: Ctx) {
  const labels: string[] = [];
  const cursor = new Date(`${c.from}T00:00:00Z`);
  const last = new Date(`${c.to}T00:00:00Z`);
  while (cursor <= last && labels.length < 400) {
    const label = c.groupBy === "day" ? cursor.toISOString().slice(0, 10) : cursor.toISOString().slice(0, 7);
    if (labels.at(-1) !== label) labels.push(label);
    if (c.groupBy === "day") cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
  }
  return labels;
}

function fill<T extends { period: string }>(c: Ctx, rows: T[], empty: Omit<T, "period">): T[] {
  return periods(c).map((period) => rows.find((r) => r.period === period) ?? ({ period, ...empty } as T));
}

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

async function salesReport(c: Ctx): Promise<ReportBody> {
  const b = bucket(sales.createdAt, c.groupBy);
  const raw = await db()
    .select({
      period: b,
      sales: countAll(),
      online: totalIf(sales.grandTotal, sql`${sales.channel} = 'online'`),
      manual: totalIf(sales.grandTotal, sql`${sales.channel} = 'manual'`),
      discount: total(sales.discount),
      gst: total(sales.gst),
      revenue: total(sales.grandTotal),
    })
    .from(sales)
    .where(and(between(sales.createdAt, c), ne(sales.paymentStatus, "refunded")))
    .groupBy(b)
    .orderBy(b);
  const rows = fill(c, raw, { sales: 0, online: 0, manual: 0, discount: 0, gst: 0, revenue: 0 });
  const [refunded] = await db()
    .select({ value: total(sales.grandTotal), count: countAll() })
    .from(sales)
    .where(and(between(sales.createdAt, c), eq(sales.paymentStatus, "refunded")));
  const revenue = sumOf(rows, (r) => r.revenue);
  const count = rows.reduce((s, r) => s + r.sales, 0);
  return {
    summary: [
      { label: "Revenue", value: revenue, format: "currency" },
      { label: "Sales", value: count, format: "number" },
      { label: "Average sale value", value: count ? round2(revenue / count) : 0, format: "currency" },
      { label: "Online", value: sumOf(rows, (r) => r.online), format: "currency" },
      { label: "In-store", value: sumOf(rows, (r) => r.manual), format: "currency" },
      { label: "GST collected", value: sumOf(rows, (r) => r.gst), format: "currency" },
      { label: "Discounts given", value: sumOf(rows, (r) => r.discount), format: "currency" },
      { label: "Refunded sales", value: refunded?.value ?? 0, format: "currency" },
    ],
    sections: [
      {
        key: "by_period",
        title: "Sales by period",
        columns: [
          { key: "period", label: "Period", format: "text" },
          { key: "sales", label: "Sales", format: "number" },
          { key: "online", label: "Online", format: "currency" },
          { key: "manual", label: "In-store", format: "currency" },
          { key: "discount", label: "Discounts", format: "currency" },
          { key: "gst", label: "GST", format: "currency" },
          { key: "revenue", label: "Revenue", format: "currency" },
        ],
        rows,
      },
    ],
    charts: [{ key: "revenue", title: "Revenue", format: "currency", points: rows.map((r) => ({ label: r.period, value: r.revenue })) }],
  };
}

async function revenueReport(c: Ctx): Promise<ReportBody> {
  const billedBucket = bucket(invoices.issuedAt, c.groupBy);
  const billed = await db()
    .select({ period: billedBucket, value: total(invoices.grandTotal) })
    .from(invoices)
    .where(and(between(invoices.issuedAt, c), inArray(invoices.status, ["issued", "partially_paid", "paid"])))
    .groupBy(billedBucket);
  const paidBucket = bucket(invoicePayments.receivedAt, c.groupBy);
  const collected = await db()
    .select({ period: paidBucket, value: total(invoicePayments.amount) })
    .from(invoicePayments)
    .where(between(invoicePayments.receivedAt, c))
    .groupBy(paidBucket);
  const refundBucket = bucket(refunds.processedAt, c.groupBy);
  const refunded = await db()
    .select({ period: refundBucket, value: total(refunds.amount) })
    .from(refunds)
    .where(and(between(refunds.processedAt, c), eq(refunds.status, "processed")))
    .groupBy(refundBucket);

  const rows = periods(c).map((period) => {
    const b = billed.find((r) => r.period === period)?.value ?? 0;
    const col = collected.find((r) => r.period === period)?.value ?? 0;
    const ref = refunded.find((r) => r.period === period)?.value ?? 0;
    return { period, billed: b, collected: col, refunds: ref, net: round2(col - ref) };
  });
  return {
    summary: [
      { label: "Billed", value: sumOf(rows, (r) => r.billed), format: "currency" },
      { label: "Collected", value: sumOf(rows, (r) => r.collected), format: "currency" },
      { label: "Refunds", value: sumOf(rows, (r) => r.refunds), format: "currency" },
      { label: "Net collected", value: sumOf(rows, (r) => r.net), format: "currency" },
    ],
    sections: [
      {
        key: "by_period",
        title: "Revenue overview",
        columns: [
          { key: "period", label: "Period" },
          { key: "billed", label: "Billed", format: "currency" },
          { key: "collected", label: "Collected", format: "currency" },
          { key: "refunds", label: "Refunds", format: "currency" },
          { key: "net", label: "Net", format: "currency" },
        ],
        rows,
      },
    ],
    charts: [
      { key: "collected", title: "Collected", format: "currency", points: rows.map((r) => ({ label: r.period, value: r.collected })) },
      { key: "billed", title: "Billed", format: "currency", points: rows.map((r) => ({ label: r.period, value: r.billed })) },
    ],
  };
}

async function bestSellersReport(c: Ctx): Promise<ReportBody> {
  const rows = await db()
    .select({
      productId: saleItems.productId,
      sku: saleItems.sku,
      name: saleItems.name,
      units: total(saleItems.quantity),
      sales: sql<number>`count(distinct ${saleItems.saleId})`.mapWith(Number),
      revenue: total(saleItems.lineTotal),
    })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .where(and(between(sales.createdAt, c), ne(sales.paymentStatus, "refunded")))
    .groupBy(saleItems.productId, saleItems.sku, saleItems.name)
    .orderBy(desc(sql`sum(${saleItems.quantity})`), desc(sql`sum(${saleItems.lineTotal})`))
    .limit(50);
  return {
    summary: [
      { label: "Products sold", value: rows.length, format: "number" },
      { label: "Units (top 50)", value: sumOf(rows, (r) => r.units), format: "number" },
      { label: "Revenue (top 50)", value: sumOf(rows, (r) => r.revenue), format: "currency" },
    ],
    sections: [
      {
        key: "products",
        title: "Best-selling products",
        columns: [
          { key: "sku", label: "SKU" },
          { key: "name", label: "Product" },
          { key: "units", label: "Units", format: "number" },
          { key: "sales", label: "Sales", format: "number" },
          { key: "revenue", label: "Revenue", format: "currency" },
        ],
        rows,
      },
    ],
    charts: [{ key: "units", title: "Units sold", format: "number", points: rows.slice(0, 10).map((r) => ({ label: r.sku, value: r.units })) }],
  };
}

async function ordersReport(c: Ctx): Promise<ReportBody> {
  const b = bucket(orders.createdAt, c.groupBy);
  const paid = inArray(orders.paymentStatus, ["paid", "refunded"]);
  const where = and(placedOrder(), between(orders.createdAt, c));
  const raw = await db()
    .select({
      period: b,
      orders: countAll(),
      paid: countIf(paid),
      cancelled: countIf(eq(orders.status, "cancelled")),
      returned: countIf(inArray(orders.status, ["returned"])),
      value: totalIf(orders.grandTotal, paid),
    })
    .from(orders)
    .where(where)
    .groupBy(b)
    .orderBy(b);
  const rows = fill(c, raw, { orders: 0, paid: 0, cancelled: 0, returned: 0, value: 0 });
  const byStatus = await db().select({ status: orders.status, orders: countAll(), value: total(orders.grandTotal) }).from(orders).where(where).groupBy(orders.status);
  const totalOrders = rows.reduce((s, r) => s + r.orders, 0);
  const paidOrders = rows.reduce((s, r) => s + r.paid, 0);
  const value = sumOf(rows, (r) => r.value);
  return {
    summary: [
      { label: "Orders", value: totalOrders, format: "number" },
      { label: "Paid orders", value: paidOrders, format: "number" },
      { label: "Order value", value, format: "currency" },
      { label: "Average order value", value: paidOrders ? round2(value / paidOrders) : 0, format: "currency" },
      { label: "Cancellation rate", value: totalOrders ? round2((rows.reduce((s, r) => s + r.cancelled, 0) / totalOrders) * 100) : 0, format: "percent" },
    ],
    sections: [
      {
        key: "by_period",
        title: "Orders by period",
        columns: [
          { key: "period", label: "Period" },
          { key: "orders", label: "Orders", format: "number" },
          { key: "paid", label: "Paid", format: "number" },
          { key: "cancelled", label: "Cancelled", format: "number" },
          { key: "returned", label: "Returned", format: "number" },
          { key: "value", label: "Value", format: "currency" },
        ],
        rows,
      },
      {
        key: "by_status",
        title: "Orders by status",
        columns: [
          { key: "status", label: "Status" },
          { key: "orders", label: "Orders", format: "number" },
          { key: "value", label: "Value", format: "currency" },
        ],
        rows: byStatus,
      },
    ],
    charts: [{ key: "orders", title: "Orders", format: "number", points: rows.map((r) => ({ label: r.period, value: r.orders })) }],
  };
}

async function customersReport(c: Ctx): Promise<ReportBody> {
  const b = bucket(customers.createdAt, c.groupBy);
  const raw = await db()
    .select({
      period: b,
      newCustomers: countAll(),
      website: countIf(eq(customers.source, "website")),
      inStore: countIf(inArray(customers.source, ["admin", "walk_in"])),
    })
    .from(customers)
    .where(between(customers.createdAt, c))
    .groupBy(b)
    .orderBy(b);
  const newRows = fill(c, raw, { newCustomers: 0, website: 0, inStore: 0 });

  const buyers = await db()
    .select({
      customerId: sales.customerId,
      purchases: countAll(),
      spend: total(sales.grandTotal),
      lastPurchaseAt: sql<string>`max(${sales.createdAt})`,
    })
    .from(sales)
    .where(and(between(sales.createdAt, c), ne(sales.paymentStatus, "refunded"), isNotNull(sales.customerId)))
    .groupBy(sales.customerId);
  const top = [...buyers].sort((a, b2) => b2.spend - a.spend).slice(0, 50);
  const people = top.length
    ? await db()
        .select()
        .from(customers)
        .where(
          inArray(
            customers.id,
            top.map((t) => t.customerId!),
          ),
        )
    : [];
  const [unlinked] = await db()
    .select({ value: total(sales.grandTotal) })
    .from(sales)
    .where(and(between(sales.createdAt, c), ne(sales.paymentStatus, "refunded"), isNull(sales.customerId)));

  return {
    summary: [
      { label: "New customers", value: newRows.reduce((s, r) => s + r.newCustomers, 0), format: "number" },
      { label: "Customers who purchased", value: buyers.length, format: "number" },
      { label: "Repeat purchasers", value: buyers.filter((b2) => b2.purchases >= 2).length, format: "number" },
      { label: "Sales without a customer record", value: unlinked?.value ?? 0, format: "currency" },
    ],
    sections: [
      {
        key: "top_customers",
        title: "Top customers by spend",
        columns: [
          { key: "customerCode", label: "Customer ID" },
          { key: "name", label: "Name" },
          { key: "phone", label: "Mobile" },
          { key: "purchases", label: "Purchases", format: "number" },
          { key: "spend", label: "Spend", format: "currency" },
          { key: "lastPurchaseAt", label: "Last purchase", format: "date" },
        ],
        rows: top.map((t) => {
          const person = people.find((p) => p.id === t.customerId);
          return {
            customerId: t.customerId,
            customerCode: person?.customerCode ?? "",
            name: person ? customerName(person) : "",
            phone: person?.phone ?? "",
            purchases: t.purchases,
            spend: t.spend,
            lastPurchaseAt: t.lastPurchaseAt,
          };
        }),
      },
      {
        key: "new_customers",
        title: "New customers by period",
        columns: [
          { key: "period", label: "Period" },
          { key: "newCustomers", label: "New", format: "number" },
          { key: "website", label: "Website", format: "number" },
          { key: "inStore", label: "In-store / admin", format: "number" },
        ],
        rows: newRows,
      },
    ],
    charts: [{ key: "new_customers", title: "New customers", format: "number", points: newRows.map((r) => ({ label: r.period, value: r.newCustomers })) }],
  };
}

async function customerHistoryReport(c: Ctx): Promise<ReportBody> {
  if (!c.customerId) throw invalid({ customerId: "Choose a customer." });
  const [customer] = await db().select().from(customers).where(eq(customers.id, c.customerId)).limit(1);
  if (!customer) throw notFound("Customer not found.");
  const rows = await db()
    .select({
      date: sales.createdAt,
      saleNumber: sales.saleNumber,
      channel: sales.channel,
      paymentStatus: sales.paymentStatus,
      sku: saleItems.sku,
      name: saleItems.name,
      quantity: saleItems.quantity,
      netWeight: saleItems.netWeight,
      lineTotal: saleItems.lineTotal,
    })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .where(and(eq(sales.customerId, c.customerId), between(sales.createdAt, c)))
    .orderBy(desc(sales.createdAt));
  const counted = rows.filter((r) => r.paymentStatus !== "refunded");
  return {
    summary: [
      { label: "Customer", value: `${customer.customerCode} ${customerName(customer)}`, format: "text" },
      { label: "Purchases", value: new Set(counted.map((r) => r.saleNumber)).size, format: "number" },
      { label: "Items", value: counted.reduce((s, r) => s + r.quantity, 0), format: "number" },
      { label: "Spend", value: sumOf(counted, (r) => r.lineTotal), format: "currency" },
    ],
    sections: [
      {
        key: "lines",
        title: "Purchase history",
        columns: [
          { key: "date", label: "Date", format: "date" },
          { key: "saleNumber", label: "Sale" },
          { key: "channel", label: "Channel" },
          { key: "sku", label: "SKU" },
          { key: "name", label: "Product" },
          { key: "quantity", label: "Qty", format: "number" },
          { key: "netWeight", label: "Net weight", format: "weight" },
          { key: "lineTotal", label: "Amount", format: "currency" },
          { key: "paymentStatus", label: "Payment" },
        ],
        rows,
      },
    ],
    charts: [],
  };
}

async function productsReport(c: Ctx): Promise<ReportBody> {
  const sold = db()
    .select({
      productId: saleItems.productId,
      units: sql<number>`sum(${saleItems.quantity})`.as("units"),
      revenue: sql<number>`sum(${saleItems.lineTotal})`.as("revenue"),
      lastSoldAt: sql<string>`max(${sales.createdAt})`.as("last_sold_at"),
    })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .where(and(between(sales.createdAt, c), ne(sales.paymentStatus, "refunded")))
    .groupBy(saleItems.productId)
    .as("sold");
  const rows = await db()
    .select({
      sku: products.sku,
      name: products.name,
      category: categories.name,
      metal: products.metal,
      purity: products.purity,
      status: products.status,
      units: sql<number>`coalesce(${sold.units}, 0)`.mapWith(Number),
      revenue: sql<number>`coalesce(${sold.revenue}, 0)`.mapWith(Number),
      lastSoldAt: sold.lastSoldAt,
    })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(sold, eq(sold.productId, products.id))
    .where(isNull(products.deletedAt))
    .orderBy(desc(sql`coalesce(${sold.units}, 0)`), asc(products.name));
  const withRevenue = can(c.req, "reports:sales");
  const byCategory = new Map<string, { category: string; products: number; active: number; units: number }>();
  for (const row of rows) {
    const entry = byCategory.get(row.category) ?? { category: row.category, products: 0, active: 0, units: 0 };
    entry.products += 1;
    entry.active += row.status === "active" ? 1 : 0;
    entry.units += row.units;
    byCategory.set(row.category, entry);
  }
  return {
    summary: [
      { label: "Products", value: rows.length, format: "number" },
      { label: "Active", value: rows.filter((r) => r.status === "active").length, format: "number" },
      { label: "Draft", value: rows.filter((r) => r.status === "draft").length, format: "number" },
      { label: "Disabled", value: rows.filter((r) => r.status === "disabled").length, format: "number" },
      { label: "Sold in period", value: rows.filter((r) => r.units > 0).length, format: "number" },
      { label: "Not sold in period", value: rows.filter((r) => r.units === 0).length, format: "number" },
    ],
    sections: [
      {
        key: "products",
        title: "Product performance",
        columns: [
          { key: "sku", label: "SKU" },
          { key: "name", label: "Product" },
          { key: "category", label: "Category" },
          { key: "metal", label: "Metal" },
          { key: "purity", label: "Purity" },
          { key: "status", label: "Status" },
          { key: "units", label: "Units sold", format: "number" },
          ...(withRevenue ? [{ key: "revenue", label: "Revenue", format: "currency" as const }] : []),
          { key: "lastSoldAt", label: "Last sold", format: "date" },
        ],
        rows: withRevenue
          ? rows
          : rows.map(({ revenue: _revenue, ...rest }) => {
              void _revenue;
              return rest;
            }),
      },
      {
        key: "by_category",
        title: "Products by category",
        columns: [
          { key: "category", label: "Category" },
          { key: "products", label: "Products", format: "number" },
          { key: "active", label: "Active", format: "number" },
          { key: "units", label: "Units sold", format: "number" },
        ],
        rows: [...byCategory.values()],
      },
    ],
    charts: [],
  };
}

async function stockRows() {
  return db()
    .select({
      productId: products.id,
      sku: products.sku,
      name: products.name,
      category: categories.name,
      metal: products.metal,
      purity: products.purity,
      netWeight: products.netWeight,
      status: products.status,
      threshold: products.lowStockThreshold,
      purchasePrice: products.purchasePrice,
      units: sql<number>`coalesce(sum(${inventoryLevels.quantity}), 0)`.mapWith(Number),
    })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(inventoryLevels, eq(inventoryLevels.productId, products.id))
    .where(isNull(products.deletedAt))
    .groupBy(products.id, categories.name)
    .orderBy(asc(products.name));
}

async function inventoryReport(c: Ctx): Promise<ReportBody> {
  const valuation = can(c.req, "inventory:view_valuation");
  const rows = await stockRows();
  const groups = (key: (r: (typeof rows)[number]) => string, label: string) => {
    const map = new Map<string, Record<string, unknown> & { products: number; units: number; netWeight: number; valuation: number }>();
    for (const r of rows) {
      const k = key(r);
      const entry = map.get(k) ?? { [label]: k, products: 0, units: 0, netWeight: 0, valuation: 0 };
      entry.products += 1;
      entry.units += r.units;
      entry.netWeight = round2(entry.netWeight + r.units * r.netWeight);
      entry.valuation = round2(entry.valuation + (r.purchasePrice !== null ? r.units * r.purchasePrice : 0));
      map.set(k, entry);
    }
    return [...map.values()].map((entry) => {
      if (valuation) return entry;
      const { valuation: _v, ...rest } = entry;
      void _v;
      return rest;
    });
  };
  const byLocation = await db()
    .select({ location: stockLocations.name, units: total(inventoryLevels.quantity) })
    .from(stockLocations)
    .leftJoin(inventoryLevels, eq(inventoryLevels.locationId, stockLocations.id))
    .groupBy(stockLocations.id, stockLocations.name);
  const groupColumns = (first: string, label: string): Column[] => [
    { key: first, label },
    { key: "products", label: "Products", format: "number" },
    { key: "units", label: "Units", format: "number" },
    { key: "netWeight", label: "Net weight", format: "weight" },
    ...(valuation ? [{ key: "valuation", label: "Valuation", format: "currency" as const }] : []),
  ];

  return {
    summary: [
      { label: "Products", value: rows.length, format: "number" },
      { label: "Units in stock", value: rows.reduce((s, r) => s + Math.max(r.units, 0), 0), format: "number" },
      { label: "Net metal weight in stock", value: sumOf(rows, (r) => r.units * r.netWeight), format: "weight" },
      ...(valuation
        ? [
            { label: "Valuation (at purchase price)", value: sumOf(rows, (r) => (r.purchasePrice !== null ? r.units * r.purchasePrice : 0)), format: "currency" as const },
            { label: "Stocked products without purchase price", value: rows.filter((r) => r.units > 0 && r.purchasePrice === null).length, format: "number" as const },
          ]
        : []),
    ],
    sections: [
      {
        key: "products",
        title: "Stock by product",
        columns: [
          { key: "sku", label: "SKU" },
          { key: "name", label: "Product" },
          { key: "category", label: "Category" },
          { key: "metal", label: "Metal" },
          { key: "purity", label: "Purity" },
          { key: "netWeight", label: "Net weight (each)", format: "weight" },
          { key: "units", label: "Units", format: "number" },
          { key: "status", label: "Status" },
          ...(valuation ? [{ key: "valuation", label: "Valuation", format: "currency" as const }] : []),
        ],
        rows: rows.map(({ purchasePrice, threshold: _t, productId: _p, ...r }) => {
          void _t;
          void _p;
          return valuation ? { ...r, valuation: purchasePrice !== null ? round2(r.units * purchasePrice) : null } : r;
        }),
      },
      { key: "by_category", title: "Stock by category", columns: groupColumns("category", "Category"), rows: groups((r) => r.category, "category") },
      { key: "by_metal", title: "Stock by metal & purity", columns: groupColumns("metalPurity", "Metal / purity"), rows: groups((r) => `${r.metal} ${r.purity}`, "metalPurity") },
      { key: "by_location", title: "Units by location", columns: [{ key: "location", label: "Location" }, { key: "units", label: "Units", format: "number" }], rows: byLocation },
    ],
    charts: [],
  };
}

async function stockMovementReport(c: Ctx): Promise<ReportBody> {
  const where = between(stockMovements.createdAt, c);
  const notTransfer = sql`${stockMovements.type} <> 'transfer'`;
  const byType = await db()
    .select({
      type: stockMovements.type,
      movements: countAll(),
      unitsIn: sql<number>`coalesce(sum(greatest(${stockMovements.quantityDelta}, 0)) filter (where ${notTransfer}), 0)`.mapWith(Number),
      unitsOut: sql<number>`coalesce(sum(greatest(-${stockMovements.quantityDelta}, 0)) filter (where ${notTransfer}), 0)`.mapWith(Number),
      unitsMoved: sql<number>`coalesce(sum(${stockMovements.quantityDelta}) filter (where ${stockMovements.type} = 'transfer'), 0)`.mapWith(Number),
    })
    .from(stockMovements)
    .where(where)
    .groupBy(stockMovements.type);
  const topChanges = await db()
    .select({
      sku: products.sku,
      name: products.name,
      movements: countAll(),
      netChange: sql<number>`coalesce(sum(${stockMovements.quantityDelta}) filter (where ${notTransfer}), 0)`.mapWith(Number),
    })
    .from(stockMovements)
    .innerJoin(products, eq(products.id, stockMovements.productId))
    .where(where)
    .groupBy(products.id, products.sku, products.name)
    .orderBy(desc(sql`abs(coalesce(sum(${stockMovements.quantityDelta}) filter (where ${notTransfer}), 0))`))
    .limit(25);
  return {
    summary: [
      { label: "Movements", value: byType.reduce((s, r) => s + r.movements, 0), format: "number" },
      { label: "Units in", value: byType.reduce((s, r) => s + r.unitsIn, 0), format: "number" },
      { label: "Units out", value: byType.reduce((s, r) => s + r.unitsOut, 0), format: "number" },
      { label: "Units transferred", value: byType.reduce((s, r) => s + r.unitsMoved, 0), format: "number" },
    ],
    sections: [
      {
        key: "by_type",
        title: "Movements by type",
        columns: [
          { key: "type", label: "Type" },
          { key: "movements", label: "Movements", format: "number" },
          { key: "unitsIn", label: "Units in", format: "number" },
          { key: "unitsOut", label: "Units out", format: "number" },
          { key: "unitsMoved", label: "Transferred", format: "number" },
        ],
        rows: byType,
      },
      {
        key: "top_changes",
        title: "Largest net changes",
        columns: [
          { key: "sku", label: "SKU" },
          { key: "name", label: "Product" },
          { key: "movements", label: "Movements", format: "number" },
          { key: "netChange", label: "Net change", format: "number" },
        ],
        rows: topChanges,
      },
    ],
    charts: [],
  };
}

async function lowStockReport(): Promise<ReportBody> {
  const rows = (await stockRows()).filter((r) => r.status === "active" && r.units <= r.threshold);
  return {
    summary: [
      { label: "Low stock", value: rows.filter((r) => r.units > 0).length, format: "number" },
      { label: "Out of stock", value: rows.filter((r) => r.units <= 0).length, format: "number" },
    ],
    sections: [
      {
        key: "products",
        title: "Low and out-of-stock products",
        columns: [
          { key: "sku", label: "SKU" },
          { key: "name", label: "Product" },
          { key: "category", label: "Category" },
          { key: "units", label: "In stock", format: "number" },
          { key: "threshold", label: "Low-stock level", format: "number" },
        ],
        rows: rows
          .sort((a, b) => a.units - b.units)
          .map(({ productId, sku, name, category, units, threshold }) => ({ productId, sku, name, category, units, threshold })),
      },
    ],
    charts: [],
  };
}

async function purchasesReport(c: Ctx): Promise<ReportBody> {
  const where = and(eq(purchases.status, "approved"), gte(purchases.purchaseDate, c.from), lte(purchases.purchaseDate, c.to));
  const byVendor = await db()
    .select({
      vendor: vendors.name,
      purchases: countAll(),
      units: total(purchases.totalQuantity),
      netWeight: total(purchases.totalNetWeight),
      subtotal: total(purchases.subtotal),
      tax: total(purchases.taxAmount),
      total: total(purchases.total),
    })
    .from(purchases)
    .innerJoin(vendors, eq(vendors.id, purchases.vendorId))
    .where(where)
    .groupBy(vendors.id, vendors.name)
    .orderBy(desc(sql`sum(${purchases.total})`));
  const b = dateBucket(purchases.purchaseDate, c.groupBy);
  const raw = await db().select({ period: b, purchases: countAll(), total: total(purchases.total) }).from(purchases).where(where).groupBy(b).orderBy(b);
  const byPeriod = fill(c, raw, { purchases: 0, total: 0 });
  const [pending] = await db().select({ count: countAll(), value: total(purchases.total) }).from(purchases).where(eq(purchases.status, "pending_approval"));
  return {
    summary: [
      { label: "Approved purchases", value: byVendor.reduce((s, r) => s + r.purchases, 0), format: "number" },
      { label: "Purchase value", value: sumOf(byVendor, (r) => r.total), format: "currency" },
      { label: "Units received", value: byVendor.reduce((s, r) => s + r.units, 0), format: "number" },
      { label: "Net weight received", value: sumOf(byVendor, (r) => r.netWeight), format: "weight" },
      { label: "Awaiting approval", value: pending?.count ?? 0, format: "number" },
    ],
    sections: [
      {
        key: "by_vendor",
        title: "Purchases by vendor",
        columns: [
          { key: "vendor", label: "Vendor" },
          { key: "purchases", label: "Purchases", format: "number" },
          { key: "units", label: "Units", format: "number" },
          { key: "netWeight", label: "Net weight", format: "weight" },
          { key: "subtotal", label: "Subtotal", format: "currency" },
          { key: "tax", label: "Tax", format: "currency" },
          { key: "total", label: "Total", format: "currency" },
        ],
        rows: byVendor,
      },
      {
        key: "by_period",
        title: "Purchases by period",
        columns: [
          { key: "period", label: "Period" },
          { key: "purchases", label: "Purchases", format: "number" },
          { key: "total", label: "Total", format: "currency" },
        ],
        rows: byPeriod,
      },
    ],
    charts: [{ key: "total", title: "Purchase value", format: "currency", points: byPeriod.map((r) => ({ label: r.period, value: r.total })) }],
  };
}

async function billingReport(c: Ctx): Promise<ReportBody> {
  const issued = and(between(invoices.issuedAt, c), inArray(invoices.status, ["issued", "partially_paid", "paid", "cancelled"]));
  const byStatus = await db()
    .select({ status: invoices.status, invoices: countAll(), value: total(invoices.grandTotal), balanceDue: total(invoices.balanceDue) })
    .from(invoices)
    .where(issued)
    .groupBy(invoices.status);
  const revenue = await revenueReport(c);
  const outstanding = await db()
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      customer: sql<string>`${invoices.customer} ->> 'name'`,
      issuedAt: invoices.issuedAt,
      dueDate: invoices.dueDate,
      grandTotal: invoices.grandTotal,
      balanceDue: invoices.balanceDue,
    })
    .from(invoices)
    .where(and(inArray(invoices.status, ["issued", "partially_paid"]), gt(invoices.balanceDue, 0)))
    .orderBy(asc(invoices.issuedAt))
    .limit(200);
  const today = istDate();
  const valid = byStatus.filter((s) => s.status !== "cancelled");
  return {
    summary: [
      { label: "Invoices issued", value: valid.reduce((s, r) => s + r.invoices, 0), format: "number" },
      { label: "Billed", value: sumOf(valid, (r) => r.value), format: "currency" },
      { label: "Collected", value: revenue.summary[1]!.value, format: "currency" },
      { label: "Outstanding (all time)", value: sumOf(outstanding, (r) => r.balanceDue), format: "currency" },
      { label: "Overdue invoices", value: outstanding.filter((r) => r.dueDate && r.dueDate < today).length, format: "number" },
      { label: "Cancelled", value: byStatus.find((s) => s.status === "cancelled")?.invoices ?? 0, format: "number" },
    ],
    sections: [
      {
        key: "by_status",
        title: "Invoices by status",
        columns: [
          { key: "status", label: "Status" },
          { key: "invoices", label: "Invoices", format: "number" },
          { key: "value", label: "Value", format: "currency" },
          { key: "balanceDue", label: "Balance due", format: "currency" },
        ],
        rows: byStatus,
      },
      revenue.sections[0]!,
      {
        key: "outstanding",
        title: "Outstanding invoices",
        columns: [
          { key: "invoiceNumber", label: "Invoice" },
          { key: "customer", label: "Customer" },
          { key: "issuedAt", label: "Issued", format: "date" },
          { key: "dueDate", label: "Due", format: "date" },
          { key: "grandTotal", label: "Total", format: "currency" },
          { key: "balanceDue", label: "Balance", format: "currency" },
        ],
        rows: outstanding,
      },
    ],
    charts: revenue.charts,
  };
}

async function expensesReport(c: Ctx): Promise<ReportBody> {
  const inPeriod = and(gte(expenses.expenseDate, c.from), lte(expenses.expenseDate, c.to));
  const counted = and(inPeriod, inArray(expenses.status, ["approved", "paid"]));
  const parent = alias(expenseCategories, "parent_category");

  const byCategory = await db()
    .select({
      category: sql<string>`coalesce(${parent.name} || ' / ', '') || ${expenseCategories.name}`,
      expenses: countAll(),
      total: total(expenses.totalAmount),
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .leftJoin(parent, eq(parent.id, expenseCategories.parentId))
    .where(counted)
    .groupBy(expenseCategories.id, expenseCategories.name, parent.name)
    .orderBy(desc(sql`sum(${expenses.totalAmount})`));
  const payee = sql<string>`coalesce(${vendors.name}, ${expenses.payee})`;
  const byPayee = await db()
    .select({ payee, expenses: countAll(), total: total(expenses.totalAmount) })
    .from(expenses)
    .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
    .where(counted)
    .groupBy(payee)
    .orderBy(desc(sql`sum(${expenses.totalAmount})`));
  const b = dateBucket(expenses.expenseDate, c.groupBy);
  const raw = await db().select({ period: b, expenses: countAll(), total: total(expenses.totalAmount) }).from(expenses).where(counted).groupBy(b).orderBy(b);
  const byPeriod = fill(c, raw, { expenses: 0, total: 0 });
  const byMethod = await db().select({ paymentMethod: expenses.paymentMethod, expenses: countAll(), total: total(expenses.totalAmount) }).from(expenses).where(counted).groupBy(expenses.paymentMethod);
  const byStatus = await db().select({ status: expenses.status, expenses: countAll(), total: total(expenses.totalAmount) }).from(expenses).where(inPeriod).groupBy(expenses.status);
  const kind = sql<string>`case when ${expenses.recurringId} is null then 'One-time' else 'Recurring' end`;
  const byKind = await db().select({ kind, expenses: countAll(), total: total(expenses.totalAmount) }).from(expenses).where(counted).groupBy(kind);
  const receipt = sql<string>`case when jsonb_array_length(${expenses.attachments}) > 0 then 'With attachment' else 'Missing attachment' end`;
  const byAttachment = await db().select({ attachment: receipt, expenses: countAll(), total: total(expenses.totalAmount) }).from(expenses).where(counted).groupBy(receipt);

  const simple = (key: string, label: string): Column[] => [
    { key, label },
    { key: "expenses", label: "Expenses", format: "number" },
    { key: "total", label: "Total", format: "currency" },
  ];
  const counts = (status: string) => byStatus.find((s) => s.status === status);
  return {
    summary: [
      { label: "Approved & paid expenses", value: sumOf(byCategory, (r) => r.total), format: "currency" },
      { label: "Count", value: byCategory.reduce((s, r) => s + r.expenses, 0), format: "number" },
      { label: "Approved (unpaid)", value: counts("approved")?.total ?? 0, format: "currency" },
      { label: "Paid", value: counts("paid")?.total ?? 0, format: "currency" },
      { label: "Rejected", value: counts("rejected")?.expenses ?? 0, format: "number" },
      { label: "Awaiting approval", value: counts("submitted")?.expenses ?? 0, format: "number" },
    ],
    sections: [
      { key: "by_category", title: "Category-wise", columns: simple("category", "Category"), rows: byCategory },
      { key: "by_vendor", title: "Vendor / payee-wise", columns: simple("payee", "Vendor / payee"), rows: byPayee },
      { key: "by_date", title: "Date-wise", columns: simple("period", "Period"), rows: byPeriod },
      { key: "by_payment_method", title: "Payment method", columns: simple("paymentMethod", "Payment method"), rows: byMethod },
      { key: "by_status", title: "Approved vs rejected (all statuses)", columns: simple("status", "Status"), rows: byStatus },
      { key: "recurring", title: "Recurring vs one-time", columns: simple("kind", "Type"), rows: byKind },
      { key: "attachments", title: "Attachment completeness", columns: simple("attachment", "Receipt"), rows: byAttachment },
    ],
    charts: [{ key: "total", title: "Expenses", format: "currency", points: byPeriod.map((r) => ({ label: r.period, value: r.total })) }],
  };
}

const REPORTS: Record<string, { title: string; permission: Permission; run: (c: Ctx) => Promise<ReportBody> }> = {
  sales: { title: "Sales Report", permission: "reports:sales", run: salesReport },
  revenue: { title: "Revenue Overview", permission: "reports:sales", run: revenueReport },
  "best-sellers": { title: "Best-Selling Products", permission: "reports:sales", run: bestSellersReport },
  orders: { title: "Order Report", permission: "reports:orders", run: ordersReport },
  customers: { title: "Customer Report", permission: "reports:customers", run: customersReport },
  "customer-history": { title: "Customer Purchase History", permission: "reports:customers", run: customerHistoryReport },
  products: { title: "Product Report", permission: "reports:products", run: productsReport },
  inventory: { title: "Inventory Report", permission: "reports:inventory", run: inventoryReport },
  stock: { title: "Stock Report", permission: "reports:inventory", run: stockMovementReport },
  "low-stock": { title: "Low Stock Report", permission: "reports:inventory", run: lowStockReport },
  purchases: { title: "Purchase Report", permission: "reports:purchases", run: purchasesReport },
  billing: { title: "Billing & Invoice Report", permission: "reports:billing", run: billingReport },
  expenses: { title: "Expense Report", permission: "reports:expenses", run: expensesReport },
};

const querySchema = z.object({
  from: zDate.optional(),
  to: zDate.optional(),
  groupBy: z.enum(["day", "month"]).optional(),
  customerId: zUuid.optional(),
  section: z.string().max(40).optional(),
});

async function runReport(req: Request) {
  const type = String(req.params.type);
  const definition = REPORTS[type];
  if (!definition) throw notFound("Unknown report.");
  if (!can(req, definition.permission)) throw forbidden();

  const query = parse(querySchema, req.query);
  const to = query.to ?? istDate();
  const from = query.from ?? istDate(new Date(istDateStart(to).getTime() - 29 * 86_400_000));
  if (from > to) throw invalid({ from: "The start date must be on or before the end date." });
  const days = Math.round((istDateStart(to).getTime() - istDateStart(from).getTime()) / 86_400_000) + 1;
  if (days > 3660) throw invalid({ from: "Choose a period of ten years or less." });
  const ctx: Ctx = { req, from, to, start: istDateStart(from), end: istDateEnd(to), groupBy: query.groupBy ?? (days > 62 ? "month" : "day"), customerId: query.customerId };

  const body = await definition.run(ctx);
  return { report: { type, title: definition.title, period: { from, to }, groupBy: ctx.groupBy, generatedAt: new Date().toISOString(), ...body }, section: query.section };
}

reportsRouter.get("/reports", (req, res) => {
  adminOf(req);
  res.json(
    Object.entries(REPORTS)
      .filter(([, definition]) => can(req, definition.permission))
      .map(([type, definition]) => ({ type, title: definition.title })),
  );
});

reportsRouter.get("/reports/:type", async (req, res) => {
  res.json((await runReport(req)).report);
});

/** Neutralises spreadsheet formula injection and quotes values. */
function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

reportsRouter.get("/reports/:type/export.csv", async (req, res) => {
  const { report, section } = await runReport(req);
  const chosen = report.sections.find((s) => s.key === section) ?? report.sections[0];
  if (!chosen) throw notFound();
  const lines = [chosen.columns.map((col) => csvCell(col.label)).join(","), ...chosen.rows.map((row) => chosen.columns.map((col) => csvCell(row[col.key])).join(","))];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${report.type}-${chosen.key}-${report.period.from}-to-${report.period.to}.csv"`);
  res.send(`﻿${lines.join("\r\n")}\r\n`);
});
