import { asc, eq, inArray } from "drizzle-orm";
import type { OrderDto } from "@/contracts/storefront";
import type { Executor } from "@/db/client";
import { orderItems, orders, orderStatusEvents } from "@/db/schema";
import { notFound } from "@/lib/errors";

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type OrderEventRow = typeof orderStatusEvents.$inferSelect;

export function toOrderDto(order: OrderRow, items: OrderItemRow[], events: OrderEventRow[]): OrderDto {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    customer: { name: order.customerName, email: order.customerEmail, phone: order.customerPhone },
    items: items.map((item) => ({
      id: item.id,
      productId: item.productId ?? "",
      slug: item.slug,
      name: item.name,
      sku: item.sku,
      image: item.image,
      metal: item.metal,
      purity: item.purity,
      ...(item.size ? { size: item.size } : {}),
      ...(item.customization ? { customization: item.customization } : {}),
      grossWeight: item.grossWeight,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
    })),
    shippingAddress: order.shippingAddress,
    billingAddress: order.billingAddress,
    totals: {
      itemCount: order.itemCount,
      subtotal: order.subtotal,
      productSavings: order.productSavings,
      couponDiscount: order.couponDiscount,
      gst: order.gst,
      shipping: order.shipping,
      grandTotal: order.grandTotal,
    },
    coupon: order.couponCode ? { code: order.couponCode, description: order.couponDescription ?? "", discount: order.couponDiscount } : null,
    payment: {
      id: `pay_${order.orderNumber}`,
      provider: order.paymentProvider,
      status: order.paymentStatus,
      ...(order.paymentMethod ? { method: order.paymentMethod } : {}),
      amount: order.grandTotal,
      ...(order.providerOrderId ? { providerOrderId: order.providerOrderId } : {}),
      ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
      ...(order.paidAt ? { paidAt: order.paidAt.toISOString() } : {}),
    },
    timeline: events.map((event) => ({ status: event.status, at: event.createdAt.toISOString(), ...(event.note ? { note: event.note } : {}) })),
    invoiceUrl: null,
    carrier: order.carrier,
    trackingNumber: order.trackingNumber,
    ...(order.customerNotes ? { notes: order.customerNotes } : {}),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

export async function loadOrderDtos(executor: Executor, rows: OrderRow[]): Promise<OrderDto[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [items, events] = await Promise.all([
    executor.select().from(orderItems).where(inArray(orderItems.orderId, ids)),
    executor.select().from(orderStatusEvents).where(inArray(orderStatusEvents.orderId, ids)).orderBy(asc(orderStatusEvents.createdAt)),
  ]);
  return rows.map((row) =>
    toOrderDto(
      row,
      items.filter((item) => item.orderId === row.id),
      events.filter((event) => event.orderId === row.id),
    ),
  );
}

export async function loadOrderDto(executor: Executor, orderId: string): Promise<OrderDto> {
  const [row] = await executor.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!row) throw notFound();
  const [dto] = await loadOrderDtos(executor, [row]);
  return dto!;
}
