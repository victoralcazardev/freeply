# Freeply

Someone comments **LINK** on your Instagram post. A few seconds later they have a DM
with your link in it, and you were asleep.

Self-hosted, open source, and it runs on Cloudflare's free tier — no monthly bill, no
card on file, and no vendor in the loop beyond the Cloudflare account you deploy it to.
A few thousand lines of TypeScript with no runtime dependencies, which matters here: your
Instagram access tokens sit encrypted in your own Cloudflare D1, touched only by code you
can read end to end.

**What it does**

- Keyword in a comment → private-reply DM. Per post, or across the whole account.
- Several keywords per campaign; any one of them fires it, and each person still gets
  exactly one message.
- Whole-word or contains matching, so `link` doesn't fire on `linking`.
- An account-wide campaign answers a repeat commenter again on a different post, or
  once for the whole account — your choice, per campaign.
- Pick the post from a list with thumbnails, rather than hunting for its ID.
- An optional public reply under the comment — posted only after the DM actually sent.
- Tracked links with click counts that exclude Meta's link-preview crawlers, so the
  number means something. On Android, links hand off to the real browser instead of
  opening in Instagram's webview.
- Per-post results: DMs sent measured against the reach of the post that produced them.
- **Story replies**, off by default per campaign. A reply to your story arrives as an
  ordinary inbound DM, so the 24-hour window is already open — no private reply spent,
  no one-shot limit, no 7-day deadline. Account-wide campaigns only.
- **Ice Breakers**: the tappable questions Instagram shows someone opening a DM with
  you for the first time. One per campaign, published to Meta from the dashboard; a tap
  routes straight to that campaign.
- A dashboard at `/` for campaigns, links, the send log, and connecting accounts.

**What it costs**

Nothing, on Cloudflare's published free tier. Checked 24 July 2026: Workers Free is
100,000 requests/day; D1 Free is 5 GB with 5 million rows read and 100,000 rows written
per day; Durable Objects are on the free plan when they use the SQLite backend, which is
what this uses. One operator's volume isn't close to any of those. Cloudflare's pricing
is Cloudflare's to change — but there is no bill today and nothing here needs the paid
plan.

**What it isn't**

It runs Instagram accounts *you own*. That's the design, and it's what keeps you out of
Meta App Review, business verification, and content-policy review entirely. There's no
multi-tenant mode, no billing, and no DM inbox.

---

## Before you start

Exactly one thing on the Instagram side: **the account must be a professional account**
(Business or Creator — either works). Switch it in the Instagram app under
Settings → Account type and tools → Switch to professional account. It's free.

What you do **not** need, despite what half the internet says:

| | |
|---|---|
| A Facebook Page | Not required. Pages are required for *Instagram API with Facebook Login*; this project uses *Instagram API with Instagram Login*, which explicitly doesn't need one. |
| A Meta business portfolio | Not required for running your own accounts. Skip it at app creation; attach one later if you ever need to. |
| Business verification | Not required — that's an App Review prerequisite, and you're not submitting. |
| A domain | Not required. Freeply runs on the free `*.workers.dev` hostname. Point it at your own domain later if you'd rather tracked links carry your name. |
| App Review | Not required while the accounts are yours. Add them as testers on your own app and Standard Access covers it. |
| A personal Instagram account | Won't work. This is the one thing you must change. |

### The constraint that shapes everything

Comment-to-DM on Instagram is a **private reply**, not a cold DM. It's a different
mechanism with its own rules, and they decide what you can build:

- **Exactly one message per commenter.** There is no follow-up unless they write back,
  and then only within 24 hours. Your first message has to carry everything.
- **7 days** from the comment to send it. After that the comment is unreachable.
- It runs on the *comments* permission, not the messaging one — although Meta refuses
  the token without the messaging scope anyway. That contradiction is real; see
  [Things Meta doesn't tell you](#things-meta-doesnt-tell-you).

Anyone selling you an Instagram drip sequence is selling you something Instagram
doesn't have.

---

## Setup

The Cloudflare half is a few commands. The Meta half is a dashboard slog, so there's a
browser-agent prompt below that does most of it.

### The short way: hand it to Claude

This repo ships a [`CLAUDE.md`](./CLAUDE.md) written for exactly this. Clone it, open
[Claude Code](https://claude.com/claude-code) in the folder, and say:

```
Set up Freeply for me.
```

Claude reads the runbook and drives the whole thing — checks your Cloudflare login,
creates the database, generates the secrets you shouldn't have to invent, deploys, and
hands you the two browser prompts for the Meta dashboard at the moment you need them.
You do three things it can't: paste two credentials off Meta's screen, flip the app to
Live, and comment on your own post to prove it works.

It won't read your secrets, won't deploy without asking, and won't tell you it's working
until a DM has actually landed.

The rest of this section is the same setup done by hand. Follow it if you'd rather see
every step, or if something in the short way went sideways.

### 1. Cloudflare

Nothing to edit. Freeply deploys to the free `*.workers.dev` hostname Cloudflare gives
every Worker, and that hostname works as the Meta webhook callback, the OAuth redirect,
and the tracked-link host. Your D1 database is created for you on first setup, and its
id is written into `wrangler.jsonc` locally — that edit is yours and shouldn't be
committed.

```bash
node -v                 # 22 or newer; wrangler requires it
npm install
npx wrangler login      # skip if wrangler whoami already prints an account
```

Two account-level things worth settling now, because otherwise they surface as a failed
deploy in step 3:

- **A workers.dev subdomain.** New Cloudflare accounts don't have one, and the free
  hostname needs it. Register it once at dash.cloudflare.com → Compute (Workers & Pages).
- **More than one Cloudflare account?** `wrangler whoami` will list them. Put the one you
  want in `.dev.vars` as `CLOUDFLARE_ACCOUNT_ID` — it's on the right-hand side of the
  dashboard overview — or wrangler won't know which to deploy to.

`npm run setup` in step 3 prints the hostname it deployed to — you'll paste that into
Meta in step 4.

**Using your own domain instead.** Uncomment the `routes` block in `wrangler.jsonc` and
point it at a hostname on a Cloudflare zone you control. Worth doing eventually: tracked
links are sent in DMs, and a `workers.dev` URL reads like a link shortener to the person
receiving it. It isn't needed to get running.

### 2. Meta app — with Claude in Chrome

Paste this into [Claude in Chrome](https://claude.ai/chrome). It'll drive the Meta
dashboard for you. Do this part *before* deploying.

```
Help me set up a Meta developer app for Freeply, a self-hosted Instagram
comment-to-DM tool. Navigate developers.facebook.com and do the following. If any
screen doesn't match what I've described, stop and show me what you see instead of
guessing — Meta changes this dashboard often.

1. Go to https://developers.facebook.com/apps and start creating a new app.

2. The first screen is "App details". It asks for an App name (30 char limit) and
   pre-fills an App contact email. Ask me for the name before typing it, and show me
   the pre-filled email so I can confirm or change it. Note that Meta rejects app
   names containing "Instagram", "Insta", "Gram", "Face", "Book", or "Meta".

3. The next screen is "Use cases", with about 20 options. Choose "Manage messaging &
   content on Instagram" — described as "Publish posts, share stories, respond to
   comments, answer direct messages and more with the Instagram API." Match on the
   meaning, not the exact characters; Meta's wording drifts between "&" and "and".
   It's the only Instagram messaging/content option, so if you find exactly one, that's
   it. Do NOT pick "Create & manage ads with Marketing API" or "Authenticate and
   request data from users with Facebook Login" — both produce a different OAuth flow
   this project cannot use. This use case advertises publishing too; that's fine, we
   just won't use that half.

4. You may hit a screen asking "Which business portfolio do you want to connect to
   this app?" Choose "I don't want to connect a business portfolio yet." Connecting
   one is only required for Tech Providers serving other businesses, or for apps
   accessing data the developer doesn't own — neither applies here, and it can be
   attached later if that ever changes.

5. After it's created, open the Instagram product from the sidebar and find the
   "API setup with Instagram login" section. Make sure it's the Instagram login
   section, not Facebook login. Ignore any banner suggesting you switch to
   Facebook login for hashtags and insights — we don't need either.

6. IMPORTANT — this panel has its OWN app ID and app secret, auto-generated and
   DIFFERENT from the ones in App settings → Basic. Meta also auto-names this
   nested identity (e.g. "Freeply-IG"). This is not a second app; it's a second
   credential pair inside the same app. Tell me the "Instagram app ID" shown here,
   and confirm you can see an "Instagram app secret" field, but do NOT reveal it.

7. The panel lists the permissions it needs — typically instagram_business_basic,
   instagram_business_manage_comments, and instagram_business_manage_messages.
   Leave whatever it adds by default, and make sure
   instagram_business_manage_insights is among them — Freeply's authorize URL asks
   for it unconditionally, so an app that doesn't declare it hands back a token
   missing a scope the code expects. Tell me if the panel won't let you add it. Do
   NOT add instagram_business_content_publish — Freeply doesn't post.

8. Go to the Roles tab and add my Instagram account as an Instagram Tester. Ask me
   for the username. This must happen BEFORE generating any access token.

9. Go to App settings → Basic and tell me the Meta App ID. Do not click "Show" on
   the App Secret and do not read it back to me — just confirm you're on the page.

10. You'll see a step saying app review is required before accessing live data.
    Ignore it. That's for serving accounts you don't own. Accounts added as
    testers work under Standard Access with no review.

Then stop and report both app IDs. I'll handle the two secrets myself and deploy,
then come back with a second set of instructions for the webhook.
```

Then, on each Instagram account, accept the tester invite:
**Instagram → Settings → Website permissions → Tester invites.**

Keep the Instagram pair somewhere for a minute — they go into `.dev.vars`, which
step 3 creates. You copy them yourself, so they never pass through a model's context:

| `.dev.vars` key | Where it comes from | |
|---|---|---|
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | Instagram product → API setup with Instagram login | **required** |
| `META_APP_ID` / `META_APP_SECRET` | App settings → Basic | optional |

The Meta pair is optional because nothing in `src/` reads it — Instagram Business Login
runs entirely on the Instagram pair, and the app secret Meta signs webhooks with is the
Instagram one. Grab them if you like; setup won't wait for them.

### 3. Secrets and deploy

```bash
npm run init
```

Creates `.dev.vars` and generates the three values you shouldn't have to invent —
`META_VERIFY_TOKEN`, `ENCRYPTION_KEY`, `DASHBOARD_PASSWORD` — writing them straight into
the file. They're never printed, so nothing lands in your scrollback or an agent's
transcript. Re-running it never overwrites a value that's already set, so it can't
orphan tokens already encrypted under your current key.

Then open `.dev.vars` and fill in the five it can't know: the two ID/secret pairs from
step 2, and `OPERATOR_EMAIL` — your contact address, shown on the `/privacy` and
`/data-deletion` pages Meta requires. Run `npm run init` again to see what's outstanding.

`.dev.vars` is gitignored and is the single source of truth. One command creates the
database, applies migrations, deploys, and pushes every secret:

```bash
npm run setup
```

It prints only names and lengths, never values, so it's safe to run in a shared terminal
or with an agent watching. It refuses to touch Cloudflare if anything is still the
example's value — the dashboard holds live Instagram tokens, and a default password is
the same as no password. Safe to re-run; every step checks the current state first.

### 4. Webhook — second Chrome prompt

Now that there's a live URL, paste this one:

```
Back to the Meta app dashboard for Freeply. Now configure the webhook.

1. Open the Instagram product → Webhooks (or Products → Webhooks).

2. Set the callback URL to: https://YOUR-HOSTNAME/webhook
   Set the verify token to the string I'll give you when you ask.

3. Save. Meta will immediately call that URL to verify it. If it fails, tell me the
   exact error — it's almost always a verify-token mismatch.

4. Subscribe to the "comments" field. Also subscribe to "messages" and
   "messaging_postbacks" — those carry story replies and Ice Breaker taps. Comments
   alone is enough if you only want comment-to-DM.

5. Now open Instagram product → API setup with Instagram login → "Business login
   settings", and fill in all three URLs. Instagram refuses any OAuth attempt whose
   redirect isn't listed here, so skipping this makes "Connect an account" fail with
   an error that looks nothing like its cause:

   - OAuth redirect URI: https://YOUR-HOSTNAME/auth/callback
   - Deauthorize callback URL: https://YOUR-HOSTNAME/data-deletion
   - Data deletion request URL: https://YOUR-HOSTNAME/data-deletion

   Save, and read the redirect URI back to me so I can check it character for
   character — a trailing slash is enough to break it.

6. Now switch the app from Development to Live using the toggle at the top of the
   dashboard. This is critical: in Development mode, real comments never reach the
   webhook and only the dashboard's Test button does anything. Skipping this makes a
   working integration look completely broken.

7. Confirm the app shows Live and the comments subscription is active.
```

Replace `YOUR-HOSTNAME` with your deployed hostname first.

### 5. Connect an account

Sign in to the dashboard and use **Connect an Instagram account**. The OAuth flow
exchanges the code for a long-lived token, subscribes the account to comment webhooks,
and stores the token encrypted in D1 — no copy-pasting tokens, no env var per account.

If Instagram blocks web login for an account — common on new ones — open the dashboard
on a phone where the session already works. Same flow, and it goes through.

If you'd rather generate a token by hand in the Meta dashboard first, that path still
exists; use this third prompt:

```
Back to the Meta app dashboard for Freeply. I need to generate an Instagram
access token.

1. Go to the Roles tab and confirm my Instagram account is listed as an
   "Instagram Tester" — not a regular Tester, the Instagram-specific role. If it
   isn't there, ask me for the username and add it.

2. Tell me to accept the invite on the Instagram side before continuing. It's in
   the Instagram app under Settings → Apps and websites → Tester invites (older
   versions call it "Website permissions"). Wait for me to confirm I've accepted.
   Token generation fails with an unhelpful error if the invite is still pending.

3. Go to Instagram → API setup with Instagram login → section 2, "Generate access
   tokens", and start adding the account. An Instagram login popup will open.

4. Stop when the popup appears. I'll log in and authorize myself — don't enter
   credentials on my behalf.

5. Once the token is displayed, do NOT read it back to me or copy it anywhere.
   Just tell me it's ready and I'll copy it myself.
```

### 6. Confirm it's alive

```bash
npm run tail
```

Create a campaign first — a keyword, a message, and either a specific post or
account-wide — then comment that keyword on the post **from a different Instagram
account**. Freeply ignores comments made by the connected account itself, so testing
from the account you just connected produces `skip: comment is from the connected
account` and nothing else, which reads exactly like a broken setup.

You should see the parsed comment in the log stream, the campaign it matched, and the
send. Then check the DM actually arrived — "sent" in the log and a message in an inbox
are two different claims, and only the second one counts.

---

## Things Meta doesn't tell you

Every line here cost at least an hour to find.

**Your app has two app secrets, and webhooks are signed with the second one.** Adding
the Instagram product auto-provisions a *nested* Instagram identity with its own app ID
and secret, separate from App settings → Basic. Meta's docs only ever say "your app's
App Secret." Sign with the wrong one and every webhook 403s. The Instagram app ID is
also the OAuth `client_id` for Business Login; the Meta one is not.

**The signature covers the raw request bytes.** Parse the body to JSON, re-serialize it,
and the digest changes — every webhook fails with nothing in the logs to explain it.

**Webhooks only fire when the app is in Live mode.** In Development mode, only the
dashboard's Test button delivers anything. This is indistinguishable from a broken
integration.

**Authorizing an account does not subscribe it to webhooks.** That's a separate POST to
`/me/subscribed_apps`. The dashboard's token generator does it silently, so a hand-built
OAuth flow looks connected and receives nothing forever. Check with
`GET /{ig-user-id}/subscribed_apps` — *not* `/{app-id}/subscriptions`, which returns an
empty array even when everything is correct.

**An account has two IDs.** `/me` returns an app-scoped `id` and an Instagram Business
`user_id` (the `17841…` form). Webhooks and the messages endpoint both use `user_id`.
Match on the other one and nothing routes, quietly.

**Private replies need the messaging scope, despite the documentation.** Meta's
private-reply docs list only `instagram_business_basic` and
`instagram_business_manage_comments`. A token with exactly those two is refused with
`IGApiException 10: Application does not have permission for this action`.

**Adding a scope later does nothing without `force_reauth`.** Instagram short-circuits
an account that already authorized and hands back a code carrying the *old* grant. The
reconnect appears to succeed and changes nothing.

**Meta redelivers webhooks.** We watched two extra deliveries of the same comment arrive
within four seconds. Since a private reply is one-shot per commenter, a duplicate spends
something you can't get back. Freeply claims each commenter in a Durable Object before
sending and releases the claim if the send fails, so redeliveries are dropped and genuine
retries still work.

---

## Troubleshooting

Setup, before anything is running:

| Symptom | Cause |
|---|---|
| `npm run setup` fails at the deploy, mentioning a subdomain | The Cloudflare account has no workers.dev subdomain. Register it at dash.cloudflare.com → Compute (Workers & Pages), then re-run |
| Deploy fails with "more than one account" | Your login sees several Cloudflare accounts. Set `CLOUDFLARE_ACCOUNT_ID` in `.dev.vars` and re-run |
| `npm run setup` says a value is "still the example value" | It's unedited in `.dev.vars`. `npm run init` fills the three generated ones; the Instagram pair and `OPERATOR_EMAIL` are yours |
| Connect an account → Instagram shows "Invalid redirect_uri" | `https://YOUR-HOSTNAME/auth/callback` isn't registered under Instagram → API setup with Instagram login → Business login settings. Step 4, item 5 |
| Connect an account → "Invalid platform app" | Same panel: the app's Business login settings are incomplete |
| `npm run dev` exits immediately | Node older than 22, or a non-function export added to `src/index.ts` — workerd refuses to mount one |

Running:

| Symptom | Cause |
|---|---|
| Webhook never fires on real comments | App still in Development mode — it must be published/Live |
| Verification fails when saving callback URL | `META_VERIFY_TOKEN` doesn't match the dashboard |
| Every webhook returns 403 | Signature computed over re-serialized JSON, not raw bytes |
| Webhooks 403 despite a correct secret | Meta signs with the **Instagram** app secret, not the Meta one. Check `INSTAGRAM_APP_SECRET` in `.dev.vars`. |
| OAuth flow rejects scopes | Wrong use case chosen at app creation |
| OAuth `client_id` rejected | You used the Meta app ID; Business Login wants the **Instagram** app ID |
| Can't generate an access token | Instagram Tester role not assigned, or the invite not yet accepted in the Instagram app |
| Can't add Instagram account | Account is personal, not Business or Creator |
| Account authorized but no webhooks arrive | OAuth doesn't subscribe. Check `GET /{ig-user-id}/subscribed_apps`; `/auth/callback` now does this automatically |
| `IGApiException 10: Application does not have permission` | Token lacks `instagram_business_manage_messages`. Required for private replies despite the docs |
| Nothing routes to the right account | Match on `user_id` (`17841…`), not the app-scoped `id`. Both come back from `/me` |
| Campaign never fires and nothing is wrong with it | Another active campaign shadows it — same account, keyword, and scope. The dashboard flags this |
| 1101 right after a deploy adding a DO method | The warm Durable Object is still on old code. Retry once it cycles |

---

## How it's built

One Cloudflare Worker. D1 for campaigns, links, the send log, and cached post metrics.
One Durable Object per connected Instagram account. Two cron triggers. No framework, no
build step beyond `wrangler`, no runtime dependencies.

```
Meta → POST /webhook
  ├─ verify X-Hub-Signature-256 against the raw bytes
  ├─ return 200 immediately — Meta retries anything slow
  └─ per comment, in the background:
       ├─ find the first active campaign matching the post and any of its keywords
       ├─ claim the commenter in that account's Durable Object → already
       │    claimed means this is a redelivery; log it and stop
       └─ hand the finished message to the Durable Object, which sends it,
            posts the public reply if the DM landed, and writes the log

cron, every 15 min  → poll for comments whose webhook never arrived, and
                      replay them through the same path
cron, daily         → renew any access token inside a week of expiring
```

The Durable Object exists for one reason: dedupe has to be correct under a burst. D1 is
eventually consistent across regions and would let a duplicate through when the same
person comments twice in three seconds. A Durable Object is single-threaded per account,
which is the serialization this needs. It's also why sends are per-account rather than
global.

It owns the retries too. A failed send goes into an outbox inside the same object and
comes back on a backoff — 30s, 2m, 10m, 30m, an hour — because a claim, its release, and
the retry between them are one piece of state, and splitting them across a queue and a
Durable Object makes two systems that can disagree. What's worth retrying is decided by
Meta's *error code*, not the HTTP status: Meta returns most rate limits as HTTP 400, so
reading the status alone treats a throttle as a permanent mistake and throws the lead
away.

`/l/:code` handles tracked links. A click only counts when the request looks like a real
navigation — Instagram fetches every URL in a DM to build a preview, and counting those
turns click totals into noise. Instagram's in-app *browser* sends a user-agent containing
"instagram" too, so the filter can't just match the name; it checks `Sec-Fetch-Mode`.

### What's proven, and what's only written

The comment → DM → public reply loop has been running in production and the dedupe is
proven against real Meta redelivery: two extra deliveries of the same comment arrived
within four seconds and neither produced a second DM.

**The reliability layer around it is deployed but unproven.** Token refresh,
missed-webhook reconciliation, and send retries are implemented, covered by the test
suite, and their cron triggers have been running since 25 July 2026 — but not one of the
failure paths they exist for has actually occurred. Read them as written and tested, not
as proven. In particular:

- **Token refresh has never actually renewed a token.** Until you deploy and a cron runs,
  an account still stops working ~60 days after you connect it. The dashboard shows the
  countdown either way.
- **Reconciliation has never recovered a real dropped webhook.** The polling, the 7-day
  cutoff and the dedupe on replay are all there and tested; the case they exist for has
  only ever been simulated.
- **No retry has run against a real Graph API failure.** The backoff and the permanent-vs-
  transient split are written against Meta's documented error codes.
- **The post picker calls `GET /me/media`, which hasn't been exercised live either.** If it
  returns nothing the form falls back to the raw post ID field, so this one fails softly.
- **Story replies and Ice Breakers have never run against live Meta at all.** They're the
  newest thing here, they need the `messages` and `messaging_postbacks` webhook fields
  subscribed, and whether Meta delivers a story reply with the story id attached — which
  is what per-story dedupe depends on — has only been assumed, not observed.
- **Whether Meta's one-shot rule is per comment or per commenter is an assumption.** An
  account-wide campaign answering the same person on a second post depends on it being
  per comment. The evidence is a thread observed on someone else's account, not a test on
  ours — see the note on `dedupeKey` in `src/db.ts`. If the stricter reading is right,
  Meta refuses the second send and it lands as `failed` in the log rather than vanishing.

Genuine gaps, still:

- **No DM inbox.** Instagram opens a 24-hour window when someone replies to your DM, the
  default copy asks for a reply, and nothing listens for one.
- **Single-tenant only.** Accounts you have a role on. Anything else means App Review.
- **No pacing.** Nothing spaces sends out to stay under Meta's throughput limits; the
  retry backoff reacts to a throttle after it happens.

---

## Local development

```bash
npm run init    # creates .dev.vars; locally the values only need to match each other
npm run dev     # applies migrations to the local D1 first, then serves on :8787
```

The local database is a separate SQLite file under `.wrangler/`, untouched by anything
remote. `npm run dev` applies migrations to it on every start — without that the Worker
comes up against a database with no tables and 500s on its own dashboard.

Exercise the webhook without involving Meta. Note the secret: the Worker verifies against
`INSTAGRAM_APP_SECRET`, because that's the one Meta signs with.

```bash
BODY='{"object":"instagram","entry":[{"id":"178414","changes":[{"field":"comments","value":{"id":"18000","text":"LINK please","media":{"id":"17900"},"from":{"id":"78000","username":"someuser"}}}]}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$(grep INSTAGRAM_APP_SECRET .dev.vars | cut -d'"' -f2)" | sed 's/^.*= //')
curl -s -X POST http://127.0.0.1:8787/webhook \
  -H "content-type: application/json" \
  -H "x-hub-signature-256: sha256=$SIG" -d "$BODY"
```

To retest with a commenter who has already been messaged, clear that account's dedupe
state: dashboard → **Settings** → *Reset dedupe for @account*. It forgets who has been
messaged; it does not resend anything.

```bash
npm test        # 161 tests against workerd, with a real D1 and Durable Object
npm run typecheck
```

## Notes for contributors

The signature is computed over the **raw request bytes**. `receiveEvent` reads
`arrayBuffer()` before any parsing for exactly this reason — parse to JSON, re-serialize,
and the digest changes, so every webhook 403s with no obvious cause.

Dedupe state lives in the Durable Object, not in D1. Clearing the send log does *not*
let already-messaged people be messaged again, which is the correct behaviour and the
opposite of what most people expect.

A send that's mid-retry has no row in `sends` yet — its outcome isn't known. That's why
reconciliation asks the Durable Object what's still pending instead of trusting the log;
without it, a message on its way would be counted as missed and replayed.

`npm run setup` writes two local edits into `wrangler.jsonc`: your D1 `database_id` and
your `OPERATOR_EMAIL`. Both are correct for you and wrong for everyone else — keep them
out of commits and pull requests. `git diff wrangler.jsonc` before staging.

[`CLAUDE.md`](./CLAUDE.md) is the runbook Claude follows for setup and for changes here.
If you change the setup flow, the Meta prompts, or one of the four traps in "Things Meta
doesn't tell you", update it in the same pull request — it drifts silently otherwise, and
a stale runbook is worse than none.

---

## License

MIT. See [LICENSE](./LICENSE).

It runs your own Instagram accounts, and what you send through it is yours to answer for.
Meta's Platform Terms still apply to anything built on their API.
