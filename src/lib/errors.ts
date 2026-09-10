/**
 * Error contract shared with the storefront (`src/types/common.ts → ApiErrorShape`)
 * plus `forbidden` and `conflict`, which only admin endpoints return.
 * Messages are safe to show to end users — never include internals.
 */
export type ErrorCode =
  | "not_found"
  | "unauthorized"
  | "session_expired"
  | "forbidden"
  | "validation_error"
  | "conflict"
  | "out_of_stock"
  | "coupon_invalid"
  | "payment_failed"
  | "rate_limited"
  | "server_error";

const statusByCode: Record<ErrorCode, number> = {
  not_found: 404,
  unauthorized: 401,
  session_expired: 401,
  forbidden: 403,
  validation_error: 422,
  conflict: 409,
  out_of_stock: 409,
  coupon_invalid: 422,
  payment_failed: 402,
  rate_limited: 429,
  server_error: 500,
};

const defaultMessages: Record<ErrorCode, string> = {
  not_found: "We couldn't find what you were looking for.",
  unauthorized: "Please sign in to continue.",
  session_expired: "Your session has expired. Please sign in again.",
  forbidden: "You don't have permission to do that.",
  validation_error: "Please review the highlighted fields.",
  conflict: "This record was changed by someone else. Refresh and try again.",
  out_of_stock: "This piece is currently unavailable.",
  coupon_invalid: "This coupon code isn't valid for your order.",
  payment_failed: "Your payment couldn't be completed. Please try again or choose another method.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  server_error: "Something went wrong on our side. Please try again shortly.",
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fieldErrors?: Record<string, string>;

  constructor(code: ErrorCode, message?: string, fieldErrors?: Record<string, string>) {
    super(message || defaultMessages[code]);
    this.name = "AppError";
    this.code = code;
    this.status = statusByCode[code];
    this.fieldErrors = fieldErrors;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.fieldErrors ? { fieldErrors: this.fieldErrors } : {}) };
  }
}

export const notFound = (message?: string) => new AppError("not_found", message);
export const unauthorized = (message?: string) => new AppError("unauthorized", message);
export const forbidden = (message?: string) => new AppError("forbidden", message);
export const conflict = (message?: string) => new AppError("conflict", message);
export const invalid = (fieldErrors: Record<string, string>, message?: string) => new AppError("validation_error", message, fieldErrors);
export const badRequest = (message: string) => new AppError("validation_error", message);
