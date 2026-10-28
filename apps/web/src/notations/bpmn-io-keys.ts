/**
 * The zoom keys, ⇧1 and the wheel of the SPA's bpmn-js and DMN DRD canvases
 * (guide §5.8), as the widget's bpmn and dmn engines take them: Cmd/Ctrl +
 * `+` / `-` / `0` and ⇧1 on the whole page while the canvas is on screen,
 * through the keymap of the SPA's Miragon editors (lib/chrome-keys.ts) and
 * the widget's view of a diagram-js canvas (engines/diagram-js.ts
 * `diagramView`). A text field (the Monaco source, a side panel's field)
 * and an open modal dialog keep the keys, and the browser zooms the page
 * there; so does the source view, where the canvas is not on screen.
 * bpmn-js's and dmn-js's own zoom keys and wheel clamp a step out to 20 %,
 * which zooms in from a fit below it: the keys never reach them, and the
 * wheel stays put there.
 */
import { SHELL } from "@miragon/modeler-shell/core";

import { type ChromeKeyDeps, handleChromeKey, routeCanvasChromeKeys } from "@/lib/chrome-keys";
import type { Insets } from "@/mcp-app/core/engine";
import { type DiagramLike, diagramView, keepWheelZoomDirection } from "@/mcp-app/engines/diagram-js";

import type { EditorContext } from "./registry";

/** what floats over a bpmn-js or DRD canvas, measured in px from its edges */
export interface BpmnIoCanvasRoom {
  /** the palette column's right edge from the canvas's left; 0 without one */
  paletteRight: number;
  /** the lowest bottom edge of the cards along the top (BPMN's breadcrumbs
   *  inside a sub-process, the DRD's name card) from the canvas's top; 0
   *  without one */
  cardsBottom: number;
  /** what covers the right edge: an open side panel, the DRD's simulation
   *  card; 0 without either */
  coveredRight: number;
}

/**
 * Where ⇧1 puts the diagram (guide §5.9): 24px clear of the palette on the
 * left, of the cards at the top, of what covers the right edge, and of the
 * bottom. Measured, as for the SPA's Miragon editors (`spaFitInsets`):
 * bpmn-js and dmn-js keep their palette in a column on the left.
 */
export function bpmnIoFitInsets(room: BpmnIoCanvasRoom): Insets {
  const gap = SHELL.fitInsetSide;
  return {
    top: room.cardsBottom + gap,
    right: room.coveredRight + gap,
    bottom: gap,
    left: room.paletteRight + gap,
  };
}

/** a box over the canvas, undefined while it is not laid out (hidden, or a view not shown) */
function shownBox(container: HTMLElement, selector: string): DOMRect | undefined {
  const box = container.querySelector(selector)?.getBoundingClientRect();
  return box && box.width > 0 && box.height > 0 ? box : undefined;
}

function canvasRoomIn(container: HTMLElement, coveredRight: number): BpmnIoCanvasRoom {
  const frame = container.getBoundingClientRect();
  const palette = shownBox(container, ".djs-palette");
  const cards = [".bjs-breadcrumbs", ".dmn-definitions"].flatMap((selector) => shownBox(container, selector) ?? []);
  const simulation = shownBox(container, ".dmn-sim-decision-requirements-diagram-panel");
  return {
    paletteRight: palette ? Math.max(0, Math.round(palette.right - frame.left)) : 0,
    cardsBottom: Math.max(0, ...cards.map((box) => Math.round(box.bottom - frame.top))),
    coveredRight: Math.max(coveredRight, simulation ? Math.round(frame.right - simulation.left) : 0),
  };
}

/**
 * Binds the chrome keys of `diagram` (a bpmn-js modeler, a DRD viewer)
 * mounted in `container` to a view of its canvas, on the canvas ahead of
 * diagram-js's own zoom and on the rest of the document, and keeps its wheel
 * zoom from turning around; `shown` says whether that canvas is the one
 * dmn-js shows. Returns the unbind.
 */
export function bindBpmnIoZoom(
  diagram: Pick<DiagramLike, "get" | "on" | "off">,
  container: HTMLElement,
  ctx: Pick<EditorContext, "sidePanels" | "visibility">,
  shown: () => boolean = () => true,
): () => void {
  const doc = container.ownerDocument;
  const view = diagramView(diagram);
  const reducedMotion = (): boolean =>
    doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const keys: ChromeKeyDeps = {
    menuOpen: () => false,
    // the source view keeps the canvas mounted, hidden behind it
    viewport: () =>
      (ctx.visibility?.visible() ?? true) && shown() && container.clientWidth > 0 && container.clientHeight > 0,
    run: (key) => {
      if (key === "fit")
        view.fit(bpmnIoFitInsets(canvasRoomIn(container, ctx.sidePanels?.covered() ?? 0)), !reducedMotion());
      else if (key === "zoomToActual") view.zoomTo(1);
      else view.stepZoom(key === "zoomIn" ? 1 : -1);
    },
  };
  const unroute = routeCanvasChromeKeys(diagram, doc, keys);
  // a key the canvas ran is prevented, so this skips it
  const onKey = (event: KeyboardEvent): void => void handleChromeKey(event, doc, keys);
  doc.addEventListener("keydown", onKey);
  const unguardWheel = keepWheelZoomDirection(diagram);
  return () => {
    unroute();
    doc.removeEventListener("keydown", onKey);
    unguardWheel();
    view.destroy();
  };
}
