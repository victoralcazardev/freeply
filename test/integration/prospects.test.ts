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
  name?: string | null;
  state?: "m1_pendiente" | "enrolled";
  m1?: string;
  /** `null` seeds an armed thread that predates the copied text (JD-B-002). */
  m1CopiedText?: string | null;
  version?: number;
}

const DEFAULT_M1 = "Hola, soy Víctor.";

async function threadStatement(over: ThreadSeed) {
  const state = over.state ?? "m1_pendiente";
  const now = Date.now();
  const m1 = over.m1 ?? DEFAULT_M1;
  return env.DB.prepare(
    `INSERT INTO prospect_threads
       (lead_id, ig_user_id, igsid, handle, name, nicho, state, m1_sha,
        m1_copied_text, m1_registered_at, version, last_inbound_at,
        last_outbound_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).bind(
    over.leadId ?? "lead-1",
    over.igUserId ?? IG_USER_ID,
    over.igsid ?? null,
    over.handle ?? "lead.handle",
    over.name ?? null,
    state,
    await textSha(m1),
    over.m1CopiedText === undefined ? m1 : over.m1CopiedText,
    state === "m1_pendiente" ? now : null,
    over.version ?? (state === "enrolled" ? 1 : 0),
    state === "enrolled" ? now : null,
    now,
    now,
  );
}

async function seedThread(over: ThreadSeed = {}) {
  await (await threadStatement(over)).run();
}

/**
 * Seeds many threads in a few round trips: the work-bound tests need hundreds
 * of rows, and one await each would cost more than the assertion.
 */
async function seedThreads(seeds: ThreadSeed[]) {
  const statements = await Promise.all(seeds.map(threadStatement));
  for (let i = 0; i < statements.length; i += 100) {
    await env.DB.batch(statements.slice(i, i + 100));
  }
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

  /**
   * The M1 is copied and sent with line breaks now, and the echo may keep them
   * or have them collapsed to spaces. Normalization is the same on both sides,
   * so either form enrolls; nothing about the line breaks changes identity.
   */
  it("enrolls when the echo keeps the M1's line breaks, and when it collapses them", async () => {
    const m1 = "Hola, soy Víctor.\nVi que llevas una agencia.\n¿Te encaja?";

    await seedThread({ leadId: "lead-lines", handle: "lines.handle", m1 });
    await post(echo({ text: m1, mid: "mid_echo_lines", peerId: "peer-lines" }));
    expect(await thread("lead-lines")).toMatchObject({
      igsid: "peer-lines",
      state: "enrolled",
      version: 1,
    });

    await seedThread({ leadId: "lead-spaces", handle: "spaces.handle", m1 });
    await post(
      echo({
        text: m1.replace(/\n/g, " "),
        mid: "mid_echo_spaces",
        peerId: "peer-spaces",
      }),
    );
    expect(await thread("lead-spaces")).toMatchObject({
      igsid: "peer-spaces",
      state: "enrolled",
      version: 1,
    });
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
   * M1. Neither is enrolled, neither is guessed at, and both land in the queue
   * that asks a person to retry with a text only one of them will receive (T6).
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
        state: "m1_sin_confirmar",
        version: 0,
      });
    }
    expect(await messages()).toEqual([]);
    expect(lines).toContain("prospect echo: ambiguous pending=2");
    expectNoSecrets(lines, [m1, mid, "lead-a", "lead-b", "a.handle", "b.handle"]);
  });

  /**
   * The operator retouches the M1 on the phone before sending it: drops the
   * opening «¡» and swaps a word. The exact hash no longer sees it, but the
   * copied text is close enough to name the one thread it belongs to.
   */
  it("enrolls the right thread when the echo only resembles the copied M1", async () => {
    const m1 =
      "¡Hola, Marta! Soy Víctor. Vi que llevas una agencia de marketing y quería saber si te encaja una llamada.";
    const sent =
      "Hola, Marta! Soy Víctor. Vi que llevas una agencia de publicidad y quería saber si te encaja una llamada.";
    await seedThread({ leadId: "lead-target", handle: "target.handle", name: "Marta", m1 });
    await seedThread({
      leadId: "lead-other",
      handle: "other.handle",
      name: "Marta Sánchez",
      m1: "Hola, Marta. Soy Víctor. Vi tu perfil y me gustó tu contenido.",
    });
    const lines = captureLogs();

    const mid = "mid_retouched";
    const peer = "peer-retouched";
    await post(echo({ text: sent, mid, peerId: peer }));

    expect(await thread("lead-target")).toMatchObject({
      igsid: peer,
      state: "enrolled",
      version: 1,
    });
    expect(await thread("lead-other")).toMatchObject({
      igsid: null,
      state: "m1_pendiente",
      version: 0,
    });
    expect(await messages()).toEqual([
      {
        mid,
        leadId: "lead-target",
        direction: "out",
        origin: "echo_m1",
        text: sent,
        sentAt: ECHO_AT,
      },
    ]);
    expect(lines).toContain("prospect echo: enrolled");
    expectNoSecrets(lines, [
      m1,
      sent,
      mid,
      peer,
      "lead-target",
      "target.handle",
      "lead-other",
      "other.handle",
    ]);
  });

  /**
   * The exact hash keeps priority. A pending thread with a similar text is not
   * consulted while one thread matches exactly, and stays untouched.
   */
  it("keeps the exact match ahead of a close pending M1", async () => {
    const exact = "Hola, soy Víctor. Vi que llevas una agencia de marketing.";
    const near = "Hola, soy Víctor. Vi que llevas una agencia de publicidad.";
    await seedThread({ leadId: "lead-exact", handle: "exact.handle", m1: exact });
    await seedThread({ leadId: "lead-near", handle: "near.handle", m1: near });

    const mid = "mid_exact";
    await post(echo({ text: exact, mid, peerId: "peer-exact" }));

    expect(await thread("lead-exact")).toMatchObject({
      igsid: "peer-exact",
      state: "enrolled",
      version: 1,
    });
    expect(await thread("lead-near")).toMatchObject({
      igsid: null,
      state: "m1_pendiente",
      version: 0,
    });
    expect((await messages()).map((m) => m.mid)).toEqual([mid]);
  });

  /**
   * Two copied M1s can both be close to the echo. Close is not evidence of
   * which lead received it, so neither enrolls, neither is marked, and the log
   * stays the content-free unmatched line.
   */
  it("enrolls neither and marks nothing when two pending M1s are both close", async () => {
    const m1a =
      "¡Hola, Marta! Soy Víctor. Vi que llevas una agencia de marketing y quería saber si te encaja una llamada.";
    const m1b =
      "¡Hola, Marta! Soy Víctor. Vi que llevas una agencia de publicidad y quería saber si te encaja una llamada.";
    const sent =
      "Hola, Marta! Soy Víctor. Vi que llevas una agencia de diseño y quería saber si te encaja una llamada.";
    await seedThread({ leadId: "lead-a", handle: "a.handle", name: "Marta", m1: m1a });
    await seedThread({ leadId: "lead-b", handle: "b.handle", name: "Marta", m1: m1b });
    const lines = captureLogs();

    const mid = "mid_two_close";
    await post(echo({ text: sent, mid, peerId: "peer-two-close" }));

    for (const leadId of ["lead-a", "lead-b"]) {
      expect(await thread(leadId)).toMatchObject({
        igsid: null,
        state: "m1_pendiente",
        version: 0,
      });
    }
    expect(await messages()).toEqual([]);
    expect(lines).toContain("prospect echo: unmatched");
    expect(lines.some((line) => line.includes("ambiguous"))).toBe(false);
    expectNoSecrets(lines, [m1a, m1b, sent, mid, "lead-a", "lead-b", "a.handle", "b.handle"]);
  });

  /**
   * The similarity floor is inclusive: one changed word in five sits exactly on
   * 0.8 and enrolls, while the same change in four (0.75) does not.
   */
  it("enrolls at the similarity floor and refuses just below it", async () => {
    await seedThread({
      leadId: "lead-floor",
      handle: "floor.handle",
      name: "Marta",
      m1: "Marta soy Víctor de Madrid",
    });

    await post(
      echo({
        text: "Marta soy Víctor de Barcelona",
        mid: "mid_floor",
        peerId: "peer-floor",
      }),
    );
    expect(await thread("lead-floor")).toMatchObject({
      igsid: "peer-floor",
      state: "enrolled",
      version: 1,
    });

    await seedThread({
      leadId: "lead-below",
      handle: "below.handle",
      name: "Marta",
      m1: "Marta soy Víctor Madrid",
    });
    const lines = captureLogs();
    await post(
      echo({
        text: "Marta soy Víctor Barcelona",
        mid: "mid_below",
        peerId: "peer-below",
      }),
    );

    expect(await thread("lead-below")).toMatchObject({
      igsid: null,
      state: "m1_pendiente",
      version: 0,
    });
    expect((await messages()).map((m) => m.mid)).toEqual(["mid_floor"]);
    expect(lines).toContain("prospect echo: unmatched");
  });

  /**
   * The operator writes to somebody who never came from /prospects, reusing the
   * M1 template with that person's name. With a single pending lead the
   * runner-up is 0, so the margin always passes and similarity alone would
   * enroll a lead who was never messaged. The name is the evidence that this
   * message was for somebody else.
   */
  it("enrolls nothing when the retouched M1 names somebody else", async () => {
    const m1 =
      "Hola Marta, soy Víctor. Vi que llevas una agencia de marketing y quería saber si te encaja una llamada.";
    const typed =
      "Hola Lucía, soy Víctor. Vi que llevas una agencia de marketing y quería saber si te encaja una llamada.";
    await seedThread({ leadId: "lead-marta", handle: "marta.handle", name: "Marta Ruiz", m1 });
    const lines = captureLogs();

    const mid = "mid_other_name";
    const peer = "peer-not-a-lead";
    await post(echo({ text: typed, mid, peerId: peer }));

    expect(await thread("lead-marta")).toMatchObject({
      igsid: null,
      state: "m1_pendiente",
      version: 0,
    });
    expect(await messages()).toEqual([]);
    expect(lines).toContain("prospect echo: unmatched");
    expectNoSecrets(lines, [m1, typed, mid, peer, "lead-marta", "marta.handle", "Marta", "Lucía"]);
  });

  /**
   * A title is part of how the name was stored, not part of how the person is
   * addressed: a lead saved as «Dra. Marta Ruiz» is named by an echo that only
   * says «Marta».
   */
  it("recognises a lead whose name is stored with a title", async () => {
    const m1 =
      "Hola Marta, soy Víctor. Vi que llevas una agencia de marketing y quería saber si te encaja una llamada.";
    const sent =
      "Hola Marta, soy Víctor. Vi que llevas una agencia de publicidad y quería saber si te encaja una llamada.";
    await seedThread({ leadId: "lead-title", name: "Dra. Marta Ruiz", m1 });

    await post(echo({ text: sent, mid: "mid_title", peerId: "peer-title" }));

    expect(await thread("lead-title")).toMatchObject({
      igsid: "peer-title",
      state: "enrolled",
      version: 1,
    });
  });

  /**
   * A lead nobody named cannot be named by any message, so the tolerant
   * fallback has no way to tell their M1 from a template that was sent to
   * somebody else. They stay out of the comparison instead.
   */
  it("leaves a lead with no stored name out of the tolerant fallback", async () => {
    const m1 =
      "Hola, soy Víctor. Vi que llevas una agencia de marketing y quería saber si te encaja una llamada.";
    const sent =
      "Hola, soy Víctor. Vi que llevas una agencia de publicidad y quería saber si te encaja una llamada.";
    await seedThread({ leadId: "lead-nameless", name: null, m1 });
    const lines = captureLogs();

    await post(echo({ text: sent, mid: "mid_nameless", peerId: "peer-nameless" }));

    expect(await thread("lead-nameless")).toMatchObject({
      igsid: null,
      state: "m1_pendiente",
      version: 0,
    });
    expect(await messages()).toEqual([]);
    expect(lines).toContain("prospect echo: unmatched");
  });

  /** A name of titles and particles names nobody either. */
  it("leaves a lead whose name is only a title out of the tolerant fallback", async () => {
    const m1 =
      "Hola, soy Víctor. Vi que llevas una agencia de marketing y quería saber si te encaja una llamada.";
    const sent =
      "Hola, soy Víctor. Vi que llevas una agencia de publicidad y quería saber si te encaja una llamada.";
    await seedThread({ leadId: "lead-title-only", name: "Dra.", m1 });

    await post(echo({ text: sent, mid: "mid_title_only", peerId: "peer-title-only" }));

    expect(await thread("lead-title-only")).toMatchObject({
      igsid: null,
      state: "m1_pendiente",
      version: 0,
    });
    expect(await messages()).toEqual([]);
  });

  /**
   * A thread armed before `m1_copied_text` existed has nothing to compare, so
   * it cannot be ruled out as the lead who received this echo. Enrolling
   * another one would be a guess about identity: the fallback refuses.
   */
  it("enrolls nothing when an armed pending thread has no copied text", async () => {
    const m1 =
      "Hola Marta, soy Víctor. Vi que llevas una agencia de marketing y quería saber si te encaja una llamada.";
    const sent =
      "Hola Marta, soy Víctor. Vi que llevas una agencia de publicidad y quería saber si te encaja una llamada.";
    await seedThread({ leadId: "lead-target", name: "Marta", m1 });
    await seedThread({
      leadId: "lead-armed",
      handle: "armed.handle",
      name: "Remedios",
      m1: "Hola Remedios, soy Víctor. Una cosa completamente distinta que no se parece a la de arriba.",
      m1CopiedText: null,
    });
    const lines = captureLogs();

    await post(echo({ text: sent, mid: "mid_armed", peerId: "peer-armed" }));

    expect(await thread("lead-target")).toMatchObject({
      igsid: null,
      state: "m1_pendiente",
      version: 0,
    });
    expect(await thread("lead-armed")).toMatchObject({ igsid: null, version: 0 });
    expect(await messages()).toEqual([]);
    expect(lines).toContain("prospect echo: unmatched");
  });

  /**
   * Only a lead whose name the echo says can be a candidate, so hundreds of
   * unrelated pending leads cost a name comparison each and never reach a
   * distance or the candidate cap. If they were compared, the cap would refuse
   * the echo and the one real match would be lost.
   */
  it("enrolls the one lead the echo names among five hundred pending leads", async () => {
    const echoWords = [
      "hola", "marta", "soy", "victor", "vi", "que", "llevas", "una", "agencia", "de", "publicidad",
    ];
    const echoText = echoWords.join(" ");
    const targetM1 = [...echoWords.slice(0, -1), "marketing"].join(" ");

    await seedThread({
      leadId: "lead-target",
      handle: "target.handle",
      name: "Marta",
      m1: targetM1,
    });
    await seedThreads(
      Array.from({ length: 500 }, (_, i) => ({
        leadId: `lead-bulk-${i}`,
        handle: `bulk${i}.handle`,
        name: `Persona${i} Apellido${i}`,
        m1: `Hola, soy Víctor. ${Array.from(
          { length: 30 },
          (_, k) => `palabra${i}x${k}`,
        ).join(" ")}`,
      })),
    );

    const pending = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM prospect_threads
       WHERE ig_user_id = ? AND state = 'm1_pendiente'`,
    )
      .bind(IG_USER_ID)
      .first<{ n: number }>();
    expect(pending?.n).toBe(501);

    const lines = captureLogs();
    await post(echo({ text: echoText, mid: "mid_many", peerId: "peer-many" }));

    expect(await thread("lead-target")).toMatchObject({
      igsid: "peer-many",
      state: "enrolled",
      version: 1,
    });
    expect(await messages()).toEqual([
      {
        mid: "mid_many",
        leadId: "lead-target",
        direction: "out",
        origin: "echo_m1",
        text: echoText,
        sentAt: ECHO_AT,
      },
    ]);
    expect(lines).toContain("prospect echo: enrolled");
  });

  /**
   * A copied text whose word count is more than 20% off cannot reach the
   * similarity floor — the distance is at least the length difference — so it
   * is dropped before any comparison, and before the cap counts it.
   */
  it("skips candidates whose copied text is far shorter than the echo", async () => {
    const echoText = "hola marta soy victor vi que llevas una agencia de publicidad";
    await seedThread({
      leadId: "lead-len-target",
      handle: "len-target.handle",
      name: "Marta",
      m1: "hola marta soy victor vi que llevas una agencia de marketing",
    });
    await seedThreads(
      Array.from({ length: 25 }, (_, i) => ({
        leadId: `lead-short-${i}`,
        handle: `short${i}.handle`,
        name: "Marta",
        m1: "Hola.",
      })),
    );

    await post(echo({ text: echoText, mid: "mid_short", peerId: "peer-short" }));

    expect(await thread("lead-len-target")).toMatchObject({
      igsid: "peer-short",
      state: "enrolled",
      version: 1,
    });
  });

  /**
   * Past twenty comparable leads, resembling the M1 stops being evidence: the
   * operator could have sent it to any of them. The fallback refuses rather
   * than spend the CPU on a guess.
   */
  it("enrolls nothing when more than twenty comparable leads are pending", async () => {
    const echoWords = [
      "hola", "marta", "soy", "victor", "vi", "que", "llevas", "una", "agencia", "de", "publicidad",
    ];
    const echoText = echoWords.join(" ");
    await seedThread({
      leadId: "lead-cap-target",
      name: "Marta",
      m1: [...echoWords.slice(0, -1), "marketing"].join(" "),
    });
    await seedThreads(
      Array.from({ length: 21 }, (_, i) => ({
        leadId: `lead-cap-${i}`,
        name: "Marta",
        m1: ["hola", "marta", "soy", ...Array.from({ length: 8 }, (_, k) => `z${i}x${k}`)].join(" "),
      })),
    );
    const lines = captureLogs();

    await post(echo({ text: echoText, mid: "mid_cap", peerId: "peer-cap" }));

    expect(await thread("lead-cap-target")).toMatchObject({
      igsid: null,
      state: "m1_pendiente",
      version: 0,
    });
    expect(await messages()).toEqual([]);
    expect(lines).toContain("prospect echo: unmatched");
  });

  /** The cap includes the twentieth: twenty comparable leads still get an answer. */
  it("enrolls the best of exactly twenty comparable leads", async () => {
    const echoWords = [
      "hola", "marta", "soy", "victor", "vi", "que", "llevas", "una", "agencia", "de", "publicidad",
    ];
    const echoText = echoWords.join(" ");
    await seedThread({
      leadId: "lead-twenty-target",
      name: "Marta",
      m1: [...echoWords.slice(0, -1), "marketing"].join(" "),
    });
    await seedThreads(
      Array.from({ length: 19 }, (_, i) => ({
        leadId: `lead-twenty-${i}`,
        name: "Marta",
        m1: ["hola", "marta", "soy", ...Array.from({ length: 8 }, (_, k) => `y${i}x${k}`)].join(" "),
      })),
    );

    await post(echo({ text: echoText, mid: "mid_twenty", peerId: "peer-twenty" }));

    expect(await thread("lead-twenty-target")).toMatchObject({
      igsid: "peer-twenty",
      state: "enrolled",
      version: 1,
    });
  });

  /**
   * An echo on an enrolled thread is the operator talking to that lead. It must
   * never fall through to the tolerant matcher, even when it resembles another
   * lead's copied M1.
   */
  it("keeps an enrolled echo on the owner path even when it resembles a pending M1", async () => {
    const pendingM1 = "Hola, soy Víctor. Vi que llevas una agencia de marketing.";
    const typed = "Hola, soy Víctor. Vi que llevas una agencia de publicidad.";
    await seedThread({
      leadId: "lead-enrolled",
      handle: "enrolled.handle",
      state: "enrolled",
      igsid: "peer-enrolled",
      version: 1,
      m1: "Hola, soy Víctor. Vi tus fotos.",
    });
    await seedThread({ leadId: "lead-pending", handle: "pending.handle", m1: pendingM1 });

    const mid = "mid_owner";
    await post(echo({ text: typed, mid, peerId: "peer-enrolled" }));

    expect(await thread("lead-pending")).toMatchObject({
      igsid: null,
      state: "m1_pendiente",
      version: 0,
    });
    expect(await messages()).toEqual([
      {
        mid,
        leadId: "lead-enrolled",
        direction: "out",
        origin: "owner",
        text: typed,
        sentAt: ECHO_AT,
      },
    ]);
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
