/**
 * The measurement of the `shim` strategy (engines/coordinate-shim): how far does a page-level
 * coordinate shim get, per engine and interaction, against `naive` (the same placement without the
 * shim) and `overlay` (an exact strategy) on the same board. A check run by hand, not by
 * `pnpm test` or CI: it starts a Vite dev server and a sandboxed headless Chromium (lib.ts).
 *
 *   PORT=5412 CACHE_DIR=<scratch>/vite-cache OUT_DIR=<scratch> node apps/web/test/spike/shim-chromium.ts
 *   STRATEGIES=shim ZOOMS=0.5,1.5 CASES=bpmn-move,dmn- node apps/web/test/spike/shim-chromium.ts
 *
 * One row per case x strategy x part list x board zoom, each on a fresh page (a case that is about
 * a sequence keeps its page). A row holds what was measured, the rule it was judged by and a
 * verdict: `ok` (as in an unscaled editor), `off` (the numbers say otherwise), `n/m` (not
 * measured, with the reason). A verdict is a strategy's result, never a failure of the run: the
 * exit code is 1 only when the harness failed (a navigation, a console error that is not a known
 * one, a page error, a line in the page's log, a case that threw something that is no measurement).
 *
 * Environment (comma lists):
 *   STRATEGIES  default shim,naive,overlay
 *   ZOOMS       default 0.5,0.73,1,1.5,2
 *   CASES       case names or prefixes of names (default: all); `CASES=list` prints the index
 *   NOTATIONS   restricts the per-renderer cases (default: all five Miragon renderers)
 *   SHIM        part lists for the shim strategy, `|` between lists (default `all`). The cases of
 *               the group `parts` bring their own lists
 *   JOBS        pages measured at the same time (default 3)
 *   plus lib.ts's PORT, BASE, CACHE_DIR, OUT_DIR, OUT. Results: <OUT_DIR>/shim.json, shim.md.
 *
 * Every geometry read of this file goes through `window.__boardSpikeNative` (TRUE screen px): the
 * shim patches the plain methods while its node is armed. Where a case wants what the armed editor
 * sees, it calls the plain method on purpose and says so.
 */
import { writeFileSync } from "node:fs";

import {
  aimAt,
  type Board,
  type Box,
  centre,
  type Harness,
  KNOWN_CONSOLE,
  MODEL_NOTATIONS,
  type ModelNotation,
  type NativeGeometry,
  type NodeHandle,
  outPath,
  type Point,
  round,
  run,
  STRATEGIES,
  type Strategy,
  writeResult,
} from "./lib.ts";

// ── what runs ────────────────────────────────────────────────────────────────

const wanted = (name: string): string[] => (process.env[name] ?? "").split(",").filter(Boolean);
const strategies: Strategy[] = (() => {
  const asked = wanted("STRATEGIES");
  return asked.length === 0 ? ["shim", "naive", "overlay"] : STRATEGIES.filter((one) => asked.includes(one));
})();
const zooms = (process.env.ZOOMS ?? "0.5,0.73,1,1.5,2").split(",").map(Number).filter(Boolean);
const caseFilter = wanted("CASES");
const notationFilter = wanted("NOTATIONS");
const shimLists = (process.env.SHIM ?? "all").split("|").filter(Boolean);
const jobs = Math.max(1, Math.round(Number(process.env.JOBS ?? 3)) || 1);

/** where the node's top-left corner sits in the canvas: clear of the toolbar */
const ORIGIN = { x: 60, y: 80 };

type NativeWindow = Window & { __boardSpikeNative?: NativeGeometry };
type Verdict = "ok" | "off" | "n/m";
type Values = Record<string, unknown>;

/** a case could not be measured, for a reason that is itself a result (never a failure of the run) */
class Unmeasured extends Error {}

interface Ctx {
  harness: Harness;
  strategy: Strategy;
  /** the shim's part list of this row; "-" for a strategy without one */
  shim: string;
  zoom: number;
  dpr: number;
}

interface Row {
  case: string;
  strategy: Strategy;
  shim: string;
  zoom: number;
  verdict: Verdict;
  /** the rule the verdict was computed by */
  rule: string;
  values: Values;
  note?: string;
  problems: string[];
  ms: number;
}

/** boxes by name, relative to the editor's host in its own layout px (see `inHost`) */
type Layout = Record<string, Box | undefined>;

interface Result {
  values: Values;
  verdict: Verdict;
  note?: string;
  /** compared with the same case's layout in the unscaled reference (overlay at board zoom 1) */
  layout?: Layout;
  /** the editor's net scale, measured: the layout is compared only where the board scales the editor as a whole */
  net?: number;
}

interface Case {
  name: string;
  group: string;
  rule: string;
  /** zooms this case runs at (default: all asked for) */
  zooms?: readonly number[];
  /** part lists for the shim strategy (default: SHIM) */
  shims?: readonly string[];
  /** strategies this case makes sense for (default: all asked for) */
  only?: readonly Strategy[];
  /** console errors that are known and no strategy's doing */
  allow?: readonly RegExp[];
  /** layout px a box of `layout` may differ from the reference (default 2) */
  tolerance?: number;
  /** device pixel ratio of the page (default 1) */
  dpr?: number;
  run(ctx: Ctx, keep: (board: Board) => void): Promise<Result>;
}

const cases: Case[] = [];
const add = (one: Case): void => void cases.push(one);

const ok = (pass: boolean): Verdict => (pass ? "ok" : "off");
const near = (value: number, target: number, tolerance: number): boolean => Math.abs(value - target) <= tolerance;
const r2 = (value: number): number => round(value, 2);
const p2 = (point: Point): Point => ({ x: r2(point.x), y: r2(point.y) });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const b2 = (box: Box): Box => ({ x: r2(box.x), y: r2(box.y), width: r2(box.width), height: r2(box.height) });

// ── a page for a row ─────────────────────────────────────────────────────────

const FILES = {
  bpmn: "processes/order-to-cash.bpmn",
  dmn: "processes/credit-limit-check.dmn",
  wardley: "processes/tea-shop.wmap",
  "team-topology": "processes/online-shop.tt",
  "event-storming": "processes/order-to-cash.storm",
  "context-map": "processes/order-fulfilment.cm.json",
  "value-chain": "processes/order-to-cash.vc.json",
} as const satisfies Record<ModelNotation, string>;

/** a part list may name a read mode after `@`: `all@arm` is `&shim=all&shimread=arm` */
function shimParams(ctx: Ctx, extra: Record<string, string> = {}): Record<string, string> {
  if (ctx.strategy !== "shim") return extra;
  const [list, read] = ctx.shim.split("@");
  return { ...(list !== "all" ? { shim: list! } : {}), ...(read ? { shimread: read } : {}), ...extra };
}

/** the matrix board with `notations`, the first one's node at ORIGIN and armed */
async function openNode(
  ctx: Ctx,
  keep: (board: Board) => void,
  notations: readonly ModelNotation[],
  options: { arm?: boolean; params?: Record<string, string>; viewport?: { width: number; height: number } } = {},
): Promise<{ board: Board; node: NodeHandle }> {
  const board = await ctx.harness.open(
    {
      board: "matrix",
      strategy: ctx.strategy,
      notations,
      zoom: ctx.zoom,
      ...ORIGIN,
      params: shimParams(ctx, options.params),
    },
    { dpr: ctx.dpr, ...(options.viewport ? { viewport: options.viewport } : {}) },
  );
  keep(board);
  const id = `m-${notations[0]!}`;
  if (options.arm !== false) await board.arm(id);
  return { board, node: await board.node(id) };
}

/** what a rule may know about the strategy, measured on the armed node and never read off its name */
interface Env {
  /** screen px per layout px of the editor's host: 1 where the editor is not scaled */
  net: number;
  /** screen px per diagram unit, null in an HTML view */
  unit: number | null;
}
async function envOf(node: NodeHandle): Promise<Env> {
  return { net: await node.netScale(), unit: await node.diagramScale() };
}

export interface View {
  a: number;
  e: number;
  f: number;
}
/** screen = (e, f) + a x diagram, in screen px, from the browser's own matrix */
async function viewOf(node: NodeHandle): Promise<View> {
  const matrix = await node.inDocument((host) => {
    const viewport = host.querySelector<SVGGElement>("svg g.viewport");
    if (!viewport) return null;
    const native = (window as NativeWindow).__boardSpikeNative;
    const ctm = native ? native.screenCTM(viewport) : viewport.getScreenCTM();
    return ctm ? { a: ctm.a, e: ctm.e, f: ctm.f } : null;
  });
  if (!matrix) throw new Unmeasured("no diagram viewport");
  return matrix;
}
const toDiagram = (view: View, point: Point): Point => ({
  x: (point.x - view.e) / view.a,
  y: (point.y - view.f) / view.a,
});
const toScreen = (view: View, point: Point): Point => ({ x: view.e + point.x * view.a, y: view.f + point.y * view.a });

/** a point of the element's box where a press reaches the element itself (chrome may cover its middle) */
async function grabPoint(
  node: NodeHandle,
  id: string,
  fractions: ReadonlyArray<readonly [number, number]> = [
    [0.5, 0.5],
    [0.5, 0.25],
    [0.5, 0.75],
    [0.25, 0.5],
    [0.75, 0.5],
    [0.8, 0.8],
    [0.2, 0.2],
  ],
): Promise<Point> {
  const box = await node.elementBox(id);
  if (!box) throw new Unmeasured(`${id} is not drawn`);
  const map = await node.map();
  for (const [fx, fy] of fractions) {
    const point = aimAt(map, { x: box.x + box.width * fx, y: box.y + box.height * fy });
    const hit = await node.hit(point);
    if (hit.reachable && hit.element === id) return point;
  }
  throw new Unmeasured(`${id} is covered or outside the editor at every grab point tried`);
}

const first = (node: NodeHandle, selector: string) => async (): Promise<Box | undefined> =>
  (await node.query(selector))[0];

/**
 * The box of a piece of chrome once it is there, its animations are over and it rests; null when it
 * never shows. The product's popups and pads fade in over 150 ms from 4 px above their place
 * (bpmn-io-theme.css, designiq-canvas-pop-in): read during that, a box is up to 4 chrome px off,
 * and two polls 50 ms apart can agree on it when the page gets few frames.
 */
async function chromeBox(board: Board, node: NodeHandle, selector: string, timeout = 2500): Promise<Box | null> {
  const shown = await board.waitForBox(first(node, selector), timeout);
  if (!shown) return null;
  await node.inDocument(async (host, query) => {
    const scopes = [host, ...document.querySelectorAll(".board-popup-host")];
    const running = scopes
      .flatMap((scope) => [...scope.querySelectorAll(query)])
      .flatMap((element) => {
        const chain: Element[] = [];
        for (let one: Element | null = element; one && one !== host; one = one.parentElement) chain.push(one);
        return chain.flatMap((one) => one.getAnimations());
      })
      .filter((animation) => animation.playState === "running" || animation.pending);
    await Promise.race([
      Promise.allSettled(running.map((animation) => animation.finished)),
      new Promise((resolve) => setTimeout(resolve, 1200)),
    ]);
  }, selector);
  return board.waitForBox(first(node, selector), timeout);
}

async function chrome(board: Board, node: NodeHandle, selector: string, what: string): Promise<Box> {
  const box = await chromeBox(board, node, selector);
  if (!box) throw new Unmeasured(`${what} did not appear`);
  return box;
}

/** selects by a click where the element itself is hit; throws Unmeasured when it cannot be */
async function selectAt(board: Board, node: NodeHandle, id: string): Promise<void> {
  if ((await node.selected()).includes(id)) return;
  await board.click(await grabPoint(node, id));
  const selected = await board.waitFor(async () => (await node.selected()).includes(id), 1200);
  if (!selected) throw new Unmeasured(`a click on ${id} did not select it`);
}

/** runs in the page with the diagram-js instance of a node (model state for an expectation; never geometry) */
function withDiagram<A, R>(
  board: Board,
  nodeId: string,
  read: (diagram: { get(name: string): never }, arg: A) => R,
  arg?: A,
): Promise<R> {
  return board.page.evaluate(
    ([id, source, value]) => {
      const hooks = (window as unknown as { __boardSpike: { engine(id: string): { engine?: { diagram(): unknown } } } })
        .__boardSpike;
      const diagram = hooks.engine(id)?.engine?.diagram();
      if (!diagram) throw new Error(`${id}: no diagram`);
      // the function crosses as text
      return (0, eval)(`(${source})`)(diagram, value) as never;
    },
    [nodeId, read.toString(), arg] as const,
  ) as Promise<R>;
}

interface ShapeModel {
  x: number;
  y: number;
  width: number;
  height: number;
}
const shapeOf = (board: Board, nodeId: string, id: string): Promise<ShapeModel | null> =>
  withDiagram(
    board,
    nodeId,
    (diagram, elementId) => {
      const registry = diagram.get("elementRegistry") as { get(id: string): ShapeModel | undefined };
      const element = registry.get(elementId);
      return element ? { x: element.x, y: element.y, width: element.width, height: element.height } : null;
    },
    id,
  );
const waypointsOf = (board: Board, nodeId: string, id: string): Promise<Point[] | null> =>
  withDiagram(
    board,
    nodeId,
    (diagram, elementId) => {
      const registry = diagram.get("elementRegistry") as { get(id: string): { waypoints?: Point[] } | undefined };
      return registry.get(elementId)?.waypoints?.map((point) => ({ x: point.x, y: point.y })) ?? null;
    },
    id,
  );
const stackIndex = (board: Board, nodeId: string): Promise<number> =>
  withDiagram(board, nodeId, (diagram) => (diagram.get("commandStack") as { _stackIdx: number })._stackIdx);
/** grid snapping off through the service: a create cannot hold Control (it would open the replace menu) */
const gridOff = (board: Board, nodeId: string): Promise<void> =>
  withDiagram(board, nodeId, (diagram) => {
    try {
      (diagram.get("gridSnapping") as { setActive(active: boolean): void }).setActive(false);
    } catch {
      /* a renderer without that service */
    }
  });

const newIds = (before: readonly string[], after: readonly string[]): string[] =>
  after.filter((id) => !before.includes(id));

// ── 0. the virtual space itself ──────────────────────────────────────────────

add({
  name: "space",
  group: "space",
  only: ["shim"],
  rule: "the space is measured, not assumed: O is the client origin of the ancestor found to be the containing block of the host's fixed boxes (within 0.02 px), s is the board zoom, and a `position: fixed` box at the virtual point v = (p - O) / s inside the editor lands under the true point p (within 1/64 px of the editor's layout, i.e. s / 64 px + float noise)",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const state = await shimState(board);
    const space = state?.spaces[0];
    if (!space?.frame) throw new Unmeasured("no armed space");
    const { frame } = space;
    const errors = await node.inDocument((host, at) => {
      const native = (window as NativeWindow).__boardSpikeNative!;
      const inside = host.querySelector(".djs-container") ?? host;
      return [
        { x: 300, y: 400 },
        { x: 777.5, y: 123.25 },
        { x: 10, y: 10 },
        { x: 1500.2, y: 900.7 },
      ].map((point) => {
        const box = document.createElement("div");
        const [left, top] = [(point.x - at.ox) / at.sx, (point.y - at.oy) / at.sy];
        box.style.cssText = `position: fixed; left: ${left}px; top: ${top}px; width: 10px; height: 10px`;
        // where an engine puts its popups: deep inside the host
        inside.appendChild(box);
        const rect = native.rect(box);
        // the plain method ON PURPOSE: what the editor is told about the same box
        const told = box.getBoundingClientRect();
        box.remove();
        return {
          landed: Math.max(Math.abs(rect.x - point.x), Math.abs(rect.y - point.y)),
          told: Math.max(Math.abs(told.x - left), Math.abs(told.y - top)),
          size: rect.width / 10,
        };
      });
    }, frame);
    const landed = Math.max(...errors.map((error) => error.landed));
    const told = Math.max(...errors.map((error) => error.told));
    const block = space.containingBlock;
    return {
      values: {
        origin: { x: r2(frame.ox), y: r2(frame.oy) },
        scale: { x: round(frame.sx, 6), y: round(frame.sy, 6) },
        containingBlock: block
          ? { element: block.element, because: block.because, originErrorPx: round(block.originError, 4) }
          : null,
        clippedBy: space.clippedBy,
        fixedBoxLandsOffByPx: round(landed, 4),
        editorIsToldOffByVirtualPx: round(told, 4),
        fixedBoxScale: round(errors[0]!.size, 6),
      },
      verdict: ok(
        !!block &&
          block.originError <= 0.02 &&
          near(frame.sx, ctx.zoom, 0.001) &&
          landed <= frame.sx / 64 + 0.005 &&
          told <= 1 / 64 + 0.001,
      ),
    };
  },
});

// ── 1. BPMN ──────────────────────────────────────────────────────────────────

const BPMN = "m-bpmn";
const PAD_ALLOW = [KNOWN_CONSOLE.padDeprecation];

add({
  name: "bpmn-move",
  group: "bpmn",
  rule: "shape displacement over pointer displacement is 1 +/- 0.03 on both axes",
  async run(ctx, keep) {
    const { node } = await openNode(ctx, keep, ["bpmn"]);
    const env = await envOf(node);
    const id = "Task_check_credit";
    const from = await grabPoint(node, id);
    const before = (await node.elementBox(id))!;
    const dragged = await node.drag(from, { x: 60 * ctx.zoom, y: 40 * ctx.zoom }, { hold: ["Control"] });
    const after = (await node.elementBox(id))!;
    const ratio = { x: (after.x - before.x) / dragged.delta.x, y: (after.y - before.y) / dragged.delta.y };
    return {
      values: { ratio: { x: round(ratio.x, 3), y: round(ratio.y, 3) }, pointer: p2(dragged.delta), net: r2(env.net) },
      verdict: ok(near(ratio.x, 1, 0.03) && near(ratio.y, 1, 0.03)),
    };
  },
});

add({
  name: "bpmn-create",
  group: "bpmn",
  rule: "the new task's centre is within 1.5 px + 1 diagram unit of the drop point (grid snapping off)",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    await gridOff(board, BPMN);
    const view = await viewOf(node);
    const entry = (await node.query('.djs-palette .entry[data-action="create.task"]'))[0];
    if (!entry) throw new Unmeasured("no palette entry create.task");
    const drop = toScreen(view, { x: 1060, y: 250 });
    const dropHit = await node.hit(drop);
    if (!dropHit.reachable || dropHit.palette || dropHit.pad)
      throw new Unmeasured(`drop point covered: ${dropHit.what}`);
    const ids = await node.elementIds();
    const text = await board.fileText(FILES.bpmn);
    const dragged = await node.paletteDrag(entry, drop);
    const changed = await board.waitForFileChange(FILES.bpmn, text, 2000);
    await board.press("Escape");
    const created = newIds(ids, await node.elementIds()).filter((id) => !id.endsWith("_label"));
    const box = created[0] ? await node.elementBox(created[0]) : null;
    if (!box) return { values: { created, fileChanged: !!changed }, verdict: "off", note: "no shape was created" };
    const error = sub(centre(box), dragged.to);
    const limit = 1.5 + view.a;
    return {
      values: { errorPx: p2(error), unitPx: r2(view.a), fileChanged: !!changed },
      verdict: ok(Math.abs(error.x) <= limit && Math.abs(error.y) <= limit),
    };
  },
});

add({
  name: "bpmn-connect",
  group: "bpmn",
  rule: "a drag from the pad's connect entry to another task writes a sequence flow between the two",
  allow: PAD_ALLOW,
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    // not Task_validate_order: an unscaled palette covers it at a low board zoom
    const [source, target] = ["Task_check_credit", "Task_reject_order"];
    await selectAt(board, node, source);
    const entry = await chrome(board, node, '.djs-context-pad.open .entry[data-action="connect"]', "connect entry");
    const entryHit = await node.hit(centre(entry));
    if (!entryHit.pad) throw new Unmeasured(`the connect entry is not hit where it is drawn (${entryHit.what})`);
    const box = (await node.elementBox(target))!;
    const drop = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.7 };
    const text = await board.fileText(FILES.bpmn);
    await node.paletteDrag(entry, drop);
    const changed = await board.waitForFileChange(FILES.bpmn, text, 2000);
    const made = new RegExp(`<bpmn:sequenceFlow id="[^"]+" sourceRef="${source}" targetRef="${target}"`).test(
      changed ?? "",
    );
    return { values: { fileChanged: !!changed, flow: made }, verdict: ok(made) };
  },
});

add({
  name: "bpmn-resize",
  group: "bpmn",
  rule: "a lane's height changes by the pointer's travel in diagram units, +/- 1.5 units",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const view = await viewOf(node);
    // the top lane, at its free right end: the pool's band at the left lies under an unscaled palette
    const id = "Lane_order_management";
    const at = await grabPoint(node, id, [
      [0.95, 0.5],
      [0.9, 0.9],
      [0.95, 0.2],
    ]);
    await board.click(at);
    const handle = await chrome(board, node, ".djs-resizer-s .djs-resizer-hit", "south resize handle");
    const handleHit = await node.hit(centre(handle));
    if (!handleHit.reachable) throw new Unmeasured(`the resize handle is not reachable (${handleHit.what})`);
    const before = (await shapeOf(board, BPMN, id))!;
    const dragged = await node.drag(centre(handle), { x: 0, y: 15 * view.a }, { hold: ["Control"] });
    await board.page.waitForTimeout(300);
    const after = (await shapeOf(board, BPMN, id))!;
    const expected = dragged.delta.y / view.a;
    const got = after.height - before.height;
    return {
      values: { heightDelta: r2(got), expected: r2(expected), ratio: round(got / expected, 3) },
      verdict: ok(near(got, expected, 1.5)),
    };
  },
});

add({
  name: "bpmn-resize-annotation",
  group: "bpmn",
  rule: "a new text annotation's width changes by the pointer's travel in diagram units, +/- 1.5 units (it has an east and a west handle only)",
  allow: PAD_ALLOW,
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const view = await viewOf(node);
    await selectAt(board, node, "Task_fulfill_order");
    const entry = await chrome(
      board,
      node,
      '.djs-context-pad.open .entry[data-action="append.text-annotation"]',
      "append annotation entry",
    );
    if (!(await node.hit(centre(entry))).pad) throw new Unmeasured("the pad entry is not hit where it is drawn");
    const ids = await node.elementIds();
    await board.click(centre(entry));
    await chrome(board, node, ".djs-direct-editing-parent", "label editor of the new annotation");
    await board.type("A note");
    // bpmn-js removes the resize handles when a label editor opens and adds them on a selection change only
    await board.click(await freeCanvasPoint(node));
    await board.page.waitForTimeout(400);
    const id = newIds(ids, await node.elementIds()).find((one) => one.startsWith("TextAnnotation"));
    if (!id) throw new Unmeasured("the click on the pad entry created no annotation");
    await selectAt(board, node, id);
    const handle = await chrome(board, node, ".djs-resizer-e .djs-resizer-hit", "east resize handle");
    if (!(await node.hit(centre(handle))).reachable) throw new Unmeasured("the resize handle is not reachable");
    const before = (await shapeOf(board, BPMN, id))!;
    const dragged = await node.drag(centre(handle), { x: 40 * view.a, y: 0 }, { hold: ["Control"] });
    await board.page.waitForTimeout(300);
    const after = (await shapeOf(board, BPMN, id))!;
    const expected = dragged.delta.x / view.a;
    const got = after.width - before.width;
    return {
      values: { widthDelta: r2(got), expected: r2(expected), ratio: round(got / expected, 3) },
      verdict: ok(near(got, expected, 1.5)),
    };
  },
});

/** every element's box in diagram units (a connection: the box of its waypoints), from the engine's registry */
const modelBoxes = (board: Board, nodeId: string): Promise<Record<string, Box>> =>
  withDiagram(board, nodeId, (diagram) => {
    interface Item {
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      waypoints?: Point[];
      parent?: unknown;
    }
    const registry = diagram.get("elementRegistry") as { getAll(): Item[] };
    const boxes: Record<string, Box> = {};
    for (const item of registry.getAll()) {
      if (!item.parent) continue;
      if (item.waypoints) {
        const xs = item.waypoints.map((point) => point.x);
        const ys = item.waypoints.map((point) => point.y);
        const [x, y] = [Math.min(...xs), Math.min(...ys)];
        boxes[item.id] = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
      } else boxes[item.id] = { x: item.x, y: item.y, width: item.width, height: item.height };
    }
    return boxes;
  });

add({
  name: "bpmn-lasso",
  group: "bpmn",
  rule: "the lasso frame is the rectangle the pointer drew (+/- 1.5 px + 1 unit) and exactly the elements inside it are selected",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const view = await viewOf(node);
    const entry = (await node.query('.djs-palette .entry[data-action="lasso-tool"]'))[0];
    if (!entry) throw new Unmeasured("no lasso entry");
    await board.click(centre(entry));
    await board.page.waitForTimeout(80);
    // around two shapes in the middle of the diagram: clear of the canvas's edges (auto-scroll) and of the palette
    const model = await modelBoxes(board, BPMN);
    const [one, two] = [model.Task_reject_order!, model.EndEvent_order_rejected!];
    const from = toScreen(view, { x: Math.min(one.x, two.x) - 14, y: Math.min(one.y, two.y) - 14 });
    const to = toScreen(view, {
      x: Math.max(one.x + one.width, two.x + two.width) + 14,
      y: Math.max(one.y + one.height, two.y + two.height) + 14,
    });
    for (const point of [from, to]) {
      const hit = await node.hit(point);
      if (!hit.reachable || hit.palette) throw new Unmeasured(`a lasso corner is covered: ${hit.what}`);
    }
    const dragged = await node.drag(from, sub(to, from), { keepDown: true });
    const frame = (await node.query(".djs-lasso-overlay"))[0];
    await board.release();
    await board.page.waitForTimeout(150);
    const drawn: Box = { x: dragged.from.x, y: dragged.from.y, width: dragged.delta.x, height: dragged.delta.y };
    const [a, b] = [toDiagram(view, dragged.from), toDiagram(view, dragged.to)];
    const expected = Object.entries(model)
      .filter(([, box]) => box.x > a.x && box.y > a.y && box.x + box.width < b.x && box.y + box.height < b.y)
      .map(([id]) => id)
      .sort();
    const selected = (await node.selected()).sort();
    const frameError = frame
      ? Math.max(
          Math.abs(frame.x - drawn.x),
          Math.abs(frame.y - drawn.y),
          Math.abs(frame.width - drawn.width),
          Math.abs(frame.height - drawn.height),
        )
      : null;
    const same = JSON.stringify(selected) === JSON.stringify(expected);
    return {
      values: { selected, expected, frameErrorPx: frameError === null ? null : r2(frameError) },
      verdict: ok(same && expected.length > 0 && frameError !== null && frameError <= 1.5 + view.a),
    };
  },
});

for (const [name, press, travel, rule] of [
  [
    "bpmn-bendpoint",
    { x: 930, y: 170 },
    { x: 50, y: 40 },
    "the bendpoint under the press moves by the pointer's travel, +/- 3 units (whole units, and bendpoints snap)",
  ],
  [
    "bpmn-segment",
    { x: 930, y: 300 },
    { x: 34, y: 6 },
    "the vertical segment under the press moves by the pointer's x travel, +/- 3 units",
  ],
] as const) {
  add({
    name,
    group: "bpmn",
    rule,
    async run(ctx, keep) {
      const { board, node } = await openNode(ctx, keep, ["bpmn"]);
      const view = await viewOf(node);
      const flow = "Flow_to_invoice";
      const from = toScreen(view, press);
      const before = (await waypointsOf(board, BPMN, flow))!;
      // the bendpoint and segment handles appear on hover
      await board.move(from, 3);
      await board.page.waitForTimeout(120);
      const dragged = await node.drag(from, { x: travel.x * view.a, y: travel.y * view.a }, { hold: ["Control"] });
      await board.page.waitForTimeout(300);
      const after = (await waypointsOf(board, BPMN, flow))!;
      const expected = { x: dragged.delta.x / view.a, y: dragged.delta.y / view.a };
      const index = before.findIndex((point) => Math.hypot(point.x - press.x, point.y - press.y) < 12);
      const moved =
        name === "bpmn-bendpoint"
          ? index >= 0 && after[index]
            ? sub(after[index], before[index]!)
            : null
          : // every waypoint of the dragged segment has the press's x
            (() => {
              const was = before.filter((point) => Math.abs(point.x - press.x) < 2);
              const now = after.filter((point) => Math.abs(point.x - (press.x + expected.x)) < 4);
              return was.length >= 2 && now.length >= 2 ? { x: now[0]!.x - was[0]!.x, y: 0 } : null;
            })();
      const unchanged = JSON.stringify(before) === JSON.stringify(after);
      const viewAfter = await viewOf(node);
      const panned = p2({ x: viewAfter.e - view.e, y: viewAfter.f - view.f });
      if (!moved || unchanged) {
        return {
          values: { started: !unchanged, before, after, canvasPannedPx: panned },
          verdict: "off",
          note: unchanged
            ? "the waypoints did not change: no bendpoint drag started"
            : "the waypoints changed otherwise",
        };
      }
      const pass = near(moved.x, expected.x, 3) && (name === "bpmn-segment" || near(moved.y, expected.y, 3));
      return { values: { moved: p2(moved), expected: p2(expected), canvasPannedPx: panned }, verdict: ok(pass) };
    },
  });
}

/** a point of the bare canvas inside the host */
async function freeCanvasPoint(node: NodeHandle): Promise<Point> {
  const host = await node.hostBox();
  for (const fy of [0.03, 0.97, 0.5, 0.2, 0.8]) {
    for (const fx of [0.5, 0.985, 0.97, 0.015, 0.03, 0.8, 0.3]) {
      const point = { x: host.x + host.width * fx, y: host.y + host.height * fy };
      const hit = await node.hit(point);
      // the svg itself: it carries the root's id, a shape would be hit through its own graphics
      if (hit.reachable && hit.what.startsWith("svg")) return point;
    }
  }
  throw new Unmeasured("no bare canvas point found");
}

add({
  name: "bpmn-pan",
  group: "bpmn",
  rule: "a drag of the bare canvas moves the diagram by the pointer's travel: ratio 1 +/- 0.03",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const view = await viewOf(node);
    const host = await node.hostBox();
    const from = await freeCanvasPoint(node);
    const direction = { x: host.x + host.width / 2 > from.x ? 1 : -1, y: host.y + host.height / 2 > from.y ? 1 : -1 };
    const dragged = await node.drag(from, { x: direction.x * 50 * ctx.zoom, y: direction.y * 30 * ctx.zoom });
    await board.page.waitForTimeout(200);
    const after = await viewOf(node);
    const ratio = { x: (after.e - view.e) / dragged.delta.x, y: (after.f - view.f) / dragged.delta.y };
    return {
      values: { ratio: { x: round(ratio.x, 3), y: round(ratio.y, 3) }, pointer: p2(dragged.delta) },
      verdict: ok(near(ratio.x, 1, 0.03) && near(ratio.y, 1, 0.03)),
    };
  },
});

add({
  name: "bpmn-wheel",
  group: "bpmn",
  rule: "after three Control + wheel steps the diagram point under the pointer is within 1.5 px of it, and the board's viewport is unchanged",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const view = await viewOf(node);
    const at = await grabPoint(node, "Task_check_credit");
    const pivot = toDiagram(view, at);
    const viewport = await board.viewport();
    for (let step = 0; step < 3; step++) {
      await board.wheel(at, -100, { hold: ["Control"] });
      await board.page.waitForTimeout(80);
    }
    const after = await viewOf(node);
    const drift = sub(toScreen(after, pivot), at);
    const boardSame = JSON.stringify(await board.viewport()) === JSON.stringify(viewport);
    return {
      values: { driftPx: p2(drift), scale: [round(view.a, 4), round(after.a, 4)], boardViewportSame: boardSame },
      verdict: ok(Math.hypot(drift.x, drift.y) <= 1.5 && after.a !== view.a && boardSame),
    };
  },
});

add({
  name: "bpmn-pad-popup",
  group: "bpmn",
  rule: "pad: 13 diagram units right of the shape (+/- 1). Replace popup: at (pad.left, pad.bottom + 5 chrome px) +/- 1.5 px, 300 chrome px wide, every entry hit where it is drawn, the chosen entry changes the file",
  allow: PAD_ALLOW,
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const env = await envOf(node);
    const id = "Task_check_credit";
    await selectAt(board, node, id);
    const shape = (await node.elementBox(id))!;
    const wrench = await chrome(board, node, '.djs-context-pad.open .entry[data-action="replace"]', "replace entry");
    const pad = await chrome(board, node, ".djs-context-pad.open", "pad");
    const padEntries = await node.query(".djs-context-pad.open .entry");
    const leftmost = Math.min(...padEntries.map((entry) => entry.x));
    const gapUnits = (leftmost - (shape.x + shape.width)) / env.unit!;
    const wrenchHit = await node.hit(centre(wrench));
    const values: Values = {
      padGapUnits: r2(gapUnits),
      padEntryPx: r2(wrench.width),
      wrenchHit: wrenchHit.pad,
    };
    if (!wrenchHit.pad) {
      return { values, verdict: "off", note: `the replace entry is not hit where it is drawn (${wrenchHit.what})` };
    }
    await board.click(centre(wrench));
    const popup = await chrome(board, node, ".djs-popup", "replace popup");
    const error = { x: popup.x - pad.x, y: popup.y - (pad.y + pad.height + 5 * env.net) };
    const entries = await node.query(".djs-popup .entry");
    const view = board.page.viewportSize()!;
    let reachable = 0;
    for (const entry of entries) {
      const at = centre(entry);
      if (at.x < 0 || at.y < 0 || at.x >= view.width || at.y >= view.height) continue;
      if ((await node.hit(at)).popup) reachable++;
    }
    const service = (await node.query('.djs-popup .entry[data-id="replace-with-service-task"]'))[0];
    const text = await board.fileText(FILES.bpmn);
    let replaced = false;
    if (service && (await node.hit(centre(service))).popup) {
      await board.click(centre(service));
      const changed = await board.waitForFileChange(FILES.bpmn, text, 2000);
      replaced = /<bpmn:serviceTask id="Task_check_credit"/.test(changed ?? "");
    }
    Object.assign(values, {
      popupErrorPx: p2(error),
      popupChromeSize: { width: r2(popup.width / env.net), height: r2(popup.height / env.net) },
      popupInWindow:
        popup.x >= 0 && popup.y >= 0 && popup.x + popup.width <= view.width && popup.y + popup.height <= view.height,
      entriesReachable: `${reachable}/${entries.length}`,
      replaced,
    });
    return {
      values,
      verdict: ok(
        near(gapUnits, 13, 1) &&
          Math.abs(error.x) <= 1.5 &&
          Math.abs(error.y) <= 1.5 &&
          near(popup.width / env.net, 300, 2) &&
          reachable > 0 &&
          replaced,
      ),
    };
  },
});

add({
  name: "bpmn-tooltip",
  group: "bpmn",
  rule: "the palette tooltip starts 8 chrome px right of its entry, vertically on the entry's middle, +/- 1.5 px",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const env = await envOf(node);
    const entry = (await node.query('.djs-palette .entry[data-action="create.task"]'))[0];
    if (!entry) throw new Unmeasured("no palette entry");
    await board.move(centre(entry), 4);
    const tooltip = await chrome(board, node, ".djs-hover-tooltip", "palette tooltip");
    const error = {
      x: tooltip.x - (entry.x + entry.width + 8 * env.net),
      y: tooltip.y + tooltip.height / 2 - (entry.y + entry.height / 2),
    };
    const view = board.page.viewportSize()!;
    return {
      values: { errorPx: p2(error), tooltip: b2(tooltip), inWindow: tooltip.x >= 0 && tooltip.x < view.width },
      verdict: ok(Math.abs(error.x) <= 1.5 && Math.abs(error.y) <= 1.5),
    };
  },
});

add({
  name: "bpmn-label",
  group: "bpmn",
  rule: "the label editor lies on its task (+/- 1 px, same size) and the typed name is in the file",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const id = "Task_check_credit";
    const at = await grabPoint(node, id);
    const shape = (await node.elementBox(id))!;
    await board.doubleClick(at);
    const editor = await chrome(board, node, ".djs-direct-editing-parent", "label editor");
    const offset = {
      x: editor.x - shape.x,
      y: editor.y - shape.y,
      width: editor.width - shape.width,
      height: editor.height - shape.height,
    };
    const text = await board.fileText(FILES.bpmn);
    await board.press("Control+A");
    await board.type("Edited by shim run");
    await board.press("Enter");
    const changed = await board.waitForFileChange(FILES.bpmn, text, 2000);
    const typed = /name="Edited by shim run"/.test(changed ?? "");
    return {
      values: { editorMinusShapePx: b2(offset), typedInFile: typed },
      verdict: ok(Object.values(offset).every((value) => Math.abs(value) <= 1) && typed),
    };
  },
});

/**
 * The canvas at scale exactly 1 with `id` 130 x 100 px inside its top-left corner. At scale 1 every
 * box of a label editor is a whole px, so what diagram-js compares on closing it (the editor's client
 * rectangle against the size it gave it, with !==) is equal in an unscaled editor. At the fitted
 * scale (0.676 here) it is not, in any strategy: the engine's own quirk (pointer-math-core.md 7.4).
 */
const scaleOne = (board: Board, nodeId: string, id: string): Promise<void> =>
  withDiagram(
    board,
    nodeId,
    (diagram, elementId) => {
      const canvas = diagram.get("canvas") as {
        getSize(): { width: number; height: number };
        viewbox(box: { x: number; y: number; width: number; height: number }): void;
      };
      const registry = diagram.get("elementRegistry") as { get(id: string): { x: number; y: number } };
      const element = registry.get(elementId);
      const size = canvas.getSize();
      canvas.viewbox({ x: element.x - 130, y: element.y - 100, width: size.width, height: size.height });
    },
    id,
  );

/** opens the label editor of `id` and closes it with nothing typed; what diagram-js compared, and what it did */
async function closeUntyped(
  board: Board,
  node: NodeHandle,
  nodeId: string,
  file: string,
  id: string,
  close: () => Promise<void>,
): Promise<Values> {
  const text = await board.fileText(file);
  const stack = await stackIndex(board, nodeId);
  await board.doubleClick(await grabPoint(node, id));
  await chrome(board, node, ".djs-direct-editing-parent", "label editor");
  // what DirectEditing.complete compares: the editor's rectangle AS THE EDITOR READS IT (the plain
  // method on purpose) against the bounds the provider gave it
  const compared = await withDiagram(board, nodeId, (diagram) => {
    const editing = diagram.get("directEditing") as {
      $textbox: Element;
      _active: { context: { bounds: { width: number; height: number } } };
    };
    const rect = editing.$textbox.getBoundingClientRect();
    const { bounds } = editing._active.context;
    return { rectMinusBounds: { width: rect.width - bounds.width, height: rect.height - bounds.height } };
  });
  await close();
  await board.page.waitForTimeout(700);
  return {
    fileIdentical: (await board.fileText(file)) === text,
    commands: (await stackIndex(board, nodeId)) - stack,
    editorRectMinusGivenSize: compared.rectMinusBounds,
  };
}

for (const [name, atOne] of [
  ["bpmn-label-nochange", true],
  ["bpmn-label-nochange-fitted", false],
] as const) {
  add({
    name,
    group: "bpmn",
    rule: atOne
      ? "canvas at scale 1: a task's label editor opened and closed with Enter, nothing typed, leaves the file byte-identical and runs no command"
      : "the same at the fitted canvas scale. An unscaled editor writes here too wherever the label box is no whole 1/64 px (the engine's quirk): compare with overlay at board zoom 1, which has the same canvas scale",
    async run(ctx, keep) {
      const { board, node } = await openNode(ctx, keep, ["bpmn"]);
      const id = "Task_check_credit";
      if (atOne) await scaleOne(board, BPMN, id);
      const env = await envOf(node);
      const values = await closeUntyped(board, node, BPMN, FILES.bpmn, id, () => board.press("Enter"));
      return {
        values: { ...values, canvasScale: round(env.unit! / env.net, 5) },
        verdict: ok(values.fileIdentical === true && values.commands === 0),
      };
    },
  });
}

add({
  name: "bpmn-label-annotation",
  group: "bpmn",
  rule: "canvas at scale 1: a text annotation's label editor opened and closed by a click outside, nothing typed, leaves the file byte-identical and the annotation its size",
  allow: PAD_ALLOW,
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    // before the annotation is made: made at another scale its width is no whole px at scale 1
    await scaleOne(board, BPMN, "Task_fulfill_order");
    await board.page.waitForTimeout(100);
    await selectAt(board, node, "Task_fulfill_order");
    const entry = await chrome(
      board,
      node,
      '.djs-context-pad.open .entry[data-action="append.text-annotation"]',
      "append annotation entry",
    );
    if (!(await node.hit(centre(entry))).pad) throw new Unmeasured("the pad entry is not hit where it is drawn");
    const ids = await node.elementIds();
    const start = await board.fileText(FILES.bpmn);
    await board.click(centre(entry));
    await chrome(board, node, ".djs-direct-editing-parent", "label editor of the new annotation");
    await board.type("A note");
    // Enter is a line break in an annotation: a click on the bare canvas completes
    await board.click(await freeCanvasPoint(node));
    const written = await board.waitForFileChange(FILES.bpmn, start, 2000);
    const id = newIds(ids, await node.elementIds()).find((one) => one.startsWith("TextAnnotation"));
    if (!id || !written) throw new Unmeasured("no annotation was created");
    await board.page.waitForTimeout(500);
    const typed = /<bpmn:text>A note<\/bpmn:text>/.test((await board.fileText(FILES.bpmn)) ?? "");
    const before = (await shapeOf(board, BPMN, id))!;
    const values = await closeUntyped(board, node, BPMN, FILES.bpmn, id, async () => {
      await board.click(await freeCanvasPoint(node));
    });
    const after = (await shapeOf(board, BPMN, id))!;
    return {
      values: {
        typedInFile: typed,
        ...values,
        size: [`${before.width} x ${before.height}`, `${r2(after.width)} x ${r2(after.height)}`],
      },
      verdict: ok(typed && values.fileIdentical === true && values.commands === 0),
    };
  },
});

add({
  name: "bpmn-autoscroll",
  group: "bpmn",
  rule: "a drag held 3 px inside the canvas's left edge scrolls the canvas (more than 20 layout px in 400 ms) and stops 60 layout px inside",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const env = await envOf(node);
    const host = await node.hostBox();
    const map = await node.map();
    const from = await grabPoint(node, "Task_check_credit");
    const edge = aimAt(map, { x: host.x + 3, y: from.y });
    const { mouse, keyboard } = board.page;
    await mouse.move(from.x, from.y);
    await mouse.down();
    for (let step = 1; step <= 8; step++) await mouse.move(from.x + ((edge.x - from.x) * step) / 8, from.y);
    await keyboard.down("Control");
    await mouse.move(edge.x, edge.y);
    const atEdge = await viewOf(node);
    await board.page.waitForTimeout(400);
    const held = await viewOf(node);
    const inside = aimAt(map, { x: host.x + 60 * env.net, y: from.y });
    await mouse.move(inside.x, inside.y, { steps: 3 });
    await board.page.waitForTimeout(120);
    const restA = await viewOf(node);
    await board.page.waitForTimeout(200);
    const restB = await viewOf(node);
    await board.press("Escape");
    await mouse.up();
    await keyboard.up("Control");
    const scrolled = (held.e - atEdge.e) / env.net;
    const after = (restB.e - restA.e) / env.net;
    return {
      values: { scrolledLayoutPxIn400ms: r2(scrolled), stillScrollingInside: r2(after) },
      verdict: ok(scrolled > 20 && Math.abs(after) < 1),
    };
  },
});

// ── layout against the unscaled reference ────────────────────────────────────

/**
 * A box relative to the editor host's origin, in the host's own layout px. An editor the board
 * scales as a whole (naive, shim, an unscaled one at board zoom 1) must show the SAME numbers at
 * every board zoom as the unscaled editor at board zoom 1 (the row `overlay` at zoom 1, measured
 * once per case as the reference): chrome that is where it belongs is there at any magnification.
 * Not compared for an editor whose chrome keeps its screen size while the diagram scales (overlay
 * at another zoom): its chrome is somewhere else by design.
 */
const inHost = (box: Box, host: Box, net: number): Box => ({
  x: (box.x - host.x) / net,
  y: (box.y - host.y) / net,
  width: box.width / net,
  height: box.height / net,
});

/** the largest difference of any number of two layouts, and where; keys missing on one side are named */
function deviation(layout: Layout, reference: Layout): { max: number; at: string; missing: string[] } {
  let max = 0;
  let at = "";
  const missing: string[] = [];
  for (const key of new Set([...Object.keys(layout), ...Object.keys(reference)])) {
    const [a, b] = [layout[key], reference[key]];
    if (!a || !b) {
      missing.push(key);
      continue;
    }
    for (const side of ["x", "y", "width", "height"] as const) {
      const difference = Math.abs(a[side] - b[side]);
      if (difference > max) [max, at] = [difference, `${key}.${side}`];
    }
  }
  return { max, at, missing };
}

/**
 * A point of the bare canvas where a new shape of half size `half` (diagram units) snaps to nothing:
 * more than 9 units from the left, middle and right (top, middle, bottom) of every drawn shape, for
 * its own middle and edges. The search order is fixed in the host's layout, so an unscaled editor
 * and a scaled one get the same point of the diagram.
 */
async function clearPoint(node: NodeHandle, half: Point): Promise<Point> {
  const host = await node.hostBox();
  const unit = (await node.diagramScale()) ?? 1;
  const shapes = await node.query(".djs-shape > .djs-visual");
  const xs = shapes.flatMap((box) => [box.x, box.x + box.width / 2, box.x + box.width]);
  const ys = shapes.flatMap((box) => [box.y, box.y + box.height / 2, box.y + box.height]);
  const clear = (value: number, lines: readonly number[], halfSize: number): boolean =>
    [0, -halfSize * unit, halfSize * unit].every((shift) =>
      lines.every((line) => Math.abs(value + shift - line) > 9 * unit),
    );
  const map = await node.map();
  for (const fy of [0.5, 0.62, 0.38, 0.74, 0.26, 0.86, 0.14]) {
    for (const fx of [0.5, 0.62, 0.38, 0.74, 0.26, 0.86, 0.14, 0.92]) {
      const point = aimAt(map, { x: host.x + host.width * fx, y: host.y + host.height * fy });
      if (!clear(point.x, xs, half.x) || !clear(point.y, ys, half.y)) continue;
      const hit = await node.hit(point);
      if (hit.reachable && hit.what.startsWith("svg")) return point;
    }
  }
  // a crowded diagram: any bare canvas point. An unscaled editor and a scaled one snap alike there
  for (const fy of [0.5, 0.62, 0.38, 0.74, 0.26, 0.86, 0.14]) {
    for (const fx of [0.86, 0.74, 0.62, 0.5, 0.38, 0.26, 0.92]) {
      const point = aimAt(map, { x: host.x + host.width * fx, y: host.y + host.height * fy });
      const hit = await node.hit(point);
      if (hit.reachable && hit.what.startsWith("svg")) return point;
    }
  }
  throw new Unmeasured("no bare canvas point for a drop");
}

/** drags a palette entry to `drop`; the new shapes' ids, and whether the file changed */
async function createByDrag(
  board: Board,
  node: NodeHandle,
  file: string,
  action: string,
  drop: Point,
  hold: readonly string[] = [],
): Promise<{ created: string[]; to: Point; changed: boolean }> {
  const entry = (await node.query(`.djs-palette .entry[data-action="${action}"]`))[0];
  if (!entry) throw new Unmeasured(`no palette entry ${action}`);
  const entryHit = await node.hit(centre(entry));
  if (!entryHit.palette)
    throw new Unmeasured(`the palette entry ${action} is not hit where it is drawn (${entryHit.what})`);
  const ids = await node.elementIds();
  const text = await board.fileText(file);
  const dragged = await node.paletteDrag(entry, drop, { hold });
  const changed = await board.waitForFileChange(file, text, 2000);
  await board.page.waitForTimeout(150);
  await board.press("Escape");
  await board.page.waitForTimeout(150);
  return { created: newIds(ids, await node.elementIds()), to: dragged.to, changed: !!changed };
}

// ── 2. the DRD of dmn-js ─────────────────────────────────────────────────────

const DMN = "m-dmn";

add({
  name: "drd-move",
  group: "drd",
  rule: "shape displacement over pointer displacement is 1 +/- 0.03 on both axes",
  async run(ctx, keep) {
    const { node } = await openNode(ctx, keep, ["dmn"]);
    const id = "InputData_segment";
    const from = await grabPoint(node, id);
    const before = (await node.elementBox(id))!;
    const dragged = await node.drag(from, { x: 60 * ctx.zoom, y: -40 * ctx.zoom }, { hold: ["Control"] });
    const after = (await node.elementBox(id))!;
    const ratio = { x: (after.x - before.x) / dragged.delta.x, y: (after.y - before.y) / dragged.delta.y };
    return {
      values: { ratio: { x: round(ratio.x, 3), y: round(ratio.y, 3) }, pointer: p2(dragged.delta) },
      verdict: ok(near(ratio.x, 1, 0.03) && near(ratio.y, 1, 0.03)),
    };
  },
});

add({
  name: "drd-create",
  group: "drd",
  rule: "a new input data's centre is within 1.5 px + 1 diagram unit of the drop point (grid snapping off)",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["dmn"]);
    await gridOff(board, DMN);
    const unit = (await node.diagramScale())!;
    const drop = await clearPoint(node, { x: 62.5, y: 22.5 });
    const made = await createByDrag(board, node, FILES.dmn, "create.input-data", drop);
    const id = made.created.find((one) => !one.endsWith("_label"));
    const box = id ? await node.elementBox(id) : null;
    if (!box) return { values: { ...made }, verdict: "off", note: "no shape was created" };
    const error = sub(centre(box), made.to);
    const limit = 1.5 + unit;
    return {
      values: { errorPx: p2(error), unitPx: r2(unit), fileChanged: made.changed },
      verdict: ok(Math.abs(error.x) <= limit && Math.abs(error.y) <= limit),
    };
  },
});

add({
  name: "drd-connect",
  group: "drd",
  rule: "a new knowledge source, then a drag from its pad's connect entry to the decision, writes an authority requirement",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["dmn"]);
    await gridOff(board, DMN);
    const drop = await clearPoint(node, { x: 50, y: 31.5 });
    const made = await createByDrag(board, node, FILES.dmn, "create.knowledge-source", drop);
    const id = made.created[0];
    if (!id) throw new Unmeasured("the palette drag created no knowledge source");
    const box = await node.elementBox(id);
    if (!box || !(await node.hit(centre(box))).reachable) {
      throw new Unmeasured("the new knowledge source was created outside the visible canvas");
    }
    await board.click(await freeCanvasPoint(node));
    await selectAt(board, node, id);
    const entry = await chrome(board, node, '.djs-context-pad.open .entry[data-action="connect"]', "connect entry");
    if (!(await node.hit(centre(entry))).pad) throw new Unmeasured("the connect entry is not hit where it is drawn");
    const target = (await node.elementBox("credit-limit-check"))!;
    const text = await board.fileText(FILES.dmn);
    await node.paletteDrag(entry, { x: target.x + target.width * 0.5, y: target.y + target.height * 0.75 });
    const changed = await board.waitForFileChange(FILES.dmn, text, 2000);
    const connected = /<authorityRequirement /.test(changed ?? "");
    return { values: { fileChanged: !!changed, authorityRequirement: connected }, verdict: ok(connected) };
  },
});

add({
  name: "drd-pad-popup",
  group: "drd",
  rule: "pad: 13 diagram units right of the decision (+/- 1). Replace popup: at (pad.left, pad.bottom + 5 chrome px) +/- 1.5 px, every entry hit where it is drawn, 'Literal expression' changes the file",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["dmn"]);
    const env = await envOf(node);
    const id = "credit-limit-check";
    const shape = (await node.elementBox(id))!;
    // below the drill-down button at its top-left
    await board.click(
      await grabPoint(node, id, [
        [0.5, 0.7],
        [0.7, 0.7],
        [0.3, 0.8],
      ]),
    );
    const wrench = await chrome(board, node, '.djs-context-pad.open .entry[data-action="replace"]', "replace entry");
    const pad = await chrome(board, node, ".djs-context-pad.open", "pad");
    const leftmost = Math.min(...(await node.query(".djs-context-pad.open .entry")).map((entry) => entry.x));
    const gapUnits = (leftmost - (shape.x + shape.width)) / env.unit!;
    const wrenchHit = await node.hit(centre(wrench));
    const values: Values = { padGapUnits: r2(gapUnits), wrenchHit: wrenchHit.pad };
    if (!wrenchHit.pad) {
      return { values, verdict: "off", note: `the replace entry is not hit where it is drawn (${wrenchHit.what})` };
    }
    await board.click(centre(wrench));
    const popup = await chrome(board, node, ".djs-popup", "replace popup");
    const error = { x: popup.x - pad.x, y: popup.y - (pad.y + pad.height + 5 * env.net) };
    const entries = await node.query(".djs-popup .entry");
    let reachable = 0;
    for (const entry of entries) if ((await node.hit(centre(entry))).popup) reachable++;
    const literal = (await node.query('.djs-popup .entry[data-id="replace-with-literal-expression"]'))[0];
    const text = await board.fileText(FILES.dmn);
    let replaced = false;
    if (literal && (await node.hit(centre(literal))).popup) {
      await board.click(centre(literal));
      replaced = /<literalExpression /.test((await board.waitForFileChange(FILES.dmn, text, 2000)) ?? "");
    }
    Object.assign(values, {
      popupErrorPx: p2(error),
      popupChromeSize: { width: r2(popup.width / env.net), height: r2(popup.height / env.net) },
      entriesReachable: `${reachable}/${entries.length}`,
      replaced,
    });
    return {
      values,
      verdict: ok(
        near(gapUnits, 13, 1) &&
          Math.abs(error.x) <= 1.5 &&
          Math.abs(error.y) <= 1.5 &&
          reachable === entries.length &&
          replaced,
      ),
    };
  },
});

add({
  name: "drd-label",
  group: "drd",
  rule: "the label editor lies on its input data (+/- 1 px, same size) and the typed name is in the file",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["dmn"]);
    const id = "InputData_overdue";
    const at = await grabPoint(node, id);
    const shape = (await node.elementBox(id))!;
    await board.doubleClick(at);
    const editor = await chrome(board, node, ".djs-direct-editing-parent", "label editor");
    const offset = {
      x: editor.x - shape.x,
      y: editor.y - shape.y,
      width: editor.width - shape.width,
      height: editor.height - shape.height,
    };
    const text = await board.fileText(FILES.dmn);
    await board.press("Control+A");
    await board.type("Edited by shim run");
    await board.press("Enter");
    const typed = /name="Edited by shim run"/.test((await board.waitForFileChange(FILES.dmn, text, 2000)) ?? "");
    return {
      values: { editorMinusShapePx: b2(offset), typedInFile: typed },
      verdict: ok(Object.values(offset).every((value) => Math.abs(value) <= 1.5) && typed),
    };
  },
});

// ── 3. the DMN decision table (HTML, table-js) ───────────────────────────────

const FEEL = [KNOWN_CONSOLE.feelEditor];

/** the DMN node armed and its decision table open, by a real click on the DRD's drill-down button */
async function openTable(
  ctx: Ctx,
  keep: (board: Board) => void,
): Promise<{ board: Board; node: NodeHandle; net: number; host: Box }> {
  const { board, node } = await openNode(ctx, keep, ["dmn"]);
  const drill = (await node.query(".drill-down-overlay"))[0];
  if (!drill || !(await node.hit(centre(drill))).reachable)
    throw new Unmeasured("the DRD's drill-down button is not reachable");
  await board.click(centre(drill));
  const header = await chromeBox(board, node, 'th[data-col-id="Input_order_value"]', 3000);
  if (!header) throw new Unmeasured("the decision table did not open");
  return { board, node, net: await node.netScale(), host: await node.hostBox() };
}

/**
 * A workaround OF THIS SCRIPT for a bug of the board, not of any strategy: the armed node body stops
 * `click` and `dblclick` in React (nodes/model-node.tsx, `onClick={armed ? stop : undefined}`),
 * which stops the native event at React's root, before `document`. dmn-js's HTML views delegate
 * their click handlers on `document` (Inferno), so inside an armed node of every in-node strategy
 * (naive, counter, plugin, shim) a click on a dropdown or a header does nothing. Here React's call
 * of stopPropagation is swallowed for clicks inside an engine host, and nothing else. A row says
 * when it needed this (`neededClickWorkaround`).
 */
async function letClicksThrough(board: Board): Promise<void> {
  await board.page.evaluate(() => {
    const page = window as unknown as { __clicksThrough?: boolean };
    if (page.__clicksThrough) return;
    page.__clicksThrough = true;
    const stop = Event.prototype.stopPropagation;
    for (const type of ["click", "dblclick"]) {
      window.addEventListener(
        type,
        (event) => {
          if (!(event.target instanceof Element) || !event.target.closest(".board-engine")) return;
          Object.defineProperty(event, "stopPropagation", {
            configurable: true,
            writable: true,
            value(this: Event) {
              if (!/react-dom|react_dom/.test(new Error().stack ?? "")) stop.call(this);
            },
          });
        },
        true,
      );
    }
  });
}

/** a box of the table that a press can reach, or Unmeasured: an unscaled table may lie outside a small host */
async function reachable(node: NodeHandle, selector: string, what: string): Promise<Box> {
  const box = (await node.query(selector))[0];
  if (!box) throw new Unmeasured(`${what} is not there`);
  const hit = await node.hit(centre(box));
  if (!hit.reachable) throw new Unmeasured(`${what} lies outside the visible editor (${hit.what})`);
  return box;
}

add({
  name: "table-colresize",
  group: "table",
  rule: "a column border dragged by 40 layout px writes the column's layout width + 40 (+/- 1.5) into the file, as a whole number (a mouse event carries whole px of the document it arrives in)",
  allow: FEEL,
  async run(ctx, keep) {
    const { board, node, net } = await openTable(ctx, keep);
    const column = 'th[data-col-id="Input_order_value"]';
    const header = (await node.query(column))[0]!;
    const handle = await reachable(node, `${column} .resize-column-handle`, "the column's resize handle");
    const text = await board.fileText(FILES.dmn);
    const dragged = await node.drag(centre(handle), { x: 40 * net, y: 0 });
    const changed = await board.waitForFileChange(FILES.dmn, text, 2000);
    const written = /<input id="Input_order_value"[^>]*?(?:biodi:)?width="([^"]+)"/.exec(changed ?? "")?.[1];
    const expected = header.width / net + dragged.delta.x / net;
    const after = (await node.query(column))[0]!;
    return {
      values: {
        writtenWidth: written ?? null,
        expected: r2(expected),
        layoutWidthBefore: r2(header.width / net),
        layoutWidthAfter: r2(after.width / net),
      },
      verdict: ok(written !== undefined && near(Number(written), expected, 1.5) && Number.isInteger(Number(written))),
    };
  },
});

add({
  name: "table-menus",
  group: "table",
  rule: "the cell's context menu opens with a corner at the click (+/- 2 layout px); the hit policy and the type dropdown open at their input's left, under it, as wide as it (+/- 1.5 layout px), every option hit where it is drawn",
  allow: FEEL,
  async run(ctx, keep) {
    const { board, node, net } = await openTable(ctx, keep);
    const values: Values = {};
    let pass = true;
    // the cell's context menu
    const cell = await reachable(node, 'td[data-element-id="UnaryTests_blocked_value"]', "a rule cell");
    const at = centre(cell);
    await board.click(at, { button: "right" });
    const menu = await chromeBox(board, node, ".context-menu", 2000);
    if (menu) {
      const corners = [menu.x, menu.x + menu.width].flatMap((x) =>
        [menu.y, menu.y + menu.height].map((y) => ({ x, y })),
      );
      const nearest =
        Math.min(...corners.map((corner) => Math.max(Math.abs(corner.x - at.x), Math.abs(corner.y - at.y)))) / net;
      values.contextMenu = {
        cornerToClickLayoutPx: r2(nearest),
        size: `${r2(menu.width / net)} x ${r2(menu.height / net)}`,
      };
      pass &&= nearest <= 2;
    } else {
      values.contextMenu = "did not open";
      pass = false;
    }
    await board.press("Escape");
    await board.page.waitForTimeout(150);
    let workaround = false;
    /** a click that is to open `selector`: again with the script's workaround when the board swallowed it */
    const clickToOpen = async (click: () => Promise<void>, selector: string): Promise<Box | null> => {
      await click();
      const opened = await chromeBox(board, node, selector, 1200);
      if (opened) return opened;
      await letClicksThrough(board);
      workaround = true;
      await click();
      return chromeBox(board, node, selector, 2000);
    };
    const dropdown = async (input: Box, name: string): Promise<void> => {
      const options = await clickToOpen(() => board.click(centre(input)), ".dms-select-options");
      if (!options) {
        values[name] = "did not open";
        pass = false;
        return;
      }
      const offset = {
        left: (options.x - input.x) / net,
        top: (options.y - (input.y + input.height)) / net,
        width: (options.width - input.width) / net,
      };
      const optionBoxes = await node.query(".dms-select-options .option");
      let hit = 0;
      for (const option of optionBoxes) {
        const target = await node.inDocument((_host, point) => {
          const native = (window as NativeWindow).__boardSpikeNative;
          const top = native
            ? native.elementFromPoint(document, point.x, point.y)
            : document.elementFromPoint(point.x, point.y);
          return !!top?.closest(".dms-select-options");
        }, centre(option));
        if (target) hit++;
      }
      values[name] = {
        ...Object.fromEntries(Object.entries(offset).map(([key, value]) => [key, r2(value)])),
        optionsHit: `${hit}/${optionBoxes.length}`,
      };
      pass &&= Object.values(offset).every((value) => Math.abs(value) <= 1.5) && hit > 0;
      await board.press("Escape");
      await board.page.waitForTimeout(150);
    };
    await dropdown(
      await reachable(node, ".hit-policy-edit-policy-select .dms-input", "the hit policy input"),
      "hitPolicy",
    );
    // the header's editor holds the type dropdown
    const header = await reachable(node, 'th[data-col-id="Input_order_value"]', "an input header");
    const typeInput = await clickToOpen(
      () => board.doubleClick(centre(header)),
      ".context-menu .type-ref-edit-select .dms-input",
    );
    if (typeInput) await dropdown(typeInput, "typeRef");
    else {
      values.typeRef = "the header's editor did not open";
      pass = false;
    }
    values.neededClickWorkaround = workaround;
    return { values, verdict: ok(pass) };
  },
});

add({
  name: "table-cell",
  group: "table",
  rule: "text typed into a FEEL cell and into a rule's annotation cell (reached by wheeling the table sideways where it is wider than the editor) is in the file; the wheel leaves the board's viewport alone",
  allow: FEEL,
  async run(ctx, keep) {
    const { board, node, net } = await openTable(ctx, keep);
    const start = await board.fileText(FILES.dmn);
    const feel = await reachable(node, 'td[data-element-id="UnaryTests_blocked_value"]', "a FEEL cell");
    await board.click(centre(feel));
    await board.page.waitForTimeout(300);
    await board.press("Control+A");
    await board.type("> 4711");
    // the annotation column is the last one: wider than a node at layout size, the table scrolls to it
    const annotationCell = 'td.annotation[data-element-id="Rule_blocked_customer"]';
    const table = await reachable(node, ".tjs-table-container", "the table");
    const viewport = await board.viewport();
    let wheeled = 0;
    for (let turn = 0; turn < 6; turn++) {
      const box = (await node.query(annotationCell))[0];
      if (box && (await node.hit(centre(box))).reachable) break;
      await board.wheel({ x: table.x + table.width / 2, y: table.y + table.height / 2 }, 0, { deltaX: 200 });
      wheeled += 200;
      await board.page.waitForTimeout(250);
    }
    const scrolled = await node.inDocument((host) => host.querySelector(".tjs-table-container")?.scrollLeft ?? 0);
    const boardKept = JSON.stringify(await board.viewport()) === JSON.stringify(viewport);
    const annotation = await reachable(node, annotationCell, "an annotation cell");
    await board.click(centre(annotation));
    await board.press("Control+A");
    await board.type("plain shim text");
    // a click on another cell commits
    await board.click(centre(await reachable(node, 'td[data-element-id="LiteralExpression_blocked"]', "another cell")));
    await board.waitForFileChange(FILES.dmn, start, 2500);
    await board.page.waitForTimeout(600);
    const text = (await board.fileText(FILES.dmn)) ?? "";
    const plain = text.includes("plain shim text");
    const feelTyped = text.includes("&gt; 4711");
    return {
      values: {
        feelInFile: feelTyped,
        annotationInFile: plain,
        wheelDeltaX: wheeled,
        tableScrolledLayoutPx: scrolled,
        hostLayoutWidth: r2((await node.hostBox()).width / net),
        boardViewportKept: boardKept,
      },
      verdict: ok(plain && feelTyped && boardKept),
    };
  },
});

add({
  name: "table-feel-caret",
  group: "table",
  rule: "a click 25 % into character 6 of a FEEL cell's text puts the caret at index 6, one 75 % into character 3 at index 4, and a drag from character 2 to 9 selects exactly those characters",
  allow: FEEL,
  async run(ctx, keep) {
    const { board, node } = await openTable(ctx, keep);
    const selector = 'td[data-element-id="UnaryTests_key_segment"]';
    const cell = await reachable(node, selector, "the FEEL cell");
    await board.click(centre(cell));
    await board.page.waitForTimeout(400);
    /** where the cell's characters are on screen (the browser's own range rectangles), and its text */
    const characters = (): Promise<Array<{ x: number; y: number; width: number; height: number }>> =>
      node.inDocument((host, query) => {
        const line = host.querySelector(`${query} .cm-content`);
        if (!line) return [];
        const native = (window as NativeWindow).__boardSpikeNative;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        const out: Array<{ x: number; y: number; width: number; height: number }> = [];
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
          for (let index = 0; index < (text.textContent ?? "").length; index++) {
            const range = document.createRange();
            range.setStart(text, index);
            range.setEnd(text, index + 1);
            const rect = native ? native.rect(range) : range.getBoundingClientRect();
            out.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
          }
        }
        return out;
      }, selector);
    const state = (): Promise<{ head: number; text: string; selected: string }> =>
      node.inDocument((host, query) => {
        const line = host.querySelector(`${query} .cm-content`);
        const selection = document.getSelection();
        let head = -1;
        if (line && selection?.focusNode && line.contains(selection.focusNode)) {
          const range = document.createRange();
          range.selectNodeContents(line);
          range.setEnd(selection.focusNode, selection.focusOffset);
          head = range.toString().length;
        }
        return { head, text: line?.textContent ?? "", selected: selection?.toString() ?? "" };
      }, selector);
    const rects = await characters();
    if (rects.length < 10)
      throw new Unmeasured(`the FEEL cell shows ${rects.length} characters: no editor, or too short a text`);
    const within = (index: number, fraction: number): Point => ({
      x: rects[index]!.x + rects[index]!.width * fraction,
      y: rects[index]!.y + rects[index]!.height / 2,
    });
    await board.click(within(6, 0.25));
    await board.page.waitForTimeout(200);
    const atSix = await state();
    await board.click(within(3, 0.75));
    await board.page.waitForTimeout(200);
    const atFour = await state();
    await board.drag(within(2, 0.1), within(9, 0.1), { lead: [2] });
    await board.page.waitForTimeout(200);
    const dragged = await state();
    const expected = dragged.text.slice(2, 9);
    const ancestorsScrolled = await node.inDocument((host) => {
      const moved: string[] = [];
      for (let element = host.parentElement; element; element = element.parentElement) {
        if (element.scrollLeft !== 0 || element.scrollTop !== 0)
          moved.push(`${element.className.split(" ")[0]} ${element.scrollLeft},${element.scrollTop}`);
      }
      return moved;
    });
    return {
      values: {
        text: atSix.text,
        caretAfterClickInChar6: atSix.head,
        caretAfterClickInChar3: atFour.head,
        dragSelected: dragged.selected,
        dragExpected: expected,
        characterWidthPx: r2(rects[6]!.width),
        ancestorsScrolled,
      },
      verdict: ok(
        atSix.head === 6 && atFour.head === 4 && dragged.selected === expected && ancestorsScrolled.length === 0,
      ),
    };
  },
});

add({
  name: "table-literal",
  group: "table",
  rule: "the literal expression view. The sample has none: its decision is turned into one through the engine's own replace service (no pointer involved). Then the view opens by a click on the DRD's drill-down button, text typed into the expression is in the file, and the type dropdown opens at its input's left, under it, in the same place as in the unscaled editor (+/- 2 layout px)",
  allow: [...FEEL, ...PAD_ALLOW],
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["dmn"]);
    const net = await node.netScale();
    await withDiagram(board, DMN, (diagram) => {
      const registry = diagram.get("elementRegistry") as { get(id: string): unknown };
      const replace = diagram.get("drdReplace") as { replaceElement(element: unknown, target: object): void };
      replace.replaceElement(registry.get("credit-limit-check"), {
        type: "dmn:Decision",
        expression: "dmn:LiteralExpression",
      });
    });
    await board.page.waitForTimeout(600);
    const drill = (await node.query(".drill-down-overlay"))[0];
    if (!drill || !(await node.hit(centre(drill))).reachable)
      throw new Unmeasured("the drill-down button is not reachable");
    await board.click(centre(drill));
    const editor = await board.waitForBox(first(node, ".dmn-literal-expression-container .literal-expression"), 3000);
    if (!editor) throw new Unmeasured("the literal expression view did not open");
    const text = await board.fileText(FILES.dmn);
    await board.click(centre(editor));
    await board.page.waitForTimeout(300);
    await board.type("1 + 2");
    const typed = /<text>1 \+ 2<\/text>/.test((await board.waitForFileChange(FILES.dmn, text, 2500)) ?? "");
    const input = (await node.query(".dmn-literal-expression-container .variable-type-select input.dms-input"))[0];
    const values: Values = {
      typedInFile: typed,
      editorLayoutSize: `${r2(editor.width / net)} x ${r2(editor.height / net)}`,
    };
    let placed = false;
    if (input && (await node.hit(centre(input))).reachable) {
      const open = async (): Promise<Box | null> => {
        await board.click(centre(input));
        return board.waitForBox(first(node, ".dms-select-options"), 1200);
      };
      let options = await open();
      if (!options) {
        await letClicksThrough(board);
        values.neededClickWorkaround = true;
        options = await open();
      }
      if (options) {
        const offset = {
          left: r2((options.x - input.x) / net),
          top: r2((options.y - (input.y + input.height)) / net),
          width: r2((options.width - input.width) / net),
        };
        values.typeDropdown = offset;
        // the select's box is wider than its input by its own padding and icon: the reference is the unscaled editor
        placed = Math.abs(offset.left) <= 12 && Math.abs(offset.top) <= 12;
        return {
          values,
          verdict: ok(typed && placed),
          layout: { typeDropdown: { x: offset.left, y: offset.top, width: offset.width, height: 0 } },
          net,
        };
      }
      values.typeDropdown = "did not open";
    } else values.typeDropdown = "the type input is not reachable";
    return { values, verdict: ok(typed && placed) };
  },
});

// ── 4. the five Miragon renderers ────────────────────────────────────────────

type Miragon = Exclude<ModelNotation, "bpmn" | "dmn">;

interface Renderer {
  /** a shape that moves freely, and where to press on its box (default: its middle) */
  mover: string;
  grab?(box: Box): Point;
  /** held after the press of a move: switches the renderer's snapping off */
  hold?: readonly string[];
  /** the palette entry (data-action) a create drags out, and half the size of what it makes (diagram units) */
  create: string;
  half: Point;
  /** the pad entry (data-action) that opens a popup menu, and the entry of it (data-id) to choose */
  popup?: readonly [string, string];
  /** the label editor a double-click on the mover opens */
  editor: string;
}

const RENDERERS: Readonly<Record<Miragon, Renderer>> = {
  wardley: {
    mover: "cmp_cup",
    // the component's circle at the left of its graphics: the name beside it has a drag of its own
    grab: (box) => ({ x: box.x + box.height / 2, y: box.y + box.height / 2 }),
    create: "create.component",
    half: { x: 12, y: 12 },
    popup: ["settings", "type-market"],
    editor: ".wardley-label-input",
  },
  "team-topology": {
    mover: "team_fraud",
    create: "team.stream-aligned",
    half: { x: 120, y: 47 },
    editor: ".tt-label-editor",
  },
  "event-storming": {
    mover: "cmd_place_order",
    // a sticky's centre snaps to another's within 8 units unless Shift is held
    hold: ["Shift"],
    create: "create.command",
    half: { x: 65, y: 45 },
    popup: ["change-kind", "kind-policy"],
    editor: ".event-storming-label-input",
  },
  "context-map": {
    mover: "ctx_ordering",
    create: "context.core",
    half: { x: 99, y: 54 },
    popup: ["subdomain-type", "type-supporting"],
    editor: ".djs-direct-editing-parent",
  },
  "value-chain": {
    mover: "step-capture",
    create: "create.step",
    half: { x: 80, y: 30 },
    popup: ["set-color", "color-blue"],
    editor: ".djs-direct-editing-parent",
  },
};

const miragon = (Object.keys(RENDERERS) as Miragon[]).filter(
  (notation) => notationFilter.length === 0 || notationFilter.includes(notation),
);

const grabOf = (renderer: Renderer, box: Box): Point => (renderer.grab ? renderer.grab(box) : centre(box));

/** the press point on the renderer's mover, hit-tested */
async function moverPoint(node: NodeHandle, renderer: Renderer): Promise<Point> {
  const box = await node.elementBox(renderer.mover);
  if (!box) throw new Unmeasured(`${renderer.mover} is not drawn`);
  const point = aimAt(await node.map(), grabOf(renderer, box));
  const hit = await node.hit(point);
  if (!hit.reachable || hit.element !== renderer.mover) {
    throw new Unmeasured(`${renderer.mover} is covered at its grab point (${hit.what})`);
  }
  return point;
}

for (const notation of miragon) {
  const renderer = RENDERERS[notation];
  const file = FILES[notation];

  add({
    name: `${notation}-move`,
    group: "miragon",
    rule: "shape displacement over pointer displacement is 1 +/- 0.05 on both axes",
    async run(ctx, keep) {
      const { node } = await openNode(ctx, keep, [notation]);
      const from = await moverPoint(node, renderer);
      const before = (await node.elementBox(renderer.mover))!;
      const dragged = await node.drag(from, { x: 60 * ctx.zoom, y: 40 * ctx.zoom }, { hold: renderer.hold ?? [] });
      const after = (await node.elementBox(renderer.mover))!;
      const ratio = { x: (after.x - before.x) / dragged.delta.x, y: (after.y - before.y) / dragged.delta.y };
      return {
        values: { ratio: { x: round(ratio.x, 3), y: round(ratio.y, 3) }, pointer: p2(dragged.delta) },
        verdict: ok(near(ratio.x, 1, 0.05) && near(ratio.y, 1, 0.05)),
      };
    },
  });

  add({
    name: `${notation}-create`,
    group: "miragon",
    rule: "a palette drag creates a shape that contains the drop point, in the same place of the editor as in the unscaled one (+/- 2 layout px)",
    async run(ctx, keep) {
      const { board, node } = await openNode(ctx, keep, [notation]);
      const env = await envOf(node);
      const host = await node.hostBox();
      const drop = await clearPoint(node, renderer.half);
      // the renderer's snapping off where a key does that: the pointer lands on slightly different units per zoom
      const made = await createByDrag(board, node, file, renderer.create, drop, renderer.hold ?? []);
      const id = made.created[0];
      const box = id ? await node.elementBox(id) : null;
      if (!box)
        return {
          values: { created: made.created, fileChanged: made.changed },
          verdict: "off",
          note: "no shape was created",
        };
      const contains =
        made.to.x >= box.x - 1 &&
        made.to.x <= box.x + box.width + 1 &&
        made.to.y >= box.y - 1 &&
        made.to.y <= box.y + box.height + 1;
      return {
        values: {
          dropInsideNewShape: contains,
          centreMinusDropPx: p2(sub(centre(box), made.to)),
          fileChanged: made.changed,
        },
        verdict: ok(contains && made.changed),
        layout: { created: inHost(box, host, env.net) },
        net: env.net,
      };
    },
  });

  add({
    name: `${notation}-pad-popup`,
    group: "miragon",
    rule: "the pad, and the popup menu one of its entries opens, lie where they do in the unscaled editor (+/- 2 layout px); every popup entry is hit where it is drawn and the chosen one changes the file",
    async run(ctx, keep) {
      const { board, node } = await openNode(ctx, keep, [notation]);
      const env = await envOf(node);
      const host = await node.hostBox();
      await board.click(await moverPoint(node, renderer));
      const pad = await chrome(board, node, ".djs-context-pad.open", "the pad");
      const layout: Layout = { pad: inHost(pad, host, env.net) };
      const values: Values = {
        padEntryPx: r2(((await node.query(".djs-context-pad.open .entry"))[0]?.width ?? 0) / 1),
      };
      if (!renderer.popup)
        return {
          values: { ...values, popup: "this renderer's pad opens no popup menu" },
          verdict: "ok",
          layout,
          net: env.net,
        };
      const [action, choice] = renderer.popup;
      const entry = await chrome(
        board,
        node,
        `.djs-context-pad.open .entry[data-action="${action}"]`,
        `pad entry ${action}`,
      );
      const entryHit = await node.hit(centre(entry));
      if (!entryHit.pad) {
        return {
          values: { ...values, entryHit: entryHit.what },
          verdict: "off",
          note: "the pad entry is not hit where it is drawn",
          layout,
          net: env.net,
        };
      }
      await board.click(centre(entry));
      const popup = await chromeBox(board, node, ".djs-popup", 2000);
      if (!popup) return { values, verdict: "off", note: "the popup did not open", layout, net: env.net };
      layout.popup = inHost(popup, host, env.net);
      const entries = await node.query(".djs-popup .entry");
      let reach = 0;
      for (const one of entries) if ((await node.hit(centre(one))).popup) reach++;
      const pick = (await node.query(`.djs-popup .entry[data-id="${choice}"]`))[0];
      const text = await board.fileText(file);
      let changed = false;
      if (pick && (await node.hit(centre(pick))).popup) {
        await board.click(centre(pick));
        changed = !!(await board.waitForFileChange(file, text, 2000));
      }
      Object.assign(values, {
        popupMinusEntryChromePx: p2({ x: (popup.x - entry.x) / env.net, y: (popup.y - entry.y) / env.net }),
        entriesReachable: `${reach}/${entries.length}`,
        choiceChangedFile: changed,
      });
      return { values, verdict: ok(reach === entries.length && changed), layout, net: env.net };
    },
  });

  add({
    name: `${notation}-label`,
    group: "miragon",
    rule: "the label editor a double-click opens lies where it does in the unscaled editor (+/- 2 layout px), and the typed text is in the file",
    async run(ctx, keep) {
      const { board, node } = await openNode(ctx, keep, [notation]);
      const env = await envOf(node);
      const host = await node.hostBox();
      const at = await moverPoint(node, renderer);
      await board.doubleClick(at);
      const editor = await chrome(board, node, renderer.editor, "the label editor");
      const text = await board.fileText(file);
      await board.press("Control+A");
      await board.type("Zeta");
      await board.press("Enter");
      let changed = await board.waitForFileChange(file, text, 1200);
      if (!changed) {
        // an editor in which Enter is a line break: a click on the bare canvas completes
        await board.click(await freeCanvasPoint(node));
        changed = await board.waitForFileChange(file, text, 1500);
      }
      const typed = (changed ?? "").includes("Zeta");
      return {
        values: {
          typedInFile: typed,
          editorChromeSize: `${r2(editor.width / env.net)} x ${r2(editor.height / env.net)}`,
        },
        verdict: ok(typed),
        layout: { editor: inHost(editor, host, env.net) },
        net: env.net,
      };
    },
  });
}

/** a drag of a resize handle of the selected shape: size change over pointer travel */
async function resizeBy(board: Board, node: NodeHandle, id: string, zoom: number): Promise<Result> {
  const handle = await chrome(board, node, ".djs-resizer-se .djs-resizer-hit", "south-east resize handle");
  if (!(await node.hit(centre(handle))).reachable) throw new Unmeasured("the resize handle is not reachable");
  const before = (await node.elementBox(id))!;
  const dragged = await node.drag(centre(handle), { x: 40 * zoom, y: 30 * zoom });
  await board.page.waitForTimeout(300);
  const after = (await node.elementBox(id))!;
  const ratio = {
    x: (after.width - before.width) / dragged.delta.x,
    y: (after.height - before.height) / dragged.delta.y,
  };
  return {
    values: { sizeChangeOverPointer: { x: round(ratio.x, 3), y: round(ratio.y, 3) }, pointer: p2(dragged.delta) },
    verdict: ok(near(ratio.x, 1, 0.1) && near(ratio.y, 1, 0.1)),
  };
}

if (miragon.includes("wardley")) {
  add({
    name: "wardley-gesture",
    group: "miragon",
    rule: "Wardley's evolve handle (Kettle's red circle) travels what the pointer travels along the evolution axis, ratio 1 +/- 0.1, and the file's evolve value changes",
    async run(ctx, keep) {
      const { board, node } = await openNode(ctx, keep, ["wardley"]);
      const selector = '[data-element-id="cmp_kettle"] .wardley-evolve-handle';
      const handle = (await node.query(selector))[0];
      if (!handle) throw new Unmeasured("Kettle shows no evolve handle");
      const at = aimAt(await node.map(), centre(handle));
      const hit = await node.hit(at);
      if (!hit.reachable || !hit.what.includes("wardley-evolve-handle")) {
        throw new Unmeasured(`the evolve handle is covered (${hit.what})`);
      }
      const text = await board.fileText(FILES.wardley);
      const dragged = await node.drag(at, { x: 60 * ctx.zoom, y: 0 });
      const changed = await board.waitForFileChange(FILES.wardley, text, 2000);
      const after = (await node.query(selector))[0];
      if (!after) return { values: {}, verdict: "off", note: "the handle is gone after the drag" };
      const ratio = (after.x - handle.x) / dragged.delta.x;
      return {
        values: {
          handleMovedOverPointer: round(ratio, 3),
          pointer: p2(dragged.delta),
          evolve: [
            /evolve Kettle ([\d.]+)/.exec(text ?? "")?.[1] ?? null,
            /evolve Kettle ([\d.]+)/.exec(changed ?? "")?.[1] ?? null,
          ],
        },
        verdict: ok(near(ratio, 1, 0.1) && !!changed),
      };
    },
  });
}

if (miragon.includes("team-topology")) {
  add({
    name: "team-topology-gesture",
    group: "miragon",
    rule: "a team resized by its south-east handle grows by the pointer's travel, ratio 1 +/- 0.1",
    async run(ctx, keep) {
      const { board, node } = await openNode(ctx, keep, ["team-topology"]);
      await board.click(await moverPoint(node, RENDERERS["team-topology"]));
      return resizeBy(board, node, RENDERERS["team-topology"].mover, ctx.zoom);
    },
  });
}

if (miragon.includes("value-chain")) {
  add({
    name: "value-chain-gesture",
    group: "miragon",
    rule: "a step resized by its south-east handle grows by the pointer's travel, ratio 1 +/- 0.1",
    async run(ctx, keep) {
      const { board, node } = await openNode(ctx, keep, ["value-chain"]);
      await board.click(await moverPoint(node, RENDERERS["value-chain"]));
      return resizeBy(board, node, RENDERERS["value-chain"].mover, ctx.zoom);
    },
  });
}

if (miragon.includes("event-storming")) {
  add({
    name: "event-storming-gesture",
    group: "miragon",
    rule: "Event Storming's draw tool (three clicks and Enter): the drawing's box is the box of the clicked points, +/- max(3 px, 2 units)",
    async run(ctx, keep) {
      const { board, node } = await openNode(ctx, keep, ["event-storming"]);
      const unit = (await node.diagramScale())!;
      const tool = (await node.query('.djs-palette .entry[data-action="draw-tool"]'))[0];
      if (!tool || !(await node.hit(centre(tool))).palette)
        throw new Unmeasured("the draw tool's palette entry is not reachable");
      const middle = await clearPoint(node, { x: 60, y: 40 });
      const map = await node.map();
      // the renderer converts these client points itself (its own toCanvasPoint), outside diagram-js's dragging
      const points = [
        aimAt(map, { x: middle.x - 40 * ctx.zoom, y: middle.y + 25 * ctx.zoom }),
        aimAt(map, { x: middle.x, y: middle.y - 25 * ctx.zoom }),
        aimAt(map, { x: middle.x + 40 * ctx.zoom, y: middle.y + 25 * ctx.zoom }),
      ];
      for (const point of points) {
        const hit = await node.hit(point);
        if (!hit.reachable || !hit.what.startsWith("svg"))
          throw new Unmeasured(`a point of the line is not bare canvas (${hit.what})`);
      }
      const ids = await node.elementIds();
      const text = await board.fileText(FILES["event-storming"]);
      await board.click(centre(tool));
      await board.page.waitForTimeout(100);
      for (const point of points) {
        await board.move(point, 5);
        await board.click(point);
        await board.page.waitForTimeout(80);
      }
      await board.press("Enter");
      const changed = await board.waitForFileChange(FILES["event-storming"], text, 2000);
      const id = newIds(ids, await node.elementIds())[0];
      const box = id ? await node.elementBox(id) : null;
      if (!box)
        return { values: { fileChanged: !!changed }, verdict: "off", note: "three clicks and Enter drew nothing" };
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const error = Math.max(
        Math.abs(box.x - Math.min(...xs)),
        Math.abs(box.y - Math.min(...ys)),
        Math.abs(box.x + box.width - Math.max(...xs)),
        Math.abs(box.y + box.height - Math.max(...ys)),
      );
      return {
        values: { drawingVsClickedPx: r2(error), unitPx: r2(unit), fileChanged: !!changed },
        verdict: ok(error <= Math.max(3, 2 * unit) && !!changed),
      };
    },
  });
}

if (miragon.includes("context-map")) {
  add({
    name: "context-map-gesture",
    group: "miragon",
    rule: "a drag from the pad's connect entry to another context writes a relationship between the two",
    async run(ctx, keep) {
      const { board, node } = await openNode(ctx, keep, ["context-map"]);
      const [source, target] = ["ctx_catalog", "ctx_payment"];
      await selectAt(board, node, source);
      const entry = await chrome(board, node, '.djs-context-pad.open .entry[data-action="connect"]', "connect entry");
      if (!(await node.hit(centre(entry))).pad) throw new Unmeasured("the connect entry is not hit where it is drawn");
      const box = (await node.elementBox(target))!;
      const ids = await node.elementIds();
      const text = await board.fileText(FILES["context-map"]);
      await node.paletteDrag(entry, { x: box.x + box.width * 0.4, y: box.y + box.height * 0.6 });
      const changed = await board.waitForFileChange(FILES["context-map"], text, 2000);
      await board.press("Escape");
      const made = newIds(ids, await node.elementIds());
      const related =
        made.length > 0 &&
        new RegExp(`"${source}"[\\s\\S]{0,200}"${target}"|"${target}"[\\s\\S]{0,200}"${source}"`).test(changed ?? "");
      return { values: { fileChanged: !!changed, newElements: made, relationship: related }, verdict: ok(related) };
    },
  });

  add({
    name: "context-map-prompt",
    group: "miragon",
    rule: "Context Maps' fixed pad prompt (the description entry) lies where it does in the unscaled editor (+/- 2 layout px), beside its pad entry, and the typed text is in the file",
    async run(ctx, keep) {
      const { board, node } = await openNode(ctx, keep, ["context-map"]);
      const env = await envOf(node);
      const host = await node.hostBox();
      await board.click(await moverPoint(node, RENDERERS["context-map"]));
      const entry = await chrome(
        board,
        node,
        '.djs-context-pad.open .entry[data-action="description"]',
        "description entry",
      );
      if (!(await node.hit(centre(entry))).pad)
        throw new Unmeasured("the description entry is not hit where it is drawn");
      await board.click(centre(entry));
      const prompt = await chromeBox(board, node, ".cm-pad-prompt", 2000);
      if (!prompt) return { values: {}, verdict: "off", note: "the prompt did not open" };
      const beside = { x: (prompt.x - (entry.x + entry.width)) / env.net, y: (prompt.y - entry.y) / env.net };
      const promptHit = await node.inDocument((_host, point) => {
        const native = (window as NativeWindow).__boardSpikeNative;
        const top = native
          ? native.elementFromPoint(document, point.x, point.y)
          : document.elementFromPoint(point.x, point.y);
        return !!top?.closest(".cm-pad-prompt");
      }, centre(prompt));
      const text = await board.fileText(FILES["context-map"]);
      await board.type("Typed into the prompt");
      await board.press("Enter");
      let changed = await board.waitForFileChange(FILES["context-map"], text, 1200);
      if (!changed) {
        await board.press("Control+Enter");
        changed = await board.waitForFileChange(FILES["context-map"], text, 1500);
      }
      const typed = (changed ?? "").includes("Typed into the prompt");
      const view = board.page.viewportSize()!;
      return {
        values: {
          promptMinusEntryRightChromePx: p2(beside),
          promptChromeSize: `${r2(prompt.width / env.net)} x ${r2(prompt.height / env.net)}`,
          promptHitWhereDrawn: promptHit,
          insideWindow:
            prompt.x >= 0 &&
            prompt.y >= 0 &&
            prompt.x + prompt.width <= view.width &&
            prompt.y + prompt.height <= view.height,
          typedInFile: typed,
        },
        verdict: ok(promptHit && typed && near(beside.x, 8, 2) && near(beside.y, 0, 2)),
        layout: { prompt: inHost(prompt, host, env.net) },
        net: env.net,
      };
    },
  });
}

// ── the page around an editor ────────────────────────────────────────────────

/** the true client box of the first match in the board page */
const pageBox = (board: Board, selector: string): Promise<Box | null> =>
  board.page.evaluate((query) => {
    const element = document.querySelector(query);
    if (!element) return null;
    const native = (window as NativeWindow).__boardSpikeNative;
    const { x, y, width, height } = native ? native.rect(element) : element.getBoundingClientRect();
    return { x, y, width, height };
  }, selector);

const wrapper = (id: string): string => `.react-flow__node[data-id="${id}"]`;

/** what window.__boardSpikeShim says; null where the shim's modules never loaded */
interface ShimState {
  installed: string[];
  stuck: string[];
  spaces: Array<{
    nodeId: string;
    reads: number;
    frame: { ox: number; oy: number; sx: number; sy: number } | null;
    clippedBy: string[];
    containingBlock: { element: string; because: string; originError: number } | null;
  }>;
  stats: {
    events: { seen: number; inScope: number; converted: number };
    rect: { calls: number; inHost: number; ancestorVirtual: number; ancestorTrue: number };
    rects: { calls: number; inHost: number };
    range: { calls: number; inHost: number };
    point: Record<string, number>;
    ctm: { calls: number; inHost: number };
    viewport: Record<string, number>;
    samples: Record<string, string[]>;
  };
}
const shimState = (board: Board, reset = false): Promise<ShimState | null> =>
  board.page.evaluate((clear) => {
    const shim = (
      window as unknown as {
        __boardSpikeShim?: {
          installed(): string[];
          stuck(): string[];
          spaces(): ShimState["spaces"];
          stats(): ShimState["stats"];
          resetStats(): void;
        };
      }
    ).__boardSpikeShim;
    if (!shim) return null;
    const state = { installed: shim.installed(), stuck: shim.stuck(), spaces: shim.spaces(), stats: shim.stats() };
    if (clear) shim.resetStats();
    return state;
  }, reset);

/** one free drag of a BPMN task of `nodeId` (Control held): displacement over pointer travel */
async function taskRatio(board: Board, nodeId: string, id: string, zoom: number): Promise<Point> {
  const node = await board.node(nodeId);
  const from = await grabPoint(node, id);
  const before = (await node.elementBox(id))!;
  const dragged = await node.drag(from, { x: 40 * zoom, y: 30 * zoom }, { hold: ["Control"] });
  const after = (await node.elementBox(id))!;
  // diagram-js swallows a click for 400 ms after a drag (Dragging.js, installClickTrap): whatever a
  // case does next must not fall into that, in any strategy
  await board.page.waitForTimeout(450);
  return { x: round((after.x - before.x) / dragged.delta.x, 3), y: round((after.y - before.y) / dragged.delta.y, 3) };
}
const exact = (ratio: Point): boolean => near(ratio.x, 1, 0.03) && near(ratio.y, 1, 0.03);

/** the replace popup of a BPMN task against its pad: where it is minus where it belongs, in px. Leaves it open */
async function popupError(board: Board, node: NodeHandle, id: string): Promise<{ error: Point; gapUnits: number }> {
  const env = await envOf(node);
  await selectAt(board, node, id);
  const shape = (await node.elementBox(id))!;
  const wrench = await chrome(board, node, '.djs-context-pad.open .entry[data-action="replace"]', "replace entry");
  const pad = await chrome(board, node, ".djs-context-pad.open", "pad");
  const leftmost = Math.min(...(await node.query(".djs-context-pad.open .entry")).map((entry) => entry.x));
  const gapUnits = (leftmost - (shape.x + shape.width)) / env.unit!;
  if (!(await node.hit(centre(wrench))).pad) throw new Unmeasured("the replace entry is not hit where it is drawn");
  await board.click(centre(wrench));
  const popup = await chrome(board, node, ".djs-popup", "replace popup");
  return { error: { x: popup.x - pad.x, y: popup.y - (pad.y + pad.height + 5 * env.net) }, gapUnits };
}

// ── 5. the board around the armed node ───────────────────────────────────────

const BOARD_ZOOMS = [0.5, 1];

add({
  name: "board-header-drag",
  group: "board",
  zooms: BOARD_ZOOMS,
  allow: PAD_ALLOW,
  rule: "the armed node dragged by its header moves by the pointer's travel (+/- 2 px), stays armed and mounted once; a drag in its editor right after is exact and its popup opens on its pad",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn", "dmn"]);
    const header = (await pageBox(board, `${wrapper(BPMN)} .board-node__header`))!;
    const before = (await board.nodeBox(BPMN))!;
    const from = { x: Math.round(header.x + header.width * 0.3), y: Math.round(header.y + header.height / 2) };
    await board.drag(from, { x: from.x + 93, y: from.y + 50 }, { lead: [3] });
    await board.page.waitForTimeout(300);
    const after = (await board.nodeBox(BPMN))!;
    const moved = { x: after.x - before.x, y: after.y - before.y };
    const state = await node.state();
    const ratio = await taskRatio(board, BPMN, "Task_check_credit", ctx.zoom);
    const popup = await popupError(board, node, "Task_fulfill_order");
    const mounts = (await board.counters()).mounts[BPMN];
    return {
      values: {
        nodeMovedPx: p2(moved),
        pointerPx: { x: 93, y: 50 },
        armed: state.armed,
        mounts,
        editorDragAfter: ratio,
        popupErrorPx: p2(popup.error),
      },
      // the node drag starts at the first move: its travel is the whole distance minus that lead step
      verdict: ok(
        Math.hypot(moved.x, moved.y) > 90 &&
          Math.abs(moved.x - 93) <= 4 &&
          Math.abs(moved.y - 50) <= 4 &&
          state.armed &&
          mounts === 1 &&
          exact(ratio) &&
          Math.abs(popup.error.x) <= 1.5 &&
          Math.abs(popup.error.y) <= 1.5,
      ),
    };
  },
});

add({
  name: "board-resize-node",
  group: "board",
  zooms: BOARD_ZOOMS,
  rule: "the armed node resized by its bottom-right control changes size by the pointer's travel (+/- 3 px), the board file has the new size, and a drag in its editor right after is exact",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn", "dmn"]);
    const header = (await pageBox(board, `${wrapper(BPMN)} .board-node__header`))!;
    await board.click({ x: header.x + header.width * 0.3, y: header.y + header.height / 2 });
    await board.page.waitForTimeout(200);
    const control = await pageBox(board, `${wrapper(BPMN)} .react-flow__resize-control.handle.bottom.right`);
    if (!control) throw new Unmeasured("the selected node shows no resize control");
    const before = (await board.nodeBox(BPMN))!;
    const text = await board.boardText();
    // its outer quarter: an editor above the board covers the inner one
    const from = { x: Math.round(control.x + control.width * 0.8), y: Math.round(control.y + control.height * 0.8) };
    await board.drag(from, { x: from.x - 83, y: from.y - 47 }, { lead: [3] });
    await board.page.waitForTimeout(400);
    const after = (await board.nodeBox(BPMN))!;
    const grew = { x: after.width - before.width, y: after.height - before.height };
    const host = await node.hostBox();
    const written = (await board.boardText()) !== text;
    const ratio = await taskRatio(board, BPMN, "Task_check_credit", ctx.zoom);
    return {
      values: {
        sizeChangePx: p2(grew),
        pointerPx: { x: -83, y: -47 },
        hostFollows: r2(host.width - after.width),
        boardFileWritten: written,
        armed: (await node.state()).armed,
        editorDragAfter: ratio,
      },
      verdict: ok(Math.abs(grew.x + 83) <= 4 && Math.abs(grew.y + 47) <= 4 && written && exact(ratio)),
    };
  },
});

add({
  name: "board-pan-zoom",
  group: "board",
  zooms: BOARD_ZOOMS,
  rule: "with a node armed: a pane drag pans the board by the pointer's travel (+/- 4 px), and a wheel over another node, over the armed node's header and over the pane zooms the board about the pointer (the flow point under it stays within 1 px)",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn", "dmn"]);
    const values: Values = {};
    let pass = true;
    const free = await board.freePanePoint();
    if (!free) throw new Unmeasured("no bare pane point");
    const start = await board.viewport();
    await board.drag(free, { x: free.x - 83, y: free.y - 47 }, { lead: [3] });
    await board.page.waitForTimeout(200);
    const panned = await board.viewport();
    const pan = { x: panned.x - start.x, y: panned.y - start.y };
    values.panPx = p2(pan);
    pass &&= Math.abs(pan.x + 83) <= 4 && Math.abs(pan.y + 47) <= 4 && panned.zoom === start.zoom;
    // back where the nodes are inside the window, whatever the wheels below do
    await board.setViewport(start);
    const canvas = await board.canvasBox();
    const wheelAt = async (name: string, at: Point): Promise<void> => {
      const before = await board.viewport();
      const flow = { x: (at.x - canvas.x - before.x) / before.zoom, y: (at.y - canvas.y - before.y) / before.zoom };
      await board.wheel(at, -40);
      await board.page.waitForTimeout(300);
      const after = await board.viewport();
      const now = { x: canvas.x + after.x + flow.x * after.zoom, y: canvas.y + after.y + flow.y * after.zoom };
      const drift = Math.hypot(now.x - at.x, now.y - at.y);
      values[name] = { zoom: [round(before.zoom, 4), round(after.zoom, 4)], pivotDriftPx: r2(drift) };
      pass &&= after.zoom > before.zoom && drift <= 1;
    };
    const other = await board.nodeBox(DMN);
    if (other)
      await wheelAt("wheelOverOtherNode", { x: Math.round(other.x + 30), y: Math.round(other.y + other.height / 2) });
    const header = await pageBox(board, `${wrapper(BPMN)} .board-node__header`);
    if (header) {
      await wheelAt("wheelOverArmedHeader", {
        x: Math.round(header.x + header.width * 0.3),
        y: Math.round(header.y + header.height / 2),
      });
    }
    const box = (await board.nodeBox(BPMN))!;
    // bare pane right under the armed node
    await wheelAt("wheelOverPane", { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height + 30) });
    values.armed = (await node.state()).armed;
    const ratio = await taskRatio(board, BPMN, "Task_check_credit", (await board.viewport()).zoom);
    values.editorDragAfter = ratio;
    return { values, verdict: ok(pass && values.armed === true) };
  },
});

add({
  name: "board-arrow",
  group: "board",
  zooms: [0.5],
  rule: "an arrow drawn from a note's handle to the armed node's handle is written to the board file with these two ends, and is drawn from one to the other (its box ends within 10 px of both: a handle is 8 px)",
  async run(ctx, keep) {
    const board = await ctx.harness.open({ board: "demo", strategy: ctx.strategy, params: shimParams(ctx) });
    keep(board);
    await board.showNode("d-wardley", ctx.zoom, { x: 240, y: 90 });
    await board.arm("d-wardley");
    const [note, model] = [(await board.nodeBox("d-note-2"))!, (await board.nodeBox("d-wardley"))!];
    const text = await board.boardText();
    const from = { x: Math.round(note.x + note.width / 2), y: Math.round(note.y) };
    const to = { x: Math.round(model.x + model.width / 2), y: Math.round(model.y + model.height) };
    await board.drag(from, to, { steps: 16 });
    await board.page.waitForTimeout(400);
    const lines = (await board.boardText()).split("\n").filter((line) => line && !text.includes(line));
    const edge = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.kind === "edge");
    if (!edge) return { values: { added: lines.length }, verdict: "off", note: "no arrow was written" };
    const drawn = await pageBox(board, `.react-flow__edge[data-id="${String(edge.id)}"] path`);
    const touches = drawn
      ? { top: r2(drawn.y - (model.y + model.height)), bottom: r2(drawn.y + drawn.height - note.y) }
      : null;
    return {
      values: {
        source: edge.source,
        target: edge.target,
        pathEndsMinusNodeEdgesPx: touches,
        armed: (await board.nodes()).find((one) => one.armed)?.id,
      },
      verdict: ok(
        edge.source === "d-note-2" &&
          edge.target === "d-wardley" &&
          !!touches &&
          Math.abs(touches.top) <= 10 &&
          Math.abs(touches.bottom) <= 10,
      ),
    };
  },
});

add({
  name: "board-other-node",
  group: "board",
  zooms: BOARD_ZOOMS,
  rule: "with a node armed, another node dragged by its body moves by the pointer's travel (+/- 4 px) and the board file has it; a press that crosses the armed editor and is released over it still belongs to the board",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn", "dmn"]);
    const before = (await board.nodeBox(DMN))!;
    const text = await board.boardText();
    const model = await board.fileText(FILES.bpmn);
    const shim = await shimState(board, true);
    const armed = await node.hostBox();
    const from = { x: Math.round(before.x + before.width * 0.3), y: Math.round(before.y + before.height * 0.6) };
    // to the middle of the armed editor: the press began on the board
    const to = { x: Math.round(armed.x + armed.width * 0.55), y: Math.round(armed.y + armed.height * 0.5) };
    await board.drag(from, to, { lead: [3], steps: 20 });
    await board.page.waitForTimeout(400);
    const after = (await board.nodeBox(DMN))!;
    const moved = { x: after.x - before.x, y: after.y - before.y };
    const wanted = { x: to.x - from.x, y: to.y - from.y };
    const stats = (await shimState(board))?.stats.events;
    return {
      values: {
        nodeMovedPx: p2(moved),
        pointerPx: wanted,
        boardFileWritten: (await board.boardText()) !== text,
        modelFileSame: (await board.fileText(FILES.bpmn)) === model,
        armedStill: (await node.state()).armed,
        selectedInEditor: await node.selected(),
        ...(shim && stats ? { eventsSeen: stats.seen, eventsConvertedToVirtual: stats.converted } : {}),
      },
      verdict: ok(
        Math.abs(moved.x - wanted.x) <= 4 &&
          Math.abs(moved.y - wanted.y) <= 4 &&
          (await board.fileText(FILES.bpmn)) === model &&
          (!stats || stats.converted === 0),
      ),
    };
  },
});

add({
  name: "board-pane-over-editor",
  group: "board",
  zooms: BOARD_ZOOMS,
  rule: "a pane drag that moves across the armed editor and is released over it pans the board by the pointer's travel (+/- 4 px) and changes nothing in the editor",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn", "dmn"]);
    const free = await board.freePanePoint();
    if (!free) throw new Unmeasured("no bare pane point");
    const model = await board.fileText(FILES.bpmn);
    await shimState(board, true);
    const armed = await node.hostBox();
    const start = await board.viewport();
    const to = { x: Math.round(armed.x + armed.width * 0.5), y: Math.round(armed.y + armed.height * 0.5) };
    await board.drag(free, to, { lead: [3], steps: 24 });
    await board.page.waitForTimeout(300);
    const end = await board.viewport();
    const pan = { x: end.x - start.x, y: end.y - start.y };
    const wanted = { x: to.x - free.x, y: to.y - free.y };
    const stats = (await shimState(board))?.stats.events;
    return {
      values: {
        panPx: p2(pan),
        pointerPx: wanted,
        modelFileSame: (await board.fileText(FILES.bpmn)) === model,
        selectedInEditor: await node.selected(),
        armedStill: (await node.state()).armed,
        ...(stats ? { eventsSeen: stats.seen, eventsConvertedToVirtual: stats.converted } : {}),
      },
      verdict: ok(
        Math.abs(pan.x - wanted.x) <= 4 &&
          Math.abs(pan.y - wanted.y) <= 4 &&
          (await board.fileText(FILES.bpmn)) === model &&
          (!stats || stats.converted === 0),
      ),
    };
  },
});

add({
  name: "board-drag-leaves",
  group: "board",
  zooms: BOARD_ZOOMS,
  rule: "a shape dragged out of the armed node, over the pane and another node, and back: the board's viewport, nodes and selection do not change, and at the release the shape sits under the pointer as it was grabbed (+/- 1.5 units; the canvas auto-scrolls while the pointer crosses its edge, so the view moves)",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn", "dmn"]);
    // what any other listener of the page reads off the same events (the plain getter on purpose)
    await board.page.evaluate(() => {
      const seen: Array<{ plain: number; own: boolean }> = [];
      Object.assign(window, { __plainMoves: seen });
      window.addEventListener("mousemove", (event) => {
        seen.push({ plain: event.clientX, own: Object.prototype.hasOwnProperty.call(event, "clientX") });
      });
    });
    const id = "Task_check_credit";
    const from = await grabPoint(node, id);
    const viewStart = await viewOf(node);
    const shape = (await shapeOf(board, BPMN, id))!;
    const grab = sub(toDiagram(viewStart, from), { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 });
    const host = await node.hostBox();
    const other = (await board.nodeBox(DMN))!;
    const viewport = await board.viewport();
    const text = await board.boardText();
    const { mouse, keyboard } = board.page;
    await mouse.move(from.x, from.y);
    await mouse.down();
    await mouse.move(from.x + 4, from.y);
    await mouse.move(from.x + 8, from.y);
    await keyboard.down("Control");
    const outside = {
      x: Math.round(Math.min(other.x + 40, host.x + host.width + 160)),
      y: Math.round(host.y + host.height * 0.4),
    };
    await mouse.move(outside.x, outside.y, { steps: 15 });
    await board.page.waitForTimeout(150);
    const whileOut = {
      viewportSame: JSON.stringify(await board.viewport()) === JSON.stringify(viewport),
      otherNodeMovedPx: r2(((await board.nodeBox(DMN))!.x - other.x) as number),
      boardSelection: (await pageBox(board, ".react-flow__selection, .react-flow__nodesselection-rect")) !== null,
    };
    const back = aimAt(await node.map(), { x: from.x + 50 * ctx.zoom, y: from.y + 30 * ctx.zoom });
    await mouse.move(back.x, back.y, { steps: 15 });
    await board.page.waitForTimeout(80);
    await mouse.up();
    await keyboard.up("Control");
    await board.page.waitForTimeout(300);
    const after = (await shapeOf(board, BPMN, id))!;
    const viewEnd = await viewOf(node);
    const under = sub(toDiagram(viewEnd, back), { x: after.x + after.width / 2, y: after.y + after.height / 2 });
    const off = sub(under, grab);
    const moves = await board.page.evaluate(
      () => (window as unknown as { __plainMoves: Array<{ plain: number; own: boolean }> }).__plainMoves,
    );
    return {
      values: {
        shapeOffPointerUnits: p2(off),
        movedUnits: p2(sub(after, shape)),
        canvasScrolledPx: p2({ x: viewEnd.e - viewStart.e, y: viewEnd.f - viewStart.f }),
        whileOutside: whileOut,
        boardFileSame: (await board.boardText()) === text,
        armedStill: (await node.state()).armed,
        mousemovesOtherListenersSaw: moves.length,
        ofThoseWithVirtualCoordinates: moves.filter((move) => move.own).length,
      },
      verdict: ok(
        Math.abs(off.x) <= 1.5 &&
          Math.abs(off.y) <= 1.5 &&
          whileOut.viewportSame &&
          whileOut.otherNodeMovedPx === 0 &&
          !whileOut.boardSelection &&
          (await board.boardText()) === text,
      ),
    };
  },
});

add({
  name: "board-files-panel",
  group: "board",
  zooms: [1],
  rule: "after an edit in the armed editor the Files panel names the file, and a click on it shows the file with its changed line inside the visible list",
  async run(ctx, keep) {
    const { board } = await openNode(ctx, keep, ["bpmn", "dmn"]);
    const ratio = await taskRatio(board, BPMN, "Task_check_credit", ctx.zoom);
    await board.page.waitForTimeout(700);
    const last = await board.page.evaluate(() => document.querySelector(".board-files__last")?.textContent ?? "");
    const entry = await board.page.evaluate(() => {
      const native = (window as NativeWindow).__boardSpikeNative;
      const button = [...document.querySelectorAll<HTMLElement>(".board-files__file")].find((one) =>
        one.textContent?.includes("order-to-cash"),
      );
      if (!button) return null;
      const { x, y, width, height } = native ? native.rect(button) : button.getBoundingClientRect();
      return { x, y, width, height };
    });
    if (!entry) throw new Unmeasured("the Files panel lists no order-to-cash file");
    await board.click(centre(entry));
    await board.page.waitForTimeout(400);
    const shown = await board.page.evaluate(() => {
      const native = (window as NativeWindow).__boardSpikeNative;
      const view = document.querySelector(".board-files__view");
      const list = document.querySelector(".board-files__lines");
      const changed = list?.querySelector('[data-changed="true"]');
      if (!view || !list || !changed)
        return { path: view?.getAttribute("data-path") ?? null, changedLineVisible: false };
      const rect = (element: Element): DOMRect => (native ? native.rect(element) : element.getBoundingClientRect());
      const [box, line] = [rect(list), rect(changed)];
      return {
        path: view.getAttribute("data-path"),
        changedLineVisible: line.top >= box.top - 1 && line.bottom <= box.bottom + 1,
      };
    });
    return {
      values: { editRatio: ratio, lastChange: last.trim().slice(0, 60), shown },
      verdict: ok(/order-to-cash/.test(last) && shown.path === FILES.bpmn && shown.changedLineVisible),
    };
  },
});

add({
  name: "board-previews",
  group: "board",
  zooms: [0.5],
  only: ["shim"],
  rule: "while one shim node is armed, client rectangles inside the unarmed shim nodes are the browser's own, an unarmed node's editor takes no click, and rectangles inside the armed one are virtual",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn", "dmn", "wardley"]);
    /** the plain method ON PURPOSE against the browser's own function, for one shape of the node */
    const compare = (target: NodeHandle): Promise<{ plain: number; native: number }> =>
      target.inDocument((host) => {
        const shape = host.querySelector("[data-element-id] > .djs-visual")!;
        const native = (window as NativeWindow).__boardSpikeNative!;
        return { plain: shape.getBoundingClientRect().width, native: native.rect(shape).width };
      });
    const armed = await compare(node);
    const previews: Record<string, unknown> = {};
    let truthful = true;
    for (const id of ["m-dmn", "m-wardley"]) {
      const preview = await board.node(id);
      const widths = await compare(preview);
      const box = (await preview.elementBox((await preview.elementIds())[0]!))!;
      await board.click(centre(box));
      await board.page.waitForTimeout(150);
      const selected = await preview.selected();
      previews[id] = { plainWidth: r2(widths.plain), nativeWidth: r2(widths.native), selectedByClick: selected };
      truthful &&= widths.plain === widths.native && selected.length === 0;
    }
    return {
      values: {
        armedNode: {
          plainWidth: r2(armed.plain),
          nativeWidth: r2(armed.native),
          ratio: round(armed.native / armed.plain, 3),
        },
        previews,
        spaces: (await shimState(board))?.spaces.map((space) => space.nodeId),
      },
      verdict: ok(truthful && near(armed.native / armed.plain, ctx.zoom, 0.01)),
    };
  },
});

for (const keepPatches of [false, true]) {
  add({
    name: keepPatches ? "board-compare-keep" : "board-compare",
    group: "board",
    zooms: [0.5],
    only: ["shim"],
    shims: [keepPatches ? "all,keep" : "all"],
    rule: `compare board, c-shim armed: client rectangles inside the nodes of the other strategies are the browser's own (in the frame too). Then c-overlay armed: ${keepPatches ? "the patches stay installed and answer with the browser's own values" : "no patch is left, the prototypes carry native functions"}; overlay drags exactly, naive drags at the board zoom, and c-shim armed again is exact`,
    async run(ctx, keep) {
      const board = await ctx.harness.open({ board: "compare", zoom: ctx.zoom, x: 40, y: 90, params: shimParams(ctx) });
      keep(board);
      const id = "Task_create_invoice";
      const compare = async (nodeId: string): Promise<boolean> => {
        const target = await board.node(nodeId);
        return target.inDocument((host) => {
          const native = (window as NativeWindow).__boardSpikeNative!;
          const elements = [host, ...host.querySelectorAll("[data-element-id] > .djs-visual")].slice(0, 12);
          return elements.every((element) => {
            const [plain, own] = [element.getBoundingClientRect(), native.rect(element)];
            return plain.x === own.x && plain.y === own.y && plain.width === own.width && plain.height === own.height;
          });
        });
      };
      /** an edit reached every node: a drag in a node that is still importing another node's edit crosses it */
      const settled = async (): Promise<void> => {
        await board.waitFor(async () => {
          const file = await board.fileText("processes/subprocesses/invoice-handling.bpmn");
          for (const one of await board.nodes()) {
            if (one.type === "model" && (await (await board.node(one.id)).text()) !== file) return false;
          }
          return true;
        }, 5000);
        await board.page.waitForTimeout(500);
      };
      await board.arm("c-shim");
      const others: Record<string, boolean> = {};
      for (const other of ["c-naive", "c-counter", "c-overlay", "c-iframe", "c-plugin"])
        others[other] = await compare(other);
      const shimFirst = await taskRatio(board, "c-shim", id, ctx.zoom);
      await settled();
      await board.arm("c-overlay");
      const afterDisarm = await shimState(board);
      const nativeAgain = await board.page.evaluate(() =>
        [
          Element.prototype.getBoundingClientRect,
          Document.prototype.elementFromPoint,
          SVGGraphicsElement.prototype.getScreenCTM,
        ].every((fn) => Function.prototype.toString.call(fn).includes("[native code]")),
      );
      const formerHost = await compare("c-shim");
      const overlay = await taskRatio(board, "c-overlay", id, ctx.zoom);
      await settled();
      await board.arm("c-naive");
      const naive = await taskRatio(board, "c-naive", id, ctx.zoom);
      await settled();
      await board.arm("c-shim");
      const shimAgain = await taskRatio(board, "c-shim", id, ctx.zoom);
      await settled();
      const counters = await board.counters();
      const pass =
        Object.values(others).every(Boolean) &&
        exact(shimFirst) &&
        formerHost &&
        exact(overlay) &&
        near(naive.x, ctx.zoom, 0.03) &&
        exact(shimAgain) &&
        (keepPatches ? (afterDisarm?.installed.length ?? 0) > 0 : afterDisarm?.installed.length === 0 && nativeAgain);
      return {
        values: {
          othersUntouchedWhileShimArmed: others,
          shimDrag: shimFirst,
          afterDisarm: {
            patchesInstalled: afterDisarm?.installed.length,
            stuck: afterDisarm?.stuck,
            prototypesNative: nativeAgain,
            formerHostRectsTrue: formerHost,
          },
          overlayDrag: overlay,
          naiveDrag: naive,
          shimDragAgain: shimAgain,
          mounts: counters.mounts,
        },
        verdict: ok(pass),
      };
    },
  });
}

// ── 6. arming, keys, sequences ───────────────────────────────────────────────

add({
  name: "keys-wheel",
  group: "mechanics",
  zooms: BOARD_ZOOMS,
  rule: "Delete removes the selected shape and no board node; a wheel over the armed editor scrolls the diagram, Control + wheel zooms it; the board's viewport and file stay as they are",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn", "dmn"]);
    const viewport = await board.viewport();
    const text = await board.boardText();
    await selectAt(board, node, "Task_reject_order");
    const model = await board.fileText(FILES.bpmn);
    await board.press("Delete");
    const deleted = !/id="Task_reject_order"/.test(
      (await board.waitForFileChange(FILES.bpmn, model, 2000)) ?? model ?? "",
    );
    const at = await grabPoint(node, "Task_check_credit");
    const before = await viewOf(node);
    await board.wheel(at, 80);
    await board.page.waitForTimeout(200);
    const scrolled = await viewOf(node);
    await board.wheel(at, -100, { hold: ["Control"] });
    await board.page.waitForTimeout(200);
    const zoomed = await viewOf(node);
    const boardSame =
      JSON.stringify(await board.viewport()) === JSON.stringify(viewport) && (await board.boardText()) === text;
    return {
      values: {
        shapeDeleted: deleted,
        boardNodes: (await board.nodes()).length,
        diagramScrolledPx: r2(scrolled.f - before.f),
        diagramScale: [round(scrolled.a, 4), round(zoomed.a, 4)],
        boardViewportAndFileSame: boardSame,
      },
      verdict: ok(
        deleted && scrolled.f !== before.f && zoomed.a > scrolled.a && boardSame && (await board.nodes()).length === 2,
      ),
    };
  },
});

add({
  name: "arm-cycle",
  group: "mechanics",
  zooms: [0.5, 1.5],
  only: ["shim"],
  rule: "arm, disarm (nothing patched, native functions back), arm another node, switch back without disarming: every drag is exact, one space at a time, every editor mounted once, the log empty",
  async run(ctx, keep) {
    const { board } = await openNode(ctx, keep, ["bpmn", "dmn"]);
    const first = await taskRatio(board, BPMN, "Task_check_credit", ctx.zoom);
    const armedState = await shimState(board);
    await board.arm(null);
    const off = await shimState(board);
    const native = await board.page.evaluate(() => {
      const functions = [
        Element.prototype.getBoundingClientRect,
        Range.prototype.getClientRects,
        Document.prototype.elementsFromPoint,
      ];
      const width = Object.getOwnPropertyDescriptor(window, "innerWidth")?.get;
      return (
        functions.every((fn) => Function.prototype.toString.call(fn).includes("[native code]")) &&
        !!width &&
        Function.prototype.toString.call(width).includes("[native code]") &&
        document.querySelectorAll("[data-board-shim-probe]").length === 0
      );
    });
    await board.arm(DMN);
    const dmnNode = await board.node(DMN);
    const from = await grabPoint(dmnNode, "InputData_segment");
    const before = (await dmnNode.elementBox("InputData_segment"))!;
    const dragged = await dmnNode.drag(from, { x: 40 * ctx.zoom, y: -30 * ctx.zoom }, { hold: ["Control"] });
    const after = (await dmnNode.elementBox("InputData_segment"))!;
    const second = {
      x: round((after.x - before.x) / dragged.delta.x, 3),
      y: round((after.y - before.y) / dragged.delta.y, 3),
    };
    const whileDmn = await shimState(board);
    // straight from one armed node to the other
    await board.arm(BPMN);
    const third = await taskRatio(board, BPMN, "Task_fulfill_order", ctx.zoom);
    const end = await shimState(board);
    const counters = await board.counters();
    return {
      values: {
        firstDrag: first,
        patchesWhileArmed: armedState?.installed.length,
        afterDisarm: { patches: off?.installed.length, spaces: off?.spaces.length, nativeAndNoProbe: native },
        dmnDrag: second,
        spaceWhileDmn: whileDmn?.spaces.map((space) => space.nodeId),
        backToBpmnDrag: third,
        spaceAtEnd: end?.spaces.map((space) => space.nodeId),
        mounts: counters.mounts,
      },
      verdict: ok(
        exact(first) &&
          off?.installed.length === 0 &&
          off.spaces.length === 0 &&
          native &&
          exact(second) &&
          exact(third) &&
          end?.spaces.length === 1 &&
          Object.values(counters.mounts).every((count) => count === 1),
      ),
    };
  },
});

add({
  name: "two-on-one-file",
  group: "mechanics",
  zooms: [0.5, 1],
  rule: "two nodes on one file: a drag in the armed one is exact and shows in the other; then the other armed, the same back",
  async run(ctx, keep) {
    const board = await ctx.harness.open({
      board: "stress",
      strategy: ctx.strategy,
      notation: "bpmn",
      count: 2,
      zoom: ctx.zoom,
      ...ORIGIN,
      params: shimParams(ctx),
    });
    keep(board);
    const id = "Task_check_credit";
    const values: Values = {};
    let pass = true;
    for (const [armed, peer] of [
      ["s-0", "s-1"],
      ["s-1", "s-0"],
    ] as const) {
      await board.showNode(armed, ctx.zoom, ORIGIN);
      await board.arm(armed);
      const ratio = await taskRatio(board, armed, id, ctx.zoom);
      const mine = (await shapeOf(board, armed, id))!;
      const same = await board.waitFor(async () => {
        const theirs = await shapeOf(board, peer, id);
        return !!theirs && theirs.x === mine.x && theirs.y === mine.y;
      }, 3000);
      values[`armed ${armed}`] = { ratio, peerShowsIt: same === true };
      pass &&= exact(ratio) && same === true;
    }
    values.mounts = (await board.counters()).mounts;
    return { values, verdict: ok(pass) };
  },
});

add({
  name: "stale-read",
  group: "mechanics",
  zooms: [0.5, 1.5],
  only: ["shim"],
  shims: ["all", "all@tick", "all@arm"],
  allow: PAD_ALLOW,
  rule: "at the start, after a board pan, after a drag of the armed node by its header and after a board zoom (x1.37, x0.8 from 1.5), the replace popup opens on its pad (+/- 1.5 px) and a drag is exact. Read mode `job` reads the space anew in every job; `tick` only on a viewport change; `arm` once",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const values: Values = {};
    let pass = true;
    const step = async (name: string, task: string): Promise<void> => {
      const state: Values = {};
      try {
        const popup = await popupError(board, node, task);
        state.popupErrorPx = p2(popup.error);
        state.padGapUnits = r2(popup.gapUnits);
        pass &&= Math.abs(popup.error.x) <= 1.5 && Math.abs(popup.error.y) <= 1.5 && near(popup.gapUnits, 13, 1);
      } catch (error) {
        state.popup = error instanceof Error ? error.message : String(error);
        pass = false;
      }
      await board.press("Escape");
      await board.page.waitForTimeout(100);
      try {
        const ratio = await taskRatio(board, BPMN, task, (await board.viewport()).zoom);
        state.dragRatio = ratio;
        pass &&= exact(ratio);
      } catch (error) {
        state.drag = error instanceof Error ? error.message : String(error);
        pass = false;
      }
      values[name] = state;
    };
    // the first use reads the space: `arm` keeps this reading for good
    await step("atStart", "Task_check_credit");
    const start = await board.viewport();
    await board.setViewport({ x: start.x + 137, y: start.y + 59, zoom: start.zoom });
    await step("afterBoardPan(137,59)", "Task_check_credit");
    const header = (await pageBox(board, `${wrapper(BPMN)} .board-node__header`))!;
    const from = { x: Math.round(header.x + header.width * 0.3), y: Math.round(header.y + header.height / 2) };
    await board.drag(from, { x: from.x + 73, y: from.y + 40 }, { lead: [3] });
    await board.page.waitForTimeout(300);
    await step("afterNodeDrag(70,40)", "Task_fulfill_order");
    const now = await board.viewport();
    // in, or out where the node would outgrow the window
    const factor = now.zoom > 1 ? 0.8 : 1.37;
    await board.setViewport({ x: now.x, y: now.y, zoom: now.zoom * factor });
    await step(`afterBoardZoom(x${factor})`, "Task_reject_order");
    values.spaceReads = (await shimState(board))?.spaces[0]?.reads;
    values.armed = (await node.state()).armed;
    return { values, verdict: ok(pass) };
  },
});

add({
  name: "held-drag-zoom",
  group: "mechanics",
  zooms: [0.5, 1],
  rule: "a shape held mid-drag while the board pans and zooms (x1.25) and then dragged on: at the release the shape sits under the pointer as it was grabbed (+/- 1.5 units)",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const id = "Task_check_credit";
    const press = await grabPoint(node, id);
    const view = await viewOf(node);
    const shape = (await shapeOf(board, BPMN, id))!;
    const grab = sub(toDiagram(view, press), { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 });
    const { mouse, keyboard } = board.page;
    await mouse.move(press.x, press.y);
    await mouse.down();
    await mouse.move(press.x + 4, press.y);
    await mouse.move(press.x + 8, press.y);
    await keyboard.down("Control");
    await mouse.move(press.x + 40 * ctx.zoom, press.y + 20 * ctx.zoom, { steps: 8 });
    const viewport = await board.viewport();
    await board.setViewport({ x: viewport.x + 31, y: viewport.y - 17, zoom: viewport.zoom * 1.25 });
    const end = { x: Math.round(press.x + 90 * ctx.zoom) + 0.5, y: Math.round(press.y + 50 * ctx.zoom) + 0.5 };
    await mouse.move(end.x, end.y, { steps: 8 });
    await board.page.waitForTimeout(100);
    await mouse.up();
    await keyboard.up("Control");
    await board.page.waitForTimeout(400);
    const after = (await shapeOf(board, BPMN, id))!;
    const viewEnd = await viewOf(node);
    const under = sub(toDiagram(viewEnd, end), { x: after.x + after.width / 2, y: after.y + after.height / 2 });
    const off = sub(under, grab);
    return {
      values: {
        shapeOffPointerUnits: p2(off),
        movedUnits: p2(sub(after, shape)),
        unitPx: [r2(view.a), r2(viewEnd.a)],
        armed: (await node.state()).armed,
      },
      verdict: ok(Math.abs(off.x) <= 1.5 && Math.abs(off.y) <= 1.5),
    };
  },
});

add({
  name: "popup-open-zoom",
  group: "mechanics",
  zooms: [0.5, 1],
  allow: PAD_ALLOW,
  rule: "an open replace popup survives a board pan and zoom (x1.25): still open, still on its pad (+/- 1.5 px), its entry is hit where it is drawn and changes the file",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const opened = await popupError(board, node, "Task_check_credit");
    const viewport = await board.viewport();
    await board.setViewport({ x: viewport.x + 43, y: viewport.y + 21, zoom: viewport.zoom * 1.25 });
    await board.page.waitForTimeout(200);
    const env = await envOf(node);
    const popup = (await node.query(".djs-popup"))[0];
    if (!popup)
      return {
        values: { openedErrorPx: p2(opened.error), stillOpen: false },
        verdict: "off",
        note: "the board zoom closed the popup",
      };
    const pad = (await node.query(".djs-context-pad.open"))[0]!;
    const error = { x: popup.x - pad.x, y: popup.y - (pad.y + pad.height + 5 * env.net) };
    const service = (await node.query('.djs-popup .entry[data-id="replace-with-service-task"]'))[0];
    const text = await board.fileText(FILES.bpmn);
    let replaced = false;
    if (service && (await node.hit(centre(service))).popup) {
      await board.click(centre(service));
      replaced = /<bpmn:serviceTask id="Task_check_credit"/.test(
        (await board.waitForFileChange(FILES.bpmn, text, 2000)) ?? "",
      );
    }
    return {
      values: { openedErrorPx: p2(opened.error), stillOpen: true, errorAfterZoomPx: p2(error), replaced },
      verdict: ok(Math.abs(error.x) <= 1.5 && Math.abs(error.y) <= 1.5 && replaced),
    };
  },
});

add({
  name: "label-open-zoom",
  group: "mechanics",
  zooms: [0.5, 1],
  rule: "a label being typed survives a board pan and zoom (x1.25): the editor stays open on its shape (+/- 1.5 px), nothing is written until Enter, the whole text is in the file after it, and the diagram follows the board's scale all the while",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const id = "Task_check_credit";
    const unit = (await node.diagramScale())!;
    await board.doubleClick(await grabPoint(node, id));
    await chrome(board, node, ".djs-direct-editing-parent", "label editor");
    const text = await board.fileText(FILES.bpmn);
    await board.press("Control+A");
    await board.type("Half");
    const viewport = await board.viewport();
    await board.setViewport({ x: viewport.x + 43, y: viewport.y + 21, zoom: viewport.zoom * 1.25 });
    await board.page.waitForTimeout(400);
    const editor = (await node.query(".djs-direct-editing-parent"))[0];
    const shape = (await node.elementBox(id))!;
    const unwritten = (await board.fileText(FILES.bpmn)) === text;
    const unitNow = (await node.diagramScale())!;
    if (!editor)
      return {
        values: { editorOpen: false, writtenEarly: !unwritten },
        verdict: "off",
        note: "the board zoom closed the label editor",
      };
    const offset = {
      x: editor.x - shape.x,
      y: editor.y - shape.y,
      width: editor.width - shape.width,
      height: editor.height - shape.height,
    };
    await board.type(" done");
    await board.press("Enter");
    const typed = /name="Half done"/.test((await board.waitForFileChange(FILES.bpmn, text, 2000)) ?? "");
    return {
      values: {
        editorOpen: true,
        nothingWrittenWhileTyping: unwritten,
        editorMinusShapePx: b2(offset),
        diagramScaleOverBoardZoom: round(unitNow / unit / 1.25, 4),
        typedInFile: typed,
      },
      verdict: ok(
        unwritten &&
          typed &&
          Object.values(offset).every((value) => Math.abs(value) <= 1.5) &&
          near(unitNow / unit, 1.25, 0.01),
      ),
    };
  },
});

const DPR_TARGETS: Readonly<Record<ModelNotation, { id: string; hold?: readonly string[]; grab?(box: Box): Point }>> = {
  bpmn: { id: "Task_check_credit", hold: ["Control"] },
  dmn: { id: "InputData_segment", hold: ["Control"] },
  wardley: { id: "cmp_cup", grab: (box) => ({ x: box.x + box.height / 2, y: box.y + box.height / 2 }) },
  "team-topology": { id: "team_fraud" },
  "event-storming": { id: "cmd_place_order", hold: ["Shift"] },
  "context-map": { id: "ctx_ordering" },
  "value-chain": { id: "step-capture" },
};
for (const notation of MODEL_NOTATIONS) {
  add({
    name: `dpr2-${notation}`,
    group: "dpr2",
    zooms: [0.73, 1.5],
    dpr: 2,
    rule: "device pixel ratio 2: shape displacement over pointer displacement is 1 +/- 0.05 on both axes",
    async run(ctx, keep) {
      const { node } = await openNode(ctx, keep, [notation]);
      const target = DPR_TARGETS[notation];
      const box = await node.elementBox(target.id);
      if (!box) throw new Unmeasured(`${target.id} is not drawn`);
      const from = aimAt(await node.map(), target.grab ? target.grab(box) : centre(box));
      const hit = await node.hit(from);
      if (!hit.reachable || hit.element !== target.id) throw new Unmeasured(`${target.id} is covered (${hit.what})`);
      const dragged = await node.drag(from, { x: 60 * ctx.zoom, y: 40 * ctx.zoom }, { hold: target.hold ?? [] });
      const after = (await node.elementBox(target.id))!;
      const ratio = { x: (after.x - box.x) / dragged.delta.x, y: (after.y - box.y) / dragged.delta.y };
      return {
        values: {
          ratio: { x: round(ratio.x, 3), y: round(ratio.y, 3) },
          devicePixelRatio: await node.inDocument(() => window.devicePixelRatio),
        },
        verdict: ok(near(ratio.x, 1, 0.05) && near(ratio.y, 1, 0.05)),
      };
    },
  });
}

// ── what the patches cost, and who calls them ────────────────────────────────

add({
  name: "bpmn-popup-edge",
  group: "bpmn",
  allow: PAD_ALLOW,
  rule: "the node in the bottom right corner of the board's box: the replace popup of a task is visible as a whole (the middles of its four edges, 3 px in, are hit as the popup: neither the window nor the board's box nor a panel beside the board cuts it) and its entries are hit where they are drawn",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn"]);
    const canvas = await board.canvasBox();
    // the node's bottom right corner 12 px inside the canvas's
    await board.showNode(BPMN, ctx.zoom, {
      x: Math.round(canvas.width - 800 * ctx.zoom - 12),
      y: Math.round(canvas.height - 540 * ctx.zoom - 12),
    });
    const env = await envOf(node);
    const id = "Task_fulfill_order";
    await selectAt(board, node, id);
    const wrench = await chrome(board, node, '.djs-context-pad.open .entry[data-action="replace"]', "replace entry");
    if (!(await node.hit(centre(wrench))).pad) {
      return { values: {}, verdict: "off", note: "the replace entry is not hit where it is drawn" };
    }
    await board.click(centre(wrench));
    const popup = await chrome(board, node, ".djs-popup", "replace popup");
    const view = board.page.viewportSize()!;
    const inWindow = (at: Point): boolean => at.x >= 0 && at.y >= 0 && at.x < view.width && at.y < view.height;
    // the middles of its four edges, 3 px in: a corner point lies outside the popup's rounded shape
    const edges = [
      { x: popup.x + popup.width / 2, y: popup.y + 3 },
      { x: popup.x + popup.width / 2, y: popup.y + popup.height - 3 },
      { x: popup.x + 3, y: popup.y + popup.height / 2 },
      { x: popup.x + popup.width - 3, y: popup.y + popup.height / 2 },
    ];
    let visible = 0;
    for (const edge of edges) if (inWindow(edge) && (await node.hit(edge)).popup) visible++;
    const entries = await node.query(".djs-popup .entry");
    let reach = 0;
    for (const entry of entries) if (inWindow(centre(entry)) && (await node.hit(centre(entry))).popup) reach++;
    return {
      values: {
        popup: b2(popup),
        boardBox: b2(canvas),
        window: `${view.width} x ${view.height}`,
        edgesVisible: `${visible}/4`,
        cutPx: {
          byBoardRight: r2(Math.max(0, popup.x + popup.width - (canvas.x + canvas.width))),
          byBoardBottom: r2(Math.max(0, popup.y + popup.height - (canvas.y + canvas.height))),
          byWindowRight: r2(Math.max(0, popup.x + popup.width - view.width)),
          byWindowBottom: r2(Math.max(0, popup.y + popup.height - view.height)),
        },
        popupChromeHeight: r2(popup.height / env.net),
        entriesReachable: `${reach}/${entries.length}`,
      },
      verdict: ok(visible === 4 && reach >= Math.min(entries.length, 8)),
    };
  },
});

/** a short session in one editor, for the counters: a drag, a selection with its pad, a label editor opened and left */
async function session(board: Board, node: NodeHandle, notation: ModelNotation, zoom: number): Promise<void> {
  const target = DPR_TARGETS[notation];
  const box = (await node.elementBox(target.id))!;
  const from = aimAt(await node.map(), target.grab ? target.grab(box) : centre(box));
  await node.drag(from, { x: 40 * zoom, y: 30 * zoom }, { hold: target.hold ?? [] });
  // past diagram-js's click trap after a drag (400 ms)
  await board.page.waitForTimeout(450);
  const again = (await node.elementBox(target.id))!;
  const at = aimAt(await node.map(), target.grab ? target.grab(again) : centre(again));
  await board.click(at);
  await board.page.waitForTimeout(300);
  await board.doubleClick(at);
  await board.page.waitForTimeout(300);
  await board.type("x");
  await board.press("Escape");
  await board.page.waitForTimeout(200);
}

/** a call stack as the names of its functions, without the dev server's paths */
const who = (stack: string): string =>
  stack
    .split(" < ")
    .slice(1, 4)
    .map((frame) => /^at (\S+)/.exec(frame)?.[1] ?? "?")
    .join(" < ");

for (const notation of [...MODEL_NOTATIONS, "dmn-table"] as const) {
  add({
    name: `calls-${notation}`,
    group: "calls",
    zooms: [0.5],
    only: ["shim"],
    allow: [...PAD_ALLOW, ...FEEL],
    rule: "which patched function this engine calls in a short session (a drag, a selection, a label or cell edit), how often, and who decided the caller",
    async run(ctx, keep) {
      let board: Board;
      let node: NodeHandle;
      if (notation === "dmn-table") {
        ({ board, node } = await openTable(ctx, keep));
        await shimState(board, true);
        const cell = await reachable(node, 'td[data-element-id="UnaryTests_key_segment"]', "a FEEL cell");
        await board.click(centre(cell));
        await board.page.waitForTimeout(400);
        await board.type("x");
        await board.click(centre(cell), { button: "right" });
        await board.page.waitForTimeout(300);
        await board.press("Escape");
        // CodeMirror measures in animation frames and observers
        await board.page.waitForTimeout(500);
      } else {
        ({ board, node } = await openNode(ctx, keep, [notation]));
        await shimState(board, true);
        await session(board, node, notation, ctx.zoom);
      }
      const state = await shimState(board);
      if (!state) throw new Unmeasured("no shim on this page");
      const { stats } = state;
      return {
        values: {
          events: stats.events,
          elementRect: stats.rect,
          elementRects: stats.rects,
          range: stats.range,
          point: stats.point,
          screenCTM: stats.ctm,
          windowSize: stats.viewport,
          spaceReads: state.spaces[0]?.reads,
          callers: Object.fromEntries(
            Object.entries(stats.samples).map(([kind, stacks]) => [kind, [...new Set(stacks.map(who))]]),
          ),
        },
        verdict: "ok",
      };
    },
  });
}

add({
  name: "cost-fastpath",
  group: "cost",
  zooms: [1],
  only: ["shim"],
  rule: "nanoseconds per call (the fastest of 7 rounds of 20 000 calls: the machine is shared) before the first arming, while a node is armed and after disarming: for a node outside every host, for an ancestor of the armed host and for a node inside it",
  async run(ctx, keep) {
    const { board } = await openNode(ctx, keep, ["bpmn"], { arm: false });
    const bench = (): Promise<Record<string, number>> =>
      board.page.evaluate(() => {
        const outside = document.querySelector(".board-toolbar button") ?? document.body;
        const ancestor = document.querySelector(".react-flow")!;
        const inside = document.querySelector(".board-engine .djs-container")!;
        const svgOutside = document.querySelector<SVGGraphicsElement>(".react-flow__edges svg, .react-flow svg");
        const svgInside = document.querySelector<SVGGraphicsElement>(".board-engine svg g.viewport")!;
        const time = (run: () => void): number => {
          const rounds: number[] = [];
          for (let round = 0; round < 7; round++) {
            const start = performance.now();
            for (let call = 0; call < 20_000; call++) run();
            rounds.push(((performance.now() - start) * 1e6) / 20_000);
          }
          return Math.round(Math.min(...rounds));
        };
        return {
          "rect outside": time(() => void outside.getBoundingClientRect()),
          "rect ancestor": time(() => void ancestor.getBoundingClientRect()),
          "rect inside": time(() => void inside.getBoundingClientRect()),
          elementFromPoint: time(() => void document.elementFromPoint(5, 5)),
          innerWidth: time(() => void window.innerWidth),
          "screenCTM inside": time(() => void svgInside.getScreenCTM()),
          ...(svgOutside ? { "screenCTM outside": time(() => void svgOutside.getScreenCTM()) } : {}),
        };
      });
    const before = await bench();
    await board.arm(BPMN);
    const armed = await bench();
    await board.arm(null);
    const after = await bench();
    return { values: { nsBeforeFirstArming: before, nsWhileArmed: armed, nsAfterDisarm: after }, verdict: "ok" };
  },
});

add({
  name: "cost-busy",
  group: "cost",
  zooms: [1],
  only: ["shim", "naive"],
  rule: "the demo board (five editors, notes, arrows), one node armed: patched calls and script time during 240 pointer moves of board work (pane pan, node drag, 10 wheel steps) and during a 60 move drag in the armed editor",
  async run(ctx, keep) {
    const board = await ctx.harness.open({ board: "demo", strategy: ctx.strategy, params: shimParams(ctx) });
    keep(board);
    await board.arm("d-order");
    const node = await board.node("d-order");
    const { mouse } = board.page;
    const measure = async (work: () => Promise<void>): Promise<Values> => {
      await shimState(board, true);
      const [m0, t0] = [await board.metrics(), Date.now()];
      await work();
      const [m1, ms] = [await board.metrics(), Date.now() - t0];
      const stats = (await shimState(board))?.stats;
      return {
        wallMs: ms,
        scriptMs: Math.round(((m1.ScriptDuration ?? 0) - (m0.ScriptDuration ?? 0)) * 1000),
        layoutMs: Math.round(((m1.LayoutDuration ?? 0) - (m0.LayoutDuration ?? 0)) * 1000),
        ...(stats
          ? {
              eventsSeen: stats.events.seen,
              eventsConverted: stats.events.converted,
              rectCalls: stats.rect.calls,
              rectInHost: stats.rect.inHost,
              rectAncestor: stats.rect.ancestorTrue + stats.rect.ancestorVirtual,
              pointCalls: stats.point.calls,
              windowSizeCalls: stats.viewport.calls,
              rectCallsPerSecond: Math.round((stats.rect.calls / ms) * 1000),
            }
          : {}),
      };
    };
    const free = await board.freePanePoint();
    if (!free) throw new Unmeasured("no bare pane point");
    const note = (await board.nodeBox("d-note-2"))!;
    const boardWork = await measure(async () => {
      await mouse.move(free.x, free.y);
      await mouse.down();
      for (let step = 1; step <= 60; step++) await mouse.move(free.x - step * 2, free.y - step);
      for (let step = 59; step >= 0; step--) await mouse.move(free.x - step * 2, free.y - step);
      await mouse.up();
      const grab = { x: note.x + note.width / 2, y: note.y + note.height - 10 };
      await mouse.move(grab.x, grab.y);
      await mouse.down();
      for (let step = 1; step <= 60; step++) await mouse.move(grab.x + step, grab.y + step / 2);
      for (let step = 59; step >= 0; step--) await mouse.move(grab.x + step, grab.y + step / 2);
      await mouse.up();
      for (let step = 0; step < 5; step++) await board.wheel(free, -60);
      for (let step = 0; step < 5; step++) await board.wheel(free, 60);
    });
    const id = "Task_check_credit";
    const from = await grabPoint(node, id);
    const zoom = (await board.viewport()).zoom;
    const editorWork = await measure(async () => {
      await mouse.move(from.x, from.y);
      await mouse.down();
      for (let step = 1; step <= 30; step++) await mouse.move(from.x + step * zoom * 2, from.y + step * zoom);
      for (let step = 29; step >= 0; step--) await mouse.move(from.x + step * zoom * 2, from.y + step * zoom);
      await mouse.up();
    });
    return {
      values: { boardZoom: round(zoom, 3), boardWork240Moves: boardWork, editorDrag60Moves: editorWork },
      verdict: "ok",
    };
  },
});

// ── where the caller rule holds and where it fails ───────────────────────────

add({
  name: "caller-rule",
  group: "rules",
  zooms: [0.5, 1.5],
  only: ["shim"],
  shims: ["all", "all,guess", "events,rects,points,ctm,viewport,snap,css,clip,docrect"],
  rule: "who gets virtual and who gets true values from the functions that carry no node: a point query and the window's width and the document element's rectangle, asked by editor-like code (in its event, in a microtask of it, in a timer with and without a read of its own geometry first, in an animation frame) and by board-like code (in a board event, in a timer). Expected: the editor's always virtual, the board's always true. `docrect` (in `all`) gives the document element's rectangle to an unknown caller as the editor's, `guess` the window's size too",
  async run(ctx, keep) {
    const { board, node } = await openNode(ctx, keep, ["bpmn", "dmn"]);
    await board.page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('.board-engine[data-armed="true"]')!;
      const tally: Record<string, { right: number; wrong: number }> = {};
      const count = (name: string, right: boolean): void => {
        const entry = (tally[name] ??= { right: 0, wrong: 0 });
        if (right) entry.right++;
        else entry.wrong++;
      };
      Object.assign(window, { __callerTally: tally });
      const trueWidth = document.documentElement.clientWidth;
      // editor-like: a listener inside the armed host, as an engine would have one
      host.addEventListener("mousemove", (event) => {
        const { clientX: x, clientY: y, target } = event;
        const hit = (): boolean => document.elementFromPoint(x, y) === target;
        const virtualWidth = (): boolean => Math.abs(window.innerWidth - trueWidth) > 1;
        count("editor: point in its event", hit());
        count("editor: window width in its event", virtualWidth());
        queueMicrotask(() => count("editor: point in a microtask of its event", hit()));
        setTimeout(() => count("editor: point in a timer, nothing read before", hit()), 0);
        setTimeout(() => {
          host.getBoundingClientRect();
          count("editor: point in a timer, after reading its own rectangle", hit());
        }, 0);
        setTimeout(() => count("editor: window width in a timer, nothing read before", virtualWidth()), 0);
        setTimeout(
          () =>
            count(
              "editor: document element's rectangle in a timer, nothing read before",
              Math.abs(document.documentElement.getBoundingClientRect().width - trueWidth) > 1,
            ),
          0,
        );
        requestAnimationFrame(() => count("editor: window width in an animation frame", virtualWidth()));
      });
      // board-like: a listener on the pane, for moves that are not the editor's
      const pane = document.querySelector<HTMLElement>(".react-flow__pane")!;
      pane.addEventListener("mousemove", (event) => {
        if (host.contains(event.target as Node)) return;
        const { clientX: x, clientY: y, target } = event;
        count("board: point in a board event", document.elementFromPoint(x, y) === target);
        count("board: window width in a board event", Math.abs(window.innerWidth - trueWidth) <= 1);
        setTimeout(() => count("board: window width in a timer", Math.abs(window.innerWidth - trueWidth) <= 1), 0);
        setTimeout(() => count("board: point in a timer", document.elementFromPoint(x, y) === target), 0);
        setTimeout(
          () =>
            count(
              "board: document element's rectangle in a timer",
              Math.abs(document.documentElement.getBoundingClientRect().width - trueWidth) <= 1,
            ),
          0,
        );
      });
    });
    const host = await node.hostBox();
    // across the bare canvas at the editor's top (a shape or a flow would answer a hover with chrome of
    // its own under the pointer), then across the bare pane under the node
    for (let step = 0; step <= 12; step++) {
      await board.move({ x: host.x + host.width * (0.3 + 0.04 * step), y: host.y + host.height * 0.03 });
    }
    const box = (await board.nodeBox(BPMN))!;
    for (let step = 0; step <= 12; step++) {
      await board.move({ x: box.x + 40 + step * 12, y: box.y + box.height + 30 });
    }
    await board.page.waitForTimeout(400);
    const tally = await board.page.evaluate(
      () => (window as unknown as { __callerTally: Record<string, { right: number; wrong: number }> }).__callerTally,
    );
    const wrong = Object.entries(tally)
      .filter(([, entry]) => entry.wrong > 0)
      .map(([name]) => name);
    return {
      values: {
        asExpected: Object.fromEntries(
          Object.entries(tally).map(([name, entry]) => [name, `${entry.right}/${entry.right + entry.wrong}`]),
        ),
      },
      verdict: ok(wrong.length === 0),
      ...(wrong.length > 0 ? { note: `not as expected: ${wrong.join("; ")}` } : {}),
    };
  },
});

// ── part by part ─────────────────────────────────────────────────────────────

/** what each part and modifier is needed for: the same cases with part lists that leave something out */
const PART_LISTS = [
  "none",
  "events",
  "rects",
  "events,rects",
  "events,rects,snap,whole,css",
  // + points and ctm
  "events,rects,points,ctm,snap,whole,css",
  // all without snap, without whole, without css, without clip, without docrect
  "events,rects,points,ctm,viewport,whole,css,clip,docrect",
  "events,rects,points,ctm,viewport,snap,css,clip,docrect",
  "events,rects,points,ctm,viewport,snap,whole,clip,docrect",
  "events,rects,points,ctm,viewport,snap,whole,css,docrect",
  "events,rects,points,ctm,viewport,snap,whole,css,clip",
  "all",
  "all,guess",
];
/** the zooms a case is repeated at per part list: where the part in question shows */
const BY_PART: Readonly<Record<string, readonly number[]>> = {
  "bpmn-move": [0.5, 1.5],
  "bpmn-create": [0.5],
  "bpmn-connect": [1.5],
  "bpmn-lasso": [0.5],
  "bpmn-bendpoint": [0.5],
  "bpmn-wheel": [1.5],
  "bpmn-pad-popup": [0.5],
  // the popup has to flip: at the board's edge, and where the virtual window is smaller than the true one
  "bpmn-popup-edge": [0.5, 2],
  "bpmn-tooltip": [1.5],
  // 0.73: a scale that is no binary fraction (float noise in a division by it)
  "bpmn-label-nochange": [0.73],
  "bpmn-autoscroll": [0.5],
  "table-colresize": [0.73],
  "table-menus": [0.5],
  "table-feel-caret": [0.5, 1.5],
  "context-map-pad-popup": [0.5],
  "context-map-prompt": [1.5],
  "wardley-label": [0.5],
};
for (const [name, at] of Object.entries(BY_PART)) {
  const base = cases.find((one) => one.name === name);
  if (base) add({ ...base, name: `parts:${name}`, group: "parts", only: ["shim"], shims: PART_LISTS, zooms: at });
}

// ── running ──────────────────────────────────────────────────────────────────

const selected = (one: Case): boolean =>
  caseFilter.length === 0 || caseFilter.some((filter) => one.name === filter || one.name.startsWith(filter));

interface Job {
  one: Case;
  ctx: Omit<Ctx, "harness">;
}

function plan(): Job[] {
  const list: Job[] = [];
  for (const one of cases.filter(selected)) {
    for (const strategy of strategies) {
      if (one.only && !one.only.includes(strategy)) continue;
      const lists = strategy === "shim" ? (one.shims ?? shimLists) : ["-"];
      for (const shim of lists) {
        for (const zoom of one.zooms ? one.zooms.filter((value) => zooms.includes(value)) : zooms) {
          list.push({ one, ctx: { strategy, shim, zoom, dpr: one.dpr ?? 1 } });
        }
      }
    }
  }
  return list;
}

/** runs a case once on a page of its own and closes the page */
async function once(
  harness: Harness,
  one: Case,
  ctx: Omit<Ctx, "harness">,
): Promise<{ result: Result; problems: string[]; failed: boolean }> {
  let board: Board | undefined;
  let result: Result;
  let failed = false;
  try {
    result = await one.run({ ...ctx, harness }, (opened) => void (board = opened));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failed = !(error instanceof Unmeasured);
    result = { values: {}, verdict: "n/m", note: failed ? `THREW: ${message.split("\n")[0]}` : message };
  }
  let problems: string[] = [];
  if (board) {
    try {
      problems = await board.problems({ allow: one.allow ?? [] });
      await board.close();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { result, problems, failed: failed || problems.length > 0 };
}

/** per case: its layout in the unscaled editor (overlay at board zoom 1), measured once */
const references = new Map<string, Promise<Result>>();
const referenceOf = (harness: Harness, one: Case): Promise<Result> => {
  let reference = references.get(one.name);
  if (!reference) {
    reference = once(harness, one, { strategy: "overlay", shim: "-", zoom: 1, dpr: 1 }).then((run) => run.result);
    references.set(one.name, reference);
  }
  return reference;
};

async function measure(harness: Harness, { one, ctx }: Job): Promise<{ row: Row; failed: boolean }> {
  const started = Date.now();
  const { result, problems, failed } = await once(harness, one, ctx);
  if (result.layout && result.verdict !== "n/m") {
    if (result.net !== undefined && near(result.net, ctx.zoom, 0.01)) {
      const reference = await referenceOf(harness, one);
      if (!reference.layout) {
        result.verdict = "n/m";
        result.note = `no reference: ${reference.note ?? "the unscaled editor gave no layout"}`;
      } else {
        const { max, at, missing } = deviation(result.layout, reference.layout);
        result.values.layoutVsUnscaled = { maxLayoutPx: r2(max), at, ...(missing.length > 0 ? { missing } : {}) };
        if (max > (one.tolerance ?? 2) || missing.length > 0) result.verdict = "off";
      }
    } else result.values.layoutVsUnscaled = "not compared: this editor's chrome keeps its screen size";
  }
  const row: Row = {
    case: one.name,
    strategy: ctx.strategy,
    shim: ctx.shim,
    zoom: ctx.zoom,
    verdict: result.verdict,
    rule: one.rule,
    values: result.values,
    ...(result.note ? { note: result.note } : {}),
    problems,
    ms: Date.now() - started,
  };
  return { row, failed };
}

const short = (value: unknown): string => {
  const text = JSON.stringify(value);
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
};

function markdown(rows: readonly Row[]): string {
  const lines = ["| Case | Strategy | Parts | Zoom | Verdict | Measured |", "| --- | --- | --- | --- | --- | --- |"];
  for (const row of rows) {
    const what = `${short(row.values)}${row.note ? ` (${row.note})` : ""}`.replaceAll("|", "\\|");
    lines.push(`| ${row.case} | ${row.strategy} | ${row.shim} | ${row.zoom} | ${row.verdict} | ${what} |`);
  }
  return `${lines.join("\n")}\n`;
}

await run(async (harness) => {
  if (caseFilter.includes("list")) {
    for (const one of cases) console.log(`${one.group.padEnd(8)} ${one.name.padEnd(28)} ${one.rule}`);
    return 0;
  }
  const queue = plan();
  console.log(`${queue.length} rows, ${jobs} at a time: ${strategies.join(", ")} at zoom ${zooms.join(", ")}`);
  const rows: Row[] = [];
  let failures = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const job = queue[index];
      if (!job) return;
      const { row, failed } = await measure(harness, job);
      rows[index] = row;
      if (failed) failures++;
      console.log(
        `${row.verdict.padEnd(3)} ${row.case.padEnd(26)} ${row.strategy.padEnd(8)} ${row.shim.padEnd(8)} ${String(row.zoom).padEnd(5)}` +
          `${short(row.values)}${row.note ? ` (${row.note})` : ""}${row.problems.length > 0 ? ` PROBLEMS ${short(row.problems)}` : ""}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
  const done = rows.filter(Boolean);
  const count = (verdict: Verdict, strategy: Strategy): number =>
    done.filter((row) => row.verdict === verdict && row.strategy === strategy).length;
  for (const strategy of strategies) {
    console.log(
      `${strategy}: ${count("ok", strategy)} ok, ${count("off", strategy)} off, ${count("n/m", strategy)} not measured`,
    );
  }
  console.log(writeResult("shim", { strategies, zooms, shimLists, rows: done }));
  const table = outPath("shim.md");
  writeFileSync(table, markdown(done));
  console.log(table);
  if (failures > 0) console.log(`${failures} rows with a harness problem`);
  return failures;
});
