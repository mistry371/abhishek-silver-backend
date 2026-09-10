import { and, asc, eq, isNull } from "drizzle-orm";
import type { ProductDiscount } from "@/contracts/common";
import type { Category, Collection, InventoryAvailability, Product, ProductBadge, ProductSummary, TaxonomyRef } from "@/contracts/storefront";
import { db } from "@/db/client";
import { categories, collections, inventoryLevels, productCollections, products, subcategories } from "@/db/schema";
import { logger } from "@/lib/logger";
import { round2 } from "@/lib/money";
import { loadPricingContext, priceProduct, type PriceableProduct, type PricingContext } from "@/modules/pricing/context";
import { MissingRateError } from "@/modules/pricing/engine";
import { getSetting } from "@/services/settings";
import { customizationCatalog, metalLabels, purityLabels, sizeLabel } from "./labels";

export type ProductRow = typeof products.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type SubcategoryRow = typeof subcategories.$inferSelect;
export type CollectionRow = typeof collections.$inferSelect;

export interface CatalogEntry {
  row: ProductRow;
  category: CategoryRow;
  subcategory: SubcategoryRow | null;
  collections: CollectionRow[];
  /** Units at the online fulfilment location. Internal only — never serialised. */
  stock: number;
  product: Product;
  summary: ProductSummary;
}

export interface CatalogSnapshot {
  entries: CatalogEntry[];
  byId: Map<string, CatalogEntry>;
  bySlug: Map<string, CatalogEntry>;
  categories: Category[];
  categoryRows: CategoryRow[];
  collections: Collection[];
  pricing: PricingContext;
}

/* ------------------------------------------------------------------ */
/* Variants, availability & presentation                               */
/* ------------------------------------------------------------------ */

export function resolveVariant(row: ProductRow, size?: string) {
  const options = row.sizeOptions;
  const selected = options.length
    ? size && options.includes(size)
      ? size
      : row.defaultSize && options.includes(row.defaultSize)
        ? row.defaultSize
        : options[0]
    : undefined;
  const netWeight = round2(selected && row.sizeWeights[selected] !== undefined ? row.sizeWeights[selected]! : row.netWeight);
  // Non-metal weight: beads/stringing (gross − net) plus stones (1 ct = 0.2 g).
  const nonMetal = (row.grossWeight ?? row.netWeight) - row.netWeight + (row.stoneWeight ?? 0) * 0.2;
  return { size: selected, netWeight, grossWeight: round2(netWeight + nonMetal) };
}

export function resolveAvailability(row: ProductRow, stock: number, size?: string): InventoryAvailability {
  if (row.status !== "active" || row.deletedAt) return { status: "unavailable", purchasable: false };
  if (stock <= 0) return { status: "out_of_stock", purchasable: false, message: "Enquire to be notified when it returns" };
  if (size && row.unavailableSizes.includes(size)) return { status: "out_of_stock", purchasable: false, message: "Not available in this size" };
  if (stock <= row.lowStockThreshold) return { status: "low_stock", purchasable: true };
  return { status: "in_stock", purchasable: true };
}

const ref = (item: { id: string; slug: string; name: string }): TaxonomyRef => ({ id: item.id, slug: item.slug, name: item.name });

export function priceable(row: ProductRow, collectionIds: string[]): PriceableProduct {
  return {
    id: row.id,
    metal: row.metal,
    purity: row.purity,
    categoryId: row.categoryId,
    collectionIds,
    makingType: row.makingType,
    makingValue: row.makingValue,
    stoneCharges: row.stoneCharges,
    otherCharges: row.otherCharges,
    discount: row.discount as ProductDiscount | null,
  };
}

export function priceEntry(entry: Pick<CatalogEntry, "row" | "collections">, context: PricingContext, size?: string) {
  const variant = resolveVariant(entry.row, size);
  const { pricing, discount } = priceProduct(
    priceable(
      entry.row,
      entry.collections.map((c) => c.id),
    ),
    variant.netWeight,
    context,
  );
  return { variant, pricing, discount };
}

function buildProduct(
  row: ProductRow,
  category: CategoryRow,
  subcategory: SubcategoryRow | null,
  productCollectionRows: CollectionRow[],
  stock: number,
  context: PricingContext,
): Product {
  const { variant, pricing, discount } = priceEntry({ row, collections: productCollectionRows }, context);
  const availability = resolveAvailability(row, stock);

  const badges: ProductBadge[] = [];
  if (availability.status === "out_of_stock") badges.push("out_of_stock");
  if (discount) badges.push("sale");
  if (row.flags.limited) badges.push("limited");
  if (row.flags.newArrival) badges.push("new");
  if (row.flags.bestSeller) badges.push("best_seller");
  if (row.flags.trending) badges.push("trending");

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    sku: row.sku,
    shortDescription: row.shortDescription,
    description: row.description,
    images: row.images,
    video: row.video ?? null,
    category: ref(category),
    subcategory: subcategory ? ref(subcategory) : null,
    collections: productCollectionRows.map(ref),
    metal: row.metal,
    purity: row.purity,
    gender: row.gender,
    grossWeight: variant.grossWeight,
    netWeight: variant.netWeight,
    stoneWeight: row.stoneWeight ?? null,
    stoneDetails: row.stoneDetails ?? null,
    makingCharges: pricing.makingCharges,
    stoneCharges: pricing.stoneCharges,
    otherCharges: pricing.otherCharges,
    basePrice: pricing.taxableValue + pricing.discount,
    discount,
    gst: { rate: pricing.gstRate, amount: pricing.gst },
    finalPrice: pricing.finalPrice,
    pricing,
    availability,
    stockStatus: availability.status,
    sizes: row.sizeOptions.map((value) => ({
      value,
      label: sizeLabel(row.sizing, value),
      available: stock > 0 && !row.unavailableSizes.includes(value),
    })),
    defaultSize: variant.size ?? null,
    variants: row.sizeOptions.map((value) => {
      const sized = resolveVariant(row, value);
      return {
        id: `${row.id}-${value}`,
        sku: `${row.sku}-${value.replace(".", "")}`,
        size: value,
        grossWeight: sized.grossWeight,
        netWeight: sized.netWeight,
        availability: resolveAvailability(row, stock, value),
      };
    }),
    customization: row.customization.map((key) => customizationCatalog[key]).filter(Boolean),
    badges,
    featured: row.flags.featured,
    bestSeller: row.flags.bestSeller,
    trending: row.flags.trending,
    newArrival: row.flags.newArrival,
    seo: {
      ...row.seo,
      title: row.seo.title || `${row.name} — ${metalLabels[row.metal]} ${category.name}`,
      description: row.seo.description || `${row.shortDescription} ${purityLabels[row.purity]} ${metalLabels[row.metal].toLowerCase()}, ${variant.grossWeight} g.`,
    },
    published: true,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSummary(product: Product): ProductSummary {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    sku: product.sku,
    images: product.images,
    category: product.category,
    collections: product.collections,
    metal: product.metal,
    purity: product.purity,
    gender: product.gender,
    grossWeight: product.grossWeight,
    netWeight: product.netWeight,
    makingCharges: product.makingCharges,
    discount: product.discount,
    finalPrice: product.finalPrice,
    pricing: product.pricing,
    availability: product.availability,
    stockStatus: product.stockStatus,
    sizes: product.sizes,
    defaultSize: product.defaultSize,
    customization: product.customization,
    badges: product.badges,
    createdAt: product.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* Snapshot loading & cache                                            */
/* ------------------------------------------------------------------ */

async function loadSnapshot(): Promise<CatalogSnapshot> {
  const executor = db();
  const inventorySettings = await getSetting("inventory", executor);
  const productRows = await executor
    .select()
    .from(products)
    .where(and(eq(products.status, "active"), isNull(products.deletedAt)));
  const categoryRows = await executor.select().from(categories).where(eq(categories.active, true)).orderBy(asc(categories.displayOrder));
  const subRows = await executor.select().from(subcategories).where(eq(subcategories.active, true)).orderBy(asc(subcategories.displayOrder));
  const collectionRows = await executor.select().from(collections).where(eq(collections.active, true)).orderBy(asc(collections.displayOrder));
  const links = await executor.select().from(productCollections);
  const levels = await executor
    .select({ productId: inventoryLevels.productId, quantity: inventoryLevels.quantity })
    .from(inventoryLevels)
    .where(eq(inventoryLevels.locationId, inventorySettings.onlineFulfilmentLocationId));
  const pricing = await loadPricingContext(executor);

  const categoryById = new Map(categoryRows.map((c) => [c.id, c]));
  const subById = new Map(subRows.map((s) => [s.id, s]));
  const collectionById = new Map(collectionRows.map((c) => [c.id, c]));
  const stockById = new Map(levels.map((l) => [l.productId, l.quantity]));
  const collectionsByProduct = new Map<string, CollectionRow[]>();
  for (const link of links) {
    const collection = collectionById.get(link.collectionId);
    if (!collection) continue;
    const list = collectionsByProduct.get(link.productId) ?? [];
    list.push(collection);
    collectionsByProduct.set(link.productId, list);
  }

  const entries: CatalogEntry[] = [];
  for (const row of productRows) {
    const category = categoryById.get(row.categoryId);
    if (!category) continue;
    const productCollectionRows = (collectionsByProduct.get(row.id) ?? []).sort((a, b) => a.displayOrder - b.displayOrder);
    const subcategory = row.subcategoryId ? (subById.get(row.subcategoryId) ?? null) : null;
    const stock = stockById.get(row.id) ?? 0;
    try {
      const product = buildProduct(row, category, subcategory, productCollectionRows, stock, pricing);
      entries.push({ row, category, subcategory, collections: productCollectionRows, stock, product, summary: toSummary(product) });
    } catch (error) {
      if (error instanceof MissingRateError) {
        logger.warn({ sku: row.sku }, `Product hidden from storefront: ${error.message}`);
        continue;
      }
      throw error;
    }
  }

  const categoriesDto: Category[] = categoryRows.map((category) => ({
    id: category.id,
    slug: category.slug,
    name: category.name,
    ...(category.shortName ? { shortName: category.shortName } : {}),
    description: category.description,
    image: category.image,
    group: category.group,
    subcategories: subRows
      .filter((s) => s.categoryId === category.id)
      .map((s) => ({ id: s.id, slug: s.slug, name: s.name, categoryId: s.categoryId })),
    seo: category.seo,
    displayOrder: category.displayOrder,
    active: category.active,
  }));

  const collectionsDto: Collection[] = collectionRows.map((collection) => ({
    id: collection.id,
    slug: collection.slug,
    name: collection.name,
    ...(collection.eyebrow ? { eyebrow: collection.eyebrow } : {}),
    description: collection.description,
    image: collection.image,
    ...(collection.mobileImage ? { mobileImage: collection.mobileImage } : {}),
    seo: collection.seo,
    displayOrder: collection.displayOrder,
    active: collection.active,
  }));

  return {
    entries,
    byId: new Map(entries.map((e) => [e.row.id, e])),
    bySlug: new Map(entries.map((e) => [e.row.slug, e])),
    categories: categoriesDto,
    categoryRows,
    collections: collectionsDto,
    pricing,
  };
}

/** Short TTL bounds staleness across multiple API instances; admin writes invalidate immediately. */
const TTL_MS = 30_000;
let cached: { promise: Promise<CatalogSnapshot>; at: number } | null = null;

export function invalidateCatalog() {
  cached = null;
}

/** Customer-safe catalogue. Pass `fresh` for checkout and payment, where stock and price must be current. */
export function catalog({ fresh = false } = {}): Promise<CatalogSnapshot> {
  if (fresh || !cached || Date.now() - cached.at > TTL_MS) {
    const promise = loadSnapshot();
    cached = { promise, at: Date.now() };
    promise.catch(() => {
      if (cached?.promise === promise) cached = null;
    });
    return promise;
  }
  return cached.promise;
}

export function findEntry(snapshot: CatalogSnapshot, idOrSlug: string | undefined) {
  if (!idOrSlug) return undefined;
  return snapshot.byId.get(idOrSlug) ?? snapshot.bySlug.get(idOrSlug);
}
