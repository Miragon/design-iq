/** @miragon/event-storming-renderer — the .storm DSL. What the host's chrome
 *  covers is `freeRectInsets` (keyboard creation lands in the rest); the
 *  viewer takes no options. */
import type { LoadedMiragonRenderer, MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "event-storming",
  pkg: "@miragon/event-storming-renderer",
  canvasClassName: "es-canvas",
  vendorRoot: "event-storming-container",
  contractNotation: "event-storming",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ createCollaborativeModeler, createCollaborativeViewer }] = await Promise.all([
      import("@miragon/event-storming-renderer"),
      import("@miragon/event-storming-renderer/assets/event-storming.css"),
    ]);
    return {
      create: ({ insets } = {}) => createCollaborativeModeler({ undoRedoKeys: true, freeRectInsets: insets }),
      createViewer: () => createCollaborativeViewer(),
    };
  },
};
