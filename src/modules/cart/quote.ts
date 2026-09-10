import { eq, sql } from "drizzle-orm";
import type { PriceBreakdown } from "@/contracts/common";
import type { AppliedCoupon, Cart, CartIssue, CartItem, CartItemInput } from "@/contracts/storefront";
import { db, type Executor } from "@/db/client";
import { coupons } from "@/db/schema";
import { allocate, lineTaxAfterCoupon } from "@/lib/allocation";
import { getSetting } from "@/services/settings";
import { sizeLabel } from "@/modules/catalog/labels";
import { catalog, findEntry, priceEntry, resolveAvailability, type CatalogEntry, type CatalogSnapshot } from "@/modules/catalog/snapshot";

/** Stable identity for a cart line: product + size + personalisation (matches the storefront). */
export function lineIdFor(item: Pick<CartItemInput, "productId" | "size" | "customization">) {
  const custom = item.customization
    ? Object.entries(item.customization)
        .filter(([, value]) => value && value.trim() !== "")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value.trim()}`)
        .join("|")
    : "";
  return `${item.productId}::${item.size ?? "-"}::${custom}`;
}

export interface QuotedLine {
  item: CartItem;
  entry: CatalogEntry;
  pricing: PriceBreakdown;
  netWeight: number;
  grossWeight: number;
  couponShare: number;
  gst: number;
}

export interface QuoteResult {
  cart: Cart;
  lines: QuotedLine[];
  couponId: string | null;
  snapshot: CatalogSnapshot;
}

type CouponRow = typeof coupons.$inferSelect;

function formatINR(value: number) {
  return `₹${value.toLocaleString("en-IN")}`;
}

function sanitiseCustomization(entry: CatalogEntry, customization?: Record<string, string>) {
  if (!customization) return undefined;
  const allowed = new Map(entry.product.customization.map((option) => [option.id, option]));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(customization)) {
    const option = allowed.get(key);
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!option || !trimmed) continue;
    if (option.options && !option.options.some((o) => o.value === trimmed)) continue;
    result[key] = option.maxLength ? trimmed.slice(0, option.maxLength) : trimmed.slice(0, 500);
  }
  return Object.keys(result).length ? result : undefined;
}

async function evaluateCoupon(
  executor: Executor,
  code: string,
  lines: QuotedLine[],
  subtotal: number,
): Promise<{ ok: true; coupon: AppliedCoupon; row: CouponRow; eligible: Set<QuotedLine> } | { ok: false; message: string }> {
  const normalised = code.trim().toUpperCase();
  const [row] = await executor
    .select()
    .from(coupons)
    .where(eq(sql`upper(${coupons.code})`, normalised))
    .limit(1);
  const now = Date.now();
  if (!row || !row.active || (row.startsAt && row.startsAt.getTime() > now)) {
    return { ok: false, message: `The code “${normalised}” isn't valid.` };
  }
  if (row.endsAt && row.endsAt.getTime() <= now) return { ok: false, message: `${row.code} has expired.` };
  if (row.usageLimit !== null && row.usedCount >= row.usageLimit) return { ok: false, message: `${row.code} is no longer available.` };
  if (subtotal === 0) return { ok: false, message: "Add an available piece to your bag to use this code." };

  const scope = row.appliesTo;
  const scoped = Boolean(scope.metals?.length || scope.categorySlugs?.length || scope.productIds?.length);
  const eligibleLines = scoped
    ? lines.filter(
        ({ entry }) =>
          (scope.metals?.includes(entry.row.metal) ?? false) ||
          (scope.categorySlugs?.includes(entry.category.slug) ?? false) ||
          (scope.productIds?.includes(entry.row.id) ?? false),
      )
    : lines;
  const eligibleTotal = eligibleLines.reduce((sum, line) => sum + line.item.lineTotal, 0);

  if (eligibleTotal === 0) return { ok: false, message: `${row.code} doesn't apply to the pieces in your bag.` };
  if (row.minOrderValue && subtotal < row.minOrderValue) {
    return { ok: false, message: `${row.code} applies to orders of ${formatINR(row.minOrderValue)} or more.` };
  }

  let discount = row.type === "percentage" ? Math.round((eligibleTotal * row.value) / 100) : Math.min(Math.round(row.value), eligibleTotal);
  if (row.maxDiscount) discount = Math.min(discount, row.maxDiscount);

  return {
    ok: true,
    coupon: { code: row.code, description: row.description, discount },
    row,
    eligible: new Set(eligibleLines),
  };
}

/**
 * Server-authoritative cart quote. The client sends only product ids, sizes,
 * quantities and personalisation; price, stock, coupon and totals are computed here.
 */
export async function quoteCart(
  input: { items: CartItemInput[]; couponCode?: string | null },
  { fresh = false, executor = db() }: { fresh?: boolean; executor?: Executor } = {},
): Promise<QuoteResult> {
  const snapshot = await catalog({ fresh });
  const commerce = await getSetting("commerce", executor);
  const issues: CartIssue[] = [];

  // Normalise sizes & personalisation first so identical lines merge.
  const merged = new Map<string, { input: CartItemInput; entry: CatalogEntry | undefined }>();
  for (const raw of input.items) {
    const entry = findEntry(snapshot, raw.productId) ?? findEntry(snapshot, raw.slug);
    const normalised: CartItemInput = entry
      ? {
          productId: entry.row.id,
          slug: entry.row.slug,
          quantity: raw.quantity,
          ...(entry.row.sizeOptions.length ? { size: priceEntry(entry, snapshot.pricing, raw.size).variant.size } : {}),
          ...(sanitiseCustomization(entry, raw.customization) ? { customization: sanitiseCustomization(entry, raw.customization) } : {}),
        }
      : raw;
    const lineId = lineIdFor(normalised);
    const existing = merged.get(lineId);
    merged.set(lineId, existing ? { entry, input: { ...existing.input, quantity: existing.input.quantity + raw.quantity } } : { entry, input: normalised });
  }

  const remainingStock = new Map<string, number>();
  const lines: QuotedLine[] = [];
  const unavailableLines: CartItem[] = [];

  for (const [lineId, { input: line, entry }] of merged) {
    if (!entry) {
      issues.push({ lineId, type: "unavailable", message: "An item in your bag is no longer available and was removed." });
      continue;
    }
    const { variant, pricing } = priceEntry(entry, snapshot.pricing, line.size);
    const availability = resolveAvailability(entry.row, entry.stock, variant.size);
    const label = entry.row.sizing && variant.size ? ` (${sizeLabel(entry.row.sizing, variant.size)})` : "";

    const requested = Math.floor(Number(line.quantity)) || 1;
    let quantity = Math.min(Math.max(requested, 1), commerce.maxLineQuantity);
    if (quantity !== requested) {
      issues.push({ lineId, type: "quantity_adjusted", message: `${entry.row.name}: quantity adjusted to ${quantity} (maximum per piece).` });
    }

    if (availability.purchasable) {
      const remaining = remainingStock.get(entry.row.id) ?? entry.stock;
      if (quantity > remaining) {
        quantity = Math.max(remaining, 0);
        issues.push({
          lineId,
          type: quantity === 0 ? "out_of_stock" : "quantity_adjusted",
          message: quantity === 0 ? `${entry.row.name}${label} is currently out of stock.` : `${entry.row.name}${label}: only ${quantity} available, quantity adjusted.`,
        });
      }
      remainingStock.set(entry.row.id, remaining - quantity);
    } else {
      issues.push({
        lineId,
        type: availability.status === "unavailable" ? "unavailable" : "out_of_stock",
        message: `${entry.row.name}${label} is currently out of stock.`,
      });
    }

    const purchasable = availability.purchasable && quantity > 0;
    const item: CartItem = {
      ...line,
      quantity: Math.max(quantity, purchasable ? 1 : Math.min(Math.max(requested, 1), commerce.maxLineQuantity)),
      lineId,
      product: { ...entry.summary, pricing, finalPrice: pricing.finalPrice, netWeight: variant.netWeight, grossWeight: variant.grossWeight },
      unitPrice: pricing.finalPrice,
      lineTotal: 0,
      availability: purchasable ? availability : { status: "out_of_stock", purchasable: false, message: availability.message },
    };
    item.lineTotal = pricing.finalPrice * item.quantity;

    if (purchasable) {
      lines.push({ item, entry, pricing, netWeight: variant.netWeight, grossWeight: variant.grossWeight, couponShare: 0, gst: 0 });
    } else {
      unavailableLines.push(item);
    }
  }

  const subtotal = lines.reduce((sum, line) => sum + line.item.lineTotal, 0);
  const productSavings = lines.reduce((sum, line) => sum + (line.pricing.originalPrice - line.pricing.finalPrice) * line.item.quantity, 0);

  let coupon: AppliedCoupon | null = null;
  let couponId: string | null = null;
  if (input.couponCode?.trim()) {
    const result = await evaluateCoupon(executor, input.couponCode, lines, subtotal);
    if (result.ok) {
      coupon = result.coupon;
      couponId = result.row.id;
      const eligible = lines.filter((line) => result.eligible.has(line));
      const shares = allocate(
        coupon.discount,
        eligible.map((line) => line.item.lineTotal),
      );
      eligible.forEach((line, index) => (line.couponShare = shares[index]!));
    } else {
      issues.push({ type: "coupon_invalid", message: result.message });
    }
  }

  for (const line of lines) {
    line.gst = lineTaxAfterCoupon({ lineTotal: line.item.lineTotal, gstTotal: line.pricing.gst * line.item.quantity }, line.couponShare).gst;
  }

  const couponDiscount = coupon?.discount ?? 0;
  const shipping = subtotal > 0 ? commerce.shippingFee : 0;
  const allItems = [...lines.map((line) => line.item), ...unavailableLines];

  return {
    cart: {
      items: allItems,
      coupon,
      totals: {
        itemCount: allItems.reduce((sum, item) => sum + item.quantity, 0),
        subtotal,
        productSavings,
        couponDiscount,
        gst: lines.reduce((sum, line) => sum + line.gst, 0),
        shipping,
        grandTotal: Math.max(0, subtotal - couponDiscount) + shipping,
      },
      issues,
      currency: "INR",
      quotedAt: new Date().toISOString(),
    },
    lines,
    couponId,
    snapshot,
  };
}
