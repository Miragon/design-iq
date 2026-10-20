/**
 * The Miragon renderers apps/web pins, for real (under jsdom, test/renderer-dom.ts),
 * through the very specs, widget engine and SPA editor the app mounts them
 * with. The other suites drive fakes that model a renderer's traits; these
 * cases pin the traits themselves, so a renderer bump that changes one fails
 * here instead of in a browser.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { newCmJson, newOwmText, newStormText, newTtJson } from "@designiq/notations/templates";
import * as Y from "yjs";

import { mountMiragonEngine } from "../src/mcp-app/engines/miragon.ts";
import { MIRAGON_RENDERERS } from "../src/notations/miragon/index.ts";
import type { LoadedMiragonRenderer } from "../src/notations/miragon/spec.ts";
import type { EditorContext } from "../src/notations/registry.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function load(id: string): Promise<LoadedMiragonRenderer> {
  const spec = MIRAGON_RENDERERS.find((s) => s.id === id);
  assert.ok(spec, id);
  return spec.load();
}

interface WardleyModeler {
  setMapSize(width: number, height: number, options?: { transient?: boolean }): void;
  exportDSL(): string;
}

const MAP =
  "title Tea Shop\ncomponent Cup of Tea [0.79, 0.61]\ncomponent Hot Water [0.82, 0.45]\nCup of Tea->Hot Water\n";
const BOARD = "title Checkout\ncommand Place Order [240, 300]\nevent Order Placed [620, 300]\n";
const CONTEXT_MAP = JSON.stringify({
  version: 1,
  title: "Conference",
  contexts: [
    { id: "ctx_cfp", label: "CfP", position: { x: 40, y: 40 }, size: { width: 200, height: 110 } },
    { id: "ctx_agenda", label: "Agenda", position: { x: 400, y: 40 }, size: { width: 200, height: 110 } },
  ],
  relationships: [],
});
/** hand-written, not the canonical serialization (one line, unsorted ids) */
const TEAMS = JSON.stringify({
  version: 3,
  title: "Online Shop",
  nodes: [
    {
      id: "team_platform",
      type: "platform",
      label: "Platform",
      position: { x: 40, y: 300 },
      size: { width: 520, height: 96 },
    },
    {
      id: "team_checkout",
      type: "stream-aligned",
      label: "Checkout",
      position: { x: 40, y: 40 },
      size: { width: 240, height: 96 },
    },
  ],
  interactions: [],
  flows: [],
});

test("the new-file templates are the renderers' own serialization: the first canvas save is no phantom diff", async () => {
  const templates: Array<[id: string, text: string]> = [
    ["wardley", newOwmText("map", "Platform Map")],
    ["event-storming", newStormText("board", "Order Checkout")],
    ["context-map", newCmJson("map", "Conference Planner")],
    ["team-topology", newTtJson("teams", "Team Landscape")],
  ];
  for (const [id, text] of templates) {
    const engine = mountMiragonEngine(await load(id), host(), false);
    await engine.importText(text);
    assert.equal(await engine.exportText(), text, id);
    engine.destroy();
  }
});

test("importing never dirties the widget (engine invariant 1), the renderer's own import echo included", async () => {
  const boards: Array<[id: string, text: string]> = [
    ["wardley", MAP],
    ["event-storming", BOARD],
    ["context-map", newCmJson("map", "Conference Planner")],
    ["team-topology", TEAMS],
  ];
  for (const [id, text] of boards) {
    const engine = mountMiragonEngine(await load(id), host(), false);
    let dirty = 0;
    engine.onDirty(() => dirty++);
    await engine.importText(text);
    await engine.importText(text);
    assert.equal(dirty, 0, id);
    engine.destroy();
  }
});

test("the read-only viewers import without a command stack: no renderer needs a shim", async () => {
  const boards: Array<[id: string, text: string]> = [
    ["wardley", MAP],
    ["event-storming", BOARD],
    ["context-map", CONTEXT_MAP],
    ["team-topology", TEAMS],
  ];
  for (const [id, text] of boards) {
    const engine = mountMiragonEngine(await load(id), host(), true);
    assert.throws(() => engine.raw.get("commandStack"), /No provider for "commandStack"/, id);
    await engine.importText(text);
    await engine.importText(text);
    engine.destroy();
  }
});

interface DiagramServices {
  get(name: "elementRegistry"): {
    filter(fn: (e: { id: string; parent?: unknown; labelTarget?: unknown }) => boolean): Array<{ id: string }>;
  };
  get(name: "selection"): { select(element: unknown): void };
}

test("Delete acts on the selection once the canvas has the focus, not while a chrome button has it", async () => {
  const boards: Array<[id: string, text: string]> = [
    ["wardley", MAP],
    ["event-storming", BOARD],
    ["context-map", CONTEXT_MAP],
    ["team-topology", TEAMS],
  ];
  for (const [id, text] of boards) {
    const widget = host();
    const button = widget.ownerDocument.createElement("button");
    widget.ownerDocument.body.append(button);
    const engine = mountMiragonEngine(await load(id), widget, false);
    await engine.importText(text);
    const diagram = engine.raw as unknown as DiagramServices;
    const shapes = () => diagram.get("elementRegistry").filter((e) => e.parent !== undefined && !e.labelTarget);
    const before = shapes().length;
    diagram.get("selection").select(shapes()[0]);
    const pressDelete = (): void =>
      void widget.ownerDocument.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
      );

    button.focus();
    pressDelete();
    assert.equal(shapes().length, before, `${id}: a chrome button keeps the key`);
    engine.view.focus?.();
    assert.equal(widget.ownerDocument.activeElement, widget.querySelector(".djs-container > svg"), id);
    pressDelete();
    assert.ok(shapes().length < before, `${id}: the canvas takes it`);
    engine.destroy();
    button.remove();
  }
});

/** what a drag of the plot corner does on every snapped step */
function dragPlotCorner(modeler: WardleyModeler): void {
  for (const [width, height] of [
    [900, 700],
    [1200, 800],
    [1500, 900],
  ] as const) {
    modeler.setMapSize(width, height, { transient: true });
  }
}

test("Wardley: a resize preview is no edit for the widget's autosave, the size it commits is", async () => {
  const engine = mountMiragonEngine(await load("wardley"), host("wardley-canvas"), false);
  await engine.importText(MAP);
  let dirty = 0;
  engine.onDirty(() => dirty++);
  const modeler = engine.raw as unknown as WardleyModeler;
  dragPlotCorner(modeler);
  assert.match(await engine.exportText(), /size \[1500, 900\]/, "the export already carries the preview");
  assert.equal(dirty, 0, "no autosave of a preview size");
  modeler.setMapSize(1500, 900);
  assert.ok(dirty > 0);
  engine.destroy();
});

test("Wardley: a resize preview never reaches the shared text, the size it commits does", async () => {
  const engine = mountMiragonEngine(await load("wardley"), host("wardley-canvas"), false);
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, MAP);
  const unbind = engine.bindLive!(ytext, doc, {
    onConflict: assert.fail,
    onImportError: assert.fail,
  });
  await wait(500);
  const opened = ytext.toString();
  const modeler = engine.raw as unknown as WardleyModeler;
  dragPlotCorner(modeler);
  await wait(50);
  assert.equal(ytext.toString(), opened, "no preview size for the peers");
  modeler.setMapSize(1500, 900);
  await wait(50);
  assert.match(ytext.toString(), /size \[1500, 900\]/);
  unbind();
  engine.destroy();
});

test("Team Topologies takes no key while its canvas is inert or a modal dialog is open, as the live editor's hidden layer and dialogs are", async () => {
  const layer = host();
  const canvasHost = layer.ownerDocument.createElement("div");
  canvasHost.className = "tt-canvas";
  layer.append(canvasHost);
  const engine = mountMiragonEngine(await load("team-topology"), canvasHost, false);
  await engine.importText(TEAMS);
  const diagram = engine.raw as unknown as DiagramServices;
  const shapes = () => diagram.get("elementRegistry").filter((e) => e.parent !== undefined && !e.labelTarget);
  const deleteOnThePage = (): number => {
    diagram.get("selection").select(shapes()[0]);
    layer.ownerDocument.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
    );
    return shapes().length;
  };
  const before = shapes().length;
  layer.setAttribute("inert", "");
  assert.equal(deleteOnThePage(), before, "an inert layer around the canvas");
  layer.removeAttribute("inert");
  const dialog = layer.ownerDocument.createElement("div");
  dialog.setAttribute("aria-modal", "true");
  layer.ownerDocument.body.append(dialog);
  assert.equal(deleteOnThePage(), before, "a modal dialog");
  dialog.remove();
  assert.ok(deleteOnThePage() < before, "neither: the page's key is the canvas's");
  engine.destroy();
  layer.remove();
});

interface TeamTopologyModeler {
  get(name: "elementRegistry"): { get(id: string): unknown };
  get(name: "modeling"): { moveElements(shapes: unknown[], delta: { x: number; y: number }): void };
  get(name: "commandStack"): { canUndo(): boolean };
  get(name: "ttLabelEditing"): {
    activate(element: unknown): void;
    openEdit(): { elementId: string; value: string } | undefined;
  };
}

/** the open label editor's textarea, typed into as a user would */
function typeLabel(container: HTMLElement, value: string): HTMLTextAreaElement {
  const editor = container.querySelector<HTMLTextAreaElement>("textarea.tt-label-editor");
  assert.ok(editor, "the label editor is open");
  editor.value = value;
  // jsdom's own Event: node's global one is no event to jsdom's dispatchEvent
  editor.dispatchEvent(new editor.ownerDocument.defaultView!.Event("input", { bubbles: true }));
  return editor;
}

test("Team Topologies: a hand-written file opens untouched, an edit writes the canonical text, a re-import leaves no undo behind", async () => {
  const engine = mountMiragonEngine(await load("team-topology"), host("tt-canvas"), false);
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, TEAMS);
  const unbind = engine.bindLive!(ytext, doc, { onConflict: assert.fail, onImportError: assert.fail });
  await wait(500);
  assert.equal(ytext.toString(), TEAMS, "the import echoes nothing into the shared text");

  const modeler = engine.raw as unknown as TeamTopologyModeler;
  const checkout = modeler.get("elementRegistry").get("team_checkout");
  modeler.get("modeling").moveElements([checkout], { x: 10, y: 0 });
  await wait(50);
  assert.match(
    ytext.toString(),
    /^\{\n {2}"version": 3,[\s\S]*"x": 50,[\s\S]*\}\n$/,
    "the edit, canonical with its line break",
  );
  assert.ok(modeler.get("commandStack").canUndo());

  await wait(700); // past the live binding's quiet period after a local edit
  const remote = ytext.toString().replace('"label": "Platform"', '"label": "Cloud Platform"');
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, remote);
  });
  await wait(500);
  assert.equal(ytext.toString(), remote, "the re-import echoes nothing either");
  assert.equal(modeler.get("commandStack").canUndo(), false, "no undo step points at the replaced shapes");
  unbind();
  engine.destroy();
});

test("Team Topologies: typing a label is no edit until it commits, and a peer's re-import keeps what was typed", async () => {
  const widget = host("tt-canvas");
  const engine = mountMiragonEngine(await load("team-topology"), widget, false);
  await engine.importText(TEAMS);
  let dirty = 0;
  engine.onDirty(() => dirty++);
  const modeler = engine.raw as unknown as TeamTopologyModeler;
  const labels = modeler.get("ttLabelEditing");
  labels.activate(modeler.get("elementRegistry").get("team_checkout"));
  typeLabel(widget, "Checkout & Pay");
  assert.equal(dirty, 0, "the open editor is a preview");
  assert.doesNotMatch(await engine.exportText(), /Checkout & Pay/);

  await engine.importText(TEAMS.replace('"label":"Platform"', '"label":"Cloud Platform"'));
  await wait(10);
  assert.deepEqual(labels.openEdit(), { elementId: "team_checkout", value: "Checkout & Pay" });
  assert.equal(dirty, 0);

  const editor = typeLabel(widget, "Checkout & Payments");
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert.equal(dirty, 1, "the commit is one edit");
  const saved = await engine.exportText();
  assert.match(saved, /"label": "Checkout & Payments"/);
  assert.match(saved, /"label": "Cloud Platform"/, "the peer's change stays");
  engine.destroy();
});

test("Context Maps: every mount shows the legend card, which the 0.3.0 Modeler leaves to its host", async () => {
  const renderer = await load("context-map");
  const text = newCmJson("map", "Conference Planner");

  const bareHost = host("cm-canvas");
  const bare = new renderer.Modeler({ container: bareHost });
  bare.get("canvas");
  assert.equal(bareHost.querySelector(".cm-legend"), null, "the renderer alone draws none");
  bare.destroy();

  const { mountMiragonEditor } = await import("../src/notations/miragon/editor.ts");
  const spa = host("cm-canvas");
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  const editor = mountMiragonEditor(renderer, spa, {
    ytext: doc.getText("content"),
    doc,
    onSyncError: assert.fail,
    onImportFailed: assert.fail,
  } as unknown as EditorContext);
  await wait(50);
  assert.ok(spa.querySelector(".cm-legend"), "the SPA editor");
  editor.destroy();

  for (const readonly of [false, true]) {
    const widget = host("cm-canvas");
    const engine = mountMiragonEngine(renderer, widget, readonly);
    await engine.importText(text);
    assert.ok(widget.querySelector(".cm-legend"), readonly ? "the widget viewer" : "the widget editor");
    engine.destroy();
  }
});
