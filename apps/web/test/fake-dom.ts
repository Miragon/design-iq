/**
 * A minimal DOM for the chrome modules' focus and ARIA rules (node --test has
 * none): elements with attributes, children, dataset, focus and bubbling
 * events, plus a selector matcher just wide enough for what the modules query
 * — `tag`, `#id`, `.class`, `[attr]`, `[attr="v"]`, `:not(:disabled)`,
 * comma lists and the descendant combinator. Like a browser, it drops the
 * focus on <body> when the focused element leaves the tree, is hidden, or is
 * disabled. No layout: getClientRects() is empty for a hidden subtree or an
 * element a test marks `cssHidden` (what a stylesheet would hide).
 */

type Listener = (e: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  key?: string;
  shiftKey?: boolean;
  target: FakeElement;
  relatedTarget?: FakeElement | null;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

interface Doc {
  activeElement: FakeElement;
  body: FakeElement;
  focused: boolean;
}

let doc: Doc;

const textOf = (n: FakeElement | string): string => (typeof n === "string" ? n : n.textContent);

/** an element and its ancestors, innermost first */
function lineage(el: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  for (let n: FakeElement | null = el; n; n = n.parentElement) out.push(n);
  return out;
}

export class FakeElement {
  readonly tagName: string;
  parentElement: FakeElement | null = null;
  children: Array<FakeElement | string> = [];
  onclick: ((event: { detail: number }) => void) | null = null;
  inert = false;
  /** what a stylesheet hides (display:none) — getClientRects() is empty */
  cssHidden = false;
  /** the layout a test sets where a rule reads it (no layout engine here) */
  offsetTop = 0;
  offsetHeight = 0;
  readonly style = { animation: "", bottom: "", setProperty: (): void => {} };
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();
  private _disabled = false;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  // ── attributes ──
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
    if (k === "hidden") this.blurIfHidden();
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  toggleAttribute(k: string, on?: boolean): boolean {
    const next = on ?? !this.attrs.has(k);
    if (next) this.setAttribute(k, "");
    else this.removeAttribute(k);
    return next;
  }
  get id(): string {
    return this.attrs.get("id") ?? "";
  }
  set id(v: string) {
    this.attrs.set("id", v);
  }
  get className(): string {
    return this.attrs.get("class") ?? "";
  }
  set className(v: string) {
    this.attrs.set("class", v);
  }
  get classList() {
    const list = (): string[] => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c: string) => list().includes(c),
      add: (c: string) => void (this.className = [...new Set([...list(), c])].join(" ")),
      remove: (c: string) =>
        void (this.className = list()
          .filter((x) => x !== c)
          .join(" ")),
      toggle: (c: string, on?: boolean) => {
        const next = on ?? !list().includes(c);
        this.className = next
          ? [...new Set([...list(), c])].join(" ")
          : list()
              .filter((x) => x !== c)
              .join(" ");
        return next;
      },
    };
  }
  get title(): string {
    return this.attrs.get("title") ?? "";
  }
  set title(v: string) {
    this.attrs.set("title", v);
  }
  get hidden(): boolean {
    return this.attrs.has("hidden");
  }
  set hidden(v: boolean) {
    if (v) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }
  get disabled(): boolean {
    return this._disabled;
  }
  set disabled(v: boolean) {
    this._disabled = v;
    // Chrome: a focused control that becomes disabled drops the focus on <body>
    if (v && doc.activeElement === this) doc.activeElement = doc.body;
  }
  get dataset(): Record<string, string | undefined> {
    const toAttr = (k: string): string => `data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    return new Proxy({} as Record<string, string | undefined>, {
      get: (_t, k: string) => this.attrs.get(toAttr(k)),
      set: (_t, k: string, v: string) => (this.setAttribute(toAttr(k), v), true),
      deleteProperty: (_t, k: string) => (this.removeAttribute(toAttr(k)), true),
    });
  }

  // ── the tree ──
  get isConnected(): boolean {
    return lineage(this).at(-1) === doc.body;
  }
  get childElementCount(): number {
    return this.children.filter((c) => typeof c !== "string").length;
  }
  get textContent(): string {
    return this.children.map(textOf).join("");
  }
  set textContent(text: string) {
    this.replaceChildren(...(text ? [text] : []));
  }
  /** an SVG's markup — kept as text, never parsed */
  set innerHTML(_markup: string) {
    this.replaceChildren();
  }
  append(...nodes: Array<FakeElement | string>): void {
    for (const n of nodes) {
      if (typeof n !== "string") {
        n.detach();
        n.parentElement = this;
      }
      this.children.push(n);
    }
  }
  prepend(...nodes: Array<FakeElement | string>): void {
    const rest = this.children;
    this.children = [];
    this.append(...nodes);
    this.children.push(...rest);
  }
  /** inserts right after this node in its parent */
  after(...nodes: FakeElement[]): void {
    const p = this.parentElement;
    if (!p) return;
    for (const n of nodes) n.detach();
    const at = p.children.indexOf(this) + 1;
    for (const n of nodes) n.parentElement = p;
    p.children.splice(at, 0, ...nodes);
  }
  replaceChildren(...nodes: Array<FakeElement | string>): void {
    for (const c of this.children) if (typeof c !== "string") c.orphan();
    this.children = [];
    this.append(...nodes);
  }
  remove(): void {
    this.detach();
    this.dropFocus();
  }
  contains(node: unknown): boolean {
    for (let n = node as FakeElement | null; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  private detach(): void {
    const p = this.parentElement;
    if (!p) return;
    p.children = p.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  private orphan(): void {
    this.parentElement = null;
    this.dropFocus();
  }
  private dropFocus(): void {
    if (this.contains(doc.activeElement)) doc.activeElement = doc.body;
  }
  private blurIfHidden(): void {
    if (this.contains(doc.activeElement)) doc.activeElement = doc.body;
  }

  // ── layout, as far as focus rules need it ──
  getClientRects(): unknown[] {
    if (lineage(this).some((n) => n.hidden || n.cssHidden)) return [];
    return this.isConnected ? [{}] : [];
  }

  // ── focus and events ──
  focus(_opts?: { preventScroll?: boolean }): void {
    if (this._disabled || this.getClientRects().length === 0) return;
    const was = doc.activeElement;
    if (was === this) return;
    doc.activeElement = this;
    was.dispatch({ type: "focusout", relatedTarget: this });
    this.dispatch({ type: "focusin", relatedTarget: was });
  }
  /** `detail` 0 is Enter or Space on a button (and `click()` itself), ≥ 1 a pointer's click */
  click(detail = 0): void {
    if (this._disabled) return;
    this.onclick?.({ detail });
    this.dispatch({ type: "click" });
  }
  addEventListener(type: string, cb: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  removeEventListener(type: string, cb: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== cb),
    );
  }
  /** bubbles from here to the root; returns the event (defaultPrevented) */
  dispatch(init: Partial<FakeEvent> & { type: string }): FakeEvent {
    let stopped = false;
    const e: FakeEvent = {
      ...init,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        e.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
    };
    for (const n of lineage(this)) {
      if (stopped) break;
      for (const l of n.listeners.get(init.type) ?? []) l(e);
    }
    return e;
  }

  // ── selectors ──
  matches(selector: string): boolean {
    return selector.split(",").some((s) => matchComplex(this, s.trim()));
  }
  closest(selector: string): FakeElement | null {
    return lineage(this).find((n) => n.matches(selector)) ?? null;
  }
  private all(): FakeElement[] {
    return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()]));
  }
  querySelector(selector: string): FakeElement | null {
    return this.all().find((n) => n.matches(selector)) ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.all().filter((n) => n.matches(selector));
  }
}

/** `a b` — the last compound on the element, the earlier ones on ancestors */
function matchComplex(el: FakeElement, selector: string): boolean {
  const parts = selector.split(/\s+/).filter(Boolean);
  if (!matchCompound(el, parts[parts.length - 1]!)) return false;
  let i = parts.length - 2;
  for (let n = el.parentElement; n && i >= 0; n = n.parentElement) if (matchCompound(n, parts[i]!)) i--;
  return i < 0;
}

function matchCompound(el: FakeElement, compound: string): boolean {
  let rest = compound;
  const tag = /^[a-z][a-z0-9-]*/i.exec(rest);
  if (tag) {
    if (el.tagName !== tag[0].toUpperCase()) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest) {
    let m: RegExpExecArray | null;
    if ((m = /^#([\w-]+)/.exec(rest))) {
      if (el.id !== m[1]) return false;
    } else if ((m = /^\.([\w-]+)/.exec(rest))) {
      if (!el.classList.contains(m[1]!)) return false;
    } else if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) {
      const v = el.getAttribute(m[1]!);
      if (v === null || (m[2] !== undefined && v !== m[2])) return false;
    } else if ((m = /^:not\(:disabled\)/.exec(rest))) {
      if (el.disabled) return false;
    } else if ((m = /^:disabled/.exec(rest))) {
      if (!el.disabled) return false;
    } else throw new Error(`fake-dom: unsupported selector part '${rest}' in '${compound}'`);
    rest = rest.slice(m[0].length);
  }
  return true;
}

export interface FakeDom {
  body: FakeElement;
  el(tag: string, attrs?: Record<string, string>, parent?: FakeElement): FakeElement;
  active(): FakeElement;
  /** whether the widget document has the focus (document.hasFocus()) */
  setFocused(focused: boolean): void;
  /** a keydown on the focused element, bubbling */
  key(key: string, opts?: { shiftKey?: boolean }): FakeEvent;
}

/** a fresh document on globalThis — call it in each test (or beforeEach) */
export function installFakeDom(): FakeDom {
  const body = new FakeElement("body");
  doc = { activeElement: body, body, focused: true };
  const documentLike = {
    body,
    get activeElement() {
      return doc.activeElement;
    },
    hasFocus: () => doc.focused,
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    getElementById: (id: string) => (body.id === id ? body : body.querySelector(`#${id}`)),
    addEventListener: (type: string, cb: Listener) => body.addEventListener(type, cb),
    removeEventListener: (type: string, cb: Listener) => body.removeEventListener(type, cb),
    querySelector: (s: string) => body.querySelector(s),
  };
  (globalThis as unknown as { document: unknown }).document = documentLike;
  return {
    body,
    el(tag, attrs = {}, parent = body) {
      const n = new FakeElement(tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      parent.append(n);
      return n;
    },
    active: () => doc.activeElement,
    setFocused(focused) {
      doc.focused = focused;
    },
    key: (key, opts = {}) => doc.activeElement.dispatch({ type: "keydown", key, shiftKey: opts.shiftKey ?? false }),
  };
}

/** the fake as the DOM type a module's deps ask for */
export const asEl = <T = HTMLElement>(n: FakeElement): T => n as unknown as T;
