import { Router } from "express";
import { z } from "zod";
import type { ProductFilters } from "@/contracts/storefront";
import { notFound } from "@/lib/errors";
import { parse } from "@/lib/validation";
import { GENDERS, METALS, PURITIES } from "./labels";
import {
  categoriesWithCounts,
  compareProducts,
  listMerchandised,
  listProducts,
  productPrice,
  relatedProducts,
  searchSuggestions,
} from "./listing";
import { catalog, findEntry } from "./snapshot";

/** Tolerant list parsing — unknown values are ignored, like the storefront URL parser. */
const csvOf = <T extends string>(allowed?: readonly T[]) =>
  z.preprocess(
    (value) =>
      typeof value === "string"
        ? value
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part && part.length <= 80 && (!allowed || (allowed as readonly string[]).includes(part)))
        : undefined,
    z.array(z.string()).optional(),
  ) as z.ZodType<T[] | undefined>;

const optionalNumber = z.coerce.number().min(0).optional().catch(undefined);
const flag = z.preprocess((value) => (value === "true" ? true : undefined), z.literal(true).optional());

const filtersSchema = z.object({
  base: z.string().max(80).optional().catch(undefined),
  category: csvOf(),
  sub: z.string().max(80).optional().catch(undefined),
  collection: z.string().max(80).optional().catch(undefined),
  metal: csvOf(METALS),
  purity: csvOf(PURITIES),
  gender: csvOf(GENDERS),
  size: csvOf(),
  inStock: flag,
  new: flag,
  best: flag,
  minPrice: optionalNumber,
  maxPrice: optionalNumber,
  minWeight: optionalNumber,
  maxWeight: optionalNumber,
  q: z
    .string()
    .trim()
    .transform((value) => value.slice(0, 80) || undefined)
    .optional()
    .catch(undefined),
  sort: z.enum(["featured", "newest", "price_asc", "price_desc", "best_selling", "trending", "most_viewed"]).optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
  pageSize: z.coerce.number().int().min(1).max(48).optional().catch(undefined),
});

const limitSchema = z.coerce.number().int().min(1).max(48).catch(10);

export const catalogRouter = Router();

/** Public catalogue responses can be cached briefly by CDNs and Next.js. */
catalogRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  next();
});

catalogRouter.get("/products", async (req, res) => {
  const { new: newArrival, best: bestSeller, ...rest } = parse(filtersSchema, req.query);
  const filters: ProductFilters = { ...rest, newArrival, bestSeller };
  res.json(listProducts(await catalog(), filters));
});

catalogRouter.get("/products/slugs", async (_req, res) => {
  const snapshot = await catalog();
  res.json(snapshot.entries.map((e) => ({ slug: e.row.slug, updatedAt: e.row.updatedAt.toISOString() })));
});

catalogRouter.get("/products/merchandising", async (req, res) => {
  const query = parse(
    z.object({
      kind: z.enum(["featured", "bestSeller", "trending", "newArrival"]).optional().catch(undefined),
      metal: z.enum(METALS).optional().catch(undefined),
      collection: z.string().max(80).optional().catch(undefined),
      limit: limitSchema,
    }),
    req.query,
  );
  res.json(listMerchandised(await catalog(), query));
});

catalogRouter.get("/products/compare", async (req, res) => {
  const { ids } = parse(z.object({ ids: csvOf() }), req.query);
  res.json(compareProducts(await catalog(), (ids ?? []).slice(0, 4)));
});

catalogRouter.get("/products/:idOrSlug/related", async (req, res) => {
  res.json(relatedProducts(await catalog(), req.params.idOrSlug, parse(z.object({ limit: limitSchema }), req.query).limit));
});

catalogRouter.get("/products/:idOrSlug/price", async (req, res) => {
  const { size } = parse(z.object({ size: z.string().max(20).optional() }), req.query);
  res.setHeader("Cache-Control", "no-store");
  res.json(productPrice(await catalog(), req.params.idOrSlug, size));
});

catalogRouter.get("/products/:slug", async (req, res) => {
  const entry = findEntry(await catalog(), req.params.slug);
  if (!entry) throw notFound();
  res.json(entry.product);
});

catalogRouter.get("/search/suggestions", async (req, res) => {
  const { q } = parse(z.object({ q: z.string().max(80).default("") }), req.query);
  res.json(searchSuggestions(await catalog(), q));
});

catalogRouter.get("/categories", async (_req, res) => {
  res.json(categoriesWithCounts(await catalog()));
});

catalogRouter.get("/categories/:slug", async (req, res) => {
  const category = categoriesWithCounts(await catalog()).find((c) => c.slug === req.params.slug);
  if (!category) throw notFound();
  res.json(category);
});

catalogRouter.get("/collections", async (_req, res) => {
  res.json((await catalog()).collections);
});

catalogRouter.get("/collections/:slug", async (req, res) => {
  const collection = (await catalog()).collections.find((c) => c.slug === req.params.slug);
  if (!collection) throw notFound();
  res.json(collection);
});
