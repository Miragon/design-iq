/**
 * Notation -> its spike-local mount. Each engine loads on demand, like in the product: a board
 * without a DMN node loads no dmn-js.
 */
import type { ModelNotation } from "../shared.ts";
import type { EngineCallbacks, EngineHandle, ModelSource, MountOptions } from "./types.ts";

export type {
  DiagramLike,
  EngineCallbacks,
  EngineHandle,
  EngineView,
  ModelSource,
  MountOptions,
  Rect,
} from "./types.ts";

export async function mountEngine(
  notation: ModelNotation,
  host: HTMLElement,
  source: ModelSource,
  callbacks: EngineCallbacks,
  options?: MountOptions,
): Promise<EngineHandle> {
  switch (notation) {
    case "bpmn":
      return (await import("./bpmn.ts")).mountBpmn(host, source, callbacks, options);
    case "dmn":
      return (await import("./dmn.ts")).mountDmn(host, source, callbacks, options);
    default:
      return (await import("./miragon.ts")).mountMiragon(notation)(host, source, callbacks, options);
  }
}
