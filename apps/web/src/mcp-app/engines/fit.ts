/**
 * Fit and zoom as pure viewbox math (spec §2.5) — the import-time
 * `fit-viewport` cannot leave room for floating chrome, so the widget fits the
 * content bbox into the frame MINUS insets (the corner row, the left palette,
 * an open card, the bottom row), never above 100 %. A diagram-js viewbox is
 * the visible area in diagram coordinates: scale = outer.width / box.width.
 *
 * Also: "untouched" detection (auto-fit until the user moved the view), the
 * zoom around a fixed screen point, and the rAF interpolation of the animated
 * re-fit (250 ms, --cd-ease; a jump under reduced motion — the caller decides).
 * Pure — engines/diagram-js.ts applies it to a canvas, node --test pins it.
 */
import type { Insets } from "../core/engine.ts";

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

/** below this the inner rect is degenerate (a tiny frame) — fit into 1px, never divide by 0 */
const MIN_INNER = 1;

/**
 * The viewbox that shows `bbox` centred in the frame's inner rect (outer minus
 * insets) at the largest scale ≤ maxScale. The box spans the WHOLE frame, so
 * the content lands inside the insets, not at the frame's edge. An empty bbox
 * centres its origin at maxScale.
 */
export function fitViewbox(bbox: Box, outer: Size, insets: Insets, maxScale = 1): Box {
  const innerW = Math.max(MIN_INNER, outer.width - insets.left - insets.right);
  const innerH = Math.max(MIN_INNER, outer.height - insets.top - insets.bottom);
  const scale =
    bbox.width > 0 && bbox.height > 0
      ? Math.min(innerW / bbox.width, innerH / bbox.height, maxScale)
      : bbox.width > 0
        ? Math.min(innerW / bbox.width, maxScale)
        : bbox.height > 0
          ? Math.min(innerH / bbox.height, maxScale)
          : maxScale;
  const offsetX = insets.left + (innerW - bbox.width * scale) / 2;
  const offsetY = insets.top + (innerH - bbox.height * scale) / 2;
  return {
    x: bbox.x - offsetX / scale,
    y: bbox.y - offsetY / scale,
    width: outer.width / scale,
    height: outer.height / scale,
  };
}

/** the scale a viewbox shows the frame at */
export const scaleOf = (viewbox: Box, outer: Size): number => outer.width / viewbox.width;

/**
 * True while the view still is the last fit — any viewbox change NOT caused
 * by a fit (scroll, wheel zoom, a keyboard zoom) marks it touched. `eps` is in
 * diagram units for x/y and relative for the size (diagram-js rounds the
 * transform to 1/1000).
 */
export function isUntouched(current: Box, lastFit: Box | undefined, eps = 1): boolean {
  if (!lastFit) return false;
  const rel = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(eps, Math.abs(b) * 1e-3);
  return (
    rel(current.x, lastFit.x) &&
    rel(current.y, lastFit.y) &&
    rel(current.width, lastFit.width) &&
    rel(current.height, lastFit.height)
  );
}

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

/** the zoom group's −/+ step: multiplicative, so in and out are symmetric
 *  (zoomBy(+0.2) then zoomBy(−0.2) returns to the start) */
export function steppedLevel(level: number, step: number, min = 0.2, max = 4): number {
  const next = level * Math.exp(step * Math.LN2);
  return Math.min(max, Math.max(min, next));
}

/** "56%" — the readout the zoom group shows and speaks */
export const zoomPercent = (level: number): string => `${Math.round(level * 100)}%`;

export function lerpBox(from: Box, to: Box, t: number): Box {
  const lerp = (a: number, b: number): number => a + (b - a) * t;
  return {
    x: lerp(from.x, to.x),
    y: lerp(from.y, to.y),
    width: lerp(from.width, to.width),
    height: lerp(from.height, to.height),
  };
}

/** a CSS cubic-bezier(x1, y1, x2, y2) as a function of time (0…1) — so the
 *  rAF re-fit eases exactly like --cd-ease */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bez = (a: number, b: number, t: number): number => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
  const slope = (a: number, b: number, t: number): number =>
    3 * a * (1 - t) ** 2 + 6 * (b - a) * (1 - t) * t + 3 * (1 - b) * t ** 2;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton on x(t) = x, bisection when the slope flattens
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = bez(x1, x2, t) - x;
      if (Math.abs(err) < 1e-6) return bez(y1, y2, t);
      const d = slope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = bez(x1, x2, t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return bez(y1, y2, t);
  };
}

/** `cubic-bezier(0.4, 0, 0.2, 1)` (the --cd-ease value) → its easing; a
 *  missing or unparsable token falls back to that very curve */
export function parseCubicBezier(css: string | undefined): (t: number) => number {
  const m = /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(css ?? "");
  const [x1, y1, x2, y2] = m ? m.slice(1).map(Number) : [0.4, 0, 0.2, 1];
  return cubicBezier(x1!, y1!, x2!, y2!);
}

/** the zoom group's readout and limits: "56%", its accessible name, and
 *  whether − / + can still move (a clamped step is a dead button) */
export function zoomReadout(
  level: number,
  min: number,
  max: number,
): { text: string; label: string; canOut: boolean; canIn: boolean } {
  const text = zoomPercent(level);
  return { text, label: `Zoom ${text} — reset to 100%`, canOut: level > min * 1.001, canIn: level < max * 0.999 };
}
