import { customType, timestamp } from "drizzle-orm/pg-core";

/**
 * Exact decimal columns mapped to JS numbers at the edge.
 * Stored as NUMERIC in PostgreSQL so totals never suffer float drift.
 */
export const money = customType<{ data: number; driverData: string }>({
  dataType: () => "numeric(14, 2)",
  toDriver: (value) => Number(value).toFixed(2),
  fromDriver: (value) => Number(value),
});

/** Grams / carats with three decimal places. */
export const weight = customType<{ data: number; driverData: string }>({
  dataType: () => "numeric(12, 3)",
  toDriver: (value) => Number(value).toFixed(3),
  fromDriver: (value) => Number(value),
});

/** Rates and percentages. */
export const decimal = customType<{ data: number; driverData: string }>({
  dataType: () => "numeric(12, 4)",
  toDriver: (value) => Number(value).toFixed(4),
  fromDriver: (value) => Number(value),
});

export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
