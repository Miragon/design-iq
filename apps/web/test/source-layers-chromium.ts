/**
 * Monaco's layers against the editor's side panels (issue 288) in the built
 * SPA, in headless Chromium: a check run by hand, not by `pnpm test`, because
 * CI has no browser (test/source-layers.test.ts holds the stylesheet to it).
 * Run it after a monaco-editor bump or a change to the editor's layers, from
 * the repository root:
 *
 *   pnpm build
 *   npx -y playwright@1.56.1 install --only-shell chromium     # once
 *   npx -y -p playwright@1.56.1 -c "node apps/web/test/source-layers-chromium.ts"
 *
 * It starts a Live Host of its own (LIVE_AUTH=none, on PORT, 8393 unless set)
 * on a generated content repo, a Git repository with two commits of a long
 * Markdown document and one of a BPMN process, and checks:
 *
 *  - markdown, xml: the source view (the Markdown document's, the process's
 *    XML) with the History panel open. The panel is the topmost element at
 *    its right edge, where Monaco shows its scrollbar; its header stays over
 *    Monaco's find widget; Monaco's context menu, opened next to the panel,
 *    stays over the part of the panel it reaches into.
 *  - split: the Markdown document in the split view: Monaco's suggestions,
 *    opened at the source pane's right edge, stay over the preview beside it.
 *  - diff: History's Compare: the dialog's Monaco diff is over the panel.
 *
 * Each check first makes sure that what it looks for is on screen where it
 * looks (the scrollbar shown under the panel's edge, the menu reaching into
 * the panel), so no check passes by looking at nothing. Exits 1 on any
 * failure.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** the part of Playwright's API this check uses: Playwright is no dependency of the repo */
interface Locator {
  click(): Promise<void>;
  getByRole(role: string, options?: { name?: string | RegExp }): Locator;
}
interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<Awaited<R>>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  getByRole(role: string, options?: { name?: string | RegExp }): Locator;
  locator(selector: string, options?: { hasText?: string }): Locator;
  mouse: {
    move(x: number, y: number): Promise<void>;
    click(x: number, y: number, options?: { button?: "right" }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> };
  on(event: "pageerror", listener: (error: Error) => void): void;
}
interface BrowserContext {
  newPage(): Promise<Page>;
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
interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIST = join(ROOT, "apps/web/dist");
const PORT = Number(process.env.PORT ?? 8393);
const BASE = `http://localhost:${PORT}`;
const REPO = "acme/source-layers";
const MARKDOWN = "docs/long.md";
const PROCESS = "docs/order-to-cash.bpmn";
const FIRST_COMMIT = "Add the long document";
/** a line that ends right of the split view's source pane middle, short of its edge */
const SUGGEST_LINE = "Suggestions open at the end of this line, right of the middle.";

/** the one npx puts on PATH */
function loadPlaywright(): Playwright {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const bin = join(dir, "playwright");
    if (existsSync(bin)) return createRequire(realpathSync(bin))("playwright") as Playwright;
  }
  throw new Error('No playwright on PATH: run this through npx -p playwright@1.56.1 -c "node …" (see its header).');
}

/** paragraphs that wrap and a document that scrolls: Monaco shows its scrollbar */
function longMarkdown(title: string): string {
  const paragraph = (n: number): string =>
    `Paragraph ${n}: the quick brown fox jumps over the lazy dog, again and again, until the line wraps near the right edge of the editor.`;
  return `# ${title}\n\n${SUGGEST_LINE}\n\n${Array.from({ length: 120 }, (_, n) => paragraph(n)).join("\n\n")}\n`;
}

function writeContentRepo(dir: string): void {
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, "-c", "user.name=Source Layers", "-c", "user.email=check@example.com", ...args]);
  };
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "designiq.yml"), "models: docs\n");
  writeFileSync(join(dir, MARKDOWN), longMarkdown("Long"));
  writeFileSync(
    join(dir, PROCESS),
    readFileSync(join(ROOT, "process-documentation/processes/order-to-cash.bpmn"), "utf8"),
  );
  git("init", "--quiet", "--initial-branch=main");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "--message", FIRST_COMMIT);
  writeFileSync(join(dir, MARKDOWN), longMarkdown("Long, retitled"));
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "--all", "--message", "Retitle the long document");
}

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
const results: Array<{ scenario: string; check: string; ok: boolean; detail: string }> = [];
function check(scenario: string, name: string, ok: boolean, detail = ""): void {
  results.push({ scenario, check: name, ok, detail: detail.slice(0, 80) });
  if (!ok) failures.push(`${scenario}: ${name}${detail ? ` (${detail})` : ""}`);
}

const playwright = loadPlaywright();
if (!existsSync(join(DIST, "index.html"))) {
  throw new Error("apps/web/dist/index.html is missing: run pnpm build first.");
}
const work = mkdtempSync(join(tmpdir(), "designiq-source-layers-"));
writeContentRepo(join(work, "content"));
const host = await startLiveHost(join(work, "content"), join(work, "data"));
const browser = await playwright.chromium.launch({ headless: true });
const pageErrors: string[] = [];

const boxOf = (page: Page, selector: string): Promise<Box | null> =>
  page.evaluate((s) => {
    const box = document.querySelector(s)?.getBoundingClientRect();
    return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null;
  }, selector);

/** a model in a fresh context, in one of its views (the view switch's button name) */
async function open(path: string, view: string): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(`${BASE}/r/${REPO}/f/${path}`);
  await page.waitForSelector('[role="group"][aria-label="Editor view"]', { timeout: 30_000 });
  await page.getByRole("group", { name: "Editor view" }).getByRole("button", { name: view }).click();
  await page.waitForSelector(".monaco-host .view-line", { timeout: 15_000 });
  await page.waitForTimeout(500);
  return { page, context };
}

async function openHistory(page: Page): Promise<Box> {
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitemcheckbox", { name: /History/ }).click();
  await page.waitForSelector("aside button[aria-expanded]", { timeout: 15_000 });
  const panel = await boxOf(page, "aside");
  if (!panel) throw new Error("The History panel did not open");
  return panel;
}

/** the panel over Monaco's frame: its scrollbar, its find widget, and its context menu over the panel */
async function sourceUnderPanel(scenario: string, path: string, view: string): Promise<void> {
  const { page, context } = await open(path, view);
  const panel = await openHistory(page);
  // over the text left of the panel and scrolled once, Monaco shows its scrollbar
  await page.mouse.move(panel.left - 200, (panel.top + panel.bottom) / 2);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(400);
  const edge = await page.evaluate(
    ({ x, ys }) => {
      const bar = document.querySelector(".monaco-host .scrollbar.vertical");
      const box = bar?.getBoundingClientRect();
      return {
        shown: !!box && bar!.classList.contains("visible") && box.left <= x && x <= box.right,
        topmost: ys.map((y) => !!document.elementFromPoint(x, y)?.closest("aside")),
      };
    },
    { x: panel.right - 4, ys: [0.25, 0.5, 0.75].map((f) => panel.top + (panel.bottom - panel.top) * f) },
  );
  check(scenario, "precondition: Monaco shows its scrollbar under the panel's right edge", edge.shown);
  check(scenario, "the panel is topmost at its right edge", edge.topmost.every(Boolean), JSON.stringify(edge.topmost));

  await page.mouse.click(panel.left - 200, (panel.top + panel.bottom) / 2);
  await page.keyboard.press("ControlOrMeta+f");
  await page.waitForTimeout(400);
  const find = await page.evaluate(() => {
    const widget = document.querySelector(".monaco-host .find-widget.visible")?.getBoundingClientRect();
    const header = document.querySelector("aside > div")?.getBoundingClientRect();
    if (!widget || !header) return null;
    const left = Math.max(widget.left, header.left);
    const right = Math.min(widget.right, header.right);
    const top = Math.max(widget.top, header.top);
    const bottom = Math.min(widget.bottom, header.bottom);
    if (right - left < 8 || bottom - top < 8) return { overlaps: false, topmost: false };
    return {
      overlaps: true,
      topmost: !!document.elementFromPoint((left + right) / 2, (top + bottom) / 2)?.closest("aside"),
    };
  }, 0);
  check(scenario, "precondition: Monaco's find widget reaches under the panel's header", find?.overlaps === true);
  check(scenario, "the panel's header stays over the find widget", find?.topmost === true);
  await page.keyboard.press("Escape");

  await page.mouse.click(panel.left - 40, (panel.top + panel.bottom) / 2, { button: "right" });
  await page.waitForTimeout(400);
  const menu = await page.evaluate((panelLeft) => {
    for (const shadowHost of document.querySelectorAll(".monaco-host .shadow-root-host")) {
      const box = shadowHost.shadowRoot?.querySelector(".context-view")?.getBoundingClientRect();
      if (!box || box.width === 0) continue;
      const x = (Math.max(box.left, panelLeft) + box.right) / 2;
      // a point in a shadow tree hits its host
      return { reaches: box.right > panelLeft + 8, topmost: document.elementFromPoint(x, box.top + 12) === shadowHost };
    }
    return null;
  }, panel.left);
  check(scenario, "precondition: Monaco's context menu reaches into the panel", menu?.reaches === true);
  check(scenario, "the context menu stays over the panel", menu?.topmost === true);
  await page.keyboard.press("Escape");
  await context.close();
}

/** Monaco's suggestions at the source pane's right edge, over the preview beside it */
async function split(): Promise<void> {
  const { page, context } = await open(MARKDOWN, "Split");
  const pane = await boxOf(page, ".monaco-host");
  const row = await page.evaluate((text) => {
    const line = [...document.querySelectorAll(".monaco-host .view-line")].find(
      (candidate) => candidate.textContent?.replace(/\u00a0/g, " ") === text,
    );
    const box = line?.getBoundingClientRect();
    return box ? (box.top + box.bottom) / 2 : null;
  }, SUGGEST_LINE);
  if (!pane || row === null) throw new Error("The split view's source does not show the line to suggest at");
  // right of the line's end: the caret goes to its end
  await page.mouse.click(pane.right - 60, row);
  await page.keyboard.type(" qu");
  await page.keyboard.press("Control+Space");
  await page.waitForSelector(".monaco-host .suggest-widget.visible", { timeout: 5000 });
  await page.waitForTimeout(300);
  const suggest = await page.evaluate((paneRight) => {
    const box = document.querySelector(".monaco-host .suggest-widget.visible")!.getBoundingClientRect();
    const x = paneRight + 20;
    return {
      reaches: box.right > x + 8,
      detail: `suggestions ${Math.round(box.left)}–${Math.round(box.right)}, source pane to ${Math.round(paneRight)}`,
      topmost: !!document.elementFromPoint(x, box.top + 10)?.closest(".monaco-host .suggest-widget"),
    };
  }, pane.right);
  check("split", "precondition: Monaco's suggestions reach past the source pane", suggest.reaches, suggest.detail);
  check("split", "the suggestions stay over the preview", suggest.topmost);
  await context.close();
}

/** History's Compare: a modal Monaco diff, which no panel overlaps */
async function diff(): Promise<void> {
  const { page, context } = await open(MARKDOWN, "Markdown");
  const panel = await openHistory(page);
  await page.locator("aside button[aria-expanded]", { hasText: FIRST_COMMIT }).click();
  await page.locator("aside").getByRole("button", { name: "Compare" }).click();
  await page.waitForSelector(".monaco-diff-editor .view-line", { timeout: 15_000 });
  await page.waitForTimeout(500);
  const over = await page.evaluate((panelBox) => {
    const box = document.querySelector(".monaco-diff-editor")!.getBoundingClientRect();
    const x = (Math.max(box.left, panelBox.left) + Math.min(box.right, panelBox.right)) / 2;
    const y = (box.top + box.bottom) / 2;
    return {
      overlaps: box.right > panelBox.left + 8,
      topmost: !!document.elementFromPoint(x, y)?.closest(".monaco-diff-editor"),
    };
  }, panel);
  check("diff", "precondition: the diff dialog lies over the open panel", over.overlaps);
  check("diff", "the dialog's Monaco diff is topmost there", over.topmost);
  await context.close();
}

try {
  await sourceUnderPanel("markdown", MARKDOWN, "Markdown");
  await sourceUnderPanel("xml", PROCESS, "XML");
  await split();
  await diff();
  check("all", "no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  console.table(results);
} finally {
  await browser.close();
  host.kill();
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nAll ${results.length} checks passed.`);
