/**
 * A gesture on the canvas holds a peer's re-import back (#295, live-client's
 * sync rule 3), with the real modelers apps/web mounts, under jsdom
 * (test/renderer-dom.ts). The bpmn-js and dmn-js mounts hand the live binding
 * the element they mount the canvas in, whose DOM it reads; a Miragon
 * renderer reports its gestures itself (contract 1.5's interaction surface),
 * and a press that starts no drag is none. A pointer held on the SPA's
 * bpmn-js canvas, or a drag on its Miragon canvas, keeps the widget peer's
 * move off it until the release; a diagram-js move in the widget's canvas
 * (its marker on the root element, its preview drawn) keeps the SPA's move
 * off it until the drag ends. Each canvas's own drop then merges with the
 * other's: both moves in the shared text and on both canvases, nobody told
 * of a conflict. An armed palette tool (bpmn-js's hand tool, a Miragon
 * renderer's lasso) sets the marker and draws no preview: it holds nothing
 * back, and the binding sends it no Escape (bpmn-js's hand tool stays armed
 * through the import). A bpmn-js drop or create that bpmn-js writes into the
 * text across the held move's DI merges with it line by line (#309), and so
 * does a dmn-js DRD create; a drop that moves the task the held move moved
 * gives way to it, with the conflict toast and no exception. A bpmn-js drag
 * that outlasts 10 s is cancelled by the binding's Escape, the way the user
 * cancels it, before the import runs; a Miragon drag that outlasts 10 s ends
 * in the renderer's own import, with no Escape sent.
 * jsdom has no layout, so the drags here run diagram-js's dragging without a
 * pointer; pointer drags in a browser: test/live-gesture-chromium.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { isDeepStrictEqual } from "node:util";

import * as Y from "yjs";

import type { EditorContext } from "../src/notations/registry.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

// bpmn-js asks a 2D canvas for nothing it needs here; jsdom has none and logs each call
(HTMLCanvasElement.prototype as unknown as { getContext(): null }).getContext = () => null;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** past the import's debounce: a peer's change not held back is on the canvas by now */
const QUIET = 1300;
/** a local edit's quiet period and the import's debounce, with margin */
const SETTLED = 2500;

const RELAYED = Symbol("relayed");

/** two Y.Docs on one room, every update relayed at once, as through the Live Host */
function room(text: string): [Y.Doc, Y.Doc] {
  const seed = new Y.Doc();
  seed.getText("content").insert(0, text);
  const state = Y.encodeStateAsUpdate(seed);
  const docs = [new Y.Doc(), new Y.Doc()];
  for (const doc of docs) {
    Y.applyUpdate(doc, state, RELAYED);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === RELAYED) return;
      for (const to of docs) if (to !== doc) Y.applyUpdate(to, update, RELAYED);
    });
  }
  return docs as [Y.Doc, Y.Doc];
}

const editorContext = (doc: Y.Doc, conflicts: string[]): EditorContext =>
  ({
    ytext: doc.getText("content"),
    doc,
    onSyncError: (message: string) => conflicts.push(message),
    onImportFailed: (message: string) => conflicts.push(`import failed: ${message}`),
    onBadgeClick: () => {},
    onSelectionChanged: () => {},
  }) as unknown as EditorContext;

interface Point {
  x: number;
  y: number;
}

interface Dragging {
  init(event: null, relativeTo: Point, prefix: string, options?: { manual?: boolean }): void;
  move(event: { clientX: number; clientY: number }, activate?: boolean): void;
  cancel(): void;
  context(): unknown;
}

/**
 * a mouse event as diagram-js reads it; no MouseEvent, so diagram-js's hover
 * fix does not ask jsdom for document.elementFromPoint, which it lacks
 */
interface PointerPosition {
  clientX: number;
  clientY: number;
  target?: Element;
}

/** a diagram-js element as these tests read it */
interface Shape extends Point {
  id: string;
  type: string;
}

interface Diagram {
  get(name: "elementRegistry"): {
    get(id: string): Point | undefined;
    getGraphics(id: string): Element;
    filter(match: (element: Shape) => boolean): Shape[];
  };
  get(name: "modeling"): {
    moveElements(elements: unknown[], delta: Point): void;
    createShape(shape: { type: string }, position: Point, parent: unknown): unknown;
  };
  get(name: "canvas"): { getRootElement(): unknown };
  get(name: "dragging"): Dragging;
  get(name: "move"): { start(event: PointerPosition, element: unknown, activate: boolean): unknown };
  get(name: "handTool"): { activateHand(event: PointerPosition, autoActivate: boolean): void };
  get(name: "lassoTool"): { activateSelection(event: PointerPosition, autoActivate: boolean): void };
}

function positionOf(diagram: Diagram, id: string): Point {
  const element = diagram.get("elementRegistry").get(id);
  assert.ok(element, id);
  return { x: element.x, y: element.y };
}

const moveElement = (diagram: Diagram, id: string, delta: Point): void =>
  diagram.get("modeling").moveElements([diagram.get("elementRegistry").get(id)], delta);

const shifted = ({ x, y }: Point, delta: Point): Point => ({ x: x + delta.x, y: y + delta.y });
/** a renderer that stores coordinates rounded (Wardley: evolution and visibility to two decimals) moves a shape by about the delta */
const near = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2;

/** a diagram-js move of an element, with no pointer: the marker on the root element and the preview are what the binding sees */
function startDrag(diagram: Diagram, canvasHost: HTMLElement, id: string): Dragging {
  const registry = diagram.get("elementRegistry");
  // move.start reads the press's target (a hit area may refuse to move)
  diagram.get("move").start({ clientX: 40, clientY: 40, target: registry.getGraphics(id) }, registry.get(id), true);
  assert.ok(canvasHost.getElementsByClassName("djs-drag-active").length > 0, "the drag marker is set");
  assert.ok(canvasHost.getElementsByClassName("djs-dragger").length > 0, "the drag preview is drawn");
  return diagram.get("dragging");
}

/** the last pointer position diagram-js keeps, which a palette tool arms at */
const pointerAt = (): PointerPosition => ({ clientX: 60, clientY: 60 });

const pointer = (type: string): PointerEvent => new PointerEvent(type, { bubbles: true, pointerId: 1 });

interface Peer {
  diagram: Diagram;
  canvasHost: HTMLElement;
  conflicts: string[];
  /** the canvas's export, where it is the shared text byte for byte after an import */
  exportText?(): string;
  /** a Miragon renderer's own report of a running gesture, which its binding waits on */
  gestureActive?(): boolean;
}

/**
 * Holds a gesture on the peer's canvas until the returned release: a pointer
 * held on it where the binding reads the DOM (bpmn-js), a drag where the
 * renderer reports its gestures itself, to which a press is none.
 */
function holdGesture(peer: Peer, id: string, what: string): () => void {
  if (!peer.gestureActive) {
    peer.canvasHost.querySelector("svg")!.dispatchEvent(pointer("pointerdown"));
    return () => window.dispatchEvent(pointer("pointerup"));
  }
  const dragging = startDrag(peer.diagram, peer.canvasHost, id);
  assert.equal(peer.gestureActive(), true, `${what}: the renderer reports the drag`);
  return () => {
    dragging.cancel();
    assert.equal(peer.gestureActive?.(), false, `${what}: and its end`);
  };
}

const MOVE_IN_SPA: Point = { x: 30, y: 0 };
const MOVE_IN_WIDGET: Point = { x: 0, y: 40 };

/**
 * The SPA's pointer holds the widget's move back, the widget's drag holds
 * the SPA's move back; each drop merges with the other peer's move.
 */
async function bothGesturesHold(
  what: string,
  docs: [Y.Doc, Y.Doc],
  [spa, widget]: [Peer, Peer],
  [spaElement, widgetElement]: [string, string],
  /** where the shared text puts an element, for a modeler whose export of an import differs from it */
  inText?: (text: string, id: string) => Point,
): Promise<void> {
  const shared = docs[0].getText("content");
  const positions = (peer: Peer) => [positionOf(peer.diagram, spaElement), positionOf(peer.diagram, widgetElement)];
  const start = positions(spa);
  assert.deepEqual(positions(widget), start, what);
  const expectBothMoves = async (moves: number, where: string): Promise<void> => {
    const [spaStart, widgetStart] = start as [Point, Point];
    const expected = [
      shifted(spaStart, { x: MOVE_IN_SPA.x * moves, y: MOVE_IN_SPA.y * moves }),
      shifted(widgetStart, { x: MOVE_IN_WIDGET.x * moves, y: MOVE_IN_WIDGET.y * moves }),
    ];
    assert.equal(docs[1].getText("content").toString(), shared.toString(), `${what} ${where}: the peers converge`);
    const text = shared.toString();
    if (inText) {
      const actual = [inText(text, spaElement), inText(text, widgetElement)];
      assert.deepEqual(actual, expected, `${what} ${where}: both moves in the shared text`);
    }
    for (const peer of [spa, widget]) {
      if (peer.exportText) assert.equal(peer.exportText(), text, `${what} ${where}: each canvas shows the shared text`);
      const actual = positions(peer);
      assert.ok(
        actual.every((point, index) => near(point, expected[index]!)),
        `${what} ${where}: both moves, on both canvases: ${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`,
      );
    }
    assert.deepEqual([spa.conflicts, widget.conflicts], [[], []], `${what} ${where}: nobody lost an edit`);
  };

  const releaseSpa = holdGesture(spa, spaElement, `${what} in the SPA`);
  moveElement(widget.diagram, widgetElement, MOVE_IN_WIDGET);
  await wait(QUIET);
  assert.deepEqual(positions(spa), start, `${what}: the SPA canvas waits while its gesture runs`);
  releaseSpa();
  moveElement(spa.diagram, spaElement, MOVE_IN_SPA);
  await wait(SETTLED);
  await expectBothMoves(1, "after the SPA's drop");

  const before = positions(widget);
  const dragging = startDrag(widget.diagram, widget.canvasHost, widgetElement);
  if (widget.gestureActive)
    assert.equal(widget.gestureActive(), true, `${what}: the renderer reports the widget's drag`);
  moveElement(spa.diagram, spaElement, MOVE_IN_SPA);
  await wait(QUIET);
  assert.deepEqual(positions(widget), before, `${what}: the widget canvas waits while its drag runs`);
  dragging.cancel();
  moveElement(widget.diagram, widgetElement, MOVE_IN_WIDGET);
  await wait(SETTLED);
  await expectBothMoves(2, "after the widget's drop");
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

type BpmnModelerLike = Diagram & { saveXML(options: { format: boolean }): Promise<{ xml?: string }> };

/** the first edit of a file bpmn-js did not write rewrites all of it: a test starts from its own export */
async function canonicalBpmn(): Promise<string> {
  const { default: BpmnModeler } = await import("bpmn-js/lib/Modeler.js");
  const canonical = new BpmnModeler({ container: host() }) as unknown as BpmnModelerLike & {
    importXML(xml: string): Promise<unknown>;
    destroy(): void;
  };
  await canonical.importXML(BPMN);
  const xml = (await canonical.saveXML({ format: true })).xml!;
  canonical.destroy();
  return xml;
}

/** bpmn-js orders the DI of a re-imported move its own way on export: the shared text is read for where it puts a task */
function boundsIn(text: string, id: string): Point {
  const match = new RegExp(`bpmnElement="${id}">\\s*<dc:Bounds x="(-?[\\d.]+)" y="(-?[\\d.]+)"`).exec(text);
  assert.ok(match, id);
  return { x: Number(match[1]), y: Number(match[2]) };
}

test("bpmn-js: a gesture in the SPA editor or the widget holds the other peer's move back; both drops end up in the text", async () => {
  const { default: BpmnModeler } = await import("bpmn-js/lib/Modeler.js");
  const { mountBpmnEditor } = await import("../src/notations/bpmn-editor.ts");
  const { mountBpmnEngine } = await import("../src/mcp-app/engines/bpmn.ts");
  type Modeler = BpmnModelerLike;
  const xml = await canonicalBpmn();

  // the SPA editor keeps its bpmn-js instance to itself; its first import names it
  const modelers: Modeler[] = [];
  const importXML = BpmnModeler.prototype.importXML;
  BpmnModeler.prototype.importXML = function (this: Modeler, ...args: Parameters<typeof importXML>) {
    if (!modelers.includes(this)) modelers.push(this);
    return importXML.apply(this, args);
  };
  const docs = room(xml);
  const spaHost = host("bpmn-canvas");
  const spaConflicts: string[] = [];
  const editor = await mountBpmnEditor(spaHost, editorContext(docs[0], spaConflicts));
  const widgetHost = host("bpmn-canvas");
  const widgetConflicts: string[] = [];
  const engine = mountBpmnEngine(widgetHost, false, { insets: () => ({ top: 56, right: 0, bottom: 0, left: 0 }) });
  const unbind = engine.bindLive!(docs[1].getText("content"), docs[1], {
    onConflict: (message) => widgetConflicts.push(message),
    onImportError: (message) => widgetConflicts.push(`import failed: ${message}`),
  });
  await wait(300);
  BpmnModeler.prototype.importXML = importXML;
  const widgetModeler = engine.raw as unknown as Modeler;
  const spaModeler = modelers.find((modeler) => modeler !== widgetModeler);
  assert.ok(spaModeler, "the SPA editor's bpmn-js");
  await bothGesturesHold(
    "bpmn-js",
    docs,
    [
      { diagram: spaModeler, canvasHost: spaHost, conflicts: spaConflicts },
      { diagram: widgetModeler, canvasHost: widgetHost, conflicts: widgetConflicts },
    ],
    // bpmn-js writes a moved shape's DI last: the SPA moves the shape that is
    // last already, so its drop rewrites one line, which merges with the widget's
    ["Task_ship", "Task_check"],
    boundsIn,
  );
  unbind();
  engine.destroy();
  editor.destroy();
});

test("the Miragon renderers: a gesture in the SPA editor or the widget holds the other peer's move back; both drops end up in the text", async () => {
  const { MIRAGON_RENDERERS } = await import("../src/notations/miragon/index.ts");
  const { mountMiragonEditor } = await import("../src/notations/miragon/editor.ts");
  const { mountMiragonEngine } = await import("../src/mcp-app/engines/miragon.ts");
  const files: Array<[id: string, text: string, moved: [string, string]]> = [
    [
      "wardley",
      "title Tea Shop\ncomponent Cup of Tea [0.79, 0.61]\ncomponent Hot Water [0.82, 0.78]\ncomponent Kettle [0.43, 0.35]\nCup of Tea->Hot Water\nHot Water->Kettle\n",
      ["cmp_cup_of_tea", "cmp_kettle"],
    ],
    [
      "event-storming",
      "title Checkout\ncommand Place Order [240,300]\nevent Order Placed [620,300]\nevent Order Shipped [900,300]\nPlace Order -> Order Placed\n",
      ["cmd_place_order", "event_order_shipped"],
    ],
    [
      "context-map",
      JSON.stringify({
        version: 1,
        title: "Conference",
        contexts: [
          { label: "CfP", id: "ctx_cfp", position: { x: 40, y: 40 }, size: { width: 200, height: 110 } },
          { label: "Agenda", id: "ctx_agenda", position: { x: 400, y: 40 }, size: { width: 200, height: 110 } },
        ],
        relationships: [],
      }),
      ["ctx_cfp", "ctx_agenda"],
    ],
    [
      "team-topology",
      JSON.stringify({
        version: 3,
        title: "Online Shop",
        nodes: [
          {
            label: "Platform",
            id: "team_platform",
            type: "platform",
            position: { x: 40, y: 300 },
            size: { width: 520, height: 96 },
          },
          {
            label: "Checkout",
            id: "team_checkout",
            type: "stream-aligned",
            position: { x: 40, y: 40 },
            size: { width: 240, height: 96 },
          },
        ],
        interactions: [],
        flows: [],
      }),
      ["team_checkout", "team_platform"],
    ],
    [
      "value-chain",
      JSON.stringify({
        schemaVersion: 1,
        meta: { name: "Order to Cash" },
        elements: [
          { name: "Ship", id: "step_ship", elementType: "step", bounds: { x: 400, y: 40, width: 200, height: 80 } },
          { name: "Order", id: "step_order", elementType: "step", bounds: { x: 40, y: 40, width: 200, height: 80 } },
        ],
        connections: [],
      }),
      ["step_order", "step_ship"],
    ],
  ];
  assert.deepEqual(files.map(([id]) => id).sort(), MIRAGON_RENDERERS.map((spec) => spec.id).sort(), "every renderer");
  for (const [id, text, moved] of files) {
    const spec = MIRAGON_RENDERERS.find((s) => s.id === id);
    assert.ok(spec, id);
    const renderer = await spec.load();
    // the first edit of a hand-written file rewrites all of it: start from the renderer's own export
    const canonical = renderer.create();
    canonical.attachTo(host(spec.canvasClassName));
    await canonical.importText(text);
    const docs = room(canonical.exportText());
    canonical.destroy();

    const spaHost = host(spec.canvasClassName);
    const spaConflicts: string[] = [];
    let spa: ReturnType<typeof renderer.create> | undefined;
    const editor = mountMiragonEditor(
      spec,
      { ...renderer, create: (options) => (spa = renderer.create(options)) },
      spaHost,
      editorContext(docs[0], spaConflicts),
    );
    const widgetHost = host(spec.canvasClassName);
    const widgetConflicts: string[] = [];
    const engine = mountMiragonEngine(spec, renderer, widgetHost, false, {
      insets: () => ({ top: 56, right: 0, bottom: 0, left: 0 }),
    });
    const unbind = engine.bindLive!(docs[1].getText("content"), docs[1], {
      onConflict: (message) => widgetConflicts.push(message),
      onImportError: (message) => widgetConflicts.push(`import failed: ${message}`),
    });
    await wait(100);
    assert.ok(spa, id);
    const spaModeler = spa;

    await bothGesturesHold(
      id,
      docs,
      [
        {
          diagram: spaModeler.diagram as unknown as Diagram,
          canvasHost: spaHost,
          conflicts: spaConflicts,
          exportText: () => spaModeler.exportText(),
          gestureActive: () => spaModeler.interaction!.active(),
        },
        {
          diagram: engine.modeler.diagram as unknown as Diagram,
          canvasHost: widgetHost,
          conflicts: widgetConflicts,
          exportText: () => engine.modeler.exportText(),
          gestureActive: () => engine.modeler.interaction!.active(),
        },
      ],
      moved,
    );
    unbind();
    engine.destroy();
    editor.destroy();
  }
});

test("dmn-js: a pointer held on the SPA editor holds a peer's change back until the release", async () => {
  const { default: DmnModeler } = await import("dmn-js/lib/Modeler");
  const { mountDmnEditor } = await import("../src/notations/dmn-editor.ts");
  const xml = readFileSync(
    new URL("../../../process-documentation/processes/credit-limit-check.dmn", import.meta.url),
    "utf8",
  );
  const imported: string[] = [];
  const importXML = DmnModeler.prototype.importXML;
  DmnModeler.prototype.importXML = function (this: InstanceType<typeof DmnModeler>, xml: string) {
    imported.push(xml);
    return importXML.call(this, xml);
  };
  try {
    const docs = room(xml);
    const spaHost = host("dmn-canvas");
    const conflicts: string[] = [];
    const editor = await mountDmnEditor(spaHost, editorContext(docs[0], conflicts));
    await wait(300);
    assert.equal(imported.length, 1, "the first import");

    spaHost.dispatchEvent(pointer("pointerdown"));
    const peer = docs[1].getText("content");
    const at = peer.toString().indexOf("</definitions>");
    assert.ok(at > 0);
    peer.insert(at, "  <!-- a peer's note -->\n");
    await wait(QUIET);
    assert.equal(imported.length, 1, "no import while the pointer is down");
    window.dispatchEvent(pointer("pointerup"));
    await wait(QUIET);
    assert.equal(imported.length, 2, "imported after the release");
    assert.ok(imported[1]!.includes("a peer's note"));
    assert.deepEqual(conflicts, []);
    editor.destroy();
  } finally {
    DmnModeler.prototype.importXML = importXML;
  }
});

test("a Miragon drag that outlasts 10 s gives way: the renderer's own import ends it, no Escape sent, and the peer's move is in", async () => {
  const { MIRAGON_RENDERERS } = await import("../src/notations/miragon/index.ts");
  const { mountMiragonEngine } = await import("../src/mcp-app/engines/miragon.ts");
  const spec = MIRAGON_RENDERERS.find((s) => s.id === "wardley");
  assert.ok(spec);
  const renderer = await spec.load();
  const canonical = renderer.create();
  canonical.attachTo(host(spec.canvasClassName));
  await canonical.importText("title Tea Shop\ncomponent Cup of Tea [0.79, 0.61]\ncomponent Kettle [0.43, 0.35]\n");
  const docs = room(canonical.exportText());
  canonical.destroy();
  const engines = docs.map((doc) => {
    const canvasHost = host(spec.canvasClassName);
    const engine = mountMiragonEngine(spec, renderer, canvasHost, false);
    const conflicts: string[] = [];
    const unbind = engine.bindLive!(doc.getText("content"), doc, {
      onConflict: (message) => conflicts.push(message),
      onImportError: (message) => conflicts.push(`import failed: ${message}`),
    });
    return { engine, canvasHost, conflicts, unbind, diagram: engine.modeler.diagram as unknown as Diagram };
  });
  const [local, peer] = engines as [(typeof engines)[0], (typeof engines)[0]];
  const errors: unknown[] = [];
  const onError = (event: ErrorEvent): void => void errors.push(event.error);
  window.addEventListener("error", onError);
  const page = watchPage();
  await wait(100);
  const start = positionOf(local.diagram, "cmp_kettle");

  const dragging = startDrag(local.diagram, local.canvasHost, "cmp_cup_of_tea");
  moveElement(peer.diagram, "cmp_kettle", MOVE_IN_WIDGET);
  await wait(9_000);
  assert.deepEqual(positionOf(local.diagram, "cmp_kettle"), start, "held for nearly 10 s");
  assert.ok(dragging.context(), "the drag still runs");
  await wait(2_000);
  assert.equal(dragging.context(), null, "the drag is cancelled");
  assert.equal(local.engine.modeler.interaction?.active(), false, "the renderer reports its end");
  assert.equal(page.seen.escapes, 0, "by the renderer's import, no Escape sent");
  assert.equal(local.canvasHost.getElementsByClassName("djs-drag-active").length, 0, "its marker is gone");
  assert.ok(near(positionOf(local.diagram, "cmp_kettle"), shifted(start, MOVE_IN_WIDGET)), "the peer's move is in");
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 80, clientY: 80 }));
  await wait(QUIET);
  assert.deepEqual(errors, [], "nothing thrown");
  assert.equal(local.engine.modeler.exportText(), docs[0].getText("content").toString());
  assert.deepEqual([local.conflicts, peer.conflicts], [[], []]);
  window.removeEventListener("error", onError);
  page.stop();
  for (const { unbind, engine } of engines) {
    unbind();
    engine.destroy();
  }
});

test("a bpmn-js drag that outlasts 10 s gives way: the binding's Escape cancels it, then the peer's move is imported", async () => {
  const docs = room(await canonicalBpmn());
  const [local, peer] = (await bpmnEngines(docs)) as [Engine, Engine];
  const page = watchPage();
  const check = positionOf(local.diagram, "Task_check");
  const ship = positionOf(local.diagram, "Task_ship");

  const dragging = startDrag(local.diagram, local.canvasHost, "Task_check");
  moveElement(peer.diagram, "Task_ship", MOVE_IN_WIDGET);
  await wait(9_000);
  assert.deepEqual(positionOf(local.diagram, "Task_ship"), ship, "held for nearly 10 s");
  assert.ok(dragging.context(), "the drag still runs");
  await wait(2_000);
  assert.equal(dragging.context(), null, "the drag is cancelled");
  assert.ok(page.seen.escapes > 0, "by the binding's Escape");
  assert.equal(local.canvasHost.getElementsByClassName("djs-drag-active").length, 0, "its marker is gone");
  assert.deepEqual(positionOf(local.diagram, "Task_ship"), shifted(ship, MOVE_IN_WIDGET), "the peer's move is in");
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 80, clientY: 80 }));
  await wait(QUIET);
  const text = docs[0].getText("content").toString();
  assert.equal(docs[1].getText("content").toString(), text, "the peers converge");
  assert.deepEqual(boundsIn(text, "Task_ship"), shifted(ship, MOVE_IN_WIDGET), "the peer's move stays in the text");
  assert.deepEqual(boundsIn(text, "Task_check"), check, "the cancelled drag moved nothing");
  assert.deepEqual(positionOf(local.diagram, "Task_check"), check, "nor on the canvas");
  assert.deepEqual(page.seen.errors, [], "nothing thrown");
  assert.deepEqual([local.conflicts, peer.conflicts], [[], []]);
  page.stop();
  for (const engine of [local, peer]) engine.destroy();
});

interface Engine {
  diagram: Diagram;
  canvasHost: HTMLElement;
  conflicts: string[];
  destroy(): void;
}

/** one bpmn-js widget engine per doc, each bound live to its doc */
async function bpmnEngines(docs: readonly Y.Doc[]): Promise<Engine[]> {
  const { mountBpmnEngine } = await import("../src/mcp-app/engines/bpmn.ts");
  const engines = docs.map((doc) => {
    const canvasHost = host("bpmn-canvas");
    const engine = mountBpmnEngine(canvasHost, false);
    const conflicts: string[] = [];
    const unbind = engine.bindLive!(doc.getText("content"), doc, {
      onConflict: (message) => conflicts.push(message),
      onImportError: (message) => conflicts.push(`import failed: ${message}`),
    });
    return {
      diagram: engine.raw as unknown as Diagram,
      canvasHost,
      conflicts,
      destroy: () => {
        unbind();
        engine.destroy();
      },
    };
  });
  await wait(300);
  return engines;
}

/** one engine of a Miragon renderer per doc, each bound live to its doc */
async function miragonEngines(id: string, text: string, count: number): Promise<{ docs: Y.Doc[]; engines: Engine[] }> {
  const { MIRAGON_RENDERERS } = await import("../src/notations/miragon/index.ts");
  const { mountMiragonEngine } = await import("../src/mcp-app/engines/miragon.ts");
  const spec = MIRAGON_RENDERERS.find((s) => s.id === id);
  assert.ok(spec, id);
  const renderer = await spec.load();
  const canonical = renderer.create();
  canonical.attachTo(host(spec.canvasClassName));
  await canonical.importText(text);
  const docs = room(canonical.exportText()).slice(0, count);
  canonical.destroy();
  const engines = docs.map((doc) => {
    const canvasHost = host(spec.canvasClassName);
    const engine = mountMiragonEngine(spec, renderer, canvasHost, false);
    const conflicts: string[] = [];
    const unbind = engine.bindLive!(doc.getText("content"), doc, {
      onConflict: (message) => conflicts.push(message),
      onImportError: (message) => conflicts.push(`import failed: ${message}`),
    });
    return {
      diagram: engine.modeler.diagram as unknown as Diagram,
      canvasHost,
      conflicts,
      destroy: () => {
        unbind();
        engine.destroy();
      },
    };
  });
  await wait(100);
  return { docs, engines };
}

/** what reaches the page: thrown errors, and every Escape sent to the document */
function watchPage() {
  const seen = { errors: [] as unknown[], escapes: 0 };
  const onError = (event: ErrorEvent): void => void seen.errors.push(event.error);
  const onKeyup = (event: KeyboardEvent): void => void (event.key === "Escape" && seen.escapes++);
  window.addEventListener("error", onError);
  document.addEventListener("keyup", onKeyup, true);
  return {
    seen,
    stop: () => {
      window.removeEventListener("error", onError);
      document.removeEventListener("keyup", onKeyup, true);
    },
  };
}

test("an armed palette tool holds nothing back and is not cancelled: bpmn-js's hand tool, a Miragon renderer's lasso", async () => {
  const bpmn = room(await canonicalBpmn());
  const storm = await miragonEngines(
    "event-storming",
    "title Checkout\ncommand Place Order [240,300]\nevent Order Placed [620,300]\n",
    2,
  );
  const cases: Array<[what: string, engines: Engine[], arm: (diagram: Diagram) => void, moved: string]> = [
    [
      "bpmn-js hand tool",
      await bpmnEngines(bpmn),
      (d) => d.get("handTool").activateHand(pointerAt(), true),
      "Task_ship",
    ],
    [
      "Event Storming lasso",
      storm.engines,
      (d) => d.get("lassoTool").activateSelection(pointerAt(), true),
      "event_order_placed",
    ],
  ];
  for (const [what, engines, arm, moved] of cases) {
    const [local, peer] = engines as [Engine, Engine];
    const page = watchPage();
    arm(local.diagram);
    assert.ok(local.canvasHost.getElementsByClassName("djs-drag-active").length > 0, `${what}: the tool is armed`);
    assert.equal(local.canvasHost.getElementsByClassName("djs-dragger").length, 0, `${what}: and draws nothing`);
    const start = positionOf(local.diagram, moved);
    moveElement(peer.diagram, moved, MOVE_IN_WIDGET);
    await wait(QUIET);
    assert.ok(
      near(positionOf(local.diagram, moved), shifted(start, MOVE_IN_WIDGET)),
      `${what}: the peer's move is imported at once`,
    );
    assert.equal(page.seen.escapes, 0, `${what}: no Escape sent`);
    assert.deepEqual(page.seen.errors, [], `${what}: nothing thrown`);
    assert.deepEqual([local.conflicts, peer.conflicts], [[], []], what);
    if (what.startsWith("bpmn-js")) {
      assert.ok(local.diagram.get("dragging").context(), `${what}: the tool stays armed through the import`);
      assert.ok(local.canvasHost.getElementsByClassName("djs-drag-active").length > 0, what);
    }
    local.diagram.get("dragging").cancel();
    page.stop();
    for (const engine of engines) engine.destroy();
  }
});

test("a press on a Miragon canvas that starts no drag holds nothing back: the binding reads the renderer, not the DOM", async () => {
  const { engines } = await miragonEngines(
    "event-storming",
    "title Checkout\ncommand Place Order [240,300]\nevent Order Placed [620,300]\n",
    2,
  );
  const [local, peer] = engines as [Engine, Engine];
  const page = watchPage();
  local.canvasHost.querySelector("svg")!.dispatchEvent(pointer("pointerdown"));
  const start = positionOf(local.diagram, "event_order_placed");
  moveElement(peer.diagram, "event_order_placed", MOVE_IN_WIDGET);
  await wait(QUIET);
  assert.ok(
    near(positionOf(local.diagram, "event_order_placed"), shifted(start, MOVE_IN_WIDGET)),
    "the peer's move is imported while the pointer is down",
  );
  window.dispatchEvent(pointer("pointerup"));
  assert.deepEqual(page.seen.errors, [], "nothing thrown");
  assert.deepEqual([local.conflicts, peer.conflicts], [[], []]);
  page.stop();
  for (const engine of engines) engine.destroy();
});

/** where a modeler draws its elements, each shape's id and position, sorted: two canvases that show one text agree */
function layoutOf(diagram: Diagram): string[] {
  return diagram
    .get("elementRegistry")
    .filter((element) => element.type !== "label" && element.x !== undefined)
    .map((element) => `${element.id} ${element.x},${element.y}`)
    .sort();
}

/**
 * The peer moves Task_ship, whose DI is last, while the local pointer is
 * down; then the local edit, which bpmn-js writes into the text from its own
 * element down past the DI the peer moved. Different lines: both stay,
 * nobody is told. `localEdit` returns whether the shared text holds it.
 */
async function bpmnEditsMerge(what: string, localEdit: (diagram: Diagram) => (text: string) => boolean): Promise<void> {
  const docs = room(await canonicalBpmn());
  const [local, peer] = (await bpmnEngines(docs)) as [Engine, Engine];
  const page = watchPage();
  const ship = positionOf(local.diagram, "Task_ship");

  local.canvasHost.querySelector("svg")!.dispatchEvent(pointer("pointerdown"));
  moveElement(peer.diagram, "Task_ship", MOVE_IN_WIDGET);
  await wait(QUIET);
  assert.deepEqual(positionOf(local.diagram, "Task_ship"), ship, `${what}: held while the pointer is down`);
  window.dispatchEvent(pointer("pointerup"));
  const kept = localEdit(local.diagram);
  await wait(SETTLED);

  const text = docs[0].getText("content").toString();
  assert.equal(docs[1].getText("content").toString(), text, `${what}: the peers converge`);
  assert.deepEqual(boundsIn(text, "Task_ship"), shifted(ship, MOVE_IN_WIDGET), `${what}: the peer's move stays`);
  assert.ok(kept(text), `${what}: and so does the local edit`);
  assert.deepEqual(layoutOf(local.diagram), layoutOf(peer.diagram), `${what}: both canvases show the shared text`);
  assert.deepEqual([local.conflicts, peer.conflicts], [[], []], `${what}: nobody lost an edit`);
  assert.deepEqual(page.seen.errors, [], `${what}: nothing thrown`);
  page.stop();
  for (const engine of [local, peer]) engine.destroy();
}

test("bpmn-js: a drop or a create whose DI goes last, across the held move's DI, merges with it: no toast, no exception", async () => {
  // bpmn-js writes a moved shape's DI last
  await bpmnEditsMerge("move", (diagram) => {
    const start = positionOf(diagram, "Task_check");
    moveElement(diagram, "Task_check", MOVE_IN_SPA);
    return (text) => isDeepStrictEqual(boundsIn(text, "Task_check"), shifted(start, MOVE_IN_SPA));
  });
  // and a new task after the last one, its DI after the last DI
  await bpmnEditsMerge("create", (diagram) => {
    const root = diagram.get("canvas").getRootElement();
    diagram.get("modeling").createShape({ type: "bpmn:Task" }, { x: 400, y: 400 }, root);
    return (text) => text.match(/<bpmn:task /g)?.length === 3;
  });
});

test("bpmn-js: a drop that moves the task the held move moved gives way to it, with the conflict toast and no exception", async () => {
  const docs = room(await canonicalBpmn());
  const [local, peer] = (await bpmnEngines(docs)) as [Engine, Engine];
  const page = watchPage();
  const start = positionOf(local.diagram, "Task_check");

  local.canvasHost.querySelector("svg")!.dispatchEvent(pointer("pointerdown"));
  moveElement(peer.diagram, "Task_check", MOVE_IN_WIDGET);
  await wait(QUIET);
  window.dispatchEvent(pointer("pointerup"));
  // both moves delete Task_check's DI where it was and write it last: the same lines
  moveElement(local.diagram, "Task_check", MOVE_IN_SPA);
  await wait(SETTLED);

  const text = docs[0].getText("content").toString();
  assert.equal(docs[1].getText("content").toString(), text, "the peers converge");
  assert.deepEqual(boundsIn(text, "Task_check"), shifted(start, MOVE_IN_WIDGET), "the peer's move stays");
  assert.equal(text.match(/bpmnElement="Task_check"/g)?.length, 1, "one DI for the task, not one from each move");
  for (const engine of [local, peer]) {
    assert.deepEqual(positionOf(engine.diagram, "Task_check"), shifted(start, MOVE_IN_WIDGET), "each canvas shows it");
  }
  assert.equal(local.conflicts.length, 1, "the canvas whose drop gave way is told, once");
  assert.match(local.conflicts[0]!, /could not be merged/);
  assert.deepEqual(peer.conflicts, []);
  assert.deepEqual(page.seen.errors, [], "nothing thrown");
  page.stop();
  for (const engine of [local, peer]) engine.destroy();
});

test("dmn-js: a DRD create next to the held move of another decision merges with it: no toast, no exception", async () => {
  const { default: DmnModeler } = await import("dmn-js/lib/Modeler");
  const { mountDmnEditor } = await import("../src/notations/dmn-editor.ts");
  type Modeler = InstanceType<typeof DmnModeler>;
  // the SPA editor keeps its dmn-js instance to itself; its first import names it
  const modelers: Modeler[] = [];
  const importXML = DmnModeler.prototype.importXML;
  DmnModeler.prototype.importXML = function (this: Modeler, xml: string) {
    if (!modelers.includes(this)) modelers.push(this);
    return importXML.call(this, xml);
  };
  const drdOf = (modeler: Modeler | undefined): Diagram => modeler!.getActiveViewer() as unknown as Diagram;
  try {
    const xml = readFileSync(
      new URL("../../../process-documentation/processes/credit-limit-check.dmn", import.meta.url),
      "utf8",
    );
    const docs = room(xml);
    const conflicts: [string[], string[]] = [[], []];
    const hosts = [host("dmn-canvas"), host("dmn-canvas")] as const;
    const editors = [await mountDmnEditor(hosts[0], editorContext(docs[0], conflicts[0]))];
    await wait(300);
    const decision = drdOf(modelers[0])
      .get("elementRegistry")
      .filter((element) => element.type === "dmn:Decision")[0];
    assert.ok(decision, "a decision on the DRD");
    // the first edit of a file dmn-js did not write rewrites all of it: both canvases start from its export
    moveElement(drdOf(modelers[0]), decision.id, { x: 10, y: 0 });
    await wait(SETTLED);
    editors.push(await mountDmnEditor(hosts[1], editorContext(docs[1], conflicts[1])));
    await wait(300);
    const [local, peer] = [drdOf(modelers[0]), drdOf(modelers[1])];
    const page = watchPage();
    const start = positionOf(local, decision.id);

    hosts[0].dispatchEvent(pointer("pointerdown"));
    moveElement(peer, decision.id, MOVE_IN_WIDGET);
    await wait(QUIET);
    assert.deepEqual(positionOf(local, decision.id), start, "held while the pointer is down");
    window.dispatchEvent(pointer("pointerup"));
    // a new decision goes after the last one and its shape after the last shape, past the peer's moved bounds
    local
      .get("modeling")
      .createShape({ type: "dmn:Decision" }, { x: 600, y: 500 }, local.get("canvas").getRootElement());
    await wait(SETTLED);

    const text = docs[0].getText("content").toString();
    assert.equal(docs[1].getText("content").toString(), text, "the peers converge");
    const decisions = (dmn: string): number => dmn.match(/<decision /g)?.length ?? 0;
    assert.equal(decisions(text), decisions(xml) + 1, "the create stays");
    for (const diagram of [local, peer]) {
      assert.deepEqual(positionOf(diagram, decision.id), shifted(start, MOVE_IN_WIDGET), "the peer's move stays");
    }
    assert.deepEqual(layoutOf(local), layoutOf(peer), "both canvases show the shared text");
    assert.deepEqual(conflicts, [[], []], "nobody lost an edit");
    assert.deepEqual(page.seen.errors, [], "nothing thrown");
    page.stop();
    for (const editor of editors) editor.destroy();
  } finally {
    DmnModeler.prototype.importXML = importXML;
  }
});
