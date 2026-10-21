/** @miragon/event-storming-renderer — the .storm DSL. Keyboard creation
 *  lands in the free area the mount names. */
import { contractOptions, type LoadedMiragonRenderer, type MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "event-storming",
  pkg: "@miragon/event-storming-renderer",
  canvasClassName: "es-canvas",
  contractNotation: "event-storming",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ createCollaborativeModeler, createCollaborativeViewer }] = await Promise.all([
      import("@miragon/event-storming-renderer"),
      import("@miragon/event-storming-renderer/assets/event-storming.css"),
    ]);
    return {
      create: (mount) => createCollaborativeModeler({ ...contractOptions(mount), undoRedoKeys: true }),
      createViewer: (mount) => createCollaborativeViewer(contractOptions(mount)),
    };
  },
};
