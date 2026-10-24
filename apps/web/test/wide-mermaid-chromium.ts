/**
 * Wide Mermaid diagrams in the Markdown view (issue 292), in headless
 * Chromium: a check run by hand, not by `pnpm test`, because CI has no
 * browser. markdown-diagram-scale.test.ts pins the scale computation under
 * jsdom; jsdom lays nothing out, so what a reader gets is checked here. Run
 * it after a change to the Markdown view, its fences or a mermaid update,
 * from the repository root:
 *
 *   pnpm build
 *   npx -y playwright@1.56.1 install --only-shell chromium     # once
 *   npx -y -p playwright@1.56.1 -c "node apps/web/test/wide-mermaid-chromium.ts"
 *
 * It starts a Live Host of its own (LIVE_AUTH=none, on PORT, 8394 unless set)
 * on a generated content repo with one document: a wide C4 context, a wide
 * flowchart, two Gantt charts (one in a quote), a medium and a small
 * flowchart. In the SPA's preview it checks:
 *
 *  - every text a diagram shows reads at 13px or more on screen;
 *  - the wide C4 and the wide flowchart scroll sideways in their block, the
 *    page does not, and each is a region with a name of its own;
 *  - each Gantt chart is laid out narrower than its block, so that with its
 *    10px axis labels at 13px it fits the block, and is no tab stop;
 *  - Tab reaches the two wide ones from the document and no diagram that
 *    fits, an arrow key scrolls the focused one, which shows the focus ring
 *    of §8, at full strength also while its drawing is dimmed;
 *  - the medium flowchart fits a wide window and turns into a scroll region
 *    in a narrow one.
 *
 * A control shows that without the minimum width the wide flowchart's
 * labels would read under 13px. Exits 1 on any failed check.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SMALLEST_TEXT_PX } from "../src/notations/markdown/diagram-scale.ts";

/** the part of Playwright's API this check uses: Playwright is no dependency of the repo */
interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<Awaited<R>>;
  waitForFunction<A>(fn: (arg: A) => unknown, arg: A, options: { timeout: number; polling?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  on(event: "pageerror", listener: (error: Error) => void): void;
}
interface Playwright {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newContext(options: { viewport: { width: number; height: number } }): Promise<{ newPage(): Promise<Page> }>;
      close(): Promise<void>;
    }>;
  };
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIST = join(ROOT, "apps/web/dist");
const PORT = Number(process.env.PORT ?? 8394);
const BASE = `http://localhost:${PORT}`;
const REPO = "acme/wide";
const PATH = "docs/wide.md";

const step = (i: number): string => `  N${i}["Step ${i} of the order flow"]`;
const DIAGRAMS = {
  "wide C4": [
    "C4Context",
    "  title System context of the order platform",
    '  UpdateLayoutConfig($c4ShapeInRow="6", $c4BoundaryInRow="1")',
    '  Person(customer, "Customer", "Places orders online")',
    '  Person(agent, "Support agent", "Helps customers")',
    '  System(shop, "Web shop", "Sells products")',
    '  System(orders, "Order service", "Takes and tracks orders")',
    '  System_Ext(payment, "Payment provider", "Charges cards")',
    '  System_Ext(mail, "Mail service", "Sends confirmations")',
    '  Rel(customer, shop, "Orders with")',
    '  Rel(agent, orders, "Looks up")',
    '  Rel(shop, orders, "Hands orders to")',
    '  Rel(orders, payment, "Charges through")',
    '  Rel(orders, mail, "Sends mail through")',
  ].join("\n"),
  "wide flowchart": [
    "flowchart LR",
    "  accTitle: Order flow",
    ...Array.from({ length: 14 }, (_, i) => step(i)),
    ...Array.from({ length: 13 }, (_, i) => `  N${i} -->|next| N${i + 1}`),
  ].join("\n"),
  gantt: [
    "gantt",
    "  title Release plan",
    "  dateFormat YYYY-MM-DD",
    "  section Build",
    "  Design :a1, 2026-01-01, 10d",
    "  Code :after a1, 20d",
  ].join("\n"),
  "quoted gantt": [
    "gantt",
    "  title Quoted release plan",
    "  dateFormat YYYY-MM-DD",
    "  section Build",
    "  Design :a1, 2026-02-01, 10d",
    "  Code :after a1, 20d",
  ].join("\n"),
  "medium flowchart": "flowchart LR\n  A[Draft] --> B[Review] --> C[Release]",
  "small flowchart": "flowchart LR\n  A[Start] --> B[End]",
};
type Name = keyof typeof DIAGRAMS;
const NAMES = Object.keys(DIAGRAMS) as Name[];
const WIDE: Name[] = ["wide C4", "wide flowchart"];
const GANTT: Name[] = ["gantt", "quoted gantt"];
const FITTING: Name[] = [...GANTT, "medium flowchart", "small flowchart"];
/** what a screen reader announces for each wide one: its place, and its accTitle or its type */
const REGION_NAMES: Partial<Record<Name, string>> = {
  "wide C4": "Diagram 1 (C4), scrolls sideways",
  "wide flowchart": "Diagram 2: Order flow, scrolls sideways",
  "medium flowchart": "Diagram 5 (flowchart), scrolls sideways",
};
const fenced = (name: Name): string => {
  const block = `\`\`\`mermaid\n${DIAGRAMS[name]}\n\`\`\``;
  return name === "quoted gantt" ? block.replace(/^/gm, "> ") : block;
};
const DOCUMENT = [
  "# Wide diagrams\n",
  "A document whose diagrams are wider than its column.\n",
  ...NAMES.map((name) => `## ${name}\n\n${fenced(name)}\n`),
  "The end.\n",
].join("\n");
/** --ring, the guide's focus colour on light (blau-link) */
const FOCUS_RING = "rgb(43, 80, 212)";

/** the one npx puts on PATH */
function loadPlaywright(): Playwright {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const bin = join(dir, "playwright");
    if (existsSync(bin)) return createRequire(realpathSync(bin))("playwright") as Playwright;
  }
  throw new Error('No playwright on PATH: run this through npx -p playwright@1.56.1 -c "node …" (see its header).');
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
    const up = await fetch(`${BASE}/mermaid-frame.html`).then(
      (res) => res.ok,
      () => false,
    );
    if (up) return host;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  host.kill();
  throw new Error(`The Live Host did not start on ${BASE}:\n${log}`);
}

/** what the page shows of each diagram, in document order */
interface Shown {
  /** the SVG's own width (its viewBox), its width on screen and its block's */
  natural: number;
  drawn: number;
  block: number;
  /** the smallest text it shows, in CSS pixels on screen */
  smallestText: number;
  scrollWidth: number;
  clientWidth: number;
  tabIndex: string | null;
  role: string | null;
  label: string | null;
}

/** runs in the page: the smallest text on screen comes from each text's own transform, not from the viewBox */
function measure(): { diagrams: Shown[]; column: number; pageScrolls: boolean } {
  const figures = [...document.querySelectorAll<HTMLElement>(".md-mermaid-diagram")];
  const diagrams = figures.map((figure) => {
    const svg = figure.querySelector("svg")!;
    let smallestText = Infinity;
    const walker = document.createTreeWalker(svg, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || !node.textContent?.trim() || element.closest("style, title, desc")) continue;
      if (element.getClientRects().length === 0) continue;
      const graphic = element.closest<SVGGraphicsElement>("text, foreignObject");
      const ctm = graphic?.getScreenCTM();
      // rotated text (a git graph's commit ids, an axis title) scales by the length of the turned unit vector
      const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
      smallestText = Math.min(smallestText, parseFloat(getComputedStyle(element).fontSize) * scale);
    }
    return {
      natural: svg.viewBox.baseVal.width,
      drawn: svg.getBoundingClientRect().width,
      block: figure.parentElement!.clientWidth,
      smallestText,
      scrollWidth: figure.scrollWidth,
      clientWidth: figure.clientWidth,
      tabIndex: figure.getAttribute("tabindex"),
      role: figure.getAttribute("role"),
      label: figure.getAttribute("aria-label"),
    };
  });
  const view = document.querySelector<HTMLElement>(".markdown-view")!;
  const column = document.querySelector<HTMLElement>(".md-mermaid-block")!.clientWidth;
  return { diagrams, column, pageScrolls: view.scrollWidth > view.clientWidth };
}

const failures: string[] = [];
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const px = (n: number): string => `${Math.round(n * 10) / 10}px`;

const playwright = loadPlaywright();
for (const file of ["index.html", "mermaid-frame.html"]) {
  if (!existsSync(join(DIST, file))) throw new Error(`apps/web/dist/${file} is missing: run pnpm build first.`);
}
const work = mkdtempSync(join(tmpdir(), "designiq-wide-mermaid-"));
mkdirSync(join(work, "content", "docs"), { recursive: true });
writeFileSync(join(work, "content", "designiq.yml"), "models: docs\n");
writeFileSync(join(work, "content", PATH), DOCUMENT);
const host = await startLiveHost(join(work, "content"), join(work, "data"));
const browser = await playwright.chromium.launch({ headless: true });

try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await page.goto(`${BASE}/r/${REPO}/f/${PATH}`);
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll(".md-mermaid-diagram > svg").length === count &&
      !document.querySelector(".md-mermaid-block[aria-busy]"),
    NAMES.length,
    { timeout: 120_000, polling: 250 },
  );
  // the scroll regions are marked once the browser has laid the figures out
  await page.waitForTimeout(500);

  const wide = await page.evaluate(measure, undefined);
  const at = (name: Name): Shown => wide.diagrams[NAMES.indexOf(name)]!;
  console.log(`Window 1280px, reading column ${wide.column}px:`);
  console.table(Object.fromEntries(NAMES.map((name) => [name, at(name)])));

  for (const name of NAMES) {
    const shown = at(name);
    check(
      shown.smallestText >= SMALLEST_TEXT_PX - 0.01,
      `${name}: its smallest text reads at ${px(shown.smallestText)}`,
    );
  }
  for (const name of WIDE) {
    const shown = at(name);
    check(shown.scrollWidth > shown.clientWidth, `${name}: wider than its block, it scrolls sideways there`);
    check(
      shown.tabIndex === "0" && shown.role === "region" && shown.label === REGION_NAMES[name],
      `${name}: a focusable region named "${shown.label}"`,
    );
  }
  check(!wide.pageScrolls, "the page itself does not scroll sideways");
  for (const name of FITTING) {
    const shown = at(name);
    check(shown.scrollWidth <= shown.clientWidth && shown.tabIndex === null, `${name}: fits, and is no tab stop`);
  }
  for (const name of GANTT) {
    const shown = at(name);
    check(
      shown.natural < shown.block && shown.drawn <= shown.block + 0.5 && shown.scrollWidth <= shown.clientWidth,
      `${name}: laid out at ${shown.natural}px, drawn at ${px(shown.drawn)} within its ${shown.block}px block`,
    );
  }
  check(at("quoted gantt").block < wide.column, "quoted gantt: its block is narrower than the column");
  check(at("wide C4").drawn > at("wide C4").natural, "wide C4: drawn above its natural size (its 10.5px type lines)");

  // the keyboard: from the document's own region, Tab goes to the wide diagrams and past every other
  await page.evaluate(() => document.querySelector<HTMLElement>(".markdown-view")!.focus(), undefined);
  const reached: string[] = [];
  for (let i = 0; i < WIDE.length + 2; i++) {
    await page.keyboard.press("Tab");
    reached.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        const blocks = [...document.querySelectorAll(".md-mermaid-diagram")];
        return active?.matches(".md-mermaid-diagram")
          ? `diagram ${blocks.indexOf(active)}`
          : (active?.localName ?? "none");
      }, undefined),
    );
  }
  console.log(`Tab from the document: ${reached.join(" → ")}`);
  check(
    WIDE.every((name, i) => reached[i] === `diagram ${NAMES.indexOf(name)}`),
    `Tab reaches the ${WIDE.join(", then the ")}`,
  );
  check(
    !reached.some((stop) => FITTING.some((name) => stop === `diagram ${NAMES.indexOf(name)}`)),
    "no diagram that fits is a tab stop",
  );

  // back to the wide C4 by keyboard, then scroll it with the arrow keys
  await page.evaluate(() => document.querySelector<HTMLElement>(".markdown-view")!.focus(), undefined);
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement!);
    return {
      visible: document.activeElement!.matches(":focus-visible"),
      outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
      offset: style.outlineOffset,
    };
  }, undefined);
  check(
    ring.visible && ring.outline === `solid 2px ${FOCUS_RING}` && ring.offset === "2px",
    `the focused diagram shows the focus ring (${ring.outline}, offset ${ring.offset})`,
  );
  const scrolled = async (): Promise<number> =>
    page.evaluate(() => (document.activeElement as HTMLElement).scrollLeft, undefined);
  const before = await scrolled();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  const after = await scrolled();
  check(before === 0 && after > 0, `ArrowRight scrolls the focused diagram sideways (${before} → ${after}px)`);
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(400);
  check((await scrolled()) < after, "ArrowLeft scrolls it back");

  // its drawing dimmed as the fence dims it while a newer source cannot be drawn: the ring keeps its colour
  await page.evaluate(() => document.activeElement!.classList.add("is-stale"), undefined);
  await page.waitForTimeout(400);
  const stale = await page.evaluate(() => {
    const figure = document.activeElement as HTMLElement;
    const result = {
      focused: figure.matches(".md-mermaid-diagram.is-stale:focus-visible"),
      figure: getComputedStyle(figure).opacity,
      drawing: getComputedStyle(figure.querySelector("svg")!).opacity,
      outline: getComputedStyle(figure).outlineColor,
    };
    figure.classList.remove("is-stale");
    return result;
  }, undefined);
  check(
    stale.focused && stale.figure === "1" && stale.drawing === "0.4" && stale.outline === FOCUS_RING,
    `a dimmed diagram's focus ring stays at full strength (block ${stale.figure}, drawing ${stale.drawing}, ring ${stale.outline})`,
  );

  // a narrow window: the medium flowchart no longer fits and becomes a scroll region
  await page.setViewportSize({ width: 480, height: 900 });
  await page.waitForTimeout(500);
  const narrow = await page.evaluate(measure, undefined);
  const medium = narrow.diagrams[NAMES.indexOf("medium flowchart")]!;
  console.log(`Window 480px, reading column ${narrow.column}px: medium flowchart ${JSON.stringify(medium)}`);
  check(
    medium.scrollWidth > medium.clientWidth &&
      medium.tabIndex === "0" &&
      medium.role === "region" &&
      medium.label === REGION_NAMES["medium flowchart"],
    `medium flowchart: in a narrow window it scrolls, a focusable region named "${medium.label}" now`,
  );
  check(
    medium.smallestText >= SMALLEST_TEXT_PX - 0.01,
    `medium flowchart: its text still reads at ${px(medium.smallestText)}`,
  );
  check(!narrow.pageScrolls, "the page itself still does not scroll sideways");
  const small = narrow.diagrams[NAMES.indexOf("small flowchart")]!;
  check(small.tabIndex === null, "small flowchart: still fits, no tab stop");

  // control: without its minimum width, the wide flowchart would shrink to unreadable labels
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    for (const svg of document.querySelectorAll<SVGSVGElement>(".md-mermaid-diagram > svg")) svg.style.minWidth = "";
  }, undefined);
  const control = (await page.evaluate(measure, undefined)).diagrams[NAMES.indexOf("wide flowchart")]!;
  check(
    control.smallestText < SMALLEST_TEXT_PX,
    `control: without the minimum width the wide flowchart's labels read at ${px(control.smallestText)}`,
  );
} finally {
  await browser.close();
  host.kill();
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nEvery diagram reads at 13px or more, and the wide ones scroll by keyboard.");
