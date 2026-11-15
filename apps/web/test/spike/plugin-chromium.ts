/**
 * The measurement of the `plugin` strategy (engines/outer-scale): how far ONE diagram-js module
 * that knows the outer scale gets, interaction by interaction, always next to `naive` (the same
 * placement without the module) and `overlay` (exact without any patch) on the same board. A check
 * run by hand on lib.ts, not by `pnpm test` or CI.
 *
 *   node apps/web/test/spike/plugin-chromium.ts
 *   NOTATIONS=bpmn CASES=move,pad ZOOMS=0.5,2 node apps/web/test/spike/plugin-chromium.ts
 *   STRATEGIES=plugin NOTATIONS=bpmn PLUGIN="none;drag;pad;all" node apps/web/test/spike/plugin-chromium.ts
 *
 * One fresh page per row (strategy x layer list x notation x board zoom x case): board=matrix with
 * the one notation, the viewport from the URL, the node armed through the hook. Every number of a
 * row is in SCREEN px unless its name says otherwise (`...Units` are diagram units). What a row
 * says about a strategy is the result; the exit code is 1 only when the harness failed (a case
 * threw, a console error, a page error, a log line).
 *
 * Environment (comma lists): STRATEGIES (default naive,overlay,plugin), NOTATIONS (default all
 * seven), ZOOMS (default 0.5,0.73,1,1.5,2), CASES (default: every case of the notation and the two
 * suites `two` and `compare`, which open boards of their own for the plugin strategy), DPR
 * (default 1), CONCURRENCY (pages at a time, default 3; every page is a browser context of its
 * own), and PLUGIN: layer lists for the plugin strategy separated by `;` (each a value of
 * `&plugin=`; default `all`), every other strategy runs once. NAME names the result file
 * (<OUT_DIR>/<NAME>.json, default plugin). Plus lib.ts's PORT, BASE, CACHE_DIR, OUT_DIR.
 */
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
  type Point,
  round,
  run,
  STRATEGIES,
  type Strategy,
  writeResult,
} from "./lib.ts";

const list = <T extends string>(name: string, all: readonly T[], fallback: readonly T[] = all): T[] => {
  const wanted = (process.env[name] ?? "").split(",").filter(Boolean);
  return wanted.length === 0 ? [...fallback] : all.filter((one) => wanted.includes(one));
};
const strategies = list("STRATEGIES", STRATEGIES, ["naive", "overlay", "plugin"]);
const notations = list("NOTATIONS", MODEL_NOTATIONS);
const zooms = (process.env.ZOOMS ?? "0.5,0.73,1,1.5,2").split(",").map(Number).filter(Boolean);
const wantedCases = (process.env.CASES ?? "").split(",").filter(Boolean);
const layerLists = (process.env.PLUGIN ?? "all").split(";").filter(Boolean);
const dpr = Number(process.env.DPR ?? 1);
const concurrency = Math.max(1, Number(process.env.CONCURRENCY ?? 3));

/** where the node's top-left corner sits in the canvas: clear of the toolbar */
const ORIGIN = { x: 60, y: 80 };

type Row = Record<string, unknown>;
type NativeWindow = Window & { __boardSpikeNative?: NativeGeometry };
/** what a case needs of diagram-js, structurally; `get` never takes a second argument (lib.ts) */
interface Diagram {
  get(name: string): any;
}
interface Ctx {
  board: Board;
  node: NodeHandle;
  strategy: Strategy;
  notation: ModelNotation;
  zoom: number;
  file: string;
}

const px = (value: number | null | undefined): number | null =>
  value === null || value === undefined ? null : round(value, 2);
const delta = (a: Point, b: Point): Point => ({ x: round(a.x - b.x, 2), y: round(a.y - b.y, 2) });
const corner = (box: Box): Point => ({ x: box.x + box.width, y: box.y + box.height });

/**
 * Runs `read(diagram, arg)` in the page with the node's diagram-js instance (in-page strategies
 * only). The function crosses as text and sees nothing of this script.
 */
async function inDiagram<A, R>(node: NodeHandle, read: (diagram: Diagram, arg: A) => R, arg?: A): Promise<R> {
  return node.inDocument(
    (_host, given) => {
      const hooks = (window as unknown as { __boardSpike: { engine(id: string): { engine: { diagram(): unknown } } } })
        .__boardSpike;
      const diagram = hooks.engine(given.id).engine.diagram();
      if (!diagram) throw new Error(`${given.id} shows no diagram-js canvas`);
      return (0, eval)(`(${given.source})`)(diagram, given.arg) as never;
    },
    { id: node.id, source: read.toString(), arg },
  ) as Promise<R>;
}

/** a diagram point on screen, through the browser's own matrix of `g.viewport` (no engine math) */
async function screenOf(node: NodeHandle, point: Point): Promise<Point> {
  const local = await node.inDocument((host, at) => {
    const viewport = host.querySelector<SVGGElement>("svg g.viewport")!;
    const native = (window as NativeWindow).__boardSpikeNative;
    const matrix = (native ? native.screenCTM(viewport) : viewport.getScreenCTM())!;
    return { x: matrix.a * at.x + matrix.c * at.y + matrix.e, y: matrix.b * at.x + matrix.d * at.y + matrix.f };
  }, point);
  const map = await node.map();
  return { x: map.x + local.x * map.sx, y: map.y + local.y * map.sy };
}

interface Shape {
  x: number;
  y: number;
  width: number;
  height: number;
  waypoints: Point[] | null;
}

/** what the engine's model says about an element */
const shapeOf = (node: NodeHandle, id: string): Promise<Shape | null> =>
  inDiagram(
    node,
    (diagram, elementId) => {
      const element = diagram.get("elementRegistry").get(elementId) as (Shape & { waypoints?: Point[] }) | undefined;
      if (!element) return null;
      const { x, y, width, height } = element;
      const waypoints = element.waypoints?.map((point) => ({ x: point.x, y: point.y }));
      return { x, y, width, height, waypoints: waypoints ?? null };
    },
    id,
  );

/** how many commands the engine's stack holds: one more is one write to the file */
const commands = (node: NodeHandle): Promise<number> =>
  inDiagram(node, (diagram) => (diagram.get("commandStack")._stackIdx as number) + 1);

/** a text annotation made through the engine's own modeling service: no pointer math is in its creation */
async function createAnnotation(ctx: Ctx): Promise<string> {
  return inDiagram(
    ctx.node,
    (diagram, bpmn) => {
      const root = diagram.get("canvas").getRootElement();
      const shape = diagram
        .get("elementFactory")
        .createShape({ type: bpmn ? "bpmn:TextAnnotation" : "dmn:TextAnnotation" });
      const created = diagram.get("modeling").createShape(shape, bpmn ? { x: 1050, y: 250 } : { x: 640, y: 340 }, root);
      diagram.get("modeling").updateLabel(created, "A note");
      diagram.get("selection").select(null);
      return created.id as string;
    },
    ctx.notation === "bpmn",
  );
}

/** the first box of a selector once it rests, null when it never shows */
const boxOf = (ctx: Ctx, selector: string, timeout = 2000): Promise<Box | null> =>
  ctx.board.waitForBox(async () => (await ctx.node.query(selector))[0], timeout);

/** the file's text once nothing wrote it for `quiet` ms (an editor writes about 350 ms after a gesture) */
async function settledText(ctx: Ctx, quiet = 700): Promise<string> {
  let last = (await ctx.board.fileText(ctx.file)) ?? "";
  for (let rounds = 0; rounds < 8; rounds++) {
    await ctx.board.page.waitForTimeout(quiet);
    const now = (await ctx.board.fileText(ctx.file)) ?? "";
    if (now === last) return now;
    last = now;
  }
  return last;
}

/** a press at `at` is this node's editor and, when asked, this element */
async function pressable(ctx: Ctx, at: Point, element?: string): Promise<string | null> {
  const hit = await ctx.node.hit(at);
  if (!hit.reachable) return `not reachable: ${hit.what}`;
  if (element !== undefined && hit.element !== element) return `hit ${hit.element ?? hit.what}, not ${element}`;
  return null;
}

/** a point of the canvas that is clear of every shape and of the editor's chrome, the roomiest first */
async function freeSpot(ctx: Ctx, clear: number): Promise<Point | null> {
  const candidates = await ctx.node.inDocument((host, minimum) => {
    const native = (window as NativeWindow).__boardSpikeNative;
    const rect = (element: Element): DOMRect => (native ? native.rect(element) : element.getBoundingClientRect());
    const frame = rect(host);
    const obstacles = [...host.querySelectorAll("[data-element-id] > .djs-visual, .djs-palette, .djs-context-pad.open")]
      .map(rect)
      // a pool, a lane, a plot or a board frame is ground to drop on, not an obstacle
      .filter((box) => box.width * box.height > 0 && box.width * box.height < 0.12 * frame.width * frame.height);
    const found: Array<{ x: number; y: number; room: number }> = [];
    for (let row = 2; row <= 12; row++) {
      for (let column = 2; column <= 18; column++) {
        const [x, y] = [frame.left + (frame.width * column) / 20, frame.top + (frame.height * row) / 14];
        let room = Math.min(x - frame.left, frame.right - x, y - frame.top, frame.bottom - y);
        for (const box of obstacles) {
          const [dx, dy] = [Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom)];
          room = Math.min(room, Math.hypot(dx, dy));
        }
        if (room >= minimum) found.push({ x, y, room });
      }
    }
    return found.sort((a, b) => b.room - a.room).slice(0, 12);
  }, clear);
  const map = await ctx.node.map();
  for (const candidate of candidates) {
    const at = aimAt(map, { x: map.x + candidate.x * map.sx, y: map.y + candidate.y * map.sy });
    const hit = await ctx.node.hit(at);
    // SVG ground (the canvas, a plot, a lane): never the editor's HTML chrome
    if (
      hit.reachable &&
      !hit.palette &&
      !hit.pad &&
      !hit.popup &&
      /^(svg|rect|path|g|polygon|circle)\./.test(hit.what)
    ) {
      return at;
    }
  }
  return null;
}

/** selects an element with a click at `at` (default: where it is grabbed); false when it does not get selected */
async function selectAt(ctx: Ctx, id: string, at?: Point): Promise<boolean> {
  if ((await ctx.node.selected()).includes(id)) return true;
  const box = await ctx.node.elementBox(id);
  if (!box) return false;
  const point = aimAt(await ctx.node.map(), at ?? grabOf(ctx.notation, id, box));
  if (await pressable(ctx, point, id)) return false;
  await ctx.board.click(point);
  return (await ctx.board.waitFor(async () => (await ctx.node.selected()).includes(id), 1000)) === true;
}

/** every label editor of the seven engines: diagram-js-direct-editing, and the renderers' own fields */
const EDITOR =
  ".djs-direct-editing-parent, textarea.wardley-label-input, textarea.tt-label-editor, .event-storming-label-input";
/** the key that commits a label editor: Event Storming's field takes a plain Enter as a line break */
const commitKey = (notation: ModelNotation): string => (notation === "event-storming" ? "Control+Enter" : "Enter");

// ── what moves freely, per notation (integrate.md, forNextStage 6) ───────────

interface Movable {
  id: string;
  /** where to grab it (default: the middle of its graphics) */
  grab?(box: Box): Point;
  /** keys held after the press: Control switches the grid snapping of bpmn-js and the DRD off */
  hold?: readonly string[];
}
const MOVABLE: Record<ModelNotation, Movable> = {
  bpmn: { id: "Task_check_credit", hold: ["Control"] },
  dmn: { id: "InputData_segment", hold: ["Control"] },
  // the name beside the circle has a drag of its own
  wardley: { id: "cmp_cup", grab: (box) => ({ x: box.x + box.height / 2, y: box.y + box.height / 2 }) },
  "team-topology": { id: "team_fraud" },
  "event-storming": { id: "cmd_place_order" },
  "context-map": { id: "ctx_ordering" },
  "value-chain": { id: "step-capture" },
};

/** where an element of a notation is grabbed: Wardley's components at their circle, everything else in the middle */
const grabOf = (notation: ModelNotation, id: string, box: Box): Point =>
  notation === "wardley" && id.startsWith("cmp_")
    ? { x: box.x + box.height / 2, y: box.y + box.height / 2 }
    : centre(box);

// ── cases ────────────────────────────────────────────────────────────────────

type Case = (ctx: Ctx) => Promise<Row>;

/** a shape dragged by (60, 40) flow units: its displacement on screen over the pointer's, and the preview mid-drag */
const move: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  const target = MOVABLE[ctx.notation];
  const before = await node.elementBox(target.id);
  if (!before) return { skipped: `${target.id} is not drawn` };
  const grab = target.grab?.(before) ?? centre(before);
  const blocked = await pressable(ctx, grab, target.id);
  if (blocked) return { skipped: blocked };
  const text = await board.fileText(ctx.file);
  const dragged = await node.drag(
    grab,
    { x: 60 * zoom, y: 40 * zoom },
    { ...(target.hold ? { hold: target.hold } : {}), keepDown: true },
  );
  // diagram-js's own drag preview (move/MovePreview.js), where the engine draws one
  const preview = (await node.query(".djs-drag-group"))[0];
  await board.release(target.hold ?? []);
  const after = (await node.elementBox(target.id))!;
  const scale = await node.diagramScale();
  return {
    element: target.id,
    ratioX: round((after.x - before.x) / dragged.delta.x, 3),
    ratioY: round((after.y - before.y) / dragged.delta.y, 3),
    // the shape under the pointer after the drop: what is missing to the pointer's travel
    offX: px(after.x - before.x - dragged.delta.x),
    offY: px(after.y - before.y - dragged.delta.y),
    previewOff: preview
      ? delta(centre(preview), { x: centre(before).x + dragged.delta.x, y: centre(before).y + dragged.delta.y })
      : null,
    unitPx: px(scale),
    fileChanged: (await board.waitForFileChange(ctx.file, text)) !== null,
  };
};

/**
 * What to drag out of the palette, per engine. `drop`: a free spot in diagram units where the sample
 * has one that is known; else the roomiest free point of the canvas is searched. `hold`: the key
 * that switches the engine's snapping off (integrate.md 6, miragon-b: Shift in Event Storming).
 */
const CREATE: Record<ModelNotation, { entry: string; drop?: Point; hold?: readonly string[] }> = {
  // a free spot of the lane Order Management, right of Fulfill order
  bpmn: { entry: "create.start-event", drop: { x: 1010, y: 265 }, hold: ["Control"] },
  dmn: { entry: "create.input-data", drop: { x: 620, y: 120 }, hold: ["Control"] },
  wardley: { entry: "create.component" },
  "team-topology": { entry: "team.enabling" },
  "event-storming": { entry: "create.command", hold: ["Shift"] },
  "context-map": { entry: "context.core" },
  "value-chain": { entry: "create.step", hold: ["Control"] },
};

/** a shape dragged out of the palette: the drop point against the new shape's middle */
const create: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  const spec = CREATE[ctx.notation];
  const entry = (await node.query(`.djs-palette .entry[data-action="${spec.entry}"]`))[0];
  if (!entry) return { skipped: `no palette entry ${spec.entry}` };
  const blocked = await pressable(ctx, centre(entry));
  if (blocked) return { skipped: `palette entry ${blocked}` };
  const drop = spec.drop ? await screenOf(node, spec.drop) : await freeSpot(ctx, 70 * zoom);
  if (!drop) return { skipped: "no free spot on the canvas" };
  const under = await node.hit(drop);
  const ids = new Set(await node.elementIds());
  const text = await board.fileText(ctx.file);
  // Control: no grid and no element snapping in bpmn-js and the DRD. Held at the drop it also opens
  // the replace menu on the new shape (their ContextPadProvider), which is closed again
  const dragged = await node.paletteDrag(entry, drop, spec.hold ? { hold: spec.hold } : {});
  await board.page.waitForTimeout(200);
  // a new shape opens its label editor or a menu: leave it
  await board.press("Escape");
  await board.press("Escape");
  const created = (await node.elementIds()).filter((id) => !ids.has(id) && !id.endsWith("_label"));
  const shape = created[0] ? await node.elementBox(created[0]) : null;
  const scale = (await node.diagramScale()) ?? 1;
  // Wardley draws a component as a circle with its name beside it: the circle is what was dropped
  const middle = shape && (ctx.notation === "wardley" ? grabOf("wardley", "cmp_", shape) : centre(shape));
  const off = middle ? delta(middle, dragged.to) : null;
  return {
    dropOn: under.element ?? under.what,
    created: created.length,
    offX: off?.x ?? null,
    offY: off?.y ?? null,
    offUnits: off ? round(Math.hypot(off.x, off.y) / scale, 1) : null,
    fileChanged: (await board.waitForFileChange(ctx.file, text, 1500)) !== null,
  };
};

/** what to connect by dragging from the pad's connect entry, per engine (diagram units) */
const CONNECT: Partial<
  Record<ModelNotation, { source: string; target: string | null; free: Point; connected: RegExp }>
> = {
  bpmn: {
    source: "Task_reject_order",
    target: "CallActivity_invoice_handling",
    free: { x: 800, y: 505 },
    connected: /sourceRef="Task_reject_order" targetRef="CallActivity_invoice_handling"/,
  },
  // every input of the sample is connected already: the target is a text annotation made for the case
  dmn: { source: "InputData_overdue", target: null, free: { x: 540, y: 400 }, connected: /<association / },
};

/** connect by dragging from the pad: the preview's end against the pointer, then the connection in the file */
const connect: Case = async (ctx) => {
  const { node, board } = ctx;
  const spec = CONNECT[ctx.notation];
  if (!spec) return { skipped: "no connect case for this notation" };
  const target = spec.target ?? (await createAnnotation(ctx));
  if (spec.target === null) await settledText(ctx, 400);
  if (!(await node.select(spec.source))) return { skipped: `${spec.source} could not be selected` };
  const entry = await boxOf(ctx, '.djs-context-pad.open .entry[data-action="connect"]');
  if (!entry) return { skipped: "no connect entry in the pad" };
  const hit = await node.hit(centre(entry));
  if (!hit.reachable || !hit.pad) return { padEntry: false, why: `connect entry not reachable: ${hit.what}` };
  // first to a free spot: there the preview ends at the pointer
  const free = await screenOf(node, spec.free);
  const map = await node.map();
  const dragged = await board.drag(aimAt(map, centre(entry)), aimAt(map, free), { keepDown: true, steps: 16 });
  // connection-preview/ConnectionPreview.js draws the line as the one `.djs-dragger` of a connect
  const preview = (await node.query(".djs-dragger"))[0];
  const text = await board.fileText(ctx.file);
  const end = centre((await node.elementBox(target))!);
  await board.move(aimAt(map, end), 12);
  await board.page.waitForTimeout(60);
  await board.release();
  const changed = await board.waitForFileChange(ctx.file, text);
  await board.press("Escape");
  return {
    padEntry: true,
    // the preview runs from the source's border to the pointer, which lies right of and below the source
    previewEndOff: preview ? delta(corner(preview), dragged.to) : null,
    connected: changed !== null && spec.connected.test(changed),
  };
};

/**
 * What is resized by which handle, per engine (all through diagram-js's Resize on the drag events).
 * BPMN: the expanded sub-process by its north-east handle; the south-east one and every handle of
 * the pool and its lanes lie within 20 px of the canvas edge, where diagram-js scrolls.
 */
const RESIZE: Partial<
  Record<ModelNotation, { id: string; select?: Point; handle: string; travel: Point; hold?: readonly string[] }>
> = {
  // selected at an empty spot inside it: its middle is a task
  bpmn: {
    id: "EventSubProcess_customer_support",
    select: { x: 632, y: 612 },
    handle: "ne",
    travel: { x: 36, y: -8 },
    hold: ["Control"],
  },
  "team-topology": { id: "team_fraud", handle: "sw", travel: { x: -30, y: 20 } },
  "value-chain": { id: "step-capture", handle: "se", travel: { x: 30, y: 20 }, hold: ["Control"] },
};

/** a shape resized by one of its handles: the growth on screen over the pointer's travel */
const resize: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  const spec = RESIZE[ctx.notation];
  if (!spec) return { skipped: "no resize case for this notation" };
  const at = spec.select ? await screenOf(node, spec.select) : undefined;
  if (!(await selectAt(ctx, spec.id, at))) return { skipped: `${spec.id} could not be selected` };
  const handle = await boxOf(ctx, `.djs-resizer-${spec.handle}`);
  if (!handle) return { skipped: `no ${spec.handle} resizer` };
  const grab = centre(handle);
  const reach = await node.hit(grab);
  if (!reach.reachable || !reach.what.includes("djs-resizer")) return { skipped: `resizer not hit: ${reach.what}` };
  const before = (await shapeOf(node, spec.id))!;
  const dragged = await node.drag(
    grab,
    { x: spec.travel.x * zoom, y: spec.travel.y * zoom },
    spec.hold ? { hold: spec.hold } : {},
  );
  await board.page.waitForTimeout(80);
  const after = (await shapeOf(node, spec.id))!;
  const scale = (await node.diagramScale()) ?? 1;
  // a handle that travels left or up grows the shape by what it travels
  const [grewX, grewY] = [after.width - before.width, after.height - before.height];
  const [wentX, wentY] = [Math.abs(dragged.delta.x), Math.abs(dragged.delta.y)];
  return {
    ratioX: round((grewX * scale) / wentX, 3),
    ratioY: round((grewY * scale) / wentY, 3),
    grewUnits: { x: round(grewX, 1), y: round(grewY, 1) },
    expectedUnits: { x: round(wentX / scale, 1), y: round(wentY / scale, 1) },
  };
};

/** the lasso tool drawn tightly around one task: the frame against the pointer, and what gets selected */
const lasso: Case = async (ctx) => {
  const { node, board } = ctx;
  const id = "Task_fulfill_order";
  const tool = (await node.query('.djs-palette .entry[data-action="lasso-tool"]'))[0];
  if (!tool) return { skipped: "no lasso entry" };
  const blocked = await pressable(ctx, centre(tool));
  if (blocked) return { skipped: `lasso entry ${blocked}` };
  await board.click(centre(tool));
  // 14 units around the task: nothing else lies wholly inside
  const map = await node.map();
  const from = aimAt(map, await screenOf(node, { x: 756, y: 116 }));
  const to = aimAt(map, await screenOf(node, { x: 884, y: 224 }));
  await board.drag(from, to, { keepDown: true });
  const frame = (await node.query(".djs-lasso-overlay"))[0];
  await board.release();
  await board.page.waitForTimeout(80);
  const selected = await node.selected();
  await board.press("Escape");
  return {
    frameStartOff: frame ? delta({ x: frame.x, y: frame.y }, from) : null,
    frameEndOff: frame ? delta(corner(frame), to) : null,
    selected,
    exact: selected.length === 1 && selected[0] === id,
  };
};

const FLOW = "Flow_to_invoice";

/** the last segment of a flow dragged sideways: does a segment move start, the dragger against the pointer, the waypoints */
const segment: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  // the middle of the vertical segment (930, 170) to (930, 430)
  const at = await screenOf(node, { x: 930, y: 300 });
  const blocked = await pressable(ctx, at, FLOW);
  if (blocked) return { skipped: blocked };
  const before = (await shapeOf(node, FLOW))!.waypoints!;
  const view = await node.viewportMatrix();
  const dragged = await node.drag(at, { x: 24 * zoom, y: 0 }, { hold: ["Control"], keepDown: true });
  const dragger = (await node.query(".djs-segment-dragger.djs-dragging"))[0];
  await board.release(["Control"]);
  await board.page.waitForTimeout(80);
  const after = (await shapeOf(node, FLOW))!.waypoints!;
  const viewAfter = await node.viewportMatrix();
  const scale = (await node.diagramScale()) ?? 1;
  const moved = after[after.length - 1]!.x - before[before.length - 1]!.x;
  return {
    started: !!dragger,
    draggerOffX: dragger ? px(centre(dragger).x - dragged.to.x) : null,
    movedUnits: round(moved, 1),
    expectedUnits: round(dragged.delta.x / scale, 1),
    ratio: round((moved * scale) / dragged.delta.x, 3),
    // a press that starts nothing on the flow pans the canvas instead
    panned: !!view && !!viewAfter && (view.e !== viewAfter.e || view.f !== viewAfter.f),
  };
};

/** a new bendpoint dragged out of a flow: the floating marker on hover, then the dragged point against the pointer */
const bendpoint: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  const map = await node.map();
  // 22 units below the corner at (930, 170): no waypoint (10 units), and outside the middle two thirds
  // of the 260 unit segment, where a press starts a segment move instead (Bendpoints.js)
  const at = aimAt(map, await screenOf(node, { x: 930, y: 192 }));
  const blocked = await pressable(ctx, at, FLOW);
  if (blocked) return { skipped: blocked };
  for (let step = 4; step >= 0; step--) await board.move({ x: at.x, y: at.y - step });
  await board.page.waitForTimeout(80);
  // Bendpoints.js translates the marker to the point of the flow it took the pointer for. Read from
  // its transform: the product's canvas options never show it without a selection
  const marker = await node.inDocument((host, flow) => {
    const floating = host.querySelector(`.djs-bendpoints[data-element-id="${flow}"] .djs-bendpoint.floating`);
    const matrix = floating?.classList.contains("positioned")
      ? (floating as SVGGElement).transform.baseVal.consolidate()?.matrix
      : undefined;
    return matrix ? { x: matrix.e, y: matrix.f } : null;
  }, FLOW);
  const floating = marker ? await screenOf(node, marker) : null;
  const dragged = await node.drag(at, { x: 24 * zoom, y: 16 * zoom }, { hold: ["Control"], keepDown: true });
  const point = (await node.query(".djs-bendpoint.djs-dragging .djs-visual"))[0];
  const view = await node.viewportMatrix();
  await board.press("Escape");
  await board.release(["Control"]);
  const viewAfter = await node.viewportMatrix();
  return {
    floatingOff: floating ? delta(floating, at) : null,
    started: !!point,
    pointOff: point ? delta(centre(point), dragged.to) : null,
    panned: !!view && !!viewAfter && (view.e !== viewAfter.e || view.f !== viewAfter.f),
  };
};

/** the bare canvas dragged: the diagram's displacement over the pointer's */
const pan: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  const probe = MOVABLE[ctx.notation].id;
  const host = await node.hostBox();
  // the first view leaves 24 diagram units around the content: search that band for bare canvas
  let from: Point | null = null;
  for (const inset of [4, 6, 8, 3, 10, 12]) {
    for (const candidate of [
      { x: host.x + host.width * 0.55, y: host.y + inset * zoom },
      { x: host.x + host.width * 0.55, y: host.y + host.height - inset * zoom },
      { x: host.x + host.width - inset * zoom, y: host.y + host.height * 0.5 },
    ]) {
      const hit = await node.hit(candidate);
      if (hit.reachable && hit.what.startsWith("svg") && !hit.palette) from ??= candidate;
    }
    if (from) break;
  }
  if (!from) return { skipped: "no bare canvas found in the margin of the first view" };
  const before = (await node.elementBox(probe))!;
  const dragged = await node.drag(from, { x: 70 * zoom, y: 44 * zoom });
  await board.page.waitForTimeout(60);
  const after = (await node.elementBox(probe))!;
  return {
    ratioX: round((after.x - before.x) / dragged.delta.x, 3),
    ratioY: round((after.y - before.y) / dragged.delta.y, 3),
    armed: (await node.state()).armed,
  };
};

/** Control + wheel over a shape (the point under the pointer stays) and a plain wheel (the canvas scrolls) */
const wheel: Case = async (ctx) => {
  const { node, board } = ctx;
  const probe = MOVABLE[ctx.notation].id;
  const box = (await node.elementBox(probe))!;
  const at = aimAt(await node.map(), centre(box));
  const blocked = await pressable(ctx, at);
  if (blocked) return { skipped: blocked };
  const viewport = await board.viewport();
  const scaleBefore = (await node.diagramScale()) ?? 1;
  await board.move(at);
  for (let step = 0; step < 3; step++) {
    await board.wheel(at, -100, { hold: ["Control"] });
    await board.page.waitForTimeout(60);
  }
  const zoomed = (await node.elementBox(probe))!;
  const scaleAfter = (await node.diagramScale()) ?? 1;
  // deltaY 100 scrolls by 75 px in diagram-js (ZoomScroll.js: factor -0.75), upwards
  await board.wheel(at, 100);
  await board.page.waitForTimeout(60);
  const scrolled = (await node.elementBox(probe))!;
  const now = await board.viewport();
  return {
    zoomFactor: round(scaleAfter / scaleBefore, 3),
    pivotOff: delta(centre(zoomed), at),
    scrollPx: px(scrolled.y - zoomed.y),
    scrollRatio: round((scrolled.y - zoomed.y) / -75, 3),
    boardMoved: now.x !== viewport.x || now.y !== viewport.y || now.zoom !== viewport.zoom,
    armed: (await node.state()).armed,
  };
};

/**
 * Which element carries the pad, which pad entry (data-action) opens a popup menu and which popup
 * entry to choose, per engine. Team Topology has no popup menu. Without `choose` the second entry
 * of the popup is taken and any change of the file counts.
 */
const PAD: Record<ModelNotation, { id: string; open?: string; choose?: string; changed?: RegExp }> = {
  bpmn: {
    id: "Task_check_credit",
    open: "replace",
    choose: '.entry[data-id="replace-with-service-task"]',
    changed: /<bpmn:serviceTask id="Task_check_credit"/,
  },
  // the decision: an input data has no replace entry
  dmn: {
    id: "credit-limit-check",
    open: "replace",
    choose: '.entry[data-id="replace-with-literal-expression"]',
    changed: /<literalExpression/,
  },
  wardley: { id: "cmp_cup", open: "settings" },
  "team-topology": { id: "team_fraud" },
  "event-storming": { id: "ext_payment_provider", open: "change-kind" },
  "context-map": { id: "ctx_ordering", open: "subdomain-type" },
  "value-chain": { id: "step-capture", open: "set-color" },
};

/** the context pad against its shape, the popup against the pad entry that opens it, every popup entry, one chosen */
const pad: Case = async (ctx) => {
  const { node, board } = ctx;
  const spec = PAD[ctx.notation];
  if (!(await selectAt(ctx, spec.id))) return { skipped: `${spec.id} could not be selected` };
  const box = await boxOf(ctx, ".djs-context-pad.open");
  const shape = (await node.elementBox(spec.id))!;
  const scale = (await node.diagramScale()) ?? 1;
  const host = await node.hostBox();
  if (!box) return { skipped: "no open pad" };
  const entries = await node.query(".djs-context-pad.open .entry");
  let padReachable = 0;
  for (const one of entries) if ((await node.hit(centre(one))).pad) padReachable++;
  const row: Row = {
    padGapX: px(box.x - (shape.x + shape.width)),
    padGapY: px(box.y - shape.y),
    padGapUnits: round((box.x - (shape.x + shape.width)) / scale, 2),
    padWidth: px(box.width),
    padInHost: box.x >= host.x && box.x + box.width <= host.x + host.width,
    padEntries: `${padReachable} of ${entries.length} hit`,
  };
  if (!spec.open) return row;
  const entry = await boxOf(ctx, `.djs-context-pad.open .entry[data-action="${spec.open}"]`);
  if (!entry) return { ...row, popup: "no such pad entry" };
  const hit = await node.hit(centre(entry));
  if (!hit.reachable || !hit.pad) return { ...row, popup: `pad entry not reachable: ${hit.what}` };
  row.entrySize = px(entry.width);
  const click = aimAt(await node.map(), centre(entry));
  await board.click(click);
  const popup = await boxOf(ctx, ".djs-popup");
  if (!popup) return { ...row, popup: "did not open" };
  // bpmn-js and dmn-js open it at (pad.left, pad.bottom + 5) in client px, the renderers at or beside the
  // click. Against the pad as it lay at the click: that is the rectangle the engine read
  row.popupOffPad = delta({ x: popup.x, y: popup.y }, { x: box.x, y: box.y + box.height });
  row.popupOffClick = delta({ x: popup.x, y: popup.y }, click);
  row.popupSize = `${round(popup.width, 0)}x${round(popup.height, 0)}`;
  const view = board.page.viewportSize()!;
  row.popupInWindow = popup.x >= 0 && popup.y >= 0 && corner(popup).x <= view.width && corner(popup).y <= view.height;
  const items = await node.query(".djs-popup .entry");
  let reachable = 0;
  for (const one of items) {
    const at = centre(one);
    const inside = at.y > popup.y && at.y < popup.y + popup.height;
    if (inside && (await node.hit(at)).popup) reachable++;
  }
  row.entries = `${reachable} of ${items.length} hit`;
  const choice = spec.choose ? (await node.query(`.djs-popup ${spec.choose}`))[0] : items[1];
  if (!choice) return { ...row, chosen: "no such popup entry" };
  if (!(await node.hit(centre(choice))).popup) return { ...row, chosen: "entry not hit" };
  const text = await board.fileText(ctx.file);
  await board.click(centre(choice));
  const changed = await board.waitForFileChange(ctx.file, text, 2000);
  row.chosen = changed !== null && (spec.changed?.test(changed) ?? true);
  await board.press("Escape");
  return row;
};

/**
 * The palette's tooltip against the entry it belongs to. diagram-js (bpmn-js, the DRD) puts it at
 * (entry.right + 8, the entry's middle); the renderers' own tooltip sits below their palette,
 * centred on the entry.
 */
const tip: Case = async (ctx) => {
  const { node, board } = ctx;
  const entry = (await node.query(".djs-palette .entry"))[2];
  const palette = (await node.query(".djs-palette"))[0];
  if (!entry || !palette) return { skipped: "no palette entry" };
  const blocked = await pressable(ctx, centre(entry));
  if (blocked) return { skipped: `palette entry ${blocked}` };
  await board.move({ x: centre(entry).x - 1, y: centre(entry).y });
  await board.move(centre(entry));
  const box = await boxOf(ctx, ".djs-hover-tooltip", 2500);
  if (!box) return { tooltip: false };
  const view = board.page.viewportSize()!;
  return {
    tooltip: true,
    // beside the entry (diagram-js)
    offX: px(box.x - (entry.x + entry.width)),
    offY: px(centre(box).y - centre(entry).y),
    // below the palette (the renderers)
    centreOffX: px(centre(box).x - centre(entry).x),
    belowPalette: px(box.y - (palette.y + palette.height)),
    size: `${round(box.width, 0)}x${round(box.height, 0)}`,
    inWindow: box.x >= 0 && box.y >= 0 && corner(box).x <= view.width && corner(box).y <= view.height,
  };
};

/**
 * The element whose label is edited, where its drawn label is (default: the whole shape) and, where
 * a shape has more than one text, the field that is its name. Context Maps decides by the pointer's
 * height in the shape whether a double-click edits the name or the team line below it.
 */
const LABEL: Record<ModelNotation, { id: string; text?: string; nameField?: string }> = {
  bpmn: { id: "Task_check_credit" },
  dmn: { id: "InputData_segment" },
  wardley: { id: "cmp_cup", text: '[data-element-id="cmp_cup"] text.wardley-name-label' },
  "team-topology": { id: "team_fraud" },
  "event-storming": { id: "event_order_placed" },
  "context-map": { id: "ctx_ordering", nameField: "label" },
  "value-chain": { id: "step-capture" },
};

/** the fields of the JSON file's object with this id that hold `text` */
function fieldsHolding(file: string, id: string, text: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.id === id) found.push(...Object.keys(record).filter((key) => record[key] === text));
      else Object.values(record).forEach(walk);
    }
  };
  try {
    walk(JSON.parse(file));
  } catch {
    /* not a JSON file */
  }
  return found;
}

/** the label editor of a shape: its box against the label, a close without typing, a typed name in the file */
const edit: Case = async (ctx) => {
  const { node, board } = ctx;
  const spec = LABEL[ctx.notation];
  const shape = await node.elementBox(spec.id);
  if (!shape) return { skipped: `${spec.id} is not drawn` };
  const at = aimAt(await node.map(), grabOf(ctx.notation, spec.id, shape));
  const blocked = await pressable(ctx, at, spec.id);
  if (blocked) return { skipped: blocked };
  const label = (spec.text ? (await node.query(spec.text))[0] : undefined) ?? shape;
  const original = await settledText(ctx, 300);
  // 1. open and close without typing: nothing may be written
  await board.doubleClick(at);
  const box = await boxOf(ctx, EDITOR);
  if (!box) return { editor: false };
  const row: Row = {
    editor: true,
    // the editor's middle against the label's, and its size over the label's
    boxOff: delta(centre(box), centre(label)),
    boxSize: `${round(box.width, 1)}x${round(box.height, 1)}`,
    labelSize: `${round(label.width, 1)}x${round(label.height, 1)}`,
  };
  const stack = await commands(node);
  await board.press(commitKey(ctx.notation));
  const untouched = await settledText(ctx);
  // a command re-serializes the whole file: the sample's own formatting is gone with the first one
  row.noTypingCommands = (await commands(node)) - stack;
  row.noTypingSameFile = untouched === original;
  // 2. open, replace the text, commit: the name is in the file
  const again = (await node.elementBox(spec.id)) ?? shape;
  await board.doubleClick(aimAt(await node.map(), grabOf(ctx.notation, spec.id, again)));
  if (!(await boxOf(ctx, EDITOR))) return { ...row, typed: "editor did not open again" };
  await board.press("Control+A");
  await board.type("Zed name");
  await board.press(commitKey(ctx.notation));
  const typed = await board.waitForFileChange(ctx.file, untouched);
  row.typed = typed !== null && typed.includes("Zed name");
  if (typed !== null && spec.nameField) {
    // in the file, but where: the name, or another text of the same shape
    const fields = fieldsHolding(typed, spec.id, "Zed name");
    row.typedInto = fields.join(",") || "nowhere in the shape";
    row.typed = fields.length === 1 && fields[0] === spec.nameField;
  }
  return row;
};

/**
 * A text annotation (created through the engine's own modeling service, so that no pointer math is
 * in its creation): its editor's box, a close without typing (pointer-math-core.md O6: under a
 * scale that resizes the annotation), and a close by a click elsewhere.
 */
const annotation: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  const id = await createAnnotation(ctx);
  const withNote = await settledText(ctx);
  const before = (await shapeOf(node, id))!;
  const shape = (await node.elementBox(id))!;
  const blocked = await pressable(ctx, centre(shape), id);
  if (blocked) return { skipped: blocked };
  await board.doubleClick(centre(shape));
  const box = await boxOf(ctx, ".djs-direct-editing-parent");
  if (!box) return { editor: false };
  const row: Row = {
    editor: true,
    boxOff: delta(centre(box), centre(shape)),
    boxSize: `${round(box.width, 1)}x${round(box.height, 1)}`,
    labelSize: `${round(shape.width, 1)}x${round(shape.height, 1)}`,
  };
  const stack = await commands(node);
  await board.press("Enter");
  const afterEnter = await settledText(ctx);
  const sized = (await shapeOf(node, id))!;
  row.noTypingCommands = (await commands(node)) - stack;
  row.noTypingSameFile = afterEnter === withNote;
  row.noTypingSize = `${round(before.width, 2)}x${round(before.height, 2)} -> ${round(sized.width, 2)}x${round(sized.height, 2)}`;
  // the same, closed by a click on the bare lane instead of Enter (focusout completes too)
  await board.doubleClick(centre((await node.elementBox(id))!));
  if (await boxOf(ctx, ".djs-direct-editing-parent")) {
    const away = await screenOf(node, ctx.notation === "bpmn" ? { x: 1010, y: 320 } : { x: 540, y: 410 });
    await board.click(aimAt(await node.map(), away));
    const afterClick = await settledText(ctx);
    const clicked = (await shapeOf(node, id))!;
    row.clickAwaySameFile = afterClick === afterEnter;
    row.clickAwaySize = `${round(clicked.width, 2)}x${round(clicked.height, 2)}`;
  }
  // last, so that nothing above depends on it: the text box's own resize handle (TextBox.js adds the
  // pointer's client travel to the box's size), dragged and then cancelled
  await board.doubleClick(centre((await node.elementBox(id))!));
  const open = await boxOf(ctx, ".djs-direct-editing-parent");
  const handle = (await node.query(".djs-direct-editing-resize-handle"))[0];
  if (open && handle) {
    const grab = aimAt(await node.map(), centre(handle));
    const hit = await node.hit(grab);
    if (!hit.reachable || !hit.what.includes("djs-direct-editing")) row.handle = `not hit: ${hit.what}`;
    else {
      const dragged = await node.drag(grab, { x: 24 * zoom, y: 12 * zoom });
      const grown = (await node.query(".djs-direct-editing-parent"))[0];
      // the box's growth on screen over the pointer's travel: 1 keeps the handle under the pointer
      row.handleRatioX = grown ? round((grown.width - open.width) / dragged.delta.x, 3) : null;
      row.handleRatioY = grown ? round((grown.height - open.height) / dragged.delta.y, 3) : null;
    }
    await board.press("Escape");
  }
  return row;
};

/** a shape dragged to the canvas edge and held: does the canvas scroll, and is the preview under the pointer afterwards */
const autoscroll: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  const target = MOVABLE[ctx.notation];
  const box = (await node.elementBox(target.id))!;
  const grab = target.grab?.(box) ?? centre(box);
  const blocked = await pressable(ctx, grab, target.id);
  if (blocked) return { skipped: blocked };
  const host = await node.hostBox();
  const map = await node.map();
  // 8 screen px inside the host's lower edge: diagram-js scrolls within 20 px of it
  const edge = aimAt(map, { x: grab.x + 30 * zoom, y: host.y + host.height - 8 });
  await board.drag(aimAt(map, grab), edge, { keepDown: true, steps: 16 });
  const start = await node.viewportMatrix();
  await board.page.waitForTimeout(300);
  const held = await node.viewportMatrix();
  // back inside by 60 flow units: the scrolling stops, the preview follows the pointer
  const inside = aimAt(map, { x: edge.x, y: edge.y - 60 * zoom });
  await board.move(inside, 6);
  await board.page.waitForTimeout(80);
  const rest = await node.viewportMatrix();
  await board.page.waitForTimeout(120);
  const still = await node.viewportMatrix();
  const preview = (await node.query(".djs-drag-group"))[0];
  await board.press("Escape");
  await board.release();
  return {
    // container px the canvas scrolled while the pointer rested at the edge for 300 ms
    scrolledWhileHeld: start && held ? px(start.f - held.f) : null,
    stoppedInside: !!rest && !!still && rest.f === still.f,
    previewOff: preview
      ? delta(centre(preview), { x: inside.x + (centre(box).x - grab.x), y: inside.y + (centre(box).y - grab.y) })
      : null,
  };
};

/**
 * The renderer's OWN draw tool (Wardley, Event Storming: `(clientX - rect.left) / zoom + viewbox.x`
 * in their bundles, not diagram-js's Dragging): a line from one click to the next, against the two
 * points clicked. Wardley ends a line with a double-click, Event Storming with Enter.
 */
const draw: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  const tool = (await node.query('.djs-palette .entry[data-action="draw-tool"]'))[0];
  if (!tool) return { skipped: "no draw tool in the palette" };
  const blocked = await pressable(ctx, centre(tool));
  if (blocked) return { skipped: `draw tool ${blocked}` };
  const middle = await freeSpot(ctx, 60 * zoom);
  if (!middle) return { skipped: "no free spot on the canvas" };
  const map = await node.map();
  const from = aimAt(map, { x: middle.x - 35 * zoom, y: middle.y - 20 * zoom });
  const to = aimAt(map, { x: middle.x + 35 * zoom, y: middle.y + 20 * zoom });
  const ids = new Set(await node.elementIds());
  const text = await board.fileText(ctx.file);
  await board.click(centre(tool));
  await board.page.waitForTimeout(80);
  await board.move(from, 6);
  await board.click(from);
  await board.move(to, 8);
  if (ctx.notation === "wardley") await board.doubleClick(to);
  else {
    await board.click(to);
    await board.press("Enter");
  }
  const id = await board.waitFor(async () => (await node.elementIds()).find((one) => !ids.has(one)) ?? null, 1500);
  const line = id ? await node.elementBox(id) : null;
  await board.press("Escape");
  return {
    drawn: !!line,
    startOff: line ? delta({ x: line.x, y: line.y }, from) : null,
    endOff: line ? delta(corner(line), to) : null,
    fileChanged: (await board.waitForFileChange(ctx.file, text, 1500)) !== null,
  };
};

/**
 * Wardley's OWN evolution handle (its bundle converts the pointer by a RATIO of the viewbox width to
 * the container's client width, so it holds under any outer scale): dragged to the right, the
 * evolution the file gets against the one under the pointer at the release.
 */
const evolve: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  // the sample's one component with a movement: the handle is the circle at its evolved position
  const id = "cmp_kettle";
  const handle = await boxOf(ctx, `[data-element-id="${id}"] .wardley-evolve-handle`);
  if (!handle) return { skipped: "no evolution handle" };
  const grab = centre(handle);
  const hit = await node.hit(grab);
  if (!hit.reachable || !hit.what.includes("wardley-evolve-handle")) return { skipped: `handle not hit: ${hit.what}` };
  // the plot's evolution axis from two components of the sample: Kettle at 0.35, Water at 0.82
  const circle = async (one: string): Promise<number> => grabOf("wardley", one, (await node.elementBox(one))!).x;
  const [kettle, water] = [await circle("cmp_kettle"), await circle("cmp_water")];
  const perEvolution = (water - kettle) / (0.82 - 0.35);
  const text = await board.fileText(ctx.file);
  const dragged = await node.drag(grab, { x: 44 * zoom, y: 0 });
  const changed = await board.waitForFileChange(ctx.file, text, 2000);
  const written = changed ? /^evolve Kettle ([\d.]+)/m.exec(changed)?.[1] : undefined;
  const under = 0.35 + (dragged.to.x - kettle) / perEvolution;
  return {
    written: written ?? null,
    underPointer: round(under, 3),
    // the file keeps two decimals: half a hundredth of the axis is the rounding
    offPx: written === undefined ? null : px((Number(written) - under) * perEvolution),
    roundingPx: px(0.005 * perEvolution),
  };
};

/**
 * A renderer's OWN box that it places from client rectangles, opened from the context pad: Wardley's
 * colour picker (absolute, at the click) and Context Maps' text prompt (`position: fixed`, beside
 * the entry). Neither is diagram-js's popup menu, so the module's popup layer does not see them.
 */
const OWN_BOX: Partial<Record<ModelNotation, { id: string; entry: string; box: string; beside: boolean }>> = {
  wardley: { id: "cmp_cup", entry: "color", box: ".wardley-color-picker", beside: false },
  "context-map": { id: "ctx_ordering", entry: "description", box: ".cm-pad-prompt", beside: true },
};

const ownBox: Case = async (ctx) => {
  const { node, board } = ctx;
  const spec = OWN_BOX[ctx.notation];
  if (!spec) return { skipped: "no such box in this notation" };
  if (!(await selectAt(ctx, spec.id))) return { skipped: `${spec.id} could not be selected` };
  const entry = await boxOf(ctx, `.djs-context-pad.open .entry[data-action="${spec.entry}"]`);
  if (!entry) return { skipped: `no pad entry ${spec.entry}` };
  const click = aimAt(await node.map(), centre(entry));
  const hit = await node.hit(click);
  if (!hit.reachable || !hit.pad) return { opened: false, why: `pad entry not reachable: ${hit.what}` };
  await board.click(click);
  const box = await boxOf(ctx, spec.box, 1500);
  await board.press("Escape");
  if (!box) return { opened: false };
  const host = await node.hostBox();
  return {
    opened: true,
    // Wardley: the picker's corner at the click. Context Maps: the prompt at (entry.right + 8, entry.top)
    off: delta({ x: box.x, y: box.y }, spec.beside ? { x: entry.x + entry.width + 8, y: entry.y } : click),
    size: `${round(box.width, 0)}x${round(box.height, 0)}`,
    inHost:
      box.x >= host.x &&
      box.y >= host.y &&
      corner(box).x <= host.x + host.width &&
      corner(box).y <= host.y + host.height,
  };
};

/**
 * The hand tool of the palette: the canvas dragged with it. diagram-js's HandTool scrolls by the
 * drag event's dx (the `drag` layer's ground); Value Chain re-anchors the drag with pointer math of
 * its own on every move (`anchorPanToView` in its bundle).
 */
const hand: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  const tool = (await node.query('.djs-palette .entry[data-action="hand-tool"]'))[0];
  if (!tool) return { skipped: "no hand tool in the palette" };
  const blocked = await pressable(ctx, centre(tool));
  if (blocked) return { skipped: `hand tool ${blocked}` };
  const probe = MOVABLE[ctx.notation].id;
  const from = await freeSpot(ctx, 30 * zoom);
  if (!from) return { skipped: "no free spot on the canvas" };
  await board.click(centre(tool));
  await board.page.waitForTimeout(80);
  const before = (await node.elementBox(probe))!;
  const dragged = await node.drag(from, { x: 60 * zoom, y: 40 * zoom });
  await board.page.waitForTimeout(80);
  const after = (await node.elementBox(probe))!;
  await board.press("Escape");
  return {
    ratioX: round((after.x - before.x) / dragged.delta.x, 3),
    ratioY: round((after.y - before.y) / dragged.delta.y, 3),
  };
};

// ── the DMN decision table: HTML drawn by table-js, no diagram-js canvas ──────

const TABLE_SCROLLER = ".dmn-decision-table-container";

/** the engine's own objects for the table view (in-page strategies) */
const inTable = <A, R>(node: NodeHandle, read: (modeler: any, arg: A) => R, arg?: A): Promise<R> =>
  node.inDocument(
    (_host, given) => {
      const hooks = (window as unknown as { __boardSpike: { engine(id: string): { engine: { modeler: unknown } } } })
        .__boardSpike;
      return (0, eval)(`(${given.source})`)(hooks.engine(given.id).engine.modeler, given.arg) as never;
    },
    { id: node.id, source: read.toString(), arg },
  ) as Promise<R>;

/** a point of the element that this node's editor takes a press at: its middle, else null with the reason */
async function aimIn(ctx: Ctx, selector: string): Promise<{ box: Box | null; at: Point | null; why?: string }> {
  const box = (await ctx.node.query(selector))[0] ?? null;
  if (!box) return { box, at: null, why: `no ${selector}` };
  const at = aimAt(await ctx.node.map(), centre(box));
  const hit = await ctx.node.hit(at);
  return hit.reachable ? { box, at } : { box, at: null, why: `${selector} not reachable: ${hit.what}` };
}

/**
 * The decision table under the scale: a rule cell's size, a column border dragged by 40 flow units
 * and the width that writes into the file, the context menu against the right-click, the hit
 * policy dropdown against its field, a value typed into a cell.
 */
const table: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  await inTable(node, async (modeler) => {
    const view = modeler.getViews().find((one: { type: string }) => one.type === "decisionTable");
    await modeler.open(view);
  });
  const cellSelector = 'td[data-element-id="UnaryTests_blocked_value"]';
  if (!(await board.waitFor(async () => (await node.query(cellSelector)).length > 0, 3000))) {
    return { skipped: "the table did not open" };
  }
  await board.page.waitForTimeout(200);
  const net = await node.netScale();
  const cell = (await node.query(cellSelector))[0]!;
  const row: Row = { cellSize: `${round(cell.width, 1)}x${round(cell.height, 1)}` };

  // 1. a column border, dragged to the right
  const column = 'th[data-col-id="Input_segment"]';
  const handle = await aimIn(ctx, `${column} .resize-column-handle`);
  const head = (await node.query(column))[0];
  if (!handle.at || !head) row.column = handle.why ?? "no header cell";
  else {
    const text = await board.fileText(ctx.file);
    const dragged = await node.drag(handle.at, { x: 40 * zoom, y: 0 });
    await board.page.waitForTimeout(150);
    const after = (await node.query(column))[0]!;
    const stored = await inTable(node, (modeler) => {
      const cols = modeler.getActiveViewer().get("sheet").getRoot().cols as Array<{
        id: string;
        businessObject: { width?: number };
      }>;
      return cols.find((one) => one.id === "Input_segment")?.businessObject.width ?? null;
    });
    // in the table's own px: the width it had plus the pointer's travel (dmn-js: never below 150)
    const expected = Math.max(150, (head.width + dragged.delta.x) / net);
    row.columnStored = stored === null ? null : round(stored, 1);
    row.columnExpected = round(expected, 1);
    row.columnOff = stored === null ? null : round(stored - expected, 1);
    // the border under the pointer: its travel on screen over the pointer's
    row.columnEdgeRatio = round((after.x + after.width - (head.x + head.width)) / dragged.delta.x, 3);
    row.columnInFile = (await board.waitForFileChange(ctx.file, text, 1500)) !== null;
  }

  // 2. the context menu of a rule cell
  const target = await aimIn(ctx, 'td[data-element-id="UnaryTests_blocked_segment"]');
  if (!target.at) row.menu = target.why;
  else {
    await board.click(target.at, { button: "right" });
    const menu = await boxOf(ctx, ".context-menu", 1500);
    if (!menu) row.menu = "did not open";
    else {
      // table-js opens it with a corner at the click: the nearest corner tells how far off it is
      const corners = [
        { x: menu.x, y: menu.y },
        { x: menu.x + menu.width, y: menu.y },
        { x: menu.x, y: menu.y + menu.height },
        corner(menu),
      ];
      const nearest = corners.reduce((best, one) =>
        Math.hypot(one.x - target.at!.x, one.y - target.at!.y) <
        Math.hypot(best.x - target.at!.x, best.y - target.at!.y)
          ? one
          : best,
      );
      row.menuCornerOff = delta(nearest, target.at);
      row.menuSize = `${round(menu.width, 0)}x${round(menu.height, 0)}`;
      const entries = await node.query(".context-menu .context-menu-group-entry");
      let hit = 0;
      for (const one of entries) {
        const found = await node.hit(centre(one));
        if (found.reachable && found.what.includes("context-menu")) hit++;
      }
      row.menuEntries = `${hit} of ${entries.length} hit`;
    }
    await board.press("Escape");
    await board.page.waitForTimeout(100);
  }

  // 3. the hit policy dropdown (dmn-js-shared InputSelect)
  const field = await aimIn(ctx, ".hit-policy-edit-policy-select .dms-input");
  if (!field.at || !field.box) row.dropdown = field.why;
  else {
    await board.click(field.at);
    let options = await boxOf(ctx, ".dms-select-options", 800);
    row.dropdownOpenedBy = options ? "click" : "ArrowDown";
    if (!options) {
      // dmn-js's components take clicks through Inferno's listener on the DOCUMENT. The spike's armed
      // node body stops a click at React's root (nodes/model-node.tsx), so in a strategy that keeps
      // the host in the node the click never arrives. The field has the focus: the key opens the list
      await board.press("ArrowDown");
      options = await boxOf(ctx, ".dms-select-options", 1500);
    }
    if (!options) row.dropdown = "did not open";
    else {
      // InputSelect.js: left-aligned with the field, right below it, as wide as the field
      row.dropdownOff = delta({ x: options.x, y: options.y }, { x: field.box.x, y: field.box.y + field.box.height });
      row.dropdownWidthRatio = round(options.width / field.box.width, 3);
      const list = await node.query(".dms-select-options .option");
      let hit = 0;
      for (const one of list) {
        const found = await node.hit(centre(one));
        if (found.reachable && found.what.includes("option")) hit++;
      }
      row.dropdownOptions = `${hit} of ${list.length} hit`;
      const text = await board.fileText(ctx.file);
      // the next policy with the key: works with and without the click
      await board.press("ArrowDown");
      await board.press("Enter");
      const changed = await board.waitForFileChange(ctx.file, text, 1500);
      row.dropdownPicked = changed !== null && /hitPolicy="(?!FIRST)/.test(changed);
    }
    await board.press("Escape");
  }

  // 4. a value typed into a rule cell
  const typed = await aimIn(ctx, cellSelector);
  if (!typed.at) row.typed = typed.why;
  else {
    const text = await board.fileText(ctx.file);
    await board.click(typed.at);
    await board.page.waitForTimeout(150);
    await board.press("Control+A");
    await board.type("> 123");
    const other = await aimIn(ctx, 'td[data-element-id="UnaryTests_blocked_segment"]');
    if (other.at) await board.click(other.at);
    else await board.press("Tab");
    const changed = await board.waitForFileChange(ctx.file, text, 2000);
    row.typed = changed !== null && changed.includes("&gt; 123");
  }
  const scroller = (await node.query(TABLE_SCROLLER))[0];
  const host = await node.hostBox();
  row.tableInHost = scroller ? cell.y >= host.y && cell.y + cell.height <= host.y + host.height : null;
  return row;
};

// ── side effects ─────────────────────────────────────────────────────────────

/** Backspace on a selected shape: the editor's, not the board's */
const keys: Case = async (ctx) => {
  const { node, board } = ctx;
  const id = MOVABLE[ctx.notation].id;
  if (!(await selectAt(ctx, id))) return { skipped: `${id} could not be selected` };
  const [boardText, nodes] = [await board.boardText(), (await board.nodes()).length];
  await board.press("Backspace");
  const gone = await board.waitFor(async () => !(await node.elementIds()).includes(id), 1500);
  await board.page.waitForTimeout(500);
  return {
    shapeDeleted: gone === true,
    boardFileSame: (await board.boardText()) === boardText,
    boardNodes: `${(await board.nodes()).length} of ${nodes}`,
    armed: (await node.state()).armed,
  };
};

/** disarm and arm again: the picture stays, the chrome goes and comes back, the next drag is exact */
const rearm: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  const target = MOVABLE[ctx.notation];
  const shown = async (): Promise<number> =>
    node.inDocument(
      (host) =>
        [...host.querySelectorAll<HTMLElement>(".djs-palette")].filter(
          (one) => getComputedStyle(one).display !== "none",
        ).length,
    );
  const armedBox = (await node.elementBox(target.id))!;
  const paletteArmed = await shown();
  await board.arm(null);
  await board.page.waitForTimeout(150);
  const previewBox = (await node.elementBox(target.id))!;
  const palettePreview = await shown();
  await board.arm(node.id);
  await board.page.waitForTimeout(150);
  const again = (await node.elementBox(target.id))!;
  const grab = target.grab?.(again) ?? centre(again);
  const dragged = await node.drag(grab, { x: 60 * zoom, y: 40 * zoom }, target.hold ? { hold: target.hold } : {});
  const after = (await node.elementBox(target.id))!;
  return {
    previewMoved: delta({ x: previewBox.x, y: previewBox.y }, { x: armedBox.x, y: armedBox.y }),
    rearmedMoved: delta({ x: again.x, y: again.y }, { x: armedBox.x, y: armedBox.y }),
    palette: `${paletteArmed} armed, ${palettePreview} preview, ${await shown()} armed again`,
    ratioX: round((after.x - again.x) / dragged.delta.x, 3),
    ratioY: round((after.y - again.y) / dragged.delta.y, 3),
  };
};

/** how far the board is zoomed under a running gesture or an open editor */
const REZOOM = 1.3;

/** the board zoomed while a label editor holds half-typed text: nothing is lost, the box stays on its shape */
const zoomEdit: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  const spec = LABEL[ctx.notation];
  const shape = (await node.elementBox(spec.id))!;
  const at = aimAt(await node.map(), grabOf(ctx.notation, spec.id, shape));
  const blocked = await pressable(ctx, at, spec.id);
  if (blocked) return { skipped: blocked };
  const original = await settledText(ctx, 300);
  await board.doubleClick(at);
  const box = await boxOf(ctx, EDITOR);
  if (!box) return { editor: false };
  await board.press("Control+A");
  await board.type("Half typed");
  const before = delta(centre(box), centre(shape));
  await board.showNode(node.id, zoom * REZOOM, ORIGIN);
  await board.page.waitForTimeout(300);
  const boxNow = (await node.query(EDITOR))[0];
  const shapeNow = (await node.elementBox(spec.id))!;
  const during = await board.fileText(ctx.file);
  const row: Row = {
    stillOpen: !!boxNow,
    nothingWrittenYet: during === original,
    boxOffBefore: before,
    boxOffAfter: boxNow ? delta(centre(boxNow), centre(shapeNow)) : null,
    // the editor grew with the shape: its width over the shape's, before and after
    boxOverShape: boxNow ? `${round(box.width / shape.width, 3)} -> ${round(boxNow.width / shapeNow.width, 3)}` : null,
    unitPx: px(await node.diagramScale()),
  };
  if (boxNow) {
    await board.type(" on");
    await board.press(commitKey(ctx.notation));
  }
  const text = await board.waitForFileChange(ctx.file, original);
  row.committed = text !== null && text.includes("Half typed on");
  row.unitPxAfterCommit = px(await node.diagramScale());
  return row;
};

/** the board zoomed while a shape is held: the gesture goes on and the shape lands under the pointer */
const zoomDrag: Case = async (ctx) => {
  const { node, board, zoom } = ctx;
  const target = MOVABLE[ctx.notation];
  const box = (await node.elementBox(target.id))!;
  const grab = target.grab?.(box) ?? centre(box);
  const blocked = await pressable(ctx, grab, target.id);
  if (blocked) return { skipped: blocked };
  const hold = target.hold ?? [];
  await node.drag(grab, { x: 30 * zoom, y: 20 * zoom }, { hold, keepDown: true });
  await board.showNode(node.id, zoom * REZOOM, ORIGIN);
  await board.page.waitForTimeout(250);
  const map = await node.map();
  // the pointer goes on from where it is, by another (30, 20) flow units of the NEW zoom
  const from = aimAt(map, { x: grab.x + 30 * zoom, y: grab.y + 20 * zoom });
  const to = aimAt(map, { x: from.x + 30 * zoom * REZOOM, y: from.y + 20 * zoom * REZOOM });
  await board.move(to, 8);
  await board.page.waitForTimeout(60);
  const preview = (await node.query(".djs-drag-group"))[0];
  await board.release(hold);
  await board.page.waitForTimeout(400);
  const after = await node.elementBox(target.id);
  const grabbedAt = { x: grab.x - box.x, y: grab.y - box.y };
  return {
    // the shape's grab point against the pointer at the release, in the new zoom's px
    previewOff: preview
      ? delta(centre(preview), {
          x: to.x - (grab.x - centre(box).x) * REZOOM,
          y: to.y - (grab.y - centre(box).y) * REZOOM,
        })
      : null,
    dropOff: after ? delta({ x: after.x + grabbedAt.x * REZOOM, y: after.y + grabbedAt.y * REZOOM }, to) : null,
    armed: (await node.state()).armed,
    unitPx: px(await node.diagramScale()),
  };
};

const SIDE = { keys, rearm, zoomEdit, zoomDrag };

const CASES: Record<ModelNotation, Record<string, Case>> = {
  bpmn: {
    move,
    create,
    connect,
    resize,
    lasso,
    segment,
    bendpoint,
    pan,
    wheel,
    pad,
    tip,
    edit,
    annotation,
    autoscroll,
    hand,
    ...SIDE,
  },
  dmn: { move, create, connect, pan, wheel, pad, tip, edit, annotation, table, ...SIDE },
  wardley: { move, create, pad, edit, draw, evolve, ownBox, pan, wheel, tip, zoomEdit, zoomDrag },
  "team-topology": { move, create, pad, edit, resize, pan, wheel, tip, zoomEdit, zoomDrag },
  "event-storming": { move, create, pad, edit, draw, pan, wheel, tip, zoomEdit, zoomDrag },
  "context-map": { move, create, pad, edit, ownBox, pan, wheel, tip, zoomEdit, zoomDrag },
  "value-chain": { move, create, pad, edit, resize, hand, pan, wheel, tip, zoomEdit, zoomDrag },
};

// ── boards of their own: two nodes on one file, and the compare board ────────

type Suite = (harness: Harness, zoom: number, layers: string) => Promise<Row[]>;

/** one drag of a task in the armed node of a board by `travel` flow units: the ratio, and the pad's gap afterwards */
async function dragIn(board: Board, nodeId: string, element: string, zoom: number, travel: Point): Promise<Row> {
  await board.showNode(nodeId, zoom, ORIGIN);
  await board.arm(nodeId);
  const node = await board.node(nodeId);
  const before = await node.elementBox(element);
  if (!before) return { skipped: `${element} is not drawn` };
  const hit = await node.hit(centre(before));
  if (!hit.reachable || hit.element !== element) return { skipped: `hit ${hit.element ?? hit.what}` };
  const dragged = await node.drag(centre(before), { x: travel.x * zoom, y: travel.y * zoom }, { hold: ["Control"] });
  await board.page.waitForTimeout(500);
  const after = (await node.elementBox(element))!;
  const row: Row = {
    netScale: round(await node.netScale(), 3),
    ratioX: round((after.x - before.x) / dragged.delta.x, 3),
    ratioY: round((after.y - before.y) / dragged.delta.y, 3),
  };
  if (await node.select(element)) {
    const padBox = await board.waitForBox(async () => (await node.query(".djs-context-pad.open"))[0]);
    const shape = (await node.elementBox(element))!;
    row.padGapX = padBox ? px(padBox.x - (shape.x + shape.width)) : null;
  }
  return row;
}

/** two nodes of the plugin strategy on ONE file (board=stress): each exact when armed, the other follows */
const two: Suite = async (harness, zoom, layers) => {
  const head = { strategy: "plugin", layers, notation: "bpmn", zoom, case: "two" };
  const board = await harness.open(
    { board: "stress", strategy: "plugin", notation: "bpmn", count: 2, zoom, ...ORIGIN, params: { plugin: layers } },
    { dpr },
  );
  try {
    const rows: Row[] = [];
    const element = "Task_check_credit";
    const model = async (id: string): Promise<Shape | null> => shapeOf(await board.node(id), element);
    // the second drag goes back and down: twice the first travel would drop the task on an end event
    for (const [armed, other, travel] of [
      ["s-0", "s-1", { x: 60, y: 40 }],
      ["s-1", "s-0", { x: -40, y: 30 }],
    ] as const) {
      const before = await model(other);
      const row = await dragIn(board, armed, element, zoom, travel);
      const mine = await model(armed);
      const theirs = await model(other);
      rows.push({
        ...head,
        armed,
        ...row,
        // the model's own units: what the peer node shows is what the armed one wrote
        peerFollowed: !!mine && !!theirs && mine.x === theirs.x && mine.y === theirs.y && theirs.x !== before?.x,
        mounts: (await board.counters()).mounts,
        problems: await board.problems({ allow: [KNOWN_CONSOLE.padDeprecation] }),
      });
    }
    return rows;
  } finally {
    await board.close();
  }
};

/**
 * The compare board (one file, a node per strategy): one drag and one pad per node. Run with the
 * module (`all`) and without it (`none`): a node of another strategy must give the same numbers in
 * both, since nothing of the module is shared between editors.
 */
const compare: Suite = async (harness, zoom, layers) => {
  const rows: Row[] = [];
  for (const strategy of STRATEGIES) {
    const head = { strategy, layers, notation: "bpmn", zoom, case: "compare" };
    let board: Board | undefined;
    try {
      // a fresh board per node: the drag of one node moves the task in all six
      board = await harness.open(
        { board: "compare", zoom, ...ORIGIN, params: { plugin: layers } },
        { dpr, allowUnmounted: true },
      );
      const id = `c-${strategy}`;
      const info = (await board.nodes()).find((one) => one.id === id);
      if (!info?.mounted) rows.push({ ...head, skipped: "not mounted" });
      else {
        const row = await dragIn(board, id, "Task_create_invoice", zoom, { x: 60, y: 40 });
        rows.push({
          ...head,
          ...row,
          mounts: (await board.counters()).mounts[id],
          problems: await board.problems({ allow: [KNOWN_CONSOLE.padDeprecation] }),
        });
      }
    } catch (error) {
      rows.push({ ...head, error: error instanceof Error ? error.message : String(error) });
    } finally {
      try {
        await board?.close();
      } catch {
        /* a navigation under the run is in the row already */
      }
    }
  }
  return rows;
};

const SUITES: Record<string, Suite> = { two, compare };

// ── the run ──────────────────────────────────────────────────────────────────

async function one(
  harness: Harness,
  strategy: Strategy,
  layers: string | null,
  notation: ModelNotation,
  zoom: number,
  name: string,
  measure: Case,
): Promise<Row> {
  const head = { strategy, layers: layers ?? "", notation, zoom, case: name };
  let board: Board | undefined;
  try {
    board = await harness.open(
      {
        board: "matrix",
        strategy,
        notations: [notation],
        zoom,
        ...ORIGIN,
        ...(layers !== null ? { params: { plugin: layers } } : {}),
      },
      { dpr },
    );
    const nodeId = `m-${notation}`;
    await board.arm(nodeId);
    const node = await board.node(nodeId);
    if (!(await node.state()).armed) return { ...head, error: "did not arm" };
    const ctx: Ctx = { board, node, strategy, notation, zoom, file: node.info.file ?? "" };
    const onHost = await node.inDocument((host) => host.dataset.pluginLayers ?? null);
    const netScale = round(await node.netScale(), 3);
    const row = await measure(ctx);
    const problems = await board.problems({ allow: [KNOWN_CONSOLE.padDeprecation, KNOWN_CONSOLE.feelEditor] });
    return {
      ...head,
      ...(layers !== null ? { layersOnHost: onHost } : {}),
      netScale,
      ...row,
      mounts: (await board.counters()).mounts[nodeId],
      problems,
    };
  } catch (error) {
    return { ...head, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      await board?.close();
    } catch (error) {
      console.error(`close: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await run(async (harness) => {
  // every row is a job of its own page(s); CONCURRENCY of them run at a time, the result keeps the order
  const jobs: Array<() => Promise<Row[]>> = [];
  const wanted = (name: string): boolean => wantedCases.length === 0 || wantedCases.includes(name);
  for (const notation of notations) {
    for (const [name, measure] of Object.entries(CASES[notation]).filter(([name]) => wanted(name))) {
      for (const zoom of zooms) {
        for (const strategy of strategies) {
          for (const layers of strategy === "plugin" ? layerLists : [null]) {
            jobs.push(async () => [await one(harness, strategy, layers, notation, zoom, name, measure)]);
          }
        }
      }
    }
  }
  // the suites run on boards of their own, for the plugin strategy's layer lists
  if (notations.includes("bpmn") && strategies.includes("plugin")) {
    for (const suite of Object.entries(SUITES).flatMap(([name, one]) => (wanted(name) ? [one] : []))) {
      for (const zoom of zooms) for (const layers of layerLists) jobs.push(() => suite(harness, zoom, layers));
    }
  }
  const results: Row[][] = new Array<Row[]>(jobs.length);
  let next = 0;
  let failures = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < jobs.length; index = next++) {
      const rows = await jobs[index]!();
      results[index] = rows;
      for (const row of rows) {
        if (row.error !== undefined || ((row.problems as string[] | undefined)?.length ?? 0) > 0) failures++;
        console.log(JSON.stringify(row));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  const rows = results.flat();
  const path = writeResult(process.env.NAME ?? "plugin", {
    strategies,
    notations,
    zooms,
    layerLists,
    dpr,
    concurrency,
    cases: wantedCases,
    rows,
  });
  console.log(`\n${rows.length} rows, ${failures} with an error or a console / log line -> ${path}`);
  return failures;
});
