import type { MakingChargeType, MetalType, PriceBreakdown, ProductDiscount, PurityCode } from "@/contracts/common";
import { rupees } from "@/lib/money";

/**
 * JEWELLERY PRICE ENGINE — authoritative implementation
 * ------------------------------------------------------------------
 * Metal Rate (for purity) × Net Weight + Making + Stone + Other − Discount + GST
 *
 * Mirrors `src/lib/pricing/engine.ts` in the storefront exactly, so the
 * reference implementation and the server agree to the rupee.
 */

export type MetalRateTable = Record<MetalType, Partial<Record<PurityCode, number>>> & { effectiveAt: string };

export interface PriceInput {
  metal: MetalType;
  purity: PurityCode;
  netWeight: number;
  making: { type: MakingChargeType; value: number };
  stoneCharges: number;
  otherCharges: number;
  discount?: Pick<ProductDiscount, "type" | "value"> | null;
  gstRate: number;
}

export class MissingRateError extends Error {
  constructor(metal: MetalType, purity: PurityCode) {
    super(`No ${metal} rate configured for purity ${purity}`);
  }
}

export function rateFor(rates: MetalRateTable, metal: MetalType, purity: PurityCode): number {
  const rate = rates[metal]?.[purity];
  if (rate === undefined) throw new MissingRateError(metal, purity);
  return rate;
}

export function calculatePrice(input: PriceInput, rates: MetalRateTable): PriceBreakdown {
  const metalRatePerGram = rateFor(rates, input.metal, input.purity);
  const metalValue = rupees(metalRatePerGram * input.netWeight);

  const makingCharges = rupees(
    input.making.type === "per_gram"
      ? input.making.value * input.netWeight
      : input.making.type === "percentage"
        ? (metalValue * input.making.value) / 100
        : input.making.value,
  );

  const subtotal = metalValue + makingCharges + input.stoneCharges + input.otherCharges;

  const discount = input.discount
    ? rupees(input.discount.type === "percentage" ? (subtotal * input.discount.value) / 100 : Math.min(input.discount.value, subtotal))
    : 0;

  const taxableValue = subtotal - discount;
  const gst = rupees((taxableValue * input.gstRate) / 100);
  const finalPrice = taxableValue + gst;
  const originalPrice = subtotal + rupees((subtotal * input.gstRate) / 100);

  return {
    currency: "INR",
    metalRatePerGram,
    metalValue,
    makingCharges,
    stoneCharges: input.stoneCharges,
    otherCharges: input.otherCharges,
    discount,
    originalPrice,
    taxableValue,
    gstRate: input.gstRate,
    gst,
    finalPrice,
    rateEffectiveAt: rates.effectiveAt,
    isEstimate: false,
  };
}
