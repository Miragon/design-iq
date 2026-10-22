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
