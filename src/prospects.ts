import * as db from "./db";

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
  const sha = await prospectTextSha(event.text);
  const pending = await db.pendingM1Threads(d1, event.igUserId, sha);

  if (pending.length === 0) {
    // No id, no text: a near miss is still somebody's private message.
    console.log("prospect echo: unmatched");
    return;
  }
  if (pending.length > 1) {
    // Same copied text on two leads is not evidence of which one received it.
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
