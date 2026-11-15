/**
 * Battery "bpmn-chrome" of the board spike: everything of bpmn-js that is not a drag. Where its
 * chrome appears (context pad, popup menus, palette and its tooltip, the label editor, the search
 * pad), text editing, the keys, the wheel and the focus, per strategy and board zoom. A check run
 * by hand, not by `pnpm test` or CI: it starts a Vite dev server and a sandboxed headless Chromium
 * of its own (lib.ts).
 *
 *   PORT=5422 CACHE_DIR=<scratch>/vite-cache OUT_DIR=<scratch> node apps/web/test/spike/bpmn-chrome-chromium.ts
 *   STRATEGIES=plugin,shim ZOOMS=0.5,1 CASES=pad,popup,label-noop node apps/web/test/spike/bpmn-chrome-chromium.ts
 *
 * One row per case x notation x strategy x board zoom: what was done, what a person expects and
 * why, what was measured, and a verdict that a rule written here computes from the numbers. The
 * cases (PLANS at the end is the index):
 *
 *   pad@<size>              the context pad of four elements (left, middle, right edge, bottom)
 *   popup-replace@<size>    the replace menu of the same four, and choosing an entry of it
 *   popup-colour@<size>     the colour menu of the product's colour module, likewise
 *   popup-align             the align menu of a selection of two
 *   palette@<size>          the palette's layout, reach, what it covers, its tooltip
 *   label-box, label-open, label-type, label-multiline, label-escape
 *                           the label editor of a task, an event's external label, a text annotation
 *   label-noop-fit, label-noop-100
 *                           opening and closing it without typing (the file must stay as it is)
 *   label-resize            the resize handle of a text annotation's label editor (added in round 4)
 *   key-*                   Delete and Backspace, undo and redo, copy and paste, select all, the
 *                           arrow keys, the tool shortcuts, E and R, the search pad
 *   wheel-*                 plain, Shift, Control (pivot), the editor's zoom limits, a wheel over an
 *                           unarmed node and over the pane
 *   focus-*, tab-order      who has the focus after each step, and where the next key goes
 *
 * <size> is the node body in flow units: 800x508 (the matrix board's node) and 640x388 (the stress
 * board's). Where a case folds several sub-measurements (four elements, three kinds of label), the
 * row's verdict is the worst of them and `why` names which.
 *
 * Nothing is keyed on a strategy's name. What a rule needs to know about a strategy is measured on
 * the page (`env`): the editor's net scale in its own document, the screen px one CSS px of its
 * chrome takes, the screen px per diagram unit, and whether the node is a frame. `plugin` and
 * `shim` therefore run the same rules. Where a rule needs a reference it is the BASELINE: the same
 * measurement in the overlay strategy at board zoom 1, taken first in every run and written into
 * the result (`baseline`).
 *
 * Geometry under the `shim` strategy: while a shim node is armed the page's plain geometry
 * functions answer in the editor's virtual space. Every read here goes through lib.ts or through
 * window.__boardSpikeNative, with two exceptions that ask on purpose what the armed editor sees:
 * EDITOR (the label editor's size as bpmn-js reads it back on closing) and EDITOR_WINDOW (where
 * the window begins that the editor's popup placement measures against; see windowTop).
 *
 * Verdicts: `ok` (as a person expects), `degraded` (works, at a cost the row names), `broken`
 * (cannot be used with the pointer or the key that was tried), `wrong-data` (the file got something
 * else than the person chose), `unmeasured` (with the reason). A verdict is a strategy's result,
 * never a failure of the run: the exit code is 1 only when the harness failed (a page that threw
 * something that is no measurement, a navigation under the run, a console error, a page error or a
 * line in the page's log).
 *
 * Environment: STRATEGIES (default naive,counter,overlay,iframe), NOTATIONS (bpmn is the only one
 * this battery knows), ZOOMS (default 0.5,0.73,1,1.5,2; the two label-noop cases add 1.37 unless
 * ZOOMS is given), CASES (comma list: a case name, a prefix of one, or a plan's name), REPEAT
 * (default 1: every row measured that often on fresh pages, agreement recorded), JOBS (pages
 * measured side by side, default 6; each has a browser context of its own), SHOTS (0 switches the
 * screenshots off), plus lib.ts's PORT, BASE, CACHE_DIR, OUT_DIR, OUT. Results:
 * <OUT_DIR>/bpmn-chrome.json and bpmn-chrome.md, screenshots under <OUT_DIR>/shots.
 *
 * Arm rules (rounds 5 and 6): arming may move the board first (lib.ts, ARMING MOVES THE BOARD). A
 * row's `zoom` is the board zoom the page was opened with, `env.zoom` the zoom in effect after
 * arming; label-resize and wheel-unarmed compute from the latter. Since round 6 an overlay node is
 * armed at zoom exactly 1 from above 1 too: every row of a default run is measured at zoom 1 and
 * differs from its zoom 1 row in where the node lies in the window.
 * Three cases zoom the board under the armed editor. What that does is the armed node's own rule,
 * read per node through board.armPolicy (never from the strategy's name or the URL), and the two
 * wheel cases are judged by it:
 * - armedzoom=free: the rules written before the arm rules (WHEEL_TEXTS).
 * - armedzoom=disarm: the node is a preview before the first tick of a wheel zoom, inside the first
 *   tick of a script's zoom. That is the specified behaviour and ok when the counters say so
 *   (`disarmFault`: exactly one disarm, lateDisarms 0, armedZoomTicks 0); the texts are
 *   WHEEL_TEXTS_DISARM. A case that goes on arms the node again first: wheel-unarmed before its
 *   pane step, wheel-limits before its step in and out (`limits.arm.rearmedAt` is where the board
 *   stood then), label-noop-100 before it opens the editors (`measured.rearmed`; under exact1 the
 *   board is back at zoom 1 then, whatever zoom the row asked for).
 * - armedzoom=lock is judged by the rule for free: a refused zoom reads as "the board did not zoom".
 * With EXTRA_PARAMS="armzoom=off&armedzoom=free" every row is round 4's.
 */
import { writeFileSync } from "node:fs";

import {
  aimAt,
  type ArmCounters,
  type ArmedZoom,
  type ArmZoom,
  type Board,
  type BoardQuery,
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
  seenEvents,
  STRATEGIES,
  type Strategy,
  toScreen,
  type Viewport,
  writeResult,
} from "./lib.ts";

// ── what runs ────────────────────────────────────────────────────────────────

const words = (name: string): string[] => (process.env[name] ?? "").split(",").filter(Boolean);
const numbers = (text: string): number[] =>
  text
    .split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);

const DEFAULT_STRATEGIES: readonly Strategy[] = ["naive", "counter", "overlay", "iframe"];
const strategies: Strategy[] =
  words("STRATEGIES").length === 0
    ? [...DEFAULT_STRATEGIES]
    : STRATEGIES.filter((one) => words("STRATEGIES").includes(one));
const notations = words("NOTATIONS").length === 0 ? ["bpmn"] : words("NOTATIONS");
const zooms = numbers(process.env.ZOOMS ?? "0.5,0.73,1,1.5,2");
/** board zooms at which float inexactness was seen to run commands: the label-noop cases add them */
const ODD_ZOOMS = process.env.ZOOMS === undefined ? [1.37] : [];
const wanted = words("CASES");
const repeat = Math.max(1, Math.floor(Number(process.env.REPEAT ?? 1)) || 1);
const jobs = Math.max(1, Math.floor(Number(process.env.JOBS ?? 6)) || 1);
const shots = process.env.SHOTS !== "0";

/** the reference every "against a baseline" compares with */
const BASELINE = { strategy: "overlay", zoom: 1 } as const satisfies { strategy: Strategy; zoom: number };

/** where a node's top-left corner sits in the canvas: clear of the toolbar */
const ORIGIN = { x: 60, y: 80 };
const WINDOW = { width: 2200, height: 1300 };
const FILE = "processes/order-to-cash.bpmn";
/** screen px a placement may be off before a row says so */
const PX = 2;
/** screen px below which an entry counts as small: half of the 22 px bpmn-js gives a pad entry */
const SMALL = 12;
/** diagram units a stored geometry value may move without a person having asked for it (one grid step) */
const UNITS = 10;

type Size = "800x508" | "640x388";
const SIZES: Readonly<
  Record<Size, { node: string; query(strategy: Strategy, zoom: number, second: boolean): BoardQuery }>
> = {
  "800x508": {
    node: "m-bpmn",
    query: (strategy, zoom, second) => ({
      board: "matrix",
      strategy,
      notations: second ? ["bpmn", "dmn"] : ["bpmn"],
      zoom,
      ...ORIGIN,
    }),
  },
  "640x388": {
    node: "s-0",
    query: (strategy, zoom) => ({ board: "stress", strategy, notation: "bpmn", count: 1, zoom, ...ORIGIN }),
  },
};
const BOTH_SIZES: readonly Size[] = ["800x508", "640x388"];

/** the sample's flow nodes: what the palette or a misplaced pad can cover */
const SHAPES = [
  "StartEvent_order_received",
  "Task_validate_order",
  "Task_check_credit",
  "Gateway_credit_approved",
  "Task_fulfill_order",
  "EndEvent_order_rejected",
  "Task_reject_order",
  "CallActivity_invoice_handling",
  "EndEvent_order_fulfilled",
  "StartEvent_customer_inquiry",
  "Task_handle_inquiry",
  "EndEvent_inquiry_resolved",
] as const;

/** the elements a pad and its popups are measured on, by where they lie in the diagram */
const POSITIONS = [
  { name: "left", elements: ["Task_validate_order", "StartEvent_order_received"] },
  { name: "middle", elements: ["Task_reject_order"] },
  { name: "right", elements: ["EndEvent_order_fulfilled"] },
  { name: "bottom", elements: ["Task_handle_inquiry"] },
] as const;
type Position = (typeof POSITIONS)[number]["name"];

// ── rows ─────────────────────────────────────────────────────────────────────

type Verdict = "ok" | "degraded" | "broken" | "wrong-data" | "unmeasured";
const SEVERITY: Readonly<Record<Verdict, number>> = {
  unmeasured: -1,
  ok: 0,
  degraded: 1,
  broken: 2,
  "wrong-data": 3,
};

/** what a strategy is on the page, measured: the rules key on these, never on a strategy's name */
interface Env {
  /**
   * The board zoom the page had when this was read, after arming: the zoom IN EFFECT. The arm rules
   * may move the board before they arm (lib.ts, ARMING MOVES THE BOARD), so it need not be the
   * row's `zoom`, which is the zoom the page was opened with.
   */
  zoom: number;
  /** client px per layout px of the engine host in its own document: 1 is what diagram-js assumes */
  net: number;
  /** the editor lives in a document of its own */
  frame: boolean;
  /** screen px one CSS px of the editor's chrome takes: the net scale times the frame's scale */
  chrome: number;
  /** screen px per diagram unit */
  unit: number;
  /** the scale of g.viewport in its own svg: the editor's own zoom */
  canvas: number;
  /** the engine host on screen */
  host: Box;
  /** the node body in flow units */
  body: { width: number; height: number };
}

interface Row {
  case: string;
  notation: "bpmn";
  strategy: Strategy;
  zoom: number;
  /** what was done */
  did: string;
  /** what a person expects, and why that is the expectation */
  expected: string;
  /** how the verdict follows from the numbers */
  rule: string;
  env: Partial<Env>;
  measured: Record<string, unknown>;
  verdict: Verdict;
  /** the clause of the rule that decided */
  why: string;
  /** the reason, when the verdict is `unmeasured` (or a part of the row could not be measured) */
  unmeasured?: string;
  /** the row in one line, for the tables */
  cell: string;
  /** console errors, page errors and lines of the page's log of the pages behind this row */
  problems: string[];
  /** REPEAT > 1: the verdict and the one-line result of every run, and whether they agree */
  repeats?: { runs: number; verdicts: Verdict[]; cells: string[]; agree: boolean };
}

interface Text {
  did: string;
  expected: string;
  rule: string;
}

interface Ctx {
  harness: Harness;
  strategy: Strategy;
  zoom: number;
}

interface Sub {
  name: string;
  verdict: Verdict;
  why: string;
  /** a few numbers for the one-line result */
  short?: string;
}

/** the worst of the measured parts decides; parts that could not be measured are named, not counted */
function fold(subs: readonly Sub[]): { verdict: Verdict; why: string; cell: string; unmeasured?: string } {
  const measured = subs.filter((sub) => sub.verdict !== "unmeasured");
  const skipped = subs.filter((sub) => sub.verdict === "unmeasured");
  const verdict = measured.reduce<Verdict>(
    (worst, sub) => (SEVERITY[sub.verdict] > SEVERITY[worst] ? sub.verdict : worst),
    measured.length > 0 ? "ok" : "unmeasured",
  );
  const telling = subs.filter((sub) => sub.verdict !== "ok");
  const unmeasured = skipped.map((sub) => `${sub.name}: ${sub.why}`).join("; ");
  return {
    verdict,
    why:
      telling.length === 0
        ? "every part as expected"
        : telling.map((sub) => `${sub.name} ${sub.verdict}: ${sub.why}`).join("; "),
    cell: subs.map((sub) => `${sub.name} ${sub.verdict}${sub.short ? ` (${sub.short})` : ""}`).join(" | "),
    ...(unmeasured ? { unmeasured } : {}),
  };
}

const r1 = (value: number): number => round(value, 1);
const r2 = (value: number): number => round(value, 2);
const r3 = (value: number): number => round(value, 3);
const rbox = (box: Box): Box => ({ x: r1(box.x), y: r1(box.y), width: r1(box.width), height: r1(box.height) });
const size = (box: { width: number; height: number }): string => `${r1(box.width)}x${r1(box.height)}`;
const pt = (point: Point): string => `${r1(point.x)},${r1(point.y)}`;
const lowerRight = (box: Box): Point => ({ x: box.x + box.width, y: box.y + box.height });

/** the share of `box` that lies inside `frame` */
function shareInside(box: Box, frame: Box): number {
  const width = Math.min(box.x + box.width, frame.x + frame.width) - Math.max(box.x, frame.x);
  const height = Math.min(box.y + box.height, frame.y + frame.height) - Math.max(box.y, frame.y);
  const area = box.width * box.height;
  return area > 0 ? r2((Math.max(0, width) * Math.max(0, height)) / area) : 0;
}
/** the gap between two boxes: 0 where they touch or overlap */
function apart(a: Box, b: Box): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}
const contains = (box: Box, point: Point): boolean =>
  point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;

// ── the page: what every case reads ──────────────────────────────────────────

type NativeWindow = Window & { __boardSpikeNative?: NativeGeometry };

interface Session {
  board: Board;
  node: NodeHandle;
  id: string;
  /** read once after arming; `envNow` reads it again */
  env: Env;
  /** `<case>-<strategy>-<zoom>` for a screenshot's name */
  tag: string;
}

async function envOf(board: Board, node: NodeHandle): Promise<Env> {
  const viewport = await board.viewport();
  const [net, map, unit, matrix, host] = [
    await node.netScale(),
    await node.map(),
    await node.diagramScale(),
    await node.viewportMatrix(),
    await node.hostBox(),
  ];
  const body = await board.page.evaluate((id) => {
    const element = document.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${CSS.escape(id)}"] .board-node__body`,
    );
    // layout px: inside the board's scaled viewport that is flow units
    return element ? { width: element.offsetWidth, height: element.offsetHeight } : { width: 0, height: 0 };
  }, node.id);
  return {
    zoom: viewport.zoom,
    net: r3(net),
    frame: node.frame !== undefined,
    chrome: r3(net * map.sx),
    unit: unit ?? 0,
    canvas: matrix?.a ?? 0,
    host,
    body,
  };
}

/** what of an Env goes into a row */
const envRow = (env: Env | undefined): Partial<Env> =>
  env
    ? {
        zoom: env.zoom,
        net: env.net,
        frame: env.frame,
        chrome: env.chrome,
        unit: r3(env.unit),
        canvas: r3(env.canvas),
        host: rbox(env.host),
        body: env.body,
      }
    : {};

interface OpenOptions {
  /** the board zoom the page opens with (default: the case's zoom) */
  zoom?: number;
  /** a second, unarmed node beside it (the matrix board with the DMN sample) */
  second?: boolean;
  arm?: boolean;
}

/** a fresh page with the node armed; `close` returns what the page logged */
async function openSession(ctx: Ctx, sizeOf: Size, tag: string, options: OpenOptions = {}): Promise<Session> {
  const spec = SIZES[sizeOf];
  const board = await ctx.harness.open(spec.query(ctx.strategy, options.zoom ?? ctx.zoom, options.second === true));
  try {
    if (options.arm !== false) await board.arm(spec.node);
    const node = await board.node(spec.node);
    return { board, node, id: spec.node, env: await envOf(board, node), tag: `${tag}-${ctx.strategy}-${ctx.zoom}` };
  } catch (error) {
    await board.close().catch(() => undefined);
    throw error;
  }
}

async function closeSession(session: Session): Promise<string[]> {
  const problems = await session.board
    .problems({ allow: [KNOWN_CONSOLE.padDeprecation] })
    .catch((error: unknown) => [String(error)]);
  await session.board.close().catch((error: unknown) => problems.push(String(error)));
  return problems;
}

/** what a page measurement carries besides its numbers */
interface PageResult {
  env?: Env;
  /** the page threw something that is no measurement: harness trouble */
  error?: string;
  problems: string[];
}

/** opens a page, runs `body` on it and closes it, whatever happens; an exception lands in `error` */
async function onPage<T extends PageResult>(
  ctx: Ctx,
  sizeOf: Size,
  tag: string,
  options: OpenOptions,
  part: T,
  body: (session: Session, part: T) => Promise<void>,
): Promise<T> {
  let session: Session | undefined;
  try {
    session = await openSession(ctx, sizeOf, tag, options);
    part.env = session.env;
    await body(session, part);
  } catch (error) {
    part.error = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "error";
  }
  if (session) part.problems.push(...(await closeSession(session)));
  return part;
}

async function shot(session: Session, detail: string, around: readonly Box[] = []): Promise<void> {
  if (!shots) return;
  await session.node
    .screenshot(outPath(`shots/${session.tag}-${detail}.png`), { around, pad: 16 })
    .catch(() => undefined);
}

interface Item {
  /** data-action, data-id or data-element-id, whichever the element has */
  id: string;
  box: Box;
  cls: string;
  text: string;
}

/** runs in the node's document: what matches inside the host and inside the popup host the editor owns */
const LIST = (host: HTMLElement, arg: { selector: string; node: string | null }): Item[] => {
  const native = (window as NativeWindow).__boardSpikeNative;
  const roots: Element[] = [host];
  if (arg.node !== null) {
    for (const one of document.querySelectorAll<HTMLElement>(".board-popup-host")) {
      if (one.dataset.node === arg.node) roots.push(one);
    }
  }
  return roots
    .flatMap((root) => [...root.querySelectorAll<HTMLElement>(arg.selector)])
    .map((element) => {
      const rect = native ? native.rect(element) : element.getBoundingClientRect();
      return {
        id:
          element.getAttribute("data-action") ??
          element.getAttribute("data-id") ??
          element.getAttribute("data-element-id") ??
          "",
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        cls: element.getAttribute("class") ?? "",
        text: (element.textContent ?? "").trim().slice(0, 80),
      };
    });
};

/** elements of the editor's chrome with their boxes on screen */
async function items(node: NodeHandle, selector: string): Promise<Item[]> {
  const map = await node.map();
  const found = await node.inDocument(LIST, { selector, node: node.frame ? null : node.id });
  return found.map((item) => ({ ...item, box: toScreen(map, item.box) }));
}

type ChromeKind = "popup" | "palette" | "pad" | "editor" | "search" | "canvas" | "outside";
interface Probe {
  /** the topmost element at the point belongs to this node's editor, in every document on the way */
  reachable: boolean;
  kind: ChromeKind;
  /** data-action or data-id of the chrome entry there */
  entry: string | null;
  /** data-element-id of the diagram element there */
  element: string | null;
  what: string;
}

/** runs in the node's document: what lies at each point of that document */
const PROBE = (host: HTMLElement, arg: { points: Point[]; node: string | null }): Probe[] => {
  const native = (window as NativeWindow).__boardSpikeNative;
  const popupHosts =
    arg.node === null
      ? []
      : [...document.querySelectorAll<HTMLElement>(".board-popup-host")].filter((one) => one.dataset.node === arg.node);
  return arg.points.map((point) => {
    const element = native
      ? native.elementFromPoint(document, point.x, point.y)
      : document.elementFromPoint(point.x, point.y);
    const inside = !!element && (host.contains(element) || popupHosts.some((one) => one.contains(element)));
    const entry = element?.closest(".entry") ?? null;
    const kind: ChromeKind =
      !element || !inside
        ? "outside"
        : element.closest(".djs-popup")
          ? "popup"
          : element.closest(".djs-palette")
            ? "palette"
            : element.closest(".djs-context-pad")
              ? "pad"
              : element.closest(".djs-direct-editing-parent")
                ? "editor"
                : element.closest(".djs-search-container")
                  ? "search"
                  : "canvas";
    return {
      reachable: inside,
      kind,
      entry: entry ? (entry.getAttribute("data-action") ?? entry.getAttribute("data-id")) : null,
      element: element?.closest("[data-element-id]")?.getAttribute("data-element-id") ?? null,
      what: element
        ? `${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "").slice(0, 60)}`
        : "nothing",
    };
  });
};

/** a hit-test of many screen points at once: what a press there would land on */
async function probes(node: NodeHandle, points: readonly Point[]): Promise<Probe[]> {
  if (points.length === 0) return [];
  const map = await node.map();
  const local = points.map((point) => ({ x: (point.x - map.x) / map.sx, y: (point.y - map.y) / map.sy }));
  let onFrame: boolean[] | undefined;
  if (node.frame) {
    onFrame = await node.board.page.evaluate(
      ([all, name]) => {
        const native = (window as NativeWindow).__boardSpikeNative;
        return all.map((point) => {
          const top = native
            ? native.elementFromPoint(document, point.x, point.y)
            : document.elementFromPoint(point.x, point.y);
          return top?.getAttribute("name") === name;
        });
      },
      [points, node.frame.name()] as const,
    );
  }
  const inside = await node.inDocument(PROBE, { points: local, node: node.frame ? null : node.id });
  return inside.map((one, index) => ({ ...one, reachable: one.reachable && (onFrame?.[index] ?? true) }));
}
const probe = async (node: NodeHandle, point: Point): Promise<Probe> => (await probes(node, [point]))[0]!;

/**
 * Of the entries whose middle takes no press: those that take one at 15 % or 85 % of their width.
 * A menu cut at the board's edge is such a case: its entries are half visible and can be clicked
 * there. Recorded beside the count the rules use (the middle), which stays what it was.
 */
async function hitBesideTheMiddle(node: NodeHandle, entries: readonly Item[], kind: ChromeKind): Promise<string[]> {
  if (entries.length === 0) return [];
  const points = entries.flatMap((entry) =>
    [0.15, 0.85].map((fx) => ({ x: entry.box.x + entry.box.width * fx, y: centre(entry.box).y })),
  );
  const hits = await probes(node, points);
  return entries
    .filter((entry, index) =>
      [hits[2 * index]!, hits[2 * index + 1]!].some(
        (hit) => hit.reachable && hit.kind === kind && hit.entry === entry.id,
      ),
    )
    .map((entry) => entry.id);
}

/**
 * Runs in the node's document: the share of the first match that no ancestor clips, from the
 * browser's own IntersectionObserver (overflow, transforms and the frame's edge all count; what
 * lies OVER the element does not, that is what the hit-tests are for). Null without a match.
 */
const UNCLIPPED = (host: HTMLElement, arg: { selector: string; node: string | null }): Promise<number | null> => {
  const roots: Element[] = [host];
  if (arg.node !== null) {
    for (const one of document.querySelectorAll<HTMLElement>(".board-popup-host")) {
      if (one.dataset.node === arg.node) roots.push(one);
    }
  }
  const element = roots.map((root) => root.querySelector(arg.selector)).find((one) => one !== null);
  if (!element) return Promise.resolve(null);
  return new Promise((resolve) => {
    const observer = new IntersectionObserver((entries) => {
      observer.disconnect();
      resolve(entries[0] ? Math.round(entries[0].intersectionRatio * 100) / 100 : null);
    });
    observer.observe(element);
    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, 1500);
  });
};
const unclipped = async (node: NodeHandle, selector: string): Promise<number | null> =>
  await node.inDocument(UNCLIPPED, { selector, node: node.frame ? null : node.id });

/**
 * Runs in the node's document: resolves once the CSS animations of the first match and of what is
 * in it are through (the count of them; -1 after 1.5 s). The product's theme lets a popup menu pop
 * in from 4 px above over 150 ms, and a page that gets few frames shows the same half-way box in
 * two reads.
 */
const ANIMATIONS_DONE = (host: HTMLElement, arg: { selector: string; node: string | null }): Promise<number> => {
  const roots: Element[] = [host];
  if (arg.node !== null) {
    for (const one of document.querySelectorAll<HTMLElement>(".board-popup-host")) {
      if (one.dataset.node === arg.node) roots.push(one);
    }
  }
  const element = roots.map((root) => root.querySelector(arg.selector)).find((one) => one !== null);
  if (!element) return Promise.resolve(0);
  const running = element.getAnimations({ subtree: true });
  return Promise.race([
    Promise.all(running.map((animation) => animation.finished.catch(() => undefined))).then(() => running.length),
    new Promise<number>((resolve) => setTimeout(() => resolve(-1), 1500)),
  ]);
};

/** the popup menu's box once it is there, its pop-in is through and it rests */
async function popupBox(session: Session, timeout = 3000): Promise<Box | null> {
  const { board, node } = session;
  const first = await board.waitForBox(async () => (await node.query(".djs-popup"))[0], timeout);
  if (!first) return null;
  await node.inDocument(ANIMATIONS_DONE, { selector: ".djs-popup", node: node.frame ? null : node.id });
  return board.waitForBox(async () => (await node.query(".djs-popup"))[0], timeout);
}

/** runs in a document: its active element in a few words */
const ACTIVE = (): string => {
  const active = document.activeElement;
  if (!active) return "none";
  const tag = active.tagName.toLowerCase();
  if (tag === "svg" && active.parentElement?.classList.contains("djs-container")) return "canvas svg";
  if (tag === "input" && active.closest(".djs-popup")) return "popup search input";
  if (tag === "input" && active.closest(".djs-search-container")) return "search pad input";
  if (active.classList.contains("djs-direct-editing-content")) return "label editor";
  if (active.classList.contains("react-flow__node")) return "board node wrapper";
  const names = (active.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
  return `${tag}${names ? `.${names}` : ""}`;
};

/** the active element of the board page and, for a frame, of the frame's document */
async function focusOf(session: Session): Promise<string> {
  const top = await session.board.page.evaluate(ACTIVE);
  return session.node.frame ? `${top} > ${await session.node.frame.evaluate(ACTIVE)}` : top;
}

/**
 * Waits until the canvas has the focus again in the node's document. diagram-js hands it back one
 * task after a popup menu or a label editor closed (Canvas.restoreFocus is debounced); a key
 * pressed before that goes to the document's body, in an in-page strategy the board page's.
 */
async function canvasFocused(session: Session, timeout = 3000): Promise<boolean> {
  const done = await session.board.waitFor(
    async () => (await session.node.scope.evaluate(ACTIVE)) === "canvas svg",
    timeout,
    20,
  );
  return done === true;
}

interface FocusGap {
  /** ms between the key that closed the popup or editor and the canvas having the focus again (follows the machine's load) */
  ms: number;
  /** what had the focus in between, read in the task right after the key event */
  meanwhile: string;
}

/** runs in the node's document before the closing key: times how long the focus is away from the canvas */
const GAP_ARM = (host: HTMLElement): void => {
  const gap: { key?: number; back?: number; meanwhile?: string } = {};
  (window as unknown as { __focusGap?: typeof gap }).__focusGap = gap;
  const canvas = host.querySelector(".djs-container > svg");
  window.addEventListener(
    "keydown",
    () => {
      gap.key = performance.now();
      // after this event's handlers, before diagram-js's own task that restores the focus
      setTimeout(() => {
        const active = document.activeElement;
        gap.meanwhile = !active
          ? "none"
          : active === canvas
            ? "canvas svg"
            : `${active.tagName.toLowerCase()}${active === document.body ? "" : `.${(active.getAttribute("class") ?? "").split(/\s+/)[0]}`}`;
      }, 0);
    },
    { capture: true, once: true },
  );
  canvas?.addEventListener("focusin", () => void (gap.back = performance.now()), { once: true });
};
const GAP_READ = (): FocusGap | null => {
  const gap = (window as unknown as { __focusGap?: { key?: number; back?: number; meanwhile?: string } }).__focusGap;
  if (gap?.key === undefined || gap.back === undefined) return null;
  return { ms: Math.round((gap.back - gap.key) * 10) / 10, meanwhile: gap.meanwhile ?? "?" };
};

/** the palette tools the editor shows as active */
const activeTools = (node: NodeHandle): Promise<string[]> =>
  node.inDocument((host) =>
    [...host.querySelectorAll(".djs-palette .entry.highlighted-entry")].map(
      (entry) => entry.getAttribute("data-action") ?? "",
    ),
  );

/** screen = a x diagram + (e, f): the browser's own matrix of g.viewport, through the frame's scale */
async function screenMatrix(node: NodeHandle): Promise<{ a: number; e: number; f: number }> {
  const map = await node.map();
  const local = await node.inDocument((host) => {
    const group = host.querySelector<SVGGElement>("svg g.viewport");
    if (!group) return null;
    const native = (window as NativeWindow).__boardSpikeNative;
    const matrix = native ? native.screenCTM(group) : group.getScreenCTM();
    return matrix ? { a: matrix.a, e: matrix.e, f: matrix.f } : null;
  });
  if (!local) throw new Error("no canvas in this view");
  return { a: local.a * map.sx, e: map.x + local.e * map.sx, f: map.y + local.f * map.sy };
}

/** where the window the armed editor sees lies in its document: true = origin + scale x seen */
interface EditorWindow {
  x: number;
  y: number;
  scale: number;
}

/**
 * Runs in the node's document. The plain getBoundingClientRect on purpose, beside the native one:
 * a strategy that gives the armed editor a coordinate space of its own (shim) answers the plain
 * call in that space. Both rectangles of the host give the space's origin and scale in true px;
 * where nothing is patched they are equal and the answer is (0, 0, 1).
 */
const EDITOR_WINDOW = (host: HTMLElement): EditorWindow => {
  const native = (window as NativeWindow).__boardSpikeNative;
  const seen = host.getBoundingClientRect();
  const real = native ? native.rect(host) : seen;
  const scale = seen.width > 0 ? real.width / seen.width : 1;
  return { x: real.x - seen.x * scale, y: real.y - seen.y * scale, scale };
};

/**
 * The screen y of the top of the document bpmn-js measures a popup against (PopupMenu
 * _ensureVisible pins a popup that fits nowhere 10 px below it): the window's top, the frame's
 * top where the editor has a document of its own, and the top of the editor's own coordinate
 * space where a strategy gives it one. Measured, not taken from the strategy's name.
 */
async function windowTop(node: NodeHandle): Promise<{ top: number; space: EditorWindow }> {
  const map = await node.map();
  const space = await node.inDocument(EDITOR_WINDOW);
  return { top: map.y + space.y * map.sy, space };
}
/** an editor window that is not simply its document's: worth a line in the row */
const ownWindow = (space: EditorWindow): boolean =>
  Math.abs(space.x) > 0.01 || Math.abs(space.y) > 0.01 || Math.abs(space.scale - 1) > 1e-4;

/** the matrix once it is the same in two reads: a wheel step and a board zoom are applied a frame later */
async function restingMatrix(session: Session): Promise<{ a: number; e: number; f: number }> {
  let last = await screenMatrix(session.node);
  for (let tries = 0; tries < 20; tries++) {
    await session.board.page.waitForTimeout(60);
    const now = await screenMatrix(session.node);
    if (Math.abs(now.a - last.a) < 1e-6 && Math.abs(now.e - last.e) < 0.01 && Math.abs(now.f - last.f) < 0.01) {
      return now;
    }
    last = now;
  }
  return last;
}

/** where a press on the element would go: the middle of its graphics, or why it cannot be pressed */
async function pointOn(session: Session, element: string): Promise<{ at: Point } | { blocked: string }> {
  const box = await session.node.elementBox(element);
  if (!box) return { blocked: "not drawn" };
  const at = aimAt(await session.node.map(), centre(box));
  const hit = await probe(session.node, at);
  if (!hit.reachable) return { blocked: `outside the editor (${hit.what})` };
  if (hit.element !== element) {
    return { blocked: hit.kind === "canvas" ? `under ${hit.element ?? hit.what}` : `under the ${hit.kind}` };
  }
  return { at };
}

/** selects exactly this element with a click, as a person does; returns why not, or "" */
async function selectOnly(session: Session, element: string): Promise<string> {
  const point = await pointOn(session, element);
  if ("blocked" in point) return point.blocked;
  const selected = await session.node.selected();
  if (!(selected.length === 1 && selected[0] === element)) await session.board.click(point.at);
  const done = await session.board.waitFor(async () => {
    const now = await session.node.selected();
    return now.length === 1 && now[0] === element;
  }, 2000);
  if (!(await session.node.state()).armed) return "the click disarmed the node";
  return done ? "" : "the click did not select it";
}

/** the first of `candidates` a click selects, and what stood in the way of the others */
async function selectFirst(
  session: Session,
  candidates: readonly string[],
): Promise<{ element?: string; passed: string[] }> {
  const passed: string[] = [];
  for (const element of candidates) {
    const blocked = await selectOnly(session, element);
    if (blocked === "") return { element, passed };
    passed.push(`${element} ${blocked}`);
  }
  return { passed };
}

/**
 * A free point of a lane, where a press hits the canvas and nothing of the chrome. With
 * `anywhere`: any point of the canvas, also beside the diagram (enough for a wheel).
 */
async function lanePoint(session: Session, anywhere = false): Promise<Point | null> {
  const host = await session.node.hostBox();
  const map = await session.node.map();
  const candidates = [
    [0.62, 0.52],
    [0.55, 0.5],
    [0.7, 0.5],
    [0.6, 0.6],
    [0.75, 0.62],
    [0.5, 0.45],
  ].map(([fx, fy]) => aimAt(map, { x: host.x + host.width * fx!, y: host.y + host.height * fy! }));
  const hits = await probes(session.node, candidates);
  const index = hits.findIndex(
    (hit) => hit.reachable && hit.kind === "canvas" && (anywhere || /^(Lane_|Participant_)/.test(hit.element ?? "")),
  );
  return index < 0 ? null : candidates[index]!;
}

// ── the file ─────────────────────────────────────────────────────────────────

/** the file after a step: waits for a change, then until it rests (a command can reach it in two writes) */
async function fileAfter(board: Board, before: string, timeout = 2500): Promise<{ changed: boolean; text: string }> {
  const first = await board.waitForFileChange(FILE, before, timeout);
  if (first === null) return { changed: false, text: before };
  let last = first;
  for (let rested = 0; rested < 2;) {
    await board.page.waitForTimeout(150);
    const now = (await board.fileText(FILE)) ?? last;
    if (now === last) rested++;
    else {
      rested = 0;
      last = now;
    }
  }
  return { changed: true, text: last };
}

const fileNow = async (board: Board): Promise<string> => (await board.fileText(FILE)) ?? "";

/** waits until the file fulfils `test` (an editor writes about 350 ms after a gesture) */
async function fileBecomes(board: Board, test: (text: string) => boolean, timeout = 3000): Promise<boolean> {
  return (await board.waitFor(async () => test(await fileNow(board)), timeout)) === true;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
const BOUNDS = /<dc:Bounds x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/;
/** as the file has them, to two decimals (the engine writes fractions such as 102.94933431952661) */
const toBounds = (match: RegExpMatchArray | null): Bounds | null =>
  match
    ? {
        x: r2(Number(match[1])),
        y: r2(Number(match[2])),
        width: r2(Number(match[3])),
        height: r2(Number(match[4])),
      }
    : null;
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** the name attribute of a flow element, with XML entities as the file has them */
const nameOf = (text: string, id: string): string | null =>
  text.match(new RegExp(`<bpmn:\\w+ id="${escapeRe(id)}"[^>]*? name="([^"]*)"`))?.[1] ?? null;
const hasElement = (text: string, id: string): boolean => new RegExp(`<bpmn:\\w+ id="${escapeRe(id)}"`).test(text);
const typeOf = (text: string, id: string): string | null =>
  text.match(new RegExp(`<bpmn:(\\w+) id="${escapeRe(id)}"`))?.[1] ?? null;
/** the DI shape of an element, by the element it draws: a replaced element gets a DI id of its own */
const shapeTag = (text: string, id: string): string | null =>
  text.match(new RegExp(`<bpmndi:BPMNShape [^>]*bpmnElement="${escapeRe(id)}"[^>]*>`))?.[0] ?? null;
const shapeBounds = (text: string, id: string): Bounds | null => {
  const found = text.match(
    new RegExp(`<bpmndi:BPMNShape [^>]*bpmnElement="${escapeRe(id)}"[^>]*>\\s*<dc:Bounds [^>]*>`),
  )?.[0];
  return found ? toBounds(found.match(BOUNDS)) : null;
};
/** every text annotation of the file: id and text */
const annotations = (text: string): Array<{ id: string; text: string }> =>
  [...text.matchAll(/<bpmn:textAnnotation id="([^"]+)"[^>]*>\s*(?:<bpmn:text>([\s\S]*?)<\/bpmn:text>)?/g)].map(
    (match) => ({ id: match[1]!, text: match[2] ?? "" }),
  );

interface Diff {
  same: boolean;
  /** `none`, `empty-label` (only empty BPMNLabel elements added), `bounds` (geometry values moved), `other` */
  kind: "none" | "empty-label" | "bounds" | "other";
  removed: number;
  added: number;
  /** the largest move of a geometry value, in diagram units */
  maxDelta: number;
  detail: string;
}

/** what changed between two texts of the file, line by line (the serializer writes one element per line) */
function diffOf(before: string, after: string): Diff {
  if (before === after)
    return { same: true, kind: "none", removed: 0, added: 0, maxDelta: 0, detail: "byte-identical" };
  const count = (lines: string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line.trim(), (counts.get(line.trim()) ?? 0) + 1);
    return counts;
  };
  const [was, now] = [count(before.split("\n")), count(after.split("\n"))];
  const removed: string[] = [];
  const added: string[] = [];
  for (const [line, times] of was) for (let more = times - (now.get(line) ?? 0); more > 0; more--) removed.push(line);
  for (const [line, times] of now) for (let more = times - (was.get(line) ?? 0); more > 0; more--) added.push(line);
  const numbersOf = (line: string): number[] =>
    [...line.matchAll(/="(-?\d+(?:\.\d+)?)"/g)].map((match) => Number(match[1]));
  const geometry = (line: string): boolean => /^<(dc:Bounds|di:waypoint) /.test(line);
  if (removed.length === 0 && added.every((line) => line === "<bpmndi:BPMNLabel />")) {
    return {
      same: false,
      kind: "empty-label",
      removed: 0,
      added: added.length,
      maxDelta: 0,
      detail: `${added.length} empty BPMNLabel element added, no value changed`,
    };
  }
  const plain = (lines: string[]): string[] => lines.filter((line) => line !== "<bpmndi:BPMNLabel />");
  if (plain(removed).length === plain(added).length && [...plain(removed), ...plain(added)].every(geometry)) {
    let maxDelta = 0;
    const moves: string[] = [];
    plain(removed).forEach((line, index) => {
      const [from, to] = [numbersOf(line), numbersOf(plain(added)[index]!)];
      const delta = Math.max(0, ...from.map((value, at) => Math.abs((to[at] ?? value) - value)));
      maxDelta = Math.max(maxDelta, delta);
      moves.push(`${from.map((value) => r1(value)).join(",")} -> ${to.map((value) => r1(value)).join(",")}`);
    });
    return {
      same: false,
      kind: "bounds",
      removed: removed.length,
      added: added.length,
      maxDelta: r2(maxDelta),
      detail: `geometry ${moves.slice(0, 2).join("; ")}${moves.length > 2 ? ` and ${moves.length - 2} more` : ""}`,
    };
  }
  return {
    same: false,
    kind: "other",
    removed: removed.length,
    added: added.length,
    maxDelta: 0,
    detail: `${removed.length} lines gone, ${added.length} new`,
  };
}

// ── events ───────────────────────────────────────────────────────────────────

interface Seen {
  /** trusted events the board page's document saw */
  top: number;
  /** trusted events the node's frame saw (0 where the node is no frame) */
  frame: number;
}

async function listen(session: Session, types: readonly string[]): Promise<void> {
  await recordEvents(session.board.page, types);
  if (session.node.frame) await recordEvents(session.node.frame, types);
}

/** how many trusted events of `type` each document saw since the last call; the lists are emptied */
async function seen(session: Session, type: string): Promise<Seen> {
  const trusted = (events: Array<{ trusted: boolean }>): number => events.filter((event) => event.trusted).length;
  const top = trusted(await seenEvents(session.board.page, type));
  const frame = session.node.frame ? trusted(await seenEvents(session.node.frame, type)) : 0;
  await clearEvents(session.board.page);
  if (session.node.frame) await clearEvents(session.node.frame);
  return { top, frame };
}
const seenText = (events: Seen): string => `top ${events.top} / frame ${events.frame}`;

interface BoardState {
  nodes: number;
  text: string;
  viewport: Viewport;
  armed: boolean;
}
async function boardState(session: Session): Promise<BoardState> {
  return {
    nodes: (await session.board.nodes()).length,
    text: await session.board.boardText(),
    viewport: await session.board.viewport(),
    armed: (await session.node.state()).armed,
  };
}
/** what the BOARD did between two states: "" when nothing */
function boardActed(before: BoardState, after: BoardState): string {
  const acts: string[] = [];
  if (after.nodes !== before.nodes) acts.push(`board nodes ${before.nodes} -> ${after.nodes}`);
  if (after.text !== before.text) acts.push("the board file changed");
  if (
    after.viewport.zoom !== before.viewport.zoom ||
    after.viewport.x !== before.viewport.x ||
    after.viewport.y !== before.viewport.y
  ) {
    acts.push(
      `viewport ${r2(before.viewport.x)},${r2(before.viewport.y)}@${r3(before.viewport.zoom)} -> ` +
        `${r2(after.viewport.x)},${r2(after.viewport.y)}@${r3(after.viewport.zoom)}`,
    );
  }
  if (before.armed && !after.armed) acts.push("the node was disarmed");
  return acts.join(", ");
}

// ── plan: pad and popups of four elements ────────────────────────────────────

interface PadMeasure {
  opened: boolean;
  shape?: Box;
  pad?: Box;
  /** pad's left edge minus the shape's right edge, pad's top minus the shape's top: screen px and diagram units */
  gapPx?: Point;
  gapUnits?: Point;
  /** one entry on screen */
  entry?: { width: number; height: number };
  entries: number;
  reachable: number;
  unreachable: string[];
  /** only where there are any: entries of `unreachable` that take a press beside their middle (hitBesideTheMiddle) */
  reachableBeside?: string[];
  /** share of the pad no ancestor clips */
  unclipped: number | null;
  /** share of the pad inside the engine host's box */
  insideHost: number;
  /** other shapes of the sample whose middle lies under the pad */
  covers: string[];
}

interface Chosen {
  entry: string;
  /** the entry could be hit and was clicked */
  clicked: boolean;
  why?: string;
  fileChanged: boolean;
  asExpected: boolean;
  detail: string;
}

interface PopupMeasure {
  /** how it was opened: a click on the pad entry, the R key where the entry cannot be hit, or not at all */
  by: "pad" | "key" | "none";
  openerReachable: boolean;
  openerWhat: string;
  opened: boolean;
  note?: string;
  box?: Box;
  /** popup's top-left minus the pad's bottom-left; bpmn-js asks for (0, 5 px of its chrome) */
  offset?: Point;
  /** offset minus what bpmn-js asks for */
  error?: Point;
  placement?: string;
  /** only where the armed editor sees a window of its own (windowTop): its origin and scale in true px of its document */
  editorWindow?: EditorWindow;
  /** screen px between the pad entry that opened it and the popup's nearest edge: 0 where they touch */
  fromOpener?: number;
  /** share of the popup inside the engine host's box, inside the window, clipped by no ancestor, hit by a 5 x 5 grid */
  insideHost?: number;
  insideWindow?: number;
  unclipped?: number | null;
  hit?: number;
  entries?: number;
  reachable?: number;
  unreachable?: string[];
  /** only where there are any: entries of `unreachable` that take a press beside their middle (hitBesideTheMiddle) */
  reachableBeside?: string[];
  entryHeight?: number;
  focus?: string;
  closedByEscape?: boolean;
  chosen?: Chosen;
}

interface TourPart extends PageResult {
  position: Position;
  element: string;
  /** why nothing was measured at this position */
  skipped?: string;
  pad?: PadMeasure;
  replace?: PopupMeasure;
  colour?: PopupMeasure;
}

async function readPad(session: Session): Promise<{ box: Box; entries: Item[] } | null> {
  const box = await session.board.waitForBox(async () => (await session.node.query(".djs-context-pad.open"))[0], 3000);
  return box ? { box, entries: await items(session.node, ".djs-context-pad.open .entry") } : null;
}

async function measurePad(session: Session, element: string): Promise<PadMeasure> {
  const { node } = session;
  const pad = await readPad(session);
  const shape = await node.elementBox(element);
  if (!pad || !shape)
    return { opened: false, entries: 0, reachable: 0, unreachable: [], unclipped: null, insideHost: 0, covers: [] };
  const hits = await probes(
    node,
    pad.entries.map((entry) => centre(entry.box)),
  );
  const unreachable = pad.entries
    .map((entry, index) => ({ entry, hit: hits[index]! }))
    .filter(({ entry, hit }) => !(hit.reachable && hit.kind === "pad" && hit.entry === entry.id))
    .map(
      ({ entry, hit }) => `${entry.id}: ${hit.kind === "outside" ? `outside (${hit.what})` : `under the ${hit.kind}`}`,
    );
  const beside = await hitBesideTheMiddle(
    node,
    pad.entries.filter((entry, index) => {
      const hit = hits[index]!;
      return !(hit.reachable && hit.kind === "pad" && hit.entry === entry.id);
    }),
    "pad",
  );
  const env = await envOf(session.board, node);
  const gapPx = { x: pad.box.x - (shape.x + shape.width), y: pad.box.y - shape.y };
  const others: string[] = [];
  for (const other of SHAPES) {
    if (other === element) continue;
    const box = await node.elementBox(other);
    if (box && contains(pad.box, centre(box))) others.push(other);
  }
  return {
    opened: true,
    shape: rbox(shape),
    pad: rbox(pad.box),
    gapPx: { x: r1(gapPx.x), y: r1(gapPx.y) },
    gapUnits: { x: r2(gapPx.x / env.unit), y: r2(gapPx.y / env.unit) },
    entry: pad.entries[0] ? { width: r1(pad.entries[0].box.width), height: r1(pad.entries[0].box.height) } : undefined,
    entries: pad.entries.length,
    reachable: pad.entries.length - unreachable.length,
    unreachable,
    ...(beside.length > 0 ? { reachableBeside: beside } : {}),
    unclipped: await unclipped(node, ".djs-context-pad.open"),
    insideHost: shareInside(pad.box, env.host),
    covers: others,
  };
}

/**
 * How the popup lies against its anchor: where bpmn-js asked for, or flipped by its own
 * _ensureVisible. Along y the engine's 5 px (10 px from the top when pinned) may be px of the
 * chrome or of the screen: a strategy that corrects the engine's math counts them in screen px.
 */
function placementOf(error: Point, box: Box, top: number, chrome: number): string {
  const near = (value: number, target: number, slack = 0): boolean => Math.abs(value - target) <= PX + slack;
  const gap = 5 * Math.abs(1 - chrome);
  if (near(error.x, 0) && near(error.y, 0, gap)) return "anchored";
  if (near(error.x, -box.width) && near(error.y, -box.height, gap)) return "flipped left and up";
  if (near(error.x, -box.width) && near(error.y, 0, gap)) return "flipped left";
  if (near(error.x, 0) && near(error.y, -box.height, gap)) return "flipped up";
  if (near(error.x, 0) && near(box.y, top + 10 * chrome, 2 * gap)) return "pinned to the top";
  return `displaced by ${pt(error)} px`;
}

/** opens the popup of a pad entry (or by key where the entry cannot be hit) and waits until it rests */
async function openPopup(
  session: Session,
  opener: string,
  key: string | undefined,
): Promise<Pick<PopupMeasure, "by" | "openerReachable" | "openerWhat" | "note"> & { box: Box | null; opener?: Box }> {
  const { board, node } = session;
  const pad = await readPad(session);
  const entry = pad?.entries.find((one) => one.id === opener);
  if (!entry) return { by: "none", openerReachable: false, openerWhat: "the pad has no such entry", box: null };
  const at = aimAt(await node.map(), centre(entry.box));
  const hit = await probe(node, at);
  const openerReachable = hit.reachable && hit.kind === "pad" && hit.entry === opener;
  const openerWhat = openerReachable
    ? "pad entry"
    : hit.kind === "outside"
      ? `outside (${hit.what})`
      : `under the ${hit.kind}`;
  if (openerReachable) await board.click(at);
  else if (key) await board.press(key);
  else return { by: "none", openerReachable, openerWhat, box: null };
  const box = await popupBox(session);
  const note = (await node.state()).armed ? undefined : "the node was disarmed";
  return {
    by: openerReachable ? "pad" : "key",
    openerReachable,
    openerWhat,
    box,
    opener: entry.box,
    ...(note ? { note } : {}),
  };
}

async function closePopup(session: Session): Promise<boolean> {
  await session.board.press("Escape");
  const gone = await session.board.waitFor(async () => (await session.node.query(".djs-popup")).length === 0, 2000);
  if (gone) await canvasFocused(session);
  return gone === true;
}

async function measurePopup(
  session: Session,
  opener: string,
  key: string | undefined,
  name: string,
): Promise<PopupMeasure> {
  const { board, node } = session;
  const opened = await openPopup(session, opener, key);
  const result: PopupMeasure = {
    by: opened.by,
    openerReachable: opened.openerReachable,
    openerWhat: opened.openerWhat,
    opened: opened.box !== null,
    ...(opened.note ? { note: opened.note } : {}),
  };
  const box = opened.box;
  if (!box || opened.note) return result;
  const env = await envOf(board, node);
  const pad = (await node.query(".djs-context-pad.open"))[0];
  const entries = await items(node, ".djs-popup .entry");
  const hits = await probes(
    node,
    entries.map((entry) => centre(entry.box)),
  );
  const unreachable = entries
    .map((entry, index) => ({ entry, hit: hits[index]! }))
    .filter(({ entry, hit }) => !(hit.reachable && hit.kind === "popup" && hit.entry === entry.id))
    .map(({ entry }) => entry.id);
  const beside = await hitBesideTheMiddle(
    node,
    entries.filter((entry) => unreachable.includes(entry.id)),
    "popup",
  );
  if (beside.length > 0) result.reachableBeside = beside;
  const fractions = [0.1, 0.3, 0.5, 0.7, 0.9];
  const grid = fractions.flatMap((fy) =>
    fractions.map((fx) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy })),
  );
  const gridHits = await probes(node, grid);
  result.box = rbox(box);
  if (pad) {
    const offset = { x: box.x - pad.x, y: box.y - (pad.y + pad.height) };
    const error = { x: offset.x, y: offset.y - 5 * env.chrome };
    result.offset = { x: r1(offset.x), y: r1(offset.y) };
    result.error = { x: r1(error.x), y: r1(error.y) };
    // the top of the document bpmn-js measures against: the window's, the frame's own, or the editor's own space
    const seenFrom = await windowTop(node);
    result.placement = placementOf(error, box, seenFrom.top, env.chrome);
    if (ownWindow(seenFrom.space)) {
      result.editorWindow = { x: r1(seenFrom.space.x), y: r1(seenFrom.space.y), scale: r3(seenFrom.space.scale) };
    }
  }
  if (opened.opener) result.fromOpener = r1(apart(opened.opener, box));
  result.insideHost = shareInside(box, env.host);
  result.insideWindow = shareInside(box, { x: 0, y: 0, ...WINDOW });
  result.unclipped = await unclipped(node, ".djs-popup");
  result.hit = r2(gridHits.filter((hit) => hit.reachable && hit.kind === "popup").length / grid.length);
  result.entries = entries.length;
  result.reachable = entries.length - unreachable.length;
  result.unreachable = unreachable;
  result.entryHeight = r1(Math.min(...entries.map((entry) => entry.box.height)));
  result.focus = await focusOf(session);
  await shot(session, name, [box]);
  result.closedByEscape = await closePopup(session);
  return result;
}

/** opens the popup again and clicks one entry; `check` says whether the file got what the entry stands for */
async function choose(
  session: Session,
  opener: string,
  key: string | undefined,
  entryId: string,
  check: (before: string, after: string) => { ok: boolean; detail: string },
): Promise<Chosen> {
  const { board, node } = session;
  const before = await fileNow(board);
  const none = { entry: entryId, clicked: false, fileChanged: false, asExpected: false };
  const opened = await openPopup(session, opener, key);
  if (!opened.box || opened.note) return { ...none, why: opened.note ?? "the popup did not open", detail: "" };
  const entry = (await items(node, ".djs-popup .entry")).find((one) => one.id === entryId);
  if (!entry) {
    await closePopup(session);
    return { ...none, why: "the popup has no such entry", detail: "" };
  }
  const at = aimAt(await node.map(), centre(entry.box));
  const hit = await probe(node, at);
  if (!(hit.reachable && hit.kind === "popup" && hit.entry === entryId)) {
    await closePopup(session);
    return { ...none, why: `the entry cannot be hit (${hit.kind === "outside" ? hit.what : hit.kind})`, detail: "" };
  }
  await board.click(at);
  const after = await fileAfter(board, before, 3000);
  const checked = check(before, after.text);
  return {
    entry: entryId,
    clicked: true,
    fileChanged: after.changed,
    asExpected: after.changed && checked.ok,
    detail: checked.detail,
  };
}

async function tourPage(ctx: Ctx, sizeOf: Size, position: (typeof POSITIONS)[number]): Promise<TourPart> {
  const part: TourPart = { position: position.name, element: "", problems: [] };
  return onPage(ctx, sizeOf, `tour-${sizeOf}-${position.name}`, {}, part, async (session) => {
    const picked = await selectFirst(session, position.elements);
    if (!picked.element) {
      part.skipped = picked.passed.join("; ");
      return;
    }
    const element = picked.element;
    part.element = element;
    part.pad = await measurePad(session, element);
    if (!part.pad.opened) return;
    part.replace = await measurePopup(session, "replace", "r", "replace");
    if (!(await session.node.state()).armed) return;
    part.colour = await measurePopup(session, "set-color", undefined, "colour");
    if (position.name !== "middle" || !(await session.node.state()).armed) return;
    // choosing: the send task becomes a user task, then gets the colour picker's blue
    const typeBefore = typeOf(await fileNow(session.board), element);
    part.replace.chosen = await choose(session, "replace", "r", "replace-with-user-task", (before, after) => {
      const now = typeOf(after, element);
      const others = SHAPES.filter((id) => id !== element && typeOf(before, id) !== typeOf(after, id));
      return {
        ok: now === "userTask" && others.length === 0,
        detail: `${element}: ${typeBefore ?? "?"} -> ${now ?? "gone"}${others.length > 0 ? `; also changed: ${others.join(", ")}` : ""}`,
      };
    });
    // the replaced shape is selected again and gets a pad of its own
    await readPad(session);
    part.colour.chosen = await choose(session, "set-color", undefined, "blue-color", (before, after) => {
      const coloured = (text: string): string[] =>
        [...SHAPES].filter((id) => /bioc:stroke="|color:border-color="/.test(shapeTag(text, id) ?? ""));
      const now = coloured(after);
      return {
        ok: now.length === 1 && now[0] === element && coloured(before).length === 0,
        detail: `shapes with a stroke colour in the file: ${now.join(", ") || "none"}`,
      };
    });
  });
}

type TourParts = TourPart[];

async function measureTour(ctx: Ctx, sizeOf: Size): Promise<TourParts> {
  const parts: TourParts = [];
  for (const position of POSITIONS) parts.push(await tourPage(ctx, sizeOf, position));
  return parts;
}

const PAD_TEXT: Text = {
  did: "Selected one element at the left, in the middle, at the right edge and at the bottom of the diagram with a click (a fresh page each) and read its context pad once it rested: its place against the shape, the size of an entry, a hit-test in the middle of every entry, the share no ancestor clips.",
  expected:
    "The pad stands right of its shape at the distance the baseline has in diagram units (overlay strategy, board zoom 1, same node size and element), every entry takes a press, nothing cuts it off. diagram-js places the pad from client rectangles, which fit only where the container's net scale is 1.",
  rule: `per element: broken when no pad opens or no entry can be hit; degraded when the pad is more than ${PX} px from where the baseline puts it, an entry cannot be hit, less than 98 % of it is unclipped or an entry is under ${SMALL} px; else ok. The row is the worst of the measured elements; an element that cannot be selected (under the palette) is named, not counted.`,
};

function judgePad(part: TourPart, base: TourPart | undefined): Sub {
  const name = part.position;
  if (part.error) return { name, verdict: "unmeasured", why: `the page failed: ${part.error}` };
  if (part.skipped) return { name, verdict: "unmeasured", why: `not selectable: ${part.skipped}` };
  const pad = part.pad;
  const env = part.env;
  if (!pad?.opened || !pad.gapUnits || !pad.entry || !env) {
    return { name, verdict: "broken", why: "no context pad opened after the selection" };
  }
  const reference = base?.pad?.gapUnits && base.element === part.element ? base.pad.gapUnits : undefined;
  const off = reference
    ? { x: r1((pad.gapUnits.x - reference.x) * env.unit), y: r1((pad.gapUnits.y - reference.y) * env.unit) }
    : undefined;
  const short = `${off ? `off ${pt(off)} px` : "no baseline"}, entry ${pad.entry.width} px, ${pad.reachable}/${pad.entries} hit`;
  if (pad.reachable === 0) {
    return {
      name,
      verdict: "broken",
      why: `none of its ${pad.entries} entries can be hit (${pad.unreachable[0] ?? ""})`,
      short,
    };
  }
  const costs: string[] = [];
  if (off && (Math.abs(off.x) > PX || Math.abs(off.y) > PX)) {
    costs.push(
      `${pt(off)} px from the baseline place${pad.covers.length > 0 ? `, over ${pad.covers.join(", ")}` : ""}`,
    );
  }
  if (pad.reachable < pad.entries) costs.push(`${pad.entries - pad.reachable} of ${pad.entries} entries cannot be hit`);
  if (pad.unclipped !== null && pad.unclipped < 0.98)
    costs.push(`${Math.round((1 - pad.unclipped) * 100)} % of it is clipped`);
  if (pad.entry.width < SMALL) costs.push(`entries are ${pad.entry.width} px`);
  return costs.length > 0
    ? { name, verdict: "degraded", why: costs.join(", "), short }
    : { name, verdict: "ok", why: "", short };
}

const popupText = (what: string, how: string, choice: string): Text => ({
  did: `For the same four elements (the page of the pad row): opened the ${what} with a click on the pad's ${how} (by the R key where that entry cannot be hit and a key exists), read the popup once it rested, hit-tested every entry and a 5 x 5 grid over it, closed it with Escape. On the element in the middle then opened it again and clicked ${choice}.`,
  expected:
    "The popup opens at the pad's bottom-left corner plus 5 px of its chrome, where bpmn-js asks for it, or flipped by bpmn-js's own rule at the window's edge; all of it is visible and takes a press; the chosen entry changes that element in the file and nothing else. diagram-js draws it with position fixed and client coordinates, which fit only where no ancestor is transformed.",
  rule: `per element: broken when it does not open, no entry can be hit, or the chosen entry leaves the file as it was; wrong-data when the file changed in another way than the entry stands for; degraded when the pad entry that opens it cannot be hit, it lies neither at its anchor nor flipped by the engine's rule, part of it is clipped or covered, fewer entries can be hit than in the baseline, or the entry to choose cannot be hit; else ok. The row is the worst of the measured elements.`,
});
const REPLACE_TEXT = popupText("replace menu", "wrench", "User task");
const COLOUR_TEXT = popupText("colour menu", "brush", "Blue");

function judgePopup(part: TourPart, base: TourPart | undefined, which: "replace" | "colour"): Sub {
  const name = part.position;
  if (part.error) return { name, verdict: "unmeasured", why: `the page failed: ${part.error}` };
  if (part.skipped) return { name, verdict: "unmeasured", why: `not selectable: ${part.skipped}` };
  const popup = part[which];
  if (!popup) return { name, verdict: "unmeasured", why: "no context pad to open it from" };
  if (!popup.opened || !popup.box) {
    const reason =
      popup.note ?? (popup.openerReachable ? "it did not open" : `its pad entry cannot be hit (${popup.openerWhat})`);
    return { name, verdict: "broken", why: reason };
  }
  const reference = base?.[which];
  const short = `${popup.placement ?? "?"}, ${r1(popup.fromOpener ?? 0)} px from its opener, ${size(popup.box)}, in node ${popup.insideHost}, ${popup.reachable}/${popup.entries} hit`;
  if (popup.reachable === 0)
    return { name, verdict: "broken", why: `none of its ${popup.entries} entries can be hit`, short };
  const chosen = popup.chosen;
  if (chosen?.clicked && !chosen.fileChanged) {
    return { name, verdict: "broken", why: `clicking ${chosen.entry} left the file as it was`, short };
  }
  if (chosen?.clicked && !chosen.asExpected) return { name, verdict: "wrong-data", why: chosen.detail, short };
  const costs: string[] = [];
  if (!popup.openerReachable) costs.push(`its pad entry cannot be hit (${popup.openerWhat}); opened by key`);
  if (popup.placement?.startsWith("displaced")) costs.push(popup.placement);
  if ((popup.unclipped ?? 1) < 0.98) costs.push(`${Math.round((1 - (popup.unclipped ?? 1)) * 100)} % of it is clipped`);
  else if ((popup.hit ?? 1) < 1) costs.push(`${Math.round((1 - (popup.hit ?? 1)) * 100)} % of it is covered`);
  if (reference?.reachable !== undefined && (popup.reachable ?? 0) < reference.reachable) {
    costs.push(`${popup.reachable} entries can be hit, ${reference.reachable} in the baseline`);
  }
  if (chosen && !chosen.clicked) costs.push(`choosing: ${chosen.why ?? "not clicked"}`);
  if (popup.closedByEscape === false) costs.push("Escape did not close it");
  return costs.length > 0
    ? { name, verdict: "degraded", why: costs.join(", "), short }
    : { name, verdict: "ok", why: "", short };
}

function tourRows(ctx: Ctx, sizeOf: Size, parts: TourParts, base: TourParts | undefined): Row[] {
  const baseOf = (part: TourPart): TourPart | undefined => base?.find((one) => one.position === part.position);
  const env = parts.find((part) => part.env)?.env;
  const problems = parts.flatMap((part) => part.problems);
  const make = (name: string, text: Text, subs: Sub[], measured: Record<string, unknown>): Row => ({
    case: `${name}@${sizeOf}`,
    notation: "bpmn",
    strategy: ctx.strategy,
    zoom: ctx.zoom,
    ...text,
    env: envRow(env),
    measured,
    ...fold(subs),
    problems,
  });
  const byPosition = <T>(read: (part: TourPart) => T): Record<string, T> =>
    Object.fromEntries(parts.map((part) => [part.position, read(part)]));
  return [
    make(
      "pad",
      PAD_TEXT,
      parts.map((part) => judgePad(part, baseOf(part))),
      byPosition((part) => ({
        element: part.element,
        skipped: part.skipped,
        ...part.pad,
        baseline: baseOf(part)?.pad?.gapUnits,
      })),
    ),
    make(
      "popup-replace",
      REPLACE_TEXT,
      parts.map((part) => judgePopup(part, baseOf(part), "replace")),
      byPosition((part) => ({ element: part.element, skipped: part.skipped, ...part.replace })),
    ),
    make(
      "popup-colour",
      COLOUR_TEXT,
      parts.map((part) => judgePopup(part, baseOf(part), "colour")),
      byPosition((part) => ({ element: part.element, skipped: part.skipped, ...part.colour })),
    ),
  ];
}

// ── plan: the align menu of a selection of two ───────────────────────────────

interface AlignPart extends PageResult {
  skipped?: string;
  selected: number;
  pad?: PadMeasure;
  popup?: PopupMeasure;
}

async function measureAlign(ctx: Ctx): Promise<AlignPart> {
  const part: AlignPart = { selected: 0, problems: [] };
  return onPage(ctx, "800x508", "align", {}, part, async (session) => {
    const { board, node } = session;
    const first = await selectOnly(session, "Task_check_credit");
    const second = await pointOn(session, "Task_reject_order");
    if (first !== "" || "blocked" in second) {
      part.skipped =
        first !== "" ? `Task_check_credit ${first}` : `Task_reject_order ${"blocked" in second ? second.blocked : ""}`;
      return;
    }
    await board.page.keyboard.down("Shift");
    await board.click(second.at);
    await board.page.keyboard.up("Shift");
    await board.waitFor(async () => (await node.selected()).length === 2, 2000);
    part.selected = (await node.selected()).length;
    if (part.selected !== 2) return;
    part.pad = await measurePad(session, "Task_check_credit");
    part.popup = await measurePopup(session, "align-elements", undefined, "align");
    if (!part.popup.opened || !(await node.state()).armed) return;
    part.popup.chosen = await choose(session, "align-elements", undefined, "align-elements-top", (before, after) => {
      const [a, b] = [shapeBounds(after, "Task_check_credit"), shapeBounds(after, "Task_reject_order")];
      const was = shapeBounds(before, "Task_reject_order");
      return {
        ok: !!a && !!b && a.y === b.y && b.x === was?.x,
        detail: `Task_reject_order y ${was?.y ?? "?"} -> ${b?.y ?? "?"}, Task_check_credit y ${a?.y ?? "?"}`,
      };
    });
  });
}

const ALIGN_TEXT: Text = {
  did: "Selected two tasks (a click, then Shift and a click), opened the align menu from the pad of the selection, read the popup as in popup-replace, then chose Align top.",
  expected:
    "As popup-replace: at the pad's bottom-left corner, all of it visible and hittable; Align top gives both tasks the same y in the file. It is the third and last popup menu bpmn-js opens here, through the same popup service.",
  rule: "as popup-replace, for the one selection; unmeasured when the two tasks cannot be selected together.",
};

function alignRows(ctx: Ctx, part: AlignPart, base: AlignPart | undefined): Row[] {
  const asTour = (one: AlignPart): TourPart => ({
    position: "middle",
    element: "selection of two",
    problems: [],
    ...(one.env ? { env: one.env } : {}),
    ...(one.error ? { error: one.error } : {}),
    ...(one.skipped ? { skipped: one.skipped } : {}),
    ...(one.pad ? { pad: one.pad } : {}),
    ...(one.popup ? { replace: one.popup } : {}),
  });
  const sub =
    !part.error && !part.skipped && part.selected !== 2
      ? {
          name: "selection",
          verdict: "unmeasured" as const,
          why: `Shift and a click selected ${part.selected} elements, not 2`,
        }
      : { ...judgePopup(asTour(part), base ? asTour(base) : undefined, "replace"), name: "selection" };
  return [
    {
      case: "popup-align",
      notation: "bpmn",
      strategy: ctx.strategy,
      zoom: ctx.zoom,
      ...ALIGN_TEXT,
      env: envRow(part.env),
      measured: { selected: part.selected, pad: part.pad, popup: part.popup },
      ...fold([sub]),
      problems: part.problems,
    },
  ];
}

// ── plan: the palette ────────────────────────────────────────────────────────

interface PalettePart extends PageResult {
  box?: Box;
  twoColumn?: boolean;
  columns?: number;
  entry?: { width: number; height: number };
  entries?: number;
  reachable?: number;
  unreachable?: string[];
  unclipped?: number | null;
  /** px the palette reaches beyond the engine host's bottom edge */
  beyondHost?: number;
  /** shapes of the sample whose middle lies under the palette */
  covers?: string[];
  tooltip?: {
    entry: string;
    shown: boolean;
    box?: Box;
    text?: string;
    /** tooltip's left edge minus the entry's right edge, and its middle minus the entry's, in screen px */
    offset?: Point;
    /** offset minus what diagram-js asks for: (8 px of its chrome, 0) */
    error?: Point;
    unclipped?: number | null;
  };
}

async function measurePalette(ctx: Ctx, sizeOf: Size): Promise<PalettePart> {
  return onPage(ctx, sizeOf, `palette-${sizeOf}`, {}, { problems: [] } as PalettePart, async (session, part) => {
    const { board, node } = session;
    const box = (await node.query(".djs-palette"))[0];
    if (!box) return;
    const entries = await items(node, ".djs-palette .entry");
    const hits = await probes(
      node,
      entries.map((entry) => centre(entry.box)),
    );
    const unreachable = entries
      .map((entry, index) => ({ entry, hit: hits[index]! }))
      .filter(({ entry, hit }) => !(hit.reachable && hit.kind === "palette" && hit.entry === entry.id))
      .map(({ entry }) => entry.id);
    const covers: string[] = [];
    for (const shape of SHAPES) {
      const shapeBox = await node.elementBox(shape);
      if (shapeBox && (await probe(node, centre(shapeBox))).kind === "palette") covers.push(shape);
    }
    part.box = rbox(box);
    part.twoColumn = await node.inDocument(
      (host) => host.querySelector(".djs-palette")?.classList.contains("two-column") === true,
    );
    part.columns = new Set(entries.map((entry) => Math.round(entry.box.x))).size;
    part.entry = entries[0] ? { width: r1(entries[0].box.width), height: r1(entries[0].box.height) } : undefined;
    part.entries = entries.length;
    part.reachable = entries.length - unreachable.length;
    part.unreachable = unreachable;
    part.unclipped = await unclipped(node, ".djs-palette");
    part.beyondHost = r1(Math.max(0, lowerRight(box).y - lowerRight(session.env.host).y));
    part.covers = covers;
    // the tooltip of an entry that can be hovered: the task entry, else the first one that can
    const reachable = entries.filter((entry) => !unreachable.includes(entry.id));
    const target = reachable.find((entry) => entry.id === "create.task") ?? reachable[0];
    if (!target) return;
    await board.move(centre(target.box), 4);
    const tip = await board.waitForBox(async () => (await node.query(".djs-hover-tooltip"))[0], 3000);
    part.tooltip = { entry: target.id, shown: tip !== null };
    if (!tip) return;
    const offset = {
      x: tip.x - (target.box.x + target.box.width),
      y: tip.y + tip.height / 2 - (target.box.y + target.box.height / 2),
    };
    part.tooltip = {
      entry: target.id,
      shown: true,
      box: rbox(tip),
      text: (await items(node, ".djs-hover-tooltip"))[0]?.text ?? "",
      offset: { x: r1(offset.x), y: r1(offset.y) },
      error: { x: r1(offset.x - 8 * session.env.chrome), y: r1(offset.y) },
      unclipped: await unclipped(node, ".djs-hover-tooltip"),
    };
    await shot(session, "tooltip", [tip]);
  });
}

const PALETTE_TEXT: Text = {
  did: "Read the palette right after arming: its box, its columns, the size of an entry, a hit-test in the middle of each of its 14 entries, the shapes of the sample whose middle lies under it; then hovered one entry and read the tooltip once it rested.",
  expected:
    "All 14 entries take a press, the palette covers no more of the diagram than in the baseline (overlay strategy, board zoom 1, same node size), and the tooltip stands 8 px of the chrome right of its entry at the entry's height, where diagram-js asks for it. The palette is laid out in container px and the tooltip with position fixed and client coordinates.",
  rule: `broken when no entry can be hit; degraded when an entry cannot be hit, the palette covers a shape it does not cover in the baseline, an entry is under ${SMALL} px, or the tooltip is missing, clipped or more than ${PX} px from its place; else ok.`,
};

function paletteRows(ctx: Ctx, sizeOf: Size, part: PalettePart, base: PalettePart | undefined): Row[] {
  let sub: Sub;
  const name = "palette";
  if (part.error) sub = { name, verdict: "unmeasured", why: `the page failed: ${part.error}` };
  else if (!part.box || part.entries === undefined || !part.entry)
    sub = { name, verdict: "broken", why: "no palette is shown" };
  else {
    const tip = part.tooltip;
    const short =
      `${part.columns} col, ${size(part.box)}, entry ${part.entry.width} px, ${part.reachable}/${part.entries} hit, ` +
      `covers ${part.covers?.length ?? 0}, tooltip ${tip?.error ? `off ${pt(tip.error)}` : "none"}`;
    const costs: string[] = [];
    if (part.reachable === 0) sub = { name, verdict: "broken", why: "none of its entries can be hit", short };
    else {
      if ((part.reachable ?? 0) < part.entries) {
        costs.push(
          `${part.entries - (part.reachable ?? 0)} of ${part.entries} entries cannot be hit (${(part.unreachable ?? []).join(", ")})`,
        );
      }
      const more = (part.covers ?? []).filter((shape) => !(base?.covers ?? []).includes(shape));
      if (more.length > 0) costs.push(`covers ${more.join(", ")}`);
      if (part.entry.width < SMALL) costs.push(`entries are ${part.entry.width} px`);
      if (!tip?.shown) costs.push("no tooltip appeared");
      else {
        // the engine's 8 px may be px of the chrome or of the screen (a strategy that corrects its math)
        const slack = PX + 8 * Math.abs(1 - (part.env?.chrome ?? 1));
        if (tip.error && (Math.abs(tip.error.x) > slack || Math.abs(tip.error.y) > PX))
          costs.push(`the tooltip is ${pt(tip.error)} px from its place`);
        if (tip.unclipped !== null && tip.unclipped !== undefined && tip.unclipped < 0.98) {
          costs.push(`${Math.round((1 - tip.unclipped) * 100)} % of the tooltip is clipped`);
        }
      }
      sub =
        costs.length > 0
          ? { name, verdict: "degraded", why: costs.join(", "), short }
          : { name, verdict: "ok", why: "", short };
    }
  }
  return [
    {
      case: `palette@${sizeOf}`,
      notation: "bpmn",
      strategy: ctx.strategy,
      zoom: ctx.zoom,
      ...PALETTE_TEXT,
      env: envRow(part.env),
      measured: { ...part, env: undefined, problems: undefined, baselineCovers: base?.covers },
      ...fold([sub]),
      cell: sub.short ?? sub.why,
      problems: part.problems,
    },
  ];
}

// ── plan: the label editor ───────────────────────────────────────────────────

type LabelKind = "task" | "event" | "annotation";
const LABEL_KINDS: readonly LabelKind[] = ["task", "event", "annotation"];
/** the element of each kind, in order of preference; for the annotation: the tasks to append one to */
const LABEL_TARGETS: Readonly<Record<LabelKind, readonly string[]>> = {
  task: ["Task_reject_order", "CallActivity_invoice_handling", "Task_check_credit"],
  event: ["EndEvent_order_rejected", "EndEvent_order_fulfilled"],
  annotation: ["CallActivity_invoice_handling", "Task_reject_order", "Task_check_credit", "Task_validate_order"],
};

interface EditorRead {
  /** the size bpmn-js asked for in the box's style, in CSS px of its container */
  requested: { width: number; height: number };
  /** the size the engine reads back when the editor closes (the plain getBoundingClientRect, on purpose) */
  engineSees: { width: number; height: number };
  fontPx: number;
  text: string;
  focused: boolean;
}

/** runs in the node's document: the open label editor, null when none is open */
const EDITOR = (host: HTMLElement): EditorRead | null => {
  const parent = host.querySelector<HTMLElement>(".djs-direct-editing-parent");
  const content = host.querySelector<HTMLElement>(".djs-direct-editing-content");
  if (!parent || !content) return null;
  // Not the native function: DirectEditing.complete() compares THIS rectangle with the size it
  // asked for, and runs a command when they differ. What the armed editor sees is the question
  const rect = parent.getBoundingClientRect();
  return {
    requested: { width: parseFloat(parent.style.width), height: parseFloat(parent.style.height) },
    engineSees: { width: rect.width, height: rect.height },
    fontPx: parseFloat(getComputedStyle(content).fontSize),
    text: content.innerText,
    focused: document.activeElement === content,
  };
};

const editorBox = (session: Session, timeout = 2500): Promise<Box | null> =>
  session.board.waitForBox(async () => (await session.node.query(".djs-direct-editing-parent"))[0], timeout);
async function editorGone(session: Session): Promise<boolean> {
  const gone = await session.board.waitFor(
    async () => (await session.node.query(".djs-direct-editing-parent")).length === 0,
    1000,
  );
  // the canvas gets the focus back one task later: the next key of a case must not fall into that gap
  if (gone && (await session.node.state()).armed) await canvasFocused(session);
  return gone === true;
}

/** opens the label editor of an element with a double-click on its middle; null when that is not possible */
async function openByDoubleClick(session: Session, element: string): Promise<Box | null> {
  const point = await pointOn(session, element);
  if ("blocked" in point) return null;
  await session.board.doubleClick(point.at);
  return editorBox(session);
}

/** opens it with the E key on the selected element */
async function openByKey(session: Session, element: string): Promise<Box | null> {
  if ((await selectOnly(session, element)) !== "") return null;
  await session.board.press("e");
  return editorBox(session);
}

interface Created {
  on: string;
  /** candidates passed over, and why */
  passed: string[];
  entryReachable: boolean;
  opened: boolean;
  /** the annotation's element id in this page */
  id?: string;
  text?: string;
  bounds?: Bounds | null;
}

/** appends a text annotation to a task through the pad and types `text` into the editor that opens */
async function createAnnotation(session: Session, text: string): Promise<Created> {
  const { board, node } = session;
  const passed: string[] = [];
  for (const task of LABEL_TARGETS.annotation) {
    const blocked = await selectOnly(session, task);
    if (blocked !== "") {
      passed.push(`${task} ${blocked}`);
      continue;
    }
    const pad = await readPad(session);
    const entry = pad?.entries.find((one) => one.id === "append.text-annotation");
    if (!entry) {
      passed.push(`${task}: no pad entry`);
      continue;
    }
    const at = aimAt(await node.map(), centre(entry.box));
    const hit = await probe(node, at);
    if (!(hit.reachable && hit.kind === "pad" && hit.entry === "append.text-annotation")) {
      passed.push(`${task}: its pad entry cannot be hit (${hit.kind === "outside" ? hit.what : hit.kind})`);
      continue;
    }
    const before = await fileNow(board);
    const known = new Set(annotations(before).map((one) => one.id));
    await board.click(at);
    const opened = (await editorBox(session)) !== null;
    if (!opened) return { on: task, passed, entryReachable: true, opened };
    await board.type(text);
    await board.press("Enter");
    const after = await fileAfter(board, before, 3000);
    const fresh = annotations(after.text).find((one) => !known.has(one.id));
    return {
      on: task,
      passed,
      entryReachable: true,
      opened,
      ...(fresh ? { id: fresh.id, text: fresh.text, bounds: shapeBounds(after.text, fresh.id) } : {}),
    };
  }
  return { on: "", passed, entryReachable: false, opened: false };
}

/** the label text as the file has it: the name attribute, or the annotation's text element */
const labelInFile = (text: string, kind: LabelKind, element: string): string | null =>
  kind === "annotation" ? (annotations(text).find((one) => one.id === element)?.text ?? null) : nameOf(text, element);

interface LabelPart extends PageResult {
  kind: LabelKind;
  /** the element's id; "annotation" for the created one (its id is random) */
  element: string;
  skipped?: string;
  created?: Created;
  /** the label's own box (its hit rectangle) and font size on screen before the editor opened */
  target?: Box;
  labelFont?: number | null;
  doubleClick?: { opened: boolean; box?: Box; font?: number; text?: string; focused?: boolean };
  key?: { opened: boolean; box?: Box };
  typed?: { typed: string; inFile: string | null; changed: boolean; bounds?: Bounds | null };
  multiline?: { inFile: string | null; changed: boolean };
  escape?: { opened: boolean; closed: boolean; fileSame: boolean; detail: string };
}

async function labelPage(ctx: Ctx, kind: LabelKind): Promise<LabelPart> {
  const part: LabelPart = { kind, element: "", problems: [] };
  return onPage(ctx, "800x508", `label-${kind}`, {}, part, async (session) => {
    const { board, node } = session;
    let element: string | undefined;
    if (kind === "annotation") {
      part.created = await createAnnotation(session, "Note");
      element = part.created.id;
      if (!element) {
        part.skipped = part.created.entryReachable
          ? "the annotation did not reach the file"
          : `no task's pad entry can be hit: ${part.created.passed.join("; ")}`;
        return;
      }
      part.element = "annotation";
    } else {
      const passed: string[] = [];
      for (const candidate of LABEL_TARGETS[kind]) {
        const point = await pointOn(session, candidate);
        if (!("blocked" in point)) {
          element = candidate;
          break;
        }
        passed.push(`${candidate} ${point.blocked}`);
      }
      if (!element) {
        part.skipped = passed.join("; ");
        return;
      }
      part.element = element;
    }
    const id = element;
    // the label's own place and font, before the editor hides it
    const own = kind === "event" ? `${id}_label` : id;
    part.target = (await items(node, `[data-element-id="${own}"] > .djs-hit`))[0]?.box;
    const fontUnits = await node.inDocument((host, labelId: string) => {
      const text = host.querySelector(`[data-element-id="${CSS.escape(labelId)}"] .djs-visual text`);
      return text ? parseFloat(getComputedStyle(text).fontSize) : null;
    }, own);
    part.labelFont = fontUnits === null ? null : r2(fontUnits * session.env.unit);

    // 1. a double-click opens it
    const byClick = await openByDoubleClick(session, id);
    const read = byClick ? await node.inDocument(EDITOR) : null;
    part.doubleClick = {
      opened: byClick !== null,
      ...(byClick ? { box: rbox(byClick) } : {}),
      ...(read ? { font: r2(read.fontPx * session.env.chrome), text: read.text, focused: read.focused } : {}),
    };
    if (byClick) {
      await shot(session, "editor", [byClick]);
      await board.press("Escape");
      await editorGone(session);
    }
    // 2. the E key opens it
    const byKey = await openByKey(session, id);
    part.key = { opened: byKey !== null, ...(byKey ? { box: rbox(byKey) } : {}) };
    if (!byKey && !byClick) return;
    const reopen = async (): Promise<boolean> =>
      ((await openByDoubleClick(session, id)) ?? (await openByKey(session, id))) !== null;
    // 3. typing and Enter reach the file (the editor of step 2 is still open when the key opened it)
    if (byKey || (await reopen())) {
      const before = await fileNow(board);
      await board.press("Control+a");
      await board.type("Edited 1");
      await board.press("Enter");
      const after = await fileAfter(board, before, 3000);
      part.typed = {
        typed: "Edited 1",
        inFile: labelInFile(after.text, kind, id),
        changed: after.changed,
        ...(kind === "annotation" ? { bounds: shapeBounds(after.text, id) } : {}),
      };
    }
    // 4. Shift + Enter breaks the line
    if (await reopen()) {
      const before = await fileNow(board);
      await board.press("Control+a");
      await board.type("Line 1");
      await board.press("Shift+Enter");
      await board.type("Line 2");
      await board.press("Enter");
      const after = await fileAfter(board, before, 3000);
      part.multiline = { inFile: labelInFile(after.text, kind, id), changed: after.changed };
    }
    // 5. Escape leaves the file alone
    const before = await fileNow(board);
    const opened = await reopen();
    if (opened) {
      await board.press("Control+a");
      await board.type("Discarded");
      await board.press("Escape");
    }
    const closed = await editorGone(session);
    // long enough for a write that should not come: the binding writes about 350 ms after a command
    const after = await fileAfter(board, before, 2000);
    part.escape = { opened, closed, fileSame: !after.changed, detail: diffOf(before, after.text).detail };
  });
}

type LabelParts = LabelPart[];
async function measureLabels(ctx: Ctx): Promise<LabelParts> {
  const parts: LabelParts = [];
  for (const kind of LABEL_KINDS) parts.push(await labelPage(ctx, kind));
  return parts;
}

const LABEL_BOX: Text = {
  did: "For a task, an event with an external label and a text annotation (appended through the pad first, a fresh page each): read the label's own box and font size on screen, opened the label editor with a double-click and read the text box once it rested.",
  expected:
    "The text box lies on the label it edits (the task's rectangle, the external label's box, the annotation's box, plus the 1 px border bpmn-js gives the last two) and its font has the size the label's own text has on screen. bpmn-js computes the box from the viewbox and its own zoom, with no client rectangle.",
  rule: `per kind: broken when neither the double-click nor the key opens the editor; degraded when the box's middle or its size is more than ${PX} px (plus the border) from the label's, or the font differs by more than 5 %; else ok. unmeasured when the element cannot be reached.`,
};
const LABEL_OPEN: Text = {
  did: "For the same three: opened the label editor with a double-click on the element, closed it with Escape, then opened it with the E key on the selected element.",
  expected:
    "Both ways open the editor with the caret in it. The double-click is a canvas event, the key a keydown on the canvas svg.",
  rule: "per kind: ok when both open it, degraded when one does, broken when neither does.",
};
const LABEL_TYPE: Text = {
  did: "For the same three: selected the whole text in the open editor (Control + A), typed 'Edited 1' and pressed Enter; for the annotation also the text typed right after appending it ('Note').",
  expected:
    "The file has exactly the typed text as the element's name (the annotation's text), and a freshly appended annotation has the size the baseline gives it (overlay strategy, board zoom 1). bpmn-js derives an annotation's new size from the text box's client rectangle.",
  rule: `per kind: broken when the file did not change; wrong-data when the file has another text than typed, or the new annotation's width or height is more than ${UNITS} units from the baseline's; else ok.`,
};
const LABEL_MULTI: Text = {
  did: "For the same three: opened the editor again, selected all, typed 'Line 1', Shift + Enter, 'Line 2', Enter.",
  expected:
    "The file has both lines with one line break between them (in a name attribute as the entity for a line feed).",
  rule: "per kind: ok when the file's text is 'Line 1', a line break, 'Line 2'; wrong-data when it is something else; broken when the file did not change.",
};
const LABEL_ESCAPE: Text = {
  did: "For the same three: opened the editor again, selected all, typed 'Discarded' and pressed Escape; waited 2 s for a write to the file.",
  expected: "The editor closes and the file is byte-identical to before: Escape cancels, no command runs.",
  rule: "per kind: ok when the editor closed and the file is the same; wrong-data when the file changed; broken when the editor stayed open.",
};

function labelRows(ctx: Ctx, parts: LabelParts, base: LabelParts | undefined): Row[] {
  const env = parts.find((part) => part.env)?.env;
  const problems = parts.flatMap((part) => part.problems);
  const blocked = (part: LabelPart): Sub | undefined =>
    part.error
      ? { name: part.kind, verdict: "unmeasured", why: `the page failed: ${part.error}` }
      : part.skipped
        ? { name: part.kind, verdict: "unmeasured", why: part.skipped }
        : undefined;
  const box = parts.map((part): Sub => {
    const name = part.kind;
    const stop = blocked(part);
    if (stop) return stop;
    const editor = part.doubleClick?.box ?? part.key?.box;
    if (!editor || !part.target || !part.env) {
      return { name, verdict: "broken", why: "neither a double-click nor the E key opened the editor" };
    }
    const border = part.kind === "task" ? 0 : 2 * part.env.chrome;
    const off = { x: centre(editor).x - centre(part.target).x, y: centre(editor).y - centre(part.target).y };
    const grown = { x: editor.width - part.target.width - border, y: editor.height - part.target.height - border };
    const font = part.doubleClick?.font;
    const ratio = font && part.labelFont ? r2(font / part.labelFont) : null;
    const short = `off ${pt(off)} px, size ${pt(grown)} px, font ${font ?? "?"}/${part.labelFont ?? "?"} px`;
    const costs: string[] = [];
    if (Math.abs(off.x) > PX || Math.abs(off.y) > PX) costs.push(`its middle is ${pt(off)} px from the label's`);
    // an external label's box follows its text: the editor is at least as large as the label
    if (Math.abs(grown.x) > PX + 1 || Math.abs(grown.y) > PX + 1) costs.push(`its size differs by ${pt(grown)} px`);
    if (ratio !== null && Math.abs(ratio - 1) > 0.05) costs.push(`its font is ${ratio} of the label's`);
    return costs.length > 0
      ? { name, verdict: "degraded", why: costs.join(", "), short }
      : { name, verdict: "ok", why: "", short };
  });
  const open = parts.map((part): Sub => {
    const name = part.kind;
    const stop = blocked(part);
    if (stop) return stop;
    const [click, key] = [part.doubleClick?.opened === true, part.key?.opened === true];
    const short = `double-click ${click ? "yes" : "no"}, key ${key ? "yes" : "no"}`;
    if (click && key) return { name, verdict: "ok", why: "", short };
    if (!click && !key) return { name, verdict: "broken", why: "neither way opened the editor", short };
    return {
      name,
      verdict: "degraded",
      why: click ? "the E key did not open it" : "the double-click did not open it",
      short,
    };
  });
  const typed = parts.map((part): Sub => {
    const name = part.kind;
    const stop = blocked(part);
    if (stop) return stop;
    if (!part.typed) return { name, verdict: "unmeasured", why: "the editor did not open" };
    const reference = base?.find((one) => one.kind === part.kind)?.created?.bounds;
    const made = part.created?.bounds;
    const short =
      `file has '${part.typed.inFile ?? "nothing"}'` +
      (made ? `, new annotation ${size(made)} (baseline ${reference ? size(reference) : "?"})` : "");
    if (!part.typed.changed) return { name, verdict: "broken", why: "typing and Enter left the file as it was", short };
    if (part.typed.inFile !== part.typed.typed) {
      return {
        name,
        verdict: "wrong-data",
        why: `typed '${part.typed.typed}', the file has '${part.typed.inFile ?? "nothing"}'`,
        short,
      };
    }
    if (part.created && part.created.text !== "Note") {
      return {
        name,
        verdict: "wrong-data",
        why: `typed 'Note' into the new annotation, the file had '${part.created.text ?? "nothing"}'`,
        short,
      };
    }
    if (
      made &&
      reference &&
      (Math.abs(made.width - reference.width) > UNITS || Math.abs(made.height - reference.height) > UNITS)
    ) {
      return {
        name,
        verdict: "wrong-data",
        why: `the new annotation is stored ${size(made)} units, the baseline stores ${size(reference)}`,
        short,
      };
    }
    return { name, verdict: "ok", why: "", short };
  });
  const multi = parts.map((part): Sub => {
    const name = part.kind;
    const stop = blocked(part);
    if (stop) return stop;
    if (!part.multiline) return { name, verdict: "unmeasured", why: "the editor did not open again" };
    const text = (part.multiline.inFile ?? "").replace(/&#10;/g, "\n");
    const short = `file has ${JSON.stringify(text)}`;
    if (!part.multiline.changed) return { name, verdict: "broken", why: "the file did not change", short };
    return text === "Line 1\nLine 2"
      ? { name, verdict: "ok", why: "", short }
      : { name, verdict: "wrong-data", why: short, short };
  });
  const escape = parts.map((part): Sub => {
    const name = part.kind;
    const stop = blocked(part);
    if (stop) return stop;
    if (!part.escape?.opened) return { name, verdict: "unmeasured", why: "the editor did not open again" };
    const short = `${part.escape.closed ? "closed" : "still open"}, file ${part.escape.fileSame ? "same" : "changed"}`;
    if (!part.escape.fileSame)
      return { name, verdict: "wrong-data", why: `the file changed: ${part.escape.detail}`, short };
    return part.escape.closed
      ? { name, verdict: "ok", why: "", short }
      : { name, verdict: "broken", why: "Escape did not close the editor", short };
  });
  /** per kind, the part of the page's measurement a row is about; the annotation's random id stays out */
  const measured = (read: (part: LabelPart) => Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      parts.map((part) => [
        part.kind,
        { element: part.element, skipped: part.skipped, error: part.error, ...read(part) },
      ]),
    );
  const created = (part: LabelPart): Record<string, unknown> | undefined =>
    part.created
      ? {
          on: part.created.on,
          passed: part.created.passed,
          entryReachable: part.created.entryReachable,
          opened: part.created.opened,
          text: part.created.text,
          bounds: part.created.bounds,
        }
      : undefined;
  const make = (name: string, text: Text, subs: Sub[], values: Record<string, unknown>): Row => ({
    case: name,
    notation: "bpmn",
    strategy: ctx.strategy,
    zoom: ctx.zoom,
    ...text,
    env: envRow(env),
    measured: values,
    ...fold(subs),
    problems,
  });
  return [
    make(
      "label-box",
      LABEL_BOX,
      box,
      measured((part) => ({
        label: part.target ? rbox(part.target) : undefined,
        labelFont: part.labelFont,
        editorByDoubleClick: part.doubleClick,
        editorByKey: part.key,
      })),
    ),
    make(
      "label-open",
      LABEL_OPEN,
      open,
      measured((part) => ({ doubleClick: part.doubleClick?.opened, key: part.key?.opened })),
    ),
    make(
      "label-type",
      LABEL_TYPE,
      typed,
      measured((part) => ({ created: created(part), typed: part.typed })),
    ),
    make(
      "label-multiline",
      LABEL_MULTI,
      multi,
      measured((part) => ({ multiline: part.multiline })),
    ),
    make(
      "label-escape",
      LABEL_ESCAPE,
      escape,
      measured((part) => ({ escape: part.escape })),
    ),
  ];
}

// ── plan: opening and closing the label editor without typing ────────────────

type NoopVariant = "fit" | "100";

interface NoopKind {
  kind: LabelKind;
  element: string;
  skipped?: string;
  opened: boolean;
  /** the editor's own zoom when it opened */
  canvas?: number;
  requested?: { width: number; height: number };
  engineSees?: { width: number; height: number };
  /** the engine's own test on closing: are the two sizes the same number? */
  sizesEqual?: boolean;
  changed?: boolean;
  diff?: Diff;
}

interface NoopPart extends PageResult {
  variant: NoopVariant;
  /** variant 100: the editor's zoom after Control + 0 at board zoom 1, before the board was zoomed */
  canvasAfterKey?: number;
  /** variant 100: the board zoom disarmed the node (armedzoom=disarm) and the node was armed again */
  rearmed?: boolean;
  kinds: NoopKind[];
}

async function measureNoop(ctx: Ctx, variant: NoopVariant): Promise<NoopPart> {
  const part: NoopPart = { variant, kinds: [], problems: [] };
  // variant 100: the page opens at board zoom 1, the editor is set to 100 %, then the board is zoomed
  const options = variant === "100" ? { zoom: 1 } : {};
  return onPage(ctx, "800x508", `noop-${variant}`, options, part, async (session) => {
    const { board, node } = session;
    if (variant === "100") {
      await board.press("Control+0");
      await restingMatrix(session);
      part.canvasAfterKey = r3((await node.viewportMatrix())?.a ?? 0);
      await board.showNode(session.id, ctx.zoom, ORIGIN);
      // under armedzoom=disarm that board zoom made the node a preview: arm it again (the view is kept),
      // which may move the board once more (armzoom); `env.zoom` below is the zoom in effect
      if (!(await node.state()).armed) {
        part.rearmed = true;
        await board.arm(session.id);
      }
      await restingMatrix(session);
      session.env = await envOf(board, node);
      part.env = session.env;
    }
    for (const kind of LABEL_KINDS) {
      const one: NoopKind = { kind, element: "", opened: false };
      part.kinds.push(one);
      let element: string | undefined;
      if (kind === "annotation") {
        const created = await createAnnotation(session, "Note");
        element = created.id;
        if (!element) {
          one.skipped = created.entryReachable
            ? "the annotation did not reach the file"
            : `no task's pad entry can be hit: ${created.passed.join("; ")}`;
          continue;
        }
        one.element = "annotation";
      } else {
        const passed: string[] = [];
        for (const candidate of LABEL_TARGETS[kind]) {
          const point = await pointOn(session, candidate);
          if (!("blocked" in point)) {
            element = candidate;
            break;
          }
          passed.push(`${candidate} ${point.blocked}`);
        }
        if (!element) {
          one.skipped = passed.join("; ");
          continue;
        }
        one.element = element;
      }
      const before = await fileNow(board);
      const opened = (await openByDoubleClick(session, element)) ?? (await openByKey(session, element));
      one.opened = opened !== null;
      if (!opened) continue;
      const read = await node.inDocument(EDITOR);
      one.canvas = r3((await node.viewportMatrix())?.a ?? 0);
      if (read) {
        one.requested = read.requested;
        one.engineSees = read.engineSees;
        one.sizesEqual =
          read.requested.width === read.engineSees.width && read.requested.height === read.engineSees.height;
      }
      // no key typed: Enter closes the editor the way a click elsewhere does (DirectEditing.complete)
      await board.press("Enter");
      await editorGone(session);
      // long enough for a write that should not come: the binding writes about 350 ms after a command
      const after = await fileAfter(board, before, 2500);
      one.changed = after.changed;
      one.diff = diffOf(before, after.text);
    }
  });
}

const noopText = (variant: NoopVariant): Text => ({
  did:
    variant === "fit"
      ? "With the view the node shows after arming: opened the label editor of a task, of an event's external label and of a text annotation (appended through the pad first) with a double-click, typed nothing, pressed Enter, and compared the file with the file before, waiting 2.5 s for a write. Also read the two numbers bpmn-js compares on closing: the size it asked for and the size it reads back."
      : "Opened the page at board zoom 1, armed the node, pressed Control + 0 (the editor's own zoom at 100 %, so that label boxes are whole px), then zoomed the board to the row's zoom. Then as label-noop-fit.",
  expected:
    "The file stays byte-identical: nothing was typed. bpmn-js runs its update command when the text box's client rectangle differs from the size it asked for, so the box must come back with exactly that size: whole CSS px (the browser lays out in 1/64 px) and a net scale of 1 between layout and client px.",
  rule: `per kind: ok when the file is byte-identical; degraded when a command ran but only an empty BPMNLabel element was added or a stored geometry value moved by at most ${UNITS} units; wrong-data when a geometry value moved further or anything else changed; broken when the editor did not open.`,
});

function noopRows(ctx: Ctx, part: NoopPart): Row[] {
  const subs = LABEL_KINDS.map((kind): Sub => {
    const one = part.kinds.find((entry) => entry.kind === kind);
    if (part.error && !one?.diff) return { name: kind, verdict: "unmeasured", why: `the page failed: ${part.error}` };
    if (!one) return { name: kind, verdict: "unmeasured", why: "not reached" };
    if (one.skipped) return { name: kind, verdict: "unmeasured", why: one.skipped };
    if (!one.opened || !one.diff) return { name: kind, verdict: "broken", why: "the editor did not open" };
    const sizes =
      one.requested && one.engineSees
        ? `asked ${r3(one.requested.width)}x${r3(one.requested.height)}, read back ${r3(one.engineSees.width)}x${r3(one.engineSees.height)}`
        : "sizes not read";
    const short = `${one.diff.same ? "same" : one.diff.kind === "bounds" ? `moved ${one.diff.maxDelta} u` : one.diff.kind}; ${sizes}`;
    if (one.diff.same) return { name: kind, verdict: "ok", why: "", short };
    if (one.diff.kind === "empty-label" || (one.diff.kind === "bounds" && one.diff.maxDelta <= UNITS)) {
      return { name: kind, verdict: "degraded", why: `a command ran: ${one.diff.detail} (${sizes})`, short };
    }
    return { name: kind, verdict: "wrong-data", why: `${one.diff.detail} (${sizes})`, short };
  });
  return [
    {
      case: `label-noop-${part.variant}`,
      notation: "bpmn",
      strategy: ctx.strategy,
      zoom: ctx.zoom,
      ...noopText(part.variant),
      ...(part.rearmed
        ? {
            did: `${noopText(part.variant).did} That board zoom disarmed the node by rule (armedzoom=disarm); it was armed again through the hook, which left the board at zoom ${part.env?.zoom ?? "?"} by the node's arm rule: the editors opened at THAT board zoom (env.zoom), with the editor's own zoom still at 100 %.`,
          }
        : {}),
      env: envRow(part.env),
      measured: { canvasAfterKey: part.canvasAfterKey, rearmed: part.rearmed, kinds: part.kinds },
      ...fold(subs),
      problems: part.problems,
    },
  ];
}

// ── plan: the label editor's own resize handle (round 4) ─────────────────────

interface ResizePart extends PageResult {
  skipped?: string;
  created?: Created;
  /** the handle on screen, and whether a press at its middle lands on it */
  handle?: { box: Box; hit: boolean; what: string };
  /** the text box on screen before and after the drag */
  before?: Box;
  after?: Box;
  /** the pointer's travel in screen px, as it was really made */
  pointer?: Point;
  /** how much the text box grew on screen, and that over the pointer's travel */
  grown?: Point;
  ratio?: Point;
  /** after Enter: the annotation's bounds in the file before and after, its growth in diagram units */
  storedBefore?: Bounds | null;
  stored?: Bounds | null;
  grownUnits?: Point;
  /** the pointer's travel in diagram units: what the growth should be */
  expectedUnits?: Point;
  changed?: boolean;
}

/**
 * The resize handle in the lower right corner of a text annotation's label editor
 * (diagram-js-direct-editing TextBox.js `resizable`): its listeners add the pointer's client delta
 * to the box's client size and write the sum as CSS px, in a closure no service leads to.
 */
async function measureResize(ctx: Ctx): Promise<ResizePart> {
  const part: ResizePart = { problems: [] };
  return onPage(ctx, "800x508", "label-resize", {}, part, async (session) => {
    const { board, node } = session;
    part.created = await createAnnotation(session, "Note");
    const id = part.created.id;
    if (!id) {
      part.skipped = part.created.entryReachable
        ? "the annotation did not reach the file"
        : `no task's pad entry can be hit: ${part.created.passed.join("; ")}`;
      return;
    }
    part.storedBefore = part.created.bounds ?? null;
    const opened = (await openByDoubleClick(session, id)) ?? (await openByKey(session, id));
    if (!opened) {
      part.skipped = "the annotation's label editor did not open";
      return;
    }
    const handle = (await items(node, ".djs-direct-editing-resize-handle"))[0];
    if (!handle) {
      part.skipped = "the label editor has no resize handle";
      return;
    }
    const map = await node.map();
    const from = aimAt(map, centre(handle.box));
    const hit = await probe(node, from);
    part.handle = {
      box: rbox(handle.box),
      hit: hit.reachable && /djs-direct-editing-resize-handle/.test(hit.what),
      what: hit.what,
    };
    if (!part.handle.hit) {
      await board.press("Escape");
      return;
    }
    part.before = rbox(opened);
    // down and right, by a travel that grows with the board zoom in effect and stays inside the node
    const to = aimAt(map, { x: from.x + 40 * session.env.zoom, y: from.y + 24 * session.env.zoom });
    const { mouse } = board.page;
    await mouse.move(from.x, from.y);
    await mouse.down();
    for (let step = 1; step <= 8; step++) {
      await mouse.move(from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8);
    }
    await mouse.move(to.x, to.y);
    await board.page.waitForTimeout(60);
    await mouse.up();
    const after = await editorBox(session);
    part.pointer = { x: r1(to.x - from.x), y: r1(to.y - from.y) };
    if (after) {
      part.after = rbox(after);
      const grown = { x: after.width - opened.width, y: after.height - opened.height };
      part.grown = { x: r1(grown.x), y: r1(grown.y) };
      part.ratio = { x: r2(grown.x / (to.x - from.x)), y: r2(grown.y / (to.y - from.y)) };
      await shot(session, "resized", [after]);
    }
    const fileBefore = await fileNow(board);
    await board.press("Enter");
    await editorGone(session);
    const file = await fileAfter(board, fileBefore, 2500);
    part.changed = file.changed;
    part.stored = shapeBounds(file.text, id);
    part.expectedUnits = { x: r1((to.x - from.x) / session.env.unit), y: r1((to.y - from.y) / session.env.unit) };
    if (part.stored && part.storedBefore) {
      part.grownUnits = {
        x: r1(part.stored.width - part.storedBefore.width),
        y: r1(part.stored.height - part.storedBefore.height),
      };
    }
  });
}

const RESIZE_TEXT: Text = {
  did: "Appended a text annotation through the pad, opened its label editor with a double-click, pressed the resize handle in the editor's lower right corner, dragged it down and right by 40 x 24 px times the board zoom, released, and pressed Enter. Read the text box on screen before and after the drag, and the annotation's bounds in the file before and after.",
  expected:
    "The text box's corner follows the pointer (growth over pointer travel 1 on both axes), and after Enter the annotation is stored wider by the pointer's travel in diagram units (bpmn-js stores the box's width; an annotation's height stays what it was, in every strategy). The handle's listeners add the pointer's client delta to the box's client size and write the sum as CSS px, which fits only at a net scale of 1.",
  rule: `unmeasured when the annotation or its editor cannot be opened; broken when the handle takes no press; wrong-data when the stored width grew by something else than the pointer's travel along x, by more than ${UNITS} units plus 5 %; degraded when the box on screen grew by something else than the pointer's travel on an axis, by more than ${PX} px plus 5 %; else ok.`,
};

function resizeRows(ctx: Ctx, part: ResizePart): Row[] {
  const name = "annotation";
  let sub: Sub;
  if (part.error) sub = { name, verdict: "unmeasured", why: `the page failed: ${part.error}` };
  else if (part.skipped) sub = { name, verdict: "unmeasured", why: part.skipped };
  else if (!part.handle?.hit) {
    sub = {
      name,
      verdict: "broken",
      why: `the resize handle takes no press at its middle (${part.handle?.what ?? "no handle"})`,
    };
  } else if (!part.pointer || !part.grown || !part.ratio) {
    sub = { name, verdict: "broken", why: "the editor was gone after the drag" };
  } else {
    const { pointer, grown, ratio } = part;
    const stored =
      part.grownUnits && part.expectedUnits
        ? `stored ${r1(part.grownUnits.x)} units wider (pointer ${r1(part.expectedUnits.x)})`
        : "nothing stored";
    const short = `box grew ${pt(grown)} px for ${pt(pointer)} px, ratio ${ratio.x}/${ratio.y}; ${stored}`;
    // the width only: bpmn-js does not store the box's height for an annotation (0 growth in every strategy)
    const offStored =
      part.grownUnits && part.expectedUnits
        ? Math.abs(part.grownUnits.x - part.expectedUnits.x) > UNITS + 0.05 * Math.abs(part.expectedUnits.x)
        : false;
    const offScreen = (["x", "y"] as const).filter(
      (axis) => Math.abs(grown[axis] - pointer[axis]) > PX + 0.05 * Math.abs(pointer[axis]),
    );
    if (!part.grownUnits) sub = { name, verdict: "broken", why: "the annotation's bounds are not in the file", short };
    else if (offStored) {
      sub = {
        name,
        verdict: "wrong-data",
        why: `the annotation is stored ${r1(part.grownUnits.x)} units wider, the pointer travelled ${r1(part.expectedUnits!.x)} units along x (on screen the box grew ${pt(grown)} px for ${pt(pointer)} px)`,
        short,
      };
    } else if (offScreen.length > 0) {
      sub = {
        name,
        verdict: "degraded",
        why: `the text box grew ${pt(grown)} px for a pointer travel of ${pt(pointer)} px (ratio ${ratio.x}/${ratio.y})`,
        short,
      };
    } else sub = { name, verdict: "ok", why: "", short };
  }
  return [
    {
      case: "label-resize",
      notation: "bpmn",
      strategy: ctx.strategy,
      zoom: ctx.zoom,
      ...RESIZE_TEXT,
      env: envRow(part.env),
      measured: {
        skipped: part.skipped,
        created: part.created
          ? { on: part.created.on, passed: part.created.passed, bounds: part.created.bounds }
          : undefined,
        handle: part.handle,
        before: part.before,
        after: part.after,
        pointer: part.pointer,
        grown: part.grown,
        ratio: part.ratio,
        storedBefore: part.storedBefore,
        stored: part.stored,
        grownUnits: part.grownUnits,
        expectedUnits: part.expectedUnits,
        changed: part.changed,
      },
      ...fold([sub]),
      cell: sub.short ?? sub.why,
      problems: part.problems,
    },
  ];
}

// ── plan: keys while armed ───────────────────────────────────────────────────

interface KeyStep {
  /** the editor did what the key stands for */
  editor: boolean;
  /** what the board did: "" when nothing */
  board: string;
  seen: Seen;
  detail: string;
  /** the step's numbers in a few words, for the one-line result */
  numbers?: string;
}

interface KeysPart extends PageResult {
  skipped?: Record<string, string>;
  delete?: KeyStep;
  backspace?: KeyStep;
  undoRedo?: KeyStep & { states: string };
  paste?: KeyStep & {
    pasted: boolean;
    /** the copy's middle minus the click, in screen px and in diagram units */
    offset?: Point;
    offsetUnits?: Point;
    /** the click lies inside the copy's box */
    underClick?: boolean;
    names?: number;
  };
  selectAll?: KeyStep & { selected: number; elements: number; pageText: number };
  arrows?: KeyStep & {
    step: number;
    shiftStep: number;
    stored?: Bounds | null;
    scroll: number;
    scrollExpected: number;
  };
  tools?: KeyStep & { active: Record<string, string>; cancelled: Record<string, boolean> };
  editReplace?: KeyStep & { editor: boolean; popup: boolean; popupPlacement?: string; escapeKeeps: boolean };
  search?: KeyStep & {
    opened: boolean;
    box?: Box;
    unclipped?: number | null;
    inputFocused: boolean;
    inputHit: boolean;
    results: number;
    selected: string[];
    closed: boolean;
  };
}

async function measureKeys(ctx: Ctx): Promise<KeysPart> {
  const part: KeysPart = { problems: [], skipped: {} };
  const skip = (name: string, why: string): void => void (part.skipped![name] = why);
  // page 1: Delete, Backspace, undo and redo
  await onPage(ctx, "800x508", "keys-delete", {}, part, async (session) => {
    const { board } = session;
    await listen(session, ["keydown"]);
    for (const [name, key, candidates] of [
      ["delete", "Delete", ["Task_fulfill_order", "Task_check_credit"]],
      ["backspace", "Backspace", ["Task_reject_order", "CallActivity_invoice_handling"]],
    ] as const) {
      const picked = await selectFirst(session, candidates);
      if (!picked.element) {
        skip(name, picked.passed.join("; "));
        continue;
      }
      const element = picked.element;
      const state = await boardState(session);
      await seen(session, "keydown");
      await board.press(key);
      const gone = await fileBecomes(board, (text) => !hasElement(text, element));
      part[name] = {
        editor: gone,
        board: boardActed(state, await boardState(session)),
        seen: await seen(session, "keydown"),
        detail: `${element} ${gone ? "left the file" : "is still in the file"}`,
      };
      if (name !== "backspace" || !gone) continue;
      // the command stack: undo brings the task back, redo removes it again, by both redo chords
      const states: string[] = [];
      const before = await boardState(session);
      let fine = true;
      for (const [chord, present] of [
        ["Control+z", true],
        ["Control+y", false],
        ["Control+z", true],
        ["Control+Shift+z", false],
      ] as const) {
        await board.press(chord);
        const reached = await fileBecomes(board, (text) => hasElement(text, element) === present);
        states.push(`${chord}: ${reached ? (present ? "back" : "gone") : "no change"}`);
        fine &&= reached;
      }
      part.undoRedo = {
        editor: fine,
        board: boardActed(before, await boardState(session)),
        seen: await seen(session, "keydown"),
        detail: states.join(", "),
        numbers: states.join(", "),
        states: states.join(", "),
      };
    }
  });
  // page 2: copy and paste, select all
  await onPage(ctx, "800x508", "keys-paste", {}, part, async (session) => {
    const { board, node } = session;
    await listen(session, ["keydown"]);
    const source = "Task_check_credit";
    const blocked = await selectOnly(session, source);
    const target = await lanePoint(session);
    if (blocked !== "" || !target) skip("paste", blocked !== "" ? `${source} ${blocked}` : "no free point of a lane");
    else {
      const state = await boardState(session);
      const before = await fileNow(board);
      const known = new Set(await node.elementIds());
      await seen(session, "keydown");
      await board.press("Control+c");
      await board.move(target, 3);
      await board.press("Control+v");
      await board.page.waitForTimeout(150);
      // the preview follows the pointer: a few px on, then the click that drops it
      const drop = aimAt(await node.map(), { x: target.x + 6, y: target.y + 4 });
      await board.move(drop, 3);
      await board.click(drop);
      const after = await fileAfter(board, before, 3000);
      const fresh = (await node.elementIds()).filter((id) => !known.has(id) && !id.endsWith("_label"));
      const box = fresh[0] ? await node.elementBox(fresh[0]) : null;
      const offset = box ? { x: centre(box).x - drop.x, y: centre(box).y - drop.y } : undefined;
      const names = (after.text.match(/ name="Check credit limit"/g) ?? []).length;
      part.paste = {
        editor: names === 2,
        board: boardActed(state, await boardState(session)),
        seen: await seen(session, "keydown"),
        pasted: names === 2,
        names,
        ...(box ? { underClick: contains(box, drop) } : {}),
        ...(offset
          ? {
              offset: { x: r1(offset.x), y: r1(offset.y) },
              offsetUnits: { x: r1(offset.x / session.env.unit), y: r1(offset.y / session.env.unit) },
            }
          : {}),
        detail: `${names} tasks named 'Check credit limit' in the file${offset ? `, the copy's middle ${pt(offset)} px from the click` : ""}`,
        numbers: offset ? `copy ${pt(offset)} px from the click` : "no copy",
      };
      await board.press("Escape");
    }
    {
      const state = await boardState(session);
      const lane = await lanePoint(session);
      if (lane) await board.click(lane);
      await seen(session, "keydown");
      await board.press("Control+a");
      await board.page.waitForTimeout(150);
      const [selected, elements] = [(await node.selected()).length, (await node.elementIds()).length];
      const pageText = await board.page.evaluate(() => (getSelection()?.toString() ?? "").length);
      part.selectAll = {
        editor: selected > 10,
        board: boardActed(state, await boardState(session)),
        seen: await seen(session, "keydown"),
        selected,
        elements,
        pageText,
        detail: `${selected} of ${elements} elements selected, ${pageText} characters of the page selected`,
        numbers: `${selected}/${elements} selected`,
      };
    }
  });
  // page 3: the arrow keys, on a diagram nothing was pasted into
  await onPage(ctx, "800x508", "keys-arrows", {}, part, async (session) => {
    const { board, node } = session;
    await listen(session, ["keydown"]);
    const mover = "Task_reject_order";
    const moverBlocked = await selectOnly(session, mover);
    if (moverBlocked !== "") skip("arrows", `${mover} ${moverBlocked}`);
    else {
      const state = await boardState(session);
      const fileBefore = await fileNow(board);
      const was = shapeBounds(fileBefore, mover);
      await seen(session, "keydown");
      const box0 = (await node.elementBox(mover))!;
      await board.press("ArrowRight");
      await board.page.waitForTimeout(120);
      const box1 = (await node.elementBox(mover))!;
      await board.press("Shift+ArrowDown");
      await board.page.waitForTimeout(120);
      const box2 = (await node.elementBox(mover))!;
      const after = await fileAfter(board, fileBefore, 3000);
      const stored = shapeBounds(after.text, mover);
      const matrix0 = await restingMatrix(session);
      const canvas = (await node.viewportMatrix())?.a ?? 1;
      await board.press("Control+ArrowRight");
      const matrix1 = await restingMatrix(session);
      const step = r2((box1.x - box0.x) / session.env.unit);
      const shiftStep = r2((box2.y - box1.y) / session.env.unit);
      const scroll = r1(matrix1.e - matrix0.e);
      // KeyboardMove: 50 canvas px, more below the editor's zoom 1; on screen that is times the chrome's scale
      const scrollExpected = r1((-50 / Math.min(Math.sqrt(canvas), 1)) * session.env.chrome);
      const fine =
        Math.abs(step - 1) <= 0.2 &&
        Math.abs(shiftStep - 10) <= 0.5 &&
        !!was &&
        stored?.x === was.x + 1 &&
        stored.y === was.y + 10 &&
        Math.abs(scroll - scrollExpected) <= Math.max(PX, Math.abs(scrollExpected) * 0.05);
      part.arrows = {
        editor: fine,
        board: boardActed(state, await boardState(session)),
        seen: await seen(session, "keydown"),
        step,
        shiftStep,
        stored,
        scroll,
        scrollExpected,
        numbers: `step ${step} u, with Shift ${shiftStep} u, scroll ${scroll} px (engine ${scrollExpected})`,
        detail: `ArrowRight moved the task ${step} units, Shift + ArrowDown ${shiftStep} units, the file has it at ${stored ? `${stored.x},${stored.y}` : "?"} (was ${was ? `${was.x},${was.y}` : "?"}); Control + ArrowRight scrolled the diagram ${scroll} px (the engine's step is ${scrollExpected} px here)`,
      };
    }
  });
  // page 4: the tool shortcuts, E and R, Escape, the search pad
  await onPage(ctx, "800x508", "keys-tools", {}, part, async (session) => {
    const { board, node } = session;
    await listen(session, ["keydown"]);
    const lane = await lanePoint(session);
    if (lane) await board.click(lane);
    {
      const state = await boardState(session);
      await seen(session, "keydown");
      const active: Record<string, string> = {};
      const cancelled: Record<string, boolean> = {};
      const tools = { h: "hand-tool", l: "lasso-tool", s: "space-tool", c: "global-connect-tool" } as const;
      for (const [key, tool] of Object.entries(tools)) {
        await board.press(key);
        await board.waitFor(async () => (await activeTools(node)).includes(tool), 1000);
        active[key] = (await activeTools(node)).join(",") || "none";
        await board.press("Escape");
        cancelled[key] = (await board.waitFor(async () => (await activeTools(node)).length === 0, 1000)) === true;
      }
      const fine = Object.entries(tools).every(([key, tool]) => active[key] === tool && cancelled[key] === true);
      part.tools = {
        editor: fine,
        board: boardActed(state, await boardState(session)),
        seen: await seen(session, "keydown"),
        active,
        cancelled,
        numbers: `${Object.entries(tools).filter(([key, tool]) => active[key] === tool).length}/4 tools`,
        detail: Object.keys(tools)
          .map((key) => `${key.toUpperCase()} ${active[key]}${cancelled[key] ? "" : " (Escape did not end it)"}`)
          .join(", "),
      };
    }
    const element = "Task_reject_order";
    const blocked = await selectOnly(session, element);
    if (blocked !== "") skip("editReplace", `${element} ${blocked}`);
    else {
      const state = await boardState(session);
      await seen(session, "keydown");
      await board.press("e");
      const editor = (await editorBox(session, 2000)) !== null;
      await board.press("Escape");
      await editorGone(session);
      await board.press("r");
      const popup = await popupBox(session, 2500);
      const pad = (await node.query(".djs-context-pad.open"))[0];
      const placement =
        popup && pad
          ? placementOf(
              { x: popup.x - pad.x, y: popup.y - (pad.y + pad.height) - 5 * session.env.chrome },
              popup,
              (await windowTop(node)).top,
              session.env.chrome,
            )
          : undefined;
      if (popup) await closePopup(session);
      // Escape with nothing open: the selection stays and the node stays armed
      await board.press("Escape");
      await board.page.waitForTimeout(100);
      const keeps = (await node.selected()).includes(element) && (await node.state()).armed;
      part.editReplace = {
        editor: editor && popup !== null,
        board: boardActed(state, await boardState(session)),
        seen: await seen(session, "keydown"),
        popup: popup !== null,
        ...(placement ? { popupPlacement: placement } : {}),
        escapeKeeps: keeps,
        numbers: `E ${editor ? "opens" : "no"}, R ${popup ? (placement ?? "opens") : "no"}`,
        detail: `E ${editor ? "opened" : "did not open"} the label editor, R ${popup ? `opened the replace menu (${placement ?? "?"})` : "did not open the replace menu"}, a further Escape ${keeps ? "kept" : "dropped"} the selection and the arming`,
      };
    }
    {
      const state = await boardState(session);
      // away from where the results list opens: a result under the pointer is preselected by the hover
      const corner = await session.node.hostBox();
      await board.move({ x: corner.x + corner.width * 0.9, y: corner.y + corner.height * 0.92 }, 2);
      await seen(session, "keydown");
      await board.press("Control+f");
      const box = await board.waitForBox(async () => (await node.query(".djs-search-container.open"))[0], 2500);
      const input = (await items(node, ".djs-search-container.open input"))[0];
      const inputHit = input ? (await probe(node, centre(input.box))).kind === "search" : false;
      const inputFocused = (await focusOf(session)).endsWith("search pad input");
      const shown = box ? await unclipped(node, ".djs-search-container.open") : null;
      if (box) await shot(session, "search", [box]);
      let results = 0;
      let selected: string[] = [];
      if (box) {
        await board.type("invoice");
        await board.waitFor(async () => (await node.query(".djs-search-result")).length > 0, 2000);
        results = (await node.query(".djs-search-result")).length;
        await board.press("Enter");
        await board.page.waitForTimeout(200);
        selected = await node.selected();
      }
      await board.press("Escape");
      const closed =
        (await board.waitFor(async () => (await node.query(".djs-search-container.open")).length === 0, 2000)) === true;
      const found = selected.includes("CallActivity_invoice_handling");
      part.search = {
        editor: box !== null && found,
        board: boardActed(state, await boardState(session)),
        seen: await seen(session, "keydown"),
        opened: box !== null,
        ...(box ? { box: rbox(box) } : {}),
        unclipped: shown,
        inputFocused,
        inputHit,
        results,
        selected,
        closed,
        numbers: box
          ? `pad ${size(box)} px, ${shown === null ? "?" : Math.round(shown * 100)} % unclipped, ${results} results`
          : "no pad",
        detail: `Control + F ${box ? `opened the search pad (${size(box)} px, ${shown === null ? "?" : Math.round(shown * 100)} % unclipped)` : "did not open the search pad"}, 'invoice' gave ${results} results, Enter selected ${selected.join(", ") || "nothing"}`,
      };
    }
  });
  return part;
}

const keyText = (did: string, expected: string, extra = ""): Text => ({
  did: `${did} Recorded the trusted keydown events the board page's document and the node's frame saw, and the board before and after (its nodes, its file, its viewport, the arming).`,
  expected: `${expected} The board does nothing: no board node is deleted or moved, the viewport stays, the node stays armed. The canvas svg has the focus after arming and bpmn-js listens for keys there.`,
  rule: `wrong-data when the board acted; broken when the editor did not act; ${extra}else ok. unmeasured when the element the key was to act on cannot be selected.`,
});
const KEY_TEXTS = {
  "key-delete-backspace": keyText(
    "Selected a task with a click and pressed Delete; selected another and pressed Backspace (one page).",
    "Each key removes the selected task from the file.",
  ),
  "key-undo-redo": keyText(
    "After the Backspace: Control + Z, Control + Y, Control + Z, Control + Shift + Z, reading the file after each.",
    "Undo brings the task back, each of the two redo chords removes it again.",
  ),
  "key-copy-paste": keyText(
    "Selected a task, pressed Control + C, moved the pointer to a free point of a lane, pressed Control + V, moved 6 px on and clicked.",
    "The file has a second task of that name, and the copy lies with its middle under the click, within what bpmn-js snaps a drop by (half a step of its 10 unit grid, and 10 px of its chrome to the lines of neighbours).",
    "broken also when the copy does not lie under the click at all; degraded when it does but further from the click than that snapping explains (5 units plus 10 px of the chrome plus 2 px); ",
  ),
  "key-select-all": keyText(
    "Clicked a lane and pressed Control + A.",
    "Every element of the diagram is selected and no text of the page is.",
    "degraded when text of the page got selected as well; ",
  ),
  "key-arrows": keyText(
    "Selected a task; ArrowRight, then Shift + ArrowDown, then Control + ArrowRight.",
    "The task moves 1 unit right and 10 units down (in the file too), and Control + ArrowRight scrolls the diagram by the engine's step.",
  ),
  "key-tools": keyText(
    "Clicked a lane, then pressed H, L, S and C in turn, each followed by Escape, and read the palette's highlighted tool after every key.",
    "H, L, S and C arm the hand, lasso, space and connect tool, Escape ends each.",
  ),
  "key-edit-replace": keyText(
    "Selected a task; E, Escape, R, Escape, and a further Escape.",
    "E opens the label editor and R the replace menu, Escape closes each, and an Escape with nothing open keeps the selection and the arming.",
    "degraded when the further Escape dropped the selection or disarmed the node; ",
  ),
  "key-search": keyText(
    "Pressed Control + F, typed 'invoice', pressed Enter, then Escape.",
    "The search pad opens inside the editor with the caret in its field, finds the call activity, Enter selects it, Escape closes the pad.",
    "degraded when the pad is clipped, its field cannot be hit or has not the focus, or Escape leaves it open; ",
  ),
} as const satisfies Record<string, Text>;

function keyRows(ctx: Ctx, part: KeysPart): Row[] {
  const judge = (
    steps: Array<[string, KeyStep | undefined]>,
    cost: (step: KeyStep) => string | { broken: string } = () => "",
  ): Sub[] =>
    steps.map(([label, step]): Sub => {
      if (!step) {
        const why = part.skipped?.[label] ?? (part.error ? `the page failed: ${part.error}` : "not reached");
        return { name: label, verdict: "unmeasured", why };
      }
      const short = `${step.editor ? "editor acted" : "editor did not act"}${step.numbers ? ` (${step.numbers})` : ""}, board ${step.board === "" ? "did nothing" : "ACTED"}, keydown ${seenText(step.seen)}`;
      if (step.board !== "")
        return { name: label, verdict: "wrong-data", why: `the board acted: ${step.board}`, short };
      if (!step.editor) return { name: label, verdict: "broken", why: step.detail, short };
      const price = cost(step);
      if (typeof price !== "string") return { name: label, verdict: "broken", why: price.broken, short };
      return price
        ? { name: label, verdict: "degraded", why: price, short }
        : { name: label, verdict: "ok", why: "", short };
    });
  const row = (name: keyof typeof KEY_TEXTS, subs: Sub[], measured: Record<string, unknown>): Row => ({
    case: name,
    notation: "bpmn",
    strategy: ctx.strategy,
    zoom: ctx.zoom,
    ...KEY_TEXTS[name],
    env: envRow(part.env),
    measured,
    ...fold(subs),
    problems: part.problems,
  });
  const unit = part.env?.unit ?? 1;
  return [
    row(
      "key-delete-backspace",
      judge([
        ["delete", part.delete],
        ["backspace", part.backspace],
      ]),
      { delete: part.delete, backspace: part.backspace },
    ),
    row("key-undo-redo", judge([["undoRedo", part.undoRedo]]), { undoRedo: part.undoRedo }),
    row(
      "key-copy-paste",
      judge([["paste", part.paste]], () => {
        const offset = part.paste?.offset;
        // bpmn-js snaps a dropped shape to its 10 unit grid and to the lines of its neighbours (10 px of its chrome)
        const slack = 5 * unit + 10 * (part.env?.chrome ?? 1) + PX;
        if (!offset || (Math.abs(offset.x) <= slack && Math.abs(offset.y) <= slack)) return "";
        const where = `the copy lies ${pt(offset)} px from the click (${pt(part.paste?.offsetUnits ?? offset)} units)`;
        return part.paste?.underClick === false ? { broken: `${where}: not under the pointer` } : where;
      }),
      { paste: part.paste },
    ),
    row(
      "key-select-all",
      judge([["selectAll", part.selectAll]], () =>
        (part.selectAll?.pageText ?? 0) > 0
          ? `${part.selectAll?.pageText} characters of the page were selected too`
          : "",
      ),
      { selectAll: part.selectAll },
    ),
    row("key-arrows", judge([["arrows", part.arrows]]), { arrows: part.arrows }),
    row("key-tools", judge([["tools", part.tools]]), { tools: part.tools }),
    row(
      "key-edit-replace",
      judge([["editReplace", part.editReplace]], () =>
        part.editReplace?.escapeKeeps === false ? "a further Escape dropped the selection or disarmed the node" : "",
      ),
      { editReplace: part.editReplace },
    ),
    row(
      "key-search",
      judge([["search", part.search]], () => {
        const search = part.search;
        const costs: string[] = [];
        if (search?.unclipped !== null && search?.unclipped !== undefined && search.unclipped < 0.98) {
          costs.push(`${Math.round((1 - search.unclipped) * 100)} % of the pad is clipped`);
        }
        if (search && !search.inputHit) costs.push("its field cannot be hit");
        if (search && !search.inputFocused) costs.push("its field has not the focus");
        if (search && !search.closed) costs.push("Escape left it open");
        return costs.join(", ");
      }),
      { search: part.search },
    ),
  ];
}

// ── plan: the wheel ──────────────────────────────────────────────────────────

interface WheelStep {
  /** how far the diagram moved on screen */
  moved: Point;
  scale: number;
  seen: Seen;
  board: string;
}

interface WheelPart extends PageResult {
  skipped?: string;
  plain?: WheelStep;
  shift?: WheelStep;
  control?: {
    steps: Array<{ delta: number; factor: number; pivot: Point }>;
    worstPivot: number;
    seen: Seen;
    board: string;
  };
  limits?: {
    /** screen px per diagram unit and the editor's own zoom at each end */
    max: { screen: number; canvas: number; further: number };
    min: { screen: number; canvas: number; further: number };
    seen: Seen;
    board: string;
    /** whether the node was still armed after the board was zoomed to half (armedzoom=disarm: it is not) */
    armedAfterBoardZoom?: boolean;
    /**
     * The editor's zoom after the board zoom, and what one step in and one step out do. With the
     * node still armed (armedzoom=free): at half the board zoom. After a disarm by rule: at the
     * board zoom the node was armed again at (`arm.rearmedAt`).
     */
    afterBoardZoom?: { boardZoom: number; canvas: number; screen: number; stepIn: number; stepOut: number };
    /** the armed node's rule for a board zoom, and what it did with the zoom to half */
    arm?: ZoomRuled & { rearmed?: boolean; rearmedAt?: Viewport };
  };
  unarmed?: {
    skipped?: string;
    node?: UnarmedStep;
    pane?: UnarmedStep;
    /** the armed node's rule for a board zoom (board.armPolicy): the verdict is judged by it */
    arm?: { armedzoom: ArmedZoom; armzoom: ArmZoom };
  };
}

/** what the arm rules counted over one zoom of the board under an armed node */
type ZoomCounts = Pick<
  ArmCounters,
  "disarmsBeforeZoom" | "disarmsAtTick" | "lateDisarms" | "armedZoomTicks" | "zoomsRefused"
>;
interface ZoomRuled {
  armedzoom: ArmedZoom;
  armzoom: ArmZoom;
  counts: ZoomCounts;
}
const countsSince = (before: ArmCounters, after: ArmCounters): ZoomCounts => ({
  disarmsBeforeZoom: after.disarmsBeforeZoom - before.disarmsBeforeZoom,
  disarmsAtTick: after.disarmsAtTick - before.disarmsAtTick,
  lateDisarms: after.lateDisarms - before.lateDisarms,
  armedZoomTicks: after.armedZoomTicks - before.armedZoomTicks,
  zoomsRefused: after.zoomsRefused - before.zoomsRefused,
});
/** the rule in effect for a node (the URL's or its strategy's default); a page without the hook is the board before the rules */
async function zoomRule(board: Board, id: string): Promise<{ armedzoom: ArmedZoom; armzoom: ArmZoom }> {
  const policy = await board.armPolicy(id);
  return { armedzoom: policy?.armedzoom ?? "free", armzoom: policy?.armzoom ?? "off" };
}
/**
 * Why a zoom of the board under an armed node was NOT the disarm armedzoom=disarm specifies, or
 * "": the node is a preview, exactly one disarm was counted, none of them late, and no zoom tick
 * passed under an armed node. `seenComing`: a wheel on the board, which the rule answers before
 * the first tick; a script's setViewport is met inside its first tick.
 */
function disarmFault(armed: boolean, counts: ZoomCounts, seenComing: boolean): { fault: string; late: boolean } {
  if (armed) return { fault: "the node stayed armed under the board zoom although armedzoom=disarm", late: true };
  if (counts.lateDisarms > 0 || counts.armedZoomTicks > 0) {
    return {
      fault: `the disarm came late: lateDisarms ${counts.lateDisarms}, armedZoomTicks ${counts.armedZoomTicks}`,
      late: true,
    };
  }
  const [wanted, other] = seenComing
    ? [counts.disarmsBeforeZoom, counts.disarmsAtTick]
    : [counts.disarmsAtTick, counts.disarmsBeforeZoom];
  return wanted === 1 && other === 0
    ? { fault: "", late: false }
    : {
        fault: `not one disarm ${seenComing ? "before the first zoom tick" : "inside the first zoom tick"}: disarmsBeforeZoom ${counts.disarmsBeforeZoom}, disarmsAtTick ${counts.disarmsAtTick}`,
        late: false,
      };
}

interface UnarmedStep {
  zoomBefore: number;
  zoomAfter: number;
  armed: boolean;
  follows: number;
  seen: Seen;
  /** armed when the wheel was sent, the counters over the step, and whether the node had to be armed again first */
  arm?: { armedBefore: boolean; rearmedFirst: boolean; counts: ZoomCounts };
}

async function wheelAt(session: Session, at: Point, deltaY: number, hold: readonly string[] = []): Promise<void> {
  await session.board.wheel(at, deltaY, { hold });
}

async function measureWheel(ctx: Ctx): Promise<WheelPart> {
  const part: WheelPart = { problems: [] };
  await onPage(ctx, "800x508", "wheel", {}, part, async (session) => {
    const { board, node } = session;
    await listen(session, ["wheel"]);
    const at = await lanePoint(session);
    if (!at) {
      part.skipped = "no free point of a lane to hold the pointer over";
      return;
    }
    // the editor binds its wheel listener on the canvas's mouseover
    await board.move({ x: at.x + 3, y: at.y + 2 }, 2);
    await board.move(at, 2);
    const one = async (hold: readonly string[]): Promise<WheelStep> => {
      const state = await boardState(session);
      const from = await restingMatrix(session);
      await seen(session, "wheel");
      await wheelAt(session, at, 100, hold);
      const to = await restingMatrix(session);
      return {
        moved: { x: r1(to.e - from.e), y: r1(to.f - from.f) },
        scale: r3(to.a / from.a),
        seen: await seen(session, "wheel"),
        board: boardActed(state, await boardState(session)),
      };
    };
    part.plain = await one([]);
    part.shift = await one(["Shift"]);
    {
      const state = await boardState(session);
      await seen(session, "wheel");
      const steps: Array<{ delta: number; factor: number; pivot: Point }> = [];
      for (const delta of [-100, -100, -100, 100, 100, 100]) {
        const from = await restingMatrix(session);
        // the diagram point under the pointer must still be under it afterwards
        const point = { x: (at.x - from.e) / from.a, y: (at.y - from.f) / from.a };
        await wheelAt(session, at, delta, ["Control"]);
        const to = await restingMatrix(session);
        steps.push({
          delta,
          factor: r3(to.a / from.a),
          pivot: { x: r1(to.a * point.x + to.e - at.x), y: r1(to.a * point.y + to.f - at.y) },
        });
      }
      part.control = {
        steps,
        worstPivot: r1(Math.max(...steps.map((step) => Math.hypot(step.pivot.x, step.pivot.y)))),
        seen: await seen(session, "wheel"),
        board: boardActed(state, await boardState(session)),
      };
    }
    {
      const state = await boardState(session);
      await seen(session, "wheel");
      const end = async (
        delta: number,
        times: number,
      ): Promise<{ screen: number; canvas: number; further: number }> => {
        for (let step = 0; step < times; step++) await wheelAt(session, at, delta, ["Control"]);
        const reached = await restingMatrix(session);
        const canvas = (await node.viewportMatrix())?.a ?? 0;
        await wheelAt(session, at, delta, ["Control"]);
        const further = await restingMatrix(session);
        return { screen: r3(reached.a), canvas: r3(canvas), further: r3(further.a / reached.a) };
      };
      const max = await end(-100, 45);
      const min = await end(100, 90);
      part.limits = {
        max,
        min,
        seen: await seen(session, "wheel"),
        board: boardActed(state, await boardState(session)),
      };
      // the board zooms out to half (of the zoom in effect) while the editor sits at its lower limit
      const half = session.env.zoom / 2;
      const rule = await zoomRule(board, session.id);
      const counted = (await board.counters()).arm;
      await board.showNode(session.id, half, ORIGIN);
      let rested = await restingMatrix(session);
      let canvas = (await node.viewportMatrix())?.a ?? 0;
      let boardZoom = half;
      // under armedzoom=disarm that board zoom made the node a preview: no editor is left to take a step
      part.limits.armedAfterBoardZoom = (await node.state()).armed;
      part.limits.arm = { ...rule, counts: countsSince(counted, (await board.counters()).arm) };
      if (rule.armedzoom === "disarm" && !part.limits.armedAfterBoardZoom) {
        // the case goes on: arm the node again first, which moves the board by its arm rule (armzoom).
        // The steps below are then the editor's first steps after a disarm by a board zoom
        await board.arm(session.id);
        part.limits.arm.rearmed = (await node.state()).armed;
        part.limits.arm.rearmedAt = await board.viewport();
        boardZoom = part.limits.arm.rearmedAt.zoom;
        rested = await restingMatrix(session);
        canvas = (await node.viewportMatrix())?.a ?? 0;
      }
      // the diagram is small now and may lie beside the pointer: any point of the canvas takes the wheel
      const again = (await node.state()).armed ? await lanePoint(session, true) : null;
      if (again) {
        await board.move({ x: again.x + 3, y: again.y + 2 }, 2);
        await board.move(again, 2);
        await wheelAt(session, again, -100, ["Control"]);
        const stepIn = await restingMatrix(session);
        await wheelAt(session, again, 100, ["Control"]);
        const stepOut = await restingMatrix(session);
        part.limits.afterBoardZoom = {
          boardZoom,
          canvas: r3(canvas),
          screen: r3(rested.a),
          stepIn: r3(stepIn.a / rested.a),
          stepOut: r3(stepOut.a / stepIn.a),
        };
      }
    }
  });
  // a second page: an unarmed node beside the armed one, and the pane
  const second: WheelPart = { problems: [] };
  await onPage(ctx, "800x508", "wheel-unarmed", { second: true }, second, async (session) => {
    const { board, node } = session;
    part.unarmed = {};
    // bring the left part of the second node into the window (at board zoom 2 it starts right of it)
    // a pan of the viewport in effect: another zoom than the one the node was armed at would disarm it
    const canvasBox = await board.canvasBox();
    const now = await board.viewport();
    const x = Math.min(now.x, canvasBox.width - 260 - 960 * now.zoom);
    await board.setViewport({ x, y: now.y, zoom: now.zoom });
    await restingMatrix(session);
    await listen(session, ["wheel"]);
    const other = await board.nodeBox("m-dmn");
    const over = other
      ? { x: Math.round(other.x + 120), y: Math.round(other.y + Math.min(200, other.height / 2)) }
      : null;
    const onOther =
      over &&
      (await board.page.evaluate(
        ([px, py]) => {
          const native = (window as NativeWindow).__boardSpikeNative;
          const top = native ? native.elementFromPoint(document, px, py) : document.elementFromPoint(px, py);
          return top?.closest('.react-flow__node[data-id="m-dmn"]') !== null && top !== null;
        },
        [over.x, over.y] as const,
      ));
    part.unarmed.arm = await zoomRule(board, session.id);
    const step = async (at: Point, rearmedFirst: boolean): Promise<UnarmedStep> => {
      const before = await board.viewport();
      const unitBefore = (await restingMatrix(session)).a / before.zoom;
      const armedBefore = (await node.state()).armed;
      const counted = (await board.counters()).arm;
      await seen(session, "wheel");
      await board.wheel(at, -100);
      await board.waitFor(async () => (await board.viewport()).zoom !== before.zoom, 2000);
      await board.page.waitForTimeout(120);
      const after = await board.viewport();
      const unitAfter = (await restingMatrix(session)).a / after.zoom;
      return {
        zoomBefore: r3(before.zoom),
        zoomAfter: r3(after.zoom),
        armed: (await node.state()).armed,
        // the node's diagram against the board: 1 means it took the board's zoom step exactly
        follows: r3(unitAfter / unitBefore),
        seen: await seen(session, "wheel"),
        arm: { armedBefore, rearmedFirst, counts: countsSince(counted, (await board.counters()).arm) },
      };
    };
    if (over && onOther) part.unarmed.node = await step(over, false);
    else part.unarmed.skipped = "no point of the unarmed node is in the window";
    // armedzoom=disarm: the first wheel made the node a preview by rule. The second step is about an
    // ARMED node too, so the node is armed again first (the board moves by its arm rule) and the
    // pane point is searched on the board as it stands then
    let rearmedFirst = false;
    if (part.unarmed.arm.armedzoom === "disarm" && !(await node.state()).armed) {
      await board.arm(session.id);
      await restingMatrix(session);
      rearmedFirst = (await node.state()).armed;
    }
    const pane = await board.freePanePoint();
    if (pane) part.unarmed.pane = await step(pane, rearmedFirst);
    else part.unarmed.skipped = `${part.unarmed.skipped ? `${part.unarmed.skipped}; ` : ""}no free point of the pane`;
  });
  part.problems.push(...second.problems);
  if (second.error) part.error = part.error ? `${part.error}; ${second.error}` : second.error;
  return part;
}

const WHEEL_TEXTS = {
  "wheel-plain": {
    did: "With the pointer over a free point of a lane: one wheel step of deltaY 100. Read the diagram's place on screen before and after (the browser's matrix), the wheel events each document saw, and the board.",
    expected:
      "The diagram scrolls up by what the baseline scrolls (overlay strategy, board zoom 1: diagram-js moves it 0.75 container px per delta unit), the board's viewport stays. The armed body carries the class that keeps React Flow's wheel off.",
    rule: "wrong-data when the board's viewport changed or the node was disarmed; broken when the diagram did not scroll; degraded when it scrolled another distance than the baseline by more than 5 %; else ok.",
  },
  "wheel-shift": {
    did: "As wheel-plain, with Shift held.",
    expected: "The diagram scrolls left by the baseline's distance, the board stays.",
    rule: "as wheel-plain, along x.",
  },
  "wheel-ctrl": {
    did: "With the pointer at the same point: three Control + wheel steps in and three out, reading the matrix after each.",
    expected:
      "The diagram zooms by one engine step per wheel step and the diagram point under the pointer stays under it. diagram-js takes the pivot from the pointer's client position minus the container's client rectangle.",
    rule: `wrong-data when the board's viewport changed; broken when the diagram did not zoom; degraded when the point under the pointer moved by more than 1.5 px in a step; else ok.`,
  },
  "wheel-limits": {
    did: "45 Control + wheel steps in and one more, 90 out and one more; then the board was zoomed to half its zoom with the editor at its lower limit, followed by one step in and one step out.",
    expected:
      "At each end a further step changes nothing and nothing reaches the board. After the board zoomed, a step in is one engine step (factor about 1.16) and a step out does nothing or is one step: no jump. The engine's range is 0.2 to 4 of its own zoom.",
    rule: "wrong-data when the board's viewport changed during the wheel steps; degraded when a further step at an end still zooms, or the first step after the board zoom changes the scale by more than a factor 1.3 (a jump); else ok.",
  },
  "wheel-unarmed": {
    did: "With a node armed: one wheel step over the unarmed node beside it, then one over the bare pane (the viewport was shifted first so that the second node is in the window).",
    expected:
      "The board zooms both times (React Flow's own wheel zoom), the armed node stays armed, and its diagram takes the board's zoom step exactly (ratio 1).",
    rule: "broken when the board did not zoom or the node was disarmed; degraded when the armed editor's diagram is more than 1 % off the board's zoom step afterwards; else ok.",
  },
} as const satisfies Record<string, Text>;

/**
 * The two cases that zoom the board under an armed node, as armedzoom=disarm specifies them (read
 * per node through board.armPolicy). The texts above are the rule for armedzoom=free and stay as
 * they were written before the arm rules.
 */
const WHEEL_TEXTS_DISARM = {
  "wheel-limits": {
    did: "45 Control + wheel steps in and one more, 90 out and one more; then a script zoomed the board to half its zoom with the editor at its lower limit, which disarms the node by rule. The node was armed again through the hook (the board moves by its arm rule), followed by one step in and one step out.",
    expected:
      "At each end a further step changes nothing and nothing reaches the board. armedzoom=disarm is in effect for the node (board.armPolicy): the script's board zoom makes it a preview inside the zoom's first tick, counted once there, never late, with no zoom tick under an armed node. Armed again, a step in is one engine step (factor about 1.16) and a step out does nothing or is one step: no jump. The engine's range is 0.2 to 4 of its own zoom.",
    rule: "wrong-data when the board's viewport changed during the wheel steps; broken when the node stayed armed under the board zoom, the disarm was late (lateDisarms or armedZoomTicks above 0) or the node did not arm again; degraded when a further step at an end still zooms, the disarm was not counted exactly once inside the first tick, or the first step after arming again changes the scale by more than a factor 1.3 (a jump); else ok.",
  },
  "wheel-unarmed": {
    did: "With a node armed: one wheel step over the unarmed node beside it (the viewport was shifted first so that the second node is in the window). That wheel disarms the node by rule, so it was armed again through the hook (the board moves by its arm rule); then one wheel step over the bare pane. The arm rules' counters were read around each step.",
    expected:
      "armedzoom=disarm is in effect for the node (board.armPolicy): the board zooms both times (React Flow's own wheel zoom) and the armed node is a preview BEFORE the first zoom tick, so no armed editor sees a zoom step: one disarm counted before the zoom, none inside a tick, none late, no zoom tick under an armed node. The preview's diagram then takes the board's zoom step exactly (ratio 1). Nothing is typed and no popup is open in this case.",
    rule: "broken when the board did not zoom, the node stayed armed, or the disarm was late (lateDisarms or armedZoomTicks above 0); degraded when the disarm was not counted exactly once before the first tick, or the node's diagram is more than 1 % off the board's zoom step afterwards; unmeasured when the node was not armed when the wheel was sent; else ok.",
  },
} as const satisfies Partial<Record<keyof typeof WHEEL_TEXTS, Text>>;

const countsText = (counts: ZoomCounts): string =>
  `disarms before the zoom ${counts.disarmsBeforeZoom}, in its first tick ${counts.disarmsAtTick}, late ${counts.lateDisarms}, armed zoom ticks ${counts.armedZoomTicks}`;

function wheelRows(ctx: Ctx, part: WheelPart, base: WheelPart | undefined): Row[] {
  const stop = (name: string): Sub | undefined =>
    part.skipped
      ? { name, verdict: "unmeasured", why: part.skipped }
      : part.error
        ? { name, verdict: "unmeasured", why: `the page failed: ${part.error}` }
        : undefined;
  const scroll = (
    name: string,
    step: WheelStep | undefined,
    reference: WheelStep | undefined,
    axis: "x" | "y",
  ): Sub => {
    if (!step) return stop(name) ?? { name, verdict: "unmeasured", why: "not reached" };
    const short = `moved ${pt(step.moved)} px (baseline ${reference ? pt(reference.moved) : "?"}), wheel ${seenText(step.seen)}`;
    if (step.board !== "") return { name, verdict: "wrong-data", why: `the board acted: ${step.board}`, short };
    if (Math.abs(step.moved[axis]) < 1) return { name, verdict: "broken", why: "the diagram did not scroll", short };
    const ratio = reference && reference.moved[axis] !== 0 ? step.moved[axis] / reference.moved[axis] : 1;
    return Math.abs(ratio - 1) > 0.05
      ? { name, verdict: "degraded", why: `scrolls ${r2(ratio)} of the baseline's distance per wheel step`, short }
      : { name, verdict: "ok", why: "", short };
  };
  const control = ((): Sub => {
    const name = "zoom";
    const data = part.control;
    if (!data) return stop(name) ?? { name, verdict: "unmeasured", why: "not reached" };
    const factors = data.steps.map((step) => step.factor);
    const short = `pivot error up to ${data.worstPivot} px, factors ${factors.join(" ")}, wheel ${seenText(data.seen)}`;
    if (data.board !== "") return { name, verdict: "wrong-data", why: `the board acted: ${data.board}`, short };
    if (factors.every((factor) => Math.abs(factor - 1) < 0.01))
      return { name, verdict: "broken", why: "the diagram did not zoom", short };
    return data.worstPivot > 1.5
      ? {
          name,
          verdict: "degraded",
          why: `the point under the pointer moved up to ${data.worstPivot} px per step`,
          short,
        }
      : { name, verdict: "ok", why: "", short };
  })();
  const limits = ((): Sub => {
    const name = "limits";
    const data = part.limits;
    if (!data) return stop(name) ?? { name, verdict: "unmeasured", why: "not reached" };
    const after = data.afterBoardZoom;
    // armedzoom=disarm: the board zoom made the node a preview by rule, and it was armed again
    const ruled = data.arm?.armedzoom === "disarm" ? data.arm : undefined;
    const steps = after ? `editor zoom ${after.canvas}, step in x${after.stepIn}, out x${after.stepOut}` : "";
    const short =
      `on screen ${data.min.screen} to ${data.max.screen} px per unit (editor zoom ${data.min.canvas} to ${data.max.canvas}), ` +
      (ruled
        ? `the board zoom disarmed by rule (${countsText(ruled.counts)}), ` +
          (after ? `armed again at board zoom ${r3(after.boardZoom)}: ${steps}` : "no step after arming again")
        : after
          ? `after board zoom ${r3(after.boardZoom)}: ${steps}`
          : data.armedAfterBoardZoom === false
            ? "the board zoom disarmed the node: no step after it"
            : "no step after the board zoom");
    if (data.board !== "") return { name, verdict: "wrong-data", why: `the board acted: ${data.board}`, short };
    const costs: string[] = [];
    if (ruled) {
      // a script's zoom is not seen coming: the rule answers inside its first tick
      const { fault, late } = disarmFault(data.armedAfterBoardZoom === true, ruled.counts, false);
      if (late) return { name, verdict: "broken", why: fault, short };
      if (ruled.rearmed !== true)
        return { name, verdict: "broken", why: "the node did not arm again after the disarm", short };
      if (fault) costs.push(fault);
    }
    const when = ruled ? "after the disarm and arming again" : "after the board zoomed out";
    if (Math.abs(data.max.further - 1) > 0.01)
      costs.push(`a step beyond the upper end still zooms (x${data.max.further})`);
    if (Math.abs(data.min.further - 1) > 0.01)
      costs.push(`a step beyond the lower end still zooms (x${data.min.further})`);
    if (after && (after.stepIn > 1.3 || after.stepIn < 0.99))
      costs.push(`${when}, one step in changes the scale x${after.stepIn}`);
    if (after && (after.stepOut < 1 / 1.3 || after.stepOut > 1.01))
      costs.push(`${when}, one step out changes the scale x${after.stepOut}`);
    return costs.length > 0
      ? { name, verdict: "degraded", why: costs.join(", "), short }
      : { name, verdict: "ok", why: "", short };
  })();
  const unarmed = (["node", "pane"] as const).map((where): Sub => {
    const name = where === "node" ? "unarmed node" : "pane";
    const data = part.unarmed?.[where];
    if (!data)
      return {
        name,
        verdict: "unmeasured",
        why: part.unarmed?.skipped ?? (part.error ? `the page failed: ${part.error}` : "not reached"),
      };
    if (part.unarmed?.arm?.armedzoom === "disarm" && data.arm) {
      // the specified behaviour under armedzoom=disarm: a preview before the first zoom tick
      const { counts, armedBefore, rearmedFirst } = data.arm;
      const short =
        `board zoom ${data.zoomBefore} -> ${data.zoomAfter}, ${rearmedFirst ? "armed again first, " : ""}` +
        `${data.armed ? "still armed" : "disarmed by rule"} (${countsText(counts)}), ` +
        `diagram follows x${data.follows}, wheel ${seenText(data.seen)}`;
      if (!armedBefore)
        return { name, verdict: "unmeasured", why: "the node was not armed when the wheel was sent", short };
      if (data.zoomAfter === data.zoomBefore) return { name, verdict: "broken", why: "the board did not zoom", short };
      const { fault, late } = disarmFault(data.armed, counts, true);
      if (late) return { name, verdict: "broken", why: fault, short };
      if (fault) return { name, verdict: "degraded", why: fault, short };
      return Math.abs(data.follows - 1) > 0.01
        ? {
            name,
            verdict: "degraded",
            why: `the preview's diagram is x${data.follows} of the board's zoom step`,
            short,
          }
        : { name, verdict: "ok", why: "", short };
    }
    const short = `board zoom ${data.zoomBefore} -> ${data.zoomAfter}, editor follows x${data.follows}, wheel ${seenText(data.seen)}`;
    if (data.zoomAfter === data.zoomBefore) return { name, verdict: "broken", why: "the board did not zoom", short };
    if (!data.armed) return { name, verdict: "broken", why: "the node was disarmed", short };
    return Math.abs(data.follows - 1) > 0.01
      ? {
          name,
          verdict: "degraded",
          why: `the armed editor's diagram is x${data.follows} of the board's zoom step`,
          short,
        }
      : { name, verdict: "ok", why: "", short };
  });
  /** the texts of a case by the rule the armed node ran under */
  const texts = (name: keyof typeof WHEEL_TEXTS): Text =>
    name === "wheel-limits" && part.limits?.arm?.armedzoom === "disarm"
      ? WHEEL_TEXTS_DISARM["wheel-limits"]
      : name === "wheel-unarmed" && part.unarmed?.arm?.armedzoom === "disarm"
        ? WHEEL_TEXTS_DISARM["wheel-unarmed"]
        : WHEEL_TEXTS[name];
  const row = (name: keyof typeof WHEEL_TEXTS, subs: Sub[], measured: Record<string, unknown>): Row => ({
    case: name,
    notation: "bpmn",
    strategy: ctx.strategy,
    zoom: ctx.zoom,
    ...texts(name),
    env: envRow(part.env),
    measured,
    ...fold(subs),
    problems: part.problems,
  });
  return [
    row("wheel-plain", [scroll("scroll", part.plain, base?.plain, "y")], {
      plain: part.plain,
      baseline: base?.plain?.moved,
    }),
    row("wheel-shift", [scroll("scroll", part.shift, base?.shift, "x")], {
      shift: part.shift,
      baseline: base?.shift?.moved,
    }),
    row("wheel-ctrl", [control], { control: part.control }),
    row("wheel-limits", [limits], { limits: part.limits }),
    row("wheel-unarmed", unarmed, { unarmed: part.unarmed }),
  ];
}

// ── plan: focus ──────────────────────────────────────────────────────────────

interface FocusStep {
  /** document.activeElement of the board page, and of the frame after " > ", once it rests */
  active: string;
  armed: boolean;
  /** the L key armed the editor's lasso tool: the key went to the editor */
  editorTookKey: boolean;
  seen: Seen;
  note?: string;
  /** closing by key: how long the focus was away from the canvas, and where */
  gap?: FocusGap | null;
}

interface FocusPart extends PageResult {
  steps: Record<string, FocusStep | undefined>;
  notes: string[];
}

/** where the next key goes: presses L (the lasso tool's shortcut), reads the palette, ends the tool again */
async function nextKey(session: Session): Promise<Omit<FocusStep, "active" | "armed">> {
  const { board, node } = session;
  await seen(session, "keydown");
  await board.press("l");
  const took = (await board.waitFor(async () => (await activeTools(node)).includes("lasso-tool"), 800)) === true;
  const events = await seen(session, "keydown");
  if (took) {
    await board.press("Escape");
    await board.waitFor(async () => (await activeTools(node)).length === 0, 800);
  }
  return { editorTookKey: took, seen: events };
}

async function focusStep(session: Session, note?: string): Promise<FocusStep> {
  // diagram-js hands the canvas the focus one task after a popup or an editor closed: read it at rest
  let active = await focusOf(session);
  for (let rested = 0, tries = 0; rested < 2 && tries < 8; tries++) {
    await session.board.page.waitForTimeout(50);
    const now = await focusOf(session);
    rested = now === active ? rested + 1 : 0;
    active = now;
  }
  const armed = (await session.node.state()).armed;
  return { active, armed, ...(await nextKey(session)), ...(note ? { note } : {}) };
}

const centreOf = (board: Board, selector: string): Promise<Point | null> =>
  board.page.evaluate((query) => {
    const element = document.querySelector(query);
    if (!element) return null;
    const native = (window as NativeWindow).__boardSpikeNative;
    const rect = native ? native.rect(element) : element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, selector);

async function measureFocus(ctx: Ctx): Promise<FocusPart> {
  const part: FocusPart = { steps: {}, notes: [], problems: [] };
  return onPage(ctx, "800x508", "focus", { arm: false }, part, async (session) => {
    const { board, node } = session;
    const { steps } = part;
    await listen(session, ["keydown"]);
    const wrapper = `.react-flow__node[data-id="${session.id}"]`;
    // 1. arming as a person does: a double-click on the preview
    const host = await node.hostBox();
    await board.doubleClick({ x: Math.round(host.x + host.width * 0.6), y: Math.round(host.y + host.height * 0.55) });
    await board.waitFor(async () => (await node.state()).armed, 2000);
    await board.page.waitForTimeout(300);
    session.env = await envOf(board, node);
    part.env = session.env;
    steps.armByDoubleClick = await focusStep(session);
    if (!steps.armByDoubleClick.armed) {
      part.notes.push("the double-click did not arm the node: armed through the hook instead");
      await board.arm(session.id);
    }
    // 2. a popup menu closes: by Escape, and by choosing an entry
    const picked = await selectFirst(session, ["Task_fulfill_order", "Task_check_credit", "Task_reject_order"]);
    if (picked.element) {
      const opened = await openPopup(session, "replace", "r");
      if (opened.box && !opened.note) {
        const inPopup = await focusOf(session);
        await node.inDocument(GAP_ARM);
        await closePopup(session);
        steps.popupEscape = {
          ...(await focusStep(session, `while open: ${inPopup}`)),
          gap: await node.scope.evaluate(GAP_READ),
        };
        const again = await openPopup(session, "replace", "r");
        const entry = again.box
          ? (await items(node, ".djs-popup .entry")).find((one) => one.id === "replace-with-service-task")
          : undefined;
        const at = entry ? aimAt(await node.map(), centre(entry.box)) : undefined;
        const hit = at ? await probe(node, at) : undefined;
        if (at && hit?.reachable && hit.kind === "popup" && hit.entry === "replace-with-service-task") {
          await board.click(at);
          await board.waitFor(async () => (await node.query(".djs-popup")).length === 0, 1000);
          await board.page.waitForTimeout(150);
          steps.popupChoose = await focusStep(session);
        } else {
          part.notes.push("popupChoose: the entry to choose cannot be hit, chosen with Enter instead");
          if (again.box) {
            await board.press("Enter");
            await board.waitFor(async () => (await node.query(".djs-popup")).length === 0, 1000);
            await board.page.waitForTimeout(150);
            steps.popupChoose = await focusStep(session, "chosen with Enter");
          }
        }
      } else part.notes.push(`popup: ${opened.note ?? `not opened (${opened.openerWhat})`}`);
    } else part.notes.push(`popup: no task can be selected (${picked.passed.join("; ")})`);
    // 3. a label editor closes: by Escape, and by Enter
    let labelled: string | undefined;
    for (const candidate of ["Task_check_credit", "Task_reject_order", "CallActivity_invoice_handling"]) {
      if (!("blocked" in (await pointOn(session, candidate)))) {
        labelled = candidate;
        break;
      }
    }
    if (labelled && (await openByDoubleClick(session, labelled))) {
      const inEditor = await focusOf(session);
      await node.inDocument(GAP_ARM);
      await board.press("Escape");
      await editorGone(session);
      steps.labelEscape = {
        ...(await focusStep(session, `while open: ${inEditor}`)),
        gap: await node.scope.evaluate(GAP_READ),
      };
      if (await openByDoubleClick(session, labelled)) {
        await board.press("Enter");
        await editorGone(session);
        steps.labelEnter = await focusStep(session);
      }
    } else part.notes.push("label: the editor could not be opened");
    // 4. a click on the board while armed: the node's own header, then back into the canvas
    const title = await centreOf(board, `${wrapper} .board-node__title`);
    if (title) {
      await board.click(title);
      await board.page.waitForTimeout(150);
      steps.headerClick = await focusStep(session);
      const lane = await lanePoint(session);
      if (lane) {
        await board.click(lane);
        await board.page.waitForTimeout(150);
        steps.backInCanvas = await focusStep(session);
      }
    }
    // 5. disarming: a click on the pane, the Done button, the hook
    const pane = await board.freePanePoint();
    if (pane) {
      await board.click(pane);
      await board.waitFor(async () => !(await node.state()).armed, 1000);
      await board.page.waitForTimeout(200);
      steps.disarmByPane = await focusStep(session);
    }
    const button = await centreOf(board, `${wrapper} .board-node__arm`);
    if (button) {
      // Edit arms, Done disarms: the same button
      if (!(await node.state()).armed) {
        await board.click(button);
        await board.waitFor(async () => (await node.state()).armed, 2000);
        await board.page.waitForTimeout(300);
        steps.armByButton = await focusStep(session);
      }
      await board.click(button);
      await board.waitFor(async () => !(await node.state()).armed, 1000);
      await board.page.waitForTimeout(200);
      steps.disarmByButton = await focusStep(session);
    }
    await board.arm(session.id);
    steps.armByHook = await focusStep(session);
    await board.arm(null);
    await board.page.waitForTimeout(200);
    steps.disarmByHook = await focusStep(session);
  });
}

const FOCUS_TEXTS = {
  "focus-arm": {
    did: "Armed the node three ways on one page (a double-click on its preview, its Edit button, the test hook), each time read document.activeElement of the board page (and of the frame) and pressed L: the lasso tool's shortcut shows in the palette when the key reached the editor.",
    expected:
      "After arming, the editor's canvas has the focus and the next key is the editor's. The strategy's surface hands the canvas the focus when it arms.",
    rule: "per way: broken when the node did not arm; degraded when it armed but the next key did not reach the editor; else ok.",
  },
  "focus-popup": {
    did: "Opened the replace menu, closed it with Escape, read the focus and pressed L; opened it again, chose an entry with a click, read the focus and pressed L.",
    expected:
      "While open the menu's search field has the focus; after it closes, either way, the canvas has it again and the next key is the editor's. diagram-js restores the canvas focus when a popup closes.",
    rule: "per way of closing: degraded when the next key did not reach the editor or the node was disarmed; else ok.",
  },
  "focus-label": {
    did: "Opened a task's label editor with a double-click, closed it with Escape, read the focus and pressed L; again, closed with Enter.",
    expected: "After the editor closes the canvas has the focus and the next key is the editor's, not text in a label.",
    rule: "per way of closing: degraded when the next key did not reach the editor; else ok.",
  },
  "focus-board-click": {
    did: "While armed: clicked the node's own header (the board), read the focus and pressed L; then clicked a free point of a lane and pressed L again.",
    expected:
      "The click on the board moves the focus out of the editor and leaves the node armed: the key goes to the board page's document and the editor does not act. After the click into the canvas the editor has the keys again.",
    rule: "wrong-data when the editor acted on the key after the click on the board; degraded when the header click disarmed the node or the key after the click into the canvas did not reach the editor; else ok.",
  },
  "focus-disarm": {
    did: "Disarmed three ways (a click on the bare pane, the Done button, the test hook), each time read the focus and pressed L.",
    expected:
      "After disarming nothing inside the editor has the focus, the key is seen by the board page's document only, and the editor does not act.",
    rule: "per way: wrong-data when the editor acted on the key; degraded when the key was seen inside the node's frame or the node stayed armed; else ok.",
  },
} as const satisfies Record<string, Text>;

function focusRows(ctx: Ctx, part: FocusPart): Row[] {
  const missing = (name: string): Sub => ({
    name,
    verdict: "unmeasured",
    why: part.error
      ? `the page failed: ${part.error}`
      : (part.notes.find((note) => note.startsWith(name.split(" ")[0]!)) ?? "not reached"),
  });
  const short = (step: FocusStep): string =>
    `focus ${step.active}; L ${step.editorTookKey ? "reached the editor" : "did not reach the editor"}; keydown ${seenText(step.seen)}` +
    (step.gap ? `; focus on ${step.gap.meanwhile} right after the closing key` : "");
  const inEditor = (name: string, step: FocusStep | undefined, mustArm: boolean): Sub => {
    if (!step) return missing(name);
    if (mustArm && !step.armed) return { name, verdict: "broken", why: "the node did not arm", short: short(step) };
    if (!step.armed) return { name, verdict: "degraded", why: "the node was disarmed", short: short(step) };
    return step.editorTookKey
      ? { name, verdict: "ok", why: "", short: short(step) }
      : {
          name,
          verdict: "degraded",
          why: `the next key did not reach the editor (focus: ${step.active})`,
          short: short(step),
        };
  };
  const outside = (name: string, step: FocusStep | undefined): Sub => {
    if (!step) return missing(name);
    if (step.editorTookKey)
      return { name, verdict: "wrong-data", why: "the disarmed editor acted on the key", short: short(step) };
    if (step.armed) return { name, verdict: "degraded", why: "the node stayed armed", short: short(step) };
    return step.seen.frame > 0
      ? { name, verdict: "degraded", why: "the key was seen inside the node's frame", short: short(step) }
      : { name, verdict: "ok", why: "", short: short(step) };
  };
  const { steps } = part;
  const boardClick = ((): Sub[] => {
    const header = steps.headerClick;
    const back = steps.backInCanvas;
    const first: Sub = !header
      ? missing("header")
      : header.editorTookKey
        ? {
            name: "header",
            verdict: "wrong-data",
            why: "the editor acted on a key typed after a click on the board",
            short: short(header),
          }
        : !header.armed
          ? {
              name: "header",
              verdict: "degraded",
              why: "the click on the node's header disarmed it",
              short: short(header),
            }
          : { name: "header", verdict: "ok", why: "", short: short(header) };
    return [first, inEditor("back in canvas", back, false)];
  })();
  const row = (name: keyof typeof FOCUS_TEXTS, subs: Sub[], measured: Record<string, unknown>): Row => ({
    case: name,
    notation: "bpmn",
    strategy: ctx.strategy,
    zoom: ctx.zoom,
    ...FOCUS_TEXTS[name],
    env: envRow(part.env),
    measured: { ...measured, notes: part.notes },
    ...fold(subs),
    problems: part.problems,
  });
  return [
    row(
      "focus-arm",
      [
        inEditor("double-click", steps.armByDoubleClick, true),
        inEditor("button", steps.armByButton, true),
        inEditor("hook", steps.armByHook, true),
      ],
      { doubleClick: steps.armByDoubleClick, button: steps.armByButton, hook: steps.armByHook },
    ),
    row("focus-popup", [inEditor("Escape", steps.popupEscape, false), inEditor("choose", steps.popupChoose, false)], {
      escape: steps.popupEscape,
      choose: steps.popupChoose,
    }),
    row("focus-label", [inEditor("Escape", steps.labelEscape, false), inEditor("Enter", steps.labelEnter, false)], {
      escape: steps.labelEscape,
      enter: steps.labelEnter,
    }),
    row("focus-board-click", boardClick, { header: steps.headerClick, backInCanvas: steps.backInCanvas }),
    row(
      "focus-disarm",
      [
        outside("pane", steps.disarmByPane),
        outside("button", steps.disarmByButton),
        outside("hook", steps.disarmByHook),
      ],
      { pane: steps.disarmByPane, button: steps.disarmByButton, hook: steps.disarmByHook },
    ),
  ];
}

// ── plan: Tab order (nice to have) ───────────────────────────────────────────

interface TabPart extends PageResult {
  forward: string[];
  backward: string[];
  armedAfter?: boolean;
}

async function measureTab(ctx: Ctx): Promise<TabPart> {
  const part: TabPart = { forward: [], backward: [], problems: [] };
  return onPage(ctx, "800x508", "tab", {}, part, async (session) => {
    const { board } = session;
    for (let press = 0; press < 8; press++) {
      await board.press("Tab");
      part.forward.push(await focusOf(session));
    }
    await board.arm(null);
    await board.arm(session.id);
    for (let press = 0; press < 4; press++) {
      await board.press("Shift+Tab");
      part.backward.push(await focusOf(session));
    }
    part.armedAfter = (await session.node.state()).armed;
  });
}

const TAB_TEXT: Text = {
  did: "Armed the node (focus on the canvas), pressed Tab eight times and read the active element after each; armed again and pressed Shift + Tab four times.",
  expected:
    "No product decision exists for this, so the row describes: where Tab goes from the canvas, after how many presses the focus has left the editor, and whether it can leave at all.",
  rule: "ok when the focus leaves the editor within eight Tab presses and within four Shift + Tab presses; degraded when it stays inside in one direction (a keyboard trap); unmeasured when the page failed.",
};

function tabRows(ctx: Ctx, part: TabPart): Row[] {
  const inside = (active: string): boolean => {
    const inner = active.includes(" > ") ? active.split(" > ")[1]! : active;
    const top = active.split(" > ")[0]!;
    if (active.includes(" > ")) return top.startsWith("iframe") && inner !== "body" && inner !== "none";
    return /^(canvas svg|label editor|popup search input|search pad input|div\.entry|button\.entry|a\.bjs|div\.djs|input)/.test(
      top,
    );
  };
  const leaves = (sequence: string[]): number => sequence.findIndex((active) => !inside(active)) + 1;
  const [forward, backward] = [leaves(part.forward), leaves(part.backward)];
  const sub: Sub = part.error
    ? { name: "tab", verdict: "unmeasured", why: `the page failed: ${part.error}` }
    : {
        name: "tab",
        verdict: forward > 0 && backward > 0 ? "ok" : "degraded",
        why:
          forward > 0 && backward > 0
            ? ""
            : `the focus stays inside the editor ${forward === 0 ? "over eight Tab presses" : ""}${forward === 0 && backward === 0 ? " and " : ""}${backward === 0 ? "over four Shift + Tab presses" : ""}`,
        short: `Tab leaves after ${forward || "more than 8"}, Shift + Tab after ${backward || "more than 4"}; Tab: ${part.forward.slice(0, 4).join(" , ")}; Shift + Tab: ${part.backward.slice(0, 2).join(" , ")}`,
      };
  return [
    {
      case: "tab-order",
      notation: "bpmn",
      strategy: ctx.strategy,
      zoom: ctx.zoom,
      ...TAB_TEXT,
      env: envRow(part.env),
      measured: {
        forward: part.forward,
        backward: part.backward,
        leavesAfterTab: forward,
        leavesAfterShiftTab: backward,
        armedAfter: part.armedAfter,
      },
      ...fold([sub]),
      cell: sub.short ?? sub.why,
      problems: part.problems,
    },
  ];
}

// ── the plans ────────────────────────────────────────────────────────────────

/** one unit of work per strategy x zoom: `measure` reads the page, `rows` judges against the baseline's parts */
interface Plan {
  name: string;
  /** the case names of the rows it writes */
  cases: readonly string[];
  /** board zooms it measures besides ZOOMS */
  extraZooms?: readonly number[];
  measure(ctx: Ctx): Promise<unknown>;
  rows(ctx: Ctx, parts: unknown, base: unknown): Row[];
}

function plan<P>(definition: {
  name: string;
  cases: readonly string[];
  extraZooms?: readonly number[];
  measure(ctx: Ctx): Promise<P>;
  rows(ctx: Ctx, parts: P, base: P | undefined): Row[];
}): Plan {
  return {
    ...definition,
    rows: (ctx, parts, base) => definition.rows(ctx, parts as P, base as P | undefined),
  };
}

const PLANS: readonly Plan[] = [
  ...BOTH_SIZES.map((sizeOf) =>
    plan<TourParts>({
      name: `tour-${sizeOf}`,
      cases: [`pad@${sizeOf}`, `popup-replace@${sizeOf}`, `popup-colour@${sizeOf}`],
      measure: (ctx) => measureTour(ctx, sizeOf),
      rows: (ctx, parts, base) => tourRows(ctx, sizeOf, parts, base),
    }),
  ),
  plan<AlignPart>({ name: "align", cases: ["popup-align"], measure: measureAlign, rows: alignRows }),
  ...BOTH_SIZES.map((sizeOf) =>
    plan<PalettePart>({
      name: `palette-${sizeOf}`,
      cases: [`palette@${sizeOf}`],
      measure: (ctx) => measurePalette(ctx, sizeOf),
      rows: (ctx, part, base) => paletteRows(ctx, sizeOf, part, base),
    }),
  ),
  plan<LabelParts>({
    name: "label-edit",
    cases: ["label-box", "label-open", "label-type", "label-multiline", "label-escape"],
    measure: measureLabels,
    rows: labelRows,
  }),
  ...(["fit", "100"] as const).map((variant) =>
    plan<NoopPart>({
      name: `label-noop-${variant}`,
      cases: [`label-noop-${variant}`],
      extraZooms: ODD_ZOOMS,
      measure: (ctx) => measureNoop(ctx, variant),
      rows: (ctx, part) => noopRows(ctx, part),
    }),
  ),
  plan<ResizePart>({
    name: "label-resize",
    cases: ["label-resize"],
    measure: measureResize,
    rows: (ctx, part) => resizeRows(ctx, part),
  }),
  plan<KeysPart>({
    name: "keys",
    cases: Object.keys(KEY_TEXTS),
    measure: measureKeys,
    rows: (ctx, part) => keyRows(ctx, part),
  }),
  plan<WheelPart>({ name: "wheel", cases: Object.keys(WHEEL_TEXTS), measure: measureWheel, rows: wheelRows }),
  plan<FocusPart>({
    name: "focus",
    cases: Object.keys(FOCUS_TEXTS),
    measure: measureFocus,
    rows: (ctx, part) => focusRows(ctx, part),
  }),
  plan<TabPart>({ name: "tab", cases: ["tab-order"], measure: measureTab, rows: (ctx, part) => tabRows(ctx, part) }),
];

/** CASES: a case name, a prefix of one, or a plan's name */
const caseWanted = (name: string): boolean =>
  wanted.length === 0 || wanted.some((one) => name === one || name.startsWith(one));
const planWanted = (one: Plan): boolean =>
  wanted.length === 0 || wanted.includes(one.name) || one.cases.some(caseWanted);
const rowWanted = (one: Plan, row: Row): boolean =>
  wanted.length === 0 || wanted.includes(one.name) || caseWanted(row.case);

// ── the run ──────────────────────────────────────────────────────────────────

interface Task {
  plan: Plan;
  strategy: Strategy;
  zoom: number;
  run: number;
}

/** runs `work` for every task, `jobs` at a time, each on pages of its own */
async function pool<T>(tasks: readonly T[], work: (task: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const task = tasks[next++];
      if (task === undefined) return;
      await work(task);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
}

const key = (name: string, strategy: Strategy, zoom: number): string => `${name}|${strategy}|${zoom}`;

/** the Markdown of the result: one line per row, and the same folded over the zooms */
function markdown(rows: readonly Row[]): string {
  const cell = (text: string): string => text.replace(/\|/g, "/").replace(/\n/g, " ");
  const lines = [
    "# bpmn-chrome",
    "",
    "One row per case x notation x strategy x board zoom.",
    "",
    "| case | notation | strategy | zoom | verdict | measured | why |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.case} | ${row.notation} | ${row.strategy} | ${row.zoom} | ${row.verdict} | ${cell(row.cell)} | ${cell(row.verdict === "ok" ? "" : row.unmeasured && row.verdict === "unmeasured" ? row.unmeasured : row.why)} |`,
    ),
    "",
    "## Verdicts over the zooms",
    "",
    "| case | strategy | verdict per board zoom |",
    "| --- | --- | --- |",
  ];
  const cases = [...new Set(rows.map((row) => row.case))];
  for (const name of cases) {
    for (const strategy of strategies) {
      const mine = rows.filter((row) => row.case === name && row.strategy === strategy);
      if (mine.length > 0)
        lines.push(`| ${name} | ${strategy} | ${mine.map((row) => `${row.zoom}: ${row.verdict}`).join(" , ")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

await run(async (harness) => {
  const started = Date.now();
  if (!notations.includes("bpmn")) {
    console.log(`NOTATIONS=${notations.join(",")}: this battery measures bpmn only, nothing to do`);
    return 0;
  }
  const plans = PLANS.filter(planWanted);
  const zoomsOf = (one: Plan): number[] => [...new Set([...zooms, ...(one.extraZooms ?? [])])].sort((a, b) => a - b);
  const parts = new Map<string, unknown[]>();
  let harnessTrouble = 0;
  const measure = async (task: Task): Promise<void> => {
    const ctx: Ctx = { harness, strategy: task.strategy, zoom: task.zoom };
    const began = Date.now();
    let measured: unknown;
    try {
      measured = await task.plan.measure(ctx);
    } catch (error) {
      // a plan catches per page: what arrives here is the script's own fault
      measured = { error: error instanceof Error ? error.message : String(error), problems: [] };
    }
    const slot = key(task.plan.name, task.strategy, task.zoom);
    const runs = parts.get(slot) ?? [];
    runs[task.run] = measured;
    parts.set(slot, runs);
    console.log(
      `measured ${task.plan.name.padEnd(18)} ${task.strategy.padEnd(8)} zoom ${String(task.zoom).padEnd(5)}` +
        `${repeat > 1 ? ` run ${task.run + 1}` : ""} ${Date.now() - began} ms`,
    );
  };

  // 1. the baseline of every plan, 2. everything else
  const baseline: Task[] = plans.map((one) => ({ plan: one, ...BASELINE, run: 0 }));
  await pool(baseline, measure);
  const rest: Task[] = [];
  for (const one of plans) {
    for (const strategy of strategies) {
      for (const zoom of zoomsOf(one)) {
        for (let index = 0; index < repeat; index++) {
          if (strategy === BASELINE.strategy && zoom === BASELINE.zoom && index === 0) continue;
          rest.push({ plan: one, strategy, zoom, run: index });
        }
      }
    }
  }
  await pool(rest, measure);

  // 3. the rows: every plan judged against its baseline's parts
  const rows: Row[] = [];
  for (const one of plans) {
    const base = parts.get(key(one.name, BASELINE.strategy, BASELINE.zoom))?.[0];
    for (const strategy of strategies) {
      for (const zoom of zoomsOf(one)) {
        const runs = parts.get(key(one.name, strategy, zoom)) ?? [];
        const perRun = runs.map((measured) => {
          try {
            return one.rows({ harness, strategy, zoom }, measured, base).filter((row) => rowWanted(one, row));
          } catch (error) {
            harnessTrouble++;
            console.error(
              `judging ${one.name} ${strategy} ${zoom} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return [];
          }
        });
        for (const row of perRun[0] ?? []) {
          if (perRun.length > 1) {
            const same = perRun.map((list) => list.find((other) => other.case === row.case));
            const verdicts = same.map((other) => other?.verdict ?? "unmeasured");
            const cells = same.map((other) => other?.cell ?? "");
            row.repeats = {
              runs: perRun.length,
              verdicts,
              cells,
              agree: verdicts.every((verdict) => verdict === verdicts[0]) && cells.every((text) => text === cells[0]),
            };
          }
          rows.push(row);
        }
      }
    }
  }
  const order = PLANS.flatMap((one) => one.cases);
  rows.sort(
    (a, b) =>
      order.indexOf(a.case) - order.indexOf(b.case) ||
      strategies.indexOf(a.strategy) - strategies.indexOf(b.strategy) ||
      a.zoom - b.zoom,
  );

  // harness trouble: a page that threw, or output where none belongs
  const failedPages = new Set<string>();
  for (const [slot, runs] of parts) {
    for (const measured of runs) {
      const pages = Array.isArray(measured) ? measured : [measured];
      for (const page of pages as PageResult[]) {
        if (page?.error || (page?.problems?.length ?? 0) > 0) failedPages.add(slot);
      }
    }
  }
  for (const slot of failedPages) console.log(`harness trouble in ${slot}`);
  for (const row of rows) {
    console.log(
      `${row.case.padEnd(24)} ${row.strategy.padEnd(8)} ${String(row.zoom).padEnd(5)} ${row.verdict.padEnd(10)} ` +
        `${row.verdict === "ok" ? row.cell : row.why}`.slice(0, 260),
    );
    for (const problem of row.problems) console.log(`    ${problem.slice(0, 200)}`);
  }
  const count = (verdict: Verdict): number => rows.filter((row) => row.verdict === verdict).length;
  const baselineRows = (name: string): unknown => parts.get(key(name, BASELINE.strategy, BASELINE.zoom))?.[0];
  const path = writeResult("bpmn-chrome", {
    what: "board spike battery bpmn-chrome: the chrome, text editing, keys, wheel and focus of bpmn-js per strategy and board zoom",
    run: { date: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), jobs },
    chromium: harness.browser.version(),
    viewport: { ...WINDOW, deviceScaleFactor: 1 },
    nodeOrigin: ORIGIN,
    file: FILE,
    nodeSizes: { "800x508": "the matrix board's node body in flow units", "640x388": "the stress board's node body" },
    strategies,
    zooms,
    oddZooms: ODD_ZOOMS,
    cases: [...new Set(rows.map((row) => row.case))],
    repeat,
    baseline: {
      ...BASELINE,
      note: "measured first in every run; rows that compare against a baseline compare with these parts",
      parts: Object.fromEntries(plans.map((one) => [one.name, baselineRows(one.name)])),
    },
    allowedConsole: [
      "ContextPad#getPad is deprecated (a warning of bpmn-js on opening the replace, colour or align menu)",
    ],
    verdicts: {
      ok: count("ok"),
      degraded: count("degraded"),
      broken: count("broken"),
      "wrong-data": count("wrong-data"),
      unmeasured: count("unmeasured"),
    },
    harnessTrouble: [...failedPages],
    rows,
  });
  const table = path.replace(/\.json$/, ".md");
  writeFileSync(table, markdown(rows));
  console.log(
    `\n${rows.length} rows in ${Math.round((Date.now() - started) / 1000)} s: ${count("ok")} ok, ${count("degraded")} degraded, ` +
      `${count("broken")} broken, ${count("wrong-data")} wrong-data, ${count("unmeasured")} unmeasured; ` +
      `${failedPages.size + harnessTrouble} with harness trouble\n${path}\n${table}`,
  );
  return failedPages.size + harnessTrouble;
});
