import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../../src/db";
import worker from "../../src/index";
import { prospectClaimKey } from "../../src/prospects-send";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/**
 * A message the operator typed on his phone (T8, S11).
 *
 * The M1 echo is the only enrollment. Once a thread is enrolled, every echo that
 * is not one of our recorded API sends is the account talking to that lead —
 * the only way a message written by hand reaches the Worker at all. It has to
 * move the conversation version and retire every draft written before it, or
 * the autopilot would answer a message it never saw. An echo from a peer that is
 * not enrolled stays dropped exactly as in T4: nothing stored, nothing logged
 * with content in it.
 */

const TOKEN = "test-api-token";
const apiEnv = { ...env, API_TOKEN: TOKEN };

const HOUR = 60 * 60 * 1000;

/* ------------------------------------------------------------ Meta's side */

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

/* --------------------------------------------------------------- traffic */

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const request = new Request(`https://freeply.test${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, apiEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const handleFor = (leadId: string) => leadId.replace(/[^a-z0-9._]/g, ".").slice(0, 30);

/** The production path to an enrolled thread, then the lead's reply. */
async function enrolledLead(o: {
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
    await deliver(inbound({ text: o.reply, peerId, mid: `mid_in_${leadId}`, at: o.replyAt }));
  }
  return leadId;
}

async function pushDraft(o: {
  draftId: string;
  leadId?: string;
  text: string;
  baseVersion?: number;
}): Promise<void> {
  const leadId = o.leadId ?? "lead-1";
  const version = o.baseVersion ?? (await threadRow(leadId)).version;
  const created = await call("POST", "/api/prospects/drafts", {
    draft_id: o.draftId,
    lead_id: leadId,
    kind: "reply",
    stage: "Filtro",
    text: o.text,
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
    .first<{ status: string; decided_at: number | null }>();
  if (!row) throw new Error(`draft ${draftId} not found`);
  return row;
}

interface MessageRow {
  mid: string;
  direction: string;
  origin: string;
  text: string;
  sent_at: number;
}

async function messages(leadId: string): Promise<MessageRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT mid, direction, origin, text, sent_at
     FROM prospect_messages WHERE lead_id = ? ORDER BY sent_at ASC, mid ASC`,
  )
    .bind(leadId)
    .all<MessageRow>();
  return results;
}

/** The account's Durable Object, where a send's claim lives while it is in flight. */
const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(IG_USER_ID));

function captureLogs() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  vi.spyOn(console, "warn").mockImplementation(record);
  return lines;
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM prospect_authorizations`).run();
  await env.DB.prepare(`DELETE FROM prospect_drafts`).run();
  await env.DB.prepare(`DELETE FROM prospect_messages`).run();
  await env.DB.prepare(`DELETE FROM prospect_threads`).run();
  await env.DB.prepare(`DELETE FROM accounts`).run();
  // Claims outlive a test in this pool, so they have to go with the rows they
  // referred to.
  await account().clear();
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
});

/* ------------------------------------------------------------------ tests */

/**
 * The M1 is sent by hand, so no API send ever records it and its draft would sit
 * in `waiting` for good — the CLI counted those as work still pending (T10, S3).
 * The echo that enrolls the thread is the proof it went out, and it closes the
 * draft in the same write.
 */
describe("the M1 echo that enrolls a thread", () => {
  it("closes the lead's waiting M1 draft", async () => {
    const now = Date.now();
    const echoAt = now - 3 * HOUR;
    await enrolledLead({ echoAt });

    const exported = await call("GET", "/api/prospects/export");
    expect(exported.status).toBe(200);
    expect((await exported.json()).drafts).toEqual([
      expect.objectContaining({
        draft_id: "m1_lead-1",
        lead_id: "lead-1",
        kind: "m1",
        status: "sent",
        // The moment the operator's phone sent it, as `enrolled_at` already is.
        decided_at: echoAt,
      }),
    ]);
  });

  /**
   * The close rides on the enrollment update winning. An echo whose registration
   * was read before the thread moved on enrolls nothing, so it must decide
   * nothing either — otherwise a draft nobody sent would look sent.
   */
  it("decides no draft when the enrollment does not win", async () => {
    const now = Date.now();
    const leadId = "lead-1";
    const m1 = "Hola, soy Víctor.";
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

    const echo = {
      leadId,
      igUserId: IG_USER_ID,
      igsid: "peer-1",
      mid: "mid_echo_1",
      text: m1,
      sentAt: now,
    };
    const stale = (await threadRow(leadId)).version + 1;
    expect(await db.enrollProspectThread(env.DB, { ...echo, expectedVersion: stale })).toBe(false);
    expect(await threadRow(leadId)).toMatchObject({ state: "m1_pendiente", igsid: null });
    expect(await draftRow(`m1_${leadId}`)).toMatchObject({
      status: "waiting",
      decided_at: null,
    });

    // The version the registration actually read enrolls, and closes the draft.
    expect(await db.enrollProspectThread(env.DB, { ...echo, expectedVersion: stale - 1 })).toBe(
      true,
    );
    const decided = await draftRow(`m1_${leadId}`);
    expect(decided.status).toBe("sent");

    // A redelivery cannot enroll a second time, so it cannot decide it again.
    const before = (await threadRow(leadId)).version;
    expect(await db.enrollProspectThread(env.DB, { ...echo, expectedVersion: before })).toBe(false);
    expect((await draftRow(`m1_${leadId}`)).decided_at).toBe(decided.decided_at);
  });
});

describe("an echo on an enrolled thread", () => {
  it("stores it as the operator's message and retires every pending draft", async () => {
    const now = Date.now();
    await enrolledLead({
      echoAt: now - 3 * HOUR,
      reply: "Cuéntame más",
      replyAt: now - HOUR,
    });
    await pushDraft({ draftId: "draft-waiting", text: "Gracias por responder." });
    await pushDraft({ draftId: "draft-approved", text: "Te cuento el proceso." });
    await env.DB.prepare(
      `UPDATE prospect_drafts SET status = 'approved', decided_text = text, decided_at = ?
       WHERE draft_id = 'draft-approved'`,
    )
      .bind(now)
      .run();

    const before = await threadRow("lead-1");
    const typed = "Te contesto yo, que acabo de verlo.";
    const at = now + 1000;
    await deliver(echo({ text: typed, peerId: "peer-1", mid: "mid_owner_1", at }));

    // The message the M1 echo never gave us: the account talking to this lead.
    expect(await messages("lead-1")).toContainEqual({
      mid: "mid_owner_1",
      direction: "out",
      origin: "owner",
      text: typed,
      sent_at: at,
    });

    // The conversation moved, so nothing written before it may still be sent.
    const after = await threadRow("lead-1");
    expect(after.version).toBe(before.version + 1);
    expect(after.last_outbound_at).toBe(at);
    for (const draftId of ["draft-waiting", "draft-approved"]) {
      expect((await draftRow(draftId)).status).toBe("invalidated");
    }

    // A redelivery of the same echo writes nothing: one message, one version.
    await deliver(echo({ text: typed, peerId: "peer-1", mid: "mid_owner_1", at }));
    expect(await threadRow("lead-1")).toMatchObject({ version: before.version + 1 });
    expect((await messages("lead-1")).filter((m) => m.mid === "mid_owner_1")).toHaveLength(1);
  });

  it("does not read the echo of an API send as an owner message", async () => {
    const now = Date.now();
    await enrolledLead({
      echoAt: now - 3 * HOUR,
      reply: "Cuéntame más",
      replyAt: now - HOUR,
    });
    await pushDraft({ draftId: "draft-1", text: "Gracias por responder." });
    const sent = await threadRow("lead-1");

    // T7 recorded the send Meta answered, so the echo carries a mid we know.
    await db.recordProspectSent(env.DB, {
      mid: "mid_api_1",
      leadId: "lead-1",
      igUserId: IG_USER_ID,
      igsid: "peer-1",
      draftId: "draft-1",
      text: "Gracias por responder.",
      sentAt: now,
      inboundMid: "mid_in_lead-1",
    });

    await deliver(
      echo({ text: "Gracias por responder.", peerId: "peer-1", mid: "mid_api_1", at: now + 1000 }),
    );

    const out = (await messages("lead-1")).filter((m) => m.direction === "out");
    expect(out.map((m) => m.origin)).toEqual(["echo_m1", "api"]);
    // Our own send must not spend a second message or a second version.
    expect(await threadRow("lead-1")).toMatchObject({ version: sent.version + 1 });
    expect((await draftRow("draft-1")).status).toBe("sent");
  });

  /**
   * The race this closes. Meta can deliver the echo of our own message before
   * the Durable Object has recorded the `message_id` it got back, and at that
   * moment the mid is unknown. The claim is the evidence: it is taken before the
   * network call and released only when nothing was sent, so a claim on a draft
   * of this thread whose text is this echo means the message is ours.
   */
  it("leaves an echo whose mid has not reached D1 yet to the API record", async () => {
    const now = Date.now();
    await enrolledLead({
      echoAt: now - 3 * HOUR,
      reply: "Cuéntame más",
      replyAt: now - HOUR,
    });
    const told = "Gracias por responder.";
    await pushDraft({ draftId: "draft-1", text: told });
    const before = await threadRow("lead-1");

    // The send path claimed the draft before calling Meta (T7). The echo lands
    // while the API response is still in flight, so the mid is unknown here.
    expect(await account().claim(prospectClaimKey("lead-1"), "draft-1")).toBe(true);
    await deliver(echo({ text: told, peerId: "peer-1", mid: "mid_api_race", at: now + 500 }));

    expect((await messages("lead-1")).filter((m) => m.origin === "owner")).toEqual([]);
    expect(await threadRow("lead-1")).toMatchObject({ version: before.version });
    expect((await draftRow("draft-1")).status).toBe("waiting");

    // The API response arrives: the same message is stored as ours, once.
    await db.recordProspectSent(env.DB, {
      mid: "mid_api_race",
      leadId: "lead-1",
      igUserId: IG_USER_ID,
      igsid: "peer-1",
      draftId: "draft-1",
      text: told,
      sentAt: now + 600,
      inboundMid: "mid_in_lead-1",
    });
    await deliver(echo({ text: told, peerId: "peer-1", mid: "mid_api_race", at: now + 700 }));

    const out = (await messages("lead-1")).filter((m) => m.direction === "out");
    expect(out.map((m) => [m.mid, m.origin])).toEqual([
      ["mid_echo_lead-1", "echo_m1"],
      ["mid_api_race", "api"],
    ]);
    expect((await draftRow("draft-1")).status).toBe("sent");
  });

  /**
   * An echo from a peer that is not enrolled is somebody's private message. It
   * is dropped in memory: no row, no version change, and nothing in the log that
   * would identify it or the person who sent it.
   */
  it("writes nothing for an echo from a peer that is not enrolled", async () => {
    const now = Date.now();
    await enrolledLead({
      echoAt: now - 3 * HOUR,
      reply: "Cuéntame más",
      replyAt: now - HOUR,
    });
    await pushDraft({ draftId: "draft-1", text: "Gracias por responder." });
    const before = await threadRow("lead-1");
    const lines = captureLogs();

    const text = "Un mensaje a un amigo";
    const mid = "mid_owner_stranger";
    await deliver(echo({ text, peerId: "friend-igsid", mid, at: now }));

    expect(await messages("lead-1")).toHaveLength(2);
    expect(await threadRow("lead-1")).toMatchObject({ version: before.version });
    expect((await draftRow("draft-1")).status).toBe("waiting");
    const logged = lines.join("\n");
    expect(logged).not.toContain(text);
    expect(logged).not.toContain(mid);
    expect(logged).not.toContain("friend-igsid");
  });
});

/**
 * A delivery is a batch, and one event in it can fail on its own — a write that
 * errors, an event we cannot read. The events after it are other messages that
 * arrived in the same second, and dropping them leaves a thread short by one.
 */
describe("a delivery carrying an event that fails", () => {
  it("still applies the events that follow it", async () => {
    const now = Date.now();
    await enrolledLead({
      echoAt: now - 3 * HOUR,
      reply: "Cuéntame más",
      replyAt: now - HOUR,
    });
    const before = await threadRow("lead-1");
    const lines = captureLogs();

    // The first echo carries a `text` that cannot be stored, so its write
    // throws. The second one is an ordinary owner message in the same batch.
    const typed = "Te contesto yo, que acabo de verlo.";
    const at = now + 1000;
    await deliver({
      object: "instagram",
      entry: [
        {
          id: IG_USER_ID,
          time: at,
          messaging: [
            {
              sender: { id: IG_USER_ID },
              recipient: { id: "peer-1" },
              timestamp: at,
              message: { mid: "mid_unreadable", text: {}, is_echo: true },
            },
            {
              sender: { id: IG_USER_ID },
              recipient: { id: "peer-1" },
              timestamp: at + 1,
              message: { mid: "mid_owner_1", text: typed, is_echo: true },
            },
          ],
        },
      ],
    });

    // The second event landed, once, and the first one wrote nothing.
    expect(await messages("lead-1")).toContainEqual({
      mid: "mid_owner_1",
      direction: "out",
      origin: "owner",
      text: typed,
      sent_at: at + 1,
    });
    expect(await threadRow("lead-1")).toMatchObject({ version: before.version + 1 });

    // The failure is a count and nothing else: no text, no mid, no error body.
    const logged = lines.join("\n");
    expect(logged).toContain("prospect webhook: failed=1");
    expect(logged).not.toContain(typed);
    expect(logged).not.toContain("mid_owner_1");
    expect(logged).not.toContain("mid_unreadable");
  });
});
