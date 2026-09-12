import { and, count, eq } from "drizzle-orm";
import { categories, collections, products, subcategories } from "@/db/schema";
import { partialUpdate } from "@/lib/validation";
import { GENDERS, METALS } from "@/modules/catalog/labels";
import { categorySchema, checkListingRule, collectionSchema, subcategorySchema } from "../../catalogue";
import type { RowReader } from "../reader";
import { defineImport, type ImportColumn, type RowPlan } from "../types";

/**
 * TAXONOMY IMPORTS — categories, subcategories and collections
 * ------------------------------------------------------------------
 * All three are matched on their URL slug (subcategories within their
 * category), so re-importing a list tidies up names, ordering and imagery
 * instead of creating duplicates.
 */

const displayOrderHint = "Optional. Lower numbers appear first. Defaults to 0.";
const activeHint = "Yes or No. Inactive pages are hidden from the website.";

function reportIssues(row: RowReader, issues: readonly { path: readonly PropertyKey[]; message: string }[], columnOf: (field: string) => string) {
  for (const issue of issues) {
    const field = issue.path.map(String).join(".") || "slug";
    row.error(columnOf(field.split(".")[0] ?? field), issue.message);
  }
}

const resolver = (columns: ImportColumn[]) => {
  const byField = columns.reduce((map, column) => map.set(column.field ?? column.key, map.get(column.field ?? column.key) ?? column.key), new Map<string, string>());
  return (field: string) => byField.get(field) ?? field;
};

/** Which of the parsed values differ from the record already in the database. */
function changed(existing: Record<string, unknown>, patch: Record<string, unknown>) {
  return Object.keys(patch).filter((key) => JSON.stringify(existing[key]) !== JSON.stringify(patch[key]));
}

type ListingRule = Parameters<typeof checkListingRule>[1];

interface TaxonomyPlan extends RowPlan {
  id: string | null;
  values: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

const categoryColumns: ImportColumn[] = [
  { key: "slug", label: "URL Slug", required: true, example: "rings", example2: "gold-jewellery", hint: "Lowercase letters, numbers and hyphens. Identifies the category — keep it stable." },
  { key: "name", label: "Name", required: true, example: "Rings", example2: "Gold Jewellery", hint: "Shown in menus and on the category page." },
  { key: "group", label: "Group", example: "type", example2: "metal", hint: "Required for new categories. type (a jewellery type such as Rings), metal, audience or service." },
  { key: "shortName", label: "Short Name", example: "Rings", example2: "", hint: "Optional. Used where space is tight." },
  { key: "description", label: "Description", example: "Everyday and bridal rings in gold and silver.", example2: "", hint: "Optional. Up to 500 characters." },
  { key: "imageUrl", label: "Image URL", field: "image", example: "https://example.com/rings.jpg", example2: "https://example.com/gold.jpg", hint: "Required for new categories. Web link to the banner image." },
  { key: "imageAlt", label: "Image Description", field: "image", example: "Gold rings on a silk tray", example2: "", hint: "Optional. Describes the image for screen readers." },
  { key: "listingMetal", label: "Lists Metal", field: "listingRule", example: "", example2: "gold", hint: "Only for metal, audience and service pages: which metal the page lists (gold or silver)." },
  { key: "listingGenders", label: "Lists Audience", field: "listingRule", example: "", example2: "", hint: "Only for metal, audience and service pages: women, men, kids or unisex, separated by commas." },
  { key: "listingCustomizable", label: "Lists Personalisable", field: "listingRule", example: "", example2: "no", hint: "Only for metal, audience and service pages: Yes to list personalisable pieces." },
  { key: "displayOrder", label: "Display Order", example: "1", example2: "2", hint: displayOrderHint },
  { key: "active", label: "Active", example: "yes", example2: "yes", hint: activeHint },
];

const categoryColumnOf = resolver(categoryColumns);

function readTaxonomyBasics(row: RowReader, creating: boolean) {
  const values: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined) values[key] = value;
  };
  set("name", row.text("name", { required: creating, max: 80 }));
  set("description", row.text("description", { max: 600 }));
  set("displayOrder", row.numeric("displayOrder", { min: 0, max: 1000, integer: true }));
  set("active", row.boolean("active"));
  const url = row.text("imageUrl", { required: creating, max: 2000 });
  if (url) set("image", { url, alt: row.text("imageAlt", { max: 300 }) ?? "" });
  return values;
}

export const categoryImport = defineImport<{ seen: Map<string, number> }, TaxonomyPlan>({
  entity: "categories",
  label: "Categories",
  description: "Add or update jewellery types and landing pages, matched on URL slug.",
  module: "products",
  permission: "catalog:manage_taxonomy",
  revalidate: true,
  columns: categoryColumns,

  async prepare() {
    return { seen: new Map<string, number>() };
  },

  async plan(row, state, ctx) {
    const slug = row.text("slug", { required: true, max: 160 })?.toLowerCase();
    if (!slug) return null;
    const seen = state.seen.get(slug);
    if (seen) {
      row.error("slug", `Slug "${slug}" is already on row ${seen} of this file.`);
      return null;
    }
    state.seen.set(slug, row.number);

    const [existing] = await ctx.ex.select().from(categories).where(eq(categories.slug, slug)).limit(1);
    const creating = !existing;
    const values = readTaxonomyBasics(row, creating);
    const group = row.choice("group", ["metal", "type", "audience", "service"] as const, { required: creating });
    if (group) values.group = group;
    const shortName = row.text("shortName", { max: 40 });
    if (shortName !== undefined) values.shortName = shortName;

    const metal = row.choice("listingMetal", METALS);
    const genders = row.list("listingGenders", { max: 4 })?.map((value) => value.toLowerCase());
    const customizable = row.boolean("listingCustomizable");
    const effectiveGroup = group ?? existing?.group;
    if (metal || genders || customizable !== undefined) {
      const unknown = genders?.filter((value) => !(GENDERS as readonly string[]).includes(value)) ?? [];
      if (unknown.length) row.error("listingGenders", `Unknown audience: ${unknown.join(", ")}. Use women, men, kids or unisex.`);
      values.listingRule = { ...(metal ? { metal } : {}), ...(genders?.length ? { genders } : {}), ...(customizable !== undefined ? { customizable } : {}) };
    } else if (creating && effectiveGroup === "type") {
      values.listingRule = null;
    }
    if (!row.ok) return null;

    const schema = creating ? categorySchema : partialUpdate(categorySchema);
    const parsed = schema.safeParse(creating ? { ...values, slug } : values);
    if (!parsed.success) {
      reportIssues(row, parsed.error.issues, categoryColumnOf);
      return null;
    }
    const data = parsed.data as Record<string, unknown>;
    checkListingRule(String(effectiveGroup ?? ""), (data.listingRule ?? existing?.listingRule ?? null) as ListingRule);

    if (!existing) return { row: row.number, action: "create", summary: `${slug} — new ${String(data.group)} category “${String(data.name)}”`, id: null, values: { ...data, slug } };
    if (group && group !== existing.group) {
      const [used] = await ctx.ex.select({ value: count() }).from(products).where(eq(products.categoryId, existing.id));
      if ((used?.value ?? 0) > 0) {
        row.error("group", "This category has products, so its group can't change.");
        return null;
      }
    }
    const differences = changed(existing as unknown as Record<string, unknown>, data);
    if (!differences.length) return { row: row.number, action: "skip", summary: `${slug} — already up to date`, id: existing.id, values: {} };
    return { row: row.number, action: "update", summary: `${slug} — updates ${differences.map(categoryColumnOf).join(", ")}`, id: existing.id, values: data };
  },

  async apply(plan, _state, ctx) {
    if (plan.action === "skip") return;
    if (!plan.id) {
      await ctx.tx.insert(categories).values(plan.values as typeof categories.$inferInsert);
      return;
    }
    await ctx.tx
      .update(categories)
      .set({ ...plan.values, updatedAt: new Date() })
      .where(eq(categories.id, plan.id));
  },
});

/* ------------------------------------------------------------------ */
/* Subcategories                                                       */
/* ------------------------------------------------------------------ */

const subcategoryColumns: ImportColumn[] = [
  { key: "category", label: "Category", required: true, example: "Rings", example2: "Earrings", hint: "The jewellery type this belongs to, by name or URL slug." },
  { key: "slug", label: "URL Slug", required: true, example: "bands", example2: "studs", hint: "Lowercase letters, numbers and hyphens. Unique within the category." },
  { key: "name", label: "Name", required: true, example: "Bands", example2: "Studs", hint: "Shown in filters and menus." },
  { key: "displayOrder", label: "Display Order", example: "1", example2: "2", hint: displayOrderHint },
  { key: "active", label: "Active", example: "yes", example2: "yes", hint: activeHint },
];

const subcategoryColumnOf = resolver(subcategoryColumns);

export const subcategoryImport = defineImport<{ categories: { id: string; slug: string; name: string; group: string }[]; seen: Map<string, number> }, TaxonomyPlan>({
  entity: "subcategories",
  label: "Subcategories",
  description: "Add or update the subcategories under each jewellery type, matched on category and URL slug.",
  module: "products",
  permission: "catalog:manage_taxonomy",
  revalidate: true,
  columns: subcategoryColumns,

  async prepare(ctx) {
    return {
      categories: await ctx.ex.select({ id: categories.id, slug: categories.slug, name: categories.name, group: categories.group }).from(categories),
      seen: new Map<string, number>(),
    };
  },

  async plan(row, state, ctx) {
    const categoryText = row.text("category", { required: true, max: 80 });
    const slug = row.text("slug", { required: true, max: 160 })?.toLowerCase();
    const values: Record<string, unknown> = {};
    const name = row.text("name", { required: true, max: 80 });
    if (name !== undefined) values.name = name;
    const displayOrder = row.numeric("displayOrder", { min: 0, max: 1000, integer: true });
    if (displayOrder !== undefined) values.displayOrder = displayOrder;
    const active = row.boolean("active");
    if (active !== undefined) values.active = active;

    const wanted = categoryText?.trim().toLowerCase();
    const category = wanted ? state.categories.find((item) => item.slug.toLowerCase() === wanted || item.name.trim().toLowerCase() === wanted) : undefined;
    if (categoryText && !category) row.error("category", `Category "${categoryText}" not found.`);
    else if (category && category.group !== "type") row.error("category", `Subcategories can only be added to jewellery types, and "${category.name}" isn't one.`);
    if (!slug || !category || !row.ok) return null;

    const key = `${category.id}:${slug}`;
    const seen = state.seen.get(key);
    if (seen) {
      row.error("slug", `This subcategory is already on row ${seen} of this file.`);
      return null;
    }
    state.seen.set(key, row.number);

    const [existing] = await ctx.ex
      .select()
      .from(subcategories)
      .where(and(eq(subcategories.categoryId, category.id), eq(subcategories.slug, slug)))
      .limit(1);
    const schema = existing ? partialUpdate(subcategorySchema) : subcategorySchema;
    const parsed = schema.safeParse(existing ? values : { ...values, slug });
    if (!parsed.success) {
      reportIssues(row, parsed.error.issues, subcategoryColumnOf);
      return null;
    }
    const data = parsed.data as Record<string, unknown>;
    if (!existing) return { row: row.number, action: "create", summary: `${category.name} / ${String(data.name)} — new subcategory`, id: null, values: { ...data, slug, categoryId: category.id } };
    const differences = changed(existing as unknown as Record<string, unknown>, data);
    if (!differences.length) return { row: row.number, action: "skip", summary: `${category.name} / ${slug} — already up to date`, id: existing.id, values: {} };
    return { row: row.number, action: "update", summary: `${category.name} / ${slug} — updates ${differences.map(subcategoryColumnOf).join(", ")}`, id: existing.id, values: data };
  },

  async apply(plan, _state, ctx) {
    if (plan.action === "skip") return;
    if (!plan.id) {
      await ctx.tx.insert(subcategories).values(plan.values as typeof subcategories.$inferInsert);
      return;
    }
    await ctx.tx
      .update(subcategories)
      .set({ ...plan.values, updatedAt: new Date() })
      .where(eq(subcategories.id, plan.id));
  },
});

/* ------------------------------------------------------------------ */
/* Collections                                                         */
/* ------------------------------------------------------------------ */

const collectionColumns: ImportColumn[] = [
  { key: "slug", label: "URL Slug", required: true, example: "festive-edit", example2: "gifting-edit", hint: "Lowercase letters, numbers and hyphens. Identifies the collection — keep it stable." },
  { key: "name", label: "Name", required: true, example: "Festive Edit", example2: "Gifting Edit", hint: "Shown on the collection page and in menus." },
  { key: "eyebrow", label: "Eyebrow", example: "Diwali 2026", example2: "", hint: "Optional short line above the title." },
  { key: "description", label: "Description", example: "Pieces chosen for the festive season.", example2: "", hint: "Optional. Up to 600 characters." },
  { key: "imageUrl", label: "Image URL", field: "image", example: "https://example.com/festive.jpg", example2: "https://example.com/gifting.jpg", hint: "Required for new collections. Web link to the banner image." },
  { key: "imageAlt", label: "Image Description", field: "image", example: "Festive gold jewellery", example2: "", hint: "Optional. Describes the image for screen readers." },
  { key: "displayOrder", label: "Display Order", example: "1", example2: "2", hint: displayOrderHint },
  { key: "active", label: "Active", example: "yes", example2: "yes", hint: activeHint },
];

const collectionColumnOf = resolver(collectionColumns);

export const collectionImport = defineImport<{ seen: Map<string, number> }, TaxonomyPlan>({
  entity: "collections",
  label: "Collections",
  description: "Add or update curated collections, matched on URL slug.",
  module: "products",
  permission: "catalog:manage_taxonomy",
  revalidate: true,
  columns: collectionColumns,

  async prepare() {
    return { seen: new Map<string, number>() };
  },

  async plan(row, state, ctx) {
    const slug = row.text("slug", { required: true, max: 160 })?.toLowerCase();
    if (!slug) return null;
    const seen = state.seen.get(slug);
    if (seen) {
      row.error("slug", `Slug "${slug}" is already on row ${seen} of this file.`);
      return null;
    }
    state.seen.set(slug, row.number);

    const [existing] = await ctx.ex.select().from(collections).where(eq(collections.slug, slug)).limit(1);
    const values = readTaxonomyBasics(row, !existing);
    const eyebrow = row.text("eyebrow", { max: 80 });
    if (eyebrow !== undefined) values.eyebrow = eyebrow;
    if (!row.ok) return null;

    const schema = existing ? partialUpdate(collectionSchema) : collectionSchema;
    const parsed = schema.safeParse(existing ? values : { ...values, slug });
    if (!parsed.success) {
      reportIssues(row, parsed.error.issues, collectionColumnOf);
      return null;
    }
    const data = parsed.data as Record<string, unknown>;
    if (!existing) return { row: row.number, action: "create", summary: `${slug} — new collection “${String(data.name)}”`, id: null, values: { ...data, slug } };
    const differences = changed(existing as unknown as Record<string, unknown>, data);
    if (!differences.length) return { row: row.number, action: "skip", summary: `${slug} — already up to date`, id: existing.id, values: {} };
    return { row: row.number, action: "update", summary: `${slug} — updates ${differences.map(collectionColumnOf).join(", ")}`, id: existing.id, values: data };
  },

  async apply(plan, _state, ctx) {
    if (plan.action === "skip") return;
    if (!plan.id) {
      await ctx.tx.insert(collections).values(plan.values as typeof collections.$inferInsert);
      return;
    }
    await ctx.tx
      .update(collections)
      .set({ ...plan.values, updatedAt: new Date() })
      .where(eq(collections.id, plan.id));
  },
});
