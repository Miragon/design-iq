/**
 * What the widget's view math keeps of its own (spec §2.5). The fit into the
 * frame minus the chrome's insets, the "untouched" test, the animated re-fit
 * and the readout come from @miragon/modeler-shell/core (`fitViewbox`,
 * `sameView`, `interpolateViewbox`, `easeStandard`, `zoomReadout`), the same
 * math the Miragon modelers' own shell runs. The −/+ buttons and keys step on
 * the guide's fixed zoom steps (§5.8), the raster diagram-js's
 * `zoomScroll.stepZoom` walks, as the shell's zoom panel does; the shell keeps
 * that function private, so `zoomStepLevel` computes the step here and
 * `zoomAround` applies it around the frame's centre.
 * A diagram-js viewbox is the visible area in diagram coordinates:
 * scale = outer.width / box.width.
 * Pure — engines/diagram-js.ts applies it to a canvas, node --test pins it.
 */
import { ZOOM_MAX, ZOOM_MIN } from "@miragon/modeler-shell/core";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

/** the scale a viewbox shows the frame at */
export const scaleOf = (viewbox: Box, outer: Size): number => outer.width / viewbox.width;

/** the viewbox at `level` (1 = 100 %) that keeps the diagram point under the
 *  screen `point` (px, relative to the frame) where it is */
export function zoomAround(viewbox: Box, outer: Size, level: number, point: Point): Box {
  const scale = scaleOf(viewbox, outer);
  const fixed = { x: viewbox.x + point.x / scale, y: viewbox.y + point.y / scale };
  return {
    x: fixed.x - point.x / level,
    y: fixed.y - point.y / level,
    width: outer.width / level,
    height: outer.height / level,
  };
}

/** the width of one zoom step in log10: ten steps from 20 to 400 %, the
 *  RANGE and NUM_STEPS of diagram-js's ZoomScroll */
const RASTER = Math.log10(ZOOM_MAX / ZOOM_MIN) / 10;

/** the level one −/+ step leads to (guide §5.8): one step on from the nearest
 *  full step of 22, 30, 41, 55, 74, 100, 135, 182, 246 and 331 %, clamped to
 *  20 … 400 % — the arithmetic of diagram-js's `zoomScroll.stepZoom` */
export function zoomStepLevel(level: number, direction: 1 | -1): number {
  const next = 10 ** (Math.round(Math.log10(level) / RASTER) * RASTER + RASTER * direction);
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
}
