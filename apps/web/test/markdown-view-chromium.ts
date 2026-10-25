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
 *  - anchor: a click on a link to a section scrolls to it and puts it in the
 *    address; the view the router renders anew is the same one, and the
 *    section stays on screen when an edit above it lands. So does a click on
 *    a footnote reference, for its note.
 *  - scroll: blocks inserted above the reader, a block above growing, a
 *    heading with the text every section has inserted above (their ids
 *    renumber; the reader's paragraph and the selection in it stay), a
 *    diagram above changed back to one drawn before, and one changed to a
 *    diagram never drawn (it lands asynchronously, at another height) leave
 *    the block the reader looks at where it was on screen. So does that
 *    diagram changed again while the top of the view cuts it: the block
 *    below it stays when the new drawing lands. A collapsible section
 *    (<details>) with another in it: the reader opens both, the top of the
 *    view through the outer one, and the inner summary stays on screen as
 *    the section grows and, later, shrinks; an edit above keeps both open
 *    (the same node) and the summary in place, an edit in the outer one
 *    replaces its block and both stay open. The footnotes at the end, which
 *    fill the view: a paragraph citing a note pasted above replaces them (one
 *    more link back), and the note the reader reads stays. Once with the
 *    browser's scroll anchoring, once without it (overflow-anchor: none), as
 *    in Safari before 27. A control shows that each edit moved that block
 *    down the document, or that the section the reader opened or closed
 *    changed its height.
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
/** a diagram no step drew before, taller than WIDE */
const fresh = (label: string): string =>
  `flowchart TD\n  A[Draft] --> B[Review]\n  B --> C[Shipped ${label}]\n  C --> D[Done]\n`;
/** another one, taller than that */
const longer = (label: string): string =>
  `flowchart TD\n  A[Draft] --> B[Review]\n  B --> C[Tested ${label}]\n  C --> D[Merged]\n  D --> E[Shipped]\n  E --> F[Done]\n`;
const section = (number: number): string =>
  `## Section ${number}\n\n### Example\n\nParagraph ${number}. ${SENTENCE} ${SENTENCE}\n`;
const NOTES = "Release notes";
const OLDER = "Older notes";
const OPEN_TEXTS = { notes: NOTES, older: OLDER };
/** a collapsible section with another one in it, below the paragraph the scroll steps read */
const COLLAPSIBLE = [
  `<details>\n<summary>${NOTES}</summary>\n`,
  ...Array.from({ length: 4 }, (_, i) => `Note ${i + 1}. ${SENTENCE}\n`),
  `<details>\n<summary>${OLDER}</summary>\n`,
  ...Array.from({ length: 6 }, (_, i) => `Older note ${i + 1}. ${SENTENCE} ${SENTENCE}\n`),
  "</details>\n",
  `Notes end. ${SENTENCE}\n`,
  "</details>\n",
].join("\n");
/** enough footnotes to fill the view at the end of the document */
const NOTE_COUNT = 20;
const CITED = `A paragraph that cites its sources.${Array.from({ length: NOTE_COUNT }, (_, i) => `[^n${i + 1}]`).join("")}`;
const FOOTNOTES = Array.from(
  { length: NOTE_COUNT },
  (_, i) => `[^n${i + 1}]: Note ${i + 1}. ${SENTENCE} ${SENTENCE}\n`,
);
/** the note the reader reads, by its id */
const NOTE = "md-Footnote-6";
const DOCUMENT = [
  "# Reading while others write\n",
  `${COPY}\n`,
  `${LINKED}\n`,
  `${CITED}\n`,
  "## The diagram\n",
  "```mermaid\n" + WIDE + "```\n",
  ...Array.from({ length: 25 }, (_, i) => section(i + 1)),
  COLLAPSIBLE,
  ...Array.from({ length: 5 }, (_, i) => section(i + 26)),
  ...FOOTNOTES,
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
  __reading?: Element;
  __below?: Element;
  __article?: Element;
  __notes?: HTMLDetailsElement;
  __footnotes?: Element;
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

/** a block the reader looks at: scrolling to it (false when the view cannot
 *  show it as the step needs), and where it is, on screen and down the document */
interface Reader {
  readOn(page: Page): Promise<boolean>;
  place(page: Page): Promise<{ onScreen: number; inDocument: number }>;
}

/** the paragraph the reader reads, found by its text: a render may have replaced its node */
const READING = "Paragraph 20.";
/** that paragraph, just below the top of the view */
const paragraph: Reader = {
  readOn: (page) =>
    page.evaluate((text) => {
      const paragraphs = [...document.querySelectorAll("article.markdown-body > p")];
      const found = paragraphs.find((p) => p.textContent?.startsWith(text))!;
      const scroller = document.querySelector(".markdown-view")!;
      const below = () => found.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += below() - 40;
      return Math.abs(below() - 40) <= 1;
    }, READING),
  place: (page) =>
    page.evaluate((text) => {
      const paragraphs = [...document.querySelectorAll("article.markdown-body > p")];
      const box = paragraphs.find((p) => p.textContent?.startsWith(text))!.getBoundingClientRect();
      const article = document.querySelector("article.markdown-body")!.getBoundingClientRect();
      return { onScreen: box.top, inDocument: box.top - article.top };
    }, READING),
};
/** the block below the diagram, with the top of the view through the middle of the diagram */
const belowCutDiagram: Reader = {
  readOn: (page) =>
    page.evaluate(() => {
      const marked = window as unknown as Marked;
      const slot = document.querySelector(".md-mermaid-block")!;
      const scroller = document.querySelector(".markdown-view")!;
      const box = slot.getBoundingClientRect();
      scroller.scrollTop += box.top + box.height / 2 - scroller.getBoundingClientRect().top;
      marked.__below = slot.nextElementSibling ?? undefined;
      const cut = slot.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      return !!marked.__below && cut.top < view.top && cut.bottom > view.top && cut.bottom <= view.bottom;
    }, 0),
  place: (page) =>
    page.evaluate(() => {
      const box = (window as unknown as Marked).__below!.getBoundingClientRect();
      const article = document.querySelector("article.markdown-body")!.getBoundingClientRect();
      return { onScreen: box.top, inDocument: box.top - article.top };
    }, 0),
};
/** the summary of the inner collapsible section, with the top of the view
 *  just below the summary of the open outer one */
const olderSummary: Reader = {
  readOn: (page) =>
    page.evaluate((texts) => {
      const summaries = [...document.querySelectorAll("article.markdown-body summary")];
      const outer = summaries.find((s) => s.textContent === texts.notes)!.parentElement as HTMLDetailsElement;
      const inner = summaries.find((s) => s.textContent === texts.older)!;
      const scroller = document.querySelector(".markdown-view")!;
      const outerSummary = outer.querySelector(":scope > summary")!;
      scroller.scrollTop += outerSummary.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + 20;
      const view = scroller.getBoundingClientRect();
      const summary = inner.getBoundingClientRect();
      return outer.open && outer.getBoundingClientRect().top < view.top && summary.top >= view.top;
    }, OPEN_TEXTS),
  place: (page) =>
    page.evaluate((older) => {
      const summaries = [...document.querySelectorAll("article.markdown-body summary")];
      const box = summaries.find((s) => s.textContent === older)!.getBoundingClientRect();
      const article = document.querySelector("article.markdown-body")!.getBoundingClientRect();
      return { onScreen: box.top, inDocument: box.top - article.top };
    }, OLDER),
};
/** a note in the footnotes, just below the top of the view: the footnotes,
 *  the last block, are the only one on screen */
const footnote: Reader = {
  readOn: (page) =>
    page.evaluate((id) => {
      const note = document.getElementById(id)!;
      const scroller = document.querySelector(".markdown-view")!;
      const below = () => note.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += below() - 40;
      const notes = note.closest("article.markdown-body > section")!;
      (window as unknown as Marked).__footnotes = notes;
      const view = scroller.getBoundingClientRect();
      const box = notes.getBoundingClientRect();
      return Math.abs(below() - 40) <= 1 && box.top < view.top && box.bottom >= view.bottom;
    }, NOTE),
  place: (page) =>
    page.evaluate((id) => {
      const box = document.getElementById(id)!.getBoundingClientRect();
      const article = document.querySelector("article.markdown-body")!.getBoundingClientRect();
      return { onScreen: box.top, inDocument: box.top - article.top };
    }, NOTE),
};
/** the end of the outer collapsible section: on screen, and down the document */
const notesEnd = (page: Page): Promise<{ onScreen: boolean; inDocument: number }> =>
  page.evaluate((notes) => {
    const summaries = [...document.querySelectorAll("article.markdown-body summary")];
    const box = summaries.find((s) => s.textContent === notes)!.parentElement!.getBoundingClientRect();
    const view = document.querySelector(".markdown-view")!.getBoundingClientRect();
    const article = document.querySelector("article.markdown-body")!.getBoundingClientRect();
    return { onScreen: box.bottom <= view.bottom, inDocument: box.bottom - article.top };
  }, NOTES);
/** which of the two collapsible sections are open, and whether the outer one is still the node the reader opened */
const sections = (page: Page): Promise<{ notes: boolean; older: boolean; same: boolean }> =>
  page.evaluate((texts) => {
    const summaries = [...document.querySelectorAll("article.markdown-body summary")];
    const outer = summaries.find((s) => s.textContent === texts.notes)?.parentElement as HTMLDetailsElement | undefined;
    const inner = summaries.find((s) => s.textContent === texts.older)?.parentElement as HTMLDetailsElement | undefined;
    return {
      notes: !!outer?.open,
      older: !!inner?.open,
      same: !!outer && outer === (window as unknown as Marked).__notes,
    };
  }, OPEN_TEXTS);
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

  // anchor: a link to a section scrolls there and puts it in the address,
  // and the view the router renders anew is the same one
  await page.evaluate(() => {
    (window as unknown as Marked).__article = document.querySelector("article.markdown-body") ?? undefined;
    document.querySelector<HTMLElement>('article.markdown-body a[href="#the-diagram"]')!.click();
  }, 0);
  await page.waitForTimeout(300);
  const landing = (): Promise<{ hash: string; offset: number; same: boolean; selection: string }> =>
    page.evaluate(() => {
      const heading = document.getElementById("md-the-diagram")!;
      const scroller = document.querySelector(".markdown-view")!;
      return {
        hash: location.hash,
        offset: Math.round(heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top),
        same: document.querySelector("article.markdown-body") === (window as unknown as Marked).__article,
        selection: getSelection()!.toString(),
      };
    }, 0);
  const landed = await landing();
  check("anchor", "the link puts its section in the address", landed.hash === "#the-diagram", landed.hash);
  check("anchor", "the view scrolls to the section", landed.offset >= 0 && landed.offset <= 40, `${landed.offset} px`);
  check("anchor", "the view stays mounted, the selection in it", landed.same && landed.selection === COPY);
  const above = "Written above the diagram.";
  check(
    "anchor",
    "an edit above the section shows",
    await edit(page, session, insertAfter(session, COPY, `\n\n${above} ${SENTENCE}`), above),
  );
  const stayed = await landing();
  check(
    "anchor",
    "an edit above: the section stays on screen, in the address",
    stayed.offset === landed.offset && stayed.hash === "#the-diagram",
    `${stayed.offset - landed.offset} px, ${stayed.hash}`,
  );
  // a footnote reference: the same for its note
  const noteHash = `#${NOTE.slice("md-".length)}`;
  await page.evaluate((hash) => {
    document.querySelector<HTMLElement>(`article.markdown-body a[href="${hash}"]`)!.click();
  }, noteHash);
  await page.waitForTimeout(300);
  const atNote = (): Promise<{ hash: string; offset: number }> =>
    page.evaluate((id) => {
      const note = document.getElementById(id)!;
      const scroller = document.querySelector(".markdown-view")!;
      return {
        hash: location.hash,
        offset: Math.round(note.getBoundingClientRect().top - scroller.getBoundingClientRect().top),
      };
    }, NOTE);
  const noted = await atNote();
  check("anchor", "a footnote reference puts its note in the address", noted.hash === noteHash, noted.hash);
  check("anchor", "the view scrolls to the note", noted.offset >= 0 && noted.offset <= 40, `${noted.offset} px`);
  const cited = "Written above the notes.";
  check(
    "anchor",
    "an edit above the notes shows",
    await edit(page, session, insertAfter(session, "## Section 30\n", `\n${cited} ${SENTENCE}\n`), cited),
  );
  const stillNoted = await atNote();
  check(
    "anchor",
    "an edit above: the note stays on screen, in the address",
    stillNoted.offset === noted.offset && stillNoted.hash === noteHash,
    `${stillNoted.offset - noted.offset} px, ${stillNoted.hash}`,
  );

  // scroll: edits above the reader, with the browser's scroll anchoring and without it
  let diagram = WIDE;
  const setDiagram = (to: string): void => {
    replace(session, diagram, to)(session.content.toString());
    diagram = to;
  };
  for (const anchoring of ["browser", "none"] as const) {
    const scenario = `scroll (anchoring: ${anchoring})`;
    if (anchoring === "none") {
      await page.evaluate(() => {
        document.querySelector<HTMLElement>(".markdown-view")!.style.overflowAnchor = "none";
      }, 0);
    }
    /** the reader's block on screen and down the document, before and after `change` shows */
    const measure = async (what: string, change: () => Promise<boolean>, reader = paragraph): Promise<void> => {
      check(scenario, `precondition: ${what}: the reader is in place`, await reader.readOn(page));
      const was = await reader.place(page);
      const shown = await change();
      const is = await reader.place(page);
      const moved = Math.round(is.inDocument - was.inDocument);
      check(
        scenario,
        `control: ${what} moved the reader's block in the document`,
        shown && Math.abs(moved) > 20,
        `${moved} px`,
      );
      const shift = Math.round((is.onScreen - was.onScreen) * 10) / 10;
      check(scenario, `${what}: the reader's block stays on screen`, Math.abs(shift) <= 1, `${shift} px`);
    };
    const steady = (what: string, change: (source: string) => void, shows: string): Promise<void> =>
      measure(what, () => edit(page, session, change, shows));

    const inserted = Array.from({ length: 5 }, (_, i) => `\n\nInserted (${anchoring}) ${i + 1}. ${SENTENCE}`).join("");
    await steady("blocks inserted above", insertAfter(session, COPY, inserted), `Inserted (${anchoring}) 5.`);
    const grown = ` Grown (${anchoring}). ${SENTENCE} ${SENTENCE} ${SENTENCE}`;
    await steady("a block above grows", insertAfter(session, "Paragraph 3.", grown), `Grown (${anchoring}).`);

    // every section has an "Example" heading: one more above renumbers their ids
    await page.evaluate((text) => {
      const marked = window as unknown as Marked;
      const paragraphs = [...document.querySelectorAll("article.markdown-body > p")];
      marked.__reading = paragraphs.find((p) => p.textContent?.startsWith(text));
      getSelection()!.selectAllChildren(marked.__reading!);
    }, READING);
    const zero = `Zero (${anchoring}).`;
    await steady(
      "a heading like the sections' inserted above",
      insertAfter(session, COPY, `\n\n### Example\n\n${zero}`),
      zero,
    );
    const reading = await page.evaluate((text) => {
      const marked = window as unknown as Marked;
      const selection = getSelection()!;
      return {
        kept: marked.__reading!.isConnected,
        selected: selection.anchorNode === marked.__reading && selection.toString().startsWith(text),
      };
    }, READING);
    check(scenario, "a heading like the sections' inserted above: the reader's paragraph stays", reading.kept);
    check(scenario, "a heading like the sections' inserted above: the selection in it stays", reading.selected);

    // the tall diagram drawn (and cached) first, the wide one back from the cache then
    setDiagram(TALL);
    check(scenario, "precondition: the tall diagram is drawn", await diagramDrawn(page, "Approve"));
    await measure("a diagram above back from the cache", async () => {
      setDiagram(WIDE);
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
      return back;
    });
    // a diagram never drawn: the render keeps the old drawing's height, the
    // new one lands later
    await measure("a diagram above drawn anew, after the render", async () => {
      setDiagram(fresh(anchoring));
      const drawn = await diagramDrawn(page, `Shipped ${anchoring}`);
      await page.waitForTimeout(200);
      return drawn;
    });
    // the reader reads below a diagram the top of the view cuts: its new
    // drawing, taller, lands after the render and must not push that down
    await measure(
      "a diagram the view cuts drawn anew, after the render",
      async () => {
        setDiagram(longer(anchoring));
        const drawn = await diagramDrawn(page, `Tested ${anchoring}`);
        await page.waitForTimeout(200);
        return drawn;
      },
      belowCutDiagram,
    );

    // collapsible sections: the reader opens them; what the reader opened
    // stays open through the co-editor's edits, and a summary the reader
    // clicks stays put while the section around it grows or shrinks
    await page.evaluate((notes) => {
      for (const details of document.querySelectorAll("article.markdown-body details")) details.removeAttribute("open");
      const summaries = [...document.querySelectorAll<HTMLElement>("article.markdown-body summary")];
      const summary = summaries.find((s) => s.textContent === notes)!;
      const scroller = document.querySelector(".markdown-view")!;
      scroller.scrollTop += summary.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 100;
      summary.click();
      (window as unknown as Marked).__notes = summary.parentElement as HTMLDetailsElement;
    }, NOTES);
    await page.waitForTimeout(200);
    check(scenario, "precondition: the reader opened the collapsible section", (await sections(page)).notes);
    /** the reader clicks the inner section's summary, the top of the view through the outer one */
    const toggle = async (what: string, endsOnScreen: boolean): Promise<void> => {
      check(scenario, `precondition: ${what}: the reader is in place`, await olderSummary.readOn(page));
      // the reader scrolled there a moment before the click
      await page.waitForTimeout(200);
      const endWas = await notesEnd(page);
      if (endsOnScreen) check(scenario, `precondition: ${what}: the outer section ends on screen`, endWas.onScreen);
      const was = await olderSummary.place(page);
      await page.evaluate((older) => {
        [...document.querySelectorAll<HTMLElement>("article.markdown-body summary")]
          .find((s) => s.textContent === older)!
          .click();
      }, OLDER);
      await page.waitForTimeout(200);
      const is = await olderSummary.place(page);
      const grown = Math.round((await notesEnd(page)).inDocument - endWas.inDocument);
      check(scenario, `control: ${what} changed the outer section's height`, Math.abs(grown) > 20, `${grown} px`);
      const shift = Math.round((is.onScreen - was.onScreen) * 10) / 10;
      check(scenario, `${what}: its summary stays on screen`, Math.abs(shift) <= 1, `${shift} px`);
    };
    await toggle("the reader opens the inner section", true);
    const aboveNotes = `Above the notes (${anchoring}).`;
    await measure(
      "an edit above the open sections",
      () => edit(page, session, insertAfter(session, "## Section 25\n", `\n${aboveNotes} ${SENTENCE}\n`), aboveNotes),
      olderSummary,
    );
    const kept = await sections(page);
    check(
      scenario,
      "an edit above: both sections stay open, the outer one the same node",
      kept.notes && kept.older && kept.same,
    );
    const inNotes = `Note 1b (${anchoring}).`;
    check(
      scenario,
      "an edit in the outer section shows",
      await edit(page, session, insertAfter(session, "Note 1.", `\n\n${inNotes} ${SENTENCE}`), inNotes),
    );
    const replaced = await sections(page);
    check(scenario, "an edit in the outer section: its block is new", !replaced.same);
    check(scenario, "an edit in the outer section: both sections stay open", replaced.notes && replaced.older);
    await toggle("the reader closes the inner section", false);

    // the footnotes fill the view: a paragraph citing a note pasted above
    // replaces them, with one more link back, and the note stays
    const pasted = `Pasted (${anchoring}).`;
    await measure(
      "a paragraph citing a note pasted above the footnotes",
      () => edit(page, session, insertAfter(session, COPY, `\n\n${pasted}[^n1] ${SENTENCE}`), pasted),
      footnote,
    );
    const notesReplaced = await page.evaluate(
      (notes) =>
        !(window as unknown as Marked).__footnotes!.isConnected &&
        document.querySelectorAll("article.markdown-body > section a.md-footnote-backref").length > notes,
      NOTE_COUNT,
    );
    check(scenario, "control: the paste replaced the footnotes, with one more link back", notesReplaced);
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
