/**
 * The geometry both arrow kinds share: React Flow's bezier between two sides, and a head at the
 * target that points INTO the node. A bezier ends at right angles to the side it arrives at, so
 * the head's direction is the side's and needs no tangent.
 */
import { getBezierPath, Position } from "@xyflow/react";

export interface ArrowPoint {
  x: number;
  y: number;
  /** the side of the node this end sits on */
  position: Position;
}

/** pointing away from the node, per side */
const OUTWARD: Readonly<Record<Position, { x: number; y: number }>> = {
  [Position.Left]: { x: -1, y: 0 },
  [Position.Right]: { x: 1, y: 0 },
  [Position.Top]: { x: 0, y: -1 },
  [Position.Bottom]: { x: 0, y: 1 },
};

export const OPPOSITE: Readonly<Record<Position, Position>> = {
  [Position.Left]: Position.Right,
  [Position.Right]: Position.Left,
  [Position.Top]: Position.Bottom,
  [Position.Bottom]: Position.Top,
};

/** the point `distance` away from the node, straight out of the side the end sits on */
export function outward(end: ArrowPoint, distance: number): { x: number; y: number } {
  const direction = OUTWARD[end.position];
  return { x: end.x + direction.x * distance, y: end.y + direction.y * distance };
}

export interface ArrowShape {
  /** the line; it ends `inset` before the target, where a filled head begins */
  path: string;
  /** the middle of the line */
  labelX: number;
  labelY: number;
  /** the CSS transform that puts a label BESIDE that point, on the side the arrow does not head for */
  labelTransform: string;
  /** tip and the two corners of the head's base, as SVG points */
  head: { tip: string; left: string; right: string };
}

/** the head's length in board units; its base is 0.8 of that wide */
export const HEAD_LENGTH = 11;

export function arrowShape(source: ArrowPoint, target: ArrowPoint, inset: number): ArrowShape {
  const end = outward(target, inset);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: source.position,
    targetX: end.x,
    targetY: end.y,
    targetPosition: target.position,
  });
  const base = outward(target, HEAD_LENGTH);
  const out = OUTWARD[target.position];
  const half = HEAD_LENGTH * 0.4;
  // across the direction the head points in
  const corner = (sign: number): string => `${base.x - out.y * half * sign},${base.y + out.x * half * sign}`;
  // Beside the line, never on it: a label keeps a least size on screen (board.css), and on a
  // board zoomed out it would cover a short arrow whole. And on the side the arrow does NOT head
  // for, so that it never lies on the head: over a line that runs across (under it when the
  // target is higher up), right of a line that runs down (left when the target is further right).
  const gap = "calc(5px / var(--board-zoom, 1))";
  const [dx, dy] = [target.x - source.x, target.y - source.y];
  const labelTransform =
    Math.abs(dx) > Math.abs(dy)
      ? dy < 0
        ? `translate(-50%, 0) translate(${labelX}px, calc(${labelY}px + ${gap}))`
        : `translate(-50%, -100%) translate(${labelX}px, calc(${labelY}px - ${gap}))`
      : dx > 0
        ? `translate(-100%, -50%) translate(calc(${labelX}px - ${gap}), ${labelY}px)`
        : `translate(0, -50%) translate(calc(${labelX}px + ${gap}), ${labelY}px)`;
  return {
    path,
    labelX,
    labelY,
    labelTransform,
    head: { tip: `${target.x},${target.y}`, left: corner(1), right: corner(-1) },
  };
}

/**
 * The point `distance` along the line from its start (`fromEnd`: back from its end), at most
 * `most` of the line's length. For what sits ON the line near an end: the path React Flow returns
 * is one cubic bezier ("M x,y C x,y x,y x,y"), walked here in short chords.
 */
export function pointAlong(path: string, distance: number, fromEnd: boolean, most = 0.3): { x: number; y: number } {
  const n = (path.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  const [x0 = 0, y0 = 0, x1 = x0, y1 = y0, x2 = x1, y2 = y1, x3 = x2, y3 = y2] = fromEnd
    ? [n[6], n[7], n[4], n[5], n[2], n[3], n[0], n[1]]
    : n;
  const at = (t: number): { x: number; y: number } => {
    const u = 1 - t;
    return {
      x: u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      y: u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    };
  };
  const STEPS = 32;
  const points = Array.from({ length: STEPS + 1 }, (_, index) => at(index / STEPS));
  const chord = (index: number): number => {
    const [a, b] = [points[index - 1], points[index]];
    return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  };
  let length = 0;
  for (let index = 1; index <= STEPS; index++) length += chord(index);
  let left = Math.min(distance, length * most);
  for (let index = 1; index <= STEPS; index++) {
    const step = chord(index);
    if (left <= step && step > 0) return at((index - 1 + left / step) / STEPS);
    left -= step;
  }
  return at(most);
}
