/**
 * The editor ENGINE of every Miragon renderer — loaded on demand by the
 * manifest (plugin.ts) together with the spec's `load()`: the renderer's
 * contract factory mounted into the SPA's canvas host and bound to the shared
 * Y.Text through live-client's miragon-sync, with live presence attached.
 * The SPA's chrome sits outside the canvas, but the renderer's palette
 * floats over its top and a side panel opens over its right edge on demand.
 * The factory gets the editor's fit insets, measured whenever the renderer
 * reads them, as the contract's free area: keyboard creation lands beside
 * the palette and an open panel, Wardley's pan constraint keeps a fit beside
 * them where it is, and Team Topologies keeps its context pad out of the
 * panel. The renderer's own import fit does not leave the palette free, so
 * the editor mounts it without one and fits the first import as ⇧1 does; a
 * peer's re-import keeps the view the user has.
 * The zoom keys and ⇧1 are the MCP-App widget's (lib/chrome-keys.ts): four
 * renderers bind none, and without them Cmd/Ctrl + `+` zooms the page. Value
 * Chain's diagram-js keeps its own on the focused canvas, so every canvas
 * hands them to the chrome first (routeCanvasChromeKeys). They act on the
 * whole page while the canvas is on screen; a text field, a modal dialog and
 * the source view leave them to the browser. The wheel and a pinch zoom
 * out no further below 20 % either (keepWheelZoomDirection, as in the
 * widget and the BPMN and DMN editors). Every other key is the
 * renderer's, which acts only on a key aimed at its own canvas. A
 * renderer's own menu entries reach the shell's ⋯ menu (MountedEditor.menu),
 * its element surface the shell's todos (MountedEditor.elements, through
 * lib/todo-surface-canvas.ts).
 */
import { bindMiragon } from "@designiq/live-client/miragon-sync";
import { modelStem } from "@designiq/notations";
import { SHELL } from "@miragon/modeler-shell/core";

import { type ChromeKeyDeps, handleChromeKey, routeCanvasChromeKeys } from "@/lib/chrome-keys";
import { attachPresenceCanvas } from "@/lib/presence-canvas";
import type { SidePanelRoom } from "@/lib/side-panel-room";
import { attachSurfaceTodoCanvas } from "@/lib/todo-surface-canvas";
import type { ExportFile, Insets } from "@/mcp-app/core/engine";
import { keepWheelZoomDirection } from "@/mcp-app/engines/diagram-js";
import { miragonView } from "@/mcp-app/engines/miragon";

import type { EditorContext, MountedEditor } from "../registry";
import type { LoadedMiragonRenderer, MiragonRendererSpec } from "./spec";

/** what floats over the SPA's canvas, measured in px from its edges */
export interface SpaCanvasRoom {
  /** the renderer palette's bottom edge below the canvas's top; 0 without one */
  paletteBottom: number;
  /** what an open side panel covers of the right edge; 0 while none is open */
  coveredRight: number;
}

/**
 * Where a fit puts the diagram in the SPA's canvas (guide §5.9): 24px clear
 * of the renderer's own palette at the top, of the sides and the bottom,
 * and of an open side panel. Measured, not the shell's rows: no designIQ
 * chrome floats over the SPA's canvas, and its palettes stay in one row.
 */
export function spaFitInsets(room: SpaCanvasRoom): Insets {
  const gap = SHELL.fitInsetSide;
  return {
    top: room.paletteBottom + gap,
    right: room.coveredRight + gap,
    bottom: gap,
    left: gap,
  };
}

export function paletteBottomIn(container: HTMLElement): number {
  const palette = container.querySelector(".djs-palette");
  if (!palette) return 0;
  const box = palette.getBoundingClientRect();
  if (box.height === 0) return 0;
  return Math.max(0, Math.round(box.bottom - container.getBoundingClientRect().top));
}

/** the fit insets of a canvas host as it is laid out now: its palette, an open side panel */
export function spaCanvasInsets(container: HTMLElement, sidePanels?: SidePanelRoom): Insets {
  return spaFitInsets({ paletteBottom: paletteBottomIn(container), coveredRight: sidePanels?.covered() ?? 0 });
}

/**
 * Brings the canvas forward where the source alone shows it hidden and inert
 * behind it, and resolves once its layer is on screen again, after the commit
 * that lifts `inert`: what opens next in it can take the focus. A pending one
 * is dropped by `cancel`, the mount's teardown.
 */
function canvasReveal(ctx: Pick<EditorContext, "visibility" | "revealCanvas">): {
  reveal(): Promise<void>;
  cancel(): void;
} {
  const waiting = new Set<() => void>();
  return {
    reveal() {
      const { visibility, revealCanvas } = ctx;
      if (!visibility || !revealCanvas || visibility.visible()) return Promise.resolve();
      return new Promise((resolve) => {
        let off = (): void => {};
        const stop = (): void => {
          off();
          waiting.delete(stop);
        };
        off = visibility.onChange(() => {
          if (!visibility.visible()) return;
          stop();
          resolve();
        });
        waiting.add(stop);
        revealCanvas();
      });
    },
    cancel() {
      for (const stop of [...waiting]) stop();
    },
  };
}

/** an export as a browser download; a failure is reported, never silent */
async function saveFile(
  doc: Document,
  build: () => Promise<ExportFile>,
  failed: ((message: string) => void) | undefined,
): Promise<void> {
  try {
    const file = await build();
    const url = URL.createObjectURL(
      file.data instanceof Blob ? file.data : new Blob([file.data], { type: file.mimeType }),
    );
    const link = doc.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    // the click starts the download in a later task: revoking now could cancel it
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (error) {
    failed?.(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function mountMiragonEditor(
  spec: Pick<MiragonRendererSpec, "contractNotation">,
  renderer: LoadedMiragonRenderer,
  container: HTMLElement,
  ctx: EditorContext,
): MountedEditor {
  const fitInsets = (): Insets => spaCanvasInsets(container, ctx.sidePanels);
  // the fit insets are the free area too: what a fit leaves clear is what the
  // palette and an open panel cover. The renderer reads them when it needs
  // them and fits nothing on import with them: the editor fits the first one
  const modeler = renderer.create({ insets: fitInsets });
  modeler.attachTo(container);
  // before the binding: its first import may finish right away, and the fit
  // of that import is the view a later move is measured against
  const view = miragonView(modeler, { firstFit: fitInsets });
  // todo badges, selection and reveal on the document's element ids — before
  // the binding too: the one-shot deep-link reveal waits for that first import
  const todos = attachSurfaceTodoCanvas(modeler.diagram, modeler.elements, {
    onBadgeClick: ctx.onBadgeClick,
    onSelectionChanged: ctx.onSelectionChanged,
  });
  let unbind: () => void;
  try {
    unbind = bindMiragon(modeler, spec.contractNotation, ctx.ytext, ctx.doc, ctx.onSyncError, ctx.onImportFailed, {
      ...ctx.sync,
      canvasHost: container,
    });
  } catch (error) {
    todos.destroy();
    view.destroy();
    modeler.destroy();
    throw error;
  }
  const presenceCanvas = ctx.presence
    ? attachPresenceCanvas(modeler.diagram, ctx.presence, modeler.elements)
    : undefined;
  const doc = container.ownerDocument;
  const reducedMotion = (): boolean =>
    doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const keys: ChromeKeyDeps = {
    menuOpen: () => false,
    // the source view keeps the canvas mounted, hidden behind it at its full size
    viewport: () => (ctx.visibility?.visible() ?? true) && container.clientWidth > 0 && container.clientHeight > 0,
    run: (key) => {
      if (key === "fit") view.fit(fitInsets(), !reducedMotion());
      else if (key === "zoomToActual") view.zoomTo(1);
      else view.stepZoom(key === "zoomIn" ? 1 : -1);
    },
  };
  // a key the canvas ran is prevented, so the document's listener skips it
  const unrouteKeys = routeCanvasChromeKeys(modeler.diagram, doc, keys);
  const onKey = (event: KeyboardEvent): void => void handleChromeKey(event, doc, keys);
  doc.addEventListener("keydown", onKey);
  // diagram-js's wheel zoom clamps to 20 %: from a fit below it, a zoom out would zoom in
  const unguardWheel = keepWheelZoomDirection(modeler.diagram);
  // a side panel opening or closing over the canvas: a view nobody moved
  // since the import or the last fit re-fits beside it, as in the widget
  // (docs/mcp-app-widget-chrome.md §2.5), so the panel never covers it
  let covered = ctx.sidePanels?.covered() ?? 0;
  const offSidePanels = ctx.sidePanels?.onChange(() => {
    const next = ctx.sidePanels?.covered() ?? 0;
    if (next === covered) return;
    covered = next;
    if (!view.isTouched() && view.hasViewport()) view.fit(fitInsets(), false);
  });
  // the dialogs sit inside the canvas host: the SPA scopes the renderer's
  // stylesheet under its class (vendor-css.ts). Behind the source view that
  // host is hidden and inert, so a popover that previews on the canvas
  // brings it forward first
  const canvas = canvasReveal(ctx);
  const menu = renderer.menu?.(modeler, {
    root: container,
    readOnly: false,
    get trigger(): HTMLElement {
      return ctx.menuTrigger?.() ?? container;
    },
    fileStem: () => modelStem(ctx.docPath),
    download: (build) => saveFile(doc, build, ctx.onActionFailed),
    revealCanvas: () => canvas.reveal(),
  });
  return {
    elements: todos,
    ...(menu ? { menu: menu.groups } : {}),
    focus: () => view.focus?.(),
    destroy: () => {
      canvas.cancel();
      menu?.destroy();
      offSidePanels?.();
      doc.removeEventListener("keydown", onKey);
      unrouteKeys();
      unguardWheel();
      view.destroy();
      todos.destroy();
      presenceCanvas?.destroy();
      unbind();
      modeler.destroy();
    },
  };
}
