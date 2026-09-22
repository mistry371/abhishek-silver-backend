/**
 * Customer-facing API contracts. Mirrors the storefront's `src/types/*`.
 * NEVER add purchase price, supplier, margin, valuation or stock quantities.
 */
import type {
  AddressSnapshot,
  CategoryGroup,
  Gender,
  ImageAsset,
  MetalType,
  PriceBreakdown,
  ProductDiscount,
  PurityCode,
  SeoMeta,
  StockStatus,
  VideoAsset,
} from "./common";

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/* ---------------------------------- Catalogue ---------------------------------- */

export interface InventoryAvailability {
  status: StockStatus;
  purchasable: boolean;
  message?: string;
}

export interface TaxonomyRef {
  id: string;
  slug: string;
  name: string;
}

export interface ProductSizeOption {
  value: string;
  label: string;
  available: boolean;
}

export interface CustomizationOption {
  id: string;
  type: "text" | "textarea" | "select";
  label: string;
  required: boolean;
  maxLength?: number;
  helpText?: string;
  options?: { value: string; label: string }[];
}

/** The parent product (design) a product is a variant of, on the product page. */
export interface ProductParentRef {
  id: string;
  slug: string;
  name: string;
}

/** The parent product on a listing card. Prices span the parent's active variants. */
export interface ProductParentSummary extends ProductParentRef {
  variantCount: number;
  priceFrom: number;
  priceTo: number;
}

/** A sibling variant (another product of the same design), for the variant picker. */
export interface ProductVariant {
  id: string;
  slug: string;
  sku: string;
  label: string;
  metal: MetalType;
  purity: PurityCode;
  price: number;
  availability: InventoryAvailability;
  image: ImageAsset | null;
}

export type ProductBadge = "new" | "best_seller" | "trending" | "sale" | "limited" | "out_of_stock";

export interface Product {
  id: string;
  name: string;
  slug: string;
  sku: string;
  shortDescription: string;
  description: string;
  images: ImageAsset[];
  video?: VideoAsset | null;
  category: TaxonomyRef;
  subcategory?: TaxonomyRef | null;
  collections: TaxonomyRef[];
  metal: MetalType;
  purity: PurityCode;
  gender: Gender;
  grossWeight: number;
  netWeight: number;
  stoneWeight?: number | null;
  stoneDetails?: string | null;
  makingCharges: number;
  stoneCharges: number;
  otherCharges: number;
  basePrice: number;
  discount?: ProductDiscount | null;
  gst: { rate: number; amount: number };
  finalPrice: number;
  pricing: PriceBreakdown;
  availability: InventoryAvailability;
  stockStatus: StockStatus;
  sizes: ProductSizeOption[];
  defaultSize?: string | null;
  /** Set when the product is a variant of an active parent product. */
  parent: ProductParentRef | null;
  /** Every active variant of the parent (including this product), in display order. Empty for standalone products. */
  variants: ProductVariant[];
  customization: CustomizationOption[];
  badges: ProductBadge[];
  featured: boolean;
  bestSeller: boolean;
  trending: boolean;
  newArrival: boolean;
  seo: SeoMeta;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProductSummary = Pick<
  Product,
  | "id"
  | "name"
  | "slug"
  | "sku"
  | "images"
  | "category"
  | "collections"
  | "metal"
  | "purity"
  | "gender"
  | "grossWeight"
  | "netWeight"
  | "makingCharges"
  | "discount"
  | "finalPrice"
  | "pricing"
  | "availability"
  | "stockStatus"
  | "sizes"
  | "defaultSize"
  | "customization"
  | "badges"
  | "createdAt"
> & {
  /** Set when the card stands for a parent product (one design with several variants). */
  parent: ProductParentSummary | null;
};

export interface Subcategory {
  id: string;
  slug: string;
  name: string;
  categoryId: string;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  shortName?: string;
  description: string;
  image: ImageAsset;
  group: CategoryGroup;
  productCount?: number;
  subcategories: Subcategory[];
  seo?: SeoMeta;
  displayOrder: number;
  active: boolean;
}

export interface Collection {
  id: string;
  slug: string;
  name: string;
  eyebrow?: string;
  description: string;
  image: ImageAsset;
  mobileImage?: ImageAsset;
  seo?: SeoMeta;
  displayOrder: number;
  active: boolean;
}

export type SortOption = "featured" | "newest" | "price_asc" | "price_desc" | "best_selling" | "trending" | "most_viewed";

export interface ProductFilters {
  base?: string;
  category?: string[];
  sub?: string;
  collection?: string;
  metal?: MetalType[];
  purity?: PurityCode[];
  gender?: Gender[];
  size?: string[];
  inStock?: boolean;
  newArrival?: boolean;
  bestSeller?: boolean;
  minPrice?: number;
  maxPrice?: number;
  minWeight?: number;
  maxWeight?: number;
  q?: string;
  sort?: SortOption;
  page?: number;
  pageSize?: number;
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

export interface ProductFacets {
  categories: FacetOption[];
  metals: FacetOption[];
  purities: FacetOption[];
  genders: FacetOption[];
  sizes: FacetOption[];
  collections: FacetOption[];
  price: { min: number; max: number };
  weight: { min: number; max: number };
}

export interface ProductListResponse extends Paginated<ProductSummary> {
  facets: ProductFacets;
}

export interface SearchSuggestions {
  query: string;
  products: ProductSummary[];
  categories: { label: string; href: string; meta?: string }[];
  collections: { label: string; href: string; meta?: string }[];
  total: number;
}

export interface ProductPriceResponse {
  productId: string;
  size?: string;
  pricing: PriceBreakdown;
  availability: InventoryAvailability;
  grossWeight: number;
  netWeight: number;
}

export interface ComparisonItem {
  productId: string;
  slug: string;
  name: string;
  image: ImageAsset;
  sku: string;
  metal: MetalType;
  purity: PurityCode;
  grossWeight: number;
  netWeight: number;
  makingCharges: number;
  finalPrice: number;
  availability: InventoryAvailability;
}

/* ---------------------------------- Cart ---------------------------------- */

export interface CartItemInput {
  productId: string;
  slug: string;
  size?: string;
  quantity: number;
  customization?: Record<string, string>;
}

export interface CartItem extends CartItemInput {
  lineId: string;
  product: ProductSummary;
  unitPrice: number;
  lineTotal: number;
  availability: InventoryAvailability;
}

export type CartIssueType = "out_of_stock" | "unavailable" | "price_changed" | "quantity_adjusted" | "coupon_invalid";

export interface CartIssue {
  lineId?: string;
  type: CartIssueType;
  message: string;
}

export interface CartTotals {
  itemCount: number;
  subtotal: number;
  productSavings: number;
  couponDiscount: number;
  gst: number;
  shipping: number;
  grandTotal: number;
}

export interface AppliedCoupon {
  code: string;
  description: string;
  discount: number;
}

export interface Cart {
  id?: string;
  items: CartItem[];
  coupon: AppliedCoupon | null;
  totals: CartTotals;
  issues: CartIssue[];
  currency: "INR";
  quotedAt: string;
}

export interface WishlistItem {
  productId: string;
  slug: string;
  addedAt: string;
  product?: ProductSummary;
}

/* ---------------------------------- Customers & orders ---------------------------------- */

export interface CustomerDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  marketingOptIn: boolean;
  createdAt: string;
}

export interface AuthSessionDto {
  customer: CustomerDto;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
}

export interface AddressDto extends AddressSnapshot {
  id: string;
  label?: string;
  isDefaultShipping?: boolean;
  isDefaultBilling?: boolean;
}

export type OrderStatus = "new" | "confirmed" | "processing" | "packed" | "shipped" | "delivered" | "completed" | "cancelled" | "returned" | "refunded";
export type PaymentStatus = "pending" | "authorized" | "paid" | "failed" | "refunded";

export interface OrderDto {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  customer: { name: string; email: string; phone: string };
  items: {
    id: string;
    productId: string;
    slug: string;
    name: string;
    sku: string;
    image: ImageAsset;
    metal: MetalType;
    purity: PurityCode;
    size?: string;
    customization?: Record<string, string>;
    grossWeight: number;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
  shippingAddress: AddressSnapshot;
  billingAddress: AddressSnapshot;
  totals: CartTotals;
  coupon: AppliedCoupon | null;
  payment: {
    id: string;
    provider: string;
    status: PaymentStatus;
    method?: string;
    amount: number;
    providerOrderId?: string;
    providerPaymentId?: string;
    paidAt?: string;
  };
  timeline: { status: OrderStatus; at: string; note?: string }[];
  invoiceUrl: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentIntent {
  provider: "razorpay" | "demo";
  keyId?: string;
  providerOrderId: string;
  amount: number;
  currency: "INR";
}

export interface EnquiryDto {
  id: string;
  reference: string;
  type: "product" | "custom_jewellery" | "contact";
  name: string;
  mobile: string;
  email: string;
  message: string;
  subject?: string;
  product?: { id: string; name: string; sku: string };
  jewelleryType?: string;
  budgetRange?: string;
  preferredMetal?: string;
  preferredPurity?: string;
  preferredContact?: "phone" | "whatsapp" | "email";
  attachments?: { name: string; size: number; type: string }[];
  status: "new" | "in_progress" | "responded" | "closed";
  createdAt: string;
}
