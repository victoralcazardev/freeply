import { chrome, esc } from "./dashboard";
import * as db from "./db";
import type { Env } from "./index";
import { approveProspectDraft, closeProspectThread, registerExpectedM1 } from "./prospects";
import type { ProspectBlockCode, ProspectSendOutcome } from "./prospects-send";

/**
 * The mobile page for the daily sessions (S8): the queues over the threads the
 * M1 echo enrolled, and nothing else.
 *
 * One of them is the follow-up queue (T19) for a thread the lead never answered:
 * a no-DM touch from day 3, one hand-sent DM from day 7, and a close at day 14
 * that the scheduled job performs. Both steps are marked here and neither sends
 * anything — the API and the autopilot have no path to a follow-up, because Meta
 * gets a thread restricted for a second unprompted message.
 *
 * Every read here comes from `prospect_threads` by `lead_id`, so a conversation
 * nobody registered has no way onto this page (S11). No message text is ever
 * logged: the page reads and renders it, and the Worker's logs stay content-free.
 *
 * It sits behind the dashboard session (`src/index.ts`), so it is dispatched only
 * after `isValidSession` passes, and it uses the dashboard's plain `POST` forms.
 * Those have no CSRF token of their own — the barrier is the `HttpOnly`,
 * `SameSite=Lax` session cookie, which a cross-site form POST does not carry.
 *
 * The page is a plain list of six queues first and a one-card-at-a-time deck
 * second: the scripts at the bottom hide every queue and every card but one, and
 * the switch is presentation only. A phone that never runs them still gets every
 * queue and every card, and every button posts the same form it always did.
 */

const CSS = `
/* Tokens the dashboard stylesheet does not carry. They are namespaced --fx- so
   this page cannot restyle the frame it shares with every other page. */
:root {
  --fx-surface: #f4f4ef; --fx-line-2: #cfcfc8;
  --fx-shadow: 0 1px 2px rgba(26,26,24,.07), 0 14px 34px rgba(26,26,24,.10);
  --fx-chip-bg: #f2f2ee; --fx-chip-fg: #4a4a46; --fx-chip-line: #dedcd4;
  --fx-warn-bg: #fdf1dd; --fx-warn-fg: #8a5a12; --fx-warn-line: #ecd0a2;
  --fx-ok-bg: #eaf5ee; --fx-ok-fg: #1f6b41; --fx-ok-line: #bfe0cc;
  --fx-focus: #1a56db;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fx-surface: #26262e; --fx-line-2: #3d3d46;
    --fx-shadow: 0 1px 2px rgba(0,0,0,.5), 0 16px 36px rgba(0,0,0,.5);
    --fx-chip-bg: #26262e; --fx-chip-fg: #c9c9c3; --fx-chip-line: #3a3a43;
    --fx-warn-bg: #2e2417; --fx-warn-fg: #f0c98a; --fx-warn-line: #4d3a20;
    --fx-ok-bg: #16281d; --fx-ok-fg: #9ad9b1; --fx-ok-line: #2b4a37;
    --fx-focus: #8ab4ff;
  }
}
/* The deck uses the attribute to hide whole queues and single cards. Without the
   !important the page's own display rules would win over the browser's. */
[hidden] { display: none !important; }
.focus :focus-visible { outline: 3px solid var(--fx-focus); outline-offset: 2px; border-radius: 8px; }

.wrap { padding: 1rem .9rem 4rem; }
.queue { display: grid; gap: .6rem; }
.queue h2 { margin: 1.2rem 0 .1rem; display: flex; align-items: baseline; gap: .4rem; font-size: .95rem; }
.queue h2 .small { font-weight: 500; }

/* One card, the parts the artboard gives it: who, how long the window holds,
   what the lead said, the box to answer in, and the actions under the thumb. */
.card { padding: 1rem 1rem 1.1rem; border-radius: 16px; box-shadow: var(--fx-shadow); }
.who { display: grid; grid-template-columns: 2.4rem minmax(0, 1fr) auto; gap: .6rem; align-items: center; }
.avatar { width: 2.4rem; height: 2.4rem; border-radius: 50%; display: grid; place-items: center;
  background: var(--fx-surface); border: 1px solid var(--fx-line-2); color: var(--muted);
  font-weight: 700; font-size: .95rem; }
.who-main { min-width: 0; }
.who h3 { margin: 0; font-size: 1rem; line-height: 1.25; overflow-wrap: anywhere; }
.who .sub { margin: .15rem 0 0; overflow-wrap: anywhere; }
.tag { display: inline-flex; align-items: center; gap: .25rem; white-space: nowrap;
  font-size: .75rem; font-weight: 650; line-height: 1; padding: .4rem .6rem; border-radius: 999px;
  border: 1px solid var(--fx-chip-line); background: var(--fx-chip-bg); color: var(--fx-chip-fg); }
.tag.warn { background: var(--fx-warn-bg); border-color: var(--fx-warn-line); color: var(--fx-warn-fg); }
.tag.on { background: var(--fx-ok-bg); border-color: var(--fx-ok-line); color: var(--fx-ok-fg); }

.window { display: grid; gap: .35rem; margin-top: .8rem; padding: .55rem .7rem;
  border-radius: 10px; border: 1px solid var(--line); background: var(--fx-surface); }
.window-top { display: flex; justify-content: space-between; gap: .5rem; font-size: .78rem;
  color: var(--muted); }
.meter { height: 6px; border-radius: 999px; overflow: hidden; background: var(--line); }
.meter span { display: block; height: 100%; background: var(--ok); }
.window[data-tone="soon"] .meter span,
.window[data-tone="closed"] .meter span { background: var(--bad); }

.say { margin-top: .8rem; }
.say-label { margin: 0 0 .3rem; font-size: .72rem; letter-spacing: .08em; text-transform: uppercase;
  font-weight: 700; color: var(--muted); }
.bubble { margin: 0; padding: .7rem .85rem; border-radius: 3px 12px 12px 12px;
  border: 1px solid var(--line); background: var(--fx-surface); font-size: .95rem; line-height: 1.45;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.bubble .when { display: block; margin-top: .35rem; font-size: .78rem; color: var(--muted); }

label { margin: .8rem 0 .3rem; font-size: .82rem; font-weight: 600; color: var(--muted); }
textarea { font-size: 16px; white-space: pre-wrap; } /* below 16px iOS zooms the page on focus */
.preview { white-space: pre-wrap; overflow-wrap: anywhere; margin: .4rem 0 0; }
.pre { margin: .3rem 0 0; padding: .7rem .85rem; border-radius: 10px; border: 1px dashed var(--fx-line-2);
  background: var(--fx-surface); font: inherit; font-size: .95rem; line-height: 1.45;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.fine { margin: .7rem 0 0; font-size: .8rem; line-height: 1.45; color: var(--muted); }
.offscreen { position: fixed; top: -1000px; left: 0; width: 1px; height: 1px; opacity: 0; }

.actions { display: grid; gap: .5rem; margin-top: .6rem; }
.actions-row { display: flex; gap: .5rem; flex-wrap: wrap; }
.actions-row > * { flex: 1 1 8rem; }
[data-copy-state]:empty { display: none; } /* a clipboard line only once it has something to say */
.btn, .actions button { display: inline-flex; align-items: center; justify-content: center; gap: .35rem;
  width: 100%; min-height: 44px; padding: .55rem .9rem; border-radius: 10px;
  border: 1px solid var(--fx-line-2); background: var(--card); color: var(--fg);
  font: inherit; font-size: .9rem; font-weight: 600; text-decoration: none; cursor: pointer; }
.actions .primary { min-height: 52px; background: var(--accent); border-color: var(--accent);
  color: #fff; font-size: .95rem; }
@media (prefers-color-scheme: dark) {
  /* The dark accent is light enough that white on it is not readable. */
  .actions .primary { color: #16161a; }
}
.actions .danger, .danger { color: var(--bad); }
.close-form { margin-top: .8rem; border-top: 1px solid var(--line); padding-top: .6rem; }
.close-form .actions { margin: 0; }
.close-form button { background: transparent; border-color: transparent; color: var(--bad); }

.card details { margin-top: .7rem; border-top: 1px solid var(--line); padding-top: .2rem; }
.card details > summary { display: inline-flex; align-items: center; min-height: 44px;
  font-size: .84rem; font-weight: 600; color: var(--accent); cursor: pointer; list-style: none; }
.card details > summary::-webkit-details-marker { display: none; }
.card details > summary::before { content: "+"; margin-right: .4rem; font-weight: 700; }
.card details[open] > summary::before { content: "–"; }
.card details .preview, .card details .fine { margin-top: .2rem; }

/* Deck chrome, rendered hidden and un-hidden by the script. */
.deck-chrome { position: sticky; top: 0; z-index: 20; background: var(--bg);
  padding: .4rem 0 .45rem; border-bottom: 1px solid var(--line); }
.deck-bar { display: flex; align-items: center; gap: .6rem; }
.deck-open { min-height: 44px; padding: 0 .9rem; border-radius: 999px;
  border: 1px solid var(--fx-line-2); background: var(--card); color: var(--fg);
  font: inherit; font-size: .85rem; font-weight: 600; cursor: pointer; }
.deck-queue { font-size: .85rem; font-weight: 650; color: var(--fg); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
.deck-pos { margin-left: auto; font-size: .8rem; font-weight: 650; color: var(--muted);
  font-variant-numeric: tabular-nums; }
.deck-hint { max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: .78rem; color: var(--muted); }
.deck-rail { height: 4px; margin-top: .45rem; border-radius: 999px; overflow: hidden;
  background: var(--line); }
.deck-rail span { display: block; height: 100%; width: 0; background: var(--accent); }
.focus[data-deck-ready] .queue { max-width: 46rem; margin: 0 auto; }

.pager { position: sticky; bottom: 0; z-index: 20; display: flex; align-items: center; gap: .5rem;
  padding: .5rem 0 calc(.5rem + env(safe-area-inset-bottom)); background: var(--bg);
  border-top: 1px solid var(--line); }
.pager button { flex: 1 1 0; min-height: 48px; padding: 0 .8rem; border-radius: 10px;
  border: 1px solid var(--fx-line-2); background: var(--card); color: var(--fg);
  font: inherit; font-size: .9rem; font-weight: 600; cursor: pointer; }
.pager button:disabled { opacity: .45; cursor: not-allowed; }
.pager .count { min-width: 3.5rem; text-align: center; font-size: .8rem; font-weight: 650;
  color: var(--muted); font-variant-numeric: tabular-nums; }

dialog.queue-sheet { width: 100%; max-width: 32rem; margin: auto auto 0; padding: 0; border: 0;
  background: transparent; color: var(--fg); }
dialog.queue-sheet::backdrop { background: rgba(15,15,14,.42); }
/* A browser without showModal() opens it with the attribute, where the element
   is in the flow; pin it to the bottom of the screen like the modal one. */
dialog.queue-sheet:not(:modal) { position: fixed; left: 0; right: 0; bottom: 0; z-index: 60; }
.sheet { display: grid; gap: .8rem; max-height: 86vh; overflow: auto;
  padding: 1rem 1rem calc(1rem + env(safe-area-inset-bottom)); background: var(--card);
  border: 1px solid var(--line); border-radius: 18px 18px 0 0; }
.sheet-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.sheet-head h2 { margin: 0; font-size: 1rem; }
.sheet-head .btn { width: auto; }
.queues { display: grid; gap: .4rem; }
.qbtn { display: flex; align-items: center; gap: .6rem; width: 100%; min-height: 52px;
  padding: .5rem .7rem; border-radius: 10px; border: 1px solid var(--line); background: var(--card);
  color: var(--fg); font: inherit; font-size: .9rem; text-align: left; cursor: pointer; }
.qbtn small { display: block; font-size: .75rem; color: var(--muted); }
.qbtn b { margin-left: auto; font-size: .78rem; font-weight: 700; color: var(--muted);
  font-variant-numeric: tabular-nums; }
.qbtn[aria-current="true"] { border-color: var(--accent); color: var(--accent); }

@media (prefers-reduced-motion: no-preference) {
  [data-card] { animation: fx-in .18s ease both; }
  @keyframes fx-in { from { opacity: .4; transform: translateY(6px); } to { opacity: 1; transform: none; } }
}
@media (prefers-reduced-motion: reduce) {
  .focus *, .focus *::before, .focus *::after { animation: none !important; transition: none !important; }
}
/* A long urgency chip moves under the name instead of squeezing the handle. */
@media (max-width: 26rem) {
  .who { grid-template-columns: 2.4rem minmax(0, 1fr); }
  .who .tag { grid-column: 1 / -1; justify-self: start; }
}
`;

/** Spanish for the three ways registering an M1 can fail. */
const M1_ERRORS: Record<"not_found" | "already_enrolled" | "thread_closed", string> = {
  not_found: "Ese lead ya no existe.",
  already_enrolled: "Este hilo ya está registrado: su eco llegó y no se puede volver a armar.",
  thread_closed: "Ese hilo está cerrado.",
};

const APPROVE_ERRORS = {
  not_found: "Ese borrador ya no existe.",
  not_waiting: "Ese borrador ya no está pendiente.",
  not_a_reply: "Solo se aprueban respuestas, no el M1.",
  empty_text: "El texto está vacío.",
} as const;

/** The two approvals that leave nothing for a person to do. */
const SEND_DONE: Record<"sent" | "queued", string> = {
  sent: "Aprobado y enviado.",
  queued: "Aprobado. Meta ha dado un error temporal: el envío se reintenta solo.",
};

/**
 * Why an approval could not send, in the operator's language and with the code
 * the checks returned — the code is what he can quote when one of these is
 * wrong, and each one points at a different thing to do next.
 */
const SEND_BLOCKED: Record<ProspectBlockCode, string> = {
  not_registered:
    "Este hilo ya no está registrado (not_registered): no se puede enviar por la API.",
  window_closed:
    "La ventana de 24 h está cerrada o el último mensaje no es del lead (window_closed): " +
    "contéstale a mano desde Instagram.",
  version_changed:
    "La conversación cambió desde que se redactó (version_changed): el borrador queda " +
    "invalidado y hay que redactarlo otra vez.",
  no_approval: "Este borrador no tiene una aprobación válida (no_approval).",
  already_sent: "Este borrador ya se envió (already_sent): no se manda dos veces.",
};

const SEND_UNKNOWN =
  "No sabemos si salió (send_state_unknown): un corte a media llamada no dice si llegó. " +
  "Está en la cola Manual — mira el hilo en Instagram y contesta «Salió» o «No salió».";

const SEND_FAILED =
  "No se envió y el borrador vuelve a la cola (failed): revisa el texto y vuelve a aprobarlo.";

/** What the non-approval buttons do, and which statuses they may act on. */
const DECISIONS: Record<
  string,
  { from: db.ProspectDraftStatus[]; status: db.ProspectDraftStatus; done: string }
> = {
  skip: { from: ["waiting"], status: "skipped", done: "Borrador omitido." },
  sent: {
    from: ["waiting", "send_state_unknown"],
    status: "sent",
    done: "Marcado como enviado.",
  },
  not_sent: {
    from: ["send_state_unknown"],
    status: "waiting",
    done: "Vuelve a los borradores.",
  },
};

/**
 * Every answer to a form on this page, and always a `303` to a `GET`.
 *
 * The page reloads itself when the phone comes back from Instagram (see
 * `REFRESH_SCRIPT`), so a POST answered with markup would be posted again by
 * the refresh: a copy would re-register, a close would re-close, an approval
 * would re-approve. Ending in a `GET` makes the reload read the same thing
 * without writing anything, and `303` says so in the one way a phone browser
 * never re-sends.
 */
const redirect = (to: string) => new Response(null, { status: 303, headers: { location: to } });
const problem = (message: string) => redirect(`/prospects?error=${encodeURIComponent(message)}`);

/** What the two manual follow-up marks say when they land (T19). */
const FOLLOWUP_DONE: Record<string, string> = {
  touch:
    "Toque marcado. No se ha enviado ningún mensaje: el siguiente paso es el DM de seguimiento.",
  followup:
    "DM de seguimiento marcado. El hilo se cierra solo si al día 14 sigue sin respuesta.",
};

const FOLLOWUP_REFUSED = "Ese hilo no está en la cola de seguimientos.";

/** What a manual close answers, by what the shared helper returned. */
const CLOSE_DONE = "Hilo cerrado: no se le volverá a escribir.";
const CLOSE_ALREADY = "Ese hilo ya estaba cerrado con ese motivo.";
const CLOSE_CONFLICT = "Ese hilo está cerrado con otro motivo.";
const CLOSE_NOT_FOUND = "Ese hilo ya no existe.";

export interface CopiedM1 {
  leadId: string;
  handle: string;
  name: string | null;
  /** The exact text that was hashed — what the clipboard has to receive. */
  text: string;
}

export async function handleProspectsPage(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (url.pathname === "/prospects" && request.method === "GET") return render(env, url);
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "").trim();

  if (url.pathname === "/prospects/m1") {
    return copyM1(env, field("lead_id"), String(form.get("text") ?? "").trim());
  }
  if (url.pathname === "/prospects/m1/retry") return retryM1(env, field("lead_id"));
  if (url.pathname === "/prospects/drafts") {
    return decideDraft(env, field("draft_id"), field("action"), String(form.get("text") ?? ""));
  }
  if (url.pathname === "/prospects/followups") {
    return markFollowup(env, field("lead_id"), field("action"));
  }
  if (url.pathname === "/prospects/close") {
    return closeThread(env, field("lead_id"), field("reason"));
  }
  return new Response("not found", { status: 404 });
}

async function render(env: Env, url: URL): Promise<Response> {
  const now = Date.now();
  const [m1, followups, drafts, manual, work, justCopied] = await Promise.all([
    db.prospectM1Queue(env.DB, now),
    db.prospectFollowupQueue(env.DB, now),
    db.prospectDraftQueue(env.DB, now),
    db.prospectManualQueue(env.DB, now),
    db.prospectWork(env.DB, OVERDUE_LIMIT),
    // `?copied=` is the lead the copy just registered. It is a read, so the
    // refresh that reloads this URL writes nothing and copies nothing again.
    db.prospectCopiedM1(env.DB, url.searchParams.get("copied") ?? ""),
  ]);
  // A lead who wrote and has no draft yet is the CLI's work — until the wait
  // gets long enough that a person has to watch it. From twenty hours it shows
  // in Manual as a warning, and past twenty-four as something only the app can
  // answer, because the API wall has already come down.
  const overdue = work.filter((item) => now - item.inbound.sentAt >= db.WINDOW_WARNING_MS);

  return prospectsPage({
    host: url.host,
    now,
    // A copied thread has `m1_registered_at` set, so the queue read already
    // leaves it out: the next uncopied lead is the first card below.
    pending: m1.pending,
    copied: m1.copied,
    unconfirmed: m1.unconfirmed,
    followups,
    drafts,
    manual,
    overdue,
    justCopied,
    status: url.searchParams.get("status") ?? undefined,
    error: url.searchParams.get("error") ?? undefined,
  });
}

/**
 * "Copiar" on the send queue: register the final text, then show the notice the
 * browser copies from.
 *
 * Registering is the whole point — it is what makes the echo legible — and the
 * clipboard write itself happens in the tap, before this request: a write after
 * the redirect has no user gesture behind it, which iOS refuses. What the notice
 * does is report what the copy resolved to, from what the tap recorded.
 */
async function copyM1(env: Env, leadId: string, text: string): Promise<Response> {
  if (!text) return problem("El mensaje está vacío.");

  const result = await registerExpectedM1(env.DB, leadId, text);
  if (!result.ok) return problem(M1_ERRORS[result.error]);

  return redirect(`/prospects?copied=${encodeURIComponent(leadId)}`);
}

/** What the page says after an approval, by what the send came back with. */
function sendSaid(send: ProspectSendOutcome): Response {
  if (send.status === "sent" || send.status === "queued") {
    return redirect(`/prospects?status=${encodeURIComponent(SEND_DONE[send.status])}`);
  }
  if (send.status === "blocked") return problem(SEND_BLOCKED[send.code]);
  if (send.status === "send_state_unknown") return problem(SEND_UNKNOWN);
  return problem(SEND_FAILED);
}

/**
 * "No le interesa" on any thread card, and the API's close (`L62`).
 *
 * A thread the system never enrolled can finally leave every queue, which is the
 * gap the first real "no me interesa" exposed: there was no way to record it and
 * the Sheet would not take a hand-written "perdido". The close is permanent, so
 * a different reason is refused instead of overwriting the first one.
 */
async function closeThread(env: Env, leadId: string, rawReason: string): Promise<Response> {
  if (leadId === "") return problem(CLOSE_NOT_FOUND);
  if (!db.isProspectCloseReason(rawReason)) return problem("Motivo desconocido.");

  const result = await closeProspectThread(env, { leadId, reason: rawReason });
  if (!result.ok) {
    return problem(result.error === "not_found" ? CLOSE_NOT_FOUND : CLOSE_CONFLICT);
  }
  return redirect(
    `/prospects?status=${encodeURIComponent(result.closed ? CLOSE_DONE : CLOSE_ALREADY)}`,
  );
}

/**
 * "Hecho" and "Enviado" on the follow-up queue (T19).
 *
 * Neither sends anything and neither stores what was typed: the DM is written
 * and copied on the phone, and this only records that the step happened. The
 * write itself is conditional on the thread still being in the queue, so a
 * mark that arrives after the lead answered is refused instead of overwriting
 * a conversation that moved on.
 */
async function markFollowup(env: Env, leadId: string, action: string): Promise<Response> {
  const mark =
    action === "touch"
      ? db.markProspectTouchDone
      : action === "followup"
        ? db.markProspectFollowupSent
        : null;
  if (!mark) return problem("Acción desconocida.");

  if (leadId === "" || !(await mark(env.DB, leadId, Date.now()))) {
    return problem(FOLLOWUP_REFUSED);
  }
  return redirect(`/prospects?status=${encodeURIComponent(FOLLOWUP_DONE[action])}`);
}

/** "Reintentar": back to the send queue with nothing registered. */
async function retryM1(env: Env, leadId: string): Promise<Response> {
  const retried = leadId !== "" && (await db.retryProspectM1(env.DB, leadId));
  if (!retried) return problem("Ese hilo ya no está esperando un M1.");
  return redirect(
    `/prospects?status=${encodeURIComponent("El M1 vuelve a la cola: edítalo y cópialo otra vez.")}`,
  );
}

async function decideDraft(
  env: Env,
  draftId: string,
  action: string,
  text: string,
): Promise<Response> {
  const now = Date.now();

  if (action === "approve") {
    // Approval and send are one gesture: the answer to this POST is whether the
    // DM left, and if it did not, which check stopped it.
    const result = await approveProspectDraft(env, { draftId, text, now });
    if (!result.ok) return problem(APPROVE_ERRORS[result.error]);
    return sendSaid(result.send);
  }

  const decision = DECISIONS[action];
  if (!decision) return problem("Acción desconocida.");

  // «Salió» also stores the message: the operator sent it by hand, so nothing
  // else records it (S8). Every other button only moves the draft.
  const decided =
    decision.status === "sent"
      ? await db.decideProspectDraftSent(env.DB, { draftId, from: decision.from, decidedAt: now })
      : await db.decideProspectDraft(env.DB, {
          draftId,
          from: decision.from,
          status: decision.status,
          decidedText: null,
          decidedAt: decision.status === "waiting" ? null : now,
        });
  if (!decided) return problem("Ese borrador ya no está pendiente.");

  return redirect(`/prospects?status=${encodeURIComponent(decision.done)}`);
}

/* ------------------------------------------------------------------- render */

export interface ProspectsPageData {
  host: string;
  now: number;
  /** Never copied: the only threads in the send queue, in draft-push order. */
  pending: db.ProspectM1Item[];
  /** Copied less than 30 min ago: waiting for an echo that may still arrive. */
  copied: db.ProspectM1Item[];
  unconfirmed: db.ProspectM1Item[];
  /** Enrolled threads with no inbound, and the step due now (T19). */
  followups: db.ProspectFollowupItem[];
  drafts: db.ProspectQueueItem[];
  manual: db.ProspectManualItem[];
  /** Unanswered inbounds with no draft yet, past the 20 h warning line. */
  overdue: db.ProspectWorkItem[];
  /** The thread just copied: the confirmation and the clipboard payload. */
  justCopied: CopiedM1 | null;
  status?: string;
  error?: string;
}

/** The six queues, by the name the deck and its switcher use for them. */
type QueueKey = "drafts" | "m1" | "unconfirmed" | "copied" | "followups" | "manual";

interface QueueSection {
  key: QueueKey;
  /** Kept as the section id the page has always published. */
  id: string;
  title: string;
  /** One line under the title in the switcher, so a queue needs no guessing. */
  blurb: string;
  count: number;
  cards: string;
  empty: string;
}

/**
 * Which queue opens the deck, most urgent first.
 *
 * A reply draft is the only queue with a clock behind it — the 24 h window is
 * running — so it opens. Manual is next because it holds the two things nobody
 * else can settle (a closed window and a send Meta never confirmed), then the
 * copy that lost its echo. Follow-ups and copied M1s are the patient work: they
 * wait on the lead or on Meta, not on the operator.
 */
const URGENT_FIRST: readonly QueueKey[] = [
  "drafts",
  "manual",
  "unconfirmed",
  "m1",
  "followups",
  "copied",
];

export function prospectsPage(d: ProspectsPageData): Response {
  const sections: QueueSection[] = [
    {
      key: "drafts",
      id: "borradores",
      title: "Borradores de respuesta",
      blurb: "Esperan tu OK",
      count: d.drafts.length,
      cards: d.drafts.map((item, i) => draftCard(item, d.now, i)).join(""),
      empty: "No hay borradores esperando el OK.",
    },
    {
      key: "m1",
      id: "m1-por-enviar",
      title: "M1 por enviar",
      blurb: "Copiar y registrar",
      count: d.pending.length,
      cards: d.pending.map((item, i) => m1Card(item, d.now, i, d.pending.length)).join(""),
      empty: "Nada por enviar.",
    },
    {
      key: "unconfirmed",
      id: "m1-sin-confirmar",
      title: "M1 sin confirmar",
      blurb: "El eco no llegó",
      count: d.unconfirmed.length,
      cards: d.unconfirmed.map((item) => unconfirmedCard(item, d.now)).join(""),
      empty: "Ningún M1 esperando su eco.",
    },
    {
      key: "copied",
      id: "m1-copiados",
      title: "Copiados, esperando confirmación",
      blurb: "Esperando el eco",
      count: d.copied.length,
      cards: d.copied.map((item) => copiedWaitingCard(item, d.now)).join(""),
      empty: "Ninguno esperando el eco.",
    },
    {
      key: "followups",
      id: "seguimientos",
      title: "Seguimientos",
      blurb: "Toque o DM, sin respuesta",
      count: d.followups.length,
      cards: d.followups.map((item, i) => followupCard(item, i)).join(""),
      empty: "Ningún hilo esperando seguimiento.",
    },
    {
      key: "manual",
      id: "manual",
      title: "Manual",
      blurb: "Fuera de ventana o salida sin confirmar",
      count: d.manual.length + d.overdue.length,
      // The thread with no draft at all comes first: it is the one where the
      // only option left is opening Instagram, and its window is the reason.
      cards:
        d.overdue.map((item) => overdueCard(item, d.now)).join("") +
        d.manual.map((item) => manualCard(item, d.now)).join(""),
      empty: "Nada para enviar a mano.",
    },
  ];

  const byKey = new Map(sections.map((section) => [section.key, section]));
  const firstWithWork = URGENT_FIRST.find((key) => (byKey.get(key)?.count ?? 0) > 0);
  const active = byKey.get(firstWithWork ?? "drafts") ?? sections[0];
  const total = sections.reduce((n, section) => n + section.count, 0);

  return chrome({
    host: d.host,
    tab: "prospects",
    title: "Prospectos",
    lang: "es",
    css: CSS,
    body: `
      <div class="focus" data-deck data-default-queue="${active.key}">
        ${d.error ? `<div class="alert">${esc(d.error)}</div>` : ""}
        ${d.status ? `<div class="card" style="border-color:var(--ok)">${esc(d.status)}</div>` : ""}
        ${d.justCopied ? copiedNotice(d.justCopied) : ""}
        ${total === 0 ? `<div class="card muted">No hay nada pendiente: ninguna cola tiene trabajo ahora mismo.</div>` : ""}

        ${deckChrome(active)}
        ${sections.map(queueSection).join("")}
        ${pager(active)}
        ${queueSheet(sections, active)}
        ${COPY_SCRIPT}
        ${DECK_SCRIPT}
        ${REFRESH_SCRIPT}
      </div>`,
  });
}

/** How many undrafted threads the page looks at; a phone shows a session's worth. */
const OVERDUE_LIMIT = 25;

const empty = (text: string) => `<div class="card muted">${esc(text)}</div>`;

const chatUrl = (handle: string) => `https://ig.me/m/${encodeURIComponent(handle)}`;

const title = (name: string | null, handle: string) => esc(name ?? `@${handle}`);

/** "No le interesa" (L62), on every card that still holds a thread. */
function closeButton(leadId: string): string {
  return `<form class="close-form" method="post" action="/prospects/close"
      onsubmit="return confirm('¿Cerrar este hilo como «no le interesa»? No se le volverá a escribir.')">
    <input type="hidden" name="lead_id" value="${esc(leadId)}">
    <input type="hidden" name="reason" value="no_interesa">
    <div class="actions"><button class="danger" type="submit">No le interesa</button></div>
  </form>`;
}

/** "hace 21 h" — the only time format the page shows. */
function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "un momento";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** What is left of the 24 h window, in the coarsest unit that still reads right. */
function windowLeft(now: number, lastInboundAt: number): string {
  const left = db.MESSAGE_WINDOW_MS - (now - lastInboundAt);
  if (left <= 0) return "ventana cerrada";
  const minutes = Math.round(left / 60000);
  return minutes < 60 ? `Quedan ${minutes} min` : `Quedan ${Math.round(minutes / 60)} h`;
}

/** A chip: always its words, with colour only as a second channel. */
function tag(text: string, tone?: "warn" | "on"): string {
  return `<span class="tag${tone ? ` ${tone}` : ""}">${esc(text)}</span>`;
}

/** The avatar's initial — decoration, so it never carries information alone. */
function initial(name: string | null, handle: string): string {
  const source = (name ?? handle).trim();
  const letter = Array.from(source).find((character) => /[\p{L}\p{N}]/u.test(character)) ?? "#";
  return letter.toUpperCase();
}

/**
 * The top of every card: who the thread is, what it waits for, and the chip
 * that says how urgent it is in words.
 */
function whoBlock(o: {
  name: string | null;
  handle: string;
  /** Already-escaped fragments, joined with «·» under the name. */
  sub?: string;
  chip?: string;
}): string {
  return `<div class="who">
    <span class="avatar" aria-hidden="true">${esc(initial(o.name, o.handle))}</span>
    <div class="who-main">
      <h3 tabindex="-1">${title(o.name, o.handle)}</h3>
      <p class="small muted sub">@${esc(o.handle)}${o.sub ? ` · ${o.sub}` : ""}</p>
    </div>
    ${o.chip ?? ""}
  </div>`;
}

/**
 * What is left of Meta's window: a bar for the glance and a sentence for the
 * reading. The bar is `role="img"` with a label, and the same fact also reaches
 * the card's chip, so urgency never depends on seeing a colour.
 */
function windowBlock(now: number, lastInboundAt: number | null): string {
  if (lastInboundAt === null) return "";
  const left = db.MESSAGE_WINDOW_MS - (now - lastInboundAt);
  const percent = Math.max(0, Math.min(100, Math.round((left / db.MESSAGE_WINDOW_MS) * 100)));
  const short = left > 0 && left <= db.MESSAGE_WINDOW_MS - db.WINDOW_WARNING_MS;
  const tone = left <= 0 ? "closed" : short ? "soon" : "calm";
  const minutes = Math.max(0, Math.round(left / 60000));
  const label =
    minutes === 0
      ? "Ventana de 24 h cerrada"
      : `Quedan ${minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`} de 24 h`;
  return `<div class="window" data-tone="${tone}">
    <div class="window-top">
      <span>Ventana de Meta: 24 h</span>
      <span>El lead escribió hace ${ago(now - lastInboundAt)}</span>
    </div>
    <div class="meter" role="img" aria-label="${esc(label)}"><span style="width:${percent}%"></span></div>
  </div>`;
}

/** The lead's last message, as the thing the answer has to respond to. */
function sayBlock(o: { label: string; text: string; when?: string }): string {
  return `<div class="say">
    <p class="say-label">${esc(o.label)}</p>
    <p class="bubble">«${esc(o.text)}»${o.when ? `<span class="when">${esc(o.when)}</span>` : ""}</p>
  </div>`;
}

function m1Card(item: db.ProspectM1Item, now: number, i: number, total: number): string {
  const { thread, text } = item;
  const sub = [thread.nicho ?? "", thread.m1RegisteredAt
    ? `registrado hace ${ago(now - thread.m1RegisteredAt)}`
    : ""].filter((part) => part !== "").join(" · ");

  return `<div class="card" data-card>
    ${whoBlock({
      name: thread.name,
      handle: thread.handle,
      sub: esc(sub),
      chip: tag(`M1 · ${i + 1} de ${total}`),
    })}
    <form method="post" action="/prospects/m1">
      <input type="hidden" name="lead_id" value="${esc(thread.leadId)}">
      <label for="m1-text-${i}">Mensaje <span class="muted">— edítalo antes de copiar</span></label>
      <textarea id="m1-text-${i}" name="text" rows="5">${esc(text ?? "")}</textarea>
      <div class="actions">
        <button class="primary" type="submit" data-copy-submit="m1-text-${i}">Copiar y registrar</button>
        <a class="btn" href="${esc(chatUrl(thread.handle))}" target="_blank" rel="noopener">Abrir chat</a>
      </div>
    </form>
    <p class="fine">«Copiar» copia este texto en el mismo toque y lo registra: el hilo se
      reconoce solo cuando llega el eco de ese texto exacto. Si lo cambias después, vuelve a
      copiarlo.</p>
    <details class="mini">
      <summary>Sugerencia antes de enviar</summary>
      <p class="small muted">Opcional: síguela y comenta o responde a una story ≥24 h antes. Nada lo
        bloquea — es una sugerencia para que el primer mensaje no llegue en frío a alguien que nunca
        te ha visto.</p>
    </details>
    ${closeButton(thread.leadId)}
  </div>`;
}

/** One thread in "Copiados": copied, echo not back yet. */
function copiedWaitingCard(item: db.ProspectM1Item, now: number): string {
  const { thread } = item;
  return `<div class="card" data-card>
    ${whoBlock({
      name: thread.name,
      handle: thread.handle,
      sub: esc(thread.nicho ?? ""),
      chip: tag(`Copiado hace ${ago(now - (thread.m1RegisteredAt ?? now))}`, "on"),
    })}
    <div class="say">
      <p class="bubble">Esperando el eco. Si no llega en 30 min pasa a «M1 sin confirmar».</p>
    </div>
    <div class="actions">
      <a class="btn primary" href="${esc(chatUrl(thread.handle))}" target="_blank" rel="noopener">Abrir chat</a>
    </div>
    <details>
      <summary>Ver el texto copiado</summary>
      ${item.text
        ? `<pre class="preview">${esc(item.text)}</pre>`
        : `<p class="fine">Sin texto registrado.</p>`}
      <p class="fine">Si el móvil no lo copió, mantén pulsado el texto y «Pegar».</p>
    </details>
    ${closeButton(thread.leadId)}
  </div>`;
}

function unconfirmedCard(item: db.ProspectM1Item, now: number): string {
  const { thread } = item;
  const sub = [thread.nicho ?? "",
    thread.m1RegisteredAt ? `registrado hace ${ago(now - thread.m1RegisteredAt)}` : ""]
    .filter((part) => part !== "").join(" · ");

  return `<div class="card" data-card>
    ${whoBlock({
      name: thread.name,
      handle: thread.handle,
      sub: esc(sub),
      chip: tag("Sin eco", "warn"),
    })}
    <div class="say">
      <p class="bubble">El texto copiado no ha vuelto como eco: o no se envió, o se envió con
        otras palabras, o estaba pendiente en dos leads a la vez. Reintentar lo devuelve a la cola
        con su texto; nada se empareja por parecido.</p>
    </div>
    <form method="post" action="/prospects/m1/retry">
      <input type="hidden" name="lead_id" value="${esc(thread.leadId)}">
      <div class="actions">
        <button class="primary" type="submit">Reintentar</button>
        <a class="btn" href="${esc(chatUrl(thread.handle))}" target="_blank" rel="noopener">Abrir chat</a>
      </div>
    </form>
    ${closeButton(thread.leadId)}
  </div>`;
}

/** The profile a touch happens on — the public page, opened in the app. */
const profileUrl = (handle: string) => `https://www.instagram.com/${encodeURIComponent(handle)}/`;

/**
 * The follow-up card (T19). One step per thread: the touch until day 7, then the
 * single follow-up DM. Neither writes any text to the server: the DM is copied
 * from the box and pasted into Instagram by hand, which is the whole rule.
 */
function followupCard(item: db.ProspectFollowupItem, i: number): string {
  const { thread, step, days } = item;
  const sub = [thread.nicho ?? "", `sin respuesta desde hace ${days} d`]
    .filter((part) => part !== "").join(" · ");
  const header = whoBlock({
    name: thread.name,
    handle: thread.handle,
    sub: esc(sub),
    chip: tag(step === "toque" ? "Toque" : "DM seguimiento"),
  });

  if (step === "toque") {
    return `<div class="card" data-card>
    ${header}
    <div class="say">
      <p class="bubble">Comenta una publicación suya o responde a una story. Nada de DM nuevo.</p>
    </div>
    <div class="actions">
      <a class="btn primary" href="${esc(profileUrl(thread.handle))}" target="_blank" rel="noopener">Abrir perfil</a>
    </div>
    <form method="post" action="/prospects/followups">
      <input type="hidden" name="lead_id" value="${esc(thread.leadId)}">
      <input type="hidden" name="action" value="touch">
      <div class="actions"><button class="primary" type="submit">Hecho</button></div>
    </form>
    <p class="fine">El toque no es un DM: comenta o responde a una story desde tu cuenta.
      «Hecho» solo apunta que lo has hecho; no envía nada.</p>
    ${closeButton(thread.leadId)}
  </div>`;
  }

  return `<div class="card" data-card>
    ${header}
    <p class="fine">DM de seguimiento: un único mensaje corto, escrito y enviado a mano desde
      el móvil. No repite el M1.</p>
    <label for="followup-text-${i}">Mensaje <span class="muted">— solo para copiarlo</span></label>
    <textarea id="followup-text-${i}" rows="4"></textarea>
    <p class="small muted" data-copy-state></p>
    <div class="actions">
      <button type="button" data-copy="followup-text-${i}">Copiar</button>
      <a class="btn" href="${esc(chatUrl(thread.handle))}" target="_blank" rel="noopener">Abrir chat</a>
    </div>
    <form method="post" action="/prospects/followups">
      <input type="hidden" name="lead_id" value="${esc(thread.leadId)}">
      <input type="hidden" name="action" value="followup">
      <div class="actions"><button class="primary" type="submit">Enviado</button></div>
    </form>
    <p class="fine">«Copiar» no guarda ni envía el texto: el mensaje sale de tu móvil. «Enviado»
      apunta el seguimiento para que no se pida dos veces.</p>
    ${closeButton(thread.leadId)}
  </div>`;
}

function draftCard(item: db.ProspectQueueItem, now: number, i: number): string {
  const { thread, draft, inbound } = item;
  const waited = thread.lastInboundAt === null ? null : now - thread.lastInboundAt;
  const closing = waited !== null && waited >= db.WINDOW_WARNING_MS;

  return `<div class="card" data-card>
    ${whoBlock({
      name: thread.name,
      handle: thread.handle,
      sub: esc(draft.stage ?? ""),
      chip: thread.lastInboundAt === null
        ? ""
        : tag(
            `${closing ? "A punto de caducar · " : ""}${windowLeft(now, thread.lastInboundAt)}`,
            closing ? "warn" : undefined,
          ),
    })}
    ${windowBlock(now, thread.lastInboundAt)}
    ${inbound ? sayBlock({
      label: "Su último mensaje",
      text: inbound.text,
      when: `hace ${ago(now - inbound.sentAt)}`,
    }) : ""}
    <form method="post" action="/prospects/drafts">
      <input type="hidden" name="draft_id" value="${esc(draft.draftId)}">
      <label for="draft-text-${i}">Tu respuesta <span class="muted">— edítala antes de aprobar</span></label>
      <textarea id="draft-text-${i}" name="text" rows="6">${esc(draft.text)}</textarea>
      <div class="actions">
        <button class="primary" name="action" value="approve">Aprobar y enviar</button>
        <div class="actions-row">
          <button name="action" value="skip">Omitir</button>
        </div>
      </div>
    </form>
    <p class="fine">Aprobar envía el texto final desde el Worker. Si no puede, la página dice
      por qué. A las 24 h del último mensaje del lead la ventana se cierra y ya no se puede
      contestar.</p>
    ${closeButton(thread.leadId)}
  </div>`;
}

/**
 * A wait with no draft behind it: either the CLI has not answered yet or it is
 * not running, and the 24 h wall is the thing that decides who answers it.
 */
function overdueCard(item: db.ProspectWorkItem, now: number): string {
  const { thread, inbound } = item;
  const waited = now - inbound.sentAt;
  const expired = waited > db.MESSAGE_WINDOW_MS;

  return `<div class="card" data-card>
    ${whoBlock({
      name: thread.name,
      handle: thread.handle,
      sub: esc(thread.nicho ?? ""),
      chip: tag(expired ? "Fuera de ventana" : "A punto de caducar", "warn"),
    })}
    ${windowBlock(now, inbound.sentAt)}
    ${sayBlock({ label: "Su último mensaje", text: inbound.text, when: `hace ${ago(waited)}` })}
    <p class="fine">${
      expired
        ? "La API ya no puede contestar a este mensaje: háblalo desde Instagram."
        : "Todavía se puede contestar por la API, pero queda poco: si no llega un borrador, contéstale desde Instagram."
    }</p>
    <div class="actions">
      <a class="btn primary" href="${esc(chatUrl(thread.handle))}" target="_blank" rel="noopener">Abrir chat y contestar</a>
    </div>
    ${closeButton(thread.leadId)}
  </div>`;
}

function manualCard(item: db.ProspectManualItem, now: number): string {
  const { thread, draft, inbound, reason } = item;
  const unknown = reason === "send_state_unknown";

  return `<div class="card" data-card>
    ${whoBlock({
      name: thread.name,
      handle: thread.handle,
      sub: esc(thread.nicho ?? ""),
      chip: tag(unknown ? "Salida sin confirmar" : "Fuera de ventana", "warn"),
    })}
    ${windowBlock(now, thread.lastInboundAt)}
    ${inbound ? sayBlock({
      label: "Su último mensaje",
      text: inbound.text,
      when: `hace ${ago(now - inbound.sentAt)}`,
    }) : ""}
    <p class="say-label">Para enviar a mano</p>
    <p class="pre">${esc(draft.text)}</p>
    <div class="actions">
      <a class="btn primary" href="${esc(chatUrl(thread.handle))}" target="_blank" rel="noopener">${
        unknown ? "Abrir chat y mirar" : "Abrir chat"
      }</a>
    </div>
    <form method="post" action="/prospects/drafts">
      <input type="hidden" name="draft_id" value="${esc(draft.draftId)}">
      <div class="actions">
        ${
          unknown
            ? `<button class="primary" name="action" value="sent">Salió</button>
               <button name="action" value="not_sent">No salió</button>`
            : `<button class="primary" name="action" value="sent">Ya lo he enviado</button>
               <button name="action" value="skip">Omitir</button>`
        }
      </div>
    </form>
    ${
      unknown
        ? `<p class="fine">Un corte a media llamada no dice si el mensaje salió, y no se
           reintenta a ciegas: mira el hilo en Instagram y contesta.</p>`
        : ""
    }
    ${closeButton(thread.leadId)}
  </div>`;
}

/** The bar that says where in the active queue the deck stands. */
function deckChrome(active: QueueSection): string {
  const position = active.count === 0 ? "Nada pendiente" : `1 de ${active.count}`;
  const fill = active.count === 0 ? 0 : Math.round(100 / active.count);
  return `<div class="deck-chrome" data-deck-chrome hidden>
    <div class="deck-bar">
      <button class="deck-open" type="button" data-queue-open aria-haspopup="dialog"
        aria-expanded="false">Colas</button>
      <span class="deck-queue" data-queue-name>${esc(active.title)}</span>
      <span class="deck-pos" data-pos aria-live="polite">${position}</span>
      <span class="deck-hint" data-hint></span>
    </div>
    <div class="deck-rail" aria-hidden="true"><span data-fill style="width:${fill}%"></span></div>
  </div>`;
}

function pager(active: QueueSection): string {
  const position = active.count === 0 ? "—" : `1 / ${active.count}`;
  return `<div class="pager" data-deck-chrome hidden data-pager>
    <button type="button" data-prev disabled>Anterior</button>
    <span class="count" data-count>${position}</span>
    <button type="button" data-next ${active.count <= 1 ? "disabled" : ""}>Siguiente</button>
  </div>`;
}

/**
 * The sheet that jumps between queues. Only queues with work are listed — an
 * empty queue is not a place to go — and the dialog is a real `<dialog>` so
 * Escape closes it natively and focus returns to the button that opened it.
 */
function queueSheet(sections: QueueSection[], active: QueueSection): string {
  const entries = sections
    .filter((section) => section.count > 0)
    .map(
      (section) => `<button class="qbtn" type="button" data-queue-link="${section.key}"${
        section.key === active.key ? ' aria-current="true"' : ""
      }>
        <span>${esc(section.title)}<small>${esc(section.blurb)}</small></span>
        <b>${section.count}</b>
      </button>`,
    )
    .join("");

  return `<dialog id="queue-sheet" class="queue-sheet" aria-labelledby="queue-sheet-title">
    <div class="sheet">
      <div class="sheet-head">
        <h2 id="queue-sheet-title">Colas</h2>
        <button class="btn" type="button" data-queue-close>Cerrar</button>
      </div>
      <div class="queues">${
        entries || `<p class="fine">Ahora mismo no hay trabajo en ninguna cola.</p>`
      }</div>
      <p class="fine">Solo se puede contestar por la API dentro de las 24 h del último mensaje
        del lead. Entre 20 y 24 h la tarjeta lo dice con palabras. Fuera de ventana el texto se
        pega a mano desde Instagram. Un envío sin confirmar no se repite a ciegas.</p>
    </div>
  </dialog>`;
}

/** One queue's section: a heading, its count, and every card it holds. */
function queueSection(section: QueueSection): string {
  return `<section id="${section.id}" class="queue" data-queue="${section.key}"
      data-queue-count="${section.count}" data-queue-title="${esc(section.title)}">
    <h2>${esc(section.title)} <span class="small muted">${section.count}</span></h2>
    ${section.cards}${section.count === 0 ? empty(section.empty) : ""}
  </section>`;
}

/**
 * The only JavaScript that copies: every "Copiar" on the page, once per page.
 *
 * Two gestures, one rule — the clipboard is only ever claimed after the write
 * resolved, and when it does not resolve the box is put in front of the person
 * to long-press instead. The two differ in where the gesture happens:
 *
 * - "Copiar y registrar" copies the M1 box inside the tap and only then submits,
 *   recording the outcome for the page it lands on. Copying after the redirect
 *   is exactly the case iOS refuses: no user gesture, no clipboard. It still
 *   submits the same form, so the deck changes nothing about what is stored.
 * - "Copiar" on a follow-up DM has nothing to register — the thread is already
 *   enrolled — so it copies in place and says so under the box.
 *
 * Nothing here writes to the server, and no message text is interpolated into
 * JavaScript: the boxes are read at click time.
 */
const COPY_SCRIPT = `<script>
    (function () {
      function remember(key, value) {
        try { sessionStorage.setItem(key, value); } catch (e) {}
      }
      var submits = document.querySelectorAll("[data-copy-submit]");
      for (var i = 0; i < submits.length; i++) {
        submits[i].addEventListener("click", function (event) {
          var box = document.getElementById(this.getAttribute("data-copy-submit"));
          var form = this.form;
          if (!box || !form) return;
          var lead = form.elements.namedItem("lead_id");
          var key = "m1-copy:" + (lead ? lead.value : "");
          event.preventDefault();
          function send() { form.submit(); }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(box.value).then(function () {
              remember(key, "ok");
              send();
            }, function () {
              remember(key, "fail");
              send();
            });
            return;
          }
          send();
        });
      }

      function noteOf(button) {
        var card = button.closest ? button.closest(".card") : null;
        return card ? card.querySelector("[data-copy-state]") : null;
      }
      var copies = document.querySelectorAll("[data-copy]");
      for (var j = 0; j < copies.length; j++) {
        copies[j].addEventListener("click", function () {
          var box = document.getElementById(this.getAttribute("data-copy"));
          if (!box) return;
          var note = noteOf(this);
          box.focus();
          box.select();
          function copied() { if (note) note.textContent = "En el portapapeles"; }
          function manual() { if (note) note.textContent = "Mantén pulsado el texto para copiarlo"; }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(box.value).then(copied, manual);
            return;
          }
          try { if (document.execCommand("copy")) return copied(); } catch (e) {}
          manual();
        });
      }
    })();
  </script>`;

/**
 * The deck: one card at a time, paged with buttons and the arrow keys, and a
 * queue switcher on top.
 *
 * The markup is a complete list before this runs — every section and every card
 * is rendered by the server — so the script only hides what the artboard does
 * not show. The arrows stay out of the way of anything being typed in: a phone
 * keyboard moves the caret with them, and a deck that pages while somebody
 * edits a reply is the one bug this page cannot afford.
 */
const DECK_SCRIPT = `<script>
    (function () {
      var root = document.querySelector("[data-deck]");
      if (!root) return;
      var sections = Array.prototype.slice.call(root.querySelectorAll("section[data-queue]"));
      var chrome = Array.prototype.slice.call(document.querySelectorAll("[data-deck-chrome]"));
      var pos = root.querySelector("[data-pos]");
      var count = root.querySelector("[data-count]");
      var fill = root.querySelector("[data-fill]");
      var hint = root.querySelector("[data-hint]");
      var qname = root.querySelector("[data-queue-name]");
      // Set while a queue link closes the sheet: focus goes to the new card, not back to «Colas».
      var landing = false;
      var prev = root.querySelector("[data-prev]");
      var next = root.querySelector("[data-next]");
      var sheet = document.getElementById("queue-sheet");
      var opener = root.querySelector("[data-queue-open]");
      var active = root.getAttribute("data-default-queue") || "drafts";
      var index = 0;

      function sectionFor(name) {
        for (var i = 0; i < sections.length; i++) {
          if (sections[i].getAttribute("data-queue") === name) return sections[i];
        }
        return sections[0];
      }
      function cardsIn(section) {
        return Array.prototype.slice.call(section.querySelectorAll("[data-card]"));
      }
      function draw(moveFocus) {
        var section = sectionFor(active);
        var cards = cardsIn(section);
        if (index > cards.length - 1) index = cards.length - 1;
        if (index < 0) index = 0;
        for (var s = 0; s < sections.length; s++) {
          sections[s].hidden = sections[s] !== section;
        }
        for (var c = 0; c < cards.length; c++) {
          cards[c].hidden = c !== index;
        }
        var total = cards.length;
        if (qname) qname.textContent = section.getAttribute("data-queue-title") || "";
        if (pos) pos.textContent = total === 0 ? "Nada pendiente" : (index + 1) + " de " + total;
        if (count) count.textContent = total === 0 ? "—" : (index + 1) + " / " + total;
        if (fill) fill.style.width = total === 0 ? "0" : Math.round(((index + 1) / total) * 100) + "%";
        if (prev) prev.disabled = index <= 0;
        if (next) next.disabled = index >= total - 1;
        var links = root.querySelectorAll("[data-queue-link]");
        for (var l = 0; l < links.length; l++) {
          links[l].setAttribute(
            "aria-current",
            String(links[l].getAttribute("data-queue-link") === active),
          );
        }
        if (!hint) return;
        // The chip already carries the urgency in words; the bar repeats it.
        var chip = cards[index] ? cards[index].querySelector(".tag.warn, .tag") : null;
        hint.textContent = chip ? chip.textContent.trim() : "";
        if (!moveFocus || !cards[index]) return;
        var head = cards[index].querySelector("h3");
        if (head) head.focus({ preventScroll: true });
        window.scrollTo(0, 0);
        cards[index].style.animation = "none";
        void cards[index].offsetWidth;
        cards[index].style.animation = "";
      }
      function choose(name) {
        active = name;
        index = 0;
        draw(true);
      }
      function openSheet() {
        if (!sheet) return;
        if (typeof sheet.showModal === "function") sheet.showModal();
        else sheet.setAttribute("open", "");
        if (opener) opener.setAttribute("aria-expanded", "true");
      }
      function closeSheet() {
        if (!sheet) return;
        if (typeof sheet.close === "function") sheet.close();
        else {
          sheet.removeAttribute("open");
          afterClose();
        }
        if (opener) opener.setAttribute("aria-expanded", "false");
      }
      function afterClose() {
        if (opener) {
          opener.setAttribute("aria-expanded", "false");
          if (!landing) opener.focus();
        }
        landing = false;
      }

      if (prev) prev.addEventListener("click", function () { index -= 1; draw(true); });
      if (next) next.addEventListener("click", function () { index += 1; draw(true); });
      if (opener) opener.addEventListener("click", openSheet);
      if (sheet) {
        // A native dialog returns focus on its own; taking it back explicitly
        // keeps the fallback path and the modal path behaving the same.
        sheet.addEventListener("close", afterClose);
        sheet.addEventListener("click", function (event) {
          if (event.target === sheet) closeSheet();
        });
        var closes = sheet.querySelectorAll("[data-queue-close]");
        for (var c = 0; c < closes.length; c++) {
          closes[c].addEventListener("click", closeSheet);
        }
        var links = sheet.querySelectorAll("[data-queue-link]");
        for (var q = 0; q < links.length; q++) {
          links[q].addEventListener("click", function () {
            var name = this.getAttribute("data-queue-link");
            landing = true;
            closeSheet();
            choose(name);
          });
        }
      }

      document.addEventListener("keydown", function (event) {
        if (sheet && (sheet.open || sheet.hasAttribute("open"))) {
          // A real dialog closes on Escape; the fallback does not.
          if (event.key === "Escape") closeSheet();
          return;
        }
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        var tag = event.target && event.target.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
        if (event.target && event.target.isContentEditable) return;
        if (event.key === "ArrowRight") { index += 1; draw(true); }
        else if (event.key === "ArrowLeft") { index -= 1; draw(true); }
      });

      for (var w = 0; w < chrome.length; w++) chrome[w].removeAttribute("hidden");
      root.setAttribute("data-deck-ready", "1");
      draw(false);
    })();
  </script>`;

/**
 * Coming back from Instagram refreshes the page so the queue is current and the
 * first card is the next uncopied lead.
 *
 * Reloading on every return would throw away a draft somebody was editing, so a
 * touched box disables it for that visit. `pageshow` covers the back-forward
 * cache, where the DOM is restored without asking the server and the copied lead
 * would otherwise still be sitting on top.
 */
const REFRESH_SCRIPT = `<script>
    (function () {
      if ("scrollRestoration" in history) history.scrollRestoration = "manual";
      var dirty = false;
      document.addEventListener("input", function (event) {
        var tag = event.target && event.target.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT") dirty = true;
      }, true);
      function refresh() {
        if (dirty || document.visibilityState !== "visible") return;
        window.scrollTo(0, 0);
        location.reload();
      }
      document.addEventListener("visibilitychange", refresh);
      window.addEventListener("focus", refresh);
      window.addEventListener("pageshow", function (event) {
        if (event.persisted) location.reload();
      });
    })();
  </script>`;

/**
 * The confirmation after "copiar": the thread is registered, the next uncopied
 * lead is already the first card of "M1 por enviar", and this one has moved to
 * "Copiados, esperando confirmación".
 *
 * The clipboard box is offscreen so focusing it cannot scroll the page away from
 * the next lead; the visible preview keeps the line breaks the text was written
 * with. The script copies the box's own value rather than a value interpolated
 * into JavaScript: one string literal less to escape, and what the clipboard
 * gets is exactly what the server hashed. `showPicker`-free, dependency-free,
 * and it degrades to a selected box the person can long-press.
 */
function copiedNotice(c: CopiedM1): string {
  return `<div class="card" style="border-color:var(--ok)">
    <div class="row">
      <h3>Copiado${c.name ? ` para ${esc(c.name)}` : ""} — @${esc(c.handle)}</h3>
      <span><span class="tag" id="m1-copy-state" hidden>En el portapapeles</span><span
        class="tag warn" id="m1-copy-hint">Mantén pulsado el texto para copiarlo</span></span>
    </div>
    <p class="small muted" style="margin:.15rem 0 .5rem">El texto ya está registrado. Abre el
      chat y pégalo: el hilo se reconoce cuando llegue el eco de este texto exacto. El siguiente lead
      está en la cola «M1 por enviar»; este hilo queda en «Copiados, esperando confirmación». Si el
      móvil no ha dejado copiarlo, mantén pulsado el texto de abajo y «Pegar».</p>
    <details><summary class="small muted">Ver el texto copiado</summary>
      <pre class="preview">${esc(c.text)}</pre>
    </details>
    <div class="actions">
      <a class="btn primary" href="${esc(chatUrl(c.handle))}" target="_blank" rel="noopener">Abrir chat con @${esc(c.handle)}</a>
    </div>
    <textarea id="m1-copy" readonly class="offscreen"
      data-copy-key="m1-copy:${esc(c.leadId)}">${esc(c.text)}</textarea>
  </div>
  <script>
    (function () {
      var box = document.getElementById("m1-copy");
      var tag = document.getElementById("m1-copy-state");
      var hint = document.getElementById("m1-copy-hint");
      if (!box || !tag || !hint) return;
      function copied() { tag.hidden = false; hint.hidden = true; }
      function manual() {
        box.classList.remove("offscreen");
        if (box.focus) box.focus({ preventScroll: true });
        box.select();
        tag.hidden = true;
        hint.hidden = false;
      }
      // The key is read from the DOM, not interpolated into this script: a lead
      // id is opaque to this page and must never become JavaScript source.
      var key = box.getAttribute("data-copy-key") || "";
      var state = null;
      try { state = sessionStorage.getItem(key); sessionStorage.removeItem(key); } catch (e) {}
      if (state === "ok") return copied();
      if (state === "fail") return manual();
      // A reload, a bookmark, or a phone that restored the page: no tap to lean
      // on, so the copy is attempted once and only claimed if it resolves.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(box.value).then(copied, manual);
        return;
      }
      try { if (document.execCommand("copy")) return copied(); } catch (e) {}
      manual();
    })();
  </script>`;
}
