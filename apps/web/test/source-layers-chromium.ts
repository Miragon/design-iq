/**
 * Monaco's layers against the editor's side panels (issue 288) in the built
 * SPA, in headless Chromium: a check run by hand, not by `pnpm test`, because
 * CI has no browser (test/source-layers.test.ts and test/side-panel-room.test.ts
 * hold the stylesheet and the layout to it).
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
 *    XML) with the History panel open. Monaco is laid out beside the panel:
 *    its scrollbar and lines end left of it, and the panel is the topmost
 *    element at its right edge; Monaco's find widget lies left of it, each of
 *    its controls takes the pointer and, reached with Tab, is on screen;
 *    Monaco's context menu, opened next to the panel, stays over the part of
 *    the panel it reaches into; closed, the panel gives Monaco its width back.
 *  - split: the Markdown document in the split view: Monaco's suggestions,
 *    opened at the source pane's right edge, stay over the preview beside it.
 *  - diff: History's Compare: the dialog's Monaco diff is over the panel.
 *  - zoomed: the process's diagram and XML views in a window whose zoom lays
 *    the source's host out to a fraction of a pixel, once with classic
 *    scrollbars (Playwright hides them; a styled one takes room on every
 *    platform) and once with hidden ones, like macOS's overlay scrollbars.
 *    Monaco, laid out behind the diagram too, ends inside its host in every
 *    frame, so the page has nothing to scroll; the toolbar, the bpmn.io logo
 *    and the page hold still frame after frame, and a wheel over the toolbar
 *    or the logo scrolls nothing. Monaco half a pixel past its host made the
 *    page's classic scrollbar show and hide every frame, shaking both, and
 *    let a wheel scroll the page by a pixel (#326). In the XML view, with
 *    History open, Monaco ends at the panel's left edge: the zoom scales the
 *    panel's bounding box, not the pixels Monaco is laid out in.
 *
 * Each check first makes sure that what it looks for is on screen (the
 * scrollbar shown, the find widget open with its controls, the menu reaching
 * into the panel, a zoom whose host rounds up to a pixel more), so no check
 * passes by looking at nothing. Exits 1 on any failure.
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
interface Browser {
  newContext(options: { viewport: { width: number; height: number } }): Promise<BrowserContext>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: {
    launch(options: { headless: boolean; ignoreDefaultArgs?: string[] }): Promise<Browser>;
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
async function open(
  path: string,
  view: string,
  { from = browser, viewport = { width: 1440, height: 900 } } = {},
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await from.newContext({ viewport });
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

/**
 * The source beside the panel: Monaco's scrollbar, find widget and lines stay
 * left of it, so every control of the find widget takes the pointer and shows
 * the focus; its context menu stays over the panel
 */
async function sourceBesidePanel(scenario: string, path: string, view: string): Promise<void> {
  const { page, context } = await open(path, view);
  const panel = await openHistory(page);
  // over the text left of the panel and scrolled once, Monaco shows its scrollbar
  await page.mouse.move(panel.left - 200, (panel.top + panel.bottom) / 2);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(400);
  const edge = await page.evaluate(
    ({ panelLeft, x, ys }) => {
      const bar = document.querySelector(".monaco-host .scrollbar.vertical");
      const barBox = bar?.getBoundingClientRect();
      const editor = document.querySelector(".monaco-host .monaco-editor")!.getBoundingClientRect();
      return {
        shown: !!barBox && bar!.classList.contains("visible") && barBox.width > 0,
        besidePanel: !!barBox && barBox.right <= panelLeft + 1 && editor.right <= panelLeft + 1,
        detail: `scrollbar to ${Math.round(barBox?.right ?? -1)}, editor to ${Math.round(editor.right)}, panel from ${Math.round(panelLeft)}`,
        topmost: ys.map((y) => !!document.elementFromPoint(x, y)?.closest("aside")),
      };
    },
    {
      panelLeft: panel.left,
      x: panel.right - 4,
      ys: [0.25, 0.5, 0.75].map((f) => panel.top + (panel.bottom - panel.top) * f),
    },
  );
  check(scenario, "precondition: Monaco shows its scrollbar", edge.shown);
  check(scenario, "Monaco's scrollbar and lines end left of the panel", edge.besidePanel, edge.detail);
  check(scenario, "the panel is topmost at its right edge", edge.topmost.every(Boolean), JSON.stringify(edge.topmost));

  await page.mouse.click(panel.left - 200, (panel.top + panel.bottom) / 2);
  await page.keyboard.press("ControlOrMeta+f");
  await page.waitForTimeout(400);
  const find = await page.evaluate((panelLeft) => {
    const widget = document.querySelector(".monaco-host .find-widget.visible");
    if (!widget) return null;
    const controls = [...widget.querySelectorAll("textarea, input, [role='button'], [role='checkbox'], .matchesCount")]
      .filter((control) => control.getBoundingClientRect().width > 0)
      .map((control) => {
        const box = control.getBoundingClientRect();
        const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
        const name = control.getAttribute("aria-label") ?? control.getAttribute("title") ?? control.className;
        return { name, ok: box.right <= panelLeft + 1 && !!hit && widget.contains(hit) };
      });
    return { right: widget.getBoundingClientRect().right, controls };
  }, panel.left);
  check(scenario, "precondition: Monaco's find widget opens with its controls", (find?.controls.length ?? 0) >= 6);
  check(
    scenario,
    "the find widget lies left of the panel",
    !!find && find.right <= panel.left + 1,
    `to ${Math.round(find?.right ?? -1)}, panel from ${Math.round(panel.left)}`,
  );
  const hidden = find?.controls.filter((control) => !control.ok).map((control) => control.name) ?? [];
  check(
    scenario,
    "every control of the find widget lies left of the panel and takes the pointer",
    hidden.length === 0,
    hidden.join(", "),
  );
  // the keyboard's way through the widget, from its input until the focus leaves it
  const tabbed: Array<{ name: string; ok: boolean }> = [];
  for (let step = 0; step < 12; step++) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate((panelLeft) => {
      const control = document.activeElement;
      if (!control?.closest(".monaco-host .find-widget")) return null;
      const box = control.getBoundingClientRect();
      const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      const name = control.getAttribute("aria-label") ?? control.getAttribute("title") ?? control.tagName;
      return { name, ok: box.width > 0 && box.right <= panelLeft + 1 && !!hit && control.contains(hit) };
    }, panel.left);
    if (!focused) break;
    tabbed.push(focused);
  }
  const unseen = tabbed.filter((control) => !control.ok).map((control) => control.name);
  check(
    scenario,
    "precondition: Tab moves through the find widget's controls",
    tabbed.length >= 4,
    String(tabbed.length),
  );
  check(
    scenario,
    "every control Tab reaches lies left of the panel and is topmost",
    unseen.length === 0,
    unseen.join(", "),
  );
  // the focus has left the widget: back in the text, Escape closes it
  await page.mouse.click(panel.left - 200, (panel.top + panel.bottom) / 2);
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

  await page.locator("aside").getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(300);
  const filled = await page.evaluate(() => {
    const host = document.querySelector(".monaco-host")!.getBoundingClientRect();
    const editor = document.querySelector(".monaco-host .monaco-editor")!.getBoundingClientRect();
    return {
      ok: Math.abs(host.right - editor.right) <= 1,
      detail: `editor to ${Math.round(editor.right)}, source to ${Math.round(host.right)}`,
    };
  }, 0);
  check(scenario, "with the panel closed, Monaco fills the source again", filled.ok, filled.detail);
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

/** zooms tried until one lays the source's host out to a fraction of a pixel that rounds up */
const ZOOMS = [1.1, 1.15, 1.2, 1.3, 1.4, 1.5, 0.9, 0.8];

/**
 * A zoomed window: Monaco ends inside its host in every frame, the page has
 * nothing to scroll, the toolbar and the bpmn.io logo hold still, and a wheel
 * over them scrolls nothing. With classic scrollbars a Monaco past its host
 * shows and hides the page's scrollbar every frame; with hidden ones (macOS's
 * overlay scrollbars take no room either) a wheel scrolls the page by a pixel
 */
async function zoomed(view: string, scrollbars: "classic" | "hidden"): Promise<void> {
  const scenario = `zoomed ${view.toLowerCase()}, ${scrollbars}`;
  const from =
    scrollbars === "classic"
      ? await playwright.chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] })
      : browser;
  try {
    const { page, context } = await open(PROCESS, view, { from, viewport: { width: 1280, height: 800 } });
    if (scrollbars === "classic") {
      const room = await page.evaluate(() => {
        const style = document.createElement("style");
        style.textContent = "::-webkit-scrollbar { width: 15px; height: 15px; }";
        document.head.append(style);
        const probe = document.createElement("div");
        probe.style.cssText = "position: absolute; width: 100px; height: 100px; overflow: scroll;";
        document.body.append(probe);
        const taken = probe.offsetWidth - probe.clientWidth;
        probe.remove();
        return taken;
      }, 0);
      check(scenario, "precondition: the page's scrollbars take room", room > 0, `${room}px`);
    }

    const zoomTo = (z: number): Promise<void> =>
      page.evaluate((zoom) => {
        document.documentElement.style.zoom = zoom === 1 ? "" : String(zoom);
      }, z);
    let roundsUp: { zoom: number; detail: string } | undefined;
    for (const candidate of ZOOMS) {
      await zoomTo(candidate);
      await page.waitForTimeout(300);
      const host = await page.evaluate((z) => {
        const source = document.querySelector<HTMLElement>(".monaco-host")!;
        const style = getComputedStyle(source);
        const roundedUp = Math.max(
          source.clientWidth - Number.parseFloat(style.width),
          source.clientHeight - Number.parseFloat(style.height),
        );
        return { roundsUp: roundedUp * z > 0.5, detail: `${style.width}×${style.height} at ${Math.round(z * 100)} %` };
      }, candidate);
      if (host.roundsUp) {
        roundsUp = { zoom: candidate, detail: host.detail };
        break;
      }
    }
    check(
      scenario,
      "precondition: a zoom lays the source's host out to a fraction that rounds up past half a pixel",
      roundsUp !== undefined,
      roundsUp?.detail,
    );
    if (roundsUp === undefined) {
      await context.close();
      return;
    }

    // sampled in every frame: a Monaco past its host shows only in every other one
    const frames = await page.evaluate(async () => {
      const at = (selector: string): string => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box ? `${box.left.toFixed(1)},${box.top.toFixed(1)}` : "none";
      };
      const seen = { more: new Set<string>(), logo: new Set<string>(), page: new Set<string>() };
      const outside: string[] = [];
      const scrollable: string[] = [];
      for (let frame = 0; frame < 30; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const root = document.documentElement;
        const host = document.querySelector(".monaco-host")!.getBoundingClientRect();
        const editor = document.querySelector(".monaco-host .monaco-editor")!.getBoundingClientRect();
        if (editor.right > host.right + 0.01 || editor.bottom > host.bottom + 0.01) {
          outside.push(
            `editor to ${editor.right.toFixed(2)}, ${editor.bottom.toFixed(2)}, host to ${host.right.toFixed(2)}, ${host.bottom.toFixed(2)}`,
          );
        }
        if (root.scrollWidth > root.clientWidth || root.scrollHeight > root.clientHeight) {
          scrollable.push(`${root.scrollWidth}×${root.scrollHeight} in ${root.clientWidth}×${root.clientHeight}`);
        }
        seen.more.add(at('button[aria-label="More"]'));
        seen.logo.add(at(".bjs-powered-by"));
        seen.page.add(`${root.clientWidth}×${root.clientHeight}`);
      }
      return { more: [...seen.more], logo: [...seen.logo], page: [...seen.page], outside, scrollable };
    }, 0);
    check(
      scenario,
      "precondition: the toolbar's More and the bpmn.io logo are laid out",
      !frames.more.includes("none") && !frames.logo.includes("none"),
    );
    check(scenario, "Monaco ends inside its host in every frame", frames.outside.length === 0, frames.outside[0]);
    check(
      scenario,
      "the page has nothing to scroll in any frame",
      frames.scrollable.length === 0,
      frames.scrollable[0],
    );
    check(
      scenario,
      "the toolbar, the logo and the page hold still frame after frame",
      frames.more.length === 1 && frames.logo.length === 1 && frames.page.length === 1,
      `More at ${frames.more.join(" | ")}; logo at ${frames.logo.join(" | ")}; page ${frames.page.join(" | ")}`,
    );

    const spots = await page.evaluate(() => {
      const centre = (selector: string): { x: number; y: number } | null => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box ? { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 } : null;
      };
      return { toolbar: centre('[role="group"][aria-label="Editor view"]'), logo: centre(".bjs-powered-by") };
    }, 0);
    // under the source the canvas, and with it the logo, takes no pointer
    const wheeled = view === "Diagram" ? [spots.toolbar, spots.logo] : [spots.toolbar];
    for (const spot of wheeled) {
      if (!spot) continue;
      await page.mouse.move(spot.x, spot.y);
      for (let tick = 0; tick < 4; tick++) await page.mouse.wheel(0, 120);
    }
    await page.waitForTimeout(300);
    const scrolled = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }), 0);
    check(
      scenario,
      "a wheel over the toolbar or the logo scrolls nothing",
      scrolled.x === 0 && scrolled.y === 0,
      `scrolled to ${scrolled.x}, ${scrolled.y}`,
    );

    if (view === "XML") {
      // opened at 100 %: on a toolbar that shakes, no click on More lands
      await zoomTo(1);
      await openHistory(page);
      // the zoom scales the panel's bounding box, not the 320px Monaco is laid out beside
      await zoomTo(roundsUp.zoom);
      await page.waitForTimeout(300);
      const beside = await page.evaluate(async () => {
        const off: string[] = [];
        let scrollable = 0;
        for (let frame = 0; frame < 10; frame++) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const panel = document.querySelector("aside")!.getBoundingClientRect();
          const editor = document.querySelector(".monaco-host .monaco-editor")!.getBoundingClientRect();
          const gap = panel.left - editor.right;
          if (gap <= -0.01 || gap >= 1.5)
            off.push(`editor to ${editor.right.toFixed(2)}, panel from ${panel.left.toFixed(2)}`);
          const root = document.documentElement;
          if (root.scrollWidth > root.clientWidth || root.scrollHeight > root.clientHeight) scrollable++;
        }
        return { off, scrollable };
      }, 0);
      check(
        scenario,
        "with History open, Monaco ends at the panel's left edge, neither under it nor short of it",
        beside.off.length === 0,
        beside.off[0],
      );
      check(
        scenario,
        "with History open, the page has nothing to scroll",
        beside.scrollable === 0,
        `${beside.scrollable} of 10 frames`,
      );
    }
    await context.close();
  } finally {
    if (from !== browser) await from.close();
  }
}

try {
  await sourceBesidePanel("markdown", MARKDOWN, "Markdown");
  await sourceBesidePanel("xml", PROCESS, "XML");
  await split();
  await diff();
  for (const view of ["Diagram", "XML"]) {
    await zoomed(view, "classic");
    await zoomed(view, "hidden");
  }
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
