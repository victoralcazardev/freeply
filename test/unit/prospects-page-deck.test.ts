import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession, sessionCookie } from "../../src/auth";
import * as db from "../../src/db";
import worker from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/**
 * The focus deck of /prospects: one card at a time, a queue switcher, and the
 * same queue sections the page has always rendered.
 *
 * The deck itself is JavaScript, and this pool has no browser, so what is pinned
 * here is the contract the script works on: every queue is server-rendered with
 * its cards and its count, the switcher lists every queue with work, the default
 * queue is the most urgent one with work, and each card type keeps its forms.
 * The no-JS contract is pinned the same way: nothing is hidden in the markup, so
 * a phone without the script still gets the plain list.
 */

const TOKEN = "test-api-token";
const apiEnv = { ...env, API_TOKEN: TOKEN };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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

async function sessionCookieHeader(value = FIXTURE_SECRETS.DASHBOARD_PASSWORD): Promise<string> {
  const session = await createSession(value);
  return sessionCookie(session).split(";")[0];
}

async function getPage(path = "/prospects"): Promise<{ status: number; html: string }> {
  const request = new Request(`https://freeply.test${path}`, {
    headers: { cookie: await sessionCookieHeader() },
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, html: await response.text() };
}

/** One queue's slice of the page, the way the older page tests read it. */
function section(html: string, id: string): string {
  const start = html.indexOf(`<section id="${id}"`);
  expect(start, `section ${id} missing`).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  expect(end, `section ${id} not closed`).toBeGreaterThan(start);
  return html.slice(start, end);
}

async function pendingLead(leadId: string, m1Draft: string): Promise<void> {
  const created = await call("POST", "/api/prospects/threads", {
    lead_id: leadId,
    handle: handleFor(leadId),
  });
  expect(created.status).toBe(201);
  const draft = await call("POST", "/api/prospects/drafts", {
    draft_id: `m1_${leadId}`,
    lead_id: leadId,
    kind: "m1",
    stage: "M1",
    text: m1Draft,
    base_version: 0,
  });
  expect(draft.status).toBe(201);
}

/** Sheet row, M1 registered, echo back: an enrolled thread. */
async function enrolledLead(o: {
  leadId: string;
  peerId: string;
  m1: string;
  at: number;
}): Promise<void> {
  await pendingLead(o.leadId, o.m1);
  const registered = await call("POST", "/api/prospects/expected-m1", {
    lead_id: o.leadId,
    text: o.m1,
  });
  expect(registered.status).toBe(200);
  await deliver(echo({ text: o.m1, peerId: o.peerId, mid: `mid_echo_${o.leadId}`, at: o.at }));
}

async function leadsReplies(o: { leadId: string; peerId: string; text: string; at: number }) {
  await deliver(inbound({ peerId: o.peerId, text: o.text, mid: `mid_in_${o.leadId}_${o.at}`, at: o.at }));
}

async function pushDraft(o: {
  draftId: string;
  leadId: string;
  text: string;
  stage?: string;
}): Promise<void> {
  const version = await env.DB.prepare(`SELECT version FROM prospect_threads WHERE lead_id = ?`)
    .bind(o.leadId)
    .first<{ version: number }>();
  const created = await call("POST", "/api/prospects/drafts", {
    draft_id: o.draftId,
    lead_id: o.leadId,
    kind: "reply",
    stage: o.stage ?? "Filtro",
    text: o.text,
    base_version: version?.version ?? 0,
  });
  expect(created.status).toBe(201);
}

/** The six queues with at least one thread each, the way a busy day looks. */
async function everyQueue(): Promise<void> {
  const now = Date.now();

  // Borradores: the window is closing, so this reply is the most urgent work.
  await enrolledLead({
    leadId: "lead-draft",
    peerId: "peer-draft",
    m1: "Hola, soy Víctor. Borrador.",
    at: now - 30 * HOUR,
  });
  await leadsReplies({
    leadId: "lead-draft",
    peerId: "peer-draft",
    text: "Cuéntame más",
    at: now - 21 * HOUR,
  });
  await pushDraft({ draftId: "draft-1", leadId: "lead-draft", text: "Te cuento." });

  // Manual, out of window.
  await enrolledLead({
    leadId: "lead-closed",
    peerId: "peer-closed",
    m1: "Hola, soy Víctor. Ventana.",
    at: now - 40 * HOUR,
  });
  await leadsReplies({
    leadId: "lead-closed",
    peerId: "peer-closed",
    text: "Ahora no",
    at: now - 25 * HOUR,
  });
  await pushDraft({ draftId: "draft-closed", leadId: "lead-closed", text: "Perdona la tardanza." });

  // Manual, a send whose outcome Meta never confirmed.
  await enrolledLead({
    leadId: "lead-unknown",
    peerId: "peer-unknown",
    m1: "Hola, soy Víctor. Sin confirmar.",
    at: now - 3 * HOUR,
  });
  await leadsReplies({
    leadId: "lead-unknown",
    peerId: "peer-unknown",
    text: "¿Me lo pasas?",
    at: now - 2 * HOUR,
  });
  await pushDraft({ draftId: "draft-unknown", leadId: "lead-unknown", text: "Claro." });
  await env.DB.prepare(
    `UPDATE prospect_drafts SET status = 'send_state_unknown' WHERE draft_id = 'draft-unknown'`,
  ).run();

  // M1 por enviar: drafted, never copied.
  await pendingLead("lead-pending", "Hola, lead-pending.");

  // M1 sin confirmar: copied two hours ago, no echo.
  await pendingLead("lead-unconfirmed", "Hola, lead-unconfirmed.");
  await call("POST", "/api/prospects/expected-m1", {
    lead_id: "lead-unconfirmed",
    text: "Hola, lead-unconfirmed.",
  });
  await env.DB.prepare(
    `UPDATE prospect_threads SET m1_registered_at = ? WHERE lead_id = 'lead-unconfirmed'`,
  )
    .bind(now - 2 * HOUR)
    .run();

  // Copiados: copied a minute ago, the echo may still be on its way.
  await pendingLead("lead-copied", "Hola, lead-copied.");
  await call("POST", "/api/prospects/expected-m1", {
    lead_id: "lead-copied",
    text: "Hola, lead-copied.",
  });

  // Seguimientos: enrolled four days ago and never answered.
  await enrolledLead({
    leadId: "lead-follow",
    peerId: "peer-follow",
    m1: "Hola, soy Víctor. Seguimiento.",
    at: now - 4 * DAY,
  });
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM prospect_authorizations`).run();
  await env.DB.prepare(`DELETE FROM prospect_drafts`).run();
  await env.DB.prepare(`DELETE FROM prospect_messages`).run();
  await env.DB.prepare(`DELETE FROM prospect_threads`).run();
  await env.DB.prepare(`DELETE FROM sends`).run();
  await env.DB.prepare(`DELETE FROM accounts`).run();
  await env.ACCOUNT.get(env.ACCOUNT.idFromName(IG_USER_ID)).clear();
  await db.upsertAccount(env.DB, env.ENCRYPTION_KEY, {
    igUserId: IG_USER_ID,
    username: "victoralcazar",
    accessToken: "IGAA-fixture-token",
    expiresIn: 60 * 24 * 60 * 60,
  });
});

/* ------------------------------------------------------------------ deck */

describe("the focus deck", () => {
  it("renders every queue with its cards and its count", async () => {
    await everyQueue();
    const { status, html } = await getPage();
    expect(status).toBe(200);

    const expected: Array<[string, string, number, string]> = [
      ["borradores", "drafts", 1, `@${handleFor("lead-draft")}`],
      ["m1-por-enviar", "m1", 1, `@${handleFor("lead-pending")}`],
      ["m1-sin-confirmar", "unconfirmed", 1, `@${handleFor("lead-unconfirmed")}`],
      ["m1-copiados", "copied", 1, `@${handleFor("lead-copied")}`],
      ["seguimientos", "followups", 1, `@${handleFor("lead-follow")}`],
      // Manual holds both the closed window and the unconfirmed send.
      ["manual", "manual", 2, `@${handleFor("lead-closed")}`],
    ];

    for (const [id, key, count, handle] of expected) {
      const queue = section(html, id);
      expect(queue, id).toContain(`data-queue="${key}"`);
      // The count travels in the markup, not only in the heading text.
      expect(queue, id).toContain(`data-queue-count="${count}"`);
      expect(queue, id).toContain(`class="small muted">${count}</span>`);
      expect(queue, id).toContain(handle);
      // A card, not a pre-rendered pile: the script shows one at a time.
      expect(queue, id).toContain("data-card");
    }

    // Manual holds the two hand-work reasons side by side.
    expect(section(html, "manual")).toContain(`@${handleFor("lead-unknown")}`);
    // Every queue carries its own card, so nothing was flattened into one list.
    expect(section(html, "borradores")).not.toContain(`@${handleFor("lead-pending")}`);
    expect(section(html, "m1-por-enviar")).not.toContain(`@${handleFor("lead-draft")}`);
  });

  it("lists every non-empty queue in the switcher, with its count", async () => {
    await everyQueue();
    const { html } = await getPage();

    const sheet = html.slice(
      html.indexOf('<dialog id="queue-sheet"'),
      html.indexOf("</dialog>"),
    );
    expect(sheet).toContain("Borradores de respuesta");
    expect(sheet).toContain("M1 por enviar");
    expect(sheet).toContain("M1 sin confirmar");
    expect(sheet).toContain("Copiados");
    expect(sheet).toContain("Seguimientos");
    expect(sheet).toContain("Manual");

    for (const key of ["drafts", "m1", "unconfirmed", "copied", "followups", "manual"]) {
      expect(sheet, key).toContain(`data-queue-link="${key}"`);
    }
    // Each entry says how much work is behind it.
    expect(sheet).toMatch(/data-queue-link="drafts"[\s\S]*?<b>1<\/b>/);

    // Escape closes it and focus goes back to the button that opened it.
    expect(sheet).toContain("data-queue-close");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('showModal');
    expect(html).toContain('addEventListener("close"');
    expect(html).toContain("opener.focus()");
  });

  it("leaves an empty queue out of the switcher", async () => {
    await pendingLead("lead-pending", "Hola, lead-pending.");
    const { html } = await getPage();

    const sheet = html.slice(
      html.indexOf('<dialog id="queue-sheet"'),
      html.indexOf("</dialog>"),
    );
    expect(sheet).toContain('data-queue-link="m1"');
    expect(sheet).not.toContain('data-queue-link="drafts"');
    expect(sheet).not.toContain('data-queue-link="copied"');
    expect(sheet).not.toContain('data-queue-link="followups"');
  });

  it("opens on the most urgent queue that has work", async () => {
    // A reply whose window is closing outranks the background M1 work.
    await everyQueue();
    expect((await getPage()).html).toContain('data-default-queue="drafts"');

    // Without a reply to approve, the thread only a person can settle comes next.
    for (const lead of ["lead-draft", "lead-pending", "lead-unconfirmed", "lead-copied"]) {
      await env.DB.prepare(`DELETE FROM prospect_drafts WHERE lead_id = ?`).bind(lead).run();
      await env.DB.prepare(`DELETE FROM prospect_messages WHERE lead_id = ?`).bind(lead).run();
      await env.DB.prepare(`DELETE FROM prospect_threads WHERE lead_id = ?`).bind(lead).run();
    }
    const manual = await getPage();
    expect(section(manual.html, "manual")).toContain(`@${handleFor("lead-closed")}`);
    expect(manual.html).toContain('data-default-queue="manual"');

    // And with only the send queue left, that is where the deck starts.
    await env.DB.prepare(`DELETE FROM prospect_drafts`).run();
    await env.DB.prepare(`DELETE FROM prospect_messages`).run();
    await env.DB.prepare(`DELETE FROM prospect_threads`).run();
    await pendingLead("lead-solo", "Hola, lead-solo.");
    expect((await getPage()).html).toContain('data-default-queue="m1"');

    // Nothing anywhere still renders the page, on the reply queue, empty.
    await env.DB.prepare(`DELETE FROM prospect_drafts`).run();
    await env.DB.prepare(`DELETE FROM prospect_threads`).run();
    const empty = await getPage();
    expect(empty.status).toBe(200);
    expect(empty.html).toContain('data-default-queue="drafts"');
    expect(empty.html).toContain("No hay borradores esperando el OK.");
  });

  it("keeps every form, field and action of each card type", async () => {
    await everyQueue();
    const { html } = await getPage();

    const m1 = section(html, "m1-por-enviar");
    expect(m1).toContain('action="/prospects/m1"');
    expect(m1).toContain(`name="lead_id" value="lead-pending"`);
    expect(m1).toContain('name="text"');
    expect(m1).toContain('data-copy-submit="m1-text-0"');

    const unconfirmed = section(html, "m1-sin-confirmar");
    expect(unconfirmed).toContain('action="/prospects/m1/retry"');
    expect(unconfirmed).toContain('name="lead_id" value="lead-unconfirmed"');

    const copied = section(html, "m1-copiados");
    expect(copied).toContain("<details>");
    expect(copied).not.toContain("<details open");

    const drafts = section(html, "borradores");
    expect(drafts).toContain('action="/prospects/drafts"');
    expect(drafts).toContain('name="draft_id"');
    expect(drafts).toContain('name="action" value="approve"');
    expect(drafts).toContain('name="action" value="skip"');

    const manual = section(html, "manual");
    expect(manual).toContain('name="action" value="sent"');
    expect(manual).toContain('name="action" value="not_sent"');
    expect(manual).toContain('name="action" value="skip"');

    const followups = section(html, "seguimientos");
    expect(followups).toContain('action="/prospects/followups"');
    expect(followups).toContain('name="action" value="touch"');

    // «No le interesa» is on every card that still holds a thread, with its
    // confirm and its two fields untouched.
    for (const id of ["m1-por-enviar", "m1-sin-confirmar", "m1-copiados", "borradores", "seguimientos", "manual"]) {
      const queue = section(html, id);
      expect(queue, id).toContain('action="/prospects/close"');
      expect(queue, id).toContain('name="reason" value="no_interesa"');
      expect(queue, id).toContain("return confirm(");
    }
  });

  it("shows urgency as words, not only as colour", async () => {
    await everyQueue();
    const { html } = await getPage();

    expect(section(html, "borradores")).toContain("A punto de caducar");
    expect(section(html, "borradores")).toContain("Quedan 3 h");
    expect(section(html, "manual")).toContain("Fuera de ventana");
    expect(section(html, "manual")).toContain("Salida sin confirmar");
    expect(section(html, "m1-sin-confirmar")).toContain("Sin eco");
    // A chip carries the words itself: the class is decoration around text.
    expect(html).toMatch(/class="tag warn">[^<]*(A punto de caducar|Fuera de ventana|Sin eco)/);
  });

  it("renders the plain list when the deck script never runs", async () => {
    await everyQueue();
    const { html } = await getPage();

    // Nothing is hidden by the server: the script is what turns the list into a
    // deck, so a phone without it still sees every card.
    expect(html).not.toMatch(/<section[^>]*data-queue[^>]* hidden/);
    expect(html).not.toMatch(/<div class="card"[^>]* hidden/);
    // The deck chrome waits for the script.
    expect(html).toContain("data-deck-chrome hidden");

    expect(html).toContain('removeAttribute("hidden")');
    expect(html).toContain('setAttribute("data-deck-ready", "1")');
    // Arrows page the deck but never steal the cursor from a box being edited.
    expect(html).toContain("TEXTAREA");
    expect(html).toContain("ArrowRight");
    expect(html).toContain("ArrowLeft");
    expect(html).toContain("isContentEditable");
    // Motion is opt-in for the people who want it.
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
