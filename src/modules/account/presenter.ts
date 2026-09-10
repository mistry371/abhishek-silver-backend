import type { AuthTokens } from "@/auth/types";
import type { AddressDto, AuthSessionDto, CustomerDto } from "@/contracts/storefront";
import type { customerAddresses } from "@/db/schema";
import type { CustomerRow } from "@/http/context";

export function toCustomerDto(customer: CustomerRow): CustomerDto {
  return {
    id: customer.id,
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    marketingOptIn: customer.marketingOptIn,
    createdAt: customer.createdAt.toISOString(),
  };
}

export function toSessionDto(customer: CustomerRow, tokens: AuthTokens): AuthSessionDto {
  return {
    customer: toCustomerDto(customer),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  };
}

export function toAddressDto(row: typeof customerAddresses.$inferSelect): AddressDto {
  return {
    id: row.id,
    ...(row.label ? { label: row.label } : {}),
    fullName: row.fullName,
    phone: row.phone,
    line1: row.line1,
    ...(row.line2 ? { line2: row.line2 } : {}),
    ...(row.landmark ? { landmark: row.landmark } : {}),
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    country: row.country,
    isDefaultShipping: row.isDefaultShipping,
    isDefaultBilling: row.isDefaultBilling,
  };
}
