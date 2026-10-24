/**
 * How small a drawn diagram may get in the Markdown view (#292). mermaid
 * writes `width="100%"` and caps the SVG at its natural width, so a wide
 * diagram shrank into the reading column until its labels were 6 to 8 px
 * (C4 in particular). Now a diagram shrinks only as far as its smallest
 * text stays at the guide's `klein` size (13px, §4); a diagram drawn with
 * smaller text (a C4 type line is 10.5px) grows to it. One that is then
 * wider than its block scrolls sideways there, and the block becomes a
 * region the keyboard reaches and scrolls. A diagram that takes the width it
 * is laid out at as its own (a Gantt chart) is laid out narrower instead, so
 * that it fits its block at 13px, and anew whenever its block changes width.
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
/** the class of the block a drawn diagram sits in, the one that scrolls (./mermaid-fence.ts) */
export const DIAGRAM_CLASS = "md-mermaid-diagram";
/** the slot ./mermaid-fence.ts puts each fence in: the diagram's block once
 *  it is drawn, the fence's code while it draws or when it cannot be */
const SLOT_CLASS = "md-mermaid-block";

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

/** whether a drawing took the width it was laid out at as its own (a Gantt
 *  chart), rather than a width of its own (C4, a flowchart) */
export function takesItsWidth(drawing: Element, laidOutAt: number): boolean {
  const width = viewBoxWidth(drawing);
  return width !== undefined && Math.abs(width - laidOutAt) <= 1;
}

/**
 * The width to lay a diagram out at once more. A Gantt chart takes the width
 * it is laid out at as its own, and its 10px axis labels would then hold it
 * to 130 % of its block: laid out at the block's width over its minimum
 * scale, it fits the block at 13px. Undefined for a diagram with a width of
 * its own (its viewBox is not the width it was given) and for one whose
 * text needs no more. Measured on a copy in `block`, where the diagram's text
 * inherits what it will in the figure, or in the page's body once a newer
 * render has taken the block off the page: a detached copy has no style.
 */
export function refitWidth(
  drawing: Element,
  laidOutAt: number,
  block: HTMLElement,
  fontSizeOf?: FontSizeOf,
): number | undefined {
  if (!takesItsWidth(drawing, laidOutAt)) return undefined;
  const doc = block.ownerDocument;
  const copy = doc.importNode(drawing, true);
  const probe = doc.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  Object.assign(probe.style, { position: "fixed", top: "0", left: "-100000px", width: `${laidOutAt}px` });
  probe.append(copy);
  (block.isConnected ? block : doc.body).append(probe);
  try {
    const fontSize = smallestFontSize(copy, fontSizeOf);
    const scale = fontSize === undefined ? 1 : minimumScale(fontSize);
    return scale > 1 ? Math.floor(laidOutAt / scale) : undefined;
  } finally {
    probe.remove();
  }
}

/** the drawing a source lays out to for its block's width now; undefined when it cannot be drawn */
export type Relayout = (block: HTMLElement) => Promise<Element | undefined>;

/** measured once per drawing: the view shows the same sanitized drawing again on every render */
const minimumWidths = new WeakMap<Element, number>();
/** the drawings that take the width they are laid out at as their own: the block width each was laid out for */
const followers = new WeakMap<Element, { width: number; relayout: Relayout }>();
/** the drawing each figure shows a copy of */
const shownDrawings = new WeakMap<Element, Element>();
/** figures whose drawing is being laid out anew: one layout at a time, the next for the width the block has then */
const relayingOut = new WeakSet<Element>();
/** one per window: slots come and go with every render */
const observers = new WeakMap<Window, ResizeObserver>();

/**
 * Lay `drawing` out anew whenever its block changes width (Split to Markdown
 * only, the split's divider, the window). It takes the width it is laid out
 * at as its own (`takesItsWidth`), so it would otherwise stay as wide as the
 * block it was first drawn in. `laidOutFor` is that block's width.
 */
export function followBlockWidth(drawing: Element, laidOutFor: number, relayout: Relayout): void {
  followers.set(drawing, { width: laidOutFor, relayout });
}

/**
 * Hold a drawn diagram to its minimum width. `drawing` is the sanitized
 * original the figure shows a copy of; call it once the figure is on the
 * page, so the copy's text can be measured.
 */
export function fitDiagram(figure: HTMLElement, drawing: Element, fontSizeOf?: FontSizeOf): void {
  const svg = figure.querySelector("svg");
  if (!svg) return;
  shownDrawings.set(figure, drawing);
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
}

/**
 * A fence's slot once its content changed, drawn or not: its diagram held to
 * its minimum width, and the slot watched. While the diagram is wider than
 * the slot, it is a named scroll region; a slot that comes or goes renames
 * every region below it. Call it once the slot is on the page.
 */
export function fitDiagramSlot(slot: HTMLElement, drawing: Element | undefined): void {
  const figure = figureIn(slot);
  if (figure && drawing) fitDiagram(figure, drawing);
  watch(slot);
}

/** a slot's drawn diagram, the block that scrolls */
function figureIn(slot: Element): HTMLElement | undefined {
  return [...slot.children].find((child) => child.classList.contains(DIAGRAM_CLASS)) as HTMLElement | undefined;
}

/** a diagram type as mermaid names it on the SVG, in words: flowchart-v2 is a flowchart, classDiagram a class diagram */
export function diagramTypeName(svg: Element): string | undefined {
  const role = svg
    .getAttribute("aria-roledescription")
    ?.trim()
    .replace(/-v\d+$/, "");
  if (!role) return undefined;
  return role.length <= 2 ? role.toUpperCase() : role.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/**
 * What a screen reader announces for a diagram wider than its block. Each
 * such block is a region, a landmark, and a document may hold several:
 * WAI-ARIA asks for a name of its own on each, so it names the diagram by
 * its place among the document's diagrams and by its title (mermaid's
 * accTitle) or else its type.
 */
export function scrollRegionLabel(position: number, svg: Element | null): string {
  const title = [...(svg?.children ?? [])].find((child) => child.localName === "title")?.textContent?.trim();
  const type = svg ? diagramTypeName(svg) : undefined;
  const name = title ? `Diagram ${position}: ${title}` : type ? `Diagram ${position} (${type})` : `Diagram ${position}`;
  return `${name}, scrolls sideways`;
}

/** a figure that fits has kept its tab stop while it had the focus: it gives it up once the focus moves on */
const unmarkOnBlur = (event: Event): void => markScrollRegion(event.currentTarget as HTMLElement);

/** a figure wider than its block is a focusable region, so the keyboard scrolls it; one that fits is no tab stop */
export function markScrollRegion(figure: HTMLElement): void {
  if (figure.scrollWidth > figure.clientWidth) {
    figure.tabIndex = 0;
    figure.setAttribute("role", "region");
  } else if (figure === figure.ownerDocument.activeElement) {
    // without its tab stop the focus would drop to the body, and the reader's next Tab start over at the top
    figure.addEventListener("blur", unmarkOnBlur, { once: true });
  } else {
    figure.removeAttribute("tabindex");
    figure.removeAttribute("role");
    figure.removeAttribute("aria-label");
  }
}

/** every region of a document named anew, numbered among all mermaid fences: one that shows its code still takes its place */
export function nameScrollRegions(doc: Document): void {
  doc.querySelectorAll(`.${SLOT_CLASS}`).forEach((slot, index) => {
    const figure = figureIn(slot);
    if (figure?.getAttribute("role") === "region") {
      figure.setAttribute("aria-label", scrollRegionLabel(index + 1, figure.querySelector("svg")));
    }
  });
}

/** a drawing that takes its width as its own, laid out anew for its slot's width once that changed */
function followWidth(slot: HTMLElement, figure: HTMLElement): void {
  const drawing = shownDrawings.get(figure);
  const follower = drawing && followers.get(drawing);
  const width = slot.clientWidth;
  if (!follower || relayingOut.has(figure) || width <= 0 || Math.abs(width - follower.width) <= 1) return;
  relayingOut.add(figure);
  void follower
    .relayout(slot)
    .then(
      (next) => {
        if (!next || !figure.isConnected || shownDrawings.get(figure) !== drawing) return;
        figure.replaceChildren(figure.ownerDocument.importNode(next, true));
        fitDiagramSlot(slot, next);
      },
      () => undefined,
    )
    .finally(() => relayingOut.delete(figure));
}

/** overflow needs layout: checked once a slot is laid out, whenever its content changes and whenever the column
 *  changes width (the window, the split) */
function watch(slot: HTMLElement): void {
  const win = slot.ownerDocument.defaultView;
  if (!win?.ResizeObserver) return;
  let observer = observers.get(win);
  if (!observer) {
    const created: ResizeObserver = new win.ResizeObserver((entries) => {
      for (const { target } of entries) {
        if (!target.isConnected) {
          created.unobserve(target);
          continue;
        }
        const figure = figureIn(target);
        if (!figure) continue;
        markScrollRegion(figure);
        followWidth(target as HTMLElement, figure);
      }
      // a slot that left the page, too: the ones below it moved up a place
      nameScrollRegions(win.document);
    });
    observers.set(win, (observer = created));
  }
  // observed afresh, so the observer reports new content at the slot's old size too
  observer.unobserve(slot);
  observer.observe(slot);
}
