/**
 * Media hosting for the cash.builds workspace.
 *
 * Reels live in R2, not in the Worker bundle — a 6MB mp4 blows the script size
 * limit and would ride every cold start. Two read-only routes, both behind the
 * dashboard session the caller has already checked:
 *
 *   GET /files        an index, grouped by folder, newest first
 *   GET /files/<key>  the object itself, streamed
 *
 * There is deliberately no upload route. An upload endpoint is an auth surface
 * and an abuse surface, and the only uploader is Chris's Mac — it publishes with
 * `scripts/publish-media.sh` in the cash-builds repo, which is `wrangler r2
 * object put` plus a poster frame.
 *
 * The one thing that must not be simplified away is Range. iOS Safari opens a
 * video with `Range: bytes=0-1` and, if the server answers 200 with the whole
 * body, refuses to play it at all — not a stall, a flat refusal. Scrubbing needs
 * it too. So `/files/<key>` answers 206 with Content-Range whenever a range is
 * asked for, and advertises Accept-Ranges either way.
 */

import type { Env } from "./index";

/** Content types worth naming. Everything else downloads as a blob. */
const TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  json: "application/json",
};

const VIDEO = new Set(["mp4", "m4v", "mov", "webm"]);
const IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

function ext(key: string): string {
  const i = key.lastIndexOf(".");
  return i < 0 ? "" : key.slice(i + 1).toLowerCase();
}

function contentType(key: string): string {
  return TYPES[ext(key)] ?? "application/octet-stream";
}

/**
 * A poster frame published beside its video as `<video key>.jpg` — see
 * publish-media.sh. Recognised by the double extension so it can be hidden from
 * the index and used as the thumbnail instead.
 */
function isPoster(key: string): boolean {
  return /\.(mp4|m4v|mov|webm)\.jpg$/i.test(key);
}

/**
 * Range resolution.
 *
 * R2 hands back the range it was given, which for `bytes=-500` is a suffix and
 * for `bytes=100-` has no length. Content-Range needs concrete numbers, so
 * everything is normalised against the object's real size here.
 */
function resolveRange(r: R2Range | undefined, size: number): { offset: number; length: number } {
  if (!r) return { offset: 0, length: size };
  if ("suffix" in r && r.suffix !== undefined) {
    const length = Math.min(r.suffix, size);
    return { offset: size - length, length };
  }
  const offset = "offset" in r && r.offset !== undefined ? r.offset : 0;
  const length =
    "length" in r && r.length !== undefined
      ? Math.min(r.length, size - offset)
      : size - offset;
  return { offset, length };
}

/** `bytes=0-1`, `bytes=100-`, `bytes=-500`. Anything else is ignored (served whole). */
function parseRange(header: string | null): R2Range | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return undefined;
  if (rawStart === "") return { suffix: Number(rawEnd) };
  const offset = Number(rawStart);
  if (rawEnd === "") return { offset };
  const end = Number(rawEnd);
  if (end < offset) return undefined;
  return { offset, length: end - offset + 1 };
}

/** R2 stores the bare md5; browsers send it quoted, sometimes weak. */
function normalizeEtag(v: string): string {
  return v.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

/**
 * GET /files/<key> — the object.
 *
 * Served inline with no Content-Disposition: the phone plays it, and saving to
 * the camera roll is a long-press → Save to Photos. Forcing `attachment` would
 * download instead of play, which is the worse trade.
 */
export async function serveFile(request: Request, env: Env, key: string): Promise<Response> {
  if (!env.MEDIA) {
    return new Response("media bucket not bound", { status: 503 });
  }
  if (!key) return new Response("not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  const range = parseRange(request.headers.get("range"));
  const ifNoneMatch = request.headers.get("if-none-match");

  const obj = await env.MEDIA.get(key, {
    range,
    onlyIf: ifNoneMatch ? { etagDoesNotMatch: normalizeEtag(ifNoneMatch) } : undefined,
  });
  if (!obj) return new Response("not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // R2 only carries a content type if one was set at upload time, and
  // `wrangler r2 object put` without --content-type sets none. Guessing from the
  // extension is what keeps iOS from treating an mp4 as a download.
  if (!headers.has("content-type")) headers.set("content-type", contentType(key));
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  // no-store, same as every other session-gated response here. `private,
  // max-age=3600` let the browser keep a playable copy for an hour, and a stored
  // response is replayed without the cookie being looked at — so signing out on
  // a shared phone left the reels reachable from the back button.
  //
  // The trade is paid in full, and it is worth being exact about: no-store means
  // the browser stores nothing, so there is nothing to revalidate and every view
  // — every scrub backwards — is fetched again. The 304 branch below is not a
  // saving on top of that. It answers whatever client does send If-None-Match,
  // and a browser holding this header is not one: it has nothing to ask about.
  //
  // This header only governs responses sent from here on. Copies stored under
  // the old `max-age=3600` are evicted by the Clear-Site-Data on /logout — see
  // the logout route in index.ts, which is the half of this that reaches back.
  headers.set("cache-control", "no-store");

  // onlyIf failed the precondition, so R2 returned metadata with no body.
  if (!("body" in obj)) return new Response(null, { status: 304, headers });

  if (range) {
    const { offset, length } = resolveRange(obj.range, obj.size);
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(request.method === "HEAD" ? null : obj.body, { status: 206, headers });
  }

  headers.set("content-length", String(obj.size));
  return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
}

type Row = {
  key: string;
  name: string;
  size: number;
  uploaded: Date;
  poster: string | null;
};

/** GET /files — the index. */
export async function filesIndex(env: Env): Promise<Response> {
  if (!env.MEDIA) {
    return page(
      `<p class="empty">No media bucket is bound to this Worker yet. Create it with
       <code>wrangler r2 bucket create cashbuilds-media</code> and deploy.</p>`,
    );
  }

  // One page of listing is plenty: this is a personal reel archive, not a CDN.
  // If it ever passes 1000 objects, paginate on the truncated cursor.
  const listed = await env.MEDIA.list({ limit: 1000 });
  const posters = new Set(listed.objects.filter((o) => isPoster(o.key)).map((o) => o.key));

  const rows: Row[] = listed.objects
    .filter((o) => !isPoster(o.key))
    .map((o) => ({
      key: o.key,
      name: o.key.slice(o.key.lastIndexOf("/") + 1),
      size: o.size,
      uploaded: o.uploaded,
      poster: posters.has(`${o.key}.jpg`) ? `${o.key}.jpg` : null,
    }));

  if (rows.length === 0) {
    return page(
      `<p class="empty">Nothing published yet. From the cash-builds repo:
       <code>scripts/publish-media.sh renders/&lt;folder&gt;/&lt;file&gt;.mp4</code></p>`,
    );
  }

  // Grouped by folder; folders ordered by their newest object, rows newest first.
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const i = r.key.lastIndexOf("/");
    const folder = i < 0 ? "(root)" : r.key.slice(0, i);
    (groups.get(folder) ?? groups.set(folder, []).get(folder)!).push(r);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
  }
  const ordered = [...groups.entries()].sort(
    (a, b) => b[1][0].uploaded.getTime() - a[1][0].uploaded.getTime(),
  );

  const body = ordered
    .map(
      ([folder, list]) => `<section>
      <h2>${esc(folder)}</h2>
      ${list.map(rowHtml).join("")}
    </section>`,
    )
    .join("");

  return page(body);
}

function rowHtml(r: Row): string {
  const href = fileHref(r.key);
  const e = ext(r.key);
  let media = "";

  if (VIDEO.has(e)) {
    // preload="none" is what keeps a folder of reels from pulling tens of MB on
    // open: the poster is a few KB and the video only loads on tap. playsinline
    // stops iOS from hijacking the whole screen.
    media = `<video controls playsinline preload="none"${
      r.poster ? ` poster="${esc(fileHref(r.poster))}"` : ""
    } src="${esc(href)}"></video>`;
  } else if (IMAGE.has(e)) {
    media = `<a href="${esc(href)}"><img loading="lazy" src="${esc(href)}" alt=""></a>`;
  }

  return `<article class="item">
    ${media}
    <div class="meta">
      <a class="name" href="${esc(href)}">${esc(r.name)}</a>
      <div class="sub">${fmtSize(r.size)} · ${fmtDate(r.uploaded)}</div>
    </div>
  </article>`;
}

/** Percent-encode each path segment, leaving the slashes as structure. */
function fileHref(key: string): string {
  return `/files/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** Hand-rolled: Workers' ICU is trimmed, and this only ever needs one shape. */
function fmtDate(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The index shell. Same palette, type stack and card treatment as the workspace
 * — it should read as another tab of the same tool, not a file server. And it
 * carries the viewport meta the workspace spent a week without.
 */
function page(body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Files — cash.builds</title>
<style>
  :root {
    --paper: #F3F6F5; --panel: #FFFFFF; --ink: #182A2D; --muted: #566B6D;
    --line: #D6E0DE; --accent: #B97416; --accent-ink: #8A5510;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #0F1B1D; --panel: #152426; --ink: #E6EDEB; --muted: #93A6A4;
      --line: #24393C; --accent: #E39A3C; --accent-ink: #E8A855;
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    background: var(--paper); color: var(--ink); margin: 0;
    font: 15px/1.5 "Avenir Next", "Segoe UI", system-ui, sans-serif;
    padding: 0 max(16px, env(safe-area-inset-left)) calc(40px + env(safe-area-inset-bottom));
  }
  .wrap { max-width: 780px; margin: 0 auto; }
  a { color: var(--accent-ink); text-underline-offset: 3px; }
  header {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: calc(20px + env(safe-area-inset-top)) 0 12px;
    border-bottom: 3px solid var(--ink);
  }
  h1 {
    font-family: "Avenir Next Condensed", "Arial Narrow", "Avenir Next", system-ui, sans-serif;
    font-weight: 700; letter-spacing: .02em; text-transform: uppercase;
    font-size: 22px; margin: 0; flex: 1;
  }
  .back {
    font: 600 11px/1 "Avenir Next", system-ui, sans-serif; text-decoration: none;
    color: var(--muted); border: 1px solid var(--line); border-radius: 4px;
    padding: 9px 10px; display: inline-block;
  }
  h2 {
    font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted);
    margin: 22px 0 8px; overflow-wrap: anywhere;
  }
  .item {
    background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
    overflow: hidden; margin-bottom: 10px;
  }
  /* Reels are 9:16, so a full-width poster is ~700px tall on a phone and two
     files stop fitting on a screen. Cap it and letterback into the black — this
     is an index you scan, and the video still plays at its own size. */
  .item video, .item img {
    display: block; width: 100%; height: auto; background: #000;
    max-height: 50vh; object-fit: contain;
  }
  .meta { padding: 9px 12px; }
  .name { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; }
  .sub {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-variant-numeric: tabular-nums;
    font-size: 11.5px; color: var(--muted); margin-top: 2px;
  }
  .empty { color: var(--muted); font-size: 13.5px; }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px;
    overflow-wrap: anywhere;
  }
  footer {
    margin-top: 24px; padding-top: 10px; border-top: 1px solid var(--line);
    font-size: 11.5px; color: var(--muted);
  }
</style></head>
<body><div class="wrap">
  <header>
    <h1>Files</h1>
    <a class="back" href="/workspace">← Workspace</a>
  </header>
  ${body}
  <footer>
    <p>To keep a reel: long-press the video → <strong>Save to Photos</strong>. Videos are
    served inline on purpose — forcing a download would stop them playing here.</p>
    <p>Published from the Mac with <code>scripts/publish-media.sh</code>. There is no upload
    button, deliberately.</p>
  </footer>
</div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
