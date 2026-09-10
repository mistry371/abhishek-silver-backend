import "@/lib/validation";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { sql } from "drizzle-orm";
import { corsOrigins, env } from "@/config/env";
import { db } from "@/db/client";
import "@/http/context";
import { errorHandler, noStore, notFoundHandler } from "@/http/middleware";
import { logger } from "@/lib/logger";
import { accountRouter } from "@/modules/account/routes";
import { adminRouter } from "@/modules/admin";
import { cartRouter } from "@/modules/cart/routes";
import { catalogRouter } from "@/modules/catalog/routes";
import { contentRouter } from "@/modules/content/routes";
import { leadsRouter } from "@/modules/leads/routes";
import { ordersRouter, webhooksRouter } from "@/modules/orders/routes";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY ? 1 : false);

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || corsOrigins.includes(origin)),
      credentials: true,
      maxAge: 600,
    }),
  );
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === "/health" },
      customLogLevel: (_req, res, error) => (error || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
    }),
  );

  app.get("/health", async (_req, res) => {
    await db().execute(sql`select 1`);
    res.json({ status: "ok" });
  });

  const prefix = env.API_PREFIX;

  // Webhooks verify signatures over the raw bytes, so they bypass the JSON parser.
  app.use(`${prefix}/webhooks`, express.raw({ type: "application/json", limit: "1mb" }), webhooksRouter);
  app.use(express.json({ limit: "1mb" }));

  if (env.STORAGE_PROVIDER === "local") {
    // Public media only. Private documents (receipts, attachments) are served through authorised admin endpoints.
    app.use("/uploads/media", express.static("uploads/media", { index: false, maxAge: "7d", fallthrough: false }));
  }

  app.use(prefix, catalogRouter, cartRouter, ordersRouter, accountRouter, leadsRouter, contentRouter);
  app.use(`${prefix}/admin`, noStore, adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
