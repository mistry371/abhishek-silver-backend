import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db/client";
import { customers, inventoryLevels, invoiceEvents, invoiceItems, invoicePayments, invoices, productCollections, products, saleItems, sales } from "@/db/schema";
import { requirePermission } from "@/http/auth";
import { AppError, invalid, notFound } from "@/lib/errors";
import { round2, rupees } from "@/lib/money";
import { paginated, parse, zDate, zEmail, zMobile, zMoney, zText, zUuid } from "@/lib/validation";
import { priceEntry, type CollectionRow } from "@/modules/catalog/snapshot";
import { loadPricingContext } from "@/modules/pricing/context";
import { MissingRateError } from "@/modules/pricing/engine";
import { actorOf, recordAudit } from "@/services/audit";
import { assignInvoiceNumber } from "@/services/billing";
import { createCustomerRecord, customerName } from "@/services/customers";
import { applyStockChange } from "@/services/inventory";
import { afterCatalogChange } from "@/services/revalidate";
import { documentNumbers } from "@/services/sequences";
import { gstinSchema, PAYMENT_METHODS } from "./billing";
import { idParam, listQuery, searchAny, sortBy, withinDates } from "./helpers";

export const salesRouter = Router();

/* ------------------------------------------------------------------ */
/* Listing & detail                                                    */
/* ------------------------------------------------------------------ */

salesRouter.get("/sales", requirePermission("sales:view"), async (req, res) => {
  const query = parse(
    listQuery.extend({
      channel: z.enum(["online", "manual"]).optional(),
      paymentStatus: z.enum(["pending", "partially_paid", "paid", "refunded"]).optional(),
      customerId: zUuid.optional(),
      from: zDate.optional(),
      to: zDate.optional(),
    }),
    req.query,
  );
  const where = and(
    query.channel ? eq(sales.channel, query.channel) : undefined,
    query.paymentStatus ? eq(sales.paymentStatus, query.paymentStatus) : undefined,
    query.customerId ? eq(sales.customerId, query.customerId) : undefined,
    ...withinDates(sales.createdAt, query.from, query.to),
    searchAny(query.q, [sales.saleNumber, sales.customerName, sales.customerPhone]),
  );
  const rows = await db()
    .select({ sale: sales, invoiceId: invoices.id, invoiceNumber: invoices.invoiceNumber })
    .from(sales)
    .leftJoin(invoices, eq(invoices.saleId, sales.id))
    .where(where)
    .orderBy(sortBy(query.sort, { createdAt: sales.createdAt, grandTotal: sales.grandTotal }, desc(sales.createdAt)))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db().select({ value: count() }).from(sales).where(where);
  res.json(
    paginated(
      rows.map((r) => ({ ...r.sale, invoice: r.invoiceId ? { id: r.invoiceId, invoiceNumber: r.invoiceNumber } : null })),
      total?.value ?? 0,
      query.page,
      query.pageSize,
    ),
  );
});

async function saleDetail(id: string) {
  const [sale] = await db().select().from(sales).where(eq(sales.id, id)).limit(1);
  if (!sale) throw notFound("Sale not found.");
  const items = await db().select().from(saleItems).where(eq(saleItems.saleId, id));
  const [invoice] = await db()
    .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status, amountPaid: invoices.amountPaid, balanceDue: invoices.balanceDue })
    .from(invoices)
    .where(eq(invoices.saleId, id))
    .limit(1);
  return { ...sale, items, invoice: invoice ?? null };
}

salesRouter.get("/sales/:id", requirePermission("sales:view"), async (req, res) => {
  res.json(await saleDetail(idParam(req)));
});

/* ------------------------------------------------------------------ */
/* Manual (in-store) sales                                             */
/* ------------------------------------------------------------------ */

const saleLineSchema = z.object({
  productId: zUuid,
  size: z.string().trim().max(10).optional(),
  quantity: z.number().int().min(1).max(100),
  /** Additional pre-tax discount for the line, on top of any product/offer discount. */
  discount: zMoney.default(0),
});

const linesSchema = z.object({
  locationId: z.string().trim().min(1).max(40),
  items: z.array(saleLineSchema).min(1).max(50),
});

/** Prices lines with the same engine as the website; staff never type selling prices. */
async function priceLines(executor: Executor, input: z.output<typeof linesSchema>) {
  const ids = [...new Set(input.items.map((item) => item.productId))];
  const rows = await executor
    .select()
    .from(products)
    .where(and(inArray(products.id, ids), isNull(products.deletedAt)));
  const links = await executor.select().from(productCollections).where(inArray(productCollections.productId, ids));
  const levels = await executor
    .select()
    .from(inventoryLevels)
    .where(and(inArray(inventoryLevels.productId, ids), eq(inventoryLevels.locationId, input.locationId)));
  const context = await loadPricingContext(executor);

  const errors: Record<string, string> = {};
  const requestedByProduct = new Map<string, number>();
  const lines = input.items.map((item, index) => {
    const row = rows.find((r) => r.id === item.productId);
    if (!row) {
      errors[`items.${index}.productId`] = "This product doesn't exist.";
      return null;
    }
    if (item.size && row.sizeOptions.length && !row.sizeOptions.includes(item.size)) {
      errors[`items.${index}.size`] = "Choose one of the product's sizes.";
      return null;
    }
    let priced;
    try {
      priced = priceEntry({ row, collections: links.filter((l) => l.productId === row.id).map((l) => ({ id: l.collectionId })) as CollectionRow[] }, context, item.size);
    } catch (error) {
      if (error instanceof MissingRateError) {
        errors[`items.${index}.productId`] = `No ${row.purity} ${row.metal} rate is set in Pricing.`;
        return null;
      }
      throw error;
    }
    const { pricing, variant } = priced;
    const unitPrice = pricing.taxableValue;
    const gross = round2(unitPrice * item.quantity);
    if (item.discount > gross) errors[`items.${index}.discount`] = "The discount can't exceed the line value.";
    const discount = round2(Math.min(item.discount, gross));
    const taxableValue = round2(gross - discount);
    // Whole-rupee GST, exactly like the website price engine, so both channels charge the same.
    const gstAmount = rupees((taxableValue * pricing.gstRate) / 100);
    requestedByProduct.set(row.id, (requestedByProduct.get(row.id) ?? 0) + item.quantity);
    return {
      row,
      size: variant.size ?? null,
      quantity: item.quantity,
      netWeight: round2(variant.netWeight * item.quantity),
      grossWeight: round2(variant.grossWeight * item.quantity),
      pricing,
      unitPrice,
      gross,
      discount,
      taxableValue,
      gstAmount,
      lineTotal: round2(taxableValue + gstAmount),
      available: levels.find((l) => l.productId === row.id)?.quantity ?? 0,
    };
  });
  if (Object.keys(errors).length) throw invalid(errors);

  const priced = lines.filter((line): line is NonNullable<typeof line> => Boolean(line));
  const taxableValue = round2(priced.reduce((sum, l) => sum + l.taxableValue, 0));
  const gst = round2(priced.reduce((sum, l) => sum + l.gstAmount, 0));
  return {
    lines: priced,
    stockShortfalls: [...requestedByProduct].flatMap(([productId, requested]) => {
      const line = priced.find((l) => l.row.id === productId)!;
      return requested > line.available ? [{ productId, sku: line.row.sku, requested, available: line.available }] : [];
    }),
    totals: {
      subtotal: round2(priced.reduce((sum, l) => sum + l.gross, 0)),
      discount: round2(priced.reduce((sum, l) => sum + l.discount, 0)),
      taxableValue,
      gst,
      grandTotal: round2(taxableValue + gst),
    },
  };
}

salesRouter.post("/sales/quote", requirePermission("sales:create"), async (req, res) => {
  const input = parse(linesSchema, req.body);
  const { lines, totals, stockShortfalls } = await priceLines(db(), input);
  res.json({
    lines: lines.map((l) => ({
      productId: l.row.id,
      name: l.row.name,
      sku: l.row.sku,
      size: l.size,
      quantity: l.quantity,
      netWeight: l.netWeight,
      grossWeight: l.grossWeight,
      unitPrice: l.unitPrice,
      discount: l.discount,
      taxableValue: l.taxableValue,
      gstRate: l.pricing.gstRate,
      gstAmount: l.gstAmount,
      lineTotal: l.lineTotal,
      pricing: l.pricing,
      available: l.available,
    })),
    totals,
    stockShortfalls,
  });
});

const saleSchema = linesSchema.extend({
  customerId: zUuid.nullable().optional(),
  customer: z
    .object({
      name: zText(160),
      phone: zMobile.nullable().optional(),
      email: zEmail.nullable().optional(),
      address: z.string().trim().max(500).nullable().optional(),
      gstin: gstinSchema,
    })
    .optional(),
  /** Save a walk-in customer (or link to an existing one with the same mobile number). */
  saveCustomer: z.boolean().default(false),
  discountReason: z.string().trim().max(300).optional(),
  payment: z.object({
    amountPaid: zMoney.default(0),
    method: z.enum(PAYMENT_METHODS),
    reference: z.string().trim().max(120).optional(),
  }),
  notes: z.string().trim().max(2000).optional(),
});

async function resolveCustomer(tx: Tx, input: z.output<typeof saleSchema>) {
  if (input.customerId) {
    const [customer] = await tx.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
    if (!customer) throw invalid({ customerId: "Choose an existing customer." });
    return {
      id: customer.id,
      name: input.customer?.name || customerName(customer),
      phone: input.customer?.phone ?? customer.phone,
      email: input.customer?.email ?? customer.email,
      address: input.customer?.address ?? null,
      gstin: input.customer?.gstin ?? null,
    };
  }
  if (!input.customer) throw invalid({ customer: "Add the customer's name, or choose an existing customer." });
  let id: string | null = null;
  if (input.saveCustomer && (input.customer.phone || input.customer.email)) {
    const [existing] = input.customer.phone ? await tx.select().from(customers).where(eq(customers.phone, input.customer.phone)).limit(1) : [];
    if (existing) {
      id = existing.id;
    } else {
      const [first, ...rest] = input.customer.name.split(/\s+/);
      id = (
        await createCustomerRecord(tx, {
          firstName: first ?? input.customer.name,
          lastName: rest.join(" "),
          phone: input.customer.phone ?? null,
          email: input.customer.email ?? null,
          source: "walk_in",
        })
      ).id;
    }
  }
  return { id, name: input.customer.name, phone: input.customer.phone ?? null, email: input.customer.email ?? null, address: input.customer.address ?? null, gstin: input.customer.gstin ?? null };
}

salesRouter.post("/sales", requirePermission("sales:create"), async (req, res) => {
  const input = parse(saleSchema, req.body);
  if (input.items.some((item) => item.discount > 0) && !input.discountReason) {
    throw invalid({ discountReason: "Add a reason for the discount." });
  }
  const actor = actorOf(req);

  const saleId = await db().transaction(async (tx) => {
    const { lines, totals } = await priceLines(tx, input);
    const amountPaid = round2(input.payment.amountPaid);
    if (amountPaid > totals.grandTotal + 0.005) throw invalid({ "payment.amountPaid": "The amount paid can't exceed the total." });
    const paymentStatus = amountPaid <= 0 ? "pending" : amountPaid >= totals.grandTotal - 0.005 ? "paid" : "partially_paid";
    const customer = await resolveCustomer(tx, input);
    const saleNumber = await documentNumbers.sale(tx);

    // Stock first: a shortage aborts the whole sale.
    for (const line of lines) {
      await applyStockChange(tx, actor, {
        productId: line.row.id,
        type: "sale",
        locationId: input.locationId,
        quantity: line.quantity,
        reason: "In-store sale",
        reference: { type: "sale", label: saleNumber },
      });
      await tx
        .update(products)
        .set({ salesCount: sql`${products.salesCount} + ${line.quantity}` })
        .where(eq(products.id, line.row.id));
    }

    const [sale] = await tx
      .insert(sales)
      .values({
        saleNumber,
        channel: "manual",
        customerId: customer.id,
        customerName: customer.name,
        customerPhone: customer.phone,
        customerEmail: customer.email,
        ...totals,
        paymentStatus,
        paymentMethod: input.payment.method,
        locationId: input.locationId,
        notes: [input.notes, input.discountReason ? `Discount reason: ${input.discountReason}` : null].filter(Boolean).join("\n") || null,
        createdById: actor.adminId,
        createdByName: actor.name,
      })
      .returning();
    await tx.insert(saleItems).values(
      lines.map((line) => ({
        saleId: sale!.id,
        productId: line.row.id,
        name: line.row.name,
        sku: line.row.sku,
        size: line.size,
        metal: line.row.metal,
        purity: line.row.purity,
        quantity: line.quantity,
        grossWeight: line.grossWeight,
        netWeight: line.netWeight,
        unitPrice: line.unitPrice,
        discount: line.discount,
        gstRate: line.pricing.gstRate,
        gstAmount: line.gstAmount,
        lineTotal: line.lineTotal,
        priceSnapshot: line.pricing,
      })),
    );
    await tx
      .update(sales)
      .set({ notes: sale!.notes })
      .where(eq(sales.id, sale!.id));

    const invoiceNumber = await assignInvoiceNumber(tx);
    const [invoice] = await tx
      .insert(invoices)
      .values({
        invoiceNumber,
        status: paymentStatus === "paid" ? "paid" : paymentStatus === "partially_paid" ? "partially_paid" : "issued",
        source: "manual_sale",
        saleId: sale!.id,
        customerId: customer.id,
        customer: { name: customer.name, mobile: customer.phone, email: customer.email, address: customer.address, gstin: customer.gstin },
        ...totals,
        amountPaid,
        balanceDue: round2(totals.grandTotal - amountPaid),
        issuedAt: new Date(),
        notes: input.notes ?? null,
        createdByName: actor.name,
      })
      .returning();
    await tx.insert(invoiceItems).values(
      lines.map((line, position) => ({
        invoiceId: invoice!.id,
        productId: line.row.id,
        description: line.row.name,
        sku: line.row.sku,
        size: line.size,
        metal: line.row.metal,
        purity: line.row.purity,
        quantity: line.quantity,
        grossWeight: line.grossWeight,
        netWeight: line.netWeight,
        unitPrice: line.unitPrice,
        discount: line.discount,
        taxableValue: line.taxableValue,
        gstRate: line.pricing.gstRate,
        gstAmount: line.gstAmount,
        lineTotal: line.lineTotal,
        position,
      })),
    );
    if (amountPaid > 0) {
      await tx.insert(invoicePayments).values({
        invoiceId: invoice!.id,
        amount: amountPaid,
        method: input.payment.method,
        reference: input.payment.reference ?? null,
        receivedAt: new Date(),
        recordedByName: actor.name,
      });
    }
    await tx.insert(invoiceEvents).values({ invoiceId: invoice!.id, action: "issued", note: `In-store sale ${saleNumber}`, actorName: actor.name });

    await recordAudit(tx, actor, {
      module: "sales",
      action: "sale.create_manual",
      entityType: "sale",
      entityId: sale!.id,
      entityLabel: `${saleNumber} / ${invoiceNumber}`,
      after: { grandTotal: totals.grandTotal, discount: totals.discount, amountPaid, items: lines.map((l) => `${l.row.sku} × ${l.quantity}`) },
      reason: input.discountReason ?? null,
      sensitive: true,
    });
    return sale!.id;
  });

  afterCatalogChange();
  res.status(201).json(await saleDetail(saleId));
});
