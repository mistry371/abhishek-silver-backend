import { z } from "zod";
import { zImage } from "@/lib/validation";

/**
 * Structured CMS documents stored in `content_blocks`. Schemas validate admin
 * edits; the storefront reads the same shapes (see storefront `src/types/content.ts`).
 */

const cta = z.object({ label: z.string().trim().min(1).max(60), href: z.string().trim().min(1).max(300) });
const orderable = { displayOrder: z.number().int().min(0).max(1000).default(0), active: z.boolean().default(true) };

const contentBlock = z.object({
  id: z.string().trim().min(1).max(60),
  key: z.string().trim().min(1).max(60),
  eyebrow: z.string().trim().max(80).optional(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(600).optional(),
  image: zImage.optional(),
  mobileImage: zImage.optional(),
  cta: cta.optional(),
  ...orderable,
});

export const homepageSchema = z.object({
  hero: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(60),
        eyebrow: z.string().trim().max(80).optional(),
        title: z.string().trim().min(1).max(120),
        subtitle: z.string().trim().max(160).optional(),
        description: z.string().trim().max(300).optional(),
        image: zImage,
        mobileImage: zImage.optional(),
        primaryCta: cta,
        secondaryCta: cta.optional(),
        tone: z.enum(["light", "dark"]).default("light"),
        align: z.enum(["left", "center"]).default("left"),
        ...orderable,
      }),
    )
    .min(1)
    .max(8),
  goldEditorial: contentBlock,
  silverEditorial: contentBlock,
  campaign: contentBlock,
  festival: contentBlock.nullable(),
  customJewellery: contentBlock,
  brandStory: z.object({
    eyebrow: z.string().trim().max(80),
    title: z.string().trim().min(1).max(160),
    paragraphs: z.array(z.string().trim().min(1).max(1200)).min(1).max(6),
    image: zImage,
    secondaryImage: zImage.optional(),
    pillars: z.array(z.object({ title: z.string().trim().min(1).max(80), description: z.string().trim().max(300) })).max(6),
    cta: cta.optional(),
  }),
  seoContent: z.object({ title: z.string().trim().max(160), paragraphs: z.array(z.string().trim().max(1500)).max(6) }),
});

export const aboutSchema = z.object({}).catchall(z.unknown());

export const contactSchema = z.object({
  storeId: z.string().trim().min(1).max(60),
  storeName: z.string().trim().min(1).max(120),
  addressLines: z.array(z.string().trim().min(1).max(160)).min(1).max(4),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().min(1).max(80),
  postalCode: z.string().trim().min(1).max(12),
  country: z.string().trim().min(1).max(60),
  mapQuery: z.string().trim().min(1).max(300),
  phones: z.array(z.object({ display: z.string().trim().min(1).max(30), href: z.string().trim().regex(/^tel:\+?\d{6,15}$/) })).max(4),
  whatsappNumber: z.string().trim().regex(/^\d{10,15}$/, { error: "Digits only, including country code." }),
  email: z.union([z.literal(""), z.email()]).default(""),
  hours: z.array(z.object({ label: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(120) })).max(10),
  image: zImage,
});

export const socialSchema = z.object({
  instagramHandle: z.string().trim().max(60).default(""),
  links: z
    .array(
      z.object({
        id: z.enum(["instagram", "facebook", "youtube", "pinterest"]),
        label: z.string().trim().min(1).max(40),
        href: z.url(),
      }),
    )
    .max(8),
});

export const trustSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(60),
        icon: z.enum(["shield", "gem", "sparkle", "message", "truck", "award", "scale", "pen"]),
        title: z.string().trim().min(1).max(80),
        description: z.string().trim().max(240),
        ...orderable,
      }),
    )
    .max(12),
});

export const instagramSchema = z.object({
  posts: z.array(z.object({ id: z.string().trim().min(1).max(60), image: zImage, url: z.url(), caption: z.string().trim().max(300).optional() })).max(24),
});

export const policySchema = z.object({
  slug: z.enum(["shipping", "returns", "privacy", "terms"]),
  title: z.string().trim().min(1).max(120),
  intro: z.string().trim().max(1500),
  sections: z.array(z.object({ heading: z.string().trim().min(1).max(160), body: z.array(z.string().trim().max(4000)).max(20) })).max(30),
  updatedAt: z.string().optional(),
  isPlaceholder: z.boolean().default(false),
});

export const POLICY_SLUGS = ["shipping", "returns", "privacy", "terms"] as const;

export const contentSchemas = {
  homepage: homepageSchema,
  about: aboutSchema,
  contact: contactSchema,
  social: socialSchema,
  trust: trustSchema,
  instagram: instagramSchema,
} as const;

export type ContentKey = keyof typeof contentSchemas;
export type ContactContent = z.output<typeof contactSchema>;
