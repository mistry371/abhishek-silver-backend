import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "@/db/client";
import { categories, inventoryLevels, products, stockLocations, stockMovements, vendors } from "@/db/schema";
import { can, requireAnyPermission, requirePermission } from "@/http/auth";
import { AppError, forbidden, invalid, notFound } from "@/lib/errors";
import { paginated, parse, zDate, zText, zUuid } from "@/lib/validation";
import { METALS, PURITIES } from "@/modules/catalog/labels";
import { actorOf, recordAudit } from "@/services/audit";
import { applyStockChange } from "@/services/inventory";
import { afterCatalogChange } from "@/services/revalidate";
import { getSetting } from "@/services/settings";
import { escapeLike, idParam, listQuery, sortBy, withinDates, withUniqueFields } from "./helpers";

export const inventoryRouter = Router();

/* ------------------------------------------------------------------ */
/* Locations                                                           */
/* ------------------------------------------------------------------ */

inventoryRouter.get("/locations", requireAnyPermission("inventory:view", "settings:manage"), async (_req, res) => {
  const rows = await db().select().from(stockLocations).orderBy(asc(stockLocations.displayOrder));
  const units = await db()
    .select({ locationId: inventoryLevels.locationId, value: sql<number>`coalesce(sum(${inventoryLevels.quantity}), 0)`.mapWith(Number) })
    .from(inventoryLevels)
    .groupBy(inventoryLevels.locationId);
  res.json(rows.map((row) => ({ ...row, units: units.find((u) => u.locationId === row.id)?.value ?? 0 })));
});

inventoryRouter.post("/locations", requirePermission("settings:manage"), async (req, res) => {
  const input = parse(
    z.object({
      id: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9-]{2,40}$/, { error: "Use 2–40 lowercase letters, numbers or hyphens." }),
      name: zText(80),
      displayOrder: z.number().int().min(0).max(1000).default(0),
    }),
    req.body,
  );
  const row = await withUniqueFields(async () => (await db().insert(stockLocations).values(input).returning())[0]!, {
    stock_locations_pkey: ["id", "A location with this code already exists."],
  });
  await recordAudit(db(), actorOf(req), { module: "inventory", action: "location.create", entityType: "stock_location", entityId: row.id, entityLabel: row.name });
  res.status(201).json(row);
});

inventoryRouter.patch("/locations/:id", requirePermission("settings:manage"), async (req, res) => {
  const id = String(req.params.id);
  const patch = parse(z.object({ name: zText(80).optional(), active: z.boolean().optional(), displayOrder: z.number().int().min(0).max(1000).optional() }), req.body);
  if (patch.active === false) {
    const settings = await getSetting("inventory");
    if (id === settings.defaultLocationId || id === settings.onlineFulfilmentLocationId) {
      throw invalid({ active: "This location is used as the default or online fulfilment location. Change that in Settings first." });
    }
    const [stock] = await db()
      .select({ value: sql<number>`coalesce(sum(${inventoryLevels.quantity}), 0)`.mapWith(Number) })
      .from(inventoryLevels)
      .where(eq(inventoryLevels.locationId, id));
    if ((stock?.value ?? 0) > 0) throw invalid({ active: "Transfer this location's stock elsewhere before deactivating it." });
  }
  const [row] = await db().update(stockLocations).set(patch).where(eq(stockLocations.id, id)).returning();
  if (!row) throw notFound();
  await recordAudit(db(), actorOf(req), { module: "inventory", action: "location.update", entityType: "stock_location", entityId: id, entityLabel: row.name, after: patch });
  afterCatalogChange();
  res.json(row);
});

/* ------------------------------------------------------------------ */
/* Inventory master                                                    */
/* ------------------------------------------------------------------ */

const stockAggregate = () =>
  db()
    .select({ productId: inventoryLevels.productId, quantity: sql<number>`sum(${inventoryLevels.quantity})`.as("quantity") })
    .from(inventoryLevels)
    .groupBy(inventoryLevels.productId)
    .as("stock_agg");

function stockStatus(status: string, total: number, threshold: number) {
  if (status === "disabled") return "unavailable";
  if (total <= 0) return "out_of_stock";
  if (total <= threshold) return "low_stock";
  return "in_stock";
}

const inventoryListSchema = listQuery.extend({
  categoryId: zUuid.optional(),
  metal: z.enum(METALS).optional(),
  purity: z.enum(PURITIES).optional(),
  status: z.enum(["in_stock", "low_stock", "out_of_stock"]).optional(),
  productStatus: z.enum(["active", "draft", "disabled"]).optional(),
  locationId: z.string().max(40).optional(),
  vendorId: zUuid.optional(),
  minWeight: z.coerce.number().min(0).optional(),
  maxWeight: z.coerce.number().min(0).optional(),
});

inventoryRouter.get("/inventory", requirePermission("inventory:view"), async (req, res) => {
  const query = parse(inventoryListSchema, req.query);
  const confidential = can(req, "products:view_confidential");
  const valuation = can(req, "inventory:view_valuation");
  if (query.vendorId && !confidential) throw forbidden();

  const agg = stockAggregate();
  const quantity = sql<number>`coalesce(${agg.quantity}, 0)`;
  const where = and(
    isNull(products.deletedAt),
    query.q
      ? or(ilike(products.name, `%${escapeLike(query.q)}%`), ilike(products.sku, `%${escapeLike(query.q)}%`), eq(products.barcode, query.q))
      : undefined,
    query.categoryId ? eq(products.categoryId, query.categoryId) : undefined,
    query.metal ? eq(products.metal, query.metal) : undefined,
    query.purity ? eq(products.purity, query.purity) : undefined,
    query.productStatus ? eq(products.status, query.productStatus) : undefined,
    query.vendorId ? eq(products.vendorId, query.vendorId) : undefined,
    query.minWeight !== undefined ? gte(products.netWeight, query.minWeight) : undefined,
    query.maxWeight !== undefined ? lte(products.netWeight, query.maxWeight) : undefined,
    query.locationId
      ? sql`exists (select 1 from ${inventoryLevels} where ${inventoryLevels.productId} = ${products.id} and ${inventoryLevels.locationId} = ${query.locationId} and ${inventoryLevels.quantity} > 0)`
      : undefined,
    // Low/out-of-stock views count active products only, matching the summary and dashboard.
    query.status && query.status !== "in_stock" && !query.productStatus ? eq(products.status, "active") : undefined,
    query.status === "out_of_stock" ? sql`${quantity} <= 0` : undefined,
    query.status === "low_stock" ? sql`${quantity} > 0 and ${quantity} <= ${products.lowStockThreshold}` : undefined,
    query.status === "in_stock" ? sql`${quantity} > ${products.lowStockThreshold}` : undefined,
  );

  const rows = await db()
    .select({ product: products, categoryName: categories.name, vendorName: vendors.name, total: sql<number>`${quantity}`.mapWith(Number) })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(vendors, eq(vendors.id, products.vendorId))
    .leftJoin(agg, eq(agg.productId, products.id))
    .where(where)
    .orderBy(sortBy(query.sort, { name: products.name, sku: products.sku, quantity, updatedAt: products.updatedAt, netWeight: products.netWeight }, asc(products.name)))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db()
    .select({ value: count() })
    .from(products)
    .leftJoin(agg, eq(agg.productId, products.id))
    .where(where);

  const ids = rows.map((r) => r.product.id);
  const levels = ids.length ? await db().select().from(inventoryLevels).where(inArray(inventoryLevels.productId, ids)) : [];

  res.json(
    paginated(
      rows.map(({ product: p, categoryName, vendorName, total: units }) => ({
        productId: p.id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        image: p.images[0] ?? null,
        category: { id: p.categoryId, name: categoryName },
        metal: p.metal,
        purity: p.purity,
        netWeight: p.netWeight,
        grossWeight: p.grossWeight,
        stoneWeight: p.stoneWeight,
        productStatus: p.status,
        lowStockThreshold: p.lowStockThreshold,
        stockVersion: p.stockVersion,
        total: units,
        levels: Object.fromEntries(levels.filter((l) => l.productId === p.id).map((l) => [l.locationId, l.quantity])),
        stockStatus: stockStatus(p.status, units, p.lowStockThreshold),
        ...(confidential ? { vendor: p.vendorId ? { id: p.vendorId, name: vendorName } : null, purchasePrice: p.purchasePrice } : {}),
        ...(valuation ? { valuation: p.purchasePrice !== null ? Math.round(units * p.purchasePrice) : null } : {}),
      })),
      total?.value ?? 0,
      query.page,
      query.pageSize,
    ),
  );
});

inventoryRouter.get("/inventory/summary", requirePermission("inventory:view"), async (req, res) => {
  const agg = stockAggregate();
  const rows = await db()
    .select({
      status: products.status,
      threshold: products.lowStockThreshold,
      purchasePrice: products.purchasePrice,
      total: sql<number>`coalesce(${agg.quantity}, 0)`.mapWith(Number),
    })
    .from(products)
    .leftJoin(agg, eq(agg.productId, products.id))
    .where(isNull(products.deletedAt));
  const byLocation = await db()
    .select({ locationId: stockLocations.id, name: stockLocations.name, units: sql<number>`coalesce(sum(${inventoryLevels.quantity}), 0)`.mapWith(Number) })
    .from(stockLocations)
    .leftJoin(inventoryLevels, eq(inventoryLevels.locationId, stockLocations.id))
    .groupBy(stockLocations.id, stockLocations.name)
    .orderBy(asc(stockLocations.displayOrder));
  const active = rows.filter((r) => r.status === "active");

  res.json({
    products: rows.length,
    totalUnits: rows.reduce((sum, r) => sum + Math.max(r.total, 0), 0),
    lowStock: active.filter((r) => r.total > 0 && r.total <= r.threshold).length,
    outOfStock: active.filter((r) => r.total <= 0).length,
    byLocation,
    ...(can(req, "inventory:view_valuation")
      ? {
          valuation: Math.round(rows.reduce((sum, r) => sum + (r.purchasePrice !== null ? r.total * r.purchasePrice : 0), 0)),
          productsMissingCost: rows.filter((r) => r.total > 0 && r.purchasePrice === null).length,
        }
      : {}),
  });
});

inventoryRouter.get("/inventory/lookup", requirePermission("inventory:view"), async (req, res) => {
  const { code } = parse(z.object({ code: z.string().trim().min(1).max(64) }), req.query);
  const [row] = await db()
    .select({ productId: products.id, name: products.name, sku: products.sku })
    .from(products)
    .where(and(isNull(products.deletedAt), or(eq(sql`upper(${products.sku})`, code.toUpperCase()), eq(products.barcode, code))))
    .limit(1);
  if (!row) throw notFound("No product matches this SKU or barcode.");
  res.json(row);
});

const movementListSchema = listQuery.extend({
  productId: zUuid.optional(),
  type: z.enum(["opening", "purchase", "sale", "return", "add", "reduce", "adjustment", "transfer"]).optional(),
  locationId: z.string().max(40).optional(),
  referenceType: z.enum(["purchase", "order", "sale", "return", "manual", "seed"]).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
});

inventoryRouter.get("/inventory/movements", requirePermission("inventory:view"), async (req, res) => {
  const query = parse(movementListSchema, req.query);
  const conditions: (SQL | undefined)[] = [
    query.productId ? eq(stockMovements.productId, query.productId) : undefined,
    query.type ? eq(stockMovements.type, query.type) : undefined,
    query.locationId ? or(eq(stockMovements.locationId, query.locationId), eq(stockMovements.toLocationId, query.locationId)) : undefined,
    query.referenceType ? eq(stockMovements.referenceType, query.referenceType) : undefined,
    query.q
      ? or(
          ilike(products.name, `%${escapeLike(query.q)}%`),
          ilike(products.sku, `%${escapeLike(query.q)}%`),
          ilike(stockMovements.actorName, `%${escapeLike(query.q)}%`),
          ilike(stockMovements.referenceLabel, `%${escapeLike(query.q)}%`),
        )
      : undefined,
    ...withinDates(stockMovements.createdAt, query.from, query.to),
  ];
  const where = and(...conditions);
  const rows = await db()
    .select({ movement: stockMovements, productName: products.name, sku: products.sku })
    .from(stockMovements)
    .innerJoin(products, eq(products.id, stockMovements.productId))
    .where(where)
    .orderBy(desc(stockMovements.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db()
    .select({ value: count() })
    .from(stockMovements)
    .innerJoin(products, eq(products.id, stockMovements.productId))
    .where(where);
  res.json(
    paginated(
      rows.map((r) => ({ ...r.movement, productName: r.productName, sku: r.sku })),
      total?.value ?? 0,
      query.page,
      query.pageSize,
    ),
  );
});

async function inventoryDetail(productId: string, confidential: boolean) {
  const [row] = await db()
    .select({ product: products, categoryName: categories.name })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(and(eq(products.id, productId), isNull(products.deletedAt)))
    .limit(1);
  if (!row) throw notFound("Product not found.");
  const locations = await db().select().from(stockLocations).orderBy(asc(stockLocations.displayOrder));
  const levels = await db().select().from(inventoryLevels).where(eq(inventoryLevels.productId, productId));
  const movements = await db().select().from(stockMovements).where(eq(stockMovements.productId, productId)).orderBy(desc(stockMovements.createdAt)).limit(50);
  const total = levels.reduce((sum, l) => sum + l.quantity, 0);
  const p = row.product;
  return {
    product: {
      id: p.id,
      name: p.name,
      sku: p.sku,
      barcode: p.barcode,
      image: p.images[0] ?? null,
      category: row.categoryName,
      metal: p.metal,
      purity: p.purity,
      netWeight: p.netWeight,
      grossWeight: p.grossWeight,
      status: p.status,
      lowStockThreshold: p.lowStockThreshold,
      ...(confidential ? { purchasePrice: p.purchasePrice, vendorId: p.vendorId } : {}),
    },
    stockVersion: p.stockVersion,
    total,
    stockStatus: stockStatus(p.status, total, p.lowStockThreshold),
    levels: locations.map((location) => ({
      locationId: location.id,
      name: location.name,
      active: location.active,
      quantity: levels.find((l) => l.locationId === location.id)?.quantity ?? 0,
    })),
    movements,
  };
}

inventoryRouter.get("/inventory/:productId", requirePermission("inventory:view"), async (req, res) => {
  res.json(await inventoryDetail(idParam(req, "productId"), can(req, "products:view_confidential")));
});

const movementSchema = z.object({
  type: z.enum(["add", "reduce", "adjustment", "transfer"]),
  locationId: z.string().trim().min(1).max(40),
  toLocationId: z.string().trim().max(40).optional(),
  quantity: z.number().int().min(1).max(100_000).optional(),
  newQuantity: z.number().int().min(0).max(100_000).optional(),
  /** Manual stock changes always need a reason (documentation §7.3). */
  reason: zText(500),
  referenceLabel: z.string().trim().max(80).optional(),
  expectedVersion: z.number().int().min(0),
});

inventoryRouter.post("/inventory/:productId/movements", requirePermission("inventory:adjust"), async (req, res) => {
  const productId = idParam(req, "productId");
  const input = parse(movementSchema, req.body);
  if (input.type === "adjustment" && input.newQuantity === undefined) throw invalid({ newQuantity: "Enter the counted quantity." });
  if (input.type !== "adjustment" && input.quantity === undefined) throw invalid({ quantity: "Enter a quantity." });
  const actor = actorOf(req);

  const movement = await db().transaction(async (tx) => {
    const created = await applyStockChange(tx, actor, {
      productId,
      type: input.type,
      locationId: input.locationId,
      toLocationId: input.toLocationId,
      quantity: input.quantity,
      newQuantity: input.newQuantity,
      reason: input.reason,
      reference: { type: "manual", label: input.referenceLabel ?? null },
      expectedVersion: input.expectedVersion,
    });
    const [product] = await tx.select({ name: products.name, sku: products.sku }).from(products).where(eq(products.id, productId));
    await recordAudit(tx, actor, {
      module: "inventory",
      action: `stock.${input.type}`,
      entityType: "product",
      entityId: productId,
      entityLabel: `${product?.sku} ${product?.name}`,
      before: { total: created.totalBefore, location: created.locationBefore },
      after: { total: created.totalAfter, location: created.locationAfter, toLocation: created.toLocationAfter },
      reason: input.reason,
      reference: input.referenceLabel ?? null,
      sensitive: true,
    });
    return created;
  });
  if (!movement) throw new AppError("server_error");
  afterCatalogChange();
  res.status(201).json({ movement, inventory: await inventoryDetail(productId, can(req, "products:view_confidential")) });
});
