/**
 * The bpmn-js / dmn-js canvases on the Miragon CI — the renderer options EVERY
 * construction takes: the SPA editors (notations/bpmn-editor.ts,
 * dmn-editor.ts), the history diff (notations/bpmn-diff.tsx) and the MCP-App
 * widgets (mcp-app/engines/bpmn.ts, dmn.ts). The chrome around the canvas
 * (palette, context pad, popups, decision table) is CSS: lib/bpmn-io-theme.css.
 *
 * Colours are LITERAL hex from the tokens.ts mirror, never var(--…): the
 * renderers write them as SVG presentation attributes, and an exported SVG or
 * PNG must stay self-contained and light (CI §10). The font is named the same
 * way — SVG <text> does not inherit a CSS font, the attribute is what an
 * export carries (CI §4); fonts.css loads Geist for the screen.
 */
import { ALIASES, FONT_SANS } from "@designiq/ui-kit/lib/tokens";

/** the label font (bpmn-js and dmn-js-drd share the TextRenderer config
 *  shape): only the family changes — size, weight and line height stay the
 *  renderers' defaults, so diagrams laid out elsewhere keep their geometry */
const textRenderer = {
  defaultStyle: { fontFamily: FONT_SANS },
  externalStyle: { fontFamily: FONT_SANS },
};

/**
 * bpmn-js (Modeler, Viewer, NavigatedViewer): `config.bpmnRenderer` +
 * `config.textRenderer`. bpmn-color.ts' picker reads the same two defaults
 * for its "Default" swatch.
 *
 * Deliberately NO defaultLabelColor: bpmn-js resolves a label as
 * `label colour (DI) || defaultLabelColor || stroke`, so a configured default
 * would beat the stroke colour a user gave the element (#189) — a red task
 * would get a black label. Left unset, the label follows the stroke, which
 * for an uncoloured element IS canvas-label (tokens.ts keeps
 * canvas-label === canvas-stroke; test/canvas-theme.test.ts pins it).
 */
export const BPMN_CANVAS_OPTIONS = {
  bpmnRenderer: {
    defaultFillColor: ALIASES["canvas-shape"],
    defaultStrokeColor: ALIASES["canvas-stroke"],
  },
  textRenderer,
};

/**
 * the dmn-js DRD view: `config.drdRenderer` + `config.textRenderer` (its own
 * TextRenderer, same shape as bpmn-js'). DMN has no element colours, so the
 * label default is safe to set here. The decision table and literal
 * expression views are HTML — CSS themes them.
 */
export const DRD_CANVAS_OPTIONS = {
  drdRenderer: {
    defaultFillColor: ALIASES["canvas-shape"],
    defaultStrokeColor: ALIASES["canvas-stroke"],
    defaultLabelColor: ALIASES["canvas-label"],
  },
  textRenderer,
};

/**
 * Fold the DRD theme into dmn-js' per-view options. dmn-js hands each view
 * ONLY its own key (`drd`, `decisionTable` …, spread over `common`), so the
 * renderer config must sit inside `drd`, next to the additionalModules the
 * simulation add-on is mounted through (lib/dmn-simulation.ts) — those pass
 * through untouched, as does every other view. An explicit `drd` option of
 * the caller wins over the theme.
 */
export function withDrdCanvasTheme<V extends { drd?: object }>(views: V): V & { drd: typeof DRD_CANVAS_OPTIONS } {
  return { ...views, drd: { ...DRD_CANVAS_OPTIONS, ...views.drd } };
}

/** the first family of the stack — the one webfont that has to arrive */
const CANVAS_FONT = FONT_SANS.split(",")[0]!.trim();

/**
 * Resolve once the canvas font is usable, so the first import lays labels
 * out in Geist. diagram-js measures every label (line breaks, external label
 * bounds) when it renders, and a fallback font measured then stays baked into
 * the wrapping after Geist swaps in. Capped: a font that does not arrive
 * (offline, blocked) must never hold the diagram back — the fallback renders.
 */
export async function canvasFontReady(timeoutMs = 2000): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      document.fonts.load(`12px ${CANVAS_FONT}`),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs))),
    ]);
  } catch {
    // an unparsable or failed load is the fallback case above, not an error
  } finally {
    clearTimeout(timer);
  }
}
