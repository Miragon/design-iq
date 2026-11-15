/**
 * Smoke run and first measurement of the board spike: every strategy x every notation x three
 * board zooms, each on a fresh page. A check run by hand, not by `pnpm test` or CI: it starts a
 * Vite dev server and a sandboxed headless Chromium of its own (lib.ts).
 *
 *   node apps/web/test/spike/smoke-chromium.ts
 *   STRATEGIES=counter,overlay NOTATIONS=bpmn,dmn ZOOMS=0.5,1 node apps/web/test/spike/smoke-chromium.ts
 *
 * Per case (board=matrix with the one notation, the viewport from the URL, so the editor MOUNTS at
 * that zoom):
 *   1. the node's editor mounts (hooks.ready, `mounted`, one engine mount);
 *   2. the node arms (hooks.arm) and says so;
 *   3. one element is dragged by a known pointer distance: (60, 40) flow units, which is
 *      (60, 40) x the board zoom IN EFFECT screen px. Arming moves the board (the arm rules): an
 *      overlay node asked at 0.5 or at 1.5 is armed at board zoom exactly 1, so the viewport is
 *      read after arming and the travel taken from it (`zoomInEffect` of the row; `zoom` stays
 *      the zoom asked for, and the tables are keyed by it). The grab point is hit-tested first;
 *      the first candidate element that is not under the editor's chrome is taken;
 *   4. recorded: the element's displacement on screen over the pointer's (per axis; 1 is exact),
 *      the editor's net scale (client rect over layout size of its host; 1 is what diagram-js
 *      assumes), whether the file at the hub changed, whether the board file stayed the same,
 *      console errors, page errors and the page's own log.
 *
 * Expected, and marked with `!` where the measurement says otherwise: ratio = the board zoom in
 * effect in the naive strategy, 1 in every other one (`plugin` and `shim` too, although their net scale is the
 * board zoom like naive's). The numbers are a strategy's result, never a failure of
 * the run. Exits 1 only when the harness failed: a case threw (wrong page, not mounted, a
 * navigation, a timeout) or had a console error, a page error or a log line.
 *
 * Environment: STRATEGIES, NOTATIONS, ZOOMS (comma lists, default all / all / 0.5,1,1.5), plus
 * lib.ts's PORT, BASE, CACHE_DIR, OUT_DIR, OUT. The result goes to <OUT_DIR>/smoke.json.
 */
import {
  type Board,
  type Box,
  centre,
  type Harness,
  MODEL_NOTATIONS,
  type ModelNotation,
  type Point,
  round,
  run,
  STRATEGIES,
  type Strategy,
  writeResult,
} from "./lib.ts";

const list = <T extends string>(name: string, all: readonly T[]): T[] => {
  const wanted = (process.env[name] ?? "").split(",").filter(Boolean);
  return wanted.length === 0 ? [...all] : all.filter((one) => wanted.includes(one));
};
const strategies = list("STRATEGIES", STRATEGIES);
const notations = list("NOTATIONS", MODEL_NOTATIONS);
const zooms = (process.env.ZOOMS ?? "0.5,1,1.5").split(",").map(Number).filter(Boolean);

/** where the node's top-left corner sits in the canvas: clear of the toolbar */
const ORIGIN = { x: 60, y: 80 };
/** the pointer's travel in flow units; on screen it is this times the board zoom in effect after arming */
const TRAVEL = { x: 60, y: 40 };

interface Target {
  /** elements that move freely under a plain drag, in order of preference */
  candidates: readonly string[];
  /** where to press, from the element's box on screen (default: its middle) */
  grab?(box: Box): Point;
  /** bpmn-js and the DRD snap a move to a 10 unit grid; Control, pressed after the button, switches that off */
  hold?: readonly string[];
}

const TARGETS: Readonly<Record<ModelNotation, Target>> = {
  bpmn: { candidates: ["Task_validate_order", "Task_check_credit", "Task_fulfill_order"], hold: ["Control"] },
  dmn: { candidates: ["InputData_segment", "InputData_order_value", "InputData_overdue"], hold: ["Control"] },
  wardley: {
    candidates: ["cmp_cup", "cmp_tea", "cmp_hot_water", "cmp_water"],
    // the component's circle at the left of its graphics: the name beside it has a drag of its own
    grab: (box) => ({ x: box.x + box.height / 2, y: box.y + box.height / 2 }),
  },
  "team-topology": { candidates: ["team_fraud", "team_fulfilment", "team_checkout"] },
  "event-storming": { candidates: ["cmd_place_order", "agg_order", "event_order_placed", "cmd_ship_order"] },
  "context-map": { candidates: ["ctx_ordering", "ctx_catalog", "ctx_payment"] },
  "value-chain": { candidates: ["step-capture", "step-stock", "step-credit"] },
};

interface Row {
  strategy: Strategy;
  notation: ModelNotation;
  /** the board zoom asked for (the URL's) */
  zoom: number;
  /** the board zoom after arming: the one the editor runs at and the travel is taken from */
  zoomInEffect?: number;
  status: "measured" | "unreachable" | "failed";
  /** what went wrong, for the two other states */
  error?: string;
  mounted?: boolean;
  armed?: boolean;
  /** engine mounts of the node: 1 */
  mounts?: number;
  element?: string;
  /** candidates passed over before `element`, each with what lay over it (the editor's chrome at a low zoom) */
  covered?: string[];
  /** screen px */
  pointer?: Point;
  moved?: Point;
  /** moved / pointer per axis */
  ratio?: Point;
  /** what the strategy is expected to give: the board zoom in effect (naive) or 1 */
  expected?: number;
  /** the ratio is further from `expected` than one diagram unit of rounding explains */
  unexpected?: boolean;
  netScale?: number;
  /** screen px per diagram unit (the browser's matrix), null in an HTML view */
  unitPx?: number | null;
  /** client size of the engine host in its own layout px */
  hostSize?: { width: number; height: number };
  fileChanged?: boolean;
  boardSame?: boolean;
  navigations?: number;
  /** console errors, page errors and lines of the page's log */
  problems: string[];
  ms: number;
}

async function measure(board: Board, row: Row): Promise<void> {
  const nodeId = `m-${row.notation}`;
  const target = TARGETS[row.notation];
  const info = (await board.nodes()).find((node) => node.id === nodeId);
  if (!info?.file) throw new Error(`no model node ${nodeId}`);
  row.mounted = info.mounted;
  await board.arm(nodeId);
  // arming may have moved the board: every travel and expectation below is from the zoom in effect
  const zoom = (await board.viewport()).zoom;
  row.zoomInEffect = zoom;
  const node = await board.node(nodeId);
  row.armed = (await node.state()).armed;
  row.mounts = (await board.counters()).mounts[nodeId];
  row.netScale = round(await node.netScale(), 4);
  row.unitPx = await node.diagramScale();
  row.hostSize = await node.hostSize();

  let chosen: { element: string; box: Box; grab: Point } | undefined;
  const covered: string[] = [];
  for (const element of target.candidates) {
    const box = await node.elementBox(element);
    if (!box) {
      covered.push(`${element}: not drawn`);
      continue;
    }
    const grab = (target.grab ?? centre)(box);
    const hit = await node.hit(grab);
    if (hit.reachable && hit.element === element) {
      chosen = { element, box, grab };
      break;
    }
    covered.push(`${element}: ${hit.reachable ? hit.what : "outside the editor"}`);
  }
  if (!chosen) {
    row.status = "unreachable";
    row.error = `no candidate takes a press (${covered.join("; ")})`;
    return;
  }
  row.element = chosen.element;
  if (covered.length > 0) row.covered = covered;

  const [fileBefore, boardBefore] = [await board.fileText(info.file), await board.boardText()];
  const dragged = await node.drag(chosen.grab, { x: TRAVEL.x * zoom, y: TRAVEL.y * zoom }, { hold: target.hold ?? [] });
  // the editor writes its file about 350 ms after the gesture
  row.fileChanged = (await board.waitForFileChange(info.file, fileBefore)) !== null;
  const after = await node.elementBox(chosen.element);
  if (!after) throw new Error(`${chosen.element} is gone after the drag`);
  row.boardSame = (await board.boardText()) === boardBefore;
  row.armed = row.armed && (await node.state()).armed;
  row.pointer = { x: round(dragged.delta.x), y: round(dragged.delta.y) };
  const moved = { x: after.x - chosen.box.x, y: after.y - chosen.box.y };
  row.moved = { x: round(moved.x), y: round(moved.y) };
  row.ratio = { x: round(moved.x / dragged.delta.x, 3), y: round(moved.y / dragged.delta.y, 3) };
  row.expected = row.strategy === "naive" ? zoom : 1;
  // a move lands on whole diagram units (or on an engine's own grid): that much may be missing
  const slack = Math.max(2, 1.5 * (row.unitPx ?? 0) * (row.strategy === "naive" ? zoom : 1));
  row.unexpected =
    Math.abs(moved.x - dragged.delta.x * row.expected) > slack ||
    Math.abs(moved.y - dragged.delta.y * row.expected) > slack;
  row.status = "measured";
}

async function one(harness: Harness, strategy: Strategy, notation: ModelNotation, zoom: number): Promise<Row> {
  const started = Date.now();
  const row: Row = { strategy, notation, zoom, status: "failed", problems: [], ms: 0 };
  let board: Board | undefined;
  try {
    board = await harness.open({ board: "matrix", strategy, notations: [notation], zoom, ...ORIGIN });
    await measure(board, row);
  } catch (error) {
    row.status = "failed";
    row.error = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  }
  if (board) {
    row.navigations = board.navigations();
    row.problems = await board.problems().catch((error: unknown) => [String(error)]);
    await board.close().catch(() => undefined);
  }
  row.ms = Date.now() - started;
  return row;
}

const pair = (point: Point | undefined, digits = 2): string =>
  point ? `${point.x.toFixed(digits)}/${point.y.toFixed(digits)}` : "-";

function line(row: Row): string {
  return [
    row.strategy.padEnd(8),
    row.notation.padEnd(15),
    String(row.zoom).padEnd(5),
    `at ${row.zoomInEffect ?? "-"}`.padEnd(7),
    (row.element ?? "-").padEnd(20),
    `ptr ${pair(row.pointer, 0)}`.padEnd(12),
    `moved ${pair(row.moved, 1)}`.padEnd(19),
    `ratio ${pair(row.ratio)}${row.unexpected ? " !" : ""}`.padEnd(19),
    `net ${row.netScale ?? "-"}`.padEnd(11),
    `file ${row.fileChanged === undefined ? "-" : row.fileChanged ? "changed" : "SAME"}`.padEnd(13),
    `board ${row.boardSame === undefined ? "-" : row.boardSame ? "same" : "CHANGED"}`.padEnd(14),
    `err ${row.problems.length}`,
    row.status === "measured" ? "" : ` ${row.status.toUpperCase()}: ${row.error ?? ""}`,
  ].join(" ");
}

/** strategy x notation, one cell per zoom: the ratio along x and y */
function summary(rows: readonly Row[]): string {
  const cell = (row: Row | undefined): string =>
    (row?.ratio ? `${pair(row.ratio)}${row.unexpected ? "!" : ""}` : (row?.status ?? "-")).padEnd(12);
  const head = `${"strategy".padEnd(8)} ${"notation".padEnd(15)} ${zooms.map((zoom) => `zoom ${zoom}`.padEnd(12)).join(" ")} net scale`;
  const body = strategies.flatMap((strategy) =>
    notations.map((notation) => {
      const mine = zooms.map((zoom) =>
        rows.find((row) => row.strategy === strategy && row.notation === notation && row.zoom === zoom),
      );
      const net = mine.map((row) => row?.netScale ?? "-").join(" / ");
      return `${strategy.padEnd(8)} ${notation.padEnd(15)} ${mine.map(cell).join(" ")} ${net}`;
    }),
  );
  return [head, ...body].join("\n");
}

await run(async (harness) => {
  const rows: Row[] = [];
  const started = Date.now();
  for (const strategy of strategies) {
    for (const notation of notations) {
      for (const zoom of zooms) {
        const row = await one(harness, strategy, notation, zoom);
        rows.push(row);
        console.log(line(row));
        for (const problem of row.problems) console.log(`    ${problem.slice(0, 200)}`);
      }
    }
  }
  console.log(`\nelement displacement / pointer displacement (x/y), expected: naive = zoom, others = 1\n`);
  console.log(summary(rows));
  const count = (status: Row["status"]): number => rows.filter((row) => row.status === status).length;
  const withProblems = rows.filter((row) => row.problems.length > 0).length;
  const unexpected = rows.filter((row) => row.unexpected).length;
  const path = writeResult("smoke", {
    what: "board spike smoke: strategy x notation x board zoom, one drag each",
    date: new Date().toISOString(),
    chromium: harness.browser.version(),
    viewport: { width: 2200, height: 1300, deviceScaleFactor: 1 },
    travelFlowUnits: TRAVEL,
    nodeOrigin: ORIGIN,
    strategies,
    notations,
    zooms,
    rows,
  });
  console.log(
    `\n${rows.length} cases in ${Math.round((Date.now() - started) / 1000)} s: ${count("measured")} measured, ` +
      `${count("unreachable")} unreachable, ${count("failed")} failed, ${unexpected} with an unexpected ratio (!), ` +
      `${withProblems} with console errors or log lines\n${path}`,
  );
  // the harness failed, not a strategy: a case that threw, or output where none belongs
  return count("failed") + withProblems;
});
