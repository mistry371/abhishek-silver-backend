import { and, eq, isNull, ne } from "drizzle-orm";
import type { MetalType, PurityCode } from "@/contracts/common";
import type { Executor } from "@/db/client";
import { parentProducts, products } from "@/db/schema";
import { invalid } from "@/lib/errors";
import { labelKey, variantLabelOf } from "@/modules/catalog/labels";

/**
 * PARENT PRODUCT RULES SHARED WITH THE PRODUCT SCREENS
 * ------------------------------------------------------------------
 * Kept apart from both routers so products and parent products can check
 * each other without importing each other.
 */

/**
 * `/product/<slug>` must never be ambiguous, so parents and products share one
 * slug space. Returns the plain-English problem, or null when the slug is free.
 */
export async function slugConflict(ex: Executor, slug: string, except: { productId?: string; parentId?: string } = {}): Promise<string | null> {
  const [parent] = await ex
    .select({ name: parentProducts.name })
    .from(parentProducts)
    .where(and(eq(parentProducts.slug, slug), except.parentId ? ne(parentProducts.id, except.parentId) : undefined))
    .limit(1);
  if (parent) return `This URL slug is already used by the parent product “${parent.name}”.`;
  const [product] = await ex
    .select({ name: products.name, sku: products.sku })
    .from(products)
    .where(and(eq(products.slug, slug), except.productId ? ne(products.id, except.productId) : undefined))
    .limit(1);
  if (product) return `This URL slug is already used by the product “${product.name}” (${product.sku}).`;
  return null;
}

export function slugify(text: string) {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 150);
}

/** `base`, or `base-2`, `base-3`… — the first slug no parent or product uses yet (nor any in `reserved`). */
export async function uniqueSlug(ex: Executor, base: string, reserved: Set<string> = new Set()) {
  const start = base || "design";
  for (let suffix = 1; suffix < 200; suffix += 1) {
    const candidate = suffix === 1 ? start : `${start}-${suffix}`.slice(0, 160);
    if (!reserved.has(candidate) && !(await slugConflict(ex, candidate))) return candidate;
  }
  return `${start}-${Date.now().toString(36)}`;
}

export async function assertSlugFree(ex: Executor, slug: string, except: { productId?: string; parentId?: string } = {}) {
  const problem = await slugConflict(ex, slug, except);
  if (problem) throw invalid({ slug: problem });
}

/**
 * When a variant's metal or purity changes, its default label ("22K Gold")
 * changes too and must not clash with a sibling's label.
 */
export async function assertSiblingLabelFree(
  ex: Executor,
  product: { id: string; parentId: string | null; metal: MetalType; purity: PurityCode; variantCustomLabel: string | null },
) {
  if (!product.parentId) return;
  const label = variantLabelOf(product);
  const siblings = await ex
    .select({ metal: products.metal, purity: products.purity, variantCustomLabel: products.variantCustomLabel, sku: products.sku })
    .from(products)
    .where(and(eq(products.parentId, product.parentId), ne(products.id, product.id), isNull(products.deletedAt)));
  const clash = siblings.find((sibling) => labelKey(variantLabelOf(sibling)) === labelKey(label));
  if (!clash) return;
  const [parent] = await ex.select({ name: parentProducts.name }).from(parentProducts).where(eq(parentProducts.id, product.parentId)).limit(1);
  throw invalid({
    purity: `This product is a variant of “${parent?.name ?? "a parent product"}”, where ${clash.sku} is already labelled “${label}”. Give one of them a custom variant label first.`,
  });
}
