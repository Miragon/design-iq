/** @miragon/team-topologies-renderer — works on a typed TtDocument, so the
 *  text lane goes through the schema-model codec (parse: Zod-validated,
 *  non-throwing, keeps unknown fields, refuses duplicate and reserved ids
 *  since 0.11.0; serialize: deterministic, with a trailing newline since
 *  0.11.0). importDocument erases the history itself since 0.11.0, silently,
 *  so the document lane's own clear(false) is a no-op here. Every committed
 *  edit, the label editor's included, runs through the command stack; drags
 *  and an open label editor stay previews until they commit. */
import { schemaModelCodec } from "./codec.ts";
import type { LoadedMiragonRenderer, MiragonRendererCtor, MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "team-topology",
  pkg: "@miragon/team-topologies-renderer",
  canvasClassName: "tt-canvas",
  vendorRoot: "tt-djs-container",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ Modeler, NavigatedViewer }, schema] = await Promise.all([
      import("@miragon/team-topologies-renderer"),
      import("@miragon/team-topologies-schema-model"),
      import("@miragon/team-topologies-renderer/assets/team-topologies.css"),
    ]);
    return {
      Modeler: Modeler as unknown as MiragonRendererCtor,
      NavigatedViewer: NavigatedViewer as unknown as MiragonRendererCtor,
      lane: { kind: "document", notation: "team-topology", codec: schemaModelCodec(schema) },
    };
  },
};
