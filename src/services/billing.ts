import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { invoiceEvents, invoiceItems, invoicePayments, invoices, orderItems, orders, saleItems, sales } from "@/db/schema";
import { allocate, lineTaxAfterCoupon } from "@/lib/allocation";
import { round2 } from "@/lib/money";
import { documentNumbers } from "./sequences";
import { getSetting } from "./settings";

/**
 * INVOICE AMOUNTS — one meaning everywhere:
 *   subtotal     pre-tax value before invoice-level discounts
 *   discount     pre-tax discount
 *   taxableValue subtotal − discount (+ untaxed charges such as shipping)
 *   gst          tax on the taxable value
 *   grandTotal   taxableValue + gst
 */

/** Line maths for manual invoices and in-store sales: unit price and discount are pre-tax; GST is added. */
export function computeTaxLine(input: { unitPrice: number; quantity: number; discount: number; gstRate: number }) {
  const gross = round2(input.unitPrice * input.quantity);
  const discount = round2(Math.min(input.discount, gross));
  const taxableValue = round2(gross - discount);
  const gstAmount = round2((taxableValue * input.gstRate) / 100);
  return { gross, discount, taxableValue, gstAmount, lineTotal: round2(taxableValue + gstAmount) };
}

export async function assignInvoiceNumber(tx: Tx) {
  const { invoicePrefix } = await getSetting("billing", tx);
  return documentNumbers.invoice(tx, invoicePrefix);
}

/**
 * Online order paid → Sale (online) + issued, paid Invoice.
 * Online prices are GST-inclusive; the order-level coupon is spread across
 * lines (largest remainder) and split into its pre-tax and tax parts, so the
 * invoice lines add up exactly to the amount the customer paid.
 */
export async function recordOnlineSale(tx: Tx, orderId: string, payment: { method: string | null; reference: string | null }) {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error(`Order ${orderId} not found`);
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));

  const shares = allocate(
    order.couponDiscount,
    items.map((item) => item.lineTotal),
  );
  const lines = items.map((item, index) => {
    const share = shares[index] ?? 0;
    const gstBeforeCoupon = item.priceSnapshot.gst * item.quantity;
    const preTax = item.lineTotal - gstBeforeCoupon;
    const { gross, gst, taxable } = lineTaxAfterCoupon({ lineTotal: item.lineTotal, gstTotal: gstBeforeCoupon }, share);
    return { item, preTax, discount: round2(preTax - taxable), taxable, gst, gross };
  });

  const subtotal = round2(lines.reduce((sum, line) => sum + line.preTax, 0));
  const discount = round2(lines.reduce((sum, line) => sum + line.discount, 0));
  const gst = round2(lines.reduce((sum, line) => sum + line.gst, 0));
  const taxableValue = round2(lines.reduce((sum, line) => sum + line.taxable, 0) + order.shipping);
  const now = new Date();

  const [sale] = await tx
    .insert(sales)
    .values({
      saleNumber: await documentNumbers.sale(tx),
      channel: "online",
      orderId: order.id,
      customerId: order.customerId,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerEmail: order.customerEmail,
      subtotal,
      discount,
      taxableValue,
      gst,
      grandTotal: order.grandTotal,
      paymentStatus: "paid",
      paymentMethod: payment.method,
      locationId: order.fulfilmentLocationId,
      createdByName: "Website",
    })
    .returning();

  await tx.insert(saleItems).values(
    lines.map(({ item, preTax, discount: lineDiscount, gst: lineGst, gross }) => ({
      saleId: sale!.id,
      productId: item.productId,
      name: item.name,
      sku: item.sku,
      size: item.size,
      metal: item.metal,
      purity: item.purity,
      quantity: item.quantity,
      grossWeight: round2(item.grossWeight * item.quantity),
      netWeight: round2(item.netWeight * item.quantity),
      unitPrice: round2(preTax / item.quantity),
      discount: lineDiscount,
      gstRate: item.priceSnapshot.gstRate,
      gstAmount: lineGst,
      lineTotal: gross,
      priceSnapshot: item.priceSnapshot,
    })),
  );

  const address = order.billingAddress;
  const [invoice] = await tx
    .insert(invoices)
    .values({
      invoiceNumber: await assignInvoiceNumber(tx),
      status: "paid",
      source: "online_order",
      orderId: order.id,
      saleId: sale!.id,
      customerId: order.customerId,
      customer: {
        name: address.fullName || order.customerName,
        mobile: order.customerPhone,
        email: order.customerEmail,
        address: [address.line1, address.line2, address.landmark, `${address.city}, ${address.state} ${address.postalCode}`, address.country].filter(Boolean).join(", "),
      },
      subtotal,
      discount,
      taxableValue,
      gst,
      grandTotal: order.grandTotal,
      amountPaid: order.grandTotal,
      balanceDue: 0,
      issuedAt: now,
      createdByName: "Website",
    })
    .returning();

  const invoiceLines: (typeof invoiceItems.$inferInsert)[] = lines.map(({ item, preTax, discount: lineDiscount, gst: lineGst, taxable, gross }, position) => ({
    invoiceId: invoice!.id,
    productId: item.productId,
    description: item.name,
    sku: item.sku,
    size: item.size,
    metal: item.metal,
    purity: item.purity,
    quantity: item.quantity,
    grossWeight: round2(item.grossWeight * item.quantity),
    netWeight: round2(item.netWeight * item.quantity),
    unitPrice: round2(preTax / item.quantity),
    discount: lineDiscount,
    taxableValue: taxable,
    gstRate: item.priceSnapshot.gstRate,
    gstAmount: lineGst,
    lineTotal: gross,
    position,
  }));
  if (order.shipping > 0) {
    invoiceLines.push({
      invoiceId: invoice!.id,
      description: "Shipping charges",
      quantity: 1,
      unitPrice: order.shipping,
      discount: 0,
      taxableValue: order.shipping,
      gstRate: 0,
      gstAmount: 0,
      lineTotal: order.shipping,
      position: invoiceLines.length,
    });
  }
  await tx.insert(invoiceItems).values(invoiceLines);

  await tx.insert(invoicePayments).values({
    invoiceId: invoice!.id,
    amount: order.grandTotal,
    method: payment.method ?? order.paymentProvider,
    reference: payment.reference,
    receivedAt: order.paidAt ?? now,
    recordedByName: "Website",
  });
  await tx.insert(invoiceEvents).values([
    { invoiceId: invoice!.id, action: "issued", note: `Generated for order ${order.orderNumber}`, actorName: "System" },
    { invoiceId: invoice!.id, action: "payment_recorded", note: `Online payment ${payment.reference ?? ""}`.trim(), actorName: "System" },
  ]);

  return { sale: sale!, invoice: invoice! };
}
