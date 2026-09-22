import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminToken, setupApp } from "./helpers";

type Ctx = Awaited<ReturnType<typeof setupApp>>;
let ctx: Ctx;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Summary {
  id: string;
  name: string;
  finalPrice: number;
  metal: string;
  parent: { id: string; slug: string; name: string; variantCount: number; priceFrom: number; priceTo: number } | null;
}

let superAdmin: string;
const ids: Record<string, string> = {};
const slugs: Record<string, string> = {};
const prices: Record<string, number> = {};
let rings = "";
let festive = "";
let baselineRings = 0;
let baselineGoldRings = 0;
let baselineGoldFacet = 0;
let parentId = "";

const SKUS = { A: "G22K-RG-1001", B: "S925-RG-2034", C: "G18K-RG-1002", D: "G22K-RG-1004", E: "S925-RG-2035" } as const;

async function listing(query: string) {
  const response = await ctx.api().get(`/v1/products?${query}`);
  expect(response.status).toBe(200);
  return response.body as { items: Summary[]; total: number; totalPages: number; facets: { metals: { value: string; count: number }[] } };
}

beforeAll(async () => {
  ctx = await setupApp();
  superAdmin = await adminToken(ctx.app, "superadmin@example.com");
  for (const [key, sku] of Object.entries(SKUS)) {
    const found = await ctx.api().get(`/v1/admin/products?q=${sku}`).set(auth(superAdmin));
    const row = found.body.items.find((item: { sku: string }) => item.sku === sku);
    ids[key] = row.id;
    slugs[key] = row.slug;
    prices[key] = (await ctx.api().get(`/v1/products/${row.slug}`)).body.finalPrice;
  }
  const categories = await ctx.api().get("/v1/admin/categories").set(auth(superAdmin));
  rings = categories.body.find((c: { slug: string }) => c.slug === "rings").id;
  const collections = await ctx.api().get("/v1/admin/collections").set(auth(superAdmin));
  festive = collections.body.find((c: { slug: string }) => c.slug === "festive-edit").id;
  baselineRings = (await listing("category=rings&pageSize=48")).total;
  baselineGoldRings = (await listing("category=rings&metal=gold&pageSize=48")).total;
  baselineGoldFacet = (await listing("pageSize=1")).facets.metals.find((m) => m.value === "gold")!.count;
}, 180_000);

afterAll(async () => {
  await ctx?.connection.close();
});

describe("parent products — draft", () => {
  it("creates a draft parent with ordered, labelled variants", async () => {
    const response = await ctx
      .api()
      .post("/v1/admin/parent-products")
      .set(auth(superAdmin))
      .send({
        name: "Aura Solitaire",
        shortDescription: "One design, three metals.",
        description: "The Aura solitaire in gold and silver.",
        categoryId: rings,
        collectionIds: [festive],
        images: [{ url: "https://example.com/aura.jpg", alt: "Aura" }],
        seo: { title: "Aura Solitaire Ring" },
        variants: [{ productId: ids.A }, { productId: ids.B }, { productId: ids.C }],
        defaultVariantId: ids.B,
      });
    expect(response.status).toBe(201);
    parentId = response.body.id;
    expect(response.body).toMatchObject({ slug: "aura-solitaire", name: "Aura Solitaire", status: "draft", defaultVariantId: ids.B, collectionIds: [festive] });
    expect(response.body.variants.map((v: { productId: string }) => v.productId)).toEqual([ids.A, ids.B, ids.C]);
    expect(response.body.variants.map((v: { label: string }) => v.label)).toEqual(["22K Gold", "925 Silver", "18K Gold"]);
    expect(response.body.variants[0]).toMatchObject({ sku: SKUS.A, metal: "gold", purity: "22k", customLabel: null, status: "active", price: prices.A });
    expect(response.body.variants[0].stock).toBeGreaterThan(0);

    const audit = await ctx.api().get(`/v1/admin/audit-logs?entityId=${parentId}`).set(auth(superAdmin));
    expect(audit.body.items.map((entry: { action: string }) => entry.action)).toContain("parent_product.create");
  });

  it("changes nothing on the website while draft", async () => {
    expect((await listing("category=rings&pageSize=48")).total).toBe(baselineRings);
    const detail = await ctx.api().get(`/v1/products/${slugs.A}`);
    expect(detail.body.parent).toBeNull();
    expect(detail.body.variants).toEqual([]);
    expect(detail.body.name).not.toBe("Aura Solitaire");
    expect((await ctx.api().get("/v1/products/aura-solitaire")).status).toBe(404);
    const slugList = await ctx.api().get("/v1/products/slugs");
    expect(slugList.body.map((s: { slug: string }) => s.slug)).not.toContain("aura-solitaire");
  });

  it("lists parents and shows the parent on the admin product", async () => {
    const list = await ctx.api().get("/v1/admin/parent-products?search=aura&status=draft").set(auth(superAdmin));
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 1, page: 1 });
    expect(list.body.items[0]).toMatchObject({ id: parentId, slug: "aura-solitaire", status: "draft", category: { id: rings, name: "Rings" }, variantCount: 3, defaultVariantId: ids.B });
    expect(list.body.items[0].image.url).toBe("https://example.com/aura.jpg");

    const product = await ctx.api().get(`/v1/admin/products/${ids.A}`).set(auth(superAdmin));
    expect(product.body.parent).toEqual({ id: parentId, name: "Aura Solitaire" });
    expect(product.body.variantLabel).toBe("22K Gold");
    const rows = await ctx.api().get(`/v1/admin/products?q=${SKUS.A}`).set(auth(superAdmin));
    expect(rows.body.items[0]).toMatchObject({ parent: { id: parentId, name: "Aura Solitaire" }, variantLabel: "22K Gold" });

    const standalone = await ctx.api().get("/v1/admin/products?q=G22K-RG-100&standalone=true&pageSize=50").set(auth(superAdmin));
    const standaloneSkus = standalone.body.items.map((item: { sku: string }) => item.sku);
    expect(standaloneSkus).toContain(SKUS.D);
    expect(standaloneSkus).not.toContain(SKUS.A);
    expect(standalone.body.items[0]).toMatchObject({ parent: null, variantLabel: null });
  });
});

describe("parent products — active on the website", () => {
  it("collapses the parent to one card with the parent's details", async () => {
    const activated = await ctx.api().patch(`/v1/admin/parent-products/${parentId}`).set(auth(superAdmin)).send({ status: "active" });
    expect(activated.status).toBe(200);
    expect(activated.body).toMatchObject({ status: "active", name: "Aura Solitaire", description: "The Aura solitaire in gold and silver." });

    const all = await listing("category=rings&pageSize=48");
    expect(all.total).toBe(baselineRings - 2);
    const cards = all.items.filter((item) => item.parent?.id === parentId);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe(ids.B); // the default variant
    expect(cards[0]!.name).toBe("Aura Solitaire");
    expect(cards[0]!.parent).toEqual({
      id: parentId,
      slug: "aura-solitaire",
      name: "Aura Solitaire",
      variantCount: 3,
      priceFrom: Math.min(prices.A!, prices.B!, prices.C!),
      priceTo: Math.max(prices.A!, prices.B!, prices.C!),
    });
    // Standalone products keep parent: null.
    expect(all.items.find((item) => item.id === ids.D)!.parent).toBeNull();
  });

  it("picks the first matching variant in the sort when the default doesn't match the filters", async () => {
    const gold = await listing("category=rings&metal=gold&sort=price_asc&pageSize=48");
    expect(gold.total).toBe(baselineGoldRings - 1);
    const cards = gold.items.filter((item) => item.parent?.id === parentId);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe(prices.A! <= prices.C! ? ids.A : ids.C);
    const descending = await listing("category=rings&metal=gold&sort=price_desc&pageSize=48");
    expect(descending.items.find((item) => item.parent?.id === parentId)!.id).toBe(prices.A! <= prices.C! ? ids.C : ids.A);
    // Facets count the design once per metal.
    const facets = (await listing("pageSize=1")).facets;
    expect(facets.metals.find((m) => m.value === "gold")!.count).toBe(baselineGoldFacet - 1);
  });

  it("filters on the parent's collections and paginates by card", async () => {
    const festiveList = await listing("collection=festive-edit&pageSize=48");
    expect(festiveList.items.filter((item) => item.parent?.id === parentId)).toHaveLength(1);
    const everyday = await listing("collection=everyday-luxe&pageSize=48");
    expect(everyday.items.map((item) => item.id)).not.toContain(ids.A);

    const pages = await listing("category=rings&pageSize=2&page=1");
    expect(pages.totalPages).toBe(Math.ceil((baselineRings - 2) / 2));
  });

  it("returns ordered variants with labels and engine prices on the product page", async () => {
    const detail = await ctx.api().get(`/v1/products/${slugs.A}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: ids.A, name: "Aura Solitaire", sku: SKUS.A, finalPrice: prices.A, parent: { id: parentId, slug: "aura-solitaire", name: "Aura Solitaire" } });
    expect(detail.body.finalPrice).toBe(41877); // price is untouched by the parent
    expect(detail.body.shortDescription).toBe("One design, three metals.");
    expect(detail.body.collections.map((c: { slug: string }) => c.slug)).toEqual(["festive-edit"]);
    expect(detail.body.seo.title).toBe("Aura Solitaire Ring");
    expect(detail.body.images.length).toBeGreaterThan(0);
    expect(detail.body.variants).toEqual([
      expect.objectContaining({ id: ids.A, slug: slugs.A, sku: SKUS.A, label: "22K Gold", metal: "gold", purity: "22k", price: prices.A }),
      expect.objectContaining({ id: ids.B, slug: slugs.B, sku: SKUS.B, label: "925 Silver", metal: "silver", purity: "925", price: prices.B }),
      expect.objectContaining({ id: ids.C, slug: slugs.C, sku: SKUS.C, label: "18K Gold", metal: "gold", purity: "18k", price: prices.C }),
    ]);
    expect(detail.body.variants[0].availability.purchasable).toBe(true);
    expect(detail.body.variants[0].image.url).toBeTruthy();
  });

  it("resolves the parent slug to the default variant and lists it in slugs", async () => {
    const byParent = await ctx.api().get("/v1/products/aura-solitaire");
    expect(byParent.status).toBe(200);
    expect(byParent.body.id).toBe(ids.B);
    const slugList = await ctx.api().get("/v1/products/slugs");
    expect(slugList.body.map((s: { slug: string }) => s.slug)).toEqual(expect.arrayContaining(["aura-solitaire", slugs.A]));
  });

  it("never relates siblings and shows the parent once in search", async () => {
    const related = await ctx.api().get(`/v1/products/${slugs.A}/related?limit=48`);
    const relatedIds = related.body.map((item: Summary) => item.id);
    expect(relatedIds).not.toContain(ids.B);
    expect(relatedIds).not.toContain(ids.C);
    const search = await ctx.api().get("/v1/search/suggestions?q=aura");
    expect(search.body.total).toBe(1);
    expect(search.body.products[0].parent.id).toBe(parentId);
  });

  it("reorders variants and applies custom labels", async () => {
    const response = await ctx
      .api()
      .put(`/v1/admin/parent-products/${parentId}/variants`)
      .set(auth(superAdmin))
      .send({ variants: [{ productId: ids.C, label: "Diamond Gold" }, { productId: ids.A }, { productId: ids.B }], defaultVariantId: ids.A });
    expect(response.status).toBe(200);
    expect(response.body.defaultVariantId).toBe(ids.A);
    expect(response.body.variants.map((v: { label: string; customLabel: string | null }) => [v.label, v.customLabel])).toEqual([
      ["Diamond Gold", "Diamond Gold"],
      ["22K Gold", null],
      ["925 Silver", null],
    ]);
    const detail = await ctx.api().get(`/v1/products/${slugs.B}`);
    expect(detail.body.variants.map((v: { id: string }) => v.id)).toEqual([ids.C, ids.A, ids.B]);
    expect((await ctx.api().get("/v1/products/aura-solitaire")).body.id).toBe(ids.A);
  });

  it("leaves disabled variants out", async () => {
    expect((await ctx.api().patch(`/v1/admin/products/${ids.C}`).set(auth(superAdmin)).send({ status: "disabled" })).status).toBe(200);
    const detail = await ctx.api().get(`/v1/products/${slugs.A}`);
    expect(detail.body.variants.map((v: { id: string }) => v.id)).toEqual([ids.A, ids.B]);
    const card = (await listing("category=rings&pageSize=48")).items.find((item) => item.parent?.id === parentId)!;
    expect(card.parent!.variantCount).toBe(2);
    expect((await ctx.api().patch(`/v1/admin/products/${ids.C}`).set(auth(superAdmin)).send({ status: "active" })).status).toBe(200);
  });
});

describe("parent products — rules", () => {
  it("rejects duplicate labels, products in another parent and a default outside the set", async () => {
    const clash = await ctx
      .api()
      .put(`/v1/admin/parent-products/${parentId}/variants`)
      .set(auth(superAdmin))
      .send({ variants: [{ productId: ids.A }, { productId: ids.D }] });
    expect(clash.status).toBe(422);
    expect(clash.body.fieldErrors["variants.1"]).toContain("22K Gold");

    const custom = await ctx
      .api()
      .put(`/v1/admin/parent-products/${parentId}/variants`)
      .set(auth(superAdmin))
      .send({ variants: [{ productId: ids.A, label: "Classic" }, { productId: ids.B, label: "classic" }] });
    expect(custom.status).toBe(422);
    expect(custom.body.fieldErrors["variants.1"]).toBeDefined();

    const outside = await ctx
      .api()
      .put(`/v1/admin/parent-products/${parentId}/variants`)
      .set(auth(superAdmin))
      .send({ variants: [{ productId: ids.A }, { productId: ids.B }], defaultVariantId: ids.E });
    expect(outside.status).toBe(422);
    expect(outside.body.fieldErrors.defaultVariantId).toBeDefined();

    const badId = await ctx.api().put(`/v1/admin/parent-products/${parentId}/variants`).set(auth(superAdmin)).send({ variants: [{ productId: "nope" }] });
    expect(badId.status).toBe(422);
    expect(Object.keys(badId.body.fieldErrors)).toEqual(["variants.0"]);

    const taken = await ctx
      .api()
      .post("/v1/admin/parent-products")
      .set(auth(superAdmin))
      .send({ name: "Second Design", categoryId: rings, variants: [{ productId: ids.E }, { productId: ids.A }] });
    expect(taken.status).toBe(422);
    expect(taken.body.fieldErrors["variants.1"]).toContain("Aura Solitaire");
    // Nothing was written.
    expect((await ctx.api().get("/v1/admin/parent-products?search=second").set(auth(superAdmin))).body.total).toBe(0);
  });

  it("keeps slugs unique across parents and products", async () => {
    const parentClash = await ctx.api().post("/v1/admin/parent-products").set(auth(superAdmin)).send({ name: "Clash", slug: slugs.E, categoryId: rings });
    expect(parentClash.status).toBe(422);
    expect(parentClash.body.fieldErrors.slug).toContain("product");

    const productClash = await ctx.api().patch(`/v1/admin/products/${ids.E}`).set(auth(superAdmin)).send({ slug: "aura-solitaire" });
    expect(productClash.status).toBe(422);
    expect(productClash.body.fieldErrors.slug).toContain("Aura Solitaire");

    const other = await ctx.api().post("/v1/admin/parent-products").set(auth(superAdmin)).send({ name: "Aura Solitaire", categoryId: rings });
    expect(other.status).toBe(201);
    expect(other.body.slug).toBe("aura-solitaire-2");
    const renamed = await ctx.api().patch(`/v1/admin/parent-products/${other.body.id}`).set(auth(superAdmin)).send({ slug: "aura-solitaire" });
    expect(renamed.status).toBe(422);
    expect(renamed.body.fieldErrors.slug).toBeDefined();
    expect((await ctx.api().delete(`/v1/admin/parent-products/${other.body.id}`).set(auth(superAdmin))).status).toBe(204);
  });

  it("keeps PATCH partial", async () => {
    const response = await ctx.api().patch(`/v1/admin/parent-products/${parentId}`).set(auth(superAdmin)).send({ name: "Aura Solitaire" });
    expect(response.status).toBe(200);
    expect(response.body.seo).toEqual({ title: "Aura Solitaire Ring" });
    expect(response.body.collectionIds).toEqual([festive]);
    expect(response.body.status).toBe("active");
  });

  it("enforces permissions", async () => {
    const sales = await adminToken(ctx.app, "sales@example.com"); // products:view only
    const inventory = await adminToken(ctx.app, "inventory@example.com"); // products:create, no edit_content
    const content = await adminToken(ctx.app, "content@example.com"); // create + edit_content, no delete

    expect((await ctx.api().get("/v1/admin/parent-products").set(auth(sales))).status).toBe(200);
    expect((await ctx.api().get(`/v1/admin/parent-products/${parentId}`).set(auth(sales))).status).toBe(200);
    expect((await ctx.api().post("/v1/admin/parent-products").set(auth(sales)).send({ name: "X", categoryId: rings })).status).toBe(403);
    expect((await ctx.api().patch(`/v1/admin/parent-products/${parentId}`).set(auth(inventory)).send({ name: "X" })).status).toBe(403);
    expect((await ctx.api().put(`/v1/admin/parent-products/${parentId}/variants`).set(auth(inventory)).send({ variants: [] })).status).toBe(403);
    expect((await ctx.api().delete(`/v1/admin/parent-products/${parentId}`).set(auth(content))).status).toBe(403);
    expect((await ctx.api().patch(`/v1/admin/parent-products/${parentId}`).set(auth(content)).send({ shortDescription: "Edited by content" })).status).toBe(200);
    expect((await ctx.api().get("/v1/admin/parent-products")).status).toBe(401);
  });

  it("deletes the parent without deleting its products", async () => {
    const response = await ctx.api().delete(`/v1/admin/parent-products/${parentId}`).set(auth(superAdmin));
    expect(response.status).toBe(204);
    expect((await ctx.api().get(`/v1/admin/parent-products/${parentId}`).set(auth(superAdmin))).status).toBe(404);
    for (const key of ["A", "B", "C"]) {
      const product = await ctx.api().get(`/v1/admin/products/${ids[key]}`).set(auth(superAdmin));
      expect(product.status).toBe(200);
      expect(product.body).toMatchObject({ parent: null, variantLabel: null, status: "active" });
    }
    expect((await listing("category=rings&pageSize=48")).total).toBe(baselineRings);
    const detail = await ctx.api().get(`/v1/products/${slugs.A}`);
    expect(detail.body).toMatchObject({ parent: null, variants: [] });
    expect((await ctx.api().get("/v1/products/aura-solitaire")).status).toBe(404);
    const audit = await ctx.api().get(`/v1/admin/audit-logs?entityId=${parentId}`).set(auth(superAdmin));
    expect(audit.body.items.map((entry: { action: string }) => entry.action)).toEqual(
      expect.arrayContaining(["parent_product.create", "parent_product.update", "parent_product.variants", "parent_product.delete"]),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Bulk import                                                         */
/* ------------------------------------------------------------------ */

const csv = (rows: string[][]) => Buffer.from(rows.map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(",")).join("\r\n"), "utf8");

function upload(entity: string, file: Buffer, mode: "preview" | "commit" = "preview") {
  return ctx
    .api()
    .post(`/v1/admin/imports/${entity}?mode=${mode}`)
    .set(auth(superAdmin))
    .attach("file", file, { filename: "import.csv", contentType: "text/csv" });
}

const PARENT_HEADER = ["Name", "URL Slug", "Category", "Collections", "Short Description", "Status", "Variant SKUs", "Default Variant SKU"];

describe("parent products — bulk import", () => {
  it("offers the parent-products template columns", async () => {
    const list = await ctx.api().get("/v1/admin/imports").set(auth(superAdmin));
    const entry = list.body.items.find((item: { entity: string }) => item.entity === "parent-products");
    expect(entry).toMatchObject({ permission: "products:create" });
    expect(entry.columns.map((c: { label: string }) => c.label)).toEqual([
      "Name",
      "URL Slug",
      "Category",
      "Subcategory",
      "Collections",
      "Short Description",
      "Description",
      "Image URLs",
      "SEO Title",
      "SEO Description",
      "Status",
      "Variant SKUs",
      "Default Variant SKU",
    ]);
    const products = list.body.items.find((item: { entity: string }) => item.entity === "products");
    expect(products.columns.map((c: { label: string }) => c.label)).toEqual(expect.arrayContaining(["Parent Product", "Variant Label"]));
  });

  it("previews, rejects bad rows and commits parent products", async () => {
    const bad = csv([
      PARENT_HEADER,
      ["Import Duo", "import-duo", "Rings", "", "", "active", "S925-RG-2036, G22K-RG-1006", "G22K-RG-1006"],
      ["Broken", "", "Rings", "", "", "", "NOPE-1, G22K-RG-1006", "S925-RG-2036"],
      ["Clashing", "", "Rings", "", "", "", "G22K-RG-1003, G22K-RG-1004", ""],
    ]);
    const rejected = await upload("parent-products", bad, "commit");
    expect(rejected.status).toBe(422);
    expect(rejected.body.errors).toEqual(
      expect.arrayContaining([
        { row: 3, column: "Variant SKUs", message: expect.stringContaining("NOPE-1 not found") },
        { row: 3, column: "Variant SKUs", message: expect.stringContaining("row 2") },
        { row: 3, column: "Default Variant SKU", message: expect.stringContaining("S925-RG-2036") },
        { row: 4, column: "Variant SKUs", message: expect.stringContaining("22K Gold") },
      ]),
    );
    expect((await ctx.api().get("/v1/admin/parent-products?search=import").set(auth(superAdmin))).body.total).toBe(0);

    const good = csv([PARENT_HEADER, ["Import Duo", "import-duo", "Rings", "Festive Edit", "Imported design", "active", "S925-RG-2036, G22K-RG-1006", "G22K-RG-1006"]]);
    const preview = await upload("parent-products", good);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ valid: 1, invalid: 0, created: 0 });
    const commit = await upload("parent-products", good, "commit");
    expect(commit.status).toBe(200);
    expect(commit.body).toMatchObject({ created: 1, updated: 0 });

    const list = await ctx.api().get("/v1/admin/parent-products?search=import-duo").set(auth(superAdmin));
    const parent = await ctx.api().get(`/v1/admin/parent-products/${list.body.items[0].id}`).set(auth(superAdmin));
    expect(parent.body).toMatchObject({ slug: "import-duo", status: "active", shortDescription: "Imported design", collectionIds: [festive] });
    expect(parent.body.variants.map((v: { sku: string }) => v.sku)).toEqual(["S925-RG-2036", "G22K-RG-1006"]);
    expect(parent.body.defaultVariantId).toBe(parent.body.variants[1].productId);

    // The same file again changes nothing.
    const again = await upload("parent-products", good, "commit");
    expect(again.body).toMatchObject({ created: 0, updated: 0, skipped: 1 });

    // A product already in a parent can't join another.
    const moved = await upload("parent-products", csv([PARENT_HEADER, ["Other Duo", "", "Rings", "", "", "", "G22K-RG-1006", ""]]));
    expect(moved.body.errors[0]).toMatchObject({ column: "Variant SKUs", message: expect.stringContaining("Import Duo") });
  });

  it("attaches products to a parent with the new product columns", async () => {
    const header = ["SKU", "Parent Product", "Variant Label"];
    const bad = await upload(
      "products",
      csv([header, ["G22K-RG-1003", "no-such-design", ""], ["G22K-RG-1004", "import-duo", ""], ["G18K-RG-1005", "", "Lonely"]]),
    );
    expect(bad.body.errors).toEqual(
      expect.arrayContaining([
        { row: 2, column: "Parent Product", message: expect.stringContaining("not found") },
        { row: 3, column: "Parent Product", message: expect.stringContaining("22K Gold") },
        { row: 4, column: "Variant Label", message: expect.stringContaining("needs a parent product") },
      ]),
    );

    const good = csv([header, ["G22K-RG-1003", "import-duo", "Twin Bands"]]);
    const commit = await upload("products", good, "commit");
    expect(commit.status).toBe(200);
    expect(commit.body).toMatchObject({ updated: 1 });
    const found = await ctx.api().get("/v1/admin/products?q=G22K-RG-1003").set(auth(superAdmin));
    expect(found.body.items[0]).toMatchObject({ parent: { name: "Import Duo" }, variantLabel: "Twin Bands" });

    const detail = await ctx.api().get(`/v1/products/${found.body.items[0].slug}`);
    expect(detail.body.variants.map((v: { sku: string; label: string }) => [v.sku, v.label])).toEqual([
      ["S925-RG-2036", "925 Silver"],
      ["G22K-RG-1006", "22K Gold"],
      ["G22K-RG-1003", "Twin Bands"],
    ]);

    // A product slug can't take a parent's slug.
    const slugClash = await upload("products", csv([["SKU", "URL Slug"], ["G18K-RG-1005", "import-duo"]]));
    expect(slugClash.body.errors[0]).toMatchObject({ column: "URL Slug", message: expect.stringContaining("Import Duo") });
  });
});
