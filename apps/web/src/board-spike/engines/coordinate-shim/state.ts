/**
 * What the shim's parts share: which parts are on, the armed spaces, who is calling, the counters.
 *
 * WHO IS CALLING is the question no browser API answers. Three of the patched functions carry
 * their own answer: a rectangle, a range or an SVG matrix of a node INSIDE an armed host is always
 * given in that host's virtual space, to every caller. The others do not: a point handed to
 * `elementFromPoint`, `window.innerWidth`, the rectangle of an ANCESTOR of the host (the document
 * element for a popup's flip, the scroll parents CodeMirror walks). For those the caller counts as
 * the armed editor when
 *   - the event being dispatched right now (`window.event`) belongs to that editor (events.ts), or
 *   - the running synchronous job has already read geometry of a node inside the armed host (an
 *     editor measures itself before it measures its surroundings). The mark is dropped at the next
 *     microtask checkpoint, so it never outlives the callback that set it.
 * Everything else gets the browser's own answer. That is wrong for an editor that asks for the
 * window's size or a point in a timer or an animation frame BEFORE it reads any of its own geometry,
 * and right for all board code. Two modifiers turn it around for values that describe the window:
 * `docrect` (in `all`) for the document element's rectangle, which almost only popup placement
 * reads, and `guess` (not in `all`) for innerWidth, innerHeight and visualViewport, which any page
 * code may read. With them an unknown caller gets the armed editor's window, board code in a timer
 * too (measured).
 */
import type { ReadMode, Space } from "./space.ts";

export const PARTS = ["events", "rects", "points", "ctm", "viewport"] as const;
export type Part = (typeof PARTS)[number];

export interface ShimOptions {
  parts: Readonly<Record<Part, boolean>>;
  /** virtual rectangles on the layout grid of 1/64 px, as a document at scale 1 reports its boxes */
  snap: boolean;
  /** mouse, wheel and drag events carry whole virtual px, as the browser gives a document (pointer events stay fractional) */
  whole: boolean;
  /** the editor's window ends where the board clips the node's fixed boxes, not at the true window's edge */
  clip: boolean;
  /**
   * The rectangle of the DOCUMENT ELEMENT asked for by a caller nobody can identify is given as the
   * armed editor's window. diagram-js decides a popup's flip with it a second time after the paint,
   * outside every event (measured: without this the flip is undone at the board's edge).
   */
  docrect: boolean;
  /**
   * Not part of `all`. The window's size asked for by a caller nobody can identify (a timer, an
   * animation frame, an observer, before it read anything of an armed host) is given as the armed
   * editor's. Off (default): the browser's own
   */
  guess: boolean;
  /** the strategy's own sheet (strategies/shim.css): fixed popups keep their own width near the node's edge */
  css: boolean;
  /** true: the patches stay installed (and inert) after the last node is disarmed */
  keep: boolean;
  read: ReadMode;
}

/** `&shim=<comma list>`: parts and modifiers. Absent or `all`: every part, `snap`, `whole`, `css`, `clip` and `docrect`. `none`: nothing (the naive control) */
export function parseOptions(search: string): ShimOptions {
  const params = new URLSearchParams(search);
  const listed = (params.get("shim") ?? "all")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  const all = listed.includes("all");
  const has = (token: string): boolean => listed.includes(token);
  const read = params.get("shimread");
  return {
    parts: Object.fromEntries(PARTS.map((part) => [part, all || has(part)])) as Record<Part, boolean>,
    snap: all || has("snap"),
    whole: all || has("whole"),
    css: all || has("css"),
    clip: all || has("clip"),
    docrect: all || has("docrect"),
    guess: has("guess"),
    keep: has("keep"),
    read: read === "tick" || read === "arm" ? read : "job",
  };
}

export const options: ShimOptions = parseOptions(location.search);

/** the armed hosts: one on this board, two for the moment in which the armed node changes */
export const spaces: Space[] = [];

export const spaceOf = (node: Node): Space | null => {
  for (const space of spaces) if (space.host.contains(node)) return space;
  return null;
};

// ── counters ─────────────────────────────────────────────────────────────────

export interface ShimStats {
  events: { seen: number; inScope: number; converted: number };
  /** Element.getBoundingClientRect */
  rect: { calls: number; inHost: number; ancestorVirtual: number; ancestorTrue: number };
  /** Element.getClientRects */
  rects: { calls: number; inHost: number };
  /** Range.getBoundingClientRect and getClientRects */
  range: { calls: number; inHost: number };
  /** elementFromPoint, elementsFromPoint, caretPositionFromPoint, caretRangeFromPoint */
  point: { calls: number; converted: number; byEvent: number; byJob: number; boardEvent: number; unknown: number };
  ctm: { calls: number; inHost: number };
  /** innerWidth, innerHeight, visualViewport.width / height */
  viewport: { calls: number; virtual: number; byEvent: number; byJob: number; boardEvent: number; unknown: number };
  /** call stacks of the first calls of each kind an engine made, for "which engine calls this at all" */
  samples: Record<string, string[]>;
}

const fresh = (): ShimStats => ({
  events: { seen: 0, inScope: 0, converted: 0 },
  rect: { calls: 0, inHost: 0, ancestorVirtual: 0, ancestorTrue: 0 },
  rects: { calls: 0, inHost: 0 },
  range: { calls: 0, inHost: 0 },
  point: { calls: 0, converted: 0, byEvent: 0, byJob: 0, boardEvent: 0, unknown: 0 },
  ctm: { calls: 0, inHost: 0 },
  viewport: { calls: 0, virtual: 0, byEvent: 0, byJob: 0, boardEvent: 0, unknown: 0 },
  samples: {},
});

export let stats: ShimStats = fresh();
export const resetStats = (): void => void (stats = fresh());

const SAMPLES_PER_KIND = 4;
/** keeps the stack of the first few calls of a kind: who reads this at all */
export function sample(kind: string): void {
  const list = (stats.samples[kind] ??= []);
  if (list.length >= SAMPLES_PER_KIND) return;
  const stack = (new Error().stack ?? "").split("\n").slice(3, 9);
  list.push(stack.map((line) => line.trim().replace(/\?[tv]=[^:)]*/g, "")).join(" < "));
}

// ── who is calling ───────────────────────────────────────────────────────────

/** an event -> the armed space it belongs to (events.ts decides), null for the board's */
export const eventSpaces = new WeakMap<Event, Space | null>();
/** how events.ts answers for an event its listeners did not see (a key, a focus, a type it does not listen to) */
let lateScope: (event: Event) => Space | null = () => null;
export const setLateScope = (decide: (event: Event) => Space | null): void => void (lateScope = decide);

let jobSpace: Space | null = null;
const endJob = (): void => void (jobSpace = null);

/** the running job read geometry inside `space`: until this job ends its other reads are the editor's */
export function touch(space: Space): void {
  if (jobSpace === null) queueMicrotask(endJob);
  jobSpace = space;
}

export type Caller = "event" | "job" | "boardEvent" | "unknown";

/** the space for a value that describes the window: the caller's, or with `guess` the armed one when nobody knows the caller */
export function windowCaller(guess: boolean): { space: Space | null; by: Caller } {
  const found = caller();
  if (found.by === "unknown" && guess && spaces.length > 0) return { space: spaces[spaces.length - 1]!, by: "unknown" };
  return found;
}

/** whose code is running, and the space it lives in when it is an armed editor's */
export function caller(): { space: Space | null; by: Caller } {
  if (jobSpace !== null) return { space: jobSpace, by: "job" };
  // deprecated and universal: the event whose listeners are running, undefined in a timer, a frame or an observer
  const event = (window as { event?: Event }).event;
  if (event === undefined) return { space: null, by: "unknown" };
  let space = eventSpaces.get(event);
  if (space === undefined) {
    space = lateScope(event);
    eventSpaces.set(event, space);
  }
  return space ? { space, by: "event" } : { space: null, by: "boardEvent" };
}
