/**
 * The panel shell the Todos and Checks cards share (src/mcp-app/chrome/
 * panel.ts): one panel at a time, focus to the heading and back to the
 * toggle, the Escape layers (the panel's own form first), the compact sheet's
 * collapse with its scroll memory, the fold under a decision card,
 * availability and the toggle badge. Driven
 * through a minimal fake DOM — only what the shell touches.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { PanelSpec } from "../src/mcp-app/chrome/contracts.ts";
import { mountPanels } from "../src/mcp-app/chrome/panel.ts";
import type { Layout } from "../src/mcp-app/core/layout.ts";

// ── a fake DOM, just wide enough for the shell ──────────────────────────────

const fakeDocument = { activeElement: null as FakeEl | null, createElementNS: () => new FakeEl("svg") };

class FakeEl {
  hidden = false;
  id = "";
  className = "";
  scrollTop = 0;
  innerHTML = "";
  onclick: (() => void) | null = null;
  parent: FakeEl | null = null;
  children: Array<FakeEl | string> = [];
  private attrs = new Map<string, string>();
  private keydown: Array<(e: unknown) => void> = [];
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  focus(): void {
    fakeDocument.activeElement = this;
  }
  contains(node: unknown): boolean {
    for (let n = node as FakeEl | null; n; n = n.parent) if (n === this) return true;
    return false;
  }
  append(...nodes: Array<FakeEl | string>): void {
    for (const n of nodes) {
      if (n instanceof FakeEl) n.parent = this;
      this.children.push(n);
    }
  }
  set textContent(text: string) {
    this.children = text ? [text] : [];
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  private all(): FakeEl[] {
    return this.children.flatMap((c) => (c instanceof FakeEl ? [c, ...c.all()] : []));
  }
  private matches(selector: string): boolean {
    return selector.split(",").some((s) => this.className.split(" ").includes(s.trim().replace(/^\./, "")));
  }
  querySelector(selector: string): FakeEl | null {
    return this.all().find((n) => n.matches(selector)) ?? null;
  }
  querySelectorAll(selector: string): FakeEl[] {
    return this.all().filter((n) => n.matches(selector));
  }
  closest(selector: string): FakeEl | null {
    if (selector.includes(this.tag)) return this;
    return this.parent ? this.parent.closest(selector) : null;
  }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    if (type === "keydown") this.keydown.push(cb);
  }
  /** a keydown on `target` bubbling through this element — true when it stopped here */
  pressEscape(target: FakeEl): { prevented: boolean; stopped: boolean } {
    const out = { prevented: false, stopped: false };
    const e = {
      key: "Escape",
      isComposing: false,
      target,
      preventDefault: () => (out.prevented = true),
      stopPropagation: () => (out.stopped = true),
    };
    for (const cb of this.keydown) cb(e);
    return out;
  }
}

(globalThis as unknown as { document: typeof fakeDocument }).document = fakeDocument;

const el = (tag: string, cls = "", parent?: FakeEl): FakeEl => {
  const n = new FakeEl(tag);
  n.className = cls;
  parent?.append(n);
  return n;
};

interface Fixture {
  spec: PanelSpec;
  panel: FakeEl;
  toggle: FakeEl;
  heading: FakeEl;
  scroll: FakeEl;
  input: FakeEl;
  calls: string[];
  form: { open: boolean };
}

function fixture(id: "todos" | "checks"): Fixture {
  const panel = el("aside", "panel");
  panel.id = id;
  panel.hidden = true;
  const heading = el("h2", "", panel);
  const scroll = el("div", "panel-scroll", panel);
  const input = el("input", "input", panel);
  const toggle = el("button", "fb toggle");
  toggle.hidden = true;
  el("span", "count", toggle);
  el("span", "verdict", toggle);
  const calls: string[] = [];
  const form = { open: false };
  const spec = {
    id,
    panel,
    toggle,
    heading,
    escape: () => {
      if (!form.open) return false;
      form.open = false;
      calls.push("form closed");
      return true;
    },
    onOpen: () => calls.push("open"),
    onClose: () => calls.push("close"),
  } as unknown as PanelSpec;
  return { spec, panel, toggle, heading, scroll, input, calls, form };
}

let mode: "card" | "sheet" = "card";
let toolsClosed = 0;
let changes = 0;
const mount = () => {
  const panels = mountPanels({
    layout: () => ({ panel: { mode, width: 320 } }) as Layout,
    closeTools: () => void toolsClosed++,
  });
  panels.onChange(() => changes++);
  return panels;
};

beforeEach(() => {
  mode = "card";
  toolsClosed = 0;
  changes = 0;
  fakeDocument.activeElement = null;
});

test("register wires the toggle: aria-controls, aria-expanded, the heading focusable", () => {
  const f = fixture("todos");
  mount().register(f.spec);
  assert.equal(f.toggle.getAttribute("aria-controls"), "todos");
  assert.equal(f.toggle.getAttribute("aria-expanded"), "false");
  assert.equal(f.heading.getAttribute("tabindex"), "-1");
});

test("the toggle opens: focus to the heading, Tools close, one change; again closes back to the toggle", () => {
  const f = fixture("todos");
  const panels = mount();
  panels.register(f.spec).setAvailable(true);
  changes = 0;
  f.toggle.onclick!();
  assert.equal(f.panel.hidden, false);
  assert.equal(f.toggle.getAttribute("aria-expanded"), "true");
  assert.equal(fakeDocument.activeElement, f.heading);
  assert.equal(toolsClosed, 1, "a panel opening closes the compact palette");
  assert.equal(panels.active(), "todos");
  assert.equal(changes, 1);
  f.toggle.onclick!();
  assert.equal(f.panel.hidden, true);
  assert.equal(f.toggle.getAttribute("aria-expanded"), "false");
  assert.equal(fakeDocument.activeElement, f.toggle, "focus was inside — it returns to the toggle");
  assert.equal(panels.active(), undefined);
  assert.deepEqual(f.calls, ["open", "close"]);
});

test("a toggle that is gone cannot take focus back", () => {
  const f = fixture("todos");
  const panels = mount();
  panels.register(f.spec).open();
  assert.equal(fakeDocument.activeElement, f.heading);
  f.toggle.hidden = true; // never discovered, or retired
  assert.equal(panels.escape(), true);
  assert.equal(f.panel.hidden, true);
  assert.equal(fakeDocument.activeElement, f.heading, "no focus into a hidden control");
});

test("a close from outside the panel never pulls focus into the widget", () => {
  const f = fixture("todos");
  const handle = mount().register(f.spec);
  handle.open();
  const composer = el("textarea");
  composer.focus();
  handle.close();
  assert.equal(fakeDocument.activeElement, composer);
});

test("one panel at a time — the newcomer takes focus, the other toggle does not", () => {
  const a = fixture("todos");
  const b = fixture("checks");
  const panels = mount();
  const ha = panels.register(a.spec);
  const hb = panels.register(b.spec);
  ha.open();
  hb.open();
  assert.equal(a.panel.hidden, true);
  assert.equal(a.toggle.getAttribute("aria-expanded"), "false");
  assert.equal(b.panel.hidden, false);
  assert.equal(fakeDocument.activeElement, b.heading);
  assert.equal(panels.active(), "checks");
});

test("Escape layers: the panel's own form first, then the panel; nothing open → not handled", () => {
  const f = fixture("todos");
  const panels = mount();
  const handle = panels.register(f.spec);
  assert.equal(panels.escape(), false);
  handle.open();
  f.form.open = true;
  assert.equal(panels.escape(), true);
  assert.equal(f.panel.hidden, false, "the form closed, the panel stays");
  assert.equal(panels.escape(), true);
  assert.equal(f.panel.hidden, true);
  assert.equal(panels.escape(), false);
});

test("Escape on a sheet folded under a decision card closes the sheet, not its hidden form", () => {
  mode = "sheet";
  const f = fixture("todos");
  const panels = mount();
  panels.register(f.spec).open();
  f.form.open = true;
  panels.fold(true);
  assert.equal(panels.escape(), true);
  assert.equal(f.panel.hidden, true, "what the user sees closes");
  assert.equal(f.form.open, true, "the draft stays for later");
});

test("an Escape typed into a field of the panel is taken there and stops there", () => {
  const f = fixture("todos");
  mount().register(f.spec).open();
  f.form.open = true;
  const inField = f.panel.pressEscape(f.input);
  assert.deepEqual(inField, { prevented: true, stopped: true });
  assert.equal(f.form.open, false);
  assert.equal(f.panel.hidden, false);
  // outside a field the document's own Escape layering decides
  const onHeading = f.panel.pressEscape(f.heading);
  assert.deepEqual(onHeading, { prevented: false, stopped: false });
  assert.equal(f.panel.hidden, false);
});

test("collapse: a card stays; a sheet steps aside and the toggle reopens it where it was", () => {
  const f = fixture("todos");
  const handle = mount().register(f.spec);
  handle.open();
  f.scroll.scrollTop = 140;
  handle.collapse();
  assert.equal(f.panel.hidden, false, "a card never collapses");

  mode = "sheet";
  handle.collapse();
  assert.equal(f.panel.hidden, true);
  f.scroll.scrollTop = 0; // a hidden panel loses its offset
  f.toggle.onclick!();
  assert.equal(f.panel.hidden, false);
  assert.equal(f.scroll.scrollTop, 140, "the toggle restores the scroll position");

  handle.collapse();
  f.scroll.scrollTop = 0;
  handle.open();
  assert.equal(f.scroll.scrollTop, 0, "a programmatic open (a badge filtering the list) starts fresh");
});

test("fold: under a decision card the open sheet folds to its head, and unfolds where it was", () => {
  mode = "sheet";
  const f = fixture("todos");
  const panels = mount();
  const handle = panels.register(f.spec);
  panels.fold(true);
  assert.equal(f.panel.getAttribute("data-folded"), null, "nothing open: nothing folds");
  handle.open();
  f.scroll.scrollTop = 140;
  changes = 0;
  panels.fold(true);
  assert.equal(f.panel.getAttribute("data-folded"), "", "the body hides (chrome.css), not squeezed");
  assert.equal(f.panel.hidden, false, "the head stays");
  assert.equal(fakeDocument.activeElement, f.heading, "the focus in the head stays");
  f.scroll.scrollTop = 0; // a hidden scroller loses its offset
  panels.fold(true);
  assert.equal(f.panel.getAttribute("data-folded"), "", "idempotent");
  panels.fold(false);
  assert.equal(f.panel.getAttribute("data-folded"), null);
  assert.equal(f.scroll.scrollTop, 140, "back at the scroll position it folded at");
  panels.fold(false);
  assert.equal(f.scroll.scrollTop, 140, "idempotent");
  assert.equal(changes, 0, "no layout change of its own: the toggle, the menu and the fit stay");
});

test("fold: a folded sheet that closes or steps aside takes the fold with it — reopened, it is where it was", () => {
  mode = "sheet";
  const f = fixture("todos");
  const g = fixture("checks");
  const panels = mount();
  const handle = panels.register(f.spec);
  const other = panels.register(g.spec);
  handle.open();
  f.scroll.scrollTop = 90;
  panels.fold(true);
  f.scroll.scrollTop = 0;
  // Tools over the sheet, a replay: it steps aside with the offsets it folded at
  handle.collapse();
  assert.equal(f.panel.hidden, true);
  assert.equal(f.panel.getAttribute("data-folded"), null);
  panels.fold(false); // the card resolves meanwhile: nothing to unfold
  f.toggle.onclick!();
  assert.equal(f.scroll.scrollTop, 90, "the toggle reopens it where it was");
  // closed while folded: the next open starts fresh and unfolded
  panels.fold(true);
  handle.close();
  assert.equal(f.panel.getAttribute("data-folded"), null);
  handle.open();
  assert.equal(f.panel.getAttribute("data-folded"), null);
  // another panel opening: the fold goes with the one that closes, the shell
  // folds the newcomer (still under the card)
  panels.fold(true);
  other.open();
  assert.equal(f.panel.getAttribute("data-folded"), null);
  panels.fold(true);
  assert.equal(g.panel.getAttribute("data-folded"), "");
});

test("availability: the toggle appears once, and going away closes the panel", () => {
  const f = fixture("todos");
  const handle = mount().register(f.spec);
  handle.setAvailable(true);
  handle.setAvailable(true);
  assert.equal(f.toggle.hidden, false);
  assert.equal(changes, 1, "an unchanged availability does not re-lay the clusters");
  handle.open();
  handle.setAvailable(false);
  assert.equal(f.toggle.hidden, true);
  assert.equal(f.panel.hidden, true);
});

test("a panel hidden behind the shell's back (superseded retire) is not open", () => {
  const f = fixture("todos");
  const panels = mount();
  panels.register(f.spec).open();
  f.panel.hidden = true;
  f.toggle.hidden = true;
  assert.equal(panels.active(), undefined);
  assert.equal(panels.escape(), false);
});

test("the badge: the count chip (none at 0), the verdict chip, the accessible name — deduplicated", () => {
  const f = fixture("todos");
  const handle = mount().register(f.spec);
  const count = f.toggle.querySelector(".count")!;
  const verdict = f.toggle.querySelector(".verdict")!;

  handle.setBadge({ count: 3, ariaLabel: "Todos, 3 open" });
  assert.equal(count.hidden, false);
  assert.equal(count.textContent, "3");
  assert.equal(verdict.hidden, true);
  assert.equal(f.toggle.getAttribute("aria-label"), "Todos, 3 open");
  const after = changes;
  handle.setBadge({ count: 3, ariaLabel: "Todos, 3 open" });
  assert.equal(changes, after, "the same badge again changes nothing");

  handle.setBadge({ count: 0, ariaLabel: "Todos, none open" });
  assert.equal(count.hidden, true);
  assert.equal(count.textContent, "");

  handle.setBadge({ verdict: { text: "Running…", tone: "muted", spinner: true }, ariaLabel: "Checks, running" });
  assert.equal(verdict.hidden, false);
  assert.equal(verdict.className, "verdict muted");
  assert.equal(verdict.children.length, 2, "spinner icon + words");
  assert.equal(verdict.textContent, "Running…");

  handle.setBadge(undefined);
  assert.equal(verdict.hidden, true);
  assert.equal(f.toggle.getAttribute("aria-label"), null);
});
