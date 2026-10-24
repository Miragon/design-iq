/**
 * How small a drawn diagram may get in the Markdown view (#292). mermaid
 * writes `width="100%"` and caps the SVG at its natural width, so a wide
 * diagram shrank into the reading column until its labels were 6 to 8 px
 * (C4 in particular). Now a diagram shrinks only as far as its smallest
 * text stays at the guide's `klein` size (13px, §4); a diagram drawn with
 * smaller text (a C4 type line is 10.5px) grows to it. One that is then
 * wider than its block scrolls sideways there, and the block becomes a
 * region the keyboard reaches and scrolls.
 *
 * The minimum follows the diagram's own smallest text, measured on the
 * page as the reader gets it, not a flat factor: a flowchart's 16px labels
 * may shrink to 81 %, a C4 diagram in mermaid's default fonts never below
 * 124 %.
 *
 * Node-loadable like the rest of the view (test/markdown-diagram-scale.test.ts
 * runs it under jsdom): every DOM access through the figure's own document.
 */

/** the guide's smallest text (§4, `klein`) */
export const SMALLEST_TEXT_PX = 13;
/** the guide's zoom ceiling (§5.8): text an author set hair-thin does not
 *  blow the diagram up without end */
export const MAX_MINIMUM_SCALE = 4;
/** what a screen reader announces for a diagram wider than its block */
export const SCROLL_REGION_LABEL = "Diagram, scroll sideways";

/** a drawn text's font size in the diagram's own units, undefined for text the diagram does not show */
export type FontSizeOf = (element: Element) => number | undefined;

/** the scale at which text of `fontSize` (in the diagram's units) reads at 13px */
export function minimumScale(fontSize: number): number {
  return Math.min(SMALLEST_TEXT_PX / fontSize, MAX_MINIMUM_SCALE);
}

/** the width of the diagram's own coordinates: what one CSS pixel of text is measured against */
export function viewBoxWidth(svg: Element): number | undefined {
  const [, , width] = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return width !== undefined && width > 0 ? width : undefined;
}

/** the browser's font size of an element: an SVG's font size is in its own units, whatever it is drawn at */
export const computedFontSize: FontSizeOf = (element) => {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style || style.display === "none" || style.visibility === "hidden") return undefined;
  const size = parseFloat(style.fontSize);
  return size > 0 ? size : undefined;
};

/** the size of the smallest text the diagram shows, labels in an HTML foreignObject included */
export function smallestFontSize(svg: Element, fontSizeOf: FontSizeOf = computedFontSize): number | undefined {
  const doc = svg.ownerDocument;
  const filter = doc.defaultView?.NodeFilter.SHOW_TEXT;
  if (filter === undefined) return undefined;
  // a layout engine knows which text it draws (mermaid leaves measuring
  // copies and a <switch>'s fallback in the SVG); without one, all of it counts
  const laidOut = svg.getClientRects().length > 0;
  let smallest: number | undefined;
  const walker = doc.createTreeWalker(svg, filter);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    if (!element || !node.textContent?.trim() || element.closest("style, title, desc")) continue;
    if (laidOut && element.getClientRects().length === 0) continue;
    const size = fontSizeOf(element);
    if (size !== undefined && (smallest === undefined || size < smallest)) smallest = size;
  }
  return smallest;
}

/** the width below which the diagram's smallest text reads under 13px; undefined for a diagram without
 *  coordinates of its own (it is drawn at its natural size) or without text */
export function minimumWidth(svg: Element, fontSizeOf?: FontSizeOf): number | undefined {
  const width = viewBoxWidth(svg);
  const fontSize = width === undefined ? undefined : smallestFontSize(svg, fontSizeOf);
  return width === undefined || fontSize === undefined ? undefined : Math.ceil(width * minimumScale(fontSize));
}

/** measured once per drawing: the view shows the same sanitized drawing again on every render */
const minimumWidths = new WeakMap<Element, number>();
/** one per window: figures come and go with every render */
const observers = new WeakMap<Window, ResizeObserver>();

/**
 * Hold a drawn diagram to its minimum width and make its figure a scroll
 * region while it is wider than its block. `drawing` is the sanitized
 * original the figure shows a copy of; call it once the figure is on the
 * page, so the copy's text can be measured.
 */
export function fitDiagram(figure: HTMLElement, drawing: Element, fontSizeOf?: FontSizeOf): void {
  const svg = figure.querySelector("svg");
  if (!svg) return;
  let width = minimumWidths.get(drawing);
  if (width === undefined) {
    width = minimumWidth(svg, fontSizeOf);
    if (width !== undefined) minimumWidths.set(drawing, width);
  }
  if (width !== undefined) {
    svg.style.minWidth = `${width}px`;
    // a fixed height (mermaid's useMaxWidth off, a journey) would keep a wider SVG's drawing at its old scale
    if (svg.hasAttribute("height")) svg.style.height = "auto";
  }
  watchOverflow(figure);
}

/** a figure wider than its block is a focusable region, so the keyboard scrolls it; one that fits is no tab stop */
export function markScrollRegion(figure: HTMLElement): void {
  if (figure.scrollWidth > figure.clientWidth) {
    figure.tabIndex = 0;
    figure.setAttribute("role", "region");
    figure.setAttribute("aria-label", SCROLL_REGION_LABEL);
  } else {
    figure.removeAttribute("tabindex");
    figure.removeAttribute("role");
    figure.removeAttribute("aria-label");
  }
}

/** overflow needs layout: checked once it is laid out and whenever the column changes width (the window, the split) */
function watchOverflow(figure: HTMLElement): void {
  const win = figure.ownerDocument.defaultView;
  if (!win?.ResizeObserver) return;
  let observer = observers.get(win);
  if (!observer) {
    const created: ResizeObserver = new win.ResizeObserver((entries) => {
      for (const { target } of entries) {
        if (target.isConnected) markScrollRegion(target as HTMLElement);
        else created.unobserve(target);
      }
    });
    observers.set(win, (observer = created));
  }
  observer.observe(figure);
}
