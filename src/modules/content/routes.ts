import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { Router } from "express";
import { db } from "@/db/client";
import { blogPosts, contentBlocks, faqs, offers, testimonials } from "@/db/schema";
import { notFound } from "@/lib/errors";
import { latestInstagramPosts } from "@/services/instagram";
import { POLICY_SLUGS, type ContactContent } from "./types";

export const contentRouter = Router();
contentRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  next();
});

async function block<T = Record<string, unknown>>(key: string): Promise<T> {
  const [row] = await db().select().from(contentBlocks).where(eq(contentBlocks.key, key)).limit(1);
  if (!row) throw notFound();
  return row.value as T;
}

export const mapEmbedUrl = (query: string) => `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
export const directionsUrl = (query: string) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`;

contentRouter.get("/content/homepage", async (_req, res) => {
  res.json(await block("homepage"));
});

contentRouter.get("/content/about", async (_req, res) => {
  res.json(await block("about"));
});

contentRouter.get("/content/testimonials", async (_req, res) => {
  const rows = await db().select().from(testimonials).where(eq(testimonials.active, true)).orderBy(asc(testimonials.displayOrder));
  res.json(
    rows.map((t) => ({
      id: t.id,
      name: t.name,
      ...(t.location ? { location: t.location } : {}),
      quote: t.quote,
      ...(t.rating ? { rating: t.rating } : {}),
      ...(t.image ? { image: t.image } : {}),
      isSample: t.isSample,
      displayOrder: t.displayOrder,
      active: t.active,
    })),
  );
});

contentRouter.get("/content/instagram", async (_req, res) => {
  // Live posts from Instagram when connected; otherwise the posts managed in the admin panel.
  const live = await latestInstagramPosts().catch(() => null);
  if (live?.length) {
    res.json(live);
    return;
  }
  const value = await block<{ posts?: unknown[] }>("instagram").catch(() => ({ posts: [] }));
  res.json(value.posts ?? []);
});

contentRouter.get("/content/trust", async (_req, res) => {
  const value = await block<{ items?: { active: boolean; displayOrder: number }[] }>("trust").catch(() => ({ items: [] }));
  res.json((value.items ?? []).filter((item) => item.active).sort((a, b) => a.displayOrder - b.displayOrder));
});

contentRouter.get("/content/social", async (_req, res) => {
  res.json(await block("social"));
});

contentRouter.get("/content/faqs", async (_req, res) => {
  const rows = await db().select().from(faqs).where(eq(faqs.active, true)).orderBy(asc(faqs.displayOrder));
  res.json(rows.map((f) => ({ id: f.slug, category: f.category, question: f.question, answer: f.answer, displayOrder: f.displayOrder, active: f.active })));
});

contentRouter.get("/content/policies/:slug", async (req, res) => {
  if (!(POLICY_SLUGS as readonly string[]).includes(req.params.slug)) throw notFound();
  res.json(await block(`policy:${req.params.slug}`));
});

contentRouter.get("/content/store", async (_req, res) => {
  const contact = await block<ContactContent>("contact");
  res.json({
    id: contact.storeId,
    name: contact.storeName,
    addressLines: contact.addressLines,
    city: contact.city,
    state: contact.state,
    postalCode: contact.postalCode,
    country: contact.country,
    phone: contact.phones[0]?.display ?? "",
    phones: contact.phones,
    whatsapp: contact.whatsappNumber,
    email: contact.email,
    hours: contact.hours,
    mapEmbedUrl: mapEmbedUrl(contact.mapQuery),
    directionsUrl: directionsUrl(contact.mapQuery),
    image: contact.image,
  });
});

function toBlogDto(post: typeof blogPosts.$inferSelect) {
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    category: post.category,
    coverImage: post.coverImage,
    author: post.author,
    content: post.content,
    tags: post.tags,
    readingMinutes: post.readingMinutes,
    publishedAt: (post.publishedAt ?? post.createdAt).toISOString(),
    updatedAt: post.updatedAt.toISOString(),
    seo: post.seo,
  };
}

const published = () => and(eq(blogPosts.status, "published"), lte(blogPosts.publishedAt, new Date()));

contentRouter.get("/blog", async (_req, res) => {
  const rows = await db().select().from(blogPosts).where(published()).orderBy(desc(blogPosts.publishedAt));
  res.json(rows.map(toBlogDto));
});

contentRouter.get("/blog/:slug", async (req, res) => {
  const [post] = await db()
    .select()
    .from(blogPosts)
    .where(and(eq(blogPosts.slug, req.params.slug), published()))
    .limit(1);
  if (!post) throw notFound();
  res.json(toBlogDto(post));
});

contentRouter.get("/offers", async (_req, res) => {
  const now = new Date();
  const rows = await db()
    .select()
    .from(offers)
    .where(and(eq(offers.active, true), or(isNull(offers.startsAt), lte(offers.startsAt, now)), or(isNull(offers.endsAt), gt(offers.endsAt, now))))
    .orderBy(asc(offers.displayOrder));
  res.json(
    rows.map((o) => ({
      id: o.id,
      type: o.type,
      ...(o.eyebrow ? { eyebrow: o.eyebrow } : {}),
      title: o.title,
      description: o.description,
      ...(o.couponCode ? { couponCode: o.couponCode } : {}),
      ...(o.image ? { image: o.image } : {}),
      ...(o.mobileImage ? { mobileImage: o.mobileImage } : {}),
      ...(o.cta ? { cta: o.cta } : {}),
      ...(o.startsAt ? { startsAt: o.startsAt.toISOString() } : {}),
      ...(o.endsAt ? { endsAt: o.endsAt.toISOString() } : {}),
      active: o.active,
      displayOrder: o.displayOrder,
    })),
  );
});
