/**
 * Which block shows which drawing (src/notations/markdown/mermaid-fence.ts,
 * #294): one drawing is in one place only, or its ids are on the page twice,
 * and every block ends up showing its own source. A drawing has more than one
 * element over time: a Gantt chart laid out anew for another block width
 * (./diagram-scale.ts), a drawing the cache let go and drew again. Under
 * jsdom with a fake renderer, a stand-in ResizeObserver and block widths set
 * by hand, as in markdown-diagram-scale.test.ts; a seeded fuzz run reorders,
 * deletes, inserts, edits and resizes and checks both rules throughout.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";
import * as Y from "yjs";

import { minimumScale } from "../src/notations/markdown/diagram-scale.ts";
import { createMermaidFence, DRAWING_CACHE_SIZE, type RenderMermaid } from "../src/notations/markdown/mermaid-fence.ts";
import { mountMarkdownView, RENDER_DEBOUNCE_MS } from "../src/notations/markdown/view.ts";
import type { EditorContext } from "../src/notations/registry.ts";

const newWindow = () =>
  new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://designiq.test/r/acme/models/f/docs/guide.md",
    virtualConsole: new VirtualConsole(),
  }).window;

/** one task: the hydration's microtasks, and a render the fake holds for a task */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const fence = (body: string): string => "```mermaid\n" + body + "\n```\n";

/** what the fake draws as a diagram's text: its source on one line */
const label = (source: string): string => source.trim().replace(/\s+/g, " ");

/** a Gantt chart's axis labels: 10px, so it is laid out once more, narrower */
const GANTT_TEXT_PX = 10;

/** the width a Gantt chart in a block of `blockWidth` ends up laid out at */
const ganttWidth = (blockWidth: number): number => Math.floor(blockWidth / minimumScale(GANTT_TEXT_PX));

/**
 * The Markdown view with the fence on a fake renderer: a source with "broken"
 * in it fails, a Gantt chart takes the width it is laid out at as its own,
 * anything else draws 400 wide. Every drawing carries ids of its own, as
 * mermaid's do. Every diagram block is `width` wide.
 */
function harness(text: string, options: { deferred?: boolean } = {}) {
  const win = newWindow();
  const state = { width: 720, renders: 0 };
  Object.defineProperty(win.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("md-mermaid-block") ? state.width : 1280;
    },
  });
  const observed = new Set<Element>();
  let report: ((entries: { target: Element }[]) => void) | undefined;
  class FakeResizeObserver {
    constructor(callback: (entries: { target: Element }[]) => void) {
      report = callback;
    }
    observe(target: Element): void {
      observed.add(target);
    }
    unobserve(target: Element): void {
      observed.delete(target);
    }
    disconnect(): void {
      observed.clear();
    }
  }
  Object.assign(win, { ResizeObserver: FakeResizeObserver });

  const render: RenderMermaid = (source, idPrefix, width) => {
    const id = `${idPrefix}-${++state.renders}`;
    const gantt = source.startsWith("gantt");
    const viewBoxWidth = gantt ? (width ?? 1280) : 400;
    const result = source.includes("broken")
      ? { error: { line: 2, message: "Expecting 'SEMI', got 'EOF'" } }
      : {
          svg:
            `<svg id="${id}" viewBox="0 0 ${viewBoxWidth} 148" width="100%">` +
            `<defs><marker id="${id}-arrow"></marker></defs><g id="${id}-node_0"></g>` +
            `<text style="font-size: ${gantt ? GANTT_TEXT_PX : 16}px">${label(source)}</text></svg>`,
        };
    return options.deferred ? new Promise((resolve) => setImmediate(() => resolve(result))) : Promise.resolve(result);
  };

  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, text);
  const ctx: EditorContext = {
    ytext,
    doc: ydoc,
    repo: "acme/models",
    docPath: "docs/guide.md",
    onSyncError: () => undefined,
    onImportFailed: () => undefined,
    onBadgeClick: () => undefined,
    onSelectionChanged: () => undefined,
  };
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const view = mountMarkdownView(container, ctx, { mermaid: createMermaidFence(async () => render) });
  const article = container.querySelector("article")!;

  const slots = (): HTMLElement[] => [...article.querySelectorAll<HTMLElement>(".md-mermaid-block")];
  /** what each block shows: its drawing (id, text, width, dimmed or not), or its code, and its notice */
  const shown = () =>
    slots().map((slot) => {
      const svg = slot.querySelector(".md-mermaid-diagram > svg");
      return {
        id: svg?.id,
        text: svg?.querySelector("text")?.textContent,
        width: svg ? Number(svg.getAttribute("viewBox")!.split(" ")[2]) : undefined,
        stale: slot.querySelector(".md-mermaid-diagram.is-stale") !== null,
        code: slot.querySelector(":scope > pre.md-mermaid")?.textContent,
        notice: slot.querySelector(".md-mermaid-notice") !== null,
        busy: slot.getAttribute("aria-busy") === "true",
      };
    });
  const assertIdsOnce = (when: string): void => {
    const ids = [...article.querySelectorAll("[id]")].map((element) => element.id);
    const twice = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual(twice, [], `${when}: every id on the page once`);
  };
  return {
    win,
    state,
    view,
    article,
    slots,
    shown,
    assertIdsOnce,
    /** a collaborator's edit, rendered once the debounce is over */
    setText(next: string, timers: { tick(ms: number): void }): void {
      ytext.delete(0, ytext.length);
      ytext.insert(0, next);
      timers.tick(RENDER_DEBOUNCE_MS);
    },
    /** the browser reports every watched block's size, as after the window or the split changed width */
    laidOut: (): void => report?.([...observed].map((target) => ({ target }))),
  };
}

const PLAN = "gantt\n  title A plan\n  Design :a1, 2026-01-01, 10d";
const BROKEN_PLAN = PLAN.replace("Design", "Design broken");

/** a Gantt chart drawn in a 720px block, laid out anew once its block is 432px wide */
async function narrowedPlan() {
  const h = harness(fence(PLAN));
  await settle();
  assert.deepEqual(
    h.shown().map(({ width }) => width),
    [ganttWidth(720)],
  );
  h.state.width = 432;
  h.laidOut();
  await settle();
  assert.deepEqual(
    h.shown().map(({ width }) => width),
    [ganttWidth(432)],
  );
  return h;
}

test("a Gantt chart laid out anew for its block comes back at that layout when a render shows it again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const h = await narrowedPlan();
  // a co-editor breaks it: its last good drawing stays, dimmed
  h.setText(fence(BROKEN_PLAN), t.mock.timers);
  await Promise.resolve();
  assert.deepEqual(
    h.shown().map(({ width }) => width),
    [ganttWidth(432)],
    "the layout for the block's width, not the one before it",
  );
  h.view.destroy();
});

test("a dimmed last drawing, laid out anew for a narrower block, is never shown again by a pasted copy of its source (#294)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const h = await narrowedPlan();

  // a co-editor breaks it: the last good drawing stays, dimmed, and follows its block's width
  h.setText(fence(BROKEN_PLAN), t.mock.timers);
  await settle();
  h.state.width = 360;
  h.laidOut();
  await settle();
  const [dimmed] = h.shown();
  assert.equal(dimmed?.stale, true);
  assert.equal(dimmed?.notice, true);
  assert.equal(dimmed?.width, ganttWidth(360));

  // ... and pastes the chart as it was below it: each block shows a drawing of its own
  h.setText(fence(BROKEN_PLAN) + "\n" + fence(PLAN), t.mock.timers);
  await Promise.resolve();
  h.assertIdsOnce("before the browser paints");
  await settle();
  h.assertIdsOnce("once drawn");
  const [stale, pasted] = h.shown();
  assert.equal(stale?.id, dimmed?.id, "the dimmed block stays as it is");
  assert.equal(stale?.stale, true);
  assert.equal(pasted?.text, label(PLAN));
  assert.equal(pasted?.stale, false);
  assert.equal(pasted?.width, ganttWidth(360));

  // the original fixed: the pasted copy, a block the render keeps, stays drawn as it is
  const pastedSvg = h.slots()[1]!.querySelector(".md-mermaid-diagram > svg");
  h.setText(fence(PLAN) + "\n" + fence(PLAN), t.mock.timers);
  await Promise.resolve();
  h.assertIdsOnce("fixed, before the browser paints");
  assert.equal(h.slots()[1]!.querySelector(".md-mermaid-diagram > svg"), pastedSvg, "the very node, not code");
  await settle();
  h.assertIdsOnce("fixed, once drawn");
  assert.deepEqual(
    h.shown().map(({ text, stale, code, busy, width }) => ({ text, stale, code, busy, width })),
    [
      { text: label(PLAN), stale: false, code: undefined, busy: false, width: ganttWidth(360) },
      { text: label(PLAN), stale: false, code: undefined, busy: false, width: ganttWidth(360) },
    ],
  );
  assert.equal(h.slots()[1]!.querySelector(".md-mermaid-diagram > svg"), pastedSvg);
  h.view.destroy();
});

test("a pasted copy stays drawn, and keeps the focus, when its broken original is fixed after the cache let the first drawing go (#294)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const source = "flowchart LR\n  A --> B";
  const broken = "flowchart LR\n  A --> broken";
  const h = harness(fence(source));
  await settle();
  h.setText(fence(broken), t.mock.timers);
  await settle();
  assert.equal(h.shown()[0]?.stale, true, "the last good drawing stays, dimmed");

  // enough other diagrams that the cache lets the first drawing go
  const others = Array.from({ length: DRAWING_CACHE_SIZE }, (_, index) => fence(`flowchart other ${index}`));
  h.setText([fence(broken), ...others].join("\n"), t.mock.timers);
  await settle();
  h.setText(fence(broken), t.mock.timers);
  await settle();

  // the chart pasted as it was: drawn anew
  h.setText(fence(broken) + "\n" + fence(source), t.mock.timers);
  await settle();
  const pasted = h.slots()[1]!;
  const figure = pasted.querySelector<HTMLElement>(".md-mermaid-diagram")!;
  const svg = figure.querySelector("svg");
  assert.equal(h.shown()[1]?.text, label(source));
  // the reader is in it: wider than its block, it took a tab stop
  Object.defineProperty(figure, "scrollWidth", { value: 1462, configurable: true });
  h.laidOut();
  figure.focus();
  assert.equal(h.win.document.activeElement, figure, "precondition: the reader's focus is on the diagram");

  // the original fixed: the pasted copy, a block the render keeps, stays as it is
  h.setText(fence(source) + "\n" + fence(source), t.mock.timers);
  await Promise.resolve();
  h.assertIdsOnce("before the browser paints");
  assert.equal(pasted.querySelector(".md-mermaid-diagram > svg"), svg, "the very node, not code, not a copy");
  assert.equal(h.win.document.activeElement, figure, "the focus stays on it");
  await settle();
  h.assertIdsOnce("once drawn");
  assert.deepEqual(
    h.shown().map(({ text, stale, code, busy }) => ({ text, stale, code, busy })),
    [
      { text: label(source), stale: false, code: undefined, busy: false },
      { text: label(source), stale: false, code: undefined, busy: false },
    ],
    "both drawn, neither left as code",
  );
  assert.equal(pasted.querySelector(".md-mermaid-diagram > svg"), svg);
  h.view.destroy();
});

/** a deterministic stream of numbers in [0, 1) (mulberry32) */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** few sources, so a document often shows one twice; a broken one keeps its last good drawing */
const POOL = [
  "gantt\n  title Plan\n  Design :a1, 2026-01-01, 10d",
  "gantt\n  title Plan\n  Design broken",
  "gantt\n  title Roadmap\n  Build :b1, 2026-02-01, 20d",
  "flowchart LR\n  A --> B",
  "flowchart LR\n  A --> broken",
  "sequenceDiagram\n  A->>B: hi",
];
const WIDTHS = [432, 560, 720];
const FUZZ_RUNS = 100;
const FUZZ_STEPS = 24;

test("fuzzed: reorder, delete, insert, edit and resize never put a drawing in two places, and every block ends on its own (#294)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  for (let seed = 1; seed <= FUZZ_RUNS; seed++) {
    const random = seeded(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const at = (length: number): number => Math.floor(random() * length);
    // half the diagrams have prose after them, as in a document: the view
    // keeps more blocks then, the others it matches among equal fences
    let notes = 0;
    const entry = (source: string) => ({ source, note: random() < 0.5 ? `Note ${++notes}.\n` : "" });
    const entries = [entry(pick(POOL)), entry(pick(POOL))];
    let intro = 0;
    const text = (): string =>
      [`Intro ${intro}.\n`, ...entries.map(({ source, note }) => fence(source) + (note && `\n${note}`))].join("\n");
    const h = harness(text(), { deferred: true });
    const steps: string[] = [];
    const where = (): string => `seed ${seed}, after ${steps.join(", ")}`;
    try {
      for (let step = 0; step < FUZZ_STEPS; step++) {
        const roll = random();
        if (roll < 0.15) {
          h.state.width = pick(WIDTHS);
          steps.push(`width ${h.state.width}`);
          h.laidOut();
        } else {
          if (roll < 0.3 || entries.length === 0) {
            const index = at(entries.length + 1);
            entries.splice(index, 0, entry(pick(POOL)));
            steps.push(`insert ${index}`);
          } else if (roll < 0.4) {
            const index = at(entries.length);
            entries.splice(index + 1, 0, entry(entries[index]!.source));
            steps.push(`paste ${index}`);
          } else if (roll < 0.5) {
            const index = at(entries.length);
            entries.splice(index, 1);
            steps.push(`delete ${index}`);
          } else if (roll < 0.6) {
            const [moved] = entries.splice(at(entries.length), 1);
            const index = at(entries.length + 1);
            entries.splice(index, 0, moved!);
            steps.push(`move to ${index}`);
          } else if (roll < 0.85) {
            const index = at(entries.length);
            entries[index]!.source = pick(POOL);
            steps.push(`edit ${index}`);
          } else if (roll < 0.97) {
            intro++;
            steps.push("edit elsewhere");
          } else {
            // so many other diagrams that the cache lets every drawing go
            steps.push("flood");
            const others = Array.from({ length: DRAWING_CACHE_SIZE + 1 }, (_, index) => `flowchart flood ${index}`);
            h.setText([text(), ...others.map(fence)].join("\n"), t.mock.timers);
            for (let task = 0; task < 4; task++) await settle();
          }
          h.setText(text(), t.mock.timers);
        }
        await Promise.resolve();
        h.assertIdsOnce(where());
        for (let tasks = at(4); tasks > 0; tasks--) {
          await settle();
          h.assertIdsOnce(where());
        }
      }
      for (let round = 0; round < 5; round++) {
        h.laidOut();
        for (let task = 0; task < 4; task++) await settle();
      }
      h.assertIdsOnce(`${where()}, settled`);
      const shown = h.shown();
      assert.equal(shown.length, entries.length, where());
      entries.forEach(({ source }, index) => {
        const block = shown[index]!;
        assert.equal(block.busy, false, `${where()}: block ${index} is done`);
        if (source.includes("broken")) {
          assert.equal(block.notice, true, `${where()}: block ${index} names its error`);
          return;
        }
        assert.equal(block.text, label(source), `${where()}: block ${index} shows its own diagram, not its code`);
        assert.equal(block.stale || block.notice, false, `${where()}: block ${index} is not dimmed`);
        if (source.startsWith("gantt")) {
          assert.equal(block.width, ganttWidth(h.state.width), `${where()}: block ${index} fits its block`);
        }
      });
    } finally {
      h.view.destroy();
    }
  }
});
