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

import { mountMiragonEngine } from "../src/mcp-app/engines/miragon.ts";
import { MIRAGON_RENDERERS } from "../src/notations/miragon/index.ts";
import type { LoadedMiragonRenderer } from "../src/notations/miragon/spec.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

async function load(id: string): Promise<LoadedMiragonRenderer> {
  const spec = MIRAGON_RENDERERS.find((s) => s.id === id);
  assert.ok(spec, id);
  return spec.load();
}

const MAP =
  "title Tea Shop\ncomponent Cup of Tea [0.79, 0.61]\ncomponent Hot Water [0.82, 0.45]\nCup of Tea->Hot Water\n";

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
    ["event-storming", "title Checkout\ncommand Place Order [240, 300]\nevent Order Placed [620, 300]\n"],
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
