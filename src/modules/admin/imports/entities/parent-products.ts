import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ImageAsset, SeoMeta } from "@/contracts/common";
import { categories, collections, parentProductCollections, parentProducts, products, subcategories } from "@/db/schema";
import { labelKey, variantLabelOf } from "@/modules/catalog/labels";
import { slugSchema } from "../../catalogue";
import { writeParentCollections, writeVariants, type VariantInput } from "../../parent-products";
import { slugify } from "../../variant-rules";
import { defineImport, type ImportColumn, type RowPlan } from "../types";
import { findNamed, same } from "./products";

/**
 * PARENT PRODUCT IMPORT
 * ------------------------------------------------------------------
 * One row per design. Matched on URL Slug (or, when that is blank, on the
 * exact name): an unknown one is created, a known one is updated with the
 * columns the row fills in. "Variant SKUs" replaces the whole variant set in
 * the order given; blank leaves the variants as they are.
 */

const columns: ImportColumn[] = [
  { key: "name", label: "Name", required: true, example: "Aaravi Filigree Band", example2: "Meera Studs", hint: "The design's name, shown for every variant. Up to 160 characters." },
  {
    key: "slug",
    label: "URL Slug",
    example: "aaravi-filigree-band",
    example2: "",
    hint: "Optional. Identifies the parent product; an existing slug updates it. Blank matches on the name, or makes a slug from it. Must not be used by any product.",
  },
  { key: "category", label: "Category", required: true, field: "categoryId", example: "Rings", example2: "Earrings", hint: "The jewellery type, by name or URL slug (Rings, Earrings, Necklaces…)." },
  { key: "subcategory", label: "Subcategory", field: "subcategoryId", example: "Bands", example2: "", hint: "Optional. Must belong to the category above." },
  { key: "collections", label: "Collections", field: "collectionIds", example: "Everyday Luxe", example2: "", hint: "Optional. Separate several collections with commas." },
  { key: "shortDescription", label: "Short Description", example: "A slender band with hand-finished filigree.", example2: "", hint: "Optional. Up to 300 characters, shown on listing pages." },
  { key: "description", label: "Description", example: "", example2: "", hint: "Optional. Up to 5,000 characters, shown on the product page." },
  { key: "images", label: "Image URLs", example: "", example2: "", hint: "Optional. Web links separated by commas. Used for variants that have no photos of their own." },
  { key: "seoTitle", label: "SEO Title", field: "seo", example: "", example2: "", hint: "Optional. Up to 160 characters." },
  { key: "seoDescription", label: "SEO Description", example: "", example2: "", hint: "Optional. Up to 320 characters." },
  { key: "status", label: "Status", example: "draft", example2: "active", hint: "active or draft. New parent products default to draft; only active ones change the website." },
  {
    key: "variantSkus",
    label: "Variant SKUs",
    field: "variants",
    example: "G22K-RG-2101, S925-RG-2101",
    example2: "",
    hint: "Optional. SKUs of the products that are variants of this design, separated by commas, in display order. Replaces the current variants; blank leaves them as they are.",
  },
  {
    key: "defaultVariantSku",
    label: "Default Variant SKU",
    field: "defaultVariantId",
    example: "G22K-RG-2101",
    example2: "",
    hint: "Optional. The variant shown first. Must be one of the variant SKUs. Blank keeps the current default, or uses the first variant.",
  },
];

interface Named {
  id: string;
  slug: string;
  name: string;
}

type ParentRow = typeof parentProducts.$inferSelect;

interface ParentState {
  categories: (Named & { group: string })[];
  subcategories: (Named & { categoryId: string })[];
  collections: Named[];
  parents: ParentRow[];
  /** Every product and parent slug, plus slugs planned by earlier rows. */
  slugs: Set<string>;
  /** Rows already planned in this file, by parent id or new slug. */
  parentRows: Map<string, number>;
  /** SKU → the row of this file that lists it as a variant. */
  skuRows: Map<string, number>;
}

interface ParentPlan extends RowPlan {
  parentId: string | null;
  values: Partial<typeof parentProducts.$inferInsert>;
  collectionIds: string[] | null;
  variants: VariantInput[] | null;
  /** Resolved default; undefined leaves it unchanged. */
  defaultVariantId: string | null | undefined;
}

export const parentProductImport = defineImport<ParentState, ParentPlan>({
  entity: "parent-products",
  label: "Parent products",
  description: "Group existing products into designs with variants (for example the same ring in 22K gold and 925 silver), matched on URL slug.",
  module: "products",
  permission: "products:create",
  revalidate: true,
  rowLimit: 500,
  columns,

  async prepare(ctx) {
    const [categoryRows, subcategoryRows, collectionRows, parentRows, productSlugs] = await Promise.all([
      ctx.ex.select({ id: categories.id, slug: categories.slug, name: categories.name, group: categories.group }).from(categories),
      ctx.ex.select({ id: subcategories.id, slug: subcategories.slug, name: subcategories.name, categoryId: subcategories.categoryId }).from(subcategories),
      ctx.ex.select({ id: collections.id, slug: collections.slug, name: collections.name }).from(collections),
      ctx.ex.select().from(parentProducts),
      ctx.ex.select({ slug: products.slug }).from(products),
    ]);
    return {
      categories: categoryRows,
      subcategories: subcategoryRows,
      collections: collectionRows,
      parents: parentRows,
      slugs: new Set([...productSlugs.map((r) => r.slug), ...parentRows.map((r) => r.slug)]),
      parentRows: new Map(),
      skuRows: new Map(),
    };
  },

  async plan(row, state, ctx) {
    const name = row.text("name", { required: true, max: 160 });
    const slugText = row.text("slug", { max: 160 })?.toLowerCase();
    if (slugText && !slugSchema.safeParse(slugText).success) row.error("slug", "Use lowercase letters, numbers and hyphens.");

    const existing = slugText
      ? (state.parents.find((p) => p.slug === slugText) ?? null)
      : name
        ? (state.parents.find((p) => same(p.name) === same(name)) ?? null)
        : null;
    if (slugText && !existing && state.slugs.has(slugText)) row.error("slug", "This URL slug is already used by a product or another row of this file.");

    const rowKey = existing?.id ?? slugText ?? (name ? `name:${same(name)}` : "");
    if (rowKey) {
      const seen = state.parentRows.get(rowKey);
      if (seen) row.error(slugText ? "slug" : "name", `This parent product is already on row ${seen} of this file. Keep one row per parent product.`);
      else state.parentRows.set(rowKey, row.number);
    }

    const values: Partial<typeof parentProducts.$inferInsert> = {};
    if (name) values.name = name;

    const categoryText = row.text("category", { required: true });
    let categoryId = existing?.categoryId ?? null;
    if (categoryText) {
      const match = findNamed(state.categories, categoryText);
      if (!match) row.error("category", `Category "${categoryText}" not found. Choose one of: ${state.categories.filter((c) => c.group === "type").map((c) => c.name).join(", ")}.`);
      else if (match.group !== "type") row.error("category", `"${match.name}" is a landing page, not a jewellery type. Choose a type such as Rings or Earrings.`);
      else {
        categoryId = match.id;
        values.categoryId = match.id;
      }
    }
    const subcategoryText = row.text("subcategory");
    if (subcategoryText) {
      const options = state.subcategories.filter((s) => s.categoryId === categoryId);
      const match = findNamed(options, subcategoryText);
      if (!match) row.error("subcategory", `Subcategory "${subcategoryText}" isn't listed under that category${options.length ? `. Choose one of: ${options.map((o) => o.name).join(", ")}.` : "."}`);
      else values.subcategoryId = match.id;
    } else if (existing && values.categoryId && values.categoryId !== existing.categoryId) values.subcategoryId = null;

    let collectionIds: string[] | null = null;
    const collectionNames = row.list("collections", { max: 20 });
    if (collectionNames) {
      collectionIds = [];
      for (const collectionName of collectionNames) {
        const match = findNamed(state.collections, collectionName);
        if (!match) row.error("collections", `Collection "${collectionName}" not found. Choose from: ${state.collections.map((c) => c.name).join(", ")}.`);
        else collectionIds.push(match.id);
      }
    }

    const shortDescription = row.text("shortDescription", { max: 300 });
    if (shortDescription !== undefined) values.shortDescription = shortDescription;
    const description = row.text("description", { max: 5000 });
    if (description !== undefined) values.description = description;
    const links = row.list("images", { max: 12 });
    if (links) values.images = links.map((url): ImageAsset => ({ url, alt: name ?? "" }));
    const seoTitle = row.text("seoTitle", { max: 160 });
    const seoDescription = row.text("seoDescription", { max: 320 });
    if (seoTitle !== undefined || seoDescription !== undefined) {
      const seo: SeoMeta = { ...(existing?.seo ?? {}) };
      if (seoTitle !== undefined) seo.title = seoTitle;
      if (seoDescription !== undefined) seo.description = seoDescription;
      values.seo = seo;
    }
    const status = row.choice("status", ["active", "draft"] as const);
    if (status) values.status = status;

    // Variants: SKUs in display order, each in no other parent, labels unique.
    let variants: VariantInput[] | null = null;
    const skus = row.list("variantSkus", { max: 50 })?.map((sku) => sku.toUpperCase());
    const members = skus?.length
      ? await ctx.ex
          .select({
            id: products.id,
            sku: products.sku,
            metal: products.metal,
            purity: products.purity,
            parentId: products.parentId,
            variantCustomLabel: products.variantCustomLabel,
          })
          .from(products)
          .where(and(inArray(sql`upper(${products.sku})`, skus), isNull(products.deletedAt)))
      : [];
    if (skus) {
      variants = [];
      const labels = new Map<string, string>();
      const listed = new Set<string>();
      for (const sku of skus) {
        const member = members.find((m) => m.sku.toUpperCase() === sku);
        if (listed.has(sku)) {
          row.error("variantSkus", `${sku} is listed more than once.`);
          continue;
        }
        listed.add(sku);
        if (!member) {
          row.error("variantSkus", `SKU ${sku} not found. Import or create the product first.`);
          continue;
        }
        const otherRow = state.skuRows.get(sku);
        if (otherRow && otherRow !== row.number) row.error("variantSkus", `${sku} is already a variant on row ${otherRow} of this file. A product can belong to only one parent product.`);
        else state.skuRows.set(sku, row.number);
        if (member.parentId && member.parentId !== existing?.id) {
          const other = state.parents.find((p) => p.id === member.parentId);
          row.error("variantSkus", `${sku} already belongs to the parent product “${other?.name ?? "another design"}”. Remove it there first.`);
          continue;
        }
        // A product staying in this parent keeps its custom label.
        const customLabel = member.parentId === existing?.id && existing ? member.variantCustomLabel : null;
        const label = variantLabelOf({ ...member, variantCustomLabel: customLabel });
        const clash = labels.get(labelKey(label));
        if (clash) {
          row.error("variantSkus", `${sku} and ${clash} would both be labelled “${label}”. Give one of them a Variant Label in the Products import first.`);
          continue;
        }
        labels.set(labelKey(label), sku);
        variants.push({ productId: member.id, label: customLabel });
      }
    }

    // Default variant: must be one of the (new or current) variants.
    let defaultVariantId: string | null | undefined;
    const defaultSku = row.text("defaultVariantSku", { max: 40 })?.toUpperCase();
    const currentIds = existing
      ? await ctx.ex
          .select({ id: products.id, sku: products.sku })
          .from(products)
          .where(and(eq(products.parentId, existing.id), isNull(products.deletedAt)))
          .orderBy(asc(products.variantOrder), asc(products.sku))
      : [];
    const finalIds = variants ? variants.map((v) => v.productId) : currentIds.map((c) => c.id);
    if (defaultSku) {
      const match = members.find((m) => m.sku.toUpperCase() === defaultSku) ?? currentIds.find((c) => c.sku.toUpperCase() === defaultSku);
      if (!match || !finalIds.includes(match.id)) row.error("defaultVariantSku", `${defaultSku} isn't one of this parent product's variant SKUs.`);
      else defaultVariantId = match.id;
    } else if (variants) {
      defaultVariantId = existing?.defaultVariantId && finalIds.includes(existing.defaultVariantId) ? existing.defaultVariantId : (finalIds[0] ?? null);
    }

    if (!row.ok || !name) return null;

    const variantNote = variants ? `, ${variants.length} variant${variants.length === 1 ? "" : "s"}` : "";
    if (!existing) {
      const slug = slugText ?? freeSlug(slugify(name), state.slugs);
      state.slugs.add(slug);
      return {
        row: row.number,
        action: "create",
        summary: `New parent product “${name}” (${slug})${variantNote}`,
        parentId: null,
        values: { ...values, slug, status: values.status ?? "draft" },
        collectionIds: collectionIds ?? [],
        variants: variants ?? [],
        defaultVariantId: defaultVariantId ?? null,
      };
    }

    const currentCollections = (await ctx.ex.select({ id: parentProductCollections.collectionId }).from(parentProductCollections).where(eq(parentProductCollections.parentId, existing.id))).map(
      (c) => c.id,
    );
    const changed = Object.keys(values).filter((key) => JSON.stringify(existing[key as keyof ParentRow]) !== JSON.stringify(values[key as keyof typeof values]));
    const collectionsChanged = collectionIds !== null && JSON.stringify([...new Set(collectionIds)].sort()) !== JSON.stringify([...currentCollections].sort());
    const variantsChanged = variants !== null && JSON.stringify(variants.map((v) => v.productId)) !== JSON.stringify(currentIds.map((c) => c.id));
    const defaultChanged = defaultVariantId !== undefined && defaultVariantId !== existing.defaultVariantId;
    if (!changed.length && !collectionsChanged && !variantsChanged && !defaultChanged) {
      return { row: row.number, action: "skip", summary: `${existing.slug} — already up to date`, parentId: existing.id, values: {}, collectionIds: null, variants: null, defaultVariantId: undefined };
    }
    return {
      row: row.number,
      action: "update",
      summary: `${existing.slug} — updates ${[...changed, ...(collectionsChanged ? ["collections"] : []), ...(variantsChanged ? ["variants"] : []), ...(defaultChanged ? ["default variant"] : [])].join(", ")}`,
      parentId: existing.id,
      values,
      collectionIds: collectionsChanged ? collectionIds : null,
      variants: variantsChanged ? variants : null,
      defaultVariantId,
    };
  },

  async apply(plan, _state, ctx) {
    if (plan.action === "skip") return;
    let parentId = plan.parentId;
    if (!parentId) {
      const [created] = await ctx.tx
        .insert(parentProducts)
        .values(plan.values as typeof parentProducts.$inferInsert)
        .returning({ id: parentProducts.id });
      parentId = created!.id;
    } else if (Object.keys(plan.values).length) {
      await ctx.tx
        .update(parentProducts)
        .set({ ...plan.values, updatedAt: new Date() })
        .where(eq(parentProducts.id, parentId));
    }
    if (plan.collectionIds) await writeParentCollections(ctx.tx, parentId, plan.collectionIds);
    if (plan.variants) await writeVariants(ctx.tx, parentId, plan.variants);
    if (plan.defaultVariantId !== undefined) {
      await ctx.tx.update(parentProducts).set({ defaultVariantId: plan.defaultVariantId, updatedAt: new Date() }).where(eq(parentProducts.id, parentId));
    }
  },
});

function freeSlug(base: string, taken: Set<string>) {
  const start = base || "design";
  if (!taken.has(start)) return start;
  for (let suffix = 2; suffix < 200; suffix += 1) {
    const candidate = `${start}-${suffix}`.slice(0, 160);
    if (!taken.has(candidate)) return candidate;
  }
  return `${start}-${Date.now().toString(36)}`;
}
