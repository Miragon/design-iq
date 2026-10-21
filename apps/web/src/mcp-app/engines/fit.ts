/**
 * What the widget's view math keeps of its own (spec §2.5). The fit into the
 * frame minus the chrome's insets, the "untouched" test, the animated re-fit
 * and the readout come from @miragon/modeler-shell/core (`fitViewbox`,
 * `sameView`, `interpolateViewbox`, `easeStandard`, `zoomReadout`), the same
 * math the Miragon modelers' own shell runs. designIQ keeps its zoom step:
 * the −/+ buttons and keys move by a multiplicative step around the frame's
 * centre, not along diagram-js's zoomScroll raster the shell steps on.
 * A diagram-js viewbox is the visible area in diagram coordinates:
 * scale = outer.width / box.width.
 * Pure — engines/diagram-js.ts applies it to a canvas, node --test pins it.
 */

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

/** the −/+ buttons' and the zoom keys' step (steppedLevel) */
export const ZOOM_STEP = 0.2;

/** the zoom group's −/+ step: multiplicative, so in and out are symmetric
 *  (zoomBy(+0.2) then zoomBy(−0.2) returns to the start) */
export function steppedLevel(level: number, step: number, min: number, max: number): number {
  const next = level * Math.exp(step * Math.LN2);
  return Math.min(max, Math.max(min, next));
}
