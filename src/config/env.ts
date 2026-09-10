import { z } from "zod";

const WRAPPERS: Record<string, string> = { '"': '"', "'": "'", "<": ">" };

/** Trims whitespace and one pair of wrapping quotes or <angle brackets> copied from templates. Empty means "not set". */
function clean(value: unknown) {
  if (typeof value !== "string") return value;
  let text = value.trim();
  const close = WRAPPERS[text[0] ?? ""];
  if (close && text.length >= 2 && text.endsWith(close)) text = text.slice(1, -1).trim();
  return text === "" ? undefined : text;
}

/**
 * Accepts the usual paste mistakes for the project URL — no scheme, the db. host, an API path,
 * a dashboard link or a Postgres connection string — and returns https://<project-ref>.supabase.co.
 */
function normalizeSupabaseUrl(value: unknown) {
  const text = clean(value);
  if (typeof text !== "string") return text;
  const ref = /(?:^|\/\/|db\.|postgres\.|project\/)([a-z0-9]{20})(?=\.supabase\.co|[:@/]|$)/i.exec(text)?.[1];
  return ref ? `https://${ref.toLowerCase()}.supabase.co` : text.replace(/\/+$/, "");
}

/** API keys never contain whitespace: drops spaces/line breaks and a pasted "NAME=" or "Bearer " prefix. */
function cleanKey(value: unknown) {
  const text = clean(value);
  if (typeof text !== "string") return text;
  const key = clean(text.replace(/^(?:[A-Z_]+=|Bearer\s+)/, ""));
  return typeof key === "string" ? key.replace(/\s+/g, "") : key;
}

const optional = z.preprocess(clean, z.string().optional());
const optionalKey = z.preprocess(cleanKey, z.string().optional());

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
    SUPABASE_URL: z.preprocess(normalizeSupabaseUrl, z.string().optional()),
    SUPABASE_ANON_KEY: optionalKey,
    SUPABASE_SERVICE_ROLE_KEY: optionalKey,
    SUPABASE_JWT_SECRET: optional,

    STORAGE_PROVIDER: z.enum(["local", "supabase"]).default("local"),
    SUPABASE_MEDIA_BUCKET: z.string().default("media"),
    SUPABASE_PRIVATE_BUCKET: z.string().default("private-documents"),

    /** "none" launches the site without online payments (customers enquire / call instead). */
    PAYMENT_PROVIDER: z.enum(["demo", "razorpay", "none"]).default("demo"),
    RAZORPAY_KEY_ID: optional,
    RAZORPAY_KEY_SECRET: optional,
    RAZORPAY_WEBHOOK_SECRET: optional,

    /** Hosted deploys: apply migrations and essential data (roles, settings, store content) on every start. */
    MIGRATE_ON_START: z.preprocess((v) => v === "true" || v === "1", z.boolean()).default(false),
    /** Creates the first Super Admin on start when no admin exists yet. Ignored afterwards. */
    INITIAL_ADMIN_EMAIL: optional,
    INITIAL_ADMIN_NAME: optional,
    INITIAL_ADMIN_PASSWORD: optional,

    SEED_ADMIN_PASSWORD: optional,
  })
  .superRefine((env, ctx) => {
    const require = (condition: unknown, path: string, message: string) => {
      if (!condition) ctx.addIssue({ code: "custom", path: [path], message });
    };

    if (env.NODE_ENV === "production") {
      require(env.DATABASE_URL, "DATABASE_URL", "is required in production (embedded PGlite is for local development only)");
      require(env.AUTH_PROVIDER === "supabase", "AUTH_PROVIDER", "must be 'supabase' in production");
      require(env.PAYMENT_PROVIDER !== "demo", "PAYMENT_PROVIDER", "must be 'razorpay' (or 'none' to launch without online payments) in production");
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
