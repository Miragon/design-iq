/** @miragon/team-topologies-renderer — one JSON document, the factory's text
 *  is its canonical serialization with a closing line break; a document with
 *  duplicate or reserved ids, or an interaction without a position or size
 *  in a file that is not version 1, is refused with the path named. Every committed edit,
 *  the label editor's included, runs through the command stack; drags and an
 *  open label editor stay previews until they commit. Its 0.12 package ships
 *  no menu content: the menu names the document's title, nothing more. */
import type { TtBaseViewer } from "@miragon/team-topologies-renderer";

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
      title: (modeler) => (modeler.diagram as TtBaseViewer).getMeta()?.title.trim() || undefined,
    };
  },
};
