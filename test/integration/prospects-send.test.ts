import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendJob } from "../../src/account-do";
import { createSession, sessionCookie } from "../../src/auth";
import * as db from "../../src/db";
import worker from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/**
 * Sending an approved reply (T7, S5, S6).
 *
 * Aprobar on the mobile page sends in the same request, through the account's
 * Durable Object, and every attempt — the first one and each retry — runs the
 * five checks of § Transporte first. What is asserted here is the block *and its
 * code* for each check, that a send inside the window lands once, and that the
 * one outcome nobody may guess at (a timeout) never turns into a second DM.
 */

const TOKEN = "test-api-token";
const apiEnv = { ...env, API_TOKEN: TOKEN };

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** The job the Worker hands the outbox for a prospect reply. */
function job(draftId: string, over: Partial<SendJob> = {}): SendJob {
  return {
    igUserId: IG_USER_ID,
    campaignId: "prospect",
    kind: "prospect_reply",
    dedupeKey: "prospect:lead-1",
    commentId: draftId,
    commenterId: draftId,
    draftId,
    leadId: "lead-1",
    message: "Gracias por responder.",
    successStatus: "sent",
    ...over,
  };
}

/* ------------------------------------------------------------ Meta's side */

interface Call {
  url: string;
  body: any;
}

let calls: Call[] = [];

function stubMeta(respond: () => Response) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: input instanceof URL ? input.toString() : String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return respond();
    }),
  );
}

const graph = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ok = (mid = "mid_api_sent") => graph(200, { message_id: mid });
const refusal = (status: number, code: number, message: string) =>
  graph(status, { error: { code, type: "OAuthException", message } });
/** What a request that never got an answer looks like: a rejected fetch. */
const timeout = (): Response => {
  throw new Error("The operation was aborted due to timeout");
};

/* --------------------------------------------------------------- traffic */

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const request = new Request(`https://freeply.test${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, apiEnv, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json() };
}

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

async function deliver(payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const request = new Request("https://freeply.test/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": await sign(body, FIXTURE_SECRETS.INSTAGRAM_APP_SECRET),
    },
    body,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function echo(over: { text: string; peerId: string; mid: string; at: number }) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_USER_ID,
        time: over.at,
        messaging: [
          {
            sender: { id: IG_USER_ID },
            recipient: { id: over.peerId },
            timestamp: over.at,
            message: { mid: over.mid, text: over.text, is_echo: true },
          },
        ],
      },
    ],
  };
}

function inbound(over: { text: string; peerId: string; mid: string; at: number }) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_USER_ID,
        time: over.at,
        messaging: [
          {
            sender: { id: over.peerId },
            recipient: { id: IG_USER_ID },
            timestamp: over.at,
            message: { mid: over.mid, text: over.text },
          },
        ],
      },
    ],
  };
}

const handleFor = (leadId: string) => leadId.replace(/[^a-z0-9._]/g, ".").slice(0, 30);

/* ------------------------------------------------------------ page traffic */

async function sessionCookieHeader(): Promise<string> {
  const session = await createSession(FIXTURE_SECRETS.DASHBOARD_PASSWORD);
  return sessionCookie(session).split(";")[0];
}

async function getPage(): Promise<string> {
  const request = new Request("https://freeply.test/prospects", {
    headers: { cookie: await sessionCookieHeader() },
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response.text();
}

async function postPage(
  path: string,
  fields: Record<string, string>,
): Promise<{ status: number; location: string | null }> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request(`https://freeply.test${path}`, {
    method: "POST",
    headers: { cookie: await sessionCookieHeader() },
    body,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, location: response.headers.get("location") };
}

const approve = (draftId: string, text: string) =>
  postPage("/prospects/drafts", { draft_id: draftId, action: "approve", text });

/** One queue's slice of the page, so "not in this queue" is a real assertion. */
function section(html: string, id: string): string {
  const start = html.indexOf(`<section id="${id}"`);
  expect(start, `section ${id} missing`).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  expect(end, `section ${id} not closed`).toBeGreaterThan(start);
  return html.slice(start, end);
}

/* ------------------------------------------------------------ arrangement */

/** The production path to an enrolled thread: Sheet row, M1, echo, reply. */
async function lead(o: {
  leadId?: string;
  peerId?: string;
  m1?: string;
  echoAt: number;
  replyAt?: number;
  reply?: string;
}): Promise<string> {
  const leadId = o.leadId ?? "lead-1";
  const peerId = o.peerId ?? "peer-1";
  const m1 = o.m1 ?? "Hola, soy Víctor.";

  const created = await call("POST", "/api/prospects/threads", {
    lead_id: leadId,
    handle: handleFor(leadId),
    name: null,
    nicho: null,
  });
  expect(created.status).toBe(201);
  const draft = await call("POST", "/api/prospects/drafts", {
    draft_id: `m1_${leadId}`,
    lead_id: leadId,
    kind: "m1",
    stage: "M1",
    text: m1,
    base_version: 0,
  });
  expect(draft.status).toBe(201);
  const registered = await call("POST", "/api/prospects/expected-m1", {
    lead_id: leadId,
    text: m1,
  });
  expect(registered.status).toBe(200);
  await deliver(echo({ text: m1, peerId, mid: `mid_echo_${leadId}`, at: o.echoAt }));

  if (o.reply !== undefined && o.replyAt !== undefined) {
    await deliver(
      inbound({ text: o.reply, peerId, mid: `mid_in_${leadId}`, at: o.replyAt }),
    );
  }
  return leadId;
}

/** A reply draft written against the conversation as it stands right now. */
async function pushDraft(o: {
  draftId?: string;
  leadId?: string;
  text?: string;
  baseVersion?: number;
}): Promise<void> {
  const leadId = o.leadId ?? "lead-1";
  const version = o.baseVersion ?? (await threadRow(leadId)).version;
  const created = await call("POST", "/api/prospects/drafts", {
    draft_id: o.draftId ?? "draft-1",
    lead_id: leadId,
    kind: "reply",
    stage: "Filtro",
    text: o.text ?? "Gracias por responder.",
    base_version: version,
  });
  expect(created.status).toBe(201);
}

async function threadRow(leadId: string) {
  const row = await env.DB.prepare(`SELECT * FROM prospect_threads WHERE lead_id = ?`)
    .bind(leadId)
    .first<{
      state: string;
      igsid: string | null;
      version: number;
      last_inbound_at: number | null;
      last_outbound_at: number | null;
    }>();
  if (!row) throw new Error(`thread ${leadId} not found`);
  return row;
}

async function draftRow(draftId: string) {
  const row = await env.DB.prepare(`SELECT * FROM prospect_drafts WHERE draft_id = ?`)
    .bind(draftId)
    .first<{ status: string; decided_text: string | null; decided_at: number | null }>();
  if (!row) throw new Error(`draft ${draftId} not found`);
  return row;
}

interface MessageRow {
  mid: string;
  direction: string;
  origin: string;
  text: string;
  sent_at: number;
  idem: string | null;
  answered_at: number | null;
}

async function messages(leadId: string): Promise<MessageRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT mid, direction, origin, text, sent_at, idem, answered_at
     FROM prospect_messages WHERE lead_id = ? ORDER BY sent_at ASC, mid ASC`,
  )
    .bind(leadId)
    .all<MessageRow>();
  return results;
}

const outbound = async (leadId: string) =>
  (await messages(leadId)).filter((m) => m.direction === "out");

const sends = async () =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM sends`).first<{ n: number }>())?.n ?? 0;

/** The account's Durable Object — the one the Worker sends through. */
const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(IG_USER_ID));

/**
 * The autopilot switch as the Durable Object sees it.
 *
 * An authorized (not approved) draft is an autopilot send, and the object
 * re-reads the switch on every attempt, including the first one. Turning it on
 * is what makes that path reach Meta at all; every other test here sends an
 * approved draft, which the switch does not govern.
 */
async function setDoSwitch(value?: string): Promise<void> {
  await runInDurableObject(account(), (instance: { env: Record<string, unknown> }) => {
    if (value === undefined) delete instance.env.PROSPECT_AUTOPILOT;
    else instance.env.PROSPECT_AUTOPILOT = value;
  });
}

/**
 * Runs the alarm the way the outbox does: whatever is queued becomes due now,
 * and the Durable Object drains it. A retry that is only reachable through
 * `deliver()` is not the retry production runs.
 */
async function fireT7Retry() {
  await runInDurableObject(account(), async (instance, state) => {
    state.storage.sql.exec(`UPDATE outbox SET due_at = 0`);
    await instance.alarm();
  });
}

/** The every-fifteen-minutes trigger, as wrangler.jsonc sets it. */
const CRON = "*/15 * * * *";

/** The deployment's scheduled pass, including the follow-up close (T19). */
async function runScheduled(): Promise<void> {
  await worker.scheduled(
    {
      cron: CRON,
      scheduledTime: Date.now(),
      noRetry: () => {},
    } as unknown as ScheduledController,
    env,
  );
}

/** The error the page redirected with, decoded. */
const said = (location: string | null) => decodeURIComponent(location ?? "");

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM prospect_authorizations`).run();
  await env.DB.prepare(`DELETE FROM prospect_drafts`).run();
  await env.DB.prepare(`DELETE FROM prospect_messages`).run();
  await env.DB.prepare(`DELETE FROM prospect_threads`).run();
  await env.DB.prepare(`DELETE FROM sends`).run();
  await env.DB.prepare(`DELETE FROM accounts`).run();
  // The Durable Object outlives a single test in this pool, so the claims it
  // took have to go with the data they referred to.
  await account().clear();
  await setDoSwitch();
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "victoralcazar",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ tests */

describe("approving a draft sends it inside the window", () => {
  it("sends the approved text and records it in the conversation", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({ text: "Gracias por responder." });
    const before = await threadRow("lead-1");
    stubMeta(() => ok("mid_api_1"));

    const response = await approve("draft-1", "Gracias por responder, Ana.");
    expect(response.status).toBe(303);
    expect(said(response.location)).toContain("Aprobado y enviado");

    // Exactly one call, addressed to the peer Meta gave us, with the text the
    // operator left in the box.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/${IG_USER_ID}/messages`);
    expect(calls[0].body).toEqual({
      recipient: { id: "peer-1" },
      message: { text: "Gracias por responder, Ana." },
    });
    // Nothing of the kind mark_seen sends: an approval is a message or nothing.
    expect(calls[0].body).not.toHaveProperty("sender_action");

    const out = (await outbound("lead-1")).filter((m) => m.origin === "api");
    expect(out).toHaveLength(1);
    expect(out[0].mid).toBe("mid_api_1");
    expect(out[0].idem).toBe("draft-1");
    expect(out[0].text).toBe("Gracias por responder, Ana.");

    // The inbound this answers is marked, and the conversation moves one step.
    const answered = (await messages("lead-1")).filter(
      (m) => m.direction === "in" && m.answered_at !== null,
    );
    expect(answered).toHaveLength(1);
    expect(answered[0].mid).toBe("mid_in_lead-1");
    const after = await threadRow("lead-1");
    expect(after.version).toBe(before.version + 1);
    expect(after.last_outbound_at).toBeGreaterThan(0);

    expect((await draftRow("draft-1")).status).toBe("sent");
    // A prospect send is logged in its own conversation, never in `sends`.
    expect(await sends()).toBe(0);
  });

  it("does not send the same draft twice", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({});
    stubMeta(() => ok("mid_api_1"));

    expect((await approve("draft-1", "Gracias por responder.")).status).toBe(303);
    const second = await approve("draft-1", "Gracias por responder.");
    expect(second.status).toBe(303);
    expect(said(second.location)).toContain("ya no está pendiente");

    expect(calls).toHaveLength(1);
    expect((await outbound("lead-1")).filter((m) => m.origin === "api")).toHaveLength(1);
  });
});

describe("the five checks, each with its code", () => {
  it("blocks with not_registered when the thread is no longer enrolled", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({});
    await env.DB.prepare(`UPDATE prospect_threads SET state = 'closed' WHERE lead_id = ?`)
      .bind("lead-1")
      .run();
    stubMeta(() => ok());

    const response = await approve("draft-1", "Gracias por responder.");
    expect(said(response.location)).toContain("not_registered");
    expect(said(response.location)).toContain("registrado");
    expect(calls).toEqual([]);
    // A refusal that would leave the draft "waiting" retires it instead when
    // the thread is closed: nothing can send it, and a waiting draft of a closed
    // thread is exactly what keeps showing up in the queues.
    expect((await draftRow("draft-1")).status).toBe("invalidated");
  });

  it("blocks with window_closed a day after the lead's last message", async () => {
    const now = Date.now();
    await lead({
      echoAt: now - 30 * HOUR,
      reply: "Cuéntame más",
      replyAt: now - 25 * HOUR,
    });
    await pushDraft({});
    stubMeta(() => ok());

    const response = await approve("draft-1", "Gracias por responder.");
    expect(said(response.location)).toContain("window_closed");
    expect(said(response.location)).toContain("24 h");
    expect(calls).toEqual([]);
    expect((await draftRow("draft-1")).status).toBe("waiting");
  });

  it("blocks with version_changed and invalidates a draft written before an inbound", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR });
    // Written against the conversation as it was, then the lead writes back.
    await pushDraft({ baseVersion: 1 });
    await deliver(
      inbound({ text: "Cuéntame más", peerId: "peer-1", mid: "mid_in_1", at: now - HOUR }),
    );
    stubMeta(() => ok());

    const response = await approve("draft-1", "Gracias por responder.");
    expect(said(response.location)).toContain("version_changed");
    expect(calls).toEqual([]);
    expect((await draftRow("draft-1")).status).toBe("invalidated");
  });

  it("blocks with already_sent when the draft's idempotency key is already stored", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({});
    // A send that reached Meta but was cut off before the draft was marked:
    // the idem key is the only thing standing between this and a second DM.
    await env.DB.prepare(
      `INSERT INTO prospect_messages
         (mid, lead_id, direction, origin, text, sent_at, idem, created_at)
       VALUES ('mid_prior', 'lead-1', 'out', 'api', 'Gracias por responder.', ?, 'draft-1', ?)`,
    )
      .bind(now, now)
      .run();
    stubMeta(() => ok());

    const response = await approve("draft-1", "Gracias por responder.");
    expect(said(response.location)).toContain("already_sent");
    expect(calls).toEqual([]);
    expect((await outbound("lead-1")).filter((m) => m.origin === "api")).toHaveLength(1);
    expect((await draftRow("draft-1")).status).toBe("sent");
  });

  it("blocks with no_approval when a waiting draft is neither approved nor authorized", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({});
    stubMeta(() => ok());

    // The cron's path, before any approval: handing the draft straight to the
    // outbox must not send anything.
    expect(await account().deliver(job("draft-1"))).toBe("blocked:no_approval");
    expect(calls).toEqual([]);
    expect((await draftRow("draft-1")).status).toBe("waiting");
  });
});

describe("the autopilot authorization", () => {
  async function authorize(draftId: string, over: { gateReason?: string; expiresAt?: number }) {
    await env.DB.prepare(
      `INSERT INTO prospect_authorizations (draft_id, category, gate_reason, expires_at, created_at)
       VALUES (?, 'copro_m2', ?, ?, ?)`,
    )
      .bind(draftId, over.gateReason ?? "", over.expiresAt ?? Date.now() + HOUR, Date.now())
      .run();
  }

  it("sends a waiting draft that carries a current authorization", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({ text: "Te cuento cómo lo hacemos." });
    await authorize("draft-1", {});
    // The autopilot path is the only one the switch governs.
    await setDoSwitch("on");
    stubMeta(() => ok("mid_api_auto"));

    expect(await account().deliver(job("draft-1"))).toBe("sent");

    expect(calls[0].body.message).toEqual({ text: "Te cuento cómo lo hacemos." });
    const out = (await outbound("lead-1")).filter((m) => m.origin === "api");
    expect(out).toHaveLength(1);
    expect(out[0].idem).toBe("draft-1");
    expect((await draftRow("draft-1")).status).toBe("sent");
  });

  it("sends on a grant written through the API, and never on one the same pass refused", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({ draftId: "draft-1" });
    await pushDraft({ draftId: "draft-2", text: "Otra respuesta." });
    const authorize = (draftId: string, over: Record<string, unknown> = {}) =>
      call("POST", "/api/prospects/authorizations", {
        draft_id: draftId,
        category: "copro_filter",
        gate_reason: "",
        expires_at: now + HOUR,
        ...over,
      });

    // The CLI's authorize phase, twice: the second pass renews the same grant
    // instead of adding a row, and the send still finds it current.
    expect((await authorize("draft-1")).status).toBe(201);
    expect((await authorize("draft-1", { expires_at: now + 2 * HOUR })).status).toBe(200);
    // And the same phase refusing this one: a current row that is not permission.
    expect(
      (await authorize("draft-2", { gate_reason: "copro_template_mismatch" })).status,
    ).toBe(201);

    await setDoSwitch("on");
    stubMeta(() => ok("mid_api_auto"));

    // The refused draft is checked first: sending the other one bumps the
    // thread's version and would report `version_changed` instead of the answer
    // to "was this authorized?".
    expect(await account().deliver(job("draft-2"))).toBe("blocked:no_approval");
    expect(calls).toEqual([]);

    expect(await account().deliver(job("draft-1"))).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.message).toEqual({ text: "Gracias por responder." });
    expect((await draftRow("draft-2")).status).toBe("waiting");
  });

  it("blocks an expired authorization and one the gate refused", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({ draftId: "draft-expired" });
    await pushDraft({ draftId: "draft-gated" });
    await authorize("draft-expired", { expiresAt: now - 1000 });
    await authorize("draft-gated", { gateReason: "copro_template_mismatch" });
    stubMeta(() => ok());

    expect(await account().deliver(job("draft-expired"))).toBe("blocked:no_approval");
    expect(await account().deliver(job("draft-gated"))).toBe("blocked:no_approval");
    expect(calls).toEqual([]);
  });
});

describe("outcomes that are not a clean send", () => {
  it("leaves a timeout as send_state_unknown and never retries it", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({});
    stubMeta(timeout);

    const response = await approve("draft-1", "Gracias por responder.");
    expect(said(response.location)).toContain("send_state_unknown");
    expect(said(response.location)).toContain("Manual");

    expect(calls).toHaveLength(1);
    expect((await draftRow("draft-1")).status).toBe("send_state_unknown");
    // Nothing is queued: the one thing worse than a missing reply is two of them.
    expect(await account().pendingCommentIds()).not.toContain("draft-1");
    expect((await outbound("lead-1")).filter((m) => m.origin === "api")).toHaveLength(0);

    // Handing the same draft to the outbox again sends nothing.
    stubMeta(() => ok());
    expect(await account().deliver(job("draft-1"))).toBe("blocked:no_approval");
    expect(calls).toEqual([]);

    // And it is waiting in the manual queue for a person to look at the thread.
    const html = await getPage();
    const manual = section(html, "manual");
    expect(manual).toContain(`@${handleFor("lead-1")}`);
    expect(manual).toContain('value="sent"');
    expect(manual).toContain('value="not_sent"');
  });

  it("queues a rate-limited send and records it once when a retry lands", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({});
    stubMeta(() => refusal(400, 80007, "Rate limit exceeded"));

    const response = await approve("draft-1", "Gracias por responder.");
    expect(said(response.location)).toContain("reintenta");

    expect(calls).toHaveLength(1);
    // Still approved, and held in the outbox behind its claim.
    expect((await draftRow("draft-1")).status).toBe("approved");
    expect(await account().pendingCommentIds()).toContain("draft-1");
    expect((await outbound("lead-1")).filter((m) => m.origin === "api")).toHaveLength(0);

    // The drain runs the same attempt again, checks included.
    stubMeta(() => ok("mid_api_retry"));
    expect(await account().deliver(job("draft-1"))).toBe("sent");
    expect((await outbound("lead-1")).filter((m) => m.origin === "api")).toHaveLength(1);
    expect((await draftRow("draft-1")).status).toBe("sent");
  });

  it("re-runs the checks on a retry, so a window that closed meanwhile blocks it", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({});
    stubMeta(() => refusal(429, 4, "Application request limit reached"));

    expect(said((await approve("draft-1", "Gracias por responder.")).location)).toContain(
      "reintenta",
    );
    expect(calls).toHaveLength(1);

    // A day passes between the queued retry and the alarm: the window is shut.
    await env.DB.prepare(`UPDATE prospect_messages SET sent_at = ? WHERE direction = 'in'`)
      .bind(now - 25 * HOUR)
      .run();
    await env.DB.prepare(`UPDATE prospect_threads SET last_inbound_at = ?`)
      .bind(now - 25 * HOUR)
      .run();

    stubMeta(() => ok());
    expect(await account().deliver(job("draft-1"))).toBe("blocked:window_closed");
    expect(calls).toEqual([]);
    expect((await draftRow("draft-1")).status).toBe("waiting");
  });
});

describe("the echo of an API send", () => {
  it("is not read as an owner message, because its mid is already stored", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({});
    stubMeta(() => ok("mid_api_1"));
    await approve("draft-1", "Gracias por responder, Ana.");

    const before = await threadRow("lead-1");
    const count = (await messages("lead-1")).length;

    // Meta echoes our own send back with the same mid it gave the API call.
    await deliver(
      echo({
        text: "Gracias por responder, Ana.",
        peerId: "peer-1",
        mid: "mid_api_1",
        at: now + 1000,
      }),
    );

    const after = await messages("lead-1");
    expect(after).toHaveLength(count);
    expect(after.some((m) => m.origin === "owner")).toBe(false);
    expect((await threadRow("lead-1")).version).toBe(before.version);
    // The stored mid is what T8 compares against: same mid, our message.
    expect(after.find((m) => m.origin === "api")?.mid).toBe("mid_api_1");
  });

  it("never enrolls another lead from the echo of our own reply", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({});
    const told = "Te cuento cómo lo hacemos.";
    stubMeta(() => ok("mid_api_1"));
    await approve("draft-1", told);

    // A second lead copied the exact text this reply happens to be written in.
    // The echo of our send must not register that lead under this conversation's
    // peer: the mid says the message is already ours.
    const other = await call("POST", "/api/prospects/threads", {
      lead_id: "lead-2",
      handle: handleFor("lead-2"),
      name: null,
      nicho: null,
    });
    expect(other.status).toBe(201);
    const registered = await call("POST", "/api/prospects/expected-m1", {
      lead_id: "lead-2",
      text: told,
    });
    expect(registered.status).toBe(200);

    await deliver(echo({ text: told, peerId: "peer-1", mid: "mid_api_1", at: now + 1000 }));

    const otherThread = await threadRow("lead-2");
    expect(otherThread.state).toBe("m1_pendiente");
    expect(otherThread.igsid).toBeNull();
  });
});

describe("a settled outcome is never sent again", () => {
  it("does not let an authorization revive a draft whose send outcome is unknown", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({});
    // The CLI authorized this draft before the first attempt timed out; the row
    // stays current, and it is still not permission to send a second time.
    await env.DB.prepare(
      `INSERT INTO prospect_authorizations (draft_id, category, gate_reason, expires_at, created_at)
       VALUES ('draft-1', 'copro_m2', '', ?, ?)`,
    )
      .bind(now + HOUR, now)
      .run();

    stubMeta(timeout);
    expect(said((await approve("draft-1", "Gracias por responder.")).location)).toContain(
      "send_state_unknown",
    );
    expect((await draftRow("draft-1")).status).toBe("send_state_unknown");

    stubMeta(() => ok());
    expect(await account().deliver(job("draft-1"))).toBe("blocked:no_approval");
    expect(calls).toEqual([]);
    expect((await draftRow("draft-1")).status).toBe("send_state_unknown");
    expect(await account().pendingCommentIds()).not.toContain("draft-1");
  });

  it("settles the outbox row when a retry is blocked, so nothing stays due", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({});
    stubMeta(() => refusal(400, 80007, "Rate limit exceeded"));

    expect(said((await approve("draft-1", "Gracias por responder.")).location)).toContain(
      "reintenta",
    );
    expect(await account().pendingCommentIds()).toContain("draft-1");

    // The window shuts before the retry fires, so the retry is refused — and a
    // refused retry is settled, not left due for the next alarm to refuse again.
    await env.DB.prepare(`UPDATE prospect_messages SET sent_at = ? WHERE direction = 'in'`)
      .bind(now - 25 * HOUR)
      .run();
    await env.DB.prepare(`UPDATE prospect_threads SET last_inbound_at = ?`)
      .bind(now - 25 * HOUR)
      .run();

    stubMeta(() => ok());
    await fireT7Retry();

    expect(calls).toEqual([]);
    expect((await draftRow("draft-1")).status).toBe("waiting");
    expect(await account().pendingCommentIds()).not.toContain("draft-1");
  });

  it("treats a response body that dies mid-read as unknown, not as a retry", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({});
    stubMeta(() => refusal(429, 4, "Application request limit reached"));
    expect(said((await approve("draft-1", "Gracias por responder.")).location)).toContain(
      "reintenta",
    );
    expect(await account().pendingCommentIds()).toContain("draft-1");

    // Meta answered 200, then the connection died while the body was read. The
    // request reached Meta, so the outcome is unknown - not a retry.
    stubMeta(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"message_id":'));
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await fireT7Retry();

    expect(calls).toHaveLength(1);
    expect((await draftRow("draft-1")).status).toBe("send_state_unknown");
    expect(await account().pendingCommentIds()).not.toContain("draft-1");

    stubMeta(() => ok());
    await fireT7Retry();
    expect(calls).toEqual([]);
  });
});

describe("the day-14 close", () => {
  it("drops the queued retry of a thread it retires", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 30 * MINUTE, reply: "Cuéntame más", replyAt: now - 10 * MINUTE });
    await pushDraft({});
    // A retry queued behind a definitive refusal: the draft is not sent, and its
    // row waits in the outbox for the next alarm.
    stubMeta(() => refusal(400, 80007, "Rate limit exceeded"));
    expect(said((await approve("draft-1", "Gracias por responder.")).location)).toContain(
      "reintenta",
    );
    expect(await account().pendingCommentIds()).toContain("draft-1");

    // The lead answered and then went silent: fifteen days later the scheduled
    // pass closes the thread.
    await env.DB.prepare(
      `UPDATE prospect_threads SET last_inbound_at = ?, last_outbound_at = ?
       WHERE lead_id = 'lead-1'`,
    )
      .bind(now - 15 * 24 * HOUR, now - 15 * 24 * HOUR)
      .run();

    stubMeta(() => ok());
    await runScheduled();

    expect((await threadRow("lead-1")).state).toBe("closed");
    expect((await draftRow("draft-1")).status).toBe("invalidated");
    // The retry behind it goes with the close: no alarm wakes up for a message
    // that can never be sent again.
    expect(await account().pendingCommentIds()).not.toContain("draft-1");

    await fireT7Retry();
    expect(calls).toEqual([]);
    expect((await draftRow("draft-1")).status).toBe("invalidated");
  });
});

describe("two approvals at once", () => {
  it("sends at most one message for the same draft", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({});
    stubMeta(() => ok("mid_api_1"));

    const [a, b] = await Promise.all([
      approve("draft-1", "Gracias por responder."),
      approve("draft-1", "Gracias por responder."),
    ]);
    expect(a.status).toBe(303);
    expect(b.status).toBe(303);

    expect(calls).toHaveLength(1);
    expect((await outbound("lead-1")).filter((m) => m.origin === "api")).toHaveLength(1);
    expect((await draftRow("draft-1")).status).toBe("sent");
  });
});
