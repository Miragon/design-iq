/** @miragon/team-topologies-renderer — one JSON document, the factory's text
 *  is its canonical serialization with a closing line break; a document with
 *  duplicate or reserved ids is refused with the ids named. Every committed
 *  edit, the label editor's included, runs through the command stack; drags
 *  and an open label editor stay previews until they commit. */
import { contractOptions, type LoadedMiragonRenderer, type MiragonRendererSpec } from "./spec.ts";

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
      create: (mount) => createCollaborativeModeler({ ...contractOptions(mount), undoRedoKeys: true }),
      createViewer: (mount) => createCollaborativeViewer(contractOptions(mount)),
    };
  },
};
