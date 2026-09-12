import { Router, type Request, type RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import type { Permission } from "@/auth/permissions";
import { can } from "@/http/auth";
import { AppError, forbidden, invalid, notFound } from "@/lib/errors";
import { parse } from "@/lib/validation";
import { actorOf } from "@/services/audit";
import { couponImport, expenseImport, metalRateImport } from "./entities/finance";
import { inventoryImport } from "./entities/inventory";
import { customerImport, vendorImport } from "./entities/people";
import { productImport } from "./entities/products";
import { categoryImport, collectionImport, subcategoryImport } from "./entities/taxonomy";
import { runImport } from "./run";
import { buildTemplate, CSV_CONTENT_TYPE, detectFormat, MAX_FILE_BYTES, MAX_ROWS, templateFileName, XLSX_CONTENT_TYPE } from "./spreadsheet";
import type { AnyImport } from "./types";

/**
 * BULK IMPORT
 * ------------------------------------------------------------------
 * Staff download a filled-in template, complete it in Excel and upload it.
 * The upload is previewed first — every problem is listed by row and column,
 * nothing is written — and only a clean file can be committed, in a single
 * transaction. Documents with line items (purchases, invoices, orders) are
 * deliberately not importable: a spreadsheet row can't describe them safely.
 */
export const importsRouter = Router();

const registry: AnyImport[] = [
  productImport,
  inventoryImport,
  customerImport,
  vendorImport,
  expenseImport,
  categoryImport,
  subcategoryImport,
  collectionImport,
  couponImport,
  metalRateImport,
];

const definitionOf = (req: Request) => {
  const definition = registry.find((entry) => entry.entity === String(req.params.entity ?? ""));
  if (!definition) throw notFound("That import isn't available.");
  return definition;
};

const mayUse = (req: Request, definition: AnyImport) => (definition.gate ?? [definition.permission]).some((permission: Permission) => can(req, permission));

/** Confidential columns are only offered to admins who may fill them in. */
const visibleColumns = (req: Request, definition: AnyImport) => definition.columns.filter((column) => !column.permission || can(req, column.permission));

const rowLimitOf = (definition: AnyImport) => Math.min(definition.rowLimit ?? MAX_ROWS, MAX_ROWS);

importsRouter.get("/imports", (req, res) => {
  res.json({
    items: registry
      .filter((definition) => mayUse(req, definition))
      .map((definition) => ({
        entity: definition.entity,
        label: definition.label,
        description: definition.description,
        permission: definition.permission,
        rowLimit: rowLimitOf(definition),
        columns: visibleColumns(req, definition).map((column) => ({
          key: column.key,
          label: column.label,
          required: Boolean(column.required),
          example: column.example,
          hint: column.hint,
        })),
      })),
  });
});

importsRouter.get("/imports/:entity/template", async (req, res) => {
  const definition = definitionOf(req);
  if (!mayUse(req, definition)) throw forbidden();
  const { format } = parse(z.object({ format: z.enum(["xlsx", "csv"]).default("xlsx") }), req.query);
  const file = await buildTemplate({ ...definition, columns: visibleColumns(req, definition) }, format);
  res.setHeader("Content-Type", format === "xlsx" ? XLSX_CONTENT_TYPE : CSV_CONTENT_TYPE);
  res.setHeader("Content-Disposition", `attachment; filename="${templateFileName(definition, format)}"`);
  res.send(file);
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

/** Multer's own errors are turned into messages that say what to do next. */
const uploadSpreadsheet: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      next(
        new AppError(
          "validation_error",
          error.code === "LIMIT_FILE_SIZE"
            ? `That file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB. Split it into smaller files and import them one after another.`
            : "Attach one file in the “file” field.",
        ),
      );
      return;
    }
    next(error);
  });
};

importsRouter.post("/imports/:entity", uploadSpreadsheet, async (req, res) => {
  const definition = definitionOf(req);
  if (!mayUse(req, definition)) throw forbidden();
  const { mode } = parse(z.object({ mode: z.enum(["preview", "commit"]).default("preview") }), req.query);
  if (!req.file) throw invalid({ file: "Choose an Excel (.xlsx) or CSV file to import." });

  const fileName = req.file.originalname.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "import.xlsx";
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (extension !== "xlsx" && extension !== "csv") throw new AppError("validation_error", "Upload an Excel file (.xlsx) or a CSV file (.csv).");

  const result = await runImport(definition, {
    mode,
    fileName,
    buffer: req.file.buffer,
    format: detectFormat(req.file.buffer, fileName),
    actor: actorOf(req),
    can: (permission) => can(req, permission),
  });
  res.status(result.status).json(result.body);
});
