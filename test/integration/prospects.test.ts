import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../../src/db";
import worker from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

const ACCOUNT_B = "17841400000000002";
const PEER = "3001881596673527";
const STORY = "17948132847250967";
const ECHO_AT = 1753300000123;

const normalize = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();

async function textSha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalize(text)),
  );
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

async function post(payload: unknown): Promise<Response> {
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
  // The handler answers Meta immediately and finishes prospect writes in waitUntil.
  await waitOnExecutionContext(ctx);
  return response;
}

function echo(over: {
  text: string;
  mid?: string;
  igUserId?: string;
  peerId?: string;
  echoOn?: "item" | "message";
}) {
  const igUserId = over.igUserId ?? IG_USER_ID;
  return {
    object: "instagram",
    entry: [
      {
        id: igUserId,
        time: ECHO_AT,
        messaging: [
          {
            sender: { id: igUserId },
            recipient: { id: over.peerId ?? PEER },
            timestamp: ECHO_AT,
            ...(over.echoOn === "message" ? {} : { is_echo: true }),
            message: {
              mid: over.mid ?? "mid_echo",
              text: over.text,
              ...(over.echoOn === "message" ? { is_echo: true } : {}),
            },
          },
        ],
      },
    ],
  };
}

function inbound(over: {
  text: string;
  mid?: string;
  igUserId?: string;
  peerId?: string;
  timestamp?: number;
}) {
  const igUserId = over.igUserId ?? IG_USER_ID;
  const timestamp = over.timestamp ?? 1753300000456;
  return {
    object: "instagram",
    entry: [
      {
        id: igUserId,
        time: timestamp,
        messaging: [
          {
            sender: { id: over.peerId ?? PEER },
            recipient: { id: igUserId },
            timestamp,
            message: { mid: over.mid ?? "mid_inbound", text: over.text },
          },
        ],
      },
    ],
  };
}

function storyReply(over: { text: string; mid?: string; peerId?: string }) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_USER_ID,
        time: 1753300000789,
        messaging: [
          {
            sender: { id: over.peerId ?? PEER },
            recipient: { id: IG_USER_ID },
            timestamp: 1753300000789,
            message: {
              mid: over.mid ?? "mid_story",
              text: over.text,
              reply_to: { story: { id: STORY } },
            },
          },
        ],
      },
    ],
  };
}

interface ThreadSeed {
  leadId?: string;
  igUserId?: string;
  igsid?: string | null;
  handle?: string;
  state?: "m1_pendiente" | "enrolled";
  m1?: string;
  version?: number;
}

async function seedThread(over: ThreadSeed = {}) {
  const leadId = over.leadId ?? "lead-1";
  const state = over.state ?? "m1_pendiente";
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO prospect_threads
       (lead_id, ig_user_id, igsid, handle, name, nicho, state, m1_sha,
        m1_registered_at, version, last_inbound_at, last_outbound_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(
      leadId,
      over.igUserId ?? IG_USER_ID,
      over.igsid ?? null,
      over.handle ?? "lead.handle",
      state,
      await textSha(over.m1 ?? "Hola, soy Víctor."),
      state === "m1_pendiente" ? now : null,
      over.version ?? (state === "enrolled" ? 1 : 0),
      state === "enrolled" ? now : null,
      now,
      now,
    )
    .run();
}

interface ThreadRow {
  leadId: string;
  igsid: string | null;
  state: string;
  version: number;
  lastInboundAt: number | null;
}

async function thread(leadId: string): Promise<ThreadRow> {
  const row = await env.DB.prepare(
    `SELECT lead_id AS leadId, igsid, state, version,
            last_inbound_at AS lastInboundAt
     FROM prospect_threads WHERE lead_id = ?`,
  )
    .bind(leadId)
    .first<ThreadRow>();
  if (!row) throw new Error(`thread ${leadId} not found`);
  return row;
}

interface MessageRow {
  mid: string;
  leadId: string;
  direction: string;
  origin: string;
  text: string;
  sentAt: number;
}

async function messages(): Promise<MessageRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT mid, lead_id AS leadId, direction, origin, text, sent_at AS sentAt
     FROM prospect_messages ORDER BY sent_at, mid`,
  ).all<MessageRow>();
  return results;
}

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

function expectNoSecrets(lines: string[], secrets: string[]) {
  const joined = lines.join("\n");
  for (const secret of secrets) expect(joined).not.toContain(secret);
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM prospect_authorizations`).run();
  await env.DB.prepare(`DELETE FROM prospect_drafts`).run();
  await env.DB.prepare(`DELETE FROM prospect_messages`).run();
  await env.DB.prepare(`DELETE FROM prospect_threads`).run();

  for (const igUserId of [IG_USER_ID, ACCOUNT_B]) {
    await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
      igUserId,
      username: igUserId === IG_USER_ID ? "victoralcazar" : "digitalriders_",
      accessToken: "IGAA-fixture-token",
      expiresIn: 60 * 24 * 60 * 60,
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("M1 echo enrollment", () => {
  /**
   * The echo is the only automatic enrollment. Whitespace and Unicode
   * composition may differ from what the operator copied; nothing else may.
   */
  it("enrolls the one pending thread whose normalized M1 matches the echo", async () => {
    const m1 = "Hola,   soy Vi\u0301ctor.\nVi que llevas una agencia.";
    await seedThread({ m1 });

    const delivered = "  Hola, soy V\u00edctor. Vi que llevas una agencia.  ";
    await post(echo({ text: delivered, mid: "mid_echo_1", echoOn: "message" }));

    expect(await thread("lead-1")).toMatchObject({
      igsid: PEER,
      state: "enrolled",
      version: 1,
    });
    expect(await messages()).toEqual([
      {
        mid: "mid_echo_1",
        leadId: "lead-1",
        direction: "out",
        origin: "echo_m1",
        text: delivered,
        sentAt: ECHO_AT,
      },
    ]);
  });

  it("writes nothing and logs no content when the echo matches no pending M1", async () => {
    await seedThread({
      leadId: "lead-secret",
      handle: "secret.handle",
      m1: "Hola, soy Víctor. Vi tu perfil.",
    });
    const lines = captureLogs();

    const privateText = "Mensaje privado que no coincide";
    const mid = "mid_private_echo";
    await post(echo({ text: privateText, mid, peerId: "friend-igsid" }));

    expect(await thread("lead-secret")).toMatchObject({
      igsid: null,
      state: "m1_pendiente",
      version: 0,
    });
    expect(await messages()).toEqual([]);
    expect(lines).toContain("prospect echo: unmatched");
    expectNoSecrets(lines, [privateText, mid, "friend-igsid", "lead-secret", "secret.handle"]);
  });

  /**
   * Same normalized text on two leads is not evidence of which one received the
   * M1. Neither is enrolled, and neither is guessed at.
   */
  it("enrolls neither thread and writes nothing when two pending M1s share the text", async () => {
    const m1 = "Hola, soy Víctor. ¿Cómo lo lleváis?";
    await seedThread({ leadId: "lead-a", handle: "a.handle", m1 });
    await seedThread({ leadId: "lead-b", handle: "b.handle", m1 });
    const lines = captureLogs();

    const mid = "mid_ambiguous_echo";
    await post(echo({ text: m1, mid }));

    for (const leadId of ["lead-a", "lead-b"]) {
      expect(await thread(leadId)).toMatchObject({
        igsid: null,
        state: "m1_pendiente",
        version: 0,
      });
    }
    expect(await messages()).toEqual([]);
    expect(lines).toContain("prospect echo: ambiguous pending=2");
    expectNoSecrets(lines, [m1, mid, "lead-a", "lead-b", "a.handle", "b.handle"]);
  });
});

describe("inbound prospect messages", () => {
  it("stores an inbound message once per mid for an enrolled peer", async () => {
    await seedThread({ state: "enrolled", igsid: PEER, version: 1 });
    const at = 1753300000456;

    await post(inbound({ text: "Hola, me interesa", mid: "mid_in_1", timestamp: at }));
    await post(inbound({ text: "Hola, me interesa", mid: "mid_in_1", timestamp: at }));

    expect(await thread("lead-1")).toMatchObject({
      igsid: PEER,
      state: "enrolled",
      version: 2,
      lastInboundAt: at,
    });
    expect(await messages()).toEqual([
      {
        mid: "mid_in_1",
        leadId: "lead-1",
        direction: "in",
        origin: "webhook",
        text: "Hola, me interesa",
        sentAt: at,
      },
    ]);
  });

  /**
   * Everything that is not a registered lead — friends, family, a lead who wrote
   * first — is dropped in memory. Comparing the sender id is the whole check:
   * no row, no log carrying text or ids, and no profile lookup.
   */
  it("drops an inbound from a peer that is not enrolled, without a row or a log", async () => {
    await seedThread({ state: "enrolled", igsid: "other-peer", version: 1, leadId: "other" });
    await seedThread({ leadId: "lead-pending" });
    const lines = captureLogs();

    const text = "Mensaje de un amigo";
    const mid = "mid_unknown";
    const peer = "friend-igsid";
    await post(inbound({ peerId: peer, text, mid }));

    expect(await thread("lead-pending")).toMatchObject({
      igsid: null,
      state: "m1_pendiente",
      version: 0,
    });
    expect(await thread("other")).toMatchObject({ igsid: "other-peer", version: 1 });
    expect(await messages()).toEqual([]);
    expect(lines.some((line) => line.includes("prospect"))).toBe(false);
    expectNoSecrets(lines, [text, mid, peer, "lead-pending"]);
  });

  /**
   * Two connected accounts each receive the same person from their own side.
   * A peer enrolled on one account must not capture the other's webhook.
   */
  it("keys threads by the account id as well as the peer id", async () => {
    await seedThread({ state: "enrolled", igsid: PEER, version: 1 });
    await seedThread({ leadId: "lead-pending", igUserId: IG_USER_ID, m1: "Hola, soy Víctor." });

    await post(
      inbound({
        igUserId: ACCOUNT_B,
        peerId: PEER,
        text: "Hola desde la otra cuenta",
        mid: "mid_other_account",
      }),
    );
    await post(
      echo({
        igUserId: ACCOUNT_B,
        peerId: PEER,
        text: "Hola, soy Víctor.",
        mid: "mid_echo_other_account",
      }),
    );

    expect(await thread("lead-1")).toMatchObject({ igsid: PEER, version: 1 });
    expect(await thread("lead-pending")).toMatchObject({
      igsid: null,
      state: "m1_pendiente",
      version: 0,
    });
    expect(await messages()).toEqual([]);
  });

  /**
   * A story reply is already answered by its own path. It is not an ordinary DM,
   * and it must never be stored as one or enroll a thread by resemblance.
   */
  it("never lets a story reply enter prospect storage", async () => {
    await seedThread({ state: "enrolled", igsid: PEER, version: 1 });

    await post(storyReply({ text: "respondo a tu historia", mid: "mid_story" }));

    expect(await thread("lead-1")).toMatchObject({ igsid: PEER, version: 1 });
    expect(await messages()).toEqual([]);
  });
});
