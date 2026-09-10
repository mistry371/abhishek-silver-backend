import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor } from "@/db/client";
import { settings } from "@/db/schema";

/**
 * Business configuration. Every value that encodes a business decision the
 * documentation leaves open (shipping fee, invoice prefix, expense approvals…)
 * lives here so the business can change it without a deployment.
 */
export const settingSchemas = {
  general: z.object({
    businessName: z.string().trim().min(1).max(120).default("Abhishek Silver"),
    /** Registered name printed on invoices — to be supplied by the business. */
    legalName: z.string().trim().max(160).default(""),
    gstin: z.string().trim().max(15).default(""),
    /** GST state code of the store (Gujarat = 24). */
    stateCode: z.string().trim().max(2).default("24"),
    invoiceAddress: z.string().trim().max(400).default(""),
    supportEmail: z.string().trim().max(160).default(""),
    timezone: z.literal("Asia/Kolkata").default("Asia/Kolkata"),
  }),
  commerce: z.object({
    /** Flat shipping fee in INR. 0 until the business confirms its shipping policy. */
    shippingFee: z.number().min(0).max(100_000).default(0),
    maxLineQuantity: z.number().int().min(1).max(50).default(5),
    guestCheckout: z.boolean().default(true),
  }),
  inventory: z.object({
    defaultLocationId: z.string().min(1).default("store"),
    onlineFulfilmentLocationId: z.string().min(1).default("store"),
    defaultLowStockThreshold: z.number().int().min(0).max(1000).default(2),
    /** Movements larger than this (units) raise an "unusual stock change" alert. */
    unusualChangeThreshold: z.number().int().min(1).max(10_000).default(20),
  }),
  billing: z.object({
    invoicePrefix: z.string().trim().regex(/^[A-Z]{2,5}$/).default("INV"),
    footerNote: z.string().trim().max(500).default(""),
  }),
  expenses: z.object({
    /** When false, submitted expenses are approved automatically. */
    approvalRequired: z.boolean().default(true),
    /** Tax/GST fields only when the business requires them. */
    taxFieldsEnabled: z.boolean().default(false),
    paymentSources: z.array(z.string().trim().min(1).max(60)).max(20).default(["Cash", "Bank account"]),
  }),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.output<(typeof settingSchemas)[K]>;

export async function getSetting<K extends SettingKey>(key: K, executor: Executor = db()): Promise<SettingValue<K>> {
  const [row] = await executor.select().from(settings).where(eq(settings.key, key)).limit(1);
  return settingSchemas[key].parse(row?.value ?? {}) as SettingValue<K>;
}

export async function saveSetting<K extends SettingKey>(executor: Executor, key: K, value: SettingValue<K>, actorName: string) {
  await executor
    .insert(settings)
    .values({ key, value: value as Record<string, unknown>, updatedByName: actorName })
    .onConflictDoUpdate({ target: settings.key, set: { value: value as Record<string, unknown>, updatedByName: actorName, updatedAt: new Date() } });
}
