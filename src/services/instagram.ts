import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "@/config/env";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { logger } from "@/lib/logger";

/**
 * INSTAGRAM FEED
 * ------------------------------------------------------------------
 * The homepage shows the business's latest posts and reels, read through
 * Instagram's official API (Instagram API with Instagram Login) using the
 * long-lived token in INSTAGRAM_ACCESS_TOKEN.
 * - Posts are cached for 15 minutes, so Instagram is asked at most four times an hour.
 * - If Instagram can't be reached the last good posts keep showing; with none yet,
 *   the caller falls back to the posts managed in Admin → Content → Instagram.
 * - Long-lived tokens expire after 60 days, so the token is renewed weekly and the
 *   renewed copy kept in a private settings row (the settings API never lists it).
 *   Pasting a new token into the environment replaces the stored copy.
 */

const GRAPH = "https://graph.instagram.com";
const TOKEN_SETTING = "instagram_token";
const FIELDS = "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp";
const POST_LIMIT = 12;
const CACHE_MS = 15 * 60_000;
const RETRY_MS = 5 * 60_000;
const RENEW_AFTER_MS = 7 * 24 * 60 * 60_000;
const TIMEOUT_MS = 5_000;

export interface InstagramFeedPost {
  id: string;
  image: { url: string; alt: string };
  url: string;
  caption?: string;
  type: "post" | "reel" | "video" | "carousel";
}

interface RawMedia {
  id: string;
  caption?: string;
  media_type?: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
}

interface StoredToken {
  token: string;
  /** Fingerprint of the environment token this copy descends from. */
  source: string;
  renewedAt: string;
}

let cache: { at: number; posts: InstagramFeedPost[] } | null = null;
let retryAt = 0;
let lastProblem: string | null = null;
let pending: Promise<InstagramFeedPost[] | null> | null = null;

const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);

/** Instagram's error text never contains the token, so it is safe to log and report. */
async function readJson(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: number }; [key: string]: unknown };
  if (!response.ok) {
    const error = body.error;
    throw new Error(error?.message ? `${error.message}${error.code ? ` (code ${error.code})` : ""}` : `HTTP ${response.status}`);
  }
  return body;
}

async function storeToken(value: StoredToken) {
  await db()
    .insert(settings)
    .values({ key: TOKEN_SETTING, value: { ...value }, updatedByName: "Instagram token renewal" })
    .onConflictDoUpdate({ target: settings.key, set: { value: { ...value }, updatedByName: "Instagram token renewal", updatedAt: new Date() } });
}

async function renewToken(token: string) {
  const response = await fetch(`${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await readJson(response);
  if (typeof body.access_token !== "string" || !body.access_token) throw new Error("Instagram returned no renewed token");
  return body.access_token;
}

/** The newest usable token: a renewed copy of the configured one, renewed again once it is a week old. */
async function currentToken(configured: string) {
  const source = fingerprint(configured);
  const [row] = await db().select().from(settings).where(eq(settings.key, TOKEN_SETTING)).limit(1);
  let stored = row?.value as unknown as StoredToken | undefined;
  if (!stored?.token || stored.source !== source) {
    stored = { token: configured, source, renewedAt: new Date().toISOString() };
    await storeToken(stored);
  }
  if (Date.now() - Date.parse(stored.renewedAt) > RENEW_AFTER_MS) {
    try {
      stored = { token: await renewToken(stored.token), source, renewedAt: new Date().toISOString() };
      await storeToken(stored);
      logger.info("Instagram access token renewed");
    } catch (error) {
      // The current token keeps working until it expires; renewal is retried on the next refresh.
      logger.warn({ reason: error instanceof Error ? error.message : String(error) }, "Instagram token renewal failed");
    }
  }
  return stored.token;
}

function toPost(item: RawMedia): InstagramFeedPost | null {
  const video = item.media_type === "VIDEO";
  const image = video ? item.thumbnail_url : item.media_url;
  if (!image || !item.permalink) return null;
  const text = item.caption?.replace(/\s+/g, " ").trim();
  const caption = text && text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text;
  return {
    id: item.id,
    image: { url: image, alt: caption || "Instagram post" },
    url: item.permalink,
    ...(caption ? { caption } : {}),
    type: item.media_product_type === "REELS" ? "reel" : video ? "video" : item.media_type === "CAROUSEL_ALBUM" ? "carousel" : "post",
  };
}

async function loadPosts(configured: string) {
  const token = await currentToken(configured);
  const response = await fetch(`${GRAPH}/me/media?fields=${FIELDS}&limit=${POST_LIMIT}&access_token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await readJson(response);
  const items = Array.isArray(body.data) ? (body.data as RawMedia[]) : [];
  return items.map(toPost).filter((post): post is InstagramFeedPost => post !== null);
}

/**
 * Latest posts, newest first — or null when Instagram isn't configured or hasn't
 * answered yet, so the caller can show the admin-managed posts instead.
 */
export async function latestInstagramPosts(): Promise<InstagramFeedPost[] | null> {
  const configured = env.INSTAGRAM_ACCESS_TOKEN;
  if (!configured) return null;
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.posts;
  if (now < retryAt) return cache?.posts ?? null;

  pending ??= loadPosts(configured)
    .then((posts) => {
      cache = { at: Date.now(), posts };
      lastProblem = null;
      return posts;
    })
    .catch((error: unknown) => {
      lastProblem = error instanceof Error ? error.message : String(error);
      retryAt = Date.now() + RETRY_MS;
      logger.warn({ reason: lastProblem }, "Instagram feed unavailable — showing the last posts available");
      return cache?.posts ?? null;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Deployment diagnostics: whether the feed works, without revealing the token. */
export async function instagramStatus() {
  if (!env.INSTAGRAM_ACCESS_TOKEN) return "not configured — the homepage shows the posts from Admin → Content → Instagram";
  const posts = await latestInstagramPosts();
  if (lastProblem) return `error: ${lastProblem}${posts ? ` (showing ${posts.length} earlier posts)` : ""}`;
  return `ok — ${posts?.length ?? 0} latest posts`;
}
