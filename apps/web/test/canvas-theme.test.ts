/**
 * The CI canvas options (src/lib/canvas-theme.ts) and the sticky palette
 * (src/notations/bpmn-sticky/sticky-model.ts): what an exported diagram
 * carries must be literal CI colours, a user's element colours must keep
 * winning over the defaults, the DRD theme must not cost the simulation
 * add-on its modules, and every sticky kind must stay legible and distinct.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALIASES, FONT_SANS, parseColor } from "@designiq/ui-kit/lib/tokens";

import {
  BPMN_CANVAS_OPTIONS,
  canvasFontReady,
  DRD_CANVAS_OPTIONS,
  withDrdCanvasTheme,
} from "../src/lib/canvas-theme.ts";
import { dmnSimulationViews } from "../src/lib/dmn-simulation.ts";
import { STICKY_COLORS, STICKY_KINDS, STICKY_TEXT_COLOR } from "../src/notations/bpmn-sticky/sticky-model.ts";

const HEX = /^#[0-9a-f]{6}$/i;

/** WCAG 2.x contrast ratio of two opaque colours */
function contrast(a: string, b: string): number {
  const luminance = (colour: string): number => {
    const [r, g, b] = parseColor(colour).map((v) => v / 255) as [number, number, number];
    const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test("bpmn-js renders the CI canvas set as literal hex — an exported SVG needs no stylesheet", () => {
  const { bpmnRenderer, textRenderer } = BPMN_CANVAS_OPTIONS;
  assert.equal(bpmnRenderer.defaultFillColor, ALIASES["canvas-shape"]);
  assert.equal(bpmnRenderer.defaultStrokeColor, ALIASES["canvas-stroke"]);
  for (const colour of Object.values(bpmnRenderer)) assert.match(colour, HEX);
  assert.equal(textRenderer.defaultStyle.fontFamily, FONT_SANS);
  assert.equal(textRenderer.externalStyle.fontFamily, FONT_SANS);
});

test("bpmn-js gets NO label default: a user's element colour keeps colouring its label (#189)", () => {
  // bpmn-js resolves a label as DI label colour || defaultLabelColor || stroke —
  // a default would paint a red task's label black. Omitting it is lossless
  // only while the uncoloured label IS the stroke colour.
  assert.equal("defaultLabelColor" in BPMN_CANVAS_OPTIONS.bpmnRenderer, false);
  assert.equal(ALIASES["canvas-label"], ALIASES["canvas-stroke"]);
});

test("the DRD theme rides inside the drd view and keeps the simulation add-on's modules", () => {
  const views = withDrdCanvasTheme(dmnSimulationViews);
  // dmn-js hands each view only its own key — the renderer config must sit in `drd`
  assert.deepEqual(views.drd.drdRenderer, DRD_CANVAS_OPTIONS.drdRenderer);
  assert.equal(views.drd.textRenderer.defaultStyle.fontFamily, FONT_SANS);
  for (const colour of Object.values(views.drd.drdRenderer)) assert.match(colour, HEX);
  // the add-on is untouched, in both views
  assert.deepEqual(views.drd.additionalModules, dmnSimulationViews.drd.additionalModules);
  assert.equal(views.decisionTable, dmnSimulationViews.decisionTable);
  // and the input is not mutated (both hosts share the same object)
  assert.equal("drdRenderer" in dmnSimulationViews.drd, false);
});

test("an explicit drd option of the caller wins over the theme", () => {
  const own = { defaultFillColor: "#000000" };
  const views = withDrdCanvasTheme({ drd: { drdRenderer: own } });
  assert.equal(views.drd.drdRenderer, own);
  assert.deepEqual(views.drd.textRenderer, DRD_CANVAS_OPTIONS.textRenderer);
});

test("canvasFontReady is a no-op without a DOM", async () => {
  await canvasFontReady(10);
});

test("every sticky kind is legible and distinct on the CI palette", () => {
  const fills = new Set<string>();
  for (const kind of STICKY_KINDS) {
    const { fill, stroke } = STICKY_COLORS[kind];
    assert.match(fill, HEX, `${kind} fill`);
    assert.match(stroke, HEX, `${kind} stroke`);
    fills.add(fill.toLowerCase());
    // text ≥ 4.5:1 on the note, the outline ≥ 3:1 on the canvas and the note
    assert.ok(contrast(STICKY_TEXT_COLOR, fill) >= 4.5, `${kind}: text on fill`);
    assert.ok(contrast(stroke, ALIASES["canvas-background"]) >= 3, `${kind}: stroke on canvas`);
    assert.ok(contrast(stroke, fill) >= 3, `${kind}: stroke on fill`);
  }
  assert.equal(fills.size, STICKY_KINDS.length, "four kinds, four fills");
});
