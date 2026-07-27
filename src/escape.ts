/**
 * Escaping Meta's in-app browser.
 *
 * Links in an Instagram DM open in Meta's webview, where there's no password
 * manager, no extensions, and no shared session — costing conversions on
 * anything needing a login or a purchase.
 *
 * What actually works, as of 2026:
 *
 *   Android — intent:// with a browser package genuinely hands off to Chrome.
 *
 *   iOS — nothing reliable. Instagram intercepts x-safari-https://, and both
 *   Facebook and Instagram block Universal Links inside their webview. Services
 *   that claim to "escape" on iOS are usually deep-linking into a *native app*
 *   (YouTube, Amazon, Spotify) via its own scheme, which is a different problem
 *   from opening an arbitrary website in Safari.
 *
 * So: attempt the handoff where it works, and where it doesn't, tell people
 * plainly how to do it themselves rather than spinning on a promise we can't
 * keep. An unexplained delay costs more conversions than one clear sentence.
 */

const IN_APP =
  /Instagram|FBAN|FBAV|FB_IAB|FBIOS|Messenger|Line\/|MicroMessenger|TikTok|Twitter/i;

export function isInAppBrowser(userAgent: string): boolean {
  return IN_APP.test(userAgent);
}

/**
 * Whether a handoff is worth attempting at all.
 *
 * Only Android. On iOS every programmatic route is blocked, so an interstitial
 * buys nothing and costs a hop plus a visible pause — measurably worse than
 * going straight to the destination. Tested: even tapping through still lands in
 * the webview.
 */
export function canEscape(userAgent: string): boolean {
  return isInAppBrowser(userAgent) && !isIOS(userAgent);
}

function isIOS(userAgent: string): boolean {
  return /iPhone|iPad|iPod/i.test(userAgent);
}

/**
 * A page that tries to hand the URL to the real browser, then gets out of the
 * way. Anyone it fails for still sees a normal link they can tap or copy.
 */
export function escapePage(target: string, userAgent: string): Response {
  const ios = isIOS(userAgent);

  // Attempted automatically; both fail silently if the scheme isn't handled.
  const escapeUrl = ios
    ? `x-safari-${target}`
    : `intent://${target.replace(/^https?:\/\//, "")}#Intent;scheme=https;package=com.android.chrome;end`;

  const json = JSON.stringify({ target, escapeUrl, ios });

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening…</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    background:#fbfbfa; color:#1a1a18; padding:2rem; text-align:center; }
  @media (prefers-color-scheme: dark) { body { background:#16161a; color:#ececE8; } }
  .box { max-width: 22rem; }
  a.btn { display:inline-block; margin-top:1rem; padding:.7rem 1.3rem; border-radius:8px;
    background:#b4491f; color:#fff; text-decoration:none; font-weight:500; }
  p { opacity:.7; font-size:.9rem; }
  .hint { display:none; margin-top:1.25rem; font-size:.85rem; opacity:.85; }
  .hint b { opacity:1; }
  .url { word-break:break-all; font-size:.8rem; opacity:.5; margin-top:1.5rem; }
</style></head>
<body><div class="box">
  <p id="msg">Opening…</p>
  <a class="btn" id="go" href="${escapeHtml(target)}">Continue</a>
  <p id="hint" class="hint"></p>
  <div class="url">${escapeHtml(target)}</div>
</div>
<script>
(function () {
  var d = ${json};

  // Executing at all proves a real browser rather than a link preview fetcher,
  // so this is also what makes the click count.
  try { navigator.sendBeacon(location.pathname + "?counted=1"); } catch (e) {}

  // Worth attempting on both: it costs nothing and still works on some
  // versions. Android's intent:// is the one that reliably succeeds.
  try { window.location.href = d.escapeUrl; } catch (e) {}

  // If the handoff worked the page is backgrounded and this never runs.
  setTimeout(function () {
    if (document.hidden) return;

    // It didn't take. Don't strand anyone waiting on something that isn't
    // coming — go to the destination, and on iOS say how to get to Safari,
    // since Instagram blocks every programmatic route.
    if (d.ios) {
      document.getElementById("msg").textContent = "Opening here.";
      var hint = document.getElementById("hint");
      hint.innerHTML =
        "For a better experience, tap <b>\u22EF</b> at the top right, then " +
        "<b>Open in browser</b>.";
      hint.style.display = "block";
    }
    window.location.replace(d.target);
  }, 900);
})();
</script></body></html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
