import type { Permission } from "@/auth/permissions";
import type { ImportColumn, RowError } from "./types";

/**
 * ONE SPREADSHEET ROW
 * ------------------------------------------------------------------
 * Turns cells (always plain trimmed text by the time they get here) into the
 * values the business schemas expect, collecting every problem instead of
 * stopping at the first one. An empty cell means "not provided", so entities
 * can tell "leave this as it is" apart from "set this to blank".
 */

const TRUE_WORDS = new Set(["yes", "y", "true", "t", "1", "on", "active", "enabled"]);
const FALSE_WORDS = new Set(["no", "n", "false", "f", "0", "off", "inactive", "disabled"]);

/** Excel's day zero (1899-12-30) — serial dates are whole days from there. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

export function parseNumber(text: string): number | null {
  const cleaned = text.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "").replace(/%$/, "");
  if (!cleaned || !/^[-+]?\d*\.?\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Accepts 2026-09-12, 12/09/2026, 12-09-2026, an Excel serial number, or a full timestamp. */
export function parseDateString(text: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (dmy) {
    const [day, month, year] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  if (/^\d{1,6}$/.test(text)) {
    const serial = Number(text);
    if (serial < 1 || serial > 100_000) return null;
    return new Date(EXCEL_EPOCH_MS + serial * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

export class RowReader {
  readonly number: number;
  private readonly cells: Record<string, string>;
  private readonly issues: RowError[] = [];
  private readonly reported = new Set<string>();

  constructor(
    row: { number: number; cells: Record<string, string> },
    private readonly columns: Map<string, ImportColumn>,
    private readonly can: (permission: Permission) => boolean,
  ) {
    this.number = row.number;
    this.cells = row.cells;
  }

  /** Header text, used as the `column` of every error so it matches what staff see in their file. */
  label(key: string) {
    return this.columns.get(key)?.label ?? key;
  }

  error(key: string, message: string) {
    this.issues.push({ row: this.number, column: this.label(key), message });
  }

  get errors(): RowError[] {
    return this.issues;
  }

  get ok() {
    return this.issues.length === 0;
  }

  /** True when the file supplied this column at all (so updates can tell "blank" from "absent"). */
  has(key: string) {
    return key in this.cells;
  }

  /** Trimmed cell text, or "" when empty. Confidential columns read as empty for admins without the permission. */
  value(key: string): string {
    const raw = this.cells[key] ?? "";
    const column = this.columns.get(key);
    if (raw && column?.permission && !this.can(column.permission)) {
      if (!this.reported.has(key)) {
        this.reported.add(key);
        this.error(key, `You don't have permission to import ${column.label.toLowerCase()}. Clear this column and try again.`);
      }
      return "";
    }
    return raw;
  }

  private require(key: string, required: boolean | undefined) {
    if (required) this.error(key, `${this.label(key)} is required.`);
    return undefined;
  }

  text(key: string, options: { required?: boolean; max?: number } = {}): string | undefined {
    const value = this.value(key);
    if (!value) return this.require(key, options.required);
    if (options.max && value.length > options.max) {
      this.error(key, `Keep ${this.label(key).toLowerCase()} to ${options.max} characters or fewer.`);
      return undefined;
    }
    return value;
  }

  numeric(key: string, options: { required?: boolean; min?: number; max?: number; integer?: boolean } = {}): number | undefined {
    const value = this.value(key);
    if (!value) return this.require(key, options.required);
    const parsed = parseNumber(value);
    if (parsed === null) {
      this.error(key, `${this.label(key)} must be a number.`);
      return undefined;
    }
    if (options.integer && !Number.isInteger(parsed)) {
      this.error(key, `${this.label(key)} must be a whole number.`);
      return undefined;
    }
    if (options.min !== undefined && parsed < options.min) {
      this.error(key, `${this.label(key)} can't be less than ${options.min}.`);
      return undefined;
    }
    if (options.max !== undefined && parsed > options.max) {
      this.error(key, `${this.label(key)} can't be more than ${options.max}.`);
      return undefined;
    }
    return parsed;
  }

  boolean(key: string, options: { required?: boolean } = {}): boolean | undefined {
    const value = this.value(key);
    if (!value) return this.require(key, options.required);
    const word = value.toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
    this.error(key, `${this.label(key)} must be Yes or No.`);
    return undefined;
  }

  date(key: string, options: { required?: boolean } = {}): string | undefined {
    const value = this.value(key);
    if (!value) return this.require(key, options.required);
    const parsed = parseDateString(value);
    if (!parsed || Number.isNaN(Date.parse(parsed))) {
      this.error(key, `${this.label(key)} must be a date like 2026-09-12 or 12/09/2026.`);
      return undefined;
    }
    return parsed;
  }

  /** One of a fixed list, matched ignoring case, spaces and hyphens ("Per Gram" → "per_gram"). */
  choice<T extends string>(key: string, allowed: readonly T[], options: { required?: boolean; extra?: Record<string, T> } = {}): T | undefined {
    const value = this.value(key);
    if (!value) return this.require(key, options.required);
    const normalised = value.toLowerCase().replace(/[\s-]+/g, "_");
    const match = allowed.find((option) => option.toLowerCase() === normalised) ?? options.extra?.[normalised];
    if (!match) {
      this.error(key, `${this.label(key)} must be one of: ${allowed.join(", ")}.`);
      return undefined;
    }
    return match;
  }

  /** Comma-separated list, e.g. collections, sizes or image links. */
  list(key: string, options: { required?: boolean; max?: number } = {}): string[] | undefined {
    const value = this.value(key);
    if (!value) return this.require(key, options.required);
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!items.length) return this.require(key, options.required);
    if (options.max && items.length > options.max) {
      this.error(key, `Add no more than ${options.max} items to ${this.label(key).toLowerCase()}.`);
      return undefined;
    }
    return items;
  }
}
