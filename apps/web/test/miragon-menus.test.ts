/**
 * What the Miragon renderers bring to designIQ's chrome, for real (under
 * jsdom, test/renderer-dom.ts), through the specs both hosts mount them with:
 * their own menu content (Wardley mapMenu, Event Storming boardMenu, Context
 * Maps contextMapMenu) in the widget engine and the SPA editor, the dialogs
 * and popovers it opens inside the mount's host, the edits they make (one
 * undoable step each), the exports a host hands to the user, the document
 * title as the menu header's display name, and the zoom keys and ⇧1 of the
 * SPA's editors on a real canvas.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

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
const DOCUMENT: Record<string, [text: string, title: string]> = {
  wardley: [MAP, "Tea Shop"],
  "event-storming": [BOARD, "Checkout"],
  "context-map": [CONTEXT_MAP, "Conference"],
  "team-topology": [TEAMS, "Online Shop"],
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
  // the JSON is the model's file itself, and no package writes CML
  "context-map": { model: ["map-title"], export: ["export-png", "export-svg"], help: ["keyboard-shortcuts"] },
};

test("each renderer's own entries reach both hosts as its package names them; Team Topologies brings none", async () => {
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
  const teams = await widgetOf("team-topology");
  assert.equal(teams.engine.menu, undefined, "team-topologies-renderer 0.12 ships no menu content");
  teams.engine.destroy();
  const spaTeams = await editorOf("team-topology");
  assert.equal(spaTeams.editor.menu, undefined);
  spaTeams.editor.destroy();
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

test("Map title…: the dialog writes the title as one undoable step, and the menu header names it", async () => {
  for (const id of ["wardley", "context-map"]) {
    const { engine, container } = await widgetOf(id);
    let dirty = 0;
    engine.onDirty(() => dirty++);
    assert.equal(engine.displayName?.(), DOCUMENT[id]![1]);
    runModelerItem(engine.menu!, "modeler:map-title");
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

test("a read-only viewer: Type captions, Export and Help stay usable, the entries that write the document do not", async () => {
  const { engine } = await widgetOf("event-storming", true);
  const items = buildMenu({
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
    modeler: engine.menu!,
  }).flatMap((g) => g.items);
  assert.deepEqual(
    items.filter((i) => i.disabled).map((i) => i.id),
    ["modeler:level:big-picture", "modeler:level:process", "modeler:level:design"],
  );
  engine.destroy();
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

test("displayName: a map or board without a title line has none, not the parser's placeholder", async () => {
  const untitled: Record<string, string> = {
    wardley: MAP.replace(/^title .*\n/, ""),
    "event-storming": BOARD.replace(/^title .*\n/, ""),
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
  assert.equal(scale(), Math.round(2 ** 0.2 * 1000) / 1000, "Ctrl+= one step in, as the widget's +");
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
