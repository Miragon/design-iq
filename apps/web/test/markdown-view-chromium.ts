/**
 * Reading a Markdown document while a colleague writes it (issue 289), in
 * headless Chromium: a check run by hand, not by `pnpm test`, because CI has
 * no browser. markdown-view.test.ts pins under jsdom which blocks a render
 * keeps; jsdom lays nothing out, so the scroll position, and what a browser
 * does with the selection and the focus, are checked here. Run it after a
 * change to the Markdown view or its fences, from the repository root:
 *
 *   pnpm build
 *   npx -y playwright@1.56.1 install --only-shell chromium     # once
 *   npx -y -p playwright@1.56.1 -c "node apps/web/test/markdown-view-chromium.ts"
 *
 * It starts a Live Host of its own (LIVE_AUTH=none, on PORT, 8393 unless set)
 * on a generated content repo with one long document, opens it in the SPA's
 * preview and edits it from a headless guest session, as a co-editor would:
 *
 *  - selection: an edit at the end keeps the reader's selection, the focus on
 *    a link and the drawn diagram, each the very node it was.
 *  - focus: an edit of the link's block moves the focus to the view; the
 *    selection elsewhere stays.
 *  - scroll: blocks inserted above the reader, a block above growing, and a
 *    diagram above changed back to one drawn before leave the block the
 *    reader looks at where it was on screen. Once with the browser's scroll
 *    anchoring, once without it (overflow-anchor: none), as in Safari
 *    before 27. A control shows that each edit moved that block down the
 *    document.
 *
 * Exits 1 on any failed check.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type LiveSession, openLiveSession, roomName } from "@designiq/live-client";

/** the part of Playwright's API this check uses: Playwright is no dependency of the repo */
interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<Awaited<R>>;
  waitForFunction<A>(fn: (arg: A) => unknown, arg: A, options: { timeout: number; polling?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
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
const PORT = Number(process.env.PORT ?? 8393);
const BASE = `http://localhost:${PORT}`;
const REPO = "acme/reading";
const PATH = "docs/reading.md";

const SENTENCE = "Every reader sees the same document, and every edit lands for all of them within a second.";
const COPY = "Copy this passage while a colleague writes.";
const LINKED = "A paragraph with [a link to the diagram](#the-diagram) to focus.";
/** two diagrams of different heights: changing one into the other moves what is below */
const WIDE = "flowchart LR\n  A[Draft] --> B[Review] --> C[Release]\n";
const TALL = "flowchart TD\n  A[Draft] --> B[Review]\n  B --> C[Approve]\n  C --> D[Merge]\n  D --> E[Release]\n";
const DOCUMENT = [
  "# Reading while others write\n",
  `${COPY}\n`,
  `${LINKED}\n`,
  "## The diagram\n",
  "```mermaid\n" + WIDE + "```\n",
  ...Array.from({ length: 30 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1}. ${SENTENCE} ${SENTENCE}\n`),
].join("\n");

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

/** what the page holds on to between the steps */
interface Marked {
  __copy?: Element;
  __link?: HTMLElement;
  __svg?: Element;
}

const failures: string[] = [];
const results: Array<{ scenario: string; check: string; ok: boolean; detail: string }> = [];
function check(scenario: string, name: string, ok: boolean, detail = ""): void {
  results.push({ scenario, check: name, ok, detail: detail.slice(0, 80) });
  if (!ok) failures.push(`${scenario}: ${name}${detail ? ` (${detail})` : ""}`);
}

/** the co-editor's edit, and the reader's page once it shows `shows` */
async function edit(
  page: Page,
  session: LiveSession,
  change: (source: string) => void,
  shows: string,
): Promise<boolean> {
  session.doc.transact(() => change(session.content.toString()));
  const shown = await page
    .waitForFunction(
      (text) => document.querySelector("article.markdown-body")?.textContent?.includes(text) ?? false,
      shows,
      { timeout: 15_000, polling: 50 },
    )
    .then(
      () => true,
      () => false,
    );
  // a frame for the browser's own scroll anchoring
  await page.waitForTimeout(200);
  return shown;
}
const insertAfter = (session: LiveSession, marker: string, text: string) => (source: string) =>
  session.content.insert(source.indexOf(marker) + marker.length, text);
const replace = (session: LiveSession, from: string, to: string) => (source: string) => {
  const at = source.indexOf(from);
  session.content.delete(at, from.length);
  session.content.insert(at, to);
};

/** the paragraph the reader reads, found by its text: a render may have replaced its node */
const READING = "Paragraph 20.";
/** the reader scrolls that paragraph to just below the top of the view */
const readOn = (page: Page): Promise<void> =>
  page.evaluate((text) => {
    const paragraphs = [...document.querySelectorAll("article.markdown-body > p")];
    const paragraph = paragraphs.find((p) => p.textContent?.startsWith(text))!;
    const scroller = document.querySelector(".markdown-view")!;
    scroller.scrollTop += paragraph.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
  }, READING);
/** where that paragraph is: on screen, and down the document */
const place = (page: Page) =>
  page.evaluate((text) => {
    const paragraphs = [...document.querySelectorAll("article.markdown-body > p")];
    const box = paragraphs.find((p) => p.textContent?.startsWith(text))!.getBoundingClientRect();
    const article = document.querySelector("article.markdown-body")!.getBoundingClientRect();
    return { onScreen: box.top, inDocument: box.top - article.top };
  }, READING);
const diagramDrawn = (page: Page, text: string): Promise<boolean> =>
  page
    .waitForFunction(
      (label) => {
        const block = document.querySelector(".md-mermaid-block");
        return (
          !!block && !block.hasAttribute("aria-busy") && !!block.querySelector("svg")?.textContent?.includes(label)
        );
      },
      text,
      { timeout: 60_000, polling: 100 },
    )
    .then(
      () => true,
      () => false,
    );

const playwright = loadPlaywright();
if (!existsSync(join(DIST, "index.html")))
  throw new Error("apps/web/dist/index.html is missing: run pnpm build first.");
const work = mkdtempSync(join(tmpdir(), "designiq-markdown-view-"));
mkdirSync(join(work, "content/docs"), { recursive: true });
writeFileSync(join(work, "content/designiq.yml"), "models: docs\n");
writeFileSync(join(work, "content", PATH), DOCUMENT);
const host = await startLiveHost(join(work, "content"), join(work, "data"));
const browser = await playwright.chromium.launch({ headless: true });
const session = openLiveSession({ url: `ws://localhost:${PORT}`, room: roomName(REPO, PATH), token: "x" });
const pageErrors: string[] = [];

try {
  await session.whenSynced(15_000);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(`${BASE}/r/${REPO}/f/${PATH}`);
  check("open", "the diagram is drawn", await diagramDrawn(page, "Review"));

  // selection: an edit at the end of the document
  const before = await page.evaluate((copy) => {
    const marked = window as unknown as Marked;
    const article = document.querySelector("article.markdown-body")!;
    marked.__copy = [...article.querySelectorAll("p")].find((p) => p.textContent === copy);
    marked.__link = article.querySelector<HTMLElement>('a[href="#the-diagram"]') ?? undefined;
    marked.__svg = article.querySelector(".md-mermaid-diagram svg") ?? undefined;
    marked.__link?.focus();
    getSelection()!.selectAllChildren(marked.__copy!);
    return { selection: getSelection()!.toString(), focused: document.activeElement === marked.__link };
  }, COPY);
  check(
    "selection",
    "precondition: a passage is selected, a link has the focus",
    before.selection === COPY && before.focused,
  );
  const appended = " Appended by a colleague.";
  check(
    "selection",
    "the edit at the end shows",
    await edit(page, session, (source) => session.content.insert(source.trimEnd().length, appended), appended.trim()),
  );
  const after = await page.evaluate(() => {
    const marked = window as unknown as Marked;
    return {
      selection: getSelection()!.toString(),
      selected: getSelection()!.anchorNode === marked.__copy && marked.__copy!.isConnected,
      focused: document.activeElement === marked.__link,
      drawing: document.querySelector(".md-mermaid-diagram svg") === marked.__svg && marked.__svg!.isConnected,
    };
  }, 0);
  check(
    "selection",
    "the selection stays, in the same block",
    after.selection === COPY && after.selected,
    after.selection,
  );
  check("selection", "the focus stays on the link", after.focused);
  check("selection", "the diagram stays as it was drawn", after.drawing);

  // focus: an edit of the block with the focus
  check(
    "focus",
    "the edit of the link's block shows",
    await edit(page, session, (source) => session.content.insert(source.indexOf(LINKED), "Now "), "Now A paragraph"),
  );
  const focus = await page.evaluate(
    () => ({
      inView: document.activeElement === document.querySelector(".markdown-view"),
      selection: getSelection()!.toString(),
    }),
    0,
  );
  check("focus", "the focus moves to the view", focus.inView);
  check("focus", "the selection elsewhere stays", focus.selection === COPY, focus.selection);

  // scroll: edits above the reader, with the browser's scroll anchoring and without it
  for (const anchoring of ["browser", "none"] as const) {
    const scenario = `scroll (anchoring: ${anchoring})`;
    if (anchoring === "none") {
      await page.evaluate(() => {
        document.querySelector<HTMLElement>(".markdown-view")!.style.overflowAnchor = "none";
      }, 0);
    }
    const steady = async (what: string, change: (source: string) => void, shows: string): Promise<void> => {
      await readOn(page);
      const was = await place(page);
      const shown = await edit(page, session, change, shows);
      const is = await place(page);
      const moved = Math.round(is.inDocument - was.inDocument);
      check(
        scenario,
        `control: ${what} moved the reader's block down the document`,
        shown && moved > 20,
        `${moved} px`,
      );
      const shift = Math.round((is.onScreen - was.onScreen) * 10) / 10;
      check(scenario, `${what}: the reader's block stays on screen`, Math.abs(shift) <= 1, `${shift} px`);
    };
    const inserted = Array.from({ length: 5 }, (_, i) => `\n\nInserted (${anchoring}) ${i + 1}. ${SENTENCE}`).join("");
    await steady("blocks inserted above", insertAfter(session, COPY, inserted), `Inserted (${anchoring}) 5.`);
    const grown = ` Grown (${anchoring}). ${SENTENCE} ${SENTENCE} ${SENTENCE}`;
    await steady("a block above grows", insertAfter(session, "Paragraph 3.", grown), `Grown (${anchoring}).`);
    // the tall diagram drawn (and cached) first, the wide one back from the cache then
    const source = session.content.toString();
    if (source.includes(WIDE)) {
      replace(session, WIDE, TALL)(source);
      check(scenario, "precondition: the tall diagram is drawn", await diagramDrawn(page, "Approve"));
    }
    await readOn(page);
    const was = await place(page);
    replace(session, TALL, WIDE)(session.content.toString());
    const back = await page
      .waitForFunction(
        () => {
          const svg = document.querySelector(".md-mermaid-block:not([aria-busy]) svg");
          return !!svg && !svg.textContent?.includes("Approve");
        },
        0,
        { timeout: 15_000, polling: 50 },
      )
      .then(
        () => true,
        () => false,
      );
    await page.waitForTimeout(200);
    const is = await place(page);
    const moved = Math.round(is.inDocument - was.inDocument);
    check(scenario, "control: the diagram above changed its height", back && Math.abs(moved) > 20, `${moved} px`);
    const shift = Math.round((is.onScreen - was.onScreen) * 10) / 10;
    check(
      scenario,
      "a diagram above back from the cache: the reader's block stays on screen",
      Math.abs(shift) <= 1,
      `${shift} px`,
    );
  }

  const toasts = await page.evaluate(
    () => [...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.textContent?.trim() ?? ""),
    0,
  );
  check("all", "no error toast", toasts.length === 0, toasts.join(" | "));
  check("all", "no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  console.table(results);
} finally {
  session.destroy();
  await browser.close();
  host.kill();
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nAll ${results.length} checks passed.`);
