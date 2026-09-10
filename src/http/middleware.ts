import type { ErrorRequestHandler, Request, RequestHandler } from "express";
import multer from "multer";
import { env } from "@/config/env";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Fixed-window, in-memory rate limiter for sensitive endpoints (auth, OTP,
 * enquiries). For multiple API instances, replace with a shared store.
 */
export function rateLimit({ windowMs, max, name }: { windowMs: number; max: number; name: string }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    if (env.NODE_ENV === "test") return next();
    const now = Date.now();
    const key = `${name}:${req.ip}`;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 50_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    if (entry.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      throw new AppError("rate_limited");
    }
    next();
  };
}

/** Admin API responses contain confidential data — never cache them. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

export const notFoundHandler: RequestHandler = () => {
  throw new AppError("not_found");
};

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

export const errorHandler: ErrorRequestHandler = (error: unknown, req: Request, res, _next) => {
  void _next;
  let appError: AppError;

  if (error instanceof AppError) {
    appError = error;
  } else if (error instanceof multer.MulterError) {
    appError = new AppError(
      "validation_error",
      error.code === "LIMIT_FILE_SIZE" ? "That file is too large." : "Please check the attached files.",
    );
  } else if ((error as BodyParserError)?.type === "entity.parse.failed") {
    appError = new AppError("validation_error", "The request body is not valid JSON.");
  } else if ((error as BodyParserError)?.type === "entity.too.large") {
    appError = new AppError("validation_error", "The request is too large.");
  } else {
    logger.error({ err: error, method: req.method, url: req.originalUrl }, "Unhandled error");
    appError = new AppError("server_error");
  }

  if (appError.status >= 500 && error instanceof AppError) {
    logger.error({ code: appError.code, method: req.method, url: req.originalUrl }, "Server error");
  }
  if (res.headersSent) return;
  res.status(appError.status).json(appError.toJSON());
};
