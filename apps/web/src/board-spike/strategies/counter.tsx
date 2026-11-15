/**
 * The `counter` strategy. Armed, the host inside the node is laid out at node size x board zoom
 * CSS px and carries `transform: scale(1 / zoom)`, origin top-left. Under the board's scale(zoom)
 * its net scale is 1, so one CSS px of the engine's container is one screen px, which is what
 * diagram-js's pointer math assumes. The node's view is applied with the board zoom on every zoom
 * tick, synchronously inside React Flow's store update.
 *
 * Preview is the naive layout (host at node size, scaled by the board), the view at zoom 1.
 *
 * What a counter-scale cannot give: a `position: fixed` box inside a transformed ancestor is laid
 * out against that ancestor. diagram-js's popup menu and palette tooltip are therefore created in
 * a body-level host (engines/diagram.ts); what a renderer appends to its own container is shifted
 * back by the host's client origin with CSS (the two custom properties below).
 */
import { useStoreApi } from "@xyflow/react";
import { useCallback, useLayoutEffect } from "react";

import { useBoardContext } from "../../notations/board/board-context.tsx";
import type { SurfaceProps } from "../../notations/board/surface.ts";
import { type EngineRuntime, setArmed, useEngine } from "../engines/use-engine.ts";

/**
 * The host's client origin for the sheet's `translate` on fixed boxes that stay inside the host. A
 * layout read, so only for an engine that has such boxes (Context Maps: the pad's text prompt).
 */
function publishOrigin(runtime: EngineRuntime): void {
  if (!runtime.engine?.fixedInContainer.length) return;
  const { x, y } = runtime.host.getBoundingClientRect();
  runtime.host.style.setProperty("--board-host-x", String(x));
  runtime.host.style.setProperty("--board-host-y", String(y));
}

export function CounterSurface(props: SurfaceProps) {
  const { armed, width, height } = props;
  const { subscribeViewport } = useBoardContext();
  const flow = useStoreApi();

  const place = useCallback(
    (runtime: EngineRuntime): void => {
      const zoom = runtime.armed ? flow.getState().transform[2] : 1;
      const { style } = runtime.host;
      if (runtime.armed) {
        // 1. the CSS size first: canvas.getSize() reads clientWidth / clientHeight live
        style.width = `${runtime.width * zoom}px`;
        style.height = `${runtime.height * zoom}px`;
        style.transform = `scale(${1 / zoom})`;
        runtime.host.dataset.layout = "counter";
      } else {
        style.width = "";
        style.height = "";
        style.transform = "";
        runtime.host.dataset.layout = "preview";
      }
      runtime.zoom = zoom;
      // 2. the viewbox for that size and zoom, 3. canvas.resized()
      runtime.controller?.sync();
    },
    [flow],
  );
  const onEngine = useCallback(
    (runtime: EngineRuntime): void => {
      place(runtime);
      if (runtime.armed) runtime.engine?.focus();
    },
    [place],
  );
  const { slot, runtime } = useEngine(props, { strategy: "counter", popupHost: true, onEngine });

  useLayoutEffect(() => {
    const current = runtime.current;
    if (!current) return;
    current.width = width;
    current.height = height;
    setArmed(current, armed);
    place(current);
  }, [runtime, place, armed, width, height]);

  useLayoutEffect(() => {
    let zoom = flow.getState().transform[2];
    // synchronous per pan and zoom tick, after React Flow wrote the viewport's transform, no render
    const offViewport = subscribeViewport((viewport) => {
      const current = runtime.current;
      if (!current?.armed) return;
      // a pan changes neither the size nor the scale: nothing to write (a write would close an open popup)
      if (viewport.zoom !== zoom) place(current);
      zoom = viewport.zoom;
      publishOrigin(current);
    });
    // a node drag moves the host without a viewport tick: the origin is read again before each press
    const host = runtime.current?.host;
    const onDown = (): void => {
      const current = runtime.current;
      if (current?.armed) publishOrigin(current);
    };
    host?.addEventListener("pointerdown", onDown, true);
    return () => {
      offViewport();
      host?.removeEventListener("pointerdown", onDown, true);
    };
    // the hook makes a new host when the node or its file changes
  }, [runtime, flow, subscribeViewport, place, props.nodeId, props.notation, props.file]);

  return (
    <div className="board-surface" data-surface="counter">
      <div ref={slot} className="board-surface__slot" />
    </div>
  );
}
