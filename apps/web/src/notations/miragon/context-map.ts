/** @miragon/context-maps-renderer — works on a typed CmDocument, so the text
 *  lane goes through the schema-model codec (parse: Zod-validated,
 *  non-throwing, migrating; serialize: sorted by id, rounded,
 *  version-stamped). importDocument erases the history itself since 0.3.0,
 *  silently, so the document lane's own clear(false) is a no-op here. Since
 *  0.3.0 the legend card is the host's to add (cmLegendModule): it explains
 *  the subdomain types and relationship patterns, and designIQ has no legend
 *  of its own. */
import { schemaModelCodec } from "./codec.ts";
import type { LoadedMiragonRenderer, MiragonRendererCtor, MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "context-map",
  pkg: "@miragon/context-maps-renderer",
  canvasClassName: "cm-canvas",
  vendorRoot: "cm-djs-container",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ Modeler, NavigatedViewer, cmLegendModule }, schema] = await Promise.all([
      import("@miragon/context-maps-renderer"),
      import("@miragon/context-maps-schema-model"),
      import("@miragon/context-maps-renderer/assets/context-maps.css"),
    ]);
    return {
      Modeler: Modeler as unknown as MiragonRendererCtor,
      NavigatedViewer: NavigatedViewer as unknown as MiragonRendererCtor,
      additionalModules: [cmLegendModule],
      lane: { kind: "document", notation: "context-map", codec: schemaModelCodec(schema) },
    };
  },
};
