/**
 * What a board offers and mounts (src/notations/board: models.ts, product-mount.ts, release.ts):
 * the model picker's list (every listed model of a notation a board shows in place, never a
 * board nor a Markdown document, the same array until the shell's list changes), a node's title
 * and kind, whether a path names a model and where a moved model went (a moved notice wins over
 * a stale list, and nothing ever leads back to a path a move left), where a node goes (a moved
 * notice at once, a guess from the list only once a list loaded after the question confirms it,
 * one load at a time, once per node and version of the list), which product editor a node
 * mounts with its first fit in layout px under a board's scale, and the release of an armed
 * node, which touches nothing outside its element.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { JSDOM } from "jsdom";

import { createBoardModels, describeModel, modelPathsOf } from "../src/notations/board/models.ts";
import { chromeInsets, FIT_MARGIN, productMount } from "../src/notations/board/product-mount.ts";
import { releaseDiagramJs } from "../src/notations/board/release.ts";
import type { EditorContext, ModelDirectory, MountedEditor, WebNotationPlugin } from "../src/notations/registry.ts";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
after(() => window.close());
const { document } = window;

/**
 * The shell's model list: a new Set per change, as live-editor.tsx makes it. With `loads`,
 * refresh() is a load the test answers (`answer`: the list it brings, or a failure)
 */
function directory(initial?: readonly string[], loads = false) {
  let paths: ReadonlySet<string> | undefined = initial ? new Set(initial) : undefined;
  const listeners = new Set<() => void>();
  const set = (next: readonly string[] | undefined): void => {
    paths = next ? new Set(next) : undefined;
    for (const listener of [...listeners]) listener();
  };
  const pending: Array<{ resolve: (next: readonly string[] | Error) => void }> = [];
  const dir: ModelDirectory = {
    paths: () => paths,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    ...(loads
      ? {
          refresh: () =>
            new Promise<void>((resolve, reject) => {
              pending.push({
                resolve(next) {
                  if (next instanceof Error) return reject(next);
                  // the shell keeps the version of a list that loads as it was
                  const same = paths?.size === next.length && next.every((one) => paths?.has(one));
                  if (!same) set(next);
                  resolve();
                },
              });
            }),
        }
      : {}),
  };
  return {
    dir,
    listeners,
    set,
    /** the loads asked so far */
    loads: () => pending.length,
    /** answers the oldest load not answered yet */
    answer(next: readonly string[] | Error) {
      const load = pending.find((one) => one.resolve !== answered);
      if (!load) throw new Error("no load to answer");
      const { resolve } = load;
      load.resolve = answered;
      resolve(next);
    },
  };
}
const answered = (): void => undefined;
const tasks = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const SHOWN = new Set(["bpmn", "dmn", "wardley", "team-topology", "event-storming", "context-map", "value-chain"]);
const shows = (notation: string): boolean => SHOWN.has(notation);

test("the picker lists the shown notations' models sorted, the same array until the shell's list changes", () => {
  const list = directory([
    "processes/zeta.bpmn",
    "processes/plan.board",
    "docs/readme.md",
    "processes/credit.dmn",
    "maps/tea.wmap",
    "notes.txt",
  ]);
  const paths = modelPathsOf(list.dir, shows);
  const first = paths.list();
  assert.deepEqual(first, ["maps/tea.wmap", "processes/credit.dmn", "processes/zeta.bpmn"]);
  assert.equal(paths.list(), first, "the same array while the shell's Set is the same");
  list.set(["processes/zeta.bpmn", "maps/tea.wmap", "processes/credit.dmn"]);
  const second = paths.list();
  assert.notEqual(second, first, "a new Set is a new version");
  assert.deepEqual(second, first);
  list.set(undefined);
  assert.deepEqual(paths.list(), []);
  assert.deepEqual(modelPathsOf(undefined, shows).list(), []);
});

test("a path is a model when the shell lists it; undefined while the list loads; every path without a list", () => {
  const list = directory();
  const paths = modelPathsOf(list.dir, shows);
  assert.equal(paths.listed("processes/a.bpmn"), undefined);
  list.set(["processes/a.bpmn"]);
  assert.equal(paths.listed("processes/a.bpmn"), true);
  assert.equal(paths.listed("processes/b.bpmn"), false);
  assert.equal(modelPathsOf(undefined, shows).listed("anything.bpmn"), true);
});

test("a model moved while the board was closed is found by its notation and stem, and only when one matches", () => {
  const list = directory(["archive/order.bpmn", "processes/order.dmn", "processes/credit.bpmn"]);
  const paths = modelPathsOf(list.dir, shows);
  assert.equal(paths.movedTo("processes/order.bpmn"), "archive/order.bpmn");
  assert.equal(paths.movedTo("archive/order.bpmn"), undefined, "a listed path went nowhere");
  assert.equal(paths.movedTo("processes/gone.bpmn"), undefined, "deleted or renamed: no model of that stem");
  list.set(["a/order.bpmn", "b/order.bpmn"]);
  assert.equal(paths.movedTo("processes/order.bpmn"), undefined, "two candidates: none");
});

test("a moved notice wins over a stale list: its new path is a model, and nothing leads back to the old one", () => {
  const list = directory(["processes/order.bpmn"]);
  const paths = modelPathsOf(list.dir, shows);
  paths.moved("processes/order.bpmn", "archive/order.bpmn");
  // the list still has the old path and not the new one
  assert.equal(paths.listed("archive/order.bpmn"), true);
  assert.equal(paths.movedTo("processes/order.bpmn"), "archive/order.bpmn");
  assert.equal(paths.movedTo("archive/order.bpmn"), undefined, "never back to the path the move left");
  // the list caught up: the move is the list's from now on
  list.set(["archive/order.bpmn"]);
  assert.equal(paths.listed("archive/order.bpmn"), true);
  assert.equal(paths.movedTo("processes/order.bpmn"), "archive/order.bpmn");
  // the notice is forgotten: once the model moves back, the list alone says where it is
  list.set(["processes/order.bpmn"]);
  assert.equal(paths.movedTo("archive/order.bpmn"), "processes/order.bpmn");
  paths.destroy();
  assert.equal(list.listeners.size, 0, "destroy stops following the shell's list");
});

test("a node follows a guess from the list only once a list loaded after it asked confirms it", async () => {
  const list = directory(["archive/order.bpmn", "processes/credit.bpmn"], true);
  const paths = modelPathsOf(list.dir, shows);
  // a moved notice: at once, no load
  paths.moved("processes/credit.bpmn", "archive/credit.bpmn");
  assert.equal(await paths.relocation("processes/credit.bpmn", "n_credit"), "archive/credit.bpmn");
  assert.equal(list.loads(), 0);
  // no model of that notation and stem: nowhere, no load
  assert.equal(await paths.relocation("processes/gone.bpmn", "n_gone"), undefined);
  assert.equal(list.loads(), 0);

  // a guess: confirmed by the list loaded anew
  const confirmed = paths.relocation("processes/order.bpmn", "n_order");
  await tasks();
  assert.equal(list.loads(), 1);
  list.answer(["archive/order.bpmn", "processes/credit.bpmn"]);
  assert.equal(await confirmed, "archive/order.bpmn");
  // the same node on the same version of the list: never again (two clients that disagree)
  assert.equal(await paths.relocation("processes/order.bpmn", "n_order"), undefined);
  assert.equal(list.loads(), 1, "and no load for it");

  // the list loaded anew has the path again (it was loaded before the move): the node stays
  const back = paths.relocation("processes/order.bpmn", "n_other");
  await tasks();
  list.answer(["processes/order.bpmn", "processes/credit.bpmn"]);
  assert.equal(await back, undefined);
  // ... names another model of that stem, or none: the node stays
  list.set(["archive/order.bpmn"]);
  const elsewhere = paths.relocation("processes/order.bpmn", "n_other");
  await tasks();
  list.answer(["old/order.bpmn"]);
  assert.equal(await elsewhere, undefined);
  // ... could not be loaded: the node stays
  const failing = paths.relocation("processes/order.bpmn", "n_other");
  await tasks();
  list.answer(new Error("offline"));
  assert.equal(await failing, undefined);
  paths.destroy();
});

test("one load of the list at a time per board: who asks before it went out joins it, who asks after waits for the next", async () => {
  const list = directory(["archive/a.bpmn", "archive/b.bpmn", "archive/c.bpmn"], true);
  const paths = modelPathsOf(list.dir, shows);
  const a = paths.relocation("processes/a.bpmn", "n_a");
  const b = paths.relocation("processes/b.bpmn", "n_b");
  await tasks();
  assert.equal(list.loads(), 1, "asked in the same moment: one load");
  // asked after that load went out: it may predate the question, so one more follows it
  const c = paths.relocation("processes/c.bpmn", "n_c");
  await tasks();
  assert.equal(list.loads(), 1, "never two at once");
  list.answer(["archive/a.bpmn", "archive/b.bpmn", "archive/c.bpmn"]);
  assert.deepEqual(await Promise.all([a, b]), ["archive/a.bpmn", "archive/b.bpmn"]);
  await tasks();
  assert.equal(list.loads(), 2);
  list.answer(["archive/a.bpmn", "archive/b.bpmn", "archive/c.bpmn"]);
  assert.equal(await c, "archive/c.bpmn");
});

test("without a way to load the list anew, the list as it is confirms a guess, once per node and version", async () => {
  const list = directory(["archive/order.bpmn"]);
  const paths = modelPathsOf(list.dir, shows);
  assert.equal(await paths.relocation("processes/order.bpmn", "n_order"), "archive/order.bpmn");
  assert.equal(await paths.relocation("processes/order.bpmn", "n_order"), undefined);
  list.set(["archive/order.bpmn"]);
  assert.equal(await paths.relocation("processes/order.bpmn", "n_order"), "archive/order.bpmn", "a new version");
});

test("a node's title is the file's stem and its kind the notation's label; a file of no notation has none", () => {
  assert.deepEqual(describeModel("processes/order-to-cash.bpmn"), { title: "order-to-cash", kind: "BPMN 2.0" });
  assert.deepEqual(describeModel("maps/porter.vc.json"), { title: "porter", kind: "Value Chain" });
  assert.equal(describeModel("notes.txt"), undefined);
  const list = directory(["processes/a.bpmn"]);
  const models = createBoardModels(modelPathsOf(list.dir, shows), () => undefined);
  let told = 0;
  const off = models.onChange(() => told++);
  list.set(["processes/a.bpmn", "processes/b.bpmn"]);
  off();
  list.set([]);
  assert.equal(told, 1);
  assert.deepEqual(models.list(), []);
});

// ── the product editor a node mounts ────────────────────────────────────────

const mounted: MountedEditor = { destroy: () => undefined };
function plugin(id: string, withEditor = true): WebNotationPlugin {
  return {
    id,
    canvasClassName: `${id}-canvas`,
    ...(withEditor ? { mountEditor: () => Promise.resolve(mounted) } : {}),
  };
}

test("a node mounts its notation's own plugin, never a board's or a Markdown view, and a first fit only for bpmn-js and the DRD", async () => {
  const asked: string[] = [];
  const lookup = (id: string): WebNotationPlugin | undefined => {
    asked.push(id);
    return id === "plain" ? plugin(id, false) : id === "none" ? undefined : plugin(id);
  };
  assert.equal(productMount("board", lookup), undefined);
  assert.equal(productMount("markdown", lookup), undefined);
  assert.equal(productMount("plain", lookup), undefined, "a notation without an editor opens in Monaco alone");
  assert.equal(productMount("none", lookup), undefined);
  assert.deepEqual(asked, ["plain", "none"], "board and Markdown are refused before any lookup");

  const bpmn = productMount("bpmn", lookup);
  assert.equal(bpmn?.canvasClassName, "bpmn-canvas");
  assert.equal(typeof bpmn?.fitInsets, "function");
  assert.equal(typeof productMount("dmn", lookup)?.fitInsets, "function");
  const wardley = productMount("wardley", lookup);
  assert.equal(wardley?.fitInsets, undefined, "a Miragon renderer fits clear of its palette by itself");
  const host = document.createElement("div");
  assert.equal(await wardley?.mount(host, {} as EditorContext), mounted);
});

/** a laid-out box in client px (jsdom lays nothing out) */
function box(element: Element, left: number, top: number, width: number, height: number): void {
  element.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
}

test("the first fit's insets are layout px whatever a board's zoom scales the preview by", () => {
  const host = document.createElement("div");
  const palette = document.createElement("div");
  palette.className = "djs-palette";
  const card = document.createElement("div");
  card.className = "dmn-definitions";
  host.append(palette, card);
  Object.defineProperty(host, "offsetWidth", { value: 800 });
  // a preview at board zoom 0.5: 800 layout px are 400 on screen
  box(host, 100, 50, 400, 300);
  box(palette, 110, 60, 24, 100);
  box(card, 140, 55, 100, 20);
  assert.deepEqual(chromeInsets(host, { left: ".djs-palette", top: ".dmn-definitions" }), {
    top: 50 + FIT_MARGIN,
    right: FIT_MARGIN,
    bottom: FIT_MARGIN,
    left: 68 + FIT_MARGIN,
  });
  // armed in the board's layer at zoom 1, the same layout gives the same insets
  box(host, 0, 0, 800, 600);
  box(palette, 20, 20, 48, 200);
  box(card, 60, 10, 200, 40);
  assert.deepEqual(chromeInsets(host, { left: ".djs-palette", top: ".dmn-definitions" }), {
    top: 50 + FIT_MARGIN,
    right: FIT_MARGIN,
    bottom: FIT_MARGIN,
    left: 68 + FIT_MARGIN,
  });
  // chrome not laid out (a decision table's view, no DRD) counts nothing
  box(palette, 0, 0, 0, 0);
  card.remove();
  assert.deepEqual(chromeInsets(host, { left: ".djs-palette", top: ".dmn-definitions" }), {
    top: FIT_MARGIN,
    right: FIT_MARGIN,
    bottom: FIT_MARGIN,
    left: FIT_MARGIN,
  });
});

// ── the release ──────────────────────────────────────────────────────────────

test("the release ends a drag, drops the selection and the focus, inside the node's element only", () => {
  const element = document.createElement("div");
  const container = document.createElement("div");
  container.className = "djs-container";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  container.append(svg);
  const label = document.createElement("textarea");
  element.append(container, label);
  const outside = document.createElement("input");
  document.body.append(element, outside);

  const heard: string[] = [];
  const onKeyup = (event: Event): void => void heard.push(`keyup ${(event as KeyboardEvent).key}`);
  document.addEventListener("keyup", onKeyup);
  svg.addEventListener("click", () => heard.push("click on the canvas"));
  label.addEventListener("blur", () => heard.push("blur of the label editor"));

  label.focus();
  assert.equal(document.activeElement, label);
  releaseDiagramJs(element);
  assert.deepEqual(heard, ["keyup Escape", "click on the canvas", "blur of the label editor"]);
  assert.notEqual(document.activeElement, label);

  // a focus outside the element is not the node's to take
  outside.focus();
  heard.length = 0;
  releaseDiagramJs(element);
  assert.equal(document.activeElement, outside);
  assert.deepEqual(heard, ["keyup Escape", "click on the canvas"]);
  document.removeEventListener("keyup", onKeyup);
  element.remove();
  outside.remove();
});
