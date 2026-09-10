import { and, asc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { MetalType, PriceBreakdown, ProductDiscount } from "@/contracts/common";
import { db, type Executor } from "@/db/client";
import { metalRates, offers, pricingSettings, type OfferTarget } from "@/db/schema";
import { calculatePrice, type MetalRateTable, type PriceInput } from "./engine";

export interface OfferDiscount {
  offerId: string;
  title: string;
  discount: { type: "percentage" | "fixed"; value: number };
  target: OfferTarget;
  endsAt: string | null;
}

export interface PricingContext {
  rates: MetalRateTable;
  gstRate: number;
  offers: OfferDiscount[];
}

/** Loads rates, GST and currently-running offer discounts in three queries. */
export async function loadPricingContext(executor: Executor = db()): Promise<PricingContext> {
  const now = new Date();
  const [rateRows, [settingsRow], offerRows] = await Promise.all([
    executor.select().from(metalRates),
    executor.select().from(pricingSettings).where(eq(pricingSettings.id, 1)).limit(1),
    executor
      .select()
      .from(offers)
      .where(
        and(
          eq(offers.active, true),
          isNotNull(offers.discount),
          or(isNull(offers.startsAt), lte(offers.startsAt, now)),
          or(isNull(offers.endsAt), gt(offers.endsAt, now)),
        ),
      )
      .orderBy(asc(offers.displayOrder)),
  ]);

  const rates = { gold: {}, silver: {}, effectiveAt: new Date(0).toISOString() } as MetalRateTable;
  let latest = 0;
  for (const row of rateRows) {
    rates[row.metal][row.purity] = row.ratePerGram;
    latest = Math.max(latest, row.updatedAt.getTime());
  }
  rates.effectiveAt = new Date(latest).toISOString();

  return {
    rates,
    gstRate: settingsRow?.gstRate ?? 0,
    offers: offerRows.map((row) => ({
      offerId: row.id,
      title: row.title,
      discount: row.discount!,
      target: row.target,
      endsAt: row.endsAt?.toISOString() ?? null,
    })),
  };
}

export interface PriceableProduct {
  id: string;
  metal: MetalType;
  purity: PriceInput["purity"];
  categoryId: string;
  collectionIds: string[];
  makingType: PriceInput["making"]["type"];
  makingValue: number;
  stoneCharges: number;
  otherCharges: number;
  discount: ProductDiscount | null;
}

function offerApplies(offer: OfferDiscount, product: PriceableProduct) {
  const { scope, ids } = offer.target;
  switch (scope) {
    case "all":
      return true;
    case "categories":
      return ids.includes(product.categoryId);
    case "collections":
      return product.collectionIds.some((id) => ids.includes(id));
    case "products":
      return ids.includes(product.id);
    case "metal":
      return ids.includes(product.metal);
    default:
      return false;
  }
}

/**
 * Prices a product at a given net weight. Candidates are the product's own
 * discount (if not expired) and every running offer that targets it; the
 * customer receives the best (lowest) resulting price.
 */
export function priceProduct(product: PriceableProduct, netWeight: number, context: PricingContext): { pricing: PriceBreakdown; discount: ProductDiscount | null } {
  const now = Date.now();
  const candidates: (ProductDiscount | null)[] = [null];
  if (product.discount && (!product.discount.endsAt || Date.parse(product.discount.endsAt) > now)) {
    candidates.push(product.discount);
  }
  for (const offer of context.offers) {
    if (offerApplies(offer, product)) {
      candidates.push({ ...offer.discount, label: offer.title, ...(offer.endsAt ? { endsAt: offer.endsAt } : {}) });
    }
  }

  let best: { pricing: PriceBreakdown; discount: ProductDiscount | null } | null = null;
  for (const discount of candidates) {
    const pricing = calculatePrice(
      {
        metal: product.metal,
        purity: product.purity,
        netWeight,
        making: { type: product.makingType, value: product.makingValue },
        stoneCharges: product.stoneCharges,
        otherCharges: product.otherCharges,
        discount,
        gstRate: context.gstRate,
      },
      context.rates,
    );
    if (!best || pricing.finalPrice < best.pricing.finalPrice) best = { pricing, discount: pricing.discount > 0 ? discount : null };
  }
  return best!;
}
