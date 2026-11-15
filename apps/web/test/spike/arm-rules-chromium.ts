/**
 * Battery "arm-rules" of the board spike: the three arm rules themselves (src/board-spike/arm-rules.ts
 * decides, board-arming.ts moves the board), measured from outside. Run by hand, not by `pnpm test`
 * or CI (lib.ts starts the dev server and a Chromium with the sandbox):
 *
 *   PORT=5451 CACHE_DIR=<scratch>/vite-cache OUT_DIR=<scratch>/run node apps/web/test/spike/arm-rules-chromium.ts
 *   CASES=R5,R6 JOBS=4 REPEAT=2 node apps/web/test/spike/arm-rules-chromium.ts
 *   CASES=list node apps/web/test/spike/arm-rules-chromium.ts          (prints every row id, runs nothing)
 *
 * The rules: armzoom (off | min1 | exact1: the board zoom a node is armed at, the board moves
 * there FIRST), armedzoom (free | disarm | lock: a board zoom under an armed node), armreturn
 * (stay | back). A row names the rules it asked for (`policy`; "default" is what the node's
 * strategy gives: overlay exact1 / disarm / stay since round 6, min1 / disarm / stay in round 5),
 * the board zoom ASKED FOR (the URL's) and the board zoom IN EFFECT (read off the board after the
 * arming). A row that names a rule in the URL is the same row as in round 5 and keeps its id, so
 * it can be compared with that round; a row that asks for "the default" now runs exact1.
 *
 * Every case arms by a REAL gesture (a double-click, the Edit button) unless the row is about the
 * hook or the URL. One fresh page per row. After every arming the row reads the viewport and the
 * builder's transition record, and computes the viewport the rule should give with a calculation
 * of its own (expectViewport below, not the source's). That calculation knows the two kinds of
 * anchor of round 6: a pointer (the double-click) keeps the double-clicked point and closes only a
 * gap between a node longer than the board's box and that box; no pointer (the Edit button, the
 * hook, the URL) puts the start of such a node at the margin.
 *
 * Cases:
 *   R1  arm-from-zoom        start zoom x armzoom x way of arming: the final viewport, the wrapper
 *                            in the board's box, the anchor under the pointer, the transition, the
 *                            zoom per animation frame with the armed flag, mounts, both files byte
 *                            for byte, then the first gestures: a shape move, a palette create, a popup
 *   R2  preview-vs-armed     at the arm zoom: how far a shape, a table cell or the literal
 *                            expression's fields jump between preview and armed editor, and the
 *                            share of pixels that change; how far the element travels on the
 *                            screen when the arming moves the board, and on the disarm
 *   R3  below-one            the round 4 symptoms below zoom 1 under the default rules against armzoom=off
 *   R4  large-node           seven windows from 2200 x 1300 to 500 x 400, nodes 800 x 540, 940 x 540
 *                            and 1600 x 1000, armed by a double-click in three parts of the node,
 *                            by the Edit button and by the hook: where the double-clicked point
 *                            goes, gaps, transitions, the toolbar's band, the palette, the header's
 *                            Done and the toolbar's Done control (pressed for real in three
 *                            states: as armed, after a pan 40 px up, after a pan far to the left);
 *                            a window that shrinks under an armed node
 *   R5  zoom-while-armed     zoom gesture x editor state x armedzoom
 *   R6  interrupted          something happens during the arm transition (a key too)
 *   R7  return               armreturn back and stay
 *   R8  a-to-b               a double-click on B while A is armed
 *   R9  other-strategies     rows of R1 and R5 on iframe and plugin with the rules given in the URL
 *   R10 cost                 time from the double-click to the editor taking input, frame intervals
 *   R11 reduced-motion       prefers-reduced-motion: the transition takes 0 ms
 *   R12 files                the board file, and a second node of the same file
 *   R13 rearm                after a disarm by a zoom: one double-click, and what is left of the
 *                            person's place in the editor (its view, the selection, the open table)
 *   R14 oversize-above-one   armzoom=min1 above zoom 1, a node larger than the board's box: the
 *                            starts round 5 measured and starts at which the node covers the box,
 *                            by a double-click and by the hook
 *   R15 exact1-cost          what the default costs a person above zoom 1: how far the
 *                            double-clicked shape travels and shrinks, the time to an editor that
 *                            takes a press, and the round trip (armed at 1, a wheel burst in over
 *                            the bare board, a new double-click on the same shape)
 *
 * Verdicts (the worst failing check wins; every check carries its rule and what it measured):
 *   ok          every check passed
 *   degraded    it works at a measured cost (a popup away from its anchor, entries out of reach,
 *               the picture out of scale for some frames, a preview that differs from its editor)
 *   broken      the rule did not do what it says (wrong zoom, not armed, an armed editor that saw
 *               a zoom step, a half state), or a gesture did not work
 *   wrong-data  a file holds what it must not: typed text lost, a file written by an arming, a
 *               transition or a disarm, a shape somewhere else in the file
 *   unmeasured  the row could not run; `reason` says why
 * Under armzoom=off and armedzoom=free a row measures the board of round 4: its verdict is that
 * board's, and stands beside the rule's row for comparison.
 *
 * `measured`, `key` and `more` hold what is the same in every run; `volatile` what depends on time
 * (ms, frame counts, the machine's load): a comparison of two runs leaves `volatile` and `ms` out.
 * `key` is the measured text a row had in round 5; what round 6 measures in addition is in `more`,
 * so that `key` can be compared with round 5 word for word.
 *
 * Exit code 1 only when the harness failed (a row threw). A verdict never fails the run.
 *
 * Environment: STRATEGIES (default overlay: the strategy of every case but R9), CASES (comma list;
 * a row runs when its case or its id starts with an entry; `list` prints the ids), REPEAT (default
 * 1; the row says whether the repeats agree), JOBS (rows side by side, default 3, at most 4; rows
 * that take times run one after another at the end), plus lib.ts's PORT, CACHE_DIR, OUT_DIR, OUT.
 * Results: <OUT_DIR>/arm-rules.json, <OUT_DIR>/arm-rules.md, screenshots under <OUT_DIR>/shots.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { inflateSync } from "node:zlib";

import { HOOKS_KEY } from "../../src/board-spike/shared.ts";
import {
  aimAt,
  type ArmedZoom,
  type ArmReturn,
  type ArmTransition,
  type ArmZoom,
  type Board,
  type BoardQuery,
  type Box,
  centre,
  type FrameSample,
  type Harness,
  KNOWN_CONSOLE,
  type ModelNotation,
  type NativeGeometry,
  type NodeHandle,
  type OpenOptions,
  outPath,
  type Point,
  round,
  run,
  sleep,
  STRATEGIES,
  type Strategy,
  type Viewport,
  writeResult,
} from "./lib.ts";

type NativeWindow = Window & { __boardSpikeNative?: NativeGeometry };

const list = <T extends string>(name: string, all: readonly T[], fallback: readonly T[]): T[] => {
  const wanted = (process.env[name] ?? "").split(",").filter(Boolean);
  return wanted.length === 0 ? [...fallback] : all.filter((one) => wanted.includes(one));
};
const strategies = list("STRATEGIES", STRATEGIES, ["overlay"]);
const caseFilter = (process.env.CASES ?? "").split(",").filter(Boolean);
const repeat = Math.max(1, Math.round(Number(process.env.REPEAT ?? 1)) || 1);
const jobs = Math.max(1, Math.min(4, Math.round(Number(process.env.JOBS ?? 3)) || 1));

/** where a node's top-left corner sits in the canvas at the start: clear of the toolbar */
const ORIGIN = { x: 60, y: 80 };
/** the rule's own numbers, as the handover names them: checked against `armPolicy()` in every R1 row */
const MARGIN = 24;
const NEARLY_ONE = 0.01;
/** what a state types into an open editor */
const MARKER = "Zq7";
const ALLOW = [KNOWN_CONSOLE.padDeprecation, KNOWN_CONSOLE.feelEditor];
/** an edit shows in the file about 350 ms after a gesture; generous, since other batteries run beside this one */
const WRITE_MS = 4000;
const SHOW_MS = 2500;
/** a popup or list counts as at its anchor within this many screen px */
const PLACE_TOL = 3;
const WINDOW = { width: 2200, height: 1300 };

type Verdict = "ok" | "degraded" | "broken" | "wrong-data" | "unmeasured";
const WORST: readonly Verdict[] = ["ok", "degraded", "broken", "wrong-data"];

interface Check {
  name: string;
  ok: boolean;
  /** the verdict this check gives when it fails */
  fails: "degraded" | "broken" | "wrong-data";
  /** what was measured, with the rule */
  detail: string;
}

interface Outcome {
  zoomAsked: number | null;
  zoomInEffect: number | null;
  /** the measured text of the row: short, and the same in every run */
  key: string;
  /** further measured text, new in round 6 and the same in every run: kept out of `key`, which is compared with round 5 */
  more?: string;
  checks: Check[];
  measured: Record<string, unknown>;
  volatile?: Record<string, unknown>;
}

interface Row extends Partial<Outcome> {
  case: string;
  id: string;
  notation: string;
  strategy: Strategy;
  policy: string;
  status: "measured" | "unmeasured" | "failed";
  verdict: Verdict;
  decidedBy?: string;
  reason?: string;
  problems: string[];
  shots: string[];
  ms: number;
  /** the machine's 1 minute load when the row ended */
  load: number;
  repeats?: { verdicts: Verdict[]; keys: string[]; agree: boolean };
}

/** what a row gets: pages that are closed for it, and screenshots */
interface Ctx {
  harness: Harness;
  open(query: BoardQuery, options?: OpenOptions): Promise<Board>;
  /** a PNG of the page (or of `clip`), under <OUT_DIR>/shots; returns the path */
  shot(board: Board, name: string, clip?: Box): Promise<string>;
}

interface Task {
  case: string;
  id: string;
  notation: string;
  strategy: Strategy;
  policy: string;
  /** takes times: runs alone, after the rows that run side by side */
  serial?: boolean;
  run(ctx: Ctx): Promise<Outcome>;
}

class Unmeasured extends Error {}

// ── small tools ──────────────────────────────────────────────────────────────

const px = (value: number, digits = 1): number => round(value, digits);
const pair = (point: Point, digits = 0): string => `${round(point.x, digits)},${round(point.y, digits)}`;
const vp = (viewport: Viewport): string => `${round(viewport.x, 1)},${round(viewport.y, 1)}@${round(viewport.zoom, 4)}`;
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const frame = (board: Board, count = 1): Promise<void> =>
  board.page.evaluate(
    (frames) =>
      new Promise<void>((resolve) => {
        const step = (left: number): void => void (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
        step(frames);
      }),
    count,
  );
const check = (name: string, ok: boolean, fails: Check["fails"], detail: string): Check => ({
  name,
  ok,
  fails,
  detail,
});
const policyText = (rules: { armzoom?: ArmZoom; armedzoom?: ArmedZoom; armreturn?: ArmReturn }): string =>
  rules.armzoom === undefined && rules.armedzoom === undefined && rules.armreturn === undefined
    ? "default"
    : [rules.armzoom ?? "-", rules.armedzoom ?? "-", rules.armreturn ?? "-"].join("/");

const overlap = (a: Box, b: Box): number => {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
};
const share = (box: Box, within: Box): number =>
  box.width * box.height > 0 ? overlap(box, within) / (box.width * box.height) : 0;
const holds = (box: Box, point: Point, inset = 0): boolean =>
  point.x >= box.x + inset &&
  point.x <= box.x + box.width - inset &&
  point.y >= box.y + inset &&
  point.y <= box.y + box.height - inset;

/** the lines of `now` that `before` does not have, trimmed */
const newLines = (before: string | undefined, now: string | undefined): string[] => {
  const had = new Set((before ?? "").split("\n").map((line) => line.trim()));
  return (now ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !had.has(line));
};

// ── the board's box, and the viewport a rule should give ─────────────────────

interface Geometry {
  /** the board's own box (`.react-flow`) in the page */
  canvas: Box;
  /** the toolbar's band: from the box's top to the toolbar's bottom */
  band: number;
  /** the node's wrapper (header and body) in the page, null when the node is not there */
  wrapper: Box | null;
}

async function geometry(board: Board, nodeId: string): Promise<Geometry> {
  return board.page.evaluate((id) => {
    const native = (window as NativeWindow).__boardSpikeNative;
    const rect = (element: Element): Box => {
      const { x, y, width, height } = native ? native.rect(element) : element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const canvas = rect(document.querySelector(".react-flow")!);
    const toolbar = document.querySelector(".board-toolbar");
    const wrapper = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
    return {
      canvas,
      band: toolbar ? Math.max(0, rect(toolbar).y + rect(toolbar).height - canvas.y) : 0,
      wrapper: wrapper ? rect(wrapper) : null,
    };
  }, nodeId);
}

/** the box a node may use: the board's box below the toolbar's band, minus the margin */
const innerBox = (g: Geometry): Box => ({
  x: g.canvas.x + MARGIN,
  y: g.canvas.y + g.band + MARGIN,
  width: g.canvas.width - 2 * MARGIN,
  height: g.canvas.height - g.band - 2 * MARGIN,
});

/** the target zoom of a rule, written from the rule's description */
const ruleZoom = (zoom: number, rule: ArmZoom): number =>
  rule === "off" ? zoom : rule === "exact1" ? 1 : zoom <= 1 + NEARLY_ONE ? 1 : zoom;

/** what armed the node: a pointer (the double-click), or none (the Edit button, the keyboard, the hook, the URL) */
type AnchorKind = "pointer" | "centre";

/**
 * The viewport the rule should arm at, computed here from its description: the rule's zoom about
 * the anchor, then the least shift that puts the wrapper into the box minus the margin. An axis on
 * which the wrapper is longer than the box: without a pointer its start goes to the margin; with a
 * pointer only a gap is closed (a start beyond the low margin goes to it, an end short of the high
 * margin goes to it) and a wrapper that covers the box stays. A changed target is whole px.
 * `wrapper` and `anchor` are page px at the viewport `from`.
 */
function expectViewport(
  from: Viewport,
  g: Geometry,
  wrapper: Box,
  anchor: Point,
  rule: ArmZoom,
  kind: AnchorKind = "centre",
): Viewport {
  if (rule === "off") return from;
  const zoom = ruleZoom(from.zoom, rule);
  const factor = zoom / from.zoom;
  // page px of the wrapper after the zoom about the anchor
  const zoomed = {
    x: anchor.x + (wrapper.x - anchor.x) * factor,
    y: anchor.y + (wrapper.y - anchor.y) * factor,
    width: wrapper.width * factor,
    height: wrapper.height * factor,
  };
  const inner = innerBox(g);
  const shift = (start: number, size: number, low: number, span: number): number => {
    if (size > span) {
      if (kind === "centre") return Math.abs(start - low) <= 0.5 ? 0 : low - start;
      if (start > low + 0.5) return low - start;
      const short = low + span - (start + size);
      return short > 0.5 ? short : 0;
    }
    if (start < low - 0.5) return low - start;
    const over = start + size - (low + span);
    return over > 0.5 ? -over : 0;
  };
  const dx = shift(zoomed.x, zoomed.width, inner.x, inner.width);
  const dy = shift(zoomed.y, zoomed.height, inner.y, inner.height);
  if (zoom === from.zoom && dx === 0 && dy === 0) return from;
  // the viewport's x is where flow 0 lies in the canvas: it follows from where the wrapper's corner ends up
  const flowX = (wrapper.x - g.canvas.x - from.x) / from.zoom;
  const flowY = (wrapper.y - g.canvas.y - from.y) / from.zoom;
  return {
    x: Math.round(zoomed.x + dx - g.canvas.x - flowX * zoom),
    y: Math.round(zoomed.y + dy - g.canvas.y - flowY * zoom),
    zoom,
  };
}

interface Placed {
  /** the share of the wrapper inside the box */
  inside: number;
  fits: boolean;
  fitsX: boolean;
  fitsY: boolean;
  text: string;
  /** an axis that is too long lies as its kind of anchor asks: its start at the margin, or no gap */
  atMargin: boolean;
  /** px left bare between the wrapper and the box's margins on an axis the wrapper is longer than (0 on an axis it fits) */
  gap: Point;
}

/** how a wrapper lies in the box a node may use */
function placed(g: Geometry, wrapper: Box, kind: AnchorKind = "centre"): Placed {
  const inner = innerBox(g);
  const fitsX = wrapper.width <= inner.width + 0.5;
  const fitsY = wrapper.height <= inner.height + 0.5;
  const left = wrapper.x - inner.x;
  const top = wrapper.y - inner.y;
  const bare = (start: number, size: number, low: number, span: number): number =>
    Math.max(0, start - low, low + span - (start + size));
  const gap = {
    x: fitsX ? 0 : bare(wrapper.x, wrapper.width, inner.x, inner.width),
    y: fitsY ? 0 : bare(wrapper.y, wrapper.height, inner.y, inner.height),
  };
  // an axis that is too long: without a pointer it has to start at the margin, with one it must leave no gap
  const long = (fits: boolean, start: number, bareThere: number): boolean =>
    fits || (kind === "centre" ? Math.abs(start) <= 1 : bareThere <= 1);
  const atMargin = long(fitsX, left, gap.x) && long(fitsY, top, gap.y);
  return {
    inside: round(
      share(wrapper, { x: inner.x - 0.5, y: inner.y - 0.5, width: inner.width + 1, height: inner.height + 1 }),
      3,
    ),
    fits: fitsX && fitsY,
    fitsX,
    fitsY,
    atMargin,
    gap,
    text: `${round(share(wrapper, inner) * 100, 0)} % in the box${fitsX && fitsY ? "" : ` (the node is ${fitsX ? "" : "wider"}${!fitsX && !fitsY ? " and " : ""}${fitsY ? "" : "taller"} than the box, its corner ${pair({ x: left, y: top })} px from the margin)`}`,
  };
}

/** what the page shows as armed, read off the DOM */
async function domArmed(board: Board): Promise<{ shown: string | null; overlaid: number; layouts: string[] }> {
  return board.page.evaluate(() => ({
    shown:
      document.querySelector('.board-node[data-armed="true"]')?.closest(".react-flow__node")?.getAttribute("data-id") ??
      null,
    overlaid: document.querySelectorAll(".board-overlay-layer > .board-engine").length,
    layouts: [...document.querySelectorAll<HTMLElement>(".board-engine")].map((host) => host.dataset.layout ?? ""),
  }));
}

/** waits until the node shows as armed in the DOM (or as a preview, for null), and two frames more */
async function waitShown(board: Board, nodeId: string | null, timeout = 3000): Promise<boolean> {
  const shown = await board.waitFor(async () => (await domArmed(board)).shown === nodeId, timeout, 30);
  await frame(board, 2);
  return shown === true;
}

// ── frames ───────────────────────────────────────────────────────────────────

interface FrameFacts {
  frames: number;
  /** frames with a node armed (runtime or DOM) */
  armed: number;
  /** of those, at a board zoom other than `at` */
  armedOffZoom: number;
  zoomsWhileArmed: number[];
  /** the zooms the armed in-page editor's view was applied with */
  editorZooms: number[];
  /** frames with a node armed while the rules moved the board */
  armedWhileMoving: number;
  /** frames in which runtime and DOM name a different armed node */
  flagsApart: number;
  /** distinct zooms on the way, the armed frames aside */
  zoomSteps: number;
}

/** `at`: the zoom every armed frame must have */
function frameFacts(frames: readonly FrameSample[], at: number): FrameFacts {
  const armed = frames.filter((one) => one.armed !== null || one.shown !== null);
  return {
    frames: frames.length,
    armed: armed.length,
    armedOffZoom: armed.filter((one) => one.zoom !== at).length,
    zoomsWhileArmed: unique(armed.map((one) => one.zoom)),
    // only where a strategy applies the view again per board zoom (overlay, counter); elsewhere it is 1 by design
    editorZooms: unique(
      armed.flatMap((one) =>
        one.editorZoom === null || (one.layout !== "overlay" && one.layout !== "counter") ? [] : [one.editorZoom],
      ),
    ),
    armedWhileMoving: armed.filter((one) => one.moving).length,
    flagsApart: frames.filter((one) => one.armed !== one.shown).length,
    zoomSteps: unique(frames.map((one) => one.zoom)).length,
  };
}

/** a sampler of this script's own: per animation frame the picture's scale and the host's, for an in-page editor */
interface ScaleRow {
  zoom: number;
  armed: boolean;
  hostWidth: number;
  ctm: number | null;
}
async function startScale(board: Board, nodeId: string): Promise<void> {
  await board.page.evaluate(
    ([key, id]) => {
      const page = window as unknown as Record<string, unknown> & { __armScale?: { rows: ScaleRow[]; stop: boolean } };
      const hooks = page[key] as {
        viewport(): Viewport;
        armState(): { armed: string | null };
        engine(id: string): { host?: HTMLElement } | undefined;
      };
      const native = (window as NativeWindow).__boardSpikeNative;
      const state = (page.__armScale = { rows: [] as ScaleRow[], stop: false });
      const step = (): void => {
        if (state.stop) return;
        const host = hooks.engine(id)?.host;
        const group = host?.querySelector<SVGGElement>("svg g.viewport");
        state.rows.push({
          zoom: hooks.viewport().zoom,
          armed: hooks.armState().armed === id,
          hostWidth: host ? (native ? native.rect(host) : host.getBoundingClientRect()).width : 0,
          ctm: group ? ((native ? native.screenCTM(group) : group.getScreenCTM())?.a ?? null) : null,
        });
        requestAnimationFrame(step);
      };
      step();
    },
    [HOOKS_KEY, nodeId] as const,
  );
}
async function stopScale(board: Board): Promise<ScaleRow[]> {
  return board.page.evaluate(() => {
    const page = window as unknown as { __armScale?: { rows: ScaleRow[]; stop: boolean } };
    if (!page.__armScale) return [];
    page.__armScale.stop = true;
    return page.__armScale.rows;
  });
}
/** the picture's scale against the host's, both 1 at the first frame: 0 is a picture in scale */
function scaleFacts(rows: readonly ScaleRow[]): {
  worst: number | null;
  worstArmed: number | null;
  framesOver: number;
} {
  const first = rows.find((row) => row.ctm !== null && row.hostWidth > 0);
  if (!first || first.ctm === null) return { worst: null, worstArmed: null, framesOver: 0 };
  const off = rows
    .filter((row) => row.ctm !== null && row.hostWidth > 0)
    .map((row) => ({ armed: row.armed, off: Math.abs(row.ctm! / first.ctm! / (row.hostWidth / first.hostWidth) - 1) }));
  const worst = (some: typeof off): number | null =>
    some.length > 0 ? round(Math.max(...some.map((one) => one.off)) * 100, 2) : null;
  return {
    worst: worst(off),
    worstArmed: worst(off.filter((one) => one.armed)),
    framesOver: off.filter((one) => one.off > 0.01).length,
  };
}

// ── pictures ─────────────────────────────────────────────────────────────────

interface Picture {
  width: number;
  height: number;
  /** RGB, 8 bit */
  data: Uint8Array;
}

/** a PNG as Playwright writes it (8 bit RGB or RGBA, one pass) into RGB: no package needed */
function decodePng(file: Uint8Array): Picture {
  const bytes = Buffer.from(file);
  let at = 8;
  let [width, height, channels] = [0, 0, 4];
  const parts: Buffer[] = [];
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      [width, height] = [body.readUInt32BE(0), body.readUInt32BE(4)];
      if (body[8] !== 8 || (body[9] !== 2 && body[9] !== 6) || body[12] !== 0) {
        throw new Error(`a PNG this script cannot read (depth ${body[8]}, colour type ${body[9]})`);
      }
      channels = body[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") parts.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const lines = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= channels ? lines[y * stride + x - channels]! : 0;
      const up = y > 0 ? lines[(y - 1) * stride + x]! : 0;
      const corner = x >= channels && y > 0 ? lines[(y - 1) * stride + x - channels]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const [pa, pb, pc] = [Math.abs(up - corner), Math.abs(left - corner), Math.abs(left + up - 2 * corner)];
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      lines[y * stride + x] = (value + predicted) & 255;
    }
  }
  const data = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 3; channel++) data[pixel * 3 + channel] = lines[pixel * channels + channel]!;
  }
  return { width, height, data };
}

/**
 * Two pictures of the same screen area (`area`, page px): the share of pixels that differ by more
 * than 40 of 255 in a channel, outside the `masks` (page px), and the same share among the pixels
 * that are drawn in either picture (not the ground colour of the first pixel).
 */
function comparePictures(
  a: Picture,
  b: Picture,
  area: Box,
  masks: readonly Box[],
): { differing: number; inked: number } {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Unmeasured(`two pictures of ${a.width}x${a.height} and ${b.width}x${b.height}`);
  }
  const masked = (x: number, y: number): boolean =>
    masks.some(
      (mask) =>
        x >= mask.x - area.x - 1 &&
        x <= mask.x + mask.width - area.x + 1 &&
        y >= mask.y - area.y - 1 &&
        y <= mask.y + mask.height - area.y + 1,
    );
  const ground = [a.data[0]!, a.data[1]!, a.data[2]!];
  const drawn = (picture: Picture, pixel: number): boolean =>
    [0, 1, 2].some((channel) => Math.abs(picture.data[pixel * 3 + channel]! - ground[channel]!) > 24);
  let [compared, differing, ink, inkDiffering] = [0, 0, 0, 0];
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (masked(x, y)) continue;
      const pixel = y * a.width + x;
      compared++;
      const differs = [0, 1, 2].some(
        (channel) => Math.abs(a.data[pixel * 3 + channel]! - b.data[pixel * 3 + channel]!) > 40,
      );
      const inked = drawn(a, pixel) || drawn(b, pixel);
      if (inked) ink++;
      if (differs) {
        differing++;
        if (inked) inkDiffering++;
      }
    }
  }
  return {
    differing: round((differing / Math.max(1, compared)) * 100, 2),
    inked: round((inkDiffering / Math.max(1, ink)) * 100, 2),
  };
}

// ── notations ────────────────────────────────────────────────────────────────

/**
 * What a row edits: a notation's diagram, or one of the two HTML views of the DMN node (the decision
 * table; the literal expression, which the sample's decision is made into first: R2 only).
 */
type Kind = "bpmn" | "dmn" | "dmn-table" | "dmn-literal" | "wardley" | "context-map";
/** the kinds of round 5, the grid of R1 and R2 */
const KINDS: readonly Kind[] = ["bpmn", "dmn", "dmn-table", "wardley", "context-map"];

interface Spec {
  notation: ModelNotation;
  file: string;
  /** shapes a double-click, a move, a label edit and a held drag use: the first that takes a press */
  shapes: readonly string[];
  /** held after the press of a move: switches grid snapping off */
  hold: readonly string[];
  /** the palette entry (data-action) a create drags out */
  create: string;
  /** where a created shape is dropped: a diagram point on an element, or (without it) a bare spot that is searched */
  drop?: { diagram: Point; on: string };
  /** shapes whose pad opens the popup, the first that can be selected */
  padOf: readonly string[];
  padEntry: string;
  popup: string;
  /** where the popup's corner lies from the pad entry's corner at net scale 1, px (measured at board zoom 1) */
  popupOff: Point;
  /** the pad entry's size at net scale 1, px */
  entryPx: number;
  /** the open label editor */
  editor: string;
}

const SPECS: Readonly<Record<Exclude<Kind, "dmn-table" | "dmn-literal">, Spec>> = {
  bpmn: {
    notation: "bpmn",
    file: "processes/order-to-cash.bpmn",
    shapes: ["Task_check_credit", "Task_validate_order", "Task_fulfill_order"],
    hold: ["Control"],
    create: "create.task",
    drop: { diagram: { x: 1060, y: 250 }, on: "Lane_order_management" },
    padOf: ["Task_check_credit", "Task_validate_order"],
    padEntry: "replace",
    popup: ".djs-popup.bpmn-replace",
    popupOff: { x: 0, y: 53 },
    entryPx: 22,
    editor: ".djs-direct-editing-parent",
  },
  dmn: {
    notation: "dmn",
    file: "processes/credit-limit-check.dmn",
    shapes: ["InputData_segment", "InputData_order_value", "InputData_overdue"],
    hold: ["Control"],
    create: "create.input-data",
    padOf: ["credit-limit-check"],
    padEntry: "replace",
    popup: ".djs-popup.dmn-replace",
    popupOff: { x: 0, y: 29 },
    entryPx: 22,
    editor: ".djs-direct-editing-parent",
  },
  wardley: {
    notation: "wardley",
    file: "processes/tea-shop.wmap",
    shapes: ["cmp_tea", "cmp_cup", "cmp_water", "cmp_hot_water"],
    hold: [],
    create: "create.component",
    padOf: ["cmp_tea", "cmp_cup", "cmp_water"],
    padEntry: "settings",
    popup: ".djs-popup.wardley-element-settings",
    popupOff: { x: 13.2, y: 13.4 },
    entryPx: 28,
    editor: "textarea.wardley-label-input",
  },
  "context-map": {
    notation: "context-map",
    file: "processes/order-fulfilment.cm.json",
    shapes: ["ctx_ordering", "ctx_catalog", "ctx_payment"],
    hold: [],
    create: "context.core",
    padOf: ["ctx_ordering", "ctx_catalog"],
    padEntry: "subdomain-type",
    popup: ".djs-popup.cm-subdomain-menu",
    popupOff: { x: 36, y: 0 },
    entryPx: 28,
    editor: ".djs-direct-editing-parent",
  },
};
const specOf = (kind: Kind): Spec => SPECS[kind === "dmn-table" || kind === "dmn-literal" ? "dmn" : kind];
const nodeOf = (kind: Kind): string => `m-${specOf(kind).notation}`;

const TABLE = "table.tjs-table";
const CELL = 'td[data-element-id="UnaryTests_blocked_value"]';
const HIT_POLICY = ".hit-policy-edit-policy-select .dms-input";
const OPTIONS = ".dms-select-options";
const DRILL = ".drill-down-overlay";
const LITERAL = ".dmn-literal-expression-container";
/** the expression's text field, and the block of fields below it (variable name and type) */
const LITERAL_TEXT = `${LITERAL} .literal-expression.textarea`;
const LITERAL_FIELDS = `${LITERAL} .literal-expression-properties`;

// ── what lies under a point ──────────────────────────────────────────────────

const MATCHES = (_host: HTMLElement, arg: { x: number; y: number; selector: string }): boolean => {
  const native = (window as NativeWindow).__boardSpikeNative;
  const element = native ? native.elementFromPoint(document, arg.x, arg.y) : document.elementFromPoint(arg.x, arg.y);
  return !!element?.closest(arg.selector);
};

/** a press at `at` reaches the node's editor AND lands on (or inside) `selector` */
async function takes(node: NodeHandle, at: Point, selector: string): Promise<boolean> {
  if (!(await node.hit(at)).reachable) return false;
  const map = await node.map();
  return node.inDocument(MATCHES, { x: (at.x - map.x) / map.sx, y: (at.y - map.y) / map.sy, selector });
}

type PointTest = (at: Point) => Promise<boolean>;

/**
 * Selects a shape with a click on a point of it that takes the press (the harness's own select
 * tries the middle only, which chrome that keeps its size covers at a low zoom).
 */
async function selectShape(node: NodeHandle, id: string): Promise<boolean> {
  if ((await node.selected()).includes(id)) return true;
  const at = await pointIn(node, await node.elementBox(id), onShape(node, id));
  if (!at) return false;
  await node.board.click(at);
  return (await node.board.waitFor(async () => (await node.selected()).includes(id), 1000)) === true;
}
const onShape =
  (node: NodeHandle, id: string): PointTest =>
  async (at) => {
    const hit = await node.hit(at);
    return hit.reachable && hit.element === id && !hit.pad && !hit.palette && !hit.popup;
  };
const onSelector =
  (node: NodeHandle, selector: string): PointTest =>
  (at) =>
    takes(node, at, selector);

const GRID = [0.5, 0.3, 0.7, 0.1, 0.9];
/** a point of `box` inside the window that passes `test`, the nearest to the box's middle; each at the centre of a px */
async function pointIn(node: NodeHandle, box: Box | null | undefined, test: PointTest): Promise<Point | null> {
  if (!box || !(box.width > 0) || !(box.height > 0)) return null;
  const map = await node.map();
  const view = node.board.page.viewportSize() ?? WINDOW;
  const middle = centre(box);
  const points = GRID.flatMap((fy) =>
    GRID.map((fx) => aimAt(map, { x: box.x + box.width * fx, y: box.y + box.height * fy })),
  ).sort((a, b) => Math.hypot(a.x - middle.x, a.y - middle.y) - Math.hypot(b.x - middle.x, b.y - middle.y));
  for (const point of points) {
    if (point.x < 1 || point.y < 1 || point.x > view.width - 1 || point.y > view.height - 1) continue;
    if (await test(point)) return point;
  }
  return null;
}

/** how many of what matches take a press at their middle */
async function pressable(node: NodeHandle, selector: string, within?: Box): Promise<{ total: number; take: number }> {
  const boxes = (await node.query(selector)).filter((box) => !within || holds(within, centre(box)));
  let take = 0;
  for (const box of boxes) if (await takes(node, centre(box), selector)) take++;
  return { total: boxes.length, take };
}

/** the topmost element at a page point belongs to the wrapper of that board node */
async function onWrapper(board: Board, nodeId: string, at: Point): Promise<boolean> {
  return board.page.evaluate(
    ([id, x, y]) => {
      const native = (window as NativeWindow).__boardSpikeNative;
      const top = native ? native.elementFromPoint(document, x, y) : document.elementFromPoint(x, y);
      return top?.closest(".react-flow__node")?.getAttribute("data-id") === id;
    },
    [nodeId, at.x, at.y] as const,
  );
}

/** a point of the bare pane near `prefer` (a click there disarms, a wheel there zooms the board) */
async function panePoint(board: Board, prefer: Point): Promise<Point> {
  const found = await board.page.evaluate(
    ([px0, py0]) => {
      const native = (window as NativeWindow).__boardSpikeNative;
      const pane = document.querySelector(".react-flow__pane");
      const flow = document.querySelector(".react-flow");
      if (!pane || !flow) return null;
      const box = native ? native.rect(flow) : flow.getBoundingClientRect();
      const candidates: Array<{ x: number; y: number }> = [];
      for (let y = box.top + 10; y < Math.min(box.bottom, window.innerHeight) - 8; y += 20) {
        for (let x = box.left + 10; x < Math.min(box.right, window.innerWidth) - 8; x += 20) candidates.push({ x, y });
      }
      candidates.sort((a, b) => Math.hypot(a.x - px0, a.y - py0) - Math.hypot(b.x - px0, b.y - py0));
      for (const { x, y } of candidates) {
        const top = native ? native.elementFromPoint(document, x, y) : document.elementFromPoint(x, y);
        if (top === pane) return { x, y };
      }
      return null;
    },
    [prefer.x, prefer.y] as const,
  );
  if (!found) throw new Unmeasured("the board shows no bare pane");
  return found;
}

/** runs in the node's document: where a diagram point lies in that document, through the browser's own matrix */
const DIAGRAM_POINT = (host: HTMLElement, at: Point): Point | null => {
  const group = host.querySelector<SVGGElement>("svg g.viewport");
  const native = (window as NativeWindow).__boardSpikeNative;
  const matrix = group ? (native ? native.screenCTM(group) : group.getScreenCTM()) : null;
  return matrix ? { x: matrix.a * at.x + matrix.e, y: matrix.d * at.y + matrix.f } : null;
};
async function diagramToScreen(node: NodeHandle, at: Point): Promise<Point | null> {
  const [local, map] = [await node.inDocument(DIAGRAM_POINT, at), await node.map()];
  return local && { x: map.x + local.x * map.sx, y: map.y + local.y * map.sy };
}
/** runs in the node's document: the origin of an element's graphics and a document point, both in diagram units */
const IN_DIAGRAM = (
  host: HTMLElement,
  arg: { id: string; at: Point | null },
): { box: Box | null; at: Point | null } => {
  const group = host.querySelector<SVGGElement>("svg g.viewport");
  const native = (window as NativeWindow).__boardSpikeNative;
  const matrix = group ? (native ? native.screenCTM(group) : group.getScreenCTM()) : null;
  if (!matrix) return { box: null, at: null };
  const visual = host.querySelector(`[data-element-id="${CSS.escape(arg.id)}"] > .djs-visual`);
  const rect = visual ? (native ? native.rect(visual) : visual.getBoundingClientRect()) : null;
  const unit = (x: number, y: number): Point => ({ x: (x - matrix.e) / matrix.a, y: (y - matrix.f) / matrix.d });
  return {
    box: rect ? { ...unit(rect.x, rect.y), width: rect.width / matrix.a, height: rect.height / matrix.d } : null,
    at: arg.at ? unit(arg.at.x, arg.at.y) : null,
  };
};
/** an element's box and a page point in diagram units: the same whatever the board zoom is */
async function inDiagram(
  node: NodeHandle,
  id: string,
  at: Point | null,
): Promise<{ box: Box | null; at: Point | null }> {
  const map = await node.map();
  return node.inDocument(IN_DIAGRAM, { id, at: at && { x: (at.x - map.x) / map.sx, y: (at.y - map.y) / map.sy } });
}

/** a bare spot of the armed editor's canvas near `prefer` (shares of the host), with bare surroundings */
async function bareCanvas(node: NodeHandle, prefer: Point): Promise<Point | null> {
  const [host, map, ids] = [await node.hostBox(), await node.map(), new Set(await node.elementIds())];
  const view = node.board.page.viewportSize() ?? WINDOW;
  const want = { x: host.x + host.width * prefer.x, y: host.y + host.height * prefer.y };
  const candidates: Point[] = [];
  for (let iy = 0; iy <= 6; iy++) {
    for (let ix = 0; ix <= 9; ix++) {
      const point = {
        x: host.x + host.width * (0.12 + (0.76 * ix) / 9),
        y: host.y + host.height * (0.12 + (0.76 * iy) / 6),
      };
      if (point.x > 8 && point.y > 8 && point.x < view.width - 60 && point.y < view.height - 60) candidates.push(point);
    }
  }
  candidates.sort((a, b) => Math.hypot(a.x - want.x, a.y - want.y) - Math.hypot(b.x - want.x, b.y - want.y));
  // on the diagram's own svg: a card or a palette that keeps its screen size lies over it at a low zoom
  const bare = async (point: Point): Promise<boolean> => {
    const hit = await node.hit(point);
    return (
      hit.reachable &&
      !hit.palette &&
      !hit.pad &&
      !hit.popup &&
      (hit.element === null || !ids.has(hit.element)) &&
      (await takes(node, point, ".djs-container svg"))
    );
  };
  // room for a shape around the spot: 40 x 30 px in a host of 800 px, less in a smaller one
  const room = Math.min(1, host.width / 800);
  for (const point of candidates.slice(0, 40)) {
    const around = [
      point,
      ...[-1, 1].flatMap((sx) => [-1, 1].map((sy) => ({ x: point.x + 40 * room * sx, y: point.y + 30 * room * sy }))),
    ];
    let free = true;
    for (const one of around) {
      if (!(await bare(one))) {
        free = false;
        break;
      }
    }
    if (free) return aimAt(map, point);
  }
  return null;
}

// ── arming ───────────────────────────────────────────────────────────────────

type Way = "shape" | "canvas" | "button" | "hook" | "url";
const WAYS: readonly Way[] = ["shape", "canvas", "button", "hook", "url"];
/** what the transition record names as the source of each way */
const SOURCE: Readonly<Record<Way, string>> = {
  shape: "pointer",
  canvas: "pointer",
  button: "button",
  hook: "hook",
  url: "url",
};

/** the Edit or Done button of a node's header: its box, its text, and whether its middle takes a press */
async function headerButton(board: Board, nodeId: string): Promise<{ box: Box; takes: boolean; text: string } | null> {
  return board.page.evaluate((id) => {
    const native = (window as NativeWindow).__boardSpikeNative;
    const button = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"] .board-node__arm`);
    if (!button) return null;
    const { x, y, width, height } = native ? native.rect(button) : button.getBoundingClientRect();
    const [cx, cy] = [x + width / 2, y + height / 2];
    const top = native ? native.elementFromPoint(document, cx, cy) : document.elementFromPoint(cx, cy);
    return {
      box: { x, y, width, height },
      takes: !!top && button.contains(top),
      text: (button.textContent ?? "").trim(),
    };
  }, nodeId);
}

/** where a double-click arms a preview: the middle of a shape (or of a table cell), or a spot of the body with no shape on it */
async function previewPoint(
  board: Board,
  node: NodeHandle,
  kind: Kind,
  way: "shape" | "canvas",
): Promise<{ at: Point; on: string }> {
  const g = await geometry(board, node.id);
  const view = board.page.viewportSize() ?? WINDOW;
  const seen: Box = {
    x: g.canvas.x + 2,
    y: g.canvas.y + g.band + 2,
    width: Math.min(g.canvas.width, view.width - g.canvas.x) - 4,
    height: Math.min(g.canvas.height, view.height - g.canvas.y) - g.band - 4,
  };
  const whole = (point: Point): Point => ({ x: Math.round(point.x), y: Math.round(point.y) });
  if (way === "shape") {
    const named: Array<[string, Box | null | undefined]> =
      kind === "dmn-table"
        ? [["a table cell", (await node.query(CELL))[0]]]
        : kind === "dmn-literal"
          ? [["the expression's text field", (await node.query(LITERAL_TEXT))[0]]]
          : await Promise.all(
              unique([...specOf(kind).shapes, ...specOf(kind).padOf]).map(
                async (id) => [id, await node.elementBox(id)] as [string, Box | null],
              ),
            );
    // a node larger than the window: any other element of it that is in the window
    const body = await node.hostBox();
    const [others, what] =
      kind === "dmn-table"
        ? [`${TABLE} tbody td`, "a table cell"]
        : kind === "dmn-literal"
          ? [`${LITERAL} .dms-input`, "a field of the expression"]
          : ["[data-element-id] > .djs-visual", "a shape"];
    const further = (await node.query(others))
      .filter((box) => box.width > 3 && box.width * box.height < 0.25 * body.width * body.height)
      .map((box) => [what, box] as [string, Box]);
    for (const [on, box] of [...named, ...further]) {
      if (!box) continue;
      const at = whole(centre(box));
      if (holds(seen, at) && (await onWrapper(board, node.id, at))) return { at, on };
    }
    throw new Unmeasured("no shape of the preview lies in the window");
  }
  const host = await node.hostBox();
  const html = kind === "dmn-table" || kind === "dmn-literal";
  const all = await node.query(
    kind === "dmn-table"
      ? TABLE
      : kind === "dmn-literal"
        ? `${LITERAL_TEXT}, ${LITERAL_FIELDS}`
        : "[data-element-id] > .djs-visual",
  );
  // a pool or a plot is the ground, not a shape
  const shapes = all.filter((box) => box.width * box.height < 0.4 * host.width * host.height || html);
  const want = { x: host.x + host.width * 0.85, y: host.y + host.height * 0.85 };
  const candidates: Point[] = [];
  for (let iy = 0; iy <= 22; iy++) {
    for (let ix = 0; ix <= 30; ix++) {
      candidates.push({
        x: host.x + host.width * (0.03 + (0.94 * ix) / 30),
        y: host.y + host.height * (0.03 + (0.94 * iy) / 22),
      });
    }
  }
  candidates.sort((a, b) => Math.hypot(a.x - want.x, a.y - want.y) - Math.hypot(b.x - want.x, b.y - want.y));
  for (const candidate of candidates) {
    const at = whole(candidate);
    const clear = shapes.every(
      (box) => !holds({ x: box.x - 1, y: box.y - 1, width: box.width + 2, height: box.height + 2 }, at),
    );
    if (clear && holds(seen, at) && (await onWrapper(board, node.id, at))) return { at, on: "the body, no shape" };
  }
  throw new Unmeasured("no bare spot of the preview lies in the window");
}

interface Arming {
  way: Way;
  /** where the pointer pressed, page px; null for the hook and the URL */
  pointer: Point | null;
  /** what the pointer was on */
  on: string;
  from: Viewport;
  before: Geometry;
  armed: boolean;
  viewport: Viewport;
  after: Geometry;
  /** the last move of the board this arming made, null when the board did not have to move */
  transition: ArmTransition | null;
  /** every move of the board this arming made: one arming is one move, unless the box changed under it */
  moves: ArmTransition[];
  frames: FrameSample[];
}

/**
 * Arms `nodeId` the given way and waits for the board to rest; frames are recorded from before the
 * gesture. `given`: the point of the preview a double-click goes to (default: a shape or a bare
 * spot that is searched).
 */
async function armBy(
  board: Board,
  node: NodeHandle,
  kind: Kind,
  way: Exclude<Way, "url">,
  given?: { at: Point; on: string },
): Promise<Arming> {
  const nodeId = node.id;
  let pointer: Point | null = null;
  let on = way === "hook" ? "hooks.arm" : "";
  if (way === "shape" || way === "canvas")
    ({ at: pointer, on } = given ?? (await previewPoint(board, node, kind, way)));
  if (way === "button") {
    const button = await headerButton(board, nodeId);
    if (!button || button.text !== "Edit") throw new Unmeasured("the node shows no Edit button");
    if (!button.takes)
      throw new Unmeasured(
        `the Edit button (${px(button.box.width)} x ${px(button.box.height)} px at x ${px(button.box.x, 0)}) takes no press: it lies at the right end of the header, outside the window or under the Files panel`,
      );
    pointer = centre(button.box);
    on = `the Edit button, ${px(button.box.width)} x ${px(button.box.height)} px`;
  }
  const [from, before] = [await board.viewport(), await geometry(board, nodeId)];
  const last = (await board.lastTransition())?.id ?? 0;
  await board.startFrames();
  if (way === "hook") await board.arm(nodeId);
  else if (way === "button") await board.click(pointer!);
  else await board.doubleClick(pointer!);
  const viewport = await board.waitForRest();
  const armed = (await board.armState()).armed === nodeId;
  if (armed) await waitShown(board, nodeId, 2000);
  if (armed && node.frame) await sleep(200);
  const frames = await board.stopFrames();
  const moves = (await board.transitions()).filter((one) => one.id > last);
  return {
    way,
    pointer: way === "button" ? null : pointer,
    on,
    from,
    before,
    armed,
    viewport,
    after: await geometry(board, nodeId),
    transition: moves[moves.length - 1] ?? null,
    moves,
    frames,
  };
}

/** how far the anchor of an arming (the pointer, else the node's centre) moved on the screen */
function anchorTravel(a: Arming): Point {
  const anchor = a.pointer ?? centre(a.before.wrapper!);
  const flow = {
    x: (anchor.x - a.before.canvas.x - a.from.x) / a.from.zoom,
    y: (anchor.y - a.before.canvas.y - a.from.y) / a.from.zoom,
  };
  return {
    x: a.after.canvas.x + a.viewport.x + flow.x * a.viewport.zoom - anchor.x,
    y: a.after.canvas.y + a.viewport.y + flow.y * a.viewport.zoom - anchor.y,
  };
}

/**
 * What an arming has to satisfy under `rule`: the zoom exactly, the viewport this script computes,
 * the wrapper in the box, a transition record that fits, and no armed frame at another zoom.
 */
function armingChecks(
  a: Arming,
  rule: ArmZoom,
  motion: number | null,
): { checks: Check[]; measured: Record<string, unknown>; key: string; volatile: Record<string, unknown> } {
  const wrapper = a.before.wrapper!;
  // a pointer is the anchor of a double-click; the Edit button, the hook and the URL zoom about the node's middle
  const anchor = a.pointer ?? centre(wrapper);
  const kind: AnchorKind = a.pointer ? "pointer" : "centre";
  const expected = expectViewport(a.from, a.before, wrapper, anchor, rule, kind);
  const zoomWanted = ruleZoom(a.from.zoom, rule);
  const moves = expected !== a.from;
  const at = a.viewport;
  const anchorMoved = anchorTravel(a);
  const lies = a.after.wrapper ? placed(a.after, a.after.wrapper, kind) : null;
  const facts = frameFacts(a.frames, at.zoom);
  const t = a.transition;
  const checks: Check[] = [
    check(
      "armed",
      a.armed,
      "broken",
      a.armed
        ? "armed at rest"
        : `not armed at rest${t?.interrupted ? ` (the move was interrupted by ${t.interruptedBy})` : ""}`,
    ),
    check(
      "zoom",
      at.zoom === zoomWanted,
      "broken",
      `board zoom ${at.zoom}, the rule ${rule} gives ${zoomWanted} from ${a.from.zoom}`,
    ),
    check(
      "viewport",
      Math.abs(at.x - expected.x) <= 1 && Math.abs(at.y - expected.y) <= 1,
      "broken",
      `the board stands at ${vp(at)}, computed here: ${vp(expected)}`,
    ),
  ];
  if (rule !== "off" && lies) {
    checks.push(
      check("in the box", lies.fits ? lies.inside >= 0.999 : lies.atMargin, "broken", `the wrapper is ${lies.text}`),
    );
  }
  checks.push(
    check(
      "transition",
      moves
        ? !!t &&
            t.purpose === "arm" &&
            t.by === SOURCE[a.way] &&
            !t.interrupted &&
            t.armed &&
            t.to.zoom === at.zoom &&
            t.anchor === kind &&
            (motion === null || t.askedMs === motion)
        : t === null,
      "broken",
      moves
        ? t
          ? `a move by ${t.by} (anchor ${t.anchor ?? "not named"}, this way of arming has the anchor ${kind}) from ${vp(t.from)} to ${vp(t.to)}, asked ${t.askedMs} ms, armed ${t.armed}, interrupted ${t.interrupted}`
          : "the board had to move and no transition is recorded"
        : t
          ? `nothing had to move, yet a transition to ${vp(t.to)} is recorded`
          : "nothing had to move, no transition",
    ),
    check(
      "frames",
      facts.armedOffZoom === 0 && facts.armedWhileMoving === 0 && facts.editorZooms.every((zoom) => zoom === at.zoom),
      "broken",
      `${facts.armedOffZoom} of ${facts.armed} armed frames at another board zoom than ${at.zoom}, ${facts.armedWhileMoving} armed while the board moved, the editor's view applied with zoom ${facts.editorZooms.join(", ") || "none read"}`,
    ),
    check(
      "one move",
      a.moves.length <= 1,
      "degraded",
      `${a.moves.length} move(s) of the board for one arming${a.moves.length > 1 ? `: ${a.moves.map((one) => vp(one.to)).join(" then ")}` : ""}`,
    ),
  );
  return {
    checks,
    measured: {
      way: a.way,
      anchorKind: kind,
      moves: a.moves.length,
      pointerOn: a.on,
      pointer: a.pointer && { x: a.pointer.x, y: a.pointer.y },
      viewportBefore: a.from,
      viewportAfter: at,
      viewportComputed: expected,
      boardBox: { width: px(a.after.canvas.width), height: px(a.after.canvas.height), toolbarBand: px(a.after.band) },
      wrapperAfter: a.after.wrapper && {
        x: px(a.after.wrapper.x - a.after.canvas.x),
        y: px(a.after.wrapper.y - a.after.canvas.y),
        width: px(a.after.wrapper.width),
        height: px(a.after.wrapper.height),
      },
      inBox: lies?.text ?? null,
      anchorMovedPx: { x: px(anchorMoved.x), y: px(anchorMoved.y) },
      transition: t && {
        by: t.by,
        anchor: t.anchor ?? null,
        from: t.from,
        to: t.to,
        askedMs: t.askedMs,
        interrupted: t.interrupted,
        interruptedBy: t.interruptedBy ?? null,
        armed: t.armed,
      },
      armedFramesAtAnotherZoom: facts.armedOffZoom,
      armedFramesWhileMoving: facts.armedWhileMoving,
      editorZooms: facts.editorZooms,
    },
    key: `${a.from.zoom} -> ${at.zoom}${moves ? ` at ${at.x},${at.y}` : ", no move"}, anchor ${pair(anchorMoved)} px`,
    volatile: {
      measuredMs: t ? px(t.measuredMs) : null,
      writes: t?.writes ?? null,
      frames: facts.frames,
      armedFrames: facts.armed,
      zoomSteps: facts.zoomSteps,
      flagsApartFrames: facts.flagsApart,
    },
  };
}

// ── gestures in the armed editor ─────────────────────────────────────────────

interface Did {
  verdict: "ok" | "degraded" | "broken";
  text: string;
  measured: Record<string, unknown>;
}
const didCheck = (name: string, did: Did, fails?: Check["fails"]): Check =>
  check(name, did.verdict === "ok", fails ?? (did.verdict === "degraded" ? "degraded" : "broken"), did.text);

/**
 * How far a shape is dragged, in diagram units: (44, 29) px in a node armed at board zoom 1. In px
 * the travel would grow with a falling zoom until the drop lands on another shape and is refused.
 */
const MOVE_UNITS = { x: 65, y: 43 };

/**
 * Drags a shape by `units` of the diagram and compares what it moved with what the pointer
 * travelled. `dropInReach` (R4, where the board is smaller than the node): a shape whose drop
 * would land under the toolbar or the Files panel is passed over, since the engine sees no target
 * there and puts the shape back, whatever the board does.
 */
async function moveShape(
  board: Board,
  node: NodeHandle,
  spec: Spec,
  units: Point = MOVE_UNITS,
  dropInReach = false,
): Promise<Did> {
  const view = board.page.viewportSize() ?? WINDOW;
  const host = await node.hostBox();
  const unit = (await node.diagramScale()) ?? 1;
  // the travel is the same in the diagram at every board zoom; at least 16 px, so that it is a drag
  const stretch = Math.max(1, 16 / Math.abs(units.x * unit));
  const delta = { x: units.x * unit * stretch, y: units.y * unit * stretch };
  const skipped: string[] = [];
  for (const id of spec.shapes) {
    const before = await node.elementBox(id);
    const at = await pointIn(node, before, onShape(node, id));
    if (!before || !at) {
      skipped.push(`${id}: ${before ? "takes no press" : "not drawn"}`);
      continue;
    }
    const to = { x: at.x + delta.x, y: at.y + delta.y };
    if (!holds(host, to, 24) || to.x > view.width - 4 || to.y > view.height - 4) {
      skipped.push(`${id}: no room to move`);
      continue;
    }
    if (dropInReach && !(await node.hit(to)).reachable) {
      skipped.push(`${id}: the drop would land outside the editor`);
      continue;
    }
    const text = await board.fileText(spec.file);
    const dragged = await node.drag(at, delta, { hold: spec.hold });
    const written = (await board.waitForFileChange(spec.file, text, WRITE_MS)) !== null;
    const after = await board.waitForBox(() => node.elementBox(id));
    // diagram-js swallows a click for 400 ms after a drag
    await sleep(450);
    if (!after) return { verdict: "broken", text: `move: ${id} is gone after the drag`, measured: { element: id } };
    const moved = { x: after.x - before.x, y: after.y - before.y };
    const slack = Math.max(2, 1.5 * unit);
    const exact = Math.abs(moved.x - dragged.delta.x) <= slack && Math.abs(moved.y - dragged.delta.y) <= slack;
    const ratio = { x: round(moved.x / dragged.delta.x, 2), y: round(moved.y / dragged.delta.y, 2) };
    return {
      verdict: exact && written ? "ok" : "broken",
      text: `move ${ratio.x.toFixed(2)}/${ratio.y.toFixed(2)}${written ? "" : ", file unchanged"}`,
      measured: {
        element: id,
        pointerPx: dragged.delta,
        movedPx: { x: px(moved.x), y: px(moved.y) },
        ratio,
        unitPx: round(unit, 3),
        fileChanged: written,
        skipped,
      },
    };
  }
  return { verdict: "broken", text: `move: no shape takes a press (${skipped.join("; ")})`, measured: { skipped } };
}

/** a spot of a BPMN lane in the window with nothing but that lane around it (half a task and a grid step each way) */
async function lanePoint(node: NodeHandle): Promise<Point | null> {
  const [host, map, unit] = [await node.hostBox(), await node.map(), (await node.diagramScale()) ?? 1];
  const view = node.board.page.viewportSize() ?? WINDOW;
  const canvas = await node.board.canvasBox();
  const [left, top] = [Math.max(host.x, canvas.x) + 140, Math.max(host.y, canvas.y) + 40];
  const right = Math.min(host.x + host.width, canvas.x + canvas.width, view.width) - 40;
  const bottom = Math.min(host.y + host.height, canvas.y + canvas.height, view.height) - 40;
  const clear = { x: 65 * unit, y: 55 * unit };
  for (let iy = 0; iy <= 8; iy++) {
    for (let ix = 10; ix >= 0; ix--) {
      const point = { x: left + ((right - left) * ix) / 10, y: top + ((bottom - top) * iy) / 8 };
      const lane = (await node.hit(point)).element;
      if (!lane?.startsWith("Lane_")) continue;
      const around = [-1, 1].flatMap((sx) =>
        [-1, 1].map((sy) => ({ x: point.x + clear.x * sx, y: point.y + clear.y * sy })),
      );
      let free = around.every(
        (one) => one.x > left - 100 && one.x < right + 30 && one.y > top - 30 && one.y < bottom + 30,
      );
      for (const one of free ? around : []) {
        const hit = await node.hit(one);
        if (!hit.reachable || hit.element !== lane) {
          free = false;
          break;
        }
      }
      if (free) return aimAt(map, point);
    }
  }
  return null;
}

/** drags the palette's create entry onto the canvas and compares where the new shape lies with the drop point */
async function createShape(board: Board, node: NodeHandle, spec: Spec): Promise<Did> {
  const selector = `.djs-palette .entry[data-action="${spec.create}"]`;
  const entry = (await node.query(selector))[0];
  const palette = await pressable(node, ".djs-palette .entry");
  const reach = `${palette.take}/${palette.total} palette entries`;
  if (!entry || !(await takes(node, centre(entry), selector))) {
    return { verdict: "broken", text: `create: the entry takes no press, ${reach}`, measured: { palette } };
  }
  let drop: Point | null;
  if (spec.drop) {
    drop = await diagramToScreen(node, spec.drop.diagram);
    const view = board.page.viewportSize() ?? WINDOW;
    const seen = !!drop && drop.x > 4 && drop.y > 4 && drop.x < view.width - 4 && drop.y < view.height - 4;
    const hit = drop && seen ? await node.hit(drop) : null;
    // a node larger than the window: any spot of a lane with room for a task around it
    if (!hit?.reachable || hit.element !== spec.drop.on) drop = await lanePoint(node);
  } else drop = await bareCanvas(node, { x: 0.72, y: 0.2 });
  if (!drop)
    return { verdict: "broken", text: `create: no bare spot of the canvas in reach, ${reach}`, measured: { palette } };
  const had = new Set(await node.elementIds());
  const unit = (await node.diagramScale()) ?? 1;
  const dragged = await node.paletteDrag(entry, drop);
  const created = await board.waitFor(
    async () => (await node.elementIds()).find((id) => !had.has(id)) ?? null,
    SHOW_MS,
  );
  // the shape's own box: its graphics may include a label beside it
  const box = created
    ? await board.waitForBox(
        async () =>
          (await node.query(`[data-element-id="${created}"] > .djs-hit`))[0] ?? (await node.elementBox(created)),
      )
    : null;
  // whatever the create opened (a label editor, a popup) is closed again
  await board.press("Escape");
  await sleep(450);
  if (!created || !box)
    return {
      verdict: "broken",
      text: `create: nothing was created, ${reach}`,
      measured: { palette, drop: dragged.to },
    };
  const off = { x: centre(box).x - dragged.to.x, y: centre(box).y - dragged.to.y };
  // a new shape snaps: half a 10 unit grid step, or 8 px of a renderer's own snapping
  const slack = Math.max(8, 6.5 * unit + 1.5);
  const exact = Math.abs(off.x) <= slack && Math.abs(off.y) <= slack;
  const all = palette.take === palette.total;
  return {
    verdict: !exact ? "broken" : all ? "ok" : "degraded",
    text: `create off ${pair(off)} px, ${reach}`,
    measured: { palette, created, dropPx: dragged.to, offPx: { x: px(off.x), y: px(off.y) }, slackPx: px(slack) },
  };
}

/** opens the popup of a shape's pad and compares where it lies with where it lies at net scale 1 */
async function openPopup(board: Board, node: NodeHandle, spec: Spec, keepOpen = false): Promise<Did & { popup?: Box }> {
  let target: string | null = null;
  for (const id of spec.padOf) {
    if (await selectShape(node, id)) {
      target = id;
      break;
    }
  }
  if (!target) return { verdict: "broken", text: "popup: no shape can be selected", measured: {} };
  const selector = `.djs-context-pad.open .entry[data-action="${spec.padEntry}"]`;
  const entry = await board.waitForBox(async () => (await node.query(selector))[0], SHOW_MS);
  const pad = await pressable(node, ".djs-context-pad.open .entry");
  const at = entry
    ? await pointIn(node, entry, async (point) => (await node.hit(point)).pad && (await takes(node, point, selector)))
    : null;
  if (!entry || !at) {
    return {
      verdict: "broken",
      text: `popup: the pad entry ${entry ? "takes no press" : "is not shown"}, ${pad.take}/${pad.total} pad entries`,
      measured: { element: target, pad },
    };
  }
  await board.click(at);
  const popup = await board.waitForBox(async () => (await node.query(spec.popup))[0], SHOW_MS);
  if (!popup) return { verdict: "broken", text: "popup: nothing opened", measured: { element: target, pad } };
  const scale = entry.width / spec.entryPx;
  const off = { x: popup.x - entry.x - spec.popupOff.x * scale, y: popup.y - entry.y - spec.popupOff.y * scale };
  const entries = await pressable(node, `${spec.popup} .entry`, popup);
  if (!keepOpen) {
    await board.press("Escape");
    await sleep(200);
  }
  const atAnchor =
    Math.abs(off.x) <= PLACE_TOL * Math.max(1, scale) && Math.abs(off.y) <= PLACE_TOL * Math.max(1, scale);
  const all = entries.take === entries.total && entries.total > 0 && pad.take === pad.total;
  return {
    verdict: atAnchor && all ? "ok" : "degraded",
    text: `popup ${pair(off)} px from its anchor, ${entries.take}/${entries.total} entries, ${pad.take}/${pad.total} pad entries`,
    measured: {
      element: target,
      pad,
      popupPx: { width: px(popup.width), height: px(popup.height) },
      offPx: { x: px(off.x), y: px(off.y) },
      entries,
      chromeScale: round(scale, 3),
    },
    popup,
  };
}

/** runs in the node's document: the focus is in a text field of the editor that is ready to be typed into */
const FOCUS_READY = (host: HTMLElement): boolean => {
  const active = document.activeElement;
  if (!active || !host.contains(active) || !active.matches("input, textarea, [contenteditable]")) return false;
  // a FEEL cell swaps its plain field for the code editor on focus
  return !active.closest(".feel-editor") || !!active.closest(".cm-content");
};
/** runs in the node's document: the text of the field that has the focus, "" when the focus is not in the editor */
const FIELD_TEXT = (host: HTMLElement): string => {
  const active = document.activeElement;
  if (!active || !host.contains(active)) return "";
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? active.value
    : (active.textContent ?? "");
};
const CLICK = (host: HTMLElement, selector: string): boolean => {
  const element = host.querySelector<HTMLElement>(selector);
  element?.click();
  return !!element;
};

/** opens the decision table from the DRD: with a real click on the drill-down button, or (prepare) with a script click */
async function openTable(
  board: Board,
  node: NodeHandle,
  byPointer: boolean,
): Promise<{ opened: boolean; pressed: boolean; button: string }> {
  const button = (await node.query(DRILL))[0];
  const size = button ? `${px(button.width)} x ${px(button.height)} px` : "none";
  if (byPointer) {
    const at = await pointIn(node, button, onSelector(node, DRILL));
    if (!at) return { opened: false, pressed: false, button: size };
    await board.click(at);
  } else if (!(await node.inDocument(CLICK, `${DRILL} button`))) return { opened: false, pressed: false, button: size };
  const opened =
    (await board.waitFor(async () => (await node.query(`.dmn-decision-table-container ${TABLE}`)).length > 0, 5000)) ===
    true;
  await sleep(400);
  return { opened, pressed: true, button: size };
}

/** clicks a cell of the decision table and types `text` over what it holds */
async function typeCell(board: Board, node: NodeHandle, text: string, replace = true): Promise<Did> {
  const [cell, host] = [(await node.query(CELL))[0], await node.hostBox()];
  const at = await pointIn(node, cell, onSelector(node, CELL));
  const shown = cell ? round(share(cell, host) * 100, 0) : 0;
  if (!cell || !at)
    return {
      verdict: "broken",
      text: `cell: takes no press (${shown} % of it in the host)`,
      measured: { cellShownPct: shown },
    };
  await board.click(at);
  await board.waitFor(() => node.inDocument(FOCUS_READY), SHOW_MS);
  await sleep(80);
  if (replace) await board.press("Control+A");
  await board.type(text);
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const written =
    (await board.waitFor(async () => ((await board.fileText(SPECS.dmn.file)) ?? "").includes(escaped), WRITE_MS)) ===
    true;
  return {
    verdict: written ? "ok" : "broken",
    text: `cell ${written ? "written" : "NOT written"} (${px(cell.width, 0)} x ${px(cell.height, 0)} px)`,
    measured: { cellPx: { width: px(cell.width), height: px(cell.height) }, cellShownPct: shown, written },
  };
}

/** opens the hit policy list and compares where it lies with its field; `pick` chooses Collect and looks into the file */
async function hitPolicy(board: Board, node: NodeHandle, pick: boolean): Promise<Did> {
  const field = (await node.query(HIT_POLICY))[0];
  const at = await pointIn(node, field, onSelector(node, HIT_POLICY));
  if (!field || !at) return { verdict: "broken", text: "hit policy: the field takes no press", measured: {} };
  await board.click(at);
  const options = await board.waitForBox(async () => (await node.query(OPTIONS))[0], SHOW_MS);
  if (!options) return { verdict: "broken", text: "hit policy: no list opened", measured: {} };
  const [below, above] = [options.y - (field.y + field.height), options.y + options.height - field.y];
  const off = { x: options.x - field.x, y: Math.abs(below) <= Math.abs(above) ? below : above };
  const entries = await pressable(node, `${OPTIONS} .option`);
  let picked: boolean | null = null;
  if (pick) {
    const option = (await node.query(`${OPTIONS} .option`))[4];
    const point = await pointIn(node, option, onSelector(node, `${OPTIONS} .option`));
    if (point) {
      await board.click(point);
      picked =
        (await board.waitFor(
          async () => /hitPolicy="COLLECT"/.test((await board.fileText(SPECS.dmn.file)) ?? ""),
          WRITE_MS,
        )) === true;
    } else picked = false;
  }
  if (picked !== true) {
    await board.press("Escape");
    await sleep(150);
  }
  // as in the DMN battery: the list at its field is ok. How many entries the node's body cuts off is in the text
  const atField = Math.abs(off.x) <= PLACE_TOL && Math.abs(off.y) <= PLACE_TOL;
  return {
    verdict: picked === false || entries.take === 0 ? "broken" : atField ? "ok" : "degraded",
    text: `list ${pair(off)} px from its field, ${entries.take}/${entries.total} entries${pick ? (picked ? ", Collect in the file" : ", NOT picked") : ""}`,
    measured: { offPx: { x: px(off.x), y: px(off.y) }, entries, picked },
  };
}

/** the first gestures a person makes in an armed editor: for a diagram a move, a create and a popup; for the table a cell and a list */
async function firstGestures(
  board: Board,
  node: NodeHandle,
  kind: Kind,
): Promise<{ checks: Check[]; key: string; measured: Record<string, unknown> }> {
  if (kind === "dmn-table") {
    const cell = await typeCell(board, node, "< 4711");
    const list = await hitPolicy(board, node, false);
    return {
      checks: [didCheck("cell", cell), didCheck("list", list)],
      key: `${cell.text}; ${list.text}`,
      measured: { cell: cell.measured, list: list.measured },
    };
  }
  const spec = specOf(kind);
  const move = await moveShape(board, node, spec);
  const create = await createShape(board, node, spec);
  const popup = await openPopup(board, node, spec);
  return {
    checks: [didCheck("move", move), didCheck("create", create), didCheck("popup", popup)],
    key: `${move.text}; ${create.text}; ${popup.text}`,
    measured: { move: move.measured, create: create.measured, popup: popup.measured },
  };
}

/** opens a label editor on a shape with a real double-click and types the marker; the shape's id, null when none opened */
async function openLabel(board: Board, node: NodeHandle, spec: Spec): Promise<string | null> {
  for (const id of spec.shapes) {
    const at = await pointIn(node, await node.elementBox(id), onShape(node, id));
    if (!at) continue;
    await board.doubleClick(at);
    const open = await board.waitFor(async () => (await node.query(spec.editor)).length > 0, 2000);
    if (!open) continue;
    await sleep(150);
    await board.type(MARKER);
    return id;
  }
  return null;
}

// ── what a test page starts as ───────────────────────────────────────────────

interface Rules {
  armzoom?: ArmZoom;
  armedzoom?: ArmedZoom;
  armreturn?: ArmReturn;
  armmotion?: number;
}

/** the matrix board with these notations (node ids m-<notation>), the first one at ORIGIN */
const matrix = (
  strategy: Strategy,
  notations: readonly ModelNotation[],
  zoom: number,
  rules: Rules,
  origin: Point = ORIGIN,
): BoardQuery => ({
  board: "matrix",
  strategy,
  notations,
  zoom,
  ...origin,
  ...rules,
});

/**
 * The DMN node showing its decision table instead of the DRD, as a preview at the viewport `at`:
 * armed by the hook, the table opened by a script click, disarmed, the viewport put back.
 */
async function showTable(board: Board, node: NodeHandle, at: Viewport): Promise<void> {
  await board.arm(node.id);
  const opened = await openTable(board, node, false);
  if (!opened.opened) throw new Unmeasured("the decision table did not open (prepare)");
  await board.arm(null);
  await waitShown(board, null);
  await board.setViewport(at);
  await board.waitForRest();
  await frame(board, 2);
}

/** an engine handle as hooks.engine(nodeId) hands it out, as far as this script reads it */
interface EngineHooks {
  engine(id: string): { engine?: { diagram(): { get(name: string): unknown } | null | undefined } } | undefined;
}
/** in-page strategies: the sample's one decision made a literal expression through the DRD's own replace service */
const TO_LITERAL = (arg: { key: string; node: string; element: string }): boolean => {
  const hooks = (window as unknown as Record<string, EngineHooks | undefined>)[arg.key];
  const diagram = hooks?.engine(arg.node)?.engine?.diagram();
  if (!diagram) return false;
  const registry = diagram.get("elementRegistry") as { get(id: string): unknown };
  const replace = diagram.get("drdReplace") as { replaceElement(element: unknown, target: unknown): unknown };
  replace.replaceElement(registry.get(arg.element), { type: "dmn:Decision", table: false, expression: true });
  return true;
};

/**
 * The DMN node showing a literal expression, as a preview at the viewport `at`. The sample has no
 * such decision: armed by the hook, its one decision is replaced through the engine, the view is
 * opened by a script click, the node disarmed and the viewport put back. All of it is preparation.
 */
async function showLiteral(board: Board, node: NodeHandle, at: Viewport): Promise<void> {
  if (node.frame) throw new Unmeasured("the literal expression is prepared through the page's engine: not in a frame");
  await board.arm(node.id);
  const replaced = await board.page.evaluate(TO_LITERAL, {
    key: HOOKS_KEY,
    node: node.id,
    element: "credit-limit-check",
  });
  const made =
    replaced &&
    (await board.waitFor(async () => /<literalExpression/.test((await board.fileText(SPECS.dmn.file)) ?? ""), 5000));
  if (!made) throw new Unmeasured("the decision did not become a literal expression (prepare)");
  await sleep(300);
  if (!(await node.inDocument(CLICK, `${DRILL} button`))) throw new Unmeasured("no drill-down button (prepare)");
  const opened = await board.waitFor(async () => (await node.query(LITERAL_TEXT)).length > 0, 8000);
  if (!opened) throw new Unmeasured("the literal expression did not open (prepare)");
  await sleep(400);
  await board.arm(null);
  await waitShown(board, null);
  await board.setViewport(at);
  await board.waitForRest();
  await frame(board, 2);
}

/** every model file's text and the board file's: to see that nothing was written */
async function texts(board: Board): Promise<Record<string, string>> {
  const out: Record<string, string> = { "(board file)": await board.boardText() };
  for (const file of await board.files()) {
    if (file.kind === "model") out[file.path] = (await board.fileText(file.path)) ?? "";
  }
  return out;
}
const changed = (before: Record<string, string>, now: Record<string, string>): string[] =>
  Object.keys(before).filter((path) => before[path] !== now[path]);

// ── R1 arm-from-zoom (and its rows on other strategies, R9) ──────────────────

const R1_ZOOMS = [0.1, 0.25, 0.5, 0.73, 0.9, 0.98, 0.999, 1, 1.001, 1.02, 1.5, 2, 4];
const ARM_ZOOMS: readonly ArmZoom[] = ["min1", "exact1", "off"];

/** `origin`: where the node's corner sits at the start (default ORIGIN); `room`: the node has room on all sides, so the anchor has to stay */
interface R1Options {
  origin?: Point;
  dpr?: number;
  room?: boolean;
  note?: string;
}

function r1(
  kind: Kind,
  strategy: Strategy,
  rules: Rules,
  zoom: number,
  way: Way,
  caseName = "R1 arm-from-zoom",
  options: R1Options = {},
): Task {
  const policy = policyText(rules);
  const origin = options.origin ?? ORIGIN;
  const opening: OpenOptions = options.dpr === undefined ? {} : { dpr: options.dpr };
  return {
    case: caseName,
    id: `${caseName.split(" ")[0]}|${kind}|${strategy}|${policy}|${way}|${zoom}${options.note ? `|${options.note}` : ""}`,
    notation: kind,
    strategy,
    policy,
    async run(ctx) {
      const [spec, id] = [specOf(kind), nodeOf(kind)];
      const query = matrix(strategy, [spec.notation], zoom, rules, origin);
      let board: Board;
      let arming: Arming;
      let before: Record<string, string>;
      if (way === "url") {
        // what a page without `arm=` has: the files, the viewport, the node's place
        const plain = await ctx.open(query, opening);
        before = await texts(plain);
        const [from, g] = [await plain.viewport(), await geometry(plain, id)];
        await plain.close();
        board = await ctx.open({ ...query, arm: id }, { ...opening, wait: false });
        await board.page.waitForFunction((key) => key in window, HOOKS_KEY, { timeout: 30_000, polling: 20 });
        await board.startFrames();
        await board.waitReady();
        const viewport = await board.waitForRest();
        const armed = (await board.armState()).armed === id;
        if (armed) await waitShown(board, id, 2000);
        const frames = await board.stopFrames();
        arming = {
          way,
          pointer: null,
          on: "arm= in the URL",
          from,
          before: g,
          armed,
          viewport,
          after: await geometry(board, id),
          transition: await board.lastTransition(),
          moves: await board.transitions(),
          frames,
        };
      } else {
        board = await ctx.open(query, opening);
        const prepared = await board.node(id);
        if (kind === "dmn-table") await showTable(board, prepared, { ...origin, zoom });
        before = await texts(board);
        arming = await armBy(board, prepared, kind, way);
      }
      const node = await board.node(id);
      const policyNow = (await board.armPolicy(id))!;
      const a = armingChecks(arming, policyNow.armzoom, policyNow.motion);
      const written = changed(before, await texts(board));
      const mounts = (await board.counters()).mounts[id] ?? 0;
      const checks = [
        ...a.checks,
        check(
          "files",
          written.length === 0,
          "wrong-data",
          written.length === 0
            ? "the model files and the board file are byte for byte as before the arming"
            : `written by the arming: ${written.join(", ")}`,
        ),
        check("mounts", mounts === 1, "degraded", `${mounts} engine mount(s)`),
        check(
          "policy",
          policyNow.margin === MARGIN &&
            policyNow.tolerance === NEARLY_ONE &&
            (rules.armzoom === undefined || policyNow.armzoom === rules.armzoom),
          "broken",
          `the page says ${policyNow.armzoom} / ${policyNow.armedzoom} / ${policyNow.armreturn}, margin ${policyNow.margin}, tolerance ${policyNow.tolerance}, motion ${policyNow.motion} ms from ${policyNow.motionFrom}`,
        ),
      ];
      // does the person still point at what they double-clicked
      const under =
        arming.armed && arming.pointer && way === "shape" && kind !== "dmn-table"
          ? (await node.hit(arming.pointer)).element === arming.on
          : null;
      if (options.room) {
        // with room on all sides nothing has to be shifted: what the person pointed at stays under the pointer
        const moved = a.measured.anchorMovedPx as Point;
        checks.push(
          check(
            "anchor",
            Math.hypot(moved.x, moved.y) <= 1 && under !== false,
            "degraded",
            `the point under the pointer moved ${pair(moved, 1)} px${under === null ? "" : under ? ", the shape is still under the pointer" : ", the shape is no longer under the pointer"}`,
          ),
        );
      }
      let gestures: Awaited<ReturnType<typeof firstGestures>> | null = null;
      if (arming.armed) {
        gestures = await firstGestures(board, node, kind);
        checks.push(...gestures.checks);
      }
      return {
        zoomAsked: zoom,
        zoomInEffect: arming.viewport.zoom,
        key: `${a.key}; ${gestures?.key ?? "not armed"}`,
        checks,
        measured: {
          ...a.measured,
          policy: { ...policyNow, motion: undefined },
          shapeStillUnderPointer: under,
          mounts,
          filesWritten: written,
          gestures: gestures?.measured ?? null,
        },
        volatile: { ...a.volatile, askedMs: policyNow.motion },
      };
    },
  };
}

// ── R2 preview against armed ─────────────────────────────────────────────────

/** `armzoom` undefined: the default of the node's strategy (an overlay node: exact1), named by no parameter */
function r2(kind: Kind, strategy: Strategy, armzoom: ArmZoom | undefined, zoom: number): Task {
  const rules: Rules = armzoom === undefined ? {} : { armzoom };
  return {
    case: "R2 preview-vs-armed",
    id: `R2|${kind}|${strategy}|${armzoom ?? "default"}|${zoom}`,
    notation: kind,
    strategy,
    policy: policyText(rules),
    async run(ctx) {
      const [spec, id] = [specOf(kind), nodeOf(kind)];
      const board = await ctx.open(matrix(strategy, [spec.notation], zoom, rules));
      const node = await board.node(id);
      if (kind === "dmn-table") await showTable(board, node, { ...ORIGIN, zoom });
      if (kind === "dmn-literal") await showLiteral(board, node, { ...ORIGIN, zoom });
      const rule = (await board.armPolicy(id))!.armzoom;
      const selector =
        kind === "dmn-table"
          ? `${TABLE} tbody td`
          : kind === "dmn-literal"
            ? LITERAL_TEXT
            : "[data-element-id] > .djs-visual";
      // what the person looks at before the arming: the preview at the zoom asked for
      const start = {
        all: await node.query(selector),
        fields: kind === "dmn-literal" ? ((await node.query(LITERAL_FIELDS))[0] ?? null) : null,
        table: kind === "dmn-table" ? ((await node.query(TABLE))[0] ?? null) : null,
        host: await node.hostBox(),
      };
      // a node larger than the window may show no shape of its preview: then a spot of its body
      const inWindow = await previewPoint(board, node, kind, "shape").then(
        () => true,
        () => false,
      );
      const arming = await armBy(board, node, kind, inWindow ? "shape" : "canvas");
      if (!arming.armed) throw new Unmeasured("the node did not arm");
      const at = arming.viewport;
      const view = board.page.viewportSize() ?? WINDOW;
      const host = await node.hostBox();
      // the body as far as the window shows it, 8 px in: the node's border and its four connection
      // handles (shown on a preview, not on an armed node) lie on the body's edge and are no part of the picture
      const inset = 8;
      const clip: Box = {
        x: Math.ceil(Math.max(host.x, arming.after.canvas.x)) + inset,
        y: Math.ceil(Math.max(host.y, arming.after.canvas.y)) + inset,
        width: 0,
        height: 0,
      };
      clip.width =
        Math.floor(Math.min(host.x + host.width, arming.after.canvas.x + arming.after.canvas.width, view.width)) -
        inset -
        clip.x;
      clip.height =
        Math.floor(Math.min(host.y + host.height, arming.after.canvas.y + arming.after.canvas.height, view.height)) -
        inset -
        clip.y;
      // the element whose jump is measured: the first small one whose middle lies well inside what is seen
      const all = await node.query(selector);
      const small = (box: Box): boolean => box.width * box.height < 0.25 * host.width * host.height && box.width > 4;
      const first = all.findIndex((box) => small(box) && holds(clip, centre(box), 30));
      // a node larger than the window: whatever element has its middle in what is seen
      const index = first >= 0 ? first : all.findIndex((box) => box.width > 4 && holds(clip, centre(box), 4));
      if (index < 0) throw new Unmeasured("no element of the armed editor lies in the window");
      const read = async (): Promise<{ element: Box; fields: Box | null; table: Box | null; host: Box }> => ({
        element: (await node.query(selector))[index]!,
        fields: kind === "dmn-literal" ? ((await node.query(LITERAL_FIELDS))[0] ?? null) : null,
        table: kind === "dmn-table" ? ((await node.query(TABLE))[0] ?? null) : null,
        host: await node.hostBox(),
      });
      const picture = async (name: string): Promise<Picture> =>
        decodePng(readFileSync(await ctx.shot(board, name, clip)));
      const press = async (label: "Done" | "Edit"): Promise<string> => {
        const button = await headerButton(board, id);
        const inBoard = !!button && holds(arming.after.canvas, centre(button.box)) && centre(button.box).x < view.width;
        if (button && button.text === label && button.takes && inBoard) {
          await board.click(centre(button.box));
          return "button";
        }
        await board.arm(label === "Done" ? null : id);
        return "hook";
      };
      await board.move({ x: clip.x + clip.width - 3, y: clip.y + clip.height - 3 });
      await sleep(250);
      const armed1 = await read();
      const shotArmed1 = await picture("armed-1");
      const doneBy = await press("Done");
      await board.waitForRest();
      await waitShown(board, null);
      await board.move({ x: clip.x + clip.width - 3, y: clip.y + clip.height - 3 });
      await sleep(300);
      const preview = await read();
      const shotPreview = await picture("preview");
      const editBy = await press("Edit");
      const again = await board.waitForRest();
      await waitShown(board, id);
      await board.move({ x: clip.x + clip.width - 3, y: clip.y + clip.height - 3 });
      await sleep(300);
      const armed2 = await read();
      const shotArmed2 = await picture("armed-2");
      // the chrome an armed editor shows and a preview hides is no jump of the picture
      // (the palette, a pad, the DRD's card with the model's name)
      const masks = await node.query(".djs-palette, .djs-context-pad, .dmn-definitions");
      const pixels = comparePictures(shotPreview, shotArmed2, clip, masks);
      const raw = comparePictures(shotPreview, shotArmed2, clip, []);
      const twice = comparePictures(shotArmed1, shotArmed2, clip, masks);
      const jump = { x: armed2.element.x - preview.element.x, y: armed2.element.y - preview.element.y };
      const far = Math.hypot(jump.x, jump.y);
      const size = armed2.element.width / preview.element.width - 1;
      const seen = (state: { table: Box | null; host: Box }): number | null =>
        state.table ? round(share(state.table, state.host) * 100, 1) : null;
      const moved = again.x !== at.x || again.y !== at.y || again.zoom !== at.zoom;
      // round 6: what the person sees when the arming moves the board, and on the disarm
      const from = start.all[index] ?? null;
      const travel = from && {
        x: centre(armed1.element).x - centre(from).x,
        y: centre(armed1.element).y - centre(from).y,
      };
      const factor = from && from.width > 0 ? armed1.element.width / from.width : null;
      const back = { x: preview.element.x - armed1.element.x, y: preview.element.y - armed1.element.y };
      const point = arming.pointer ? anchorTravel(arming) : null;
      const fieldsJump =
        armed2.fields && preview.fields
          ? { x: armed2.fields.x - preview.fields.x, y: armed2.fields.y - preview.fields.y }
          : null;
      const fieldsTravel =
        armed1.fields && start.fields
          ? { x: centre(armed1.fields).x - centre(start.fields).x, y: centre(armed1.fields).y - centre(start.fields).y }
          : null;
      const fieldsBack =
        armed1.fields && preview.fields
          ? { x: preview.fields.x - armed1.fields.x, y: preview.fields.y - armed1.fields.y }
          : null;
      const checks = [
        check(
          "zoom",
          at.zoom === ruleZoom(zoom, rule),
          "broken",
          `armed at board zoom ${at.zoom}, the rule ${rule} gives ${ruleZoom(zoom, rule)}`,
        ),
        check(
          "again",
          !moved,
          "broken",
          moved
            ? `Done and Edit moved the board from ${vp(at)} to ${vp(again)}`
            : "Done and Edit left the board where it stood",
        ),
        check(
          "jump",
          far <= 1,
          far <= 3 ? "degraded" : "broken",
          `the element lies ${pair(jump, 1)} px from where its preview showed it (ok up to 1 px, degraded up to 3)`,
        ),
        check(
          "size",
          Math.abs(size) <= 0.01,
          "broken",
          `the element is ${px(armed2.element.width)} px wide armed and ${px(preview.element.width)} px as a preview (${round(size * 100, 1)} %; ok within 1 %)`,
        ),
        check(
          "pixels",
          pixels.differing <= 0.5,
          pixels.differing <= 3 ? "degraded" : "broken",
          `${pixels.differing} % of the body's pixels differ between preview and armed editor, the armed chrome masked (ok up to 0.5 %, degraded up to 3 %); ${pixels.inked} % of the drawn pixels`,
        ),
        check(
          "twice",
          twice.differing <= 0.1 &&
            Math.hypot(armed2.element.x - armed1.element.x, armed2.element.y - armed1.element.y) <= 0.5,
          "degraded",
          `${twice.differing} % of the pixels differ between the first and the second arming`,
        ),
      ];
      if (fieldsJump) {
        const fieldsFar = Math.hypot(fieldsJump.x, fieldsJump.y);
        checks.push(
          check(
            "fields",
            fieldsFar <= 1,
            fieldsFar <= 3 ? "degraded" : "broken",
            `the block of fields below the expression lies ${pair(fieldsJump, 1)} px from where its preview showed it (ok up to 1 px, degraded up to 3)`,
          ),
        );
      }
      const table =
        kind === "dmn-table" ? `, table ${seen(armed2)} % in view armed, ${seen(preview)} % as a preview` : "";
      const fields = fieldsJump ? `, fields block jump ${pair(fieldsJump, 1)} px` : "";
      const more = [
        `the double-click on ${arming.on}`,
        point ? `its point moved ${px(Math.hypot(point.x, point.y))} px` : "",
        travel
          ? `on arming the element travels ${px(Math.hypot(travel.x, travel.y))} px (${pair(travel, 1)}) and is x${round(factor ?? 0, 3)} as wide`
          : "the element was not drawn before the arming",
        `on disarming it moves ${pair(back, 1)} px`,
        fieldsTravel && fieldsBack
          ? `the fields block travels ${px(Math.hypot(fieldsTravel.x, fieldsTravel.y))} px on arming and moves ${pair(fieldsBack, 1)} px on disarming`
          : "",
        start.table ? `table ${seen(start)} % in view before the arming` : "",
      ]
        .filter(Boolean)
        .join("; ");
      return {
        zoomAsked: zoom,
        zoomInEffect: at.zoom,
        key: `jump ${pair(jump, 1)} px, size ${round(size * 100, 1)} %, pixels ${pixels.differing} %${table}${fields}`,
        more,
        checks,
        measured: {
          viewport: at,
          viewportBefore: arming.from,
          armedOn: arming.on,
          moves: arming.moves.length,
          elementIndex: index,
          beforeArmingPx: from && {
            x: px(from.x),
            y: px(from.y),
            width: px(from.width),
            height: px(from.height),
          },
          previewPx: {
            x: px(preview.element.x),
            y: px(preview.element.y),
            width: px(preview.element.width),
            height: px(preview.element.height),
          },
          armedPx: {
            x: px(armed2.element.x),
            y: px(armed2.element.y),
            width: px(armed2.element.width),
            height: px(armed2.element.height),
          },
          jumpPx: { x: px(jump.x), y: px(jump.y) },
          jumpPctOfBodyWidth: round((far / host.width) * 100, 2),
          sizeChangePct: round(size * 100, 2),
          pointMovedOnArmingPx: point && { x: px(point.x), y: px(point.y) },
          travelOnArmingPx: travel && { x: px(travel.x), y: px(travel.y) },
          widthFactorOnArming: factor === null ? null : round(factor, 4),
          moveOnDisarmingPx: { x: px(back.x), y: px(back.y) },
          fieldsJumpPx: fieldsJump && { x: px(fieldsJump.x), y: px(fieldsJump.y) },
          fieldsTravelOnArmingPx: fieldsTravel && { x: px(fieldsTravel.x), y: px(fieldsTravel.y) },
          fieldsMoveOnDisarmingPx: fieldsBack && { x: px(fieldsBack.x), y: px(fieldsBack.y) },
          pixelsDifferingPct: pixels.differing,
          drawnPixelsDifferingPct: pixels.inked,
          pixelsDifferingUnmaskedPct: raw.differing,
          armedTwicePct: twice.differing,
          tableInViewArmedPct: seen(armed2),
          tableInViewPreviewPct: seen(preview),
          tableInViewBeforeArmingPct: seen(start),
          tablePx: armed2.table && { armed: px(armed2.table.width), preview: px(preview.table?.width ?? 0) },
          comparedPx: { width: clip.width, height: clip.height },
          doneBy,
          editBy,
        },
      };
    },
  };
}

// ── R3 what below 1 was wrong ────────────────────────────────────────────────

type Symptom = "palette" | "pad" | "table-open-cell" | "hit-policy" | "drd-shape" | "cm-shape";
const SYMPTOM_KIND: Readonly<Record<Symptom, Kind>> = {
  palette: "bpmn",
  pad: "bpmn",
  "table-open-cell": "dmn",
  "hit-policy": "dmn",
  "drd-shape": "dmn",
  "cm-shape": "context-map",
};

function r3(symptom: Symptom, strategy: Strategy, zoom: number, off: boolean): Task {
  const rules: Rules = off ? { armzoom: "off", armedzoom: "free" } : {};
  const kind = SYMPTOM_KIND[symptom];
  return {
    case: "R3 below-one",
    id: `R3|${symptom}|${strategy}|${policyText(rules)}|${zoom}`,
    notation: kind,
    strategy,
    policy: policyText(rules),
    async run(ctx) {
      const [spec, id] = [specOf(kind), nodeOf(kind)];
      const board = await ctx.open(matrix(strategy, [spec.notation], zoom, rules));
      const node = await board.node(id);
      const arming = await armBy(board, node, kind, "shape");
      const at = arming.viewport;
      const checks = [
        check("armed", arming.armed, "broken", arming.armed ? `armed at board zoom ${at.zoom}` : "not armed"),
      ];
      const measured: Record<string, unknown> = { viewport: at, hostPx: await node.hostSize() };
      if (!arming.armed) return { zoomAsked: zoom, zoomInEffect: at.zoom, key: "not armed", checks, measured };
      let key: string;
      if (symptom === "palette") {
        const palette = await pressable(node, ".djs-palette .entry");
        checks.push(
          check(
            "palette",
            palette.take === palette.total && palette.total > 0,
            palette.take === 0 ? "broken" : "degraded",
            `${palette.take} of ${palette.total} palette entries take a press`,
          ),
        );
        key = `${palette.take}/${palette.total} palette entries`;
        measured.palette = palette;
      } else if (symptom === "pad") {
        let target: string | null = null;
        for (const shape of spec.padOf) {
          if (await selectShape(node, shape)) {
            target = shape;
            break;
          }
        }
        if (target) await board.waitForBox(async () => (await node.query(".djs-context-pad.open .entry"))[0], SHOW_MS);
        const pad = target ? await pressable(node, ".djs-context-pad.open .entry") : { total: 0, take: 0 };
        checks.push(
          check(
            "pad",
            !!target && pad.take === pad.total && pad.total > 0,
            !target || pad.take === 0 ? "broken" : "degraded",
            target ? `${pad.take} of ${pad.total} pad entries of ${target} take a press` : "no shape can be selected",
          ),
        );
        key = target ? `${pad.take}/${pad.total} pad entries` : "no shape can be selected";
        measured.pad = { element: target, ...pad };
      } else if (symptom === "table-open-cell" || symptom === "hit-policy") {
        const opened = await openTable(board, node, true);
        measured.drillDown = opened;
        checks.push(
          check(
            "open",
            opened.opened,
            "broken",
            opened.pressed
              ? opened.opened
                ? `a click on the drill-down button (${opened.button}) opened the table`
                : "the click opened nothing"
              : `the drill-down button (${opened.button}) takes no press`,
          ),
        );
        key = opened.opened
          ? "table opened by pointer"
          : `drill-down ${opened.pressed ? "opened nothing" : "takes no press"}`;
        if (opened.opened) {
          const [table, host] = [(await node.query(TABLE))[0], await node.hostBox()];
          measured.tableInViewPct = table ? round(share(table, host) * 100, 1) : null;
          const cells = await pressable(node, `${TABLE} tbody td`);
          measured.bodyCells = cells;
          const did =
            symptom === "hit-policy" ? await hitPolicy(board, node, true) : await typeCell(board, node, "< 4711");
          checks.push(didCheck(symptom === "hit-policy" ? "list" : "cell", did));
          key += `, ${measured.tableInViewPct} % in view, ${cells.take}/${cells.total} cells; ${did.text}`;
          measured.did = did.measured;
        }
      } else {
        const shapes = unique([...spec.shapes, ...spec.padOf]);
        let take = 0;
        for (const shape of shapes) {
          if (await pointIn(node, await node.elementBox(shape), onShape(node, shape))) take++;
        }
        const move = await moveShape(board, node, spec);
        checks.push(
          check(
            "shapes",
            take === shapes.length,
            take === 0 ? "broken" : "degraded",
            `${take} of ${shapes.length} shapes take a press`,
          ),
          didCheck("move", move),
        );
        key = `${take}/${shapes.length} shapes take a press; ${move.text}`;
        measured.shapes = { take, total: shapes.length };
        measured.move = move.measured;
      }
      return { zoomAsked: zoom, zoomInEffect: at.zoom, key, checks, measured };
    },
  };
}

// ── R4 a node larger than the window ─────────────────────────────────────────

type NodeSize = "800x540" | "940x540" | "1600x1000";
interface Size {
  width: number;
  height: number;
}
const R4_WINDOWS: readonly Size[] = [
  { width: 2200, height: 1300 },
  { width: 1280, height: 720 },
  { width: 1100, height: 650 },
  { width: 1000, height: 600 },
  { width: 800, height: 500 },
  { width: 640, height: 360 },
  { width: 500, height: 400 },
];
const R4_SIZES: readonly NodeSize[] = ["800x540", "940x540", "1600x1000"];
type R4Way = "dbl-upper-left" | "dbl-middle" | "dbl-lower-right" | "button" | "hook";
const R4_WAYS: readonly R4Way[] = ["dbl-upper-left", "dbl-middle", "dbl-lower-right", "button", "hook"];
/** where a double-click of R4 lands in the node's wrapper, as shares of its width and height */
const R4_PART: Readonly<Record<Exclude<R4Way, "button" | "hook">, Point>> = {
  "dbl-upper-left": { x: 0.2, y: 0.25 },
  "dbl-middle": { x: 0.5, y: 0.5 },
  "dbl-lower-right": { x: 0.85, y: 0.85 },
};

/** what the window shows of the board's own box */
const seenBox = (g: Geometry, view: Size): Box => ({
  x: g.canvas.x,
  y: g.canvas.y,
  width: Math.min(g.canvas.width, view.width - g.canvas.x),
  height: Math.min(g.canvas.height, view.height - g.canvas.y),
});

/** a whole px of the node's wrapper that the node itself takes, in the board below the toolbar's band, the nearest to `prefer` */
async function wrapperPoint(board: Board, nodeId: string, prefer: Point): Promise<Point | null> {
  const g = await geometry(board, nodeId);
  if (!g.wrapper) return null;
  const seen = seenBox(g, board.page.viewportSize() ?? WINDOW);
  const left = Math.max(g.wrapper.x, seen.x) + 2;
  const right = Math.min(g.wrapper.x + g.wrapper.width, seen.x + seen.width) - 2;
  const top = Math.max(g.wrapper.y, seen.y + g.band) + 2;
  const bottom = Math.min(g.wrapper.y + g.wrapper.height, seen.y + seen.height) - 2;
  if (right <= left || bottom <= top) return null;
  const want = {
    x: Math.round(Math.min(right, Math.max(left, prefer.x))),
    y: Math.round(Math.min(bottom, Math.max(top, prefer.y))),
  };
  const grid = GRID.flatMap((fy) =>
    GRID.map((fx) => ({ x: Math.round(left + (right - left) * fx), y: Math.round(top + (bottom - top) * fy) })),
  ).sort((a, b) => Math.hypot(a.x - want.x, a.y - want.y) - Math.hypot(b.x - want.x, b.y - want.y));
  for (const point of [want, ...grid]) if (await onWrapper(board, nodeId, point)) return point;
  return null;
}

/** the two ways out of an armed node that are buttons: the toolbar's Done control and the header's own Done */
interface WayOut {
  /** the toolbar's control is switched on for this node and takes a press at its middle */
  controlTakes: boolean;
  controlUnder: string;
  band: number;
  headerDone: { x: number; right: number; y: number; takes: boolean } | null;
  /** the header's Done takes a press at its middle and lies in what the window shows of the board */
  headerInReach: boolean;
}
async function wayOut(board: Board, nodeId: string, seen: Box): Promise<WayOut> {
  const control = await board.doneControl();
  const button = await headerButton(board, nodeId);
  const done = button && button.text === "Done" ? button : null;
  return {
    controlTakes: control.takesPress && control.nodeId === nodeId,
    controlUnder: control.under,
    band: control.band,
    headerDone: done && {
      x: px(done.box.x),
      right: px(done.box.x + done.box.width),
      y: px(done.box.y),
      takes: done.takes,
    },
    headerInReach: !!done && done.takes && holds(seen, centre(done.box)),
  };
}

interface Pressed {
  /** the control took a press for this node */
  takes: boolean;
  /** after a real click on it the node is a preview: nothing armed at runtime, in the DOM or in the overlay layer */
  preview: boolean;
  under: string;
}
/** ends the editing with a REAL click on the toolbar's Done control; a row goes on from a preview either way */
async function pressControl(board: Board, nodeId: string): Promise<Pressed> {
  const result = await board.pressDone();
  if (result.pressed) await waitShown(board, null, 1500);
  const dom = await domArmed(board);
  const preview = result.pressed && result.armed === null && dom.shown === null && dom.overlaid === 0;
  if ((await board.armState()).armed !== null) {
    await board.arm(null);
    await waitShown(board, null, 1500);
  }
  return {
    takes: result.control.takesPress && result.control.nodeId === nodeId,
    preview,
    under: result.control.under,
  };
}
const pressedText = (pressed: Pressed | null): string =>
  !pressed
    ? "not measured"
    : pressed.takes && pressed.preview
      ? "takes the press, the node is a preview"
      : pressed.takes
        ? "takes the press, the node STAYS armed"
        : `takes NO press (${pressed.under})`;

/** arms the node again the way the row armed it (the same kind of anchor), else by the hook */
async function armAgain(
  board: Board,
  node: NodeHandle,
  way: R4Way,
  flow: Point | null,
): Promise<{ by: string; sameKind: boolean; armed: boolean; viewport: Viewport; moves: number }> {
  const id = node.id;
  const last = (await board.lastTransition())?.id ?? 0;
  let by = "hooks.arm";
  let sameKind = way === "hook" || way === "button";
  if (way !== "hook" && way !== "button" && flow) {
    const [v, canvas] = [await board.viewport(), await board.canvasBox()];
    const at = await wrapperPoint(board, id, {
      x: canvas.x + v.x + flow.x * v.zoom,
      y: canvas.y + v.y + flow.y * v.zoom,
    });
    if (at) {
      by = "a double-click";
      sameKind = true;
      await board.doubleClick(at);
    } else await board.arm(id);
  } else if (way === "button") {
    const button = await headerButton(board, id);
    if (button && button.text === "Edit" && button.takes) {
      by = "the Edit button";
      await board.click(centre(button.box));
    } else await board.arm(id);
  } else await board.arm(id);
  const viewport = await board.waitForRest();
  const armed = (await board.armState()).armed === id;
  if (armed) await waitShown(board, id, 2000);
  const moves = (await board.transitions()).filter((one) => one.id > last).length;
  return { by, sameKind, armed, viewport, moves };
}

/** a pan of the board at its zoom: by a drag on the bare pane where the window shows any (`real`), else by the hook */
async function panBoard(
  board: Board,
  nodeId: string,
  by: Point,
  seen: Box,
  real: boolean,
): Promise<{ how: string; panned: Point; armed: boolean; zoomKept: boolean }> {
  const before = await board.viewport();
  let how = "hooks.setViewport";
  const from = real ? await panePoint(board, { x: seen.x + 8, y: seen.y + seen.height - 8 }).catch(() => null) : null;
  if (from && holds(seen, { x: from.x + by.x, y: from.y + by.y }, 2)) {
    how = "pane drag";
    await board.drag(from, { x: from.x + by.x, y: from.y + by.y }, { steps: 8 });
  } else await board.setViewport({ x: before.x + by.x, y: before.y + by.y, zoom: before.zoom });
  await board.waitForRest();
  await sleep(250);
  const after = await board.viewport();
  return {
    how,
    panned: { x: after.x - before.x, y: after.y - before.y },
    armed: (await board.armState()).armed === nodeId,
    zoomKept: after.zoom === before.zoom,
  };
}

/** resizes a node as a person does: selects it by its header, drags its bottom right handle by `by` flow units */
async function resizeByHandle(board: Board, id: string, by: Point): Promise<{ width: number; height: number }> {
  const { zoom } = await board.viewport();
  const wrapper = (await board.nodeBox(id))!;
  await board.click({ x: Math.round(wrapper.x + 90), y: Math.round(wrapper.y + 5) });
  const handle = await board.waitFor(
    () =>
      board.page.evaluate((nodeId) => {
        const element = document.querySelector(
          `.react-flow__node[data-id="${nodeId}"] .react-flow__resize-control.handle.bottom.right`,
        );
        if (!element) return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x: x + width / 2, y: y + height / 2 };
      }, id),
    2000,
  );
  if (!handle) throw new Unmeasured("the selected node shows no resize handle");
  await board.drag(handle, { x: handle.x + by.x * zoom, y: handle.y + by.y * zoom }, { steps: 16, lead: [2, 4] });
  await sleep(400);
  const line = (await board.boardText()).split("\n").find((one) => one.includes(`"id":"${id}"`)) ?? "";
  return {
    width: Number(/"width":([\d.]+)/.exec(line)?.[1]),
    height: Number(/"height":([\d.]+)/.exec(line)?.[1]),
  };
}

/** one of the two further states of an R4 row: armed again, the board panned, the ways out read, a shape moved, the control pressed */
interface PannedState {
  rearmedBy: string;
  rearmMoves: number;
  rearmedAt: Viewport;
  rearmSameKind: boolean;
  panBy: string;
  pannedPx: Point;
  armedAfterPan: boolean;
  zoomKept: boolean;
  out: WayOut;
  palette: { total: number; take: number };
  move: Did | null;
  pressed: Pressed | null;
}

function r4(strategy: Strategy, view: Size, size: NodeSize, way: R4Way): Task {
  return {
    case: "R4 large-node",
    id: `R4|${size}|${strategy}|default|${view.width}x${view.height}|${way}`,
    notation: "bpmn",
    strategy,
    policy: "default",
    async run(ctx) {
      const spec = SPECS.bpmn;
      // the matrix node is 800 x 540 (resized by its handle to 1600 x 1000); the demo board's process
      // node is 940 x 540 and lies in a group
      const id = size === "940x540" ? "d-order" : "m-bpmn";
      const large = size === "1600x1000";
      const board = await ctx.open(
        size === "940x540" ? { board: "demo", strategy } : matrix(strategy, ["bpmn"], 0.3, {}, { x: 40, y: 150 }),
        large ? {} : { viewport: view },
      );
      const node = await board.node(id);
      const measured: Record<string, unknown> = { window: view, node: size };
      if (large) {
        // the handle's travel needs room: resized in the large window, then the window is made the size asked for
        measured.resizedTo = await resizeByHandle(board, id, { x: 800, y: 460 });
        // unselect: the next double-click is to arm, not to act on a selection
        await board.click(await panePoint(board, { x: WINDOW.width - 360, y: WINDOW.height - 20 }));
        await sleep(200);
        await board.page.setViewportSize(view);
        await sleep(400);
      }
      // the start: the whole node in the board below the toolbar's band, so that each of its parts
      // can be double-clicked; a board zoom of 0.3 at most and of 0.1 (the board's lower end) at least
      const [g0, v0] = [await geometry(board, id), await board.viewport()];
      const flowSize = { width: g0.wrapper!.width / v0.zoom, height: g0.wrapper!.height / v0.zoom };
      const seen0 = seenBox(g0, view);
      const fit = (room: number, length: number): number => Math.floor((room / length) * 1000) / 1000;
      const zoomAsked = Math.max(
        0.1,
        Math.min(0.3, fit(seen0.width - 32, flowSize.width), fit(seen0.height - g0.band - 24, flowSize.height)),
      );
      await board.showNode(id, zoomAsked, {
        x: Math.min(16, Math.floor(seen0.width - flowSize.width * zoomAsked - 2)),
        y: Math.round(g0.band + 12),
      });
      await board.waitForRest();
      await frame(board, 2);
      const before = await texts(board);
      const unarmed = await geometry(board, id);
      const controlOff = await board.doneControl();
      // the arming
      let given: { at: Point; on: string } | undefined;
      if (way !== "button" && way !== "hook") {
        const part = R4_PART[way];
        const at = await wrapperPoint(board, id, {
          x: unarmed.wrapper!.x + unarmed.wrapper!.width * part.x,
          y: unarmed.wrapper!.y + unarmed.wrapper!.height * part.y,
        });
        if (!at) throw new Unmeasured("no point of the preview takes the double-click");
        given = { at, on: `the node's ${way.slice(4)} part` };
      }
      const arming = await armBy(board, node, "bpmn", way === "button" || way === "hook" ? way : "shape", given);
      const policy = (await board.armPolicy(id))!;
      const a = armingChecks(arming, policy.armzoom, policy.motion);
      const checks = [...a.checks];
      const at = arming.viewport;
      const kind: AnchorKind = arming.pointer ? "pointer" : "centre";
      const anchor = a.measured.anchorMovedPx as Point;
      const anchorFar = px(Math.hypot(anchor.x, anchor.y));
      const anchorText = `${arming.pointer ? "the double-clicked point" : "the node's centre"} moved ${anchorFar} px`;
      if (!arming.armed)
        return {
          zoomAsked,
          zoomInEffect: at.zoom,
          key: `${a.key}; not armed`,
          checks,
          measured: { ...measured, ...a.measured },
        };
      const g = arming.after;
      const seen = seenBox(g, view);
      const wrapper = g.wrapper!;
      const lies = placed(g, wrapper, kind);
      const inBox = round(share(wrapper, innerBox(g)) * 100, 0);
      const inWindow = round(share(wrapper, seen) * 100, 0);
      // px of the wrapper that lie above the lower edge of the toolbar's band
      const above = px(Math.max(0, g.canvas.y + g.band - wrapper.y));
      const written = changed(before, await texts(board));
      const out1 = await wayOut(board, id, seen);
      const palette1 = await pressable(node, ".djs-palette .entry");
      await ctx.shot(board, "armed");
      const gapText =
        lies.fitsX && lies.fitsY
          ? "the node fits the box"
          : `the node is longer than the box on ${[lies.fitsX ? "" : "x", lies.fitsY ? "" : "y"].filter(Boolean).join(" and ")}, gap ${pair(lies.gap, 1)} px`;
      checks.push(
        check(
          "files",
          written.length === 0,
          "wrong-data",
          written.length === 0 ? "no file written by the arming" : `written by the arming: ${written.join(", ")}`,
        ),
        check("no gap", lies.gap.x <= 1 && lies.gap.y <= 1, "broken", gapText),
        check(
          "clear of the band",
          !lies.fitsY || above <= 0.5,
          "broken",
          lies.fitsY
            ? `the node fits the box's height: ${above} px of it lie under the toolbar's band`
            : `the node is taller than the box: its top lies ${above} px above the band's lower edge`,
        ),
        check(
          "band",
          unarmed.band === g.band && controlOff.band === out1.band,
          "degraded",
          `the toolbar's band is ${px(unarmed.band)} px with no node armed and ${px(g.band)} px with this one armed`,
        ),
        check(
          "palette",
          palette1.take === palette1.total && palette1.total > 0,
          "degraded",
          `${palette1.take} of ${palette1.total} palette entries take a press`,
        ),
      );
      // state 1, as armed: a label editor with typed text is open when the control is pressed
      const edited = await openLabel(board, node, spec);
      const pressed1 = await pressControl(board, id);
      const inFile =
        edited === null
          ? null
          : (await board.waitFor(async () => ((await board.fileText(spec.file)) ?? "").includes(MARKER), WRITE_MS)) ===
            true;
      // states 2 and 3: armed again the way the row arms, the board panned, the control pressed again
      const flow = arming.pointer && {
        x: (arming.pointer.x - arming.before.canvas.x - arming.from.x) / arming.from.zoom,
        y: (arming.pointer.y - arming.before.canvas.y - arming.from.y) / arming.from.zoom,
      };
      const panned = async (far: boolean, shapes: readonly string[], units: Point): Promise<PannedState> => {
        const again = await armAgain(board, node, way, flow);
        const now = await geometry(board, id);
        // far to the left: until the node's right end, where the header's Done sits, is 30 px inside the board
        const by = far
          ? { x: -Math.max(300, Math.ceil(now.wrapper!.x + now.wrapper!.width - (seen.x + seen.width - 30))), y: 0 }
          : { x: 0, y: -40 };
        const pan = again.armed
          ? await panBoard(board, id, by, seen, !far)
          : { how: "not panned", panned: { x: 0, y: 0 }, armed: false, zoomKept: true };
        const out = await wayOut(board, id, seen);
        const palette = pan.armed ? await pressable(node, ".djs-palette .entry") : { total: 0, take: 0 };
        const move = pan.armed ? await moveShape(board, node, { ...spec, shapes }, units, true) : null;
        const pressed = pan.armed ? await pressControl(board, id) : null;
        return {
          rearmedBy: again.by,
          rearmMoves: again.moves,
          rearmedAt: again.viewport,
          rearmSameKind: again.sameKind,
          panBy: pan.how,
          pannedPx: pan.panned,
          armedAfterPan: pan.armed,
          zoomKept: pan.zoomKept,
          out,
          palette,
          move,
          pressed,
        };
      };
      const up = await panned(false, [...spec.shapes].reverse(), { x: 44, y: 32 });
      const movedUp = (up.move?.measured.element as string | undefined) ?? null;
      // the shape that was moved goes back, so that the drop is one the engine allows
      const left = await panned(
        true,
        movedUp ? [movedUp, ...spec.shapes.filter((one) => one !== movedUp)] : spec.shapes,
        movedUp ? { x: -44, y: -32 } : { x: 44, y: 32 },
      );
      const stayed =
        up.rearmMoves === 0 && up.rearmedAt.x === at.x && up.rearmedAt.y === at.y && up.rearmedAt.zoom === 1;
      const ok = (pressed: Pressed | null): boolean => !!pressed && pressed.takes && pressed.preview;
      checks.push(
        check(
          "Done control",
          out1.controlTakes && ok(pressed1) && ok(up.pressed) && ok(left.pressed),
          "broken",
          `the toolbar's Done control, a real click on its middle: as armed it ${pressedText(pressed1)}; after a pan 40 px up it ${pressedText(up.pressed)}; after a pan far to the left it ${pressedText(left.pressed)}`,
        ),
        check(
          "text",
          inFile !== false,
          "wrong-data",
          edited === null
            ? "no shape of the diagram takes a press: no label editor was opened before the control's press"
            : inFile
              ? `the text typed into the open label editor of ${edited} is in the file after the control's press`
              : `the text typed into the open label editor of ${edited} is LOST after the control's press`,
        ),
        check(
          "armed again",
          !up.rearmSameKind || stayed,
          "degraded",
          `after Done, arming the node again by ${up.rearmedBy} made ${up.rearmMoves} move(s): the board stands at ${vp(up.rearmedAt)}, the first arming left it at ${vp(at)}`,
        ),
        check(
          "pan",
          up.armedAfterPan && up.zoomKept && left.armedAfterPan && left.zoomKept,
          "broken",
          `a pan by ${up.panBy} of ${pair(up.pannedPx)} px: ${up.armedAfterPan ? "armed" : "NOT armed"}; a pan by ${left.panBy} of ${pair(left.pannedPx)} px: ${left.armedAfterPan ? "armed" : "NOT armed"}`,
        ),
      );
      // a shape move counts where a shape of the diagram takes a press at all (not in a board of 160 px)
      const moveText = (move: Did | null): string =>
        move === null ? "no move" : move.measured.element === undefined ? "no shape in reach" : move.text;
      if (up.move?.measured.element !== undefined) checks.push(didCheck("move after the pan", up.move));
      if (left.move?.measured.element !== undefined) checks.push(didCheck("move after the far pan", left.move));
      const reach = (inReach: boolean): string => (inReach ? "in reach" : "OUT of reach");
      const short = (pressed: Pressed | null): string => (ok(pressed) ? "ends the editing" : "FAILS");
      return {
        zoomAsked,
        zoomInEffect: at.zoom,
        key: [
          `${a.key}`,
          `${anchorText}, ${arming.moves.length} transition(s), ${inBox} % of the node in the box (${gapText}), band ${px(unarmed.band)} px unarmed and ${px(g.band)} armed, top ${above} px above the band's edge, palette ${palette1.take}/${palette1.total}, header Done ${reach(out1.headerInReach)}`,
          `control as armed: ${short(pressed1)}${edited === null ? ", no label editor" : inFile ? ", typed label in the file" : ", typed label LOST"}`,
          `40 px up: control ${short(up.pressed)}, header Done ${reach(up.out.headerInReach)}, ${moveText(up.move)}`,
          `far left: control ${short(left.pressed)}, header Done ${reach(left.out.headerInReach)}, palette ${left.palette.take}/${left.palette.total}, ${moveText(left.move)}`,
        ].join("; "),
        checks,
        measured: {
          ...measured,
          ...a.measured,
          anchorMovedFarPx: anchorFar,
          transitions: arming.moves.length,
          nodeInWindowPct: inWindow,
          nodeInBoxPct: inBox,
          fits: { x: lies.fitsX, y: lies.fitsY },
          gapPx: { x: px(lies.gap.x), y: px(lies.gap.y) },
          bandUnarmedPx: px(unarmed.band),
          bandArmedPx: px(g.band),
          topAboveBandEdgePx: above,
          palette: palette1,
          asArmed: {
            headerDone: out1.headerDone,
            headerDoneInReach: out1.headerInReach,
            controlTakesPress: out1.controlTakes,
            pressed: pressed1,
            labelEdited: edited,
            typedTextInFile: inFile,
          },
          afterPanUp: { ...up, move: up.move?.measured ?? null },
          afterPanFarLeft: { ...left, move: left.move?.measured ?? null },
        },
        volatile: a.volatile,
      };
    },
  };
}

/** the window shrinks under an armed node: the builder states that nothing is placed again */
function r4resize(strategy: Strategy, to: Size): Task {
  return {
    case: "R4 large-node",
    id: `R4|bpmn|${strategy}|default|window shrinks to ${to.width}x${to.height} while armed`,
    notation: "bpmn",
    strategy,
    policy: "default",
    async run(ctx) {
      const board = await ctx.open(matrix(strategy, ["bpmn"], 0.5, {}));
      const node = await board.node("m-bpmn");
      const arming = await armBy(board, node, "bpmn", "shape");
      if (!arming.armed) throw new Unmeasured("the node did not arm");
      const at = arming.viewport;
      await board.page.setViewportSize(to);
      await sleep(500);
      const rest = await board.waitForRest();
      const armed = (await board.armState()).armed === "m-bpmn";
      const g = await geometry(board, "m-bpmn");
      const seen = seenBox(g, to);
      const inWindow = round(share(g.wrapper!, seen) * 100, 0);
      const out = await wayOut(board, "m-bpmn", seen);
      const pane = await panePoint(board, { x: seen.x + seen.width - 10, y: seen.y + seen.height - 10 }).catch(
        () => null,
      );
      const palette = armed ? await pressable(node, ".djs-palette .entry") : { total: 0, take: 0 };
      const move = armed ? await moveShape(board, node, SPECS.bpmn) : null;
      const same = rest.x === at.x && rest.y === at.y && rest.zoom === at.zoom;
      // nothing is placed again: the band of the narrower board may reach over the node
      const under = px(Math.max(0, g.canvas.y + g.band - g.wrapper!.y));
      await ctx.shot(board, "shrunk");
      const pressed = armed ? await pressControl(board, "m-bpmn") : null;
      const checks = [
        check("armed", armed, "broken", armed ? "the node stays armed" : "the node is disarmed"),
        check("zoom", rest.zoom === at.zoom, "broken", `board zoom ${rest.zoom}, armed at ${at.zoom}`),
        check(
          "Done control",
          out.controlTakes && !!pressed && pressed.takes && pressed.preview,
          "broken",
          `the toolbar's Done control ${pressedText(pressed)}; the header's Done is ${out.headerInReach ? "in reach" : "out of reach"}, ${pane ? "bare pane in the window" : "no bare pane in the window"}`,
        ),
        check(
          "band",
          under <= 0.5,
          "degraded",
          `the toolbar's band is ${px(g.band)} px after the shrink (${px(arming.after.band)} px when the node was placed): ${under} px of the node lie under it`,
        ),
        check(
          "palette",
          palette.take === palette.total,
          "degraded",
          `${palette.take} of ${palette.total} palette entries take a press`,
        ),
      ];
      if (move) checks.push(didCheck("move", move));
      return {
        zoomAsked: 0.5,
        zoomInEffect: rest.zoom,
        key: `armed at ${vp(at)} in ${WINDOW.width}x${WINDOW.height}; after the window shrank: ${armed ? "armed" : "disarmed"}, the board ${same ? "stays" : `at ${vp(rest)}`}, ${inWindow} % of the node in the window, band ${px(arming.after.band)} -> ${px(g.band)} px with ${under} px of the node under it, header Done ${out.headerInReach ? "in reach" : "OUT of reach"}, control ${pressed?.takes && pressed.preview ? "ends the editing" : "FAILS"}, ${palette.take}/${palette.total} palette entries, ${move?.text ?? "no move"}`,
        checks,
        measured: {
          armedAt: at,
          rest,
          nodeInWindowPct: inWindow,
          bandPx: { placed: px(arming.after.band), afterShrink: px(g.band) },
          nodeUnderBandPx: under,
          headerDone: out.headerDone,
          headerDoneInReach: out.headerInReach,
          controlTakesPress: out.controlTakes,
          pressed,
          paneInWindow: pane !== null,
          palette,
          move: move?.measured ?? null,
        },
      };
    },
  };
}

// ── R5 a zoom while armed (and its rows on other strategies, R9) ─────────────

type State = "none" | "bpmn-label" | "drd-label" | "table-cell" | "wardley-label" | "popup" | "held-in" | "held-out";
type Gesture =
  | "pane"
  | "ctrl-pane"
  | "other-node"
  | "tb-out"
  | "tb-100"
  | "tb-in"
  | "tb-fit"
  | "editor"
  | "palette"
  | "popup"
  | "ctrl-editor"
  | "hook"
  | "none"
  | "pane-click";
const STATE_KIND: Readonly<Record<State, Kind>> = {
  none: "bpmn",
  "bpmn-label": "bpmn",
  "drd-label": "dmn",
  "table-cell": "dmn-table",
  "wardley-label": "wardley",
  popup: "bpmn",
  "held-in": "bpmn",
  "held-out": "bpmn",
};
const TEXT_STATES: readonly State[] = ["bpmn-label", "drd-label", "table-cell", "wardley-label"];
/** gestures that ask the BOARD to zoom; the others are wheels over the armed editor */
const BOARD_GESTURES: readonly Gesture[] = [
  "pane",
  "ctrl-pane",
  "other-node",
  "tb-out",
  "tb-100",
  "tb-in",
  "tb-fit",
  "hook",
];
const TOOLBAR: Partial<Record<Gesture, number>> = { "tb-out": 0, "tb-100": 1, "tb-in": 2, "tb-fit": 3 };
const R5_GESTURES: Readonly<Record<State, readonly Gesture[]>> = {
  none: [
    "pane",
    "ctrl-pane",
    "other-node",
    "tb-out",
    "tb-100",
    "tb-in",
    "tb-fit",
    "editor",
    "palette",
    "ctrl-editor",
    "hook",
  ],
  "bpmn-label": [
    "pane",
    "ctrl-pane",
    "other-node",
    "tb-out",
    "tb-100",
    "tb-in",
    "tb-fit",
    "editor",
    "palette",
    "ctrl-editor",
    "hook",
  ],
  "drd-label": ["pane", "ctrl-pane", "tb-out", "editor", "hook"],
  "table-cell": ["pane", "ctrl-pane", "tb-out", "tb-fit", "editor", "hook"],
  "wardley-label": ["pane", "ctrl-pane", "tb-out", "editor", "hook"],
  popup: ["pane", "ctrl-pane", "other-node", "tb-out", "popup", "editor", "hook"],
  "held-in": ["editor", "ctrl-editor", "hook", "none"],
  "held-out": ["pane", "ctrl-pane", "hook", "none"],
};

interface Held {
  id: string;
  /** where the pointer pressed and the shape's box then, in diagram units */
  pressUnits: Point;
  boxUnits: Box;
  /** where the pointer is held, page px */
  pointer: Point;
  /** the engine shows a drag */
  active: boolean;
}

/** presses a shape and drags it without releasing: by (40, 30) px inside the editor, or out to `out` */
async function holdShape(node: NodeHandle, spec: Spec, out: Point | null): Promise<Held> {
  for (const id of spec.shapes) {
    const at = await pointIn(node, await node.elementBox(id), onShape(node, id));
    if (!at) continue;
    const start = await inDiagram(node, id, at);
    if (!start.at || !start.box) continue;
    const delta = out ? { x: out.x - at.x, y: out.y - at.y } : { x: 40, y: 30 };
    const dragged = await node.drag(at, delta, { keepDown: true, steps: out ? 24 : 12 });
    const active = await node.inDocument((host) => !!host.querySelector(".djs-drag-group, .djs-dragging"));
    return { id, pressUnits: start.at, boxUnits: start.box, pointer: dragged.to, active };
  }
  throw new Unmeasured("no shape takes a press");
}

interface Where {
  pane: Point;
  other: Point | null;
  editor: Point | null;
  palette: Point | null;
  popup: Point | null;
  /** a held pointer stays where it is: its wheels go there */
  pointer: Point | null;
}

/** the button of the toolbar's zoom group by its place (its title changes under lock) */
async function zoomButton(board: Board, index: number): Promise<{ at: Point; disabled: boolean; title: string }> {
  const found = await board.page.evaluate((nth) => {
    const button = document.querySelectorAll<HTMLButtonElement>('.board-toolbar__group[aria-label="Zoom"] button')[nth];
    if (!button) return null;
    const { x, y, width, height } = button.getBoundingClientRect();
    return { at: { x: x + width / 2, y: y + height / 2 }, disabled: button.disabled, title: button.title };
  }, index);
  if (!found) throw new Unmeasured("the toolbar shows no zoom button");
  return found;
}

async function doGesture(board: Board, gesture: Gesture, where: Where, start: Viewport): Promise<void> {
  const need = (point: Point | null, what: string): Point => {
    if (!point) throw new Unmeasured(`no point over ${what}`);
    return point;
  };
  if (gesture === "none") return;
  if (gesture === "pane") return board.wheelBurst(where.pointer ?? where.pane, 40);
  if (gesture === "ctrl-pane") return board.wheelBurst(where.pointer ?? where.pane, 40, { hold: ["Control"] });
  if (gesture === "other-node") return board.wheelBurst(need(where.other, "another node"), 40);
  if (gesture === "editor") return board.wheelBurst(where.pointer ?? need(where.editor, "the editor's canvas"), 40);
  if (gesture === "ctrl-editor")
    return board.wheelBurst(where.pointer ?? need(where.editor, "the editor's canvas"), 40, { hold: ["Control"] });
  if (gesture === "palette") return board.wheelBurst(need(where.palette, "the palette"), 40);
  if (gesture === "popup") return board.wheelBurst(need(where.popup, "the popup"), 40);
  if (gesture === "hook") return board.setViewport({ x: start.x, y: start.y, zoom: start.zoom * 0.8 });
  if (gesture === "pane-click") return board.click(where.pane);
  const button = await zoomButton(board, TOOLBAR[gesture]!);
  await board.click(button.at);
}

function r5(
  strategy: Strategy,
  rules: Rules,
  state: State,
  gesture: Gesture,
  zoom = 1,
  caseName = "R5 zoom-while-armed",
): Task {
  const kind = STATE_KIND[state];
  const policy = policyText(rules);
  return {
    case: caseName,
    id: `${caseName.split(" ")[0]}|${state}|${strategy}|${policy}|${gesture}|${zoom}`,
    notation: kind,
    strategy,
    policy,
    async run(ctx) {
      const [spec, id] = [specOf(kind), nodeOf(kind)];
      const otherNotation: ModelNotation = spec.notation === "bpmn" ? "dmn" : "bpmn";
      const otherId = `m-${otherNotation}`;
      const board = await ctx.open(matrix(strategy, [spec.notation, otherNotation], zoom, rules));
      const node = await board.node(id);
      const arming = await armBy(board, node, kind === "dmn-table" ? "dmn" : kind, "shape");
      if (!arming.armed) throw new Unmeasured("the node did not arm");
      const armedAt = arming.viewport;
      const policyNow = (await board.armPolicy(id))!;
      const original = await texts(board);
      const measured: Record<string, unknown> = {
        state,
        gesture,
        armedAt,
        policy: `${policyNow.armzoom}/${policyNow.armedzoom}/${policyNow.armreturn}`,
      };

      // the state
      let held: Held | null = null;
      let popupOpen: Box | undefined;
      const host = await node.hostBox();
      if (state === "bpmn-label" || state === "drd-label" || state === "wardley-label") {
        const edited = await openLabel(board, node, spec);
        if (!edited) throw new Unmeasured("no label editor opened");
        measured.edited = edited;
      } else if (state === "table-cell") {
        const opened = await openTable(board, node, true);
        if (!opened.opened) throw new Unmeasured(`the decision table did not open by pointer (${opened.button})`);
        const typed = await typeCell(board, node, MARKER);
        measured.edited = `a table cell, ${typed.text}`;
      } else if (state === "popup") {
        const opened = await openPopup(board, node, spec, true);
        if (!opened.popup) throw new Unmeasured(opened.text);
        popupOpen = opened.popup;
      }
      const g = await geometry(board, id);
      const pane = await panePoint(board, {
        x: host.x + host.width / 2,
        y: Math.min(host.y + host.height + 160, g.canvas.y + g.canvas.height - 40),
      });
      if (state === "held-in") held = await holdShape(node, spec, null);
      if (state === "held-out") held = await holdShape(node, spec, pane);
      if (held) measured.heldDragShown = held.active;

      const otherBox = await board.nodeBox(otherId);
      const otherAt = otherBox && {
        x: Math.round(otherBox.x + otherBox.width / 2),
        y: Math.round(otherBox.y + otherBox.height / 2),
      };
      const view = board.page.viewportSize() ?? WINDOW;
      const paletteBox = (await node.query(".djs-palette"))[0];
      const editorAt =
        gesture === "editor" || gesture === "ctrl-editor"
          ? held
            ? null
            : await pointIn(
                node,
                {
                  x: host.x + host.width * 0.3,
                  y: host.y + host.height * 0.55,
                  width: host.width * 0.5,
                  height: host.height * 0.4,
                },
                async (point) => {
                  const hit = await node.hit(point);
                  return (
                    hit.reachable &&
                    !hit.palette &&
                    !hit.pad &&
                    !hit.popup &&
                    !(await takes(node, point, `${spec.editor}, textarea, input`))
                  );
                },
              )
          : null;
      const where: Where = {
        pane,
        other:
          otherAt &&
          otherAt.x < Math.min(view.width, g.canvas.x + g.canvas.width) &&
          (await onWrapper(board, otherId, otherAt))
            ? otherAt
            : null,
        editor: editorAt,
        palette: paletteBox ? centre(paletteBox) : null,
        popup: popupOpen
          ? { x: popupOpen.x + popupOpen.width / 2, y: popupOpen.y + Math.min(popupOpen.height / 2, 120) }
          : null,
        pointer: held ? held.pointer : null,
      };
      const fileBefore = (await board.fileText(spec.file)) ?? "";
      const matrixBefore = await node.viewportMatrix();
      const countersBefore = (await board.counters()).arm;
      const toolbarIndex = TOOLBAR[gesture];
      const button = toolbarIndex === undefined ? null : await zoomButton(board, toolbarIndex);

      // the gesture, with both samplers running
      await board.startFrames();
      if (!node.frame) await startScale(board, id);
      await sleep(50);
      await doGesture(board, gesture, where, armedAt);
      await sleep(350);
      const after = await board.waitForRest();
      const frames = await board.stopFrames();
      const scale = node.frame ? null : scaleFacts(await stopScale(board));
      const armedAfter = (await board.armState()).armed === id;
      const dom = await domArmed(board);
      const countersAfter = (await board.counters()).arm;
      const counted = {
        transitions: countersAfter.transitions - countersBefore.transitions,
        disarmsBeforeZoom: countersAfter.disarmsBeforeZoom - countersBefore.disarmsBeforeZoom,
        disarmsAtTick: countersAfter.disarmsAtTick - countersBefore.disarmsAtTick,
        zoomsRefused: countersAfter.zoomsRefused - countersBefore.zoomsRefused,
        zoomsUndone: countersAfter.zoomsUndone - countersBefore.zoomsUndone,
        armedZoomTicks: countersAfter.armedZoomTicks - countersBefore.armedZoomTicks,
        lateDisarms: countersAfter.lateDisarms - countersBefore.lateDisarms,
      };
      const matrixAfter = armedAfter ? await node.viewportMatrix() : null;
      const editorScrolled =
        matrixBefore && matrixAfter
          ? matrixBefore.e !== matrixAfter.e || matrixBefore.f !== matrixAfter.f || matrixBefore.a !== matrixAfter.a
          : null;
      const facts = frameFacts(frames, armedAt.zoom);

      // what the rule says should have happened
      const boardGesture = BOARD_GESTURES.includes(gesture);
      const isHeld = held !== null;
      const zooms = boardGesture && !(gesture === "tb-100" && armedAt.zoom === 1);
      const rule = policyNow.armedzoom;
      const wantArmed = gesture === "pane-click" ? false : !zooms || rule === "free" || rule === "lock" || isHeld;
      const wantZoom: "unchanged" | "unarmed" =
        !zooms || ((rule === "lock" || isHeld) && rule !== "free") ? "unchanged" : "unarmed";

      // text
      const isText = TEXT_STATES.includes(state);
      let text = "";
      let lost = false;
      if (isText) {
        const editorOpen =
          armedAfter &&
          (kind === "dmn-table" ? await node.inDocument(FOCUS_READY) : (await node.query(spec.editor)).length > 0);
        const fieldKeeps = editorOpen && (await node.inDocument(FIELD_TEXT)).includes(MARKER);
        let inFile =
          (await board.waitFor(
            async () => ((await board.fileText(spec.file)) ?? "").includes(MARKER),
            fieldKeeps ? 500 : WRITE_MS,
          )) === true;
        let committedBy = inFile ? (fileBefore.includes(MARKER) ? "typing" : "the gesture") : "";
        if (!inFile && fieldKeeps) {
          // not lost while the open field holds it: committed as a person would, with a click on the bare pane
          await board.click(await panePoint(board, pane));
          inFile =
            (await board.waitFor(async () => ((await board.fileText(spec.file)) ?? "").includes(MARKER), WRITE_MS)) ===
            true;
          committedBy = inFile ? "a later pane click" : "";
        }
        lost = !inFile;
        const lines = newLines(original[spec.file], await board.fileText(spec.file));
        text = lost
          ? "typed text LOST"
          : `typed text in the file by ${committedBy}${editorOpen ? ", the editor stayed open" : ""}`;
        Object.assign(measured, {
          editorOpenAfter: editorOpen,
          fieldKeepsText: fieldKeeps,
          textInFile: inFile,
          committedBy,
          newLines: lines.slice(0, 12),
          newLineCount: lines.length,
        });
      }
      // a popup
      let popupAfter: boolean | null = null;
      if (state === "popup") {
        popupAfter = (await node.query(spec.popup)).length > 0;
        measured.popupOpenAfter = popupAfter;
      }
      // a held shape: where the pointer is in the diagram now, then the release
      let drop = "";
      if (held) {
        const end = await inDiagram(node, held.id, held.pointer);
        const fileHeld = (await board.fileText(spec.file)) ?? "";
        await board.release();
        const written = (await board.waitForFileChange(spec.file, fileHeld, 1800)) !== null;
        await sleep(450);
        const landed = await inDiagram(node, held.id, null);
        const moved = landed.box ? { x: landed.box.x - held.boxUnits.x, y: landed.box.y - held.boxUnits.y } : null;
        const pointer = end.at ? { x: end.at.x - held.pressUnits.x, y: end.at.y - held.pressUnits.y } : null;
        const off = moved && pointer ? { x: moved.x - pointer.x, y: moved.y - pointer.y } : null;
        const unit = (await node.diagramScale()) ?? 1;
        drop = moved
          ? `the held shape moved ${pair(moved)} units, the pointer ${pointer ? pair(pointer) : "?"} units${off ? ` (off ${pair(off)} units, ${pair({ x: off.x * unit, y: off.y * unit })} px)` : ""}, file ${written ? "written" : "unchanged"}`
          : "the held shape is gone";
        measured.held = {
          element: held.id,
          movedUnits: moved && { x: px(moved.x), y: px(moved.y) },
          pointerUnits: pointer && { x: px(pointer.x), y: px(pointer.y) },
          offUnits: off && { x: px(off.x), y: px(off.y) },
          fileWritten: written,
          armedAfterRelease: (await board.armState()).armed === id,
        };
      }
      const now = await texts(board);
      const written = changed(original, now);
      const mounts = (await board.counters()).mounts;

      // the same gesture with no node armed, from the same viewport
      let unarmed: number | null = null;
      if (boardGesture && gesture !== "hook") {
        await board.arm(null);
        await waitShown(board, null);
        await board.setViewport(armedAt);
        await board.waitForRest();
        const plainPane = await panePoint(board, pane);
        await doGesture(board, gesture, { ...where, pane: plainPane, pointer: null }, armedAt);
        await sleep(300);
        unarmed = (await board.waitForRest()).zoom;
      } else if (gesture === "hook") unarmed = armedAt.zoom * 0.8;

      const sameView = after.x === armedAt.x && after.y === armedAt.y && after.zoom === armedAt.zoom;
      const checks = [
        check(
          "armed after",
          armedAfter === wantArmed && dom.shown === (armedAfter ? id : null),
          "broken",
          `the node is ${armedAfter ? "armed" : "a preview"} (the DOM shows ${dom.shown ?? "none"} armed), the rule ${rule} asks for ${wantArmed ? "armed" : "a preview"}`,
        ),
        check(
          "board zoom",
          wantZoom === "unchanged" ? sameView : unarmed !== null && Math.abs(after.zoom - unarmed) < 1e-9,
          "broken",
          wantZoom === "unchanged"
            ? `the board stands at ${vp(after)}, it was armed at ${vp(armedAt)} and has to stay`
            : `board zoom ${round(after.zoom, 4)}, the same gesture with no node armed gives ${unarmed === null ? "?" : round(unarmed, 4)}`,
        ),
      ];
      if (rule !== "free") {
        checks.push(
          check(
            "frames",
            facts.armedOffZoom === 0,
            "broken",
            `${facts.armedOffZoom} of ${facts.armed} armed frames at another board zoom than ${armedAt.zoom}`,
          ),
          check("late", counted.lateDisarms === 0, "broken", `${counted.lateDisarms} late disarm(s)`),
        );
      }
      if (rule === "disarm" && zooms && !isHeld) {
        const seenComing = gesture === "hook" ? counted.disarmsAtTick : counted.disarmsBeforeZoom;
        checks.push(
          check(
            "counted",
            seenComing === 1,
            "degraded",
            `disarmsBeforeZoom ${counted.disarmsBeforeZoom}, disarmsAtTick ${counted.disarmsAtTick} for one gesture`,
          ),
        );
      }
      if ((rule === "lock" || (isHeld && rule === "disarm")) && zooms) {
        checks.push(
          check(
            "refused",
            counted.zoomsRefused >= 1 || (button?.disabled ?? false),
            "degraded",
            `${counted.zoomsRefused} zoom(s) refused, ${counted.zoomsUndone} undone${button ? `, the button is ${button.disabled ? "disabled" : "enabled"} ("${button.title}")` : ""}`,
          ),
        );
      }
      if (scale && scale.worst !== null && boardGesture) {
        checks.push(
          check(
            "picture",
            scale.worst <= 1,
            "degraded",
            `the picture was up to ${scale.worst} % out of scale against its host (${scale.framesOver} frames over 1 %; while armed up to ${scale.worstArmed ?? 0} %)`,
          ),
        );
      }
      if (isText) checks.push(check("text", !lost, "wrong-data", text));
      if (state === "popup" && wantArmed && boardGesture) {
        checks.push(
          check(
            "popup",
            popupAfter === true,
            "degraded",
            `the popup is ${popupAfter ? "open" : "closed"} after a zoom that ${rule === "free" ? "went on under the editor" : "was refused"}`,
          ),
        );
      }
      const expectFile = isText || isHeld;
      checks.push(
        check(
          "files",
          written.every((path) => expectFile && path === spec.file),
          "wrong-data",
          written.length === 0
            ? "no file changed"
            : `changed: ${written.join(", ")}${expectFile ? "" : " (nothing was edited)"}`,
        ),
        check(
          "mounts",
          Object.values(mounts).every((count) => count === 1),
          "degraded",
          `mounts ${JSON.stringify(mounts)}`,
        ),
      );
      await ctx.shot(board, "end").catch(() => undefined);
      const zoomText = `zoom ${armedAt.zoom} -> ${round(after.zoom, 4)}${unarmed !== null ? ` (unarmed ${round(unarmed, 4)})` : ""}`;
      return {
        zoomAsked: zoom,
        zoomInEffect: armedAt.zoom,
        key: [
          armedAfter ? "armed" : "disarmed",
          zoomText,
          ...(isText ? [text] : []),
          ...(popupAfter !== null ? [`popup ${popupAfter ? "open" : "closed"}`] : []),
          ...(drop ? [drop] : []),
          ...(editorScrolled !== null && !boardGesture
            ? [editorScrolled ? "the editor's view changed" : "the editor's view did not change"]
            : []),
          ...(scale && scale.worst !== null && scale.worst > 1 && boardGesture ? ["picture out of scale"] : []),
        ].join(", "),
        checks,
        measured: {
          ...measured,
          viewportAfter: after,
          armedAfter,
          unarmedZoom: unarmed,
          counted,
          armedFramesAtAnotherZoom: facts.armedOffZoom,
          editorViewChanged: editorScrolled,
          filesWritten: written,
          mounts,
          toolbarButton: button && { disabled: button.disabled, title: button.title },
        },
        volatile: {
          frames: facts.frames,
          armedFrames: facts.armed,
          zoomSteps: facts.zoomSteps,
          pictureOffPct: scale?.worst ?? null,
          pictureOffArmedPct: scale?.worstArmed ?? null,
          framesOffScale: scale?.framesOver ?? null,
        },
      };
    },
  };
}

// ── R6 the transition interrupted ────────────────────────────────────────────

type Interrupt =
  | "dblclick-same"
  | "wheel"
  | "escape"
  | "pan-drag"
  | "pane-click"
  | "dblclick-other"
  | "resize"
  | "toolbar-zoom"
  | "backspace"
  | "letter";
const INTERRUPTS: readonly Interrupt[] = [
  "dblclick-same",
  "wheel",
  "escape",
  "pan-drag",
  "pane-click",
  "dblclick-other",
  "resize",
  "toolbar-zoom",
  "backspace",
  "letter",
];
/** what is armed at rest, as the builder's report states it */
const STATED: Readonly<Record<Interrupt, string | null>> = {
  "dblclick-same": "m-bpmn",
  wheel: null,
  escape: null,
  "pan-drag": null,
  "pane-click": null,
  "dblclick-other": "m-dmn",
  resize: "m-bpmn",
  "toolbar-zoom": null,
  // the double-click selected the node, and the board's delete key acts on the selection: the key must be lost
  backspace: "m-bpmn",
  letter: "m-bpmn",
};

function r6(strategy: Strategy, interrupt: Interrupt, motion: number | undefined): Task {
  return {
    case: "R6 interrupted",
    id: `R6|bpmn|${strategy}|default|${interrupt}|motion ${motion ?? "token"}`,
    notation: "bpmn",
    strategy,
    policy: "default",
    serial: motion === undefined,
    async run(ctx) {
      const board = await ctx.open(
        matrix(strategy, ["bpmn", "dmn"], 0.5, motion === undefined ? {} : { armmotion: motion }),
      );
      const node = await board.node("m-bpmn");
      const point = await previewPoint(board, node, "bpmn", "shape");
      const pane = await panePoint(board, { x: 900, y: 1150 });
      const before = await texts(board);
      const from = await board.viewport();
      const policy = (await board.armPolicy("m-bpmn"))!;
      await board.startFrames();
      await board.page.mouse.dblclick(point.at.x, point.at.y);
      if (policy.motion >= 800) {
        await board.waitFor(async () => (await board.armState()).moving, 1000, 10);
        await sleep(policy.motion * 0.25);
      }
      const moving = (await board.armState()).moving;
      if (interrupt === "dblclick-same") await board.page.mouse.dblclick(point.at.x, point.at.y);
      else if (interrupt === "wheel") await board.wheelBurst(pane, 40, { count: 4 });
      else if (interrupt === "escape") await board.press("Escape");
      else if (interrupt === "pan-drag") await board.drag(pane, { x: pane.x - 80, y: pane.y - 50 }, { steps: 6 });
      else if (interrupt === "pane-click") await board.click(pane);
      else if (interrupt === "dblclick-other") {
        const other = (await board.nodeBox("m-dmn"))!;
        await board.page.mouse.dblclick(Math.round(other.x + other.width / 2), Math.round(other.y + other.height / 2));
      } else if (interrupt === "resize") await board.page.setViewportSize({ width: 1000, height: 600 });
      else if (interrupt === "backspace") await board.press("Backspace");
      else if (interrupt === "letter") await board.press("x");
      else await board.click((await zoomButton(board, 2)).at);
      const rest = await board.waitForRest(10_000);
      const nodesLeft = (await board.nodes()).map((one) => one.id);
      const state = await board.armState();
      if (state.armed) await waitShown(board, state.armed, 2000);
      await sleep(200);
      const frames = await board.stopFrames();
      const transitions = await board.transitions();
      const dom = await domArmed(board);
      const first = transitions[0];
      if (!moving || !first) {
        throw new Unmeasured(
          `the action came after the move had ended (the move took ${first ? px(first.measuredMs) : "?"} ms of ${policy.motion})`,
        );
      }
      const written = changed(before, await texts(board));
      const armedId = state.armed;
      const facts = frameFacts(frames, rest.zoom);
      const overlaidWanted = armedId && strategy === "overlay" ? 1 : 0;
      const consistent =
        dom.shown === armedId && !state.moving && (strategy !== "overlay" || dom.overlaid === overlaidWanted);
      let lies = "";
      let allowed = consistent;
      if (consistent && armedId) {
        const g = await geometry(board, armedId);
        // every arming of this case is a double-click: a node that became longer than the box under the
        // move (the window was resized) has to leave no gap, and is not brought to the margin (round 6)
        const where = placed(g, g.wrapper!, "pointer");
        lies = `, the wrapper ${where.text}`;
        allowed = rest.zoom === 1 && (where.fits ? where.inside >= 0.999 : where.atMargin) && facts.armedOffZoom === 0;
      }
      const what = armedId ? `${armedId} armed at ${vp(rest)}${lies}` : `nothing armed at ${vp(rest)}`;
      // does the editor take input: at once when armed, else after the person asks again
      let asked = "";
      let target = armedId;
      if (!target) {
        const again = await armBy(board, node, "bpmn", "shape");
        asked = again.armed ? `a new double-click arms at ${vp(again.viewport)}` : "a new double-click does NOT arm";
        target = again.armed ? "m-bpmn" : null;
      }
      const input = target
        ? await moveShape(board, await board.node(target), specOf(target === "m-dmn" ? "dmn" : "bpmn"))
        : null;
      const late = (await board.counters()).arm.lateDisarms;
      const by = transitions.map(
        (one) =>
          `${one.by}${one.interrupted ? `, interrupted by ${one.interruptedBy}` : ""}${one.armed ? ", armed" : ""}`,
      );
      const checks = [
        check(
          "state",
          allowed,
          "broken",
          allowed
            ? `${what}: an allowed state`
            : `${what}: runtime ${armedId ?? "none"}, DOM ${dom.shown ?? "none"}, ${dom.overlaid} host(s) in the overlay layer, moving ${state.moving}, ${facts.armedOffZoom} armed frames at another zoom`,
        ),
        check(
          "stated",
          armedId === STATED[interrupt],
          "degraded",
          `at rest ${armedId ?? "nothing"} is armed, the builder states ${STATED[interrupt] ?? "nothing"}`,
        ),
        check(
          "armed on the way",
          armedId !== null || facts.armed === 0,
          "degraded",
          `${facts.armed} frames with a node armed although nothing is armed at rest`,
        ),
        check("input", input?.verdict === "ok", "broken", input ? `${asked ? `${asked}; ` : ""}${input.text}` : asked),
        check(
          "files",
          written.length === 0,
          "wrong-data",
          written.length === 0 ? "no file written" : `written: ${written.join(", ")}`,
        ),
        check("late", late === 0, "broken", `${late} late disarm(s)`),
        check(
          "nodes",
          nodesLeft.includes("m-bpmn") && nodesLeft.includes("m-dmn"),
          "wrong-data",
          `the board has ${nodesLeft.join(", ")} after the action`,
        ),
      ];
      return {
        zoomAsked: from.zoom,
        zoomInEffect: armedId ? rest.zoom : null,
        key: `${armedId ? `${armedId} armed, zoom ${rest.zoom}` : "nothing armed"}; moves: ${by.join(" | ")}; ${asked ? `${asked.replace(/ at .*/, "")}; ` : ""}${input?.text ?? "no input"}`,
        ...(lies ? { more: `at rest${lies}` } : {}),
        checks,
        measured: {
          interrupt,
          askedMs: policy.motion,
          armedAtRest: armedId,
          transitions: transitions.map((one) => ({
            by: one.by,
            to: one.to,
            interrupted: one.interrupted,
            interruptedBy: one.interruptedBy ?? null,
            armed: one.armed,
          })),
          domShown: dom.shown,
          overlaid: dom.overlaid,
          input: input?.measured ?? null,
          filesWritten: written,
        },
        volatile: {
          viewportAtRest: rest,
          interruptedAfterMs: px(first.measuredMs),
          armedFrames: facts.armed,
          frames: facts.frames,
        },
      };
    },
  };
}

// ── R7 return ────────────────────────────────────────────────────────────────

type History = "moved" | "panned" | "b-from-a" | "zoom-disarm";
type End = "done" | "pane" | "hook" | "wheel";

function r7(strategy: Strategy, armreturn: ArmReturn, history: History, end: End): Task {
  const rules: Rules = { armreturn };
  return {
    case: "R7 return",
    id: `R7|bpmn|${strategy}|${policyText(rules)}|${history}|${end}`,
    notation: "bpmn",
    strategy,
    policy: policyText(rules),
    async run(ctx) {
      // B sticks out of a narrower board once A is armed, so that arming B has to move the board
      const view = history === "b-from-a" ? { width: 1600, height: 1300 } : WINDOW;
      const board = await ctx.open(matrix(strategy, ["bpmn", "dmn"], 0.5, rules), { viewport: view });
      const nodeA = await board.node("m-bpmn");
      const before = await texts(board);
      const home = await board.viewport();
      const first = await armBy(board, nodeA, "bpmn", "shape");
      if (!first.armed || !first.transition) throw new Unmeasured("arming A did not move the board");
      let target = "m-bpmn";
      let back: Viewport | null = home;
      let story = `A armed at ${vp(first.viewport)}`;
      if (history === "panned") {
        const from = await panePoint(board, { x: 900, y: 1150 });
        await board.drag(from, { x: from.x - 70, y: from.y + 40 }, { steps: 8 });
        await board.waitForRest();
        await sleep(450);
        story += `, panned to ${vp(await board.viewport())}`;
      }
      if (history === "b-from-a") {
        const second = await armBy(board, await board.node("m-dmn"), "dmn", "shape");
        if (!second.armed) throw new Unmeasured("B did not arm");
        target = "m-dmn";
        // the arming of B began where A's left the board; without a move there is nothing to go back to
        back = second.transition ? second.from : null;
        story += `, B armed at ${vp(second.viewport)}${second.transition ? "" : " without a move"}`;
      }
      if ((await board.armState()).armed !== target) throw new Unmeasured(`${target} is not armed before the end`);
      const armedAt = await board.viewport();
      const last = (await board.lastTransition())?.id ?? 0;
      await board.startFrames();
      if (end === "done") {
        const button = await headerButton(board, target);
        if (!button || button.text !== "Done" || !button.takes) throw new Unmeasured("the Done button takes no press");
        await board.click(centre(button.box));
      } else if (end === "pane") await board.click(await panePoint(board, { x: 900, y: 1150 }));
      else if (end === "hook") await board.arm(null);
      else await board.wheelBurst(await panePoint(board, { x: 900, y: 1150 }), 40);
      await sleep(300);
      const rest = await board.waitForRest();
      await waitShown(board, null, 2000);
      const frames = await board.stopFrames();
      const transition = await board.lastTransition();
      const returned = transition && transition.id > last ? transition : null;
      const state = await board.armState();
      const goesBack = armreturn === "back" && end !== "wheel" && back !== null;
      const same = (a: Viewport, b: Viewport): boolean => a.x === b.x && a.y === b.y && a.zoom === b.zoom;
      const wanted = goesBack ? back! : end === "wheel" ? null : armedAt;
      const facts = frameFacts(frames, armedAt.zoom);
      const written = changed(before, await texts(board));
      const checks = [
        check(
          "disarmed",
          state.armed === null && (await domArmed(board)).shown === null,
          "broken",
          state.armed === null ? "nothing is armed" : `${state.armed} is still armed`,
        ),
        check(
          "viewport",
          wanted ? same(rest, wanted) : !same(rest, home) && rest.zoom < armedAt.zoom,
          "broken",
          wanted
            ? `the board rests at ${vp(rest)}, the rule ${armreturn} gives ${vp(wanted)}`
            : `the board rests at ${vp(rest)} after the zoom, not at ${vp(home)} where it stood before the arming`,
        ),
        check(
          "return",
          goesBack
            ? !!returned && returned.purpose === "return" && returned.by === end && !returned.interrupted
            : returned === null,
          "broken",
          returned
            ? `a ${returned.purpose} move by ${returned.by} to ${vp(returned.to)}, asked ${returned.askedMs} ms`
            : "no move after the disarm",
        ),
        check(
          "frames",
          facts.armedOffZoom === 0 && facts.armedWhileMoving === 0,
          "broken",
          `${facts.armedOffZoom} armed frames at another zoom than ${armedAt.zoom}, ${facts.armedWhileMoving} armed while the board moved`,
        ),
        check(
          "files",
          written.length === 0,
          "wrong-data",
          written.length === 0 ? "no file written" : `written: ${written.join(", ")}`,
        ),
      ];
      return {
        zoomAsked: home.zoom,
        zoomInEffect: armedAt.zoom,
        key: `${story}; ${end}: rests at ${end === "wheel" ? `zoom ${round(rest.zoom, 4)}` : vp(rest)}${returned ? `, a return move by ${returned.by}` : ", no return move"}`,
        checks,
        measured: {
          home,
          armedAt,
          rest,
          wanted,
          returned: returned && { by: returned.by, to: returned.to, askedMs: returned.askedMs },
          filesWritten: written,
        },
        volatile: { returnMs: returned ? px(returned.measuredMs) : null, frames: facts.frames },
      };
    },
  };
}

// ── R8 from A to B ───────────────────────────────────────────────────────────

type Variant = "plain" | "label" | "table-cell" | "lock";

function r8(strategy: Strategy, variant: Variant): Task {
  const rules: Rules = variant === "lock" ? { armedzoom: "lock" } : {};
  const kindA: Kind = variant === "table-cell" ? "dmn-table" : "bpmn";
  // the matrix board lays its nodes out in the registry's order (bpmn, dmn, wardley): B is the later one
  const kindB: Kind = variant === "table-cell" ? "wardley" : "dmn";
  return {
    case: "R8 a-to-b",
    id: `R8|${kindA}|${strategy}|${policyText(rules)}|${variant}`,
    notation: kindA,
    strategy,
    policy: policyText(rules),
    async run(ctx) {
      const [specA, specB] = [specOf(kindA), specOf(kindB)];
      const [idA, idB] = [nodeOf(kindA), nodeOf(kindB)];
      // a board of 1260 px: at zoom 1 B lies at x 1020 to 1820, partly outside
      const board = await ctx.open(matrix(strategy, [specA.notation, specB.notation], 1, rules), {
        viewport: { width: 1600, height: 1300 },
      });
      const [nodeA, nodeB] = [await board.node(idA), await board.node(idB)];
      const original = await texts(board);
      const first = await armBy(board, nodeA, kindA === "dmn-table" ? "dmn" : kindA, "shape");
      if (!first.armed) throw new Unmeasured("A did not arm");
      let edited = "nothing";
      if (variant === "label") edited = `the label of ${(await openLabel(board, nodeA, specA)) ?? "?"}`;
      if (variant === "table-cell") {
        const opened = await openTable(board, nodeA, true);
        if (!opened.opened) throw new Unmeasured("the decision table did not open by pointer");
        edited = `a table cell (${(await typeCell(board, nodeA, MARKER)).text})`;
      }
      const boxB = (await board.nodeBox(idB))!;
      const g = await geometry(board, idB);
      const outside = round((1 - share(boxB, innerBox(g))) * 100, 0);
      // what is seen of B may hold no shape: a spot of its body
      const second = await armBy(board, nodeB, kindB, "canvas");
      const policy = (await board.armPolicy(idB))!;
      const b = armingChecks(second, policy.armzoom, policy.motion);
      const dom = await domArmed(board);
      const mounts = (await board.counters()).mounts;
      const framesA = second.frames.filter((one) => one.armed === idA || one.shown === idA);
      const movedUnderA = framesA.filter(
        (one) => one.x !== second.from.x || one.y !== second.from.y || one.zoom !== second.from.zoom,
      ).length;
      const both = second.frames.filter(
        (one) => one.armed !== null && one.shown !== null && one.armed !== one.shown,
      ).length;
      const isText = variant === "label" || variant === "table-cell";
      const inFile = isText
        ? (await board.waitFor(async () => ((await board.fileText(specA.file)) ?? "").includes(MARKER), WRITE_MS)) ===
          true
        : null;
      const editorOpen = isText && kindA !== "dmn-table" ? (await nodeA.query(specA.editor)).length > 0 : false;
      const written = changed(original, await texts(board));
      const move = second.armed ? await moveShape(board, nodeB, specB) : null;
      const checks = [
        ...b.checks,
        check(
          "zoom kept",
          second.viewport.zoom === 1,
          "broken",
          `board zoom ${second.viewport.zoom} after arming B, it was 1`,
        ),
        check(
          "A a preview",
          dom.shown === idB && (strategy !== "overlay" || dom.overlaid === 1),
          "broken",
          `the DOM shows ${dom.shown ?? "none"} armed, ${dom.overlaid} host(s) in the overlay layer`,
        ),
        check(
          "A never moved armed",
          movedUnderA === 0 && both === 0,
          "broken",
          `${movedUnderA} frames with A armed while the board stood elsewhere, ${both} frames with runtime and DOM naming two nodes`,
        ),
        check("mounts", mounts[idA] === 1 && mounts[idB] === 1, "degraded", `mounts ${JSON.stringify(mounts)}`),
        check(
          "files before the move",
          written.every((path) => isText && path === specA.file),
          "wrong-data",
          written.length === 0 ? "no file changed" : `changed: ${written.join(", ")}`,
        ),
      ];
      if (isText)
        checks.push(
          check(
            "text",
            inFile === true && !editorOpen,
            "wrong-data",
            inFile
              ? `the text typed into A is in the file${editorOpen ? ", A's editor is still open" : ""}`
              : "the text typed into A is LOST",
          ),
        );
      if (move) checks.push(didCheck("move in B", move));
      return {
        zoomAsked: 1,
        zoomInEffect: second.viewport.zoom,
        key: `B ${outside} % outside the box; ${b.key}; A edited ${edited}${isText ? (inFile ? ", in the file" : ", LOST") : ""}; ${move?.text ?? "B not armed"}`,
        checks,
        measured: {
          ...b.measured,
          outsideBeforePct: outside,
          edited,
          textInFile: inFile,
          domShown: dom.shown,
          mounts,
          filesWritten: written,
          move: move?.measured ?? null,
        },
        volatile: b.volatile,
      };
    },
  };
}

// ── R10 what it costs a person ───────────────────────────────────────────────

interface Timing {
  down: number | null;
  dbl: number | null;
  moving: number | null;
  armed: number | null;
  shown: number | null;
  input: number | null;
  palette: number | null;
  frames: number[];
}

/** records, per animation frame from the double-click on: when the board moves, the node is armed, and the editor takes a press */
async function installTiming(board: Board, nodeId: string): Promise<void> {
  await board.page.evaluate(
    ([key, id]) => {
      const page = window as unknown as Record<string, unknown> & { __armTiming?: Timing };
      const hooks = page[key] as {
        armState(): { armed: string | null; moving: boolean };
        engine(id: string): { host?: HTMLElement } | undefined;
      };
      const native = (window as NativeWindow).__boardSpikeNative;
      const timing: Timing = (page.__armTiming = {
        down: null,
        dbl: null,
        moving: null,
        armed: null,
        shown: null,
        input: null,
        palette: null,
        frames: [],
      });
      window.addEventListener("mousedown", () => void (timing.down ??= performance.now()), true);
      window.addEventListener("dblclick", () => void (timing.dbl ??= performance.now()), true);
      const takes = (element: Element | null | undefined, host: HTMLElement): boolean => {
        if (!element) return false;
        const { x, y, width, height } = native ? native.rect(element) : element.getBoundingClientRect();
        if (!(width > 0) || !(height > 0)) return false;
        const [cx, cy] = [x + width / 2, y + height / 2];
        const top = native ? native.elementFromPoint(document, cx, cy) : document.elementFromPoint(cx, cy);
        return !!top && host.contains(top);
      };
      const step = (): void => {
        const now = performance.now();
        if (timing.dbl !== null) timing.frames.push(now);
        const state = hooks.armState();
        if (state.moving) timing.moving ??= now;
        if (state.armed === id) timing.armed ??= now;
        if (document.querySelector(`.react-flow__node[data-id="${id}"] .board-node[data-armed="true"]`))
          timing.shown ??= now;
        const host = hooks.engine(id)?.host;
        if (host && timing.shown !== null) {
          if (takes(host.querySelector(".djs-container svg") ?? host, host)) timing.input ??= now;
          if (takes(host.querySelector(".djs-palette .entry"), host)) timing.palette ??= now;
        }
        if (timing.frames.length < 600) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    [HOOKS_KEY, nodeId] as const,
  );
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? NaN : sorted[Math.floor((sorted.length - 1) / 2)]!;
};
const spread = (values: readonly number[]): { median: number; min: number; max: number; n: number } => ({
  median: px(median(values)),
  min: px(Math.min(...values)),
  max: px(Math.max(...values)),
  n: values.length,
});

function r10time(
  strategy: Strategy,
  zoom: number,
  motion: number | undefined,
  samples = 5,
  caseName = "R10 cost",
): Task {
  return {
    case: caseName,
    id: `${caseName.split(" ")[0]}|bpmn|${strategy}|default|time to input|${zoom}|motion ${motion ?? "token"}`,
    notation: "bpmn",
    strategy,
    policy: "default",
    serial: true,
    async run(ctx) {
      const rows: Array<Record<string, number>> = [];
      let took = 0;
      let asked = 0;
      let zoomAfter = zoom;
      for (let sample = 0; sample < samples; sample++) {
        const board = await ctx.open(
          matrix(strategy, ["bpmn"], zoom, motion === undefined ? {} : { armmotion: motion }),
        );
        const node = await board.node("m-bpmn");
        const point = await previewPoint(board, node, "bpmn", "shape");
        asked = (await board.armPolicy("m-bpmn"))!.motion;
        await installTiming(board, "m-bpmn");
        await board.doubleClick(point.at);
        zoomAfter = (await board.waitForRest()).zoom;
        await board.waitFor(
          () => board.page.evaluate(() => (window as unknown as { __armTiming?: Timing }).__armTiming?.palette != null),
          3000,
          20,
        );
        const timing = await board.page.evaluate(() => (window as unknown as { __armTiming: Timing }).__armTiming);
        const transition = await board.lastTransition();
        const move = await moveShape(board, node, SPECS.bpmn);
        if (move.verdict === "ok") took++;
        const start = timing.dbl ?? timing.down ?? 0;
        const until = timing.input ?? start;
        const gaps = timing.frames
          .filter((time) => time <= until + 1)
          .map((time, index, all) => (index === 0 ? time - start : time - all[index - 1]!));
        rows.push({
          toMove: timing.moving === null ? 0 : timing.moving - start,
          toArmed: (timing.armed ?? NaN) - start,
          toShown: (timing.shown ?? NaN) - start,
          toInput: (timing.input ?? NaN) - start,
          toPalette: (timing.palette ?? NaN) - start,
          moveMs: transition?.measuredMs ?? 0,
          longestFrame: gaps.length > 0 ? Math.max(...gaps) : 0,
          load: loadavg()[0]!,
        });
        await board.close();
      }
      const column = (name: string): number[] =>
        rows.map((row) => row[name]!).filter((value) => Number.isFinite(value));
      const complete = column("toInput").length;
      return {
        zoomAsked: zoom,
        zoomInEffect: zoomAfter,
        key: `motion asked ${asked} ms: the editor took a press in ${complete}/${samples} samples, a shape move was exact in ${took}/${samples}`,
        checks: [
          check(
            "input",
            complete === samples && took === samples,
            "broken",
            `${complete} of ${samples} samples reached an editor that takes a press, ${took} exact moves`,
          ),
        ],
        measured: { samples, askedMs: asked },
        volatile: {
          msFromDoubleClick: {
            toFirstMovingFrame: spread(column("toMove")),
            toArmedRuntime: spread(column("toArmed")),
            toArmedInDom: spread(column("toShown")),
            toEditorTakesPress: spread(column("toInput")),
            toPaletteTakesPress: spread(column("toPalette")),
          },
          moveMs: spread(column("moveMs")),
          longestFrameMs: spread(column("longestFrame")),
          loadDuringSamples: spread(column("load")),
          perSample: rows.map((row) =>
            Object.fromEntries(Object.entries(row).map(([name, value]) => [name, px(value)])),
          ),
        },
      };
    },
  };
}

function r10frames(strategy: Strategy, count: number, samples = 3): Task {
  return {
    case: "R10 cost",
    id: `R10|bpmn|${strategy}|default|frames|${count} node(s)`,
    notation: "bpmn",
    strategy,
    policy: "default",
    serial: true,
    async run(ctx) {
      const rows: Array<Record<string, number>> = [];
      let from = 0;
      let to = 0;
      let armedAll = true;
      for (let sample = 0; sample < samples; sample++) {
        const board = await ctx.open(
          count === 1 ? matrix(strategy, ["bpmn"], 0.5, {}) : { board: "stress", strategy, notation: "bpmn", count },
        );
        const id = count === 1 ? "m-bpmn" : "s-0";
        const node = await board.node(id);
        from = (await board.viewport()).zoom;
        const point = await previewPoint(board, node, "bpmn", "shape");
        await board.startFrames();
        await board.doubleClick(point.at);
        to = (await board.waitForRest()).zoom;
        await frame(board, 4);
        const frames = await board.stopFrames();
        armedAll &&= (await board.armState()).armed === id;
        const transition = await board.lastTransition();
        // the frames of the move, and the one after its last: that one arms
        const last = frames.findLastIndex((one) => one.moving);
        const firstMoving = frames.findIndex((one) => one.moving);
        const during = frames
          .slice(Math.max(1, firstMoving), last + 1)
          .map((one, index) => one.t - frames[Math.max(1, firstMoving) + index - 1]!.t);
        const arming = last >= 0 && frames[last + 1] ? frames[last + 1]!.t - frames[last]!.t : 0;
        const sorted = [...during].sort((a, b) => a - b);
        rows.push({
          frames: during.length,
          medianMs: median(during),
          p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
          maxMs: sorted[sorted.length - 1] ?? 0,
          over20: during.filter((gap) => gap > 20).length,
          over34: during.filter((gap) => gap > 34).length,
          armingFrameMs: arming,
          moveMs: transition?.measuredMs ?? 0,
          writes: transition?.writes ?? 0,
          load: loadavg()[0]!,
        });
        await board.close();
      }
      const column = (name: string): number[] => rows.map((row) => row[name]!);
      return {
        zoomAsked: round(from, 4),
        zoomInEffect: to,
        key: `${count} node(s): armed in ${armedAll ? "every" : "NOT every"} sample`,
        checks: [check("armed", armedAll, "broken", armedAll ? "armed in every sample" : "a sample did not arm")],
        measured: { samples, nodes: count },
        volatile: {
          framesDuringMove: spread(column("frames")),
          frameMs: { median: spread(column("medianMs")), p95: spread(column("p95Ms")), max: spread(column("maxMs")) },
          framesOver20Ms: spread(column("over20")),
          framesOver34Ms: spread(column("over34")),
          armingFrameMs: spread(column("armingFrameMs")),
          moveMs: spread(column("moveMs")),
          writes: spread(column("writes")),
          loadDuringSamples: spread(column("load")),
        },
      };
    },
  };
}

// ── R11 reduced motion ───────────────────────────────────────────────────────

function r11(strategy: Strategy, way: "shape" | "button" | "hook" | "back" | "control"): Task {
  const rules: Rules = way === "back" ? { armreturn: "back" } : {};
  return {
    case: "R11 reduced-motion",
    id: `R11|bpmn|${strategy}|${policyText(rules)}|${way}`,
    notation: "bpmn",
    strategy,
    policy: policyText(rules),
    async run(ctx) {
      const board = await ctx.open(matrix(strategy, ["bpmn"], 0.5, rules));
      const node = await board.node("m-bpmn");
      const reduced = way !== "control";
      if (reduced) await board.page.emulateMedia({ reducedMotion: "reduce" });
      const policy = (await board.armPolicy("m-bpmn"))!;
      const home = await board.viewport();
      const arming = await armBy(board, node, "bpmn", way === "back" || way === "control" ? "shape" : way);
      const a = armingChecks(arming, policy.armzoom, policy.motion);
      const zooms = unique(arming.frames.map((one) => one.zoom));
      const t = arming.transition;
      const checks = [
        ...a.checks,
        check(
          "policy",
          reduced
            ? policy.motion === 0 && policy.motionFrom === "reduced-motion"
            : policy.motion > 0 && policy.motionFrom === "token",
          "broken",
          `the page says motion ${policy.motion} ms from ${policy.motionFrom}`,
        ),
        check(
          "at once",
          reduced
            ? !!t && t.askedMs === 0 && t.writes === 1 && zooms.length <= 2
            : !!t && t.askedMs > 0 && t.writes > 1,
          "broken",
          t
            ? `asked ${t.askedMs} ms, ${t.writes} write(s), board zooms seen per frame: ${zooms.length}`
            : "no transition",
        ),
      ];
      let back = "";
      if (way === "back") {
        const button = await headerButton(board, "m-bpmn");
        if (!button?.takes) throw new Unmeasured("the Done button takes no press");
        await board.startFrames();
        await board.click(centre(button.box));
        const rest = await board.waitForRest();
        await frame(board, 2);
        const frames = await board.stopFrames();
        const returned = await board.lastTransition();
        const seen = unique(frames.map((one) => one.zoom)).length;
        checks.push(
          check(
            "back at once",
            !!returned &&
              returned.purpose === "return" &&
              returned.askedMs === 0 &&
              returned.writes === 1 &&
              rest.x === home.x &&
              rest.y === home.y &&
              rest.zoom === home.zoom &&
              seen <= 2,
            "broken",
            returned
              ? `a ${returned.purpose} move, asked ${returned.askedMs} ms, ${returned.writes} write(s), rests at ${vp(rest)}`
              : "no return move",
          ),
        );
        back = `; back at ${vp(rest)} in ${returned?.writes ?? "?"} write(s)`;
      }
      return {
        zoomAsked: 0.5,
        zoomInEffect: arming.viewport.zoom,
        key: `motion ${policy.motion} ms from ${policy.motionFrom}; ${a.key}; ${t ? `${t.writes > 1 ? "several writes" : "1 write"}` : "no transition"}${back}`,
        checks,
        measured: {
          ...a.measured,
          motion: policy.motion,
          motionFrom: policy.motionFrom,
          writes: reduced ? (t?.writes ?? null) : null,
          zoomsSeen: reduced ? zooms.length : null,
        },
        volatile: a.volatile,
      };
    },
  };
}

// ── R12 the board file, and a second node of the same file ───────────────────

type Shared = "stress-bpmn" | "stress-wardley" | "compare";

function r12(strategy: Strategy, shared: Shared, by: "wheel" | "toolbar" | "done"): Task {
  const kind: Kind = shared === "stress-wardley" ? "wardley" : "bpmn";
  return {
    case: "R12 files",
    id: `R12|${kind}|${strategy}|default|${shared}|${by}`,
    notation: kind,
    strategy,
    policy: "default",
    async run(ctx) {
      const base = specOf(kind);
      const board = await ctx.open(
        shared === "compare"
          ? { board: "compare", zoom: 0.4, ...ORIGIN }
          : { board: "stress", strategy, notation: base.notation, count: 2, zoom: 0.5, ...ORIGIN },
      );
      const id = shared === "compare" ? "c-overlay" : "s-0";
      const node = await board.node(id);
      const file = node.info.file ?? base.file;
      // the compare board shows another process: its tasks are read off the editor
      const shapes =
        shared === "compare"
          ? (await node.elementIds()).filter((one) => /task|activity/i.test(one) && !/label|flow/i.test(one))
          : base.shapes;
      const spec: Spec = { ...base, file, shapes };
      const others = (await board.nodes())
        .filter((one) => one.type === "model" && one.file === file && one.id !== id)
        .map((one) => one.id);
      const board0 = await board.boardText();
      const file0 = (await board.fileText(file)) ?? "";
      const point = await (async (): Promise<Point> => {
        for (const shape of shapes) {
          const box = await node.elementBox(shape);
          const at = box && { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
          if (at && (await onWrapper(board, id, at))) return at;
        }
        throw new Unmeasured("no shape of the preview takes the double-click");
      })();
      const armed = await board.armByDoubleClick(id, point);
      if (!armed.armed) throw new Unmeasured("the node did not arm");
      await waitShown(board, id);
      const afterArming = {
        board: (await board.boardText()) === board0,
        file: ((await board.fileText(file)) ?? "") === file0,
      };
      const edited = await openLabel(board, node, spec);
      if (!edited) throw new Unmeasured("no label editor opened");
      if (by === "wheel") await board.wheelBurst(await panePoint(board, { x: 900, y: 1150 }), 40);
      else if (by === "toolbar") await board.click((await zoomButton(board, 0)).at);
      else {
        const button = await headerButton(board, id);
        if (!button?.takes) throw new Unmeasured("the Done button takes no press");
        await board.click(centre(button.box));
      }
      await sleep(300);
      const rest = await board.waitForRest();
      const disarmed = (await board.armState()).armed === null;
      const inFile =
        (await board.waitFor(async () => ((await board.fileText(file)) ?? "").includes(MARKER), WRITE_MS)) === true;
      const boardSame = (await board.boardText()) === board0;
      const shows: string[] = [];
      for (const other of others) {
        const handle = await board.node(other);
        const seen = await board.waitFor(
          () =>
            // not by the element's id: a renamed Wardley component gets a new one
            handle.inDocument(
              (host, marker: string) =>
                [...host.querySelectorAll("[data-element-id] > .djs-visual")].some((visual) =>
                  (visual.textContent ?? "").replace(/\s+/g, "").includes(marker),
                ),
              MARKER,
            ),
          3000,
        );
        if (seen) shows.push(other);
      }
      const mounts = (await board.counters()).mounts;
      const lines = newLines(file0, await board.fileText(file));
      const late = (await board.counters()).arm.lateDisarms;
      const checks = [
        check(
          "board file",
          afterArming.board && boardSame,
          "wrong-data",
          `the board file is ${afterArming.board ? "the same" : "CHANGED"} after the arming and its transition, ${boardSame ? "the same" : "CHANGED"} after the label edit and the disarm`,
        ),
        check(
          "model file",
          afterArming.file,
          "wrong-data",
          `the model file is ${afterArming.file ? "the same" : "CHANGED"} after the arming`,
        ),
        check("disarmed", disarmed, "broken", disarmed ? "disarmed" : "still armed"),
        check("text", inFile, "wrong-data", inFile ? "the typed text is in the file" : "the typed text is LOST"),
        check(
          "second node",
          shows.length === others.length && others.length > 0,
          "broken",
          `${shows.length} of ${others.length} other node(s) of the file show the text`,
        ),
        check(
          "mounts",
          Object.values(mounts).every((count) => count === 1),
          "degraded",
          `mounts ${JSON.stringify(mounts)}`,
        ),
        check("late", late === 0, "broken", `${late} late disarm(s)`),
      ];
      await ctx.shot(board, "end");
      return {
        zoomAsked: armed.transition?.from.zoom ?? armed.viewport.zoom,
        zoomInEffect: armed.viewport.zoom,
        key: `armed at zoom ${armed.viewport.zoom}, label of ${edited} typed, disarmed by ${by} (zoom ${round(rest.zoom, 4)}): text ${inFile ? "in the file" : "LOST"}, ${shows.length}/${others.length} other node(s) show it, board file ${afterArming.board && boardSame ? "untouched" : "CHANGED"}, ${lines.length} new line(s)`,
        checks,
        measured: {
          file,
          edited,
          others,
          shows,
          boardFileSame: afterArming.board && boardSame,
          modelFileSameAfterArming: afterArming.file,
          newLines: lines.slice(0, 8),
          mounts,
        },
      };
    },
  };
}

// ── R13 after a disarm by a zoom: what a person has lost ─────────────────────

/** the time from a double-click to an editor that takes a press, as installTiming recorded it; null when it never did */
async function timeToInput(board: Board): Promise<number | null> {
  const timing = await board.page.evaluate(() => (window as unknown as { __armTiming?: Timing }).__armTiming ?? null);
  const start = timing?.dbl ?? timing?.down ?? null;
  return timing?.input == null || start === null ? null : px(timing.input - start);
}

/**
 * `out` (R13): a wheel burst outwards over the bare board disarms, the board ends below zoom 1.
 * `in` (a row of R15, the round trip under the default exact1): the burst goes inwards, the board
 * ends near 1.56, and the new double-click brings it back to 1.
 */
function r13(strategy: Strategy, kind: "bpmn" | "dmn-table" | "wardley", direction: "out" | "in" = "out"): Task {
  const inwards = direction === "in";
  return {
    case: inwards ? "R15 exact1-cost" : "R13 rearm",
    id: inwards
      ? `R15|${kind}|${strategy}|default|round trip: zoom in, then a new double-click`
      : `R13|${kind}|${strategy}|default|zoom out, then a new double-click`,
    notation: kind,
    strategy,
    policy: "default",
    // the round trip takes a time
    serial: inwards,
    async run(ctx) {
      const [spec, id] = [specOf(kind), nodeOf(kind)];
      const board = await ctx.open(matrix(strategy, [spec.notation], 1, {}));
      const node = await board.node(id);
      const first = await armBy(board, node, kind === "dmn-table" ? "dmn" : kind, "shape");
      if (!first.armed) throw new Unmeasured("the node did not arm");
      let selected: string | null = null;
      if (kind === "dmn-table") {
        if (!(await openTable(board, node, true)).opened)
          throw new Unmeasured("the decision table did not open by pointer");
      } else {
        // the person's place in the diagram: a scrolled view and a selection
        const host = await node.hostBox();
        const over = await pointIn(
          node,
          { x: host.x + 200, y: host.y + 300, width: 300, height: 150 },
          async (point) => {
            const hit = await node.hit(point);
            return hit.reachable && !hit.palette && !hit.pad && !hit.popup;
          },
        );
        if (over) await board.wheel(over, 60);
        await sleep(300);
        for (const shape of spec.shapes) {
          if (await selectShape(node, shape)) {
            selected = shape;
            break;
          }
        }
        await sleep(200);
      }
      const view0 = await node.viewportMatrix();
      const table0 = kind === "dmn-table" ? (await node.query(TABLE)).length : null;
      const before = await texts(board);
      // what the person works on: the selected shape, or the table's cell
      const mine = async (): Promise<Box | null> =>
        kind === "dmn-table"
          ? ((await node.query(CELL))[0] ?? null)
          : selected
            ? await node.elementBox(selected)
            : null;
      const worked = await mine();
      // outwards: over the bare board below the node, as in round 5. Inwards: over the bare board left
      // of the node at the height of what the person works on, so that it stays in the window
      const pane = await panePoint(
        board,
        inwards && worked ? { x: first.after.canvas.x + 30, y: centre(worked).y } : { x: 900, y: 1150 },
      );
      await board.wheelBurst(pane, inwards ? -40 : 40);
      await sleep(300);
      const out = await board.waitForRest();
      const disarmed = (await board.armState()).armed === null;
      await waitShown(board, null);
      // what the person double-clicks now, and where it lies before and after: inwards the same shape again
      const same = inwards ? await mine() : null;
      const sameAt = same && { x: Math.round(centre(same).x), y: Math.round(centre(same).y) };
      const target =
        sameAt && (await wrapperPoint(board, id, sameAt).then((point) => point?.x === sameAt.x && point.y === sameAt.y))
          ? { at: sameAt, on: kind === "dmn-table" ? "a table cell" : selected! }
          : await previewPoint(board, node, kind, "shape");
      const landmark = async (): Promise<Box | null> =>
        kind === "dmn-table" ? ((await node.query(CELL))[0] ?? null) : await node.elementBox(target.on);
      const boxBefore = await landmark();
      await installTiming(board, id);
      const again = await armBy(board, node, kind, "shape", target);
      const boxAfter = again.armed ? await landmark() : null;
      const toInput = again.armed
        ? await board
            .waitFor(async () => (await timeToInput(board)) ?? 0, 3000, 20)
            .then((value) => (value ? value : null))
        : null;
      const travel =
        boxBefore && boxAfter
          ? { x: centre(boxAfter).x - centre(boxBefore).x, y: centre(boxAfter).y - centre(boxBefore).y }
          : null;
      const factor = boxBefore && boxAfter && boxBefore.width > 0 ? boxAfter.width / boxBefore.width : null;
      const point = again.pointer ? anchorTravel(again) : null;
      const under =
        again.armed && again.pointer && kind !== "dmn-table" && boxAfter
          ? (await node.hit(again.pointer)).element === target.on
          : null;
      const view1 = await node.viewportMatrix();
      const selectedNow = again.armed && selected ? (await node.selected()).includes(selected) : null;
      const table1 = kind === "dmn-table" ? (await node.query(TABLE)).length : null;
      const viewKept =
        view0 && view1
          ? Math.abs(view0.a - view1.a) < 0.001 &&
            Math.abs(view0.e - view1.e) < 0.6 &&
            Math.abs(view0.f - view1.f) < 0.6
          : null;
      const written = changed(before, await texts(board));
      const move = again.armed && kind !== "dmn-table" ? await moveShape(board, node, spec) : null;
      const cell = again.armed && kind === "dmn-table" ? await typeCell(board, node, "< 4711") : null;
      const input = move ?? cell;
      const checks = [
        check(
          "disarmed by the zoom",
          disarmed && (inwards ? out.zoom > 1 : out.zoom < 1),
          "broken",
          `after the burst: ${disarmed ? "a preview" : "armed"}, board zoom ${round(out.zoom, 4)}`,
        ),
        check(
          "armed again",
          again.armed && again.viewport.zoom === 1,
          "broken",
          `one double-click: ${again.armed ? "armed" : "not armed"} at board zoom ${again.viewport.zoom}`,
        ),
        check(
          "files",
          written.length === 0,
          "wrong-data",
          written.length === 0 ? "no file written by the disarm and the new arming" : `written: ${written.join(", ")}`,
        ),
      ];
      if (viewKept !== null)
        checks.push(
          check(
            "view",
            viewKept,
            "degraded",
            viewKept
              ? "the editor's own view (scroll and zoom) is as the person left it"
              : `the editor's own view changed: scale ${round(view0!.a, 3)} -> ${round(view1!.a, 3)}, origin ${pair({ x: view0!.e, y: view0!.f })} -> ${pair({ x: view1!.e, y: view1!.f })}`,
          ),
        );
      if (selectedNow !== null)
        checks.push(
          check(
            "selection",
            selectedNow,
            "degraded",
            selectedNow ? `${selected} is still selected` : `the selection of ${selected} is gone`,
          ),
        );
      if (table0 !== null)
        checks.push(
          check(
            "table",
            table1 === table0,
            "degraded",
            table1 ? "the decision table is still the view" : "the view went back to the DRD",
          ),
        );
      if (input) checks.push(didCheck("input", input));
      return {
        zoomAsked: 1,
        zoomInEffect: again.viewport.zoom,
        key: `zoomed ${inwards ? "in" : "out"} to ${round(out.zoom, 4)}: ${disarmed ? "disarmed" : "armed"}; a new double-click: ${again.armed ? `armed at ${vp(again.viewport)}` : "NOT armed"} (first at ${vp(first.viewport)})${viewKept === null ? "" : viewKept ? ", view kept" : ", view CHANGED"}${selectedNow === null ? "" : selectedNow ? ", selection kept" : ", selection gone"}${table0 === null ? "" : table1 ? ", table still open" : ", back at the DRD"}; ${input?.text ?? "no input"}`,
        more: [
          `the new double-click on ${target.on}`,
          point ? `its point moved ${px(Math.hypot(point.x, point.y))} px` : "",
          travel
            ? `${kind === "dmn-table" ? "the cell" : "the shape"} travelled ${px(Math.hypot(travel.x, travel.y))} px (${pair(travel, 1)}) and is x${round(factor ?? 0, 3)} as wide`
            : "",
          under === null ? "" : under ? "it is still under the pointer" : "it is NO LONGER under the pointer",
          `${again.moves.length} transition(s)`,
        ]
          .filter(Boolean)
          .join("; "),
        checks,
        measured: {
          firstAt: first.viewport,
          zoomedTo: out,
          againAt: again.viewport,
          againOn: target.on,
          pointMovedPx: point && { x: px(point.x), y: px(point.y) },
          travelPx: travel && { x: px(travel.x), y: px(travel.y) },
          widthFactor: factor === null ? null : round(factor, 4),
          stillUnderPointer: under,
          transitions: again.moves.length,
          viewBefore: view0,
          viewAfter: view1,
          viewKept,
          selected,
          selectionKept: selectedNow,
          tableStillOpen: table0 === null ? null : table1 === table0,
          filesWritten: written,
          input: input?.measured ?? null,
        },
        volatile: {
          rearmMs: again.transition ? px(again.transition.measuredMs) : null,
          msFromDoubleClickToEditorTakesPress: toInput,
          load: round(loadavg()[0]!, 1),
        },
      };
    },
  };
}

// ── R14 a node larger than the box, armed above zoom 1 under armzoom=min1 ────

/** per axis: the wrapper reaches over both margins of the box a node may use */
function covering(g: Geometry, wrapper: Box): { x: boolean; y: boolean; both: boolean; text: string } {
  const inner = innerBox(g);
  const over = (start: number, size: number, low: number, span: number): boolean =>
    start <= low + 0.5 && start + size >= low + span - 0.5;
  const [x, y] = [
    over(wrapper.x, wrapper.width, inner.x, inner.width),
    over(wrapper.y, wrapper.height, inner.y, inner.height),
  ];
  const span = (start: number, size: number, origin: number): string =>
    `${px(start - origin, 0)} to ${px(start + size - origin, 0)}`;
  return {
    x,
    y,
    both: x && y,
    text: `the node spans x ${span(wrapper.x, wrapper.width, g.canvas.x)} and y ${span(wrapper.y, wrapper.height, g.canvas.y)}, the box minus the margin x ${span(inner.x, inner.width, g.canvas.x)} and y ${span(inner.y, inner.height, g.canvas.y)}`,
  };
}

interface OversizeStart {
  /** no comma: CASES splits at them */
  name: string;
  zoom: number;
  window?: Size;
  /** the URL's x and y: the viewport, the node's corner being flow 0, 0 */
  viewport?: Point;
  /** or: this shape of the diagram is brought to `at` by a pan before the arming, as a person who looks at it has it */
  shape?: string;
  /** where the double-click goes, page px */
  at: Point;
  /** px the double-clicked point moved in round 5 (the start always to the margin), where it was measured */
  round5?: number;
}
const R14_STARTS: readonly OversizeStart[] = [
  // round 5, the supplement of the DMN rerun
  {
    name: "z3 -1500/-900 at 500/400",
    zoom: 3,
    viewport: { x: -1500, y: -900 },
    at: { x: 500, y: 400 },
    round5: 1811.4,
  },
  {
    name: "z3 -1200/-700 at 600/500",
    zoom: 3,
    viewport: { x: -1200, y: -700 },
    at: { x: 600, y: 500 },
    round5: 1450.9,
  },
  { name: "z3 -1200/-700 at 500/400", zoom: 3, viewport: { x: -1200, y: -700 }, at: { x: 500, y: 400 } },
  {
    name: "1440x900 z2 -500/-300 at 500/450",
    zoom: 2,
    window: { width: 1440, height: 900 },
    viewport: { x: -500, y: -300 },
    at: { x: 500, y: 450 },
    round5: 646.7,
  },
  // round 5, the independent check: the diagram's right end brought into the window
  {
    name: "z2.5 end event at 900/600",
    zoom: 2.5,
    shape: "EndEvent_order_fulfilled",
    at: { x: 900, y: 600 },
    round5: 832,
  },
  {
    name: "z3.5 end event at 900/600",
    zoom: 3.5,
    shape: "EndEvent_order_fulfilled",
    at: { x: 900, y: 600 },
    round5: 1566,
  },
  {
    name: "z1.5 end event at 900/600 fits",
    zoom: 1.5,
    shape: "EndEvent_order_fulfilled",
    at: { x: 900, y: 600 },
    round5: 120,
  },
  // starts at which the node covers the box on both axes before it is armed
  { name: "z3 -400/-200 at 900/650 covers", zoom: 3, viewport: { x: -400, y: -200 }, at: { x: 900, y: 650 } },
  {
    name: "z2.5 call activity at 1350/800 covers",
    zoom: 2.5,
    shape: "CallActivity_invoice_handling",
    at: { x: 1350, y: 800 },
  },
  {
    name: "z3 call activity at 1350/800 covers",
    zoom: 3,
    shape: "CallActivity_invoice_handling",
    at: { x: 1350, y: 800 },
  },
  {
    name: "z3.5 call activity at 1350/800 covers",
    zoom: 3.5,
    shape: "CallActivity_invoice_handling",
    at: { x: 1350, y: 800 },
  },
];

function r14(strategy: Strategy, start: OversizeStart, way: "dbl" | "hook"): Task {
  const rules: Rules = { armzoom: "min1" };
  return {
    case: "R14 oversize-above-one",
    id: `R14|bpmn|${strategy}|${policyText(rules)}|${way}|${start.name}`,
    notation: "bpmn",
    strategy,
    policy: policyText(rules),
    async run(ctx) {
      const id = "m-bpmn";
      const board = await ctx.open(
        matrix(strategy, ["bpmn"], start.zoom, rules, start.viewport ?? ORIGIN),
        start.window ? { viewport: start.window } : {},
      );
      const node = await board.node(id);
      const view = board.page.viewportSize() ?? WINDOW;
      if (start.shape) {
        const box = await node.elementBox(start.shape);
        if (!box) throw new Unmeasured(`the preview shows no ${start.shape}`);
        const v = await board.viewport();
        // a pan before the arming, to whole px
        await board.setViewport({
          x: Math.round(v.x - (centre(box).x - start.at.x)),
          y: Math.round(v.y - (centre(box).y - start.at.y)),
          zoom: v.zoom,
        });
        await board.waitForRest();
        await frame(board, 2);
      }
      const at = start.at;
      if (!(await onWrapper(board, id, at))) throw new Unmeasured(`the node is not at ${pair(at)}`);
      const before = await texts(board);
      const g0 = await geometry(board, id);
      const cover0 = covering(g0, g0.wrapper!);
      const arming =
        way === "hook"
          ? await armBy(board, node, "bpmn", "hook")
          : await armBy(board, node, "bpmn", "shape", { at, on: start.shape ?? "the point round 5 double-clicked" });
      const policy = (await board.armPolicy(id))!;
      const a = armingChecks(arming, policy.armzoom, policy.motion);
      const checks = [...a.checks];
      const v1 = arming.viewport;
      if (!arming.armed)
        return {
          zoomAsked: start.zoom,
          zoomInEffect: v1.zoom,
          key: `${a.key}; not armed`,
          checks,
          measured: a.measured,
        };
      const g = arming.after;
      const kind: AnchorKind = arming.pointer ? "pointer" : "centre";
      // the point of the diagram the person looked at: where it lies now (by the hook too)
      const flow = {
        x: (at.x - g0.canvas.x - arming.from.x) / arming.from.zoom,
        y: (at.y - g0.canvas.y - arming.from.y) / arming.from.zoom,
      };
      const now = { x: g.canvas.x + v1.x + flow.x * v1.zoom, y: g.canvas.y + v1.y + flow.y * v1.zoom };
      const moved = px(Math.hypot(now.x - at.x, now.y - at.y));
      const seen = seenBox(g, view);
      const inBoard = holds(seen, now);
      const cover1 = covering(g, g.wrapper!);
      const lies = placed(g, g.wrapper!, kind);
      const above = px(Math.max(0, g.canvas.y + g.band - g.wrapper!.y));
      const written = changed(before, await texts(board));
      const out = await wayOut(board, id, seen);
      const palette = await pressable(node, ".djs-palette .entry");
      await ctx.shot(board, "armed");
      const pressed = await pressControl(board, id);
      checks.push(
        check(
          "files",
          written.length === 0,
          "wrong-data",
          written.length === 0 ? "no file written by the arming" : `written by the arming: ${written.join(", ")}`,
        ),
        check(
          "covers",
          lies.gap.x <= 1 && lies.gap.y <= 1,
          "broken",
          `after the arming a gap of ${pair(lies.gap, 1)} px is left on the axes the node is longer than the box (${cover1.text})`,
        ),
        check(
          "Done control",
          out.controlTakes && pressed.takes && pressed.preview,
          "broken",
          `the toolbar's Done control ${pressedText(pressed)}; the header's Done is ${out.headerInReach ? "in reach" : "out of reach"}`,
        ),
      );
      if (way === "dbl")
        checks.push(
          check(
            "point",
            moved <= 1,
            // a node that covered the box must not move at all; one that left a gap moves by the gap, which is the rule
            cover0.both ? "broken" : "degraded",
            `the double-clicked point moved ${moved} px to ${pair(now)}${inBoard ? "" : ", out of the board"}; before the arming the node ${cover0.both ? "covered the box on both axes" : `did not cover the box (${cover0.text})`}${start.round5 === undefined ? "" : `; round 5 measured ${start.round5} px for this start`}`,
          ),
        );
      return {
        zoomAsked: start.zoom,
        zoomInEffect: v1.zoom,
        key: [
          a.key,
          `before: the node ${cover0.both ? "covers" : "does NOT cover"} the box (x ${cover0.x ? "covered" : "a gap"}, y ${cover0.y ? "covered" : "a gap"})`,
          `the point at ${pair(at)} moved ${moved} px${inBoard ? "" : " OUT of the board"}, ${arming.moves.length} transition(s)`,
          `after: gap ${pair(lies.gap, 1)} px, top ${above} px above the band's edge, header Done ${out.headerInReach ? "in reach" : "OUT of reach"}, control ${pressed.takes && pressed.preview ? "ends the editing" : "FAILS"}, palette ${palette.take}/${palette.total}`,
        ].join("; "),
        checks,
        measured: {
          ...a.measured,
          start: start.name,
          window: view,
          doubleClickAt: at,
          coveredBefore: { x: cover0.x, y: cover0.y, text: cover0.text },
          coversAfter: { x: cover1.x, y: cover1.y, text: cover1.text },
          pointNow: { x: px(now.x), y: px(now.y) },
          pointMovedPx: moved,
          pointInBoard: inBoard,
          round5MovedPx: start.round5 ?? null,
          transitions: arming.moves.length,
          gapAfterPx: { x: px(lies.gap.x), y: px(lies.gap.y) },
          topAboveBandEdgePx: above,
          headerDone: out.headerDone,
          headerDoneInReach: out.headerInReach,
          controlTakesPress: out.controlTakes,
          pressed,
          palette,
        },
        volatile: a.volatile,
      };
    },
  };
}

// ── R15 what the default exact1 costs a person above zoom 1 ──────────────────

function r15(strategy: Strategy, way: "shape" | "button", zoom: number): Task {
  return {
    case: "R15 exact1-cost",
    id: `R15|bpmn|${strategy}|default|${way}|${zoom}`,
    notation: "bpmn",
    strategy,
    policy: "default",
    async run(ctx) {
      const [spec, id] = [SPECS.bpmn, "m-bpmn"];
      // at zoom 4 a node at ORIGIN has its Edit button right of the window: started further left, as in R1
      const origin = way === "button" && zoom === 4 ? { x: -1400, y: 80 } : ORIGIN;
      const board = await ctx.open(matrix(strategy, ["bpmn"], zoom, {}, origin));
      const node = await board.node(id);
      const target = way === "shape" ? await previewPoint(board, node, "bpmn", "shape") : undefined;
      // the shape the person looks at: the double-clicked one, or (Edit) the first task
      const named = target && (await node.elementBox(target.on)) ? target.on : spec.shapes[0]!;
      const g0 = await geometry(board, id);
      const view = board.page.viewportSize() ?? WINDOW;
      const boxBefore = await node.elementBox(named);
      const seenBefore = !!boxBefore && holds(seenBox(g0, view), centre(boxBefore));
      const before = await texts(board);
      const arming = await armBy(board, node, "bpmn", way, target);
      const policy = (await board.armPolicy(id))!;
      const a = armingChecks(arming, policy.armzoom, policy.motion);
      const checks = [...a.checks];
      if (!arming.armed)
        return {
          zoomAsked: zoom,
          zoomInEffect: arming.viewport.zoom,
          key: `${a.key}; not armed`,
          checks,
          measured: a.measured,
        };
      const g = arming.after;
      const boxAfter = await node.elementBox(named);
      const travel =
        boxBefore && boxAfter
          ? { x: centre(boxAfter).x - centre(boxBefore).x, y: centre(boxAfter).y - centre(boxBefore).y }
          : null;
      const far = travel ? px(Math.hypot(travel.x, travel.y)) : null;
      const factor = boxBefore && boxAfter && boxBefore.width > 0 ? round(boxAfter.width / boxBefore.width, 3) : null;
      const under = arming.pointer && way === "shape" ? (await node.hit(arming.pointer)).element === named : null;
      const seenAfter = !!boxAfter && holds(seenBox(g, view), centre(boxAfter));
      const wrapper = g.wrapper!;
      const corner = { x: wrapper.x - g.canvas.x, y: wrapper.y - g.canvas.y };
      const inBox = round(share(wrapper, innerBox(g)) * 100, 0);
      const written = changed(before, await texts(board));
      await ctx.shot(board, "armed");
      const move = await moveShape(board, node, spec);
      checks.push(
        check(
          "files",
          written.length === 0,
          "wrong-data",
          written.length === 0 ? "no file written by the arming" : `written by the arming: ${written.join(", ")}`,
        ),
        check(
          "in view",
          seenAfter,
          "degraded",
          `${named} lies ${seenAfter ? "in" : "OUTSIDE"} the board after the arming (before: ${seenBefore ? "in" : "outside"})`,
        ),
      );
      if (under !== null)
        checks.push(
          check(
            "under the pointer",
            under,
            "degraded",
            `the double-clicked shape ${named} is ${under ? "still" : "no longer"} under the pointer; it travelled ${far ?? "?"} px`,
          ),
        );
      checks.push(didCheck("move", move));
      return {
        zoomAsked: zoom,
        zoomInEffect: arming.viewport.zoom,
        key: `${a.key}; ${named} travelled ${far ?? "?"} px${travel ? ` (${pair(travel, 1)})` : ""} on the screen and is x${factor ?? "?"} as wide${under === null ? "" : under ? ", still under the pointer" : ", NO LONGER under the pointer"}${seenAfter ? "" : ", OUTSIDE the board"}; the node ends at ${pair(corner)} of the board (${px(g.canvas.width, 0)} x ${px(g.canvas.height, 0)}), ${inBox} % in the box, ${arming.moves.length} transition(s); ${move.text}`,
        checks,
        measured: {
          ...a.measured,
          landmark: named,
          landmarkBeforePx: boxBefore && { x: px(boxBefore.x), y: px(boxBefore.y), width: px(boxBefore.width) },
          landmarkAfterPx: boxAfter && { x: px(boxAfter.x), y: px(boxAfter.y), width: px(boxAfter.width) },
          travelPx: travel && { x: px(travel.x), y: px(travel.y) },
          travelFarPx: far,
          widthFactor: factor,
          stillUnderPointer: under,
          landmarkInBoard: { before: seenBefore, after: seenAfter },
          nodeCornerPx: { x: px(corner.x), y: px(corner.y) },
          nodeInBoxPct: inBox,
          transitions: arming.moves.length,
          move: move.measured,
        },
        volatile: a.volatile,
      };
    },
  };
}

// ── the rows ─────────────────────────────────────────────────────────────────

function tasksFor(strategy: Strategy): Task[] {
  const tasks: Task[] = [];
  // R1: the whole grid on bpmn; the other kinds on six zooms by a double-click and by the Edit button,
  // and once per further way
  for (const armzoom of ARM_ZOOMS) {
    for (const way of WAYS) {
      for (const zoom of R1_ZOOMS) {
        // at zoom 4 a node at ORIGIN has its Edit button 1100 px right of the window: started further left
        const far = way === "button" && zoom === 4 ? { origin: { x: -1400, y: 80 } } : {};
        tasks.push(r1("bpmn", strategy, { armzoom }, zoom, way, undefined, far));
      }
    }
  }
  // the node in the middle of the board, with room on all sides: nothing has to be shifted, so the anchor stays
  for (const way of ["shape", "canvas"] as const) {
    for (const zoom of [0.1, 0.25, 0.5, 0.73]) {
      const room = { origin: { x: 900, y: 600 }, room: true, note: "room" };
      tasks.push(r1("bpmn", strategy, { armzoom: "min1" }, zoom, way, undefined, room));
    }
  }
  // device pixel ratio 2
  for (const kind of ["bpmn", "dmn-table"] as const) {
    tasks.push(r1(kind, strategy, { armzoom: "min1" }, 0.5, "shape", undefined, { dpr: 2, note: "dpr 2" }));
  }
  for (const kind of KINDS.filter((one) => one !== "bpmn")) {
    for (const armzoom of ARM_ZOOMS) {
      for (const way of ["shape", "button"] as const) {
        for (const zoom of [0.25, 0.5, 0.73, 1, 1.5, 2]) tasks.push(r1(kind, strategy, { armzoom }, zoom, way));
      }
    }
    for (const way of ["canvas", "hook", "url"] as const) {
      if (!(kind === "dmn-table" && way === "url")) tasks.push(r1(kind, strategy, { armzoom: "min1" }, 0.5, way));
    }
  }
  // the edge of "nearly 1": 1.01 is taken for 1, 1.011 is not
  for (const way of ["shape", "hook"] as const)
    for (const zoom of [1.01, 1.011]) tasks.push(r1("bpmn", strategy, { armzoom: "min1" }, zoom, way));
  // the default rules, named by no parameter
  for (const kind of KINDS) tasks.push(r1(kind, strategy, {}, 0.5, "shape"));
  // R2: the rows of round 5, each with its rule in the URL
  for (const kind of KINDS) {
    for (const zoom of [1, 1.5, 2, 4]) tasks.push(r2(kind, strategy, "min1", zoom));
    for (const zoom of [1.5, 2, 4]) tasks.push(r2(kind, strategy, "exact1", zoom));
  }
  // a toolbar step and a zoom that is no round number
  for (const kind of ["bpmn", "dmn-table"] as const)
    for (const zoom of [1.2, 1.37]) tasks.push(r2(kind, strategy, "min1", zoom));
  // round 6: the default (exact1 for an overlay node) from above 1, the literal expression among the kinds
  for (const kind of [...KINDS, "dmn-literal"] as const)
    for (const zoom of [1.02, 1.2, 1.37, 1.5, 2, 4]) tasks.push(r2(kind, strategy, undefined, zoom));
  // and beside them under min1: the literal expression, and the table at the first zoom min1 leaves alone
  for (const zoom of [1, 1.37, 1.5, 2]) tasks.push(r2("dmn-literal", strategy, "min1", zoom));
  tasks.push(r2("dmn-table", strategy, "min1", 1.02));
  // R3
  for (const symptom of Object.keys(SYMPTOM_KIND) as Symptom[]) {
    for (const zoom of [0.25, 0.5, 0.73]) for (const off of [false, true]) tasks.push(r3(symptom, strategy, zoom, off));
  }
  // R4: seven windows x three node sizes x five ways of arming, and the two windows that shrink while armed
  for (const view of R4_WINDOWS)
    for (const size of R4_SIZES) for (const way of R4_WAYS) tasks.push(r4(strategy, view, size, way));
  for (const view of [
    { width: 1280, height: 720 },
    { width: 1000, height: 600 },
  ])
    tasks.push(r4resize(strategy, view));
  // R5: 100 % changes nothing at zoom 1, so those rows are armed at 1.5; one row shows the no-op
  for (const armedzoom of ["disarm", "lock", "free"] as const) {
    for (const state of Object.keys(R5_GESTURES) as State[]) {
      for (const gesture of R5_GESTURES[state])
        tasks.push(r5(strategy, { armedzoom }, state, gesture, gesture === "tb-100" ? 1.5 : 1));
    }
  }
  tasks.push(r5(strategy, { armedzoom: "disarm" }, "none", "tb-100", 1));
  // round 6: under the default exact1 a node asked at 1.5 is armed at 1, where 100 % changes nothing.
  // The rows of round 5 (armed AT 1.5, 100 % zooms the board) are these, with min1 in the URL
  for (const armedzoom of ["disarm", "lock", "free"] as const)
    for (const state of ["none", "bpmn-label"] as const)
      tasks.push(r5(strategy, { armzoom: "min1", armedzoom }, state, "tb-100", 1.5));
  // what a commit by a click on the pane writes: the reference of "nothing else changed"
  for (const state of TEXT_STATES) tasks.push(r5(strategy, { armedzoom: "disarm" }, state, "pane-click", 1));
  // R6
  for (const motion of [1500, undefined])
    for (const interrupt of INTERRUPTS) tasks.push(r6(strategy, interrupt, motion));
  // R7
  for (const armreturn of ["back", "stay"] as const) {
    for (const history of ["moved", "panned", "b-from-a"] as const) {
      for (const end of ["done", "pane"] as const) tasks.push(r7(strategy, armreturn, history, end));
    }
    tasks.push(r7(strategy, armreturn, "zoom-disarm", "wheel"));
  }
  tasks.push(r7(strategy, "back", "moved", "hook"));
  // R8
  for (const variant of ["plain", "label", "table-cell", "lock"] as const) tasks.push(r8(strategy, variant));
  // R9: the rules by parameter on two other strategies
  const explicit: Rules = { armzoom: "min1", armedzoom: "disarm" };
  for (const other of ["iframe", "plugin"] as const) {
    const name = "R9 other-strategies";
    for (const way of ["shape", "button", "hook"] as const) {
      for (const zoom of [0.5, 1, 1.5]) tasks.push(r1("bpmn", other, explicit, zoom, way, name));
    }
    tasks.push(r1("dmn-table", other, explicit, 0.5, "shape", name));
    for (const state of ["none", "bpmn-label"] as const) {
      for (const gesture of ["pane", "tb-out", "hook", "editor"] as const)
        tasks.push(r5(other, explicit, state, gesture, 1, name));
    }
    tasks.push(r5(other, explicit, "bpmn-label", "pane-click", 1, name));
    tasks.push(r5(other, explicit, "held-in", "hook", 1, name), r5(other, explicit, "held-in", "none", 1, name));
    tasks.push(r5(other, explicit, "held-out", "pane", 1, name), r5(other, explicit, "held-out", "none", 1, name));
    tasks.push(r5(other, { armzoom: "min1", armedzoom: "lock" }, "none", "pane", 1, name));
  }
  // R10
  for (const zoom of [0.5, 1]) for (const motion of [undefined, 0]) tasks.push(r10time(strategy, zoom, motion));
  tasks.push(r10frames(strategy, 1), r10frames(strategy, 20));
  // R11
  for (const way of ["shape", "button", "hook", "back", "control"] as const) tasks.push(r11(strategy, way));
  // R12
  for (const by of ["wheel", "toolbar", "done"] as const) tasks.push(r12(strategy, "stress-bpmn", by));
  for (const by of ["wheel", "done"] as const) tasks.push(r12(strategy, "stress-wardley", by));
  tasks.push(r12(strategy, "compare", "wheel"));
  // R13 (added): what a disarm by a zoom costs the person who goes on editing
  for (const kind of ["bpmn", "dmn-table", "wardley"] as const) tasks.push(r13(strategy, kind));
  // R14 (round 6): a node larger than the box, armed above zoom 1 under min1, by a double-click and by the hook
  for (const start of R14_STARTS) for (const way of ["dbl", "hook"] as const) tasks.push(r14(strategy, start, way));
  // R15 (round 6): what the default exact1 costs a person above zoom 1
  for (const way of ["shape", "button"] as const)
    for (const zoom of [1.2, 1.5, 2, 4]) tasks.push(r15(strategy, way, zoom));
  for (const zoom of [1.2, 1.5, 2, 4]) tasks.push(r10time(strategy, zoom, undefined, 5, "R15 exact1-cost"));
  for (const kind of ["bpmn", "dmn-table", "wardley"] as const) tasks.push(r13(strategy, kind, "in"));
  return tasks;
}

// ── run ──────────────────────────────────────────────────────────────────────

function judge(checks: readonly Check[]): { verdict: Verdict; decidedBy?: string } {
  let verdict: Verdict = "ok";
  let decidedBy: string | undefined;
  for (const one of checks) {
    if (one.ok) continue;
    if (WORST.indexOf(one.fails) > WORST.indexOf(verdict)) {
      verdict = one.fails;
      decidedBy = `${one.name}: ${one.detail}`;
    }
  }
  return decidedBy === undefined ? { verdict } : { verdict, decidedBy };
}

const fileName = (id: string): string => id.replace(/[^a-z0-9.]+/gi, "_");

async function once(harness: Harness, task: Task): Promise<Row> {
  const started = Date.now();
  const boards: Board[] = [];
  const row: Row = {
    case: task.case,
    id: task.id,
    notation: task.notation,
    strategy: task.strategy,
    policy: task.policy,
    status: "failed",
    verdict: "unmeasured",
    problems: [],
    shots: [],
    ms: 0,
    load: 0,
  };
  const ctx: Ctx = {
    harness,
    async open(query, options) {
      const board = await harness.open(query, { viewport: WINDOW, ...options });
      boards.push(board);
      return board;
    },
    async shot(board, name, clip) {
      const path = outPath(`shots/${fileName(task.id)}-${name}.png`);
      await board.screenshot(path, clip);
      row.shots.push(path);
      return path;
    },
  };
  const problems = async (): Promise<string[]> => {
    const found: string[] = [];
    for (const board of boards) {
      if (board.page.isClosed())
        found.push(...board.violations, ...board.errors.filter((line) => !ALLOW.some((pattern) => pattern.test(line))));
      else found.push(...(await board.problems({ allow: ALLOW }).catch((error: unknown) => [String(error)])));
    }
    return found;
  };
  try {
    const outcome = await task.run(ctx);
    row.problems = await problems();
    outcome.checks.push(
      check(
        "console",
        row.problems.length === 0,
        "degraded",
        row.problems.length === 0 ? "no console error, page error or log line" : row.problems.join(" | ").slice(0, 300),
      ),
    );
    Object.assign(row, outcome, judge(outcome.checks));
    row.status = "measured";
    const open = boards.filter((board) => !board.page.isClosed());
    if (row.verdict !== "ok" && open.length > 0 && !row.shots.some((path) => path.endsWith("-end.png"))) {
      await ctx.shot(open[open.length - 1]!, "end").catch(() => undefined);
    }
  } catch (error) {
    row.problems = await problems().catch(() => []);
    const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
    if (error instanceof Unmeasured) {
      row.status = "unmeasured";
      row.reason = message;
    } else {
      row.status = "failed";
      row.reason = `harness: ${message}`;
    }
    row.key = row.status;
    const open = boards.filter((board) => !board.page.isClosed());
    if (open.length > 0) await ctx.shot(open[open.length - 1]!, "end").catch(() => undefined);
  }
  for (const board of boards) {
    if (board.page.isClosed()) continue;
    // a held key or button of a half-done gesture must not leak into the close
    await board.release(["Control", "Shift"]).catch(() => undefined);
    await board.close().catch(() => undefined);
  }
  row.ms = Date.now() - started;
  row.load = round(loadavg()[0]!, 1);
  return row;
}

async function measure(harness: Harness, task: Task): Promise<Row> {
  const runs: Row[] = [];
  for (let index = 0; index < repeat; index++) runs.push(await once(harness, task));
  const row = runs[0]!;
  if (repeat > 1) {
    const verdicts = runs.map((each) => each.verdict);
    const keys = runs.map((each) => each.key ?? "");
    row.repeats = { verdicts, keys, agree: new Set(verdicts).size === 1 && new Set(keys).size === 1 };
    row.problems = runs.flatMap((each) => each.problems);
    row.ms = runs.reduce((sum, each) => sum + each.ms, 0);
    if (runs.some((each) => each.status === "failed")) row.status = "failed";
  }
  return row;
}

/**
 * Rules that need another row. A text row of R5 must have written what a commit by a click on the
 * bare pane writes and nothing else (the row `pane-click` of the same state and strategy). A held
 * shape must land where it lands without any zoom gesture (the row `none` of the same state,
 * strategy and rules).
 */
function crossRules(rows: Row[]): void {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const part = (row: Row, index: number): string => row.id.split("|")[index] ?? "";
  for (const row of rows) {
    if (row.status !== "measured" || !row.checks || !row.measured || !/^R[59]\b/.test(row.case)) continue;
    const [tag, state, strategy, policy, gesture, zoom] = [
      part(row, 0),
      part(row, 1),
      part(row, 2),
      part(row, 3),
      part(row, 4),
      part(row, 5),
    ];
    if (TEXT_STATES.includes(state as State) && gesture !== "pane-click" && row.measured.textInFile === true) {
      const reference =
        byId.get(`${tag}|${state}|${strategy}|${policy.replace(/\/(lock|free)\//, "/disarm/")}|pane-click|1`) ??
        byId.get(`R5|${state}|${strategy}|-/disarm/-|pane-click|1`);
      const mine = (row.measured.newLines as string[] | undefined) ?? [];
      const theirs = (reference?.measured?.newLines as string[] | undefined) ?? null;
      if (theirs && row.measured.committedBy !== "typing") {
        const extra = mine.filter((line) => !theirs.includes(line));
        const missing = theirs.filter((line) => !mine.includes(line));
        row.checks.push(
          check(
            "nothing else",
            extra.length === 0 && missing.length === 0,
            "wrong-data",
            extra.length === 0 && missing.length === 0
              ? `the file has the same ${mine.length} new line(s) a commit by a pane click writes`
              : `against a commit by a pane click: ${extra.length} further line(s) (${extra.slice(0, 2).join(" ; ").slice(0, 160)}), ${missing.length} missing`,
          ),
        );
      }
    }
    if (state.startsWith("held") && gesture !== "none") {
      const control = byId.get(`${tag}|${state}|${strategy}|${policy}|none|${zoom}`);
      const mine = row.measured.held as { movedUnits: Point | null; fileWritten: boolean } | undefined;
      const theirs = control?.measured?.held as { movedUnits: Point | null; fileWritten: boolean } | undefined;
      if (mine && theirs) {
        const same =
          mine.fileWritten === theirs.fileWritten &&
          !!mine.movedUnits === !!theirs.movedUnits &&
          (!mine.movedUnits ||
            !theirs.movedUnits ||
            (Math.abs(mine.movedUnits.x - theirs.movedUnits.x) <= 10 &&
              Math.abs(mine.movedUnits.y - theirs.movedUnits.y) <= 10));
        row.checks.push(
          check(
            "drop as without the zoom",
            same,
            mine.fileWritten ? "wrong-data" : "broken",
            `the shape moved ${mine.movedUnits ? pair(mine.movedUnits) : "?"} units (file ${mine.fileWritten ? "written" : "unchanged"}); without any zoom gesture ${theirs.movedUnits ? pair(theirs.movedUnits) : "?"} units (file ${theirs.fileWritten ? "written" : "unchanged"}); the same within one grid step: ${same}`,
          ),
        );
      }
    }
    Object.assign(row, { decidedBy: undefined }, judge(row.checks));
  }
}

const line = (row: Row): string =>
  [
    row.id.padEnd(58),
    row.verdict.padEnd(11),
    `${row.zoomAsked ?? "-"}>${row.zoomInEffect ?? "-"}`.padEnd(12),
    (row.key ?? "").slice(0, 150),
    row.reason ?? row.decidedBy?.slice(0, 160) ?? "",
    row.more ? `\n    + ${row.more.slice(0, 220)}` : "",
  ].join(" ");

function markdown(rows: readonly Row[]): string {
  const out = [
    "| Case | Rows | ok | degraded | broken | wrong-data | unmeasured |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const name of unique(rows.map((row) => row.case))) {
    const mine = rows.filter((row) => row.case === name);
    const count = (verdict: Verdict): number => mine.filter((row) => row.verdict === verdict).length;
    out.push(
      `| ${name} | ${mine.length} | ${count("ok")} | ${count("degraded")} | ${count("broken")} | ${count("wrong-data")} | ${count("unmeasured")} |`,
    );
  }
  out.push(
    "",
    "| Row | Policy | Zoom asked | Zoom in effect | Verdict | Measured | Decided by |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  const cell = (text: string): string => text.replace(/\|/g, "\\|");
  for (const row of rows) {
    out.push(
      `| ${cell(row.id)} | ${row.policy} | ${row.zoomAsked ?? ""} | ${row.zoomInEffect ?? ""} | ${row.verdict} | ${cell(row.key ?? "")}${row.more ? `<br>${cell(row.more)}` : ""} | ${cell(row.reason ?? row.decidedBy ?? "")} |`,
    );
  }
  return `${out.join("\n")}\n`;
}

const selected = (task: Task): boolean =>
  caseFilter.length === 0 ||
  caseFilter.some(
    (entry) => task.case.startsWith(entry) || task.id.startsWith(entry) || task.case.split(" ")[0] === entry,
  );

const all = strategies.flatMap((strategy) => tasksFor(strategy));
if (caseFilter.includes("list")) {
  for (const task of all) console.log(`${task.case.padEnd(24)} ${task.id}`);
  console.log(`${all.length} rows`);
} else {
  await run(async (harness) => {
    const tasks = all.filter(selected);
    const started = Date.now();
    const done: Row[] = [];
    const report = (index: number, row: Row): void => {
      done[index] = row;
      console.log(line(row));
      for (const problem of row.problems) console.log(`    ${problem.slice(0, 220)}`);
    };
    // rows side by side, each on pages of its own; rows that take times one after another, afterwards
    const side = tasks.map((task, index) => ({ task, index })).filter((one) => !one.task.serial);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const mine = side[next++];
        if (!mine) return;
        report(mine.index, await measure(harness, mine.task));
      }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, side.length) }, worker));
    for (const [index, task] of tasks.entries()) {
      if (task.serial) report(index, await measure(harness, task));
    }
    const rows = done.filter(Boolean);
    crossRules(rows);
    const count = (verdict: Verdict): number => rows.filter((row) => row.verdict === verdict).length;
    const failed = rows.filter((row) => row.status === "failed").length;
    const path = writeResult("arm-rules", {
      what: "board spike battery arm-rules: the arm rules themselves, one fresh page per row",
      run: {
        date: new Date().toISOString(),
        chromium: harness.browser.version(),
        seconds: Math.round((Date.now() - started) / 1000),
        loadAtEnd: round(loadavg()[0]!, 1),
      },
      config: {
        strategies,
        cases: unique(tasks.map((task) => task.case)),
        filter: caseFilter,
        repeat,
        jobs,
        window: { ...WINDOW, deviceScaleFactor: 1 },
        nodeOrigin: ORIGIN,
        margin: MARGIN,
        nearlyOne: NEARLY_ONE,
        marker: MARKER,
      },
      rows,
    });
    const table = outPath("arm-rules.md");
    writeFileSync(table, markdown(rows));
    console.log(
      `\n${rows.length} rows in ${Math.round((Date.now() - started) / 1000)} s: ${count("ok")} ok, ${count("degraded")} degraded, ` +
        `${count("broken")} broken, ${count("wrong-data")} wrong-data, ${count("unmeasured")} unmeasured; ${failed} failed in the harness\n${path}\n${table}`,
    );
    return failed;
  });
}
