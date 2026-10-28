/**
 * The −/+ step of every diagram-js view designIQ mounts, on real canvases
 * (under jsdom, test/renderer-dom.ts): the widget engines of the Miragon
 * renderers, of bpmn-js and of the DMN DRD step exactly as diagram-js's own
 * `zoomScroll.stepZoom` does, the step of the Miragon modelers' own zoom
 * panel: the guide's fixed zoom steps (§5.8). The zoom keys step through the
 * same view: the SPA's Miragon editors (miragon-menus.test.ts presses their
 * keys), and bpmn-js and the DMN DRD in both hosts
 * (canvas-zoom-keys-dom.test.ts), where `zoomScroll.stepZoom` no longer acts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import { newCmJson, newOwmText, newStormText, newTtJson } from "@designiq/notations/templates";

import type { Insets, ViewControls } from "../src/mcp-app/core/engine.ts";
import { mountMiragonEngine } from "../src/mcp-app/engines/miragon.ts";
import { MIRAGON_RENDERERS } from "../src/notations/miragon/index.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

// bpmn-js asks a 2D canvas for nothing it needs here; jsdom has none and logs each call
(HTMLCanvasElement.prototype as unknown as { getContext(): null }).getContext = () => null;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const insets = (): Insets => ({ top: 56, right: 16, bottom: 56, left: 16 });
const model = (name: string): string =>
  readFileSync(new URL(`../../../process-documentation/processes/${name}`, import.meta.url), "utf8");

interface Diagram {
  get(service: string): unknown;
}
interface Canvas {
  zoom(level?: number, center?: unknown): number;
  viewbox(): { outer: { width: number; height: number } };
  viewbox(box: { x: number; y: number; width: number; height: number }): void;
}
type Steps = Array<[start: number, zoomIn: number, zoomOut: number]>;

/** levels as diagram-js reads them back: the limits, the guide's full steps,
 *  the wheel's half steps between them and a fit's odd level */
const STARTS = [0.2, 0.224, 0.26, 0.302, 0.37, 0.56, 0.638, 0.741, 0.861, 0.95, 1, 1.16, 1.349, 2.2, 3.314, 3.9, 4];

/** from each start, the level one step in and one step out lead to */
function walk(canvas: Canvas, step: (direction: 1 | -1) => number): Steps {
  return STARTS.map((start) => {
    const [zoomIn, zoomOut] = ([1, -1] as const).map((direction) => {
      // a viewbox write, not canvas.zoom(start): jsdom keeps no CTM
      // (renderer-dom.ts), so only a viewbox write moves what the canvas reads
      const { outer } = canvas.viewbox();
      canvas.viewbox({ x: 0, y: 0, width: outer.width / start, height: outer.height / start });
      return step(direction);
    });
    return [start, zoomIn!, zoomOut!];
  });
}

/** the view's step against diagram-js's own on the same canvas: the level
 *  zoomScroll.stepZoom hands canvas.zoom, to three decimals as the canvas
 *  reads it back */
function bothSteps(view: ViewControls, diagram: Diagram): { view: Steps; zoomScroll: Steps } {
  const canvas = diagram.get("canvas") as Canvas;
  const zoomScroll = diagram.get("zoomScroll") as { stepZoom(direction: number): void };
  const byView = walk(canvas, (direction) => {
    view.stepZoom(direction);
    return canvas.zoom();
  });
  const zoom = canvas.zoom;
  let set = Number.NaN;
  canvas.zoom = (level, center) => {
    if (level !== undefined) set = level;
    return zoom.call(canvas, level, center);
  };
  try {
    const byZoomScroll = walk(canvas, (direction) => {
      set = Number.NaN;
      zoomScroll.stepZoom(direction);
      return Math.round(set * 1000) / 1000;
    });
    return { view: byView, zoomScroll: byZoomScroll };
  } finally {
    canvas.zoom = zoom;
  }
}

/** one start's row of a walk */
const row = (steps: Steps, start: number) => steps.find(([level]) => level === start);

const DOCUMENTS: Record<string, string> = {
  wardley: newOwmText("map", "Platform Map"),
  "event-storming": newStormText("board", "Order Checkout"),
  "context-map": newCmJson("map", "Conference Planner"),
  "team-topology": newTtJson("teams", "Team Landscape"),
};

test("every Miragon renderer in the widget: − and + step as diagram-js's zoomScroll does, 100 % to 135 % and 74 %", async () => {
  assert.deepEqual(MIRAGON_RENDERERS.map((spec) => spec.id).sort(), Object.keys(DOCUMENTS).sort());
  for (const spec of MIRAGON_RENDERERS) {
    const engine = mountMiragonEngine(spec, await spec.load(), host(spec.canvasClassName), false, { insets });
    await engine.importText(DOCUMENTS[spec.id]!);
    const steps = bothSteps(engine.view, engine.modeler.diagram);
    assert.deepEqual(steps.view, steps.zoomScroll, spec.id);
    assert.deepEqual(row(steps.view, 1), [1, 1.349, 0.741], spec.id);
    engine.destroy();
  }
});

test("bpmn-js in the widget: − and + step as its zoomScroll does", async () => {
  const { mountBpmnEngine } = await import("../src/mcp-app/engines/bpmn.ts");
  const engine = mountBpmnEngine(host("bpmn-canvas"), false, { insets });
  await engine.importText(model("order-to-cash.bpmn"));
  const steps = bothSteps(engine.view, engine.raw as unknown as Diagram);
  assert.deepEqual(steps.view, steps.zoomScroll);
  assert.deepEqual(row(steps.view, 0.95), [0.95, 1.349, 0.741], "95 % after a fit");
  engine.destroy();
});

test("the DMN DRD in the widget: − and + step as its zoomScroll does", async () => {
  const { default: DmnModeler } = await import("dmn-js/lib/Modeler");
  const { mountDmnEngine } = await import("../src/mcp-app/engines/dmn.ts");
  // the engine keeps its dmn-js instance to itself; its import names it
  type Modeler = InstanceType<typeof DmnModeler>;
  const modelers: Modeler[] = [];
  const importXML = DmnModeler.prototype.importXML;
  DmnModeler.prototype.importXML = function (this: Modeler, xml: string) {
    modelers.push(this);
    return importXML.call(this, xml);
  };
  try {
    const engine = mountDmnEngine(host("dmn-canvas"), false, { insets });
    await engine.importText(model("credit-limit-check.dmn"));
    await wait(0);
    assert.equal(engine.view.hasViewport(), true, "the DRD is the active view");
    const drd = modelers[0]?.getActiveViewer();
    assert.ok(drd);
    const steps = bothSteps(engine.view, drd);
    assert.deepEqual(steps.view, steps.zoomScroll);
    assert.deepEqual(row(steps.view, 0.861), [0.861, 1.349, 0.741], "the wheel's 86 %");
    engine.destroy();
  } finally {
    DmnModeler.prototype.importXML = importXML;
  }
});
