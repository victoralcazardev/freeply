import { describe, expect, it } from "vitest";
import { prospectsPage } from "../../src/prospects-page";

/* Independent probe: render /prospects with hostile and multi-card data from
   the pure page function, then run the page's own DECK_SCRIPT against a minimal
   DOM shim built by parsing that markup. Nothing here touches D1. */

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>"'&</textarea>`;

function T(o: any = {}) {
  return {
    leadId: "lead-1", igUserId: "ig", igsid: null, handle: "lead_1", name: "Ana",
    nicho: "nicho", state: "enrolled", m1Sha: null, m1RegisteredAt: NOW - 2 * HOUR,
    version: 1, lastInboundAt: NOW - 21 * HOUR, lastOutboundAt: NOW - 22 * HOUR, ...o,
  };
}
function D(o: any = {}) {
  return {
    draftId: "draft-1", leadId: "lead-1", kind: "reply", stage: "Filtro", text: "texto",
    baseVersion: 0, variantId: null, status: "waiting", decidedAt: null, decidedText: null,
    createdAt: NOW, ...o,
  };
}
function M(o: any = {}) {
  return {
    mid: "mid-1", leadId: "lead-1", direction: "in", origin: "webhook", text: "hola",
    sentAt: NOW - 21 * HOUR, draftedAt: null, answeredAt: null, ...o,
  };
}

function data(over: any = {}) {
  return {
    host: "freeply.test", now: NOW,
    pending: [], copied: [], unconfirmed: [], followups: [], drafts: [], manual: [],
    overdue: [], justCopied: null, ...over,
  } as any;
}

async function render(d: any): Promise<string> {
  const res = prospectsPage(d);
  return await res.text();
}

/* ---------------------------------------------------------------- escaping */

describe("probe: escaping", () => {
  it("escapes every user string in every card type", async () => {
    const page = await render(data({
      pending: [{ thread: T({ leadId: "p1", handle: HOSTILE, name: HOSTILE, nicho: HOSTILE }), text: HOSTILE }],
      copied: [{ thread: T({ leadId: "c1", handle: HOSTILE, name: null, nicho: HOSTILE }), text: HOSTILE }],
      unconfirmed: [{ thread: T({ leadId: "u1", handle: HOSTILE, name: HOSTILE }), text: null }],
      followups: [
        { thread: T({ leadId: "f1", handle: HOSTILE, name: HOSTILE }), step: "toque", days: 3 },
        { thread: T({ leadId: "f2", handle: HOSTILE, name: HOSTILE }), step: "dm", days: 7 },
      ],
      drafts: [{ thread: T({ leadId: "d1", handle: HOSTILE, name: HOSTILE }), draft: D({ text: HOSTILE, stage: HOSTILE }), inbound: M({ text: HOSTILE }) }],
      manual: [{ thread: T({ leadId: "m1", handle: HOSTILE, name: HOSTILE }), draft: D({ text: HOSTILE }), inbound: M({ text: HOSTILE }), reason: "window_closed" }],
      overdue: [{ thread: T({ leadId: "o1", handle: HOSTILE, name: HOSTILE }), inbound: M({ text: HOSTILE }), messages: [] }],
    }));
    // No user string may reach the parser as markup or as an attribute break.
    expect(page).not.toContain("<img src=x");
    expect(page).not.toContain("<script>alert(2)");
    expect(page).not.toContain("</textarea><script>");
    expect(page).not.toContain(`" onerror="`);
    expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    // The only <script> tags are the page's own four (COPY, DECK, REFRESH, notice).
    const scripts = page.match(/<script>/g) ?? [];
    expect(scripts.length).toBe(3);
  });

  it("keeps a hostile handle out of the chat href attributes it builds", async () => {
    const page = await render(data({
      pending: [{ thread: T({ leadId: "p1", handle: `x" onmouseover="alert(1)`, name: null }), text: "t" }],
    }));
    expect(page).not.toContain(` onmouseover="alert(1)"`);
    expect(page).toContain("https://ig.me/m/x%22%20onmouseover%3D%22alert(1)");
  });
});

/* ------------------------------------------------------------ form contract */

describe("probe: form contract", () => {
  it("still submits the same fields for every card type", async () => {
    const page = await render(data({
      pending: [{ thread: T({ leadId: "p1" }), text: "M1 texto" }],
      copied: [{ thread: T({ leadId: "c1" }), text: "copiado" }],
      unconfirmed: [{ thread: T({ leadId: "u1" }), text: null }],
      followups: [
        { thread: T({ leadId: "f1" }), step: "toque", days: 3 },
        { thread: T({ leadId: "f2" }), step: "dm", days: 7 },
      ],
      drafts: [{ thread: T({ leadId: "d1" }), draft: D({ draftId: "dd1" }), inbound: M() }],
      manual: [{ thread: T({ leadId: "m1" }), draft: D({ draftId: "dm1" }), inbound: M(), reason: "window_closed" }],
      overdue: [{ thread: T({ leadId: "o1" }), inbound: M(), messages: [] }],
    }));
    const q = (id: string) => {
      const s = page.indexOf(`<section id="${id}"`);
      expect(s).toBeGreaterThan(-1);
      const e = page.indexOf("</section>", s);
      return page.slice(s, e);
    };
    const m1 = q("m1-por-enviar");
    expect(m1).toContain('<form method="post" action="/prospects/m1">');
    expect(m1).toContain('name="lead_id" value="p1"');
    expect(m1).toContain('<textarea id="m1-text-0" name="text" rows="5">M1 texto</textarea>');
    expect(m1).toContain('type="submit" data-copy-submit="m1-text-0"');

    const un = q("m1-sin-confirmar");
    expect(un).toContain('<form method="post" action="/prospects/m1/retry">');
    expect(un).toContain('name="lead_id" value="u1"');

    const dr = q("borradores");
    expect(dr).toContain('<form method="post" action="/prospects/drafts">');
    expect(dr).toContain('name="draft_id" value="dd1"');
    expect(dr).toContain('<textarea id="draft-text-0" name="text" rows="6">');
    expect(dr).toContain('name="action" value="approve"');
    expect(dr).toContain('name="action" value="skip"');

    const ma = q("manual");
    expect(ma).toContain('<form method="post" action="/prospects/drafts">');
    expect(ma).toContain('name="draft_id" value="dm1"');
    expect(ma).toContain('name="action" value="sent"');
    expect(ma).toContain('name="action" value="skip"');

    const fu = q("seguimientos");
    expect(fu).toContain('<form method="post" action="/prospects/followups">');
    expect(fu).toContain('name="action" value="touch"');
    expect(fu).toContain('name="action" value="followup"');
    expect(fu).toContain('<button type="button" data-copy="followup-text-1">Copiar</button>');

    for (const id of ["m1-por-enviar", "m1-sin-confirmar", "m1-copiados", "borradores", "seguimientos", "manual"]) {
      const queue = q(id);
      expect(queue, id).toContain('<form class="close-form" method="post" action="/prospects/close"');
      expect(queue, id).toContain('name="lead_id"');
      expect(queue, id).toContain('name="reason" value="no_interesa"');
      expect(queue, id).toContain("return confirm(");
    }
  });

  it("keeps the copied notice's clipboard box and chat link", async () => {
    const page = await render(data({
      justCopied: { leadId: "lead-9", handle: "lead_9", text: "texto copiado" },
    }));
    expect(page).toContain('id="m1-copy"');
    expect(page).toContain('data-copy-key="m1-copy:lead-9"');
    expect(page).toContain("https://ig.me/m/lead_9");
  });
});

/* ------------------------------------------------------------------- deck */

/* A DOM shim just large enough for DECK_SCRIPT: attributes, classes, children,
   events, focus, and the four selectors the script uses. */
let focused: any = null;

class El {
  tagName: string;
  attrs: Record<string, string> = {};
  children: El[] = [];
  parent: El | null = null;
  listeners: Record<string, Function[]> = {};
  style: Record<string, any> = {};
  ownText = "";
  disabled = false;
  open = false;

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get hidden() { return "hidden" in this.attrs; }
  set hidden(v: boolean) { if (v) this.attrs.hidden = ""; else delete this.attrs.hidden; }
  getAttribute(n: string) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n: string, v: any) { this.attrs[n] = String(v); }
  hasAttribute(n: string) { return n in this.attrs; }
  removeAttribute(n: string) { delete this.attrs[n]; }
  get offsetWidth() { return 0; }
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) { this.ownText = String(v); this.children = []; }
  focus() { focused = this; }
  addEventListener(t: string, f: Function) { (this.listeners[t] ||= []).push(f); }
  dispatch(t: string, ev: any = {}) {
    for (const f of this.listeners[t] || []) f.call(this, ev);
  }
  matches(sel: string) { return parseSel(sel).some((s) => matchOne(this, s)); }
  querySelectorAll(sel: string): El[] {
    const out: El[] = [];
    const walk = (node: El) => {
      for (const kid of node.children) {
        if (kid.matches(sel)) out.push(kid);
        walk(kid);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel: string): El | null {
    let n: El | null = this;
    while (n) { if (n.matches(sel)) return n; n = n.parent; }
    return null;
  }
}

function parseSel(sel: string) {
  return sel.split(",").map((raw) => {
    const s = raw.trim();
    const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(s);
    if (!m) throw new Error("unsupported selector: " + s);
    const classes = m[2] ? m[2].slice(1).split(".") : [];
    const attrs = [...m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((x) => [x[1], x[2]]);
    return { tag: m[1] || null, classes, attrs };
  });
}
function matchOne(el: El, spec: ReturnType<typeof parseSel>[number]) {
  if (spec.tag && el.tagName !== spec.tag.toUpperCase()) return false;
  const cls = (el.attrs.class || "").split(/\s+/);
  for (const c of spec.classes) if (!cls.includes(c)) return false;
  for (const [n, v] of spec.attrs) {
    if (!(n in el.attrs)) return false;
    if (v !== undefined && el.attrs[n] !== v) return false;
  }
  return true;
}

const VOID = new Set(["meta", "input", "br", "img", "link", "hr"]);

function parseHtml(source: string): El {
  const root = new El("#doc");
  const stack: El[] = [root];
  let i = 0;
  const addText = (t: string) => { stack[stack.length - 1].ownText += t; };
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) { addText(source.slice(i)); break; }
    if (lt > i) addText(source.slice(i, lt));
    if (source.startsWith("<!--", lt)) { i = source.indexOf("-->", lt) + 3; continue; }
    if (source.startsWith("<!", lt)) { i = source.indexOf(">", lt) + 1; continue; }
    let gt = lt + 1;
    let quote: string | null = null;
    for (; gt < source.length; gt++) {
      const ch = source[gt];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    const raw = source.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith("/")) { stack.pop(); continue; }
    const selfClose = raw.endsWith("/");
    const body = selfClose ? raw.slice(0, -1) : raw;
    const nameMatch = /^([a-zA-Z][\w-]*)/.exec(body)!;
    const tag = nameMatch[1];
    const el = new El(tag);
    for (const a of body.slice(tag.length).matchAll(/([^\s=\/]+)(?:="([^"]*)")?/g)) {
      el.attrs[a[1]] = a[2] ?? "";
    }
    stack[stack.length - 1].children.push(el);
    el.parent = stack[stack.length - 1];
    const lower = tag.toLowerCase();
    if (lower === "script" || lower === "style") {
      const close = source.toLowerCase().indexOf("</" + lower, i);
      i = source.indexOf(">", close) + 1;
      continue;
    }
    if (!selfClose && !VOID.has(lower)) stack.push(el);
  }
  return root;
}

function deckScript(page: string): string {
  const marker = 'var root = document.querySelector("[data-deck]")';
  const at = page.indexOf(marker);
  expect(at, "DECK_SCRIPT not found").toBeGreaterThan(-1);
  const open = page.lastIndexOf("<script>", at) + "<script>".length;
  const close = page.indexOf("</script>", at);
  return page.slice(open, close);
}

function harness(page: string) {
  focused = null;
  const root = parseHtml(page);
  const doc = {
    visibilityState: "visible",
    listeners: {} as Record<string, Function[]>,
    querySelector: (s: string) => root.querySelector(s),
    querySelectorAll: (s: string) => root.querySelectorAll(s),
    getElementById(id: string) {
      const all: El[] = [];
      const walk = (n: El) => { for (const k of n.children) { all.push(k); walk(k); } };
      walk(root);
      return all.find((e) => e.attrs.id === id) ?? null;
    },
    addEventListener(t: string, f: Function) { (this.listeners[t] ||= []).push(f); },
    fire(t: string, ev: any) { for (const f of this.listeners[t] || []) f(ev); },
  };
  const win = { scrollTo() {}, addEventListener() {} };
  const code = deckScript(page);
  new Function("document", "window", "history", "location", "navigator", code)(doc, win, {}, {}, {});
  return { root, doc, focus: () => focused };
}

function fullPage(): any {
  return data({
    pending: [
      { thread: T({ leadId: "p1", handle: "lead_a", name: "Ana" }), text: "uno" },
      { thread: T({ leadId: "p2", handle: "lead_b", name: "Bea" }), text: "dos" },
    ],
    unconfirmed: [{ thread: T({ leadId: "u1", handle: "lead_c" }), text: null }],
    copied: [{ thread: T({ leadId: "c1", handle: "lead_d" }), text: "copiado" }],
    followups: [{ thread: T({ leadId: "f1", handle: "lead_e" }), step: "toque", days: 3 }],
    drafts: [
      { thread: T({ leadId: "d1", handle: "lead_f", name: "Ce" }), draft: D({ draftId: "dd1", text: "r1" }), inbound: M({ text: "m1" }) },
      { thread: T({ leadId: "d2", handle: "lead_g", name: "Di" }), draft: D({ draftId: "dd2", text: "r2" }), inbound: M({ text: "m2" }) },
      { thread: T({ leadId: "d3", handle: "lead_h", name: "El" }), draft: D({ draftId: "dd3", text: "r3" }), inbound: M({ text: "m3" }) },
    ],
    manual: [{ thread: T({ leadId: "m1", handle: "lead_i" }), draft: D({ draftId: "dm1" }), inbound: M(), reason: "window_closed" }],
  });
}

describe("probe: DECK_SCRIPT behaviour", () => {
  it("opens on drafts, hides every other queue and card, and wires the chrome", async () => {
    const page = await render(fullPage());
    // No-JS markup: nothing hidden by the server, chrome waits for the script.
    expect(page).not.toMatch(/<section[^>]*data-queue[^>]* hidden/);
    expect(page).not.toMatch(/<div class="card"[^>]* hidden/);
    expect(page).toContain("data-deck-chrome hidden");
    expect(page).toContain('data-default-queue="drafts"');

    const { root, focus } = harness(page);
    const sections = root.querySelectorAll("section[data-queue]");
    expect(sections.length).toBe(6);
    const visible = sections.filter((s) => !s.hidden);
    expect(visible.map((s) => s.getAttribute("data-queue"))).toEqual(["drafts"]);
    const cards = visible[0].querySelectorAll("[data-card]");
    expect(cards.filter((c) => !c.hidden).length).toBe(1);
    expect(cards[0].querySelector("h3")!.textContent).toBe("Ce");
    expect(root.querySelector("[data-pos]")!.textContent).toBe("1 de 3");
    expect(root.querySelector("[data-count]")!.textContent).toBe("1 / 3");
    expect(root.querySelector("[data-fill]")!.style.width).toBe("33%");
    const prev = root.querySelector("[data-prev]")!;
    const next = root.querySelector("[data-next]")!;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    expect(root.querySelector("[data-deck-chrome]")!.hasAttribute("hidden")).toBe(false);
    expect(root.querySelector("[data-pager]")!.hasAttribute("hidden")).toBe(false);
    expect(root.querySelector("[data-deck]")!.hasAttribute("data-deck-ready")).toBe(true);
    expect(focus()).toBe(null); // initial draw never steals focus
  });

  it("clamps prev/next at both ends and never goes out of range", async () => {
    const { root } = harness(await render(fullPage()));
    const prev = root.querySelector("[data-prev]")!;
    const next = root.querySelector("[data-next]")!;
    prev.dispatch("click", {});
    expect(root.querySelector("[data-pos]")!.textContent).toBe("1 de 3");
    next.dispatch("click", {}); next.dispatch("click", {});
    expect(root.querySelector("[data-pos]")!.textContent).toBe("3 de 3");
    expect(root.querySelector("[data-fill]")!.style.width).toBe("100%");
    expect(next.disabled).toBe(true);
    next.dispatch("click", {}); next.dispatch("click", {});
    expect(root.querySelector("[data-pos]")!.textContent).toBe("3 de 3");
    prev.dispatch("click", {}); prev.dispatch("click", {}); prev.dispatch("click", {});
    expect(root.querySelector("[data-pos]")!.textContent).toBe("1 de 3");
    expect(prev.disabled).toBe(true);
  });

  it("honours the arrow keys, but not while a text box or a modifier is in play", async () => {
    const { root, doc } = harness(await render(fullPage()));
    const textarea = root.querySelector("textarea")!;
    const editable = new El("div");
    editable.attrs.contenteditable = "true";
    (editable as any).isContentEditable = true;
    const pos = () => root.querySelector("[data-pos]")!.textContent;

    doc.fire("keydown", { key: "ArrowRight", target: textarea });
    expect(pos()).toBe("1 de 3");
    doc.fire("keydown", { key: "ArrowRight", target: editable });
    expect(pos()).toBe("1 de 3");
    doc.fire("keydown", { key: "ArrowRight", target: root, ctrlKey: true });
    expect(pos()).toBe("1 de 3");
    doc.fire("keydown", { key: "ArrowRight", target: root, altKey: true });
    expect(pos()).toBe("1 de 3");

    doc.fire("keydown", { key: "ArrowRight", target: root });
    expect(pos()).toBe("2 de 3");
    doc.fire("keydown", { key: "ArrowLeft", target: root });
    expect(pos()).toBe("1 de 3");
    doc.fire("keydown", { key: "ArrowLeft", target: root });
    expect(pos()).toBe("1 de 3");
  });

  it("opens the queue sheet, closes it on Escape and gives focus back", async () => {
    const { root, doc, focus } = harness(await render(fullPage()));
    const sheet: any = root.querySelector("dialog")!;
    let modal = 0;
    sheet.showModal = function () { modal++; this.open = true; this.setAttribute("open", ""); };
    sheet.close = function () {
      this.open = false; this.removeAttribute("open");
      this.dispatch("close", {});
    };
    const opener = root.querySelector("[data-queue-open]")!;
    opener.dispatch("click", { target: opener });
    expect(modal).toBe(1);
    expect(sheet.open).toBe(true);
    expect(opener.getAttribute("aria-expanded")).toBe("true");

    doc.fire("keydown", { key: "Escape", target: root });
    expect(sheet.open).toBe(false);
    expect(opener.getAttribute("aria-expanded")).toBe("false");
    expect(focus()).toBe(opener);
  });

  it("switches queue from the sheet and resets to its first card", async () => {
    const { root } = harness(await render(fullPage()));
    const sheet: any = root.querySelector("dialog")!;
    sheet.showModal = function () { this.open = true; this.setAttribute("open", ""); };
    sheet.close = function () { this.open = false; this.removeAttribute("open"); this.dispatch("close", {}); };
    root.querySelector("[data-queue-open]")!.dispatch("click", {});
    const link = root.querySelectorAll("[data-queue-link]").find((l) => l.attrs["data-queue-link"] === "manual")!;
    link.dispatch("click", {});
    const visible = root.querySelectorAll("section[data-queue]").filter((s) => !s.hidden);
    expect(visible.map((s) => s.getAttribute("data-queue"))).toEqual(["manual"]);
    expect(root.querySelector("[data-pos]")!.textContent).toBe("1 de 1");
    expect(link.getAttribute("aria-current")).toBe("true");
    expect(root.querySelector("[data-prev]")!.disabled).toBe(true);
    expect(root.querySelector("[data-next]")!.disabled).toBe(true);
    expect(sheet.open).toBe(false);
  });

  it("lands on the chosen queue's card and names the queue, not back on «Colas»", async () => {
    const { root, focus } = harness(await render(fullPage()));
    const sheet: any = root.querySelector("dialog")!;
    sheet.showModal = function () { this.open = true; this.setAttribute("open", ""); };
    sheet.close = function () { this.open = false; this.removeAttribute("open"); this.dispatch("close", {}); };
    const name = root.querySelector("[data-queue-name]")!;
    const drafts = root.querySelectorAll("section[data-queue]").find((s) => s.getAttribute("data-queue") === "drafts")!;
    expect(name.textContent).toBe(drafts.getAttribute("data-queue-title"));
    root.querySelector("[data-queue-open]")!.dispatch("click", {});
    root.querySelectorAll("[data-queue-link]").find((l) => l.attrs["data-queue-link"] === "manual")!.dispatch("click", {});
    const manual = root.querySelectorAll("section[data-queue]").find((s) => s.getAttribute("data-queue") === "manual")!;
    expect(name.textContent).toBe(manual.getAttribute("data-queue-title"));
    expect(name.textContent).not.toBe("");
    expect(focus()).toBe(manual.querySelector("h3"));
  });

  it("runs without a card and without a queue to page", async () => {
    const page = await render(data({}));
    expect(page).toContain("No hay nada pendiente");
    const { root } = harness(page);
    const sections = root.querySelectorAll("section[data-queue]");
    expect(sections.filter((s) => !s.hidden).map((s) => s.attrs["data-queue"])).toEqual(["drafts"]);
    expect(root.querySelector("[data-pos]")!.textContent).toBe("Nada pendiente");
    expect(root.querySelector("[data-count]")!.textContent).toBe("—");
    expect(root.querySelector("[data-prev]")!.disabled).toBe(true);
    expect(root.querySelector("[data-next]")!.disabled).toBe(true);
    // The switcher says so instead of listing nothing.
    expect(root.querySelector("dialog")!.textContent).toContain("Ahora mismo no hay trabajo en ninguna cola.");
  });

  it("still starts on the send queue when no reply draft is waiting", async () => {
    const page = await render(data({
      pending: [
        { thread: T({ leadId: "p1" }), text: "uno" },
        { thread: T({ leadId: "p2" }), text: "dos" },
      ],
    }));
    expect(page).toContain('data-default-queue="m1"');
    const { root } = harness(page);
    expect(root.querySelectorAll("section[data-queue]").filter((s) => !s.hidden).map((s) => s.attrs["data-queue"])).toEqual(["m1"]);
  });
});

describe("deck: native close ordering", () => {
  it("keeps focus on the chosen card when close fires asynchronously, then resets landing", async () => {
    const { root, doc, focus } = harness(await render(fullPage()));
    const sheet: any = root.querySelector("dialog")!;
    const opener = root.querySelector("[data-queue-open]")!;
    sheet.showModal = function () { this.open = true; this.setAttribute("open", ""); };
    sheet.close = function () {
      this.open = false; this.removeAttribute("open"); opener.focus();
      setTimeout(() => this.dispatch("close", {}), 0);
    };
    opener.dispatch("click", {});
    root.querySelectorAll("[data-queue-link]").find((l) => l.attrs["data-queue-link"] === "manual")!.dispatch("click", {});
    const manual = root.querySelectorAll("section[data-queue]").find((s) => s.getAttribute("data-queue") === "manual")!;
    expect(focus()).toBe(manual.querySelector("h3"));
    await new Promise((r) => setTimeout(r, 5));
    expect(focus()).toBe(manual.querySelector("h3"));
    opener.dispatch("click", {});
    sheet.close = function () { this.open = false; this.removeAttribute("open"); setTimeout(() => this.dispatch("close", {}), 0); };
    doc.fire("keydown", { key: "Escape", target: root });
    await new Promise((r) => setTimeout(r, 5));
    expect(focus()).toBe(opener);
  });

  it("resets landing on the fallback path with no close()", async () => {
    const { root, doc, focus } = harness(await render(fullPage()));
    const sheet: any = root.querySelector("dialog")!;
    const opener = root.querySelector("[data-queue-open]")!;
    sheet.showModal = function () { this.open = true; this.setAttribute("open", ""); };
    delete sheet.close;
    opener.dispatch("click", {});
    root.querySelectorAll("[data-queue-link]").find((l) => l.attrs["data-queue-link"] === "manual")!.dispatch("click", {});
    const manual = root.querySelectorAll("section[data-queue]").find((s) => s.getAttribute("data-queue") === "manual")!;
    expect(focus()).toBe(manual.querySelector("h3"));
    opener.dispatch("click", {});
    doc.fire("keydown", { key: "Escape", target: root });
    expect(focus()).toBe(opener);
  });
});
