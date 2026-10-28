/**
 * The focus after a click on the SPA's chrome (src/lib/canvas-focus.ts) on
 * the real canvases, one case per notation with a canvas: the Miragon
 * renderers (Wardley, Event Storming, Context Map, Team Topology, Value
 * Chain), bpmn-js
 * and the dmn-js DRD, each mounted by its SPA editor under jsdom
 * (test/renderer-dom.ts). Each hears Delete only while its canvas has the
 * focus. A click on the view switch's Diagram side, behind which the source
 * showed, hands the canvas the focus once it shows, and Delete deletes the
 * selection; Enter on it keeps the focus on the switch, and Delete does
 * nothing. A click on a Model action of the ⋯ menu hands the canvas the focus
 * as the menu closes; Enter on it leaves the focus to radix (the trigger).
 * Both hand-backs also hold under Safari's click model, where a pressed
 * button takes no focus and takes it off the canvas, so the click finds the
 * page focused (Miragon/modeler-suite#165): the click is dispatched without
 * moving the focus to the button. The toolbar's React wiring (the non-modal ⋯ menu, its entries' clicks):
 * test/toolbar-focus-dom.test.ts; the whole SPA in a browser:
 * test/canvas-focus-chromium.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import * as Y from "yjs";

import type { MiragonModeler } from "../src/notations/miragon/spec.ts";
import type { EditorContext, MountedEditor } from "../src/notations/registry.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

// bpmn-js asks a 2D canvas for nothing it needs here; jsdom has none and logs each call
(HTMLCanvasElement.prototype as unknown as { getContext(): null }).getContext = () => null;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface DiagramElement {
  id: string;
  parent?: unknown;
  labelTarget?: unknown;
  waypoints?: unknown;
}
interface DiagramServices {
  get(name: "elementRegistry"): { filter(fn: (element: DiagramElement) => boolean): DiagramElement[] };
  get(name: "selection"): { select(element: DiagramElement): void };
}

/** a mounted SPA editor and the diagram-js services of its canvas */
interface Mounted {
  editor: MountedEditor;
  container: HTMLElement;
  diagram(): DiagramServices;
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

const MIRAGON: Record<string, string> = {
  wardley: "title Tea Shop\ncomponent Cup of Tea [0.79, 0.61]\ncomponent Hot Water [0.82, 0.45]\n",
  "event-storming": "title Checkout\ncommand Place Order [240, 300]\nevent Order Placed [620, 300]\n",
  "context-map": JSON.stringify({
    version: 1,
    title: "Conference",
    contexts: [
      { id: "ctx_cfp", label: "CfP", position: { x: 40, y: 40 }, size: { width: 200, height: 110 } },
      { id: "ctx_agenda", label: "Agenda", position: { x: 500, y: 40 }, size: { width: 200, height: 110 } },
    ],
    relationships: [],
  }),
  "team-topology": JSON.stringify({
    version: 3,
    title: "Online Shop",
    nodes: [
      {
        id: "team_checkout",
        type: "stream-aligned",
        label: "Checkout",
        position: { x: 40, y: 40 },
        size: { width: 240, height: 96 },
      },
      {
        id: "team_payments",
        type: "stream-aligned",
        label: "Payments",
        position: { x: 500, y: 40 },
        size: { width: 240, height: 96 },
      },
    ],
    interactions: [],
    flows: [],
  }),
  "value-chain": JSON.stringify({
    schemaVersion: 1,
    meta: { name: "Order to Cash" },
    elements: [
      { id: "step_order", elementType: "step", name: "Order", bounds: { x: 40, y: 40, width: 200, height: 80 } },
      { id: "step_ship", elementType: "step", name: "Ship", bounds: { x: 500, y: 40, width: 200, height: 80 } },
    ],
    connections: [],
  }),
};

async function miragonEditor(id: string): Promise<Mounted> {
  const { MIRAGON_RENDERERS } = await import("../src/notations/miragon/index.ts");
  const { mountMiragonEditor } = await import("../src/notations/miragon/editor.ts");
  const spec = MIRAGON_RENDERERS.find((s) => s.id === id);
  assert.ok(spec, id);
  const renderer = await spec.load();
  const container = host(spec.canvasClassName);
  let modeler: MiragonModeler | undefined;
  const editor = mountMiragonEditor(
    spec,
    { ...renderer, create: (options) => (modeler = renderer.create(options)) },
    container,
    context(docOf(MIRAGON[id]!), `processes/${id}.model`),
  );
  await wait(50);
  return { editor, container, diagram: () => modeler!.diagram as unknown as DiagramServices };
}

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:task id="Task_check" name="Check order" />
    <bpmn:task id="Task_ship" name="Ship order" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="Task_check_di" bpmnElement="Task_check"><dc:Bounds x="100" y="100" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_ship_di" bpmnElement="Task_ship"><dc:Bounds x="400" y="100" width="100" height="80" /></bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;

async function bpmnEditor(): Promise<Mounted> {
  const { default: BpmnModeler } = await import("bpmn-js/lib/Modeler.js");
  const { mountBpmnEditor } = await import("../src/notations/bpmn-editor.ts");
  // the editor keeps its bpmn-js to itself; its first import names it
  const modelers: DiagramServices[] = [];
  const importXML = BpmnModeler.prototype.importXML;
  BpmnModeler.prototype.importXML = function (this: DiagramServices, ...args: Parameters<typeof importXML>) {
    modelers.push(this);
    return importXML.apply(this, args);
  };
  try {
    const container = host("bpmn-canvas");
    const editor = await mountBpmnEditor(container, context(docOf(BPMN), "processes/order.bpmn"));
    await wait(300);
    return { editor, container, diagram: () => modelers[0]! };
  } finally {
    BpmnModeler.prototype.importXML = importXML;
  }
}

async function dmnEditor(): Promise<Mounted> {
  const { default: DmnModeler } = await import("dmn-js/lib/Modeler");
  const { mountDmnEditor } = await import("../src/notations/dmn-editor.ts");
  type Modeler = InstanceType<typeof DmnModeler>;
  const xml = readFileSync(
    new URL("../../../process-documentation/processes/credit-limit-check.dmn", import.meta.url),
    "utf8",
  );
  const modelers: Modeler[] = [];
  const importXML = DmnModeler.prototype.importXML;
  DmnModeler.prototype.importXML = function (this: Modeler, text: string) {
    modelers.push(this);
    return importXML.call(this, text);
  };
  try {
    const container = host("dmn-canvas");
    const editor = await mountDmnEditor(container, context(docOf(xml), "processes/credit-limit-check.dmn"));
    await wait(300);
    const modeler = modelers[0]!;
    assert.equal(modeler.getActiveView()?.type, "drd", "the editor opens on the DRD");
    return { editor, container, diagram: () => modeler.getActiveViewer() as unknown as DiagramServices };
  } finally {
    DmnModeler.prototype.importXML = importXML;
  }
}

const EDITORS: Array<[name: string, mount: () => Promise<Mounted>]> = [
  ...Object.keys(MIRAGON).map((id): [string, () => Promise<Mounted>] => [id, () => miragonEditor(id)]),
  ["bpmn", bpmnEditor],
  ["dmn", dmnEditor],
];

for (const [name, mount] of EDITORS) {
  test(`${name}: a click on the Diagram side or a Model action hands the canvas the focus, and Delete acts there; Enter keeps the guide's focus`, async () => {
    const { focusCanvasIn, isPointerClick, menuCloseFocus, viewSwitchFocus } =
      await import("../src/lib/canvas-focus.ts");
    const { editor, container, diagram } = await mount();
    const svg = container.querySelector(".djs-container > svg");
    assert.ok(svg, `${name}: the canvas`);
    /** what a user can select and delete (no root, no external label, no connection) */
    const shapes = (): DiagramElement[] =>
      diagram()
        .get("elementRegistry")
        .filter((element) => element.parent !== undefined && !element.labelTarget && !element.waypoints);
    const select = (): void => diagram().get("selection").select(shapes()[0]!);
    const pressDelete = (): void =>
      void document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
      );

    // the shell's canvas (live-editor.tsx): the layer shows or the source does
    let shown = true;
    const canvas = { shown: () => shown, focus: () => focusCanvasIn(container, editor) };
    const views = viewSwitchFocus(canvas);
    const diagramSide = document.createElement("button");
    const trigger = document.createElement("button");
    document.body.append(diagramSide, trigger);
    diagramSide.addEventListener("click", (event) => views.chose("canvas", isPointerClick(event)));
    const showSource = (): void => {
      views.chose("source", true);
      shown = false;
      views.shown();
    };
    const showCanvas = (): void => {
      shown = true;
      views.shown();
    };
    /** the button's own activation: Enter and Space click with detail 0, a pointer with 1 */
    const activate = (button: HTMLElement, detail: number): void => {
      button.focus();
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
    };

    select();
    const before = shapes().length;
    showSource();
    activate(diagramSide, 0);
    showCanvas();
    assert.equal(document.activeElement, diagramSide, `${name}: Enter on Diagram keeps the focus on the switch`);
    pressDelete();
    assert.equal(shapes().length, before, `${name}: the switch keeps Delete`);

    showSource();
    activate(diagramSide, 1);
    assert.equal(document.activeElement, diagramSide, `${name}: the canvas is not on screen yet`);
    showCanvas();
    assert.equal(document.activeElement, svg, `${name}: a click on Diagram hands the canvas the focus`);
    pressDelete();
    assert.equal(shapes().length, before - 1, `${name}: Delete deletes the selection`);

    const menu = menuCloseFocus();
    select();
    trigger.focus();
    menu.actedOnCanvas({ detail: 0 });
    assert.equal(menu.closing(canvas), false, `${name}: Enter on a Model action leaves the focus to radix`);
    assert.equal(document.activeElement, trigger);
    menu.pointerReleased();
    menu.actedOnCanvas({ detail: 1 });
    assert.equal(menu.closing(canvas), true, `${name}: a click on a Model action settles the focus`);
    assert.equal(document.activeElement, svg, `${name}: on the canvas`);
    pressDelete();
    assert.equal(shapes().length, before - 2, `${name}: Delete deletes the selection`);

    editor.destroy();
    diagramSide.remove();
    trigger.remove();
    container.remove();
  });
}

/** a pointer click as Safari runs it: the pressed button takes no focus and takes it off what held it */
function clickLikeSafari(button: HTMLElement): void {
  const pressed = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1 });
  if (button.dispatchEvent(pressed)) (document.activeElement as HTMLElement | SVGElement | null)?.blur();
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
}

for (const [name, mount] of EDITORS) {
  test(`${name}: clicking as Safari does, the Diagram side and a Model action hand the canvas the focus, and Delete and Ctrl+Z act there`, async () => {
    const { focusCanvasIn, isPointerClick, menuCloseFocus, viewSwitchFocus } =
      await import("../src/lib/canvas-focus.ts");
    const { editor, container, diagram } = await mount();
    const svg = container.querySelector(".djs-container > svg");
    assert.ok(svg, `${name}: the canvas`);
    const shapes = (): DiagramElement[] =>
      diagram()
        .get("elementRegistry")
        .filter((element) => element.parent !== undefined && !element.labelTarget && !element.waypoints);
    const select = (): void => diagram().get("selection").select(shapes()[0]!);
    const press = (key: string, init: KeyboardEventInit = {}): void =>
      void document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
      );

    let shown = true;
    const canvas = { shown: () => shown, focus: () => focusCanvasIn(container, editor) };
    const views = viewSwitchFocus(canvas);
    const sourceSide = document.createElement("button");
    const diagramSide = document.createElement("button");
    document.body.append(sourceSide, diagramSide);
    sourceSide.addEventListener("click", (event) => {
      views.chose("source", isPointerClick(event));
      shown = false;
      views.shown();
    });
    diagramSide.addEventListener("click", (event) => views.chose("canvas", isPointerClick(event)));
    const showCanvas = (): void => {
      shown = true;
      views.shown();
    };

    try {
      (svg as SVGSVGElement).focus();
      select();
      const before = shapes().length;
      clickLikeSafari(sourceSide);
      assert.equal(document.activeElement, document.body, `${name}: the press took the focus off the canvas`);
      clickLikeSafari(diagramSide);
      assert.equal(document.activeElement, document.body, `${name}: the clicked button took none`);
      showCanvas();
      assert.equal(document.activeElement, svg, `${name}: a click on Diagram hands the canvas the focus`);
      press("Delete");
      assert.equal(shapes().length, before - 1, `${name}: Delete deletes the selection`);
      press("z", { ctrlKey: true, code: "KeyZ" });
      assert.equal(shapes().length, before, `${name}: Ctrl+Z brings it back`);

      const menu = menuCloseFocus();
      select();
      (document.activeElement as HTMLElement | SVGElement | null)?.blur();
      menu.pointerReleased();
      menu.actedOnCanvas({ detail: 1 });
      assert.equal(menu.closing(canvas), true, `${name}: a click on a Model action settles the focus`);
      assert.equal(document.activeElement, svg, `${name}: on the canvas, from the page`);
      press("Delete");
      assert.equal(shapes().length, before - 1, `${name}: Delete deletes the selection`);
      press("z", { ctrlKey: true, code: "KeyZ" });
      assert.equal(shapes().length, before, `${name}: Ctrl+Z brings it back`);
    } finally {
      editor.destroy();
      sourceSide.remove();
      diagramSide.remove();
      container.remove();
    }
  });
}
