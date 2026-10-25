/**
 * The real mermaid (apps/web's pin) under jsdom, for the suites that run it
 * (mermaid-engine.test.ts, mermaid-engine-hostile.test.ts): the DOM globals
 * mermaid reads, and stand-ins for what jsdom lacks. jsdom has no layout, so
 * every label measures one fixed box: enough to compare two drawings of the
 * same diagram, and to draw every diagram type. node --test runs each suite in
 * its own process, so the globals stay out of the other suites.
 */
import { type ConstructorOptions, JSDOM } from "jsdom";
import type { Mermaid } from "mermaid";

/** the globals mermaid and its sanitizer read; mermaid builds a diagram's
 *  classDef and C4 font rules in a CSSStyleSheet of its own */
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "Element",
  "HTMLElement",
  "SVGElement",
  "DOMParser",
  "Image",
  "CSSStyleSheet",
];

/** what a canvas measures: some diagram types size their text on one */
const CONTEXT_2D = new Proxy(
  {},
  {
    get: (_target, key) => (key === "measureText" ? () => ({ width: 40 }) : () => undefined),
    set: () => true,
  },
);

/**
 * Make `window` mermaid's DOM and load mermaid through the app's renderer
 * (lib/mermaid-render.ts: its configuration, Geist awaited). Resolves once
 * mermaid has registered its diagram detectors.
 */
export async function loadMermaidUnderJsdom(
  options: ConstructorOptions = {},
): Promise<{ window: JSDOM["window"]; mermaid: Mermaid }> {
  const { window } = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, ...options });
  for (const key of GLOBALS) {
    if (!(key in globalThis)) {
      Object.defineProperty(globalThis, key, {
        value: (window as unknown as Record<string, unknown>)[key],
        configurable: true,
        writable: true,
      });
    }
  }
  Object.assign(window.SVGElement.prototype, {
    getBBox: () => ({ x: 0, y: 0, width: 40, height: 16 }),
    getComputedTextLength: () => 40,
  });
  window.HTMLCanvasElement.prototype.getContext = (() => CONTEXT_2D) as never;
  // mermaid waits for a label's images before it measures it; jsdom loads none
  Object.defineProperty(window.HTMLImageElement.prototype, "complete", { get: () => true, configurable: true });
  const { loadMermaid } = await import("../src/lib/mermaid-render.ts");
  const mermaid = await loadMermaid();
  // the first parse registers mermaid's diagram detectors (detectType needs them)
  await mermaid.parse("flowchart LR\n  A --> B\n");
  return { window, mermaid };
}

/** the properties an SVG element takes from its parent when no rule sets them */
const INHERITED = new Set(["fill", "stroke", "color", "fill-opacity", "stroke-opacity"]);

/** a selector jsdom cannot read matches nothing, as in a browser that does not know it */
const matches = (element: Element, selector: string): boolean => {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
};

/** a selector's specificity as one number: ids, then classes, attributes and pseudo-classes, then types */
function specificity(selector: string): number {
  const bare = selector.replace(/"[^"]*"|'[^']*'/g, "");
  const ids = bare.match(/#[\w-]+/g)?.length ?? 0;
  const classes = bare.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g)?.length ?? 0;
  const types =
    bare.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:+[\w-]+(?:\([^)]*\))?/g, " ").match(/(?:^|[\s>+~])[a-z][\w-]*/gi)
      ?.length ?? 0;
  return ids * 10_000 + classes * 100 + types;
}

/**
 * The value a browser gives an element's `property` in a drawn diagram, which
 * jsdom does not compute for SVG: of the rules in the diagram's style sheets
 * that match the element, its style attribute and its presentation
 * attribute, the one that wins by importance, specificity and order; a
 * colour or an opacity the element sets nowhere comes from its parent. Read
 * as mermaid writes its selectors (no :is(), :where() or :not()).
 */
export function drawnStyle(element: Element, property: string): string | undefined {
  const svg = element.closest("svg");
  const win = element.ownerDocument.defaultView!;
  let best: { rank: number; specificity: number; order: number; value: string } | undefined;
  const consider = (rank: number, specificity: number, order: number, value: string): void => {
    if (!value) return;
    const wins =
      !best ||
      rank > best.rank ||
      (rank === best.rank &&
        (specificity > best.specificity || (specificity === best.specificity && order >= best.order)));
    if (wins) best = { rank, specificity, order, value };
  };
  consider(0, 0, 0, element.getAttribute(property) ?? "");
  let order = 0;
  for (const style of svg?.querySelectorAll("style") ?? []) {
    const sheet = new win.CSSStyleSheet();
    sheet.replaceSync(style.textContent ?? "");
    for (const rule of sheet.cssRules) {
      order++;
      if (!(rule instanceof win.CSSStyleRule)) continue;
      const value = rule.style.getPropertyValue(property);
      if (!value) continue;
      const important = rule.style.getPropertyPriority(property) === "important";
      for (const selector of rule.selectorText.split(",")) {
        if (matches(element, selector)) consider(important ? 3 : 1, specificity(selector), order, value);
      }
    }
  }
  const inline = (element as HTMLElement).style;
  if (inline?.getPropertyValue(property)) {
    consider(inline.getPropertyPriority(property) === "important" ? 4 : 2, 0, 0, inline.getPropertyValue(property));
  }
  if (!best && INHERITED.has(property) && element.parentElement && element !== svg) {
    return drawnStyle(element.parentElement, property);
  }
  return best?.value;
}
