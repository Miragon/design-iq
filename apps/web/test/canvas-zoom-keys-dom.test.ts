/**
 * The zoom keys, ⇧1 and the wheel of bpmn-js and the DMN DRD (guide §5.8),
 * on real canvases under jsdom (test/renderer-dom.ts): the SPA's editors
 * (src/notations/bpmn-io-keys.ts) and the widget's engines
 * (EngineOptions.chromeKeys) with the widget's document listener
 * (chrome/keys.ts). Cmd/Ctrl + `+` / `-` / `0` step on the guide's fixed
 * steps once per press and keep the page from zooming, ⇧1 fits, and
 * diagram-js's own zoom never acts: its step clamps to 20 %, so from a fit
 * below 20 % its zoom out zoomed in. A step out from there stays put, a step
 * in goes to 20 %, and the wheel stays put too. The keys act on the whole
 * document (the canvas, the toolbar, the page), except in a text field (the
 * Monaco source), under a modal dialog and while no diagram is on screen
 * (the source view, the DMN decision table). dmn-js keeps one DRD viewer and
 * binds it once: after a trip to a decision table and back a press still
 * acts once.
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
    zoom(level?: number, center?: unknown): number;
  };
  get(service: "zoomScroll"): { stepZoom(direction: number): void; toggle(enabled: boolean): void };
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

/**
 * One Ctrl + wheel turn out on the canvas, as a trackpad pinch sends it, and
 * the levels diagram-js's wheel zoom set for it: recorded, not applied (jsdom
 * keeps no CTM, renderer-dom.ts)
 */
function wheelOut(diagram: Diagram, container: HTMLElement): number[] {
  const canvas = diagram.get("canvas");
  const zoomScroll = diagram.get("zoomScroll");
  const set: number[] = [];
  canvas.zoom = (level?: number) => {
    if (level !== undefined) set.push(Math.round(level * 1000) / 1000);
    return canvas.viewbox().scale;
  };
  zoomScroll.toggle(true);
  try {
    const frame = container.querySelector(".djs-container");
    assert.ok(frame, "the canvas's frame, where diagram-js listens to the wheel");
    frame.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }));
  } finally {
    zoomScroll.toggle(false);
    delete (canvas as { zoom?: unknown }).zoom;
  }
  return set;
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

/** whether the SPA shows the canvas layer (EditorContext.visibility): the source view hides it */
const layer = { visible: true };

const context = (doc: Y.Doc, docPath: string): EditorContext =>
  ({
    ytext: doc.getText("content"),
    doc,
    docPath,
    onSyncError: assert.fail,
    onImportFailed: assert.fail,
    onBadgeClick: () => {},
    onSelectionChanged: () => {},
    visibility: { visible: () => layer.visible, onChange: () => () => {} },
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

/**
 * Opens the decision table and the DRD again: dmn-js says views.changed
 * each time, and the DRD's zoom stays bound once (a second canvas route
 * would also mean a second document listener and view). While the table
 * shows, no diagram is on screen and the browser keeps the keys.
 */
async function toTableAndBack(modeler: {
  getViews(): Array<{ type: string }>;
  getActiveViewer(): unknown;
  open(view: { type: string }): Promise<unknown>;
}): Promise<void> {
  const view = (type: string) => modeler.getViews().find((candidate) => candidate.type === type)!;
  type AddListener = (...args: unknown[]) => void;
  const drd = modeler.getActiveViewer() as { get(name: "keyboard"): { addListener: AddListener } };
  const keyboard = drd.get("keyboard");
  let routes = 0;
  const addListener = keyboard.addListener;
  keyboard.addListener = (...args) => {
    routes++;
    addListener.apply(keyboard, args);
  };
  try {
    await modeler.open(view("decisionTable"));
    await wait(10);
    assert.equal(press(document.body, "=", "Equal", { ctrlKey: true }).defaultPrevented, false, "the table scrolls");
    await modeler.open(view("drd"));
    await wait(10);
  } finally {
    keyboard.addListener = addListener;
  }
  assert.equal(routes, 0, "the DRD's zoom stays bound once");
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
    await toTableAndBack(modeler);
    assert.equal(modeler.getActiveViewer(), diagram, "dmn-js keeps its DRD viewer");
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
  test(`the SPA's ${name}: the zoom keys step once on the canvas and the rest of the page, never turn around below 20 %, and leave text fields, modal dialogs and the source view alone`, async () => {
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
    viewAt(diagram, 0.12);
    assert.deepEqual(wheelOut(diagram, container), [], "and so does the wheel, which clamps to 20 % as well");
    press(svg, "+", "NumpadAdd", { ctrlKey: true });
    assert.equal(levelOf(diagram), 0.2, "a step in goes to 20 %");

    assert.equal(press(svg, "0", "Digit0", { ctrlKey: true }).defaultPrevented, true);
    assert.equal(levelOf(diagram), 1, "Ctrl+0: 100 %");
    press(svg, "=", "Equal", { ctrlKey: true });
    assert.equal(levelOf(diagram), 1.349, "Ctrl+= one step in, to the guide's 135 %, once");
    press(svg, "-", "Minus", { metaKey: true });
    assert.equal(levelOf(diagram), 1, "⌘- one step out");
    assert.deepEqual(own, [], `${name}: diagram-js's own zoom never acts`);

    assert.deepEqual(wheelOut(diagram, container), [0.861], "from 100 % the wheel zooms out half a step");

    const toolbarButton = document.createElement("button");
    const source = document.createElement("div");
    source.className = "monaco-editor";
    const typed = document.createElement("textarea");
    source.append(typed);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.hidden = true;
    document.body.append(toolbarButton, source, dialog);
    assert.equal(press(toolbarButton, "=", "Equal", { ctrlKey: true }).defaultPrevented, true, "a toolbar button");
    assert.equal(levelOf(diagram), 1.349, "the page does not zoom, the diagram does, once");
    assert.equal(press(document.body, "-", "Minus", { metaKey: true }).defaultPrevented, true, "the page itself");
    assert.equal(levelOf(diagram), 1);
    assert.equal(press(typed, "=", "Equal", { ctrlKey: true }).defaultPrevented, false, "the source types");
    dialog.hidden = false;
    assert.equal(press(toolbarButton, "=", "Equal", { ctrlKey: true }).defaultPrevented, false, "a modal dialog");
    dialog.remove();
    layer.visible = false;
    assert.equal(press(document.body, "=", "Equal", { ctrlKey: true }).defaultPrevented, false, "the source view");
    layer.visible = true;
    toolbarButton.remove();
    source.remove();
    assert.equal(levelOf(diagram), 1, "the browser keeps those keys: none zoomed the diagram");

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
  hasViewport(): boolean;
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
    viewport: () => view?.hasViewport() ?? false,
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

/** the widget's one document listener (chrome/keys.ts), as shell.ts mounts it with the same deps */
async function documentKeys(deps: ChromeKeyDeps): Promise<() => void> {
  const { mountKeys } = await import("../src/mcp-app/chrome/keys.ts");
  return mountKeys(document, { save: () => false, escape: [], chromeKeys: deps });
}

test("the bpmn widget: its canvas and the rest of the document run the chrome's keys once each, a step out below 20 % stays put", async () => {
  const { mountBpmnEngine } = await import("../src/mcp-app/engines/bpmn.ts");
  const { ran, deps, bind } = chromeKeys();
  const container = host("bpmn-canvas");
  const engine = mountBpmnEngine(container, false, { insets, chromeKeys: deps });
  bind(engine.view);
  await engine.importText(model("order-to-cash.bpmn"));
  const diagram = engine.raw as unknown as Diagram;
  const own = spyOnOwnZoom(diagram);
  const unbindKeys = await documentKeys(deps);
  const svg = svgOf(container);

  viewAt(diagram, 0.12);
  assert.equal(press(svg, "-", "Minus", { ctrlKey: true }).defaultPrevented, true, "the page does not zoom");
  assert.deepEqual(own, [], "bpmn-js's own zoom, which clamps to 20 % and so zooms in, never acts");
  assert.equal(levelOf(diagram), 0.12, "from a fit at 12 % a step out stays put");
  viewAt(diagram, 0.12);
  assert.deepEqual(wheelOut(diagram, container), [], "and so does the wheel");
  press(svg, "=", "Equal", { metaKey: true });
  assert.equal(levelOf(diagram), 0.2, "a step in goes to 20 %");
  press(svg, "0", "Digit0", { ctrlKey: true });
  assert.equal(levelOf(diagram), 1);
  assert.equal(press(svg, "!", "Digit1", { shiftKey: true }).defaultPrevented, true);
  assert.deepEqual(ran, ["zoomOut", "zoomIn", "zoomToActual", "fit"], "each press runs once, ⇧1 too");
  assert.deepEqual(own, [], "bpmn-js's own zoom never acts");

  assert.deepEqual(wheelOut(diagram, container), [0.861], "from 100 % the wheel zooms out half a step");

  ran.length = 0;
  const chromeButton = document.createElement("button");
  document.body.append(chromeButton);
  assert.equal(press(chromeButton, "=", "Equal", { ctrlKey: true }).defaultPrevented, true, "a chrome button");
  assert.equal(levelOf(diagram), 1.349);
  assert.equal(press(document.body, "!", "Digit1", { shiftKey: true }).defaultPrevented, true, "the page");
  assert.deepEqual(ran, ["zoomIn", "fit"], "off the canvas the document runs them, once each");
  chromeButton.remove();

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

test("the read-only dmn widget: its DRD, which binds no keyboard, takes the chrome's keys through the document", async () => {
  const { default: DmnViewer } = await import("dmn-js/lib/Viewer");
  const { mountDmnEngine } = await import("../src/mcp-app/engines/dmn.ts");
  type Viewer = InstanceType<typeof DmnViewer>;
  const viewers: Viewer[] = [];
  const importXML = DmnViewer.prototype.importXML;
  DmnViewer.prototype.importXML = function (this: Viewer, xml: string) {
    viewers.push(this);
    return importXML.call(this, xml);
  };
  try {
    const { ran, deps, bind } = chromeKeys();
    const container = host("dmn-canvas");
    const engine = mountDmnEngine(container, true, { insets, chromeKeys: deps });
    bind(engine.view);
    await engine.importText(model("credit-limit-check.dmn"));
    await wait(0);
    const unbindKeys = await documentKeys(deps);
    const diagram = viewers[0]?.getActiveViewer() as unknown as Diagram;
    assert.ok(diagram);
    assert.throws(() => (diagram as unknown as { get(name: string): unknown }).get("keyboard"), "no keyboard");
    const svg = svgOf(container);

    viewAt(diagram, 1);
    assert.equal(press(svg, "=", "Equal", { ctrlKey: true }).defaultPrevented, true, "the page zoomed before");
    assert.equal(levelOf(diagram), 1.349);
    viewAt(diagram, 0.12);
    press(svg, "-", "Minus", { metaKey: true });
    assert.equal(levelOf(diagram), 0.12, "from a fit at 12 % a step out stays put");
    assert.deepEqual(ran, ["zoomIn", "zoomOut"], "each press runs once");
    unbindKeys();
    engine.destroy();
    container.remove();
  } finally {
    DmnViewer.prototype.importXML = importXML;
  }
});

test("the dmn widget: the DRD's canvas runs the chrome's keys once each, also after a trip to a table, a step out below 20 % stays put", async () => {
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
    const unbindKeys = await documentKeys(deps);
    await toTableAndBack(modelers[0]!);
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
    press(svg, "=", "Equal", { ctrlKey: true });
    assert.equal(levelOf(diagram), 1.349, "one step, once");
    assert.deepEqual(ran, ["zoomOut", "zoomIn", "zoomToActual", "zoomIn"], "each press runs once");
    assert.deepEqual(own, [], "dmn-js's own zoom never acts");
    viewAt(diagram, 0.12);
    assert.deepEqual(wheelOut(diagram, container), [], "the wheel stays put below 20 %");
    unbindKeys();
    engine.destroy();
    container.remove();
  } finally {
    DmnModeler.prototype.importXML = importXML;
  }
});
