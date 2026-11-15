/**
 * The `plugin` strategy: the engine's host stays in the node at the node body's size and the
 * board's CSS transform scales it, exactly as in `naive`. What differs is INSIDE the engine: every
 * editor is constructed with the outer-scale module (engines/outer-scale), which measures the
 * host's net scale itself and corrects the places where the engine mixes client px with container
 * px. So the chrome, the popups and an HTML view scale with the board, there is one document, and
 * a board zoom needs no view to be applied again.
 *
 * `&plugin=<comma list>` on the URL switches the module's layers (engines/outer-scale/layers.ts):
 * all by default, `none` for the bare engine. The list in effect is on the host as
 * `data-plugin-layers`.
 */
import { useLayoutEffect } from "react";

import type { SurfaceProps } from "../../notations/board/surface.ts";
import { outerScaleMount, readLayers } from "../engines/outer-scale/index.ts";
import { type EngineRuntime, setArmed, useEngine } from "../engines/use-engine.ts";

/** one list for the page: every plugin node of a board runs the same layers */
const layers = readLayers(location.search);
/** read once per mount (use-engine.ts); each engine instantiates its own services from it */
const mount = outerScaleMount(layers);

const onEngine = (runtime: EngineRuntime): void => {
  runtime.host.dataset.pluginLayers = layers.join(",");
  if (runtime.armed) runtime.engine?.focus();
};

export function PluginSurface(props: SurfaceProps) {
  const { armed, width, height } = props;
  const { slot, runtime } = useEngine(props, { strategy: "plugin", onEngine, mount });

  useLayoutEffect(() => {
    const current = runtime.current;
    if (!current) return;
    current.width = width;
    current.height = height;
    current.zoom = 1;
    setArmed(current, armed);
    // the host fills the slot: after a resize of the node the canvas has a new size
    current.controller?.sync();
  }, [runtime, armed, width, height]);

  return (
    <div className="board-surface" data-surface="plugin">
      <div ref={slot} className="board-surface__slot" />
    </div>
  );
}
