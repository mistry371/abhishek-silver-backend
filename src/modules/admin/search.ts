import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "@/db/client";
import { customers, enquiries, expenses, invoices, orders, products, purchases, vendors } from "@/db/schema";
import { can, requirePermission } from "@/http/auth";
import { parse } from "@/lib/validation";
import { searchAny } from "./helpers";

export const searchRouter = Router();

interface SearchHit {
  type: "product" | "customer" | "order" | "invoice" | "purchase" | "expense" | "enquiry";
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

/** Global search across products, SKU/barcode, customers, orders, invoices, purchases, expenses and enquiries. */
searchRouter.get("/search", requirePermission("dashboard:view"), async (req, res) => {
  const { q } = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
  const database = db();
  const limit = 5;
  const groups: Promise<SearchHit[]>[] = [];

  if (can(req, "products:view")) {
    groups.push(
      database
        .select({ id: products.id, name: products.name, sku: products.sku, status: products.status })
        .from(products)
        .where(and(isNull(products.deletedAt), searchAny(q, [products.name, products.sku, products.barcode])))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ type: "product", id: r.id, title: r.name, subtitle: `${r.sku} · ${r.status}`, href: `/admin/products/${r.id}` }))),
    );
  }
  if (can(req, "customers:view")) {
    groups.push(
      database
        .select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName, code: customers.customerCode, phone: customers.phone, email: customers.email })
        .from(customers)
        .where(searchAny(q, [sql`concat_ws(' ', ${customers.firstName}, ${customers.lastName})`, customers.email, customers.phone, customers.customerCode]))
        .limit(limit)
        .then((rows) =>
          rows.map((r) => ({
            type: "customer",
            id: r.id,
            title: `${r.firstName} ${r.lastName}`.trim(),
            subtitle: [r.code, r.phone, r.email].filter(Boolean).join(" · "),
            href: `/admin/customers/${r.id}`,
          })),
        ),
    );
  }
  if (can(req, "orders:view")) {
    groups.push(
      database
        .select({ id: orders.id, orderNumber: orders.orderNumber, customerName: orders.customerName, status: orders.status })
        .from(orders)
        .where(searchAny(q, [orders.orderNumber, orders.customerName, orders.customerPhone, orders.customerEmail]))
        .orderBy(desc(orders.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ type: "order", id: r.id, title: r.orderNumber, subtitle: `${r.customerName} · ${r.status}`, href: `/admin/orders/${r.id}` }))),
    );
  }
  if (can(req, "billing:view")) {
    groups.push(
      database
        .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, customer: invoices.customer, status: invoices.status })
        .from(invoices)
        .where(searchAny(q, [invoices.invoiceNumber, sql`${invoices.customer}->>'name'`, sql`${invoices.customer}->>'mobile'`]))
        .orderBy(desc(invoices.createdAt))
        .limit(limit)
        .then((rows) =>
          rows.map((r) => ({
            type: "invoice",
            id: r.id,
            title: r.invoiceNumber ?? "Draft invoice",
            subtitle: `${r.customer.name} · ${r.status}`,
            href: `/admin/invoices/${r.id}`,
          })),
        ),
    );
  }
  if (can(req, "purchases:view")) {
    groups.push(
      database
        .select({ id: purchases.id, purchaseNumber: purchases.purchaseNumber, vendorName: vendors.name, status: purchases.status })
        .from(purchases)
        .innerJoin(vendors, eq(vendors.id, purchases.vendorId))
        .where(searchAny(q, [purchases.purchaseNumber, purchases.vendorInvoiceRef, vendors.name]))
        .orderBy(desc(purchases.createdAt))
        .limit(limit)
        .then((rows) =>
          rows.map((r) => ({ type: "purchase", id: r.id, title: r.purchaseNumber, subtitle: `${r.vendorName} · ${r.status}`, href: `/admin/purchases/${r.id}` })),
        ),
    );
  }
  if (can(req, "expenses:view")) {
    groups.push(
      database
        .select({ id: expenses.id, expenseNumber: expenses.expenseNumber, payee: expenses.payee, status: expenses.status })
        .from(expenses)
        .where(searchAny(q, [expenses.expenseNumber, expenses.payee, expenses.referenceNumber, expenses.description]))
        .orderBy(desc(expenses.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ type: "expense", id: r.id, title: r.expenseNumber, subtitle: `${r.payee} · ${r.status}`, href: `/admin/expenses/${r.id}` }))),
    );
  }
  if (can(req, "enquiries:view")) {
    groups.push(
      database
        .select({ id: enquiries.id, reference: enquiries.reference, name: enquiries.name, status: enquiries.status })
        .from(enquiries)
        .where(searchAny(q, [enquiries.reference, enquiries.name, enquiries.mobile, enquiries.email]))
        .orderBy(desc(enquiries.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => ({ type: "enquiry", id: r.id, title: r.reference, subtitle: `${r.name} · ${r.status}`, href: `/admin/enquiries/${r.id}` }))),
    );
  }

  // Sequential awaits keep the embedded development database happy; each query is small.
  const results: SearchHit[] = [];
  for (const group of groups) results.push(...(await group));
  res.json({ query: q, results });
});
