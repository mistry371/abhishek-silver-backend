import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, normalize, resolve, sep } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/config/env";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * File storage: local disk in development, Supabase Storage in production.
 * - "media": public product/CMS imagery (public bucket).
 * - "private": receipts and attachments (private bucket, served only through authorised endpoints).
 */
export type Bucket = "media" | "private";

const LOCAL_ROOT = resolve(process.cwd(), "uploads");

const kinds = {
  image: { types: ["image/jpeg", "image/png", "image/webp", "image/avif"], maxBytes: 8 * 1024 * 1024 },
  video: { types: ["video/mp4", "video/webm"], maxBytes: 50 * 1024 * 1024 },
  document: { types: ["image/jpeg", "image/png", "image/webp", "application/pdf"], maxBytes: 10 * 1024 * 1024 },
} as const;
export type FileKind = keyof typeof kinds;

const extensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
};

/** Detects the real type from the file's leading bytes — never trust the browser's declared type. */
export function sniffType(buffer: Buffer): string | null {
  const hex = buffer.subarray(0, 12).toString("hex");
  const ascii = buffer.subarray(0, 12).toString("latin1");
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("89504e470d0a1a0a")) return "image/png";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (ascii.slice(4, 12) === "ftypavif" || ascii.slice(4, 12) === "ftypavis") return "image/avif";
  if (ascii.slice(4, 8) === "ftyp") return "video/mp4";
  if (hex.startsWith("1a45dfa3")) return "video/webm";
  if (ascii.startsWith("%PDF-")) return "application/pdf";
  return null;
}

export function validateFile(buffer: Buffer, kind: FileKind) {
  const type = sniffType(buffer);
  const rule = kinds[kind];
  if (!type || !(rule.types as readonly string[]).includes(type)) {
    throw new AppError("validation_error", `Unsupported file type. Allowed: ${rule.types.map((t) => extensions[t]).join(", ")}.`);
  }
  if (buffer.length > rule.maxBytes) {
    throw new AppError("validation_error", `That file is too large (maximum ${Math.round(rule.maxBytes / 1024 / 1024)} MB).`);
  }
  return type;
}

let supabase: SupabaseClient | null = null;
const client = () =>
  (supabase ??= createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } }));
const bucketName = (bucket: Bucket) => (bucket === "media" ? env.SUPABASE_MEDIA_BUCKET : env.SUPABASE_PRIVATE_BUCKET);

function localPath(bucket: Bucket, path: string) {
  const root = resolve(LOCAL_ROOT, bucket);
  const full = resolve(root, normalize(path));
  if (!full.startsWith(root + sep)) throw new AppError("not_found");
  return full;
}

export function publicUrl(path: string) {
  if (env.STORAGE_PROVIDER === "supabase") return client().storage.from(bucketName("media")).getPublicUrl(path).data.publicUrl;
  return `${env.PUBLIC_API_URL.replace(/\/$/, "")}/uploads/media/${path}`;
}

let bucketsReady: Promise<void> | null = null;

/** Creates missing Supabase buckets (media public, private documents private) so a fresh project needs no dashboard setup. */
export function ensureStorageBuckets() {
  if (env.STORAGE_PROVIDER !== "supabase") return Promise.resolve();
  bucketsReady ??= (async () => {
    for (const bucket of ["media", "private"] as const) {
      const name = bucketName(bucket);
      const isPublic = bucket === "media";
      const { data, error } = await client().storage.getBucket(name);
      if (data) {
        if (data.public !== isPublic) {
          const { error: updateError } = await client().storage.updateBucket(name, { public: isPublic });
          if (updateError) throw updateError;
          logger.info({ bucket: name, public: isPublic }, "Storage bucket visibility corrected");
        }
        continue;
      }
      if (error && !/not found/i.test(error.message)) throw error;
      const { error: createError } = await client().storage.createBucket(name, { public: isPublic });
      if (createError && !/already exists/i.test(createError.message)) throw createError;
      logger.info({ bucket: name, public: isPublic }, "Storage bucket created");
    }
  })().catch((error: unknown) => {
    bucketsReady = null;
    throw error;
  });
  return bucketsReady;
}

/** Diagnostics: whether each bucket exists and its visibility. */
export async function describeStorageBuckets() {
  const report: Record<string, string> = {};
  for (const bucket of ["media", "private"] as const) {
    const name = bucketName(bucket);
    const { data, error } = await client().storage.getBucket(name);
    report[name] = data ? (data.public ? "ok (public)" : "ok (private)") : `missing${error ? ` — ${error.message}` : ""}`;
  }
  return report;
}

export async function storeFile({ bucket, buffer, type, folder }: { bucket: Bucket; buffer: Buffer; type: string; folder: string }) {
  const now = new Date();
  const path = `${folder}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}${extensions[type] ?? ""}`;

  if (env.STORAGE_PROVIDER === "supabase") {
    try {
      await ensureStorageBuckets();
      const { error } = await client().storage.from(bucketName(bucket)).upload(path, buffer, { contentType: type, upsert: false });
      if (error) throw error;
    } catch (error) {
      logger.error({ err: error, bucket: bucketName(bucket) }, "Supabase storage upload failed");
      throw new AppError("server_error", "The file couldn't be uploaded. Please try again.");
    }
  } else {
    const full = localPath(bucket, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, buffer);
  }
  return { path, url: bucket === "media" ? publicUrl(path) : null };
}

/** Private files: local bytes, or a short-lived signed URL on Supabase. */
export async function readPrivateFile(path: string): Promise<{ buffer: Buffer } | { signedUrl: string }> {
  if (env.STORAGE_PROVIDER === "supabase") {
    const { data, error } = await client().storage.from(bucketName("private")).createSignedUrl(path, 60);
    if (error || !data) throw new AppError("not_found");
    return { signedUrl: data.signedUrl };
  }
  try {
    return { buffer: await readFile(localPath("private", path)) };
  } catch {
    throw new AppError("not_found");
  }
}

export async function deleteFile(bucket: Bucket, path: string) {
  if (env.STORAGE_PROVIDER === "supabase") {
    await client().storage.from(bucketName(bucket)).remove([path]);
    return;
  }
  await rm(localPath(bucket, path), { force: true });
}
