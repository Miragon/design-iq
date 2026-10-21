/**
 * The zoom group, bottom-right (spec §2.5): [− | 56% | + | fit], 28px
 * targets, bound to whichever engine view is mounted (re-bound after the
 * superseded remount — a viewer keeps zoom and fit). Shown only while the
 * view has a viewport (not the DMN table). Compact mode hides the readout
 * (layout-dom.ts applies Layout.showZoomPct); the fit button runs the
 * layout's forced re-fit, which resets "touched". The readout and its limits
 * are the modeler shell's (`zoomReadout`), so it reads and speaks like the
 * Miragon modelers' own zoom panel. Keyboard zoom (Ctrl/⌘ + / − / 0) and ⇧1
 * are chrome/keys.ts: the widget's own keymap in the Miragon widgets, the
 * diagram-js keyboard on the focused canvas in bpmn and the DMN DRD view.
 * Touch undo/redo is phase 2.
 */
import { defaultMessages, formatPercent, zoomReadout } from "@miragon/modeler-shell/core";

import { ZOOM_STEP } from "../engines/fit.ts";
import type { MountZoom } from "./contracts.ts";

/** the widget's one UI language (spec: UI copy is English), also for numbers */
const LANG = "en";

export const mountZoom: MountZoom = ({ els, fit }) => {
  let view: Parameters<ReturnType<MountZoom>["bind"]>[0];
  let off: (() => void) | undefined;
  let frame = 0;
  let shown = "";

  const render = (): void => {
    frame = 0;
    const on = view?.hasViewport() ?? false;
    els.zoom.hidden = !on;
    if (!on || !view) return;
    const r = zoomReadout(view.level(), LANG, defaultMessages);
    if (r.text !== shown) {
      shown = r.text;
      els.zoomPct.textContent = r.text;
      els.zoomPct.setAttribute("aria-label", r.ariaLabel);
    }
    // aria-disabled, not disabled: a button pressed up to the limit keeps the
    // keyboard focus (a disabled one drops it on <body>); zoomBy clamps anyway
    els.zoomOut.setAttribute("aria-disabled", String(!r.canZoomOut));
    els.zoomIn.setAttribute("aria-disabled", String(!r.canZoomIn));
  };
  // a pan or a wheel zoom fires a change per event — read once per frame
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(render);
  };

  /** a click (detail > 0) gives the focus back to the canvas, so its keys
   *  work on at once; Enter or Space (detail 0) keeps it on the button */
  const thenCanvas =
    (act: () => void) =>
    (e: MouseEvent): void => {
      act();
      if (e.detail > 0) view?.focus?.();
    };
  els.zoomPct.title = defaultMessages.zoomToActual(formatPercent(1, LANG));
  els.zoomOut.onclick = thenCanvas(() => view?.zoomBy(-ZOOM_STEP));
  els.zoomIn.onclick = thenCanvas(() => view?.zoomBy(ZOOM_STEP));
  els.zoomPct.onclick = thenCanvas(() => view?.zoomTo(1));
  els.zoomFit.onclick = thenCanvas(fit);

  return {
    bind(next) {
      off?.();
      view = next;
      off = next?.onChange(schedule);
      cancelAnimationFrame(frame);
      render();
    },
  };
};
