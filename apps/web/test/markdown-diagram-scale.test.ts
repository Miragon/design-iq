/**
 * How far a drawn Mermaid diagram may shrink in the Markdown view (#292,
 * src/notations/markdown/diagram-scale.ts) under jsdom: the minimum scale
 * from the diagram's smallest text, the fence holding the SVG to it, the
 * scroll region of a diagram wider than its block, and the width the fence
 * lays a diagram out at. jsdom lays nothing out, so a stand-in
 * ResizeObserver and the figure's widths stand in for the browser;
 * wide-mermaid-chromium.ts checks the real thing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";
import * as Y from "yjs";

import {
  fitDiagram,
  MAX_MINIMUM_SCALE,
  minimumScale,
  minimumWidth,
  SCROLL_REGION_LABEL,
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

/** a ResizeObserver that reports when the test says so */
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
  return { observed, laidOut: () => report?.([...observed].map((target) => ({ target }))) };
}

/** the widths a laid-out figure would report */
function sized(figure: Element, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(figure, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(figure, "clientWidth", { value: clientWidth, configurable: true });
}

function mount(source: string, svgOf: (source: string, id: string) => string) {
  const win = newWindow();
  const widths: (number | undefined)[] = [];
  const render: RenderMermaid = (text, idPrefix, width) => {
    widths.push(width);
    return Promise.resolve({ svg: svgOf(text, `${idPrefix}-${widths.length}`) });
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
  return { win, widths, container, render, ctx };
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
    return `<svg id="${id}" viewBox="0 0 900 90" width="100%"><text style="font-size: 16px">${source}</text></svg>`;
  });
  const observer = observeByHand(m.win);
  const view = mountMarkdownView(m.container, m.ctx, { mermaid: createMermaidFence(async () => m.render) });
  await settle();
  const [wide, narrow] = [...m.container.querySelectorAll<HTMLElement>(".md-mermaid-diagram")];
  assert.ok(wide && narrow && observer.observed.has(wide) && observer.observed.has(narrow), "each figure is watched");
  sized(wide, 1462, 720);
  sized(narrow, 720, 720);
  observer.laidOut();
  assert.equal(wide.tabIndex, 0);
  assert.equal(wide.getAttribute("role"), "region");
  assert.equal(wide.getAttribute("aria-label"), SCROLL_REGION_LABEL);
  assert.equal(narrow.hasAttribute("tabindex"), false);
  assert.equal(narrow.hasAttribute("role"), false);

  // the column widens (a wider window, the split's divider): it fits now
  sized(wide, 1462, 1462);
  observer.laidOut();
  assert.equal(wide.hasAttribute("tabindex"), false);
  assert.equal(wide.hasAttribute("role"), false);
  assert.equal(wide.hasAttribute("aria-label"), false);

  // a figure a render took off the page is no longer watched
  wide.remove();
  observer.laidOut();
  assert.equal(observer.observed.has(wide), false);
  view.destroy();
});

test("the fence lays a diagram out at the reading column's width, which a Gantt chart takes as its own", async () => {
  const m = mount(fence("gantt\n  title A plan"), (_source, id) => `<svg id="${id}"><text>plan</text></svg>`);
  Object.defineProperty(m.win.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("md-mermaid-block") ? 720 : 1280;
    },
  });
  const view = mountMarkdownView(m.container, m.ctx, { mermaid: createMermaidFence(async () => m.render) });
  await settle();
  assert.deepEqual(m.widths, [720], "the block's width, not the page's");
  view.destroy();
});
