/**
 * The zoom keys and ⇧1 of bpmn-js and the DMN DRD on their focused canvas
 * (src/lib/chrome-keys.ts routeCanvasChromeKeys), on real canvases under
 * jsdom (test/renderer-dom.ts): the SPA's editors (src/notations/
 * bpmn-io-keys.ts) and the widget's engines (EngineOptions.chromeKeys).
 * Cmd/Ctrl + `+` / `-` / `0` step on the guide's fixed steps once per press
 * and keep the page from zooming, ⇧1 fits, and diagram-js's own zoom never
 * acts: its step clamps to 20 %, so from a fit below 20 % its zoom out zoomed
 * in (guide §5.8). A step out from there stays put, a step in goes to 20 %.
 * The keys act only while the canvas has the focus: one pressed elsewhere
 * (the toolbar, the source, a side panel) is the browser's.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import { fitViewbox } from "@miragon/modeler-shell/core";
import * as Y from "yjs";

import type { ChromeKeyDeps } from "../src/lib/chrome-keys.ts";
import type { Insets } from "../src/mcp-app/core/engine.ts";
import type { ChromeKey } from "../src/mcp-app/core/keymap.ts";
import type { EditorContext, MountedEditor } from "../src/notations/registry.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

// bpmn-js asks a 2D canvas for nothing it needs here; jsdom has none and logs each call
(HTMLCanvasElement.prototype as unknown as { getContext(): null }).getContext = () => null;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const model = (name: string): string =>
  readFileSync(new URL(`../../../process-documentation/processes/${name}`, import.meta.url), "utf8");

interface Viewbox {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  outer: { width: number; height: number };
}
interface Diagram {
  get(service: "canvas"): {
    viewbox(): Viewbox;
    viewbox(box: { x: number; y: number; width: number; height: number }): void;
  };
  get(service: "zoomScroll"): { stepZoom(direction: number): void };
}

/** the level a canvas reads back, to three decimals as diagram-js keeps it */
const levelOf = (diagram: Diagram): number => Math.round(diagram.get("canvas").viewbox().scale * 1000) / 1000;

/** a view at `level`, as a fit of a large diagram leaves it: a viewbox write
 *  (jsdom keeps no CTM, renderer-dom.ts) */
function viewAt(diagram: Diagram, level: number): void {
  const canvas = diagram.get("canvas");
  const { outer } = canvas.viewbox();
  canvas.viewbox({ x: 0, y: 0, width: outer.width / level, height: outer.height / level });
}

/** every step diagram-js's own zoom takes on this canvas, which still takes it */
function spyOnOwnZoom(diagram: Diagram): string[] {
  const steps: string[] = [];
  const zoomScroll = diagram.get("zoomScroll");
  const stepZoom = zoomScroll.stepZoom.bind(zoomScroll);
  zoomScroll.stepZoom = (direction) => {
    steps.push(`zoomScroll.stepZoom(${direction})`);
    stepZoom(direction);
  };
  return steps;
}

function press(
  target: Element,
  key: string,
  code: string,
  mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; isComposing?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(event);
  return event;
}

const svgOf = (container: HTMLElement): SVGSVGElement => {
  const svg = container.querySelector<SVGSVGElement>(".djs-container > svg");
  assert.ok(svg, "the canvas");
  return svg;
};

/** jsdom lays nothing out: for ⇧1 the canvas's content gets a box */
function withContent<T>(box: { x: number; y: number; width: number; height: number }, run: () => T): T {
  const element = SVGElement.prototype as unknown as { getBBox(): typeof box };
  const getBBox = element.getBBox;
  element.getBBox = () => box;
  try {
    return run();
  } finally {
    element.getBBox = getBBox;
  }
}

const context = (doc: Y.Doc, docPath: string): EditorContext =>
  ({
    ytext: doc.getText("content"),
    doc,
    docPath,
    onSyncError: assert.fail,
    onImportFailed: assert.fail,
    onBadgeClick: () => {},
    onSelectionChanged: () => {},
  }) as unknown as EditorContext;

const docOf = (text: string): Y.Doc => {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return doc;
};

/** an SPA editor, the diagram-js instance of its canvas and that canvas's <svg> */
interface SpaEditor {
  editor: MountedEditor;
  container: HTMLElement;
  diagram: Diagram;
  svg: SVGSVGElement;
}

async function spaBpmnEditor(): Promise<SpaEditor> {
  const { default: BpmnModeler } = await import("bpmn-js/lib/Modeler.js");
  const { mountBpmnEditor } = await import("../src/notations/bpmn-editor.ts");
  // the editor keeps its bpmn-js to itself; its first import names it
  const modelers: Diagram[] = [];
  const importXML = BpmnModeler.prototype.importXML;
  BpmnModeler.prototype.importXML = function (this: Diagram, ...args: Parameters<typeof importXML>) {
    modelers.push(this);
    return importXML.apply(this, args);
  };
  try {
    const container = host("bpmn-canvas");
    const editor = await mountBpmnEditor(container, context(docOf(model("order-to-cash.bpmn")), "processes/o.bpmn"));
    await wait(300);
    return { editor, container, diagram: modelers[0]!, svg: svgOf(container) };
  } finally {
    BpmnModeler.prototype.importXML = importXML;
  }
}

async function spaDmnEditor(): Promise<SpaEditor> {
  const { default: DmnModeler } = await import("dmn-js/lib/Modeler");
  const { mountDmnEditor } = await import("../src/notations/dmn-editor.ts");
  type Modeler = InstanceType<typeof DmnModeler>;
  const modelers: Modeler[] = [];
  const importXML = DmnModeler.prototype.importXML;
  DmnModeler.prototype.importXML = function (this: Modeler, text: string) {
    modelers.push(this);
    return importXML.call(this, text);
  };
  try {
    const container = host("dmn-canvas");
    const editor = await mountDmnEditor(
      container,
      context(docOf(model("credit-limit-check.dmn")), "processes/credit-limit-check.dmn"),
    );
    await wait(300);
    const modeler = modelers[0]!;
    assert.equal(modeler.getActiveView()?.type, "drd", "the editor opens on the DRD");
    const diagram = modeler.getActiveViewer() as unknown as Diagram;
    return { editor, container, diagram, svg: svgOf(container) };
  } finally {
    DmnModeler.prototype.importXML = importXML;
  }
}

const SPA_EDITORS: Array<[name: string, mount: () => Promise<SpaEditor>]> = [
  ["BPMN editor", spaBpmnEditor],
  ["DMN editor's DRD", spaDmnEditor],
];

for (const [name, mount] of SPA_EDITORS) {
  test(`the SPA's ${name}: the zoom keys step once on the focused canvas, never turn around below 20 %, and stay off the rest of the page`, async () => {
    const { editor, container, diagram, svg } = await mount();
    const own = spyOnOwnZoom(diagram);
    editor.focus?.();
    assert.equal(document.activeElement, svg, `${name}: the canvas has the focus`);

    viewAt(diagram, 0.12);
    assert.equal(press(svg, "-", "Minus", { ctrlKey: true }).defaultPrevented, true, "the page does not zoom");
    assert.deepEqual(own, [], `${name}: diagram-js's own zoom, which clamps to 20 % and so zooms in, never acts`);
    assert.equal(levelOf(diagram), 0.12, "from a fit at 12 % a step out stays put");
    press(svg, "_", "Minus", { ctrlKey: true, shiftKey: true });
    assert.equal(levelOf(diagram), 0.12, "and so does Ctrl+_");
    press(svg, "+", "NumpadAdd", { ctrlKey: true });
    assert.equal(levelOf(diagram), 0.2, "a step in goes to 20 %");

    assert.equal(press(svg, "0", "Digit0", { ctrlKey: true }).defaultPrevented, true);
    assert.equal(levelOf(diagram), 1, "Ctrl+0: 100 %");
    press(svg, "=", "Equal", { ctrlKey: true });
    assert.equal(levelOf(diagram), 1.349, "Ctrl+= one step in, to the guide's 135 %, once");
    press(svg, "-", "Minus", { metaKey: true });
    assert.equal(levelOf(diagram), 1, "⌘- one step out");
    assert.deepEqual(own, [], `${name}: diagram-js's own zoom never acts`);

    const toolbarButton = document.createElement("button");
    const source = document.createElement("div");
    source.className = "monaco-editor";
    const typed = document.createElement("textarea");
    source.append(typed);
    document.body.append(toolbarButton, source);
    for (const target of [document.body, toolbarButton, typed]) {
      assert.equal(press(target, "=", "Equal", { ctrlKey: true }).defaultPrevented, false);
    }
    toolbarButton.remove();
    source.remove();
    assert.equal(levelOf(diagram), 1, "off the canvas (the page, the toolbar, the source) the browser keeps the keys");

    press(svg, "=", "Equal", { ctrlKey: true, isComposing: true });
    assert.equal(levelOf(diagram), 1, "an IME composition keeps the key");

    // ⇧1: the content into the canvas, 24px clear of what floats over it
    // (jsdom lays nothing out: the palette and the cards measure 0)
    const { bpmnIoFitInsets } = await import("../src/notations/bpmn-io-keys.ts");
    const content = { x: 100, y: 80, width: 3000, height: 900 };
    const fitted = fitViewbox(
      content,
      diagram.get("canvas").viewbox().outer,
      bpmnIoFitInsets({ paletteRight: 0, cardsBottom: 0, coveredRight: 0 }),
    );
    assert.ok(fitted);
    withContent(content, () => press(svg, "!", "Digit1", { shiftKey: true }));
    assert.equal(levelOf(diagram), Math.round(fitted.scale * 1000) / 1000, "⇧1 fits");

    editor.destroy();
    container.remove();
  });
}

test("the SPA's fit for bpmn-js and the DRD: 24px clear of the palette column, the cards along the top and what covers the right edge", async () => {
  const { bpmnIoFitInsets } = await import("../src/notations/bpmn-io-keys.ts");
  assert.deepEqual(bpmnIoFitInsets({ paletteRight: 0, cardsBottom: 0, coveredRight: 0 }), {
    top: 24,
    right: 24,
    bottom: 24,
    left: 24,
  });
  assert.deepEqual(
    bpmnIoFitInsets({ paletteRight: 68, cardsBottom: 74, coveredRight: 320 }),
    { top: 98, right: 344, bottom: 24, left: 92 },
    "the palette at 20 + 48, the DRD's name card, an open side panel",
  );
});

interface ZoomTarget {
  stepZoom(direction: 1 | -1): void;
  zoomTo(level: number): void;
}

/** the widget chrome's keys as an engine gets them (WidgetChrome.canvasKeys),
 *  recorded; they run the view `bind` hands them, as the chrome's setZoom does */
function chromeKeys() {
  const ran: ChromeKey[] = [];
  let view: ZoomTarget | undefined;
  const deps: ChromeKeyDeps = {
    menuOpen: () => false,
    viewport: () => true,
    run(key) {
      ran.push(key);
      if (key === "zoomToActual") view?.zoomTo(1);
      else if (key !== "fit") view?.stepZoom(key === "zoomIn" ? 1 : -1);
    },
  };
  return {
    ran,
    deps,
    bind: (next: ZoomTarget) => {
      view = next;
    },
  };
}

const insets = (): Insets => ({ top: 56, right: 16, bottom: 56, left: 16 });

test("the bpmn widget: its focused canvas runs the chrome's keys once each, a step out below 20 % stays put, and the document keeps ⇧1 elsewhere", async () => {
  const { mountBpmnEngine } = await import("../src/mcp-app/engines/bpmn.ts");
  const { mountKeys } = await import("../src/mcp-app/chrome/keys.ts");
  const { ran, deps, bind } = chromeKeys();
  const container = host("bpmn-canvas");
  const engine = mountBpmnEngine(container, false, { insets, chromeKeys: deps });
  bind(engine.view);
  await engine.importText(model("order-to-cash.bpmn"));
  const diagram = engine.raw as unknown as Diagram;
  const own = spyOnOwnZoom(diagram);
  // the widget's one document listener (chrome/keys.ts), as a bpmn widget mounts it: no chromeKeys
  const unbindKeys = mountKeys(document, {
    save: () => false,
    fit: () => {
      ran.push("fit (document)" as ChromeKey);
      return true;
    },
    escape: [],
  });
  const svg = svgOf(container);

  viewAt(diagram, 0.12);
  assert.equal(press(svg, "-", "Minus", { ctrlKey: true }).defaultPrevented, true, "the page does not zoom");
  assert.deepEqual(own, [], "bpmn-js's own zoom, which clamps to 20 % and so zooms in, never acts");
  assert.equal(levelOf(diagram), 0.12, "from a fit at 12 % a step out stays put");
  press(svg, "=", "Equal", { metaKey: true });
  assert.equal(levelOf(diagram), 0.2, "a step in goes to 20 %");
  press(svg, "0", "Digit0", { ctrlKey: true });
  assert.equal(levelOf(diagram), 1);
  assert.equal(press(svg, "!", "Digit1", { shiftKey: true }).defaultPrevented, true);
  assert.deepEqual(ran, ["zoomOut", "zoomIn", "zoomToActual", "fit"], "each press runs once, ⇧1 too");
  assert.deepEqual(own, [], "bpmn-js's own zoom never acts");

  ran.length = 0;
  assert.equal(press(document.body, "=", "Equal", { ctrlKey: true }).defaultPrevented, false);
  press(document.body, "!", "Digit1", { shiftKey: true });
  assert.deepEqual(ran, ["fit (document)"], "off the canvas the zoom keys are the browser's, ⇧1 the chrome's fit");

  unbindKeys();
  engine.destroy();
  container.remove();
});

test("the read-only bpmn widget: its canvas takes the chrome's zoom keys too", async () => {
  const { mountBpmnEngine } = await import("../src/mcp-app/engines/bpmn.ts");
  const { ran, deps, bind } = chromeKeys();
  const container = host("bpmn-canvas");
  const engine = mountBpmnEngine(container, true, { insets, chromeKeys: deps });
  bind(engine.view);
  await engine.importText(model("order-to-cash.bpmn"));
  const diagram = engine.raw as unknown as Diagram;
  viewAt(diagram, 1);
  assert.equal(press(svgOf(container), "=", "Equal", { ctrlKey: true }).defaultPrevented, true);
  assert.equal(levelOf(diagram), 1.349, "a viewer binds no zoom keys of its own: the page zoomed before");
  assert.deepEqual(ran, ["zoomIn"]);
  engine.destroy();
  container.remove();
});

test("the dmn widget: the DRD's focused canvas runs the chrome's keys once each, a step out below 20 % stays put", async () => {
  const { default: DmnModeler } = await import("dmn-js/lib/Modeler");
  const { mountDmnEngine } = await import("../src/mcp-app/engines/dmn.ts");
  // the engine keeps its dmn-js instance to itself; its import names it
  type Modeler = InstanceType<typeof DmnModeler>;
  const modelers: Modeler[] = [];
  const importXML = DmnModeler.prototype.importXML;
  DmnModeler.prototype.importXML = function (this: Modeler, xml: string) {
    modelers.push(this);
    return importXML.call(this, xml);
  };
  try {
    const { ran, deps, bind } = chromeKeys();
    const container = host("dmn-canvas");
    const engine = mountDmnEngine(container, false, { insets, chromeKeys: deps });
    bind(engine.view);
    await engine.importText(model("credit-limit-check.dmn"));
    await wait(0);
    assert.equal(engine.view.hasViewport(), true, "the DRD is the active view");
    const diagram = modelers[0]?.getActiveViewer() as unknown as Diagram;
    assert.ok(diagram);
    const own = spyOnOwnZoom(diagram);
    const svg = svgOf(container);

    viewAt(diagram, 0.12);
    assert.equal(press(svg, "-", "Minus", { metaKey: true }).defaultPrevented, true, "the page does not zoom");
    assert.deepEqual(own, [], "dmn-js's own zoom, which clamps to 20 % and so zooms in, never acts");
    assert.equal(levelOf(diagram), 0.12, "from a fit at 12 % a step out stays put");
    press(svg, "=", "Equal", { ctrlKey: true });
    assert.equal(levelOf(diagram), 0.2, "a step in goes to 20 %");
    press(svg, "0", "Numpad0", { ctrlKey: true });
    assert.equal(levelOf(diagram), 1);
    assert.deepEqual(ran, ["zoomOut", "zoomIn", "zoomToActual"], "each press runs once");
    assert.deepEqual(own, [], "dmn-js's own zoom never acts");
    engine.destroy();
    container.remove();
  } finally {
    DmnModeler.prototype.importXML = importXML;
  }
});
