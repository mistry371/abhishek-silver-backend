/**
 * Splits an integer amount across weights so the parts always sum exactly
 * to the amount (largest-remainder method). Used to spread an order-level
 * coupon across lines for GST and invoicing.
 */
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((weight) => (amount * weight) / total);
  const parts = raw.map(Math.floor);
  let remainder = amount - parts.reduce((sum, part) => sum + part, 0);
  const order = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; remainder > 0 && i < order.length; i += 1, remainder -= 1) {
    parts[order[i]!.index]! += 1;
  }
  return parts;
}

/**
 * GST contained in a tax-inclusive line after a coupon share is removed.
 * Scales the engine's GST proportionally, so taxable + GST still equals the amount paid.
 */
export function lineTaxAfterCoupon(line: { lineTotal: number; gstTotal: number }, couponShare: number) {
  const gross = line.lineTotal - couponShare;
  const gst = line.lineTotal > 0 ? Math.round((line.gstTotal * gross) / line.lineTotal) : 0;
  return { gross, gst, taxable: gross - gst };
}
