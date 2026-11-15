/**
 * Battery "sync-view" of the board spike: what happens to an editor's VIEW and to its STATE when
 * the world around it changes. The board zooms or pans, the node moves or is resized, a peer edits
 * the same file. A check run by hand on lib.ts, not by `pnpm test` or CI.
 *
 *   PORT=5436 CACHE_DIR=<scratch>/vite-cache OUT_DIR=<scratch> node apps/web/test/spike/sync-view-chromium.ts
 *   STRATEGIES=naive,counter,overlay,iframe,plugin,shim node apps/web/test/spike/sync-view-chromium.ts (all six)
 *
 * One row per case x variant x notation x strategy x board zoom, each on a fresh page. A row says
 * what was done, what was expected and why, what was measured, and a verdict computed from the
 * numbers by the rule of its case (RULES below, repeated in the result file). The verdict is about
 * what a person at the board gets, by the SAME rule for every strategy: nothing here is keyed on a
 * strategy's name. Where a strategy's mechanics matter, a measured property decides (the host's net
 * scale, whether the node is a frame).
 *
 * Environment (comma lists):
 *   STRATEGIES   default naive,counter,overlay,iframe; plugin and shim run unchanged
 *   NOTATIONS    of bpmn, dmn, dmn-table, wardley, context-map (default all). `dmn` is the DRD,
 *                `dmn-table` the same file in its decision table (an HTML view)
 *   CASES        case names (CASES below), default all
 *   ZOOMS        replaces the board zooms of the cases whose zooms are a choice (peer-view, zoom-*, pan,
 *                node-move, arm-disarm, preview); the cases whose zooms are part of the question keep
 *                theirs (the two-editor cases at 1, extreme, sharpness, dpr2-drag)
 *   REPEAT       how often every row is measured (default 1); a row carries its repetition number
 *   CONCURRENCY  pages measured at the same time (default 5). The case that takes times (sync-edit)
 *                always runs alone, before the others
 * plus lib.ts's PORT, BASE, CACHE_DIR, OUT_DIR. Result: <OUT_DIR>/sync-view.json, sync-view.md (one
 * line per row), sync-view-folded.json (one row per case x notation x strategy, zooms folded) and
 * screenshots under <OUT_DIR>/shots.
 *
 * The exit code is 1 only for harness trouble: a row that threw for another reason than "this
 * cannot be measured here" (wrong page, not mounted, a timeout of the harness), a page that
 * navigated, or a late dependency of the dev server. What a row says about a strategy is its verdict.
 *
 * The arm rules (round 5, lib.ts's header). Arming may move the board first, so the zoom a row ASKED
 * for (`zoom`) is not always the zoom its editor runs at: every row carries `zoomInEffect`, and
 * `measured.arming` holds the viewport before and after arming and the node's rules. A case computes
 * from the zoom in effect (`ctx.zoom` once `arm()` returned) and from where the node IS, never from
 * the URL. Under armedzoom=disarm a zoom of the board makes the node a preview before its first
 * step, and a zoom while a shape is held is refused: `armedAfter` and `row.arm` (the rules' counters)
 * say which. Variant burst of the zoom cases sends what a trackpad sends, 20 wheel events a frame
 * apart with nothing read in between, and samples the picture once per animation frame.
 *
 * The verdict rules know the node's rule (round 6). zoom-label, zoom-popup and the wheel variant of
 * pan were written before the arm rules and judged an editor or popup that a board zoom closed, and
 * a node it disarmed, as a defect. They read the node's policy off the page (`board.armPolicy`).
 * Under armedzoom=disarm the specified behaviour is ok: the node a preview before the zoom's first
 * step (the rules counted the disarm, `lateDisarms` 0, `armedZoomTicks` 0), the typed text in the
 * file, the popup closed, the picture in scale. A disarm that was late, or a zoom tick under an
 * armed node, is broken there. Under armedzoom=free every rule is the one it always was. pan arms
 * the node again after its wheel probes, which disarm it by rule, before it samples. The toolbar
 * variant of zoom-plain takes as many steps as fit below the board's limit from the zoom IN EFFECT.
 *
 * The peer. Exactly one node of a board is armed, so the second editor of a file cannot take real
 * input. Its edits are a drag of script-dispatched mouse events inside its own document, preview
 * state: its engine and its binding handle them like a person's drag (PEER_DRAG). While the events
 * are dispatched, `focus()` is a no-op in that document, so the peer cannot take the keyboard focus
 * from the node under test (diagram-js focuses its canvas on a press).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { crc32, deflateSync, inflateSync } from "node:zlib";

import { HOOKS_KEY } from "../../src/board-spike/shared.ts";
import {
  aimAt,
  type ArmCounters,
  type ArmedZoom,
  type Board,
  type Box,
  centre,
  type Harness,
  KNOWN_CONSOLE,
  type ModelNotation,
  type NativeGeometry,
  type NodeHandle,
  outPath,
  type Point,
  recordEvents,
  round,
  run,
  seenEvents,
  sleep,
  STRATEGIES,
  type Strategy,
  type Viewport,
  writeResult,
} from "./lib.ts";

type NativeWindow = Window & { __boardSpikeNative?: NativeGeometry };

// ── environment ──────────────────────────────────────────────────────────────

const words = (name: string): string[] => (process.env[name] ?? "").split(",").filter(Boolean);
const strategies: Strategy[] = (() => {
  const wanted = words("STRATEGIES");
  const all: readonly Strategy[] = STRATEGIES;
  return wanted.length === 0
    ? (["naive", "counter", "overlay", "iframe"] satisfies Strategy[])
    : all.filter((one) => wanted.includes(one));
})();
const zoomsOverride = words("ZOOMS").map(Number).filter(Boolean);
const caseFilter = words("CASES");
const repeat = Math.max(1, Number(process.env.REPEAT ?? 1) || 1);
const concurrency = Math.max(1, Number(process.env.CONCURRENCY ?? 5) || 1);

/** where a node's top-left corner sits in the canvas: clear of the toolbar */
const ORIGIN: Point = { x: 60, y: 80 };
/** a point of the bare pane left of a node at ORIGIN: the pivot of every wheel zoom, so the node stays in the window */
const PIVOT: Point = { x: 30.5, y: 70.5 };
/** the board zooms of the cases that have no zooms of their own: 1, an odd one below and one above */
const BOARD_ZOOMS: readonly number[] = [1, 0.8137, 1.37];
/** the odd zoom the single-zoom cases run at: no round number hides a rounding there */
const ODD_ZOOM = 0.8137;
/** what a label editor gets typed into it */
const TYPED = "XYZ";
const ALLOWED = [KNOWN_CONSOLE.padDeprecation, KNOWN_CONSOLE.feelEditor];
/** how long a step may take to show (an editor opens, a node arms): the machine may be busy with other runs */
const WAIT = 4000;
/** how long a peer's edit may take to show on another canvas: the binding's 350 to 600 ms and a busy machine */
const ARRIVAL = 6000;

// ── the rules ────────────────────────────────────────────────────────────────

/** a picture that moved less than this on screen did not move for a person (device pixel snapping is 0.5 px) */
const PX_STILL = 0.75;
/** above this a jump is seen at once */
const PX_JUMP = 3;
/** the diagram's on-screen scale may be this far from the board's (relative) and still be "in scale" */
const SCALE_SLACK = 0.005;
/** engines round a move to whole diagram units: that much, on each side, may be missing */
const UNIT_SLACK = 1.5;
/** how a rule that predates the arm rules reads where the node's own rule disarms on a board zoom */
const BY_RULE =
  "Under armedzoom=disarm (read off the page per node) the zoom makes the node a preview before its first step, which is specified and no defect when the rules counted the disarm, lateDisarms is 0 and armedZoomTicks is 0 (a late disarm or a zoom tick under an armed node: broken). Then";

const RULES: Readonly<Record<string, string>> = {
  "sync-edit": `ok: the file at the hub and every other node's canvas have the edit, the receivers' element within ${UNIT_SLACK} units of the sender's, all texts equal. wrong-data: a receiver or the file differs after 6 s. broken: the edit never left the sender.`,
  "sync-both": `ok: both edits are in the file and on both canvases, each once (positions equal on both canvases within ${UNIT_SLACK} units), no conflict notice. degraded: one edit was undone with a conflict notice. wrong-data: the canvases or texts differ in the end, or an edit is gone without a notice.`,
  "busy-drag": `ok: the held shape lands where the pointer went (within ${UNIT_SLACK} units + the grid), the peer's edit is on the canvas afterwards, the file holds both. degraded: the drop was undone (with a conflict notice) or the drag was cancelled. wrong-data: the texts or canvases differ in the end, or the move landed elsewhere.`,
  "busy-label":
    "ok: the typed text is still in the open editor after the peer's edit arrived. degraded: the editor closed but the text is in the file. broken: the typed text is gone (neither in an editor nor in the file after the commit key).",
  "busy-popup":
    "ok: the popup is still open after the peer's edit arrived. degraded: it closed (the person opens it again).",
  "busy-select": "ok: the selection is kept. degraded: it is gone (the person selects again).",
  "peer-view": `ok: the visible diagram rectangle moved less than ${PX_STILL} px on screen after the peer's edit, armed and in preview. degraded: up to ${PX_JUMP} px. broken: more.`,
  "zoom-plain": `ok: after the steps in and back the rectangle is within ${PX_STILL} px of the start and the diagram's on-screen scale stayed within ${SCALE_SLACK * 100} % of the board's at every step. degraded: up to ${PX_JUMP} px or 2 %. broken: more.`,
  "zoom-label": `ok: the editor stays open with its text through all steps, the text is in the file after the commit key, and the picture stayed in scale (${SCALE_SLACK * 100} %). degraded: the text is kept (editor or file) but the picture was out of scale meanwhile or the editor closed. broken: the typed text is gone. ${BY_RULE} ok: the editor closed with the disarm at the first step, the typed text is in the file with no commit key, and the picture stayed in scale.`,
  "zoom-popup": `ok: the popup stays open, ends within ${PX_JUMP} px of where it was against its element, and the picture stayed in scale. degraded: it closed, or it stayed at the price of a picture out of scale. broken: it stayed open and ended more than ${PX_JUMP} px off. ${BY_RULE} ok: the popup closed with the disarm at the first step and the picture stayed in scale. broken also: the popup outlived the disarm.`,
  burst: `Variant burst of zoom-plain, zoom-label and zoom-popup: the case's own rule, with every animation frame of the burst in place of the single steps. The board is not zoomed back, so the popup's end place is not judged. Reported beside it: whether the node showed as armed in a frame at another board zoom than it was armed at. Under armedzoom=disarm that count is part of the rule: ok needs 0 such frames.`,
  "zoom-drag": `ok: the drop lands where the pointer went (within ${UNIT_SLACK} units + the grid) and the picture stayed in scale. degraded: it lands right but the picture was out of scale while the shape was held. broken: the drag was lost or landed elsewhere. Variant hook-stay (the drop at another board zoom than the press): "where the pointer went" is the point of the diagram under the pointer in the picture as it was drawn at the release, from the browser's matrix; degraded also when the shape's grabbed point lies more than ${PX_JUMP} px from the resting pointer once the picture has settled.`,
  pan: `ok: the editor's host stays within ${PX_STILL} px of the node body in every sampled frame, and the node stays armed. degraded: up to ${PX_JUMP} px. broken: more, or the node was disarmed. ${BY_RULE} the wheel variant is a zoom on this board, so the node is a preview from its first notch: ok, degraded and broken by the gap alone, sampled from the armed node through the disarm.`,
  "node-move": `ok: the host stays within ${PX_STILL} px of the node body during and after, the rectangle's origin and the scale are unchanged, and after the resize every palette entry lies inside the host. degraded: the palette is cut, or a gap up to ${PX_JUMP} px. broken: a larger gap, or the view jumped.`,
  "arm-disarm": `ok: arming and disarming move the picture less than ${PX_STILL} px, the typed label is in the file after the disarm, nothing stays selected or open. degraded: up to ${PX_JUMP} px, or a selection or an editor stays. broken: more, or the typed text is gone.`,
  extreme: `ok: a double-click arms the node, a drag moves a shape with the pointer (ratio within 5 % of 1 beyond the unit rounding), and one Control + wheel step changes the diagram's scale by no more than 1.4. degraded: editing works but the wheel step jumps (the engine's 0.2 to 4 limit) or no element is free of chrome. broken: the drag does not follow the pointer or the node cannot be armed.`,
  preview:
    "ok: a click, a key and a wheel on the unarmed node reach the board and change nothing in the model, no editing chrome is shown, and at most 0.5 % of the diagram's pixels differ from the armed picture. degraded: up to 3 % differ, or chrome shows. broken: the editor took input.",
  sharpness:
    "ok: the label's glyph edges are as narrow as in the sharpest strategy of the same zoom and device pixel ratio (mean grey run within 0.3 px). degraded: wider (a scaled bitmap). The rule needs the other strategies: it is applied after the run.",
  "dpr2-drag":
    "ok: at device pixel ratio 2 the shape follows the pointer (ratio within 5 % of 1 beyond the unit rounding). broken: it does not.",
};

// ── notations ────────────────────────────────────────────────────────────────

const KIT_IDS = ["bpmn", "dmn", "dmn-table", "wardley", "context-map"] as const;
type KitId = (typeof KIT_IDS)[number];

/**
 * What a case needs to know of a notation. wardley and context-map are the two Miragon renderers:
 * Wardley holds its view to a pan constraint of its own, has an own text field as label editor and
 * a text file that rounds coordinates; Context Map is JSON, uses diagram-js's direct editing and is
 * the one renderer with a fixed prompt inside its container.
 */
interface Kit {
  id: KitId;
  notation: ModelNotation;
  /** the DMN decision table is HTML: no viewbox, no shapes */
  table: boolean;
  /** elements a plain drag moves, in order of preference */
  drag: readonly string[];
  /** what the peer moves: never one of `drag`, never `label` */
  peer: string;
  /** the elements whose label editor, context pad and popup are used, in order of preference */
  label: readonly string[];
  /** the pad entry that opens a popup menu */
  popup: string;
  /** the open label editor */
  editor: string;
  /** where to press on an element (default: its middle) */
  grab?(box: Box): Point;
  /** bpmn-js and the DRD snap a move to a 10 unit grid; Control, pressed after the button, switches that off */
  hold: readonly string[];
  /** units a move may be off beyond the rounding: the engine's grid where Control does not switch it off */
  grid: number;
}

const circle = (box: Box): Point => ({ x: box.x + box.height / 2, y: box.y + box.height / 2 });
/** the cell the table cases type into, and the cell editor it shows while it has the focus */
const CELL = 'td[data-element-id="UnaryTests_blocked_value"]';

const KITS: Readonly<Record<KitId, Kit>> = {
  bpmn: {
    id: "bpmn",
    notation: "bpmn",
    table: false,
    drag: ["Task_validate_order", "Task_check_credit", "Task_fulfill_order"],
    peer: "Task_reject_order",
    label: ["Task_check_credit", "Task_fulfill_order", "Task_validate_order"],
    popup: "replace",
    editor: ".djs-direct-editing-content",
    hold: ["Control"],
    grid: 0,
  },
  dmn: {
    id: "dmn",
    notation: "dmn",
    table: false,
    drag: ["InputData_segment", "InputData_order_value"],
    peer: "InputData_overdue",
    label: ["credit-limit-check", "InputData_order_value"],
    popup: "replace",
    editor: ".djs-direct-editing-content",
    hold: ["Control"],
    grid: 0,
  },
  "dmn-table": {
    id: "dmn-table",
    notation: "dmn",
    table: true,
    drag: [],
    peer: "InputData_overdue",
    label: [],
    popup: "",
    editor: `${CELL} .cm-content`,
    hold: [],
    grid: 0,
  },
  wardley: {
    id: "wardley",
    notation: "wardley",
    table: false,
    drag: ["cmp_cup", "cmp_tea", "cmp_hot_water"],
    peer: "cmp_power",
    label: ["cmp_tea", "cmp_cup", "cmp_hot_water"],
    popup: "settings",
    editor: "textarea.wardley-label-input",
    grab: circle,
    hold: [],
    grid: 1,
  },
  "context-map": {
    id: "context-map",
    notation: "context-map",
    table: false,
    drag: ["ctx_ordering", "ctx_catalog"],
    peer: "ctx_payment",
    label: ["ctx_ordering", "ctx_catalog", "ctx_shipping"],
    popup: "subdomain-type",
    editor: ".djs-direct-editing-content",
    hold: [],
    grid: 1,
  },
};

/** the compare board shows another BPMN file than the stress and the matrix board */
const COMPARE_KIT: Kit = {
  ...KITS.bpmn,
  drag: ["Task_create_invoice", "Task_send_invoice"],
  peer: "Task_send_reminder",
  label: ["Task_send_invoice", "Task_create_invoice"],
};

const kits: Kit[] = (() => {
  const wanted = words("NOTATIONS");
  return KIT_IDS.filter((id) => wanted.length === 0 || wanted.includes(id)).map((id) => KITS[id]);
})();
const DIAGRAMS: readonly KitId[] = ["bpmn", "dmn", "wardley", "context-map"];

// ── rows ─────────────────────────────────────────────────────────────────────

type Verdict = "ok" | "degraded" | "broken" | "wrong-data" | "unmeasured";
const RANK: readonly Verdict[] = ["ok", "degraded", "broken", "wrong-data"];
const worst = (...verdicts: Verdict[]): Verdict =>
  verdicts.reduce((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a), "ok");

interface Row {
  case: string;
  variant: string;
  notation: KitId;
  strategy: Strategy;
  /** the board zoom the row asked for (the URL's) */
  zoom: number;
  /** the board zoom in effect once the node was armed (the arm rules may move the board); `zoom` for a row that arms nothing */
  zoomInEffect?: number;
  /** what the arm rules did on the row's first board: moves, disarms before a zoom, refused zooms */
  arm?: ArmCounters;
  rep: number;
  did: string;
  expected: string;
  measured: Record<string, unknown>;
  verdict: Verdict;
  /** the numbers the rule decided on, in a sentence */
  why: string;
  /** the measured quantity in a few characters, for the folded table */
  short: string;
  /** the case could not run here: the reason */
  unmeasured?: string;
  /** the harness failed, not a strategy */
  harness?: string;
  /** console errors, page errors and lines of the page's log (the known noise filtered) */
  problems: string[];
  shots: string[];
  ms: number;
  /** the machine's one-minute load average when the row ended: times of a row measured under load are longer */
  load: number;
}

interface Outcome {
  verdict: Verdict;
  why: string;
  short: string;
}

/** thrown by a case for "this cannot be measured here": a row with the reason, no harness failure */
class Unmeasured extends Error {}

interface Ctx {
  harness: Harness;
  strategy: Strategy;
  kit: Kit;
  /** the board zoom asked for; once `arm()` or `noteArming()` ran, the board zoom IN EFFECT */
  zoom: number;
  variant: string;
  /** what the case measured so far: kept when it ends early */
  m: Record<string, unknown>;
  shots: string[];
  boards: Board[];
  tag: string;
}

interface CaseDef {
  name: string;
  did: string;
  expected: string;
  kits: readonly KitId[];
  variants(kit: Kit): readonly string[];
  /** its board zooms; `fixed` zooms are not replaced by ZOOMS */
  zooms(variant: string): readonly number[];
  fixedZooms?: boolean;
  /** takes times: never beside another page */
  serial?: boolean;
  run(ctx: Ctx): Promise<Outcome>;
}

// ── in the page ──────────────────────────────────────────────────────────────

const frames = (board: Board, count = 2): Promise<void> =>
  board.page.evaluate(
    (left) =>
      new Promise<void>((resolve) => {
        const step = (n: number): void => void (n === 0 ? resolve() : requestAnimationFrame(() => step(n - 1)));
        step(left);
      }),
    count,
  );

/** the client rect of the node's body (`.board-node__body`) in the board page, from the browser's own function */
const bodyBox = (board: Board, nodeId: string): Promise<Box | null> =>
  board.page.evaluate((id) => {
    const body = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"] .board-node__body`);
    if (!body) return null;
    const native = (window as NativeWindow).__boardSpikeNative;
    const { x, y, width, height } = native ? native.rect(body) : body.getBoundingClientRect();
    return { x, y, width, height };
  }, nodeId);

const topElementAt = (board: Board, at: Point): Promise<string> =>
  board.page.evaluate(({ x, y }) => {
    const native = (window as NativeWindow).__boardSpikeNative;
    const element = native ? native.elementFromPoint(document, x, y) : document.elementFromPoint(x, y);
    return element ? `${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "").split(" ")[0]}` : "";
  }, at);

/** the middle of a toolbar button, by its accessible name */
async function toolbarButton(board: Board, label: string): Promise<Point> {
  const at = await board.page.evaluate((name) => {
    const button = document.querySelector(`.board-toolbar button[aria-label="${name}"]`);
    if (!button) return null;
    const native = (window as NativeWindow).__boardSpikeNative;
    const rect = native ? native.rect(button) : button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, label);
  if (!at) throw new Error(`no toolbar button "${label}"`);
  return at;
}

/** the visible diagram rectangle of one editor: which part of its model the host shows, in the model's own units */
interface View {
  /** an HTML view (the decision table): the units are layout px of the table */
  html: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** screen px per unit */
  unitPx: number;
  /** scroll offsets of the table's own scroll box */
  scroll: Point | null;
}

/**
 * Runs in the node's document. A diagram: the host's client rect through the inverse of
 * `g.viewport`'s screen matrix, both from the browser's own functions, so no engine is asked and no
 * rounding getter is read. A table: the host's rect against the table element's, in the table's
 * layout px.
 */
const READ_VIEW = (host: HTMLElement): (Omit<View, "unitPx"> & { unit: number }) | null => {
  const native = (window as NativeWindow).__boardSpikeNative;
  const rect = (element: Element): DOMRect => (native ? native.rect(element) : element.getBoundingClientRect());
  const box = rect(host);
  const viewport = host.querySelector<SVGGElement>("svg g.viewport");
  if (viewport) {
    const matrix = native ? native.screenCTM(viewport) : viewport.getScreenCTM();
    if (!matrix || !(matrix.a > 0)) return null;
    return {
      html: false,
      x: (box.x - matrix.e) / matrix.a,
      y: (box.y - matrix.f) / matrix.d,
      width: box.width / matrix.a,
      height: box.height / matrix.d,
      unit: matrix.a,
      scroll: null,
    };
  }
  const table = host.querySelector<HTMLElement>("table");
  if (!table || !(table.offsetWidth > 0)) return null;
  const tableBox = rect(table);
  const unit = tableBox.width / table.offsetWidth;
  const scroller = host.querySelector(".tjs-table-container");
  return {
    html: true,
    x: (box.x - tableBox.x) / unit,
    y: (box.y - tableBox.y) / unit,
    width: box.width / unit,
    height: box.height / unit,
    unit,
    scroll: scroller ? { x: scroller.scrollLeft, y: scroller.scrollTop } : null,
  };
};

async function viewOf(node: NodeHandle): Promise<View> {
  const [map, raw] = [await node.map(), await node.inDocument(READ_VIEW)];
  if (!raw) throw new Unmeasured("the editor shows neither a diagram nor a table");
  const { unit, ...rest } = raw;
  return { ...rest, unitPx: unit * map.sx };
}

interface Drift {
  /** how far the rectangle's origin moved, in units and in screen px of the later view */
  units: number;
  px: number;
  /** change of the rectangle's size, in units */
  size: number;
  /** later scale over earlier scale */
  scale: number;
}
function drift(from: View, to: View): Drift {
  const units = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  return {
    units: round(units, 3),
    px: round(units * to.unitPx, 2),
    size: round(Math.max(Math.abs(to.width - from.width), Math.abs(to.height - from.height)), 3),
    scale: round(to.unitPx / from.unitPx, 5),
  };
}
const shortView = (view: View): string =>
  `${round(view.x, 1)},${round(view.y, 1)} ${round(view.width, 1)}x${round(view.height, 1)}`;
const flatView = (view: View): Record<string, unknown> => ({
  rect: { x: round(view.x, 3), y: round(view.y, 3), width: round(view.width, 3), height: round(view.height, 3) },
  unitPx: round(view.unitPx, 5),
  ...(view.html ? { html: true, scroll: view.scroll } : {}),
});

/** what a case reads of the editor's state */
interface EditorState {
  /** the label editor (the table: the cell editor) is shown */
  editor: boolean;
  text: string | null;
  /** the document's focus is in it */
  focused: boolean;
  popup: boolean;
  pad: boolean;
  selected: string[];
  /** diagram-js draws a drag preview */
  dragging: boolean;
  active: string;
}

/** runs in the node's document; `node` is the node's id in the board page, null in a frame */
const READ_STATE = (host: HTMLElement, arg: { editor: string; node: string | null }): EditorState => {
  const native = (window as NativeWindow).__boardSpikeNative;
  const popupHost =
    arg.node === null
      ? undefined
      : [...document.querySelectorAll<HTMLElement>(".board-popup-host")].find((one) => one.dataset.node === arg.node);
  const roots: Element[] = popupHost ? [host, popupHost] : [host];
  const shown = (element: Element): boolean => {
    const rect = native ? native.rect(element) : element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
  };
  const find = (selector: string): Element | undefined =>
    roots.flatMap((root) => [...root.querySelectorAll(selector)]).find(shown);
  const editor = find(arg.editor);
  const text = !editor
    ? null
    : editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement
      ? editor.value
      : (editor.textContent ?? "");
  const active = document.activeElement;
  return {
    editor: !!editor,
    text,
    focused: !!editor && !!active && editor.contains(active),
    popup: !!find(".djs-popup"),
    pad: !!find(".djs-context-pad.open"),
    selected: [...host.querySelectorAll(".djs-element.selected[data-element-id]")].map(
      (element) => element.getAttribute("data-element-id") ?? "",
    ),
    dragging: host.querySelector(".djs-dragger") !== null,
    active: active ? `${active.tagName.toLowerCase()}.${(active.getAttribute("class") ?? "").split(" ")[0]}` : "none",
  };
};
const stateOf = (node: NodeHandle, kit: Kit): Promise<EditorState> =>
  node.inDocument(READ_STATE, { editor: kit.editor, node: node.frame ? null : node.id });

/** a shape's place in diagram units, from its `transform`; a table cell's text */
interface Mark {
  selector: string;
  attribute: string | null;
}
const shapeMark = (element: string): Mark => ({ selector: `[data-element-id="${element}"]`, attribute: "transform" });
const CELL_MARK: Mark = { selector: CELL, attribute: null };
const READ_MARK = (host: HTMLElement, mark: Mark): string | null => {
  const element = host.querySelector(mark.selector);
  if (!element) return null;
  return mark.attribute === null ? (element.textContent ?? "") : element.getAttribute(mark.attribute);
};
const markOf = (node: NodeHandle, mark: Mark): Promise<string | null> => node.inDocument(READ_MARK, mark);
/** `matrix(1 0 0 1 x y)` */
function placeOf(transform: string | null): Point | null {
  const numbers = /matrix\(([^)]+)\)/
    .exec(transform ?? "")?.[1]
    ?.split(/[\s,]+/)
    .map(Number);
  return numbers?.length === 6 ? { x: numbers[4]!, y: numbers[5]! } : null;
}
const apart = (a: Point | null, b: Point | null): number =>
  a && b ? round(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)), 3) : Number.NaN;

/**
 * Runs in the node's document: remembers when the mark first differs from what it is now (epoch
 * ms, from this document's clock). A MutationObserver: its callback runs right after the change.
 */
const WATCH_MARK = (host: HTMLElement, arg: { mark: Mark; key: string }): void => {
  const read = (): string | null => {
    const element = host.querySelector(arg.mark.selector);
    if (!element) return null;
    return arg.mark.attribute === null ? (element.textContent ?? "") : element.getAttribute(arg.mark.attribute);
  };
  const first = read();
  const state: { changedAt: number | null } = { changedAt: null };
  const observer = new MutationObserver(() => {
    if (read() === first) return;
    state.changedAt = performance.timeOrigin + performance.now();
    observer.disconnect();
  });
  observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
  (window as unknown as Record<string, unknown>)[arg.key] = state;
};
const READ_WATCH = (_host: HTMLElement, key: string): number | null =>
  ((window as unknown as Record<string, { changedAt: number | null } | undefined>)[key] ?? { changedAt: null })
    .changedAt;

/** in the board page: remembers when the hub's copy of the file first differs from what it is now (polled, 4 ms) */
const watchHub = (board: Board, path: string): Promise<void> =>
  board.page.evaluate(
    ([key, file]) => {
      const page = window as unknown as Record<string, { fileText(path: string): string | undefined }> & {
        __hubWatch?: { changedAt: number | null };
      };
      const hooks = page[key]!;
      const first = hooks.fileText(file);
      const state: { changedAt: number | null } = { changedAt: null };
      const until = performance.now() + 15_000;
      const tick = (): void => {
        if (hooks.fileText(file) !== first) state.changedAt = performance.timeOrigin + performance.now();
        else if (performance.now() < until) setTimeout(tick, 0);
      };
      tick();
      page.__hubWatch = state;
    },
    [HOOKS_KEY, path] as const,
  );
const hubChangedAt = (board: Board): Promise<number | null> =>
  board.page.evaluate(
    () => (window as unknown as { __hubWatch?: { changedAt: number | null } }).__hubWatch?.changedAt ?? null,
  );

interface PeerDrag {
  ok: boolean;
  why: string;
  before: string | null;
  after: string | null;
  /** epoch ms of the release */
  at: number;
}

/**
 * Runs in the PEER's document: a drag of script-dispatched mouse events on one shape, by `dx, dy`
 * px of that document. The node is not armed and needs no pointer of the page. While the events
 * are dispatched `focus()` does nothing in this document: diagram-js focuses its canvas on a
 * press, and the peer must not take the focus from the node under test.
 */
const PEER_DRAG = (host: HTMLElement, arg: { id: string; dx: number; dy: number; left: boolean }): PeerDrag => {
  const native = (window as NativeWindow).__boardSpikeNative;
  const gfx = host.querySelector(`[data-element-id="${CSS.escape(arg.id)}"]`);
  const visual = gfx?.querySelector(":scope > .djs-visual");
  const target = gfx?.querySelector(":scope > .djs-hit") ?? visual;
  const now = (): number => performance.timeOrigin + performance.now();
  if (!gfx || !visual || !target) return { ok: false, why: `no shape ${arg.id}`, before: null, after: null, at: now() };
  const rect = native ? native.rect(visual) : visual.getBoundingClientRect();
  const x = arg.left ? rect.x + rect.height / 2 : rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const fire = (to: EventTarget, type: string, clientX: number, clientY: number, held: boolean): void =>
    void to.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        button: 0,
        buttons: type === "mouseup" ? 0 : 1,
        // after the press, as a person holds it: no grid snapping in bpmn-js and the DRD
        ctrlKey: held,
      }),
    );
  const before = gfx.getAttribute("transform");
  const prototypes = [HTMLElement.prototype, SVGElement.prototype];
  const saved = prototypes.map((prototype) => Object.getOwnPropertyDescriptor(prototype, "focus"));
  for (const prototype of prototypes) {
    Object.defineProperty(prototype, "focus", { configurable: true, writable: true, value: () => undefined });
  }
  try {
    fire(target, "mousedown", x, y, false);
    for (let step = 1; step <= 8; step++) {
      fire(document, "mousemove", x + (arg.dx * step) / 8, y + (arg.dy * step) / 8, true);
    }
    fire(document, "mouseup", x + arg.dx, y + arg.dy, true);
  } finally {
    prototypes.forEach((prototype, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(prototype, "focus", descriptor);
    });
  }
  const after = host.querySelector(`[data-element-id="${CSS.escape(arg.id)}"]`)?.getAttribute("transform") ?? null;
  return { ok: after !== before, why: after !== before ? "" : "the shape did not move", before, after, at: now() };
};

interface DiagramApi {
  get(service: "elementRegistry"): { get(id: string): object | undefined };
  get(service: "modeling"): { moveElements(shapes: object[], delta: Point): void };
}

/**
 * The peer's edit: one shape moves. A peer in the board page has its engine handle there
 * (`hooks.engine`), and the move goes through its diagram's own `modeling` service, by `dx, dy`
 * diagram units: no event touches the document, which the node under test shares (a second drag of
 * dispatched events would end ITS held drag too, both engines listen on the document). A peer in a
 * frame has no handle: there the drag of dispatched events runs, in a document of its own. Either
 * way the peer's binding sees a canvas edit. Throws Unmeasured when the engine refuses the move.
 */
async function peerEdit(peer: NodeHandle, kit: Kit, dx = 30, dy = 20): Promise<PeerDrag> {
  const result = peer.frame
    ? await peer.inDocument(PEER_DRAG, { id: kit.peer, dx, dy, left: !!kit.grab })
    : await peer.board.page.evaluate(
        ([key, node, id, x, y]): PeerDrag => {
          const now = (): number => performance.timeOrigin + performance.now();
          const hooks = (window as unknown as Record<string, { engine(id: string): unknown } | undefined>)[key];
          const runtime = hooks?.engine(node) as
            { host: HTMLElement; engine: { diagram(): DiagramApi | undefined } | null } | undefined;
          const diagram = runtime?.engine?.diagram();
          const shape = diagram?.get("elementRegistry").get(id);
          const read = (): string | null =>
            runtime?.host.querySelector(`[data-element-id="${CSS.escape(id)}"]`)?.getAttribute("transform") ?? null;
          const before = read();
          if (!diagram || !shape)
            return { ok: false, why: `no engine handle or no shape ${id}`, before, after: before, at: now() };
          diagram.get("modeling").moveElements([shape], { x, y });
          const after = read();
          return {
            ok: after !== before,
            why: after !== before ? "" : "the shape did not move",
            before,
            after,
            at: now(),
          };
        },
        [HOOKS_KEY, peer.id, kit.peer, dx, dy] as const,
      );
  if (!result.ok) throw new Unmeasured(`the peer's edit did not happen: ${result.why}`);
  return result;
}

/** the DRD's own button on the decision, clicked by script: the table opens in a node of any state */
async function openTable(node: NodeHandle): Promise<void> {
  const clicked = await node.inDocument((host) => {
    const button = host.querySelector<HTMLElement>(".drill-down-overlay button");
    button?.click();
    return !!button;
  });
  const shown =
    clicked && (await node.board.waitFor(() => node.inDocument((host) => !!host.querySelector("table")), WAIT));
  if (!shown) throw new Error(`${node.id}: the decision table did not open`);
  await sleep(150);
}

/** the first candidate that takes a press at its grab point; throws Unmeasured with what covers the others */
async function pick(
  node: NodeHandle,
  kit: Kit,
  candidates: readonly string[],
): Promise<{ element: string; box: Box; grab: Point; covered: string[] }> {
  const covered: string[] = [];
  for (const element of candidates) {
    const box = await node.elementBox(element);
    if (!box) {
      covered.push(`${element}: not drawn`);
      continue;
    }
    const grab = aimAt(await node.map(), (kit.grab ?? centre)(box));
    const hit = await node.hit(grab);
    if (hit.reachable && hit.element === element) return { element, box, grab, covered };
    covered.push(`${element}: ${hit.reachable ? hit.what.slice(0, 50) : "outside the editor"}`);
  }
  throw new Unmeasured(`no element takes a press (${covered.join("; ")})`);
}

/** the part of `box` inside `within`, null when there is none */
function clip(box: Box, within: Box): Box | null {
  const x = Math.max(box.x, within.x);
  const y = Math.max(box.y, within.y);
  const right = Math.min(box.x + box.width, within.x + within.width);
  const bottom = Math.min(box.y + box.height, within.y + within.height);
  return right - x > 2 && bottom - y > 2 ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * Opens the label editor (the table: the cell editor) and types TYPED into it, as a person does:
 * a double-click on the element, a click on the cell. Returns the element.
 */
async function typeLabel(board: Board, node: NodeHandle, kit: Kit): Promise<string> {
  if (kit.table) {
    const [host, cell] = [await node.hostBox(), (await node.query(CELL))[0]];
    const visible = cell && clip(cell, host);
    const at = visible && centre(visible);
    const hit = at && (await node.hit(at));
    if (!at || !hit?.reachable || hit.what.startsWith("div.input-label") || hit.what.startsWith("th")) {
      throw new Unmeasured(
        `the table cell cannot be pressed: ${cell ? `its box ${Math.round(cell.y - host.y)} px below the host's top, host ${Math.round(host.height)} px high, on top there: ${hit?.what ?? "nothing"}` : "not rendered"}`,
      );
    }
    await board.click(at);
    await board.waitFor(async () => (await stateOf(node, kit)).editor, WAIT);
    await board.type(TYPED);
    return CELL;
  }
  const { element, grab } = await pick(node, kit, kit.label);
  await board.doubleClick(grab);
  const open = await board.waitFor(async () => (await stateOf(node, kit)).editor, WAIT);
  if (!open) throw new Unmeasured(`a double-click on ${element} opened no label editor`);
  await board.type(TYPED);
  return element;
}

/** selects an element and opens the popup menu of its pad; returns the element and the popup's box */
async function openPopup(board: Board, node: NodeHandle, kit: Kit): Promise<{ element: string; popup: Box }> {
  const { element, grab } = await pick(node, kit, kit.label);
  await board.click(grab);
  const entry = await board.waitForBox(
    async () => (await node.query(`.djs-context-pad.open .entry[data-action="${kit.popup}"]`))[0],
  );
  if (!entry) throw new Unmeasured(`no pad entry "${kit.popup}" for ${element}`);
  const at = centre(entry);
  const hit = await node.hit(at);
  if (!hit.reachable || !hit.pad) throw new Unmeasured(`the pad entry "${kit.popup}" is covered by ${hit.what}`);
  await board.click(at);
  const first = await board.waitForBox(async () => (await node.query(".djs-popup"))[0], WAIT);
  if (!first) throw new Unmeasured(`the pad entry "${kit.popup}" opened no popup`);
  // Placed twice: after its first render diagram-js moves the popup into view (4 px were measured
  // between the two). Two equal reads 50 ms apart can both be the first place on a busy machine
  await sleep(400);
  const popup = (await board.waitForBox(async () => (await node.query(".djs-popup"))[0], WAIT)) ?? first;
  return { element, popup };
}

/** ends a label edit as a person does: Enter; what a renderer's text field wants may differ, so the row says what closed it */
async function commitLabel(board: Board, node: NodeHandle, kit: Kit): Promise<string> {
  if (!(await stateOf(node, kit)).editor) return "nothing to commit";
  for (const key of kit.table ? ["Tab"] : ["Enter", "Control+Enter", "Tab"]) {
    await board.press(key);
    const closed = await board.waitFor(async () => !(await stateOf(node, kit)).editor, 1500);
    if (closed) return key;
  }
  return "still open";
}

// ── boards ───────────────────────────────────────────────────────────────────

async function open(ctx: Ctx, ...args: Parameters<Harness["open"]>): Promise<Board> {
  const board = await ctx.harness.open(...args);
  ctx.boards.push(board);
  return board;
}

/** the pane point a board's wheel zooms about: PIVOT unless arming put the node over it */
const pivots = new WeakMap<Board, Point>();
const pivotOf = (board: Board): Point => pivots.get(board) ?? PIVOT;
const PANE = "div.react-flow__pane";
const flatViewport = (viewport: Viewport): Viewport => ({
  x: round(viewport.x, 2),
  y: round(viewport.y, 2),
  zoom: round(viewport.zoom, 4),
});
const sameViewport = (a: Viewport, b: Viewport): boolean => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

/**
 * What the arm rules did when `nodeId` was armed, read off the page: the viewport before and after
 * (the rules may move the board first), the node's rules, whether it is armed. From here on
 * `ctx.zoom` is the board zoom IN EFFECT; the row keeps the zoom it asked for. Where the node now
 * lies over PIVOT, the wheel's pivot becomes a point of the bare pane just above or beside the node.
 */
async function noteArming(ctx: Ctx, board: Board, nodeId: string, before: Viewport): Promise<Viewport> {
  const [after, policy, state, last] = [
    await board.viewport(),
    await board.armPolicy(nodeId),
    await board.armState(),
    await board.lastTransition(),
  ];
  const moved = !sameViewport(before, after);
  ctx.zoom = after.zoom;
  const arming: Record<string, unknown> = {
    rules: policy ? `${policy.armzoom}/${policy.armedzoom}/${policy.armreturn}` : null,
    zoomAsked: round(before.zoom, 4),
    zoomInEffect: round(after.zoom, 4),
    viewportBefore: flatViewport(before),
    viewportArmed: flatViewport(after),
    boardMoved: moved,
    // a time, taken beside other pages: never compared between runs
    moveMsUnderLoad: moved && last ? Math.round(last.measuredMs) : null,
    armed: state.armed === nodeId,
  };
  ctx.m.arming = arming;
  if ((await topElementAt(board, PIVOT)) !== PANE) {
    const [canvas, box] = [await board.canvasBox(), await board.nodeBox(nodeId)];
    const tries: Point[] = box
      ? [
          { x: Math.round(box.x) + 6.5, y: Math.round(box.y) - 8.5 },
          { x: Math.round(box.x) - 8.5, y: Math.round(box.y) + 6.5 },
          { x: Math.round(box.x + box.width) + 8.5, y: Math.round(box.y) + 6.5 },
          { x: Math.round(box.x) + 6.5, y: Math.round(box.y + box.height) + 8.5 },
        ]
      : [];
    for (const at of tries) {
      const inCanvas = at.x > canvas.x && at.y > canvas.y && at.x < canvas.x + canvas.width;
      if (inCanvas && at.y < canvas.y + canvas.height && (await topElementAt(board, at)) === PANE) {
        pivots.set(board, at);
        break;
      }
    }
    arming.pivot =
      pivots.get(board) ?? `PIVOT is under ${await topElementAt(board, PIVOT)} and no pane point was found`;
  }
  return after;
}

/** arms through the hook, as every case did, and notes what the arm rules made of it; returns the viewport in effect */
async function arm(ctx: Ctx, board: Board, nodeId: string): Promise<Viewport> {
  const before = await board.viewport();
  await board.arm(nodeId);
  return noteArming(ctx, board, nodeId, before);
}

// ── the node's rule in a verdict ─────────────────────────────────────────────

/** before a zoom gesture: what the node's rule says a board zoom does while it is armed, and the rules' counters */
interface ZoomRule {
  /** the node's armedzoom, read off the page (hooks.armPolicy); null on a board without the rules */
  armedzoom: ArmedZoom | null;
  counters: ArmCounters;
}
const zoomRuleOf = async (board: Board, nodeId: string): Promise<ZoomRule> => ({
  armedzoom: (await board.armPolicy(nodeId))?.armedzoom ?? null,
  counters: (await board.counters()).arm,
});

/**
 * After the gesture: did the node's own rule make it a preview, and as the rule specifies? Under
 * armedzoom=disarm a board zoom disarms the node BEFORE its first step: counted before the zoom
 * for a gesture the board sees coming (wheel, toolbar), inside the first tick for a script's zoom.
 * `lateDisarms` and `armedZoomTicks` are the rules' own proof that no armed editor saw a zoom
 * step: both stay 0. Under free and lock `byRule` is false and a case keeps the rule it had.
 */
interface RuleDisarm {
  armedzoom: ArmedZoom | null;
  /** armedzoom=disarm and the node is a preview now */
  byRule: boolean;
  /** byRule, the rules counted a disarm during the gesture, none was late, no zoom tick passed under an armed node */
  asSpecified: boolean;
  /** armedzoom=disarm and the rules' own proof failed: a late disarm, or a zoom tick under an armed node */
  violated: boolean;
  /** during the gesture */
  disarmsBeforeZoom: number;
  disarmsAtTick: number;
  /** of the whole page */
  lateDisarms: number;
  armedZoomTicks: number;
}
async function ruleDisarmOf(board: Board, nodeId: string, rule: ZoomRule): Promise<RuleDisarm> {
  const [now, state] = [(await board.counters()).arm, await board.armState()];
  const byRule = rule.armedzoom === "disarm" && state.armed !== nodeId;
  const counted = {
    disarmsBeforeZoom: now.disarmsBeforeZoom - rule.counters.disarmsBeforeZoom,
    disarmsAtTick: now.disarmsAtTick - rule.counters.disarmsAtTick,
    lateDisarms: now.lateDisarms,
    armedZoomTicks: now.armedZoomTicks,
  };
  const violated = rule.armedzoom === "disarm" && (counted.lateDisarms > 0 || counted.armedZoomTicks > 0);
  return {
    armedzoom: rule.armedzoom,
    byRule,
    asSpecified: byRule && !violated && counted.disarmsBeforeZoom + counted.disarmsAtTick >= 1,
    violated,
    ...counted,
  };
}
/** the proof in a sentence, for a row's `why` */
const ruleProof = (rule: RuleDisarm): string =>
  `armedzoom=disarm: ${rule.disarmsBeforeZoom} disarm(s) before the zoom's first tick, ${rule.disarmsAtTick} inside it, lateDisarms ${rule.lateDisarms}, armedZoomTicks ${rule.armedZoomTicks}`;
/** the verdict of a row whose rule's own proof failed */
const violation = (rule: RuleDisarm, short: string): Outcome => ({
  verdict: "broken",
  why: `the node's rule disarms on a board zoom and its proof failed (${ruleProof(rule)}): an armed editor saw a zoom step`,
  short: `RULE VIOLATED, ${short}`,
});

/**
 * Where the board's own move puts a screen box: the box at viewport `from`, at viewport `to`. The
 * same box when the board did not move, so a row without a move keeps its numbers to the last digit.
 */
function carried(box: Box | null, from: Viewport, to: Viewport, canvas: Box): Box | null {
  if (!box || sameViewport(from, to)) return box;
  const k = to.zoom / from.zoom;
  return {
    x: canvas.x + to.x + (box.x - canvas.x - from.x) * k,
    y: canvas.y + to.y + (box.y - canvas.y - from.y) * k,
    width: box.width * k,
    height: box.height * k,
  };
}

async function shot(ctx: Ctx, node: NodeHandle, name: string, around: readonly Box[] = []): Promise<void> {
  const path = outPath(`shots/${ctx.tag}-${name}.png`);
  await node.screenshot(path, { around });
  ctx.shots.push(path);
}

interface Pair {
  board: Board;
  /** the node that takes the page's pointer and keys */
  main: NodeHandle;
  /** the other editors of the same file, preview state, in the order of the board */
  peers: NodeHandle[];
  file: string;
  kit: Kit;
}

/**
 * Two or more editors of ONE file. "stress": the stress board in the row's strategy (s-0 is the
 * main node). "compare": the compare board, the row's strategy is the main node and the nodes of
 * the other strategies under test are its peers. The decision table needs a node of 800 x 540 to
 * show a row below its sticky head, which the stress board's 640 x 420 nodes do not: there the
 * matrix board's node is the main one, and a second node of the file is added with the toolbar's
 * Model list, far to the right.
 */
async function openPair(ctx: Ctx, zoom: number, count = 2): Promise<Pair> {
  const { kit, strategy } = ctx;
  if (ctx.variant === "compare") {
    const board = await open(ctx, { board: "compare", zoom, ...ORIGIN });
    const infos = (await board.nodes()).filter((info) => info.type === "model" && info.strategy !== undefined);
    const mine = infos.find((info) => info.strategy === strategy);
    if (!mine?.file) throw new Error(`the compare board has no node of ${strategy}`);
    const others = infos.filter((info) => info.id !== mine.id && strategies.includes(info.strategy!));
    if (others.length === 0) throw new Unmeasured("the compare board needs a second strategy in STRATEGIES");
    await board.showNode(mine.id, zoom, ORIGIN);
    const peers: NodeHandle[] = [];
    for (const info of others) peers.push(await board.node(info.id));
    return { board, main: await board.node(mine.id), peers, file: mine.file, kit: COMPARE_KIT };
  }
  if (kit.table) {
    const board = await open(ctx, { board: "matrix", strategy, notations: [kit.notation], zoom, x: -6000, y: 80 });
    const before = (await board.nodes()).map((info) => info.id);
    const main = await board.node(`m-${kit.notation}`);
    if (!main.info.file) throw new Error("the matrix node has no file");
    // lands in the middle of what the board shows: far right of the matrix node
    await board.page.selectOption("select.board-toolbar__models", main.info.file);
    const added = await board.waitFor(async () => {
      const info = (await board.nodes()).find((one) => !before.includes(one.id));
      return info?.mounted ? info : null;
    }, 20_000);
    if (!added) throw new Error("the second node of the file did not mount");
    await board.showNode(main.id, zoom, ORIGIN);
    await openTable(main);
    return { board, main, peers: [await board.node(added.id)], file: main.info.file, kit };
  }
  const board = await open(ctx, { board: "stress", strategy, notation: kit.notation, count, zoom, ...ORIGIN });
  const main = await board.node("s-0");
  if (!main.info.file) throw new Error("the stress node has no file");
  const peers: NodeHandle[] = [];
  for (let index = 1; index < count; index++) peers.push(await board.node(`s-${index}`));
  return { board, main, peers, file: main.info.file, kit };
}

/** the matrix board with the row's one notation, the node at ORIGIN; the table kit opens its table */
async function openOne(
  ctx: Ctx,
  zoom: number,
  options: Parameters<Harness["open"]>[1] = {},
): Promise<{ board: Board; node: NodeHandle; file: string }> {
  const { kit, strategy } = ctx;
  const board = await open(ctx, { board: "matrix", strategy, notations: [kit.notation], zoom, ...ORIGIN }, options);
  const node = await board.node(`m-${kit.notation}`);
  if (!node.info.file) throw new Error("the matrix node has no file");
  if (kit.table) await openTable(node);
  return { board, node, file: node.info.file };
}

const armed = async (node: NodeHandle): Promise<boolean> => (await node.state()).armed;

/** the texts of every editor's replica against the hub's file */
async function textsAgree(pair: Pair): Promise<boolean> {
  const file = await pair.board.fileText(pair.file);
  for (const node of [pair.main, ...pair.peers]) if ((await node.text()) !== file) return false;
  return true;
}

// ── cases: two editors of one file ───────────────────────────────────────────

const twoNodeVariants = (kit: Kit): readonly string[] => (kit.id === "bpmn" ? ["stress", "compare"] : ["stress"]);

/**
 * One move of the peer's shape before the measurement, taken in by every canvas. Which lines two
 * edits change decides whether the binding can merge them, and that depends on the file's history:
 * the first canvas write into a file may bring the whole file into the engine's own serialisation
 * (attribute order, line breaks), so two FIRST writes at the same moment change the same lines,
 * whatever the two people moved; and a shape that was moved before sits elsewhere in the text than
 * one that never was. So the two-edit cases run cold (no earlier write) and warm (after this one).
 * Returns how many lines the warm-up write changed.
 */
async function warmUp(pair: Pair): Promise<number> {
  const { board, main, peers, kit } = pair;
  const before = (await board.fileText(pair.file)) ?? "";
  const seen = await markOf(main, shapeMark(kit.peer));
  await peerEdit(peers[0]!, kit, 10, 6);
  const arrived = await board.waitFor(
    async () => (await markOf(main, shapeMark(kit.peer))) !== seen && (await textsAgree(pair)),
    4000,
  );
  if (!arrived) throw new Unmeasured("the peer's warm-up edit did not arrive within 4 s");
  // past every binding's quiet period after an edit (600 ms)
  await sleep(800);
  const [was, now] = [before.split("\n"), ((await board.fileText(pair.file)) ?? "").split("\n")];
  const kept = new Set(was);
  return now.filter((text) => !kept.has(text)).length + Math.max(0, was.length - now.length);
}

const syncEdit: CaseDef = {
  name: "sync-edit",
  did: "Arm one node and make one real edit in it (a shape drag; the table: three characters typed into a cell). The other nodes of the file are previews. Times from the trusted release (the table: from the first key, every key is an edit) to the first change of the hub's file (polled every 4 ms) and of each receiver's canvas (MutationObserver).",
  expected:
    "The binding writes a canvas edit at once and re-imports a remote change after its 350 ms debounce: the file within some ms, every receiver's canvas after about 350 to 700 ms, at the sender's position, all replicas equal to the file.",
  kits: KIT_IDS,
  variants: twoNodeVariants,
  zooms: () => [1],
  fixedZooms: true,
  serial: true,
  async run(ctx) {
    const pair = await openPair(ctx, ctx.zoom, ctx.variant === "stress" && !ctx.kit.table ? 3 : 2);
    const { board, main, peers, kit } = pair;
    const { m } = ctx;
    if (kit.table) for (const peer of peers) await openTable(peer);
    await arm(ctx, board, main.id);
    let mark: Mark;
    let editEvent: string;
    let act: () => Promise<void>;
    if (kit.table) {
      mark = CELL_MARK;
      editEvent = "keydown";
      act = async () => void (await typeLabel(board, main, kit));
    } else {
      const { element, grab, covered } = await pick(main, kit, kit.drag);
      m.element = element;
      if (covered.length > 0) m.covered = covered;
      mark = shapeMark(element);
      editEvent = "mouseup";
      act = async () => void (await main.drag(grab, { x: 60 * ctx.zoom, y: 40 * ctx.zoom }, { hold: kit.hold }));
    }
    const before = await markOf(main, mark);
    await watchHub(board, pair.file);
    for (const [index, peer] of peers.entries()) await peer.inDocument(WATCH_MARK, { mark, key: `__watch${index}` });
    await recordEvents(main.scope, [editEvent]);
    await act();
    const origin = await main.scope.evaluate(() => performance.timeOrigin);
    // a drag is in the model at its release; a cell edit with its first key (every key is an edit of its own)
    const trusted = (await seenEvents(main.scope, editEvent)).filter((event) => event.trusted);
    const last = kit.table ? trusted[0] : trusted.at(-1);
    if (!last) throw new Error(`no trusted ${editEvent} seen in the sender's document`);
    const editedAt = origin + last.t;
    // every receiver, or ARRIVAL
    await board.waitFor(async () => {
      for (const [index, peer] of peers.entries()) {
        if ((await peer.inDocument(READ_WATCH, `__watch${index}`)) === null) return false;
      }
      return true;
    }, ARRIVAL);
    await sleep(300);
    const hubAt = await hubChangedAt(board);
    const sent = await markOf(main, mark);
    const receivers: Array<Record<string, unknown>> = [];
    let late = 0;
    let off = 0;
    for (const [index, peer] of peers.entries()) {
      const at = await peer.inDocument(READ_WATCH, `__watch${index}`);
      const got = await markOf(peer, mark);
      // the sender's cell shows its editor while it has the focus: the receiver's cell is compared with what was typed
      const gap = kit.table ? (got?.includes(TYPED) ? 0 : Number.NaN) : apart(placeOf(got), placeOf(sent));
      if (at === null) late++;
      else if (!(gap <= UNIT_SLACK)) off++;
      receivers.push({
        node: peer.id,
        strategy: peer.info.strategy,
        canvasMs: at === null ? null : Math.round(at - editedAt),
        mark: got,
        unitsFromSender: gap,
      });
    }
    const agree = await textsAgree(pair);
    Object.assign(m, {
      sender: main.id,
      markBefore: before,
      markAfter: sent,
      hubMs: hubAt === null ? null : Math.round(hubAt - editedAt),
      receivers,
      textsEqual: agree,
      armedAfter: await armed(main),
    });
    const times = receivers.map((one) => one.canvasMs as number | null);
    const short = `hub ${m.hubMs ?? "never"} ms, canvas ${times.map((ms) => ms ?? "never").join("/")} ms${off > 0 ? `, ${off} off` : ""}`;
    if (sent === before) return { verdict: "broken", why: "the sender's own edit did not happen", short };
    if (hubAt === null) return { verdict: "broken", why: "the hub's file never changed", short };
    if (late > 0 || off > 0 || !agree) {
      return {
        verdict: "wrong-data",
        why: `${late} receiver(s) without the edit after 6 s, ${off} off the sender's position, texts equal: ${agree}`,
        short,
      };
    }
    return { verdict: "ok", why: `file after ${m.hubMs as number} ms, canvases after ${times.join(", ")} ms`, short };
  },
};

const syncBoth: CaseDef = {
  name: "sync-both",
  did: "Arm one node and hold a shape at the end of a real drag; the peer moves ANOTHER shape, and the held shape is released at once: two edits of one file within a few ms. After 4 s: both shapes on both canvases, the file, the page's log. Variant stress and compare: the file as the repository has it (both edits are the first canvas writes). Variant stress-warm: after one earlier edit of the peer that every canvas took in.",
  expected:
    "Each binding writes its own edit at once; where the two edits change different lines the text merges and each canvas re-imports the other's edit after its own quiet period (600 ms): no conflict notice, each move applied once. Where the writes cross (both written before either arrived) or change the same lines, the binding undoes one of them and says so.",
  kits: DIAGRAMS,
  variants: (kit) => [...twoNodeVariants(kit), "stress-warm"],
  zooms: () => [1],
  fixedZooms: true,
  async run(ctx) {
    const warm = ctx.variant === "stress-warm";
    if (warm) ctx.variant = "stress";
    const pair = await openPair(ctx, ctx.zoom);
    const { board, main, peers, kit } = pair;
    const { m } = ctx;
    const peer = peers[0]!;
    if (warm) m.linesChangedByTheWarmUpWrite = await warmUp(pair);
    await arm(ctx, board, main.id);
    const { element, grab } = await pick(main, kit, kit.drag);
    const [mine, theirs] = [shapeMark(element), shapeMark(kit.peer)];
    const start = { mine: placeOf(await markOf(main, mine)), theirs: placeOf(await markOf(peer, theirs)) };
    const unitPx = (await viewOf(main)).unitPx;
    const fileBefore = (await board.fileText(pair.file)) ?? "";
    const dragged = await main.drag(grab, { x: 60 * ctx.zoom, y: 40 * ctx.zoom }, { hold: kit.hold, keepDown: true });
    const peerDrag = await peerEdit(peer, kit);
    await board.release(kit.hold);
    m.msBetweenTheTwoEdits = Math.round(Date.now() - peerDrag.at);
    // where each edit put its shape: the pointer's travel in units, and what the peer's canvas showed
    const wanted = {
      mine: start.mine && { x: start.mine.x + dragged.delta.x / unitPx, y: start.mine.y + dragged.delta.y / unitPx },
      theirs: placeOf(peerDrag.after),
    };
    await sleep(4000);
    const end = {
      mineOnMain: placeOf(await markOf(main, mine)),
      mineOnPeer: placeOf(await markOf(peer, mine)),
      theirsOnMain: placeOf(await markOf(main, theirs)),
      theirsOnPeer: placeOf(await markOf(peer, theirs)),
    };
    const agree = await textsAgree(pair);
    const notices = (await board.log()).filter((text) => /crossed|could not be merged|cannot be rendered/.test(text));
    const fileAfter = ((await board.fileText(pair.file)) ?? "").split("\n");
    const kept = new Set(fileBefore.split("\n"));
    Object.assign(m, {
      main: main.id,
      peer: `${peer.id} (${peer.info.strategy})`,
      element,
      peerElement: kit.peer,
      start,
      wanted: {
        mine: wanted.mine && { x: round(wanted.mine.x, 2), y: round(wanted.mine.y, 2) },
        theirs: wanted.theirs,
      },
      end,
      textsEqual: agree,
      notices,
      linesChangedInTheFile: fileAfter.filter((text) => !kept.has(text)).length,
    });
    const slack = UNIT_SLACK + kit.grid;
    const mineKept = apart(end.mineOnMain, wanted.mine) <= slack && apart(end.mineOnPeer, wanted.mine) <= slack;
    const theirsKept =
      apart(end.theirsOnMain, wanted.theirs) <= slack && apart(end.theirsOnPeer, wanted.theirs) <= slack;
    const same = apart(end.mineOnMain, end.mineOnPeer) <= slack && apart(end.theirsOnMain, end.theirsOnPeer) <= slack;
    const short = `mine ${mineKept ? "kept" : "UNDONE"}, peer's ${theirsKept ? "kept" : "UNDONE"}, ${notices.length} notice(s)${agree ? "" : ", texts differ"}`;
    if (!agree || !same)
      return { verdict: "wrong-data", why: `the canvases or texts differ after 4 s (${short})`, short };
    if (mineKept && theirsKept && notices.length === 0) {
      return { verdict: "ok", why: "both moves on both canvases and in the file, once each, no notice", short };
    }
    if (notices.length > 0) {
      return { verdict: "degraded", why: `one edit was undone with a notice: ${notices[0]?.slice(0, 120)}`, short };
    }
    return { verdict: "wrong-data", why: `an edit is gone without a notice (${short})`, short };
  },
};

/** when each of them was first gone, epoch ms from the node's own clock; null: still there, or never there */
interface GoneAt {
  editor: number | null;
  popup: number | null;
  selection: number | null;
}

/**
 * Runs in the node's document: looks every 10 ms whether the label editor, a popup menu and a
 * selection are still there and remembers when each was first gone. Read later, against the time
 * of the peer's edit and of its arrival on this canvas: what closes with the import is the
 * import's doing, what closes at once would be the harness's.
 */
const WATCH_STATE = (host: HTMLElement, arg: { editor: string; node: string | null; key: string }): void => {
  const native = (window as NativeWindow).__boardSpikeNative;
  const popupHost =
    arg.node === null
      ? undefined
      : [...document.querySelectorAll<HTMLElement>(".board-popup-host")].find((one) => one.dataset.node === arg.node);
  const roots: Element[] = popupHost ? [host, popupHost] : [host];
  const shown = (selector: string): boolean =>
    roots.some((root) =>
      [...root.querySelectorAll(selector)].some((element) => {
        const rect = native ? native.rect(element) : element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }),
    );
  const state: GoneAt = { editor: null, popup: null, selection: null };
  const selected = (): boolean => host.querySelector(".djs-element.selected") !== null;
  // only what is there now can go
  const watched = { editor: shown(arg.editor), popup: shown(".djs-popup"), selection: selected() };
  const timer = setInterval(() => {
    const now = performance.timeOrigin + performance.now();
    if (watched.editor && state.editor === null && !shown(arg.editor)) state.editor = now;
    if (watched.popup && state.popup === null && !shown(".djs-popup")) state.popup = now;
    if (watched.selection && state.selection === null && !selected()) state.selection = now;
  }, 10);
  setTimeout(() => clearInterval(timer), 15_000);
  (window as unknown as Record<string, unknown>)[arg.key] = state;
};
const READ_GONE = (_host: HTMLElement, key: string): GoneAt =>
  (window as unknown as Record<string, GoneAt | undefined>)[key] ?? { editor: null, popup: null, selection: null };

interface Busy {
  pair: Pair;
  peer: NodeHandle;
  before: EditorState;
  after: EditorState;
  arrived: boolean;
  /** ms after the peer's edit: when it showed on this canvas, and when the editor, the popup, the selection went */
  ms: { canvas: number | null; editor: number | null; popup: number | null; selection: number | null };
}

/** a node armed and busy, a peer that edits: what the label, the popup and the selection case share */
async function busy(ctx: Ctx, prepare: (pair: Pair) => Promise<void>): Promise<Busy> {
  const pair = await openPair(ctx, ctx.zoom);
  const { board, main, peers, kit } = pair;
  const peer = peers[0]!;
  await arm(ctx, board, main.id);
  await prepare(pair);
  // a cell edit is in the model with every key: the peer's canvas takes it in before the peer edits
  // itself (its binding waits 350 ms; an edit of the peer inside that window would cross it)
  if (kit.table) await sleep(1200);
  const before = await stateOf(main, kit);
  const theirs = shapeMark(kit.peer);
  const seen = kit.table ? null : await markOf(main, theirs);
  const text = await main.text();
  const viewBefore = await viewOf(main);
  await main.inDocument(WATCH_STATE, { editor: kit.editor, node: main.frame ? null : main.id, key: "__busy" });
  await main.inDocument(WATCH_MARK, { mark: kit.table ? CELL_MARK : theirs, key: "__busyMark" });
  const peerDrag = await peerEdit(peer, kit);
  // arrived: the replica has the text; on the canvas: the peer's shape is where the peer put it
  const arrived =
    (await board.waitFor(async () => {
      if ((await main.text()) === text) return false;
      return kit.table ? true : (await markOf(main, theirs)) !== seen;
    }, ARRIVAL)) === true;
  await sleep(kit.table ? 900 : 250);
  const after = await stateOf(main, kit);
  const viewAfter = await viewOf(main);
  const [gone, canvasAt] = [
    await main.inDocument(READ_GONE, "__busy"),
    await main.inDocument(READ_WATCH, "__busyMark"),
  ];
  const since = (at: number | null): number | null => (at === null ? null : Math.round(at - peerDrag.at));
  const ms = {
    // the table shows no shape: its canvas time is the re-render of the cell, if any
    canvas: since(canvasAt),
    editor: since(gone.editor),
    popup: since(gone.popup),
    selection: since(gone.selection),
  };
  Object.assign(ctx.m, {
    main: main.id,
    peer: `${peer.id} (${peer.info.strategy})`,
    peerMoved: `${peerDrag.before} -> ${peerDrag.after}`,
    stateBefore: before,
    peerEditOnCanvas: arrived,
    msAfterThePeersEdit: ms,
    stateAfter: after,
    viewDrift: drift(viewBefore, viewAfter),
    armedAfter: await armed(main),
  });
  return { pair, peer, before, after, arrived, ms };
}

/** it went more than 150 ms before the peer's edit showed on the canvas: not with the import */
const wentEarly = (ms: Busy["ms"], what: "editor" | "popup" | "selection"): boolean =>
  ms[what] !== null && ms.canvas !== null && ms[what] < ms.canvas - 150;

const busyDrag: CaseDef = {
  name: "busy-drag",
  did: "Arm a node, press on a shape and drag it part of the way (the button stays down); the peer moves another shape. 1.5 s later: is the peer's edit on the canvas? Then the pointer moves on and releases. After 2 s: where the shape landed, the peer's shape, the file, the page's log. Variant stress and compare: the file as the repository has it. Variant stress-warm: after one earlier move of the peer's shape that every canvas took in.",
  expected:
    "The binding holds a remote re-import while a pointer is down on the canvas (up to 10 s): the peer's edit waits, the drop lands where the pointer is, then the canvas takes the peer's edit in. The drop is written into a text that already holds the peer's edit: where the two changed different lines both stay, else the binding undoes the drop and says so.",
  kits: DIAGRAMS,
  variants: (kit) => [...twoNodeVariants(kit), "stress-warm"],
  zooms: () => [1],
  fixedZooms: true,
  async run(ctx) {
    const warm = ctx.variant === "stress-warm";
    if (warm) ctx.variant = "stress";
    const pair = await openPair(ctx, ctx.zoom);
    const { board, main, peers, kit } = pair;
    const { m } = ctx;
    const peer = peers[0]!;
    if (warm) m.linesChangedByTheWarmUpWrite = await warmUp(pair);
    await arm(ctx, board, main.id);
    const { element, grab } = await pick(main, kit, kit.drag);
    const [mine, theirs] = [shapeMark(element), shapeMark(kit.peer)];
    const start = placeOf(await markOf(main, mine));
    const theirsBefore = await markOf(main, theirs);
    const unitPx = (await viewOf(main)).unitPx;
    const first = await main.drag(grab, { x: 40 * ctx.zoom, y: 30 * ctx.zoom }, { hold: kit.hold, keepDown: true });
    const held = await stateOf(main, kit);
    const peerDrag = await peerEdit(peer, kit);
    await sleep(1500);
    const meanwhile = {
      peerEditOnCanvas: (await markOf(main, theirs)) !== theirsBefore,
      replicaHasIt: (await main.text()) === (await board.fileText(pair.file)),
      stillDragging: (await stateOf(main, kit)).dragging,
    };
    // on: the same direction, then the release
    const end = { x: first.to.x + 20 * ctx.zoom, y: first.to.y + 10 * ctx.zoom };
    await board.move(end, 4);
    await sleep(40);
    await board.release(kit.hold);
    await sleep(2000);
    const landed = placeOf(await markOf(main, mine));
    const pointer = { x: end.x - first.from.x, y: end.y - first.from.y };
    const expected = start && { x: start.x + pointer.x / unitPx, y: start.y + pointer.y / unitPx };
    const offUnits = apart(landed, expected);
    const theirsOnMain = placeOf(await markOf(main, theirs));
    const peerOff = apart(theirsOnMain, placeOf(peerDrag.after));
    const agree = await textsAgree(pair);
    const log = await board.log();
    Object.assign(m, {
      main: main.id,
      peer: `${peer.id} (${peer.info.strategy})`,
      element,
      heldDragging: held.dragging,
      meanwhile,
      pointerPx: { x: round(pointer.x), y: round(pointer.y) },
      unitPx: round(unitPx, 4),
      start,
      landed,
      expected: expected && { x: round(expected.x, 2), y: round(expected.y, 2) },
      offUnits,
      onScreenRatio: start && landed ? round(((landed.x - start.x) * unitPx) / pointer.x, 3) : null,
      peerShapeOffUnits: peerOff,
      textsEqual: agree,
      log,
      armedAfter: await armed(main),
    });
    const slack = UNIT_SLACK + kit.grid;
    const undone = apart(landed, start) === 0;
    const short = `held: import ${meanwhile.peerEditOnCanvas ? "ran" : "waited"}; drop ${undone ? "UNDONE" : `${offUnits} u off`}; peer's ${peerOff <= UNIT_SLACK ? "kept" : "MISSING"}`;
    if (!agree || !(peerOff <= UNIT_SLACK)) {
      return {
        verdict: "wrong-data",
        why: `texts equal: ${agree}, the peer's shape ${peerOff} units off on this canvas`,
        short,
      };
    }
    if (undone) {
      const notice = log.find((text) => /crossed|could not be merged/.test(text));
      return {
        verdict: "degraded",
        why: `the held shape did not move: ${notice ? `undone with the notice "${notice.slice(0, 100)}"` : "the drag was lost"}`,
        short,
      };
    }
    if (!(offUnits <= slack)) {
      return {
        verdict: "wrong-data",
        why: `the shape landed ${offUnits} units from where the pointer went (slack ${slack})`,
        short,
      };
    }
    return {
      verdict: "ok",
      why: `the drop is ${offUnits} units off (slack ${slack}); the peer's edit ${meanwhile.peerEditOnCanvas ? "was imported under the held drag" : "waited for the drop"} and is on the canvas`,
      short,
    };
  },
};

const busyLabel: CaseDef = {
  name: "busy-label",
  did: `Arm a node, open a label editor (the table: a cell editor) and type "${TYPED}"; the peer moves a shape. Read the editor right after the peer's edit and after it arrived, then press the commit key and read the file.`,
  expected:
    "A label editor is no gesture for the binding: the remote re-import replaces the canvas after 350 ms. Expected from the engine's code: the editor closes and the typed text is gone, in every strategy alike.",
  kits: KIT_IDS,
  variants: twoNodeVariants,
  zooms: () => [1],
  fixedZooms: true,
  async run(ctx) {
    const { pair, before, after, arrived, ms } = await busy(ctx, async ({ board, main, kit }) => {
      ctx.m.element = await typeLabel(board, main, kit);
    });
    const { board, main, kit } = pair;
    if (!before.editor || !before.text?.includes(TYPED)) throw new Unmeasured("the typed text did not reach an editor");
    await shot(ctx, main, "after");
    ctx.m.committedBy = await commitLabel(board, main, kit);
    await sleep(700);
    const inFile = (await board.fileText(pair.file))?.includes(TYPED) === true;
    const inEditor = after.editor && after.text?.includes(TYPED) === true;
    Object.assign(ctx.m, {
      textInEditorAfter: inEditor,
      textInFileAfterCommit: inFile,
      textsEqual: await textsAgree(pair),
    });
    const short = `editor ${after.editor ? "open" : `closed after ${ms.editor} ms`}, text ${inEditor ? "in editor" : inFile ? "in file" : "LOST"}${after.focused ? "" : ", focus gone"}`;
    if (!arrived) throw new Unmeasured("the peer's edit did not arrive within 6 s");
    if (wentEarly(ms, "editor")) {
      throw new Unmeasured(
        `the editor closed ${ms.editor} ms after the peer's edit, before it reached this canvas (${ms.canvas} ms)`,
      );
    }
    if (inEditor && after.focused)
      return { verdict: "ok", why: "the editor is open, focused and holds the typed text", short };
    if (inEditor || inFile) {
      return {
        verdict: "degraded",
        why: `the text is kept (${inEditor ? "editor" : "file"}) but the editor ${after.editor ? "lost the focus" : "closed"}: the next key goes elsewhere`,
        short,
      };
    }
    return { verdict: "broken", why: "the typed text is in no editor and not in the file after the commit key", short };
  },
};

const busyPopup: CaseDef = {
  name: "busy-popup",
  did: "Arm a node, select a shape and open the popup menu of its pad; the peer moves another shape. Read the popup right after the peer's edit and after it arrived.",
  expected:
    "The re-import replaces every shape: the selection goes, and with it the pad and its popup, in every strategy alike.",
  kits: DIAGRAMS,
  variants: twoNodeVariants,
  zooms: () => [1],
  fixedZooms: true,
  async run(ctx) {
    const { pair, before, after, arrived, ms } = await busy(ctx, async ({ board, main, kit }) => {
      ctx.m.element = (await openPopup(board, main, kit)).element;
    });
    await shot(ctx, pair.main, "after");
    if (!before.popup) throw new Unmeasured("no popup was open");
    if (!arrived) throw new Unmeasured("the peer's edit did not arrive within 6 s");
    if (wentEarly(ms, "popup")) {
      throw new Unmeasured(
        `the popup closed ${ms.popup} ms after the peer's edit, before it reached this canvas (${ms.canvas} ms)`,
      );
    }
    const short = `popup ${after.popup ? "kept" : `closed after ${ms.popup} ms`}, pad ${after.pad ? "kept" : "closed"}, selection ${after.selected.length > 0 ? "kept" : "gone"}`;
    return after.popup
      ? { verdict: "ok", why: "the popup is still open", short }
      : { verdict: "degraded", why: "the popup closed when the peer's edit was imported", short };
  },
};

const busySelect: CaseDef = {
  name: "busy-select",
  did: "Arm a node and select a shape (its pad opens); the peer moves another shape. Read the selection after the peer's edit arrived.",
  expected:
    "The re-import replaces every shape and the binding restores the view, not the selection: it is gone, in every strategy alike.",
  kits: DIAGRAMS,
  variants: twoNodeVariants,
  zooms: () => [1],
  fixedZooms: true,
  async run(ctx) {
    const { before, after, arrived, ms } = await busy(ctx, async ({ board, main, kit }) => {
      const { element, grab } = await pick(main, kit, kit.label);
      ctx.m.element = element;
      await board.click(grab);
      await board.waitFor(async () => (await main.selected()).includes(element), WAIT);
    });
    if (before.selected.length === 0) throw new Unmeasured("nothing was selected");
    if (!arrived) throw new Unmeasured("the peer's edit did not arrive within 6 s");
    const kept = before.selected.every((id) => after.selected.includes(id));
    const short = `selection ${kept ? "kept" : `gone after ${ms.selection} ms`}, pad ${after.pad ? "open" : "closed"}`;
    return kept
      ? { verdict: "ok", why: "the same element is selected", short }
      : {
          verdict: "degraded",
          why: `selected before: ${before.selected.join(",")}, after: ${after.selected.join(",") || "nothing"}`,
          short,
        };
  },
};

const peerView: CaseDef = {
  name: "peer-view",
  did: "Two nodes of one file. The visible diagram rectangle of one node before and after an edit of the other (a shape moved by the peer), with the node as a preview (variant preview) and armed (variant armed), each on a fresh page. The rectangle is read from the browser's matrices, in diagram units.",
  expected:
    "The binding restores the viewbox it read before the import through diagram-js's getter, which rounds scale and origin to three decimals: at an odd scale the view shifts by a fraction of a unit unless the strategy applies its own view again.",
  kits: KIT_IDS,
  variants: () => ["armed", "preview"],
  // armed at the three zooms; the preview is laid out at zoom 1 whatever the board zoom is: one odd zoom
  zooms: (variant) => (variant === "armed" ? BOARD_ZOOMS : [ODD_ZOOM]),
  async run(ctx) {
    // the node under test is the one a person looks at: the pair's main node; the peer edits
    const pair = await openPair(ctx, ctx.zoom);
    const { board, main, peers, kit } = pair;
    const peer = peers[0]!;
    if (ctx.variant === "armed") {
      await arm(ctx, board, main.id);
      await sleep(150);
    }
    const theirs = shapeMark(kit.peer);
    const from = await viewOf(main);
    const ownBefore = (await main.viewportMatrix())?.a;
    const [text, seen] = [await main.text(), kit.table ? null : await markOf(main, theirs)];
    await peerEdit(peer, kit);
    const arrived = await board.waitFor(async () => {
      if ((await main.text()) === text) return false;
      return kit.table ? true : (await markOf(main, theirs)) !== seen;
    }, ARRIVAL);
    if (!arrived) throw new Unmeasured("the peer's edit did not arrive within 6 s");
    await sleep(kit.table ? 900 : 350);
    const to = await viewOf(main);
    const moved = drift(from, to);
    Object.assign(ctx.m, {
      main: main.id,
      peer: peer.id,
      before: flatView(from),
      after: flatView(to),
      drift: moved,
      // the scale the engine itself holds, in its own document: a rounding by the getter shows here
      ownScale: { before: ownBefore, after: (await main.viewportMatrix())?.a },
      tableStillShown: kit.table ? await main.inDocument((host) => !!host.querySelector("table")) : undefined,
      armed: await armed(main),
    });
    const scaleOff = Math.abs(moved.scale - 1);
    const short = `${moved.units} u / ${moved.px} px, scale x${moved.scale}`;
    const why = `the rectangle (${shortView(from)}) moved ${moved.units} units = ${moved.px} px, the scale changed by ${round(scaleOff * 100, 4)} %`;
    if (moved.px <= PX_STILL && scaleOff <= SCALE_SLACK) return { verdict: "ok", why, short };
    if (moved.px <= PX_JUMP && scaleOff <= 0.02) return { verdict: "degraded", why, short };
    return { verdict: "broken", why, short };
  },
};

// ── cases: the board zooms ───────────────────────────────────────────────────

type ZoomBy = "wheel" | "toolbar" | "hook";
/** one wheel notch of 30: x 2^0.06 = 1.0425, 20 of them x 2.3; the toolbar's step is x 1.2 */
const WHEEL_DELTA = 30;
const HOOK_STEP = 2 ** (WHEEL_DELTA * 0.002);

/** one zoom step of the board; returns the board zoom after it (unchanged at the board's limit of 0.1 or 4) */
async function zoomStep(board: Board, by: ZoomBy, direction: 1 | -1): Promise<number> {
  const before = (await board.viewport()).zoom;
  if (by === "wheel") await board.wheel(pivotOf(board), -WHEEL_DELTA * direction);
  else if (by === "toolbar") await board.click(await toolbarButton(board, direction > 0 ? "Zoom in" : "Zoom out"));
  else {
    // the node's corner stays where it IS: the viewport's own x and y (ORIGIN unless arming moved the board)
    const { x, y } = await board.viewport();
    await board.setViewport({ x, y, zoom: before * HOOK_STEP ** direction });
  }
  // at the board's limit (0.1 and 4) nothing will change: a short look is enough there. The hook's
  // zoom is in effect when setViewport returns, or it was refused (armedzoom, a held press)
  const atLimit = direction > 0 ? before >= 3.9999 : before <= 0.10001;
  await board.waitFor(async () => (await board.viewport()).zoom !== before, atLimit || by === "hook" ? 150 : 1500, 15);
  await frames(board);
  return (await board.viewport()).zoom;
}

interface Series {
  /** per step: the board zoom, the diagram's on-screen scale over the board's (1 = in scale), the rectangle's drift in units */
  steps: Array<{ zoom: number; scale: number; units: number }>;
  /** the largest |scale - 1| */
  scaleOff: number;
  /** steps (of all) at which the picture was more than SCALE_SLACK out of scale */
  outOfScale: number;
  /** the largest drift of the rectangle's origin against the start, in units */
  units: number;
  /** steps at which the board zoom did not change: its limit */
  clamped: number;
  maxZoom: number;
}

/**
 * `count` steps in and `count` back. After each one: the visible rectangle against the start and
 * the diagram's on-screen scale against the board's (k0 x zoom, k0 from the start), plus whatever
 * `each` reads; `each` returning false ends the series early (nothing left to watch).
 */
async function zoomSeries(
  board: Board,
  node: NodeHandle,
  by: ZoomBy,
  count: number,
  start: View,
  each?: (step: number, zoom: number) => Promise<boolean | void>,
): Promise<Series> {
  const k0 = start.unitPx / (await board.viewport()).zoom;
  const series: Series = { steps: [], scaleOff: 0, outOfScale: 0, units: 0, clamped: 0, maxZoom: 0 };
  let last = (await board.viewport()).zoom;
  for (let step = 1; step <= 2 * count; step++) {
    const zoom = await zoomStep(board, by, step <= count ? 1 : -1);
    if (zoom === last) series.clamped++;
    last = zoom;
    const view = await viewOf(node);
    const scale = view.unitPx / (k0 * zoom);
    const units = Math.max(Math.abs(view.x - start.x), Math.abs(view.y - start.y));
    series.steps.push({ zoom: round(zoom, 4), scale: round(scale, 4), units: round(units, 3) });
    series.scaleOff = Math.max(series.scaleOff, Math.abs(scale - 1));
    if (Math.abs(scale - 1) > SCALE_SLACK) series.outOfScale++;
    series.units = Math.max(series.units, units);
    series.maxZoom = Math.max(series.maxZoom, zoom);
    if ((await each?.(step, zoom)) === false) break;
  }
  series.scaleOff = round(series.scaleOff, 4);
  series.units = round(series.units, 3);
  return series;
}

const seriesFacts = (series: Series): Record<string, unknown> => ({
  stepsDone: series.steps.length,
  maxBoardZoom: round(series.maxZoom, 4),
  stepsAtTheBoardsLimit: series.clamped,
  maxScaleOff: series.scaleOff,
  stepsOutOfScale: series.outOfScale,
  maxDriftUnits: series.units,
  // the first, the turning point and the last: the whole list would be 40 lines per row
  samples: [series.steps[0], series.steps[Math.floor(series.steps.length / 2) - 1], series.steps.at(-1)],
});

// ── variant burst: a zoom gesture as a trackpad sends it ─────────────────────

/** wheel events of one burst, a frame apart: x 2.3 in all, what the 20 single steps in of the other variants add up to */
const BURST_EVENTS = 20;

interface BurstFacts {
  events: number;
  /** animation frames sampled, from the frame before the first event until the board rested */
  frames: number;
  boardZoom: { start: number; end: number; factor: number };
  /** frames in which the node showed as armed (the DOM's flag) at another board zoom than at the start */
  framesArmedAtAnotherZoom: number;
  /** frames in which the picture's on-screen scale was more than SCALE_SLACK off the board's */
  framesOutOfScale: number;
  /** of those, the ones in which what the case watches (an editor, a popup) was shown */
  framesOutOfScaleWithItShown: number;
  /** the largest |scale - 1| over all frames */
  maxScaleOff: number;
  /** index of the first frame at another board zoom, of the first frame that showed no armed node, of the first without what is watched */
  firstFrameAtAnotherZoom: number | null;
  firstFrameDisarmed: number | null;
  firstFrameWithoutIt: number | null;
  /** the runtime's armed node and the DOM's flag agreed in every frame */
  runtimeAndDomAgree: boolean;
  /** the board's own recording (hooks.startFrames): armed frames at another zoom, armed frames whose editor zoom is not the board's */
  hookFrames: {
    frames: number;
    armedAtAnotherZoom: number;
    shownAtAnotherZoom: number;
    editorZoomOffTheBoards: number;
  };
}

type BurstWindow = Window & { __burst?: { stop(): number[][] } };

/**
 * Starts sampling in the board page, once per animation frame in a task right after the frame's
 * callbacks, plus once at the call: [board zoom, screen px per unit of the picture (the diagram's
 * matrix, the table's width over its layout width), the runtime has the node armed, the DOM shows
 * an armed node, `watch` is shown]. The host is the engine's own element wherever the strategy put it.
 */
const startBurstSampler = (board: Board, node: NodeHandle, watch: string | null): Promise<void> =>
  board.page.evaluate(
    ([key, id, selector]) => {
      interface Hooks {
        engine(id: string): unknown;
        viewport(): { zoom: number };
        armState(): { armed: string | null };
      }
      const hooks = (window as unknown as Record<string, Hooks>)[key]!;
      const native = (window as NativeWindow).__boardSpikeNative;
      const rect = (element: Element): DOMRect => (native ? native.rect(element) : element.getBoundingClientRect());
      const shown = (element: Element): boolean => {
        const box = rect(element);
        return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
      };
      const samples: number[][] = [];
      let on = true;
      const read = (): void => {
        const host = (hooks.engine(id) as { host?: HTMLElement } | undefined)?.host ?? null;
        let unit = Number.NaN;
        const viewport = host?.querySelector<SVGGElement>("svg g.viewport");
        const table = host?.querySelector<HTMLElement>("table");
        if (viewport) unit = (native ? native.screenCTM(viewport) : viewport.getScreenCTM())?.a ?? Number.NaN;
        else if (table && table.offsetWidth > 0) unit = rect(table).width / table.offsetWidth;
        const popupHost = [...document.querySelectorAll<HTMLElement>(".board-popup-host")].find(
          (one) => one.dataset.node === id,
        );
        const roots = [host, popupHost].filter((one): one is HTMLElement => !!one);
        const watched =
          selector !== null && roots.some((root) => [...root.querySelectorAll(selector)].some(shown)) ? 1 : 0;
        samples.push([
          hooks.viewport().zoom,
          unit,
          hooks.armState().armed === id ? 1 : 0,
          document.querySelector('.board-node[data-armed="true"]') ? 1 : 0,
          watched,
        ]);
      };
      const channel = new MessageChannel();
      channel.port1.onmessage = read;
      const tick = (): void => {
        if (!on) return;
        channel.port2.postMessage(0);
        requestAnimationFrame(tick);
      };
      read();
      requestAnimationFrame(tick);
      (window as BurstWindow).__burst = {
        stop() {
          on = false;
          return samples;
        },
      };
    },
    [HOOKS_KEY, node.id, watch] as const,
  );

/** one burst of BURST_EVENTS wheel events on the bare pane, nothing read in between; what every frame showed */
async function burst(board: Board, node: NodeHandle, watch: string | null): Promise<BurstFacts> {
  if (node.frame)
    throw new Unmeasured("variant burst reads the picture in the board page: not for a node that is a frame");
  await startBurstSampler(board, node, watch);
  await board.startFrames();
  await frames(board, 2);
  await board.wheelBurst(pivotOf(board), -WHEEL_DELTA, { count: BURST_EVENTS });
  await board.waitForRest();
  await frames(board, 3);
  const samples = await board.page.evaluate(() => (window as BurstWindow).__burst?.stop() ?? []);
  const recorded = await board.stopFrames();
  const first = samples[0];
  if (!first || !(first[1]! > 0)) throw new Unmeasured("the picture's scale could not be read before the burst");
  const [zoom0, unit0] = [first[0]!, first[1]!];
  const k0 = unit0 / zoom0;
  const facts: BurstFacts = {
    events: BURST_EVENTS,
    frames: samples.length,
    boardZoom: { start: round(zoom0, 4), end: 0, factor: 0 },
    framesArmedAtAnotherZoom: 0,
    framesOutOfScale: 0,
    framesOutOfScaleWithItShown: 0,
    maxScaleOff: 0,
    firstFrameAtAnotherZoom: null,
    firstFrameDisarmed: null,
    firstFrameWithoutIt: null,
    runtimeAndDomAgree: true,
    hookFrames: {
      frames: recorded.length,
      armedAtAnotherZoom: recorded.filter((one) => one.armed !== null && one.zoom !== zoom0).length,
      shownAtAnotherZoom: recorded.filter((one) => one.shown !== null && one.zoom !== zoom0).length,
      editorZoomOffTheBoards: recorded.filter(
        (one) => one.armed !== null && one.editorZoom !== null && one.editorZoom !== one.zoom,
      ).length,
    },
  };
  samples.forEach(([zoom, unit, runtime, dom, watched], index) => {
    const off = Math.abs(unit! / (k0 * zoom!) - 1);
    if (zoom !== zoom0) facts.firstFrameAtAnotherZoom ??= index;
    if (dom === 0) facts.firstFrameDisarmed ??= index;
    if (watch !== null && watched === 0) facts.firstFrameWithoutIt ??= index;
    if (dom === 1 && zoom !== zoom0) facts.framesArmedAtAnotherZoom++;
    if (runtime !== dom) facts.runtimeAndDomAgree = false;
    if (off > SCALE_SLACK) {
      facts.framesOutOfScale++;
      if (watched === 1) facts.framesOutOfScaleWithItShown++;
    }
    if (off > facts.maxScaleOff) facts.maxScaleOff = off;
  });
  const zoomEnd = samples.at(-1)![0]!;
  facts.boardZoom.end = round(zoomEnd, 4);
  facts.boardZoom.factor = round(zoomEnd / zoom0, 3);
  facts.maxScaleOff = round(facts.maxScaleOff, 4);
  return facts;
}

/** the burst's part of a headline: only what does not depend on how many frames the machine got in */
const burstShort = (facts: BurstFacts, armedAfter: boolean, byRule = false): string =>
  `burst x${facts.boardZoom.factor}: ${armedAfter ? "armed after" : byRule ? "disarmed by rule" : "disarmed"}, ${facts.framesArmedAtAnotherZoom > 0 ? "ARMED in frames at another zoom" : "no armed frame at another zoom"}, scale off ${round(facts.maxScaleOff * 100, 2)} % max`;

const zoomVariants = (): readonly string[] => ["wheel", "toolbar", "burst"];
/** 20 toolbar steps of x 1.2 are x 38: they fit between the board's limits (0.1 and 4) from 0.1 only */
const plainZooms = (variant: string): readonly number[] => (variant === "toolbar" ? [0.1] : [ODD_ZOOM]);
/** the toolbar's zoom step and the board's upper limit */
const TOOLBAR_STEP = 1.2;
const BOARD_MAX_ZOOM = 4;
/**
 * Toolbar steps in that fit below the board's limit from `zoom`, 20 at most. From the zoom IN
 * EFFECT, not the one asked for: a node asked at 0.1 is armed at 1 by its rule, and from there 7
 * steps fit, not 20 (with 20, 12 of 40 steps stood at the limit and the board did not come back).
 */
const toolbarStepsFrom = (zoom: number): number =>
  Math.max(1, Math.min(20, Math.floor(Math.log(BOARD_MAX_ZOOM / zoom) / Math.log(TOOLBAR_STEP) + 1e-9)));

const zoomPlain: CaseDef = {
  name: "zoom-plain",
  did: "Arm a node, then 20 board zoom steps in and 20 back: by wheel on the bare pane (30 per notch, x 1.0425, pivot left of the node; from 0.8137 to 1.87) and by the toolbar's buttons (x 1.2, from 0.1, the only start from which 20 steps fit between the board's limits; where arming put the board at another zoom, as many steps as fit below the limit of 4 from there). After every step the visible diagram rectangle and the diagram's on-screen scale. Variant burst: 20 wheel events of 30 on the bare pane, one animation frame apart, nothing read in between (x 2.3, not back); the board zoom, the picture's scale and the armed flag in every frame.",
  expected:
    "The node owns its view: the same diagram rectangle at every board zoom, the diagram's on-screen scale = the board zoom x a constant. A host the board scales gets that for free; a host at net scale 1 has to re-apply the view on every step and may drift. An HTML view has no scale to set: at net scale 1 it does not follow.",
  kits: KIT_IDS,
  variants: zoomVariants,
  zooms: plainZooms,
  async run(ctx) {
    const { board, node } = await openOne(ctx, ctx.zoom);
    await arm(ctx, board, node.id);
    await sleep(150);
    const by: ZoomBy = ctx.variant === "toolbar" ? "toolbar" : "wheel";
    const [start, viewportStart, hostStart] = [await viewOf(node), await board.viewport(), await node.hostBox()];
    if (ctx.variant === "burst") {
      const facts = await burst(board, node, null);
      const [end, armedAfter] = [await viewOf(node), await armed(node)];
      const moved = drift(start, end);
      Object.assign(ctx.m, { start: flatView(start), end: flatView(end), drift: moved, burst: facts, armedAfter });
      const short = `${burstShort(facts, armedAfter)}, drift ${moved.units} u`;
      const why = `${facts.frames} frames of one burst (board zoom ${facts.boardZoom.start} to ${facts.boardZoom.end}): the picture was more than ${SCALE_SLACK * 100} % off the board's scale in ${facts.framesOutOfScale} of them (${round(facts.maxScaleOff * 100, 2)} % at most), the node showed as armed at another zoom in ${facts.framesArmedAtAnotherZoom}; the rectangle ends ${moved.units} units (${moved.px} px) from the start`;
      if (moved.px <= PX_STILL && facts.maxScaleOff <= SCALE_SLACK) return { verdict: "ok", why, short };
      if (moved.px <= PX_JUMP && facts.maxScaleOff <= 0.02) return { verdict: "degraded", why, short };
      return { verdict: "broken", why, short };
    }
    // the toolbar's steps are counted from the zoom in effect: 20 from 0.1, 7 from 1
    const stepsIn = by === "toolbar" ? toolbarStepsFrom(viewportStart.zoom) : 20;
    const series = await zoomSeries(board, node, by, stepsIn, start);
    const [end, viewportEnd, hostEnd] = [await viewOf(node), await board.viewport(), await node.hostBox()];
    const moved = drift(start, end);
    const boardBack = Math.abs(viewportEnd.zoom - viewportStart.zoom) < 1e-9;
    Object.assign(ctx.m, {
      start: flatView(start),
      end: flatView(end),
      drift: moved,
      ...seriesFacts(series),
      boardBackAtStart: boardBack,
      hostMovedPx: boardBack
        ? round(Math.max(Math.abs(hostEnd.x - hostStart.x), Math.abs(hostEnd.y - hostStart.y)), 2)
        : null,
      armedAfter: await armed(node),
    });
    const short = `drift ${moved.units} u / ${moved.px} px, scale off ${round(series.scaleOff * 100, 2)} % max (zoom to ${round(series.maxZoom, 2)})`;
    const why = `after ${series.steps.length} steps the rectangle is ${moved.units} units (${moved.px} px) from the start; the on-screen scale was up to ${round(series.scaleOff * 100, 2)} % off the board's, at ${series.outOfScale} steps beyond ${SCALE_SLACK * 100} %`;
    if (moved.px <= PX_STILL && series.scaleOff <= SCALE_SLACK) return { verdict: "ok", why, short };
    if (moved.px <= PX_JUMP && series.scaleOff <= 0.02) return { verdict: "degraded", why, short };
    return { verdict: "broken", why, short };
  },
};

const stateSteps = (variant: string): number => (variant === "toolbar" ? 3 : 20);

/**
 * How far something that belongs to an element (an open label editor, a popup) moved against it
 * between two moments at different scales: its middle against the element's middle, in element
 * widths, the difference in screen px of the later moment. Null when it was not there at either.
 */
function againstAnchor(
  start: { editor: Box; element: Box } | null,
  peak: { editor: Box; element: Box } | null,
): { startPx: Point; peakPx: Point; movedPx: number; sizeRatio: number; elementRatio: number } | null {
  if (!start || !peak) return null;
  const offset = (one: { editor: Box; element: Box }): Point => ({
    x: centre(one.editor).x - centre(one.element).x,
    y: centre(one.editor).y - centre(one.element).y,
  });
  const [a, b] = [offset(start), offset(peak)];
  const grew = peak.element.width / start.element.width;
  return {
    startPx: { x: round(a.x), y: round(a.y) },
    peakPx: { x: round(b.x), y: round(b.y) },
    movedPx: round(Math.hypot(b.x - a.x * grew, b.y - a.y * grew), 2),
    // the editor's (the popup's) width at the peak over its width at the start, and the element's
    sizeRatio: round(peak.editor.width / start.editor.width, 4),
    elementRatio: round(grew, 4),
  };
}

const zoomLabel: CaseDef = {
  name: "zoom-label",
  did: `Arm a node, open a label editor (the table: a cell editor), type "${TYPED}", then zoom the board: 20 wheel steps in and 20 back on the bare pane (variant wheel), 3 clicks on the toolbar's Zoom in and 3 on Zoom out (variant toolbar). After every step: is the editor open, has it the text and the focus, is the picture in scale. Then the commit key and the file. Variant burst: 20 wheel events a frame apart with the editor open, sampled per frame.`,
  expected:
    "A viewbox write commits an open label editor in bpmn-js and dmn-js. A host the board scales writes none. A host at net scale 1 has to write one per step: it either commits the label at the first step or holds the write, and then the picture is out of scale for as long as the editor is open. A click on the toolbar takes the focus.",
  kits: KIT_IDS,
  variants: zoomVariants,
  zooms: () => [ODD_ZOOM],
  async run(ctx) {
    const { board, node, file } = await openOne(ctx, ctx.zoom);
    const { kit, m } = ctx;
    await arm(ctx, board, node.id);
    await sleep(150);
    const start = await viewOf(node);
    m.element = await typeLabel(board, node, kit);
    const before = await stateOf(node, kit);
    if (!before.editor || !before.text?.includes(TYPED)) throw new Unmeasured("the typed text did not reach an editor");
    // the node's own rule for a board zoom, and the rules' counters before the first step
    const rule = await zoomRuleOf(board, node.id);
    if (ctx.variant === "burst") {
      const facts = await burst(board, node, kit.editor);
      const [after, armedAfter] = [await stateOf(node, kit), await armed(node)];
      const disarm = await ruleDisarmOf(board, node.id, rule);
      await shot(ctx, node, "after-the-burst");
      m.committedBy = await commitLabel(board, node, kit);
      await sleep(800);
      const inFile = (await board.fileText(file))?.includes(TYPED) === true;
      const inEditor = after.editor && after.text?.includes(TYPED) === true;
      Object.assign(m, {
        burst: facts,
        stateAfterTheBurst: after,
        textInEditorAfterTheBurst: inEditor,
        textInFileAfterCommit: inFile,
        armedAfter,
        ...(disarm.armedzoom === "disarm" ? { disarmByRule: disarm } : {}),
      });
      const short = `${burstShort(facts, armedAfter, disarm.byRule)}, ${after.editor ? "editor open" : "editor closed"}, text ${inEditor ? "in editor" : inFile ? "in file" : "LOST"}`;
      const why = `${short}; ${facts.frames} frames: out of scale in ${facts.framesOutOfScale} (${facts.framesOutOfScaleWithItShown} with the editor shown), armed at another zoom in ${facts.framesArmedAtAnotherZoom}, first frame at another zoom ${String(facts.firstFrameAtAnotherZoom)}, first frame disarmed ${String(facts.firstFrameDisarmed)}`;
      if (!inEditor && !inFile)
        return { verdict: "broken", why: `the typed text is in no editor and not in the file (${why})`, short };
      if (disarm.violated) return violation(disarm, short);
      if (disarm.byRule) {
        // armedzoom=disarm: the editor closed with the disarm, before the first zoomed frame. That is the rule
        const specified =
          disarm.asSpecified &&
          !after.editor &&
          inFile &&
          m.committedBy === "nothing to commit" &&
          facts.framesArmedAtAnotherZoom === 0 &&
          facts.hookFrames.armedAtAnotherZoom === 0 &&
          facts.maxScaleOff <= SCALE_SLACK;
        return {
          verdict: specified ? "ok" : "degraded",
          why: `${specified ? "as the node's rule specifies" : "NOT as the node's rule specifies"} (${ruleProof(disarm)}); ${why}`,
          short,
        };
      }
      if (after.editor && after.focused && facts.maxScaleOff <= SCALE_SLACK) return { verdict: "ok", why, short };
      return { verdict: "degraded", why, short };
    }
    let closedAt: number | null = null;
    let unfocusedAt: number | null = null;
    const steps = stateSteps(ctx.variant);
    // reported, not judged: does the open editor stay on its element (the table: on its cell) at the turning point
    const anchor = String(m.element);
    const editorOnElement = async (): Promise<{ editor: Box; element: Box } | null> => {
      const [editor, element] = [
        (await node.query(kit.editor))[0],
        kit.table ? (await node.query(anchor))[0] : await node.elementBox(anchor),
      ];
      return editor && element ? { editor, element } : null;
    };
    const editorStart = await editorOnElement();
    let editorPeak: Awaited<ReturnType<typeof editorOnElement>> = null;
    const series = await zoomSeries(
      board,
      node,
      ctx.variant === "toolbar" ? "toolbar" : "wheel",
      steps,
      start,
      async (step) => {
        const state = await stateOf(node, kit);
        if (!state.editor && closedAt === null) closedAt = step;
        if (!state.focused && unfocusedAt === null) unfocusedAt = step;
        if (step === steps) {
          editorPeak = await editorOnElement();
          await shot(ctx, node, "peak");
        }
      },
    );
    m.editorAgainstItsElement = againstAnchor(editorStart, editorPeak);
    const after = await stateOf(node, kit);
    const disarm = await ruleDisarmOf(board, node.id, rule);
    m.committedBy = await commitLabel(board, node, kit);
    await sleep(800);
    const inFile = (await board.fileText(file))?.includes(TYPED) === true;
    const inEditor = after.editor && after.text?.includes(TYPED) === true;
    const end = await viewOf(node);
    Object.assign(m, {
      ...seriesFacts(series),
      editorClosedAtStep: closedAt,
      focusLostAtStep: unfocusedAt,
      stateAfterTheSteps: after,
      textInEditorAfterTheSteps: inEditor,
      textInFileAfterCommit: inFile,
      driftAfterCommit: drift(start, end),
      armedAfter: await armed(node),
      ...(disarm.armedzoom === "disarm" ? { disarmByRule: disarm } : {}),
    });
    const scale = `scale off ${round(series.scaleOff * 100, 1)} % max (${series.outOfScale} of ${series.steps.length} steps)`;
    const closed =
      closedAt === null
        ? "editor open throughout"
        : `editor closed ${disarm.byRule ? "by the rule's disarm " : ""}at step ${closedAt}`;
    const short = `${closed}, text ${inEditor ? "in editor" : inFile ? "in file" : "LOST"}, ${scale}`;
    if (!inEditor && !inFile)
      return { verdict: "broken", why: `the typed text is in no editor and not in the file (${short})`, short };
    if (disarm.violated) return violation(disarm, short);
    if (disarm.byRule) {
      // armedzoom=disarm: the first step makes the node a preview, the editor closes with it and its text is committed
      const specified =
        disarm.asSpecified &&
        closedAt === 1 &&
        inFile &&
        m.committedBy === "nothing to commit" &&
        series.scaleOff <= SCALE_SLACK;
      return {
        verdict: specified ? "ok" : "degraded",
        why: `${specified ? "as the node's rule specifies" : "NOT as the node's rule specifies"} (${ruleProof(disarm)}): the editor closed at step ${String(closedAt)}, the typed text is ${inFile ? "in the file" : "NOT in the file"} (commit key: ${String(m.committedBy)}), ${scale}`,
        short,
      };
    }
    if (closedAt === null && unfocusedAt === null && series.scaleOff <= SCALE_SLACK) {
      return {
        verdict: "ok",
        why: `editor open and focused through ${series.steps.length} steps, text in the file after the commit, ${scale}`,
        short,
      };
    }
    return {
      verdict: "degraded",
      why: `the text is kept, but ${[closedAt !== null ? `the editor closed at step ${closedAt}` : "", closedAt === null && unfocusedAt !== null ? `the editor lost the focus at step ${unfocusedAt}` : "", series.scaleOff > SCALE_SLACK ? `the picture was up to ${round(series.scaleOff * 100, 1)} % out of scale` : ""].filter(Boolean).join(", ")}`,
      short,
    };
  },
};

/** the shortest distance between two boxes, 0 when they touch or overlap */
function gapBetween(a: Box, b: Box): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

const zoomPopup: CaseDef = {
  name: "zoom-popup",
  did: "Arm a node, select a shape, open the popup menu of its pad, then zoom the board: 20 wheel steps in and 20 back on the bare pane (variant wheel), 3 toolbar clicks in and 3 back (variant toolbar). After every step: is the popup open, where is it against its shape. Variant burst: 20 wheel events a frame apart with the popup open, sampled per frame.",
  expected:
    "diagram-js closes its popup menu on a viewbox change. A host the board scales writes none: the popup stays and scales with the node. A host at net scale 1 writes one per step (the popup closes) unless something holds the write: bpmn-js's popup has a search field with the focus, the others have none.",
  kits: DIAGRAMS,
  variants: zoomVariants,
  zooms: () => [ODD_ZOOM],
  async run(ctx) {
    const { board, node } = await openOne(ctx, ctx.zoom);
    const { kit, m } = ctx;
    await arm(ctx, board, node.id);
    await sleep(150);
    const start = await viewOf(node);
    const { element, popup } = await openPopup(board, node, kit);
    const shape = (await node.elementBox(element))!;
    const offset = { x: popup.x - (shape.x + shape.width), y: popup.y - shape.y };
    // the node's own rule for a board zoom, and the rules' counters before the first step
    const rule = await zoomRuleOf(board, node.id);
    if (ctx.variant === "burst") {
      const facts = await burst(board, node, ".djs-popup");
      const [popupEnd, stateAfter, armedAfter] = [
        (await node.query(".djs-popup"))[0],
        await stateOf(node, kit),
        await armed(node),
      ];
      const disarm = await ruleDisarmOf(board, node.id, rule);
      const kept = !!popupEnd && popupEnd.width > 0;
      await shot(ctx, node, "after-the-burst", popupEnd ? [popupEnd] : []);
      Object.assign(m, {
        element,
        popupStart: popup,
        burst: facts,
        popupKept: kept,
        stateAfter,
        armedAfter,
        ...(disarm.armedzoom === "disarm" ? { disarmByRule: disarm } : {}),
      });
      const short = `${burstShort(facts, armedAfter, disarm.byRule)}, popup ${kept ? "kept" : "closed"}`;
      const why = `${short}; ${facts.frames} frames: out of scale in ${facts.framesOutOfScale} (${facts.framesOutOfScaleWithItShown} with the popup shown), armed at another zoom in ${facts.framesArmedAtAnotherZoom}, first frame at another zoom ${String(facts.firstFrameAtAnotherZoom)}, first frame without the popup ${String(facts.firstFrameWithoutIt)}`;
      if (disarm.violated) return violation(disarm, short);
      if (disarm.byRule) {
        // armedzoom=disarm: a popup belongs to the armed editor and goes with it, before the first zoomed frame
        if (kept)
          return { verdict: "broken", why: `the popup outlived the disarm (${ruleProof(disarm)}); ${why}`, short };
        const specified =
          disarm.asSpecified &&
          !stateAfter.popup &&
          facts.framesArmedAtAnotherZoom === 0 &&
          facts.hookFrames.armedAtAnotherZoom === 0 &&
          facts.maxScaleOff <= SCALE_SLACK;
        return {
          verdict: specified ? "ok" : "degraded",
          why: `${specified ? "as the node's rule specifies" : "NOT as the node's rule specifies"} (${ruleProof(disarm)}); ${why}`,
          short,
        };
      }
      if (!kept) return { verdict: "degraded", why: `${why}: the person opens it again`, short };
      return { verdict: facts.maxScaleOff > SCALE_SLACK ? "degraded" : "ok", why, short };
    }
    const window = board.page.viewportSize() ?? { width: 0, height: 0 };
    let closedAt: number | null = null;
    let maxGap = 0;
    let outside = 0;
    const steps = stateSteps(ctx.variant);
    // reported, not judged: the popup against its shape at the turning point, and whether its first entry takes a press there
    let popupPeak: { editor: Box; element: Box } | null = null;
    let entryAtThePeak: string | null = null;
    const series = await zoomSeries(
      board,
      node,
      ctx.variant === "toolbar" ? "toolbar" : "wheel",
      steps,
      start,
      async (step) => {
        const [now, where] = [(await node.query(".djs-popup"))[0], await node.elementBox(element)];
        if (step === steps) {
          await shot(ctx, node, "peak", now ? [now] : []);
          if (now && now.width > 0 && where) {
            popupPeak = { editor: now, element: where };
            const entry = (await node.query(".djs-popup .entry"))[0];
            const hit = entry && (await node.hit(centre(entry)));
            entryAtThePeak = !entry
              ? "no entry"
              : hit?.reachable && hit.popup
                ? "takes a press"
                : `under ${hit?.what ?? "?"}`;
          }
        }
        if (!now || !(now.width > 0)) {
          closedAt ??= step;
          return false;
        }
        if (where) maxGap = Math.max(maxGap, gapBetween(now, where));
        if (now.x < 0 || now.y < 0 || now.x + now.width > window.width || now.y + now.height > window.height) outside++;
        return true;
      },
    );
    const [popupEnd, shapeEnd] = [(await node.query(".djs-popup"))[0], await node.elementBox(element)];
    const offsetEnd =
      popupEnd && shapeEnd ? { x: popupEnd.x - (shapeEnd.x + shapeEnd.width), y: popupEnd.y - shapeEnd.y } : null;
    const moved = offsetEnd
      ? round(Math.max(Math.abs(offsetEnd.x - offset.x), Math.abs(offsetEnd.y - offset.y)), 2)
      : null;
    const disarm = await ruleDisarmOf(board, node.id, rule);
    Object.assign(m, {
      ...(disarm.armedzoom === "disarm" ? { disarmByRule: disarm } : {}),
      element,
      popupStart: popup,
      popupFromShapeStartPx: { x: round(offset.x), y: round(offset.y) },
      ...seriesFacts(series),
      popupClosedAtStep: closedAt,
      popupAgainstItsShapeAtThePeak: againstAnchor({ editor: popup, element: shape }, popupPeak),
      firstEntryAtThePeak: entryAtThePeak,
      maxGapPopupToShapePx: round(maxGap, 1),
      stepsWithThePopupPartlyOutsideTheWindow: outside,
      popupEnd: popupEnd ?? null,
      popupFromShapeEndPx: offsetEnd && { x: round(offsetEnd.x), y: round(offsetEnd.y) },
      popupMovedAgainstShapePx: moved,
      stateAfter: await stateOf(node, kit),
      armedAfter: await armed(node),
    });
    if (closedAt !== null) {
      const short = `popup closed ${disarm.byRule ? "by the rule's disarm " : ""}at step ${closedAt} of ${2 * steps}`;
      if (disarm.violated) return violation(disarm, short);
      if (disarm.byRule) {
        // armedzoom=disarm: the first step makes the node a preview, and the popup goes with the armed editor
        const specified = disarm.asSpecified && closedAt === 1 && series.scaleOff <= SCALE_SLACK;
        return {
          verdict: specified ? "ok" : "degraded",
          why: `${specified ? "as the node's rule specifies" : "NOT as the node's rule specifies"} (${ruleProof(disarm)}): ${short}, scale off ${round(series.scaleOff * 100, 1)} % max`,
          short,
        };
      }
      return { verdict: "degraded", why: `${short}: the person opens it again`, short };
    }
    if (disarm.violated) return violation(disarm, "popup kept");
    if (disarm.byRule) {
      const short = "popup kept on a node the board zoom disarmed";
      return { verdict: "broken", why: `the popup outlived the disarm (${ruleProof(disarm)})`, short };
    }
    const short = `popup kept, ends ${moved} px from its place, up to ${round(maxGap)} px from its shape meanwhile, scale off ${round(series.scaleOff * 100, 1)} % max${outside > 0 ? `, ${outside} steps partly outside the window` : ""}`;
    if (moved !== null && moved <= PX_JUMP) {
      return series.scaleOff > SCALE_SLACK
        ? { verdict: "degraded", why: `${short}: the popup is kept at the price of a picture out of scale`, short }
        : { verdict: "ok", why: short, short };
    }
    return { verdict: "broken", why: `the popup stayed open but ${short}`, short };
  },
};

const zoomDrag: CaseDef = {
  name: "zoom-drag",
  did: "Arm a node, press on a shape and drag it part of the way (the button stays down), then zoom the board 20 steps in and 20 back (x 1.0425 each, the node's corner fixed) and drag on and release. The board is zoomed through the hook: a wheel under a held pointer goes to the editor, and a hand that holds a shape reaches no toolbar. At the turning point: the diagram's scale against the board's and how far the dragged preview is from the pointer. Variant hook-stay: the 20 steps in only, so the shape is dropped at 2.3 times the board zoom it was pressed at. The hand goes on to the same point of the diagram as in the plain variant, found on screen through the browser's matrix after the zoom. The drop against the point of the diagram under the pointer at the release, and where the shape's grabbed point lies against the resting pointer 0.9 s later.",
  expected:
    "A viewbox write under a held drag would pull the canvas from under it. A host the board scales writes none. A host at net scale 1 holds the write until the drop: the picture is out of scale while the shape is held, and the drop lands where the pointer is once the zoom is back at its start.",
  kits: DIAGRAMS,
  variants: () => ["hook", "hook-stay"],
  zooms: () => [ODD_ZOOM],
  async run(ctx) {
    const { board, node, file } = await openOne(ctx, ctx.zoom);
    const { kit, m } = ctx;
    const stay = ctx.variant === "hook-stay";
    await arm(ctx, board, node.id);
    await sleep(150);
    const [start, hostStart] = [await viewOf(node), await node.hostBox()];
    const { element, grab } = await pick(node, kit, kit.drag);
    const mark = shapeMark(element);
    const from = placeOf(await markOf(node, mark));
    const first = await node.drag(grab, { x: 30 * ctx.zoom, y: 20 * ctx.zoom }, { hold: kit.hold, keepDown: true });
    const held = await stateOf(node, kit);
    let peak: Record<string, unknown> = {};
    let lostAt: number | null = null;
    const series = await zoomSeries(board, node, "hook", 20, start, async (step) => {
      const dragging = (await stateOf(node, kit)).dragging;
      if (!dragging && held.dragging && lostAt === null) lostAt = step;
      if (step !== 20) return;
      const dragger = (await node.query(".djs-dragger"))[0];
      peak = {
        draggerFromPointerPx: dragger
          ? round(Math.hypot(centre(dragger).x - first.to.x, centre(dragger).y - first.to.y), 1)
          : null,
        dragging,
      };
      await shot(ctx, node, "peak");
      // hook-stay: no way back, the shape is dropped at this board zoom
      return !stay;
    });
    // the point of the diagram under a screen point, in the picture as it is drawn at that moment
    const under = (view: View, host: Box, at: Point): Point => ({
      x: view.x + (at.x - host.x) / view.unitPx,
      y: view.y + (at.y - host.y) / view.unitPx,
    });
    let end = { x: first.to.x + 20 * ctx.zoom, y: first.to.y + 10 * ctx.zoom };
    if (stay) {
      // The hand goes on to the SAME point of the diagram the plain variant ends on. Where that point
      // is on screen now is read from the browser's matrix: in a picture that grew with the board it
      // lies elsewhere than in one that was held (and a pointer left where it was would point at
      // another part of the diagram, for BPMN one that refuses the drop)
      const goal = under(start, hostStart, end);
      const [view, host] = [await viewOf(node), await node.hostBox()];
      end = aimAt(await node.map(), {
        x: host.x + (goal.x - view.x) * view.unitPx,
        y: host.y + (goal.y - view.y) * view.unitPx,
      });
    }
    await board.move(end, 4);
    await sleep(40);
    const atRelease = stay ? { view: await viewOf(node), host: await node.hostBox() } : null;
    await board.release(kit.hold);
    const changed = await board.waitForFileChange(file, undefined, 100);
    await sleep(900);
    const landed = placeOf(await markOf(node, mark));
    const pointer = { x: end.x - first.from.x, y: end.y - first.from.y };
    // where the pointer held the shape, in units from the shape's own origin
    const held0 = under(start, hostStart, first.from);
    const hold = from && { x: held0.x - from.x, y: held0.y - from.y };
    const dropAt = atRelease && under(atRelease.view, atRelease.host, end);
    const expected =
      dropAt && hold
        ? { x: dropAt.x - hold.x, y: dropAt.y - hold.y }
        : from && { x: from.x + pointer.x / start.unitPx, y: from.y + pointer.y / start.unitPx };
    const offUnits = apart(landed, expected);
    const finish = await viewOf(node);
    // hook-stay: the shape's grabbed point on screen once everything rests, against the pointer that still rests at `end`
    let restPx: number | null = null;
    if (stay && landed && hold) {
      const hostEnd = await node.hostBox();
      restPx = round(
        Math.hypot(
          hostEnd.x + (landed.x + hold.x - finish.x) * finish.unitPx - end.x,
          hostEnd.y + (landed.y + hold.y - finish.y) * finish.unitPx - end.y,
        ),
        1,
      );
    }
    Object.assign(m, {
      element,
      heldDragging: held.dragging,
      ...seriesFacts(series),
      atTheTurningPoint: peak,
      dragLostAtStep: lostAt,
      pointerPx: { x: round(pointer.x), y: round(pointer.y) },
      from,
      landed,
      expected: expected && { x: round(expected.x, 2), y: round(expected.y, 2) },
      offUnits,
      onScreenRatio: stay || !from || !landed ? null : round(((landed.x - from.x) * start.unitPx) / pointer.x, 3),
      fileHasText: changed !== null,
      driftAfterDrop: drift(start, finish),
      armedAfter: await armed(node),
      ...(stay
        ? {
            boardZoomAtTheDrop: round((await board.viewport()).zoom, 4),
            pictureScaleAtTheRelease: atRelease && round(atRelease.view.unitPx / start.unitPx, 4),
            pictureScaleAtRest: round(finish.unitPx / start.unitPx, 4),
            grabbedPointFromThePointerAtRestPx: restPx,
          }
        : {}),
    });
    const slack = UNIT_SLACK + kit.grid;
    const scale = `scale off ${round(series.scaleOff * 100, 1)} % max`;
    const short = stay
      ? `drop ${offUnits} u off the point under the pointer, at rest ${restPx} px from the pointer, ${scale}`
      : `drop ${offUnits} u off (ratio ${String(m.onScreenRatio)}), ${scale}`;
    if (apart(landed, from) === 0)
      return {
        verdict: "broken",
        why: `the shape did not move: the drag was lost${lostAt === null ? "" : ` at step ${lostAt}`}`,
        short,
      };
    if (!(offUnits <= slack))
      return {
        verdict: "broken",
        why: `the shape landed ${offUnits} units from where the pointer went (slack ${slack})`,
        short,
      };
    if (series.scaleOff > SCALE_SLACK)
      return {
        verdict: "degraded",
        why: `the drop is right (${offUnits} units off), but the picture was up to ${round(series.scaleOff * 100, 1)} % out of scale while the shape was held${restPx === null ? "" : `; at rest the shape's grabbed point is ${restPx} px from the pointer`}`,
        short,
      };
    if (restPx !== null && restPx > PX_JUMP)
      return {
        verdict: "degraded",
        why: `the drop is right (${offUnits} units off) and the picture stayed in scale, but at rest the shape's grabbed point is ${restPx} px from the pointer`,
        short,
      };
    return { verdict: "ok", why: `the drop is ${offUnits} units off and the picture stayed in scale`, short };
  },
};

// ── cases: the board pans, the node moves ────────────────────────────────────

interface GapStats {
  frames: number;
  /** frames in which the node body had moved since the frame before */
  movingFrames: number;
  /** host against body at rest, before the gesture: x, y, width, height in px */
  rest: number[];
  /** the largest deviation of the host's corner from where it rests against the body, over all frames */
  maxGapPx: number;
  /** the largest deviation of the host's size from the body's, against rest */
  maxSizeGapPx: number;
}

/**
 * Starts sampling host against body in the board page, once per animation frame, in a task right
 * AFTER the frame's callbacks (a message posted from requestAnimationFrame): what the frame painted.
 * The host is the engine's host element, or the frame element of a node that is a frame.
 */
const startGapSampler = (board: Board, node: NodeHandle): Promise<void> =>
  board.page.evaluate(
    ([key, id, frameName]) => {
      const page = window as unknown as Record<string, { engine(id: string): unknown } | undefined> & {
        __gap?: { stop(): number[][] };
      };
      const native = (window as NativeWindow).__boardSpikeNative;
      const rect = (element: Element): DOMRect => (native ? native.rect(element) : element.getBoundingClientRect());
      const body = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"] .board-node__body`);
      const host = (): Element | null =>
        frameName !== null
          ? document.querySelector(`iframe[name="${CSS.escape(frameName)}"]`)
          : ((page[key]?.engine(id) as { host?: Element } | undefined)?.host ?? null);
      const samples: number[][] = [];
      let on = true;
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        const element = host();
        if (!body || !element) return;
        const [b, h] = [rect(body), rect(element)];
        samples.push([h.x - b.x, h.y - b.y, h.width - b.width, h.height - b.height, b.x, b.y, b.width, b.height]);
      };
      const tick = (): void => {
        if (!on) return;
        channel.port2.postMessage(0);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      page.__gap = {
        stop() {
          on = false;
          return samples;
        },
      };
    },
    [HOOKS_KEY, node.id, node.info.frameName ?? null] as const,
  );

async function stopGapSampler(board: Board): Promise<GapStats> {
  const samples = await board.page.evaluate(
    () => (window as unknown as { __gap?: { stop(): number[][] } }).__gap?.stop() ?? [],
  );
  const rest = samples[0] ?? [0, 0, 0, 0];
  let [maxGap, maxSize, moving] = [0, 0, 0];
  samples.forEach((sample, index) => {
    maxGap = Math.max(maxGap, Math.abs(sample[0]! - rest[0]!), Math.abs(sample[1]! - rest[1]!));
    maxSize = Math.max(maxSize, Math.abs(sample[2]! - rest[2]!), Math.abs(sample[3]! - rest[3]!));
    const previous = samples[index - 1];
    if (previous && [4, 5, 6, 7].some((at) => sample[at] !== previous[at])) moving++;
  });
  return {
    frames: samples.length,
    movingFrames: moving,
    rest: rest.slice(0, 4).map((value) => round(value, 2)),
    maxGapPx: round(maxGap, 2),
    maxSizeGapPx: round(maxSize, 2),
  };
}

/** a drag slow enough for animation frames in between: `steps` moves, `pause` ms apart; the first move is 3 px along x */
async function slowDrag(board: Board, from: Point, to: Point, steps = 30, pause = 12): Promise<void> {
  const { mouse } = board.page;
  await mouse.move(from.x, from.y);
  await mouse.down();
  await mouse.move(from.x + 3 * Math.sign(to.x - from.x || 1), from.y);
  for (let step = 1; step <= steps; step++) {
    await mouse.move(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
    await sleep(pause);
  }
  await sleep(60);
  await mouse.up();
}

/**
 * `disarm`: only where the gesture is a board zoom (pan's wheel variant). Under armedzoom=disarm the
 * node is a preview from the first notch by its own rule, and the gap alone decides; a disarm that
 * is not the rule's (any other gesture, any other policy) is broken, as it always was.
 */
function gapVerdict(stats: GapStats, stillArmed: boolean, what: string, disarm?: RuleDisarm): Outcome {
  const restGap = Math.max(Math.abs(stats.rest[0] ?? 0), Math.abs(stats.rest[1] ?? 0));
  const byRule = !stillArmed && disarm?.byRule === true;
  const short = `gap ${stats.maxGapPx} px max over ${stats.movingFrames} moving frames, rest ${round(restGap, 2)} px${stillArmed ? "" : byRule ? ", disarmed by rule" : ", DISARMED"}`;
  const sampled = `${what}: the host's corner deviated ${stats.maxGapPx} px at most from its rest place against the body (rest gap ${round(restGap, 2)} px, size ${stats.maxSizeGapPx} px) in ${stats.frames} frames, ${stats.movingFrames} of them with the node moving`;
  if (disarm?.violated) return violation(disarm, short);
  if (!stillArmed && !byRule) return { verdict: "broken", why: `${sampled}; the node was disarmed`, short };
  if (disarm && byRule && !disarm.asSpecified) {
    return {
      verdict: "broken",
      why: `${sampled}; the node was disarmed, NOT as its rule specifies (${ruleProof(disarm)})`,
      short,
    };
  }
  const why =
    disarm && byRule
      ? `${sampled}; the node is a preview from the first notch, as its rule specifies (${ruleProof(disarm)})`
      : sampled;
  const gap = Math.max(stats.maxGapPx, restGap);
  if (gap <= PX_STILL) return { verdict: "ok", why, short };
  return { verdict: gap <= PX_JUMP ? "degraded" : "broken", why, short };
}

const pan: CaseDef = {
  name: "pan",
  did: "Arm a node at board zoom 0.8137 and pan the board: drag the bare pane by (160, 90) px in 30 moves (variant drag), and turn the wheel on the pane, 6 notches in and 6 back (variant wheel: this board has no wheel pan, a wheel zooms about the pointer, which moves the node too; a horizontal wheel and Shift + wheel are tried first and recorded). The host's client rect against the node body's, sampled once per animation frame after the frame's callbacks.",
  expected:
    "A host inside the node moves with it by construction. A host outside the node (a layer above the board) is placed by script: one frame of lag would show as a gap of the pan's speed (about 5 px per frame here).",
  kits: KIT_IDS,
  variants: () => ["drag", "wheel"],
  zooms: () => [ODD_ZOOM],
  async run(ctx) {
    const { board, node } = await openOne(ctx, ctx.zoom);
    const { m } = ctx;
    await arm(ctx, board, node.id);
    await sleep(150);
    let [viewStart, viewportStart] = [await viewOf(node), await board.viewport()];
    let rule: ZoomRule | null = null;
    if (ctx.variant === "drag") {
      const free = await board.freePanePoint();
      if (!free) throw new Unmeasured("no bare pane point to drag");
      const from = { x: free.x - 40, y: free.y - 40 };
      await startGapSampler(board, node);
      await frames(board, 3);
      await slowDrag(board, from, { x: from.x - 160, y: from.y - 90 });
      await frames(board, 3);
    } else {
      // does any wheel PAN this board?
      await board.wheel(pivotOf(board), 0, { deltaX: 120 });
      await frames(board);
      const afterHorizontal = await board.viewport();
      await board.wheel(pivotOf(board), 60, { hold: ["Shift"] });
      await frames(board);
      const afterShift = await board.viewport();
      m.horizontalWheel = {
        ...afterHorizontal,
        panned: afterHorizontal.x !== viewportStart.x && afterHorizontal.zoom === viewportStart.zoom,
      };
      m.shiftWheel = {
        ...afterShift,
        panned: afterShift.zoom === afterHorizontal.zoom && afterShift.x !== afterHorizontal.x,
      };
      await board.wheel(pivotOf(board), -60, { hold: ["Shift"] });
      await frames(board);
      // armedzoom=disarm: a probe that zoomed the board made the node a preview, by rule. What this
      // case samples is the ARMED editor's host, so the node is armed again first (the board may
      // move once more), and the 12 notches then start from an armed node
      if (!(await armed(node)) && (await board.armPolicy(node.id))?.armedzoom === "disarm") {
        const probes = (await board.counters()).arm;
        await board.arm(node.id);
        await sleep(150);
        [viewStart, viewportStart] = [await viewOf(node), await board.viewport()];
        m.armedAgainAfterTheProbes = {
          disarmsBeforeZoomByTheProbes: probes.disarmsBeforeZoom,
          viewport: flatViewport(viewportStart),
          armed: await armed(node),
        };
      }
      rule = await zoomRuleOf(board, node.id);
      await startGapSampler(board, node);
      await frames(board, 3);
      for (const direction of [1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1]) {
        await board.wheel(pivotOf(board), -WHEEL_DELTA * direction);
        await sleep(30);
      }
      await frames(board, 3);
    }
    const stats = await stopGapSampler(board);
    const [viewEnd, viewportEnd, stillArmed] = [await viewOf(node), await board.viewport(), await armed(node)];
    // the wheel variant is a board zoom: what the node's rule made of it
    const disarm = rule ? await ruleDisarmOf(board, node.id, rule) : undefined;
    Object.assign(m, {
      viewportStart,
      viewportEnd,
      gap: stats,
      viewDrift: drift(viewStart, viewEnd),
      armedAfter: stillArmed,
      ...(disarm?.armedzoom === "disarm" ? { disarmByRule: disarm } : {}),
    });
    if (ctx.variant === "drag" && viewportEnd.x === viewportStart.x)
      throw new Unmeasured("the pane drag did not pan the board");
    return gapVerdict(
      stats,
      stillArmed,
      ctx.variant === "drag" ? "pane drag" : "wheel zoom about a point beside the node",
      disarm,
    );
  },
};

const nodeMove: CaseDef = {
  name: "node-move",
  did: "Arm a node at board zoom 0.8137. Variant header-drag: drag it by its header, (120, 70) px in 30 moves. Variant resize: drag its bottom right handle until the node is 500 x 320 flow units. The host against the node body per animation frame, the visible rectangle before and after, and after the resize the palette against the host.",
  expected:
    "The editor follows the node. After a resize the node shows less of the diagram at the same scale from the same corner (the view is the node's, it does not refit); chrome that keeps its screen size or that the engine lays out for a larger canvas may no longer fit.",
  kits: KIT_IDS,
  variants: () => ["header-drag", "resize"],
  zooms: () => [ODD_ZOOM],
  async run(ctx) {
    const { board, node } = await openOne(ctx, ctx.zoom);
    const { m } = ctx;
    // flow units per screen px: the zoom in effect, not the one asked for
    const { zoom } = await arm(ctx, board, node.id);
    await sleep(150);
    const [viewStart, boxStart, boardStart] = [
      await viewOf(node),
      (await board.nodeBox(node.id))!,
      await board.boardText(),
    ];
    const part = (selector: string): Promise<Box | null> =>
      board.page.evaluate(
        ([id, inner]) => {
          const element = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"] ${inner}`);
          if (!element) return null;
          const native = (window as NativeWindow).__boardSpikeNative;
          const { x, y, width, height } = native ? native.rect(element) : element.getBoundingClientRect();
          return { x, y, width, height };
        },
        [node.id, selector] as const,
      );
    const header = await part(".board-node__header");
    if (!header) throw new Error("the node has no header");
    // on the title, clear of the Done button at the right
    const grip = { x: Math.round(header.x + 70), y: Math.round(header.y + header.height / 2) };
    if (ctx.variant === "header-drag") {
      await startGapSampler(board, node);
      await frames(board, 3);
      await slowDrag(board, grip, { x: grip.x + 120, y: grip.y + 70 });
      await frames(board, 3);
    } else {
      // the resize handles show on a selected node
      if (!(await part(".react-flow__resize-control.handle.bottom.right"))) await board.click(grip);
      const handle = await board.waitForBox(() => part(".react-flow__resize-control.handle.bottom.right"));
      if (!handle) throw new Unmeasured("the node shows no resize handle");
      const from = { x: Math.round(handle.x + handle.width / 2), y: Math.round(handle.y + handle.height / 2) };
      const top = await topElementAt(board, from);
      m.onTopOfTheHandle = top;
      await startGapSampler(board, node);
      await frames(board, 3);
      await slowDrag(board, from, {
        x: Math.round(from.x + (500 - boxStart.width / zoom) * zoom) + 3,
        y: Math.round(from.y + (320 - boxStart.height / zoom) * zoom),
      });
      await frames(board, 3);
    }
    await sleep(300);
    const stats = await stopGapSampler(board);
    const [viewEnd, boxEnd, stillArmed, host] = [
      await viewOf(node),
      (await board.nodeBox(node.id))!,
      await armed(node),
      await node.hostBox(),
    ];
    const moved = drift(viewStart, viewEnd);
    const sizeFlow = { width: round(boxEnd.width / zoom, 1), height: round(boxEnd.height / zoom, 1) };
    Object.assign(m, {
      nodeMovedPx: { x: round(boxEnd.x - boxStart.x, 1), y: round(boxEnd.y - boxStart.y, 1) },
      nodeSizeFlowUnits: sizeFlow,
      gap: stats,
      before: flatView(viewStart),
      after: flatView(viewEnd),
      drift: moved,
      boardFileChanged: (await board.boardText()) !== boardStart,
      armedAfter: stillArmed,
    });
    const outcome = gapVerdict(stats, stillArmed, ctx.variant);
    const scaleOff = Math.abs(moved.scale - 1);
    // an HTML view has no viewbox: its layout flows into the new width, which is no jump of a view
    const view =
      moved.px <= PX_STILL && scaleOff <= SCALE_SLACK
        ? "stays"
        : scaleOff > SCALE_SLACK
          ? "rescaled"
          : viewEnd.html
            ? "reflowed"
            : "shifted";
    m.viewAfter = view;
    let short = `${outcome.short}; view ${view} (${moved.units} u, x${moved.scale})`;
    let verdict = outcome.verdict;
    let why = `${outcome.why}; the view ${view}: origin ${moved.units} units = ${moved.px} px, scale x${moved.scale}`;
    if (view === "rescaled" || view === "shifted") {
      verdict = worst(verdict, moved.px <= PX_JUMP && scaleOff <= 0.02 ? "degraded" : "broken");
    }
    if (ctx.variant === "resize") {
      if (Math.abs(sizeFlow.width - 500) > 4 || Math.abs(sizeFlow.height - 320) > 4) {
        throw new Unmeasured(`the resize ended at ${sizeFlow.width} x ${sizeFlow.height} flow units, not at 500 x 320`);
      }
      const [palette, entries] = [(await node.query(".djs-palette"))[0], await node.query(".djs-palette .entry")];
      const inside = entries.filter(
        (entry) =>
          entry.x >= host.x - 0.5 &&
          entry.y >= host.y - 0.5 &&
          entry.x + entry.width <= host.x + host.width + 0.5 &&
          entry.y + entry.height <= host.y + host.height + 0.5,
      ).length;
      const shapes = await node.elementIds();
      let visible = 0;
      for (const id of shapes) {
        const box = await node.elementBox(id);
        if (
          box &&
          clip(box, host) &&
          box.x >= host.x &&
          box.y >= host.y &&
          box.x + box.width <= host.x + host.width &&
          box.y + box.height <= host.y + host.height
        )
          visible++;
      }
      Object.assign(m, {
        hostPx: { width: round(host.width, 1), height: round(host.height, 1) },
        palettePx: palette ? { width: round(palette.width, 1), height: round(palette.height, 1) } : null,
        paletteCutPx: palette ? round(Math.max(0, palette.y + palette.height - (host.y + host.height)), 1) : null,
        paletteEntries: entries.length,
        paletteEntriesInsideTheHost: inside,
        shapesWhollyVisible: `${visible} of ${shapes.length}`,
      });
      await shot(ctx, node, "resized");
      short += `; palette ${inside}/${entries.length} entries inside, cut ${String(m.paletteCutPx)} px; ${visible}/${shapes.length} shapes visible`;
      if (entries.length > 0 && inside < entries.length) {
        verdict = worst(verdict, "degraded");
        why += `; ${entries.length - inside} of ${entries.length} palette entries lie outside the host (the palette is ${String(m.paletteCutPx)} px too high)`;
      }
    }
    return { verdict, why, short };
  },
};

// ── cases: arm, disarm, preview ──────────────────────────────────────────────

/** an element the cases can watch on screen: the first drawn one of the kit's lists; the table: its cell */
async function landmark(node: NodeHandle, kit: Kit): Promise<Box | null> {
  if (kit.table) return (await node.query(CELL))[0] ?? null;
  for (const element of [...kit.drag, ...kit.label]) {
    const box = await node.elementBox(element);
    if (box) return box;
  }
  return null;
}
const corner = (a: Box | null, b: Box | null): number =>
  a && b ? round(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)), 2) : Number.NaN;

/**
 * Two things that are no editing chrome and still change when a node is armed: the text of a
 * label (laid out at layout size and scaled by the board, or laid out at the scaled size) and the
 * bpmn.io mark (scaled by the board, or at its screen size). Their boxes on screen.
 */
async function textAndMark(node: NodeHandle, kit: Kit): Promise<{ label: Box | null; mark: Box | null }> {
  let label: Box | null = null;
  for (const element of kit.table ? [] : [...kit.drag, ...kit.label]) {
    label ??= (await node.query(`[data-element-id="${element}"] > .djs-visual text`))[0] ?? null;
  }
  return { label, mark: (await node.query(".bjs-powered-by"))[0] ?? null };
}
const sizeOf = (box: Box | null): string => (box ? `${round(box.width, 1)}x${round(box.height, 1)}` : "none");

/** what of the editing chrome is SHOWN (a box and not `visibility: hidden`), with its box in the node's document */
const CHROME = [
  ".djs-palette",
  ".djs-context-pad",
  ".djs-popup",
  ".djs-hover-tooltip",
  ".djs-direct-editing-parent",
  ".djs-search-container",
  ".dmn-definitions",
  ".view-drd",
  ".dmn-sim-decision-requirements-diagram-panel",
  ".wardley-explore-hint",
  ".wardley-label-input",
  ".cm-pad-prompt",
];
const READ_CHROME = (
  host: HTMLElement,
  arg: { selectors: string[]; node: string | null },
): Array<{ what: string; box: Box }> => {
  const native = (window as NativeWindow).__boardSpikeNative;
  const popupHost =
    arg.node === null
      ? undefined
      : [...document.querySelectorAll<HTMLElement>(".board-popup-host")].find((one) => one.dataset.node === arg.node);
  const roots: Element[] = popupHost ? [host, popupHost] : [host];
  const found: Array<{ what: string; box: Box }> = [];
  for (const selector of arg.selectors) {
    for (const element of roots.flatMap((root) => [...root.querySelectorAll(selector)])) {
      const { x, y, width, height } = native ? native.rect(element) : element.getBoundingClientRect();
      if (width > 0 && height > 0 && getComputedStyle(element).visibility !== "hidden") {
        found.push({ what: selector, box: { x, y, width, height } });
      }
    }
  }
  return found;
};
async function chromeOf(node: NodeHandle): Promise<Array<{ what: string; box: Box }>> {
  const [map, raw] = [
    await node.map(),
    await node.inDocument(READ_CHROME, { selectors: CHROME, node: node.frame ? null : node.id }),
  ];
  return raw.map(({ what, box }) => ({
    what,
    box: {
      x: map.x + box.x * map.sx,
      y: map.y + box.y * map.sy,
      width: box.width * map.sx,
      height: box.height * map.sy,
    },
  }));
}

const armDisarm: CaseDef = {
  name: "arm-disarm",
  did: `A node as a preview, armed (the hook), with a label typed ("${TYPED}", the editor left open), and disarmed by a click on the bare pane. Each time: the visible diagram rectangle, where one shape is on screen, the palette's size. After the disarm: selection, open editors, the focus, the file.`,
  expected:
    "Arming must not move the picture: the same rectangle, the same shape at the same screen place. What may jump is the chrome (hidden in preview). A disarm ends the edit as a click outside does: the typed label is kept, nothing stays selected or open, the keys are the board's.",
  kits: KIT_IDS,
  variants: () => [""],
  zooms: () => [1, ODD_ZOOM],
  async run(ctx) {
    const { board, node, file } = await openOne(ctx, ctx.zoom);
    const { kit, m } = ctx;
    const [viewPreview, markPreview, chromePreview] = [
      await viewOf(node),
      await landmark(node, kit),
      await chromeOf(node),
    ];
    const partsPreview = await textAndMark(node, kit);
    const [viewportPreview, canvas] = [await board.viewport(), await board.canvasBox()];
    const viewportArmed = await arm(ctx, board, node.id);
    // the arm rules may have moved the board: the picture is compared with the preview as that move alone leaves it
    const zoomRatio = viewportArmed.zoom / viewportPreview.zoom;
    await sleep(200);
    const [viewArmed, markArmed, chromeArmed] = [await viewOf(node), await landmark(node, kit), await chromeOf(node)];
    const partsArmed = await textAndMark(node, kit);
    const palette = chromeArmed.find((one) => one.what === ".djs-palette")?.box;
    let typed: string;
    try {
      typed = await typeLabel(board, node, kit);
    } catch (error) {
      if (!(error instanceof Unmeasured)) throw error;
      typed = `not typed: ${error.message}`;
    }
    const typing = await stateOf(node, kit);
    await shot(ctx, node, "armed");
    const free = await board.freePanePoint();
    if (!free) throw new Unmeasured("no bare pane point to click");
    await board.click(free);
    const disarmed = (await board.waitFor(async () => !(await armed(node)), WAIT)) === true;
    await sleep(700);
    const [viewAfter, markAfter, chromeAfter, after] = [
      await viewOf(node),
      await landmark(node, kit),
      await chromeOf(node),
      await stateOf(node, kit),
    ];
    const inFile = (await board.fileText(file))?.includes(TYPED) === true;
    const focus = await board.page.evaluate(() => {
      const active = document.activeElement;
      return active
        ? `${active.tagName.toLowerCase()}${active.getAttribute("name") ? `[name=${active.getAttribute("name")}]` : ""}`
        : "none";
    });
    const [armingRaw, disarming] = [drift(viewPreview, viewArmed), drift(viewArmed, viewAfter)];
    // the scale against the board's: a move to another zoom changes the picture's scale by the zoom's ratio
    const arming =
      zoomRatio === 1
        ? armingRaw
        : { ...armingRaw, scale: round(viewArmed.unitPx / viewPreview.unitPx / zoomRatio, 5) };
    // the label's text changes a Wardley component's box: its corner is what is compared
    const shift = {
      arm: corner(carried(markPreview, viewportPreview, viewportArmed, canvas), markArmed),
      disarm: corner(markArmed, markAfter),
    };
    Object.assign(m, {
      preview: flatView(viewPreview),
      armed: flatView(viewArmed),
      after: flatView(viewAfter),
      driftOnArming: arming,
      driftOnDisarming: disarming,
      shapeShiftPx: shift,
      // what the rule costs the eye: how far the landmark travelled on screen while the board moved (0 without a move)
      landmarkTravelOnArmingPx:
        zoomRatio === 1 && sameViewport(viewportPreview, viewportArmed) ? 0 : corner(markPreview, markArmed),
      // not chrome, and they change all the same: a label's text box and the bpmn.io mark, preview against armed
      labelTextPx: { preview: sizeOf(partsPreview.label), armed: sizeOf(partsArmed.label) },
      labelTextWidthArmedOverPreview:
        partsPreview.label && partsArmed.label
          ? round(partsArmed.label.width / partsPreview.label.width / zoomRatio, 4)
          : null,
      bpmnIoMarkPx: { preview: sizeOf(partsPreview.mark), armed: sizeOf(partsArmed.mark) },
      chromeShownInPreview: chromePreview.map((one) => one.what),
      chromeShownArmed: chromeArmed.map((one) => one.what),
      chromeShownAfter: chromeAfter.map((one) => one.what),
      palettePx: palette ? { width: round(palette.width, 1), height: round(palette.height, 1) } : null,
      typed,
      stateWhileTyping: typing,
      disarmedByThePaneClick: disarmed,
      stateAfter: after,
      focusAfter: focus,
      textInFileAfter: inFile,
    });
    const px = Math.max(arming.px, disarming.px, shift.arm || 0, shift.disarm || 0);
    const scaleOff = Math.max(Math.abs(arming.scale - 1), Math.abs(disarming.scale - 1));
    const wasTyped = typing.editor && typing.text?.includes(TYPED) === true;
    const leftovers = [
      after.editor ? "an editor" : "",
      after.selected.length > 0 ? "a selection" : "",
      after.popup ? "a popup" : "",
      // what a fresh preview shows anyway is the preview case's finding, not something the disarm left
      ...chromeAfter
        .map((one) => one.what)
        .filter((what) => !chromePreview.some((one) => one.what === what))
        .map((what) => `chrome ${what}`),
    ].filter(Boolean);
    const short = `arm ${arming.units} u / ${Math.max(arming.px, shift.arm || 0)} px, disarm ${disarming.units} u / ${Math.max(disarming.px, shift.disarm || 0)} px, palette ${palette ? `${Math.round(palette.width)}x${Math.round(palette.height)}` : "none"}, text ${!wasTyped ? "not typed" : inFile ? "in file" : "LOST"}${leftovers.length > 0 ? `, stays: ${leftovers.join(", ")}` : ""}`;
    const why = `the picture moved ${px} px at most (scale ${round(scaleOff * 100, 3)} % off); ${wasTyped ? `typed label ${inFile ? "is" : "is NOT"} in the file` : typed}; after the disarm: ${leftovers.join(", ") || "nothing selected or open"}, focus on ${focus}`;
    if (!disarmed) return { verdict: "broken", why: `a click on the bare pane did not disarm the node; ${why}`, short };
    if (wasTyped && !inFile) return { verdict: "broken", why, short };
    if (px > PX_JUMP || scaleOff > 0.02) return { verdict: "broken", why, short };
    if (px > PX_STILL || scaleOff > SCALE_SLACK || leftovers.length > 0) return { verdict: "degraded", why, short };
    return { verdict: "ok", why, short };
  },
};

/** a shape drag by a known pointer travel: what the smoke run measures, with the on-screen ratio */
async function smokeDrag(
  ctx: Ctx,
  board: Board,
  node: NodeHandle,
  file: string,
  travelFrom: (grab: Point) => Point,
): Promise<{ ok: boolean; why: string; ratio: Point; element: string; box: Box }> {
  const { kit, m } = ctx;
  const { element, grab, covered, box } = await pick(node, kit, kit.drag);
  if (covered.length > 0) m.covered = covered;
  const mark = shapeMark(element);
  const [from, unitPx, text] = [
    placeOf(await markOf(node, mark)),
    (await viewOf(node)).unitPx,
    await board.fileText(file),
  ];
  const travel = travelFrom(grab);
  const dropOn = await node.hit({ x: grab.x + travel.x, y: grab.y + travel.y });
  const dragged = await node.drag(grab, travel, { hold: kit.hold });
  const changed = (await board.waitForFileChange(file, text, 2500)) !== null;
  await sleep(200);
  const to = placeOf(await markOf(node, mark));
  const moved =
    from && to ? { x: (to.x - from.x) * unitPx, y: (to.y - from.y) * unitPx } : { x: Number.NaN, y: Number.NaN };
  const ratio = { x: round(moved.x / dragged.delta.x, 3), y: round(moved.y / dragged.delta.y, 3) };
  const slack = (axis: "x" | "y"): number =>
    Math.max(0.05 * Math.abs(dragged.delta[axis]), (UNIT_SLACK + kit.grid) * unitPx);
  const ok = Math.abs(moved.x - dragged.delta.x) <= slack("x") && Math.abs(moved.y - dragged.delta.y) <= slack("y");
  Object.assign(m, {
    element,
    pointerPx: { x: round(dragged.delta.x), y: round(dragged.delta.y) },
    movedOnScreenPx: { x: round(moved.x), y: round(moved.y) },
    ratio,
    unitPx: round(unitPx, 4),
    netScale: round(await node.netScale(), 4),
    fileChanged: changed,
    onTopAtTheDropPoint: dropOn.reachable ? dropOn.what.slice(0, 60) : "outside the editor",
  });
  const refused =
    moved.x === 0 && moved.y === 0
      ? `: the move was refused (at the drop point: ${dropOn.reachable ? (dropOn.palette ? "the editor's palette" : dropOn.what.slice(0, 40)) : "nothing of the editor"})`
      : "";
  return {
    ok,
    why: `the shape moved ${round(moved.x)} / ${round(moved.y)} px on screen for a pointer travel of ${round(dragged.delta.x)} / ${round(dragged.delta.y)} px (ratio ${ratio.x} / ${ratio.y}, net scale ${String(m.netScale)})${refused}`,
    ratio,
    element,
    box,
  };
}

/** one notch of diagram-js's wheel zoom is x 1.16 (ZoomScroll: 20 steps between 0.2 and 4), snapped to its steps */
const NOTCH = { min: 1.05, max: 1.4 };

const extreme: CaseDef = {
  name: "extreme",
  did: "The board at zoom 0.1, 0.25, 3 and 4 (its limits are 0.1 and 4). Arm the node with a real double-click on its body, drag a shape (60 flow units of pointer travel, at least 12 px, kept inside the host), then one Control + wheel notch in and one out inside the editor: the diagram's own scale before and after.",
  expected:
    "diagram-js's wheel zoom keeps its scale between 0.2 and 4 and snaps to steps of x 1.16; the product's guard (keepWheelZoomDirection) drops a notch that would go the wrong way at a limit. Where the engine's scale carries the board zoom (a host at net scale 1), a small board zoom puts it below 0.2: a notch then jumps to the limit or does nothing. A host the board scales keeps the engine's scale where it was, and keeps its pointer error. Chrome that keeps its screen size covers a node of 80 x 54 px.",
  kits: DIAGRAMS,
  variants: () => [""],
  zooms: () => [0.1, 0.25, 3, 4],
  fixedZooms: true,
  async run(ctx) {
    const { board, node, file } = await openOne(ctx, ctx.zoom);
    const { kit, m } = ctx;
    const [canvas, body] = [await board.canvasBox(), await bodyBox(board, node.id)];
    const inWindow =
      body && clip(body, { x: canvas.x, y: canvas.y + 60, width: canvas.width, height: canvas.height - 60 });
    if (!inWindow) throw new Unmeasured("the node body is not in the window");
    // right of the middle and low: in the window at every zoom, clear of the palette at the left
    const at = {
      x: Math.round(inWindow.x + inWindow.width * 0.75),
      y: Math.round(inWindow.y + Math.min(inWindow.height * 0.9, inWindow.height - 3)),
    };
    const viewportBefore = await board.viewport();
    await board.doubleClick(at);
    const byDoubleClick = (await board.waitFor(() => armed(node), WAIT)) === true;
    if (!byDoubleClick) await board.arm(node.id);
    // the arm rules may move the board first: nothing is read before it rests
    await board.waitForRest();
    const { zoom } = await noteArming(ctx, board, node.id, viewportBefore);
    await sleep(250);
    // the second click may have reached the editor: nothing of it must stay open
    const afterArming = await stateOf(node, kit);
    if (afterArming.editor || afterArming.popup) await board.press("Escape");
    const chrome = await chromeOf(node);
    const palette = chrome.find((one) => one.what === ".djs-palette")?.box;
    const host = await node.hostBox();
    Object.assign(m, {
      armedByDoubleClick: byDoubleClick,
      stateRightAfterArming: afterArming,
      hostPx: { width: round(host.width, 1), height: round(host.height, 1) },
      palettePx: palette ? { width: round(palette.width, 1), height: round(palette.height, 1) } : null,
      ownScale: (await node.viewportMatrix())?.a,
    });
    await shot(ctx, node, "armed");
    // a person pans the board to what they want to edit: the first drawn candidate to the middle of the window
    for (const element of kit.drag) {
      const box = await node.elementBox(element);
      if (!box) continue;
      const [middle, target] = [centre(box), { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 }];
      const inWindow = clip(box, {
        x: canvas.x + 40,
        y: canvas.y + 80,
        width: canvas.width - 80,
        height: canvas.height - 120,
      });
      if (!inWindow || inWindow.width < box.width - 1 || inWindow.height < box.height - 1) {
        const viewport = await board.viewport();
        await board.setViewport({
          ...viewport,
          x: viewport.x + target.x - middle.x,
          y: viewport.y + target.y - middle.y,
        });
        m.pannedTheBoardToTheElement = true;
      }
      break;
    }
    const hostNow = await node.hostBox();
    // at least 12 px (the engine's drag threshold is 5), kept inside the host: towards its far edge
    // where there is room for half the travel, else the other way
    const want = Math.max(12, 60 * zoom);
    const along = (from: number, low: number, high: number, wanted: number): number => {
      const [before, after] = [from - low - 8, high - from - 8];
      return after >= wanted / 2 ? Math.min(wanted, after) : -Math.min(wanted, Math.max(0, before));
    };
    let drag: Awaited<ReturnType<typeof smokeDrag>> | undefined;
    let noElement = "";
    try {
      drag = await smokeDrag(ctx, board, node, file, (grab) => ({
        x: along(grab.x, hostNow.x, Math.min(hostNow.x + hostNow.width, canvas.x + canvas.width), want),
        y: along(grab.y, hostNow.y, Math.min(hostNow.y + hostNow.height, canvas.y + canvas.height), (want * 2) / 3),
      }));
    } catch (error) {
      if (!(error instanceof Unmeasured)) throw error;
      noElement = error.message;
      m.noElement = noElement;
    }
    // the engine's own wheel zoom, over the diagram: the dragged shape, else the middle of what the window shows of the host
    const shown = clip(hostNow, canvas);
    let wheelAt: Point | null = null;
    const onTop: string[] = [];
    for (const over of [drag ? ((await node.elementBox(drag.element)) ?? drag.box) : null, shown]) {
      if (!over || wheelAt) continue;
      const map = await node.map();
      const point = aimAt(map, centre(over));
      const hit = await node.hit(point);
      // on the canvas itself: the engine's wheel listener is on its container, and the palette, a pad
      // or the bpmn.io mark (a sibling of the container) on top of it would take the wheel
      const onCanvas = await node.inDocument(
        (host, at) => {
          const native = (window as NativeWindow).__boardSpikeNative;
          const top = native ? native.elementFromPoint(document, at.x, at.y) : document.elementFromPoint(at.x, at.y);
          return !!top && host.contains(top) && top.closest(".djs-container") !== null;
        },
        { x: (point.x - map.x) / map.sx, y: (point.y - map.y) / map.sy },
      );
      if (hit.reachable && onCanvas && !hit.palette && !hit.pad) wheelAt = point;
      else onTop.push(hit.reachable ? hit.what.slice(0, 40) : "outside the editor");
    }
    if (!wheelAt) m.noWheelPoint = `chrome on top of the diagram at the points tried: ${onTop.join("; ")}`;
    let notch: {
      before: number;
      afterIn: number;
      afterOut: number;
      in: number;
      out: number;
      boardZoomChanged: boolean;
    } | null = null;
    if (wheelAt) {
      const read = async (): Promise<number> => (await node.viewportMatrix())?.a ?? Number.NaN;
      const [before, boardZoom] = [await read(), (await board.viewport()).zoom];
      await board.wheel(wheelAt, -100, { hold: ["Control"] });
      await sleep(150);
      const afterIn = await read();
      await board.wheel(wheelAt, 100, { hold: ["Control"] });
      await sleep(150);
      const afterOut = await read();
      notch = {
        before: round(before, 4),
        afterIn: round(afterIn, 4),
        afterOut: round(afterOut, 4),
        in: round(afterIn / before, 3),
        out: round(afterOut / afterIn, 3),
        boardZoomChanged: (await board.viewport()).zoom !== boardZoom,
      };
    }
    Object.assign(m, { controlWheel: notch, armedAfter: await armed(node) });
    const regular = (factor: number): boolean => factor >= NOTCH.min && factor <= NOTCH.max;
    const atLimit = notch !== null && !(regular(notch.in) && regular(1 / notch.out));
    const wheel = notch
      ? `Ctrl+wheel x${notch.in} in, x${notch.out} out (own scale ${notch.before})`
      : "Ctrl+wheel not tried";
    const short = `${byDoubleClick ? "armed by double-click" : "NOT armed by double-click"}, ${drag ? `drag ratio ${drag.ratio.x}/${drag.ratio.y}` : "no element free"}, ${wheel}`;
    if (!byDoubleClick) {
      return { verdict: "broken", why: `a double-click on the node body did not arm it; ${short}`, short };
    }
    if (drag && !drag.ok) return { verdict: "broken", why: `${drag.why}; ${wheel}`, short };
    if (!drag) return { verdict: "degraded", why: `armed, but ${noElement}; ${wheel}`, short };
    if (notch && atLimit) {
      return {
        verdict: "degraded",
        why: `${drag.why}; one Control + wheel notch changed the diagram's scale by x${notch.in} in and x${notch.out} out where a notch is x1.16 and x0.86: the engine's 0.2 to 4 limit at an own scale of ${notch.before}`,
        short,
      };
    }
    return { verdict: "ok", why: `${drag.why}; ${wheel}`, short };
  },
};

// ── pictures ─────────────────────────────────────────────────────────────────

interface Picture {
  width: number;
  height: number;
  /** RGBA, 8 bit */
  data: Uint8Array;
}

/** a PNG as Playwright writes it (8 bit RGB or RGBA, not interlaced) into RGBA: no package needed */
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
      const [depth, colour, interlace] = [body[8], body[9], body[12]];
      if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0)
        throw new Error(`unsupported PNG (depth ${depth}, colour type ${colour})`);
      channels = colour === 6 ? 4 : 3;
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
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 3; channel++) data[pixel * 4 + channel] = lines[pixel * channels + channel]!;
    data[pixel * 4 + 3] = channels === 4 ? lines[pixel * channels + 3]! : 255;
  }
  return { width, height, data };
}

/** RGBA into a PNG file (filter 0, one IDAT) */
function encodePng(picture: Picture): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(picture.width, 0);
  header.writeUInt32BE(picture.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = picture.width * 4;
  const raw = Buffer.alloc(picture.height * (stride + 1));
  for (let y = 0; y < picture.height; y++) {
    raw.set(picture.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** `pictures` in rows of `columns`, each `times` as large (nearest neighbour, so single px stay visible), on white */
function contactSheet(pictures: ReadonlyArray<Picture | undefined>, columns: number, times: number): Picture {
  const cell = {
    width: Math.max(1, ...pictures.map((one) => one?.width ?? 0)) * times + 8,
    height: Math.max(1, ...pictures.map((one) => one?.height ?? 0)) * times + 8,
  };
  const sheet: Picture = {
    width: cell.width * columns,
    height: cell.height * Math.ceil(pictures.length / columns),
    data: new Uint8Array(0),
  };
  sheet.data = new Uint8Array(sheet.width * sheet.height * 4).fill(255);
  pictures.forEach((one, index) => {
    if (!one) return;
    const [left, top] = [(index % columns) * cell.width + 4, Math.floor(index / columns) * cell.height + 4];
    for (let y = 0; y < one.height * times; y++) {
      for (let x = 0; x < one.width * times; x++) {
        const from = (Math.floor(y / times) * one.width + Math.floor(x / times)) * 4;
        sheet.data.set(one.data.subarray(from, from + 4), ((top + y) * sheet.width + left + x) * 4);
      }
    }
  });
  return sheet;
}

const luminance = (picture: Picture, pixel: number): number =>
  0.299 * picture.data[pixel * 4]! + 0.587 * picture.data[pixel * 4 + 1]! + 0.114 * picture.data[pixel * 4 + 2]!;

async function picture(ctx: Ctx, board: Board, name: string, area: Box): Promise<Picture> {
  const path = outPath(`shots/${ctx.tag}-${name}.png`);
  await board.screenshot(path, area);
  ctx.shots.push(path);
  return decodePng(readFileSync(path));
}

/**
 * Two pictures of the same screen area: the share of pixels that differ by more than 40 of 255 in
 * a channel, outside the `masks` (screen px), and that share among the pixels that are drawn (not
 * ground) in either picture. `shift` is the whole px offset of `b` (up to 2 px each way) at which
 * the fewest pixels differ: a picture that only moved shows as a low share at an offset. Returns
 * also a picture of the differences: black where the two differ, grey where masked.
 */
function comparePictures(
  a: Picture,
  b: Picture,
  area: Box,
  masks: readonly Box[],
): {
  compared: number;
  differing: number;
  share: number;
  inkShare: number;
  bestShift: Point;
  shareAtBestShift: number;
  map: Picture;
} {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`pictures of ${a.width}x${a.height} and ${b.width}x${b.height}`);
  }
  const scale = a.width / Math.ceil(area.width);
  const masked = (x: number, y: number): boolean =>
    masks.some(
      (mask) =>
        x >= (mask.x - area.x - 1) * scale &&
        x <= (mask.x + mask.width - area.x + 1) * scale &&
        y >= (mask.y - area.y - 1) * scale &&
        y <= (mask.y + mask.height - area.y + 1) * scale,
    );
  const differs = (pixel: number, other: number): boolean => {
    for (let channel = 0; channel < 3; channel++) {
      if (Math.abs(a.data[pixel * 4 + channel]! - b.data[other * 4 + channel]!) > 40) return true;
    }
    return false;
  };
  const background = luminance(a, 0);
  const map: Picture = { width: a.width, height: a.height, data: new Uint8Array(a.width * a.height * 4).fill(255) };
  const free: number[] = [];
  let [differing, ink] = [0, 0];
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const pixel = y * a.width + x;
      if (masked(x, y)) {
        map.data.set([200, 200, 200, 255], pixel * 4);
        continue;
      }
      free.push(pixel);
      if (Math.abs(luminance(a, pixel) - background) > 24 || Math.abs(luminance(b, pixel) - background) > 24) ink++;
      if (differs(pixel, pixel)) {
        differing++;
        map.data.set([0, 0, 0, 255], pixel * 4);
      }
    }
  }
  let best = { x: 0, y: 0, count: differing };
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dy === 0) continue;
      let count = 0;
      for (const pixel of free) {
        const [x, y] = [(pixel % a.width) + dx, Math.floor(pixel / a.width) + dy];
        if (x < 0 || y < 0 || x >= a.width || y >= a.height) continue;
        if (differs(pixel, y * a.width + x) && ++count >= best.count) break;
      }
      if (count < best.count) best = { x: dx, y: dy, count };
    }
  }
  const compared = Math.max(1, free.length);
  return {
    compared: free.length,
    differing,
    share: round(differing / compared, 5),
    inkShare: round(differing / Math.max(1, ink), 4),
    bestShift: { x: best.x, y: best.y },
    shareAtBestShift: round(best.count / compared, 5),
    map,
  };
}

const preview: CaseDef = {
  name: "preview",
  did: "An unarmed node. A picture of its body. Then a click on a shape, the key x and a wheel notch over it: which document saw the events, what changed (the node's selection, the board zoom, the model, the editor's selection and scale). Which editing chrome is shown. Then the node is armed and its picture, with the armed chrome masked, is compared pixel by pixel with the first one.",
  expected:
    "A preview takes no input: the board selects the node, zooms and gets the key, the model and the editor stay as they are. It shows no palette, pad or popup, and its diagram is the armed diagram: the same pixels where the board's scale is 1, the same up to antialiasing where one is scaled by CSS and the other drawn at that scale.",
  kits: KIT_IDS,
  variants: () => [""],
  zooms: () => [1, ODD_ZOOM],
  async run(ctx) {
    const { board, node, file } = await openOne(ctx, ctx.zoom);
    const { kit, m } = ctx;
    const body = await bodyBox(board, node.id);
    if (!body) throw new Error("the node has no body");
    // inside the body's border, whole px: the same area for both pictures
    const inner = (box: Box): Box => ({
      x: Math.ceil(box.x) + 4,
      y: Math.ceil(box.y) + 4,
      width: Math.floor(box.width) - 8,
      height: Math.floor(box.height) - 8,
    });
    let area = inner(body);
    let before = await picture(ctx, board, "preview", area);
    const chromePreview = await chromeOf(node);
    let markPreview = (await node.query(".bjs-powered-by"))[0];
    const [text, viewportStart, ownScale] = [
      await board.fileText(file),
      await board.viewport(),
      (await node.viewportMatrix())?.a,
    ];
    let viewStart = await viewOf(node);
    await recordEvents(board.page);
    if (node.frame) await recordEvents(node.frame);
    // a shape of the diagram where the body shows one, else the body's middle
    const target = await landmark(node, kit);
    const at = centre((target && clip(target, area)) ?? body);
    await board.click(at);
    await sleep(150);
    const nodeSelected = await board.page.evaluate(
      (id) =>
        document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.classList.contains("selected") ===
        true,
      node.id,
    );
    await board.press("x");
    await board.wheel(at, -WHEEL_DELTA);
    await frames(board);
    const viewportAfter = await board.viewport();
    const inFrame = node.frame
      ? (await seenEvents(node.frame)).filter((event) => event.trusted).map((event) => event.type)
      : [];
    const inPage = (await seenEvents(board.page)).filter((event) => event.trusted).map((event) => event.type);
    const state = await stateOf(node, kit);
    const input = {
      eventsInTheBoardPage: [...new Set(inPage)],
      eventsInTheNodesFrame: [...new Set(inFrame)],
      nodeSelectedByTheClick: nodeSelected,
      boardZoomedByTheWheel: viewportAfter.zoom !== viewportStart.zoom,
      editorSelection: state.selected,
      editorScaleChanged: (await node.viewportMatrix())?.a !== ownScale,
      modelChanged: (await board.fileText(file)) !== text,
      armed: await armed(node),
    };
    await board.setViewport(viewportStart);
    // off the node: an armed editor under the pointer shows hover marks and tooltips
    await board.move(PIVOT);
    const viewportArmed = await arm(ctx, board, node.id);
    if (!sameViewport(viewportStart, viewportArmed)) {
      // The arm rules moved the board. The preview a person had before the editor came is the one at
      // THIS viewport (the board moves first, then the node is armed): its picture is taken again
      // there, the node disarmed by the hook and armed once more, which moves nothing
      await board.arm(null);
      await sleep(300);
      if (!sameViewport(await board.viewport(), viewportArmed)) {
        throw new Unmeasured(
          "the board does not stay where the node was armed (armreturn=back): no preview at that viewport",
        );
      }
      const bodyNow = await bodyBox(board, node.id);
      if (!bodyNow) throw new Error("the node has no body");
      area = inner(bodyNow);
      // as the first picture was taken: of a node the board has not selected (the click above selected
      // it, and a selected preview shows the board's connection handles at its edges)
      const free = await board.freePanePoint();
      if (free) await board.click(free);
      await board.move(pivotOf(board));
      // the handles of a node that was selected fade out
      await sleep(400);
      before = await picture(ctx, board, "preview-at-the-zoom-in-effect", area);
      markPreview = (await node.query(".bjs-powered-by"))[0];
      viewStart = await viewOf(node);
      await board.arm(node.id);
      m.previewTakenAgainAt = flatViewport(viewportArmed);
    }
    await sleep(300);
    const chromeArmed = await chromeOf(node);
    const markArmed = (await node.query(".bjs-powered-by"))[0];
    const after = await picture(ctx, board, "armed", area);
    // masked: the armed chrome, and the bpmn.io mark as it is in either state (it changes its size where chrome keeps its screen size)
    const compared = comparePictures(before, after, area, [
      ...chromeArmed.map((one) => one.box),
      ...(markPreview ? [markPreview] : []),
      ...(markArmed ? [markArmed] : []),
    ]);
    const { map, ...numbers } = compared;
    const mapPath = outPath(`shots/${ctx.tag}-difference.png`);
    writeFileSync(mapPath, encodePng(map));
    ctx.shots.push(mapPath);
    Object.assign(m, {
      input,
      chromeShownInPreview: chromePreview.map((one) => one.what),
      chromeShownArmed: chromeArmed.map((one) => one.what),
      picture: numbers,
      bpmnIoMarkPx: { preview: sizeOf(markPreview ?? null), armed: sizeOf(markArmed ?? null) },
      viewDriftOnArming: drift(viewStart, await viewOf(node)),
    });
    const took = [
      input.eventsInTheNodesFrame.length > 0 ? `its frame saw ${input.eventsInTheNodesFrame.join(",")}` : "",
      input.editorSelection.length > 0 ? "the editor selected a shape" : "",
      input.editorScaleChanged ? "the editor zoomed" : "",
      input.modelChanged ? "the model changed" : "",
      input.armed ? "the node armed" : "",
    ].filter(Boolean);
    const missed = [
      input.nodeSelectedByTheClick ? "" : "the click did not select the node",
      input.boardZoomedByTheWheel ? "" : "the wheel did not zoom the board",
      input.eventsInTheBoardPage.includes("keydown") ? "" : "the key did not reach the board page",
    ].filter(Boolean);
    const short = `input ${took.length + missed.length === 0 ? "all to the board" : [...took, ...missed].join("; ")}; chrome in preview: ${chromePreview.length === 0 ? "none" : chromePreview.map((one) => one.what).join(" ")}; picture differs ${round(compared.share * 100, 2)} % (${round(compared.inkShare * 100, 1)} % of the drawn px)`;
    if (took.length > 0) return { verdict: "broken", why: `the preview took input: ${took.join("; ")}`, short };
    const why = `${missed.length === 0 ? "click, key and wheel reached the board and changed nothing in the model" : missed.join("; ")}; ${chromePreview.length} chrome element(s) shown in preview; ${compared.differing} of ${compared.compared} px differ from the armed picture outside its chrome (${round(compared.share * 100, 2)} %)`;
    if (missed.length > 0 || chromePreview.length > 0 || compared.share > 0.005) {
      return { verdict: compared.share > 0.03 ? "broken" : "degraded", why, short };
    }
    return { verdict: "ok", why, short };
  },
};

/** how sharp a crop of dark text on a light ground is */
interface Sharpness {
  /** device px of the crop */
  width: number;
  height: number;
  /** distinct grey levels in the crop */
  levels: number;
  /** darkest over lightest luminance span, of 255 */
  contrast: number;
  /** crossings from ground to full ink along the rows, and the mean number of grey px between the two */
  edges: number;
  meanEdgePx: number;
  /** grey px over grey + ink px */
  greyShare: number;
}
function sharpnessOf(crop: Picture): Sharpness {
  const count = crop.width * crop.height;
  const light = new Float32Array(count);
  const histogram = new Map<number, number>();
  let darkest = 255;
  for (let pixel = 0; pixel < count; pixel++) {
    const value = Math.round(luminance(crop, pixel));
    light[pixel] = value;
    histogram.set(value, (histogram.get(value) ?? 0) + 1);
    darkest = Math.min(darkest, value);
  }
  const ground = [...histogram.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const span = ground - darkest;
  const isGround = (value: number): boolean => value >= ground - 0.12 * span;
  const isInk = (value: number): boolean => value <= darkest + 0.3 * span;
  let [edges, greyInEdges, grey, ink] = [0, 0, 0, 0];
  for (let y = 0; y < crop.height; y++) {
    let run = 0;
    let cameFrom: "ground" | "ink" | null = null;
    for (let x = 0; x < crop.width; x++) {
      const value = light[y * crop.width + x]!;
      const kind = isGround(value) ? "ground" : isInk(value) ? "ink" : null;
      if (kind === null) {
        grey++;
        run++;
        continue;
      }
      if (kind === "ink") ink++;
      if (cameFrom !== null && cameFrom !== kind) {
        edges++;
        greyInEdges += run;
      }
      cameFrom = kind;
      run = 0;
    }
  }
  return {
    width: crop.width,
    height: crop.height,
    levels: histogram.size,
    contrast: span,
    edges,
    meanEdgePx: edges > 0 ? round(greyInEdges / edges, 3) : Number.NaN,
    greyShare: round(grey / Math.max(1, grey + ink), 3),
  };
}

/** the label of one task: its `text` element's box on screen */
const LABEL_OF = "Task_check_credit";

const sharpness: CaseDef = {
  name: "sharpness",
  did: `The label of the BPMN task ${LABEL_OF} at board zoom 0.5 and 2, at device pixel ratio 1 (variant dpr1) and 2 (variant dpr2): a screenshot of the label's box as a preview and armed. Per crop: the mean number of grey px between ground and full ink along the rows (1 is one anti-aliased px per edge; a bitmap scaled up by 2 has 2 to 3), the share of grey px, the grey levels.`,
  expected:
    "SVG text under a CSS transform is drawn again at the transform's scale unless its layer is kept as a bitmap: every strategy should show the same edge width. A frame is drawn at the board's scale too (the iframe builder saw that by eye).",
  kits: ["bpmn"],
  variants: () => ["dpr1", "dpr2"],
  zooms: () => [0.5, 2],
  fixedZooms: true,
  async run(ctx) {
    const { board, node } = await openOne(ctx, ctx.zoom, { dpr: ctx.variant === "dpr2" ? 2 : 1 });
    const { m } = ctx;
    const crop = async (name: string): Promise<Sharpness> => {
      const label = (await node.query(`[data-element-id="${LABEL_OF}"] .djs-visual text`))[0];
      if (!label) throw new Unmeasured(`${LABEL_OF} has no label on the canvas`);
      const area = {
        x: Math.floor(label.x) - 3,
        y: Math.floor(label.y) - 3,
        width: Math.ceil(label.width) + 6,
        height: Math.ceil(label.height) + 6,
      };
      return sharpnessOf(await picture(ctx, board, name, area));
    };
    m.devicePixelRatio = await board.page.evaluate(() => window.devicePixelRatio);
    m.preview = await crop("preview");
    const viewportStart = await board.viewport();
    if (!sameViewport(viewportStart, await arm(ctx, board, node.id))) {
      // the arm rules moved the board: the preview to compare with is the one at the viewport in effect
      await board.arm(null);
      await sleep(300);
      m.previewAtTheZoomAsked = m.preview;
      m.preview = await crop("preview-at-the-zoom-in-effect");
      await board.arm(node.id);
    }
    await sleep(300);
    const live = await crop("armed");
    m.armed = live;
    m.netScale = round(await node.netScale(), 4);
    const short = `edge ${live.meanEdgePx} px over ${live.edges} edges, grey ${live.greyShare}, ${live.levels} levels (preview edge ${(m.preview as Sharpness).meanEdgePx})`;
    // the verdict needs the other strategies: judgeSharpness() after the run
    return { verdict: "ok", why: short, short };
  },
};

/** below this many edge crossings the mean edge width says little (small text): the grey share decides */
const EDGES_ENOUGH = 40;

/**
 * After the run: a label is "ok" when it is as sharp as the sharpest strategy's at the same zoom
 * and device pixel ratio. With at least EDGES_ENOUGH crossings in every crop of the group the mean
 * edge width decides (0.3 px), else the share of grey px (0.05). Also writes one picture of all
 * armed crops, three times as large: a row per strategy, a column per ratio and zoom.
 */
function judgeSharpness(rows: Row[]): string | null {
  const mine = rows.filter((row) => row.case === "sharpness" && row.verdict !== "unmeasured");
  if (mine.length === 0) return null;
  const of = (row: Row): Sharpness | undefined => row.measured.armed as Sharpness | undefined;
  for (const row of mine) {
    const group = mine.filter((one) => one.variant === row.variant && one.zoom === row.zoom && one.rep === row.rep);
    const byEdge = group.every((one) => (of(one)?.edges ?? 0) >= EDGES_ENOUGH);
    const value = (one: Row): number => (byEdge ? of(one)?.meanEdgePx : of(one)?.greyShare) ?? Number.NaN;
    const best = Math.min(...group.map(value).filter((number) => !Number.isNaN(number)));
    const mineValue = value(row);
    row.measured.sharpestOfTheGroup = best;
    row.measured.judgedBy = byEdge ? "mean edge width" : "share of grey px";
    row.verdict = mineValue - best <= (byEdge ? 0.3 : 0.05) ? "ok" : "degraded";
    row.why = byEdge
      ? `glyph edges ${mineValue} grey px wide over ${of(row)?.edges} crossings; the sharpest strategy at this zoom and ratio has ${best}`
      : `too few edge crossings for the edge measure (${of(row)?.edges}): ${mineValue} of the text px are grey, the sharpest strategy has ${best}`;
  }
  const columns = [...new Set(mine.map((row) => `${row.variant}|${row.zoom}`))];
  const lines = [...new Set(mine.map((row) => row.strategy))];
  const crops = lines.flatMap((strategy) =>
    columns.map((column) => {
      const row = mine.find(
        (one) => one.strategy === strategy && `${one.variant}|${one.zoom}` === column && one.rep === 0,
      );
      const path = row?.shots.find((shot) => shot.endsWith("-armed.png"));
      return path ? decodePng(readFileSync(path)) : undefined;
    }),
  );
  const path = outPath("shots/sharpness-sheet.png");
  writeFileSync(path, encodePng(contactSheet(crops, columns.length, 3)));
  console.log(`sharpness sheet: rows ${lines.join(", ")}; columns ${columns.join(", ")}\n${path}`);
  return path;
}

const dprDrag: CaseDef = {
  name: "dpr2-drag",
  did: "The smoke run's drag at device pixel ratio 2: arm the node, drag one shape by (60, 40) flow units of pointer travel, at board zoom 0.73 and 1.5.",
  expected:
    "Pointer events and client rectangles are in CSS px at every device pixel ratio: the ratio of shape travel to pointer travel is what it is at ratio 1 (1 where the engine's host has net scale 1 or the engine is corrected, the board zoom otherwise).",
  kits: DIAGRAMS,
  variants: () => ["dpr2"],
  zooms: () => [0.73, 1.5],
  fixedZooms: true,
  async run(ctx) {
    const { board, node, file } = await openOne(ctx, ctx.zoom, { dpr: 2 });
    await arm(ctx, board, node.id);
    await sleep(150);
    ctx.m.devicePixelRatio = await board.page.evaluate(() => window.devicePixelRatio);
    const [host, body] = [await node.hostBox(), await bodyBox(board, node.id)];
    ctx.m.hostAgainstBodyPx = body && { x: round(host.x - body.x, 3), y: round(host.y - body.y, 3) };
    const drag = await smokeDrag(ctx, board, node, file, () => ({ x: 60 * ctx.zoom, y: 40 * ctx.zoom }));
    const short = `ratio ${drag.ratio.x}/${drag.ratio.y}, net scale ${String(ctx.m.netScale)}`;
    return { verdict: drag.ok ? "ok" : "broken", why: drag.why, short };
  },
};

// ── the run ──────────────────────────────────────────────────────────────────

const CASES: readonly CaseDef[] = [
  syncEdit,
  syncBoth,
  busyDrag,
  busyLabel,
  busyPopup,
  busySelect,
  peerView,
  zoomPlain,
  zoomLabel,
  zoomPopup,
  zoomDrag,
  pan,
  nodeMove,
  armDisarm,
  extreme,
  preview,
  sharpness,
  dprDrag,
];

async function one(
  harness: Harness,
  def: CaseDef,
  kit: Kit,
  strategy: Strategy,
  variant: string,
  zoom: number,
  rep: number,
): Promise<Row> {
  const started = Date.now();
  const tag = [def.name, variant, kit.id, strategy, String(zoom), ...(repeat > 1 ? [`r${rep}`] : [])]
    .filter(Boolean)
    .join("-");
  const ctx: Ctx = { harness, strategy, kit, zoom, variant, m: {}, shots: [], boards: [], tag };
  const row: Row = {
    case: def.name,
    variant,
    notation: kit.id,
    strategy,
    zoom,
    rep,
    did: def.did,
    expected: def.expected,
    measured: ctx.m,
    verdict: "unmeasured",
    why: "",
    short: "",
    problems: [],
    shots: ctx.shots,
    ms: 0,
    load: 0,
  };
  try {
    Object.assign(row, await def.run(ctx));
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
    row.verdict = "unmeasured";
    row.short = "unmeasured";
    if (error instanceof Unmeasured) row.unmeasured = message;
    else row.harness = message;
    row.why = message;
  }
  row.zoomInEffect = round(ctx.zoom, 4);
  row.arm = await ctx.boards[0]
    ?.counters()
    .then((counters) => counters.arm)
    .catch(() => undefined);
  for (const board of ctx.boards) {
    row.problems.push(...(await board.problems({ allow: ALLOWED }).catch((error: unknown) => [String(error)])));
    if (board.violations.length > 0) row.harness = `${row.harness ?? ""} ${board.violations.join("; ")}`.trim();
    // a held button or key must not outlive the row
    await board.release(["Control", "Shift"]).catch(() => undefined);
    await board.close().catch(() => undefined);
  }
  row.ms = Date.now() - started;
  row.load = round(loadavg()[0] ?? 0, 1);
  return row;
}

interface Job {
  def: CaseDef;
  kit: Kit;
  strategy: Strategy;
  variant: string;
  zoom: number;
  rep: number;
  index: number;
}

function line(row: Row): string {
  const key = [row.case, row.variant, row.notation, row.strategy, String(row.zoom)].filter(Boolean).join(" ");
  const tail = row.harness ? `HARNESS: ${row.harness}` : (row.unmeasured ?? row.short);
  return `${row.verdict.padEnd(10)} ${key.padEnd(52)} ${tail}${row.problems.length > 0 ? ` [${row.problems.length} console/log]` : ""}`;
}

const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

function markdown(rows: readonly Row[]): string {
  const head =
    "| case | variant | notation | strategy | zoom | verdict | measured | why |\n| --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = rows.map(
    (row) =>
      `| ${[row.case, row.variant, row.notation, row.strategy, String(row.zoom), row.verdict, row.short, row.harness ? `HARNESS: ${row.harness}` : row.why].map(cell).join(" | ")} |`,
  );
  return `${head}\n${body.join("\n")}\n`;
}

/** one row per case x notation x strategy: the variants and zooms folded into one string */
function folded(rows: readonly Row[]): Array<Record<string, string>> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.case}|${row.notation}|${row.strategy}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const measured = group.filter((row) => row.verdict !== "unmeasured");
    return {
      case: first.case,
      notation: first.notation,
      strategy: first.strategy,
      verdict: measured.length === 0 ? "unmeasured" : worst(...measured.map((row) => row.verdict)),
      byZoom: group
        .map(
          (row) =>
            `${[row.variant, String(row.zoom)].filter(Boolean).join(" ")}: ${row.verdict === "unmeasured" ? `unmeasured (${row.unmeasured ?? row.harness ?? ""})` : `${row.short} [${row.verdict}]`}`,
        )
        .join(" | "),
    };
  });
}

await run(async (harness) => {
  const jobs: Job[] = [];
  for (const def of CASES) {
    if (caseFilter.length > 0 && !caseFilter.includes(def.name)) continue;
    for (const kit of kits) {
      if (!def.kits.includes(kit.id)) continue;
      for (const strategy of strategies) {
        for (const variant of def.variants(kit)) {
          const zooms = !def.fixedZooms && zoomsOverride.length > 0 ? zoomsOverride : def.zooms(variant);
          for (const zoom of zooms) {
            for (let rep = 0; rep < repeat; rep++)
              jobs.push({ def, kit, strategy, variant, zoom, rep, index: jobs.length });
          }
        }
      }
    }
  }
  const rows: Row[] = [];
  const started = Date.now();
  const work = async (job: Job): Promise<void> => {
    const row = await one(harness, job.def, job.kit, job.strategy, job.variant, job.zoom, job.rep);
    rows[job.index] = row;
    console.log(line(row));
    for (const problem of row.problems.slice(0, 3)) console.log(`    ${problem.slice(0, 160)}`);
  };
  // first, alone: the rows that take times
  for (const job of jobs.filter((one) => one.def.serial)) await work(job);
  const queue = jobs.filter((one) => !one.def.serial);
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await work(job);
    }),
  );

  judgeSharpness(rows);
  const count = (verdict: Verdict): number => rows.filter((row) => row.verdict === verdict).length;
  const harnessFailures = rows.filter((row) => row.harness !== undefined);
  const path = writeResult("sync-view", {
    what: "board spike battery sync-view: an editor's view and state when the board zooms or pans, the node moves or is resized, a peer edits the same file",
    date: new Date().toISOString(),
    chromium: harness.browser.version(),
    viewport: { width: 2200, height: 1300 },
    loadAverage: loadavg().map((value) => round(value, 1)),
    strategies,
    notations: kits.map((kit) => kit.id),
    cases: CASES.filter((def) => caseFilter.length === 0 || caseFilter.includes(def.name)).map((def) => def.name),
    zoomsOverride,
    repeat,
    concurrency,
    rules: RULES,
    rows,
  });
  writeFileSync(path.replace(/\.json$/, ".md"), markdown(rows));
  writeFileSync(path.replace(/\.json$/, "-folded.json"), `${JSON.stringify(folded(rows), null, 1)}\n`);
  console.log(
    `\n${rows.length} rows in ${Math.round((Date.now() - started) / 1000)} s: ${count("ok")} ok, ${count("degraded")} degraded, ` +
      `${count("broken")} broken, ${count("wrong-data")} wrong-data, ${count("unmeasured")} unmeasured ` +
      `(${harnessFailures.length} of them harness failures)\n${path}`,
  );
  return harnessFailures.length;
});
