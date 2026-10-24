/**
 * The focus after a click on the SPA's chrome (issue 298, guide §5.4 and
 * §5.8) in the built app, in headless Chromium, with the real modelers:
 * bpmn-js, the dmn-js DRD and every Miragon renderer. A check run by hand,
 * not by `pnpm test`, because CI has no browser; the jsdom suite
 * (test/canvas-focus-dom.test.ts) runs the rules on the real canvases, not
 * the React chrome and radix's menu around them. Run it after a change to
 * the editor's toolbar, radix or a renderer, from the repository root:
 *
 *   pnpm build
 *   npx -y playwright@1.56.1 install --only-shell chromium     # once
 *   npx -y -p playwright@1.56.1 -c "node apps/web/test/canvas-focus-chromium.ts"
 *
 * It starts a Live Host of its own (LIVE_AUTH=none, on PORT, 8393 unless
 * set) on a generated content repo with one model per notation (NOTATIONS,
 * comma-separated, picks some), opens each and checks:
 *
 *  1. The ⋯ menu opened with a click, an entry that keeps it open toggled
 *     with a click where the notation has one (Event Storming's Type
 *     captions, the Context Map's Legend): one click on an element of the
 *     canvas closes the menu, selects the element and leaves the canvas the
 *     focus, and Delete deletes it.
 *  2. Escape closes the ⋯ menu and gives its trigger the focus; a click on
 *     Rename… leaves the focus to the dialog's field.
 *  3. The view switch: Enter on the source side and then on the canvas side
 *     keeps the focus on the switch, and Delete deletes nothing; a click on
 *     the source side and then on the canvas side hands the canvas the
 *     focus, and Delete deletes the selected element.
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
interface Playwright {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newContext(options: { viewport: { width: number; height: number } }): Promise<{
        newPage(): Promise<Page>;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }>;
  };
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIST = join(ROOT, "apps/web/dist");
const PORT = Number(process.env.PORT ?? 8393);
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
const browser = await playwright.chromium.launch({ headless: true });

const picked = process.env.NOTATIONS?.split(",");
try {
  for (const model of MODELS.filter(({ notation }) => !picked || picked.includes(notation))) {
    console.log(`\n== ${model.notation} (${model.fileName})`);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
  "\nA click on the canvas or the view switch's canvas side left every canvas the focus; Enter and Escape kept the guide's.",
);
