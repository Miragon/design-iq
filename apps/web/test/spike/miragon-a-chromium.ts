/**
 * Battery "miragon-a" of the board spike: what a person can do in the Wardley Map, Value Chain and
 * Team Topology renderers, per strategy and board zoom. A check run by hand, not by `pnpm test` or
 * CI: it starts a Vite dev server and a sandboxed headless Chromium of its own (lib.ts).
 *
 *   PORT=5424 CACHE_DIR=<scratch>/vite-cache OUT_DIR=<scratch> node apps/web/test/spike/miragon-a-chromium.ts
 *   STRATEGIES=plugin,shim NOTATIONS=wardley ZOOMS=0.5,1 CASES=create,popup REPEAT=2 node ...
 *
 * One fresh page per case x notation x strategy x zoom (board=matrix with the one notation, the
 * viewport from the URL, the node armed through the hook). A case does what a person does with the
 * mouse and the keyboard, reads the result off the DOM and the file at the hub, and returns the
 * numbers. Every rectangle is in top-level screen px (lib.ts), every geometry read of this file goes
 * through window.__boardSpikeNative, so the numbers stay true under a strategy that patches the
 * prototypes.
 *
 * NOTHING is keyed on a strategy's name. What a case expects is what a person needs (the shape under
 * the pointer, the popup at its entry, the typed text in the file), and the verdict is computed from
 * the measured numbers by the rules below. Three measured properties of the node say what its
 * strategy does and are in every row:
 *   net        client size of the editor's host over its layout size, in its own document. diagram-js
 *              and the renderers' own pointer code assume 1;
 *   frame      the node's editor lives in a frame of its own (a document with its own client space);
 *   chromePx   screen px per CSS px of the editor's HTML chrome (net x the frame's scale);
 *   space      the coordinate space the node's document TELLS its editor against the browser's own
 *              (scale 1 and origin 0, 0 unless a strategy answers the plain geometry functions in a
 *              space of its own, as `shim` does), and the window the editor is told. Read on purpose
 *              through the plain methods next to the native ones: the difference is the measurement;
 *   layers     what the strategy says about its variant on the page: the host's data-plugin-layers
 *              (`plugin`) and the parts of window.__boardSpikeShim (`shim`), null elsewhere.
 * A popup's `shownShare` is hit-tested (a 5 x 5 grid over its box, each point asked for its topmost
 * element with the browser's own function): what the board clips or other chrome covers is not
 * shown, whatever the box's numbers say. A strategy that keeps its popups inside the node has them
 * cut by the board's own box, which no rectangle of the window tells.
 *
 * Verdicts (worst first when folded over the zooms):
 *   wrong-data  the gesture ended and the file holds something else than the person chose: another
 *               element connected, renamed or deleted, another menu entry applied, a file that
 *               changed although nothing was typed, the board file changed by a key meant for the editor;
 *   broken      the gesture cannot be done: no element created, an entry that is drawn but does not
 *               take the click (covered, outside the window), no popup, no editor box, the node disarmed;
 *   degraded    it works, at a cost a person sees: the element does not follow the pointer (further
 *               off than the engine's own rounding), a pad, popup, tooltip or editor box away from
 *               its anchor, chrome that is cut off or covers part of the entries, a target below
 *               24 px (WCAG 2.2, 2.5.8 minimum target size) or editor text below 9 px on screen;
 *   unmeasured  the case could not run here, with the reason (never guessed, never dropped);
 *   ok          none of the above.
 * One case zooms the BOARD under the armed editor (board-zoom, round 6: an open label editor with
 * typed text, a wheel burst over the bare board). Its verdict follows the node's own arm rule, read
 * off the page (`board.armPolicy`): under armedzoom=disarm a node that is a preview before the first
 * zoom step, with the typed text in the file as a click on the bare board writes it, is the
 * specified behaviour and ok; under free the node stays armed and the click commits. No other case
 * lets a wheel reach the board: there a moved board or a disarmed node is broken under every rule.
 * A case never fails the script. Exit code 1 only for harness trouble: a case that threw something
 * else than Unmeasured (wrong page, a navigation, a timeout), or a console error, page error or log
 * line that is not on the allow list of its case.
 *
 * Environment: STRATEGIES (default naive,counter,overlay,iframe; all six: add plugin,shim),
 * NOTATIONS (default wardley,value-chain,team-topology), ZOOMS (default 0.5,0.73,1,1.5), CASES
 * (comma list; a case runs when its name contains one of them), REPEAT (default 1: runs per row,
 * the row carries every run and says whether they agree), CONCURRENCY (pages at a time, default 4;
 * every page is a browser context of its own), SHOTS (1: a screenshot at the marked moments of each
 * case, into <OUT_DIR>/shots), PAGE_CSS (a diagnostic, off by default: CSS text added to the board
 * page before the node is armed, to show what one rule would change; the result file says so), plus
 * lib.ts's PORT, BASE, CACHE_DIR, OUT_DIR, OUT. Results:
 * <OUT_DIR>/miragon-a.json (rows, and the same folded per case x notation x strategy) and
 * <OUT_DIR>/miragon-a.md (the folded table).
 */
import { writeFileSync } from "node:fs";

import { EMBED_KEY } from "../../src/board-spike/shared.ts";
import {
  aimAt,
  type Board,
  type Box,
  centre,
  type Harness,
  type Hit,
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
  toScreen,
  union,
  writeResult,
} from "./lib.ts";

// ── what runs ────────────────────────────────────────────────────────────────

const NOTATIONS = ["wardley", "value-chain", "team-topology"] as const;
type Notation = (typeof NOTATIONS)[number];

const list = <T extends string>(name: string, all: readonly T[], fallback: readonly T[]): T[] => {
  const wanted = (process.env[name] ?? "").split(",").filter(Boolean);
  return wanted.length === 0 ? [...fallback] : all.filter((one) => wanted.includes(one));
};
const strategies = list<Strategy>("STRATEGIES", STRATEGIES, ["naive", "counter", "overlay", "iframe"]);
const notations = list<Notation>("NOTATIONS", NOTATIONS, NOTATIONS);
const zooms = (process.env.ZOOMS ?? "0.5,0.73,1,1.5").split(",").map(Number).filter(Boolean);
const caseFilter = (process.env.CASES ?? "").split(",").filter(Boolean);
const REPEAT = Math.max(1, Number(process.env.REPEAT ?? 1));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 4));
const SHOTS = process.env.SHOTS === "1";
/** a diagnostic, off by default: CSS text added to the board page before the node is armed, to show what one rule changes */
const PAGE_CSS = process.env.PAGE_CSS ?? "";

/** where the node's top-left corner sits in the canvas: clear of the toolbar */
const ORIGIN = { x: 60, y: 80 };
/** the pointer's travel of a move in flow units; on screen it is this times the board zoom */
const TRAVEL = { x: 60, y: 40 };
/** WCAG 2.2, success criterion 2.5.8: a pointer target is at least 24 x 24 CSS px */
const TARGET_PX = 24;
/** text of an editor box below this is not read at arm's length (the script's own threshold) */
const TEXT_PX = 9;
/** a popup or pad counts as "at its anchor" within this many screen px */
const ANCHOR_PX = 8;
/** ms a case may take before the page is given up (harness trouble) */
const CASE_TIMEOUT = 90_000;

// ── rows ─────────────────────────────────────────────────────────────────────

const VERDICTS = ["wrong-data", "broken", "degraded", "unmeasured", "ok"] as const;
type Verdict = (typeof VERDICTS)[number];
type Measured = Record<string, unknown>;

interface Outcome {
  verdict: Verdict;
  /** why the verdict is not ok, in the words of the rule that fired */
  why: string;
  measured: Measured;
}

/** a case that could not run here: the message is the reason */
class Unmeasured extends Error {}

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
  /** what was done, what was expected and why: the case's own text */
  did: string;
  expected: string;
  verdict: Verdict;
  why: string;
  measured: Measured;
  /** the cell of the folded table */
  cell: string;
  /** client size over layout size of the editor's host in its document */
  net?: number;
  frame?: boolean;
  chromePx?: number;
  /** screen px per diagram unit */
  unitPx?: number | null;
  /** the editor's host on screen */
  hostPx?: { width: number; height: number };
  /** the space the editor is told (see the header); `virtual` when it is not the browser's own */
  space?: { scale: number; origin: Point; window: Box; virtual: boolean };
  /** the strategy's variant as the page states it: data-plugin-layers of the host, the shim's parts */
  layers?: string | null;
  armedAfter?: boolean;
  boardSame?: boolean;
  mounts?: number;
  /** REPEAT > 1: verdict and cell of every run, and whether they are the same */
  runs?: Array<{ verdict: Verdict; cell: string }>;
  stable?: boolean;
  /** harness trouble: the case threw (not Unmeasured) */
  failed?: string;
  problems: string[];
  ms: number;
}

// ── the page, as a case sees it ──────────────────────────────────────────────

/** what an element of the editor's chrome looks like on screen */
interface Seen {
  box: Box;
  /** computed font-size in CSS px of its own document (HTML chrome: x chromePx is screen px) */
  fontCss: number;
  text: string;
  action: string | null;
  dataId: string | null;
  label: string | null;
  cls: string;
  position: string;
}

interface Ctx {
  /** for a case that needs a second page (board-zoom: the same steps, ended by a click on the bare board) */
  harness: Harness;
  board: Board;
  node: NodeHandle;
  notation: Notation;
  strategy: Strategy;
  /** the board zoom IN EFFECT after arming (the viewport's), which is the asked one unless an arm rule moved the board */
  zoom: number;
  /** the board zoom the URL asked for: what a second page of the same row is opened with */
  asked: number;
  spec: Spec;
  /** the model file and the board file before the case */
  file0: string;
  board0: string;
  net: number;
  frame: boolean;
  chromePx: number;
  unitPx: number;
  host: Box;
  /** what a person can see of the editor's document: the frame's box, else the window */
  clip: Box;
  /** screen px per client px the editor is TOLD (the told space's scale x the frame's scale) */
  toldPx: number;
  /** screen px a pointer result may be off: the engine rounds to whole diagram units */
  tol: number;
  shot(tag: string, around?: readonly Box[]): Promise<void>;
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const len = (p: Point): number => Math.hypot(p.x, p.y);
const rp = (p: Point, digits = 1): Point => ({ x: round(p.x, digits), y: round(p.y, digits) });
const rb = (b: Box): Box => ({
  x: round(b.x, 1),
  y: round(b.y, 1),
  width: round(b.width, 1),
  height: round(b.height, 1),
});
const origin = (b: Box): Point => ({ x: b.x, y: b.y });
const inside = (p: Point, b: Box, slack = 0): boolean =>
  p.x >= b.x - slack && p.x <= b.x + b.width + slack && p.y >= b.y - slack && p.y <= b.y + b.height + slack;
/** the share of `box` that lies inside `clip` */
function visibleShare(box: Box, clip: Box): number {
  const w = Math.min(box.x + box.width, clip.x + clip.width) - Math.max(box.x, clip.x);
  const h = Math.min(box.y + box.height, clip.y + clip.height) - Math.max(box.y, clip.y);
  const area = box.width * box.height;
  return area <= 0 ? 0 : round((Math.max(0, w) * Math.max(0, h)) / area, 3);
}
/**
 * How far a popup lies from where it belongs. diagram-js opens a popup menu with a corner at the
 * pointer (the top-left one, another one where it flips at the window's edge); a renderer's own
 * picker opens with its top-left corner there and is pushed back inside the editor's container
 * (4 CSS px from its edge). The smaller of the two distances.
 */
function fromAnchor(click: Point, popup: Box, host: Box, margin: number): number {
  const corners = [
    { x: popup.x, y: popup.y },
    { x: popup.x + popup.width, y: popup.y },
    { x: popup.x, y: popup.y + popup.height },
    { x: popup.x + popup.width, y: popup.y + popup.height },
  ];
  const kept = {
    x: Math.max(host.x + margin, Math.min(click.x, host.x + host.width - popup.width - margin)),
    y: Math.max(host.y + margin, Math.min(click.y, host.y + host.height - popup.height - margin)),
  };
  return Math.min(...corners.map((corner) => len(sub(corner, click))), len(sub(origin(popup), kept)));
}
/** a number as text, without the "-0" of toFixed */
const fixed = (value: number, digits: number): string => (round(value, digits) + 0).toFixed(digits);
const pt = (p: Point | undefined, digits = 0): string => (p ? `${fixed(p.x, digits)},${fixed(p.y, digits)}` : "-");

const rest = (ctx: Ctx, ms: number): Promise<void> => ctx.board.page.waitForTimeout(ms);
const fileNow = async (ctx: Ctx): Promise<string> => (await ctx.board.fileText(ctx.spec.file)) ?? "";
/** the file once it differs from `before`, null when it never did (an editor writes about 350 ms after a gesture) */
const fileChange = (ctx: Ctx, before: string, timeout = 2500): Promise<string | null> =>
  ctx.board.waitForFileChange(ctx.spec.file, before, timeout);

/**
 * Elements of the editor's chrome by selector, inside the host and inside the body-level popup host
 * the node owns, with their boxes in screen px. Read through the browser's own geometry functions.
 */
async function seen(ctx: Ctx, selector: string): Promise<Seen[]> {
  const map = await ctx.node.map();
  const raw = await ctx.node.inDocument(
    (host, arg: { selector: string; node: string }) => {
      const native = (window as unknown as { __boardSpikeNative?: NativeGeometry }).__boardSpikeNative;
      const popupHosts = [...document.querySelectorAll<HTMLElement>(".board-popup-host")].filter(
        (one) => one.dataset.node === arg.node,
      );
      return [host, ...popupHosts].flatMap((root) =>
        [...root.querySelectorAll(arg.selector)].map((element) => {
          const { x, y, width, height } = native ? native.rect(element) : element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            box: { x, y, width, height },
            fontCss: Number.parseFloat(style.fontSize) || 0,
            text: (element.textContent ?? "").trim().slice(0, 80),
            action: element.getAttribute("data-action"),
            dataId: element.getAttribute("data-id"),
            label: element.getAttribute("aria-label") ?? element.getAttribute("title"),
            cls: element.getAttribute("class") ?? "",
            position: style.position,
          };
        }),
      );
    },
    { selector, node: ctx.node.id },
  );
  return raw.map((one) => ({ ...one, box: toScreen(map, one.box) }));
}
const first = async (ctx: Ctx, selector: string): Promise<Box | undefined> => (await ctx.node.query(selector))[0];
/** a box once it is there and at rest */
const settled = (ctx: Ctx, selector: string, timeout = 2000): Promise<Box | null> =>
  ctx.board.waitForBox(() => first(ctx, selector), timeout);

/** the element's own bounds on screen (its hit rectangle: no label, no decoration) */
const shapeBox = (ctx: Ctx, id: string): Promise<Box | undefined> => first(ctx, `[data-element-id="${id}"] > .djs-hit`);

/** what the focus is on, in the node's document */
const focusOf = (ctx: Ctx): Promise<{ what: string; inHost: boolean; action: string | null }> =>
  ctx.node.inDocument((host) => {
    const active = document.activeElement;
    return {
      what: active ? `${active.tagName.toLowerCase()}.${(active.getAttribute("class") ?? "").slice(0, 60)}` : "none",
      inHost: !!active && host.contains(active),
      action: active?.getAttribute("data-action") ?? null,
    };
  });

/** the coordinate space the node's document tells its editor, in true client px of that document */
interface EditorSpace {
  /** true client px per px the editor is told */
  scale: number;
  /** the true client point of the told (0, 0) */
  origin: Point;
  /** the document's box as the editor is told it: what diagram-js flips a popup against */
  window: Box;
  /** the told space is not the browser's own */
  virtual: boolean;
  layers: string | null;
}
const editorSpace = (node: NodeHandle): Promise<EditorSpace> =>
  node.inDocument((host) => {
    const page = window as unknown as {
      __boardSpikeNative?: NativeGeometry;
      __boardSpikeShim?: { options?: { parts?: Record<string, boolean> } };
    };
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
      virtual: Math.abs(scale - 1) > 0.001 || Math.abs(origin.x) + Math.abs(origin.y) > 0.5,
      layers: host.dataset.pluginLayers !== undefined ? `plugin=${host.dataset.pluginLayers}` : shim,
    };
  });

/**
 * The share of a box a person can see and press: a 5 x 5 grid over it, each point asked for the
 * topmost element of the top document (the node's editor) and of the node's own document (inside
 * `mark`), both with the browser's own function.
 */
async function shownShare(ctx: Ctx, box: Box, mark: string): Promise<number> {
  const map = await ctx.node.map();
  let shown = 0;
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 5; column++) {
      const at = { x: box.x + (box.width * (column + 0.5)) / 5, y: box.y + (box.height * (row + 0.5)) / 5 };
      const hit = await ctx.node.hit(at);
      if (!hit.reachable) continue;
      const marked = await ctx.node.inDocument(
        (_host, arg: { x: number; y: number; mark: string }) => {
          const native = (window as unknown as { __boardSpikeNative?: NativeGeometry }).__boardSpikeNative;
          const element = native
            ? native.elementFromPoint(document, arg.x, arg.y)
            : document.elementFromPoint(arg.x, arg.y);
          return !!element?.closest(arg.mark);
        },
        { x: (at.x - map.x) / map.sx, y: (at.y - map.y) / map.sy, mark },
      );
      if (marked) shown++;
    }
  }
  return round(shown / 25, 2);
}

const isPad = (hit: Hit): boolean => hit.reachable && hit.pad;
const isPalette = (hit: Hit): boolean => hit.reachable && hit.palette;
const isPopup = (hit: Hit): boolean => hit.reachable && hit.popup;
const isClass =
  (name: string) =>
  (hit: Hit): boolean =>
    hit.reachable && hit.what.includes(name);

/** how many of the boxes take a press at their middle */
async function reachable(ctx: Ctx, boxes: readonly Box[], is: (hit: Hit) => boolean): Promise<number> {
  let count = 0;
  for (const box of boxes) if (is(await ctx.node.hit(centre(box)))) count++;
  return count;
}

/**
 * Clicks the middle of a piece of chrome as a person does, where it is DRAWN. Hit-tested first: a
 * click on something that is drawn elsewhere than it takes input lands on whatever is there (the
 * board's pane disarms the node). Returns the point clicked, or the reason no click was made.
 */
async function clickChrome(ctx: Ctx, box: Box | null | undefined, is: (hit: Hit) => boolean, what: string) {
  if (!box) return { clicked: false as const, reason: `${what}: not there` };
  const at = aimAt(await ctx.node.map(), centre(box));
  const hit = await ctx.node.hit(at);
  if (!is(hit)) {
    return {
      clicked: false as const,
      reason: `${what}: drawn at ${pt(at)} but the press goes to ${hit.reachable ? hit.what : "something outside the editor"}`,
    };
  }
  await ctx.board.click(at);
  return { clicked: true as const, at };
}

/** the first of `ids` whose middle takes a press; the others are in `covered` with what lies over them */
async function grab(ctx: Ctx, ids: readonly string[]): Promise<{ id: string; box: Box; at: Point; covered: string[] }> {
  const covered: string[] = [];
  const map = await ctx.node.map();
  for (const id of ids) {
    const box = await shapeBox(ctx, id);
    if (!box) {
      covered.push(`${id}: not drawn`);
      continue;
    }
    const at = aimAt(map, centre(box));
    const hit = await ctx.node.hit(at);
    if (hit.reachable && hit.element === id) return { id, box, at, covered };
    covered.push(`${id}: ${hit.reachable ? hit.what : "outside the editor"}`);
  }
  throw new Unmeasured(`no element takes a press at its middle (${covered.join("; ")})`);
}

/** selects by a click and waits until the editor shows it selected */
async function selectByClick(ctx: Ctx, ids: readonly string[]) {
  const target = await grab(ctx, ids);
  await ctx.board.click(target.at);
  const selected = await ctx.board.waitFor(async () => (await ctx.node.selected()).includes(target.id), 1500);
  if (!selected) throw new Unmeasured(`a click on ${target.id} did not select it`);
  return target;
}

/** an entry of the open context pad once it rests */
const padEntry = (ctx: Ctx, action: string): Promise<Box | null> =>
  settled(ctx, `.djs-context-pad.open .entry[data-action="${action}"]`);

/** the first candidate point where a press reaches the bare canvas (the diagram's root) */
async function freeSpot(ctx: Ctx): Promise<Point> {
  const map = await ctx.node.map();
  const tried: string[] = [];
  for (const candidate of await ctx.spec.spots(ctx)) {
    const at = aimAt(map, candidate);
    // the middle and a ring around it: a new shape must not land on a neighbour
    const ring = [0, 1, 2, 3].map((i) => ({
      x: at.x + Math.cos((i * Math.PI) / 2 + Math.PI / 4) * 34 * ctx.unitPx,
      y: at.y + Math.sin((i * Math.PI) / 2 + Math.PI / 4) * 34 * ctx.unitPx,
    }));
    const hits = [];
    for (const point of [at, ...ring]) hits.push(await ctx.node.hit(point));
    if (hits.every((hit) => hit.reachable && hit.element === ctx.spec.root && hit.what.startsWith("svg"))) return at;
    tried.push(`${pt(at)}: ${hits.find((hit) => !(hit.reachable && hit.element === ctx.spec.root))?.what ?? "?"}`);
  }
  throw new Unmeasured(`no free canvas point takes a press (${tried.join("; ")})`);
}

/** ids the editor draws now that it did not draw before */
const created = async (ctx: Ctx, before: readonly string[]): Promise<string[]> =>
  (await ctx.node.elementIds()).filter((id) => !before.includes(id));
/** waits for a new SHAPE (an element with a rectangle to hit) and returns its id */
async function newShape(ctx: Ctx, before: readonly string[], timeout = 1500): Promise<string | null> {
  return ctx.board.waitFor(async () => {
    for (const id of await created(ctx, before)) {
      if ((await ctx.node.query(`[data-element-id="${id}"] > rect.djs-hit`)).length > 0) return id;
    }
    return null;
  }, timeout);
}

/** the verdict of a gesture whose result should lie under the pointer */
function pointerOutcome(done: boolean, error: Point, tol: number, measured: Measured, undone: string): Outcome {
  if (!done) return { verdict: "broken", why: undone, measured };
  const off = Math.max(Math.abs(error.x), Math.abs(error.y));
  return off <= tol
    ? { verdict: "ok", why: "", measured }
    : {
        verdict: "degraded",
        why: `${round(off, 1)} px off the pointer (the engine's rounding allows ${round(tol, 1)} px)`,
        measured,
      };
}

// ── the three notations ──────────────────────────────────────────────────────

interface Spec {
  file: string;
  /** `data-element-id` of the diagram's root svg */
  root: string;
  /** keys that switch the engine's snapping off while a drag is held (pressed after the button) */
  hold: readonly string[];
  /** diagram units a drop without those keys may be off (a grid) */
  grid: number;
  /** shapes that move freely, in order of preference */
  movers: readonly string[];
  pair: readonly [string, string];
  /** groups of shapes a lasso is drawn around, best first */
  lasso: readonly (readonly string[])[];
  create: { drag: string; click: string; keyAction: string };
  /** candidate points of the bare canvas, best first */
  spots(ctx: Ctx): Promise<Point[]>;
  label: {
    targets: readonly string[];
    /** the element's drawn text */
    text(id: string): string;
    /** the editor's box and the element that carries its font */
    box: string;
    font: string;
    /** whether `id` carries `text` in the file: "yes", "no" */
    named(file: string, id: string, text: string): boolean;
  };
  pad: { targets: readonly string[] };
  /** the element is in the file */
  has(file: string, id: string): boolean;
  /** a palette entry in the middle of the palette, for the tooltip */
  tooltipEntry: string;
}

/** the tea-shop sample: document id -> name, and where it sits in the plot ([visibility, evolution]) */
const TEA: Readonly<Record<string, { name: string; at: readonly [number, number] }>> = {
  cmp_cup_of_tea: { name: "Cup of Tea", at: [0.79, 0.61] },
  cmp_cup: { name: "Cup", at: [0.73, 0.78] },
  cmp_tea: { name: "Tea", at: [0.63, 0.81] },
  cmp_hot_water: { name: "Hot Water", at: [0.52, 0.8] },
  cmp_water: { name: "Water", at: [0.38, 0.82] },
  cmp_kettle: { name: "Kettle", at: [0.43, 0.35] },
  cmp_power: { name: "Power", at: [0.1, 0.71] },
};

/**
 * A point of the Wardley plot on screen, from where four components of the sample are drawn right
 * now: x from Kettle (evolution 0.35) and Water (0.82), y from Cup of Tea (visibility 0.79) and
 * Power (0.1). Read before the case changes anything.
 */
async function plotPoint(ctx: Ctx, visibility: number, evolution: number): Promise<Point> {
  const at = async (id: string): Promise<Point> => {
    const box = await shapeBox(ctx, id);
    if (!box) throw new Unmeasured(`${id} is not drawn: no plot to aim at`);
    return centre(box);
  };
  const [kettle, water, tea, power] = [
    await at("cmp_kettle"),
    await at("cmp_water"),
    await at("cmp_cup_of_tea"),
    await at("cmp_power"),
  ];
  const perEvolution = (water.x - kettle.x) / (0.82 - 0.35);
  const perVisibility = (power.y - tea.y) / (0.79 - 0.1);
  return { x: kettle.x + (evolution - 0.35) * perEvolution, y: tea.y + (0.79 - visibility) * perVisibility };
}

const fraction = (ctx: Ctx, fx: number, fy: number): Point => ({
  x: ctx.host.x + ctx.host.width * fx,
  y: ctx.host.y + ctx.host.height * fy,
});

interface ValueChainFile {
  elements: Array<{ id: string; name?: string; color?: string; bounds: Box }>;
  connections: Array<{ id: string; source: string; target: string; connectionType: string }>;
}
interface TeamTopologyFile {
  nodes: Array<{ id: string; label?: string; size: { width: number; height: number } }>;
  interactions: Array<{ id: string; label?: string }>;
  flows: Array<{ id: string }>;
  annotations: Array<{ id: string; text?: string; attachedTo?: string }>;
}
const valueChain = (file: string): ValueChainFile => JSON.parse(file) as ValueChainFile;
const teamTopology = (file: string): TeamTopologyFile => JSON.parse(file) as TeamTopologyFile;
const wardleyLines = (file: string): string[] => file.split("\n");

const SPECS: Readonly<Record<Notation, Spec>> = {
  wardley: {
    file: "processes/tea-shop.wmap",
    root: "wardley-root",
    hold: [],
    grid: 0,
    movers: ["cmp_cup", "cmp_tea", "cmp_water", "cmp_hot_water"],
    pair: ["cmp_tea", "cmp_cup"],
    lasso: [["cmp_tea", "cmp_cup"], ["cmp_kettle"]],
    create: { drag: "create.component", click: "create.component", keyAction: "create.component" },
    // the empty left third of the plot, 8 screen px and more from a stage boundary (components snap to those)
    spots: async (ctx) => [
      await plotPoint(ctx, 0.6, 0.28),
      await plotPoint(ctx, 0.75, 0.1),
      await plotPoint(ctx, 0.2, 0.28),
      await plotPoint(ctx, 0.5, 0.08),
    ],
    label: {
      targets: ["cmp_cup", "cmp_tea", "cmp_water"],
      text: (id) => `[data-element-id="${id}"] text.wardley-name-label`,
      box: "textarea.wardley-label-input",
      font: "textarea.wardley-label-input",
      named: (file, id, text) => {
        const [visibility, evolution] = TEA[id]?.at ?? [0, 0];
        return wardleyLines(file).some((line) => line.startsWith(`component ${text} [${visibility}, ${evolution}]`));
      },
    },
    pad: { targets: ["cmp_cup", "cmp_tea", "cmp_water", "cmp_kettle"] },
    has: (file, id) => wardleyLines(file).some((line) => line.startsWith(`component ${TEA[id]?.name ?? id} [`)),
    tooltipEntry: "create.anchor",
  },
  "value-chain": {
    file: "processes/order-to-cash.vc.json",
    root: "vc-root",
    hold: ["Control"],
    grid: 10,
    movers: ["step-stock", "step-capture", "step-delivery"],
    pair: ["step-stock", "step-capture"],
    lasso: [["step-stock", "step-capture"], ["step-stock"]],
    create: { drag: "create.step", click: "create.org-unit", keyAction: "create.step" },
    spots: (ctx) =>
      Promise.resolve([
        fraction(ctx, 0.62, 0.8),
        fraction(ctx, 0.5, 0.84),
        fraction(ctx, 0.8, 0.72),
        fraction(ctx, 0.4, 0.86),
      ]),
    label: {
      targets: ["step-stock", "step-capture", "step-delivery"],
      text: (id) => `[data-element-id="${id}"] > .djs-visual text`,
      box: ".djs-direct-editing-parent",
      font: ".djs-direct-editing-content",
      named: (file, id, text) => valueChain(file).elements.find((one) => one.id === id)?.name === text,
    },
    pad: { targets: ["step-stock", "step-capture", "step-delivery"] },
    has: (file, id) => valueChain(file).elements.some((one) => one.id === id),
    tooltipEntry: "global-connect-tool",
  },
  "team-topology": {
    file: "processes/online-shop.tt",
    root: "tt-root",
    hold: [],
    grid: 0,
    movers: ["team_fraud", "team_platform", "team_fulfilment"],
    pair: ["team_fraud", "team_platform"],
    lasso: [["team_fraud", "team_platform"], ["team_fulfilment"], ["int_platform_fulfilment"]],
    create: { drag: "team.enabling", click: "mode.collaboration", keyAction: "team.enabling" },
    spots: (ctx) =>
      Promise.resolve([
        fraction(ctx, 0.82, 0.82),
        fraction(ctx, 0.9, 0.9),
        fraction(ctx, 0.86, 0.72),
        fraction(ctx, 0.08, 0.9),
      ]),
    label: {
      targets: ["team_fraud", "team_platform", "team_fulfilment"],
      text: (id) => `[data-element-id="${id}"] > .djs-visual text`,
      box: "textarea.tt-label-editor",
      font: "textarea.tt-label-editor",
      named: (file, id, text) => teamTopology(file).nodes.find((one) => one.id === id)?.label === text,
    },
    pad: { targets: ["team_fraud", "team_platform", "team_fulfilment"] },
    has: (file, id) => teamTopology(file).nodes.some((one) => one.id === id),
    tooltipEntry: "team.platform",
  },
};

// ── the cases ────────────────────────────────────────────────────────────────

interface CaseDef {
  notations: readonly Notation[];
  /** what a person does */
  did: string;
  /** what is expected and why */
  expected: string;
  /** console lines this case may produce, each named in the report */
  allow?: readonly RegExp[];
  run(ctx: Ctx): Promise<Outcome>;
  /** the measured numbers in a few characters, for the folded table */
  cell(measured: Measured): string;
}

const ALL = NOTATIONS;
const num = (value: unknown, digits = 1): string => (typeof value === "number" ? fixed(value, digits) : "-");
const xy = (value: unknown, digits = 0): string => pt(value as Point | undefined, digits);

/**
 * Selects the first of `ids` that takes a press, opens its pad and clicks one entry. A pad whose
 * entry does not take a press where it is drawn (cut off by the node's edge, covered) is noted in
 * `measured.padCutOff` and the next id is tried: the row then says both that the pad was cut off
 * and whether the gesture itself works. Returns the click point, or the outcome that ends the case.
 */
async function viaPad(ctx: Ctx, ids: readonly string[], action: string, measured: Measured) {
  const cutOff: string[] = [];
  for (const id of ids) {
    let target;
    try {
      target = await selectByClick(ctx, [id]);
    } catch (error) {
      if (!(error instanceof Unmeasured)) throw error;
      cutOff.push(error.message);
      continue;
    }
    const entry = await padEntry(ctx, action);
    const click = await clickChrome(ctx, entry, isPad, `pad entry ${action} of ${id}`);
    if (click.clicked) {
      measured.element = id;
      if (cutOff.length > 0) measured.padCutOff = cutOff;
      return { target, at: click.at, entry: entry! };
    }
    cutOff.push(click.reason);
    // drop the selection and its pad before the next one is tried
    await ctx.board.press("Escape");
    await rest(ctx, 150);
  }
  measured.padCutOff = cutOff;
  return { outcome: { verdict: "broken", why: cutOff.join("; "), measured } satisfies Outcome };
}
/** ok, unless the pad of an earlier candidate was cut off: then the gesture worked, on another element */
function afterPad(measured: Measured, outcome: Outcome): Outcome {
  const cutOff = measured.padCutOff as string[] | undefined;
  if (outcome.verdict !== "ok" || !cutOff?.length) return outcome;
  return { ...outcome, verdict: "degraded", why: `done on ${String(measured.element)} after: ${cutOff.join("; ")}` };
}

/** opens the label editor of the first reachable target with a double-click on its middle */
async function openLabelEditor(ctx: Ctx, measured: Measured, targets: readonly string[] = ctx.spec.label.targets) {
  const target = await grab(ctx, targets);
  measured.element = target.id;
  if (target.covered.length > 0) measured.covered = target.covered;
  const labels = await ctx.node.query(ctx.spec.label.text(target.id));
  const label = labels.length > 0 ? union(...labels) : target.box;
  const labelFont = (await seen(ctx, ctx.spec.label.text(target.id)))[0]?.fontCss ?? 0;
  await ctx.board.doubleClick(target.at);
  const editor = await settled(ctx, ctx.spec.label.box, 1500);
  return { target, label, labelFont, editor };
}

interface PopupBody {
  popup: string;
  entries: string;
  /** the entry the case clicks */
  choose: string;
  isEntry(hit: Hit): boolean;
  /** the choice is in the file, on that element */
  applied(file: string, id: string): boolean;
}
interface PopupPlan extends PopupBody {
  targets: readonly string[];
  /** the pad entry that opens it */
  action: string;
}

/** a popup or picker the context pad opens: where it lies against the click that opened it, what of it takes a press, and whether a choice lands in the file */
async function popupCase(ctx: Ctx, plan: PopupPlan): Promise<Outcome> {
  const measured: Measured = {};
  const pad = await viaPad(ctx, plan.targets, plan.action, measured);
  if (pad.outcome) return pad.outcome;
  return popupBody(ctx, measured, pad.at, pad.target.id, plan);
}
/** the popup that the click at `at` opened */
async function popupBody(ctx: Ctx, measured: Measured, at: Point, id: string, plan: PopupBody): Promise<Outcome> {
  const popup = await settled(ctx, plan.popup, 2000);
  if (!popup) return { verdict: "broken", why: "nothing opened", measured };
  await ctx.shot("open", [popup]);
  // a list longer than the popup scrolls inside it: the entries it shows are the ones to reach
  const entries = (await seen(ctx, plan.entries)).filter((one) => inside(centre(one.box), popup));
  const boxes = entries.map((one) => one.box);
  const reach = await reachable(ctx, boxes, plan.isEntry);
  const off = fromAnchor(at, popup, ctx.host, 4 * ctx.chromePx);
  const entryPx = Math.min(...boxes.map((box) => Math.min(box.width, box.height)));
  const position = (await seen(ctx, plan.popup))[0]?.position ?? "";
  Object.assign(measured, {
    position,
    click: rp(at),
    popup: rb(popup),
    fromClickPx: round(off, 1),
    entries: entries.length,
    reachable: reach,
    entryPx: round(entryPx, 1),
    textPx: round((entries[0]?.fontCss ?? 0) * ctx.chromePx, 1),
    visibleShare: visibleShare(popup, ctx.clip),
    shownShare: await shownShare(ctx, popup, plan.popup),
    insideHost: visibleShare(popup, ctx.host),
  });
  const choice = await first(ctx, plan.choose);
  const click = await clickChrome(ctx, choice, plan.isEntry, "the entry to choose");
  if (!click.clicked) return { verdict: "broken", why: click.reason, measured };
  const file = (await fileChange(ctx, ctx.file0)) ?? ctx.file0;
  const applied = file !== ctx.file0 && plan.applied(file, id);
  Object.assign(measured, { fileChanged: file !== ctx.file0, applied });
  if (file === ctx.file0) return { verdict: "broken", why: "the choice did not reach the file", measured };
  if (!applied)
    return { verdict: "wrong-data", why: "the file changed, but not to the entry that was clicked", measured };
  if (off > ANCHOR_PX) {
    return afterPad(measured, {
      verdict: "degraded",
      why: `opened ${round(off, 0)} px from the click on its pad entry`,
      measured,
    });
  }
  if (visibleShare(popup, ctx.clip) < 0.999) {
    return afterPad(measured, {
      verdict: "degraded",
      why: `${round((1 - visibleShare(popup, ctx.clip)) * 100, 0)} % of it is cut off`,
      measured,
    });
  }
  if (reach < entries.length) {
    return {
      verdict: "degraded",
      why: `${entries.length - reach} of ${entries.length} entries do not take a press`,
      measured,
    };
  }
  if (entryPx < TARGET_PX)
    return { verdict: "degraded", why: `entries of ${round(entryPx, 0)} px on screen`, measured };
  if ((measured.shownShare as number) < 0.99) {
    return afterPad(measured, {
      verdict: "degraded",
      why: `${round((1 - (measured.shownShare as number)) * 100, 0)} % of it is not shown where it is drawn (clipped or covered)`,
      measured,
    });
  }
  return afterPad(measured, { verdict: "ok", why: "", measured });
}
const popupCell = (m: Measured): string =>
  m.popup
    ? `${num(m.fromClickPx, 0)} px from click, ${num((m.popup as Box).width, 0)}x${num((m.popup as Box).height, 0)}, ${String(m.reachable)}/${String(m.entries)}, ${m.applied ? "applied" : "not applied"}`
    : "none";

/** `steps` Control + wheel notches in at a point */
async function zoomIn(ctx: Ctx, at: Point, steps: number): Promise<void> {
  for (let step = 0; step < steps; step++) {
    await ctx.board.wheel(at, -120, { hold: ["Control"] });
    await rest(ctx, 200);
  }
}

/**
 * A point where a press reaches the bare canvas and from where the pointer can travel `travel`
 * screen px without leaving the node: searched on a grid from the lower right, since the palette
 * lies at the top and the samples leave their lower right corner free.
 */
async function barePoint(ctx: Ctx, travel: Point = { x: 0, y: 0 }): Promise<Point> {
  const map = await ctx.node.map();
  const edge = 14;
  const well = {
    x: ctx.host.x + edge + Math.max(0, -travel.x),
    y: ctx.host.y + edge + Math.max(0, -travel.y),
    width: ctx.host.width - 2 * edge - Math.abs(travel.x),
    height: ctx.host.height - 2 * edge - Math.abs(travel.y),
  };
  for (let fy = 0.92; fy > 0.2; fy -= 0.06) {
    for (let fx = 0.92; fx > 0.05; fx -= 0.06) {
      const candidate = fraction(ctx, fx, fy);
      if (!inside(candidate, well)) continue;
      const at = aimAt(map, candidate);
      const hit = await ctx.node.hit(at);
      if (hit.reachable && hit.element === ctx.spec.root && hit.what.startsWith("svg")) return at;
    }
  }
  throw new Unmeasured("no point of the bare canvas takes a press");
}

/**
 * Which document sees the keys from here on: the board page, and the node's own document where it
 * has one. Returns a function that reads the counts of trusted keydown events.
 */
async function watchKeys(ctx: Ctx): Promise<() => Promise<{ keysInBoardPage: number; keysInFrame?: number }>> {
  await recordEvents(ctx.board.page, ["keydown"]);
  if (ctx.node.frame) await recordEvents(ctx.node.frame, ["keydown"]);
  return async () => {
    const top = (await seenEvents(ctx.board.page, "keydown")).filter((one) => one.trusted).length;
    if (!ctx.node.frame) return { keysInBoardPage: top };
    const inner = (await seenEvents(ctx.node.frame, "keydown")).filter((one) => one.trusted).length;
    return { keysInBoardPage: top, keysInFrame: inner };
  };
}

// ── a board zoom under the armed editor (round 6) ────────────────────────────

/** the wheel burst of board-zoom: 8 events of 40 a frame apart, outwards (the board zoom times 0.64) */
const BURST = { deltaY: 40, count: 8 } as const;
/** what board-zoom types over a shape's name and leaves uncommitted */
const TYPED = "Zed";

/** what the open label editor holds right now: a field's value, else the text of the box; null when none is open */
const editorText = (ctx: Ctx): Promise<string | null> =>
  ctx.node.inDocument((host, selector: string) => {
    const field = host.querySelector(selector);
    if (!field) return null;
    return field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement
      ? field.value
      : (field.textContent ?? "");
  }, ctx.spec.label.font);

/** opens the label editor of the first reachable target and types over its name, WITHOUT committing */
async function typeUncommitted(ctx: Ctx, measured: Measured, targets?: readonly string[]) {
  const opened = await openLabelEditor(ctx, measured, targets);
  if (!opened.editor) return null;
  await ctx.board.press("Control+A");
  await ctx.board.type(TYPED);
  await rest(ctx, 100);
  return opened;
}

/** lines of `now` that `was` does not hold: what a commit added to the file */
const newLines = (was: string, now: string): string[] => {
  const old = new Set(was.split("\n"));
  return now.split("\n").filter((one) => !old.has(one));
};

/**
 * The reference of board-zoom, on a page of its own with the row's URL: the same shape, the same
 * typed text, and a click on the bare board instead of the wheel. Returns the file that click
 * writes. Console output of that page is harness trouble like the row's own.
 */
async function byPaneClick(ctx: Ctx, element: string) {
  const board = await ctx.harness.open({
    board: "matrix",
    strategy: ctx.strategy,
    notations: [ctx.notation as ModelNotation],
    zoom: ctx.asked,
    ...ORIGIN,
  });
  try {
    await board.arm(ctx.node.id);
    const node = await board.node(ctx.node.id);
    const twin: Ctx = { ...ctx, board, node, host: await node.hostBox(), shot: () => Promise.resolve() };
    const file0 = await fileNow(twin);
    if (!(await typeUncommitted(twin, {}, [element]))) throw new Unmeasured("the second page opened no editor box");
    const pane = await board.freePanePoint();
    if (!pane) throw new Unmeasured("the second page has no point of the bare board");
    await board.click(pane);
    const file = (await fileChange(twin, file0)) ?? file0;
    await rest(twin, 300);
    const problems = await board.problems();
    if (problems.length > 0) throw new Error(`the second page: ${problems[0]!.slice(0, 160)}`);
    return {
      file: await fileNow(twin),
      sameStart: file0 === ctx.file0,
      changed: file !== file0,
      armed: (await board.armState()).armed === ctx.node.id,
      viewport: await board.viewport(),
    };
  } finally {
    await board.close().catch(() => undefined);
  }
}

const CASES: Readonly<Record<string, CaseDef>> = {
  // ── move ──
  "move-shape": {
    notations: ALL,
    did: "press a shape at its middle, drag (60, 40) flow units, release",
    expected:
      "the shape travels what the pointer travels (ratio 1.00, within one diagram unit of rounding) and the file changes; an engine that takes client px for its own px moves it by net x the pointer",
    async run(ctx) {
      const target = await grab(ctx, ctx.spec.movers);
      const dragged = await ctx.node.drag(
        target.at,
        { x: TRAVEL.x * ctx.zoom, y: TRAVEL.y * ctx.zoom },
        { hold: ctx.spec.hold },
      );
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      const after = await shapeBox(ctx, target.id);
      const moved = after ? sub(origin(after), origin(target.box)) : { x: 0, y: 0 };
      const measured: Measured = {
        element: target.id,
        ...(target.covered.length > 0 ? { covered: target.covered } : {}),
        pointer: rp(dragged.delta),
        moved: rp(moved),
        ratio: { x: round(moved.x / dragged.delta.x, 3), y: round(moved.y / dragged.delta.y, 3) },
        errorPx: rp(sub(moved, dragged.delta)),
        fileChanged: changed,
      };
      return pointerOutcome(
        changed && len(moved) > 1,
        sub(moved, dragged.delta),
        ctx.tol,
        measured,
        "the shape did not move or the file did not change",
      );
    },
    cell: (m) => `${num((m.ratio as Point | undefined)?.x, 2)}/${num((m.ratio as Point | undefined)?.y, 2)}`,
  },

  "move-selection": {
    notations: ALL,
    did: "click one shape, Shift + click a second, press the first again and drag (60, 40) flow units",
    expected:
      "both shapes travel what the pointer travels, by the same amount, as one change of the file; the press on a selected shape goes to that shape",
    async run(ctx) {
      const [a, b] = ctx.spec.pair;
      const first = await grab(ctx, [a]);
      await ctx.board.click(first.at);
      // the first shape's pad is open now: the second press is hit-tested against it
      await settled(ctx, ".djs-context-pad.open", 1000);
      let second;
      try {
        second = await grab(ctx, [b]);
      } catch (error) {
        if (!(error instanceof Unmeasured)) throw error;
        // in every layout the pair was chosen for, the second shape lies clear of the first one's pad
        return {
          verdict: "broken",
          why: `the second shape does not take the Shift + click: ${error.message}`,
          measured: { elements: [a, b] },
        };
      }
      await ctx.board.page.keyboard.down("Shift");
      await ctx.board.click(second.at);
      await ctx.board.page.keyboard.up("Shift");
      const both = await ctx.board.waitFor(async () => {
        const selected = await ctx.node.selected();
        return selected.includes(a) && selected.includes(b);
      }, 1500);
      const measured: Measured = { elements: [a, b], selected: (await ctx.node.selected()).length };
      if (!both)
        return { verdict: "broken", why: "Shift + click did not add the second shape to the selection", measured };
      await rest(ctx, 300);
      // what a press on the first shape reaches now that both are selected
      const press = await ctx.node.hit(first.at);
      const view = await ctx.node.viewportMatrix();
      measured.pressGoesTo = press.element === a ? a : `${press.element ?? "nothing"} (${press.what})`;
      const dragged = await ctx.node.drag(
        first.at,
        { x: TRAVEL.x * ctx.zoom, y: TRAVEL.y * ctx.zoom },
        { hold: ctx.spec.hold },
      );
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      const [afterA, afterB, viewAfter] = [
        await shapeBox(ctx, a),
        await shapeBox(ctx, b),
        await ctx.node.viewportMatrix(),
      ];
      const movedA = afterA ? sub(origin(afterA), origin(first.box)) : { x: 0, y: 0 };
      const movedB = afterB ? sub(origin(afterB), origin(second.box)) : { x: 0, y: 0 };
      const panned = !!view && !!viewAfter && Math.hypot(viewAfter.e - view.e, viewAfter.f - view.f) > 1;
      Object.assign(measured, {
        pointer: rp(dragged.delta),
        moved: rp(movedA),
        movedSecond: rp(movedB),
        ratio: { x: round(movedA.x / dragged.delta.x, 3), y: round(movedA.y / dragged.delta.y, 3) },
        errorPx: rp(sub(movedA, dragged.delta)),
        apartPx: round(len(sub(movedA, movedB)), 2),
        fileChanged: changed,
        canvasPanned: panned,
      });
      if (!changed) {
        return {
          verdict: "broken",
          why: `the selection did not move in the file: the press went to ${String(measured.pressGoesTo)}${panned ? " and the canvas panned instead" : ""}`,
          measured,
        };
      }
      if (len(sub(movedA, movedB)) > Math.max(1, ctx.unitPx)) {
        return { verdict: "degraded", why: "the two shapes moved by different amounts", measured };
      }
      return pointerOutcome(
        len(movedA) > 1,
        sub(movedA, dragged.delta),
        ctx.tol,
        measured,
        "the selection did not move",
      );
    },
    cell: (m) =>
      m.fileChanged
        ? `${num((m.ratio as Point | undefined)?.x, 2)}/${num((m.ratio as Point | undefined)?.y, 2)}`
        : m.canvasPanned
          ? "canvas panned"
          : "no move",
  },

  // ── create ──
  "create-palette-drag": {
    notations: ALL,
    did: "drag a creating palette entry onto a free point of the canvas, release, Escape",
    expected: "a new shape with its middle at the drop point (within one diagram unit), written to the file",
    async run(ctx) {
      const before = await ctx.node.elementIds();
      const entry = await first(ctx, `.djs-palette .entry[data-action="${ctx.spec.create.drag}"]`);
      const measured: Measured = { entry: ctx.spec.create.drag };
      if (!entry || !isPalette(await ctx.node.hit(centre(entry)))) {
        return {
          verdict: "broken",
          why: `the palette entry ${ctx.spec.create.drag} does not take a press where it is drawn`,
          measured,
        };
      }
      const to = await freeSpot(ctx);
      const dragged = await ctx.node.paletteDrag(entry, to, { hold: ctx.spec.hold });
      const id = await newShape(ctx, before);
      await ctx.shot("dropped");
      await rest(ctx, 250);
      await ctx.board.press("Escape");
      const box = id ? await shapeBox(ctx, id) : undefined;
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      const error = box ? sub(centre(box), dragged.to) : { x: 0, y: 0 };
      Object.assign(measured, {
        drop: rp(dragged.to),
        created: !!id,
        middle: box ? rp(centre(box)) : null,
        errorPx: rp(error),
        fileChanged: changed,
      });
      return pointerOutcome(
        !!box && changed,
        error,
        ctx.tol,
        measured,
        id ? "the new shape is not in the file" : "no shape was created",
      );
    },
    cell: (m) => (m.created ? `off ${xy(m.errorPx)}` : "none"),
  },

  "create-palette-click": {
    notations: ALL,
    did: "click a creating palette entry, move to a free point of the canvas, click, Escape",
    expected:
      "a new shape with its middle at the click (within one diagram unit, or half a grid step where the engine snaps), written to the file",
    async run(ctx) {
      const before = await ctx.node.elementIds();
      const entry = await first(ctx, `.djs-palette .entry[data-action="${ctx.spec.create.click}"]`);
      const measured: Measured = { entry: ctx.spec.create.click };
      const to = await freeSpot(ctx);
      const click = await clickChrome(ctx, entry, isPalette, `palette entry ${ctx.spec.create.click}`);
      if (!click.clicked) return { verdict: "broken", why: click.reason, measured };
      await rest(ctx, 150);
      await ctx.board.move(to, 10);
      await rest(ctx, 100);
      await ctx.shot("moving");
      await ctx.board.click(to);
      const id = await newShape(ctx, before);
      await rest(ctx, 250);
      await ctx.board.press("Escape");
      const box = id ? await shapeBox(ctx, id) : undefined;
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      const error = box ? sub(centre(box), to) : { x: 0, y: 0 };
      Object.assign(measured, {
        drop: rp(to),
        created: !!id,
        middle: box ? rp(centre(box)) : null,
        errorPx: rp(error),
        fileChanged: changed,
      });
      // no key can be held over a click-click gesture: the engine's grid applies
      const tol = ctx.tol + (ctx.spec.grid / 2) * ctx.unitPx;
      return pointerOutcome(
        !!box && changed,
        error,
        tol,
        measured,
        id ? "the new shape is not in the file" : "no shape was created",
      );
    },
    cell: (m) => (m.created ? `off ${xy(m.errorPx)}` : "none"),
  },

  "create-keyboard": {
    notations: ALL,
    did: "Shift + Tab from the canvas into the palette, arrow keys to a creating entry, Enter, Escape",
    expected:
      "a new shape in the free middle of the view with its label editor open, written to the file, at a place where a press reaches it; the keys act in the editor and nowhere else",
    async run(ctx) {
      const before = await ctx.node.elementIds();
      const measured: Measured = { entry: ctx.spec.create.keyAction };
      await ctx.board.press("Shift+Tab");
      let focus = await focusOf(ctx);
      measured.focusAfterTab = focus.what;
      for (let step = 0; step < 16 && focus.action !== ctx.spec.create.keyAction; step++) {
        await ctx.board.press("ArrowRight");
        focus = await focusOf(ctx);
      }
      if (focus.action !== ctx.spec.create.keyAction) {
        return {
          verdict: "broken",
          why: `the keyboard did not reach the palette entry (focus on ${focus.what})`,
          measured,
        };
      }
      await ctx.board.press("Enter");
      const id = await newShape(ctx, before);
      await rest(ctx, 300);
      measured.editorOpen = (await ctx.node.query(ctx.spec.label.box)).length > 0;
      await ctx.shot("created");
      await ctx.board.press("Escape");
      await rest(ctx, 200);
      const box = id ? await shapeBox(ctx, id) : undefined;
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      const hit = box ? await ctx.node.hit(centre(box)) : undefined;
      Object.assign(measured, {
        created: !!id,
        middle: box ? rp(centre(box)) : null,
        fromHostMiddle: box ? rp(sub(centre(box), centre(ctx.host))) : null,
        takesPress: !!hit && hit.reachable && hit.element === id,
        under: hit && !(hit.reachable && hit.element === id) ? hit.what : undefined,
        fileChanged: changed,
      });
      if (!box || !changed)
        return { verdict: "broken", why: id ? "the new shape is not in the file" : "no shape was created", measured };
      if (!measured.takesPress)
        return {
          verdict: "degraded",
          why: `the new shape lies where a press does not reach it (${hit?.what ?? "?"})`,
          measured,
        };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) => (m.created ? `at ${xy(m.fromHostMiddle)} of mid${m.takesPress ? "" : ", covered"}` : "none"),
  },

  "create-pad-append": {
    notations: ALL,
    did: "select a shape, use the context pad's append entry (Wardley: click it, move, click the drop point; Value Chain and Team Topology: one click places the new element)",
    expected:
      "a new element connected to the selected one, in the file; Wardley: its middle at the click (within one diagram unit); the other two: placed by the engine beside the source",
    async run(ctx) {
      const before = await ctx.node.elementIds();
      const measured: Measured = {};
      const [ids, action] =
        ctx.notation === "wardley"
          ? [["cmp_water", "cmp_hot_water", "cmp_kettle"], "append"]
          : ctx.notation === "value-chain"
            ? [["step-stock", "step-delivery"], "append.step"]
            : [["team_platform", "team_fulfilment"], "append-annotation"];
      // Wardley's drop point is looked up before the pad opens: the pad may cover it
      const to = ctx.notation === "wardley" ? await freeSpot(ctx) : undefined;
      const pad = await viaPad(ctx, ids, action, measured);
      if (pad.outcome) return pad.outcome;
      if (to) {
        await rest(ctx, 150);
        await ctx.board.move(to, 10);
        await rest(ctx, 100);
        await ctx.board.click(to);
      }
      const id = await newShape(ctx, before);
      await rest(ctx, 300);
      await ctx.shot("appended");
      if (ctx.notation === "team-topology") {
        // an annotation without text is dropped again
        await ctx.board.type("Note");
        await ctx.board.press("Enter");
      } else {
        await ctx.board.press("Escape");
      }
      const box = id ? await shapeBox(ctx, id) : undefined;
      const file = (await fileChange(ctx, ctx.file0)) ?? ctx.file0;
      const source = pad.target.id;
      const linked =
        ctx.notation === "wardley"
          ? wardleyLines(file).some(
              (line) => line.startsWith(`${TEA[source]?.name ?? "?"} -> `) && !ctx.file0.includes(line),
            )
          : ctx.notation === "value-chain"
            ? valueChain(file).connections.some((one) => one.source === source && !ctx.file0.includes(`"${one.id}"`))
            : teamTopology(file).annotations.some(
                (one) => one.attachedTo === source && !ctx.file0.includes(`"${one.id}"`),
              );
      Object.assign(measured, { created: !!id, middle: box ? rp(centre(box)) : null, linkedInFile: linked });
      if (!box || !linked)
        return {
          verdict: "broken",
          why: id ? "the new element is not connected to its source in the file" : "no element was created",
          measured,
        };
      if (to) {
        const error = sub(centre(box), to);
        Object.assign(measured, { drop: rp(to), errorPx: rp(error) });
        return afterPad(measured, pointerOutcome(true, error, ctx.tol, measured, ""));
      }
      const from = await shapeBox(ctx, source);
      measured.fromSourceUnits = from
        ? rp({ x: (centre(box).x - centre(from).x) / ctx.unitPx, y: (centre(box).y - centre(from).y) / ctx.unitPx }, 0)
        : null;
      return afterPad(measured, { verdict: "ok", why: "", measured });
    },
    cell: (m) => (m.created ? (m.errorPx ? `off ${xy(m.errorPx)}` : `placed ${xy(m.fromSourceUnits)} units`) : "none"),
  },

  // ── connect and draw ──
  "connect-pad": {
    notations: ALL,
    did: "select a shape, click the pad's connect entry, move onto another element, click",
    expected:
      "the file gains the relation between exactly these two elements (the target is the element under the pointer)",
    async run(ctx) {
      const measured: Measured = {};
      // source -> target per source candidate: a relation the sample does not hold yet
      const plans: ReadonlyArray<{ source: string; target: string; at: number }> =
        ctx.notation === "wardley"
          ? [
              { source: "cmp_water", target: "cmp_power", at: 0.5 },
              { source: "cmp_kettle", target: "cmp_water", at: 0.5 },
            ]
          : ctx.notation === "value-chain"
            ? [{ source: "step-capture", target: "step-stock", at: 0.5 }]
            : [{ source: "ann_fraud_handover", target: "team_fulfilment", at: 0.82 }];
      const action = ctx.notation === "value-chain" ? "connect.sequence" : "connect";
      const pad = await viaPad(
        ctx,
        plans.map((one) => one.source),
        action,
        measured,
      );
      if (pad.outcome) return pad.outcome;
      const plan = plans.find((one) => one.source === pad.target.id)!;
      const targetBox = await shapeBox(ctx, plan.target);
      if (!targetBox) throw new Unmeasured(`${plan.target} is not drawn`);
      const aim = aimAt(await ctx.node.map(), {
        x: targetBox.x + targetBox.width * plan.at,
        y: targetBox.y + targetBox.height / 2,
      });
      await rest(ctx, 150);
      await ctx.board.move(aim, 12);
      await rest(ctx, 120);
      const over = await ctx.node.hit(aim);
      measured.target = plan.target;
      measured.underPointer = over.element;
      await ctx.shot("aiming");
      await ctx.board.click(aim);
      const file = (await fileChange(ctx, ctx.file0)) ?? ctx.file0;
      const relation = relationOf(ctx, file, plan.source);
      Object.assign(measured, { relation, fileChanged: file !== ctx.file0 });
      if (file === ctx.file0) return { verdict: "broken", why: "no relation was written", measured };
      if (relation !== plan.target)
        return {
          verdict: "wrong-data",
          why: `connected to ${relation ?? "something else"} instead of ${plan.target}`,
          measured,
        };
      return afterPad(measured, { verdict: "ok", why: "", measured });
    },
    cell: (m) => (m.fileChanged ? `to ${String(m.relation)}` : "none"),
  },

  "connect-tool": {
    notations: ["wardley", "value-chain"],
    did: "Wardley: select a component, press A, move onto another, click. Value Chain: click the palette's Connect tool, click the source, move onto the target, click",
    expected: "the file gains the relation between exactly these two elements",
    async run(ctx) {
      const measured: Measured = {};
      const plan =
        ctx.notation === "wardley"
          ? { source: "cmp_water", target: "cmp_power" }
          : { source: "org-sales", target: "step-stock" };
      const targetBox = await shapeBox(ctx, plan.target);
      if (!targetBox) throw new Unmeasured(`${plan.target} is not drawn`);
      const aim = aimAt(await ctx.node.map(), centre(targetBox));
      if (ctx.notation === "wardley") {
        await selectByClick(ctx, [plan.source]);
        await ctx.board.press("a");
      } else {
        const tool = await first(ctx, '.djs-palette .entry[data-action="global-connect-tool"]');
        const click = await clickChrome(ctx, tool, isPalette, "palette entry global-connect-tool");
        if (!click.clicked) return { verdict: "broken", why: click.reason, measured };
        const source = await grab(ctx, [plan.source]);
        await ctx.board.move(source.at, 6);
        await ctx.board.click(source.at);
      }
      await rest(ctx, 150);
      await ctx.board.move(aim, 12);
      await rest(ctx, 120);
      measured.target = plan.target;
      measured.underPointer = (await ctx.node.hit(aim)).element;
      await ctx.board.click(aim);
      const file = (await fileChange(ctx, ctx.file0)) ?? ctx.file0;
      const relation = relationOf(ctx, file, plan.source);
      Object.assign(measured, { relation, fileChanged: file !== ctx.file0 });
      if (file === ctx.file0) return { verdict: "broken", why: "no relation was written", measured };
      if (relation !== plan.target)
        return {
          verdict: "wrong-data",
          why: `connected to ${relation ?? "something else"} instead of ${plan.target}`,
          measured,
        };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) => (m.fileChanged ? `to ${String(m.relation)}` : "none"),
  },

  "draw-tool": {
    notations: ["wardley"],
    did: "click the palette's Draw tool, click a first point of the plot, move (70, 40) flow units, double-click",
    expected:
      "a line from the first click to the double-click (both ends within one diagram unit), written to the file",
    async run(ctx) {
      const before = await ctx.node.elementIds();
      const measured: Measured = {};
      const map = await ctx.node.map();
      const from = aimAt(map, await plotPoint(ctx, 0.72, 0.06));
      const to = aimAt(map, { x: from.x + 70 * ctx.zoom, y: from.y + 40 * ctx.zoom });
      const tool = await first(ctx, '.djs-palette .entry[data-action="draw-tool"]');
      const click = await clickChrome(ctx, tool, isPalette, "palette entry draw-tool");
      if (!click.clicked) return { verdict: "broken", why: click.reason, measured };
      for (const point of [from, to]) {
        const hit = await ctx.node.hit(point);
        if (!hit.reachable || hit.element !== ctx.spec.root)
          throw new Unmeasured(`the plot point ${pt(point)} is covered by ${hit.what}`);
      }
      await ctx.board.move(from, 6);
      await ctx.board.click(from);
      await ctx.board.move(to, 8);
      await ctx.shot("drawing");
      await ctx.board.doubleClick(to);
      const id = await ctx.board.waitFor(async () => (await created(ctx, before))[0] ?? null, 1500);
      const line = id ? await first(ctx, `[data-element-id="${id}"] > .djs-visual polyline`) : undefined;
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      const start = line ? sub(origin(line), from) : { x: 0, y: 0 };
      const end = line ? sub({ x: line.x + line.width, y: line.y + line.height }, to) : { x: 0, y: 0 };
      Object.assign(measured, {
        from: rp(from),
        to: rp(to),
        created: !!id,
        startErrorPx: rp(start),
        endErrorPx: rp(end),
        fileChanged: changed,
      });
      const worst = len(start) > len(end) ? start : end;
      return pointerOutcome(
        !!line && changed,
        worst,
        ctx.tol,
        measured,
        id ? "the line is not in the file" : "no line was drawn",
      );
    },
    cell: (m) => (m.created ? `ends off ${xy(m.startErrorPx)} / ${xy(m.endErrorPx)}` : "none"),
  },

  // ── text ──
  "label-edit-box": {
    notations: ALL,
    did: "double-click a shape, look at the editor box, Escape",
    expected:
      "an editor box over the shape's label (the label's middle inside the box), with the focus, in text of 9 px or more on screen; closing it without typing leaves the file byte-identical",
    async run(ctx) {
      const measured: Measured = {};
      const { label, labelFont, editor } = await openLabelEditor(ctx, measured);
      if (!editor) return { verdict: "broken", why: "no editor box opened", measured };
      const font = (await seen(ctx, ctx.spec.label.font))[0]?.fontCss ?? 0;
      const focus = await focusOf(ctx);
      await ctx.shot("editing", [editor]);
      const over = inside(centre(label), editor, 2);
      Object.assign(measured, {
        label: rb(label),
        editor: rb(editor),
        offsetPx: rp(sub(centre(editor), centre(label))),
        overLabel: over,
        editorTextPx: round(font * ctx.chromePx, 1),
        labelTextPx: round(labelFont * ctx.unitPx, 1),
        focusInEditor: focus.inHost && /textarea|direct-editing/.test(focus.what),
        visibleShare: visibleShare(editor, ctx.clip),
      });
      await ctx.board.press("Escape");
      await rest(ctx, 700);
      const identical = (await fileNow(ctx)) === ctx.file0;
      measured.fileIdentical = identical;
      measured.closed = (await ctx.node.query(ctx.spec.label.box)).length === 0;
      if (!identical) return { verdict: "wrong-data", why: "the file changed although nothing was typed", measured };
      if (!over)
        return {
          verdict: "degraded",
          why: `the editor box is ${pt(measured.offsetPx as Point)} px from its label`,
          measured,
        };
      if (Math.round(font * ctx.chromePx) < TEXT_PX)
        return { verdict: "degraded", why: `editor text of ${round(font * ctx.chromePx, 1)} px on screen`, measured };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) => (m.editor ? `off ${xy(m.offsetPx)}, text ${num(m.editorTextPx)} px` : "none"),
  },

  "label-type": {
    notations: ALL,
    did: "double-click a shape, select all, type Zed, Enter",
    expected: "the file carries Zed as the name of exactly that shape",
    async run(ctx) {
      const measured: Measured = {};
      const { target, editor } = await openLabelEditor(ctx, measured);
      if (!editor) return { verdict: "broken", why: "no editor box opened", measured };
      await ctx.board.press("Control+A");
      await ctx.board.type("Zed");
      await ctx.board.press("Enter");
      const file = (await fileChange(ctx, ctx.file0)) ?? ctx.file0;
      const named = file !== ctx.file0 && ctx.spec.label.named(file, target.id, "Zed");
      Object.assign(measured, { fileChanged: file !== ctx.file0, named });
      if (file === ctx.file0) return { verdict: "broken", why: "the typed text did not reach the file", measured };
      if (!named) return { verdict: "wrong-data", why: "the file changed, but that shape is not named Zed", measured };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) => (m.named ? "in file" : m.fileChanged ? "elsewhere" : "not in file"),
  },

  // ── context pad ──
  "pad-layout": {
    notations: ALL,
    did: "click a shape and look at its context pad",
    expected:
      "the pad beside the shape (0 to 16 diagram units + 8 px from its edge, tops within 8 units + 8 px), every entry takes a press where it is drawn and is 24 px or more on screen",
    async run(ctx) {
      const target = await selectByClick(ctx, ctx.spec.pad.targets);
      const pad = await settled(ctx, ".djs-context-pad.open");
      const measured: Measured = {
        element: target.id,
        ...(target.covered.length > 0 ? { covered: target.covered } : {}),
      };
      if (!pad) return { verdict: "broken", why: "no context pad opened", measured };
      await ctx.shot("pad", [pad]);
      // the pad is placed against everything the element draws (Wardley: its name too)
      const anchor = (await ctx.node.elementBox(target.id)) ?? target.box;
      const entries = await seen(ctx, ".djs-context-pad.open .entry");
      const reach = await reachable(
        ctx,
        entries.map((one) => one.box),
        isPad,
      );
      const right = pad.x - (anchor.x + anchor.width);
      const left = anchor.x - (pad.x + pad.width);
      const gap = right >= -4 ? right : left >= -4 ? left : -Math.min(-right, -left);
      const entryPx = Math.min(...entries.map((one) => Math.min(one.box.width, one.box.height)));
      const top = pad.y - anchor.y;
      Object.assign(measured, {
        anchor: rb(anchor),
        pad: rb(pad),
        side: right >= -4 ? "right" : left >= -4 ? "left" : "over",
        gapPx: round(gap, 1),
        topPx: round(top, 1),
        entries: entries.length,
        reachable: reach,
        entryPx: round(entryPx, 1),
        visibleShare: visibleShare(pad, ctx.clip),
        insideHost: visibleShare(pad, ctx.host),
      });
      if (reach === 0) return { verdict: "broken", why: "no pad entry takes a press where it is drawn", measured };
      const attached = gap >= -4 && gap <= 16 * ctx.unitPx + 8 && Math.abs(top) <= 8 * ctx.unitPx + 8;
      if (!attached)
        return {
          verdict: "degraded",
          why: `the pad is ${round(gap, 0)} px beside and ${round(top, 0)} px below its shape's edge`,
          measured,
        };
      if (reach < entries.length)
        return {
          verdict: "degraded",
          why: `${entries.length - reach} of ${entries.length} entries do not take a press`,
          measured,
        };
      if (entryPx < TARGET_PX)
        return { verdict: "degraded", why: `entries of ${round(entryPx, 0)} px on screen`, measured };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) =>
      m.pad
        ? `gap ${num(m.gapPx, 0)}/${num(m.topPx, 0)}, ${String(m.reachable)}/${String(m.entries)}, ${num(m.entryPx, 0)} px`
        : "none",
  },

  "pad-delete": {
    notations: ALL,
    did: "click a shape, click the pad's Delete entry",
    expected: "exactly that shape is gone from the file",
    async run(ctx) {
      const measured: Measured = {};
      const pad = await viaPad(ctx, ctx.spec.pad.targets, "delete", measured);
      if (pad.outcome) return pad.outcome;
      const file = (await fileChange(ctx, ctx.file0)) ?? ctx.file0;
      const gone = !ctx.spec.has(file, pad.target.id);
      const others = ctx.spec.pad.targets.filter((id) => id !== pad.target.id).every((id) => ctx.spec.has(file, id));
      Object.assign(measured, { fileChanged: file !== ctx.file0, gone, othersKept: others });
      if (file === ctx.file0) return { verdict: "broken", why: "the file did not change", measured };
      if (!gone || !others)
        return { verdict: "wrong-data", why: "the file lost something else than the shape", measured };
      return afterPad(measured, { verdict: "ok", why: "", measured });
    },
    cell: (m) => (m.gone ? "deleted" : m.element ? "not deleted" : "none"),
  },

  // ── popups the pad opens ──
  "popup-settings": {
    notations: ["wardley"],
    did: "click a component, click the pad's Settings entry, look at the menu, click Market",
    expected:
      "diagram-js's popup menu (position: fixed) opens at the click, whole inside what the person sees, every entry takes a press and is 24 px or more high, and the file marks that component (market)",
    run: (ctx) =>
      popupCase(ctx, {
        targets: ["cmp_cup", "cmp_tea", "cmp_water", "cmp_kettle"],
        action: "settings",
        popup: ".djs-popup.wardley-element-settings",
        entries: ".djs-popup.wardley-element-settings .entry",
        choose: '.djs-popup.wardley-element-settings .entry[data-id="type-market"]',
        isEntry: isPopup,
        applied: (file, id) =>
          wardleyLines(file).some(
            (line) => line.startsWith(`component ${TEA[id]?.name} [`) && line.includes("(market)"),
          ),
      }),
    cell: popupCell,
  },

  "popup-color": {
    notations: ["wardley", "value-chain"],
    did: "click a shape, click the pad's colour entry, look at the picker, click a colour (Wardley: Amber, Value Chain: Green)",
    expected:
      "the picker opens at the click (Wardley: the renderer's own box, position: absolute in its container; Value Chain: diagram-js's popup menu, position: fixed), every swatch or entry takes a press, and the file carries the colour on that shape",
    run: (ctx) =>
      ctx.notation === "wardley"
        ? popupCase(ctx, {
            targets: ["cmp_cup", "cmp_tea", "cmp_water", "cmp_kettle"],
            action: "color",
            popup: ".wardley-color-picker",
            entries: ".wardley-color-picker .wardley-cp-swatch",
            choose: '.wardley-color-picker .wardley-cp-swatch[aria-label^="Amber"]',
            isEntry: isClass("wardley-cp-swatch"),
            applied: (file, id) =>
              wardleyLines(file).some(
                (line) => line.startsWith(`component ${TEA[id]?.name} [`) && line.includes("(color #92610A)"),
              ),
          })
        : popupCase(ctx, {
            targets: ["step-stock", "step-capture", "step-delivery"],
            action: "set-color",
            popup: ".djs-popup.vc-color-picker",
            entries: ".djs-popup.vc-color-picker .entry",
            choose: '.djs-popup.vc-color-picker .entry[data-id="color-green"]',
            isEntry: isPopup,
            applied: (file, id) => valueChain(file).elements.find((one) => one.id === id)?.color === "#00E676",
          }),
    cell: popupCell,
  },

  // ── the renderers' own gestures ──
  "evolve-handle": {
    notations: ["wardley"],
    did: "press the evolve handle of Kettle (the red circle at its target maturity), drag 60 flow units to the right, release",
    expected:
      "the handle travels what the pointer travels along the evolution axis (the renderer maps the pointer through the container's client width, so an outer scale cancels out) and the file's evolve value changes",
    async run(ctx) {
      const selector = '[data-element-id="cmp_kettle"] .wardley-evolve-handle';
      const handle = await first(ctx, selector);
      const measured: Measured = {};
      if (!handle) throw new Unmeasured("Kettle shows no evolve handle");
      const at = aimAt(await ctx.node.map(), centre(handle));
      const hit = await ctx.node.hit(at);
      if (!isClass("wardley-evolve-handle")(hit)) throw new Unmeasured(`the evolve handle is covered by ${hit.what}`);
      const dragged = await ctx.node.drag(at, { x: TRAVEL.x * ctx.zoom, y: 0 });
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      const after = await first(ctx, selector);
      const moved = after ? sub(origin(after), origin(handle)) : { x: 0, y: 0 };
      Object.assign(measured, {
        pointer: rp(dragged.delta),
        moved: rp(moved),
        ratio: round(moved.x / dragged.delta.x, 3),
        errorPx: rp({ x: moved.x - dragged.delta.x, y: 0 }),
        fileChanged: changed,
        evolve: /evolve Kettle ([\d.]+)/.exec(await fileNow(ctx))?.[1] ?? null,
      });
      return pointerOutcome(
        changed && Math.abs(moved.x) > 1,
        { x: moved.x - dragged.delta.x, y: 0 },
        ctx.tol,
        measured,
        "the handle did not move or the file did not change",
      );
    },
    cell: (m) => `${num(m.ratio, 2)}, evolve ${String(m.evolve)}`,
  },

  "evolve-pad": {
    notations: ["wardley"],
    did: "click a component without a target maturity, click the pad's Evolve entry, move 80 flow units to the right, click",
    expected:
      "an evolve handle with its middle under the click along the evolution axis, and an evolve line in the file",
    async run(ctx) {
      const measured: Measured = {};
      const pad = await viaPad(ctx, ["cmp_cup_of_tea", "cmp_power", "cmp_hot_water"], "evolve", measured);
      if (pad.outcome) return pad.outcome;
      const to = aimAt(await ctx.node.map(), {
        x: pad.target.at.x + 80 * ctx.zoom,
        y: pad.target.at.y + 14 * ctx.zoom,
      });
      await rest(ctx, 150);
      await ctx.board.move(to, 10);
      await rest(ctx, 100);
      await ctx.shot("aiming");
      await ctx.board.click(to);
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      const handle = await first(ctx, `[data-element-id="${pad.target.id}"] .wardley-evolve-handle`);
      const error = handle ? { x: centre(handle).x - to.x, y: 0 } : { x: 0, y: 0 };
      Object.assign(measured, {
        click: rp(to),
        handle: handle ? rp(centre(handle)) : null,
        errorPx: rp(error),
        fileChanged: changed,
      });
      return afterPad(
        measured,
        pointerOutcome(
          !!handle && changed,
          error,
          ctx.tol,
          measured,
          "no evolve target was written: the click right of the component was not taken as a later maturity",
        ),
      );
    },
    cell: (m) => (m.handle ? `off ${num((m.errorPx as Point).x, 0)} px along x` : "none"),
  },

  "label-drag": {
    notations: ["wardley"],
    did: "press a component's name, drag it (30, -20) flow units, release",
    expected: "the name travels what the pointer travels and the file gains its label offset",
    async run(ctx) {
      const measured: Measured = {};
      const map = await ctx.node.map();
      let chosen: { id: string; box: Box; at: Point } | undefined;
      const covered: string[] = [];
      for (const id of ["cmp_tea", "cmp_water", "cmp_hot_water", "cmp_cup"]) {
        const box = await first(ctx, `[data-element-id="${id}"] text.wardley-name-label`);
        if (!box) continue;
        const at = aimAt(map, centre(box));
        const hit = await ctx.node.hit(at);
        if (isClass("wardley-name-label")(hit) && hit.element === id) {
          chosen = { id, box, at };
          break;
        }
        covered.push(`${id}: ${hit.reachable ? hit.what : "outside the editor"}`);
      }
      if (!chosen) throw new Unmeasured(`no name takes a press (${covered.join("; ")})`);
      const selector = `[data-element-id="${chosen.id}"] text.wardley-name-label`;
      const dragged = await ctx.node.drag(chosen.at, { x: 30 * ctx.zoom, y: -20 * ctx.zoom });
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      const after = await first(ctx, selector);
      const moved = after ? sub(origin(after), origin(chosen.box)) : { x: 0, y: 0 };
      Object.assign(measured, {
        element: chosen.id,
        labelPx: rb(chosen.box),
        pointer: rp(dragged.delta),
        moved: rp(moved),
        ratio: { x: round(moved.x / dragged.delta.x, 3), y: round(moved.y / dragged.delta.y, 3) },
        errorPx: rp(sub(moved, dragged.delta)),
        fileChanged: changed,
        label: /label \[[^\]]+\]/.exec(await fileNow(ctx))?.[0] ?? null,
      });
      return pointerOutcome(
        changed && len(moved) > 1,
        sub(moved, dragged.delta),
        ctx.tol,
        measured,
        "the name did not move or the file did not change",
      );
    },
    cell: (m) => `${num((m.ratio as Point | undefined)?.x, 2)}/${num((m.ratio as Point | undefined)?.y, 2)}`,
  },

  "map-resize": {
    notations: ["wardley"],
    did: "press the plot's corner handle, drag it (-40, -30) flow units, look at the size badge, release",
    expected:
      "the corner travels what the pointer travels (the size is rounded to tens of units), the badge (the renderer's own box, position: absolute in its container) sits 16 CSS px right of and below the pointer, and the file gains the map size",
    async run(ctx) {
      const measured: Measured = {};
      const selector = ".wardley-map-resize-xy .wardley-map-resize-hit";
      const handle = await first(ctx, selector);
      if (!handle) throw new Unmeasured("no corner handle is drawn");
      const at = aimAt(await ctx.node.map(), centre(handle));
      const hit = await ctx.node.hit(at);
      if (!isClass("wardley-map-resize")(hit)) throw new Unmeasured(`the corner handle is covered by ${hit.what}`);
      const dragged = await ctx.node.drag(at, { x: -40 * ctx.zoom, y: -30 * ctx.zoom }, { keepDown: true });
      const badge = await settled(ctx, ".wardley-map-resize-badge", 1000);
      await ctx.shot("held", badge ? [badge] : []);
      const badgeText = (await seen(ctx, ".wardley-map-resize-badge"))[0]?.text ?? null;
      await ctx.board.release();
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      const after = await first(ctx, selector);
      const moved = after ? sub(origin(after), origin(handle)) : { x: 0, y: 0 };
      const badgeOffset = badge ? sub(origin(badge), dragged.to) : null;
      Object.assign(measured, {
        handlePx: round(handle.width, 1),
        pointer: rp(dragged.delta),
        moved: rp(moved),
        ratio: { x: round(moved.x / dragged.delta.x, 3), y: round(moved.y / dragged.delta.y, 3) },
        errorPx: rp(sub(moved, dragged.delta)),
        badge: badgeText,
        badgeFromPointer: badgeOffset ? rp(badgeOffset) : null,
        badgeExpected: round(16 * ctx.chromePx, 1),
        fileChanged: changed,
        size: /size \[[^\]]+\]/.exec(await fileNow(ctx))?.[0] ?? null,
      });
      // the renderer rounds a map size to whole tens of units: half a step more may be missing
      const outcome = pointerOutcome(
        changed && len(moved) > 1,
        sub(moved, dragged.delta),
        ctx.tol + 5 * ctx.unitPx,
        measured,
        "the corner did not move or the file did not change",
      );
      if (outcome.verdict !== "ok") return outcome;
      const badgeOff = badgeOffset
        ? Math.max(Math.abs(badgeOffset.x - 16 * ctx.chromePx), Math.abs(badgeOffset.y - 16 * ctx.chromePx))
        : Number.POSITIVE_INFINITY;
      if (badgeOff > ANCHOR_PX) {
        return {
          verdict: "degraded",
          why: badgeOffset ? `the size badge is ${pt(badgeOffset)} px from the pointer` : "no size badge showed",
          measured,
        };
      }
      return outcome;
    },
    cell: (m) =>
      `${num((m.ratio as Point | undefined)?.x, 2)}/${num((m.ratio as Point | undefined)?.y, 2)}, badge ${xy(m.badgeFromPointer)}`,
  },

  resize: {
    notations: ["value-chain", "team-topology"],
    did: "click a shape, press its lower right resize handle, drag (30, 20) flow units, release",
    expected: "the shape grows by what the pointer travels (within one diagram unit) and the file carries the new size",
    async run(ctx) {
      const measured: Measured = {};
      const target = await selectByClick(ctx, ctx.spec.movers);
      const handle = await settled(ctx, ".djs-resizer-se .djs-resizer-hit", 1500);
      measured.element = target.id;
      if (!handle) return { verdict: "broken", why: "the selected shape shows no resize handle", measured };
      const at = aimAt(await ctx.node.map(), centre(handle));
      const hit = await ctx.node.hit(at);
      if (!isClass("djs-resizer")(hit)) {
        return {
          verdict: "broken",
          why: `the resize handle is drawn at ${pt(at)} but the press goes to ${hit.reachable ? hit.what : "something outside the editor"}`,
          measured,
        };
      }
      const dragged = await ctx.node.drag(at, { x: 30 * ctx.zoom, y: 20 * ctx.zoom }, { hold: ctx.spec.hold });
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      const after = await shapeBox(ctx, target.id);
      const grown = after ? { x: after.width - target.box.width, y: after.height - target.box.height } : { x: 0, y: 0 };
      Object.assign(measured, {
        handlePx: round(handle.width, 1),
        pointer: rp(dragged.delta),
        grown: rp(grown),
        ratio: { x: round(grown.x / dragged.delta.x, 3), y: round(grown.y / dragged.delta.y, 3) },
        errorPx: rp(sub(grown, dragged.delta)),
        fileChanged: changed,
      });
      return pointerOutcome(
        changed && len(grown) > 1,
        sub(grown, dragged.delta),
        ctx.tol,
        measured,
        "the shape did not grow or the file did not change",
      );
    },
    cell: (m) =>
      m.ratio
        ? `${num((m.ratio as Point).x, 2)}/${num((m.ratio as Point).y, 2)}, handle ${num(m.handlePx, 0)} px`
        : "none",
  },

  // ── palette ──
  "palette-layout": {
    notations: ALL,
    did: "look at the armed editor's palette; where entries are cut off, turn the wheel sideways over it",
    expected:
      "the whole palette inside the node, every entry takes a press where it is drawn and is 24 px or more on screen; a palette wider than the node scrolls, and the wheel over it does not move the board",
    async run(ctx) {
      const palette = await first(ctx, ".djs-palette");
      const measured: Measured = {};
      if (!palette) return { verdict: "broken", why: "no palette", measured };
      const entries = await seen(ctx, ".djs-palette .entry");
      const boxes = entries.map((one) => one.box);
      const reach = await reachable(ctx, boxes, isPalette);
      const rows = new Set(boxes.map((box) => Math.round(box.y))).size;
      const entryPx = Math.min(...boxes.map((box) => Math.min(box.width, box.height)));
      const scroll = await ctx.node.inDocument((host) => {
        const scrollers = [...host.querySelectorAll<HTMLElement>(".djs-palette, .djs-palette-entries")];
        const widest = scrollers.reduce((best, one) =>
          one.scrollWidth - one.clientWidth > best.scrollWidth - best.clientWidth ? one : best,
        );
        return {
          hidden: widest.scrollWidth - widest.clientWidth,
          narrow: !!host.querySelector(".djs-palette.two-column, .djs-palette-two-column"),
        };
      });
      Object.assign(measured, {
        host: rb(ctx.host),
        palette: rb(palette),
        paletteShare: round((palette.width * palette.height) / (ctx.host.width * ctx.host.height), 3),
        insideHost: visibleShare(union(...boxes), ctx.host),
        entries: entries.length,
        reachable: reach,
        rows,
        narrowLayout: scroll.narrow,
        entryPx: round(entryPx, 1),
        hiddenCssPx: scroll.hidden,
      });
      await ctx.shot("palette");
      if (reach < entries.length && scroll.hidden > 0) {
        // a person turns the wheel (or two fingers) sideways over the palette
        const viewport = await ctx.board.viewport();
        await ctx.board.wheel(aimAt(await ctx.node.map(), centre(boxes[0]!)), 0, { deltaX: 600 });
        await rest(ctx, 300);
        const scrolled = (await seen(ctx, ".djs-palette .entry")).map((one) => one.box);
        const last = scrolled[scrolled.length - 1]!;
        const now = await ctx.board.viewport();
        Object.assign(measured, {
          lastEntryAfterWheel: isPalette(await ctx.node.hit(centre(last))),
          scrolledPx: round(boxes[0]!.x - scrolled[0]!.x, 1),
          boardMovedByWheel: now.x !== viewport.x || now.y !== viewport.y || now.zoom !== viewport.zoom,
        });
        await ctx.shot("scrolled");
      }
      if (reach === 0) return { verdict: "broken", why: "no palette entry takes a press where it is drawn", measured };
      if (measured.boardMovedByWheel) {
        return { verdict: "broken", why: "the wheel over the palette moved the board", measured };
      }
      if (reach < entries.length) {
        return {
          verdict: "degraded",
          why: `${entries.length - reach} of ${entries.length} entries are cut off${measured.lastEntryAfterWheel ? " until the palette is scrolled" : measured.lastEntryAfterWheel === false ? " and scrolling does not bring the last one in" : ""}`,
          measured,
        };
      }
      if (entryPx < TARGET_PX)
        return { verdict: "degraded", why: `entries of ${round(entryPx, 0)} px on screen`, measured };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) =>
      m.palette
        ? `${String(m.reachable)}/${String(m.entries)}, ${num(m.entryPx, 0)} px, ${String(m.rows)} row(s), ${num((m.paletteShare as number) * 100, 0)} % of node`
        : "none",
  },

  "palette-tooltip": {
    notations: ALL,
    did: "rest the pointer on a palette entry for more than 300 ms",
    expected:
      "the renderer's tooltip (position: absolute in its container) centred under that entry, 8 CSS px below the palette, whole inside what the person sees",
    async run(ctx) {
      const measured: Measured = { entry: ctx.spec.tooltipEntry };
      const entry = await first(ctx, `.djs-palette .entry[data-action="${ctx.spec.tooltipEntry}"]`);
      const palette = await first(ctx, ".djs-palette");
      if (!entry || !palette) throw new Unmeasured("no such palette entry");
      const at = aimAt(await ctx.node.map(), centre(entry));
      if (!isPalette(await ctx.node.hit(at))) {
        throw new Unmeasured(`the palette entry ${ctx.spec.tooltipEntry} is cut off at this size`);
      }
      await ctx.board.move({ x: at.x, y: at.y + palette.height * 1.5 });
      await ctx.board.move(at, 6);
      const tooltip = await settled(ctx, ".djs-hover-tooltip", 2500);
      if (!tooltip) return { verdict: "broken", why: "no tooltip showed", measured };
      await ctx.shot("tooltip", [tooltip]);
      const [info] = await seen(ctx, ".djs-hover-tooltip");
      const dx = centre(tooltip).x - centre(entry).x;
      const gap = tooltip.y - (palette.y + palette.height);
      Object.assign(measured, {
        text: info?.text ?? "",
        tooltip: rb(tooltip),
        fromEntryMiddlePx: round(dx, 1),
        belowPalettePx: round(gap, 1),
        expectedBelowPx: round(8 * ctx.chromePx, 1),
        textPx: round((info?.fontCss ?? 0) * ctx.chromePx, 1),
        visibleShare: visibleShare(tooltip, ctx.clip),
        insideHost: visibleShare(tooltip, ctx.host),
      });
      const off = Math.max(Math.abs(dx), Math.abs(gap - 8 * ctx.chromePx));
      if (off > ANCHOR_PX) {
        return {
          verdict: "degraded",
          why: `the tooltip is ${round(dx, 0)} px beside its entry and ${round(gap, 0)} px below the palette`,
          measured,
        };
      }
      if (visibleShare(tooltip, ctx.clip) < 0.999)
        return { verdict: "degraded", why: "the tooltip is cut off", measured };
      if (Math.round((info?.fontCss ?? 0) * ctx.chromePx) < TEXT_PX) {
        return {
          verdict: "degraded",
          why: `tooltip text of ${round((info?.fontCss ?? 0) * ctx.chromePx, 1)} px on screen`,
          measured,
        };
      }
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) =>
      m.tooltip ? `off ${num(m.fromEntryMiddlePx, 0)}/${num(m.belowPalettePx, 0)}, text ${num(m.textPx)} px` : "none",
  },

  // ── canvas ──
  "canvas-pan": {
    notations: ALL,
    did: "press the bare canvas, drag (-40, -30) flow units, release (Wardley: after two Control + wheel steps in, its pan constraint holds a fitted map in place)",
    expected: "the diagram travels what the pointer travels; the file and the board's viewport stay as they are",
    async run(ctx) {
      const measured: Measured = {};
      const viewport = await ctx.board.viewport();
      if (ctx.notation === "wardley") await zoomIn(ctx, centre(ctx.host), 2);
      const travel = { x: -40 * ctx.zoom, y: -30 * ctx.zoom };
      const at = await barePoint(ctx, travel);
      const ref = ctx.spec.movers[0]!;
      const before = await shapeBox(ctx, ref);
      if (!before) throw new Unmeasured(`${ref} is not drawn`);
      const dragged = await ctx.node.drag(at, travel);
      await rest(ctx, 500);
      const after = await shapeBox(ctx, ref);
      const moved = after ? sub(origin(after), origin(before)) : { x: 0, y: 0 };
      const now = await ctx.board.viewport();
      Object.assign(measured, {
        pointer: rp(dragged.delta),
        moved: rp(moved),
        ratio: { x: round(moved.x / dragged.delta.x, 3), y: round(moved.y / dragged.delta.y, 3) },
        errorPx: rp(sub(moved, dragged.delta)),
        fileSame: (await fileNow(ctx)) === ctx.file0,
        boardViewportSame: now.x === viewport.x && now.y === viewport.y && now.zoom === viewport.zoom,
      });
      if (!measured.boardViewportSame)
        return { verdict: "broken", why: "the board moved instead of the diagram", measured };
      if (!measured.fileSame) return { verdict: "wrong-data", why: "a pan changed the file", measured };
      return pointerOutcome(
        len(moved) > 1,
        sub(moved, dragged.delta),
        Math.max(2, ctx.tol),
        measured,
        "the diagram did not move",
      );
    },
    cell: (m) => `${num((m.ratio as Point | undefined)?.x, 2)}/${num((m.ratio as Point | undefined)?.y, 2)}`,
  },

  "wheel-zoom": {
    notations: ALL,
    did: "Control + wheel in over a shape, three steps; then a fourth step over the shape's middle of that moment",
    expected:
      "the diagram zooms (not the board) and the point under the pointer stays under it: the shape's middle is where it was after the fourth step (the first steps may shift a fitted Wardley map, its pan constraint)",
    async run(ctx) {
      const measured: Measured = {};
      const viewport = await ctx.board.viewport();
      const target = await grab(ctx, ctx.spec.movers);
      const scale0 = (await ctx.node.diagramScale()) ?? 0;
      await ctx.board.wheel(target.at, -120, { hold: ["Control"] });
      await rest(ctx, 250);
      const one = await shapeBox(ctx, target.id);
      const scale1 = (await ctx.node.diagramScale()) ?? 0;
      await zoomIn(ctx, target.at, 2);
      const mid = await shapeBox(ctx, target.id);
      const scale3 = (await ctx.node.diagramScale()) ?? 0;
      Object.assign(measured, {
        element: target.id,
        firstStepFactor: round(scale1 / scale0, 3),
        firstStepErrorPx: one ? rp(sub(centre(one), target.at)) : null,
      });
      if (!mid || !inside(centre(mid), ctx.host)) {
        measured.afterThreeSteps = mid ? rp(sub(centre(mid), target.at)) : null;
        if (Math.abs(scale1 / scale0 - 1) < 0.01)
          return { verdict: "broken", why: "Control + wheel did not zoom the diagram", measured };
        return {
          verdict: "degraded",
          why: "after three steps the shape under the pointer has left the node",
          measured,
        };
      }
      const pivot = aimAt(await ctx.node.map(), centre(mid));
      await ctx.board.wheel(pivot, -120, { hold: ["Control"] });
      await rest(ctx, 250);
      const end = await shapeBox(ctx, target.id);
      const scale4 = (await ctx.node.diagramScale()) ?? 0;
      const error = end ? sub(centre(end), pivot) : { x: 0, y: 0 };
      const now = await ctx.board.viewport();
      Object.assign(measured, {
        afterThreeSteps: rp(sub(centre(mid), target.at)),
        fourthStepFactor: round(scale4 / scale3, 3),
        pivotErrorPx: rp(error),
        fileSame: (await fileNow(ctx)) === ctx.file0,
        boardViewportSame: now.x === viewport.x && now.y === viewport.y && now.zoom === viewport.zoom,
      });
      if (!measured.boardViewportSame)
        return { verdict: "broken", why: "the board zoomed instead of the diagram", measured };
      if (Math.abs(scale4 / scale3 - 1) < 0.01)
        return { verdict: "broken", why: "Control + wheel did not zoom the diagram", measured };
      return pointerOutcome(true, error, Math.max(2, ctx.tol), measured, "");
    },
    cell: (m) =>
      m.pivotErrorPx
        ? `x${num(m.fourthStepFactor, 2)}, pivot off ${xy(m.pivotErrorPx)} (first step ${xy(m.firstStepErrorPx)})`
        : `first step x${num(m.firstStepFactor, 2)} off ${xy(m.firstStepErrorPx)}`,
  },

  "wheel-scroll": {
    notations: ALL,
    did: "turn the wheel one notch down over the bare canvas, no key held (Wardley: after two Control + wheel steps in)",
    expected: "the diagram scrolls and the board stays where it is (the armed editor owns the wheel)",
    async run(ctx) {
      const measured: Measured = {};
      const viewport = await ctx.board.viewport();
      if (ctx.notation === "wardley") await zoomIn(ctx, centre(ctx.host), 2);
      const at = await barePoint(ctx);
      const ref = ctx.spec.movers[0]!;
      const before = await shapeBox(ctx, ref);
      if (!before) throw new Unmeasured(`${ref} is not drawn`);
      await ctx.board.wheel(at, 120);
      await rest(ctx, 400);
      const after = await shapeBox(ctx, ref);
      const moved = after ? sub(origin(after), origin(before)) : { x: 0, y: 0 };
      const now = await ctx.board.viewport();
      Object.assign(measured, {
        movedPx: rp(moved),
        movedUnits: rp({ x: moved.x / ctx.unitPx, y: moved.y / ctx.unitPx }, 0),
        fileSame: (await fileNow(ctx)) === ctx.file0,
        boardViewportSame: now.x === viewport.x && now.y === viewport.y && now.zoom === viewport.zoom,
      });
      if (!measured.boardViewportSame)
        return { verdict: "broken", why: "the wheel moved the board instead of the diagram", measured };
      if (len(moved) <= 1) return { verdict: "broken", why: "the wheel did not scroll the diagram", measured };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) => `diagram ${xy(m.movedPx)} px${m.boardViewportSame ? "" : ", board moved"}`,
  },

  // ── keys while armed ──
  "keys-delete": {
    notations: ALL,
    did: "click a shape, press Delete",
    expected:
      "the editor deletes that shape from its file; the board keeps its node, stays armed and its own file stays byte-identical (React Flow's delete key is Backspace and Delete too)",
    async run(ctx) {
      const measured: Measured = {};
      const nodes = (await ctx.board.nodes()).length;
      const where = await watchKeys(ctx);
      const target = await selectByClick(ctx, ctx.spec.movers);
      await ctx.board.press("Delete");
      const file = (await fileChange(ctx, ctx.file0)) ?? ctx.file0;
      await rest(ctx, 500);
      Object.assign(measured, {
        element: target.id,
        gone: !ctx.spec.has(file, target.id),
        boardNodes: `${(await ctx.board.nodes()).length} of ${nodes}`,
        boardSame: (await ctx.board.boardText()) === ctx.board0,
        armed: (await ctx.node.state()).armed,
        ...(await where()),
      });
      if (!measured.boardSame || (await ctx.board.nodes()).length !== nodes) {
        return { verdict: "wrong-data", why: "the board acted on the key too", measured };
      }
      if (!measured.gone) return { verdict: "broken", why: "the shape is still in the file", measured };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) => `${m.gone ? "deleted" : "not deleted"}, board ${m.boardSame ? "same" : "CHANGED"}`,
  },

  "keys-undo-redo": {
    notations: ALL,
    did: "drag a shape, press Control + Z, then Control + Shift + Z",
    expected:
      "undo puts the file back byte for byte and the shape back in place, redo writes the moved state again; the board file stays the same",
    async run(ctx) {
      const measured: Measured = {};
      const target = await grab(ctx, ctx.spec.movers);
      await ctx.node.drag(target.at, { x: TRAVEL.x * ctx.zoom, y: TRAVEL.y * ctx.zoom }, { hold: ctx.spec.hold });
      const moved = await fileChange(ctx, ctx.file0);
      if (moved === null)
        return { verdict: "unmeasured", why: "the drag did not change the file: nothing to undo", measured };
      await rest(ctx, 450);
      await ctx.board.press("Control+z");
      const undone = await ctx.board.waitFor(async () => (await fileNow(ctx)) === ctx.file0, 2500);
      const back = await shapeBox(ctx, target.id);
      await ctx.board.press("Control+Shift+z");
      const redone = await ctx.board.waitFor(async () => (await fileNow(ctx)) === moved, 2500);
      Object.assign(measured, {
        element: target.id,
        undoneByteIdentical: undone === true,
        backInPlacePx: back ? round(len(sub(origin(back), origin(target.box))), 2) : null,
        redoneByteIdentical: redone === true,
        boardSame: (await ctx.board.boardText()) === ctx.board0,
      });
      if (!measured.boardSame) return { verdict: "wrong-data", why: "the board acted on the keys too", measured };
      if (!undone) return { verdict: "broken", why: "Control + Z did not put the file back", measured };
      if (!redone) return { verdict: "broken", why: "Control + Shift + Z did not write the move again", measured };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) => `undo ${m.undoneByteIdentical ? "yes" : "no"}, redo ${m.redoneByteIdentical ? "yes" : "no"}`,
  },

  "keys-select-all": {
    notations: ALL,
    did: "with the focus on the armed canvas press Control + A, then Escape",
    expected:
      "the editor selects every element it draws; the page's own select-all does not run (no text of the page is selected) and Escape leaves the node armed",
    async run(ctx) {
      const measured: Measured = {};
      const drawn = (await ctx.node.elementIds()).length;
      const where = await watchKeys(ctx);
      await ctx.board.press("Control+a");
      await rest(ctx, 300);
      const selected = (await ctx.node.selected()).length;
      const pageSelection = await ctx.board.page.evaluate(() => (window.getSelection()?.toString() ?? "").length);
      await ctx.board.press("Escape");
      await rest(ctx, 300);
      Object.assign(measured, {
        drawn,
        selected,
        pageTextSelected: pageSelection,
        afterEscape: (await ctx.node.selected()).length,
        armed: (await ctx.node.state()).armed,
        ...(await where()),
      });
      if (!measured.armed) return { verdict: "broken", why: "Escape disarmed the node", measured };
      if (selected === 0) return { verdict: "broken", why: "Control + A selected nothing in the editor", measured };
      if (pageSelection > 0) return { verdict: "degraded", why: "the page selected its own text too", measured };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) => `${String(m.selected)}/${String(m.drawn)} selected, Escape leaves ${String(m.afterEscape)}`,
  },

  "keys-arrows": {
    notations: ALL,
    did: "click a shape, press ArrowRight three times",
    expected:
      "the editor nudges the shape and writes its file; the board does not move its node (React Flow moves a selected node with the arrow keys) and its file stays byte-identical",
    async run(ctx) {
      const measured: Measured = {};
      const nodeBefore = await ctx.board.nodeBox(ctx.node.id);
      const where = await watchKeys(ctx);
      const target = await selectByClick(ctx, ctx.spec.movers);
      for (let press = 0; press < 3; press++) {
        await ctx.board.press("ArrowRight");
        await rest(ctx, 60);
      }
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      // the board writes an arrow-key move of its node about 400 ms after the last key
      await rest(ctx, 800);
      const after = await shapeBox(ctx, target.id);
      const nodeAfter = await ctx.board.nodeBox(ctx.node.id);
      const moved = after ? sub(origin(after), origin(target.box)) : { x: 0, y: 0 };
      const nodeMoved = nodeBefore && nodeAfter ? len(sub(origin(nodeAfter), origin(nodeBefore))) : 0;
      Object.assign(measured, {
        element: target.id,
        movedPx: rp(moved),
        movedUnits: round(moved.x / ctx.unitPx, 1),
        fileChanged: changed,
        boardNodeMovedPx: round(nodeMoved, 1),
        boardSame: (await ctx.board.boardText()) === ctx.board0,
        ...(await where()),
      });
      if (!measured.boardSame || nodeMoved > 0.5)
        return { verdict: "wrong-data", why: "the board moved its node on the same keys", measured };
      if (!changed || Math.abs(moved.x) < 0.5)
        return { verdict: "broken", why: "the arrow keys did not move the shape", measured };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) => `shape ${num(m.movedUnits, 0)} units, board node ${num(m.boardNodeMovedPx, 0)} px`,
  },

  "keys-zoom": {
    notations: ALL,
    did: "press Control + = (zoom in), then Shift + 1 (fit), with the focus on the armed canvas",
    expected:
      "whatever the mount binds: the product's own mount (the one a frame runs) binds both for every renderer, the spike's in-page mount leaves the product's chrome keys out (Value Chain's diagram-js binds the zoom key itself). In no case does the board's viewport change. Not counted against a strategy",
    async run(ctx) {
      const measured: Measured = {};
      const viewport = await ctx.board.viewport();
      const scale0 = (await ctx.node.diagramScale()) ?? 0;
      const where = await watchKeys(ctx);
      await ctx.board.press("Control+=");
      await rest(ctx, 400);
      const scale1 = (await ctx.node.diagramScale()) ?? 0;
      await ctx.board.press("Shift+1");
      await rest(ctx, 600);
      const scale2 = (await ctx.node.diagramScale()) ?? 0;
      const now = await ctx.board.viewport();
      Object.assign(measured, {
        zoomKeyFactor: round(scale1 / scale0, 3),
        fitKeyFactor: round(scale2 / scale1, 3),
        zoomKeyBound: Math.abs(scale1 / scale0 - 1) > 0.01,
        fitKeyBound: Math.abs(scale2 / scale1 - 1) > 0.01,
        boardViewportSame: now.x === viewport.x && now.y === viewport.y && now.zoom === viewport.zoom,
        fileSame: (await fileNow(ctx)) === ctx.file0,
        ...(await where()),
      });
      if (!measured.boardViewportSame)
        return { verdict: "broken", why: "the keys changed the board's viewport", measured };
      if (!measured.fileSame) return { verdict: "wrong-data", why: "a view key changed the file", measured };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) =>
      `zoom key ${m.zoomKeyBound ? `x${num(m.zoomKeyFactor, 2)}` : "unbound"}, fit key ${m.fitKeyBound ? `x${num(m.fitKeyFactor, 2)}` : "unbound"}`,
  },

  // ── further tools and boxes (nice to have) ──
  "lasso-select": {
    notations: ALL,
    did: "click the palette's Lasso tool, drag a rectangle around one or two shapes (a group whose rectangle keeps 24 CSS px and more from the node's edge: nearer, diagram-js scrolls the canvas under a drag)",
    expected:
      "the editor selects exactly the shapes the rectangle on screen encloses (the engine's rectangle is the pointer's) and the canvas stays where it is",
    async run(ctx) {
      const measured: Measured = {};
      const map = await ctx.node.map();
      const pad = Math.max(6, 8 * ctx.unitPx);
      // diagram-js scrolls the canvas while a drag is within 20 px of its edge, counted in the client px
      // the editor is told (AutoScroll.js compares the event's client point with the container's client
      // rectangle). A host that is scaled without its editor being told so has that band in screen px
      const edge = 24 * ctx.toldPx;
      const calm = {
        x: ctx.host.x + edge,
        y: ctx.host.y + edge,
        width: ctx.host.width - 2 * edge,
        height: ctx.host.height - 2 * edge,
      };
      let from: Point | undefined;
      let to: Point | undefined;
      const passed: string[] = [];
      for (const group of ctx.spec.lasso) {
        const boxes: Box[] = [];
        for (const id of group) {
          const box = await shapeBox(ctx, id);
          if (box) boxes.push(box);
        }
        if (boxes.length !== group.length) continue;
        const around = union(...boxes);
        const corners = [
          aimAt(map, { x: around.x - pad, y: around.y - pad }),
          aimAt(map, { x: around.x + around.width + pad, y: around.y + around.height + pad }),
        ] as const;
        let free = corners.every((corner) => inside(corner, calm));
        let why = "within 24 CSS px of the node's edge";
        for (const corner of corners) {
          const hit = await ctx.node.hit(corner);
          if (!hit.reachable || hit.palette || hit.pad) {
            free = false;
            why = `a corner is covered by ${hit.what}`;
          }
        }
        if (free) {
          [from, to] = corners;
          measured.around = group;
          break;
        }
        passed.push(`${group.join(" + ")}: ${why}`);
      }
      if (passed.length > 0) measured.passedOver = passed;
      if (!from || !to) throw new Unmeasured(`no group of shapes leaves room for a lasso (${passed.join("; ")})`);
      const view = await ctx.node.viewportMatrix();
      // what the rectangle encloses on screen, before anything moves
      const frame = { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y };
      const enclosed: string[] = [];
      for (const id of await ctx.node.elementIds()) {
        const box = (await ctx.node.query(`[data-element-id="${id}"] > rect.djs-hit`))[0];
        if (!box) continue;
        if (inside(origin(box), frame) && inside({ x: box.x + box.width, y: box.y + box.height }, frame))
          enclosed.push(id);
      }
      const tool = await first(ctx, '.djs-palette .entry[data-action="lasso-tool"]');
      const click = await clickChrome(ctx, tool, isPalette, "palette entry lasso-tool");
      if (!click.clicked) return { verdict: "broken", why: click.reason, measured };
      await rest(ctx, 150);
      await ctx.board.drag(from, to, { steps: 14, keepDown: true });
      await ctx.shot("lasso");
      await ctx.board.release();
      await rest(ctx, 300);
      const shapes: string[] = [];
      for (const id of await ctx.node.selected()) {
        if ((await ctx.node.query(`[data-element-id="${id}"] > rect.djs-hit`)).length > 0) shapes.push(id);
      }
      const missing = enclosed.filter((id) => !shapes.includes(id));
      const extra = shapes.filter((id) => !enclosed.includes(id));
      const viewAfter = await ctx.node.viewportMatrix();
      Object.assign(measured, {
        canvasScrolledPx:
          view && viewAfter ? round(Math.hypot(viewAfter.e - view.e, viewAfter.f - view.f) * ctx.chromePx, 1) : null,
        rectangle: rb(frame),
        enclosedOnScreen: enclosed.sort(),
        selected: shapes.sort(),
        missing,
        extra,
        fileSame: (await fileNow(ctx)) === ctx.file0,
      });
      if (!measured.fileSame) return { verdict: "wrong-data", why: "the lasso changed the file", measured };
      if (shapes.length === 0) return { verdict: "broken", why: "the lasso selected nothing", measured };
      if (missing.length > 0 || extra.length > 0) {
        return {
          verdict: "degraded",
          why: `the lasso selected other shapes than its rectangle encloses (missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"})`,
          measured,
        };
      }
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) =>
      m.selected
        ? `${(m.selected as string[]).length} selected, ${(m.enclosedOnScreen as string[]).length} enclosed`
        : "none",
  },

  "popup-align": {
    notations: ["value-chain"],
    did: "click one step, Shift + click a second, click the pad's Align entry, look at the menu, click Align left",
    expected:
      "diagram-js's popup menu opens at the click, whole inside what the person sees, every entry takes a press, and the file puts both steps at the same x",
    async run(ctx) {
      const [a, b] = ctx.spec.pair;
      const one = await grab(ctx, [a]);
      await ctx.board.click(one.at);
      await settled(ctx, ".djs-context-pad.open", 1000);
      const two = await grab(ctx, [b]);
      await ctx.board.page.keyboard.down("Shift");
      await ctx.board.click(two.at);
      await ctx.board.page.keyboard.up("Shift");
      await rest(ctx, 300);
      const entry = await padEntry(ctx, "align");
      const click = await clickChrome(ctx, entry, isPad, "pad entry align of the selection");
      if (!click.clicked) return { verdict: "broken", why: click.reason, measured: { elements: [a, b] } };
      return popupBody(ctx, { elements: [a, b] }, click.at, a, {
        popup: ".djs-popup",
        entries: ".djs-popup .entry",
        choose: '.djs-popup .entry[data-id="align-left"]',
        isEntry: isPopup,
        applied: (file) => {
          const steps = valueChain(file).elements;
          const [first, second] = [steps.find((step) => step.id === a), steps.find((step) => step.id === b)];
          return !!first && !!second && first.bounds.x === second.bounds.x;
        },
      });
    },
    cell: popupCell,
  },

  "link-editor": {
    notations: ["wardley"],
    did: "click a component, click the pad's link entry, look at the input box, type an address, Enter",
    expected:
      "the renderer's input box (position: absolute, placed from diagram coordinates) at the component's left edge, 72 CSS px below its top, whole inside the node, and the address in the file",
    async run(ctx) {
      const measured: Measured = {};
      const pad = await viaPad(ctx, ["cmp_cup", "cmp_tea", "cmp_water", "cmp_kettle"], "link", measured);
      if (pad.outcome) return pad.outcome;
      const box = await settled(ctx, "input.wardley-link-input", 1500);
      if (!box) return { verdict: "broken", why: "no input box opened", measured };
      await ctx.shot("input", [box]);
      const [info] = await seen(ctx, "input.wardley-link-input");
      const focus = await focusOf(ctx);
      Object.assign(measured, {
        input: rb(box),
        belowTopPx: round(box.y - pad.target.box.y, 1),
        expectedBelowPx: round(72 * ctx.chromePx, 1),
        fromLeftEdgePx: round(box.x - pad.target.box.x, 1),
        textPx: round((info?.fontCss ?? 0) * ctx.chromePx, 1),
        focusInInput: focus.what.includes("wardley-link-input"),
        insideHost: visibleShare(box, ctx.host),
      });
      await ctx.board.type("https://example.org/tea");
      await ctx.board.press("Enter");
      const file = (await fileChange(ctx, ctx.file0)) ?? ctx.file0;
      const written = file.includes("https://example.org/tea");
      measured.inFile = written;
      if (!written) return { verdict: "broken", why: "the address did not reach the file", measured };
      const off = Math.abs(box.y - pad.target.box.y - 72 * ctx.chromePx);
      if (off > ANCHOR_PX + 2 * ctx.unitPx) {
        return afterPad(measured, {
          verdict: "degraded",
          why: `the input box is ${round(box.y - pad.target.box.y, 0)} px below its component's top (${round(72 * ctx.chromePx, 0)} expected)`,
          measured,
        });
      }
      if (visibleShare(box, ctx.host) < 0.999) {
        return afterPad(measured, {
          verdict: "degraded",
          why: "the input box is cut off by the node's edge",
          measured,
        });
      }
      if (Math.round((info?.fontCss ?? 0) * ctx.chromePx) < TEXT_PX) {
        return afterPad(measured, {
          verdict: "degraded",
          why: `input text of ${round((info?.fontCss ?? 0) * ctx.chromePx, 1)} px on screen`,
          measured,
        });
      }
      return afterPad(measured, { verdict: "ok", why: "", measured });
    },
    cell: (m) =>
      m.input
        ? `${num(m.belowTopPx, 0)} px below top (${num(m.expectedBelowPx, 0)}), text ${num(m.textPx)} px, ${m.inFile ? "in file" : "not in file"}`
        : "none",
  },

  "explore-start": {
    notations: ["wardley"],
    did: "click the palette's Explore mode entry, click Start from… in the toolbar it turns into, look at the menu, click Kettle, then press E",
    expected:
      "diagram-js's popup menu opens under the Start from… entry (its left edge, 4 CSS px below), every entry takes a press, explore mode shows Kettle alone, E ends it, and the file never changes",
    async run(ctx) {
      const measured: Measured = {};
      const drawn = (await ctx.node.elementIds()).length;
      const tool = await first(ctx, '.djs-palette .entry[data-action="explore"]');
      const click = await clickChrome(ctx, tool, isPalette, "palette entry explore");
      if (!click.clicked) return { verdict: "broken", why: click.reason, measured };
      const start = await settled(ctx, '.djs-palette .entry[data-action="explore.start-from"]', 1500);
      const second = await clickChrome(ctx, start, isPalette, "palette entry explore.start-from");
      if (!second.clicked) return { verdict: "broken", why: second.reason, measured };
      const popup = await settled(ctx, ".djs-popup", 2000);
      if (!popup || !start) return { verdict: "broken", why: "no menu opened", measured };
      await ctx.shot("menu", [popup]);
      // the list of components scrolls inside the menu: the entries it shows are the ones to reach
      const listed = await seen(ctx, ".djs-popup .entry");
      const entries = listed.filter((one) => inside(centre(one.box), popup));
      const boxes = entries.map((one) => one.box);
      const reach = await reachable(ctx, boxes, isPopup);
      const anchor = { x: start.x, y: start.y + start.height + 4 * ctx.chromePx };
      const off = fromAnchor(anchor, popup, ctx.host, 4 * ctx.chromePx);
      const entryPx = Math.min(...boxes.map((box) => Math.min(box.width, box.height)));
      Object.assign(measured, {
        entry: rb(start),
        popup: rb(popup),
        fromClickPx: round(off, 1),
        listed: listed.length,
        entries: entries.length,
        reachable: reach,
        entryPx: round(entryPx, 1),
        visibleShare: visibleShare(popup, ctx.clip),
        shownShare: await shownShare(ctx, popup, ".djs-popup"),
        insideHost: visibleShare(popup, ctx.host),
      });
      const kettle = entries.find((one) => one.text.startsWith("Kettle"));
      const choose = await clickChrome(ctx, kettle?.box, isPopup, "the menu entry Kettle");
      if (!choose.clicked) return { verdict: "broken", why: choose.reason, measured };
      await rest(ctx, 500);
      const hint = (await seen(ctx, ".wardley-explore-hint"))[0]?.text ?? "";
      const hidden = await ctx.node.inDocument(
        (host) => host.querySelectorAll(".djs-element.wardley-explore-hidden").length,
      );
      await ctx.shot("exploring");
      await ctx.board.press("e");
      await rest(ctx, 400);
      const hiddenAfter = await ctx.node.inDocument(
        (host) => host.querySelectorAll(".djs-element.wardley-explore-hidden").length,
      );
      Object.assign(measured, {
        applied: /^1 of \d+/.test(hint),
        hint,
        hiddenWhileExploring: hidden,
        drawn,
        hiddenAfterE: hiddenAfter,
        fileSame: (await fileNow(ctx)) === ctx.file0,
      });
      if (!measured.fileSame) return { verdict: "wrong-data", why: "exploring changed the file", measured };
      if (!measured.applied)
        return { verdict: "broken", why: `explore mode did not start at Kettle (hint: ${hint})`, measured };
      if (hiddenAfter > 0) return { verdict: "broken", why: "E did not end explore mode", measured };
      if (off > ANCHOR_PX)
        return {
          verdict: "degraded",
          why: `the menu opened ${round(off, 0)} px from its place under the entry`,
          measured,
        };
      if (visibleShare(popup, ctx.clip) < 0.999) {
        return {
          verdict: "degraded",
          why: `${round((1 - visibleShare(popup, ctx.clip)) * 100, 0)} % of the menu is cut off`,
          measured,
        };
      }
      if (reach < entries.length) {
        return {
          verdict: "degraded",
          why: `${entries.length - reach} of ${entries.length} entries do not take a press`,
          measured,
        };
      }
      if (entryPx < TARGET_PX)
        return { verdict: "degraded", why: `entries of ${round(entryPx, 0)} px on screen`, measured };
      if ((measured.shownShare as number) < 0.99) {
        return {
          verdict: "degraded",
          why: `${round((1 - (measured.shownShare as number)) * 100, 0)} % of the menu is not shown where it is drawn (clipped or covered)`,
          measured,
        };
      }
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) =>
      m.popup
        ? `${num(m.fromClickPx, 0)} px from its place, ${num((m.popup as Box).width, 0)}x${num((m.popup as Box).height, 0)}, ${String(m.reachable)}/${String(m.entries)}, ${m.applied ? "started" : "not started"}`
        : "none",
  },

  "hand-tool": {
    notations: ["value-chain"],
    did: "click the palette's Hand tool, press a step (the hand moves the canvas there too), drag (-40, -30) flow units",
    expected: "the diagram travels what the pointer travels and the file stays as it is",
    async run(ctx) {
      const measured: Measured = {};
      const tool = await first(ctx, '.djs-palette .entry[data-action="hand-tool"]');
      const target = await grab(ctx, ctx.spec.movers);
      const click = await clickChrome(ctx, tool, isPalette, "palette entry hand-tool");
      if (!click.clicked) return { verdict: "broken", why: click.reason, measured };
      await rest(ctx, 150);
      const dragged = await ctx.node.drag(target.at, { x: -40 * ctx.zoom, y: -30 * ctx.zoom });
      await rest(ctx, 500);
      const after = await shapeBox(ctx, target.id);
      const moved = after ? sub(origin(after), origin(target.box)) : { x: 0, y: 0 };
      Object.assign(measured, {
        pointer: rp(dragged.delta),
        moved: rp(moved),
        ratio: { x: round(moved.x / dragged.delta.x, 3), y: round(moved.y / dragged.delta.y, 3) },
        errorPx: rp(sub(moved, dragged.delta)),
        fileSame: (await fileNow(ctx)) === ctx.file0,
      });
      if (!measured.fileSame)
        return { verdict: "wrong-data", why: "the hand tool changed the file (it moved the step)", measured };
      return pointerOutcome(
        len(moved) > 1,
        sub(moved, dragged.delta),
        Math.max(2, ctx.tol),
        measured,
        "the diagram did not move",
      );
    },
    cell: (m) => `${num((m.ratio as Point | undefined)?.x, 2)}/${num((m.ratio as Point | undefined)?.y, 2)}`,
  },

  "space-tool": {
    notations: ["value-chain"],
    did: "click the palette's Space tool, press the bare canvas between Delivery and Invoicing, drag 40 flow units to the right",
    expected:
      "everything right of the press (Invoicing, Finance) travels what the pointer travels, nothing left of it moves, and the file changes",
    async run(ctx) {
      const measured: Measured = {};
      const [left, right] = [await shapeBox(ctx, "step-delivery"), await shapeBox(ctx, "step-invoice")];
      if (!left || !right) throw new Unmeasured("Delivery and Invoicing are not drawn");
      const map = await ctx.node.map();
      // between the two steps along x, on the bare canvas below everything along y
      const x = (left.x + left.width + right.x) / 2;
      let at: Point | undefined;
      for (let fy = 0.92; fy > 0.5 && !at; fy -= 0.06) {
        const candidate = aimAt(map, { x, y: ctx.host.y + ctx.host.height * fy });
        const hit = await ctx.node.hit(candidate);
        if (hit.reachable && hit.element === ctx.spec.root && hit.what.startsWith("svg")) at = candidate;
      }
      if (!at) throw new Unmeasured("no bare canvas between Delivery and Invoicing");
      const tool = await first(ctx, '.djs-palette .entry[data-action="space-tool"]');
      const click = await clickChrome(ctx, tool, isPalette, "palette entry space-tool");
      if (!click.clicked) return { verdict: "broken", why: click.reason, measured };
      await rest(ctx, 150);
      const dragged = await ctx.node.drag(at, { x: 40 * ctx.zoom, y: 0 }, { hold: ctx.spec.hold });
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      const [leftAfter, rightAfter] = [await shapeBox(ctx, "step-delivery"), await shapeBox(ctx, "step-invoice")];
      const moved = rightAfter ? sub(origin(rightAfter), origin(right)) : { x: 0, y: 0 };
      const stayed = leftAfter ? len(sub(origin(leftAfter), origin(left))) : 0;
      Object.assign(measured, {
        gapPx: round(right.x - (left.x + left.width), 1),
        pointer: rp(dragged.delta),
        movedRight: rp(moved),
        movedLeftOfPress: round(stayed, 1),
        ratio: round(moved.x / dragged.delta.x, 3),
        errorPx: rp({ x: moved.x - dragged.delta.x, y: moved.y }),
        fileChanged: changed,
      });
      if (changed && stayed > Math.max(1, ctx.unitPx)) {
        return { verdict: "degraded", why: "the space tool also moved what lies left of the press", measured };
      }
      return pointerOutcome(
        changed && Math.abs(moved.x) > 1,
        { x: moved.x - dragged.delta.x, y: moved.y },
        ctx.tol,
        measured,
        "nothing right of the press moved or the file did not change",
      );
    },
    cell: (m) => `${num(m.ratio, 2)}, left of press moved ${num(m.movedLeftOfPress, 0)} px`,
  },

  "create-key": {
    notations: ["wardley"],
    did: "rest the pointer on a free point of the plot, press C, move a little, click, Escape",
    expected:
      "the key hands a new component to the pointer (the renderer starts diagram-js's create at the last pointer position) and the click drops it with its middle there, within one diagram unit",
    async run(ctx) {
      const before = await ctx.node.elementIds();
      const measured: Measured = {};
      const to = await freeSpot(ctx);
      await ctx.board.move({ x: to.x - 24 * ctx.zoom, y: to.y - 16 * ctx.zoom }, 4);
      await ctx.board.move(to, 6);
      await ctx.board.press("c");
      await rest(ctx, 200);
      await ctx.board.move({ x: to.x + 3, y: to.y + 2 }, 2);
      await ctx.board.move(to, 2);
      await rest(ctx, 100);
      await ctx.shot("carrying");
      await ctx.board.click(to);
      const id = await newShape(ctx, before);
      await rest(ctx, 250);
      await ctx.board.press("Escape");
      const box = id ? await shapeBox(ctx, id) : undefined;
      const changed = (await fileChange(ctx, ctx.file0)) !== null;
      const error = box ? sub(centre(box), to) : { x: 0, y: 0 };
      Object.assign(measured, {
        drop: rp(to),
        created: !!id,
        middle: box ? rp(centre(box)) : null,
        errorPx: rp(error),
        fileChanged: changed,
      });
      return pointerOutcome(
        !!box && changed,
        error,
        ctx.tol,
        measured,
        id ? "the new shape is not in the file" : "no shape was created",
      );
    },
    cell: (m) => (m.created ? `off ${xy(m.errorPx)}` : "none"),
  },

  "keys-edit": {
    notations: ["value-chain"],
    did: "click a step, press E, look for the editor box, Escape",
    expected:
      "the renderer's own letter key opens the label editor of the selected step; Escape closes it and the file stays byte-identical",
    async run(ctx) {
      const measured: Measured = {};
      const where = await watchKeys(ctx);
      const target = await selectByClick(ctx, ctx.spec.label.targets);
      await ctx.board.press("e");
      const editor = await settled(ctx, ctx.spec.label.box, 1500);
      measured.element = target.id;
      measured.editorOpened = !!editor;
      if (editor) measured.overShape = inside(centre(editor), target.box, 2);
      await ctx.board.press("Escape");
      await rest(ctx, 700);
      Object.assign(measured, { fileIdentical: (await fileNow(ctx)) === ctx.file0, ...(await where()) });
      if (!measured.fileIdentical)
        return { verdict: "wrong-data", why: "the file changed although nothing was typed", measured };
      if (!editor) return { verdict: "broken", why: "E did not open the label editor", measured };
      if (!measured.overShape) return { verdict: "degraded", why: "the editor box is not over its step", measured };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) => (m.editorOpened ? `editor ${m.overShape ? "over the step" : "elsewhere"}` : "no editor"),
  },

  "pad-key-popup": {
    notations: ["wardley"],
    did: "click a component, Tab to its context pad, arrow keys to the Settings entry, Enter, look at the menu, click Market",
    expected:
      "the renderer hands the entry a click of its own making at the component's middle (built from the container's client rectangle and the diagram's zoom): diagram-js's popup menu opens with a corner there, every entry takes a press, and the file marks that component (market)",
    async run(ctx) {
      const measured: Measured = {};
      const target = await selectByClick(ctx, ["cmp_cup", "cmp_tea", "cmp_water", "cmp_kettle"]);
      measured.element = target.id;
      await settled(ctx, ".djs-context-pad.open", 1000);
      const path: string[] = [];
      let focus = await focusOf(ctx);
      for (let step = 0; step < 8 && !focus.what.includes("wardley-cp-entry"); step++) {
        await ctx.board.press("Tab");
        focus = await focusOf(ctx);
        path.push(focus.action ?? focus.what);
      }
      for (let step = 0; step < 10 && focus.what.includes("wardley-cp-entry") && focus.action !== "settings"; step++) {
        await ctx.board.press("ArrowDown");
        focus = await focusOf(ctx);
        path.push(focus.action ?? focus.what);
      }
      measured.focusPath = path;
      if (!focus.what.includes("wardley-cp-entry") || focus.action !== "settings") {
        return {
          verdict: "broken",
          why: `the keyboard did not reach the pad's Settings entry (focus on ${focus.what})`,
          measured,
        };
      }
      await ctx.board.press("Enter");
      // the component may have moved under nothing: its middle now is where the renderer aims the click
      const shape = (await shapeBox(ctx, target.id)) ?? target.box;
      return popupBody(ctx, measured, centre(shape), target.id, {
        popup: ".djs-popup.wardley-element-settings",
        entries: ".djs-popup.wardley-element-settings .entry",
        choose: '.djs-popup.wardley-element-settings .entry[data-id="type-market"]',
        isEntry: isPopup,
        applied: (file, id) =>
          wardleyLines(file).some(
            (line) => line.startsWith(`component ${TEA[id]?.name} [`) && line.includes("(market)"),
          ),
      });
    },
    cell: popupCell,
  },

  // ── a board zoom under the armed editor ──
  "board-zoom": {
    notations: ALL,
    did: "double-click a shape, select all, type Zed and leave the editor box open; then turn the wheel over the bare board, a burst of 8 events outwards. On a second page the same up to the wheel, and a click on the bare board instead. Then arm the node again",
    expected:
      "what the node's own rule for a board zoom says (armedzoom, read off the page). disarm: the node is a preview before the first zoom step (no late disarm, no zoom step and no frame with the node armed at another zoom), the editor box is closed, Zed is that shape's name in the file, the file is byte for byte the one the click on the bare board writes, and the board zooms. free: the board zooms under the armed editor, the box stays open with Zed and over its label, the diagram keeps the scale of its host, nothing is written, and a click on the bare board then writes that same file. lock: the zoom is refused, the node stays armed with the box open, and the click writes that same file",
    async run(ctx) {
      const measured: Measured = {};
      const nodeId = ctx.node.id;
      // the rule in effect for THIS node: the verdict follows it, not the script's idea of a default
      const rule = (await ctx.board.armPolicy(nodeId))?.armedzoom ?? "free";
      measured.armedzoom = rule;
      const opened = await typeUncommitted(ctx, measured);
      if (!opened) return { verdict: "broken", why: "no editor box opened", measured };
      const { target } = opened;
      measured.typedInBox = await editorText(ctx);
      await ctx.shot("typed", [opened.editor!]);
      const pane = await ctx.board.freePanePoint();
      if (!pane) throw new Unmeasured("no point of the bare board takes a press");
      const [before, counters0] = [await ctx.board.viewport(), (await ctx.board.counters()).arm];
      const uncommitted = (await fileNow(ctx)) === ctx.file0;
      await ctx.board.startFrames();
      await ctx.board.wheelBurst(pane, BURST.deltaY, { count: BURST.count });
      const after = await ctx.board.waitForRest();
      const frames = await ctx.board.stopFrames();
      const counters1 = (await ctx.board.counters()).arm;
      const armedAfter = (await ctx.board.armState()).armed === nodeId;
      // a zoom disarm writes inside the disarm; a node that stayed armed has nothing to write yet
      const fileAfterBurst = armedAfter ? await fileNow(ctx) : ((await fileChange(ctx, ctx.file0, 1500)) ?? ctx.file0);
      const boxAfter = (await ctx.node.query(ctx.spec.label.box))[0];
      const labels = await ctx.node.query(ctx.spec.label.text(target.id));
      const unitAfter = await ctx.node.diagramScale();
      const count = <K extends keyof typeof counters0>(key: K): number => counters1[key] - counters0[key];
      Object.assign(measured, {
        pane: rp(pane),
        uncommittedBeforeBurst: uncommitted,
        viewportBefore: { x: round(before.x, 2), y: round(before.y, 2), zoom: before.zoom },
        viewportAfter: { x: round(after.x, 2), y: round(after.y, 2), zoom: round(after.zoom, 4) },
        zoomFactor: round(after.zoom / before.zoom, 4),
        armedAfterBurst: armedAfter,
        boxOpenAfterBurst: !!boxAfter,
        boxTextAfterBurst: await editorText(ctx),
        counters: {
          disarmsBeforeZoom: count("disarmsBeforeZoom"),
          disarmsAtTick: count("disarmsAtTick"),
          lateDisarms: count("lateDisarms"),
          armedZoomTicks: count("armedZoomTicks"),
          zoomsRefused: count("zoomsRefused"),
          zoomsUndone: count("zoomsUndone"),
        },
        frames: frames.length,
        framesArmedAtAnotherZoom: frames.filter((one) => one.armed !== null && one.zoom !== before.zoom).length,
        framesShownArmedAtAnotherZoom: frames.filter((one) => one.shown !== null && one.zoom !== before.zoom).length,
        fileChangedByBurst: fileAfterBurst !== ctx.file0,
        namedByBurst: fileAfterBurst !== ctx.file0 && ctx.spec.label.named(fileAfterBurst, target.id, TYPED),
        // a node that stayed armed: its picture against its host, which the board zoom made smaller
        ...(armedAfter && unitAfter !== null
          ? { pictureOutOfScalePct: round(Math.abs(unitAfter / ctx.unitPx / (after.zoom / before.zoom) - 1) * 100, 1) }
          : {}),
        ...(armedAfter && boxAfter && labels.length > 0
          ? { boxOverLabelAfterBurst: inside(centre(union(...labels)), boxAfter, 2) }
          : {}),
      });
      await ctx.shot("zoomed");
      // a node that stayed armed (free, lock): the click on the bare board is what commits
      let file = fileAfterBurst;
      if (armedAfter) {
        const again = await ctx.board.freePanePoint();
        if (!again) throw new Unmeasured("no point of the bare board takes a press after the zoom");
        await ctx.board.click(again);
        await fileChange(ctx, ctx.file0);
        await rest(ctx, 300);
        file = await fileNow(ctx);
        measured.armedAfterPaneClick = (await ctx.board.armState()).armed === nodeId;
      }
      const named = file !== ctx.file0 && ctx.spec.label.named(file, target.id, TYPED);
      const reference = await byPaneClick(ctx, target.id);
      const same = file === reference.file;
      Object.assign(measured, {
        fileChanged: file !== ctx.file0,
        named,
        newLines: newLines(ctx.file0, file).length,
        paneClick: {
          sameStart: reference.sameStart,
          fileChanged: reference.changed,
          named: reference.changed && ctx.spec.label.named(reference.file, target.id, TYPED),
          newLines: newLines(ctx.file0, reference.file).length,
          armedAfter: reference.armed,
        },
        sameFileAsPaneClick: same,
      });
      // a case that goes on after a disarm arms the node again first: here that is the last step
      await ctx.board.arm(nodeId);
      const rearmed = await ctx.board.viewport();
      const drawn = (await seen(ctx, ctx.spec.label.text(target.id))).map((one) => one.text).join(" ");
      Object.assign(measured, {
        armedAgain: (await ctx.board.armState()).armed === nodeId,
        viewportArmedAgain: { x: round(rearmed.x, 2), y: round(rearmed.y, 2), zoom: rearmed.zoom },
        labelDrawn: drawn,
      });
      await ctx.shot("armed-again");
      const sawZoom =
        (measured.framesArmedAtAnotherZoom as number) > 0 || count("armedZoomTicks") > 0 || count("lateDisarms") > 0;
      if (file !== ctx.file0 && !named)
        return { verdict: "wrong-data", why: "the file changed, but that shape is not named Zed", measured };
      if (!same)
        return {
          verdict: "wrong-data",
          why: "the file is not the one a click on the bare board writes",
          measured,
        };
      if (rule === "disarm") {
        if (armedAfter) return { verdict: "broken", why: "the board zoom did not disarm the node", measured };
        if (sawZoom)
          return {
            verdict: "broken",
            why: `the armed editor saw the zoom: ${String(measured.framesArmedAtAnotherZoom)} frames armed at another zoom, ${count("armedZoomTicks")} zoom steps while armed, ${count("lateDisarms")} late disarms`,
            measured,
          };
        if (!named) return { verdict: "broken", why: "the typed text did not reach the file", measured };
        if (boxAfter) return { verdict: "broken", why: "the editor box is still open in the preview", measured };
        if (after.zoom === before.zoom)
          return { verdict: "degraded", why: "the node was disarmed and the board did not zoom", measured };
        return { verdict: "ok", why: "", measured };
      }
      if (!armedAfter) return { verdict: "broken", why: `the node was disarmed under armedzoom=${rule}`, measured };
      if (!named) return { verdict: "broken", why: "the typed text did not reach the file", measured };
      if (rule === "lock") {
        return after.zoom === before.zoom
          ? { verdict: "ok", why: "", measured }
          : { verdict: "broken", why: "the board zoomed under armedzoom=lock", measured };
      }
      // free: the board zooms under the open editor, which is what the rule leaves alone
      if (!boxAfter || measured.boxTextAfterBurst !== TYPED)
        return { verdict: "broken", why: "the zoom closed the editor box or changed its text", measured };
      if (measured.boxOverLabelAfterBurst === false)
        return { verdict: "degraded", why: "after the zoom the editor box is no longer over its label", measured };
      if (((measured.pictureOutOfScalePct as number | undefined) ?? 0) > 1)
        return {
          verdict: "degraded",
          why: `while the editor box is open the diagram is ${String(measured.pictureOutOfScalePct)} % out of the scale of its host`,
          measured,
        };
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) => {
      const counters = m.counters as Record<string, number> | undefined;
      if (!counters) return "none";
      const state = m.armedAfterBurst
        ? `stays armed, ${counters.armedZoomTicks} zoom steps under it, ${counters.zoomsRefused} refused, box ${m.boxOpenAfterBurst ? "open" : "closed"}, picture ${num(m.pictureOutOfScalePct)} % out of scale`
        : `preview first (before ${counters.disarmsBeforeZoom}, late ${counters.lateDisarms}, steps ${counters.armedZoomTicks}, armed frames at another zoom ${String(m.framesArmedAtAnotherZoom)}/${String(m.frames)})`;
      return `${String(m.armedzoom)}: ${state}, zoom x${num(m.zoomFactor, 2)}, ${m.named ? "Zed in file" : "Zed NOT in file"}, ${m.sameFileAsPaneClick ? "= pane click" : "NOT the pane click's file"}, again armed @${num((m.viewportArmedAgain as { zoom: number } | undefined)?.zoom, 4)}`;
    },
  },

  // ── what only the product's own mount has ──
  "menu-dialog": {
    notations: ALL,
    did: "run the Keyboard shortcuts… entry of the menu the product's mount builds (the spike's pages draw no menu button, so the entry is called through the mounted editor), look at the dialog, Escape",
    expected:
      "a modal dialog, whole inside what the person sees, in text of 9 px or more; Escape closes it, the node stays armed and the file byte-identical. Only a mount that builds the product's menu has it: the spike's in-page mount leaves menu and dialogs out, which is no property of a strategy",
    async run(ctx) {
      const measured: Measured = {};
      const frame = ctx.node.frame;
      const label = frame
        ? await frame.evaluate((key) => {
            const editor = (window as unknown as Record<string, { editor?: { menu?: Record<string, unknown[]> } }>)[key]
              ?.editor;
            const entries = Object.values(editor?.menu ?? {}).flat() as Array<{
              id?: string;
              label?: string;
              onSelect?: () => void;
            }>;
            const entry = entries.find((one) => one.id === "keyboard-shortcuts");
            entry?.onSelect?.();
            return entry?.label ?? null;
          }, EMBED_KEY)
        : null;
      if (label === null) {
        throw new Unmeasured(
          "this node's mount builds no menu: the spike's in-page mount leaves the product's menu and dialogs out",
        );
      }
      const dialog = await settled(ctx, "dialog.cd-shell-dialog[open]", 2000);
      if (!dialog) return { verdict: "broken", why: "the entry opened no dialog", measured };
      await ctx.shot("dialog", [dialog]);
      const [info] = await seen(
        ctx,
        "dialog.cd-shell-dialog[open] kbd, dialog.cd-shell-dialog[open] td, dialog.cd-shell-dialog[open] li",
      );
      const modal = await ctx.node.inDocument(
        (host) => host.querySelector("dialog.cd-shell-dialog[open]")?.matches(":modal") ?? false,
      );
      Object.assign(measured, {
        entry: label,
        dialog: rb(dialog),
        modal,
        shareOfNode: round((dialog.width * dialog.height) / (ctx.host.width * ctx.host.height), 2),
        visibleShare: visibleShare(dialog, ctx.clip),
        textPx: round((info?.fontCss ?? 0) * ctx.chromePx, 1),
      });
      await ctx.board.press("Escape");
      await rest(ctx, 400);
      Object.assign(measured, {
        closedByEscape: (await ctx.node.query("dialog.cd-shell-dialog[open]")).length === 0,
        armed: (await ctx.node.state()).armed,
        fileIdentical: (await fileNow(ctx)) === ctx.file0,
      });
      if (!measured.fileIdentical) return { verdict: "wrong-data", why: "the dialog changed the file", measured };
      if (!measured.closedByEscape || !measured.armed) {
        return { verdict: "broken", why: "Escape did not close the dialog, or it disarmed the node", measured };
      }
      if (visibleShare(dialog, ctx.clip) < 0.999)
        return { verdict: "degraded", why: "the dialog is cut off", measured };
      if (Math.round((info?.fontCss ?? 0) * ctx.chromePx) < TEXT_PX) {
        return {
          verdict: "degraded",
          why: `dialog text of ${round((info?.fontCss ?? 0) * ctx.chromePx, 1)} px on screen`,
          measured,
        };
      }
      return { verdict: "ok", why: "", measured };
    },
    cell: (m) =>
      m.dialog
        ? `${num((m.dialog as Box).width, 0)}x${num((m.dialog as Box).height, 0)}, ${num((m.shareOfNode as number) * 100, 0)} % of node, text ${num(m.textPx)} px`
        : "none",
  },
};

/** what `source` is connected to in `file` and was not in the file before (the other end's document id) */
function relationOf(ctx: Ctx, file: string, source: string): string | null {
  if (ctx.notation === "wardley") {
    const name = TEA[source]?.name;
    const line = wardleyLines(file).find(
      (one) => one.startsWith(`${name} -> `) && !wardleyLines(ctx.file0).includes(one),
    );
    const other = line?.slice(`${name} -> `.length).split(";")[0]?.trim();
    return Object.entries(TEA).find(([, value]) => value.name === other)?.[0] ?? other ?? null;
  }
  if (ctx.notation === "value-chain") {
    const known = valueChain(ctx.file0).connections.map((one) => one.id);
    const added = valueChain(file).connections.find((one) => !known.includes(one.id));
    if (!added) return null;
    return added.source === source
      ? added.target
      : added.target === source
        ? added.source
        : `${added.source} -> ${added.target}`;
  }
  const [was, now] = [teamTopology(ctx.file0), teamTopology(file)];
  const annotation = now.annotations.find((one) => one.id === source);
  return annotation?.attachedTo !== was.annotations.find((one) => one.id === source)?.attachedTo
    ? (annotation?.attachedTo ?? null)
    : null;
}

// ── one row ──────────────────────────────────────────────────────────────────

interface Job {
  name: string;
  notation: Notation;
  strategy: Strategy;
  zoom: number;
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no result after ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function attempt(harness: Harness, job: Job, run: number): Promise<Row> {
  const started = Date.now();
  const definition = CASES[job.name]!;
  const row: Row = {
    case: job.name,
    notation: job.notation,
    strategy: job.strategy,
    zoom: job.zoom,
    did: definition.did,
    expected: definition.expected,
    verdict: "unmeasured",
    why: "",
    measured: {},
    cell: "",
    problems: [],
    ms: 0,
  };
  let board: Board | undefined;
  try {
    board = await harness.open({
      board: "matrix",
      strategy: job.strategy,
      notations: [job.notation as ModelNotation],
      zoom: job.zoom,
      ...ORIGIN,
    });
    const opened = board;
    const outcome = await withTimeout(
      (async (): Promise<Outcome> => {
        const nodeId = `m-${job.notation}`;
        if (PAGE_CSS) await opened.page.addStyleTag({ content: PAGE_CSS });
        await opened.arm(nodeId);
        // arming may have moved the board (arm rules): everything below is computed from what is in effect
        const armed = await opened.viewport();
        const [policy, move] = [await opened.armPolicy(nodeId), await opened.lastTransition()];
        const at = (v: { x: number; y: number; zoom: number }): string => `${round(v.x, 1)},${round(v.y, 1)}@${v.zoom}`;
        const node = await opened.node(nodeId);
        const spec = SPECS[job.notation];
        const [net, map, unit, host] = [
          await node.netScale(),
          await node.map(),
          await node.diagramScale(),
          await node.hostBox(),
        ];
        const view = opened.page.viewportSize() ?? { width: 0, height: 0 };
        const space = await editorSpace(node);
        const chromePx = net * map.sx;
        const unitPx = unit ?? 1;
        Object.assign(row, {
          net: round(net, 4),
          frame: node.frame !== undefined,
          chromePx: round(chromePx, 4),
          unitPx: unit === null ? null : round(unit, 4),
          hostPx: { width: round(host.width, 1), height: round(host.height, 1) },
          space: {
            scale: round(space.scale, 4),
            origin: rp(space.origin),
            window: rb(space.window),
            virtual: space.virtual,
          },
          layers: space.layers,
          mounts: (await opened.counters()).mounts[nodeId],
          zoomInEffect: armed.zoom,
          viewportArmed: { x: round(armed.x, 2), y: round(armed.y, 2), zoom: armed.zoom },
          hostAt: rp(origin(host)),
          armRules: policy ? `${policy.armzoom}/${policy.armedzoom}/${policy.armreturn}` : "none",
          armMove: move
            ? {
                by: move.by,
                from: at(move.from),
                to: at(move.to),
                askedMs: move.askedMs,
                writes: move.writes,
                interrupted: move.interrupted,
              }
            : null,
        });
        if (!(await node.state()).armed) throw new Unmeasured("the node did not arm");
        const ctx: Ctx = {
          harness,
          board: opened,
          node,
          notation: job.notation,
          strategy: job.strategy,
          zoom: armed.zoom,
          asked: job.zoom,
          spec,
          file0: (await opened.fileText(spec.file)) ?? "",
          board0: await opened.boardText(),
          net,
          frame: node.frame !== undefined,
          chromePx,
          unitPx,
          host,
          clip: node.frame ? host : { x: 0, y: 0, width: view.width, height: view.height },
          toldPx: space.scale * map.sx,
          tol: Math.max(1.5, 1.5 * unitPx + 0.5),
          async shot(tag, around = []) {
            if (!SHOTS || run > 0) return;
            await node.screenshot(outPath(`shots/${job.name}-${job.notation}-${job.strategy}-${job.zoom}-${tag}.png`), {
              around,
              pad: 24,
            });
          },
        };
        const result = await definition.run(ctx);
        row.armedAfter = (await node.state()).armed;
        row.boardSame = (await opened.boardText()) === ctx.board0;
        await ctx.shot("end");
        return result;
      })(),
      CASE_TIMEOUT,
      `${job.name} ${job.notation} ${job.strategy} ${job.zoom}`,
    );
    Object.assign(row, outcome);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
    if (error instanceof Unmeasured) {
      row.verdict = "unmeasured";
      row.why = message;
    } else {
      row.verdict = "unmeasured";
      row.why = `harness: ${message}`;
      row.failed = message;
    }
  }
  if (board) {
    row.problems = await board.problems({ allow: definition.allow ?? [] }).catch((error: unknown) => [String(error)]);
    await board.close().catch(() => undefined);
  }
  row.cell = row.verdict === "unmeasured" ? "" : definition.cell(row.measured);
  row.ms = Date.now() - started;
  return row;
}

async function one(harness: Harness, job: Job): Promise<Row> {
  const row = await attempt(harness, job, 0);
  if (REPEAT === 1) return row;
  const runs = [{ verdict: row.verdict, cell: row.cell }];
  for (let run = 1; run < REPEAT; run++) {
    const again = await attempt(harness, job, run);
    runs.push({ verdict: again.verdict, cell: again.cell });
    row.problems.push(...again.problems);
    row.failed ??= again.failed;
    row.ms += again.ms;
  }
  row.runs = runs;
  row.stable = runs.every((one) => one.verdict === runs[0]!.verdict && one.cell === runs[0]!.cell);
  return row;
}

// ── folding and printing ─────────────────────────────────────────────────────

interface Folded {
  case: string;
  notation: Notation;
  strategy: Strategy;
  /** the worst verdict over the zooms */
  verdict: Verdict;
  /** "0.5: verdict cell | 0.73: ..." */
  byZoom: string;
  /** the reasons of the rows that are not ok, each once */
  note: string;
}

function fold(rows: readonly Row[]): Folded[] {
  const out: Folded[] = [];
  for (const name of Object.keys(CASES)) {
    for (const notation of notations) {
      for (const strategy of strategies) {
        const mine = rows.filter((row) => row.case === name && row.notation === notation && row.strategy === strategy);
        if (mine.length === 0) continue;
        const verdict = VERDICTS.find((one) => mine.some((row) => row.verdict === one)) ?? "unmeasured";
        const byZoom = mine
          .map(
            (row) =>
              `${row.zoom}: ${row.verdict}${row.cell ? ` ${row.cell}` : ""}${row.stable === false ? " (runs differ)" : ""}`,
          )
          .join(" | ");
        const reasons = new Map<string, number[]>();
        for (const row of mine) if (row.why) reasons.set(row.why, [...(reasons.get(row.why) ?? []), row.zoom]);
        const note = [...reasons].map(([why, at]) => `${at.join(", ")}: ${why}`).join("; ");
        out.push({ case: name, notation, strategy, verdict, byZoom, note });
      }
    }
  }
  return out;
}

function markdown(folded: readonly Folded[]): string {
  const escape = (text: string): string => text.replaceAll("|", "\\|");
  const lines = [
    "| Case | Notation | Strategy | Verdict | By zoom | Note |",
    "| --- | --- | --- | --- | --- | --- |",
    ...folded.map(
      (row) =>
        `| ${row.case} | ${row.notation} | ${row.strategy} | ${row.verdict} | ${escape(row.byZoom)} | ${escape(row.note)} |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function line(row: Row): string {
  return [
    row.case.padEnd(22),
    row.notation.padEnd(14),
    row.strategy.padEnd(8),
    String(row.zoom).padEnd(5),
    row.verdict.padEnd(11),
    row.cell.padEnd(44),
    row.why ? `(${row.why.slice(0, 110)})` : "",
    row.problems.length > 0 ? ` PROBLEMS ${row.problems.length}` : "",
    row.stable === false ? " RUNS DIFFER" : "",
  ].join(" ");
}

// ── the run ──────────────────────────────────────────────────────────────────

await run(async (harness) => {
  const names = Object.keys(CASES).filter(
    (name) => caseFilter.length === 0 || caseFilter.some((part) => name.includes(part)),
  );
  const jobs: Job[] = [];
  for (const name of names) {
    for (const notation of notations) {
      if (!CASES[name]!.notations.includes(notation)) continue;
      for (const strategy of strategies) for (const zoom of zooms) jobs.push({ name, notation, strategy, zoom });
    }
  }
  const order = new Map(jobs.map((job, index) => [job, index]));
  const done: Array<{ index: number; row: Row }> = [];
  const queue = [...jobs];
  const started = Date.now();
  console.log(
    `${jobs.length} rows: ${names.length} cases, ${notations.join(", ")}; ${strategies.join(", ")}; zoom ${zooms.join(", ")}; ${CONCURRENCY} pages at a time, ${REPEAT} run(s) per row`,
  );
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const row = await one(harness, job);
        done.push({ index: order.get(job)!, row });
        console.log(line(row));
        for (const problem of row.problems) console.log(`    ${problem.slice(0, 220)}`);
      }
    }),
  );
  const rows = done.sort((a, b) => a.index - b.index).map((one) => one.row);
  const folded = fold(rows);
  const count = (verdict: Verdict): number => rows.filter((row) => row.verdict === verdict).length;
  const failed = rows.filter((row) => row.failed !== undefined).length;
  const withProblems = rows.filter((row) => row.problems.length > 0).length;
  const unstable = rows.filter((row) => row.stable === false).length;
  const path = writeResult("miragon-a", {
    what: "board spike battery miragon-a: Wardley Map, Value Chain and Team Topology per strategy and board zoom",
    chromium: harness.browser.version(),
    viewport: { width: 2200, height: 1300, deviceScaleFactor: 1 },
    nodeOrigin: ORIGIN,
    strategies,
    notations,
    zooms,
    cases: names,
    repeat: REPEAT,
    ...(PAGE_CSS ? { pageCss: PAGE_CSS } : {}),
    rules: {
      targetPx: TARGET_PX,
      textPx: TEXT_PX,
      anchorPx: ANCHOR_PX,
      pointer: "max(1.5, 1.5 x unitPx + 0.5) screen px",
    },
    rows: rows.map(({ ms: _ms, ...row }) => row),
    folded,
  });
  const table = outPath("miragon-a.md");
  writeFileSync(table, markdown(folded));
  console.log(
    `\n${rows.length} rows in ${Math.round((Date.now() - started) / 1000)} s: ${VERDICTS.map((one) => `${count(one)} ${one}`).join(", ")}; ` +
      `${failed} failed in the harness, ${withProblems} with console errors or log lines, ${unstable} whose runs differ\n${path}\n${table}`,
  );
  // the harness failed, not a strategy: a case that threw, or output where none belongs
  return failed + withProblems;
});
