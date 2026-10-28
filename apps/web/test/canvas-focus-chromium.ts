/**
 * The focus after a click on the SPA's chrome (issue 298, guide §5.4 and
 * §5.8) and the keys of a hidden canvas, in the built app, in headless
 * Chromium or WebKit, with the real modelers: bpmn-js, the dmn-js DRD and
 * every Miragon renderer. A check run by hand, not by `pnpm test`, because
 * CI has no browser. The jsdom suites run the rules on the real canvases
 * (test/canvas-focus-dom.test.ts, test/canvas-keys-dom.test.ts) and the
 * toolbar with radix's menu beside a stand-in canvas
 * (test/toolbar-focus-dom.test.ts), never the two together in the live
 * editor. Run it after a change to the editor's toolbar, radix or a
 * renderer, from the repository root, in both engines:
 *
 *   pnpm build
 *   npx -y playwright@1.56.1 install --only-shell chromium     # once
 *   npx -y -p playwright@1.56.1 -c "node apps/web/test/canvas-focus-chromium.ts"
 *
 * BROWSER=webkit runs it in WebKit (`install webkit` instead, once).
 *
 * Safari gives a clicked button no focus: its mousedown takes the focus off
 * whatever held it, so the page has it when the click runs. Chromium and
 * Playwright's WebKit focus the button. Every page here clicks as Safari
 * does (the init script of the modeler shell's e2e/pointer-focus.spec.ts),
 * so a hand-back that waits for the clicked button to hold the focus fails
 * in both engines (Miragon/modeler-suite#165).
 *
 * It starts a Live Host of its own (LIVE_AUTH=none, on PORT, 8393 unless
 * set) on a generated content repo with one model per notation (NOTATIONS,
 * comma-separated, picks some), opens each and checks:
 *
 *  1. The ⋯ menu opened with a click, an entry that keeps it open toggled
 *     with a click where the notation has one (Event Storming's Type
 *     captions, the Context Map's Legend): one click on an element of the
 *     canvas closes the menu, selects the element and leaves the canvas the
 *     focus, Delete deletes it and Cmd/Ctrl+Z brings it back.
 *  2. Escape closes the ⋯ menu and gives its trigger the focus; a click on
 *     Rename… leaves the focus to the dialog's field. Under the modal
 *     Release → PR dialog Cmd/Ctrl+= is not prevented (the browser zooms the
 *     page) and leaves the canvas's view.
 *  3. The view switch: Enter on the source side and then on the canvas side
 *     keeps the focus on the switch, and Delete deletes nothing; a click on
 *     the source side and then on the canvas side hands the canvas the
 *     focus, Delete deletes the selected element and Cmd/Ctrl+Z brings it
 *     back.
 *  4. The canvas behind the source view (the live editor holds no keys):
 *     after a delete on the canvas and a click on the source side, with the
 *     focus on the page and then on the switch, Cmd/Ctrl+Z, Delete,
 *     Backspace (in Chromium), an arrow, Cmd/Ctrl+A and the renderers'
 *     single-key tools change nothing, and Cmd/Ctrl+= is not prevented (the
 *     browser zooms the page) and leaves the view. A click on the canvas
 *     side, then Cmd/Ctrl+Z, undoes the delete.
 *  5. The canvas behind a modal dialog (Release → PR, Rename…): with an
 *     element selected, Tab and Shift+Tab never land on the canvas, and
 *     Cmd/Ctrl+A, Delete and an arrow change nothing, wherever the focus
 *     went. Once the dialog is gone a click on the canvas acts.
 *  6. BPMN's Workshop switch, the toolbar button that changes the canvas for
 *     every participant: a click hands the canvas the focus, Delete deletes
 *     the selected element and Cmd/Ctrl+Z brings it back.
 *
 * No page error and no console error on the way. Exits 1 on any failure.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** the part of Playwright's API this check uses: Playwright is no dependency of the repo */
interface Page {
  goto(url: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  focus(selector: string): Promise<void>;
  close(): Promise<void>;
  mouse: { click(x: number, y: number): Promise<void> };
  keyboard: { press(key: string): Promise<void> };
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<Awaited<R>>;
  waitForFunction<A>(fn: (arg: A) => unknown, arg: A, options: { timeout: number; polling?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  on(event: "pageerror", listener: (error: Error) => void): void;
  on(event: "console", listener: (message: { type(): string; text(): string }) => void): void;
}
interface BrowserType {
  launch(options: { headless: boolean }): Promise<{
    newContext(options: { viewport: { width: number; height: number } }): Promise<{
      addInitScript(script: () => void): Promise<void>;
      newPage(): Promise<Page>;
      close(): Promise<void>;
    }>;
    close(): Promise<void>;
  }>;
}
type Playwright = Record<"chromium" | "webkit", BrowserType>;

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIST = join(ROOT, "apps/web/dist");
const PORT = Number(process.env.PORT ?? 8393);
const engine = process.env.BROWSER === "webkit" ? "webkit" : "chromium";
const BASE = `http://localhost:${PORT}`;
const REPO = "acme/focus";
/** what the canvas, the menu or the switch does on a click or a key has settled by then */
const SETTLE = 400;

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
  /** what the menu case deletes, what the view switch case deletes: diagram-js element ids */
  a: string;
  b: string;
  /** a Model entry of the ⋯ menu that keeps the menu open on a toggle */
  toggle?: string;
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

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const MODELS: Model[] = [
  { notation: "bpmn", fileName: "order.bpmn", text: BPMN, a: "Task_check", b: "Task_ship" },
  {
    notation: "dmn",
    fileName: "credit-limit-check.dmn",
    text: readFileSync(join(ROOT, "process-documentation/processes/credit-limit-check.dmn"), "utf8"),
    a: "InputData_segment",
    b: "InputData_overdue",
  },
  {
    notation: "wardley",
    fileName: "tea.wmap",
    text: "title Tea Shop\ncomponent Cup of Tea [0.79, 0.61]\ncomponent Kettle [0.43, 0.35]\n",
    a: "cmp_cup_of_tea",
    b: "cmp_kettle",
  },
  {
    notation: "event-storming",
    fileName: "checkout.storm",
    text: "title Checkout\ncommand Place Order [240,300]\nevent Order Placed [620,300]\n",
    a: "cmd_place_order",
    b: "event_order_placed",
    toggle: "Type captions",
  },
  {
    notation: "context-map",
    fileName: "conference.cm.json",
    text: json({
      version: 1,
      title: "Conference",
      contexts: [
        { label: "CfP", id: "ctx_cfp", position: { x: 40, y: 40 }, size: { width: 200, height: 110 } },
        { label: "Agenda", id: "ctx_agenda", position: { x: 500, y: 40 }, size: { width: 200, height: 110 } },
      ],
      relationships: [],
    }),
    a: "ctx_cfp",
    b: "ctx_agenda",
    toggle: "Legend",
  },
  {
    notation: "team-topology",
    fileName: "shop.tt",
    text: json({
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
    }),
    a: "team_checkout",
    b: "team_payments",
  },
  {
    notation: "value-chain",
    fileName: "order.vc.json",
    text: json({
      schemaVersion: 1,
      meta: { name: "Order to Cash" },
      elements: [
        { id: "step_order", elementType: "step", name: "Order", bounds: { x: 40, y: 40, width: 240, height: 80 } },
        { id: "step_invoice", elementType: "step", name: "Invoice", bounds: { x: 500, y: 40, width: 240, height: 80 } },
      ],
      connections: [],
    }),
    a: "step_order",
    b: "step_invoice",
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

const failures: string[] = [];
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

/** where the focus is: on the canvas, the ⋯ trigger, a side of the view switch, or what else */
const focused = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return "body";
    if (active.closest(".djs-container")) return "canvas";
    const label = active.getAttribute("aria-label");
    if (active.closest('[role="group"][aria-label="Editor view"]')) return `switch:${label}`;
    if (label === "More") return "trigger";
    return `${active.tagName.toLowerCase()}${label ? `:${label}` : ""}`;
  }, undefined);

const menuOpen = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.querySelector('[role="menu"]') !== null, undefined);

const exists = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((elementId) => document.querySelector(`.djs-element[data-element-id="${elementId}"]`) !== null, id);

const selected = (page: Page, id: string): Promise<boolean> =>
  page.evaluate(
    (elementId) => document.querySelector(`.djs-element.selected[data-element-id="${elementId}"]`) !== null,
    id,
  );

/** clicks the middle of an element's hit area */
async function clickElement(page: Page, id: string): Promise<void> {
  const at = await page.evaluate((elementId) => {
    const hit = document.querySelector(`.djs-element[data-element-id="${elementId}"] > .djs-hit`);
    const box = hit!.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, id);
  await page.mouse.click(at.x, at.y);
}

const SWITCH = '[role="group"][aria-label="Editor view"] button';
const CANVAS_SIDE = `${SWITCH}:first-child`;
const SOURCE_SIDE = `${SWITCH}:last-child`;

/** ⌘ on macOS, Ctrl elsewhere: the modifier of undo, select all and the zoom keys */
const MOD = "ControlOrMeta";

/**
 * Safari's click model, as the modeler shell's e2e/pointer-focus.spec.ts
 * forces it: a pressed button takes no focus, and its mousedown takes the
 * focus off the element that held it. Runs in the page, so it stays
 * self-contained.
 */
function clickButtonsLikeSafari(): void {
  document.addEventListener(
    "mousedown",
    (event) => {
      if (!(event.target instanceof Element) || !event.target.closest("button")) return;
      event.preventDefault();
      (document.activeElement as HTMLElement | SVGElement | null)?.blur();
    },
    true,
  );
}

/** what a key that reached the canvas would change: its shapes, where they are, its view */
const canvasState = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const shapes = [...document.querySelectorAll(".djs-shape[data-element-id]")].map(
      (shape) => `${shape.getAttribute("data-element-id")}@${shape.getAttribute("transform")}`,
    );
    const viewport = document.querySelector(".djs-container > svg .viewport")?.getAttribute("transform");
    return JSON.stringify({ shapes: shapes.sort(), viewport });
  }, undefined);

/** records, at window, whether each keydown was prevented: the browser acts on one that was not */
const recordKeys = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const record = window as unknown as { keysPrevented: boolean[] };
    record.keysPrevented = [];
    window.addEventListener("keydown", (event) => record.keysPrevented.push(event.defaultPrevented));
  }, undefined);

const lastKeyPrevented = (page: Page): Promise<boolean | undefined> =>
  page.evaluate(() => (window as unknown as { keysPrevented: boolean[] }).keysPrevented.at(-1), undefined);

/**
 * keys a canvas acts on: undo, select all, delete, move, and the renderers'
 * single-key tools. Backspace, which the renderers take as Delete, only in
 * Chromium: Playwright's WebKit goes back in the history on a Backspace
 * outside a text field (Safari does not), which would leave the page
 */
const CANVAS_KEYS = [`${MOD}+z`, "Delete", "ArrowRight", `${MOD}+a`, "c", "e", "l", "a"].concat(
  engine === "webkit" ? [] : ["Backspace"],
);

/** how far Tab and Shift+Tab are tried each way: the longest way from a dialog's field to the canvas is 16 presses */
const TAB_PRESSES = 40;

/** whether Tab or Shift+Tab, pressed from where the focus is, ever lands on a canvas */
async function tabReachesCanvas(page: Page): Promise<boolean> {
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let press = 0; press < TAB_PRESSES; press++) {
      await page.keyboard.press(key);
      if ((await focused(page)) === "canvas") return true;
    }
  }
  return false;
}

async function run(page: Page, model: Model): Promise<void> {
  const name = model.notation;

  // 1. a click on the canvas closes the ⋯ menu, acts there and leaves the canvas the focus
  await page.click('button[aria-label="More"]');
  check(await menuOpen(page), `${name}: a click opens the ⋯ menu`);
  if (model.toggle) {
    const entry = `[role="menu"] [role="menuitemcheckbox"]:has-text("${model.toggle}")`;
    const state = (): Promise<string | null> =>
      page.evaluate(
        (label) =>
          [...document.querySelectorAll('[role="menu"] [role="menuitemcheckbox"]')]
            .find((item) => item.textContent?.includes(label))
            ?.getAttribute("aria-checked") ?? null,
        model.toggle!,
      );
    const before = await state();
    await page.click(entry);
    await page.waitForTimeout(SETTLE);
    check(
      (await menuOpen(page)) && (await state()) !== before,
      `${name}: a click on ${model.toggle} toggles it and the menu stays open`,
    );
  }
  await clickElement(page, model.a);
  await page.waitForTimeout(SETTLE);
  check(!(await menuOpen(page)), `${name}: a click on the canvas closes the menu`);
  check(await selected(page, model.a), `${name}: ... and acts there: ${model.a} is selected`);
  const afterMenu = await focused(page);
  check(afterMenu === "canvas", `${name}: ... and the canvas has the focus (${afterMenu})`);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(SETTLE);
  check(!(await exists(page, model.a)), `${name}: Delete deletes ${model.a}`);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(SETTLE);
  check(await exists(page, model.a), `${name}: ... and ${MOD}+Z brings it back`);

  // 2. Escape gives the trigger the focus
  await page.click('button[aria-label="More"]');
  check(await menuOpen(page), `${name}: the ⋯ menu opens again`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(SETTLE);
  const afterEscape = await focused(page);
  check(
    !(await menuOpen(page)) && afterEscape === "trigger",
    `${name}: Escape closes the menu, the trigger has the focus (${afterEscape})`,
  );
  await page.click('button[aria-label="More"]');
  await page.click('[role="menu"] [role="menuitem"]:has-text("Rename…")');
  await page.waitForTimeout(SETTLE);
  const inDialog = await page.evaluate(
    () => document.activeElement?.matches('[role="dialog"] input') ?? false,
    undefined,
  );
  check(inDialog, `${name}: a click on Rename… leaves the focus to the dialog's field`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(SETTLE);
  const view = await canvasState(page);
  await page.click('button[aria-label="More"]');
  await page.click('[role="menu"] [role="menuitem"]:has-text("Release → PR")');
  await page.waitForTimeout(SETTLE);
  const modal = await page.evaluate(
    () => document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
    undefined,
  );
  check(modal, `${name}: Release → PR opens a modal dialog`);
  await page.keyboard.press(`${MOD}+=`);
  check((await lastKeyPrevented(page)) === false, `${name}: ... under it ${MOD}+= is the browser's`);
  await page.waitForTimeout(SETTLE);
  check((await canvasState(page)) === view, `${name}: ... and the canvas keeps its view`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(SETTLE);

  // 3. the view switch: Enter keeps the focus on it, a click hands it to the canvas
  await clickElement(page, model.b);
  await page.waitForTimeout(SETTLE);
  check(await selected(page, model.b), `${name}: ${model.b} is selected`);
  await page.focus(SOURCE_SIDE);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(SETTLE);
  await page.focus(CANVAS_SIDE);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(SETTLE);
  const afterEnter = await focused(page);
  check(afterEnter.startsWith("switch:"), `${name}: Enter on the canvas side keeps the focus there (${afterEnter})`);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(SETTLE);
  check(await exists(page, model.b), `${name}: ... and Delete deletes nothing`);

  await page.click(SOURCE_SIDE);
  await page.waitForTimeout(SETTLE);
  await page.click(CANVAS_SIDE);
  await page.waitForTimeout(SETTLE);
  const afterClick = await focused(page);
  check(afterClick === "canvas", `${name}: a click on the canvas side hands the canvas the focus (${afterClick})`);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(SETTLE);
  check(!(await exists(page, model.b)), `${name}: ... and Delete deletes ${model.b}`);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(SETTLE);
  check(await exists(page, model.b), `${name}: ... and ${MOD}+Z brings it back`);

  // 4. behind the source view the canvas hears no key, wherever the focus is outside it
  await clickElement(page, model.a);
  await page.waitForTimeout(SETTLE);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(SETTLE);
  check(!(await exists(page, model.a)), `${name}: Delete deletes ${model.a}, an edit to undo`);
  await clickElement(page, model.b);
  await page.waitForTimeout(SETTLE);
  check(await selected(page, model.b), `${name}: ${model.b} is selected`);
  const before = await canvasState(page);
  await page.click(SOURCE_SIDE);
  await page.waitForTimeout(SETTLE);
  const afterSource = await focused(page);
  check(afterSource === "body", `${name}: a click on the source side leaves the page the focus (${afterSource})`);
  const url = await page.evaluate(() => location.href, undefined);
  for (const where of ["the page", "the switch"]) {
    if (where === "the switch") await page.focus(SOURCE_SIDE);
    for (const key of CANVAS_KEYS) await page.keyboard.press(key);
    await page.keyboard.press(`${MOD}+=`);
    check((await lastKeyPrevented(page)) === false, `${name}: with the focus on ${where}, ${MOD}+= is the browser's`);
    await page.waitForTimeout(SETTLE);
    check(
      (await canvasState(page)) === before,
      `${name}: with the focus on ${where}, no key reaches the canvas behind the source`,
    );
  }
  check((await page.evaluate(() => location.href, undefined)) === url, `${name}: ... and the page stays`);
  await page.click(CANVAS_SIDE);
  await page.waitForTimeout(SETTLE);
  const backOnCanvas = await focused(page);
  check(backOnCanvas === "canvas", `${name}: a click on the canvas side hands the canvas the focus (${backOnCanvas})`);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(SETTLE);
  check(await exists(page, model.a), `${name}: ... and ${MOD}+Z undoes the delete from before the source view`);

  // 5. behind a modal dialog the canvas is out of reach, and no key edits it
  for (const entry of ["Release → PR", "Rename…"]) {
    if (!(await selected(page, model.b))) {
      await clickElement(page, model.b);
      await page.waitForTimeout(SETTLE);
    }
    check(await selected(page, model.b), `${name}: ${model.b} is selected`);
    const beforeDialog = await canvasState(page);
    await page.click('button[aria-label="More"]');
    await page.click(`[role="menu"] [role="menuitem"]:has-text("${entry}")`);
    await page.waitForTimeout(SETTLE);
    const open = await page.evaluate(
      () => document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
      undefined,
    );
    check(open, `${name}: ${entry} opens a modal dialog`);
    check(!(await tabReachesCanvas(page)), `${name}: behind ${entry}, Tab and Shift+Tab never reach the canvas`);
    for (const key of [`${MOD}+a`, "Delete", "ArrowRight"]) await page.keyboard.press(key);
    await page.waitForTimeout(SETTLE);
    check(
      (await canvasState(page)) === beforeDialog && (await exists(page, model.b)),
      `${name}: behind ${entry}, ${MOD}+A, Delete and an arrow change nothing`,
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(SETTLE);
    check(
      !(await page.evaluate(() => document.querySelector('[role="dialog"]') !== null, undefined)),
      `${name}: Escape closes ${entry}`,
    );
    await clickElement(page, model.a);
    await page.waitForTimeout(SETTLE);
    check(await selected(page, model.a), `${name}: once ${entry} is gone, a click on the canvas acts again`);
  }

  // 6. BPMN's Workshop switch changes the canvas for every participant, so a click on it hands the canvas the focus
  if (model.notation === "bpmn") {
    const workshop = 'button[role="switch"]:has-text("Workshop")';
    await clickElement(page, model.b);
    await page.waitForTimeout(SETTLE);
    check(await selected(page, model.b), `${name}: ${model.b} is selected`);
    await page.click(workshop);
    await page.waitForTimeout(SETTLE);
    const afterSwitch = await focused(page);
    check(
      afterSwitch === "canvas",
      `${name}: a click on the Workshop switch hands the canvas the focus (${afterSwitch})`,
    );
    await page.keyboard.press("Delete");
    await page.waitForTimeout(SETTLE);
    check(!(await exists(page, model.b)), `${name}: ... and Delete deletes ${model.b}`);
    await page.keyboard.press(`${MOD}+z`);
    await page.waitForTimeout(SETTLE);
    check(await exists(page, model.b), `${name}: ... and ${MOD}+Z brings it back`);
    await page.click(workshop);
    await page.waitForTimeout(SETTLE);
  }
}

const playwright = loadPlaywright();
for (const file of ["index.html", "assets"]) {
  if (!existsSync(join(DIST, file))) throw new Error(`apps/web/dist/${file} is missing: run pnpm build first.`);
}
const work = mkdtempSync(join(tmpdir(), "designiq-canvas-focus-"));
mkdirSync(join(work, "content", "models"), { recursive: true });
writeFileSync(join(work, "content", "designiq.yml"), "models: models\n");
for (const model of MODELS) writeFileSync(join(work, "content", "models", model.fileName), model.text);
const host = await startLiveHost(join(work, "content"), join(work, "data"));
const browser = await playwright[engine].launch({ headless: true });

const picked = process.env.NOTATIONS?.split(",");
try {
  for (const model of MODELS.filter(({ notation }) => !picked || picked.includes(notation))) {
    console.log(`\n== ${model.notation} (${model.fileName})`);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(clickButtonsLikeSafari);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      // a failed request is no exception (this host answers the todo API with 501)
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
        errors.push(`console.error: ${message.text()}`);
      }
    });
    try {
      await page.goto(`${BASE}/r/${REPO}/f/models/${model.fileName}`);
      await page.waitForFunction(
        (ids) => ids.every((id) => document.querySelector(`.djs-element[data-element-id="${id}"]`)),
        [model.a, model.b],
        { timeout: 60_000, polling: 100 },
      );
      await page.waitForTimeout(500);
      await recordKeys(page);
      await run(page, model);
      check(errors.length === 0, `${model.notation}: no page error, no console error`);
      for (const error of errors) console.log(`     ${error}`);
    } catch (error) {
      check(false, `${model.notation}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await context.close();
    }
  }
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
  `\nIn ${engine}, clicking as Safari does: a click on the canvas or the view switch's canvas side left every canvas the focus, Enter and Escape kept the guide's, and no key reached a canvas behind the source view or a modal dialog.`,
);
