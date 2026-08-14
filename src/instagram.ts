// v23.0 on purpose, and tested: v26.0 (the newest version Meta recognises as of
// 2026-08-12; v27+ answers "Unknown path components") returns byte-identical
// errors for every metric this file asks for. The version is not a variable —
// re-bumping it is a tested dead end, receipts in the comments below.
const API_VERSION = "v23.0";
const GRAPH_HOST = "https://graph.instagram.com";
const OAUTH_HOST = "https://api.instagram.com";

/**
 * Ceiling on a single Graph read.
 *
 * `fetch` in a Worker has no default timeout, so a Meta endpoint that stalls
 * stalls whoever is waiting on it — and until the dashboard stopped awaiting
 * these, that was the page render itself. Ten seconds is far past a healthy
 * call (a few hundred ms) and far short of a visitor giving up.
 *
 * Nothing downstream needs new handling: every read below already treats a
 * throw as "this metric is unavailable", and an abort arrives as a throw. The
 * token exchange and the publish path are deliberately left uncapped — a
 * publish is a user action that already failed loudly, and a half-aborted
 * container create is worse than a slow one.
 */
const GRAPH_TIMEOUT_MS = 10_000;

/** Request init that aborts a stalled Graph read instead of waiting forever. */
function timed(init: RequestInit = {}): RequestInit {
  return { ...init, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) };
}

/**
 * Meta's private-reply docs list only basic + manage_comments, but a token with
 * exactly those two is refused with "IGApiException 10: Application does not have
 * permission for this action". manage_messages is required in practice — verified
 * by comparing a working dashboard-issued token against an OAuth one without it.
 */
export const SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
  // Reach/impressions, so campaign results can be read against the audience that
  // saw the post rather than in isolation. Requested now because scope changes
  // only take effect on a fresh authorization.
  "instagram_business_manage_insights",
  // Publishing reels from the Kuff app (see src/channel.ts). Standard Access
  // covers it for accounts the operator has a role on, the same as every other
  // scope here — no App Review, because this stays single-tenant.
  "instagram_business_content_publish",
];

export function authorizeUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(","),
    // Without this, Instagram short-circuits an account that already authorized
    // and returns a code carrying the OLD grant — so scopes added later are
    // never actually given. Reconnecting appears to succeed and changes nothing.
    force_reauth: "true",
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

export interface ConnectedAccount {
  accessToken: string;
  userId: string;
  username?: string;
  /** Seconds until expiry — long-lived tokens are ~60 days. */
  expiresIn?: number;
}

/**
 * Exchanges an authorization code for a long-lived token.
 *
 * Two hops: the code buys a short-lived token, which is then swapped for a
 * 60-day one. Skipping the second hop leaves you with a token that dies in hours.
 */
export async function exchangeCodeForToken(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<{ ok: true; account: ConnectedAccount } | { ok: false; error: string }> {
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });

  const shortRes = await fetch(`${OAUTH_HOST}/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const shortBody = await shortRes.text();
  if (!shortRes.ok) {
    return { ok: false, error: `code exchange failed (${shortRes.status}): ${shortBody.slice(0, 300)}` };
  }

  let short: {
    access_token?: string;
    user_id?: string | number;
    error_message?: string;
    /**
     * Instagram Login for Business wraps the first hop's result in `data[0]`
     * rather than returning it flat, and which shape you get has moved with the
     * API. Read both: a flat response that suddenly nests is otherwise a
     * "no access_token in response" with a perfectly valid token inside it.
     */
    data?: Array<{ access_token?: string; user_id?: string | number; permissions?: unknown }>;
  };
  try {
    short = JSON.parse(shortBody);
  } catch {
    return { ok: false, error: `code exchange returned non-JSON: ${shortBody.slice(0, 200)}` };
  }

  const shortToken = short.access_token ?? short.data?.[0]?.access_token;
  const shortUserId = short.user_id ?? short.data?.[0]?.user_id;

  // Shape only — never the token, never the secret. Enough to tell a nested
  // response from a flat one, and a real token from a stringified object,
  // without any of it being usable if a log is ever read by the wrong person.
  console.log(
    "code exchange ok:",
    JSON.stringify({
      keys: Object.keys(short),
      nested: Array.isArray(short.data),
      tokenLength: shortToken?.length ?? 0,
      looksLikeIgToken: typeof shortToken === "string" && shortToken.startsWith("IGAA"),
      hasUserId: shortUserId !== undefined,
    }),
  );

  if (!shortToken) {
    return { ok: false, error: short.error_message ?? "no access_token in response" };
  }

  const longUrl = new URL(`${GRAPH_HOST}/access_token`);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", clientSecret);
  longUrl.searchParams.set("access_token", shortToken);

  const longRes = await fetch(longUrl);
  const longBody = await longRes.text();
  if (!longRes.ok) {
    // Logged with the secret and token stripped, because the failure we chased
    // on 2026-08-07 ("Unsupported request - method type: get") was impossible to
    // tell apart from a malformed URL without seeing what was actually sent.
    console.error(
      "long-lived exchange failed:",
      JSON.stringify({
        status: longRes.status,
        url: `${longUrl.origin}${longUrl.pathname}?grant_type=${longUrl.searchParams.get("grant_type")}`,
        secretLength: clientSecret.length,
        body: longBody.slice(0, 300),
      }),
    );
    return { ok: false, error: `long-lived exchange failed (${longRes.status}): ${longBody.slice(0, 300)}` };
  }

  let long: { access_token?: string; expires_in?: number };
  try {
    long = JSON.parse(longBody);
  } catch {
    return { ok: false, error: `long-lived exchange returned non-JSON: ${longBody.slice(0, 200)}` };
  }
  if (!long.access_token) {
    return { ok: false, error: "no access_token in long-lived response" };
  }

  const me = await getMe(long.access_token);

  return {
    ok: true,
    account: {
      accessToken: long.access_token,
      userId: me?.userId ?? String(shortUserId ?? ""),
      username: me?.username,
      expiresIn: long.expires_in,
    },
  };
}

export interface RefreshResult {
  ok: boolean;
  accessToken?: string;
  /** Seconds until the new token expires — another ~60 days. */
  expiresIn?: number;
  error?: string;
  /** True when re-authorizing by hand is the only fix. */
  permanent?: boolean;
}

/**
 * A refresh extends the token by ~60 days. Used only when Meta omits expires_in
 * from the response: defaulting to 0 instead would write the just-renewed token
 * back as expiring immediately, so the next run marks the account dead.
 */
const REFRESHED_TOKEN_TTL_S = 60 * 24 * 60 * 60;

/**
 * Extends a long-lived token by another ~60 days.
 *
 * Meta refuses this if the token is under 24 hours old or already expired, and a
 * token nobody refreshes within 60 days is gone for good — there is no recovery
 * except a fresh authorization. Note the unversioned path: adding /vXX.0 here
 * 404s, unlike every other Graph call in this file.
 */
export async function refreshLongLivedToken(accessToken: string): Promise<RefreshResult> {
  const url = new URL(`${GRAPH_HOST}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", accessToken);

  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    return { ok: false, error: `network: ${cause}`, permanent: false };
  }

  const raw = await res.text();
  let body: { access_token?: string; expires_in?: number; error?: GraphError } = {};
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: `non-JSON (${res.status}): ${raw.slice(0, 200)}`, permanent: false };
  }

  if (!res.ok || body.error || !body.access_token) {
    const { retryable } = classify(res.status, body.error?.code);
    return {
      ok: false,
      error: describe(body.error) ?? raw.slice(0, 200),
      permanent: !retryable,
    };
  }

  return {
    ok: true,
    accessToken: body.access_token,
    expiresIn: body.expires_in ?? REFRESHED_TOKEN_TTL_S,
  };
}

/**
 * Subscribes the app to an account's comment webhooks.
 *
 * Authorizing via OAuth does NOT do this — the dashboard's token generator
 * quietly performs both steps, so an account connected through the OAuth flow
 * looks fully set up while silently receiving nothing. Check with
 * GET /{ig-user-id}/subscribed_apps.
 */
/**
 * Everything freeply acts on.
 *
 * `messages` carries story replies, `messaging_postbacks` carries Ice Breaker
 * taps. Both were arriving in production before this list named them, which
 * means they were subscribed by some other route — asserting them here stops
 * that being luck.
 */
export const WEBHOOK_FIELDS = ["comments", "messages", "messaging_postbacks"] as const;

/**
 * Marks an Ice Breaker payload as ours, so a tap from anything else is left alone.
 *
 * Lives here rather than in the Worker entrypoint: workerd requires every named
 * export of the entrypoint module to be a function or an ExportedHandler, and a
 * string constant there refuses to start the Worker at all.
 */
export const ICE_BREAKER_PREFIX = "freeply:";

export async function subscribeToComments(
  accessToken: string,
  fields: readonly string[] = WEBHOOK_FIELDS,
): Promise<{ ok: boolean; error?: string }> {
  const body = new URLSearchParams({
    subscribed_fields: fields.join(","),
    access_token: accessToken,
  });

  const res = await fetch(`${GRAPH_HOST}/${API_VERSION}/me/subscribed_apps`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const raw = await res.text();

  if (!res.ok) return { ok: false, error: `${res.status}: ${raw.slice(0, 200)}` };
  try {
    return JSON.parse(raw).success === true
      ? { ok: true }
      : { ok: false, error: raw.slice(0, 200) };
  } catch {
    return { ok: false, error: `non-JSON: ${raw.slice(0, 200)}` };
  }
}

/** Meta's cap. A fifth question is rejected rather than ignored. */
export const MAX_ICE_BREAKERS = 4;

/** Meta truncates past this; doing it here means what you see is what shows. */
export const ICE_BREAKER_MAX_CHARS = 80;

export interface IceBreaker {
  question: string;
  /** Comes back verbatim on the tap. Ours to interpret. */
  payload: string;
}

/**
 * Replaces the account's Ice Breakers with exactly this list.
 *
 * There is no partial update: Meta stores one set per account, so publishing is
 * always the whole list and an empty list is how you remove them. That's why
 * this lives behind an explicit dashboard action rather than firing on every
 * campaign save — the state that matters is on Meta's servers, not in D1, and
 * pretending otherwise would let the two drift silently.
 *
 * Host is graph.instagram.com to match every other call here. Meta documents the
 * Facebook-login variant against graph.facebook.com with ?platform=instagram and
 * says nothing about the Instagram-login one, so if this 404s that's the first
 * thing to change — the error is surfaced rather than swallowed for exactly that
 * reason.
 */
export async function publishIceBreakers(
  iceBreakers: readonly IceBreaker[],
  accessToken: string,
): Promise<SendResult> {
  const callToActions = iceBreakers.slice(0, MAX_ICE_BREAKERS).map((b) => ({
    question: b.question.slice(0, ICE_BREAKER_MAX_CHARS),
    payload: b.payload,
  }));

  // Deleting the field is how you clear it; posting an empty array is rejected.
  if (callToActions.length === 0) {
    const url = new URL(`${GRAPH_HOST}/${API_VERSION}/me/messenger_profile`);
    url.searchParams.set("fields", "ice_breakers");
    url.searchParams.set("access_token", accessToken);
    const res = await fetch(url, { method: "DELETE" });
    const raw = await res.text();
    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: raw.slice(0, 300) };
  }

  return post(`${GRAPH_HOST}/${API_VERSION}/me/messenger_profile`, accessToken, {
    platform: "instagram",
    ice_breakers: [{ locale: "default", call_to_actions: callToActions }],
  });
}

export interface Me {
  /** App-scoped ID. NOT the ID webhooks use. */
  id: string;
  /**
   * Instagram Business account ID, the `17841…` form. This is what webhook
   * payloads put in entry.id and what the messages endpoint expects in its path.
   * The two IDs are different namespaces for the same account — matching on the
   * wrong one silently fails to route anything.
   */
  userId: string;
  username: string;
}

export async function getMe(accessToken: string): Promise<Me | null> {
  const url = new URL(`${GRAPH_HOST}/${API_VERSION}/me`);
  url.searchParams.set("fields", "id,user_id,username");
  url.searchParams.set("access_token", accessToken);

  // Wrapped because the timeout above turns a stalled call into a throw, and
  // this function's contract is already "null means we couldn't read it" — an
  // uncaught abort here would 500 the OAuth callback instead.
  let res: Response;
  try {
    res = await fetch(url, timed());
  } catch (cause) {
    console.error("graph GET /me failed:", cause);
    return null;
  }
  if (!res.ok) return null;
  try {
    const d = (await res.json()) as { id?: string; user_id?: string; username?: string };
    if (!d.user_id) return null;
    return { id: d.id ?? "", userId: d.user_id, username: d.username ?? "" };
  } catch {
    return null;
  }
}

export interface MediaStats {
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saved: number | null;
  shares: number | null;
  views: number | null;
  /** Percentage of views skipped in the first 3 seconds. Reels only. */
  skipRate: number | null;
  /** Average watch time in milliseconds. Reels only. */
  avgWatchMs: number | null;
  /** Total watch time across all views, ms. Catches replays. Reels only. */
  totalWatchMs: number | null;
  /** likes+comments+saves+shares as Meta counts it. Rides the reels request. */
  interactions: number | null;
  /** reposts_count — a media field, owner-only, feed + reels. */
  reposts: number | null;
  /** Accounts that followed as a result of this post. */
  follows: number | null;
  /** Profile visits driven by this post. */
  profileVisits: number | null;
  permalink: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  mediaType: string | null;
}

/** One metric row, in either shape Meta uses. */
interface InsightRow {
  name: string;
  values?: Array<{ value: number }>;
  total_value?: { value?: number };
}

/**
 * Pulls a metric out of an insights payload.
 *
 * Meta returns two different shapes and doesn't document which metric uses which:
 * the long-standing ones carry `values: [{value}]`, while several of the newer
 * "in development" ones carry a single `total_value: {value}`. Reading only
 * `values[0]` makes a metric that IS present look absent — the call succeeds,
 * the number silently comes back null, and nothing errors. Accept both.
 */
function pickMetric(rows: InsightRow[] | undefined, name: string): number | null {
  const row = rows?.find((m) => m.name === name);
  return row?.values?.[0]?.value ?? row?.total_value?.value ?? null;
}

/**
 * Reads insights for one post. Needs instagram_business_manage_insights, which
 * is only granted on a fresh authorization — see force_reauth in authorizeUrl.
 *
 * Metrics vary by media type (a Reel exposes different ones than a carousel), so
 * anything Meta doesn't return comes back null rather than failing the lot.
 */
export async function getMediaStats(
  mediaId: string,
  accessToken: string,
): Promise<MediaStats | null> {
  const insightsUrl = new URL(`${GRAPH_HOST}/${API_VERSION}/${mediaId}/insights`);
  // views replaced plays/impressions across all media types in 2025, so it can
  // ride in the base list. The reel-only pair can't — one invalid metric fails
  // the whole call — so those go in a second request gated on product type.
  insightsUrl.searchParams.set("metric", "reach,likes,comments,saved,shares,views");
  insightsUrl.searchParams.set("access_token", accessToken);

  const metaUrl = new URL(`${GRAPH_HOST}/${API_VERSION}/${mediaId}`);
  // thumbnail_url only exists on video; images put their preview in media_url.
  // media_product_type distinguishes a REELS video from a feed video.
  metaUrl.searchParams.set(
    "fields",
    "permalink,caption,media_type,media_product_type,media_url,thumbnail_url",
  );
  metaUrl.searchParams.set("access_token", accessToken);

  // allSettled, not all: `all` rejects on the first failure and abandons the
  // other request, whose body is then never read — the exact leak the drain
  // below exists to prevent, reintroduced on the one path where a call times
  // out. Settling both means whichever one arrived can still be cancelled.
  const [insights, meta] = await Promise.allSettled([
    fetch(insightsUrl, timed()),
    fetch(metaUrl, timed()),
  ]);
  if (insights.status === "rejected" || meta.status === "rejected") {
    if (insights.status === "fulfilled") await insights.value.body?.cancel().catch(() => {});
    if (meta.status === "fulfilled") await meta.value.body?.cancel().catch(() => {});
    // A network-level throw here used to escape uncaught and 500 whatever was
    // blocking on the sweep — the overview render included. Same soft-fail
    // contract as getJson: this post stays blank, everything else proceeds.
    console.error(
      `media stats fetch failed for ${mediaId}:`,
      insights.status === "rejected" ? insights.reason : (meta as PromiseRejectedResult).reason,
    );
    return null;
  }
  const insightsRes = insights.value;
  const metaRes = meta.value;

  if (!insightsRes.ok) {
    console.error(`insights failed for ${mediaId}:`, (await insightsRes.text()).slice(0, 200));
    // metaRes is abandoned on this path — drain it. An unread body holds one of
    // the isolate's limited concurrent connections open forever, and the runtime
    // "prevents deadlock" by cancelling the OLDEST unread response, i.e. some
    // OTHER post's in-flight request. That cancellation is where the sweep's
    // random nulls (product type, skip/watch) were coming from.
    await metaRes.body?.cancel().catch(() => {});
    return null;
  }

  let permalink: string | null = null;
  let caption: string | null = null;
  let thumbnailUrl: string | null = null;
  let mediaType: string | null = null;
  let mediaProductType: string | null = null;

  if (metaRes.ok) {
    try {
      const m = (await metaRes.json()) as {
        permalink?: string;
        caption?: string;
        media_type?: string;
        media_product_type?: string;
        media_url?: string;
        thumbnail_url?: string;
      };
      permalink = m.permalink ?? null;
      caption = m.caption ?? null;
      mediaType = m.media_type ?? null;
      mediaProductType = m.media_product_type ?? null;
      thumbnailUrl = m.thumbnail_url ?? m.media_url ?? null;
    } catch {
      // Presentation only — its absence shouldn't lose the metrics.
    }
  } else {
    // Same rule as above: every response gets read or cancelled, no exceptions.
    // This unread error body was the other leak feeding the stall-canceller.
    console.error(`media fields failed for ${mediaId}:`, (await metaRes.text()).slice(0, 200));
  }

  // Meta flags both reel metrics "in development"; they come and go. A failure
  // here nulls the pair rather than losing the base metrics above.
  let skipRate: number | null = null;
  let avgWatchMs: number | null = null;
  let totalWatchMs: number | null = null;
  let interactions: number | null = null;
  if (mediaProductType === "REELS") {
    const reelUrl = new URL(`${GRAPH_HOST}/${API_VERSION}/${mediaId}/insights`);
    // total_interactions isn't reels-only, but it IS "in development", and one bad
    // metric fails the whole request — so it rides here in the already-tolerated
    // call rather than in the base list, where a wobble would cost reach/likes/views.
    // The price is that feed posts never fill it. Fine: this account posts reels.
    reelUrl.searchParams.set(
      "metric",
      "reels_skip_rate,ig_reels_avg_watch_time,ig_reels_video_view_total_time,total_interactions",
    );
    reelUrl.searchParams.set("access_token", accessToken);
    try {
      const reelRes = await fetch(reelUrl, timed());
      if (reelRes.ok) {
        const body = (await reelRes.json()) as { data?: InsightRow[] };
        skipRate = pickMetric(body.data, "reels_skip_rate");
        avgWatchMs = pickMetric(body.data, "ig_reels_avg_watch_time");
        totalWatchMs = pickMetric(body.data, "ig_reels_video_view_total_time");
        interactions = pickMetric(body.data, "total_interactions");
        // Names Meta accepted but returned nothing for. Without this you cannot tell
        // "metric absent" from "parser missed it" — the symptom is identical.
        const missing = ["ig_reels_video_view_total_time", "total_interactions"]
          .filter((n) => !body.data?.some((m) => m.name === n));
        if (missing.length) {
          console.log(`insights omitted for ${mediaId}: ${missing.join(",")}`);
        }
      } else {
        console.error(
          `reel insights failed for ${mediaId}:`,
          (await reelRes.text()).slice(0, 200),
        );
      }
    } catch {
      // Tolerated for the same reason as above.
    }
  }

  // follows / profile_visits: the growth pair. SETTLED 2026-08-12, singly, on the
  // account's own posts — not from docs and not from a batched request:
  //   · REELS  + metric=follows          → "does not support the follows metric
  //     for this media product type" (same for profile_visits alone, same with
  //     metric_type=total_value, same on v23.0 and v26.0)
  //   · CAROUSEL/feed + the pair         → 200, follows=1, profile_visits=0
  // So: valid metric names, live token, one unsupported product type. The app's
  // per-reel Follows screen reads Instagram's private internals, which hard rule
  // 9 puts permanently off the table. Skipping REELS here is not giving up on
  // the metric — it is declining to pay one guaranteed-400 per reel per sweep.
  let follows: number | null = null;
  let profileVisits: number | null = null;
  if (mediaProductType && mediaProductType !== "REELS") {
    try {
      const growthUrl = new URL(`${GRAPH_HOST}/${API_VERSION}/${mediaId}/insights`);
      growthUrl.searchParams.set("metric", "follows,profile_visits");
      growthUrl.searchParams.set("access_token", accessToken);
      const growthRes = await fetch(growthUrl, timed());
      if (growthRes.ok) {
        const body = (await growthRes.json()) as { data?: InsightRow[] };
        follows = pickMetric(body.data, "follows");
        profileVisits = pickMetric(body.data, "profile_visits");
      } else {
        // Log the QUERY next to the error. A rejection is only evidence about the
        // metric if you can see what was asked — reading one without the other is
        // how "the API does not support this" once got claimed for a request that
        // had never been checked.
        const sent = new URLSearchParams(growthUrl.searchParams);
        sent.delete("access_token");
        console.log(
          `growth metrics rejected for ${mediaId} (${mediaProductType}) [${sent}]:`,
          (await growthRes.text()).slice(0, 300),
        );
      }
    } catch {
      // Same soft-fail contract as every other optional metric here.
    }
  }

  // reposts: SETTLED 2026-08-12 — this surface has no per-post repost number,
  // and it is not a version problem. Tested, all 400: fields=reposts_count
  // (v23.0 AND v26.0, "nonexisting field"), fields=reshare_count (same),
  // metric=reposts, metric=reshares. The endpoint's own enum (leaked in full by
  // probing an invalid metric name) was: impressions, shares, comments, likes,
  // saved, replies, total_interactions, navigation, follows, profile_visits,
  // profile_activity, reach, ig_reels_video_view_total_time,
  // ig_reels_avg_watch_time, views, thread_replies, reposts, quotes,
  // thread_shares, threads_views, threads_media_clicks, reels_skip_rate,
  // threads_reposts, facebook_views, crossposted_views, total_views,
  // total_likes, total_comments, link_clicks. "reposts" IS in that shared enum,
  // but asking for it here answers "Instagram Insights Media API endpoint does
  // not support the metrics: reposts" — endpoint-absolute wording, unlike the
  // follows error, which is conditional on product type. Read together: the
  // name belongs to another surface (note the Threads metrics around it), not
  // to media insights. The column stays null until Meta ships it here — do NOT
  // re-add a per-post request that 400s every sweep, and do not re-test the
  // version; both are receipted dead ends.
  const reposts: number | null = null;

  try {
    const body = (await insightsRes.json()) as { data?: InsightRow[] };
    const pick = (name: string) => pickMetric(body.data, name);

    return {
      reach: pick("reach"),
      likes: pick("likes"),
      comments: pick("comments"),
      saved: pick("saved"),
      shares: pick("shares"),
      views: pick("views"),
      skipRate,
      avgWatchMs,
      totalWatchMs,
      interactions,
      reposts,
      follows,
      profileVisits,
      permalink,
      caption,
      thumbnailUrl,
      mediaType,
    };
  } catch {
    return null;
  }
}

/** Most recent media IDs on the connected account, newest first. */
export async function listRecentMedia(
  accessToken: string,
  limit: number,
): Promise<string[]> {
  const url = new URL(`${GRAPH_HOST}/${API_VERSION}/me/media`);
  url.searchParams.set("fields", "id");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", accessToken);

  const body = await getJson<{ data?: Array<{ id?: string }> }>(url);
  if (!body) return [];
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
}

export interface MediaSummary {
  mediaId: string;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  mediaType: string | null;
  /** Epoch ms. */
  postedAt: number | null;
}

/**
 * Recent posts with enough detail to recognise one in a list, newest first.
 * Null means the read failed, which is different from an account with no posts.
 *
 * Deliberately separate from listRecentMedia rather than an extension of it:
 * Meta rejects the whole request when the token can't read one of the requested
 * fields, so asking for captions and thumbnails there would let a field that
 * only decorates a picker take down missed-webhook recovery. Fields that do come
 * back missing are nulled individually, the way getMediaStats treats metrics
 * that don't exist for a media type.
 */
export async function getRecentMedia(
  accessToken: string,
  limit: number,
): Promise<MediaSummary[] | null> {
  const url = new URL(`${GRAPH_HOST}/${API_VERSION}/me/media`);
  // thumbnail_url only exists on video; images put their preview in media_url.
  url.searchParams.set(
    "fields",
    "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp",
  );
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", accessToken);

  const body = await getJson<{ data?: RawMedia[] }>(url);
  if (!body) return null;

  return (body.data ?? [])
    .filter((m): m is RawMedia & { id: string } => !!m.id)
    .map((m) => ({
      mediaId: m.id,
      caption: m.caption ?? null,
      thumbnailUrl: m.thumbnail_url ?? m.media_url ?? null,
      permalink: m.permalink ?? null,
      mediaType: m.media_type ?? null,
      postedAt: m.timestamp ? Date.parse(m.timestamp) || null : null,
    }));
}

interface RawMedia {
  id?: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  /** ISO 8601 with a +0000 offset, not epoch seconds. */
  timestamp?: string;
}

export interface RecentComment {
  id: string;
  text: string;
  /** Epoch ms. Null when Meta omits the timestamp, which forces us to treat the
   *  comment as in-window rather than silently dropping a real lead. */
  timestamp: number | null;
  commenterId?: string;
  username?: string;
}

/**
 * Reads recent comments on one post, newest first.
 *
 * `from` carries the commenter's ID, which is what the dedupe key is built from —
 * without it a recovered comment would claim under a different key than the same
 * comment arriving by webhook, and could be messaged twice. Meta rejects the
 * whole request when a field isn't available to the token rather than omitting
 * it, so a refusal is retried once without `from`; losing the commenter ID is
 * worse than losing the comment, but losing both is worse still.
 */
export async function listRecentComments(
  mediaId: string,
  accessToken: string,
  limit: number,
): Promise<RecentComment[]> {
  const read = async (fields: string) => {
    const url = new URL(`${GRAPH_HOST}/${API_VERSION}/${mediaId}/comments`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("access_token", accessToken);
    return getJson<{ data?: RawComment[] }>(url);
  };

  const body =
    (await read("id,text,timestamp,username,from")) ?? (await read("id,text,timestamp"));
  if (!body) return [];

  return (body.data ?? [])
    .filter((c): c is RawComment & { id: string } => !!c.id)
    .map((c) => ({
      id: c.id,
      text: c.text ?? "",
      timestamp: c.timestamp ? (Date.parse(c.timestamp) || null) : null,
      commenterId: c.from?.id,
      username: c.from?.username ?? c.username,
    }));
}

interface RawComment {
  id?: string;
  text?: string;
  /** ISO 8601 with a +0000 offset, not epoch seconds. */
  timestamp?: string;
  username?: string;
  from?: { id?: string; username?: string };
}

async function getJson<T>(url: URL): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url, timed());
  } catch (cause) {
    console.error(`graph GET ${url.pathname} failed:`, cause);
    return null;
  }
  if (!res.ok) {
    console.error(`graph GET ${url.pathname} (${res.status}):`, (await res.text()).slice(0, 200));
    return null;
  }
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface SendResult {
  ok: boolean;
  status: number;
  /** Meta's error message, when it gives one. */
  error?: string;
  messageId?: string;
  /** Meta's numeric error code. The only trustworthy signal — see classify(). */
  code?: number;
  /** Worth attempting again later. */
  retryable?: boolean;
  /** The token itself was refused; the account has to be reconnected by hand. */
  authFailure?: boolean;
}

/**
 * Sends a private reply to a comment.
 *
 * This is not a normal DM. Meta only permits it within 7 days of the comment, and
 * only once per commenter — after that the recipient has to write back before you
 * can send anything else. Runs on instagram_business_manage_comments.
 */
export async function sendPrivateReply(
  igUserId: string,
  commentId: string,
  text: string,
  accessToken: string,
): Promise<SendResult> {
  return post(`${GRAPH_HOST}/${API_VERSION}/${igUserId}/messages`, accessToken, {
    recipient: { comment_id: commentId },
    message: { text },
  });
}

/**
 * Sends an ordinary DM to someone who has already messaged us.
 *
 * Unlike a private reply this carries no special permission of its own: it works
 * only inside the 24-hour window the recipient's own message opened, and Meta
 * refuses it once that window shuts. Story replies arrive as inbound messages,
 * so the window is open by definition at the moment we're deciding to answer.
 */
export async function sendMessage(
  igUserId: string,
  recipientId: string,
  text: string,
  accessToken: string,
): Promise<SendResult> {
  return post(`${GRAPH_HOST}/${API_VERSION}/${igUserId}/messages`, accessToken, {
    recipient: { id: recipientId },
    message: { text },
  });
}

/** Posts a public reply underneath the comment. */
export async function replyToComment(
  commentId: string,
  text: string,
  accessToken: string,
): Promise<SendResult> {
  return post(`${GRAPH_HOST}/${API_VERSION}/${commentId}/replies`, accessToken, {
    message: text,
  });
}

async function post(
  url: string,
  accessToken: string,
  body: unknown,
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    return { ok: false, status: 0, error: `network: ${cause}`, retryable: true };
  }

  const raw = await response.text();
  let parsed: GraphResponse = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Non-JSON body — keep the raw text, it's usually an HTML error page from an
    // edge rather than from Meta, so the status is all there is to go on.
    return {
      ok: response.ok,
      status: response.status,
      error: response.ok ? undefined : raw.slice(0, 300),
      ...classify(response.status, undefined),
    };
  }

  if (!response.ok || parsed.error) {
    const code = parsed.error?.code;
    return {
      ok: false,
      status: response.status,
      error: describe(parsed.error) ?? raw.slice(0, 300),
      code,
      ...classify(response.status, code),
    };
  }

  return { ok: true, status: response.status, messageId: parsed.message_id };
}

/** Meta's error_user_msg is the human-readable one; message is the developer one. */
function describe(e: GraphError | undefined): string | undefined {
  if (!e) return undefined;
  return `${e.type ?? "error"} ${e.code ?? ""}: ${e.error_user_msg ?? e.message ?? "no message"}`;
}

/**
 * Rate limits, which clear on their own. Meta returns most of them with HTTP 400,
 * so the status code alone would read them as our mistake and give up.
 */
const TRANSIENT_CODES = new Set([
  1, // API Unknown — Meta's own docs call it possibly temporary
  2, // API Service
  4, // application-level rate limit, rolling hour
  17, // user-level rate limit
  32, // page-level rate limit
  341, // application limit reached
  613, // calls to this API have exceeded the rate limit
  80007, // Instagram messaging rate limit
]);

/** Refusals of the token itself. Only re-authorizing fixes these. */
const AUTH_CODES = new Set([
  10, // IGApiException 10 — app does not have permission for this action
  102, // session invalid
  190, // access token expired or revoked
  200, // permissions error
]);

/**
 * Decides whether a failed Graph call is worth repeating.
 *
 * Anything Meta names that isn't in either set is treated as permanent: a
 * deleted comment, a recipient who can't be messaged, a malformed request. A
 * private reply is one-shot per commenter, so spending retries on a call that
 * cannot succeed costs more than giving up does.
 */
function classify(status: number, code?: number): { retryable: boolean; authFailure: boolean } {
  if (code !== undefined && AUTH_CODES.has(code)) return { retryable: false, authFailure: true };
  if (status === 0 || status === 429 || status >= 500) {
    return { retryable: true, authFailure: false };
  }
  if (code !== undefined && TRANSIENT_CODES.has(code)) {
    return { retryable: true, authFailure: false };
  }
  return { retryable: false, authFailure: false };
}

interface GraphError {
  message?: string;
  error_user_msg?: string;
  type?: string;
  code?: number;
}

interface GraphResponse {
  message_id?: string;
  error?: GraphError;
}

export interface PublishResult {
  ok: boolean;
  mediaId?: string;
  permalink?: string;
  error?: string;
}

/**
 * How long to wait for Meta to finish transcoding before giving up.
 *
 * A container is not publishable the instant it is created — Meta downloads the
 * video, transcodes it, and only then flips `status_code` to FINISHED. Calling
 * media_publish before that returns "Media ID is not available", which reads
 * like a bad ID rather than like "not yet". A minute covers a normal reel; past
 * that something is wrong with the file and waiting longer will not fix it.
 */
const PUBLISH_POLL_ATTEMPTS = 20;
const PUBLISH_POLL_INTERVAL_MS = 3_000;

/**
 * Publishes a reel: create a container, wait for it, publish it.
 *
 * `videoUrl` must be publicly reachable — Meta fetches the file itself, and a
 * signed URL that expires mid-transcode fails the container rather than the
 * publish. The resumable upload endpoint (rupload.facebook.com) exists for
 * uploading bytes directly and is the alternative if hosting ever becomes the
 * awkward part.
 *
 * Needs instagram_business_content_publish, which — like every other scope here
 * — is only granted on a fresh authorization. See force_reauth in authorizeUrl.
 * Standard Access covers it because these are the operator's own accounts,
 * added as testers on their own app; that is the same reason nothing else here
 * went through App Review.
 */
export async function publishReel(
  accessToken: string,
  post: { videoUrl: string; caption: string },
): Promise<PublishResult> {
  const createUrl = new URL(`${GRAPH_HOST}/${API_VERSION}/me/media`);
  const createBody = new URLSearchParams({
    media_type: "REELS",
    video_url: post.videoUrl,
    caption: post.caption,
    access_token: accessToken,
  });

  let container: { id?: string; error?: { message?: string } };
  try {
    const res = await fetch(createUrl, { method: "POST", body: createBody });
    container = (await res.json()) as typeof container;
  } catch (cause) {
    console.error("reel container create failed:", cause);
    return { ok: false, error: "could not reach Instagram" };
  }
  if (!container.id) {
    return { ok: false, error: container.error?.message ?? "container was not created" };
  }

  const ready = await waitForContainer(accessToken, container.id);
  if (!ready.ok) return ready;

  const publishUrl = new URL(`${GRAPH_HOST}/${API_VERSION}/me/media_publish`);
  const publishBody = new URLSearchParams({
    creation_id: container.id,
    access_token: accessToken,
  });

  let published: { id?: string; error?: { message?: string } };
  try {
    const res = await fetch(publishUrl, { method: "POST", body: publishBody });
    published = (await res.json()) as typeof published;
  } catch (cause) {
    console.error("reel publish failed:", cause);
    return { ok: false, error: "could not reach Instagram" };
  }
  if (!published.id) {
    return { ok: false, error: published.error?.message ?? "publish was refused" };
  }

  // Best-effort. The post is live either way, and failing the whole call
  // because the permalink lookup 500'd would have the caller believe nothing
  // was posted — and try again, which is the one outcome worth avoiding.
  const url = new URL(`${GRAPH_HOST}/${API_VERSION}/${published.id}`);
  url.searchParams.set("fields", "permalink");
  url.searchParams.set("access_token", accessToken);
  const detail = await getJson<{ permalink?: string }>(url);

  return { ok: true, mediaId: published.id, permalink: detail?.permalink };
}

async function waitForContainer(
  accessToken: string,
  containerId: string,
): Promise<PublishResult> {
  for (let attempt = 0; attempt < PUBLISH_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_POLL_INTERVAL_MS));

    const url = new URL(`${GRAPH_HOST}/${API_VERSION}/${containerId}`);
    url.searchParams.set("fields", "status_code,status");
    url.searchParams.set("access_token", accessToken);

    const body = await getJson<{ status_code?: string; status?: string }>(url);
    // A failed read is not a failed publish — the poll is retried rather than
    // treated as an error, because one flaky request should not abandon a video
    // Meta is already transcoding.
    if (!body) continue;

    switch (body.status_code) {
      case "FINISHED":
        return { ok: true };
      case "ERROR":
        // `status` carries Meta's reason; `status_code` only says it failed.
        return { ok: false, error: body.status ?? "Instagram rejected the video" };
      case "EXPIRED":
        return { ok: false, error: "the upload container expired before publishing" };
      default:
        continue; // IN_PROGRESS, or a code Meta has not documented.
    }
  }
  return { ok: false, error: "Instagram did not finish processing the video in time" };
}

/** One message as the conversations API hands it back. */
export interface ConversationMessage {
  id: string;
  createdTime: string | null;
  fromId: string | null;
  toId: string | null;
  text: string;
  raw: string;
}

/**
 * The operator's DM threads, newest messages first.
 *
 * Two limits from Meta shape what this can return, and both are ceilings rather
 * than page sizes — paginating harder does not beat either:
 *
 *   - only the 20 most recent messages in a thread are readable; older ids come
 *     back as "message has been deleted"
 *   - threads sitting in Requests with no activity for 30 days aren't returned
 *
 * So this is a one-time seed for whatever is still in reach, never the source of
 * truth. The webhook recorder is what makes history complete going forward.
 *
 * Only the five documented message fields are requested. Attachments and shares
 * are NOT — Meta documents no field name for them, and one invalid field fails
 * the entire call rather than being ignored, which would turn a partial result
 * into no result. Whatever does arrive is kept verbatim in `raw`.
 */
export async function fetchConversations(
  accessToken: string,
): Promise<{ ok: boolean; messages: ConversationMessage[]; error?: string }> {
  const url = new URL(`${GRAPH_HOST}/${API_VERSION}/me/conversations`);
  url.searchParams.set("fields", "id,messages{id,created_time,from,to,message}");
  url.searchParams.set("access_token", accessToken);

  let res: Response;
  try {
    res = await fetch(url, timed());
  } catch (cause) {
    console.error("graph GET /me/conversations failed:", cause);
    return { ok: false, messages: [], error: "request failed or timed out" };
  }

  const body = await res.text();
  if (!res.ok) {
    // Never the URL: it carries the access token.
    return { ok: false, messages: [], error: `conversations read failed (${res.status}): ${body.slice(0, 300)}` };
  }

  let parsed: {
    data?: Array<{
      id?: string;
      messages?: {
        data?: Array<{
          id?: string;
          created_time?: string;
          from?: { id?: string };
          to?: { data?: Array<{ id?: string }> };
          message?: string;
        }>;
      };
    }>;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, messages: [], error: "conversations returned non-JSON" };
  }

  const messages: ConversationMessage[] = [];
  for (const conversation of parsed.data ?? []) {
    for (const m of conversation.messages?.data ?? []) {
      if (!m.id) continue;
      messages.push({
        id: m.id,
        createdTime: m.created_time ?? null,
        fromId: m.from?.id ?? null,
        // `to` is a list even in a one-to-one thread.
        toId: m.to?.data?.[0]?.id ?? null,
        text: m.message ?? "",
        raw: JSON.stringify(m),
      });
    }
  }
  return { ok: true, messages };
}
