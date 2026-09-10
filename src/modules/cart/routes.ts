import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import type { CartItemInput } from "@/contracts/storefront";
import { db } from "@/db/client";
import { carts } from "@/db/schema";
import { optionalCustomer, requireCustomer } from "@/http/auth";
import { notFound } from "@/lib/errors";
import { parse } from "@/lib/validation";
import { cartItemSchema, couponCodeSchema } from "@/modules/account/schemas";
import { lineIdFor, quoteCart } from "./quote";

export const cartRouter = Router();
cartRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const quoteSchema = z.object({ items: z.array(cartItemSchema).max(50), couponCode: couponCodeSchema });

cartRouter.post("/cart/quote", optionalCustomer(), async (req, res) => {
  const input = parse(quoteSchema, req.body);
  res.json((await quoteCart(input)).cart);
});

/* ------------------------------------------------------------------ */
/* Server cart for signed-in customers                                 */
/* ------------------------------------------------------------------ */

async function loadCart(customerId: string) {
  const [row] = await db().select().from(carts).where(eq(carts.customerId, customerId)).limit(1);
  return { items: row?.items ?? [], couponCode: row?.couponCode ?? null };
}

/** Quotes, then stores the normalised lines so the saved cart mirrors what the customer sees. */
async function saveAndQuote(customerId: string, items: CartItemInput[], couponCode: string | null) {
  const { cart } = await quoteCart({ items, couponCode });
  const normalised = cart.items.map(({ productId, slug, size, quantity, customization }) => ({
    productId,
    slug,
    quantity,
    ...(size ? { size } : {}),
    ...(customization ? { customization } : {}),
  }));
  const storedCoupon = cart.coupon?.code ?? null;
  await db()
    .insert(carts)
    .values({ customerId, items: normalised, couponCode: storedCoupon })
    .onConflictDoUpdate({ target: carts.customerId, set: { items: normalised, couponCode: storedCoupon, updatedAt: new Date() } });
  return cart;
}

cartRouter.get("/cart", requireCustomer, async (req, res) => {
  const stored = await loadCart(req.customer!.id);
  res.json((await quoteCart(stored)).cart);
});

cartRouter.post("/cart/items", requireCustomer, async (req, res) => {
  const { item, couponCode } = parse(z.object({ item: cartItemSchema, couponCode: couponCodeSchema }), req.body);
  const stored = await loadCart(req.customer!.id);
  res.json(await saveAndQuote(req.customer!.id, [...stored.items, item], couponCode === undefined ? stored.couponCode : couponCode));
});

cartRouter.patch("/cart/items/:lineId", requireCustomer, async (req, res) => {
  const { quantity, couponCode } = parse(z.object({ quantity: z.coerce.number().int().min(1).max(99), couponCode: couponCodeSchema }), req.body);
  const stored = await loadCart(req.customer!.id);
  if (!stored.items.some((item) => lineIdFor(item) === req.params.lineId)) throw notFound();
  const items = stored.items.map((item) => (lineIdFor(item) === req.params.lineId ? { ...item, quantity } : item));
  res.json(await saveAndQuote(req.customer!.id, items, couponCode === undefined ? stored.couponCode : couponCode));
});

cartRouter.delete("/cart/items/:lineId", requireCustomer, async (req, res) => {
  const stored = await loadCart(req.customer!.id);
  const items = stored.items.filter((item) => lineIdFor(item) !== req.params.lineId);
  res.json(await saveAndQuote(req.customer!.id, items, stored.couponCode));
});
