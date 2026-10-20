/** @miragon/wardley-renderer — the OWM DSL. Its factory reports content
 *  changes from the command stack only: the steps of a plot-resize drag,
 *  which the export already carries, are previews, the dropped size is the
 *  edit. It gets no `freeRectInsets` yet: with them its pan constraint pulls
 *  the widget's fit towards its own content bounds, which are not the bounds
 *  the chrome fits (#265 aligns the fit). The viewer takes no options. */
import type { LoadedMiragonRenderer, MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "wardley",
  pkg: "@miragon/wardley-renderer",
  canvasClassName: "wardley-canvas",
  vendorRoot: "wardley-container",
  contractNotation: "wardley",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ createCollaborativeModeler, createCollaborativeViewer }] = await Promise.all([
      import("@miragon/wardley-renderer"),
      import("@miragon/wardley-renderer/assets/wardley.css"),
    ]);
    return {
      create: () => createCollaborativeModeler({ keyboard: { undoRedo: true } }),
      createViewer: () => createCollaborativeViewer(),
    };
  },
};
