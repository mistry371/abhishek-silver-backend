import { describe, expect, it } from "vitest";
import { allocate, lineTaxAfterCoupon } from "@/lib/allocation";
import { advanceDate } from "@/modules/admin/expenses";
import { calculatePrice, MissingRateError, type MetalRateTable } from "@/modules/pricing/engine";

const rates = {
  gold: { "22k": 9610, "18k": 7860 },
  silver: { "925": 118 },
  effectiveAt: "2026-09-10T03:30:00.000Z",
} as MetalRateTable;

const base = { stoneCharges: 0, otherCharges: 0, discount: null, gstRate: 3 };

describe("price engine", () => {
  it("prices per-gram making charges to the rupee (matches the storefront reference engine)", () => {
    const price = calculatePrice({ ...base, metal: "gold", purity: "22k", netWeight: 3.85, making: { type: "per_gram", value: 950 } }, rates);
    expect(price).toMatchObject({ metalRatePerGram: 9610, metalValue: 36999, makingCharges: 3658, taxableValue: 40657, gst: 1220, finalPrice: 41877, originalPrice: 41877 });
  });

  it("applies percentage making, stone charges and a percentage discount before GST", () => {
    const input = { ...base, metal: "gold" as const, purity: "18k" as const, netWeight: 3.2, making: { type: "percentage" as const, value: 14 }, stoneCharges: 24500 };
    expect(calculatePrice(input, rates)).toMatchObject({ metalValue: 25152, makingCharges: 3521, taxableValue: 53173, gst: 1595, finalPrice: 54768 });
    expect(calculatePrice({ ...input, discount: { type: "percentage", value: 10 } }, rates)).toMatchObject({
      discount: 5317,
      taxableValue: 47856,
      gst: 1436,
      finalPrice: 49292,
      originalPrice: 54768,
    });
  });

  it("caps a fixed discount at the pre-tax value", () => {
    const price = calculatePrice({ ...base, metal: "silver", purity: "925", netWeight: 1, making: { type: "fixed", value: 100 }, discount: { type: "fixed", value: 99_999 } }, rates);
    expect(price.discount).toBe(218);
    expect(price.finalPrice).toBe(0);
  });

  it("refuses to price a purity without a configured rate", () => {
    expect(() => calculatePrice({ ...base, metal: "gold", purity: "24k", netWeight: 1, making: { type: "fixed", value: 0 } }, rates)).toThrow(MissingRateError);
  });
});

describe("coupon allocation", () => {
  it("splits an amount exactly across lines", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(2094, [41877])).toEqual([2094]);
    expect(allocate(0, [10, 20])).toEqual([0, 0]);
    const parts = allocate(999, [12345, 6789, 101112]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(999);
  });

  it("keeps taxable value + GST equal to what the customer pays", () => {
    const line = lineTaxAfterCoupon({ lineTotal: 41877, gstTotal: 1220 }, 2094);
    expect(line).toEqual({ gross: 39783, gst: 1159, taxable: 38624 });
    expect(line.taxable + line.gst).toBe(line.gross);
  });
});

describe("recurring expense dates", () => {
  it("advances by frequency and clamps month ends", () => {
    expect(advanceDate("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(advanceDate("2026-11-30", "quarterly")).toBe("2027-02-28");
    expect(advanceDate("2028-02-29", "yearly")).toBe("2029-02-28");
    expect(advanceDate("2026-12-28", "weekly")).toBe("2027-01-04");
  });
});
