import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The token has to be in place before the app (and its environment) is loaded.
vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "test-instagram-token");

const media = {
  data: [
    {
      id: "1",
      media_type: "IMAGE",
      media_product_type: "FEED",
      media_url: "https://scontent.cdninstagram.com/a.jpg",
      permalink: "https://www.instagram.com/p/AAA/",
      caption: "  New   bridal\nset  ",
    },
    {
      id: "2",
      media_type: "VIDEO",
      media_product_type: "REELS",
      media_url: "https://scontent.cdninstagram.com/b.mp4",
      thumbnail_url: "https://scontent.cdninstagram.com/b.jpg",
      permalink: "https://www.instagram.com/reel/BBB/",
    },
    {
      id: "3",
      media_type: "CAROUSEL_ALBUM",
      media_product_type: "FEED",
      media_url: "https://scontent.cdninstagram.com/c.jpg",
      permalink: "https://www.instagram.com/p/CCC/",
      caption: "x".repeat(300),
    },
    // No permalink → not shown.
    { id: "4", media_type: "IMAGE", media_url: "https://scontent.cdninstagram.com/d.jpg" },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const minutes = (count: number) => count * 60_000;

describe("Instagram feed", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let helpers: typeof import("./helpers");
  let schema: typeof import("@/db/schema");
  let ctx: Awaited<ReturnType<typeof import("./helpers").setupApp>>;

  const feed = () => ctx.api().get("/v1/content/instagram");
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const storedToken = async () => {
    const [row] = await ctx.connection.db.select().from(schema.settings).where(eq(schema.settings.key, "instagram_token"));
    return (row?.value as { token?: string } | undefined)?.token;
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.stubGlobal("fetch", fetchMock);
    helpers = await import("./helpers");
    schema = await import("@/db/schema");
    ctx = await helpers.setupApp();
  });

  afterAll(async () => {
    await ctx.connection.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("falls back to the posts from the admin panel while Instagram is unavailable", async () => {
    fetchMock.mockImplementation(async () => json({ error: { message: "Invalid OAuth access token", code: 190 } }, 400));
    const response = await feed();
    expect(response.status).toBe(200);
    expect(response.body.length).toBeGreaterThan(0);
    expect(response.body[0]).not.toHaveProperty("type");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the latest posts and reels once Instagram answers", async () => {
    advance(minutes(6));
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => json(media));

    const response = await feed();
    expect(response.body).toHaveLength(3);
    expect(response.body[0]).toEqual({
      id: "1",
      image: { url: "https://scontent.cdninstagram.com/a.jpg", alt: "New bridal set" },
      url: "https://www.instagram.com/p/AAA/",
      caption: "New bridal set",
      type: "post",
    });
    expect(response.body[1]).toMatchObject({ type: "reel", image: { url: "https://scontent.cdninstagram.com/b.jpg" }, url: "https://www.instagram.com/reel/BBB/" });
    expect(response.body[2].type).toBe("carousel");
    expect(response.body[2].caption).toHaveLength(140);
    expect(await storedToken()).toBe("test-instagram-token");

    // The stored token never leaves the server through the settings API.
    const token = await helpers.adminToken(ctx.app, "superadmin@example.com");
    const settings = await ctx.api().get("/v1/admin/settings").set("Authorization", `Bearer ${token}`);
    expect(settings.status).toBe(200);
    expect(JSON.stringify(settings.body)).not.toContain("test-instagram-token");
  });

  it("keeps showing the last posts when Instagram fails later", async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });

    advance(minutes(1));
    expect((await feed()).body).toHaveLength(3);
    expect(fetchMock).not.toHaveBeenCalled(); // still inside the 15-minute cache

    advance(minutes(16));
    expect((await feed()).body).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renews the token once it is a week old", async () => {
    advance(8 * 24 * minutes(60));
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/refresh_access_token")) return json({ access_token: "renewed-token", token_type: "bearer", expires_in: 5_184_000 });
      if (url.includes("access_token=renewed-token")) return json(media);
      return json({ error: { message: "Old token used" } }, 400);
    });

    expect((await feed()).body).toHaveLength(3);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/refresh_access_token"))).toBe(true);
    expect(await storedToken()).toBe("renewed-token");
  });
});
