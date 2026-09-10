import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db, type Tx } from "@/db/client";
import {
  invoiceEvents,
  invoices,
  orderCommunications,
  orderItems,
  orderNotes,
  orderReturns,
  orders,
  orderStatusEvents,
  refunds,
  sales,
  stockMovements,
  type OrderStatus,
  type ReturnLine,
} from "@/db/schema";
import { adminOf, requirePermission } from "@/http/auth";
import { AppError, invalid, notFound } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { round2 } from "@/lib/money";
import { paginated, parse, zBoolQuery, zCsv, zDate, zText, zUuid } from "@/lib/validation";
import { addressSchema, toSnapshot } from "@/modules/account/schemas";
import { paymentGateway } from "@/modules/orders/payment-gateway";
import { loadOrderDto } from "@/modules/orders/presenter";
import { actorOf, recordAudit, type Actor } from "@/services/audit";
import { applyStockChange } from "@/services/inventory";
import { afterCatalogChange } from "@/services/revalidate";
import { documentNumbers } from "@/services/sequences";
import { getSetting } from "@/services/settings";
import { placedOrder } from "./dashboard";
import { idParam, listQuery, searchAny, sortBy, withinDates } from "./helpers";

export const ordersAdminRouter = Router();

const ORDER_STATUSES = ["new", "confirmed", "processing", "packed", "shipped", "delivered", "completed", "cancelled", "returned", "refunded"] as const;

/** Documented lifecycle: New → Confirmed → Processing → Packed → Shipped → Delivered → Completed, with cancel/return/refund branches. */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  new: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["packed", "cancelled"],
  packed: ["shipped", "cancelled"],
  shipped: ["delivered", "returned"],
  delivered: ["completed", "returned"],
  completed: ["returned"],
  cancelled: ["refunded"],
  returned: ["refunded"],
  refunded: [],
};

const formatINR = (value: number) => `₹${value.toLocaleString("en-IN")}`;

async function lockOrder(tx: Tx, id: string) {
  const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for("update");
  if (!order) throw notFound("Order not found.");
  return order;
}

async function addEvent(tx: Tx, orderId: string, status: OrderStatus, actor: Actor, note?: string | null) {
  await tx.insert(orderStatusEvents).values({ orderId, status, note: note || null, actorType: actor.adminId ? "admin" : "system", actorName: actor.name });
}

/* ------------------------------------------------------------------ */
/* Listing & detail                                                    */
/* ------------------------------------------------------------------ */

const listSchema = listQuery.extend({
  status: zCsv(z.enum(ORDER_STATUSES)),
  paymentStatus: z.enum(["pending", "authorized", "paid", "failed", "refunded"]).optional(),
  customerId: zUuid.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  /** Include checkout attempts that never completed payment. */
  includeUnpaid: zBoolQuery,
});

ordersAdminRouter.get("/orders", requirePermission("orders:view"), async (req, res) => {
  const query = parse(listSchema, req.query);
  const base = and(
    query.includeUnpaid ? undefined : placedOrder(),
    query.paymentStatus ? eq(orders.paymentStatus, query.paymentStatus) : undefined,
    query.customerId ? eq(orders.customerId, query.customerId) : undefined,
    ...withinDates(orders.createdAt, query.from, query.to),
    searchAny(query.q, [orders.orderNumber, orders.customerName, orders.customerPhone, orders.customerEmail]),
  );
  const where = and(base, query.status?.length ? inArray(orders.status, query.status) : undefined);

  const rows = await db()
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      paymentMethod: orders.paymentMethod,
      customerId: orders.customerId,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      itemCount: orders.itemCount,
      grandTotal: orders.grandTotal,
      stockCommitted: orders.stockCommitted,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
    })
    .from(orders)
    .where(where)
    .orderBy(sortBy(query.sort, { createdAt: orders.createdAt, grandTotal: orders.grandTotal, updatedAt: orders.updatedAt }, desc(orders.createdAt)))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db().select({ value: count() }).from(orders).where(where);
  const statusCounts = await db()
    .select({ status: orders.status, value: count() })
    .from(orders)
    .where(base)
    .groupBy(orders.status);

  res.json({ ...paginated(rows, total?.value ?? 0, query.page, query.pageSize), statusCounts: Object.fromEntries(statusCounts.map((s) => [s.status, s.value])) });
});

async function orderDetail(id: string) {
  const database = db();
  const [order] = await database.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) throw notFound("Order not found.");
  const dto = await loadOrderDto(database, id);
  const notes = await database.select().from(orderNotes).where(eq(orderNotes.orderId, id)).orderBy(desc(orderNotes.createdAt));
  const communications = await database.select().from(orderCommunications).where(eq(orderCommunications.orderId, id)).orderBy(desc(orderCommunications.createdAt));
  const returns = await database.select().from(orderReturns).where(eq(orderReturns.orderId, id)).orderBy(desc(orderReturns.createdAt));
  const refundRows = await database.select().from(refunds).where(eq(refunds.orderId, id)).orderBy(desc(refunds.createdAt));
  const invoiceRows = await database
    .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status, grandTotal: invoices.grandTotal })
    .from(invoices)
    .where(eq(invoices.orderId, id));
  const saleRows = await database.select({ id: sales.id, saleNumber: sales.saleNumber, paymentStatus: sales.paymentStatus }).from(sales).where(eq(sales.orderId, id));
  const references = [id, ...returns.map((r) => r.id)];
  const movements = await database
    .select()
    .from(stockMovements)
    .where(and(inArray(stockMovements.referenceType, ["order", "return"]), inArray(stockMovements.referenceId, references)))
    .orderBy(asc(stockMovements.createdAt));

  return {
    ...dto,
    customerId: order.customerId,
    paymentProvider: order.paymentProvider,
    stockCommitted: order.stockCommitted,
    fulfilmentLocationId: order.fulfilmentLocationId,
    allowedTransitions: ORDER_TRANSITIONS[order.status],
    internalNotes: notes,
    communications,
    returns,
    refunds: refundRows,
    refundedAmount: round2(refundRows.filter((r) => r.status === "processed").reduce((sum, r) => sum + r.amount, 0)),
    pendingRefundAmount: round2(refundRows.filter((r) => r.status === "pending").reduce((sum, r) => sum + r.amount, 0)),
    invoices: invoiceRows,
    sales: saleRows,
    stockMovements: movements,
  };
}

ordersAdminRouter.get("/orders/:id", requirePermission("orders:view"), async (req, res) => {
  res.json(await orderDetail(idParam(req)));
});

/* ------------------------------------------------------------------ */
/* Status workflow                                                     */
/* ------------------------------------------------------------------ */

const statusSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  /** Shown to the customer in their order timeline. */
  note: z.string().trim().max(500).optional(),
  carrier: z.string().trim().max(80).optional(),
  trackingNumber: z.string().trim().max(80).optional(),
  /** When cancelling an order whose stock was deducted, put the stock back. */
  restock: z.boolean().default(true),
});

ordersAdminRouter.post("/orders/:id/status", requirePermission("orders:update_status"), async (req, res) => {
  const id = idParam(req);
  const input = parse(statusSchema, req.body);
  const actor = actorOf(req);

  const restocked = await db().transaction(async (tx) => {
    const order = await lockOrder(tx, id);
    if (!ORDER_TRANSITIONS[order.status].includes(input.status)) {
      throw new AppError("validation_error", `An order can't move from “${order.status}” to “${input.status}”.`);
    }
    if (input.status === "confirmed" && order.paymentStatus !== "paid") {
      throw new AppError("validation_error", "Only paid orders can be confirmed.");
    }
    if (input.status === "returned") {
      const [received] = await tx
        .select({ id: orderReturns.id })
        .from(orderReturns)
        .where(and(eq(orderReturns.orderId, id), inArray(orderReturns.status, ["received", "closed"])))
        .limit(1);
      if (!received) throw new AppError("validation_error", "Record and receive a return for this order first.");
    }
    if (input.status === "refunded") {
      const [processed] = await tx
        .select({ value: sql<number>`coalesce(sum(${refunds.amount}), 0)`.mapWith(Number) })
        .from(refunds)
        .where(and(eq(refunds.orderId, id), eq(refunds.status, "processed")));
      if (!processed || processed.value <= 0) throw new AppError("validation_error", "Process a refund for this order first.");
    }

    let didRestock = false;
    if (input.status === "cancelled" && order.stockCommitted && input.restock) {
      const { onlineFulfilmentLocationId } = await getSetting("inventory", tx);
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, id));
      for (const item of items) {
        if (!item.productId) continue;
        await applyStockChange(tx, actor, {
          productId: item.productId,
          type: "return",
          locationId: order.fulfilmentLocationId ?? onlineFulfilmentLocationId,
          quantity: item.quantity,
          reason: `Order ${order.orderNumber} cancelled`,
          reference: { type: "order", id, label: order.orderNumber },
        });
      }
      didRestock = true;
    }

    await tx
      .update(orders)
      .set({
        status: input.status,
        ...(didRestock ? { stockCommitted: false } : {}),
        ...(input.carrier !== undefined ? { carrier: input.carrier || null } : {}),
        ...(input.trackingNumber !== undefined ? { trackingNumber: input.trackingNumber || null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(orders.id, id));
    await addEvent(tx, id, input.status, actor, input.note);
    await recordAudit(tx, actor, {
      module: "orders",
      action: "order.status_change",
      entityType: "order",
      entityId: id,
      entityLabel: order.orderNumber,
      before: { status: order.status },
      after: { status: input.status, restocked: didRestock, carrier: input.carrier, trackingNumber: input.trackingNumber },
      reason: input.note ?? null,
      sensitive: true,
    });
    return didRestock;
  });

  if (restocked) afterCatalogChange();
  res.json(await orderDetail(id));
});

ordersAdminRouter.patch("/orders/:id", requirePermission("orders:manage"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(
    z.object({
      carrier: z.string().trim().max(80).nullable().optional(),
      trackingNumber: z.string().trim().max(80).nullable().optional(),
      shippingAddress: addressSchema.optional(),
    }),
    req.body,
  );
  const actor = actorOf(req);
  await db().transaction(async (tx) => {
    const order = await lockOrder(tx, id);
    if (patch.shippingAddress && ["shipped", "delivered", "completed", "returned", "refunded"].includes(order.status)) {
      throw invalid({ shippingAddress: "The shipping address can't change after dispatch." });
    }
    await tx
      .update(orders)
      .set({
        ...(patch.carrier !== undefined ? { carrier: patch.carrier || null } : {}),
        ...(patch.trackingNumber !== undefined ? { trackingNumber: patch.trackingNumber || null } : {}),
        ...(patch.shippingAddress ? { shippingAddress: toSnapshot(patch.shippingAddress) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(orders.id, id));
    await recordAudit(tx, actor, {
      module: "orders",
      action: "order.update",
      entityType: "order",
      entityId: id,
      entityLabel: order.orderNumber,
      before: { carrier: order.carrier, trackingNumber: order.trackingNumber, ...(patch.shippingAddress ? { shippingAddress: order.shippingAddress } : {}) },
      after: patch,
    });
  });
  res.json(await orderDetail(id));
});

ordersAdminRouter.post("/orders/:id/notes", requirePermission("orders:manage"), async (req, res) => {
  const id = idParam(req);
  const { body } = parse(z.object({ body: zText(2000) }), req.body);
  const admin = adminOf(req);
  const [order] = await db().select({ id: orders.id }).from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) throw notFound();
  const [note] = await db().insert(orderNotes).values({ orderId: id, body, authorAdminId: admin.id, authorName: admin.name }).returning();
  res.status(201).json(note);
});

ordersAdminRouter.post("/orders/:id/communications", requirePermission("orders:manage"), async (req, res) => {
  const id = idParam(req);
  const input = parse(
    z.object({
      channel: z.enum(["phone", "whatsapp", "email", "sms", "in_person"]),
      direction: z.enum(["outbound", "inbound"]),
      summary: zText(1000),
    }),
    req.body,
  );
  const [order] = await db().select({ id: orders.id }).from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) throw notFound();
  const [row] = await db()
    .insert(orderCommunications)
    .values({ orderId: id, ...input, authorName: adminOf(req).name })
    .returning();
  res.status(201).json(row);
});

/* ------------------------------------------------------------------ */
/* Returns                                                             */
/* ------------------------------------------------------------------ */

ordersAdminRouter.get("/returns", requirePermission("orders:view"), async (req, res) => {
  const query = parse(listQuery.extend({ status: z.enum(["requested", "approved", "received", "rejected", "closed"]).optional() }), req.query);
  const where = and(query.status ? eq(orderReturns.status, query.status) : undefined, searchAny(query.q, [orderReturns.returnNumber, orders.orderNumber, orders.customerName]));
  const rows = await db()
    .select({ ret: orderReturns, orderNumber: orders.orderNumber, customerName: orders.customerName })
    .from(orderReturns)
    .innerJoin(orders, eq(orders.id, orderReturns.orderId))
    .where(where)
    .orderBy(desc(orderReturns.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db()
    .select({ value: count() })
    .from(orderReturns)
    .innerJoin(orders, eq(orders.id, orderReturns.orderId))
    .where(where);
  res.json(
    paginated(
      rows.map((r) => ({ ...r.ret, orderNumber: r.orderNumber, customerName: r.customerName })),
      total?.value ?? 0,
      query.page,
      query.pageSize,
    ),
  );
});

ordersAdminRouter.post("/orders/:id/returns", requirePermission("orders:returns"), async (req, res) => {
  const id = idParam(req);
  const input = parse(
    z.object({
      reason: zText(500),
      items: z.array(z.object({ orderItemId: zUuid, quantity: z.number().int().min(1).max(1000) })).min(1).max(50),
      notes: z.string().trim().max(2000).optional(),
    }),
    req.body,
  );
  const actor = actorOf(req);

  await db().transaction(async (tx) => {
    const order = await lockOrder(tx, id);
    if (!["shipped", "delivered", "completed"].includes(order.status)) {
      throw new AppError("validation_error", "Returns can be recorded for shipped, delivered or completed orders.");
    }
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, id));
    const previous = await tx
      .select({ items: orderReturns.items })
      .from(orderReturns)
      .where(and(eq(orderReturns.orderId, id), ne(orderReturns.status, "rejected")));
    const alreadyReturned = new Map<string, number>();
    for (const ret of previous) for (const line of ret.items) alreadyReturned.set(line.orderItemId, (alreadyReturned.get(line.orderItemId) ?? 0) + line.quantity);

    const errors: Record<string, string> = {};
    const lines: ReturnLine[] = [];
    input.items.forEach((line, index) => {
      const item = items.find((i) => i.id === line.orderItemId);
      if (!item) {
        errors[`items.${index}.orderItemId`] = "This item isn't part of the order.";
        return;
      }
      const remaining = item.quantity - (alreadyReturned.get(item.id) ?? 0);
      if (line.quantity > remaining) errors[`items.${index}.quantity`] = `Only ${remaining} can still be returned.`;
      lines.push({ orderItemId: item.id, productId: item.productId, name: item.name, sku: item.sku, quantity: line.quantity });
    });
    if (Object.keys(errors).length) throw invalid(errors);

    const [ret] = await tx
      .insert(orderReturns)
      .values({ returnNumber: await documentNumbers.return(tx), orderId: id, reason: input.reason, items: lines, notes: input.notes || null, createdByName: actor.name })
      .returning();
    await recordAudit(tx, actor, {
      module: "orders",
      action: "return.create",
      entityType: "order_return",
      entityId: ret!.id,
      entityLabel: `${ret!.returnNumber} (${order.orderNumber})`,
      after: { items: lines.map((l) => `${l.sku} × ${l.quantity}`) },
      reason: input.reason,
    });
  });
  res.status(201).json(await orderDetail(id));
});

const RETURN_TRANSITIONS: Record<string, string[]> = {
  requested: ["approved", "rejected"],
  approved: ["received", "rejected"],
  received: ["closed"],
  // Rejected is final, so rejected returns never count against returnable quantity.
  rejected: [],
  closed: [],
};

ordersAdminRouter.post("/returns/:id/status", requirePermission("orders:returns"), async (req, res) => {
  const returnId = idParam(req);
  const input = parse(
    z.object({
      status: z.enum(["approved", "received", "rejected", "closed"]),
      restock: z.boolean().default(true),
      locationId: z.string().trim().max(40).optional(),
      note: z.string().trim().max(1000).optional(),
    }),
    req.body,
  );
  const actor = actorOf(req);

  const result = await db().transaction(async (tx) => {
    const [ret] = await tx.select().from(orderReturns).where(eq(orderReturns.id, returnId)).for("update");
    if (!ret) throw notFound("Return not found.");
    if (!RETURN_TRANSITIONS[ret.status]!.includes(input.status)) {
      throw new AppError("validation_error", `A return can't move from “${ret.status}” to “${input.status}”.`);
    }
    const order = await lockOrder(tx, ret.orderId);

    let restocked = false;
    let restockLocationId: string | null = null;
    if (input.status === "received" && input.restock) {
      const { defaultLocationId } = await getSetting("inventory", tx);
      restockLocationId = input.locationId ?? order.fulfilmentLocationId ?? defaultLocationId;
      for (const line of ret.items) {
        if (!line.productId) continue;
        await applyStockChange(tx, actor, {
          productId: line.productId,
          type: "return",
          locationId: restockLocationId,
          quantity: line.quantity,
          reason: `Return ${ret.returnNumber} for ${order.orderNumber}`,
          reference: { type: "return", id: ret.id, label: ret.returnNumber },
        });
      }
      restocked = true;
    }

    await tx
      .update(orderReturns)
      .set({
        status: input.status,
        ...(restocked ? { restocked: true, restockLocationId } : {}),
        ...(input.note ? { notes: [ret.notes, input.note].filter(Boolean).join("\n") } : {}),
        updatedAt: new Date(),
      })
      .where(eq(orderReturns.id, returnId));

    if (input.status === "received" && ORDER_TRANSITIONS[order.status].includes("returned")) {
      await tx.update(orders).set({ status: "returned", updatedAt: new Date() }).where(eq(orders.id, order.id));
      await addEvent(tx, order.id, "returned", actor, `Return ${ret.returnNumber} received`);
    }
    await recordAudit(tx, actor, {
      module: "orders",
      action: "return.status_change",
      entityType: "order_return",
      entityId: ret.id,
      entityLabel: `${ret.returnNumber} (${order.orderNumber})`,
      before: { status: ret.status },
      after: { status: input.status, restocked, restockLocationId },
      reason: input.note ?? null,
      sensitive: restocked,
    });
    return { orderId: order.id, restocked };
  });

  if (result.restocked) afterCatalogChange();
  res.json(await orderDetail(result.orderId));
});

/* ------------------------------------------------------------------ */
/* Refunds                                                             */
/* ------------------------------------------------------------------ */

ordersAdminRouter.get("/refunds", requirePermission("orders:view"), async (req, res) => {
  const query = parse(listQuery.extend({ status: z.enum(["pending", "processed", "failed"]).optional() }), req.query);
  const where = and(query.status ? eq(refunds.status, query.status) : undefined, searchAny(query.q, [refunds.refundNumber, orders.orderNumber, orders.customerName]));
  const rows = await db()
    .select({ refund: refunds, orderNumber: orders.orderNumber, customerName: orders.customerName })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(where)
    .orderBy(desc(refunds.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db()
    .select({ value: count() })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(where);
  res.json(
    paginated(
      rows.map((r) => ({ ...r.refund, orderNumber: r.orderNumber, customerName: r.customerName })),
      total?.value ?? 0,
      query.page,
      query.pageSize,
    ),
  );
});

ordersAdminRouter.post("/orders/:id/refunds", requirePermission("orders:refunds"), async (req, res) => {
  const id = idParam(req);
  const input = parse(
    z.object({
      amount: z.number().positive().max(100_000_000),
      method: z.enum(["original_payment", "bank_transfer", "cash", "upi"]),
      reason: zText(500),
      returnId: zUuid.optional(),
      reference: z.string().trim().max(120).optional(),
    }),
    req.body,
  );
  const actor = actorOf(req);

  await db().transaction(async (tx) => {
    const order = await lockOrder(tx, id);
    if (order.paymentStatus !== "paid") throw new AppError("validation_error", "Only paid orders can be refunded.");
    if (input.method === "original_payment" && !order.providerPaymentId) {
      throw invalid({ method: "This order has no gateway payment to refund. Choose another method." });
    }
    if (input.returnId) {
      const [ret] = await tx
        .select({ id: orderReturns.id })
        .from(orderReturns)
        .where(and(eq(orderReturns.id, input.returnId), eq(orderReturns.orderId, id)))
        .limit(1);
      if (!ret) throw invalid({ returnId: "Choose a return that belongs to this order." });
    }
    const [committed] = await tx
      .select({ value: sql<number>`coalesce(sum(${refunds.amount}), 0)`.mapWith(Number) })
      .from(refunds)
      .where(and(eq(refunds.orderId, id), inArray(refunds.status, ["pending", "processed"])));
    const refundable = round2(order.grandTotal - (committed?.value ?? 0));
    if (input.amount > refundable) throw invalid({ amount: `Up to ${formatINR(refundable)} can still be refunded.` });

    const [refund] = await tx
      .insert(refunds)
      .values({
        refundNumber: await documentNumbers.refund(tx),
        orderId: id,
        returnId: input.returnId ?? null,
        amount: round2(input.amount),
        method: input.method,
        reason: input.reason,
        reference: input.reference || null,
        createdByName: actor.name,
      })
      .returning();
    await recordAudit(tx, actor, {
      module: "orders",
      action: "refund.create",
      entityType: "refund",
      entityId: refund!.id,
      entityLabel: `${refund!.refundNumber} (${order.orderNumber})`,
      after: { amount: refund!.amount, method: refund!.method },
      reason: input.reason,
      sensitive: true,
    });
  });
  res.status(201).json(await orderDetail(id));
});

ordersAdminRouter.post("/refunds/:id/process", requirePermission("orders:refunds"), async (req, res) => {
  const refundId = idParam(req);
  const input = parse(z.object({ outcome: z.enum(["processed", "failed"]), reference: z.string().trim().max(120).optional() }), req.body);
  const actor = actorOf(req);

  const orderId = await db().transaction(async (tx) => {
    const [refund] = await tx.select().from(refunds).where(eq(refunds.id, refundId)).for("update");
    if (!refund) throw notFound("Refund not found.");
    if (refund.status !== "pending") throw new AppError("validation_error", "This refund has already been completed.");
    const order = await lockOrder(tx, refund.orderId);

    let reference = input.reference || refund.reference;
    if (input.outcome === "processed" && refund.method === "original_payment") {
      try {
        reference = (await paymentGateway().refund(order.providerPaymentId!, refund.amount)).refundId;
      } catch (error) {
        logger.error({ err: error, refund: refund.refundNumber }, "Gateway refund failed");
        throw new AppError("payment_failed", "The payment gateway couldn't process this refund. Try again, or refund by another method.");
      }
    }

    await tx
      .update(refunds)
      .set({ status: input.outcome, reference, processedAt: input.outcome === "processed" ? new Date() : null, updatedAt: new Date() })
      .where(eq(refunds.id, refundId));

    if (input.outcome === "processed") {
      const [processed] = await tx
        .select({ value: sql<number>`coalesce(sum(${refunds.amount}), 0)`.mapWith(Number) })
        .from(refunds)
        .where(and(eq(refunds.orderId, order.id), eq(refunds.status, "processed")));
      const fullyRefunded = (processed?.value ?? 0) >= order.grandTotal - 0.005;
      if (fullyRefunded) {
        await tx.update(orders).set({ paymentStatus: "refunded", updatedAt: new Date() }).where(eq(orders.id, order.id));
        await tx.update(sales).set({ paymentStatus: "refunded" }).where(eq(sales.orderId, order.id));
        if (ORDER_TRANSITIONS[order.status].includes("refunded")) {
          await tx.update(orders).set({ status: "refunded" }).where(eq(orders.id, order.id));
          await addEvent(tx, order.id, "refunded", actor, "Refund processed");
        }
      }
      const linkedInvoices = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.orderId, order.id));
      if (linkedInvoices.length) {
        await tx.insert(invoiceEvents).values(
          linkedInvoices.map((invoice) => ({
            invoiceId: invoice.id,
            action: "refund_recorded",
            note: `${refund.refundNumber}: ${formatINR(refund.amount)} (${refund.method.replace("_", " ")})`,
            actorName: actor.name,
          })),
        );
      }
    }

    await recordAudit(tx, actor, {
      module: "orders",
      action: `refund.${input.outcome}`,
      entityType: "refund",
      entityId: refund.id,
      entityLabel: `${refund.refundNumber} (${order.orderNumber})`,
      after: { amount: refund.amount, reference },
      sensitive: true,
    });
    return order.id;
  });
  res.json(await orderDetail(orderId));
});
