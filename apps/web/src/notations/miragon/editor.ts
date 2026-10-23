/**
 * The editor ENGINE of every Miragon renderer — loaded on demand by the
 * manifest (plugin.ts) together with the spec's `load()`: the renderer's
 * contract factory mounted into the SPA's canvas host and bound to the shared
 * Y.Text through live-client's miragon-sync, with live presence attached.
 * The SPA's chrome sits outside the canvas (only a side panel opens over
 * its edge, on demand), so the factory gets no insets: the renderer's
 * defaults apply.
 * The zoom keys and ⇧1 are the MCP-App widget's (lib/chrome-keys.ts): the
 * renderers bind none, and without them Cmd/Ctrl + `+` zooms the page. A
 * renderer's own menu entries reach the shell's ⋯ menu (MountedEditor.menu).
 */
import { bindMiragon } from "@designiq/live-client/miragon-sync";
import { modelStem } from "@designiq/notations";
import { SHELL } from "@miragon/modeler-shell/core";

import { handleChromeKey } from "@/lib/chrome-keys";
import { attachPresenceCanvas } from "@/lib/presence-canvas";
import type { ExportFile, Insets } from "@/mcp-app/core/engine";
import { ZOOM_STEP } from "@/mcp-app/engines/fit";
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

function paletteBottomIn(container: HTMLElement): number {
  const palette = container.querySelector(".djs-palette");
  if (!palette) return 0;
  const box = palette.getBoundingClientRect();
  if (box.height === 0) return 0;
  return Math.max(0, Math.round(box.bottom - container.getBoundingClientRect().top));
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
  const modeler = renderer.create();
  modeler.attachTo(container);
  // before the binding: its first import may finish right away, and the view
  // that import leaves is the one a later move is measured against
  const view = miragonView(modeler);
  let unbind: () => void;
  try {
    unbind = bindMiragon(modeler, spec.contractNotation, ctx.ytext, ctx.doc, ctx.onSyncError, ctx.onImportFailed, {
      ...ctx.sync,
      canvasHost: container,
    });
  } catch (error) {
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
  // the live editor holds every key from document listeners while the canvas
  // is behind the source or a dialog (lib/canvas-keys), so this hears only
  // the keys meant for the canvas in front
  const fitInsets = (): Insets =>
    spaFitInsets({ paletteBottom: paletteBottomIn(container), coveredRight: ctx.sidePanels?.covered() ?? 0 });
  const onKey = (event: KeyboardEvent): void => {
    handleChromeKey(event, doc, {
      menuOpen: () => false,
      viewport: () => container.clientWidth > 0 && container.clientHeight > 0,
      run: (key) => {
        if (key === "fit") view.fit(fitInsets(), !reducedMotion());
        else if (key === "zoomToActual") view.zoomTo(1);
        else view.zoomBy(key === "zoomIn" ? ZOOM_STEP : -ZOOM_STEP);
      },
    });
  };
  doc.addEventListener("keydown", onKey);
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
  // stylesheet under its class (vendor-css.ts)
  const menu = renderer.menu?.(modeler, {
    root: container,
    readOnly: false,
    get trigger(): HTMLElement {
      return ctx.menuTrigger?.() ?? container;
    },
    fileStem: () => modelStem(ctx.docPath),
    download: (build) => saveFile(doc, build, ctx.onActionFailed),
  });
  return {
    ...(menu ? { menu: menu.groups } : {}),
    destroy: () => {
      menu?.destroy();
      offSidePanels?.();
      doc.removeEventListener("keydown", onKey);
      view.destroy();
      presenceCanvas?.destroy();
      unbind();
      modeler.destroy();
    },
  };
}
