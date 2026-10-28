/**
 * The merge safety net (#274, live-client's sync rule 4) with the real
 * modelers apps/web mounts, under jsdom (test/renderer-dom.ts): two peers on
 * two Y.Docs whose drops cross on the wire, one in the SPA editor and one in
 * the live widget's engine. One bpmn-js move rewrites order-to-cash.bpmn from
 * line 11 to line 176 (lane refs and DI are reordered on export); the first
 * edit of a hand-written Context Maps, Team Topologies, Value Chain, Wardley
 * or Event Storming file rewrites all of it. Each merge is a text no canvas imports,
 * or one the Wardley and Event Storming parsers read garbled (every element
 * twice). Afterwards both peers hold exactly one peer's export, both canvases
 * show it, and the peer whose edit is lost has been told, through the SPA's
 * sync-error toast or the widget's conflict hook.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import * as Y from "yjs";

import type { EditorContext } from "../src/notations/registry.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

// bpmn-js asks a 2D canvas for nothing it needs here; jsdom has none and logs each call
(HTMLCanvasElement.prototype as unknown as { getContext(): null }).getContext = () => null;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** the local edit's quiet period, the import's debounce, the repair's settle delay and the peer's re-import */
const SETTLED = 3000;

const RELAYED = Symbol("relayed");

/** the Live Host's fan-out between Y.Docs, holding every update until release() */
function relay() {
  const docs: Y.Doc[] = [];
  const held: Array<{ to: Y.Doc; update: Uint8Array }> = [];
  let holding = false;
  const flush = (): void => {
    for (const { to, update } of held.splice(0)) Y.applyUpdate(to, update, RELAYED);
  };
  return {
    join(doc: Y.Doc): void {
      docs.push(doc);
      doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === RELAYED) return;
        for (const to of docs) if (to !== doc) held.push({ to, update });
        if (!holding) flush();
      });
    },
    hold(): void {
      holding = true;
    },
    flush,
    release(): void {
      holding = false;
      flush();
    },
  };
}

function room(text: string, clientIds: readonly number[]) {
  const seed = new Y.Doc();
  seed.getText("content").insert(0, text);
  const state = Y.encodeStateAsUpdate(seed);
  const net = relay();
  const docs = clientIds.map((clientId) => {
    const doc = new Y.Doc();
    doc.clientID = clientId;
    Y.applyUpdate(doc, state, RELAYED);
    net.join(doc);
    return doc;
  });
  return { net, docs };
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

interface Modeling {
  get(name: "elementRegistry"): { get(id: string): unknown };
  get(name: "modeling"): { moveElements(elements: unknown[], delta: { x: number; y: number }): void };
}

const moveElement = (diagram: Modeling, id: string, delta: { x: number; y: number }): void => {
  const element = diagram.get("elementRegistry").get(id);
  assert.ok(element, id);
  diagram.get("modeling").moveElements([element], delta);
};

const wellFormed = (xml: string): boolean =>
  new DOMParser().parseFromString(xml, "application/xml").getElementsByTagName("parsererror").length === 0;

test("bpmn-js: two moves of order-to-cash.bpmn dropped at once (#274) are repaired into one peer's export, SPA and widget alike", async () => {
  const { default: BpmnModeler } = await import("bpmn-js/lib/Modeler.js");
  const { mountBpmnEditor } = await import("../src/notations/bpmn-editor.ts");
  const { mountBpmnEngine } = await import("../src/mcp-app/engines/bpmn.ts");
  // the SPA editor keeps its bpmn-js instance to itself; its first import names it
  const spaModelers: Modeling[] = [];
  const importXML = BpmnModeler.prototype.importXML;
  BpmnModeler.prototype.importXML = function (this: Modeling, ...args: Parameters<typeof importXML>) {
    if (!spaModelers.includes(this)) spaModelers.push(this);
    return importXML.apply(this, args);
  };

  const xml = readFileSync(
    new URL("../../../process-documentation/processes/order-to-cash.bpmn", import.meta.url),
    "utf8",
  );
  const { net, docs } = room(xml, [200, 100]);
  const [spaDoc, widgetDoc] = docs as [Y.Doc, Y.Doc];
  const spaConflicts: string[] = [];
  const editor = await mountBpmnEditor(host("bpmn-canvas"), editorContext(spaDoc, spaConflicts));
  const widgetConflicts: string[] = [];
  const engine = mountBpmnEngine(host("bpmn-canvas"), false, {
    insets: () => ({ top: 56, right: 0, bottom: 0, left: 0 }),
  });
  const unbind = engine.bindLive!(widgetDoc.getText("content"), widgetDoc, {
    onConflict: (message) => widgetConflicts.push(message),
    onImportError: (message) => widgetConflicts.push(`import failed: ${message}`),
  });
  await wait(300);
  BpmnModeler.prototype.importXML = importXML;
  const spa = spaModelers.find((modeler) => modeler !== (engine.raw as unknown as Modeling));
  assert.ok(spa, "the SPA editor's bpmn-js");

  net.hold();
  moveElement(spa, "Task_check_credit", { x: 50, y: 40 });
  moveElement(engine.raw as unknown as Modeling, "Task_handle_inquiry", { x: 45, y: -30 });
  await wait(200);
  const own = [spaDoc, widgetDoc].map((doc) => doc.getText("content").toString());
  net.flush();
  const merged = spaDoc.getText("content").toString();
  assert.equal(widgetDoc.getText("content").toString(), merged);
  assert.ok(!wellFormed(merged), "the precondition of #274: the merge is malformed XML");
  net.release();
  await wait(SETTLED);

  const text = spaDoc.getText("content").toString();
  assert.equal(widgetDoc.getText("content").toString(), text, "the peers converge");
  assert.ok(wellFormed(text), "a fresh session can render the room");
  assert.equal(text, own[1], "the widget's peer has the lower client id: its export, exactly");
  // bpmn-js orders the DI of a re-imported move its own way on export, so
  // the canvases are compared by where they draw the two tasks
  const bounds = (diagram: Modeling) =>
    ["Task_check_credit", "Task_handle_inquiry"].map((id) => {
      const { x, y } = diagram.get("elementRegistry").get(id) as { x: number; y: number };
      return { x, y };
    });
  const boundsIn = (source: string) =>
    ["Task_check_credit", "Task_handle_inquiry"].map((id) => {
      const match = new RegExp(`bpmnElement="${id}">\\s*<dc:Bounds x="(-?[\\d.]+)" y="(-?[\\d.]+)"`).exec(source);
      assert.ok(match, id);
      return { x: Number(match[1]), y: Number(match[2]) };
    });
  const [credit, inquiry] = boundsIn(xml) as [{ x: number; y: number }, { x: number; y: number }];
  const inText = boundsIn(text);
  assert.deepEqual(inText, [credit, { x: inquiry.x + 45, y: inquiry.y - 30 }], "the widget's move, not the SPA's");
  assert.deepEqual(bounds(spa), inText, "the SPA canvas shows the shared text");
  assert.deepEqual(bounds(engine.raw as unknown as Modeling), inText, "the widget canvas shows it");
  assert.equal(spaConflicts.length, 1, "the SPA peer's move is lost, and its toast says so");
  assert.deepEqual(widgetConflicts, [], "the repairing widget keeps its move");
  unbind();
  engine.destroy();
  editor.destroy();
});

test("the JSON notations: both peers' first edits of a hand-written file at once are repaired into one peer's export", async () => {
  const { MIRAGON_RENDERERS } = await import("../src/notations/miragon/index.ts");
  const { mountMiragonEditor } = await import("../src/notations/miragon/editor.ts");
  const { mountMiragonEngine } = await import("../src/mcp-app/engines/miragon.ts");
  type Element = { id: string; position?: { x: number; y: number }; bounds?: { x: number; y: number } };
  const files: Array<[id: string, text: string, moved: [string, string]]> = [
    [
      "context-map",
      // hand-written: one line, keys in the writer's own order
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
  for (const [id, text, moved] of files) {
    const spec = MIRAGON_RENDERERS.find((s) => s.id === id);
    assert.ok(spec, id);
    const renderer = await spec.load();
    const { net, docs } = room(text, [100, 200]);
    const [spaDoc, widgetDoc] = docs as [Y.Doc, Y.Doc];
    const spaConflicts: string[] = [];
    let spa: ReturnType<typeof renderer.create> | undefined;
    const editor = mountMiragonEditor(
      spec,
      { ...renderer, create: (options) => (spa = renderer.create(options)) },
      host(spec.canvasClassName),
      editorContext(spaDoc, spaConflicts),
    );
    const widgetConflicts: string[] = [];
    const engine = mountMiragonEngine(spec, renderer, host(spec.canvasClassName), false, {
      insets: () => ({ top: 56, right: 0, bottom: 0, left: 0 }),
    });
    const unbind = engine.bindLive!(widgetDoc.getText("content"), widgetDoc, {
      onConflict: (message) => widgetConflicts.push(message),
      onImportError: (message) => widgetConflicts.push(`import failed: ${message}`),
    });
    await wait(100);
    assert.ok(spa, id);

    net.hold();
    moveElement(spa.diagram as unknown as Modeling, moved[0], { x: 10, y: 0 });
    moveElement(engine.modeler.diagram as unknown as Modeling, moved[1], { x: 0, y: 20 });
    await wait(50);
    const [spaOwn, widgetOwn] = [spaDoc, widgetDoc].map((doc) => doc.getText("content").toString()) as [string, string];
    net.flush();
    assert.throws(() => JSON.parse(spaDoc.getText("content").toString()), `${id}: the merge is no JSON`);
    net.release();
    await wait(SETTLED);

    const shared = spaDoc.getText("content").toString();
    assert.equal(widgetDoc.getText("content").toString(), shared, `${id}: the peers converge`);
    assert.notEqual(spaOwn, widgetOwn, id);
    assert.equal(shared, spaOwn, `${id}: the SPA's peer has the lower client id: its export, exactly`);
    assert.deepEqual([spa.exportText(), engine.modeler.exportText()], [shared, shared], `${id}: both canvases show it`);
    const positionOf = (json: string, elementId: string): unknown => {
      const document = JSON.parse(json) as { contexts?: Element[]; nodes?: Element[]; elements?: Element[] };
      const element = (document.contexts ?? document.nodes ?? document.elements)?.find((e) => e.id === elementId);
      return element?.position ?? element?.bounds;
    };
    assert.deepEqual(positionOf(shared, moved[0]), positionOf(spaOwn, moved[0]), `${id}: the SPA's move kept`);
    assert.deepEqual(spaConflicts, [], id);
    assert.equal(widgetConflicts.length, 1, `${id}: the widget's move is lost, and the widget is told`);
    unbind();
    engine.destroy();
    editor.destroy();
  }
});

test("Wardley and Event Storming: first edits of a hand-written file at once, whose merge the parsers read garbled, are repaired into one peer's export", async () => {
  const { MIRAGON_RENDERERS } = await import("../src/notations/miragon/index.ts");
  const { mountMiragonEditor } = await import("../src/notations/miragon/editor.ts");
  const { mountMiragonEngine } = await import("../src/mcp-app/engines/miragon.ts");
  const files: Array<[id: string, text: string, moved: [string, string]]> = [
    [
      "wardley",
      // hand-written: no space after the comma, none around the arrow
      "title Tea Shop\ncomponent Cup of Tea [0.79,0.61]\ncomponent Hot Water [0.82,0.78]\ncomponent Kettle [0.43,0.35]\nCup of Tea->Hot Water\nHot Water->Kettle\n",
      ["cmp_cup_of_tea", "cmp_kettle"],
    ],
    [
      "event-storming",
      "title Checkout\ncommand Place Order [240,300]\nevent Order Placed [620,300]\nevent Order Shipped [900,300]\nPlace Order -> Order Placed\n",
      ["cmd_place_order", "event_order_shipped"],
    ],
  ];
  for (const [id, text, moved] of files) {
    const spec = MIRAGON_RENDERERS.find((s) => s.id === id);
    assert.ok(spec, id);
    const renderer = await spec.load();
    const { net, docs } = room(text, [100, 200]);
    const [spaDoc, widgetDoc] = docs as [Y.Doc, Y.Doc];
    const spaConflicts: string[] = [];
    let spa: ReturnType<typeof renderer.create> | undefined;
    const editor = mountMiragonEditor(
      spec,
      { ...renderer, create: (options) => (spa = renderer.create(options)) },
      host(spec.canvasClassName),
      editorContext(spaDoc, spaConflicts),
    );
    const widgetConflicts: string[] = [];
    const engine = mountMiragonEngine(spec, renderer, host(spec.canvasClassName), false, {
      insets: () => ({ top: 56, right: 0, bottom: 0, left: 0 }),
    });
    const unbind = engine.bindLive!(widgetDoc.getText("content"), widgetDoc, {
      onConflict: (message) => widgetConflicts.push(message),
      onImportError: (message) => widgetConflicts.push(`import failed: ${message}`),
    });
    await wait(100);
    assert.ok(spa, id);

    net.hold();
    moveElement(spa.diagram as unknown as Modeling, moved[0], { x: 30, y: 0 });
    moveElement(engine.modeler.diagram as unknown as Modeling, moved[1], { x: 0, y: 40 });
    await wait(50);
    const [spaOwn, widgetOwn] = [spaDoc, widgetDoc].map((doc) => doc.getText("content").toString()) as [string, string];
    net.flush();
    const merged = spaDoc.getText("content").toString();
    const reader = renderer.create();
    reader.attachTo(host(spec.canvasClassName));
    await assert.doesNotReject(reader.importText(merged), `${id}: the parser reads the merge`);
    assert.notEqual(reader.exportText(), spaOwn, `${id}: as neither peer's model`);
    assert.notEqual(reader.exportText(), widgetOwn, id);
    reader.destroy();
    net.release();
    await wait(SETTLED);

    const shared = spaDoc.getText("content").toString();
    assert.equal(widgetDoc.getText("content").toString(), shared, `${id}: the peers converge`);
    assert.equal(shared, spaOwn, `${id}: the SPA's peer has the lower client id: its export, exactly`);
    assert.deepEqual([spa.exportText(), engine.modeler.exportText()], [shared, shared], `${id}: both canvases show it`);
    assert.deepEqual(spaConflicts, [], id);
    assert.equal(widgetConflicts.length, 1, `${id}: the widget's move is lost, and the widget is told`);
    unbind();
    engine.destroy();
    editor.destroy();
  }
});
