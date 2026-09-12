import { and, eq, isNull, sql } from "drizzle-orm";
import { inventoryLevels, products, stockLocations, type StockMovementType } from "@/db/schema";
import { applyStockChange } from "@/services/inventory";
import { defineImport, type ImportColumn, type RowPlan } from "../types";

/**
 * STOCK IMPORT
 * ------------------------------------------------------------------
 * Every row goes through the same stock engine as the Inventory screen, so
 * levels, the movement ledger and low-stock alerts stay correct. The preview
 * runs the file through a running tally per product and location, which
 * catches "stock would go below zero" before anything is written.
 */

const MOVEMENTS = ["opening", "add", "reduce", "adjust"] as const;
type Movement = (typeof MOVEMENTS)[number];

const columns: ImportColumn[] = [
  { key: "sku", label: "SKU", required: true, example: "G22K-RG-1001", example2: "S925-ER-2040", hint: "The product's SKU. It must already exist in Products." },
  { key: "location", label: "Location", required: true, example: "Main store", example2: "Main store", hint: "Stock location name or code, e.g. Main store." },
  { key: "movement", label: "Movement", required: true, example: "add", example2: "adjust", hint: "opening (first count), add (stock in), reduce (stock out) or adjust (set to a counted quantity)." },
  { key: "quantity", label: "Quantity", required: true, example: "5", example2: "12", hint: "Whole units. For adjust, enter the quantity you counted; for the rest, how many to add or remove." },
  { key: "reason", label: "Reason", required: true, example: "Stock received from workshop", example2: "Annual stock count", hint: "Why stock changed. Shown in the movement history." },
];

interface LocationRow {
  id: string;
  name: string;
  active: boolean;
}

interface InventoryState {
  locations: LocationRow[];
  /** Running quantity per product and location, so several rows for one product add up. */
  projected: Map<string, number>;
}

interface InventoryPlan extends RowPlan {
  productId: string;
  type: StockMovementType;
  locationId: string;
  quantity: number;
  reason: string;
}

export const inventoryImport = defineImport<InventoryState, InventoryPlan>({
  entity: "inventory",
  label: "Stock",
  description: "Record opening stock, additions, reductions and counted adjustments by SKU and location.",
  module: "inventory",
  permission: "inventory:adjust",
  revalidate: true,
  columns,

  async prepare(ctx) {
    return {
      locations: await ctx.ex.select({ id: stockLocations.id, name: stockLocations.name, active: stockLocations.active }).from(stockLocations),
      projected: new Map<string, number>(),
    };
  },

  async plan(row, state, ctx) {
    const sku = row.text("sku", { required: true, max: 40 })?.toUpperCase();
    const locationText = row.text("location", { required: true, max: 80 });
    const movement = row.choice("movement", MOVEMENTS, { required: true, extra: { adjustment: "adjust" as Movement, opening_stock: "opening" as Movement } });
    const quantity = row.numeric("quantity", { required: true, min: 0, max: 100_000, integer: true });
    const reason = row.text("reason", { required: true, max: 500 });

    const [product] = sku
      ? await ctx.ex
          .select({ id: products.id, sku: products.sku, name: products.name })
          .from(products)
          .where(and(eq(sql`upper(${products.sku})`, sku), isNull(products.deletedAt)))
          .limit(1)
      : [];
    if (sku && !product) row.error("sku", `No product with SKU ${sku}. Import the product first, or check the code.`);

    const location = locationText
      ? state.locations.find((item) => item.id.toLowerCase() === locationText.toLowerCase() || item.name.toLowerCase() === locationText.toLowerCase())
      : undefined;
    if (locationText && !location) {
      row.error("location", `Location "${locationText}" not found. Use one of: ${state.locations.map((item) => item.name).join(", ")}.`);
    } else if (location && !location.active) {
      row.error("location", `${location.name} is no longer in use. Choose an active location.`);
    }
    if (movement && movement !== "adjust" && quantity !== undefined && quantity < 1) row.error("quantity", "Enter a whole number of at least 1.");
    if (!product || !location || !movement || quantity === undefined || !reason || !row.ok) return null;

    const key = `${product.id}:${location.id}`;
    let before = state.projected.get(key);
    if (before === undefined) {
      const [level] = await ctx.ex
        .select({ quantity: inventoryLevels.quantity })
        .from(inventoryLevels)
        .where(and(eq(inventoryLevels.productId, product.id), eq(inventoryLevels.locationId, location.id)))
        .limit(1);
      before = level?.quantity ?? 0;
    }
    const after = movement === "reduce" ? before - quantity : movement === "adjust" ? quantity : before + quantity;
    if (after < 0) {
      row.error("quantity", `Only ${before} in stock at ${location.name}, so ${quantity} can't be removed.`);
      return null;
    }
    state.projected.set(key, after);

    const type: StockMovementType = movement === "adjust" ? "adjustment" : movement;
    if (type === "adjustment" && after === before) {
      return { row: row.number, action: "skip", summary: `${product.sku} — counted quantity already matches (${before} at ${location.name})`, productId: product.id, type, locationId: location.id, quantity, reason };
    }
    return {
      row: row.number,
      action: "create",
      summary: `${product.sku} — ${movement} ${quantity} at ${location.name} (${before} → ${after})`,
      productId: product.id,
      type,
      locationId: location.id,
      quantity,
      reason,
    };
  },

  async apply(plan, _state, ctx) {
    if (plan.action === "skip") return;
    await applyStockChange(ctx.tx, ctx.actor, {
      productId: plan.productId,
      type: plan.type,
      locationId: plan.locationId,
      quantity: plan.type === "adjustment" ? undefined : plan.quantity,
      newQuantity: plan.type === "adjustment" ? plan.quantity : undefined,
      reason: plan.reason,
      reference: { type: "manual", label: `Import: ${ctx.fileName}` },
    });
  },
});
