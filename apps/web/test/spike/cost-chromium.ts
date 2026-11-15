/**
 * Cost of the six strategies of the board spike: what an editor in a node costs to mount, to keep
 * in memory, to arm, while the board moves, while the pointer works in it, while the board is
 * worked beside it, and at rest. A measurement run by hand on lib.ts, not by `pnpm test` or CI.
 *
 *   on the dev server (the script's own, unbundled modules: load times say little):
 *     PORT=5438 CACHE_DIR=<scratch>/vite-cache OUT_DIR=<scratch>/dev node apps/web/test/spike/cost-chromium.ts
 *   on a production build of the spike's two pages, served by `vite preview`:
 *     BASE=http://localhost:5439 OUT_DIR=<scratch>/prod node apps/web/test/spike/cost-chromium.ts
 *
 * The build. Neither page is a build input of the product, so the build needs a Vite config of
 * its own, OUTSIDE the repository: one that imports apps/web/vite.config.ts as it is and sets root
 * (apps/web), build.rollupOptions.input (board-spike.html, board-spike-embed.html), build.outDir
 * and preview.port. Name it `.mts` (outside a package Vite takes a `.ts` config for CommonJS).
 * From apps/web: `node node_modules/vite/bin/vite.js build --config <it>`, then the same with
 * `preview`. Vite's preview answers every file with `Cache-Control: no-cache`; for a warm load
 * that means something, give /assets/ the product's rule (`public, max-age=31536000, immutable`,
 * apps/live-host/src/http/api.ts) in a configurePreviewServer hook of that config.
 *
 * All cases at REPEAT=5 take about an hour: start the run detached and read its log, or run it
 * case by case (CASES).
 *
 * ONE page at a time, never two: every number here is a time or a size of one renderer process.
 * Each sample runs on a fresh page in a fresh browser context (a renderer process of its own).
 * The repetitions are the OUTER loop and the order of the strategies rotates with each one, so a
 * drift of the machine hits every strategy alike.
 *
 * What is measured, each per strategy (METHOD at the end of the file is printed into the result):
 *   M1 mount     navigation start until every editor shows its first element / reports ready, for
 *                N BPMN editors and for the mixed board, cold and warm; slope per editor
 *   M2 memory    after load and a forced collection: JS heap of the whole isolate (all frames),
 *                DOM nodes, resident memory of the renderer and of all processes; slope per editor
 *   M3 arming    from the click on Edit until the editor takes input, and the same for disarming
 *   M4 frames    frame intervals and main thread time per frame while the board pans and zooms
 *   M5 pointer   main thread time per mouse move of a drag inside the armed editor
 *   M6 board     main thread time per mouse move of a node drag beside an armed editor
 *   M7 idle      main thread time of a board at rest with one editor armed
 *
 * Environment (comma lists):
 *   STRATEGIES      default all six
 *   CASES           of mount, memory, arming, frames, pointer, board, idle (default all)
 *   REPEAT          samples per case and strategy (default 5: median and range need that many)
 *   BUDGET_MIN      minutes the repetitions may take: a further repetition starts only when it fits,
 *                   judged by the mean of those done. Cuts repetitions, never cases (default: none)
 *   COUNTS          editors on the board for M1 and M2 (default 1,5,10,20)
 *   FRAME_COUNTS    for M4 (default 10,20)
 *   POINTER_COUNTS  for M5 (default 1,20)
 *   BOARD_COUNT     for M3, M6 and M7 (default 10)
 *   MOVES           mouse moves of the drags of M5 and M6 (default 200)
 *   IDLE_MS         length of the rest of M7 (default 10000)
 *   DPR             device pixel ratio (default 1)
 *   FORCE           1: print the table as final although the machine was loaded at the start
 *   WAIT_QUIET      minutes to wait at the start for the 1 minute load average to fall to 3
 *   SPEED_REF_MS    ms the fixed work of the speed probe takes on this machine when it is quiet
 *                   (a former run's machineSpeed.workMs.median): a slower run is not final
 * plus lib.ts's PORT, BASE, CACHE_DIR, OUT_DIR, EXTRA_PARAMS. Result: <OUT_DIR>/cost.json (every
 * sample) and <OUT_DIR>/cost.md (medians and ranges), the latter also printed.
 *
 * FINAL OR NOT. The script reads /proc/loadavg before it starts anything. With a 1 minute load
 * above 3 the result is marked NOT FINAL in both files, unless FORCE=1. It is also not final with
 * fewer than 2 complete repetitions, with MOVES or IDLE_MS other than the defaults, and when a
 * sample failed. Fewer than 5 repetitions (REPEAT, or BUDGET_MIN cutting them) is said in the title
 * and in a bold line of its own: each cell is then the median of that many samples. Load at the
 * start, at the end and at every sample is recorded.
 *
 * MACHINE SPEED. The load average counts this system's own tasks and cannot see a host that runs a
 * virtual machine slower or takes its processors away. So before every sample a fixed amount of
 * work is timed in this process (`speedMs`), and the processor time the host took during the sample
 * is read from /proc/stat (`stolenPct`). Both are in every sample and summed up in the result. NOT
 * FINAL: a run whose repetitions differ in speed by more than 15 %, one in which the host took more
 * than 10 % of the wanted processor time (median over the samples), and one that is more than 15 %
 * slower than SPEED_REF_MS (the `machineSpeed.workMs.median` of a run taken as the reference).
 *
 * The exit code is 1 when the harness failed: a sample threw (wrong page, an editor that did not
 * mount, a gesture that did not happen, a timeout), or a page had a console error or a log line.
 * What a number says about a strategy is in the result, never in the exit code.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";

import type { CDPSession } from "playwright";

import { EMBED_PAGE, PAGE_MARK } from "../../src/board-spike/shared.ts";
import {
  aimAt,
  Board,
  type BoardQuery,
  type Box,
  centre,
  extraParams,
  type Harness,
  type NativeGeometry,
  outPath,
  type Point,
  round,
  run,
  sleep,
  STRATEGIES,
  type Strategy,
  writeResult,
} from "./lib.ts";

// ── the machine, before anything of this run loads it ────────────────────────

/** the 1 minute load average, from /proc/loadavg */
function load1(): number {
  try {
    return Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
  } catch {
    return loadavg()[0] ?? Number.NaN;
  }
}
/** above this at the start the result is not final */
const LOAD_LIMIT = 3;
let loadAtStart = load1();

/**
 * How fast this machine works right now: a fixed amount of work in this process, timed. The load
 * average cannot show it: it counts this system's own tasks. In a virtual machine the host can run
 * the processors slower or take them away (steal time), and then EVERY time and every CPU figure of
 * a sample grows while the load average says the machine is idle. Measured in the two final runs
 * of round 4 (a KVM guest, load average below 2.5 in both): the same 200 mouse moves cost 0.33 ms
 * of script each in one run and 0.55 to 0.66 ms in two repetitions of the next. Where the kernel
 * is built without CONFIG_PARAVIRT_TIME_ACCOUNTING (this one) stolen time counts as CPU time of the
 * thread that was running, so ThreadTime and the processes' CPU time grow with it as well.
 */
const SPEED_ITERATIONS = 2_000_000;
const SPEED_ROUNDS = 5;
/** repetitions of one run may differ by this factor, and a run from SPEED_REF_MS */
const SPEED_TOLERANCE = 1.15;
/**
 * % of the processor time this system wanted that the host may take during a sample (median over
 * the samples) before the result is not final. The single thread of the speed probe hardly shows a
 * busy host; a sample keeps several threads busy (raster workers, the compositor, the GPU process)
 * and does: measured at 18 to 43 % stolen, the script time of a mouse move was 1.55 times that of a
 * run on the quiet machine while the speed probe was 10 % slower.
 */
const STOLEN_LIMIT_PCT = 10;
function fixedWork(): number {
  let value = 0;
  for (let index = 0; index < SPEED_ITERATIONS; index++) value += Math.sqrt(index ^ (value & 1023));
  return value;
}
/** ms the fixed work takes: the median and the slowest of SPEED_ROUNDS */
function speed(): { ms: number; slowestMs: number } {
  const times: number[] = [];
  for (let round = 0; round < SPEED_ROUNDS; round++) {
    const start = performance.now();
    fixedWork();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { ms: times[Math.floor(times.length / 2)] ?? Number.NaN, slowestMs: times.at(-1) ?? Number.NaN };
}
/**
 * Processor time of the whole system so far, in ticks: what its tasks wanted (ran or were kept from
 * running by the host) and what the host took (steal). null where /proc/stat is missing.
 */
function processorTime(): { wanted: number; stolen: number } | null {
  try {
    const fields = (readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "").trim().split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal
    const [user = 0, nice = 0, system = 0, , , irq = 0, softirq = 0, steal = 0] = fields;
    return { wanted: user + nice + system + irq + softirq + steal, stolen: steal };
  } catch {
    return null;
  }
}
// the optimizing compiler has the loop before the first sample is timed
for (let round = 0; round < 20; round++) fixedWork();

// ── settings ─────────────────────────────────────────────────────────────────

const setting = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
};
const list = <T extends string>(name: string, all: readonly T[]): T[] => {
  const wanted = (setting(name) ?? "").split(",").filter(Boolean);
  return wanted.length === 0 ? [...all] : all.filter((one) => wanted.includes(one));
};
const numbers = (name: string, fallback: readonly number[]): number[] => {
  const given = (setting(name) ?? "")
    .split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return given.length === 0 ? [...fallback] : given;
};
const single = (name: string, fallback: number): number => numbers(name, [fallback])[0] ?? fallback;

const CASE_NAMES = ["mount", "memory", "arming", "frames", "pointer", "board", "idle"] as const;
type CaseName = (typeof CASE_NAMES)[number];
const DEFAULT_MOVES = 200;
const DEFAULT_IDLE_MS = 10_000;

const strategies = list("STRATEGIES", STRATEGIES);
const cases = list("CASES", CASE_NAMES);
const REPEAT = Math.round(single("REPEAT", 5));
/** repetitions a result should have: with fewer the title says how many */
const FULL_REPEAT = 5;
/** minutes the repetitions may take, 0: no limit */
const BUDGET_MIN = single("BUDGET_MIN", 0);
const COUNTS = numbers("COUNTS", [1, 5, 10, 20]);
const FRAME_COUNTS = numbers("FRAME_COUNTS", [10, 20]);
const POINTER_COUNTS = numbers("POINTER_COUNTS", [1, 20]);
const BOARD_COUNT = Math.round(single("BOARD_COUNT", 10));
const MOVES = Math.round(single("MOVES", DEFAULT_MOVES));
const IDLE_MS = Math.round(single("IDLE_MS", DEFAULT_IDLE_MS));
const DPR = single("DPR", 1);
const FORCE = setting("FORCE") === "1";
const WAIT_QUIET_MIN = single("WAIT_QUIET", 0);
/** ms of the speed probe's fixed work on the quiet machine, 0: not given */
const SPEED_REF_MS = single("SPEED_REF_MS", 0);

/** the window lib.ts opens by default */
const WINDOW = { width: 2200, height: 1300 };
const OPEN = { dpr: DPR } as const;
/**
 * The first viewport of every board but M5's: 20 stress nodes (five columns of 640 x 420 flow
 * units, 80 apart) lie in the canvas as a whole at this zoom, beside the open Files panel. Of 30
 * (six columns, measured: canvas 1860 px wide) the sixth column shows 20 px and the fifth row
 * lacks 10 px; M1 and M2 read the DOM and the heap, which a node outside the window has as well.
 */
const VIEW = { zoom: 0.5, x: 40, y: 100 } as const;
/** M5: the board zoom the task names, and where the armed node's corner sits */
const POINTER_VIEW = { zoom: 0.73, x: 60, y: 80 } as const;
/** the node that is armed, and the one that is dragged beside it (second row, second column of a board of 10) */
const ARMED_NODE = "s-0";
const OTHER_NODE = "s-5";
/** a stress node and the gap to the next, flow units (samples.ts: stress) */
const STRESS = { width: 640, height: 420, gap: 80 };
/**
 * Elements of the order-to-cash process a drag may take, in order of preference. The first is in
 * the middle of the canvas in every strategy: the pointer's loop stays more than 20 px inside the
 * canvas (diagram-js scrolls the canvas when the pointer comes that near to its edge).
 */
const DRAG_CANDIDATES = ["Task_reject_order", "CallActivity_invoice_handling", "Task_validate_order"];
/** px of the lead that passes the drag threshold, radius of the pointer's loop, and where the drag ends: screen px */
const LEAD = 8;
const RADIUS = 30;
const DRAG_END = { x: 24, y: 16 };
/** M4: moves of the pane drag (one per frame at 60 Hz: 2 s), wheel steps (ten out, ten in) and their delta */
const PAN_MOVES = 120;
const WHEEL_STEPS = 20;
const WHEEL_DELTA = 50;
/** rest after ready before memory is read, ms */
const MEMORY_SETTLE_MS = 1500;
/** M2's controls: frames (or isolated worlds) added to a board with one in-page editor */
const CONTROL_FRAMES = 20;
/** no sample takes longer */
const SAMPLE_TIMEOUT_MS = 180_000;

// ── samples ──────────────────────────────────────────────────────────────────

type Metric = "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7";
type Values = Record<string, number | null>;

interface Sample {
  metric: Metric;
  /** what was measured, without the strategy: "stress-10 cold", "pan 20 armed" */
  variant: string;
  strategy: Strategy;
  /** 0 based */
  repeat: number;
  status: "ok" | "failed";
  /** why it failed */
  error?: string;
  /** null: could not be read here */
  values: Values;
  /** what is no number: the element dragged, the files a page loaded, the frame intervals */
  detail?: Record<string, unknown>;
  /** console errors, page errors, navigations and lines of the page's own log */
  problems: string[];
  /** 1 minute load average when the sample began */
  load1: number;
  /** ms a fixed amount of work took in this process right before the sample: the machine's speed */
  speedMs: number;
  /** the slowest of the probe's rounds */
  speedSlowestMs: number;
  /** processor time the host took from this system during the sample, % of what its tasks wanted; null: not readable */
  stolenPct: number | null;
  /** wall time of the sample with opening and closing the page */
  ms: number;
}

interface Ctx {
  harness: Harness;
  /** a DevTools session of the browser itself: its processes */
  system: CDPSession;
  strategy: Strategy;
  repeat: number;
  /** a board the sample opened: its problems are collected and its context closed afterwards */
  keep(board: Board): Board;
  emit(variant: string, values: Values, detail?: Record<string, unknown>): void;
  problems: string[];
}

interface Job {
  metric: Metric;
  /** the variants it emits, one sample each */
  variants: readonly string[];
  /** a job that does not concern every strategy */
  only?(strategy: Strategy): boolean;
  run(ctx: Ctx): Promise<void>;
}

// ── numbers ──────────────────────────────────────────────────────────────────

/** linear interpolation between the two nearest ranks */
function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const at = (sorted.length - 1) * q;
  const [low, high] = [Math.floor(at), Math.ceil(at)];
  return (sorted[low] ?? Number.NaN) + ((sorted[high] ?? Number.NaN) - (sorted[low] ?? Number.NaN)) * (at - low);
}

/** least squares slope of y over x; null with fewer than two different x */
function slopeOf(points: ReadonlyArray<readonly [number, number]>): number | null {
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  const spread = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
  if (points.length < 2 || spread === 0) return null;
  return points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0) / spread;
}

const diff = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a === null || a === undefined || b === null || b === undefined ? null : b - a;
const perUnit = (value: number | null, units: number, factor = 1): number | null =>
  value === null || units <= 0 ? null : (value * factor) / units;
const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: no end within ${ms / 1000} s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ── the browser's processes ──────────────────────────────────────────────────

interface Proc {
  type: string;
  pid: number;
  /** CPU seconds of all its threads since it started */
  cpuS: number;
  rssMB: number | null;
  /** anonymous resident memory: heaps and malloc */
  anonMB: number | null;
  /** resident shared memory: in software raster the tiles a renderer shares with the GPU process */
  shmemMB: number | null;
  /** proportional set size: shared pages divided among their users, so the figures of processes add up */
  pssMB: number | null;
  /** pages no other process maps */
  privateMB: number | null;
}

const megabytes = (text: string, name: string): number | null => {
  const match = new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text);
  return match ? Number(match[1]) / 1024 : null;
};

function readProc(pid: number): Pick<Proc, "rssMB" | "anonMB" | "shmemMB" | "pssMB" | "privateMB"> {
  let status = "";
  let rollup = "";
  try {
    status = readFileSync(`/proc/${pid}/status`, "utf8");
  } catch {
    // the process is gone, or this is no Linux: the figures stay null
  }
  try {
    rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
  } catch {
    // not readable for this user: the figures stay null
  }
  const [clean, dirty] = [megabytes(rollup, "Private_Clean"), megabytes(rollup, "Private_Dirty")];
  return {
    rssMB: megabytes(status, "VmRSS"),
    anonMB: megabytes(status, "RssAnon"),
    shmemMB: megabytes(status, "RssShmem"),
    pssMB: megabytes(rollup, "Pss"),
    privateMB: clean === null || dirty === null ? null : clean + dirty,
  };
}

/** every process of the browser (SystemInfo.getProcessInfo), with its memory from /proc when asked */
async function processes(system: CDPSession, memory: boolean): Promise<Proc[]> {
  const { processInfo } = await system.send("SystemInfo.getProcessInfo");
  return processInfo.map((one) => ({
    type: one.type,
    pid: one.id,
    cpuS: one.cpuTime,
    ...(memory ? readProc(one.id) : { rssMB: null, anonMB: null, shmemMB: null, pssMB: null, privateMB: null }),
  }));
}

interface Cpu {
  renderer: number;
  gpu: number;
  all: number;
}
/** CPU seconds so far: of the renderers (one page is open, so that is the page's), of the GPU process, of all */
async function cpuOf(system: CDPSession): Promise<Cpu> {
  const all = await processes(system, false);
  const sum = (keep: (proc: Proc) => boolean): number => all.filter(keep).reduce((total, proc) => total + proc.cpuS, 0);
  return {
    renderer: sum((proc) => proc.type === "renderer"),
    gpu: sum((proc) => proc.type === "GPU"),
    all: sum(() => true),
  };
}
const cpuBetween = (a: Cpu, b: Cpu): { rendererCpuMs: number; gpuCpuMs: number; allCpuMs: number } => ({
  rendererCpuMs: (b.renderer - a.renderer) * 1000,
  gpuCpuMs: (b.gpu - a.gpu) * 1000,
  allCpuMs: (b.all - a.all) * 1000,
});

// ── main thread time between two readings of CDP Performance.getMetrics ──────

type Metrics = Record<string, number>;
interface Work {
  /** between the two readings, by the browser's clock */
  wallMs: number;
  /**
   * Wall time of all tasks of the main thread: script, style, layout, paint, input, and the commit,
   * during which the main thread WAITS for the compositor thread. On a loaded machine it grows with
   * every preemption (measured in the rehearsal at load 40: two to four times threadMs)
   */
  taskMs: number;
  scriptMs: number;
  layoutMs: number;
  styleMs: number;
  /**
   * DevTools commands on the main thread in that time, part of taskMs: the readings themselves. A
   * script run by Runtime.evaluate counts here and NOT as scriptMs (measured), so nothing is
   * evaluated between two readings
   */
  devtoolsMs: number;
  /**
   * CPU time of the main thread: what it worked, without what it waited. The metric ProcessTime is
   * not read: it is 0 at every reading in the sandboxed renderer (measured); the processes' CPU
   * time comes from SystemInfo.getProcessInfo instead (cpuOf)
   */
  threadMs: number;
  layouts: number;
  styles: number;
}
function workBetween(a: Metrics, b: Metrics): Work {
  const seconds = (name: string): number => ((b[name] ?? 0) - (a[name] ?? 0)) * 1000;
  const count = (name: string): number => (b[name] ?? 0) - (a[name] ?? 0);
  return {
    wallMs: seconds("Timestamp"),
    taskMs: seconds("TaskDuration"),
    scriptMs: seconds("ScriptDuration"),
    layoutMs: seconds("LayoutDuration"),
    styleMs: seconds("RecalcStyleDuration"),
    devtoolsMs: seconds("DevToolsCommandDuration"),
    threadMs: seconds("ThreadTime"),
    layouts: count("LayoutCount"),
    styles: count("RecalcStyleCount"),
  };
}

// ── what runs in the page ────────────────────────────────────────────────────
// Every function below crosses to the page as text: it sees its argument and that document, nothing
// of this file. The property names are the contract's (shared.ts: HOOKS_KEY, EMBED_KEY, NATIVE_KEY).

interface MountProbe {
  /** performance.timeOrigin of this document: places its times on another document's clock */
  origin: number;
  /** ms since this document's navigation start; null: not seen */
  ready: number | null;
  rendered: number | null;
  /** how often the probe looked */
  polls: number;
}
interface ViewStats {
  writes: number;
  inLine: number;
  held: number;
  userChanges: number;
}
type CostWindow = Window & {
  __boardSpikeNative?: NativeGeometry;
  __boardSpike?: {
    ready: boolean;
    nodes(): Array<{ type: string }>;
    arm(nodeId: string | null): Promise<void>;
    engine(nodeId: string): { host?: HTMLElement; controller?: { stats(): ViewStats } | null } | undefined;
  };
  __boardSpikeEmbed?: { ready: boolean; armed: boolean };
  __cost?: MountProbe;
  __costFrames?: FrameRecord;
  __costWatch?: { done: Promise<Watched> };
};

/**
 * M1, as an init script in the page and in every frame, before their own scripts: notes when the
 * page reports ready and when every editor shows its first element. A timer and no observer: an
 * observer on the editors' DOM would run for every element an import draws. The same test in every
 * strategy (embed-main.ts, RENDERED): a `.djs-visual` of an element, or one of dmn-js's HTML views.
 */
const MOUNT_PROBE = (): void => {
  const page = window as CostWindow;
  if (page.__cost) return;
  const RENDERED = "[data-element-id] > .djs-visual, .dmn-decision-table-container table, .dmn-literal-expression";
  const probe: MountProbe = { origin: performance.timeOrigin, ready: null, rendered: null, polls: 0 };
  page.__cost = probe;
  // the default buffer holds 250 entries; a dev server answers one request per module
  performance.setResourceTimingBufferSize(5000);
  const shown = new WeakSet<Element>();
  const timer = setInterval(() => {
    const now = performance.now();
    probe.polls++;
    const embed = page.__boardSpikeEmbed;
    const hooks = page.__boardSpike;
    if (embed) {
      if (probe.rendered === null && document.querySelector(".board-embed__host")?.querySelector(RENDERED)) {
        probe.rendered = now;
      }
      if (probe.ready === null && embed.ready) probe.ready = now;
    } else if (hooks) {
      if (probe.rendered === null) {
        let count = 0;
        for (const host of document.querySelectorAll(".board-engine")) {
          if (!shown.has(host) && host.querySelector(RENDERED)) shown.add(host);
          if (shown.has(host)) count++;
        }
        const models = hooks.nodes().filter((node) => node.type === "model").length;
        if (models > 0 && count >= models) probe.rendered = now;
      }
      if (probe.ready === null && hooks.ready) probe.ready = now;
    }
    // done; in the iframe strategy the top page never has an editor of its own. Never left running
    const over = probe.ready !== null && (probe.rendered !== null || now - probe.ready > 3000);
    if (over || now > 120_000) clearInterval(timer);
  }, 4);
};

const READ_PROBE = (): MountProbe | null => (window as CostWindow).__cost ?? null;

interface Loaded {
  name: string;
  /** bytes over the wire with headers; 0 for a file from the cache */
  transfer: number;
  /** body as it was sent (compressed) and as the page got it */
  encoded: number;
  decoded: number;
}
interface MountReading {
  probe: MountProbe | null;
  origin: number;
  domContentLoaded: number | null;
  loadEvent: number | null;
  firstContentfulPaint: number | null;
  document: Loaded | null;
  resources: Loaded[];
}
const READ_MOUNT = (): MountReading => {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const paint = performance.getEntriesByType("paint").find((entry) => entry.name === "first-contentful-paint");
  const loaded = (entry: PerformanceResourceTiming): Loaded => ({
    name: entry.name.replace(location.origin, ""),
    transfer: entry.transferSize,
    encoded: entry.encodedBodySize,
    decoded: entry.decodedBodySize,
  });
  return {
    probe: (window as CostWindow).__cost ?? null,
    origin: performance.timeOrigin,
    domContentLoaded: navigation ? navigation.domContentLoadedEventEnd : null,
    loadEvent: navigation && navigation.loadEventEnd > 0 ? navigation.loadEventEnd : null,
    firstContentfulPaint: paint ? paint.startTime : null,
    document: navigation ? loaded(navigation) : null,
    resources: (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).map(loaded),
  };
};

interface FrameRecord {
  /** performance.now() at the start of every animation frame callback */
  frames: number[];
  /** the frame time the browser handed that callback */
  stamps: number[];
  /** performance.now() of every pointermove and wheel the top document saw */
  events: number[];
  on: boolean;
}
/** M4: an animation frame loop in the top page, and when the gesture's events arrived */
const RECORD_FRAMES = (): void => {
  const record: FrameRecord = { frames: [], stamps: [], events: [], on: true };
  (window as CostWindow).__costFrames = record;
  const loop = (stamp: number): void => {
    if (!record.on) return;
    record.frames.push(performance.now());
    record.stamps.push(stamp);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const seen = (): void => void (record.on && record.events.push(performance.now()));
  for (const type of ["pointermove", "wheel"]) window.addEventListener(type, seen, { capture: true, passive: true });
};
const STOP_FRAMES = (): FrameRecord | null => {
  const record = (window as CostWindow).__costFrames ?? null;
  if (record) record.on = false;
  return record;
};

interface Watched {
  /** timeStamp of the click that armed or disarmed: when the browser got the input */
  click: number | null;
  /** performance.now() when its listener ran */
  clickSeen: number | null;
  /** the node shows the wanted state (`data-armed`) */
  flag: number | null;
  /** the editor takes (or no longer takes) what arrives at the middle of the node body */
  input: number | null;
  /** the main thread finished the frame that shows it */
  frameDone: number | null;
  timedOut: boolean;
}
/**
 * M3: installs a watch and returns at once; `__costWatch.done` resolves with the times. "Takes
 * input" is read from the page as a pointer would find it: the topmost element at the middle of
 * the node body belongs to the editor's host (in-page), or is the node's frame AND the page in
 * that frame says it is armed (iframe). Looked at when an attribute that carries the state changes
 * and every 4 ms; the hit test forces a layout, at most once per look and only after the flag.
 */
const WATCH_ARMING = (wanted: { node: string; armed: boolean; at: Point; frame: string | null }): void => {
  const page = window as CostWindow;
  const native = page.__boardSpikeNative;
  const wrapper = document.querySelector(`.react-flow__node[data-id="${CSS.escape(wanted.node)}"]`);
  const shell = wrapper?.querySelector<HTMLElement>(".board-node");
  const frame = wanted.frame
    ? document.querySelector<HTMLIFrameElement>(`iframe[name="${CSS.escape(wanted.frame)}"]`)
    : null;
  const result: Watched = { click: null, clickSeen: null, flag: null, input: null, frameDone: null, timedOut: false };
  const inFrame = (): boolean | undefined =>
    (frame?.contentWindow as CostWindow | null | undefined)?.__boardSpikeEmbed?.armed;
  const takesInput = (): boolean => {
    const top = native
      ? native.elementFromPoint(document, wanted.at.x, wanted.at.y)
      : document.elementFromPoint(wanted.at.x, wanted.at.y);
    if (frame) return top === frame && inFrame() === true;
    const host = page.__boardSpike?.engine(wanted.node)?.host;
    return !!host && !!top && host.contains(top);
  };
  let finish!: (value: Watched) => void;
  const done = new Promise<Watched>((resolve) => (finish = resolve));
  const stop = (): void => {
    observer.disconnect();
    clearInterval(timer);
    clearTimeout(limit);
    window.removeEventListener("click", onClick, true);
    finish(result);
  };
  const look = (): void => {
    if (result.click === null || result.input !== null) return;
    if (result.flag === null && (shell?.dataset.armed === "true") === wanted.armed) result.flag = performance.now();
    if (result.flag === null || (frame && inFrame() !== wanted.armed)) return;
    if (takesInput() !== wanted.armed) return;
    result.input = performance.now();
    // the frame that shows the state, and one task after its rendering: the main thread is through with it
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        result.frameDone = performance.now();
        channel.port1.close();
        stop();
      };
      channel.port2.postMessage(0);
    });
  };
  const observer = new MutationObserver(look);
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-armed", "inert", "data-layout"],
  });
  const timer = setInterval(look, 4);
  const onClick = (event: MouseEvent): void => {
    if (result.click !== null) return;
    result.click = event.timeStamp;
    result.clickSeen = performance.now();
  };
  window.addEventListener("click", onClick, true);
  const limit = setTimeout(() => {
    result.timedOut = true;
    stop();
  }, 8000);
  page.__costWatch = { done };
};
const WATCHED = (): Promise<Watched> | null => (window as CostWindow).__costWatch?.done ?? null;

/** ms `hooks.arm` takes to resolve: it waits for the node to show the state, one frame, and the surface's whenInteractive */
const HOOK_ARM = async (nodeId: string | null): Promise<number> => {
  const start = performance.now();
  await (window as CostWindow).__boardSpike!.arm(nodeId);
  return performance.now() - start;
};

/** the view controller's counters of an in-page editor (viewbox writes); null for a frame */
const VIEW_STATS = (nodeId: string): ViewStats | null =>
  (window as CostWindow).__boardSpike?.engine(nodeId)?.controller?.stats() ?? null;

/** what the top document has at a point: "pane", else the id of the node whose header (not a button) it is, else "" */
const AT_POINT = (at: Point): string => {
  const native = (window as CostWindow).__boardSpikeNative;
  const top = native ? native.elementFromPoint(document, at.x, at.y) : document.elementFromPoint(at.x, at.y);
  if (!top) return "";
  if (top.classList.contains("react-flow__pane")) return "pane";
  if (top.closest("button") || !top.closest(".board-node__header")) return "";
  return top.closest(".react-flow__node")?.getAttribute("data-id") ?? "";
};

/** the Edit / Done button of a node, as a screen box */
const ARM_BUTTON = (nodeId: string): Box | null => {
  const button = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"] .board-node__arm`);
  if (!button) return null;
  const native = (window as CostWindow).__boardSpikeNative;
  const { x, y, width, height } = native ? native.rect(button) : button.getBoundingClientRect();
  return { x, y, width, height };
};

/** M2's control: `count` frames of the node body's size, out of sight; resolves when all have loaded */
const ADD_FRAMES = (wanted: { count: number; src: string }): Promise<void> =>
  new Promise((resolve) => {
    const holder = document.createElement("div");
    holder.style.cssText =
      "position:fixed;left:0;bottom:0;width:8px;height:8px;overflow:hidden;opacity:0;pointer-events:none";
    let left = wanted.count;
    for (let index = 0; index < wanted.count; index++) {
      const frame = document.createElement("iframe");
      // a name each: lib.ts counts the loads of an embed frame by its name
      frame.name = `cost-control-${index}`;
      frame.style.cssText = "width:640px;height:388px;border:0";
      frame.addEventListener("load", () => void (--left === 0 && resolve()), { once: true });
      frame.src = wanted.src;
      holder.append(frame);
    }
    document.body.append(holder);
  });

// ── helpers on a board ───────────────────────────────────────────────────────

const stress = (
  strategy: Strategy,
  count: number,
  view: { zoom: number; x: number; y: number } = VIEW,
): BoardQuery => ({
  board: "stress",
  strategy,
  notation: "bpmn",
  count,
  ...view,
});

/** what harness.open checks, for a page this script opened itself (M1's second load in the same context) */
async function expectBoard(board: Board): Promise<void> {
  const mark = await board.page.evaluate(
    (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content"),
    PAGE_MARK,
  );
  if (mark !== "board") throw new Error(`${board.url} is not the board page (mark: ${String(mark)})`);
  await board.waitReady();
  const failed = (await board.nodes()).filter((node) => node.type === "model" && !node.mounted);
  if (failed.length > 0) throw new Error(`not mounted: ${failed.map((node) => node.id).join(", ")}`);
}

async function arm(board: Board, nodeId: string): Promise<void> {
  await board.arm(nodeId);
  // the chrome pops in over 150 ms, the view of a counter or overlay editor is applied in a timer
  await sleep(600);
  const armed = (await board.nodes()).find((node) => node.id === nodeId)?.armed;
  if (!armed) throw new Error(`${nodeId} is not armed after arm()`);
}

/**
 * A point of the bare pane: where the gaps between the first two columns and the first two rows of
 * the stress grid cross (the same point in every strategy and on every board of three nodes or
 * more), else any free point lib.ts finds.
 */
async function panePoint(board: Board, view: { zoom: number; x: number; y: number }): Promise<Point> {
  const cross = {
    x: Math.round(view.x + (STRESS.width + STRESS.gap / 2) * view.zoom),
    y: Math.round(view.y + (STRESS.height + STRESS.gap / 2) * view.zoom),
  };
  if ((await board.page.evaluate(AT_POINT, cross)) === "pane") return cross;
  const free = await board.freePanePoint();
  if (!free) throw new Error("no point of the bare pane");
  return free;
}

/**
 * Mouse events for the measured gestures, sent as CDP Input.dispatchMouseEvent on the page's own
 * session: trusted input through the browser's input pipeline, the command page.mouse sends too.
 * NOT page.mouse: with a button down Playwright wraps every move in its drag interception, which
 * evaluates a script in EVERY frame of the page before the move and another one after it
 * (playwright-core, crDragDrop.ts, interceptDragCausedByMove). Measured in the rehearsal of this
 * script: 2 to 9 ms of DevTools commands per move on the main thread, more with every frame of the
 * page, and 25 to 59 ms per move instead of one frame. That is a cost of the tool, and it would be
 * charged to the iframe strategy. The command resolves when the page has handled the event, which
 * Chromium does once per frame for moves and wheels: the input is closed loop.
 */
interface Pointer {
  press(at: Point): Promise<void>;
  move(at: Point): Promise<void>;
  release(at: Point): Promise<void>;
  wheel(at: Point, deltaY: number): Promise<void>;
}
async function pointerOf(board: Board): Promise<Pointer> {
  const session = await board.cdp();
  let down = false;
  const send = async (type: "mousePressed" | "mouseReleased" | "mouseMoved", at: Point): Promise<void> => {
    board.assertStable();
    await session.send("Input.dispatchMouseEvent", {
      type,
      x: at.x,
      y: at.y,
      button: type === "mouseMoved" && !down ? "none" : "left",
      // the buttons that are down AFTER the event
      buttons: down ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  };
  return {
    async press(at) {
      down = true;
      await send("mousePressed", at);
    },
    move: (at) => send("mouseMoved", at),
    async release(at) {
      down = false;
      // `button` names the one that went up
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: at.x,
        y: at.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    },
    async wheel(at, deltaY) {
      board.assertStable();
      await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY });
    },
  };
}

/**
 * The pointer's way in a drag of M5 and M6: two loops of a circle that begins at `start`, then one
 * move to `start + DRAG_END`. Every move differs from the one before by about 4 pi RADIUS / moves px.
 */
function loopPath(start: Point, moves: number): Point[] {
  const points: Point[] = [];
  for (let step = 1; step < moves; step++) {
    const angle = (4 * Math.PI * step) / moves;
    points.push({ x: start.x + RADIUS * (1 - Math.cos(angle)), y: start.y + RADIUS * Math.sin(angle) });
  }
  points.push({ x: start.x + DRAG_END.x, y: start.y + DRAG_END.y });
  return points;
}

/** main thread and process time per move, in micro seconds, from the readings around the moves */
function perMove(work: Work, cpu: ReturnType<typeof cpuBetween>, moves: number, wallMs: number): Values {
  return {
    moves,
    taskUsPerMove: perUnit(work.taskMs, moves, 1000),
    scriptUsPerMove: perUnit(work.scriptMs, moves, 1000),
    layoutUsPerMove: perUnit(work.layoutMs, moves, 1000),
    styleUsPerMove: perUnit(work.styleMs, moves, 1000),
    layoutsPerMove: perUnit(work.layouts, moves),
    stylesPerMove: perUnit(work.styles, moves),
    threadUsPerMove: perUnit(work.threadMs, moves, 1000),
    rendererCpuUsPerMove: perUnit(cpu.rendererCpuMs, moves, 1000),
    gpuCpuUsPerMove: perUnit(cpu.gpuCpuMs, moves, 1000),
    wallMsPerMove: perUnit(wallMs, moves),
    taskMs: work.taskMs,
    scriptMs: work.scriptMs,
    layoutMs: work.layoutMs,
    styleMs: work.styleMs,
    devtoolsMs: work.devtoolsMs,
  };
}

// ── M1 mount ─────────────────────────────────────────────────────────────────

const kind = (name: string): "js" | "css" | "font" | "other" => {
  const path = (name.split("?")[0] ?? "").toLowerCase();
  if (/\.(m?js|jsx|tsx?)$/.test(path)) return "js";
  if (path.endsWith(".css")) return "css";
  if (/\.(woff2?|ttf|otf|eot)$/.test(path)) return "font";
  return "other";
};

async function readMount(board: Board, strategy: Strategy): Promise<{ values: Values; files: unknown }> {
  const embedFrames = () =>
    board.page.frames().filter((frame) => frame !== board.page.mainFrame() && frame.url().includes(EMBED_PAGE));
  const seen = await board.waitFor(
    async () => {
      const top = await board.page.evaluate(READ_PROBE);
      if (!top || top.ready === null) return false;
      if (strategy !== "iframe") return top.rendered !== null;
      const inner = await Promise.all(embedFrames().map((frame) => frame.evaluate(READ_PROBE)));
      return inner.length > 0 && inner.every((one) => one !== null && one.rendered !== null && one.ready !== null);
    },
    5000,
    50,
  );
  if (!seen) throw new Error("the mount probe did not see every editor's first element within 5 s after ready");
  const top = await board.page.evaluate(READ_MOUNT);
  const inner =
    strategy === "iframe" ? await Promise.all(embedFrames().map((frame) => frame.evaluate(READ_MOUNT))) : [];
  /** a time of another document on the top page's clock */
  const onTop = (reading: MountReading, value: number | null | undefined): number =>
    value === null || value === undefined ? Number.NaN : reading.origin + value - top.origin;
  const latest = (values: number[]): number | null => (values.length === 0 ? null : Math.max(...values));

  const sizes = (reading: MountReading) => {
    const all = [...(reading.document ? [reading.document] : []), ...reading.resources];
    const of = (wanted: ReturnType<typeof kind>): Loaded[] => all.filter((one) => kind(one.name) === wanted);
    const sum = (some: Loaded[], field: "transfer" | "encoded" | "decoded"): number =>
      some.reduce((total, one) => total + one[field], 0) / 1024;
    return {
      requests: all.length,
      // a cached file reports no transfer and still its body
      cached: all.filter((one) => one.transfer === 0 && one.decoded > 0).length,
      transferKB: sum(all, "transfer"),
      decodedKB: sum(all, "decoded"),
      jsFiles: of("js").length,
      jsEncodedKB: sum(of("js"), "encoded"),
      jsDecodedKB: sum(of("js"), "decoded"),
      cssFiles: of("css").length,
      cssEncodedKB: sum(of("css"), "encoded"),
      cssDecodedKB: sum(of("css"), "decoded"),
    };
  };
  const page = sizes(top);
  const frames = inner.map(sizes);
  const mean = (field: keyof ReturnType<typeof sizes>): number | null =>
    frames.length === 0 ? null : frames.reduce((total, one) => total + one[field], 0) / frames.length;
  const values: Values = {
    // the comparable figure: the same test of the DOM in every strategy
    renderedMs:
      strategy === "iframe"
        ? latest(inner.map((one) => onTop(one, one.probe?.rendered)))
        : (top.probe?.rendered ?? null),
    // as the board reports it; a frame adds a rest of 100 ms of unchanged DOM (embed-main.ts, SETTLE_MS)
    readyMs: top.probe?.ready ?? null,
    frameReadyMs: strategy === "iframe" ? latest(inner.map((one) => onTop(one, one.probe?.ready))) : null,
    domContentLoadedMs: top.domContentLoaded,
    loadEventMs: top.loadEvent,
    firstContentfulPaintMs: top.firstContentfulPaint,
    probePolls: top.probe?.polls ?? null,
    requests: page.requests + frames.reduce((total, one) => total + one.requests, 0),
    cachedRequests: page.cached + frames.reduce((total, one) => total + one.cached, 0),
    transferKB: page.transferKB + frames.reduce((total, one) => total + one.transferKB, 0),
    pageRequests: page.requests,
    pageJsFiles: page.jsFiles,
    pageJsEncodedKB: page.jsEncodedKB,
    pageJsDecodedKB: page.jsDecodedKB,
    pageCssFiles: page.cssFiles,
    pageCssEncodedKB: page.cssEncodedKB,
    pageCssDecodedKB: page.cssDecodedKB,
    frames: frames.length,
    frameRequests: mean("requests"),
    frameJsFiles: mean("jsFiles"),
    frameJsEncodedKB: mean("jsEncodedKB"),
    frameJsDecodedKB: mean("jsDecodedKB"),
    frameCssFiles: mean("cssFiles"),
    frameCssEncodedKB: mean("cssEncodedKB"),
    frameCssDecodedKB: mean("cssDecodedKB"),
  };
  const files = {
    page: [...(top.document ? [top.document] : []), ...top.resources],
    firstFrame: inner[0] ? [...(inner[0].document ? [inner[0].document] : []), ...inner[0].resources] : [],
  };
  return { values, files };
}

function mountJob(board: "stress" | "matrix", count: number): Job {
  const name = `${board}-${count}`;
  return {
    metric: "M1",
    variants: [`${name} cold`, `${name} warm`],
    async run(ctx) {
      const query: BoardQuery =
        board === "stress" ? stress(ctx.strategy, count) : { board: "matrix", strategy: ctx.strategy, ...VIEW };
      // cold: a context of its own has an empty HTTP cache and a renderer process of its own
      const cold = ctx.keep(await ctx.harness.open(query, { ...OPEN, init: MOUNT_PROBE, settle: 0 }));
      const first = await readMount(cold, ctx.strategy);
      // which files a board with ONE editor loads: once per strategy is enough
      ctx.emit(`${name} cold`, first.values, ctx.repeat === 0 && count === 1 ? { files: first.files } : undefined);
      ctx.problems.push(...(await cold.problems()));
      // warm: the same URL in a new page of the SAME context (its HTTP cache is filled), the first page closed
      const context = cold.page.context();
      await cold.page.close();
      const page = await context.newPage();
      const warm = ctx.keep(new Board(page, cold.url));
      await page.goto(cold.url);
      await expectBoard(warm);
      const second = await readMount(warm, ctx.strategy);
      ctx.emit(`${name} warm`, second.values);
    },
  };
}

// ── M2 memory ────────────────────────────────────────────────────────────────

async function memoryOf(ctx: Ctx, board: Board): Promise<Values> {
  // twice: what the first collection frees (wrappers, finalizers) is collected by the second
  await board.collectGarbage();
  await sleep(300);
  await board.collectGarbage();
  await sleep(200);
  const metrics = await board.metrics();
  const heap = await (await board.cdp()).send("Runtime.getHeapUsage");
  const all = await processes(ctx.system, true);
  // a frame in a process of its own would be a target of its own, and its heap not in the page's
  const { targetInfos } = await ctx.system.send("Target.getTargets");
  const renderers = all.filter((proc) => proc.type === "renderer").sort((a, b) => (b.rssMB ?? 0) - (a.rssMB ?? 0));
  // one page is open: its renderer is the largest (a spare one may wait beside it)
  const renderer = renderers[0];
  const gpu = all.find((proc) => proc.type === "GPU");
  const total = (field: "rssMB" | "pssMB"): number | null =>
    all.some((proc) => proc[field] === null) ? null : all.reduce((sum, proc) => sum + (proc[field] ?? 0), 0);
  const megabyte = 1024 * 1024;
  return {
    // V8's heap of the page's isolate. Same-origin frames live in that isolate: their realms are in it
    heapUsedMB: heap.usedSize / megabyte,
    heapTotalMB: heap.totalSize / megabyte,
    // Blink's own collected heap (DOM objects of every document of the process)
    embedderHeapMB: heap.embedderHeapUsedSize / megabyte,
    // array buffers and external strings (the Yjs documents)
    backingStoreMB: heap.backingStorageSize / megabyte,
    domNodes: metrics.Nodes ?? null,
    documents: metrics.Documents ?? null,
    listeners: metrics.JSEventListeners ?? null,
    layoutObjects: metrics.LayoutObjects ?? null,
    // V8 contexts: the main world of every frame, plus Playwright's utility world in each
    contexts: metrics.V8PerContextDatas ?? null,
    rendererRssMB: renderer?.rssMB ?? null,
    rendererAnonMB: renderer?.anonMB ?? null,
    rendererShmemMB: renderer?.shmemMB ?? null,
    rendererPssMB: renderer?.pssMB ?? null,
    rendererPrivateMB: renderer?.privateMB ?? null,
    gpuPssMB: gpu?.pssMB ?? null,
    allPssMB: total("pssMB"),
    allRssMB: total("rssMB"),
    renderers: renderers.length,
    processes: all.length,
    outOfProcessFrames: targetInfos.filter((target) => target.type === "iframe").length,
  };
}

function memoryJob(count: number): Job {
  const variant = `stress-${count}`;
  return {
    metric: "M2",
    variants: [variant],
    async run(ctx) {
      const board = ctx.keep(await ctx.harness.open(stress(ctx.strategy, count), OPEN));
      await sleep(MEMORY_SETTLE_MS);
      ctx.emit(variant, await memoryOf(ctx, board));
    },
  };
}

/**
 * What a frame costs before it holds an editor: `CONTROL_FRAMES` frames added to a board with one
 * in-page editor, either empty (about:blank: a document, a window, two V8 contexts) or with the
 * embed page without parameters (plus its style sheets and its entry modules, no engine, no editor).
 * And what the TOOL adds to every frame: `CONTROL_FRAMES` isolated worlds created in the main frame
 * the way Playwright creates its utility world in every frame (Page.createIsolatedWorld; an empty
 * script in that world on every new document). A person's browser has no such world, so this
 * figure is what the iframe strategy's memory per frame is too high by under this harness.
 * Each runs once per repetition, filed under the iframe strategy.
 */
function controlJob(what: "blank" | "stub" | "world"): Job {
  const variant = `control ${what}`;
  return {
    metric: "M2",
    variants: [variant],
    only: (strategy) => strategy === "iframe",
    async run(ctx) {
      const board = ctx.keep(await ctx.harness.open(stress("naive", 1), OPEN));
      await sleep(MEMORY_SETTLE_MS);
      const before = await memoryOf(ctx, board);
      if (what === "world") {
        const session = await board.cdp();
        const { frameTree } = await session.send("Page.getFrameTree");
        for (let index = 0; index < CONTROL_FRAMES; index++) {
          await session.send("Page.createIsolatedWorld", {
            frameId: frameTree.frame.id,
            worldName: `cost-control-${index}`,
            grantUniveralAccess: true,
          });
        }
      } else {
        await board.page.evaluate(ADD_FRAMES, {
          count: CONTROL_FRAMES,
          src: what === "blank" ? "about:blank" : `/${EMBED_PAGE}`,
        });
      }
      await sleep(MEMORY_SETTLE_MS);
      const after = await memoryOf(ctx, board);
      const each = (field: string, factor = 1): number | null =>
        perUnit(diff(before[field], after[field]), CONTROL_FRAMES, factor);
      ctx.emit(variant, {
        frames: CONTROL_FRAMES,
        heapUsedKBPerFrame: each("heapUsedMB", 1024),
        embedderHeapKBPerFrame: each("embedderHeapMB", 1024),
        rendererAnonKBPerFrame: each("rendererAnonMB", 1024),
        rendererPssKBPerFrame: each("rendererPssMB", 1024),
        allPssKBPerFrame: each("allPssMB", 1024),
        domNodesPerFrame: each("domNodes"),
        documentsPerFrame: each("documents"),
        contextsPerFrame: each("contexts"),
      });
    },
  };
}

// ── M3 arming ────────────────────────────────────────────────────────────────

function armingJob(): Job {
  const variant = `stress-${BOARD_COUNT}`;
  return {
    metric: "M3",
    variants: [variant],
    async run(ctx) {
      const board = ctx.keep(await ctx.harness.open(stress(ctx.strategy, BOARD_COUNT), OPEN));
      const target = BOARD_COUNT > 5 ? OTHER_NODE : ARMED_NODE;
      const node = await board.node(target);
      const at = centre(await node.hostBox());
      const frame = node.frame ? node.frame.name() : null;
      const button = await board.page.evaluate(ARM_BUTTON, target);
      const pane = await board.freePanePoint();
      if (!button || !pane) throw new Error(`no Edit button of ${target} or no bare pane`);
      const watch = async (armed: boolean, click: Point): Promise<Watched> => {
        await board.page.evaluate(WATCH_ARMING, { node: target, armed, at, frame });
        await board.click(click);
        const watched = await board.page.evaluate(WATCHED);
        if (!watched) throw new Error("the arming watch is gone");
        if (watched.timedOut || watched.click === null) {
          throw new Error(`${target} did not ${armed ? "take" : "give up"} input within 8 s of the click`);
        }
        return watched;
      };
      const since = (watched: Watched, value: number | null): number | null => diff(watched.click, value);

      // first arming of the page, by a person's click on Edit; then a click on the bare pane
      const armed = await watch(true, centre(button));
      if (!(await node.state()).armed) throw new Error(`${target} is not armed after the click on Edit`);
      await sleep(700);
      const disarmed = await watch(false, pane);
      if ((await node.state()).armed) throw new Error(`${target} is still armed after the click on the pane`);
      await sleep(700);
      // second arming of the same node, through the hook
      const hookArm = await board.page.evaluate(HOOK_ARM, target);
      await sleep(700);
      const hookDisarm = await board.page.evaluate(HOOK_ARM, null);
      ctx.emit(variant, {
        armFlagMs: since(armed, armed.flag),
        armInputMs: since(armed, armed.input),
        armFrameDoneMs: since(armed, armed.frameDone),
        armClickDelayMs: since(armed, armed.clickSeen),
        disarmFlagMs: since(disarmed, disarmed.flag),
        disarmInputMs: since(disarmed, disarmed.input),
        disarmFrameDoneMs: since(disarmed, disarmed.frameDone),
        disarmClickDelayMs: since(disarmed, disarmed.clickSeen),
        hookArmMs: hookArm,
        hookDisarmMs: hookDisarm,
      });
    },
  };
}

// ── M4 frames while the board moves ──────────────────────────────────────────

function frameStats(record: FrameRecord): { values: Values; intervals: number[] } {
  const [first, last] = [record.events[0], record.events.at(-1)];
  if (first === undefined || last === undefined) throw new Error("the top page saw no event of the gesture");
  // through the frame that follows the last event: it carries that event's work
  const end = record.frames.find((time) => time > last) ?? last;
  const inside = record.frames
    .map((time, index) => ({ time, index }))
    .filter(({ time }) => time >= first && time <= end);
  const intervals: number[] = [];
  let skipped = 0;
  for (let at = 1; at < inside.length; at++) {
    const [before, now] = [inside[at - 1]!, inside[at]!];
    intervals.push(now.time - before.time);
    // by the browser's own frame times: a step of two frame lengths is one frame that never came
    skipped += Math.max(
      0,
      Math.round(((record.stamps[now.index] ?? 0) - (record.stamps[before.index] ?? 0)) / (1000 / 60)) - 1,
    );
  }
  if (intervals.length < 3) throw new Error(`only ${inside.length} animation frames during the gesture`);
  const share = (limit: number): number => (100 * intervals.filter((one) => one > limit).length) / intervals.length;
  return {
    values: {
      frames: intervals.length,
      events: record.events.length,
      gestureMs: end - first,
      frameMedianMs: quantile(intervals, 0.5),
      frameP95Ms: quantile(intervals, 0.95),
      frameWorstMs: Math.max(...intervals),
      over20Pct: share(20),
      over50Pct: share(50),
      skippedFrames: skipped,
    },
    intervals: intervals.map((one) => round(one, 1)),
  };
}

function framesJob(count: number, gesture: "pan" | "zoom", armed: boolean): Job {
  const variant = `${gesture} ${count} ${armed ? "armed" : "unarmed"}`;
  return {
    metric: "M4",
    variants: [variant],
    async run(ctx) {
      const board = ctx.keep(await ctx.harness.open(stress(ctx.strategy, count), OPEN));
      if (armed) await arm(board, ARMED_NODE);
      const at = await panePoint(board, VIEW);
      const pointer = await pointerOf(board);
      const [viewBefore, countersBefore] = [await board.viewport(), await board.counters()];
      const statsBefore = armed ? await board.page.evaluate(VIEW_STATS, ARMED_NODE) : null;
      await pointer.move(at);
      if (gesture === "pan") await pointer.press(at);
      await board.page.evaluate(RECORD_FRAMES);
      // some frames at rest first: the loop runs, nothing of the page's start is left
      await sleep(300);
      const cpu0 = await cpuOf(ctx.system);
      const m0 = await board.metrics();
      if (gesture === "pan") {
        // once around an ellipse and back to the start: the board follows the pointer
        for (let step = 1; step <= PAN_MOVES; step++) {
          const angle = (2 * Math.PI * step) / PAN_MOVES;
          await pointer.move({ x: at.x + 150 * (1 - Math.cos(angle)), y: at.y + 100 * Math.sin(angle) });
        }
      } else {
        // out first: every node stays in the window, the armed one too
        for (let step = 0; step < WHEEL_STEPS; step++) {
          await pointer.wheel(at, step < WHEEL_STEPS / 2 ? WHEEL_DELTA : -WHEEL_DELTA);
        }
      }
      const m1 = await board.metrics();
      const cpu1 = await cpuOf(ctx.system);
      const record = await board.page.evaluate(STOP_FRAMES);
      if (gesture === "pan") await pointer.release(at);
      if (!record) throw new Error("the frame recorder is gone");
      const { values, intervals } = frameStats(record);
      const [work, cpu] = [workBetween(m0, m1), cpuBetween(cpu0, cpu1)];
      const frames = values.frames ?? 0;
      const [viewAfter, countersAfter] = [await board.viewport(), await board.counters()];
      const ticks = countersAfter.viewportChanges - countersBefore.viewportChanges;
      const expected = gesture === "pan" ? PAN_MOVES : WHEEL_STEPS;
      if (ticks < expected / 2)
        throw new Error(`the board moved in ${ticks} ticks of ${expected}: the gesture did not arrive`);
      const statsAfter = armed ? await board.page.evaluate(VIEW_STATS, ARMED_NODE) : null;
      if (armed && !(await board.nodes()).find((node) => node.id === ARMED_NODE)?.armed) {
        throw new Error(`${ARMED_NODE} was disarmed by the gesture`);
      }
      ctx.emit(
        variant,
        {
          ...values,
          viewportTicks: ticks,
          taskMsPerFrame: perUnit(work.taskMs, frames),
          scriptMsPerFrame: perUnit(work.scriptMs, frames),
          layoutMsPerFrame: perUnit(work.layoutMs, frames),
          styleMsPerFrame: perUnit(work.styleMs, frames),
          layoutsPerFrame: perUnit(work.layouts, frames),
          threadMsPerFrame: perUnit(work.threadMs, frames),
          rendererCpuMsPerFrame: perUnit(cpu.rendererCpuMs, frames),
          gpuCpuMsPerFrame: perUnit(cpu.gpuCpuMs, frames),
          // per viewport tick: a wheel step is spread over about three frames, a pan move is one frame
          taskMsPerTick: perUnit(work.taskMs, ticks),
          threadMsPerTick: perUnit(work.threadMs, ticks),
          scriptMsPerTick: perUnit(work.scriptMs, ticks),
          layoutMsPerTick: perUnit(work.layoutMs, ticks),
          styleMsPerTick: perUnit(work.styleMs, ticks),
          taskMs: work.taskMs,
          threadMs: work.threadMs,
          scriptMs: work.scriptMs,
          layoutMs: work.layoutMs,
          styleMs: work.styleMs,
          devtoolsMs: work.devtoolsMs,
          rendererCpuMs: cpu.rendererCpuMs,
          gpuCpuMs: cpu.gpuCpuMs,
          // the armed in-page editor's viewbox writes during the gesture (counter and overlay write per zoom tick)
          viewWrites: statsBefore && statsAfter ? statsAfter.writes - statsBefore.writes : null,
          zoomBefore: viewBefore.zoom,
          zoomAfter: viewAfter.zoom,
        },
        { intervals },
      );
    },
  };
}

// ── M5 pointer work in the armed editor ──────────────────────────────────────

function pointerJob(count: number): Job {
  const variant = `stress-${count}`;
  return {
    metric: "M5",
    variants: [variant],
    async run(ctx) {
      const board = ctx.keep(await ctx.harness.open(stress(ctx.strategy, count, POINTER_VIEW), OPEN));
      await arm(board, ARMED_NODE);
      const node = await board.node(ARMED_NODE);
      const file = node.info.file;
      if (!file) throw new Error(`${ARMED_NODE} has no file`);
      const [host, map] = [await node.hostBox(), await node.map()];
      // hit-test before the press: the first candidate that takes it and leaves the loop room in the canvas
      let chosen: { element: string; box: Box; from: Point } | undefined;
      const passed: string[] = [];
      for (const element of DRAG_CANDIDATES) {
        const box = await node.elementBox(element);
        if (!box) {
          passed.push(`${element}: not drawn`);
          continue;
        }
        const from = aimAt(map, centre(box));
        const room =
          from.x + LEAD + 2 * RADIUS + 24 <= host.x + host.width &&
          from.y - RADIUS - 24 >= host.y &&
          from.y + RADIUS + 24 <= host.y + host.height;
        const hit = await node.hit(from);
        if (room && hit.reachable && hit.element === element) {
          chosen = { element, box, from };
          break;
        }
        passed.push(`${element}: ${room ? hit.what : "no room for the loop"}`);
      }
      if (!chosen) throw new Error(`no element takes the drag (${passed.join("; ")})`);
      const { from } = chosen;
      const before = await board.fileText(file);
      const pointer = await pointerOf(board);
      await pointer.move(from);
      await pointer.press(from);
      // past the drag threshold, still on the shape: the drag exists before the first measured move
      await pointer.move({ x: from.x + LEAD / 2, y: from.y });
      await pointer.move({ x: from.x + LEAD, y: from.y });
      const path = loopPath({ x: from.x + LEAD, y: from.y }, MOVES);
      const cpu0 = await cpuOf(ctx.system);
      const m0 = await board.metrics();
      const started = Date.now();
      for (const point of path) await pointer.move(point);
      const wallMs = Date.now() - started;
      const m1 = await board.metrics();
      const cpu1 = await cpuOf(ctx.system);
      await sleep(40);
      await pointer.release(path.at(-1)!);
      // the editor writes its file about 350 ms after the gesture; every other node of the board shows the same file
      const changed = (await board.waitForFileChange(file, before)) !== null;
      await sleep(1200);
      const m2 = await board.metrics();
      const after = await node.elementBox(chosen.element);
      if (!changed) throw new Error(`the drag of ${chosen.element} did not change ${file}: it did not happen`);
      if (!(await node.state()).armed) throw new Error(`${ARMED_NODE} was disarmed by the drag`);
      const tail = workBetween(m1, m2);
      ctx.emit(
        variant,
        {
          ...perMove(workBetween(m0, m1), cpuBetween(cpu0, cpu1), MOVES, wallMs),
          // the release, the command, the write to the file and its import by every other node of the board
          afterReleaseTaskMs: tail.taskMs,
          afterReleaseScriptMs: tail.scriptMs,
          movedXPx: after ? after.x - chosen.box.x : null,
          movedYPx: after ? after.y - chosen.box.y : null,
          pointerXPx: LEAD + DRAG_END.x,
          pointerYPx: DRAG_END.y,
          netScale: await node.netScale(),
        },
        { element: chosen.element, ...(passed.length > 0 ? { passed } : {}) },
      );
    },
  };
}

// ── M6 board work beside an armed editor ─────────────────────────────────────

function boardJob(armed: boolean): Job {
  const variant = armed ? "armed" : "unarmed";
  return {
    metric: "M6",
    variants: [variant],
    async run(ctx) {
      const board = ctx.keep(await ctx.harness.open(stress(ctx.strategy, BOARD_COUNT), OPEN));
      const other = BOARD_COUNT > 5 ? OTHER_NODE : `s-${BOARD_COUNT - 1}`;
      if (other === ARMED_NODE) throw new Error("a board of one node has no other node to drag");
      if (armed) await arm(board, ARMED_NODE);
      const box = await board.nodeBox(other);
      if (!box) throw new Error(`no node ${other}`);
      // the header (32 flow units high): a preview moves by a press anywhere, the header is the same place in every state
      let from: Point | undefined;
      for (const share of [0.5, 0.4, 0.6, 0.3]) {
        const point = { x: Math.round(box.x + box.width * share), y: Math.round(box.y + 16 * VIEW.zoom) };
        if ((await board.page.evaluate(AT_POINT, point)) === other) {
          from = point;
          break;
        }
      }
      if (!from) throw new Error(`no point of the header of ${other} takes a press`);
      const text = await board.boardText();
      const pointer = await pointerOf(board);
      await pointer.move(from);
      await pointer.press(from);
      await pointer.move({ x: from.x + LEAD / 2, y: from.y });
      await pointer.move({ x: from.x + LEAD, y: from.y });
      const path = loopPath({ x: from.x + LEAD, y: from.y }, MOVES);
      const cpu0 = await cpuOf(ctx.system);
      const m0 = await board.metrics();
      const started = Date.now();
      for (const point of path) await pointer.move(point);
      const wallMs = Date.now() - started;
      const m1 = await board.metrics();
      const cpu1 = await cpuOf(ctx.system);
      await sleep(40);
      await pointer.release(path.at(-1)!);
      await sleep(300);
      const after = await board.nodeBox(other);
      const moved = after ? { x: after.x - box.x, y: after.y - box.y } : null;
      if (!moved || Math.hypot(moved.x, moved.y) < 8) throw new Error(`${other} did not move: the drag did not happen`);
      if ((await board.boardText()) === text) throw new Error("the board file is unchanged after the node drag");
      if (armed && !(await board.nodes()).find((node) => node.id === ARMED_NODE)?.armed) {
        throw new Error(`${ARMED_NODE} was disarmed by the node drag`);
      }
      ctx.emit(variant, {
        ...perMove(workBetween(m0, m1), cpuBetween(cpu0, cpu1), MOVES, wallMs),
        movedXPx: moved.x,
        movedYPx: moved.y,
      });
    },
  };
}

// ── M7 idle ──────────────────────────────────────────────────────────────────

function idleJob(armed: boolean): Job {
  const variant = armed ? "armed" : "unarmed";
  return {
    metric: "M7",
    variants: [variant],
    async run(ctx) {
      const board = ctx.keep(await ctx.harness.open(stress(ctx.strategy, BOARD_COUNT), OPEN));
      if (armed) await arm(board, ARMED_NODE);
      // what arming and loading started is over: pop-in animations, the first view, held writes
      await sleep(2500);
      const cpu0 = await cpuOf(ctx.system);
      const m0 = await board.metrics();
      // nothing: no evaluate, no animation frame loop, no pointer
      await sleep(IDLE_MS);
      const m1 = await board.metrics();
      const cpu1 = await cpuOf(ctx.system);
      const [work, cpu] = [workBetween(m0, m1), cpuBetween(cpu0, cpu1)];
      const seconds = work.wallMs / 1000;
      ctx.emit(variant, {
        idleMs: work.wallMs,
        taskMsPerS: perUnit(work.taskMs, seconds),
        scriptMsPerS: perUnit(work.scriptMs, seconds),
        layoutMsPerS: perUnit(work.layoutMs + work.styleMs, seconds),
        threadMsPerS: perUnit(work.threadMs, seconds),
        rendererCpuMsPerS: perUnit(cpu.rendererCpuMs, seconds),
        gpuCpuMsPerS: perUnit(cpu.gpuCpuMs, seconds),
        layouts: work.layouts,
        styles: work.styles,
        taskMs: work.taskMs,
        scriptMs: work.scriptMs,
        devtoolsMs: work.devtoolsMs,
      });
    },
  };
}

// ── the run ──────────────────────────────────────────────────────────────────

function jobs(): Job[] {
  const all: Job[] = [];
  const has = (name: CaseName): boolean => cases.includes(name);
  if (has("mount")) all.push(...COUNTS.map((count) => mountJob("stress", count)), mountJob("matrix", 7));
  if (has("memory")) {
    all.push(...COUNTS.map((count) => memoryJob(count)), controlJob("blank"), controlJob("stub"), controlJob("world"));
  }
  if (has("arming")) all.push(armingJob());
  if (has("frames")) {
    for (const count of FRAME_COUNTS) {
      for (const gesture of ["pan", "zoom"] as const) {
        for (const armed of [false, true]) all.push(framesJob(count, gesture, armed));
      }
    }
  }
  if (has("pointer")) all.push(...POINTER_COUNTS.map((count) => pointerJob(count)));
  if (has("board")) all.push(boardJob(true), boardJob(false));
  if (has("idle")) all.push(idleJob(true), idleJob(false));
  return all;
}

async function runJob(
  job: Job,
  harness: Harness,
  system: CDPSession,
  strategy: Strategy,
  repeat: number,
): Promise<Sample[]> {
  const load = load1();
  // before the page exists: the probe measures the machine, not this sample
  const machine = speed();
  const started = Date.now();
  const processorBefore = processorTime();
  const boards: Board[] = [];
  const out: Sample[] = [];
  const problems: string[] = [];
  const ctx: Ctx = {
    harness,
    system,
    strategy,
    repeat,
    problems,
    keep: (board) => {
      boards.push(board);
      return board;
    },
    emit(variant, values, detail) {
      out.push({
        metric: job.metric,
        variant,
        strategy,
        repeat,
        status: "ok",
        values: Object.fromEntries(
          Object.entries(values).map(([name, value]) => [
            name,
            value !== null && Number.isFinite(value) ? value : null,
          ]),
        ),
        ...(detail ? { detail } : {}),
        problems: [],
        load1: load,
        speedMs: machine.ms,
        speedSlowestMs: machine.slowestMs,
        stolenPct: null,
        ms: 0,
      });
    },
  };
  let error: string | undefined;
  try {
    await withTimeout(job.run(ctx), SAMPLE_TIMEOUT_MS, `${job.metric} ${job.variants.join(", ")}`);
  } catch (thrown) {
    error = firstLine(thrown);
  }
  for (const board of boards) {
    // a page the job closed itself (M1's first load) handed its problems over before
    if (!board.page.isClosed())
      problems.push(...(await board.problems().catch((thrown: unknown) => [firstLine(thrown)])));
    else problems.push(...board.violations);
    await board.close().catch((thrown: unknown) => void problems.push(firstLine(thrown)));
  }
  for (const variant of job.variants) {
    if (out.some((sample) => sample.variant === variant)) continue;
    out.push({
      metric: job.metric,
      variant,
      strategy,
      repeat,
      status: "failed",
      error: error ?? "the job ended without this sample",
      values: {},
      problems: [],
      load1: load,
      speedMs: machine.ms,
      speedSlowestMs: machine.slowestMs,
      stolenPct: null,
      ms: 0,
    });
  }
  const processorAfter = processorTime();
  const wanted = processorBefore && processorAfter ? processorAfter.wanted - processorBefore.wanted : 0;
  for (const sample of out) {
    sample.problems = [...new Set(problems)];
    sample.ms = Date.now() - started;
    sample.stolenPct =
      processorBefore && processorAfter && wanted > 0
        ? (100 * (processorAfter.stolen - processorBefore.stolen)) / wanted
        : null;
  }
  return out;
}

// ── the tables ───────────────────────────────────────────────────────────────

interface Stat {
  n: number;
  median: number;
  min: number;
  max: number;
}
function statOf(values: readonly number[]): Stat | null {
  if (values.length === 0) return null;
  return { n: values.length, median: quantile(values, 0.5), min: Math.min(...values), max: Math.max(...values) };
}
/** "median (min to max)", the lone value of one sample, "-" for none */
function shown(stat: Stat | null, digits: number): string {
  if (!stat) return "-";
  const fixed = (value: number): string => value.toFixed(digits);
  return stat.n === 1 ? fixed(stat.median) : `${fixed(stat.median)} (${fixed(stat.min)} to ${fixed(stat.max)})`;
}

interface Column {
  title: string;
  key: string;
  digits?: number;
}

function tables(samples: readonly Sample[]): string {
  const ok = samples.filter((sample) => sample.status === "ok");
  const valuesOf = (metric: Metric, variant: string, strategy: Strategy, key: string): number[] =>
    ok
      .filter((sample) => sample.metric === metric && sample.variant === variant && sample.strategy === strategy)
      .map((sample) => sample.values[key])
      .filter((value): value is number => typeof value === "number");
  const has = (metric: Metric, variant?: string): boolean =>
    ok.some((sample) => sample.metric === metric && (variant === undefined || sample.variant === variant));
  const markdown = (head: string[], rows: string[][]): string =>
    [
      `| ${head.join(" | ")} |`,
      `| ${head.map(() => "---").join(" | ")} |`,
      ...rows.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
  /** one row per strategy, one column per value of ONE variant */
  const byStrategy = (metric: Metric, variant: string, columns: readonly Column[]): string =>
    markdown(
      ["strategy", ...columns.map((column) => column.title)],
      strategies.map((strategy) => [
        `\`${strategy}\``,
        ...columns.map((column) => shown(statOf(valuesOf(metric, variant, strategy, column.key)), column.digits ?? 1)),
      ]),
    );
  /** the slope of a value over the number of editors, one per repetition */
  const slopes = (
    metric: Metric,
    variantOf: (count: number) => string,
    strategy: Strategy,
    key: string,
  ): Stat | null => {
    const perRepeat: number[] = [];
    for (let repeat = 0; repeat < REPEAT; repeat++) {
      const points: Array<readonly [number, number]> = [];
      for (const count of COUNTS) {
        const value = ok.find(
          (sample) =>
            sample.metric === metric &&
            sample.variant === variantOf(count) &&
            sample.strategy === strategy &&
            sample.repeat === repeat,
        )?.values[key];
        if (typeof value === "number") points.push([count, value]);
      }
      const slope = slopeOf(points);
      if (slope !== null) perRepeat.push(slope);
    }
    return statOf(perRepeat);
  };
  /** one row per strategy (and per `rows` entry), one column per number of editors, the slope last */
  const overCounts = (
    metric: Metric,
    key: string,
    rows: ReadonlyArray<{
      label: string;
      variantOf(count: number): string;
      extra?: { title: string; variant: string };
    }>,
    digits: number,
    slopeTitle: string,
    slopeFactor = 1,
    slopeDigits = digits,
  ): string => {
    const extra = rows[0]?.extra;
    const head = [
      "strategy",
      ...(rows.length > 1 ? [""] : []),
      ...COUNTS.map((count) => `N = ${count}`),
      slopeTitle,
      ...(extra ? [extra.title] : []),
    ];
    const body = strategies.flatMap((strategy) =>
      rows.map((row) => {
        const slope = slopes(metric, row.variantOf, strategy, key);
        const scaled = slope && {
          n: slope.n,
          median: slope.median * slopeFactor,
          min: slope.min * slopeFactor,
          max: slope.max * slopeFactor,
        };
        return [
          `\`${strategy}\``,
          ...(rows.length > 1 ? [row.label] : []),
          ...COUNTS.map((count) => shown(statOf(valuesOf(metric, row.variantOf(count), strategy, key)), digits)),
          shown(scaled, slopeDigits),
          ...(row.extra ? [shown(statOf(valuesOf(metric, row.extra.variant, strategy, key)), digits)] : []),
        ];
      }),
    );
    return markdown(head, body);
  };

  const parts: string[] = [];
  const section = (title: string, ...body: string[]): void => void parts.push(`## ${title}`, ...body);

  if (has("M1")) {
    const rows = (["cold", "warm"] as const).map((load) => ({
      label: load,
      variantOf: (count: number) => `stress-${count} ${load}`,
      extra: { title: "mixed board (7 notations)", variant: `matrix-7 ${load}` },
    }));
    section(
      "M1 Mount",
      METHOD.M1,
      "ms from navigation start until EVERY editor shows its first element (the same test of the DOM in every strategy):",
      overCounts("M1", "renderedMs", rows, 0, "ms per further editor", 1, 1),
      "ms from navigation start until the board reports ready (`window.__boardSpike.ready`):",
      overCounts("M1", "readyMs", rows, 0, "ms per further editor", 1, 1),
    );
    if (COUNTS.includes(1)) {
      parts.push(
        "What a board with ONE BPMN editor loads, cold (requests of the page and its frames; per frame: of one embed frame):",
        byStrategy("M1", "stress-1 cold", [
          { title: "requests", key: "requests", digits: 0 },
          { title: "KB over the wire", key: "transferKB", digits: 0 },
          { title: "page: JS files", key: "pageJsFiles", digits: 0 },
          { title: "JS KB sent", key: "pageJsEncodedKB", digits: 0 },
          { title: "JS KB decoded", key: "pageJsDecodedKB", digits: 0 },
          { title: "CSS files", key: "pageCssFiles", digits: 0 },
          { title: "CSS KB sent", key: "pageCssEncodedKB", digits: 0 },
          { title: "per frame: JS files", key: "frameJsFiles", digits: 0 },
          { title: "JS KB sent", key: "frameJsEncodedKB", digits: 0 },
          { title: "JS KB decoded", key: "frameJsDecodedKB", digits: 0 },
          { title: "CSS files", key: "frameCssFiles", digits: 0 },
        ]),
      );
    }
  }

  if (has("M2")) {
    const row = [{ label: "", variantOf: (count: number) => `stress-${count}` }];
    section(
      "M2 Memory",
      METHOD.M2,
      "JS heap used, MB (V8 heap of the page's isolate, every frame's realm included):",
      overCounts("M2", "heapUsedMB", row, 1, "KB per further editor", 1024, 0),
      "Renderer process, anonymous resident memory, MB:",
      overCounts("M2", "rendererAnonMB", row, 1, "KB per further editor", 1024, 0),
      "All processes of the browser, proportional set size, MB:",
      overCounts("M2", "allPssMB", row, 1, "KB per further editor", 1024, 0),
      "DOM nodes of the process (every document):",
      overCounts("M2", "domNodes", row, 0, "nodes per further editor", 1, 0),
      "Per further editor, the other figures (least squares over N, one slope per repetition):",
      markdown(
        [
          "strategy",
          "Blink heap KB",
          "array buffers KB",
          "renderer PSS KB",
          "renderer shared memory KB",
          "listeners",
          "documents",
          "V8 contexts",
        ],
        strategies.map((strategy) => [
          `\`${strategy}\``,
          ...(
            [
              ["embedderHeapMB", 1024, 0],
              ["backingStoreMB", 1024, 0],
              ["rendererPssMB", 1024, 0],
              ["rendererShmemMB", 1024, 0],
              ["listeners", 1, 1],
              ["documents", 1, 2],
              ["contexts", 1, 2],
            ] as const
          ).map(([key, factor, digits]) => {
            const slope = slopes("M2", row[0]!.variantOf, strategy, key);
            return shown(
              slope && { n: slope.n, median: slope.median * factor, min: slope.min * factor, max: slope.max * factor },
              digits,
            );
          }),
        ]),
      ),
    );
    const controls = {
      blank: `Control: ${CONTROL_FRAMES} EMPTY frames (about:blank) added to a board with one in-page editor, per frame:`,
      stub: `Control: ${CONTROL_FRAMES} frames with the embed page WITHOUT an editor (its sheets and entry modules), per frame:`,
      world: `Control: ${CONTROL_FRAMES} isolated worlds in the main frame of a board with one in-page editor, per world. The tool's own share of every frame (Playwright's utility world), which a person's browser has not:`,
    } as const;
    for (const what of ["blank", "stub", "world"] as const) {
      if (!has("M2", `control ${what}`)) continue;
      parts.push(
        controls[what],
        markdown(
          [
            "JS heap KB",
            "Blink heap KB",
            "renderer anonymous KB",
            "renderer PSS KB",
            "all processes PSS KB",
            "DOM nodes",
            "V8 contexts",
          ],
          [
            (
              [
                ["heapUsedKBPerFrame", 0],
                ["embedderHeapKBPerFrame", 0],
                ["rendererAnonKBPerFrame", 0],
                ["rendererPssKBPerFrame", 0],
                ["allPssKBPerFrame", 0],
                ["domNodesPerFrame", 1],
                ["contextsPerFrame", 1],
              ] as const
            ).map(([key, digits]) => shown(statOf(valuesOf("M2", `control ${what}`, "iframe", key)), digits)),
          ],
        ),
      );
    }
  }

  if (has("M3")) {
    section(
      "M3 Arming and disarming",
      METHOD.M3,
      byStrategy("M3", `stress-${BOARD_COUNT}`, [
        { title: "arm: click to state shown", key: "armFlagMs" },
        { title: "click to editor takes input", key: "armInputMs" },
        { title: "click to frame done", key: "armFrameDoneMs" },
        { title: "disarm: click to state shown", key: "disarmFlagMs" },
        { title: "click to input back at the board", key: "disarmInputMs" },
        { title: "click to frame done", key: "disarmFrameDoneMs" },
        { title: "hooks.arm, second arming", key: "hookArmMs" },
        { title: "hooks.arm(null)", key: "hookDisarmMs" },
      ]),
    );
  }

  if (has("M4")) {
    section("M4 Frames while the board moves", METHOD.M4);
    for (const count of FRAME_COUNTS) {
      for (const gesture of ["pan", "zoom"] as const) {
        for (const armed of [false, true]) {
          const variant = `${gesture} ${count} ${armed ? "armed" : "unarmed"}`;
          if (!has("M4", variant)) continue;
          parts.push(
            `${gesture === "pan" ? `Pan (${PAN_MOVES} moves of a pane drag)` : `Zoom (${WHEEL_STEPS} wheel steps)`}, ${count} BPMN nodes, ${armed ? "one armed" : "none armed"}. Frame intervals in ms; main thread and process time in ms per frame; main thread time in ms per viewport tick (${gesture === "pan" ? "a move" : "a wheel step"}):`,
            byStrategy("M4", variant, [
              { title: "frames", key: "frames", digits: 0 },
              { title: "median", key: "frameMedianMs" },
              { title: "p95", key: "frameP95Ms" },
              { title: "worst", key: "frameWorstMs" },
              { title: "over 20 ms, %", key: "over20Pct" },
              { title: "over 50 ms, %", key: "over50Pct" },
              { title: "per frame: tasks", key: "taskMsPerFrame", digits: 2 },
              { title: "main thread CPU", key: "threadMsPerFrame", digits: 2 },
              { title: "script", key: "scriptMsPerFrame", digits: 2 },
              { title: "layout", key: "layoutMsPerFrame", digits: 2 },
              { title: "style", key: "styleMsPerFrame", digits: 2 },
              { title: "renderer CPU", key: "rendererCpuMsPerFrame", digits: 2 },
              { title: "GPU process CPU", key: "gpuCpuMsPerFrame", digits: 2 },
              { title: "per tick: main thread CPU", key: "threadMsPerTick", digits: 2 },
              { title: "script", key: "scriptMsPerTick", digits: 2 },
              { title: "layout", key: "layoutMsPerTick", digits: 2 },
              { title: "style", key: "styleMsPerTick", digits: 2 },
              ...(armed ? [{ title: "viewbox writes", key: "viewWrites", digits: 0 }] : []),
            ]),
          );
        }
      }
    }
  }

  const moveColumns: Column[] = [
    { title: "tasks", key: "taskUsPerMove", digits: 0 },
    { title: "main thread CPU", key: "threadUsPerMove", digits: 0 },
    { title: "script", key: "scriptUsPerMove", digits: 0 },
    { title: "layout", key: "layoutUsPerMove", digits: 0 },
    { title: "style", key: "styleUsPerMove", digits: 0 },
    { title: "layouts per move", key: "layoutsPerMove", digits: 2 },
    { title: "style recalcs per move", key: "stylesPerMove", digits: 2 },
    { title: "renderer CPU", key: "rendererCpuUsPerMove", digits: 0 },
    { title: "GPU process CPU", key: "gpuCpuUsPerMove", digits: 0 },
    { title: "wall ms per move", key: "wallMsPerMove", digits: 1 },
  ];
  if (has("M5")) {
    section("M5 Pointer work in the armed editor", METHOD.M5);
    for (const count of POINTER_COUNTS) {
      if (!has("M5", `stress-${count}`)) continue;
      parts.push(
        `A shape dragged over ${MOVES} mouse moves, board zoom ${POINTER_VIEW.zoom}, ${count === 1 ? "the armed node alone" : `${count - 1} previews beside the armed node`}. Micro seconds per move:`,
        byStrategy("M5", `stress-${count}`, [
          ...moveColumns,
          { title: "after the release, task ms", key: "afterReleaseTaskMs", digits: 0 },
        ]),
      );
    }
  }
  if (has("M6")) {
    section("M6 Board work beside an armed editor", METHOD.M6);
    for (const armed of [true, false]) {
      const variant = armed ? "armed" : "unarmed";
      if (!has("M6", variant)) continue;
      parts.push(
        `Another node dragged over ${MOVES} mouse moves on a board of ${BOARD_COUNT}, ${armed ? "one node armed" : "none armed (the base line)"}. Micro seconds per move:`,
        byStrategy("M6", variant, moveColumns),
      );
    }
  }
  if (has("M7")) {
    section("M7 Idle", METHOD.M7);
    for (const armed of [true, false]) {
      const variant = armed ? "armed" : "unarmed";
      if (!has("M7", variant)) continue;
      parts.push(
        `${IDLE_MS / 1000} s at rest, board of ${BOARD_COUNT}, ${armed ? "one node armed" : "none armed (the base line)"}. ms per second:`,
        byStrategy("M7", variant, [
          { title: "tasks", key: "taskMsPerS", digits: 2 },
          { title: "script", key: "scriptMsPerS", digits: 2 },
          { title: "style and layout", key: "layoutMsPerS", digits: 2 },
          { title: "main thread CPU", key: "threadMsPerS", digits: 2 },
          { title: "renderer CPU", key: "rendererCpuMsPerS", digits: 2 },
          { title: "GPU process CPU", key: "gpuCpuMsPerS", digits: 2 },
          { title: "layouts", key: "layouts", digits: 0 },
          { title: "style recalcs", key: "styles", digits: 0 },
        ]),
      );
    }
  }
  return parts.join("\n\n");
}

/** how each figure is taken and what it can and cannot show: printed under its heading */
const METHOD: Readonly<Record<Metric, string>> = {
  M1:
    "A stress board of N BPMN nodes of one file (and the matrix board with all seven notations), nothing armed, " +
    `first viewport zoom ${VIEW.zoom}. Times are performance.now() of the top page, taken by a timer of 4 ms that an ` +
    "init script starts before the page's own scripts; a frame's time is put on the top page's clock through " +
    "performance.timeOrigin. Cold: a new browser context (empty HTTP cache, a new renderer process). Warm: the same " +
    "URL in a new page of the same context after the first was closed (HTTP cache filled, again a new renderer " +
    "process). The server is on this machine, so a cold load pays parsing, compiling and running, and next to " +
    "nothing for the transfer; V8's code cache plays no part in either load (a browser context of the harness is off " +
    "the record and has none: a third and a fourth load took as long as the second). The stress board lays N nodes " +
    "out in ceil(sqrt(N)) columns: up to 20 they lie in the canvas as a whole; of 30 (six columns) the five of the " +
    "sixth column show 20 px beside the Files panel and the fifth row is cut by 10 px (the board mounts every " +
    "node, in the window or not). Slope: least squares over N, one per repetition. The board's own `ready` is not " +
    "comparable between an in-page editor and a frame: the embed page reports ready after 100 ms of unchanged DOM. " +
    "On the dev server every module is a request and the times say little; only a production build shows load times.",
  M2:
    `After ready, ${MEMORY_SETTLE_MS} ms and two forced collections (HeapProfiler.collectGarbage). JS heap: CDP ` +
    "Runtime.getHeapUsage of the page. The frames of the iframe strategy are same-origin and live in the page's " +
    "renderer process and V8 isolate (`outOfProcessFrames` in the JSON counts the frame targets of the browser and " +
    "is 0; `documents` and `V8 contexts` grow with every frame), so the one figure holds every frame's realm. Each frame also carries Playwright's utility context, which " +
    "a person's browser has not: the control rows say what a frame costs before it holds an editor, and what one " +
    "such world weighs. Resident memory: " +
    "/proc/<pid>/status and smaps_rollup of the processes CDP SystemInfo.getProcessInfo lists; the page's renderer is " +
    "the largest renderer. In software raster tiles are shared memory, so the anonymous figure leaves them out and " +
    "the sum over all processes (PSS) has them. Slope: least squares over N, one per repetition.",
  M3:
    `Board of ${BOARD_COUNT}, zoom ${VIEW.zoom}, first arming of a fresh page by a real click on the node's Edit ` +
    "button, then a real click on the bare pane. Times count from the click event's timeStamp. State shown: the " +
    "node's `data-armed`. Takes input: the topmost element at the middle of the node body belongs to the editor's " +
    "host, for a frame: is the frame, and the page in it says armed. Frame done: one task after the next animation " +
    "frame. The watch looks on attribute changes and every 4 ms and forces one layout per look after the state " +
    "shows. `hooks.arm` waits whole animation frames by construction (at least three), so it has a floor near 50 ms.",
  M4:
    `Boards of ${FRAME_COUNTS.join(" and ")} BPMN previews at zoom ${VIEW.zoom}, all in the window. Pan: a press on ` +
    `the bare pane and ${PAN_MOVES} mouse moves around an ellipse of 300 x 200 px. Zoom: ${WHEEL_STEPS} wheel steps ` +
    "on the bare pane, ten out and ten in. Input is closed loop: the next event is sent when the page has handled " +
    "the one before, which Chromium does once per frame, so the pan takes about 2 s at 60 Hz. Frame intervals: " +
    "between animation frame callbacks of the top page, from the first event to the frame after the last. A wheel " +
    "step takes about three frames, so two thirds of the zoom's frames carry no tick: read its worst frame and the " +
    "figures per tick. Main thread time: differences of CDP Performance.getMetrics around the gesture (TaskDuration: " +
    "wall time of all tasks, with the wait for the compositor at every commit; ThreadTime: CPU time of the main " +
    "thread; ScriptDuration, LayoutDuration, RecalcStyleDuration), divided by the frames and by the ticks; " +
    "same-origin frames run on that thread and are in it. Renderer and GPU process CPU: SystemInfo.getProcessInfo " +
    "(all threads, steps of 10 ms). Mouse events are sent as CDP Input.dispatchMouseEvent, not through page.mouse: " +
    "Playwright evaluates a script in every frame around each move while a button is down. " +
    "HEADLESS CHROMIUM RASTERS IN SOFTWARE: absolute frame times are not those of a laptop with a GPU, and raster " +
    "runs on other threads than the one the frame intervals watch. Only the comparison between strategies carries.",
  M5:
    `Board zoom ${POINTER_VIEW.zoom}, node s-0 armed, one task pressed after a hit test and dragged along two loops ` +
    `of a circle of ${RADIUS} px, snapping left on (no key held). The readings of Performance.getMetrics are taken ` +
    "after the drag began and before the release: only the moves are in them. One move per frame (closed loop), so " +
    "a move's time includes the frame the browser renders for it. Tasks: wall time, with the wait for the " +
    "compositor; main thread CPU: what the thread worked. The file changes after the release only. The " +
    "stress board shows ONE file in all nodes: what follows the release (every other node imports the change) is " +
    "that board's property and is listed apart.",
  M6:
    `Board of ${BOARD_COUNT} at zoom ${VIEW.zoom}. Another node is pressed on its header and dragged along the same ` +
    "loops; readings as in M5. The unarmed table is the base line: the difference is what an armed editor of that " +
    "strategy adds to board work (listeners that see every event, patched prototypes, a frame's shield).",
  M7:
    `Board of ${BOARD_COUNT} at zoom ${VIEW.zoom}; 2.5 s after arming the script does nothing for the stated time: ` +
    "no evaluate, no animation frame loop, no pointer. Differences of Performance.getMetrics and of the processes' " +
    "CPU time. A strategy that polls or retries shows here. The unarmed table is the base line.",
};

// ── main ─────────────────────────────────────────────────────────────────────

const headline: Readonly<Record<Metric, readonly string[]>> = {
  M1: ["renderedMs", "readyMs", "requests"],
  M2: ["heapUsedMB", "rendererAnonMB", "allPssMB", "domNodes", "heapUsedKBPerFrame", "rendererAnonKBPerFrame"],
  M3: ["armInputMs", "armFrameDoneMs", "disarmInputMs", "hookArmMs"],
  M4: ["frames", "frameMedianMs", "frameP95Ms", "frameWorstMs", "taskMsPerFrame", "scriptMsPerFrame"],
  M5: ["taskUsPerMove", "scriptUsPerMove", "layoutsPerMove", "movedXPx"],
  M6: ["taskUsPerMove", "scriptUsPerMove", "layoutsPerMove", "movedXPx"],
  M7: ["taskMsPerS", "scriptMsPerS", "rendererCpuMsPerS"],
};
function line(sample: Sample): string {
  const numbers = headline[sample.metric]
    .filter((key) => typeof sample.values[key] === "number")
    .map((key) => `${key} ${round(sample.values[key] ?? 0, 2)}`)
    .join("  ");
  return [
    sample.metric,
    sample.variant.padEnd(22),
    sample.strategy.padEnd(8),
    `r${sample.repeat}`,
    sample.status === "ok" ? numbers : `FAILED: ${sample.error ?? ""}`,
    `(${sample.ms} ms, load ${sample.load1}, speed ${round(sample.speedMs, 1)} ms, stolen ${sample.stolenPct === null ? "?" : round(sample.stolenPct, 1)} %)`,
  ].join("  ");
}

if (WAIT_QUIET_MIN > 0 && loadAtStart > LOAD_LIMIT) {
  const until = Date.now() + WAIT_QUIET_MIN * 60_000;
  console.log(`1 minute load ${loadAtStart}: waiting up to ${WAIT_QUIET_MIN} min for it to fall to ${LOAD_LIMIT}`);
  while (load1() > LOAD_LIMIT && Date.now() < until) await sleep(5000);
  loadAtStart = load1();
}
if (loadAtStart > LOAD_LIMIT) {
  console.log(
    `1 minute load average ${loadAtStart} is above ${LOAD_LIMIT}: ` +
      (FORCE
        ? "FORCE=1, the result is printed as final all the same"
        : "the result of this run is NOT FINAL (a rehearsal)"),
  );
}

await run(async (harness) => {
  const started = Date.now();
  const system = await harness.browser.newBrowserCDPSession();
  const info = await system.send("SystemInfo.getInfo");
  const html = await fetch(`${harness.base}/board-spike.html`).then((response) => response.text());
  const build = html.includes("/src/board-spike/main.tsx") ? "dev server, unbundled modules" : "production build";
  const all = jobs();
  console.log(
    `${build} at ${harness.base}; ${strategies.join(", ")}; cases ${cases.join(", ")}; ${REPEAT} repetitions; ` +
      `${all.length} jobs per strategy and repetition`,
  );

  // Not measured: every strategy's page once, with every engine. A dev server transforms a module
  // on its first request; without this the first cold sample would pay for the server, not the page
  for (const strategy of strategies) {
    const board = await harness.open({ board: "matrix", strategy, ...VIEW }, OPEN);
    await board.close();
  }

  const samples: Sample[] = [];
  /** complete repetitions so far, and why there are fewer than REPEAT */
  let repetitions = 0;
  let cut = "";
  const result = (ended: boolean) => {
    const failed = samples.filter((sample) => sample.status === "failed");
    const troubled = samples.filter((sample) => sample.problems.length > 0);
    const loadAtEnd = load1();
    // the machine's speed: over all samples, and per repetition (a job is counted once per sample it gave)
    const speeds = samples.map((sample) => sample.speedMs);
    const stolen = samples.map((sample) => sample.stolenPct).filter((value): value is number => value !== null);
    const speedOf = (repeat: number): number =>
      quantile(
        samples.filter((sample) => sample.repeat === repeat).map((sample) => sample.speedMs),
        0.5,
      );
    const perRepetition = [...new Set(samples.map((sample) => sample.repeat))].map((repeat) => speedOf(repeat));
    const [fastestRepetition, slowestRepetition] = [Math.min(...perRepetition), Math.max(...perRepetition)];
    const speedMedian = quantile(speeds, 0.5);
    const notFinal = [
      ...(ended ? [] : ["the run is not over"]),
      ...(ended && perRepetition.length > 1 && slowestRepetition > fastestRepetition * SPEED_TOLERANCE
        ? [
            `the machine's speed changed during the run: the fixed work took a median of ${round(fastestRepetition, 1)} ms in one repetition and ${round(slowestRepetition, 1)} ms in another (limit ${Math.round((SPEED_TOLERANCE - 1) * 100)} %)`,
          ]
        : []),
      ...(ended && stolen.length > 0 && quantile(stolen, 0.5) > STOLEN_LIMIT_PCT
        ? [
            `the host took a median of ${round(quantile(stolen, 0.5), 1)} % of the processor time this system wanted during a sample (limit ${STOLEN_LIMIT_PCT} %): times and CPU figures are too high`,
          ]
        : []),
      ...(ended && SPEED_REF_MS > 0 && speedMedian > SPEED_REF_MS * SPEED_TOLERANCE
        ? [
            `the machine was slower than its reference: the fixed work took a median of ${round(speedMedian, 1)} ms against SPEED_REF_MS=${SPEED_REF_MS}`,
          ]
        : []),
      ...(loadAtStart > LOAD_LIMIT && !FORCE
        ? [`1 minute load average ${loadAtStart} at the start (limit ${LOAD_LIMIT})`]
        : []),
      ...(ended && repetitions < 2 ? [`${repetitions} complete repetition, below 2: no range`] : []),
      ...(MOVES !== DEFAULT_MOVES && (cases.includes("pointer") || cases.includes("board")) ? [`MOVES=${MOVES}`] : []),
      ...(IDLE_MS !== DEFAULT_IDLE_MS && cases.includes("idle") ? [`IDLE_MS=${IDLE_MS}`] : []),
      ...(failed.length > 0 ? [`${failed.length} samples failed`] : []),
    ];
    return {
      what: "board spike: cost of the strategies (mount, memory, arming, frames, pointer, board work, idle)",
      final: notFinal.length === 0,
      notFinal,
      repetitions: { wanted: REPEAT, done: repetitions, full: FULL_REPEAT, budgetMin: BUDGET_MIN, cut },
      date: new Date().toISOString(),
      runMinutes: round((Date.now() - started) / 60_000, 1),
      load: {
        limit: LOAD_LIMIT,
        forced: FORCE,
        atStart: loadAtStart,
        atEnd: loadAtEnd,
        highestAtASample: samples.reduce((highest, sample) => Math.max(highest, sample.load1), 0),
      },
      machine: { cpus: cpus().length, memoryGB: round(totalmem() / 2 ** 30, 1), node: process.version },
      // a fixed amount of work in this process before every sample, and the host's steal during it
      machineSpeed: {
        iterations: SPEED_ITERATIONS,
        rounds: SPEED_ROUNDS,
        referenceMs: SPEED_REF_MS,
        workMs: {
          fastest: round(Math.min(...speeds), 2),
          median: round(speedMedian, 2),
          p90: round(quantile(speeds, 0.9), 2),
          slowest: round(Math.max(...speeds), 2),
        },
        perRepetitionMedianMs: perRepetition.map((value) => round(value, 2)),
        stolenPct:
          stolen.length === 0
            ? null
            : {
                median: round(quantile(stolen, 0.5), 2),
                p90: round(quantile(stolen, 0.9), 2),
                highest: round(Math.max(...stolen), 2),
              },
      },
      chromium: harness.browser.version(),
      // what the browser says about its own rendering: software raster in a headless shell without a GPU
      gpu: info.gpu.featureStatus ?? null,
      sandbox: !info.commandLine.includes("--no-sandbox"),
      base: harness.base,
      build,
      extraParams: extraParams(),
      window: { ...WINDOW, deviceScaleFactor: DPR },
      settings: {
        strategies,
        cases,
        repeat: REPEAT,
        counts: COUNTS,
        frameCounts: FRAME_COUNTS,
        pointerCounts: POINTER_COUNTS,
        boardCount: BOARD_COUNT,
        moves: MOVES,
        idleMs: IDLE_MS,
        view: VIEW,
        pointerView: POINTER_VIEW,
        panMoves: PAN_MOVES,
        wheelSteps: WHEEL_STEPS,
      },
      method: METHOD,
      counts: { samples: samples.length, failed: failed.length, withProblems: troubled.length },
      samples,
    };
  };

  const loopStarted = Date.now();
  for (let repeat = 0; repeat < REPEAT; repeat++) {
    if (BUDGET_MIN > 0 && repeat > 0) {
      // whole repetitions only: every case keeps the same number of samples
      const spent = (Date.now() - loopStarted) / 60_000;
      if (spent + spent / repeat > BUDGET_MIN) {
        cut = `${repeat} of ${REPEAT} repetitions: a further one (${round(spent / repeat, 1)} min each) does not fit BUDGET_MIN=${BUDGET_MIN} after ${round(spent, 1)} min`;
        console.log(cut);
        break;
      }
    }
    // the order of the strategies rotates: none is always first after a pause or last in a warm machine
    const order = strategies.map((_, index) => strategies[(index + repeat) % strategies.length]!);
    for (const job of all) {
      for (const strategy of order) {
        if (job.only && !job.only(strategy)) continue;
        const done = await runJob(job, harness, system, strategy, repeat);
        samples.push(...done);
        for (const sample of done) {
          console.log(line(sample));
          for (const problem of sample.problems) console.log(`    ${problem.slice(0, 200)}`);
        }
      }
      // after every job: a run that is stopped leaves what it has
      writeResult("cost", result(false));
    }
    repetitions = repeat + 1;
  }
  await system.detach();

  const data = result(true);
  const forced =
    FORCE && loadAtStart > LOAD_LIMIT
      ? `the 1 minute load average was ${loadAtStart} at the start, above the limit of ${LOAD_LIMIT}`
      : "";
  const path = writeResult("cost", data);
  const software = Object.entries(data.gpu ?? {})
    .filter(([name]) => ["gpu_compositing", "rasterization"].includes(name))
    .map(([name, value]) => `${name}: ${value}`)
    .join(", ");
  const few =
    repetitions < FULL_REPEAT
      ? `${repetitions} repetitions instead of ${FULL_REPEAT}${cut ? ` (${cut})` : ` (REPEAT=${REPEAT})`}: each cell is the median and the range of ${repetitions} samples`
      : "";
  const markdown = [
    `# Board spike, cost of the strategies: ${data.final ? "FINAL" : "NOT FINAL"}${few ? `, ${repetitions} repetitions` : ""}`,
    ...(data.final ? [] : [`**Not final, not to be cited:** ${data.notFinal.join("; ")}.`]),
    ...(few ? [`**Fewer repetitions:** ${few}.`] : []),
    ...(data.final && forced ? [`**Final by FORCE=1 only:** ${forced}.`] : []),
    [
      `- ${data.date}, ${data.runMinutes} min, ${build} at ${harness.base}${data.extraParams ? `, EXTRA_PARAMS ${data.extraParams}` : ""}`,
      `- Chromium ${data.chromium} headless with the sandbox${data.sandbox ? "" : " (NOT: --no-sandbox is on the command line)"}, window ${WINDOW.width} x ${WINDOW.height}, device pixel ratio ${DPR}${software ? `; ${software}` : ""}`,
      `- machine: ${data.machine.cpus} cores, ${data.machine.memoryGB} GB; 1 minute load average ${data.load.atStart} at the start, ${data.load.atEnd} at the end, at most ${data.load.highestAtASample} when a sample began (the run itself loads the machine)`,
      `- machine speed: a fixed amount of work in this process, timed before every sample, took ${data.machineSpeed.workMs.median} ms (median; fastest ${data.machineSpeed.workMs.fastest}, 90th percentile ${data.machineSpeed.workMs.p90}, slowest ${data.machineSpeed.workMs.slowest}); per repetition ${data.machineSpeed.perRepetitionMedianMs.join(", ")} ms${data.machineSpeed.stolenPct ? `; processor time the host took from this system during a sample: median ${data.machineSpeed.stolenPct.median} %, 90th percentile ${data.machineSpeed.stolenPct.p90} %, at most ${data.machineSpeed.stolenPct.highest} % of what its tasks wanted` : ""}`,
      `- ${repetitions} repetitions, each cell: median (lowest to highest); one page at a time, a fresh page and browser context per sample`,
      `- ${data.counts.samples} samples, ${data.counts.failed} failed, ${data.counts.withProblems} with console errors or log lines`,
      "- Headless Chromium rasters in software: absolute frame times are not those of a laptop with a GPU. Only the comparison between strategies carries.",
    ].join("\n"),
    tables(samples),
  ].join("\n\n");
  const markdownPath = outPath("cost.md");
  writeFileSync(markdownPath, `${markdown}\n`);
  console.log(`\n${markdown}\n`);
  for (const sample of samples.filter((one) => one.status === "failed")) console.log(`FAILED ${line(sample)}`);
  console.log(
    `\n${data.final ? `FINAL${forced ? ` by FORCE=1 (${forced})` : ""}` : `NOT FINAL (${data.notFinal.join("; ")})`}${few ? `, ${few}` : ""}: ${data.counts.samples} samples in ` +
      `${data.runMinutes} min, ${data.counts.failed} failed, ${data.counts.withProblems} with problems\n${path}\n${markdownPath}`,
  );
  // the harness failed, not a strategy: a sample that threw, or output where none belongs
  return data.counts.failed + data.counts.withProblems;
});
