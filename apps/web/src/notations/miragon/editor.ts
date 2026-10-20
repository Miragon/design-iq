/**
 * The editor ENGINE of every Miragon renderer — loaded on demand by the
 * manifest (plugin.ts) together with the spec's `load()`: the renderer's
 * contract factory mounted into the SPA's canvas host and bound to the shared
 * Y.Text through live-client's miragon-sync, with live presence attached.
 * Nothing of the SPA covers the canvas, so the factory gets no insets.
 */
import { bindMiragon } from "@designiq/live-client/miragon-sync";

import { attachPresenceCanvas } from "@/lib/presence-canvas";

import type { EditorContext, MountedEditor } from "../registry";
import type { LoadedMiragonRenderer, MiragonRendererSpec } from "./spec";

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
  return {
    destroy: () => {
      presenceCanvas?.destroy();
      unbind();
      modeler.destroy();
    },
  };
}
