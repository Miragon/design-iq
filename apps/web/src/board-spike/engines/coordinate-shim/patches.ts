/**
 * The global patches of the parts `rects`, `points`, `ctm` and `viewport`: each replaces ONE
 * function or getter on a prototype (or on the window) and is taken back exactly as it was.
 *
 * Every replacement starts with the same fast path: with no armed space it calls the function it
 * replaced and returns. With an armed space, a call for a node that is neither inside the host nor
 * one of its ancestors costs one `contains` walk and one set lookup on top.
 */
import type { Frame, Space } from "./space.ts";
import { caller, options, type Part, sample, spaceOf, spaces, stats, touch, windowCaller } from "./state.ts";

// ── conversions ──────────────────────────────────────────────────────────────

/** HTML boxes are laid out on a grid of 1/64 px: a document at scale 1 reports exactly such numbers */
const GRID = 64;
const onGrid = (value: number): number => Math.round(value * GRID) / GRID;

function virtualRect(rect: DOMRect, frame: Frame): DOMRect {
  const x = (rect.x - frame.ox) / frame.sx;
  const y = (rect.y - frame.oy) / frame.sy;
  const width = rect.width / frame.sx;
  const height = rect.height / frame.sy;
  return options.snap
    ? new DOMRect(onGrid(x), onGrid(y), onGrid(width), onGrid(height))
    : new DOMRect(x, y, width, height);
}

/** what `getClientRects` returns, as far as callers use it: indexable, iterable, `length`, `item()` */
class VirtualRectList extends Array<DOMRect> {
  item(index: number): DOMRect | null {
    return this[index] ?? null;
  }
}

function virtualRects(list: DOMRectList, frame: Frame): DOMRectList {
  const out = new VirtualRectList();
  for (const rect of list) out.push(virtualRect(rect, frame));
  return out as unknown as DOMRectList;
}

/**
 * The window as the armed editor sees it: from the virtual origin to where its fixed boxes stop
 * being visible, which is the true window's far edge or, sooner, the board's own clip (modifier
 * `clip`). Code that flips a popup compares `position + size` with a width and a height and takes
 * the origin for 0 (diagram-js `_ensureVisible`, Context Maps' prompt, CodeMirror's `windowRect`).
 */
const virtualWidth = (trueWidth: number, space: Space, frame: Frame): number =>
  ((options.clip ? space.limits(trueWidth, Infinity).right : trueWidth) - frame.ox) / frame.sx;
const virtualHeight = (trueHeight: number, space: Space, frame: Frame): number =>
  ((options.clip ? space.limits(Infinity, trueHeight).bottom : trueHeight) - frame.oy) / frame.sy;

// ── who gets what ────────────────────────────────────────────────────────────

/** the space whose rectangle of `element` the caller is to get, null for the browser's own */
function rectSpace(element: Element): Space | null {
  const inside = spaceOf(element);
  if (inside) {
    stats.rect.inHost++;
    touch(inside);
    return inside;
  }
  // an ancestor of an armed host: the editor's when the editor asks, the board's otherwise
  let ancestor = false;
  for (const space of spaces) if (space.ancestors.has(element)) ancestor = true;
  if (!ancestor) return null;
  // the document element stands for the window (a popup's flip): see windowCaller
  const { space } =
    options.parts.viewport && element === document.documentElement ? windowCaller(options.docrect) : caller();
  if (space?.ancestors.has(element)) {
    stats.rect.ancestorVirtual++;
    return space;
  }
  stats.rect.ancestorTrue++;
  return null;
}

/** the space for a value that has no node to tell whose it is: a point handed in, the window's size */
function callerSpace(counter: "point" | "viewport", kind: string): { space: Space; frame: Frame } | null {
  const count = stats[counter];
  count.calls++;
  const { space, by } = counter === "viewport" ? windowCaller(options.guess) : caller();
  if (by === "event") count.byEvent++;
  else if (by === "job") count.byJob++;
  else if (by === "boardEvent") count.boardEvent++;
  else {
    count.unknown++;
    sample(`${kind}:unknown`);
  }
  const frame = space?.frame();
  if (!space || !frame) return null;
  sample(kind);
  return { space, frame };
}

// ── the patches ──────────────────────────────────────────────────────────────

type AnyFunction = (this: never, ...args: never[]) => unknown;

interface Patch {
  part: Part;
  /** null where the target does not exist in this browser */
  target: object | null;
  key: string;
  kind: "method" | "getter";
  /** the replacement for `previous`, the function found at install time */
  make(previous: AnyFunction): AnyFunction;
}

type RectOf<T> = (this: T) => DOMRect;
type RectsOf<T> = (this: T) => DOMRectList;
type PointQuery = (this: Document, x: number, y: number) => unknown;
type SizeOf = (this: object) => number;

const method = <F extends AnyFunction>(part: Part, target: object, key: string, make: (previous: F) => F): Patch => ({
  part,
  target,
  key,
  kind: "method",
  make: make as unknown as Patch["make"],
});

const pointQuery = (key: string): Patch =>
  method<PointQuery>("points", Document.prototype, key, (previous) => {
    return function (this: Document, x: number, y: number): unknown {
      if (spaces.length === 0) return previous.call(this, x, y);
      const frame = callerSpace("point", key)?.frame;
      if (!frame) return previous.call(this, x, y);
      stats.point.converted++;
      return previous.call(this, frame.ox + x * frame.sx, frame.oy + y * frame.sy);
    };
  });

const windowSize = (
  target: object | null,
  key: string,
  convert: (value: number, space: Space, frame: Frame) => number,
): Patch => ({
  part: "viewport",
  target,
  key,
  kind: "getter",
  make: (previous) => {
    const read = previous as unknown as SizeOf;
    return function (this: object | undefined): number {
      // `innerWidth` read as a bare global has no receiver
      const value = read.call(this ?? (target as object));
      if (spaces.length === 0) return value;
      const asked = callerSpace("viewport", key);
      if (!asked) return value;
      stats.viewport.virtual++;
      return convert(value, asked.space, asked.frame);
    } as AnyFunction;
  },
});

const PATCHES: readonly Patch[] = [
  method<RectOf<Element>>("rects", Element.prototype, "getBoundingClientRect", (previous) => {
    return function (this: Element): DOMRect {
      const rect = previous.call(this);
      if (spaces.length === 0) return rect;
      stats.rect.calls++;
      const space = rectSpace(this);
      const frame = space?.frame();
      if (!space || !frame) return rect;
      // the document element stands for the window in a popup's flip (see virtualWidth)
      if (options.parts.viewport && this === document.documentElement) {
        return new DOMRect(0, 0, virtualWidth(rect.right, space, frame), virtualHeight(rect.bottom, space, frame));
      }
      return virtualRect(rect, frame);
    };
  }),
  method<RectsOf<Element>>("rects", Element.prototype, "getClientRects", (previous) => {
    return function (this: Element): DOMRectList {
      const list = previous.call(this);
      if (spaces.length === 0) return list;
      stats.rects.calls++;
      const space = spaceOf(this);
      const frame = space?.frame();
      if (!space || !frame) return list;
      stats.rects.inHost++;
      touch(space);
      return virtualRects(list, frame);
    };
  }),
  method<RectOf<Range>>("rects", Range.prototype, "getBoundingClientRect", (previous) => {
    return function (this: Range): DOMRect {
      const rect = previous.call(this);
      if (spaces.length === 0) return rect;
      stats.range.calls++;
      const space = spaceOf(this.commonAncestorContainer);
      const frame = space?.frame();
      if (!space || !frame) return rect;
      stats.range.inHost++;
      touch(space);
      return virtualRect(rect, frame);
    };
  }),
  method<RectsOf<Range>>("rects", Range.prototype, "getClientRects", (previous) => {
    return function (this: Range): DOMRectList {
      const list = previous.call(this);
      if (spaces.length === 0) return list;
      stats.range.calls++;
      const space = spaceOf(this.commonAncestorContainer);
      const frame = space?.frame();
      if (!space || !frame) return list;
      stats.range.inHost++;
      touch(space);
      return virtualRects(list, frame);
    };
  }),
  pointQuery("elementFromPoint"),
  pointQuery("elementsFromPoint"),
  pointQuery("caretPositionFromPoint"),
  pointQuery("caretRangeFromPoint"),
  method<(this: SVGGraphicsElement) => DOMMatrix | null>(
    "ctm",
    SVGGraphicsElement.prototype,
    "getScreenCTM",
    (previous) => {
      return function (this: SVGGraphicsElement): DOMMatrix | null {
        const matrix = previous.call(this);
        if (spaces.length === 0 || !matrix) return matrix;
        stats.ctm.calls++;
        const space = spaceOf(this);
        const frame = space?.frame();
        if (!space || !frame) return matrix;
        stats.ctm.inHost++;
        sample("getScreenCTM");
        touch(space);
        // user units -> true client px -> virtual px
        return new DOMMatrix()
          .scaleSelf(1 / frame.sx, 1 / frame.sy)
          .translateSelf(-frame.ox, -frame.oy)
          .multiplySelf(matrix);
      };
    },
  ),
  // Window's attributes are own accessors of the window object
  windowSize(window, "innerWidth", virtualWidth),
  windowSize(window, "innerHeight", virtualHeight),
  windowSize(typeof VisualViewport === "undefined" ? null : VisualViewport.prototype, "width", virtualWidth),
  windowSize(typeof VisualViewport === "undefined" ? null : VisualViewport.prototype, "height", virtualHeight),
];

// ── install and take back ────────────────────────────────────────────────────

/** takes one patch back; false when someone wrapped ours since (taking it back would drop theirs) */
type Restore = () => boolean;

function apply(patch: Patch): Restore | null {
  if (!patch.target) return null;
  const { target, key } = patch;
  const slot = patch.kind === "method" ? "value" : "get";
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  const previous: unknown = descriptor?.[slot];
  // a function this browser does not have (caretPositionFromPoint in an older Chromium)
  if (!descriptor || typeof previous !== "function") return null;
  const replacement = patch.make(previous as AnyFunction);
  Object.defineProperty(target, key, { ...descriptor, [slot]: replacement });
  return () => {
    if (Object.getOwnPropertyDescriptor(target, key)?.[slot] !== replacement) return false;
    Object.defineProperty(target, key, descriptor);
    return true;
  };
}

/** what is installed right now, by `Interface.key` */
const applied = new Map<string, Restore>();
const nameOf = (patch: Patch): string => `${patch.target?.constructor.name ?? "?"}.${patch.key}`;

export const installedPatches = (): string[] => [...applied.keys()];

export function install(): void {
  for (const patch of PATCHES) {
    const name = nameOf(patch);
    if (!options.parts[patch.part] || applied.has(name)) continue;
    const restore = apply(patch);
    if (restore) applied.set(name, restore);
  }
}

/** takes every patch back; returns the names of those that could not be and stay, inert without a space */
export function uninstall(): string[] {
  for (const [name, restore] of [...applied]) if (restore()) applied.delete(name);
  return [...applied.keys()];
}
