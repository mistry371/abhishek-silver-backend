import type {
  Category,
  ComparisonItem,
  FacetOption,
  Product,
  ProductFacets,
  ProductFilters,
  ProductListResponse,
  ProductPriceResponse,
  ProductSummary,
  SearchSuggestions,
  SortOption,
} from "@/contracts/storefront";
import { AppError, notFound } from "@/lib/errors";
import { GENDERS, genderLabels, METALS, metalLabels, PURITIES, purityFineness, purityLabels, sizeLabel } from "./labels";
import { findEntry, priceEntry, resolveAvailability, type CatalogEntry, type CatalogSnapshot, type CategoryRow } from "./snapshot";

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function matchesBase(entry: CatalogEntry, base: CategoryRow | undefined) {
  if (!base) return true;
  if (base.group === "type") return entry.row.categoryId === base.id;
  const rule = base.listingRule;
  if (!rule || (!rule.metal && !rule.genders?.length && !rule.customizable)) return false;
  if (rule.metal && entry.row.metal !== rule.metal) return false;
  if (rule.genders?.length && !rule.genders.includes(entry.row.gender)) return false;
  if (rule.customizable && entry.row.customization.length === 0) return false;
  return true;
}

function searchHaystack(product: Product) {
  return [
    product.name,
    product.sku,
    product.category.name,
    product.subcategory?.name,
    ...product.collections.map((c) => c.name),
    metalLabels[product.metal],
    `${metalLabels[product.metal]} jewellery`,
    purityLabels[product.purity],
    product.purity,
    String(purityFineness[product.purity]),
    genderLabels[product.gender],
    product.gender === "men" || product.gender === "unisex" ? "mens men's" : "",
    product.gender === "women" || product.gender === "unisex" ? "womens women's" : "",
  ]
    .join(" ")
    .toLowerCase();
}

function matchesQuery(product: Product, query: string) {
  const haystack = searchHaystack(product);
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function matchesGender(product: Product, genders: string[]) {
  if (genders.includes(product.gender)) return true;
  return product.gender === "unisex" && genders.some((g) => g === "men" || g === "women");
}

function facetFrom<T extends string>(
  entries: CatalogEntry[],
  values: readonly T[],
  getValues: (entry: CatalogEntry) => string[],
  label: (value: T) => string,
): FacetOption[] {
  return values
    .map((value) => ({ value, label: label(value), count: entries.filter((e) => getValues(e).includes(value)).length }))
    .filter((option) => option.count > 0);
}

function buildFacets(snapshot: CatalogSnapshot, scoped: CatalogEntry[], filters: ProductFilters): ProductFacets {
  const typeScoped = filters.category?.length ? scoped.filter((e) => filters.category!.includes(e.product.category.slug)) : scoped;
  const sizingTypes = new Set(typeScoped.map((e) => e.row.sizing).filter(Boolean));
  const sizes: FacetOption[] = [];
  if (sizingTypes.size === 1) {
    const sizing = [...sizingTypes][0]!;
    const values = [...new Set(typeScoped.flatMap((e) => e.row.sizeOptions))].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    for (const value of values) {
      const count = typeScoped.filter((e) => e.product.sizes.some((s) => s.value === value && s.available)).length;
      if (count > 0) sizes.push({ value, label: sizeLabel(sizing, value), count });
    }
  }

  const typeCategories = snapshot.categoryRows.filter((c) => c.group === "type");
  const prices = scoped.map((e) => e.product.finalPrice);
  const weights = scoped.map((e) => e.product.grossWeight);

  return {
    categories: facetFrom(
      scoped,
      typeCategories.map((c) => c.slug),
      (e) => [e.product.category.slug],
      (slug) => typeCategories.find((c) => c.slug === slug)?.name ?? slug,
    ),
    metals: facetFrom(scoped, METALS, (e) => [e.row.metal], (v) => metalLabels[v]),
    purities: facetFrom(scoped, PURITIES, (e) => [e.row.purity], (v) => purityLabels[v]),
    genders: facetFrom(scoped, GENDERS, (e) => [e.row.gender], (v) => genderLabels[v]),
    sizes,
    collections: facetFrom(
      scoped,
      snapshot.collections.map((c) => c.slug),
      (e) => e.product.collections.map((c) => c.slug),
      (slug) => snapshot.collections.find((c) => c.slug === slug)?.name ?? slug,
    ),
    price: { min: prices.length ? Math.min(...prices) : 0, max: prices.length ? Math.max(...prices) : 0 },
    weight: { min: weights.length ? Math.min(...weights) : 0, max: weights.length ? Math.max(...weights) : 0 },
  };
}

export function sortEntries(list: CatalogEntry[], sort: SortOption) {
  const sorted = [...list];
  switch (sort) {
    case "newest":
      return sorted.sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime());
    case "price_asc":
      return sorted.sort((a, b) => a.product.finalPrice - b.product.finalPrice);
    case "price_desc":
      return sorted.sort((a, b) => b.product.finalPrice - a.product.finalPrice);
    case "best_selling":
      return sorted.sort((a, b) => b.row.salesCount - a.row.salesCount);
    case "trending":
      return sorted.sort((a, b) => Number(b.product.trending) - Number(a.product.trending) || b.row.viewsCount - a.row.viewsCount);
    case "most_viewed":
      return sorted.sort((a, b) => b.row.viewsCount - a.row.viewsCount);
    default:
      return sorted.sort(
        (a, b) =>
          Number(b.product.availability.purchasable) - Number(a.product.availability.purchasable) ||
          Number(b.product.featured) - Number(a.product.featured) ||
          Number(b.product.bestSeller) - Number(a.product.bestSeller) ||
          b.row.salesCount - a.row.salesCount,
      );
  }
}

export function listProducts(snapshot: CatalogSnapshot, filters: ProductFilters): ProductListResponse {
  const base = filters.base ? snapshot.categoryRows.find((c) => c.slug === filters.base) : undefined;
  if (filters.base && !base) throw notFound();

  const scoped = snapshot.entries.filter(
    (e) =>
      matchesBase(e, base) &&
      (!filters.collection || e.product.collections.some((c) => c.slug === filters.collection)) &&
      (!filters.q || matchesQuery(e.product, filters.q)),
  );
  const facets = buildFacets(snapshot, scoped, filters);

  const filtered = scoped.filter(({ product: p }) => {
    if (filters.category?.length && !filters.category.includes(p.category.slug)) return false;
    if (filters.sub && p.subcategory?.slug !== filters.sub) return false;
    if (filters.metal?.length && !filters.metal.includes(p.metal)) return false;
    if (filters.purity?.length && !filters.purity.includes(p.purity)) return false;
    if (filters.gender?.length && !matchesGender(p, filters.gender)) return false;
    if (filters.size?.length && !p.sizes.some((s) => filters.size!.includes(s.value) && s.available)) return false;
    if (filters.inStock && !p.availability.purchasable) return false;
    if (filters.newArrival && !p.newArrival) return false;
    if (filters.bestSeller && !p.bestSeller) return false;
    if (filters.minPrice !== undefined && p.finalPrice < filters.minPrice) return false;
    if (filters.maxPrice !== undefined && p.finalPrice > filters.maxPrice) return false;
    if (filters.minWeight !== undefined && p.grossWeight < filters.minWeight) return false;
    if (filters.maxWeight !== undefined && p.grossWeight > filters.maxWeight) return false;
    return true;
  });

  const sorted = sortEntries(filtered, filters.sort ?? "featured");
  const pageSize = clamp(filters.pageSize ?? 12, 1, 48);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = clamp(filters.page ?? 1, 1, totalPages);

  return {
    items: sorted.slice((page - 1) * pageSize, page * pageSize).map((e) => e.summary),
    total: sorted.length,
    page,
    pageSize,
    totalPages,
    facets,
  };
}

export type MerchandisingKind = "featured" | "bestSeller" | "trending" | "newArrival";

export function listMerchandised(
  snapshot: CatalogSnapshot,
  { kind, metal, collection, limit }: { kind?: MerchandisingKind; metal?: "gold" | "silver"; collection?: string; limit: number },
): ProductSummary[] {
  let list = snapshot.entries;
  let sort: SortOption = "featured";
  if (kind) {
    list = list.filter((e) => e.product[kind]);
    sort = ({ featured: "featured", bestSeller: "best_selling", trending: "most_viewed", newArrival: "newest" } as const)[kind];
  }
  if (metal) list = list.filter((e) => e.row.metal === metal && e.product.availability.purchasable);
  if (collection) list = list.filter((e) => e.product.collections.some((c) => c.slug === collection));
  return sortEntries(list, sort)
    .slice(0, limit)
    .map((e) => e.summary);
}

export function relatedProducts(snapshot: CatalogSnapshot, idOrSlug: string, limit: number): ProductSummary[] {
  const source = findEntry(snapshot, idOrSlug);
  if (!source) return [];
  const sourceCollections = new Set(source.collections.map((c) => c.id));
  return snapshot.entries
    .filter((e) => e.row.id !== source.row.id && e.product.stockStatus !== "out_of_stock")
    .map((e) => ({
      entry: e,
      score:
        (e.row.categoryId === source.row.categoryId ? 3 : 0) +
        e.collections.filter((c) => sourceCollections.has(c.id)).length +
        (e.row.metal === source.row.metal ? 1 : 0),
    }))
    .filter((item) => item.score > 1)
    .sort((a, b) => b.score - a.score || b.entry.row.salesCount - a.entry.row.salesCount)
    .slice(0, limit)
    .map((item) => item.entry.summary);
}

export function categoriesWithCounts(snapshot: CatalogSnapshot): Category[] {
  return snapshot.categories.map((category) => {
    const row = snapshot.categoryRows.find((c) => c.id === category.id);
    return { ...category, productCount: snapshot.entries.filter((e) => matchesBase(e, row)).length };
  });
}

export function productPrice(snapshot: CatalogSnapshot, idOrSlug: string, size?: string): ProductPriceResponse {
  const entry = findEntry(snapshot, idOrSlug);
  if (!entry) throw notFound();
  if (size && entry.row.sizeOptions.length && !entry.row.sizeOptions.includes(size)) {
    throw new AppError("validation_error", "Please choose a valid size.");
  }
  const { variant, pricing } = priceEntry(entry, snapshot.pricing, size);
  return {
    productId: entry.row.id,
    ...(variant.size ? { size: variant.size } : {}),
    pricing,
    availability: resolveAvailability(entry.row, entry.stock, variant.size),
    grossWeight: variant.grossWeight,
    netWeight: variant.netWeight,
  };
}

export function searchSuggestions(snapshot: CatalogSnapshot, query: string): SearchSuggestions {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2) return { query, products: [], categories: [], collections: [], total: 0 };

  const matches = sortEntries(
    snapshot.entries.filter((e) => matchesQuery(e.product, normalized)),
    "featured",
  );
  const tokens = normalized.split(/\s+/);
  const categories = categoriesWithCounts(snapshot)
    .filter((c) => tokens.some((t) => c.name.toLowerCase().includes(t)))
    .slice(0, 4)
    .map((c) => ({ label: c.name, href: `/shop/${c.slug}`, meta: `${c.productCount ?? 0} pieces` }));
  const collections = snapshot.collections
    .filter((c) => tokens.some((t) => c.name.toLowerCase().includes(t)))
    .slice(0, 3)
    .map((c) => ({ label: c.name, href: `/collection/${c.slug}`, meta: "Collection" }));

  return { query, products: matches.slice(0, 6).map((e) => e.summary), categories, collections, total: matches.length };
}

export function compareProducts(snapshot: CatalogSnapshot, ids: string[]): ComparisonItem[] {
  return ids
    .map((id) => findEntry(snapshot, id))
    .filter((e): e is CatalogEntry => Boolean(e))
    .map(({ product }) => ({
      productId: product.id,
      slug: product.slug,
      name: product.name,
      image: product.images[0]!,
      sku: product.sku,
      metal: product.metal,
      purity: product.purity,
      grossWeight: product.grossWeight,
      netWeight: product.netWeight,
      makingCharges: product.makingCharges,
      finalPrice: product.finalPrice,
      availability: product.availability,
    }));
}
