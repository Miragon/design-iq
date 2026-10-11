/**
 * The zoom group, bottom-right (spec §2.5): [− | 56% | + | fit], 28px
 * targets, bound to whichever engine view is mounted (re-bound after the
 * superseded remount — a viewer keeps zoom and fit). Shown only while the
 * view has a viewport (not the DMN table). Compact mode hides the readout
 * (layout-dom.ts applies Layout.showZoomPct); the fit button runs the
 * layout's forced re-fit, which resets "touched". Keyboard zoom (Ctrl/⌘ + /
 * − / 0) is diagram-js's own while the canvas has focus; touch undo/redo is
 * phase 2.
 */
import { MAX_ZOOM, MIN_ZOOM } from "../engines/diagram-js.ts";
import { zoomReadout } from "../engines/fit.ts";
import type { MountZoom } from "./contracts.ts";

/** the −/+ step: multiplicative (engines/fit.ts steppedLevel) */
const STEP = 0.2;

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
    const r = zoomReadout(view.level(), MIN_ZOOM, MAX_ZOOM);
    if (r.text !== shown) {
      shown = r.text;
      els.zoomPct.textContent = r.text;
      els.zoomPct.setAttribute("aria-label", r.label);
    }
    // aria-disabled, not disabled: a button pressed up to the limit keeps the
    // keyboard focus (a disabled one drops it on <body>); zoomBy clamps anyway
    els.zoomOut.setAttribute("aria-disabled", String(!r.canOut));
    els.zoomIn.setAttribute("aria-disabled", String(!r.canIn));
  };
  // a pan or a wheel zoom fires a change per event — read once per frame
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(render);
  };

  els.zoomPct.title = "Reset zoom to 100%";
  els.zoomOut.onclick = () => view?.zoomBy(-STEP);
  els.zoomIn.onclick = () => view?.zoomBy(STEP);
  els.zoomPct.onclick = () => view?.zoomTo(1);
  els.zoomFit.onclick = () => fit();

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
