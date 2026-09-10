import { and, asc, count, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "@/db/client";
import { categories, chargeRates, makingChargeDefaults, metalRates, pricingHistory, pricingSettings, productCollections, products } from "@/db/schema";
import { requirePermission } from "@/http/auth";
import { invalid, notFound } from "@/lib/errors";
import { paginated, parse, zMoney, zText, zUuid } from "@/lib/validation";
import { METALS, PURITIES, PURITIES_BY_METAL, purityLabels } from "@/modules/catalog/labels";
import { priceable, resolveVariant } from "@/modules/catalog/snapshot";
import { loadPricingContext, priceProduct, type PriceableProduct, type PricingContext } from "@/modules/pricing/context";
import { calculatePrice, MissingRateError, type MetalRateTable } from "@/modules/pricing/engine";
import { actorOf, diff, recordAudit } from "@/services/audit";
import { afterCatalogChange } from "@/services/revalidate";
import { idParam, listQuery } from "./helpers";

/**
 * JEWELLERY PRICING MANAGEMENT
 * Metal rate × net weight + making + stone + other − discount + GST.
 * Every change needs a reason and is written to price history and the audit log.
 */
export const pricingRouter = Router();

pricingRouter.get("/pricing", requirePermission("pricing:view"), async (_req, res) => {
  const database = db();
  const rates = await database.select().from(metalRates);
  const [settingsRow] = await database.select().from(pricingSettings).where(eq(pricingSettings.id, 1)).limit(1);
  const typeCategories = await database.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.group, "type")).orderBy(asc(categories.displayOrder));
  const defaults = await database.select().from(makingChargeDefaults);
  const charges = await database.select().from(chargeRates).orderBy(asc(chargeRates.kind), asc(chargeRates.name));
  const context = await loadPricingContext(database);

  res.json({
    rates: METALS.flatMap((metal) =>
      PURITIES_BY_METAL[metal].map((purity) => {
        const row = rates.find((r) => r.metal === metal && r.purity === purity);
        return { metal, purity, label: purityLabels[purity], ratePerGram: row?.ratePerGram ?? null, updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null };
      }),
    ),
    gst: { rate: settingsRow?.gstRate ?? null, updatedBy: settingsRow?.updatedBy ?? null, updatedAt: settingsRow?.updatedAt ?? null },
    makingDefaults: typeCategories.map((category) => {
      const rule = defaults.find((d) => d.categoryId === category.id);
      return { categoryId: category.id, categoryName: category.name, type: rule?.type ?? null, value: rule?.value ?? null };
    }),
    chargeRates: charges,
    runningOfferDiscounts: context.offers,
  });
});

const rateSchema = z.object({ metal: z.enum(METALS), purity: z.enum(PURITIES), ratePerGram: z.number().positive().max(1_000_000) });

pricingRouter.put("/pricing/rates", requirePermission("pricing:manage"), async (req, res) => {
  const { rates, reason } = parse(z.object({ rates: z.array(rateSchema).min(1).max(6), reason: zText(300) }), req.body);
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  rates.forEach((rate, index) => {
    if (!PURITIES_BY_METAL[rate.metal].includes(rate.purity)) errors[`rates.${index}.purity`] = "Purity doesn't match the metal.";
    if (seen.has(`${rate.metal}:${rate.purity}`)) errors[`rates.${index}.purity`] = "Each purity can only appear once.";
    seen.add(`${rate.metal}:${rate.purity}`);
  });
  if (Object.keys(errors).length) throw invalid(errors);
  const actor = actorOf(req);

  const affected = await db().transaction(async (tx) => {
    const before = await tx.select().from(metalRates);
    for (const rate of rates) {
      await tx
        .insert(metalRates)
        .values({ ...rate, updatedBy: actor.name })
        .onConflictDoUpdate({ target: [metalRates.metal, metalRates.purity], set: { ratePerGram: rate.ratePerGram, updatedBy: actor.name, updatedAt: new Date() } });
    }
    const [impact] = await tx
      .select({ value: count() })
      .from(products)
      .where(and(eq(products.status, "active"), isNull(products.deletedAt), or(...rates.map((r) => and(eq(products.metal, r.metal), eq(products.purity, r.purity))))));
    const previous = rates.map((r) => ({ ...r, ratePerGram: before.find((b) => b.metal === r.metal && b.purity === r.purity)?.ratePerGram ?? null }));
    await tx.insert(pricingHistory).values({
      kind: "metal_rate",
      label: rates.map((r) => `${purityLabels[r.purity]} ${r.metal}`).join(", "),
      before: { rates: previous },
      after: { rates },
      reason,
      affectedProducts: impact?.value ?? 0,
      actorAdminId: actor.adminId,
      actorName: actor.name,
    });
    await recordAudit(tx, actor, { module: "pricing", action: "pricing.rates_update", entityType: "metal_rate", entityLabel: "Metal rates", before: { rates: previous }, after: { rates }, reason, sensitive: true });
    return impact?.value ?? 0;
  });
  afterCatalogChange();
  res.json({ updated: rates.length, affectedProducts: affected });
});

pricingRouter.put("/pricing/gst", requirePermission("pricing:manage"), async (req, res) => {
  const { gstRate, reason } = parse(z.object({ gstRate: z.number().min(0).max(28), reason: zText(300) }), req.body);
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const [current] = await tx.select().from(pricingSettings).where(eq(pricingSettings.id, 1)).limit(1);
    await tx
      .insert(pricingSettings)
      .values({ id: 1, gstRate, updatedBy: actor.name })
      .onConflictDoUpdate({ target: pricingSettings.id, set: { gstRate, updatedBy: actor.name, updatedAt: new Date() } });
    const [impact] = await tx.select({ value: count() }).from(products).where(and(eq(products.status, "active"), isNull(products.deletedAt)));
    await tx.insert(pricingHistory).values({
      kind: "gst",
      label: "GST rate",
      before: { gstRate: current?.gstRate ?? null },
      after: { gstRate },
      reason,
      affectedProducts: impact?.value ?? 0,
      actorAdminId: actor.adminId,
      actorName: actor.name,
    });
    await recordAudit(tx, actor, { module: "pricing", action: "pricing.gst_update", entityType: "pricing_settings", entityLabel: "GST rate", before: { gstRate: current?.gstRate ?? null }, after: { gstRate }, reason, sensitive: true });
  });
  afterCatalogChange();
  res.json({ gstRate });
});

/** Starting values offered when staff create products in a category. Existing products are unchanged. */
pricingRouter.put("/pricing/making-defaults", requirePermission("pricing:manage"), async (req, res) => {
  const { items, reason } = parse(
    z.object({
      items: z.array(z.object({ categoryId: zUuid, type: z.enum(["per_gram", "percentage", "fixed"]), value: z.number().min(0).max(10_000_000) })).min(1).max(50),
      reason: zText(300),
    }),
    req.body,
  );
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const typeCategories = await tx.select({ id: categories.id }).from(categories).where(and(eq(categories.group, "type"), inArray(categories.id, items.map((i) => i.categoryId))));
    const errors: Record<string, string> = {};
    items.forEach((item, index) => {
      if (!typeCategories.some((c) => c.id === item.categoryId)) errors[`items.${index}.categoryId`] = "Choose a jewellery type category.";
      if (item.type === "percentage" && item.value > 100) errors[`items.${index}.value`] = "A percentage can't exceed 100.";
    });
    if (Object.keys(errors).length) throw invalid(errors);
    const before = await tx.select().from(makingChargeDefaults);
    for (const item of items) {
      await tx
        .insert(makingChargeDefaults)
        .values(item)
        .onConflictDoUpdate({ target: makingChargeDefaults.categoryId, set: { type: item.type, value: item.value, updatedAt: new Date() } });
    }
    await tx.insert(pricingHistory).values({ kind: "making_default", label: "Making charge defaults", before: { items: before }, after: { items }, reason, actorAdminId: actor.adminId, actorName: actor.name });
    await recordAudit(tx, actor, { module: "pricing", action: "pricing.making_defaults_update", entityType: "making_charge_default", entityLabel: "Making charge defaults", after: { items }, reason, sensitive: true });
  });
  res.json({ updated: items.length });
});

const chargeRateSchema = z.object({
  name: zText(80),
  kind: z.enum(["stone", "other"]),
  unit: z.enum(["per_carat", "per_piece", "fixed"]),
  rate: zMoney,
  active: z.boolean().default(true),
});

pricingRouter.post("/pricing/charge-rates", requirePermission("pricing:manage"), async (req, res) => {
  const input = parse(chargeRateSchema.extend({ reason: zText(300) }), req.body);
  const { reason, ...values } = input;
  const actor = actorOf(req);
  const row = await db().transaction(async (tx) => {
    const [created] = await tx.insert(chargeRates).values(values).returning();
    await tx.insert(pricingHistory).values({ kind: "charge_rate", label: created!.name, after: values, reason, actorAdminId: actor.adminId, actorName: actor.name });
    await recordAudit(tx, actor, { module: "pricing", action: "pricing.charge_rate_create", entityType: "charge_rate", entityId: created!.id, entityLabel: created!.name, after: values, reason, sensitive: true });
    return created!;
  });
  res.status(201).json(row);
});

pricingRouter.patch("/pricing/charge-rates/:id", requirePermission("pricing:manage"), async (req, res) => {
  const id = idParam(req);
  const { reason, ...patch } = parse(chargeRateSchema.partial().extend({ reason: zText(300) }), req.body);
  const actor = actorOf(req);
  const row = await db().transaction(async (tx) => {
    const [current] = await tx.select().from(chargeRates).where(eq(chargeRates.id, id)).for("update");
    if (!current) throw notFound();
    const [updated] = await tx
      .update(chargeRates)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(chargeRates.id, id))
      .returning();
    const changes = diff(current, updated!);
    await tx.insert(pricingHistory).values({ kind: "charge_rate", label: updated!.name, before: changes.before, after: changes.after, reason, actorAdminId: actor.adminId, actorName: actor.name });
    await recordAudit(tx, actor, { module: "pricing", action: "pricing.charge_rate_update", entityType: "charge_rate", entityId: id, entityLabel: updated!.name, ...changes, reason, sensitive: true });
    return updated!;
  });
  res.json(row);
});

/* ------------------------------------------------------------------ */
/* Price preview / simulator                                           */
/* ------------------------------------------------------------------ */

const previewSchema = z.object({
  productId: zUuid.optional(),
  size: z.string().trim().max(10).optional(),
  metal: z.enum(METALS).optional(),
  purity: z.enum(PURITIES).optional(),
  netWeight: z.number().positive().max(10_000).optional(),
  makingType: z.enum(["per_gram", "percentage", "fixed"]).optional(),
  makingValue: z.number().min(0).max(10_000_000).optional(),
  stoneCharges: zMoney.optional(),
  otherCharges: zMoney.optional(),
  /** Explicit discount to test; omit to apply the product's own discount and running offers. */
  discount: z.object({ type: z.enum(["percentage", "fixed"]), value: z.number().positive() }).nullable().optional(),
  gstRate: z.number().min(0).max(28).optional(),
  rateOverrides: z.array(rateSchema).max(6).optional(),
});

pricingRouter.post("/pricing/preview", requirePermission("pricing:view"), async (req, res) => {
  const input = parse(previewSchema, req.body);
  const context = await loadPricingContext();
  const proposed: PricingContext = { ...context, rates: structuredClone(context.rates) as MetalRateTable, gstRate: input.gstRate ?? context.gstRate };
  for (const override of input.rateOverrides ?? []) proposed.rates[override.metal][override.purity] = override.ratePerGram;

  let base: PriceableProduct;
  let netWeight: number;
  let current = null;

  try {
    if (input.productId) {
      const [row] = await db()
        .select()
        .from(products)
        .where(and(eq(products.id, input.productId), isNull(products.deletedAt)))
        .limit(1);
      if (!row) throw notFound("Product not found.");
      const collectionIds = (await db().select({ id: productCollections.collectionId }).from(productCollections).where(eq(productCollections.productId, row.id))).map((c) => c.id);
      base = priceable(row, collectionIds);
      netWeight = resolveVariant(row, input.size).netWeight;
      current = priceProduct(base, netWeight, context);
    } else {
      if (!input.metal || !input.purity || input.netWeight === undefined || !input.makingType || input.makingValue === undefined) {
        throw invalid({ productId: "Choose a product, or enter metal, purity, net weight and making charges." });
      }
      base = {
        id: "preview",
        metal: input.metal,
        purity: input.purity,
        categoryId: "",
        collectionIds: [],
        makingType: input.makingType,
        makingValue: input.makingValue,
        stoneCharges: 0,
        otherCharges: 0,
        discount: null,
      };
      netWeight = input.netWeight;
    }

    const simulated: PriceableProduct = {
      ...base,
      metal: input.metal ?? base.metal,
      purity: input.purity ?? base.purity,
      makingType: input.makingType ?? base.makingType,
      makingValue: input.makingValue ?? base.makingValue,
      stoneCharges: input.stoneCharges ?? base.stoneCharges,
      otherCharges: input.otherCharges ?? base.otherCharges,
    };
    if (!PURITIES_BY_METAL[simulated.metal].includes(simulated.purity)) throw invalid({ purity: "Purity doesn't match the metal." });
    const weight = input.netWeight ?? netWeight;

    const result =
      input.discount !== undefined
        ? {
            pricing: calculatePrice(
              {
                metal: simulated.metal,
                purity: simulated.purity,
                netWeight: weight,
                making: { type: simulated.makingType, value: simulated.makingValue },
                stoneCharges: simulated.stoneCharges,
                otherCharges: simulated.otherCharges,
                discount: input.discount,
                gstRate: proposed.gstRate,
              },
              proposed.rates,
            ),
            discount: input.discount,
          }
        : priceProduct(simulated, weight, proposed);

    res.json({ netWeight: weight, proposed: result, current });
  } catch (error) {
    if (error instanceof MissingRateError) throw invalid({ rateOverrides: `${error.message}. Add a rate or an override to preview.` });
    throw error;
  }
});

pricingRouter.get("/pricing/history", requirePermission("pricing:view"), async (req, res) => {
  const query = parse(listQuery.extend({ kind: z.enum(["metal_rate", "gst", "making_default", "charge_rate"]).optional() }), req.query);
  const where = query.kind ? eq(pricingHistory.kind, query.kind) : undefined;
  const rows = await db()
    .select()
    .from(pricingHistory)
    .where(where)
    .orderBy(desc(pricingHistory.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db().select({ value: count() }).from(pricingHistory).where(where);
  res.json(paginated(rows, total?.value ?? 0, query.page, query.pageSize));
});
