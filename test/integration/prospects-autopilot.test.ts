import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, sessionCookie } from "../../src/auth";
import { prospectAutopilotDueAt } from "../../src/cron";
import * as db from "../../src/db";
import worker, { type Env } from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/**
 * The autopilot cron and the 20 h warning (T8, S5, S6).
 *
 * The cron is the only place that sends without a person in the loop, so it is
 * driven the way production drives it: through the exported `scheduled` handler
 * on the same every-fifteen-minutes trigger `wrangler.jsonc` holds. What is
 * asserted is what may not be guessed at — the switch, the human delay, the
 * per-run cap, the spacing between two messages to the same thread, and the
 * fact that a draft nobody authorized is never sent by the Worker on its own.
 */

const TOKEN = "test-api-token";
const apiEnv = { ...env, API_TOKEN: TOKEN };

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** The trigger this job rides — the one in wrangler.jsonc, not the token one. */
const CRON = "*/15 * * * *";

function autopilotEnv(value?: string): Env {
  const base = { ...apiEnv } as Env;
  if (value === undefined) {
    const { PROSPECT_AUTOPILOT: _unset, ...rest } = base;
    return rest as Env;
  }
  return { ...base, PROSPECT_AUTOPILOT: value };
}

async function runScheduled(envUnderTest: Env = autopilotEnv("on")): Promise<void> {
  await worker.scheduled(
    {
      cron: CRON,
      scheduledTime: Date.now(),
      noRetry: () => {},
    } as unknown as ScheduledController,
    envUnderTest,
  );
}

/* ------------------------------------------------------------ Meta's side */

interface Call {
  url: string;
  body: any;
}

let calls: Call[] = [];

const graph = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubMeta(respond: (call: Call) => Response = () => graph(200, { message_id: "mid_api" })) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: input instanceof URL ? input.toString() : String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      };
      calls.push(call);
      return respond(call);
    }),
  );
}

/* --------------------------------------------------------------- traffic */

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

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const request = new Request(`https://freeply.test${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, apiEnv, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, json: await response.json() };
}

const handleFor = (leadId: string) => leadId.replace(/[^a-z0-9._]/g, ".").slice(0, 30);

/** The production path to an enrolled thread whose last message is the lead's. */
async function lead(o: {
  leadId?: string;
  peerId?: string;
  m1?: string;
  echoAt: number;
  reply?: string;
  replyAt?: number;
}): Promise<string> {
  const leadId = o.leadId ?? "lead-1";
  const peerId = o.peerId ?? "peer-1";
  const m1 = o.m1 ?? "Hola, soy Víctor.";

  expect(
    (
      await call("POST", "/api/prospects/threads", {
        lead_id: leadId,
        handle: handleFor(leadId),
        name: null,
        nicho: null,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call("POST", "/api/prospects/drafts", {
        draft_id: `m1_${leadId}`,
        lead_id: leadId,
        kind: "m1",
        stage: "M1",
        text: m1,
        base_version: 0,
      })
    ).status,
  ).toBe(201);
  expect(
    (await call("POST", "/api/prospects/expected-m1", { lead_id: leadId, text: m1 })).status,
  ).toBe(200);
  await deliver(echo({ text: m1, peerId, mid: `mid_echo_${leadId}`, at: o.echoAt }));

  if (o.reply !== undefined && o.replyAt !== undefined) {
    await deliver(inbound({ text: o.reply, peerId, mid: `mid_in_${leadId}_1`, at: o.replyAt }));
  }
  return leadId;
}

async function threadRow(leadId: string) {
  const row = await env.DB.prepare(`SELECT * FROM prospect_threads WHERE lead_id = ?`)
    .bind(leadId)
    .first<{ version: number; last_outbound_at: number | null; last_inbound_at: number | null }>();
  if (!row) throw new Error(`thread ${leadId} not found`);
  return row;
}

async function pushDraft(o: {
  draftId: string;
  leadId?: string;
  text?: string;
  baseVersion?: number;
  createdAt?: number;
}): Promise<void> {
  const leadId = o.leadId ?? "lead-1";
  const created = await call("POST", "/api/prospects/drafts", {
    draft_id: o.draftId,
    lead_id: leadId,
    kind: "reply",
    stage: "Filtro",
    text: o.text ?? "Te cuento cómo lo hacemos.",
    base_version: o.baseVersion ?? (await threadRow(leadId)).version,
  });
  expect(created.status).toBe(201);
  if (o.createdAt !== undefined) {
    await env.DB.prepare(`UPDATE prospect_drafts SET created_at = ? WHERE draft_id = ?`)
      .bind(o.createdAt, o.draftId)
      .run();
  }
}

async function authorize(
  draftId: string,
  over: { at?: number; expiresAt?: number; gateReason?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO prospect_authorizations (draft_id, category, gate_reason, expires_at, created_at)
     VALUES (?, 'copro_m2', ?, ?, ?)`,
  )
    .bind(draftId, over.gateReason ?? "", over.expiresAt ?? Date.now() + HOUR, over.at ?? Date.now())
    .run();
}

const draftStatus = async (draftId: string) =>
  (
    await env.DB.prepare(`SELECT status FROM prospect_drafts WHERE draft_id = ?`)
      .bind(draftId)
      .first<{ status: string }>()
  )?.status;

const outbound = async (leadId: string) => {
  const { results } = await env.DB.prepare(
    `SELECT mid, origin, text FROM prospect_messages
     WHERE lead_id = ? AND direction = 'out' ORDER BY sent_at ASC, mid ASC`,
  )
    .bind(leadId)
    .all<{ mid: string; origin: string; text: string }>();
  return results;
};

const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(IG_USER_ID));

/**
 * The switch as the Durable Object sees it.
 *
 * The object keeps its own copy of the bindings, separate from the env object a
 * test hands to `scheduled`; the retry path reads that copy, so a run that is
 * expected to send has to turn it on here as well.
 */
async function setDoSwitch(value?: string): Promise<void> {
  await runInDurableObject(account(), (instance: { env: Record<string, unknown> }) => {
    if (value === undefined) delete instance.env.PROSPECT_AUTOPILOT;
    else instance.env.PROSPECT_AUTOPILOT = value;
  });
}

/** One queue's slice of the page, so "not in this queue" is a real assertion. */
function section(html: string, id: string): string {
  const start = html.indexOf(`<section id="${id}"`);
  expect(start, `section ${id} missing`).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  expect(end, `section ${id} not closed`).toBeGreaterThan(start);
  return html.slice(start, end);
}

async function getPage(): Promise<string> {
  const session = await createSession(FIXTURE_SECRETS.DASHBOARD_PASSWORD);
  const request = new Request("https://freeply.test/prospects", {
    headers: { cookie: sessionCookie(session).split(";")[0] },
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response.text();
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM prospect_authorizations`).run();
  await env.DB.prepare(`DELETE FROM prospect_drafts`).run();
  await env.DB.prepare(`DELETE FROM prospect_messages`).run();
  await env.DB.prepare(`DELETE FROM prospect_threads`).run();
  await env.DB.prepare(`DELETE FROM campaigns`).run();
  await env.DB.prepare(`DELETE FROM accounts`).run();
  await account().clear();
  await setDoSwitch();
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "victoralcazar",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });
  stubMeta();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------- the switch */

describe("the autopilot switch", () => {
  it.each([
    ["unset", undefined],
    ["off", "off"],
    ["anything else", "yes"],
  ])("sends nothing when PROSPECT_AUTOPILOT is %s", async (_label, value) => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({ draftId: "draft-1", createdAt: now - 30 * MINUTE });
    await authorize("draft-1", { at: now - 30 * MINUTE });
    await setDoSwitch("on");

    await runScheduled(autopilotEnv(value));

    expect(calls).toEqual([]);
    expect(await draftStatus("draft-1")).toBe("waiting");
    // The switch is checked before the send path, not inside it: no claim was
    // taken, so approving this draft by hand later is untouched by the run.
    expect(await account().claimedDrafts("prospect:lead-1")).toEqual([]);
  });
});

/* --------------------------------------------------------- the human delay */

describe("the human delay", () => {
  it("spreads due_at over 3 to 12 minutes after the authorization, stable per draft", () => {
    const authorizedAt = 1_700_000_000_000;
    for (const draftId of ["draft-a", "draft-b", "draft-c", "draft-zzz"]) {
      const due = prospectAutopilotDueAt({ draftId, authorizedAt });
      expect(due - authorizedAt).toBeGreaterThanOrEqual(3 * MINUTE);
      expect(due - authorizedAt).toBeLessThanOrEqual(12 * MINUTE);
      // Same draft, same delay: a cron run must not keep pushing it back.
      expect(prospectAutopilotDueAt({ draftId, authorizedAt })).toBe(due);
    }
  });

  it("does not send before the delay and sends once it has passed", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    // A draft written long ago and authorized two minutes ago is not due yet:
    // the wait runs from the authorization, not from when the text was written.
    await pushDraft({ draftId: "draft-1", createdAt: now - 20 * HOUR });
    await authorize("draft-1", { at: now - 2 * MINUTE });
    await setDoSwitch("on");

    await runScheduled();
    expect(calls).toEqual([]);
    expect(await draftStatus("draft-1")).toBe("waiting");

    // Twelve minutes is the longest delay in the window, so past it the draft
    // is due whatever its id hashes to.
    await env.DB.prepare(
      `UPDATE prospect_authorizations SET created_at = ? WHERE draft_id = 'draft-1'`,
    )
      .bind(now - 13 * MINUTE)
      .run();

    await runScheduled();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/${IG_USER_ID}/messages`);
    expect(calls[0].body).toEqual({
      recipient: { id: "peer-1" },
      message: { text: "Te cuento cómo lo hacemos." },
    });
    expect(await draftStatus("draft-1")).toBe("sent");
    expect((await outbound("lead-1")).map((m) => m.origin)).toEqual(["echo_m1", "api"]);
  });
});

/* ------------------------------------------------------ what may be sent */

describe("what the autopilot may send", () => {
  it("sends only a waiting draft with a current, empty-gate authorization", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });

    const due = now - 30 * MINUTE;
    await pushDraft({ draftId: "draft-none", createdAt: due });
    await pushDraft({ draftId: "draft-expired", createdAt: due });
    await authorize("draft-expired", { at: due, expiresAt: now - 1000 });
    await pushDraft({ draftId: "draft-gated", createdAt: due });
    await authorize("draft-gated", { at: due, gateReason: "copro_template_mismatch" });
    await pushDraft({ draftId: "draft-approved", createdAt: due });
    await authorize("draft-approved", { at: due });
    await setDoSwitch("on");
    await env.DB.prepare(
      `UPDATE prospect_drafts SET status = 'approved', decided_text = text, decided_at = ?
       WHERE draft_id = 'draft-approved'`,
    )
      .bind(now)
      .run();

    await runScheduled();

    expect(calls).toEqual([]);
    for (const draftId of ["draft-none", "draft-expired", "draft-gated"]) {
      expect(await draftStatus(draftId)).toBe("waiting");
    }
    // An approved draft is the page's gesture, already attempted by the request
    // that approved it. The cron does not pick it up a second time.
    expect(await draftStatus("draft-approved")).toBe("approved");
  });

  it("sends at most five drafts per run", async () => {
    const now = Date.now();
    const due = now - 30 * MINUTE;
    for (let i = 0; i < 7; i++) {
      const leadId = `lead-${i}`;
      await lead({
        leadId,
        peerId: `peer-${i}`,
        echoAt: now - 3 * HOUR,
        reply: "Cuéntame más",
        replyAt: now - HOUR,
      });
      await pushDraft({ draftId: `draft-${i}`, leadId, createdAt: due });
      await authorize(`draft-${i}`, { at: due });
    }
    await setDoSwitch("on");

    await runScheduled();

    expect(calls).toHaveLength(5);
    // Oldest first, so the two left over are the last ones — and they stay
    // waiting for the next run rather than being dropped.
    for (let i = 0; i < 5; i++) expect(await draftStatus(`draft-${i}`)).toBe("sent");
    for (const i of [5, 6]) expect(await draftStatus(`draft-${i}`)).toBe("waiting");
  });

  it("never sends twice to the same thread within five minutes", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    await pushDraft({ draftId: "draft-1", createdAt: now - 30 * MINUTE });
    await authorize("draft-1", { at: now - 30 * MINUTE });
    await setDoSwitch("on");

    await runScheduled();
    expect(calls).toHaveLength(1);
    expect(await draftStatus("draft-1")).toBe("sent");

    // The lead writes again a moment later and the CLI answers at once: one
    // message just went out, so this one waits for the spacing to pass.
    await deliver(
      inbound({ text: "Vale, ¿y cómo?", peerId: "peer-1", mid: "mid_in_2", at: Date.now() }),
    );
    await pushDraft({ draftId: "draft-2", createdAt: now - 30 * MINUTE });
    await authorize("draft-2", { at: now - 30 * MINUTE });

    await runScheduled();
    expect(calls).toHaveLength(1);
    expect(await draftStatus("draft-2")).toBe("waiting");

    // Six minutes after the last outbound the spacing has passed.
    await env.DB.prepare(`UPDATE prospect_threads SET last_outbound_at = ? WHERE lead_id = ?`)
      .bind(now - 6 * MINUTE, "lead-1")
      .run();

    await runScheduled();
    expect(calls).toHaveLength(2);
    expect(calls[1].body.message).toEqual({ text: "Te cuento cómo lo hacemos." });
    expect(await draftStatus("draft-2")).toBe("sent");
  });

  it("sends at most one message per thread in a run", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR, reply: "Cuéntame más", replyAt: now - HOUR });
    for (const draftId of ["draft-a", "draft-b"]) {
      await pushDraft({ draftId, createdAt: now - 30 * MINUTE });
      await authorize(draftId, { at: now - 30 * MINUTE });
    }
    await setDoSwitch("on");

    await runScheduled();

    expect(calls).toHaveLength(1);
    expect(await draftStatus("draft-a")).toBe("sent");
    expect(await draftStatus("draft-b")).toBe("waiting");
  });
});

/* ------------------------------------------------------- the 20 h warning */

describe("the 20 h warning", () => {
  async function unanswered(leadId: string, waitedMs: number): Promise<void> {
    const now = Date.now();
    await lead({
      leadId,
      peerId: `peer-${leadId}`,
      echoAt: now - waitedMs - 2 * HOUR,
      reply: "Cuéntame más",
      replyAt: now - waitedMs,
    });
  }

  it("flags an unanswered inbound in /work, and says when the API can no longer answer", async () => {
    await unanswered("lead-fresh", HOUR);
    await unanswered("lead-warning", 21 * HOUR);
    await unanswered("lead-late", 25 * HOUR);

    const { status, json } = await call("GET", "/api/prospects/work");
    expect(status).toBe(200);

    const byLead = new Map(json.work.map((w: any) => [w.lead_id, w]));
    expect(byLead.get("lead-fresh")).toMatchObject({ expiring: false, expired: false });
    // Twenty hours is where a person still has time to answer by the API.
    expect(byLead.get("lead-warning")).toMatchObject({ expiring: true, expired: false });
    expect(byLead.get("lead-warning")).toMatchObject({
      inbound: { age_seconds: expect.any(Number) },
    });
    // Past twenty-four hours the API will not send it at all.
    expect(byLead.get("lead-late")).toMatchObject({ expiring: true, expired: true });
  });

  it("shows those threads in the page's Manual queue, with the wait that is left", async () => {
    await unanswered("lead-warning", 21 * HOUR);
    await unanswered("lead-late", 25 * HOUR);
    await unanswered("lead-fresh", HOUR);

    const html = await getPage();
    const manual = section(html, "manual");

    expect(manual).toContain(`@${handleFor("lead-warning")}`);
    expect(manual).toContain("A punto de caducar");
    expect(manual).toContain("hace 21 h");

    expect(manual).toContain(`@${handleFor("lead-late")}`);
    expect(manual).toContain("Fuera de ventana");

    // A wait that still has hours left is the CLI's work, not a manual one.
    expect(manual).not.toContain(`@${handleFor("lead-fresh")}`);
  });
});
