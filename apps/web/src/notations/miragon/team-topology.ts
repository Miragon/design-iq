/** @miragon/team-topologies-renderer — one JSON document, the factory's text
 *  is its canonical serialization with a closing line break; a document with
 *  duplicate or reserved ids is refused with the ids named. Every committed
 *  edit, the label editor's included, runs through the command stack; drags
 *  and an open label editor stay previews until they commit. Unlike the
 *  other renderers it takes the free area as a point, `freeRectCenter` in
 *  diagram coordinates, and it fits on import only when the host does not
 *  fit itself (`fitOnImport`). */
import type { CollaborativeTeamTopologiesModeler } from "@miragon/team-topologies-renderer";

import type { Insets } from "../../mcp-app/core/engine.ts";
import type { LoadedMiragonRenderer, MiragonDiagram, MiragonRendererSpec } from "./spec.ts";

interface CanvasViewbox {
  viewbox(): { x: number; y: number; scale: number; outer: { width: number; height: number } };
}

/** the centre of what the insets leave of the canvas, in diagram coordinates */
function freeRectCentre(diagram: MiragonDiagram, insets: Insets): { x: number; y: number } {
  const { x, y, scale, outer } = (diagram.get("canvas") as CanvasViewbox).viewbox();
  return {
    x: x + (insets.left + (outer.width - insets.left - insets.right) / 2) / scale,
    y: y + (insets.top + (outer.height - insets.top - insets.bottom) / 2) / scale,
  };
}

export const spec: MiragonRendererSpec = {
  id: "team-topology",
  pkg: "@miragon/team-topologies-renderer",
  canvasClassName: "tt-canvas",
  contractNotation: "team-topologies",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ createCollaborativeModeler, createCollaborativeViewer }] = await Promise.all([
      import("@miragon/team-topologies-renderer"),
      import("@miragon/team-topologies-renderer/assets/team-topologies.css"),
    ]);
    return {
      create: ({ insets } = {}) => {
        const modeler: CollaborativeTeamTopologiesModeler = createCollaborativeModeler({
          undoRedoKeys: true,
          freeRectCenter: insets && (() => freeRectCentre(modeler.diagram, insets())),
          fitOnImport: !insets,
        });
        return modeler;
      },
      createViewer: ({ insets } = {}) => createCollaborativeViewer({ fitOnImport: !insets }),
    };
  },
};
