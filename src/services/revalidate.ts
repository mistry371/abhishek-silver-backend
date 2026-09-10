import { env } from "@/config/env";
import { logger } from "@/lib/logger";
import { invalidateCatalog } from "@/modules/catalog/snapshot";

/**
 * Asks the storefront to purge cached pages for the given cache tags
 * (best effort — the storefront also revalidates on a short timer).
 */
export function revalidateStorefront(tags: string[]) {
  if (!env.STOREFRONT_REVALIDATE_URL || !env.STOREFRONT_REVALIDATE_SECRET || !tags.length) return;
  void fetch(env.STOREFRONT_REVALIDATE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.STOREFRONT_REVALIDATE_SECRET}` },
    body: JSON.stringify({ tags: [...new Set(tags)] }),
    signal: AbortSignal.timeout(5_000),
  })
    .then((response) => {
      if (!response.ok) logger.warn({ status: response.status }, "Storefront revalidation was rejected");
    })
    .catch((error: unknown) => logger.warn({ err: error }, "Storefront revalidation failed"));
}

/** Call after any committed change that affects customer-facing products or prices. */
export function afterCatalogChange(extraTags: string[] = []) {
  invalidateCatalog();
  revalidateStorefront(["products", "categories", "collections", "offers", ...extraTags]);
}
