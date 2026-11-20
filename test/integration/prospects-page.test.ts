import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession, sessionCookie } from "../../src/auth";
import * as db from "../../src/db";
import worker from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/**
 * The mobile page: four queues over the threads the echo enrolled (S8, S11).
 *
 * Everything here goes through the public routes with a real session cookie, the
 * same way the operator's phone asks for the page. The four queues are asserted
 * through the section they render in, so a thread in the wrong queue fails even
 * if it still appears somewhere on the page.
 */

const TOKEN = "test-api-token";
const apiEnv = { ...env, API_TOKEN: TOKEN };

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/* --------------------------------------------------------------- fixtures */

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

const handleFor = (leadId: string) => leadId.replace(/[^a-z0-9._]/g, ".").slice(0, 30);

function normalize(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

async function textSha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalize(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------ page traffic */

function sessionCookieHeader(value = FIXTURE_SECRETS.DASHBOARD_PASSWORD): Promise<string> {
  return createSession(value).then((session) => sessionCookie(session).split(";")[0]);
}

async function getPage(
  path = "/prospects",
  opts: { cookie?: string | null } = {},
): Promise<{ status: number; html: string; location: string | null }> {
  const headers: Record<string, string> = {};
  const cookie = opts.cookie === undefined ? await sessionCookieHeader() : opts.cookie;
  if (cookie) headers.cookie = cookie;
  const request = new Request(`https://freeply.test${path}`, { headers });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return {
    status: response.status,
    html: await response.text(),
    location: response.headers.get("location"),
  };
}

async function postPage(
  path: string,
  fields: Record<string, string>,
  opts: { cookie?: string | null } = {},
): Promise<{ status: number; html: string; location: string | null }> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const headers: Record<string, string> = {};
  const cookie = opts.cookie === undefined ? await sessionCookieHeader() : opts.cookie;
  if (cookie) headers.cookie = cookie;
  const request = new Request(`https://freeply.test${path}`, { method: "POST", headers, body });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return {
    status: response.status,
    html: await response.text(),
    location: response.headers.get("location"),
  };
}

/** One queue's slice of the page, so "not in this queue" is a real assertion. */
function section(html: string, id: string): string {
  const start = html.indexOf(`<section id="${id}"`);
  expect(start, `section ${id} missing`).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  expect(end, `section ${id} not closed`).toBeGreaterThan(start);
  return html.slice(start, end);
}

/* ------------------------------------------------------------ arrangement */

interface Arrangement {
  leadId: string;
  peerId: string;
  m1: string;
}

/** A lead the team put in the Sheet, with the M1 drafted but not yet copied. */
async function pendingLead(o: {
  leadId: string;
  name?: string;
  nicho?: string;
  m1Draft?: string;
  version?: number;
}): Promise<void> {
  const created = await call("POST", "/api/prospects/threads", {
    lead_id: o.leadId,
    handle: handleFor(o.leadId),
    name: o.name ?? null,
    nicho: o.nicho ?? null,
  });
  expect(created.status).toBe(201);
  if (o.m1Draft !== undefined) {
    const draft = await call("POST", "/api/prospects/drafts", {
      draft_id: `m1_${o.leadId}`,
      lead_id: o.leadId,
      kind: "m1",
      stage: "M1",
      text: o.m1Draft,
      base_version: o.version ?? 0,
    });
    expect(draft.status).toBe(201);
  }
}

/** The full production path: Sheet row, M1 registered, echo arrives. */
async function enrolledLead(o: {
  leadId: string;
  peerId: string;
  m1: string;
  at: number;
  name?: string;
}): Promise<Arrangement> {
  await pendingLead({ leadId: o.leadId, name: o.name, m1Draft: o.m1 });
  const registered = await call("POST", "/api/prospects/expected-m1", {
    lead_id: o.leadId,
    text: o.m1,
  });
  expect(registered.status).toBe(200);
  await deliver(
    echo({ text: o.m1, peerId: o.peerId, mid: `mid_echo_${o.leadId}`, at: o.at }),
  );
  return { leadId: o.leadId, peerId: o.peerId, m1: o.m1 };
}

/** The lead writes back, which opens the 24 h window. */
async function leadsReplies(o: {
  thread: Arrangement;
  text: string;
  at: number;
}): Promise<void> {
  await deliver(
    inbound({
      peerId: o.thread.peerId,
      text: o.text,
      mid: `mid_in_${o.thread.leadId}_${o.at}`,
      at: o.at,
    }),
  );
}

async function threadRow(leadId: string) {
  const row = await env.DB.prepare(`SELECT * FROM prospect_threads WHERE lead_id = ?`)
    .bind(leadId)
    .first<{
      state: string;
      m1_sha: string | null;
      m1_registered_at: number | null;
      version: number;
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

async function pushDraft(o: {
  draftId: string;
  leadId: string;
  text: string;
  stage?: string;
}): Promise<void> {
  const version = (await threadRow(o.leadId)).version;
  const created = await call("POST", "/api/prospects/drafts", {
    draft_id: o.draftId,
    lead_id: o.leadId,
    kind: "reply",
    stage: o.stage ?? "Filtro",
    text: o.text,
    base_version: version,
  });
  expect(created.status).toBe(201);
}

const messageCount = async () =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM prospect_messages`).first<{ n: number }>())?.n ??
  0;

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM prospect_authorizations`).run();
  await env.DB.prepare(`DELETE FROM prospect_drafts`).run();
  await env.DB.prepare(`DELETE FROM prospect_messages`).run();
  await env.DB.prepare(`DELETE FROM prospect_threads`).run();
  await env.DB.prepare(`DELETE FROM sends`).run();
  await env.DB.prepare(`DELETE FROM accounts`).run();
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "victoralcazar",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });
});

describe("/prospects without a session", () => {
  it("redirects every route to the login page and writes nothing", async () => {
    await pendingLead({ leadId: "lead-1", m1Draft: "Hola, soy Víctor." });

    for (const [path, fields] of [
      ["/prospects", {}],
      ["/prospects/m1", { lead_id: "lead-1", text: "Hola, soy Víctor." }],
      ["/prospects/m1/retry", { lead_id: "lead-1" }],
      ["/prospects/drafts", { draft_id: "nope", action: "skip" }],
    ] as Array<[string, Record<string, string>]>) {
      const response =
        path === "/prospects" ? await getPage(path, { cookie: null }) : await postPage(path, fields, { cookie: null });
      expect(response.status).toBe(302);
      expect(response.location).toBe("/login");
    }

    const thread = await threadRow("lead-1");
    expect(thread.m1_sha).toBeNull();

    // A cookie signed with anything else is not a session either.
    const forged = await sessionCookieHeader("another-password");
    expect((await getPage("/prospects", { cookie: forged })).status).toBe(302);
  });
});

describe("GET /prospects", () => {
  it("renders the four queues and the editable M1 with the chat link", async () => {
    await pendingLead({ leadId: "lead-nuevo", name: "Ana", nicho: "viajes", m1Draft: "Hola, Ana." });
    const enrolled = await enrolledLead({
      leadId: "lead-activo",
      peerId: "peer-secret-123",
      m1: "Hola, soy Víctor.",
      at: Date.now() - 3 * HOUR,
      name: "Bea",
    });
    await leadsReplies({ thread: enrolled, text: "Cuéntame más", at: Date.now() - HOUR });
    await pushDraft({ draftId: "draft-1", leadId: "lead-activo", text: "Gracias por responder." });

    const { status, html } = await getPage("/prospects");
    expect(status).toBe(200);
    expect(html).toContain('lang="es"');

    const m1 = section(html, "m1-por-enviar");
    expect(m1).toContain("<h2>M1 por enviar");
    // Editable before copying, and prefilled with the draft the CLI pushed.
    expect(m1).toContain('name="text"');
    expect(m1).toContain(">Hola, Ana.</textarea>");
    expect(m1).toContain('action="/prospects/m1"');
    expect(m1).toContain(`https://ig.me/m/${handleFor("lead-nuevo")}`);
    expect(m1).toContain("Copiar");
    // An enrolled thread is not waiting to send its M1.
    expect(m1).not.toContain("lead-activo");

    expect(section(html, "m1-sin-confirmar")).toContain("<h2>M1 sin confirmar");

    const drafts = section(html, "borradores");
    expect(drafts).toContain("<h2>Borradores");
    expect(drafts).toContain(`@${handleFor("lead-activo")}`);
    expect(drafts).toContain(">Gracias por responder.</textarea>");
    expect(drafts).toContain("hace 1 h");
    expect(drafts).toContain('name="action" value="approve"');
    expect(drafts).toContain('name="action" value="skip"');

    expect(section(html, "manual")).toContain("<h2>Manual");

    // The peer id is how the webhook recognises a lead; it never reaches the page.
    expect(html).not.toContain("peer-secret-123");
  });

  it("escapes what the lead wrote and what the CLI drafted", async () => {
    const enrolled = await enrolledLead({
      leadId: "lead-x",
      peerId: "peer-x",
      m1: "Hola, soy Víctor.",
      at: Date.now() - 3 * HOUR,
    });
    await leadsReplies({
      thread: enrolled,
      text: `<img src=x onerror="alert(1)">`,
      at: Date.now() - HOUR,
    });
    await pushDraft({
      draftId: "draft-x",
      leadId: "lead-x",
      text: `</textarea><script>alert(2)</script>`,
    });

    const { html } = await getPage("/prospects");
    expect(html).not.toContain("<img src=x onerror=");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("</textarea><script>alert(2)</script>");
    expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  it("moves both threads to unconfirmed when one text was pending on two leads", async () => {
    const at = Date.now() - HOUR;
    for (const leadId of ["lead-a", "lead-b"]) {
      await pendingLead({ leadId, m1Draft: "Hola, soy Víctor." });
      const registered = await call("POST", "/api/prospects/expected-m1", {
        lead_id: leadId,
        text: "Hola, soy Víctor.",
      });
      expect(registered.status).toBe(200);
    }

    // The same copied text cannot say which of the two received it, so neither
    // enrolls — and both go to the queue that invites a retry.
    await deliver(
      echo({ text: "Hola, soy Víctor.", peerId: "peer-a", mid: "mid_echo_ambiguous", at }),
    );

    expect((await threadRow("lead-a")).state).toBe("m1_sin_confirmar");
    expect((await threadRow("lead-b")).state).toBe("m1_sin_confirmar");

    const { html } = await getPage("/prospects");
    const unconfirmed = section(html, "m1-sin-confirmar");
    expect(unconfirmed).toContain(`@${handleFor("lead-a")}`);
    expect(unconfirmed).toContain(`@${handleFor("lead-b")}`);
    expect(section(html, "m1-por-enviar")).not.toContain(`@${handleFor("lead-a")}`);
  });

  it("keeps a fresh registered M1 to send and moves an old one to unconfirmed", async () => {
    for (const leadId of ["lead-now", "lead-old"]) {
      await pendingLead({ leadId, m1Draft: "Hola, soy Víctor." });
      const registered = await call("POST", "/api/prospects/expected-m1", {
        lead_id: leadId,
        text: "Hola, soy Víctor.",
      });
      expect(registered.status).toBe(200);
    }
    // Copied two hours ago and no echo came back: nobody sent it, or the text
    // changed after copying. Either way it needs a person to look at it.
    const at = Date.now() - 2 * HOUR;
    await env.DB.prepare(
      `UPDATE prospect_threads SET m1_registered_at = ? WHERE lead_id = 'lead-old'`,
    )
      .bind(at)
      .run();

    const { html } = await getPage("/prospects");
    expect(section(html, "m1-por-enviar")).toContain(`@${handleFor("lead-now")}`);
    expect(section(html, "m1-por-enviar")).not.toContain(`@${handleFor("lead-old")}`);
    expect(section(html, "m1-sin-confirmar")).toContain(`@${handleFor("lead-old")}`);
    expect(section(html, "m1-sin-confirmar")).toContain("hace 2 h");
  });

  it("flags a draft whose window is nearly closed and drops the closed one into manual", async () => {
    const now = Date.now();
    const soon = await enrolledLead({
      leadId: "lead-soon",
      peerId: "peer-soon",
      m1: "Hola, soy Víctor.",
      at: now - 30 * HOUR,
    });
    await leadsReplies({ thread: soon, text: "Cuéntame más", at: now - 21 * HOUR });
    await pushDraft({ draftId: "draft-soon", leadId: "lead-soon", text: "Te cuento." });

    const closed = await enrolledLead({
      leadId: "lead-closed",
      peerId: "peer-closed",
      m1: "Hola, soy Víctor.",
      at: now - 40 * HOUR,
    });
    await leadsReplies({ thread: closed, text: "Cuéntame más", at: now - 25 * HOUR });
    await pushDraft({ draftId: "draft-closed", leadId: "lead-closed", text: "Perdona la tardanza." });

    const { html } = await getPage("/prospects");
    const drafts = section(html, "borradores");
    expect(drafts).toContain(`@${handleFor("lead-soon")}`);
    expect(drafts).toContain("hace 21 h");
    expect(drafts).toContain("Quedan 3 h");
    expect(drafts).toContain('class="tag warn"');
    expect(drafts).not.toContain(`@${handleFor("lead-closed")}`);

    const manual = section(html, "manual");
    expect(manual).toContain(`@${handleFor("lead-closed")}`);
    expect(manual).toContain("Fuera de ventana");
    expect(manual).toContain("Perdona la tardanza.");
    expect(manual).toContain(`https://ig.me/m/${handleFor("lead-closed")}`);
    expect(manual).not.toContain(`@${handleFor("lead-soon")}`);
  });

  it("asks whether an unknown send went out, with the two buttons that settle it", async () => {
    const now = Date.now();
    const enrolled = await enrolledLead({
      leadId: "lead-unknown",
      peerId: "peer-unknown",
      m1: "Hola, soy Víctor.",
      at: now - 3 * HOUR,
    });
    await leadsReplies({ thread: enrolled, text: "Cuéntame más", at: now - 2 * HOUR });
    await pushDraft({ draftId: "draft-unknown", leadId: "lead-unknown", text: "Te cuento." });
    await env.DB.prepare(`UPDATE prospect_drafts SET status = 'send_state_unknown' WHERE draft_id = ?`)
      .bind("draft-unknown")
      .run();

    const { html } = await getPage("/prospects");
    expect(section(html, "borradores")).not.toContain(`@${handleFor("lead-unknown")}`);

    const manual = section(html, "manual");
    expect(manual).toContain(`@${handleFor("lead-unknown")}`);
    expect(manual).toContain("Salida sin confirmar");
    expect(manual).toContain('name="action" value="sent">Salió<');
    expect(manual).toContain('name="action" value="not_sent">No salió<');
  });

  it("still renders the dashboard with the new entry in its nav", async () => {
    const dashboard = await getPage("/");
    expect(dashboard.status).toBe(200);
    for (const tab of ["overview", "campaigns", "links", "settings"]) {
      expect(dashboard.html).toContain(`/?tab=${tab}`);
    }
    expect(dashboard.html).toContain('href="/prospects"');

    const prospects = await getPage("/prospects");
    expect(prospects.html).toContain('<a href="/prospects" class="on">');
  });
});

describe("POST /prospects/m1", () => {
  it("registers the edited text and copies exactly that text", async () => {
    await pendingLead({ leadId: "lead-1", m1Draft: "Hola, Ana. Soy Víctor." });
    const edited = "Hola, Ana. Soy Víctor, de Madrid.";

    const response = await postPage("/prospects/m1", { lead_id: "lead-1", text: edited });
    expect(response.status).toBe(200);

    // The hash is what recognises the echo, and it is of the edited text.
    const thread = await threadRow("lead-1");
    expect(thread.state).toBe("m1_pendiente");
    expect(thread.m1_sha).toBe(await textSha(edited));
    expect(thread.m1_registered_at).toBeGreaterThan(0);
    expect(thread.m1_registered_at).toBeLessThanOrEqual(Date.now());

    // What lands in the clipboard is the registered text, not the draft's.
    expect(response.html).toContain('id="m1-copy"');
    expect(response.html).toContain(`>${edited}</textarea>`);
    expect(response.html).toContain("navigator.clipboard.writeText");
    expect(response.html).toContain(`https://ig.me/m/${handleFor("lead-1")}`);

    // Coming back to the page later it is still waiting for its echo.
    const later = await getPage("/prospects");
    expect(section(later.html, "m1-por-enviar")).toContain(`@${handleFor("lead-1")}`);
    expect(later.html).toContain("Registrado hace");
  });

  it("refuses to re-arm an enrolled thread and to register an empty message", async () => {
    const enrolled = await enrolledLead({
      leadId: "lead-1",
      peerId: "peer-1",
      m1: "Hola, soy Víctor.",
      at: Date.now() - HOUR,
    });
    const before = (await threadRow(enrolled.leadId)).m1_sha;

    const enrolledResponse = await postPage("/prospects/m1", {
      lead_id: "lead-1",
      text: "Otro texto",
    });
    expect(enrolledResponse.status).toBe(302);
    expect(decodeURIComponent(enrolledResponse.location ?? "")).toContain(
      "Este hilo ya está registrado",
    );
    expect((await threadRow("lead-1")).m1_sha).toBe(before);

    const emptyResponse = await postPage("/prospects/m1", { lead_id: "lead-1", text: "   " });
    expect(emptyResponse.status).toBe(302);
    expect(decodeURIComponent(emptyResponse.location ?? "")).toContain("vacío");
  });
});

describe("POST /prospects/m1/retry", () => {
  it("puts the unconfirmed M1 back in the send queue with its text", async () => {
    await pendingLead({ leadId: "lead-1", m1Draft: "Hola, Ana. Soy Víctor." });
    await call("POST", "/api/prospects/expected-m1", {
      lead_id: "lead-1",
      text: "Hola, Ana. Soy Víctor.",
    });
    await env.DB.prepare(`UPDATE prospect_threads SET state = 'm1_sin_confirmar' WHERE lead_id = ?`)
      .bind("lead-1")
      .run();
    expect((await getPage("/prospects")).html).toContain('action="/prospects/m1/retry"');

    const response = await postPage("/prospects/m1/retry", { lead_id: "lead-1" });
    expect(response.status).toBe(302);
    expect(response.location).toContain("/prospects");

    const thread = await threadRow("lead-1");
    expect(thread.state).toBe("m1_pendiente");
    // The old hash is dropped: it points at a text nobody sent.
    expect(thread.m1_sha).toBeNull();
    expect(thread.m1_registered_at).toBeNull();

    const { html } = await getPage("/prospects");
    const m1 = section(html, "m1-por-enviar");
    expect(m1).toContain(`@${handleFor("lead-1")}`);
    expect(m1).toContain(">Hola, Ana. Soy Víctor.</textarea>");
    expect(section(html, "m1-sin-confirmar")).not.toContain(`@${handleFor("lead-1")}`);
  });
});

describe("POST /prospects/drafts", () => {
  it("records the approval with the text the operator left, and sends nothing", async () => {
    const now = Date.now();
    const enrolled = await enrolledLead({
      leadId: "lead-1",
      peerId: "peer-1",
      m1: "Hola, soy Víctor.",
      at: now - 3 * HOUR,
    });
    await leadsReplies({ thread: enrolled, text: "Cuéntame más", at: now - HOUR });
    await pushDraft({ draftId: "draft-1", leadId: "lead-1", text: "Gracias por responder." });
    const messages = await messageCount();
    const edited = "Gracias por responder, Ana. ¿Lo vemos el jueves?";

    const response = await postPage("/prospects/drafts", {
      draft_id: "draft-1",
      action: "approve",
      text: edited,
    });
    expect(response.status).toBe(302);
    expect(response.location).toContain("/prospects");

    const draft = await draftRow("draft-1");
    expect(draft.status).toBe("approved");
    expect(draft.decided_text).toBe(edited);
    expect(draft.decided_at).toBeGreaterThan(0);
    // Approval is not a send: T7 owns that, and nothing left the Worker here.
    expect(await messageCount()).toBe(messages);
    const sends = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sends`).first<{ n: number }>();
    expect(sends?.n).toBe(0);
  });

  it("skips a draft without approving it", async () => {
    const now = Date.now();
    const enrolled = await enrolledLead({
      leadId: "lead-1",
      peerId: "peer-1",
      m1: "Hola, soy Víctor.",
      at: now - 3 * HOUR,
    });
    await leadsReplies({ thread: enrolled, text: "No me interesa", at: now - HOUR });
    await pushDraft({ draftId: "draft-1", leadId: "lead-1", text: "Gracias por responder." });

    const response = await postPage("/prospects/drafts", { draft_id: "draft-1", action: "skip" });
    expect(response.status).toBe(302);

    const draft = await draftRow("draft-1");
    expect(draft.status).toBe("skipped");
    expect(draft.decided_text).toBeNull();
    expect(draft.decided_at).toBeGreaterThan(0);
  });

  it("settles an unknown send either way: back to waiting, or sent", async () => {
    const now = Date.now();
    const enrolled = await enrolledLead({
      leadId: "lead-1",
      peerId: "peer-1",
      m1: "Hola, soy Víctor.",
      at: now - 3 * HOUR,
    });
    await leadsReplies({ thread: enrolled, text: "Cuéntame más", at: now - HOUR });

    for (const [draftId, action, expected] of [
      ["draft-no", "not_sent", "waiting"],
      ["draft-si", "sent", "sent"],
    ] as const) {
      await pushDraft({ draftId, leadId: "lead-1", text: "Te cuento." });
      await env.DB.prepare(`UPDATE prospect_drafts SET status = 'send_state_unknown' WHERE draft_id = ?`)
        .bind(draftId)
        .run();

      const response = await postPage("/prospects/drafts", { draft_id: draftId, action });
      expect(response.status).toBe(302);
      expect((await draftRow(draftId)).status).toBe(expected);
    }
  });

  it("confirms a manual send from the out-of-window queue", async () => {
    const now = Date.now();
    const enrolled = await enrolledLead({
      leadId: "lead-1",
      peerId: "peer-1",
      m1: "Hola, soy Víctor.",
      at: now - 40 * HOUR,
    });
    await leadsReplies({ thread: enrolled, text: "Cuéntame más", at: now - 25 * HOUR });
    await pushDraft({ draftId: "draft-1", leadId: "lead-1", text: "Perdona la tardanza." });

    const response = await postPage("/prospects/drafts", { draft_id: "draft-1", action: "sent" });
    expect(response.status).toBe(302);
    expect((await draftRow("draft-1")).status).toBe("sent");

    // Nothing waiting is left in either queue.
    const { html } = await getPage("/prospects");
    expect(section(html, "manual")).not.toContain(`@${handleFor("lead-1")}`);
    expect(section(html, "borradores")).not.toContain(`@${handleFor("lead-1")}`);
  });

  it("refuses an action on a draft that already moved on", async () => {
    const now = Date.now();
    const enrolled = await enrolledLead({
      leadId: "lead-1",
      peerId: "peer-1",
      m1: "Hola, soy Víctor.",
      at: now - 3 * HOUR,
    });
    await leadsReplies({ thread: enrolled, text: "Cuéntame más", at: now - HOUR });
    await pushDraft({ draftId: "draft-1", leadId: "lead-1", text: "Te cuento." });
    await env.DB.prepare(`UPDATE prospect_drafts SET status = 'skipped' WHERE draft_id = ?`)
      .bind("draft-1")
      .run();

    const response = await postPage("/prospects/drafts", {
      draft_id: "draft-1",
      action: "approve",
      text: "Te cuento.",
    });
    expect(response.status).toBe(302);
    expect(decodeURIComponent(response.location ?? "")).toContain("ya no está pendiente");
    expect((await draftRow("draft-1")).status).toBe("skipped");
  });
});
