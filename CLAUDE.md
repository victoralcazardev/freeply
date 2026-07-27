# Instructions for Claude

Freeply turns an Instagram comment into a DM. One Cloudflare Worker, D1, one Durable
Object per connected account, no runtime dependencies. It runs Instagram accounts the
operator owns — that single-tenant scope is what keeps it out of Meta App Review, and
it is not a limitation to design around.

Two jobs arrive at this repo. Read the one you've been given:

- **[Set it up for me](#setting-it-up)** — the operator has cloned this and wants it
  live. Most requests. You drive; they paste the things only they can paste.
- **[Change the code](#working-on-the-code)** — a fix or a feature.

---

## Rules that don't bend

**1. Never read or print a secret.** No `cat .dev.vars`, no `grep` against it, no
reading it "just to check". If you need to know whether a value is set, run
`npm run init` — it reports names and character counts and nothing else. The Instagram
credentials go from the operator's screen into their file without passing through your
context, and that property is worth more than the convenience of holding them.

The line is whether a value reaches your context, not whether a command touches the
file. Piping a secret straight into another program without printing it — the way the
README's local webhook test feeds `INSTAGRAM_APP_SECRET` to `openssl` inside a
`$(…)` — is fine. Anything whose output you would end up reading is not.

**2. Never commit `.dev.vars`, and check `git diff` before every commit.**
`npm run setup` writes two local edits into `wrangler.jsonc` — `database_id` and
`OPERATOR_EMAIL`. Both are correct locally and wrong for everyone else. Leave them
out of commits and pull requests. `git diff wrangler.jsonc` before you stage anything.

**3. Ask before anything that reaches the outside world.** Deploying, switching the
Meta app to Live, connecting an account, resetting dedupe, or any
`wrangler d1 execute --remote` that isn't a `SELECT`. A deploy changes what a live
Instagram automation does to real people's DMs.

**4. Don't guess at Meta's dashboard.** Its layout changes every few months. Hand the
operator the browser prompts below rather than describing screens from memory, and if
they say a screen doesn't match, stop and ask what they're looking at.

**5. Don't try to widen what Instagram allows.** One private reply per commenter, ever;
seven days from the comment to send it; no follow-up unless they write back. These are
Meta's rules. Retries, extra scopes, and second messages don't beat them — they get the
app restricted. If a request depends on beating them, say so plainly.

---

## Setting it up

Six phases. Confirm each one landed before starting the next — a mistake in phase 1
shows up as silence in phase 6, which is the worst possible place to debug it.

### Phase 0 — Check the ground

```bash
node -v                 # 22 or newer — the pinned wrangler requires it
npx wrangler whoami     # must print an account
```

If `wrangler whoami` fails, the operator runs `npx wrangler login` themselves — it
opens a browser. Suggest they type `! npx wrangler login` so the output lands in the
session.

Two things about that account will stop the deploy in phase 3 if they aren't sorted
now, and both fail in a way that reads like a broken script rather than a missing
prerequisite:

- **More than one Cloudflare account on the login.** `wrangler whoami` prints them. If
  there's more than one, wrangler can't choose, and in a non-interactive shell — which
  is what you are — it doesn't even prompt. Have them put the account id in `.dev.vars`
  as `CLOUDFLARE_ACCOUNT_ID`; it's on the right of the Cloudflare dashboard overview.
- **No workers.dev subdomain registered.** A brand-new Cloudflare account has none, and
  registering it is an interactive prompt you can't answer. They register it once at
  dash.cloudflare.com → Compute (Workers &amp; Pages).

Then ask them one question, and don't move until it's answered: **is the Instagram
account a professional account — Business or Creator?** A personal account cannot work,
no matter what else is configured. They switch it in the Instagram app under
Settings → Account type and tools. It's free and takes a minute.

They also need a Cloudflare account. Free tier is genuinely enough; nothing here needs
the paid plan.

### Phase 1 — The Meta app, via Claude in Chrome

Don't navigate `developers.facebook.com` yourself. Give the operator this, and tell them
to paste it into [Claude in Chrome](https://claude.ai/chrome) with the Meta dashboard
open. It's reproduced from README step 2 — if you edit it, edit it there too.

> Help me set up a Meta developer app for Freeply, a self-hosted Instagram
> comment-to-DM tool. Navigate developers.facebook.com and do the following. If any
> screen doesn't match what I've described, stop and show me what you see instead of
> guessing — Meta changes this dashboard often.
>
> 1. Go to https://developers.facebook.com/apps and start creating a new app.
> 2. The first screen is "App details" — an App name (30 char limit) and a pre-filled
>    contact email. Ask me for the name, and show me the email so I can confirm it.
>    Meta rejects names containing "Instagram", "Insta", "Gram", "Face", "Book", "Meta".
> 3. Next is "Use cases". Choose **"Manage messaging & content on Instagram"**. Match on
>    meaning, not exact characters. Do NOT pick the Marketing API or Facebook Login
>    options — both produce an OAuth flow this project cannot use.
> 4. If asked about a business portfolio, choose "I don't want to connect a business
>    portfolio yet."
> 5. Open the Instagram product → **"API setup with Instagram login"**. Not Facebook
>    login. Ignore any banner suggesting you switch.
> 6. IMPORTANT — this panel has its OWN app ID and secret, different from App settings →
>    Basic. Tell me the "Instagram app ID" and confirm you can see an "Instagram app
>    secret" field, but do NOT reveal the secret.
> 7. Leave the default permissions (instagram_business_basic,
>    instagram_business_manage_comments, instagram_business_manage_messages) and make
>    sure instagram_business_manage_insights is there too — it's requested
>    unconditionally, so leaving it out yields a token missing a scope the code asks
>    for. Tell me if the panel won't let you add it. Do NOT add
>    instagram_business_content_publish.
> 8. Roles tab → add my Instagram account as an **Instagram Tester**. Ask me for the
>    username. This must happen before any token is generated.
> 9. App settings → Basic: tell me the Meta App ID. Do not click "Show" on the secret.
> 10. Ignore any prompt that app review is required. Tester accounts work under
>     Standard Access.
>
> Then stop and report both app IDs. I'll handle the two secrets myself.

Two things you must then confirm with them:

- They accepted the tester invite **inside the Instagram app**: Settings → Website
  permissions (or Apps and websites) → Tester invites. Token generation fails with an
  unhelpful error while it's pending.
- They have the **Instagram** app ID and secret — the pair from the "API setup with
  Instagram login" panel, not the pair in App settings → Basic. Only the Instagram pair
  is used: it's the OAuth `client_id` and the secret Meta signs webhooks with. Mixing
  the two up produces the two ugliest failures in this project — every webhook 403ing,
  and OAuth rejecting the `client_id` — so if they're unsure which they copied, have
  them check before moving on. The Meta pair is optional and nothing reads it.

### Phase 2 — Local config

```bash
npm install
npm run init
```

`npm run init` creates `.dev.vars` and generates `META_VERIFY_TOKEN`, `ENCRYPTION_KEY`,
and `DASHBOARD_PASSWORD` directly into it, printing only names and lengths. It never
overwrites a value that's already set, so re-running it can't orphan stored tokens.

Then the operator edits `.dev.vars` themselves and fills in three things:
`INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` from phase 1, and `OPERATOR_EMAIL` — their
contact address, which appears on the `/privacy` and `/data-deletion` pages Meta
requires. Tell them which three; don't offer to type them in for them, and don't ask
them to paste the values to you.

Re-run `npm run init` to see what's still outstanding. It prints `todo` or `ok` per key.

### Phase 3 — Deploy

Ask first. Then:

```bash
npm run setup
```

One command that creates the D1 database if it doesn't exist, writes its id into
`wrangler.jsonc`, applies every migration, deploys the Worker, and pushes each secret.
It refuses to touch Cloudflare while any value is still the example's, and prints the
deployed hostname at the end. Note that hostname — the next two phases need it.

If it fails, read the failure before re-running. It's safe to re-run: every step checks
current state first.

### Phase 4 — Webhook, then Live

Second Chrome prompt. Substitute the real hostname before handing it over.

> Back to the Meta app dashboard for Freeply. Now configure the webhook.
>
> 1. Instagram product → Webhooks (or Products → Webhooks).
> 2. Callback URL: `https://YOUR-HOSTNAME/webhook`. Verify token: the string I'll give
>    you when you ask.
> 3. Save. Meta calls the URL immediately to verify. If it fails, tell me the exact
>    error — it's almost always a verify-token mismatch.
> 4. Subscribe to the **comments** field. Also subscribe to **messages** and
>    **messaging_postbacks** if you want story replies and Ice Breakers to work.
> 5. Open Instagram product → API setup with Instagram login → **Business login
>    settings** and fill in all three URLs:
>    - OAuth redirect URI: `https://YOUR-HOSTNAME/auth/callback`
>    - Deauthorize callback URL: `https://YOUR-HOSTNAME/data-deletion`
>    - Data deletion request URL: `https://YOUR-HOSTNAME/data-deletion`
>
>    Save, then read the redirect URI back to me exactly as saved.
> 6. Switch the app from Development to **Live** using the toggle at the top. This is
>    critical: in Development mode real comments never reach the webhook and only the
>    dashboard's Test button does anything.
> 7. Confirm the app shows Live and the subscription is active.

The verify token is the `META_VERIFY_TOKEN` line in their `.dev.vars`. They read it and
paste it — you don't.

Two things here decide whether phase 5 works at all:

- **The OAuth redirect URI.** Instagram rejects any authorization whose redirect isn't
  registered, and the error it shows says nothing useful. If "Connect an account" fails
  in the next phase, this is the first thing to re-check.
- **The Live toggle.** The single most common reason a correct setup looks broken.
  Confirm it explicitly rather than assuming.

### Phase 5 — Connect the account

Open `https://YOUR-HOSTNAME/`, sign in with `DASHBOARD_PASSWORD`, and use **Connect an
Instagram account**. The OAuth callback exchanges the code for a long-lived token,
subscribes the account to webhooks, and stores the token encrypted in D1.

If Instagram blocks web login — common on newer accounts — they open the same dashboard
URL on a phone where the session already works.

### Phase 6 — Prove it works

Create a campaign in the dashboard: a keyword, a message, and either a specific post or
account-wide. Then:

```bash
npm run tail
```

Have them comment the keyword on that post from a **different** Instagram account than
the one connected. Comments made by the connected account are skipped deliberately
(`src/index.ts:588` — you'll see `skip: comment is from the connected account` in the
tail), so a self-test looks identical to a dead integration. This trips people
constantly; say it before they test, not after.

Watch for the parsed comment, the matched campaign, and the send.

Then confirm the DM actually arrived. The log saying "sent" and a DM appearing are not
the same claim, and only the second one matters. If nothing arrives, work the
troubleshooting table in the README top to bottom — it is ordered by how often each
cause is the real one.

Don't report success until a DM has landed in a real inbox.

---

## Working on the code

```bash
npm test            # 161 tests, workerd + real D1 + a real Durable Object
npm run typecheck
```

Both must pass. CI runs both on every push and every pull request.

**Where things live.** `src/index.ts` routes and the webhook handler; `src/instagram.ts`
every Graph API call; `src/db.ts` D1 queries and the campaign model; `src/account-do.ts`
the per-account Durable Object — dedupe claims, the send outbox, retries;
`src/cron.ts` token refresh and missed-webhook reconciliation; `src/dashboard.ts` the
whole UI; `src/escape.ts`, `src/crypto.ts`, `src/auth.ts`, `src/pages.ts` the small
supporting pieces.

**Four things that will bite you.** Each cost real hours to find, and each is invisible
in review if you don't already know:

- The webhook signature is computed over the **raw request bytes**. Parse to JSON and
  re-serialize and every delivery 403s with nothing in the logs to explain it.
- Meta signs webhooks with the **Instagram** app secret, not the Meta one.
- Dedupe lives in the **Durable Object**, not D1. D1 is eventually consistent across
  regions and would let a duplicate through when someone comments twice in three
  seconds. Clearing the send log therefore does not let anyone be messaged again — that
  is correct behaviour, and the opposite of what most people assume.
- An account has two IDs. Webhooks and the messages endpoint use the Instagram Business
  `user_id` (the `17841…` form), not the app-scoped `id`. Match the wrong one and
  nothing routes, quietly.

**Migrations** are numbered and additive: add `migrations/NNNN_name.sql`, never edit one
that has been applied. `npm run setup` applies them.

**No runtime dependencies.** The operator's Instagram tokens sit in their D1, touched
only by code in this repo, and that claim is in the README. Adding a package to save
twenty lines breaks it. Dev dependencies are fine.

**Match the surrounding style.** Comments here explain *why* — the constraint, the
failure that motivated the shape — and skip what the code already says.

**Don't overstate what's proven.** The README distinguishes what has run in production
from what is only written and tested, and that section is load-bearing. Token refresh,
reconciliation, and retries are implemented and covered by tests but have never been
exercised against live Meta. If you make one of those real, update that section; if you
add something new and unproven, say so there.

---

## When it isn't working

The README's troubleshooting table is the fast path. The three that account for most of
it, in order:

1. **App still in Development mode.** Real comments never arrive. Looks identical to a
   broken integration.
2. **Wrong app secret.** Signed with the Meta secret instead of the Instagram one, so
   every webhook 403s.
3. **Account authorized but never subscribed.** OAuth alone doesn't subscribe an account
   to webhooks; `/auth/callback` does it, but a hand-built token skips it. Check
   `GET /{ig-user-id}/subscribed_apps` — not `/{app-id}/subscriptions`, which returns an
   empty array even when everything is correct.

To watch live traffic: `npm run tail`. To inspect state without changing it, `SELECT`
against D1 with `--remote`. Note that a send mid-retry has no row in `sends` yet, so an
empty log doesn't mean nothing is happening — ask the Durable Object, which is what
reconciliation does.
