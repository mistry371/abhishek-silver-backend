/**
 * Shared JSON shapes stored in PostgreSQL `jsonb` columns and returned by the API.
 * These mirror the storefront's `src/types` so both repos speak the same contract.
 * All money is INR; weights are grams; stone weights are carats.
 */

export type MetalType = "gold" | "silver";
export type PurityCode = "24k" | "22k" | "18k" | "14k" | "999" | "925";
export type Gender = "women" | "men" | "kids" | "unisex";
export type CategoryGroup = "metal" | "type" | "audience" | "service";
export type SizingType = "ring" | "bangle" | "chain" | "bracelet";
export type CustomizationKey = "engraving" | "initial" | "note";
export type MakingChargeType = "per_gram" | "percentage" | "fixed";
export type StockStatus = "in_stock" | "low_stock" | "out_of_stock" | "unavailable";
export type ProductStatus = "active" | "draft" | "disabled";

export interface CategoryListingRule {
  metal?: MetalType;
  genders?: Gender[];
  /** Lists products that offer personalisation. */
  customizable?: boolean;
}

export interface ImageAsset {
  url: string;
  alt: string;
  width?: number;
  height?: number;
}

export interface VideoAsset {
  url: string;
  poster?: ImageAsset;
  mimeType?: string;
}

export interface CtaLink {
  label: string;
  href: string;
}

export interface SeoMeta {
  title?: string;
  description?: string;
  keywords?: string[];
}

export interface ProductDiscount {
  type: "percentage" | "fixed";
  value: number;
  label?: string;
  endsAt?: string;
}

export interface AddressSnapshot {
  fullName: string;
  phone: string;
  line1: string;
  line2?: string;
  landmark?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface MerchandisingFlags {
  featured: boolean;
  bestSeller: boolean;
  trending: boolean;
  newArrival: boolean;
  limited: boolean;
}

/** Customer-safe price breakdown — never contains purchase cost or margin. */
export interface PriceBreakdown {
  currency: "INR";
  metalRatePerGram: number;
  metalValue: number;
  makingCharges: number;
  stoneCharges: number;
  otherCharges: number;
  discount: number;
  originalPrice: number;
  taxableValue: number;
  gstRate: number;
  gst: number;
  finalPrice: number;
  rateEffectiveAt?: string;
  isEstimate?: boolean;
}

export interface ActorRef {
  id: string | null;
  name: string;
}
