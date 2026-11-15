/**
 * The `shim` strategy: the naive placement (the engine's host in the node at the node body's size,
 * scaled by the board's CSS transform, the view at zoom 1), plus the coordinate shim while the node
 * is armed (engines/coordinate-shim): the page gives the armed editor a virtual, unscaled
 * coordinate space, in event coordinates, client rectangles, point queries, screen matrices and the
 * window's size. The editor's host, its popups and its fixed boxes stay where the engine put them.
 *
 * Nothing of the board's view is written to the canvas on a board zoom or pan: the virtual space
 * is relative to the node, so an open popup or label editor survives both.
 *
 * Whatever measures keeps reading the browser's own functions (native-geometry.ts,
 * `window.__boardSpikeNative`). `window.__boardSpikeShim` tells a script what is patched.
 */
import "./shim.css";

import { useLayoutEffect } from "react";

import { useBoardContext } from "../../notations/board/board-context.tsx";
import type { SurfaceProps } from "../../notations/board/surface.ts";
import { armShim, disarmShim, invalidateShim, shimOptions } from "../engines/coordinate-shim/index.ts";
import { type EngineRuntime, setArmed, useEngine } from "../engines/use-engine.ts";

const onEngine = (runtime: EngineRuntime): void => {
  if (runtime.armed) runtime.engine?.focus();
};

export function ShimSurface(props: SurfaceProps) {
  const { nodeId, notation, file, armed, width, height } = props;
  const { subscribeViewport } = useBoardContext();
  const { slot, runtime } = useEngine(props, { strategy: "shim", onEngine });

  useLayoutEffect(() => {
    const current = runtime.current;
    if (!current) return;
    current.width = width;
    current.height = height;
    current.zoom = 1;
    // ONE effect, in this order: the space exists before the editor takes input, and it is still
    // there while disarming completes an open label editor (which compares client rectangles)
    if (armed) armShim(current.host, nodeId);
    setArmed(current, armed);
    if (!armed) disarmShim(current.host);
    // the host fills the slot: after a resize of the node the canvas has a new size
    current.controller?.sync();
  }, [runtime, nodeId, notation, file, armed, width, height]);

  useLayoutEffect(() => {
    // the hook makes a new host when the node or its file changes, and removes the old one first
    const host = runtime.current?.host;
    // only the `tick` read mode listens to this: by default the space is read anew in every job
    const offViewport = subscribeViewport(invalidateShim);
    return () => {
      offViewport();
      if (host) disarmShim(host);
    };
  }, [runtime, subscribeViewport, nodeId, notation, file]);

  return (
    <div className="board-surface" data-surface="shim" data-shim-css={shimOptions.css}>
      <div ref={slot} className="board-surface__slot" />
    </div>
  );
}
