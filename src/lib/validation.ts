import { z } from "zod";
import { AppError } from "./errors";
import { normalizeIndianMobile } from "./phone";

/** Customer-friendly default messages for common validation failures. */
z.config({
  customError: (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return issue.input === undefined || issue.input === null ? "This field is required." : "Please enter a valid value.";
      case "too_small":
        if (issue.origin === "string") return Number(issue.minimum) <= 1 ? "This field is required." : `Must be at least ${issue.minimum} characters.`;
        if (issue.origin === "array") return Number(issue.minimum) <= 1 ? "Add at least one item." : `Add at least ${issue.minimum} items.`;
        return `Must be at least ${issue.minimum}.`;
      case "too_big":
        if (issue.origin === "string") return `Must be ${issue.maximum} characters or fewer.`;
        if (issue.origin === "array") return `Add no more than ${issue.maximum} items.`;
        return `Must be ${issue.maximum} or less.`;
      case "invalid_format":
        return issue.format === "email" ? "Enter a valid email address." : "Please enter a valid value.";
      case "invalid_value":
        return "Please choose a valid option.";
      default:
        return undefined;
    }
  },
});

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_form";
    fieldErrors[key] ??= issue.message;
  }
  throw new AppError("validation_error", undefined, fieldErrors);
}

/* ------------------------------------------------------------------ */
/* Shared field schemas                                                */
/* ------------------------------------------------------------------ */

export const zText = (max = 200) => z.string().trim().min(1).max(max);
export const zOptionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((value) => (value ? value : null));

export const zEmail = z.string().trim().toLowerCase().pipe(z.email({ error: "Enter a valid email address." }));

export const zMobile = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const mobile = normalizeIndianMobile(value);
    if (!mobile) {
      ctx.addIssue({ code: "custom", message: "Enter a valid 10-digit mobile number." });
      return z.NEVER;
    }
    return mobile;
  });

export const zPassword = z
  .string()
  .min(8, { error: "Use at least 8 characters." })
  .max(72)
  .regex(/[A-Za-z]/, { error: "Include at least one letter." })
  .regex(/\d/, { error: "Include at least one number." });

export const zUuid = z.uuid({ error: "Please choose a valid option." });
export const zMoney = z.coerce.number().min(0).max(100_000_000);
export const zWeight = z.coerce.number().min(0).max(100_000);
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Enter a valid date." });
export const zBoolQuery = z.preprocess((value) => (value === "true" ? true : value === "false" ? false : value), z.boolean().optional());

export const zCsv = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (value) =>
      typeof value === "string"
        ? value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : value,
    z.array(item).optional(),
  );

export const zImage = z.object({
  url: z.string().trim().min(1).max(2000),
  alt: z.string().trim().max(300).default(""),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const zSeo = z
  .object({
    title: z.string().trim().max(160).optional(),
    description: z.string().trim().max(320).optional(),
    keywords: z.array(z.string().trim().max(60)).max(20).optional(),
  })
  .default({});

export const zPagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function paginated<T>(items: T[], total: number, page: number, pageSize: number) {
  return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
