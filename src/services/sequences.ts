import { sql } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { sequences } from "@/db/schema";
import { financialYear, yearMonthStamp } from "@/lib/dates";

/**
 * Atomically increments a named counter. The upsert takes a row lock, so
 * concurrent transactions get distinct, gap-free numbers.
 */
export async function nextSequence(executor: Executor, name: string, startAt = 1): Promise<number> {
  const [row] = await executor
    .insert(sequences)
    .values({ name, value: startAt })
    .onConflictDoUpdate({ target: sequences.name, set: { value: sql`${sequences.value} + 1` } })
    .returning({ value: sequences.value });
  return row!.value;
}

const pad = (value: number, length: number) => String(value).padStart(length, "0");

export const documentNumbers = {
  order: async (ex: Executor) => `ORD-${yearMonthStamp()}-${await nextSequence(ex, "order", 1001)}`,
  customer: async (ex: Executor) => `CUS-${pad(await nextSequence(ex, "customer", 1), 5)}`,
  enquiry: async (ex: Executor) => `ENQ-${await nextSequence(ex, "enquiry", 1001)}`,
  vendor: async (ex: Executor) => `VEN-${pad(await nextSequence(ex, "vendor", 1), 4)}`,

  /** GST invoice numbers must be unique and consecutive within a financial year (≤ 16 characters). */
  invoice: async (ex: Executor, prefix: string) => {
    const fy = financialYear();
    return `${prefix}-${fy.short}-${pad(await nextSequence(ex, `invoice:${fy.label}`, 1), 5)}`;
  },
  sale: async (ex: Executor) => {
    const fy = financialYear();
    return `SAL-${fy.short}-${pad(await nextSequence(ex, `sale:${fy.label}`, 1), 5)}`;
  },
  purchase: async (ex: Executor) => {
    const fy = financialYear();
    return `PUR-${fy.short}-${pad(await nextSequence(ex, `purchase:${fy.label}`, 1), 4)}`;
  },
  expense: async (ex: Executor) => {
    const fy = financialYear();
    return `EXP-${fy.short}-${pad(await nextSequence(ex, `expense:${fy.label}`, 1), 4)}`;
  },
  return: async (ex: Executor) => `RET-${pad(await nextSequence(ex, "return", 1), 5)}`,
  refund: async (ex: Executor) => `RFD-${pad(await nextSequence(ex, "refund", 1), 5)}`,
};
