import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "@/db/client";
import { enquiries, newsletterSubscribers, products, type EnquirySource } from "@/db/schema";
import { optionalCustomer } from "@/http/auth";
import { rateLimit } from "@/http/middleware";
import { isUuid } from "@/lib/ids";
import { parse, zEmail, zMobile, zText } from "@/lib/validation";
import { notify } from "@/services/notifications";
import { documentNumbers } from "@/services/sequences";
import { toEnquiryDto } from "./presenter";

export const leadsRouter = Router();
leadsRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || null);

const enquirySchema = z.object({
  type: z.enum(["product", "custom_jewellery", "contact"]),
  name: zText(120),
  mobile: zMobile,
  email: zEmail,
  message: zText(3000),
  subject: optional(200),
  product: z.object({ id: z.string().max(160), name: z.string().max(200), sku: z.string().max(80) }).optional(),
  jewelleryType: optional(80),
  budgetRange: optional(80),
  preferredMetal: optional(40),
  preferredPurity: optional(40),
  preferredContact: z.enum(["phone", "whatsapp", "email"]).optional(),
  /** File metadata only; files are shared with the team over WhatsApp/email until uploads are enabled. */
  attachments: z
    .array(z.object({ name: z.string().max(200), size: z.number().int().min(0).max(50_000_000), type: z.string().max(100) }))
    .max(5)
    .optional(),
});

const sourceByType: Record<z.output<typeof enquirySchema>["type"], EnquirySource> = {
  product: "product_page",
  custom_jewellery: "custom_jewellery",
  contact: "website_form",
};

const typeLabels = { product: "Product enquiry", custom_jewellery: "Custom jewellery enquiry", contact: "Contact enquiry" } as const;

leadsRouter.post("/enquiries", rateLimit({ name: "enquiries", windowMs: 10 * 60_000, max: 10 }), optionalCustomer(), async (req, res) => {
  const input = parse(enquirySchema, req.body);

  // Trust the catalogue, not the browser, for the product reference.
  let product: { id: string; name: string; sku: string } | null = null;
  if (input.product) {
    const [row] = await db()
      .select({ id: products.id, name: products.name, sku: products.sku })
      .from(products)
      .where(isUuid(input.product.id) ? or(eq(products.id, input.product.id), eq(products.sku, input.product.sku)) : eq(products.sku, input.product.sku))
      .limit(1);
    product = row ?? null;
  }

  const enquiry = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(enquiries)
      .values({
        reference: await documentNumbers.enquiry(tx),
        type: input.type,
        source: sourceByType[input.type],
        customerId: req.customer?.id ?? null,
        name: input.name,
        mobile: input.mobile,
        email: input.email,
        subject: input.subject,
        message: input.message,
        product,
        jewelleryType: input.jewelleryType,
        budgetRange: input.budgetRange,
        preferredMetal: input.preferredMetal,
        preferredPurity: input.preferredPurity,
        preferredContact: input.preferredContact ?? null,
        attachments: (input.attachments ?? []).map((file) => ({
          id: randomUUID(),
          name: file.name,
          size: file.size,
          type: file.type,
          path: "",
          uploadedAt: new Date().toISOString(),
        })),
      })
      .returning();
    await notify(tx, {
      type: "new_enquiry",
      title: typeLabels[input.type],
      body: `${row!.reference} from ${input.name}${product ? ` about ${product.name}` : ""}`,
      href: `/admin/enquiries/${row!.id}`,
      permission: "enquiries:view",
    });
    return row!;
  });

  res.status(201).json(toEnquiryDto(enquiry));
});

leadsRouter.post("/newsletter", rateLimit({ name: "newsletter", windowMs: 10 * 60_000, max: 10 }), async (req, res) => {
  const { email } = parse(z.object({ email: zEmail }), req.body);
  const [existing] = await db().select().from(newsletterSubscribers).where(eq(newsletterSubscribers.email, email)).limit(1);
  const alreadySubscribed = Boolean(existing && !existing.unsubscribedAt);
  if (!existing) {
    await db().insert(newsletterSubscribers).values({ email, source: "website" });
  } else if (existing.unsubscribedAt) {
    await db().update(newsletterSubscribers).set({ unsubscribedAt: null, subscribedAt: new Date(), updatedAt: new Date() }).where(eq(newsletterSubscribers.email, email));
  }
  res.json({ ok: true, alreadySubscribed });
});
