/**
 * Static policy pages. Meta requires a reachable privacy policy URL before an app
 * can be published, and a data-deletion URL for the Instagram permissions.
 * Serving them from the Worker keeps them on the same domain as the webhook.
 */

const STYLE = `
  :root { color-scheme: light dark; }
  body {
    max-width: 42rem; margin: 0 auto; padding: 3rem 1.25rem 6rem;
    font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  h1 { font-size: 1.6rem; margin-bottom: .25rem; }
  h2 { font-size: 1.1rem; margin-top: 2.25rem; }
  .sub { opacity: .65; margin-top: 0; }
  code { font-size: .9em; }
  footer { margin-top: 3rem; font-size: .875rem; opacity: .65; }
`;

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<link rel="icon" type="image/svg+xml" href="/icon.svg">` +
      `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title><style>${STYLE}</style></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export function privacyPage(operator: string, host: string): Response {
  return page(
    "Privacy Policy",
    `<h1>Privacy Policy</h1>
<p class="sub">For the Freeply instance at ${host}</p>

<p>This is a self-hosted, single-operator installation of
<a href="https://github.com/">Freeply</a>, an open-source tool that sends an
Instagram private reply when someone comments on the operator's own posts.
It is not a service offered to the public and does not accept sign-ups.</p>

<h2>What is collected</h2>
<p>When you comment on a post belonging to an Instagram account connected to this
instance, Instagram sends this instance a notification containing your Instagram
user ID, your username, the text of your comment, and the ID of the post. If your
comment matches a configured keyword, that information is stored so a reply can be
sent and so you are not messaged twice for the same campaign.</p>
<p>Access tokens for the operator's own Instagram accounts are stored encrypted.</p>

<h2>What is not collected</h2>
<p>No tracking pixels, advertising identifiers, analytics, or third-party sharing.
Your data is never sold, and is not used to build a profile of you. If a reply
contains a shortened link, only an aggregate click count is recorded — not who
clicked.</p>

<h2>Where it lives</h2>
<p>On Cloudflare infrastructure controlled by the operator. Nothing is sent to any
other processor apart from Meta, which is the source of the data.</p>

<h2>Retention</h2>
<p>Send records are kept so duplicate messages can be avoided, and are pruned
automatically after 30 days.</p>

<h2>Your rights</h2>
<p>You can request access to or deletion of any data this instance holds about you.
See the <a href="/data-deletion">data deletion instructions</a>.</p>

<footer>Contact: ${operator}</footer>`,
  );
}

export function dataDeletionPage(operator: string, host: string): Response {
  return page(
    "Data Deletion Instructions",
    `<h1>Data Deletion Instructions</h1>
<p class="sub">For the Freeply instance at ${host}</p>

<p>To have any data this instance holds about you deleted, email
<strong>${operator}</strong> from any address and include the Instagram username
you commented from.</p>

<p>The only data held about a commenter is: your Instagram user ID, your username,
the comment that triggered a reply, and a timestamp. All of it is deleted on
request, and records are pruned automatically after 30 days regardless.</p>

<h2>If you are the operator</h2>
<p>Disconnecting an Instagram account removes its stored access token. Deleting a
campaign removes its send history.</p>

<footer>Requests are handled by a person, not automatically. Expect a reply within
a few days.</footer>`,
  );
}
