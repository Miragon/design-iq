/**
 * The arm rules as pure functions: which zoom a node is armed at, where the board has to stand so
 * that the node is in the window, and how a transition runs between two viewports. No DOM, no
 * React Flow, no clock: board-arming.ts feeds them and moves the board. Node-loadable (type
 * stripping), tested in test/spike/arm-rules.test.ts.
 *
 * Three rules, each a URL parameter (samples.ts), each with a default per strategy:
 *
 *   armzoom    off | min1 | exact1   the board zoom a node is armed at
 *   armedzoom  free | disarm | lock  what a zoom of the board does while a node is armed
 *   armreturn  stay | back           whether Done and a pane click bring the board back
 *
 * `overlay` defaults to exact1, disarm, stay: a model is edited at board zoom exactly 1, the one
 * state every engine is built for. Its measured weaknesses lie below board zoom 1, in a board
 * zoom under an armed editor, and above zoom 1 for an HTML view, which keeps 100 % while its
 * preview is scaled by the board (README, sections 11 to 13). Detail zoom is the editor's own
 * zoom. Round 5 ran with min1 as the default; `&armzoom=min1` is that board. Every other strategy
 * defaults to off, free, stay, which is the board as it was before the rules. A parameter given
 * in the URL applies to every strategy.
 */
import {
  ARM_RETURNS,
  ARM_ZOOMS,
  type ArmAnchor,
  ARMED_ZOOMS,
  type ArmedZoom,
  type ArmReturn,
  type ArmZoom,
  type Box,
  type Strategy,
  type Viewport,
} from "./types.ts";

export interface Point {
  x: number;
  y: number;
}

/**
 * A board zoom this close to 1 counts as 1. A fit lands on values such as 0.9973 or 1.0004, and an
 * editor armed there differs from one armed at 1 in nothing a person chose: within 1 % an
 * 800 x 540 node is at most 8 x 5.4 px larger or smaller. But only at exactly 1 an HTML view (the
 * decision table keeps 100 % while its preview is scaled by the board) is its preview pixel for
 * pixel, and the host needs no snapping to device px. The smallest step a person makes on purpose
 * is far outside: 1.149 for one wheel notch, 1.2 for a toolbar step.
 */
export const ARM_ZOOM_TOLERANCE = 0.01;

/** px between the armed node and the edge of the box it is brought into: room for the selection ring and the resize handles */
export const ARM_MARGIN = 24;

/** a node that sticks out by less than this is in: a target is rounded to whole px, and a second look must not move it again */
const EDGE_SLACK = 0.5;

export interface ArmRuleSet {
  armzoom: ArmZoom;
  armedzoom: ArmedZoom;
  armreturn: ArmReturn;
}

/** what a node's strategy gives when the URL names no rule */
export function defaultRules(strategy: Strategy): ArmRuleSet {
  return strategy === "overlay"
    ? { armzoom: "exact1", armedzoom: "disarm", armreturn: "stay" }
    : { armzoom: "off", armedzoom: "free", armreturn: "stay" };
}

/** the rules of one node: each one from the URL when it is given there, else from the node's strategy */
export function resolveRules(strategy: Strategy, given: { [K in keyof ArmRuleSet]: ArmRuleSet[K] | null }): ArmRuleSet {
  const fallback = defaultRules(strategy);
  return {
    armzoom: given.armzoom ?? fallback.armzoom,
    armedzoom: given.armedzoom ?? fallback.armedzoom,
    armreturn: given.armreturn ?? fallback.armreturn,
  };
}

/** the board zoom the rule arms at, coming from `zoom` */
export function targetZoom(zoom: number, rule: ArmZoom, tolerance = ARM_ZOOM_TOLERANCE): number {
  if (rule === "off") return zoom;
  if (rule === "exact1") return 1;
  // min1: anything below 1 goes up to 1, and what is nearly 1 from above becomes exactly 1
  return zoom <= 1 + tolerance ? 1 : zoom;
}

export interface ArmPlacement {
  /** where the board stands */
  viewport: Viewport;
  /** the node's whole wrapper (header and body) in flow units, absolute */
  node: Box;
  /** what a node may use of the board, in px of the board's own box: the box without the toolbar's band */
  box: Box;
  /** px of the board's own box: the point that keeps its place while the zoom changes (the pointer, or the node's centre) */
  anchor: Point;
  /**
   * What the anchor is (default centre). It decides the axis on which the wrapper is longer than
   * the box, and it belongs to the ARMING, not to one look: a second look at a node the pointer
   * placed is taken with pointer again, whatever point it is given.
   */
  anchorKind?: ArmAnchor;
  rule: ArmZoom;
  margin?: number;
  tolerance?: number;
}

/**
 * The shift that brings the stretch [start, start + size] into [low, low + span].
 * A stretch that fits: the least shift that puts all of it inside.
 * A stretch longer than the span, by the kind of anchor:
 *   centre   its start goes to `low`, wherever it lies;
 *   pointer  the least shift that leaves no gap: a start beyond `low` goes to it, an end short of
 *            the span's end goes to that end, and a stretch that covers the span is not moved.
 */
function shiftInto(start: number, size: number, low: number, span: number, anchorKind: ArmAnchor): number {
  if (size > span) {
    if (anchorKind === "centre") return Math.abs(start - low) <= EDGE_SLACK ? 0 : low - start;
    if (start > low + EDGE_SLACK) return low - start;
    const short = low + span - (start + size);
    return short > EDGE_SLACK ? short : 0;
  }
  if (start < low - EDGE_SLACK) return low - start;
  const over = start + size - (low + span);
  return over > EDGE_SLACK ? -over : 0;
}

/**
 * The viewport the node is armed at. The rule's zoom is applied about the anchor, then the board
 * is shifted per axis, and the zoom is never lowered to make a node fit.
 *
 * An axis on which the wrapper fits the box minus the margin: the least shift that puts the whole
 * wrapper inside.
 *
 * An axis on which the wrapper is longer than that, by the kind of anchor:
 * - centre (Edit, the keyboard, the hook, the URL): its start goes to the margin, so that the
 *   header's left end and the palette are in reach.
 * - pointer (the double-click): the least shift that leaves no gap between the wrapper and the
 *   box's margins. A wrapper that covers the box on that axis is not moved, so the point a person
 *   double-clicked stays under the pointer. Round 5 measured the rule before it (the start always
 *   to the margin): the double-clicked point moved 647 to 1811 px, once out of the board (README,
 *   section 12). The header may then lie outside the board: the way out is the board's own Done
 *   control (toolbar.tsx), which is in reach wherever the node lies.
 *
 * `off` returns the viewport as it is (the same object): arming moves nothing. So does every
 * rule when nothing has to change. A viewport that does change is rounded to whole px, so that a
 * preview and its armed editor lie on the same px.
 */
export function armViewport(placement: ArmPlacement): Viewport {
  const { viewport, node, box, anchor, rule } = placement;
  if (rule === "off") return viewport;
  const margin = placement.margin ?? ARM_MARGIN;
  const anchorKind = placement.anchorKind ?? "centre";
  const zoom = targetZoom(viewport.zoom, rule, placement.tolerance);
  // the flow point under the anchor stays under it; no arithmetic when the zoom stays, so nothing drifts
  const zoomed =
    zoom === viewport.zoom
      ? { x: viewport.x, y: viewport.y }
      : {
          x: anchor.x - ((anchor.x - viewport.x) / viewport.zoom) * zoom,
          y: anchor.y - ((anchor.y - viewport.y) / viewport.zoom) * zoom,
        };
  const [low, span] = [
    { x: box.x + margin, y: box.y + margin },
    { x: box.width - 2 * margin, y: box.height - 2 * margin },
  ];
  const dx = shiftInto(zoomed.x + node.x * zoom, node.width * zoom, low.x, span.x, anchorKind);
  const dy = shiftInto(zoomed.y + node.y * zoom, node.height * zoom, low.y, span.y, anchorKind);
  if (zoom === viewport.zoom && dx === 0 && dy === 0) return viewport;
  return { x: Math.round(zoomed.x + dx), y: Math.round(zoomed.y + dy), zoom };
}

export const sameViewport = (a: Viewport, b: Viewport): boolean => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

/** the viewport at `t` of the way (0 to 1): linear in x, y and zoom, so a point that ends where it began never moves */
export function viewportBetween(from: Viewport, to: Viewport, t: number): Viewport {
  if (t <= 0) return from;
  if (t >= 1) return to;
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    zoom: from.zoom + (to.zoom - from.zoom) * t,
  };
}

/**
 * Whether a wheel event changes the board zoom, as d3-zoom decides it (the zoom is multiplied by
 * 2 ^ (-deltaY x a positive factor) and kept inside the board's range): a wheel with no vertical
 * part, or one that pushes against the end of the range, changes nothing and starts no gesture.
 */
export function wheelChangesZoom(zoom: number, deltaY: number, minZoom: number, maxZoom: number): boolean {
  if (deltaY < 0) return zoom < maxZoom;
  if (deltaY > 0) return zoom > minZoom;
  return false;
}

// ── motion, read from the design tokens ──────────────────────────────────────

/** a CSS time ("250ms", "0.25s", "0") in ms; null for anything else */
export function parseDuration(token: string): number | null {
  const match = /^\s*(\d*\.?\d+)\s*(ms|s)?\s*$/.exec(token);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return match[2] === "s" ? value * 1000 : value;
}

/** the timing function cubic-bezier(x1, y1, x2, y2) as CSS defines it: progress 0 to 1 in, eased value out */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const curve = (a: number, b: number, s: number): number =>
    3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // x is monotonic for x1 and x2 inside 0 to 1: bisect for the curve parameter at x = t
    let [low, high] = [0, 1];
    for (let round = 0; round < 40; round++) {
      const middle = (low + high) / 2;
      if (curve(x1, x2, middle) < t) low = middle;
      else high = middle;
    }
    return curve(y1, y2, (low + high) / 2);
  };
}

const linear = (t: number): number => Math.min(1, Math.max(0, t));

/** a CSS easing token as a function; anything but a cubic-bezier() with x inside 0 to 1 eases linearly */
export function parseEase(token: string): (t: number) => number {
  const match = /^\s*cubic-bezier\(\s*([^)]*)\)\s*$/.exec(token);
  if (!match) return linear;
  const parts = (match[1] ?? "").split(",").map((part) => Number(part.trim()));
  const [x1, y1, x2, y2] = parts;
  if (parts.length !== 4 || x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return linear;
  if (!parts.every(Number.isFinite) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return linear;
  return cubicBezier(x1, y1, x2, y2);
}

/** `&armmotion=<ms>`: a duration of 0 or more, null for anything else */
export function parseMotion(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** the arm rules as a URL gives them: null for a rule that is absent or misspelt, so the strategy's default holds */
export interface ArmParams {
  armzoom: ArmZoom | null;
  armedzoom: ArmedZoom | null;
  armreturn: ArmReturn | null;
  /** ms of a transition (0: at once); null: the design token, 0 under reduced motion */
  armmotion: number | null;
}

export function parseArmParams(params: URLSearchParams): ArmParams {
  const pick = <T extends string>(all: readonly T[], name: string): T | null =>
    all.find((one) => one === params.get(name)) ?? null;
  return {
    armzoom: pick(ARM_ZOOMS, "armzoom"),
    armedzoom: pick(ARMED_ZOOMS, "armedzoom"),
    armreturn: pick(ARM_RETURNS, "armreturn"),
    armmotion: parseMotion(params.get("armmotion")),
  };
}
