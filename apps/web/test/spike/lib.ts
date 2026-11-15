/**
 * The board spike's Playwright harness: what every hand-run `*-chromium.ts` under test/spike shares.
 * Not run by `pnpm test` or CI. A script imports it and runs with plain Node (type stripping):
 *
 *   node apps/web/test/spike/smoke-chromium.ts
 *
 * What it does for a script:
 * - a Vite dev server of its own, in process (no child to orphan), with a dependency cache of its
 *   own and the spike's two pages as optimizer entries, so no optimizer reload hits a measurement;
 * - Chromium, headless and ALWAYS with the sandbox (`chromiumSandbox: true`; Playwright's default
 *   launch adds --no-sandbox);
 * - a board opened by its URL parameters, identified by its meta mark (a missing page answers 200
 *   with the SPA), waited for until `window.__boardSpike.ready`;
 * - a run that fails when the page or an embed frame navigates or reloads under it;
 * - ONE way to reach a node's editor in every strategy (`board.node(id)`): the SpikeProbe of
 *   the page or of the node's frame, with every rectangle mapped to TOP-LEVEL screen coordinates,
 *   which are the coordinates `page.mouse` takes;
 * - TRUE screen geometry: the `shim` strategy patches geometry functions on their prototypes while
 *   a node is armed (getBoundingClientRect, getClientRects, getScreenCTM, elementFromPoint, ...).
 *   The probe, the hooks and every evaluate of this file read the browser's own functions, which
 *   both pages capture before any strategy code runs and publish as `window.__boardSpikeNative`
 *   (NativeGeometry in shared.ts). In an evaluate or `node.inDocument` of YOUR script do the same:
 *   `const native = (window as { __boardSpikeNative?: NativeGeometry }).__boardSpikeNative;` then
 *   `native ? native.rect(element) : element.getBoundingClientRect()`, never the plain method alone;
 * - pointer input in small steps, with the traps the builders measured (see drag and paletteDrag);
 * - the hooks (viewport, files, counters, log), console and page errors, screenshots, CDP metrics;
 * - results as JSON outside the repository, and a shutdown that leaves no process behind.
 *
 * ARMING MOVES THE BOARD (rounds 5 and 6, src/board-spike/arm-rules.ts and board-arming.ts). Three
 * rules, each a URL parameter (typed keys of BoardQuery, or EXTRA_PARAMS for a script that knows
 * nothing of them), each with a default per strategy:
 *   armzoom    off | min1 | exact1   default exact1 for an overlay node (round 5: min1), off for
 *                                    any other strategy
 *   armedzoom  free | disarm | lock  default disarm for an overlay node, free for any other
 *   armreturn  stay | back           default stay
 *   armmotion  <ms>                  how long the board takes to move (0: at once); default: the
 *                                    design token, 0 under prefers-reduced-motion
 * A parameter in the URL applies to every strategy. EXTRA_PARAMS="armzoom=off&armedzoom=free" is
 * the board of round 4, EXTRA_PARAMS="armzoom=min1" the default of round 5. What that means for a
 * script:
 * - Under min1 and exact1, `board.arm(id)`, a double-click and `arm=` in the URL first move the
 *   board (the node into the window, clear of the toolbar) and arm THEN. Since round 6 an overlay
 *   node is armed at board zoom EXACTLY 1 by default, so the board moves from ABOVE zoom 1 too:
 *   asked at 1.5 or 2, the armed editor runs at zoom 1 and the node is not where the URL put it
 *   (a node at 60, 80 armed by the hook ends at 260, 215 from 1.5 and at 460, 350 from 2; from
 *   below 1 at 24, 79; in a 2200 x 1300 window). The zoom a script asked for (`zoom:`, showNode)
 *   is not the zoom the armed editor runs at: read `board.viewport()` after arming and compute
 *   every travel and every expectation from that.
 * - WHERE the node ends depends on what armed it. A pointer (`board.armByDoubleClick`): the zoom
 *   changes about the pointer, and a node that is longer than the board's box on an axis is moved
 *   only as far as closes a gap, so one that covers the box stays and the double-clicked point
 *   with it. No pointer (`board.arm`, `arm=`, the header's Edit button, the keyboard): about the
 *   node's centre, and such a node starts at the margin. A node that fits is brought into the box
 *   by the least shift either way. `transition.anchor` says which ("pointer" or "centre").
 * - `board.arm()` resolves after the move. A double-click does not wait: `board.armByDoubleClick`
 *   does, or `board.waitForRest()`. A box read while the board moves is a moving box.
 * - THE WAY OUT that is always in reach is the toolbar's Done control (`[data-board-done]`,
 *   round 6): `board.doneControl()` reads its box and whether it takes a press, `board.pressDone()`
 *   presses it with a real click. The header's own Done button lies wherever the node lies: under
 *   the Files panel, under the toolbar or outside the window for a node larger than the board.
 * - A move can be interrupted (a wheel, a press, Escape, another arm): then NO node is armed.
 *   `board.lastTransition()` says so (`interrupted`, `interruptedBy`), `board.armState()` what is armed.
 * - Under disarm, a wheel over the pane or another node, the toolbar's zoom buttons and
 *   `board.setViewport` with another zoom DISARM the node (showNode calls setViewport twice). A
 *   pan never does. Under lock they are refused and the viewport stays. `(await board.counters()).arm`
 *   counts each path; `board.startFrames()` / `stopFrames()` record zoom and armed node per frame.
 * - A wheel event of the harness has no inertia: a case about a zoom gesture sends `board.wheelBurst`.
 *
 * Environment:
 *   PORT          port of the script's own dev server (default 5391); a taken port fails at once
 *   BASE          use a running dev server instead, e.g. http://localhost:5391 (none is started)
 *   CACHE_DIR     Vite's cacheDir (default apps/web/node_modules/.vite-board-spike-<PORT>)
 *   OUT_DIR       folder for results and screenshots (default: outside the repo, see outDir())
 *   OUT           the result file of a script that writes exactly one (default <OUT_DIR>/<name>.json)
 *   EXTRA_PARAMS  a query string, e.g. "plugin=all,own", "shim=all,guess" or, two parameters joined
 *                 by an ampersand, "armzoom=off&armedzoom=free": its entries are appended to EVERY
 *                 board URL harness.open opens, after the known keys and after the call's own
 *                 `params`. A name the call set itself is left alone (the call wins). It measures
 *                 a variant of a strategy with a script that knows nothing of it; writeResult adds it
 *                 to the result file as `extraParams`, and run() prints it
 *
 * Two notes for every script:
 * - diagram-js swallows a click for 400 ms after a drag ends (diagram-js lib/features/dragging/
 *   Dragging.js, installClickTrap), in every strategy: a click or `node.select()` within that time
 *   does nothing. Wait 450 ms after a drag before the next click.
 * - With BASE set no server is started, so `optimizerNotes()` is always empty and run() cannot see a
 *   dependency the shared server found late (it reloads the page under the measurement). The run
 *   still fails on the reload itself (assertStable); whoever started that server has its notes.
 *
 * Node's type stripping decides the syntax here and in every script: no enum, no namespace with
 * values, no parameter properties, relative imports with their `.ts` extension, `type` on type
 * imports, nothing from a `.tsx`, `.css` or `@/` module (shared.ts is the one source module a
 * script may import). ESLint does not flag a floating promise under test/: await every mouse call.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Browser, type CDPSession, chromium, type Frame, type Page } from "playwright";
import { createLogger, createServer } from "vite";

import {
  type ArmCounters,
  type ArmedZoom,
  type ArmPolicy,
  type ArmReturn,
  type ArmState,
  type ArmTransition,
  type ArmZoom,
  type BoardSpikeHooks,
  type Box,
  EMBED_KEY,
  EMBED_PAGE,
  type FrameSample,
  HOOKS_KEY,
  type ModelNotation,
  type NativeGeometry,
  PAGE_MARK,
  type SpikeNodeInfo,
  type SpikeProbe,
  type Strategy,
  type Viewport,
} from "../../src/board-spike/shared.ts";

export { ARM_RETURNS, ARM_ZOOMS, ARMED_ZOOMS, MODEL_NOTATIONS, STRATEGIES } from "../../src/board-spike/shared.ts";
export type {
  ArmCounters,
  ArmedZoom,
  ArmPolicy,
  ArmReturn,
  ArmState,
  ArmTransition,
  ArmZoom,
  Box,
  FrameSample,
  ModelNotation,
  NativeGeometry,
  SpikeNodeInfo,
  Strategy,
  Viewport,
};

/**
 * How an evaluate reaches the browser's own geometry functions (shared.ts, NATIVE_KEY): absent in a
 * document that is neither spike page, where the plain method is the native one anyway.
 */
type NativeWindow = Window & { __boardSpikeNative?: NativeGeometry };

/** apps/web */
export const WEB = fileURLToPath(new URL("../../", import.meta.url));
const PORT = Number(process.env.PORT ?? 5391);
/** EXTRA_PARAMS (see the header) as it was given, without a leading "?" or "&" */
const EXTRA_QUERY = (process.env.EXTRA_PARAMS ?? "").trim().replace(/^[?&]+/, "");
/** its entries: what harness.open appends to every board URL */
const EXTRA_PARAMS = new URLSearchParams(EXTRA_QUERY);
/** EXTRA_PARAMS as given, "" when it names no parameter: for a script's own result or log */
export const extraParams = (): string => (EXTRA_PARAMS.size > 0 ? EXTRA_QUERY : "");
/** how long waitForBox waits for running animations before a poll, ms */
const ANIMATION_CAP_MS = 400;
/** pressPoint: the fractions of a shape's box that are tried, the middle first */
const PRESS_GRID = [0.5, 0.3, 0.7, 0.1, 0.9] as const;

export interface Point {
  x: number;
  y: number;
}

export const centre = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
export const round = (value: number, digits = 2): number => Math.round(value * 10 ** digits) / 10 ** digits;
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** the smallest box around all of them */
export function union(...boxes: Box[]): Box {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y,
  };
}

/**
 * Console output that is known and is no strategy's doing. Filter with `board.problems({ allow })`
 * and say in the report what was filtered.
 */
export const KNOWN_CONSOLE = {
  /** bpmn-js on opening the replace or colour menu: a warning, twice per open */
  padDeprecation: /ContextPad#getPad is deprecated/,
  /** dmn-js's FEEL cell editor on its first focus, in every strategy and in the embed page alone */
  feelEditor: /CodeMirror plugin crashed: TypeError: tags is not iterable/,
} as const;

// ── results ──────────────────────────────────────────────────────────────────

/**
 * Where results and screenshots go, never into the repository (Prettier would check a JSON there):
 * OUT_DIR, else `board-spike-results` in the scratchpad of the agent session that runs the script
 * (/tmp/claude-<uid>/<project>/<session>/scratchpad), else a folder in the OS temp directory.
 */
export function outDir(): string {
  if (process.env.OUT_DIR) return process.env.OUT_DIR;
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  const root = join(tmpdir(), `claude-${userInfo().uid}`);
  if (session && existsSync(root)) {
    for (const project of readdirSync(root)) {
      const scratchpad = join(root, project, session, "scratchpad");
      if (existsSync(scratchpad)) return join(scratchpad, "board-spike-results");
    }
  }
  return join(tmpdir(), "designiq-board-spike");
}

/** a path in outDir(), its folder created */
export function outPath(file: string): string {
  const path = join(outDir(), file);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/**
 * Writes `data` as JSON to OUT, else to <outDir>/<name>.json; returns the path. With EXTRA_PARAMS
 * set, a result that is an object gets it as `extraParams` (unless the script wrote that field
 * itself): which variant a file measured must not depend on someone remembering the command line.
 */
export function writeResult(name: string, data: unknown): string {
  const path = process.env.OUT ?? outPath(`${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  const variant = extraParams();
  const tagged =
    variant !== "" && typeof data === "object" && data !== null && !Array.isArray(data) && !("extraParams" in data)
      ? { ...data, extraParams: variant }
      : data;
  writeFileSync(path, `${JSON.stringify(tagged, null, 2)}\n`);
  return path;
}

/** `check(ok, what)` prints a line per check and counts; `done()` prints the sum and returns the failures */
export function reporter() {
  const failures: string[] = [];
  let checks = 0;
  return {
    check(ok: boolean, what: string): boolean {
      checks++;
      console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
      if (!ok) failures.push(what);
      return ok;
    },
    note: (what: string): void => console.log(`     ${what}`),
    done(): number {
      console.log(`\n${checks - failures.length} of ${checks} checks passed`);
      for (const failure of failures) console.log(`  FAILED: ${failure}`);
      return failures.length;
    },
  };
}

// ── dev server and browser ───────────────────────────────────────────────────

export interface SpikeServer {
  /** http://localhost:<port>: the dev server listens on ::1, so `localhost`, never 127.0.0.1 */
  readonly base: string;
  /** what the server logged about its dependency optimizer after the start: any line is a late-found dependency */
  optimizerNotes(): string[];
  close(): Promise<void>;
}

export async function startServer(): Promise<SpikeServer> {
  if (process.env.BASE) {
    return { base: process.env.BASE.replace(/\/$/, ""), optimizerNotes: () => [], close: () => Promise.resolve() };
  }
  const notes: string[] = [];
  const logger = createLogger("warn");
  const server = await createServer({
    root: WEB,
    configFile: join(WEB, "vite.config.ts"),
    // not the cache `pnpm dev` and vitest share, and not another script's that runs at the same time
    cacheDir: process.env.CACHE_DIR ?? join(WEB, `node_modules/.vite-board-spike-${PORT}`),
    clearScreen: false,
    logLevel: "info",
    // info lines are read, not printed: "optimized dependencies changed. reloading" must not go unseen
    customLogger: {
      ...logger,
      info(message) {
        // Vite 8: "dependency optimized: x" / "dependencies optimized: x, y" for what the scanner missed,
        // "optimized dependencies changed. reloading" when the page is reloaded for it
        if (/optimized dependencies changed|dependenc(?:y|ies) optimized/i.test(message)) notes.push(message);
      },
    },
    // Neither page is a build input, so Vite's scanner would never see their dependencies: found
    // late, the optimizer reloads the page under the measurement. `force`: a cache that exists is
    // not scanned again (harness.md 3.2)
    optimizeDeps: {
      entries: [join(WEB, "board-spike.html"), join(WEB, EMBED_PAGE), join(WEB, "board-spike-kit.html")],
      force: true,
    },
    // no hot updates: someone may save a file of this tree while a script measures. The next page
    // LOAD sees the current files all the same
    // forwardConsole: Vite switches it on when it finds itself run by an agent; the page is to be
    // the one a person gets from `pnpm dev`, and the harness reads the console itself
    server: { port: PORT, strictPort: true, hmr: false, forwardConsole: false },
  });
  try {
    await server.listen();
  } catch (error) {
    // a server that was created and not closed keeps the process alive
    await server.close();
    throw error;
  }
  return { base: `http://localhost:${PORT}`, optimizerNotes: () => [...notes], close: () => server.close() };
}

/** the ONLY launch the spike may use: headless, with the sandbox */
export const launchBrowser = (): Promise<Browser> => chromium.launch({ headless: true, chromiumSandbox: true });

// ── a board ──────────────────────────────────────────────────────────────────

/** the URL parameters of board-spike.html (DESIGN.md section 6) */
export interface BoardQuery {
  board?: "demo" | "compare" | "matrix" | "stress";
  strategy?: Strategy;
  /** matrix */
  notations?: readonly ModelNotation[];
  /** stress */
  notation?: ModelNotation;
  count?: number;
  /** the initial viewport; without any of the three the board is fitted into the window */
  zoom?: number;
  x?: number;
  y?: number;
  /** the node armed on load, through the arm rule of its strategy: open() returns once it is armed and the board rests */
  arm?: string;
  /** the board zoom a node is armed at (default: exact1 for an overlay node, off for any other strategy; round 5 ran min1) */
  armzoom?: ArmZoom;
  /** what a board zoom does while a node is armed (default: disarm for an overlay node, free for any other) */
  armedzoom?: ArmedZoom;
  /** whether Done, a pane click and arm(null) bring the board back to where it stood (default stay) */
  armreturn?: ArmReturn;
  /** ms the board takes to move when a rule moves it; 0 moves at once (default: the design token) */
  armmotion?: number;
  /** iframe strategy: "registry" mounts through the SPA's plugin registry (embed/product-mount.ts) */
  via?: "modules" | "registry";
  /**
   * Further URL parameters as they are, e.g. `{ plugin: "a,b" }` for `&plugin=a,b`: what a strategy
   * reads from location.search itself. The board's own parser ignores a name it does not know. Set
   * after the keys above, so a name given here wins.
   */
  params?: Readonly<Record<string, string>>;
}

export function boardUrl(base: string, query: BoardQuery | string): string {
  if (typeof query === "string") return `${base}/board-spike.html${query === "" ? "" : `?${query}`}`;
  const { params: extra, ...known } = query;
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(known)) {
    if (value !== undefined) params.set(name, Array.isArray(value) ? value.join(",") : String(value));
  }
  for (const [name, value] of Object.entries(extra ?? {})) params.set(name, value);
  return `${base}/board-spike.html?${params.toString()}`;
}

/** `url` with the entries of EXTRA_PARAMS appended; a name the URL has already is the call's own and stays */
function withExtraParams(url: string): string {
  if (extraParams() === "") return url;
  const parsed = new URL(url);
  const own = new Set(parsed.searchParams.keys());
  for (const [name, value] of EXTRA_PARAMS) {
    if (!own.has(name)) parsed.searchParams.append(name, value);
  }
  return parsed.toString();
}

export interface OpenOptions {
  /** default 2200 x 1300: an 800 x 540 node fits beside the Files panel up to board zoom 2 */
  viewport?: { width: number; height: number };
  /** deviceScaleFactor, default 1. `page.mouse` takes CSS px at any value */
  dpr?: number;
  /** false: return right after the page's mark was checked, before hooks.ready */
  wait?: boolean;
  /** true: a model node whose editor failed to mount is no error of open() (hooks.ready is true for it too) */
  allowUnmounted?: boolean;
  /** ms to rest after ready (default 300): the first fit and the fonts are through */
  settle?: number;
  /** runs in the page and in every frame before their own scripts (context.addInitScript) */
  init?: () => void;
}

type HookMethod = Exclude<keyof BoardSpikeHooks, "ready" | "probe" | "engine">;
type HookResult<K extends HookMethod> = Awaited<ReturnType<BoardSpikeHooks[K]>>;
type Callable = Record<string, (...args: unknown[]) => unknown>;

/** how a node's own document lies in the top-level page: screen = origin + local x scale */
export interface ScreenMap {
  x: number;
  y: number;
  sx: number;
  sy: number;
}
const IDENTITY: ScreenMap = { x: 0, y: 0, sx: 1, sy: 1 };

export const toScreen = (map: ScreenMap, box: Box): Box => ({
  x: map.x + box.x * map.sx,
  y: map.y + box.y * map.sy,
  width: box.width * map.sx,
  height: box.height * map.sy,
});
export const toLocal = (map: ScreenMap, point: Point): Point => ({
  x: (point.x - map.x) / map.sx,
  y: (point.y - map.y) / map.sy,
});
/**
 * The screen point at the centre of the whole px of the node's document that holds `point`. Mouse
 * events carry whole px in the document they arrive in: a position on a px boundary lands on
 * either side after the browser's inverse transform, a centre lands where it was aimed.
 */
export const aimAt = (map: ScreenMap, point: Point): Point => {
  const local = toLocal(map, point);
  return { x: map.x + (Math.floor(local.x) + 0.5) * map.sx, y: map.y + (Math.floor(local.y) + 0.5) * map.sy };
};

export interface DragOptions {
  /** pointer moves between the lead and the end (default 12): a drag needs several mousemoves */
  steps?: number;
  /**
   * The first moves after the press, in px along the drag (default [4, 8]): they pass the drag
   * thresholds while the pointer is still on what it pressed. A React Flow NODE drag starts at the
   * first move: its travel is the whole distance minus the first lead step.
   */
  lead?: readonly number[];
  /**
   * Keys held from AFTER the press to after the release. "Control" switches snapping off in
   * diagram-js (bpmn-js and the DRD snap moves to a 10 unit grid); held at the press it would
   * start the hand tool instead.
   */
  hold?: readonly string[];
  /** ms between the last move and the release (default 40) */
  settle?: number;
  /** true: the button stays down and the keys held; end the gesture with board.release(hold) */
  keepDown?: boolean;
}

/** what a drag really did, in screen px: the ratio of a measurement is against `delta`, not against what was asked */
export interface Dragged {
  from: Point;
  to: Point;
  delta: Point;
}

/** the toolbar's Done control (`[data-board-done]`, src/board-spike/toolbar.tsx) as `board.doneControl()` reads it */
export interface DoneControl {
  /** its client rect; null on a page that has no such control */
  box: Box | null;
  /** where a press goes: the box's middle, whole px; null without a box */
  middle: Point | null;
  /** the armed model node it would make a preview; null while it is switched off (no model node is armed) */
  nodeId: string | null;
  /** switched on: a model node is armed */
  enabled: boolean;
  /** switched on, its middle inside the window, and the page's topmost element there is the control or a part of it */
  takesPress: boolean;
  /** what is topmost at its middle (tag and classes), for a message */
  under: string;
  /** what it shows: "Done" and the model's name while it is on */
  text: string;
  /** its accessible name (aria-label) */
  label: string | null;
  /** the toolbar's band the arm rules keep free of the armed node: the toolbar's lower edge below the board's upper edge, px */
  band: number;
}

/** what the node's own document has at a screen point */
export interface Hit {
  /** the TOP document's topmost element there belongs to this node's editor (its host, its popup host, its frame) */
  reachable: boolean;
  /** the `data-element-id` of the nearest ancestor that has one */
  element: string | null;
  /** tag and classes of the element hit, for a message */
  what: string;
  popup: boolean;
  palette: boolean;
  pad: boolean;
}

export class Board {
  readonly page: Page;
  readonly url: string;
  /** console errors and page errors of the page and its frames, oldest first */
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  /** navigations and reloads that must not happen during a run */
  readonly violations: string[] = [];
  private session: CDPSession | undefined;
  private mainNavigations = 0;
  private readonly frameNavigations = new Map<string, number>();

  constructor(page: Page, url: string) {
    this.page = page;
    this.url = url;
    page.on("pageerror", (error) => this.errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") this.errors.push(`console.error: ${message.text()}`);
      if (message.type() === "warning") this.warnings.push(message.text());
    });
    page.on("crash", () => this.violations.push("the page crashed"));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        if (++this.mainNavigations > 1) this.violations.push(`the board page navigated again (${frame.url()})`);
        return;
      }
      // an embed frame loads once for the life of its node; about:blank before its src does not count
      if (!frame.url().includes(EMBED_PAGE)) return;
      const count = (this.frameNavigations.get(frame.name()) ?? 0) + 1;
      this.frameNavigations.set(frame.name(), count);
      if (count > 1) this.violations.push(`the frame ${frame.name()} loaded again (${count} loads)`);
    });
  }

  /** how often the top page navigated: 1 on a healthy run */
  navigations(): number {
    return this.mainNavigations;
  }

  /** throws when the page or a frame navigated or reloaded since it was opened; every hook call asks */
  assertStable(): void {
    if (this.violations.length > 0) throw new Error(`unstable run: ${this.violations.join("; ")}`);
  }

  // ── the hooks ──

  /** a method of window.__boardSpike with a serializable result */
  async hook<K extends HookMethod>(method: K, ...args: Parameters<BoardSpikeHooks[K]>): Promise<HookResult<K>> {
    this.assertStable();
    const result = await this.page.evaluate(
      ([key, name, rest]) => (window as unknown as Record<string, Callable>)[key]![name]!(...rest),
      [HOOKS_KEY, method, args] as const,
    );
    return result as HookResult<K>;
  }
  viewport = (): Promise<Viewport> => this.hook("viewport");
  /**
   * Set at once; resolves two animation frames later, when the surfaces caught up. The board does
   * not see it coming: under armedzoom=disarm another ZOOM disarms the armed node inside the first
   * tick (counters().arm.disarmsAtTick), under lock it is undone there (zoomsUndone). A pan passes.
   */
  setViewport = (viewport: Viewport): Promise<void> => this.hook("setViewport", viewport);
  /**
   * Arms one node or none through its arm rules: under armzoom=min1 or exact1 (the default of an
   * overlay node, from below AND from above zoom 1) the board may move first, under
   * armreturn=back arm(null) brings it back. The hook has no pointer: the zoom changes about the
   * node's centre and a node longer than the board's box starts at the margin. Resolves once the
   * move is over and the surface takes input (in-page: one frame after its view; iframe: the
   * frame's answer). After an interrupted move no node is armed. Read `viewport()` afterwards:
   * it is the zoom in effect.
   */
  arm = (nodeId: string | null): Promise<void> => this.hook("arm", nodeId);
  /** the arm rules in effect for a model node (`fromUrl` names those the URL gave), null for any other id */
  armPolicy = (nodeId: string): Promise<ArmPolicy | null> => this.hook("armPolicy", nodeId);
  /** what is armed, whether the arm rules are moving the board, and for which node */
  armState = (): Promise<ArmState> => this.hook("armState");
  /** the last move of the board the arm rules made, running or over; null before the first */
  lastTransition = (): Promise<ArmTransition | null> => this.hook("lastTransition");
  /** all moves of the arm rules on this page, oldest first */
  transitions = (): Promise<ArmTransition[]> => this.hook("transitions");
  /** starts recording viewport, armed node and editor zoom once per animation frame (the first sample at once) */
  startFrames = (): Promise<void> => this.hook("startFrames");
  /** ends the recording and returns it, oldest first */
  stopFrames = (): Promise<FrameSample[]> => this.hook("stopFrames");

  /**
   * Waits until the arm rules move nothing (no transition runs, `arm=` of the URL is through) AND
   * the viewport is the same in two readings one animation frame apart; returns that viewport.
   * Throws after `timeout` ms. Covers a wheel's own tail too: d3-zoom ends a wheel gesture 150 ms
   * after its last event, but applies each event at once, so the viewport rests right after it.
   */
  async waitForRest(timeout = 5000): Promise<Viewport> {
    this.assertStable();
    const rested = await this.page.evaluate(
      async ([key, limit]) => {
        const hooks = (window as unknown as Record<string, BoardSpikeHooks>)[key]!;
        const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
        const end = performance.now() + limit;
        let last = "";
        for (;;) {
          await hooks.whenRest();
          const now = JSON.stringify(hooks.viewport());
          if (now === last && !hooks.armState().moving) return hooks.viewport();
          last = now;
          if (performance.now() > end) return null;
          await frame();
        }
      },
      [HOOKS_KEY, timeout] as const,
    );
    if (!rested) throw new Error(`the board did not come to rest within ${timeout} ms`);
    return rested;
  }

  /**
   * Arms a node as a person does: a real double-click at `at` (default: the middle of the node's
   * wrapper, which in a preview is the node itself), then waits for the board to rest. Returns
   * whether the node is armed, the viewport in effect and the transition the double-click started
   * (null when the board did not have to move). Hit-test `at` yourself when something may cover it.
   * The pointer is the anchor (`transition.anchor` is "pointer"): the zoom changes about `at`, and
   * a node longer than the board's box that covers it is not moved, so `at` stays under the pointer.
   */
  async armByDoubleClick(
    nodeId: string,
    at?: Point,
  ): Promise<{ armed: boolean; viewport: Viewport; transition: ArmTransition | null; at: Point }> {
    const box = await this.nodeBox(nodeId);
    if (!box) throw new Error(`no node ${nodeId} on the board`);
    const point = at ?? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    const before = (await this.lastTransition())?.id ?? 0;
    await this.doubleClick(point);
    const viewport = await this.waitForRest();
    const last = await this.lastTransition();
    const armed = (await this.armState()).armed === nodeId;
    // the surface takes input one frame after its view (hooks.arm waits the same way)
    if (armed) await this.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    return { armed, viewport, transition: last && last.id > before ? last : null, at: point };
  }

  // ── the toolbar's Done control ──

  /**
   * The toolbar's Done control as it is right now: its box, the node it would disarm, and whether
   * it takes a press (hit-tested at its middle with the browser's own function). It is always on
   * the page and switched off while no model node is armed: `enabled` and `nodeId` say which.
   * `box` is null only on a page without the control.
   */
  async doneControl(): Promise<DoneControl> {
    this.assertStable();
    return this.page.evaluate(() => {
      const native = (window as NativeWindow).__boardSpikeNative;
      const rect = (element: Element): DOMRect => (native ? native.rect(element) : element.getBoundingClientRect());
      const flow = document.querySelector(".react-flow");
      const toolbar = document.querySelector(".board-toolbar");
      const band = flow && toolbar ? Math.max(0, rect(toolbar).bottom - rect(flow).top) : 0;
      const control = document.querySelector<HTMLButtonElement>("[data-board-done]");
      if (!control) {
        return {
          box: null,
          middle: null,
          nodeId: null,
          enabled: false,
          takesPress: false,
          under: "no control",
          text: "",
          label: null,
          band,
        };
      }
      const { x, y, width, height } = rect(control);
      const middle = { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
      const inWindow = middle.x >= 0 && middle.y >= 0 && middle.x < innerWidth && middle.y < innerHeight;
      const top = !inWindow
        ? null
        : native
          ? native.elementFromPoint(document, middle.x, middle.y)
          : document.elementFromPoint(middle.x, middle.y);
      const enabled = !control.disabled;
      return {
        box: { x, y, width, height },
        middle,
        nodeId: enabled ? control.getAttribute("data-board-done") || null : null,
        enabled,
        takesPress: enabled && !!top && (top === control || control.contains(top)),
        under: top
          ? `${top.tagName.toLowerCase()}.${(top.getAttribute("class") ?? "").slice(0, 80)}`
          : "outside the window",
        text: (control.textContent ?? "").trim(),
        label: control.getAttribute("aria-label"),
        band,
      };
    });
  }

  /**
   * Ends the editing as a person does: a real click on the middle of the toolbar's Done control,
   * then waits for the board to rest (under armreturn=back it moves back first). Nothing is
   * clicked when the control takes no press: `pressed` is false then and `control` says why.
   * `armed` is what is armed afterwards (null: the node is a preview), `viewport` where the board rests.
   */
  async pressDone(): Promise<{ pressed: boolean; armed: string | null; viewport: Viewport; control: DoneControl }> {
    const control = await this.doneControl();
    const pressed = control.takesPress && control.middle !== null;
    if (pressed) await this.click(control.middle!);
    const viewport = await this.waitForRest();
    // the armed flag leaves the node's frame through a React commit
    await this.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    return { pressed, armed: (await this.armState()).armed, viewport, control };
  }

  nodes = (): Promise<SpikeNodeInfo[]> => this.hook("nodes");
  /** client rect of the node's React Flow wrapper (header included) */
  nodeBox = (nodeId: string): Promise<Box | null> => this.hook("nodeBox", nodeId);
  /** the hub's server copy of a file: "the file" */
  fileText = (path: string): Promise<string | undefined> => this.hook("fileText", path);
  files = (): Promise<ReturnType<BoardSpikeHooks["files"]>> => this.hook("files");
  boardText = (): Promise<string> => this.hook("boardText");
  counters = (): Promise<ReturnType<BoardSpikeHooks["counters"]>> => this.hook("counters");
  /** page errors (window `error` events too, which Playwright does not report), sync errors, conflict notices */
  log = (): Promise<string[]> => this.hook("log");

  async ready(): Promise<boolean> {
    return this.page.evaluate(
      (key) => (window as unknown as Record<string, BoardSpikeHooks | undefined>)[key]?.ready === true,
      HOOKS_KEY,
    );
  }

  async waitReady(timeout = 60_000): Promise<void> {
    await this.page.waitForFunction(
      (key) => (window as unknown as Record<string, BoardSpikeHooks | undefined>)[key]?.ready === true,
      HOOKS_KEY,
      { timeout, polling: 50 },
    );
  }

  /** the client rect of the board's canvas (`.react-flow`) in the page */
  async canvasBox(): Promise<Box> {
    return this.page.evaluate(() => {
      const canvas = document.querySelector(".react-flow")!;
      const native = (window as NativeWindow).__boardSpikeNative;
      const { x, y, width, height } = native ? native.rect(canvas) : canvas.getBoundingClientRect();
      return { x, y, width, height };
    });
  }

  /**
   * Sets the board zoom and pans so that the node's top-left corner is `at` px from the canvas's
   * top-left (default 60, 80: clear of the toolbar). Works for a node inside a group too.
   */
  async showNode(nodeId: string, zoom: number, at: Point = { x: 60, y: 80 }): Promise<void> {
    await this.setViewport({ x: 0, y: 0, zoom });
    const [canvas, box] = [await this.canvasBox(), await this.nodeBox(nodeId)];
    if (!box) throw new Error(`no node ${nodeId} on the board`);
    await this.setViewport({ x: at.x - (box.x - canvas.x), y: at.y - (box.y - canvas.y), zoom });
  }

  /** the uniform handle on one model node's editor, whatever its strategy */
  async node(nodeId: string): Promise<NodeHandle> {
    const info = (await this.nodes()).find((node) => node.id === nodeId);
    if (!info) throw new Error(`no node ${nodeId} on the board`);
    if (info.type !== "model") throw new Error(`${nodeId} is a ${info.type} node: it has no editor`);
    if (info.strategy !== "iframe") return new NodeHandle(this, info, undefined);
    const frame = info.frameName === undefined ? null : this.page.frame({ name: info.frameName });
    if (!frame) throw new Error(`${nodeId}: no frame named ${info.frameName}`);
    await frame.waitForFunction((key) => key in window, EMBED_KEY, { timeout: 30_000, polling: 50 });
    return new NodeHandle(this, info, frame);
  }

  // ── pointer and keys, in top-level screen px ──

  async move(to: Point, steps = 1): Promise<void> {
    await this.page.mouse.move(to.x, to.y, { steps });
  }

  async click(at: Point, options: { clickCount?: number; button?: "left" | "right" | "middle" } = {}): Promise<void> {
    this.assertStable();
    await this.page.mouse.click(at.x, at.y, options);
  }

  /** a real double-click: arms a node, opens a label editor */
  async doubleClick(at: Point): Promise<void> {
    this.assertStable();
    await this.page.mouse.dblclick(at.x, at.y);
  }

  /**
   * Presses at `from`, moves to `to` and releases. In small steps: a drag needs several mousemoves
   * and more than 5 px, and a coarse first step would be taken for the whole gesture by whatever
   * starts on a threshold. For an editor inside a node prefer `node.drag`, which aims at whole px.
   */
  async drag(from: Point, to: Point, options: DragOptions = {}): Promise<Dragged> {
    this.assertStable();
    const { mouse, keyboard } = this.page;
    const hold = options.hold ?? [];
    const steps = options.steps ?? 12;
    const [dx, dy] = [to.x - from.x, to.y - from.y];
    const length = Math.hypot(dx, dy);
    await mouse.move(from.x, from.y);
    await mouse.down();
    let led = 0;
    for (const px of options.lead ?? [4, 8]) {
      if (px >= length) break;
      led = px;
      await mouse.move(from.x + (dx / length) * px, from.y + (dy / length) * px);
    }
    for (const key of hold) await keyboard.down(key);
    const start = length > 0 ? led / length : 1;
    for (let step = 1; step <= steps; step++) {
      const t = start + ((1 - start) * step) / steps;
      await mouse.move(from.x + dx * t, from.y + dy * t);
    }
    // the last position exactly
    await mouse.move(to.x, to.y);
    await this.page.waitForTimeout(options.settle ?? 40);
    if (!options.keepDown) await this.release(hold);
    return { from, to, delta: { x: dx, y: dy } };
  }

  /** ends a drag that was left down (`keepDown`), releasing the keys it held */
  async release(hold: readonly string[] = []): Promise<void> {
    await this.page.mouse.up();
    for (const key of [...hold].reverse()) await this.page.keyboard.up(key);
  }

  /** a wheel at `at`. deltaY < 0 zooms in on the pane (x 2^(-deltaY * 0.002)); `hold: ["Control"]` for the pinch zoom */
  async wheel(at: Point, deltaY: number, options: { deltaX?: number; hold?: readonly string[] } = {}): Promise<void> {
    this.assertStable();
    await this.page.mouse.move(at.x, at.y);
    for (const key of options.hold ?? []) await this.page.keyboard.down(key);
    await this.page.mouse.wheel(options.deltaX ?? 0, deltaY);
    for (const key of [...(options.hold ?? [])].reverse()) await this.page.keyboard.up(key);
  }

  /**
   * A wheel burst at `at`, as a trackpad or a wheel with inertia sends it: `count` events (default
   * 8) of `deltaY` each, `frames` animation frames apart (default 1). On the pane one event zooms
   * by 2^(-deltaY x 0.002): 8 x 40 ends at 0.64 of the zoom. `hold: ["Control"]` is the pinch.
   * Does not wait for anything afterwards: follow with `waitForRest()` unless the case is the burst.
   */
  async wheelBurst(
    at: Point,
    deltaY: number,
    options: { count?: number; frames?: number; deltaX?: number; hold?: readonly string[] } = {},
  ): Promise<void> {
    this.assertStable();
    const frames = Math.max(1, options.frames ?? 1);
    await this.page.mouse.move(at.x, at.y);
    for (const key of options.hold ?? []) await this.page.keyboard.down(key);
    for (let index = 0; index < (options.count ?? 8); index++) {
      await this.page.mouse.wheel(options.deltaX ?? 0, deltaY);
      await this.page.evaluate(
        (wait) =>
          new Promise<void>((resolve) => {
            const step = (left: number): void =>
              void (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
            step(wait);
          }),
        frames,
      );
    }
    for (const key of [...(options.hold ?? [])].reverse()) await this.page.keyboard.up(key);
  }

  /** a key or chord for whatever has the focus: after arming that is the editor, in its frame too ("Control+A", "Delete") */
  async press(key: string): Promise<void> {
    this.assertStable();
    await this.page.keyboard.press(key);
  }

  async type(text: string, delay = 10): Promise<void> {
    this.assertStable();
    await this.page.keyboard.type(text, { delay });
  }

  /** a point of the bare pane (a click there disarms): searched, since a fitted board is mostly covered by nodes */
  async freePanePoint(): Promise<Point | null> {
    return this.page.evaluate(() => {
      const pane = document.querySelector(".react-flow__pane");
      const flow = document.querySelector(".react-flow");
      if (!pane || !flow) return null;
      const native = (window as NativeWindow).__boardSpikeNative;
      const canvas = native ? native.rect(flow) : flow.getBoundingClientRect();
      for (let y = canvas.bottom - 12; y > canvas.top; y -= 24) {
        for (let x = canvas.right - 12; x > canvas.left; x -= 24) {
          const top = native ? native.elementFromPoint(document, x, y) : document.elementFromPoint(x, y);
          if (top === pane) return { x, y };
        }
      }
      return null;
    });
  }

  // ── waiting ──

  /** polls `check` until it returns something truthy; null after `timeout` ms */
  async waitFor<T>(check: () => Promise<T>, timeout = 3000, interval = 40): Promise<T | null> {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() >= end) return null;
      await this.page.waitForTimeout(interval);
    }
  }

  /**
   * Waits until the finite animations that are running in the page and in its same-origin frames
   * have finished (CSS animations, CSS transitions, script animations), at most `cap` ms. Resolves
   * to how many were running: 0 costs one round trip per document. Never waits on an infinite
   * animation, nor on one that only repaints (ANIMATIONS_REST).
   */
  async animationsRest(cap = ANIMATION_CAP_MS): Promise<number> {
    const { origin } = new URL(this.page.url());
    const documents = this.page.frames().filter((frame) => frame.url().startsWith(`${origin}/`));
    // a frame that goes away under the question has nothing running; assertStable reports a navigation
    const running = await Promise.all(documents.map((frame) => frame.evaluate(ANIMATIONS_REST, cap).catch(() => 0)));
    return running.reduce((sum, count) => sum + count, 0);
  }

  /**
   * The box `read` returns once it is there AND at rest (the same in two polls). Chrome is placed
   * after it appears: a context pad one task after it opens (read at once it is `.open` but lies
   * where the page's flow put it), a popup after its first render, a palette tooltip after 300 ms.
   *
   * Two equal polls alone are no rest: the product's theme lets pads and popups pop in over 150 ms
   * from 4 px above their place (designiq-canvas-pop-in), and on a page that gets few frames two
   * reads 50 ms apart both return the box of one and the same animation frame. So every poll first
   * waits for the running animations to finish (animationsRest, at most 400 ms per poll and never
   * past `timeout`): the box may appear, and its animation begin, long after the first poll.
   */
  async waitForBox(read: () => Promise<Box | null | undefined>, timeout = 2000, interval = 50): Promise<Box | null> {
    const end = Date.now() + timeout;
    let last: Box | null = null;
    for (;;) {
      await this.animationsRest(Math.max(0, Math.min(ANIMATION_CAP_MS, end - Date.now())));
      const box = (await read()) ?? null;
      const still =
        !!box &&
        !!last &&
        [box.x - last.x, box.y - last.y, box.width - last.width, box.height - last.height].every(
          (difference) => Math.abs(difference) < 0.01,
        );
      if (box && still) return box;
      last = box;
      if (Date.now() >= end) return null;
      await this.page.waitForTimeout(interval);
    }
  }

  /** the file's text once it differs from `before` (an editor writes about 350 ms after a gesture); null when it never did */
  async waitForFileChange(path: string, before: string | undefined, timeout = 3000): Promise<string | null> {
    return this.waitFor(async () => {
      const now = await this.fileText(path);
      return now !== undefined && now !== before ? now : null;
    }, timeout);
  }

  // ── errors ──

  /**
   * Everything that should be empty after a healthy run: navigations, console and page errors,
   * and the page's own log. `allow` drops known console lines (KNOWN_CONSOLE).
   */
  async problems(options: { allow?: readonly RegExp[] } = {}): Promise<string[]> {
    const allowed = (line: string): boolean => (options.allow ?? []).some((pattern) => pattern.test(line));
    const log = this.violations.length > 0 ? [] : (await this.log()).map((line) => `log: ${line}`);
    return [...this.violations, ...this.errors.filter((line) => !allowed(line)), ...log];
  }

  // ── screenshots and metrics ──

  /** a PNG of the page, or of `clip` (screen px); returns the path */
  async screenshot(path: string, clip?: Box): Promise<string> {
    mkdirSync(dirname(path), { recursive: true });
    const view = this.page.viewportSize() ?? { width: 0, height: 0 };
    const inside = clip && {
      x: Math.max(0, Math.floor(clip.x)),
      y: Math.max(0, Math.floor(clip.y)),
      width: Math.ceil(Math.min(view.width, clip.x + clip.width) - Math.max(0, Math.floor(clip.x))),
      height: Math.ceil(Math.min(view.height, clip.y + clip.height) - Math.max(0, Math.floor(clip.y))),
    };
    await this.page.screenshot({ path, ...(inside && inside.width > 0 && inside.height > 0 ? { clip: inside } : {}) });
    return path;
  }

  /** the raw DevTools session of the page (Performance, HeapProfiler, Tracing, Memory, ...) */
  async cdp(): Promise<CDPSession> {
    this.session ??= await this.page.context().newCDPSession(this.page);
    return this.session;
  }

  /**
   * CDP Performance.getMetrics by name: JSHeapUsedSize, Nodes, Documents, JSEventListeners,
   * LayoutCount, RecalcStyleCount, LayoutDuration, ScriptDuration, TaskDuration, ... Same-origin
   * frames share the page's renderer, so the figures cover every embed frame.
   */
  async metrics(): Promise<Record<string, number>> {
    const session = await this.cdp();
    await session.send("Performance.enable");
    const { metrics } = await session.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
  }

  /** a forced garbage collection, before a heap figure is read */
  async collectGarbage(): Promise<void> {
    await (await this.cdp()).send("HeapProfiler.collectGarbage");
  }

  /** closes the page's context; throws if the page navigated under the run */
  async close(): Promise<void> {
    await this.page.context().close();
    this.assertStable();
  }
}

/**
 * ONE model node's editor, the same in every strategy. In-page strategies answer from the
 * board page (`hooks.probe(nodeId)`), the iframe strategy from the node's frame
 * (`window.__boardSpikeEmbed.probe`); every rectangle that leaves this class is in TOP-LEVEL screen
 * px, mapped through the frame element's client rect and scale where there is a frame.
 */
export class NodeHandle {
  readonly board: Board;
  readonly id: string;
  readonly info: SpikeNodeInfo;
  /** the node's frame in the iframe strategy, else undefined */
  readonly frame: Frame | undefined;

  constructor(board: Board, info: SpikeNodeInfo, frame: Frame | undefined) {
    this.board = board;
    this.id = info.id;
    this.info = info;
    this.frame = frame;
  }

  /** the document the editor lives in: `evaluate` and `waitForFunction` run there */
  get scope(): Page | Frame {
    return this.frame ?? this.board.page;
  }

  /** a method of the node's SpikeProbe, RAW: rectangles are in the coordinates of the node's own document */
  async probe<K extends keyof SpikeProbe>(
    method: K,
    ...args: Parameters<SpikeProbe[K]>
  ): Promise<ReturnType<SpikeProbe[K]>> {
    this.board.assertStable();
    const result = this.frame
      ? await this.frame.evaluate(
          ([key, name, rest]) => (window as unknown as Record<string, { probe: Callable }>)[key]!.probe[name]!(...rest),
          [EMBED_KEY, method, args] as const,
        )
      : await this.board.page.evaluate(
          ([key, id, name, rest]) => {
            const probe = (window as unknown as Record<string, { probe(id: string): Callable | null }>)[key]!.probe(id);
            if (!probe) throw new Error(`${id} has no probe: its surface did not register one`);
            return probe[name]!(...rest);
          },
          [HOOKS_KEY, this.id, method, args] as const,
        );
    return result as ReturnType<SpikeProbe[K]>;
  }

  /** where the node's document lies on screen right now: the identity in-page, the frame's rect and scale otherwise */
  async map(): Promise<ScreenMap> {
    if (!this.frame) return IDENTITY;
    return this.board.page.evaluate((name) => {
      const frame = document.querySelector<HTMLIFrameElement>(`iframe[name="${CSS.escape(name)}"]`);
      if (!frame) throw new Error(`no frame element named ${name}`);
      const native = (window as NativeWindow).__boardSpikeNative;
      const rect = native ? native.rect(frame) : frame.getBoundingClientRect();
      // layout px against screen px; a border, if the frame had one, lies outside its viewport
      const [sx, sy] = [rect.width / frame.offsetWidth, rect.height / frame.offsetHeight];
      return { x: rect.x + frame.clientLeft * sx, y: rect.y + frame.clientTop * sy, sx, sy };
    }, this.frame.name());
  }

  // ── the probe, in screen px ──

  /** client rect of the engine host */
  async hostBox(): Promise<Box> {
    return toScreen(await this.map(), await this.probe("hostBox"));
  }
  /** the element's `.djs-visual`, null when the editor shows no such element */
  async elementBox(elementId: string): Promise<Box | null> {
    const box = await this.probe("elementBox", elementId);
    return box && toScreen(await this.map(), box);
  }
  /** whatever matches inside the host and inside the popup host the editor owns */
  async query(selector: string): Promise<Box[]> {
    const map = await this.map();
    return (await this.probe("query", selector)).map((box) => toScreen(map, box));
  }
  /** the scale between the engine's layout px and its client rect IN ITS DOCUMENT: 1 means its pointer math is exact */
  netScale = (): Promise<number> => this.probe("netScale");
  /** clientWidth / clientHeight of the engine host, in its own layout px */
  hostSize = (): Promise<{ width: number; height: number }> => this.probe("hostSize");
  elementIds = (): Promise<string[]> => this.probe("elementIds");
  /** the CTM of `g.viewport` inside its svg (a = the diagram's own scale); null in an HTML view */
  viewportMatrix = (): Promise<{ a: number; d: number; e: number; f: number } | null> => this.probe("viewportMatrix");
  /** the text of THIS editor's replica (the file at the hub is `board.fileText`) */
  text = (): Promise<string> => this.probe("text");

  /** the node's SpikeNodeInfo of now (armed, mounted) */
  async state(): Promise<SpikeNodeInfo> {
    const info = (await this.board.nodes()).find((node) => node.id === this.id);
    if (!info) throw new Error(`the node ${this.id} is gone`);
    return info;
  }

  /**
   * Screen px per diagram unit, from the browser's own matrix (`g.viewport.getScreenCTM()`, times
   * the frame's scale): ground truth that asks no engine. Null in an HTML view.
   */
  async diagramScale(): Promise<number | null> {
    const [map, scale] = [await this.map(), await this.inDocument(SCREEN_CTM_SCALE)];
    return scale === null ? null : scale * map.sx;
  }

  /**
   * Runs `run(host, arg)` in the node's document, `host` being the engine's host element. The
   * function crosses as text: it sees its two arguments and that document, nothing of the script.
   * A geometry read in it goes through `window.__boardSpikeNative` (see the header): the plain
   * methods answer in the shim strategy's virtual space while the node is armed.
   */
  async inDocument<A, R>(run: (host: HTMLElement, arg: A) => R, arg?: A): Promise<R> {
    this.board.assertStable();
    const host = await this.scope.evaluateHandle(
      ([key, embedKey, id]) => {
        const page = window as unknown as Record<string, unknown>;
        if (embedKey in page) return document.querySelector<HTMLElement>(".board-embed__host");
        const hooks = page[key] as { engine(id: string): { host?: HTMLElement } | undefined } | undefined;
        return hooks?.engine(id)?.host ?? null;
      },
      [HOOKS_KEY, EMBED_KEY, this.id] as const,
    );
    try {
      const element = host.asElement();
      if (!element) throw new Error(`${this.id}: no engine host in this document`);
      // Playwright types the argument as it arrives in the page (handles unboxed); here it is plain data
      const result: unknown = await element.evaluate(run as (host: Node, arg: unknown) => unknown, arg);
      return result as R;
    } finally {
      await host.dispose();
    }
  }

  /** what the node's document has at a screen point: hit-test BEFORE every press (chrome covers shapes at low zoom) */
  async hit(point: Point): Promise<Hit> {
    const map = await this.map();
    const local = toLocal(map, point);
    const page = this.board.page;
    if (this.frame) {
      const name = this.frame.name();
      const onFrame = await page.evaluate(
        ([x, y, frameName]) => {
          const native = (window as NativeWindow).__boardSpikeNative;
          const top = native ? native.elementFromPoint(document, x, y) : document.elementFromPoint(x, y);
          return top?.getAttribute("name") === frameName;
        },
        [point.x, point.y, name] as const,
      );
      const inside = await this.inDocument(DESCRIBE_HIT, { x: local.x, y: local.y, node: null });
      return { ...inside, reachable: onFrame && inside.reachable };
    }
    return this.inDocument(DESCRIBE_HIT, { x: local.x, y: local.y, node: this.id });
  }

  /** the ids the editor shows as selected (`.djs-element.selected`), read off the DOM like everything else */
  selected(): Promise<string[]> {
    return this.inDocument((host) =>
      [...host.querySelectorAll(".djs-element.selected[data-element-id]")].map(
        (element) => element.getAttribute("data-element-id") ?? "",
      ),
    );
  }

  // ── pointer ──

  /**
   * Selects an element as a person does, with a click on the middle of its graphics, unless it is
   * selected already (a click on a selected element can deselect it). False when the element is
   * not drawn or something else lies over that point; read pad rectangles with `board.waitForBox`.
   */
  async select(elementId: string): Promise<boolean> {
    if ((await this.selected()).includes(elementId)) return true;
    const box = await this.elementBox(elementId);
    if (!box) return false;
    const at = aimAt(await this.map(), centre(box));
    const hit = await this.hit(at);
    if (!hit.reachable || hit.element !== elementId) return false;
    await this.board.click(at);
    return (await this.board.waitFor(async () => (await this.selected()).includes(elementId), 1000)) === true;
  }

  /**
   * A screen point of the element's graphics that takes a press FOR THAT ELEMENT: the middle of
   * its box when nothing lies over it, else the nearest point of a 5 x 5 grid over the box (at
   * 10, 30, 50, 70 and 90 % of its width and height) that is inside the window and whose hit is
   * the element itself, not a pad, a palette or a popup. Each point is aimed at the centre of a
   * whole px of the node's document. Null when the element is not drawn or no point of the grid
   * takes the press. For a press, a drag's start or a double-click on a shape that chrome covers
   * in part (the context pad of a neighbour, the palette at a low zoom).
   */
  async pressPoint(elementId: string): Promise<Point | null> {
    const box = await this.elementBox(elementId);
    if (!box || !(box.width > 0) || !(box.height > 0)) return null;
    const map = await this.map();
    const view = this.board.page.viewportSize();
    const middle = centre(box);
    const points = PRESS_GRID.flatMap((fy) =>
      PRESS_GRID.map((fx) => aimAt(map, { x: box.x + box.width * fx, y: box.y + box.height * fy })),
    ).sort((a, b) => Math.hypot(a.x - middle.x, a.y - middle.y) - Math.hypot(b.x - middle.x, b.y - middle.y));
    for (const point of points) {
      if (point.x < 1 || point.y < 1) continue;
      if (view && (point.x > view.width - 1 || point.y > view.height - 1)) continue;
      const hit = await this.hit(point);
      if (hit.reachable && hit.element === elementId && !hit.pad && !hit.palette && !hit.popup) return point;
    }
    return null;
  }

  /**
   * Selects an element like `select`, but with a click on ANY point of its box that takes the
   * press (`pressPoint`), not on its middle alone: where chrome that keeps its size covers the
   * middle, `select` returns false although the shape can be selected. True when the element is
   * selected already or the click selected it; false when no point of the grid takes the press.
   * `select` itself is unchanged: rows of earlier rounds depend on its middle-only click.
   */
  async selectAnywhere(elementId: string): Promise<boolean> {
    if ((await this.selected()).includes(elementId)) return true;
    const at = await this.pressPoint(elementId);
    if (!at) return false;
    await this.board.click(at);
    return (await this.board.waitFor(async () => (await this.selected()).includes(elementId), 1000)) === true;
  }

  /**
   * Drags from the screen point `from` by `delta` screen px, both ends aimed at the centre of a
   * whole px of the node's document (aimAt). Returns what was really travelled: compare an
   * element's displacement with `delta` of the RESULT.
   */
  async drag(from: Point, delta: Point, options: DragOptions = {}): Promise<Dragged> {
    const map = await this.map();
    const start = aimAt(map, from);
    const end = aimAt(map, { x: from.x + delta.x, y: from.y + delta.y });
    return this.board.drag(start, end, options);
  }

  /**
   * A drag out of the engine's palette onto the canvas, e.g. from
   * `(await node.query('.djs-palette .entry[data-action="create.task"]'))[0]` to a screen point.
   * diagram-js starts `create` on the entry's dragstart: when the first move after the press
   * already leaves the palette, the hover of the root comes before the drag exists and the drop is
   * refused. So the first two moves stay INSIDE the entry, then the pointer goes on in small steps.
   * Drop more than 20 px from the canvas edge (auto-scroll), clear of every snap line and not on a
   * label or flow; Escape afterwards: a created shape opens its label editor.
   */
  async paletteDrag(entry: Box, to: Point, options: DragOptions = {}): Promise<Dragged> {
    const map = await this.map();
    const start = aimAt(map, centre(entry));
    const end = aimAt(map, to);
    // the entry is small on screen when the board scales it (naive, iframe at low zoom)
    const reach = Math.max(1, Math.min(entry.width, entry.height) / 2 - 2);
    return this.board.drag(start, end, {
      steps: 16,
      ...options,
      lead: [Math.min(4, reach), Math.min(8, reach)].filter((px, index, all) => all.indexOf(px) === index),
    });
  }

  /** a PNG of the node (its wrapper and its editor's host, plus `pad` px and whatever `around` adds, e.g. a popup's box) */
  async screenshot(path: string, options: { pad?: number; around?: readonly Box[] } = {}): Promise<string> {
    const pad = options.pad ?? 12;
    const wrapper = await this.board.nodeBox(this.id);
    const box = union(...(wrapper ? [wrapper] : []), await this.hostBox(), ...(options.around ?? []));
    return this.board.screenshot(path, {
      x: box.x - pad,
      y: box.y - pad,
      width: box.width + 2 * pad,
      height: box.height + 2 * pad,
    });
  }
}

/**
 * Runs in a document (the page or a frame): resolves once every finite animation that is running
 * there and can move or resize a box has finished, or after `cap` ms; resolves to how many there
 * were. Left out: an animation without an end (a spinner, React Flow's animated edge), one that is
 * paused, and one that only repaints (opacity, colours, shadows, outline: the Files panel flashes
 * for 1.8 s after every edit, which would cost every poll its whole cap and moves nothing).
 */
const ANIMATIONS_REST = async (cap: number): Promise<number> => {
  const repaintsOnly = (property: string): boolean =>
    /^(opacity|visibility|(backdrop-)?filter|box-shadow|text-shadow|color|caret-color|text-decoration-color|fill|fill-opacity|stroke|stroke-opacity|background(-.+)?|outline(-.+)?|border(-.+)?-color)$/.test(
      property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
    );
  const NOT_A_PROPERTY = new Set(["offset", "computedOffset", "easing", "composite"]);
  const moving = document.getAnimations().filter((animation) => {
    if (animation.playState !== "running") return false;
    const end = animation.effect?.getComputedTiming().endTime;
    if (typeof end !== "number" || !Number.isFinite(end)) return false;
    const properties =
      animation.effect instanceof KeyframeEffect
        ? [...new Set(animation.effect.getKeyframes().flatMap((frame) => Object.keys(frame)))].filter(
            (name) => !NOT_A_PROPERTY.has(name),
          )
        : [];
    // unknown properties count as moving: waiting too long is the smaller mistake
    return properties.length === 0 || !properties.every(repaintsOnly);
  });
  if (moving.length === 0) return 0;
  await Promise.race([
    // `finished` rejects when the animation is cancelled (its element went away): that is rest too
    Promise.allSettled(moving.map((animation) => animation.finished)),
    new Promise((resolve) => setTimeout(resolve, cap)),
  ]);
  return moving.length;
};

/** runs in the node's document (inDocument): the screen scale of `g.viewport`, null without a canvas */
const SCREEN_CTM_SCALE = (host: HTMLElement): number | null => {
  const viewport = host.querySelector<SVGGElement>("svg g.viewport");
  if (!viewport) return null;
  const native = (window as NativeWindow).__boardSpikeNative;
  return (native ? native.screenCTM(viewport) : viewport.getScreenCTM())?.a ?? null;
};

/** runs in the node's document (inDocument): what lies at a point of that document */
const DESCRIBE_HIT = (host: HTMLElement, at: { x: number; y: number; node: string | null }): Hit => {
  const native = (window as NativeWindow).__boardSpikeNative;
  const element = native ? native.elementFromPoint(document, at.x, at.y) : document.elementFromPoint(at.x, at.y);
  // the counter strategy's body-level popup host carries the node's id; a frame has none
  const popupHost =
    at.node === null
      ? undefined
      : [...document.querySelectorAll<HTMLElement>(".board-popup-host")].find((one) => one.dataset.node === at.node);
  return {
    reachable: !!element && (host.contains(element) || !!popupHost?.contains(element)),
    element: element?.closest("[data-element-id]")?.getAttribute("data-element-id") ?? null,
    what: element
      ? `${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "").slice(0, 80)}`
      : "nothing",
    popup: !!element?.closest(".djs-popup"),
    palette: !!element?.closest(".djs-palette"),
    pad: !!element?.closest(".djs-context-pad"),
  };
};

// ── events, as a document saw them ───────────────────────────────────────────

export interface SeenEvent {
  type: string;
  /** clientX / clientY from the browser's own getters: true px of that document, whatever a strategy patched */
  x: number;
  y: number;
  key?: string;
  /** false: dispatched by a script (a strategy that re-dispatches input, the embed page's release) */
  trusted: boolean;
  /** performance.now() of that document */
  t: number;
}
const INPUT_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "mousedown",
  "mousemove",
  "mouseup",
  "click",
  "dblclick",
  "wheel",
  "keydown",
  "keyup",
];

/**
 * Records the input events one document sees (capture phase, on its window): `board.page` for the
 * board page, `node.scope` for a node's frame. Which document got a key, a wheel or the moves of a
 * drag is what tells the strategies apart.
 */
export async function recordEvents(scope: Page | Frame, types: readonly string[] = INPUT_EVENTS): Promise<void> {
  await scope.evaluate((names) => {
    const page = window as unknown as { __seen?: SeenEvent[] };
    if (page.__seen) return;
    const seen: SeenEvent[] = (page.__seen = []);
    const native = (window as NativeWindow).__boardSpikeNative;
    for (const type of names) {
      window.addEventListener(
        type,
        (event) => {
          const input = event as MouseEvent & KeyboardEvent;
          // a key event has no client point: x and y stay undefined, as before
          const { x, y } =
            native && "clientX" in input ? native.clientPoint(input) : { x: input.clientX, y: input.clientY };
          const { key, isTrusted } = input;
          seen.push({ type, x, y, ...(key !== undefined ? { key } : {}), trusted: isTrusted, t: performance.now() });
        },
        true,
      );
    }
  }, types);
}

export function seenEvents(scope: Page | Frame, type?: string): Promise<SeenEvent[]> {
  return scope.evaluate(
    (wanted) =>
      ((window as unknown as { __seen?: SeenEvent[] }).__seen ?? []).filter((one) => !wanted || one.type === wanted),
    type,
  );
}

export async function clearEvents(scope: Page | Frame): Promise<void> {
  await scope.evaluate(() => void (window as unknown as { __seen?: SeenEvent[] }).__seen?.splice(0));
}

// ── the harness ──────────────────────────────────────────────────────────────

export interface Harness {
  readonly base: string;
  readonly browser: Browser;
  readonly server: SpikeServer;
  /** opens a board in a context of its own: a fresh page, nothing shared with another */
  open(query: BoardQuery | string, options?: OpenOptions): Promise<Board>;
  /** closes every page, the browser and the dev server; safe to call twice */
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const server = await startServer();
  let browser: Browser;
  try {
    browser = await launchBrowser();
  } catch (error) {
    await server.close();
    throw error;
  }
  let closed = false;
  return {
    base: server.base,
    browser,
    server,
    async open(query, options = {}) {
      const context = await browser.newContext({
        viewport: options.viewport ?? { width: 2200, height: 1300 },
        deviceScaleFactor: options.dpr ?? 1,
      });
      if (options.init) await context.addInitScript(options.init);
      const page = await context.newPage();
      const url = withExtraParams(boardUrl(server.base, query));
      const board = new Board(page, url);
      try {
        await page.goto(url);
        // a 200 proves nothing: the dev server answers a missing page with the SPA
        const mark = await page.evaluate(
          (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content"),
          PAGE_MARK,
        );
        if (mark !== "board") throw new Error(`${url} is not the board page (mark: ${String(mark)})`);
        if (options.wait === false) return board;
        await board.waitReady();
        if (!options.allowUnmounted) {
          const failed = (await board.nodes()).filter((node) => node.type === "model" && !node.mounted);
          if (failed.length > 0) {
            const log = await board.log();
            throw new Error(`not mounted: ${failed.map((node) => node.id).join(", ")} (${log.join("; ")})`);
          }
        }
        await page.waitForTimeout(options.settle ?? 300);
        return board;
      } catch (error) {
        await context.close();
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await browser.close();
      } finally {
        await server.close();
      }
    },
  };
}

/**
 * The frame of a script: starts the harness, runs `main`, shuts everything down whatever happened
 * and sets the exit code. `main` returns the number of failed checks (or nothing). Exit 1 when
 * `main` threw (wrong page, a navigation, a timeout), returned a number above 0, or the dev
 * server's optimizer found a dependency late; 0 otherwise. What a measurement says about a
 * strategy belongs in its result, not in the exit code.
 */
export async function run(main: (harness: Harness) => Promise<number | void>): Promise<void> {
  let harness: Harness | undefined;
  let code = 0;
  const stop = (signal: string): void => {
    console.error(`\n${signal}: shutting down`);
    void (harness?.close() ?? Promise.resolve()).finally(() => process.exit(130));
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  try {
    harness = await startHarness();
    if (extraParams() !== "") console.log(`EXTRA_PARAMS: every board URL gets ${extraParams()}`);
    const failures = await main(harness);
    if (typeof failures === "number" && failures > 0) code = 1;
    const notes = harness.server.optimizerNotes();
    if (notes.length > 0) {
      console.error(`the dev server's optimizer ran again during the run:\n${notes.join("\n")}`);
      code = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    code = 1;
  } finally {
    await harness?.close();
  }
  process.exitCode = code;
  // nothing of the harness is left; a handle a script forgot must not keep the process alive
  setTimeout(() => process.exit(code), 2000).unref();
}
