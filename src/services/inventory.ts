import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { inventoryLevels, products, stockLocations, stockMovements, type StockMovementType } from "@/db/schema";
import { conflict, invalid, notFound } from "@/lib/errors";
import type { Actor } from "./audit";
import { notify } from "./notifications";
import { getSetting } from "./settings";

/**
 * STOCK TRANSACTION ENGINE
 * ------------------------------------------------------------------
 * Every quantity change goes through here: the product row is locked,
 * negative stock is rejected, an immutable movement is written with
 * before/after quantities, and alerts are raised. Optimistic concurrency
 * (`expectedVersion`) surfaces a conflict when stock changed since a form opened.
 */

export interface StockChange {
  productId: string;
  type: StockMovementType;
  locationId: string;
  /** Units for add, reduce, purchase, sale, return, opening and transfer. */
  quantity?: number;
  /** Counted quantity at the location, for adjustments. */
  newQuantity?: number;
  toLocationId?: string;
  reason?: string | null;
  reference?: { type: "purchase" | "order" | "sale" | "return" | "manual" | "seed"; id?: string | null; label?: string | null };
  expectedVersion?: number;
}

const INCREASES = new Set<StockMovementType>(["opening", "purchase", "return", "add"]);
const DECREASES = new Set<StockMovementType>(["sale", "reduce"]);
const MANUAL = new Set<StockMovementType>(["add", "reduce", "adjustment"]);

async function assertLocation(tx: Tx, id: string, field: string) {
  const [location] = await tx.select().from(stockLocations).where(eq(stockLocations.id, id)).limit(1);
  if (!location || !location.active) throw invalid({ [field]: "Choose an active stock location." });
  return location;
}

export async function applyStockChange(tx: Tx, actor: Actor, change: StockChange) {
  const [product] = await tx
    .select({ id: products.id, name: products.name, sku: products.sku, stockVersion: products.stockVersion, lowStockThreshold: products.lowStockThreshold })
    .from(products)
    .where(eq(products.id, change.productId))
    .for("update");
  if (!product) throw notFound("Product not found.");
  if (change.expectedVersion !== undefined && change.expectedVersion !== product.stockVersion) {
    throw conflict("Stock for this product changed since you opened the form. Review the latest quantities and try again.");
  }

  const location = await assertLocation(tx, change.locationId, "locationId");
  const levels = await tx.select().from(inventoryLevels).where(eq(inventoryLevels.productId, product.id));
  const at = (locationId: string) => levels.find((level) => level.locationId === locationId)?.quantity ?? 0;
  const totalBefore = levels.reduce((sum, level) => sum + level.quantity, 0);
  const units = change.quantity ?? 0;

  if (change.type !== "adjustment" && (!Number.isInteger(units) || units < 1)) {
    throw invalid({ quantity: "Enter a whole number of at least 1." });
  }

  let locationDelta = 0;
  let toLocationId: string | null = null;
  if (INCREASES.has(change.type)) locationDelta = units;
  else if (DECREASES.has(change.type)) locationDelta = -units;
  else if (change.type === "adjustment") {
    const counted = change.newQuantity;
    if (counted === undefined || !Number.isInteger(counted) || counted < 0) throw invalid({ newQuantity: "Enter the counted quantity (0 or more)." });
    locationDelta = counted - at(location.id);
    if (locationDelta === 0) throw invalid({ newQuantity: "The counted quantity matches the current stock." });
  } else if (change.type === "transfer") {
    if (!change.toLocationId || change.toLocationId === location.id) throw invalid({ toLocationId: "Choose a different destination location." });
    toLocationId = (await assertLocation(tx, change.toLocationId, "toLocationId")).id;
    locationDelta = -units;
  }

  const locationBefore = at(location.id);
  const locationAfter = locationBefore + locationDelta;
  if (locationAfter < 0) {
    throw invalid({ quantity: `Only ${locationBefore} in stock at ${location.name}.` }, "Stock can't go below zero.");
  }

  const upsert = (locationId: string, quantity: number) =>
    tx
      .insert(inventoryLevels)
      .values({ productId: product.id, locationId, quantity })
      .onConflictDoUpdate({ target: [inventoryLevels.productId, inventoryLevels.locationId], set: { quantity, updatedAt: new Date() } });

  await upsert(location.id, locationAfter);
  let toBefore: number | null = null;
  let toAfter: number | null = null;
  if (toLocationId) {
    toBefore = at(toLocationId);
    toAfter = toBefore + units;
    await upsert(toLocationId, toAfter);
  }

  const totalAfter = totalBefore + locationDelta + (toLocationId ? units : 0);
  await tx
    .update(products)
    .set({ stockVersion: sql`${products.stockVersion} + 1`, updatedAt: new Date() })
    .where(eq(products.id, product.id));

  const [movement] = await tx
    .insert(stockMovements)
    .values({
      productId: product.id,
      type: change.type,
      quantityDelta: change.type === "transfer" ? units : totalAfter - totalBefore,
      locationId: location.id,
      toLocationId,
      totalBefore,
      totalAfter,
      locationBefore,
      locationAfter,
      toLocationBefore: toBefore,
      toLocationAfter: toAfter,
      reason: change.reason ?? null,
      referenceType: change.reference?.type ?? null,
      referenceId: change.reference?.id ?? null,
      referenceLabel: change.reference?.label ?? null,
      actorAdminId: actor.adminId,
      actorName: actor.name,
    })
    .returning();

  const href = `/admin/inventory/${product.id}`;
  if (totalBefore > 0 && totalAfter <= 0) {
    await notify(tx, { type: "out_of_stock", title: "Out of stock", body: `${product.name} (${product.sku}) is out of stock.`, href, permission: "inventory:view" });
  } else if (totalBefore > product.lowStockThreshold && totalAfter <= product.lowStockThreshold) {
    await notify(tx, {
      type: "low_stock",
      title: "Low stock",
      body: `${product.name} (${product.sku}) is down to ${totalAfter}.`,
      href,
      permission: "inventory:view",
    });
  }
  if (MANUAL.has(change.type)) {
    const { unusualChangeThreshold } = await getSetting("inventory", tx);
    if (Math.abs(totalAfter - totalBefore) >= unusualChangeThreshold) {
      await notify(tx, {
        type: "unusual_stock_change",
        title: "Unusual stock change",
        body: `${actor.name} changed ${product.name} (${product.sku}) by ${totalAfter - totalBefore} units.`,
        href,
        permission: "inventory:adjust",
      });
    }
  }

  return movement!;
}

/** Units available at one location (row-locking is done by applyStockChange). */
export async function stockAt(tx: Tx, productId: string, locationId: string) {
  const [level] = await tx
    .select({ quantity: inventoryLevels.quantity })
    .from(inventoryLevels)
    .where(and(eq(inventoryLevels.productId, productId), eq(inventoryLevels.locationId, locationId)))
    .limit(1);
  return level?.quantity ?? 0;
}
