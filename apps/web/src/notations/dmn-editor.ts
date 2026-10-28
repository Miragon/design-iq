/**
 * The DMN editor ENGINE — loaded on demand by the manifest (dmn.tsx). One
 * dmn-js modeler (DRD + decision table + literal expression) with the SAME
 * simulation add-on the MCP-App decision widget mounts: enter values in a
 * decision table and the matching rows light up. It evaluates with `feelin`,
 * as does @designiq/decisions in the Checks panel and on the server — one
 * semantics, three places. The DRD wears the CI (lib/canvas-theme.ts) and
 * waits for its font before the first import. Its zoom keys, ⇧1 and wheel
 * zoom follow guide §5.8 (bpmn-io-keys.ts).
 */
import { bindDmn } from "@designiq/live-client/dmn-sync";
import type Canvas from "diagram-js/lib/core/Canvas";
import DmnModeler from "dmn-js/lib/Modeler";

import { canvasFontReady, withDrdCanvasTheme } from "@/lib/canvas-theme";
import { dmnSimulationViews } from "@/lib/dmn-simulation";

import { bindBpmnIoZoom } from "./bpmn-io-keys";
import type { EditorContext, MountedEditor } from "./registry";

export async function mountDmnEditor(container: HTMLElement, ctx: EditorContext): Promise<MountedEditor> {
  // bindDmn imports right away — DRD labels must be measured in Geist
  await canvasFontReady();
  const modeler = new DmnModeler({ container, ...withDrdCanvasTheme(dmnSimulationViews) });
  // dmn-js keeps one DRD viewer per modeler: its zoom is bound once, the
  // first time it shows
  const drdZoom = new Map<unknown, () => void>();
  const onViews = (): void => {
    if (modeler.getActiveView()?.type !== "drd") return;
    const viewer = modeler.getActiveViewer();
    if (!viewer || drdZoom.has(viewer)) return;
    drdZoom.set(
      viewer,
      bindBpmnIoZoom(viewer as never, container, ctx, () => modeler.getActiveViewer() === viewer),
    );
  };
  modeler.on("views.changed", onViews);
  const unbind = bindDmn(
    modeler as never,
    ctx.ytext,
    ctx.doc,
    ctx.onSyncError,
    // malformed from the start: nothing to render — surface the error and
    // fall back to the text view, where the document stays editable
    ctx.onImportFailed,
    { ...ctx.sync, canvasHost: container },
  );
  return {
    // the DRD has a canvas; a decision table or literal expression has none
    focus: () => {
      if (modeler.getActiveView()?.type !== "drd") return;
      (modeler.getActiveViewer()?.get("canvas", false) as Canvas | null | undefined)?.focus();
    },
    destroy: () => {
      unbind();
      modeler.off("views.changed", onViews);
      for (const unbindZoom of drdZoom.values()) unbindZoom();
      drdZoom.clear();
      modeler.destroy();
    },
  };
}
