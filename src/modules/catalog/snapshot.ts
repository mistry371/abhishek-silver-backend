import { and, asc, eq, isNull } from "drizzle-orm";
import type { ImageAsset, ProductDiscount, SeoMeta } from "@/contracts/common";
import type {
  Category,
  Collection,
  InventoryAvailability,
  Product,
  ProductBadge,
  ProductParentSummary,
  ProductSummary,
  ProductVariant,
  TaxonomyRef,
} from "@/contracts/storefront";
import { db } from "@/db/client";
import { categories, collections, inventoryLevels, parentProductCollections, parentProducts, productCollections, products, subcategories } from "@/db/schema";
import { logger } from "@/lib/logger";
import { round2 } from "@/lib/money";
import { loadPricingContext, priceProduct, type PriceableProduct, type PricingContext } from "@/modules/pricing/context";
import { MissingRateError } from "@/modules/pricing/engine";
import { getSetting } from "@/services/settings";
import { customizationCatalog, metalLabels, purityLabels, sizeLabel, variantLabelOf } from "./labels";

export type ProductRow = typeof products.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type SubcategoryRow = typeof subcategories.$inferSelect;
export type CollectionRow = typeof collections.$inferSelect;
export type ParentRow = typeof parentProducts.$inferSelect;

export interface CatalogEntry {
  row: ProductRow;
  /** Displayed category — the parent's when the product is a variant of an active parent. Filters act on it. */
  category: CategoryRow;
  subcategory: SubcategoryRow | null;
  /** The product's OWN collections. Pricing (collection offers) uses these, so a parent never changes a price. */
  collections: CollectionRow[];
  /** Displayed collections — the parent's for a variant of an active parent. Filters act on these. */
  displayCollections: CollectionRow[];
  /** The ACTIVE parent this product is a variant of (a draft parent changes nothing). */
  parent: ParentRow | null;
  /** Units at the online fulfilment location. Internal only — never serialised. */
  stock: number;
  product: Product;
  summary: ProductSummary;
}

/** An active parent product and its active variants. */
export interface ParentGroup {
  row: ParentRow;
  /** Active variants in the parent's display order. Never empty. */
  variants: CatalogEntry[];
  /** The default variant when it is active, otherwise the first active variant. */
  primary: CatalogEntry;
}

export interface CatalogSnapshot {
  entries: CatalogEntry[];
  byId: Map<string, CatalogEntry>;
  bySlug: Map<string, CatalogEntry>;
  parents: Map<string, ParentGroup>;
  parentsBySlug: Map<string, ParentGroup>;
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

/** What the website shows for a product: its own details, or its active parent's shared ones. */
interface Presentation {
  name: string;
  shortDescription: string;
  description: string;
  images: ImageAsset[];
  seo: SeoMeta;
  category: CategoryRow;
  subcategory: SubcategoryRow | null;
  collections: CollectionRow[];
}

interface ParentPresentation {
  row: ParentRow;
  category: CategoryRow;
  subcategory: SubcategoryRow | null;
  collections: CollectionRow[];
}

function presentationOf(row: ProductRow, own: Pick<Presentation, "category" | "subcategory" | "collections">, parent: ParentPresentation | null): Presentation {
  if (!parent) {
    return { name: row.name, shortDescription: row.shortDescription, description: row.description, images: row.images, seo: row.seo, ...own };
  }
  return {
    name: parent.row.name,
    shortDescription: parent.row.shortDescription,
    description: parent.row.description,
    // A variant's own photos win; the parent's photos cover variants without any.
    images: row.images.length ? row.images : parent.row.images,
    seo: parent.row.seo,
    category: parent.category,
    subcategory: parent.subcategory,
    collections: parent.collections,
  };
}

function buildProduct(row: ProductRow, shown: Presentation, pricingCollections: CollectionRow[], stock: number, context: PricingContext): Product {
  const { category, subcategory } = shown;
  const { variant, pricing, discount } = priceEntry({ row, collections: pricingCollections }, context);
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
    name: shown.name,
    slug: row.slug,
    sku: row.sku,
    shortDescription: shown.shortDescription,
    description: shown.description,
    images: shown.images,
    video: row.video ?? null,
    category: ref(category),
    subcategory: subcategory ? ref(subcategory) : null,
    collections: shown.collections.map(ref),
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
    // Filled in by `groupVariants` for variants of an active parent.
    parent: null,
    variants: [],
    customization: row.customization.map((key) => customizationCatalog[key]).filter(Boolean),
    badges,
    featured: row.flags.featured,
    bestSeller: row.flags.bestSeller,
    trending: row.flags.trending,
    newArrival: row.flags.newArrival,
    seo: {
      ...shown.seo,
      title: shown.seo.title || `${shown.name} — ${metalLabels[row.metal]} ${category.name}`,
      description: shown.seo.description || `${shown.shortDescription} ${purityLabels[row.purity]} ${metalLabels[row.metal].toLowerCase()}, ${variant.grossWeight} g.`,
    },
    published: true,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSummary(product: Product, parent: ProductParentSummary | null = null): ProductSummary {
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
    parent,
  };
}

/**
 * Groups the variants of each active parent, then gives every variant its
 * parent reference, the ordered variant list and the card's price range.
 */
function groupVariants(entries: CatalogEntry[]): Map<string, ParentGroup> {
  const members = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    if (!entry.parent) continue;
    const list = members.get(entry.parent.id) ?? [];
    list.push(entry);
    members.set(entry.parent.id, list);
  }

  const groups = new Map<string, ParentGroup>();
  for (const list of members.values()) {
    const row = list[0]!.parent!;
    const variants = list.sort((a, b) => a.row.variantOrder - b.row.variantOrder || a.row.sku.localeCompare(b.row.sku));
    const primary = variants.find((v) => v.row.id === row.defaultVariantId) ?? variants[0]!;
    const prices = variants.map((v) => v.product.finalPrice);
    const summary: ProductParentSummary = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      variantCount: variants.length,
      priceFrom: Math.min(...prices),
      priceTo: Math.max(...prices),
    };
    const options: ProductVariant[] = variants.map((v) => ({
      id: v.row.id,
      slug: v.row.slug,
      sku: v.row.sku,
      label: variantLabelOf(v.row),
      metal: v.row.metal,
      purity: v.row.purity,
      price: v.product.finalPrice,
      availability: v.product.availability,
      image: v.product.images[0] ?? null,
    }));
    for (const variant of variants) {
      variant.product.parent = { id: row.id, slug: row.slug, name: row.name };
      variant.product.variants = options;
      variant.summary = toSummary(variant.product, summary);
    }
    groups.set(row.id, { row, variants, primary });
  }
  return groups;
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
  const parentRows = await executor.select().from(parentProducts).where(eq(parentProducts.status, "active"));
  const parentLinks = parentRows.length ? await executor.select().from(parentProductCollections) : [];
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

  const byDisplayOrder = (a: CollectionRow, b: CollectionRow) => a.displayOrder - b.displayOrder;
  /** Active parents; `category` is undefined while the parent's category is inactive. */
  const parentById = new Map(
    parentRows.map((row) => [
      row.id,
      {
        row,
        category: categoryById.get(row.categoryId),
        subcategory: row.subcategoryId ? (subById.get(row.subcategoryId) ?? null) : null,
        collections: parentLinks
          .filter((link) => link.parentId === row.id)
          .map((link) => collectionById.get(link.collectionId))
          .filter((c): c is CollectionRow => Boolean(c))
          .sort(byDisplayOrder),
      },
    ]),
  );

  const entries: CatalogEntry[] = [];
  for (const row of productRows) {
    const parentInfo = row.parentId ? parentById.get(row.parentId) : undefined;
    const ownCategory = categoryById.get(row.categoryId);
    let parent: ParentPresentation | null = null;
    if (parentInfo) {
      // A variant shows under its parent's category; like any product, it is hidden while that category is inactive.
      if (!parentInfo.category) continue;
      parent = { ...parentInfo, category: parentInfo.category };
    } else if (!ownCategory) continue;
    const productCollectionRows = (collectionsByProduct.get(row.id) ?? []).sort(byDisplayOrder);
    const ownSubcategory = row.subcategoryId ? (subById.get(row.subcategoryId) ?? null) : null;
    const shown = presentationOf(row, { category: ownCategory!, subcategory: ownSubcategory, collections: productCollectionRows }, parent);
    const stock = stockById.get(row.id) ?? 0;
    try {
      const product = buildProduct(row, shown, productCollectionRows, stock, pricing);
      entries.push({
        row,
        category: shown.category,
        subcategory: shown.subcategory,
        collections: productCollectionRows,
        displayCollections: shown.collections,
        parent: parent?.row ?? null,
        stock,
        product,
        summary: toSummary(product),
      });
    } catch (error) {
      if (error instanceof MissingRateError) {
        logger.warn({ sku: row.sku }, `Product hidden from storefront: ${error.message}`);
        continue;
      }
      throw error;
    }
  }

  const parents = groupVariants(entries);

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
    parents,
    parentsBySlug: new Map([...parents.values()].map((group) => [group.row.slug, group])),
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

/** By product id or slug; a parent product's slug resolves to its default (or first) active variant. */
export function findEntry(snapshot: CatalogSnapshot, idOrSlug: string | undefined) {
  if (!idOrSlug) return undefined;
  return snapshot.byId.get(idOrSlug) ?? snapshot.bySlug.get(idOrSlug) ?? snapshot.parentsBySlug.get(idOrSlug)?.primary;
}

/** Listing key: the variants of one active parent share a key, so the parent counts once. */
export const groupKey = (entry: CatalogEntry) => entry.parent?.id ?? entry.row.id;

/**
 * Collapses an ordered list so each active parent appears once, represented by
 * its default variant when that is in the list, otherwise by the first of its
 * variants in the list. The representative keeps its own position.
 */
export function collapseVariants(snapshot: CatalogSnapshot, ordered: CatalogEntry[]): CatalogEntry[] {
  const present = new Set(ordered.map((e) => e.row.id));
  const chosen = new Map<string, string>();
  for (const entry of ordered) {
    if (!entry.parent || chosen.has(entry.parent.id)) continue;
    const defaultId = snapshot.parents.get(entry.parent.id)?.row.defaultVariantId;
    chosen.set(entry.parent.id, defaultId && present.has(defaultId) ? defaultId : entry.row.id);
  }
  return ordered.filter((entry) => !entry.parent || chosen.get(entry.parent.id) === entry.row.id);
}
