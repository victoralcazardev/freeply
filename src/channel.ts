import type { Env } from "./index";
import { constantTimeEqual } from "./auth";
import { getAccountToken, listAccounts } from "./db";
import { publishReel, type PublishResult } from "./instagram";

/**
 * Channel endpoints for the Kuff app.
 *
 * Two jobs, both of which exist so the phone never has to hold an Instagram
 * token: hand it a picture of how the channel talks and what has worked
 * (`GET /channel/context`), and post on its behalf (`POST /channel/publish`).
 *
 * Auth is its own secret (CHANNEL_TOKEN), never the dashboard password and
 * never MCP_STATS_TOKEN. This one ships inside an app binary — assume it is
 * extractable — so it must not open anything but these two routes, and it is
 * rotated here rather than in the app.
 */

function authorized(request: Request, env: Env): boolean {
  if (!env.CHANNEL_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice(7), env.CHANNEL_TOKEN);
}

export async function handleChannel(
  request: Request,
  path: string,
  env: Env,
): Promise<Response> {
  // Unset means the feature is off, and off should look like it was never
  // built rather than like a locked door worth rattling.
  if (!env.CHANNEL_TOKEN) return new Response("not found", { status: 404 });
  if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });

  if (path === "/channel/accounts" && request.method === "GET") {
    const accounts = await listAccounts(env.DB);
    return jsonResponse(accounts.map((a) => ({ igUserId: a.igUserId, username: a.username })));
  }
  if (path === "/channel/context" && request.method === "GET") {
    // The app asks for one account's pack at a time. Omitted means the first
    // account, matching the publish default — never a blend of all of them.
    const requested = new URL(request.url).searchParams.get("account") ?? undefined;
    return jsonResponse(await buildContext(env, requested));
  }
  if (path === "/channel/brand" && request.method === "PUT") {
    return putBrand(request, env);
  }
  if (path === "/channel/upload" && request.method === "POST") {
    return handleUpload(request, env);
  }
  if (path === "/channel/publish" && request.method === "POST") {
    return handlePublish(request, env);
  }
  return new Response("not found", { status: 404 });
}

/**
 * Take the video and park it somewhere Meta can fetch it.
 *
 * This exists because Instagram's container create takes a **URL**, not bytes —
 * Meta downloads the file itself. A video sitting in an app's sandbox is not
 * reachable, so it has to land in R2 first, where `/files/<key>` already serves
 * it publicly over https.
 *
 * The alternative is the resumable upload endpoint (rupload.facebook.com),
 * which takes bytes directly. It is the better answer the day a reel is large
 * enough that pushing it through the Worker twice starts to hurt; today the
 * bucket is already there and already served.
 */
/**
 * What the caller may declare the upload to be. Anything else becomes mp4.
 *
 * The stored type is handed straight back by `/files/<key>`
 * (`writeHttpMetadata`), which serves from the dashboard's own origin — so a
 * caller free to name `text/html` could put a scripted page on the origin that
 * holds the session cookie. The name sanitizer doesn't stop that: it controls
 * the key, not what the response claims the bytes are. An allowlist does.
 */
const UPLOAD_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

/**
 * Ceiling on one upload, and it is not R2's.
 *
 * A single `put()` takes 4.995 GiB, but the bytes have to reach the Worker
 * first, and Cloudflare caps an inbound request body at 100 MB on Free and Pro
 * — rejected at the edge with a 413 before any of this runs. Multipart upload
 * would not raise it, because the parts still arrive through that same request;
 * a reel past this has to go to R2 another way (`scripts/publish-media.sh` in
 * cash-builds). Checked here so the app gets a legible refusal rather than the
 * edge's, and so the number is written down somewhere.
 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (!env.MEDIA) {
    return jsonResponse({ error: "no media bucket is configured" }, 503);
  }
  if (!request.body) return jsonResponse({ error: "no body" }, 400);

  // R2 needs the length up front: `put()` given a stream whose size it cannot
  // know throws, and a chunked upload with no Content-Length is exactly that.
  // Unhandled, that throw became a 500 with nothing in it for the app to act on.
  const declared = Number(request.headers.get("content-length"));
  if (!Number.isInteger(declared) || declared <= 0) {
    return jsonResponse({ error: "content-length is required" }, 411);
  }
  if (declared > MAX_UPLOAD_BYTES) {
    return jsonResponse({ error: "video is larger than the worker can accept" }, 413);
  }

  const declaredType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const contentType = UPLOAD_TYPES.has(declaredType) ? declaredType : "video/mp4";
  // Named by the caller so a retry overwrites rather than accumulating, but
  // always under `outbox/` — the bucket also holds the published renders, and
  // an app upload must not be able to land on one of those.
  const requested = new URL(request.url).searchParams.get("name") ?? "";
  const safe = requested.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
  const key = `outbox/${safe || `reel-${Date.now()}.mp4`}`;

  try {
    await env.MEDIA.put(key, request.body, {
      httpMetadata: { contentType },
    });
  } catch (cause) {
    console.error(`upload of ${key} failed:`, cause);
    return jsonResponse({ error: "the upload could not be stored" }, 502);
  }

  const url = new URL(request.url);
  return jsonResponse({ key, url: `${url.origin}/files/${key}` });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Swift's `.iso8601` decoding strategy uses `ISO8601DateFormatter` with default
 * options, which **rejects fractional seconds** — and `Date.toISOString()`
 * always emits them. Left alone, every pack the app fetched failed to decode at
 * `generatedAt`, and the failure surfaced as "couldn't reach your channel"
 * rather than as a format mismatch.
 */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// The brand half: written by hand, uploaded from cash-builds
// ---------------------------------------------------------------------------

/**
 * The part of the pack that no API knows: positioning, voice, and which format
 * each post was.
 *
 * Uploaded rather than derived because it lives in prose — PLAYBOOK.md and
 * CHANNEL.md — and no amount of reading `post_stats` will tell you that a
 * walkie-talkie is distinct from a vlog. `scripts/push-context.sh` in
 * cash-builds is what puts it here.
 */
interface Brand {
  handle: string;
  /**
   * Which account this voice belongs to. Omitted keeps the legacy single-brand
   * behaviour, where the one brand served whichever account asked.
   */
  igUserId?: string;
  positioning: string;
  voice: string[];
  avoid: string[];
  formats: Array<{ name: string; definition: string }>;
  /** mediaId → format name, so reference posts can say what they were. */
  postFormats: Record<string, string>;
}

/** One account's voice lives under `channel_brand:<igUserId>`. */
function brandKey(igUserId: string): string {
  return `channel_brand:${igUserId}`;
}

/** The pre-accounts single-brand key. Kept byte-for-byte for legacy reads. */
const LEGACY_BRAND_KEY = "channel_brand";

function parseBrand(value: string | null): Brand | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Brand;
  } catch {
    return null;
  }
}

async function putBrand(request: Request, env: Env): Promise<Response> {
  let brand: Brand;
  try {
    brand = (await request.json()) as Brand;
  } catch {
    return jsonResponse({ error: "body is not JSON" }, 400);
  }
  if (!brand.handle) return jsonResponse({ error: "handle is required" }, 400);

  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(brand.igUserId ? brandKey(brand.igUserId) : LEGACY_BRAND_KEY, JSON.stringify(brand), Date.now())
    .run();

  return jsonResponse({ ok: true });
}

/**
 * The brand for one account, if there is one.
 *
 * Per-account brands are read first. A legacy single-account upload — keyed
 * just `channel_brand` before accounts existed — is still honoured, but only
 * when its `handle` matches the account, so a voice written for one account
 * never leaks into another account's pack.
 */
async function loadBrand(
  env: Env,
  account: { igUserId: string; username: string },
): Promise<Brand | null> {
  const perAccount = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`)
    .bind(brandKey(account.igUserId))
    .first<{ value: string }>();
  const brand = parseBrand(perAccount?.value ?? null);
  if (brand) return brand;

  const legacy = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`)
    .bind(LEGACY_BRAND_KEY)
    .first<{ value: string }>();
  const legacyBrand = parseBrand(legacy?.value ?? null);
  if (legacyBrand && legacyBrand.handle.toLowerCase() === account.username.toLowerCase()) {
    return legacyBrand;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The evidence half: read from the stats cache
// ---------------------------------------------------------------------------

interface MediaRow {
  media_id: string;
  caption: string | null;
  permalink: string | null;
  posted_at: number | null;
  media_type: string | null;
  thumbnail_url: string | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  views: number | null;
  skip_rate: number | null;
  avg_watch_ms: number | null;
  saved: number | null;
  shares: number | null;
}

/** How many past posts to carry. The app ranks and trims further. */
const REFERENCE_LIMIT = 40;

/**
 * Assemble the pack for one account.
 *
 * Read-only against D1 — this must never write to the stats cache, which the
 * cron owns.
 *
 * The account filter is the whole point of the per-account split: with two
 * Instagram accounts connected, an unfiltered read would mix both accounts'
 * posts, hashtag findings and medians into one pack — which is what the app was
 * showing when this was written. Defaulting to the first account (like publish)
 * means the old app build stops seeing the blend even before it learns to ask
 * for a specific account.
 */
async function buildContext(env: Env, igUserId?: string): Promise<unknown> {
  const accounts = await listAccounts(env.DB);
  const account = accounts.find((a) => a.igUserId === igUserId) ?? accounts[0];

  // No connected account at all. Serve an evidence-free pack rather than
  // failing, exactly as a brand-new install expects.
  if (!account) {
    return {
      handle: "",
      igUserId: null,
      positioning: "",
      voice: [],
      avoid: [],
      formats: [],
      referencePosts: [],
      hashtagFindings: [],
      medianViews: null,
      generatedAt: isoSeconds(Date.now()),
    };
  }

  const brand = await loadBrand(env, account);
  const handle = brand?.handle ?? account.username;

  const { results } = await env.DB.prepare(
    `SELECT m.media_id, m.caption, m.permalink, m.posted_at,
            COALESCE(s.media_type, m.media_type) AS media_type,
            COALESCE(s.thumbnail_url, m.thumbnail_url) AS thumbnail_url,
            s.reach, s.likes, s.comments, s.views, s.skip_rate,
            s.avg_watch_ms, s.saved, s.shares
     FROM account_media m
     LEFT JOIN post_stats s ON s.media_id = m.media_id
     WHERE m.ig_user_id = ?
     ORDER BY m.posted_at DESC
     LIMIT ?`,
  )
    .bind(account.igUserId, REFERENCE_LIMIT)
    .all<MediaRow>();

  const rows = results ?? [];
  const viewCounts = rows
    .map((r) => r.views)
    .filter((v): v is number => typeof v === "number");
  const channelMedian = median(viewCounts);

  const referencePosts = rows.map((row) => ({
    id: shortcodeOf(row.permalink) ?? row.media_id,
    format: brand?.postFormats?.[row.media_id] ?? null,
    // Hashtags are stripped out of the caption body. The app carries them
    // separately, and leaving them inline would teach the model to write
    // captions with tags baked in — which every platform then positions wrong.
    caption: captionWithoutTags(row.caption ?? ""),
    hashtags: hashtagsIn(row.caption ?? ""),
    views: row.views,
    skipRate: row.skip_rate,
    watch: row.avg_watch_ms == null ? null : row.avg_watch_ms / 1000,
    likes: row.likes,
    comments: row.comments,
    reach: row.reach,
    saves: row.saved,
    shares: row.shares,
    permalink: row.permalink,
    mediaType: row.media_type,
    mediaURL: row.thumbnail_url,
    thumbnailURL: row.thumbnail_url,
    status: null,
    postedAt: row.posted_at ? isoSeconds(row.posted_at) : null,
  }));

  return {
    handle,
    igUserId: account.igUserId,
    positioning: brand?.positioning ?? "",
    voice: brand?.voice ?? [],
    avoid: brand?.avoid ?? [],
    formats: (brand?.formats ?? []).map((f) => {
      const ofFormat = rows.filter((r) => brand?.postFormats?.[r.media_id] === f.name);
      const views = ofFormat.map((r) => r.views).filter((v): v is number => typeof v === "number");
      return {
        name: f.name,
        definition: f.definition,
        medianViews: median(views),
        postCount: ofFormat.length,
      };
    }),
    referencePosts,
    hashtagFindings: hashtagFindings(rows, channelMedian),
    medianViews: channelMedian,
    generatedAt: isoSeconds(Date.now()),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

const HASHTAG_PATTERN = /#([\p{L}\p{N}_]+)/gu;

function hashtagsIn(caption: string): string[] {
  const found = new Set<string>();
  for (const match of caption.matchAll(HASHTAG_PATTERN)) {
    found.add(match[1].toLowerCase());
  }
  return [...found];
}

function captionWithoutTags(caption: string): string {
  return caption.replace(HASHTAG_PATTERN, "").replace(/\s+/g, " ").trim();
}

/** Below this a tag's ratio is one video's variance, not a finding. */
const MIN_POSTS_FOR_A_FINDING = 3;

/**
 * Correlate each hashtag against the channel median.
 *
 * **This is inference, not attribution.** Instagram publishes no per-hashtag
 * breakdown — there is no reach-from-hashtags metric at media level and no
 * public hashtag-search endpoint — so the only thing available is "posts that
 * carried this tag did N% better than the median", which cannot separate the
 * tag from the video that carried it. `postCount` travels with every finding so
 * the app can say so, and the floor here keeps single-post tags out entirely:
 * on an account where one post went 20×, every tag it carried would otherwise
 * come back looking like a strategy.
 */
function hashtagFindings(rows: MediaRow[], channelMedian: number | null) {
  const byTag = new Map<string, number[]>();
  for (const row of rows) {
    if (typeof row.views !== "number") continue;
    for (const tag of hashtagsIn(row.caption ?? "")) {
      const list = byTag.get(tag) ?? [];
      list.push(row.views);
      byTag.set(tag, list);
    }
  }

  const findings = [];
  for (const [tag, views] of byTag) {
    if (views.length < MIN_POSTS_FOR_A_FINDING) continue;
    const tagMedian = median(views);
    findings.push({
      tag,
      postCount: views.length,
      medianViews: tagMedian,
      lift:
        channelMedian && channelMedian > 0 && tagMedian !== null
          ? Number((tagMedian / channelMedian).toFixed(2))
          : null,
    });
  }
  return findings.sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));
}

/** `.../reel/DbqRhj-p19Q/` → `DbqRhj-p19Q`. Short enough to carry in a prompt. */
function shortcodeOf(permalink: string | null): string | null {
  if (!permalink) return null;
  const match = permalink.match(/\/(?:reel|p|tv)\/([^/?]+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

interface PublishBody {
  /** Publicly reachable URL Meta will fetch the video from. */
  videoUrl: string;
  caption: string;
  /** Which connected account. Omitted means the only one. */
  igUserId?: string;
}

async function handlePublish(request: Request, env: Env): Promise<Response> {
  let body: PublishBody;
  try {
    body = (await request.json()) as PublishBody;
  } catch {
    return jsonResponse({ error: "body is not JSON" }, 400);
  }

  if (!body.videoUrl) return jsonResponse({ error: "videoUrl is required" }, 400);
  // Meta fetches this itself, so it has to be reachable from the internet and
  // it has to be https — an http URL is refused by the container create with a
  // message that names neither.
  let parsed: URL;
  try {
    parsed = new URL(body.videoUrl);
  } catch {
    return jsonResponse({ error: "videoUrl is not a URL" }, 400);
  }
  if (parsed.protocol !== "https:") {
    return jsonResponse({ error: "videoUrl must be https" }, 400);
  }

  const accounts = await listAccounts(env.DB);
  const igUserId = body.igUserId ?? accounts[0]?.igUserId;
  if (!igUserId) return jsonResponse({ error: "no connected account" }, 409);

  const token = await getAccountToken(env.DB, env.ENCRYPTION_KEY, igUserId);
  if (!token) return jsonResponse({ error: "account has no usable token" }, 409);

  const result: PublishResult = await publishReel(token, {
    videoUrl: body.videoUrl,
    caption: body.caption ?? "",
  });

  if (!result.ok) return jsonResponse({ error: result.error }, 502);
  return jsonResponse({ mediaId: result.mediaId, permalink: result.permalink });
}
