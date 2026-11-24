import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      close_reason: string | null;
      m1_sha: string | null;
      m1_registered_at: number | null;
      version: number;
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

/** Place a draft in the batch order the send queue reads, without waiting. */
async function setDraftPushed(draftId: string, at: number): Promise<void> {
  await env.DB.prepare(`UPDATE prospect_drafts SET created_at = ? WHERE draft_id = ?`)
    .bind(at, draftId)
    .run();
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

/** The account's Durable Object, where a send's claim lives while it is in flight. */
const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(IG_USER_ID));

const messageCount = async () =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM prospect_messages`).first<{ n: number }>())?.n ??
  0;

/** How many outbound rows this lead holds with that exact text. */
async function outboundWithText(leadId: string, text: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM prospect_messages
     WHERE lead_id = ? AND direction = 'out' AND text = ?`,
  )
    .bind(leadId, text)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** One stored message's text — the export publishes the row, never its text. */
async function messageText(mid: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT text FROM prospect_messages WHERE mid = ?`)
    .bind(mid)
    .first<{ text: string }>();
  return row?.text ?? null;
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM prospect_authorizations`).run();
  await env.DB.prepare(`DELETE FROM prospect_drafts`).run();
  await env.DB.prepare(`DELETE FROM prospect_messages`).run();
  await env.DB.prepare(`DELETE FROM prospect_threads`).run();
  await env.DB.prepare(`DELETE FROM sends`).run();
  await env.DB.prepare(`DELETE FROM accounts`).run();
  // Claims outlive a test in this pool, so they have to go with the rows they
  // referred to: a held claim on a reused draft id makes a later echo look like
  // the copy of an API send that never happened.
  await account().clear();
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

  it("moves a fresh copy to Copiados and an old one to unconfirmed", async () => {
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
    // A copied thread is never in the send queue again, not even while the echo
    // could still be on its way: it waits in the collapsed section instead.
    expect(section(html, "m1-por-enviar")).not.toContain(`@${handleFor("lead-now")}`);
    expect(section(html, "m1-por-enviar")).not.toContain(`@${handleFor("lead-old")}`);
    const copied = section(html, "m1-copiados");
    expect(copied).toContain(`@${handleFor("lead-now")}`);
    expect(copied).toContain("Copiado hace");
    expect(copied).toContain("<details>");
    expect(copied).not.toContain("<details open");
    expect(section(html, "m1-sin-confirmar")).toContain(`@${handleFor("lead-old")}`);
    expect(section(html, "m1-sin-confirmar")).toContain("hace 2 h");
  });

  it("lists only uncopied M1s, in the order their drafts were pushed", async () => {
    // Threads are created c, a, b; drafts are pushed b, c, a. Neither the thread
    // order nor the lead id may decide the queue.
    for (const leadId of ["lead-c", "lead-a", "lead-b"]) {
      await pendingLead({ leadId, m1Draft: `Hola, ${leadId}.` });
    }
    const base = Date.now();
    await setDraftPushed("m1_lead-b", base - 3000);
    await setDraftPushed("m1_lead-c", base - 2000);
    await setDraftPushed("m1_lead-a", base - 1000);

    const pending = section((await getPage("/prospects")).html, "m1-por-enviar");
    const positions = ["lead-b", "lead-c", "lead-a"].map((id) =>
      pending.indexOf(`@${handleFor(id)}`),
    );
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    expect(positions.every((position) => position > -1)).toBe(true);

    // Copiying one takes it out of the queue and puts it in the collapsed
    // section; the next uncopied lead is the first card that remains.
    const posted = await postPage("/prospects/m1", {
      lead_id: "lead-c",
      text: "Hola, lead-c.",
    });
    const copied = await getPage(posted.location ?? "");
    const after = section(copied.html, "m1-por-enviar");
    expect(after).not.toContain(`@${handleFor("lead-c")}`);
    expect(after.indexOf(`@${handleFor("lead-b")}`)).toBeLessThan(
      after.indexOf(`@${handleFor("lead-a")}`),
    );
    const waiting = section(copied.html, "m1-copiados");
    expect(waiting).toContain(`@${handleFor("lead-c")}`);
    expect(waiting).toContain("Copiado hace");

    // A reload reads the same thing from D1.
    const later = section((await getPage("/prospects")).html, "m1-copiados");
    expect(later).toContain(`@${handleFor("lead-c")}`);
  });

  it("renders and copies the M1 with its line breaks", async () => {
    const text = "Hola, Ana.\nSoy Víctor.\n¿Te encaja?";
    await pendingLead({ leadId: "lead-lines", m1Draft: text });

    const page = await getPage("/prospects");
    expect(section(page.html, "m1-por-enviar")).toContain(`>${text}</textarea>`);

    const posted = await postPage("/prospects/m1", { lead_id: "lead-lines", text });
    expect(posted.status).toBe(303);
    const copied = await getPage(posted.location ?? "");
    // The clipboard box and the preview both keep the newlines; the CSS keeps
    // the preview's line breaks visible.
    expect(copied.html).toContain(`id="m1-copy"`);
    expect(copied.html).toContain(`>${text}</textarea>`);
    expect(copied.html).toContain(`<pre class="preview">${text}</pre>`);
    expect(copied.html).toContain("white-space: pre-wrap");
  });

  it("refreshes on return without losing an edit in progress", async () => {
    await pendingLead({ leadId: "lead-1", m1Draft: "Hola." });
    const { html } = await getPage("/prospects");
    expect(html).toContain('addEventListener("visibilitychange"');
    expect(html).toContain('addEventListener("focus"');
    expect(html).toContain("event.persisted");
    expect(html).toContain("location.reload()");
    expect(html).toContain("dirty = true");
  });

  it("offers the optional warming hint on the send queue and adds no action for it", async () => {
    await pendingLead({ leadId: "lead-nuevo", name: "Ana", m1Draft: "Hola, Ana." });
    const { html } = await getPage("/prospects");

    const m1 = section(html, "m1-por-enviar");
    expect(m1).toContain("Opcional: síguela y comenta o responde a una story");
    expect(m1).toContain("≥24 h antes");

    // A suggestion, not a step: the paragraph carries no link, button or form of
    // its own, and the card keeps the one action it had (copy and register).
    const hint = m1.slice(m1.indexOf("Opcional:"));
    const paragraph = hint.slice(0, hint.indexOf("</p>"));
    expect(paragraph).not.toContain("<a ");
    expect(paragraph).not.toContain("<button");
    expect(paragraph).not.toContain("<form");
    // The card keeps its copy action and gains the close button; the hint adds
    // neither.
    expect(m1.match(/action="\/prospects\/m1"/g)).toHaveLength(1);
    expect(m1.match(/action="\/prospects\/close"/g)).toHaveLength(1);

    // Only the queue that sends the M1: warming up is a step before it, not a
    // thing to do once somebody replied.
    expect(section(html, "m1-sin-confirmar")).not.toContain("Opcional:");
    expect(section(html, "borradores")).not.toContain("Opcional:");
    expect(section(html, "manual")).not.toContain("Opcional:");
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
  it("registers the edited text and answers with a GET that carries it", async () => {
    await pendingLead({ leadId: "lead-1", m1Draft: "Hola, Ana. Soy Víctor." });
    const edited = "Hola, Ana. Soy Víctor, de Madrid.";

    const response = await postPage("/prospects/m1", { lead_id: "lead-1", text: edited });
    // Ending in a GET is what makes coming back from Instagram harmless: the
    // reload re-reads the notice instead of posting the copy a second time.
    expect(response.status).toBe(303);
    expect(response.location).toBe("/prospects?copied=lead-1");

    // The hash is what recognises the echo, and it is of the edited text.
    const thread = await threadRow("lead-1");
    expect(thread.state).toBe("m1_pendiente");
    expect(thread.m1_sha).toBe(await textSha(edited));
    expect(thread.m1_registered_at).toBeGreaterThan(0);
    expect(thread.m1_registered_at).toBeLessThanOrEqual(Date.now());

    // The notice, and the text the clipboard gets, live on the page the redirect
    // points at: reading it again is reading, never a second registration.
    const notice = await getPage(response.location ?? "");
    expect(notice.status).toBe(200);
    expect(notice.html).toContain('id="m1-copy"');
    expect(notice.html).toContain(`>${edited}</textarea>`);
    expect(notice.html).toContain(`https://ig.me/m/${handleFor("lead-1")}`);
    expect(notice.html).toContain("siguiente lead");
    expect(section(notice.html, "m1-por-enviar")).not.toContain(`@${handleFor("lead-1")}`);

    // A reload of that same URL writes nothing: the registration moment is the
    // one the POST made, and no message row is invented by a GET.
    const messagesBefore = await messageCount();
    const again = await getPage(response.location ?? "");
    expect(again.html).toContain(`>${edited}</textarea>`);
    expect((await threadRow("lead-1")).m1_registered_at).toBe(thread.m1_registered_at);
    expect(await messageCount()).toBe(messagesBefore);

    // The copied card is gone from the top immediately; coming back to the page
    // later it is still waiting for its echo, in the collapsed section.
    const later = await getPage("/prospects");
    expect(section(later.html, "m1-por-enviar")).not.toContain(`@${handleFor("lead-1")}`);
    expect(section(later.html, "m1-copiados")).toContain(`@${handleFor("lead-1")}`);
    expect(section(later.html, "m1-copiados")).toContain("Copiado hace");
  });

  it("copies inside the tap and only claims the clipboard once the write resolved", async () => {
    await pendingLead({ leadId: "lead-1", m1Draft: "Hola, Ana. Soy Víctor." });
    const edited = "Hola, Ana. Soy Víctor, de Madrid.";

    // The box the operator reads is the one copied, inside the click: a copy
    // after the redirect has no user gesture behind it, and iOS refuses it.
    const page = await getPage("/prospects");
    expect(section(page.html, "m1-por-enviar")).toContain('data-copy-submit="m1-text-0"');
    expect(page.html).toContain("preventDefault()");
    expect(page.html).toContain("form.submit()");
    expect(page.html).toContain('remember(key, "ok")');
    expect(page.html).toContain('remember(key, "fail")');
    expect(page.html).toContain("sessionStorage.setItem(key, value)");

    const copied = await postPage("/prospects/m1", { lead_id: "lead-1", text: edited });
    const notice = await getPage(copied.location ?? "");
    // Nothing claims the clipboard up front: the tag starts hidden and the
    // honest fallback is the one on screen until a write resolves.
    expect(notice.html).toContain('id="m1-copy-state" hidden>En el portapapeles');
    expect(notice.html).toContain(
      'id="m1-copy-hint">Mantén pulsado el texto para copiarlo',
    );
    expect(notice.html).toContain("navigator.clipboard.writeText(box.value).then(copied, manual)");
    // A rejected write brings the readonly box on screen and selects it, so the
    // long press the hint asks for has something to land on.
    expect(notice.html).toContain('box.classList.remove("offscreen")');
    expect(notice.html).toContain("box.select()");
    expect(notice.html).toContain('<textarea id="m1-copy" readonly class="offscreen"');
    // The lead id reaches the script as data, never as source.
    expect(notice.html).toContain('data-copy-key="m1-copy:lead-1"');
    expect(notice.html).toContain('box.getAttribute("data-copy-key")');
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
    expect(enrolledResponse.status).toBe(303);
    expect(decodeURIComponent(enrolledResponse.location ?? "")).toContain(
      "Este hilo ya está registrado",
    );
    expect((await threadRow("lead-1")).m1_sha).toBe(before);

    const emptyResponse = await postPage("/prospects/m1", { lead_id: "lead-1", text: "   " });
    expect(emptyResponse.status).toBe(303);
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
    expect(response.status).toBe(303);
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

describe("POST /prospects/close", () => {
  it("offers «No le interesa» with a confirm on every thread card", async () => {
    const now = Date.now();
    await pendingLead({ leadId: "lead-pending", m1Draft: "Hola." });
    await pendingLead({ leadId: "lead-copied", m1Draft: "Hola, soy Víctor. Copiado." });
    await call("POST", "/api/prospects/expected-m1", {
      lead_id: "lead-copied",
      text: "Hola, soy Víctor. Copiado.",
    });

    await pendingLead({ leadId: "lead-old", m1Draft: "Hola, soy Víctor. Antiguo." });
    await call("POST", "/api/prospects/expected-m1", {
      lead_id: "lead-old",
      text: "Hola, soy Víctor. Antiguo.",
    });
    await env.DB.prepare(
      `UPDATE prospect_threads SET m1_registered_at = ? WHERE lead_id = 'lead-old'`,
    )
      .bind(now - 2 * HOUR)
      .run();

    await enrolledLead({
      leadId: "lead-follow",
      peerId: "peer-follow",
      m1: "Hola, soy Víctor. Seguimiento.",
      at: now - 4 * 24 * HOUR,
    });
    const active = await enrolledLead({
      leadId: "lead-draft",
      peerId: "peer-draft",
      m1: "Hola, soy Víctor. Borrador.",
      at: now - 3 * HOUR,
    });
    await leadsReplies({ thread: active, text: "Cuéntame más", at: now - HOUR });
    await pushDraft({ draftId: "draft-1", leadId: "lead-draft", text: "Te cuento." });

    const { html } = await getPage("/prospects");
    for (const id of [
      "m1-por-enviar",
      "m1-copiados",
      "m1-sin-confirmar",
      "seguimientos",
      "borradores",
    ]) {
      const queue = section(html, id);
      expect(queue, id).toContain('action="/prospects/close"');
      expect(queue, id).toContain('name="reason" value="no_interesa"');
      expect(queue, id).toContain("No le interesa");
      expect(queue, id).toContain("return confirm(");
    }
  });

  it("closes a thread, invalidates its drafts and refuses a re-arm or a different reason", async () => {
    const now = Date.now();
    await pendingLead({ leadId: "lead-pending", m1Draft: "Hola, soy Víctor." });
    const active = await enrolledLead({
      leadId: "lead-draft",
      peerId: "peer-draft",
      m1: "Hola, soy Víctor. Borrador.",
      at: now - 3 * HOUR,
    });
    await leadsReplies({ thread: active, text: "Cuéntame más", at: now - HOUR });
    await pushDraft({ draftId: "draft-1", leadId: "lead-draft", text: "Te cuento." });

    // The button posts exactly these two fields.
    for (const leadId of ["lead-pending", "lead-draft"]) {
      const response = await postPage("/prospects/close", {
        lead_id: leadId,
        reason: "no_interesa",
      });
      expect(response.status).toBe(303);
      expect(decodeURIComponent(response.location ?? "")).toContain("Hilo cerrado");

      const thread = await threadRow(leadId);
      expect(thread.state).toBe("closed");
      expect(thread.close_reason).toBe("no_interesa");
    }
    expect((await draftRow("draft-1")).status).toBe("invalidated");

    // A closed thread is gone from every queue, its draft is not pending, and
    // the M1 box refuses to arm it again.
    const { html } = await getPage("/prospects");
    expect(html).not.toContain(`@${handleFor("lead-pending")}`);
    expect(html).not.toContain(`@${handleFor("lead-draft")}`);

    const approve = await postPage("/prospects/drafts", {
      draft_id: "draft-1",
      action: "approve",
      text: "Te cuento.",
    });
    expect(decodeURIComponent(approve.location ?? "")).toContain("ya no está pendiente");

    const rearm = await postPage("/prospects/m1", {
      lead_id: "lead-pending",
      text: "Hola otra vez.",
    });
    expect(decodeURIComponent(rearm.location ?? "")).toContain("cerrado");

    const again = await postPage("/prospects/close", {
      lead_id: "lead-pending",
      reason: "no_interesa",
    });
    expect(decodeURIComponent(again.location ?? "")).toContain("ya estaba cerrado");

    const conflict = await postPage("/prospects/close", {
      lead_id: "lead-pending",
      reason: "otro",
    });
    expect(decodeURIComponent(conflict.location ?? "")).toContain("otro motivo");
  });
});

describe("POST /prospects/drafts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("records the approval with the text the operator left, and sends it", async () => {
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
    let sent: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ message_id: "mid_api_1" }), { status: 200 });
      }),
    );

    const response = await postPage("/prospects/drafts", {
      draft_id: "draft-1",
      action: "approve",
      text: edited,
    });
    expect(response.status).toBe(303);
    expect(decodeURIComponent(response.location ?? "")).toContain("enviado");

    // Approving is the send (T7): the operator's text is what reaches the lead.
    expect(sent.message).toEqual({ text: edited });
    const draft = await draftRow("draft-1");
    expect(draft.status).toBe("sent");
    expect(draft.decided_text).toBe(edited);
    expect(draft.decided_at).toBeGreaterThan(0);
    expect(await messageCount()).toBe(messages + 1);
    // A prospect send is logged in its conversation, never in `sends`.
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
    expect(response.status).toBe(303);

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
      expect(response.status).toBe(303);
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
    expect(response.status).toBe(303);
    expect((await draftRow("draft-1")).status).toBe("sent");

    // Nothing waiting is left in either queue.
    const { html } = await getPage("/prospects");
    expect(section(html, "manual")).not.toContain(`@${handleFor("lead-1")}`);
    expect(section(html, "borradores")).not.toContain(`@${handleFor("lead-1")}`);
  });

  /**
   * «Salió» is the only record of a reply the operator sent by hand: no API send
   * wrote it and its echo cannot be told apart from any other message, so the
   * Sheet kept the thread asking for our reply and the 24 h warning never went
   * out (S8).
   */
  it("records the message when the operator says «Salió»", async () => {
    const now = Date.now();
    const enrolled = await enrolledLead({
      leadId: "lead-1",
      peerId: "peer-1",
      m1: "Hola, soy Víctor.",
      at: now - 40 * HOUR,
    });
    await leadsReplies({ thread: enrolled, text: "Cuéntame más", at: now - 25 * HOUR });
    await pushDraft({ draftId: "draft-1", leadId: "lead-1", text: "Perdona la tardanza." });
    const before = await threadRow("lead-1");
    const messages = await messageCount();

    const response = await postPage("/prospects/drafts", { draft_id: "draft-1", action: "sent" });
    expect(response.status).toBe(303);
    expect(await messageCount()).toBe(messages + 1);

    const exported = await call("GET", "/api/prospects/export");
    expect(exported.status).toBe(200);
    // A row the Sheet can tell from an echo: our own mid, our own origin.
    expect(exported.json.messages).toContainEqual(
      expect.objectContaining({
        mid: "manual:draft-1",
        lead_id: "lead-1",
        direction: "out",
        origin: "owner",
      }),
    );

    const thread = exported.json.threads.find((t: any) => t.lead_id === "lead-1");
    expect(thread.version).toBe(before.version + 1);
    const ours = exported.json.messages.filter(
      (m: any) => m.lead_id === "lead-1" && m.direction === "out",
    );
    expect(thread.last_outbound_at).toBe(Math.max(...ours.map((m: any) => m.sent_at)));
    expect(thread.last_outbound_at).toBeGreaterThan(before.last_outbound_at ?? 0);

    // The rule the Sheet derives "respondió" from: with our message last it is
    // not asking for our reply any more.
    const lastIn = Math.max(
      ...exported.json.messages
        .filter((m: any) => m.lead_id === "lead-1" && m.direction === "in")
        .map((m: any) => m.sent_at),
    );
    expect(thread.last_outbound_at).toBeGreaterThanOrEqual(lastIn);

    // A second «Salió» writes nothing; neither does one whose decision wins
    // again, because the `mid` is derived from the draft.
    const again = await postPage("/prospects/drafts", { draft_id: "draft-1", action: "sent" });
    expect(again.status).toBe(303);
    expect(await messageCount()).toBe(messages + 1);

    await env.DB.prepare(
      `UPDATE prospect_drafts SET status = 'send_state_unknown' WHERE draft_id = 'draft-1'`,
    ).run();
    const settled = await postPage("/prospects/drafts", { draft_id: "draft-1", action: "sent" });
    expect(settled.status).toBe(303);
    expect((await draftRow("draft-1")).status).toBe("sent");
    expect(await messageCount()).toBe(messages + 1);
    expect((await threadRow("lead-1")).version).toBe(before.version + 1);

    // And a decision that lost writes nothing at all: `sent` is also where the
    // API leaves a draft, so a stale page must not turn that send into this one.
    await pushDraft({ draftId: "draft-2", leadId: "lead-1", text: "Otra respuesta." });
    await env.DB.prepare(
      `UPDATE prospect_drafts SET status = 'sent', decided_at = ? WHERE draft_id = 'draft-2'`,
    )
      .bind(now - 1000)
      .run();
    const version = (await threadRow("lead-1")).version;
    const lost = await postPage("/prospects/drafts", { draft_id: "draft-2", action: "sent" });
    expect(decodeURIComponent(lost.location ?? "")).toContain("ya no está pendiente");
    expect(await messageCount()).toBe(messages + 1);
    expect((await threadRow("lead-1")).version).toBe(version);
  });

  /**
   * The button has to record the message before Meta's copy of it arrives, so
   * one DM ends up with two identities: the `manual:<draft_id>` the page wrote
   * and the mid the webhook carries. Storing the echo as well would leave two
   * outbound rows and two version bumps for a message the lead saw once, and
   * every draft would be retired twice over a conversation that never moved
   * (JD-B-002).
   */
  it("ignores the echo of the message «Salió» already recorded", async () => {
    const now = Date.now();
    const enrolled = await enrolledLead({
      leadId: "lead-1",
      peerId: "peer-1",
      m1: "Hola, soy Víctor.",
      at: now - 40 * HOUR,
    });
    await leadsReplies({ thread: enrolled, text: "Cuéntame más", at: now - 25 * HOUR });
    const told = "Perdona la tardanza, te cuento ahora mismo.";
    await pushDraft({ draftId: "draft-1", leadId: "lead-1", text: told });

    const response = await postPage("/prospects/drafts", { draft_id: "draft-1", action: "sent" });
    expect(response.status).toBe(303);
    expect(await outboundWithText("lead-1", told)).toBe(1);
    const decided = await threadRow("lead-1");

    // The same DM coming back as an echo, with a mid nothing here has seen.
    const at = now + 1000;
    await deliver(echo({ text: told, peerId: "peer-1", mid: "mid_echo_manual_1", at }));

    // One message, one row, one version — and the row is still the page's.
    expect(await outboundWithText("lead-1", told)).toBe(1);
    const exported = await call("GET", "/api/prospects/export");
    expect(exported.status).toBe(200);
    expect(
      exported.json.messages.filter(
        (m: any) => m.lead_id === "lead-1" && m.direction === "out",
      ),
    ).toEqual([
      expect.objectContaining({ mid: "mid_echo_lead-1", origin: "echo_m1" }),
      expect.objectContaining({ mid: "manual:draft-1", origin: "owner" }),
    ]);
    const thread = exported.json.threads.find((t: any) => t.lead_id === "lead-1");
    expect(thread.version).toBe(decided.version);
    expect(thread.last_outbound_at).toBe(decided.last_outbound_at);

    // A redelivery of that echo still writes nothing at all.
    await deliver(echo({ text: told, peerId: "peer-1", mid: "mid_echo_manual_1", at }));
    expect(await outboundWithText("lead-1", told)).toBe(1);
    expect((await threadRow("lead-1")).version).toBe(decided.version);
  });

  /**
   * The guard is about one DM seen twice, not about the text: a different
   * message the operator types after «Salió» has no other way of being stored.
   */
  it("still records an echo whose text «Salió» never recorded", async () => {
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
    expect(response.status).toBe(303);
    const decided = await threadRow("lead-1");

    const typed = "Te paso los detalles por aquí.";
    const at = now + 1000;
    await deliver(echo({ text: typed, peerId: "peer-1", mid: "mid_owner_after", at }));

    expect(await outboundWithText("lead-1", typed)).toBe(1);
    const after = await threadRow("lead-1");
    expect(after.version).toBe(decided.version + 1);
    expect(after.last_outbound_at).toBe(at);
  });

  /**
   * The same text after the lead has written back is a second message, not a
   * duplicate: the manual row is no longer the last thing in the conversation,
   * so nothing proves the echo is the one «Salió» already stored.
   */
  it("records the same text again once the lead has written back", async () => {
    const now = Date.now();
    const enrolled = await enrolledLead({
      leadId: "lead-1",
      peerId: "peer-1",
      m1: "Hola, soy Víctor.",
      at: now - 40 * HOUR,
    });
    await leadsReplies({ thread: enrolled, text: "Cuéntame más", at: now - 25 * HOUR });
    const told = "Perdona la tardanza, te cuento ahora mismo.";
    await pushDraft({ draftId: "draft-1", leadId: "lead-1", text: told });

    const response = await postPage("/prospects/drafts", { draft_id: "draft-1", action: "sent" });
    expect(response.status).toBe(303);
    await leadsReplies({ thread: enrolled, text: "Vale, ¿y el precio?", at: now + 500 });
    const replied = await threadRow("lead-1");

    const at = now + 1000;
    await deliver(echo({ text: told, peerId: "peer-1", mid: "mid_owner_again", at }));

    expect(await outboundWithText("lead-1", told)).toBe(2);
    const after = await threadRow("lead-1");
    expect(after.version).toBe(replied.version + 1);
    expect(after.last_outbound_at).toBe(at);
  });

  /**
   * An approval that ended unknown was attempted with the text the operator
   * left, not with the draft's (the send path reads `decidedText ?? text`), so
   * «Salió» has to record that text and keep the only copy of it: it is what
   * the lead may have received, and nulling it would lose it (JD-A-001).
   */
  it("keeps the approved text when «Salió» settles an unknown send", async () => {
    const now = Date.now();
    const enrolled = await enrolledLead({
      leadId: "lead-1",
      peerId: "peer-1",
      m1: "Hola, soy Víctor.",
      at: now - 3 * HOUR,
    });
    await leadsReplies({ thread: enrolled, text: "Cuéntame más", at: now - HOUR });
    await pushDraft({ draftId: "draft-edited", leadId: "lead-1", text: "Gracias por responder." });
    const edited = "Gracias por responder, Ana. ¿Lo vemos el jueves?";

    // Meta never answered, so nothing proves whether the edited text landed:
    // the draft waits for a person in the manual queue.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("The operation was aborted due to timeout");
      }),
    );
    const approval = await postPage("/prospects/drafts", {
      draft_id: "draft-edited",
      action: "approve",
      text: edited,
    });
    expect(approval.status).toBe(303);
    expect(decodeURIComponent(approval.location ?? "")).toContain("send_state_unknown");
    const unknown = await draftRow("draft-edited");
    expect(unknown.status).toBe("send_state_unknown");
    expect(unknown.decided_text).toBe(edited);

    const response = await postPage("/prospects/drafts", {
      draft_id: "draft-edited",
      action: "sent",
    });
    expect(response.status).toBe(303);
    expect((await draftRow("draft-edited")).status).toBe("sent");

    // The message the page records is the one the attempt carried, and the
    // draft still holds the text it was sent from.
    expect(await messageText("manual:draft-edited")).toBe(edited);
    expect((await draftRow("draft-edited")).decided_text).toBe(edited);

    const exported = await call("GET", "/api/prospects/export");
    expect(exported.status).toBe(200);
    expect(exported.json.messages).toContainEqual(
      expect.objectContaining({
        mid: "manual:draft-edited",
        lead_id: "lead-1",
        direction: "out",
        origin: "owner",
      }),
    );
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
    expect(response.status).toBe(303);
    expect(decodeURIComponent(response.location ?? "")).toContain("ya no está pendiente");
    expect((await draftRow("draft-1")).status).toBe("skipped");
  });
});
