const API_VERSION = "v23.0";
const GRAPH_HOST = "https://graph.instagram.com";
const OAUTH_HOST = "https://api.instagram.com";

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

  let short: { access_token?: string; user_id?: string | number; error_message?: string };
  try {
    short = JSON.parse(shortBody);
  } catch {
    return { ok: false, error: `code exchange returned non-JSON: ${shortBody.slice(0, 200)}` };
  }
  if (!short.access_token) {
    return { ok: false, error: short.error_message ?? "no access_token in response" };
  }

  const longUrl = new URL(`${GRAPH_HOST}/access_token`);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", clientSecret);
  longUrl.searchParams.set("access_token", short.access_token);

  const longRes = await fetch(longUrl);
  const longBody = await longRes.text();
  if (!longRes.ok) {
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
      userId: me?.userId ?? String(short.user_id ?? ""),
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

  const res = await fetch(url);
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
  permalink: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  mediaType: string | null;
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
  insightsUrl.searchParams.set("metric", "reach,likes,comments,saved,shares");
  insightsUrl.searchParams.set("access_token", accessToken);

  const metaUrl = new URL(`${GRAPH_HOST}/${API_VERSION}/${mediaId}`);
  // thumbnail_url only exists on video; images put their preview in media_url.
  metaUrl.searchParams.set(
    "fields",
    "permalink,caption,media_type,media_url,thumbnail_url",
  );
  metaUrl.searchParams.set("access_token", accessToken);

  const [insightsRes, metaRes] = await Promise.all([fetch(insightsUrl), fetch(metaUrl)]);

  if (!insightsRes.ok) {
    console.error(`insights failed for ${mediaId}:`, (await insightsRes.text()).slice(0, 200));
    return null;
  }

  let permalink: string | null = null;
  let caption: string | null = null;
  let thumbnailUrl: string | null = null;
  let mediaType: string | null = null;

  if (metaRes.ok) {
    try {
      const m = (await metaRes.json()) as {
        permalink?: string;
        caption?: string;
        media_type?: string;
        media_url?: string;
        thumbnail_url?: string;
      };
      permalink = m.permalink ?? null;
      caption = m.caption ?? null;
      mediaType = m.media_type ?? null;
      thumbnailUrl = m.thumbnail_url ?? m.media_url ?? null;
    } catch {
      // Presentation only — its absence shouldn't lose the metrics.
    }
  }

  try {
    const body = (await insightsRes.json()) as {
      data?: Array<{ name: string; values?: Array<{ value: number }> }>;
    };
    const pick = (name: string) =>
      body.data?.find((m) => m.name === name)?.values?.[0]?.value ?? null;

    return {
      reach: pick("reach"),
      likes: pick("likes"),
      comments: pick("comments"),
      saved: pick("saved"),
      shares: pick("shares"),
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
    res = await fetch(url);
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
