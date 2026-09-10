import { boolean, date, index, jsonb, pgTable, text, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createdAt, decimal, money, updatedAt } from "./common";
import { adminUsers } from "./identity";
import { vendors } from "./purchasing";

/**
 * EXPENSE MANAGEMENT — expanded scope (not in the original project document).
 * Accounting/tax treatment is intentionally minimal and configurable; confirm
 * rules with the business before relying on these records for bookkeeping.
 */

export const expenseCategories = pgTable("expense_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => expenseCategories.id, { onDelete: "set null" }),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type ExpenseStatus = "draft" | "submitted" | "approved" | "rejected" | "paid";
export type ExpensePaymentMethod = "cash" | "upi" | "bank_transfer" | "card" | "cheque" | "other";

export interface StoredAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  type: string;
  uploadedAt: string;
}

export const recurringExpenses = pgTable("recurring_expenses", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  categoryId: uuid("category_id")
    .notNull()
    .references(() => expenseCategories.id),
  amount: money("amount").notNull(),
  frequency: text("frequency").$type<"weekly" | "monthly" | "quarterly" | "yearly">().notNull(),
  nextDueDate: date("next_due_date", { mode: "string" }).notNull(),
  payee: text("payee").notNull(),
  paymentMethod: text("payment_method").$type<ExpensePaymentMethod>().notNull(),
  paymentSource: text("payment_source"),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  lastCreatedAt: timestamp("last_created_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expenseNumber: text("expense_number").notNull().unique(),
    expenseDate: date("expense_date", { mode: "string" }).notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => expenseCategories.id),
    amount: money("amount").notNull(),
    /** Only captured when the business requires tax on expenses. */
    taxAmount: money("tax_amount"),
    gstRate: decimal("gst_rate"),
    totalAmount: money("total_amount").notNull(),
    paymentMethod: text("payment_method").$type<ExpensePaymentMethod>().notNull(),
    paymentSource: text("payment_source"),
    payee: text("payee").notNull(),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    referenceNumber: text("reference_number"),
    description: text("description").notNull(),
    notes: text("notes"),
    attachments: jsonb("attachments").$type<StoredAttachment[]>().notNull().default([]),
    status: text("status").$type<ExpenseStatus>().notNull().default("draft"),
    recurringId: uuid("recurring_id").references(() => recurringExpenses.id, { onDelete: "set null" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decision: text("decision").$type<"approved" | "rejected" | null>(),
    decidedByName: text("decided_by_name"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidByName: text("paid_by_name"),
    createdById: uuid("created_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("expenses_date_idx").on(t.expenseDate),
    index("expenses_category_idx").on(t.categoryId),
    index("expenses_status_idx").on(t.status),
  ],
);

export const expenseEvents = pgTable(
  "expense_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expenseId: uuid("expense_id")
      .notNull()
      .references(() => expenses.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    note: text("note"),
    actorName: text("actor_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("expense_events_expense_idx").on(t.expenseId)],
);
