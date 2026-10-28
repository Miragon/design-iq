/**
 * The Value Chain palette's keyboard and screen reader side outside the
 * modeler shell (lib/value-chain-palette.ts, guide §5.5 and §5.8), on the
 * real renderer under jsdom (test/renderer-dom.ts), mounted the way the SPA
 * and the widget mount it: a toolbar of entries with one roving tab stop, ←
 * → Home End, Enter and Space as a click without a pointer, `aria-pressed`
 * on the active tool, and the canvas as the focus after a press on the
 * island's padding. Without the module the renderer gives its entries none
 * of it: the first test fails once a release does, and the module goes with
 * lib/value-chain-palette.css.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { newVcJson } from "@designiq/notations/templates";

import { MIRAGON_RENDERERS } from "../src/notations/miragon/index.ts";
import type { LoadedMiragonRenderer, MiragonModeler } from "../src/notations/miragon/spec.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const spec = MIRAGON_RENDERERS.find((candidate) => candidate.id === "value-chain")!;

interface Mount {
  container: HTMLElement;
  modeler: MiragonModeler;
  renderer: LoadedMiragonRenderer;
  detach(): void;
}

async function mount(enhanced: boolean): Promise<Mount> {
  const renderer = await spec.load();
  const container = host(spec.canvasClassName);
  const modeler = renderer.create({ fitOnImport: false });
  modeler.attachTo(container);
  const detach = enhanced ? (renderer.attached?.(modeler, container) ?? (() => {})) : () => {};
  await modeler.importText(newVcJson("chain", "Chain"));
  await wait(20);
  return { container, modeler, renderer, detach };
}

const entriesOf = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(".djs-palette .entry"));
const entry = (container: HTMLElement, action: string): HTMLElement => {
  const found = entriesOf(container).find((candidate) => candidate.dataset.action === action);
  assert.ok(found, `the palette has ${action}`);
  return found;
};
const stops = (container: HTMLElement): string[] =>
  entriesOf(container)
    .filter((candidate) => candidate.tabIndex === 0)
    .map((candidate) => candidate.dataset.action!);

function press(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const shapes = (container: HTMLElement): number => container.querySelectorAll(".djs-shape[data-element-id]").length;

test("value-chain-renderer's palette outside the shell has no toolbar, no tab stop and no pressed tool of its own", async () => {
  const { container, modeler } = await mount(false);
  const palette = container.querySelector(".djs-palette");
  assert.ok(palette && entriesOf(container).length >= 6, "the palette is built");
  assert.equal(palette.querySelector('[role="toolbar"]'), null, "a release that ships it retires the module");
  const svg = container.querySelector(".djs-container > svg")!;
  assert.ok(palette.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_PRECEDING, "and it comes after the canvas");
  assert.deepEqual(
    entriesOf(container).map((candidate) => [
      candidate.getAttribute("tabindex"),
      candidate.getAttribute("aria-pressed"),
    ]),
    entriesOf(container).map(() => [null, null]),
  );
  modeler.destroy();
});

test("a toolbar named Tools with one tab stop on its first entry, the tools pressed or not", async () => {
  const { container, modeler, detach } = await mount(true);
  const toolbar = container.querySelector(".djs-palette .djs-palette-entries");
  assert.equal(toolbar?.getAttribute("role"), "toolbar");
  assert.equal(toolbar?.getAttribute("aria-label"), "Tools");
  assert.deepEqual(stops(container), ["lasso-tool"], "one tab stop, the first entry");
  for (const action of ["lasso-tool", "hand-tool", "space-tool", "global-connect-tool"]) {
    assert.equal(entry(container, action).getAttribute("aria-pressed"), "false", action);
  }
  assert.equal(
    entry(container, "create.step").hasAttribute("aria-pressed"),
    false,
    "an entry that creates is no toggle",
  );
  detach();
  modeler.destroy();
});

test("the palette comes before the canvas in the tab order", async () => {
  const { container, modeler, detach } = await mount(true);
  const palette = container.querySelector(".djs-palette")!;
  const svg = container.querySelector(".djs-container > svg")!;
  assert.ok(palette.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING, "the palette precedes the <svg>");
  assert.equal(palette.parentElement, svg.parentElement, "in the same container, so nothing else moved");
  detach();
  modeler.destroy();
});

test("← → Home End move the focus and the tab stop, around the ends, and leave other keys and modified keys alone", async () => {
  const { container, modeler, detach } = await mount(true);
  const actions = entriesOf(container).map((candidate) => candidate.dataset.action!);
  const first = entry(container, actions[0]!);
  first.focus();
  assert.equal(document.activeElement, first);

  const right = press(first, "ArrowRight");
  assert.equal(right.defaultPrevented, true);
  assert.equal(document.activeElement, entry(container, actions[1]!));
  assert.deepEqual(stops(container), [actions[1]], "the tab stop follows the focus");

  press(document.activeElement!, "End");
  assert.equal(document.activeElement, entry(container, actions.at(-1)!));
  press(document.activeElement!, "ArrowRight");
  assert.equal(document.activeElement, entry(container, actions[0]!), "after the last comes the first");
  press(document.activeElement!, "ArrowLeft");
  assert.equal(document.activeElement, entry(container, actions.at(-1)!), "before the first comes the last");
  press(document.activeElement!, "Home");
  assert.equal(document.activeElement, entry(container, actions[0]!));

  const modified = press(document.activeElement!, "ArrowRight", { ctrlKey: true });
  assert.equal(modified.defaultPrevented, false, "a modified key is the browser's or the page's");
  assert.equal(document.activeElement, entry(container, actions[0]!));
  assert.equal(press(document.activeElement!, "a").defaultPrevented, false);
  detach();
  modeler.destroy();
});

test("Enter and Space click an entry without a pointer: a tool toggles, a creating entry places its element", async () => {
  const { container, modeler, detach } = await mount(true);
  const hand = entry(container, "hand-tool");
  hand.focus();
  const clicks: number[] = [];
  hand.addEventListener("click", (event) => clicks.push((event as MouseEvent).detail));
  assert.equal(press(hand, "Enter").defaultPrevented, true, "Enter is the entry's, never the page's");
  assert.deepEqual(clicks, [0], "a click without a pointer");
  assert.equal(hand.getAttribute("aria-pressed"), "true", "the tool is on");
  assert.equal(entry(container, "lasso-tool").getAttribute("aria-pressed"), "false");
  press(hand, " ");
  assert.equal(hand.getAttribute("aria-pressed"), "false", "Space switches it off again");
  press(hand, "Enter", { repeat: true });
  assert.equal(clicks.length, 2, "a held key does not click again");

  const before = shapes(container);
  const step = entry(container, "create.step");
  step.focus();
  press(step, "Enter");
  await wait(20);
  assert.equal(shapes(container), before + 1, "the step lands in the canvas");
  detach();
  modeler.destroy();
});

test("a rebuild of the palette keeps the toolbar, the tab stop and the pressed tool", async () => {
  const { container, modeler, detach } = await mount(true);
  const diagram = modeler.diagram as { get(name: "eventBus"): { fire(type: string, event?: object): void } };
  const bus = diagram.get("eventBus");
  const space = entry(container, "space-tool");
  space.focus();
  bus.fire("tool-manager.update", { tool: "space" });
  assert.equal(entry(container, "space-tool").getAttribute("aria-pressed"), "true");
  assert.equal(entry(container, "hand-tool").getAttribute("aria-pressed"), "false");

  // diagram-js clears and rebuilds every entry
  for (const old of entriesOf(container)) {
    const fresh = old.cloneNode(true) as HTMLElement;
    fresh.removeAttribute("tabindex");
    fresh.removeAttribute("aria-pressed");
    old.replaceWith(fresh);
  }
  const toolbar = container.querySelector(".djs-palette-entries")!;
  toolbar.removeAttribute("role");
  toolbar.removeAttribute("aria-label");
  bus.fire("palette.changed");
  assert.equal(toolbar.getAttribute("role"), "toolbar");
  assert.deepEqual(stops(container), ["space-tool"], "the tab stop stays where the focus was");
  assert.equal(entry(container, "space-tool").getAttribute("aria-pressed"), "true");
  assert.equal(document.activeElement, entry(container, "space-tool"), "the focus does not fall to the page");

  bus.fire("tool-manager.update", { tool: null });
  assert.equal(entry(container, "space-tool").getAttribute("aria-pressed"), "false");
  detach();
  modeler.destroy();
});

test("a press on the island's padding hands the canvas the focus, a press on an entry leaves it to the entry", async () => {
  const { container, modeler, detach } = await mount(true);
  const palette = container.querySelector<HTMLElement>(".djs-palette")!;
  const svg = container.querySelector<SVGElement>(".djs-container > svg")!;
  document.body.append(Object.assign(document.createElement("button"), { id: "elsewhere" }));
  (document.getElementById("elsewhere") as HTMLElement).focus();
  const padding = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  palette.dispatchEvent(padding);
  assert.equal(padding.defaultPrevented, true);
  assert.equal(document.activeElement, svg, "Delete and ⌘Z act again");
  const onEntry = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  entry(container, "hand-tool").dispatchEvent(onEntry);
  assert.equal(onEntry.defaultPrevented, false);
  document.getElementById("elsewhere")?.remove();
  detach();
  modeler.destroy();
});

test("what the module added goes with it: no key moves the focus once it is detached", async () => {
  const { container, modeler, detach } = await mount(true);
  const first = entry(container, "lasso-tool");
  first.focus();
  detach();
  assert.equal(press(first, "ArrowRight").defaultPrevented, false);
  assert.equal(document.activeElement, first);
  modeler.destroy();
});
