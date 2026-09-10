import type { EnquiryDto } from "@/contracts/storefront";
import type { enquiries } from "@/db/schema";

export function toEnquiryDto(row: typeof enquiries.$inferSelect): EnquiryDto {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    name: row.name,
    mobile: row.mobile,
    email: row.email,
    message: row.message,
    ...(row.subject ? { subject: row.subject } : {}),
    ...(row.product ? { product: row.product } : {}),
    ...(row.jewelleryType ? { jewelleryType: row.jewelleryType } : {}),
    ...(row.budgetRange ? { budgetRange: row.budgetRange } : {}),
    ...(row.preferredMetal ? { preferredMetal: row.preferredMetal } : {}),
    ...(row.preferredPurity ? { preferredPurity: row.preferredPurity } : {}),
    ...(row.preferredContact ? { preferredContact: row.preferredContact } : {}),
    ...(row.attachments.length ? { attachments: row.attachments.map(({ name, size, type }) => ({ name, size, type })) } : {}),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
