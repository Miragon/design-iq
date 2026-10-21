/**
 * The diagram-js surface every engine adapter touches — STRUCTURALLY. The
 * widgets bundle different diagram-js copies (each Miragon renderer pins its
 * own, bpmn-js another), so nothing here may `instanceof` or import a
 * diagram-js module: only `get(service)` and the documented service APIs.
 *
 * diagramView() is the engines' ViewControls (core/engine.ts): fit into the
 * frame minus the chrome's insets, zoom around the centre, auto-fit until
 * touched, the palette for Tools and the layout. The view math is the
 * modeler shell's (@miragon/modeler-shell/core), so the widget fits, eases
 * and clamps exactly like the Miragon modelers' own chrome.
 */
import {
  easeStandard,
  FIT_ANIMATION_MS,
  fitViewbox,
  interpolateViewbox,
  sameView,
  type ScaledViewbox,
  TEXT_FIELD_SELECTOR,
  ZOOM_MAX,
  ZOOM_MIN,
} from "@miragon/modeler-shell/core";

import type { Insets, PaletteControls, ViewControls } from "../core/engine.ts";
import { type Box, steppedLevel, zoomAround } from "./fit.ts";
export interface DiagramLike {
  /** didi's strict lookup — the Miragon viewers forward only the name, so a
   *  missing service THROWS (never pass a strict flag; guard by mount instead) */
  get(service: string): unknown;
  on(event: string, cb: () => void): void;
  off(event: string, cb: () => void): void;
  destroy(): void;
}

/** the single selected element's id (a label resolves to its target), or
 *  undefined — also when this build registers no selection service. The
 *  bpmn engine's; a contract modeler reports its selection itself */
export function selectedElementOf(instance: Pick<DiagramLike, "get">): string | undefined {
  try {
    const selection = instance.get("selection") as { get(): Array<{ id: string; labelTarget?: { id: string } }> };
    const selected = selection.get();
    if (selected.length !== 1) return undefined;
    return selected[0]?.labelTarget?.id ?? selected[0]?.id;
  } catch {
    return undefined;
  }
}

/** zoom the canvas to the whole diagram — what a fresh import shows */
export function fitViewport(instance: Pick<DiagramLike, "get">): void {
  (instance.get("canvas") as { zoom(mode: string): void }).zoom("fit-viewport");
}

// ── view controls ───────────────────────────────────────────────────────────

type Viewbox = Box & { scale: number; inner: Box; outer: { width: number; height: number } };

interface CanvasLike {
  /** the getter: x/y/width/height in diagram units, `inner` = the content
   *  bbox, `outer` = the container's px size. CACHED until the next viewbox
   *  write or `resized()` — `false` recomputes (a frame resize alone leaves
   *  the cached `outer` stale) */
  viewbox(fresh?: false): Viewbox;
  viewbox(box: Box): void;
  /** invalidates the cache and fires `canvas.resized` (the palette re-lays
   *  its columns, keep-selection-visible scrolls) — nobody else calls it here */
  resized?(): void;
  getContainer?(): HTMLElement;
  focus?(): void;
}

interface PaletteLike {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** set once diagram.init built it (diagram-js Palette internals) */
  _container?: HTMLElement;
}

export interface DiagramView extends ViewControls {
  /** after an import: fit (instantly) unless the user moved the view — or
   *  plain fit-viewport when the engine was mounted without insets (tests).
   *  `import.done` runs it by itself (live re-imports included); an engine
   *  whose renderer fires no import events calls it after its import. */
  importFit(): void;
  /** stop listening (the engine's destroy) */
  destroy(): void;
}

/**
 * The ViewControls of a diagram-js instance. Touched detection compares the
 * viewbox after every `canvas.viewbox.changed` (synchronous in diagram-js 15)
 * with the last fit's origin and scale — a frame resize alone changes the
 * viewbox size, never those, so it never reads as a touch. The animated fit
 * interpolates the viewbox per rAF frame and is never mistaken for a touch;
 * neither is what a renderer writes while it imports (the event-storming
 * renderer zooms to its board) — from `import.parse.start` /
 * `import.render.start` until the fit one task after `import.done`: the live
 * binding restores its view (or zooms to fit-viewport on its first import)
 * in the import's own continuation, and the chrome's fit must come last.
 */
export function diagramView(
  instance: Pick<DiagramLike, "get" | "on" | "off">,
  opts: { insets?: () => Insets; hasViewport?: () => boolean; contentBounds?: () => Box | undefined } = {},
): DiagramView {
  const canvas = (): CanvasLike => instance.get("canvas") as CanvasLike;
  let lastFit: { x: number; y: number; scale: number } | undefined;
  let touched = false;
  let fitting = 0; // > 0 while a fit writes the viewbox
  let frame = 0; // the running re-fit animation
  let importing = false; // a renderer is replacing the content — its viewbox writes are not the user's
  let pendingFit: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const cb of listeners) cb();
  };

  const write = ({ x, y, width, height }: Box): void => {
    fitting++;
    try {
      canvas().viewbox({ x, y, width, height });
    } finally {
      fitting--;
    }
  };
  const onViewbox = (): void => {
    if (fitting === 0 && importing) return;
    // a move from outside (the user, mid-animation) wins over the running re-fit
    if (fitting === 0) stopAnimation();
    if (fitting === 0 && lastFit && !touched) touched = !sameView(canvas().viewbox(), lastFit);
    notify();
  };
  const onImportStart = (): void => {
    importing = true;
  };
  // without insets (the node suites) the engine fits by itself after its import
  const onImportDone = (): void => {
    if (!opts.insets) {
      importing = false;
      return;
    }
    clearTimeout(pendingFit);
    pendingFit = setTimeout(() => {
      pendingFit = undefined;
      importFit();
    }, 0);
  };
  instance.on("canvas.viewbox.changed", onViewbox);
  instance.on("palette.changed", notify);
  instance.on("import.parse.start", onImportStart);
  instance.on("import.render.start", onImportStart);
  instance.on("import.done", onImportDone);

  // the widget frame resizes (inline ↔ fullscreen, a host resize, a panel
  // never — panels float) and diagram-js does not watch its container: tell
  // it, one frame later (inside the observer the palette's own re-layout
  // would re-trigger the layout's observers in the same pass). What it
  // scrolls in response (keep-selection-visible) is not the user's move.
  // Only for a chrome that fits the view itself (insets): the SPA's view
  // keys read the viewbox fresh and leave its editors' resizing as it was
  let resizeFrame = 0;
  const container = canvas().getContainer?.();
  const resizes =
    opts.insets && container && typeof ResizeObserver === "function" && typeof requestAnimationFrame === "function"
      ? new ResizeObserver(() => {
          cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(() => {
            fitting++;
            try {
              canvas().resized?.();
            } finally {
              fitting--;
            }
          });
        })
      : undefined;
  if (container) resizes?.observe(container);

  // bpmn-js and dmn-js commit an open label editor on a viewbox change, so a
  // fit the host makes on its own (after a peer's re-import, on a frame
  // resize) would save what the user has typed so far; the Miragon renderers
  // keep theirs open (contract L5), and the field stays where it is typed
  const typingOnCanvas = (): boolean => {
    const focused = container?.ownerDocument.activeElement;
    return !!focused && !!container?.contains(focused) && focused.matches(TEXT_FIELD_SELECTOR);
  };

  function stopAnimation(): void {
    if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    frame = 0;
  }

  function fit(insets: Insets, animate: boolean): void {
    if (typingOnCanvas()) return;
    const vb = canvas().viewbox(false);
    // undefined for a hidden or unlaid-out container (no size to fit into)
    // and an empty canvas (mounted, not yet imported: nothing to fit)
    const target = fitViewbox(opts.contentBounds?.() ?? vb.inner, vb.outer, insets);
    if (!target) return;
    stopAnimation();
    lastFit = { x: target.x, y: target.y, scale: target.scale };
    touched = false;
    if (!animate || typeof requestAnimationFrame !== "function") {
      write(target);
      notify();
      return;
    }
    const from: ScaledViewbox = { x: vb.x, y: vb.y, width: vb.width, height: vb.height, scale: vb.scale };
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / FIT_ANIMATION_MS);
      write(t < 1 ? interpolateViewbox(from, target, easeStandard(t)) : target);
      if (t < 1) frame = requestAnimationFrame(step);
      else {
        frame = 0;
        notify();
      }
    };
    frame = requestAnimationFrame(step);
  }

  function importFit(): void {
    importing = false;
    if (typingOnCanvas()) return;
    if (!opts.insets) {
      fitViewport(instance);
      return;
    }
    if (!touched) fit(opts.insets(), false);
    else notify(); // the content changed under a touched view — the readout re-reads
  }

  function zoomTo(level: number): void {
    const vb = canvas().viewbox(false);
    if (!vb.outer.width || !vb.outer.height) return;
    stopAnimation();
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
    // a user zoom — the changed handler marks the view touched
    canvas().viewbox(zoomAround(vb, vb.outer, next, { x: vb.outer.width / 2, y: vb.outer.height / 2 }));
  }

  const palette = (): PaletteLike | undefined => {
    try {
      // strict lookup: a viewer registers no palette and throws (see DiagramLike)
      return instance.get("palette") as PaletteLike;
    } catch {
      return undefined;
    }
  };
  const paletteControls: PaletteControls | undefined = palette()
    ? {
        open: () => palette()?.open(),
        close: () => palette()?.close(),
        isOpen: () => palette()?.isOpen() ?? false,
        size: () => {
          const box = palette()?._container?.getBoundingClientRect();
          return box ? { w: Math.round(box.width), h: Math.round(box.height) } : { w: 0, h: 0 };
        },
      }
    : undefined;

  return {
    hasViewport: () => opts.hasViewport?.() ?? true,
    fit,
    zoomBy: (step) => zoomTo(steppedLevel(canvas().viewbox().scale, step, ZOOM_MIN, ZOOM_MAX)),
    zoomTo,
    level: () => canvas().viewbox().scale,
    isTouched: () => touched,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    ...(paletteControls ? { palette: paletteControls } : {}),
    focus: () => canvas().focus?.(),
    importFit,
    destroy() {
      stopAnimation();
      clearTimeout(pendingFit);
      resizes?.disconnect();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      listeners.clear();
      instance.off("canvas.viewbox.changed", onViewbox);
      instance.off("palette.changed", notify);
      instance.off("import.parse.start", onImportStart);
      instance.off("import.render.start", onImportStart);
      instance.off("import.done", onImportDone);
    },
  };
}
