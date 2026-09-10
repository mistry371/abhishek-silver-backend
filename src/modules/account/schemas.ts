import { z } from "zod";
import { zMobile, zText } from "@/lib/validation";

const optionalLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((value) => value || undefined);

export const addressSchema = z.object({
  label: optionalLine(40),
  fullName: zText(120),
  phone: zMobile,
  line1: zText(200),
  line2: optionalLine(200),
  landmark: optionalLine(200),
  city: zText(80),
  state: zText(80),
  postalCode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{5}$/, { error: "Enter a valid 6-digit PIN code." }),
  country: z.string().trim().min(1).max(60).default("India"),
  isDefaultShipping: z.boolean().optional(),
  isDefaultBilling: z.boolean().optional(),
});

export type AddressInput = z.output<typeof addressSchema>;

export const cartItemSchema = z.object({
  productId: z.string().trim().min(1).max(80),
  slug: z.string().trim().max(160).default(""),
  size: z.string().trim().max(20).optional(),
  quantity: z.coerce.number().int().min(1).max(99),
  customization: z.record(z.string().max(40), z.string().max(500)).optional(),
});

export const couponCodeSchema = z.string().trim().max(40).optional().nullable();

/** Strips selection flags so only the delivery snapshot is stored on orders. */
export function toSnapshot(address: AddressInput) {
  return {
    fullName: address.fullName,
    phone: address.phone,
    line1: address.line1,
    ...(address.line2 ? { line2: address.line2 } : {}),
    ...(address.landmark ? { landmark: address.landmark } : {}),
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
  };
}
