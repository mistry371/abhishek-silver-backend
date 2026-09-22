import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type {
  CategoryGroup,
  CategoryListingRule,
  CustomizationKey,
  Gender,
  ImageAsset,
  MakingChargeType,
  MerchandisingFlags,
  MetalType,
  ParentProductStatus,
  ProductDiscount,
  ProductStatus,
  PurityCode,
  SeoMeta,
  SizingType,
  VideoAsset,
} from "@/contracts/common";
import { createdAt, decimal, money, updatedAt, weight } from "./common";
import { vendors } from "./purchasing";

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  shortName: text("short_name"),
  description: text("description").notNull().default(""),
  image: jsonb("image").$type<ImageAsset>().notNull(),
  group: text("group").$type<CategoryGroup>().notNull(),
  /** For non-"type" groups (metal, audience, service): which products the landing page lists. */
  listingRule: jsonb("listing_rule").$type<CategoryListingRule | null>(),
  seo: jsonb("seo").$type<SeoMeta>().notNull().default({}),
  displayOrder: integer("display_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const subcategories = pgTable(
  "subcategories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("subcategories_category_slug_idx").on(t.categoryId, t.slug)],
);

export const collections = pgTable("collections", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  eyebrow: text("eyebrow"),
  description: text("description").notNull().default(""),
  image: jsonb("image").$type<ImageAsset>().notNull(),
  mobileImage: jsonb("mobile_image").$type<ImageAsset | null>(),
  seo: jsonb("seo").$type<SeoMeta>().notNull().default({}),
  displayOrder: integer("display_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    sku: text("sku").notNull().unique(),
    barcode: text("barcode").unique(),
    name: text("name").notNull(),
    shortDescription: text("short_description").notNull().default(""),
    description: text("description").notNull().default(""),

    /** Jewellery-type category (group = "type"). */
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    subcategoryId: uuid("subcategory_id").references(() => subcategories.id, { onDelete: "set null" }),

    metal: text("metal").$type<MetalType>().notNull(),
    purity: text("purity").$type<PurityCode>().notNull(),
    gender: text("gender").$type<Gender>().notNull().default("unisex"),

    netWeight: weight("net_weight").notNull(),
    /** Only set when non-metal components (beads, stringing) add weight beyond metal + stones. */
    grossWeight: weight("gross_weight"),
    stoneWeight: weight("stone_weight"),
    stoneDetails: text("stone_details"),

    makingType: text("making_type").$type<MakingChargeType>().notNull(),
    makingValue: decimal("making_value").notNull(),
    stoneCharges: money("stone_charges").notNull().default(0),
    otherCharges: money("other_charges").notNull().default(0),
    discount: jsonb("discount").$type<ProductDiscount | null>(),

    sizing: text("sizing").$type<SizingType | null>(),
    /** Sizes offered, in display order, e.g. ["10", "12", "14"]. */
    sizeOptions: jsonb("size_options").$type<string[]>().notNull().default([]),
    /** Size the listed price and `netWeight` refer to. */
    defaultSize: text("default_size"),
    /** Net metal weight (g) per size, entered by staff. Sizes without an entry use `netWeight`. */
    sizeWeights: jsonb("size_weights").$type<Record<string, number>>().notNull().default({}),
    unavailableSizes: jsonb("unavailable_sizes").$type<string[]>().notNull().default([]),
    customization: jsonb("customization").$type<CustomizationKey[]>().notNull().default([]),

    images: jsonb("images").$type<ImageAsset[]>().notNull().default([]),
    video: jsonb("video").$type<VideoAsset | null>(),
    flags: jsonb("flags")
      .$type<MerchandisingFlags>()
      .notNull()
      .default({ featured: false, bestSeller: false, trending: false, newArrival: false, limited: false }),
    status: text("status").$type<ProductStatus>().notNull().default("draft"),
    seo: jsonb("seo").$type<SeoMeta>().notNull().default({}),

    /* ---- Confidential (admin-only; never in public responses) ---- */
    purchasePrice: money("purchase_price"),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    lowStockThreshold: integer("low_stock_threshold").notNull().default(2),
    /** Optimistic-concurrency version bumped on every stock movement. */
    stockVersion: integer("stock_version").notNull().default(0),

    /* ---- Parent product (one design with variants) ---- */
    /** The design this product is a variant of. A product belongs to at most one parent. */
    parentId: uuid("parent_id").references((): AnyPgColumn => parentProducts.id, { onDelete: "set null" }),
    /** Custom variant label; when null the label is "<purity> <metal>", e.g. "22K Gold". */
    variantCustomLabel: text("variant_label"),
    /** Position among the parent's variants (ascending). */
    variantOrder: integer("variant_order").notNull().default(0),

    salesCount: integer("sales_count").notNull().default(0),
    viewsCount: integer("views_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("products_category_idx").on(t.categoryId),
    index("products_status_idx").on(t.status),
    index("products_metal_purity_idx").on(t.metal, t.purity),
    index("products_parent_idx").on(t.parentId),
  ],
);

/**
 * One jewellery design sold in several variants (e.g. 22K gold and 925 silver).
 * Variants are ordinary products (own SKU, stock and price); the parent only
 * holds the shared presentation. Deleting a parent never deletes products.
 */
export const parentProducts = pgTable(
  "parent_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    shortDescription: text("short_description").notNull().default(""),
    description: text("description").notNull().default(""),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    subcategoryId: uuid("subcategory_id").references(() => subcategories.id, { onDelete: "set null" }),
    images: jsonb("images").$type<ImageAsset[]>().notNull().default([]),
    seo: jsonb("seo").$type<SeoMeta>().notNull().default({}),
    status: text("status").$type<ParentProductStatus>().notNull().default("draft"),
    defaultVariantId: uuid("default_variant_id").references((): AnyPgColumn => products.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("parent_products_status_idx").on(t.status)],
);

export const parentProductCollections = pgTable(
  "parent_product_collections",
  {
    parentId: uuid("parent_id")
      .notNull()
      .references(() => parentProducts.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.parentId, t.collectionId] })],
);

export const productCollections = pgTable(
  "product_collections",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.productId, t.collectionId] })],
);
