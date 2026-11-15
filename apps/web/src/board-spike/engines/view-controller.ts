/**
 * The node's own view of its diagram, shared by every in-page strategy (DESIGN.md, section 2).
 *
 * The node owns a LOGICAL view { x, y, k }: `x, y` is the diagram point at the top-left of the node
 * body, `k` the container px per diagram unit at board zoom 1. The canvas is brought in line with
 * it by the sequence pointer-math-core.md (section 6) verified: the host's CSS size first (the
 * strategy did that), then `canvas.viewbox({ x, y, width: size.width / (k * z), ... })` with the
 * LIVE `canvas.getSize()`, so both ratios equal `k * z` exactly, then `canvas.resized()`.
 *
 * - The first view is the spike's own fit of the content into the node body. Not diagram-js's
 *   fit-viewport: that depends on the host's CSS size at call time, which in the counter and the
 *   overlay strategy depends on the board zoom.
 * - Never read back through `canvas.viewbox()`: it rounds scale and origin to three decimals, and a
 *   read and re-apply loop drifts. What the USER changed (pan, wheel zoom, auto-scroll) is read from
 *   the `g.viewport` matrix, on viewbox events this controller did not cause and no import caused.
 * - A viewbox write commits an open label editor and closes an open popup menu in bpmn-js and
 *   dmn-js. So nothing is written while a gesture runs, a pointer is down on the editor or a text
 *   field of the editor has the focus: the write is held and made up for afterwards.
 * - After every import the view is applied again: the binding restores a viewbox it read through
 *   the rounding getter, and fits with fit-viewport after the first one.
 * - The board zoom never takes the canvas's scale out of the engine's own zoom range (`scaleFor`):
 *   where k x zoom leaves it, the picture is larger or smaller than the node's preview. The logical
 *   view stays, so the picture is in scale again as soon as k x zoom is back inside.
 */
import { TEXT_FIELD_SELECTOR } from "@miragon/modeler-shell/core";

import type { EngineHandle } from "./types.ts";

export interface LogicalView {
  x: number;
  y: number;
  /** container px per diagram unit at board zoom 1 */
  k: number;
}

export interface ViewControllerOptions {
  engine: EngineHandle;
  /** the node body in flow units: what the first view fits the content into */
  nodeSize(): { width: number; height: number };
  /** container px per flow unit: 1 while the board's CSS scale carries the zoom, else the board zoom */
  zoom(): number;
  /** the editor takes input (the node is armed): its own wheel may zoom the view */
  editing(): boolean;
  /** a pointer is down on the editor */
  pressed(): boolean;
  /** elements outside the host that belong to the editor (its body-level popup host) */
  scopes(): readonly Element[];
  /** after each time the canvas was brought in line following an import: the first call is the first view */
  onSettled?(): void;
}

export interface ViewStats {
  /** viewbox writes made */
  writes: number;
  /** syncs that found the canvas in line already and wrote nothing */
  inLine: number;
  /** syncs held back by a gesture, a pressed pointer, a focused text field or an import */
  held: number;
  /** viewbox changes taken over from the user */
  userChanges: number;
  /** writes the engine answered with another view than asked for (a pan constraint) */
  constrained: number;
}

export interface ViewController {
  /** the host's CSS size or the zoom changed, or may have: bring the canvas in line, now or once nothing holds it */
  sync(): void;
  view(): LogicalView | null;
  /** a write is owed (held back) */
  pending(): boolean;
  stats(): ViewStats;
  destroy(): void;
}

/** flow units between the content and the node body's edge in the first view */
const FIT_MARGIN = 24;
/** the first view never magnifies, like diagram-js's own fit */
const FIT_MAX = 1;
/** how often a held write is tried again */
const RETRY_MS = 80;
/** diagram-js keeps a canvas's wheel zoom inside this range (lib/navigation/zoomscroll/ZoomScroll.js, RANGE) */
const ENGINE_ZOOM = { min: 0.2, max: 4 };

/**
 * The scale the canvas gets for the view's `k` at board zoom `zoom`. A preview takes no wheel: its
 * scale is k x zoom as it is. An editor that takes input gets k x zoom kept inside the engine's
 * own zoom range: outside it the engine's next wheel step jumped back into the range (measured in
 * counter and overlay: with the editor at its lower end and the board zoomed out to half, the
 * canvas stood at 0.1 and one step in was a factor 2).
 *
 * The node's own fit may lie below the range (a large diagram in a small node): `fitted` x zoom
 * widens the lower end to hold it, so a view nobody zoomed is never touched.
 */
const scaleFor = (k: number, zoom: number, fitted: number, editing: boolean): number =>
  editing ? Math.min(ENGINE_ZOOM.max, Math.max(k * zoom, Math.min(ENGINE_ZOOM.min, fitted * zoom))) : k * zoom;

/** equal up to float noise: the setter derives the scale by two divisions, the matrix keeps doubles */
const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

export function createViewController(options: ViewControllerOptions): ViewController {
  const { engine } = options;
  let view: LogicalView | null = null;
  /** `k` of the first fit: the scale this node shows its whole content at (scaleFor) */
  let fitted = 0;
  /** the zoom the canvas's matrix was last written for: a user change is read against it */
  let appliedZoom = 1;
  let appliedSize = { width: 0, height: 0 };
  let writing = 0;
  // the binding starts the first import when it binds: until that one is through, the view is not ours
  let importing = true;
  let pending = false;
  let destroyed = false;
  let retry: ReturnType<typeof setInterval> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const stats: ViewStats = { writes: 0, inLine: 0, held: 0, userChanges: 0, constrained: 0 };

  /** the transform of `svg > g.viewport` (Canvas.js: `_viewport`), unrounded: a = scale, e/f = translation */
  const matrix = (): { a: number; e: number; f: number } | undefined => {
    const group = engine.canvas()?.getContainer().querySelector<SVGGElement>(":scope > svg > g.viewport");
    const ctm = group?.getCTM();
    return ctm && ctm.a > 0 ? ctm : undefined;
  };

  const fit = (): LogicalView | null => {
    const bounds = engine.contentBounds();
    const { width, height } = options.nodeSize();
    if (!bounds || !(width > 0) || !(height > 0)) return null;
    const k = Math.min(
      FIT_MAX,
      Math.max(1, width - 2 * FIT_MARGIN) / bounds.width,
      Math.max(1, height - 2 * FIT_MARGIN) / bounds.height,
    );
    // centred: the content's middle is the body's middle
    return {
      k,
      x: bounds.x + bounds.width / 2 - width / (2 * k),
      y: bounds.y + bounds.height / 2 - height / (2 * k),
    };
  };

  const typing = (): boolean => {
    const focused = document.activeElement;
    if (!focused?.matches(TEXT_FIELD_SELECTOR)) return false;
    return engine.host.contains(focused) || options.scopes().some((scope) => scope.contains(focused));
  };
  const held = (): boolean => importing || options.pressed() || engine.gestureActive() || typing();

  const stopRetry = (): void => {
    clearInterval(retry);
    retry = undefined;
  };

  function sync(): void {
    if (destroyed) return;
    const canvas = engine.canvas();
    // a decision table or a literal expression: HTML, no viewbox, nothing to bring in line
    if (!canvas) return;
    const size = canvas.getSize();
    if (!(size.width > 0) || !(size.height > 0)) return;
    if (importing) {
      // the import ends with a sync of its own
      stats.held++;
      return;
    }
    if (!view) {
      view = fit();
      if (!view) return;
      fitted = view.k;
    }
    const zoom = options.zoom();
    const scale = scaleFor(view.k, zoom, fitted, options.editing());
    const now = matrix();
    const viewInLine = !!now && close(now.a, scale) && close(-now.e / now.a, view.x) && close(-now.f / now.a, view.y);
    const sizeInLine = size.width === appliedSize.width && size.height === appliedSize.height;
    if (viewInLine && sizeInLine) {
      appliedZoom = zoom;
      pending = false;
      stopRetry();
      stats.inLine++;
      return;
    }
    if (held()) {
      // not now: the write would commit the label being typed, close the open popup or pull the
      // canvas from under the drag. An interval and not an event: the ways a hold ends are many
      // (drop, cancel, blur, pointerup outside the window)
      pending = true;
      stats.held++;
      retry ??= setInterval(() => (pending ? sync() : stopRetry()), RETRY_MS);
      return;
    }
    pending = false;
    stopRetry();
    if (!viewInLine) {
      writing++;
      try {
        canvas.viewbox({ x: view.x, y: view.y, width: size.width / scale, height: size.height / scale });
      } finally {
        writing--;
      }
      stats.writes++;
    }
    appliedZoom = zoom;
    appliedSize = { width: size.width, height: size.height };
    // after the write: with it first, KeepSelectionVisible would scroll the canvas in between. It
    // drops diagram-js's cached viewbox (stale outer size) and lets the palette re-decide its columns
    canvas.resized();
    // an engine may hold the view to rules of its own (Wardley's pan constraint re-clamps on every
    // viewbox change): then what it made of the write is the view, or every sync would write again
    const after = matrix();
    if (after && !(close(after.a, scale) && close(-after.e / after.a, view.x) && close(-after.f / after.a, view.y))) {
      view = { x: -after.e / after.a, y: -after.f / after.a, k: after.a / zoom };
      stats.constrained++;
    }
  }

  const offViewbox = engine.onViewbox(() => {
    if (destroyed || writing > 0 || importing) return;
    const now = matrix();
    if (!now) return;
    // the user panned, wheel-zoomed, auto-scrolled or drilled down: that is the view now
    view = { x: -now.e / now.a, y: -now.f / now.a, k: now.a / appliedZoom };
    stats.userChanges++;
  });

  /** an import is over: the binding restores (re-import) or fits (first import) right after the
   *  import's promise, in a microtask. One task later the view is ours again */
  const afterImport = (): void => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (destroyed) return;
      importing = false;
      sync();
      options.onSettled?.();
    }, 0);
  };
  const offLifecycle = engine.onLifecycle((phase) => {
    if (phase === "start") {
      importing = true;
      clearTimeout(settle);
    } else if (phase === "done") afterImport();
    // dmn-js shows another view, or the DRD again (re-attached, with the size of now)
    else if (!importing) setTimeout(sync, 0);
  });
  // the first import may be through before this controller listens
  void engine.ready.then(afterImport, () => undefined);

  return {
    sync,
    view: () => (view ? { ...view } : null),
    pending: () => pending,
    stats: () => ({ ...stats }),
    destroy() {
      destroyed = true;
      stopRetry();
      clearTimeout(settle);
      offViewbox();
      offLifecycle();
    },
  };
}
