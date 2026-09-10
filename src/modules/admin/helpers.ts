import type { Request } from "express";
import { asc, desc, gte, ilike, lt, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { AppError, invalid, notFound } from "@/lib/errors";
import { istDateEnd, istDateStart } from "@/lib/dates";
import { isUuid } from "@/lib/ids";
import { zDate, zPagination } from "@/lib/validation";

/** Route id parameter that must be a uuid (anything else is simply "not found"). */
export function idParam(req: Request, name = "id"): string {
  const value = String(req.params[name] ?? "");
  if (!isUuid(value)) throw notFound();
  return value;
}

export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

export function searchAny(q: string | undefined, columns: (PgColumn | SQL)[]): SQL | undefined {
  if (!q) return undefined;
  const pattern = `%${escapeLike(q)}%`;
  return or(...columns.map((column) => ilike(column as PgColumn, pattern)));
}

export const listQuery = zPagination.extend({
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((value) => value || undefined),
  sort: z.string().max(40).optional(),
});

export const dateRangeQuery = z.object({ from: zDate.optional(), to: zDate.optional() });

/** "field:asc" | "field:desc" against a whitelist of sortable columns. */
export function sortBy(sort: string | undefined, allowed: Record<string, AnyColumn | SQL | SQL.Aliased>, fallback: SQL): SQL {
  if (!sort) return fallback;
  const [key, direction] = sort.split(":");
  const column = key ? allowed[key] : undefined;
  if (!column) return fallback;
  return direction === "asc" ? asc(column as AnyColumn) : desc(column as AnyColumn);
}

/** IST calendar-date range on a timestamp column (inclusive of both dates). */
export function withinDates(column: PgColumn, from?: string, to?: string): SQL[] {
  const conditions: SQL[] = [];
  if (from) conditions.push(gte(column, istDateStart(from)));
  if (to) conditions.push(lt(column, istDateEnd(to)));
  return conditions;
}

/** Same range against a `date` column stored as "YYYY-MM-DD". */
export function withinDateStrings(column: PgColumn, from?: string, to?: string): SQL[] {
  const conditions: SQL[] = [];
  if (from) conditions.push(gte(column, from));
  if (to) conditions.push(sql`${column} <= ${to}`);
  return conditions;
}

interface DatabaseError {
  code?: string;
  constraint?: string;
  constraint_name?: string;
  cause?: DatabaseError;
}

/** Returns the violated unique constraint name, if the error is a unique violation. */
export function uniqueViolation(error: unknown): string | null {
  let current = error as DatabaseError | undefined;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.cause) {
    if (current.code === "23505") return current.constraint_name ?? current.constraint ?? "unique";
  }
  return null;
}

/** Runs a write and turns unique violations into friendly field errors. */
export async function withUniqueFields<T>(write: () => Promise<T>, fields: Record<string, [field: string, message: string]>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const constraint = uniqueViolation(error);
    if (!constraint) throw error;
    const match = Object.entries(fields).find(([name]) => constraint.includes(name));
    if (match) throw invalid({ [match[1][0]]: match[1][1] });
    throw new AppError("validation_error", "A record with these details already exists.");
  }
}

export const toNumber = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
export const toDate = (value: unknown) => (value === null || value === undefined ? null : value instanceof Date ? value : new Date(String(value)));
