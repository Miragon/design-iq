/**
 * fitDiagram (model-sync.ts): the first view of a bpmn-js or DRD canvas, edge to edge as
 * diagram-js fits it, or inside the free area a host names (SyncOptions.fitInsets). And
 * keepDiagramViewbox, bpmn-js's view recipe around it: the first import fits, into the
 * insets read when the fit runs; a re-import puts the view back and never reads them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type FitCanvas, fitDiagram, type FitInsets, keepDiagramViewbox } from "../src/model-sync.ts";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
function canvas(inner: Box | undefined, outer: { width: number; height: number }) {
  const calls: Array<Box | "fit-viewport"> = [];
  const fake: FitCanvas = {
    viewbox(box?: Box | false) {
      if (box) calls.push(box);
      return { x: 0, y: 0, width: outer.width, height: outer.height, ...(inner ? { inner } : {}), outer };
    },
    zoom(mode) {
      calls.push(mode);
      return 1;
    },
  } as FitCanvas;
  return { fake, calls };
}

test("without insets, or with insets that are all zero, it is diagram-js's own fit", () => {
  for (const insets of [undefined, { top: 0, right: 0, bottom: 0, left: 0 }]) {
    const { fake, calls } = canvas({ x: 100, y: 50, width: 2000, height: 1000 }, { width: 800, height: 500 });
    fitDiagram(fake, insets);
    assert.deepEqual(calls, ["fit-viewport"]);
  }
});

test("with insets the diagram is scaled into what they leave free, its corner at the free area's", () => {
  const { fake, calls } = canvas({ x: 100, y: 50, width: 2000, height: 1000 }, { width: 800, height: 500 });
  fitDiagram(fake, { top: 20, right: 10, bottom: 30, left: 110 });
  // free: 680 x 450; scale = min(1, 0.34, 0.45) = 0.34
  const [box] = calls;
  assert.ok(box && box !== "fit-viewport");
  const scale = 800 / box.width;
  assert.ok(Math.abs(scale - 0.34) < 1e-9);
  // the diagram's left edge lies 110 px from the canvas's, its top 20 px
  assert.ok(Math.abs((100 - box.x) * scale - 110) < 1e-9);
  assert.ok(Math.abs((50 - box.y) * scale - 20) < 1e-9);
  // and it ends inside the free area on the limiting axis: 110 + 2000 * 0.34 = 790 = 800 - 10
  assert.ok(Math.abs((100 + 2000 - box.x) * scale - 790) < 1e-9);
  assert.equal(calls.length, 1);
});

test("a diagram smaller than the free area is not zoomed in", () => {
  const { fake, calls } = canvas({ x: 0, y: 0, width: 200, height: 100 }, { width: 800, height: 500 });
  fitDiagram(fake, { top: 12, right: 12, bottom: 12, left: 100 });
  assert.deepEqual(calls, [{ x: -100, y: -12, width: 800, height: 500 }]);
});

test("insets that leave nothing free, a canvas without content and values that are no px fall back to the plain fit", () => {
  const cases: Array<[Box | undefined, Parameters<typeof fitDiagram>[1]]> = [
    [
      { x: 0, y: 0, width: 200, height: 100 },
      { top: 0, right: 500, bottom: 0, left: 400 },
    ],
    [
      { x: 0, y: 0, width: 0, height: 0 },
      { top: 12, right: 12, bottom: 12, left: 12 },
    ],
    [undefined, { top: 12, right: 12, bottom: 12, left: 12 }],
    [
      { x: 0, y: 0, width: 200, height: 100 },
      { top: Number.NaN, right: -5, bottom: 0, left: Number.POSITIVE_INFINITY },
    ],
  ];
  for (const [inner, insets] of cases) {
    const { fake, calls } = canvas(inner, { width: 800, height: 500 });
    fitDiagram(fake, insets);
    assert.deepEqual(calls, ["fit-viewport"], JSON.stringify(insets));
  }
});

/** a modeler whose canvas keeps the viewbox it is given, its content box fixed */
function viewboxModeler() {
  const calls: Array<Box | "fit-viewport"> = [];
  let view: Box = { x: 0, y: 0, width: 800, height: 500 };
  const canvasOf = {
    viewbox(box?: Box | false) {
      if (box) {
        calls.push(box);
        view = box;
      }
      return { ...view, inner: { x: 100, y: 50, width: 2000, height: 1000 }, outer: { width: 800, height: 500 } };
    },
    zoom(mode: "fit-viewport") {
      calls.push(mode);
      return 1;
    },
  };
  return { modeler: { get: () => canvasOf }, calls };
}

test("keepDiagramViewbox: the first import fits into the insets, read when the fit runs, not when the recipe is made", () => {
  const { modeler, calls } = viewboxModeler();
  let insets: FitInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  let reads = 0;
  const beforeImport = keepDiagramViewbox(modeler, () => {
    reads++;
    return insets;
  });
  const restore = beforeImport(true);
  assert.equal(reads, 0, "nothing is read before the import ran");
  // the host's chrome is laid out by the time the import is drawn
  insets = { top: 20, right: 10, bottom: 30, left: 110 };
  restore();
  assert.equal(reads, 1);
  const [box] = calls;
  assert.ok(box && box !== "fit-viewport", "a fit into the free area, not diagram-js's own");
  assert.ok(Math.abs(800 / box.width - 0.34) < 1e-9);
});

test("keepDiagramViewbox: a re-import puts the view back and never reads the insets", () => {
  const { modeler, calls } = viewboxModeler();
  let reads = 0;
  const beforeImport = keepDiagramViewbox(modeler, () => {
    reads++;
    return { top: 20, right: 10, bottom: 30, left: 110 };
  });
  beforeImport(true)();
  const fitted = calls.at(-1);
  calls.length = 0;
  reads = 0;
  // the user pans; a peer's change re-imports
  modeler.get().viewbox({ x: 7, y: 8, width: 400, height: 250 });
  calls.length = 0;
  beforeImport(false)();
  // diagram-js hands back what viewbox() read, its content and container boxes included
  const [restored] = calls;
  assert.equal(calls.length, 1);
  assert.ok(restored && restored !== "fit-viewport", "the view put back, no fit");
  assert.deepEqual([restored.x, restored.y, restored.width, restored.height], [7, 8, 400, 250]);
  assert.equal(reads, 0);
  assert.notDeepEqual(fitted, calls[0]);
});

test("keepDiagramViewbox: without insets the first import is exactly diagram-js's fit-viewport", () => {
  const { modeler, calls } = viewboxModeler();
  keepDiagramViewbox(modeler)(true)();
  assert.deepEqual(calls, ["fit-viewport"]);
});
