/**
 * The BPMN editor ENGINE — loaded on demand by the manifest (bpmn.tsx). One
 * bpmn-js modeler bound to the shared Y.Text (bindBpmn), with the todo canvas
 * attached for EVERY bpmn file, not only process members: the selection feeds
 * the todo buttons AND the Analyse-with-AI handover (a sub-process has no
 * process id, but its selection matters just the same). Badges re-attach on
 * every import.done (bindBpmn re-imports remote changes); without todos the
 * list stays empty and no badge ever renders. The canvas wears the CI
 * (lib/canvas-theme.ts) and waits for its font before the first import.
 */
import { bindBpmn } from "@designiq/live-client/bpmn-sync";
import BpmnModeler from "bpmn-js/lib/Modeler";

import { BPMN_CANVAS_OPTIONS, canvasFontReady } from "@/lib/canvas-theme";
import { attachPresenceCanvas } from "@/lib/presence-canvas";
import { attachTodoCanvas } from "@/lib/todo-canvas";

import { bpmnColorModule } from "./bpmn-color";
import { bpmnStickyModule, stickyModdle, tbpmToggleAction } from "./bpmn-sticky";
import type { EditorContext, MountedEditor } from "./registry";

export async function mountBpmnEditor(container: HTMLElement, ctx: EditorContext): Promise<MountedEditor> {
  // bindBpmn imports right away — labels must be measured in Geist
  await canvasFontReady();
  const modeler = new BpmnModeler({
    container,
    ...BPMN_CANVAS_OPTIONS,
    // stickies (#117): discussion artifacts as bpmiq:sticky extension elements (legacy-name-ok);
    // element colours (#189): the context-pad brush
    additionalModules: [bpmnStickyModule, bpmnColorModule],
    moddleExtensions: { sticky: stickyModdle },
  });
  const unbind = bindBpmn(modeler as never, ctx.ytext, ctx.doc, ctx.onSyncError);
  const todoCanvas = attachTodoCanvas(modeler as never, {
    onBadgeClick: ctx.onBadgeClick,
    onSelectionChanged: ctx.onSelectionChanged,
  });
  const presenceCanvas = ctx.presence ? attachPresenceCanvas(modeler as never, ctx.presence) : undefined;
  return {
    elements: todoCanvas,
    actions: [tbpmToggleAction(modeler as never)],
    destroy: () => {
      presenceCanvas?.destroy();
      todoCanvas.destroy();
      unbind();
      modeler.destroy();
    },
  };
}
