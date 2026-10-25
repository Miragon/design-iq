/**
 * How far a drawn Mermaid diagram may shrink in the Markdown view (#292,
 * src/notations/markdown/diagram-scale.ts) under jsdom: the minimum scale
 * from the diagram's smallest text, the fence holding the SVG to it, the
 * scroll region of a diagram wider than its block and its name, and the
 * widths the fence lays a diagram out at, also once its block changes width.
 * jsdom lays nothing out, so a stand-in ResizeObserver and the figure's
 * widths stand in for the browser; wide-mermaid-chromium.ts checks the real
 * thing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";
import * as Y from "yjs";

import {
  diagramTypeName,
  fitDiagram,
  MAX_MINIMUM_SCALE,
  minimumScale,
  minimumWidth,
  refitWidth,
  scrollRegionLabel,
  SMALLEST_TEXT_PX,
  smallestFontSize,
} from "../src/notations/markdown/diagram-scale.ts";
import { createMermaidFence, type RenderMermaid } from "../src/notations/markdown/mermaid-fence.ts";
import { mountMarkdownView } from "../src/notations/markdown/view.ts";
import type { EditorContext } from "../src/notations/registry.ts";

const newWindow = () =>
  new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://designiq.test/r/acme/models/f/docs/guide.md",
    virtualConsole: new VirtualConsole(),
  }).window;

type Win = ReturnType<typeof newWindow>;

/** let the hydration (microtasks and the fake renderer) run */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const fence = (body: string): string => "```mermaid\n" + body + "\n```\n";

/** an SVG on the page of `win`, as mermaid writes it */
function svgOn(win: Win, markup: string): SVGSVGElement {
  const box = win.document.createElement("div");
  box.innerHTML = markup;
  win.document.body.append(box);
  return box.querySelector("svg")!;
}

/** C4's default fonts: names 14px, type lines 0.75em of that (10.5px), relations 12px */
const WIDE_C4 =
  '<svg viewBox="0 -70 1148 699" width="100%" style="max-width: 1148px;" aria-roledescription="c4">' +
  '<title style="font-size: 2px">Order platform</title>' +
  '<text style="font-size: 14px"><tspan>Customer</tspan></text>' +
  '<text style="font-size: 10.5px"><tspan>[Person]</tspan></text>' +
  '<text style="font-size: 12px"><tspan>Orders with</tspan></text>' +
  '<text style="font-size: 4px">   </text>' +
  "</svg>";
/** a flowchart's labels: HTML in a foreignObject, 16px from the diagram's own style */
const WIDE_FLOWCHART =
  '<svg viewBox="0 0 3603 94" width="100%" style="max-width: 3603px; font-size: 16px;" aria-roledescription="flowchart-v2">' +
  '<foreignObject width="120" height="24"><div xmlns="http://www.w3.org/1999/xhtml"><p>Step 1 of the flow</p></div></foreignObject>' +
  "</svg>";

test("the minimum scale is 13px over the diagram's smallest text, not a flat factor", () => {
  assert.equal(SMALLEST_TEXT_PX, 13, "the guide's klein size");
  assert.equal(minimumScale(16), 0.8125, "16px labels may shrink to 81 %");
  assert.equal(minimumScale(13), 1);
  assert.equal(minimumScale(12), 13 / 12, "C4's 12px relations stay above 100 %");
  assert.equal(minimumScale(10.5), 13 / 10.5, "and its 10.5px type lines at 124 %");
  assert.equal(minimumScale(1), MAX_MINIMUM_SCALE, "a hair-thin font grows the diagram to the guide's zoom ceiling");
});

test("the smallest text counts: tspans, HTML labels, never a title, a style or blank text", () => {
  const win = newWindow();
  assert.equal(smallestFontSize(svgOn(win, WIDE_C4)), 10.5);
  assert.equal(smallestFontSize(svgOn(win, WIDE_FLOWCHART)), 16, "a label inherits the diagram's font size");
  assert.equal(smallestFontSize(svgOn(win, '<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>')), undefined);
});

test("a wide diagram's minimum width keeps its smallest text at 13px", () => {
  const win = newWindow();
  assert.equal(minimumWidth(svgOn(win, WIDE_C4)), Math.ceil((1148 * 13) / 10.5));
  assert.equal(minimumWidth(svgOn(win, WIDE_FLOWCHART)), Math.ceil(3603 * 0.8125));
  assert.equal(
    minimumWidth(svgOn(win, '<svg width="400" height="80"><text style="font-size: 8px">fixed</text></svg>')),
    undefined,
    "an SVG without coordinates of its own is drawn at its natural size, never scaled",
  );
});

test("a drawing is measured once, and a fixed height gives way to the minimum width", () => {
  const win = newWindow();
  const drawing = svgOn(win, '<svg viewBox="0 0 500 540" height="565"><text>Journey</text></svg>');
  drawing.remove();
  let measured = 0;
  const fontSizeOf = (): number => (measured++, 10);
  const figures = [0, 1].map(() => {
    const figure = win.document.createElement("div");
    figure.append(win.document.importNode(drawing, true));
    win.document.body.append(figure);
    fitDiagram(figure, drawing, fontSizeOf);
    return figure.querySelector("svg")!;
  });
  assert.equal(measured, 1, "the second copy of the same drawing takes the first one's measure");
  for (const svg of figures) {
    assert.equal(svg.style.minWidth, "650px");
    assert.equal(svg.style.height, "auto");
  }
});

test("a diagram that takes the width it is laid out at as its own is laid out narrower, so it fits at 13px", () => {
  const win = newWindow();
  const block = win.document.createElement("div");
  win.document.body.append(block);
  const drawn = (markup: string): Element => {
    const svg = svgOn(win, markup);
    svg.remove();
    return svg;
  };
  const gantt = drawn('<svg viewBox="0 0 720 148"><text style="font-size: 10px">Jan 04</text></svg>');
  assert.equal(refitWidth(gantt, 720, block), Math.floor((720 * 10) / 13), "10px axis labels: 720 × 10 / 13");
  assert.equal(block.childElementCount, 0, "the copy it measured is gone");
  block.remove();
  // a browser computes no style for a node off the page
  const styledOnPage = (element: Element): number | undefined => (element.isConnected ? 10 : undefined);
  assert.equal(
    refitWidth(gantt, 720, block, styledOnPage),
    553,
    "a block a newer render took off the page: measured in the body",
  );
  assert.equal(win.document.body.querySelector("[aria-hidden]"), null);
  assert.equal(
    minimumWidth(drawn('<svg viewBox="0 0 553 148"><text style="font-size: 10px">Jan 04</text></svg>')),
    719,
  );
  assert.equal(
    refitWidth(drawn('<svg viewBox="0 0 720 148"><text style="font-size: 14px">Jan 04</text></svg>'), 720, block),
    undefined,
    "text that reads at 13px at that width needs no second layout",
  );
  assert.equal(
    refitWidth(drawn('<svg viewBox="0 0 1148 699"><text style="font-size: 10.5px">[Person]</text></svg>'), 720, block),
    undefined,
    "a diagram with a width of its own (C4) is not laid out again: a narrower frame would not change it",
  );
});

test("a scroll region's name: its place among the diagrams and its title or type", () => {
  const win = newWindow();
  const flowchart = svgOn(win, '<svg aria-roledescription="flowchart-v2"><text>A</text></svg>');
  const titled = svgOn(
    win,
    '<svg aria-roledescription="flowchart-v2" aria-labelledby="chart-title-1"><title id="chart-title-1">Order flow</title></svg>',
  );
  assert.equal(diagramTypeName(flowchart), "flowchart");
  assert.equal(diagramTypeName(svgOn(win, '<svg aria-roledescription="c4"></svg>')), "C4");
  assert.equal(diagramTypeName(svgOn(win, '<svg aria-roledescription="classDiagram"></svg>')), "class diagram");
  assert.equal(scrollRegionLabel(1, flowchart), "Diagram 1 (flowchart), scrolls sideways");
  assert.equal(scrollRegionLabel(2, titled), "Diagram 2: Order flow, scrolls sideways", "mermaid's accTitle");
  assert.equal(scrollRegionLabel(3, svgOn(win, "<svg></svg>")), "Diagram 3, scrolls sideways");
});

/** a ResizeObserver that reports when the test says so: every watched slot, or as a browser does, only those that
 *  changed (a slot that left the page reports, the ones left in place do not) */
function observeByHand(win: Win) {
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
  return {
    observed,
    laidOut: (targets: Element[] = [...observed]) => report?.(targets.map((target) => ({ target }))),
  };
}

/** the widths a laid-out figure would report */
function sized(figure: Element, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(figure, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(figure, "clientWidth", { value: clientWidth, configurable: true });
}

function mount(source: string, svgOf: (source: string, id: string, width: number | undefined) => string) {
  const win = newWindow();
  /** each render's source (without the fence's last line break) and width */
  const renders: [source: string, width: number | undefined][] = [];
  const render: RenderMermaid = (text, idPrefix, width) => {
    renders.push([text.trimEnd(), width]);
    return Promise.resolve({ svg: svgOf(text, `${idPrefix}-${renders.length}`, width) });
  };
  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, source);
  const ctx: EditorContext = {
    ytext: ydoc.getText("content"),
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
  return { win, renders, container, render, ctx };
}

test("the fence holds a drawn diagram to the width its smallest text needs", async () => {
  const m = mount(fence("C4Context wide") + "\n" + fence("flowchart narrow"), (source, id) =>
    source.startsWith("C4Context")
      ? `<svg id="${id}" viewBox="0 0 2000 600" width="100%" style="max-width: 2000px;"><text style="font-size: 12px">Orders with</text></svg>`
      : `<svg id="${id}" viewBox="0 0 400 90" width="100%" style="max-width: 400px;"><text style="font-size: 16px">Start</text></svg>`,
  );
  const view = mountMarkdownView(m.container, m.ctx, { mermaid: createMermaidFence(async () => m.render) });
  await settle();
  const [wide, narrow] = [...m.container.querySelectorAll<SVGSVGElement>(".md-mermaid-diagram > svg")];
  assert.equal(wide?.style.minWidth, "2167px", "12px text at 13px: 2000 × 13 / 12");
  assert.equal(wide?.style.maxWidth, "2000px", "mermaid's own cap stays");
  assert.equal(narrow?.style.minWidth, "325px", "16px labels may shrink to 400 × 13 / 16");
  view.destroy();
});

test("a diagram wider than its block is a focusable region the keyboard scrolls; one that fits is no tab stop", async () => {
  const m = mount(fence("flowchart wide") + "\n" + fence("flowchart narrow"), (source, id) => {
    return `<svg id="${id}" viewBox="0 0 900 90" width="100%" aria-roledescription="flowchart-v2"><text style="font-size: 16px">${source}</text></svg>`;
  });
  const observer = observeByHand(m.win);
  const view = mountMarkdownView(m.container, m.ctx, { mermaid: createMermaidFence(async () => m.render) });
  await settle();
  const [wide, narrow] = [...m.container.querySelectorAll<HTMLElement>(".md-mermaid-diagram")];
  assert.ok(
    wide && narrow && observer.observed.has(wide.parentElement!) && observer.observed.has(narrow.parentElement!),
    "each diagram's slot is watched",
  );
  sized(wide, 1462, 720);
  sized(narrow, 720, 720);
  observer.laidOut();
  assert.equal(wide.tabIndex, 0);
  assert.equal(wide.getAttribute("role"), "region");
  assert.equal(wide.getAttribute("aria-label"), "Diagram 1 (flowchart), scrolls sideways");
  assert.equal(narrow.hasAttribute("tabindex"), false);
  assert.equal(narrow.hasAttribute("role"), false);
  assert.equal(narrow.hasAttribute("aria-label"), false);

  // the column widens (a wider window, the split's divider) while the reader is in it: it fits now, and keeps its
  // tab stop until the focus leaves, so the focus does not drop to the body and the next Tab start at the top
  wide.focus();
  sized(wide, 1462, 1462);
  observer.laidOut();
  assert.equal(m.win.document.activeElement, wide);
  assert.equal(wide.tabIndex, 0);
  assert.equal(wide.getAttribute("role"), "region");
  wide.blur();
  assert.equal(wide.hasAttribute("tabindex"), false);
  assert.equal(wide.hasAttribute("role"), false);
  assert.equal(wide.hasAttribute("aria-label"), false);

  // a slot a render took off the page is no longer watched
  const slot = wide.parentElement!;
  slot.remove();
  observer.laidOut([slot]);
  assert.equal(observer.observed.has(slot), false);
  view.destroy();
});

test("every scroll region of a document has a name of its own, by its place among the diagrams", async () => {
  const m = mount(
    fence("flowchart one") + "\n" + fence("flowchart two") + "\n" + fence("flowchart three"),
    (source, id) =>
      `<svg id="${id}" viewBox="0 0 900 90" width="100%" aria-roledescription="flowchart-v2">` +
      (source.includes("two") ? `<title>Order flow</title>` : "") +
      `<text style="font-size: 16px">${source}</text></svg>`,
  );
  const observer = observeByHand(m.win);
  const view = mountMarkdownView(m.container, m.ctx, { mermaid: createMermaidFence(async () => m.render) });
  await settle();
  const figures = [...m.container.querySelectorAll<HTMLElement>(".md-mermaid-diagram")];
  for (const figure of figures) sized(figure, 1462, 720);
  observer.laidOut();
  assert.deepEqual(
    figures.map((figure) => figure.getAttribute("aria-label")),
    [
      "Diagram 1 (flowchart), scrolls sideways",
      "Diagram 2: Order flow, scrolls sideways",
      "Diagram 3 (flowchart), scrolls sideways",
    ],
  );

  // a diagram above leaves the page and the view keeps the others' slots (#289): only the one that left reports
  const first = figures[0]!.parentElement!;
  first.remove();
  observer.laidOut([first]);
  assert.deepEqual(
    figures.slice(1).map((figure) => figure.getAttribute("aria-label")),
    ["Diagram 1: Order flow, scrolls sideways", "Diagram 2 (flowchart), scrolls sideways"],
  );
  view.destroy();
});

test("a fence that shows its code, one mermaid cannot draw, still takes its place among the diagrams", async () => {
  const m = mount(
    fence("flowchart one") + "\n" + fence("flowchart two") + "\n" + fence("flowchart three"),
    (source, id) =>
      source.includes("one")
        ? ""
        : `<svg id="${id}" viewBox="0 0 900 90" width="100%" aria-roledescription="flowchart-v2"><text style="font-size: 16px">${source}</text></svg>`,
  );
  const observer = observeByHand(m.win);
  const view = mountMarkdownView(m.container, m.ctx, { mermaid: createMermaidFence(async () => m.render) });
  await settle();
  assert.equal(m.container.querySelectorAll(".md-mermaid-block > pre").length, 1, "the first shows its code");
  const figures = [...m.container.querySelectorAll<HTMLElement>(".md-mermaid-diagram")];
  for (const figure of figures) sized(figure, 1462, 720);
  observer.laidOut();
  assert.deepEqual(
    figures.map((figure) => figure.getAttribute("aria-label")),
    ["Diagram 2 (flowchart), scrolls sideways", "Diagram 3 (flowchart), scrolls sideways"],
  );
  view.destroy();
});

/** a layout where a diagram block is 720px wide, 690px in a quote, and anything else 1280px */
function blockWidths(win: Win): void {
  Object.defineProperty(win.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList.contains("md-mermaid-block")) return 1280;
      return this.closest("blockquote") ? 690 : 720;
    },
  });
}

/** a Gantt chart takes the width it is laid out at as its own; its axis labels are 10px */
const ganttAt = (id: string, width: number | undefined): string =>
  `<svg id="${id}" viewBox="0 0 ${width ?? 1280} 148" width="100%" style="max-width: ${width ?? 1280}px;">` +
  '<g font-size="10"><text style="font-size: 10px">Jan 04</text></g></svg>';

test("the fence lays a diagram out at its own block's width, not the page's or another block's", async () => {
  const m = mount(
    fence("flowchart LR\n  A --> B") + "\n> " + fence("flowchart TD\n  C --> D").replace(/\n(?=.)/g, "\n> "),
    (_source, id) =>
      `<svg id="${id}" viewBox="0 0 400 90" width="100%"><text style="font-size: 16px">plan</text></svg>`,
  );
  blockWidths(m.win);
  const view = mountMarkdownView(m.container, m.ctx, { mermaid: createMermaidFence(async () => m.render) });
  await settle();
  assert.deepEqual(m.renders, [
    ["flowchart LR\n  A --> B", 720],
    ["flowchart TD\n  C --> D", 690],
  ]);
  view.destroy();
});

test("a Gantt chart is laid out once more, at its block's width over its minimum scale, and fits its block at 13px", async () => {
  const plan = "gantt\n  title A plan\n  Design :a1, 2026-01-01, 10d";
  const quoted = "gantt\n  title A quoted plan\n  Design :a1, 2026-01-01, 10d";
  const m = mount(fence(plan) + "\n> " + fence(quoted).replace(/\n(?=.)/g, "\n> "), (_source, id, width) =>
    ganttAt(id, width),
  );
  blockWidths(m.win);
  const view = mountMarkdownView(m.container, m.ctx, { mermaid: createMermaidFence(async () => m.render) });
  await settle();
  assert.deepEqual(
    m.renders.filter(([source]) => source === plan).map(([, width]) => width),
    [720, Math.floor((720 * 10) / 13)],
    "laid out at the block's 720px, then at 720 × 10 / 13",
  );
  assert.deepEqual(
    m.renders.filter(([source]) => source === quoted).map(([, width]) => width),
    [690, Math.floor((690 * 10) / 13)],
    "the one in the quote at its own block's width",
  );
  const [top, inQuote] = [...m.container.querySelectorAll<SVGSVGElement>(".md-mermaid-diagram > svg")];
  assert.equal(top?.getAttribute("viewBox"), "0 0 553 148", "the page shows the second layout");
  assert.equal(top?.style.minWidth, "719px", "its 10px labels at 13px: 553 × 13 / 10, within the 720px block");
  assert.equal(inQuote?.style.minWidth, "689px", "530 × 13 / 10, within the 690px block");
  view.destroy();
});

test("a Gantt chart is laid out anew when its block changes width, and a diagram with a width of its own is not", async () => {
  const plan = "gantt\n  title A plan\n  Design :a1, 2026-01-01, 10d";
  const m = mount(fence(plan) + "\n" + fence("flowchart LR\n  A --> B"), (source, id, width) =>
    source.startsWith("gantt")
      ? ganttAt(id, width)
      : `<svg id="${id}" viewBox="0 0 400 90" width="100%"><text style="font-size: 16px">plan</text></svg>`,
  );
  let blockWidth = 432;
  Object.defineProperty(m.win.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("md-mermaid-block") ? blockWidth : 1280;
    },
  });
  const observer = observeByHand(m.win);
  const view = mountMarkdownView(m.container, m.ctx, { mermaid: createMermaidFence(async () => m.render) });
  await settle();
  const ganttWidths = (): (number | undefined)[] =>
    m.renders.filter(([source]) => source === plan).map(([, width]) => width);
  const shown = (): SVGSVGElement => m.container.querySelector<SVGSVGElement>(".md-mermaid-diagram > svg")!;
  assert.deepEqual(ganttWidths(), [432, 332], "a 432px block: 432 × 10 / 13");
  observer.laidOut();
  await settle();
  assert.equal(ganttWidths().length, 2, "the block keeps its width: no new layout");

  // Split to Markdown only: the block widens to the column's 720px, twice reported before the layout is done
  blockWidth = 720;
  observer.laidOut();
  observer.laidOut();
  await settle();
  assert.deepEqual(ganttWidths(), [432, 332, 720, 553], "laid out once for the wider block");
  assert.equal(shown().getAttribute("viewBox"), "0 0 553 148");
  assert.equal(shown().style.minWidth, "719px", "it fills the 720px block, its labels at 13px");

  // back to the narrow block and to the wide one again: the layout for 720px is kept
  blockWidth = 432;
  observer.laidOut();
  await settle();
  assert.equal(shown().getAttribute("viewBox"), "0 0 332 148");
  blockWidth = 720;
  observer.laidOut();
  await settle();
  assert.equal(shown().getAttribute("viewBox"), "0 0 553 148");
  assert.equal(ganttWidths().length, 6, "only the narrow block's layout ran once more");

  // the next render of the document puts the drawing for the block's width back
  m.ctx.ytext.insert(0, "# Plan\n\n");
  await settle();
  assert.equal(shown().getAttribute("viewBox"), "0 0 553 148");
  assert.equal(ganttWidths().length, 6);
  assert.equal(
    m.renders.filter(([source]) => source.startsWith("flowchart")).length,
    1,
    "a flowchart has a width of its own: never laid out anew",
  );
  view.destroy();
});

test("two Gantt charts of one source are laid out anew a drawing each, so every id is on the page once (#294)", async () => {
  const plan = "gantt\n  title A plan\n  Design :a1, 2026-01-01, 10d";
  const m = mount(fence(plan) + "\n" + fence(plan), (_source, id, width) => ganttAt(id, width));
  let blockWidth = 432;
  Object.defineProperty(m.win.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("md-mermaid-block") ? blockWidth : 1280;
    },
  });
  const observer = observeByHand(m.win);
  const view = mountMarkdownView(m.container, m.ctx, { mermaid: createMermaidFence(async () => m.render) });
  await settle();
  const shown = (): SVGSVGElement[] => [...m.container.querySelectorAll<SVGSVGElement>(".md-mermaid-diagram > svg")];
  assert.equal(m.renders.length, 4, "each fence drawn for its own: laid out twice each");
  assert.equal(new Set(shown().map((svg) => svg.id)).size, 2);

  blockWidth = 720;
  observer.laidOut();
  await settle();
  assert.equal(m.renders.length, 8, "each laid out anew for the wider block");
  const ids = shown().map((svg) => svg.id);
  assert.equal(new Set(ids).size, 2, `each shows a drawing of its own: ${ids.join(" ")}`);
  for (const svg of shown()) assert.equal(svg.getAttribute("viewBox"), "0 0 553 148");
  view.destroy();
});
