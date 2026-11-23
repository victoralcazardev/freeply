import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, sessionCookie } from "../../src/auth";
import * as db from "../../src/db";
import worker from "../../src/index";
import { FIXTURE_SECRETS, IG_USER_ID } from "../fixtures";

/**
 * The "Seguimientos" queue (T19): what happens to a thread whose M1 echo
 * enrolled it and whose lead never wrote back.
 *
 * Two steps, both manual: a no-DM touch from day 3, a single hand-sent follow-up
 * DM from day 7. At day 14 with no inbound the scheduled job closes the thread
 * with `no_reply`. Nothing here sends anything — the assertions on `fetch` and on
 * the exported message count are what make that claim checkable.
 *
 * Everything goes through the public routes: the page the operator's phone asks
 * for, the form it posts, the JSON API, and the exported `scheduled` handler the
 * deployment runs. Days are counted from the M1 echo's own timestamp, which is
 * what enrolment records as `enrolled_at`, so a test can place a thread on any
 * day by delivering the echo at that moment.
 */

const TOKEN = "test-api-token";
const apiEnv = { ...env, API_TOKEN: TOKEN };

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The trigger the every-fifteen-minutes jobs ride, as wrangler.jsonc sets it. */
const CRON = "*/15 * * * *";

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

/* ------------------------------------------------------------ page traffic */

function sessionCookieHeader(value = FIXTURE_SECRETS.DASHBOARD_PASSWORD): Promise<string> {
  return createSession(value).then((session) => sessionCookie(session).split(";")[0]);
}

async function getPage(
  opts: { cookie?: string | null } = {},
): Promise<{ status: number; html: string }> {
  const headers: Record<string, string> = {};
  const cookie = opts.cookie === undefined ? await sessionCookieHeader() : opts.cookie;
  if (cookie) headers.cookie = cookie;
  const request = new Request("https://freeply.test/prospects", { headers });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, html: await response.text() };
}

async function postPage(
  path: string,
  fields: Record<string, string>,
  opts: { cookie?: string | null } = {},
): Promise<{ status: number; location: string | null }> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const headers: Record<string, string> = {};
  const cookie = opts.cookie === undefined ? await sessionCookieHeader() : opts.cookie;
  if (cookie) headers.cookie = cookie;
  const request = new Request(`https://freeply.test${path}`, { method: "POST", headers, body });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, location: response.headers.get("location") };
}

/** One queue's slice of the page, so "not in this queue" is a real assertion. */
function section(html: string, id: string): string {
  const start = html.indexOf(`<section id="${id}"`);
  expect(start, `section ${id} missing`).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  expect(end, `section ${id} not closed`).toBeGreaterThan(start);
  return html.slice(start, end);
}

/** The exported thread — the public read of what the queue and the cron wrote. */
async function exportedThread(leadId: string): Promise<any> {
  const r = await call("GET", "/api/prospects/export");
  expect(r.status).toBe(200);
  const thread = r.json.threads.find((t: any) => t.lead_id === leadId);
  expect(thread, `thread ${leadId} not in export`).toBeDefined();
  return thread;
}

async function exportedMessages(leadId: string): Promise<any[]> {
  const r = await call("GET", "/api/prospects/export");
  return r.json.messages.filter((m: any) => m.lead_id === leadId);
}

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

/* ------------------------------------------------------------ arrangement */

async function pendingLead(o: { leadId: string; name?: string }): Promise<string> {
  const m1 = `Hola, soy Víctor. Te escribo por ${o.leadId}.`;
  const created = await call("POST", "/api/prospects/threads", {
    lead_id: o.leadId,
    handle: handleFor(o.leadId),
    name: o.name ?? null,
  });
  expect(created.status).toBe(201);
  const registered = await call("POST", "/api/prospects/expected-m1", {
    lead_id: o.leadId,
    text: m1,
  });
  expect(registered.status).toBe(200);
  return m1;
}

/** The production path: Sheet row, M1 registered, its echo at `echoAt`. */
async function enrolledLead(o: {
  leadId: string;
  peerId: string;
  echoAt: number;
  name?: string;
}): Promise<void> {
  const m1 = await pendingLead({ leadId: o.leadId, name: o.name });
  await deliver(
    echo({ text: m1, peerId: o.peerId, mid: `mid_echo_${o.leadId}`, at: o.echoAt }),
  );
  expect((await exportedThread(o.leadId)).state).toBe("enrolled");
}

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

afterEach(() => vi.unstubAllGlobals());

describe("GET /prospects — Seguimientos", () => {
  it("shows nothing on day 2", async () => {
    const now = Date.now();
    await enrolledLead({ leadId: "lead-day2", peerId: "peer-2", echoAt: now - 2 * DAY });

    const { status, html } = await getPage();
    expect(status).toBe(200);

    const followups = section(html, "seguimientos");
    expect(followups).toContain("<h2>Seguimientos");
    expect(followups).toContain('class="small muted">0</');
    expect(followups).not.toContain(`@${handleFor("lead-day2")}`);
    expect(followups).not.toContain("Nada de DM nuevo");
  });

  it("offers the no-DM touch from day 3, with the profile link and no chat", async () => {
    const now = Date.now();
    await enrolledLead({
      leadId: "lead-day3",
      peerId: "peer-3",
      echoAt: now - 3 * DAY - MINUTE,
      name: "Ana",
    });

    const { html } = await getPage();
    const followups = section(html, "seguimientos");

    expect(followups).toContain("<h2>Seguimientos");
    expect(followups).toContain("Ana");
    expect(followups).toContain(`@${handleFor("lead-day3")}`);
    expect(followups).toContain("sin respuesta");
    // The step is a touch on the profile: comment or story, never a new DM.
    expect(followups).toContain(`https://www.instagram.com/${handleFor("lead-day3")}/`);
    expect(followups).toContain('target="_blank"');
    expect(followups).toContain("Comenta una publicación suya o responde a una story.");
    expect(followups).toContain("Nada de DM nuevo.");
    expect(followups).toContain('action="/prospects/followups"');
    expect(followups).toContain('name="lead_id" value="lead-day3"');
    expect(followups).toContain('name="action" value="touch"');
    expect(followups).toContain(">Hecho</button>");
    // The chat link is the day 7 step, not this one.
    expect(followups).not.toContain(`ig.me/m/${handleFor("lead-day3")}`);
  });

  it("replaces the touch with the follow-up DM at day 7, and keeps it until day 14", async () => {
    const now = Date.now();
    await enrolledLead({
      leadId: "lead-day6",
      peerId: "peer-6",
      echoAt: now - 7 * DAY + 2 * HOUR,
    });
    await enrolledLead({ leadId: "lead-day7", peerId: "peer-7", echoAt: now - 7 * DAY - MINUTE });
    await enrolledLead({
      leadId: "lead-day13",
      peerId: "peer-13",
      echoAt: now - 13 * DAY,
    });

    const { html } = await getPage();
    const followups = section(html, "seguimientos");

    // Day 6 is still the touch: the next step has not arrived yet.
    expect(followups).toContain(`https://www.instagram.com/${handleFor("lead-day6")}/`);
    expect(followups).not.toContain(`ig.me/m/${handleFor("lead-day6")}`);

    for (const leadId of ["lead-day7", "lead-day13"]) {
      const handle = handleFor(leadId);
      // An editable, empty box: the follow-up is written by hand, not filled in.
      expect(followups).toMatch(/<textarea id="followup-text-\d+"[^>]*><\/textarea>/);
      expect(followups).toContain(`ig.me/m/${handle}`);
      expect(followups).toContain("Copiar");
      expect(followups).toContain("navigator.clipboard.writeText");
      expect(followups).toContain('name="action" value="followup"');
      expect(followups).toContain(">Enviado</button>");
      // The touch was superseded, not repeated next to the DM step.
      expect(followups).not.toContain(`https://www.instagram.com/${handle}/`);
    }
  });

  it("drops the thread from the queue as soon as the lead writes back", async () => {
    const now = Date.now();
    await enrolledLead({ leadId: "lead-reply", peerId: "peer-r", echoAt: now - 5 * DAY });
    expect(section((await getPage()).html, "seguimientos")).toContain(
      `@${handleFor("lead-reply")}`,
    );

    await deliver(inbound({ peerId: "peer-r", text: "Cuéntame más", mid: "mid_in_r", at: now }));

    const followups = section((await getPage()).html, "seguimientos");
    expect(followups).not.toContain(`@${handleFor("lead-reply")}`);
    expect((await exportedThread("lead-reply")).touch_done_at).toBeNull();
  });
});

describe("the existing queues", () => {
  it("still send an M1, stay behind the session, and export a thread as before", async () => {
    const now = Date.now();

    // An untouched thread: the page's M1 queue and the export must read exactly
    // as they did before the follow-up queue existed.
    const m1 = await pendingLead({ leadId: "lead-old", name: "Bea" });
    // The CLI's M1 draft is what fills the page's box before it is copied.
    const draft = await call("POST", "/api/prospects/drafts", {
      draft_id: "m1_lead-old",
      lead_id: "lead-old",
      kind: "m1",
      stage: "M1",
      text: m1,
      base_version: 0,
    });
    expect(draft.status).toBe(201);
    await enrolledLead({ leadId: "lead-follow", peerId: "peer-z", echoAt: now - 4 * DAY });

    const { html } = await getPage();
    expect(section(html, "m1-por-enviar")).toContain(`@${handleFor("lead-old")}`);
    expect(section(html, "m1-por-enviar")).toContain(`>${m1}</textarea>`);
    expect(section(html, "seguimientos")).not.toContain(`@${handleFor("lead-old")}`);

    const before = await exportedThread("lead-old");
    expect(before).toMatchObject({ state: "m1_pendiente", handle: handleFor("lead-old") });
    expect(before.m1_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(before).not.toHaveProperty("igsid");

    const anonymous = await postPage(
      "/prospects/m1",
      { lead_id: "lead-old", text: "Otro texto" },
      { cookie: null },
    );
    expect(anonymous.location).toBe("/login");
    expect((await exportedThread("lead-old")).m1_sha).toBe(before.m1_sha);

    // Marking one thread's touch leaves its neighbours alone.
    await postPage("/prospects/followups", { lead_id: "lead-follow", action: "touch" });
    expect((await exportedThread("lead-old")).m1_sha).toBe(before.m1_sha);
  });
});

describe("GET /api/prospects/export", () => {
  it("carries enrolled_at and the two follow-up marks", async () => {
    const now = Date.now();
    const echoAt = now - 5 * DAY;
    await enrolledLead({ leadId: "lead-export", peerId: "peer-x", echoAt });

    // The echo's own timestamp is the anchor the days are counted from, so the
    // Sheet can tell how old the wait is without re-deriving it from messages.
    const fresh = await exportedThread("lead-export");
    expect(fresh.enrolled_at).toBe(echoAt);
    expect(fresh.touch_done_at).toBeNull();
    expect(fresh.followup_sent_at).toBeNull();
    expect(fresh.close_reason).toBeNull();

    await postPage("/prospects/followups", { lead_id: "lead-export", action: "touch" });
    const touched = await exportedThread("lead-export");
    expect(touched.enrolled_at).toBe(echoAt);
    expect(touched.touch_done_at).toBeGreaterThanOrEqual(now);
    expect(touched.followup_sent_at).toBeNull();
  });
});

describe("POST /prospects/followups", () => {
  it("«Hecho» marks the touch, hides the step and refuses a second mark", async () => {
    const now = Date.now();
    await enrolledLead({ leadId: "lead-touch", peerId: "peer-t", echoAt: now - 4 * DAY });

    const before = await exportedThread("lead-touch");
    expect(before.touch_done_at).toBeNull();
    expect(before.followup_sent_at).toBeNull();

    const response = await postPage("/prospects/followups", {
      lead_id: "lead-touch",
      action: "touch",
    });
    expect(response.status).toBe(302);
    expect(response.location).toContain("/prospects");

    const followups = section((await getPage()).html, "seguimientos");
    expect(followups).not.toContain(`@${handleFor("lead-touch")}`);

    const after = await exportedThread("lead-touch");
    expect(after.touch_done_at).toBeGreaterThanOrEqual(now);
    // A touch is not a DM: the other step stays unmarked.
    expect(after.followup_sent_at).toBeNull();

    const again = await postPage("/prospects/followups", {
      lead_id: "lead-touch",
      action: "touch",
    });
    expect(again.status).toBe(302);
    expect(decodeURIComponent(again.location ?? "")).toContain("no está en la cola");
    expect((await exportedThread("lead-touch")).touch_done_at).toBe(after.touch_done_at);
  });

  it("«Enviado» marks the follow-up DM, hides the step and sends nothing", async () => {
    const now = Date.now();
    await enrolledLead({ leadId: "lead-dm", peerId: "peer-d", echoAt: now - 8 * DAY });

    // The claim this test exists for: both steps are manual.
    const calls = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", calls);
    const messagesBefore = await exportedMessages("lead-dm");

    const response = await postPage("/prospects/followups", {
      lead_id: "lead-dm",
      action: "followup",
    });
    expect(response.status).toBe(302);
    expect(response.location).toContain("/prospects");

    const followups = section((await getPage()).html, "seguimientos");
    expect(followups).not.toContain(`@${handleFor("lead-dm")}`);
    expect(followups).not.toContain("Copiar");

    const after = await exportedThread("lead-dm");
    expect(after.followup_sent_at).toBeGreaterThanOrEqual(now);
    expect(after.touch_done_at).toBeNull();
    // Nothing was sent by the API and no message was invented in the thread.
    expect(calls).not.toHaveBeenCalled();
    expect(await exportedMessages("lead-dm")).toHaveLength(messagesBefore.length);

    const again = await postPage("/prospects/followups", {
      lead_id: "lead-dm",
      action: "followup",
    });
    expect(decodeURIComponent(again.location ?? "")).toContain("no está en la cola");
    expect((await exportedThread("lead-dm")).followup_sent_at).toBe(after.followup_sent_at);
  });

  it("refuses a mark from no session, from an unknown action, and once the lead answered", async () => {
    const now = Date.now();
    await enrolledLead({ leadId: "lead-refuse", peerId: "peer-f", echoAt: now - 4 * DAY });

    const anonymous = await postPage(
      "/prospects/followups",
      { lead_id: "lead-refuse", action: "touch" },
      { cookie: null },
    );
    expect(anonymous.status).toBe(302);
    expect(anonymous.location).toBe("/login");

    const unknown = await postPage("/prospects/followups", {
      lead_id: "lead-refuse",
      action: "teleport",
    });
    expect(unknown.status).toBe(302);
    expect(decodeURIComponent(unknown.location ?? "")).toContain("Acción desconocida");
    expect((await exportedThread("lead-refuse")).touch_done_at).toBeNull();

    await deliver(inbound({ peerId: "peer-f", text: "Ya te digo", mid: "mid_in_f", at: now }));
    const answered = await postPage("/prospects/followups", {
      lead_id: "lead-refuse",
      action: "touch",
    });
    expect(answered.status).toBe(302);
    expect(decodeURIComponent(answered.location ?? "")).toContain("no está en la cola");
    expect((await exportedThread("lead-refuse")).touch_done_at).toBeNull();
  });
});

describe("the scheduled job", () => {
  it("closes an unanswered thread at day 14 with no_reply, idempotently, and never one with an inbound", async () => {
    const now = Date.now();
    await enrolledLead({ leadId: "lead-quiet", peerId: "peer-q", echoAt: now - 15 * DAY });
    await enrolledLead({ leadId: "lead-answered", peerId: "peer-a", echoAt: now - 15 * DAY });
    await deliver(
      inbound({ peerId: "peer-a", text: "Cuéntame más", mid: "mid_in_a", at: now - 10 * DAY }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    expect((await exportedThread("lead-quiet")).state).toBe("enrolled");
    await runScheduled();

    const quiet = await exportedThread("lead-quiet");
    expect(quiet.state).toBe("closed");
    expect(quiet.close_reason).toBe("no_reply");
    // Closing is not sending: the thread still holds only its own echo.
    expect(await exportedMessages("lead-quiet")).toHaveLength(1);

    const answered = await exportedThread("lead-answered");
    expect(answered.state).toBe("enrolled");
    expect(answered.close_reason).toBeNull();

    // A second run of the same trigger changes nothing.
    await runScheduled();
    const again = await exportedThread("lead-quiet");
    expect(again.state).toBe("closed");
    expect(again.updated_at).toBe(quiet.updated_at);
  });
});
