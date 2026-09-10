import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { CtaLink, ImageAsset, MetalType } from "@/contracts/common";
import { createdAt, decimal, money, updatedAt } from "./common";

export interface CouponScope {
  metals?: MetalType[];
  categorySlugs?: string[];
  productIds?: string[];
}

export const coupons = pgTable("coupons", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  description: text("description").notNull(),
  type: text("type").$type<"percentage" | "fixed">().notNull(),
  value: decimal("value").notNull(),
  minOrderValue: money("min_order_value"),
  maxDiscount: money("max_discount"),
  appliesTo: jsonb("applies_to").$type<CouponScope>().notNull().default({}),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  usageLimit: integer("usage_limit"),
  usedCount: integer("used_count").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type OfferType = "percentage" | "fixed" | "product" | "category" | "limited_time" | "festival";

export interface OfferTarget {
  scope: "all" | "categories" | "products" | "collections" | "metal";
  ids: string[];
}

export const offers = pgTable("offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  eyebrow: text("eyebrow"),
  description: text("description").notNull(),
  type: text("type").$type<OfferType>().notNull(),
  /** When set, the pricing engine applies this discount to targeted products. */
  discount: jsonb("discount").$type<{ type: "percentage" | "fixed"; value: number } | null>(),
  target: jsonb("target").$type<OfferTarget>().notNull().default({ scope: "all", ids: [] }),
  couponCode: text("coupon_code"),
  image: jsonb("image").$type<ImageAsset | null>(),
  mobileImage: jsonb("mobile_image").$type<ImageAsset | null>(),
  cta: jsonb("cta").$type<CtaLink | null>(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
