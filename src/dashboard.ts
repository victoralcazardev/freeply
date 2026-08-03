import type { Account, Campaign, Link, MediaItem, PostPerformance, Send } from "./db";
import { MAX_ICE_BREAKERS } from "./instagram";

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type Tab = "overview" | "campaigns" | "links" | "settings";

/**
 * Prefilled campaign copy. Values, not placeholders — a new campaign should be a
 * keyword and a URL away from finished.
 *
 * The DM's closing line invites a reply on purpose: Instagram allows exactly one
 * private reply per commenter, but if they write back a 24-hour window opens.
 * Asking for a reply is the only way to earn that.
 */
export const DEFAULTS = {
  keywords: "LINK",
  dmMessage:
    "Hey {username}! \u{1F64C} Here's the link you asked for:\n\n" +
    "{link}\n\n" +
    "Any questions, just reply to this message and I'll get back to you.",
  publicReply:
    "Just sent it \u{1F4E9} Check your DMs — it might land in your message requests.",
};

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --fg: #1a1a18; --muted: #6b6b66;
  --line: #e2e2dd; --card: #fff; --accent: #b4491f; --ok: #2f7d4f; --bad: #b3261e;
  --warnbg: #fdf3ec;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16161a; --fg: #ececE8; --muted: #9a9a94;
    --line: #2c2c33; --card: #1e1e23; --accent: #e8814f; --ok: #6cc48c; --bad: #f2857c;
    --warnbg: #2a1f1a;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; }
.wrap { max-width: 64rem; margin: 0 auto; padding: 1.75rem 1.25rem 5rem; }
header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: 1.25rem; }
h1 { font-size: 1.3rem; margin: 0; letter-spacing: -.01em; }
h2 { font-size: 1rem; margin: 2rem 0 .7rem; letter-spacing: -.01em; }
h2:first-of-type { margin-top: 0; }
a { color: var(--accent); }
.muted { color: var(--muted); }
.small { font-size: .85rem; }

nav { display: flex; gap: .25rem; border-bottom: 1px solid var(--line); margin-bottom: 1.75rem; }
nav a { padding: .5rem .85rem; text-decoration: none; color: var(--muted);
  border-bottom: 2px solid transparent; margin-bottom: -1px; font-size: .92rem; }
nav a.on { color: var(--fg); border-bottom-color: var(--accent); font-weight: 500; }
nav a:hover { color: var(--fg); }

.card { background: var(--card); border: 1px solid var(--line);
  border-radius: 10px; padding: 1rem 1.15rem; margin-bottom: .75rem; }
.row { display: flex; gap: 1rem; align-items: center; justify-content: space-between; }
.alert { background: var(--warnbg); border: 1px solid var(--bad);
  border-radius: 10px; padding: .8rem 1rem; margin-bottom: 1.25rem; font-size: .9rem; }
.alert b { display: block; margin-bottom: .15rem; }

.stats { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: .7rem 1rem; min-width: 6.5rem; }
.stat b { display: block; font-size: 1.4rem; font-weight: 600; }
a.stat { text-decoration: none; color: inherit; display: block; }
a.stat:hover, a.stat.on { border-color: var(--accent); }

label { display: block; font-size: .82rem; color: var(--muted); margin: .7rem 0 .25rem; }
input, textarea, select { width: 100%; padding: .5rem .6rem; font: inherit; font-size: .9rem;
  background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 7px; }
textarea { min-height: 4.5rem; resize: vertical; }
button { font: inherit; font-size: .88rem; padding: .45rem .9rem; border-radius: 7px;
  border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { color: var(--bad); }
button:hover { filter: brightness(1.07); }

.tag { font-size: .72rem; padding: .1rem .45rem; border-radius: 20px;
  border: 1px solid var(--line); color: var(--muted); }
.tag.on { color: var(--ok); border-color: var(--ok); }
.tag.warn { color: var(--bad); border-color: var(--bad); }

table { width: 100%; border-collapse: collapse; font-size: .87rem; }
th { text-align: left; font-weight: 500; color: var(--muted); font-size: .78rem;
  padding: .4rem .5rem; border-bottom: 1px solid var(--line); }
td { padding: .5rem; border-bottom: 1px solid var(--line); }
.scroll { overflow-x: auto; }
.sent { color: var(--ok); } .failed { color: var(--bad); }
form.inline { display: inline; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 1rem; }
@media (max-width: 40rem) { .grid { grid-template-columns: 1fr; } }

.choice { margin-top: .6rem; display: grid; gap: .5rem; }
.choice label { display: flex; gap: .5rem; align-items: flex-start; margin: 0;
  font-size: .84rem; color: var(--fg); line-height: 1.45; }
.choice input { width: auto; margin-top: .2rem; flex: 0 0 auto; }
.choice b { font-weight: 600; }

.picker { max-height: 17rem; overflow-y: auto; border: 1px solid var(--line);
  border-radius: 8px; padding: .6rem .7rem; }

.post { display: flex; align-items: center; gap: .55rem; min-width: 13rem; }
.post img, .thumb-fallback { width: 40px; height: 40px; border-radius: 6px;
  object-fit: cover; flex: 0 0 auto; background: var(--line); }
.post span { font-size: .84rem; line-height: 1.35; }
a:has(.post) { text-decoration: none; color: inherit; }
a:has(.post):hover span { color: var(--accent); }
`;

function page(title: string, body: string, brand = "Freeply"): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<link rel="icon" type="image/svg+xml" href="/icon.svg">` +
      `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)} — ${esc(brand)}</title><style>${STYLE}</style></head>` +
      `<body><div class="wrap">${body}</div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export function loginPage(error?: string, next?: string, brand?: string): Response {
  // `next` carries where the visitor was actually going. Without it every sign-in
  // lands on the Freeply dashboard — so opening the cash.builds workspace cold
  // dumped you somewhere you didn't ask for.
  // `brand` is the hostname's own answer and outranks `next`: on the workspace
  // domain every sign-in is a cash.builds sign-in, whatever path asked for it.
  const heading = brand ?? (next === "/workspace" ? "cash.builds" : "Freeply");
  return page(
    "Sign in",
    `<header><h1>${esc(heading)}</h1></header>
     ${error ? `<p class="card" style="color:var(--bad)">${esc(error)}</p>` : ""}
     <form method="post" action="/login" class="card" style="max-width:22rem">
       ${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ""}
       <label for="p">Dashboard password</label>
       <input id="p" type="password" name="password" autofocus autocomplete="current-password">
       <p><button class="primary" type="submit">Sign in</button></p>
     </form>`,
    heading,
  );
}

/**
 * Campaigns that can never fire because other active campaigns already cover
 * every keyword they watch, on the same account and the same posts. Resolution
 * takes the newest match, so the older one is dead — silently, which is the part
 * worth surfacing.
 *
 * A post-specific campaign is NOT shadowed by an account-wide one on the same
 * keyword: the specific one wins on its own post, the broad one covers the rest.
 *
 * Match mode decides coverage rather than joining the key. Contains matches
 * everything whole word does and more, so it shadows a whole-word campaign — but
 * a whole-word campaign leaves an older contains one alive, because "LINKKK"
 * misses the strict one and still falls through to the loose one.
 *
 * A campaign watching several keywords is only dead when all of them are taken.
 */
export function shadowedIds(campaigns: Campaign[]): Set<string> {
  const claimed = new Map<string, Set<Campaign["matchMode"]>>();
  const shadowed = new Set<string>();

  // Resolution always takes the newest matching campaign, so shadowing has to be
  // judged newest-first — sorted here rather than trusting the caller's order.
  // Equal timestamps keep their incoming order, since the sort is stable.
  const newestFirst = [...campaigns].sort((a, b) => b.createdAt - a.createdAt);

  for (const c of newestFirst) {
    if (!c.active || c.keywords.length === 0) continue;

    let covered = true;
    for (const keyword of c.keywords) {
      const scope = `${c.igUserId}|${keyword.toLowerCase()}|${c.mediaId ?? "*"}`;
      const modes = claimed.get(scope);
      if (!modes?.has("contains") && !modes?.has(c.matchMode)) covered = false;

      if (modes) modes.add(c.matchMode);
      else claimed.set(scope, new Set([c.matchMode]));
    }

    if (covered) shadowed.add(c.id);
  }
  return shadowed;
}

const DAY_MS = 86400000;

/** Problems worth interrupting for, on whichever tab you're looking at. */
function alerts(accounts: Account[], shadowedCount: number): string {
  const items: string[] = [];

  if (accounts.length === 0) {
    items.push(
      `<b>No Instagram account connected.</b> Nothing can send until you connect one in
       <a href="/?tab=settings">Settings</a>.`,
    );
  }

  for (const a of accounts) {
    // The cron gave up, so the countdown below is no longer the story — nothing
    // will renew this token and only a human can replace it.
    if (a.needsReconnect) {
      items.push(
        `<b>@${esc(a.username)} needs reconnecting.</b> Automatic token refresh failed
         and won't be retried${a.reconnectReason ? `: ${esc(a.reconnectReason)}` : "."}
         <a href="/auth/start">Reconnect</a> to resume sending.`,
      );
      continue;
    }

    if (!a.tokenExpiresAt) continue;
    const days = Math.round((a.tokenExpiresAt - Date.now()) / DAY_MS);
    if (days < 0) {
      items.push(
        `<b>@${esc(a.username)}'s access expired.</b> Sending has stopped.
         <a href="/auth/start">Reconnect</a> to resume.`,
      );
    } else if (days <= 10) {
      items.push(
        `<b>@${esc(a.username)}'s access expires in ${days} day${days === 1 ? "" : "s"}.</b>
         <a href="/auth/start">Reconnect</a> before it lapses — once expired, sending stops
         until you do.`,
      );
    }
  }

  if (shadowedCount > 0) {
    items.push(
      `<b>${shadowedCount} campaign${shadowedCount > 1 ? "s" : ""} can never fire.</b>
       Newer active campaigns already match every keyword ${shadowedCount > 1 ? "they watch" : "it watches"},
       on the same account and posts — see <a href="/?tab=campaigns">Campaigns</a>.`,
    );
  }

  return items.map((i) => `<div class="alert">${i}</div>`).join("");
}

function nav(tab: Tab): string {
  const tabs: Array<[Tab, string]> = [
    ["overview", "Overview"],
    ["campaigns", "Campaigns"],
    ["links", "Links"],
    ["settings", "Settings"],
  ];
  return `<nav>${tabs
    .map(
      ([id, label]) =>
        `<a href="/?tab=${id}" class="${tab === id ? "on" : ""}">${label}</a>`,
    )
    .join("")}</nav>`;
}

export function dashboardPage(data: {
  accounts: Account[];
  campaigns: Campaign[];
  links: Link[];
  sends: Send[];
  stats: { sent: number; failed: number; duplicate: number };
  posts: PostPerformance[];
  /** Cached recent posts, for the campaign form's picker. */
  media: MediaItem[];
  host: string;
  tab: Tab;
  editing: Campaign | null;
  filter: { status?: string; error?: string };
}): Response {
  const { accounts, campaigns, links, sends, stats, posts, media, host, tab, editing, filter } =
    data;
  const shadowed = shadowedIds(campaigns);
  const accountName = (id: string) =>
    accounts.find((a) => a.igUserId === id)?.username ?? id;

  const body =
    tab === "campaigns"
      ? campaignsTab(campaigns, accounts, links, media, shadowed, accountName, editing)
      : tab === "links"
        ? linksTab(links, host)
        : tab === "settings"
          ? settingsTab(accounts, campaigns)
          : overviewTab(stats, posts, sends, filter);

  return page(
    "Dashboard",
    `<header>
       <h1>Freeply</h1>
       <span class="muted small">${esc(host)}</span>
       <form method="post" action="/logout" style="margin-left:auto">
         <button class="small">Sign out</button>
       </form>
     </header>
     ${filter.error ? `<div class="alert">${esc(filter.error)}</div>` : ""}
     ${alerts(accounts, shadowed.size)}
     ${nav(tab)}
     ${body}`,
  );
}

/* ---------------------------------------------------------------- overview */

function overviewTab(
  stats: { sent: number; failed: number; duplicate: number },
  posts: PostPerformance[],
  sends: Send[],
  filter: { status?: string },
): string {
  const num = (n: number | null) => (n === null ? "—" : String(n));

  return `
    <div class="stats">
      ${(
        [
          ["sent", stats.sent],
          ["duplicate", stats.duplicate],
          ["failed", stats.failed],
        ] as const
      )
        .map(
          ([key, n]) => `<a class="stat ${filter.status === key ? "on" : ""}"
             href="/?tab=overview&status=${key}" title="Show only ${key} below">
             <b>${n}</b><span class="muted small">${key === "duplicate" ? "deduped" : key}</span></a>`,
        )
        .join("")}
    </div>

    <h2>Post performance
      <form method="post" action="/refresh" style="display:inline;margin-left:8px">
        <button class="small" title="Re-read posts and stats from Instagram right now, ignoring the cache">Refresh now</button>
      </form>
    </h2>
    ${
      posts.length === 0
        ? `<div class="card muted">No posts have produced DMs yet.</div>`
        : `<div class="card scroll"><table>
            <tr><th>Post</th><th>Reach</th><th>Likes</th><th>Comments</th><th>DMs</th><th>DM rate</th></tr>
            ${posts
              .map((p) => {
                const caption = (p.caption ?? "").replace(/\s+/g, " ").trim();
                const label = caption
                  ? caption.length > 55
                    ? `${caption.slice(0, 55)}…`
                    : caption
                  : (p.mediaType?.toLowerCase() ?? p.mediaId);
                const preview = `<div class="post">
                    ${
                      p.thumbnailUrl
                        ? `<img src="${esc(p.thumbnailUrl)}" alt="" loading="lazy">`
                        : `<div class="thumb-fallback"></div>`
                    }
                    <span>${esc(label)}</span>
                  </div>`;
                const rate =
                  p.reach && p.reach > 0 ? `${((p.sent / p.reach) * 100).toFixed(1)}%` : "—";
                return `<tr>
                  <td>${
                    p.permalink
                      ? `<a href="${esc(p.permalink)}" target="_blank" rel="noopener"
                            title="Open on Instagram">${preview}</a>`
                      : preview
                  }</td>
                  <td>${num(p.reach)}</td><td>${num(p.likes)}</td><td>${num(p.comments)}</td>
                  <td><b>${p.sent}</b></td><td>${rate}</td>
                </tr>`;
              })
              .join("")}
          </table>
          <p class="small muted" style="margin:.6rem 0 0">DM rate is DMs sent as a share of
          reach — how much of the audience the campaign converted into a conversation. Click-through
          on the link itself is under <a href="/?tab=links">Links</a>. Metrics refresh every 15
          minutes; a dash means Instagram doesn't report that one for this post type.</p>
          </div>`
    }

    <h2>Recent sends${filter.status ? ` — ${esc(filter.status)} only` : ""}</h2>
    ${filter.status ? `<p class="small"><a href="/?tab=overview">Clear filter</a></p>` : ""}
    ${
      sends.length === 0
        ? `<div class="card muted">Nothing sent yet.</div>`
        : `<div class="card scroll"><table>
            <tr><th>When</th><th>To</th><th>Status</th><th>Detail</th></tr>
            ${sends
              .map(
                (s) => `<tr>
                  <td class="muted">${new Date(s.createdAt).toLocaleString()}</td>
                  <td>${s.commenterUsername ? "@" + esc(s.commenterUsername) : "—"}</td>
                  <td class="${esc(s.status)}">${esc(s.status)}</td>
                  <td class="muted small">${esc(s.error ?? "")}</td>
                </tr>`,
              )
              .join("")}
          </table></div>`
    }`;
}

/* --------------------------------------------------------------- campaigns */

/**
 * The value of the "paste an ID" radio. Post IDs are numeric, so nothing real
 * collides with it.
 */
export const MANUAL_MEDIA = "manual";

/** One post in the picker: thumbnail, caption snippet, and when it went up. */
function mediaOption(m: MediaItem, handle: string | null, selected: string): string {
  const caption = (m.caption ?? "").replace(/\s+/g, " ").trim();
  const label = caption
    ? caption.length > 60
      ? `${caption.slice(0, 60)}…`
      : caption
    : (m.mediaType?.toLowerCase().replace(/_/g, " ") ?? "post");
  const meta = [
    handle ? `@${handle}` : "",
    m.postedAt ? new Date(m.postedAt).toLocaleDateString() : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return `<label><input type="radio" name="media_id" value="${esc(m.mediaId)}"${
    m.mediaId === selected ? " checked" : ""
  }>
    <span class="post">
      ${
        m.thumbnailUrl
          ? `<img src="${esc(m.thumbnailUrl)}" alt="" loading="lazy">`
          : `<div class="thumb-fallback"></div>`
      }
      <span>${esc(label)}${
        meta ? `<br><span class="muted small">${esc(meta)}</span>` : ""
      }</span>
    </span></label>`;
}

/**
 * Post picker, falling back to the raw ID field when there's nothing cached —
 * an account with no posts, or one whose media couldn't be read.
 *
 * Server-rendered radios rather than a filtered list, because the account
 * dropdown can't be reacted to without client-side JS. With more than one
 * account connected, each post carries its handle instead.
 */
function mediaField(
  media: MediaItem[],
  accounts: Account[],
  selected: string,
  handle: (id: string) => string,
): string {
  if (media.length === 0) {
    return `<label for="media">Post ID <span class="muted">— blank means any post</span></label>
      <input id="media" name="media_id" value="${esc(selected)}">`;
  }

  const known = media.some((m) => m.mediaId === selected);
  const manual = selected !== "" && !known;
  const showHandle = accounts.length > 1;

  return `<label>Post <span class="muted">— whose comments this campaign watches</span></label>
    <div class="choice picker">
      <label><input type="radio" name="media_id" value=""${selected === "" ? " checked" : ""}>
        <span><b>Any post</b> on the account</span></label>
      ${media
        .map((m) => mediaOption(m, showHandle ? handle(m.igUserId) : null, selected))
        .join("")}
      <label><input type="radio" name="media_id" value="${MANUAL_MEDIA}"${manual ? " checked" : ""}>
        <span><b>Another post</b> — paste its ID below</span></label>
    </div>
    <input id="media" name="media_id_manual" value="${manual ? esc(selected) : ""}"
           placeholder="17912345678901234" inputmode="numeric" spellcheck="false"
           style="margin-top:.4rem">`;
}

function campaignForm(
  accounts: Account[],
  links: Link[],
  media: MediaItem[],
  accountName: (id: string) => string,
  editing: Campaign | null,
): string {
  const v = {
    name: editing?.name ?? "",
    keywords: editing ? editing.keywords.join(", ") : DEFAULTS.keywords,
    mediaId: editing?.mediaId ?? "",
    dmMessage: editing?.dmMessage ?? DEFAULTS.dmMessage,
    publicReply: editing?.publicReply ?? DEFAULTS.publicReply,
    matchMode: editing?.matchMode ?? "contains",
    dedupeScope: editing?.dedupeScope ?? "per_post",
    storyReplies: editing?.storyReplies ?? false,
    iceBreaker: editing?.iceBreaker ?? "",
    igUserId: editing?.igUserId ?? "",
  };
  const currentLink = editing?.linkId
    ? links.find((l) => l.id === editing.linkId)
    : undefined;

  return `<form method="post" action="${editing ? `/campaigns/${esc(editing.id)}/update` : "/campaigns"}" class="card">
      <div class="grid">
        <div>
          <label for="name">Name</label>
          <input id="name" name="name" required value="${esc(v.name)}" placeholder="e.g. October giveaway">
        </div>
        <div>
          <label for="account">Account</label>
          <select id="account" name="ig_user_id" required>
            ${accounts
              .map(
                (a) =>
                  `<option value="${esc(a.igUserId)}"${a.igUserId === v.igUserId ? " selected" : ""}>@${esc(a.username)}</option>`,
              )
              .join("")}
          </select>
        </div>
        <div>
          <label for="keywords">Keywords <span class="muted">— comma-separated; any one fires</span></label>
          <input id="keywords" name="keywords" required value="${esc(v.keywords)}">
        </div>
        <div>
          <label for="match">Match</label>
          <select id="match" name="match_mode">
            <option value="contains"${v.matchMode === "contains" ? " selected" : ""}>Contains — also catches LINKKK, linkk</option>
            <option value="whole_word"${v.matchMode === "whole_word" ? " selected" : ""}>Whole word — LINK but not linking</option>
          </select>
        </div>
      </div>
      ${mediaField(media, accounts, v.mediaId, accountName)}
      <div class="choice">
        <label><input type="radio" name="dedupe_scope" value="per_post"${
          v.dedupeScope === "campaign" ? "" : " checked"
        }>
          <span><b>Once per post</b> — someone who comments again on a different post
          is messaged again. Only has an effect on an account-wide campaign; pin this
          campaign to a post above and the two settings are the same thing.</span></label>
        <label><input type="radio" name="dedupe_scope" value="campaign"${
          v.dedupeScope === "campaign" ? " checked" : ""
        }>
          <span><b>Once per person</b> — one message from this campaign however many
          posts they comment on. Right when every post sends the same thing.</span></label>
      </div>
      <label class="small" style="display:flex;gap:.4rem;align-items:center;margin-top:.5rem">
        <input type="checkbox" name="story_replies" value="1"${
          v.storyReplies ? " checked" : ""
        } style="width:auto">
        Also answer replies to your stories. No private reply is spent and there's no
        7-day limit — a story reply is an ordinary DM, so the window is already open.
        Account-wide campaigns only.
      </label>
      <label for="link">Link to send <span class="muted">— optional. A tracked short link is created automatically.${
        currentLink
          ? ` Point it somewhere new to replace it — the current short link keeps its clicks. Clearing this box leaves it as it is; use the checkbox below to remove it.`
          : ""
      }</span></label>
      <input id="link" name="link_url" type="text" inputmode="url" autocapitalize="off"
             spellcheck="false" value="${esc(currentLink?.targetUrl ?? "")}"
             placeholder="example.com/offer">
      <div class="choice">
        <label><input type="radio" name="track_link" value="yes"${
          currentLink?.tracked === false ? "" : " checked"
        }>
          <span><b>Track clicks</b> — sends a short link on your domain. Gives you
          click-through data, and opens in the visitor's real browser instead of Meta's
          in-app one.</span></label>
        <label><input type="radio" name="track_link" value="no"${
          currentLink?.tracked === false ? " checked" : ""
        }>
          <span><b>Send the URL as-is</b> — recipients see your actual domain, which reads
          as more trustworthy in a DM. No click data, and it opens inside Meta's browser.</span></label>
      </div>
      ${
        currentLink
          ? `<label class="small" style="display:flex;gap:.4rem;align-items:center;margin-top:.5rem">
               <input type="checkbox" name="remove_link" value="1" style="width:auto">
               Remove the link from this campaign
             </label>`
          : ""
      }
      <label for="ice">Ice breaker question <span class="muted">— optional, max 80 characters. A tappable
        prompt shown when someone opens a DM with you for the first time, which is what a new
        follower does when they tap Message. Tapping it sends this campaign's DM. Four per
        account; publish them from the button below the form.</span></label>
      <input id="ice" name="ice_breaker" type="text" maxlength="80"
             value="${esc(v.iceBreaker)}" placeholder="Send me the free guide">
      <label for="dm">DM message <span class="muted">— {username} and {link} are substituted. If you set a link and don't use {link}, it's appended.</span></label>
      <textarea id="dm" name="dm_message" required>${esc(v.dmMessage)}</textarea>
      <label for="pub">Public reply <span class="muted">— blank to skip. Private replies land in Requests, so this is what gets them opened. Never contains the link.</span></label>
      <textarea id="pub" name="public_reply">${esc(v.publicReply)}</textarea>
      <p><button class="primary" type="submit">${editing ? "Save changes" : "Create campaign"}</button>
         ${editing ? `<a href="/?tab=campaigns"><button type="button">Cancel</button></a>` : ""}</p>
    </form>`;
}

function campaignsTab(
  campaigns: Campaign[],
  accounts: Account[],
  links: Link[],
  media: MediaItem[],
  shadowed: Set<string>,
  accountName: (id: string) => string,
  editing: Campaign | null,
): string {
  if (editing) {
    return `<h2>Edit campaign</h2>${campaignForm(accounts, links, media, accountName, editing)}`;
  }
  return `
    <h2>Campaigns</h2>
    ${
      campaigns.length === 0
        ? `<div class="card muted">No campaigns yet. Create one below.</div>`
        : campaigns
            .map(
              (c) => `<div class="card">
                <div class="row">
                  <div><b>${esc(c.name)}</b>
                    <span class="tag ${c.active ? "on" : ""}">${c.active ? "active" : "paused"}</span>
                    ${
                      shadowed.has(c.id)
                        ? `<span class="tag warn" title="Newer active campaigns already match every keyword this one watches, on the same posts. Newest wins, so this never fires.">never fires</span>`
                        : ""
                    }<br>
                    <span class="small muted">@${esc(accountName(c.igUserId))} ·
                      ${c.keywords.length > 1 ? "keywords" : "keyword"}
                      <b>${esc(c.keywords.join(", "))}</b> · ${esc(c.matchMode.replace("_", " "))}
                      ${c.mediaId ? `· post ${esc(c.mediaId)}` : "· any post"}</span>
                  </div>
                  <div style="display:flex;gap:.4rem">
                    <a href="/?tab=campaigns&edit=${esc(c.id)}"><button class="small">Edit</button></a>
                    <form method="post" action="/campaigns/${esc(c.id)}/toggle" class="inline">
                      <button class="small">${c.active ? "Pause" : "Activate"}</button>
                    </form>
                    <form method="post" action="/campaigns/${esc(c.id)}/delete" class="inline"
                          onsubmit="return confirm('Delete ${esc(c.name)}?\\n\\nIts send history and post performance go with it.')">
                      <button class="danger small">Delete</button>
                    </form>
                  </div>
                </div>
                <p class="small muted" style="margin:.6rem 0 0">DM: ${esc(c.dmMessage)}</p>
                ${c.publicReply ? `<p class="small muted" style="margin:.2rem 0 0">Public: ${esc(c.publicReply)}</p>` : ""}
              </div>`,
            )
            .join("")
    }

    ${iceBreakerPanel(campaigns, accounts, accountName)}

    <h2>New campaign</h2>
    ${
      accounts.length === 0
        ? `<div class="card muted">Connect an Instagram account in
           <a href="/?tab=settings">Settings</a> first.</div>`
        : campaignForm(accounts, links, media, accountName, null)
    }`;
}

/**
 * Ice Breakers live on Meta's servers, not here, so this shows what *would* be
 * published rather than what is. Anything else would be a claim we can't check
 * without asking Meta on every page load.
 */
function iceBreakerPanel(
  campaigns: Campaign[],
  accounts: Account[],
  accountName: (igUserId: string) => string,
): string {
  if (accounts.length === 0) return "";

  return accounts
    .map((account) => {
      const questions = campaigns.filter(
        (c) => c.active && c.igUserId === account.igUserId && c.iceBreaker,
      );
      const over = questions.length > MAX_ICE_BREAKERS;

      return `<h2>Ice breakers <span class="small muted">@${esc(accountName(account.igUserId))}</span></h2>
      <div class="card">
        <p class="small muted" style="margin:0 0 .6rem">Shown when someone opens a DM with you
        for the first time — the closest thing Instagram allows to messaging a new follower,
        since Meta publishes no follow event at all. Tapping one opens a 24-hour window and
        sends that campaign's DM.</p>
        ${
          questions.length === 0
            ? `<p class="small muted" style="margin:0">No campaign on this account has a question yet.
               Add one in the campaign form and publish.</p>`
            : `<ol class="small" style="margin:0 0 .6rem 1.1rem">
                 ${questions
                   .slice(0, MAX_ICE_BREAKERS)
                   .map((c) => `<li>${esc(c.iceBreaker ?? "")} <span class="muted">→ ${esc(c.name)}</span></li>`)
                   .join("")}
               </ol>
               ${
                 over
                   ? `<p class="small warn" style="margin:0 0 .6rem">Instagram allows ${MAX_ICE_BREAKERS};
                      the ${questions.length - MAX_ICE_BREAKERS} oldest won't be published.</p>`
                   : ""
               }`
        }
        <form method="post" action="/ice-breakers/publish" class="inline">
          <input type="hidden" name="ig_user_id" value="${esc(account.igUserId)}">
          <button class="small">${questions.length === 0 ? "Clear ice breakers on Instagram" : "Publish to Instagram"}</button>
        </form>
        <span class="small muted">Replaces whatever is live now — Meta stores one set per account.</span>
      </div>`;
    })
    .join("");
}

/* ------------------------------------------------------------------- links */

function linksTab(links: Link[], host: string): string {
  return `
    <h2>Tracked links</h2>
    ${
      links.length === 0
        ? `<div class="card muted">No links yet — add one to a campaign and it appears here.</div>`
        : `<div class="card scroll"><table>
            <tr><th>Campaign</th><th>Short</th><th>Target</th><th>DMs</th><th>Clicks</th><th>CTR</th><th></th></tr>
            ${links
              .map((l) => {
                const dms = l.dmsSent ?? 0;
                const untracked = l.tracked === false;
                const ctr = untracked
                  ? "—"
                  : dms > 0
                    ? `${((l.clicks / dms) * 100).toFixed(0)}%`
                    : "—";
                return `<tr>
                  <td>${l.campaignName ? esc(l.campaignName) : `<span class="tag warn">unused</span>`}</td>
                  <td>${
                    untracked
                      ? `<span class="small muted" title="Sent as-is, so there's nothing to count.">not tracked</span>`
                      : `<a href="https://${esc(host)}/l/${esc(l.code)}">/l/${esc(l.code)}</a>`
                  }</td>
                  <td class="muted">${esc(l.targetUrl)}</td>
                  <td>${dms}</td>
                  <td>${untracked ? "—" : `<b>${l.clicks}</b>`}</td>
                  <td>${ctr}</td>
                  <td>${
                    l.campaignName
                      ? `<span class="small muted" title="In use by ${esc(l.campaignName)} — delete or repoint that campaign first.">in use</span>`
                      : `<form method="post" action="/links/${esc(l.id)}/delete" class="inline"
                             onsubmit="return confirm('Delete this link?\n\nAnyone who already received it gets a dead URL.')">
                           <button class="danger small">Delete</button></form>`
                  }</td>
                </tr>`;
              })
              .join("")}
          </table>
          <p class="small muted" style="margin:.6rem 0 0">CTR is clicks as a share of DMs sent —
          how many recipients actually opened the link. Requests from link preview crawlers
          aren't counted.</p>
          </div>
          ${
            links.some((l) => !l.campaignName)
              ? `<form method="post" action="/links/prune">
                   <button class="small">Remove unused links</button>
                 </form>`
              : ""
          }`
    }`;
}

/* ---------------------------------------------------------------- settings */

function settingsTab(accounts: Account[], campaigns: Campaign[]): string {
  const expiry = (a: Account) => {
    if (!a.tokenExpiresAt) return "";
    const days = Math.round((a.tokenExpiresAt - Date.now()) / DAY_MS);
    if (days < 0) return `<span class="tag warn">expired</span>`;
    const cls = days <= 10 ? ' style="color:var(--bad)"' : "";
    return `<span class="small muted"${cls}>access expires in ${days}d</span>`;
  };

  return `
    <h2>Instagram accounts</h2>
    ${
      accounts.length === 0
        ? `<div class="card muted">No accounts connected.</div>`
        : accounts
            .map(
              (a) => `<div class="card row">
                <div><b>@${esc(a.username)}</b><br>
                  <span class="small muted">${esc(a.igUserId)}</span> ${expiry(a)}</div>
                <div style="display:flex;gap:.4rem">
                  <a href="/auth/start"><button class="small"
                     title="Re-runs authorization and replaces the stored access. Campaigns are kept.">Reconnect</button></a>
                  <form method="post" action="/accounts/${esc(a.igUserId)}/delete"
                        onsubmit="return confirm('Disconnect @${esc(a.username)}?\\n\\nThis DELETES its campaigns as well. To refresh expiring access or pick up new permissions, use Reconnect instead.')">
                    <button class="danger small">Disconnect</button>
                  </form>
                </div>
              </div>`,
            )
            .join("")
    }
    <p><a href="/auth/start"><button class="primary">Connect an Instagram account</button></a>
       <span class="small muted">Reconnecting an existing account keeps its campaigns.</span></p>

    <h2>Send history</h2>
    <div class="card">
      <p class="small muted" style="margin:0 0 .8rem">
        Clearing history also clears the post performance figures derived from it — DM counts
        and rates are rebuilt from these records. Dedupe is stored separately, so clearing
        never lets someone be messaged twice.
      </p>
      ${
        campaigns.length > 0
          ? `<form method="post" action="/sends/clear" style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
               <div style="flex:1;min-width:14rem">
                 <label for="camp">Clear history for</label>
                 <select id="camp" name="campaign_id">
                   <option value="">Every campaign</option>
                   ${campaigns.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}
                 </select>
               </div>
               <button class="danger"
                 onclick="return confirm('Clear send history?\\n\\nThis permanently deletes those records and the post performance built from them. It cannot be undone.')">
                 Clear history
               </button>
             </form>`
          : `<p class="small muted" style="margin:0">No campaigns to clear.</p>`
      }
    </div>

    <h2>Testing</h2>
    <div class="card">
      <p class="small muted" style="margin:0 0 .8rem">
        Freeply refuses to message the same person twice for a campaign, which is why a
        repeat comment shows as <b>deduped</b> rather than sending. Resetting forgets who has
        been messaged so you can test with the same account again.
        <br><br>
        Only useful for testing: Instagram itself permits one private reply per commenter, so
        in real use a reset produces failed sends rather than second messages.
      </p>
      ${
        accounts.length === 0
          ? `<p class="small muted" style="margin:0">No accounts connected.</p>`
          : accounts
              .map(
                (a) => `<form method="post" action="/dedupe/clear" class="inline">
                  <input type="hidden" name="ig_user_id" value="${esc(a.igUserId)}">
                  <button onclick="return confirm('Forget everyone already messaged from @${esc(a.username)}?')">
                    Reset dedupe for @${esc(a.username)}
                  </button>
                </form>`,
              )
              .join(" ")
      }
    </div>`;
}
