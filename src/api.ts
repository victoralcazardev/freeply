import { constantTimeEqual } from "./auth";
import { type CampaignFields, saveCampaignWithLink } from "./campaign-save";
import * as db from "./db";
import type { Env } from "./index";
import { listCommentsPaged, listMediaPaged } from "./instagram";

/**
 * Bearer-token JSON API for tooling (see README "JSON API"). Off unless the
 * API_TOKEN secret is set. No cookies, no CORS.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const fail = (status: number, error: string, detail?: string) =>
  json(detail ? { error, detail } : { error }, status);

const invalid = (field: string, why: string) => fail(400, "invalid_field", `${field}: ${why}`);

const MAX_BYTES = 1000;
const bytes = (s: string) => new TextEncoder().encode(s).length;

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.API_TOKEN) return fail(404, "not_found");

  const supplied = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!constantTimeEqual(supplied, env.API_TOKEN)) return fail(401, "unauthorized");

  const { method } = request;
  const path = url.pathname;

  if (path === "/api/accounts" && method === "GET") {
    const accounts = await db.listAccounts(env.DB);
    return json({
      accounts: accounts.map((a) => ({
        ig_user_id: a.igUserId,
        username: a.username,
        needs_reconnect: a.needsReconnect,
      })),
    });
  }

  if (path === "/api/media" && method === "GET") return listMedia(env, url);
  if (path === "/api/comments" && method === "GET") return listComments(env, url);

  if (path === "/api/campaigns") {
    if (method === "GET") {
      const [campaigns, links, stats] = await Promise.all([
        db.listCampaigns(env.DB),
        db.listLinks(env.DB),
        db.campaignSendStats(env.DB),
      ]);
      const linkById = new Map(links.map((l) => [l.id, l]));
      return json({
        campaigns: campaigns.map((c) => present(c, c.linkId ? linkById.get(c.linkId) : null, stats)),
      });
    }
    if (method === "POST") return upsert(request, env, null);
  }

  const one = path.match(/^\/api\/campaigns\/([^/]+)$/);
  if (one) {
    let id: string;
    try {
      id = decodeURIComponent(one[1]);
    } catch {
      // A malformed escape can't name any campaign.
      return fail(404, "not_found");
    }
    if (method === "PATCH") {
      const existing = await db.getCampaign(env.DB, id);
      return existing ? upsert(request, env, existing) : fail(404, "not_found");
    }
    if (method === "DELETE") {
      if (!(await db.getCampaign(env.DB, id))) return fail(404, "not_found");
      await db.deleteCampaign(env.DB, id);
      return json({ deleted: id });
    }
  }

  return fail(404, "not_found");
}

function present(
  c: db.Campaign,
  link: db.Link | null | undefined,
  stats: Awaited<ReturnType<typeof db.campaignSendStats>>,
) {
  return {
    id: c.id,
    name: c.name,
    ig_user_id: c.igUserId,
    media_id: c.mediaId,
    keywords: c.keywords,
    match_mode: c.matchMode,
    dedupe_scope: c.dedupeScope,
    dm_message: c.dmMessage,
    public_reply: c.publicReply,
    link_url: link?.targetUrl ?? null,
    track_link: link?.tracked ?? true,
    active: c.active,
    created_at: c.createdAt,
    stats: stats.get(c.id) ?? { sent: 0, failed: 0, duplicate: 0, recovered: 0 },
    clicks: link?.clicks ?? 0,
  };
}

async function presentOne(env: Env, c: db.Campaign) {
  const [link, stats] = await Promise.all([
    c.linkId ? db.getLink(env.DB, c.linkId) : null,
    db.campaignSendStats(env.DB),
  ]);
  return present(c, link, stats);
}

/** POST (existing null) and PATCH share this; PATCH only touches supplied keys. */
async function upsert(request: Request, env: Env, existing: db.Campaign | null): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw 0;
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, "invalid_json");
  }

  const has = (k: string) => body[k] !== undefined;
  // POST requires these; PATCH inherits them from the stored campaign.
  const required = ["name", "ig_user_id", "keywords", "match_mode", "dm_message"];
  if (!existing) {
    for (const k of required) if (!has(k)) return invalid(k, "required");
  }

  const base: CampaignFields = existing ?? {
    igUserId: "",
    name: "",
    mediaId: null,
    keywords: [],
    matchMode: "whole_word",
    dedupeScope: "per_post",
    storyReplies: false,
    iceBreaker: null,
    dmMessage: "",
    publicReply: null,
  };
  const fields: CampaignFields = { ...base };

  if (has("name")) {
    if (typeof body.name !== "string" || !body.name.trim()) return invalid("name", "must be non-empty");
    fields.name = body.name.trim();
  }
  if (has("ig_user_id")) {
    const id = body.ig_user_id;
    const accounts = await db.listAccounts(env.DB);
    if (typeof id !== "string" || !accounts.some((a) => a.igUserId === id)) {
      return invalid("ig_user_id", "not a connected account");
    }
    fields.igUserId = id;
  }
  if (has("media_id")) {
    const m = body.media_id;
    if (m !== null && (typeof m !== "string" || !m.trim())) {
      return invalid("media_id", "must be a string or null");
    }
    fields.mediaId = m === null ? null : (m as string).trim();
  }
  if (has("keywords")) {
    const k = body.keywords;
    if (!Array.isArray(k) || k.some((x) => typeof x !== "string")) {
      return invalid("keywords", "must be an array of strings");
    }
    // Same case-insensitive dedupe as the form's splitKeywords, minus splitting on commas.
    const seen = new Set<string>();
    fields.keywords = (k as string[]).map((x) => x.trim()).filter((x) => {
      const key = x.toLowerCase();
      if (!x || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fields.keywords.length === 0) return invalid("keywords", "need at least one non-empty keyword");
  }
  if (has("match_mode")) {
    if (body.match_mode !== "whole_word" && body.match_mode !== "contains") {
      return invalid("match_mode", "must be whole_word or contains");
    }
    fields.matchMode = body.match_mode;
  }
  if (has("dedupe_scope")) {
    if (body.dedupe_scope !== "per_post" && body.dedupe_scope !== "campaign") {
      return invalid("dedupe_scope", "must be per_post or campaign");
    }
    fields.dedupeScope = body.dedupe_scope;
  }
  if (has("dm_message")) {
    const m = body.dm_message;
    if (typeof m !== "string" || !m.trim()) return invalid("dm_message", "must be non-empty");
    if (bytes(m) > MAX_BYTES) return invalid("dm_message", `over ${MAX_BYTES} bytes`);
    fields.dmMessage = m;
  }
  if (has("public_reply")) {
    const r = body.public_reply;
    if (r !== null && typeof r !== "string") return invalid("public_reply", "must be a string or null");
    if (typeof r === "string" && bytes(r) > MAX_BYTES) return invalid("public_reply", `over ${MAX_BYTES} bytes`);
    fields.publicReply = r?.trim() || null;
  }
  if (has("active") && typeof body.active !== "boolean") return invalid("active", "must be a boolean");
  if (has("track_link") && typeof body.track_link !== "boolean") {
    return invalid("track_link", "must be a boolean");
  }
  if (has("active")) fields.active = body.active as boolean;

  let targetUrl: string | null = null;
  let remove = false;
  if (body.link_url === null) {
    remove = true;
  } else if (has("link_url")) {
    const raw = body.link_url;
    targetUrl = typeof raw === "string" && /^https?:\/\//i.test(raw.trim()) ? db.normalizeUrl(raw) : null;
    if (!targetUrl) return invalid("link_url", "must be an http(s) URL");
  }

  // A tracking change without a URL applies to the link already there.
  const tracked = has("track_link") ? (body.track_link as boolean) : undefined;
  if (!targetUrl && !remove && tracked !== undefined && existing?.linkId) {
    targetUrl = (await db.getLink(env.DB, existing.linkId))?.targetUrl ?? null;
  }

  const saved = await saveCampaignWithLink(env.DB, existing, fields, { targetUrl, tracked, remove });
  return json({ campaign: await presentOne(env, saved) }, existing ? 200 : 201);
}

function limitParam(url: URL, max: number, dflt: number): number | null {
  const raw = url.searchParams.get("limit");
  if (raw === null) return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

/** The account's token, or the error response explaining why there isn't one. */
async function tokenFor(env: Env, url: URL): Promise<string | Response> {
  const igUserId = url.searchParams.get("ig_user_id") ?? "";
  const account = (await db.listAccounts(env.DB)).find((a) => a.igUserId === igUserId);
  if (!account) return invalid("ig_user_id", "not a connected account");
  if (account.needsReconnect) return fail(409, "needs_reconnect", account.username);
  const token = await db.getAccountToken(env.DB, env.ENCRYPTION_KEY, igUserId);
  return token ?? fail(409, "needs_reconnect", account.username);
}

async function listMedia(env: Env, url: URL): Promise<Response> {
  const limit = limitParam(url, 500, 100);
  if (limit === null) return invalid("limit", "must be an integer from 1 to 500");
  const token = await tokenFor(env, url);
  if (token instanceof Response) return token;

  const media = await listMediaPaged(token, limit);
  if (!media) return fail(502, "graph_error");
  return json({
    media: media.map((m) => ({
      media_id: m.mediaId,
      permalink: m.permalink,
      media_type: m.mediaType,
      timestamp: m.postedAt === null ? null : new Date(m.postedAt).toISOString(),
      caption: m.caption?.slice(0, 200) ?? null,
    })),
  });
}

async function listComments(env: Env, url: URL): Promise<Response> {
  const limit = limitParam(url, 5000, 1000);
  if (limit === null) return invalid("limit", "must be an integer from 1 to 5000");
  const mediaId = url.searchParams.get("media_id");
  if (!mediaId) return invalid("media_id", "required");
  const token = await tokenFor(env, url);
  if (token instanceof Response) return token;

  // Graph refuses a post the token's account doesn't own, which surfaces as graph_error.
  const comments = await listCommentsPaged(mediaId, token, limit);
  if (!comments) return fail(502, "graph_error");
  return json({
    comments: comments.map((c) => ({
      id: c.id,
      text: c.text,
      timestamp: c.timestamp === null ? null : new Date(c.timestamp).toISOString(),
      username: c.username ?? null,
    })),
  });
}
