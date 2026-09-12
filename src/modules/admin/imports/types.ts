import type { Permission } from "@/auth/permissions";
import type { Executor, Tx } from "@/db/client";
import type { Actor } from "@/services/audit";
import type { RowReader } from "./reader";

/**
 * BULK IMPORT REGISTRY — shared types
 * ------------------------------------------------------------------
 * Every section that can be imported describes itself here: its columns,
 * how a row is validated and how a validated row is written. The router,
 * the template builder and the preview/commit runner are generic, so a new
 * section only needs one more definition.
 */

export interface ImportColumn {
  key: string;
  /** Header text written to the template. Uploads match headers ignoring case, spaces and punctuation. */
  label: string;
  /** Required columns must be present in an uploaded file; a missing value is reported per row. */
  required?: boolean;
  example: string;
  /** Second example row in the template; falls back to `example`. */
  example2?: string;
  /** Allowed values and notes, shown in the API, the template's Instructions sheet and the admin UI. */
  hint: string;
  /** Extra header spellings accepted on upload (for files exported from other systems). */
  aliases?: string[];
  /** Values are only accepted from admins holding this permission; other admins get a row error. */
  permission?: Permission;
  /** Schema field this column feeds, when it differs from `key` (maps validation errors back to a column). */
  field?: string;
}

export type RowAction = "create" | "update" | "skip";

/** One problem with one cell, in the shop owner's words. */
export interface RowError {
  row: number;
  column: string;
  message: string;
}

/** What one validated row would do. Entities extend this with the values they need to write. */
export interface RowPlan {
  row: number;
  action: RowAction;
  summary: string;
}

export interface ImportContext {
  /** Read-only pool during preview, the open transaction during commit. */
  ex: Executor;
  actor: Actor;
  can(permission: Permission): boolean;
  fileName: string;
}

export interface CommitContext extends ImportContext {
  tx: Tx;
}

export interface ImportDefinition<State = unknown, Plan extends RowPlan = RowPlan> {
  /** URL segment, e.g. "products" → POST /v1/admin/imports/products. */
  entity: string;
  label: string;
  description: string;
  /** Audit module, matching the manual screens for the same records. */
  module: string;
  /** The permission reported to the admin UI. */
  permission: Permission;
  /** Any one of these may run the import. Defaults to `permission` alone. */
  gate?: Permission[];
  /** Maximum data rows per file (never above MAX_ROWS). */
  rowLimit?: number;
  /** Purge storefront caches after a committed import. */
  revalidate?: boolean;
  columns: ImportColumn[];
  /** Lookups shared by every row (categories, locations…) plus per-file duplicate tracking. */
  prepare(ctx: ImportContext): Promise<State>;
  /** Validates one row. Problems are reported through the reader; return null when the row can't be planned. */
  plan(row: RowReader, state: State, ctx: ImportContext): Promise<Plan | null>;
  /** Writes one planned row. Only ever called inside the commit transaction, after every row validated. */
  apply(plan: Plan, state: State, ctx: CommitContext): Promise<void>;
}

/** Definitions are stored with their state type erased so one registry can hold them all. */
export type AnyImport = ImportDefinition<unknown, RowPlan>;

export function defineImport<State, Plan extends RowPlan>(definition: ImportDefinition<State, Plan>): AnyImport {
  return definition as unknown as AnyImport;
}
