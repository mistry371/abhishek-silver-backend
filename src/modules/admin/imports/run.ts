import { db } from "@/db/client";
import { AppError } from "@/lib/errors";
import { recordAudit, type Actor } from "@/services/audit";
import { afterCatalogChange } from "@/services/revalidate";
import { uniqueViolation } from "../helpers";
import { RowReader } from "./reader";
import { MAX_ROWS, readTable, type SpreadsheetFormat } from "./spreadsheet";
import type { AnyImport, ImportColumn, ImportContext, RowError, RowPlan } from "./types";

/**
 * PREVIEW & COMMIT
 * ------------------------------------------------------------------
 * Preview validates every row and writes nothing. Commit validates every row
 * again inside one transaction and only then writes: a single bad row leaves
 * the whole file unsaved, so staff never end up with half an import.
 */

export const MAX_ERRORS = 200;
export const MAX_SAMPLE = 10;

export type ImportMode = "preview" | "commit";

export interface ImportResult {
  entity: string;
  mode: ImportMode;
  fileName: string;
  totalRows: number;
  valid: number;
  invalid: number;
  created: number;
  updated: number;
  skipped: number;
  errors: RowError[];
  sample: { row: number; action: string; summary: string }[];
}

export interface RunInput {
  mode: ImportMode;
  fileName: string;
  buffer: Buffer;
  format: SpreadsheetFormat;
  actor: Actor;
  can: ImportContext["can"];
}

/** Headers match ignoring case, spaces and punctuation: "Net Weight (g)" = "net_weight_g". */
const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

class ImportRejected extends Error {
  constructor(
    readonly rowErrors: RowError[],
    readonly plans: RowPlan[],
  ) {
    super("Import rejected");
  }
}

function mapHeaders(definition: AnyImport, header: string[]): Map<number, string> {
  const byName = new Map<string, ImportColumn>();
  for (const column of definition.columns) {
    for (const name of [column.key, column.label, ...(column.aliases ?? [])]) byName.set(normalise(name), column);
  }

  const keyByIndex = new Map<number, string>();
  const seen = new Set<string>();
  const unknown: string[] = [];
  const duplicated: string[] = [];
  header.forEach((text, index) => {
    const title = text.trim();
    if (!title) return;
    const column = byName.get(normalise(title));
    if (!column) {
      unknown.push(title);
      return;
    }
    if (seen.has(column.key)) {
      duplicated.push(column.label);
      return;
    }
    seen.add(column.key);
    keyByIndex.set(index, column.key);
  });

  const missing = definition.columns.filter((column) => column.required && !seen.has(column.key)).map((column) => column.label);
  if (missing.length || unknown.length || duplicated.length) {
    const problems = [
      missing.length ? `${missing.length === 1 ? "This column is" : "These columns are"} missing: ${missing.join(", ")}.` : "",
      unknown.length ? `${unknown.length === 1 ? "This column isn't" : "These columns aren't"} recognised: ${unknown.join(", ")}.` : "",
      duplicated.length ? `${duplicated.join(", ")} appears more than once.` : "",
    ].filter(Boolean);
    throw new AppError(
      "validation_error",
      `${problems.join(" ")} The ${definition.label} file's columns are: ${definition.columns.map((column) => column.label).join(", ")}. Download the template and fill that in.`,
    );
  }
  return keyByIndex;
}

function buildRows(rows: { number: number; cells: string[] }[], keyByIndex: Map<number, string>) {
  const built: { number: number; cells: Record<string, string> }[] = [];
  for (const row of rows) {
    const cells: Record<string, string> = {};
    let filled = false;
    for (const [index, key] of keyByIndex) {
      const value = row.cells[index] ?? "";
      cells[key] = value;
      if (value) filled = true;
    }
    // Fully empty rows (spacers, or the blank rows Excel leaves behind) are ignored.
    if (filled) built.push({ number: row.number, cells });
  }
  return built;
}

/** Maps a schema field name ("categoryId", "discount.value") back to the column heading staff see. */
function fieldResolver(definition: AnyImport) {
  const labels = new Map<string, string>();
  for (const column of definition.columns) {
    // Several columns can feed one field (a discount type and its value); the first one owns the message.
    for (const name of [column.key, column.field ?? column.key]) if (!labels.has(name)) labels.set(name, column.label);
  }
  return (field: string) => labels.get(field) ?? labels.get(field.split(".")[0] ?? field) ?? field;
}

/** Turns a business-rule failure into row errors; returns null for anything that should bubble up. */
function describeError(error: unknown, row: number, resolve: (field: string) => string): RowError[] | null {
  if (error instanceof AppError) {
    if (error.fieldErrors) return Object.entries(error.fieldErrors).map(([field, message]) => ({ row, column: resolve(field), message }));
    if (error.code === "validation_error" || error.code === "not_found" || error.code === "conflict") return [{ row, column: "", message: error.message }];
    return null;
  }
  if (uniqueViolation(error)) return [{ row, column: "", message: "Another record already uses one of these values (SKU, URL slug, barcode or code)." }];
  return null;
}

async function planRows(definition: AnyImport, rows: { number: number; cells: Record<string, string> }[], ctx: ImportContext) {
  const state = await definition.prepare(ctx);
  const columns = new Map(definition.columns.map((column) => [column.key, column]));
  const resolve = fieldResolver(definition);
  const plans: RowPlan[] = [];
  const errors: RowError[] = [];

  for (const row of rows) {
    const reader = new RowReader(row, columns, ctx.can);
    let plan: RowPlan | null = null;
    try {
      plan = await definition.plan(reader, state, ctx);
    } catch (error) {
      const described = describeError(error, row.number, resolve);
      if (!described) throw error;
      errors.push(...reader.errors, ...described);
      continue;
    }
    if (plan && reader.ok) plans.push(plan);
    else if (reader.errors.length) errors.push(...reader.errors);
    else errors.push({ row: row.number, column: "", message: "This row couldn't be imported." });
  }
  return { state, plans, errors };
}

function summarise(
  base: Pick<ImportResult, "entity" | "mode" | "fileName" | "totalRows">,
  plans: RowPlan[],
  errors: RowError[],
  counts: { created: number; updated: number; skipped: number },
): ImportResult {
  const invalid = new Set(errors.map((error) => error.row)).size;
  return {
    ...base,
    valid: Math.max(base.totalRows - invalid, 0),
    invalid,
    ...counts,
    errors: errors.slice(0, MAX_ERRORS),
    sample: plans.slice(0, MAX_SAMPLE).map((plan) => ({ row: plan.row, action: plan.action, summary: plan.summary })),
  };
}

const NO_COUNTS = { created: 0, updated: 0, skipped: 0 };

export async function runImport(definition: AnyImport, input: RunInput): Promise<{ status: number; body: ImportResult }> {
  const table = await readTable(input.buffer, input.format);
  const rows = buildRows(table.rows, mapHeaders(definition, table.header));
  const limit = Math.min(definition.rowLimit ?? MAX_ROWS, MAX_ROWS);
  if (!rows.length) throw new AppError("validation_error", "That file has a header row but no data to import.");
  if (rows.length > limit) {
    throw new AppError(
      "validation_error",
      `This file has ${rows.length.toLocaleString("en-IN")} rows. Import up to ${limit.toLocaleString("en-IN")} rows at a time and put the rest in another file.`,
    );
  }

  const base = { entity: definition.entity, mode: input.mode, fileName: input.fileName, totalRows: rows.length };
  const context = { actor: input.actor, can: input.can, fileName: input.fileName };

  if (input.mode === "preview") {
    const { plans, errors } = await planRows(definition, rows, { ...context, ex: db() });
    return { status: 200, body: summarise(base, plans, errors, NO_COUNTS) };
  }

  const resolve = fieldResolver(definition);
  const counts = { created: 0, updated: 0, skipped: 0 };
  let written: RowPlan[] = [];
  try {
    await db().transaction(async (tx) => {
      const ctx = { ...context, ex: tx, tx };
      const { state, plans, errors } = await planRows(definition, rows, ctx);
      if (errors.length) throw new ImportRejected(errors, plans);

      for (const plan of plans) {
        try {
          await definition.apply(plan, state, ctx);
        } catch (error) {
          const described = describeError(error, plan.row, resolve);
          if (!described) throw error;
          throw new ImportRejected(described, plans);
        }
        counts[plan.action === "create" ? "created" : plan.action === "update" ? "updated" : "skipped"] += 1;
      }
      written = plans;
      await recordAudit(tx, input.actor, {
        module: definition.module,
        action: "import",
        entityType: definition.entity,
        entityLabel: input.fileName,
        after: { totalRows: rows.length, ...counts },
        sensitive: true,
      });
    });
  } catch (error) {
    if (error instanceof ImportRejected) return { status: 422, body: summarise(base, error.plans, error.rowErrors, NO_COUNTS) };
    throw error;
  }

  if (definition.revalidate) afterCatalogChange();
  return { status: 200, body: summarise(base, written, [], counts) };
}
