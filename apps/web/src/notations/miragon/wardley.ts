/** @miragon/wardley-renderer — the OWM DSL. Its factory reports content
 *  changes from the command stack only, and its export is the committed
 *  document: during a plot-resize drag or a size preview it is the map as
 *  it was before, the dropped size is the edit. */
import { contractOptions, type LoadedMiragonRenderer, type MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "wardley",
  pkg: "@miragon/wardley-renderer",
  canvasClassName: "wardley-canvas",
  contractNotation: "wardley",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ createCollaborativeModeler, createCollaborativeViewer }] = await Promise.all([
      import("@miragon/wardley-renderer"),
      import("@miragon/wardley-renderer/assets/wardley.css"),
    ]);
    return {
      create: (mount) => createCollaborativeModeler({ ...contractOptions(mount), undoRedoKeys: true }),
      createViewer: (mount) => createCollaborativeViewer(contractOptions(mount)),
    };
  },
};
