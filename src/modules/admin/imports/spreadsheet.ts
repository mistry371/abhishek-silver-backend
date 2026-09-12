import ExcelJS from "exceljs";
import { AppError } from "@/lib/errors";
import type { AnyImport } from "./types";

/**
 * SPREADSHEET IN / OUT
 * ------------------------------------------------------------------
 * Reading: the real file type is taken from the leading bytes (an .xlsx is a
 * ZIP), never from the browser's content type. Every cell is reduced to
 * trimmed text — Excel dates become "YYYY-MM-DD" and numbers keep their value
 * whether they were typed as numbers or as text.
 * Writing: a ready-to-fill template with an Instructions sheet.
 */

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 2000;

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

export type SpreadsheetFormat = "xlsx" | "csv";

export interface SheetRow {
  /** The spreadsheet's own row number (header = row 1 in a normal file). */
  number: number;
  cells: string[];
}

export interface SheetTable {
  header: string[];
  rows: SheetRow[];
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

/** Trusts the bytes, not the upload's declared type or extension. */
export function detectFormat(buffer: Buffer, fileName: string): SpreadsheetFormat {
  if (!buffer.length) throw new AppError("validation_error", "That file is empty.");
  if (buffer.subarray(0, 4).equals(ZIP_MAGIC)) return "xlsx";
  if (buffer.subarray(0, 4).equals(OLE_MAGIC)) {
    throw new AppError("validation_error", "This is an older .xls file. Open it in Excel and save it as .xlsx, then upload it again.");
  }
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (extension === "xlsx") throw new AppError("validation_error", "That file isn't a real Excel workbook. Open it in Excel and save it as .xlsx.");
  if (isText(buffer)) return "csv";
  throw new AppError("validation_error", "Upload an Excel file (.xlsx) or a CSV file (.csv).");
}

function isText(buffer: Buffer) {
  const sample = buffer.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

/** Cell values arrive as strings, numbers, dates, rich text, hyperlinks or formula results. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof value === "object") {
    const record = value as { text?: unknown; richText?: { text?: string }[]; result?: unknown; formula?: unknown; error?: unknown; hyperlink?: unknown };
    if (Array.isArray(record.richText)) return record.richText.map((part) => part.text ?? "").join("").trim();
    if (record.error !== undefined) return "";
    if (record.result !== undefined) return cellText(record.result);
    if (typeof record.text === "string") return record.text.trim();
    if ("formula" in record) return "";
  }
  return String(value).trim();
}

/** RFC 4180 with the usual real-world allowances: BOM, CRLF and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((cells) => cells.map((cell) => cell.trim()));
}

async function readXlsx(buffer: Buffer): Promise<SheetRow[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs types its own Buffer; the bytes are the same.
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new AppError("validation_error", "We couldn't read that Excel file. Open it in Excel, save it again as .xlsx and retry.");
  }
  const sheet = workbook.worksheets.find((worksheet) => worksheet.state !== "hidden") ?? workbook.worksheets[0];
  if (!sheet) throw new AppError("validation_error", "That workbook has no sheets.");

  const rows: SheetRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      cells[columnNumber - 1] = cellText(cell.value);
    });
    rows.push({ number: rowNumber, cells: Array.from(cells, (cell) => cell ?? "") });
  });
  return rows;
}

/** Header row plus data rows, keeping each row's real spreadsheet number for error messages. */
export async function readTable(buffer: Buffer, format: SpreadsheetFormat): Promise<SheetTable> {
  const all: SheetRow[] =
    format === "xlsx"
      ? await readXlsx(buffer)
      : parseCsv(new TextDecoder("utf-8").decode(buffer)).map((cells, index) => ({ number: index + 1, cells }));

  const filled = all.filter((row) => row.cells.some((cell) => cell !== ""));
  const header = filled[0];
  if (!header) throw new AppError("validation_error", "That file has no rows. Download the template, fill it in and upload it again.");
  return { header: header.cells, rows: filled.slice(1) };
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

const csvCell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

function templateNotes(definition: AnyImport) {
  return [
    "How this import works",
    "1. Keep the header row exactly as it is — you can delete columns you don't need, apart from the required ones.",
    "2. Replace the two example rows with your own data. Leave a cell blank when you have nothing to put in it.",
    `3. Up to ${(definition.rowLimit ?? MAX_ROWS).toLocaleString("en-IN")} rows and 5 MB per file.`,
    "4. Upload it in the admin panel and check the preview: it lists every problem by row before anything is saved.",
    "5. Nothing is saved until the preview is clean and you confirm the import.",
  ];
}

export async function buildTemplate(definition: AnyImport, format: SpreadsheetFormat): Promise<Buffer> {
  const columns = definition.columns;
  if (format === "csv") {
    const lines = [
      columns.map((column) => csvCell(column.label)).join(","),
      columns.map((column) => csvCell(column.example)).join(","),
      columns.map((column) => csvCell(column.example2 ?? column.example)).join(","),
    ];
    // The BOM keeps Excel from mangling non-English text when it opens the file.
    return Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8");
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Abhishek Silver";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(definition.label.slice(0, 28), { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns.map((column) => ({
    header: column.label,
    key: column.key,
    width: Math.min(Math.max(column.label.length + 4, column.example.length + 4, 14), 44),
  }));
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
  headerRow.alignment = { vertical: "middle" };
  headerRow.height = 22;
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  for (const example of ["example", "example2"] as const) {
    sheet.addRow(Object.fromEntries(columns.map((column) => [column.key, column[example] ?? column.example])));
  }

  const guide = workbook.addWorksheet("Instructions");
  guide.columns = [
    { header: "Column", key: "column", width: 28 },
    { header: "Required", key: "required", width: 12 },
    { header: "Example", key: "example", width: 30 },
    { header: "Allowed values & notes", key: "hint", width: 72 },
  ];
  guide.getRow(1).font = { bold: true };
  for (const column of columns) {
    guide.addRow({ column: column.label, required: column.required ? "Required" : "Optional", example: column.example, hint: column.hint });
  }
  guide.getColumn("hint").alignment = { wrapText: true, vertical: "top" };
  guide.addRow({});
  for (const [index, note] of templateNotes(definition).entries()) {
    const row = guide.addRow({ column: note });
    if (index === 0) row.font = { bold: true };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export const templateFileName = (definition: AnyImport, format: SpreadsheetFormat) => `abhishek-silver-${definition.entity}-import-template.${format}`;
