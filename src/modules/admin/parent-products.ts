import { and, asc, count, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import type { MetalType, PurityCode } from "@/contracts/common";
import { db, type Executor, type Tx } from "@/db/client";
import { categories, collections, inventoryLevels, parentProductCollections, parentProducts, productCollections, products, subcategories } from "@/db/schema";
import { requirePermission } from "@/http/auth";
import { AppError, invalid, notFound } from "@/lib/errors";
import { paginated, parse, partialUpdate, zImage, zPagination, zSeo, zText, zUuid } from "@/lib/validation";
import { labelKey, variantLabelOf } from "@/modules/catalog/labels";
import { loadPricingContext } from "@/modules/pricing/context";
import { actorOf, diff, recordAudit } from "@/services/audit";
import { afterCatalogChange } from "@/services/revalidate";
import { currentPrice, slugSchema } from "./catalogue";
import { escapeLike, idParam, searchAny, withUniqueFields } from "./helpers";
import { assertSlugFree, slugify, uniqueSlug } from "./variant-rules";

/**
 * PARENT PRODUCTS
 * ------------------------------------------------------------------
 * One jewellery design sold in several variants. Each variant is an ordinary
 * product (own SKU, stock and price); the parent holds the shared name,
 * descriptions, taxonomy, images and SEO, the variant order and the default
 * variant. Only an ACTIVE parent changes the website.
 */
export const parentProductsRouter = Router();

export type ParentProductRow = typeof parentProducts.$inferSelect;

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const variantInput = z.object({
  productId: zUuid,
  label: z
    .string()
    .trim()
    .max(60)
    .nullable()
    .optional()
    .transform((value) => value || null),
});
const variantsSchema = z.array(variantInput).max(50);
export type VariantInput = { productId: string; label: string | null };

export const parentShape = {
  name: zText(160),
  slug: slugSchema,
  shortDescription: z.string().trim().max(300),
  description: z.string().trim().max(5000),
  categoryId: zUuid,
  subcategoryId: zUuid.nullable(),
  collectionIds: z.array(zUuid).max(20),
  images: z.array(zImage).max(12),
  seo: zSeo,
  status: z.enum(["active", "draft"]),
  defaultVariantId: zUuid.nullable(),
};

export const createParentSchema = z.object({
  name: parentShape.name,
  slug: parentShape.slug.optional(),
  shortDescription: parentShape.shortDescription.default(""),
  description: parentShape.description.default(""),
  categoryId: parentShape.categoryId,
  subcategoryId: parentShape.subcategoryId.default(null),
  collectionIds: parentShape.collectionIds.default([]),
  images: parentShape.images.default([]),
  seo: parentShape.seo,
  status: parentShape.status.default("draft"),
  variants: variantsSchema.default([]),
  defaultVariantId: parentShape.defaultVariantId.optional(),
});

export const updateParentSchema = partialUpdate(z.object(parentShape));

const replaceVariantsSchema = z.object({ variants: variantsSchema, defaultVariantId: zUuid.nullable().optional() });

/** Like `parse`, but reports per-variant problems as `variants.<index>` (never `variants.<index>.productId`). */
function parseWithVariants<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  try {
    return parse(schema, body);
  } catch (error) {
    if (!(error instanceof AppError) || !error.fieldErrors) throw error;
    const fieldErrors: Record<string, string> = {};
    for (const [key, message] of Object.entries(error.fieldErrors)) fieldErrors[key.replace(/^(variants\.\d+)\..*$/, "$1")] ??= message;
    throw invalid(fieldErrors);
  }
}

const UNIQUE_PARENT_FIELDS: Record<string, [string, string]> = {
  parent_products_slug: ["slug", "This URL slug is already used by another parent product."],
};

/* ------------------------------------------------------------------ */
/* Rules (shared with the bulk import)                                 */
/* ------------------------------------------------------------------ */

/** Category, subcategory and collection checks. Returns field errors (empty when fine). */
export async function taxonomyErrors(ex: Executor, p: { categoryId: string; subcategoryId: string | null; collectionIds: string[] }) {
  const errors: Record<string, string> = {};
  const [category] = await ex.select({ group: categories.group }).from(categories).where(eq(categories.id, p.categoryId)).limit(1);
  if (!category) errors.categoryId = "Choose a category.";
  else if (category.group !== "type") errors.categoryId = "Choose a jewellery type (for example Rings).";
  if (p.subcategoryId) {
    const [sub] = await ex
      .select({ id: subcategories.id })
      .from(subcategories)
      .where(and(eq(subcategories.id, p.subcategoryId), eq(subcategories.categoryId, p.categoryId)))
      .limit(1);
    if (!sub) errors.subcategoryId = "Choose a subcategory of the selected category.";
  }
  const unique = [...new Set(p.collectionIds)];
  if (unique.length) {
    const found = await ex.select({ id: collections.id }).from(collections).where(inArray(collections.id, unique));
    if (found.length !== unique.length) errors.collectionIds = "One or more collections no longer exist.";
  }
  return errors;
}

interface MemberRow {
  id: string;
  sku: string;
  slug: string;
  metal: MetalType;
  purity: PurityCode;
  parentId: string | null;
  parentName: string | null;
}

/**
 * Validates a complete variant set for `parentId` (null while creating):
 * every product exists, appears once and belongs to no other parent; labels
 * are unique; the default is one of the variants. Per-row problems are keyed
 * `variants.<index>`, set-level ones `variants` / `defaultVariantId`. Resolves
 * the default — the requested one, else the current one if kept, else the first variant.
 */
export async function checkVariants(
  ex: Executor,
  parentId: string | null,
  variants: VariantInput[],
  requestedDefault: string | null | undefined,
  currentDefault: string | null = null,
): Promise<{ errors: Record<string, string>; defaultVariantId: string | null; members: MemberRow[] }> {
  const errors: Record<string, string> = {};
  const ids = variants.map((v) => v.productId);
  const members: MemberRow[] = ids.length
    ? await ex
        .select({
          id: products.id,
          sku: products.sku,
          slug: products.slug,
          metal: products.metal,
          purity: products.purity,
          parentId: products.parentId,
          parentName: parentProducts.name,
        })
        .from(products)
        .leftJoin(parentProducts, eq(parentProducts.id, products.parentId))
        .where(and(inArray(products.id, [...new Set(ids)]), isNull(products.deletedAt)))
    : [];
  const byId = new Map(members.map((m) => [m.id, m]));

  const seen = new Set<string>();
  const labels = new Map<string, { index: number; sku: string }>();
  variants.forEach((variant, index) => {
    const member = byId.get(variant.productId);
    if (seen.has(variant.productId)) {
      errors[`variants.${index}`] = `${member?.sku ?? "This product"} is listed more than once.`;
      return;
    }
    seen.add(variant.productId);
    if (!member) {
      errors[`variants.${index}`] = "This product no longer exists.";
      return;
    }
    if (member.parentId && member.parentId !== parentId) {
      errors[`variants.${index}`] = `${member.sku} already belongs to the parent product “${member.parentName}”. Remove it there first.`;
      return;
    }
    const label = variantLabelOf({ ...member, variantCustomLabel: variant.label });
    const clash = labels.get(labelKey(label));
    if (clash) {
      errors[`variants.${index}`] = `${member.sku} and ${clash.sku} would both be labelled “${label}”. Give each variant a different label.`;
      return;
    }
    labels.set(labelKey(label), { index, sku: member.sku });
  });

  let defaultVariantId: string | null = null;
  if (requestedDefault) {
    if (!ids.includes(requestedDefault)) errors.defaultVariantId = "The default variant must be one of this parent product's variants.";
    else defaultVariantId = requestedDefault;
  } else if (currentDefault && ids.includes(currentDefault)) defaultVariantId = currentDefault;
  else defaultVariantId = ids[0] ?? null;

  return { errors, defaultVariantId, members };
}

/** Replaces the parent's variant set: detaches products no longer listed, then attaches and orders the rest. */
export async function writeVariants(tx: Tx, parentId: string, variants: VariantInput[]) {
  const ids = variants.map((v) => v.productId);
  await tx
    .update(products)
    .set({ parentId: null, variantCustomLabel: null, variantOrder: 0, updatedAt: new Date() })
    .where(and(eq(products.parentId, parentId), ids.length ? notInArray(products.id, ids) : undefined));
  for (const [index, variant] of variants.entries()) {
    const updated = await tx
      .update(products)
      .set({ parentId, variantCustomLabel: variant.label, variantOrder: index, updatedAt: new Date() })
      .where(and(eq(products.id, variant.productId), isNull(products.deletedAt), or(isNull(products.parentId), eq(products.parentId, parentId))))
      .returning({ id: products.id });
    // The row lock taken by UPDATE makes this the database-level guard against two parents claiming one product at once.
    if (!updated.length) throw new AppError("conflict", "One of these products was just added to another parent product. Refresh and try again.");
  }
}

export async function writeParentCollections(tx: Tx, parentId: string, collectionIds: string[]) {
  await tx.delete(parentProductCollections).where(eq(parentProductCollections.parentId, parentId));
  const unique = [...new Set(collectionIds)];
  if (unique.length) await tx.insert(parentProductCollections).values(unique.map((collectionId) => ({ parentId, collectionId })));
}

/** Slugs of the parent and its variants, for storefront cache purges. */
async function cacheTags(ex: Executor, parentId: string, extraSlugs: string[] = []) {
  const rows = await ex.select({ slug: products.slug }).from(products).where(eq(products.parentId, parentId));
  return [...new Set([...rows.map((r) => r.slug), ...extraSlugs])].map((slug) => `product:${slug}`);
}

/* ------------------------------------------------------------------ */
/* Presentation                                                        */
/* ------------------------------------------------------------------ */

export async function parentDetail(ex: Executor, id: string) {
  const [row] = await ex.select().from(parentProducts).where(eq(parentProducts.id, id)).limit(1);
  if (!row) throw notFound("Parent product not found.");
  const [category] = await ex.select({ id: categories.id, name: categories.name, slug: categories.slug }).from(categories).where(eq(categories.id, row.categoryId));
  const collectionIds = (await ex.select({ id: parentProductCollections.collectionId }).from(parentProductCollections).where(eq(parentProductCollections.parentId, id))).map(
    (c) => c.id,
  );

  const variantRows = await ex
    .select()
    .from(products)
    .where(and(eq(products.parentId, id), isNull(products.deletedAt)))
    .orderBy(asc(products.variantOrder), asc(products.sku));
  const variantIds = variantRows.map((v) => v.id);
  const stock = variantIds.length
    ? await ex
        .select({ productId: inventoryLevels.productId, total: sql<number>`coalesce(sum(${inventoryLevels.quantity}), 0)`.mapWith(Number) })
        .from(inventoryLevels)
        .where(inArray(inventoryLevels.productId, variantIds))
        .groupBy(inventoryLevels.productId)
    : [];
  const links = variantIds.length ? await ex.select().from(productCollections).where(inArray(productCollections.productId, variantIds)) : [];
  const context = variantIds.length ? await loadPricingContext(ex) : null;

  return {
    ...row,
    category: category ?? null,
    collectionIds,
    variants: variantRows.map((variant) => ({
      productId: variant.id,
      sku: variant.sku,
      name: variant.name,
      slug: variant.slug,
      metal: variant.metal,
      purity: variant.purity,
      label: variantLabelOf(variant),
      customLabel: variant.variantCustomLabel,
      status: variant.status,
      stock: stock.find((s) => s.productId === variant.id)?.total ?? 0,
      price:
        currentPrice(
          variant,
          links.filter((l) => l.productId === variant.id).map((l) => l.collectionId),
          context!,
        ).pricing?.finalPrice ?? null,
    })),
  };
}

const auditVariants = (detail: Awaited<ReturnType<typeof parentDetail>>) => detail.variants.map((v) => `${v.sku} (${v.label})`);

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const listSchema = zPagination.extend({
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((value) => value || undefined),
  status: z.enum(["active", "draft"]).optional(),
});

parentProductsRouter.get("/parent-products", requirePermission("products:view"), async (req, res) => {
  const query = parse(listSchema, req.query);
  const variantCount = sql<number>`(select count(*) from ${products} where ${products.parentId} = ${parentProducts.id} and ${products.deletedAt} is null)`.mapWith(Number);
  const where = and(
    query.search
      ? or(
          searchAny(query.search, [parentProducts.name, parentProducts.slug]),
          sql`exists (select 1 from ${products} where ${products.parentId} = ${parentProducts.id} and ${products.sku} ilike ${`%${escapeLike(query.search)}%`})`,
        )
      : undefined,
    query.status ? eq(parentProducts.status, query.status) : undefined,
  );
  const rows = await db()
    .select({ parent: parentProducts, category: { id: categories.id, name: categories.name }, variantCount })
    .from(parentProducts)
    .leftJoin(categories, eq(categories.id, parentProducts.categoryId))
    .where(where)
    .orderBy(desc(parentProducts.updatedAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db().select({ value: count() }).from(parentProducts).where(where);
  res.json(
    paginated(
      rows.map(({ parent, category, variantCount: variants }) => ({
        id: parent.id,
        slug: parent.slug,
        name: parent.name,
        status: parent.status,
        category: category ?? null,
        image: parent.images[0] ?? null,
        variantCount: variants,
        defaultVariantId: parent.defaultVariantId,
        updatedAt: parent.updatedAt,
      })),
      total?.value ?? 0,
      query.page,
      query.pageSize,
    ),
  );
});

parentProductsRouter.get("/parent-products/:id", requirePermission("products:view"), async (req, res) => {
  res.json(await parentDetail(db(), idParam(req)));
});

parentProductsRouter.post("/parent-products", requirePermission("products:create"), async (req, res) => {
  const input = parseWithVariants(createParentSchema, req.body);
  const actor = actorOf(req);
  const { variants, defaultVariantId: requestedDefault, collectionIds, slug: requestedSlug, ...fields } = input;

  const created = await withUniqueFields(
    () =>
      db().transaction(async (tx) => {
        const errors = await taxonomyErrors(tx, { ...fields, collectionIds });
        const checked = await checkVariants(tx, null, variants, requestedDefault);
        Object.assign(errors, checked.errors);
        if (Object.keys(errors).length) throw invalid(errors);
        let slug = requestedSlug;
        if (slug) await assertSlugFree(tx, slug);
        else slug = await uniqueSlug(tx, slugify(fields.name));

        const [row] = await tx.insert(parentProducts).values({ ...fields, slug }).returning();
        await writeParentCollections(tx, row!.id, collectionIds);
        await writeVariants(tx, row!.id, variants);
        if (checked.defaultVariantId) await tx.update(parentProducts).set({ defaultVariantId: checked.defaultVariantId }).where(eq(parentProducts.id, row!.id));
        const detail = await parentDetail(tx, row!.id);
        await recordAudit(tx, actor, {
          module: "products",
          action: "parent_product.create",
          entityType: "parent_product",
          entityId: row!.id,
          entityLabel: row!.name,
          after: { slug: row!.slug, name: row!.name, status: row!.status, variants: auditVariants(detail), defaultVariantId: detail.defaultVariantId },
        });
        return detail;
      }),
    UNIQUE_PARENT_FIELDS,
  );
  afterCatalogChange(await cacheTags(db(), created.id, [created.slug]));
  res.status(201).json(created);
});

parentProductsRouter.patch("/parent-products/:id", requirePermission("products:edit_content"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(updateParentSchema, req.body);
  const actor = actorOf(req);

  const result = await withUniqueFields(
    () =>
      db().transaction(async (tx) => {
        const [current] = await tx.select().from(parentProducts).where(eq(parentProducts.id, id)).for("update");
        if (!current) throw notFound("Parent product not found.");
        const before = await parentDetail(tx, id);
        const { collectionIds, defaultVariantId, ...fields } = patch;

        const errors = await taxonomyErrors(tx, {
          categoryId: fields.categoryId ?? current.categoryId,
          subcategoryId: fields.subcategoryId !== undefined ? fields.subcategoryId : current.subcategoryId,
          collectionIds: collectionIds ?? [],
        });
        const variantIds = before.variants.map((v) => v.productId);
        let nextDefault = current.defaultVariantId;
        if (defaultVariantId !== undefined) {
          if (defaultVariantId && !variantIds.includes(defaultVariantId)) errors.defaultVariantId = "The default variant must be one of this parent product's variants.";
          nextDefault = defaultVariantId ?? variantIds[0] ?? null;
        }
        if (Object.keys(errors).length) throw invalid(errors);
        if (fields.slug && fields.slug !== current.slug) await assertSlugFree(tx, fields.slug, { parentId: id });

        const [updated] = await tx
          .update(parentProducts)
          .set({ ...fields, defaultVariantId: nextDefault, updatedAt: new Date() })
          .where(eq(parentProducts.id, id))
          .returning();
        if (collectionIds) await writeParentCollections(tx, id, collectionIds);
        const after = await parentDetail(tx, id);

        const changes = diff({ ...current, collectionIds: [...before.collectionIds].sort() }, { ...updated!, collectionIds: [...after.collectionIds].sort() });
        if (changes.changed) {
          await recordAudit(tx, actor, {
            module: "products",
            action: "parent_product.update",
            entityType: "parent_product",
            entityId: id,
            entityLabel: after.name,
            before: changes.before,
            after: changes.after,
            sensitive: patch.status !== undefined && patch.status !== current.status,
          });
        }
        return { detail: after, previousSlug: current.slug };
      }),
    UNIQUE_PARENT_FIELDS,
  );
  afterCatalogChange(await cacheTags(db(), id, [result.detail.slug, result.previousSlug]));
  res.json(result.detail);
});

parentProductsRouter.put("/parent-products/:id/variants", requirePermission("products:edit_content"), async (req, res) => {
  const id = idParam(req);
  const input = parseWithVariants(replaceVariantsSchema, req.body);
  const actor = actorOf(req);

  const result = await db().transaction(async (tx) => {
    const [current] = await tx.select().from(parentProducts).where(eq(parentProducts.id, id)).for("update");
    if (!current) throw notFound("Parent product not found.");
    const before = await parentDetail(tx, id);
    const checked = await checkVariants(tx, id, input.variants, input.defaultVariantId, current.defaultVariantId);
    if (Object.keys(checked.errors).length) throw invalid(checked.errors);

    await writeVariants(tx, id, input.variants);
    await tx.update(parentProducts).set({ defaultVariantId: checked.defaultVariantId, updatedAt: new Date() }).where(eq(parentProducts.id, id));
    const after = await parentDetail(tx, id);
    await recordAudit(tx, actor, {
      module: "products",
      action: "parent_product.variants",
      entityType: "parent_product",
      entityId: id,
      entityLabel: after.name,
      before: { variants: auditVariants(before), defaultVariantId: before.defaultVariantId },
      after: { variants: auditVariants(after), defaultVariantId: after.defaultVariantId },
    });
    return { detail: after, detachedSlugs: before.variants.map((v) => v.slug) };
  });
  afterCatalogChange(await cacheTags(db(), id, [result.detail.slug, ...result.detachedSlugs]));
  res.json(result.detail);
});

/** Removes the parent only: its products become standalone again. */
parentProductsRouter.delete("/parent-products/:id", requirePermission("products:delete"), async (req, res) => {
  const id = idParam(req);
  const actor = actorOf(req);
  const removed = await db().transaction(async (tx) => {
    const [current] = await tx.select().from(parentProducts).where(eq(parentProducts.id, id)).for("update");
    if (!current) throw notFound("Parent product not found.");
    const detail = await parentDetail(tx, id);
    const variantSlugs = (await tx.select({ slug: products.slug }).from(products).where(eq(products.parentId, id))).map((r) => r.slug);
    await tx.update(products).set({ parentId: null, variantCustomLabel: null, variantOrder: 0, updatedAt: new Date() }).where(eq(products.parentId, id));
    await tx.delete(parentProducts).where(eq(parentProducts.id, id));
    await recordAudit(tx, actor, {
      module: "products",
      action: "parent_product.delete",
      entityType: "parent_product",
      entityId: id,
      entityLabel: current.name,
      before: { slug: current.slug, name: current.name, status: current.status, variants: auditVariants(detail) },
      sensitive: true,
    });
    return { slug: current.slug, variantSlugs };
  });
  afterCatalogChange([removed.slug, ...removed.variantSlugs].map((slug) => `product:${slug}`));
  res.status(204).end();
});
