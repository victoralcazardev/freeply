import * as db from "./db";
import type { Env } from "./index";
import { sendProspectDraft, type ProspectSendOutcome } from "./prospects-send";

/**
 * What the M1 echo and the lead's replies have in common, and nothing else.
 *
 * `peerId` is the counterpart as Meta names it: `recipient.id` on an echo and
 * `sender.id` on an inbound message. It is never inferred from a handle.
 */
export interface ProspectEvent {
  /** The account that received the event — `entry.id`, not the peer. */
  igUserId: string;
  peerId: string;
  mid: string;
  text: string;
  timestamp: number;
  echo: boolean;
}

interface ProspectWebhookPayload {
  entry?: Array<{
    id: string;
    messaging?: Array<{
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      is_echo?: boolean;
      message?: {
        mid?: string;
        text?: string;
        is_echo?: boolean;
        reply_to?: { story?: { id?: string } };
      };
    }>;
  }>;
}

/**
 * The form the M1 is compared in: NFC, one space per whitespace run, trimmed.
 *
 * Case is deliberately untouched. Two messages that differ only in case are
 * different messages, and the enrollment gate does not get to decide otherwise.
 */
export function normalizeProspectText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The exact value stored in `prospect_threads.m1_sha` when the operator copies. */
export function prospectTextSha(text: string): Promise<string> {
  return sha256Hex(normalizeProspectText(text));
}

/**
 * Prospect candidates out of a `messages` delivery.
 *
 * This parser does not decide whether a peer is enrolled; it only lifts what
 * the event says. The handler then compares the peer id against enrolled threads
 * in memory and drops everything else before any write or log.
 *
 * Story replies are excluded here because they already have a path of their own.
 * A reply to a story is not someone opening a conversation, and must not become
 * a prospect message by resemblance.
 */
export function extractProspectEvents(payload: ProspectWebhookPayload): ProspectEvent[] {
  const events: ProspectEvent[] = [];

  for (const entry of payload.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      if (m.message?.reply_to?.story) continue;

      const mid = m.message?.mid;
      if (!mid) continue;

      // Meta has put is_echo on both the envelope and the message; either one
      // means this is the account's own outgoing message coming back.
      const echo = Boolean(m.is_echo || m.message?.is_echo);
      const peerId = echo ? m.recipient?.id : m.sender?.id;
      if (!peerId) continue;
      // An ordinary event from the account itself is not a counterpart. Echoes
      // are how our own messages arrive, and they carry the peer in recipient.id.
      if (!echo && peerId === entry.id) continue;

      events.push({
        igUserId: entry.id,
        peerId,
        mid,
        text: m.message?.text ?? "",
        timestamp: m.timestamp ?? Date.now(),
        echo,
      });
    }
  }

  return events;
}

/**
 * Applies one delivery's prospect events, in order.
 *
 * Enrollment fails closed: an echo enrolls only when its normalized text hash
 * matches exactly one pending M1 for that account. Zero or several matches write
 * nothing, and the only log is a content-free counter — never the text, the
 * sender, or a lead id. An inbound message from anyone not already enrolled is
 * compared and dropped in memory, with no row and no log.
 */
export async function handleProspectEvents(
  events: readonly ProspectEvent[],
  d1: D1Database,
): Promise<void> {
  for (const event of events) {
    if (event.echo) await handleEcho(event, d1);
    else await handleInbound(event, d1);
  }
}

async function handleEcho(event: ProspectEvent, d1: D1Database): Promise<void> {
  // An echo carrying a mid we stored for an API send is our own message coming
  // back: already recorded, never an owner message, and never evidence of who
  // should be enrolled. Without this, a reply whose text happened to match
  // another lead's copied M1 would register that lead with the wrong peer.
  // T8 adds the other half — an unknown mid on an enrolled thread is the
  // operator writing from his phone.
  if (await db.prospectMessageExists(d1, event.mid)) return;

  const sha = await prospectTextSha(event.text);
  const pending = await db.pendingM1Threads(d1, event.igUserId, sha);

  if (pending.length === 0) {
    // No id, no text: a near miss is still somebody's private message.
    console.log("prospect echo: unmatched");
    return;
  }
  if (pending.length > 1) {
    // Same copied text on two leads is not evidence of which one received it.
    // Neither enrolls, and both are handed back for a retry with a text only one
    // of them will receive.
    await db.markAmbiguousM1Threads(d1, event.igUserId, sha);
    console.log(`prospect echo: ambiguous pending=${pending.length}`);
    return;
  }

  const thread = pending[0];
  const enrolled = await db.enrollProspectThread(d1, {
    leadId: thread.leadId,
    igUserId: thread.igUserId,
    igsid: event.peerId,
    mid: event.mid,
    text: event.text,
    sentAt: event.timestamp,
    expectedVersion: thread.version,
  });

  if (enrolled) console.log("prospect echo: enrolled");
}

/** Why registering an M1 failed, as both the API and the page report it. */
export type M1Registration =
  | { ok: true; thread: db.ProspectThreadDetail }
  | { ok: false; error: "not_found" | "already_enrolled" | "thread_closed" };

/**
 * Records the text whose exact echo enrolls a thread — what "copiar" on the
 * mobile page does, and what `POST /api/prospects/expected-m1` does.
 *
 * The page and the API share this so there is one place that decides what may be
 * registered and one writer for `m1_sha`. It fails closed: an enrolled or closed
 * thread is refused rather than left holding a hash that could never match.
 */
export async function registerExpectedM1(
  d1: D1Database,
  leadId: string,
  text: string,
): Promise<M1Registration> {
  const thread = await db.getProspectThread(d1, leadId);
  if (!thread) return { ok: false, error: "not_found" };
  if (thread.igsid !== null) return { ok: false, error: "already_enrolled" };
  if (thread.state === "closed") return { ok: false, error: "thread_closed" };

  // The echo is compared in normalized form, so the hash comes from that form.
  if (!(await db.registerProspectM1(d1, { leadId, m1Sha: await prospectTextSha(text) }))) {
    // The echo can land between the read above and this write.
    return { ok: false, error: "already_enrolled" };
  }

  const updated = await db.getProspectThread(d1, leadId);
  if (!updated) return { ok: false, error: "not_found" };
  return { ok: true, thread: updated };
}

/** Why approving a draft failed, as the page reports it. */
export type DraftApproval =
  | { ok: true; send: ProspectSendOutcome }
  | {
      ok: false;
      error: "not_found" | "not_waiting" | "not_a_reply" | "empty_text";
    };

/**
 * Records the operator's approval of a reply draft — the OK that used to be a
 * Telegram message — and sends it in the same request.
 *
 * The approved text is stored in `decided_text`, which is also what the
 * graduation count reads: a draft sent as written graduates its stage, an edited
 * one does not. That write is check 4's evidence: the send path finds an
 * `approved` draft carrying this exact text, and re-reads it before every
 * attempt. A draft that never passed through here needs a current autopilot
 * authorization instead, and has none until the CLI writes one.
 */
export async function approveProspectDraft(
  env: Env,
  d: { draftId: string; text: string; now?: number },
): Promise<DraftApproval> {
  const draft = await db.getProspectDraft(env.DB, d.draftId);
  if (!draft) return { ok: false, error: "not_found" };
  if (draft.kind !== "reply") return { ok: false, error: "not_a_reply" };
  if (draft.status !== "waiting") return { ok: false, error: "not_waiting" };

  const decidedText = d.text.trim();
  if (!decidedText) return { ok: false, error: "empty_text" };

  const now = d.now ?? Date.now();
  const decided = await db.decideProspectDraft(env.DB, {
    draftId: d.draftId,
    from: ["waiting"],
    status: "approved",
    decidedText,
    decidedAt: now,
  });
  // Somebody else decided it between the read and this write.
  if (!decided) return { ok: false, error: "not_waiting" };

  const send = await sendProspectDraft(env, {
    draftId: d.draftId,
    leadId: draft.leadId,
    text: decidedText,
  });
  return { ok: true, send };
}

async function handleInbound(event: ProspectEvent, d1: D1Database): Promise<void> {
  // This comparison is the entire privacy boundary (S11): an id that is not in
  // an enrolled thread is discarded here, before storage, logging, or any lookup.
  const thread = await db.enrolledThreadByIgsid(d1, event.igUserId, event.peerId);
  if (!thread) return;

  await db.recordProspectInbound(d1, {
    leadId: thread.leadId,
    igUserId: thread.igUserId,
    igsid: event.peerId,
    mid: event.mid,
    text: event.text,
    sentAt: event.timestamp,
  });
}
