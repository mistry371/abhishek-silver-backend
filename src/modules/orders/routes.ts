import { desc, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "@/db/client";
import { orders } from "@/db/schema";
import { optionalCustomer, requireCustomer } from "@/http/auth";
import { rateLimit } from "@/http/middleware";
import { AppError, notFound, unauthorized } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { parse } from "@/lib/validation";
import { paymentGateway, razorpayMethodLabel } from "./payment-gateway";
import { loadOrderDto, loadOrderDtos } from "./presenter";
import { createOrder, createOrderSchema, finalizePaidOrder, markPaymentFailed } from "./service";

export const ordersRouter = Router();
ordersRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

ordersRouter.post("/orders", rateLimit({ name: "orders", windowMs: 10 * 60_000, max: 30 }), optionalCustomer({ strict: true }), async (req, res) => {
  const input = parse(createOrderSchema, req.body);
  res.status(201).json(await createOrder(input, req.customer ?? null));
});

ordersRouter.get("/orders", requireCustomer, async (req, res) => {
  const rows = await db().select().from(orders).where(eq(orders.customerId, req.customer!.id)).orderBy(desc(orders.createdAt)).limit(100);
  res.json(await loadOrderDtos(db(), rows));
});

/** Customer orders require the owner's session; guest orders are reachable only by their unguessable id. */
ordersRouter.get("/orders/:id", optionalCustomer(), async (req, res) => {
  const id = String(req.params.id);
  const [order] = isUuid(id)
    ? await db().select().from(orders).where(eq(orders.id, id)).limit(1)
    : req.customer
      ? await db().select().from(orders).where(eq(orders.orderNumber, id)).limit(1)
      : [];
  if (!order) throw notFound();
  if (order.customerId) {
    if (!req.customer) throw unauthorized();
    if (req.customer.id !== order.customerId) throw notFound();
  }
  res.json(await loadOrderDto(db(), order.id));
});

const verifySchema = z.object({
  providerOrderId: z.string().trim().min(1).max(100),
  providerPaymentId: z.string().trim().min(1).max(100),
  signature: z.string().trim().min(1).max(256),
});

ordersRouter.post("/orders/:id/payments/verify", rateLimit({ name: "payment-verify", windowMs: 10 * 60_000, max: 30 }), async (req, res) => {
  const input = parse(verifySchema, req.body);
  if (!isUuid(req.params.id)) throw notFound();
  const [order] = await db().select().from(orders).where(eq(orders.id, req.params.id)).limit(1);
  if (!order || order.providerOrderId !== input.providerOrderId) throw notFound();

  if (order.paymentStatus !== "paid") {
    const gateway = paymentGateway();
    if (!gateway.verifySignature(input)) {
      await markPaymentFailed(order.id);
      throw new AppError("payment_failed");
    }
    await finalizePaidOrder(order.id, { providerPaymentId: input.providerPaymentId, method: await gateway.paymentMethod(input.providerPaymentId) });
  }
  res.json(await loadOrderDto(db(), order.id));
});

ordersRouter.post("/orders/:id/payments/failed", async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound();
  const [order] = await db().select({ id: orders.id }).from(orders).where(eq(orders.id, req.params.id)).limit(1);
  if (!order) throw notFound();
  await markPaymentFailed(order.id);
  res.json(await loadOrderDto(db(), order.id));
});

/* ------------------------------------------------------------------ */
/* Razorpay webhook (mounted with a raw body parser)                   */
/* ------------------------------------------------------------------ */

interface RazorpayWebhook {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; method?: string } };
    order?: { entity?: { id?: string } };
  };
}

export const webhooksRouter = Router();

webhooksRouter.post("/razorpay", async (req, res) => {
  const gateway = paymentGateway();
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (gateway.name !== "razorpay" || !gateway.verifyWebhook(raw, req.get("x-razorpay-signature") ?? "")) {
    throw unauthorized();
  }

  let event: RazorpayWebhook;
  try {
    event = JSON.parse(raw.toString("utf8")) as RazorpayWebhook;
  } catch {
    throw new AppError("validation_error");
  }

  const payment = event.payload?.payment?.entity;
  const providerOrderId = payment?.order_id ?? event.payload?.order?.entity?.id;
  if (providerOrderId) {
    const [order] = await db().select().from(orders).where(eq(orders.providerOrderId, providerOrderId)).limit(1);
    if (!order) {
      logger.warn({ event: event.event }, "Razorpay webhook for unknown order");
    } else if ((event.event === "payment.captured" || event.event === "order.paid") && payment?.id) {
      await finalizePaidOrder(order.id, { providerPaymentId: payment.id, method: razorpayMethodLabel(payment.method) });
    } else if (event.event === "payment.failed") {
      await markPaymentFailed(order.id);
    }
  }
  res.json({ ok: true });
});
