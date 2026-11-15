/**
 * fitDiagram (model-sync.ts): the first view of a bpmn-js or DRD canvas, edge to edge as
 * diagram-js fits it, or inside the free area a host names (SyncOptions.fitInsets).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type FitCanvas, fitDiagram } from "../src/model-sync.ts";

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
