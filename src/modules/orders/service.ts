import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/config/env";
import type { PaymentIntent } from "@/contracts/storefront";
import { db } from "@/db/client";
import { coupons, orderItems, orders, orderStatusEvents, products } from "@/db/schema";
import { AppError, notFound, unauthorized } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { zEmail, zMobile, zText } from "@/lib/validation";
import type { CustomerRow } from "@/http/context";
import { addressSchema, cartItemSchema, couponCodeSchema, toSnapshot } from "@/modules/account/schemas";
import { quoteCart } from "@/modules/cart/quote";
import { invalidateCatalog } from "@/modules/catalog/snapshot";
import { SYSTEM_ACTOR } from "@/services/audit";
import { recordOnlineSale } from "@/services/billing";
import { applyStockChange } from "@/services/inventory";
import { notify } from "@/services/notifications";
import { documentNumbers } from "@/services/sequences";
import { getSetting } from "@/services/settings";
import { paymentGateway } from "./payment-gateway";
import { loadOrderDto } from "./presenter";

export const createOrderSchema = z.object({
  items: z.array(cartItemSchema).min(1).max(50),
  couponCode: couponCodeSchema,
  customer: z.object({ name: zText(120), email: zEmail, phone: zMobile }),
  shippingAddress: addressSchema,
  billingAddress: addressSchema,
  notes: z.string().trim().max(1000).optional(),
  paymentProvider: z.string().max(20).optional(),
});

const formatINR = (value: number) => `₹${value.toLocaleString("en-IN")}`;

export async function createOrder(input: z.output<typeof createOrderSchema>, customer: CustomerRow | null) {
  if (env.PAYMENT_PROVIDER === "none") {
    throw new AppError("payment_failed", "Online payment isn't available yet. Please contact us on WhatsApp or call the store to place your order.");
  }
  const commerce = await getSetting("commerce");
  if (!customer && !commerce.guestCheckout) throw unauthorized("Please sign in to place your order.");

  const quote = await quoteCart({ items: input.items, couponCode: input.couponCode }, { fresh: true });
  const blocking = quote.cart.issues.filter((issue) => ["out_of_stock", "unavailable", "quantity_adjusted"].includes(issue.type));
  if (blocking.length || quote.lines.length === 0) {
    throw new AppError("out_of_stock", "Some pieces in your bag have changed or are no longer available. Please review your bag before paying.");
  }
  if (input.couponCode?.trim() && !quote.cart.coupon) {
    throw new AppError("coupon_invalid", quote.cart.issues.find((issue) => issue.type === "coupon_invalid")?.message);
  }

  const { onlineFulfilmentLocationId } = await getSetting("inventory");
  const gateway = paymentGateway();
  const { totals, coupon } = quote.cart;

  const order = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(orders)
      .values({
        orderNumber: await documentNumbers.order(tx),
        customerId: customer?.id ?? null,
        customerName: input.customer.name,
        customerEmail: input.customer.email,
        customerPhone: input.customer.phone,
        itemCount: totals.itemCount,
        subtotal: totals.subtotal,
        productSavings: totals.productSavings,
        couponCode: coupon?.code ?? null,
        couponDescription: coupon?.description ?? null,
        couponDiscount: totals.couponDiscount,
        gst: totals.gst,
        shipping: totals.shipping,
        grandTotal: totals.grandTotal,
        shippingAddress: toSnapshot(input.shippingAddress),
        billingAddress: toSnapshot(input.billingAddress),
        customerNotes: input.notes || null,
        paymentProvider: gateway.name,
        fulfilmentLocationId: onlineFulfilmentLocationId,
      })
      .returning();

    await tx.insert(orderItems).values(
      quote.lines.map(({ item, entry, pricing, netWeight, grossWeight }) => ({
        orderId: row!.id,
        productId: entry.row.id,
        slug: entry.row.slug,
        name: entry.row.name,
        sku: entry.row.sku,
        image: entry.row.images[0] ?? { url: "", alt: entry.row.name },
        metal: entry.row.metal,
        purity: entry.row.purity,
        size: item.size ?? null,
        customization: item.customization ?? null,
        grossWeight,
        netWeight,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
        priceSnapshot: pricing,
      })),
    );
    await tx.insert(orderStatusEvents).values({
      orderId: row!.id,
      status: "new",
      actorType: customer ? "customer" : "system",
      actorName: customer ? input.customer.name : "Guest checkout",
    });
    return row!;
  });

  let providerOrderId: string;
  try {
    ({ providerOrderId } = await gateway.createPayment({ id: order.id, orderNumber: order.orderNumber, amount: order.grandTotal }));
  } catch (error) {
    logger.error({ err: error, orderNumber: order.orderNumber }, "Could not start payment");
    await db().update(orders).set({ paymentStatus: "failed", updatedAt: new Date() }).where(eq(orders.id, order.id));
    throw new AppError("payment_failed", "We couldn't start the payment. Please try again.");
  }
  await db().update(orders).set({ providerOrderId, updatedAt: new Date() }).where(eq(orders.id, order.id));

  const paymentIntent: PaymentIntent = {
    provider: gateway.name,
    ...(gateway.keyId ? { keyId: gateway.keyId } : {}),
    providerOrderId,
    amount: order.grandTotal,
    currency: "INR",
  };
  return { order: await loadOrderDto(db(), order.id), paymentIntent };
}

/**
 * Idempotently completes a paid order: confirms it, deducts stock at the
 * fulfilment location, counts coupon usage, records the online sale and
 * invoice, and alerts staff. Safe to call from both the browser callback
 * and the payment webhook.
 */
export async function finalizePaidOrder(orderId: string, payment: { providerPaymentId: string; method: string | null }) {
  const outcome = await db().transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!order) throw notFound();
    if (order.paymentStatus === "paid") return { alreadyPaid: true };

    const now = new Date();
    await tx
      .update(orders)
      .set({
        paymentStatus: "paid",
        providerPaymentId: payment.providerPaymentId,
        paymentMethod: payment.method,
        paidAt: now,
        status: order.status === "new" ? "confirmed" : order.status,
        updatedAt: now,
      })
      .where(eq(orders.id, order.id));
    if (order.status === "new") {
      await tx.insert(orderStatusEvents).values({ orderId: order.id, status: "confirmed", note: "Payment received", actorType: "system", actorName: "System" });
    }

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const { onlineFulfilmentLocationId } = await getSetting("inventory", tx);
    const locationId = order.fulfilmentLocationId ?? onlineFulfilmentLocationId;
    const shortfalls: string[] = [];
    for (const item of items) {
      if (!item.productId) continue;
      try {
        await applyStockChange(tx, { ...SYSTEM_ACTOR, name: "Website" }, {
          productId: item.productId,
          type: "sale",
          locationId,
          quantity: item.quantity,
          reason: "Online order",
          reference: { type: "order", id: order.id, label: order.orderNumber },
        });
      } catch (error) {
        if (!(error instanceof AppError) || (error.code !== "validation_error" && error.code !== "not_found")) throw error;
        shortfalls.push(`${item.name} (${item.sku})`);
      }
      await tx
        .update(products)
        .set({ salesCount: sql`${products.salesCount} + ${item.quantity}` })
        .where(eq(products.id, item.productId));
    }
    await tx.update(orders).set({ stockCommitted: shortfalls.length === 0 }).where(eq(orders.id, order.id));
    if (shortfalls.length) {
      await notify(tx, {
        type: "stock_conflict",
        title: "Paid order needs stock review",
        body: `${order.orderNumber} was paid, but stock could not be deducted for: ${shortfalls.join(", ")}.`,
        href: `/admin/orders/${order.id}`,
        permission: "orders:view",
      });
    }

    if (order.couponCode) {
      await tx
        .update(coupons)
        .set({ usedCount: sql`${coupons.usedCount} + 1` })
        .where(eq(sql`upper(${coupons.code})`, order.couponCode.toUpperCase()));
    }

    await recordOnlineSale(tx, order.id, { method: payment.method, reference: payment.providerPaymentId });
    await notify(tx, {
      type: "new_order",
      title: "New order",
      body: `${order.orderNumber} · ${formatINR(order.grandTotal)} · ${order.customerName}`,
      href: `/admin/orders/${order.id}`,
      permission: "orders:view",
    });
    return { alreadyPaid: false };
  });
  if (!outcome.alreadyPaid) invalidateCatalog();
  return outcome;
}

/** Marks a still-pending payment as failed (never overrides a verified payment). */
export async function markPaymentFailed(orderId: string) {
  const [updated] = await db()
    .update(orders)
    .set({ paymentStatus: "failed", updatedAt: new Date() })
    .where(and(eq(orders.id, orderId), eq(orders.paymentStatus, "pending")))
    .returning();
  if (updated) {
    await notify(db(), {
      type: "payment_failed",
      title: "Payment failed",
      body: `Payment for ${updated.orderNumber} (${formatINR(updated.grandTotal)}) did not complete.`,
      href: `/admin/orders/${updated.id}`,
      permission: "orders:view",
    });
  }
}
