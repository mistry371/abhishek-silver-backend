import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "@/db/client";
import {
  customerAddresses,
  customerNotes,
  customers,
  enquiries,
  invoices,
  orders,
  products,
  saleItems,
  sales,
  wishlistItems,
} from "@/db/schema";
import { adminOf, requirePermission } from "@/http/auth";
import { conflict, invalid, notFound } from "@/lib/errors";
import { istDateEnd, istDateStart } from "@/lib/dates";
import { paginated, parse, partialUpdate, zDate, zEmail, zMobile, zText } from "@/lib/validation";
import { addressSchema } from "@/modules/account/schemas";
import { toAddressDto } from "@/modules/account/presenter";
import { actorOf, diff, recordAudit } from "@/services/audit";
import { createCustomerRecord, customerName } from "@/services/customers";
import { idParam, listQuery, searchAny, sortBy, toDate, toNumber, withinDates } from "./helpers";

export const customersRouter = Router();

/** Purchase totals come from recorded sales (online + manual), excluding refunded sales. */
const salesAggregate = () =>
  db()
    .select({
      customerId: sales.customerId,
      purchaseCount: sql<number>`count(*)`.as("purchase_count"),
      totalSpent: sql<number>`coalesce(sum(${sales.grandTotal}), 0)`.as("total_spent"),
      firstPurchaseAt: sql<Date>`min(${sales.createdAt})`.as("first_purchase_at"),
      lastPurchaseAt: sql<Date>`max(${sales.createdAt})`.as("last_purchase_at"),
    })
    .from(sales)
    .where(and(isNotNull(sales.customerId), ne(sales.paymentStatus, "refunded")))
    .groupBy(sales.customerId)
    .as("sales_agg");

const listSchema = listQuery.extend({
  status: z.enum(["active", "inactive", "blocked"]).optional(),
  source: z.enum(["website", "admin", "walk_in"]).optional(),
  registeredFrom: zDate.optional(),
  registeredTo: zDate.optional(),
  lastPurchaseFrom: zDate.optional(),
  lastPurchaseTo: zDate.optional(),
  minSpent: z.coerce.number().min(0).optional(),
  maxSpent: z.coerce.number().min(0).optional(),
});

customersRouter.get("/customers", requirePermission("customers:view"), async (req, res) => {
  const query = parse(listSchema, req.query);
  const agg = salesAggregate();
  const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

  const conditions: (SQL | undefined)[] = [
    query.status ? eq(customers.status, query.status) : undefined,
    query.source ? eq(customers.source, query.source) : undefined,
    ...withinDates(customers.createdAt, query.registeredFrom, query.registeredTo),
    query.lastPurchaseFrom ? gte(agg.lastPurchaseAt, istDateStart(query.lastPurchaseFrom)) : undefined,
    query.lastPurchaseTo ? sql`${agg.lastPurchaseAt} < ${istDateEnd(query.lastPurchaseTo).toISOString()}::timestamptz` : undefined,
    query.minSpent !== undefined ? gte(sql`coalesce(${agg.totalSpent}, 0)`, query.minSpent) : undefined,
    query.maxSpent !== undefined ? lte(sql`coalesce(${agg.totalSpent}, 0)`, query.maxSpent) : undefined,
    pattern
      ? or(
          searchAny(query.q, [sql`concat_ws(' ', ${customers.firstName}, ${customers.lastName})`, customers.email, customers.phone, customers.customerCode]),
          sql`exists (select 1 from ${orders} where ${orders.customerId} = ${customers.id} and ${orders.orderNumber} ilike ${pattern})`,
        )
      : undefined,
  ];
  const where = and(...conditions);

  const rows = await db()
    .select({
      customer: customers,
      purchaseCount: agg.purchaseCount,
      totalSpent: agg.totalSpent,
      lastPurchaseAt: agg.lastPurchaseAt,
    })
    .from(customers)
    .leftJoin(agg, eq(agg.customerId, customers.id))
    .where(where)
    .orderBy(
      sortBy(
        query.sort,
        { createdAt: customers.createdAt, name: customers.firstName, totalSpent: sql`coalesce(${agg.totalSpent}, 0)`, lastPurchaseAt: agg.lastPurchaseAt },
        desc(customers.createdAt),
      ),
    )
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const [total] = await db()
    .select({ value: sql<number>`count(*)`.mapWith(Number) })
    .from(customers)
    .leftJoin(agg, eq(agg.customerId, customers.id))
    .where(where);

  res.json(
    paginated(
      rows.map((row) => ({
        id: row.customer.id,
        customerCode: row.customer.customerCode,
        name: customerName(row.customer),
        firstName: row.customer.firstName,
        lastName: row.customer.lastName,
        email: row.customer.email,
        phone: row.customer.phone,
        status: row.customer.status,
        source: row.customer.source,
        hasAccount: Boolean(row.customer.authUserId),
        marketingOptIn: row.customer.marketingOptIn,
        purchaseCount: toNumber(row.purchaseCount),
        totalSpent: toNumber(row.totalSpent),
        lastPurchaseAt: toDate(row.lastPurchaseAt),
        createdAt: row.customer.createdAt,
      })),
      total?.value ?? 0,
      query.page,
      query.pageSize,
    ),
  );
});

async function loadCustomer(id: string) {
  const [customer] = await db().select().from(customers).where(eq(customers.id, id)).limit(1);
  if (!customer) throw notFound("Customer not found.");
  return customer;
}

/** Customer 360: profile, addresses, orders, purchases, invoices, wishlist, enquiries, notes and activity. */
customersRouter.get("/customers/:id", requirePermission("customers:view"), async (req, res) => {
  const customer = await loadCustomer(idParam(req));
  const database = db();

  const addresses = await database.select().from(customerAddresses).where(eq(customerAddresses.customerId, customer.id)).orderBy(asc(customerAddresses.createdAt));
  const orderRows = await database
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      itemCount: orders.itemCount,
      grandTotal: orders.grandTotal,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(eq(orders.customerId, customer.id))
    .orderBy(desc(orders.createdAt))
    .limit(100);
  const saleRows = await database.select().from(sales).where(eq(sales.customerId, customer.id)).orderBy(desc(sales.createdAt)).limit(100);
  const saleLines = saleRows.length
    ? await database
        .select({ saleId: saleItems.saleId, name: saleItems.name, sku: saleItems.sku, quantity: saleItems.quantity, lineTotal: saleItems.lineTotal })
        .from(saleItems)
        .where(
          inArray(
            saleItems.saleId,
            saleRows.map((s) => s.id),
          ),
        )
    : [];
  const invoiceRows = await database
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      source: invoices.source,
      grandTotal: invoices.grandTotal,
      balanceDue: invoices.balanceDue,
      issuedAt: invoices.issuedAt,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .where(eq(invoices.customerId, customer.id))
    .orderBy(desc(invoices.createdAt))
    .limit(100);
  const wishlist = await database
    .select({ productId: products.id, name: products.name, sku: products.sku, images: products.images, status: products.status, addedAt: wishlistItems.addedAt })
    .from(wishlistItems)
    .innerJoin(products, eq(products.id, wishlistItems.productId))
    .where(eq(wishlistItems.customerId, customer.id))
    .orderBy(desc(wishlistItems.addedAt));
  const enquiryRows = await database
    .select({ id: enquiries.id, reference: enquiries.reference, type: enquiries.type, status: enquiries.status, message: enquiries.message, createdAt: enquiries.createdAt })
    .from(enquiries)
    .where(customer.email ? or(eq(enquiries.customerId, customer.id), eq(sql`lower(${enquiries.email})`, customer.email.toLowerCase())) : eq(enquiries.customerId, customer.id))
    .orderBy(desc(enquiries.createdAt))
    .limit(100);
  const notes = await database.select().from(customerNotes).where(eq(customerNotes.customerId, customer.id)).orderBy(desc(customerNotes.createdAt));

  const counted = saleRows.filter((s) => s.paymentStatus !== "refunded");
  const totalSpent = counted.reduce((sum, s) => sum + s.grandTotal, 0);
  const purchaseDates = counted.map((s) => s.createdAt.getTime());

  const activity = [
    ...orderRows.map((o) => ({ at: o.createdAt, type: "order", label: `Order ${o.orderNumber} placed`, href: `/admin/orders/${o.id}` })),
    ...saleRows.filter((s) => s.channel === "manual").map((s) => ({ at: s.createdAt, type: "sale", label: `In-store sale ${s.saleNumber}`, href: `/admin/sales/${s.id}` })),
    ...invoiceRows
      .filter((i) => i.issuedAt)
      .map((i) => ({ at: i.issuedAt!, type: "invoice", label: `Invoice ${i.invoiceNumber} issued`, href: `/admin/invoices/${i.id}` })),
    ...enquiryRows.map((e) => ({ at: e.createdAt, type: "enquiry", label: `Enquiry ${e.reference}`, href: `/admin/enquiries/${e.id}` })),
    ...notes.map((n) => ({ at: n.createdAt, type: "note", label: `Note by ${n.authorName}`, href: null })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 20);

  res.json({
    customer: { ...customer, name: customerName(customer), hasAccount: Boolean(customer.authUserId), authUserId: undefined },
    stats: {
      totalSpent,
      purchaseCount: counted.length,
      onlineOrderCount: orderRows.filter((o) => o.paymentStatus === "paid" || o.paymentStatus === "refunded").length,
      averagePurchaseValue: counted.length ? Math.round(totalSpent / counted.length) : 0,
      firstPurchaseAt: purchaseDates.length ? new Date(Math.min(...purchaseDates)) : null,
      lastPurchaseAt: purchaseDates.length ? new Date(Math.max(...purchaseDates)) : null,
    },
    addresses: addresses.map(toAddressDto),
    orders: orderRows,
    purchases: saleRows.map((s) => ({
      id: s.id,
      saleNumber: s.saleNumber,
      channel: s.channel,
      grandTotal: s.grandTotal,
      paymentStatus: s.paymentStatus,
      createdAt: s.createdAt,
      items: saleLines.filter((line) => line.saleId === s.id),
    })),
    invoices: invoiceRows,
    wishlist: wishlist.map((w) => ({ productId: w.productId, name: w.name, sku: w.sku, image: w.images[0] ?? null, status: w.status, addedAt: w.addedAt })),
    enquiries: enquiryRows,
    notes,
    activity,
  });
});

const customerSchema = z.object({
  firstName: zText(60),
  lastName: z.string().trim().max(60).default(""),
  email: zEmail.optional().nullable(),
  phone: zMobile.optional().nullable(),
  status: z.enum(["active", "inactive", "blocked"]).default("active"),
  marketingOptIn: z.boolean().default(false),
});

async function assertNoDuplicate(input: { email?: string | null; phone?: string | null }, exceptId?: string) {
  const checks = [input.email ? eq(customers.email, input.email) : undefined, input.phone ? eq(customers.phone, input.phone) : undefined].filter(Boolean) as SQL[];
  if (!checks.length) return;
  const matches = await db()
    .select({ id: customers.id, code: customers.customerCode, email: customers.email, phone: customers.phone })
    .from(customers)
    .where(and(or(...checks), exceptId ? ne(customers.id, exceptId) : undefined))
    .limit(5);
  const fieldErrors: Record<string, string> = {};
  const byEmail = input.email ? matches.find((m) => m.email === input.email) : undefined;
  const byPhone = input.phone ? matches.find((m) => m.phone === input.phone) : undefined;
  if (byEmail) fieldErrors.email = `Customer ${byEmail.code} already uses this email.`;
  if (byPhone) fieldErrors.phone = `Customer ${byPhone.code} already uses this mobile number.`;
  if (Object.keys(fieldErrors).length) throw invalid(fieldErrors);
}

customersRouter.post("/customers", requirePermission("customers:manage"), async (req, res) => {
  const input = parse(customerSchema.extend({ source: z.enum(["admin", "walk_in"]).default("walk_in") }), req.body);
  if (!input.email && !input.phone) throw invalid({ phone: "Add a mobile number or email so the customer can be found later." });
  await assertNoDuplicate(input);

  const customer = await db().transaction(async (tx) => {
    const row = await createCustomerRecord(tx, { ...input, email: input.email ?? null, phone: input.phone ?? null });
    if (input.status !== "active") await tx.update(customers).set({ status: input.status }).where(eq(customers.id, row.id));
    await recordAudit(tx, actorOf(req), {
      module: "customers",
      action: "customer.create",
      entityType: "customer",
      entityId: row.id,
      entityLabel: `${row.customerCode} ${customerName(row)}`,
      after: { firstName: row.firstName, lastName: row.lastName, email: row.email, phone: row.phone, source: row.source },
    });
    return row;
  });
  res.status(201).json(customer);
});

customersRouter.patch("/customers/:id", requirePermission("customers:manage"), async (req, res) => {
  const current = await loadCustomer(idParam(req));
  const patch = parse(partialUpdate(customerSchema), req.body);
  await assertNoDuplicate({ email: patch.email, phone: patch.phone }, current.id);
  if (current.authUserId && patch.email !== undefined && patch.email !== current.email) {
    // The sign-in email lives in the identity provider; changing it here would desynchronise them.
    throw invalid({ email: "This customer signs in with their email. Ask them to update it from their account." });
  }

  const updated = await db().transaction(async (tx) => {
    const [row] = await tx
      .update(customers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(customers.id, current.id))
      .returning();
    const changes = diff(current, row!);
    if (changes.changed) {
      await recordAudit(tx, actorOf(req), {
        module: "customers",
        action: "customer.update",
        entityType: "customer",
        entityId: current.id,
        entityLabel: `${current.customerCode} ${customerName(current)}`,
        before: changes.before,
        after: changes.after,
        sensitive: true,
      });
    }
    return row!;
  });
  res.json(updated);
});

customersRouter.post("/customers/:id/addresses", requirePermission("customers:manage"), async (req, res) => {
  const customer = await loadCustomer(idParam(req));
  const input = parse(addressSchema, req.body);
  await db().transaction(async (tx) => {
    const existing = await tx.select({ id: customerAddresses.id }).from(customerAddresses).where(eq(customerAddresses.customerId, customer.id));
    const first = existing.length === 0;
    if (input.isDefaultShipping) await tx.update(customerAddresses).set({ isDefaultShipping: false }).where(eq(customerAddresses.customerId, customer.id));
    if (input.isDefaultBilling) await tx.update(customerAddresses).set({ isDefaultBilling: false }).where(eq(customerAddresses.customerId, customer.id));
    await tx.insert(customerAddresses).values({
      customerId: customer.id,
      label: input.label ?? null,
      fullName: input.fullName,
      phone: input.phone,
      line1: input.line1,
      line2: input.line2 ?? null,
      landmark: input.landmark ?? null,
      city: input.city,
      state: input.state,
      postalCode: input.postalCode,
      country: input.country,
      isDefaultShipping: first || Boolean(input.isDefaultShipping),
      isDefaultBilling: first || Boolean(input.isDefaultBilling),
    });
    await recordAudit(tx, actorOf(req), {
      module: "customers",
      action: "customer.address_add",
      entityType: "customer",
      entityId: customer.id,
      entityLabel: customer.customerCode,
      after: { city: input.city, postalCode: input.postalCode },
    });
  });
  const rows = await db().select().from(customerAddresses).where(eq(customerAddresses.customerId, customer.id)).orderBy(asc(customerAddresses.createdAt));
  res.status(201).json(rows.map(toAddressDto));
});

customersRouter.delete("/customers/:id/addresses/:addressId", requirePermission("customers:manage"), async (req, res) => {
  const customer = await loadCustomer(idParam(req));
  const addressId = idParam(req, "addressId");
  const [removed] = await db()
    .delete(customerAddresses)
    .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customer.id)))
    .returning();
  if (!removed) throw notFound();
  // Keep a default shipping/billing address when the default one is removed.
  const remaining = await db().select().from(customerAddresses).where(eq(customerAddresses.customerId, customer.id)).orderBy(asc(customerAddresses.createdAt));
  if (remaining.length && !remaining.some((a) => a.isDefaultShipping)) {
    await db().update(customerAddresses).set({ isDefaultShipping: true }).where(eq(customerAddresses.id, remaining[0]!.id));
  }
  if (remaining.length && !remaining.some((a) => a.isDefaultBilling)) {
    await db().update(customerAddresses).set({ isDefaultBilling: true }).where(eq(customerAddresses.id, remaining[0]!.id));
  }
  await recordAudit(db(), actorOf(req), {
    module: "customers",
    action: "customer.address_remove",
    entityType: "customer",
    entityId: customer.id,
    entityLabel: customer.customerCode,
    before: { city: removed.city, postalCode: removed.postalCode },
  });
  res.status(204).end();
});

customersRouter.post("/customers/:id/notes", requirePermission("customers:notes"), async (req, res) => {
  const customer = await loadCustomer(idParam(req));
  const { body } = parse(z.object({ body: zText(2000) }), req.body);
  const admin = adminOf(req);
  const [note] = await db().insert(customerNotes).values({ customerId: customer.id, body, authorAdminId: admin.id, authorName: admin.name }).returning();
  res.status(201).json(note);
});

customersRouter.delete("/customers/:id/notes/:noteId", requirePermission("customers:notes"), async (req, res) => {
  const admin = adminOf(req);
  const [note] = await db()
    .select()
    .from(customerNotes)
    .where(and(eq(customerNotes.id, idParam(req, "noteId")), eq(customerNotes.customerId, idParam(req))))
    .limit(1);
  if (!note) throw notFound();
  if (note.authorAdminId !== admin.id && admin.roleId !== "super_admin") throw conflict("Only the author or a Super Admin can remove this note.");
  await db().delete(customerNotes).where(eq(customerNotes.id, note.id));
  res.status(204).end();
});
