import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ImageAsset, SeoMeta } from "@/contracts/common";
import { createdAt, updatedAt } from "./common";

/**
 * Structured CMS documents keyed by name:
 *   homepage, about, contact, social, policy:shipping, policy:returns, policy:privacy, policy:terms
 */
export const contentBlocks = pgTable("content_blocks", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedByName: text("updated_by_name").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const testimonials = pgTable("testimonials", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  location: text("location"),
  quote: text("quote").notNull(),
  rating: integer("rating"),
  image: jsonb("image").$type<ImageAsset | null>(),
  productName: text("product_name"),
  isSample: boolean("is_sample").notNull().default(false),
  displayOrder: integer("display_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const faqs = pgTable("faqs", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Stable anchor id used by storefront deep links, e.g. "faq-size". */
  slug: text("slug").notNull().unique(),
  category: text("category").notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type BlogBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; text: string; level: 2 | 3 }
  | { type: "image"; image: ImageAsset; caption?: string }
  | { type: "quote"; text: string; cite?: string }
  | { type: "list"; items: string[] };

export const blogPosts = pgTable("blog_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  excerpt: text("excerpt").notNull(),
  category: text("category").notNull(),
  coverImage: jsonb("cover_image").$type<ImageAsset>().notNull(),
  author: jsonb("author").$type<{ name: string; role?: string }>().notNull(),
  content: jsonb("content").$type<BlogBlock[]>().notNull().default([]),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  readingMinutes: integer("reading_minutes").notNull().default(3),
  status: text("status").$type<"draft" | "published">().notNull().default("draft"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  seo: jsonb("seo").$type<SeoMeta>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
