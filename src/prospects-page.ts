import { chrome, esc } from "./dashboard";
import * as db from "./db";
import type { Env } from "./index";
import { approveProspectDraft, closeProspectThread, registerExpectedM1 } from "./prospects";
import type { ProspectBlockCode, ProspectSendOutcome } from "./prospects-send";

/**
 * The mobile page for the daily sessions (S8): five queues over the threads the
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
 */

const CSS = `
.wrap { padding: 1rem .9rem 4rem; }
.queue { display: grid; gap: .6rem; }
h2 { margin-top: 1.8rem; }
.card h3 { font-size: .98rem; margin: 0; font-weight: 600; }
.card textarea { font-size: 16px; white-space: pre-wrap; } /* below this iOS zooms the page on focus */
.preview { white-space: pre-wrap; overflow-wrap: anywhere; margin: .4rem 0 0; }
.offscreen { position: fixed; top: -1000px; left: 0; width: 1px; height: 1px; opacity: 0; }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .6rem; }
.actions > * { flex: 1 1 9rem; }
.actions > a { display: flex; }
.actions button { width: 100%; padding: .6rem .9rem; }
details.queue > summary { cursor: pointer; }
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

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
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
  if (url.pathname === "/prospects" && request.method === "GET") return render(env, url, {});
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "").trim();

  if (url.pathname === "/prospects/m1") {
    return copyM1(env, url, field("lead_id"), String(form.get("text") ?? "").trim());
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

async function render(
  env: Env,
  url: URL,
  extra: { copied?: CopiedM1; status?: string; error?: string },
): Promise<Response> {
  const now = Date.now();
  const [m1, followups, drafts, manual, work] = await Promise.all([
    db.prospectM1Queue(env.DB, now),
    db.prospectFollowupQueue(env.DB, now),
    db.prospectDraftQueue(env.DB, now),
    db.prospectManualQueue(env.DB, now),
    db.prospectWork(env.DB, OVERDUE_LIMIT),
  ]);
  const justCopied = extra.copied ?? null;
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
    status: extra.status ?? url.searchParams.get("status") ?? undefined,
    error: extra.error ?? url.searchParams.get("error") ?? undefined,
  });
}

/**
 * "Copiar" on the send queue: register the final text, then let the browser copy
 * it. The order is the whole point — registering is what makes the echo legible,
 * and copying first would leave a message nobody can recognise.
 */
async function copyM1(env: Env, url: URL, leadId: string, text: string): Promise<Response> {
  if (!text) return problem("El mensaje está vacío.");

  const result = await registerExpectedM1(env.DB, leadId, text);
  if (!result.ok) return problem(M1_ERRORS[result.error]);

  return render(env, url, {
    copied: { leadId, handle: result.thread.handle, name: result.thread.name, text },
  });
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

  const decided = await db.decideProspectDraft(env.DB, {
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
  /** Copied less than 30 min ago; collapsed at the bottom of the M1 queues. */
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

export function prospectsPage(d: ProspectsPageData): Response {
  return chrome({
    host: d.host,
    tab: "prospects",
    title: "Prospectos",
    lang: "es",
    css: CSS,
    body: `
      ${d.error ? `<div class="alert">${esc(d.error)}</div>` : ""}
      ${d.status ? `<div class="card" style="border-color:var(--ok)">${esc(d.status)}</div>` : ""}
      ${d.justCopied ? copiedNotice(d.justCopied) : ""}

      <section id="m1-por-enviar" class="queue">
        <h2>M1 por enviar <span class="small muted">${d.pending.length}</span></h2>
        ${
          d.pending.length === 0
            ? empty("Nada por enviar.")
            : d.pending.map((item, i) => m1Card(item, d.now, i)).join("")
        }
      </section>

      <section id="m1-sin-confirmar" class="queue">
        <h2>M1 sin confirmar <span class="small muted">${d.unconfirmed.length}</span></h2>
        ${
          d.unconfirmed.length === 0
            ? empty("Ningún M1 esperando su eco.")
            : d.unconfirmed.map((item) => unconfirmedCard(item, d.now)).join("")
        }
      </section>

      <section id="m1-copiados" class="queue">
        <details>
          <summary><h2>Copiados, esperando confirmación
            <span class="small muted">${d.copied.length}</span></h2></summary>
          ${
            d.copied.length === 0
              ? empty("Ninguno esperando el eco.")
              : d.copied.map((item) => copiedWaitingCard(item, d.now)).join("")
          }
        </details>
      </section>

      <section id="seguimientos" class="queue">
        <h2>Seguimientos <span class="small muted">${d.followups.length}</span></h2>
        ${
          d.followups.length === 0
            ? empty("Ningún hilo esperando seguimiento.")
            : d.followups.map((item, i) => followupCard(item, i)).join("") +
              (d.followups.some((i) => i.step === "dm") ? COPY_SCRIPT : "")
        }
      </section>

      <section id="borradores" class="queue">
        <h2>Borradores <span class="small muted">${d.drafts.length}</span></h2>
        ${
          d.drafts.length === 0
            ? empty("No hay borradores esperando el OK.")
            : d.drafts.map((item, i) => draftCard(item, d.now, i)).join("")
        }
      </section>

      <section id="manual" class="queue">
        <h2>Manual <span class="small muted">${d.manual.length + d.overdue.length}</span></h2>
        ${d.overdue.map((item) => overdueCard(item, d.now)).join("")}
        ${
          d.manual.length === 0 && d.overdue.length === 0
            ? empty("Nada para enviar a mano.")
            : d.manual.map((item) => manualCard(item, d.now)).join("")
        }
      </section>
      ${REFRESH_SCRIPT}`,
  });
}

/** How many undrafted threads the page looks at; a phone shows a session's worth. */
const OVERDUE_LIMIT = 25;

const empty = (text: string) => `<div class="card muted">${esc(text)}</div>`;

const chatUrl = (handle: string) => `https://ig.me/m/${encodeURIComponent(handle)}`;

const title = (name: string | null, handle: string) => esc(name ?? `@${handle}`);

/**
 * "No le interesa" (L62), on every card that still holds a thread.
 *
 * A plain POST with the session cookie, like every other form on this page. The
 * confirm is the browser's own dialog over static text: the label sits next to
 * the action, and closing is permanent, so one tap is too little.
 */
function closeButton(leadId: string): string {
  return `<form method="post" action="/prospects/close"
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

function m1Card(item: db.ProspectM1Item, now: number, i: number): string {
  const { thread, text } = item;
  return `<div class="card">
    <h3>${title(thread.name, thread.handle)}</h3>
    <p class="small muted" style="margin:.15rem 0 0">@${esc(thread.handle)}${
      thread.nicho ? ` · ${esc(thread.nicho)}` : ""
    }${
      thread.m1RegisteredAt
        ? ` · <span class="tag">Registrado hace ${ago(now - thread.m1RegisteredAt)}</span>`
        : ""
    }</p>
    <p class="small muted">Opcional: síguela y comenta o responde a una story ≥24 h antes. Nada lo
      bloquea — es una sugerencia para que el primer mensaje no llegue en frío a alguien que nunca
      te ha visto.</p>
    <form method="post" action="/prospects/m1">
      <input type="hidden" name="lead_id" value="${esc(thread.leadId)}">
      <label for="m1-text-${i}">Mensaje <span class="muted">— edítalo antes de copiar</span></label>
      <textarea id="m1-text-${i}" name="text" rows="5">${esc(text ?? "")}</textarea>
      <div class="actions">
        <button class="primary" type="submit">Copiar y registrar</button>
        <a href="${esc(chatUrl(thread.handle))}" target="_blank" rel="noopener">
          <button type="button">Abrir chat</button>
        </a>
      </div>
    </form>
    <p class="small muted">«Copiar» registra el texto y luego lo copia: el hilo se reconoce solo
      cuando llega el eco de ese texto exacto. Si lo cambias después, vuelve a copiarlo.</p>
    ${closeButton(thread.leadId)}
  </div>`;
}

/** One thread in the collapsed "Copiados" section: copied, echo not back yet. */
function copiedWaitingCard(item: db.ProspectM1Item, now: number): string {
  const { thread } = item;
  return `<div class="card">
    <div class="row">
      <h3>${title(thread.name, thread.handle)}</h3>
      <span class="tag">Copiado hace ${ago(now - (thread.m1RegisteredAt ?? now))}</span>
    </div>
    <p class="small muted" style="margin:.15rem 0 .5rem">@${esc(thread.handle)}${
      thread.nicho ? ` · ${esc(thread.nicho)}` : ""
    }</p>
    <p class="small muted">Esperando el eco. Si no llega en 30 min pasa a «M1 sin confirmar».</p>
    ${
      item.text
        ? `<details><summary class="small muted">Ver el texto copiado</summary>
             <pre class="preview">${esc(item.text)}</pre></details>`
        : ""
    }
    ${closeButton(thread.leadId)}
  </div>`;
}

function unconfirmedCard(item: db.ProspectM1Item, now: number): string {
  const { thread } = item;
  return `<div class="card">
    <div class="row">
      <h3>${title(thread.name, thread.handle)}</h3>
      <span class="tag warn">Sin eco</span>
    </div>
    <p class="small muted" style="margin:.15rem 0 .5rem">@${esc(thread.handle)}${
      thread.m1RegisteredAt ? ` · registrado hace ${ago(now - thread.m1RegisteredAt)}` : ""
    }</p>
    <p class="small">El texto copiado no ha vuelto como eco: o no se envió, o se envió con otras
      palabras, o estaba pendiente en dos leads a la vez. Reintentar lo devuelve a la cola con su
      texto; nada se empareja por parecido.</p>
    <form method="post" action="/prospects/m1/retry">
      <input type="hidden" name="lead_id" value="${esc(thread.leadId)}">
      <div class="actions"><button class="primary" type="submit">Reintentar</button></div>
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
  const header = `<h3>${title(thread.name, thread.handle)}</h3>
    <p class="small muted" style="margin:.15rem 0 .5rem">@${esc(thread.handle)}${
      thread.nicho ? ` · ${esc(thread.nicho)}` : ""
    } · sin respuesta desde hace ${days} d</p>`;

  if (step === "toque") {
    return `<div class="card">
    ${header}
    <p class="small">Comenta una publicación suya o responde a una story. Nada de DM nuevo.</p>
    <div class="actions">
      <a href="${esc(profileUrl(thread.handle))}" target="_blank" rel="noopener">
        <button type="button">Abrir perfil</button>
      </a>
    </div>
    <form method="post" action="/prospects/followups">
      <input type="hidden" name="lead_id" value="${esc(thread.leadId)}">
      <input type="hidden" name="action" value="touch">
      <div class="actions"><button class="primary" type="submit">Hecho</button></div>
    </form>
    <p class="small muted">El toque no es un DM: comenta o responde a una story desde tu
      cuenta. «Hecho» solo apunta que lo has hecho; no envía nada.</p>
    ${closeButton(thread.leadId)}
  </div>`;
  }

  return `<div class="card">
    ${header}
    <p class="small">DM de seguimiento: un único mensaje corto, escrito y enviado a mano desde
      el móvil. No repite el M1.</p>
    <label for="followup-text-${i}">Mensaje <span class="muted">— solo para copiarlo</span></label>
    <textarea id="followup-text-${i}" rows="4"></textarea>
    <div class="actions">
      <button type="button" data-copy="followup-text-${i}">Copiar</button>
      <a href="${esc(chatUrl(thread.handle))}" target="_blank" rel="noopener">
        <button type="button">Abrir chat</button>
      </a>
    </div>
    <form method="post" action="/prospects/followups">
      <input type="hidden" name="lead_id" value="${esc(thread.leadId)}">
      <input type="hidden" name="action" value="followup">
      <div class="actions"><button class="primary" type="submit">Enviado</button></div>
    </form>
    <p class="small muted">«Copiar» no guarda ni envía el texto: el mensaje sale de tu móvil.
      «Enviado» apunta el seguimiento para que no se pida dos veces.</p>
    ${closeButton(thread.leadId)}
  </div>`;
}

/**
 * Wires every "Copiar" of the follow-up queue to its own box, once per page.
 *
 * The box is read at click time and nothing is registered: a follow-up DM is
 * already on a thread the echo enrolled, so there is no hash to store and no
 * echo to wait for.
 */
const COPY_SCRIPT = `<script>
    (function () {
      var buttons = document.querySelectorAll("[data-copy]");
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].addEventListener("click", function () {
          var box = document.getElementById(this.getAttribute("data-copy"));
          if (!box) return;
          box.focus();
          box.select();
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(box.value).catch(function () {});
          } else {
            try { document.execCommand("copy"); } catch (e) {}
          }
        });
      }
    })();
  </script>`;

function draftCard(item: db.ProspectQueueItem, now: number, i: number): string {
  const { thread, draft, inbound } = item;
  const waited = thread.lastInboundAt === null ? null : now - thread.lastInboundAt;
  const closing = waited !== null && waited >= db.WINDOW_WARNING_MS;

  return `<div class="card">
    <div class="row">
      <h3>${title(thread.name, thread.handle)}</h3>
      ${
        thread.lastInboundAt !== null
          ? `<span class="tag ${closing ? "warn" : ""}">${
              closing ? "A punto de caducar · " : "" // the 20 h highlight
            }${windowLeft(now, thread.lastInboundAt)}</span>`
          : ""
      }
    </div>
    <p class="small muted" style="margin:.15rem 0 .5rem">@${esc(thread.handle)}${
      draft.stage ? ` · ${esc(draft.stage)}` : ""
    }${waited !== null ? ` · el lead escribió hace ${ago(waited)}` : ""}</p>
    ${inbound ? `<p class="small">«${esc(inbound.text)}»</p>` : ""}
    <form method="post" action="/prospects/drafts">
      <input type="hidden" name="draft_id" value="${esc(draft.draftId)}">
      <label for="draft-text-${i}">Respuesta <span class="muted">— edítala antes de aprobar</span></label>
      <textarea id="draft-text-${i}" name="text" rows="6">${esc(draft.text)}</textarea>
      <div class="actions">
        <button class="primary" name="action" value="approve">Aprobar</button>
        <button name="action" value="skip">Omitir</button>
      </div>
    </form>
    <p class="small muted">Aprobar envía el texto final desde el Worker. Si no puede, la página
      dice por qué. A las 24 h del último mensaje del lead la ventana se cierra y ya no se
      puede contestar.</p>
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

  return `<div class="card">
    <div class="row">
      <h3>${title(thread.name, thread.handle)}</h3>
      <span class="tag warn">${expired ? "Fuera de ventana" : "A punto de caducar"}</span>
    </div>
    <p class="small muted" style="margin:.15rem 0 .5rem">@${esc(thread.handle)} · el lead
      escribió hace ${ago(waited)}</p>
    <p class="small">«${esc(inbound.text)}»</p>
    <p class="small">${
      expired
        ? "La API ya no puede contestar a este mensaje: háblalo desde Instagram."
        : "Todavía se puede contestar por la API, pero queda poco: si no llega un borrador, contéstale desde Instagram."
    }</p>
    <div class="actions">
      <a href="${esc(chatUrl(thread.handle))}" target="_blank" rel="noopener">
        <button type="button">Abrir chat</button>
      </a>
    </div>
    ${closeButton(thread.leadId)}
  </div>`;
}

function manualCard(item: db.ProspectManualItem, now: number): string {
  const { thread, draft, inbound, reason } = item;
  const unknown = reason === "send_state_unknown";

  return `<div class="card">
    <div class="row">
      <h3>${title(thread.name, thread.handle)}</h3>
      <span class="tag warn">${unknown ? "Salida sin confirmar" : "Fuera de ventana"}</span>
    </div>
    <p class="small muted" style="margin:.15rem 0 .5rem">@${esc(thread.handle)}${
      thread.lastInboundAt !== null
        ? ` · el lead escribió hace ${ago(now - thread.lastInboundAt)}`
        : ""
    }</p>
    ${inbound ? `<p class="small">«${esc(inbound.text)}»</p>` : ""}
    <p class="small preview"><b>Para enviar a mano:</b><br>${esc(draft.text)}</p>
    <div class="actions">
      <a href="${esc(chatUrl(thread.handle))}" target="_blank" rel="noopener">
        <button type="button">Abrir chat</button>
      </a>
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
        ? `<p class="small muted">Un corte a media llamada no dice si el mensaje salió, y no se
           reintenta a ciegas: mira el hilo en Instagram y contesta.</p>`
        : ""
    }
    ${closeButton(thread.leadId)}
  </div>`;
}

/**
 * The confirmation after "copiar": the thread is registered, the next uncopied
 * lead is already the first card below, and this one has moved to the collapsed
 * section at the bottom.
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
      <span class="tag">En el portapapeles</span>
    </div>
    <p class="small muted" style="margin:.15rem 0 .5rem">El texto ya está registrado. Abre el
      chat y pégalo: el hilo se reconoce cuando llegue el eco de este texto exacto. El siguiente lead
      está en «M1 por enviar», arriba; este hilo queda en «Copiados, esperando confirmación»,
      al final.</p>
    <details><summary class="small muted">Ver el texto copiado</summary>
      <pre class="preview">${esc(c.text)}</pre>
    </details>
    <div class="actions">
      <a href="${esc(chatUrl(c.handle))}" target="_blank" rel="noopener">
        <button class="primary" type="button">Abrir chat con @${esc(c.handle)}</button>
      </a>
    </div>
    <textarea id="m1-copy" readonly class="offscreen">${esc(c.text)}</textarea>
  </div>
  <script>
    (function () {
      var box = document.getElementById("m1-copy");
      if (!box) return;
      if (box.focus) box.focus({ preventScroll: true });
      box.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(box.value).catch(function () {});
      } else {
        try { document.execCommand("copy"); } catch (e) {}
      }
    })();
  </script>`;
}

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
