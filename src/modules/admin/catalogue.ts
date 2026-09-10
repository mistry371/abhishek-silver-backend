import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { Permission } from "@/auth/permissions";
import type { PriceBreakdown } from "@/contracts/common";
import { db, type Tx } from "@/db/client";
import { categories, collections, inventoryLevels, metalRates, productCollections, products, subcategories, vendors } from "@/db/schema";
import { can, requireAnyPermission, requirePermission } from "@/http/auth";
import { AppError, forbidden, invalid, notFound } from "@/lib/errors";
import { paginated, parse, zImage, zMoney, zSeo, zText, zUuid } from "@/lib/validation";
import { GENDERS, METALS, PURITIES, PURITIES_BY_METAL, purityLabels } from "@/modules/catalog/labels";
import { priceable, resolveVariant, type ProductRow } from "@/modules/catalog/snapshot";
import { loadPricingContext, priceProduct, type PricingContext } from "@/modules/pricing/context";
import { MissingRateError } from "@/modules/pricing/engine";
import { actorOf, diff, recordAudit } from "@/services/audit";
import { applyStockChange } from "@/services/inventory";
import { afterCatalogChange } from "@/services/revalidate";
import { getSetting } from "@/services/settings";
import { storeFile, validateFile } from "@/services/storage";
import { idParam, listQuery, searchAny, sortBy, withUniqueFields } from "./helpers";

export const catalogueRouter = Router();

/* ------------------------------------------------------------------ */
/* Product fields & field-level permissions                            */
/* ------------------------------------------------------------------ */

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: "Use lowercase letters, numbers and hyphens." });

const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => value || null);

const flagsSchema = z.object({
  featured: z.boolean(),
  bestSeller: z.boolean(),
  trending: z.boolean(),
  newArrival: z.boolean(),
  limited: z.boolean(),
});

const productShape = {
  name: zText(160),
  slug: slugSchema,
  sku: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,39}$/, { error: "Use 2–40 letters, numbers or hyphens." }),
  barcode: nullableText(64),
  shortDescription: z.string().trim().max(300),
  description: z.string().trim().max(5000),
  categoryId: zUuid,
  subcategoryId: zUuid.nullable(),
  collectionIds: z.array(zUuid).max(20),
  metal: z.enum(METALS),
  purity: z.enum(PURITIES),
  gender: z.enum(GENDERS),
  netWeight: z.number().positive().max(10_000),
  grossWeight: z.number().positive().max(10_000).nullable(),
  stoneWeight: z.number().min(0).max(1_000).nullable(),
  stoneDetails: nullableText(300),
  makingType: z.enum(["per_gram", "percentage", "fixed"]),
  makingValue: z.number().min(0).max(10_000_000),
  stoneCharges: zMoney,
  otherCharges: zMoney,
  discount: z
    .object({
      type: z.enum(["percentage", "fixed"]),
      value: z.number().positive().max(10_000_000),
      label: z.string().trim().max(60).optional(),
      endsAt: z.iso.datetime({ offset: true }).optional(),
    })
    .nullable(),
  sizing: z.enum(["ring", "bangle", "chain", "bracelet"]).nullable(),
  sizeOptions: z.array(z.string().trim().min(1).max(10)).max(30),
  defaultSize: z.string().trim().max(10).nullable(),
  sizeWeights: z.record(z.string().max(10), z.number().positive().max(10_000)),
  unavailableSizes: z.array(z.string().trim().max(10)).max(30),
  customization: z.array(z.enum(["engraving", "initial", "note"])).max(3),
  images: z.array(zImage).max(12),
  video: z.object({ url: z.string().trim().min(1).max(2000), poster: zImage.optional(), mimeType: z.string().max(40).optional() }).nullable(),
  flags: flagsSchema,
  status: z.enum(["active", "draft", "disabled"]),
  seo: zSeo,
  lowStockThreshold: z.number().int().min(0).max(1000),
  purchasePrice: zMoney.nullable(),
  vendorId: zUuid.nullable(),
};
type ProductField = keyof typeof productShape;

const fieldPermission: Record<ProductField, Permission> = {
  name: "products:edit_content",
  slug: "products:edit_content",
  shortDescription: "products:edit_content",
  description: "products:edit_content",
  categoryId: "products:edit_content",
  subcategoryId: "products:edit_content",
  collectionIds: "products:edit_content",
  gender: "products:edit_content",
  customization: "products:edit_content",
  images: "products:edit_content",
  video: "products:edit_content",
  seo: "products:edit_content",
  status: "products:edit_content",
  flags: "products:edit_merchandising",
  discount: "products:edit_merchandising",
  sku: "products:edit_inventory",
  barcode: "products:edit_inventory",
  metal: "products:edit_inventory",
  purity: "products:edit_inventory",
  netWeight: "products:edit_inventory",
  grossWeight: "products:edit_inventory",
  stoneWeight: "products:edit_inventory",
  stoneDetails: "products:edit_inventory",
  sizing: "products:edit_inventory",
  sizeOptions: "products:edit_inventory",
  defaultSize: "products:edit_inventory",
  sizeWeights: "products:edit_inventory",
  unavailableSizes: "products:edit_inventory",
  lowStockThreshold: "products:edit_inventory",
  makingType: "products:edit_pricing",
  makingValue: "products:edit_pricing",
  stoneCharges: "products:edit_pricing",
  otherCharges: "products:edit_pricing",
  purchasePrice: "products:view_confidential",
  vendorId: "products:view_confidential",
};

const PRICE_FIELDS = new Set<ProductField>(["metal", "purity", "netWeight", "sizeWeights", "makingType", "makingValue", "stoneCharges", "otherCharges", "discount"]);
const CONFIDENTIAL_FIELDS = new Set<ProductField>(["purchasePrice", "vendorId"]);

const createSchema = z.object({
  name: productShape.name,
  slug: productShape.slug,
  sku: productShape.sku,
  categoryId: productShape.categoryId,
  metal: productShape.metal,
  purity: productShape.purity,
  netWeight: productShape.netWeight,
  makingType: productShape.makingType,
  makingValue: productShape.makingValue,
  barcode: productShape.barcode.default(null),
  shortDescription: productShape.shortDescription.default(""),
  description: productShape.description.default(""),
  subcategoryId: productShape.subcategoryId.default(null),
  collectionIds: productShape.collectionIds.default([]),
  gender: productShape.gender.default("unisex"),
  grossWeight: productShape.grossWeight.default(null),
  stoneWeight: productShape.stoneWeight.default(null),
  stoneDetails: productShape.stoneDetails.default(null),
  stoneCharges: productShape.stoneCharges.default(0),
  otherCharges: productShape.otherCharges.default(0),
  discount: productShape.discount.default(null),
  sizing: productShape.sizing.default(null),
  sizeOptions: productShape.sizeOptions.default([]),
  defaultSize: productShape.defaultSize.default(null),
  sizeWeights: productShape.sizeWeights.default({}),
  unavailableSizes: productShape.unavailableSizes.default([]),
  customization: productShape.customization.default([]),
  images: productShape.images.default([]),
  video: productShape.video.default(null),
  flags: flagsSchema.default({ featured: false, bestSeller: false, trending: false, newArrival: false, limited: false }),
  status: productShape.status.default("draft"),
  seo: productShape.seo,
  lowStockThreshold: productShape.lowStockThreshold.optional(),
  purchasePrice: productShape.purchasePrice.default(null),
  vendorId: productShape.vendorId.default(null),
  initialStock: z.object({ locationId: z.string().trim().min(1).max(40), quantity: z.number().int().min(1).max(100_000) }).optional(),
});

const updateSchema = z.object(productShape).partial();

type ProductDraft = Pick<
  ProductRow,
  | "metal"
  | "purity"
  | "grossWeight"
  | "netWeight"
  | "makingType"
  | "makingValue"
  | "discount"
  | "sizing"
  | "sizeOptions"
  | "defaultSize"
  | "sizeWeights"
  | "unavailableSizes"
  | "categoryId"
  | "subcategoryId"
  | "vendorId"
  | "status"
  | "images"
> & { collectionIds: string[] };

const UNIQUE_FIELDS: Record<string, [string, string]> = {
  products_slug: ["slug", "This URL slug is already used by another product."],
  products_sku: ["sku", "This SKU is already used by another product."],
  products_barcode: ["barcode", "This barcode is already used by another product."],
};

/** Cross-field and referential checks shared by create, update and bulk activation. */
async function validateProduct(tx: Tx, p: ProductDraft) {
  const errors: Record<string, string> = {};
  if (!PURITIES_BY_METAL[p.metal].includes(p.purity)) errors.purity = "Choose a purity that matches the metal.";
  if (p.grossWeight !== null && p.grossWeight < p.netWeight) errors.grossWeight = "Gross weight can't be less than net weight.";
  if (p.makingType === "percentage" && p.makingValue > 100) errors.makingValue = "A percentage can't exceed 100.";
  if (p.discount?.type === "percentage" && p.discount.value > 90) errors["discount.value"] = "Percentage discounts are limited to 90%.";

  const sizes = p.sizeOptions;
  if (!p.sizing && sizes.length) errors.sizeOptions = "Choose a sizing type before adding sizes.";
  else if (new Set(sizes).size !== sizes.length) errors.sizeOptions = "Sizes must be unique.";
  if (p.defaultSize && !sizes.includes(p.defaultSize)) errors.defaultSize = "The default size must be one of the sizes.";
  if (Object.keys(p.sizeWeights).some((size) => !sizes.includes(size))) errors.sizeWeights = "Weights can only be set for listed sizes.";
  if (p.unavailableSizes.some((size) => !sizes.includes(size))) errors.unavailableSizes = "Unavailable sizes must be listed sizes.";

  const [category] = await tx.select().from(categories).where(eq(categories.id, p.categoryId)).limit(1);
  if (!category) errors.categoryId = "Choose a category.";
  else if (category.group !== "type") errors.categoryId = "Choose a jewellery type (for example Rings).";
  if (p.subcategoryId) {
    const [sub] = await tx
      .select({ id: subcategories.id })
      .from(subcategories)
      .where(and(eq(subcategories.id, p.subcategoryId), eq(subcategories.categoryId, p.categoryId)))
      .limit(1);
    if (!sub) errors.subcategoryId = "Choose a subcategory of the selected category.";
  }
  const uniqueCollections = [...new Set(p.collectionIds)];
  if (uniqueCollections.length) {
    const found = await tx.select({ id: collections.id }).from(collections).where(inArray(collections.id, uniqueCollections));
    if (found.length !== uniqueCollections.length) errors.collectionIds = "One or more collections no longer exist.";
  }
  if (p.vendorId) {
    const [vendor] = await tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, p.vendorId)).limit(1);
    if (!vendor) errors.vendorId = "Choose an existing vendor.";
  }
  if (p.status === "active") {
    if (!p.images.length) errors.images = "Add at least one image before activating.";
    const [rate] = await tx
      .select({ metal: metalRates.metal })
      .from(metalRates)
      .where(and(eq(metalRates.metal, p.metal), eq(metalRates.purity, p.purity)))
      .limit(1);
    if (!rate) errors.status = `Set a ${purityLabels[p.purity]} ${p.metal} rate in Pricing before activating.`;
  }
  if (Object.keys(errors).length) throw invalid(errors);
}

/* ------------------------------------------------------------------ */
/* Presentation                                                        */
/* ------------------------------------------------------------------ */

function stockStatusOf(row: Pick<ProductRow, "status" | "lowStockThreshold">, total: number) {
  if (row.status === "disabled") return "unavailable";
  if (total <= 0) return "out_of_stock";
  if (total <= row.lowStockThreshold) return "low_stock";
  return "in_stock";
}

function currentPrice(row: ProductRow, collectionIds: string[], context: PricingContext): { pricing: PriceBreakdown | null; pricingError: string | null } {
  try {
    return { pricing: priceProduct(priceable(row, collectionIds), resolveVariant(row).netWeight, context).pricing, pricingError: null };
  } catch (error) {
    if (error instanceof MissingRateError) return { pricing: null, pricingError: `No ${purityLabels[row.purity]} ${row.metal} rate is set.` };
    throw error;
  }
}

function withoutConfidential<T extends Partial<ProductRow>>(row: T, confidential: boolean) {
  if (confidential) return row;
  const { purchasePrice: _price, vendorId: _vendor, ...rest } = row;
  void _price;
  void _vendor;
  return rest;
}

async function productDetail(id: string, confidential: boolean) {
  const database = db();
  const [row] = await database
    .select()
    .from(products)
    .where(and(eq(products.id, id), isNull(products.deletedAt)))
    .limit(1);
  if (!row) throw notFound("Product not found.");

  const [category] = await database.select({ id: categories.id, name: categories.name, slug: categories.slug }).from(categories).where(eq(categories.id, row.categoryId));
  const collectionIds = (await database.select({ id: productCollections.collectionId }).from(productCollections).where(eq(productCollections.productId, id))).map((c) => c.id);
  const levels = await database.select({ locationId: inventoryLevels.locationId, quantity: inventoryLevels.quantity }).from(inventoryLevels).where(eq(inventoryLevels.productId, id));
  const total = levels.reduce((sum, level) => sum + level.quantity, 0);
  const vendor =
    confidential && row.vendorId ? ((await database.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.id, row.vendorId)))[0] ?? null) : null;
  const context = await loadPricingContext(database);

  return {
    ...withoutConfidential(row, confidential),
    category: category ?? null,
    collectionIds,
    stock: { total, levels, stockStatus: stockStatusOf(row, total) },
    ...(confidential ? { vendor } : {}),
    ...currentPrice(row, collectionIds, context),
  };
}

/* ------------------------------------------------------------------ */
/* Products                                                            */
/* ------------------------------------------------------------------ */

const productListSchema = listQuery.extend({
  categoryId: zUuid.optional(),
  collectionId: zUuid.optional(),
  metal: z.enum(METALS).optional(),
  purity: z.enum(PURITIES).optional(),
  status: z.enum(["active", "draft", "disabled"]).optional(),
  stock: z.enum(["in", "low", "out"]).optional(),
  vendorId: zUuid.optional(),
  flag: z.enum(["featured", "bestSeller", "trending", "newArrival", "limited"]).optional(),
});

catalogueRouter.get("/products", requirePermission("products:view"), async (req, res) => {
  const query = parse(productListSchema, req.query);
  const confidential = can(req, "products:view_confidential");
  if (query.vendorId && !confidential) throw forbidden();

  const stockAgg = db()
    .select({ productId: inventoryLevels.productId, quantity: sql<number>`sum(${inventoryLevels.quantity})`.as("quantity") })
    .from(inventoryLevels)
    .groupBy(inventoryLevels.productId)
    .as("stock_agg");
  const quantity = sql<number>`coalesce(${stockAgg.quantity}, 0)`;

  const where = and(
    isNull(products.deletedAt),
    searchAny(query.q, [products.name, products.sku, products.barcode]),
    query.categoryId ? eq(products.categoryId, query.categoryId) : undefined,
    query.metal ? eq(products.metal, query.metal) : undefined,
    query.purity ? eq(products.purity, query.purity) : undefined,
    query.status ? eq(products.status, query.status) : undefined,
    query.vendorId ? eq(products.vendorId, query.vendorId) : undefined,
    query.flag ? sql`(${products.flags} ->> ${query.flag})::boolean = true` : undefined,
    query.collectionId
      ? sql`exists (select 1 from ${productCollections} where ${productCollections.productId} = ${products.id} and ${productCollections.collectionId} = ${query.collectionId})`
      : undefined,
    query.stock === "out" ? sql`${quantity} <= 0` : undefined,
    query.stock === "low" ? sql`${quantity} > 0 and ${quantity} <= ${products.lowStockThreshold}` : undefined,
    query.stock === "in" ? sql`${quantity} > ${products.lowStockThreshold}` : undefined,
  );

  const rows = await db()
    .select({ product: products, categoryName: categories.name, quantity: sql<number>`${quantity}`.mapWith(Number) })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(stockAgg, eq(stockAgg.productId, products.id))
    .where(where)
    .orderBy(
      sortBy(
        query.sort,
        { name: products.name, sku: products.sku, createdAt: products.createdAt, updatedAt: products.updatedAt, stock: quantity },
        desc(products.updatedAt),
      ),
    )
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db()
    .select({ value: count() })
    .from(products)
    .leftJoin(stockAgg, eq(stockAgg.productId, products.id))
    .where(where);

  const ids = rows.map((r) => r.product.id);
  const links = ids.length ? await db().select().from(productCollections).where(inArray(productCollections.productId, ids)) : [];
  const context = await loadPricingContext();

  res.json(
    paginated(
      rows.map(({ product, categoryName, quantity: stock }) => {
        const collectionIds = links.filter((l) => l.productId === product.id).map((l) => l.collectionId);
        const { pricing, pricingError } = currentPrice(product, collectionIds, context);
        return {
          id: product.id,
          name: product.name,
          slug: product.slug,
          sku: product.sku,
          barcode: product.barcode,
          image: product.images[0] ?? null,
          category: { id: product.categoryId, name: categoryName },
          metal: product.metal,
          purity: product.purity,
          gender: product.gender,
          netWeight: product.netWeight,
          status: product.status,
          flags: product.flags,
          stock,
          stockStatus: stockStatusOf(product, stock),
          finalPrice: pricing?.finalPrice ?? null,
          pricingError,
          updatedAt: product.updatedAt,
          ...(confidential ? { purchasePrice: product.purchasePrice, vendorId: product.vendorId } : {}),
        };
      }),
      total?.value ?? 0,
      query.page,
      query.pageSize,
    ),
  );
});

catalogueRouter.get("/products/:id", requirePermission("products:view"), async (req, res) => {
  res.json(await productDetail(idParam(req), can(req, "products:view_confidential")));
});

catalogueRouter.post("/products", requirePermission("products:create"), async (req, res) => {
  const input = parse(createSchema, req.body);
  if ((input.purchasePrice !== null || input.vendorId !== null) && !can(req, "products:view_confidential")) {
    throw forbidden("You don't have permission to set purchase price or supplier.");
  }
  if (input.initialStock && !can(req, "inventory:adjust")) throw forbidden("You don't have permission to add stock.");

  const { initialStock, collectionIds, lowStockThreshold, ...fields } = input;
  const threshold = lowStockThreshold ?? (await getSetting("inventory")).defaultLowStockThreshold;
  const actor = actorOf(req);

  const created = await withUniqueFields(
    () =>
      db().transaction(async (tx) => {
        await validateProduct(tx, { ...fields, collectionIds });
        const [row] = await tx
          .insert(products)
          .values({ ...fields, lowStockThreshold: threshold })
          .returning();
        if (collectionIds.length) {
          await tx.insert(productCollections).values([...new Set(collectionIds)].map((collectionId) => ({ productId: row!.id, collectionId })));
        }
        if (initialStock) {
          await applyStockChange(tx, actor, {
            productId: row!.id,
            type: "opening",
            locationId: initialStock.locationId,
            quantity: initialStock.quantity,
            reason: "Opening stock when the product was created",
            reference: { type: "manual" },
          });
        }
        await recordAudit(tx, actor, {
          module: "products",
          action: "product.create",
          entityType: "product",
          entityId: row!.id,
          entityLabel: `${row!.sku} ${row!.name}`,
          after: { sku: row!.sku, name: row!.name, status: row!.status, metal: row!.metal, purity: row!.purity, initialStock: initialStock?.quantity ?? 0 },
        });
        return row!;
      }),
    UNIQUE_FIELDS,
  );
  afterCatalogChange([`product:${created.slug}`]);
  res.status(201).json(await productDetail(created.id, can(req, "products:view_confidential")));
});

catalogueRouter.patch("/products/:id", requireAnyPermission(...new Set(Object.values(fieldPermission))), async (req, res) => {
  const id = idParam(req);
  const patch = parse(updateSchema, req.body);
  const keys = Object.keys(patch) as ProductField[];
  const denied = keys.filter((key) => !can(req, fieldPermission[key]));
  if (denied.length) throw forbidden(`You don't have permission to change: ${denied.join(", ")}.`);
  const actor = actorOf(req);

  const result = await withUniqueFields(
    () =>
      db().transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(products)
          .where(and(eq(products.id, id), isNull(products.deletedAt)))
          .for("update");
        if (!current) throw notFound("Product not found.");
        const currentCollections = (await tx.select({ id: productCollections.collectionId }).from(productCollections).where(eq(productCollections.productId, id))).map((c) => c.id);
        if (!keys.length) return { row: current, previousSlug: current.slug };

        const { collectionIds, ...fields } = patch;
        const nextCollections = collectionIds ? [...new Set(collectionIds)] : currentCollections;
        await validateProduct(tx, { ...current, ...fields, collectionIds: nextCollections });

        const [row] = await tx
          .update(products)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(products.id, id))
          .returning();
        if (collectionIds) {
          await tx.delete(productCollections).where(eq(productCollections.productId, id));
          if (nextCollections.length) await tx.insert(productCollections).values(nextCollections.map((collectionId) => ({ productId: id, collectionId })));
        }

        const changes = diff({ ...current, collectionIds: currentCollections }, { ...row!, collectionIds: nextCollections });
        if (changes.changed) {
          await recordAudit(tx, actor, {
            module: "products",
            action: "product.update",
            entityType: "product",
            entityId: id,
            entityLabel: `${row!.sku} ${row!.name}`,
            before: changes.before,
            after: changes.after,
            sensitive: keys.some((key) => PRICE_FIELDS.has(key) || CONFIDENTIAL_FIELDS.has(key) || key === "status"),
          });
        }
        return { row: row!, previousSlug: current.slug };
      }),
    UNIQUE_FIELDS,
  );
  afterCatalogChange([`product:${result.row.slug}`, `product:${result.previousSlug}`]);
  res.json(await productDetail(id, can(req, "products:view_confidential")));
});

/** Soft delete keeps order, sale and stock history intact. */
catalogueRouter.delete("/products/:id", requirePermission("products:delete"), async (req, res) => {
  const id = idParam(req);
  const actor = actorOf(req);
  const removed = await db().transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, id), isNull(products.deletedAt)))
      .for("update");
    if (!current) throw notFound("Product not found.");
    const [stock] = await tx
      .select({ total: sql<number>`coalesce(sum(${inventoryLevels.quantity}), 0)`.mapWith(Number) })
      .from(inventoryLevels)
      .where(eq(inventoryLevels.productId, id));
    if ((stock?.total ?? 0) > 0) {
      throw new AppError("validation_error", `This product still has ${stock!.total} in stock. Reduce stock to zero before deleting it.`);
    }
    await tx.update(products).set({ deletedAt: new Date(), status: "disabled", updatedAt: new Date() }).where(eq(products.id, id));
    await recordAudit(tx, actor, {
      module: "products",
      action: "product.delete",
      entityType: "product",
      entityId: id,
      entityLabel: `${current.sku} ${current.name}`,
      before: { status: current.status },
      sensitive: true,
    });
    return current;
  });
  afterCatalogChange([`product:${removed.slug}`]);
  res.status(204).end();
});

const bulkSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_status"), ids: z.array(zUuid).min(1).max(200), status: productShape.status }),
  z.object({ action: z.literal("set_flag"), ids: z.array(zUuid).min(1).max(200), flag: z.enum(["featured", "bestSeller", "trending", "newArrival", "limited"]), value: z.boolean() }),
]);

/** All-or-nothing bulk changes. */
catalogueRouter.post("/products/bulk", requireAnyPermission("products:edit_content", "products:edit_merchandising"), async (req, res) => {
  const input = parse(bulkSchema, req.body);
  if (input.action === "set_status" && !can(req, "products:edit_content")) throw forbidden();
  if (input.action === "set_flag" && !can(req, "products:edit_merchandising")) throw forbidden();
  const actor = actorOf(req);
  const ids = [...new Set(input.ids)];

  const updated = await db().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(products)
      .where(and(inArray(products.id, ids), isNull(products.deletedAt)))
      .for("update");
    if (rows.length !== ids.length) throw notFound("One or more products no longer exist.");

    for (const row of rows) {
      if (input.action === "set_status") {
        if (input.status === "active") {
          try {
            await validateProduct(tx, { ...row, status: "active", collectionIds: [] });
          } catch (error) {
            if (error instanceof AppError && error.fieldErrors) {
              throw new AppError("validation_error", `${row.sku}: ${Object.values(error.fieldErrors)[0]}`);
            }
            throw error;
          }
        }
        await tx.update(products).set({ status: input.status, updatedAt: new Date() }).where(eq(products.id, row.id));
      } else {
        await tx
          .update(products)
          .set({ flags: { ...row.flags, [input.flag]: input.value }, updatedAt: new Date() })
          .where(eq(products.id, row.id));
      }
    }
    await recordAudit(tx, actor, {
      module: "products",
      action: `product.bulk_${input.action}`,
      entityType: "product",
      entityLabel: `${rows.length} products`,
      after: { ...input, skus: rows.map((r) => r.sku) },
      sensitive: input.action === "set_status",
    });
    return rows;
  });
  afterCatalogChange(updated.map((row) => `product:${row.slug}`));
  res.json({ updated: updated.length });
});

/* ------------------------------------------------------------------ */
/* Categories, subcategories & collections                             */
/* ------------------------------------------------------------------ */

const listingRuleSchema = z
  .object({
    metal: z.enum(METALS).optional(),
    genders: z.array(z.enum(GENDERS)).max(4).optional(),
    customizable: z.boolean().optional(),
  })
  .nullable();

const categorySchema = z.object({
  slug: slugSchema,
  name: zText(80),
  shortName: nullableText(40).default(null),
  description: z.string().trim().max(500).default(""),
  image: zImage,
  group: z.enum(["metal", "type", "audience", "service"]),
  listingRule: listingRuleSchema.default(null),
  seo: zSeo,
  displayOrder: z.number().int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
});

function checkListingRule(group: string, rule: z.output<typeof listingRuleSchema>) {
  if (group === "type" && rule) throw invalid({ listingRule: "Jewellery types list their own products and don't use a listing rule." });
  if (group !== "type" && (!rule || (!rule.metal && !rule.genders?.length && !rule.customizable))) {
    throw invalid({ listingRule: "Choose which products this page should list (metal, audience or personalisable)." });
  }
}

const taxonomyAccess = requireAnyPermission("products:view", "catalog:manage_taxonomy");

catalogueRouter.get("/categories", taxonomyAccess, async (_req, res) => {
  const database = db();
  const rows = await database.select().from(categories).orderBy(asc(categories.displayOrder));
  const subs = await database.select().from(subcategories).orderBy(asc(subcategories.displayOrder));
  const counts = await database
    .select({ categoryId: products.categoryId, value: count() })
    .from(products)
    .where(isNull(products.deletedAt))
    .groupBy(products.categoryId);
  res.json(
    rows.map((row) => ({
      ...row,
      productCount: counts.find((c) => c.categoryId === row.id)?.value ?? 0,
      subcategories: subs.filter((s) => s.categoryId === row.id),
    })),
  );
});

catalogueRouter.post("/categories", requirePermission("catalog:manage_taxonomy"), async (req, res) => {
  const input = parse(categorySchema, req.body);
  checkListingRule(input.group, input.listingRule);
  const actor = actorOf(req);
  const row = await withUniqueFields(
    () =>
      db().transaction(async (tx) => {
        const [created] = await tx.insert(categories).values(input).returning();
        await recordAudit(tx, actor, { module: "products", action: "category.create", entityType: "category", entityId: created!.id, entityLabel: created!.name });
        return created!;
      }),
    { categories_slug: ["slug", "This slug is already used by another category."] },
  );
  afterCatalogChange();
  res.status(201).json(row);
});

catalogueRouter.patch("/categories/:id", requirePermission("catalog:manage_taxonomy"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(categorySchema.partial(), req.body);
  const actor = actorOf(req);
  const row = await withUniqueFields(
    () =>
      db().transaction(async (tx) => {
        const [current] = await tx.select().from(categories).where(eq(categories.id, id)).for("update");
        if (!current) throw notFound();
        const group = patch.group ?? current.group;
        if (group !== current.group) {
          const [used] = await tx.select({ value: count() }).from(products).where(eq(products.categoryId, id));
          if ((used?.value ?? 0) > 0) throw invalid({ group: "This category has products, so its type can't change." });
        }
        checkListingRule(group, patch.listingRule !== undefined ? patch.listingRule : current.listingRule);
        const [updated] = await tx
          .update(categories)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(categories.id, id))
          .returning();
        const changes = diff(current, updated!);
        if (changes.changed) {
          await recordAudit(tx, actor, { module: "products", action: "category.update", entityType: "category", entityId: id, entityLabel: updated!.name, ...changes });
        }
        return updated!;
      }),
    { categories_slug: ["slug", "This slug is already used by another category."] },
  );
  afterCatalogChange();
  res.json(row);
});

catalogueRouter.delete("/categories/:id", requirePermission("catalog:manage_taxonomy"), async (req, res) => {
  const id = idParam(req);
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const [current] = await tx.select().from(categories).where(eq(categories.id, id)).for("update");
    if (!current) throw notFound();
    const [used] = await tx.select({ value: count() }).from(products).where(eq(products.categoryId, id));
    if ((used?.value ?? 0) > 0) throw new AppError("validation_error", "Move this category's products to another category before deleting it.");
    await tx.delete(categories).where(eq(categories.id, id));
    await recordAudit(tx, actor, { module: "products", action: "category.delete", entityType: "category", entityId: id, entityLabel: current.name, sensitive: true });
  });
  afterCatalogChange();
  res.status(204).end();
});

const subcategorySchema = z.object({
  slug: slugSchema,
  name: zText(80),
  displayOrder: z.number().int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
});

catalogueRouter.post("/categories/:id/subcategories", requirePermission("catalog:manage_taxonomy"), async (req, res) => {
  const categoryId = idParam(req);
  const input = parse(subcategorySchema, req.body);
  const [category] = await db().select().from(categories).where(eq(categories.id, categoryId)).limit(1);
  if (!category) throw notFound();
  if (category.group !== "type") throw invalid({ slug: "Subcategories can only be added to jewellery types." });
  const row = await withUniqueFields(
    async () => (await db().insert(subcategories).values({ ...input, categoryId }).returning())[0]!,
    { subcategories_category_slug: ["slug", "This category already has a subcategory with this slug."] },
  );
  await recordAudit(db(), actorOf(req), { module: "products", action: "subcategory.create", entityType: "subcategory", entityId: row.id, entityLabel: `${category.name} / ${row.name}` });
  afterCatalogChange();
  res.status(201).json(row);
});

catalogueRouter.patch("/subcategories/:id", requirePermission("catalog:manage_taxonomy"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(subcategorySchema.partial(), req.body);
  const row = await withUniqueFields(
    async () =>
      (
        await db()
          .update(subcategories)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(subcategories.id, id))
          .returning()
      )[0],
    { subcategories_category_slug: ["slug", "This category already has a subcategory with this slug."] },
  );
  if (!row) throw notFound();
  await recordAudit(db(), actorOf(req), { module: "products", action: "subcategory.update", entityType: "subcategory", entityId: id, entityLabel: row.name, after: patch });
  afterCatalogChange();
  res.json(row);
});

catalogueRouter.delete("/subcategories/:id", requirePermission("catalog:manage_taxonomy"), async (req, res) => {
  const id = idParam(req);
  const [row] = await db().delete(subcategories).where(eq(subcategories.id, id)).returning();
  if (!row) throw notFound();
  await recordAudit(db(), actorOf(req), { module: "products", action: "subcategory.delete", entityType: "subcategory", entityId: id, entityLabel: row.name });
  afterCatalogChange();
  res.status(204).end();
});

const collectionSchema = z.object({
  slug: slugSchema,
  name: zText(80),
  eyebrow: nullableText(80).default(null),
  description: z.string().trim().max(600).default(""),
  image: zImage,
  mobileImage: zImage.nullable().default(null),
  seo: zSeo,
  displayOrder: z.number().int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
});

catalogueRouter.get("/collections", taxonomyAccess, async (_req, res) => {
  const rows = await db().select().from(collections).orderBy(asc(collections.displayOrder));
  const counts = await db()
    .select({ collectionId: productCollections.collectionId, value: count() })
    .from(productCollections)
    .innerJoin(products, and(eq(products.id, productCollections.productId), isNull(products.deletedAt)))
    .groupBy(productCollections.collectionId);
  res.json(rows.map((row) => ({ ...row, productCount: counts.find((c) => c.collectionId === row.id)?.value ?? 0 })));
});

catalogueRouter.post("/collections", requirePermission("catalog:manage_taxonomy"), async (req, res) => {
  const input = parse(collectionSchema, req.body);
  const row = await withUniqueFields(async () => (await db().insert(collections).values(input).returning())[0]!, {
    collections_slug: ["slug", "This slug is already used by another collection."],
  });
  await recordAudit(db(), actorOf(req), { module: "products", action: "collection.create", entityType: "collection", entityId: row.id, entityLabel: row.name });
  afterCatalogChange([`collection:${row.slug}`]);
  res.status(201).json(row);
});

catalogueRouter.patch("/collections/:id", requirePermission("catalog:manage_taxonomy"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(collectionSchema.partial(), req.body);
  const row = await withUniqueFields(
    async () =>
      (
        await db()
          .update(collections)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(collections.id, id))
          .returning()
      )[0],
    { collections_slug: ["slug", "This slug is already used by another collection."] },
  );
  if (!row) throw notFound();
  await recordAudit(db(), actorOf(req), { module: "products", action: "collection.update", entityType: "collection", entityId: id, entityLabel: row.name, after: patch });
  afterCatalogChange([`collection:${row.slug}`]);
  res.json(row);
});

catalogueRouter.delete("/collections/:id", requirePermission("catalog:manage_taxonomy"), async (req, res) => {
  const id = idParam(req);
  const [row] = await db().delete(collections).where(eq(collections.id, id)).returning();
  if (!row) throw notFound();
  await recordAudit(db(), actorOf(req), { module: "products", action: "collection.delete", entityType: "collection", entityId: id, entityLabel: row.name, sensitive: true });
  afterCatalogChange([`collection:${row.slug}`]);
  res.status(204).end();
});

/* ------------------------------------------------------------------ */
/* Media uploads                                                       */
/* ------------------------------------------------------------------ */

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

catalogueRouter.post(
  "/media",
  requireAnyPermission("products:edit_content", "products:create", "catalog:manage_taxonomy", "content:manage"),
  upload.single("file"),
  async (req, res) => {
    const { kind } = parse(z.object({ kind: z.enum(["image", "video"]).default("image") }), req.query);
    if (!req.file) throw invalid({ file: "Choose a file to upload." });
    const type = validateFile(req.file.buffer, kind);
    const stored = await storeFile({ bucket: "media", buffer: req.file.buffer, type, folder: kind === "image" ? "images" : "videos" });
    res.status(201).json({ url: stored.url, path: stored.path, type, size: req.file.size });
  },
);
