/**
 * A drag that spans a peer's change (issue 295) in the built SPA, in headless
 * Chromium, with the real modelers: bpmn-js and every Miragon renderer. A
 * check run by hand, not by `pnpm test`, because CI has no browser; the jsdom
 * suites cannot drag with a pointer (test/live-gesture.test.ts runs
 * diagram-js's dragging without one). Run it after a renderer, diagram-js or
 * live-client change, from the repository root:
 *
 *   pnpm build
 *   npx -y playwright@1.56.1 install --only-shell chromium     # once
 *   npx -y -p playwright@1.56.1 -c "node apps/web/test/live-gesture-chromium.ts"
 *
 * It starts a Live Host of its own (LIVE_AUTH=none, on PORT, 8392 unless
 * set) on a generated content repo with one model per notation (NOTATIONS,
 * comma-separated, picks some: NOTATIONS=bpmn,wardley), and opens
 * each in two pages, A and B, each in a browser context of its own. First a
 * drag on A writes the model once, so the text is the modeler's own and later
 * edits stay local to their element. Then:
 *
 *  1. A presses on one element and drags it; B drags another element and
 *     drops; A holds its drag well past the import debounce, then drops.
 *     Both moves must end up in the shared text (read by a third, headless
 *     session) and on A, B and a freshly opened page C, with no page error,
 *     no console error and no conflict toast.
 *  2. A presses and drags again and holds for 11 s while B drops another
 *     move. At 10 s A's drag must be cancelled (the drag marker gone) and B's
 *     move imported; A's drop afterwards changes nothing and throws nothing.
 *  3. A clicks a palette entry, so the new element follows the pointer with
 *     no button held, while the headless session edits the title; A places
 *     the element well past the import debounce. The edit and A's new element
 *     must both end up in the shared text and on A, B and a fresh page, with
 *     no error and no toast.
 *
 * Then on fresh pages A and B:
 *
 *  4. A arms a palette tool that waits for the next press (bpmn-js: the hand
 *     tool after one pan, which re-arms it; a Miragon renderer: the lasso):
 *     diagram-js sets its drag marker and draws no preview. B's move must
 *     reach A within the import debounce, with no Escape sent to A's page,
 *     no error and no toast.
 *  5. A clicks a palette entry and leaves the pointer on the palette, so the
 *     new element has no preview on the canvas yet, while the headless
 *     session edits the title back. A's canvas must wait all the same; then
 *     A places the element. Both must end up in the shared text, with no
 *     error and no toast.
 *  6. Edits that touch in the text: A creates from the palette while B moves
 *     the element listed last (a new element goes after it), and in bpmn-js
 *     A drags the task whose DI is not last while B moves the other (bpmn-js
 *     writes a moved shape's DI last). B's edit must stay, nothing may throw,
 *     and A's edit must either end up in the shared text with no toast, or
 *     give way with exactly one toast on A. The run reports which.
 *
 * Exits 1 on any failure.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openLiveSession, roomName } from "@designiq/live-client";

/** the part of Playwright's API this check uses: Playwright is no dependency of the repo */
interface Mouse {
  move(x: number, y: number, options?: { steps?: number }): Promise<void>;
  down(): Promise<void>;
  up(): Promise<void>;
}
interface Page {
  goto(url: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  close(): Promise<void>;
  mouse: Mouse;
  keyboard: { press(key: string): Promise<void> };
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<Awaited<R>>;
  waitForFunction<A>(fn: (arg: A) => unknown, arg: A, options: { timeout: number; polling?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  on(event: "pageerror", listener: (error: Error) => void): void;
  on(event: "console", listener: (message: { type(): string; text(): string }) => void): void;
}
interface BrowserContext {
  newPage(): Promise<Page>;
  addInitScript<A>(script: (arg: A) => void, arg: A): Promise<void>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newContext(options: { viewport: { width: number; height: number } }): Promise<BrowserContext>;
      close(): Promise<void>;
    }>;
  };
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIST = join(ROOT, "apps/web/dist");
const PORT = Number(process.env.PORT ?? 8392);
const BASE = `http://localhost:${PORT}`;
const REPO = "acme/gestures";
/** past the import debounce (350 ms) with margin: without the hold, the peer's change is imported by now */
const HOLD_PAST_DEBOUNCE = 1500;
/** past the 10 s a re-import waits for a gesture */
const HOLD_PAST_BOUND = 11_000;
/** the quiet period after a drop, the import debounce and the peers' re-import */
const SETTLE = 3000;

/** the one npx puts on PATH */
function loadPlaywright(): Playwright {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const bin = join(dir, "playwright");
    if (existsSync(bin)) return createRequire(realpathSync(bin))("playwright") as Playwright;
  }
  throw new Error('No playwright on PATH: run this through npx -p playwright@1.56.1 -c "node …" (see its header).');
}

interface Model {
  notation: string;
  /** its file name in the content repo's models folder */
  fileName: string;
  text: string;
  /** what A drags, what B drags: diagram-js element ids */
  a: string;
  b: string;
  /** the palette entry A creates an element with (its data-action) */
  create: string;
  /** a peer's text edit far from where a new element goes: the title */
  retitle: [from: string, to: string];
  /** a palette tool that waits for the next press (its data-action) */
  tool: string;
  /** of a and b, the one the text lists last (a new element goes after it); bpmn reads it from the DI order */
  listedLast?: string;
}

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:task id="Task_check" name="Check order" />
    <bpmn:task id="Task_ship" name="Ship order" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="Task_check_di" bpmnElement="Task_check"><dc:Bounds x="160" y="200" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_ship_di" bpmnElement="Task_ship"><dc:Bounds x="520" y="200" width="100" height="80" /></bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;

const MODELS: Model[] = [
  // bpmn-js writes a moved shape's DI last: A warms up and drags the same
  // task, so its drop rewrites one line, which merges with B's
  {
    notation: "bpmn",
    fileName: "order.bpmn",
    text: BPMN,
    a: "Task_check",
    b: "Task_ship",
    create: "create.task",
    retitle: ['<bpmn:process id="Process_1"', '<bpmn:process id="Process_1" name="Orders"'],
    tool: "hand-tool",
  },
  {
    notation: "wardley",
    fileName: "tea.wmap",
    text: "title Tea Shop\ncomponent Cup of Tea [0.79, 0.61]\ncomponent Hot Water [0.82, 0.78]\ncomponent Kettle [0.43, 0.35]\nCup of Tea->Hot Water\nHot Water->Kettle\n",
    a: "cmp_kettle",
    b: "cmp_cup_of_tea",
    create: "create.component",
    retitle: ["Tea Shop", "Tea House"],
    tool: "lasso-tool",
    listedLast: "cmp_kettle",
  },
  {
    notation: "event-storming",
    fileName: "checkout.storm",
    text: "title Checkout\ncommand Place Order [240,300]\nevent Order Placed [620,300]\nevent Order Shipped [900,300]\nPlace Order -> Order Placed\n",
    a: "cmd_place_order",
    b: "event_order_shipped",
    create: "create.event",
    retitle: ["Checkout", "Checkout Flow"],
    tool: "lasso-tool",
    listedLast: "event_order_shipped",
  },
  {
    notation: "context-map",
    fileName: "conference.cm.json",
    text: `${JSON.stringify(
      {
        version: 1,
        title: "Conference",
        contexts: [
          { label: "CfP", id: "ctx_cfp", position: { x: 40, y: 40 }, size: { width: 200, height: 110 } },
          { label: "Agenda", id: "ctx_agenda", position: { x: 500, y: 40 }, size: { width: 200, height: 110 } },
        ],
        relationships: [],
      },
      null,
      2,
    )}\n`,
    a: "ctx_cfp",
    b: "ctx_agenda",
    create: "context.core",
    retitle: ["Conference", "Conference Days"],
    tool: "lasso-tool",
    listedLast: "ctx_agenda",
  },
  {
    notation: "team-topology",
    fileName: "shop.tt",
    text: `${JSON.stringify(
      {
        version: 3,
        title: "Online Shop",
        nodes: [
          {
            label: "Checkout",
            id: "team_checkout",
            type: "stream-aligned",
            position: { x: 40, y: 40 },
            size: { width: 240, height: 96 },
          },
          {
            label: "Payments",
            id: "team_payments",
            type: "stream-aligned",
            position: { x: 500, y: 40 },
            size: { width: 240, height: 96 },
          },
        ],
        interactions: [],
        flows: [],
      },
      null,
      2,
    )}\n`,
    a: "team_checkout",
    b: "team_payments",
    create: "team.stream-aligned",
    retitle: ["Online Shop", "Online Store"],
    tool: "lasso-tool",
    listedLast: "team_payments",
  },
];

async function startLiveHost(content: string, data: string): Promise<ChildProcess> {
  const host = spawn(process.execPath, [join(ROOT, "apps/live-host/src/server.ts")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      LIVE_PUBLIC_URL: BASE,
      GITHUB_REPO: REPO,
      LIVE_HOST_CONTENT_DIR: content,
      LIVE_DATA_DIR: data,
      LIVE_AUTH: "none",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  host.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  host.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  for (const deadline = Date.now() + 60_000; Date.now() < deadline && host.exitCode === null;) {
    const up = await fetch(`${BASE}/`).then(
      (res) => res.ok,
      () => false,
    );
    if (up) return host;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  host.kill();
  throw new Error(`The Live Host did not start on ${BASE}:\n${log}`);
}

interface Point {
  x: number;
  y: number;
}

/** a page on a model, and the exceptions it reports */
interface Peer {
  page: Page;
  errors: string[];
}

/** the copy of a model scenario 6 runs on: a text no create has touched, so the element listed last is known */
const touchFile = (model: Model): string => `touch-${model.fileName}`;

async function openPeer(context: BrowserContext, model: Model, fileName = model.fileName): Promise<Peer> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    // a failed request is no exception (this host answers the todo API with 501)
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  await page.goto(`${BASE}/r/${REPO}/f/models/${fileName}`);
  await page.waitForFunction(
    (ids) => ids.every((id) => document.querySelector(`.djs-element[data-element-id="${id}"]`)),
    [model.a, model.b],
    { timeout: 60_000, polling: 100 },
  );
  await page.waitForTimeout(500);
  return { page, errors };
}

/** where the canvas draws an element, in diagram coordinates (its transform) */
const positionIn = (peer: Peer, id: string): Promise<Point> =>
  peer.page.evaluate((elementId) => {
    const gfx = document.querySelector<SVGGraphicsElement>(`.djs-element[data-element-id="${elementId}"]`);
    const matrix = gfx?.transform.baseVal.consolidate()?.matrix;
    return { x: matrix?.e ?? NaN, y: matrix?.f ?? NaN };
  }, id);

/** the screen point to grab an element at: the middle of its hit area (what it draws may include its label) */
const grabPoint = (peer: Peer, id: string): Promise<Point> =>
  peer.page.evaluate((elementId) => {
    const hit = document.querySelector(`.djs-element[data-element-id="${elementId}"] > .djs-hit`);
    const box = hit!.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, id);

/** a point on the bare canvas, well clear of every shape, to place a new element at */
const emptySpot = (peer: Peer): Promise<Point> =>
  peer.page.evaluate(() => {
    const canvas = document.querySelector(".djs-container")!.getBoundingClientRect();
    const shapes = [...document.querySelectorAll(".djs-element.djs-shape")].map((shape) =>
      shape.getBoundingClientRect(),
    );
    const clear = (x: number, y: number): boolean =>
      shapes.every((box) => x < box.left - 160 || x > box.right + 160 || y < box.top - 120 || y > box.bottom + 120);
    for (let y = canvas.bottom - 100; y > canvas.top + 150; y -= 40) {
      for (let x = canvas.left + 150; x < canvas.right - 150; x += 40) {
        const hit = document.elementFromPoint(x, y);
        if (clear(x, y) && hit?.closest("svg") && !hit.closest(".djs-element")) return { x, y };
      }
    }
    throw new Error("no bare canvas to place a new element on");
  }, undefined);

/** tags what the canvas draws for an element: an import draws everything anew, without the tag */
const markRendered = (peer: Peer, id: string): Promise<void> =>
  peer.page.evaluate((elementId) => {
    document.querySelector(`.djs-element[data-element-id="${elementId}"]`)!.setAttribute("data-rendered-before", "");
  }, id);

const stillRendered = (peer: Peer): Promise<boolean> =>
  peer.page.evaluate(() => document.querySelector("[data-rendered-before]") !== null, undefined);

const shapeCount = (peer: Peer): Promise<number> =>
  peer.page.evaluate(() => document.querySelectorAll(".djs-element.djs-shape").length, undefined);

const dragActive = (peer: Peer): Promise<boolean> =>
  peer.page.evaluate(() => document.querySelector(".djs-drag-active") !== null, undefined);

/** what diagram-js draws for the elements a drag carries: an armed palette tool draws none */
const previewDrawn = (peer: Peer): Promise<boolean> =>
  peer.page.evaluate(() => document.querySelector(".djs-dragger") !== null, undefined);

/** runs in every page before its own scripts: counts the Escape keyups a script sends (the binding's cancel at the bound) */
function recordSentEscapes(): void {
  const sent = { count: 0 };
  Object.assign(window, { __sentEscapes: sent });
  document.addEventListener(
    "keyup",
    (event) => {
      if (event.key === "Escape" && !event.isTrusted) sent.count++;
    },
    true,
  );
}

const sentEscapes = (peer: Peer): Promise<number> =>
  peer.page.evaluate(() => (window as unknown as { __sentEscapes: { count: number } }).__sentEscapes.count, undefined);

/** runs in every page before its own scripts: keeps every toast it shows, also one gone again */
function recordToasts(): void {
  const shown: string[] = [];
  Object.assign(window, { __toasts: shown });
  const start = (): void =>
    new MutationObserver(() => {
      for (const toast of document.querySelectorAll("[data-sonner-toast]")) {
        const text = toast.textContent ?? "";
        if (!toast.hasAttribute("data-recorded")) {
          toast.setAttribute("data-recorded", "");
          shown.push(text);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  if (document.documentElement) start();
  else document.addEventListener("readystatechange", start, { once: true });
}

/** the toasts a page showed since the last call */
const toasts = (peer: Peer): Promise<string[]> =>
  peer.page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts.splice(0), undefined);

/** presses on an element and moves it, without letting go */
async function startDrag(peer: Peer, id: string, by: Point): Promise<void> {
  const from = await grabPoint(peer, id);
  await peer.page.mouse.move(from.x, from.y);
  await peer.page.mouse.down();
  await peer.page.mouse.move(from.x + by.x / 2, from.y + by.y / 2, { steps: 5 });
  await peer.page.mouse.move(from.x + by.x, from.y + by.y, { steps: 5 });
}

async function drag(peer: Peer, id: string, by: Point): Promise<void> {
  await startDrag(peer, id, by);
  await peer.page.mouse.up();
}

/** how long until a page draws an element away from `before` (ms), or -1 */
async function latency(peer: Peer, id: string, before: Point, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!same(await positionIn(peer, id), before)) return Date.now() - start;
    await peer.page.waitForTimeout(50);
  }
  return -1;
}

const moved = (from: Point, to: Point): boolean => Math.abs(to.x - from.x) + Math.abs(to.y - from.y) > 10;
const same = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
const show = ({ x, y }: Point): string => `(${Math.round(x)}, ${Math.round(y)})`;

const failures: string[] = [];
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const playwright = loadPlaywright();
for (const file of ["index.html", "assets"]) {
  if (!existsSync(join(DIST, file))) throw new Error(`apps/web/dist/${file} is missing: run pnpm build first.`);
}
const work = mkdtempSync(join(tmpdir(), "designiq-live-gesture-"));
mkdirSync(join(work, "content", "models"), { recursive: true });
writeFileSync(join(work, "content", "designiq.yml"), "models: models\n");
for (const model of MODELS) {
  writeFileSync(join(work, "content", "models", model.fileName), model.text);
  writeFileSync(join(work, "content", "models", touchFile(model)), model.text);
}
const host = await startLiveHost(join(work, "content"), join(work, "data"));
const browser = await playwright.chromium.launch({ headless: true });
const summary: Array<Record<string, string | number>> = [];
const touching: Array<Record<string, string>> = [];

const picked = process.env.NOTATIONS?.split(",");
try {
  for (const model of MODELS.filter(({ notation }) => !picked || picked.includes(notation))) {
    console.log(`\n== ${model.notation} (${model.fileName})`);
    const session = openLiveSession({
      url: `ws://localhost:${PORT}`,
      room: roomName(REPO, `models/${model.fileName}`),
      token: "local",
    });
    const contexts: BrowserContext[] = [];
    try {
      await session.whenSynced(15_000);
      const shared = (): string => session.content.toString();
      for (let i = 0; i < 2; i++) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await context.addInitScript(recordToasts, undefined);
        await context.addInitScript(recordSentEscapes, undefined);
        contexts.push(context);
      }
      const a = await openPeer(contexts[0]!, model);
      // the modeler's own text first: a hand-written file's first edit rewrites all of it
      await drag(a, model.a, { x: 20, y: 20 });
      check(await waitFor(() => shared() !== model.text), `${model.notation}: A's first drop is written`);
      await a.page.waitForTimeout(SETTLE);
      const b = await openPeer(contexts[1]!, model);
      const start = { a: await positionIn(a, model.a), b: await positionIn(a, model.b) };

      // 1. A drags, B's drop arrives, A drops
      await startDrag(a, model.a, { x: 60, y: 40 });
      check(
        (await dragActive(a)) && (await previewDrawn(a)),
        `${model.notation}: A's drag runs (diagram-js's marker set, its preview drawn)`,
      );
      const beforeB = shared();
      await drag(b, model.b, { x: 50, y: 60 });
      check(await waitFor(() => shared() !== beforeB), `${model.notation}: B's drop is written`);
      const afterB = shared();
      await a.page.waitForTimeout(HOLD_PAST_DEBOUNCE);
      const heldOnA = await positionIn(a, model.b);
      check(same(heldOnA, start.b), `${model.notation}: A's canvas waits with B's move while A drags`);
      await a.page.mouse.up();
      check(await waitFor(() => shared() !== afterB, SETTLE), `${model.notation}: A's drop is written`);
      await a.page.waitForTimeout(SETTLE);
      const c = await openPeer(contexts[1]!, model);
      const onC = { a: await positionIn(c, model.a), b: await positionIn(c, model.b) };
      check(
        moved(start.a, onC.a),
        `${model.notation}: A's move is in the shared text ${show(start.a)} → ${show(onC.a)}`,
      );
      check(
        moved(start.b, onC.b),
        `${model.notation}: B's move is in the shared text ${show(start.b)} → ${show(onC.b)}`,
      );
      for (const [name, peer] of [
        ["A", a],
        ["B", b],
      ] as const) {
        const on = { a: await positionIn(peer, model.a), b: await positionIn(peer, model.b) };
        check(
          same(on.a, onC.a) && same(on.b, onC.b),
          `${model.notation}: ${name}'s canvas shows the shared text (${show(on.a)}, ${show(on.b)})`,
        );
        const shown = await toasts(peer);
        check(shown.length === 0, `${model.notation}: no toast on ${name} ${shown.join(" | ")}`);
      }
      check(a.errors.length + b.errors.length === 0, `${model.notation}: no error on A or B`);
      for (const error of [...a.errors, ...b.errors]) console.log(`     ${error}`);
      const scenario1 = { errors: a.errors.length + b.errors.length };
      await c.page.close();

      // 2. A holds its drag past the bound while B's drop arrives
      const before2 = { a: await positionIn(a, model.a), b: await positionIn(b, model.b) };
      a.errors.length = 0;
      b.errors.length = 0;
      await startDrag(a, model.a, { x: -40, y: 50 });
      check(await dragActive(a), `${model.notation}: A's second drag runs`);
      const beforeB2 = shared();
      await drag(b, model.b, { x: -50, y: 40 });
      check(await waitFor(() => shared() !== beforeB2), `${model.notation}: B's second drop is written`);
      await a.page.waitForTimeout(HOLD_PAST_DEBOUNCE);
      check(same(await positionIn(a, model.b), before2.b), `${model.notation}: A still waits after 1.5 s`);
      await a.page.waitForTimeout(HOLD_PAST_BOUND - HOLD_PAST_DEBOUNCE);
      check(!(await dragActive(a)), `${model.notation}: past 10 s A's drag is cancelled`);
      const bOnB = await positionIn(b, model.b);
      check(same(await positionIn(a, model.b), bOnB), `${model.notation}: and B's move is on A's canvas`);
      const textAtBound = shared();
      await a.page.mouse.move(700, 500, { steps: 3 });
      await a.page.mouse.up();
      await a.page.waitForTimeout(SETTLE);
      check(same(await positionIn(a, model.a), before2.a), `${model.notation}: A's drop after the bound moves nothing`);
      check(shared() === textAtBound, `${model.notation}: and writes nothing`);
      check(a.errors.length + b.errors.length === 0, `${model.notation}: no error on A or B at the bound`);
      for (const error of [...a.errors, ...b.errors]) console.log(`     ${error}`);
      for (const [name, peer] of [
        ["A", a],
        ["B", b],
      ] as const) {
        const shown = await toasts(peer);
        check(shown.length === 0, `${model.notation}: no toast on ${name} at the bound ${shown.join(" | ")}`);
      }

      const bound = { errors: a.errors.length + b.errors.length };

      // 3. A creates from the palette with no button held while a peer's text edit arrives
      a.errors.length = 0;
      b.errors.length = 0;
      const shapesBefore = await shapeCount(a);
      const createAt = await emptySpot(a);
      await a.page.click(`.djs-palette .entry[data-action="${model.create}"]`);
      await a.page.mouse.move(createAt.x - 40, createAt.y - 40, { steps: 5 });
      await a.page.mouse.move(createAt.x, createAt.y, { steps: 5 });
      check(
        (await dragActive(a)) && (await previewDrawn(a)),
        `${model.notation}: A's new element follows the pointer (the drag marker set, its preview drawn)`,
      );
      await markRendered(a, model.a);
      const [from, to] = model.retitle;
      const at = shared().indexOf(from);
      check(at >= 0, `${model.notation}: the peer finds "${from}"`);
      session.doc.transact(() => {
        session.content.delete(at, from.length);
        session.content.insert(at, to);
      });
      const edited = shared();
      await a.page.waitForTimeout(HOLD_PAST_DEBOUNCE);
      check(await stillRendered(a), `${model.notation}: A's canvas waits with the peer's edit while A creates`);
      await a.page.mouse.down();
      await a.page.mouse.up();
      check(await waitFor(() => shared() !== edited, SETTLE), `${model.notation}: A's new element is written`);
      await a.page.waitForTimeout(SETTLE);
      check(!(await stillRendered(a)), `${model.notation}: A's canvas has imported since (the check would see it)`);
      check(shared().includes(to), `${model.notation}: the peer's edit is in the shared text`);
      const fresh = await openPeer(contexts[1]!, model);
      const shapes = await shapeCount(fresh);
      check(
        shapes > shapesBefore,
        `${model.notation}: A's new element is in the shared text (${shapesBefore} → ${shapes} shapes)`,
      );
      for (const [name, peer] of [
        ["A", a],
        ["B", b],
      ] as const) {
        check((await shapeCount(peer)) === shapes, `${model.notation}: ${name}'s canvas shows the shared text`);
        const shown = await toasts(peer);
        check(shown.length === 0, `${model.notation}: no toast on ${name} after the create ${shown.join(" | ")}`);
      }
      check(a.errors.length + b.errors.length === 0, `${model.notation}: no error on A or B after the create`);
      for (const error of [...a.errors, ...b.errors]) console.log(`     ${error}`);
      const createErrors = a.errors.length + b.errors.length;
      await fresh.page.close();
      // fresh pages from here: bpmn-js left its label editor open on A's new element
      await a.page.close();
      await b.page.close();
      const a2 = await openPeer(contexts[0]!, model);
      const b2 = await openPeer(contexts[1]!, model);

      // 4. an armed palette tool holds nothing back
      const toolAt = await emptySpot(a2);
      await a2.page.click(`.djs-palette .entry[data-action="${model.tool}"]`);
      await a2.page.mouse.move(toolAt.x - 40, toolAt.y - 40, { steps: 5 });
      if (model.tool === "hand-tool") {
        // one pan: the hand tool re-arms after it, with no button held
        await a2.page.mouse.move(toolAt.x, toolAt.y, { steps: 5 });
        await a2.page.mouse.down();
        await a2.page.mouse.move(toolAt.x + 30, toolAt.y + 20, { steps: 5 });
        await a2.page.mouse.up();
      }
      await a2.page.mouse.move(toolAt.x + 10, toolAt.y + 10, { steps: 5 });
      check(
        (await dragActive(a2)) && !(await previewDrawn(a2)),
        `${model.notation}: A's ${model.tool} is armed (the drag marker set, no preview)`,
      );
      const beforeTool = await positionIn(a2, model.b);
      await drag(b2, model.b, { x: 30, y: -30 });
      const toolLatency = await latency(a2, model.b, beforeTool, HOLD_PAST_DEBOUNCE + 1000);
      check(
        toolLatency >= 0 && toolLatency <= HOLD_PAST_DEBOUNCE,
        `${model.notation}: B's move reaches A with the tool armed (${toolLatency} ms)`,
      );
      check((await sentEscapes(a2)) === 0, `${model.notation}: no Escape sent to A's page`);
      const toolAfter = (await dragActive(a2)) ? "still armed" : "disarmed by the renderer's import";
      console.log(`     ${model.notation}: A's ${model.tool} after the import: ${toolAfter}`);
      await a2.page.keyboard.press("Escape");

      // 5. a palette create whose preview is not on the canvas yet holds the import back too
      const shapesBefore5 = await shapeCount(a2);
      const createAt5 = await emptySpot(a2);
      await a2.page.click(`.djs-palette .entry[data-action="${model.create}"]`);
      check(
        (await dragActive(a2)) && !(await previewDrawn(a2)),
        `${model.notation}: A's new element waits on the palette (the drag marker set, no preview)`,
      );
      await markRendered(a2, model.a);
      const [titled, retitled] = model.retitle;
      const back = shared().indexOf(retitled);
      check(back >= 0, `${model.notation}: the peer finds "${retitled}"`);
      session.doc.transact(() => {
        session.content.delete(back, retitled.length);
        session.content.insert(back, titled);
      });
      const titledBack = shared();
      await a2.page.waitForTimeout(HOLD_PAST_DEBOUNCE);
      check(
        await stillRendered(a2),
        `${model.notation}: A's canvas waits with the peer's edit, its new element on the palette`,
      );
      await a2.page.mouse.move(createAt5.x - 40, createAt5.y - 40, { steps: 5 });
      await a2.page.mouse.move(createAt5.x, createAt5.y, { steps: 5 });
      check(await previewDrawn(a2), `${model.notation}: then it follows the pointer on the canvas`);
      await a2.page.mouse.down();
      await a2.page.mouse.up();
      check(await waitFor(() => shared() !== titledBack, SETTLE), `${model.notation}: A's new element is written`);
      await a2.page.waitForTimeout(SETTLE);
      await a2.page.keyboard.press("Escape");
      check(!(await stillRendered(a2)), `${model.notation}: A's canvas has imported since`);
      check(
        shared().includes(titled) && !shared().includes(retitled),
        `${model.notation}: the peer's edit is in the shared text`,
      );
      const fresh5 = await openPeer(contexts[1]!, model);
      const shapes5 = await shapeCount(fresh5);
      check(
        shapes5 === shapesBefore5 + 1,
        `${model.notation}: A's new element is in the shared text (${shapesBefore5} → ${shapes5})`,
      );
      for (const [name, peer] of [
        ["A", a2],
        ["B", b2],
      ] as const) {
        check((await shapeCount(peer)) === shapes5, `${model.notation}: ${name}'s canvas shows the shared text`);
        const shown = await toasts(peer);
        check(shown.length === 0, `${model.notation}: no toast on ${name} in 4 and 5 ${shown.join(" | ")}`);
      }
      check(a2.errors.length + b2.errors.length === 0, `${model.notation}: no error on A or B in 4 and 5`);
      for (const error of [...a2.errors, ...b2.errors]) console.log(`     ${error}`);
      await fresh5.page.close();
      await a2.page.close();
      await b2.page.close();

      // 6. edits that touch in the text, on a copy no create has touched
      const touchSession = openLiveSession({
        url: `ws://localhost:${PORT}`,
        room: roomName(REPO, `models/${touchFile(model)}`),
        token: "local",
      });
      try {
        await touchSession.whenSynced(15_000);
        const touchText = (): string => touchSession.content.toString();
        const a6 = await openPeer(contexts[0]!, model, touchFile(model));
        await drag(a6, model.a, { x: 20, y: 20 });
        check(
          await waitFor(() => touchText() !== model.text),
          `${model.notation}: A's first drop on the copy is written`,
        );
        await a6.page.waitForTimeout(SETTLE);
        const b6 = await openPeer(contexts[1]!, model, touchFile(model));
        /** bpmn-js writes a moved shape's DI last; the other notations keep their order */
        const diLast = (): string =>
          touchText().lastIndexOf(`bpmnElement="${model.a}"`) > touchText().lastIndexOf(`bpmnElement="${model.b}"`)
            ? model.a
            : model.b;

        const touches = async (
          what: string,
          bMoves: string,
          begin: () => Promise<void>,
          drop: () => Promise<void>,
          aEditKept: (fresh: Peer) => Promise<boolean>,
        ): Promise<void> => {
          await begin();
          const bStart = await positionIn(b6, bMoves);
          const beforeB6 = touchText();
          await drag(b6, bMoves, { x: 40, y: 50 });
          check(await waitFor(() => touchText() !== beforeB6), `${model.notation} ${what}: B's drop is written`);
          await a6.page.waitForTimeout(HOLD_PAST_DEBOUNCE);
          await drop();
          await a6.page.waitForTimeout(SETTLE);
          await a6.page.keyboard.press("Escape");
          const fresh6 = await openPeer(contexts[1]!, model, touchFile(model));
          const bOnFresh = await positionIn(fresh6, bMoves);
          check(moved(bStart, bOnFresh), `${model.notation} ${what}: B's move stays in the shared text`);
          const kept = await aEditKept(fresh6);
          const shownA = await toasts(a6);
          const gaveWay = shownA.length === 1 && shownA[0]!.includes("could not be merged");
          check(
            kept ? shownA.length === 0 : gaveWay,
            `${model.notation} ${what}: ${kept ? "both edits kept, no toast" : "A's edit gave way, with one toast"} ${shownA.join(" | ")}`,
          );
          const shownB = await toasts(b6);
          check(shownB.length === 0, `${model.notation} ${what}: no toast on B ${shownB.join(" | ")}`);
          const shapes = await shapeCount(fresh6);
          for (const [name, peer] of [
            ["A", a6],
            ["B", b6],
          ] as const) {
            check(
              (await shapeCount(peer)) === shapes && same(await positionIn(peer, bMoves), bOnFresh),
              `${model.notation} ${what}: ${name}'s canvas shows the shared text`,
            );
          }
          check(a6.errors.length + b6.errors.length === 0, `${model.notation} ${what}: no error on A or B`);
          for (const error of [...a6.errors, ...b6.errors]) console.log(`     ${error}`);
          a6.errors.length = 0;
          b6.errors.length = 0;
          touching.push({
            notation: model.notation,
            case: what,
            outcome: kept ? "both kept" : "A's edit gave way (toast)",
          });
          await fresh6.page.close();
        };

        if (model.notation === "bpmn") {
          const first = diLast() === model.a ? model.b : model.a;
          const firstStart = await positionIn(a6, first);
          await touches(
            "move (DI not last) / move",
            diLast(),
            () => startDrag(a6, first, { x: 40, y: 60 }),
            () => a6.page.mouse.up(),
            async (fresh) => moved(firstStart, await positionIn(fresh, first)),
          );
        }
        const listedLast = model.listedLast ?? diLast();
        const shapesBefore6 = await shapeCount(a6);
        const createAt6 = await emptySpot(a6);
        await touches(
          "create / move of the element listed last",
          listedLast,
          async () => {
            await a6.page.click(`.djs-palette .entry[data-action="${model.create}"]`);
            await a6.page.mouse.move(createAt6.x - 40, createAt6.y - 40, { steps: 5 });
            await a6.page.mouse.move(createAt6.x, createAt6.y, { steps: 5 });
            check(await previewDrawn(a6), `${model.notation}: A's new element follows the pointer on the copy`);
          },
          async () => {
            await a6.page.mouse.down();
            await a6.page.mouse.up();
          },
          async (fresh) => (await shapeCount(fresh)) > shapesBefore6,
        );
      } finally {
        touchSession.destroy();
      }

      summary.push({
        notation: model.notation,
        "A moved (shared)": `${show(start.a)} → ${show(onC.a)}`,
        "B moved (shared)": `${show(start.b)} → ${show(onC.b)}`,
        "errors (1)": scenario1.errors,
        "errors (bound)": bound.errors,
        "shapes after create": `${shapesBefore} → ${shapes}`,
        "errors (create)": createErrors,
      });
    } catch (error) {
      check(false, `${model.notation}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      session.destroy();
      for (const context of contexts) await context.close();
    }
  }
  console.log("");
  console.table(summary);
  console.table(touching);
} finally {
  await browser.close();
  host.kill();
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(
  "\nEvery gesture that spanned a peer's change threw nothing and kept the peer's edit; its own edit stayed, or gave way with the toast where the two touch in the text.",
);
