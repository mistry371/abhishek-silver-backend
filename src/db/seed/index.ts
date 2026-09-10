import { count, eq } from "drizzle-orm";
import type {
  CategoryGroup,
  CategoryListingRule,
  CustomizationKey,
  Gender,
  ImageAsset,
  MakingChargeType,
  MetalType,
  ProductDiscount,
  PurityCode,
  SeoMeta,
  SizingType,
} from "@/contracts/common";
import { env } from "@/config/env";
import { auth } from "@/auth";
import { defaultRoles } from "@/auth/permissions";
import { db } from "@/db/client";
import {
  adminUsers,
  blogPosts,
  categories,
  collections,
  contentBlocks,
  coupons,
  customerAddresses,
  faqs,
  metalRates,
  offers,
  pricingHistory,
  pricingSettings,
  productCollections,
  products,
  rolePermissions,
  roles,
  settings,
  stockLocations,
  subcategories,
  testimonials,
  type BlogBlock,
} from "@/db/schema";
import { logger } from "@/lib/logger";
import { SYSTEM_ACTOR } from "@/services/audit";
import { createCustomerRecord } from "@/services/customers";
import { applyStockChange } from "@/services/inventory";
import { settingSchemas } from "@/services/settings";
import aboutJson from "./data/about.json" with { type: "json" };
import contentJson from "./data/content.json" with { type: "json" };
import productsJson from "./data/products.json" with { type: "json" };
import taxonomyJson from "./data/taxonomy.json" with { type: "json" };

/* ------------------------------------------------------------------ */
/* Seed file shapes                                                    */
/* ------------------------------------------------------------------ */

interface SeedProduct {
  slug: string;
  sku: string;
  name: string;
  type: string;
  sub: string | null;
  collections: string[];
  metal: MetalType;
  purity: PurityCode;
  gender: Gender;
  netWeight: number;
  grossWeight: number | null;
  stoneWeight: number | null;
  stoneDetails: string | null;
  making: { type: MakingChargeType; value: number };
  stoneCharges: number;
  otherCharges: number;
  discount: ProductDiscount | null;
  stock: "in_stock" | "low_stock" | "out_of_stock" | "unavailable";
  sizing: SizingType | null;
  sizeOptions: string[];
  defaultSize: string | null;
  sizeWeights: Record<string, number>;
  unavailableSizes: string[];
  customization: CustomizationKey[];
  images: ImageAsset[];
  shortDescription: string;
  description: string;
  flags: { featured: boolean; bestSeller: boolean; trending: boolean; newArrival: boolean; limited: boolean };
  createdAt: string;
}

interface SeedCategory {
  id: string;
  slug: string;
  name: string;
  shortName?: string;
  description: string;
  image: ImageAsset;
  group: CategoryGroup;
  subcategories: { slug: string; name: string }[];
  displayOrder: number;
  active: boolean;
  seo?: SeoMeta;
}

interface SeedCollection {
  slug: string;
  name: string;
  eyebrow?: string;
  description: string;
  image: ImageAsset;
  mobileImage?: ImageAsset;
  displayOrder: number;
  active: boolean;
}

interface SeedContent {
  homepage: Record<string, unknown>;
  testimonials: { name: string; quote: string; rating?: number; isSample?: boolean; displayOrder: number; active: boolean }[];
  instagram: { id: string; image: ImageAsset; url: string }[];
  trust: Record<string, unknown>[];
  faqs: { id: string; category: string; question: string; answer: string; displayOrder: number; active: boolean }[];
  blog: {
    slug: string;
    title: string;
    excerpt: string;
    category: string;
    coverImage: ImageAsset;
    author: { name: string; role?: string };
    tags: string[];
    readingMinutes: number;
    publishedAt: string;
    content: BlogBlock[];
  }[];
  policies: Record<string, Record<string, unknown>>;
  offers: { type: "festival"; eyebrow?: string; title: string; description: string; cta?: { label: string; href: string }; active: boolean; displayOrder: number }[];
  coupons: { code: string; type: "percentage" | "fixed"; value: number; description: string; minOrderValue?: number; maxDiscount?: number; appliesTo?: { categorySlugs?: string[] } }[];
  rates: { gold: Record<string, number>; silver: Record<string, number>; effectiveAt: string };
  gstRate: number;
  storeImage: ImageAsset;
}

const content = contentJson as unknown as SeedContent;

/* ------------------------------------------------------------------ */
/* Business facts supplied by the owner (mirrors storefront site.ts)   */
/* ------------------------------------------------------------------ */

const STORE_CONTACT = {
  storeId: "abhishek-silver-surat",
  storeName: "Abhishek Silver, Surat",
  addressLines: ["103/104 Silver Arcade", "Near Sadriwala Market, Bhagal Main Road"],
  city: "Surat",
  state: "Gujarat",
  postalCode: "395003",
  country: "India",
  mapQuery: "Abhishek Silver, 103/104 Silver Arcade, Bhagal Main Road, Surat, Gujarat 395003",
  // TO CONFIRM with the business (taken from the public Instagram profile).
  phones: [
    { display: "+91 99985 55281", href: "tel:+919998555281" },
    { display: "+91 98243 65444", href: "tel:+919824365444" },
  ],
  whatsappNumber: "919998555281",
  email: "",
  hours: [{ label: "Store hours", value: "11:00 AM – 9:00 PM" }],
};

const SOCIAL = {
  instagramHandle: "@abhisheksilver",
  links: [
    { id: "instagram", label: "Instagram", href: "https://www.instagram.com/abhisheksilver/" },
    { id: "facebook", label: "Facebook", href: "https://www.facebook.com/asbhisheksilver" },
  ],
};

/** Listing rules for landing pages that aren't a single jewellery type. */
const LISTING_RULES: Record<string, CategoryListingRule> = {
  "gold-jewellery": { metal: "gold" },
  "silver-jewellery": { metal: "silver" },
  men: { genders: ["men", "unisex"] },
  women: { genders: ["women", "unisex"] },
  kids: { genders: ["kids"] },
  "custom-jewellery": { customizable: true },
};

/** Demo opening stock (units) — replace with real counts through Inventory. */
const DEMO_STOCK: Record<SeedProduct["stock"], number> = { in_stock: 6, low_stock: 1, out_of_stock: 0, unavailable: 0 };

const SEED_ACTOR = "Seed";

/* ------------------------------------------------------------------ */
/* Essentials                                                          */
/* ------------------------------------------------------------------ */

async function seedEssentials() {
  const database = db();

  for (const role of defaultRoles) {
    await database.insert(roles).values({ id: role.id, name: role.name, description: role.description, isSystem: true }).onConflictDoNothing();
    const [{ value }] = await database.select({ value: count() }).from(rolePermissions).where(eq(rolePermissions.roleId, role.id));
    if (value === 0 && role.permissions.length) {
      await database.insert(rolePermissions).values(role.permissions.map((permission) => ({ roleId: role.id, permission })));
    }
  }

  await database.insert(stockLocations).values({ id: "store", name: "Main store", displayOrder: 1 }).onConflictDoNothing();

  for (const [key, schema] of Object.entries(settingSchemas)) {
    await database
      .insert(settings)
      .values({ key, value: schema.parse({}) as Record<string, unknown>, updatedByName: SEED_ACTOR })
      .onConflictDoNothing();
  }

  // GST on gold & silver jewellery in India is 3%. Confirm with the business's accountant.
  await database.insert(pricingSettings).values({ id: 1, gstRate: content.gstRate, updatedBy: SEED_ACTOR }).onConflictDoNothing();

  const blocks: [string, Record<string, unknown>][] = [
    ["homepage", content.homepage],
    ["about", aboutJson as Record<string, unknown>],
    ["contact", { ...STORE_CONTACT, image: content.storeImage }],
    ["social", SOCIAL],
    ["trust", { items: content.trust }],
    ["instagram", { posts: content.instagram.map((post) => ({ ...post, url: SOCIAL.links[0]!.href })) }],
    ...Object.entries(content.policies).map(([slug, policy]): [string, Record<string, unknown>] => [`policy:${slug}`, policy]),
  ];
  for (const [key, value] of blocks) {
    await database.insert(contentBlocks).values({ key, value, updatedByName: SEED_ACTOR }).onConflictDoNothing();
  }

  const [{ value: faqCount }] = await database.select({ value: count() }).from(faqs);
  if (faqCount === 0) {
    await database.insert(faqs).values(
      content.faqs.map((faq) => ({ slug: faq.id, category: faq.category, question: faq.question, answer: faq.answer, displayOrder: faq.displayOrder, active: faq.active })),
    );
  }
}

/** Development-only staff accounts (local auth provider). With Supabase, use `npm run admin:create`. */
async function seedLocalAdmins() {
  if (env.AUTH_PROVIDER !== "local") return;
  const password = env.SEED_ADMIN_PASSWORD ?? "Admin@12345";
  const staff = [
    { name: "Super Admin", email: "superadmin@example.com", roleId: "super_admin" },
    { name: "Inventory Manager", email: "inventory@example.com", roleId: "inventory_manager" },
    { name: "Sales Manager", email: "sales@example.com", roleId: "sales_manager" },
    { name: "Content Manager", email: "content@example.com", roleId: "content_manager" },
  ];
  for (const member of staff) {
    const [existing] = await db().select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, member.email)).limit(1);
    if (existing) continue;
    const identity = await auth().createUser({ email: member.email, password });
    await db().insert(adminUsers).values({ authUserId: identity.userId, name: member.name, email: member.email, roleId: member.roleId });
  }
  logger.info({ accounts: staff.map((s) => s.email) }, "Local development admin accounts ready (password from SEED_ADMIN_PASSWORD)");
}

/* ------------------------------------------------------------------ */
/* Demo catalogue & content                                            */
/* ------------------------------------------------------------------ */

async function seedDemo() {
  const database = db();
  const [{ value: productCount }] = await database.select({ value: count() }).from(products);
  if (productCount > 0) {
    logger.info("Products already exist — demo catalogue not re-seeded");
    return;
  }

  // Illustrative demo rates, NOT market rates. Update in Admin → Pricing before launch.
  const rateRows = [
    ...Object.entries(content.rates.gold).map(([purity, rate]) => ({ metal: "gold" as const, purity: purity as PurityCode, ratePerGram: rate })),
    ...Object.entries(content.rates.silver).map(([purity, rate]) => ({ metal: "silver" as const, purity: purity as PurityCode, ratePerGram: rate })),
  ];
  await database
    .insert(metalRates)
    .values(rateRows.map((row) => ({ ...row, updatedBy: "Seed (demo rates)" })))
    .onConflictDoNothing();
  await database.insert(pricingHistory).values({
    kind: "metal_rate",
    label: "Demo metal rates loaded",
    after: { rates: rateRows },
    reason: "Development seed — illustrative values, not market rates",
    actorName: SEED_ACTOR,
  });

  const categoryIdBySlug = new Map<string, string>();
  const subIdByKey = new Map<string, string>();
  for (const category of taxonomyJson.categories as SeedCategory[]) {
    const [row] = await database
      .insert(categories)
      .values({
        slug: category.slug,
        name: category.name,
        shortName: category.shortName ?? null,
        description: category.description,
        image: category.image,
        group: category.group,
        listingRule: LISTING_RULES[category.slug] ?? null,
        seo: category.seo ?? {},
        displayOrder: category.displayOrder,
        active: category.active,
      })
      .returning({ id: categories.id });
    categoryIdBySlug.set(category.slug, row!.id);
    for (const [index, sub] of category.subcategories.entries()) {
      const [subRow] = await database
        .insert(subcategories)
        .values({ categoryId: row!.id, slug: sub.slug, name: sub.name, displayOrder: index + 1 })
        .returning({ id: subcategories.id });
      subIdByKey.set(`${category.slug}/${sub.slug}`, subRow!.id);
    }
  }

  const collectionIdBySlug = new Map<string, string>();
  for (const collection of taxonomyJson.collections as SeedCollection[]) {
    const [row] = await database
      .insert(collections)
      .values({
        slug: collection.slug,
        name: collection.name,
        eyebrow: collection.eyebrow ?? null,
        description: collection.description,
        image: collection.image,
        mobileImage: collection.mobileImage ?? null,
        displayOrder: collection.displayOrder,
        active: collection.active,
      })
      .returning({ id: collections.id });
    collectionIdBySlug.set(collection.slug, row!.id);
  }

  for (const product of productsJson as unknown as SeedProduct[]) {
    const categoryId = categoryIdBySlug.get(product.type);
    if (!categoryId) throw new Error(`Seed product ${product.sku} references unknown category ${product.type}`);
    const createdAt = new Date(product.createdAt);

    await database.transaction(async (tx) => {
      const [row] = await tx
        .insert(products)
        .values({
          slug: product.slug,
          sku: product.sku,
          name: product.name,
          shortDescription: product.shortDescription,
          description: product.description,
          categoryId,
          subcategoryId: product.sub ? (subIdByKey.get(`${product.type}/${product.sub}`) ?? null) : null,
          metal: product.metal,
          purity: product.purity,
          gender: product.gender,
          netWeight: product.netWeight,
          grossWeight: product.grossWeight,
          stoneWeight: product.stoneWeight,
          stoneDetails: product.stoneDetails,
          makingType: product.making.type,
          makingValue: product.making.value,
          stoneCharges: product.stoneCharges,
          otherCharges: product.otherCharges,
          discount: product.discount,
          sizing: product.sizing,
          sizeOptions: product.sizeOptions,
          defaultSize: product.defaultSize,
          sizeWeights: product.sizeWeights,
          unavailableSizes: product.unavailableSizes,
          customization: product.customization,
          images: product.images,
          flags: product.flags,
          status: product.stock === "unavailable" ? "disabled" : "active",
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: products.id });

      const collectionIds = product.collections.map((slug) => collectionIdBySlug.get(slug)).filter((id): id is string => Boolean(id));
      if (collectionIds.length) {
        await tx.insert(productCollections).values(collectionIds.map((collectionId) => ({ productId: row!.id, collectionId })));
      }

      const opening = DEMO_STOCK[product.stock];
      if (opening > 0) {
        await applyStockChange(tx, { ...SYSTEM_ACTOR, name: SEED_ACTOR }, {
          productId: row!.id,
          type: "opening",
          locationId: "store",
          quantity: opening,
          reason: "Demo opening stock",
          reference: { type: "seed", label: "Development seed" },
        });
      }
    });
  }

  await database.insert(testimonials).values(
    content.testimonials.map((t) => ({ name: t.name, quote: t.quote, rating: t.rating ?? null, isSample: t.isSample ?? true, displayOrder: t.displayOrder, active: t.active })),
  );

  await database.insert(blogPosts).values(
    content.blog.map((post) => ({
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      category: post.category,
      coverImage: post.coverImage,
      author: post.author,
      content: post.content,
      tags: post.tags,
      readingMinutes: post.readingMinutes,
      status: "published" as const,
      publishedAt: new Date(post.publishedAt),
    })),
  );

  await database.insert(offers).values(
    content.offers.map((offer) => ({
      title: offer.title,
      eyebrow: offer.eyebrow ?? null,
      description: offer.description,
      type: offer.type,
      cta: offer.cta ?? null,
      active: offer.active,
      displayOrder: offer.displayOrder,
    })),
  );

  await database.insert(coupons).values(
    content.coupons.map((coupon) => ({
      code: coupon.code,
      description: coupon.description,
      type: coupon.type,
      value: coupon.value,
      minOrderValue: coupon.minOrderValue ?? null,
      maxDiscount: coupon.maxDiscount ?? null,
      // The storefront demo expressed "silver jewellery" as a category; the backend scopes it by metal.
      appliesTo: coupon.appliesTo?.categorySlugs?.includes("silver-jewellery") ? { metals: ["silver" as const] } : {},
    })),
  );

  if (env.AUTH_PROVIDER === "local") {
    const identity = await auth().createUser({ email: "demo@example.com", phone: "9000000000", password: "Demo@1234" });
    const customer = await createCustomerRecord(database, {
      authUserId: identity.userId,
      firstName: "Demo",
      lastName: "Customer",
      email: "demo@example.com",
      phone: "9000000000",
      source: "website",
    });
    await database.insert(customerAddresses).values({
      customerId: customer.id,
      label: "Home",
      fullName: "Demo Customer",
      phone: "9000000000",
      line1: "Demo address line 1",
      line2: "Demo area",
      city: "Surat",
      state: "Gujarat",
      postalCode: "395001",
      country: "India",
      isDefaultShipping: true,
      isDefaultBilling: true,
    });
  }

  logger.info({ products: productsJson.length }, "Demo catalogue, content, coupons and demo customer seeded");
}

export async function seedDatabase({ demo }: { demo: boolean }) {
  await seedEssentials();
  await seedLocalAdmins();
  if (demo) await seedDemo();
  logger.info({ demo }, "Seed complete");
}
