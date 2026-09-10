import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./common";
import { customers } from "./customers";
import { adminUsers } from "./identity";
import type { StoredAttachment } from "./expenses";

export type EnquiryType = "product" | "custom_jewellery" | "contact";
export type EnquiryStatus = "new" | "in_progress" | "responded" | "closed";
export type EnquirySource = "website_form" | "product_page" | "custom_jewellery" | "whatsapp" | "phone" | "walk_in";

export const enquiries = pgTable(
  "enquiries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reference: text("reference").notNull().unique(),
    type: text("type").$type<EnquiryType>().notNull(),
    source: text("source").$type<EnquirySource>().notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    mobile: text("mobile").notNull(),
    email: text("email").notNull(),
    subject: text("subject"),
    message: text("message").notNull(),
    product: jsonb("product").$type<{ id: string; name: string; sku: string } | null>(),
    jewelleryType: text("jewellery_type"),
    budgetRange: text("budget_range"),
    preferredMetal: text("preferred_metal"),
    preferredPurity: text("preferred_purity"),
    preferredContact: text("preferred_contact").$type<"phone" | "whatsapp" | "email" | null>(),
    attachments: jsonb("attachments").$type<StoredAttachment[]>().notNull().default([]),
    status: text("status").$type<EnquiryStatus>().notNull().default("new"),
    assignedToAdminId: uuid("assigned_to_admin_id").references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("enquiries_status_idx").on(t.status), index("enquiries_created_idx").on(t.createdAt), index("enquiries_customer_idx").on(t.customerId)],
);

export const enquiryNotes = pgTable(
  "enquiry_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enquiryId: uuid("enquiry_id")
      .notNull()
      .references(() => enquiries.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorName: text("author_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("enquiry_notes_enquiry_idx").on(t.enquiryId)],
);

export const enquiryContactLogs = pgTable(
  "enquiry_contact_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enquiryId: uuid("enquiry_id")
      .notNull()
      .references(() => enquiries.id, { onDelete: "cascade" }),
    channel: text("channel").$type<"phone" | "whatsapp" | "email" | "in_person">().notNull(),
    outcome: text("outcome").notNull(),
    note: text("note"),
    authorName: text("author_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("enquiry_contact_logs_enquiry_idx").on(t.enquiryId)],
);

export const newsletterSubscribers = pgTable("newsletter_subscribers", {
  email: text("email").primaryKey(),
  source: text("source").notNull().default("website"),
  subscribedAt: timestamp("subscribed_at", { withTimezone: true }).notNull().defaultNow(),
  unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
  updatedAt: updatedAt(),
});
