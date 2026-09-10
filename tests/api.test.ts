import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { address, adminToken, setupApp } from "./helpers";

type Ctx = Awaited<ReturnType<typeof setupApp>>;
let ctx: Ctx;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const round2 = (value: number) => Math.round(value * 100) / 100;

beforeAll(async () => {
  ctx = await setupApp();
}, 180_000);

afterAll(async () => {
  await ctx?.connection.close();
});

async function referenceProduct() {
  const response = await ctx.api().get("/v1/products/aaravi-filigree-gold-band");
  expect(response.status).toBe(200);
  return response.body as { id: string; slug: string; finalPrice: number };
}

describe("storefront API", () => {
  it("lists the catalogue without confidential or internal fields", async () => {
    const response = await ctx.api().get("/v1/products?base=gold-jewellery&pageSize=5");
    expect(response.status).toBe(200);
    expect(response.body.total).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toMatch(/purchasePrice|vendorId|stockVersion|lowStockThreshold|"stock":/);
  });

  it("prices the reference product exactly like the storefront engine", async () => {
    const product = await referenceProduct();
    expect(product.finalPrice).toBe(41877);
  });

  it("runs checkout end to end: quote → order → verified payment → stock, sale and invoice", async () => {
    const product = await referenceProduct();
    const items = [{ productId: product.id, slug: product.slug, size: "14", quantity: 2 }];

    const quote = await ctx.api().post("/v1/cart/quote").send({ items, couponCode: "WELCOME5" });
    expect(quote.status).toBe(200);
    expect(quote.body.coupon.discount).toBeGreaterThan(0);
    expect(quote.body.totals.grandTotal).toBe(quote.body.totals.subtotal - quote.body.totals.couponDiscount + quote.body.totals.shipping);

    const token = await adminToken(ctx.app, "superadmin@example.com");
    const before = await ctx.api().get(`/v1/admin/inventory/${product.id}`).set(auth(token));

    const created = await ctx
      .api()
      .post("/v1/orders")
      .send({ items, couponCode: "WELCOME5", customer: { name: "Test Buyer", email: "buyer@example.com", phone: "9876543210" }, shippingAddress: address, billingAddress: address });
    expect(created.status).toBe(201);
    expect(created.body.order.totals.grandTotal).toBe(quote.body.totals.grandTotal);
    expect(created.body.order.payment.status).toBe("pending");

    const verify = () =>
      ctx
        .api()
        .post(`/v1/orders/${created.body.order.id}/payments/verify`)
        .send({ providerOrderId: created.body.paymentIntent.providerOrderId, providerPaymentId: "pay_test_1", signature: "demo_valid_signature" });
    const paid = await verify();
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe("confirmed");
    expect(paid.body.payment.status).toBe("paid");
    // Verifying twice (e.g. browser callback + webhook) must not double-book.
    expect((await verify()).status).toBe(200);

    const after = await ctx.api().get(`/v1/admin/inventory/${product.id}`).set(auth(token));
    expect(after.body.total).toBe(before.body.total - 2);

    const list = await ctx.api().get("/v1/admin/invoices?source=online_order").set(auth(token));
    expect(list.body.total).toBe(1);
    const invoice = await ctx.api().get(`/v1/admin/invoices/${list.body.items[0].id}`).set(auth(token));
    const lineSum = invoice.body.items.reduce((sum: number, line: { lineTotal: number }) => sum + line.lineTotal, 0);
    expect(invoice.body.grandTotal).toBe(created.body.order.totals.grandTotal);
    expect(round2(lineSum)).toBe(invoice.body.grandTotal);
    expect(round2(invoice.body.taxableValue + invoice.body.gst)).toBe(invoice.body.grandTotal);
    expect(round2(invoice.body.subtotal - invoice.body.discount)).toBe(invoice.body.taxableValue);
    expect(invoice.body.gst).toBe(created.body.order.totals.gst);
  });

  it("rejects a tampered payment signature", async () => {
    const product = await referenceProduct();
    const created = await ctx
      .api()
      .post("/v1/orders")
      .send({
        items: [{ productId: product.id, slug: product.slug, size: "14", quantity: 1 }],
        customer: { name: "Test Buyer", email: "buyer@example.com", phone: "9876543210" },
        shippingAddress: address,
        billingAddress: address,
      });
    const response = await ctx
      .api()
      .post(`/v1/orders/${created.body.order.id}/payments/verify`)
      .send({ providerOrderId: created.body.paymentIntent.providerOrderId, providerPaymentId: "pay_fake", signature: "forged" });
    expect(response.status).toBe(402);
    const order = await ctx.api().get(`/v1/orders/${created.body.order.id}`);
    expect(order.body.payment.status).toBe("failed");
    expect(order.body.status).toBe("new");
  });

  it("registers a customer who can then sign in by mobile and save an address", async () => {
    const registered = await ctx
      .api()
      .post("/v1/auth/register")
      .send({ firstName: "Asha", lastName: "Patel", email: "asha@example.com", phone: "9876500001", password: "Secure123", marketingOptIn: false });
    expect(registered.status).toBe(201);
    const duplicate = await ctx
      .api()
      .post("/v1/auth/register")
      .send({ firstName: "Asha", email: "asha@example.com", phone: "9876500002", password: "Secure123" });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.fieldErrors.email).toBeDefined();

    const login = await ctx.api().post("/v1/auth/login").send({ identifier: "9876500001", password: "Secure123" });
    expect(login.status).toBe(200);
    const saved = await ctx.api().post("/v1/me/addresses").set(auth(login.body.accessToken)).send(address);
    expect(saved.status).toBe(201);
    expect(saved.body).toHaveLength(1);
    expect(saved.body[0].isDefaultShipping).toBe(true);
  });
});

describe("admin API", () => {
  it("enforces role permissions and hides confidential fields", async () => {
    const content = await adminToken(ctx.app, "content@example.com");
    const product = await referenceProduct();
    expect((await ctx.api().patch(`/v1/admin/products/${product.id}`).set(auth(content)).send({ makingValue: 1 })).status).toBe(403);
    expect((await ctx.api().get("/v1/admin/orders").set(auth(content))).status).toBe(403);
    expect((await ctx.api().get("/v1/admin/reports/sales").set(auth(content))).status).toBe(403);
    const products = await ctx.api().get("/v1/admin/products?q=aaravi").set(auth(content));
    expect(products.status).toBe(200);
    expect(products.body.items[0]).not.toHaveProperty("purchasePrice");
    const dashboard = await ctx.api().get("/v1/admin/dashboard").set(auth(content));
    expect(dashboard.body.financials).toBeNull();
    expect((await ctx.api().get("/v1/admin/dashboard")).status).toBe(401);
  });

  it("rejects stale and negative stock changes", async () => {
    const inventory = await adminToken(ctx.app, "inventory@example.com");
    const product = await referenceProduct();
    const detail = await ctx.api().get(`/v1/admin/inventory/${product.id}`).set(auth(inventory));
    const version = detail.body.stockVersion;

    const add = await ctx.api().post(`/v1/admin/inventory/${product.id}/movements`).set(auth(inventory)).send({ type: "add", locationId: "store", quantity: 2, reason: "Count correction", expectedVersion: version });
    expect(add.status).toBe(201);
    expect(add.body.movement.totalAfter).toBe(detail.body.total + 2);

    const stale = await ctx.api().post(`/v1/admin/inventory/${product.id}/movements`).set(auth(inventory)).send({ type: "reduce", locationId: "store", quantity: 1, reason: "Test", expectedVersion: version });
    expect(stale.status).toBe(409);

    const negative = await ctx
      .api()
      .post(`/v1/admin/inventory/${product.id}/movements`)
      .set(auth(inventory))
      .send({ type: "reduce", locationId: "store", quantity: 9999, reason: "Test", expectedVersion: add.body.inventory.stockVersion });
    expect(negative.status).toBe(422);

    const noReason = await ctx.api().post(`/v1/admin/inventory/${product.id}/movements`).set(auth(inventory)).send({ type: "add", locationId: "store", quantity: 1, expectedVersion: add.body.inventory.stockVersion });
    expect(noReason.status).toBe(422);
  });

  it("records an in-store sale at the same price as the website", async () => {
    const sales = await adminToken(ctx.app, "sales@example.com");
    const product = await referenceProduct();
    const sale = await ctx
      .api()
      .post("/v1/admin/sales")
      .set(auth(sales))
      .send({ locationId: "store", items: [{ productId: product.id, size: "14", quantity: 1 }], customer: { name: "Walk-in" }, payment: { amountPaid: product.finalPrice, method: "cash" } });
    expect(sale.status).toBe(201);
    expect(sale.body.grandTotal).toBe(product.finalPrice);
    expect(sale.body.invoice.status).toBe("paid");
    expect(sale.body.invoice.invoiceNumber).toMatch(/^INV-\d{4}-\d{5}$/);
  });

  it("approves purchases into inventory and keeps an audit trail", async () => {
    const token = await adminToken(ctx.app, "superadmin@example.com");
    const product = await referenceProduct();
    const before = await ctx.api().get(`/v1/admin/inventory/${product.id}`).set(auth(token));
    const vendor = await ctx.api().post("/v1/admin/vendors").set(auth(token)).send({ name: "Test Supplier" });
    const purchase = await ctx
      .api()
      .post("/v1/admin/purchases")
      .set(auth(token))
      .send({
        vendorId: vendor.body.id,
        purchaseDate: "2026-09-10",
        receivingLocationId: "store",
        items: [{ productId: product.id, description: "Bands", metal: "gold", purity: "22k", quantity: 3, grossWeight: 11.6, netWeight: 11.55, ratePerGram: 9400 }],
      });
    expect(purchase.status).toBe(201);
    expect(purchase.body.total).toBe(round2(11.55 * 9400));
    expect((await ctx.api().post(`/v1/admin/purchases/${purchase.body.id}/approve`).set(auth(token)).send({})).status).toBe(422);
    await ctx.api().post(`/v1/admin/purchases/${purchase.body.id}/submit`).set(auth(token));
    const approved = await ctx.api().post(`/v1/admin/purchases/${purchase.body.id}/approve`).set(auth(token)).send({});
    expect(approved.body.status).toBe("approved");

    const after = await ctx.api().get(`/v1/admin/inventory/${product.id}`).set(auth(token));
    expect(after.body.total).toBe(before.body.total + 3);
    const audit = await ctx.api().get(`/v1/admin/audit-logs?entityId=${purchase.body.id}`).set(auth(token));
    expect(audit.body.items.map((entry: { action: string }) => entry.action)).toContain("purchase.approve");
  });

  it("keeps at least one active Super Admin", async () => {
    const token = await adminToken(ctx.app, "superadmin@example.com");
    const users = await ctx.api().get("/v1/admin/users").set(auth(token));
    const me = users.body.find((user: { email: string }) => user.email === "superadmin@example.com");
    const response = await ctx.api().patch(`/v1/admin/users/${me.id}`).set(auth(token)).send({ roleId: "sales_manager" });
    expect(response.status).toBe(422);
  });
});
