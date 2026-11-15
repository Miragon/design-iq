/**
 * The `naive` strategy, the spike's CONTROL: the engine's host stays inside the node at the node
 * body's size and the board's CSS transform scales it, armed or not. Nothing compensates. Whatever
 * an engine computes from client rectangles is therefore off by the board zoom (diagram-js assumes
 * that one CSS px of its container is one screen px).
 *
 * It shares the node's own view with the other strategies (the first fit, the node's size), always
 * at zoom 1: the canvas is never told about the board zoom.
 */
import { useLayoutEffect } from "react";

import type { SurfaceProps } from "../../notations/board/surface.ts";
import { type EngineRuntime, setArmed, useEngine } from "../engines/use-engine.ts";

const onEngine = (runtime: EngineRuntime): void => {
  if (runtime.armed) runtime.engine?.focus();
};

export function NaiveSurface(props: SurfaceProps) {
  const { armed, width, height } = props;
  const { slot, runtime } = useEngine(props, { strategy: "naive", onEngine });

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
    <div className="board-surface" data-surface="naive">
      <div ref={slot} className="board-surface__slot" />
    </div>
  );
}
