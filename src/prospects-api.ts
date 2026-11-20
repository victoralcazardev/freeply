import { fail, invalid, json, jsonBody, limitParam } from "./api";
import * as db from "./db";
import type { Env } from "./index";
import { registerExpectedM1 } from "./prospects";

/**
 * The prospect API the Pi-side CLI and the mobile page talk to.
 *
 * Same guard as the rest of `/api`: no `API_TOKEN` means these routes do not
 * exist. Nothing here searches conversations — every read is keyed by the
 * `lead_id` the operator registered, so an unregistered thread has no address
 * through which it could be reached.
 *
 * `igsid` never leaves: it is how the webhook recognises a lead, and no client
 * needs to name a peer by the id Meta gave them.
 */

/** Instagram caps a DM at 1000 characters; bytes leave room for accents. */
const MAX_TEXT_BYTES = 4000;
const MAX_ID_BYTES = 200;
const MAX_LABEL_BYTES = 500;

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** A required, trimmed, non-empty string within a byte cap. */
function required(
  value: unknown,
  field: string,
  max = MAX_ID_BYTES,
): string | Response {
  if (typeof value !== "string") return invalid(field, "must be a string");
  const trimmed = value.trim();
  if (!trimmed) return invalid(field, "must be non-empty");
  if (bytes(trimmed) > max) return invalid(field, `over ${max} bytes`);
  return trimmed;
}

/** An optional Sheet label: null and "" both mean "not set". */
function label(value: unknown, field: string): string | null | Response {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return invalid(field, "must be a string or null");
  const trimmed = value.trim();
  if (bytes(trimmed) > MAX_LABEL_BYTES) return invalid(field, `over ${MAX_LABEL_BYTES} bytes`);
  return trimmed || null;
}

/**
 * The handle as Instagram writes it, without the `@` people paste from the app.
 *
 * The charset is Instagram's, so a malformed row fails here rather than becoming
 * an `ig.me/m/<handle>` link that opens nothing.
 */
function instagramHandle(value: unknown): string | Response {
  if (typeof value !== "string") return invalid("handle", "must be a string");
  const handle = value.trim().replace(/^@+/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(handle)) return invalid("handle", "must be an Instagram handle");
  return handle;
}

function integer(value: unknown, field: string, min: number): number | Response {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    return invalid(field, `must be an integer >= ${min}`);
  }
  return value;
}

/**
 * The account a new thread belongs to. One connected account is the normal case
 * (`@victoralcazar`); with several, the caller has to say which.
 */
async function accountFor(env: Env, requested: unknown): Promise<string | Response> {
  const accounts = await db.listAccounts(env.DB);

  if (requested !== undefined) {
    const id = required(requested, "ig_user_id");
    if (id instanceof Response) return id;
    if (!accounts.some((a) => a.igUserId === id)) {
      return invalid("ig_user_id", "not a connected account");
    }
    return id;
  }

  if (accounts.length === 0) return fail(409, "no_account", "connect an Instagram account first");
  if (accounts.length > 1) {
    return invalid("ig_user_id", "required when several accounts are connected");
  }
  return accounts[0].igUserId;
}

function presentThread(t: db.ProspectThreadDetail) {
  return {
    lead_id: t.leadId,
    ig_user_id: t.igUserId,
    handle: t.handle,
    name: t.name,
    nicho: t.nicho,
    state: t.state,
    m1_sha: t.m1Sha,
    m1_registered_at: t.m1RegisteredAt,
    version: t.version,
    last_inbound_at: t.lastInboundAt,
    last_outbound_at: t.lastOutboundAt,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

function presentDraft(d: db.ProspectDraft) {
  return {
    draft_id: d.draftId,
    lead_id: d.leadId,
    kind: d.kind,
    stage: d.stage,
    text: d.text,
    base_version: d.baseVersion,
    status: d.status,
    decided_at: d.decidedAt,
    decided_text: d.decidedText,
    created_at: d.createdAt,
  };
}

/** Only what the board and the session summary read — no message text. */
function presentMessageMeta(m: db.ProspectMessage) {
  return {
    mid: m.mid,
    lead_id: m.leadId,
    direction: m.direction,
    origin: m.origin,
    sent_at: m.sentAt,
    drafted_at: m.draftedAt,
    answered_at: m.answeredAt,
  };
}

export async function handleProspectsApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const { method } = request;
  const path = url.pathname;

  if (path === "/api/prospects/threads" && method === "POST") return createThread(request, env);
  if (path === "/api/prospects/expected-m1" && method === "POST") return registerM1(request, env);
  if (path === "/api/prospects/drafts" && method === "POST") return createDraft(request, env);
  if (path === "/api/prospects/work" && method === "GET") return work(env, url);
  if (path === "/api/prospects/authorizations" && method === "POST") {
    return authorize(request, env);
  }
  if (path === "/api/prospects/export" && method === "GET") return exportState(env, url);

  return fail(404, "not_found");
}

/**
 * Create or refresh a thread from the Sheet: the columns the operator's team
 * owns, plus the optional final M1 text. The text goes through the same helper
 * `expected-m1` uses, so there is one writer for `m1_sha` and one gate: nothing
 * enrolls until that exact text comes back as an echo.
 */
async function createThread(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);
  if (body instanceof Response) return body;

  const leadId = required(body.lead_id, "lead_id");
  if (leadId instanceof Response) return leadId;
  const handle = instagramHandle(body.handle);
  if (handle instanceof Response) return handle;
  const m1Text =
    body.m1_text === undefined ? null : required(body.m1_text, "m1_text", MAX_TEXT_BYTES);
  if (m1Text instanceof Response) return m1Text;

  const existing = await db.getProspectThread(env.DB, leadId);
  // A thread is pinned to the account that will receive its echo; re-pointing it
  // would detach it from the webhook that recognises it.
  const igUserId =
    existing && body.ig_user_id === undefined
      ? existing.igUserId
      : await accountFor(env, body.ig_user_id);
  if (igUserId instanceof Response) return igUserId;
  if (existing && existing.igUserId !== igUserId) {
    return fail(409, "account_mismatch", "lead_id: thread belongs to another account");
  }

  if (m1Text !== null && existing) {
    // Re-arming an enrolled or closed thread is not a refresh; say so instead of
    // storing an M1 that could never enroll.
    if (existing.igsid !== null) return fail(409, "already_enrolled");
    if (existing.state === "closed") return fail(409, "thread_closed");
  }

  const name = body.name === undefined ? (existing?.name ?? null) : label(body.name, "name");
  if (name instanceof Response) return name;
  const nicho = body.nicho === undefined ? (existing?.nicho ?? null) : label(body.nicho, "nicho");
  if (nicho instanceof Response) return nicho;

  const thread = await db.upsertProspectThread(env.DB, { leadId, igUserId, handle, name, nicho });
  const status = existing ? 200 : 201;

  if (m1Text === null) return json({ thread: presentThread(thread) }, status);
  // Same registration the page's "copiar" performs, so there is one writer for
  // `m1_sha` and one set of rules about what may be armed.
  const registered = await registerExpectedM1(env.DB, leadId, m1Text);
  if (!registered.ok) {
    return fail(registered.error === "not_found" ? 404 : 409, registered.error);
  }
  return json({ thread: presentThread(registered.thread) }, status);
}

/**
 * Registers the text the operator copied. The echo of that exact text is the
 * only thing that enrolls the thread, so this is the last moment the pairing can
 * be made — and re-registering is how a failed M1 is retried.
 *
 * The rules live in `registerExpectedM1`, shared with the mobile page's copy
 * button; this handler only decides the status code.
 */
async function registerM1(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);
  if (body instanceof Response) return body;

  const leadId = required(body.lead_id, "lead_id");
  if (leadId instanceof Response) return leadId;
  const text = required(body.text, "text", MAX_TEXT_BYTES);
  if (text instanceof Response) return text;

  const result = await registerExpectedM1(env.DB, leadId, text);
  if (!result.ok) return fail(result.error === "not_found" ? 404 : 409, result.error);
  return json({ thread: presentThread(result.thread) });
}

/** The same draft_id is a retry, not a second draft. */
function sameDraft(stored: db.ProspectDraft, pushed: db.ProspectDraft): boolean {
  return (
    stored.leadId === pushed.leadId &&
    stored.kind === pushed.kind &&
    stored.stage === pushed.stage &&
    stored.text === pushed.text &&
    stored.baseVersion === pushed.baseVersion
  );
}

async function createDraft(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);
  if (body instanceof Response) return body;

  const draftId = required(body.draft_id, "draft_id");
  if (draftId instanceof Response) return draftId;
  const leadId = required(body.lead_id, "lead_id");
  if (leadId instanceof Response) return leadId;
  const kind = body.kind === "m1" || body.kind === "reply" ? body.kind : null;
  if (!kind) return invalid("kind", "must be m1 or reply");
  const text = required(body.text, "text", MAX_TEXT_BYTES);
  if (text instanceof Response) return text;
  const baseVersion = integer(body.base_version, "base_version", 0);
  if (baseVersion instanceof Response) return baseVersion;
  const stage = label(body.stage, "stage");
  if (stage instanceof Response) return stage;

  const thread = await db.getProspectThread(env.DB, leadId);
  if (!thread) return fail(404, "not_found");
  if (thread.state === "closed") return fail(409, "thread_closed");
  // A draft cannot answer more than the conversation has said so far.
  if (baseVersion > thread.version) {
    return invalid("base_version", "newer than the conversation version");
  }

  const pushed: db.ProspectDraft = {
    draftId,
    leadId,
    kind,
    stage,
    text,
    baseVersion,
    status: "waiting",
    decidedAt: null,
    decidedText: null,
    createdAt: Date.now(),
  };
  const created = await db.insertProspectDraft(env.DB, pushed);
  const stored = await db.getProspectDraft(env.DB, draftId);
  if (!stored) return fail(404, "not_found");
  // A retry may arrive after the draft moved on; a changed payload is a bug in
  // the caller, and silently keeping either version would hide it.
  if (!created && !sameDraft(stored, pushed)) {
    return fail(409, "draft_conflict", "draft_id: already stored with different content");
  }

  return json({ draft: presentDraft(stored), created }, created ? 201 : 200);
}

/**
 * What to work on: one item per enrolled thread whose latest message is the
 * lead's, oldest wait first.
 *
 * The age is measured from that message because the 24 h window Meta allows
 * runs from the lead's latest one. A thread with a draft for its current version
 * is not here — the CLI already did that one.
 */
async function work(env: Env, url: URL): Promise<Response> {
  const limit = limitParam(url, 100, 50);
  if (limit === null) return invalid("limit", "must be an integer from 1 to 100");

  const now = Date.now();
  const items = await db.prospectWork(env.DB, limit);

  return json({
    work: items.map((item) => ({
      lead_id: item.thread.leadId,
      ig_user_id: item.thread.igUserId,
      handle: item.thread.handle,
      name: item.thread.name,
      nicho: item.thread.nicho,
      version: item.thread.version,
      last_inbound_at: item.thread.lastInboundAt,
      // Twenty hours is the warning line: a person still has time to answer by
      // the API. Past twenty-four the wall is shut, and the session summary has
      // to say "manually" rather than "soon". Both are derived from the age of
      // the lead's message, which is what the window runs on.
      expiring: now - item.inbound.sentAt >= db.WINDOW_WARNING_MS,
      expired: now - item.inbound.sentAt > db.MESSAGE_WINDOW_MS,
      inbound: {
        mid: item.inbound.mid,
        text: item.inbound.text,
        sent_at: item.inbound.sentAt,
        age_seconds: Math.max(0, Math.floor((now - item.inbound.sentAt) / 1000)),
      },
      messages: item.messages.map((m) => ({
        mid: m.mid,
        direction: m.direction,
        origin: m.origin,
        text: m.text,
        sent_at: m.sentAt,
      })),
    })),
  });
}

/**
 * The CLI's autopilot gate result for one draft. The Worker reads the row before
 * sending and refuses without a current one; an empty `gate_reason` means the
 * gate passed.
 */
async function authorize(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);
  if (body instanceof Response) return body;

  const draftId = required(body.draft_id, "draft_id");
  if (draftId instanceof Response) return draftId;
  const category = required(body.category, "category");
  if (category instanceof Response) return category;

  if (body.gate_reason !== undefined && typeof body.gate_reason !== "string") {
    return invalid("gate_reason", "must be a string");
  }
  const gateReason = (body.gate_reason ?? "").trim();

  const expiresAt = integer(body.expires_at, "expires_at", 0);
  if (expiresAt instanceof Response) return expiresAt;
  if (expiresAt <= Date.now()) return invalid("expires_at", "must be in the future");

  if (!(await db.getProspectDraft(env.DB, draftId))) return fail(404, "not_found");

  const createdAt = Date.now();
  await db.insertProspectAuthorization(env.DB, {
    draftId,
    category,
    gateReason,
    expiresAt,
    createdAt,
  });

  return json(
    {
      authorization: {
        draft_id: draftId,
        category,
        gate_reason: gateReason,
        expires_at: expiresAt,
        created_at: createdAt,
      },
    },
    201,
  );
}

function sinceParam(url: URL): number | Response {
  const raw = url.searchParams.get("since");
  if (raw === null || raw === "") return 0;
  const since = Number(raw);
  if (!Number.isInteger(since) || since < 0) {
    return invalid("since", "must be an epoch-millisecond integer");
  }
  return since;
}

/**
 * State for the Sheet sync and the session summary.
 *
 * `since` narrows which threads are returned; each one comes complete, because a
 * poll still has to warn about a wait that started before it.
 */
async function exportState(env: Env, url: URL): Promise<Response> {
  const since = sinceParam(url);
  if (since instanceof Response) return since;

  const { threads, messages, drafts } = await db.prospectExport(env.DB, since);
  return json({
    threads: threads.map(presentThread),
    messages: messages.map(presentMessageMeta),
    drafts: drafts.map(presentDraft),
  });
}
