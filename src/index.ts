import type { AccountDO } from "./account-do";
import {
  clearCookie,
  constantTimeEqual,
  createSession,
  isValidSession,
  sessionCookie,
} from "./auth";
import { scheduled } from "./cron";
import { MANUAL_MEDIA, type Tab, dashboardPage, loginPage } from "./dashboard";
import * as db from "./db";
import { canEscape, escapePage, isInAppBrowser } from "./escape";
import { filesIndex, serveFile } from "./files";
import { ICON_SVG, appleIconBytes } from "./icon";
import { WORKSPACE_HTML } from "./workspace-html";
import { handleMcp } from "./mcp";
import {
  ICE_BREAKER_PREFIX,
  MAX_ICE_BREAKERS,
  authorizeUrl,
  exchangeCodeForToken,
  getMediaStats,
  getRecentMedia,
  publishIceBreakers,
  subscribeToComments,
} from "./instagram";
import { dataDeletionPage, privacyPage } from "./pages";

export interface Env {
  DB: D1Database;
  ACCOUNT: DurableObjectNamespace<AccountDO>;

  /** Encrypts access tokens at rest. Rotating it orphans stored tokens. */
  ENCRYPTION_KEY: string;
  /** Gates the dashboard and signs its session cookies. */
  DASHBOARD_PASSWORD: string;

  META_APP_SECRET: string;
  INSTAGRAM_APP_ID: string;
  INSTAGRAM_APP_SECRET: string;
  META_VERIFY_TOKEN: string;

  OPERATOR_EMAIL: string;

  /**
   * Gates the read-only /mcp stats endpoint (see src/mcp.ts). Deliberately not
   * the dashboard password: this token leaves the machine (it lives in a
   * claude.ai connector config) and must never open the dashboard. Unset = off.
   */
  MCP_STATS_TOKEN?: string;

  /**
   * Reels and renders for the cash.builds workspace (see src/files.ts). Optional
   * because the Worker is useful without it — Freeply itself never reads it, and
   * an operator who hasn't created the bucket should get a clear 503 from /files
   * rather than a broken deploy.
   */
  MEDIA?: R2Bucket;
}

export { AccountDO } from "./account-do";

/**
 * The two custom domains this Worker answers on (see wrangler.jsonc `routes`).
 * They are one brand each: the workspace host serves cash.builds, the Freeply
 * host serves Freeply, and each hands a visitor who asks for the other brand's
 * page over to the hostname that owns it.
 */
const WORKSPACE_HOST = "cashbuilds.cannappy.org";
const FREEPLY_HOST = "freeply.cannappy.org";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // One worker, two brands, split by hostname: cashbuilds.cannappy.org IS the
    // cash.builds workspace, freeply.cannappy.org IS Freeply's dashboard. They
    // can't be two workers — the workspace page calls /stats.json and /refresh
    // same-origin and reads its media off the same session cookie.
    // The workers.dev name is deliberately left unsplit, so it still reaches
    // either half if a custom domain ever misbehaves.
    const onWorkspaceHost = url.hostname === WORKSPACE_HOST;
    const onFreeplyHost = url.hostname === FREEPLY_HOST;
    // Endpoints both brands call. /refresh in particular is posted by Freeply's
    // own Overview tab AND by the workspace's Refresh button, so it has to keep
    // answering on both names — the session cookie is host-scoped, and bouncing
    // that POST across hostnames would drop the session and land on a login.
    const sharedApi = path === "/refresh" || path === "/stats.json" || path === "/files" ||
      path === "/workspace-state" || path.startsWith("/files/");

    // Token-authed, never by session — the caller is a claude.ai connector,
    // not a browser. Auth and 404-when-off live inside the handler.
    if (path === "/mcp" || path.startsWith("/mcp/")) return handleMcp(request, path, env);

    // OAuth discovery probes, answered with a clean 404 so a client concludes
    // there is no authorization server to negotiate with and just calls /mcp
    // with its capability URL. Without this they fall through to the catch-all
    // session redirect below, mistake the login page for a sign-in service, and
    // fail dynamic client registration — which is exactly what claude.ai's
    // "couldn't register with Freeply's sign-in service" error was.
    if (path.startsWith("/.well-known/") || path === "/register") {
      return new Response("not found", { status: 404 });
    }

    // Authenticated by signature, never by session — Meta has no cookie.
    if (path === "/webhook") {
      if (request.method === "GET") return verifySubscription(url, env);
      if (request.method === "POST") return receiveEvent(request, env, ctx);
      return new Response("method not allowed", { status: 405 });
    }

    // The example address counts as unset. `npm run setup` refuses to deploy while
    // OPERATOR_EMAIL is still the placeholder, but a bare `wrangler deploy` doesn't,
    // and a contact page Meta requires is worse carrying a fake address than none.
    const configured = env.OPERATOR_EMAIL === "you@example.com" ? "" : env.OPERATOR_EMAIL;
    const operator = configured || "the operator of this instance";
    if (path === "/privacy") return privacyPage(operator, url.host);
    if (path === "/data-deletion") return dataDeletionPage(operator, url.host);

    // Icons stay public — the login page and iOS home-screen fetches have no
    // session to show.
    if (path === "/icon.svg") {
      return new Response(ICON_SVG, {
        headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
      });
    }
    if (path === "/apple-touch-icon.png") {
      return new Response(appleIconBytes(), {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
      });
    }

    if (path.startsWith("/l/")) {
      const code = path.slice(3);
      const ua = request.headers.get("user-agent") ?? "";

      // The escape page's beacon calls back here. Executing JS proves a real
      // browser, so this is the only count an in-app visit produces.
      if (url.searchParams.get("counted") === "1") {
        await db.resolveLink(env.DB, code, true);
        return new Response(null, { status: 204 });
      }

      // Sec-Fetch-Mode: navigate means a browser is actually going to the page.
      // Link preview fetchers — including Instagram's, which runs when a DM
      // containing a URL is merely displayed — don't set it.
      const mode = request.headers.get("sec-fetch-mode");
      const navigating = mode === null ? !isCrawler(ua) : mode === "navigate";
      // Only Android in-app gets the handoff page; its clicks are counted by
      // that page's beacon instead, so they aren't double-counted here.
      const handoff = canEscape(ua) && navigating;
      const counted = navigating && !isCrawler(ua) && !handoff;

      console.log(
        `link ${code} ${counted ? "COUNTED" : handoff ? "handoff" : "ignored"} ` +
          `in-app=${isInAppBrowser(ua)} sec-fetch-mode=${mode ?? "-"} ` +
          `ua=${ua.slice(0, 80) || "-"}`,
      );

      const target = await db.resolveLink(env.DB, code, counted);
      if (!target) return new Response("link not found", { status: 404 });

      return handoff ? escapePage(target, ua) : Response.redirect(target, 302);
    }

    if (path === "/login") {
      // Only same-site absolute paths come back out of this — "//evil.com" is a
      // protocol-relative URL, so rejecting a second leading slash is what stops
      // this being an open redirect.
      const safeNext = (v: unknown) => {
        const s = String(v ?? "");
        return s.startsWith("/") && !s.startsWith("//") ? s : "/";
      };

      // The hostname decides the name on the sign-in page: the workspace domain
      // never says "Freeply" at any point, including on the way in.
      const brand = onWorkspaceHost ? "cash.builds" : undefined;

      if (request.method === "GET") {
        return loginPage(undefined, safeNext(url.searchParams.get("next")), brand);
      }
      const form = await request.formData();
      const supplied = String(form.get("password") ?? "");
      const next = safeNext(form.get("next"));

      if (!env.DASHBOARD_PASSWORD || !constantTimeEqual(supplied, env.DASHBOARD_PASSWORD)) {
        return loginPage("Incorrect password.", next, brand);
      }
      return new Response(null, {
        status: 302,
        headers: {
          location: next,
          "set-cookie": sessionCookie(await createSession(env.DASHBOARD_PASSWORD)),
        },
      });
    }

    if (path === "/logout") {
      return new Response(null, {
        status: 302,
        headers: { location: "/login", "set-cookie": clearCookie },
      });
    }

    /* ---- everything past here needs a session ---- */
    if (!(await isValidSession(request.headers.get("cookie"), env.DASHBOARD_PASSWORD))) {
      // Carry the destination through the sign-in, so opening the workspace cold
      // lands on the workspace instead of Freeply's own dashboard.
      // GET only: a POST can't be replayed after sign-in, so carrying its path
      // would just bounce the visitor to a 405 once they're through.
      const next =
        request.method === "GET" && path !== "/"
          ? `?next=${encodeURIComponent(path + url.search)}`
          : "";
      return new Response(null, { status: 302, headers: { location: `/login${next}` } });
    }

    /* ---- one brand per hostname, from here down ---- */
    // Only pages split. Everything above the session gate — webhooks, /l/ tracked
    // links, /mcp, icons, /login — is plumbing that has to answer on every
    // hostname, because links already sitting in real DMs point at both names.
    // 302 for GET so no browser caches the split into permanence; 307 for the
    // rest so a stray form post keeps its method instead of arriving as a GET.
    const handOverTo = (host: string) =>
      new Response(null, {
        status: request.method === "GET" ? 302 : 307,
        headers: { location: `https://${host}${path}${url.search}` },
      });
    if (onWorkspaceHost && path !== "/" && !sharedApi && path !== "/workspace") {
      return handOverTo(FREEPLY_HOST);
    }
    if (onFreeplyHost && path === "/workspace") return handOverTo(WORKSPACE_HOST);
    // The workspace is what this hostname is for, so it answers at the root —
    // no /workspace to remember and no Freeply dashboard flashing past first.
    if (onWorkspaceHost && path === "/") {
      return new Response(WORKSPACE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (path === "/auth/start") {
      return Response.redirect(
        authorizeUrl(env.INSTAGRAM_APP_ID, `${url.origin}/auth/callback`),
        302,
      );
    }
    if (path === "/auth/callback") return handleAuthCallback(url, env);

    // The cash.builds workspace, served from the same origin as its data so its
    // Refresh button can actually call /refresh. Session-gated by the check above.
    if (path === "/workspace") {
      return new Response(WORKSPACE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    // Media for the workspace, same origin and the same session as /workspace —
    // so a reel opened on the phone is one tap from the dashboard and needs no
    // second password. Read-only: there is no upload route (see src/files.ts).
    if (path === "/files") return filesIndex(env);
    if (path.startsWith("/files/")) {
      return serveFile(request, env, decodeURIComponent(path.slice("/files/".length)));
    }
    if (path === "/stats.json") {
      return new Response(JSON.stringify(await db.postStatsReport(env.DB, 24)), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    // Card state for the workspace board. It lived in localStorage until 8/3, which
    // meant every device kept a private copy and they diverged the moment two got
    // used. Session-gated by the check above, same as /stats.json — the board is
    // behind the dashboard password, not public.
    if (path === "/workspace-state") {
      if (request.method === "GET") {
        return new Response(JSON.stringify(await db.workspaceState(env.DB)), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      if (request.method === "POST") {
        let body: { section?: unknown; value?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return new Response("bad json", { status: 400 });
        }
        const section = String(body.section ?? "");
        if (!db.WORKSPACE_SECTIONS.includes(section)) {
          return new Response("unknown section", { status: 400 });
        }
        if (body.value === undefined || body.value === null) {
          return new Response("missing value", { status: 400 });
        }
        const value = JSON.stringify(body.value);
        // A board section is a few KB. Anything near this ceiling is a bug or a
        // loop, and D1 rows are not the place to find out.
        if (value.length > 256 * 1024) return new Response("too large", { status: 413 });
        const updatedAt = await db.saveWorkspaceState(env.DB, section, value);
        return new Response(JSON.stringify({ updatedAt }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      return new Response("method not allowed", { status: 405 });
    }
    if (path === "/") {
      const requested = url.searchParams.get("tab");
      const tab: Tab =
        requested === "campaigns" || requested === "links" || requested === "settings"
          ? requested
          : "overview";
      return renderDashboard(env, url.host, tab, url.searchParams.get("edit"), {
        status: url.searchParams.get("status") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
      });
    }

    // Manual sweep, cache ignored — the cron's hourly clock is a floor, not a
    // gate. Session-guarded like every dashboard action; scripts get in by
    // logging in first (see RUNBOOK in the cash-builds workspace).
    if (path === "/refresh") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      await refreshStaleAccountMedia(env, 0);
      await refreshRecentMediaStats(env, 0);
      return new Response(null, { status: 302, headers: { location: "/" } });
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const s = (k: string) => String(form.get(k) ?? "").trim();
      // The picker posts the chosen post's ID; its last option hands over to the
      // manual field instead, which is the only way in for a post too old to be
      // in the cached list.
      const pickedMediaId = () => {
        const picked = s("media_id");
        return (picked === MANUAL_MEDIA ? s("media_id_manual") : picked) || null;
      };

      if (path === "/campaigns") {
        // Creating the link is part of creating the campaign — asking someone to
        // make one separately and wire it up by hand is a step with no purpose.
        let linkId: string | null = null;
        const targetUrl = db.normalizeUrl(s("link_url"));
        if (targetUrl) {
          linkId = db.newId();
          await db.saveLink(env.DB, {
            id: linkId,
            code: db.newLinkCode(),
            targetUrl,
            tracked: s("track_link") !== "no",
          });
        }

        await db.saveCampaign(env.DB, {
          id: db.newId(),
          igUserId: s("ig_user_id"),
          name: s("name"),
          mediaId: pickedMediaId(),
          keywords: db.splitKeywords(s("keywords")),
          matchMode: s("match_mode") === "whole_word" ? "whole_word" : "contains",
          dedupeScope: s("dedupe_scope") === "campaign" ? "campaign" : "per_post",
          storyReplies: s("story_replies") === "1",
          iceBreaker: s("ice_breaker") || null,
          dmMessage: s("dm_message"),
          publicReply: s("public_reply") || null,
          linkId,
          active: true,
        });
        return redirect("/?tab=campaigns");
      }

      const campaignUpdate = path.match(/^\/campaigns\/([^/]+)\/update$/);
      if (campaignUpdate) {
        const existing = await db.getCampaign(env.DB, campaignUpdate[1]);
        if (!existing) return redirect("/?tab=campaigns");

        // Blank link field keeps the current link; a new URL replaces it; the
        // checkbox detaches it. Replaced links stay in the table with their
        // click history rather than vanishing.
        let linkId = existing.linkId;
        const targetUrl = db.normalizeUrl(s("link_url"));
        const tracked = s("track_link") !== "no";
        const currentLink = existing.linkId ? await db.getLink(env.DB, existing.linkId) : null;

        if (s("remove_link") === "1") {
          linkId = null;
        } else if (targetUrl && currentLink && targetUrl === currentLink.targetUrl) {
          // Same destination. The form prefills the current URL, so a save that
          // didn't touch the link arrives looking exactly like a replacement —
          // minting a row for it every time is what left three short codes
          // pointing at one page, each splitting the click count. Only the
          // tracked choice can have moved, and that belongs on the row we have.
          if (tracked !== currentLink.tracked) {
            await db.saveLink(env.DB, { ...currentLink, tracked });
          }
        } else if (targetUrl) {
          linkId = db.newId();
          await db.saveLink(env.DB, {
            id: linkId,
            code: db.newLinkCode(),
            targetUrl,
            tracked,
          });
        }

        await db.saveCampaign(env.DB, {
          ...existing,
          igUserId: s("ig_user_id"),
          name: s("name"),
          mediaId: pickedMediaId(),
          keywords: db.splitKeywords(s("keywords")),
          matchMode: s("match_mode") === "whole_word" ? "whole_word" : "contains",
          dedupeScope: s("dedupe_scope") === "campaign" ? "campaign" : "per_post",
          storyReplies: s("story_replies") === "1",
          iceBreaker: s("ice_breaker") || null,
          dmMessage: s("dm_message"),
          publicReply: s("public_reply") || null,
          linkId,
        });
        return redirect("/?tab=campaigns");
      }

      const campaignAction = path.match(/^\/campaigns\/([^/]+)\/(toggle|delete)$/);
      if (campaignAction) {
        const [, id, action] = campaignAction;
        if (action === "delete") {
          await db.deleteCampaign(env.DB, id);
        } else {
          const c = await db.getCampaign(env.DB, id);
          if (c) await db.saveCampaign(env.DB, { ...c, active: !c.active });
        }
        return redirectHome();
      }

      const linkDelete = path.match(/^\/links\/([^/]+)\/delete$/);
      if (linkDelete) {
        const result = await db.deleteLink(env.DB, linkDelete[1]);
        return redirect(
          result.ok
            ? "/?tab=links"
            : `/?tab=links&error=${encodeURIComponent(
                `That link is used by "${result.usedBy}". Delete or edit the campaign first.`,
              )}`,
        );
      }

      if (path === "/dedupe/clear") {
        const igUserId = s("ig_user_id");
        if (igUserId) {
          const cleared = await env.ACCOUNT.get(env.ACCOUNT.idFromName(igUserId)).clear();
          console.log(`cleared ${cleared} dedupe claim(s) for ${igUserId}`);
        }
        return redirect("/?tab=settings");
      }

      if (path === "/sends/clear") {
        const campaignId = s("campaign_id") || undefined;
        const removed = await db.clearSends(env.DB, campaignId);
        console.log(`cleared ${removed} send record(s)${campaignId ? ` for ${campaignId}` : ""}`);
        return redirect("/?tab=settings");
      }

      if (path === "/ice-breakers/publish") {
        const igUserId = s("ig_user_id");
        const token = igUserId
          ? await db.getAccountToken(env.DB, env.ENCRYPTION_KEY, igUserId)
          : null;
        if (!token) {
          return redirect(
            `/?tab=campaigns&error=${encodeURIComponent("No usable token — reconnect the account.")}`,
          );
        }

        // Whatever the account's campaigns say right now becomes the whole set;
        // Meta stores one list and has no partial update.
        const campaigns = (await db.activeCampaignsFor(env.DB, igUserId))
          .filter((c) => c.iceBreaker)
          .slice(0, MAX_ICE_BREAKERS);

        const result = await publishIceBreakers(
          campaigns.map((c) => ({
            question: c.iceBreaker as string,
            payload: `${ICE_BREAKER_PREFIX}${c.id}`,
          })),
          token,
        );

        // Also assert the webhook fields the taps arrive on. Publishing prompts
        // nobody can answer is the failure this whole feature is prone to.
        const sub = await subscribeToComments(token);
        if (!sub.ok) console.error("re-subscribe failed:", sub.error);

        console.log(
          result.ok
            ? `published ${campaigns.length} ice breaker(s) for ${igUserId}`
            : `ice breaker publish failed (${result.status}): ${result.error}`,
        );
        return redirect(
          result.ok
            ? `/?tab=campaigns&status=${encodeURIComponent(`Published ${campaigns.length} ice breaker(s).`)}`
            : `/?tab=campaigns&error=${encodeURIComponent(`Ice breakers failed: ${result.error ?? result.status}`)}`,
        );
      }

      if (path === "/links/prune") {
        const removed = await db.deleteOrphanLinks(env.DB);
        console.log(`pruned ${removed} unused link(s)`);
        return redirect("/?tab=campaigns");
      }

      const accountDelete = path.match(/^\/accounts\/([^/]+)\/delete$/);
      if (accountDelete) {
        await db.deleteAccount(env.DB, accountDelete[1]);
        return redirect("/?tab=settings");
      }

    }

    return new Response("not found", { status: 404 });
  },

  /**
   * Token refresh and missed-webhook reconciliation — see src/cron.ts. Awaited
   * rather than handed to waitUntil, so a throw shows up against the scheduled
   * event in `wrangler tail` instead of as a stray log line.
   */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await scheduled(controller, env);
  },
};

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
const redirectHome = () => redirect("/");

async function renderDashboard(
  env: Env,
  host: string,
  tab: Tab,
  editId: string | null,
  filter: { status?: string; error?: string },
): Promise<Response> {
  const [accounts, campaigns, links, sends, stats, posts] = await Promise.all([
    db.listAccounts(env.DB),
    db.listCampaigns(env.DB),
    db.listLinks(env.DB),
    db.recentSends(env.DB, { status: filter.status }),
    db.sendStats(env.DB),
    db.postPerformance(env.DB),
  ]);

  // Only the overview renders post metrics, and only the campaign form offers
  // the post picker, so each tab pays for its own refresh and no other.
  const fresh = tab === "overview" ? await refreshPostStats(env, posts) : posts;
  if (tab === "overview") await refreshRecentMediaStats(env);
  const media = tab === "campaigns" ? await pickableMedia(env, accounts) : [];
  const editing = editId ? (campaigns.find((c) => c.id === editId) ?? null) : null;
  return dashboardPage({
    accounts, campaigns, links, sends, stats, posts: fresh, media, host, tab, editing, filter,
  });
}

/** Enough posts to cover a month of regular posting without a long scroll. */
const MEDIA_PICKER_LIMIT = 24;

/**
 * Recent posts for the campaign form, from cache, topped up when it has aged out.
 *
 * Same 15-minute TTL as post insights, and the same tolerance: an account whose
 * media can't be read keeps whatever was cached last, so a token that has lost
 * its permissions leaves the picker stale rather than empty. An account already
 * flagged for reconnection isn't asked at all — its token is refused until a
 * human replaces it, and the form can be opened as often as you like.
 */
async function pickableMedia(env: Env, accounts: db.Account[]): Promise<db.MediaItem[]> {
  const lists = await Promise.all(
    accounts.map(async (account) => {
      const stale = db.cacheIsStale(await db.mediaCheckedAt(env.DB, account.igUserId));
      if (stale && !account.needsReconnect) {
        const token = await db.getAccountToken(env.DB, env.ENCRYPTION_KEY, account.igUserId);
        const media = token ? await getRecentMedia(token, MEDIA_PICKER_LIMIT) : null;
        if (media) await db.saveAccountMedia(env.DB, account.igUserId, media);
      }
      return db.listAccountMedia(env.DB, account.igUserId, MEDIA_PICKER_LIMIT);
    }),
  );
  return lists.flat();
}

/**
 * Tops up any post whose cached insights have gone stale. Fetches in parallel and
 * tolerates failures — a post whose metrics can't be read still shows its send
 * count rather than blanking the whole section.
 */
async function refreshPostStats(
  env: Env,
  posts: db.PostPerformance[],
): Promise<db.PostPerformance[]> {
  const stale = posts.filter((p) => db.cacheIsStale(p.fetchedAt));
  if (stale.length === 0) return posts;

  const tokens = new Map<string, string | null>();
  const updated = await Promise.all(
    stale.map(async (post) => {
      if (!tokens.has(post.igUserId)) {
        tokens.set(
          post.igUserId,
          await db.getAccountToken(env.DB, env.ENCRYPTION_KEY, post.igUserId),
        );
      }
      const token = tokens.get(post.igUserId);
      if (!token) return null;

      const s = await getMediaStats(post.mediaId, token);
      if (!s) return null;

      await db.savePostStats(env.DB, post.mediaId, s);
      return { ...post, ...s, fetchedAt: Date.now() };
    }),
  );

  const byId = new Map(updated.filter(Boolean).map((p) => [p!.mediaId, p!]));
  return posts.map((p) => byId.get(p.mediaId) ?? p);
}

/**
 * refreshPostStats starts from sends, so a recent post with no campaign never
 * gets stats cached at all. This tops up the newest posts from the account
 * media cache — same TTL, same tolerance — so post_stats describes the
 * account, not just the funnels. Capped: each stale post costs up to three
 * Graph API calls, and the overview blocks on this.
 */
const MEDIA_STATS_LIMIT = 12;

/**
 * The discovery half of the hourly sweep. Stats refresh only covers posts
 * already in account_media, and until now that cache was only written when the
 * campaigns tab loaded — so a post published after the last dashboard visit
 * stayed invisible to the cron indefinitely. One list call per account per
 * cycle keeps discovery on the same clock as the stats it feeds.
 */
export async function refreshStaleAccountMedia(env: Env, maxAgeMs: number): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  const accounts = await db.listAccounts(env.DB);

  for (const account of accounts) {
    if (account.needsReconnect) continue;
    const checked = await db.mediaCheckedAt(env.DB, account.igUserId);
    if (checked !== null && checked >= cutoff) continue;

    const token = await db.getAccountToken(env.DB, env.ENCRYPTION_KEY, account.igUserId);
    if (!token) continue;

    const media = await getRecentMedia(token, MEDIA_PICKER_LIMIT);
    if (media) await db.saveAccountMedia(env.DB, account.igUserId, media);
  }
}

export async function refreshRecentMediaStats(env: Env, maxAgeMs?: number): Promise<void> {
  const stale = await db.staleRecentMediaStats(env.DB, MEDIA_STATS_LIMIT, maxAgeMs);
  if (stale.length === 0) return;

  const tokens = new Map<string, string | null>();
  await Promise.all(
    stale.map(async (m) => {
      if (!tokens.has(m.igUserId)) {
        tokens.set(
          m.igUserId,
          await db.getAccountToken(env.DB, env.ENCRYPTION_KEY, m.igUserId),
        );
      }
      const token = tokens.get(m.igUserId);
      if (!token) return;

      const s = await getMediaStats(m.mediaId, token);
      if (s) await db.savePostStats(env.DB, m.mediaId, s);
    }),
  );
}

/* -------------------------------------------------------------------- oauth */

async function handleAuthCallback(url: URL, env: Env): Promise<Response> {
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (error) {
    console.error("oauth callback error:", error);
    return new Response(`Authorization failed: ${error}`, { status: 400 });
  }

  const code = url.searchParams.get("code");
  if (!code) return new Response("Missing authorization code.", { status: 400 });

  const result = await exchangeCodeForToken(
    code,
    env.INSTAGRAM_APP_ID,
    env.INSTAGRAM_APP_SECRET,
    `${url.origin}/auth/callback`,
  );
  if (!result.ok) {
    console.error("token exchange failed:", result.error);
    return new Response(`Token exchange failed: ${result.error}`, { status: 400 });
  }

  const { username, userId, expiresIn, accessToken } = result.account;

  // Authorizing does not subscribe the account to webhooks. Without this the
  // connection looks complete and silently receives nothing.
  const sub = await subscribeToComments(accessToken);
  if (!sub.ok) console.error("webhook subscription failed:", sub.error);

  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: userId,
    username: username ?? "",
    accessToken,
    expiresIn,
  });
  // Earliest reliable moment to learn the hostname the cron will have to build
  // tracked links against: an account can't exist without passing through here.
  await db.rememberHost(env.DB, url.host);

  console.log(`connected @${username} (${userId})${sub.ok ? "" : " WITHOUT webhooks"}`);
  return redirectHome();
}

/* ------------------------------------------------------------------ webhook */

function verifySubscription(url: URL, env: Env): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.META_VERIFY_TOKEN && challenge) {
    return new Response(challenge, { headers: { "content-type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}

async function receiveEvent(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // The signature covers these exact bytes — parsing then re-serializing changes
  // the digest and fails every time.
  const raw = await request.arrayBuffer();
  const signature = request.headers.get("x-hub-signature-256");

  // Meta signs with the *Instagram* app secret, not the Meta app secret.
  const valid =
    signature !== null &&
    timingSafeEqual(await hmacHex(raw, env.INSTAGRAM_APP_SECRET), stripPrefix(signature));
  if (!valid) {
    // Silent until now, which made a webhook Meta signed with the wrong secret
    // indistinguishable from one that never arrived — both look like nothing.
    console.error(
      `webhook rejected: ${signature === null ? "no x-hub-signature-256 header" : "signature mismatch — check INSTAGRAM_APP_SECRET"}`,
    );
    return new Response("invalid signature", { status: 403 });
  }

  let payload: InstagramWebhookPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    console.error("could not parse webhook body");
    return new Response("ok");
  }

  const host = new URL(request.url).host;
  // The cron has no request to learn this from, and a recovered DM has to carry
  // the same tracked-link host a webhook-driven one would.
  ctx.waitUntil(db.rememberHost(env.DB, host));

  const comments = extractComments(payload);
  const storyReplies = extractStoryReplies(payload);
  const postbacks = extractPostbacks(payload);
  if (comments.length === 0 && storyReplies.length === 0 && postbacks.length === 0) {
    // A delivery we can't read is the one failure that looked exactly like
    // success: 200 back to Meta, nothing logged, nothing sent. Print what did
    // arrive so the field name it came under is visible.
    const fields = (payload.entry ?? [])
      .flatMap((e) => e.changes ?? [])
      .map((c) => c.field ?? "?");
    console.log(
      `webhook carried nothing we act on — change fields: [${fields.join(", ")}] ` +
        `body: ${JSON.stringify(payload).slice(0, 800)}`,
    );
  }

  for (const comment of comments) {
    console.log("comment", JSON.stringify(comment));
    // Answer Meta immediately; they retry anything slow or non-200.
    ctx.waitUntil(handleComment(comment, env, host));
  }
  for (const reply of storyReplies) {
    console.log("story reply", JSON.stringify(reply));
    ctx.waitUntil(handleStoryReply(reply, env, host));
  }
  for (const tap of postbacks) {
    console.log("ice breaker tap", JSON.stringify(tap));
    ctx.waitUntil(handlePostback(tap, env, host));
  }
  return new Response("ok");
}

/**
 * Where a comment turned up. Reconciliation replays comments whose webhook never
 * arrived, so it runs the same matching, dedupe and send path — it only differs
 * in how loud it is and what it calls a successful send.
 */
export type CommentSource = "webhook" | "reconcile";

/**
 * Matches a comment to a campaign and hands the send to the account's Durable
 * Object. Returns what was recorded, which the reconciliation poll tallies.
 */
export async function handleComment(
  comment: CommentEvent,
  env: Env,
  host: string,
  source: CommentSource = "webhook",
): Promise<string> {
  // A poll walks every recent comment on every recent post, most of which match
  // nothing. Logging each near-miss the way the webhook path does would bury the
  // recoveries, which are the only thing worth reading in that run.
  const trace = (message: string) => {
    if (source === "webhook") console.log(message);
  };

  // Our own public replies arrive back as comment webhooks. Without this the bot
  // answers itself.
  if (comment.commenterId && comment.commenterId === comment.igUserId) {
    trace("skip: comment is from the connected account");
    return "self";
  }

  const campaigns = await db.activeCampaignsFor(env.DB, comment.igUserId);
  if (campaigns.length === 0) {
    trace(`skip: no active campaigns for ${comment.igUserId}`);
    return "no-campaign";
  }

  // Ordered narrowest-first, so a post-specific campaign wins over account-wide.
  const campaign = campaigns.find(
    (c) =>
      (c.mediaId === null || c.mediaId === comment.mediaId) &&
      matchesKeyword(comment.text, c.keywords, c.matchMode),
  );
  if (!campaign) {
    trace("skip: no campaign matched");
    return "no-match";
  }

  console.log(
    `matched campaign "${campaign.name}" on ${campaign.keywords.map((k) => `"${k}"`).join("/")}` +
      (source === "reconcile" ? " (from reconciliation — webhook was missed)" : ""),
  );

  // The Durable Object reads the token itself when it sends, and again on every
  // retry. This check exists only to fail before a claim is spent on an account
  // that can't send at all.
  if (!(await db.getAccountToken(env.DB, env.ENCRYPTION_KEY, comment.igUserId))) {
    console.error(`no usable token for ${comment.igUserId} — reconnect the account`);
    return "no-token";
  }

  const commenterId = comment.commenterId ?? comment.commentId;
  const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(comment.igUserId));
  // Not the campaign id: an account-wide campaign claims per post, so someone
  // who comments on a second post is answered rather than refused as a duplicate
  // of the first. See db.dedupeKey().
  const claimKey = db.dedupeKey(campaign, comment.mediaId);

  // Claim before sending. Meta redelivers, and a private reply is one-shot per
  // commenter — a duplicate spends a message that can't be reclaimed.
  if (!(await account.claim(claimKey, commenterId))) {
    trace(`skip: already messaged ${commenterId} for "${campaign.name}"`);
    await db.recordSend(env.DB, {
      campaignId: campaign.id,
      igUserId: comment.igUserId,
      commentId: comment.commentId,
      commenterId,
      commenterUsername: comment.commenterUsername,
      mediaId: comment.mediaId,
      status: "duplicate",
    });
    return "duplicate";
  }

  const link = campaign.linkId ? await db.getLink(env.DB, campaign.linkId) : null;
  const wrapped = link !== null && link.tracked !== false;

  if (wrapped && !host) {
    // Only reachable from the cron before any request has taught this instance
    // its own hostname. Sending now would promise a link pointing nowhere.
    await account.release(claimKey, commenterId);
    console.error("skip: tracked link needs a hostname, and none has been seen yet");
    return "no-host";
  }

  // Untracked links go out as the destination itself: no click data and no
  // escape from Meta's webview, but the recipient sees a domain they recognise.
  const linkUrl = link ? (wrapped ? `https://${host}/l/${link.code}` : link.targetUrl) : "";

  const substitute = (s: string) =>
    s
      .replace(/\{username\}/g, comment.commenterUsername ?? "there")
      .replace(/\{link\}/g, linkUrl);

  // The DM is where the link belongs, so a campaign whose copy forgot {link}
  // still delivers one rather than promising something it never includes.
  const fillDm = (s: string) =>
    linkUrl && !s.includes("{link}") ? `${substitute(s)}\n\n${linkUrl}` : substitute(s);

  // The public reply must never gain a link it didn't ask for. Its whole job is
  // to drive people to the DM; a link in the comments lets everyone take it
  // without ever messaging, which is the opposite of the point.
  const fillPublic = substitute;

  return account.deliver({
    igUserId: comment.igUserId,
    campaignId: campaign.id,
    kind: "private_reply",
    dedupeKey: claimKey,
    commentId: comment.commentId,
    commenterId,
    commenterUsername: comment.commenterUsername,
    mediaId: comment.mediaId,
    message: fillDm(campaign.dmMessage),
    publicReply: campaign.publicReply ? fillPublic(campaign.publicReply) : undefined,
    successStatus: source === "reconcile" ? "recovered" : "sent",
  });
}

/**
 * Answers a reply to one of the account's stories.
 *
 * Deliberately not folded into handleComment. It shares the matching and the
 * dedupe, but almost none of the reasoning: there is no private reply to spend,
 * no 7-day deadline, no comment to answer publicly under, and the 24-hour window
 * is already open because the reply itself opened it. The one rule that gets
 * stricter is which campaigns are eligible — a campaign pinned to a post is
 * asking about that post, and a story isn't it.
 */
export async function handleStoryReply(
  reply: StoryReplyEvent,
  env: Env,
  host: string,
): Promise<string> {
  // Our own story replies come back when message_echoes is subscribed, and the
  // account can reply to its own story besides.
  if (reply.senderId === reply.igUserId) {
    console.log("skip: story reply is from the connected account");
    return "self";
  }

  const campaigns = await db.activeCampaignsFor(env.DB, reply.igUserId);
  const campaign = campaigns.find(
    (c) =>
      c.storyReplies &&
      c.mediaId === null &&
      matchesKeyword(reply.text, c.keywords, c.matchMode),
  );
  if (!campaign) {
    console.log("skip: no campaign answers story replies for this keyword");
    return "no-match";
  }

  console.log(`matched campaign "${campaign.name}" on a story reply`);

  if (!(await db.getAccountToken(env.DB, env.ENCRYPTION_KEY, reply.igUserId))) {
    console.error(`no usable token for ${reply.igUserId} — reconnect the account`);
    return "no-token";
  }

  const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(reply.igUserId));
  // Namespaced so a story id can never collide with a post id under the same
  // campaign. Per-post scope means a reply to each story earns its own answer,
  // which is the same judgement as answering someone twice across two posts.
  const claimKey = db.dedupeKey(campaign, reply.storyId && `story:${reply.storyId}`);

  if (!(await account.claim(claimKey, reply.senderId))) {
    console.log(`skip: already answered ${reply.senderId} for "${campaign.name}"`);
    await db.recordSend(env.DB, {
      campaignId: campaign.id,
      igUserId: reply.igUserId,
      commentId: reply.messageId,
      commenterId: reply.senderId,
      status: "duplicate",
    });
    return "duplicate";
  }

  const link = campaign.linkId ? await db.getLink(env.DB, campaign.linkId) : null;
  const wrapped = link !== null && link.tracked !== false;

  if (wrapped && !host) {
    await account.release(claimKey, reply.senderId);
    console.error("skip: tracked link needs a hostname, and none has been seen yet");
    return "no-host";
  }

  const linkUrl = link ? (wrapped ? `https://${host}/l/${link.code}` : link.targetUrl) : "";
  const substitute = (s: string) =>
    s.replace(/\{username\}/g, "there").replace(/\{link\}/g, linkUrl);
  const message = linkUrl && !campaign.dmMessage.includes("{link}")
    ? `${substitute(campaign.dmMessage)}\n\n${linkUrl}`
    : substitute(campaign.dmMessage);

  return account.deliver({
    igUserId: reply.igUserId,
    campaignId: campaign.id,
    kind: "dm",
    recipientId: reply.senderId,
    dedupeKey: claimKey,
    commentId: reply.messageId,
    commenterId: reply.senderId,
    message,
    // No comment to sit under, so nothing public to post. Passing the campaign's
    // public reply here would try to reply to a message id and fail every time.
    successStatus: "sent",
  });
}

/**
 * Automated fetchers only.
 *
 * Deliberately excludes a bare "instagram": Instagram's in-app *browser* puts
 * that in its user-agent too, so matching it discarded real clicks from the
 * majority of traffic. Preview fetches are excluded by requiring
 * Sec-Fetch-Mode: navigate, which is the honest signal — user-agent alone can't
 * tell a fetcher from the app's browser.
 */
const CRAWLERS =
  /facebookexternalhit|facebookcatalog|meta-externalagent|bot\b|crawler|spider|preview|slurp|bingpreview|headless/i;

export function isCrawler(userAgent: string): boolean {
  return userAgent === "" || CRAWLERS.test(userAgent);
}

/**
 * True when the comment carries any of a campaign's keywords. Whole-word
 * matching means "link" won't fire on "linking".
 *
 * Blank entries are dropped rather than matched: in contains mode an empty
 * pattern matches every comment ever posted, which would turn one stray comma in
 * the campaign form into a campaign that DMs everybody.
 */
export function matchesKeyword(
  text: string,
  keywords: readonly string[],
  mode: "whole_word" | "contains" = "whole_word",
): boolean {
  return keywords.some((keyword) => {
    if (keyword.trim() === "") return false;
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return mode === "contains"
      ? new RegExp(escaped, "i").test(text)
      : new RegExp(`(^|\\W)${escaped}(\\W|$)`, "i").test(text);
  });
}

/* ------------------------------------------------------------------- crypto */

function stripPrefix(header: string): string {
  return header.startsWith("sha256=") ? header.slice(7) : header;
}

async function hmacHex(body: ArrayBuffer, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, body);
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ parsing */

export interface CommentEvent {
  igUserId: string;
  commentId: string;
  mediaId?: string;
  commenterId?: string;
  commenterUsername?: string;
  text: string;
}

function extractComments(payload: InstagramWebhookPayload): CommentEvent[] {
  const events: CommentEvent[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "comments") continue;
      const v = change.value;
      if (!v?.id) continue;
      events.push({
        igUserId: entry.id,
        commentId: v.id,
        mediaId: v.media?.id,
        commenterId: v.from?.id,
        commenterUsername: v.from?.username,
        text: v.text ?? "",
      });
    }
  }
  return events;
}

export interface StoryReplyEvent {
  igUserId: string;
  /** Meta's message id. Unique, and the only handle a story reply has. */
  messageId: string;
  senderId: string;
  /** The story replied to. Absent if Meta omits it, which costs per-story dedupe
   *  but shouldn't cost the answer. */
  storyId?: string;
  text: string;
}

/**
 * Story replies out of a `messages` delivery.
 *
 * These arrive under `entry[].messaging[]`, not `entry[].changes[]` — a
 * different array on the same envelope, which is why the comment parser sees
 * nothing in them. An ordinary DM is skipped: `reply_to.story` is what marks a
 * message as an answer to a story rather than someone starting a conversation,
 * and freeply has no business auto-answering the latter.
 */
export function extractStoryReplies(payload: InstagramWebhookPayload): StoryReplyEvent[] {
  const events: StoryReplyEvent[] = [];
  for (const entry of payload.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      // Meta has put is_echo on both the envelope and the message over the
      // years; ours coming back as a fresh lead would be an answer to itself.
      if (m.is_echo || m.message?.is_echo) continue;

      const story = m.message?.reply_to?.story;
      if (!story || !m.message?.mid || !m.sender?.id) continue;

      events.push({
        igUserId: entry.id,
        messageId: m.message.mid,
        senderId: m.sender.id,
        storyId: story.id,
        text: m.message.text ?? "",
      });
    }
  }
  return events;
}

export interface PostbackEvent {
  igUserId: string;
  /** Meta's id for the tap. Unique, and the outbox needs one. */
  messageId: string;
  senderId: string;
  /** The campaign id we put in the Ice Breaker when we published it. */
  campaignId: string;
  /** The question they tapped, for the log. */
  title: string;
}

/**
 * Ice Breaker taps out of a `messaging_postbacks` delivery.
 *
 * The payload is the correlation, not the sender id: it comes back exactly as we
 * published it, so it survives whatever Meta does with id namespaces between the
 * profile API and the webhook. Anything without our prefix belongs to something
 * else and is ignored rather than guessed at.
 */
export function extractPostbacks(payload: InstagramWebhookPayload): PostbackEvent[] {
  const events: PostbackEvent[] = [];
  for (const entry of payload.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      const raw = m.postback?.payload;
      if (!raw?.startsWith(ICE_BREAKER_PREFIX)) continue;

      const campaignId = raw.slice(ICE_BREAKER_PREFIX.length);
      if (!campaignId || !m.sender?.id) continue;

      events.push({
        igUserId: entry.id,
        messageId: m.postback?.mid ?? `${campaignId}:${m.sender.id}:${m.timestamp ?? 0}`,
        senderId: m.sender.id,
        campaignId,
        title: m.postback?.title ?? "",
      });
    }
  }
  return events;
}

/**
 * Answers an Ice Breaker tap.
 *
 * Closest thing Meta permits to messaging a new follower: the prompts appear
 * when someone opens a DM with the account for the first time, which is what
 * following and then tapping Message looks like. The tap is an inbound event, so
 * the 24-hour window is open by the time we're deciding — same as a story reply,
 * and unlike a private reply there's nothing one-shot to protect.
 *
 * Routes by the campaign id in the payload rather than by matching keywords:
 * they tapped a specific question, and which one they tapped is the intent.
 */
export async function handlePostback(
  event: PostbackEvent,
  env: Env,
  host: string,
): Promise<string> {
  if (event.senderId === event.igUserId) return "self";

  const campaign = await db.getCampaign(env.DB, event.campaignId);
  if (!campaign || !campaign.active || campaign.igUserId !== event.igUserId) {
    // A question published before the campaign was deleted, paused, or moved.
    // Meta still shows it until the next publish, so this is reachable.
    console.log(`skip: ice breaker points at no active campaign (${event.campaignId})`);
    return "no-campaign";
  }

  console.log(`matched campaign "${campaign.name}" on ice breaker "${event.title}"`);

  if (!(await db.getAccountToken(env.DB, env.ENCRYPTION_KEY, event.igUserId))) {
    console.error(`no usable token for ${event.igUserId} — reconnect the account`);
    return "no-token";
  }

  const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(event.igUserId));
  const claimKey = db.dedupeKey(campaign, "ice-breaker");

  if (!(await account.claim(claimKey, event.senderId))) {
    console.log(`skip: already answered ${event.senderId} for "${campaign.name}"`);
    await db.recordSend(env.DB, {
      campaignId: campaign.id,
      igUserId: event.igUserId,
      commentId: event.messageId,
      commenterId: event.senderId,
      status: "duplicate",
    });
    return "duplicate";
  }

  const link = campaign.linkId ? await db.getLink(env.DB, campaign.linkId) : null;
  const wrapped = link !== null && link.tracked !== false;

  if (wrapped && !host) {
    await account.release(claimKey, event.senderId);
    console.error("skip: tracked link needs a hostname, and none has been seen yet");
    return "no-host";
  }

  const linkUrl = link ? (wrapped ? `https://${host}/l/${link.code}` : link.targetUrl) : "";
  const substitute = (s: string) =>
    s.replace(/\{username\}/g, "there").replace(/\{link\}/g, linkUrl);
  const message =
    linkUrl && !campaign.dmMessage.includes("{link}")
      ? `${substitute(campaign.dmMessage)}\n\n${linkUrl}`
      : substitute(campaign.dmMessage);

  return account.deliver({
    igUserId: event.igUserId,
    campaignId: campaign.id,
    kind: "dm",
    recipientId: event.senderId,
    dedupeKey: claimKey,
    commentId: event.messageId,
    commenterId: event.senderId,
    message,
    successStatus: "sent",
  });
}

interface InstagramWebhookPayload {
  object?: string;
  entry?: Array<{
    id: string;
    time?: number;
    messaging?: Array<{
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      is_echo?: boolean;
      postback?: { mid?: string; title?: string; payload?: string };
      message?: {
        mid?: string;
        text?: string;
        is_echo?: boolean;
        reply_to?: { story?: { id?: string; url?: string } };
      };
    }>;
    changes?: Array<{
      field?: string;
      value?: {
        id?: string;
        text?: string;
        media?: { id?: string };
        from?: { id?: string; username?: string };
      };
    }>;
  }>;
}
