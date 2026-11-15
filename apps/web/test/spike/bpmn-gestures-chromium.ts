/**
 * Battery "bpmn-gestures" of the board spike: every pointer gesture of bpmn-js that runs through a
 * drag, per strategy and board zoom, each on a fresh page. Run by hand, not by `pnpm test` or CI:
 *
 *   PORT=5421 CACHE_DIR=<scratch>/vite-cache OUT_DIR=<scratch> node apps/web/test/spike/bpmn-gestures-chromium.ts
 *   STRATEGIES=plugin,shim ZOOMS=0.5,2 CASES=move,create node apps/web/test/spike/bpmn-gestures-chromium.ts
 *
 * What a row is: one case x notation (bpmn) x strategy x board zoom. It says what was done, what
 * was expected and why, what was measured, whether the gesture STARTED (read off the editor's DOM
 * while the button is down), what the model FILE holds afterwards (the hub's copy, parsed), and a
 * verdict computed from the numbers by the rules the row carries (`checks`). A case that cannot
 * run is a row with the verdict `unmeasured` and the reason, never a dropped row.
 *
 * Cases (the board is `matrix` with the order-to-cash process, node m-bpmn at 60, 80):
 *   move-snap, move-free            one shape, grid snapping on (plain drag) and off (Control)
 *   move-multi, move-multi-pefix    three shapes selected with Shift + click; the second with the
 *                                   rule `.board-engine { pointer-events: auto }` injected (below)
 *   create-drag, create-click       palette create: entry dragged onto the canvas; click, then click
 *   append-click, append-drag       the context pad's "append task": click (auto-place) and drag
 *   connect-drag, global-connect    the pad's connect entry dragged to a shape; the palette's tool
 *   resize-participant, resize-lane a resize handle of the pool (east) and of a lane (south)
 *   lasso, space-tool               set equality: what is selected, what moves
 *   hand-tool, canvas-pan           diagram displacement over pointer travel
 *   bendpoint-move, segment-move, reconnect-end    a flow's corner, its segment, its end onto a shape
 *   label-move                      an external label
 *   autoscroll                      the pool held at the editor's edge, then dropped
 *   drop-lane, drop-container       a task into another lane; a new event into a sub-process
 *   paste-at-pointer, snap-guides, drag-leave-return, release-outside    nice to have
 *
 * Ground truth, the same in every strategy and asked of no engine:
 * - where the pointer is in the diagram: the browser's own matrix of `g.viewport` (getScreenCTM
 *   through window.__boardSpikeNative, times the frame's scale where there is a frame), read at the
 *   press and again while the button is down (the canvas may scroll under a drag);
 * - what the model holds: the file's text at the hub, its BPMNDI and semantic tree parsed in the page;
 * - what is under the pointer: the lib's hit test (elementFromPoint, native).
 * Nothing is keyed on a strategy's name: the editor's net scale, the frame map and the host's
 * computed `pointer-events` are measured and recorded per row (`env`).
 *
 * Verdicts (the worst failing check wins; a check's rule and what it measured are in the row):
 *   ok          every check passed
 *   degraded    the gesture works but a cost was measured (the diagram does not follow the pointer
 *               one to one, the canvas scrolled under the drag, the context pad lies off its shape,
 *               the node disarmed); nothing wrong in the file
 *   broken      the gesture did not start or did not do what the screen shows; the file is as before
 *               or holds nothing wrong
 *   wrong-data  the file changed and holds a value or a relation that contradicts the true pointer
 *               position (worse than a gesture that does nothing)
 *   unmeasured  the case could not run; `reason` says why
 *
 * Tolerances, in diagram units: 1.5 units + 1.5 screen px for a free drag (the engine rounds to
 * whole units, the pointer to whole px at both ends), 6.5 units + 1.5 px where the engine's 10 unit
 * grid snapping is on (half a grid step more).
 *
 * `measured` holds what is the same in every run, `volatile` what depends on timing (how far an
 * auto-scroll went): a comparison of two runs leaves `volatile`, `ms` and the `run` header out.
 *
 * Exit code 1 only when the harness failed: a case threw (wrong page, a navigation, a timeout), or
 * a row had a console error, a page error or a log line (KNOWN_CONSOLE.padDeprecation is allowed:
 * it is a warning). What a row says about a strategy is never a failure of the run.
 *
 * Environment: STRATEGIES (default naive,counter,overlay,iframe; plugin and shim run the same),
 * NOTATIONS (only bpmn has these gestures), ZOOMS (default 0.5,0.73,1,1.5,2), CASES (comma list;
 * a case runs when its name equals an entry or starts with it), REPEAT (default 1: fresh pages per
 * case, the row says whether the repeats agree), JOBS (rows measured side by side, default 1; each
 * row has a page and a browser context of its own either way, and the result lists the rows in the
 * same order), PATCH=pointer-events (EVERY case runs with the rule `.board-engine { pointer-events:
 * auto }` injected by this script: the emulation of a fix this battery suggested, see moveMulti;
 * the board has that rule itself since round 4, so the patched and the unpatched rows are to be
 * equal), plus lib.ts's PORT, BASE, CACHE_DIR, OUT_DIR, OUT, EXTRA_PARAMS.
 * Results: <OUT_DIR>/bpmn-gestures.json (or OUT) and <OUT_DIR>/bpmn-gestures.md.
 *
 * Arm rules (rounds 5 and 6): arming may move the board first (lib.ts, ARMING MOVES THE BOARD). A
 * row's `zoom` is the board zoom the page was opened with; `effect` is the board's viewport after
 * arming, and the size of every gesture (travel, margins) is computed from ITS zoom. Every
 * expectation was already computed from the browser's own matrix, read after arming. Since round 6
 * an overlay node is armed at zoom exactly 1 from above 1 too, so every row of a default run is
 * measured at zoom 1 and differs from its zoom 1 row only in where the node lies in the window.
 * No case of this battery zooms the board, so no rule here depends on `armedzoom`. With
 * EXTRA_PARAMS="armzoom=off&armedzoom=free" both zooms are the same and the rows are round 4's.
 *
 * A resize handle that is not on the page at all (resize-participant, resize-lane) is `unmeasured`
 * after the shape was selected anew and waited for again; `broken` is a handle that is there and
 * takes no press.
 *
 * Geometry under the `shim` strategy: while a shim node is armed the page's plain geometry
 * functions answer in the editor's virtual space. Every read of this script goes through lib.ts
 * (probe, hit, map) or through window.__boardSpikeNative (viewOf, topElement); the two other
 * evaluates read no geometry (gestureOf: class names, hostPointerEvents: a computed style).
 */
import { writeFileSync } from "node:fs";

import {
  aimAt,
  type Board,
  type Box,
  centre,
  type Dragged,
  type Harness,
  type Hit,
  KNOWN_CONSOLE,
  type NativeGeometry,
  type NodeHandle,
  outPath,
  type Point,
  round,
  run,
  type ScreenMap,
  STRATEGIES,
  type Strategy,
  type Viewport,
  writeResult,
} from "./lib.ts";

// ── configuration ────────────────────────────────────────────────────────────

const list = (name: string): string[] => (process.env[name] ?? "").split(",").filter(Boolean);
const wantedStrategies = list("STRATEGIES");
const strategies: Strategy[] =
  wantedStrategies.length === 0
    ? ["naive", "counter", "overlay", "iframe"]
    : STRATEGIES.filter((one) => wantedStrategies.includes(one));
const notations = list("NOTATIONS").length === 0 ? ["bpmn"] : list("NOTATIONS").filter((one) => one === "bpmn");
const zooms = (process.env.ZOOMS ?? "0.5,0.73,1,1.5,2").split(",").map(Number).filter(Boolean);
const caseFilter = list("CASES");
const repeat = Math.max(1, Number(process.env.REPEAT ?? 1) || 1);
const jobs = Math.max(1, Math.floor(Number(process.env.JOBS ?? 1)) || 1);
const patchAll = process.env.PATCH === "pointer-events";

const NODE = "m-bpmn";
const FILE = "processes/order-to-cash.bpmn";
/** where the node's top-left corner sits in the canvas: clear of the toolbar */
const ORIGIN = { x: 60, y: 80 };
/** the rule this script injects to emulate the suggested fix of the inherited `pointer-events: all` */
const POINTER_EVENTS_FIX = ".board-engine.board-engine { pointer-events: auto; }";

const PARTICIPANT = "Participant_acme";
const LANES = ["Lane_order_management", "Lane_billing", "Lane_customer_support"] as const;
const SUBPROCESS = "EventSubProcess_customer_support";

type NativeWindow = Window & { __boardSpikeNative?: NativeGeometry };

// ── geometry: the true mapping between the screen and the diagram ────────────

/** screen = (e, f) + a x diagram, in TOP-LEVEL screen px, from the browser's own matrix */
interface View {
  a: number;
  e: number;
  f: number;
}

async function viewOf(node: NodeHandle): Promise<View> {
  const map = await node.map();
  const matrix = await node.inDocument((host) => {
    const viewport = host.querySelector<SVGGElement>("svg g.viewport");
    if (!viewport) return null;
    const native = (window as NativeWindow).__boardSpikeNative;
    const ctm = native ? native.screenCTM(viewport) : viewport.getScreenCTM();
    return ctm ? { a: ctm.a, e: ctm.e, f: ctm.f } : null;
  });
  if (!matrix) throw new Error("the editor shows no diagram viewport");
  return { a: matrix.a * map.sx, e: map.x + matrix.e * map.sx, f: map.y + matrix.f * map.sy };
}

const toDiagram = (view: View, point: Point): Point => ({
  x: (point.x - view.e) / view.a,
  y: (point.y - view.f) / view.a,
});
const toScreen = (view: View, point: Point): Point => ({ x: view.e + point.x * view.a, y: view.f + point.y * view.a });
const minus = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const times = (a: Point, factor: number): Point => ({ x: a.x * factor, y: a.y * factor });
const rounded = (point: Point, digits = 2): Point => ({ x: round(point.x, digits), y: round(point.y, digits) });
/** a number as text without a negative zero */
const fixed = (value: number, digits: number): string => {
  const text = value.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
};
const pair = (point: Point, digits = 1): string => `${fixed(point.x, digits)}/${fixed(point.y, digits)}`;
const middle = (box: Box): Point => centre(box);
const inside = (box: Box, point: Point): boolean =>
  point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height;

// ── the model file ───────────────────────────────────────────────────────────

interface Model {
  /** bpmnElement -> dc:Bounds of its BPMNShape */
  shapes: Record<string, Box>;
  /** bpmnElement -> dc:Bounds of its BPMNLabel */
  labels: Record<string, Box>;
  /** bpmnElement -> di:waypoint list of its BPMNEdge */
  edges: Record<string, Point[]>;
  /** element id -> id of the element that contains it in the semantic tree */
  parent: Record<string, string>;
  /** element id -> local name (userTask, sequenceFlow, lane, ...) */
  type: Record<string, string>;
  /** lane id -> its flowNodeRefs */
  lanes: Record<string, string[]>;
  /** flow id -> its ends */
  refs: Record<string, { source: string; target: string }>;
}

async function parseModel(board: Board, text: string): Promise<Model> {
  return board.page.evaluate((xml) => {
    const model: Model = { shapes: {}, labels: {}, edges: {}, parent: {}, type: {}, lanes: {}, refs: {} };
    const tree = new DOMParser().parseFromString(xml, "application/xml");
    const number = (element: Element, name: string): number => Number(element.getAttribute(name));
    const bounds = (element: Element): Box => ({
      x: number(element, "x"),
      y: number(element, "y"),
      width: number(element, "width"),
      height: number(element, "height"),
    });
    const child = (element: Element, name: string): Element | undefined =>
      [...element.children].find((one) => one.localName === name);
    for (const element of tree.getElementsByTagName("*")) {
      const id = element.getAttribute("id");
      const of = element.getAttribute("bpmnElement");
      if (element.localName === "BPMNShape" && of) {
        const own = child(element, "Bounds");
        if (own) model.shapes[of] = bounds(own);
        const label = child(element, "BPMNLabel");
        const labelBounds = label && child(label, "Bounds");
        if (labelBounds) model.labels[of] = bounds(labelBounds);
      } else if (element.localName === "BPMNEdge" && of) {
        model.edges[of] = [...element.children]
          .filter((one) => one.localName === "waypoint")
          .map((one) => ({ x: number(one, "x"), y: number(one, "y") }));
        const label = child(element, "BPMNLabel");
        const labelBounds = label && child(label, "Bounds");
        if (labelBounds) model.labels[of] = bounds(labelBounds);
      } else if (id && element.namespaceURI === "http://www.omg.org/spec/BPMN/20100524/MODEL") {
        model.type[id] = element.localName;
        const parentId = element.parentElement?.getAttribute("id");
        if (parentId) model.parent[id] = parentId;
        if (element.localName === "lane") {
          model.lanes[id] = [...element.children]
            .filter((one) => one.localName === "flowNodeRef")
            .map((one) => one.textContent ?? "");
        }
        const [source, target] = [element.getAttribute("sourceRef"), element.getAttribute("targetRef")];
        if (source && target) model.refs[id] = { source, target };
      }
    }
    return model;
  }, text);
}

const lanesOf = (model: Model, id: string): string[] =>
  Object.entries(model.lanes)
    .filter(([, members]) => members.includes(id))
    .map(([lane]) => lane);
/** the lane whose bounds in the model hold a diagram point */
const laneAt = (model: Model, point: Point): string[] =>
  LANES.filter((lane) => {
    const box = model.shapes[lane];
    return !!box && inside(box, point);
  });
const added = (before: Record<string, unknown>, after: Record<string, unknown>): string[] =>
  Object.keys(after).filter((id) => !(id in before));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * What the file holds now against before, in short strings, with ids the editor made up replaced
 * by their type (they differ between runs): the row's "model afterwards". Shapes that moved alike
 * and flows that were only re-routed are counted, not listed, when they are many.
 */
function describeChange(before: Model, after: Model): string[] {
  const name = (id: string): string =>
    id in before.type || id in before.shapes ? id : `new ${after.type[id] ?? "element"}`;
  const out: string[] = [];
  const box = (b: Box): string => `${b.x},${b.y} ${b.width}x${b.height}`;
  const movedAlike = new Map<string, string[]>();
  for (const [id, now] of Object.entries(after.shapes)) {
    const was = before.shapes[id];
    if (!was) {
      const lane = lanesOf(after, id);
      out.push(
        `+ ${name(id)} at ${box(now)} in ${name(after.parent[id] ?? "?")}${lane.length > 0 ? `, lane ${lane.join("+")}` : ""}`,
      );
    } else if (!same(was, now)) {
      const moved = was.x !== now.x || was.y !== now.y ? ` moved ${now.x - was.x}/${now.y - was.y}` : "";
      const sized =
        was.width !== now.width || was.height !== now.height
          ? ` resized ${now.width - was.width}/${now.height - was.height}`
          : "";
      movedAlike.set(`${moved}${sized}`, [...(movedAlike.get(`${moved}${sized}`) ?? []), id]);
    }
  }
  for (const [how, ids] of movedAlike) {
    if (ids.length > 4) out.push(`${ids.length} shapes${how} (${ids.slice(0, 3).join(", ")}, ...)`);
    else for (const id of ids) out.push(`${id}${how}`);
  }
  for (const id of Object.keys(before.shapes)) if (!(id in after.shapes)) out.push(`- ${id}`);
  const labels = Object.entries(after.labels).filter(([id, now]) => before.labels[id] && !same(before.labels[id], now));
  if (labels.length > 4) out.push(`${labels.length} labels moved`);
  else {
    for (const [id, now] of labels) {
      const was = before.labels[id]!;
      out.push(`label of ${name(id)} moved ${now.x - was.x}/${now.y - was.y}`);
    }
  }
  const points = (list: Point[]): string => list.map((point) => `${point.x},${point.y}`).join(" ");
  const rerouted: string[] = [];
  for (const [id, now] of Object.entries(after.edges)) {
    const was = before.edges[id];
    const ends = after.refs[id];
    const flow = ends ? ` ${name(ends.source)} -> ${name(ends.target)}` : "";
    if (!was) out.push(`+ ${name(id)}${flow}: ${points(now)}`);
    else if (!same(before.refs[id], ends)) out.push(`${id} now${flow}: ${points(now)}`);
    else if (!same(was, now)) rerouted.push(`${id}: ${points(now)}`);
  }
  if (rerouted.length > 4) out.push(`${rerouted.length} flows have other waypoints`);
  else out.push(...rerouted);
  for (const id of Object.keys(before.edges)) if (!(id in after.edges)) out.push(`- ${id}`);
  for (const lane of Object.keys(after.lanes)) {
    const [was, now] = [before.lanes[lane] ?? [], after.lanes[lane] ?? []];
    const gained = now.filter((id) => !was.includes(id)).map(name);
    const lost = was.filter((id) => !now.includes(id));
    if (gained.length + lost.length > 0) {
      out.push(`${lane}:${gained.map((id) => ` +${id}`).join("")}${lost.map((id) => ` -${id}`).join("")}`);
    }
  }
  for (const [id, parent] of Object.entries(after.parent)) {
    if (before.parent[id] !== undefined && before.parent[id] !== parent) out.push(`${id} now in ${name(parent)}`);
  }
  return out;
}

// ── what the editor's DOM shows of a running gesture ─────────────────────────

const GESTURE_MARKS = [
  ".djs-drag-active",
  ".djs-drag-group",
  ".djs-dragger",
  ".djs-lasso-overlay",
  ".djs-resize-overlay",
  ".djs-bendpoint.djs-dragging",
  ".djs-segment-dragger.djs-dragging",
  ".connect-ok",
  ".connect-not-ok",
  ".drop-ok",
  ".drop-not-ok",
  ".new-parent",
  ".djs-snap-line",
] as const;

interface Gesture {
  /** the selectors of GESTURE_MARKS that match inside the host, plus the cursor class diagram-js puts on the body */
  marks: string[];
  /** element ids by the marker class they carry right now */
  marked: Record<string, string[]>;
}

async function gestureOf(node: NodeHandle): Promise<Gesture> {
  return node.inDocument(
    (host, names) => {
      const ids = (cls: string): string[] =>
        [...host.querySelectorAll(`.djs-element.${cls}[data-element-id]`)].map(
          (element) => element.getAttribute("data-element-id") ?? "",
        );
      return {
        marks: [
          ...names.filter((selector) => !!host.querySelector(selector)),
          ...[...document.body.classList].filter((cls) => cls.startsWith("djs-cursor")).map((cls) => `body.${cls}`),
        ],
        marked: {
          "new-parent": ids("new-parent"),
          "drop-ok": ids("drop-ok"),
          "drop-not-ok": ids("drop-not-ok"),
          "connect-ok": ids("connect-ok"),
          "connect-not-ok": ids("connect-not-ok"),
        },
      };
    },
    GESTURE_MARKS as readonly string[],
  );
}

// ── rows ─────────────────────────────────────────────────────────────────────

type Verdict = "ok" | "degraded" | "broken" | "wrong-data" | "unmeasured";
const WORST: readonly Verdict[] = ["ok", "degraded", "broken", "wrong-data"];

interface Check {
  name: string;
  /** the rule, in words and numbers */
  rule: string;
  ok: boolean;
  /** what was measured against it */
  detail: string;
  /** the verdict a failure of this check gives the row */
  fails: Exclude<Verdict, "ok" | "unmeasured">;
}

interface Outcome {
  did: string;
  expected: string;
  /** the gesture started (the editor's own drag markers while the button was down); null: not reached */
  started: boolean | null;
  marks: string[];
  /** numbers that are the same in every run */
  measured: Record<string, unknown>;
  /** numbers that depend on timing (auto-scroll): left out of a comparison of two runs */
  volatile?: Record<string, unknown>;
  checks: Check[];
  /** the one quantity the folded table shows for this zoom */
  key: string;
  notes: string[];
  /** how far the diagram scrolled on screen under a drag that is no pan, in px (goes to `volatile`) */
  scrolled?: Point;
}

interface Env {
  /** client size over layout size of the editor's host in its own document: 1 is what diagram-js assumes */
  netScale: number;
  /** top-level screen px per px of the editor's document: 1 unless the editor lives in a frame */
  frameScale: number;
  /** screen px per diagram unit */
  unitPx: number;
  /** the host's box on screen */
  host: Box;
  /** the host's computed `pointer-events` (the node wrapper of React Flow sets `all`, which is inherited) */
  hostPointerEvents: string;
  /** the palette and one of its entries on screen */
  palette: string;
}

interface Row {
  case: string;
  notation: "bpmn";
  strategy: Strategy;
  /** the board zoom the page was opened with (asked for) */
  zoom: number;
  /**
   * The board's viewport after arming: the zoom IN EFFECT. The arm rules may move the board before
   * they arm (lib.ts, ARMING MOVES THE BOARD), so this is what the armed editor runs at and what
   * every size of a gesture is computed from; with the rules off it is the URL's viewport.
   */
  effect?: Viewport;
  status: "measured" | "unmeasured" | "failed";
  verdict: Verdict;
  /** why it is unmeasured or failed */
  reason?: string;
  /** which check decided the verdict */
  decidedBy?: string;
  env?: Env;
  did?: string;
  expected?: string;
  started?: boolean | null;
  marks?: string[];
  measured?: Record<string, unknown>;
  volatile?: Record<string, unknown>;
  checks?: Check[];
  key?: string;
  notes?: string[];
  /** the file at the hub differs from before the gesture */
  fileChanged?: boolean;
  /** what the model file holds now against before */
  model?: string[];
  boardSame?: boolean;
  armedAfter?: boolean;
  mounts?: number;
  /** REPEAT > 1: verdict and key of every repeat, and whether they agree */
  repeats?: { verdicts: Verdict[]; keys: string[]; agree: boolean };
  problems: string[];
  ms: number;
}

class Unmeasured extends Error {}

interface Ctx {
  board: Board;
  node: NodeHandle;
  /** the board zoom in effect after arming (Row.effect), not the zoom asked for */
  zoom: number;
  /** the true view at the start of the case */
  view: View;
  map: ScreenMap;
  /** the model at the start of the case */
  model: Model;
  env: Env;
}

/** diagram units a value may be off: `base` (1.5 free, 6.5 under the 10 unit grid) plus 1.5 screen px */
const tolerance = (view: View, base: number): number => base + 1.5 / view.a;
const FREE = 1.5;
const GRID = 6.5;
const within = (error: Point, limit: number): boolean => Math.abs(error.x) <= limit && Math.abs(error.y) <= limit;

/** the screen point of a diagram point, aimed at the middle of a px of the node's document */
const at = (c: Ctx, diagram: Point): Point => aimAt(c.map, toScreen(c.view, diagram));
const hitText = (hit: Hit): string =>
  `${hit.reachable ? "" : "NOT REACHABLE: "}${hit.element ?? "no element"} (${hit.what})`;

/** a point of the element where a press reaches the element itself: the editor's chrome may cover its middle */
async function reach(
  c: Ctx,
  id: string,
  fractions: readonly (readonly [number, number])[] = [
    [0.5, 0.5],
    [0.5, 0.3],
    [0.5, 0.7],
    [0.3, 0.5],
    [0.7, 0.5],
    [0.25, 0.25],
    [0.75, 0.75],
  ],
): Promise<Point | null> {
  const box = await c.node.elementBox(id);
  if (!box) return null;
  for (const [fx, fy] of fractions) {
    const point = aimAt(c.map, { x: box.x + box.width * fx, y: box.y + box.height * fy });
    const hit = await c.node.hit(point);
    if (hit.reachable && hit.element === id) return point;
  }
  return null;
}

async function firstReachable(c: Ctx, ids: readonly string[]): Promise<{ id: string; point: Point; passed: string[] }> {
  const passed: string[] = [];
  for (const id of ids) {
    const point = await reach(c, id);
    if (point) return { id, point, passed };
    passed.push(id);
  }
  throw new Unmeasured(
    `none of ${ids.join(", ")} takes a press: the editor's chrome covers them or they are not drawn`,
  );
}

/** the participant's label band (30 units at its left): where a press selects and moves the pool */
const BAND: readonly (readonly [number, number])[] = [
  0.97, 0.94, 0.9, 0.82, 0.75, 0.5, 0.25, 0.1, 0.06, 0.03, 0.02,
].map((fy) => [0.012, fy] as const);

interface Dragging {
  dragged: Dragged;
  gesture: Gesture;
  /** the true view while the button was down, after the last move */
  viewHeld: View;
  changed: boolean;
  after: Model;
  /** the true view after the release */
  viewAfter: View;
  /**
   * The pointer's travel in the diagram, in units: the press through the view of the start, the
   * last position through the view while the button was down. They differ when the canvas scrolled
   * under the drag (auto-scroll within 20 px of the container's edge).
   */
  travel: Point;
  /** the diagram's displacement on screen between the press and the last move, in px */
  scrolled: Point;
}

/** the file's text once it differs from `before`, else what it is after `timeout` ms */
async function settledModel(
  c: Ctx,
  before: string | undefined,
  // an editor writes about 350 ms after a gesture; generous, for a machine under load
  timeout = 2000,
): Promise<{ changed: boolean; after: Model }> {
  const text = await c.board.waitForFileChange(FILE, before, timeout);
  if (text === null) return { changed: false, after: await parseModel(c.board, before ?? "") };
  // a gesture may write twice (a create, then the label editor's cancel): let the file rest
  let last = text;
  for (let waited = 0; waited < 4; waited++) {
    await c.board.page.waitForTimeout(120);
    const now = (await c.board.fileText(FILE)) ?? "";
    if (now === last) break;
    last = now;
  }
  return { changed: true, after: await parseModel(c.board, last) };
}

/**
 * Presses at `from`, drags by `delta` screen px, reads the editor's gesture markers while the
 * button is down, releases, and waits for the file. `drag` chooses how the pointer travels.
 */
async function dragAndRead(
  c: Ctx,
  from: Point,
  delta: Point,
  options: { hold?: readonly string[]; palette?: Box; steps?: number } = {},
): Promise<Dragging> {
  const before = await c.board.fileText(FILE);
  const hold = options.hold ?? [];
  const dragged = options.palette
    ? await c.node.paletteDrag(options.palette, { x: from.x + delta.x, y: from.y + delta.y }, { keepDown: true, hold })
    : await c.node.drag(from, delta, { keepDown: true, hold, ...(options.steps ? { steps: options.steps } : {}) });
  const gesture = await gestureOf(c.node);
  const viewHeld = await viewOf(c.node);
  await c.board.release(hold);
  const { changed, after } = await settledModel(c, before);
  return {
    dragged,
    gesture,
    viewHeld,
    changed,
    after,
    viewAfter: await viewOf(c.node),
    travel: minus(toDiagram(viewHeld, dragged.to), toDiagram(c.view, dragged.from)),
    scrolled: { x: viewHeld.e - c.view.e, y: viewHeld.f - c.view.f },
  };
}

/** a gesture that is no pan: the canvas is to stay where it was while the pointer drags */
function viewKept(scrolled: Point): Check {
  const kept = Math.hypot(scrolled.x, scrolled.y) <= 1;
  return {
    name: "view stays",
    rule: "the diagram does not scroll under the drag (diagram-js auto-scrolls while a drag's pointer is within 20 px of its container's edge)",
    ok: kept,
    // how far differs from run to run (15 ms steps): the amount is in the row's volatile part
    detail: kept ? "kept" : "the canvas scrolled during the drag",
    fails: "degraded",
  };
}

const startCheck = (started: boolean, what: string, marks: readonly string[]): Check => ({
  name: "starts",
  rule: `the editor shows ${what} while the button is down`,
  ok: started,
  detail: marks.length > 0 ? marks.join(" ") : "no drag marker",
  fails: "broken",
});

/** `value - expected` per axis against a tolerance in diagram units */
function valueCheck(name: string, value: Point, expected: Point, limit: number, what: string): Check {
  const error = minus(value, expected);
  return {
    name,
    rule: `${what}: |model - true pointer| <= ${round(limit)} units per axis`,
    ok: within(error, limit),
    detail: `model ${pair(value)}, true ${pair(expected)}, off by ${pair(error)} units`,
    fails: "wrong-data",
  };
}

function setCheck(
  name: string,
  measured: readonly string[],
  expected: readonly string[],
  what: string,
  fails: Check["fails"],
): Check {
  const [a, b] = [[...measured].sort(), [...expected].sort()];
  const missing = b.filter((id) => !a.includes(id));
  const extra = a.filter((id) => !b.includes(id));
  return {
    name,
    rule: `${what}: the two sets are equal`,
    ok: missing.length === 0 && extra.length === 0,
    detail:
      missing.length + extra.length === 0
        ? `${a.length} of ${b.length}: ${a.join(", ") || "none"}`
        : `expected ${b.join(", ") || "none"}; got ${a.join(", ") || "none"}${missing.length > 0 ? `; missing ${missing.join(", ")}` : ""}${extra.length > 0 ? `; extra ${extra.join(", ")}` : ""}`,
    fails,
  };
}

/** moved / pointer per axis, as text; an axis the pointer did not travel shows the displacement alone */
function ratioText(moved: Point, pointer: Point): string {
  const one = (m: number, p: number): string => (Math.abs(p) < 0.5 ? `${round(m, 1)}u` : (m / p).toFixed(2));
  return `ratio ${one(moved.x, pointer.x)}/${one(moved.y, pointer.y)}`;
}

// ── the cases ────────────────────────────────────────────────────────────────

/** move one shape by a known pointer travel, with the engine's grid snapping on (a plain drag) or off (Control) */
async function moveOne(c: Ctx, snap: boolean): Promise<Outcome> {
  const { id, point, passed } = await firstReachable(c, [
    "Task_check_credit",
    "Task_fulfill_order",
    "CallActivity_invoice_handling",
  ]);
  const travel = snap ? { x: 60, y: 40 } : { x: 53, y: 37 };
  const run = await dragAndRead(c, point, times(travel, c.view.a), { hold: snap ? [] : ["Control"] });
  const started = run.gesture.marks.includes(".djs-drag-group");
  const expected = run.travel;
  const moved = minus(run.after.shapes[id]!, c.model.shapes[id]!);
  const limit = tolerance(c.view, snap ? GRID : FREE);
  return {
    did: `pressed ${id} and dragged it by ${pair(run.dragged.delta)} screen px${snap ? "" : ", Control held after the press (grid and element snapping off)"}`,
    expected: `the shape's bounds in the file move by the pointer's travel over the diagram's on-screen scale: ${pair(expected)} units${snap ? ", rounded by the engine to its 10 unit grid" : ""}`,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: {
      element: id,
      passedOver: passed,
      pointerPx: rounded(run.dragged.delta),
      expectedUnits: rounded(expected),
      modelUnits: moved,
      errorUnits: rounded(minus(moved, expected)),
      errorPx: rounded(times(minus(moved, expected), c.view.a)),
      ratio: { x: round(moved.x / expected.x, 3), y: round(moved.y / expected.y, 3) },
    },
    checks: [
      startCheck(started, "its move preview", run.gesture.marks),
      valueCheck("displacement", moved, expected, limit, "bounds of the shape"),
      viewKept(run.scrolled),
    ],
    key: ratioText(moved, expected),
    notes: passed.length > 0 ? [`passed over (covered by the editor's chrome): ${passed.join(", ")}`] : [],
  };
}

/**
 * Select three shapes with Shift + click, drag one of them: all three move, nothing else does.
 *
 * `patch`: React Flow's node wrapper sets `pointer-events: all` (@xyflow/react style.css,
 * .react-flow__node), which an editor host inside the node inherits. An SVG shape without a fill
 * then takes a press anywhere inside it, and diagram-js draws exactly such a shape around a
 * multi-selection (rect.djs-selection-outline, fill: none): the press on a selected shape lands on
 * the outline. With `patch` the script injects `.board-engine { pointer-events: auto }` first, to
 * show what the gesture does once the host resets the inherited value.
 */
async function moveMulti(c: Ctx, patch: boolean): Promise<Outcome> {
  const notes: string[] = [];
  const peBefore = c.env.hostPointerEvents;
  if (patch) {
    await c.board.page.addStyleTag({ content: POINTER_EVENTS_FIX });
    const now = await hostPointerEvents(c.node);
    notes.push(`rule injected by the script: ${POINTER_EVENTS_FIX} (host pointer-events ${peBefore} -> ${now})`);
  }
  const members = ["Task_reject_order", "CallActivity_invoice_handling", "EndEvent_order_fulfilled"];
  for (const id of members) {
    const point = await reach(c, id);
    if (!point)
      throw new Unmeasured(`${id} takes no press (covered by the editor's chrome): the selection cannot be made`);
    await c.board.page.keyboard.down("Shift");
    await c.board.click(point);
    await c.board.page.keyboard.up("Shift");
    await c.board.page.waitForTimeout(80);
  }
  const selected = await c.node.selected();
  if (!members.every((id) => selected.includes(id))) {
    throw new Unmeasured(`Shift + click selected ${selected.join(", ") || "nothing"} instead of ${members.join(", ")}`);
  }
  const grabbed = "CallActivity_invoice_handling";
  const box = (await c.node.elementBox(grabbed))!;
  const grab = aimAt(c.map, middle(box));
  // a person presses the shape where it is drawn, whatever lies over it: the hit is recorded, not avoided
  const hit = await c.node.hit(grab);
  const travel = { x: -59, y: 44 };
  const run = await dragAndRead(c, grab, times(travel, c.view.a), { hold: ["Control"] });
  const started = run.gesture.marks.includes(".djs-drag-group");
  const expected = run.travel;
  const limit = tolerance(c.view, FREE);
  const shapes = Object.keys(c.model.shapes).filter((id) => !LANES.includes(id as never) && id !== PARTICIPANT);
  const movedIds = shapes.filter((id) => !same(c.model.shapes[id], run.after.shapes[id]));
  const deltas = Object.fromEntries(members.map((id) => [id, minus(run.after.shapes[id]!, c.model.shapes[id]!)]));
  const off = (delta: Point): number => Math.max(Math.abs(delta.x - expected.x), Math.abs(delta.y - expected.y));
  // the member whose displacement is furthest from the pointer's
  const worst = members.map((id) => deltas[id]!).reduce((a, b) => (off(a) >= off(b) ? a : b));
  const viewMoved = { x: run.viewAfter.e - c.view.e, y: run.viewAfter.f - c.view.f };
  if (Math.hypot(viewMoved.x, viewMoved.y) > 1) notes.push(`the canvas panned by ${pair(viewMoved)} px instead`);
  if (hit.element !== grabbed) notes.push(`the press on ${grabbed} is taken by ${hitText(hit)}`);
  return {
    did: `selected ${members.join(", ")} with Shift + click, pressed ${grabbed} at its middle and dragged by ${pair(run.dragged.delta)} screen px, Control held after the press`,
    expected: `all three selected shapes move by ${pair(expected)} units in the file and no other shape moves`,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: {
      hostPointerEvents: await hostPointerEvents(c.node),
      hitAtGrab: hitText(hit),
      pointerPx: rounded(run.dragged.delta),
      expectedUnits: rounded(expected),
      modelUnits: deltas,
      movedShapes: movedIds,
      viewMovedPx: rounded(viewMoved),
    },
    checks: [
      startCheck(started, "the move preview of the selection", run.gesture.marks),
      setCheck("moved set", movedIds, members, "shapes whose bounds changed against the selection", "wrong-data"),
      valueCheck("displacement", worst, expected, limit, "bounds of the worst of the three"),
      ...(started ? [viewKept(run.scrolled)] : []),
    ],
    key: started ? ratioText(worst, expected) : `not started, press on ${hit.what.split(" ")[0]}`,
    notes,
  };
}

const PALETTE = (action: string): string => `.djs-palette .entry[data-action="${action}"]`;
const PAD = (action: string): string => `.djs-context-pad.open .entry[data-action="${action}"]`;

/** the box of a palette entry that takes a press; throws Unmeasured where the palette has none */
async function paletteEntry(c: Ctx, action: string): Promise<{ box: Box; hit: Hit }> {
  const [box] = await c.node.query(PALETTE(action));
  if (!box) throw new Unmeasured(`the palette has no entry ${action}`);
  return { box, hit: await c.node.hit(aimAt(c.map, middle(box))) };
}

const entryBroken = (did: string, expected: string, what: string, box: Box, hit: Hit): Outcome => ({
  did,
  expected,
  started: false,
  marks: [],
  measured: { entry: rounded(middle(box)), entryHit: hitText(hit) },
  checks: [
    {
      name: "entry",
      rule: `${what} takes a press at its middle`,
      ok: false,
      detail: `its middle (${pair(middle(box))} px) is ${hitText(hit)}`,
      fails: "broken",
    },
  ],
  key: `${what} not reachable`,
  notes: [],
});

/** a new shape's centre in the file against the true pointer position at the drop */
function createdChecks(
  c: Ctx,
  /** the true view at the drop */
  view: View,
  after: Model,
  dropAt: Point,
  options: { type: string; lane?: boolean; parent?: string; base: number },
): { checks: Check[]; measured: Record<string, unknown>; key: string } {
  const ids = added(c.model.shapes, after.shapes).filter((id) => after.type[id] === options.type);
  const trueDrop = toDiagram(view, dropAt);
  const count: Check = {
    name: "created",
    rule: `exactly one new ${options.type} is in the file`,
    ok: ids.length === 1,
    detail: `${ids.length} new`,
    fails: "broken",
  };
  const id = ids[0];
  if (ids.length !== 1 || !id) return { checks: [count], measured: { created: ids.length }, key: "nothing created" };
  const box = after.shapes[id]!;
  const centreNow = middle(box);
  const error = minus(centreNow, trueDrop);
  const checks = [
    count,
    valueCheck("position", centreNow, trueDrop, tolerance(c.view, options.base), "centre of the new shape"),
  ];
  const measured: Record<string, unknown> = {
    created: 1,
    bounds: box,
    trueDropUnits: rounded(trueDrop),
    errorUnits: rounded(error),
    errorPx: rounded(times(error, c.view.a)),
  };
  if (options.lane) {
    const [under, holds] = [laneAt(c.model, trueDrop), lanesOf(after, id)];
    measured.laneUnderPointer = under;
    measured.laneInFile = holds;
    checks.push(
      setCheck(
        "lane",
        holds,
        under,
        "the lane that lists the new shape against the lane under the pointer",
        "wrong-data",
      ),
    );
  }
  if (options.parent) {
    const parent = after.parent[id] ?? "?";
    const container = after.shapes[options.parent];
    measured.parentInFile = parent;
    checks.push({
      name: "parent",
      rule: `the new shape's parent in the file is the element under the pointer (${options.parent})`,
      ok: parent === options.parent,
      detail: `parent ${parent}`,
      fails: "wrong-data",
    });
    const was = c.model.shapes[options.parent];
    checks.push({
      name: "container",
      rule: `the container ${options.parent} keeps its bounds (the drop point lies inside it)`,
      ok: same(was, container),
      detail: same(was, container)
        ? "unchanged"
        : `${was?.x},${was?.y} ${was?.width}x${was?.height} -> ${container?.x},${container?.y} ${container?.width}x${container?.height}`,
      fails: "wrong-data",
    });
  }
  const pool: Check = {
    name: "pool",
    rule: "the participant keeps its bounds (the drop point lies inside it)",
    ok: same(c.model.shapes[PARTICIPANT], after.shapes[PARTICIPANT]),
    detail: same(c.model.shapes[PARTICIPANT], after.shapes[PARTICIPANT])
      ? "unchanged"
      : `now ${after.shapes[PARTICIPANT]?.x},${after.shapes[PARTICIPANT]?.y} ${after.shapes[PARTICIPANT]?.width}x${after.shapes[PARTICIPANT]?.height}`,
    fails: "wrong-data",
  };
  checks.push(pool);
  return { checks, measured, key: `off ${pair(times(error, c.view.a), 0)} px` };
}

/** a free spot of the first lane, clear of every shape, flow and snap line */
const FREE_SPOT = { x: 1060, y: 250 };

async function dropSpot(c: Ctx, diagram: Point, wanted: string): Promise<Point> {
  const point = at(c, diagram);
  const hit = await c.node.hit(point);
  if (!hit.reachable || hit.element !== wanted) {
    throw new Unmeasured(`the drop point ${pair(diagram, 0)} (${pair(point)} px) is not on ${wanted}: ${hitText(hit)}`);
  }
  return point;
}

/** palette create by dragging the entry onto the canvas */
async function createDrag(c: Ctx): Promise<Outcome> {
  const did = "dragged the palette's task entry to a free spot of the first lane";
  const expected =
    "a new task whose centre in the file is the true pointer position at the drop (grid snapping on), listed in the lane under the pointer";
  const entry = await paletteEntry(c, "create.task");
  if (!entry.hit.reachable || !entry.hit.palette)
    return entryBroken(did, expected, "the palette entry", entry.box, entry.hit);
  const drop = await dropSpot(c, FREE_SPOT, "Lane_order_management");
  const from = aimAt(c.map, middle(entry.box));
  const run = await dragAndRead(c, from, minus(drop, from), { palette: entry.box });
  await c.board.press("Escape");
  const started = run.gesture.marks.includes(".djs-drag-group");
  const result = createdChecks(c, run.viewHeld, run.after, run.dragged.to, { type: "task", lane: true, base: GRID });
  return {
    did: `${did} (${pair(run.dragged.to)} px)`,
    expected,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: { ...result.measured, newParentMarker: run.gesture.marked["new-parent"] },
    checks: [startCheck(started, "the create preview", run.gesture.marks), ...result.checks, viewKept(run.scrolled)],
    key: result.key,
    notes: [],
  };
}

/** palette create by a click on the entry, then a click on the canvas */
async function createClick(c: Ctx): Promise<Outcome> {
  const did = "clicked the palette's task entry, moved to a free spot of the first lane and clicked";
  const expected =
    "a new task whose centre in the file is the true pointer position at the second click, listed in the lane under the pointer; the preview follows the pointer";
  const entry = await paletteEntry(c, "create.task");
  if (!entry.hit.reachable || !entry.hit.palette)
    return entryBroken(did, expected, "the palette entry", entry.box, entry.hit);
  const drop = await dropSpot(c, FREE_SPOT, "Lane_order_management");
  const before = await c.board.fileText(FILE);
  await c.board.click(aimAt(c.map, middle(entry.box)));
  await c.board.move(drop, 12);
  await c.board.page.waitForTimeout(80);
  const gesture = await gestureOf(c.node);
  const [preview] = await c.node.query(".djs-drag-group");
  const previewOff = preview ? minus(middle(preview), drop) : null;
  const viewAtDrop = await viewOf(c.node);
  const scrolled = { x: viewAtDrop.e - c.view.e, y: viewAtDrop.f - c.view.f };
  await c.board.click(drop);
  const { after } = await settledModel(c, before);
  await c.board.press("Escape");
  const started = gesture.marks.includes(".djs-drag-group");
  const result = createdChecks(c, viewAtDrop, after, drop, { type: "task", lane: true, base: GRID });
  return {
    did: `${did} (${pair(drop)} px)`,
    expected,
    started,
    marks: gesture.marks,
    scrolled,
    measured: { ...result.measured, previewOffPx: previewOff && rounded(previewOff) },
    checks: [startCheck(started, "the create preview", gesture.marks), ...result.checks, viewKept(scrolled)],
    key: result.key,
    notes:
      previewOff && Math.hypot(previewOff.x, previewOff.y) > 6 * c.view.a + 2
        ? [`the preview is drawn ${pair(previewOff)} px from the pointer`]
        : [],
  };
}

/**
 * The context pad's place against its shape. bpmn-js puts it 8 units right of the shape's graphics
 * box, top aligned, and that box includes the 5 unit outline around the visual: 13 units right of
 * and 5 units above the visual's top right corner, times the on-screen scale.
 */
function padCheck(c: Ctx, pad: Box | null, shape: Box): { check: Check; offset: Point | null } {
  const offset = pad ? { x: pad.x - (shape.x + shape.width), y: pad.y - shape.y } : null;
  const want = { x: 13 * c.view.a, y: -5 * c.view.a };
  return {
    offset,
    check: {
      name: "pad place",
      rule: `the context pad lies ${pair(want)} px from the shape's top right corner (13 units right, 5 up, x the on-screen scale), within 6 px per axis`,
      ok: !!offset && within(minus(offset, want), 6),
      detail: offset
        ? `pad at ${pair(offset)} px from the corner, ${pair(minus(offset, want))} px off its place`
        : "no pad",
      fails: "degraded",
    },
  };
}

/** selects a shape with a click and waits for its context pad's entry to rest */
async function openPad(
  c: Ctx,
  id: string,
  action: string,
): Promise<{ shape: Box; pad: Box | null; entry: Box | null; hit: Hit | null }> {
  if (!(await c.node.select(id))) throw new Unmeasured(`${id} could not be selected with a click`);
  const entry = await c.board.waitForBox(async () => (await c.node.query(PAD(action)))[0]);
  const [pad] = await c.node.query(".djs-context-pad.open");
  const shape = (await c.node.elementBox(id))!;
  return { shape, pad: pad ?? null, entry, hit: entry && (await c.node.hit(aimAt(c.map, middle(entry)))) };
}

const SOURCE = "Task_fulfill_order";
/** where bpmn-js's auto-place puts a task appended to Task_fulfill_order in this model (no pointer involved) */
const AUTO_PLACED = { x: 880, y: 130, width: 100, height: 80 };

/** append from the context pad by a click on its task entry (auto-place) */
async function appendClick(c: Ctx): Promise<Outcome> {
  const did = `selected ${SOURCE} and clicked the context pad's "append task" entry`;
  const expected = `a new task at ${AUTO_PLACED.x},${AUTO_PLACED.y} (bpmn-js's auto-place: no pointer position enters it) and a flow from ${SOURCE} to it; the pad lies at its shape`;
  if (!(await reach(c, SOURCE))) throw new Unmeasured(`${SOURCE} takes no press (covered by the editor's chrome)`);
  const pad = await openPad(c, SOURCE, "append.append-task");
  const place = padCheck(c, pad.pad, pad.shape);
  if (!pad.entry || !pad.hit?.reachable || !pad.hit.pad) {
    const broken = entryBroken(
      did,
      expected,
      "the pad entry",
      pad.entry ?? { x: 0, y: 0, width: 0, height: 0 },
      pad.hit ?? { reachable: false, element: null, what: "no pad entry", popup: false, palette: false, pad: false },
    );
    return {
      ...broken,
      measured: { ...broken.measured, padOffsetPx: place.offset && rounded(place.offset) },
      checks: [...broken.checks, place.check],
    };
  }
  const before = await c.board.fileText(FILE);
  await c.board.click(aimAt(c.map, middle(pad.entry)));
  const { after } = await settledModel(c, before);
  await c.board.press("Escape");
  const ids = added(c.model.shapes, after.shapes);
  const flows = added(c.model.edges, after.edges);
  const box = ids[0] ? after.shapes[ids[0]] : undefined;
  const connected = flows.some((flow) => after.refs[flow]?.source === SOURCE && after.refs[flow]?.target === ids[0]);
  return {
    did,
    expected,
    started: ids.length === 1,
    marks: [],
    measured: {
      padOffsetPx: place.offset && rounded(place.offset),
      padEntryPx: `${round(pad.entry.width, 1)}x${round(pad.entry.height, 1)}`,
      bounds: box ?? null,
      connected,
    },
    checks: [
      {
        name: "created",
        rule: "exactly one new shape is in the file",
        ok: ids.length === 1,
        detail: `${ids.length} new`,
        fails: "broken",
      },
      {
        name: "position",
        rule: `the new task's bounds are ${AUTO_PLACED.x},${AUTO_PLACED.y} ${AUTO_PLACED.width}x${AUTO_PLACED.height}`,
        ok: !!box && same(box, AUTO_PLACED),
        detail: box ? `${box.x},${box.y} ${box.width}x${box.height}` : "none",
        fails: "wrong-data",
      },
      {
        name: "flow",
        rule: `a new flow runs from ${SOURCE} to the new task`,
        ok: connected,
        detail: connected ? "there" : "missing",
        fails: "wrong-data",
      },
      place.check,
    ],
    key: place.offset
      ? `pad ${pair(minus(place.offset, { x: 13 * c.view.a, y: -5 * c.view.a }), 0)} px off its place`
      : "no pad",
    notes: [],
  };
}

/** append from the context pad by dragging its task entry to a free spot */
async function appendDrag(c: Ctx): Promise<Outcome> {
  const did = `selected ${SOURCE} and dragged the context pad's "append task" entry to a free spot of the first lane`;
  const expected = `a new task whose centre in the file is the true pointer position at the drop, and a flow from ${SOURCE} to it`;
  if (!(await reach(c, SOURCE))) throw new Unmeasured(`${SOURCE} takes no press (covered by the editor's chrome)`);
  const pad = await openPad(c, SOURCE, "append.append-task");
  const place = padCheck(c, pad.pad, pad.shape);
  if (!pad.entry || !pad.hit?.reachable || !pad.hit.pad) {
    const broken = entryBroken(
      did,
      expected,
      "the pad entry",
      pad.entry ?? { x: 0, y: 0, width: 0, height: 0 },
      pad.hit ?? { reachable: false, element: null, what: "no pad entry", popup: false, palette: false, pad: false },
    );
    return {
      ...broken,
      measured: { ...broken.measured, padOffsetPx: place.offset && rounded(place.offset) },
      checks: [...broken.checks, place.check],
    };
  }
  const drop = await dropSpot(c, FREE_SPOT, "Lane_order_management");
  const from = aimAt(c.map, middle(pad.entry));
  const run = await dragAndRead(c, from, minus(drop, from), { palette: pad.entry });
  await c.board.press("Escape");
  const started = run.gesture.marks.includes(".djs-drag-group");
  const result = createdChecks(c, run.viewHeld, run.after, run.dragged.to, { type: "task", lane: true, base: GRID });
  const ids = added(c.model.shapes, run.after.shapes);
  const connected = added(c.model.edges, run.after.edges).some(
    (flow) => run.after.refs[flow]?.source === SOURCE && run.after.refs[flow]?.target === ids[0],
  );
  return {
    did,
    expected,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: { ...result.measured, padOffsetPx: place.offset && rounded(place.offset), connected },
    checks: [
      startCheck(started, "the create preview", run.gesture.marks),
      ...result.checks,
      ...(ids.length === 1
        ? [
            {
              name: "flow",
              rule: `a new flow runs from ${SOURCE} to the new task`,
              ok: connected,
              detail: connected ? "there" : "missing",
              fails: "wrong-data",
            } as Check,
          ]
        : []),
      place.check,
    ],
    key: result.key,
    notes: [],
  };
}

/** what a new flow's last waypoint says about where the pointer was released on the target */
function dockingCheck(after: Model, flow: string | undefined, target: string): Check {
  const points = flow ? after.edges[flow] : undefined;
  const last = points?.[points.length - 1];
  const box = after.shapes[target];
  const mid = box && middle(box);
  const onMidLine = !!last && !!mid && (Math.abs(last.x - mid.x) <= 1 || Math.abs(last.y - mid.y) <= 1);
  return {
    name: "docking",
    rule: `the pointer was released within 20 units of ${target}'s middle, where bpmn-js docks a sequence flow on the target's middle line: the last waypoint has the middle's x or y (1 unit)`,
    ok: onMidLine,
    detail: last && mid ? `last waypoint ${last.x},${last.y}; middle ${mid.x},${mid.y}` : "no flow",
    fails: "wrong-data",
  };
}

const CONNECT_SOURCES = ["Task_check_credit", "Task_fulfill_order"] as const;
const CONNECT_TARGETS = ["Task_reject_order", "CallActivity_invoice_handling"] as const;

/** a point near the target's middle (within 20 units on both axes) that takes a press on the target */
async function targetPoint(c: Ctx, targets: readonly string[]): Promise<{ id: string; point: Point }> {
  for (const id of targets) {
    const point = await reach(c, id, [
      [0.4, 0.6],
      [0.6, 0.4],
      [0.5, 0.5],
    ]);
    if (point) return { id, point };
  }
  throw new Unmeasured(`none of ${targets.join(", ")} can be pointed at near its middle (covered)`);
}

function connectOutcome(
  c: Ctx,
  did: string,
  expected: string,
  started: boolean,
  gesture: Gesture,
  after: Model,
  source: string,
  target: string,
  releasedAt: Point,
  extra: Record<string, unknown>,
  moreChecks: Check[],
): Outcome {
  const flows = added(c.model.edges, after.edges);
  const ends = flows.map((flow) => `${after.refs[flow]?.source} -> ${after.refs[flow]?.target}`);
  const flow = flows[0];
  const points = flow ? after.edges[flow] : undefined;
  return {
    did,
    expected,
    started,
    marks: gesture.marks,
    measured: {
      source,
      target,
      releasedAtUnits: rounded(toDiagram(c.view, releasedAt)),
      newFlows: ends,
      waypoints: points ?? null,
      connectOkMarker: gesture.marked["connect-ok"],
      ...extra,
    },
    checks: [
      startCheck(started, "the connection preview", gesture.marks),
      setCheck(
        "ends",
        ends,
        [`${source} -> ${target}`],
        "the new flow's ends against the selected source and the shape under the pointer",
        "wrong-data",
      ),
      ...(flows.length === 1 ? [dockingCheck(after, flow, target)] : []),
      ...moreChecks,
    ],
    key:
      flows.length === 1
        ? `${ends[0] === `${source} -> ${target}` ? "ends right" : "ENDS WRONG"}, last wp ${points?.[points.length - 1]?.x},${points?.[points.length - 1]?.y}`
        : `${flows.length} flows`,
    notes: [],
  };
}

/** connect by dragging the context pad's connect entry to another shape */
async function connectDrag(c: Ctx): Promise<Outcome> {
  const source = (await firstReachable(c, CONNECT_SOURCES)).id;
  const did = `selected ${source} and dragged the context pad's connect entry onto another task`;
  const expected =
    "a new sequence flow from the selected shape to the shape under the pointer at the release, docked on the target's middle line";
  const pad = await openPad(c, source, "connect");
  const place = padCheck(c, pad.pad, pad.shape);
  if (!pad.entry || !pad.hit?.reachable || !pad.hit.pad) {
    const broken = entryBroken(
      did,
      expected,
      "the pad entry",
      pad.entry ?? { x: 0, y: 0, width: 0, height: 0 },
      pad.hit ?? { reachable: false, element: null, what: "no pad entry", popup: false, palette: false, pad: false },
    );
    return {
      ...broken,
      measured: { ...broken.measured, padOffsetPx: place.offset && rounded(place.offset) },
      checks: [...broken.checks, place.check],
    };
  }
  const target = await targetPoint(c, CONNECT_TARGETS);
  const from = aimAt(c.map, middle(pad.entry));
  const run = await dragAndRead(c, from, minus(target.point, from), { palette: pad.entry });
  const started = run.gesture.marks.includes(".djs-drag-active");
  return connectOutcome(
    c,
    `${did} (${target.id})`,
    expected,
    started,
    run.gesture,
    run.after,
    source,
    target.id,
    run.dragged.to,
    { padOffsetPx: place.offset && rounded(place.offset) },
    [place.check],
  );
}

/** the palette's global connect tool: click the tool, click the source, click the target */
async function globalConnect(c: Ctx): Promise<Outcome> {
  const did = "clicked the palette's global connect tool, clicked a task, moved onto another task and clicked";
  const expected =
    "a new sequence flow from the first shape clicked to the shape under the pointer at the second click, docked on the target's middle line";
  const entry = await paletteEntry(c, "global-connect-tool");
  if (!entry.hit.reachable || !entry.hit.palette)
    return entryBroken(did, expected, "the palette entry", entry.box, entry.hit);
  const source = await firstReachable(c, CONNECT_SOURCES);
  const target = await targetPoint(c, CONNECT_TARGETS);
  const before = await c.board.fileText(FILE);
  const { mouse } = c.board.page;
  await c.board.click(aimAt(c.map, middle(entry.box)));
  await c.board.move(source.point, 8);
  await c.board.page.waitForTimeout(60);
  const overSource = await gestureOf(c.node);
  await mouse.down();
  await mouse.up();
  await c.board.page.waitForTimeout(60);
  await c.board.move(target.point, 12);
  await c.board.page.waitForTimeout(80);
  const gesture = await gestureOf(c.node);
  await mouse.down();
  await mouse.up();
  const { after } = await settledModel(c, before);
  await c.board.press("Escape");
  const started = gesture.marks.includes(".djs-dragger");
  return connectOutcome(
    c,
    `${did} (${source.id}, then ${target.id})`,
    expected,
    started,
    gesture,
    after,
    source.id,
    target.id,
    target.point,
    { sourceMarker: overSource.marked["connect-ok"] },
    [],
  );
}

/**
 * A resize handle of a selected shape and what a press at its middle meets. `box` null: no handle
 * element came within 2500 ms. That is another finding than a handle that is there and takes no
 * press (`hit`), and `resize` keeps the two apart.
 */
async function handleOf(c: Ctx, direction: string): Promise<{ box: Box | null; hit: Hit | null }> {
  const box = await c.board.waitForBox(
    async () => (await c.node.query(`.djs-resizer-${direction} .djs-resizer-hit`))[0],
    2500,
  );
  return { box, hit: box && (await c.node.hit(aimAt(c.map, middle(box)))) };
}

async function resize(
  c: Ctx,
  options: {
    id: string;
    press: Point | null;
    direction: string;
    travel: Point;
    dimension: "width" | "height";
    what: string;
  },
): Promise<Outcome> {
  const did = `selected ${options.id} with a click and dragged its ${options.what} handle by ${pair(options.travel, 0)} units on screen, Control held after the press`;
  const expected = `the ${options.dimension} of ${options.id} in the file changes by the pointer's travel over the diagram's on-screen scale`;
  if (!options.press)
    throw new Unmeasured(`${options.id} takes no press where it can be selected (covered by the editor's chrome)`);
  await c.board.click(options.press);
  const selected = await c.board.waitFor(async () => (await c.node.selected()).includes(options.id), 2500);
  if (!selected) throw new Unmeasured(`a click did not select ${options.id}`);
  const notes: string[] = [];
  let handle = await handleOf(c, options.direction);
  if (!handle.box) {
    // No handle element at all (seen once in 14 measurements of round 5, on a slow page, with no
    // arming move involved) is not a handle that takes no press: select the shape anew and wait
    // again. A click on a selected pool or lane takes the selection AWAY (bpmn-js, measured in 4 of
    // 4 pages), so: click, and once more when the shape is not selected after it. Still no handle:
    // nothing was there to press, so the row is unmeasured, not broken
    let anew = false;
    for (let tries = 0; tries < 2 && !anew; tries++) {
      const again = await c.node.hit(options.press);
      if (!again.reachable || again.element !== options.id) break;
      await c.board.click(options.press);
      anew = (await c.board.waitFor(async () => (await c.node.selected()).includes(options.id), 800)) === true;
    }
    handle = anew ? await handleOf(c, options.direction) : handle;
    if (!handle.box) {
      throw new Unmeasured(
        `no ${options.what} resize handle of ${options.id} on the page after ${anew ? "two waits of 2500 ms, the shape selected anew in between" : "2500 ms, and the shape could not be selected anew"}: an absent handle, not one that takes no press`,
      );
    }
    notes.push("the resize handle came only after the shape was selected anew");
  }
  if (!handle.hit?.reachable || !/djs-resizer-hit/.test(handle.hit.what)) {
    return entryBroken(
      did,
      expected,
      "the resize handle",
      handle.box,
      handle.hit ?? { reachable: false, element: null, what: "no handle", popup: false, palette: false, pad: false },
    );
  }
  const from = aimAt(c.map, middle(handle.box));
  const run = await dragAndRead(c, from, times(options.travel, c.view.a), { hold: ["Control"] });
  const started = run.gesture.marks.includes(".djs-resize-overlay");
  const trueTravel = run.travel;
  const [was, now] = [c.model.shapes[options.id]!, run.after.shapes[options.id]!];
  const grown = { x: now.width - was.width, y: now.height - was.height };
  const wanted = options.dimension === "width" ? { x: trueTravel.x, y: 0 } : { x: 0, y: trueTravel.y };
  const moved = options.dimension === "width" ? grown.x / trueTravel.x : grown.y / trueTravel.y;
  return {
    did,
    expected: `${expected}: ${round(options.dimension === "width" ? trueTravel.x : trueTravel.y)} units`,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: {
      handlePx: `${round(handle.box.width, 1)}x${round(handle.box.height, 1)}`,
      pointerPx: rounded(run.dragged.delta),
      expectedUnits: rounded(wanted),
      modelUnits: grown,
      errorUnits: rounded(minus(grown, wanted)),
      ratio: round(moved, 3),
    },
    checks: [
      startCheck(started, "the resize frame", run.gesture.marks),
      valueCheck("size", grown, wanted, tolerance(c.view, FREE), `${options.dimension} of ${options.id}`),
      viewKept(run.scrolled),
    ],
    key: `ratio ${moved.toFixed(2)}, off ${fixed(options.dimension === "width" ? grown.x - wanted.x : grown.y - wanted.y, 1)} u`,
    notes,
  };
}

/** every element of the model fully inside a diagram rectangle, as bpmn-js's lasso names them */
function enclosed(model: Model, a: Point, b: Point, margin: number): { clear: string[]; ambiguous: string[] } {
  const clear: string[] = [];
  const ambiguous: string[] = [];
  const place = (id: string, box: Box): void => {
    const gaps = [box.x - a.x, box.y - a.y, b.x - (box.x + box.width), b.y - (box.y + box.height)];
    if (gaps.every((gap) => gap > margin)) clear.push(id);
    else if (gaps.every((gap) => gap > -margin)) ambiguous.push(id);
  };
  for (const [id, box] of Object.entries(model.shapes)) place(id, box);
  for (const [id, box] of Object.entries(model.labels)) place(`${id}_label`, box);
  for (const [id, points] of Object.entries(model.edges)) {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const [x, y] = [Math.min(...xs), Math.min(...ys)];
    place(id, { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
  }
  return { clear, ambiguous };
}

/** the lasso tool: the selection against what lies inside the rectangle on screen */
async function lasso(c: Ctx): Promise<Outcome> {
  const did =
    "clicked the palette's lasso tool and dragged a rectangle around the rejection task, the call activity and the fulfilled end event";
  const expected =
    "the selection is exactly the elements whose bounds lie inside the rectangle the pointer drew on screen";
  const entry = await paletteEntry(c, "lasso-tool");
  if (!entry.hit.reachable || !entry.hit.palette)
    return entryBroken(did, expected, "the palette entry", entry.box, entry.hit);
  // at least 10 units clear of every element's edge, and far from the node's border (auto-scroll)
  const [from, to] = [at(c, { x: 580, y: 370 }), at(c, { x: 1120, y: 525 })];
  for (const point of [from, to]) {
    const hit = await c.node.hit(point);
    if (!hit.reachable || hit.palette || hit.pad)
      throw new Unmeasured(`a corner of the rectangle (${pair(point)} px) is not on the canvas: ${hitText(hit)}`);
  }
  await c.board.click(aimAt(c.map, middle(entry.box)));
  await c.board.page.waitForTimeout(60);
  const dragged = await c.node.drag(from, minus(to, from), { keepDown: true });
  const gesture = await gestureOf(c.node);
  const [overlay] = await c.node.query(".djs-lasso-overlay");
  const viewHeld = await viewOf(c.node);
  await c.board.release();
  await c.board.page.waitForTimeout(120);
  const selected = await c.node.selected();
  await c.board.press("Escape");
  // each corner through the view of its moment
  const [a, b] = [toDiagram(c.view, dragged.from), toDiagram(viewHeld, dragged.to)];
  const scrolled = { x: viewHeld.e - c.view.e, y: viewHeld.f - c.view.f };
  const truth = enclosed(c.model, a, b, 2 + 2 / c.view.a);
  const counted = selected.filter((id) => !truth.ambiguous.includes(id));
  const started = gesture.marks.includes(".djs-lasso-overlay");
  const drawn = { x: dragged.from.x, y: dragged.from.y, width: dragged.delta.x, height: dragged.delta.y };
  const frameOff = overlay
    ? {
        x: Math.max(Math.abs(overlay.x - drawn.x), Math.abs(overlay.x + overlay.width - drawn.x - drawn.width)),
        y: Math.max(Math.abs(overlay.y - drawn.y), Math.abs(overlay.y + overlay.height - drawn.y - drawn.height)),
      }
    : null;
  const check = setCheck(
    "selection",
    counted,
    truth.clear,
    "selected elements against the elements inside the rectangle on screen",
    "broken",
  );
  return {
    did,
    expected,
    started,
    marks: gesture.marks,
    scrolled,
    measured: {
      rectangleUnits: [rounded(a), rounded(b)],
      insideOnScreen: truth.clear,
      selected,
      ambiguous: truth.ambiguous,
      lassoFrameOffPx: frameOff && rounded(frameOff),
    },
    checks: [startCheck(started, "the lasso frame", gesture.marks), check, viewKept(scrolled)],
    key: check.ok
      ? `${counted.length} of ${truth.clear.length} selected`
      : `${counted.filter((id) => truth.clear.includes(id)).length} of ${truth.clear.length} selected, ${counted.filter((id) => !truth.clear.includes(id)).length} wrong`,
    notes:
      frameOff && Math.max(frameOff.x, frameOff.y) > 3
        ? [`the lasso frame is drawn up to ${pair(frameOff)} px off the pointer's rectangle`]
        : [],
  };
}

/** the flow nodes of the model: what the space tool moves (containers are resized, labels follow) */
const flowNodes = (model: Model): string[] =>
  Object.keys(model.shapes).filter((id) => id !== PARTICIPANT && id !== SUBPROCESS && !LANES.includes(id as never));

/** the space tool: which shapes move, and by how much */
async function spaceTool(c: Ctx): Promise<Outcome> {
  const did =
    "clicked the palette's space tool, pressed in the first lane right of the rejection task and dragged 40 units to the right, Control held after the press";
  const expected =
    "exactly the flow nodes that begin right of the true press position move, by the pointer's travel over the on-screen scale, and the pool grows by the same";
  const entry = await paletteEntry(c, "space-tool");
  if (!entry.hit.reachable || !entry.hit.palette)
    return entryBroken(did, expected, "the palette entry", entry.box, entry.hit);
  const from = await dropSpot(c, { x: 745, y: 250 }, "Lane_order_management");
  await c.board.click(aimAt(c.map, middle(entry.box)));
  await c.board.page.waitForTimeout(60);
  const run = await dragAndRead(c, from, { x: 40 * c.view.a, y: 0 }, { hold: ["Control"] });
  await c.board.press("Escape");
  const started = run.gesture.marks.includes(".djs-drag-group") || run.gesture.marks.includes(".djs-resize-overlay");
  const startX = toDiagram(c.view, run.dragged.from).x;
  const travel = run.travel.x;
  const nodes = flowNodes(c.model);
  const margin = 2 + 2 / c.view.a;
  const shouldMove = nodes.filter((id) => c.model.shapes[id]!.x > startX + margin);
  const ambiguous = nodes.filter((id) => Math.abs(c.model.shapes[id]!.x - startX) <= margin);
  const moved = nodes.filter(
    (id) => run.after.shapes[id] && !same(run.after.shapes[id], c.model.shapes[id]) && !ambiguous.includes(id),
  );
  const deltas = moved.map((id) => minus(run.after.shapes[id]!, c.model.shapes[id]!));
  const worst = deltas.reduce(
    (a, b) => (Math.abs(a.x - travel) + Math.abs(a.y) >= Math.abs(b.x - travel) + Math.abs(b.y) ? a : b),
    { x: travel, y: 0 },
  );
  const pool = run.after.shapes[PARTICIPANT]!.width - c.model.shapes[PARTICIPANT]!.width;
  const limit = tolerance(c.view, FREE);
  return {
    did,
    expected,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: {
      truePressX: round(startX),
      expectedUnits: round(travel),
      shouldMove,
      moved,
      modelUnits: moved.length > 0 ? worst : null,
      poolGrewUnits: pool,
      ratio: round(worst.x / travel, 3),
    },
    checks: [
      startCheck(started, "the space tool's preview", run.gesture.marks),
      setCheck(
        "moved set",
        moved,
        shouldMove,
        "flow nodes whose bounds changed against those right of the true press position",
        "wrong-data",
      ),
      valueCheck("displacement", worst, { x: travel, y: 0 }, limit, "bounds of the worst moved shape"),
      valueCheck("pool", { x: pool, y: 0 }, { x: travel, y: 0 }, limit, "width of the participant"),
      viewKept(run.scrolled),
    ],
    // no shape moved: `worst` is then the seed of the reduce above, not a measurement
    key: `${moved.filter((id) => shouldMove.includes(id)).length} of ${shouldMove.length} right, ${moved.filter((id) => !shouldMove.includes(id)).length} wrong, ${moved.length > 0 ? `ratio ${(worst.x / travel).toFixed(2)}` : "none moved"}`,
    notes: [],
  };
}

/** a view displacement against the pointer's travel, both in screen px */
function followCheck(moved: Point, pointer: Point): Check {
  const error = minus(moved, pointer);
  return {
    name: "follows",
    rule: "the diagram's displacement on screen equals the pointer's travel within 2 px per axis",
    ok: within(error, 2),
    detail: `diagram ${pair(moved)} px, pointer ${pair(pointer)} px, ${(moved.x / pointer.x).toFixed(2)}/${(moved.y / pointer.y).toFixed(2)}`,
    fails: "degraded",
  };
}

/** the hand tool: diagram displacement over pointer travel */
async function handTool(c: Ctx): Promise<Outcome> {
  const did = "clicked the palette's hand tool, pressed in the first lane and dragged";
  const expected = "the diagram moves on screen by the pointer's travel (ratio 1), nothing is written";
  const entry = await paletteEntry(c, "hand-tool");
  if (!entry.hit.reachable || !entry.hit.palette)
    return entryBroken(did, expected, "the palette entry", entry.box, entry.hit);
  const from = await dropSpot(c, { x: 745, y: 250 }, "Lane_order_management");
  await c.board.click(aimAt(c.map, middle(entry.box)));
  await c.board.page.waitForTimeout(60);
  const run = await dragAndRead(c, from, { x: -60 * c.zoom, y: 35 * c.zoom });
  await c.board.press("Escape");
  await c.board.page.waitForTimeout(100);
  const settled = await viewOf(c.node);
  const moved = { x: run.viewAfter.e - c.view.e, y: run.viewAfter.f - c.view.f };
  const held = { x: run.viewHeld.e - c.view.e, y: run.viewHeld.f - c.view.f };
  const started = Math.hypot(held.x, held.y) > 2;
  return {
    did: `${did} by ${pair(run.dragged.delta)} screen px`,
    expected,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: {
      pointerPx: rounded(run.dragged.delta),
      diagramPx: rounded(moved),
      ratio: { x: round(moved.x / run.dragged.delta.x, 3), y: round(moved.y / run.dragged.delta.y, 3) },
      scaleKept: Math.abs(settled.a / c.view.a - 1) < 1e-4,
      afterSettlePx: rounded({ x: settled.e - c.view.e, y: settled.f - c.view.f }),
      fileChanged: run.changed,
    },
    checks: [
      {
        name: "starts",
        rule: "the diagram has moved while the button is down",
        ok: started,
        detail: `${pair(held)} px`,
        fails: "broken",
      },
      followCheck(moved, run.dragged.delta),
      {
        name: "no write",
        rule: "the file is as before",
        ok: !run.changed,
        detail: run.changed ? "changed" : "same",
        fails: "wrong-data",
      },
    ],
    key: `ratio ${(moved.x / run.dragged.delta.x).toFixed(2)}/${(moved.y / run.dragged.delta.y).toFixed(2)}`,
    notes: [],
  };
}

/** a point of the bare canvas inside the host (the root's own surface): where a plain drag pans */
async function freeCanvas(c: Ctx): Promise<Point | null> {
  const host = c.env.host;
  for (const fy of [0.03, 0.5, 0.2, 0.8, 0.97]) {
    for (const fx of [0.5, 0.985, 0.97, 0.015, 0.03, 0.8, 0.3]) {
      const point = aimAt(c.map, { x: host.x + host.width * fx, y: host.y + host.height * fy });
      const hit = await c.node.hit(point);
      if (hit.reachable && !hit.palette && !hit.pad && !hit.popup && /^svg/.test(hit.what)) return point;
    }
  }
  return null;
}

/**
 * The pool's label band is where a press selects or moves the pool. Where the palette covers all
 * of it (an editor whose chrome keeps its screen size, at a board zoom around 0.73), the canvas is
 * panned 40 px down first, as a person would: the case then runs on the view of after the pan.
 */
async function uncoverBand(c: Ctx): Promise<string | null> {
  if (await reach(c, PARTICIPANT, BAND)) return null;
  const from = await freeCanvas(c);
  if (!from) return null;
  await c.node.drag(from, { x: 0, y: 40 });
  await c.board.page.waitForTimeout(200);
  c.view = await viewOf(c.node);
  return "the pool's label band lay under the palette: the canvas was panned 40 px down first";
}

/** a plain canvas pan: a drag that starts on the empty canvas */
async function canvasPan(c: Ctx): Promise<Outcome> {
  const from = await freeCanvas(c);
  if (!from)
    throw new Unmeasured("no point of the bare canvas inside the node: the diagram and the editor's chrome cover it");
  const host = c.env.host;
  const towards = { x: host.x + host.width / 2 > from.x ? 1 : -1, y: host.y + host.height / 2 > from.y ? 1 : -1 };
  const run = await dragAndRead(c, from, { x: towards.x * 50 * c.zoom, y: towards.y * 30 * c.zoom });
  const moved = { x: run.viewAfter.e - c.view.e, y: run.viewAfter.f - c.view.f };
  const held = { x: run.viewHeld.e - c.view.e, y: run.viewHeld.f - c.view.f };
  const started = Math.hypot(held.x, held.y) > 2;
  return {
    did: `pressed the empty canvas at ${pair(from)} px and dragged by ${pair(run.dragged.delta)} screen px`,
    expected: "the diagram moves on screen by the pointer's travel (ratio 1), nothing is written",
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: {
      pointerPx: rounded(run.dragged.delta),
      diagramPx: rounded(moved),
      ratio: { x: round(moved.x / run.dragged.delta.x, 3), y: round(moved.y / run.dragged.delta.y, 3) },
      fileChanged: run.changed,
    },
    checks: [
      {
        name: "starts",
        rule: "the diagram has moved while the button is down",
        ok: started,
        detail: `${pair(held)} px`,
        fails: "broken",
      },
      followCheck(moved, run.dragged.delta),
      {
        name: "no write",
        rule: "the file is as before",
        ok: !run.changed,
        detail: run.changed ? "changed" : "same",
        fails: "wrong-data",
      },
    ],
    key: `ratio ${(moved.x / run.dragged.delta.x).toFixed(2)}/${(moved.y / run.dragged.delta.y).toFixed(2)}`,
    notes: [],
  };
}

/** hovers a point of a connection (bpmn-js shows its bendpoints then) and says what a press there reaches */
async function hoverFlow(c: Ctx, flow: string, diagram: Point): Promise<{ point: Point; hit: Hit }> {
  const point = at(c, diagram);
  await c.board.move(point, 3);
  await c.board.page.waitForTimeout(100);
  const hit = await c.node.hit(point);
  if (!hit.reachable || hit.element !== flow) {
    throw new Unmeasured(`${flow} takes no press at ${pair(diagram, 0)} (${pair(point)} px): ${hitText(hit)}`);
  }
  return { point, hit };
}

const panNote = (c: Ctx, run: Dragging): string[] => {
  const moved = { x: run.viewAfter.e - c.view.e, y: run.viewAfter.f - c.view.f };
  return Math.hypot(moved.x, moved.y) > 1 ? [`the canvas panned by ${pair(moved)} px instead`] : [];
};

/** move an existing bendpoint of a sequence flow */
async function bendpointMove(c: Ctx): Promise<Outcome> {
  const flow = "Flow_to_invoice";
  // its corner; the release point is more than 12 units from every line bpmn-js snaps a bendpoint to
  const { point } = await hoverFlow(c, flow, { x: 930, y: 170 });
  const run = await dragAndRead(c, point, times({ x: 45, y: 80 }, c.view.a), { hold: ["Control"] });
  const started = run.gesture.marks.includes(".djs-bendpoint.djs-dragging");
  const released = toDiagram(run.viewHeld, run.dragged.to);
  const points = run.after.edges[flow] ?? [];
  const nearest = points.reduce((a, b) =>
    Math.hypot(a.x - released.x, a.y - released.y) <= Math.hypot(b.x - released.x, b.y - released.y) ? a : b,
  );
  const error = minus(nearest, released);
  const viewMoved = { x: run.viewAfter.e - c.view.e, y: run.viewAfter.f - c.view.f };
  return {
    did: `hovered ${flow}, pressed its corner at 930,170 and dragged by ${pair(run.dragged.delta)} screen px, Control held after the press`,
    expected: `the flow in the file has a waypoint at the true release position ${pair(released)}`,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: {
      releasedAtUnits: rounded(released),
      waypoints: points,
      nearestWaypoint: nearest,
      errorUnits: rounded(error),
      errorPx: rounded(times(error, c.view.a)),
      viewMovedPx: rounded(viewMoved),
    },
    checks: [
      startCheck(started, "the dragged bendpoint", run.gesture.marks),
      valueCheck("waypoint", nearest, released, tolerance(c.view, FREE), "the waypoint nearest to the release"),
      ...(started ? [viewKept(run.scrolled)] : []),
    ],
    key: started
      ? `off ${pair(times(error, c.view.a), 0)} px`
      : `not started${Math.hypot(viewMoved.x, viewMoved.y) > 1 ? `, canvas panned ${pair(viewMoved, 0)} px` : ""}`,
    notes: panNote(c, run),
  };
}

/** move a segment of a sequence flow sideways */
async function segmentMove(c: Ctx): Promise<Outcome> {
  const flow = "Flow_to_invoice";
  const { point } = await hoverFlow(c, flow, { x: 930, y: 300 });
  const run = await dragAndRead(c, point, times({ x: 34, y: 6 }, c.view.a), { hold: ["Control"] });
  const started = run.gesture.marks.includes(".djs-segment-dragger.djs-dragging");
  const released = toDiagram(run.viewHeld, run.dragged.to);
  const points = run.after.edges[flow] ?? [];
  // the vertical segment is the one between the last two waypoints of this flow
  const segmentX = points[points.length - 1]?.x ?? Number.NaN;
  const viewMoved = { x: run.viewAfter.e - c.view.e, y: run.viewAfter.f - c.view.f };
  return {
    did: `hovered ${flow}, pressed the middle of its vertical segment at 930,300 and dragged by ${pair(run.dragged.delta)} screen px, Control held after the press`,
    expected: `the segment's x in the file is the true release position's x, ${round(released.x)}`,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: {
      releasedAtUnits: rounded(released),
      waypoints: points,
      segmentX,
      errorUnits: round(segmentX - released.x),
      errorPx: round((segmentX - released.x) * c.view.a),
      viewMovedPx: rounded(viewMoved),
    },
    checks: [
      startCheck(started, "the dragged segment", run.gesture.marks),
      valueCheck(
        "segment",
        { x: segmentX, y: 0 },
        { x: released.x, y: 0 },
        tolerance(c.view, FREE),
        "x of the moved segment",
      ),
    ],
    key: started
      ? `off ${round((segmentX - released.x) * c.view.a, 0)} px`
      : `not started${Math.hypot(viewMoved.x, viewMoved.y) > 1 ? `, canvas panned ${pair(viewMoved, 0)} px` : ""}`,
    notes: panNote(c, run),
  };
}

/** drag a connection's end to another shape */
async function reconnectEnd(c: Ctx): Promise<Outcome> {
  const flow = "Flow_to_rejected";
  const target = await targetPoint(c, ["Task_fulfill_order", "CallActivity_invoice_handling"]);
  // 4 units before its last waypoint: bpmn-js takes a press within 10 units of an end for the end
  const { point } = await hoverFlow(c, flow, { x: 756, y: 290 });
  const run = await dragAndRead(c, point, minus(target.point, point), { steps: 16 });
  const started = run.gesture.marks.includes(".djs-bendpoint.djs-dragging");
  const ends = run.after.refs[flow];
  const viewMoved = { x: run.viewAfter.e - c.view.e, y: run.viewAfter.f - c.view.f };
  return {
    did: `hovered ${flow}, pressed its end at the rejected end event and dragged it onto ${target.id}`,
    expected: `the flow's target in the file is the shape under the pointer at the release, ${target.id}`,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: {
      targetUnderPointer: target.id,
      targetInFile: ends?.target ?? null,
      waypoints: run.after.edges[flow] ?? null,
      connectOkMarker: run.gesture.marked["connect-ok"],
      viewMovedPx: rounded(viewMoved),
    },
    checks: [
      startCheck(started, "the dragged connection end", run.gesture.marks),
      setCheck(
        "target",
        [ends?.target ?? "none"],
        [target.id],
        "the flow's target against the shape under the pointer",
        "wrong-data",
      ),
      dockingCheck(run.after, flow, target.id),
    ],
    key: started
      ? `target ${ends?.target === target.id ? "right" : `WRONG (${ends?.target})`}`
      : `not started${Math.hypot(viewMoved.x, viewMoved.y) > 1 ? `, canvas panned ${pair(viewMoved, 0)} px` : ""}`,
    notes: panNote(c, run),
  };
}

/** move an external label */
async function labelMove(c: Ctx): Promise<Outcome> {
  const owners = ["EndEvent_order_rejected", "Gateway_credit_approved", "EndEvent_order_fulfilled"];
  const { id, point, passed } = await firstReachable(
    c,
    owners.map((owner) => `${owner}_label`),
  );
  const owner = id.replace(/_label$/, "");
  const run = await dragAndRead(c, point, times({ x: 23, y: 17 }, c.view.a), { hold: ["Control"] });
  const started = run.gesture.marks.includes(".djs-drag-group");
  const expected = run.travel;
  const moved = minus(run.after.labels[owner]!, c.model.labels[owner]!);
  const ownerMoved = !same(run.after.shapes[owner], c.model.shapes[owner]);
  return {
    did: `pressed the external label of ${owner} and dragged it by ${pair(run.dragged.delta)} screen px, Control held after the press`,
    expected: `the label's bounds in the file move by ${pair(expected)} units, its shape stays`,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: {
      label: id,
      passedOver: passed,
      pointerPx: rounded(run.dragged.delta),
      expectedUnits: rounded(expected),
      modelUnits: moved,
      errorUnits: rounded(minus(moved, expected)),
      ratio: { x: round(moved.x / expected.x, 3), y: round(moved.y / expected.y, 3) },
    },
    checks: [
      startCheck(started, "the label's move preview", run.gesture.marks),
      valueCheck("displacement", moved, expected, tolerance(c.view, FREE), "bounds of the label"),
      viewKept(run.scrolled),
      {
        name: "owner",
        rule: "the label's shape keeps its bounds",
        ok: !ownerMoved,
        detail: ownerMoved ? "moved" : "same",
        fails: "wrong-data",
      },
    ],
    key: ratioText(moved, expected),
    notes: passed.length > 0 ? [`passed over (covered by the editor's chrome): ${passed.join(", ")}`] : [],
  };
}

/**
 * Auto-scroll: the pool is dragged by its label band to the editor's left edge and held there, then
 * moved back out of every scroll zone and dropped. diagram-js scrolls 10 container px every 15 ms
 * while a drag's pointer is within 20 px of the container's edge, both in the px of ITS document.
 */
async function autoScroll(c: Ctx): Promise<Outcome> {
  const host = c.env.host;
  // clear of the scroll zone whether it is 20 screen px or 20 px of a scaled document
  const margin = 24 * Math.max(1, c.zoom);
  const clear = async (point: Point): Promise<Point | null> => {
    const aimed = aimAt(c.map, point);
    const insideMargins =
      aimed.x > host.x + margin &&
      aimed.x < host.x + host.width - margin &&
      aimed.y > host.y + margin &&
      aimed.y < host.y + host.height - margin;
    if (!insideMargins) return null;
    const hit = await c.node.hit(aimed);
    return hit.reachable && !hit.palette && !hit.pad && !hit.popup ? aimed : null;
  };
  let press: Point | null = null;
  let out: Point | null = null;
  for (const [fx, fy] of BAND) {
    const point = await reach(c, PARTICIPANT, [[fx, fy]]);
    if (!point) continue;
    // the drop point: beside the press, else the middle of the editor; outside the zones, not on the chrome
    const y = Math.min(Math.max(point.y, host.y + margin + 2), host.y + host.height - margin - 2);
    out =
      (await clear({ x: Math.max(point.x + 40 * c.zoom, host.x + margin + 2), y })) ??
      (await clear({ x: host.x + host.width / 2, y: host.y + host.height / 2 })) ??
      (await clear({ x: host.x + host.width * 0.7, y: host.y + host.height * 0.4 }));
    if (out) {
      press = point;
      break;
    }
  }
  if (!press || !out)
    throw new Unmeasured(
      "the participant's label band takes no press, or no free drop point lies outside the scroll zones (the palette covers them)",
    );
  const edge = aimAt(c.map, { x: host.x + Math.min(3, (press.x - host.x) / 3), y: press.y });
  const before = await c.board.fileText(FILE);
  const { mouse, keyboard } = c.board.page;
  await mouse.move(press.x, press.y);
  await mouse.down();
  for (let step = 1; step <= 6; step++) await mouse.move(press.x + ((edge.x - press.x) * step) / 6, press.y);
  await keyboard.down("Control");
  await mouse.move(edge.x, edge.y);
  const gesture = await gestureOf(c.node);
  const atEdge = await viewOf(c.node);
  const clock = Date.now();
  await c.board.page.waitForTimeout(400);
  const afterHold = await viewOf(c.node);
  const heldMs = Date.now() - clock;
  await mouse.move(out.x, out.y, { steps: 5 });
  await c.board.page.waitForTimeout(120);
  const atRest = await viewOf(c.node);
  await c.board.page.waitForTimeout(60);
  const atDrop = await viewOf(c.node);
  await mouse.up();
  await keyboard.up("Control");
  const { changed, after } = await settledModel(c, before);
  await c.board.page.waitForTimeout(150);
  const settled = await viewOf(c.node);
  const started = gesture.marks.includes(".djs-drag-group");
  const scrolled = afterHold.e - atEdge.e;
  const total = { x: atDrop.e - c.view.e, y: atDrop.f - c.view.f };
  const stillScrolling = Math.hypot(atDrop.e - atRest.e, atDrop.f - atRest.f) > 0.5;
  // where the pointer was in the diagram at the press and at the drop: each through the view of its moment
  const expected = minus(toDiagram(atDrop, out), toDiagram(c.view, press));
  const moved = minus(after.shapes[PARTICIPANT]!, c.model.shapes[PARTICIPANT]!);
  const error = minus(moved, expected);
  // what the pointer itself travelled between press and drop, without the scroll: the part a wrong scale gets wrong
  const pointerUnits = times(minus(out, press), 1 / c.view.a);
  const jump = Math.hypot(settled.e - atDrop.e, settled.f - atDrop.f);
  const limit = tolerance(c.view, FREE);
  const landed = within(error, limit);
  return {
    did: `pressed the pool's label band, dragged it to ${round(edge.x - host.x, 1)} px from the editor's left edge, held 400 ms, moved back out of the scroll zones and dropped, Control held after the press`,
    expected:
      "the canvas scrolls while the pointer is held at the edge, and the pool lands where the pointer is: its position in the file moves by the true pointer travel in the diagram, the scroll included",
    started,
    marks: gesture.marks,
    measured: {
      edgeDistancePx: round(edge.x - host.x, 1),
      pointerTravelUnits: rounded(pointerUnits, 0),
      scrolledWhileHeld: Math.abs(scrolled) > 2,
      scrollDirection: scrolled > 2 ? "content moves right" : scrolled < -2 ? "content moves left" : "none",
      toleranceUnits: round(limit),
      landed,
      viewJumpAfterDrop: jump > 1,
    },
    volatile: {
      heldMs,
      scrolledPx: round(scrolled, 1),
      scrollPxPerSecond: round((scrolled / heldMs) * 1000, 0),
      scrollUnitsPerSecond: round((scrolled / c.view.a / heldMs) * 1000, 0),
      totalScrollPx: rounded(total, 1),
      expectedUnits: rounded(expected),
      modelUnits: moved,
      errorUnits: rounded(error),
      errorOverPointerTravel: round(
        Math.hypot(error.x, error.y) / Math.max(1, Math.hypot(pointerUnits.x, pointerUnits.y)),
        2,
      ),
      viewJumpAfterDropPx: round(jump, 1),
      fileChanged: changed,
    },
    checks: [
      startCheck(started, "the pool's move preview", gesture.marks),
      {
        name: "scrolls",
        rule: "the diagram moved by more than 2 px on screen during the 400 ms at the edge",
        ok: Math.abs(scrolled) > 2,
        detail: Math.abs(scrolled) > 2 ? "scrolled" : "did not scroll",
        fails: "broken",
      },
      {
        name: "rests",
        rule: "the scroll stops once the pointer is back outside the zones",
        ok: !stillScrolling,
        detail: stillScrolling ? "still scrolling at the drop" : "at rest",
        fails: "degraded",
      },
      {
        name: "lands",
        rule: `position of the participant: |model - true pointer travel| <= ${round(limit)} units per axis`,
        ok: landed,
        // the scroll's share differs from run to run: the numbers are in the volatile part
        detail: landed ? "lands under the pointer" : "lands off the pointer",
        fails: "wrong-data",
      },
    ],
    key: `${Math.abs(scrolled) > 2 ? "scrolls" : "NO SCROLL"}, ${landed ? "lands right" : "LANDS WRONG"}`,
    notes: [],
  };
}

/** move a task into another lane: the lane that lists it against the lane under the pointer */
async function dropLane(c: Ctx): Promise<Outcome> {
  const id = "Task_fulfill_order";
  const point = await reach(c, id);
  if (!point) throw new Unmeasured(`${id} takes no press (covered by the editor's chrome)`);
  const to = await dropSpot(c, { x: 820, y: 660 }, "Lane_customer_support");
  const run = await dragAndRead(c, point, minus(to, point), { hold: ["Control"], steps: 20 });
  const started = run.gesture.marks.includes(".djs-drag-group");
  const released = toDiagram(run.viewHeld, run.dragged.to);
  const expected = run.travel;
  const moved = minus(run.after.shapes[id]!, c.model.shapes[id]!);
  const [under, holds] = [laneAt(c.model, released), lanesOf(run.after, id)];
  const now = run.after.shapes[id]!;
  const pool = run.after.shapes[PARTICIPANT]!;
  const insidePool =
    now.x >= pool.x &&
    now.y >= pool.y &&
    now.x + now.width <= pool.x + pool.width &&
    now.y + now.height <= pool.y + pool.height;
  return {
    did: `pressed ${id} (first lane) and dragged it onto the third lane, Control held after the press`,
    expected: `the lane that lists the task in the file is the lane under the pointer at the release (${under.join(", ")}), and the task's bounds move by ${pair(expected)} units`,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: {
      laneUnderPointer: under,
      laneInFile: holds,
      expectedUnits: rounded(expected),
      modelUnits: moved,
      errorUnits: rounded(minus(moved, expected)),
      insidePool,
      poolChanged: !same(pool, c.model.shapes[PARTICIPANT]),
    },
    checks: [
      startCheck(started, "the move preview", run.gesture.marks),
      setCheck("lane", holds, under, "the lane that lists the task against the lane under the pointer", "wrong-data"),
      valueCheck("displacement", moved, expected, tolerance(c.view, FREE), "bounds of the task"),
      viewKept(run.scrolled),
    ],
    key: `lane ${same(under, holds) ? "right" : `WRONG (${holds.map((lane) => lane.replace("Lane_", "")).join("+") || "none"})`}, ${ratioText(moved, expected)}`,
    notes: [],
  };
}

/** create a shape inside an expanded sub-process: its parent in the file against the element under the pointer */
async function dropContainer(c: Ctx): Promise<Outcome> {
  const did = "dragged the palette's intermediate event entry into the expanded event sub-process";
  const expected = `a new event whose parent in the file is the element under the pointer (${SUBPROCESS}) and whose centre is the true pointer position; the sub-process keeps its bounds`;
  const entry = await paletteEntry(c, "create.intermediate-event");
  if (!entry.hit.reachable || !entry.hit.palette)
    return entryBroken(did, expected, "the palette entry", entry.box, entry.hit);
  const drop = await dropSpot(c, { x: 530, y: 618 }, SUBPROCESS);
  const from = aimAt(c.map, middle(entry.box));
  const run = await dragAndRead(c, from, minus(drop, from), { palette: entry.box });
  await c.board.press("Escape");
  const started = run.gesture.marks.includes(".djs-drag-group");
  const result = createdChecks(c, run.viewHeld, run.after, run.dragged.to, {
    type: "intermediateThrowEvent",
    parent: SUBPROCESS,
    base: GRID,
  });
  const ids = added(c.model.shapes, run.after.shapes);
  const box = ids[0] ? run.after.shapes[ids[0]] : undefined;
  const was = c.model.shapes[SUBPROCESS]!;
  const insideOld =
    !!box &&
    box.x >= was.x &&
    box.y >= was.y &&
    box.x + box.width <= was.x + was.width &&
    box.y + box.height <= was.y + was.height;
  return {
    did,
    expected,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: {
      ...result.measured,
      newParentMarker: run.gesture.marked["new-parent"],
      insideTheContainerAsItWas: insideOld,
    },
    checks: [startCheck(started, "the create preview", run.gesture.marks), ...result.checks, viewKept(run.scrolled)],
    key: `${result.key}, parent ${result.measured.parentInFile === SUBPROCESS ? "right" : "WRONG"}${insideOld ? "" : ", OUTSIDE it"}`,
    notes: [],
  };
}

// ── nice to have ─────────────────────────────────────────────────────────────

/** paste with the pointer position as the paste point: Control+C on a selected task, Control+V, click */
async function pasteAtPointer(c: Ctx): Promise<Outcome> {
  const { id, point } = await firstReachable(c, ["Task_check_credit", "Task_fulfill_order"]);
  const drop = await dropSpot(c, FREE_SPOT, "Lane_order_management");
  await c.board.click(point);
  const selected = await c.board.waitFor(async () => (await c.node.selected()).includes(id), 2500);
  if (!selected) throw new Unmeasured(`a click did not select ${id}`);
  const before = await c.board.fileText(FILE);
  await c.board.press("Control+C");
  await c.board.move(drop, 12);
  await c.board.page.waitForTimeout(60);
  await c.board.press("Control+V");
  await c.board.page.waitForTimeout(80);
  // the preview appears where the engine believes the pointer is, before any further move
  const atPaste = await gestureOf(c.node);
  const [preview] = await c.node.query(".djs-drag-group");
  const previewOff = preview ? minus(middle(preview), drop) : null;
  const viewAtDrop = await viewOf(c.node);
  const scrolled = { x: viewAtDrop.e - c.view.e, y: viewAtDrop.f - c.view.f };
  await c.board.click(drop);
  const { after } = await settledModel(c, before);
  await c.board.press("Escape");
  const started = atPaste.marks.includes(".djs-drag-active");
  const type = c.model.type[id] ?? "task";
  const result = createdChecks(c, viewAtDrop, after, drop, { type, lane: true, base: GRID });
  return {
    did: `selected ${id}, pressed Control+C, moved the pointer to a free spot of the first lane, pressed Control+V and clicked`,
    expected:
      "a copy of the task whose centre in the file is the true pointer position at the click, listed in the lane under the pointer",
    started,
    marks: atPaste.marks,
    scrolled,
    measured: { ...result.measured, copied: id, previewOffPx: previewOff && rounded(previewOff) },
    checks: [
      {
        name: "starts",
        rule: "Control+V starts a placement (the editor's drag marker shows)",
        ok: started,
        detail: atPaste.marks.join(" ") || "no drag marker",
        fails: "broken",
      },
      ...result.checks,
      viewKept(scrolled),
    ],
    key: result.key,
    notes:
      previewOff && Math.hypot(previewOff.x, previewOff.y) > 6 * c.view.a + 2
        ? [`the paste preview is drawn ${pair(previewOff)} px from the pointer`]
        : [],
  };
}

/** alignment guides: a task is dragged so that its middle comes within 7 units of another task's middle line */
async function snapGuides(c: Ctx): Promise<Outcome> {
  const [id, other] = ["CallActivity_invoice_handling", "Task_fulfill_order"];
  const point = await reach(c, id, [[0.5, 0.5]]);
  if (!point) throw new Unmeasured(`${id} takes no press at its middle (covered by the editor's chrome)`);
  const [start, line] = [middle(c.model.shapes[id]!), middle(c.model.shapes[other]!).x];
  // the middle of the dragged task comes to rest 3 units right of the other task's middle line
  const run = await dragAndRead(c, point, times({ x: line + 3 - start.x, y: 35 }, c.view.a));
  const started = run.gesture.marks.includes(".djs-drag-group");
  const trueMiddle = { x: start.x + run.travel.x, y: start.y + run.travel.y };
  const near = Math.abs(trueMiddle.x - line) <= 5.5;
  const now = middle(run.after.shapes[id]!);
  return {
    did: `pressed ${id} at its middle and dragged it until its middle was ${round(trueMiddle.x - line, 1)} units from the middle line of ${other} (x = ${line}), grid and element snapping on`,
    expected: `bpmn-js snaps a move within 7 units of a sibling's middle line: the task's middle x in the file is ${line}, and the guide shows while the button is down`,
    started,
    marks: run.gesture.marks,
    scrolled: run.scrolled,
    measured: {
      trueMiddleUnits: rounded(trueMiddle),
      middleInFile: now,
      guideShown: run.gesture.marks.includes(".djs-snap-line"),
      offLineUnits: round(now.x - line),
    },
    checks: [
      startCheck(started, "the move preview", run.gesture.marks),
      {
        name: "aim",
        rule: "the true pointer brought the middle within 5.5 units of the line (else the case proves nothing)",
        ok: near,
        detail: `${round(trueMiddle.x - line, 1)} units`,
        fails: "degraded",
      },
      {
        name: "snaps",
        rule: `the task's middle x in the file equals the line's x (${line})`,
        ok: now.x === line,
        detail: `middle x ${now.x}, ${round(now.x - line)} units off the line`,
        fails: "wrong-data",
      },
      viewKept(run.scrolled),
    ],
    key: now.x === line ? "snapped to the line" : `NOT on the line (${round(now.x - line, 0)} units off)`,
    notes: [],
  };
}

/** what the top document has at a screen point, for a message */
const topElement = (board: Board, point: Point): Promise<string> =>
  board.page.evaluate(
    ([x, y]) => {
      const native = (window as NativeWindow).__boardSpikeNative;
      const element = native ? native.elementFromPoint(document, x, y) : document.elementFromPoint(x, y);
      return element
        ? `${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "").split(" ")[0]}`
        : "nothing";
    },
    [point.x, point.y] as const,
  );

/**
 * Presses a shape and takes the pointer out of the node's body through its upper edge: up to a point
 * just inside the editor's scroll zone, then in ONE move to 45 px above the body. No pointer event
 * falls inside the zone, as with a quick hand, so the canvas does not auto-scroll on the way and the
 * case stays about where the events go (auto-scroll has its own case). Returns the two points.
 */
async function leaveUpwards(c: Ctx, point: Point, hold: readonly string[]): Promise<{ inner: Point; outside: Point }> {
  const host = c.env.host;
  // clear of the scroll zone whether it is 20 screen px or 20 px of a scaled document
  const inner = aimAt(c.map, { x: point.x + 10 * c.zoom, y: host.y + 24 * Math.max(1, c.zoom) + 2 });
  const outside = { x: point.x + 20 * c.zoom, y: host.y - 45 };
  if (point.y - inner.y < 12) {
    throw new Unmeasured(
      "the shape lies too close to the editor's upper edge to leave without entering the scroll zone",
    );
  }
  const { mouse, keyboard } = c.board.page;
  await mouse.move(point.x, point.y);
  await mouse.down();
  await mouse.move(point.x, point.y - 4);
  await mouse.move(point.x, point.y - 8);
  for (const key of hold) await keyboard.down(key);
  for (let step = 1; step <= 4; step++) {
    await mouse.move(point.x + ((inner.x - point.x) * step) / 4, point.y - 8 + ((inner.y - point.y + 8) * step) / 4);
  }
  await mouse.move(outside.x, outside.y);
  await c.board.page.waitForTimeout(60);
  return { inner, outside };
}

/** the first task that takes a press and lies deep enough below the editor's upper edge for leaveUpwards */
async function excursionStart(c: Ctx): Promise<{ id: string; point: Point }> {
  for (const id of ["Task_reject_order", "CallActivity_invoice_handling", "Task_check_credit"]) {
    const point = await reach(c, id);
    if (point && point.y - (c.env.host.y + 24 * Math.max(1, c.zoom) + 2) >= 12) return { id, point };
  }
  throw new Unmeasured(
    "no task takes a press far enough below the editor's upper edge to leave without entering the scroll zone",
  );
}

/** a drag that leaves the node's body and comes back before the drop */
async function dragLeaveReturn(c: Ctx): Promise<Outcome> {
  const { id, point } = await excursionStart(c);
  const drop = aimAt(c.map, { x: point.x + 60 * c.view.a, y: point.y + 40 * c.view.a });
  const before = await c.board.fileText(FILE);
  const { mouse } = c.board.page;
  const { inner, outside } = await leaveUpwards(c, point, ["Control"]);
  const away = await gestureOf(c.node);
  const under = await topElement(c.board, outside);
  await mouse.move(inner.x, inner.y);
  for (let step = 1; step <= 6; step++) {
    await mouse.move(inner.x + ((drop.x - inner.x) * step) / 6, inner.y + ((drop.y - inner.y) * step) / 6);
  }
  await mouse.move(drop.x, drop.y);
  await c.board.page.waitForTimeout(60);
  const gesture = await gestureOf(c.node);
  const viewHeld = await viewOf(c.node);
  await c.board.release(["Control"]);
  const { after } = await settledModel(c, before);
  const started = gesture.marks.includes(".djs-drag-group");
  const expected = minus(toDiagram(viewHeld, drop), toDiagram(c.view, point));
  const moved = minus(after.shapes[id]!, c.model.shapes[id]!);
  return {
    did: `pressed ${id}, dragged the pointer 45 px above the node's body (over ${under}) and back, and dropped beside the start, Control held after the press`,
    expected:
      "the drag survives the excursion and the shape's bounds in the file move by the true pointer travel in the diagram",
    started,
    marks: gesture.marks,
    scrolled: { x: viewHeld.e - c.view.e, y: viewHeld.f - c.view.f },
    measured: {
      element: id,
      dragAliveOutside: away.marks.includes(".djs-drag-active"),
      underThePointerOutside: under,
      landed: within(minus(moved, expected), tolerance(c.view, FREE)),
    },
    volatile: { expectedUnits: rounded(expected), modelUnits: moved, errorUnits: rounded(minus(moved, expected)) },
    checks: [
      {
        name: "survives",
        rule: "the editor still shows its drag while the pointer is outside the node",
        ok: away.marks.includes(".djs-drag-active"),
        detail: away.marks.join(" ") || "no drag marker",
        fails: "broken",
      },
      startCheck(started, "its move preview after the return", gesture.marks),
      {
        name: "lands",
        rule: `bounds of the shape: |model - true pointer travel| <= ${round(tolerance(c.view, FREE))} units per axis`,
        ok: within(minus(moved, expected), tolerance(c.view, FREE)),
        // should the canvas scroll after all, its share differs from run to run: the numbers are in the volatile part
        detail: within(minus(moved, expected), tolerance(c.view, FREE))
          ? "lands under the pointer"
          : "lands off the pointer",
        fails: "wrong-data",
      },
      viewKept({ x: viewHeld.e - c.view.e, y: viewHeld.f - c.view.f }),
    ],
    key: `${away.marks.includes(".djs-drag-active") ? "survives" : "DRAG LOST"}, ${within(minus(moved, expected), tolerance(c.view, FREE)) ? "lands right" : "LANDS WRONG"}`,
    notes: [],
  };
}

/** a drag released outside the node, over the board */
async function releaseOutside(c: Ctx): Promise<Outcome> {
  const { id, point } = await excursionStart(c);
  const pane = await c.board.freePanePoint();
  if (!pane) throw new Unmeasured("the board shows no bare pane to release on");
  const before = await c.board.fileText(FILE);
  const { mouse } = c.board.page;
  const { outside } = await leaveUpwards(c, point, []);
  const away = await gestureOf(c.node);
  // on to the bare board, where a click disarms a node
  for (let step = 1; step <= 4; step++) {
    await mouse.move(outside.x + ((pane.x - outside.x) * step) / 4, outside.y + ((pane.y - outside.y) * step) / 4);
  }
  await c.board.page.waitForTimeout(60);
  const under = await topElement(c.board, pane);
  await mouse.up();
  const { changed, after } = await settledModel(c, before, 1500);
  const left = await gestureOf(c.node);
  const armed = (await c.node.state()).armed;
  const moved = minus(after.shapes[id]!, c.model.shapes[id]!);
  const stuck = left.marks.some((mark) => mark === ".djs-drag-active" || mark === ".djs-drag-group");
  return {
    did: `pressed ${id}, dragged the pointer out of the node's body onto the bare board (${under}) and released there`,
    expected:
      "bpmn-js has no drop target outside its canvas and rejects the move: the file is as before, no drag is left over, the node is still armed",
    started: away.marks.includes(".djs-drag-active"),
    marks: away.marks,
    measured: {
      element: id,
      underThePointerOutside: under,
      fileChanged: changed,
      modelUnits: moved,
      dragLeftOver: stuck,
      armedAfter: armed,
      marksAfter: left.marks,
    },
    checks: [
      {
        name: "no write",
        rule: "the file is as before",
        ok: !changed,
        detail: changed ? `the shape moved by ${pair(moved, 0)} units` : "same",
        fails: "wrong-data",
      },
      {
        name: "ends",
        rule: "no drag marker is left in the editor after the release",
        ok: !stuck,
        detail: left.marks.join(" ") || "none",
        fails: "broken",
      },
      {
        name: "armed",
        rule: "the node is still armed (the release ends a drag: it is no click on the bare board)",
        ok: armed,
        detail: armed ? "armed" : "disarmed",
        fails: "degraded",
      },
    ],
    key: `${changed ? "FILE CHANGED" : "file same"}, ${stuck ? "DRAG STUCK" : "drag ended"}, ${armed ? "armed" : "DISARMED"}`,
    notes: [],
  };
}

interface Case {
  name: string;
  /** what a person does first where the case cannot begin as it is; returns a note for the row, if it did anything */
  prepare?(c: Ctx): Promise<string | null>;
  run(c: Ctx): Promise<Outcome>;
}

const CASES: readonly Case[] = [
  { name: "move-snap", run: (c) => moveOne(c, true) },
  { name: "move-free", run: (c) => moveOne(c, false) },
  { name: "move-multi", run: (c) => moveMulti(c, false) },
  { name: "move-multi-pefix", run: (c) => moveMulti(c, true) },
  { name: "create-drag", run: createDrag },
  { name: "create-click", run: createClick },
  { name: "append-click", run: appendClick },
  { name: "append-drag", run: appendDrag },
  { name: "connect-drag", run: connectDrag },
  { name: "global-connect", run: globalConnect },
  {
    name: "resize-participant",
    run: async (c) =>
      resize(c, {
        id: PARTICIPANT,
        press: await reach(c, PARTICIPANT, BAND),
        direction: "e",
        travel: { x: -30, y: 0 },
        dimension: "width",
        what: "east (right edge)",
      }),
    prepare: uncoverBand,
  },
  {
    name: "resize-lane",
    run: async (c) =>
      resize(c, {
        id: "Lane_billing",
        press: await reach(c, "Lane_billing", [
          [0.3, 0.8],
          [0.6, 0.85],
          [0.9, 0.9],
          [0.2, 0.85],
        ]),
        direction: "s",
        travel: { x: 0, y: 20 },
        dimension: "height",
        what: "south (lower edge)",
      }),
  },
  { name: "lasso", run: lasso },
  { name: "space-tool", run: spaceTool },
  { name: "hand-tool", run: handTool },
  { name: "canvas-pan", run: canvasPan },
  { name: "bendpoint-move", run: bendpointMove },
  { name: "segment-move", run: segmentMove },
  { name: "reconnect-end", run: reconnectEnd },
  { name: "label-move", run: labelMove },
  { name: "autoscroll", run: autoScroll, prepare: uncoverBand },
  { name: "drop-lane", run: dropLane },
  { name: "drop-container", run: dropContainer },
  { name: "paste-at-pointer", run: pasteAtPointer },
  { name: "snap-guides", run: snapGuides },
  { name: "drag-leave-return", run: dragLeaveReturn },
  { name: "release-outside", run: releaseOutside },
];

const cases = CASES.filter(
  (one) => caseFilter.length === 0 || caseFilter.some((entry) => one.name === entry || one.name.startsWith(entry)),
);

// ── one row ──────────────────────────────────────────────────────────────────

const hostPointerEvents = (node: NodeHandle): Promise<string> =>
  node.inDocument((host) => getComputedStyle(host).pointerEvents);

async function envOf(node: NodeHandle, view: View, map: ScreenMap): Promise<Env> {
  const [palette] = await node.query(".djs-palette");
  const [entry] = await node.query(".djs-palette .entry");
  return {
    netScale: round(await node.netScale(), 4),
    frameScale: round(map.sx, 4),
    unitPx: round(view.a, 4),
    host: await node.hostBox(),
    hostPointerEvents: await hostPointerEvents(node),
    palette:
      palette && entry
        ? `${round(palette.width, 0)}x${round(palette.height, 0)} px, entry ${round(entry.width, 0)} px`
        : "none",
  };
}

function judge(outcome: Outcome, fileChanged: boolean): { verdict: Verdict; decidedBy?: string } {
  let verdict: Verdict = "ok";
  let decidedBy: string | undefined;
  for (const check of outcome.checks) {
    if (check.ok) continue;
    // nothing wrong can be in a file that did not change: then the gesture is broken, not the data
    const gives: Verdict = check.fails === "wrong-data" && !fileChanged ? "broken" : check.fails;
    if (WORST.indexOf(gives) > WORST.indexOf(verdict)) {
      verdict = gives;
      decidedBy = `${check.name}: ${check.detail}`;
    }
  }
  return decidedBy === undefined ? { verdict } : { verdict, decidedBy };
}

async function once(harness: Harness, one: Case, strategy: Strategy, zoom: number): Promise<Row> {
  const started = Date.now();
  const row: Row = {
    case: one.name,
    notation: "bpmn",
    strategy,
    zoom,
    status: "failed",
    verdict: "unmeasured",
    problems: [],
    ms: 0,
  };
  let board: Board | undefined;
  try {
    board = await harness.open({ board: "matrix", strategy, notations: ["bpmn"], zoom, ...ORIGIN });
    if (patchAll) await board.page.addStyleTag({ content: POINTER_EVENTS_FIX });
    await board.arm(NODE);
    const node = await board.node(NODE);
    if (!(await node.state()).armed) throw new Error("the node did not arm");
    // arming may have moved the board (arm rules): the zoom in effect, not the zoom asked for
    row.effect = await board.viewport();
    const [view, map] = [await viewOf(node), await node.map()];
    const text = (await board.fileText(FILE)) ?? "";
    const model = await parseModel(board, text);
    const boardBefore = await board.boardText();
    row.env = await envOf(node, view, map);
    const ctx: Ctx = { board, node, zoom: row.effect.zoom, view, map, model, env: row.env };
    try {
      const prepared = (await one.prepare?.(ctx)) ?? null;
      const outcome = await one.run(ctx);
      if (prepared) outcome.notes.unshift(prepared);
      const now = (await board.fileText(FILE)) ?? "";
      row.fileChanged = now !== text;
      row.model = describeChange(model, await parseModel(board, now));
      const { scrolled, ...rest } = outcome;
      Object.assign(row, rest, judge(outcome, row.fileChanged));
      if (scrolled) row.volatile = { ...row.volatile, viewScrolledPx: rounded(scrolled, 1) };
      row.status = "measured";
    } catch (error) {
      if (!(error instanceof Unmeasured)) throw error;
      row.status = "unmeasured";
      row.verdict = "unmeasured";
      row.reason = error.message;
      row.key = "unmeasured";
      // a held key or button of a half-done gesture must not leak into the close
      await board.release(["Control", "Shift"]).catch(() => undefined);
    }
    row.boardSame = (await board.boardText()) === boardBefore;
    row.armedAfter = (await node.state()).armed;
    row.mounts = (await board.counters()).mounts[NODE];
  } catch (error) {
    row.status = "failed";
    row.verdict = "unmeasured";
    row.reason = `harness: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`;
    row.key = "failed";
  }
  if (board) {
    row.problems = await board
      .problems({ allow: [KNOWN_CONSOLE.padDeprecation] })
      .catch((error: unknown) => [String(error)]);
    await board.close().catch(() => undefined);
  }
  row.ms = Date.now() - started;
  return row;
}

async function measure(harness: Harness, one: Case, strategy: Strategy, zoom: number): Promise<Row> {
  const runs: Row[] = [];
  for (let index = 0; index < repeat; index++) runs.push(await once(harness, one, strategy, zoom));
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

// ── output ───────────────────────────────────────────────────────────────────

const line = (row: Row): string =>
  [
    row.case.padEnd(19),
    row.strategy.padEnd(8),
    String(row.zoom).padEnd(5),
    row.verdict.padEnd(11),
    (row.started === undefined || row.started === null ? "-" : row.started ? "started" : "NOT started").padEnd(12),
    (row.key ?? "").padEnd(44),
    row.reason ?? row.decidedBy ?? "",
  ].join(" ");

/** one line per case x strategy, the zooms folded */
function table(rows: readonly Row[]): string {
  const out = ["| Case | Notation | Strategy | Verdict | By zoom |", "| --- | --- | --- | --- | --- |"];
  for (const one of cases) {
    for (const strategy of strategies) {
      const mine = zooms
        .map((zoom) => rows.find((row) => row.case === one.name && row.strategy === strategy && row.zoom === zoom))
        .filter((row): row is Row => !!row);
      if (mine.length === 0) continue;
      const worst = mine
        .map((row) => row.verdict)
        .reduce((a, b) => (a === "unmeasured" || WORST.indexOf(b) > WORST.indexOf(a) ? b : a));
      const folded = mine
        .map(
          (row) =>
            `${row.zoom}: ${row.verdict}${row.started === false ? ", not started" : ""} (${row.key ?? row.reason ?? ""})`,
        )
        .join(" \\| ");
      out.push(`| ${one.name} | bpmn | ${strategy} | ${worst} | ${folded} |`);
    }
  }
  return `${out.join("\n")}\n`;
}

await run(async (harness) => {
  const rows: Row[] = [];
  const started = Date.now();
  if (notations.length === 0) console.log("NOTATIONS names no notation with these gestures (only bpmn): no row");
  const tasks: Array<{ one: Case; strategy: Strategy; zoom: number }> = [];
  for (const one of notations.length === 0 ? [] : cases) {
    for (const strategy of strategies) {
      for (const zoom of zooms) tasks.push({ one, strategy, zoom });
    }
  }
  // JOBS rows side by side, each on a page of its own; `rows` keeps the order of `tasks` (case, strategy, zoom)
  const done: Row[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const task = tasks[index];
      if (!task) return;
      const row = await measure(harness, task.one, task.strategy, task.zoom);
      done[index] = row;
      console.log(line(row));
      for (const problem of row.problems) console.log(`    ${problem.slice(0, 220)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  rows.push(...done);
  const count = (verdict: Verdict): number => rows.filter((row) => row.verdict === verdict).length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const withProblems = rows.filter((row) => row.problems.length > 0).length;
  const path = writeResult("bpmn-gestures", {
    what: "board spike battery bpmn-gestures: case x strategy x board zoom, one fresh page per row",
    run: {
      date: new Date().toISOString(),
      chromium: harness.browser.version(),
      seconds: Math.round((Date.now() - started) / 1000),
    },
    config: {
      strategies,
      notations,
      zooms,
      cases: cases.map((one) => one.name),
      repeat,
      jobs,
      patch: patchAll ? POINTER_EVENTS_FIX : null,
      viewport: { width: 2200, height: 1300, deviceScaleFactor: 1 },
      nodeOrigin: ORIGIN,
      file: FILE,
      tolerances: { freeUnits: FREE, gridUnits: GRID, plusScreenPx: 1.5 },
    },
    rows,
  });
  const markdown = outPath("bpmn-gestures.md");
  writeFileSync(markdown, table(rows));
  console.log(
    `\n${rows.length} rows in ${Math.round((Date.now() - started) / 1000)} s: ${count("ok")} ok, ${count("degraded")} degraded, ` +
      `${count("broken")} broken, ${count("wrong-data")} wrong-data, ${count("unmeasured")} unmeasured; ` +
      `${failed} failed in the harness, ${withProblems} with console errors or log lines\n${path}\n${markdown}`,
  );
  // the harness failed, not a strategy: a case that threw, or output where none belongs
  return failed + withProblems;
});
