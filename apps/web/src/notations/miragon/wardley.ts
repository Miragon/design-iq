/** @miragon/wardley-renderer — the OWM DSL round-trips losslessly
 *  (importDSL/exportDSL), so the text tab and the canvas edit one document */
import type { LoadedMiragonRenderer, MiragonRendererCtor, MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "wardley",
  pkg: "@miragon/wardley-renderer",
  canvasClassName: "wardley-canvas",
  vendorRoot: "wardley-container",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ Modeler, NavigatedViewer }] = await Promise.all([
      import("@miragon/wardley-renderer"),
      import("@miragon/wardley-renderer/assets/wardley.css"),
    ]);
    return {
      Modeler: Modeler as unknown as MiragonRendererCtor,
      NavigatedViewer: NavigatedViewer as unknown as MiragonRendererCtor,
      // a committed title, size or axis-label edit runs through the command
      // stack since 0.7.0; `wardley.config.changed` also fires for every
      // preview step of a resize drag, whose size must never reach the Y.Text
      lane: { kind: "dsl", changeEvents: ["commandStack.changed"] },
    };
  },
};
