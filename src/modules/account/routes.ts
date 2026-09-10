import { and, asc, desc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/db/client";
import { customerAddresses, customers, enquiries, wishlistItems } from "@/db/schema";
import { bearerToken, loadCustomer, requireCustomer } from "@/http/auth";
import { rateLimit } from "@/http/middleware";
import { forbidden, invalid, notFound } from "@/lib/errors";
import { normalizeIndianMobile } from "@/lib/phone";
import { parse, zEmail, zMobile, zPassword, zText } from "@/lib/validation";
import { catalog, findEntry } from "@/modules/catalog/snapshot";
import { createCustomerRecord } from "@/services/customers";
import { toAddressDto, toCustomerDto, toSessionDto } from "./presenter";
import { addressSchema } from "./schemas";
import { toEnquiryDto } from "@/modules/leads/presenter";

export const accountRouter = Router();
accountRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const authLimiter = rateLimit({ name: "auth", windowMs: 15 * 60_000, max: 20 });
const otpLimiter = rateLimit({ name: "otp", windowMs: 15 * 60_000, max: 6 });

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

accountRouter.post("/auth/login", authLimiter, async (req, res) => {
  const { identifier, password } = parse(z.object({ identifier: z.string().trim().min(1).max(160), password: z.string().min(1).max(200) }), req.body);
  const isEmail = identifier.includes("@");
  const phone = isEmail ? null : normalizeIndianMobile(identifier);
  if (!isEmail && !phone) throw invalid({ identifier: "Enter your email or 10-digit mobile number." });

  const tokens = await auth().signInWithPassword(isEmail ? { email: identifier.toLowerCase(), password } : { phone: phone!, password });
  const customer = await loadCustomer(tokens.identity);
  if (customer.status === "blocked") throw forbidden("This account is unavailable. Please contact the store.");
  res.json(toSessionDto(customer, tokens));
});

const registerSchema = z.object({
  firstName: zText(60),
  lastName: z.string().trim().max(60).default(""),
  email: zEmail,
  phone: zMobile,
  password: zPassword,
  marketingOptIn: z.boolean().default(false),
});

accountRouter.post("/auth/register", authLimiter, async (req, res) => {
  const input = parse(registerSchema, req.body);

  const existing = await db()
    .select({ email: customers.email, phone: customers.phone })
    .from(customers)
    .where(and(isNotNull(customers.authUserId), or(eq(customers.email, input.email), eq(customers.phone, input.phone))));
  const fieldErrors: Record<string, string> = {};
  if (existing.some((c) => c.email === input.email)) fieldErrors.email = "An account with this email already exists.";
  if (existing.some((c) => c.phone === input.phone)) fieldErrors.phone = "An account with this mobile number already exists.";
  if (Object.keys(fieldErrors).length) throw invalid(fieldErrors);

  const tokens = await auth().signUp({ email: input.email, phone: input.phone, password: input.password });
  const customer = await createCustomerRecord(db(), {
    authUserId: tokens.identity.userId,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    marketingOptIn: input.marketingOptIn,
    source: "website",
  });
  res.status(201).json(toSessionDto(customer, tokens));
});

accountRouter.post("/auth/otp/request", otpLimiter, async (req, res) => {
  const { phone } = parse(z.object({ phone: zMobile }), req.body);
  const result = await auth().requestPhoneOtp(phone);
  res.json({ sent: true, ...result });
});

accountRouter.post("/auth/otp/verify", otpLimiter, async (req, res) => {
  const { phone, otp } = parse(z.object({ phone: zMobile, otp: z.string().trim().regex(/^\d{4,8}$/, { error: "Enter the code we sent." }) }), req.body);
  const tokens = await auth().verifyPhoneOtp(phone, otp);
  const customer = await loadCustomer(tokens.identity);
  if (customer.status === "blocked") throw forbidden("This account is unavailable. Please contact the store.");
  res.json(toSessionDto(customer, tokens));
});

accountRouter.post("/auth/refresh", authLimiter, async (req, res) => {
  const { refreshToken } = parse(z.object({ refreshToken: z.string().min(1).max(4000) }), req.body);
  const tokens = await auth().refresh(refreshToken);
  res.json(toSessionDto(await loadCustomer(tokens.identity), tokens));
});

accountRouter.post("/auth/password/forgot", authLimiter, async (req, res) => {
  const { email } = parse(z.object({ email: zEmail }), req.body);
  await auth().requestPasswordReset(email);
  // Same response whether or not the account exists.
  res.json({ ok: true });
});

accountRouter.post("/auth/logout", async (req, res) => {
  const token = bearerToken(req);
  if (token) await auth().signOut(token);
  res.status(204).end();
});

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

accountRouter.get("/me", requireCustomer, (req, res) => {
  res.json(toCustomerDto(req.customer!));
});

accountRouter.patch("/me", requireCustomer, async (req, res) => {
  const patch = parse(
    z.object({
      firstName: zText(60).optional(),
      lastName: z.string().trim().max(60).optional(),
      phone: zMobile.optional(),
      marketingOptIn: z.boolean().optional(),
    }),
    req.body,
  );
  const me = req.customer!;
  if (patch.phone && patch.phone !== me.phone) {
    const [taken] = await db()
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.phone, patch.phone), isNotNull(customers.authUserId), ne(customers.id, me.id)))
      .limit(1);
    if (taken) throw invalid({ phone: "An account with this mobile number already exists." });
  }
  const [updated] = await db()
    .update(customers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(customers.id, me.id))
    .returning();
  res.json(toCustomerDto(updated!));
});

accountRouter.post("/me/password", requireCustomer, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: zPassword }), req.body);
  await auth().changePassword(req.identity!, currentPassword, newPassword);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Addresses                                                           */
/* ------------------------------------------------------------------ */

const MAX_ADDRESSES = 20;

async function listAddresses(customerId: string) {
  const rows = await db().select().from(customerAddresses).where(eq(customerAddresses.customerId, customerId)).orderBy(asc(customerAddresses.createdAt));
  return rows.map(toAddressDto);
}

async function saveAddress(customerId: string, input: z.output<typeof addressSchema>, id?: string) {
  await db().transaction(async (tx) => {
    const existing = await tx.select().from(customerAddresses).where(eq(customerAddresses.customerId, customerId)).for("update");
    const current = id ? existing.find((a) => a.id === id) : undefined;
    if (id && !current) throw notFound();
    if (!id && existing.length >= MAX_ADDRESSES) throw invalid({ _form: `You can save up to ${MAX_ADDRESSES} addresses.` });

    const makeDefaultShipping = Boolean(input.isDefaultShipping) || existing.length === 0 || (current?.isDefaultShipping ?? false);
    const makeDefaultBilling = Boolean(input.isDefaultBilling) || existing.length === 0 || (current?.isDefaultBilling ?? false);
    if (input.isDefaultShipping || existing.length === 0) {
      await tx.update(customerAddresses).set({ isDefaultShipping: false }).where(eq(customerAddresses.customerId, customerId));
    }
    if (input.isDefaultBilling || existing.length === 0) {
      await tx.update(customerAddresses).set({ isDefaultBilling: false }).where(eq(customerAddresses.customerId, customerId));
    }

    const values = {
      label: input.label ?? null,
      fullName: input.fullName,
      phone: input.phone,
      line1: input.line1,
      line2: input.line2 ?? null,
      landmark: input.landmark ?? null,
      city: input.city,
      state: input.state,
      postalCode: input.postalCode,
      country: input.country,
      isDefaultShipping: makeDefaultShipping,
      isDefaultBilling: makeDefaultBilling,
      updatedAt: new Date(),
    };
    if (current) await tx.update(customerAddresses).set(values).where(eq(customerAddresses.id, current.id));
    else await tx.insert(customerAddresses).values({ ...values, customerId });
  });
  return listAddresses(customerId);
}

accountRouter.get("/me/addresses", requireCustomer, async (req, res) => {
  res.json(await listAddresses(req.customer!.id));
});

accountRouter.post("/me/addresses", requireCustomer, async (req, res) => {
  res.status(201).json(await saveAddress(req.customer!.id, parse(addressSchema, req.body)));
});

accountRouter.put("/me/addresses/:id", requireCustomer, async (req, res) => {
  res.json(await saveAddress(req.customer!.id, parse(addressSchema, req.body), String(req.params.id)));
});

accountRouter.delete("/me/addresses/:id", requireCustomer, async (req, res) => {
  const customerId = req.customer!.id;
  await db().transaction(async (tx) => {
    const rows = await tx.select().from(customerAddresses).where(eq(customerAddresses.customerId, customerId)).for("update");
    const target = rows.find((a) => a.id === req.params.id);
    if (!target) return;
    await tx.delete(customerAddresses).where(eq(customerAddresses.id, target.id));
    const remaining = rows.filter((a) => a.id !== target.id);
    if (remaining.length && !remaining.some((a) => a.isDefaultShipping)) {
      await tx.update(customerAddresses).set({ isDefaultShipping: true }).where(eq(customerAddresses.id, remaining[0]!.id));
    }
    if (remaining.length && !remaining.some((a) => a.isDefaultBilling)) {
      await tx.update(customerAddresses).set({ isDefaultBilling: true }).where(eq(customerAddresses.id, remaining[0]!.id));
    }
  });
  res.json(await listAddresses(customerId));
});

/* ------------------------------------------------------------------ */
/* Enquiries                                                           */
/* ------------------------------------------------------------------ */

accountRouter.get("/me/enquiries", requireCustomer, async (req, res) => {
  const me = req.customer!;
  const rows = await db()
    .select()
    .from(enquiries)
    .where(me.email ? or(eq(enquiries.customerId, me.id), eq(sql`lower(${enquiries.email})`, me.email.toLowerCase())) : eq(enquiries.customerId, me.id))
    .orderBy(desc(enquiries.createdAt))
    .limit(100);
  res.json(rows.map(toEnquiryDto));
});

/* ------------------------------------------------------------------ */
/* Wishlist                                                            */
/* ------------------------------------------------------------------ */

async function wishlistFor(customerId: string) {
  const [rows, snapshot] = await Promise.all([
    db().select().from(wishlistItems).where(eq(wishlistItems.customerId, customerId)).orderBy(desc(wishlistItems.addedAt)),
    catalog(),
  ]);
  return rows.flatMap((row) => {
    const entry = snapshot.byId.get(row.productId);
    return entry ? [{ productId: entry.row.id, slug: entry.row.slug, addedAt: row.addedAt.toISOString(), product: entry.summary }] : [];
  });
}

accountRouter.get("/wishlist", requireCustomer, async (req, res) => {
  res.json(await wishlistFor(req.customer!.id));
});

accountRouter.post("/wishlist", requireCustomer, async (req, res) => {
  const { productId } = parse(z.object({ productId: z.string().trim().min(1).max(160) }), req.body);
  const entry = findEntry(await catalog(), productId);
  if (!entry) throw notFound();
  await db().insert(wishlistItems).values({ customerId: req.customer!.id, productId: entry.row.id }).onConflictDoNothing();
  res.json(await wishlistFor(req.customer!.id));
});

accountRouter.delete("/wishlist/:productId", requireCustomer, async (req, res) => {
  const entry = findEntry(await catalog(), String(req.params.productId));
  if (entry) {
    await db()
      .delete(wishlistItems)
      .where(and(eq(wishlistItems.customerId, req.customer!.id), eq(wishlistItems.productId, entry.row.id)));
  }
  res.json(await wishlistFor(req.customer!.id));
});

accountRouter.post("/wishlist/merge", requireCustomer, async (req, res) => {
  const { items } = parse(
    z.object({
      items: z
        .array(z.object({ productId: z.string().max(160), slug: z.string().max(160).default(""), addedAt: z.string().max(40).optional() }))
        .max(200),
    }),
    req.body,
  );
  const snapshot = await catalog();
  const values = items.flatMap((item) => {
    const entry = findEntry(snapshot, item.productId) ?? findEntry(snapshot, item.slug);
    const addedAt = item.addedAt && !Number.isNaN(Date.parse(item.addedAt)) ? new Date(item.addedAt) : new Date();
    return entry ? [{ customerId: req.customer!.id, productId: entry.row.id, addedAt }] : [];
  });
  if (values.length) await db().insert(wishlistItems).values(values).onConflictDoNothing();
  res.json(await wishlistFor(req.customer!.id));
});
