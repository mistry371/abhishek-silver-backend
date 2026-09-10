import { and, asc, count, desc, eq, gt, gte, inArray, lt, notExists, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db, type Tx } from "@/db/client";
import { contentBlocks, customers, invoiceEvents, invoiceItems, invoicePayments, invoices, orders, sales } from "@/db/schema";
import { requirePermission } from "@/http/auth";
import { AppError, invalid, notFound } from "@/lib/errors";
import { istDate, istDateEnd, istDateStart, startOfIstMonth } from "@/lib/dates";
import { round2 } from "@/lib/money";
import { paginated, parse, zDate, zEmail, zMobile, zMoney, zText, zUuid, zWeight } from "@/lib/validation";
import { METALS, PURITIES } from "@/modules/catalog/labels";
import { actorOf, recordAudit } from "@/services/audit";
import { assignInvoiceNumber, computeTaxLine } from "@/services/billing";
import { customerName } from "@/services/customers";
import { getSetting } from "@/services/settings";
import { idParam, listQuery, searchAny, sortBy, withinDates } from "./helpers";

export const billingRouter = Router();

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => value || null);

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, { error: "Enter a valid 15-character GSTIN." })
  .nullable()
  .optional()
  .or(z.literal("").transform(() => null));

export const PAYMENT_METHODS = ["cash", "upi", "card", "bank_transfer", "cheque", "other"] as const;

const invoiceItemSchema = z.object({
  productId: zUuid.nullable().optional(),
  description: zText(200),
  sku: optionalText(40),
  size: optionalText(10),
  metal: z.enum(METALS).nullable().optional(),
  purity: z.enum(PURITIES).nullable().optional(),
  quantity: z.number().int().min(1).max(10_000),
  grossWeight: zWeight.nullable().optional(),
  netWeight: zWeight.nullable().optional(),
  /** Pre-tax unit price. */
  unitPrice: zMoney,
  /** Pre-tax discount for the whole line. */
  discount: zMoney.default(0),
  gstRate: z.number().min(0).max(28),
});

const invoiceSchema = z.object({
  customerId: zUuid.nullable().optional(),
  customer: z.object({
    name: zText(160),
    mobile: zMobile.nullable().optional(),
    email: zEmail.nullable().optional(),
    address: optionalText(500),
    gstin: gstinSchema,
  }),
  items: z.array(invoiceItemSchema).min(1).max(100),
  dueDate: zDate.nullable().optional(),
  notes: optionalText(2000),
});

type InvoiceInput = z.output<typeof invoiceSchema>;

/** Totals are always computed on the server from the lines. */
function computeInvoice(input: InvoiceInput) {
  const lines = input.items.map((item, position) => {
    const line = computeTaxLine(item);
    return {
      productId: item.productId ?? null,
      description: item.description,
      sku: item.sku,
      size: item.size,
      metal: item.metal ?? null,
      purity: item.purity ?? null,
      quantity: item.quantity,
      grossWeight: item.grossWeight ?? null,
      netWeight: item.netWeight ?? null,
      unitPrice: round2(item.unitPrice),
      discount: line.discount,
      taxableValue: line.taxableValue,
      gstRate: item.gstRate,
      gstAmount: line.gstAmount,
      lineTotal: line.lineTotal,
      position,
      gross: line.gross,
    };
  });
  const errors: Record<string, string> = {};
  input.items.forEach((item, index) => {
    if (item.discount > round2(item.unitPrice * item.quantity)) errors[`items.${index}.discount`] = "The discount can't exceed the line value.";
  });
  if (Object.keys(errors).length) throw invalid(errors);

  const taxableValue = round2(lines.reduce((sum, l) => sum + l.taxableValue, 0));
  const gst = round2(lines.reduce((sum, l) => sum + l.gstAmount, 0));
  return {
    lines: lines.map(({ gross: _gross, ...line }) => {
      void _gross;
      return line;
    }),
    totals: {
      subtotal: round2(lines.reduce((sum, l) => sum + l.gross, 0)),
      discount: round2(lines.reduce((sum, l) => sum + l.discount, 0)),
      taxableValue,
      gst,
      grandTotal: round2(taxableValue + gst),
    },
  };
}

async function lockInvoice(tx: Tx, id: string) {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
  if (!invoice) throw notFound("Invoice not found.");
  return invoice;
}

async function invoiceDetail(id: string) {
  const database = db();
  const [invoice] = await database.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!invoice) throw notFound("Invoice not found.");
  const [items, payments, events, general, contact] = [
    await database.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id)).orderBy(asc(invoiceItems.position)),
    await database.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, id)).orderBy(asc(invoicePayments.receivedAt)),
    await database.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, id)).orderBy(asc(invoiceEvents.createdAt)),
    await getSetting("general"),
    (await database.select().from(contentBlocks).where(eq(contentBlocks.key, "contact")).limit(1))[0]?.value as
      | { storeName?: string; addressLines?: string[]; city?: string; state?: string; postalCode?: string; phones?: { display: string }[] }
      | undefined,
  ];
  const order = invoice.orderId ? (await database.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, invoice.orderId)))[0] : null;
  const sale = invoice.saleId ? (await database.select({ id: sales.id, saleNumber: sales.saleNumber }).from(sales).where(eq(sales.id, invoice.saleId)))[0] : null;

  return {
    ...invoice,
    items,
    payments,
    events,
    order: order ?? null,
    sale: sale ?? null,
    // Seller details for the printable invoice. Legal name and GSTIN come from Settings → General.
    seller: {
      name: general.legalName || general.businessName,
      gstin: general.gstin,
      stateCode: general.stateCode,
      address:
        general.invoiceAddress ||
        (contact ? [...(contact.addressLines ?? []), `${contact.city ?? ""}, ${contact.state ?? ""} ${contact.postalCode ?? ""}`.trim()].join(", ") : ""),
      phone: contact?.phones?.[0]?.display ?? "",
      email: general.supportEmail,
      footerNote: (await getSetting("billing")).footerNote,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Summary & listing                                                   */
/* ------------------------------------------------------------------ */

billingRouter.get("/billing/summary", requirePermission("billing:view"), async (req, res) => {
  const { from, to } = parse(z.object({ from: zDate.optional(), to: zDate.optional() }), req.query);
  const start = from ? istDateStart(from) : startOfIstMonth();
  const end = to ? istDateEnd(to) : new Date(Date.now() + 1);
  const database = db();

  const [period] = await database
    .select({
      invoices: sql<number>`count(*)`.mapWith(Number),
      paid: sql<number>`count(*) filter (where ${invoices.status} = 'paid')`.mapWith(Number),
      partiallyPaid: sql<number>`count(*) filter (where ${invoices.status} = 'partially_paid')`.mapWith(Number),
      unpaid: sql<number>`count(*) filter (where ${invoices.status} = 'issued')`.mapWith(Number),
      billed: sql<number>`coalesce(sum(${invoices.grandTotal}), 0)`.mapWith(Number),
    })
    .from(invoices)
    .where(and(inArray(invoices.status, ["issued", "partially_paid", "paid"]), gte(invoices.issuedAt, start), lt(invoices.issuedAt, end)));
  const [collected] = await database
    .select({ value: sql<number>`coalesce(sum(${invoicePayments.amount}), 0)`.mapWith(Number) })
    .from(invoicePayments)
    .where(and(gte(invoicePayments.receivedAt, start), lt(invoicePayments.receivedAt, end)));
  const [outstanding] = await database
    .select({
      value: sql<number>`coalesce(sum(${invoices.balanceDue}), 0)`.mapWith(Number),
      overdue: sql<number>`count(*) filter (where ${invoices.dueDate} < ${istDate()})`.mapWith(Number),
    })
    .from(invoices)
    .where(and(inArray(invoices.status, ["issued", "partially_paid"]), gt(invoices.balanceDue, 0)));
  const [drafts] = await database.select({ value: count() }).from(invoices).where(eq(invoices.status, "draft"));

  // Exceptions: paid online orders that have no invoice (e.g. an interrupted finalisation).
  const paidWithoutInvoice = await database
    .select({ id: orders.id, orderNumber: orders.orderNumber, grandTotal: orders.grandTotal, paidAt: orders.paidAt })
    .from(orders)
    .where(and(eq(orders.paymentStatus, "paid"), notExists(database.select({ one: sql`1` }).from(invoices).where(eq(invoices.orderId, orders.id)))))
    .limit(20);

  const recent = await database
    .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status, customer: invoices.customer, grandTotal: invoices.grandTotal, balanceDue: invoices.balanceDue, issuedAt: invoices.issuedAt, createdAt: invoices.createdAt })
    .from(invoices)
    .orderBy(desc(invoices.createdAt))
    .limit(10);

  res.json({
    period: { from: start.toISOString(), to: end.toISOString() },
    counts: { issued: period!.invoices, paid: period!.paid, partiallyPaid: period!.partiallyPaid, unpaid: period!.unpaid, drafts: drafts?.value ?? 0 },
    billedTotal: period!.billed,
    collected: collected!.value,
    outstanding: outstanding!.value,
    overdueInvoices: outstanding!.overdue,
    exceptions: { paidOrdersWithoutInvoice: paidWithoutInvoice },
    recent,
  });
});

billingRouter.get("/invoices", requirePermission("billing:view"), async (req, res) => {
  const query = parse(
    listQuery.extend({
      status: z.enum(["draft", "issued", "partially_paid", "paid", "cancelled"]).optional(),
      source: z.enum(["online_order", "manual_sale", "manual"]).optional(),
      customerId: zUuid.optional(),
      from: zDate.optional(),
      to: zDate.optional(),
    }),
    req.query,
  );
  const where = and(
    query.status ? eq(invoices.status, query.status) : undefined,
    query.source ? eq(invoices.source, query.source) : undefined,
    query.customerId ? eq(invoices.customerId, query.customerId) : undefined,
    ...withinDates(invoices.createdAt, query.from, query.to),
    searchAny(query.q, [invoices.invoiceNumber, sql`${invoices.customer} ->> 'name'`, sql`${invoices.customer} ->> 'mobile'`]),
  );
  const rows = await db()
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      source: invoices.source,
      customer: invoices.customer,
      customerId: invoices.customerId,
      grandTotal: invoices.grandTotal,
      amountPaid: invoices.amountPaid,
      balanceDue: invoices.balanceDue,
      dueDate: invoices.dueDate,
      issuedAt: invoices.issuedAt,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .where(where)
    .orderBy(sortBy(query.sort, { createdAt: invoices.createdAt, issuedAt: invoices.issuedAt, grandTotal: invoices.grandTotal, balanceDue: invoices.balanceDue }, desc(invoices.createdAt)))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db().select({ value: count() }).from(invoices).where(where);
  res.json(paginated(rows, total?.value ?? 0, query.page, query.pageSize));
});

billingRouter.get("/invoices/:id", requirePermission("billing:view"), async (req, res) => {
  res.json(await invoiceDetail(idParam(req)));
});

/* ------------------------------------------------------------------ */
/* Manual invoices: draft → issued → partially paid / paid, or cancelled */
/* ------------------------------------------------------------------ */

async function customerSnapshot(tx: Tx, input: InvoiceInput) {
  if (!input.customerId) return { customerId: null, snapshot: input.customer };
  const [customer] = await tx.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
  if (!customer) throw invalid({ customerId: "Choose an existing customer." });
  return {
    customerId: customer.id,
    snapshot: {
      name: input.customer.name || customerName(customer),
      mobile: input.customer.mobile ?? customer.phone,
      email: input.customer.email ?? customer.email,
      address: input.customer.address ?? null,
      gstin: input.customer.gstin ?? null,
    },
  };
}

billingRouter.post("/invoices", requirePermission("billing:create"), async (req, res) => {
  const input = parse(invoiceSchema, req.body);
  const { lines, totals } = computeInvoice(input);
  const actor = actorOf(req);
  const invoice = await db().transaction(async (tx) => {
    const { customerId, snapshot } = await customerSnapshot(tx, input);
    const [row] = await tx
      .insert(invoices)
      .values({
        status: "draft",
        source: "manual",
        customerId,
        customer: snapshot,
        ...totals,
        balanceDue: totals.grandTotal,
        dueDate: input.dueDate ?? null,
        notes: input.notes,
        createdByName: actor.name,
      })
      .returning();
    await tx.insert(invoiceItems).values(lines.map((line) => ({ ...line, invoiceId: row!.id })));
    await tx.insert(invoiceEvents).values({ invoiceId: row!.id, action: "draft_created", actorName: actor.name });
    await recordAudit(tx, actor, { module: "billing", action: "invoice.create_draft", entityType: "invoice", entityId: row!.id, entityLabel: `Draft for ${snapshot.name}`, after: totals });
    return row!;
  });
  res.status(201).json(await invoiceDetail(invoice.id));
});

billingRouter.put("/invoices/:id", requirePermission("billing:create"), async (req, res) => {
  const id = idParam(req);
  const input = parse(invoiceSchema, req.body);
  const { lines, totals } = computeInvoice(input);
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const current = await lockInvoice(tx, id);
    if (current.status !== "draft" || current.source !== "manual") {
      throw new AppError("validation_error", "Only manual draft invoices can be edited. Issued invoices are locked.");
    }
    const { customerId, snapshot } = await customerSnapshot(tx, input);
    await tx
      .update(invoices)
      .set({ customerId, customer: snapshot, ...totals, balanceDue: totals.grandTotal, dueDate: input.dueDate ?? null, notes: input.notes, updatedAt: new Date() })
      .where(eq(invoices.id, id));
    await tx.delete(invoiceItems).where(eq(invoiceItems.invoiceId, id));
    await tx.insert(invoiceItems).values(lines.map((line) => ({ ...line, invoiceId: id })));
    await tx.insert(invoiceEvents).values({ invoiceId: id, action: "draft_updated", actorName: actor.name });
    await recordAudit(tx, actor, {
      module: "billing",
      action: "invoice.update_draft",
      entityType: "invoice",
      entityId: id,
      entityLabel: `Draft for ${snapshot.name}`,
      before: { grandTotal: current.grandTotal },
      after: totals,
    });
  });
  res.json(await invoiceDetail(id));
});

billingRouter.post("/invoices/:id/issue", requirePermission("billing:issue"), async (req, res) => {
  const id = idParam(req);
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const current = await lockInvoice(tx, id);
    if (current.status !== "draft") throw new AppError("validation_error", "Only draft invoices can be issued.");
    if (current.grandTotal <= 0) throw new AppError("validation_error", "An invoice needs a total above zero before it can be issued.");
    const invoiceNumber = await assignInvoiceNumber(tx);
    await tx
      .update(invoices)
      .set({ status: "issued", invoiceNumber, issuedAt: new Date(), amountPaid: 0, balanceDue: current.grandTotal, updatedAt: new Date() })
      .where(eq(invoices.id, id));
    await tx.insert(invoiceEvents).values({ invoiceId: id, action: "issued", note: invoiceNumber, actorName: actor.name });
    await recordAudit(tx, actor, {
      module: "billing",
      action: "invoice.issue",
      entityType: "invoice",
      entityId: id,
      entityLabel: invoiceNumber,
      after: { grandTotal: current.grandTotal },
      sensitive: true,
    });
  });
  res.json(await invoiceDetail(id));
});

billingRouter.post("/invoices/:id/payments", requirePermission("billing:record_payment"), async (req, res) => {
  const id = idParam(req);
  const input = parse(
    z.object({
      amount: z.number().positive().max(100_000_000),
      method: z.enum(PAYMENT_METHODS),
      reference: optionalText(120),
      receivedAt: z.iso.datetime({ offset: true }).optional(),
    }),
    req.body,
  );
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const current = await lockInvoice(tx, id);
    if (!["issued", "partially_paid"].includes(current.status)) throw new AppError("validation_error", "Payments can only be recorded against issued invoices.");
    const amount = round2(input.amount);
    if (amount > current.balanceDue + 0.005) throw invalid({ amount: `The balance due is ₹${current.balanceDue.toLocaleString("en-IN")}.` });

    const amountPaid = round2(current.amountPaid + amount);
    const balanceDue = round2(Math.max(current.grandTotal - amountPaid, 0));
    const status = balanceDue <= 0 ? "paid" : "partially_paid";
    await tx.insert(invoicePayments).values({
      invoiceId: id,
      amount,
      method: input.method,
      reference: input.reference,
      receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
      recordedByName: actor.name,
    });
    await tx.update(invoices).set({ amountPaid, balanceDue, status, updatedAt: new Date() }).where(eq(invoices.id, id));
    if (current.saleId) await tx.update(sales).set({ paymentStatus: status }).where(eq(sales.id, current.saleId));
    await tx.insert(invoiceEvents).values({ invoiceId: id, action: "payment_recorded", note: `₹${amount.toLocaleString("en-IN")} by ${input.method}`, actorName: actor.name });
    await recordAudit(tx, actor, {
      module: "billing",
      action: "invoice.payment",
      entityType: "invoice",
      entityId: id,
      entityLabel: current.invoiceNumber,
      before: { amountPaid: current.amountPaid, status: current.status },
      after: { amountPaid, status, method: input.method },
      sensitive: true,
    });
  });
  res.json(await invoiceDetail(id));
});

billingRouter.post("/invoices/:id/cancel", requirePermission("billing:cancel"), async (req, res) => {
  const id = idParam(req);
  const { reason } = parse(z.object({ reason: zText(500) }), req.body);
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const current = await lockInvoice(tx, id);
    if (current.status === "cancelled") return;
    const cancellable = current.status === "draft" || (current.source === "manual" && current.status === "issued" && current.amountPaid === 0);
    if (!cancellable) {
      throw new AppError(
        "validation_error",
        current.source === "manual"
          ? "Invoices with recorded payments can't be cancelled."
          : "Invoices for orders and in-store sales are cancelled through the order or sale (returns and refunds).",
      );
    }
    await tx.update(invoices).set({ status: "cancelled", cancelReason: reason, balanceDue: 0, updatedAt: new Date() }).where(eq(invoices.id, id));
    await tx.insert(invoiceEvents).values({ invoiceId: id, action: "cancelled", note: reason, actorName: actor.name });
    await recordAudit(tx, actor, {
      module: "billing",
      action: "invoice.cancel",
      entityType: "invoice",
      entityId: id,
      entityLabel: current.invoiceNumber ?? "Draft invoice",
      before: { status: current.status },
      after: { status: "cancelled" },
      reason,
      sensitive: true,
    });
  });
  res.json(await invoiceDetail(id));
});
