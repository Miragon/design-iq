/** @miragon/context-maps-renderer — one JSON document, the factory's text
 *  is its canonical serialization with a closing line break. The legend
 *  card is the host's to add since 0.3.0 (cmLegendModule): it explains the
 *  subdomain types and relationship patterns, and designIQ has no legend of
 *  its own, so every mount gets it. */
import { contractOptions, type LoadedMiragonRenderer, type MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "context-map",
  pkg: "@miragon/context-maps-renderer",
  canvasClassName: "cm-canvas",
  contractNotation: "context-maps",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ cmLegendModule, createCollaborativeModeler, createCollaborativeViewer }] = await Promise.all([
      import("@miragon/context-maps-renderer"),
      import("@miragon/context-maps-renderer/assets/context-maps.css"),
    ]);
    const additionalModules = [cmLegendModule];
    return {
      create: (mount) =>
        createCollaborativeModeler({ ...contractOptions(mount), additionalModules, undoRedoKeys: true }),
      createViewer: (mount) => createCollaborativeViewer({ ...contractOptions(mount), additionalModules }),
    };
  },
};
