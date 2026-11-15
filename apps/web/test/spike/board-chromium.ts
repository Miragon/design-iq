/**
 * The board ITSELF as a permanent artifact: what a gesture of the board writes into the board file,
 * where an image's bytes go, whether the board's action layer writes what a pointer does, the
 * derived arrows, the board's own gestures next to an ARMED editor, and what a large board costs.
 * The editor-embedding batteries do not look at any of this. A measurement run by hand (lib.ts):
 *
 *   node apps/web/test/spike/board-chromium.ts
 *   PARTS=file,images node apps/web/test/spike/board-chromium.ts
 *   PARTS=armed STRATEGIES=iframe ZOOMS=1.5 CASES=resize-armed node apps/web/test/spike/board-chromium.ts
 *
 * Parts (PARTS, default all):
 *   file     every gesture of the board on a fresh page of the demo board (strategy overlay, the
 *            page's default; arm and disarm in overlay, plugin and iframe): lines added, removed
 *            and changed in boards/workshop.board, bytes, whether the rest of the file is
 *            byte-identical, how often the document was written. Then the SAME change through the
 *            action layer (board-actions.ts, board-doc.ts) on a document loaded from the text the
 *            page had before the gesture, in Node: the same lines or not
 *   images   a 200 KiB and a 2 MiB image through the toolbar's picker, two pastes: where the bytes
 *            are, what the board file gains, and `git diff --stat` of that change
 *   derived  the dashed arrows a call activity and a business rule task give: the right pairs, do
 *            they follow an edit of the reference, do they go with their node, are they ever in
 *            the board file (overlay, plugin, iframe)
 *   armed    the board's gestures while a node is armed (STRATEGIES, default overlay, plugin,
 *            iframe; ZOOMS, default 0.5 and 1.5), each case on a fresh page
 *   peer     a write that is not this client's arriving on the page (a peer, an AI client): does
 *            the page show it, does it disturb a gesture in progress, what becomes of an open note
 *            editor and of an armed node that a peer deletes
 *   size     a board of 50 and of 200 notes, groups and arrows: file size, time to show it, time
 *            of one move (REPEAT, default 2 pages per size)
 * The pure half (two peers on one document, a 3-way merge with Git) is board-file.test.ts.
 *
 * The page hands a script no way to the board's document or its actions (window.__boardSpike has
 * neither). This script reaches the runtime through React's root (INSTALL below) to SET UP a board
 * (the armed cases' group and notes, the large boards) and to read the document. Every measured
 * gesture is real pointer and key input; where a file is dropped it is a real drag of DevTools
 * (Input.dispatchDragEvent), where an image is pasted it is the real clipboard.
 *
 * Exits 1 only when the harness failed. What a row says about the board is in the result:
 * <OUT_DIR>/board.json (rows, the texts before and after every gesture) and board-table.txt.
 *
 * Environment: PARTS, STRATEGIES, ZOOMS, CASES (names of gestures or cases), JOBS (pages side by
 * side, default 3, at most 4), REPEAT, SHOTS=0 (no screenshots), plus lib.ts's PORT, BASE,
 * CACHE_DIR, OUT_DIR.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import type { Page } from "playwright";

import type * as BoardActions from "../../src/notations/board/board-actions.ts";
import {
  absoluteBoxes,
  addArrow,
  addGroupAround,
  addNode,
  arrowEndAt,
  fitImage,
  NEW_NODE,
  type Point as FlowPoint,
  reconnectArrow,
  writeDrop,
  writeNoteColor,
  writeRemoval,
} from "../../src/notations/board/board-actions.ts";
import {
  type BoardStore,
  boardText,
  createBoardDoc,
  createBoardStore,
  writeGeometry,
} from "../../src/notations/board/board-doc.ts";
import { derivedArrows, derivedRefs } from "../../src/notations/board/derived-refs.ts";
import {
  type Board,
  type Box,
  centre,
  type Harness,
  KNOWN_CONSOLE,
  type NativeGeometry,
  type NodeHandle,
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

// ── what to run ──────────────────────────────────────────────────────────────

const words = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);
const pick = <T extends string>(name: string, all: readonly T[], fallback: readonly T[] = all): T[] => {
  const wanted = words(name);
  return wanted.length === 0 ? [...fallback] : all.filter((one) => wanted.includes(one));
};
const PARTS = ["file", "images", "derived", "armed", "peer", "size"] as const;
const parts = pick("PARTS", PARTS);
/** the strategies of the cases an armed editor is part of */
const strategies = pick("STRATEGIES", STRATEGIES, ["overlay", "plugin", "iframe"]);
const zooms = words("ZOOMS").map(Number).filter(Boolean);
const armedZooms = zooms.length > 0 ? zooms : [0.5, 1.5];
const caseFilter = words("CASES");
const wanted = (name: string): boolean => caseFilter.length === 0 || caseFilter.includes(name);
const jobs = Math.max(1, Math.min(4, Number(process.env.JOBS ?? 3) || 1));
const repeat = Math.max(1, Number(process.env.REPEAT ?? 2) || 1);
const shots = process.env.SHOTS !== "0";

const ORDER = "processes/order-to-cash.bpmn";
const INVOICE = "processes/subprocesses/invoice-handling.bpmn";
const PICKER = '.board-toolbar input[type="file"]';
const ALLOWED = [KNOWN_CONSOLE.padDeprecation, KNOWN_CONSOLE.feelEditor];
/** how long a step may take to show: the machine may be busy with other runs */
const WAIT = 5000;

type Verdict = "ok" | "degraded" | "broken" | "wrong-data" | "unmeasured";
interface Row {
  part: (typeof PARTS)[number];
  case: string;
  strategy: string;
  zoom: number | null;
  verdict: Verdict;
  measured: string;
  expected: string;
  details: Record<string, unknown>;
  problems: string[];
}
const rows: Row[] = [];
let harnessFailures = 0;

const RULES: Readonly<Record<(typeof PARTS)[number], string>> = {
  file: "ok: the lines added, removed and changed are exactly the elements the gesture touched (nothing for arm, disarm, pan, zoom, select), the rest of the file is byte-identical, no model file changed, one write. degraded: more lines than elements touched, or more than one write. wrong-data: the file does not hold what the screen shows. broken: nothing written.",
  images:
    "ok: the board file gains one line with the path and nothing of the picture, the bytes are a file of their own. broken: bytes in the board file.",
  derived:
    "ok: the dashed arrows are exactly the pairs the models' texts name, they follow an edit within 3 s, go with their node, and the board file never holds one. wrong-data: an arrow for a pair the texts do not name, or one missing after 3 s. broken: a derived arrow in the board file.",
  armed:
    "ok: the board's gesture does what it does without an armed node, the model's file is unchanged, the node stays armed and on the board. degraded: the gesture works with a limit (a part cannot be reached, a result is hidden, it has to be done disarmed). broken: the gesture does not end, is lost or is not possible at all. wrong-data: the model changed or the armed node is gone.",
  peer: "ok: the page shows a write that is not this client's, the person's own gesture in progress is not disturbed, and nothing a peer wrote is lost. degraded: of two edits of one text the later one wins whole, without a notice. wrong-data: a peer's write is overwritten by a person who changed nothing. broken: the page is left with an error, a ghost of an editor, or does not go on.",
  size: "no rule: one number each. Times are taken on a machine that runs other measurements and are not comparable across runs.",
};

// ── small things ─────────────────────────────────────────────────────────────

type NativeWindow = Window & { __boardSpikeNative?: NativeGeometry };
type Json = Record<string, unknown>;

const nodeSel = (id: string): string => `.react-flow__node[data-id="${id}"]`;
const bytesOf = (text: string): number => Buffer.byteLength(text);
const lineRows = (text: string): Json[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(1)
    .map((line) => JSON.parse(line) as Json);
const rowOf = (text: string, id: string): Json | undefined => lineRows(text).find((row) => row.id === id);
const near = (a: number, b: number, slack: number): boolean => Math.abs(a - b) <= slack;

/** runs the tasks with at most `size` of them at a time, in order of the list */
async function pool(tasks: ReadonlyArray<() => Promise<void>>, size: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) await tasks[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
}

/** a board on a fresh page; whatever `use` throws becomes a row that says so, and the page is closed */
async function onBoard(
  harness: Harness,
  query: Parameters<Harness["open"]>[0],
  label: { part: Row["part"]; case: string; strategy: string; zoom: number | null },
  work: (board: Board) => Promise<void>,
  options: Parameters<Harness["open"]>[1] = {},
): Promise<void> {
  let board: Board | undefined;
  try {
    board = await harness.open(query, options);
    await work(board);
  } catch (error) {
    harnessFailures++;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${label.part} ${label.case} ${label.strategy} ${label.zoom ?? ""}: ${message.split("\n")[0]}`);
    rows.push({
      ...label,
      verdict: "unmeasured",
      measured: `the case threw: ${message.split("\n")[0]}`,
      expected: "",
      details: { stack: error instanceof Error ? error.stack : undefined },
      problems: board ? await board.problems({ allow: ALLOWED }).catch(() => []) : [],
    });
  } finally {
    await board?.page
      .context()
      .close()
      .catch(() => undefined);
  }
}

function report(row: Row): void {
  rows.push(row);
  const where = `${row.strategy}${row.zoom === null ? "" : ` @${row.zoom}`}`;
  console.log(
    `${row.verdict.padEnd(10)} ${row.part.padEnd(7)} ${row.case.padEnd(26)} ${where.padEnd(13)} ${row.measured}`,
  );
}

// ── the page's runtime, for setting a board up ───────────────────────────────

interface PageBattery {
  runtime: {
    store: BoardStore;
    hub: {
      replica(path: string): {
        ytext: {
          toString(): string;
          delete(index: number, length: number): void;
          insert(index: number, text: string): void;
        };
        doc: { transact(run: () => void): void };
        destroy(): void;
      };
    };
  };
  actions: typeof BoardActions;
}
type BatteryWindow = Window & { __boardBattery: PageBattery };

/**
 * Runs in the board page: finds the board's runtime (main.tsx hands it to <Board> as a prop, so it
 * hangs on the first fiber under React's root) and loads the action module the page itself uses.
 * A workaround: window.__boardSpike offers neither.
 */
const INSTALL = async (): Promise<boolean> => {
  interface Fiber {
    memoizedProps?: { runtime?: { store?: unknown } } | null;
    child?: Fiber | null;
    sibling?: Fiber | null;
  }
  const root = document.getElementById("root");
  const key = root ? Object.keys(root).find((one) => one.startsWith("__reactContainer$")) : undefined;
  const stack: Array<Fiber | null | undefined> = [key && root ? (root as unknown as Record<string, Fiber>)[key] : null];
  let runtime: unknown;
  for (let visited = 0; stack.length > 0 && runtime === undefined && visited < 20_000; visited++) {
    const at = stack.pop();
    if (!at) continue;
    if (at.memoizedProps?.runtime?.store) runtime = at.memoizedProps.runtime;
    stack.push(at.sibling, at.child);
  }
  if (runtime === undefined) return false;
  // the URL the page's own modules import it by: the same module instance, the same Yjs
  const path = "/src/notations/board/board-actions.ts";
  const actions: unknown = await import(/* @vite-ignore */ path);
  Object.assign(window, { __boardBattery: { runtime, actions } });
  return true;
};

async function install(board: Board): Promise<void> {
  if (!(await board.page.evaluate(INSTALL))) throw new Error("the board's runtime was not found under React's root");
}

/** replaces a model file's text through a replica of its own, as a peer would: the smallest change of the text */
async function setFileText(board: Board, path: string, text: string): Promise<void> {
  await board.page.evaluate(
    ([file, next]) => {
      const replica = (window as unknown as BatteryWindow).__boardBattery.runtime.hub.replica(file);
      const now = replica.ytext.toString();
      let head = 0;
      while (head < now.length && head < next.length && now[head] === next[head]) head++;
      let tail = 0;
      while (
        tail < now.length - head &&
        tail < next.length - head &&
        now[now.length - 1 - tail] === next[next.length - 1 - tail]
      ) {
        tail++;
      }
      replica.doc.transact(() => {
        replica.ytext.delete(head, now.length - head - tail);
        replica.ytext.insert(head, next.slice(head, next.length - tail));
      });
      replica.destroy();
    },
    [path, text] as const,
  );
}

// ── the page's geometry ──────────────────────────────────────────────────────

const rectOf = (page: Page, selector: string): Promise<Box | null> =>
  page.evaluate((query) => {
    const element = document.querySelector(query);
    if (!element) return null;
    const native = (window as NativeWindow).__boardSpikeNative;
    const { x, y, width, height } = native ? native.rect(element) : element.getBoundingClientRect();
    return { x, y, width, height };
  }, selector);

async function mustRect(page: Page, selector: string, timeout = WAIT): Promise<Box> {
  const end = Date.now() + timeout;
  for (;;) {
    const box = await rectOf(page, selector);
    if (box && box.width > 0 && box.height > 0) return box;
    if (Date.now() >= end) throw new Error(`nothing on the page matches ${selector}`);
    await sleep(50);
  }
}

interface Top {
  what: string;
  /** the board node the topmost element belongs to */
  node: string | null;
  edge: string | null;
  pane: boolean;
  /** inside the overlay strategy's layer above the board */
  overlay: boolean;
  frame: boolean;
  handle: string | null;
  control: string | null;
}
/** what a person sees at a point where the element `id` should be */
const seenAt = (top: Top | null, id: string, name: string): string =>
  top === null
    ? "nothing"
    : top.node === id
      ? name
      : top.overlay
        ? `the overlaid editor: ${name} is under it`
        : top.frame
          ? `the armed node's frame: ${name} is under it`
          : top.node === "m-bpmn"
            ? `the armed node: ${name} is under it`
            : top.what;

/** what the TOP document has at a screen point */
const topAt = (page: Page, point: Point): Promise<Top> =>
  page.evaluate(
    ([x, y]) => {
      const native = (window as NativeWindow).__boardSpikeNative;
      const element = native ? native.elementFromPoint(document, x, y) : document.elementFromPoint(x, y);
      const classes = element?.getAttribute("class") ?? "";
      return {
        what: element ? `${element.tagName.toLowerCase()}.${classes.slice(0, 70)}` : "nothing",
        node: element?.closest(".react-flow__node")?.getAttribute("data-id") ?? null,
        edge: element?.closest(".react-flow__edge")?.getAttribute("data-id") ?? null,
        pane: element?.classList.contains("react-flow__pane") ?? false,
        overlay: !!element?.closest(".board-overlay-layer"),
        frame: element?.tagName === "IFRAME",
        handle: element?.closest(".react-flow__handle")?.getAttribute("data-handleid") ?? null,
        control: element?.closest(".react-flow__resize-control")?.getAttribute("class") ?? null,
      };
    },
    [point.x, point.y] as const,
  );

const handleOf = async (page: Page, id: string, side: string): Promise<Point> =>
  centre(await mustRect(page, `.react-flow__handle[data-nodeid="${id}"][data-handleid="${side}"]`));

/** a point of an arrow's line that the arrow itself answers at (labels and grips lie over it elsewhere) */
async function linePoint(page: Page, edgeId: string, lineClass = "board-arrow__line"): Promise<Point | null> {
  return page.evaluate(
    ([id, cls]) => {
      const native = (window as NativeWindow).__boardSpikeNative;
      const path = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${id}"] .${cls}`);
      const matrix = path && (native ? native.screenCTM(path) : path.getScreenCTM());
      if (!path || !matrix) return null;
      for (const share of [0.5, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85]) {
        const at = path.getPointAtLength(path.getTotalLength() * share);
        const point = { x: at.x * matrix.a + matrix.e, y: at.y * matrix.d + matrix.f };
        const top = native
          ? native.elementFromPoint(document, point.x, point.y)
          : document.elementFromPoint(point.x, point.y);
        if (cls !== "board-arrow__line" || top?.closest(".react-flow__edge")?.getAttribute("data-id") === id) {
          return point;
        }
      }
      return null;
    },
    [edgeId, lineClass] as const,
  );
}

const selectedOnBoard = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node.selected, .react-flow__edge.selected")].map(
      (element) => element.getAttribute("data-id") ?? "?",
    ),
  );
const derivedShown = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__edge")]
      .map((element) => element.getAttribute("data-id") ?? "")
      .filter((id) => id.startsWith("derived:"))
      .sort(),
  );
const focusOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return "body";
    if (element.classList.contains("react-flow__node")) return `node wrapper ${element.getAttribute("data-id")}`;
    if (element.tagName === "IFRAME") return "frame";
    const inside = element.closest(".board-engine, .board-overlay-layer, .board-node__body") ? " in the editor" : "";
    return `${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "").split(" ")[0]}${inside}`;
  });

/** a point of the bare pane inside `area` (screen px), searched from its middle outwards */
async function panePoint(page: Page, area: Box): Promise<Point> {
  const found = await page.evaluate((box) => {
    const native = (window as NativeWindow).__boardSpikeNative;
    const pane = document.querySelector(".react-flow__pane");
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const points: Array<{ x: number; y: number }> = [];
    for (let y = box.y + 6; y < box.y + box.height - 6; y += 12) {
      for (let x = box.x + 6; x < box.x + box.width - 6; x += 12) points.push({ x: Math.round(x), y: Math.round(y) });
    }
    points.sort((a, b) => Math.hypot(a.x - middle.x, a.y - middle.y) - Math.hypot(b.x - middle.x, b.y - middle.y));
    for (const point of points) {
      const top = native
        ? native.elementFromPoint(document, point.x, point.y)
        : document.elementFromPoint(point.x, point.y);
      if (top === pane) return point;
    }
    return null;
  }, area);
  if (!found) throw new Error(`no bare pane inside ${JSON.stringify(area)}`);
  return found;
}

// ── the board file ───────────────────────────────────────────────────────────

interface FileState {
  text: string;
  /** how often the board document told the hub that it changed: one per transaction that wrote */
  version: number;
  models: Record<string, number>;
  assets: Record<string, number>;
}
async function fileState(board: Board): Promise<FileState> {
  const files = await board.files();
  return {
    text: await board.boardText(),
    version: files.find((file) => file.kind === "board")?.version ?? -1,
    models: Object.fromEntries(files.filter((file) => file.kind === "model").map((file) => [file.path, file.version])),
    assets: Object.fromEntries(files.filter((file) => file.kind === "asset").map((file) => [file.path, file.bytes])),
  };
}

interface FileDiff {
  added: string[];
  removed: string[];
  changed: string[];
  /** per changed element: the attributes whose value differs, added or gone */
  attributes: Record<string, string[]>;
  bytesBefore: number;
  bytesAfter: number;
  /** bytes of the lines that are new or changed, newline included: what a diff shows as added */
  bytesWritten: number;
  /** the header and every line of an element the gesture did not touch are byte-identical, in the canonical order */
  restIdentical: boolean;
  writes: number;
  modelsChanged: string[];
  newAssets: string[];
}

function diffState(before: FileState, after: FileState): FileDiff {
  const linesOf = (text: string): Map<string, string> =>
    new Map(
      text
        .split("\n")
        .filter((line) => line !== "")
        .slice(1)
        .map((line) => [String((JSON.parse(line) as Json).id), line]),
    );
  const [was, now] = [linesOf(before.text), linesOf(after.text)];
  const added = [...now.keys()].filter((id) => !was.has(id));
  const removed = [...was.keys()].filter((id) => !now.has(id));
  const changed = [...now.keys()].filter((id) => was.has(id) && was.get(id) !== now.get(id));
  const attributes: Record<string, string[]> = {};
  for (const id of changed) {
    const [a, b] = [JSON.parse(was.get(id)!) as Json, JSON.parse(now.get(id)!) as Json];
    attributes[id] = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
      (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
    );
  }
  // the text the file must be when only those elements differ: the old lines, with the changed
  // ones swapped, sorted by id as the codec sorts them
  const expected = new Map(was);
  for (const id of removed) expected.delete(id);
  for (const id of [...added, ...changed]) expected.set(id, now.get(id)!);
  const rebuilt = `${[before.text.split("\n")[0], ...[...expected.keys()].sort().map((id) => expected.get(id))].join("\n")}\n`;
  return {
    added,
    removed,
    changed,
    attributes,
    bytesBefore: bytesOf(before.text),
    bytesAfter: bytesOf(after.text),
    bytesWritten: [...added, ...changed].reduce((sum, id) => sum + bytesOf(now.get(id)!) + 1, 0),
    restIdentical: rebuilt === after.text,
    writes: after.version - before.version,
    modelsChanged: Object.keys(after.models).filter((path) => after.models[path] !== before.models[path]),
    newAssets: Object.keys(after.assets).filter((path) => !(path in before.assets)),
  };
}

const diffLine = (diff: FileDiff): string =>
  `+${diff.added.length} -${diff.removed.length} ~${diff.changed.length} lines, ${diff.bytesWritten} B written, file ${diff.bytesBefore} -> ${diff.bytesAfter} B, ${diff.writes} write${diff.writes === 1 ? "" : "s"}, rest ${diff.restIdentical ? "identical" : "DIFFERS"}`;

/**
 * The same change through the action layer, in Node, on a document loaded from the text the page
 * had before the gesture. New elements get random ids on both sides: the ids are made alike first.
 */
function replay(before: string, after: string, apply: (store: BoardStore) => void) {
  const store = createBoardStore(createBoardDoc(before));
  apply(store);
  const acted = store.text();
  store.destroy();
  const known = new Set(lineRows(before).map((row) => String(row.id)));
  const alike = (text: string): string[] => {
    const fresh = lineRows(text)
      .map((row) => String(row.id))
      .filter((id) => !known.has(id));
    let out = text;
    fresh.forEach((id, index) => (out = out.replaceAll(id, `<new ${id.slice(0, 2)}${index}>`)));
    return out.split("\n").filter((line) => line !== "");
  };
  const [gesture, action] = [alike(after), alike(acted)];
  return {
    same: gesture.length === action.length && gesture.every((line) => action.includes(line)),
    onlyGesture: gesture.filter((line) => !action.includes(line)),
    onlyAction: action.filter((line) => !gesture.includes(line)),
  };
}

// ── pictures ─────────────────────────────────────────────────────────────────

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
  return out;
}

/**
 * A valid PNG of one colour. With `bytes` it is padded to exactly that size by an ancillary chunk
 * a decoder skips (and the pixel data is stored, not deflated, so the padding is not all of it).
 */
function png(width: number, height: number, rgb: readonly [number, number, number], bytes?: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const line = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) line.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => line));
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: bytes === undefined ? 9 : 0 })),
  ];
  const end = pngChunk("IEND", Buffer.alloc(0));
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + end.length;
  if (bytes !== undefined) {
    if (bytes < size + 12) throw new Error(`a ${width} x ${height} picture has ${size} B already`);
    chunks.push(pngChunk("paDd", Buffer.alloc(bytes - size - 12, 0x2e)));
  }
  return Buffer.concat([...chunks, end]);
}

const BLUE = [51, 93, 229] as const;

/**
 * The browser has ONE clipboard for all of its pages, and the pages of this run work side by side:
 * whoever copies and pastes does it alone, from the copy to the paste.
 */
let clipboardFree: Promise<unknown> = Promise.resolve();
function alone<T>(work: () => Promise<T>): Promise<T> {
  const mine = clipboardFree.then(work, work);
  clipboardFree = mine.catch(() => undefined);
  return mine;
}

/** puts a PNG into the real clipboard of the page */
async function copyImage(page: Page, picture: Buffer): Promise<string> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  return page.evaluate(
    async (data) => {
      try {
        const blob = new Blob([new Uint8Array(data)], { type: "image/png" });
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        return "written";
      } catch (error) {
        return String(error);
      }
    },
    [...picture],
  );
}

/** a real file drag of DevTools onto a point of the page: dragenter, dragover, drop, with the browser's own events */
async function dropFile(board: Board, path: string, at: Point): Promise<{ hint: boolean }> {
  const session = await board.cdp();
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  const point = { x: Math.round(at.x), y: Math.round(at.y) };
  await session.send("Input.dispatchDragEvent", { type: "dragEnter", ...point, data });
  await session.send("Input.dispatchDragEvent", { type: "dragOver", ...point, data });
  await sleep(120);
  const hint = await board.page.evaluate(() => document.querySelector(".board-drop-hint") !== null);
  await session.send("Input.dispatchDragEvent", { type: "drop", ...point, data });
  return { hint };
}

const countImages = (page: Page): Promise<number> =>
  page.evaluate(() => document.querySelectorAll(".react-flow__node-image").length);
async function waitForImages(board: Board, count: number, timeout = WAIT): Promise<boolean> {
  return (await board.waitFor(async () => (await countImages(board.page)) >= count, timeout)) === true;
}

// ── part "file": what a gesture writes ───────────────────────────────────────

interface Ctx {
  board: Board;
  page: Page;
  view: Viewport;
  canvas: Box;
  before: FileState;
  /** screen px to board coordinates, as React Flow's screenToFlowPosition does it */
  toFlow(point: Point): FlowPoint;
  /** a node's box on screen as a box of the board */
  flowBox(box: Box): Box;
  /** the middle of what the board shows, in board coordinates: where the toolbar puts a new node */
  middle(): FlowPoint;
}

interface Replay {
  /** how a program would write the call */
  call: string;
  apply(store: BoardStore): void;
  /** its arguments are read off the SCREEN after the gesture: other lines than the gesture's mean the file is not what the screen shows */
  fromScreen?: boolean;
}
interface Outcome {
  note?: string;
  /** the action that is this gesture's counterpart; null: there is none, `why` says what is missing */
  action: Replay | null;
  why?: string;
  /** a second, plainer way to call the action layer, when the first needs what only React Flow knows */
  plain?: Replay;
}
interface Gesture {
  name: string;
  /** what a person did, for the table */
  does: string;
  strategy?: Strategy;
  view: Viewport;
  /** what one line per touched element means here */
  expect: { added?: number; removed?: number; changed?: number; writes?: number; models?: number; assets?: number };
  settle?: number;
  /** a verdict of the gesture's own, where the general rule does not say it */
  verdict?(diff: FileDiff): Verdict;
  run(ctx: Ctx): Promise<Outcome>;
}

/** the demo board's lower left corner at 1 px per unit: the two notes' corner, an image, the Wardley node above */
const CORNER: Viewport = { x: 700, y: -1000, zoom: 1 };
/** the whole demo board */
const WHOLE: Viewport = { x: 40, y: 120, zoom: 0.5 };
const PARAGRAPH = "A second paragraph of about eighty characters, typed in one go by one person.";

async function selectNode(ctx: Ctx, id: string): Promise<Box> {
  const box = (await ctx.board.nodeBox(id))!;
  await ctx.board.click(centre(box));
  await ctx.board.waitFor(async () => (await selectedOnBoard(ctx.page)).includes(id), WAIT);
  return box;
}
async function selectArrow(ctx: Ctx, id: string): Promise<void> {
  const at = await linePoint(ctx.page, id);
  if (!at) throw new Error(`no free point on the arrow ${id}`);
  await ctx.board.click(at);
  await mustRect(ctx.page, `.board-arrow-grip[data-edge="${id}"][data-end="target"]`);
}
const groupStrip = (ctx: Ctx, side: string): Promise<Box> =>
  mustRect(ctx.page, `${nodeSel("d-group")} .board-group__edge[data-side="${side}"]`);
async function selectGroup(ctx: Ctx): Promise<void> {
  const strip = await groupStrip(ctx, "right");
  await ctx.board.click({ x: strip.x + strip.width / 2, y: strip.y + strip.height * 0.8 });
  await ctx.board.waitFor(async () => (await selectedOnBoard(ctx.page)).includes("d-group"), WAIT);
}
const control = (id: string, name: string): string =>
  `${nodeSel(id)} .react-flow__resize-control.handle.${name.replace("-", ".")}`;
/** a move as board-flow.tsx hands it to writeDrop: React Flow's position, relative to the node's group */
const moveTo = (ctx: Ctx, id: string, after: Box, relativeTo?: string): Replay => {
  const place = ctx.toFlow(after);
  const origin =
    relativeTo === undefined
      ? undefined
      : absoluteBoxes(createBoardStore(createBoardDoc(ctx.before.text)).getSnapshot()).get(relativeTo);
  const to = { x: place.x - (origin?.x ?? 0), y: place.y - (origin?.y ?? 0) };
  return {
    call: `writeDrop(store, { "${id}": ${JSON.stringify(to)} })`,
    apply: (store) => writeDrop(store, { [id]: to }),
    fromScreen: true,
  };
};
const NO_ACTION = (why: string): Outcome => ({ action: null, why });

const GESTURES: Gesture[] = [
  {
    name: "move-note",
    does: "drag a text note by its body",
    view: CORNER,
    expect: { changed: 1 },
    async run(ctx) {
      const before = (await ctx.board.nodeBox("d-note-2"))!;
      const grab = centre(before);
      await ctx.board.drag(grab, { x: grab.x - 100, y: grab.y + 60 }, { lead: [3] });
      await sleep(300);
      const after = (await ctx.board.nodeBox("d-note-2"))!;
      return {
        note: `${after.x - before.x}, ${after.y - before.y} px on screen`,
        action: moveTo(ctx, "d-note-2", after),
      };
    },
  },
  {
    name: "move-model",
    does: "drag a model node by its header",
    view: { x: 300, y: 200, zoom: 1 },
    expect: { changed: 1 },
    async run(ctx) {
      const before = (await ctx.board.nodeBox("d-storm"))!;
      const grab = { x: before.x + 200, y: before.y + 14 };
      await ctx.board.drag(grab, { x: grab.x - 90, y: grab.y + 50 }, { lead: [3] });
      await sleep(300);
      const after = (await ctx.board.nodeBox("d-storm"))!;
      return {
        note: `${after.x - before.x}, ${after.y - before.y} px on screen`,
        action: moveTo(ctx, "d-storm", after),
      };
    },
  },
  ...(["bottom-right", "top-left"] as const).map((corner): Gesture => ({
    name: `resize-note-${corner}`,
    does: `resize a note by its ${corner.replace("-", " ")} handle`,
    view: CORNER,
    expect: { changed: 1 },
    async run(ctx) {
      await selectNode(ctx, "d-note-2");
      const handle = centre(await mustRect(ctx.page, control("d-note-2", corner)));
      const by = corner === "bottom-right" ? { x: 60, y: 40 } : { x: -40, y: -30 };
      await ctx.board.drag(handle, { x: handle.x + by.x, y: handle.y + by.y }, { lead: [3] });
      await sleep(300);
      const box = ctx.flowBox((await ctx.board.nodeBox("d-note-2"))!);
      return {
        note: `box ${box.x},${box.y} ${box.width}x${box.height}`,
        action: {
          call: `writeGeometry(store, { "d-note-2": ${JSON.stringify(box)} })`,
          apply: (store) => writeGeometry(store, { "d-note-2": box }),
          fromScreen: true,
        },
      };
    },
  })),
  ...(
    [
      ["note-one-character", "type one character into a note", "x"],
      ["note-one-paragraph", "type a paragraph into a note", `\n\n${PARAGRAPH}`],
    ] as const
  ).map(([name, does, typed]): Gesture => ({
    name,
    does,
    view: CORNER,
    expect: { changed: 1 },
    async run(ctx) {
      const box = (await ctx.board.nodeBox("d-note-2"))!;
      await ctx.board.doubleClick(centre(box));
      await ctx.page.waitForSelector(`${nodeSel("d-note-2")} textarea`, { timeout: WAIT });
      await ctx.board.type(typed, 2);
      const written = await fileState(ctx.board);
      await ctx.board.press(typed.length === 1 ? "Escape" : "Control+Enter");
      const text = `${String(rowOf(ctx.before.text, "d-note-2")?.text)}${typed}`;
      return {
        note: `nothing written while typing: ${written.version === ctx.before.version}`,
        action: {
          call: 'store.gesture((tx) => tx.update("d-note-2", { text })): no named action, the store\'s plain update',
          apply: (store) => store.gesture((tx) => tx.update("d-note-2", { text })),
        },
      };
    },
  })),
  {
    name: "note-colour",
    does: "pick a note's colour",
    view: CORNER,
    expect: { changed: 1 },
    async run(ctx) {
      await selectNode(ctx, "d-note-2");
      await ctx.board.click(centre(await mustRect(ctx.page, '.board-swatch[data-color="amber"]')));
      return {
        action: {
          call: 'writeNoteColor(store, "d-note-2", "amber")',
          apply: (store) => writeNoteColor(store, "d-note-2", "amber"),
        },
      };
    },
  },
  {
    name: "arrow-create",
    does: "draw an arrow from a handle to a handle",
    view: CORNER,
    expect: { added: 1 },
    async run(ctx) {
      await ctx.board.move(centre((await ctx.board.nodeBox("d-note-2"))!));
      const [from, to] = [await handleOf(ctx.page, "d-note-2", "right"), await handleOf(ctx.page, "d-image", "left")];
      const hit = await topAt(ctx.page, from);
      await ctx.board.drag(from, to, { steps: 16 });
      return {
        note: `pressed on handle ${hit.handle}`,
        action: {
          call: 'addArrow(store, { node: "d-note-2", side: "right" }, { node: "d-image", side: "left" })',
          apply: (store) =>
            void addArrow(store, { node: "d-note-2", side: "right" }, { node: "d-image", side: "left" }),
        },
      };
    },
  },
  {
    name: "arrow-create-on-body",
    does: "draw an arrow from a handle and drop it on a model node's body",
    view: CORNER,
    expect: { added: 1 },
    async run(ctx) {
      await ctx.board.move(centre((await ctx.board.nodeBox("d-note-2"))!));
      const from = await handleOf(ctx.page, "d-note-2", "top");
      const wardley = (await ctx.board.nodeBox("d-wardley"))!;
      const to = { x: from.x, y: wardley.y + wardley.height - 90 };
      await ctx.board.drag(from, to, { steps: 16 });
      const [point, reach] = [ctx.toFlow(to), 12 / ctx.view.zoom];
      return {
        note: `dropped ${round(wardley.y + wardley.height - to.y, 0)} px inside the node`,
        action: {
          call: 'addArrow(store, { node: "d-note-2", side: "top" }, arrowEndAt(view, point, reach, "d-note-2"))',
          apply: (store) => {
            const end = arrowEndAt(store.getSnapshot(), point, reach, "d-note-2");
            if (end) addArrow(store, { node: "d-note-2", side: "top" }, end);
          },
        },
      };
    },
  },
  {
    name: "arrow-label",
    does: "change an arrow's label",
    view: CORNER,
    expect: { changed: 1 },
    async run(ctx) {
      await ctx.board.doubleClick(centre(await mustRect(ctx.page, '.board-arrow-label[data-edge="d-arrow-3"]')));
      await ctx.page.waitForSelector('.board-arrow-label[data-edge="d-arrow-3"] input', { timeout: WAIT });
      await ctx.board.press("Control+A");
      await ctx.board.type("photo of the wall", 2);
      await ctx.board.press("Enter");
      return {
        action: {
          call: 'store.gesture((tx) => tx.update("d-arrow-3", { label })): no named action, the store\'s plain update',
          apply: (store) => store.gesture((tx) => tx.update("d-arrow-3", { label: "photo of the wall" })),
        },
      };
    },
  },
  {
    name: "arrow-reconnect",
    does: "drag an arrow's end to another node",
    view: CORNER,
    expect: { changed: 1 },
    async run(ctx) {
      await selectArrow(ctx, "d-arrow-3");
      const grip = centre(await mustRect(ctx.page, '.board-arrow-grip[data-edge="d-arrow-3"][data-end="target"]'));
      const note = (await ctx.board.nodeBox("d-note-2"))!;
      const to = { x: note.x + note.width - 60, y: note.y + 50 };
      await ctx.board.drag(grip, to, { lead: [5], steps: 10 });
      const [point, reach] = [ctx.toFlow(to), 12 / ctx.view.zoom];
      return {
        action: {
          call: 'reconnectArrow(store, "d-arrow-3", "target", arrowEndAt(view, point, reach, "d-image"))',
          apply: (store) => {
            const end = arrowEndAt(store.getSnapshot(), point, reach, "d-image");
            if (end) reconnectArrow(store, "d-arrow-3", "target", end);
          },
        },
      };
    },
  },
  ...(["key", "toolbar"] as const).map((how): Gesture => ({
    name: `arrow-delete-${how}`,
    does: how === "key" ? "select an arrow, press Delete" : "select an arrow, press the toolbar's delete button",
    view: CORNER,
    expect: { removed: 1 },
    async run(ctx) {
      await selectArrow(ctx, "d-arrow-3");
      if (how === "key") await ctx.board.press("Delete");
      else await ctx.page.click(".board-toolbar__delete");
      return {
        action: {
          call: 'writeRemoval(store, [], ["d-arrow-3"])',
          apply: (store) => writeRemoval(store, [], ["d-arrow-3"]),
        },
      };
    },
  })),
  {
    name: "node-delete",
    does: "select an image that an arrow starts at, press Delete",
    view: CORNER,
    expect: { removed: 2 },
    async run(ctx) {
      await selectNode(ctx, "d-image");
      await ctx.board.press("Delete");
      return {
        note: "the image's file stays in the repository",
        action: {
          call: 'writeRemoval(store, ["d-image"], ["d-arrow-3"]): the caller has to name the arrows at the node',
          apply: (store) => writeRemoval(store, ["d-image"], ["d-arrow-3"]),
        },
        plain: { call: 'writeRemoval(store, ["d-image"], [])', apply: (store) => writeRemoval(store, ["d-image"], []) },
      };
    },
  },
  {
    name: "image-picker",
    does: "add an image through the toolbar's file picker",
    view: CORNER,
    expect: { added: 1, assets: 1 },
    async run(ctx) {
      const count = await countImages(ctx.page);
      await ctx.page.setInputFiles(PICKER, { name: "wall.png", mimeType: "image/png", buffer: png(600, 300, BLUE) });
      await waitForImages(ctx.board, count + 1);
      const at = ctx.middle();
      return {
        action: {
          call: 'addNode(store, { type: "image", file: "assets/wall.png", ...fitImage({ width: 600, height: 300 }) }, centre): the node only; the file itself is added by board-gestures.tsx (importImages), which is no action',
          apply: (store) =>
            void addNode(
              store,
              { type: "image", file: "assets/wall.png", ...fitImage({ width: 600, height: 300 }) },
              at,
            ),
        },
      };
    },
  },
  {
    name: "image-paste",
    does: "paste an image from the clipboard",
    view: CORNER,
    expect: { added: 1, assets: 1 },
    async run(ctx) {
      const count = await countImages(ctx.page);
      const [wrote, pasted] = await alone(async () => {
        const written = await copyImage(ctx.page, png(200, 100, [205, 24, 57]));
        // the focus on the page, on nothing that takes text
        await ctx.board.click(await panePoint(ctx.page, { x: 60, y: 300, width: 560, height: 600 }));
        await ctx.board.press("Control+V");
        return [written, await waitForImages(ctx.board, count + 1)] as const;
      });
      const at = ctx.middle();
      return {
        note: `clipboard ${wrote}, real paste ${pasted ? "took" : "DID NOT TAKE"}`,
        action: {
          call: 'addNode(store, { type: "image", file: "assets/image.png", ...fitImage({ width: 200, height: 100 }) }, centre): the node only',
          apply: (store) =>
            void addNode(
              store,
              { type: "image", file: "assets/image.png", ...fitImage({ width: 200, height: 100 }) },
              at,
            ),
        },
      };
    },
  },
  {
    name: "image-drop",
    does: "drop an image file onto the board",
    view: CORNER,
    expect: { added: 1, assets: 1 },
    async run(ctx) {
      const count = await countImages(ctx.page);
      const path = outPath("files/dropped.png");
      writeFileSync(path, png(300, 200, [255, 176, 0]));
      const at = await panePoint(ctx.page, { x: 100, y: 700, width: 500, height: 400 });
      const { hint } = await dropFile(ctx.board, path, at);
      const dropped = await waitForImages(ctx.board, count + 1);
      const point = ctx.toFlow(at);
      return {
        note: `hint shown ${hint}, the drop ${dropped ? "took" : "DID NOT TAKE"}`,
        action: {
          call: 'addNode(store, { type: "image", file: "assets/dropped.png", ...fitImage({ width: 300, height: 200 }) }, point): the node only',
          apply: (store) =>
            void addNode(
              store,
              { type: "image", file: "assets/dropped.png", ...fitImage({ width: 300, height: 200 }) },
              point,
            ),
        },
      };
    },
  },
  {
    name: "group-create-empty",
    does: "press Group with nothing selected",
    view: CORNER,
    expect: { added: 1 },
    async run(ctx) {
      await ctx.page.click('.board-toolbar button[title="Add an empty group"]');
      const at = ctx.middle();
      return {
        action: {
          call: 'addNode(store, { type: "group", ...NEW_NODE.group, text: "Group" }, centre)',
          apply: (store) => void addNode(store, { type: "group", ...NEW_NODE.group, text: "Group" }, at),
        },
      };
    },
  },
  {
    name: "group-create-around",
    does: "select two nodes, press Group",
    view: CORNER,
    expect: { added: 1, changed: 2 },
    async run(ctx) {
      await selectNode(ctx, "d-note-2");
      await ctx.page.keyboard.down("Control");
      await ctx.board.click(centre((await ctx.board.nodeBox("d-image"))!));
      await ctx.page.keyboard.up("Control");
      const selected = await selectedOnBoard(ctx.page);
      await ctx.page.click('.board-toolbar button[title="Draw a group around the selected nodes"]');
      return {
        note: `selected ${selected.join(", ")}`,
        action: {
          call: 'addGroupAround(store, ["d-note-2", "d-image"], "Group")',
          apply: (store) => void addGroupAround(store, ["d-note-2", "d-image"], "Group"),
        },
      };
    },
  },
  {
    name: "group-add-member",
    does: "drag a note into a group",
    view: WHOLE,
    expect: { changed: 1 },
    async run(ctx) {
      const [note, group] = [(await ctx.board.nodeBox("d-note-2"))!, (await ctx.board.nodeBox("d-group"))!];
      const grab = centre(note);
      // the free lower right corner of the group
      await ctx.board.drag(
        grab,
        { x: group.x + group.width * 0.8, y: group.y + group.height * 0.85 },
        { lead: [3], steps: 20 },
      );
      await sleep(300);
      return { action: moveTo(ctx, "d-note-2", (await ctx.board.nodeBox("d-note-2"))!) };
    },
  },
  {
    name: "group-remove-member",
    does: "drag a member out of its group",
    view: WHOLE,
    expect: { changed: 1 },
    async run(ctx) {
      const [note, group] = [(await ctx.board.nodeBox("d-note-1"))!, (await ctx.board.nodeBox("d-group"))!];
      const grab = centre(note);
      await ctx.board.drag(grab, { x: group.x + group.width + 140, y: grab.y + 20 }, { lead: [3], steps: 20 });
      await sleep(300);
      return { action: moveTo(ctx, "d-note-1", (await ctx.board.nodeBox("d-note-1"))!, "d-group") };
    },
  },
  {
    name: "group-move",
    does: "drag a group with four members by its border",
    view: WHOLE,
    expect: { changed: 1 },
    async run(ctx) {
      const strip = await groupStrip(ctx, "top");
      const grab = { x: Math.round(strip.x + strip.width * 0.6), y: Math.round(strip.y + strip.height / 2) };
      const member = (await ctx.board.nodeBox("d-order"))!;
      await ctx.board.drag(grab, { x: grab.x + 40, y: grab.y + 30 }, { lead: [3] });
      await sleep(300);
      const moved = (await ctx.board.nodeBox("d-order"))!;
      return {
        note: `a member moved ${moved.x - member.x}, ${moved.y - member.y} px with it`,
        action: moveTo(ctx, "d-group", (await ctx.board.nodeBox("d-group"))!),
      };
    },
  },
  ...(["bottom-right", "top-left"] as const).map((corner): Gesture => ({
    name: `group-resize-${corner}`,
    does: `resize a group with four members by its ${corner.replace("-", " ")} handle`,
    view: WHOLE,
    // the members do not move on the board: one line, the group's
    expect: { changed: 1 },
    async run(ctx) {
      await selectGroup(ctx);
      const member = (await ctx.board.nodeBox("d-order"))!;
      const handle = centre(await mustRect(ctx.page, control("d-group", corner)));
      const by = corner === "bottom-right" ? { x: 40, y: 30 } : { x: -40, y: -30 };
      await ctx.board.drag(handle, { x: handle.x + by.x, y: handle.y + by.y }, { lead: [3] });
      await sleep(300);
      const moved = (await ctx.board.nodeBox("d-order"))!;
      return {
        note: `a member moved ${round(moved.x - member.x, 1)}, ${round(moved.y - member.y, 1)} px on screen`,
        ...NO_ACTION(
          "the write is writeGroupResize in nodes/group-node.tsx, a React module: no action a program can call",
        ),
      };
    },
  })),
  {
    name: "group-delete",
    does: "select a group with four members, press Delete",
    view: WHOLE,
    // the group, its four members and the two arrows that end at a member: the spike's decision
    expect: { removed: 7 },
    async run(ctx) {
      await selectGroup(ctx);
      await ctx.board.press("Delete");
      const members = ["d-order", "d-credit", "d-invoice", "d-note-1"];
      return {
        note: "the model files stay",
        action: {
          call: 'writeRemoval(store, ["d-group", ...its members], [...the arrows at them]): the caller has to name both lists',
          apply: (store) => writeRemoval(store, ["d-group", ...members], ["d-arrow-1", "d-arrow-2"]),
        },
        plain: { call: 'writeRemoval(store, ["d-group"], [])', apply: (store) => writeRemoval(store, ["d-group"], []) },
      };
    },
  },
  {
    name: "group-label",
    does: "rename a group",
    view: WHOLE,
    expect: { changed: 1 },
    async run(ctx) {
      await ctx.board.doubleClick(centre(await mustRect(ctx.page, `${nodeSel("d-group")} .board-group__label`)));
      await ctx.page.waitForSelector(`${nodeSel("d-group")} input`, { timeout: WAIT });
      await ctx.board.press("Control+A");
      await ctx.board.type("Order to cash, as is", 2);
      await ctx.board.press("Enter");
      return {
        action: {
          call: 'store.gesture((tx) => tx.update("d-group", { text })): no named action, the store\'s plain update',
          apply: (store) => store.gesture((tx) => tx.update("d-group", { text: "Order to cash, as is" })),
        },
      };
    },
  },
  {
    name: "model-add",
    does: "add a model node for a file through the toolbar",
    view: CORNER,
    expect: { added: 1 },
    settle: 1500,
    async run(ctx) {
      const file = "processes/order-to-cash.vc.json";
      await ctx.page.selectOption(".board-toolbar__models", file);
      await ctx.board.waitFor(
        async () => (await ctx.board.nodes()).some((one) => one.file === file && one.mounted),
        15_000,
      );
      const at = ctx.middle();
      return {
        action: {
          call: `addNode(store, { type: "model", ...NEW_NODE.model, file: "${file}" }, centre)`,
          apply: (store) => void addNode(store, { type: "model", ...NEW_NODE.model, file }, at),
        },
      };
    },
  },
  {
    name: "key-move",
    does: "select a note, press arrow keys four times",
    view: CORNER,
    expect: { changed: 1 },
    settle: 1000,
    async run(ctx) {
      await selectNode(ctx, "d-note-2");
      for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowDown"]) await ctx.board.press(key);
      const during = await fileState(ctx.board);
      await sleep(900);
      return {
        note: `nothing written while the keys go: ${during.version === ctx.before.version}; written 400 ms after the last key`,
        action: moveTo(ctx, "d-note-2", (await ctx.board.nodeBox("d-note-2"))!),
      };
    },
  },
  {
    name: "undo-key",
    does: "move a note, press Control+Z",
    view: CORNER,
    // the move and its undo: two writes that leave the file as it was
    expect: { writes: 2 },
    verdict: (diff) => (diff.changed.length === 0 && diff.writes === 2 ? "ok" : "broken"),
    async run(ctx) {
      const before = (await ctx.board.nodeBox("d-note-2"))!;
      const grab = centre(before);
      await ctx.board.drag(grab, { x: grab.x - 100, y: grab.y + 60 }, { lead: [3] });
      await sleep(400);
      const focus = await focusOf(ctx.page);
      await ctx.board.press("Control+Z");
      await sleep(400);
      const after = (await ctx.board.nodeBox("d-note-2"))!;
      return {
        note: `Control+Z with the focus on ${focus}: the note is ${after.x - before.x}, ${after.y - before.y} px from where it started`,
        ...NO_ACTION(
          "store.undo.undo() of the board store takes a gesture back (board-file.test.ts); nothing on the page calls it",
        ),
      };
    },
  },
  {
    name: "delete-then-store-undo",
    does: "delete an image and its arrow by key, then store.undo.undo() (which no key calls)",
    view: CORNER,
    // the delete and its undo: two writes that leave the file as it was
    expect: { writes: 2 },
    verdict: (diff) =>
      diff.added.length + diff.removed.length + diff.changed.length === 0 && diff.restIdentical ? "ok" : "wrong-data",
    async run(ctx) {
      await install(ctx.board);
      await selectNode(ctx, "d-image");
      await ctx.board.press("Delete");
      await sleep(400);
      const gone = lineRows(await ctx.board.boardText()).length;
      await ctx.page.evaluate(() => void (window as unknown as BatteryWindow).__boardBattery.runtime.store.undo.undo());
      await sleep(400);
      const back = await ctx.board.boardText();
      const shown = (await ctx.board.nodeBox("d-image")) !== null;
      return {
        note: `${lineRows(ctx.before.text).length} lines, ${gone} after the delete, ${lineRows(back).length} after the undo, byte-identical to the start: ${back === ctx.before.text}; the image is on the board again: ${shown}`,
        ...NO_ACTION(
          "store.undo is the board store's own undo manager: it is the counterpart, and only a program can call it",
        ),
      };
    },
  },
  {
    name: "box-move",
    does: "box-select two nodes, drag the selection",
    view: CORNER,
    expect: { changed: 2 },
    async run(ctx) {
      const [a, b] = [(await ctx.board.nodeBox("d-note-2"))!, (await ctx.board.nodeBox("d-image"))!];
      await ctx.page.keyboard.down("Shift");
      await ctx.board.drag(
        { x: a.x - 30, y: a.y - 30 },
        { x: b.x + b.width + 30, y: b.y + b.height + 30 },
        { steps: 16 },
      );
      await ctx.page.keyboard.up("Shift");
      const frame = await mustRect(ctx.page, ".react-flow__nodesselection-rect");
      const grab = { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + 6) };
      await ctx.board.drag(grab, { x: grab.x + 63, y: grab.y + 36 }, { lead: [3] });
      await sleep(300);
      const [toA, toB] = [
        ctx.toFlow((await ctx.board.nodeBox("d-note-2"))!),
        ctx.toFlow((await ctx.board.nodeBox("d-image"))!),
      ];
      return {
        action: {
          call: 'writeDrop(store, { "d-note-2": to, "d-image": to })',
          apply: (store) => writeDrop(store, { "d-note-2": toA, "d-image": toB }),
          fromScreen: true,
        },
      };
    },
  },
  ...(["overlay", "plugin", "iframe"] as const).map((strategy): Gesture => ({
    name: "arm-disarm",
    does: "double-click a model node, Done, Edit, a click on the bare board",
    strategy,
    // order-to-cash at 300,200 of the canvas
    view: { x: -300, y: 164, zoom: 0.6 },
    expect: {},
    async run(ctx) {
      const armed = async (): Promise<string> =>
        (await ctx.board.nodes())
          .filter((one) => one.armed)
          .map((one) => one.id)
          .join(",");
      const box = (await ctx.board.nodeBox("d-order"))!;
      const seen: string[] = [];
      await ctx.board.doubleClick(centre(box));
      await ctx.board.waitFor(async () => (await armed()) === "d-order", WAIT);
      seen.push(await armed());
      const button = `${nodeSel("d-order")} .board-node__arm`;
      await ctx.board.click(centre(await mustRect(ctx.page, button)));
      await ctx.board.waitFor(async () => (await armed()) === "", WAIT);
      seen.push(await armed());
      await ctx.board.click(centre(await mustRect(ctx.page, button)));
      await ctx.board.waitFor(async () => (await armed()) === "d-order", WAIT);
      seen.push(await armed());
      await ctx.board.click(await panePoint(ctx.page, { x: 20, y: 700, width: 240, height: 500 }));
      await ctx.board.waitFor(async () => (await armed()) === "", WAIT);
      seen.push(await armed());
      const mounts = (await ctx.board.counters()).mounts;
      return {
        note: `armed after each step: ${seen.map((id) => id || "none").join(" / ")}; engine mounts ${Object.values(mounts).join("")}`,
        ...NO_ACTION("arming is this client's own state, not the document's: hooks.arm(id) of the test hooks sets it"),
      };
    },
  })),
  {
    name: "pan-zoom",
    does: "drag the bare board, wheel on it, the toolbar's zoom buttons, fit",
    view: CORNER,
    expect: {},
    async run(ctx) {
      const at = await panePoint(ctx.page, { x: 60, y: 300, width: 560, height: 600 });
      const seen: Viewport[] = [await ctx.board.viewport()];
      await ctx.board.drag(at, { x: at.x + 150, y: at.y + 90 }, { lead: [3] });
      seen.push(await ctx.board.viewport());
      await ctx.board.wheel(at, -240);
      await sleep(200);
      seen.push(await ctx.board.viewport());
      for (const title of ["Zoom out", "Zoom in", "Fit the board"]) {
        await ctx.page.click(`.board-toolbar button[title="${title}"]`);
        await sleep(350);
        seen.push(await ctx.board.viewport());
      }
      const changes = seen
        .slice(1)
        .filter((view, index) => JSON.stringify(view) !== JSON.stringify(seen[index])).length;
      return {
        note: `the viewport changed in ${changes} of 5 steps, to zoom ${round(seen.at(-1)!.zoom, 3)}`,
        ...NO_ACTION(
          "the viewport is this client's own, not the document's: hooks.setViewport of the test hooks sets it",
        ),
      };
    },
  },
  {
    name: "select",
    does: "click a node, click an arrow, box-select, click the bare board",
    view: CORNER,
    expect: {},
    async run(ctx) {
      const seen: string[] = [];
      await selectNode(ctx, "d-note-2");
      seen.push((await selectedOnBoard(ctx.page)).join("+"));
      await selectArrow(ctx, "d-arrow-3");
      seen.push((await selectedOnBoard(ctx.page)).join("+"));
      const [a, b] = [(await ctx.board.nodeBox("d-note-2"))!, (await ctx.board.nodeBox("d-image"))!];
      await ctx.page.keyboard.down("Shift");
      await ctx.board.drag(
        { x: a.x - 30, y: a.y - 30 },
        { x: b.x + b.width + 30, y: b.y + b.height + 30 },
        { steps: 16 },
      );
      await ctx.page.keyboard.up("Shift");
      seen.push((await selectedOnBoard(ctx.page)).join("+"));
      await ctx.board.click(await panePoint(ctx.page, { x: 60, y: 700, width: 560, height: 400 }));
      await sleep(150);
      seen.push((await selectedOnBoard(ctx.page)).join("+") || "none");
      return {
        note: `selected after each step: ${seen.join(" / ")}`,
        ...NO_ACTION("the selection is React Flow's own state: neither the action layer nor the test hooks reach it"),
      };
    },
  },
  {
    name: "edit-in-armed-model",
    does: "the control: drag a task inside the armed editor",
    // order-to-cash at 80,100 of the canvas
    view: { x: -920, y: 40, zoom: 1 },
    expect: { models: 1 },
    settle: 300,
    async run(ctx) {
      await ctx.board.arm("d-order");
      const node = await ctx.board.node("d-order");
      const text = await ctx.board.fileText(ORDER);
      const task = (await node.elementBox("Task_check_credit"))!;
      await node.drag(centre(task), { x: 44, y: 29 }, { hold: ["Control"] });
      const changed = (await ctx.board.waitForFileChange(ORDER, text)) !== null;
      return {
        note: `the model's file changed: ${changed}`,
        ...NO_ACTION("an edit of a model is the editor's, not the board's"),
      };
    },
  },
];

/** what the board has no gesture for: asked for by the task, and not there */
const NO_GESTURE: ReadonlyArray<{ name: string; why: string }> = [
  {
    name: "z-order",
    why: "there is no gesture and no action that changes a node's z: a new node goes on top (store.zOnTop), a new group to the bottom, and nothing moves either afterwards",
  },
];

async function measureGesture(harness: Harness, gesture: Gesture): Promise<void> {
  const strategy = gesture.strategy ?? "overlay";
  const label = { part: "file" as const, case: gesture.name, strategy, zoom: gesture.view.zoom };
  await onBoard(harness, { board: "demo", strategy, ...gesture.view }, label, async (board) => {
    const canvas = await board.canvasBox();
    const before = await fileState(board);
    const view = gesture.view;
    const toFlow = (point: Point): FlowPoint => ({
      x: (point.x - canvas.x - view.x) / view.zoom,
      y: (point.y - canvas.y - view.y) / view.zoom,
    });
    const ctx: Ctx = {
      board,
      page: board.page,
      view,
      canvas,
      before,
      toFlow,
      flowBox: (box) => ({ ...toFlow(box), width: box.width / view.zoom, height: box.height / view.zoom }),
      middle: () => toFlow({ x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 }),
    };
    const outcome = await gesture.run(ctx);
    await sleep(gesture.settle ?? 500);
    const after = await fileState(board);
    const diff = diffState(before, after);
    const want = { added: 0, removed: 0, changed: 0, models: 0, assets: 0, ...gesture.expect };
    const lines = want.added + want.removed + want.changed;
    const wantWrites = gesture.expect.writes ?? (lines > 0 ? 1 : 0);
    const exact =
      diff.added.length === want.added && diff.removed.length === want.removed && diff.changed.length === want.changed;
    const acted = outcome.action ? replay(before.text, after.text, outcome.action.apply) : null;
    const plain = outcome.plain ? replay(before.text, after.text, outcome.plain.apply) : null;
    const problems = await board.problems({ allow: ALLOWED });
    let verdict: Verdict = "ok";
    if (gesture.verdict) verdict = gesture.verdict(diff);
    else if (lines > 0 && diff.added.length + diff.removed.length + diff.changed.length === 0) verdict = "broken";
    else if (!diff.restIdentical || diff.modelsChanged.length !== want.models) verdict = "wrong-data";
    else if (acted && !acted.same && outcome.action?.fromScreen) verdict = "wrong-data";
    else if (!exact || diff.writes !== wantWrites || diff.newAssets.length !== want.assets) verdict = "degraded";
    report({
      ...label,
      verdict,
      measured: `${diffLine(diff)}${diff.modelsChanged.length > 0 ? `, model files changed: ${diff.modelsChanged.length}` : ""}${diff.newAssets.length > 0 ? `, new file ${diff.newAssets.join(", ")}` : ""}${outcome.note ? `; ${outcome.note}` : ""}`,
      expected: `+${want.added} -${want.removed} ~${want.changed} lines, ${wantWrites} write${wantWrites === 1 ? "" : "s"}`,
      details: {
        does: gesture.does,
        diff,
        before: before.text,
        after: after.text,
        action: outcome.action ? { call: outcome.action.call, ...acted } : null,
        noAction: outcome.why ?? null,
        plainAction: outcome.plain ? { call: outcome.plain.call, ...plain } : null,
      },
      problems,
    });
    if (shots && ["group-resize-top-left", "group-create-around"].includes(gesture.name)) {
      await board.screenshot(outPath(`shots/file-${gesture.name}.png`));
    }
  });
}

/** load and serialise without a change, in the page's own document and in Node */
async function measureIdle(harness: Harness): Promise<void> {
  const label = { part: "file" as const, case: "open-and-close", strategy: "overlay", zoom: null };
  await onBoard(harness, { board: "demo", strategy: "overlay" }, label, async (board) => {
    await install(board);
    const first = await fileState(board);
    // the page's own document, read again and loaded into a second document in the page
    const again = await board.page.evaluate(() =>
      (window as unknown as BatteryWindow).__boardBattery.runtime.store.text(),
    );
    const reloaded = boardText(createBoardDoc(first.text));
    await sleep(1500);
    const later = await fileState(board);
    const same = again === first.text && reloaded === first.text && later.text === first.text;
    report({
      ...label,
      verdict: same && later.version === first.version ? "ok" : "wrong-data",
      measured: `${lineRows(first.text).length} elements, ${bytesOf(first.text)} B; read twice the same: ${again === first.text}; loaded from its text and serialised in Node: ${reloaded === first.text ? "byte-identical" : "DIFFERS"}; 1.5 s open: ${later.version - first.version} writes`,
      expected: "byte-identical, 0 writes",
      details: { text: first.text },
      problems: await board.problems({ allow: ALLOWED }),
    });
  });
}

async function partFile(harness: Harness): Promise<void> {
  const tasks = GESTURES.filter((gesture) => wanted(gesture.name)).map(
    (gesture) => () => measureGesture(harness, gesture),
  );
  if (wanted("open-and-close")) tasks.unshift(() => measureIdle(harness));
  await pool(tasks, jobs);
  for (const missing of NO_GESTURE.filter((one) => wanted(one.name))) {
    report({
      part: "file",
      case: missing.name,
      strategy: "overlay",
      zoom: null,
      verdict: "unmeasured",
      measured: missing.why,
      expected: "one changed line",
      details: {},
      problems: [],
    });
  }
}

// ── part "images" ────────────────────────────────────────────────────────────

async function partImages(harness: Harness): Promise<void> {
  const label = { part: "images" as const, case: "", strategy: "overlay", zoom: 1 };
  await onBoard(
    harness,
    { board: "demo", strategy: "overlay", ...CORNER },
    { ...label, case: "images" },
    async (board) => {
      const page = board.page;
      const steps: Array<{ name: string; diff: FileDiff; line: string; ms: number; asset: string }> = [];
      const texts: string[] = [(await fileState(board)).text];
      const pictures = [
        { name: "photo-200k.png", buffer: png(256, 192, BLUE, 200 * 1024) },
        { name: "photo-2m.png", buffer: png(800, 600, [0, 230, 118], 2 * 1024 * 1024) },
      ];
      let state = await fileState(board);
      for (const picture of pictures) {
        const count = await countImages(page);
        const start = Date.now();
        await page.setInputFiles(PICKER, { name: picture.name, mimeType: "image/png", buffer: picture.buffer });
        if (!(await waitForImages(board, count + 1, 15_000))) throw new Error(`${picture.name} did not become a node`);
        const ms = Date.now() - start;
        await sleep(300);
        const next = await fileState(board);
        const diff = diffState(state, next);
        const line = next.text.split("\n").find((one) => one.includes(`"${diff.added[0]}"`)) ?? "";
        steps.push({
          name: picture.name,
          diff,
          line,
          ms,
          asset: diff.newAssets.map((path) => `${path} ${next.assets[path]} B`).join(", "),
        });
        texts.push(next.text);
        state = next;
      }
      // two pastes: what the files are called
      const pasted: string[] = [];
      for (const colour of [
        [205, 24, 57],
        [255, 176, 0],
      ] as const) {
        const count = await countImages(page);
        await alone(async () => {
          await copyImage(page, png(200, 100, colour));
          await board.click(await panePoint(page, { x: 60, y: 300, width: 560, height: 500 }));
          await board.press("Control+V");
          await waitForImages(board, count + 1);
        });
        await sleep(300);
        const next = await fileState(board);
        pasted.push(...diffState(state, next).newAssets);
        state = next;
      }
      // an image node deleted: what becomes of its file
      const big = String(lineRows(state.text).find((row) => row.file === "assets/photo-2m.png")?.id);
      // the pictures lie on top of each other, a step apart: a point of the 2 MiB one that it answers at
      const bigBox = (await board.nodeBox(big))!;
      let grab: Point | undefined;
      for (let y = bigBox.y + 12; y < bigBox.y + bigBox.height - 12 && !grab; y += 16) {
        for (let x = bigBox.x + 12; x < bigBox.x + bigBox.width - 12 && !grab; x += 16) {
          const top = await topAt(page, { x, y });
          if (top.node === big && top.control === null && top.handle === null)
            grab = { x: Math.round(x), y: Math.round(y) };
        }
      }
      if (!grab) throw new Error("the 2 MiB picture is covered whole");
      await board.click(grab);
      await board.waitFor(async () => (await selectedOnBoard(page)).join() === big, WAIT);
      await board.press("Delete");
      await sleep(500);
      const afterDelete = await fileState(board);
      const deleted = !afterDelete.text.includes("photo-2m");
      const orphan = deleted && "assets/photo-2m.png" in afterDelete.assets;

      // the same change as Git sees it: two trees, before and after the 200 KiB picture
      const tree = outPath("images/tree/before/boards/workshop.board");
      const root = dirname(dirname(dirname(tree)));
      rmSync(root, { recursive: true, force: true });
      for (const [side, text, withPicture] of [
        ["before", texts[0]!, false],
        ["after", texts[1]!, true],
      ] as const) {
        mkdirSync(join(root, side, "boards"), { recursive: true });
        mkdirSync(join(root, side, "assets"), { recursive: true });
        writeFileSync(join(root, side, "boards/workshop.board"), text);
        if (withPicture) writeFileSync(join(root, side, "assets/photo-200k.png"), pictures[0]!.buffer);
      }
      let stat: string;
      try {
        stat = execFileSync("git", ["diff", "--no-index", "--stat", "before", "after"], {
          cwd: root,
          encoding: "utf8",
        });
      } catch (error) {
        // git diff --no-index exits 1 when the trees differ
        stat = (error as { stdout?: string }).stdout ?? String(error);
      }
      const inFile = /data:|base64/i.test(state.text);
      const longest = Math.max(...state.text.split("\n").map((line) => bytesOf(line)));
      const problems = await board.problems({ allow: ALLOWED });
      for (const [index, step] of steps.entries()) {
        report({
          ...label,
          case: index === 0 ? "image-200-KiB" : "image-2-MiB",
          verdict:
            step.diff.added.length === 1 && step.diff.changed.length === 0 && !inFile && step.diff.restIdentical
              ? "ok"
              : "broken",
          measured: `board file ${step.diff.bytesBefore} -> ${step.diff.bytesAfter} B (+${step.diff.bytesAfter - step.diff.bytesBefore} B, one line of ${bytesOf(step.line)} B); the bytes: ${step.asset}; a node after ${step.ms} ms (under load)`,
          expected: "one line with the path, the bytes in a file of their own",
          details: { line: step.line, diff: step.diff, gitDiffStat: index === 0 ? stat.trim().split("\n") : undefined },
          problems,
        });
      }
      report({
        ...label,
        case: "image-names-and-orphans",
        verdict: orphan ? "degraded" : "ok",
        measured: `two pastes became ${pasted.join(" and ")}; longest line of the board file ${longest} B, "data:" or "base64" in it: ${inFile}; ${deleted ? `after deleting the 2 MiB node its file is ${orphan ? `still in the repository (${afterDelete.assets["assets/photo-2m.png"]} B), named by no board line` : "gone"}` : "the 2 MiB node could NOT be deleted"}`,
        expected: "a name that two branches cannot both pick, no file left without a node",
        details: { pasted, assets: afterDelete.assets, gitDiffStat: stat.trim().split("\n") },
        problems,
      });
      if (shots) await board.screenshot(outPath("shots/images.png"));
    },
  );
}

// ── part "derived" ───────────────────────────────────────────────────────────

/** the derived arrows the board has to show, computed here from the hub's file texts and the board file */
async function derivedExpected(board: Board): Promise<string[]> {
  const nodes = lineRows(await board.boardText())
    .filter((row) => row.type === "model")
    .map((row) => ({ id: String(row.id), file: String(row.file) }));
  const files = await Promise.all(
    [...new Set(nodes.map((one) => one.file))].map(async (path) => ({
      path,
      text: (await board.fileText(path)) ?? "",
    })),
  );
  // only a file that has a node can be either end of an arrow
  return derivedArrows(derivedRefs(files), nodes)
    .map((arrow) => arrow.id)
    .sort();
}

async function partDerived(harness: Harness): Promise<void> {
  const tasks = strategies
    .filter((strategy) => wanted("derived") || wanted(strategy))
    .map((strategy) => async () => {
      const label = { part: "derived" as const, case: "", strategy, zoom: 1 };
      // order-to-cash at 80,100 of the canvas, at 1 px per unit
      const query = { board: "demo" as const, strategy, x: -920, y: 40, zoom: 1 };
      await onBoard(harness, query, { ...label, case: "derived" }, async (board) => {
        const page = board.page;
        await install(board);
        const start = await fileState(board);
        const drawn = lineRows(start.text).filter((row) => row.kind === "edge").length;
        const bare = (ids: readonly string[]): string =>
          ids.map((id) => id.replace("derived:", "")).join(", ") || "none";
        /**
         * Waits, at most 3 s, until the dashed arrows are the ones the texts name AND `reached` holds
         * (an edit takes a moment to reach the file, and before it did, old arrows equal old texts).
         */
        const step = async (
          name: string,
          expected: string,
          reached: (shown: string[]) => boolean,
          extra = "",
        ): Promise<void> => {
          const from = Date.now();
          let shown: string[] = [];
          let named: string[] = [];
          const ok =
            (await board.waitFor(async () => {
              [shown, named] = [await derivedShown(page), await derivedExpected(board)];
              return shown.join() === named.join() && reached(shown);
            }, 3000)) === true;
          const ms = Date.now() - from;
          const now = await fileState(board);
          const written =
            /derived/.test(now.text) || lineRows(now.text).filter((row) => row.kind === "edge").length > drawn;
          report({
            ...label,
            case: name,
            verdict: written ? "broken" : ok ? "ok" : "wrong-data",
            measured: `${shown.join() === named.join() ? `shown, and named by the texts: ${bare(shown)}` : `shown ${bare(shown)}, but the texts name ${bare(named)}`}; ${ok ? `there ${ms} ms after the step (under load)` : "NOT as expected after 3 s"}; a derived arrow in the board file: ${written}; board writes so far ${now.version - start.version}${extra}`,
            expected,
            details: { shown, named, ms, boardText: now.text },
            problems: await board.problems({ allow: ALLOWED }),
          });
        };
        const has =
          (id: string) =>
          (shown: string[]): boolean =>
            shown.includes(`derived:${id}`);
        const lacks =
          (id: string) =>
          (shown: string[]): boolean =>
            !shown.includes(`derived:${id}`);

        await step("pairs-on-load", "calls:d-order:d-invoice, decides:d-order:d-credit", (shown) => shown.length === 2);

        // 1. in the ARMED editor, by pointer and key: the call activity deleted, then undone
        await board.arm("d-order");
        const node = await board.node("d-order");
        const selected = await node.select("CallActivity_invoice_handling");
        await board.press("Delete");
        await step(
          "edit-delete-call-activity",
          "the calls arrow goes, the board file stays",
          lacks("calls:d-order:d-invoice"),
          `; the call activity was selected by a click: ${selected}`,
        );
        await board.press("Control+Z");
        await step("edit-undo", "the calls arrow is back", has("calls:d-order:d-invoice"));

        // 2. the reference itself, through the engine where the page hands one out (not in a frame)
        const viaEngine = await page.evaluate(() => {
          interface Modeler {
            get(name: string): unknown;
          }
          const hooks = (
            window as unknown as {
              __boardSpike: { engine(id: string): { engine?: { modeler?: Modeler } } | undefined };
            }
          ).__boardSpike;
          const modeler = hooks.engine("d-order")?.engine?.modeler;
          if (!modeler) return false;
          const registry = modeler.get("elementRegistry") as { get(id: string): unknown };
          const modeling = modeler.get("modeling") as {
            updateProperties(element: unknown, properties: Record<string, unknown>): void;
          };
          modeling.updateProperties(registry.get("Task_check_credit"), { calledDecision: "no-such-decision" });
          return true;
        });
        if (!viaEngine) {
          // a frame hides its engine: the same edit as a peer's, in the file's text
          const text = (await board.fileText(ORDER)) ?? "";
          await setFileText(
            board,
            ORDER,
            text.replace('calledDecision="credit-limit-check"', 'calledDecision="no-such-decision"'),
          );
        }
        await step(
          "edit-decision-reference",
          "the decides arrow goes",
          lacks("decides:d-order:d-credit"),
          `; edited ${viaEngine ? "through modeling.updateProperties of the armed editor" : "in the file's text, as a peer (the frame hands out no engine)"}`,
        );
        const text = (await board.fileText(ORDER)) ?? "";
        await setFileText(
          board,
          ORDER,
          text.replace('calledDecision="no-such-decision"', 'calledDecision="credit-limit-check"'),
        );
        await step(
          "edit-reference-back",
          "the decides arrow is back",
          has("decides:d-order:d-credit"),
          "; edited in the file's text, as a peer",
        );

        // 3. a NEW reference in another model: invoice-handling now calls order-to-cash (a peer's edit of the text)
        const invoice = (await board.fileText(INVOICE)) ?? "";
        const task = /<bpmn:(\w*[tT]ask) id="([^"]+)"([^>]*)>([\s\S]*?)<\/bpmn:\1>/.exec(invoice);
        if (task) {
          await setFileText(
            board,
            INVOICE,
            invoice.replace(
              task[0],
              `<bpmn:callActivity id="${task[2]}"${task[3]} calledElement="order-to-cash">${task[4]}</bpmn:callActivity>`,
            ),
          );
        }
        await step(
          "new-reference",
          "a calls arrow from d-invoice to d-order",
          has("calls:d-invoice:d-order"),
          `; ${task ? `${task[2]} became a call activity in the file's text` : "no task found to change"}`,
        );
        const unchanged = (await board.boardText()) === start.text;

        // 4. a click on a dashed arrow and Delete: nothing to select, nothing to delete
        await board.arm(null);
        await board.setViewport({ x: 40, y: 120, zoom: 0.5 });
        const dashed = await linePoint(page, "derived:calls:d-order:d-invoice", "board-derived__line");
        if (dashed) await board.click(dashed);
        const picked = await selectedOnBoard(page);
        await board.press("Delete");
        await sleep(400);
        await step(
          "click-and-delete",
          "nothing selected, nothing deleted",
          (shown) => shown.length === 3 && picked.length === 0 && unchanged,
          `; a click on a dashed arrow selected ${picked.join(",") || "nothing"}, then Delete; the board file byte-identical through all edits so far: ${unchanged}`,
        );

        // 5. the target node removed, then a second node of a called file added
        const credit = (await board.nodeBox("d-credit"))!;
        await board.click({ x: credit.x + 60, y: credit.y + 7 });
        await board.press("Delete");
        await sleep(500);
        await step(
          "target-node-removed",
          "the decides arrow goes with d-credit",
          (shown) => !shown.some((id) => id.includes("d-credit")),
        );
        await page.selectOption(".board-toolbar__models", INVOICE);
        await board.waitFor(
          async () => (await board.nodes()).filter((one) => one.file === INVOICE && one.mounted).length === 2,
          15_000,
        );
        await step(
          "second-node-of-a-file",
          "an arrow to each node of the called file, and from each node of the calling one",
          (shown) => shown.length === 4,
        );
        if (shots) await board.screenshot(outPath(`shots/derived-${strategy}.png`));
      });
    });
  await pool(tasks, jobs);
}

// ── part "armed": the board's gestures next to an armed editor ───────────────

interface ArmedSetup {
  group: string;
  /** a note left of the group, outside it */
  note: string;
  /** a note inside the group, below the model node */
  member: string;
  arrow: string;
}

/**
 * The armed cases' board: the matrix board's one BPMN node, a note under it, a group around both,
 * a note left of the group and an arrow from that note to the model node. Set up through the
 * action layer in the page, so every page of a case starts from the same lines.
 */
const SETUP_ARMED = (): ArmedSetup => {
  const { runtime, actions } = (window as unknown as BatteryWindow).__boardBattery;
  const member = actions.addNode(
    runtime.store,
    { type: "text", width: 200, height: 100, text: "A member" },
    { x: 400, y: 620 },
  );
  const group = actions.addGroupAround(runtime.store, ["m-bpmn", member], "Group") ?? "";
  const note = actions.addNode(
    runtime.store,
    { type: "text", width: 200, height: 120, text: "Drag me" },
    { x: -232, y: 270 },
  );
  const arrow = actions.addArrow(runtime.store, { node: note, side: "bottom" }, { node: "m-bpmn", side: "left" });
  return { group, note, member, arrow };
};

interface ArmedCtx {
  board: Board;
  page: Page;
  node: NodeHandle;
  strategy: Strategy;
  zoom: number;
  ids: ArmedSetup;
  before: FileState;
  model: string;
}
interface ArmedResult {
  verdict: Verdict;
  measured: string;
  expected: string;
  details?: Record<string, unknown>;
  shot?: boolean;
}

/** what every armed case says at its end: the model, the armed state, the node, the engine */
async function standing(
  ctx: ArmedCtx,
): Promise<{ modelSame: boolean; armed: boolean; onBoard: boolean; mounts: number; text: string }> {
  const nodes = await ctx.board.nodes();
  return {
    modelSame: (await ctx.board.fileText(ORDER)) === ctx.model,
    armed: nodes.some((one) => one.id === "m-bpmn" && one.armed),
    onBoard: nodes.some((one) => one.id === "m-bpmn"),
    mounts: (await ctx.board.counters()).mounts["m-bpmn"] ?? 0,
    text: `model ${(await ctx.board.fileText(ORDER)) === ctx.model ? "same" : "CHANGED"}, ${nodes.some((one) => one.id === "m-bpmn" && one.armed) ? "armed" : "DISARMED"}`,
  };
}
const harmed = (state: { modelSame: boolean; onBoard: boolean }): boolean => !state.modelSame || !state.onBoard;
/** how far the editor's host lies from the node's body, px: the editor follows its node */
async function hostGap(ctx: ArmedCtx): Promise<number> {
  const [host, body] = [await ctx.node.hostBox(), await mustRect(ctx.page, `${nodeSel("m-bpmn")} .board-node__body`)];
  return round(
    Math.max(
      Math.abs(host.x - body.x),
      Math.abs(host.y - body.y),
      Math.abs(host.width - body.width),
      Math.abs(host.height - body.height),
    ),
    2,
  );
}

const ARMED_CASES: Record<string, (ctx: ArmedCtx) => Promise<ArmedResult>> = {
  /** another node dragged across the armed editor and dropped beyond it */
  async "drag-across"(ctx) {
    const { board, page, ids } = ctx;
    const [note, group] = [(await board.nodeBox(ids.note))!, (await board.nodeBox(ids.group))!];
    const from = centre(note);
    const host = await ctx.node.hostBox();
    const mid = { x: Math.round(host.x + host.width / 2), y: from.y };
    const to = { x: Math.round(group.x + group.width + 40 * ctx.zoom + note.width / 2), y: from.y };
    const selected = await ctx.node.selected();
    await board.drag(from, mid, { lead: [3], steps: 16, keepDown: true });
    await sleep(120);
    const [atMid, top] = [(await board.nodeBox(ids.note))!, await topAt(page, mid)];
    for (let step = 1; step <= 12; step++) await board.move({ x: mid.x + ((to.x - mid.x) * step) / 12, y: mid.y });
    await sleep(60);
    await board.release();
    await sleep(500);
    const end = (await board.nodeBox(ids.note))!;
    // the travel is the pointer's minus the first step of 3 px, which starts the drag
    const [lagMid, lagEnd] = [mid.x - from.x - (atMid.x - note.x), to.x - from.x - (end.x - note.x)];
    const diff = diffState(ctx.before, await fileState(board));
    const state = await standing(ctx);
    const selectionKept = (await ctx.node.selected()).join() === selected.join();
    const followed = near(lagMid, 3, 3) && near(lagEnd, 3, 3);
    const clean =
      diff.changed.join() === ids.note && diff.added.length + diff.removed.length === 0 && diff.writes === 1;
    return {
      verdict: harmed(state)
        ? "wrong-data"
        : !followed || !clean
          ? "broken"
          : !state.armed || !selectionKept
            ? "degraded"
            : "ok",
      measured: `over the editor the note is ${round(lagMid, 1)} px behind the pointer, after the drop ${round(lagEnd, 1)} px (3 is the start step); on top at the pointer there: ${seenAt(top, ids.note, "the dragged note")}; board ${diffLine(diff)}; ${state.text}; editor selection kept: ${selectionKept}`,
      expected: "the note follows the pointer over the editor and lands beyond it, one line",
      details: { diff, lagMid, lagEnd, top },
    };
  },

  /** another node dropped ON the armed editor */
  async "drop-on-armed"(ctx) {
    const { board, page, ids } = ctx;
    const note = (await board.nodeBox(ids.note))!;
    const from = centre(note);
    const host = await ctx.node.hostBox();
    const to = { x: Math.round(host.x + host.width / 2), y: Math.round(host.y + host.height / 2) };
    await board.drag(from, to, { lead: [3], steps: 16 });
    await sleep(500);
    const dropped = (await board.nodeBox(ids.note))!;
    // a drag that did not end follows the pointer although no button is down
    await board.move({ x: to.x + 60 * ctx.zoom + 40, y: to.y + 40 }, 6);
    await sleep(200);
    const later = (await board.nodeBox(ids.note))!;
    const stuck = Math.abs(later.x - dropped.x) > 2 || Math.abs(later.y - dropped.y) > 2;
    if (stuck) {
      await board.click({ x: to.x + 60 * ctx.zoom + 40, y: to.y + 40 });
      await sleep(300);
    }
    const lag = Math.hypot(to.x - from.x - (dropped.x - note.x), to.y - from.y - (dropped.y - note.y));
    const top = await topAt(page, centre((await board.nodeBox(ids.note))!));
    const after = await fileState(board);
    const diff = diffState(ctx.before, after);
    const state = await standing(ctx);
    const row = rowOf(after.text, ids.note);
    const onTop = top.node === ids.note;
    const landed = lag <= 6 && diff.changed.includes(ids.note);
    return {
      verdict: harmed(state) ? "wrong-data" : stuck || !landed ? "broken" : !onTop || !state.armed ? "degraded" : "ok",
      measured: `the note lies ${round(lag, 1)} px from where it was released${stuck ? ", and went on following the pointer with no button down" : ""}; it ${row?.parent === ids.group ? "joined the group" : `has parent ${String(row?.parent)}`}; at its centre the page shows ${seenAt(top, ids.note, "the note")}; board ${diffLine(diff)}; ${state.text}`,
      expected: "the note lands where it was released, on top, one line",
      details: { diff, lag, top, stuck },
      shot: true,
    };
  },

  /** an arrow drawn from a note and released on the armed editor */
  async "arrow-to-armed"(ctx) {
    const { board, page, ids } = ctx;
    await board.move(centre((await board.nodeBox(ids.note))!));
    const from = await handleOf(page, ids.note, "right");
    const host = await ctx.node.hostBox();
    const to = { x: Math.round(host.x + host.width / 2), y: Math.round(host.y + host.height / 2) };
    const selected = await ctx.node.selected();
    await board.drag(from, to, { steps: 16, keepDown: true });
    const line = await page.evaluate(() => document.querySelector(".react-flow__connection") !== null);
    await board.release();
    await sleep(500);
    // a connection that did not end still draws its line
    const open = await page.evaluate(() => document.querySelector(".react-flow__connection") !== null);
    if (open) await board.click(from);
    const after = await fileState(board);
    const diff = diffState(ctx.before, after);
    const arrow = diff.added.length === 1 ? rowOf(after.text, diff.added[0]!) : undefined;
    const state = await standing(ctx);
    const right = arrow?.source === ids.note && arrow.target === "m-bpmn";
    const selectionKept = (await ctx.node.selected()).join() === selected.join();
    return {
      verdict: harmed(state)
        ? "wrong-data"
        : !right || open
          ? "broken"
          : !state.armed || !selectionKept
            ? "degraded"
            : "ok",
      measured: `${arrow ? `a new arrow ${String(arrow.source) === ids.note ? "note" : String(arrow.source)} ${String(arrow.sourceHandle)} -> ${String(arrow.target)} ${String(arrow.targetHandle)}` : "NO arrow"}; the line showed while dragging: ${line}${open ? ", and stayed after the release" : ""}; board ${diffLine(diff)}; ${state.text}; editor selection kept: ${selectionKept}`,
      expected: "one new arrow from the note to the armed node, one line",
      details: { diff, arrow },
    };
  },

  /** an arrow started at the armed node */
  async "arrow-from-armed"(ctx) {
    const { board, page, ids } = ctx;
    const sides: string[] = [];
    let reachable = 0;
    for (const side of ["top", "right", "bottom", "left"]) {
      const selector = `.react-flow__handle[data-nodeid="m-bpmn"][data-handleid="${side}"]`;
      const box = await rectOf(page, selector);
      const style = await page.evaluate((query) => {
        const handle = document.querySelector(query);
        const computed = handle && getComputedStyle(handle);
        return computed
          ? `${computed.visibility}, opacity ${computed.opacity}, pointer-events ${computed.pointerEvents}`
          : "absent";
      }, selector);
      const top = box ? await topAt(page, centre(box)) : null;
      if (top?.handle === side && top.node === "m-bpmn") reachable++;
      sides.push(
        `${side}: ${style}${top ? `, on top there: ${top.handle ? "the handle" : top.what.slice(0, 40)}` : ""}`,
      );
    }
    // the attempt: a press where the left handle would be, a drag to the note
    const handle = await rectOf(page, '.react-flow__handle[data-nodeid="m-bpmn"][data-handleid="left"]');
    const from = handle ? centre(handle) : centre((await board.nodeBox("m-bpmn"))!);
    const nodeBefore = (await board.nodeBox("m-bpmn"))!;
    await board.drag(from, centre((await board.nodeBox(ids.note))!), { steps: 16 });
    await sleep(500);
    const nodeAfter = (await board.nodeBox("m-bpmn"))!;
    const diff = diffState(ctx.before, await fileState(board));
    const state = await standing(ctx);
    const drew = diff.added.length === 1;
    const sideEffect =
      diff.changed.length + diff.removed.length > 0 || Math.abs(nodeAfter.width - nodeBefore.width) > 1;
    return {
      verdict: harmed(state) ? "wrong-data" : drew && !sideEffect ? "ok" : sideEffect ? "broken" : "degraded",
      measured: `${reachable} of 4 handles of the armed node take a press (${sides[3]}); a drag from its left side to the note: ${drew ? "a new arrow" : "no arrow"}${sideEffect ? `, and the board changed: ${diffLine(diff)}` : `, board ${diffLine(diff)}`}; ${state.text}`,
      expected: "an arrow can start at the armed node",
      details: { sides, diff },
    };
  },

  /** the armed node resized from each of its eight handles */
  async "resize-armed"(ctx) {
    const { board, page } = ctx;
    interface Control {
      name: string;
      box: Box;
      /** whole px inside the control's box: where a mouse can press (it carries integers at device pixel ratio 1) */
      points: number;
      /** how many of them have the control itself on top */
      takes: number;
      /** the one of those nearest to the control's middle */
      at: Point | null;
      covered: string;
    }
    const controls = (): Promise<Control[]> =>
      page.evaluate((selector) => {
        const native = (window as NativeWindow).__boardSpikeNative;
        const top = (x: number, y: number): Element | null =>
          native ? native.elementFromPoint(document, x, y) : document.elementFromPoint(x, y);
        /** the whole numbers in [from, to), at most 40 of them, evenly spread */
        const whole = (from: number, to: number): number[] => {
          const all: number[] = [];
          for (let value = Math.ceil(from); value < to; value++) all.push(value);
          if (all.length <= 40) return all;
          return Array.from({ length: 40 }, (_, index) => all[Math.floor(((index + 0.5) * all.length) / 40)]!);
        };
        return [...document.querySelectorAll(`${selector} .react-flow__resize-control`)].map((element) => {
          const rect = native ? native.rect(element) : element.getBoundingClientRect();
          const middle = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          let [points, takes, best, bestDistance] = [0, 0, null as { x: number; y: number } | null, Infinity];
          const others = new Map<string, number>();
          for (const y of whole(rect.y, rect.y + rect.height)) {
            for (const x of whole(rect.x, rect.x + rect.width)) {
              points++;
              const found = top(x, y);
              if (found === element) {
                takes++;
                const distance = Math.hypot(x - middle.x, y - middle.y);
                if (distance < bestDistance) [best, bestDistance] = [{ x, y }, distance];
                continue;
              }
              const name =
                found?.tagName === "IFRAME"
                  ? "the frame"
                  : found?.closest(".board-overlay-layer")
                    ? "the overlaid editor"
                    : found?.closest(".board-node__body")
                      ? "the node's body"
                      : found?.closest(".react-flow__node")
                        ? "the node's frame"
                        : "something else";
              others.set(name, (others.get(name) ?? 0) + 1);
            }
          }
          const classes = element.getAttribute("class") ?? "";
          return {
            name: classes.replace("react-flow__resize-control", "").replace("nodrag", "").trim().replace(/\s+/g, " "),
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            points,
            takes,
            at: best,
            covered: [...others].map(([name, count]) => `${name} ${count}`).join(", "),
          };
        });
      }, nodeSel("m-bpmn"));
    const shares = (list: readonly Control[]): string =>
      list.map((one) => `${one.name.replace(" handle", "")} ${one.takes}/${one.points}`).join(", ");
    // the same node selected and NOT armed: what the board's own frame leaves of each handle
    await board.arm(null);
    await sleep(250);
    if (!(await selectedOnBoard(page)).includes("m-bpmn")) {
      const header = (await board.nodeBox("m-bpmn"))!;
      await board.click({ x: header.x + 140 * ctx.zoom, y: header.y + 14 * ctx.zoom });
      await sleep(200);
    }
    const unarmed = await controls();
    await board.arm("m-bpmn");
    await sleep(300);
    const first = await controls();
    const outward = (name: string): Point => ({
      x: name.includes("left") ? -30 : name.includes("right") ? 30 : 0,
      y: name.includes("top") ? -24 : name.includes("bottom") ? 24 : 0,
    });
    const results: Array<Record<string, unknown>> = [];
    let [worked, tried, gapWorst] = [0, 0, 0];
    for (const { name } of first) {
      const now = (await controls()).find((one) => one.name === name);
      if (!now?.at) {
        results.push({ name, takes: 0, points: now?.points ?? 0, covered: now?.covered, pressed: false });
        continue;
      }
      tried++;
      const boxBefore = (await board.nodeBox("m-bpmn"))!;
      const by = outward(name);
      await board.drag(now.at, { x: now.at.x + by.x, y: now.at.y + by.y }, { lead: [3], steps: 8 });
      await sleep(350);
      const boxAfter = (await board.nodeBox("m-bpmn"))!;
      const grew = { x: boxAfter.width - boxBefore.width, y: boxAfter.height - boxBefore.height };
      // the first 3 px start the gesture
      const ok = near(grew.x, Math.abs(by.x), 4.5) && near(grew.y, Math.abs(by.y), 4.5);
      const gap = await hostGap(ctx);
      gapWorst = Math.max(gapWorst, gap);
      if (ok) worked++;
      results.push({ name, takes: now.takes, points: now.points, covered: now.covered, grew, ok, hostGap: gap });
    }
    // inward: the pointer travels over the editor while the button is down
    const inward: string[] = [];
    let inwardOk = 0;
    for (const name of ["right line", "bottom right handle"]) {
      const now = (await controls()).find((one) => one.name === name);
      if (!now?.at) continue;
      const boxBefore = (await board.nodeBox("m-bpmn"))!;
      const by = { x: -60, y: name.includes("bottom") ? -40 : 0 };
      await board.drag(now.at, { x: now.at.x + by.x, y: now.at.y + by.y }, { lead: [3], steps: 10 });
      await sleep(350);
      const mid = (await board.nodeBox("m-bpmn"))!;
      // a resize that did not end goes on with no button down
      await board.move({ x: now.at.x + by.x - 30, y: now.at.y + by.y - 30 }, 4);
      await sleep(200);
      const later = (await board.nodeBox("m-bpmn"))!;
      const stuck = Math.abs(later.width - mid.width) > 2 || Math.abs(later.height - mid.height) > 2;
      if (stuck) {
        await board.click({ x: now.at.x + by.x - 30, y: now.at.y + by.y - 30 });
        await sleep(300);
      }
      const shrank = { x: boxBefore.width - mid.width, y: boxBefore.height - mid.height };
      const ok = !stuck && near(shrank.x, Math.abs(by.x), 4.5) && near(shrank.y, Math.abs(by.y), 4.5);
      if (ok) inwardOk++;
      inward.push(
        `${name} by ${by.x},${by.y}: shrank ${round(shrank.x, 1)},${round(shrank.y, 1)} px${stuck ? ", then went on with no button down" : ""}`,
      );
    }
    await sleep(300);
    const diff = diffState(ctx.before, await fileState(board));
    const state = await standing(ctx);
    const reachable = (list: readonly Control[]): number => list.filter((one) => one.takes > 0).length;
    // armed against not armed: a handle that lost more than a tenth of its px, or all of them
    const lost = first.filter((one) => {
      const before = unarmed.find((other) => other.name === one.name);
      return before !== undefined && before.takes > 0 && one.takes / one.points < before.takes / before.points - 0.1;
    });
    const onlyNode = diff.changed.join() === "m-bpmn" && diff.added.length + diff.removed.length === 0;
    return {
      verdict:
        harmed(state) || state.mounts !== 1
          ? "wrong-data"
          : worked < tried || inwardOk < inward.length || gapWorst > 1.5 || !onlyNode
            ? "broken"
            : reachable(first) < reachable(unarmed) || lost.length > 0 || !state.armed
              ? "degraded"
              : "ok",
      measured: `whole px that take a press, of those in the handle's box: armed ${shares(first)} (${reachable(first)} of ${first.length} handles reachable); the same node not armed ${shares(unarmed)} (${reachable(unarmed)} of ${unarmed.length}); arming took px from ${lost.length} handles${lost.length > 0 ? ` (${lost.map((one) => one.name).join(", ")}: under ${[...new Set(lost.map((one) => one.covered.replace(/ \d+/g, "")))].join(" / ")})` : ""}; ${worked} of ${tried} outward drags resized by the pointer's travel; inward over the editor: ${inward.join("; ") || "not tried"}; the editor's host at most ${gapWorst} px off the node's body; board lines changed: ${diff.changed.join(",") || "none"} in ${diff.writes} writes; engine mounts ${state.mounts}; ${state.text}`,
      expected: "arming takes no handle away: each resizes by the pointer's travel, the editor follows",
      details: { armed: first, unarmed, results, inward, diff },
    };
  },

  /** the delete key and the delete button while the armed node is the board's selection */
  async "delete-keys"(ctx) {
    const { board, page } = ctx;
    const steps: string[] = [];
    const selectedAtStart = await selectedOnBoard(page);
    // a task selected in the editor: a key that reaches the editor would delete it
    const task = await ctx.node.select("Task_check_credit");
    const header = (await board.nodeBox("m-bpmn"))!;
    const press = async (name: string, act: () => Promise<void>): Promise<void> => {
      const focus = await focusOf(page);
      await act();
      await sleep(600);
      const state = await standing(ctx);
      const text = (await board.boardText()) === ctx.before.text ? "board same" : "BOARD CHANGED";
      steps.push(`${name} (focus ${focus}): ${state.onBoard ? "node kept" : "NODE DELETED"}, ${text}, ${state.text}`);
    };
    await board.click({ x: header.x + 140 * ctx.zoom, y: header.y + 14 * ctx.zoom });
    await sleep(150);
    const selectedAfterHeader = await selectedOnBoard(page);
    await press("Delete after a click on the armed node's header", () => board.press("Delete"));
    await press("Backspace", () => board.press("Backspace"));
    const disabled = await page.evaluate(
      () => document.querySelector<HTMLButtonElement>(".board-toolbar__delete")?.disabled ?? true,
    );
    await press(`the toolbar's delete button (${disabled ? "disabled" : "enabled"})`, async () => {
      if (!disabled) await page.click(".board-toolbar__delete");
    });
    const state = await standing(ctx);
    const boardSame = (await board.boardText()) === ctx.before.text;
    return {
      verdict: harmed(state) ? "wrong-data" : !boardSame ? "broken" : !state.armed ? "degraded" : "ok",
      measured: `selected on the board after arming: ${selectedAtStart.join(",") || "nothing"}, after the header click: ${selectedAfterHeader.join(",") || "nothing"}; a task selected in the editor first: ${task}; ${steps.join("; ")}`,
      expected: "the armed node stays, the task selected in the editor stays, the board file stays",
      details: { steps },
    };
  },

  /** the group that holds the armed node, moved by its border */
  async "group-move"(ctx) {
    const { board, page, ids } = ctx;
    const strip = await mustRect(page, `${nodeSel(ids.group)} .board-group__edge[data-side="top"]`);
    const grab = { x: Math.round(strip.x + strip.width * 0.7), y: Math.round(strip.y + strip.height / 2) };
    const top = await topAt(page, grab);
    const nodeBefore = (await board.nodeBox("m-bpmn"))!;
    await board.drag(grab, { x: grab.x + 43, y: grab.y + 27 }, { lead: [3] });
    await sleep(500);
    const nodeAfter = (await board.nodeBox("m-bpmn"))!;
    const moved = { x: nodeAfter.x - nodeBefore.x, y: nodeAfter.y - nodeBefore.y };
    const gap = await hostGap(ctx);
    const diff = diffState(ctx.before, await fileState(board));
    const state = await standing(ctx);
    // and the editor still edits where the pointer is
    let ratio = "not tried";
    let exact = true;
    for (const id of ["Task_fulfill_order", "Task_validate_order", "Task_check_credit"]) {
      const box = await ctx.node.elementBox(id);
      if (!box) continue;
      const hit = await ctx.node.hit(centre(box));
      if (!hit.reachable || hit.element !== id) continue;
      const dragged = await ctx.node.drag(centre(box), { x: 44, y: 29 }, { hold: ["Control"] });
      await sleep(450);
      const now = (await ctx.node.elementBox(id))!;
      const [rx, ry] = [(now.x - box.x) / dragged.delta.x, (now.y - box.y) / dragged.delta.y];
      const unit = (await ctx.node.diagramScale()) ?? 1;
      exact = near(now.x - box.x, dragged.delta.x, unit + 0.6) && near(now.y - box.y, dragged.delta.y, unit + 0.6);
      ratio = `${id} ${round(rx, 2)} / ${round(ry, 2)}`;
      break;
    }
    const clean =
      diff.changed.join() === ids.group && diff.added.length + diff.removed.length === 0 && diff.writes === 1;
    return {
      verdict: harmed(state)
        ? "wrong-data"
        : !clean || gap > 1.5 || !exact || !near(moved.x, 40, 1.5)
          ? "broken"
          : !state.armed
            ? "degraded"
            : "ok",
      measured: `grabbed ${top.node === ids.group ? "the group's border" : top.what}; the armed node moved ${round(moved.x, 1)}, ${round(moved.y, 1)} px with the group (40, 27 is the travel after the start step); the editor's host ${gap} px off the node's body; board ${diffLine(diff)} (${diff.changed.join(",") === ids.group ? "the group's line alone" : diff.changed.join(",")}); ${state.text}; a drag inside the editor afterwards: ${ratio}`,
      expected: "the group's line alone, the editor follows and still edits where the pointer is",
      details: { diff, moved, gap },
    };
  },

  /** everything on the board box-selected and deleted while the node is armed */
  async "select-all-delete"(ctx) {
    const { board, page, ids } = ctx;
    const canvas = await board.canvasBox();
    const toolbar = await mustRect(page, ".board-toolbar");
    // 60 px to the right, so that the box can begin clear of the window's edge: React Flow pans
    // the board while a box selection is within 40 px of it
    const start = await board.viewport();
    const view = { ...start, x: start.x + 60 };
    await board.setViewport(view);
    await sleep(200);
    const from = { x: canvas.x + 48, y: Math.max(46, Math.round(toolbar.y + toolbar.height + 10)) };
    const to = { x: canvas.x + canvas.width - 60, y: canvas.y + canvas.height - 60 };
    const startsOn = await topAt(page, from);
    /** the node's corner in board coordinates, as the screen has it */
    const corner = async (): Promise<Point> => {
      const [box, now] = [(await board.nodeBox("m-bpmn"))!, await board.viewport()];
      return { x: (box.x - canvas.x - now.x) / now.zoom, y: (box.y - canvas.y - now.y) / now.zoom };
    };
    const nodeBefore = await corner();
    const wholeBoard = [ids.group, ids.note, ids.member, "m-bpmn"];
    const box = async (): Promise<{ focus: string; selected: string[]; panned: number; all: boolean }> => {
      const focus = await focusOf(page);
      await page.keyboard.down("Shift");
      await board.drag(from, to, { steps: 24, lead: [4, 8] });
      await page.keyboard.up("Shift");
      await sleep(250);
      const [now, selected] = [await board.viewport(), await selectedOnBoard(page)];
      return {
        focus,
        selected,
        panned: round(Math.hypot(now.x - view.x, now.y - view.y), 1),
        all: wholeBoard.every((id) => selected.includes(id)),
      };
    };
    const first = await box();
    let second: Awaited<ReturnType<typeof box>> | undefined;
    if (!first.all) {
      if (shots) await board.screenshot(outPath(`shots/armed-select-all-first-try-${ctx.strategy}-${ctx.zoom}.png`));
      // once more with the focus on the board page: a click on the armed node's header, the board back in place
      await board.setViewport(view);
      const header = (await board.nodeBox("m-bpmn"))!;
      await board.click({ x: header.x + 140 * ctx.zoom, y: header.y + 14 * ctx.zoom });
      await sleep(200);
      second = await box();
    }
    const { selected, all } = second ?? first;
    const armedAfterBox = (await standing(ctx)).armed;
    const focus = await focusOf(page);
    await board.press("Delete");
    await sleep(700);
    const after = await fileState(board);
    const diff = diffState(ctx.before, after);
    const state = await standing(ctx);
    const left = lineRows(after.text).map((row) => String(row.id));
    const nodeAfter = state.onBoard ? await corner() : null;
    const jumped = nodeAfter ? Math.hypot(nodeAfter.x - nodeBefore.x, nodeAfter.y - nodeBefore.y) : NaN;
    const row = rowOf(after.text, "m-bpmn");
    const others = left.filter((id) => id !== "m-bpmn");
    const said = (try_: Awaited<ReturnType<typeof box>>): string =>
      `selected ${try_.selected.length} of the 5 elements (focus before it: ${try_.focus}; the board panned ${try_.panned} px)`;
    return {
      verdict:
        harmed(state) || state.mounts !== 1
          ? "wrong-data"
          : !first.all || !all || others.length > 0 || jumped > 1.5 || row?.parent !== undefined
            ? "broken"
            : !state.armed
              ? "degraded"
              : "ok",
      measured: `Shift + drag from ${startsOn.pane ? "the pane" : startsOn.what} across everything ${said(first)}${second ? `; again after a click on the armed node's header: ${said(second)}` : ""}; armed after the box: ${armedAfterBox}; focus at the key: ${focus}; after Delete the board holds ${left.join(", ") || "nothing"}; the armed node ${state.onBoard ? `stayed, ${round(jumped, 1)} board units from where it was (file ${String(row?.x)},${String(row?.y)}), parent ${String(row?.parent)}` : "IS GONE"}; board ${diffLine(diff)}; engine mounts ${state.mounts}; ${state.text}`,
      expected: "everything but the armed node goes, in one write; the armed node stays where it is, without a group",
      details: { diff, first, second, selected, left },
      shot: true,
    };
  },

  /** Control+A and Delete as a person types them, with the focus where arming left it */
  async "select-all-keys"(ctx) {
    const { board, page } = ctx;
    const focus = await focusOf(page);
    const elements = (await ctx.node.elementIds()).length;
    await board.press("Control+A");
    await sleep(200);
    const inEditor = (await ctx.node.selected()).length;
    const onBoard = (await selectedOnBoard(page)).length;
    await board.press("Delete");
    await sleep(900);
    const left = (await ctx.node.elementIds()).length;
    const boardSame = (await board.boardText()) === ctx.before.text;
    const state = await standing(ctx);
    // the editor's own undo brings it back
    await board.press("Control+Z");
    await sleep(900);
    const restored = (await ctx.node.elementIds()).length;
    return {
      verdict: !state.onBoard || !boardSame ? "wrong-data" : !state.armed ? "degraded" : "ok",
      measured: `focus ${focus}; Control+A selected ${inEditor} elements in the editor and ${onBoard} on the board; Delete left ${left} of ${elements} elements in the model (${state.modelSame ? "the file is the same" : "the file changed"}); board file ${boardSame ? "same" : "CHANGED"}; ${state.armed ? "armed" : "DISARMED"}; Control+Z brought back ${restored} of ${elements}`,
      expected:
        "the keys are the armed editor's: its content goes, the board does not change (the board has no select-all key of its own)",
      details: { elements, inEditor, left, restored },
    };
  },

  /** an image file dropped onto the armed editor */
  async "drop-image"(ctx) {
    const { board, page, ids } = ctx;
    const path = outPath("files/onto-editor.png");
    writeFileSync(path, png(300, 200, [255, 176, 0]));
    const host = await ctx.node.hostBox();
    const at = { x: Math.round(host.x + host.width / 2), y: Math.round(host.y + host.height / 2) };
    const count = await countImages(page);
    const { hint } = await dropFile(board, path, at);
    const took = await waitForImages(board, count + 1, 2500);
    await sleep(400);
    const after = await fileState(board);
    const diff = diffState(ctx.before, after);
    const state = await standing(ctx);
    const image = diff.added.length === 1 ? rowOf(after.text, diff.added[0]!) : undefined;
    const box = image ? await board.nodeBox(String(image.id)) : null;
    const top = box ? await topAt(page, centre(box)) : null;
    const off = box ? round(Math.hypot(centre(box).x - at.x, centre(box).y - at.y), 1) : null;
    const onTop = top?.node === String(image?.id);
    return {
      verdict:
        harmed(state) || board.violations.length > 0
          ? "wrong-data"
          : !took
            ? "broken"
            : !onTop || !state.armed
              ? "degraded"
              : "ok",
      measured: `drop hint shown: ${hint}; ${took ? `a new image node ${String(image?.file)}, its centre ${off} px from the drop point, parent ${image?.parent === ids.group ? "the group" : String(image?.parent)}; at its centre the page shows ${seenAt(top, String(image?.id), "the image")}` : "NO image node, the board did not see the drop"}; new files ${diff.newAssets.join(",") || "none"}; board ${diffLine(diff)}; navigations ${board.violations.length}; ${state.text}`,
      expected: "the image lands on the board at the drop point, visible, one line and one file",
      details: { diff, image, top },
      shot: true,
    };
  },

  /** text and an image pasted while the node is armed */
  async paste(ctx) {
    const { board, page } = ctx;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const steps: string[] = [];
    const TEXT = "Pasted by the battery";
    await page.evaluate((text) => navigator.clipboard.writeText(text), TEXT);
    // which paste events the BOARD page sees, and with what
    await page.evaluate(() => {
      const seen: string[] = [];
      Object.assign(window, { __boardPastes: seen });
      document.addEventListener(
        "paste",
        (event) => {
          const target = event.target instanceof Element ? event.target.tagName.toLowerCase() : "?";
          seen.push(`on ${target}, ${event.clipboardData?.files.length ?? 0} file(s)`);
        },
        true,
      );
    });
    const pastes = async (): Promise<string> => {
      const seen = await page.evaluate(() =>
        (window as unknown as { __boardPastes: string[] }).__boardPastes.splice(0),
      );
      return seen.length === 0 ? "no paste event on the board page" : `paste event ${seen.join(", ")}`;
    };
    const header = async (): Promise<void> => {
      const box = (await board.nodeBox("m-bpmn"))!;
      await board.click({ x: box.x + 140 * ctx.zoom, y: box.y + 14 * ctx.zoom });
      await sleep(150);
    };
    const pasteImage = async (name: string): Promise<boolean> => {
      const focus = await focusOf(page);
      const count = await countImages(page);
      await board.press("Control+V");
      const took = await waitForImages(board, count + 1, 2000);
      steps.push(
        `image, ${name} (focus ${focus}): ${took ? "an image node on the board" : "no image node"} (${await pastes()})`,
      );
      return took;
    };
    // 1. text, the focus where arming left it
    const focus = await focusOf(page);
    await board.press("Control+V");
    await sleep(600);
    let state = await standing(ctx);
    const quiet = state.modelSame && (await board.boardText()) === ctx.before.text;
    steps.push(`text, focus ${focus}: ${quiet ? "nothing changed" : "SOMETHING CHANGED"} (${await pastes()})`);
    // 2. an image, the focus in the editor; 3. after a click on the armed node's header
    const wrote = await copyImage(page, png(200, 100, [205, 24, 57]));
    const inEditor = await pasteImage("in the armed editor");
    await header();
    const onBoard = await pasteImage("after a click on the armed node's header");
    // 4. text into an open label editor of the armed editor
    await page.evaluate((text) => navigator.clipboard.writeText(text), TEXT);
    const task = (await ctx.node.elementBox("Task_check_credit"))!;
    const modelBefore = await board.fileText(ORDER);
    await board.doubleClick(centre(task));
    const opened = await board.waitFor(
      async () => (await ctx.node.query(".djs-direct-editing-content")).length > 0,
      WAIT,
    );
    await board.press("Control+A");
    await board.press("Control+V");
    await sleep(200);
    await board.press("Enter");
    const labelled = await board.waitFor(async () => ((await board.fileText(ORDER)) ?? "").includes(TEXT), 2500);
    steps.push(
      `text into a task's open label (opened ${opened === true}): ${labelled ? "in the model's file" : "NOT in the model's file"} (${await pastes()})`,
    );
    const modelNow = await board.fileText(ORDER);
    // 5. an image once more after the header click: the label editor was open meanwhile
    await copyImage(page, png(200, 100, [255, 176, 0]));
    await header();
    const afterLabel = await pasteImage("after the label edit and a click on the header");
    await sleep(300);
    state = await standing(ctx);
    const modelKept = (await board.fileText(ORDER)) === modelNow && modelBefore === ctx.model;
    const diff = diffState(ctx.before, await fileState(board));
    return {
      verdict:
        !quiet || !modelKept || !state.onBoard
          ? "wrong-data"
          : !labelled
            ? "broken"
            : !onBoard || !afterLabel || inEditor || !state.armed
              ? "degraded"
              : "ok",
      measured: `clipboard image ${wrote}; ${steps.join("; ")}; board ${diffLine(diff)}; the model changed only by the label: ${modelKept}; ${state.armed ? "armed" : "DISARMED"}`,
      expected:
        "text reaches the editor's own text field and nothing else; an image reaches the board when the focus is the board's",
      details: { steps, diff },
    };
  },
};

async function partArmed(harness: Harness): Promise<void> {
  const tasks: Array<() => Promise<void>> = [];
  for (const name of Object.keys(ARMED_CASES).filter(wanted)) {
    for (const strategy of strategies) {
      for (const zoom of armedZooms) {
        tasks.push(async () => {
          const label = { part: "armed" as const, case: name, strategy, zoom };
          // the node at 500,200 (zoom 0.5) or 530,200 (above): the note left of the group stays in the window
          const query = {
            board: "matrix" as const,
            strategy,
            notations: ["bpmn"] as const,
            zoom,
            x: zoom < 1 ? 500 : 530,
            y: 200,
          };
          await onBoard(
            harness,
            query,
            label,
            async (board) => {
              const page = board.page;
              await install(board);
              // the Files panel away: the board gets the window's width
              await page.click(".board-files__toggle");
              const ids = await page.evaluate(SETUP_ARMED);
              await board.waitFor(
                async () => (await board.nodeBox(ids.note)) !== null && (await board.nodeBox(ids.group)) !== null,
                WAIT,
              );
              await sleep(300);
              await board.arm("m-bpmn");
              await sleep(300);
              const ctx: ArmedCtx = {
                board,
                page,
                node: await board.node("m-bpmn"),
                strategy,
                zoom,
                ids,
                before: await fileState(board),
                model: (await board.fileText(ORDER)) ?? "",
              };
              const measure = ARMED_CASES[name]!;
              const result = await (name === "paste" ? alone(() => measure(ctx)) : measure(ctx));
              if (shots && result.shot) await board.screenshot(outPath(`shots/armed-${name}-${strategy}-${zoom}.png`));
              report({
                ...label,
                verdict: result.verdict,
                measured: result.measured,
                expected: result.expected,
                details: result.details ?? {},
                problems: await board.problems({ allow: ALLOWED }),
              });
            },
            { viewport: { width: 2200, height: 1500 } },
          );
        });
      }
    }
  }
  await pool(tasks, jobs);
}

// ── part "peer": a write that is not this client's, on the page ──────────────

type PeerWrite = readonly ["update" | "remove", string, Record<string, unknown>];

/**
 * Runs in the page: a write to the board's document under another origin than this client's
 * gestures. To the page that is what a peer's update is: the store's observers hear it, the undo
 * manager does not track it. (How two documents MERGE is board-file.test.ts.)
 */
const PEER = ([kind, id, attrs]: PeerWrite): void => {
  const { doc } = (window as unknown as BatteryWindow).__boardBattery.runtime.store;
  doc.transact(() => {
    const elements = doc.getMap<{ set(key: string, value: unknown): void }>("elements");
    if (kind === "remove") elements.delete(id);
    else for (const [key, value] of Object.entries(attrs)) elements.get(id)?.set(key, value);
  }, "a peer");
};

interface PeerCase {
  name: string;
  strategies?: readonly Strategy[];
  query(strategy: Strategy): Parameters<Harness["open"]>[0];
  run(board: Board, strategy: Strategy): Promise<{ verdict: Verdict; measured: string; expected: string }>;
}

const PEER_CASES: PeerCase[] = [
  {
    name: "peer-moves-node",
    query: (strategy) => ({ board: "demo", strategy, ...CORNER }),
    async run(board) {
      const [before, was] = [(await board.nodeBox("d-note-2"))!, await fileState(board)];
      await board.page.evaluate(PEER, ["update", "d-note-2", { x: 120, y: 1360 }] as const);
      await sleep(400);
      const [after, now] = [(await board.nodeBox("d-note-2"))!, await fileState(board)];
      const moved = { x: after.x - before.x, y: after.y - before.y };
      const diff = diffState(was, now);
      return {
        verdict: moved.x === 120 && moved.y === 40 && diff.changed.join() === "d-note-2" ? "ok" : "broken",
        measured: `the note moved ${moved.x}, ${moved.y} px on the page for a peer's 120, 40 units at zoom 1; board ${diffLine(diff)}`,
        expected: "the page shows the peer's move",
      };
    },
  },
  {
    name: "peer-moves-dragged-node",
    query: (strategy) => ({ board: "demo", strategy, ...CORNER }),
    async run(board) {
      const before = (await board.nodeBox("d-note-2"))!;
      const grab = centre(before);
      await board.drag(grab, { x: grab.x - 100, y: grab.y + 60 }, { lead: [3], keepDown: true });
      const held = (await board.nodeBox("d-note-2"))!;
      await board.page.evaluate(PEER, ["update", "d-note-2", { x: 300, y: 1700 }] as const);
      await sleep(300);
      const during = (await board.nodeBox("d-note-2"))!;
      await board.release();
      await sleep(500);
      const row = rowOf(await board.boardText(), "d-note-2");
      const after = (await board.nodeBox("d-note-2"))!;
      const jumped = Math.hypot(during.x - held.x, during.y - held.y);
      const own = row?.x === after.x - before.x && row.y === 1320 + (after.y - before.y);
      return {
        verdict: jumped > 1 ? "broken" : own ? "ok" : "wrong-data",
        measured: `while the person held the note, a peer wrote it to 300,1700: the note moved ${round(jumped, 1)} px under the pointer; after the release the file has ${String(row?.x)},${String(row?.y)}, the person's drop is ${after.x - before.x},${1320 + (after.y - before.y)}`,
        expected: "the held node stays under the pointer; the later write, the person's drop, is the file's",
      };
    },
  },
  {
    name: "peer-deletes-dragged-node",
    query: (strategy) => ({ board: "demo", strategy, ...CORNER }),
    async run(board) {
      const before = (await board.nodeBox("d-note-2"))!;
      const grab = centre(before);
      await board.drag(grab, { x: grab.x - 100, y: grab.y + 60 }, { lead: [3], keepDown: true });
      await board.page.evaluate(PEER, ["remove", "d-note-2", {}] as const);
      await sleep(300);
      const during = await board.nodeBox("d-note-2");
      await board.release();
      await sleep(500);
      const row = rowOf(await board.boardText(), "d-note-2");
      // the board still works: another node moves
      const image = (await board.nodeBox("d-image"))!;
      await board.drag(centre(image), { x: centre(image).x + 40, y: centre(image).y + 30 }, { lead: [3] });
      await sleep(400);
      const moved = (await board.nodeBox("d-image"))!.x - image.x;
      return {
        verdict: row === undefined && during === null && moved > 30 ? "ok" : "broken",
        measured: `a peer deleted the note the person was dragging: on the page ${during === null ? "it went at once" : "it stayed"}; after the release it is ${row === undefined ? "not" : "BACK"} in the file; the next drag of another node moved it ${moved} px`,
        expected: "the node goes, the drop re-creates nothing, the board goes on",
      };
    },
  },
  ...(["typed", "untouched"] as const).map((how): PeerCase => ({
    name: `peer-edits-open-note-${how}`,
    query: (strategy) => ({ board: "demo", strategy, ...CORNER }),
    async run(board) {
      const page = board.page;
      const old = String(rowOf(await board.boardText(), "d-note-2")?.text);
      await board.doubleClick(centre((await board.nodeBox("d-note-2"))!));
      await page.waitForSelector(`${nodeSel("d-note-2")} textarea`, { timeout: WAIT });
      if (how === "typed") await board.type(" Mine.", 2);
      await page.evaluate(PEER, ["update", "d-note-2", { text: `${old} The peer's sentence.` }] as const);
      await sleep(300);
      const shown = await page.evaluate(
        (selector) => document.querySelector<HTMLTextAreaElement>(selector)?.value ?? "",
        `${nodeSel("d-note-2")} textarea`,
      );
      await board.press("Escape");
      await sleep(400);
      const text = String(rowOf(await board.boardText(), "d-note-2")?.text);
      const peers = text.includes("The peer's sentence.");
      return {
        verdict: peers ? "ok" : how === "typed" ? "degraded" : "wrong-data",
        measured: `the note's editor was open${how === "typed" ? " and the person typed 6 characters" : ", the person typed NOTHING"}; a peer changed the text meanwhile; the open editor ${shown.includes("peer") ? "showed" : "did not show"} it; after Escape the file has ${peers ? "the peer's sentence" : `the ${how === "typed" ? "person's text" : "OLD text"} and not the peer's sentence`}`,
        expected:
          how === "typed" ? "both edits, or a notice that one was lost" : "the peer's text: the person changed nothing",
      };
    },
  })),
  {
    name: "peer-deletes-armed-node",
    strategies: ["overlay", "plugin", "iframe"],
    query: (strategy) => ({ board: "matrix", strategy, notations: ["bpmn", "dmn"], zoom: 1, x: 60, y: 80 }),
    async run(board, strategy) {
      const page = board.page;
      await board.arm("m-bpmn");
      const node = await board.node("m-bpmn");
      const picked = await node.select("Task_check_credit");
      const model = await board.fileText(ORDER);
      await page.evaluate(PEER, ["remove", "m-bpmn", {}] as const);
      await sleep(700);
      const left = await page.evaluate(() => {
        const native = (window as NativeWindow).__boardSpikeNative;
        const size = (element: Element): number => {
          const rect = native ? native.rect(element) : element.getBoundingClientRect();
          return rect.width * rect.height;
        };
        return {
          // an editor that is still drawn somewhere on the page, its node gone
          editors: [...document.querySelectorAll(".board-overlay-layer .board-engine, .board-popup-host > *")].filter(
            (element) => size(element) > 0,
          ).length,
          frames: [...document.querySelectorAll("iframe")].length,
          wrapper: document.querySelector('.react-flow__node[data-id="m-bpmn"]') !== null,
          focus:
            document.activeElement === document.body ? "body" : (document.activeElement?.tagName.toLowerCase() ?? ""),
        };
      });
      const nodes = await board.nodes();
      // the board goes on: the other model node arms and edits
      await board.arm("m-dmn");
      await sleep(300);
      const armed = (await board.nodes()).filter((one) => one.armed).map((one) => one.id);
      const problems = await board.problems({ allow: ALLOWED });
      const clean = !left.wrapper && left.editors === 0 && (strategy !== "iframe" || left.frames === 1);
      return {
        verdict:
          (await board.fileText(ORDER)) !== model
            ? "wrong-data"
            : !clean || problems.length > 0 || armed.join() !== "m-dmn"
              ? "broken"
              : "ok",
        measured: `the armed node (a task selected in it: ${picked}) deleted by a peer: its wrapper is ${left.wrapper ? "STILL there" : "gone"}, editors left on the page without a node: ${left.editors}, frames ${left.frames}, focus ${left.focus}; the board lists ${nodes.map((one) => one.id).join(",")}, armed ${nodes.filter((one) => one.armed).length}; the model's file is ${(await board.fileText(ORDER)) === model ? "the same" : "CHANGED"}; arming the other node afterwards: ${armed.join(",") || "none armed"}; problems ${problems.length}`,
        expected: "the node and its editor go without a trace, the model file stays, the board goes on",
      };
    },
  },
];

async function partPeer(harness: Harness): Promise<void> {
  const tasks: Array<() => Promise<void>> = [];
  for (const one of PEER_CASES.filter((item) => wanted(item.name))) {
    for (const strategy of one.strategies ?? (["overlay"] as const)) {
      tasks.push(async () => {
        const query = one.query(strategy);
        const zoom = typeof query === "string" ? null : (query.zoom ?? null);
        const label = { part: "peer" as const, case: one.name, strategy, zoom };
        await onBoard(harness, query, label, async (board) => {
          await install(board);
          const result = await one.run(board, strategy);
          report({ ...label, ...result, details: {}, problems: await board.problems({ allow: ALLOWED }) });
        });
      });
    }
  }
  await pool(tasks, jobs);
}

// ── part "size" ──────────────────────────────────────────────────────────────

interface SizeBoard {
  /** the notes that are no member of a group, in the grid's order */
  ids: string[];
  notes: number;
  groups: number;
  arrows: number;
}

/**
 * Runs in the page: fills the board with `count` elements of its own kinds in ONE transaction
 * (notes in a grid, every 25th element a group around four of them, three arrows for every ten)
 * and says how long it took until React Flow had drawn them.
 */
const FILL = async (count: number): Promise<SizeBoard & { writeMs: number; shownMs: number }> => {
  const { runtime } = (window as unknown as BatteryWindow).__boardBattery;
  const groups = Math.max(1, Math.round(count / 12.5));
  const arrows = Math.round(count * 0.3);
  const notes = count - groups - arrows;
  // ids of the shape the board gives its own (n_ / e_ and 13 characters of a UUID), from a fixed sequence
  let state = 20_261_114;
  // mulberry32: whole 32 bit steps (a product beyond 2^53 would lose the low bits and repeat ids)
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return (mixed ^ (mixed >>> 14)) >>> 0;
  };
  const hex = (length: number): string => Array.from({ length }, () => (next() >>> 28).toString(16)).join("");
  const id = (prefix: string): string => `${prefix}_${hex(8)}-${hex(4)}`;
  const noteIds = Array.from({ length: notes }, () => id("n"));
  const groupIds = Array.from({ length: groups }, () => id("n"));
  const arrowIds = Array.from({ length: arrows }, () => id("e"));
  const columns = Math.ceil(Math.sqrt(notes));
  const start = performance.now();
  runtime.store.gesture((tx) => {
    for (const element of runtime.store.getSnapshot().nodes) tx.remove(element.id);
    groupIds.forEach((group, index) =>
      tx.create(group, {
        kind: "node",
        type: "group",
        x: (index % 4) * 1400,
        y: -700 - Math.floor(index / 4) * 520,
        width: 1300,
        height: 460,
        z: "9",
        text: `Group ${index + 1}`,
      }),
    );
    noteIds.forEach((note, index) => {
      // the first four notes per group are its members, at places relative to it
      const group = index < groups * 4 ? groupIds[Math.floor(index / 4)] : undefined;
      const text = `### Note ${index + 1}\n\nWho decides this, and by when? See the order process, step ${index + 1}.`;
      const z = `a${index.toString(36).padStart(3, "0")}`;
      if (group)
        tx.create(note, {
          kind: "node",
          type: "text",
          parent: group,
          x: 30 + (index % 4) * 310,
          y: 80,
          width: 280,
          height: 160,
          z,
          text,
        });
      else
        tx.create(note, {
          kind: "node",
          type: "text",
          x: (index % columns) * 320,
          y: Math.floor(index / columns) * 200,
          width: 280,
          height: 160,
          z,
          text,
        });
    });
    arrowIds.forEach((arrow, index) =>
      tx.create(arrow, {
        kind: "edge",
        source: noteIds[index % notes]!,
        target: noteIds[(index * 7 + 1) % notes]!,
        sourceHandle: "right",
        targetHandle: "left",
        label: index % 3 === 0 ? "leads to" : undefined,
      }),
    );
  });
  const writeMs = performance.now() - start;
  const want = notes + groups;
  const shown = await new Promise<boolean>((resolve) => {
    const look = (): void => {
      if (
        document.querySelectorAll(".react-flow__node").length >= want &&
        document.querySelectorAll(".react-flow__edge").length >= arrows
      ) {
        // drawn, and one more frame for the paint
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      } else if (performance.now() - start > 20_000) resolve(false);
      else requestAnimationFrame(look);
    };
    look();
  });
  if (!shown) throw new Error(`the board did not show ${want} nodes and ${arrows} arrows within 20 s`);
  return { ids: noteIds.slice(groups * 4), notes, groups, arrows, writeMs, shownMs: performance.now() - start };
};

/** runs in the page: one move through the action layer, ten times: the write itself and until the next frame */
const MOVE = async (ids: string[]): Promise<{ write: number[]; frame: number[]; text: number[] }> => {
  const { runtime, actions } = (window as unknown as BatteryWindow).__boardBattery;
  const [write, frame, text]: [number[], number[], number[]] = [[], [], []];
  for (let round = 0; round < 10; round++) {
    const id = ids[ids.length - 1 - round]!;
    const at = runtime.store.getSnapshot().nodes.find((one) => one.id === id)!.attrs;
    const start = performance.now();
    actions.writeDrop(runtime.store, { [id]: { x: at.x + 7, y: at.y + 5 } });
    write.push(performance.now() - start);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    frame.push(performance.now() - start);
    const before = performance.now();
    runtime.store.text();
    text.push(performance.now() - before);
  }
  return { write, frame, text };
};

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? NaN;

async function partSize(harness: Harness): Promise<void> {
  // one page at a time: these rows are times
  for (const count of [50, 200]) {
    if (!wanted(`size-${count}`) && !wanted("size")) continue;
    for (let turn = 1; turn <= repeat; turn++) {
      const label = { part: "size" as const, case: `${count}-elements`, strategy: "overlay", zoom: 0.3 };
      await onBoard(
        harness,
        { board: "matrix", strategy: "overlay", notations: ["bpmn"], zoom: 0.3, x: 60, y: 560 },
        label,
        async (board) => {
          const page = board.page;
          await install(board);
          await page.click(".board-files__toggle");
          await sleep(200);
          const filled = await page.evaluate(FILL, count);
          const text = await board.boardText();
          // Node, the same text: decode into a fresh document, project it, serialise it
          let start = performance.now();
          const store = createBoardStore(createBoardDoc(text));
          const loadMs = performance.now() - start;
          start = performance.now();
          const again = store.text();
          const textMs = performance.now() - start;
          store.destroy();
          const moved = await page.evaluate(MOVE, filled.ids);
          // one move by the pointer: from the release to the document's write, as the page saw both
          await page.evaluate(() => {
            const marks: { up?: number; written?: number } = {};
            const { runtime } = (window as unknown as BatteryWindow).__boardBattery;
            window.addEventListener("mouseup", () => (marks.up ??= performance.now()), { capture: true, once: true });
            const stop = runtime.store.subscribe(() => {
              marks.written = performance.now();
              stop();
            });
            Object.assign(window, { __boardMarks: marks });
          });
          // a note that answers at its middle (an arrow's label may lie over one)
          let note: Box | undefined;
          for (const id of filled.ids) {
            const box = await board.nodeBox(id);
            if (box && (await topAt(page, centre(box))).node === id) {
              note = box;
              break;
            }
          }
          if (!note) throw new Error("no note of the large board answers at its middle");
          const before = await fileState(board);
          await board.drag(centre(note), { x: centre(note).x + 30, y: centre(note).y + 20 }, { lead: [3] });
          await sleep(400);
          const marks = await page.evaluate(
            () => (window as unknown as { __boardMarks: { up?: number; written?: number } }).__boardMarks,
          );
          const diff = diffState(before, await fileState(board));
          const pointerMs = marks.up !== undefined && marks.written !== undefined ? marks.written - marks.up : NaN;
          const lines = text.split("\n").filter((line) => line !== "");
          report({
            ...label,
            case: `${count}-elements run ${turn}`,
            verdict: again === text && diff.changed.length === 1 ? "ok" : "wrong-data",
            measured: `${filled.notes} notes, ${filled.groups} groups, ${filled.arrows} arrows: file ${bytesOf(text)} B in ${lines.length} lines (${Math.round(bytesOf(text) / count)} B per element); shown ${round(filled.shownMs, 0)} ms after one write of ${round(filled.writeMs, 1)} ms; in Node: load ${round(loadMs, 1)} ms, serialise ${round(textMs, 2)} ms; one move: write ${round(median(moved.write), 2)} ms, until the second frame after it ${round(median(moved.frame), 1)} ms, serialise ${round(median(moved.text), 2)} ms (medians of 10); by pointer: document written ${round(pointerMs, 1)} ms after the release, ${diff.changed.length} line changed. Times under load`,
            expected: "",
            details: {
              ...filled,
              ids: undefined,
              bytes: bytesOf(text),
              lines: lines.length,
              loadMs,
              textMs,
              moved,
              pointerMs,
              diff: { ...diff, attributes: undefined },
            },
            problems: await board.problems({ allow: ALLOWED }),
          });
          if (shots && turn === 1) await board.screenshot(outPath(`shots/size-${count}.png`));
        },
      );
    }
  }
}

// ── the run ──────────────────────────────────────────────────────────────────

function table(): string {
  const pad = (text: string, width: number): string => (text.length > width ? text : text.padEnd(width));
  const lines = rows.map(
    (row) =>
      `${pad(row.part, 8)}${pad(row.case, 28)}${pad(row.strategy, 9)}${pad(row.zoom === null ? "" : String(row.zoom), 5)}${pad(row.verdict, 11)}${row.measured}${row.problems.length > 0 ? ` | problems: ${row.problems.join(" | ").slice(0, 300)}` : ""}`,
  );
  return `${pad("part", 8)}${pad("case", 28)}${pad("strategy", 9)}${pad("zoom", 5)}${pad("verdict", 11)}measured\n${lines.join("\n")}\n`;
}

await run(async (harness) => {
  const started = Date.now();
  if (parts.includes("file")) await partFile(harness);
  if (parts.includes("images")) await partImages(harness);
  if (parts.includes("derived")) await partDerived(harness);
  if (parts.includes("armed")) await partArmed(harness);
  if (parts.includes("peer")) await partPeer(harness);
  if (parts.includes("size")) await partSize(harness);

  // pages run side by side: the rows come in the order the cases are listed in, not in the order they ended
  const listed = [
    "open-and-close",
    ...GESTURES.map((gesture) => gesture.name),
    ...NO_GESTURE.map((one) => one.name),
    ...Object.keys(ARMED_CASES),
    ...PEER_CASES.map((one) => one.name),
  ];
  const place = (row: Row): number => PARTS.indexOf(row.part) * 1000 + Math.max(0, listed.indexOf(row.case));
  const arrival = new Map(rows.map((row, index) => [row, index]));
  rows.sort(
    (a, b) =>
      place(a) - place(b) ||
      (a.part === "file" ? 0 : a.strategy.localeCompare(b.strategy) || (a.zoom ?? 0) - (b.zoom ?? 0)) ||
      (arrival.get(a) ?? 0) - (arrival.get(b) ?? 0),
  );
  const gestures = rows.filter((row) => row.part === "file" && row.details.diff !== undefined);
  const actions = gestures.map((row) => {
    const action = row.details.action as {
      call: string;
      same: boolean;
      onlyGesture: string[];
      onlyAction: string[];
    } | null;
    const plain = row.details.plainAction as { call: string; same: boolean } | null;
    return {
      gesture: row.case,
      strategy: row.strategy,
      action: action?.call ?? null,
      sameLines: action ? action.same : null,
      plainAction: plain?.call ?? null,
      plainSameLines: plain ? plain.same : null,
      noAction: row.details.noAction ?? null,
      onlyGesture: action?.onlyGesture ?? [],
      onlyAction: action?.onlyAction ?? [],
    };
  });
  const counts: Record<string, number> = {};
  for (const row of rows) counts[`${row.part} ${row.verdict}`] = (counts[`${row.part} ${row.verdict}`] ?? 0) + 1;
  const withProblems = rows.filter((row) => row.problems.length > 0);
  const path = writeResult("board", {
    meta: {
      parts,
      strategies,
      armedZooms,
      jobs,
      repeat,
      seconds: Math.round((Date.now() - started) / 1000),
      window: "2200 x 1300 (armed cases 2200 x 1500), device pixel ratio 1",
      rules: RULES,
      allowedConsole: ALLOWED.map(String),
    },
    counts,
    rows,
    actions,
  });
  writeFileSync(outPath("board-table.txt"), table());
  console.log(`\n${rows.length} rows in ${Math.round((Date.now() - started) / 1000)} s: ${JSON.stringify(counts)}`);
  console.log(
    `actions against gestures: ${actions.filter((one) => one.sameLines === true).length} write the same lines, ${actions.filter((one) => one.sameLines === false).length} differ, ${actions.filter((one) => one.action === null).length} have no action`,
  );
  for (const row of withProblems)
    console.log(`problems in ${row.part} ${row.case} ${row.strategy}: ${row.problems.join(" | ").slice(0, 400)}`);
  console.log(path);
  return harnessFailures;
});
