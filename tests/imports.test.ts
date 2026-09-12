import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminToken, setupApp } from "./helpers";

type Ctx = Awaited<ReturnType<typeof setupApp>>;
let ctx: Ctx;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
}, 180_000);

afterAll(async () => {
  await ctx?.connection.close();
});

/** Builds a real .xlsx in memory, the way staff would hand one to the API. */
async function xlsx(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const csv = (rows: string[][]) => Buffer.from(rows.map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(",")).join("\r\n"), "utf8");

function upload(token: string, entity: string, file: Buffer, { name = "import.xlsx", mode = "preview" as "preview" | "commit" } = {}) {
  return ctx
    .api()
    .post(`/v1/admin/imports/${entity}?mode=${mode}`)
    .set(auth(token))
    .attach("file", file, { filename: name, contentType: "application/octet-stream" });
}

const PRODUCT_HEADER = ["SKU", "Name", "Category", "Metal", "Purity", "Net Weight (g)", "Making Charge Type", "Making Charge Value", "Short Description"];
const productRow = (sku: string, name: string, category = "Rings") => [sku, name, category, "gold", "22k", "3.5", "per_gram", "900", ""];

async function findBySku(token: string, sku: string) {
  const response = await ctx.api().get(`/v1/admin/products?q=${sku}`).set(auth(token));
  return response.body.items.find((item: { sku: string }) => item.sku === sku) ?? null;
}

describe("bulk import — templates and listing", () => {
  it("lists only the imports an admin may use", async () => {
    const superAdmin = await adminToken(ctx.app, "superadmin@example.com");
    const content = await adminToken(ctx.app, "content@example.com");

    const all = await ctx.api().get("/v1/admin/imports").set(auth(superAdmin));
    expect(all.status).toBe(200);
    expect(all.body.items.map((entry: { entity: string }) => entry.entity)).toEqual([
      "products",
      "inventory",
      "customers",
      "vendors",
      "expenses",
      "categories",
      "subcategories",
      "collections",
      "coupons",
      "metal-rates",
    ]);
    const products = all.body.items.find((entry: { entity: string }) => entry.entity === "products");
    expect(products).toMatchObject({ permission: "products:create", rowLimit: 2000 });
    expect(products.columns[0]).toMatchObject({ key: "sku", label: "SKU", required: true });
    expect(products.columns.some((column: { key: string }) => column.key === "purchasePrice")).toBe(true);

    const allowed = await ctx.api().get("/v1/admin/imports").set(auth(content));
    const entities = allowed.body.items.map((entry: { entity: string }) => entry.entity);
    expect(entities).toContain("products");
    expect(entities).not.toContain("inventory");
    expect(entities).not.toContain("expenses");
    // Confidential columns aren't offered to staff who may not fill them in.
    const contentProducts = allowed.body.items.find((entry: { entity: string }) => entry.entity === "products");
    expect(contentProducts.columns.some((column: { key: string }) => column.key === "purchasePrice")).toBe(false);
  });

  it("downloads a product template with example rows and an Instructions sheet", async () => {
    const token = await adminToken(ctx.app, "superadmin@example.com");
    const response = await ctx.api().get("/v1/admin/imports/products/template").set(auth(token)).buffer(true).parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="abhishek-silver-products-import-template.xlsx"');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as never);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.getRow(1).getCell(1).value).toBe("SKU");
    expect(sheet.rowCount).toBe(3);
    const guide = workbook.getWorksheet("Instructions")!;
    expect(guide.getRow(1).getCell(1).value).toBe("Column");
    expect(guide.getRow(2).getCell(2).value).toBe("Required");

    const asCsv = await ctx.api().get("/v1/admin/imports/products/template?format=csv").set(auth(token));
    expect(asCsv.headers["content-type"]).toContain("text/csv");
    expect(asCsv.text.split("\r\n")[0]).toContain("SKU");
  });
});

describe("bulk import — preview and commit", () => {
  it("reports problems row by row and writes nothing in preview", async () => {
    const token = await adminToken(ctx.app, "superadmin@example.com");
    const file = await xlsx([
      PRODUCT_HEADER,
      productRow("IMP-PREVIEW-1", "Import preview band"),
      ["IMP-PREVIEW-2", "Bad category", "Rngs", "gold", "22k", "3.5", "per_gram", "900", ""],
      ["IMP-PREVIEW-3", "Bad weight", "Rings", "gold", "22k", "heavy", "per_gram", "900", ""],
      ["", "", "", "", "", "", "", "", ""],
    ]);
    const response = await upload(token, "products", file, { name: "new-products.xlsx" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ entity: "products", mode: "preview", fileName: "new-products.xlsx", totalRows: 3, valid: 1, invalid: 2, created: 0, updated: 0, skipped: 0 });
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        { row: 3, column: "Category", message: expect.stringContaining('Category "Rngs" not found') },
        { row: 4, column: "Net Weight (g)", message: "Net Weight (g) must be a number." },
      ]),
    );
    expect(response.body.sample).toEqual([{ row: 2, action: "create", summary: expect.stringContaining("IMP-PREVIEW-1") }]);
    expect(await findBySku(token, "IMP-PREVIEW-1")).toBeNull();
  });

  it("commits a clean file: new products are created and existing ones updated", async () => {
    const token = await adminToken(ctx.app, "superadmin@example.com");
    const file = await xlsx([
      [...PRODUCT_HEADER, "Collections", "Status"],
      [...productRow("IMP-NEW-1", "Imported gold band"), "Everyday Luxe", "draft"],
      ["G22K-RG-1001", "", "", "", "", "", "", "", "Updated by the September import", "", ""],
    ]);

    const preview = await upload(token, "products", file, { name: "catalogue.xlsx" });
    expect(preview.body).toMatchObject({ valid: 2, invalid: 0, created: 0 });
    expect(preview.body.sample.map((entry: { action: string }) => entry.action)).toEqual(["create", "update"]);

    const commit = await upload(token, "products", file, { name: "catalogue.xlsx", mode: "commit" });
    expect(commit.status).toBe(200);
    expect(commit.body).toMatchObject({ mode: "commit", totalRows: 2, valid: 2, invalid: 0, created: 1, updated: 1, skipped: 0 });

    const created = await findBySku(token, "IMP-NEW-1");
    expect(created).toMatchObject({ name: "Imported gold band", metal: "gold", purity: "22k", status: "draft" });
    const detail = await ctx.api().get(`/v1/admin/products/${created.id}`).set(auth(token));
    expect(detail.body.slug).toBe("imported-gold-band");
    expect(detail.body.collectionIds).toHaveLength(1);

    const updated = await findBySku(token, "G22K-RG-1001");
    const updatedDetail = await ctx.api().get(`/v1/admin/products/${updated.id}`).set(auth(token));
    expect(updatedDetail.body.shortDescription).toBe("Updated by the September import");
    expect(updatedDetail.body.name).toBe("Aaravi Filigree Gold Band");

    // Re-importing the same file changes nothing.
    const again = await upload(token, "products", file, { name: "catalogue.xlsx", mode: "commit" });
    expect(again.body).toMatchObject({ created: 0, updated: 0, skipped: 2 });

    const audit = await ctx.api().get("/v1/admin/audit-logs?module=products").set(auth(token));
    expect(audit.body.items.some((entry: { action: string; entityLabel: string }) => entry.action === "import" && entry.entityLabel === "catalogue.xlsx")).toBe(true);
  });

  it("writes nothing when any row is invalid", async () => {
    const token = await adminToken(ctx.app, "superadmin@example.com");
    const file = await xlsx([PRODUCT_HEADER, productRow("IMP-ROLLBACK-1", "Good row"), ["IMP-ROLLBACK-2", "No category", "Nowhere", "gold", "22k", "3.5", "per_gram", "900", ""]]);

    const response = await upload(token, "products", file, { mode: "commit" });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ mode: "commit", totalRows: 2, valid: 1, invalid: 1, created: 0, updated: 0, skipped: 0 });
    expect(response.body.errors[0]).toMatchObject({ row: 3, column: "Category" });
    expect(await findBySku(token, "IMP-ROLLBACK-1")).toBeNull();
  });

  it("moves stock through the stock engine, keeping movements and levels correct", async () => {
    const token = await adminToken(ctx.app, "inventory@example.com");
    const product = (await ctx.api().get("/v1/products/aaravi-filigree-gold-band")).body as { id: string };
    const before = await ctx.api().get(`/v1/admin/inventory/${product.id}`).set(auth(token));

    const file = csv([
      ["SKU", "Location", "Movement", "Quantity", "Reason"],
      ["G22K-RG-1001", "Main store", "add", "4", "Stock received from workshop"],
      ["g22k-rg-1001", "Main store", "reduce", "1", "Damaged piece returned to workshop"],
    ]);
    const preview = await upload(token, "inventory", file, { name: "stock.csv" });
    expect(preview.body).toMatchObject({ valid: 2, invalid: 0 });
    expect(preview.body.sample[1].summary).toContain("→");

    const commit = await upload(token, "inventory", file, { name: "stock.csv", mode: "commit" });
    expect(commit.status).toBe(200);
    expect(commit.body).toMatchObject({ created: 2, updated: 0, skipped: 0 });

    const after = await ctx.api().get(`/v1/admin/inventory/${product.id}`).set(auth(token));
    expect(after.body.total).toBe(before.body.total + 3);
    const movements = after.body.movements as { type: string; quantityDelta: number; reason: string; referenceLabel: string }[];
    expect(movements[0]).toMatchObject({ type: "reduce", quantityDelta: -1, reason: "Damaged piece returned to workshop", referenceLabel: "Import: stock.csv" });
    expect(movements[1]).toMatchObject({ type: "add", quantityDelta: 4 });

    const tooMuch = csv([
      ["SKU", "Location", "Movement", "Quantity", "Reason"],
      ["G22K-RG-1001", "Main store", "reduce", "9999", "Stock take"],
    ]);
    const rejected = await upload(token, "inventory", tooMuch, { name: "stock.csv", mode: "commit" });
    expect(rejected.status).toBe(422);
    expect(rejected.body.errors[0].message).toContain("in stock at Main store");
  });

  it("reads Excel dates and numbers typed as text when importing expenses", async () => {
    const token = await adminToken(ctx.app, "superadmin@example.com");
    const category = await ctx.api().post("/v1/admin/expense-categories").set(auth(token)).send({ name: "Shop rent" });
    expect(category.status).toBe(201);

    const file = await xlsx([
      ["Date", "Category", "Amount", "Payment Method", "Paid To", "Description"],
      [new Date(Date.UTC(2026, 8, 1)), "Shop rent", "25,000", "bank_transfer", "Ratna Estates", "Shop rent for September"],
    ]);
    const commit = await upload(token, "expenses", file, { name: "september-expenses.xlsx", mode: "commit" });
    expect(commit.status).toBe(200);
    expect(commit.body).toMatchObject({ created: 1, invalid: 0 });

    const list = await ctx.api().get("/v1/admin/expenses?q=Ratna").set(auth(token));
    expect(list.body.items[0]).toMatchObject({ expenseDate: "2026-09-01", totalAmount: 25000, payee: "Ratna Estates", status: "draft" });
  });
});

describe("bulk import — the remaining sections", () => {
  it("imports taxonomy, coupons, metal rates, customers and suppliers", async () => {
    const token = await adminToken(ctx.app, "superadmin@example.com");
    const commit = (entity: string, rows: string[][], name: string) => upload(token, entity, csv(rows), { name, mode: "commit" });

    const categories = await commit(
      "categories",
      [
        ["URL Slug", "Name", "Group", "Image URL", "Display Order"],
        ["anklets", "Anklets", "type", "https://example.com/anklets.jpg", "12"],
      ],
      "categories.csv",
    );
    expect(categories.body).toMatchObject({ created: 1, invalid: 0 });

    const missingRule = await upload(
      token,
      "categories",
      csv([
        ["URL Slug", "Name", "Group", "Image URL"],
        ["festive-gold", "Festive Gold", "metal", "https://example.com/festive.jpg"],
      ]),
      { name: "categories.csv" },
    );
    expect(missingRule.body.errors[0]).toMatchObject({ column: "Lists Metal" });

    const subcategories = await commit(
      "subcategories",
      [
        ["Category", "URL Slug", "Name"],
        ["Anklets", "payal", "Payal"],
      ],
      "subcategories.csv",
    );
    expect(subcategories.body).toMatchObject({ created: 1, invalid: 0 });
    const taxonomy = await ctx.api().get("/v1/admin/categories").set(auth(token));
    const anklets = taxonomy.body.find((category: { slug: string }) => category.slug === "anklets");
    expect(anklets.subcategories).toHaveLength(1);

    const collections = await commit(
      "collections",
      [
        ["URL Slug", "Name", "Image URL"],
        ["monsoon-edit", "Monsoon Edit", "https://example.com/monsoon.jpg"],
      ],
      "collections.csv",
    );
    expect(collections.body).toMatchObject({ created: 1, invalid: 0 });

    const rates = await commit(
      "metal-rates",
      [
        ["Metal", "Purity", "Rate Per Gram", "Reason"],
        ["gold", "22k", "9700", "Morning rate, 12 September"],
      ],
      "rates.csv",
    );
    expect(rates.body).toMatchObject({ updated: 1, invalid: 0 });
    const pricing = await ctx.api().get("/v1/admin/pricing").set(auth(token));
    expect(pricing.body.rates.find((rate: { purity: string }) => rate.purity === "22k").ratePerGram).toBe(9700);
    const history = await ctx.api().get("/v1/admin/pricing/history?kind=metal_rate").set(auth(token));
    expect(history.body.items[0]).toMatchObject({ reason: "Morning rate, 12 September", label: "22KT gold" });

    const coupons = await commit(
      "coupons",
      [
        ["Code", "Description", "Type", "Value", "Applies To Categories", "Ends On"],
        ["IMPORT10", "Ten percent off imported pieces", "percentage", "10", "rings", "2026-12-31"],
      ],
      "coupons.csv",
    );
    expect(coupons.body).toMatchObject({ created: 1, invalid: 0 });
    const couponList = await ctx.api().get("/v1/admin/coupons?q=IMPORT10").set(auth(token));
    expect(couponList.body.items[0]).toMatchObject({ code: "IMPORT10", value: 10, state: "active" });

    const customers = [
      ["Name", "Email", "Mobile", "Marketing Opt-In"],
      ["Asha Patel", "asha.import@example.com", "9876500111", "yes"],
    ];
    expect((await commit("customers", customers, "customers.csv")).body).toMatchObject({ created: 1, invalid: 0 });
    expect((await commit("customers", customers, "customers.csv")).body).toMatchObject({ created: 0, skipped: 1 });
    const renamed = await commit(
      "customers",
      [
        ["Name", "Email", "Mobile", "Marketing Opt-In"],
        ["Asha Mehta", "asha.import@example.com", "9876500111", "no"],
      ],
      "customers.csv",
    );
    expect(renamed.body).toMatchObject({ updated: 1 });
    const customerList = await ctx.api().get("/v1/admin/customers?q=asha.import").set(auth(token));
    expect(customerList.body.items[0]).toMatchObject({ name: "Asha Mehta", marketingOptIn: false });

    const vendors = await commit(
      "vendors",
      [
        ["Name", "Mobile", "Status"],
        ["Surat Gold Works", "9825012345", "active"],
      ],
      "suppliers.csv",
    );
    expect(vendors.body).toMatchObject({ created: 1, invalid: 0 });
    const vendorList = await ctx.api().get("/v1/admin/vendors?q=Surat Gold").set(auth(token));
    expect(vendorList.body.items[0]).toMatchObject({ name: "Surat Gold Works", mobile: "9825012345" });
  });
});

describe("bulk import — permissions and file checks", () => {
  it("refuses an entity the admin has no permission for", async () => {
    const content = await adminToken(ctx.app, "content@example.com");
    const file = csv([
      ["SKU", "Location", "Movement", "Quantity", "Reason"],
      ["G22K-RG-1001", "Main store", "add", "1", "Test"],
    ]);
    expect((await upload(content, "inventory", file, { name: "stock.csv" })).status).toBe(403);
    expect((await ctx.api().get("/v1/admin/imports/inventory/template").set(auth(content))).status).toBe(403);
    expect((await ctx.api().get("/v1/admin/imports/unicorns/template").set(auth(content))).status).toBe(404);
  });

  it("rejects confidential columns from admins who may not see them", async () => {
    const content = await adminToken(ctx.app, "content@example.com");
    const file = csv([
      [...PRODUCT_HEADER, "Purchase Cost"],
      [...productRow("IMP-CONF-1", "Confidential column").map(String), "18000"],
    ]);
    const response = await upload(content, "products", file, { name: "products.csv" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ valid: 0, invalid: 1 });
    expect(response.body.errors[0]).toMatchObject({ row: 2, column: "Purchase Cost", message: expect.stringContaining("don't have permission") });
  });

  it("applies the product form's field permissions to the fields a row changes", async () => {
    const content = await adminToken(ctx.app, "content@example.com");
    const priced = csv([
      ["SKU", "Making Charge Value"],
      ["G22K-RG-1001", "1000"],
    ]);
    const denied = await upload(content, "products", priced, { name: "prices.csv" });
    expect(denied.body).toMatchObject({ valid: 0, invalid: 1 });
    expect(denied.body.errors[0]).toMatchObject({ row: 2, column: "Making Charge Value", message: expect.stringContaining("permission") });

    // The same column at its current value changes nothing, so no pricing permission is needed.
    const unchanged = csv([
      ["SKU", "Making Charge Value", "Short Description"],
      ["G22K-RG-1001", "950", "Autumn campaign copy"],
    ]);
    const allowed = await upload(content, "products", unchanged, { name: "copy.csv" });
    expect(allowed.body).toMatchObject({ valid: 1, invalid: 0 });
    expect(allowed.body.sample[0].summary).toContain("Short Description");
  });

  it("rejects files that are too large, too long or have the wrong columns", async () => {
    const token = await adminToken(ctx.app, "superadmin@example.com");

    const big = Buffer.alloc(5 * 1024 * 1024 + 1024, "x");
    const oversized = await upload(token, "products", big, { name: "huge.csv" });
    expect(oversized.status).toBe(422);
    expect(oversized.body.message).toContain("5 MB");

    const many = csv([PRODUCT_HEADER, ...Array.from({ length: 2001 }, (_, index) => productRow(`IMP-BULK-${index}`, `Row ${index}`).map(String))]);
    const tooLong = await upload(token, "products", many, { name: "long.csv" });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.message).toContain("2,001 rows");

    const wrong = csv([
      ["Item Code", "Title", "Cost"],
      ["A1", "Something", "100"],
    ]);
    const badHeaders = await upload(token, "products", wrong, { name: "wrong.csv" });
    expect(badHeaders.status).toBe(422);
    expect(badHeaders.body.message).toContain("SKU");
    expect(badHeaders.body.message).toContain("Item Code");

    const notASpreadsheet = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0x01]);
    const wrongType = await upload(token, "products", notASpreadsheet, { name: "catalogue.xlsx" });
    expect(wrongType.status).toBe(422);
    expect(wrongType.body.message).toContain("Excel");
  });
});
