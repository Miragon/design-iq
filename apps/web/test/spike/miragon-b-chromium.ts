/**
 * Battery "miragon-b" of the board spike: the Miragon renderers Event Storming and Context Map,
 * every strategy x board zoom 0.5, 0.73, 1 and 1.5, one fresh page per row. A check run by hand, not
 * by `pnpm test` or CI: it starts a Vite dev server and a sandboxed headless Chromium (lib.ts).
 *
 *   PORT=5425 CACHE_DIR=<scratch>/vite-cache OUT_DIR=<scratch> node apps/web/test/spike/miragon-b-chromium.ts
 *   STRATEGIES=overlay,iframe NOTATIONS=context-map ZOOMS=0.5,1 CASES=pad,popup node apps/web/test/spike/miragon-b-chromium.ts
 *
 * What it covers per renderer (the CASES below are the index; CM = Context Map only, ES = Event
 * Storming only):
 * - moving: move-shape, move-selection, lasso, resize-note (ES), drawing-handle (ES), pan, wheel,
 *   wheel-out;
 * - creating: create-palette-drag, create-palette-click, create-key-enter (Enter on a palette entry),
 *   create-key-pointer (ES: the C key), append-click and append-drag (the pad's append entry);
 * - connecting and drawing: connect-click, connect-drag (the pad's connect entry), draw (ES: the draw
 *   tool);
 * - text: label-edit, label-noop, note-edit (ES), team-band (CM: the team line of a context);
 * - chrome: pad, popup-kind, popup-pattern (CM), popup-roles (CM), colour-picker (ES), pad-prompt and
 *   pad-prompt-edge (CM: the fixed description prompt), hover-tip (CM), palette, palette-tooltip;
 * - keys: keys (Delete, undo, redo, select all: who acts), keys-own (ES: nudge, duplicate, lasso);
 * - label-suggest (ES: the list of known names that opens under a sticky's name field while typing);
 * - a board zoom under the armed editor (round 6): board-zoom-note (ES: the note's editor),
 *   board-zoom-suggest (ES: the name field with its list of suggestions), board-zoom-prompt (CM: the
 *   description prompt), each with typed text and a wheel burst over the bare board. Their verdict
 *   follows the node's own arm rule, read off the page (`board.armPolicy`): under armedzoom=disarm
 *   a node that is a preview before the first zoom step, with the file a click on the bare board
 *   leaves, is the specified behaviour and ok; under free the node stays armed. No other case lets
 *   a wheel reach the board: there a moved board or a disarmed node is broken under every rule;
 * - product-mount: what the mount in use brings beside the canvas (menu, shortcuts dialog, chrome
 *   keys). It judges no strategy.
 *
 * A row holds what was done, what a person expects and why, what was measured, and a verdict that
 * a rule written here computes from the numbers. Nothing is keyed on a strategy's name: what a
 * rule needs to know about the strategy is measured per row (`env`): the editor's net scale in its
 * own document, the screen px one CSS px of its chrome takes (`chrome`), the screen px per diagram
 * unit (`unit`), whether the node is a frame, and the coordinate space the node's document TELLS its
 * editor against the browser's own (`space`: scale 1 and origin 0, 0 unless a strategy answers the
 * plain geometry functions in a space of its own, as `shim` does; read on purpose through the plain
 * methods next to the native ones, the difference is the measurement). The document a menu or the
 * prompt is flipped and clamped against is the window the editor is told, not the browser's, where
 * the two differ. `layers` is the strategy's variant as the page states it (the host's
 * data-plugin-layers, the parts of window.__boardSpikeShim).
 *
 * Verdicts: `ok` (as a person expects), `degraded` (works, with a cost that the row names),
 * `broken` (the gesture misses, its result is not where the pointer was, or the chrome it starts at
 * takes no press: `blocked` in the row), `wrong-data` (the file got something else than the person
 * chose), `unmeasured` (with the reason). A verdict is a strategy's result, never a failure of the
 * run: the exit code is 1 only when the harness failed (a case threw something that is no
 * measurement, a navigation under the run, a console error, a page error or a line in the page's
 * log).
 *
 * Environment: STRATEGIES (default naive,counter,overlay,iframe; all six: add plugin,shim), NOTATIONS (default
 * event-storming,context-map), ZOOMS (default 0.5,0.73,1,1.5), CASES (comma list; a name or a
 * prefix of names), REPEAT (default 1: every row measured that often on fresh pages, the spread of
 * its numbers recorded), CONCURRENCY (default 1: that many rows side by side, each on a page and a
 * browser context of its own), SHOTS (0 switches the screenshots off), plus lib.ts's PORT, BASE,
 * CACHE_DIR, OUT_DIR, OUT. Results: <OUT_DIR>/miragon-b.json and miragon-b.md, screenshots under
 * <OUT_DIR>/shots.
 */
import { writeFileSync } from "node:fs";

import {
  aimAt,
  type Board,
  type Box,
  centre,
  type Harness,
  type ModelNotation,
  type NativeGeometry,
  type NodeHandle,
  outPath,
  type Point,
  recordEvents,
  round,
  run,
  seenEvents,
  STRATEGIES,
  type Strategy,
  union,
  writeResult,
} from "./lib.ts";

// ── what runs ────────────────────────────────────────────────────────────────

const MINE = ["event-storming", "context-map"] as const;
type Notation = (typeof MINE)[number];

const wanted = (name: string): string[] => (process.env[name] ?? "").split(",").filter(Boolean);
const strategies: Strategy[] = (() => {
  const asked = wanted("STRATEGIES");
  const all: Strategy[] = asked.length === 0 ? ["naive", "counter", "overlay", "iframe"] : [...STRATEGIES];
  return asked.length === 0 ? all : all.filter((one) => asked.includes(one));
})();
const notations: Notation[] = (() => {
  const asked = wanted("NOTATIONS");
  return asked.length === 0 ? [...MINE] : MINE.filter((one) => asked.includes(one));
})();
const zooms = (process.env.ZOOMS ?? "0.5,0.73,1,1.5").split(",").map(Number).filter(Boolean);
const caseFilter = wanted("CASES");
const repeat = Math.max(1, Math.round(Number(process.env.REPEAT ?? 1)) || 1);
const shots = process.env.SHOTS !== "0";
const concurrency = Math.max(1, Math.round(Number(process.env.CONCURRENCY ?? 1)) || 1);

/** where the node's top-left corner sits in the canvas: clear of the toolbar */
const ORIGIN = { x: 60, y: 80 };
/** the pointer's travel of a drag in flow units; on screen it is this times the board zoom */
const TRAVEL = { x: 60, y: 40 };

type NativeWindow = Window & { __boardSpikeNative?: NativeGeometry };
type Verdict = "ok" | "degraded" | "broken" | "wrong-data" | "unmeasured";

/** a case could not be measured, for a reason that is itself a result (never a failure of the run) */
class Unmeasured extends Error {}
/**
 * The gesture cannot be started by a person: the chrome it starts at (a pad entry, a palette entry)
 * is not there or takes no press where the editor put it. That is a measurement: the row is broken.
 */
class Blocked extends Error {}

/** what the notation's sample file offers a case */
interface Sample {
  /** shapes that move freely, in order of preference */
  movers: readonly string[];
  /** two shapes for a selection, close to each other and with room to travel */
  pair: readonly [string, string];
  /** held after the press of a move or a create: switches the renderer's snapping off */
  hold: readonly string[];
  /** the palette entry (data-action) a create case uses, and how many shapes one create adds */
  create: string;
  /** a shape whose label is edited */
  label: string;
  /** a shape whose pad and kind popup are opened */
  padOf: string;
  /** connect: from, to (no connection between them in the sample) */
  connect: readonly [string, string];
  /** the pad entries (data-action) that start an append and a connect */
  append: string;
  /** the pad entry that opens the kind popup of a shape, and a kind to choose that the shape has not */
  kindEntry: string;
}

const SAMPLES: Readonly<Record<Notation, Sample>> = {
  "event-storming": {
    movers: ["cmd_place_order", "agg_order", "event_order_placed", "cmd_ship_order"],
    // the hotspot first: its pad opens to the right, clear of the other one
    pair: ["hot_double_payment_on_retry", "ext_payment_provider"],
    // ElementSnapping: a sticky's centre snaps to another's within 8 units unless Shift is held
    hold: ["Shift"],
    create: "create.command",
    label: "event_order_placed",
    padOf: "ext_payment_provider",
    // from the hotspot: its pad opens to the right, clear of the target
    connect: ["hot_double_payment_on_retry", "ext_payment_provider"],
    append: "append",
    kindEntry: "change-kind",
  },
  "context-map": {
    movers: ["ctx_ordering", "ctx_catalog", "ctx_payment"],
    pair: ["ctx_payment", "ctx_legacy_erp"],
    hold: [],
    create: "context.core",
    label: "ctx_ordering",
    padOf: "ctx_ordering",
    connect: ["ctx_catalog", "ctx_payment"],
    append: "append-context",
    kindEntry: "subdomain-type",
  },
};

/** what a rule may know about the strategy: measured on the armed node, never read off its name */
interface Env {
  /** client size over layout size of the editor's host in its own document: 1 is what diagram-js assumes */
  netScale: number;
  /** screen px one CSS px of the editor's chrome takes (net scale times the frame's scale) */
  chrome: number;
  /** screen px per diagram unit */
  unit: number;
  /** the editor lives in a document of its own */
  frame: boolean;
  /** the host on screen and in its own layout px */
  hostScreen: { width: number; height: number };
  hostLayout: { width: number; height: number };
  /**
   * The space the node's document tells its editor: true client px per told px, the true client
   * point of the told (0, 0), and the document's box as the editor is told it, on SCREEN. `virtual`
   * when that space is not the browser's own.
   */
  space: { scale: number; origin: Point; window: Box; virtual: boolean };
  /** the strategy's variant as the page states it: data-plugin-layers of the host, the shim's parts */
  layers: string | null;
}

interface Row {
  case: string;
  notation: Notation;
  strategy: Strategy;
  /** the board zoom the URL ASKED for; the row's key in every table */
  zoom: number;
  /**
   * What arming left (round 5: the arm rules may move the board first): the board's viewport and the
   * zoom IN EFFECT while the case ran, the host's top-left corner in the window, the rules of the
   * node and the move they made (null: the board did not move).
   */
  zoomInEffect?: number;
  viewportArmed?: { x: number; y: number; zoom: number };
  hostAt?: Point;
  armRules?: string;
  armMove?: { by: string; from: string; to: string; askedMs: number; writes: number; interrupted: boolean } | null;
  status: "measured" | "unmeasured" | "failed";
  did: string;
  expected: string;
  why: string;
  /** the rule the verdict was computed with */
  rule: string;
  verdict: Verdict;
  /** one line for the tables: the measured quantity the verdict rests on */
  headline: string;
  measured: Record<string, unknown>;
  /** why a case could not be measured */
  unmeasured?: string;
  /** 2: the first attempt could not be measured (`firstAttempt` says why) and the row is the second one's */
  attempts?: number;
  firstAttempt?: string;
  /** what the harness tripped over (status failed) */
  error?: string;
  env?: Env;
  /** the node was still armed and the board file unchanged when the case ended */
  armedAfter?: boolean;
  boardSame?: boolean;
  /** an own box of the editor was left scrolled when the case ended (scrolledBy): absent when none was */
  scrolledAfter?: { x: number; y: number; where: string };
  mounts?: number;
  /** console errors, page errors and lines of the page's log */
  problems: string[];
  /** REPEAT > 1: the verdicts of all runs and the largest difference between a number of two runs */
  repeats?: { verdicts: Verdict[]; spread: number };
  shot?: string;
}

interface Ctx {
  harness: Harness;
  board: Board;
  node: NodeHandle;
  row: Row;
  notation: Notation;
  /** the board zoom IN EFFECT after arming (the viewport's), which is the asked one unless an arm rule moved the board */
  zoom: number;
  nodeId: string;
  file: string;
  sample: Sample;
  env: Env;
  /** a screenshot of the node and whatever `around` adds, named after the row */
  shot(around?: readonly (Box | null | undefined)[]): Promise<void>;
}

interface CaseDef {
  name: string;
  notations: readonly Notation[];
  did: string;
  expected: string;
  why: string;
  rule: string;
  run(ctx: Ctx): Promise<{ verdict: Verdict; headline: string }>;
}

// ── small tools ──────────────────────────────────────────────────────────────

const r2 = (value: number): number => round(value, 2);
const pt = (point: Point): Point => ({ x: r2(point.x), y: r2(point.y) });
const bx = (box: Box): Box => ({ x: r2(box.x), y: r2(box.y), width: r2(box.width), height: r2(box.height) });
const right = (box: Box): number => box.x + box.width;
const bottom = (box: Box): number => box.y + box.height;
const inflate = (box: Box, by: number): Box => ({
  x: box.x - by,
  y: box.y - by,
  width: box.width + 2 * by,
  height: box.height + 2 * by,
});
const overlaps = (a: Box, b: Box): boolean =>
  a.x < right(b) && right(a) > b.x && a.y < bottom(b) && bottom(a) > b.y && a.width > 0 && b.width > 0;
const inside = (inner: Box, outer: Box, slack = 0.5): boolean =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  right(inner) <= right(outer) + slack &&
  bottom(inner) <= bottom(outer) + slack;
const around = (at: Point, width: number, height: number): Box => ({
  x: at.x - width / 2,
  y: at.y - height / 2,
  width,
  height,
});
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const pair = (point: Point, digits = 2): string => `${point.x.toFixed(digits)}/${point.y.toFixed(digits)}`;

/** a position against where the pointer or the anchor says it belongs: ok within `tight`, degraded within `loose` */
const placed = (error: number, tight: number, loose: number): Verdict =>
  error <= tight ? "ok" : error <= loose ? "degraded" : "broken";
/** the rounding an engine may add to a position: moves land on whole diagram units */
const unitSlack = (env: Env): number => Math.max(2, 1.5 * env.unit);

/** what the node's document holds for a selector, in screen px, with what a case reads off an element */
interface Found {
  box: Box;
  action: string | null;
  id: string | null;
  title: string | null;
  cls: string;
  text: string;
  /** font size on screen */
  font: number;
  pressed: string | null;
  position: string;
  value: string | null;
  /** an animation or transition of the element still runs (Context Maps' menu slides in over 4 px) */
  animating: boolean;
}

async function find(node: NodeHandle, selector: string): Promise<Found[]> {
  const map = await node.map();
  const raw = await node.inDocument(
    (host, arg) => {
      const native = (window as NativeWindow).__boardSpikeNative;
      // the counter strategy's body-level popup host carries the node's id; a frame has none
      const popupHosts =
        arg.node === null
          ? []
          : [...document.querySelectorAll<HTMLElement>(".board-popup-host")].filter(
              (one) => one.dataset.node === arg.node,
            );
      return [host, ...popupHosts].flatMap((root) =>
        [...root.querySelectorAll(arg.selector)].map((element) => {
          const rect = native ? native.rect(element) : element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const layoutWidth = element instanceof HTMLElement ? element.offsetWidth : 0;
          return {
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            action: element.getAttribute("data-action"),
            id: element.getAttribute("data-id") ?? element.getAttribute("data-element-id"),
            title: element.getAttribute("title") ?? element.getAttribute("aria-label"),
            cls: element.getAttribute("class") ?? "",
            text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
            // CSS px of the font times the element's own scale in this document
            font: parseFloat(style.fontSize) * (layoutWidth > 0 ? rect.width / layoutWidth : 1),
            pressed: element.getAttribute("aria-pressed"),
            position: style.position,
            value: element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? element.value : null,
            animating: element
              .getAnimations()
              .some(
                (animation) =>
                  (animation.playState === "running" || animation.pending) &&
                  animation.effect?.getComputedTiming().iterations !== Infinity,
              ),
          };
        }),
      );
    },
    { selector, node: node.frame ? null : node.id },
  );
  return raw.map((one) => ({
    ...one,
    box: {
      x: map.x + one.box.x * map.sx,
      y: map.y + one.box.y * map.sy,
      width: one.box.width * map.sx,
      height: one.box.height * map.sy,
    },
    font: one.font * map.sx,
  }));
}

/**
 * The first match once its box rests and its opening animation is over, null when none came. A
 * busy page can show the first frame of an animation for longer than two polls: at rest by its
 * numbers, and still 4 px from where it will stand (Context Maps' menu).
 */
async function settled(ctx: Ctx, selector: string, timeout = 2500): Promise<Found | null> {
  const box = await ctx.board.waitForBox(async () => {
    const one = (await find(ctx.node, selector))[0];
    return one && !one.animating ? one.box : null;
  }, timeout);
  if (!box) return null;
  return (await find(ctx.node, selector))[0] ?? null;
}

/** every shape and connection the editor draws, in screen px */
async function elementBoxes(node: NodeHandle): Promise<Record<string, Box>> {
  const map = await node.map();
  const raw = await node.inDocument((host) => {
    const native = (window as NativeWindow).__boardSpikeNative;
    const out: Record<string, Box> = {};
    for (const visual of host.querySelectorAll("[data-element-id] > .djs-visual")) {
      const id = visual.parentElement?.getAttribute("data-element-id");
      if (!id) continue;
      const rect = native ? native.rect(visual) : visual.getBoundingClientRect();
      out[id] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    return out;
  });
  return Object.fromEntries(
    Object.entries(raw).map(([id, box]) => [
      id,
      { x: map.x + box.x * map.sx, y: map.y + box.y * map.sy, width: box.width * map.sx, height: box.height * map.sy },
    ]),
  );
}

/** what is drawn that was not before */
async function added(node: NodeHandle, before: readonly string[]): Promise<string[]> {
  return (await node.elementIds()).filter((id) => !before.includes(id));
}

/** the space the node's document tells its editor (Env.space), its window in screen px */
async function editorSpace(node: NodeHandle): Promise<Pick<Env, "space" | "layers">> {
  const map = await node.map();
  const raw = await node.inDocument((host) => {
    const page = window as NativeWindow & { __boardSpikeShim?: { options?: { parts?: Record<string, boolean> } } };
    const native = page.__boardSpikeNative;
    // the PLAIN methods on purpose: what the armed editor is told. The host first: a strategy that
    // answers by the caller takes the rest of this job for the editor's after a read inside the host
    const told = host.getBoundingClientRect();
    const toldWindow = document.documentElement.getBoundingClientRect();
    const real = native ? native.rect(host) : told;
    const scale = told.width > 0 ? real.width / told.width : 1;
    const origin = { x: real.x - told.x * scale, y: real.y - told.y * scale };
    const parts = page.__boardSpikeShim?.options?.parts;
    const shim = parts
      ? `shim=${Object.keys(parts)
          .filter((part) => parts[part])
          .join(",")}`
      : null;
    return {
      scale,
      origin,
      window: {
        x: origin.x + toldWindow.x * scale,
        y: origin.y + toldWindow.y * scale,
        width: toldWindow.width * scale,
        height: toldWindow.height * scale,
      },
      layers: host.dataset.pluginLayers !== undefined ? `plugin=${host.dataset.pluginLayers}` : shim,
    };
  });
  return {
    space: {
      scale: round(raw.scale, 4),
      origin: pt(raw.origin),
      window: bx({
        x: map.x + raw.window.x * map.sx,
        y: map.y + raw.window.y * map.sy,
        width: raw.window.width * map.sx,
        height: raw.window.height * map.sy,
      }),
      virtual: Math.abs(raw.scale - 1) > 0.001 || Math.abs(raw.origin.x) + Math.abs(raw.origin.y) > 0.5,
    },
    layers: raw.layers,
  };
}

/** the hit is the canvas itself: the svg carries the root's id, every shape lies in a group of its own */
const bare = (hit: { reachable: boolean; what: string; palette: boolean; pad: boolean; popup: boolean }): boolean =>
  hit.reachable && hit.what.startsWith("svg.") && !hit.palette && !hit.pad && !hit.popup;

const CHROME = ".djs-palette, .djs-context-pad.open, .djs-popup, .cm-pad-prompt, .event-storming-color-picker";

/**
 * A point of the bare canvas where a box of `size` screen px around it touches no element and no
 * chrome, more than `edge` px inside the host (diagram-js scrolls the canvas near its edge), the
 * nearest to `prefer`. Hit-tested: the top document's topmost element there is the editor's canvas.
 */
async function freePoint(
  ctx: Ctx,
  options: { size?: { width: number; height: number }; prefer?: Point; clear?: readonly Box[] } = {},
): Promise<Point> {
  const { node, env } = ctx;
  const host = await node.hostBox();
  const size = options.size ?? { width: 24, height: 24 };
  const edge = 30 * Math.max(env.chrome, 0.5) + 6;
  const taken = [
    ...Object.values(await elementBoxes(node)).map((box) => inflate(box, 4)),
    ...(await find(node, CHROME)).map((one) => inflate(one.box, 6)),
    ...(options.clear ?? []),
  ];
  const prefer = options.prefer ?? { x: host.x + host.width * 0.3, y: host.y + host.height * 0.82 };
  const candidates: Point[] = [];
  const step = Math.max(6, Math.min(host.width, host.height) / 40);
  for (let y = host.y + edge + size.height / 2; y <= bottom(host) - edge - size.height / 2; y += step) {
    for (let x = host.x + edge + size.width / 2; x <= right(host) - edge - size.width / 2; x += step) {
      const box = around({ x, y }, size.width, size.height);
      if (!taken.some((one) => overlaps(one, box))) candidates.push({ x, y });
    }
  }
  candidates.sort((a, b) => distance(a, prefer) - distance(b, prefer));
  for (const candidate of candidates.slice(0, 40)) {
    const at = aimAt(await node.map(), candidate);
    const hit = await node.hit(at);
    if (bare(hit)) return at;
  }
  throw new Unmeasured(
    `no free canvas point for a ${Math.round(size.width)} x ${Math.round(size.height)} px box in the ` +
      `${Math.round(host.width)} x ${Math.round(host.height)} px host (${candidates.length} candidates clear of elements and chrome)`,
  );
}

/**
 * A point on the element that takes a press for it: its middle, else the first point of a grid over
 * its box. `selection: true` also takes a point where the outline of a multi-selection lies over the
 * element (a person presses there all the same; whether the press then reaches the element is what
 * the case measures).
 */
async function pressPoint(ctx: Ctx, elementId: string, options: { selection?: boolean } = {}): Promise<Point> {
  const { node } = ctx;
  const box = await node.elementBox(elementId);
  if (!box) throw new Unmeasured(`${elementId} is not drawn`);
  const map = await node.map();
  const seen: string[] = [];
  const fractions = [0.5, 0.3, 0.7, 0.15, 0.85];
  for (const fy of fractions) {
    for (const fx of fractions) {
      const at = aimAt(map, { x: box.x + box.width * fx, y: box.y + box.height * fy });
      const hit = await node.hit(at);
      const chrome = hit.palette || hit.pad || hit.popup;
      if (hit.reachable && !chrome && hit.element === elementId) return at;
      if (hit.reachable && !chrome && options.selection && hit.what.includes("djs-selection-outline")) return at;
      if (seen.length < 3) seen.push(hit.reachable ? hit.what : "outside the editor");
    }
  }
  throw new Unmeasured(`${elementId} takes no press: covered by ${[...new Set(seen)].join(", ")}`);
}

/** the first of `ids` that takes a press */
async function pressable(ctx: Ctx, ids: readonly string[]): Promise<{ id: string; at: Point; box: Box }> {
  const reasons: string[] = [];
  for (const id of ids) {
    try {
      const at = await pressPoint(ctx, id);
      return { id, at, box: (await ctx.node.elementBox(id))! };
    } catch (error) {
      if (!(error instanceof Unmeasured)) throw error;
      reasons.push(error.message);
    }
  }
  throw new Unmeasured(reasons.join("; "));
}

/** a click on the element; throws Unmeasured when it does not end up selected */
async function select(ctx: Ctx, elementId: string): Promise<Point> {
  const at = await pressPoint(ctx, elementId);
  await ctx.board.click(at);
  const ok = await ctx.board.waitFor(async () => (await ctx.node.selected()).includes(elementId), 2500);
  if (!ok) throw new Unmeasured(`a click on ${elementId} did not select it`);
  return at;
}

/** the entry of the open context pad, once the pad rests; throws Blocked when it never shows or takes no press */
async function padEntry(ctx: Ctx, action: string): Promise<Found> {
  const selector = `.djs-context-pad.open .entry[data-action="${action}"]`;
  const entry = await settled(ctx, selector);
  if (!entry) throw new Blocked(`the pad shows no entry ${action}`);
  const hit = await ctx.node.hit(aimAt(await ctx.node.map(), centre(entry.box)));
  if (!hit.reachable || !hit.pad) {
    throw new Blocked(
      `the pad entry ${action} at ${pair(centre(entry.box), 0)} takes no press (${hit.reachable ? hit.what : "outside the editor"})`,
    );
  }
  return entry;
}

async function clickBox(ctx: Ctx, box: Box): Promise<Point> {
  const at = aimAt(await ctx.node.map(), centre(box));
  await ctx.board.click(at);
  return at;
}

/** moves the pointer to `to` in small steps, as a hand does (a hover and a follow need the moves) */
async function glide(ctx: Ctx, from: Point, to: Point, steps = 10): Promise<void> {
  for (let step = 1; step <= steps; step++) {
    await ctx.board.move({
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
    });
  }
}

const pause = (ctx: Ctx, ms: number): Promise<void> => ctx.board.page.waitForTimeout(ms);

/**
 * How far a box of the editor, or a box around it up to the document, is scrolled: 0 / 0 in a
 * healthy page. The editor's containers and the node's body hide their overflow and are never meant
 * to scroll; a focus on a field that lies outside them scrolls them all the same, and the diagram
 * (or the whole editor inside its node) then shows shifted by that much.
 */
function scrolledBy(node: NodeHandle): Promise<{ x: number; y: number; where: string }> {
  return node.inDocument((host) => {
    const around: Element[] = [];
    for (let element = host.parentElement; element; element = element.parentElement) around.push(element);
    let worst = { x: 0, y: 0, where: "" };
    for (const element of [...around, host, ...host.querySelectorAll<HTMLElement>("div")]) {
      const { scrollLeft, scrollTop } = element;
      if (Math.abs(scrollLeft) + Math.abs(scrollTop) > Math.abs(worst.x) + Math.abs(worst.y)) {
        worst = {
          x: Math.round(scrollLeft * 100) / 100,
          y: Math.round(scrollTop * 100) / 100,
          where: (element.getAttribute("class") ?? element.tagName.toLowerCase()).split(" ")[0] ?? "",
        };
      }
    }
    return worst;
  });
}

/** the file, once it stopped changing (an editor writes about 350 ms after a gesture) */
async function fileAtRest(ctx: Ctx, wait = 700): Promise<string> {
  let last = (await ctx.board.fileText(ctx.file)) ?? "";
  for (let round = 0; round < 6; round++) {
    await pause(ctx, wait / 2);
    const now = (await ctx.board.fileText(ctx.file)) ?? "";
    if (now === last && round > 0) return now;
    last = now;
  }
  return last;
}

/** the file after a gesture that should have written: waits for the write (up to 3 s), then for the file to rest */
async function fileAfter(ctx: Ctx, before: string): Promise<string> {
  await ctx.board.waitForFileChange(ctx.file, before, 3000);
  return fileAtRest(ctx, 500);
}

/** counts of what a model file holds, per notation: enough to tell an added shape from an added connection */
function census(notation: Notation, text: string): { shapes: number; connections: number } {
  if (notation === "context-map") {
    try {
      const doc = JSON.parse(text) as { contexts?: unknown[]; relationships?: unknown[] };
      return { shapes: doc.contexts?.length ?? 0, connections: doc.relationships?.length ?? 0 };
    } catch {
      return { shapes: -1, connections: -1 };
    }
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const connections = lines.filter((line) => /\s->\s/.test(line)).length;
  const shapes = lines.filter(
    // a drawing is written as `line [[x, y], ...]`
    (line) => /^(actor|command|aggregate|event|policy|readmodel|external|hotspot|note|line)\b/.test(line.trim()),
  ).length;
  return { shapes, connections };
}

/** the same lines, in whatever order */
const sameLines = (a: string, b: string): boolean =>
  a.split("\n").sort().join("\n") === b.split("\n").sort().join("\n");

// ── the cases ────────────────────────────────────────────────────────────────

const CASES: CaseDef[] = [];
const both: readonly Notation[] = MINE;

CASES.push({
  name: "move-shape",
  notations: both,
  did: "pressed one shape and dragged it by (60, 40) flow units",
  expected: "the shape travels as far as the pointer on screen (ratio 1.00 / 1.00) and the file changes",
  why: "a drag is the base gesture: the shape must stay under the pointer",
  rule: "error = |moved - pointer| in screen px; ok up to max(2, 1.5 units), degraded up to 3 times that, else broken; no file change is broken",
  async run(ctx) {
    const { node, board, row, sample, env } = ctx;
    const target = await pressable(ctx, sample.movers);
    const before = await board.fileText(ctx.file);
    const dragged = await node.drag(
      target.at,
      { x: TRAVEL.x * ctx.zoom, y: TRAVEL.y * ctx.zoom },
      { hold: sample.hold },
    );
    const changed = (await board.waitForFileChange(ctx.file, before)) !== null;
    const after = await node.elementBox(target.id);
    if (!after) throw new Error(`${target.id} is gone after the drag`);
    const moved = { x: after.x - target.box.x, y: after.y - target.box.y };
    const error = Math.max(Math.abs(moved.x - dragged.delta.x), Math.abs(moved.y - dragged.delta.y));
    const ratio = { x: moved.x / dragged.delta.x, y: moved.y / dragged.delta.y };
    Object.assign(row.measured, {
      element: target.id,
      pointer: pt(dragged.delta),
      moved: pt(moved),
      ratio: pt(ratio),
      errorPx: r2(error),
      fileChanged: changed,
    });
    await ctx.shot();
    const tight = unitSlack(env);
    return { verdict: changed ? placed(error, tight, 3 * tight) : "broken", headline: `${pair(ratio)}` };
  },
});

CASES.push({
  name: "move-selection",
  notations: both,
  did: "selected two shapes (click, Shift + click) and dragged one of them by (60, 40) flow units",
  expected: "both selected shapes travel as far as the pointer",
  why: "a multi-selection moves as one: the same pointer math, applied to several shapes",
  rule: "error = the larger |moved - pointer| of the two shapes; ok up to max(2, 1.5 units), degraded up to 3 times that, else broken; a selection of other than two shapes is broken",
  async run(ctx) {
    const { node, board, row, sample, env } = ctx;
    const [first, second] = sample.pair;
    await select(ctx, first);
    const secondAt = await pressPoint(ctx, second);
    await board.page.keyboard.down("Shift");
    await board.click(secondAt);
    await board.page.keyboard.up("Shift");
    await pause(ctx, 150);
    const selected = (await node.selected()).filter((id) => id === first || id === second);
    row.measured.selected = await node.selected();
    if (selected.length !== 2) {
      await ctx.shot();
      return { verdict: "broken", headline: `selected ${selected.length} of 2` };
    }
    const boxes = { a: (await node.elementBox(first))!, b: (await node.elementBox(second))! };
    const grab = await pressPoint(ctx, first, { selection: true });
    // inside a node the outline of a multi-selection can lie over its shapes and take the press
    row.measured.pressedOn = (await node.hit(grab)).what;
    const before = await board.fileText(ctx.file);
    const dragged = await node.drag(grab, { x: TRAVEL.x * ctx.zoom, y: TRAVEL.y * ctx.zoom }, { hold: sample.hold });
    const changed = (await board.waitForFileChange(ctx.file, before)) !== null;
    const after = { a: await node.elementBox(first), b: await node.elementBox(second) };
    if (!after.a || !after.b) throw new Error("a selected shape is gone after the drag");
    const movedA = { x: after.a.x - boxes.a.x, y: after.a.y - boxes.a.y };
    const movedB = { x: after.b.x - boxes.b.x, y: after.b.y - boxes.b.y };
    const errorOf = (moved: Point): number =>
      Math.max(Math.abs(moved.x - dragged.delta.x), Math.abs(moved.y - dragged.delta.y));
    const error = Math.max(errorOf(movedA), errorOf(movedB));
    const ratio = { x: movedA.x / dragged.delta.x, y: movedA.y / dragged.delta.y };
    Object.assign(row.measured, {
      pointer: pt(dragged.delta),
      movedFirst: pt(movedA),
      movedSecond: pt(movedB),
      ratio: pt(ratio),
      errorPx: r2(error),
      fileChanged: changed,
    });
    await ctx.shot();
    const tight = unitSlack(env);
    return { verdict: changed ? placed(error, tight, 3 * tight) : "broken", headline: pair(ratio) };
  },
});

/** the smallest press target a person hits without aiming (WCAG 2.2, target size minimum) */
const TARGET_PX = 24;
/** below this a text on screen is hard to read */
const READABLE_PX = 9;

/** how many of `targets` take a press at their middle, as chrome of the kind `what` */
async function reachable(ctx: Ctx, targets: readonly Found[], what: "palette" | "pad" | "popup"): Promise<number> {
  const map = await ctx.node.map();
  let count = 0;
  for (const target of targets) {
    const hit = await ctx.node.hit(aimAt(map, centre(target.box)));
    if (hit.reachable && hit[what]) count++;
  }
  return count;
}

CASES.push({
  name: "lasso",
  notations: both,
  did: "held Shift and dragged a rectangle over the bare canvas around two shapes, from below right to above left",
  expected: "the dashed frame follows the pointer and exactly the shapes inside the drawn rectangle are selected",
  why: "the lasso is the renderers' way to select several shapes; a frame that is not under the pointer selects other shapes than the person framed",
  rule: "ok when the selected shapes are those inside the pointer's rectangle and the frame's corner is within max(2, 1.5 units) of the pointer; else broken",
  async run(ctx) {
    const { node, board, row, sample, env } = ctx;
    const [first, second] = sample.pair;
    const boxes = await elementBoxes(node);
    if (!boxes[first] || !boxes[second]) throw new Unmeasured(`${first} or ${second} is not drawn`);
    const target = union(boxes[first], boxes[second]);
    const margin = Math.max(6, 10 * env.unit);
    const map = await node.map();
    // from below right: the start must be bare canvas, the end may lie on anything
    let start: Point | undefined;
    for (const extra of [1, 1.6, 2.4, 3.2]) {
      const at = aimAt(map, { x: right(target) + margin * extra, y: bottom(target) + margin * extra });
      const hit = await node.hit(at);
      if (bare(hit)) {
        start = at;
        break;
      }
    }
    if (!start) throw new Unmeasured("no bare canvas below right of the two shapes to start the lasso on");
    const end = aimAt(map, { x: target.x - margin, y: target.y - margin });
    const drawn: Box = { x: end.x, y: end.y, width: start.x - end.x, height: start.y - end.y };
    const shapes = Object.entries(boxes).filter(([id]) => (boxes[id]?.width ?? 0) > 0);
    const expected = shapes
      .filter(([, box]) => inside(box, drawn, 0))
      .map(([id]) => id)
      .sort();
    await board.page.keyboard.down("Shift");
    await board.drag(start, end, { keepDown: true, steps: 14 });
    await pause(ctx, 80);
    const frame = (await find(node, ".djs-lasso-overlay"))[0]?.box;
    await ctx.shot(frame ? [frame] : []);
    await board.release();
    await board.page.keyboard.up("Shift");
    await pause(ctx, 200);
    const all = await node.selected();
    const selected = all.filter((id) => id in boxes).sort();
    const frameError = frame ? Math.max(Math.abs(frame.x - end.x), Math.abs(frame.y - end.y)) : Number.NaN;
    const frameSize = frame ? { x: frame.width / drawn.width, y: frame.height / drawn.height } : null;
    Object.assign(row.measured, {
      drawn: bx(drawn),
      frame: frame ? bx(frame) : null,
      frameCornerErrorPx: frame ? r2(frameError) : null,
      frameOverDrawn: frameSize ? pt(frameSize) : null,
      expected,
      selected,
    });
    const same = expected.length === selected.length && expected.every((id, index) => id === selected[index]);
    const exact = !!frame && frameError <= unitSlack(env);
    return {
      verdict: same && exact ? "ok" : "broken",
      headline: `${selected.length} selected of ${expected.length} framed, frame ${frameSize ? pair(frameSize) : "none"}`,
    };
  },
});

/** the label editor a renderer opens: Event Storming's field over the sticky, Context Maps' direct editing box */
const EDITOR = ".event-storming-label-input, .djs-direct-editing-parent";
const EDITOR_TEXT = ".event-storming-label-input, .djs-direct-editing-content";

/** what a new shape takes on screen, generously: the drop spot must be clear of every other shape */
const roomFor = (ctx: Ctx): { width: number; height: number } => ({
  width: Math.max(40, 230 * ctx.env.unit),
  height: Math.max(30, 150 * ctx.env.unit),
});

/** the one shape that is new since `before`; throws Unmeasured when none or several appeared */
async function newShape(ctx: Ctx, before: readonly string[], what: string): Promise<{ id: string; box: Box }> {
  const fresh = await ctx.board.waitFor(async () => {
    const ids = await added(ctx.node, before);
    return ids.length > 0 ? ids : null;
  }, 2500);
  const boxes = await elementBoxes(ctx.node);
  // an append brings its arrow along: the shape is the one with an area
  const shapesOnly = (fresh ?? []).filter((id) => {
    const box = boxes[id];
    return !!box && box.width > 3 && box.height > 3 && !/^(arrow|rel)_/.test(id);
  });
  if (shapesOnly.length === 0) throw new Unmeasured(`${what}: no new shape appeared`);
  const id = shapesOnly[0]!;
  return { id, box: boxes[id]! };
}

/** closes whatever a create left open (a label editor, a kind popup), keeping the new shape where the renderer allows */
async function dismiss(ctx: Ctx): Promise<void> {
  await ctx.board.press("Escape");
  await pause(ctx, 120);
}

CASES.push({
  name: "create-palette-drag",
  notations: both,
  did: "dragged a palette entry onto a free spot of the canvas and released",
  expected: "the new shape's middle lies at the drop point and the file holds one shape more",
  why: "the palette drag is the first way to create; the ghost and the drop go through the engine's pointer math",
  rule: "error = |shape middle - drop point| in screen px; ok up to max(2, 1.5 units), degraded up to 3 times that, else broken; no new shape in the file is broken",
  async run(ctx) {
    const { node, row, sample, env } = ctx;
    const entry = (await find(node, `.djs-palette .entry[data-action="${sample.create}"]`))[0];
    if (!entry) throw new Unmeasured(`the palette has no entry ${sample.create}`);
    const hit = await node.hit(aimAt(await node.map(), centre(entry.box)));
    if (!hit.reachable || !hit.palette) throw new Blocked(`the palette entry ${sample.create} takes no press`);
    const drop = await freePoint(ctx, { size: roomFor(ctx) });
    const ids = await node.elementIds();
    const before = await fileAtRest(ctx, 100);
    const dragged = await node.paletteDrag(entry.box, drop, { hold: sample.hold });
    const shape = await newShape(ctx, ids, "palette drag");
    const editorOpen = (await find(node, EDITOR)).length > 0;
    await ctx.shot([shape.box]);
    await dismiss(ctx);
    const after = await fileAfter(ctx, before);
    const offset = { x: centre(shape.box).x - dragged.to.x, y: centre(shape.box).y - dragged.to.y };
    const error = Math.max(Math.abs(offset.x), Math.abs(offset.y));
    const gained = census(ctx.notation, after).shapes - census(ctx.notation, before).shapes;
    Object.assign(row.measured, {
      entry: sample.create,
      drop: pt(dragged.to),
      shape: bx(shape.box),
      offsetPx: pt(offset),
      errorPx: r2(error),
      shapesGained: gained,
      editorOpen,
    });
    const tight = unitSlack(env);
    return {
      verdict: gained === 1 ? placed(error, tight, 3 * tight) : "broken",
      headline: `off ${pair(offset, 1)} px`,
    };
  },
});

CASES.push({
  name: "create-palette-click",
  notations: both,
  did: "clicked a palette entry, moved to a free spot of the canvas and clicked there",
  expected: "the new shape's middle lies at the second click and the file holds one shape more",
  why: "click, move, click is the palette's second way to create: the shape follows the pointer until the click",
  rule: "error = |shape middle - click point| in screen px; ok up to max(2, 1.5 units), degraded up to 3 times that, else broken; no new shape in the file is broken",
  async run(ctx) {
    const { node, board, row, sample, env } = ctx;
    const entry = (await find(node, `.djs-palette .entry[data-action="${sample.create}"]`))[0];
    if (!entry) throw new Unmeasured(`the palette has no entry ${sample.create}`);
    const from = aimAt(await node.map(), centre(entry.box));
    const hit = await node.hit(from);
    if (!hit.reachable || !hit.palette) throw new Blocked(`the palette entry ${sample.create} takes no press`);
    const drop = await freePoint(ctx, { size: roomFor(ctx) });
    const ids = await node.elementIds();
    const before = await fileAtRest(ctx, 100);
    await board.click(from);
    await glide(ctx, from, drop, 14);
    await pause(ctx, 60);
    for (const key of sample.hold) await board.page.keyboard.down(key);
    await board.click(drop);
    for (const key of sample.hold) await board.page.keyboard.up(key);
    const shape = await newShape(ctx, ids, "palette click");
    const editorOpen = (await find(node, EDITOR)).length > 0;
    await ctx.shot([shape.box]);
    await dismiss(ctx);
    const after = await fileAfter(ctx, before);
    const offset = { x: centre(shape.box).x - drop.x, y: centre(shape.box).y - drop.y };
    const error = Math.max(Math.abs(offset.x), Math.abs(offset.y));
    const gained = census(ctx.notation, after).shapes - census(ctx.notation, before).shapes;
    Object.assign(row.measured, {
      entry: sample.create,
      click: pt(drop),
      shape: bx(shape.box),
      offsetPx: pt(offset),
      errorPx: r2(error),
      shapesGained: gained,
      editorOpen,
    });
    const tight = unitSlack(env);
    return {
      verdict: gained === 1 ? placed(error, tight, 3 * tight) : "broken",
      headline: `off ${pair(offset, 1)} px`,
    };
  },
});

/** the data-action of the palette entry that has the focus in the node's document, null when none has */
const focusedEntry = (node: NodeHandle): Promise<string | null> =>
  node.inDocument((host) => {
    const active = document.activeElement;
    return active && host.contains(active) && active.closest(".djs-palette")
      ? active.getAttribute("data-action")
      : null;
  });

CASES.push({
  name: "create-key-enter",
  notations: both,
  did: "went from the canvas to the palette with Shift + Tab, to the entry with the arrow keys, pressed Enter, typed a name and committed it",
  expected:
    "a new shape appears inside the visible editor with its label editor open, and the typed name is in the file",
  why: "Enter on a palette entry is the renderers' keyboard way to create: the shape goes to the middle of the free area the host names",
  rule: "ok when the shape lies wholly inside the editor's box on screen, is not under the palette, its editor opened and the name reached the file; degraded when it was created but lies partly outside or under chrome; broken when nothing was created or the name did not arrive",
  async run(ctx) {
    const { node, board, row, sample } = ctx;
    const ids = await node.elementIds();
    const before = await fileAtRest(ctx, 100);
    await board.press("Shift+Tab");
    await pause(ctx, 80);
    let focused = await focusedEntry(node);
    const path: Array<string | null> = [focused];
    for (let step = 0; step < 14 && focused !== null && focused !== sample.create; step++) {
      await board.press("ArrowRight");
      focused = await focusedEntry(node);
      path.push(focused);
    }
    row.measured.focusPath = path;
    if (focused !== sample.create) {
      throw new Unmeasured(
        `Shift + Tab and the arrow keys did not reach the palette entry (focus went ${path.join(" > ")})`,
      );
    }
    await board.press("Enter");
    const shape = await newShape(ctx, ids, "Enter on the palette entry");
    const editor = await settled(ctx, EDITOR);
    const host = await node.hostBox();
    const palette = (await find(node, ".djs-palette"))[0]?.box;
    await ctx.shot([shape.box]);
    const name = "Zed";
    if (editor) {
      // Context Maps opens the editor with the name in it and the caret behind; Event Storming selects it
      await board.press("Control+A");
      await board.type(name);
      await board.press(ctx.notation === "event-storming" ? "Control+Enter" : "Enter");
    }
    const after = await fileAfter(ctx, before);
    const gained = census(ctx.notation, after).shapes - census(ctx.notation, before).shapes;
    const named = after.includes(name) && !before.includes(name);
    const visible = inside(shape.box, host, 1);
    const underPalette = !!palette && overlaps(shape.box, palette);
    Object.assign(row.measured, {
      shape: bx(shape.box),
      offsetFromHostMiddlePx: pt({ x: centre(shape.box).x - centre(host).x, y: centre(shape.box).y - centre(host).y }),
      insideHost: visible,
      underPalette,
      editorOpen: !!editor,
      shapesGained: gained,
      nameInFile: named,
    });
    const verdict: Verdict =
      gained !== 1 || !editor || !named ? "broken" : visible && !underPalette ? "ok" : "degraded";
    return {
      verdict,
      headline: `${visible ? "inside" : "partly outside"}${underPalette ? ", under the palette" : ""}, name ${named ? "in file" : "missing"}`,
    };
  },
});

CASES.push({
  name: "create-key-pointer",
  notations: ["event-storming"],
  did: "moved the pointer over the canvas, pressed C (the Command key of the board), moved to a free spot and clicked",
  expected:
    "a command sticky follows the pointer and lands with its middle at the click; the file holds one sticky more",
  why: "E and C are Event Storming's own shortcuts: the create starts at the last pointer position the engine saw",
  rule: "error = |sticky middle - click point| in screen px; ok up to max(2, 1.5 units), degraded up to 3 times that, else broken; no new sticky is broken",
  async run(ctx) {
    const { node, board, row, sample, env } = ctx;
    const drop = await freePoint(ctx, { size: roomFor(ctx) });
    const host = await node.hostBox();
    const from = await freePoint(ctx, { prefer: { x: host.x + host.width * 0.6, y: host.y + host.height * 0.85 } });
    const ids = await node.elementIds();
    const before = await fileAtRest(ctx, 100);
    await glide(ctx, { x: from.x - 6, y: from.y - 6 }, from, 4);
    await board.press("c");
    await pause(ctx, 80);
    await glide(ctx, from, drop, 14);
    await pause(ctx, 60);
    for (const key of sample.hold) await board.page.keyboard.down(key);
    await board.click(drop);
    for (const key of sample.hold) await board.page.keyboard.up(key);
    const shape = await newShape(ctx, ids, "the C key");
    await ctx.shot([shape.box]);
    await dismiss(ctx);
    const after = await fileAfter(ctx, before);
    const offset = { x: centre(shape.box).x - drop.x, y: centre(shape.box).y - drop.y };
    const error = Math.max(Math.abs(offset.x), Math.abs(offset.y));
    const gained = census(ctx.notation, after).shapes - census(ctx.notation, before).shapes;
    Object.assign(row.measured, {
      click: pt(drop),
      shape: bx(shape.box),
      offsetPx: pt(offset),
      errorPx: r2(error),
      shapesGained: gained,
    });
    const tight = unitSlack(env);
    return {
      verdict: gained === 1 ? placed(error, tight, 3 * tight) : "broken",
      headline: `off ${pair(offset, 1)} px`,
    };
  },
});

/** the popup menu of diagram-js, once it rests */
const popupBox = (ctx: Ctx): Promise<Found | null> => settled(ctx, ".djs-popup");

/** the popup's entry `id` when it takes a press, else null */
async function popupEntry(ctx: Ctx, id: string): Promise<Found | null> {
  const entry = (await find(ctx.node, `.djs-popup .entry[data-id="${id}"]`))[0];
  if (!entry) return null;
  const hit = await ctx.node.hit(aimAt(await ctx.node.map(), centre(entry.box)));
  return hit.reachable && hit.popup ? entry : null;
}

/** the screen box of the top document's window: what a person can see at all */
const windowBox = (ctx: Ctx): Box => {
  const size = ctx.board.page.viewportSize() ?? { width: 0, height: 0 };
  return { x: 0, y: 0, width: size.width, height: size.height };
};

CASES.push({
  name: "append-click",
  notations: both,
  did: "selected a shape, clicked the pad's append entry (Event Storming: then clicked a free spot), chose a type in the menu that opens and, in Event Storming, typed a name",
  expected:
    "the new shape is where the person put it (Event Storming) or beside its source (Context Maps), the type menu opens at it, and the file holds one shape and one connection more, of the chosen type",
  why: "append is the pad's way to create a connected shape; it chains a create, a popup menu placed from client rectangles and a label editor",
  rule: "broken when the chain cannot be finished (no shape, no menu, the menu's entry takes no press, the file misses the shape or the connection); wrong-data when the file's type is not the chosen one; else ok when the menu is where diagram-js puts it for its anchor (Event Storming: 6 px under the sticky's lower left corner, within 8 chrome px + 2; Context Maps: 8 px beside the new shape's pad, its top between the pad's top and bottom) and, in Event Storming, the sticky within max(2, 1.5 units) of the click; degraded otherwise",
  async run(ctx) {
    const { node, board, row, sample, env } = ctx;
    const sources =
      ctx.notation === "event-storming"
        ? ["ext_payment_provider", "hot_double_payment_on_retry", "read_order_status"]
        : ["ctx_payment", "ctx_catalog", "ctx_legacy_erp"];
    const picked = await selectWithPad(ctx, sources, sample.append);
    const ids = await node.elementIds();
    const before = await fileAtRest(ctx, 100);
    const entryAt = await clickBox(ctx, picked.entry.box);
    let placeError = 0;
    if (ctx.notation === "event-storming") {
      // the blank sticky follows the pointer until the next click
      const drop = await freePoint(ctx, { size: roomFor(ctx) });
      await glide(ctx, entryAt, drop, 14);
      await pause(ctx, 60);
      await board.page.keyboard.down("Shift");
      await board.click(drop);
      await board.page.keyboard.up("Shift");
      const dropped = await newShape(ctx, ids, "the pad's append");
      const offset = { x: centre(dropped.box).x - drop.x, y: centre(dropped.box).y - drop.y };
      placeError = Math.max(Math.abs(offset.x), Math.abs(offset.y));
      Object.assign(row.measured, { click: pt(drop), offsetPx: pt(offset) });
    }
    const shape = await newShape(ctx, ids, "the pad's append");
    const popup = await popupBox(ctx);
    const host = await node.hostBox();
    Object.assign(row.measured, {
      source: picked.id,
      passedOver: picked.passed,
      shape: bx(shape.box),
      shapeInsideHost: inside(shape.box, host, 1),
    });
    if (!popup) {
      await ctx.shot([shape.box]);
      row.measured.popup = null;
      return { verdict: "broken", headline: "no type menu opened" };
    }
    const world = await worldOf(ctx);
    const fresh = (await node.elementBox(shape.id)) ?? shape.box;
    let off: Point;
    let place: string;
    let exact: boolean;
    if (ctx.notation === "event-storming") {
      // EventStormingAppendBehavior: under the sticky's lower left corner, 6 px down
      const edges = menuEdges(ctx, popup.box, world, { point: { x: fresh.x, y: bottom(fresh) + 6 * env.chrome } });
      const found = menuPlace(popup.box, edges.xs, edges.ys);
      [off, place] = [found.off, found.place];
      exact = found.error <= 8 * env.chrome + 2 && placeError <= unitSlack(env);
    } else {
      // CmContextPadProvider.openMenuOnPad: beside the new shape's own pad entry. The pad is clamped into the
      // container after the menu opened, so the menu's top lies somewhere along the pad
      const pad = (await find(node, ".djs-context-pad.open"))[0];
      const own = (await find(node, `.djs-context-pad.open .entry[data-action="${sample.kindEntry}"]`))[0];
      if (!pad || !own) throw new Unmeasured("the new context's pad shows no subdomain entry to anchor the menu at");
      const edges = menuEdges(ctx, popup.box, world, { entry: own.box });
      const found = menuPlace(popup.box, edges.xs, [[pad.box.y, ""], ...edges.ys.slice(1)]);
      const slack = 8 * env.chrome + 2;
      // flipped up at the lower edge of its document, it is the menu's bottom that lies along the pad
      const edgeY = found.place.includes("flipped up") ? bottom(popup.box) : popup.box.y;
      const along = edgeY >= pad.box.y - slack && edgeY <= bottom(pad.box) + slack;
      off = along ? { x: found.off.x, y: edgeY - pad.box.y } : found.off;
      place = found.place;
      exact = Math.abs(found.off.x) <= slack && (along || Math.abs(found.off.y) <= slack);
    }
    const share = await visibleShare(ctx, popup.box, ".djs-popup");
    await ctx.shot([shape.box, popup.box]);
    const choice = ctx.notation === "event-storming" ? "kind-policy" : "type-supporting";
    const chosen = await popupEntry(ctx, choice);
    Object.assign(row.measured, {
      popup: bx(popup.box),
      popupOffPx: pt(off),
      popupPlace: place,
      popupVisibleShare: r2(share),
      popupInsideHost: inside(popup.box, host, 1),
      entryReachable: !!chosen,
    });
    const headline = `menu off ${pair(off, 0)} px (${place}), ${Math.round(share * 100)}% visible`;
    if (!chosen) {
      await dismiss(ctx);
      return { verdict: "broken", headline: `${headline}, its entry takes no press` };
    }
    await clickBox(ctx, chosen.box);
    if (ctx.notation === "event-storming") {
      const editor = await settled(ctx, EDITOR);
      row.measured.editorOpen = !!editor;
      if (editor) {
        await board.type("Zed");
        await board.press("Control+Enter");
      }
    }
    const after = await fileAfter(ctx, before);
    const [was, now] = [census(ctx.notation, before), census(ctx.notation, after)];
    const typed =
      ctx.notation === "event-storming"
        ? /^policy Zed\b/m.test(after)
        : (JSON.parse(after) as { contexts: Array<{ id: string; subdomainType?: string }> }).contexts.some(
            (one) => !before.includes(`"${one.id}"`) && one.subdomainType === "supporting",
          );
    Object.assign(row.measured, {
      shapesGained: now.shapes - was.shapes,
      connectionsGained: now.connections - was.connections,
      chosenTypeInFile: typed,
    });
    if (now.shapes - was.shapes !== 1 || now.connections - was.connections !== 1) {
      return {
        verdict: "broken",
        headline: `file gained ${now.shapes - was.shapes} shapes, ${now.connections - was.connections} connections`,
      };
    }
    if (!typed) return { verdict: "wrong-data", headline: "the file holds another type than the chosen one" };
    return { verdict: exact && share >= 0.99 ? "ok" : "degraded", headline };
  },
});

CASES.push({
  name: "append-drag",
  notations: both,
  did: "selected a shape and dragged the pad's append entry onto a free spot of the canvas",
  expected: "the new shape's middle lies at the drop point, connected to its source",
  why: "the pad's append entry is draggable: the same create as from the palette, started from chrome the engine placed itself",
  rule: "error = |shape middle - drop point| in screen px; ok up to max(2, 1.5 units), degraded up to 3 times that, else broken; no new shape is broken",
  async run(ctx) {
    const { node, row, sample, env } = ctx;
    const sources =
      ctx.notation === "event-storming"
        ? ["ext_payment_provider", "hot_double_payment_on_retry", "read_order_status"]
        : ["ctx_payment", "ctx_catalog", "ctx_legacy_erp"];
    const picked = await selectWithPad(ctx, sources, sample.append);
    const entry = picked.entry;
    row.measured.source = picked.id;
    row.measured.passedOver = picked.passed;
    const drop = await freePoint(ctx, { size: roomFor(ctx) });
    const ids = await node.elementIds();
    const dragged = await node.paletteDrag(entry.box, drop, { hold: sample.hold });
    const shape = await newShape(ctx, ids, "the drag of the pad's append entry");
    const connections = (await added(node, ids)).filter((id) => id !== shape.id).length;
    await ctx.shot([shape.box]);
    const offset = { x: centre(shape.box).x - dragged.to.x, y: centre(shape.box).y - dragged.to.y };
    const error = Math.max(Math.abs(offset.x), Math.abs(offset.y));
    await dismiss(ctx);
    Object.assign(row.measured, {
      drop: pt(dragged.to),
      shape: bx(shape.box),
      offsetPx: pt(offset),
      errorPx: r2(error),
      connectionsDrawn: connections,
    });
    const tight = unitSlack(env);
    return {
      verdict: connections === 1 ? placed(error, tight, 3 * tight) : "broken",
      headline: `off ${pair(offset, 1)} px`,
    };
  },
});

/** the end of a connection the engine previews: the corner of the preview's box that is farthest from `from` */
async function previewEnd(ctx: Ctx, from: Point): Promise<Point | null> {
  const boxes = (await find(ctx.node, ".djs-connection-preview, .djs-dragger .djs-connection, g.djs-dragger path"))
    .map((one) => one.box)
    .filter((box) => box.width + box.height > 1);
  if (boxes.length === 0) return null;
  const box = union(...boxes);
  const corners = [
    { x: box.x, y: box.y },
    { x: right(box), y: box.y },
    { x: box.x, y: bottom(box) },
    { x: right(box), y: bottom(box) },
  ];
  return corners.sort((a, b) => distance(b, from) - distance(a, from))[0]!;
}

/** true when the file holds a connection from `from` to `to` that `before` did not hold */
function connected(notation: Notation, before: string, after: string, from: string, to: string): boolean {
  if (notation === "context-map") {
    const count = (text: string): number =>
      (JSON.parse(text) as { relationships: Array<{ from: string; to: string }> }).relationships.filter(
        (one) => (one.from === from && one.to === to) || (one.from === to && one.to === from),
      ).length;
    return count(after) === count(before) + 1;
  }
  // the board's arrows name their ends by label
  const line = /^Double payment on retry\? -> Payment Provider/m;
  return line.test(after) && !line.test(before);
}

for (const how of ["click", "drag"] as const) {
  CASES.push({
    name: `connect-${how}`,
    notations: both,
    did:
      how === "click"
        ? "selected a shape, clicked the pad's connect entry, moved over bare canvas to another shape and clicked it"
        : "selected a shape and dragged the pad's connect entry onto another shape",
    expected:
      "the preview line ends at the pointer on the way, and the file holds one connection more, between exactly these two shapes",
    why: "connecting is the second half of modelling: the target is found by the browser's hit test, the preview line by the engine's pointer math",
    rule: "wrong-data when a connection was written between other shapes; broken when none was written; else by the preview: ok when its end is within max(3, 2 units) of the pointer, degraded when further",
    async run(ctx) {
      const { node, board, row, sample, env } = ctx;
      const [from, to] = sample.connect;
      const fromBox = await node.elementBox(from);
      await select(ctx, from);
      const entry = await padEntry(ctx, "connect");
      const target = await pressPoint(ctx, to);
      const before = await fileAtRest(ctx, 100);
      const ids = await node.elementIds();
      const map = await node.map();
      const start = aimAt(map, centre(entry.box));
      // a point of bare canvas on the way, where nothing docks the preview
      const waypoint = await freePoint(ctx, {
        prefer: { x: (start.x + target.x) / 2, y: Math.max(start.y, target.y) + 50 * env.chrome },
      });
      let end: Point | null;
      if (how === "click") {
        await board.click(start);
        await glide(ctx, start, waypoint, 12);
        await pause(ctx, 80);
        end = fromBox ? await previewEnd(ctx, centre(fromBox)) : null;
        await ctx.shot();
        await glide(ctx, waypoint, target, 10);
        await pause(ctx, 60);
        await board.click(target);
      } else {
        const reach = Math.max(1, Math.min(entry.box.width, entry.box.height) / 2 - 2);
        await board.drag(start, waypoint, { keepDown: true, steps: 12, lead: [Math.min(4, reach)] });
        await pause(ctx, 80);
        end = fromBox ? await previewEnd(ctx, centre(fromBox)) : null;
        await ctx.shot();
        await glide(ctx, waypoint, target, 10);
        await pause(ctx, 60);
        await board.release();
      }
      await pause(ctx, 250);
      // Context Maps opens the pattern menu on a new relationship: leave it
      await dismiss(ctx);
      const after = await fileAfter(ctx, before);
      const gained = census(ctx.notation, after).connections - census(ctx.notation, before).connections;
      const right_ = gained === 1 && connected(ctx.notation, before, after, from, to);
      const previewError = end ? distance(end, waypoint) : Number.NaN;
      Object.assign(row.measured, {
        from,
        to,
        waypoint: pt(waypoint),
        previewEnd: end ? pt(end) : null,
        previewErrorPx: end ? r2(previewError) : null,
        connectionsGained: gained,
        betweenTheTwo: right_,
        drawn: (await added(node, ids)).length,
      });
      if (gained === 0) return { verdict: "broken", headline: "no connection written" };
      if (!right_)
        return { verdict: "wrong-data", headline: `${gained} connection(s) written, not between the two shapes` };
      const tight = Math.max(3, 2 * env.unit);
      return {
        verdict: end && previewError <= tight ? "ok" : "degraded",
        headline: `connected, preview ${end ? `${previewError.toFixed(1)} px off the pointer` : "not seen"}`,
      };
    },
  });
}

/** draws a three point line with Event Storming's draw tool; returns the drawing and the points clicked */
async function drawLine(ctx: Ctx): Promise<{ id: string; box: Box; points: Point[] }> {
  const { node, board, env } = ctx;
  const tool = (await find(node, '.djs-palette .entry[data-action="draw-tool"]'))[0];
  if (!tool) throw new Unmeasured("the palette has no draw tool");
  const toolAt = aimAt(await node.map(), centre(tool.box));
  const hit = await node.hit(toolAt);
  if (!hit.reachable || !hit.palette) throw new Blocked("the palette's draw tool takes no press");
  // three corners of a box that is clear of every shape: far enough apart that no click ends the line (12 units)
  const size = { width: Math.max(70, 150 * env.unit), height: Math.max(50, 90 * env.unit) };
  const middle = await freePoint(ctx, { size: { width: size.width + 16, height: size.height + 16 } });
  const map = await node.map();
  const points = [
    aimAt(map, { x: middle.x - size.width / 2, y: middle.y + size.height / 2 }),
    aimAt(map, { x: middle.x, y: middle.y - size.height / 2 }),
    aimAt(map, { x: middle.x + size.width / 2, y: middle.y + size.height / 2 }),
  ];
  const ids = await node.elementIds();
  await board.click(toolAt);
  await pause(ctx, 80);
  let last = toolAt;
  for (const point of points) {
    await glide(ctx, last, point, 6);
    await board.click(point);
    await pause(ctx, 60);
    last = point;
  }
  await board.press("Enter");
  const fresh = await board.waitFor(async () => {
    const now = await added(node, ids);
    return now.length > 0 ? now : null;
  }, 2500);
  if (!fresh) throw new Unmeasured("the draw tool made no drawing from three clicks and Enter");
  const box = await node.elementBox(fresh[0]!);
  if (!box) throw new Unmeasured("the drawing has no graphics");
  return { id: fresh[0]!, box, points };
}

CASES.push({
  name: "draw",
  notations: ["event-storming"],
  did: "armed the palette's draw tool, clicked three points on bare canvas and pressed Enter",
  expected: "the drawing's corners lie on the three clicked points and the file holds a drawing",
  why: "the draw tool converts client coordinates itself (its own toCanvasPoint), outside diagram-js's dragging",
  rule: "error = the largest distance between a side of the drawing's box and the box of the clicked points; ok up to max(3, 2 units), degraded up to 3 times that, else broken; no drawing in the file is broken",
  async run(ctx) {
    const { row, env } = ctx;
    const before = await fileAtRest(ctx, 100);
    const drawing = await drawLine(ctx);
    await ctx.shot([drawing.box]);
    const after = await fileAfter(ctx, before);
    const clicked = union(...drawing.points.map((point) => ({ x: point.x, y: point.y, width: 0, height: 0 })));
    const error = Math.max(
      Math.abs(drawing.box.x - clicked.x),
      Math.abs(drawing.box.y - clicked.y),
      Math.abs(right(drawing.box) - right(clicked)),
      Math.abs(bottom(drawing.box) - bottom(clicked)),
    );
    const inFile = /^line \[\[/m.test(after) && !/^line \[\[/m.test(before);
    Object.assign(row.measured, {
      clicked: bx(clicked),
      drawing: bx(drawing.box),
      sizeOverClicked: pt({ x: drawing.box.width / clicked.width, y: drawing.box.height / clicked.height }),
      errorPx: r2(error),
      drawingInFile: inFile,
    });
    const tight = Math.max(3, 2 * env.unit);
    return {
      verdict: inFile ? placed(error, tight, 3 * tight) : "broken",
      headline: `${error.toFixed(1)} px off, size ${pair({ x: drawing.box.width / clicked.width, y: drawing.box.height / clicked.height })}`,
    };
  },
});

CASES.push({
  name: "colour-picker",
  notations: ["event-storming"],
  did: "drew a line, clicked its pad's colour entry and chose the second swatch of the picker",
  expected:
    "the picker opens with its corner at the click (kept 4 px inside the editor), every swatch takes a press, and the file holds the drawing with the chosen colour",
  why: "the colour picker is the renderer's own popover: it places itself from the click's client coordinates minus the container's client origin",
  rule: "broken when the picker does not open, the swatch takes no press or no colour reaches the file; else ok when the picker's corner is within 4 chrome px + 2 of the click (clamped into the editor as the renderer does), degraded when further",
  async run(ctx) {
    const { node, row, env } = ctx;
    const start = await fileAtRest(ctx, 100);
    await drawLine(ctx);
    const entry = await padEntry(ctx, "color");
    const before = await fileAfter(ctx, start);
    const at = await clickBox(ctx, entry.box);
    const picker = await settled(ctx, ".event-storming-color-picker");
    if (!picker) return { verdict: "broken", headline: "no picker opened" };
    const swatches = await find(node, ".event-storming-color-picker .event-storming-cp-swatch");
    // EventStormingColorPicker.open: at the click, kept 4 px inside the canvas container
    const host = await node.hostBox();
    const edge = 4 * env.chrome;
    const meant = {
      x: Math.max(host.x + edge, Math.min(at.x, right(host) - picker.box.width - edge)),
      y: Math.max(host.y + edge, Math.min(at.y, bottom(host) - picker.box.height - edge)),
    };
    const off = { x: picker.box.x - meant.x, y: picker.box.y - meant.y };
    const error = Math.max(Math.abs(off.x), Math.abs(off.y));
    await ctx.shot([picker.box]);
    const swatch = swatches[1];
    const map = await node.map();
    const hits = await Promise.all(swatches.map((one) => node.hit(aimAt(map, centre(one.box)))));
    const pressable = hits.filter((hit) => hit.reachable && hit.what.includes("event-storming-cp-swatch")).length;
    Object.assign(row.measured, {
      click: pt(at),
      picker: bx(picker.box),
      offPx: pt(off),
      swatches: swatches.length,
      swatchesReachable: pressable,
      swatchPx: swatch ? r2(swatch.box.width) : null,
    });
    if (!swatch || !hits[1]?.reachable || !hits[1].what.includes("event-storming-cp-swatch")) {
      return { verdict: "broken", headline: `picker off ${pair(off, 0)} px, the swatch takes no press` };
    }
    await clickBox(ctx, swatch.box);
    const after = await fileAfter(ctx, before);
    const coloured = after !== before && /^line \[\[.*\(color #[0-9a-f]{6}\)/im.test(after);
    row.measured.colourInFile = coloured;
    row.measured.swatchTitle = swatch.title;
    if (!coloured) return { verdict: "broken", headline: "no colour reached the file" };
    return { verdict: error <= 4 * env.chrome + 2 ? "ok" : "degraded", headline: `picker off ${pair(off, 0)} px` };
  },
});

CASES.push({
  name: "resize-note",
  notations: ["event-storming"],
  did: "selected the note and dragged its lower right resize handle by (30, 20) flow units",
  expected: "the note's lower right corner travels as far as the pointer",
  why: "notes are the only shapes with resize handles; the resize goes through diagram-js's dragging",
  rule: "error = |growth of the note's box - pointer travel| in screen px; ok up to max(2, 1.5 units), degraded up to 3 times that, else broken",
  async run(ctx) {
    const { node, row, env } = ctx;
    const note = "note_design_level_session_checkout_flow";
    await select(ctx, note);
    const handle = await settled(ctx, ".djs-resizer-se .djs-resizer-hit, .djs-resizer-se");
    if (!handle) throw new Unmeasured("the selected note shows no lower right resize handle");
    const at = aimAt(await node.map(), centre(handle.box));
    const hit = await node.hit(at);
    if (!hit.reachable || !hit.what.includes("djs-resizer")) {
      throw new Unmeasured(`the resize handle takes no press (${hit.reachable ? hit.what : "outside the editor"})`);
    }
    const box = (await node.elementBox(note))!;
    const before = await ctx.board.fileText(ctx.file);
    const dragged = await node.drag(at, { x: 30 * ctx.zoom, y: 20 * ctx.zoom });
    const changed = (await ctx.board.waitForFileChange(ctx.file, before)) !== null;
    const after = (await node.elementBox(note))!;
    const grown = { x: after.width - box.width, y: after.height - box.height };
    const error = Math.max(Math.abs(grown.x - dragged.delta.x), Math.abs(grown.y - dragged.delta.y));
    const ratio = { x: grown.x / dragged.delta.x, y: grown.y / dragged.delta.y };
    await ctx.shot();
    Object.assign(row.measured, {
      handlePx: r2(handle.box.width),
      pointer: pt(dragged.delta),
      grown: pt(grown),
      ratio: pt(ratio),
      errorPx: r2(error),
      fileChanged: changed,
    });
    const tight = unitSlack(env);
    return { verdict: changed ? placed(error, tight, 3 * tight) : "broken", headline: pair(ratio) };
  },
});

CASES.push({
  name: "label-edit",
  notations: both,
  did: "double-clicked a shape, replaced its name with a typed one and committed (Event Storming: Control + Enter, Context Maps: Enter)",
  expected:
    "the editor box opens on its shape, its text is readable, and the file holds exactly the typed name on that shape",
  why: "the label editors are HTML boxes the renderers place themselves from the canvas's zoom and viewbox",
  rule: "wrong-data when the file holds another text than the typed one; broken when no editor opens or nothing is written; else ok when the editor's middle (Event Storming) or box (Context Maps) is within max(3, 2 units) of where the renderer means it and its font is at least 9 px on screen, degraded otherwise",
  async run(ctx) {
    const { node, board, row, sample, env } = ctx;
    const at = await pressPoint(ctx, sample.label);
    const shape = (await node.elementBox(sample.label))!;
    const before = await fileAtRest(ctx, 100);
    await board.doubleClick(at);
    const editor = await settled(ctx, EDITOR);
    if (!editor) {
      await ctx.shot();
      return { verdict: "broken", headline: "no editor opened" };
    }
    const text = (await find(node, EDITOR_TEXT))[0];
    let error: number;
    if (ctx.notation === "event-storming") {
      // a field centred on the sticky (translate(-50%, -50%)), at least 120 CSS px wide
      error = Math.max(
        Math.abs(centre(editor.box).x - centre(shape).x),
        Math.abs(centre(editor.box).y - centre(shape).y),
      );
    } else {
      // CmLabelEditing.activationContext: 10 units in from the sides, 36 units below the top, minus 1 px
      const meant = {
        x: shape.x + 10 * env.unit,
        y: shape.y + 36 * env.unit - env.chrome,
        width: shape.width - 20 * env.unit,
      };
      error = Math.max(
        Math.abs(editor.box.x - meant.x),
        Math.abs(editor.box.y - meant.y),
        Math.abs(editor.box.width - meant.width),
      );
    }
    await ctx.shot([editor.box]);
    const name = "Zed";
    await board.press("Control+A");
    await board.type(name);
    await board.press(ctx.notation === "event-storming" ? "Control+Enter" : "Enter");
    const after = await fileAfter(ctx, before);
    const written =
      ctx.notation === "event-storming"
        ? /^event Zed \[/m.test(after)
        : (JSON.parse(after) as { contexts: Array<{ id: string; label: string }> }).contexts.find(
            (one) => one.id === sample.label,
          )?.label === name;
    Object.assign(row.measured, {
      shape: bx(shape),
      editor: bx(editor.box),
      editorOverShape: pt({ x: editor.box.width / shape.width, y: editor.box.height / shape.height }),
      errorPx: r2(error),
      fontPx: r2(text?.font ?? editor.font),
      fileChanged: after !== before,
      typedNameInFile: written,
    });
    if (after === before) return { verdict: "broken", headline: "nothing written" };
    if (!written) return { verdict: "wrong-data", headline: "the file holds another text than the typed one" };
    const font = text?.font ?? editor.font;
    const exact = error <= Math.max(3, 2 * env.unit);
    return {
      verdict: exact && font >= READABLE_PX ? "ok" : "degraded",
      headline: `${error.toFixed(1)} px off, font ${font.toFixed(1)} px`,
    };
  },
});

CASES.push({
  name: "label-noop",
  notations: both,
  did: "opened the label editor twice and closed it without typing: once with Escape, once with a click on bare canvas",
  expected: "the file is byte-identical after both and the node is still armed",
  why: "opening an editor to look must not write: a write would show as a change of the model in the repository",
  rule: "wrong-data when the file differs after either way of closing; unmeasured when the editor did not open; broken when the click on bare canvas disarmed the node; else ok",
  async run(ctx) {
    const { node, board, row, sample } = ctx;
    const before = await fileAtRest(ctx, 100);
    const at = await pressPoint(ctx, sample.label);
    await board.doubleClick(at);
    const first = await settled(ctx, EDITOR);
    if (!first) throw new Unmeasured("the label editor did not open on a double-click");
    await board.press("Escape");
    await pause(ctx, 150);
    const closedByEscape = (await find(node, EDITOR)).length === 0;
    const afterEscape = await fileAtRest(ctx, 1000);
    await board.doubleClick(at);
    const second = await settled(ctx, EDITOR);
    if (!second) throw new Unmeasured("the label editor did not open a second time");
    const outside = await freePoint(ctx, { clear: [inflate(second.box, 8)] });
    await board.click(outside);
    await pause(ctx, 150);
    const closedByClick = (await find(node, EDITOR)).length === 0;
    const afterClick = await fileAtRest(ctx, 1000);
    const armed = (await node.state()).armed;
    await ctx.shot();
    Object.assign(row.measured, {
      closedByEscape,
      sameAfterEscape: afterEscape === before,
      closedByClick,
      sameAfterClick: afterClick === before,
      armed,
    });
    if (afterEscape !== before || afterClick !== before) {
      return { verdict: "wrong-data", headline: "the file changed without typing" };
    }
    return {
      verdict: armed && closedByEscape && closedByClick ? "ok" : "broken",
      headline: `file identical, ${armed ? "still armed" : "disarmed"}`,
    };
  },
});

/** selects the first of `ids` whose pad shows `action` where it takes a press; says which it passed over */
async function selectWithPad(
  ctx: Ctx,
  ids: readonly string[],
  action: string,
): Promise<{ id: string; entry: Found; passed: string[] }> {
  const passed: string[] = [];
  let blocked = false;
  for (const id of ids) {
    try {
      await select(ctx, id);
      const entry = await padEntry(ctx, action);
      return { id, entry, passed };
    } catch (error) {
      if (!(error instanceof Unmeasured) && !(error instanceof Blocked)) throw error;
      blocked ||= error instanceof Blocked;
      passed.push(`${id}: ${error.message}`);
      await ctx.board.press("Escape");
      await pause(ctx, 100);
    }
  }
  if (blocked) throw new Blocked(passed.join("; "));
  throw new Unmeasured(passed.join("; "));
}

CASES.push({
  name: "pad",
  notations: both,
  did: "selected a shape with a click and read its context pad",
  expected:
    "the pad stands at the shape's upper right corner, 12 diagram units to its right, inside the editor, and every entry takes a press",
  why: "diagram-js places the pad from the client rectangles of the shape and of its container",
  rule: "broken when an entry takes no press; else ok when the pad's corner is within 8 chrome px + 2 of the shape's right edge + 12 units and of its top, and the entries are at least 24 px on screen; degraded otherwise",
  async run(ctx) {
    const { node, row, sample, env } = ctx;
    await select(ctx, sample.padOf);
    const pad = await settled(ctx, ".djs-context-pad.open");
    if (!pad) return { verdict: "broken", headline: "no pad opened" };
    const shape = (await node.elementBox(sample.padOf))!;
    const entries = await find(node, ".djs-context-pad.open .entry");
    const host = await node.hostBox();
    const off = { x: pad.box.x - (right(shape) + 12 * env.unit), y: pad.box.y - shape.y };
    const error = Math.max(Math.abs(off.x), Math.abs(off.y));
    const map = await node.map();
    const unreachable: string[] = [];
    for (const entry of entries) {
      const hit = await node.hit(aimAt(map, centre(entry.box)));
      if (!hit.reachable || !hit.pad) {
        unreachable.push(`${entry.action ?? "?"}: ${hit.reachable ? hit.what : "outside the editor"}`);
      }
    }
    const pressable = entries.length - unreachable.length;
    const entryPx = entries[0] ? Math.min(entries[0].box.width, entries[0].box.height) : 0;
    await ctx.shot([pad.box]);
    Object.assign(row.measured, {
      shape: bx(shape),
      pad: bx(pad.box),
      offPx: pt(off),
      entries: entries.length,
      entriesReachable: pressable,
      unreachable,
      entryPx: r2(entryPx),
      padInsideHost: inside(pad.box, host, 1),
      padOverHostHeight: r2(pad.box.height / host.height),
    });
    const headline = `off ${pair(off, 0)} px, ${pressable}/${entries.length} entries, ${entryPx.toFixed(0)} px`;
    if (pressable < entries.length) return { verdict: "broken", headline };
    const exact = error <= 8 * env.chrome + 2;
    return { verdict: exact && entryPx >= TARGET_PX ? "ok" : "degraded", headline };
  },
});

/**
 * How far a menu lies from the nearest place diagram-js can give it for an anchor. PopupMenu's
 * _ensureVisible keeps the asked corner, or flips the menu to the other side of it on either axis,
 * or puts its top 10 px below the top of its document; Context Maps moves a menu that the flip put
 * over its pad entry to the entry's left. `xs` and `ys` are the left and top edges those rules
 * allow, in screen px. A menu at none of them was placed with wrong numbers.
 */
function menuPlace(
  popup: Box,
  xs: ReadonlyArray<readonly [number, string]>,
  ys: ReadonlyArray<readonly [number, string]>,
): { off: Point; error: number; place: string } {
  const nearest = (value: number, all: ReadonlyArray<readonly [number, string]>): readonly [number, string] =>
    [...all].sort((a, b) => Math.abs(value - a[0]) - Math.abs(value - b[0]))[0]!;
  const [x, y] = [nearest(popup.x, xs), nearest(popup.y, ys)];
  const off = { x: popup.x - x[0], y: popup.y - y[0] };
  const place = [x[1], y[1]].filter((name) => name !== "").join(", ") || "at its anchor";
  return { off, error: Math.max(Math.abs(off.x), Math.abs(off.y)), place };
}

/** the left and top edges a menu may take for an anchor point (Event Storming) or beside a pad entry (Context Maps) */
function menuEdges(
  ctx: Ctx,
  popup: Box,
  world: Box,
  anchor: { point: Point } | { entry: Box },
): { xs: Array<readonly [number, string]>; ys: Array<readonly [number, string]> } {
  const chrome = ctx.env.chrome;
  if ("point" in anchor) {
    return {
      xs: [
        [anchor.point.x, ""],
        [anchor.point.x - popup.width, "flipped left"],
      ],
      ys: [
        [anchor.point.y, ""],
        [anchor.point.y - popup.height, "flipped up"],
        [world.y + 10 * chrome, "at the top of its document"],
      ],
    };
  }
  return {
    xs: [
      [right(anchor.entry) + 8 * chrome, ""],
      [anchor.entry.x - 8 * chrome - popup.width, "left of its entry"],
      [world.x + 8 * chrome, "at the left edge of its document"],
    ],
    ys: [
      [anchor.entry.y, ""],
      [anchor.entry.y - popup.height, "flipped up"],
      [world.y + 10 * chrome, "at the top of its document"],
    ],
  };
}

/**
 * The document a popup is laid out in, on screen: the frame's box for a framed editor, else the
 * window. Where the node's document tells its editor a window of its own (measured, Env.space), that
 * one: diagram-js flips a menu and the renderers clamp their fixed boxes against what they are told.
 */
const worldOf = async (ctx: Ctx): Promise<Box> =>
  ctx.env.frame ? ctx.node.hostBox() : ctx.env.space.virtual ? ctx.env.space.window : windowBox(ctx);

/** how much of a box a person can see and press: the share of a 5 x 5 grid over it that hits `mark` */
async function visibleShare(ctx: Ctx, box: Box, mark: string): Promise<number> {
  const map = await ctx.node.map();
  let seen = 0;
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 5; column++) {
      const at = aimAt(map, { x: box.x + (box.width * (column + 0.5)) / 5, y: box.y + (box.height * (row + 0.5)) / 5 });
      const hit = await ctx.node.hit(at);
      const marked = await ctx.node.inDocument(
        (_host, arg) => {
          const native = (window as NativeWindow).__boardSpikeNative;
          const element = native
            ? native.elementFromPoint(document, arg.x, arg.y)
            : document.elementFromPoint(arg.x, arg.y);
          return !!element?.closest(arg.mark);
        },
        { ...(await localPoint(ctx, at)), mark },
      );
      if (hit.reachable && marked) seen++;
    }
  }
  return seen / 25;
}

/** a screen point in the coordinates of the node's own document */
async function localPoint(ctx: Ctx, at: Point): Promise<Point> {
  const map = await ctx.node.map();
  return { x: (at.x - map.x) / map.sx, y: (at.y - map.y) / map.sy };
}

interface MenuCase {
  name: string;
  notations: readonly Notation[];
  /** shapes or connections to try, the pad entry that opens the menu, the menu entry to choose */
  targets: Readonly<Partial<Record<Notation, readonly string[]>>>;
  entry: Readonly<Partial<Record<Notation, string>>>;
  choice: Readonly<Partial<Record<Notation, string>>>;
  /** true when the file shows the choice on the element */
  written(notation: Notation, text: string, element: string): boolean;
  what: string;
}

const MENUS: MenuCase[] = [
  {
    name: "popup-kind",
    notations: both,
    targets: {
      "event-storming": ["ext_payment_provider", "cmd_place_order", "event_order_placed"],
      "context-map": ["ctx_ordering", "ctx_catalog", "ctx_shipping"],
    },
    entry: { "event-storming": "change-kind", "context-map": "subdomain-type" },
    choice: { "event-storming": "kind-policy", "context-map": "type-generic" },
    written(notation, text, element) {
      if (notation === "event-storming") return /^policy (Payment Provider|Place Order|Order Placed) \[/m.test(text);
      const doc = JSON.parse(text) as { contexts: Array<{ id: string; subdomainType?: string }> };
      return doc.contexts.find((one) => one.id === element)?.subdomainType === "generic";
    },
    what: "the type menu of a shape (Event Storming: Change type, Context Maps: Subdomain type)",
  },
  {
    name: "popup-pattern",
    notations: ["context-map"],
    targets: { "context-map": ["rel_ordering_payment", "rel_ordering_shipping", "rel_catalog_ordering"] },
    entry: { "context-map": "pattern" },
    choice: { "context-map": "pattern-shared-kernel" },
    written(_notation, text, element) {
      const doc = JSON.parse(text) as { relationships: Array<{ id: string; pattern?: string }> };
      return doc.relationships.find((one) => one.id === element)?.pattern === "shared-kernel";
    },
    what: "the pattern menu of a relationship",
  },
];

for (const menu of MENUS) {
  CASES.push({
    name: menu.name,
    notations: menu.notations,
    did: `selected an element, clicked the pad entry that opens ${menu.what} and chose an entry the element does not have`,
    expected:
      "the menu opens at its anchor, wholly visible, every entry takes a press, and the file holds the choice on that element",
    why: "diagram-js lays the popup menu out with position: fixed and client coordinates; Event Storming anchors it at the click, Context Maps beside the pad entry",
    rule: "wrong-data when the file changed to something else than the choice; broken when the menu does not open, the chosen entry takes no press or nothing is written; else ok when the menu's corner is within 4 chrome px + 2 of a place diagram-js can give it for that anchor (the anchor itself, flipped to its other side, or 10 px below the top of its document) and the menu is wholly visible; degraded otherwise",
    async run(ctx) {
      const { node, row, env } = ctx;
      const targets = menu.targets[ctx.notation] ?? [];
      const picked = await selectWithPad(ctx, targets, menu.entry[ctx.notation]!);
      const before = await fileAtRest(ctx, 100);
      const at = await clickBox(ctx, picked.entry.box);
      const popup = await popupBox(ctx);
      if (!popup) {
        await ctx.shot();
        return { verdict: "broken", headline: "no menu opened" };
      }
      const world = await worldOf(ctx);
      // Event Storming: at the click. Context Maps: 8 px beside the pad entry
      const edges = menuEdges(
        ctx,
        popup.box,
        world,
        ctx.notation === "event-storming" ? { point: at } : { entry: picked.entry.box },
      );
      const { off, error, place } = menuPlace(popup.box, edges.xs, edges.ys);
      // a long menu scrolls inside its box: only the entries the box shows are there to press
      const all = await find(node, ".djs-popup .entry");
      const entries = all.filter((entry) => inside(around(centre(entry.box), 1, 1), popup.box, 0));
      const pressable = await reachable(ctx, entries, "popup");
      const share = await visibleShare(ctx, popup.box, ".djs-popup");
      await ctx.shot([popup.box]);
      Object.assign(row.measured, {
        element: picked.id,
        passedOver: picked.passed,
        anchor: pt(at),
        popup: bx(popup.box),
        offPx: pt(off),
        place,
        entries: all.length,
        entriesShown: entries.length,
        entriesReachable: pressable,
        entryHeightPx: entries[0] ? r2(entries[0].box.height) : null,
        fontPx: entries[0] ? r2(entries[0].font) : null,
        visibleShare: r2(share),
        insideHost: inside(popup.box, await node.hostBox(), 1),
      });
      const chosen = await popupEntry(ctx, menu.choice[ctx.notation]!);
      const headline = `off ${pair(off, 0)} px (${place}), ${popup.box.width.toFixed(0)}x${popup.box.height.toFixed(0)}, ${pressable}/${entries.length} entries, ${Math.round(share * 100)}% visible`;
      if (!chosen) {
        await dismiss(ctx);
        return { verdict: "broken", headline };
      }
      await clickBox(ctx, chosen.box);
      const after = await fileAfter(ctx, before);
      const written = after !== before && menu.written(ctx.notation, after, picked.id);
      row.measured.fileChanged = after !== before;
      row.measured.choiceInFile = written;
      if (after === before) return { verdict: "broken", headline: `${headline}, nothing written` };
      if (!written) return { verdict: "wrong-data", headline: `${headline}, the file holds another choice` };
      const exact = error <= 4 * env.chrome + 2 && share >= 0.99 && pressable === entries.length;
      return { verdict: exact ? "ok" : "degraded", headline };
    },
  });
}

CASES.push({
  name: "popup-roles",
  notations: ["context-map"],
  did: "selected an upstream-downstream relationship, opened the pad's integration roles menu and switched Open Host Service on",
  expected:
    "the file holds the role on that relationship, and the menu, which the renderer reopens after every choice, comes back at the same place",
  why: "the roles menu stays open across choices: the renderer reopens it at the position it stored, in client coordinates",
  rule: "wrong-data when the file holds another role; broken when the menu or its entry takes no press or nothing is written; else ok when the reopened menu is within 2 px of the first one, degraded otherwise",
  async run(ctx) {
    const { row } = ctx;
    const picked = await selectWithPad(ctx, ["rel_shipping_erp", "rel_catalog_ordering"], "roles");
    const before = await fileAtRest(ctx, 100);
    await clickBox(ctx, picked.entry.box);
    const popup = await popupBox(ctx);
    if (!popup) return { verdict: "broken", headline: "no menu opened" };
    const chosen = await popupEntry(ctx, "upstream-OHS");
    await ctx.shot([popup.box]);
    if (!chosen) {
      await dismiss(ctx);
      return { verdict: "broken", headline: "the role's entry takes no press" };
    }
    await clickBox(ctx, chosen.box);
    await pause(ctx, 200);
    const again = await popupBox(ctx);
    const after = await fileAfter(ctx, before);
    const doc = JSON.parse(after) as { relationships: Array<{ id: string; upstreamRoles?: string[] }> };
    const roles = doc.relationships.find((one) => one.id === picked.id)?.upstreamRoles ?? [];
    const drift = again
      ? Math.max(Math.abs(again.box.x - popup.box.x), Math.abs(again.box.y - popup.box.y))
      : Number.NaN;
    await dismiss(ctx);
    Object.assign(row.measured, {
      element: picked.id,
      popup: bx(popup.box),
      reopened: again ? bx(again.box) : null,
      driftPx: again ? r2(drift) : null,
      upstreamRoles: roles,
      fileChanged: after !== before,
    });
    if (after === before) return { verdict: "broken", headline: "nothing written" };
    if (!roles.includes("OHS"))
      return { verdict: "wrong-data", headline: `the file holds ${roles.join(", ") || "no role"}` };
    return {
      verdict: again && drift <= 2 ? "ok" : "degraded",
      headline: again ? `role written, reopened ${drift.toFixed(1)} px away` : "role written, the menu did not reopen",
    };
  },
});

for (const where of ["middle", "edge"] as const) {
  CASES.push({
    name: where === "middle" ? "pad-prompt" : "pad-prompt-edge",
    notations: ["context-map"],
    did:
      where === "middle"
        ? "selected a context in the middle, clicked the pad's description entry, typed a text into the prompt and saved with Control + Enter"
        : "selected a context at the editor's right edge, clicked the pad's description entry, typed a text and saved with Control + Enter",
    expected:
      "the prompt opens 8 px right of the pad entry (left of it at the window's edge), wholly visible, the diagram stays where it is, and the file holds the typed description",
    why: "the prompt is the renderer's own position: fixed box, appended to its canvas container and placed with client coordinates against window.innerWidth and innerHeight",
    rule: "wrong-data when the file holds another text; broken when the prompt does not open, nothing is written or the canvas container is left scrolled after it closed; else ok when its corner is within 4 chrome px + 2 of its place, all of it is visible and the canvas did not scroll under it; degraded otherwise",
    async run(ctx) {
      const { node, board, row, env } = ctx;
      const targets = where === "middle" ? ["ctx_ordering", "ctx_catalog"] : ["ctx_shipping", "ctx_legacy_erp"];
      const picked = await selectWithPad(ctx, targets, "description");
      const before = await fileAtRest(ctx, 100);
      await clickBox(ctx, picked.entry.box);
      const prompt = await settled(ctx, ".cm-pad-prompt");
      if (!prompt) {
        await ctx.shot();
        return { verdict: "broken", headline: "no prompt opened" };
      }
      // the pad may have moved with the canvas since the click: read the entry again
      const entry =
        (await find(node, '.djs-context-pad.open .entry[data-action="description"]'))[0]?.box ?? picked.entry.box;
      // CmContextPadProvider (jr): right of the entry; left of it when it would pass the window's right edge less 8 px
      const world = await worldOf(ctx);
      let meant = { x: right(entry) + 8 * env.chrome, y: entry.y };
      if (meant.x + prompt.box.width > right(world) - 8 * env.chrome) {
        meant = { x: Math.max(world.x + 8 * env.chrome, entry.x - prompt.box.width - 8 * env.chrome), y: meant.y };
      }
      if (meant.y + prompt.box.height > bottom(world) - 8 * env.chrome) {
        meant = {
          x: meant.x,
          y: Math.max(world.y + 8 * env.chrome, bottom(world) - 8 * env.chrome - prompt.box.height),
        };
      }
      const off = { x: prompt.box.x - meant.x, y: prompt.box.y - meant.y };
      const error = Math.max(Math.abs(off.x), Math.abs(off.y));
      const share = await visibleShare(ctx, prompt.box, ".cm-pad-prompt");
      const field = (await find(node, ".cm-pad-prompt__field"))[0];
      const scrolledOpen = await scrolledBy(node);
      await ctx.shot([prompt.box]);
      const text = "Zed text";
      await board.type(text);
      await board.press("Control+Enter");
      const after = await fileAfter(ctx, before);
      const doc = JSON.parse(after) as { contexts: Array<{ id: string; description?: string }> };
      const stored = doc.contexts.find((one) => one.id === picked.id)?.description ?? "";
      const scrolledAfter = await scrolledBy(node);
      Object.assign(row.measured, {
        element: picked.id,
        passedOver: picked.passed,
        entry: bx(entry),
        prompt: bx(prompt.box),
        offPx: pt(off),
        visibleShare: r2(share),
        insideHost: inside(prompt.box, await node.hostBox(), 1),
        fontPx: field ? r2(field.font) : null,
        position: prompt.position,
        containerScrolledWhileOpen: scrolledOpen,
        containerScrolledAfter: scrolledAfter,
        fileChanged: after !== before,
        stored,
      });
      const headline = `off ${pair(off, 0)} px, ${prompt.box.width.toFixed(0)}x${prompt.box.height.toFixed(0)}, ${Math.round(share * 100)}% visible`;
      if (after === before) return { verdict: "broken", headline: `${headline}, nothing written` };
      if (!stored.endsWith(text)) {
        return { verdict: "wrong-data", headline: `${headline}, the file holds another text` };
      }
      const stuck = Math.abs(scrolledAfter.x) + Math.abs(scrolledAfter.y) > 0.5;
      const jumped = Math.abs(scrolledOpen.x) + Math.abs(scrolledOpen.y) > 0.5;
      if (stuck) {
        return {
          verdict: "broken",
          headline: `${headline}, the canvas container stays scrolled by ${scrolledAfter.x}/${scrolledAfter.y} px`,
        };
      }
      return {
        verdict: error <= 4 * env.chrome + 2 && share >= 0.99 && !jumped ? "ok" : "degraded",
        headline: jumped
          ? `${headline}, the canvas scrolled by ${scrolledOpen.x}/${scrolledOpen.y} px while it was open`
          : headline,
      };
    },
  });
}

CASES.push({
  name: "palette",
  notations: both,
  did: "armed the node and read the palette as it lies in the editor",
  expected:
    "the palette lies inside the editor in one row, every entry takes a press and is at least 24 px on screen, and it covers no shape",
  why: "the palettes are a toolbar at the top centre that wraps into more rows in a host up to 760 CSS px wide; in a small node it competes with the diagram",
  rule: "broken when an entry takes no press; else ok when the palette is inside the editor's box, in one row, its entries at least 24 px and no shape's middle lies under it; degraded otherwise",
  async run(ctx) {
    const { node, row } = ctx;
    const palette = (await find(node, ".djs-palette"))[0];
    if (!palette) return { verdict: "broken", headline: "no palette" };
    const entries = await find(node, ".djs-palette .entry");
    const host = await node.hostBox();
    const rows = new Set(entries.map((entry) => Math.round(entry.box.y))).size;
    const pressable = await reachable(ctx, entries, "palette");
    const entryPx = entries[0] ? Math.min(entries[0].box.width, entries[0].box.height) : 0;
    const boxes = await elementBoxes(node);
    const map = await node.map();
    let covered = 0;
    let shapes = 0;
    for (const [id, box] of Object.entries(boxes)) {
      if (/^(arrow|rel)_/.test(id) || !overlaps(box, host)) continue;
      shapes++;
      if ((await node.hit(aimAt(map, centre(box)))).palette) covered++;
    }
    await ctx.shot();
    Object.assign(row.measured, {
      palette: bx(palette.box),
      hostWidthCssPx: ctx.env.hostLayout.width,
      rows,
      entries: entries.length,
      entriesReachable: pressable,
      entryPx: r2(entryPx),
      insideHost: inside(palette.box, host, 1),
      paletteOverHostWidth: r2(palette.box.width / host.width),
      paletteOverHostHeight: r2(palette.box.height / host.height),
      shapesInView: shapes,
      shapesUnderPalette: covered,
    });
    const headline = `${pressable}/${entries.length} entries, ${rows} row(s), ${entryPx.toFixed(0)} px, ${covered} shape(s) under it`;
    if (pressable < entries.length) return { verdict: "broken", headline };
    const fine = inside(palette.box, host, 1) && rows === 1 && entryPx >= TARGET_PX && covered === 0;
    return { verdict: fine ? "ok" : "degraded", headline };
  },
});

CASES.push({
  name: "palette-tooltip",
  notations: both,
  did: "rested the pointer on a palette entry until its tooltip showed",
  expected: "the tooltip stands 8 px below the palette, centred under its entry (12 px clear of the editor's sides)",
  why: "the renderers bring a palette tooltip of their own and place it from client rectangles relative to the canvas container",
  rule: "broken when no tooltip shows or it lies further from its entry's middle than half an entry (it then reads as a neighbour's); ok when within 2 chrome px + 2; degraded between",
  async run(ctx) {
    const { node, row, sample, env } = ctx;
    const entry = (await find(node, `.djs-palette .entry[data-action="${sample.create}"]`))[0];
    const palette = (await find(node, ".djs-palette"))[0];
    if (!entry || !palette) throw new Unmeasured("no palette entry to hover");
    const at = aimAt(await node.map(), centre(entry.box));
    const hit = await node.hit(at);
    if (!hit.reachable || !hit.palette) throw new Unmeasured("the palette entry takes no pointer");
    await glide(ctx, { x: at.x, y: at.y + 30 * env.chrome }, at, 6);
    const tip = await settled(ctx, ".djs-hover-tooltip");
    await ctx.shot(tip ? [tip.box] : []);
    if (!tip) return { verdict: "broken", headline: "no tooltip" };
    const host = await node.hostBox();
    // centred under the entry, kept 12 px inside the container
    const half = tip.box.width / 2;
    const meantX = Math.max(
      host.x + 12 * env.chrome + half,
      Math.min(centre(entry.box).x, right(host) - 12 * env.chrome - half),
    );
    const off = { x: centre(tip.box).x - meantX, y: tip.box.y - (bottom(palette.box) + 8 * env.chrome) };
    const error = Math.max(Math.abs(off.x), Math.abs(off.y));
    Object.assign(row.measured, {
      entry: bx(entry.box),
      tooltip: bx(tip.box),
      text: tip.text,
      offPx: pt(off),
      fontPx: r2(tip.font),
      insideHost: inside(tip.box, host, 1),
    });
    const headline = `off ${pair(off, 0)} px, font ${tip.font.toFixed(1)} px`;
    if (error > Math.max(entry.box.width, entry.box.height) / 2) return { verdict: "broken", headline };
    return { verdict: error <= 2 * env.chrome + 2 ? "ok" : "degraded", headline };
  },
});

CASES.push({
  name: "pan",
  notations: both,
  did: "pressed on bare canvas and dragged by (60, 40) flow units",
  expected: "the diagram travels as far as the pointer, the board's viewport stays, the file stays",
  why: "a drag on the editor's ground pans the diagram (MoveCanvas): the board must not take it, and the travel is the engine's pointer math",
  rule: "broken when the board's viewport or the file changed or the node was disarmed; else error = |diagram travel - pointer|: ok up to max(2, 1.5 units), degraded up to 3 times that, else broken",
  async run(ctx) {
    const { node, board, row, sample, env } = ctx;
    const from = await freePoint(ctx, {});
    const reference = sample.movers[0]!;
    const box = await node.elementBox(reference);
    if (!box) throw new Unmeasured(`${reference} is not drawn`);
    const [viewport, file] = [await board.viewport(), await fileAtRest(ctx, 100)];
    const dragged = await node.drag(from, { x: TRAVEL.x * ctx.zoom, y: TRAVEL.y * ctx.zoom });
    await pause(ctx, 250);
    const after = (await node.elementBox(reference))!;
    const moved = { x: after.x - box.x, y: after.y - box.y };
    const error = Math.max(Math.abs(moved.x - dragged.delta.x), Math.abs(moved.y - dragged.delta.y));
    const ratio = { x: moved.x / dragged.delta.x, y: moved.y / dragged.delta.y };
    const now = await board.viewport();
    const boardStayed = now.x === viewport.x && now.y === viewport.y && now.zoom === viewport.zoom;
    const fileSame = (await fileAtRest(ctx)) === file;
    const armed = (await node.state()).armed;
    await ctx.shot();
    Object.assign(row.measured, {
      pointer: pt(dragged.delta),
      moved: pt(moved),
      ratio: pt(ratio),
      errorPx: r2(error),
      boardViewportStayed: boardStayed,
      fileSame,
      armed,
    });
    if (!boardStayed || !fileSame || !armed)
      return { verdict: "broken", headline: `${pair(ratio)}, board or file touched` };
    const tight = unitSlack(env);
    return { verdict: placed(error, tight, 3 * tight), headline: pair(ratio) };
  },
});

/** a shape whose upper left corner lies on the visible canvas, clear of chrome: where a wheel is turned */
async function wheelSpot(ctx: Ctx): Promise<{ id: string; box: Box; at: Point }> {
  const map = await ctx.node.map();
  const seen: string[] = [];
  for (const id of ctx.sample.movers) {
    const box = await ctx.node.elementBox(id);
    if (!box) continue;
    const at = aimAt(map, { x: box.x, y: box.y });
    const hit = await ctx.node.hit(at);
    if (hit.reachable && !hit.palette && !hit.pad && !hit.popup) return { id, box, at };
    seen.push(`${id}: ${hit.reachable ? hit.what : "outside the editor"}`);
  }
  throw new Unmeasured(`no shape's corner is clear of chrome (${seen.join("; ")})`);
}

const sameView = (a: { x: number; y: number; zoom: number }, b: { x: number; y: number; zoom: number }): boolean =>
  a.x === b.x && a.y === b.y && a.zoom === b.zoom;

CASES.push({
  name: "wheel",
  notations: both,
  did: "held Control and turned the wheel three notches in over a shape's corner, then turned it once without Control",
  expected:
    "the diagram zooms around the pointer (the corner stays under it), the plain wheel scrolls the diagram, and the board's viewport stays through both",
  why: "diagram-js zooms about the pointer's position, converted with the container's client rectangle; the board must not zoom under an armed editor",
  rule: "broken when the board's viewport changed or the diagram did not zoom; else drift = how far the corner left the pointer: ok up to max(2, 1.5 units), degraded up to 8 px, else broken",
  async run(ctx) {
    const { node, board, row, env } = ctx;
    const spot = await wheelSpot(ctx);
    const viewport = await board.viewport();
    const unitBefore = (await node.diagramScale()) ?? 0;
    await recordEvents(board.page, ["wheel"]);
    if (node.frame) await recordEvents(node.frame, ["wheel"]);
    for (let notch = 0; notch < 3; notch++) {
      await board.wheel(spot.at, -100, { hold: ["Control"] });
      await pause(ctx, 60);
    }
    await pause(ctx, 250);
    const zoomed = (await node.elementBox(spot.id))!;
    const unitAfter = (await node.diagramScale()) ?? 0;
    // the pointer was aimed at the corner within a px of the node's document: the corner should not have moved
    const drift = { x: zoomed.x - spot.box.x, y: zoomed.y - spot.box.y };
    const driftPx = Math.max(Math.abs(drift.x), Math.abs(drift.y));
    const afterZoom = await board.viewport();
    await board.wheel(spot.at, 100);
    await pause(ctx, 250);
    const scrolled = (await node.elementBox(spot.id))!;
    const afterScroll = await board.viewport();
    const topWheels = (await seenEvents(board.page, "wheel")).filter((event) => event.trusted).length;
    const nodeWheels = node.frame ? (await seenEvents(node.frame, "wheel")).filter((event) => event.trusted).length : 0;
    await ctx.shot();
    Object.assign(row.measured, {
      element: spot.id,
      scaleRatio: r2(unitAfter / unitBefore),
      cornerDriftPx: pt(drift),
      boardStayedOnZoom: sameView(viewport, afterZoom),
      plainWheelMovedDiagramPx: pt({ x: scrolled.x - zoomed.x, y: scrolled.y - zoomed.y }),
      boardStayedOnScroll: sameView(afterZoom, afterScroll),
      wheelEventsTopDocument: topWheels,
      wheelEventsNodeDocument: nodeWheels,
    });
    const headline = `x${(unitAfter / unitBefore).toFixed(2)}, corner drifts ${driftPx.toFixed(1)} px`;
    if (!sameView(viewport, afterZoom) || !sameView(afterZoom, afterScroll)) {
      return { verdict: "broken", headline: `${headline}, the board moved` };
    }
    if (Math.abs(unitAfter / unitBefore - 1) < 0.01) return { verdict: "broken", headline: `${headline}, no zoom` };
    return { verdict: placed(driftPx, unitSlack(env), 8), headline };
  },
});

CASES.push({
  name: "wheel-out",
  notations: both,
  did: "held Control and turned the wheel three notches out over a shape's corner",
  expected:
    "the diagram shrinks about the pointer as far as it grew on three notches in (to about 0.65 of its scale), and the board's viewport stays",
  why: "diagram-js stops zooming out at a canvas scale of 0.2; where a strategy shows a small node by scaling the canvas itself, the first view already sits near that floor",
  rule: "broken when the board's viewport changed or the diagram did not shrink at all; degraded when it shrank to more than 0.8 of its scale (the engine's floor cut the zoom short) or the corner drifted more than max(2, 1.5 units); else ok",
  async run(ctx) {
    const { node, board, row, env } = ctx;
    const spot = await wheelSpot(ctx);
    const viewport = await board.viewport();
    const unitBefore = (await node.diagramScale()) ?? 0;
    for (let notch = 0; notch < 3; notch++) {
      await board.wheel(spot.at, 100, { hold: ["Control"] });
      await pause(ctx, 60);
    }
    await pause(ctx, 250);
    const zoomed = (await node.elementBox(spot.id))!;
    const unitAfter = (await node.diagramScale()) ?? 0;
    const drift = { x: zoomed.x - spot.box.x, y: zoomed.y - spot.box.y };
    const driftPx = Math.max(Math.abs(drift.x), Math.abs(drift.y));
    const stayed = sameView(viewport, await board.viewport());
    const ratio = unitAfter / unitBefore;
    await ctx.shot();
    Object.assign(row.measured, {
      element: spot.id,
      // canvas px per diagram unit in the editor's own document: what diagram-js clamps at 0.2
      canvasScaleBefore: r2(unitBefore / env.chrome),
      canvasScaleAfter: r2(unitAfter / env.chrome),
      scaleRatio: r2(ratio),
      cornerDriftPx: pt(drift),
      boardStayed: stayed,
    });
    const headline = `x${ratio.toFixed(2)} (canvas scale ${(unitBefore / env.chrome).toFixed(2)} to ${(unitAfter / env.chrome).toFixed(2)}), corner drifts ${driftPx.toFixed(1)} px`;
    if (!stayed) return { verdict: "broken", headline: `${headline}, the board moved` };
    if (ratio > 0.99) return { verdict: "broken", headline: `${headline}, no zoom out` };
    return { verdict: ratio <= 0.8 && driftPx <= unitSlack(env) ? "ok" : "degraded", headline };
  },
});

CASES.push({
  name: "keys",
  notations: both,
  did: "selected a shape and pressed Delete, Control + Z, Control + Y, Control + Z, then Control + A",
  expected:
    "the shape goes, comes back, goes and comes back in the editor and in the file; Control + A selects the diagram's elements; the board keeps its nodes and stays armed",
  why: "several editors share one page: a key must act in the armed editor and nowhere else",
  rule: "broken when a key did not act in the editor, the board file changed or the node was disarmed; else ok",
  async run(ctx) {
    const { node, board, row, sample } = ctx;
    const target = sample.padOf;
    await select(ctx, target);
    const original = await fileAtRest(ctx, 100);
    const nodesBefore = (await board.nodes()).length;
    await recordEvents(board.page, ["keydown"]);
    if (node.frame) await recordEvents(node.frame, ["keydown"]);
    const drawn = async (): Promise<boolean> => (await node.elementIds()).includes(target);
    const steps: Record<string, boolean> = {};
    await board.press("Delete");
    await pause(ctx, 200);
    steps.deleteRemoved = !(await drawn());
    const afterDelete = await fileAfter(ctx, original);
    steps.deleteInFile = afterDelete !== original;
    await board.press("Control+z");
    await pause(ctx, 200);
    steps.undoRestored = await drawn();
    // Event Storming writes the restored sticky and its arrows at the end of their blocks: the same lines in another order
    const afterUndo = await fileAfter(ctx, afterDelete);
    steps.undoInFile = sameLines(afterUndo, original);
    row.measured.undoByteIdentical = afterUndo === original;
    await board.press("Control+y");
    await pause(ctx, 200);
    steps.redoRemoved = !(await drawn());
    await board.press("Control+z");
    await pause(ctx, 200);
    steps.undoAgainRestored = await drawn();
    await board.press("Control+a");
    await pause(ctx, 200);
    const selected = (await node.selected()).length;
    const shapes = Object.keys(await elementBoxes(node)).length;
    steps.selectAll = selected >= 2;
    const armed = (await node.state()).armed;
    const nodesAfter = (await board.nodes()).length;
    const topKeys = (await seenEvents(board.page, "keydown")).filter((event) => event.trusted).length;
    const nodeKeys = node.frame ? (await seenEvents(node.frame, "keydown")).filter((event) => event.trusted).length : 0;
    await ctx.shot();
    Object.assign(row.measured, {
      ...steps,
      selectedByControlA: selected,
      elementsDrawn: shapes,
      armed,
      boardNodes: nodesAfter - nodesBefore,
      keydownsTopDocument: topKeys,
      keydownsNodeDocument: nodeKeys,
      fileRestored: sameLines(await fileAtRest(ctx), original),
    });
    const acted = Object.values(steps).filter(Boolean).length;
    const total = Object.keys(steps).length;
    return {
      verdict: acted === total && armed && nodesAfter === nodesBefore ? "ok" : "broken",
      headline: `${acted}/${total} keys acted, keydowns top ${topKeys} / node ${nodeKeys}`,
    };
  },
});

CASES.push({
  name: "keys-own",
  notations: ["event-storming"],
  did: "selected a sticky and pressed Arrow Right, Shift + Arrow Right, Control + D and L",
  expected: "the sticky moves 2 and then 10 diagram units to the right, a duplicate appears, and L arms the lasso tool",
  why: "these are the board's own shortcuts, bound by a listener on the document that acts only for a key aimed at its own canvas",
  rule: "broken when a key did not act or the board file changed; else ok when the two nudges are within 1 px of 2 and 10 units on screen",
  async run(ctx) {
    const { node, board, row, env } = ctx;
    const target = "ext_payment_provider";
    await select(ctx, target);
    const start = (await node.elementBox(target))!;
    const count = (await node.elementIds()).length;
    await board.press("ArrowRight");
    await pause(ctx, 200);
    const small = (await node.elementBox(target))!;
    await board.press("Shift+ArrowRight");
    await pause(ctx, 200);
    const large = (await node.elementBox(target))!;
    await board.press("Control+d");
    await pause(ctx, 300);
    const duplicated = (await node.elementIds()).length - count;
    await board.press("Escape");
    const host = await node.hostBox();
    await board.move({ x: host.x + host.width * 0.5, y: host.y + host.height * 0.9 }, 4);
    await board.press("l");
    await pause(ctx, 200);
    const lasso = (await find(node, '.djs-palette .entry[data-action="lasso-tool"]'))[0];
    await ctx.shot();
    await board.press("Escape");
    const nudges = { small: (small.x - start.x) / env.unit, large: (large.x - small.x) / env.unit };
    Object.assign(row.measured, {
      nudgeUnits: pt({ x: nudges.small, y: nudges.large }),
      nudgePx: pt({ x: small.x - start.x, y: large.x - small.x }),
      duplicated,
      lassoPressed: lasso?.pressed ?? null,
    });
    const exact = Math.abs(small.x - start.x - 2 * env.unit) <= 1 && Math.abs(large.x - small.x - 10 * env.unit) <= 1;
    const acted = duplicated >= 1 && lasso?.pressed === "true" && small.x !== start.x;
    return {
      verdict: acted && exact ? "ok" : "broken",
      headline: `nudges ${nudges.small.toFixed(1)} / ${nudges.large.toFixed(1)} units, ${duplicated} duplicate, lasso ${lasso?.pressed ?? "?"}`,
    };
  },
});

CASES.push({
  name: "hover-tip",
  notations: ["context-map"],
  did: "moved the pointer onto a context that has a description and rested there",
  expected: "the context's tooltip stands 14 px right of and 18 px below the pointer",
  why: "Context Maps shows an element's own data in a tooltip that follows the pointer: client coordinates minus the container's client origin",
  rule: "broken when no tooltip shows; ok when its corner is within 2 chrome px + 2 of pointer + (14, 18) chrome px (kept 12 px inside the container); degraded when further",
  async run(ctx) {
    const { node, row, env } = ctx;
    const target = await pressable(ctx, ["ctx_ordering", "ctx_catalog"]);
    const at = aimAt(await node.map(), {
      x: target.box.x + target.box.width * 0.3,
      y: target.box.y + target.box.height * 0.3,
    });
    await glide(ctx, { x: at.x - 20 * env.chrome, y: at.y - 14 * env.chrome }, at, 8);
    const tip = await settled(ctx, ".cm-hover-tooltip:not([hidden])");
    await ctx.shot(tip ? [tip.box] : []);
    if (!tip) return { verdict: "broken", headline: "no tooltip" };
    const host = await node.hostBox();
    const meant = {
      x: Math.max(
        host.x + 12 * env.chrome,
        Math.min(at.x + 14 * env.chrome, right(host) - tip.box.width - 12 * env.chrome),
      ),
      y: at.y + 18 * env.chrome,
    };
    const off = { x: tip.box.x - meant.x, y: tip.box.y - meant.y };
    const error = Math.max(Math.abs(off.x), Math.abs(off.y));
    Object.assign(row.measured, {
      pointer: pt(at),
      tooltip: bx(tip.box),
      text: tip.text,
      offPx: pt(off),
      fontPx: r2(tip.font),
      insideHost: inside(tip.box, host, 1),
    });
    return {
      verdict: error <= 2 * env.chrome + 2 ? "ok" : "degraded",
      headline: `off ${pair(off, 0)} px, font ${tip.font.toFixed(1)} px`,
    };
  },
});

CASES.push({
  name: "team-band",
  notations: ["context-map"],
  did: "double-clicked the team line at the bottom of a context, typed a name and pressed Enter",
  expected:
    "the editor opens on the team line with the team's name in it, and the file holds the typed text as the context's team, its name untouched",
  why: "the renderer decides between the name and the team editor from the click's client y against the shape's box in container px (isInTeamBand)",
  rule: "wrong-data when the typed text was written into the context's name; broken when no editor opened; else ok",
  async run(ctx) {
    const { node, board, row, env } = ctx;
    const target = await pressable(ctx, ["ctx_ordering", "ctx_catalog"]);
    // the band is the lowest 22 units of the box; the team's text sits in its middle
    const at = aimAt(await node.map(), { x: centre(target.box).x, y: bottom(target.box) - 11 * env.unit });
    const hit = await node.hit(at);
    if (!hit.reachable || hit.element !== target.id)
      throw new Unmeasured(`the team line of ${target.id} takes no press`);
    const before = await fileAtRest(ctx, 100);
    const was = (JSON.parse(before) as { contexts: Array<{ id: string; label: string; team?: string }> }).contexts.find(
      (one) => one.id === target.id,
    )!;
    await board.doubleClick(at);
    const editor = await settled(ctx, EDITOR);
    if (!editor) return { verdict: "broken", headline: "no editor opened" };
    const shown = (await find(node, EDITOR_TEXT))[0]?.text ?? "";
    await ctx.shot([editor.box]);
    await board.press("Control+A");
    await board.type("Zed Team");
    await board.press("Enter");
    const after = await fileAfter(ctx, before);
    const now = (JSON.parse(after) as { contexts: Array<{ id: string; label: string; team?: string }> }).contexts.find(
      (one) => one.id === target.id,
    )!;
    Object.assign(row.measured, {
      element: target.id,
      editorShowed: shown,
      editor: bx(editor.box),
      editorBelowShapeTopPx: r2(editor.box.y - target.box.y),
      teamBefore: was.team ?? null,
      teamAfter: now.team ?? null,
      nameBefore: was.label,
      nameAfter: now.label,
    });
    if (now.label !== was.label)
      return { verdict: "wrong-data", headline: `the name became '${now.label}', the team stayed '${now.team ?? ""}'` };
    return {
      verdict: now.team === "Zed Team" ? "ok" : "broken",
      headline: `team '${now.team ?? ""}', name '${now.label}'`,
    };
  },
});

CASES.push({
  name: "drawing-handle",
  notations: ["event-storming"],
  did: "drew a three point line and dragged its middle point's handle by (30, 20) flow units",
  expected: "the point travels as far as the pointer",
  why: "the vertex handles of a drawing are a gesture of the renderer's own (mousemove on the document, its own toCanvasPoint), outside diagram-js's dragging",
  rule: "error = |travel of the drawing's top edge and of its middle point - pointer| in screen px; ok up to max(3, 2 units), degraded up to 3 times that, else broken; a handle that takes no press is unmeasured",
  async run(ctx) {
    const { node, board, row, env } = ctx;
    const start = await fileAtRest(ctx, 100);
    const drawing = await drawLine(ctx);
    const handles = await find(node, ".event-storming-drawing-handle");
    // the middle point is the line's top
    const handle = [...handles].sort((a, b) => a.box.y - b.box.y)[0];
    if (!handle) throw new Unmeasured("the selected drawing shows no point handles");
    const at = aimAt(await node.map(), centre(handle.box));
    const hit = await node.hit(at);
    if (!hit.reachable || !hit.what.includes("event-storming-drawing-handle")) {
      throw new Unmeasured(
        `the ${handle.box.width.toFixed(1)} px point handle takes no press (${hit.reachable ? hit.what : "outside the editor"})`,
      );
    }
    const before = await fileAfter(ctx, start);
    // upwards and to the right: the top edge of the drawing's box follows the point
    const dragged = await node.drag(at, { x: 30 * ctx.zoom, y: -20 * ctx.zoom });
    const changed = (await board.waitForFileChange(ctx.file, before)) !== null;
    const after = (await node.elementBox(drawing.id))!;
    const movedHandle = [...(await find(node, ".event-storming-drawing-handle"))].sort((a, b) => a.box.y - b.box.y)[0];
    const moved = movedHandle
      ? { x: centre(movedHandle.box).x - centre(handle.box).x, y: centre(movedHandle.box).y - centre(handle.box).y }
      : { x: Number.NaN, y: after.y - drawing.box.y };
    const error = Math.max(Math.abs(moved.x - dragged.delta.x), Math.abs(moved.y - dragged.delta.y));
    const ratio = { x: moved.x / dragged.delta.x, y: moved.y / dragged.delta.y };
    await ctx.shot([after]);
    Object.assign(row.measured, {
      handlePx: r2(handle.box.width),
      pointer: pt(dragged.delta),
      moved: pt(moved),
      ratio: pt(ratio),
      errorPx: r2(error),
      fileChanged: changed,
    });
    const tight = Math.max(3, 2 * env.unit);
    return {
      verdict: changed ? placed(error, tight, 3 * tight) : "broken",
      headline: `${pair(ratio)}, handle ${handle.box.width.toFixed(1)} px`,
    };
  },
});

CASES.push({
  name: "note-edit",
  notations: ["event-storming"],
  did: "double-clicked the note, typed a text behind its own and saved with Control + Enter",
  expected:
    "the note's editor opens on the note with its toolbar above it, and the file holds the typed text in the note",
  why: "a note has an editor of its own: a contenteditable box and a floating toolbar, both placed from the canvas's zoom and viewbox",
  rule: "wrong-data when the typed text is not in the note's line; broken when no editor opens or nothing is written; else ok when the editor's middle is within max(3, 2 units) of the note's and the toolbar stands above it, readable (font at least 9 px) and inside the editor's box; degraded otherwise",
  async run(ctx) {
    const { node, board, row, env } = ctx;
    const note = "note_design_level_session_checkout_flow";
    const at = await pressPoint(ctx, note);
    const shape = (await node.elementBox(note))!;
    const before = await fileAtRest(ctx, 100);
    await board.doubleClick(at);
    const editor = await settled(ctx, ".event-storming-note-editor");
    if (!editor) {
      await ctx.shot();
      return { verdict: "broken", headline: "no editor opened" };
    }
    const toolbar = (await find(node, ".event-storming-note-toolbar"))[0];
    const buttons = await find(node, ".event-storming-note-toolbar [data-action]");
    const map = await node.map();
    let pressableButtons = 0;
    for (const button of buttons) {
      const hit = await node.hit(aimAt(map, centre(button.box)));
      if (hit.reachable && hit.what.length > 0 && !hit.palette) pressableButtons++;
    }
    const host = await node.hostBox();
    const error = Math.max(
      Math.abs(centre(editor.box).x - centre(shape).x),
      Math.abs(centre(editor.box).y - centre(shape).y),
    );
    await ctx.shot([editor.box, toolbar?.box]);
    await board.type(" Zed");
    await board.press("Control+Enter");
    const after = await fileAfter(ctx, before);
    const written = /^note .*Zed/m.test(after);
    Object.assign(row.measured, {
      note: bx(shape),
      editor: bx(editor.box),
      errorPx: r2(error),
      fontPx: r2(editor.font),
      toolbar: toolbar ? bx(toolbar.box) : null,
      toolbarAboveEditorPx: toolbar ? r2(editor.box.y - bottom(toolbar.box)) : null,
      toolbarInsideHost: toolbar ? inside(toolbar.box, host, 1) : null,
      toolbarButtons: buttons.length,
      toolbarButtonsReachable: pressableButtons,
      toolbarButtonPx: buttons[0] ? r2(buttons[0].box.width) : null,
      fileChanged: after !== before,
      typedTextInNote: written,
    });
    if (after === before) return { verdict: "broken", headline: "nothing written" };
    if (!written) return { verdict: "wrong-data", headline: "the typed text is not in the note" };
    const fine =
      error <= Math.max(3, 2 * env.unit) &&
      editor.font >= READABLE_PX &&
      !!toolbar &&
      inside(toolbar.box, host, 1) &&
      pressableButtons === buttons.length;
    return {
      verdict: fine ? "ok" : "degraded",
      headline: `${error.toFixed(1)} px off, font ${editor.font.toFixed(1)} px, toolbar ${pressableButtons}/${buttons.length} buttons`,
    };
  },
});

CASES.push({
  name: "label-suggest",
  notations: ["event-storming"],
  did: "double-clicked a sticky, replaced its name with the first letters of another sticky's name and read the list of suggestions that opens, then chose its first entry with a click and committed",
  expected:
    "the list opens under the name field, its left edge on the field's (kept 12 px inside the editor), 8 px below it (or above where there is no room below), its entry takes a press, and the file holds the chosen name on that sticky",
  why: "the suggestion list is the renderer's own box: it places itself from the client rectangles of the field and of the canvas container, written as container px",
  rule: "unmeasured when no list opens for the typed letters; wrong-data when the file holds another name than the chosen one; broken when the entry takes no press or nothing is written; else ok when the list's corner is within 4 chrome px + 2 of its place, degraded when further",
  async run(ctx) {
    const { node, board, row, sample, env } = ctx;
    const at = await pressPoint(ctx, sample.label);
    const before = await fileAtRest(ctx, 100);
    await board.doubleClick(at);
    const editor = await settled(ctx, EDITOR);
    if (!editor) {
      await ctx.shot();
      return { verdict: "broken", headline: "no editor opened" };
    }
    await board.press("Control+A");
    // "Order S" is the start of Order Shipped, another event of the sample
    await board.type("Order S");
    const list = await settled(ctx, ".event-storming-label-suggestions");
    if (!list) throw new Unmeasured("no suggestion list opened for the typed letters");
    const field = (await find(node, EDITOR))[0] ?? editor;
    const options = await find(node, ".event-storming-label-suggestion");
    const host = await node.hostBox();
    // LabelSuggestions.place: the field's left edge, kept 12 px inside the container; 8 px under the field, or above it
    const meantX = Math.max(
      host.x + 12 * env.chrome,
      Math.min(field.box.x, right(host) - list.box.width - 12 * env.chrome),
    );
    const below = list.box.y - (bottom(field.box) + 8 * env.chrome);
    const above = bottom(list.box) - (field.box.y - 8 * env.chrome);
    const off = { x: list.box.x - meantX, y: Math.abs(below) <= Math.abs(above) ? below : above };
    const error = Math.max(Math.abs(off.x), Math.abs(off.y));
    const share = await visibleShare(ctx, list.box, ".event-storming-label-suggestions");
    await ctx.shot([field.box, list.box]);
    const option = options[0];
    const hit = option ? await node.hit(aimAt(await node.map(), centre(option.box))) : null;
    const takesPress = !!hit && hit.reachable && hit.what.includes("event-storming-label-suggestion");
    Object.assign(row.measured, {
      field: bx(field.box),
      list: bx(list.box),
      offPx: pt(off),
      side: Math.abs(below) <= Math.abs(above) ? "below" : "above",
      options: options.map((one) => one.text),
      optionPx: option ? r2(option.box.height) : null,
      fontPx: option ? r2(option.font) : null,
      visibleShare: r2(share),
      insideHost: inside(list.box, host, 1),
      optionTakesPress: takesPress,
    });
    const headline = `list off ${pair(off, 0)} px, ${options.length} option(s), ${Math.round(share * 100)}% visible`;
    if (!option || !takesPress) {
      await dismiss(ctx);
      await dismiss(ctx);
      return { verdict: "broken", headline: `${headline}, its entry takes no press` };
    }
    await clickBox(ctx, option.box);
    await pause(ctx, 120);
    await board.press("Control+Enter");
    const after = await fileAfter(ctx, before);
    const chosen = option.text;
    const names = after
      .split("\n")
      .filter((line) => /^event /.test(line.trim()))
      .map((line) => line.trim());
    const written = names.filter((line) => line.startsWith(`event ${chosen} [`)).length;
    const had = before.split("\n").filter((line) => line.trim().startsWith(`event ${chosen} [`)).length;
    Object.assign(row.measured, { chosen, fileChanged: after !== before, chosenNameGained: written - had });
    if (after === before) return { verdict: "broken", headline: `${headline}, nothing written` };
    if (written - had !== 1) {
      return { verdict: "wrong-data", headline: `${headline}, the file holds another name than the chosen one` };
    }
    return { verdict: error <= 4 * env.chrome + 2 ? "ok" : "degraded", headline };
  },
});

// ── a board zoom under the armed editor (round 6) ────────────────────────────

/** the wheel burst of the board-zoom cases: 8 events of 40 a frame apart, outwards (the board zoom times 0.64) */
const BURST = { deltaY: 40, count: 8 } as const;

/** an editor of a renderer that holds typed text which is not committed yet */
interface OpenText {
  /** the element the text belongs to */
  element: string;
  /** the open box, and the boxes that belong to it (a toolbar, a list) */
  box: string;
  with: readonly string[];
  /** the field whose text is read back */
  field: string;
  /** what the field must hold after the typing */
  holds: string;
  /** the typed text is in the file, on that element */
  written(file: string): boolean;
}

interface ZoomText {
  name: string;
  notation: Notation;
  what: string;
  /** opens the editor on the page of `ctx` and types, WITHOUT committing; null when no editor opened */
  open(ctx: Ctx): Promise<OpenText | null>;
}

const NOTE = "note_design_level_session_checkout_flow";

const ZOOM_TEXTS: readonly ZoomText[] = [
  {
    name: "board-zoom-note",
    notation: "event-storming",
    what: "double-clicked the note and typed a text behind its own (the note's editor and its toolbar stay open)",
    async open(ctx) {
      const at = await pressPoint(ctx, NOTE);
      await ctx.board.doubleClick(at);
      if (!(await settled(ctx, ".event-storming-note-editor"))) return null;
      await ctx.board.type(" Zed");
      return {
        element: NOTE,
        box: ".event-storming-note-editor",
        with: [".event-storming-note-toolbar"],
        field: ".event-storming-note-editor",
        holds: " Zed",
        written: (file) => /^note .*Zed/m.test(file),
      };
    },
  },
  {
    name: "board-zoom-suggest",
    notation: "event-storming",
    what: "double-clicked a sticky and replaced its name with the first letters of another sticky's name (the name field and its list of suggestions stay open)",
    async open(ctx) {
      const at = await pressPoint(ctx, ctx.sample.label);
      await ctx.board.doubleClick(at);
      if (!(await settled(ctx, EDITOR))) return null;
      await ctx.board.press("Control+A");
      await ctx.board.type("Order S");
      if (!(await settled(ctx, ".event-storming-label-suggestions")))
        throw new Unmeasured("no suggestion list opened for the typed letters");
      return {
        element: ctx.sample.label,
        box: EDITOR,
        with: [".event-storming-label-suggestions"],
        field: EDITOR_TEXT,
        holds: "Order S",
        written: (file) => /^event Order S \[/m.test(file),
      };
    },
  },
  {
    name: "board-zoom-prompt",
    notation: "context-map",
    what: "selected a context, clicked the pad's description entry and typed a text into the prompt (the fixed prompt stays open)",
    async open(ctx) {
      const picked = await selectWithPad(ctx, ["ctx_ordering", "ctx_catalog"], "description");
      await clickBox(ctx, picked.entry.box);
      if (!(await settled(ctx, ".cm-pad-prompt"))) return null;
      await ctx.board.type("Zed text");
      return {
        element: picked.id,
        box: ".cm-pad-prompt",
        with: [],
        field: ".cm-pad-prompt__field",
        holds: "Zed text",
        written: (file) =>
          (
            (JSON.parse(file) as { contexts: Array<{ id: string; description?: string }> }).contexts.find(
              (one) => one.id === picked.id,
            )?.description ?? ""
          ).endsWith("Zed text"),
      };
    },
  },
];

/** what a field of the editor holds right now: its value, else its text; null when it is not there */
const fieldText = (node: NodeHandle, selector: string): Promise<string | null> =>
  node.inDocument((host, wanted: string) => {
    const field = host.querySelector(wanted);
    if (!field) return null;
    return field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement
      ? field.value
      : (field.textContent ?? "");
  }, selector);

/** lines of `now` that `was` does not hold */
const linesNew = (was: string, now: string): string[] => {
  const old = new Set(was.split("\n"));
  return now.split("\n").filter((one) => !old.has(one));
};

/**
 * The reference of a board-zoom case, on a page of its own with the row's URL: the same editor, the
 * same typed text, and a click on the bare board instead of the wheel. Returns the file that click
 * leaves. Console output of that page fails the row like the row's own.
 */
async function byPaneClick(ctx: Ctx, edit: ZoomText) {
  const board = await ctx.harness.open({
    board: "matrix",
    strategy: ctx.row.strategy,
    notations: [ctx.notation as ModelNotation],
    zoom: ctx.row.zoom,
    ...ORIGIN,
  });
  try {
    await board.arm(ctx.nodeId);
    const node = await board.node(ctx.nodeId);
    const twin: Ctx = {
      ...ctx,
      board,
      node,
      row: { ...ctx.row, measured: {} },
      shot: () => Promise.resolve(),
    };
    const file0 = await fileAtRest(twin, 100);
    if (!(await edit.open(twin))) throw new Unmeasured("the second page opened no editor");
    await pause(twin, 100);
    const pane = await board.freePanePoint();
    if (!pane) throw new Unmeasured("the second page has no point of the bare board");
    await board.click(pane);
    await board.waitForFileChange(ctx.file, file0, 1500);
    const file = await fileAtRest(twin, 500);
    const problems = await board.problems();
    if (problems.length > 0) throw new Error(`the second page: ${problems[0]!.slice(0, 160)}`);
    return { file, file0, armed: (await board.armState()).armed === ctx.nodeId };
  } finally {
    await board.close().catch(() => undefined);
  }
}

for (const edit of ZOOM_TEXTS) {
  CASES.push({
    name: edit.name,
    notations: [edit.notation],
    did: `${edit.what}; then turned the wheel over the bare board, a burst of 8 events outwards. On a second page the same up to the wheel, and a click on the bare board instead. Then armed the node again`,
    expected:
      "what the node's own rule for a board zoom says (armedzoom, read off the page). disarm: the node is a preview before the first zoom step, the editor is closed, the file is byte for byte the one the click on the bare board leaves, and the board zooms. free: the board zooms under the armed editor, which stays open with the typed text and writes nothing, the diagram keeps the scale of its host, and a click on the bare board then leaves that same file. lock: the zoom is refused",
    why: "a zoom of the board under an armed editor ends the editing like a click on the bare board does (armedzoom=disarm): what was typed into a renderer's own editor must go where that click puts it",
    rule: "wrong-data when the file differs from the one a click on the bare board leaves. Under disarm: broken when the node is still armed after the burst, when an armed editor saw the zoom (a late disarm, a zoom step while armed, a frame armed at another zoom) or when the editor is still open; degraded when the typed text is in the file by neither way (the editor itself drops it) or the board did not zoom; else ok. Under free: broken when the node was disarmed or the zoom closed the editor or changed its text; degraded when the typed text is in the file by neither way or the diagram is more than 1 % out of the scale of its host while the editor is open; else ok. Under lock: broken when the node was disarmed or the board zoomed; else ok",
    async run(ctx) {
      const { board, node, row, nodeId } = ctx;
      // the rule in effect for THIS node: the verdict follows it
      const armedzoom = (await board.armPolicy(nodeId))?.armedzoom ?? "free";
      const file0 = await fileAtRest(ctx, 100);
      const open = await edit.open(ctx);
      if (!open) {
        await ctx.shot();
        return { verdict: "broken", headline: "no editor opened" };
      }
      await pause(ctx, 100);
      const typed = await fieldText(node, open.field);
      const boxes = async (): Promise<number> => {
        let count = 0;
        for (const selector of [open.box, ...open.with]) count += (await find(node, selector)).length;
        return count;
      };
      const openBefore = await boxes();
      const pane = await board.freePanePoint();
      if (!pane) throw new Unmeasured("no point of the bare board takes a press");
      const [before, counters0] = [await board.viewport(), (await board.counters()).arm];
      const uncommitted = ((await board.fileText(ctx.file)) ?? "") === file0;
      await ctx.shot((await find(node, [open.box, ...open.with].join(", "))).map((one) => one.box));
      await board.startFrames();
      await board.wheelBurst(pane, BURST.deltaY, { count: BURST.count });
      const after = await board.waitForRest();
      const frames = await board.stopFrames();
      const counters1 = (await board.counters()).arm;
      const armedAfter = (await board.armState()).armed === nodeId;
      if (!armedAfter) await board.waitForFileChange(ctx.file, file0, 1500);
      const fileAfterBurst = armedAfter ? ((await board.fileText(ctx.file)) ?? "") : await fileAtRest(ctx, 500);
      const openAfter = await boxes();
      const textAfter = await fieldText(node, open.field);
      // a node that stayed armed: its picture against its host, which the board zoom made smaller
      const unitAfter = armedAfter ? await node.diagramScale() : null;
      const outOfScale =
        unitAfter === null ? null : round(Math.abs(unitAfter / ctx.env.unit / (after.zoom / before.zoom) - 1) * 100, 1);
      const count = (key: keyof typeof counters0): number => counters1[key] - counters0[key];
      const armedFrames = frames.filter((one) => one.armed !== null && one.zoom !== before.zoom).length;
      // a node that stayed armed (free, lock): the click on the bare board is what ends the editing
      let file = fileAfterBurst;
      let armedAfterClick: boolean | null = null;
      if (armedAfter) {
        const again = await board.freePanePoint();
        if (!again) throw new Unmeasured("no point of the bare board takes a press after the zoom");
        await board.click(again);
        await board.waitForFileChange(ctx.file, file0, 1500);
        file = await fileAtRest(ctx, 500);
        armedAfterClick = (await board.armState()).armed === nodeId;
      }
      const reference = await byPaneClick(ctx, edit);
      const same = file === reference.file;
      const written = file !== file0 && open.written(file);
      const writtenByClick = reference.file !== reference.file0 && open.written(reference.file);
      // a case that goes on after a disarm arms the node again first: here that is the last step
      await board.arm(nodeId);
      const rearmed = await board.viewport();
      const armedAgain = (await board.armState()).armed === nodeId;
      Object.assign(row.measured, {
        armedzoom,
        element: open.element,
        typedInField: typed,
        boxesOpenBeforeBurst: openBefore,
        uncommittedBeforeBurst: uncommitted,
        pane: pt(pane),
        viewportBefore: { x: r2(before.x), y: r2(before.y), zoom: before.zoom },
        viewportAfter: { x: r2(after.x), y: r2(after.y), zoom: round(after.zoom, 4) },
        zoomFactor: round(after.zoom / before.zoom, 4),
        armedAfterBurst: armedAfter,
        boxesOpenAfterBurst: openAfter,
        fieldTextAfterBurst: textAfter,
        pictureOutOfScalePct: outOfScale,
        counters: {
          disarmsBeforeZoom: count("disarmsBeforeZoom"),
          disarmsAtTick: count("disarmsAtTick"),
          lateDisarms: count("lateDisarms"),
          armedZoomTicks: count("armedZoomTicks"),
          zoomsRefused: count("zoomsRefused"),
          zoomsUndone: count("zoomsUndone"),
        },
        frames: frames.length,
        framesArmedAtAnotherZoom: armedFrames,
        framesShownArmedAtAnotherZoom: frames.filter((one) => one.shown !== null && one.zoom !== before.zoom).length,
        fileChangedByBurst: fileAfterBurst !== file0,
        armedAfterPaneClick: armedAfterClick,
        fileChanged: file !== file0,
        typedTextInFile: written,
        newLines: linesNew(file0, file).length,
        paneClick: {
          sameStart: reference.file0 === file0,
          fileChanged: reference.file !== reference.file0,
          typedTextInFile: writtenByClick,
          newLines: linesNew(reference.file0, reference.file).length,
          armedAfter: reference.armed,
        },
        sameFileAsPaneClick: same,
        armedAgain,
        viewportArmedAgain: { x: r2(rearmed.x), y: r2(rearmed.y), zoom: rearmed.zoom },
      });
      const state = armedAfter
        ? `stays armed, ${count("armedZoomTicks")} zoom steps under it, ${count("zoomsRefused")} refused, ${openAfter}/${openBefore} boxes open, picture ${outOfScale ?? "-"} % out of scale`
        : `preview first (before ${count("disarmsBeforeZoom")}, late ${count("lateDisarms")}, steps ${count("armedZoomTicks")}, armed frames at another zoom ${armedFrames}/${frames.length}), ${openAfter}/${openBefore} boxes open`;
      const headline = `${armedzoom}: ${state}, zoom x${(after.zoom / before.zoom).toFixed(2)}, text ${written ? "in file" : "NOT in file"} (pane click: ${writtenByClick ? "in file" : "NOT in file"}), ${same ? "= pane click" : "NOT the pane click's file"}, again armed @${round(rearmed.zoom, 4)}`;
      if (!same) return { verdict: "wrong-data", headline };
      const dropped = !written && !writtenByClick;
      if (armedzoom === "disarm") {
        const sawZoom = armedFrames > 0 || count("armedZoomTicks") > 0 || count("lateDisarms") > 0;
        if (armedAfter || sawZoom || openAfter > 0) return { verdict: "broken", headline };
        return { verdict: dropped || after.zoom === before.zoom ? "degraded" : "ok", headline };
      }
      if (!armedAfter) return { verdict: "broken", headline };
      if (armedzoom === "lock") return { verdict: after.zoom === before.zoom ? "ok" : "broken", headline };
      if (openAfter < openBefore || textAfter !== typed) return { verdict: "broken", headline };
      return { verdict: dropped || (outOfScale ?? 0) > 1 ? "degraded" : "ok", headline };
    },
  });
}

/** what the product's own mount brings beside the editor: read from the embed page's hooks, absent in a page mount */
interface ProductMenu {
  entries: number;
  labels: string[];
}

CASES.push({
  name: "product-mount",
  notations: both,
  did: "read what the mount brings beside the canvas: its menu entries, the Keyboard shortcuts dialog (opened through its menu entry), and the chrome key Shift + 1 (fit) after a wheel zoom",
  expected: "nothing is expected of a strategy here: the row records what the mount in use binds",
  why: "the product's mount (in a frame) adds a menu, its dialogs and page-wide zoom and fit keys; the spike's in-page mount leaves them out on purpose, so a difference here is the mount's and no strategy's",
  rule: "always ok when it could be read: the numbers say what is there (menu entries, the dialog's box in the editor, whether Shift + 1 changed the view)",
  async run(ctx) {
    const { node, board, row, sample, env } = ctx;
    const menu: ProductMenu | null = node.frame
      ? await node.frame.evaluate(() => {
          const hooks = (
            window as unknown as Record<string, { editor?: { menu?: Record<string, Array<{ label?: string }>> } }>
          ).__boardSpikeEmbed;
          const groups = hooks?.editor?.menu;
          if (!groups) return null;
          const all = Object.values(groups).flat();
          return { entries: all.length, labels: all.map((one) => one.label ?? "") };
        })
      : null;
    let dialog: Box | null = null;
    let dialogClosedByEscape: boolean | null = null;
    if (menu && node.frame) {
      await node.frame.evaluate(() => {
        const hooks = (
          window as unknown as Record<
            string,
            { editor: { menu: Record<string, Array<{ label?: string; onSelect?(): void }>> } }
          >
        ).__boardSpikeEmbed!;
        Object.values(hooks.editor.menu)
          .flat()
          .find((one) => /shortcut/i.test(one.label ?? ""))
          ?.onSelect?.();
      });
      const shown = await settled(ctx, "dialog.cd-shell-dialog");
      dialog = shown?.box ?? null;
      await ctx.shot(dialog ? [dialog] : []);
      if (shown) {
        await board.press("Escape");
        await pause(ctx, 300);
        dialogClosedByEscape = (await find(node, "dialog.cd-shell-dialog[open]")).length === 0;
      }
    }
    // the fit key: zoom in with the wheel first, so that a fit has something to undo
    const reference = sample.movers[0]!;
    const box = await node.elementBox(reference);
    let fitKeyActs: boolean | null = null;
    if (box) {
      const at = aimAt(await node.map(), centre(box));
      await board.wheel(at, -100, { hold: ["Control"] });
      await pause(ctx, 250);
      const zoomed = (await node.diagramScale()) ?? 0;
      await board.press("Shift+Digit1");
      await pause(ctx, 500);
      const fitted = (await node.diagramScale()) ?? 0;
      fitKeyActs = Math.abs(fitted / zoomed - 1) > 0.02;
      Object.assign(row.measured, { unitAfterWheel: r2(zoomed), unitAfterFitKey: r2(fitted) });
    }
    const host = await node.hostBox();
    Object.assign(row.measured, {
      firstViewUnitPerFlowUnit: r2(env.unit / ctx.zoom),
      menuEntries: menu?.entries ?? 0,
      menuLabels: menu?.labels ?? [],
      dialog: dialog ? bx(dialog) : null,
      dialogInsideEditor: dialog ? inside(dialog, host, 1) : null,
      dialogOverEditor: dialog ? pt({ x: dialog.width / host.width, y: dialog.height / host.height }) : null,
      dialogClosedByEscape,
      fitKeyActs,
    });
    return {
      verdict: "ok",
      headline: `menu ${menu?.entries ?? 0} entries, dialog ${dialog ? `${dialog.width.toFixed(0)}x${dialog.height.toFixed(0)}` : "none"}, Shift+1 ${fitKeyActs ? "fits" : "does nothing"}`,
    };
  },
});

// ── running ──────────────────────────────────────────────────────────────────

const FILES: Readonly<Record<Notation, string>> = {
  "event-storming": "processes/order-to-cash.storm",
  "context-map": "processes/order-fulfilment.cm.json",
};

/** every number in a measurement, by its path */
function numbers(value: unknown, path = "", out: Record<string, number> = {}): Record<string, number> {
  if (typeof value === "number") out[path] = value;
  else if (Array.isArray(value)) value.forEach((one, index) => numbers(one, `${path}[${index}]`, out));
  else if (value && typeof value === "object") {
    for (const [key, one] of Object.entries(value)) numbers(one, path ? `${path}.${key}` : key, out);
  }
  return out;
}

async function once(
  harness: Harness,
  definition: CaseDef,
  strategy: Strategy,
  notation: Notation,
  zoom: number,
  attempt: number,
): Promise<Row> {
  const row: Row = {
    case: definition.name,
    notation,
    strategy,
    zoom,
    status: "failed",
    did: definition.did,
    expected: definition.expected,
    why: definition.why,
    rule: definition.rule,
    verdict: "unmeasured",
    headline: "",
    measured: {},
    problems: [],
  };
  let board: Board | undefined;
  try {
    board = await harness.open({ board: "matrix", strategy, notations: [notation as ModelNotation], zoom, ...ORIGIN });
    const nodeId = `m-${notation}`;
    const info = (await board.nodes()).find((node) => node.id === nodeId);
    if (!info?.file) throw new Error(`no model node ${nodeId}`);
    if (info.file !== FILES[notation]) throw new Error(`${nodeId} shows ${info.file}, not ${FILES[notation]}`);
    await board.arm(nodeId);
    // arming may have moved the board (arm rules): everything below is computed from what is in effect
    const armed = await board.viewport();
    const [policy, move] = [await board.armPolicy(nodeId), await board.lastTransition()];
    const at = (v: { x: number; y: number; zoom: number }): string => `${r2(v.x)},${r2(v.y)}@${v.zoom}`;
    const node = await board.node(nodeId);
    if (!(await node.state()).armed) throw new Error(`${nodeId} did not arm`);
    const [hostScreen, hostLayout] = [await node.hostBox(), await node.hostSize()];
    row.zoomInEffect = armed.zoom;
    row.viewportArmed = { x: r2(armed.x), y: r2(armed.y), zoom: armed.zoom };
    row.hostAt = pt({ x: hostScreen.x, y: hostScreen.y });
    row.armRules = policy ? `${policy.armzoom}/${policy.armedzoom}/${policy.armreturn}` : "none";
    row.armMove = move
      ? {
          by: move.by,
          from: at(move.from),
          to: at(move.to),
          askedMs: move.askedMs,
          writes: move.writes,
          interrupted: move.interrupted,
        }
      : null;
    const unit = await node.diagramScale();
    if (unit === null) throw new Error(`${nodeId} shows no diagram`);
    const env: Env = {
      netScale: round(await node.netScale(), 4),
      chrome: round(hostScreen.width / hostLayout.width, 4),
      unit: round(unit, 4),
      frame: node.frame !== undefined,
      hostScreen: { width: r2(hostScreen.width), height: r2(hostScreen.height) },
      hostLayout,
      ...(await editorSpace(node)),
    };
    row.env = env;
    const boardBefore = await board.boardText();
    const file = `shots/${definition.name}/${notation}-${strategy}-${zoom}${attempt > 0 ? `-r${attempt}` : ""}.png`;
    const opened: Board = board;
    const ctx: Ctx = {
      harness,
      board,
      node,
      row,
      notation,
      zoom: armed.zoom,
      nodeId,
      file: info.file,
      sample: SAMPLES[notation],
      env,
      async shot(extra = []) {
        if (!shots) return;
        const boxes = extra.filter((box): box is Box => !!box && box.width > 0 && box.height > 0);
        row.shot = await node.screenshot(outPath(file), { around: boxes, pad: 16 });
        void opened;
      },
    };
    try {
      const result = await definition.run(ctx);
      row.verdict = result.verdict;
      row.headline = result.headline;
      row.status = "measured";
    } catch (error) {
      if (error instanceof Blocked) {
        row.status = "measured";
        row.verdict = "broken";
        row.measured.blocked = error.message;
        row.headline = `blocked: ${error.message}`;
      } else if (error instanceof Unmeasured) {
        row.status = "unmeasured";
        row.verdict = "unmeasured";
        row.unmeasured = error.message;
        row.headline = "unmeasured";
      } else throw error;
      await ctx.shot().catch(() => undefined);
    }
    row.armedAfter = (await node.state()).armed;
    row.boardSame = (await board.boardText()) === boardBefore;
    const scrolled = await scrolledBy(node);
    if (scrolled.x !== 0 || scrolled.y !== 0) row.scrolledAfter = scrolled;
    row.mounts = (await board.counters()).mounts[nodeId];
  } catch (error) {
    row.status = "failed";
    row.error = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  }
  if (board) {
    row.problems = await board.problems().catch((error: unknown) => [String(error)]);
    await board.close().catch(() => undefined);
  }
  return row;
}

async function measure(
  harness: Harness,
  definition: CaseDef,
  strategy: Strategy,
  notation: Notation,
  zoom: number,
): Promise<Row> {
  let first = await once(harness, definition, strategy, notation, zoom, 0);
  if (first.status === "unmeasured") {
    // the gesture could not be carried out: once more on a fresh page tells a slip of the script
    // (a drag the page did not take under load) from an obstacle that is always there
    const again = await once(harness, definition, strategy, notation, zoom, 0);
    again.attempts = 2;
    again.firstAttempt = first.unmeasured;
    again.problems.push(...first.problems);
    first = again;
  }
  if (repeat === 1) return first;
  const verdicts: Verdict[] = [first.verdict];
  const base = numbers(first.measured);
  let spread = 0;
  for (let attempt = 1; attempt < repeat; attempt++) {
    const again = await once(harness, definition, strategy, notation, zoom, attempt);
    verdicts.push(again.verdict);
    first.problems.push(...again.problems);
    if (again.status === "failed") {
      first.status = "failed";
      first.error = `repeat ${attempt}: ${again.error ?? ""}`;
    }
    const other = numbers(again.measured);
    for (const [path, value] of Object.entries(base)) {
      if (path in other) spread = Math.max(spread, Math.abs(other[path]! - value));
      else spread = Number.POSITIVE_INFINITY;
    }
  }
  first.repeats = { verdicts, spread: Number.isFinite(spread) ? r2(spread) : -1 };
  return first;
}

function line(row: Row): string {
  return [
    row.case.padEnd(20),
    row.notation.padEnd(15),
    row.strategy.padEnd(8),
    String(row.zoom).padEnd(5),
    row.verdict.padEnd(11),
    row.headline,
    row.status === "unmeasured" ? `(${row.unmeasured ?? ""})` : "",
    row.status === "failed" ? `FAILED: ${row.error ?? ""}` : "",
    row.attempts ? `[attempt ${row.attempts}; first: ${row.firstAttempt ?? ""}]` : "",
    row.armedAfter === false ? "[disarmed]" : "",
    row.boardSame === false ? "[board file changed]" : "",
    row.scrolledAfter ? `[container scrolled ${row.scrolledAfter.x}/${row.scrolledAfter.y}]` : "",
    row.repeats
      ? `[x${row.repeats.verdicts.length} ${row.repeats.verdicts.join(",")} spread ${row.repeats.spread}]`
      : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/** one line per case x notation x strategy, the zooms folded into one cell */
function table(rows: readonly Row[]): string {
  const out = ["| Case | Notation | Strategy | Verdict | By zoom | Note |", "| --- | --- | --- | --- | --- | --- |"];
  const keys = [...new Set(rows.map((row) => `${row.case}|${row.notation}|${row.strategy}`))];
  for (const key of keys) {
    const [name, notation, strategy] = key.split("|");
    const mine = rows.filter((row) => row.case === name && row.notation === notation && row.strategy === strategy);
    const byZoom = mine.map((row) => `${row.zoom}: ${row.headline || row.verdict}`).join(" \\| ");
    const verdicts = [...new Set(mine.map((row) => row.verdict))];
    const verdict = verdicts.length === 1 ? verdicts[0]! : mine.map((row) => `${row.zoom}: ${row.verdict}`).join(", ");
    const notes = [
      ...new Set(mine.flatMap((row) => (row.unmeasured ? [`${row.zoom}: ${row.unmeasured}`] : []))),
      ...mine.flatMap((row) =>
        row.attempts ? [`${row.zoom}: second attempt (first: ${row.firstAttempt ?? ""})`] : [],
      ),
      ...(mine.some((row) => row.armedAfter === false) ? ["the node was disarmed"] : []),
      ...(mine.some((row) => row.boardSame === false) ? ["the board file changed"] : []),
      ...(mine.some((row) => row.scrolledAfter) ? ["a container of the editor was left scrolled"] : []),
      ...(mine.some((row) => row.status === "failed") ? ["HARNESS FAILED"] : []),
    ];
    out.push(`| ${name} | ${notation} | ${strategy} | ${verdict} | ${byZoom} | ${notes.join("; ")} |`);
  }
  return `${out.join("\n")}\n`;
}

const selectedCases = CASES.filter(
  (one) => caseFilter.length === 0 || caseFilter.some((filter) => one.name === filter || one.name.startsWith(filter)),
);

await run(async (harness) => {
  const started = Date.now();
  const jobs: Array<{ definition: CaseDef; notation: Notation; strategy: Strategy; zoom: number }> = [];
  for (const definition of selectedCases) {
    for (const notation of notations) {
      if (!definition.notations.includes(notation)) continue;
      for (const strategy of strategies) {
        for (const zoom of zooms) jobs.push({ definition, notation, strategy, zoom });
      }
    }
  }
  // every row has a page and a browser context of its own, so several can run side by side; the
  // result keeps the order of the jobs whatever finished first
  const done: Array<Row | undefined> = jobs.map(() => undefined);
  const timing: Array<{ row: string; ms: number }> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const job = jobs[index];
      if (!job) return;
      const begun = Date.now();
      const row = await measure(harness, job.definition, job.strategy, job.notation, job.zoom);
      timing[index] = { row: `${row.case} ${job.notation} ${job.strategy} ${job.zoom}`, ms: Date.now() - begun };
      done[index] = row;
      console.log(line(row));
      for (const problem of row.problems) console.log(`    ${problem.slice(0, 240)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, jobs.length)) }, () => worker()));
  const rows = done.filter((row): row is Row => row !== undefined);
  const count = (status: Row["status"]): number => rows.filter((row) => row.status === status).length;
  const withProblems = rows.filter((row) => row.problems.length > 0).length;
  const path = writeResult("miragon-b", {
    what: "board spike battery miragon-b: Event Storming and Context Map, case x notation x strategy x board zoom",
    chromium: harness.browser.version(),
    viewport: { width: 2200, height: 1300, deviceScaleFactor: 1 },
    nodeOrigin: ORIGIN,
    travelFlowUnits: TRAVEL,
    strategies,
    notations,
    zooms,
    cases: selectedCases.map((one) => one.name),
    repeat,
    concurrency,
    rows,
  });
  // what changes from run to run stays out of the result file, so two runs can be compared with diff
  writeFileSync(
    outPath("miragon-b-timing.json"),
    `${JSON.stringify({ date: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), timing }, null, 2)}\n`,
  );
  const markdown = outPath("miragon-b.md");
  writeFileSync(markdown, table(rows));
  const tally = (["ok", "degraded", "broken", "wrong-data", "unmeasured"] as const)
    .map((verdict) => `${rows.filter((row) => row.verdict === verdict).length} ${verdict}`)
    .join(", ");
  console.log(
    `\n${rows.length} rows in ${Math.round((Date.now() - started) / 1000)} s: ${tally}; ${count("failed")} failed, ` +
      `${withProblems} with console errors or log lines\n${path}\n${markdown}`,
  );
  // the harness failed, not a strategy: a case that threw, or output where none belongs
  return count("failed") + withProblems;
});
