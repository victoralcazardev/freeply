import * as db from "./db";
import type { Env } from "./index";
import {
  prospectClaimKey,
  sendProspectDraft,
  type ProspectSendOutcome,
} from "./prospects-send";

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
 * The form the exact M1 gate is compared in: NFC, one space per whitespace run,
 * trimmed.
 *
 * Case is deliberately untouched here. This path compares hashes, and two
 * messages that differ only in case are different messages there. The tolerant
 * fallback is a separate, looser form — see `looseProspectText` — and only runs
 * when this exact gate finds nothing.
 */
export function normalizeProspectText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * The form the tolerant fallback compares in: NFC, lowercase, punctuation and
 * emoji removed, whitespace collapsed.
 *
 * This is deliberately looser than `normalizeProspectText`: it only runs after
 * the exact hash found nothing, and its job is to recognise a retouched M1, not
 * to define identity. Letters and digits survive; everything else (¡ ¿ ! ? ,
 * . : ; « » " ' and emoji) disappears before either side is split into words.
 */
export function looseProspectText(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words of a text, in the loose form the tolerant fallback compares in. */
function looseWords(text: string): string[] {
  return looseProspectText(text).split(" ").filter(Boolean);
}

/** Titles that live inside a stored name and never identify the person. */
const PROSPECT_NAME_TITLES = new Set(["dr", "dra", "doctor", "doctora"]);

/**
 * The words of a lead's name a message can use to name them.
 *
 * Titles are dropped, and so is anything shorter than three letters: «de», «la»
 * and a stray initial say nothing about who this is. An empty result means the
 * stored name cannot identify anybody, which is a lead the tolerant fallback
 * must leave alone rather than match on resemblance.
 */
export function prospectNameWords(name: string | null | undefined): string[] {
  return name
    ? looseWords(name).filter(
        (word) =>
          !PROSPECT_NAME_TITLES.has(word) &&
          (word.match(/\p{L}/gu)?.length ?? 0) >= 3,
      )
    : [];
}

function wordDistance(a: readonly string[], b: readonly string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length];
}

/**
 * How close an echo is to a copied M1, on [0, 1]: one minus the word-level
 * Levenshtein distance over the longer of the two word counts.
 *
 * Word level, not character level, because the retouches are whole words
 * (`marketing` → `publicidad`); a character metric would call unrelated short
 * messages similar. Two texts with no words at all score 0.
 */
export function prospectTextSimilarity(echo: string, copied: string): number {
  const a = looseWords(echo);
  const b = looseWords(copied);
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return 1 - wordDistance(a, b) / longest;
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
 *
 * Each event stands on its own: a write that errors on one of them must not take
 * the rest of the delivery with it, or one D1 hiccup silently loses every
 * message that arrived after it. The failure is a count and nothing else — the
 * event that broke is still somebody's private message, and the error's own
 * message quotes the value that broke it.
 */
export async function handleProspectEvents(
  events: readonly ProspectEvent[],
  env: Env,
): Promise<void> {
  let failed = 0;

  for (const event of events) {
    try {
      if (event.echo) await handleEcho(event, env);
      else await handleInbound(event, env.DB);
    } catch {
      failed += 1;
    }
  }

  if (failed > 0) console.log(`prospect webhook: failed=${failed}`);
}

async function handleEcho(event: ProspectEvent, env: Env): Promise<void> {
  const d1 = env.DB;

  // An echo carrying a mid we stored for an API send is our own message coming
  // back: already recorded, never an owner message, and never evidence of who
  // should be enrolled. Without this, a reply whose text happened to match
  // another lead's copied M1 would register that lead with the wrong peer.
  if (await db.prospectMessageExists(d1, event.mid)) return;

  // An echo on a thread already enrolled is the account talking to that lead:
  // the only way a message written by hand is ever visible here. Every other
  // echo — an unregistered peer, a friend — is dropped in memory below, with no
  // write and no log carrying content (S11).
  const known = await db.enrolledThreadByIgsid(d1, event.igUserId, event.peerId);
  if (known) {
    const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(known.igUserId));

    // The one echo that looks exactly like this and is not an owner message: the
    // copy of our own API send, delivered before the Durable Object recorded the
    // `message_id` it got back. T7 records it a moment later, so nothing is
    // written now — the alternative is a duplicate message row and a version
    // bump that invalidates drafts over a send nobody read.
    if (await echoIsOurSend(d1, account, known, event.text)) {
      console.log("prospect echo: in flight");
      return;
    }

    // Read before the write: recording the owner message retires these in the
    // same transaction, and their queued retries have to go with them.
    const pendingDrafts = await db.pendingProspectDraftIds(d1, known.leadId);
    const stored = await db.recordProspectOwnerMessage(d1, {
      leadId: known.leadId,
      igUserId: known.igUserId,
      igsid: event.peerId,
      mid: event.mid,
      text: event.text,
      sentAt: event.timestamp,
    });
    // A draft retired by this message must not keep a retry in the outbox: the
    // alarm would keep coming back for a send that can no longer be right. Only
    // the delivery that recorded the message may drop those rows — a redelivery
    // would otherwise cancel a draft written after it, whose claim would then
    // keep it stuck in the queue.
    if (stored && pendingDrafts.length > 0) await account.forgetDrafts(pendingDrafts);
    console.log("prospect echo: owner");
    return;
  }

  const sha = await prospectTextSha(event.text);
  const pending = await db.pendingM1Threads(d1, event.igUserId, sha);

  if (pending.length === 0) {
    // The exact hash is identity. Only when it finds nothing does a retouched
    // copy get a chance, and that fallback still refuses to guess.
    const thread = await tolerantM1Match(d1, event.igUserId, event.text);
    if (!thread) {
      // No id, no text: a near miss is still somebody's private message.
      console.log("prospect echo: unmatched");
      return;
    }
    await enrollM1Echo(d1, thread, event);
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

  await enrollM1Echo(d1, pending[0], event);
}

/** The smallest similarity that may enroll, and the lead it needs over second. */
const TOLERANT_M1_MIN_SIMILARITY = 0.8;
const TOLERANT_M1_MIN_MARGIN = 0.2;
/** Ratios land on a threshold as e.g. 0.19999999999999996; include those. */
const TOLERANT_EPSILON = 1e-9;
/**
 * A word-count ratio below the floor cannot reach it, so those candidates are
 * skipped before any distance is computed.
 */
const TOLERANT_M1_MIN_LENGTH_RATIO = TOLERANT_M1_MIN_SIMILARITY;
/**
 * Past this many comparable leads, resembling the M1 stops being evidence: the
 * operator could have sent it to any of them. The Worker gives up instead of
 * spending CPU on a guess.
 */
const TOLERANT_M1_MAX_CANDIDATES = 20;

/**
 * The one pending thread whose copied M1 is close enough to this echo, or null.
 *
 * Only reached when the exact hash found nothing, so this is a fallback for a
 * retouched M1 — never a replacement for identity. It fails closed several
 * ways: the echo must say the lead's name, a thread that cannot be compared
 * blocks the whole read, too many candidates is no answer at all, and the best
 * must clear the similarity floor and beat the runner-up by a wide margin,
 * because two close leads mean the echo could belong to either and a guess
 * would enroll the wrong person. Callers log a content-free unmatched line on
 * null; nothing here writes, marks, or logs.
 */
async function tolerantM1Match(
  d1: D1Database,
  igUserId: string,
  echo: string,
): Promise<db.PendingM1Candidate | null> {
  const candidates = await db.pendingM1Candidates(d1, igUserId);
  const echoWords = looseWords(echo);
  const echoed = new Set(echoWords);
  const comparable: { thread: db.PendingM1Candidate; copied: string }[] = [];
  let second = 0;

  for (const thread of candidates) {
    const copied = thread.m1CopiedText;
    // A thread armed before the text was stored has nothing to compare, and
    // nothing rules it out as the lead this echo belongs to. Enrolling a
    // different one would be a guess about identity, so the fallback declines.
    if (copied === null) return null;

    // The name is what turns resemblance into a match: the same template with
    // somebody else's name is a message to that somebody else, and similarity
    // alone would enroll this lead for it. A lead with no usable name cannot
    // be identified this way at all.
    if (!prospectNameWords(thread.name).some((word) => echoed.has(word))) continue;

    // The distance is at least the length difference, so a candidate this far
    // off cannot reach the floor and is skipped without a comparison.
    const copiedWords = looseWords(copied).length;
    const longest = Math.max(copiedWords, echoWords.length);
    const ratio = longest === 0 ? 0 : Math.min(copiedWords, echoWords.length) / longest;
    if (ratio < TOLERANT_M1_MIN_LENGTH_RATIO) {
      // Its own bound still counts as a runner-up: a lead this close could be
      // the second one the margin exists to rule out, and pretending it was
      // never there would enroll where the full comparison would have refused.
      second = Math.max(second, ratio);
      continue;
    }

    if (comparable.length >= TOLERANT_M1_MAX_CANDIDATES) return null;
    comparable.push({ thread, copied });
  }

  let best: { thread: db.PendingM1Candidate; similarity: number } | null = null;
  for (const candidate of comparable) {
    const similarity = prospectTextSimilarity(echo, candidate.copied);
    if (!best || similarity > best.similarity) {
      second = Math.max(second, best?.similarity ?? 0);
      best = { thread: candidate.thread, similarity };
    } else {
      second = Math.max(second, similarity);
    }
  }

  if (!best) return null;
  if (best.similarity + TOLERANT_EPSILON < TOLERANT_M1_MIN_SIMILARITY) return null;
  if (best.similarity - second + TOLERANT_EPSILON < TOLERANT_M1_MIN_MARGIN) return null;
  return best.thread;
}

/** Records the M1 echo against the matched pending thread, once. */
async function enrollM1Echo(
  d1: D1Database,
  thread: { leadId: string; igUserId: string; version: number },
  event: ProspectEvent,
): Promise<void> {
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

/**
 * Closes the threads that went fourteen days without a word (T19).
 *
 * Runs on the scheduled trigger and is idempotent by state, so a second run in
 * the same hour writes nothing. Dropping the queued retries is the same work the
 * page's manual close does: a draft retired by the close must not keep an alarm
 * waking up for a send that can never be right. The log is a count: a closed
 * thread's handle is not something the Worker's logs carry.
 */
export async function closeUnansweredProspects(
  env: Env,
  now = Date.now(),
): Promise<number> {
  const closed = await db.closeUnansweredProspectThreads(env.DB, now);

  for (const thread of closed) {
    if (thread.draftIds.length === 0) continue;
    const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(thread.igUserId));
    await account.forgetDrafts(thread.draftIds);
  }

  if (closed.length > 0) console.log(`prospect followup: closed=${closed.length}`);
  return closed.length;
}

/**
 * Whether this echo is the copy of a send we already made, whose `mid` has not
 * reached D1 yet.
 *
 * Meta can deliver the echo before the API response reaches the Durable Object,
 * so "unknown mid on an enrolled thread" is momentarily ambiguous. The evidence
 * is that a request of ours may actually have reached Meta: a claimed draft
 * whose request is executing or awaiting its response, or one already recorded.
 * A claim held for a retry queued behind a definitive refusal is *not* evidence
 * — Meta answered that one with an error — so a hand-written message that
 * happens to match the queued text stays the operator's. Nothing here decides a
 * send; it only keeps the owner path from claiming one that already happened.
 */
async function echoIsOurSend(
  d1: D1Database,
  account: ReturnType<Env["ACCOUNT"]["get"]>,
  thread: db.ProspectThread,
  text: string,
): Promise<boolean> {
  const inFlight = await account.prospectSendsInFlight(prospectClaimKey(thread.leadId));
  if (inFlight.length === 0) return false;

  const echo = normalizeProspectText(text);
  for (const draftId of inFlight) {
    const draft = await db.getProspectDraft(d1, draftId);
    if (!draft || draft.leadId !== thread.leadId) continue;

    // An approval sends `decided_text`; an authorized draft sends its own text.
    const sent = (draft.decidedText ?? "").trim() || draft.text;
    if (normalizeProspectText(sent) === echo) return true;
  }

  return false;
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
  // Closed is the stronger answer: the thread may also have enrolled before a
  // person closed it, and "thread_closed" is what says it can never be armed.
  if (thread.state === "closed") return { ok: false, error: "thread_closed" };
  if (thread.igsid !== null) return { ok: false, error: "already_enrolled" };

  // The echo is compared in normalized form, so the hash comes from that form.
  if (
    !(await db.registerProspectM1(d1, {
      leadId,
      m1Sha: await prospectTextSha(text),
      text,
    }))
  ) {
    // The echo can land between the read above and this write.
    return { ok: false, error: "already_enrolled" };
  }

  const updated = await db.getProspectThread(d1, leadId);
  if (!updated) return { ok: false, error: "not_found" };
  return { ok: true, thread: updated };
}

/**
 * Closes a thread by hand (L62), shared by the JSON API and the page's button.
 *
 * The database write is one helper so both routes have the same rules about
 * open states, idempotence and a different reason. The outbox cleanup lives here
 * because it needs the account's Durable Object: a retry queued before the close
 * must not keep waking up for a draft that can no longer be sent.
 */
export async function closeProspectThread(
  env: Env,
  c: { leadId: string; reason: db.ProspectCloseReason; now?: number },
): Promise<db.ProspectCloseOutcome> {
  const pending = await db.pendingProspectDraftIds(env.DB, c.leadId);
  const result = await db.closeProspectThread(env.DB, c);
  if (!result.ok) return result;

  if (pending.length > 0) {
    const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(result.thread.igUserId));
    await account.forgetDrafts(pending);
  }
  return result;
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
