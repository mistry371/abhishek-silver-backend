import { and, eq, isNull, max } from "drizzle-orm";
import { z } from "zod";
import { categories, collections, metalRates, parentProducts, productCollections, products, subcategories, vendors } from "@/db/schema";
import type { Executor } from "@/db/client";
import { partialUpdate } from "@/lib/validation";
import { GENDERS, labelKey, METALS, PURITIES, variantLabelOf } from "@/modules/catalog/labels";
import { getSetting } from "@/services/settings";
import { createSchema, fieldPermission, productShape, validateProduct, type ProductField, type ProductLookups } from "../../catalogue";
import type { RowReader } from "../reader";
import { defineImport, type ImportColumn, type RowPlan } from "../types";

/**
 * PRODUCT IMPORT
 * ------------------------------------------------------------------
 * Matched on SKU: a SKU the shop doesn't have yet is created, one it already
 * has is updated with the columns the file fills in (blank means "leave it
 * as it is"). Rows run through exactly the same schema and cross-field rules
 * as the product form, including its field-level permissions.
 */

const updateSchema = partialUpdate(z.object(productShape));

const METAL_WORDS = { gold: "gold", silver: "silver" } as const;
const PURITY_WORDS = { "24kt": "24k", "22kt": "22k", "18kt": "18k", "14kt": "14k", fine_silver: "999", sterling: "925", sterling_silver: "925" } as const;

const columns: ImportColumn[] = [
  { key: "sku", label: "SKU", required: true, example: "G22K-RG-2101", example2: "S925-ER-2102", hint: "The code that identifies the piece. A new SKU creates a product; an existing one updates it." },
  { key: "name", label: "Name", example: "Aaravi Filigree Gold Band", example2: "Meera Silver Studs", hint: "Required for new products. Up to 160 characters." },
  { key: "slug", label: "URL Slug", example: "aaravi-filigree-gold-band", example2: "", hint: "Optional. Leave blank and it is made from the name (lowercase letters, numbers and hyphens)." },
  { key: "category", label: "Category", field: "categoryId", example: "Rings", example2: "Earrings", hint: "Required for new products. The jewellery type, by name or URL slug (Rings, Earrings, Necklaces…)." },
  { key: "subcategory", label: "Subcategory", field: "subcategoryId", example: "Bands", example2: "Studs", hint: "Optional. Must belong to the category above." },
  { key: "collections", label: "Collections", field: "collectionIds", example: "Everyday Luxe", example2: "Festive Edit, Gifting Edit", hint: "Optional. Separate several collections with commas." },
  { key: "metal", label: "Metal", example: "gold", example2: "silver", hint: "Required for new products. gold or silver." },
  { key: "purity", label: "Purity", example: "22k", example2: "925", hint: "Required for new products. Gold: 24k, 22k, 18k, 14k. Silver: 999, 925." },
  { key: "gender", label: "Gender", example: "women", example2: "unisex", hint: "women, men, kids or unisex. Defaults to unisex." },
  { key: "netWeight", label: "Net Weight (g)", example: "3.85", example2: "4.2", hint: "Required for new products. Metal weight in grams, used for pricing." },
  { key: "grossWeight", label: "Gross Weight (g)", example: "", example2: "4.6", hint: "Optional. Total weight including stones; can't be less than the net weight." },
  { key: "stoneWeight", label: "Stone Weight (ct)", example: "", example2: "0.35", hint: "Optional. Stone weight in carats." },
  { key: "stoneDetails", label: "Stone Details", example: "", example2: "2 round cubic zirconia", hint: "Optional. Short description of the stones." },
  { key: "makingType", label: "Making Charge Type", example: "per_gram", example2: "percentage", hint: "Required for new products. per_gram, percentage or fixed." },
  { key: "makingValue", label: "Making Charge Value", example: "950", example2: "12", hint: "Required for new products. Rupees per gram, a percentage, or a fixed amount — matching the type." },
  { key: "stoneCharges", label: "Stone Charges", example: "0", example2: "1800", hint: "Optional. Rupees added for stones." },
  { key: "otherCharges", label: "Other Charges", example: "0", example2: "250", hint: "Optional. Rupees added for hallmarking, polish and the like." },
  { key: "discountType", label: "Discount Type", field: "discount", example: "", example2: "percentage", hint: "Optional. percentage or fixed. Fill in the discount value as well." },
  { key: "discountValue", label: "Discount Value", field: "discount", example: "", example2: "10", hint: "Optional. Percentage discounts are limited to 90." },
  { key: "sizing", label: "Sizing Type", example: "ring", example2: "", hint: "Optional. ring, bangle, chain or bracelet. Needed before sizes can be listed." },
  { key: "sizeOptions", label: "Sizes", field: "sizeOptions", example: "10, 12, 14, 16", example2: "", hint: "Optional. Separate sizes with commas." },
  { key: "defaultSize", label: "Default Size", example: "14", example2: "", hint: "Optional. Must be one of the sizes above; the listed price refers to it." },
  { key: "status", label: "Status", example: "draft", example2: "active", hint: "active, draft or disabled. New products default to draft. Activating needs an image and a metal rate." },
  { key: "shortDescription", label: "Short Description", example: "A slender 22KT band with hand-finished filigree.", example2: "", hint: "Optional. Up to 300 characters, shown on listing pages." },
  { key: "description", label: "Description", example: "", example2: "", hint: "Optional. Up to 5,000 characters, shown on the product page." },
  { key: "images", label: "Image URLs", field: "images", example: "https://example.com/band-1.jpg", example2: "", hint: "Optional. Web links to images, separated by commas. Upload files in Products → Media first." },
  { key: "barcode", label: "Barcode", example: "", example2: "", hint: "Optional. Must be unique across products." },
  { key: "lowStockThreshold", label: "Low Stock Alert At", example: "", example2: "3", hint: "Optional. Raise an alert when stock falls to this many units." },
  {
    key: "parentProduct",
    label: "Parent Product",
    example: "",
    example2: "",
    hint: "Optional. URL slug of an existing parent product (one design with several variants) to add this product to. Blank leaves it as it is.",
    permission: "products:edit_content",
  },
  {
    key: "variantLabel",
    label: "Variant Label",
    example: "",
    example2: "",
    hint: 'Optional. What this variant is called on the parent product, e.g. "Rose Gold". Blank uses purity and metal, e.g. "22K Gold". Labels must differ within a parent.',
    permission: "products:edit_content",
  },
  {
    key: "purchasePrice",
    label: "Purchase Cost",
    example: "",
    example2: "",
    hint: "Optional and confidential. Only staff who may see purchase prices can import this column.",
    permission: "products:view_confidential",
  },
  {
    key: "vendor",
    label: "Supplier",
    field: "vendorId",
    example: "",
    example2: "",
    hint: "Optional and confidential. Supplier name or code. Only staff who may see suppliers can import this column.",
    permission: "products:view_confidential",
  },
];

/** Schema field → the column that owns it (the first one, where several columns feed one field). */
const COLUMN_BY_FIELD = columns.reduce((map, column) => map.set(column.field ?? column.key, map.get(column.field ?? column.key) ?? column.key), new Map<string, string>());
const columnOf = (field: string) => COLUMN_BY_FIELD.get(field) ?? field;

interface Named {
  id: string;
  slug: string;
  name: string;
}

export const same = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

/** Taxonomy is referenced by slug or by the name staff see on screen. */
export function findNamed<T extends Named>(items: T[], text: string): T | null {
  const wanted = same(text);
  return items.find((item) => item.slug.toLowerCase() === wanted || same(item.name) === wanted) ?? null;
}

function slugify(text: string) {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 150);
}

function freeSlug(base: string, taken: Set<string>) {
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 200; suffix += 1) {
    const candidate = `${base}-${suffix}`.slice(0, 160);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

interface ProductState {
  categories: (Named & { group: string })[];
  subcategories: (Named & { categoryId: string })[];
  collections: Named[];
  suppliers: (Named & { code: string })[];
  slugs: Set<string>;
  /** Parent products by slug, and their names by id. */
  parents: Map<string, { id: string; name: string }>;
  parentNames: Map<string, string>;
  /** Effective variant labels per parent, kept up to date as rows are planned (key: product id or "row:<n>"). */
  labels: Map<string, Map<string, { label: string; sku: string }>>;
  /** Next free variant position per parent. */
  nextOrder: Map<string, number>;
  skuRows: Map<string, number>;
  defaultThreshold: number;
  /** Everything a row needs is loaded once per file, so a check makes a handful of queries, not several per row. */
  bySku: Map<string, ProductRow>;
  /** Product id → its collection ids. */
  links: Map<string, string[]>;
  lookups: ProductLookups;
}

type ParentFields = Pick<typeof products.$inferInsert, "parentId" | "variantCustomLabel" | "variantOrder">;
type ProductRow = typeof products.$inferSelect;

async function labelsOf(ex: Executor, state: ProductState, parentId: string) {
  let book = state.labels.get(parentId);
  if (!book) {
    const members = await ex
      .select({ id: products.id, sku: products.sku, metal: products.metal, purity: products.purity, variantCustomLabel: products.variantCustomLabel })
      .from(products)
      .where(and(eq(products.parentId, parentId), isNull(products.deletedAt)));
    book = new Map(members.map((m) => [m.id, { label: variantLabelOf(m), sku: m.sku }]));
    state.labels.set(parentId, book);
  }
  return book;
}

async function nextOrderOf(ex: Executor, state: ProductState, parentId: string) {
  let next = state.nextOrder.get(parentId);
  if (next === undefined) {
    const [row] = await ex.select({ value: max(products.variantOrder) }).from(products).where(eq(products.parentId, parentId));
    next = row?.value === null || row?.value === undefined ? 0 : row.value + 1;
  }
  state.nextOrder.set(parentId, next + 1);
  return next;
}

/**
 * "Parent Product" and "Variant Label": attaches the product to an existing
 * parent and/or sets its custom label, keeping labels unique within the parent
 * (also when a row changes a variant's metal or purity, which changes its default label).
 */
async function readParentFields(
  row: RowReader,
  state: ProductState,
  ex: Executor,
  sku: string | undefined,
  existing: ProductRow | null,
  fields: Record<string, unknown>,
): Promise<Partial<ParentFields>> {
  const patch: Partial<ParentFields> = {};
  const parentSlug = row.text("parentProduct", { max: 160 })?.toLowerCase();
  const customLabel = row.text("variantLabel", { max: 60 });
  let parentId = existing?.parentId ?? null;

  if (parentSlug) {
    const parent = state.parents.get(parentSlug);
    if (!parent) row.error("parentProduct", `Parent product "${parentSlug}" not found. Use the URL slug of an existing parent product.`);
    else if (existing?.parentId && existing.parentId !== parent.id) {
      row.error("parentProduct", `${sku} already belongs to the parent product “${state.parentNames.get(existing.parentId) ?? "another design"}”. Remove it there first.`);
    } else {
      parentId = parent.id;
      if (existing?.parentId !== parent.id) {
        patch.parentId = parent.id;
        patch.variantOrder = await nextOrderOf(ex, state, parent.id);
      }
    }
  }
  if (customLabel) {
    if (!parentId) row.error("variantLabel", "A variant label needs a parent product. Fill in Parent Product as well.");
    else if (customLabel !== existing?.variantCustomLabel) patch.variantCustomLabel = customLabel;
  }
  const metal = (fields.metal as ProductRow["metal"] | undefined) ?? existing?.metal;
  const purity = (fields.purity as ProductRow["purity"] | undefined) ?? existing?.purity;
  if (!parentId || !row.ok || !metal || !purity) return patch;

  const label = variantLabelOf({ metal, purity, variantCustomLabel: customLabel ?? (existing?.parentId === parentId ? existing.variantCustomLabel : null) });
  const book = await labelsOf(ex, state, parentId);
  const key = existing?.id ?? `row:${row.number}`;
  const clash = [...book.entries()].find(([other, entry]) => other !== key && labelKey(entry.label) === labelKey(label));
  if (clash) {
    row.error(customLabel ? "variantLabel" : "parentProduct", `${clash[1].sku} is already labelled “${label}” in this parent product. Give this variant a different Variant Label.`);
    return patch;
  }
  book.set(key, { label, sku: sku ?? "" });
  return patch;
}

interface ProductPlan extends RowPlan {
  productId: string | null;
  insert?: typeof products.$inferInsert;
  patch?: Partial<typeof products.$inferInsert>;
  /** null leaves the product's collections untouched. */
  collectionIds: string[] | null;
}

/** Reads every column the file supplied; blank cells are simply absent from the result. */
function readFields(row: RowReader, state: ProductState, existing: typeof products.$inferSelect | null) {
  const required = !existing;
  const fields: Record<string, unknown> = {};
  const set = (field: string, value: unknown) => {
    if (value !== undefined) fields[field] = value;
  };

  set("name", row.text("name", { required, max: 160 }));
  set("slug", row.text("slug", { max: 160 })?.toLowerCase());
  set("barcode", row.text("barcode", { max: 64 }));
  set("shortDescription", row.text("shortDescription", { max: 300 }));
  set("description", row.text("description", { max: 5000 }));
  set("gender", row.choice("gender", GENDERS));
  set("metal", row.choice("metal", METALS, { required, extra: METAL_WORDS }));
  set("purity", row.choice("purity", PURITIES, { required, extra: PURITY_WORDS }));
  set("netWeight", row.numeric("netWeight", { required, min: 0.001, max: 10_000 }));
  set("grossWeight", row.numeric("grossWeight", { min: 0.001, max: 10_000 }));
  set("stoneWeight", row.numeric("stoneWeight", { min: 0, max: 1_000 }));
  set("stoneDetails", row.text("stoneDetails", { max: 300 }));
  set("makingType", row.choice("makingType", ["per_gram", "percentage", "fixed"] as const, { required }));
  set("makingValue", row.numeric("makingValue", { required, min: 0, max: 10_000_000 }));
  set("stoneCharges", row.numeric("stoneCharges", { min: 0 }));
  set("otherCharges", row.numeric("otherCharges", { min: 0 }));
  set("sizing", row.choice("sizing", ["ring", "bangle", "chain", "bracelet"] as const));
  set("sizeOptions", row.list("sizeOptions", { max: 30 }));
  set("defaultSize", row.text("defaultSize", { max: 10 }));
  set("status", row.choice("status", ["active", "draft", "disabled"] as const));
  set("lowStockThreshold", row.numeric("lowStockThreshold", { min: 0, max: 1000, integer: true }));
  set("purchasePrice", row.numeric("purchasePrice", { min: 0 }));

  const links = row.list("images", { max: 12 });
  if (links) set("images", links.map((url) => ({ url, alt: "" })));

  const discountType = row.choice("discountType", ["percentage", "fixed"] as const);
  const discountValue = row.numeric("discountValue", { min: 0.01, max: 10_000_000 });
  if (discountType && discountValue !== undefined) set("discount", { type: discountType, value: discountValue });
  else if (discountType || discountValue !== undefined) row.error(discountType ? "discountValue" : "discountType", "Fill in both the discount type and the discount value.");

  const categoryText = row.text("category", { required });
  let categoryId = existing?.categoryId ?? null;
  if (categoryText) {
    const match = findNamed(state.categories, categoryText);
    if (!match) {
      row.error("category", `Category "${categoryText}" not found. Choose one of: ${state.categories.filter((c) => c.group === "type").map((c) => c.name).join(", ")}.`);
    } else if (match.group !== "type") {
      row.error("category", `"${match.name}" is a landing page, not a jewellery type. Choose a type such as Rings or Earrings.`);
    } else {
      categoryId = match.id;
      set("categoryId", match.id);
    }
  }

  const subcategoryText = row.text("subcategory");
  if (subcategoryText) {
    const options = state.subcategories.filter((item) => item.categoryId === categoryId);
    const match = findNamed(options, subcategoryText);
    if (!match) row.error("subcategory", `Subcategory "${subcategoryText}" isn't listed under that category${options.length ? `. Choose one of: ${options.map((o) => o.name).join(", ")}.` : "."}`);
    else set("subcategoryId", match.id);
  }

  const collectionNames = row.list("collections", { max: 20 });
  if (collectionNames) {
    const ids: string[] = [];
    for (const name of collectionNames) {
      const match = findNamed(state.collections, name);
      if (!match) row.error("collections", `Collection "${name}" not found. Choose from: ${state.collections.map((c) => c.name).join(", ")}.`);
      else ids.push(match.id);
    }
    set("collectionIds", ids);
  }

  const supplierText = row.text("vendor");
  if (supplierText) {
    const match = state.suppliers.find((supplier) => supplier.code.toLowerCase() === same(supplierText) || same(supplier.name) === same(supplierText));
    if (!match) row.error("vendor", `Supplier "${supplierText}" not found. Add it in Purchases → Suppliers first.`);
    else set("vendorId", match.id);
  }

  return fields;
}

function reportIssues(row: RowReader, issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
  for (const issue of issues) {
    const field = issue.path.map(String).join(".") || "sku";
    row.error(columnOf(field.split(".")[0] ?? field), issue.message);
  }
}

const changedKeys = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));

export const productImport = defineImport<ProductState, ProductPlan>({
  entity: "products",
  label: "Products",
  description: "Add new products and update existing ones, matched on SKU. New rows need Products → Create; changed fields need the same permissions as the product form.",
  module: "products",
  permission: "products:create",
  gate: ["products:create", "products:edit_content", "products:edit_inventory", "products:edit_pricing"],
  revalidate: true,
  columns,

  async prepare(ctx) {
    const categoryRows = await ctx.ex.select({ id: categories.id, slug: categories.slug, name: categories.name, group: categories.group }).from(categories);
    const subcategoryRows = await ctx.ex.select({ id: subcategories.id, slug: subcategories.slug, name: subcategories.name, categoryId: subcategories.categoryId }).from(subcategories);
    const collectionRows = await ctx.ex.select({ id: collections.id, slug: collections.slug, name: collections.name }).from(collections);
    const vendorRows = ctx.can("products:view_confidential")
      ? await ctx.ex.select({ id: vendors.id, slug: vendors.code, name: vendors.name, code: vendors.code }).from(vendors)
      : [];
    const slugRows = await ctx.ex.select({ slug: products.slug }).from(products);
    const parentRows = await ctx.ex.select({ id: parentProducts.id, slug: parentProducts.slug, name: parentProducts.name, images: parentProducts.images }).from(parentProducts);
    const productRows = await ctx.ex.select().from(products).where(isNull(products.deletedAt));
    const linkRows = await ctx.ex.select({ productId: productCollections.productId, collectionId: productCollections.collectionId }).from(productCollections);
    const vendorIds = await ctx.ex.select({ id: vendors.id }).from(vendors);
    const rateRows = await ctx.ex.select({ metal: metalRates.metal, purity: metalRates.purity }).from(metalRates);

    const links = new Map<string, string[]>();
    for (const link of linkRows) links.set(link.productId, [...(links.get(link.productId) ?? []), link.collectionId]);
    // Every parent's current labels and next free position, as labelsOf / nextOrderOf would read them.
    const labels = new Map<string, Map<string, { label: string; sku: string }>>(parentRows.map((row) => [row.id, new Map()]));
    const nextOrder = new Map<string, number>(parentRows.map((row) => [row.id, 0]));
    for (const product of productRows) {
      if (!product.parentId) continue;
      labels.get(product.parentId)?.set(product.id, { label: variantLabelOf(product), sku: product.sku });
      nextOrder.set(product.parentId, Math.max(nextOrder.get(product.parentId) ?? 0, product.variantOrder + 1));
    }

    return {
      categories: categoryRows,
      subcategories: subcategoryRows,
      collections: collectionRows,
      suppliers: vendorRows,
      // Parent slugs are reserved too, so /product/<slug> is never ambiguous.
      slugs: new Set([...slugRows.map((row) => row.slug), ...parentRows.map((row) => row.slug)]),
      parents: new Map(parentRows.map((row) => [row.slug, { id: row.id, name: row.name }])),
      parentNames: new Map(parentRows.map((row) => [row.id, row.name])),
      labels,
      nextOrder,
      skuRows: new Map<string, number>(),
      defaultThreshold: (await getSetting("inventory", ctx.ex)).defaultLowStockThreshold,
      bySku: new Map(productRows.map((row) => [row.sku.toUpperCase(), row])),
      links,
      lookups: {
        categories: new Map(categoryRows.map((row) => [row.id, { group: row.group }])),
        subcategories: new Map(subcategoryRows.map((row) => [row.id, row.categoryId])),
        collections: new Set(collectionRows.map((row) => row.id)),
        vendors: new Set(vendorIds.map((row) => row.id)),
        parentImages: new Map(parentRows.map((row) => [row.id, row.images])),
        rates: new Set(rateRows.map((row) => `${row.metal}:${row.purity}`)),
      },
    };
  },

  async plan(row, state, ctx) {
    const sku = row.text("sku", { required: true, max: 40 })?.toUpperCase();
    if (sku) {
      const seen = state.skuRows.get(sku);
      if (seen) row.error("sku", `SKU ${sku} is already on row ${seen} of this file. Keep one row per product.`);
      else state.skuRows.set(sku, row.number);
    }
    const existing = sku ? (state.bySku.get(sku) ?? null) : null;
    const fields = readFields(row, state, existing);
    const parentFields = row.ok ? await readParentFields(row, state, ctx.ex, sku, existing, fields) : {};
    const explicitSlug = fields.slug as string | undefined;
    if (explicitSlug && explicitSlug !== existing?.slug && state.parents.has(explicitSlug)) {
      row.error("slug", `This URL slug is already used by the parent product “${state.parents.get(explicitSlug)!.name}”.`);
    }
    if (!sku || !row.ok) return null;

    if (!existing) {
      if (!ctx.can("products:create")) {
        row.error("sku", `SKU ${sku} isn't in the catalogue yet and you don't have permission to create products.`);
        return null;
      }
      const name = String(fields.name ?? "");
      const slug = (fields.slug as string | undefined) || freeSlug(slugify(name) || sku.toLowerCase(), state.slugs);
      const parsed = createSchema.omit({ initialStock: true }).safeParse({ ...fields, sku, slug, lowStockThreshold: fields.lowStockThreshold ?? state.defaultThreshold });
      if (!parsed.success) {
        reportIssues(row, parsed.error.issues);
        return null;
      }
      const { collectionIds, ...values } = parsed.data;
      await validateProduct(ctx.ex, { ...parsed.data, collectionIds, parentId: parentFields.parentId ?? null }, state.lookups);
      state.slugs.add(values.slug);
      return { row: row.number, action: "create", summary: `${sku} — new product “${values.name}”`, productId: null, insert: { ...values, ...parentFields }, collectionIds };
    }

    const parsed = updateSchema.safeParse(fields);
    if (!parsed.success) {
      reportIssues(row, parsed.error.issues);
      return null;
    }

    const { collectionIds, ...patch } = parsed.data as Record<string, unknown> & { collectionIds?: string[] };
    const current = state.links.get(existing.id) ?? [];
    const nextCollections = collectionIds ? [...new Set(collectionIds)] : current;

    const changed = changedKeys(existing as unknown as Record<string, unknown>, patch);
    if (collectionIds && JSON.stringify([...current].sort()) !== JSON.stringify([...nextCollections].sort())) changed.push("collectionIds");
    const parentChanged = Object.keys(parentFields).filter((key) => key !== "variantOrder");
    if (!changed.length && !parentChanged.length) return { row: row.number, action: "skip", summary: `${sku} — already up to date`, productId: existing.id, collectionIds: null };

    // Only the fields this row actually changes need the product form's permission for them.
    const denied = changed.filter((field) => !ctx.can(fieldPermission[field as ProductField]));
    if (denied.length) {
      for (const field of denied) row.error(columnOf(field), "You don't have permission to change this field.");
      return null;
    }
    await validateProduct(ctx.ex, { ...existing, ...patch, ...parentFields, collectionIds: nextCollections }, state.lookups);

    const labelled = [...changed.map((field) => row.label(columnOf(field))), ...parentChanged.map((key) => row.label(key === "parentId" ? "parentProduct" : "variantLabel"))];
    const listed = labelled.slice(0, 3);
    return {
      row: row.number,
      action: "update",
      summary: `${sku} — updates ${listed.join(", ")}${labelled.length > listed.length ? ` and ${labelled.length - listed.length} more` : ""}`,
      productId: existing.id,
      patch: { ...(patch as Partial<typeof products.$inferInsert>), ...parentFields },
      collectionIds: collectionIds ? nextCollections : null,
    };
  },

  async apply(plan, _state, ctx) {
    if (plan.action === "skip") return;
    let productId = plan.productId;
    if (plan.insert) {
      const [created] = await ctx.tx.insert(products).values(plan.insert).returning({ id: products.id });
      productId = created!.id;
    } else if (plan.patch && productId) {
      await ctx.tx
        .update(products)
        .set({ ...plan.patch, updatedAt: new Date() })
        .where(eq(products.id, productId));
    }
    if (plan.collectionIds && productId) {
      // A product created just now has no links to clear.
      if (!plan.insert) await ctx.tx.delete(productCollections).where(eq(productCollections.productId, productId));
      if (plan.collectionIds.length) {
        await ctx.tx.insert(productCollections).values([...new Set(plan.collectionIds)].map((collectionId) => ({ productId, collectionId })));
      }
    }
  },
});
