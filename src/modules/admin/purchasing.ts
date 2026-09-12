import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db, type Tx } from "@/db/client";
import { auditLogs, products, purchaseItems, purchases, stockLocations, vendors } from "@/db/schema";
import { can, requireAnyPermission, requirePermission } from "@/http/auth";
import { AppError, invalid, notFound } from "@/lib/errors";
import { round2, round3 } from "@/lib/money";
import { paginated, parse, partialUpdate, zDate, zEmail, zMobile, zMoney, zText, zUuid, zWeight } from "@/lib/validation";
import { METALS, PURITIES, PURITIES_BY_METAL } from "@/modules/catalog/labels";
import { actorOf, diff, recordAudit } from "@/services/audit";
import { applyStockChange } from "@/services/inventory";
import { notify } from "@/services/notifications";
import { afterCatalogChange } from "@/services/revalidate";
import { documentNumbers } from "@/services/sequences";
import { idParam, listQuery, searchAny, sortBy, withinDateStrings } from "./helpers";

export const purchasingRouter = Router();

/* ------------------------------------------------------------------ */
/* Vendors                                                             */
/* ------------------------------------------------------------------ */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => value || null);

export const vendorSchema = z.object({
  name: zText(160),
  contactPerson: optionalText(120),
  mobile: zMobile.nullable().optional(),
  email: zEmail.nullable().optional(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, { error: "Enter a valid 15-character GSTIN." })
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  address: optionalText(500),
  status: z.enum(["active", "inactive"]).default("active"),
  notes: optionalText(2000),
});

purchasingRouter.get("/vendors", requirePermission("vendors:view"), async (req, res) => {
  const query = parse(listQuery.extend({ status: z.enum(["active", "inactive"]).optional() }), req.query);
  const where = and(query.status ? eq(vendors.status, query.status) : undefined, searchAny(query.q, [vendors.name, vendors.code, vendors.mobile, vendors.gstin, vendors.contactPerson]));
  const rows = await db()
    .select()
    .from(vendors)
    .where(where)
    .orderBy(sortBy(query.sort, { name: vendors.name, code: vendors.code, createdAt: vendors.createdAt }, asc(vendors.name)))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db().select({ value: count() }).from(vendors).where(where);

  let stats: { vendorId: string; purchases: number; approvedValue: number }[] = [];
  if (can(req, "purchases:view") && rows.length) {
    stats = await db()
      .select({
        vendorId: purchases.vendorId,
        purchases: sql<number>`count(*)`.mapWith(Number),
        approvedValue: sql<number>`coalesce(sum(${purchases.total}) filter (where ${purchases.status} = 'approved'), 0)`.mapWith(Number),
      })
      .from(purchases)
      .where(
        inArray(
          purchases.vendorId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(purchases.vendorId);
  }
  res.json(
    paginated(
      rows.map((row) => ({ ...row, ...(can(req, "purchases:view") ? (stats.find((s) => s.vendorId === row.id) ?? { purchases: 0, approvedValue: 0 }) : {}) })),
      total?.value ?? 0,
      query.page,
      query.pageSize,
    ),
  );
});

purchasingRouter.get("/vendors/:id", requirePermission("vendors:view"), async (req, res) => {
  const [vendor] = await db().select().from(vendors).where(eq(vendors.id, idParam(req))).limit(1);
  if (!vendor) throw notFound();
  const recentPurchases = can(req, "purchases:view")
    ? await db()
        .select({ id: purchases.id, purchaseNumber: purchases.purchaseNumber, purchaseDate: purchases.purchaseDate, status: purchases.status, total: purchases.total })
        .from(purchases)
        .where(eq(purchases.vendorId, vendor.id))
        .orderBy(desc(purchases.purchaseDate))
        .limit(50)
    : null;
  res.json({ ...vendor, purchases: recentPurchases });
});

purchasingRouter.post("/vendors", requirePermission("vendors:manage"), async (req, res) => {
  const input = parse(vendorSchema, req.body);
  const actor = actorOf(req);
  const vendor = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(vendors)
      .values({ ...input, mobile: input.mobile ?? null, email: input.email ?? null, gstin: input.gstin ?? null, code: await documentNumbers.vendor(tx) })
      .returning();
    await recordAudit(tx, actor, { module: "purchases", action: "vendor.create", entityType: "vendor", entityId: row!.id, entityLabel: `${row!.code} ${row!.name}` });
    return row!;
  });
  res.status(201).json(vendor);
});

purchasingRouter.patch("/vendors/:id", requirePermission("vendors:manage"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(partialUpdate(vendorSchema), req.body);
  const actor = actorOf(req);
  const vendor = await db().transaction(async (tx) => {
    const [current] = await tx.select().from(vendors).where(eq(vendors.id, id)).for("update");
    if (!current) throw notFound();
    const [row] = await tx
      .update(vendors)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(vendors.id, id))
      .returning();
    const changes = diff(current, row!);
    if (changes.changed) {
      await recordAudit(tx, actor, { module: "purchases", action: "vendor.update", entityType: "vendor", entityId: id, entityLabel: `${row!.code} ${row!.name}`, ...changes });
    }
    return row!;
  });
  res.json(vendor);
});

/* ------------------------------------------------------------------ */
/* Purchases                                                           */
/* ------------------------------------------------------------------ */

const purchaseItemSchema = z.object({
  productId: zUuid.nullable().optional(),
  description: zText(200),
  sku: optionalText(40),
  metal: z.enum(METALS),
  purity: z.enum(PURITIES),
  quantity: z.number().int().min(1).max(100_000),
  /** Line total weights in grams, as on the vendor invoice. */
  grossWeight: zWeight,
  netWeight: zWeight,
  ratePerGram: zMoney,
  makingCharges: zMoney.default(0),
  otherCharges: zMoney.default(0),
});

const purchaseSchema = z.object({
  vendorId: zUuid,
  vendorInvoiceRef: optionalText(80),
  purchaseDate: zDate,
  receivingLocationId: z.string().trim().min(1).max(40),
  taxAmount: zMoney.default(0),
  notes: optionalText(2000),
  items: z.array(purchaseItemSchema).min(1).max(200),
});

type PurchaseInput = z.output<typeof purchaseSchema>;

/** Totals are always computed here; the browser never supplies them. */
function computePurchase(input: PurchaseInput) {
  const items = input.items.map((item, position) => ({
    ...item,
    productId: item.productId ?? null,
    lineTotal: round2(item.netWeight * item.ratePerGram + item.makingCharges + item.otherCharges),
    position,
  }));
  const subtotal = round2(items.reduce((sum, item) => sum + item.lineTotal, 0));
  return {
    items,
    totals: {
      totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
      totalGrossWeight: round3(items.reduce((sum, item) => sum + item.grossWeight, 0)),
      totalNetWeight: round3(items.reduce((sum, item) => sum + item.netWeight, 0)),
      subtotal,
      taxAmount: round2(input.taxAmount),
      total: round2(subtotal + input.taxAmount),
    },
  };
}

async function validatePurchase(tx: Tx, input: PurchaseInput) {
  const errors: Record<string, string> = {};
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, input.vendorId)).limit(1);
  if (!vendor) errors.vendorId = "Choose a vendor.";
  else if (vendor.status !== "active") errors.vendorId = "This vendor is inactive.";
  const [location] = await tx.select().from(stockLocations).where(eq(stockLocations.id, input.receivingLocationId)).limit(1);
  if (!location || !location.active) errors.receivingLocationId = "Choose an active stock location.";

  const productIds = [...new Set(input.items.map((i) => i.productId).filter((id): id is string => Boolean(id)))];
  const found = productIds.length
    ? await tx.select({ id: products.id, metal: products.metal, purity: products.purity }).from(products).where(inArray(products.id, productIds))
    : [];
  input.items.forEach((item, index) => {
    if (!PURITIES_BY_METAL[item.metal].includes(item.purity)) errors[`items.${index}.purity`] = "Purity doesn't match the metal.";
    if (item.grossWeight < item.netWeight) errors[`items.${index}.grossWeight`] = "Gross weight can't be less than net weight.";
    if (item.productId) {
      const product = found.find((p) => p.id === item.productId);
      if (!product) errors[`items.${index}.productId`] = "This product no longer exists.";
      else if (product.metal !== item.metal || product.purity !== item.purity) errors[`items.${index}.purity`] = "Metal and purity must match the linked product.";
    }
  });
  if (Object.keys(errors).length) throw invalid(errors);
}

purchasingRouter.get("/purchases", requirePermission("purchases:view"), async (req, res) => {
  const query = parse(
    listQuery.extend({
      status: z.enum(["draft", "pending_approval", "approved", "cancelled"]).optional(),
      vendorId: zUuid.optional(),
      from: zDate.optional(),
      to: zDate.optional(),
    }),
    req.query,
  );
  const where = and(
    query.status ? eq(purchases.status, query.status) : undefined,
    query.vendorId ? eq(purchases.vendorId, query.vendorId) : undefined,
    ...withinDateStrings(purchases.purchaseDate, query.from, query.to),
    searchAny(query.q, [purchases.purchaseNumber, purchases.vendorInvoiceRef, vendors.name]),
  );
  const rows = await db()
    .select({ purchase: purchases, vendorName: vendors.name, locationName: stockLocations.name })
    .from(purchases)
    .innerJoin(vendors, eq(vendors.id, purchases.vendorId))
    .innerJoin(stockLocations, eq(stockLocations.id, purchases.receivingLocationId))
    .where(where)
    .orderBy(sortBy(query.sort, { purchaseDate: purchases.purchaseDate, total: purchases.total, createdAt: purchases.createdAt }, desc(purchases.createdAt)))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db()
    .select({ value: count() })
    .from(purchases)
    .innerJoin(vendors, eq(vendors.id, purchases.vendorId))
    .where(where);
  res.json(
    paginated(
      rows.map((r) => ({ ...r.purchase, vendorName: r.vendorName, locationName: r.locationName })),
      total?.value ?? 0,
      query.page,
      query.pageSize,
    ),
  );
});

async function purchaseDetail(id: string) {
  const [row] = await db()
    .select({ purchase: purchases, vendor: vendors, locationName: stockLocations.name })
    .from(purchases)
    .innerJoin(vendors, eq(vendors.id, purchases.vendorId))
    .innerJoin(stockLocations, eq(stockLocations.id, purchases.receivingLocationId))
    .where(eq(purchases.id, id))
    .limit(1);
  if (!row) throw notFound("Purchase not found.");
  const items = await db()
    .select({ item: purchaseItems, productName: products.name, productSku: products.sku })
    .from(purchaseItems)
    .leftJoin(products, eq(products.id, purchaseItems.productId))
    .where(eq(purchaseItems.purchaseId, id))
    .orderBy(asc(purchaseItems.position));
  const history = await db()
    .select({ action: auditLogs.action, actorName: auditLogs.actorName, reason: auditLogs.reason, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, "purchase"), eq(auditLogs.entityId, id)))
    .orderBy(asc(auditLogs.createdAt));
  return {
    ...row.purchase,
    vendor: { id: row.vendor.id, code: row.vendor.code, name: row.vendor.name, gstin: row.vendor.gstin },
    locationName: row.locationName,
    items: items.map((i) => ({ ...i.item, productName: i.productName, productSku: i.productSku })),
    history,
  };
}

purchasingRouter.get("/purchases/:id", requirePermission("purchases:view"), async (req, res) => {
  res.json(await purchaseDetail(idParam(req)));
});

purchasingRouter.post("/purchases", requirePermission("purchases:create"), async (req, res) => {
  const input = parse(purchaseSchema, req.body);
  const actor = actorOf(req);
  const { items, totals } = computePurchase(input);
  const purchase = await db().transaction(async (tx) => {
    await validatePurchase(tx, input);
    const [row] = await tx
      .insert(purchases)
      .values({
        purchaseNumber: await documentNumbers.purchase(tx),
        vendorId: input.vendorId,
        vendorInvoiceRef: input.vendorInvoiceRef,
        purchaseDate: input.purchaseDate,
        receivingLocationId: input.receivingLocationId,
        notes: input.notes,
        ...totals,
        createdById: actor.adminId,
        createdByName: actor.name,
      })
      .returning();
    await tx.insert(purchaseItems).values(items.map((item) => ({ ...item, purchaseId: row!.id })));
    await recordAudit(tx, actor, {
      module: "purchases",
      action: "purchase.create",
      entityType: "purchase",
      entityId: row!.id,
      entityLabel: row!.purchaseNumber,
      after: { total: totals.total, items: items.length },
    });
    return row!;
  });
  res.status(201).json(await purchaseDetail(purchase.id));
});

async function lockPurchase(tx: Tx, id: string) {
  const [row] = await tx.select().from(purchases).where(eq(purchases.id, id)).for("update");
  if (!row) throw notFound("Purchase not found.");
  return row;
}

purchasingRouter.put("/purchases/:id", requirePermission("purchases:create"), async (req, res) => {
  const id = idParam(req);
  const input = parse(purchaseSchema, req.body);
  const actor = actorOf(req);
  const { items, totals } = computePurchase(input);
  await db().transaction(async (tx) => {
    const current = await lockPurchase(tx, id);
    if (current.status !== "draft") throw new AppError("validation_error", "Only draft purchases can be edited.");
    await validatePurchase(tx, input);
    await tx
      .update(purchases)
      .set({
        vendorId: input.vendorId,
        vendorInvoiceRef: input.vendorInvoiceRef,
        purchaseDate: input.purchaseDate,
        receivingLocationId: input.receivingLocationId,
        notes: input.notes,
        ...totals,
        updatedAt: new Date(),
      })
      .where(eq(purchases.id, id));
    await tx.delete(purchaseItems).where(eq(purchaseItems.purchaseId, id));
    await tx.insert(purchaseItems).values(items.map((item) => ({ ...item, purchaseId: id })));
    await recordAudit(tx, actor, {
      module: "purchases",
      action: "purchase.update",
      entityType: "purchase",
      entityId: id,
      entityLabel: current.purchaseNumber,
      before: { total: current.total },
      after: { total: totals.total, items: items.length },
    });
  });
  res.json(await purchaseDetail(id));
});

purchasingRouter.post("/purchases/:id/submit", requirePermission("purchases:create"), async (req, res) => {
  const id = idParam(req);
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const current = await lockPurchase(tx, id);
    if (current.status !== "draft") throw new AppError("validation_error", "Only draft purchases can be submitted.");
    await tx.update(purchases).set({ status: "pending_approval", submittedAt: new Date(), updatedAt: new Date() }).where(eq(purchases.id, id));
    await recordAudit(tx, actor, { module: "purchases", action: "purchase.submit", entityType: "purchase", entityId: id, entityLabel: current.purchaseNumber });
    await notify(tx, {
      type: "purchase_pending",
      title: "Purchase awaiting approval",
      body: `${current.purchaseNumber} (₹${current.total.toLocaleString("en-IN")}) was submitted by ${actor.name}.`,
      href: `/admin/purchases/${id}`,
      permission: "purchases:approve",
    });
  });
  res.json(await purchaseDetail(id));
});

/** Sends a purchase awaiting approval back to draft so its lines can be corrected (e.g. linked to products). */
purchasingRouter.post("/purchases/:id/reopen", requireAnyPermission("purchases:create", "purchases:approve"), async (req, res) => {
  const id = idParam(req);
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const current = await lockPurchase(tx, id);
    if (current.status !== "pending_approval") throw new AppError("validation_error", "Only purchases awaiting approval can be returned to draft.");
    await tx.update(purchases).set({ status: "draft", submittedAt: null, updatedAt: new Date() }).where(eq(purchases.id, id));
    await recordAudit(tx, actor, { module: "purchases", action: "purchase.reopen", entityType: "purchase", entityId: id, entityLabel: current.purchaseNumber });
  });
  res.json(await purchaseDetail(id));
});

/** Approval is the only path from a purchase into inventory. */
purchasingRouter.post("/purchases/:id/approve", requirePermission("purchases:approve"), async (req, res) => {
  const id = idParam(req);
  const { updateProductCost } = parse(z.object({ updateProductCost: z.boolean().default(false) }), req.body ?? {});
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const current = await lockPurchase(tx, id);
    if (current.status !== "pending_approval") throw new AppError("validation_error", "Only purchases awaiting approval can be approved.");
    const items = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, id)).orderBy(asc(purchaseItems.position));
    const unlinked = items.filter((item) => !item.productId);
    if (unlinked.length) {
      throw new AppError("validation_error", `Link every line to a product before approval (unlinked: ${unlinked.map((i) => i.description).join(", ")}).`);
    }

    for (const item of items) {
      await applyStockChange(tx, actor, {
        productId: item.productId!,
        type: "purchase",
        locationId: current.receivingLocationId,
        quantity: item.quantity,
        reason: `Purchase ${current.purchaseNumber}`,
        reference: { type: "purchase", id, label: current.purchaseNumber },
      });
      if (updateProductCost) {
        await tx
          .update(products)
          .set({ purchasePrice: round2(item.lineTotal / item.quantity), vendorId: sql`coalesce(${products.vendorId}, ${current.vendorId}::uuid)` })
          .where(eq(products.id, item.productId!));
      }
    }

    await tx
      .update(purchases)
      .set({ status: "approved", approvedById: actor.adminId, approvedByName: actor.name, approvedAt: new Date(), updatedAt: new Date() })
      .where(eq(purchases.id, id));
    await recordAudit(tx, actor, {
      module: "purchases",
      action: "purchase.approve",
      entityType: "purchase",
      entityId: id,
      entityLabel: current.purchaseNumber,
      after: { total: current.total, units: current.totalQuantity, updateProductCost },
      sensitive: true,
    });
  });
  afterCatalogChange();
  res.json(await purchaseDetail(id));
});

purchasingRouter.post("/purchases/:id/cancel", requirePermission("purchases:approve"), async (req, res) => {
  const id = idParam(req);
  const { reason } = parse(z.object({ reason: zText(500) }), req.body);
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const current = await lockPurchase(tx, id);
    if (current.status === "approved") {
      throw new AppError("validation_error", "Approved purchases have already updated inventory. Record a stock reduction instead of cancelling.");
    }
    if (current.status === "cancelled") return;
    await tx
      .update(purchases)
      .set({ status: "cancelled", cancelledByName: actor.name, cancelledAt: new Date(), cancelReason: reason, updatedAt: new Date() })
      .where(eq(purchases.id, id));
    await recordAudit(tx, actor, { module: "purchases", action: "purchase.cancel", entityType: "purchase", entityId: id, entityLabel: current.purchaseNumber, reason, sensitive: true });
  });
  res.json(await purchaseDetail(id));
});
