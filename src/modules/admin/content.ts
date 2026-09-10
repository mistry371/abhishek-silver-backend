import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "@/db/client";
import { blogPosts, contentBlocks, faqs, testimonials } from "@/db/schema";
import { requirePermission } from "@/http/auth";
import { invalid, notFound } from "@/lib/errors";
import { paginated, parse, partialUpdate, zImage, zSeo, zText } from "@/lib/validation";
import { contentSchemas, policySchema, POLICY_SLUGS, type ContentKey } from "@/modules/content/types";
import { actorOf, recordAudit } from "@/services/audit";
import { revalidateStorefront } from "@/services/revalidate";
import { idParam, listQuery, searchAny, withUniqueFields } from "./helpers";

export const contentAdminRouter = Router();

const CONTENT_KEYS = Object.keys(contentSchemas) as ContentKey[];

/** Cache tags the storefront uses for each document. */
const contentTags: Record<ContentKey, string[]> = {
  homepage: ["content:homepage"],
  about: ["content:about"],
  contact: ["content:store", "content:contact"],
  social: ["content:social"],
  trust: ["content:trust"],
  instagram: ["content:instagram"],
};

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: "Use lowercase letters, numbers and hyphens." });

/* ------------------------------------------------------------------ */
/* Structured documents: homepage, about, contact, social, trust, instagram */
/* ------------------------------------------------------------------ */

contentAdminRouter.get("/content", requirePermission("content:view"), async (_req, res) => {
  const rows = await db()
    .select({ key: contentBlocks.key, updatedByName: contentBlocks.updatedByName, updatedAt: contentBlocks.updatedAt })
    .from(contentBlocks)
    .orderBy(asc(contentBlocks.key));
  res.json(rows);
});

contentAdminRouter.get("/content/policies", requirePermission("content:view"), async (_req, res) => {
  const rows = await db()
    .select()
    .from(contentBlocks)
    .where(inArray(contentBlocks.key, POLICY_SLUGS.map((slug) => `policy:${slug}`)));
  res.json(
    POLICY_SLUGS.map((slug) => {
      const row = rows.find((r) => r.key === `policy:${slug}`);
      return { slug, title: (row?.value.title as string) ?? slug, isPlaceholder: Boolean(row?.value.isPlaceholder ?? true), updatedByName: row?.updatedByName ?? null, updatedAt: row?.updatedAt ?? null };
    }),
  );
});

contentAdminRouter.get("/content/policies/:slug", requirePermission("content:view"), async (req, res) => {
  const slug = String(req.params.slug);
  if (!(POLICY_SLUGS as readonly string[]).includes(slug)) throw notFound();
  const [row] = await db().select().from(contentBlocks).where(eq(contentBlocks.key, `policy:${slug}`)).limit(1);
  // A policy that was never written can still be opened and created from the admin.
  res.json(row ?? { key: `policy:${slug}`, value: null, updatedByName: null, updatedAt: null });
});

contentAdminRouter.put("/content/policies/:slug", requirePermission("content:manage"), async (req, res) => {
  const slug = String(req.params.slug);
  if (!(POLICY_SLUGS as readonly string[]).includes(slug)) throw notFound();
  const value = parse(policySchema, { ...req.body, slug, updatedAt: new Date().toISOString() });
  const actor = actorOf(req);
  const key = `policy:${slug}`;
  await db()
    .insert(contentBlocks)
    .values({ key, value, updatedByName: actor.name })
    .onConflictDoUpdate({ target: contentBlocks.key, set: { value, updatedByName: actor.name, updatedAt: new Date() } });
  await recordAudit(db(), actor, { module: "content", action: "content.policy_update", entityType: "content_block", entityId: key, entityLabel: value.title });
  revalidateStorefront([`content:policy:${slug}`, "content"]);
  res.json({ key, value });
});

contentAdminRouter.get("/content/:key", requirePermission("content:view"), async (req, res) => {
  const key = String(req.params.key) as ContentKey;
  if (!CONTENT_KEYS.includes(key)) throw notFound();
  const [row] = await db().select().from(contentBlocks).where(eq(contentBlocks.key, key)).limit(1);
  res.json(row ?? { key, value: null, updatedByName: null, updatedAt: null });
});

contentAdminRouter.put("/content/:key", requirePermission("content:manage"), async (req, res) => {
  const key = String(req.params.key) as ContentKey;
  if (!CONTENT_KEYS.includes(key)) throw notFound();
  const value = parse(contentSchemas[key], req.body) as Record<string, unknown>;
  const actor = actorOf(req);
  const [before] = await db().select().from(contentBlocks).where(eq(contentBlocks.key, key)).limit(1);
  await db()
    .insert(contentBlocks)
    .values({ key, value, updatedByName: actor.name })
    .onConflictDoUpdate({ target: contentBlocks.key, set: { value, updatedByName: actor.name, updatedAt: new Date() } });
  const changedSections = Object.keys(value).filter((section) => JSON.stringify(before?.value?.[section]) !== JSON.stringify(value[section]));
  await recordAudit(db(), actor, {
    module: "content",
    action: "content.update",
    entityType: "content_block",
    entityId: key,
    entityLabel: key,
    after: { changedSections },
    // Contact details and social links are business facts shown to customers.
    sensitive: key === "contact" || key === "social",
  });
  revalidateStorefront([...contentTags[key], "content"]);
  res.json({ key, value });
});

/* ------------------------------------------------------------------ */
/* Testimonials                                                        */
/* ------------------------------------------------------------------ */

const testimonialSchema = z.object({
  name: zText(80),
  location: z.string().trim().max(80).nullable().optional(),
  quote: zText(800),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  image: zImage.nullable().optional(),
  productName: z.string().trim().max(120).nullable().optional(),
  /** Placeholder copy stays visibly marked as a sample on the website. */
  isSample: z.boolean().default(false),
  displayOrder: z.number().int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
});

contentAdminRouter.get("/testimonials", requirePermission("content:view"), async (_req, res) => {
  res.json(await db().select().from(testimonials).orderBy(asc(testimonials.displayOrder)));
});

contentAdminRouter.post("/testimonials", requirePermission("content:manage"), async (req, res) => {
  const input = parse(testimonialSchema, req.body);
  const [row] = await db().insert(testimonials).values(input).returning();
  await recordAudit(db(), actorOf(req), { module: "content", action: "testimonial.create", entityType: "testimonial", entityId: row!.id, entityLabel: row!.name });
  revalidateStorefront(["content:testimonials"]);
  res.status(201).json(row);
});

contentAdminRouter.patch("/testimonials/:id", requirePermission("content:manage"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(partialUpdate(testimonialSchema), req.body);
  const [row] = await db()
    .update(testimonials)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(testimonials.id, id))
    .returning();
  if (!row) throw notFound();
  await recordAudit(db(), actorOf(req), { module: "content", action: "testimonial.update", entityType: "testimonial", entityId: id, entityLabel: row.name, after: patch });
  revalidateStorefront(["content:testimonials"]);
  res.json(row);
});

contentAdminRouter.delete("/testimonials/:id", requirePermission("content:manage"), async (req, res) => {
  const id = idParam(req);
  const [row] = await db().delete(testimonials).where(eq(testimonials.id, id)).returning();
  if (!row) throw notFound();
  await recordAudit(db(), actorOf(req), { module: "content", action: "testimonial.delete", entityType: "testimonial", entityId: id, entityLabel: row.name });
  revalidateStorefront(["content:testimonials"]);
  res.status(204).end();
});

/* ------------------------------------------------------------------ */
/* FAQs                                                                */
/* ------------------------------------------------------------------ */

const faqSchema = z.object({
  slug: slugSchema,
  category: zText(60),
  question: zText(300),
  answer: zText(3000),
  displayOrder: z.number().int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
});
const faqUnique = { faqs_slug: ["slug", "Another FAQ already uses this anchor."] as [string, string] };

contentAdminRouter.get("/faqs", requirePermission("content:view"), async (_req, res) => {
  res.json(await db().select().from(faqs).orderBy(asc(faqs.displayOrder)));
});

contentAdminRouter.post("/faqs", requirePermission("content:manage"), async (req, res) => {
  const input = parse(faqSchema, req.body);
  const row = await withUniqueFields(async () => (await db().insert(faqs).values(input).returning())[0]!, faqUnique);
  await recordAudit(db(), actorOf(req), { module: "content", action: "faq.create", entityType: "faq", entityId: row.id, entityLabel: row.question });
  revalidateStorefront(["content:faqs"]);
  res.status(201).json(row);
});

contentAdminRouter.post("/faqs/reorder", requirePermission("content:manage"), async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.uuid()).min(1).max(500) }), req.body);
  await db().transaction(async (tx) => {
    for (const [index, id] of ids.entries()) await tx.update(faqs).set({ displayOrder: index + 1, updatedAt: new Date() }).where(eq(faqs.id, id));
  });
  revalidateStorefront(["content:faqs"]);
  res.json(await db().select().from(faqs).orderBy(asc(faqs.displayOrder)));
});

contentAdminRouter.patch("/faqs/:id", requirePermission("content:manage"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(partialUpdate(faqSchema), req.body);
  const row = await withUniqueFields(
    async () =>
      (
        await db()
          .update(faqs)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(faqs.id, id))
          .returning()
      )[0],
    faqUnique,
  );
  if (!row) throw notFound();
  await recordAudit(db(), actorOf(req), { module: "content", action: "faq.update", entityType: "faq", entityId: id, entityLabel: row.question });
  revalidateStorefront(["content:faqs"]);
  res.json(row);
});

contentAdminRouter.delete("/faqs/:id", requirePermission("content:manage"), async (req, res) => {
  const id = idParam(req);
  const [row] = await db().delete(faqs).where(eq(faqs.id, id)).returning();
  if (!row) throw notFound();
  await recordAudit(db(), actorOf(req), { module: "content", action: "faq.delete", entityType: "faq", entityId: id, entityLabel: row.question });
  revalidateStorefront(["content:faqs"]);
  res.status(204).end();
});

/* ------------------------------------------------------------------ */
/* Blog                                                                */
/* ------------------------------------------------------------------ */

const blockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), text: zText(5000) }),
  z.object({ type: z.literal("heading"), text: zText(200), level: z.union([z.literal(2), z.literal(3)]) }),
  z.object({ type: z.literal("image"), image: zImage, caption: z.string().trim().max(300).optional() }),
  z.object({ type: z.literal("quote"), text: zText(1000), cite: z.string().trim().max(120).optional() }),
  z.object({ type: z.literal("list"), items: z.array(zText(500)).min(1).max(30) }),
]);

const blogSchema = z.object({
  slug: slugSchema,
  title: zText(200),
  excerpt: zText(400),
  category: zText(60),
  coverImage: zImage,
  author: z.object({ name: zText(80), role: z.string().trim().max(80).optional() }),
  content: z.array(blockSchema).max(200).default([]),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  readingMinutes: z.number().int().min(1).max(120).optional(),
  status: z.enum(["draft", "published"]).default("draft"),
  publishedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  seo: zSeo,
});
const blogUnique = { blog_posts_slug: ["slug", "Another post already uses this URL slug."] as [string, string] };

function readingMinutes(content: z.output<typeof blockSchema>[]) {
  const words = content
    .map((block) => ("text" in block ? block.text : "items" in block ? block.items.join(" ") : ""))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

contentAdminRouter.get("/blog-posts", requirePermission("content:view"), async (req, res) => {
  const query = parse(listQuery.extend({ status: z.enum(["draft", "published"]).optional() }), req.query);
  const combined = and(searchAny(query.q, [blogPosts.title, blogPosts.slug, blogPosts.category]), query.status ? eq(blogPosts.status, query.status) : undefined);
  const rows = await db()
    .select({ id: blogPosts.id, slug: blogPosts.slug, title: blogPosts.title, category: blogPosts.category, status: blogPosts.status, publishedAt: blogPosts.publishedAt, updatedAt: blogPosts.updatedAt })
    .from(blogPosts)
    .where(combined)
    .orderBy(desc(blogPosts.updatedAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [total] = await db().select({ value: count() }).from(blogPosts).where(combined);
  res.json(paginated(rows, total?.value ?? 0, query.page, query.pageSize));
});

contentAdminRouter.get("/blog-posts/:id", requirePermission("content:view"), async (req, res) => {
  const [row] = await db().select().from(blogPosts).where(eq(blogPosts.id, idParam(req))).limit(1);
  if (!row) throw notFound();
  res.json(row);
});

contentAdminRouter.post("/blog-posts", requirePermission("content:manage"), async (req, res) => {
  const input = parse(blogSchema, req.body);
  const publishedAt = input.status === "published" ? (input.publishedAt ? new Date(input.publishedAt) : new Date()) : input.publishedAt ? new Date(input.publishedAt) : null;
  const row = await withUniqueFields(
    async () => (await db().insert(blogPosts).values({ ...input, readingMinutes: input.readingMinutes ?? readingMinutes(input.content), publishedAt }).returning())[0]!,
    blogUnique,
  );
  await recordAudit(db(), actorOf(req), { module: "content", action: "blog.create", entityType: "blog_post", entityId: row.id, entityLabel: row.title, after: { status: row.status } });
  revalidateStorefront(["blog", `blog:${row.slug}`]);
  res.status(201).json(row);
});

contentAdminRouter.patch("/blog-posts/:id", requirePermission("content:manage"), async (req, res) => {
  const id = idParam(req);
  const patch = parse(partialUpdate(blogSchema), req.body);
  const [current] = await db().select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
  if (!current) throw notFound();
  if (patch.status === "published" && !(patch.coverImage ?? current.coverImage)?.url) throw invalid({ coverImage: "Add a cover image before publishing." });
  const publishedAt =
    patch.publishedAt !== undefined
      ? patch.publishedAt
        ? new Date(patch.publishedAt)
        : null
      : patch.status === "published" && !current.publishedAt
        ? new Date()
        : current.publishedAt;
  const row = await withUniqueFields(
    async () =>
      (
        await db()
          .update(blogPosts)
          .set({
            ...patch,
            publishedAt,
            ...(patch.content && patch.readingMinutes === undefined ? { readingMinutes: readingMinutes(patch.content) } : {}),
            updatedAt: new Date(),
          })
          .where(eq(blogPosts.id, id))
          .returning()
      )[0]!,
    blogUnique,
  );
  await recordAudit(db(), actorOf(req), {
    module: "content",
    action: "blog.update",
    entityType: "blog_post",
    entityId: id,
    entityLabel: row.title,
    before: { status: current.status, slug: current.slug },
    after: { status: row.status, slug: row.slug },
  });
  revalidateStorefront(["blog", `blog:${row.slug}`, `blog:${current.slug}`]);
  res.json(row);
});

contentAdminRouter.delete("/blog-posts/:id", requirePermission("content:manage"), async (req, res) => {
  const id = idParam(req);
  const [row] = await db().delete(blogPosts).where(eq(blogPosts.id, id)).returning();
  if (!row) throw notFound();
  await recordAudit(db(), actorOf(req), { module: "content", action: "blog.delete", entityType: "blog_post", entityId: id, entityLabel: row.title });
  revalidateStorefront(["blog", `blog:${row.slug}`]);
  res.status(204).end();
});
