import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../../src/db";
import worker from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/**
 * The prospect API the Pi CLI reads and writes through.
 *
 * Enrollment itself happens on the webhook (test/integration/prospects.test.ts);
 * here the echo is used the way production uses it — to create a lead the API
 * may then return. Every assertion on `work`/`export` doubles as the privacy
 * check: only threads the operator registered exist at all.
 */

const TOKEN = "test-api-token";
const apiEnv = { ...env, API_TOKEN: TOKEN };

const HOUR = 60 * 60 * 1000;

async function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { token?: string | null; env?: typeof apiEnv } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const request = new Request(`https://freeply.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, opts.env ?? apiEnv, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json() };
}

const normalize = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();

async function textSha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalize(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

/** A webhook delivery, so enrollment goes through the path production uses. */
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

/** Instagram handles allow letters, dots and underscores only. */
const handleFor = (leadId: string) => leadId.replace(/[^a-z0-9._]/g, ".").slice(0, 30);

/** Registers a lead through the API, then enrolls it with the exact M1 echo. */
async function enroll(over: {
  leadId: string;
  peerId: string;
  m1: string;
  at: number;
}): Promise<void> {
  const created = await call("POST", "/api/prospects/threads", {
    lead_id: over.leadId,
    handle: handleFor(over.leadId),
  });
  expect(created.status).toBe(201);
  const registered = await call("POST", "/api/prospects/expected-m1", {
    lead_id: over.leadId,
    text: over.m1,
  });
  expect(registered.status).toBe(200);
  await deliver(
    echo({ text: over.m1, peerId: over.peerId, mid: `mid_echo_${over.leadId}`, at: over.at }),
  );
}

/** An outbound row as the send path (T7) would leave it. */
async function recordOutbound(leadId: string, mid: string, text: string, at: number) {
  await env.DB.prepare(
    `INSERT INTO prospect_messages (mid, lead_id, direction, origin, text, sent_at, created_at)
     VALUES (?, ?, 'out', 'api', ?, ?, ?)`,
  )
    .bind(mid, leadId, text, at, at)
    .run();
  await env.DB.prepare(
    `UPDATE prospect_threads SET version = version + 1, last_outbound_at = ? WHERE lead_id = ?`,
  )
    .bind(at, leadId)
    .run();
}

async function threadVersion(leadId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT version FROM prospect_threads WHERE lead_id = ?`)
    .bind(leadId)
    .first<{ version: number }>();
  if (!row) throw new Error(`thread ${leadId} not found`);
  return row.version;
}

async function draftCount(): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM prospect_drafts`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM prospect_authorizations`).run();
  await env.DB.prepare(`DELETE FROM prospect_drafts`).run();
  await env.DB.prepare(`DELETE FROM prospect_messages`).run();
  await env.DB.prepare(`DELETE FROM prospect_threads`).run();
  await env.DB.prepare(`DELETE FROM accounts`).run();
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "victoralcazar",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });
});

afterEach(() => vi.restoreAllMocks());

const ROUTES: Array<[string, string, unknown]> = [
  ["POST", "/api/prospects/threads", { lead_id: "l", handle: "a" }],
  ["POST", "/api/prospects/threads/close", { lead_id: "l", reason: "otro" }],
  ["POST", "/api/prospects/expected-m1", { lead_id: "l", text: "Hola" }],
  ["POST", "/api/prospects/drafts", { draft_id: "d", lead_id: "l" }],
  ["GET", "/api/prospects/work", undefined],
  ["POST", "/api/prospects/authorizations", { draft_id: "d", category: "c" }],
  ["GET", "/api/prospects/export", undefined],
];

describe("prospect api auth", () => {
  /**
   * The rest of the suite runs with `API_TOKEN` from `.dev.vars`, which is why
   * json-api's "unset" test gets 401 there; the unset case has to be explicit.
   */
  it("answers 404 for every prospects route when API_TOKEN is unset", async () => {
    for (const [method, path, body] of ROUTES) {
      const r = await call(method, path, body, { env: { ...env, API_TOKEN: "" } });
      expect(r).toEqual({ status: 404, json: { error: "not_found" } });
    }
  });

  it("answers 401 for a missing or wrong token", async () => {
    for (const [method, path, body] of ROUTES) {
      expect((await call(method, path, body, { token: null })).status).toBe(401);
      expect((await call(method, path, body, { token: "nope" })).json).toEqual({
        error: "unauthorized",
      });
    }
  });
});

describe("POST /api/prospects/threads", () => {
  it("creates a lead thread from the Sheet row and refreshes it in place", async () => {
    const created = await call("POST", "/api/prospects/threads", {
      lead_id: "lead-1",
      handle: "@Ana.Leads",
      name: "Ana",
      nicho: "agencias",
    });
    expect(created.status).toBe(201);
    expect(created.json.thread).toMatchObject({
      lead_id: "lead-1",
      ig_user_id: IG_USER_ID,
      handle: "ana.leads",
      name: "Ana",
      nicho: "agencias",
      state: "m1_pendiente",
      m1_sha: null,
      version: 0,
    });
    // The peer id is how the webhook recognises the lead; a client never needs it.
    expect(created.json.thread).not.toHaveProperty("igsid");

    const refreshed = await call("POST", "/api/prospects/threads", {
      lead_id: "lead-1",
      handle: "ana.leads",
      nicho: "viajes",
      m1_text: "Hola, soy Víctor. ¿Cómo lo lleváis?",
    });
    expect(refreshed.status).toBe(200);
    // Omitted fields keep their value; a refresh never resets the row. The M1
    // text arrives through the same registration `expected-m1` performs.
    expect(refreshed.json.thread).toMatchObject({
      lead_id: "lead-1",
      handle: "ana.leads",
      name: "Ana",
      nicho: "viajes",
      state: "m1_pendiente",
      m1_sha: await textSha("Hola, soy Víctor. ¿Cómo lo lleváis?"),
      version: 0,
    });
    expect(refreshed.json.thread.m1_registered_at).toBeGreaterThan(0);

    // An enrolled thread cannot be re-armed: its echo is already known.
    const at = Date.now() - HOUR;
    await enroll({
      leadId: "lead-2",
      peerId: "peer-2",
      m1: "Hola, soy Víctor. Te escribo por tu agencia.",
      at,
    });
    expect(
      await call("POST", "/api/prospects/threads", {
        lead_id: "lead-2",
        handle: handleFor("lead-2"),
        m1_text: "Otra cosa",
      }),
    ).toEqual({ status: 409, json: { error: "already_enrolled" } });

    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM prospect_threads`).first<{
      n: number;
    }>();
    expect(row?.n).toBe(2);
  });

  it("rejects a handle Instagram cannot have", async () => {
    const r = await call("POST", "/api/prospects/threads", {
      lead_id: "lead-1",
      handle: "not a handle!",
    });
    expect(r).toEqual({
      status: 400,
      json: { error: "invalid_field", detail: "handle: must be an Instagram handle" },
    });
    expect(
      (
        await call("POST", "/api/prospects/threads", {
          lead_id: "lead-1",
          handle: "ana",
          ig_user_id: "17841400000009999",
        })
      ).status,
    ).toBe(400);
  });

  it("tells a stateless pass whether the row was new or a refresh", async () => {
    const created = await call("POST", "/api/prospects/threads", {
      lead_id: "lead-1",
      handle: "ana.leads",
    });
    expect(created.status).toBe(201);
    expect(created.json.created).toBe(true);

    const refreshed = await call("POST", "/api/prospects/threads", {
      lead_id: "lead-1",
      handle: "ana.leads",
      nicho: "viajes",
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.created).toBe(false);

    // Arming the M1 on an existing thread is a refresh too, not a second create.
    const armed = await call("POST", "/api/prospects/threads", {
      lead_id: "lead-1",
      handle: "ana.leads",
      m1_text: "Hola, soy Víctor.",
    });
    expect(armed.status).toBe(200);
    expect(armed.json.created).toBe(false);
  });

  /** What T14's Business Discovery read hands the CLI: profile data, never an id. */
  const PROFILE = {
    handle: "ana.leads",
    name: "Ana",
    biography: "Agencia de viajes boutique · Japón y Escandinavia",
    followers: 12400,
    media_count: 87,
    website: "https://analeds.example",
    recent_posts: [
      {
        caption: "Nuevo destino: Japón en otoño",
        date: "2026-11-02",
        permalink: "https://www.instagram.com/p/Cabc123/",
        source: "business_discovery",
      },
    ],
    source: "business_discovery",
  };

  it("stores the profile evidence a reply can quote, and keeps it across a refresh", async () => {
    const readAt = Date.now() - HOUR;
    const created = await call("POST", "/api/prospects/threads", {
      lead_id: "lead-1",
      handle: "ana.leads",
      profile_summary: PROFILE,
      profile_read_at: readAt,
    });
    expect(created.status).toBe(201);
    expect(created.json.thread.profile_summary).toEqual(PROFILE);
    expect(created.json.thread.profile_read_at).toBe(readAt);

    // The Sheet resync sends the Sheet's columns only. Evidence a reply depends
    // on is not erased by a refresh that does not mention it.
    const refreshed = await call("POST", "/api/prospects/threads", {
      lead_id: "lead-1",
      handle: "ana.leads",
      nicho: "viajes",
    });
    expect(refreshed.json.thread.profile_summary).toEqual(PROFILE);
    expect(refreshed.json.thread.profile_read_at).toBe(readAt);

    const exported = await call("GET", "/api/prospects/export");
    expect(exported.json.threads).toEqual([
      expect.objectContaining({
        lead_id: "lead-1",
        profile_summary: PROFILE,
        profile_read_at: readAt,
      }),
    ]);

    // Once the echo enrolled the thread, the profile is what M2 and the Filtro
    // are authorized on — so a refresh has to be able to record it there too.
    await call("POST", "/api/prospects/expected-m1", {
      lead_id: "lead-1",
      text: "Hola, soy Víctor.",
    });
    await deliver(
      echo({ text: "Hola, soy Víctor.", peerId: "peer-1", mid: "mid_echo_lead-1", at: readAt }),
    );
    const later = { ...PROFILE, followers: 12500 };
    const enrolled = await call("POST", "/api/prospects/threads", {
      lead_id: "lead-1",
      handle: "ana.leads",
      profile_summary: later,
      profile_read_at: Date.now(),
    });
    expect(enrolled.status).toBe(200);
    expect(enrolled.json.thread).toMatchObject({ state: "enrolled", profile_summary: later });
  });

  it("refuses profile evidence that carries an account id, is not an object, or is oversized", async () => {
    const post = { caption: "Un viaje", permalink: "https://www.instagram.com/p/Cabc123/" };
    const cases: Array<[unknown, string]> = [
      [{ igsid: "17841400000000001" }, "profile_summary: must not carry an account id"],
      [
        { recent_posts: [{ ...post, id: "17841400000000001" }] },
        "profile_summary: must not carry an account id",
      ],
      // A bare digit run is an id wherever it sits: a profile read is not a way
      // to address a message (L12).
      [{ recent_posts: [post], source: "17841400000000001" }, "profile_summary: must not carry an account id"],
      ["biography: Ana", "profile_summary: must be a JSON object"],
      [[post], "profile_summary: must be a JSON object"],
      [{ biography: "x".repeat(9000) }, "profile_summary: over 8192 bytes"],
    ];

    for (const [profile_summary, detail] of cases) {
      expect(
        await call("POST", "/api/prospects/threads", {
          lead_id: "lead-1",
          handle: "ana.leads",
          profile_summary,
        }),
      ).toEqual({ status: 400, json: { error: "invalid_field", detail } });
    }

    // None of them wrote anything: the payload is validated before the thread is
    // touched, so a refusal cannot leave half a row behind.
    expect((await call("GET", "/api/prospects/export")).json.threads).toEqual([]);
  });
});

describe("POST /api/prospects/threads/close", () => {
  it("closes a pending, an unconfirmed and an enrolled thread", async () => {
    const at = Date.now() - HOUR;
    await call("POST", "/api/prospects/threads", { lead_id: "lead-pending", handle: "lead.pending" });
    await call("POST", "/api/prospects/threads", {
      lead_id: "lead-unconfirmed",
      handle: "lead.unconfirmed",
    });
    await env.DB.prepare(
      `UPDATE prospect_threads SET state = 'm1_sin_confirmar' WHERE lead_id = ?`,
    )
      .bind("lead-unconfirmed")
      .run();
    await enroll({ leadId: "lead-enrolled", peerId: "peer-enrolled", m1: "Hola, soy Víctor.", at });

    for (const [leadId, reason] of [
      ["lead-pending", "no_interesa"],
      ["lead-unconfirmed", "fuera_de_nicho"],
      ["lead-enrolled", "no_interesa"],
    ] as const) {
      const r = await call("POST", "/api/prospects/threads/close", {
        lead_id: leadId,
        reason,
      });
      expect(r.status).toBe(200);
      expect(r.json.closed).toBe(true);
      expect(r.json.thread).toMatchObject({ lead_id: leadId, state: "closed", close_reason: reason });
    }

    const exported = await call("GET", "/api/prospects/export");
    const byLead = Object.fromEntries(
      exported.json.threads.map((t: any) => [t.lead_id, [t.state, t.close_reason]]),
    );
    expect(byLead).toEqual({
      "lead-pending": ["closed", "no_interesa"],
      "lead-unconfirmed": ["closed", "fuera_de_nicho"],
      "lead-enrolled": ["closed", "no_interesa"],
    });
  });

  it("rejects an unknown reason and an unknown lead", async () => {
    await call("POST", "/api/prospects/threads", { lead_id: "lead-1", handle: "ana.leads" });

    expect(
      await call("POST", "/api/prospects/threads/close", {
        lead_id: "lead-1",
        reason: "spam",
      }),
    ).toEqual({
      status: 400,
      json: {
        error: "invalid_field",
        detail: "reason: must be one of no_interesa, fuera_de_nicho, no_reply, otro",
      },
    });
    expect(
      await call("POST", "/api/prospects/threads/close", { lead_id: "lead-1" }),
    ).toEqual({ status: 400, json: { error: "invalid_field", detail: "reason: must be a string" } });
    expect(
      await call("POST", "/api/prospects/threads/close", {
        lead_id: "nope",
        reason: "otro",
      }),
    ).toEqual({ status: 404, json: { error: "not_found" } });

    expect((await call("GET", "/api/prospects/export")).json.threads[0].state).toBe(
      "m1_pendiente",
    );
  });

  it("is idempotent with the same reason and refuses a different one", async () => {
    const at = Date.now() - HOUR;
    await enroll({ leadId: "lead-1", peerId: "peer-1", m1: "Hola, soy Víctor.", at });

    const first = await call("POST", "/api/prospects/threads/close", {
      lead_id: "lead-1",
      reason: "no_interesa",
    });
    expect(first.status).toBe(200);
    expect(first.json.closed).toBe(true);

    const again = await call("POST", "/api/prospects/threads/close", {
      lead_id: "lead-1",
      reason: "no_interesa",
    });
    expect(again).toEqual({ status: 200, json: { closed: false } });

    const conflict = await call("POST", "/api/prospects/threads/close", {
      lead_id: "lead-1",
      reason: "otro",
    });
    expect(conflict).toEqual({ status: 409, json: { error: "thread_closed" } });

    // The first reason stands; a later request never rewrites why.
    expect((await call("GET", "/api/prospects/export")).json.threads[0].close_reason).toBe(
      "no_interesa",
    );
  });

  it("invalidates pending drafts and refuses to re-arm the thread", async () => {
    const at = Date.now() - HOUR;
    await enroll({ leadId: "lead-1", peerId: "peer-1", m1: "Hola, soy Víctor.", at });
    await deliver(
      inbound({ peerId: "peer-1", text: "Cuéntame más", mid: "mid_in_1", at: at + 1000 }),
    );
    const version = await threadVersion("lead-1");

    for (const [draftId, status] of [
      ["draft-waiting", "waiting"],
      ["draft-approved", "approved"],
    ] as const) {
      await call("POST", "/api/prospects/drafts", {
        draft_id: draftId,
        lead_id: "lead-1",
        kind: "reply",
        stage: "Filtro",
        text: "Te cuento.",
        base_version: version,
      });
      if (status === "approved") {
        await env.DB.prepare(
          `UPDATE prospect_drafts SET status = 'approved', decided_text = ?, decided_at = ?
           WHERE draft_id = ?`,
        )
          .bind("Te cuento.", at, draftId)
          .run();
      }
    }

    const closed = await call("POST", "/api/prospects/threads/close", {
      lead_id: "lead-1",
      reason: "no_interesa",
    });
    expect(closed.status).toBe(200);

    const drafts = await call("GET", "/api/prospects/export");
    const statuses = Object.fromEntries(
      drafts.json.drafts.map((d: any) => [d.draft_id, d.status]),
    );
    expect(statuses).toEqual({
      "draft-waiting": "invalidated",
      "draft-approved": "invalidated",
    });

    // A closed thread can never be armed again, through either route.
    expect(
      await call("POST", "/api/prospects/expected-m1", {
        lead_id: "lead-1",
        text: "Hola, soy Víctor.",
      }),
    ).toEqual({ status: 409, json: { error: "thread_closed" } });
    expect(
      await call("POST", "/api/prospects/threads", {
        lead_id: "lead-1",
        handle: handleFor("lead-1"),
        m1_text: "Hola, soy Víctor.",
      }),
    ).toEqual({ status: 409, json: { error: "thread_closed" } });
  });
});

describe("POST /api/prospects/expected-m1", () => {
  it("registers the copied text as the pending M1, by its normalized hash", async () => {
    await call("POST", "/api/prospects/threads", { lead_id: "lead-1", handle: "ana.leads" });

    const r = await call("POST", "/api/prospects/expected-m1", {
      lead_id: "lead-1",
      text: "  Hola,   soy Vi\u0301ctor.  ",
    });
    expect(r.status).toBe(200);
    expect(r.json.thread).toMatchObject({
      lead_id: "lead-1",
      state: "m1_pendiente",
      m1_sha: await textSha("Hola, soy Víctor."),
    });
    expect(r.json.thread.m1_registered_at).toBeGreaterThan(0);
  });

  it("answers already_enrolled once the echo has enrolled the thread", async () => {
    const at = Date.now() - HOUR;
    await enroll({ leadId: "lead-1", peerId: "peer-1", m1: "Hola, soy Víctor.", at });

    const r = await call("POST", "/api/prospects/expected-m1", {
      lead_id: "lead-1",
      text: "Hola, soy Víctor.",
    });
    expect(r).toEqual({ status: 409, json: { error: "already_enrolled" } });
  });

  it("rejects an empty text and an unknown lead", async () => {
    await call("POST", "/api/prospects/threads", { lead_id: "lead-1", handle: "ana.leads" });

    expect(
      await call("POST", "/api/prospects/expected-m1", { lead_id: "lead-1", text: "   " }),
    ).toEqual({
      status: 400,
      json: { error: "invalid_field", detail: "text: must be non-empty" },
    });
    expect(
      (await call("POST", "/api/prospects/expected-m1", { lead_id: "nope", text: "Hola" })).status,
    ).toBe(404);
  });
});

describe("POST /api/prospects/drafts", () => {
  const draft = {
    draft_id: "draft-1",
    lead_id: "lead-1",
    kind: "m1",
    stage: "M1",
    text: "Hola, soy Víctor. ¿Cómo lo lleváis?",
    base_version: 0,
  };

  beforeEach(async () => {
    await call("POST", "/api/prospects/threads", { lead_id: "lead-1", handle: "ana.leads" });
  });

  it("is idempotent by draft_id: the same push stores one row and answers it again", async () => {
    const first = await call("POST", "/api/prospects/drafts", draft);
    expect(first.status).toBe(201);
    expect(first.json.created).toBe(true);
    expect(first.json.draft).toMatchObject({
      ...draft,
      status: "waiting",
      decided_at: null,
      decided_text: null,
    });

    const again = await call("POST", "/api/prospects/drafts", { ...draft, text: `${draft.text}` });
    expect(again.status).toBe(200);
    expect(again.json.created).toBe(false);
    expect(again.json.draft).toEqual(first.json.draft);
    expect(await draftCount()).toBe(1);
  });

  it("answers draft_conflict when the same draft_id carries different content", async () => {
    await call("POST", "/api/prospects/drafts", draft);

    const r = await call("POST", "/api/prospects/drafts", { ...draft, text: "Otro texto" });
    expect(r).toEqual({
      status: 409,
      json: {
        error: "draft_conflict",
        detail: "draft_id: already stored with different content",
      },
    });

    const stored = await env.DB.prepare(`SELECT text FROM prospect_drafts WHERE draft_id = ?`)
      .bind("draft-1")
      .first<{ text: string }>();
    expect(stored?.text).toBe(draft.text);
  });

  it("rejects an unknown kind", async () => {
    expect(await call("POST", "/api/prospects/drafts", { ...draft, kind: "post" })).toEqual({
      status: 400,
      json: { error: "invalid_field", detail: "kind: must be m1 or reply" },
    });
  });

  it("stores the M1 variant and exports it, which is what the A/B rate is counted on", async () => {
    const first = await call("POST", "/api/prospects/drafts", { ...draft, variant_id: "B" });
    expect(first.status).toBe(201);
    expect(first.json.draft.variant_id).toBe("B");

    // A reply has no variant, and the field is present and null rather than
    // missing: a caller reading the export never has to guess.
    const reply = await call("POST", "/api/prospects/drafts", {
      draft_id: "draft-2",
      lead_id: "lead-1",
      kind: "reply",
      stage: "Filtro",
      text: "Gracias por responder.",
      base_version: 0,
    });
    expect(reply.json.draft.variant_id).toBeNull();

    const exported = await call("GET", "/api/prospects/export");
    expect(exported.json.drafts.map((d: any) => [d.draft_id, d.variant_id])).toEqual([
      ["draft-1", "B"],
      ["draft-2", null],
    ]);
  });

  it("keeps variant ids canonical and short, and a changed one is a conflict", async () => {
    // The CLI upper-cases before pushing; the Worker keeps one cohort, not A and a.
    const created = await call("POST", "/api/prospects/drafts", { ...draft, variant_id: "a" });
    expect(created.status).toBe(201);
    expect(created.json.draft.variant_id).toBe("A");

    // The same draft_id with another variant is another draft, not a retry.
    expect(await call("POST", "/api/prospects/drafts", { ...draft, variant_id: "B" })).toEqual({
      status: 409,
      json: { error: "draft_conflict", detail: "draft_id: already stored with different content" },
    });

    for (const [variant_id, detail] of [
      ["A/B", "variant_id: must be 1-8 characters A-Z"],
      ["AAAAAAAAA", "variant_id: must be 1-8 characters A-Z"],
      [3, "variant_id: must be a string or null"],
    ] as const) {
      expect(
        await call("POST", "/api/prospects/drafts", {
          ...draft,
          draft_id: `draft-${variant_id}`,
          variant_id,
        }),
      ).toEqual({ status: 400, json: { error: "invalid_field", detail } });
    }
    expect(await draftCount()).toBe(1);
  });
});

describe("GET /api/prospects/work", () => {
  it("returns enrolled threads whose latest message is the lead's, oldest first", async () => {
    const now = Date.now();
    await enroll({ leadId: "lead-old", peerId: "peer-old", m1: "Hola, soy Víctor.", at: now - 3 * HOUR });
    await deliver(
      inbound({ peerId: "peer-old", text: "Hola, me interesa", mid: "mid_in_old", at: now - 2 * HOUR }),
    );
    await enroll({
      leadId: "lead-new",
      peerId: "peer-new",
      m1: "Hola, soy Víctor.",
      at: now - 3 * HOUR,
    });
    await deliver(
      inbound({ peerId: "peer-new", text: "¿Cómo funciona?", mid: "mid_in_new", at: now - HOUR }),
    );
    // A thread we already answered has nothing to do.
    await enroll({
      leadId: "lead-answered",
      peerId: "peer-answered",
      m1: "Hola, soy Víctor.",
      at: now - 3 * HOUR,
    });
    await deliver(
      inbound({
        peerId: "peer-answered",
        text: "Cuéntame",
        mid: "mid_in_answered",
        at: now - 2 * HOUR,
      }),
    );
    await recordOutbound("lead-answered", "mid_out_answered", "Te cuento", now - HOUR);

    // A lead who never answered the M1 is not work: there is nothing to reply to.
    await call("POST", "/api/prospects/threads", { lead_id: "lead-pending", handle: "lead.pending" });

    const r = await call("GET", "/api/prospects/work");
    expect(r.status).toBe(200);
    expect(r.json.work.map((w: any) => w.lead_id)).toEqual(["lead-old", "lead-new"]);

    const [old, fresh] = r.json.work;
    expect(old).toMatchObject({
      handle: handleFor("lead-old"),
      ig_user_id: IG_USER_ID,
      version: 2,
      inbound: { mid: "mid_in_old", text: "Hola, me interesa", sent_at: now - 2 * HOUR },
    });
    expect(old.inbound.age_seconds).toBeGreaterThanOrEqual(7200);
    expect(old.inbound.age_seconds).toBeLessThan(7200 + 60);
    expect(old.messages.map((m: any) => [m.mid, m.direction])).toEqual([
      ["mid_echo_lead-old", "out"],
      ["mid_in_old", "in"],
    ]);
    expect(fresh.inbound.age_seconds).toBeGreaterThanOrEqual(3600);
    expect(fresh.inbound.age_seconds).toBeLessThan(3600 + 60);
  });

  it("never returns a thread that already has a draft for its current version", async () => {
    const now = Date.now();
    for (const leadId of ["lead-a", "lead-b"]) {
      await enroll({
        leadId,
        peerId: `peer-${leadId}`,
        m1: "Hola, soy Víctor.",
        at: now - 3 * HOUR,
      });
      await deliver(
        inbound({
          peerId: `peer-${leadId}`,
          text: "Cuéntame",
          mid: `mid_in_${leadId}`,
          at: now - HOUR,
        }),
      );
    }
    const version = await threadVersion("lead-a");
    expect(version).toBe(2);

    // Drafted against the conversation as it stands now: the CLI has done this one.
    await call("POST", "/api/prospects/drafts", {
      draft_id: "draft-a",
      lead_id: "lead-a",
      kind: "reply",
      stage: "Filtro",
      text: "Gracias por responder.",
      base_version: version,
    });
    // Drafted against an older version: a message arrived since, so it is stale.
    await call("POST", "/api/prospects/drafts", {
      draft_id: "draft-b",
      lead_id: "lead-b",
      kind: "reply",
      stage: "Filtro",
      text: "Gracias por responder.",
      base_version: version - 1,
    });

    const r = await call("GET", "/api/prospects/work");
    expect(r.json.work.map((w: any) => w.lead_id)).toEqual(["lead-b"]);
  });

  it("rejects a limit that is not a positive integer", async () => {
    expect(await call("GET", "/api/prospects/work?limit=0")).toEqual({
      status: 400,
      json: { error: "invalid_field", detail: "limit: must be an integer from 1 to 100" },
    });
  });
});

describe("POST /api/prospects/authorizations", () => {
  it("stores the autopilot authorization for a draft", async () => {
    await call("POST", "/api/prospects/threads", { lead_id: "lead-1", handle: "ana.leads" });
    await call("POST", "/api/prospects/drafts", {
      draft_id: "draft-1",
      lead_id: "lead-1",
      kind: "reply",
      stage: "Filtro",
      text: "Gracias por responder.",
      base_version: 0,
    });
    const expiresAt = Date.now() + HOUR;

    const r = await call("POST", "/api/prospects/authorizations", {
      draft_id: "draft-1",
      category: "copro_filter",
      gate_reason: "",
      expires_at: expiresAt,
    });
    expect(r.status).toBe(201);
    expect(r.json.authorization).toMatchObject({
      draft_id: "draft-1",
      category: "copro_filter",
      gate_reason: "",
      expires_at: expiresAt,
    });
    expect(r.json.authorization.created_at).toBeGreaterThan(0);
  });

  it("answers 404 for an unknown draft and 400 for an expiry that is not a future timestamp", async () => {
    expect(
      (
        await call("POST", "/api/prospects/authorizations", {
          draft_id: "nope",
          category: "copro_filter",
          expires_at: Date.now() + HOUR,
        })
      ).status,
    ).toBe(404);

    await call("POST", "/api/prospects/threads", { lead_id: "lead-1", handle: "ana.leads" });
    await call("POST", "/api/prospects/drafts", {
      draft_id: "draft-1",
      lead_id: "lead-1",
      kind: "reply",
      text: "Gracias.",
      base_version: 0,
    });
    expect(
      await call("POST", "/api/prospects/authorizations", {
        draft_id: "draft-1",
        category: "copro_filter",
        expires_at: "soon",
      }),
    ).toEqual({
      status: 400,
      json: { error: "invalid_field", detail: "expires_at: must be an integer >= 0" },
    });
  });

  /** A registered thread with one waiting reply draft, ready to be authorized. */
  async function authorizableDraft(): Promise<void> {
    await call("POST", "/api/prospects/threads", { lead_id: "lead-1", handle: "ana.leads" });
    await call("POST", "/api/prospects/drafts", {
      draft_id: "draft-1",
      lead_id: "lead-1",
      kind: "reply",
      stage: "Filtro",
      text: "Gracias por responder.",
      base_version: 0,
    });
  }

  it("upserts on (draft_id, category): a repeated pass rewrites one row and keeps its age", async () => {
    await authorizableDraft();
    const now = Date.now();
    const authorize = (over: Record<string, unknown> = {}) =>
      call("POST", "/api/prospects/authorizations", {
        draft_id: "draft-1",
        category: "copro_filter",
        gate_reason: "",
        expires_at: now + HOUR,
        ...over,
      });

    const first = await authorize();
    expect(first.status).toBe(201);
    expect(first.json.created).toBe(true);

    // The cron's human delay runs from the moment autonomy was granted, so age
    // the row the way an earlier pass would have left it.
    const grantedAt = now - HOUR;
    await env.DB.prepare(`UPDATE prospect_authorizations SET created_at = ?`)
      .bind(grantedAt)
      .run();

    const later = now + 3 * HOUR;
    const again = await authorize({ expires_at: later });
    expect(again.status).toBe(200);
    expect(again.json.created).toBe(false);
    expect(again.json.authorization).toMatchObject({
      draft_id: "draft-1",
      category: "copro_filter",
      gate_reason: "",
      expires_at: later,
      // Not restamped: re-recording the grant on every pass would push the send
      // another few minutes away each time, and the autopilot would never send.
      created_at: grantedAt,
    });

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM prospect_authorizations WHERE draft_id = ?`,
    )
      .bind("draft-1")
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);

    const exported = await call("GET", "/api/prospects/export");
    expect(exported.json.authorizations).toEqual([
      {
        draft_id: "draft-1",
        category: "copro_filter",
        gate_reason: "",
        expires_at: later,
        created_at: grantedAt,
      },
    ]);
  });

  it("keeps one row per category, exports only current rows, and lets a refusal replace the grant", async () => {
    await authorizableDraft();
    const now = Date.now();
    const authorize = (over: Record<string, unknown> = {}) =>
      call("POST", "/api/prospects/authorizations", {
        draft_id: "draft-1",
        category: "copro_filter",
        gate_reason: "",
        expires_at: now + HOUR,
        ...over,
      });

    expect((await authorize()).status).toBe(201);
    expect((await authorize({ category: "copro_m2", expires_at: now + 2 * HOUR })).status).toBe(201);

    // The gate now refuses this draft. The row is rewritten rather than added,
    // so the Worker still reads one answer per category — and an empty gate
    // reason is the only one that is permission.
    expect((await authorize({ gate_reason: "copro_template_mismatch" })).status).toBe(200);

    const exported = await call("GET", "/api/prospects/export");
    expect(exported.json.authorizations).toEqual([
      expect.objectContaining({
        draft_id: "draft-1",
        category: "copro_filter",
        gate_reason: "copro_template_mismatch",
        expires_at: now + HOUR,
      }),
      expect.objectContaining({
        draft_id: "draft-1",
        category: "copro_m2",
        gate_reason: "",
        expires_at: now + 2 * HOUR,
      }),
    ]);

    // An expired row is history, not permission, so it is not part of the export.
    await env.DB.prepare(
      `UPDATE prospect_authorizations SET expires_at = ? WHERE category = 'copro_m2'`,
    )
      .bind(now - 1000)
      .run();
    expect(
      (await call("GET", "/api/prospects/export")).json.authorizations.map(
        (a: any) => a.category,
      ),
    ).toEqual(["copro_filter"]);
  });
});

describe("GET /api/prospects/export", () => {
  it("exports threads, message metadata and drafts, and never conversation text", async () => {
    const now = Date.now();
    await call("POST", "/api/prospects/threads", {
      lead_id: "lead-pending",
      handle: "lead.pending",
      name: "Bea",
      nicho: "viajes",
    });
    await enroll({ leadId: "lead-1", peerId: "peer-1", m1: "Hola, soy Víctor.", at: now - HOUR });
    await deliver(
      inbound({ peerId: "peer-1", text: "Cuéntame más", mid: "mid_in_1", at: now - 60_000 }),
    );
    await call("POST", "/api/prospects/drafts", {
      draft_id: "draft-1",
      lead_id: "lead-1",
      kind: "reply",
      stage: "Filtro",
      text: "Gracias por responder.",
      base_version: 2,
    });

    const r = await call("GET", "/api/prospects/export");
    expect(r.status).toBe(200);
    // Oldest touch first, so an incremental sync keeps a stable order.
    expect(r.json.threads.map((t: any) => [t.lead_id, t.state])).toEqual([
      ["lead-pending", "m1_pendiente"],
      ["lead-1", "enrolled"],
    ]);
    expect(r.json.threads[0]).not.toHaveProperty("igsid");
    expect(r.json.messages).toHaveLength(2);
    expect(r.json.messages[0]).toMatchObject({
      lead_id: "lead-1",
      direction: "out",
      origin: "echo_m1",
    });
    // The Sheet needs activity, not what anyone said.
    expect(r.json.messages[0]).not.toHaveProperty("text");
    for (const message of r.json.messages) expect(message).not.toHaveProperty("text");
    expect(r.json.drafts).toEqual([
      expect.objectContaining({
        draft_id: "draft-1",
        lead_id: "lead-1",
        kind: "reply",
        stage: "Filtro",
        status: "waiting",
        base_version: 2,
      }),
    ]);

    const since = await call("GET", `/api/prospects/export?since=${now + HOUR}`);
    expect(since.json).toEqual({ threads: [], messages: [], drafts: [], authorizations: [] });
  });

  it("rejects a since that is not an epoch-millisecond integer", async () => {
    expect(await call("GET", "/api/prospects/export?since=yesterday")).toEqual({
      status: 400,
      json: { error: "invalid_field", detail: "since: must be an epoch-millisecond integer" },
    });
  });
});
