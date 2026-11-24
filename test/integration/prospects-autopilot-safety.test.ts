import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../../src/db";
import worker, { type Env } from "../../src/index";
import { approveProspectDraft } from "../../src/prospects";
import { prospectClaimKey } from "../../src/prospects-send";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/**
 * The safety properties of the autopilot, as the independent review found them
 * missing (T8, S5, S6).
 *
 * Each case here is a message that could reach a person when it must not:
 * a retry that outlives the kill switch, a hand-written message discarded
 * because a refused send still holds its claim, a queued draft reported as sent,
 * a switch value that is not quite `on`, and a "human" delay measured from the
 * wrong moment.
 */

const TOKEN = "test-api-token";
const apiEnv = { ...env, API_TOKEN: TOKEN };

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const CRON = "*/15 * * * *";

/** The hour of day in Lisbon, the way `inProspectSendingHours` reads it. */
function lisbonHour(at: number): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Lisbon",
      hour: "numeric",
      hourCycle: "h23",
    }).format(at),
  );
}

/**
 * The instant every case here runs at: noon in Lisbon, on the real clock's date.
 *
 * Two constraints pull in opposite directions. The autopilot sends only between
 * 09:00 and 21:00 in Lisbon, so a suite on the real clock would assert "sent"
 * against a cron that was entitled to send nothing at 03:00. But only `Date` is
 * faked: the pool's own timers, and workerd's alarm manager, keep the real
 * clock. A `Date` pinned in the past leaves the account's `pruneDueAt` and any
 * queued retry a year behind that real clock, so the alarm the object arms for
 * them is already overdue — workerd clamps it to now and runs it, `prune` reads
 * the faked past and doesn't advance, and the object re-arms the same overdue
 * alarm for as long as the process lives. The cases go green and vitest never
 * exits.
 *
 * Starting from the real instant and moving *forward* by whole hours to Lisbon
 * noon keeps both: the window is where the cases expect it, and everything the
 * object schedules — the daily prune, a retry's backoff — still lands after the
 * instant the alarm manager measures against. A whole number of hours, because
 * the cases below are written as offsets from this one.
 */
const LISBON_NOON = Date.now() + ((12 - lisbonHour(Date.now()) + 24) % 24) * HOUR;

/** Out of the window however the shift landed: 00:00 in Lisbon, that day or the next. */
const LISBON_MIDNIGHT = LISBON_NOON + 12 * HOUR;

/** The switch as the Worker sees it for this run: ("on" | "off" | anything). */
function runEnv(value?: string): Env {
  const base = { ...apiEnv } as Env;
  if (value === undefined) {
    const { PROSPECT_AUTOPILOT: _unset, ...rest } = base;
    return rest as Env;
  }
  return { ...base, PROSPECT_AUTOPILOT: value };
}

async function runScheduled(value?: string): Promise<void> {
  await worker.scheduled(
    {
      cron: CRON,
      scheduledTime: Date.now(),
      noRetry: () => {},
    } as unknown as ScheduledController,
    runEnv(value),
  );
}

/**
 * The switch as the account's Durable Object sees it.
 *
 * A Durable Object keeps its own copy of the Worker's bindings, and in this pool
 * that copy is separate from the object a test can hand to `fetch`/`scheduled`.
 * The retry path is what has to read it, so each case sets it here.
 */
const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(IG_USER_ID));

async function setDoSwitch(value?: string): Promise<void> {
  await runInDurableObject(account(), (instance: { env: Record<string, unknown> }) => {
    if (value === undefined) delete instance.env.PROSPECT_AUTOPILOT;
    else instance.env.PROSPECT_AUTOPILOT = value;
  });
}

/** Runs the outbox the way the alarm does: everything queued becomes due. */
async function fireRetry(): Promise<void> {
  await runInDurableObject(account(), async (instance, state) => {
    state.storage.sql.exec(`UPDATE outbox SET due_at = 0`);
    await instance.alarm();
  });
}

/* ------------------------------------------------------------ Meta's side */

interface Call {
  url: string;
  body: any;
}

let calls: Call[] = [];

const graph = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** One answer per call, in order; the last one repeats. */
function stubMeta(...answers: Array<() => Response>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: input instanceof URL ? input.toString() : String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)] ?? (() => ok());
      return answer();
    }),
  );
}

const ok = (mid = "mid_api") => graph(200, { message_id: mid });
const rateLimited = () => graph(429, { error: { code: 4, message: "Application request limit reached" } });

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
async function lead(o: { leadId?: string; peerId?: string; m1?: string; echoAt: number }): Promise<string> {
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
  await deliver(
    inbound({ text: "Cuéntame más", peerId, mid: `mid_in_${leadId}`, at: o.echoAt + HOUR }),
  );
  return leadId;
}

async function pushDraft(o: {
  draftId?: string;
  leadId?: string;
  text?: string;
  createdAt?: number;
}): Promise<void> {
  const leadId = o.leadId ?? "lead-1";
  const created = await call("POST", "/api/prospects/drafts", {
    draft_id: o.draftId ?? "draft-1",
    lead_id: leadId,
    kind: "reply",
    stage: "Filtro",
    text: o.text ?? "Te cuento cómo lo hacemos.",
    base_version: (
      await env.DB.prepare(`SELECT version FROM prospect_threads WHERE lead_id = ?`)
        .bind(leadId)
        .first<{ version: number }>()
    )?.version ?? 0,
  });
  expect(created.status).toBe(201);
  if (o.createdAt !== undefined) {
    await env.DB.prepare(`UPDATE prospect_drafts SET created_at = ? WHERE draft_id = ?`)
      .bind(o.createdAt, o.draftId ?? "draft-1")
      .run();
  }
}

/** The CLI's autopilot authorization, with the moment autonomy was granted. */
async function authorize(
  draftId: string,
  o: { at: number; expiresAt?: number; gateReason?: string } ,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO prospect_authorizations (draft_id, category, gate_reason, expires_at, created_at)
     VALUES (?, 'copro_m2', ?, ?, ?)`,
  )
    .bind(draftId, o.gateReason ?? "", o.expiresAt ?? Date.now() + HOUR, o.at)
    .run();
}

const draftStatus = async (draftId: string) =>
  (
    await env.DB.prepare(`SELECT status FROM prospect_drafts WHERE draft_id = ?`)
      .bind(draftId)
      .first<{ status: string }>()
  )?.status;

async function messages(leadId: string) {
  const { results } = await env.DB.prepare(
    `SELECT mid, direction, origin, text FROM prospect_messages
     WHERE lead_id = ? ORDER BY sent_at ASC, mid ASC`,
  )
    .bind(leadId)
    .all<{ mid: string; direction: string; origin: string; text: string }>();
  return results;
}

beforeEach(async () => {
  // Fixed before the account is created, so every row below shares one clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LISBON_NOON);
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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ---------------------------------------------------------------- blocker 1 */

describe("an autopilot retry is bound to the switch, not to the run that queued it", () => {
  /**
   * A 429 is Meta refusing to take the message: the draft stays waiting and its
   * job sits in the outbox behind a backoff. When the alarm comes back for it,
   * autonomy may already be off — and this is the path that never passed the
   * cron's check again.
   */
  it.each([
    ["off", "off"],
    ["unset", undefined],
  ])("does not send the queued retry when the switch is %s", async (_label, value) => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR });
    await pushDraft({ draftId: "draft-1", createdAt: now - 45 * MINUTE });
    await authorize("draft-1", { at: now - 45 * MINUTE });
    await setDoSwitch("on");
    stubMeta(rateLimited);

    await runScheduled("on");
    expect(calls).toHaveLength(1);
    expect(await draftStatus("draft-1")).toBe("waiting");

    // Autonomy is withdrawn before the backoff elapses.
    await setDoSwitch(value);
    stubMeta(() => ok("mid_api_retry"));
    await fireRetry();

    expect(calls).toEqual([]);
    expect(await draftStatus("draft-1")).toBe("waiting");
    // Nothing is left queued to try again while the switch is off, and the claim
    // is let go so a person can still approve this draft by hand.
    expect(await account().pendingCommentIds()).not.toContain("draft-1");
    expect(await account().claimedDrafts(prospectClaimKey("lead-1"))).not.toContain("draft-1");
  });

  /** The permission here is a person's approval, which the switch does not touch. */
  it("still retries a manually approved draft with the switch off", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR });
    await pushDraft({ draftId: "draft-1", createdAt: now - 30 * MINUTE });
    await setDoSwitch("on");
    stubMeta(rateLimited);

    // Aprobar on the page: a decision, not a gate, and it sends immediately.
    const approved = await approveProspectDraft(runEnv("on"), {
      draftId: "draft-1",
      text: "Te cuento cómo lo hacemos.",
    });
    expect(approved).toMatchObject({ ok: true, send: { status: "queued" } });
    expect(calls).toHaveLength(1);
    expect(await account().pendingCommentIds()).toContain("draft-1");

    await setDoSwitch("off");
    stubMeta(() => ok("mid_api_retry"));
    await fireRetry();

    expect(calls).toHaveLength(1);
    expect(await draftStatus("draft-1")).toBe("sent");
  });
});

/* --------------------------------------------------------------- the window */

describe("the sending window is the autopilot's, not the operator's", () => {
  /**
   * A person deciding to send is exactly what the window exists for: it governs
   * the messages nobody decided. Aprobar at midnight has to leave at midnight.
   */
  it("sends a draft a person approves outside the window", async () => {
    vi.setSystemTime(LISBON_MIDNIGHT);
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR });
    await pushDraft({ draftId: "draft-1", createdAt: now - 45 * MINUTE });
    await setDoSwitch("on");
    stubMeta(ok);

    const approved = await approveProspectDraft(runEnv("on"), {
      draftId: "draft-1",
      text: "Te cuento cómo lo hacemos.",
    });

    expect(approved).toMatchObject({ ok: true, send: { status: "sent" } });
    expect(calls).toHaveLength(1);
    expect(await draftStatus("draft-1")).toBe("sent");
  });
});

/* ---------------------------------------------------------------- blocker 2 */

describe("a refused send is not evidence that a message went out", () => {
  /**
   * After a 429 the claim is kept, so the send path can recognise its own retry.
   * It is not evidence the request reached Meta: Meta answered, and answered
   * with a refusal. A message the operator types by hand that happens to match
   * the queued draft is his, and the queue behind it has to be dropped.
   */
  it("stores a hand-written message that matches a queued draft, and cancels the queue", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR });
    const told = "Te cuento cómo lo hacemos.";
    await pushDraft({ draftId: "draft-1", text: told, createdAt: now - 45 * MINUTE });
    await authorize("draft-1", { at: now - 45 * MINUTE });
    await setDoSwitch("on");
    stubMeta(rateLimited);

    await runScheduled("on");
    expect(calls).toHaveLength(1);
    expect(await account().pendingCommentIds()).toContain("draft-1");

    // The operator opens the chat and writes the same thing himself, so the
    // echo arrives with a mid no send of ours ever had.
    await deliver(echo({ text: told, peerId: "peer-1", mid: "mid_owner_1", at: now + 1000 }));

    const out = (await messages("lead-1")).filter((m) => m.direction === "out");
    expect(out).toContainEqual({
      mid: "mid_owner_1",
      direction: "out",
      origin: "owner",
      text: told,
    });
    expect(await draftStatus("draft-1")).toBe("invalidated");
    // The queued retry is settled, so it can never send that draft afterwards.
    expect(await account().pendingCommentIds()).not.toContain("draft-1");
  });

  /**
   * The case the claim is for: the API request is executing, so its echo may
   * arrive before the response records the mid. Nothing is written now; T7
   * records the message itself in a moment.
   */
  it("still treats the echo of an executing send as ours", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR });
    const told = "Te cuento cómo lo hacemos.";
    await pushDraft({ draftId: "draft-1", text: told });
    const before = (
      await env.DB.prepare(`SELECT version FROM prospect_threads WHERE lead_id = 'lead-1'`)
        .first<{ version: number }>()
    )?.version;

    // A claim with no outbox row: the job is running right now.
    expect(await account().claim("prospect:lead-1", "draft-1")).toBe(true);
    await deliver(echo({ text: told, peerId: "peer-1", mid: "mid_api_race", at: now + 500 }));

    expect((await messages("lead-1")).filter((m) => m.origin === "owner")).toEqual([]);
    expect(
      (
        await env.DB.prepare(`SELECT version FROM prospect_threads WHERE lead_id = 'lead-1'`)
          .first<{ version: number }>()
      )?.version,
    ).toBe(before);
    expect(await draftStatus("draft-1")).toBe("waiting");
  });
});

/* ---------------------------------------------------------------- blocker 3 */

describe("a queued draft is not a sent one", () => {
  /**
   * Between the refusal and the retry, the draft is waiting with its job in the
   * outbox. A later cron pass sees the held claim and nothing else: it must skip
   * the draft and leave the retry alone, never report it as sent.
   */
  it("leaves a queued draft waiting and keeps its retry", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR });
    await pushDraft({ draftId: "draft-1", createdAt: now - 45 * MINUTE });
    await authorize("draft-1", { at: now - 45 * MINUTE });
    await setDoSwitch("on");
    stubMeta(rateLimited);

    await runScheduled("on");
    expect(calls).toHaveLength(1);
    expect(await draftStatus("draft-1")).toBe("waiting");
    expect(await account().pendingCommentIds()).toContain("draft-1");

    stubMeta(() => ok("mid_api_second"));
    await runScheduled("on");

    expect(calls).toEqual([]);
    expect(await draftStatus("draft-1")).toBe("waiting");
    expect(await account().pendingCommentIds()).toContain("draft-1");
  });
});

/* ---------------------------------------------------------------- blocker 4 */

describe("the switch is the exact literal on", () => {
  it.each([" on", "on ", " On ", "ON", "true"])(
    "does not treat %j as permission to send",
    async (value) => {
      const now = Date.now();
      await lead({ echoAt: now - 3 * HOUR });
      await pushDraft({ draftId: "draft-1", createdAt: now - 45 * MINUTE });
      await authorize("draft-1", { at: now - 45 * MINUTE });
      await setDoSwitch("on");
      stubMeta(ok);

      await runScheduled(value);

      expect(calls).toEqual([]);
      expect(await draftStatus("draft-1")).toBe("waiting");
    },
  );
});

/* ---------------------------------------------------------------- blocker 5 */

describe("the human delay runs from the authorization", () => {
  /**
   * A draft can be written long before the CLI graduates its stage and grants
   * autonomy. The wait that matters is the one since autonomy was granted: a
   * draft written yesterday must not leave the moment the gate says yes.
   */
  it("does not send a fresh authorization for an old draft, and sends once it has waited", async () => {
    const now = Date.now();
    await lead({ echoAt: now - 3 * HOUR });
    await pushDraft({ draftId: "draft-1", createdAt: now - 20 * HOUR });
    await setDoSwitch("on");
    stubMeta(ok);

    await authorize("draft-1", { at: now });
    await runScheduled("on");
    expect(calls).toEqual([]);
    expect(await draftStatus("draft-1")).toBe("waiting");

    // Forty minutes is the longest delay in the window, so past it this draft
    // is due whatever its id hashes to.
    await env.DB.prepare(
      `UPDATE prospect_authorizations SET created_at = ? WHERE draft_id = 'draft-1'`,
    )
      .bind(now - 45 * MINUTE)
      .run();

    await runScheduled("on");
    expect(calls).toHaveLength(1);
    expect(await draftStatus("draft-1")).toBe("sent");
  });
});
