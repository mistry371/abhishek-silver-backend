import { and, desc, eq, gte, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "@/db/client";
import {
  auditLogs,
  customers,
  enquiries,
  expenseCategories,
  expenses,
  inventoryLevels,
  invoices,
  orders,
  products,
  purchases,
  sales,
  vendors,
} from "@/db/schema";
import { can, requirePermission } from "@/http/auth";
import { istDate, startOfIstDay, startOfIstMonth } from "@/lib/dates";
import { toNumber } from "./helpers";

export const dashboardRouter = Router();

/** Orders that never reached payment are checkout attempts, not orders. */
export const placedOrder = () => or(ne(orders.status, "new"), inArray(orders.paymentStatus, ["paid", "authorized", "refunded"]));

export async function stockTotals() {
  const rows = await db()
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      status: products.status,
      threshold: products.lowStockThreshold,
      purchasePrice: products.purchasePrice,
      quantity: sql<number>`coalesce(sum(${inventoryLevels.quantity}), 0)`.mapWith(Number),
    })
    .from(products)
    .leftJoin(inventoryLevels, eq(inventoryLevels.productId, products.id))
    .where(isNull(products.deletedAt))
    .groupBy(products.id);
  return rows;
}

/**
 * Every figure is computed from recorded data. Sections the admin isn't
 * permitted to see are returned as null, so each role gets "relevant metrics".
 */
dashboardRouter.get("/dashboard", requirePermission("dashboard:view"), async (req, res) => {
  const database = db();
  const today = startOfIstDay();
  const monthStart = startOfIstMonth();
  const result: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  if (can(req, "dashboard:financials")) {
    const [salesRow] = await database
      .select({
        total: sql<number>`coalesce(sum(${sales.grandTotal}), 0)`.mapWith(Number),
        today: sql<number>`coalesce(sum(${sales.grandTotal}) filter (where ${sales.createdAt} >= ${today.toISOString()}::timestamptz), 0)`.mapWith(Number),
        month: sql<number>`coalesce(sum(${sales.grandTotal}) filter (where ${sales.createdAt} >= ${monthStart.toISOString()}::timestamptz), 0)`.mapWith(Number),
      })
      .from(sales)
      .where(ne(sales.paymentStatus, "refunded"));
    const [billed] = await database
      .select({ month: sql<number>`coalesce(sum(${invoices.grandTotal}), 0)`.mapWith(Number) })
      .from(invoices)
      .where(and(inArray(invoices.status, ["issued", "partially_paid", "paid"]), gte(invoices.issuedAt, monthStart)));
    const [spent] = await database
      .select({ month: sql<number>`coalesce(sum(${expenses.totalAmount}), 0)`.mapWith(Number) })
      .from(expenses)
      .where(and(inArray(expenses.status, ["approved", "paid"]), gte(expenses.expenseDate, istDate(monthStart))));
    result.financials = {
      totalSales: salesRow!.total,
      todaySales: salesRow!.today,
      monthlySales: salesRow!.month,
      billedThisMonth: billed!.month,
      expensesThisMonth: spent!.month,
    };
  } else {
    result.financials = null;
  }

  if (can(req, "orders:view")) {
    const statusRows = await database
      .select({ status: orders.status, value: sql<number>`count(*)`.mapWith(Number) })
      .from(orders)
      .where(placedOrder())
      .groupBy(orders.status);
    const countOf = (...statuses: string[]) => statusRows.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row.value, 0);
    result.orders = {
      total: statusRows.reduce((sum, row) => sum + row.value, 0),
      pending: countOf("confirmed", "processing", "packed", "shipped"),
      completed: countOf("delivered", "completed"),
    };
    result.ordersRequiringAction = await database
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        customerName: orders.customerName,
        grandTotal: orders.grandTotal,
        stockCommitted: orders.stockCommitted,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(or(inArray(orders.status, ["confirmed", "processing", "packed"]), and(eq(orders.paymentStatus, "paid"), eq(orders.stockCommitted, false))))
      .orderBy(orders.createdAt)
      .limit(8);
  } else {
    result.orders = null;
    result.ordersRequiringAction = null;
  }

  result.customers = can(req, "customers:view")
    ? { total: toNumber((await database.select({ value: sql<number>`count(*)` }).from(customers))[0]?.value) }
    : null;

  if (can(req, "products:view") || can(req, "inventory:view")) {
    const totals = await stockTotals();
    const active = totals.filter((row) => row.status === "active");
    result.products = { total: totals.length, active: active.length };

    if (can(req, "inventory:view")) {
      const low = active.filter((row) => row.quantity > 0 && row.quantity <= row.threshold);
      result.inventory = {
        availableUnits: totals.reduce((sum, row) => sum + Math.max(row.quantity, 0), 0),
        lowStock: low.length,
        outOfStock: active.filter((row) => row.quantity <= 0).length,
        ...(can(req, "inventory:view_valuation")
          ? {
              valuation: Math.round(totals.reduce((sum, row) => sum + (row.purchasePrice !== null ? row.quantity * row.purchasePrice : 0), 0)),
              // Stocked products without a purchase price are excluded from valuation — shown so the figure is never misleading.
              productsMissingCost: totals.filter((row) => row.quantity > 0 && row.purchasePrice === null).length,
            }
          : {}),
      };
      result.lowStockList = [...low, ...active.filter((row) => row.quantity <= 0)]
        .sort((a, b) => a.quantity - b.quantity)
        .slice(0, 8)
        .map(({ id, name, sku, quantity, threshold }) => ({ id, name, sku, quantity, threshold }));
    } else {
      result.inventory = null;
      result.lowStockList = null;
    }
  } else {
    result.products = null;
    result.inventory = null;
    result.lowStockList = null;
  }

  result.recentSales = can(req, "sales:view")
    ? await database
        .select({ id: sales.id, saleNumber: sales.saleNumber, channel: sales.channel, customerName: sales.customerName, grandTotal: sales.grandTotal, createdAt: sales.createdAt })
        .from(sales)
        .orderBy(desc(sales.createdAt))
        .limit(5)
    : null;

  result.recentPurchases = can(req, "purchases:view")
    ? await database
        .select({ id: purchases.id, purchaseNumber: purchases.purchaseNumber, vendorName: vendors.name, status: purchases.status, total: purchases.total, purchaseDate: purchases.purchaseDate })
        .from(purchases)
        .innerJoin(vendors, eq(vendors.id, purchases.vendorId))
        .orderBy(desc(purchases.createdAt))
        .limit(5)
    : null;

  result.recentEnquiries = can(req, "enquiries:view")
    ? await database
        .select({ id: enquiries.id, reference: enquiries.reference, type: enquiries.type, name: enquiries.name, status: enquiries.status, createdAt: enquiries.createdAt })
        .from(enquiries)
        .orderBy(desc(enquiries.createdAt))
        .limit(5)
    : null;

  result.recentExpenses = can(req, "expenses:view")
    ? await database
        .select({
          id: expenses.id,
          expenseNumber: expenses.expenseNumber,
          category: expenseCategories.name,
          payee: expenses.payee,
          totalAmount: expenses.totalAmount,
          status: expenses.status,
          expenseDate: expenses.expenseDate,
        })
        .from(expenses)
        .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
        .orderBy(desc(expenses.createdAt))
        .limit(5)
    : null;

  result.recentInvoices = can(req, "billing:view")
    ? await database
        .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status, customer: invoices.customer, grandTotal: invoices.grandTotal, createdAt: invoices.createdAt })
        .from(invoices)
        .where(notInArray(invoices.status, ["draft"]))
        .orderBy(desc(invoices.createdAt))
        .limit(5)
    : null;

  result.recentActivity = can(req, "audit:view")
    ? await database
        .select({ id: auditLogs.id, actorName: auditLogs.actorName, module: auditLogs.module, action: auditLogs.action, entityLabel: auditLogs.entityLabel, createdAt: auditLogs.createdAt })
        .from(auditLogs)
        .orderBy(desc(auditLogs.createdAt))
        .limit(8)
    : null;

  res.json(result);
});
