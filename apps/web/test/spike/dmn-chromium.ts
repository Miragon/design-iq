/**
 * The DMN battery of the board spike: dmn-js in all its views, per strategy and board zoom. A check
 * run by hand, not by `pnpm test` or CI (lib.ts starts the dev server and a sandboxed Chromium).
 *
 *   PORT=5433 CACHE_DIR=<scratch>/vite-cache OUT_DIR=<scratch> node apps/web/test/spike/dmn-chromium.ts
 *   STRATEGIES=plugin,shim ZOOMS=0.5,1 CASES=drd,table-feel REPEAT=2 node apps/web/test/spike/dmn-chromium.ts
 *   STRATEGIES=naive,counter,overlay,iframe,plugin,shim ZOOMS=0.5,0.73,1,1.5,2 VARIANTS=as-built (all six, as built)
 *
 * dmn-js has a DRD (a diagram-js canvas) and HTML views without any canvas: the decision table
 * (table-js) and the literal expression. The HTML views are where a strategy that only steers a
 * viewbox has nothing to hold on to, so most cases are there.
 *
 * One fresh page per case x strategy x zoom (board=matrix with the one DMN node, the viewport from
 * the URL, so the editor MOUNTS at that zoom). Every press is hit-tested first: a control that no
 * point of takes a press is a result ("broken", with what lies over it), never a click on the
 * board. Every row says what was done, what was expected and why, what was measured, and a verdict
 * computed from the numbers by the rule written beside the case.
 *
 * Nothing here is keyed on a strategy's name. What differs is read off the page: `scale`, the
 * screen px per layout px of the node's document (the board zoom where the board scales the
 * editor, 1 where the host has a net scale of 1), and whether the node is a frame.
 *
 * Geometry is TRUE screen geometry: lib.ts's probe, and `window.__boardSpikeNative` in every
 * evaluate of this file (the shim strategy patches the plain methods while a node is armed).
 *
 * Views other than the DRD are opened with a script click on the DRD's drill-down button, so that
 * a table case does not depend on whether the button can be reached: `drd-open-table` measures that.
 *
 * The arm rules (round 5, lib.ts's header): arming may move the board, so the zoom a row ASKED for
 * (`zoom`, the URL's) is not always the zoom its editor runs at. Every row carries both: `zoom` and
 * `zoomInEffect`, with the viewport and the node's corner after arming, the rules of the node and
 * what they did (`arm`). A case computes from the zoom in effect (`Ctx.zoom`) and from where the
 * node is, never from the URL. Under armedzoom=disarm the one case that zooms the board under the
 * armed editor (switch-views-zoomed) finds the node a preview after the zoom, which is what the
 * node's rule specifies (the policy is read off the page, `board.armPolicy`). A preview takes no
 * press, so the case arms the node again, as a person has to, and goes on from there: View DRD is
 * pressed by pointer in an armed editor (round 6; until then a script click on the preview's
 * button). A disarm that was late or a zoom tick under an armed node (`lateDisarms`,
 * `armedZoomTicks` of the rules' counters) makes the row broken. Under armedzoom=free the case is
 * what it was.
 *
 * Two variants. "as-built" is the page as it is. "node-fixed" repeats the cases that press a control
 * of an HTML view, wherever the armed editor's host lies inside a board node (read off the page), with
 * two bugs of the board's node lifted from the harness side (UNSTOP_CLICKS, UNFOCUSABLE below): as
 * built, the node stops every click before the document, where dmn-js's HTML views listen, and its
 * focusable wrapper takes the focus from their lists. Without the second variant such a row would
 * say nothing about the strategy. The spike's source is not touched. Round 4 fixed both bugs in the
 * board itself: the variant is kept so that as built and emulated can be shown equal, and
 * VARIANTS=as-built is the run that counts.
 *
 * Console: exactly KNOWN_CONSOLE.feelEditor is allowed (the FEEL cell editor's highlighter on its
 * first focus); each row counts how often it came (`feelErrors`).
 *
 * Exit code as in smoke-chromium.ts: 1 only when the harness failed, that is a case threw (wrong
 * page, not mounted, a navigation, a timeout) or the page had a console error, a page error or a
 * log line that is not allowed. A verdict is a strategy's result and never fails the run.
 *
 * Environment: STRATEGIES (default naive,counter,overlay,iframe), ZOOMS (default 0.5,0.73,1,1.5),
 * CASES (comma list; a case runs when its name starts with one entry), REPEAT (default 1),
 * VARIANTS (default as-built,node-fixed), PARALLEL (pages measured at the same time, each in a
 * browser context of its own; default 3, and 1 gave the same rows), NOTATIONS (must contain dmn,
 * the only notation here), SHOTS (comma list of case prefixes, or `all`: a PNG of the node at the
 * end of the case and one while a pad, popup, label editor, context menu or list of the case is
 * open, under <OUT_DIR>/shots), plus lib.ts's PORT, BASE, CACHE_DIR, OUT_DIR, OUT.
 * Results: <OUT_DIR>/dmn.json and <OUT_DIR>/dmn.md.
 */
import { writeFileSync } from "node:fs";

import {
  aimAt,
  type ArmCounters,
  type Board,
  type Box,
  centre,
  clearEvents,
  type Harness,
  KNOWN_CONSOLE,
  type NativeGeometry,
  type NodeHandle,
  outPath,
  type Point,
  recordEvents,
  round,
  run,
  type ScreenMap,
  seenEvents,
  STRATEGIES,
  type Strategy,
  toLocal,
  toScreen,
  type Viewport,
  writeResult,
} from "./lib.ts";

type NativeWindow = Window & { __boardSpikeNative?: NativeGeometry };

const list = <T extends string>(name: string, all: readonly T[], fallback: readonly T[]): T[] => {
  const wanted = (process.env[name] ?? "").split(",").filter(Boolean);
  return wanted.length === 0 ? [...fallback] : all.filter((one) => wanted.includes(one));
};
const strategies = list("STRATEGIES", STRATEGIES, ["naive", "counter", "overlay", "iframe"]);
const zooms = (process.env.ZOOMS ?? "0.5,0.73,1,1.5").split(",").map(Number).filter(Boolean);
const caseFilter = (process.env.CASES ?? "").split(",").filter(Boolean);
const repeats = Math.max(1, Math.round(Number(process.env.REPEAT ?? 1)) || 1);
const shots = (process.env.SHOTS ?? "").split(",").filter(Boolean);
/** pages measured at the same time, each in a browser context of its own */
const parallel = Math.max(1, Math.round(Number(process.env.PARALLEL ?? 3)) || 1);
const notationWanted = (process.env.NOTATIONS ?? "dmn").split(",").includes("dmn");
const VARIANTS = ["as-built", "node-fixed"] as const;
type Variant = (typeof VARIANTS)[number];
const variants = list("VARIANTS", VARIANTS, VARIANTS);

const NODE = "m-dmn";
const FILE = "processes/credit-limit-check.dmn";
/** where the node's top-left corner sits in the canvas: clear of the toolbar */
const ORIGIN = { x: 60, y: 80 };
/** screen px a placement may be off before it counts as displaced */
const PLACE_TOL = 3;
/**
 * How long an edit may take to show in the file, and chrome to appear. Generous on purpose: an editor
 * writes about 350 ms after a gesture, but on a machine under load (other batteries beside this one)
 * it took seconds, and a wait that gives up early turns a working control into a wrong "broken".
 */
const WRITE_MS = 5000;
const SHOW_MS = 3000;
/** the smallest text a person reads on screen, px */
const READABLE_PX = 9;

const DECISION = "credit-limit-check";
const INPUTS = ["InputData_segment", "InputData_order_value", "InputData_overdue"] as const;
const SHAPES = [DECISION, ...INPUTS] as const;
const RULES = [
  "Rule_blocked_customer",
  "Rule_too_many_overdue",
  "Rule_key_account",
  "Rule_small_order",
  "Rule_manual_review",
] as const;

type Verdict = "ok" | "degraded" | "broken" | "wrong-data" | "unmeasured";

interface Outcome {
  verdict: Verdict;
  /** the headline of the row: the measured quantity in one short string */
  short: string;
  measured: Record<string, unknown>;
}

interface Ctx {
  board: Board;
  node: NodeHandle;
  strategy: Strategy;
  /** the board zoom IN EFFECT once the node was armed (the arm rules may have moved the board), not the one asked for */
  zoom: number;
  /** the node is a frame: its document is not the board page's */
  frame: boolean;
  /** SHOTS only: a PNG of the node and of what matches `chrome` (an open list, menu, popup), taken while it is open */
  shot(what: string, chrome: string): Promise<void>;
}

interface CaseDef {
  name: string;
  view: "drd" | "decisionTable" | "literalExpression";
  did: string;
  expected: string;
  /** how the verdict follows from the numbers */
  rule: string;
  /** the case presses controls of an HTML view (click handlers at the document): it has a node-fixed variant */
  clicks?: true;
  run(c: Ctx): Promise<Outcome>;
}

interface Row {
  case: string;
  notation: "dmn";
  strategy: Strategy;
  /** the board zoom the row asked for (the URL's) */
  zoom: number;
  /** the board zoom the armed editor ran at: the viewport read after arming */
  zoomInEffect?: number;
  /** the viewport after arming, and the node's top-left corner against the board's then (the URL put it at ORIGIN) */
  viewportArmed?: Viewport;
  nodeAt?: Point;
  /** the arm rules of the node, as "armzoom/armedzoom/armreturn" */
  armRules?: string;
  /** what the arm rules did until the end of the row (moves of the board, disarms before a zoom, refused zooms) */
  arm?: ArmCounters;
  repeat: number;
  /** "node-fixed": with the node's click stop and its focusable wrapper lifted (see the header) */
  variant: Variant;
  view: CaseDef["view"];
  did: string;
  expected: string;
  rule: string;
  /** "failed": the harness or the script failed, the row says nothing about the strategy */
  status: "measured" | "unmeasured" | "failed";
  verdict: Verdict;
  short: string;
  measured: Record<string, unknown>;
  /** why a row is unmeasured or failed */
  reason?: string;
  /** client size over layout size of the editor's host in its own document */
  netScale?: number;
  /** screen px per layout px of the node's document */
  scale?: number;
  frame?: boolean;
  /** the armed editor's host lies inside a board node (not in a layer of its own, not in a frame) */
  hostInNode?: boolean;
  armedAfter?: boolean;
  /** engine mounts of the node: 1 */
  mounts?: number;
  /** clicks of the case inside the editor, and how many of them the document saw; focus changes to the node's wrapper */
  presses?: PressLog;
  /** how often KNOWN_CONSOLE.feelEditor came (allowed) */
  feelErrors: number;
  /** console errors, page errors and log lines that are not allowed */
  problems: string[];
  ms: number;
}

/** a case could not run, for a reason that is the script's or the page's and no strategy's result */
class Unmeasured extends Error {}

/**
 * The node-fixed variant only, as an init script of the page. The armed node body stops `click` and `dblclick`
 * in a React handler (nodes/model-node.tsx, `onClick={armed ? stop : undefined}`), and React stops
 * the NATIVE event with it, at its root container. dmn-js's HTML views are Inferno, which listens
 * for click and dblclick at the document: with the editor inside the node (every strategy but
 * overlay and iframe) none of their click handlers runs. This keeps React's own stop (React Flow
 * still sees nothing) and lets the native event go on to the document, which is what a fix of the
 * node would do.
 */
const UNSTOP_CLICKS = (): void => {
  for (const type of ["click", "dblclick"]) {
    window.addEventListener(
      type,
      (event) => {
        const stop = event.stopPropagation.bind(event);
        event.stopPropagation = () => {
          if ((event.currentTarget as Element | null)?.id === "root") return;
          stop();
        };
      },
      true,
    );
  }
};

/**
 * The node-fixed variant only, in the board page after arming. React Flow's node wrapper is focusable
 * (tabindex 0). A press on anything that is not focusable inside the node (an entry of a dmn-js
 * list) moves the focus to that wrapper, and dmn-js closes its list on any focus change to outside
 * it, before the mouse is released. Without the tabindex the press leaves the focus alone, as it
 * does in a page of the editor's own (`focusable: false` on the armed node would do it).
 */
const UNFOCUSABLE = (id: string): void => {
  document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.removeAttribute("tabindex");
};

/** counts, in the node's document: clicks of a person in the editor at the window and at the document, focus thefts */
interface PressLog {
  /** trusted click and dblclick events inside the editor, seen at the window (capture) */
  made: number;
  /** of those, the ones that bubbled up to the page's root element (React's root container in the board page) */
  atRoot: number;
  /** of those, the ones that reached the document (bubble), where dmn-js's HTML views listen */
  atDocument: number;
  /** focus changes to a board node's wrapper */
  focusToNodeWrapper: number;
}
type PressWindow = Window & { __dmnPresses?: PressLog };
const COUNT_PRESSES = (host: HTMLElement): void => {
  const page = window as PressWindow;
  if (page.__dmnPresses) return;
  const log: PressLog = (page.__dmnPresses = { made: 0, atRoot: 0, atDocument: 0, focusToNodeWrapper: 0 });
  const root = document.getElementById("root");
  const mine = (event: Event): boolean =>
    event.isTrusted && event.target instanceof Node && (host.contains(event.target) || host === event.target);
  for (const type of ["click", "dblclick"]) {
    window.addEventListener(type, (event) => void (mine(event) && log.made++), true);
    root?.addEventListener(type, (event) => void (mine(event) && log.atRoot++));
    document.addEventListener(type, (event) => void (mine(event) && log.atDocument++));
  }
  window.addEventListener(
    "focusin",
    (event) =>
      void (event.target instanceof Element && event.target.matches(".react-flow__node") && log.focusToNodeWrapper++),
    true,
  );
};
const READ_PRESSES = (): PressLog | null => (window as PressWindow).__dmnPresses ?? null;
const HOST_IN_NODE = (host: HTMLElement): boolean => !!host.closest(".react-flow__node");

// ── geometry ─────────────────────────────────────────────────────────────────

const px = (value: number): number => round(value, 1);
const pair = (point: Point): string => `${px(point.x)}/${px(point.y)}`;
const size = (box: Box): string => `${px(box.width)}x${px(box.height)}`;
const area = (box: Box | null): number => (box ? box.width * box.height : 0);
const far = (point: Point): number => Math.hypot(point.x, point.y);
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

function intersect(a: Box | null | undefined, b: Box | null | undefined): Box | null {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}
const inside = (inner: Box, outer: Box | null, slack = 0.5): boolean =>
  !!outer &&
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack &&
  inner.y + inner.height <= outer.y + outer.height + slack;

/** screen px per layout px of the node's document: the host's net scale times the frame's scale */
async function scaleOf(c: Ctx): Promise<number> {
  return (await c.node.netScale()) * (await c.node.map()).sx;
}

// ── what a point of the screen has (runs in the node's document) ─────────────

interface HitInfo {
  /** the element there belongs to this node's editor */
  mine: boolean;
  /** and it is, or lies in, what was asked for */
  match: boolean;
  what: string;
}

const HITS = (
  host: HTMLElement,
  arg: { points: Point[]; selector: string; exact: boolean; node: string | null },
): HitInfo[] => {
  const native = (window as NativeWindow).__boardSpikeNative;
  // the counter strategy's body-level popup host carries the node's id; a frame has none
  const popupHosts =
    arg.node === null
      ? []
      : [...document.querySelectorAll<HTMLElement>(".board-popup-host")].filter((one) => one.dataset.node === arg.node);
  return arg.points.map(({ x, y }) => {
    const element = native ? native.elementFromPoint(document, x, y) : document.elementFromPoint(x, y);
    const mine = !!element && (host.contains(element) || popupHosts.some((one) => one.contains(element)));
    const match = mine && !!element && (arg.exact ? element.matches(arg.selector) : !!element.closest(arg.selector));
    const what = element
      ? `${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "").trim().split(/\s+/).slice(0, 3).join(".")}`
      : "nothing";
    return { mine, match, what };
  });
};

/** runs in the board page: is the topmost element at each point the frame named `name` */
const ON_FRAME = (arg: { points: Point[]; name: string }): boolean[] => {
  const native = (window as NativeWindow).__boardSpikeNative;
  return arg.points.map(({ x, y }) => {
    const top = native ? native.elementFromPoint(document, x, y) : document.elementFromPoint(x, y);
    return top?.getAttribute("name") === arg.name;
  });
};

/** what each screen point has, for a person's press: in the top document AND in the node's own */
async function hits(c: Ctx, points: readonly Point[], selector: string, exact = false): Promise<HitInfo[]> {
  if (points.length === 0) return [];
  const map = await c.node.map();
  const local = points.map((point) => toLocal(map, point));
  const found = await c.node.inDocument(HITS, { points: local, selector, exact, node: c.frame ? null : NODE });
  if (!c.node.frame) return found;
  const onFrame = await c.board.page.evaluate(ON_FRAME, { points: [...points], name: c.node.frame.name() });
  return found.map((one, index) => (onFrame[index] ? one : { mine: false, match: false, what: "outside the frame" }));
}

interface Aim {
  /** a screen point of the box that takes a press for `selector`, the centre if it does; null when none does */
  point: Point | null;
  /** the centre itself takes the press */
  centre: boolean;
  /** share of a 5 x 5 grid of points over the box that takes the press */
  free: number;
  /** what lies at the centre */
  under: string;
}
const NO_AIM: Aim = { point: null, centre: false, free: 0, under: "not in the page" };
const GRID = [0.5, 0.3, 0.7, 0.1, 0.9];

/** where a person can press `box` and reach `selector`: hit-tested, each point at the centre of a px of the node's document */
async function aim(c: Ctx, box: Box | null | undefined, selector: string, exact = false): Promise<Aim> {
  if (!box || !(box.width > 0) || !(box.height > 0)) return NO_AIM;
  const map = await c.node.map();
  const points = GRID.flatMap((fy) =>
    GRID.map((fx) => aimAt(map, { x: box.x + box.width * fx, y: box.y + box.height * fy })),
  );
  const middle = centre(box);
  const order = points
    .map((point, index) => ({ point, index, distance: Math.hypot(point.x - middle.x, point.y - middle.y) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index);
  const found = await hits(
    c,
    order.map((one) => one.point),
    selector,
    exact,
  );
  const match = found.findIndex((one) => one.match);
  return {
    point: match < 0 ? null : order[match]!.point,
    centre: found[0]!.match,
    free: round(found.filter((one) => one.match).length / found.length, 2),
    under: found[0]!.what,
  };
}

const first = async (c: Ctx, selector: string): Promise<Box | undefined> => (await c.node.query(selector))[0];
/**
 * Runs in the node's document: waits until the entry animations of what matches are through (at
 * most 800 ms). The DRD's popup slides in over about 200 ms: read before that it is 4 layout px
 * above its place, and two equal polls can both fall before its first frame.
 */
const ANIMATIONS_DONE = async (host: HTMLElement, arg: { selector: string; node: string | null }): Promise<number> => {
  const popupHosts =
    arg.node === null
      ? []
      : [...document.querySelectorAll<HTMLElement>(".board-popup-host")].filter((one) => one.dataset.node === arg.node);
  const running = [host, ...popupHosts]
    .flatMap((root) => [...root.querySelectorAll(arg.selector)])
    .flatMap((element) => element.getAnimations({ subtree: true }))
    .filter(
      (animation) =>
        animation.playState !== "finished" &&
        Number.isFinite(Number(animation.effect?.getComputedTiming().endTime ?? Infinity)),
    );
  await Promise.race([
    Promise.all(running.map((animation) => animation.finished.catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, 800)),
  ]);
  return running.length;
};
/** the box of the first match once it is there, its entry animation is through and it rests (chrome is placed after it appears) */
async function rested(c: Ctx, selector: string, timeout = SHOW_MS): Promise<Box | null> {
  const there = await c.board.waitFor(async () => (await c.node.query(selector)).length > 0, timeout);
  if (!there) return null;
  await c.node.inDocument(ANIMATIONS_DONE, { selector, node: c.frame ? null : NODE });
  return c.board.waitForBox(() => first(c, selector), timeout);
}
const settle = (c: Ctx, ms: number): Promise<void> => c.board.page.waitForTimeout(ms);

async function aimFor(c: Ctx, selector: string, exact = false): Promise<Aim & { box: Box | undefined }> {
  const box = await first(c, selector);
  return { ...(await aim(c, box, selector, exact)), box };
}

// ── small readers (run in the node's document) ───────────────────────────────

const CLICK = (host: HTMLElement, selector: string): boolean => {
  const element = host.querySelector<HTMLElement>(selector);
  element?.click();
  return !!element;
};
const FONT_PX = (host: HTMLElement, selector: string): number | null => {
  const element = host.querySelector(selector);
  return element ? parseFloat(getComputedStyle(element).fontSize) : null;
};
const SCROLL = (
  host: HTMLElement,
  selector: string,
): { left: number; top: number; maxLeft: number; maxTop: number } | null => {
  const element = host.querySelector(selector);
  if (!element) return null;
  return {
    left: element.scrollLeft,
    top: element.scrollTop,
    maxLeft: element.scrollWidth - element.clientWidth,
    maxTop: element.scrollHeight - element.clientHeight,
  };
};
/** layout px: the height an element would have without its max-height (its border included) */
const NATURAL_HEIGHT = (host: HTMLElement, selector: string): number | null => {
  const element = host.querySelector<HTMLElement>(selector);
  if (!element) return null;
  return element.scrollHeight > element.clientHeight
    ? element.scrollHeight + (element.offsetHeight - element.clientHeight)
    : element.offsetHeight;
};
const TEXT = (host: HTMLElement, selector: string): string | null =>
  host.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
const ACTIVE = (host: HTMLElement): string => {
  const active = document.activeElement;
  if (!active) return "nothing";
  const what = `${active.tagName.toLowerCase()}.${(active.getAttribute("class") ?? "").trim().split(/\s+/).slice(0, 2).join(".")}`;
  return host.contains(active) ? what : `outside the editor: ${what}`;
};

interface Caret {
  /** the focus is in the cell's code editor */
  focused: boolean;
  /** characters before the caret, -1 when the selection is not in the cell */
  head: number;
  text: string;
  selected: string;
}
const CARET = (host: HTMLElement, cell: string): Caret => {
  const content = host.querySelector(`${cell} .cm-content`);
  const selection = document.getSelection();
  let head = -1;
  if (content && selection?.focusNode && content.contains(selection.focusNode)) {
    const range = document.createRange();
    range.selectNodeContents(content);
    range.setEnd(selection.focusNode, selection.focusOffset);
    head = range.toString().length;
  }
  return {
    focused: !!content && content.contains(document.activeElement),
    head,
    text: content?.textContent ?? "",
    selected: selection?.toString() ?? "",
  };
};
/** the client rectangle of every character of the element's text, in the node's document */
const CHARS = (host: HTMLElement, selector: string): Box[] => {
  const content = host.querySelector(selector);
  if (!content) return [];
  const native = (window as NativeWindow).__boardSpikeNative;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  const boxes: Box[] = [];
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    for (let index = 0; index < (text.textContent ?? "").length; index++) {
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      const { x, y, width, height } = native ? native.rect(range) : range.getBoundingClientRect();
      boxes.push({ x, y, width, height });
    }
  }
  return boxes;
};
/** where the connection preview ends, in the node's document: the last point of its path through the browser's own matrix */
const PREVIEW_END = (host: HTMLElement): Point | null => {
  const native = (window as NativeWindow).__boardSpikeNative;
  const paths = [...host.querySelectorAll<SVGGeometryElement>(".djs-dragger path, .djs-dragger polyline")];
  const path = paths.find((one) => one.getTotalLength() > 0);
  if (!path) return null;
  const end = path.getPointAtLength(path.getTotalLength());
  const matrix = native ? native.screenCTM(path) : path.getScreenCTM();
  if (!matrix) return null;
  return { x: matrix.a * end.x + matrix.c * end.y + matrix.e, y: matrix.b * end.x + matrix.d * end.y + matrix.f };
};

const pointToScreen = (map: ScreenMap, point: Point): Point => ({
  x: map.x + point.x * map.sx,
  y: map.y + point.y * map.sy,
});

// ── the file ─────────────────────────────────────────────────────────────────

const fileText = async (c: Ctx): Promise<string> => (await c.board.fileText(FILE)) ?? "";
/** the file once `test` holds (an editor writes about 350 ms after a gesture); null when it never did */
const waitFile = (c: Ctx, test: (text: string) => boolean, timeout = WRITE_MS): Promise<string | null> =>
  c.board.waitFor(async () => {
    const text = await fileText(c);
    return test(text) ? text : null;
  }, timeout);
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;
const ruleOrder = (text: string): string[] => [...text.matchAll(/<rule id="([^"]+)"/g)].map((match) => match[1]!);

// ── gestures ─────────────────────────────────────────────────────────────────

/** selects an element with a click on a point of it that takes the press */
async function select(c: Ctx, id: string): Promise<Aim> {
  const found = await aim(c, await c.node.elementBox(id), `[data-element-id="${id}"]`);
  if (!found.point) return found;
  if (!(await c.node.selected()).includes(id)) {
    await c.board.click(found.point);
    await c.board.waitFor(async () => (await c.node.selected()).includes(id), SHOW_MS);
  }
  return found;
}

/** the first of `ids` that can be selected */
async function selectFirst(c: Ctx, ids: readonly string[]): Promise<{ id: string; aim: Aim } | { covered: string[] }> {
  const covered: string[] = [];
  for (const id of ids) {
    const found = await select(c, id);
    if (found.point && (await c.node.selected()).includes(id)) return { id, aim: found };
    covered.push(`${id}: ${found.under}`);
  }
  return { covered };
}

/** a point of the bare canvas whose surroundings (half extents `clear`, screen px) are bare too, nearest to `prefer` */
async function freeCanvasPoint(c: Ctx, prefer: Point, clear: Point): Promise<Point | null> {
  const host = await c.node.hostBox();
  const inset = 28;
  const candidates: Point[] = [];
  for (let iy = 0; iy <= 8; iy++) {
    for (let ix = 0; ix <= 12; ix++) {
      candidates.push({
        x: host.x + inset + ((host.width - 2 * inset) * ix) / 12,
        y: host.y + inset + ((host.height - 2 * inset) * iy) / 8,
      });
    }
  }
  const around = (point: Point): Point[] => [
    point,
    { x: point.x - clear.x, y: point.y - clear.y },
    { x: point.x + clear.x, y: point.y - clear.y },
    { x: point.x - clear.x, y: point.y + clear.y },
    { x: point.x + clear.x, y: point.y + clear.y },
  ];
  const found = await hits(c, candidates.flatMap(around), ".djs-container > svg", true);
  const want = { x: host.x + host.width * prefer.x, y: host.y + host.height * prefer.y };
  const free = candidates
    .filter((_, index) => found.slice(index * 5, index * 5 + 5).every((one) => one.match))
    .sort((a, b) => Math.hypot(a.x - want.x, a.y - want.y) - Math.hypot(b.x - want.x, b.y - want.y));
  return free[0] ?? null;
}

/** a wheel of `delta` layout px (what the document scrolls by) at a screen point; returns once `scroller` rests */
async function wheelAt(c: Ctx, at: Point, delta: Point, scroller?: string): Promise<void> {
  await c.board.wheel(at, delta.y, { deltaX: delta.x });
  await settle(c, 100);
  if (!scroller) return;
  let last = JSON.stringify(await c.node.inDocument(SCROLL, scroller));
  for (let poll = 0; poll < 12; poll++) {
    await settle(c, 60);
    const now = JSON.stringify(await c.node.inDocument(SCROLL, scroller));
    if (now === last) return;
    last = now;
  }
}

interface Reach extends Aim {
  box: Box | undefined;
  /** wheels it took to bring the target into reach */
  wheels: number;
}

/**
 * Brings `selector` into reach as a person does: a wheel over `scroller`, as often as it takes
 * (at most 6), until a point of the target takes a press. No wheel when nothing of the scroller
 * takes one: then the target stays out of reach and the result says so.
 */
async function reach(c: Ctx, selector: string, scroller: string): Promise<Reach> {
  let wheels = 0;
  for (;;) {
    const found = await aimFor(c, selector);
    if (found.point || !found.box || wheels >= 6) return { ...found, wheels };
    const host = await c.node.hostBox();
    const view = intersect(await first(c, scroller), host);
    const over = await aim(c, view, scroller);
    if (!view || !over.point) return { ...found, wheels };
    const scale = await scaleOf(c);
    const [target, middle] = [centre(found.box), centre(view)];
    // only along an axis on which the target's middle is outside the scroller's visible part
    const dx = target.x < view.x || target.x > view.x + view.width ? target.x - middle.x : 0;
    const dy = target.y < view.y || target.y > view.y + view.height ? target.y - middle.y : 0;
    const before = await c.node.inDocument(SCROLL, scroller);
    await wheelAt(
      c,
      over.point,
      { x: dx / scale, y: dy === 0 && dx === 0 ? (target.y - middle.y) / scale : dy / scale },
      scroller,
    );
    wheels++;
    const after = await c.node.inDocument(SCROLL, scroller);
    if (before && after && before.left === after.left && before.top === after.top) {
      return { ...(await aimFor(c, selector)), wheels };
    }
  }
}

/** runs in the node's document: the focus is in a text field of the editor that is ready to be typed into */
const FOCUS_READY = (host: HTMLElement): boolean => {
  const active = document.activeElement;
  if (!active || !host.contains(active) || !active.matches("input, textarea, [contenteditable]")) return false;
  // a FEEL cell swaps its plain field for the code editor on focus: ready once the code editor has it
  return !active.closest(".feel-editor") || !!active.closest(".cm-content");
};
const focusReady = (c: Ctx): Promise<boolean | null> => c.board.waitFor(() => c.node.inDocument(FOCUS_READY), SHOW_MS);

/**
 * A click that focuses a text field, then replaces what is in it: key by key, or `atOnce` as ONE
 * insertion into whatever has the focus (as a paste or an input method does), for a field that
 * must not see a pause between two keys.
 */
async function typeAt(c: Ctx, at: Point, text: string, atOnce = false): Promise<void> {
  await c.board.click(at);
  // no fixed wait: under load a FEEL cell takes its time to bring its code editor up
  await focusReady(c);
  await settle(c, 60);
  await c.board.press("Control+A");
  if (atOnce) await c.board.page.keyboard.insertText(text);
  else await c.board.type(text);
}

/** opens the decision's table or literal expression with a script click on the DRD's drill-down button */
async function openDecision(c: Ctx, shows: string): Promise<void> {
  if (!(await c.node.inDocument(CLICK, ".drill-down-overlay button"))) {
    throw new Unmeasured("the DRD shows no drill-down button");
  }
  const opened = await c.board.waitFor(async () => (await c.node.query(shows)).length > 0, 8000);
  if (!opened) throw new Unmeasured(`a script click on the drill-down button did not show ${shows}`);
  await rested(c, shows);
  await settle(c, 150);
}
const openTable = (c: Ctx): Promise<void> => openDecision(c, ".dmn-decision-table-container table.tjs-table");

const unreachable = (what: string, found: Aim, measured: Record<string, unknown> = {}): Outcome => ({
  verdict: "broken",
  short: `${what} takes no press (${found.under})`,
  measured: { ...measured, unreachable: what, under: found.under, free: found.free },
});

// ── DRD ──────────────────────────────────────────────────────────────────────

async function drdMove(c: Ctx): Promise<Outcome> {
  const covered: string[] = [];
  for (const id of INPUTS) {
    const before = await c.node.elementBox(id);
    const grab = await aim(c, before, `[data-element-id="${id}"]`);
    if (!before || !grab.point) {
      covered.push(`${id}: ${grab.under}`);
      continue;
    }
    const text = await fileText(c);
    const unit = (await c.node.diagramScale()) ?? 0;
    // Control, pressed after the button, switches the DRD's 10 unit grid snapping off
    const dragged = await c.node.drag(grab.point, { x: 60 * c.zoom, y: 40 * c.zoom }, { hold: ["Control"] });
    const written = (await c.board.waitForFileChange(FILE, text, WRITE_MS)) !== null;
    const after = await c.board.waitForBox(() => c.node.elementBox(id));
    if (!after) throw new Unmeasured(`${id} is gone after the drag`);
    const moved = { x: after.x - before.x, y: after.y - before.y };
    const ratio = { x: round(moved.x / dragged.delta.x, 3), y: round(moved.y / dragged.delta.y, 3) };
    // a move lands on whole diagram units: that much may be missing
    const slack = Math.max(2, 1.5 * unit);
    const exact = Math.abs(moved.x - dragged.delta.x) <= slack && Math.abs(moved.y - dragged.delta.y) <= slack;
    return {
      verdict: exact && written ? "ok" : "broken",
      short: `${ratio.x.toFixed(2)}/${ratio.y.toFixed(2)}`,
      measured: {
        element: id,
        pointerPx: dragged.delta,
        movedPx: { x: px(moved.x), y: px(moved.y) },
        ratio,
        unitPx: round(unit, 3),
        fileChanged: written,
        ...(covered.length > 0 ? { covered } : {}),
      },
    };
  }
  return { verdict: "broken", short: "no input data takes a press", measured: { covered } };
}

async function drdCreate(c: Ctx): Promise<Outcome> {
  const selector = '.djs-palette .entry[data-action="create.decision"]';
  const entry = await rested(c, selector);
  const grab = await aim(c, entry, selector);
  if (!entry || !grab.centre) return unreachable("the palette's decision entry", grab);
  const unit = (await c.node.diagramScale()) ?? 0;
  // a decision is 180 x 80 units: the drop point's surroundings are bare for a shape of that size
  const drop = await freeCanvasPoint(c, { x: 0.78, y: 0.72 }, { x: 90 * unit + 6, y: 40 * unit + 6 });
  if (!drop) {
    return {
      verdict: "broken",
      short: "no bare canvas for a decision",
      measured: { entryPx: size(entry), reason: "no point of the canvas has room for a 180 x 80 unit shape" },
    };
  }
  const before = await c.node.elementIds();
  const dragged = await c.node.paletteDrag(entry, drop, { hold: ["Control"] });
  await settle(c, 300);
  const created = (await c.node.elementIds()).filter((id) => !before.includes(id));
  const box = created[0] === undefined ? null : await c.board.waitForBox(() => c.node.elementBox(created[0]!));
  // a created shape opens its label editor
  await c.board.press("Escape");
  const inFile = (await waitFile(c, (text) => count(text, /<decision /g) === 2)) !== null;
  if (!box) {
    return {
      verdict: "broken",
      short: "nothing created",
      measured: { entryPx: size(entry), dropAt: dragged.to, created: created.length, inFile },
    };
  }
  const off = { x: centre(box).x - dragged.to.x, y: centre(box).y - dragged.to.y };
  const slack = Math.max(2, 1.5 * unit);
  return {
    verdict: inFile && Math.abs(off.x) <= slack && Math.abs(off.y) <= slack ? "ok" : "broken",
    short: `off ${pair(off)} px`,
    measured: {
      entryPx: size(entry),
      dropAt: dragged.to,
      shapePx: size(box),
      offPx: { x: px(off.x), y: px(off.y) },
      offUnits: unit > 0 ? { x: px(off.x / unit), y: px(off.y / unit) } : null,
      unitPx: round(unit, 3),
      inFile,
    },
  };
}

async function drdConnect(c: Ctx): Promise<Outcome> {
  const source = "InputData_overdue";
  const chosen = await select(c, source);
  if (!chosen.point) return unreachable(source, chosen);
  const selector = '.djs-context-pad.open .entry[data-action="connect"]';
  const entry = await rested(c, selector);
  const grab = await aim(c, entry, selector);
  if (!entry || !grab.point) return unreachable("the pad's connect entry", grab);
  const unit = (await c.node.diagramScale()) ?? 0;
  const target = await aim(c, await c.node.elementBox(DECISION), `[data-element-id="${DECISION}"]`);
  if (!target.point) return unreachable("the decision to connect to", target, { entryPx: size(entry) });
  const hold = await freeCanvasPoint(c, { x: 0.8, y: 0.45 }, { x: 8, y: 8 });
  const before = count(await fileText(c), /<informationRequirement /g);
  // the first moves stay on the entry (it is small where the board scales it): the pad starts the connection on dragstart
  const within = Math.max(1, Math.min(entry.width, entry.height) / 2 - 2);
  const lead = [Math.min(3, within), Math.min(6, within)].filter((one, index, all) => all.indexOf(one) === index);
  // Control, pressed after the button, switches the DRD's grid snapping off: the rubber band's end is the pointer
  const KEYS = ["Control"];
  let preview: Point | null = null;
  let pointer: Point | null = null;
  if (hold) {
    const dragged = await c.board.drag(grab.point, aimAt(await c.node.map(), hold), {
      keepDown: true,
      lead,
      hold: KEYS,
    });
    await settle(c, 150);
    const end = await c.node.inDocument(PREVIEW_END);
    preview = end && pointToScreen(await c.node.map(), end);
    pointer = dragged.to;
    await c.board.move(target.point, 10);
  } else {
    await c.board.drag(grab.point, target.point, { keepDown: true, lead, hold: KEYS });
  }
  await settle(c, 150);
  await c.board.release(KEYS);
  const created = (await waitFile(c, (text) => count(text, /<informationRequirement /g) === before + 1)) !== null;
  const error = preview && pointer ? { x: preview.x - pointer.x, y: preview.y - pointer.y } : null;
  const slack = Math.max(PLACE_TOL, 1.5 * unit);
  const exact = !!error && far(error) <= slack;
  return {
    verdict: created ? (exact || !error ? "ok" : "degraded") : "broken",
    short: `${created ? "connected" : "NOT connected"}, rubber band ${error ? `${px(far(error))} px off` : "not measured"}`,
    measured: {
      source,
      target: DECISION,
      entryPx: size(entry),
      entryFree: grab.free,
      created,
      previewOffPx: error && { x: px(error.x), y: px(error.y) },
      previewOffUnits: error && unit > 0 ? px(far(error) / unit) : null,
      ...(hold ? {} : { previewNote: "no bare canvas point to hold the pointer over" }),
      unitPx: round(unit, 3),
    },
  };
}

async function drdPad(c: Ctx): Promise<Outcome> {
  const chosen = await selectFirst(c, ["InputData_order_value", "InputData_segment", "InputData_overdue", DECISION]);
  if ("covered" in chosen) return { verdict: "broken", short: "no element takes a press", measured: chosen };
  const pad = await rested(c, ".djs-context-pad.open");
  if (!pad) return { verdict: "broken", short: "no pad opened", measured: { element: chosen.id } };
  await c.shot("pad", ".djs-context-pad.open");
  const unit = (await c.node.diagramScale()) ?? 0;
  const graphics = await first(c, `.djs-element[data-element-id="${chosen.id}"]`);
  if (!graphics) throw new Unmeasured(`no graphics of ${chosen.id}`);
  // ContextPad._getPosition: right edge of the element's graphics plus 8 px times the canvas scale, its top
  const expected = { x: graphics.x + graphics.width + 8 * unit, y: graphics.y };
  const off = { x: pad.x - expected.x, y: pad.y - expected.y };
  const entries = await c.node.query(".djs-context-pad.open .entry");
  const found = await hits(c, entries.map(centre), ".djs-context-pad.open .entry");
  const reachable = found.filter((one) => one.match).length;
  const placed = far(off) <= PLACE_TOL;
  return {
    verdict: reachable === 0 ? "broken" : placed && reachable === entries.length ? "ok" : "degraded",
    short: `off ${pair(off)} px, ${reachable}/${entries.length} entries, entry ${px(entries[0]?.width ?? 0)} px`,
    measured: {
      element: chosen.id,
      padAt: { x: px(pad.x), y: px(pad.y) },
      expectedAt: { x: px(expected.x), y: px(expected.y) },
      offPx: { x: px(off.x), y: px(off.y) },
      entries: entries.length,
      reachable,
      entryPx: px(entries[0]?.width ?? 0),
      insideNode: inside(pad, await c.node.hostBox()),
      unitPx: round(unit, 3),
    },
  };
}

async function drdPopup(c: Ctx): Promise<Outcome> {
  const chosen = await select(c, DECISION);
  if (!chosen.point) return unreachable("the decision", chosen);
  const wrenchSelector = '.djs-context-pad.open .entry[data-action="replace"]';
  const wrench = await rested(c, wrenchSelector);
  const press = await aim(c, wrench, wrenchSelector);
  if (!wrench || !press.point) return unreachable("the pad's change type entry", press);
  const pad = await first(c, ".djs-context-pad.open");
  await c.board.click(press.point);
  const popup = await rested(c, ".djs-popup");
  if (!popup || !pad) {
    return { verdict: "broken", short: "no popup opened", measured: { wrenchPx: size(wrench) } };
  }
  await c.shot("popup", ".djs-popup, .djs-context-pad.open");
  const map = await c.node.map();
  // dmn-js-drd getReplaceMenuPosition: the pad's left, 5 px of the node's document below its bottom
  const expected = { x: pad.x, y: pad.y + pad.height + 5 * map.sy };
  const off = { x: popup.x - expected.x, y: popup.y - expected.y };
  // An editor whose host the board scales inside the page may leave those 5 px in its own layout px
  // (5 x scale on screen, as a frame does) or in screen px: both are the popup's place. Where the
  // host has a net scale of 1, and in a frame, the two are the same number
  const offScaled = { x: off.x, y: popup.y - (pad.y + pad.height + 5 * (await scaleOf(c))) };
  const entrySelector = '.djs-popup .entry[data-id="replace-with-literal-expression"]';
  const entry = await aimFor(c, entrySelector);
  const entries = await c.node.query(".djs-popup .entry");
  const reachable = (await hits(c, entries.map(centre), ".djs-popup .entry")).filter((one) => one.match).length;
  let route: "pointer" | "keyboard" = "pointer";
  if (entry.point) await c.board.click(entry.point);
  else {
    // the popup is open and has the focus: the second entry by keys
    route = "keyboard";
    await c.board.press("ArrowDown");
    await c.board.press("Enter");
  }
  const changed =
    (await waitFile(c, (text) => /<literalExpression/.test(text) && !/<decisionTable/.test(text))) !== null;
  const gapScaled = far(off) > PLACE_TOL && far(offScaled) <= PLACE_TOL;
  const placed = far(off) <= PLACE_TOL || gapScaled;
  return {
    verdict: !changed ? "broken" : route === "pointer" && placed ? "ok" : "degraded",
    short: `off ${gapScaled ? `${pair(offScaled)} px (its 5 px gap scaled with the host)` : `${pair(off)} px`}, ${size(popup)} px, ${reachable}/${entries.length} entries, type changed ${changed ? `by ${route}` : "NOT"}`,
    measured: {
      popupAt: { x: px(popup.x), y: px(popup.y) },
      expectedAt: { x: px(expected.x), y: px(expected.y) },
      offPx: { x: px(off.x), y: px(off.y) },
      offPxWithTheGapScaled: { x: px(offScaled.x), y: px(offScaled.y) },
      popupPx: size(popup),
      entries: entries.length,
      reachable,
      insideNode: inside(popup, await c.node.hostBox()),
      route,
      changed,
    },
  };
}

async function drdLabel(c: Ctx): Promise<Outcome> {
  const covered: string[] = [];
  for (const id of ["InputData_overdue", "InputData_order_value", "InputData_segment"]) {
    const box = await c.node.elementBox(id);
    const press = await aim(c, box, `[data-element-id="${id}"]`);
    if (!box || !press.point) {
      covered.push(`${id}: ${press.under}`);
      continue;
    }
    await c.board.doubleClick(press.point);
    const editor = await rested(c, ".djs-direct-editing-parent");
    if (!editor) {
      return { verdict: "broken", short: "no label editor opened", measured: { element: id, covered } };
    }
    await c.shot("editor", ".djs-direct-editing-parent");
    const off = { x: centre(editor).x - centre(box).x, y: centre(editor).y - centre(box).y };
    const sizeRatio = round(editor.width / box.width, 3);
    await c.board.press("Control+A");
    await c.board.type("Late invoices");
    await c.board.press("Enter");
    const written =
      (await waitFile(c, (text) => new RegExp(`<inputData id="${id}" name="Late invoices"`).test(text))) !== null;
    const placed = far(off) <= PLACE_TOL && Math.abs(sizeRatio - 1) <= 0.1;
    return {
      verdict: !written ? "broken" : placed ? "ok" : "degraded",
      short: `box off ${pair(off)} px, width x${sizeRatio.toFixed(2)}, name ${written ? "written" : "NOT written"}`,
      measured: {
        element: id,
        elementPx: size(box),
        editorPx: size(editor),
        offPx: { x: px(off.x), y: px(off.y) },
        sizeRatio,
        written,
        ...(covered.length > 0 ? { covered } : {}),
      },
    };
  }
  return { verdict: "broken", short: "no input data takes a press", measured: { covered } };
}

async function drdDefinitions(c: Ctx): Promise<Outcome> {
  const card = await rested(c, ".dmn-definitions");
  if (!card) throw new Unmeasured("the DRD shows no definitions card");
  const host = await c.node.hostBox();
  const middles: Point[] = [];
  for (const id of SHAPES) {
    const box = await c.node.elementBox(id);
    if (box) middles.push(centre(box));
  }
  const coveredShapes = (await hits(c, middles, ".dmn-definitions")).filter((one) => one.match).length;
  const drill = await aimFor(c, ".drill-down-overlay");
  let written = 0;
  const fields: Record<string, string> = {};
  const inFile = (text: string, field: string): string | null =>
    new RegExp(`<definitions\\b[^>]*\\b${field}="([^"]*)"`).exec(text)?.[1] ?? null;
  for (const [field, selector, text] of [
    ["name", ".dmn-definitions-name", "Credit check"],
    ["id", ".dmn-definitions-id", "Definitions_board"],
  ] as const) {
    const press = await aimFor(c, selector);
    if (!press.point) {
      fields[field] = `takes no press (${press.under})`;
      continue;
    }
    // As ONE insertion: dmn-js writes 300 ms after the last key and then sets the field's text
    // again, which puts the caret at its start (see `pause` below). Typed key by key on a busy
    // machine, a late key lands in front of the others
    await typeAt(c, press.point, text, true);
    // ... and it drops the text when the field is left before that write: Enter only once the file has it
    await waitFile(c, (now) => inFile(now, field) === text);
    await c.board.press("Enter");
    await settle(c, 200);
    const got = inFile(await fileText(c), field);
    fields[field] = got === text ? "written" : `NOT written (the file has "${got}")`;
    if (got === text) written++;
  }
  // what a pause while typing does, in every strategy alike: "ab", the engine's write, then "cd"
  let pause: string | null = null;
  const name = await aimFor(c, ".dmn-definitions-name");
  if (name.point) {
    await typeAt(c, name.point, "ab", true);
    if (await waitFile(c, (now) => inFile(now, "name") === "ab")) {
      await settle(c, 100);
      await c.board.page.keyboard.insertText("cd");
      await settle(c, 100);
      pause = await c.node.inDocument(TEXT, ".dmn-definitions-name");
      await waitFile(c, (now) => inFile(now, "name") === pause);
    }
    await c.board.press("Enter");
  }
  return {
    verdict: written === 0 ? "broken" : written === 2 && coveredShapes === 0 && drill.centre ? "ok" : "degraded",
    short: `card ${size(card)} px = ${round((100 * area(intersect(card, host))) / area(host), 0)} % of the node, covers ${coveredShapes}/${middles.length} shape centres${drill.centre ? "" : " and the drill-down button's centre"}, ${written}/2 written; "ab", pause, "cd" gives "${pause ?? "?"}"`,
    measured: {
      cardPx: size(card),
      shareOfNode: round(area(intersect(card, host)) / area(host), 3),
      coveredShapeCentres: coveredShapes,
      shapes: middles.length,
      drillDownCentreFree: drill.centre,
      fields,
      written,
      typedAbPauseCd: pause,
    },
  };
}

async function drdOpenTable(c: Ctx): Promise<Outcome> {
  const press = await aimFor(c, ".drill-down-overlay");
  if (!press.box) throw new Unmeasured("the DRD shows no drill-down button");
  const measured = { buttonPx: size(press.box), free: press.free, centreFree: press.centre, under: press.under };
  if (!press.point) {
    return {
      verdict: "broken",
      short: `button ${size(press.box)} px, 0 % free: under ${press.under}`,
      measured: { ...measured, opened: false },
    };
  }
  await c.board.click(press.point);
  const opened =
    (await c.board.waitFor(
      async () => (await c.node.query(".dmn-decision-table-container table")).length > 0,
      6000,
    )) === true;
  return {
    verdict: !opened ? "broken" : press.centre ? "ok" : "degraded",
    short: `button ${size(press.box)} px, ${round(press.free * 100, 0)} % free${press.centre ? "" : ` (centre under ${press.under})`}, ${opened ? "opens" : "does NOT open"}`,
    measured: { ...measured, opened },
  };
}

// ── decision table ───────────────────────────────────────────────────────────

const CONTAINER = ".dmn-decision-table-container";
const SCROLLER = ".tjs-table-container";

async function tableVisible(c: Ctx): Promise<Outcome> {
  await openTable(c);
  const host = await c.node.hostBox();
  const table = (await first(c, "table.tjs-table"))!;
  const view = intersect(await first(c, SCROLLER), host);
  const shown = intersect(table, view);
  const rows = await c.node.query("table.tjs-table tbody tr");
  const columns = await c.node.query("table.tjs-table thead th:not(.index-column)");
  const head = await first(c, "table.tjs-table thead tr");
  const rowsFull = rows.filter((row) => inside({ ...row, x: Math.max(row.x, view?.x ?? 0), width: 1 }, view)).length;
  const rowsPartly = rows.filter((row) => intersect(row, view)).length;
  const columnsFull = columns.filter((column) => inside({ ...column, y: view?.y ?? 0, height: 1 }, view)).length;
  const scale = await scaleOf(c);
  const fontLayout = (await c.node.inDocument(FONT_PX, "table.tjs-table td.input-cell")) ?? 0;
  const font = fontLayout * scale;
  const share = area(shown) / area(table);
  const cell = await first(c, 'td[data-element-id="UnaryTests_blocked_value"]');
  return {
    verdict: !shown ? "broken" : font >= READABLE_PX && rowsFull >= 1 ? "ok" : "degraded",
    short: `${round(share * 100, 0)} % of the table, ${rowsFull}/${rows.length} rules, ${columnsFull}/${columns.length} columns, text ${px(font)} px`,
    measured: {
      tablePx: size(table),
      viewPx: view ? size(view) : "0x0",
      nodePx: size(host),
      shareOfTable: round(share, 3),
      shareOfNodeTheTableGets: round(area(view) / area(host), 3),
      headVisible: !!intersect(head, view),
      rulesFullyVisible: rowsFull,
      rulesPartlyVisible: rowsPartly,
      rules: rows.length,
      columnsFullyVisible: columnsFull,
      columns: columns.length,
      fontLayoutPx: fontLayout,
      fontScreenPx: px(font),
      cellPx: cell ? size(cell) : null,
    },
  };
}

async function tableColumnResize(c: Ctx): Promise<Outcome> {
  await openTable(c);
  const column = 'th[data-col-id="Input_segment"]';
  const handle = await aimFor(c, `${column} .resize-column-handle`);
  const before = await first(c, column);
  if (!handle.point || !before) return unreachable("the column border", handle);
  const scale = await scaleOf(c);
  const layoutBefore = before.width / scale;
  const dragged = await c.node.drag(handle.point, { x: 40, y: 0 });
  const pattern = /<input id="Input_segment"[^>]*biodi:width="([\d.]+)"/;
  const text = await waitFile(c, (now) => pattern.test(now));
  const after = await rested(c, column);
  await c.shot("resized", column);
  const written = text ? Number(pattern.exec(text)![1]) : null;
  // the border follows the pointer: the pointer's travel in layout px on top of the width before
  const right = Math.round(layoutBefore + dragged.delta.x / scale);
  const grew = after ? after.width - before.width : 0;
  return {
    verdict: written === null ? "broken" : Math.abs(written - right) <= 1 ? "ok" : "wrong-data",
    short:
      written === null
        ? "no width written"
        : `wrote ${round(written)}, right is ${right} (${written - right >= 0 ? "+" : ""}${round(written - right)}); border moved ${px(grew)} of ${px(dragged.delta.x)} px`,
    measured: {
      pointerPx: dragged.delta.x,
      widthBeforeLayoutPx: px(layoutBefore),
      writtenWidth: written,
      rightWidth: right,
      errorLayoutPx: written === null ? null : round(written - right),
      writtenIsWholeNumber: written === null ? null : Number.isInteger(written),
      columnGrewScreenPx: px(grew),
      borderOverPointer: round(grew / dragged.delta.x, 3),
      scale: round(scale, 4),
    },
  };
}

async function tableColumnClick(c: Ctx): Promise<Outcome> {
  await openTable(c);
  const column = 'th[data-col-id="Input_segment"]';
  const handle = await aimFor(c, `${column} .resize-column-handle`);
  const before = await first(c, column);
  if (!handle.point || !before) return unreachable("the column border", handle);
  const scale = await scaleOf(c);
  const layoutBefore = before.width / scale;
  // press and release in place: dmn-js ends a resize on every release and writes the width it computed
  await c.board.click(handle.point);
  const pattern = /<input id="Input_segment"[^>]*biodi:width="([\d.]+)"/;
  const text = await waitFile(c, (now) => pattern.test(now), 2500);
  const written = text ? Number(pattern.exec(text)![1]) : null;
  const after = await rested(c, column);
  const same = written === null || Math.abs(written - layoutBefore) <= 1;
  return {
    verdict: same ? "ok" : "wrong-data",
    short:
      written === null
        ? "nothing written"
        : `wrote ${round(written)}, the column was ${round(layoutBefore)} wide (${written - layoutBefore >= 0 ? "+" : ""}${round(written - layoutBefore)}); on screen ${px(before.width)} -> ${px(after?.width ?? 0)} px`,
    measured: {
      widthBeforeLayoutPx: px(layoutBefore),
      writtenWidth: written,
      errorLayoutPx: written === null ? null : round(written - layoutBefore),
      columnScreenPxBefore: px(before.width),
      columnScreenPxAfter: after ? px(after.width) : null,
      scale: round(scale, 4),
    },
  };
}

async function tableType(c: Ctx): Promise<Outcome> {
  await openTable(c);
  const steps: Record<string, string> = {};
  let done = 0;
  let wheels = 0;
  for (const [what, selector, text, pattern] of [
    [
      "input entry",
      'td[data-element-id="UnaryTests_blocked_value"]',
      "< 4711",
      /<inputEntry id="UnaryTests_blocked_value">\s*<text>&lt; 4711<\/text>/,
    ],
    [
      "output entry",
      'td[data-element-id="LiteralExpression_blocked"]',
      "hold",
      /<outputEntry id="LiteralExpression_blocked">\s*<text>hold<\/text>/,
    ],
    [
      "annotation",
      'td.annotation[data-row-id="Rule_blocked_customer"]',
      "Checked by hand",
      /<rule id="Rule_blocked_customer">\s*<description>Checked by hand<\/description>/,
    ],
  ] as const) {
    const cell = await reach(c, selector, SCROLLER);
    wheels += cell.wheels;
    if (!cell.point) {
      steps[what] = `takes no press (${cell.under})`;
      continue;
    }
    await typeAt(c, cell.point, text);
    const ok = (await waitFile(c, (now) => pattern.test(now))) !== null;
    steps[what] = `${ok ? "written" : "NOT written"}${cell.wheels > 0 ? ` after ${cell.wheels} wheel(s)` : ""}`;
    if (ok) done++;
  }
  return {
    verdict: done === 3 ? "ok" : done === 0 ? "broken" : "degraded",
    short: `${done}/3 written${wheels > 0 ? `, ${wheels} wheel(s) to get there` : ""}`,
    measured: { steps, written: done, wheels },
  };
}

async function tableFeel(c: Ctx): Promise<Outcome> {
  await openTable(c);
  const selector = 'td[data-element-id="UnaryTests_key_segment"]';
  const cell = await reach(c, selector, SCROLLER);
  if (!cell.point) return unreachable("the FEEL cell", cell, { wheels: cell.wheels });
  const charsOf = async (content: string): Promise<Box[]> => {
    const map = await c.node.map();
    return (await c.node.inDocument(CHARS, `${selector} ${content}`)).map((box) => toScreen(map, box));
  };
  // a click on the boundary before character n puts the caret at n: half a character of slack either way
  const boundary = (chars: Box[], index: number): Point => ({
    x: chars[index]!.x,
    y: chars[index]!.y + chars[index]!.height / 2,
  });
  // the first click, into the cell that has no focus yet: on the text's middle where that takes a press
  const plain = await charsOf(".content-editable");
  const map = await c.node.map();
  const onText = plain.length >= 10 ? aimAt(map, boundary(plain, 6)) : null;
  const firstAt = onText && (await hits(c, [onText], selector))[0]?.match ? onText : cell.point;
  await c.board.click(firstAt);
  // the cell brings its code editor up on focus
  await c.board.waitFor(async () => (await c.node.inDocument(CARET, selector)).focused, SHOW_MS);
  await settle(c, 80);
  const focus = await c.node.inDocument(CARET, selector);
  const chars = await charsOf(".cm-content");
  if (!focus.focused || chars.length < 10) {
    return {
      verdict: "broken",
      short: `no focus in the cell's editor (${await c.node.inDocument(ACTIVE)})`,
      measured: { focus, characters: chars.length },
    };
  }
  const caretAfter = async (index: number): Promise<number> => {
    await c.board.click(aimAt(map, boundary(chars, index)));
    await settle(c, 120);
    return (await c.node.inDocument(CARET, selector)).head;
  };
  const caret6 = await caretAfter(6);
  const caret4 = await caretAfter(4);
  await c.board.drag(aimAt(map, boundary(chars, 2)), aimAt(map, boundary(chars, 9)), { lead: [2], steps: 6 });
  await settle(c, 120);
  const dragged = await c.node.inDocument(CARET, selector);
  await c.shot("selection", selector);
  const wanted = focus.text.slice(2, 9);
  await c.board.type("X");
  const typed = `${focus.text.slice(0, 2)}X${focus.text.slice(9)}`;
  const escaped = typed.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const text = await waitFile(
    c,
    (now) => now.includes(`<inputEntry id="UnaryTests_key_segment">`) && !now.includes(`<text>${focus.text}</text>`),
  );
  const inFile = /<inputEntry id="UnaryTests_key_segment">\s*<text>([^<]*)<\/text>/.exec(text ?? "")?.[1] ?? null;
  const exact = caret6 === 6 && caret4 === 4 && dragged.selected === wanted && inFile === escaped;
  return {
    verdict: exact ? "ok" : inFile !== null ? "degraded" : "broken",
    short: `first click${firstAt === onText ? " before character 6" : ""}: focus, caret at ${focus.head} of ${focus.text.length}; then click at 6 -> ${caret6}, at 4 -> ${caret4}; drag 2..9 selected "${dragged.selected}"; file ${inFile === escaped ? "right" : `"${inFile}"`}; char ${px(chars[0]!.width)} px`,
    measured: {
      text: focus.text,
      firstClickBeforeCharacter: firstAt === onText ? 6 : "the cell's middle",
      caretAfterFirstClick: focus.head,
      caretAfterClickAt6: caret6,
      caretAfterClickAt4: caret4,
      dragSelected: dragged.selected,
      dragWanted: wanted,
      fileText: inFile,
      fileWanted: escaped,
      charScreenPx: px(chars[0]!.width),
      wheels: cell.wheels,
    },
  };
}

/** how far a menu lies from where table-js's ContextMenu would put it for a click at `at`, in true screen geometry */
async function menuError(c: Ctx, menu: Box, at: Point): Promise<{ off: Point; corner: number }> {
  const container = (await first(c, CONTAINER))!;
  const scale = await scaleOf(c);
  const natural = ((await c.node.inDocument(NATURAL_HEIGHT, ".context-menu")) ?? menu.height / scale) * scale;
  // left or right of the click, above or below it, each clamped into the container
  const xs = [at.x, at.x - menu.width].map((x) => clamp(x, container.x, container.x + container.width - menu.width));
  const ys = [at.y, at.y - natural].map((y) => clamp(y, container.y, container.y + container.height - natural));
  const nearest = (value: number, candidates: number[]): number =>
    candidates.map((one) => value - one).sort((a, b) => Math.abs(a) - Math.abs(b))[0]!;
  const corners = [menu.x, menu.x + menu.width].flatMap((x) =>
    [menu.y, menu.y + menu.height].map((y) => Math.hypot(x - at.x, y - at.y)),
  );
  return { off: { x: nearest(menu.x, xs), y: nearest(menu.y, ys) }, corner: Math.min(...corners) };
}

async function contextMenuCase(
  c: Ctx,
  target: string,
  entrySelector: string,
  added: (text: string) => boolean,
): Promise<Outcome> {
  await openTable(c);
  const cell = await reach(c, target, SCROLLER);
  if (!cell.point) return unreachable("the cell to right-click", cell);
  await c.board.click(cell.point, { button: "right" });
  const menu = await rested(c, ".context-menu");
  if (!menu) return { verdict: "broken", short: "no context menu opened", measured: { clickAt: cell.point } };
  await c.shot("menu", ".context-menu");
  const { off, corner } = await menuError(c, menu, cell.point);
  const entries = await c.node.query(".context-menu .context-menu-group-entry");
  const reachable = (await hits(c, entries.map(centre), ".context-menu .context-menu-group-entry")).filter(
    (one) => one.match,
  ).length;
  const entry = await aimFor(c, `.context-menu ${entrySelector}`);
  if (entry.point) await c.board.click(entry.point);
  const done = entry.point ? (await waitFile(c, added)) !== null : false;
  if (!done) await c.board.press("Escape");
  const placed = far(off) <= PLACE_TOL;
  return {
    verdict: !done ? "broken" : placed ? "ok" : "degraded",
    short: `off ${pair(off)} px (nearest corner ${px(corner)} px from the click), ${size(menu)} px, ${reachable}/${entries.length} entries, ${done ? "entry worked" : `entry did NOT work${entry.point ? "" : ` (${entry.under})`}`}`,
    measured: {
      clickAt: cell.point,
      menuAt: { x: px(menu.x), y: px(menu.y) },
      menuPx: size(menu),
      offPx: { x: px(off.x), y: px(off.y) },
      nearestCornerToClickPx: px(corner),
      entries: entries.length,
      reachable,
      insideNode: inside(menu, await c.node.hostBox()),
      entryWorked: done,
    },
  };
}

const tableMenuRule = (c: Ctx): Promise<Outcome> =>
  contextMenuCase(
    c,
    'td[data-element-id="UnaryTests_blocked_segment"]',
    ".context-menu-entry-add-rule-below",
    (text) => count(text, /<rule /g) === RULES.length + 1,
  );
const tableMenuColumn = (c: Ctx): Promise<Outcome> =>
  contextMenuCase(
    c,
    'th[data-col-id="Input_order_value"]',
    ".context-menu-entry-add-input-right",
    (text) => count(text, /<input /g) === 4,
  );

async function tableAdd(c: Ctx): Promise<Outcome> {
  await openTable(c);
  const steps: Record<string, string> = {};
  let done = 0;
  let wheels = 0;
  for (const [what, selector, added] of [
    ["add input", ".add-input", (text: string) => count(text, /<input /g) === 4],
    ["add rule", "tfoot.add-rule td.add-rule-add", (text: string) => count(text, /<rule /g) === RULES.length + 1],
  ] as const) {
    const control = await reach(c, selector, SCROLLER);
    wheels += control.wheels;
    if (!control.point) {
      steps[what] = `takes no press (${control.under})`;
      continue;
    }
    await c.board.click(control.point);
    const ok = (await waitFile(c, added)) !== null;
    steps[what] =
      `${ok ? "added" : "NOT added"}${control.wheels > 0 ? ` after ${control.wheels} wheel(s)` : ""}, control ${control.box ? size(control.box) : "?"} px`;
    if (ok) done++;
  }
  return {
    verdict: done === 2 ? "ok" : done === 0 ? "broken" : "degraded",
    short: `input ${steps["add input"]}; rule ${steps["add rule"]}`,
    measured: { steps, added: done, wheels },
  };
}

interface Dropdown {
  input: Box;
  options: Box;
  /** the list against its field: left edges, list top against field bottom (or list bottom against field top when it opens upwards), widths */
  off: Point;
  widthRatio: number;
  entries: number;
  reachable: number;
}

/** an open InputSelect list against the field it belongs to */
async function dropdown(c: Ctx, input: Box): Promise<Dropdown | null> {
  const options = await rested(c, ".dms-select-options");
  if (!options) return null;
  await c.shot("list", ".dms-select-options, .context-menu");
  const below = options.y - (input.y + input.height);
  const above = options.y + options.height - input.y;
  const entries = await c.node.query(".dms-select-options .option");
  const reachable = (await hits(c, entries.map(centre), ".dms-select-options .option")).filter(
    (one) => one.match,
  ).length;
  return {
    input,
    options,
    off: { x: options.x - input.x, y: Math.abs(below) <= Math.abs(above) ? below : above },
    widthRatio: round(options.width / input.width, 3),
    entries: entries.length,
    reachable,
  };
}
const dropdownPlaced = (list: Dropdown): boolean =>
  far(list.off) <= PLACE_TOL && Math.abs(list.options.width - list.input.width) <= PLACE_TOL;
const dropdownShort = (list: Dropdown): string =>
  `list off ${pair(list.off)} px, width x${list.widthRatio.toFixed(2)}, ${list.reachable}/${list.entries} entries in reach`;
const dropdownMeasured = (list: Dropdown): Record<string, unknown> => ({
  fieldPx: size(list.input),
  listPx: size(list.options),
  offPx: { x: px(list.off.x), y: px(list.off.y) },
  widthRatio: list.widthRatio,
  entries: list.entries,
  reachable: list.reachable,
});

const HIT_POLICIES = ["UNIQUE", "FIRST", "PRIORITY", "ANY", "COLLECT"];

async function tableHitPolicy(c: Ctx): Promise<Outcome> {
  await openTable(c);
  const field = await aimFor(c, ".hit-policy-edit-policy-select .dms-input");
  if (!field.point || !field.box) return unreachable("the hit policy field", field);
  await c.board.click(field.point);
  const list = await dropdown(c, field.box);
  if (!list) return { verdict: "broken", short: "no list opened", measured: { fieldPx: size(field.box) } };
  const entries = await c.node.query(".dms-select-options .option");
  // Collect first, then the others but the policy the table has (First)
  let picked: number | null = null;
  for (const index of [4, 0, 2, 3]) {
    const option = await aim(c, entries[index], ".dms-select-options .option");
    if (!option.point) continue;
    await c.board.click(option.point);
    picked = index;
    break;
  }
  const wanted = picked === null ? null : HIT_POLICIES[picked]!;
  const text = wanted === null ? null : await waitFile(c, (now) => !/hitPolicy="FIRST"/.test(now));
  const policy = text === null ? null : (/<decisionTable[^>]*hitPolicy="([^"]+)"/.exec(text)?.[1] ?? "UNIQUE");
  const changed = wanted !== null && policy === wanted;
  if (!changed) await c.board.press("Escape");
  return {
    verdict: !changed ? (policy !== null ? "wrong-data" : "broken") : dropdownPlaced(list) ? "ok" : "degraded",
    short: `${dropdownShort(list)}, ${changed ? `set ${policy}` : policy !== null ? `picked ${wanted}, file has ${policy}` : "NOT set"}`,
    measured: { ...dropdownMeasured(list), picked: wanted, fileHitPolicy: policy, changed },
  };
}

/** opens the input expression editor over a header cell with a double-click */
async function openHeaderEditor(c: Ctx, column: string): Promise<{ menu: Box; head: Box; wheels: number } | Aim> {
  const head = await reach(c, column, SCROLLER);
  if (!head.point || !head.box) return head;
  await c.board.doubleClick(head.point);
  const menu = await rested(c, ".context-menu");
  const now = await first(c, column);
  if (menu) await c.shot("header-editor", ".context-menu");
  return menu && now ? { menu, head: now, wheels: head.wheels } : { ...head, point: null, under: "no editor opened" };
}

/** picks boolean from an open type list by pointer; where that does not set it, types it into the field (it is a text field too) */
async function pickType(
  c: Ctx,
  listOpen: boolean,
  isSet: (text: string) => boolean,
): Promise<{ route: "pointer" | "typing" | "none"; set: boolean; entry: string }> {
  const option = listOpen ? await aimFor(c, '.dms-select-options .option[data-value="boolean"]') : null;
  let entry = listOpen ? `takes no press (${option?.under ?? "?"})` : "no list";
  if (option?.point) {
    await c.board.click(option.point);
    if (await waitFile(c, isSet)) return { route: "pointer", set: true, entry: "picked" };
    entry = "pressed, nothing set";
  }
  await c.board.press("Control+A");
  await c.board.type("boolean");
  const set = (await waitFile(c, isSet)) !== null;
  return { route: set ? "typing" : "none", set, entry };
}

async function tableTypeDropdown(c: Ctx): Promise<Outcome> {
  await openTable(c);
  const editor = await openHeaderEditor(c, 'th[data-col-id="Input_order_value"]');
  if (!("menu" in editor)) return unreachable("the header cell's editor", editor);
  const selector = ".context-menu .type-ref-edit-select .dms-input";
  const field = await reach(c, selector, ".context-menu");
  if (!field.point || !field.box) return unreachable("the type field", field, { wheels: field.wheels });
  await c.board.click(field.point);
  const list = await dropdown(c, (await first(c, selector)) ?? field.box);
  const pattern = /<inputExpression id="InputExpression_order_value" typeRef="boolean"/;
  const { route, set, entry } = await pickType(c, !!list, (now) => pattern.test(now));
  await c.board.press("Escape");
  await c.board.press("Escape");
  return {
    verdict: !set ? "broken" : list && route === "pointer" && dropdownPlaced(list) ? "ok" : "degraded",
    short: `${list ? dropdownShort(list) : "no list opened"}, type ${set ? `set by ${route}` : "NOT set"}${field.wheels > 0 ? `, field after ${field.wheels} wheel(s) in the editor` : ""}`,
    measured: {
      ...(list ? dropdownMeasured(list) : { list: "none" }),
      route,
      set,
      listEntry: entry,
      wheelsToField: field.wheels,
    },
  };
}

async function tableHeaderEditors(c: Ctx): Promise<Outcome> {
  await openTable(c);
  const result: Record<string, unknown> = {};
  const offs: Point[] = [];
  let written = 0;
  let fields = 0;
  for (const [what, column, inputs] of [
    [
      "input expression editor",
      'th[data-col-id="Input_order_value"]',
      [
        [".context-menu .dms-input-label", "Order total", /<input id="Input_order_value" label="Order total"/],
        [
          ".context-menu .ref-text",
          "orderTotal",
          /<inputExpression id="InputExpression_order_value"[^>]*>\s*<text>orderTotal<\/text>/,
        ],
      ],
    ],
    [
      "output definition editor",
      'th[data-col-id="Output_credit_decision"]',
      [
        [".context-menu .dms-output-label", "Outcome", /<output id="Output_credit_decision"[^>]*\blabel="Outcome"/],
        [".context-menu .ref-output-name", "outcome", /<output id="Output_credit_decision"[^>]*\bname="outcome"/],
      ],
    ],
  ] as const) {
    fields += inputs.length;
    const editor = await openHeaderEditor(c, column);
    if (!("menu" in editor)) {
      result[what] = `did not open (${editor.under})`;
      continue;
    }
    // the box opens over the header cell: its top-left corner on the cell's
    const off = { x: editor.menu.x - editor.head.x, y: editor.menu.y - editor.head.y };
    offs.push(off);
    const typed: string[] = [];
    for (const [selector, text, pattern] of inputs) {
      const field = await reach(c, selector, ".context-menu");
      if (!field.point) {
        typed.push(`${text}: takes no press (${field.under})`);
        continue;
      }
      await typeAt(c, field.point, text);
      const ok = (await waitFile(c, (now) => pattern.test(now))) !== null;
      typed.push(`${text}: ${ok ? "written" : "NOT written"}`);
      if (ok) written++;
    }
    result[what] = {
      boxPx: size(editor.menu),
      offPx: { x: px(off.x), y: px(off.y) },
      insideNode: inside(editor.menu, await c.node.hostBox()),
      wheelsToHeader: editor.wheels,
      typed,
    };
    // twice: the first one may only close the FEEL editor's completion list
    await c.board.press("Escape");
    await c.board.press("Escape");
    await c.board.waitFor(async () => (await c.node.query(".context-menu")).length === 0, SHOW_MS);
  }
  const placed = offs.length === 2 && offs.every((off) => far(off) <= PLACE_TOL);
  return {
    verdict: written === 0 ? "broken" : written === fields && placed ? "ok" : "degraded",
    short: `${offs.length}/2 opened, box off ${offs.map(pair).join(" and ") || "-"} px, ${written}/${fields} fields written`,
    measured: { ...result, opened: offs.length, written, fields },
  };
}

async function tableReorder(c: Ctx): Promise<Outcome> {
  await openTable(c);
  const handle = await aimFor(c, `td.rule-index[data-row-id="${RULES[0]}"] .dmn-icon-drag`);
  if (!handle.point) return unreachable("the first rule's drag handle", handle);
  // Onto the lower half of the second rule's index cell: the rule lands below it. Not onto a row at
  // the table's lower edge: the browser scrolls a table under a drag held near its edge (measured:
  // 119 px within 300 ms), the row is gone from under the pointer and the drop is lost.
  const target = 1;
  const row = await first(c, `td.rule-index[data-row-id="${RULES[target]}"]`);
  const to = row && aimAt(await c.node.map(), { x: row.x + row.width / 2, y: row.y + row.height * 0.75 });
  const onRow = to ? (await hits(c, [to], `td[data-row-id="${RULES[target]}"]`))[0] : undefined;
  if (!to || !onRow?.match) {
    return {
      verdict: "broken",
      short: `the second rule's index cell takes no drop (${onRow?.what ?? "not in the page"})`,
      measured: { handlePx: handle.box ? size(handle.box) : null, under: onRow?.what ?? null },
    };
  }
  const wanted = [RULES[1], RULES[0], ...RULES.slice(2)];
  const before = await c.node.inDocument(SCROLL, SCROLLER);
  await c.board.drag(handle.point, to, { steps: 10 });
  const text = await waitFile(c, (now) => ruleOrder(now).join() !== RULES.join());
  const after = await c.node.inDocument(SCROLL, SCROLLER);
  const order = ruleOrder(text ?? (await fileText(c)));
  const right = order.join() === wanted.join();
  const numbers = (ids: readonly string[]): number[] => ids.map((id) => RULES.indexOf(id as never) + 1);
  return {
    verdict: right ? "ok" : text ? "wrong-data" : "broken",
    short: right
      ? "rule 1 dropped below rule 2: order right"
      : text
        ? `order is ${numbers(order).join(",")}, right is ${numbers(wanted).join(",")}`
        : "order unchanged",
    measured: {
      droppedBelowRule: target + 1,
      order: numbers(order),
      wanted: numbers(wanted),
      handlePx: handle.box ? size(handle.box) : null,
      tableScrolledDuringDragPx: before && after ? after.top - before.top : null,
    },
  };
}

// ── literal expression ───────────────────────────────────────────────────────

/** an engine handle as hooks.engine(nodeId) hands it out, as far as this script reads it */
interface EngineWindow {
  __boardSpike?: {
    engine(id: string): { engine?: { diagram(): { get(name: string): unknown } | undefined } } | undefined;
  };
}

/** in-page strategies only: the type change through the DRD's own replace service */
const REPLACE_BY_API = (arg: { node: string; element: string }): boolean => {
  const diagram = (window as unknown as EngineWindow).__boardSpike?.engine(arg.node)?.engine?.diagram();
  if (!diagram) return false;
  const registry = diagram.get("elementRegistry") as { get(id: string): unknown };
  const replace = diagram.get("drdReplace") as { replaceElement(element: unknown, target: unknown): unknown };
  replace.replaceElement(registry.get(arg.element), { type: "dmn:Decision", table: false, expression: true });
  return true;
};

/** makes the sample's decision a literal expression: by pointer, else by keys, else through the engine */
async function toLiteralExpression(c: Ctx): Promise<"pointer" | "keyboard" | "engine API"> {
  const isLiteral = (text: string): boolean => /<literalExpression/.test(text) && !/<decisionTable/.test(text);
  const chosen = await select(c, DECISION);
  const wrenchSelector = '.djs-context-pad.open .entry[data-action="replace"]';
  const wrench = chosen.point ? await aim(c, await rested(c, wrenchSelector), wrenchSelector) : NO_AIM;
  if (wrench.point) {
    await c.board.click(wrench.point);
    if (await rested(c, ".djs-popup")) {
      const entry = await aimFor(c, '.djs-popup .entry[data-id="replace-with-literal-expression"]');
      if (entry.point) {
        await c.board.click(entry.point);
        if (await waitFile(c, isLiteral)) return "pointer";
      } else {
        await c.board.press("ArrowDown");
        await c.board.press("Enter");
        if (await waitFile(c, isLiteral)) return "keyboard";
      }
    }
  }
  if (!c.frame && (await c.board.page.evaluate(REPLACE_BY_API, { node: NODE, element: DECISION }))) {
    if (await waitFile(c, isLiteral)) return "engine API";
  }
  throw new Unmeasured("the decision could not be made a literal expression by pointer, keys or engine");
}

async function literalExpression(c: Ctx): Promise<Outcome> {
  // the sample has no decision with a literal expression: its one decision is changed to one first
  const route = await toLiteralExpression(c);
  await settle(c, 300);
  const view = ".dmn-literal-expression-container";
  await openDecision(c, `${view} .literal-expression`);
  const host = await c.node.hostBox();
  const steps: Record<string, string> = {};
  let done = 0;
  for (const [what, selector, text, pattern] of [
    [
      "expression",
      `${view} .literal-expression.textarea`,
      "orderValue > 1000",
      /<literalExpression[^>]*>\s*<text>orderValue &gt; 1000<\/text>/,
    ],
    ["name", `${view} .decision-name`, "Credit gate", /<decision id="credit-limit-check" name="Credit gate"/],
    ["variable name", `${view} .variable-name-input`, "gate", /<variable id="Variable_credit_decision" name="gate"/],
  ] as const) {
    const field = await aimFor(c, selector);
    if (!field.point) {
      steps[what] = `takes no press (${field.under})`;
      continue;
    }
    await typeAt(c, field.point, text);
    const ok = (await waitFile(c, (now) => pattern.test(now))) !== null;
    steps[what] = ok ? "written" : "NOT written";
    if (ok) done++;
  }
  // the type field: a list like the table's
  const typeSelector = `${view} .variable-type-select .dms-input`;
  const typeField = await aimFor(c, typeSelector);
  let list: Dropdown | null = null;
  let typeRoute = "none";
  if (typeField.point && typeField.box) {
    await c.board.click(typeField.point);
    list = await dropdown(c, typeField.box);
    const picked = await pickType(c, !!list, (now) =>
      /<variable id="Variable_credit_decision"[^>]*typeRef="boolean"/.test(now),
    );
    typeRoute = picked.route;
    steps.type = picked.set ? `set by ${picked.route}` : "NOT set";
    if (picked.set) done++;
  } else steps.type = `takes no press (${typeField.under})`;
  const shown = await first(c, view);
  const fields = await first(c, `${view} .literal-expression-properties`);
  const allByPointer = done === 4 && typeRoute === "pointer" && (!list || dropdownPlaced(list));
  return {
    verdict: done === 0 ? "broken" : allByPointer ? "ok" : "degraded",
    short: `type changed by ${route}; ${done}/4 fields (${Object.entries(steps)
      .map(([what, how]) => `${what} ${how}`)
      .join(", ")})${list ? `; type ${dropdownShort(list)}` : ""}`,
    measured: {
      sampleHasLiteralExpression: false,
      madeOneBy: route,
      steps,
      written: done,
      viewPx: shown ? size(shown) : null,
      propertiesVisible: round(area(intersect(fields, host)) / Math.max(1, area(fields ?? null)), 2),
      typeList: list ? dropdownMeasured(list) : "none",
    },
  };
}

// ── switching views ──────────────────────────────────────────────────────────

interface DrdView {
  /** each shape's box relative to the host: x, y, width as shares of the host's width and height */
  shapes: Array<{ x: number; y: number; width: number }>;
  host: Box;
  matrix: { a: number; e: number; f: number } | null;
}

async function drdView(c: Ctx): Promise<DrdView> {
  const host = await c.node.hostBox();
  const shapes: DrdView["shapes"] = [];
  for (const id of SHAPES) {
    const box = await c.board.waitForBox(() => c.node.elementBox(id), SHOW_MS);
    if (!box) throw new Unmeasured(`the DRD does not show ${id}`);
    shapes.push({
      x: (box.x - host.x) / host.width,
      y: (box.y - host.y) / host.height,
      width: box.width / host.width,
    });
  }
  const matrix = await c.node.viewportMatrix();
  return { shapes, host, matrix: matrix && { a: matrix.a, e: matrix.e, f: matrix.f } };
}

async function switchViews(c: Ctx, zoomBy: number): Promise<Outcome> {
  const before = await drdView(c);
  await openTable(c);
  /** armedzoom=disarm: what the node's own rule made of the board zoom (null: no zoom, or another policy) */
  let byRule: Record<string, unknown> | null = null;
  let violated = false;
  if (zoomBy !== 1) {
    const [policy, counted] = [await c.board.armPolicy(NODE), (await c.board.counters()).arm];
    // the node's corner stays where it IS (ORIGIN unless arming moved the board), the zoom is the one in effect x zoomBy
    await c.board.showNode(NODE, round(c.zoom * zoomBy, 4), await cornerOf(c.board));
    await settle(c, 250);
    if (policy?.armedzoom === "disarm") {
      // The node's rule: a board zoom makes the armed node a preview first (a script's zoom inside
      // its first tick). That is specified, and proved by the rules' own counters
      const [now, disarmed, zoomed] = [
        (await c.board.counters()).arm,
        !(await c.node.state()).armed,
        await c.board.viewport(),
      ];
      violated = now.lateDisarms > 0 || now.armedZoomTicks > 0;
      byRule = {
        disarmedByTheZoom: disarmed,
        boardZoomAfterTheZoom: round(zoomed.zoom, 4),
        disarmsBeforeZoom: now.disarmsBeforeZoom - counted.disarmsBeforeZoom,
        disarmsAtTick: now.disarmsAtTick - counted.disarmsAtTick,
        lateDisarms: now.lateDisarms,
        armedZoomTicks: now.armedZoomTicks,
      };
      if (disarmed) {
        // a preview takes no press: the person arms the node again to get back to the DRD (the board may move once more)
        await c.board.arm(NODE);
        await settle(c, 250);
        const again = await c.board.viewport();
        Object.assign(byRule, {
          armedAgain: (await c.node.state()).armed,
          viewportArmedAgain: { x: round(again.x, 2), y: round(again.y, 2), zoom: round(again.zoom, 4) },
          tableStillShown: (await c.node.query("table.tjs-table")).length > 0,
        });
        if (byRule.armedAgain !== true) throw new Unmeasured("the node did not arm again after the zoom disarmed it");
      }
    }
  }
  const back = await aimFor(c, ".view-drd-button");
  if (back.point) await c.board.click(back.point);
  else await c.node.inDocument(CLICK, ".view-drd-button");
  const shown = await c.board.waitFor(async () => (await c.node.viewportMatrix()) !== null, 8000);
  if (!shown) {
    return { verdict: "broken", short: "the DRD did not come back", measured: { backButton: back.under } };
  }
  await settle(c, 400);
  const after = await drdView(c);
  // the picture relative to the node: every shape at the same share of the host as before
  const drifts = after.shapes.map((shape, index) => ({
    x: (shape.x - before.shapes[index]!.x) * after.host.width,
    y: (shape.y - before.shapes[index]!.y) * after.host.height,
  }));
  const drift = Math.max(...drifts.map(far));
  const scaleRatio = round(after.shapes[0]!.width / before.shapes[0]!.width, 4);
  const same = drift <= 1.5 && Math.abs(scaleRatio - 1) <= 0.005;
  const ruleNote = !byRule
    ? ""
    : violated
      ? " (RULE VIOLATED: a late disarm or a zoom tick under the armed node)"
      : byRule.disarmedByTheZoom === true
        ? " (the zoom disarmed by rule, armed again)"
        : " (armedzoom=disarm, but the zoom did NOT disarm)";
  return {
    // armedzoom=disarm: an armed editor that saw a zoom step is the defect the rule exists to prevent
    verdict: violated ? "broken" : same ? "ok" : "degraded",
    short: `view moved ${px(drift)} px, scale x${scaleRatio.toFixed(3)}${ruleNote}${back.point ? "" : " (View DRD by script click: it takes no press)"}`,
    measured: {
      ...(byRule ? { byRule } : {}),
      boardZoomAfter: round(c.zoom * zoomBy, 4),
      driftPx: px(drift),
      driftOfDecisionPx: { x: px(drifts[0]!.x), y: px(drifts[0]!.y) },
      scaleRatio,
      matrixBefore: before.matrix && { a: round(before.matrix.a, 4), e: px(before.matrix.e), f: px(before.matrix.f) },
      matrixAfter: after.matrix && { a: round(after.matrix.a, 4), e: px(after.matrix.e), f: px(after.matrix.f) },
      backButtonByPointer: !!back.point,
      netScaleAfter: round(await c.node.netScale(), 4),
    },
  };
}

// ── simulation form ──────────────────────────────────────────────────────────

async function simForm(c: Ctx): Promise<Outcome> {
  await openTable(c);
  const host = await c.node.hostBox();
  const form = await first(c, ".dmn-sim");
  if (!form) throw new Unmeasured("the table view shows no simulation form");
  const visible = area(intersect(form, host)) / area(form);
  const numbers = await c.node.query(".dmn-sim input.dmn-sim-input");
  const controls: Array<[string, Aim]> = [
    ["segment select", await aimFor(c, ".dmn-sim select.dmn-sim-input")],
    ["order value", await aim(c, numbers[0], ".dmn-sim input.dmn-sim-input")],
    ["overdue invoices", await aim(c, numbers[1], ".dmn-sim input.dmn-sim-input")],
    ["Simulate", await aimFor(c, ".dmn-sim-run")],
  ];
  const reachable = controls.filter(([, found]) => found.point).length;
  const measured = {
    formPx: size(form),
    shareOfNodeHeight: round(form.height / host.height, 3),
    visibleShare: round(visible, 3),
    controls: Object.fromEntries(controls.map(([what, found]) => [what, found.point ? "in reach" : found.under])),
    reachable,
  };
  const [, value, overdue, simulate] = controls.map(([, found]) => found.point);
  if (!value || !overdue || !simulate) {
    return {
      verdict: "broken",
      short: `form ${size(form)} px = ${round((100 * form.height) / host.height, 0)} % of the node's height, ${round(visible * 100, 0)} % visible, ${reachable}/4 controls in reach: cannot simulate`,
      measured,
    };
  }
  // 500 EUR, no overdue invoice, any segment: the small order rule (4) approves
  await typeAt(c, value, "500");
  await typeAt(c, overdue, "0");
  await c.board.click(simulate);
  const shown = await c.board.waitFor(async () => (await c.node.query(".dmn-sim-result")).length > 0, WRITE_MS);
  const result = shown ? await c.node.inDocument(TEXT, ".dmn-sim-result") : null;
  const matched = (await c.node.query("tr.dmn-sim-match")).length;
  const right = !!result && /approve/.test(result) && /Rule 4/.test(result) && matched === 1;
  return {
    verdict: !right ? "broken" : reachable === 4 && visible >= 0.99 ? "ok" : "degraded",
    short: `form ${size(form)} px = ${round((100 * form.height) / host.height, 0)} % of the node's height, ${round(visible * 100, 0)} % visible, ${reachable}/4 controls in reach, result ${result ? `"${result}"` : "none"}`,
    measured: { ...measured, result, matchedRows: matched },
  };
}

// ── wheel and keys in the table ──────────────────────────────────────────────

async function tableWheelKeys(c: Ctx): Promise<Outcome> {
  await openTable(c);
  await recordEvents(c.board.page);
  if (c.node.frame) await recordEvents(c.node.frame);
  const trusted = async (type: string): Promise<{ top: number; frame: number | null }> => ({
    top: (await seenEvents(c.board.page, type)).filter((one) => one.trusted).length,
    frame: c.node.frame ? (await seenEvents(c.node.frame, type)).filter((one) => one.trusted).length : null,
  });
  const host = await c.node.hostBox();
  const view = intersect(await first(c, SCROLLER), host);
  const over = await aim(c, view, "table.tjs-table");
  const scale = await scaleOf(c);
  const viewport = await c.board.viewport();
  const boardText = await c.board.boardText();
  const measured: Record<string, unknown> = { tableInReach: !!over.point };
  let scrolled = { x: 0, y: 0 };
  let room = { x: 0, y: 0 };
  let boardMoved: boolean;
  if (over.point) {
    const before = (await c.node.inDocument(SCROLL, SCROLLER))!;
    room = { x: before.maxLeft, y: before.maxTop };
    await wheelAt(c, over.point, { x: 0, y: 60 }, SCROLLER);
    const down = (await c.node.inDocument(SCROLL, SCROLLER))!;
    await wheelAt(c, over.point, { x: 100, y: 0 }, SCROLLER);
    const right = (await c.node.inDocument(SCROLL, SCROLLER))!;
    scrolled = { x: right.left - before.left, y: down.top - before.top };
    boardMoved = JSON.stringify(await c.board.viewport()) !== JSON.stringify(viewport);
    measured.wheel = {
      asked: { x: 100, y: 60 },
      scrolledLayoutPx: scrolled,
      scrolledScreenPx: { x: px(scrolled.x * scale), y: px(scrolled.y * scale) },
      room,
      boardMoved,
      seen: await trusted("wheel"),
    };
    // the pinch gesture over the table: reported, not judged
    await c.board.wheel(over.point, -100, { hold: ["Control"] });
    await settle(c, 150);
    const pinched = await c.board.viewport();
    measured.controlWheel = { boardZoomBefore: viewport.zoom, boardZoomAfter: round(pinched.zoom, 4) };
    if (pinched.zoom !== viewport.zoom) await c.board.setViewport(viewport);
  } else {
    // nothing of the table takes a wheel: what a wheel over the middle of the node does instead
    const middle = centre(host);
    await wheelAt(c, middle, { x: 0, y: 60 });
    boardMoved = JSON.stringify(await c.board.viewport()) !== JSON.stringify(viewport);
    measured.wheel = { over: "the middle of the node", boardMoved, seen: await trusted("wheel") };
    if (boardMoved) await c.board.setViewport(viewport);
  }
  // keys in a cell
  await clearEvents(c.board.page);
  if (c.node.frame) await clearEvents(c.node.frame);
  const cell = await reach(c, 'td[data-element-id="UnaryTests_blocked_overdue"]', SCROLLER);
  const text = await fileText(c);
  let keysOk: boolean | null = null;
  if (cell.point) {
    await c.board.click(cell.point);
    await focusReady(c);
    await settle(c, 80);
    const keys = ["a", "Backspace", "Delete", "ArrowLeft", "Enter", "Tab", "Escape"];
    for (const key of keys) await c.board.press(key);
    await settle(c, 500);
    const nodes = await c.board.nodes();
    const armed = nodes.find((one) => one.id === NODE)?.armed === true;
    keysOk =
      armed &&
      nodes.length === 1 &&
      (await c.board.boardText()) === boardText &&
      JSON.stringify(await c.board.viewport()) === JSON.stringify(viewport);
    measured.keys = {
      pressed: keys,
      seen: await trusted("keydown"),
      nodeStillArmed: armed,
      boardNodes: nodes.length,
      boardFileSame: (await c.board.boardText()) === boardText,
      modelFileSame: (await fileText(c)) === text,
      focusAfter: await c.node.inDocument(ACTIVE),
    };
  } else measured.keys = `no cell takes a press (${cell.under})`;
  const wheel = measured.wheel as { seen: { top: number; frame: number | null } };
  const keySeen =
    typeof measured.keys === "object" ? (measured.keys as { seen: { top: number; frame: number | null } }).seen : null;
  const where = (seen: { top: number; frame: number | null } | null): string =>
    seen ? `top ${seen.top}${seen.frame === null ? "" : ` / frame ${seen.frame}`}` : "-";
  const didScroll = scrolled.x > 0 || scrolled.y > 0;
  return {
    verdict: boardMoved || keysOk === false ? "broken" : didScroll && keysOk === true ? "ok" : "degraded",
    short: `${over.point ? `scrolled ${scrolled.x}/${scrolled.y} layout px for a wheel of 100/60 (room ${room.x}/${room.y})` : "table takes no wheel"}, board ${boardMoved ? "MOVED" : "still"}; wheel seen by ${where(wheel.seen)}; keys ${keysOk === null ? "not pressed" : keysOk ? "stay in the editor" : "REACH THE BOARD"}, seen by ${where(keySeen)}`,
    measured,
  };
}

// ── the cases ────────────────────────────────────────────────────────────────

const CASES: readonly CaseDef[] = [
  {
    name: "drd-move",
    view: "drd",
    did: "dragged an input data shape by (60, 40) flow units of pointer travel, Control held",
    expected: "the shape moves as far as the pointer on screen (ratio 1.00): what a person sees under the hand",
    rule: "ok: the shape's displacement is within max(2 px, 1.5 diagram units) of the pointer's on both axes and the file changed; else broken",
    run: drdMove,
  },
  {
    name: "drd-create",
    view: "drd",
    did: "dragged the palette's decision entry onto a bare point of the canvas, Control held",
    expected: "the new decision's middle lies on the drop point",
    rule: "ok: created, in the file, middle within max(2 px, 1.5 units) of the drop point; else broken (also when the entry or a bare point takes no press)",
    run: drdCreate,
  },
  {
    name: "drd-connect",
    view: "drd",
    did: "selected an input data, dragged the pad's connect entry over bare canvas (held there) and on to the decision",
    expected: "the rubber band ends under the pointer and the file gains one information requirement",
    rule: "ok: connected and the preview's end within max(3 px, 1.5 units) of the pointer; degraded: connected, preview off; broken: not connected or the pad entry takes no press",
    run: drdConnect,
  },
  {
    name: "drd-pad",
    view: "drd",
    did: "selected an element with a click and read the context pad's place",
    expected:
      "the pad at the right edge of the element's graphics plus 8 px times the diagram scale, at its top (ContextPad._getPosition), every entry in reach",
    rule: "ok: pad within 3 px of that place and all entries take a press; degraded: displaced or some entries out of reach; broken: no entry in reach or nothing selectable",
    run: drdPad,
  },
  {
    name: "drd-popup",
    view: "drd",
    did: "opened the decision's change type popup from the pad and picked Literal expression",
    expected:
      "the popup at the pad's left edge, 5 px below its bottom (getReplaceMenuPosition), the entry in reach, the file's decision a literal expression afterwards",
    rule: "ok: popup within 3 px (its 5 px gap in px of the node's document or scaled with the host) and the entry clicked by pointer changed the type; degraded: displaced, or changed by keys only; broken: type not changed",
    run: drdPopup,
  },
  {
    name: "drd-label",
    view: "drd",
    did: "double-clicked an input data, typed a name, Enter",
    expected: "the label editor's box lies on the shape (same middle, same width) and the name is in the file",
    rule: "ok: written, box middle within 3 px and width within 10 % of the shape's; degraded: written, box off; broken: no editor or not written",
    run: drdLabel,
  },
  {
    name: "drd-definitions",
    view: "drd",
    did: 'put a text into the definitions name and id fields of the card at the DRD\'s top-left (one insertion each), Enter once the file had it; then "ab", a pause until the engine wrote, "cd" into the name',
    expected:
      "both land in the file; the card covers no shape's middle and not the drill-down button's. Reported and not judged: \"abcd\" after the pause",
    rule: "ok: 2 of 2 written and the card covers no shape centre and not the drill-down button's centre; degraded: 1 written, or it covers one; broken: none written",
    run: drdDefinitions,
  },
  {
    name: "drd-open-table",
    view: "drd",
    did: "hit-tested the decision's drill-down button on a 5 x 5 grid and clicked a free point of it",
    expected: "the button's centre takes the press and the click opens the decision table",
    rule: "ok: centre free and the table opens; degraded: only an off-centre point is free, the table opens; broken: no point free or nothing opens",
    run: drdOpenTable,
  },
  {
    name: "table-visible",
    view: "decisionTable",
    did: "opened the table and read how much of it the node shows and how large its text is on screen",
    expected: `at least one whole rule row visible and text of at least ${READABLE_PX} px on screen`,
    rule: `ok: a whole rule row visible and text >= ${READABLE_PX} px; degraded: part of the table visible but no whole rule row or text below ${READABLE_PX} px; broken: nothing of the table visible`,
    run: tableVisible,
  },
  {
    name: "table-col-resize",
    view: "decisionTable",
    did: "dragged the first input column's border 40 screen px to the right",
    expected:
      "the file holds the column's width before plus the pointer's travel in layout px (the border follows the pointer)",
    rule: "ok: written width within 1 of that; wrong-data: another width written; broken: nothing written or the border takes no press",
    run: tableColumnResize,
  },
  {
    name: "table-col-click",
    view: "decisionTable",
    did: "clicked the first input column's border without moving the pointer",
    expected: "the column keeps its width: nothing written, or the width it has (192)",
    rule: "ok: nothing written or the written width within 1 of the column's width; wrong-data: another width written; broken: the border takes no press",
    run: tableColumnClick,
  },
  {
    name: "table-type",
    view: "decisionTable",
    did: "typed into an input entry, an output entry and an annotation of the first rule, scrolling by wheel where needed",
    expected: "all three texts in the file",
    rule: "ok: 3 of 3 in the file; degraded: 1 or 2; broken: none",
    run: tableType,
  },
  {
    name: "table-feel",
    view: "decisionTable",
    did: 'in the FEEL cell "key-account": click, click on the boundary before character 6, before 4, drag from 2 to 9, type X',
    expected: 'caret at 6, then 4; the drag selects "ey-acco"; the file holds "kXunt" with its quotes',
    rule: "ok: both carets, the selection and the file right; degraded: text reached the file but a caret or the selection is off; broken: no focus or nothing written",
    run: tableFeel,
  },
  {
    name: "table-menu-rule",
    clicks: true,
    view: "decisionTable",
    did: "right-clicked the first rule's first entry and clicked Add rule below",
    expected:
      "the menu's corner at the click (left or right of it, above or below, clamped into the table's container), a sixth rule in the file",
    rule: "ok: menu within 3 px of such a place and the entry worked; degraded: displaced, entry worked; broken: no menu or the entry takes no press",
    run: tableMenuRule,
  },
  {
    name: "table-menu-column",
    clicks: true,
    view: "decisionTable",
    did: "right-clicked the second input column's header and clicked Add input right",
    expected: "the menu's corner at the click (clamped into the table's container), a fourth input in the file",
    rule: "ok: menu within 3 px of such a place and the entry worked; degraded: displaced, entry worked; broken: no menu or the entry takes no press",
    run: tableMenuColumn,
  },
  {
    name: "table-add",
    clicks: true,
    view: "decisionTable",
    did: "clicked the header's add input button and the footer's add rule cell, scrolling by wheel where needed",
    expected: "a fourth input and a sixth rule in the file",
    rule: "ok: both added; degraded: one; broken: none",
    run: tableAdd,
  },
  {
    name: "table-hit-policy",
    clicks: true,
    view: "decisionTable",
    did: "opened the hit policy list and picked Collect (else the first other policy in reach)",
    expected:
      "the list under its field (same left edge, same width, top at the field's bottom), the picked policy in the file",
    rule: "ok: list within 3 px and as wide as the field, the picked policy in the file; degraded: displaced, policy set; wrong-data: another policy in the file than picked; broken: nothing set",
    run: tableHitPolicy,
  },
  {
    name: "table-type-dropdown",
    clicks: true,
    view: "decisionTable",
    did: "double-clicked an input header, opened the type list in its editor and picked boolean",
    expected: "the list at its field (above or below), boolean in reach, the input's typeRef boolean in the file",
    rule: "ok: list within 3 px, boolean picked by pointer and in the file; degraded: displaced, or the type only by typing into the field; broken: type not set",
    run: tableTypeDropdown,
  },
  {
    name: "table-header-editors",
    clicks: true,
    view: "decisionTable",
    did: "double-clicked an input header and the output header, typed label and expression, label and name",
    expected: "each editor box with its top-left corner on the header cell's, all four texts in the file",
    rule: "ok: both boxes within 3 px and 4 of 4 written; degraded: displaced or fewer written; broken: none written",
    run: tableHeaderEditors,
  },
  {
    name: "table-reorder",
    view: "decisionTable",
    did: "dragged the first rule by its handle onto the lower half of the second rule's index cell",
    expected: "the first rule lands below the second in the file (order 2,1,3,4,5)",
    rule: "ok: that order; wrong-data: another new order; broken: order unchanged or handle or target out of reach",
    run: tableReorder,
  },
  {
    name: "literal-expression",
    clicks: true,
    view: "literalExpression",
    did: "made the sample's one decision a literal expression (pad popup by pointer, else keys, else the engine), opened its view by script click, typed the expression, the name, the variable name, picked the type",
    expected: "all four in the file, the type picked from its list by pointer",
    rule: "ok: 4 of 4 and the type list within 3 px and picked by pointer; degraded: fewer, or the type by typing, or the list displaced; broken: none",
    run: literalExpression,
  },
  {
    name: "switch-views",
    clicks: true,
    view: "drd",
    did: "DRD, table (script click), back with the View DRD button",
    expected: "the DRD shows the same picture relative to the node as before",
    rule: "ok: no shape more than 1.5 px from its place relative to the node and the scale within 0.5 %; degraded: the view moved; broken: the DRD did not come back",
    run: (c) => switchViews(c, 1),
  },
  {
    name: "switch-views-zoomed",
    clicks: true,
    view: "drd",
    did: "DRD, table (script click), board zoom x 1.25 while the table shows, back with the View DRD button",
    expected: "the DRD shows the same picture relative to the node as before, at the new board zoom",
    rule: "ok: no shape more than 1.5 px from its place relative to the node and its share of the node's width within 0.5 %; degraded: the view moved or its scale did not follow; broken: the DRD did not come back. Under armedzoom=disarm (read off the page) the zoom makes the node a preview first, which is specified: the node is armed again and the same rule decides; broken also when the disarm was late or a zoom tick passed under the armed node (lateDisarms, armedZoomTicks)",
    run: (c) => switchViews(c, 1.25),
  },
  {
    name: "sim-form",
    clicks: true,
    view: "decisionTable",
    did: "read the simulation form's size and reach, typed 500 and 0, clicked Simulate",
    expected:
      'the whole form visible, its four controls in reach, the result "approve" from rule 4 and one matched row',
    rule: "ok: right result, 4 of 4 controls in reach, form at least 99 % visible; degraded: right result but a control out of reach or the form cut; broken: Simulate or a number field out of reach, or no right result",
    run: simForm,
  },
  {
    name: "table-wheel-keys",
    view: "decisionTable",
    did: "wheel of 60 down and 100 right over the table, Control + wheel, then a, Backspace, Delete, ArrowLeft, Enter, Tab, Escape in a cell",
    expected:
      "the table scrolls, the board's viewport and file stay, the node stays armed; the events' document is recorded",
    rule: "ok: the table scrolled, the board did not move, the keys changed nothing of the board; degraded: board untouched but the table did not scroll or no cell took the keys; broken: the plain wheel moved the board, or a key changed the board or disarmed the node",
    run: tableWheelKeys,
  },
];

// ── the run ──────────────────────────────────────────────────────────────────

/** the node's top-left corner against the board's own box, px: ORIGIN where the URL's viewport still holds */
async function cornerOf(board: Board): Promise<Point> {
  const [canvas, box] = [await board.canvasBox(), await board.nodeBox(NODE)];
  if (!box) throw new Error(`no node ${NODE} on the board`);
  return { x: round(box.x - canvas.x, 2), y: round(box.y - canvas.y, 2) };
}

async function one(
  harness: Harness,
  definition: CaseDef,
  strategy: Strategy,
  zoom: number,
  repeat: number,
  variant: Variant,
): Promise<Row> {
  const started = Date.now();
  const fixed = variant === "node-fixed";
  const { name, view, did, expected, rule } = definition;
  const row: Row = {
    case: name,
    notation: "dmn",
    strategy,
    zoom,
    repeat,
    variant,
    view,
    did,
    expected,
    rule,
    status: "failed",
    verdict: "unmeasured",
    short: "",
    measured: {},
    feelErrors: 0,
    problems: [],
    ms: 0,
  };
  let board: Board | undefined;
  try {
    board = await harness.open(
      { board: "matrix", strategy, notations: ["dmn"], zoom, ...ORIGIN },
      fixed ? { init: UNSTOP_CLICKS } : {},
    );
    await board.arm(NODE);
    // the arm rules may have moved the board: the zoom in effect and the node's place are read, not assumed
    const inEffect = await board.viewport();
    row.zoomInEffect = inEffect.zoom;
    row.viewportArmed = inEffect;
    row.nodeAt = await cornerOf(board);
    const policy = await board.armPolicy(NODE);
    row.armRules = policy ? `${policy.armzoom}/${policy.armedzoom}/${policy.armreturn}` : undefined;
    if (fixed) await board.page.evaluate(UNFOCUSABLE, NODE);
    const node = await board.node(NODE);
    await node.inDocument(COUNT_PRESSES);
    row.hostInNode = await node.inDocument(HOST_IN_NODE);
    const wantsShots = shots.some((prefix) => prefix === "all" || name.startsWith(prefix));
    const tag = `${name}-${strategy}${fixed ? "-node-fixed" : ""}-${zoom}`;
    let taken = 0;
    const c: Ctx = {
      board,
      node,
      strategy,
      zoom: inEffect.zoom,
      frame: !!node.frame,
      async shot(what, chrome) {
        if (!wantsShots) return;
        const around = await node.query(chrome);
        await node.screenshot(outPath(`shots/${tag}-${++taken}-${what}.png`), { around });
      },
    };
    row.frame = c.frame;
    row.netScale = round(await node.netScale(), 4);
    row.scale = round(await scaleOf(c), 4);
    if (!(await node.state()).armed) throw new Error("the node did not arm");
    try {
      const outcome = await definition.run(c);
      row.status = "measured";
      row.verdict = outcome.verdict;
      row.short = outcome.short;
      row.measured = outcome.measured;
    } catch (error) {
      if (!(error instanceof Unmeasured)) throw error;
      row.status = "unmeasured";
      row.reason = error.message;
      row.short = `unmeasured: ${error.message}`;
    }
    if (wantsShots) {
      const around = await node.query(".djs-popup, .context-menu, .dms-select-options");
      await node.screenshot(outPath(`shots/${tag}.png`), { around });
    }
    row.armedAfter = (await node.state()).armed;
    row.mounts = (await board.counters()).mounts[NODE];
    row.arm = (await board.counters()).arm;
    row.presses = (await node.scope.evaluate(READ_PRESSES)) ?? undefined;
    // a case that presses controls of an HTML view: say when the presses never got where dmn-js listens
    if (row.presses && row.verdict !== "ok" && definition.clicks) {
      const { made, atRoot, atDocument, focusToNodeWrapper } = row.presses;
      const notes = [
        ...(atRoot > atDocument
          ? [`${atRoot - atDocument} of ${made} clicks stopped at the page's root, before the document`]
          : []),
        ...(focusToNodeWrapper > 0 ? [`${focusToNodeWrapper} press(es) moved the focus to the node's wrapper`] : []),
      ];
      if (notes.length > 0) row.short += ` [${notes.join("; ")}]`;
    }
  } catch (error) {
    row.status = "failed";
    row.verdict = "unmeasured";
    row.reason = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    row.short = `FAILED: ${row.reason}`;
  }
  if (board) {
    row.feelErrors = board.errors.filter((line) => KNOWN_CONSOLE.feelEditor.test(line)).length;
    row.problems = await board
      .problems({ allow: [KNOWN_CONSOLE.feelEditor] })
      .catch((error: unknown) => [String(error)]);
    await board.close().catch(() => undefined);
  }
  row.ms = Date.now() - started;
  return row;
}

const MARK: Readonly<Record<Verdict, string>> = {
  ok: "ok",
  degraded: "DEGRADED",
  broken: "BROKEN",
  "wrong-data": "WRONG DATA",
  unmeasured: "unmeasured",
};
const WORST: readonly Verdict[] = ["wrong-data", "broken", "degraded", "unmeasured", "ok"];

/** " (armed at 1)" where the arm rules moved the board to another zoom than the row asked for */
const inEffectNote = (row: Row): string =>
  row.zoomInEffect !== undefined && row.zoomInEffect !== row.zoom ? ` (armed at ${row.zoomInEffect})` : "";

/** one line per case x strategy, the zooms folded into one cell */
function markdown(rows: readonly Row[], cases: readonly CaseDef[]): string {
  const lines = [
    "# DMN battery",
    "",
    `Strategies ${strategies.join(", ")}; board zooms asked for ${zooms.join(", ")}; ${repeats} run(s) per cell.`,
    "",
    "`(node fixed)`: the same case with the board node's click stop and its focusable wrapper lifted from the harness side, where the armed editor's host lies inside a board node.",
    "",
    "| Case | Strategy | Worst | Per board zoom |",
    "| --- | --- | --- | --- |",
  ];
  for (const definition of cases) {
    for (const strategy of strategies) {
      for (const variant of VARIANTS) {
        const mine = rows.filter(
          (row) => row.case === definition.name && row.strategy === strategy && row.variant === variant,
        );
        if (mine.length === 0) continue;
        const worst = WORST.find((verdict) => mine.some((row) => row.verdict === verdict)) ?? "unmeasured";
        const cells = mine.map(
          (row) =>
            `**${row.zoom}${inEffectNote(row)}${repeats > 1 ? ` #${row.repeat}` : ""}** ${MARK[row.verdict]}: ${row.short.replace(/\|/g, "/")}`,
        );
        const label = `\`${strategy}\`${variant === "node-fixed" ? " (node fixed)" : ""}`;
        lines.push(`| \`${definition.name}\` | ${label} | ${MARK[worst]} | ${cells.join("<br>")} |`);
      }
    }
  }
  lines.push("", "## Cases", "", "| Case | Did | Expected | Verdict rule |", "| --- | --- | --- | --- |");
  for (const { name, did, expected, rule } of cases) lines.push(`| \`${name}\` | ${did} | ${expected} | ${rule} |`);
  return `${lines.join("\n")}\n`;
}

await run(async (harness) => {
  if (!notationWanted) {
    console.log("NOTATIONS does not contain dmn: nothing to do");
    return 0;
  }
  const cases = CASES.filter(
    (one) => caseFilter.length === 0 || caseFilter.some((prefix) => one.name.startsWith(prefix)),
  );
  const started = Date.now();
  // one job per case x strategy x zoom x repeat: its as-built row and, where it applies, its node-fixed one
  const jobs = strategies.flatMap((strategy) =>
    zooms.flatMap((zoom) =>
      cases.flatMap((definition) =>
        Array.from({ length: repeats }, (_, index) => ({ strategy, zoom, definition, repeat: index + 1 })),
      ),
    ),
  );
  const results: Row[][] = jobs.map(() => []);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < jobs.length; index = next++) {
      const { strategy, zoom, definition, repeat } = jobs[index]!;
      let asBuilt: Row | undefined;
      for (const variant of variants) {
        // the second variant: only a case that presses HTML controls, only with the host inside a board node
        if (variant === "node-fixed" && (!definition.clicks || asBuilt?.hostInNode === false)) continue;
        const row = await one(harness, definition, strategy, zoom, repeat, variant);
        if (variant === "as-built") asBuilt = row;
        results[index]!.push(row);
        const label = variant === "node-fixed" ? `${strategy}+fix` : strategy;
        console.log(
          `${label.padEnd(12)} ${`${zoom}${inEffectNote(row)}`.padEnd(5)} ${definition.name.padEnd(21)} ${MARK[row.verdict].padEnd(11)} ${row.short}`,
        );
        for (const problem of row.problems) console.log(`    PROBLEM ${problem.slice(0, 240)}`);
      }
    }
  };
  // PARALLEL pages at a time, each in a browser context of its own; the rows keep the order of the jobs
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
  const rows = results.flat();
  const tally = (verdict: Verdict): number => rows.filter((row) => row.verdict === verdict).length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const withProblems = rows.filter((row) => row.problems.length > 0).length;
  const path = writeResult("dmn", {
    what: "board spike DMN battery: case x strategy x board zoom, one fresh page each",
    date: new Date().toISOString(),
    chromium: harness.browser.version(),
    viewport: { width: 2200, height: 1300, deviceScaleFactor: 1 },
    nodeOrigin: ORIGIN,
    file: FILE,
    strategies,
    zooms,
    repeats,
    parallel,
    allowedConsole: "KNOWN_CONSOLE.feelEditor",
    variants,
    cases: cases.map(({ name, view, did, expected, rule, clicks }) => ({
      name,
      view,
      did,
      expected,
      rule,
      hasNodeFixedVariant: !!clicks,
    })),
    rows,
  });
  const table = path.replace(/\.json$/, ".md");
  writeFileSync(table, markdown(rows, cases));
  console.log(
    `\n${rows.length} rows in ${Math.round((Date.now() - started) / 1000)} s: ${tally("ok")} ok, ${tally("degraded")} degraded, ` +
      `${tally("broken")} broken, ${tally("wrong-data")} wrong data, ${tally("unmeasured")} unmeasured (${failed} failed), ` +
      `${rows.filter((row) => row.feelErrors > 0).length} with the allowed FEEL editor error, ${withProblems} with other console errors or log lines\n${path}\n${table}`,
  );
  // the harness failed, not a strategy: a case that threw, or output where none belongs
  return failed + withProblems;
});
