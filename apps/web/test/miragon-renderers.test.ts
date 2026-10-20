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

test("the read-only viewers import without a command stack: Event Storming and Wardley need no shim", async () => {
  const boards: Array<[id: string, text: string]> = [
    ["wardley", MAP],
    ["event-storming", BOARD],
  ];
  for (const [id, text] of boards) {
    const engine = mountMiragonEngine(await load(id), host(), true);
    assert.throws(() => engine.raw.get("commandStack"), /No provider for "commandStack"/, id);
    await engine.importText(text);
    await engine.importText(text);
    engine.destroy();
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
