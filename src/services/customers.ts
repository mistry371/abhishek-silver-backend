import type { Executor } from "@/db/client";
import { customers } from "@/db/schema";
import { documentNumbers } from "./sequences";

export async function createCustomerRecord(
  executor: Executor,
  input: {
    authUserId?: string | null;
    firstName: string;
    lastName?: string;
    email?: string | null;
    phone?: string | null;
    marketingOptIn?: boolean;
    source: "website" | "admin" | "walk_in";
  },
) {
  const [row] = await executor
    .insert(customers)
    .values({
      authUserId: input.authUserId ?? null,
      customerCode: await documentNumbers.customer(executor),
      firstName: input.firstName,
      lastName: input.lastName ?? "",
      email: input.email ?? null,
      phone: input.phone ?? null,
      marketingOptIn: input.marketingOptIn ?? false,
      source: input.source,
    })
    .returning();
  return row!;
}

export const customerName = (customer: { firstName: string; lastName: string }) =>
  `${customer.firstName} ${customer.lastName}`.trim();
