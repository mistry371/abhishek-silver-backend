import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db, type Tx } from "@/db/client";
import { categories, collections, coupons, offers, products } from "@/db/schema";
import { requirePermission } from "@/http/auth";
import { AppError, invalid, notFound } from "@/lib/errors";
import { paginated, parse, partialUpdate, zBoolQuery, zImage, zMoney, zText, zUuid } from "@/lib/validation";
import { METALS } from "@/modules/catalog/labels";
import { actorOf, diff, recordAudit } from "@/services/audit";
import { afterCatalogChange, revalidateStorefront } from "@/services/revalidate";
import { idParam, listQuery, searchAny, withUniqueFields } from "./helpers";

export const marketingRouter = Router();

const optionalDate = z.iso.datetime({ offset: true }).nullable().optional();
const toDate = (value: string | null | undefined) => (value ? new Date(value) : null);

function checkWindow(startsAt?: string | null, endsAt?: string | null) {
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) throw invalid({ endsAt: "The end must be after the start." });
}

/* ------------------------------------------------------------------ */
/* Coupons                                                             */
/* ------------------------------------------------------------------ */

const couponSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{3,30}$/, { error: "Use 3–30 letters and numbers." }),
  description: zText(200),
  type: z.enum(["percentage", "fixed"]),
  value: z.number().positive().max(10_000_000),
  minOrderValue: zMoney.nullable().optional(),
  maxDiscount: zMoney.nullable().optional(),
  appliesTo: z
    .object({
      metals: z.array(z.enum(METALS)).max(2).optional(),
      categorySlugs: z.array(z.string().trim().max(80)).max(30).optional(),
      productIds: z.array(zUuid).max(200).optional(),
    })
    .default({}),
  startsAt: optionalDate,
  endsAt: optionalDate,
  usageLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  active: z.boolean().default(true),
});

function couponState(coupon: typeof coupons.$inferSelect) {
  const now = Date.now();
  if (!coupon.active) return "inactive";
  if (coupon.startsAt && coupon.startsAt.getTime() > now) return "scheduled";
  if (coupon.endsAt && coupon.endsAt.getTime() <= now) return "expired";
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) return "exhausted";
  return "active";
}

async function validateCoupon(tx: Tx, input: Partial<z.output<typeof couponSchema>>) {
  if (input.type === "percentage" && input.value !== undefined && input.value > 90) throw invalid({ value: "Percentage coupons are limited to 90%." });
  checkWindow(input.startsAt, input.endsAt);
  const scope = input.appliesTo;
  if (scope?.categorySlugs?.length) {
    const found = await tx.select({ slug: categories.slug }).from(categories).where(inArray(categories.slug, scope.categorySlugs));
    const missing = scope.categorySlugs.filter((slug) => !found.some((f) => f.slug === slug));
    if (missing.length) throw invalid({ "appliesTo.categorySlugs": `Unknown categories: ${missing.join(", ")}.` });
  }
  if (scope?.productIds?.length) {
    const found = await tx.select({ id: products.id }).from(products).where(inArray(products.id, scope.productIds));
    if (found.length !== new Set(scope.productIds).size) throw invalid({ "appliesTo.productIds": "One or more products no longer exist." });
  }
}

const couponUnique = { coupons_code: ["code", "A coupon with this code already exists."] as [string, string] };

marketingRouter.get("/coupons", requirePermission("marketing:view"), async (req, res) => {
  const query = parse(listQuery.extend({ active: zBoolQuery }), req.query);
  const where = and(query.active !== undefined ? eq(coupons.active, query.active) : undefined, searchAny(query.q, [coupons.code, coupons.description]));
  const rows = await db()
    .select()
    .from(coupons)
    .where(where)
    .orderBy(desc(coupons.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db().select({ value: count() }).from(coupons).where(where);
  res.json(paginated(rows.map((row) => ({ ...row, state: couponState(row) })), total?.value ?? 0, query.page, query.pageSize));
});

marketingRouter.post("/coupons", requirePermission("marketing:manage"), async (req, res) => {
  const input = parse(couponSchema, req.body);
  const actor = actorOf(req);
  const row = await withUniqueFields(
    () =>
      db().transaction(async (tx) => {
        await validateCoupon(tx, input);
        const [created] = await tx
          .insert(coupons)
          .values({ ...input, startsAt: toDate(input.startsAt), endsAt: toDate(input.endsAt), minOrderValue: input.minOrderValue ?? null, maxDiscount: input.maxDiscount ?? null, usageLimit: input.usageLimit ?? null })
          .returning();
        await recordAudit(tx, actor, { module: "marketing", action: "coupon.create", entityType: "coupon", entityId: created!.id, entityLabel: created!.code, after: input, sensitive: true });
        return created!;
      }),
    couponUnique,
  );
  res.status(201).json({ ...row, state: couponState(row) });
});

marketingRouter.patch("/coupons/:id", requirePermission("marketing:manage"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(partialUpdate(couponSchema), req.body);
  const { startsAt, endsAt, ...couponFields } = patch;
  const actor = actorOf(req);
  const row = await withUniqueFields(
    () =>
      db().transaction(async (tx) => {
        const [current] = await tx.select().from(coupons).where(eq(coupons.id, id)).for("update");
        if (!current) throw notFound();
        if (patch.code && patch.code !== current.code && current.usedCount > 0) throw invalid({ code: "This coupon has been used, so its code can't change." });
        if (patch.usageLimit !== undefined && patch.usageLimit !== null && patch.usageLimit < current.usedCount) {
          throw invalid({ usageLimit: `This coupon has already been used ${current.usedCount} times.` });
        }
        await validateCoupon(tx, {
          ...patch,
          type: patch.type ?? current.type,
          value: patch.value ?? current.value,
          startsAt: patch.startsAt !== undefined ? patch.startsAt : current.startsAt?.toISOString(),
          endsAt: patch.endsAt !== undefined ? patch.endsAt : current.endsAt?.toISOString(),
        });
        const [updated] = await tx
          .update(coupons)
          .set({
            ...couponFields,
            ...(startsAt !== undefined ? { startsAt: toDate(startsAt) } : {}),
            ...(endsAt !== undefined ? { endsAt: toDate(endsAt) } : {}),
            updatedAt: new Date(),
          })
          .where(eq(coupons.id, id))
          .returning();
        const changes = diff(current, updated!);
        if (changes.changed) await recordAudit(tx, actor, { module: "marketing", action: "coupon.update", entityType: "coupon", entityId: id, entityLabel: updated!.code, ...changes, sensitive: true });
        return updated!;
      }),
    couponUnique,
  );
  res.json({ ...row, state: couponState(row) });
});

marketingRouter.delete("/coupons/:id", requirePermission("marketing:manage"), async (req, res) => {
  const id = idParam(req);
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const [current] = await tx.select().from(coupons).where(eq(coupons.id, id)).for("update");
    if (!current) throw notFound();
    if (current.usedCount > 0) throw new AppError("validation_error", "This coupon has been used on orders. Deactivate it instead of deleting it.");
    await tx.delete(coupons).where(eq(coupons.id, id));
    await recordAudit(tx, actor, { module: "marketing", action: "coupon.delete", entityType: "coupon", entityId: id, entityLabel: current.code, sensitive: true });
  });
  res.status(204).end();
});

/* ------------------------------------------------------------------ */
/* Offers & campaigns                                                  */
/* ------------------------------------------------------------------ */

const offerSchema = z.object({
  title: zText(120),
  eyebrow: z.string().trim().max(80).nullable().optional(),
  description: zText(500),
  type: z.enum(["percentage", "fixed", "product", "category", "limited_time", "festival"]),
  /** When set, the price engine applies it to targeted products (customers get the best available price). */
  discount: z.object({ type: z.enum(["percentage", "fixed"]), value: z.number().positive().max(10_000_000) }).nullable().default(null),
  target: z.object({ scope: z.enum(["all", "categories", "products", "collections", "metal"]), ids: z.array(z.string().max(80)).max(200) }).default({ scope: "all", ids: [] }),
  couponCode: z.string().trim().toUpperCase().max(30).nullable().optional(),
  image: zImage.nullable().optional(),
  mobileImage: zImage.nullable().optional(),
  cta: z.object({ label: zText(60), href: zText(300) }).nullable().optional(),
  startsAt: optionalDate,
  endsAt: optionalDate,
  active: z.boolean().default(true),
  displayOrder: z.number().int().min(0).max(1000).default(0),
});

async function validateOffer(tx: Tx, input: Partial<z.output<typeof offerSchema>>) {
  checkWindow(input.startsAt, input.endsAt);
  if (input.discount?.type === "percentage" && input.discount.value > 90) throw invalid({ "discount.value": "Percentage discounts are limited to 90%." });
  const target = input.target;
  if (target) {
    const ids = [...new Set(target.ids)];
    if (target.scope === "all" && ids.length) throw invalid({ "target.ids": "Leave the list empty when the offer applies to everything." });
    if (target.scope !== "all" && !ids.length) throw invalid({ "target.ids": "Choose at least one target." });
    if (target.scope === "metal" && ids.some((id) => !(METALS as readonly string[]).includes(id))) throw invalid({ "target.ids": "Choose gold or silver." });
    const table = target.scope === "categories" ? categories : target.scope === "collections" ? collections : target.scope === "products" ? products : null;
    if (table) {
      if (ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw invalid({ "target.ids": "One or more targets are invalid." });
      const found = await tx.select({ id: table.id }).from(table).where(inArray(table.id, ids));
      if (found.length !== ids.length) throw invalid({ "target.ids": "One or more targets no longer exist." });
    }
  }
  if (input.couponCode) {
    const [coupon] = await tx.select({ id: coupons.id }).from(coupons).where(eq(sql`upper(${coupons.code})`, input.couponCode)).limit(1);
    if (!coupon) throw invalid({ couponCode: "No coupon with this code exists." });
  }
}

const offerValues = (input: Partial<z.output<typeof offerSchema>>) => ({
  ...input,
  ...(input.startsAt !== undefined ? { startsAt: toDate(input.startsAt) } : {}),
  ...(input.endsAt !== undefined ? { endsAt: toDate(input.endsAt) } : {}),
});

marketingRouter.get("/offers", requirePermission("marketing:view"), async (_req, res) => {
  const rows = await db().select().from(offers).orderBy(asc(offers.displayOrder), desc(offers.createdAt));
  const now = Date.now();
  res.json(
    rows.map((row) => ({
      ...row,
      state: !row.active
        ? "inactive"
        : row.startsAt && row.startsAt.getTime() > now
          ? "scheduled"
          : row.endsAt && row.endsAt.getTime() <= now
            ? "ended"
            : "running",
    })),
  );
});

marketingRouter.post("/offers", requirePermission("marketing:manage"), async (req, res) => {
  const input = parse(offerSchema, req.body);
  const actor = actorOf(req);
  const row = await db().transaction(async (tx) => {
    await validateOffer(tx, input);
    const [created] = await tx
      .insert(offers)
      .values({ ...offerValues(input), eyebrow: input.eyebrow ?? null, couponCode: input.couponCode ?? null, image: input.image ?? null, mobileImage: input.mobileImage ?? null, cta: input.cta ?? null } as typeof offers.$inferInsert)
      .returning();
    await recordAudit(tx, actor, { module: "marketing", action: "offer.create", entityType: "offer", entityId: created!.id, entityLabel: created!.title, after: { discount: input.discount, target: input.target }, sensitive: Boolean(input.discount) });
    return created!;
  });
  afterCatalogChange(["offers"]);
  res.status(201).json(row);
});

marketingRouter.patch("/offers/:id", requirePermission("marketing:manage"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(partialUpdate(offerSchema), req.body);
  const actor = actorOf(req);
  const row = await db().transaction(async (tx) => {
    const [current] = await tx.select().from(offers).where(eq(offers.id, id)).for("update");
    if (!current) throw notFound();
    await validateOffer(tx, {
      ...patch,
      startsAt: patch.startsAt !== undefined ? patch.startsAt : current.startsAt?.toISOString(),
      endsAt: patch.endsAt !== undefined ? patch.endsAt : current.endsAt?.toISOString(),
    });
    const [updated] = await tx
      .update(offers)
      .set({ ...offerValues(patch), updatedAt: new Date() } as Partial<typeof offers.$inferInsert>)
      .where(eq(offers.id, id))
      .returning();
    const changes = diff(current, updated!);
    if (changes.changed) {
      await recordAudit(tx, actor, {
        module: "marketing",
        action: "offer.update",
        entityType: "offer",
        entityId: id,
        entityLabel: updated!.title,
        ...changes,
        sensitive: "discount" in changes.after || "target" in changes.after || "active" in changes.after,
      });
    }
    return updated!;
  });
  afterCatalogChange(["offers"]);
  res.json(row);
});

marketingRouter.delete("/offers/:id", requirePermission("marketing:manage"), async (req, res) => {
  const id = idParam(req);
  const [row] = await db().delete(offers).where(eq(offers.id, id)).returning();
  if (!row) throw notFound();
  await recordAudit(db(), actorOf(req), { module: "marketing", action: "offer.delete", entityType: "offer", entityId: id, entityLabel: row.title, sensitive: Boolean(row.discount) });
  afterCatalogChange(["offers"]);
  revalidateStorefront(["offers"]);
  res.status(204).end();
});
