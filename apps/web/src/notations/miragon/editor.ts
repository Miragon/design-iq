/**
 * The editor ENGINE of every Miragon renderer — loaded on demand by the
 * manifest (plugin.ts) together with the spec's `load()`: the renderer's
 * contract factory mounted into the SPA's canvas host and bound to the shared
 * Y.Text through live-client's miragon-sync, with live presence attached.
 * The SPA's chrome sits outside the canvas (only a side panel opens over
 * its edge, on demand), so the factory gets no insets: the renderer's
 * defaults apply.
 * The zoom keys and ⇧1 are the MCP-App widget's (lib/chrome-keys.ts): the
 * renderers bind none, and without them Cmd/Ctrl + `+` zooms the page.
 */
import { bindMiragon } from "@designiq/live-client/miragon-sync";
import { fitInsets, SHELL } from "@miragon/modeler-shell/core";

import { handleChromeKey } from "@/lib/chrome-keys";
import { attachPresenceCanvas } from "@/lib/presence-canvas";
import { diagramView } from "@/mcp-app/engines/diagram-js";
import { ZOOM_STEP } from "@/mcp-app/engines/fit";

import type { EditorContext, MountedEditor } from "../registry";
import type { LoadedMiragonRenderer, MiragonRendererSpec } from "./spec";

/**
 * Where ⇧1 fits in the SPA's canvas: the renderer's own palette floats over
 * its top edge like the shell's top row (the second row from 760px down), so
 * the fit keeps the shell's insets for an embedded modeler.
 */
export function spaFitInsets(width: number, height: number): ReturnType<typeof fitInsets> {
  return fitInsets({
    container: { width, height },
    host: "embedded",
    paletteRow: width <= SHELL.narrow ? "second-row" : "top",
    problemsVisible: false,
  });
}

export function mountMiragonEditor(
  spec: Pick<MiragonRendererSpec, "contractNotation">,
  renderer: LoadedMiragonRenderer,
  container: HTMLElement,
  ctx: EditorContext,
): MountedEditor {
  const modeler = renderer.create();
  modeler.attachTo(container);
  let unbind: () => void;
  try {
    unbind = bindMiragon(modeler, spec.contractNotation, ctx.ytext, ctx.doc, ctx.onSyncError, ctx.onImportFailed);
  } catch (error) {
    modeler.destroy();
    throw error;
  }
  const presenceCanvas = ctx.presence
    ? attachPresenceCanvas(modeler.diagram, ctx.presence, modeler.elements)
    : undefined;
  const view = diagramView(
    modeler.diagram,
    renderer.contentBounds ? { contentBounds: () => renderer.contentBounds?.(modeler) } : {},
  );
  const doc = container.ownerDocument;
  const reducedMotion = (): boolean =>
    doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  // the live editor holds every key from document listeners while the canvas
  // is behind the source or a dialog (lib/canvas-keys), so this hears only
  // the keys meant for the canvas in front
  const onKey = (event: KeyboardEvent): void => {
    handleChromeKey(event, doc, {
      menuOpen: () => false,
      viewport: () => container.clientWidth > 0 && container.clientHeight > 0,
      run: (key) => {
        if (key === "fit") view.fit(spaFitInsets(container.clientWidth, container.clientHeight), !reducedMotion());
        else if (key === "zoomToActual") view.zoomTo(1);
        else view.zoomBy(key === "zoomIn" ? ZOOM_STEP : -ZOOM_STEP);
      },
    });
  };
  doc.addEventListener("keydown", onKey);
  return {
    destroy: () => {
      doc.removeEventListener("keydown", onKey);
      view.destroy();
      presenceCanvas?.destroy();
      unbind();
      modeler.destroy();
    },
  };
}
