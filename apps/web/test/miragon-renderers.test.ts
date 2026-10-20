/**
 * The Miragon renderers apps/web pins, for real (under jsdom, test/renderer-dom.ts),
 * through the very specs, widget engine and SPA editor the app mounts them
 * with — their @miragon/modeler-api factories. The other suites drive a fake
 * that keeps the contract's laws; these cases pin that the renderers keep
 * them the way designIQ relies on, so a renderer bump that breaks one fails
 * here instead of in a browser.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { newCmJson, newOwmText, newStormText, newTtJson } from "@designiq/notations/templates";
import * as Y from "yjs";

import type { PresenceSurface, RemotePresence } from "../src/lib/presence-canvas.ts";
import { mountMiragonEngine } from "../src/mcp-app/engines/miragon.ts";
import { MIRAGON_RENDERERS } from "../src/notations/miragon/index.ts";
import type { LoadedMiragonRenderer, MiragonModeler, MiragonRendererSpec } from "../src/notations/miragon/spec.ts";
import type { EditorContext } from "../src/notations/registry.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function specOf(id: string): MiragonRendererSpec {
  const spec = MIRAGON_RENDERERS.find((s) => s.id === id);
  assert.ok(spec, id);
  return spec;
}

/** the spec and its loaded factories, as both hosts mount them */
async function load(id: string): Promise<[MiragonRendererSpec, LoadedMiragonRenderer]> {
  const spec = specOf(id);
  return [spec, await spec.load()];
}

/** the widget engine of a notation, mounted the way the widget does it */
async function engineOf(id: string, container: HTMLElement, readonly = false) {
  const [spec, renderer] = await load(id);
  return mountMiragonEngine(spec, renderer, container, readonly);
}

const HOSTS = ["the SPA editor", "the live widget"] as const;

/**
 * A notation's editing mount bound to a shared Y.Text the way a host does
 * it: the SPA's editor, or the widget's engine with the chrome's insets (so
 * the widget fits the view itself after every import).
 */
async function mountLive(
  where: (typeof HOSTS)[number],
  id: string,
  ytext: Y.Text,
  doc: Y.Doc,
  presence?: PresenceSurface,
): Promise<{ container: HTMLElement; modeler: MiragonModeler; destroy(): void }> {
  const [spec, renderer] = await load(id);
  const container = host(spec.canvasClassName);
  if (where === "the live widget") {
    const engine = mountMiragonEngine(spec, renderer, container, false, {
      insets: () => ({ top: 56, right: 0, bottom: 0, left: 0 }),
    });
    const unbind = engine.bindLive!(ytext, doc, { onConflict: assert.fail, onImportError: assert.fail, presence });
    return {
      container,
      modeler: engine.modeler,
      destroy: () => {
        unbind();
        engine.destroy();
      },
    };
  }
  const { mountMiragonEditor } = await import("../src/notations/miragon/editor.ts");
  let modeler: MiragonModeler | undefined;
  const editor = mountMiragonEditor(
    spec,
    { ...renderer, create: (options) => (modeler = renderer.create(options)) },
    container,
    { ytext, doc, onSyncError: assert.fail, onImportFailed: assert.fail, presence } as unknown as EditorContext,
  );
  assert.ok(modeler, id);
  return { container, modeler, destroy: () => editor.destroy() };
}

interface DiagramServices {
  get(name: "elementRegistry"): {
    get(id: string): unknown;
    filter(fn: (e: { id: string; parent?: unknown; labelTarget?: unknown }) => boolean): Array<{ id: string }>;
  };
  get(name: "selection"): { select(element: unknown): void };
  get(name: "modeling"): { removeElements(elements: unknown[]): void };
  get(name: "commandStack"): { canUndo(): boolean; undo(): void };
}

interface WardleyModeler {
  setMapSize(width: number, height: number, options?: { transient?: boolean }): void;
}

interface WardleyServices {
  get(name: "elementRegistry"): { get(id: string): { x: number; y: number } | undefined };
  get(name: "selection"): { select(element: unknown): void };
  get(name: "wardleyModeling"): { updateLabel(element: unknown, label: string): void };
  get(name: "canvas"): { getLayer(name: string): SVGElement };
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

/** one hand-written document per notation, and a second one a peer turns it into */
const DOCUMENTS: Array<[id: string, text: string, peer: string]> = [
  ["wardley", MAP, MAP.replace("[0.82, 0.45]", "[0.82, 0.55]")],
  ["event-storming", BOARD, BOARD.replace("[620, 300]", "[640, 300]")],
  ["context-map", CONTEXT_MAP, CONTEXT_MAP.replace('"label":"Agenda"', '"label":"Agenda Builder"')],
  ["team-topology", TEAMS, TEAMS.replace('"label":"Platform"', '"label":"Cloud Platform"')],
];

/** the shapes a user can select and delete (no root, no external label) */
const shapesOf = (diagram: DiagramServices) =>
  diagram.get("elementRegistry").filter((e) => e.parent !== undefined && !e.labelTarget);

test("each spec's factories are its renderer's: meta.notation is the spec's contractNotation, editor and viewer", async () => {
  for (const spec of MIRAGON_RENDERERS) {
    const renderer = await spec.load();
    const editor = renderer.create();
    const viewer = renderer.createViewer();
    assert.equal(editor.meta.notation, spec.contractNotation, spec.id);
    assert.deepEqual([editor.meta.editable, viewer.meta.editable], [true, false], spec.id);
    editor.destroy();
    viewer.destroy();
  }
});

test("the renderer's root mounts INSIDE the host, which keeps the scope class; destroy removes only that root", async () => {
  for (const spec of MIRAGON_RENDERERS) {
    const widget = host(spec.canvasClassName);
    const engine = await engineOf(spec.id, widget);
    const root = widget.firstElementChild!;
    assert.equal(widget.children.length, 1, spec.id);
    // the descendant prefix of the SPA's vendor-CSS scoping (notations/miragon/vendor-css.ts)
    assert.ok(root.matches(`.${spec.canvasClassName} > *`), spec.id);
    assert.ok(!root.classList.contains(spec.canvasClassName), `${spec.id}: the scope class stays on the host`);
    assert.ok(root.querySelector(".djs-container"), spec.id);
    engine.destroy();
    assert.equal(widget.children.length, 0, `${spec.id}: its root is gone`);
    assert.ok(widget.isConnected, `${spec.id}: the host is the host's to remove`);
    widget.remove();
  }
});

test("the new-file templates are the renderers' own serialization: the first canvas save is no phantom diff", async () => {
  const templates: Array<[id: string, text: string]> = [
    ["wardley", newOwmText("map", "Platform Map")],
    ["event-storming", newStormText("board", "Order Checkout")],
    ["context-map", newCmJson("map", "Conference Planner")],
    ["team-topology", newTtJson("teams", "Team Landscape")],
  ];
  for (const [id, text] of templates) {
    const engine = await engineOf(id, host());
    await engine.importText(text);
    assert.equal(await engine.exportText(), text, id);
    engine.destroy();
  }
});

test("L1: importing never dirties the widget, over an edit's undo history too, and leaves no undo step", async () => {
  for (const [id, text, peer] of DOCUMENTS) {
    const engine = await engineOf(id, host());
    let dirty = 0;
    engine.onDirty(() => dirty++);
    await engine.importText(text);
    await engine.importText(text);
    assert.equal(dirty, 0, id);
    const diagram = engine.modeler.diagram as unknown as DiagramServices;
    diagram.get("modeling").removeElements([shapesOf(diagram)[0]]);
    assert.equal(dirty, 1, `${id}: the edit is`);
    assert.ok(diagram.get("commandStack").canUndo(), id);
    await engine.importText(peer);
    assert.equal(dirty, 1, `${id}: the re-import over its history is not`);
    assert.equal(diagram.get("commandStack").canUndo(), false, `${id}: L4, no undo step points at replaced shapes`);
    engine.destroy();
  }
});

test("L4: an undo right after a peer's re-import changes neither the canvas nor the shared text", async () => {
  for (const [id, text, peer] of DOCUMENTS) {
    const engine = await engineOf(id, host());
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, text);
    const unbind = engine.bindLive!(ytext, doc, { onConflict: assert.fail, onImportError: assert.fail });
    await wait(50);
    const diagram = engine.modeler.diagram as unknown as DiagramServices;
    diagram.get("modeling").removeElements([shapesOf(diagram)[0]]);
    await wait(650); // past the live binding's quiet period after a local edit
    assert.equal(ytext.toString(), await engine.exportText(), `${id}: the edit is shared`);
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, peer);
    });
    await wait(450);
    const imported = await engine.exportText();
    diagram.get("commandStack").undo();
    await wait(50);
    assert.equal(await engine.exportText(), imported, `${id}: the canvas`);
    assert.equal(ytext.toString(), peer, `${id}: the shared text`);
    unbind();
    engine.destroy();
  }
});

/** a document each JSON renderer refuses, with the reason it gives — the
 *  line DSLs refuse nothing: they keep every line they do not understand */
const REFUSED: Array<[id: string, good: string, refused: string, reason: RegExp]> = [
  [
    "context-map",
    CONTEXT_MAP,
    withId(CONTEXT_MAP, "contexts", 0, "cm-root"),
    /^contexts\.0\.id: the id "cm-root" is reserved/,
  ],
  ["team-topology", TEAMS, withId(TEAMS, "nodes", 1, "team_platform"), /^nodes\.1\.id: duplicate id "team_platform"/],
  ["context-map", CONTEXT_MAP, CONTEXT_MAP.slice(0, 40), /^\(root\): not valid JSON/],
  ["team-topology", TEAMS, TEAMS.slice(0, 40), /JSON/],
];

/** the document with one element's id replaced */
function withId(json: string, list: "nodes" | "contexts", index: number, id: string): string {
  const document = JSON.parse(json) as Record<string, Array<{ id: string }>>;
  document[list]![index]!.id = id;
  return JSON.stringify(document);
}

test("L7: a refused document leaves no trace — the canvas, its export, its undo history, no change event", async () => {
  for (const [id, good, refused, reason] of REFUSED) {
    const engine = await engineOf(id, host());
    await engine.importText(good);
    const diagram = engine.modeler.diagram as unknown as DiagramServices;
    diagram.get("modeling").removeElements([shapesOf(diagram)[0]]);
    const before = await engine.exportText();
    const shapes = shapesOf(diagram).length;
    let dirty = 0;
    engine.onDirty(() => dirty++);
    await assert.rejects(() => engine.importText(refused), { message: reason }, id);
    assert.equal(await engine.exportText(), before, id);
    assert.equal(shapesOf(diagram).length, shapes, `${id}: still rendered`);
    assert.ok(diagram.get("commandStack").canUndo(), `${id}: the history is untouched`);
    assert.equal(dirty, 0, id);
    await engine.importText(good);
    assert.equal(shapesOf(diagram).length, shapes + 1, `${id}: and the next valid text renders`);
    engine.destroy();
  }
});

test("the SPA editor names the reason a renderer refuses a document, word for word", async () => {
  const { mountMiragonEditor } = await import("../src/notations/miragon/editor.ts");
  for (const [id, , refused, reason] of REFUSED) {
    const [spec, renderer] = await load(id);
    const doc = new Y.Doc();
    doc.getText("content").insert(0, refused);
    const failed: string[] = [];
    const editor = mountMiragonEditor(spec, renderer, host(), {
      ytext: doc.getText("content"),
      doc,
      onSyncError: assert.fail,
      onImportFailed: (message: string) => failed.push(message),
    } as unknown as EditorContext);
    await wait(50);
    assert.equal(failed.length, 1, id);
    assert.match(failed[0]!, reason, id);
    editor.destroy();
  }
});

test("L5: a peer's re-import keeps the view the user panned to; the first import keeps the renderer's own fit", async () => {
  for (const [id, text, peer] of DOCUMENTS) {
    const bare = await engineOf(id, host());
    await bare.modeler.importText(text);
    const ownFit = bare.modeler.getViewState();
    bare.destroy();

    const engine = await engineOf(id, host());
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, text);
    const unbind = engine.bindLive!(ytext, doc, { onConflict: assert.fail, onImportError: assert.fail });
    await wait(50);
    const fitted = engine.modeler.getViewState() as { x: number; y: number; width: number; height: number };
    assert.ok(fitted && fitted.width > 0, `${id}: a view to keep`);
    assert.deepEqual(fitted, ownFit, `${id}: the binding puts no view of its own over the first import`);
    const panned = { ...fitted, x: fitted.x + 123, y: fitted.y - 45 };
    engine.modeler.setViewState(panned);
    const readback = engine.modeler.getViewState();
    const before = await engine.exportText();
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, peer);
    });
    await wait(450);
    assert.notEqual(await engine.exportText(), before, `${id}: re-imported`);
    assert.deepEqual(engine.modeler.getViewState(), readback, `${id}: the view does not jump`);
    unbind();
    engine.destroy();
  }
});

test("the read-only viewers import without a command stack: no renderer needs a shim", async () => {
  for (const [id, text] of DOCUMENTS) {
    const engine = await engineOf(id, host(), true);
    assert.equal(engine.modeler.meta.editable, false, id);
    assert.throws(
      () => (engine.modeler.diagram as unknown as DiagramServices).get("commandStack"),
      /No provider for "commandStack"/,
      id,
    );
    await engine.importText(text);
    await engine.importText(text);
    engine.destroy();
  }
});

test("Delete acts on the selection once the canvas has the focus, not while a chrome button has it", async () => {
  for (const [id, text] of DOCUMENTS) {
    const widget = host();
    const button = widget.ownerDocument.createElement("button");
    widget.ownerDocument.body.append(button);
    const engine = await engineOf(id, widget);
    await engine.importText(text);
    const diagram = engine.modeler.diagram as unknown as DiagramServices;
    const before = shapesOf(diagram).length;
    diagram.get("selection").select(shapesOf(diagram)[0]);
    const pressDelete = (): void =>
      void widget.ownerDocument.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
      );

    button.focus();
    pressDelete();
    assert.equal(shapesOf(diagram).length, before, `${id}: a chrome button keeps the key`);
    engine.view.focus?.();
    assert.equal(widget.ownerDocument.activeElement, widget.querySelector(".djs-container > svg"), id);
    pressDelete();
    assert.ok(shapesOf(diagram).length < before, `${id}: the canvas takes it`);
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
  const engine = await engineOf("wardley", host("wardley-canvas"));
  await engine.importText(MAP);
  let dirty = 0;
  engine.onDirty(() => dirty++);
  const modeler = engine.modeler.diagram as unknown as WardleyModeler;
  dragPlotCorner(modeler);
  assert.match(await engine.exportText(), /size \[1500, 900\]/, "the export already carries the preview");
  assert.equal(dirty, 0, "no autosave of a preview size");
  modeler.setMapSize(1500, 900);
  assert.ok(dirty > 0);
  engine.destroy();
});

test("Wardley: a resize preview never reaches the shared text, the size it commits does", async () => {
  const engine = await engineOf("wardley", host("wardley-canvas"));
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, MAP);
  const unbind = engine.bindLive!(ytext, doc, {
    onConflict: assert.fail,
    onImportError: assert.fail,
  });
  await wait(500);
  const opened = ytext.toString();
  assert.equal(opened, MAP, "opening writes nothing");
  const modeler = engine.modeler.diagram as unknown as WardleyModeler;
  dragPlotCorner(modeler);
  await wait(50);
  assert.equal(ytext.toString(), opened, "no preview size for the peers");
  modeler.setMapSize(1500, 900);
  await wait(50);
  assert.match(ytext.toString(), /size \[1500, 900\]/);
  assert.doesNotMatch(ytext.toString(), /size \[(900|1200), /);
  unbind();
  engine.destroy();
});

test("presence on a Wardley map: the selection travels as document ids, a peer's component NAME (the Live Host's) is outlined", async () => {
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  const engine = await engineOf("wardley", host("wardley-canvas"));
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, MAP);
  const published: string[][] = [];
  let deliver: (peers: RemotePresence[]) => void = () => {};
  const unbind = engine.bindLive!(ytext, doc, {
    onConflict: assert.fail,
    onImportError: assert.fail,
    presence: {
      setLocal: (local) => void (local && published.push(local.selection)),
      onRemote(callback) {
        deliver = callback;
        callback([]);
        return () => {};
      },
    },
  });
  await wait(50);
  const diagram = engine.modeler.diagram as unknown as WardleyServices;
  const cup = diagram.get("elementRegistry").get("cmp_cup_of_tea");
  diagram.get("selection").select(cup);
  assert.deepEqual(published.at(-1), ["cmp_cup_of_tea"]);
  // renamed on this canvas: the canvas keeps its id until the next import,
  // the document (and so every peer) ids the element by its new name
  diagram.get("wardleyModeling").updateLabel(cup, "Pot of Tea");
  diagram.get("selection").select(cup);
  assert.deepEqual(published.at(-1), ["cmp_pot_of_tea"]);
  await wait(20);
  assert.match(ytext.toString(), /^component Pot of Tea /m);

  deliver([
    {
      clientId: 7,
      user: { name: "AI · Dominik", color: "#1D4ED8", kind: "agent" },
      canvas: { cursor: null, selection: ["Hot Water", "dep-0"] },
    },
  ]);
  await wait(20);
  const outlines = [...diagram.get("canvas").getLayer("designiq-presence").querySelectorAll("rect[stroke-dasharray]")];
  const water = diagram.get("elementRegistry").get("cmp_hot_water")!;
  assert.deepEqual(
    outlines.map((rect) => [Number(rect.getAttribute("x")), Number(rect.getAttribute("y"))]),
    [[water.x - 3, water.y - 3]],
    "the component the agent changed, by its name; the positional edge id outlines nothing",
  );
  unbind();
  engine.destroy();
  globalThis.requestAnimationFrame = raf;
});

test("Team Topologies takes no key while its canvas is inert or a modal dialog is open, as the live editor's hidden layer and dialogs are", async () => {
  const layer = host();
  const canvasHost = layer.ownerDocument.createElement("div");
  canvasHost.className = "tt-canvas";
  layer.append(canvasHost);
  const engine = await engineOf("team-topology", canvasHost);
  await engine.importText(TEAMS);
  const diagram = engine.modeler.diagram as unknown as DiagramServices;
  const deleteOnThePage = (): number => {
    diagram.get("selection").select(shapesOf(diagram)[0]);
    layer.ownerDocument.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
    );
    return shapesOf(diagram).length;
  };
  const before = shapesOf(diagram).length;
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
  const engine = await engineOf("team-topology", host("tt-canvas"));
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, TEAMS);
  const unbind = engine.bindLive!(ytext, doc, { onConflict: assert.fail, onImportError: assert.fail });
  await wait(500);
  assert.equal(ytext.toString(), TEAMS, "the import echoes nothing into the shared text");

  const modeler = engine.modeler.diagram as unknown as TeamTopologyModeler;
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

/** per notation: the element whose label is typed, and what the peer's
 *  change in DOCUMENTS leaves in the text (another element) */
const LABEL_EDITS: Record<string, [elementId: string, peerChange: string]> = {
  wardley: ["cmp_cup_of_tea", "Hot Water [0.82, 0.55]"],
  "event-storming": ["cmd_place_order", "Order Placed [640, 300]"],
  "context-map": ["ctx_cfp", "Agenda Builder"],
  "team-topology": ["team_checkout", "Cloud Platform"],
};

interface EditableDiagram {
  get(name: "elementRegistry"): { get(id: string): unknown };
  get(name: "eventBus"): { fire(event: string, payload: unknown): void };
}

/** the canvas's open label editor: an input, a textarea or diagram-js's
 *  direct editing (contenteditable) */
function openLabelEditor(container: HTMLElement): HTMLElement {
  const field = container.querySelector<HTMLElement>("input, textarea, [contenteditable='true']");
  assert.ok(field, "a label editor is open");
  return field;
}

// diagram-js's direct editing reads innerText, which jsdom only stores
const typedText = (field: HTMLElement): string =>
  field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
    ? field.value
    : (field as unknown as { innerText: string }).innerText;

function typeInto(field: HTMLElement, value: string): void {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = value;
  else (field as unknown as { innerText: string }).innerText = value;
  field.dispatchEvent(new field.ownerDocument.defaultView!.Event("input", { bubbles: true }));
}

test("every renderer, in both hosts: a typed label is no edit until it commits, and a peer's re-import keeps it open", async () => {
  const svgElement = SVGElement.prototype as unknown as { getBBox(): unknown };
  const getBBox = svgElement.getBBox;
  // content with a size, so the widget fits the view after the peer's
  // re-import (jsdom measures every shape 0×0, and an empty canvas is not fitted)
  svgElement.getBBox = () => ({ x: 0, y: 0, width: 600, height: 400 });
  try {
    for (const where of HOSTS) {
      for (const [id, text, peer] of DOCUMENTS) {
        const [elementId, peerChange] = LABEL_EDITS[id]!;
        const doc = new Y.Doc();
        const ytext = doc.getText("content");
        ytext.insert(0, text);
        const { container, modeler, destroy } = await mountLive(where, id, ytext, doc);
        await wait(50);
        const diagram = modeler.diagram as unknown as EditableDiagram;
        const element = diagram.get("elementRegistry").get(elementId);
        assert.ok(element, `${where}, ${id}: ${elementId}`);
        diagram.get("eventBus").fire("element.dblclick", { element });
        typeInto(openLabelEditor(container), "Half Typ");
        await wait(20);
        assert.equal(ytext.toString(), text, `${where}, ${id}: the open editor is a preview`);

        doc.transact(() => {
          ytext.delete(0, ytext.length);
          ytext.insert(0, peer);
        });
        await wait(500);
        assert.equal(ytext.toString(), peer, `${where}, ${id}: the peer's text, nothing of what was typed`);
        const field = openLabelEditor(container);
        assert.equal(typedText(field), "Half Typ", `${where}, ${id}: the editor stays open with what was typed`);

        typeInto(field, "Half Typed");
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, ctrlKey: true, bubbles: true, cancelable: true }),
        );
        await wait(20);
        assert.match(ytext.toString(), /Half Typed/, `${where}, ${id}: the commit is the edit`);
        assert.ok(ytext.toString().includes(peerChange), `${where}, ${id}: the peer's change stays`);
        destroy();
      }
    }
  } finally {
    svgElement.getBBox = getBBox;
  }
});

test("Team Topologies: typing a label is no edit until it commits, and a peer's re-import keeps what was typed", async () => {
  const widget = host("tt-canvas");
  const engine = await engineOf("team-topology", widget);
  await engine.importText(TEAMS);
  let dirty = 0;
  engine.onDirty(() => dirty++);
  const modeler = engine.modeler.diagram as unknown as TeamTopologyModeler;
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
  const [spec, renderer] = await load("context-map");
  const text = newCmJson("map", "Conference Planner");

  const { createCollaborativeModeler } = await import("@miragon/context-maps-renderer");
  const bareHost = host("cm-canvas");
  const bare = createCollaborativeModeler();
  bare.attachTo(bareHost);
  await bare.importText(text);
  assert.equal(bareHost.querySelector(".cm-legend"), null, "the renderer alone draws none");
  bare.destroy();

  const { mountMiragonEditor } = await import("../src/notations/miragon/editor.ts");
  const spa = host("cm-canvas");
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  const editor = mountMiragonEditor(spec, renderer, spa, {
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
    const engine = mountMiragonEngine(spec, renderer, widget, readonly);
    await engine.importText(text);
    assert.ok(widget.querySelector(".cm-legend"), readonly ? "the widget viewer" : "the widget editor");
    engine.destroy();
  }
});
