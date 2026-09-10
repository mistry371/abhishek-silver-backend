import { z } from "zod";

/** Treat empty strings from .env files as "not set". */
const optional = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    API_PREFIX: z.string().default("/v1"),
    CORS_ORIGINS: z.string().default("http://localhost:3000"),
    PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
    /** Public base URL of this API — used for links to locally stored media. */
    PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
    /** Optional storefront on-demand revalidation endpoint + shared secret, so admin edits appear immediately. */
    STOREFRONT_REVALIDATE_URL: optional,
    STOREFRONT_REVALIDATE_SECRET: optional,
    TRUST_PROXY: z.preprocess((v) => v === "true" || v === "1", z.boolean()).default(false),

    DATABASE_URL: optional,
    PGLITE_DATA_DIR: z.string().default(".pglite"),

    AUTH_PROVIDER: z.enum(["local", "supabase"]).default("local"),
    LOCAL_JWT_SECRET: optional,
    SUPABASE_URL: optional,
    SUPABASE_ANON_KEY: optional,
    SUPABASE_SERVICE_ROLE_KEY: optional,
    SUPABASE_JWT_SECRET: optional,

    STORAGE_PROVIDER: z.enum(["local", "supabase"]).default("local"),
    SUPABASE_MEDIA_BUCKET: z.string().default("media"),
    SUPABASE_PRIVATE_BUCKET: z.string().default("private-documents"),

    PAYMENT_PROVIDER: z.enum(["demo", "razorpay"]).default("demo"),
    RAZORPAY_KEY_ID: optional,
    RAZORPAY_KEY_SECRET: optional,
    RAZORPAY_WEBHOOK_SECRET: optional,

    SEED_ADMIN_PASSWORD: optional,
  })
  .superRefine((env, ctx) => {
    const require = (condition: unknown, path: string, message: string) => {
      if (!condition) ctx.addIssue({ code: "custom", path: [path], message });
    };

    if (env.NODE_ENV === "production") {
      require(env.DATABASE_URL, "DATABASE_URL", "is required in production (embedded PGlite is for local development only)");
      require(env.AUTH_PROVIDER === "supabase", "AUTH_PROVIDER", "must be 'supabase' in production");
      require(env.PAYMENT_PROVIDER === "razorpay", "PAYMENT_PROVIDER", "must be 'razorpay' in production");
    }
    if (env.AUTH_PROVIDER === "local") {
      require(env.LOCAL_JWT_SECRET && env.LOCAL_JWT_SECRET.length >= 32, "LOCAL_JWT_SECRET", "must be at least 32 characters");
    }
    if (env.AUTH_PROVIDER === "supabase" || env.STORAGE_PROVIDER === "supabase") {
      require(env.SUPABASE_URL, "SUPABASE_URL", "is required for Supabase auth/storage");
      require(env.SUPABASE_ANON_KEY, "SUPABASE_ANON_KEY", "is required for Supabase auth/storage");
      require(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY", "is required for Supabase auth/storage");
    }
    if (env.PAYMENT_PROVIDER === "razorpay") {
      require(env.RAZORPAY_KEY_ID, "RAZORPAY_KEY_ID", "is required for Razorpay");
      require(env.RAZORPAY_KEY_SECRET, "RAZORPAY_KEY_SECRET", "is required for Razorpay");
    }
  });

export type Env = z.infer<typeof schema>;

function load(): Env {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    // Never print values — only which settings are missing or invalid.
    console.error(`Invalid environment configuration:\n${details}`);
    process.exit(1);
  }
  return result.data;
}

export const env = load();

export const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
