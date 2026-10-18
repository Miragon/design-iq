/**
 * The split view's divider as numbers (src/lib/split-ratio.ts): where it may
 * sit (neither pane under 20rem), where a pointer puts it, what a drag and a
 * plain click do, and where the window splitter keys move it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampRatio,
  DEFAULT_RATIO,
  dragDivider,
  KEY_STEP,
  MIN_PANE_REM,
  percent,
  pressDivider,
  ratioAt,
  ratioBounds,
  ratioForKey,
} from "../src/lib/split-ratio.ts";

const REM = 16;
const near = (actual: number | undefined, expected: number, message?: string): void =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, message ?? `${actual} ≉ ${expected}`);

test("neither pane gets narrower than 20rem", () => {
  assert.equal(MIN_PANE_REM, 20);
  const bounds = ratioBounds(1600, REM);
  near(bounds.min, 320 / 1600);
  near(bounds.max, 1 - 320 / 1600);
});

test("without room for two panes of the minimum, or unmeasured, the divider sits in the middle", () => {
  for (const width of [640, 500, 0, Number.NaN]) {
    assert.deepEqual(ratioBounds(width, REM), { min: DEFAULT_RATIO, max: DEFAULT_RATIO }, String(width));
  }
});

test("a ratio is clamped to the bounds; a ratio that is no number lands in the middle", () => {
  const bounds = ratioBounds(1000, REM); // 0.32 .. 0.68
  near(clampRatio(0.1, bounds), 0.32);
  near(clampRatio(0.9, bounds), 0.68);
  near(clampRatio(0.4, bounds), 0.4);
  near(clampRatio(Number.NaN, bounds), 0.5);
  near(clampRatio(Number.POSITIVE_INFINITY, bounds), 0.5);
});

test("the pointer's ratio is its share of the editor from the editor's left edge", () => {
  near(ratioAt(300, 100, 800), 0.25);
  near(ratioAt(100, 100, 800), 0);
  near(ratioAt(1000, 100, 800), 1.125, "not clamped here");
  near(ratioAt(300, 100, 0), DEFAULT_RATIO, "an editor without width");
});

test("a click on the divider without a move gives no ratio: the clamped one is never stored over the chosen one", () => {
  // 0.25 was chosen on a wide screen; this editor is 1000px wide (0.32 .. 0.68), 0.32 shows
  const bounds = ratioBounds(1000, REM);
  const press = pressDivider(323, 1000, clampRatio(0.25, bounds));
  const [still, ratio] = dragDivider(press, 323, bounds);
  assert.equal(ratio, undefined);
  assert.equal(still.moved, false);
});

test("a drag moves the divider by the pointer's way from where it grabbed it, back to the start included", () => {
  const bounds = ratioBounds(1000, REM);
  // grabbed 3px right of the divider's centre: no jump to the pointer
  const press = pressDivider(503, 1000, 0.5);
  const [moved, ratio] = dragDivider(press, 603, bounds);
  near(ratio, 0.6);
  assert.equal(moved.moved, true);
  near(dragDivider(moved, 503, bounds)[1], 0.5, "moved away and back: still a drag, ending where it started");
  near(dragDivider(moved, 2000, bounds)[1], 0.68, "clamped");
});

test("the arrow keys move the divider by a step, Home and End to either end, other keys not at all", () => {
  const bounds = ratioBounds(1600, REM); // 0.2 .. 0.8
  near(ratioForKey("ArrowLeft", 0.5, bounds), 0.5 - KEY_STEP);
  near(ratioForKey("ArrowRight", 0.5, bounds), 0.5 + KEY_STEP);
  near(ratioForKey("ArrowLeft", 0.22, bounds), 0.2, "a step stops at the bound");
  near(ratioForKey("ArrowRight", 0.79, bounds), 0.8);
  near(ratioForKey("Home", 0.5, bounds), 0.2);
  near(ratioForKey("End", 0.5, bounds), 0.8);
  for (const key of ["ArrowUp", "ArrowDown", "Enter", "a", "Tab"]) {
    assert.equal(ratioForKey(key, 0.5, bounds), undefined, key);
  }
});

test("the divider announces whole percent", () => {
  assert.equal(percent(0.5), 50);
  assert.equal(percent(0.2), 20);
  assert.equal(percent(0.5 + KEY_STEP), 55);
  assert.equal(percent(1 / 3), 33);
});
