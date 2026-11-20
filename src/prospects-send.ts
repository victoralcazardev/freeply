import type { SendJob } from "./account-do";
import * as db from "./db";
import type { Env } from "./index";

/**
 * Sending a reply into an enrolled prospect conversation (S5, S6).
 *
 * The page approves and the Worker sends, in the same request; the cron will do
 * the same for a draft the CLI authorized (T8). Either way the message leaves
 * through the account's `AccountDO`, which already owns the claim, the backoff
 * and `classify`, so there is one send path with one retry policy.
 *
 * Five checks run inside the Worker immediately before *every* attempt — the
 * first and each retry — because time passes between them and each one can make
 * a draft wrong: the thread can close, the window can shut, the lead can write
 * again, the authorization can expire, or the same draft can have gone out. Each
 * refusal has its own stable code so the page can say which one it was.
 */

/**
 * The autopilot kill switch (S6).
 *
 * Only the exact literal `on` means yes. Unset, `off` and anything else — a
 * padded `" on"`, a `true`, a UI toggle that wrote `On` — all mean no, because
 * this is the one decision that lets a message reach a person with nobody in the
 * loop. Both the cron and the account's Durable Object read it through here, so
 * there is one answer to what counts as autonomy.
 */
export function prospectAutopilotOn(env: { PROSPECT_AUTOPILOT?: string }): boolean {
  return env.PROSPECT_AUTOPILOT === "on";
}

/** The outbox's campaign id for prospect sends; the row is not a real campaign. */
export const PROSPECT_CAMPAIGN_ID = "prospect";

/** Why a prospect reply may not be sent. The strings are contract, not copy. */
export type ProspectBlockCode =
  | "not_registered"
  | "window_closed"
  | "version_changed"
  | "no_approval"
  | "already_sent";

const PROSPECT_BLOCK_CODES: readonly ProspectBlockCode[] = [
  "not_registered",
  "window_closed",
  "version_changed",
  "no_approval",
  "already_sent",
];

/**
 * What became of an approval.
 *
 * `queued` is the only outcome that leaves work behind: Meta answered with
 * something that clears on its own, so the outbox owns it from here. Everything
 * else is final for this request, and `send_state_unknown` is the one that must
 * never be retried automatically — the request may have reached Meta.
 */
export type ProspectSendOutcome =
  | { status: "sent" }
  | { status: "queued" }
  | { status: "send_state_unknown" }
  | { status: "failed" }
  | { status: "blocked"; code: ProspectBlockCode };

/** Which draft, on whose account — everything the checks need to find the rows. */
export interface ProspectSendTarget {
  draftId: string;
  leadId: string;
  igUserId: string;
}

export type ProspectCheck =
  | {
      ok: true;
      /** The peer id from the M1 echo. The only address a reply may use. */
      recipientId: string;
      text: string;
      /** The lead's message this reply answers. */
      inboundMid: string;
      /**
       * The permission is an autopilot authorization, not a person's approval.
       * The send path uses this to require the switch on every attempt, and the
       * Durable Object reads it again for each retry the alarm makes.
       */
      autopilot: boolean;
    }
  | { ok: false; code: ProspectBlockCode };

/**
 * The five checks of § Transporte.
 *
 * Reads only: the checks never write, so a refusal is free to retry later. The
 * one status a caller does write on refusal is the draft's (`blockProspectSend`),
 * because "no se envía y el borrador queda con su motivo".
 *
 * The order decides which code gets reported if several of them are true — every
 * one of them blocks the send either way. Dedupe runs early among the state
 * checks because "this exact draft already went out" is what explains the state
 * the others would otherwise misreport: our own sent message leaves the lead no
 * longer the last speaker (check 2) and moves the version the draft was written
 * against (check 3), so reporting either of those would send the operator to the
 * manual queue for a reply that is already in the thread.
 */
export async function checkProspectSend(
  d1: D1Database,
  t: ProspectSendTarget,
  now = Date.now(),
): Promise<ProspectCheck> {
  // 1. The thread is still enrolled and holds the peer id the echo gave us.
  //    A draft whose thread is gone cascades away with it, so a missing row
  //    reads the same: this conversation is not registered for the API.
  const draft = await db.getProspectDraft(d1, t.draftId);
  if (!draft || draft.leadId !== t.leadId) return { ok: false, code: "not_registered" };

  const thread = await db.getProspectThread(d1, t.leadId);
  if (
    !thread ||
    thread.igUserId !== t.igUserId ||
    thread.state !== "enrolled" ||
    thread.igsid === null
  ) {
    return { ok: false, code: "not_registered" };
  }

  // 5. This draft never spends a second message. The key is the draft id, and
  //    `(lead_id, idem)` is unique in D1 — the claim in the DO is the other half.
  if (await db.prospectMessageByIdem(d1, t.leadId, draft.draftId)) {
    return { ok: false, code: "already_sent" };
  }

  // 3. Nothing was said in either direction since the draft was written.
  if (thread.version !== draft.baseVersion) return { ok: false, code: "version_changed" };

  // 2. The lead's last message is inside the 24 h window, and it is the last
  //    word: answering our own message is not a reply, and Meta refuses both.
  const latest = await db.latestProspectMessage(d1, t.leadId);
  if (
    latest === null ||
    latest.direction !== "in" ||
    now - latest.sentAt > db.MESSAGE_WINDOW_MS
  ) {
    return { ok: false, code: "window_closed" };
  }

  // 4. Somebody allowed this exact draft, and only in a state that may still
  //    send: the manual path needs `approved` with the text the operator left,
  //    the autopilot path needs a draft still `waiting` plus a current
  //    authorization row.
  //
  //    A live authorization is not permission to send a draft whose outcome is
  //    already settled. `send_state_unknown` above all: its claim was released
  //    precisely so nothing resends it, and an authorizing row that outlives the
  //    attempt would otherwise bring it back for a second DM. `sent`,
  //    `invalidated`, `skipped` and `expired` are decisions too, and no gate
  //    result undoes one.
  const approved = draft.status === "approved" && (draft.decidedText ?? "").trim() !== "";
  const authorized =
    draft.status === "waiting" &&
    (await db.currentProspectAuthorization(d1, draft.draftId, now)) !== null;
  if (!approved && !authorized) return { ok: false, code: "no_approval" };

  return {
    ok: true,
    recipientId: thread.igsid,
    text: approved ? (draft.decidedText ?? "").trim() : draft.text,
    inboundMid: latest.mid,
    autopilot: !approved,
  };
}

/**
 * The claim the account's Durable Object holds for a prospect thread.
 *
 * One per conversation, so the claims of a thread are exactly the sends it has
 * in flight — which is what the webhook reads to tell the echo of our own API
 * send, whose `mid` may still be on its way back, from a message the operator
 * typed on his phone (see `handleEcho` in `src/prospects.ts`).
 */
export function prospectClaimKey(leadId: string): string {
  return `prospect:${leadId}`;
}

/**
 * The job the outbox stores for a prospect reply.
 *
 * The outbox is keyed by (campaign id, comment id) and claims by (dedupe key,
 * commenter id); a prospect send has neither a campaign nor a comment, so the
 * draft id fills both ids — it is already unique — and the claim is scoped to the
 * lead it belongs to. Nothing about the send is decided here: the checks re-read
 * the draft and the thread before every attempt.
 */
function prospectReplyJob(t: {
  draftId: string;
  leadId: string;
  igUserId: string;
  text: string;
}): SendJob {
  return {
    igUserId: t.igUserId,
    campaignId: PROSPECT_CAMPAIGN_ID,
    kind: "prospect_reply",
    dedupeKey: prospectClaimKey(t.leadId),
    commentId: t.draftId,
    commenterId: t.draftId,
    draftId: t.draftId,
    leadId: t.leadId,
    message: t.text,
    successStatus: "sent",
  };
}

/**
 * Hands one draft to the account's Durable Object and reports what happened.
 *
 * The claim is taken here, before the DO is asked to send, so two requests
 * holding the same draft cannot both reach Meta. The DO then runs the checks and
 * the send itself; everything it reports is translated into this union, and an
 * outcome nobody recognises fails closed rather than claiming success.
 */
export async function sendProspectDraft(
  env: Env,
  t: { draftId: string; leadId: string; text: string },
): Promise<ProspectSendOutcome> {
  const thread = await db.getProspectThread(env.DB, t.leadId);
  // Without the thread there is no account to send from, and no DO to ask. The
  // checks would say the same thing a moment later.
  if (!thread) return { status: "blocked", code: "not_registered" };

  const draft = await db.getProspectDraft(env.DB, t.draftId);
  if (!draft || draft.leadId !== t.leadId) return { status: "blocked", code: "not_registered" };
  // Only a draft that is still undecided (the autopilot path) or approved may
  // take a claim at all. The DO runs the five checks before the network call
  // either way; this one keeps a settled draft — above all an unknown one — from
  // even briefly holding a claim as if a send were under way.
  if (draft.status !== "approved" && draft.status !== "waiting") {
    return { status: "blocked", code: "no_approval" };
  }

  const job = prospectReplyJob({
    draftId: t.draftId,
    leadId: t.leadId,
    igUserId: thread.igUserId,
    text: t.text,
  });
  const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(thread.igUserId));

  // Check 5's evidence is the stored message, never a claim. A claim is also
  // held by a retry queued behind a refusal (a 429), and reading that as "this
  // draft already went out" would retire a draft that has not left at all. The
  // draft is settled through the same writer as every other refusal.
  if (await db.prospectMessageByIdem(env.DB, t.leadId, t.draftId)) {
    await blockProspectSend(env.DB, t.draftId, "already_sent");
    return { status: "blocked", code: "already_sent" };
  }

  if (!(await account.claim(job.dedupeKey, job.commenterId))) {
    // The draft is already being sent, or its retry is waiting in the outbox.
    // Either way this request sends nothing and the draft keeps the state it
    // has: it is not "sent", and the queue behind it is not touched.
    return { status: "queued" };
  }

  return outcome(await account.deliver(job));
}

function outcome(status: string): ProspectSendOutcome {
  if (status === "sent") return { status: "sent" };
  if (status === "queued") return { status: "queued" };
  if (status === "send_state_unknown") return { status: "send_state_unknown" };
  if (status === "failed") return { status: "failed" };
  if (status.startsWith("blocked:")) {
    const code = status.slice("blocked:".length);
    if ((PROSPECT_BLOCK_CODES as readonly string[]).includes(code)) {
      return { status: "blocked", code: code as ProspectBlockCode };
    }
  }
  // Unknown is not sent. A wrong "sent" would hide a message that never left.
  return { status: "failed" };
}

/** What a block leaves the draft as, so the queue shows the truth. */
function statusAfterBlock(code: ProspectBlockCode): db.ProspectDraftStatus {
  // Redrafting is the only way forward: the conversation it answered is gone.
  if (code === "version_changed") return "invalidated";
  // It already left, once. `sent` is what it is.
  if (code === "already_sent") return "sent";
  // Nothing was sent, so it waits again — and the page shows it where its
  // reason belongs (out of window, or a thread nobody registered).
  return "waiting";
}

/**
 * Records what a send attempt left the draft as.
 *
 * One writer for every outcome, so a blocked approval, a Meta refusal and a
 * timeout cannot each invent their own status. The decision text is kept: it is
 * what the graduation count reads, and a draft that goes back to `waiting` was
 * not sent, so its decision time is cleared rather than rewritten.
 */
export async function setProspectDraftStatus(
  d1: D1Database,
  draftId: string,
  status: db.ProspectDraftStatus,
  now = Date.now(),
): Promise<boolean> {
  const draft = await db.getProspectDraft(d1, draftId);
  if (!draft) return false;

  return db.decideProspectDraft(d1, {
    draftId,
    // `send_state_unknown` is deliberately not a starting point: it means a
    // request may have reached Meta, and only a person looking at the thread may
    // say otherwise ("salió" / "no salió"). No check, retry or cron gets to
    // quietly turn it back into something sendable.
    from: (["waiting", "approved"] as const).filter((s) => s !== status),
    status,
    decidedText: draft.decidedText,
    decidedAt: status === "waiting" ? null : (draft.decidedAt ?? now),
  });
}

/** A blocked attempt: the draft carries the reason in its own status. */
export async function blockProspectSend(
  d1: D1Database,
  draftId: string,
  code: ProspectBlockCode,
  now = Date.now(),
): Promise<void> {
  await setProspectDraftStatus(d1, draftId, statusAfterBlock(code), now);
}
