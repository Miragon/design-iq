/**
 * What the Miragon renderers bring to designIQ's chrome, for real (under
 * jsdom, test/renderer-dom.ts), through the specs both hosts mount them with:
 * their own menu content (Wardley mapMenu, Event Storming boardMenu, Context
 * Maps contextMapMenu, Team Topologies diagramMenu, Value Chain diagramMenu)
 * in the widget engine and the SPA editor, the dialogs and popovers it opens
 * inside the mount's host, the edits they make (one undoable step each), the
 * exports a host hands to the user, the document title as the menu header's
 * display name, and the zoom keys and ⇧1 of the SPA's editors on a real canvas.
 */
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

import type { CmBaseViewer } from "@miragon/context-maps-renderer";
import { fitViewbox } from "@miragon/modeler-shell/core";
import * as Y from "yjs";

import type { ExportFile, MenuHost } from "../src/mcp-app/core/engine.ts";
import { buildMenu, type ModelerMenu, runModelerItem } from "../src/mcp-app/core/menu-model.ts";
import { mountMiragonEngine } from "../src/mcp-app/engines/miragon.ts";
import { MIRAGON_RENDERERS } from "../src/notations/miragon/index.ts";
import type { LoadedMiragonRenderer, MiragonModeler, MiragonRendererSpec } from "../src/notations/miragon/spec.ts";
import type { EditorContext, MountedEditor } from "../src/notations/registry.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function load(id: string): Promise<[MiragonRendererSpec, LoadedMiragonRenderer]> {
  const spec = MIRAGON_RENDERERS.find((s) => s.id === id);
  assert.ok(spec, id);
  return [spec, await spec.load()];
}

const MAP =
  "title Tea Shop\ncomponent Cup of Tea [0.79, 0.61]\ncomponent Hot Water [0.82, 0.45]\nCup of Tea->Hot Water\n";
const BOARD = "title Checkout\ncommand Place Order [240, 300]\nevent Order Placed [620, 300]\n";
const CONTEXT_MAP = JSON.stringify({
  version: 1,
  title: "Conference",
  contexts: [{ id: "ctx_cfp", label: "CfP", position: { x: 40, y: 40 }, size: { width: 200, height: 110 } }],
  relationships: [],
});
const TEAMS = JSON.stringify({
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
  ],
  interactions: [],
  flows: [],
});
const VALUE_CHAIN = JSON.stringify({
  schemaVersion: 1,
  meta: { name: "Order to Cash" },
  elements: [
    { id: "step_order", elementType: "step", name: "Order", bounds: { x: 40, y: 40, width: 200, height: 80 } },
  ],
  connections: [],
});
const DOCUMENT: Record<string, [text: string, title: string]> = {
  wardley: [MAP, "Tea Shop"],
  "event-storming": [BOARD, "Checkout"],
  "context-map": [CONTEXT_MAP, "Conference"],
  "team-topology": [TEAMS, "Online Shop"],
  "value-chain": [VALUE_CHAIN, "Order to Cash"],
};

/** the chrome around a mount: a menu trigger in the page, a download that records */
function chrome(stem = "tea-shop") {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  const files: ExportFile[] = [];
  const failures: string[] = [];
  const menuHost: MenuHost = {
    trigger,
    fileStem: () => stem,
    async download(build) {
      try {
        files.push(await build());
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    },
  };
  return { trigger, files, failures, menuHost };
}

const ids = (menu: ModelerMenu | undefined) =>
  menu && {
    model: menu.model.map((e) => e.id),
    export: menu.export.map((e) => e.id),
    help: menu.help.map((e) => e.id),
  };

/** the widget engine as the Miragon widget mounts it, with its menu host */
async function widgetOf(id: string, readonly = false) {
  const [spec, renderer] = await load(id);
  const container = host(spec.canvasClassName);
  const around = chrome();
  const engine = mountMiragonEngine(spec, renderer, container, readonly, {
    insets: () => ({ top: 56, right: 16, bottom: 56, left: 16 }),
    menuHost: around.menuHost,
  });
  await engine.importText(DOCUMENT[id]![0]);
  return { engine, container, ...around };
}

/** a side panel over the SPA's canvas, opened and closed by the test */
function sidePanels() {
  let covered = 0;
  const listeners = new Set<() => void>();
  return {
    room: {
      covered: () => covered,
      onChange(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    set(next: number) {
      covered = next;
      for (const listener of listeners) listener();
    },
    listening: () => listeners.size,
  };
}

/** the SPA's editor of a notation on a shared Y.Text, its ⋯ trigger in the page */
async function editorOf(id: string, panels = sidePanels()) {
  const [spec, renderer] = await load(id);
  const { mountMiragonEditor } = await import("../src/notations/miragon/editor.ts");
  const container = host(spec.canvasClassName);
  const doc = new Y.Doc();
  doc.getText("content").insert(0, DOCUMENT[id]![0]);
  const trigger = document.createElement("button");
  document.body.append(trigger);
  const failed: string[] = [];
  let modeler: MiragonModeler | undefined;
  const editor: MountedEditor = mountMiragonEditor(
    spec,
    { ...renderer, create: (o) => (modeler = renderer.create(o)) },
    container,
    {
      ytext: doc.getText("content"),
      doc,
      docPath: `processes/${id}.model`,
      onSyncError: assert.fail,
      onImportFailed: assert.fail,
      onBadgeClick: () => {},
      onSelectionChanged: () => {},
      menuTrigger: () => trigger,
      onActionFailed: (message: string) => void failed.push(message),
      sidePanels: panels.room,
    } as unknown as EditorContext,
  );
  await wait(50);
  assert.ok(modeler);
  return { editor, container, trigger, failed, modeler, renderer, panels };
}

const EXPECTED = {
  wardley: {
    model: ["map-title", "map-size", "x-axis-labels"],
    export: ["export-png", "export-svg"],
    help: ["keyboard-shortcuts"],
  },
  "event-storming": {
    model: ["level", "type-captions"],
    export: ["export-png", "export-svg"],
    help: ["keyboard-shortcuts"],
  },
  // the JSON is the model's file itself
  "context-map": {
    model: ["map-title"],
    export: ["export-png", "export-svg", "export-cml"],
    help: ["keyboard-shortcuts"],
  },
  "team-topology": {
    model: ["diagram-title"],
    export: ["export-png", "export-svg"],
    help: ["keyboard-shortcuts"],
  },
  // no title dialog in the package: the document's name is edited as JSON
  "value-chain": {
    model: [],
    export: ["export-png", "export-svg"],
    help: ["keyboard-shortcuts"],
  },
};

test("each renderer's own entries reach both hosts as its package names them", async () => {
  for (const [id, expected] of Object.entries(EXPECTED)) {
    const widget = await widgetOf(id);
    assert.deepEqual(ids(widget.engine.menu), expected, `${id}: the widget`);
    const viewer = await widgetOf(id, true);
    assert.deepEqual(
      ids(viewer.engine.menu),
      expected,
      `${id}: the read-only viewer, its entries disabled by the menu`,
    );
    const spa = await editorOf(id);
    assert.deepEqual(ids(spa.editor.menu), expected, `${id}: the SPA's ⋯ menu`);
    widget.engine.destroy();
    viewer.engine.destroy();
    spa.editor.destroy();
  }
});

test("Keyboard shortcuts…: the dialog opens inside the mount's host — the canvas host — and gives the focus back to the trigger", async () => {
  for (const id of Object.keys(EXPECTED)) {
    for (const where of ["widget", "spa"] as const) {
      const mounted =
        where === "widget"
          ? await widgetOf(id).then((w) => ({
              menu: w.engine.menu,
              container: w.container,
              trigger: w.trigger,
              destroy: () => w.engine.destroy(),
            }))
          : await editorOf(id).then((s) => ({
              menu: s.editor.menu,
              container: s.container,
              trigger: s.trigger,
              destroy: () => s.editor.destroy(),
            }));
      // where each menu leaves the focus as it opens a dialog: the widget's on
      // its trigger, the SPA's nowhere (radix must not take it back from the
      // dialog), so a dialog that returns the focus to its opener (Team
      // Topologies) falls back to the trigger there
      if (where === "widget") mounted.trigger.focus();
      else (document.activeElement as HTMLElement | null)?.blur();
      assert.ok(runModelerItem(mounted.menu!, "modeler:keyboard-shortcuts"));
      const dialog = mounted.container.querySelector<HTMLDialogElement>("dialog[open]");
      assert.ok(dialog, `${id} in the ${where}: a dialog in the canvas host`);
      assert.equal(dialog.parentElement, mounted.container, "a child of the host, beside the renderer's root");
      const view = [...dialog.querySelectorAll("tr")].map((row) => row.textContent);
      // the shell's messages name the zoom keys, as the machine's keyboard has them
      const mac = /mac/i.test(navigator.platform);
      assert.ok(view.includes(mac ? "Zoom in⌘+" : "Zoom inCtrl+Plus"), `${id}: ${view.slice(0, 4).join(" / ")}`);
      assert.ok(view.includes(mac ? "Fit to view⇧1" : "Fit to viewShift+1"));
      dialog.close();
      assert.equal(document.activeElement, mounted.trigger, "the focus returns to the menu trigger");
      mounted.destroy();
      assert.equal(mounted.container.querySelector("dialog"), null, `${id}: the dialog goes with the mount`);
    }
  }
});

test("Map title… and Diagram title…: the dialog writes the title as one undoable step, and the menu header names it", async () => {
  const titleEntries: Array<[id: string, entry: string]> = [
    ["wardley", "map-title"],
    ["context-map", "map-title"],
    ["team-topology", "diagram-title"],
  ];
  for (const [id, entry] of titleEntries) {
    const { engine, container } = await widgetOf(id);
    let dirty = 0;
    engine.onDirty(() => dirty++);
    assert.equal(engine.displayName?.(), DOCUMENT[id]![1]);
    runModelerItem(engine.menu!, `modeler:${entry}`);
    const dialog = container.querySelector<HTMLDialogElement>("dialog[open]")!;
    const field = dialog.querySelector<HTMLInputElement>("input")!;
    assert.equal(field.value, DOCUMENT[id]![1], `${id}: the field holds the title`);
    field.value = "Renamed Together";
    dialog.querySelector("form")!.requestSubmit();
    assert.equal(dialog.hasAttribute("open"), false, "Apply closes it");
    assert.equal(dirty, 1, `${id}: one change`);
    assert.match(await engine.exportText(), /Renamed Together/);
    assert.equal(engine.displayName?.(), "Renamed Together", "the menu header follows");
    const diagram = engine.modeler.diagram as unknown as { get(name: "commandStack"): { undo(): void } };
    diagram.get("commandStack").undo();
    assert.equal(engine.displayName?.(), DOCUMENT[id]![1], `${id}: one undo step puts it back`);
    engine.destroy();
  }
});

test("Event Storming: the Level radio is one undoable edit of the board; Type captions is a view preference the next mount keeps", async () => {
  const { engine } = await widgetOf("event-storming");
  let dirty = 0;
  engine.onDirty(() => dirty++);
  const level = () => (engine.menu!.model.find((e) => e.id === "level") as { value(): string }).value();
  assert.equal(level(), "design", "no level line: everything available");
  runModelerItem(engine.menu!, "modeler:level:process");
  assert.equal(level(), "process");
  assert.equal(dirty, 1);
  assert.match(await engine.exportText(), /^level process$/m);
  const diagram = engine.modeler.diagram as unknown as { get(name: "commandStack"): { undo(): void } };
  diagram.get("commandStack").undo();
  assert.equal(level(), "design", "undone in one step");

  const captions = engine.menu!.model.find((e) => e.id === "type-captions") as { checked(): boolean };
  const before = await engine.exportText();
  dirty = 0;
  assert.equal(captions.checked(), true);
  runModelerItem(engine.menu!, "modeler:type-captions");
  assert.equal(captions.checked(), false);
  assert.equal(dirty, 0, "a view preference is no edit");
  assert.equal(await engine.exportText(), before);
  engine.destroy();
  const next = await widgetOf("event-storming");
  assert.equal(
    (next.engine.menu!.model.find((e) => e.id === "type-captions") as { checked(): boolean }).checked(),
    false,
  );
  runModelerItem(next.engine.menu!, "modeler:type-captions");
  next.engine.destroy();
});

/** the widget menu's items over a read-only viewer's own entries */
function readOnlyItems(modeler: ModelerMenu) {
  return buildMenu({
    kind: "miragon",
    editable: false,
    live: false,
    dirty: false,
    saving: false,
    paused: false,
    inactive: false,
    viewport: true,
    fullscreenOffered: false,
    displayMode: "inline",
    deepLink: false,
    modeler,
  }).flatMap((g) => g.items);
}

test("a read-only viewer: Type captions, Export and Help stay usable, the entries that write the document do not", async () => {
  const board = await widgetOf("event-storming", true);
  assert.deepEqual(
    readOnlyItems(board.engine.menu!)
      .filter((i) => i.disabled)
      .map((i) => i.id),
    ["modeler:level:big-picture", "modeler:level:process", "modeler:level:design"],
  );
  board.engine.destroy();
  const teams = await widgetOf("team-topology", true);
  const items = readOnlyItems(teams.engine.menu!);
  assert.deepEqual(
    items.filter((i) => i.disabled).map((i) => i.id),
    ["modeler:diagram-title"],
    "Team Topologies: the title writes the document, the exports and the shortcuts do not",
  );
  assert.ok(items.some((i) => i.id === "modeler:export-png" && !i.disabled));
  teams.engine.destroy();
});

test("Wardley: Map size… opens its popover at the menu's place in the mount's host, with the size field focused", async () => {
  const { engine, container } = await widgetOf("wardley");
  runModelerItem(engine.menu!, "modeler:map-size");
  const popover = container.querySelector<HTMLElement>(".wardley-popover:not([hidden])");
  assert.ok(popover);
  assert.equal(popover.getAttribute("role"), "dialog", "a non-modal dialog: the zoom keys stay");
  assert.equal(popover.getAttribute("aria-modal"), null);
  assert.equal(document.activeElement, popover.querySelector("select"));
  engine.destroy();
});

test("exports: the SVG reaches the host's download, named after the model", async () => {
  for (const id of Object.keys(EXPECTED)) {
    const { engine, files, failures } = await widgetOf(id);
    runModelerItem(engine.menu!, "modeler:export-svg");
    await wait(50);
    assert.equal(files.length, 1, `${id}: ${failures.join(", ")}`);
    assert.deepEqual([files[0]!.name, files[0]!.mimeType], ["tea-shop.svg", "image/svg+xml"]);
    assert.match(String(files[0]!.data), /<svg[\s>]/);
    engine.destroy();
  }
});

test("Context Maps: Export as CML hands the host Context Mapper's text of the map, named after the model, in an editor and a viewer", async () => {
  const { serializeCml } = await import("@miragon/context-maps-cml");
  for (const readonly of [false, true]) {
    const { engine, files, failures } = await widgetOf("context-map", readonly);
    runModelerItem(engine.menu!, "modeler:export-cml");
    await wait(50);
    assert.deepEqual(failures, [], readonly ? "the viewer" : "the editor");
    assert.equal(files.length, 1);
    assert.deepEqual([files[0]!.name, files[0]!.mimeType], ["tea-shop.cml", "text/plain"]);
    const map = engine.modeler.diagram as unknown as CmBaseViewer;
    assert.equal(files[0]!.data, serializeCml(map.exportDocument()));
    assert.match(String(files[0]!.data), /^ContextMap Conference \{$/m);
    assert.match(String(files[0]!.data), /^BoundedContext CtxCfp$/m);
    engine.destroy();
  }
});

test("Context Maps: a map the CML export cannot read ends in the host's failure report, never in a throw from the menu", async () => {
  const { engine, files, failures } = await widgetOf("context-map");
  const map = engine.modeler.diagram as unknown as CmBaseViewer;
  map.exportDocument = () => {
    throw new Error("the map could not be read");
  };
  assert.doesNotThrow(() => runModelerItem(engine.menu!, "modeler:export-cml"));
  await wait(50);
  assert.deepEqual(files, []);
  assert.deepEqual(failures, ["the map could not be read"]);
  engine.destroy();
});

/** the page's Geist as the widget's stylesheet holds it (geist.css: data: URIs);
 *  jsdom keeps no src in a parsed @font-face, so the sheet is written out */
function geistOnThePage(): () => void {
  const latin = "data:font/woff2;base64,R2Vpc3QgbGF0aW4=";
  const face = Object.create(CSSFontFaceRule.prototype, {
    style: {
      value: {
        getPropertyValue: (name: string) =>
          ({
            "font-family": '"Geist Variable"',
            "font-weight": "100 900",
            "unicode-range": "U+0-FF, U+131, U+152-153",
            src: `url("${latin}") format("woff2-variations")`,
          })[name] ?? "",
      },
    },
    parentStyleSheet: { value: null },
  }) as CSSFontFaceRule;
  Object.defineProperty(document, "styleSheets", { configurable: true, value: [{ href: null, cssRules: [face] }] });
  return () => void delete (document as { styleSheets?: unknown }).styleSheets;
}

/** jsdom draws no image, so while this is installed the rasterizer's image
 *  and canvas record what they are given: only during an export, because the
 *  renderers measure their labels on a canvas of their own */
function recordingRasterizer(): { drawn: { svg: string; background: unknown }[]; restore(): void } {
  const drawn: { svg: string; background: unknown }[] = [];
  const image = HTMLImageElement.prototype as HTMLImageElement & { decode?: () => Promise<void> };
  const canvas = HTMLCanvasElement.prototype;
  const serializer = XMLSerializer.prototype;
  const real = {
    decode: image.decode,
    getContext: canvas.getContext,
    toBlob: canvas.toBlob,
    serializeToString: serializer.serializeToString,
  };
  // the renderers' saveSVG sets xmlns as an attribute: a browser writes it
  // once, jsdom a second time, and the SVG would not parse
  serializer.serializeToString = function (this: XMLSerializer, node: Node) {
    return real.serializeToString.call(this, node).replace(/^(<svg xmlns="[^"]*"[^>]*?) xmlns="[^"]*"/, "$1");
  };
  image.decode = async function (this: HTMLImageElement) {
    const [, data = ""] = /^data:image\/svg\+xml;charset=utf-8,(.*)$/.exec(this.src) ?? [];
    drawn.push({ svg: decodeURIComponent(data), background: undefined });
  };
  canvas.getContext = function () {
    const context = {
      fillStyle: "" as unknown,
      fillRect: () => void (drawn.at(-1)!.background = context.fillStyle),
      drawImage: () => {},
    };
    return context;
  } as unknown as typeof canvas.getContext;
  canvas.toBlob = (done: BlobCallback) => done(new Blob(["png"], { type: "image/png" }));
  return {
    drawn,
    restore() {
      Object.assign(image, { decode: real.decode });
      Object.assign(canvas, { getContext: real.getContext, toBlob: real.toBlob });
      serializer.serializeToString = real.serializeToString;
    },
  };
}

/** until the host's download has `count` files or a failure */
async function downloaded(files: ExportFile[], failures: string[], count = 1): Promise<void> {
  for (let waited = 0; files.length < count && failures.length === 0 && waited < 2000; waited += 10) await wait(10);
}

/** Export as PNG on a mounted widget */
async function exportPng(id: string) {
  const { engine, files, failures } = await widgetOf(id);
  const rasterizer = recordingRasterizer();
  try {
    runModelerItem(engine.menu!, "modeler:export-png");
    await downloaded(files, failures);
  } finally {
    rasterizer.restore();
    engine.destroy();
  }
  return { files, failures, drawn: rasterizer.drawn };
}

test("exports: the PNG is drawn from the SVG with Geist inside, through a data: URL, on the guide's light ground", async () => {
  const removeGeist = geistOnThePage();
  // guide §10.7: the plot's white under a map with a plot, the canvas ground's grey under the others
  const paper: Record<string, string> = {
    wardley: "#FFFFFF",
    "event-storming": "#F9F7F7",
    "context-map": "#F9F7F7",
    "team-topology": "#F9F7F7",
    "value-chain": "#F9F7F7",
  };
  try {
    for (const id of Object.keys(EXPECTED)) {
      const { files, failures, drawn } = await exportPng(id);
      assert.deepEqual(failures, [], `${id}: the export fails`);
      assert.deepEqual([files[0]!.name, files[0]!.mimeType], ["tea-shop.png", "image/png"]);
      assert.equal(drawn.length, 1, `${id}: drawn once`);
      const { svg, background } = drawn[0]!;
      assert.match(
        svg,
        /^<svg[^>]*><defs><style>@font-face\{font-family:'Geist Variable';[^}]*src:url\("data:font\/woff2;base64,R2Vpc3QgbGF0aW4="\);\}<\/style><\/defs><g visibility="hidden"><text font-family="'Geist Variable'">\S<\/text><\/g>/,
        `${id}: the face goes in ahead of the drawing, with its hidden text`,
      );
      assert.match(svg, /<text[^>]*font-family[^>]*Geist Variable/, `${id}: and its text asks for it`);
      assert.equal(background, paper[id], `${id}: the paper under the drawing`);
      assert.doesNotMatch(svg, /tt-export-paper/, `${id}: no sheet of the renderer's over that paper`);
    }
  } finally {
    removeGeist();
  }
  // a page without Geist still gets its PNG, in the system sans
  const warned = mock.method(console, "warn", () => {});
  const { files, drawn } = await exportPng("event-storming");
  warned.mock.restore();
  assert.equal(files[0]?.name, "tea-shop.png");
  assert.doesNotMatch(drawn[0]?.svg ?? "", /@font-face/);
  assert.equal(warned.mock.callCount(), 1, "the fallback is no secret");
});

/** an element of each document, for a peer to select */
const SELECTED: Record<string, string> = {
  wardley: "cmp_cup_of_tea",
  "event-storming": "cmd_place_order",
  "context-map": "ctx_cfp",
  "team-topology": "team_checkout",
  "value-chain": "step_order",
};

test("exports: the SVG and the PNG leave out the live canvas's presence: no peer's cursor, outline or name", async () => {
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  const PEERS = ["Ada Lovelace", "Claude"];
  const removeGeist = geistOnThePage();
  try {
    for (const id of Object.keys(EXPECTED)) {
      const [spec, renderer] = await load(id);
      const container = host(spec.canvasClassName);
      const { files, failures, menuHost } = chrome();
      const engine = mountMiragonEngine(spec, renderer, container, false, {
        insets: () => ({ top: 56, right: 16, bottom: 56, left: 16 }),
        menuHost,
      });
      const doc = new Y.Doc();
      doc.getText("content").insert(0, DOCUMENT[id]![0]);
      const unbind = engine.bindLive!(doc.getText("content"), doc, {
        onConflict: assert.fail,
        onImportError: assert.fail,
        presence: {
          setLocal: () => {},
          onRemote(callback) {
            callback([
              {
                clientId: 8,
                user: { name: PEERS[0]!, color: "#1D4ED8", kind: "human" },
                canvas: { cursor: { x: 120, y: 90 }, selection: [SELECTED[id]!] },
              },
              {
                clientId: 7,
                user: { name: PEERS[1]!, color: "#1D4ED8", kind: "agent" },
                canvas: { cursor: null, selection: [SELECTED[id]!] },
              },
            ]);
            return () => {};
          },
        },
      });
      await wait(50);
      const diagram = engine.modeler.diagram as unknown as {
        get(name: "canvas"): { getLayer(name: string): SVGElement };
        saveSVG(): { svg: string } | Promise<{ svg: string }>;
      };
      const layer = diagram.get("canvas").getLayer("designiq-presence");
      assert.equal(layer.querySelectorAll("rect[stroke]").length, 2, `${id}: both peers outline the element`);
      assert.equal(layer.querySelectorAll("rect[stroke-dasharray]").length, 1, `${id}: the agent's outline dashed`);
      const rasterizer = recordingRasterizer();
      try {
        const raw = (await diagram.saveSVG()).svg;
        for (const name of PEERS) assert.ok(raw.includes(name), `${id}: the renderer's own SVG copies ${name}'s pill`);
        runModelerItem(engine.menu!, "modeler:export-svg");
        await downloaded(files, failures);
        runModelerItem(engine.menu!, "modeler:export-png");
        await downloaded(files, failures, 2);
      } finally {
        rasterizer.restore();
      }
      assert.deepEqual(failures, [], id);
      assert.deepEqual(
        files.map((file) => file.mimeType),
        ["image/svg+xml", "image/png"],
      );
      assert.equal(rasterizer.drawn.length, 1, `${id}: the PNG drawn once`);
      for (const [what, svg] of [
        ["the SVG", String(files[0]!.data)],
        ["the PNG's SVG", rasterizer.drawn[0]!.svg],
      ] as const) {
        assert.match(svg, /<svg[\s>]/, `${id}: ${what} is still the diagram`);
        assert.doesNotMatch(svg, /layer-designiq-presence/, `${id}: ${what} holds no presence layer`);
        for (const name of PEERS) assert.ok(!svg.includes(name), `${id}: ${what} names no ${name}`);
      }
      for (const name of PEERS) assert.ok(layer.textContent?.includes(name), `${id}: the canvas still shows ${name}`);
      unbind();
      engine.destroy();
    }
  } finally {
    removeGeist();
    globalThis.requestAnimationFrame = raf;
  }
});

test("withoutPresence: an SVG without the layer comes back as it was, one that cannot be read is refused", async () => {
  const { withoutPresence } = await import("../src/lib/presence-canvas.ts");
  const drawing =
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><g class="viewport"><g class="layer-base"><rect width="10" height="10"/></g></g></svg>';
  assert.equal(withoutPresence(drawing), drawing);
  assert.throws(
    () => withoutPresence('<svg><g class="layer-designiq-presence"><text>Ada</svg>'),
    /the diagram's SVG could not be read/,
  );
});

test("Team Topologies: the PNG's SVG loses the renderer's white sheet and nothing else", async () => {
  const { withoutExportSheet } = await import("../src/notations/miragon/team-topology.ts");
  const sheet = '<rect class="tt-export-paper" x="0" y="0" width="80" height="40" fill="#FFFFFF"/>';
  const drawing = (first: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40" width="80" height="40">${first}<g class="viewport"><rect class="team" width="10" height="10"/></g></svg>`;
  const without = withoutExportSheet(drawing(sheet));
  assert.doesNotMatch(without, /tt-export-paper/);
  assert.match(without, /<g class="viewport"><rect class="team" width="10" height="10"\/><\/g>/);
  // a renderer that no longer draws the sheet (Miragon/modeler-suite#234) needs no change here
  assert.equal(withoutExportSheet(drawing("")), drawing(""));
});

test("displayName: every renderer's document title", async () => {
  for (const id of Object.keys(DOCUMENT)) {
    const [spec, renderer] = await load(id);
    const engine = mountMiragonEngine(spec, renderer, host(spec.canvasClassName), false);
    // before the first import: the renderer's empty document, never a throw
    assert.doesNotThrow(() => engine.displayName?.(), id);
    await engine.importText(DOCUMENT[id]![0]);
    assert.equal(engine.displayName?.(), DOCUMENT[id]![1], id);
    engine.destroy();
  }
});

test("displayName: a map or board without a title line, or a value chain without a name, has none, not a placeholder", async () => {
  const untitled: Record<string, string> = {
    wardley: MAP.replace(/^title .*\n/, ""),
    "event-storming": BOARD.replace(/^title .*\n/, ""),
    "value-chain": VALUE_CHAIN.replace('"name":"Order to Cash"', '"name":" "'),
  };
  for (const [id, text] of Object.entries(untitled)) {
    const [spec, renderer] = await load(id);
    const engine = mountMiragonEngine(spec, renderer, host(spec.canvasClassName), false);
    await engine.importText(text);
    assert.equal(engine.displayName?.(), undefined, id);
    engine.destroy();
  }
});

test("the SPA's Miragon editors: the zoom keys and ⇧1 drive the canvas, a text field keeps them", async () => {
  const { editor, container, modeler } = await editorOf("wardley");
  const { spaFitInsets } = await import("../src/notations/miragon/editor.ts");
  const canvas = modeler.diagram.get("canvas") as { viewbox(): { scale: number } };
  const scale = (): number => Math.round(canvas.viewbox().scale * 1000) / 1000;
  const press = (key: string, code: string, mods: Partial<KeyboardEventInit>, target: Element = document.body) => {
    const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods });
    target.dispatchEvent(event);
    return event;
  };
  assert.equal(press("0", "Digit0", { ctrlKey: true }).defaultPrevented, true, "the page does not zoom");
  assert.equal(scale(), 1, "Ctrl+0: 100 %");
  press("=", "Equal", { ctrlKey: true });
  assert.equal(scale(), 1.349, "Ctrl+= one step in, to the guide's 135 %, as the widget's +");
  press("-", "Minus", { metaKey: true });
  assert.equal(scale(), 1, "⌘- one step out");
  const field = document.createElement("input");
  container.append(field);
  assert.equal(press("=", "Equal", { ctrlKey: true }, field).defaultPrevented, false);
  assert.equal(scale(), 1, "a text field keeps the key: the browser zooms the page");
  field.remove();
  // ⇧1: the plot with its axes into what the renderer's palette leaves free
  // (jsdom lays nothing out: the palette measures 0)
  press("!", "Digit1", { shiftKey: true });
  const fitted = fitViewbox(
    modeler.contentBounds!()!,
    { width: 1000, height: 640 },
    spaFitInsets({ paletteBottom: 0, coveredRight: 0 }),
  );
  assert.ok(fitted);
  assert.equal(scale(), Math.round(fitted.scale * 1000) / 1000);
  editor.destroy();
  assert.equal(press("=", "Equal", { ctrlKey: true }).defaultPrevented, false, "gone with the editor");
});

/** Value Chain's diagram-js keeps its own zoom on the focused canvas: a step it clamps to 20 %, so from a fit below it a step out zooms in */
async function valueChainKeys(
  mountChrome: () => Promise<{ container: HTMLElement; diagram: MiragonModeler["diagram"] }>,
) {
  const { container, diagram } = await mountChrome();
  const canvas = diagram.get("canvas") as {
    viewbox(): { scale: number; outer: { width: number; height: number } };
    viewbox(box: { x: number; y: number; width: number; height: number }): void;
  };
  const zoomScroll = diagram.get("zoomScroll") as { stepZoom(direction: number): void };
  const own: number[] = [];
  const stepZoom = zoomScroll.stepZoom.bind(zoomScroll);
  zoomScroll.stepZoom = (direction) => {
    own.push(direction);
    stepZoom(direction);
  };
  const svg = container.querySelector<SVGSVGElement>(".djs-container > svg");
  assert.ok(svg, "the canvas");
  const level = (): number => Math.round(canvas.viewbox().scale * 1000) / 1000;
  // a viewbox write, not canvas.zoom: jsdom keeps no CTM (renderer-dom.ts)
  const viewAt = (scale: number): void => {
    const { outer } = canvas.viewbox();
    canvas.viewbox({ x: 0, y: 0, width: outer.width / scale, height: outer.height / scale });
  };
  const press = (key: string, code: string, mods: Partial<KeyboardEventInit>): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods });
    svg.dispatchEvent(event);
    return event;
  };
  return { svg, own, level, viewAt, press };
}

test("the SPA's Value Chain editor: a zoom key on the focused canvas is the chrome's, never diagram-js's own, which zooms in below 20 %", async () => {
  const { editor, container, modeler } = await editorOf("value-chain");
  const { svg, own, level, viewAt, press } = await valueChainKeys(async () => ({
    container,
    diagram: modeler.diagram,
  }));
  editor.focus?.();
  assert.equal(document.activeElement, svg, "the canvas has the focus");
  viewAt(0.12);
  assert.equal(press("-", "Minus", { ctrlKey: true }).defaultPrevented, true, "the page does not zoom");
  assert.equal(level(), 0.12, "from a fit below 20 % a step out stays put");
  press("+", "NumpadAdd", { ctrlKey: true });
  assert.equal(level(), 0.2, "a step in goes to 20 %");
  press("0", "Digit0", { ctrlKey: true });
  assert.equal(level(), 1, "Ctrl+0: 100 %");
  press("=", "Equal", { metaKey: true });
  assert.equal(level(), 1.349, "one step in, to the guide's 135 %, once");
  press("-", "Minus", { metaKey: true });
  assert.equal(level(), 1, "and one step out");
  assert.deepEqual(own, [], "diagram-js's own zoom never acts");
  press("=", "Equal", { ctrlKey: true, isComposing: true });
  assert.equal(level(), 1, "an IME composition keeps the key");
  editor.destroy();
  assert.equal(press("=", "Equal", { ctrlKey: true }).defaultPrevented, false, "gone with the editor");
});

test("the widget's Value Chain engine: a zoom key on the focused canvas runs the chrome's deps first and prevents the key", async () => {
  const [spec, renderer] = await load("value-chain");
  const container = host(spec.canvasClassName);
  const ran: string[] = [];
  const engine = mountMiragonEngine(spec, renderer, container, false, {
    insets: () => ({ top: 56, right: 16, bottom: 56, left: 16 }),
    chromeKeys: { menuOpen: () => false, viewport: () => true, run: (key) => void ran.push(key) },
  });
  await engine.importText(DOCUMENT["value-chain"]![0]);
  const { svg, own, press } = await valueChainKeys(async () => ({ container, diagram: engine.modeler.diagram }));
  svg.focus();
  assert.equal(press("-", "Minus", { ctrlKey: true }).defaultPrevented, true);
  assert.equal(press("=", "Equal", { ctrlKey: true }).defaultPrevented, true);
  assert.equal(press("0", "Digit0", { metaKey: true }).defaultPrevented, true);
  assert.equal(press("!", "Digit1", { shiftKey: true }).defaultPrevented, true);
  assert.deepEqual(ran, ["zoomOut", "zoomIn", "zoomToActual", "fit"], "each press acts once");
  assert.deepEqual(own, [], "diagram-js's own zoom never acts");
  engine.destroy();
});

test("the SPA's fit: 24px clear of the measured palette, the sides, the bottom and an open side panel", async () => {
  const { spaFitInsets } = await import("../src/notations/miragon/editor.ts");
  assert.deepEqual(spaFitInsets({ paletteBottom: 64, coveredRight: 0 }), { top: 88, right: 24, bottom: 24, left: 24 });
  assert.deepEqual(
    spaFitInsets({ paletteBottom: 52, coveredRight: 320 }),
    { top: 76, right: 344, bottom: 24, left: 24 },
    "one row of palette, no zoom row below, the panel's width kept clear",
  );
});

test("the SPA's Miragon editors: a side panel opening re-fits a view nobody moved beside it, ⇧1 fits beside it, a moved view stays", async () => {
  const { editor, modeler, panels } = await editorOf("wardley");
  const { spaFitInsets } = await import("../src/notations/miragon/editor.ts");
  const canvas = modeler.diagram.get("canvas") as { viewbox(): { x: number; scale: number } };
  const scale = (): number => Math.round(canvas.viewbox().scale * 1000) / 1000;
  const fitBeside = (coveredRight: number): number => {
    const fitted = fitViewbox(
      modeler.contentBounds!()!,
      { width: 1000, height: 640 },
      spaFitInsets({ paletteBottom: 0, coveredRight }),
    );
    assert.ok(fitted);
    return Math.round(fitted.scale * 1000) / 1000;
  };
  const press = (key: string, code: string, mods: Partial<KeyboardEventInit>) =>
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods }));

  press("=", "Equal", { ctrlKey: true });
  const moved = scale();
  panels.set(320);
  assert.equal(scale(), moved, "a view the user moved since the import stays where it is (guide §5.9)");
  press("!", "Digit1", { shiftKey: true });
  assert.equal(scale(), fitBeside(320), "⇧1 fits left of the open panel");
  panels.set(0);
  assert.equal(scale(), fitBeside(0), "the fitted view re-fits over the whole canvas once it closes");
  panels.set(320);
  assert.equal(scale(), fitBeside(320), "and left of the panel as it opens again");
  editor.destroy();
  assert.equal(panels.listening(), 0, "the editor stops listening with its destroy");

  const fresh = await editorOf("wardley");
  const freshCanvas = fresh.modeler.diagram.get("canvas") as { viewbox(): { scale: number } };
  fresh.panels.set(320);
  const fittedFresh = fitViewbox(
    fresh.modeler.contentBounds!()!,
    { width: 1000, height: 640 },
    spaFitInsets({ paletteBottom: 0, coveredRight: 320 }),
  );
  assert.equal(
    Math.round(freshCanvas.viewbox().scale * 1000) / 1000,
    Math.round(fittedFresh!.scale * 1000) / 1000,
    "the view the import left, nobody moved, re-fits left of the panel",
  );
  fresh.editor.destroy();
});
