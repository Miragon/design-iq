/**
 * The `overlay` strategy. Armed, the SAME host element (with the engine in it) is moved out of the
 * node into the board's screen-space layer: a child of `.react-flow` outside the scaled viewport,
 * so no ancestor of the editor carries a transform. It is placed with left / top / width / height
 * over the node body, computed from the node's flow rectangle and the viewport and rounded to
 * device pixels, on every pan and zoom tick and on every move of the node, without a React render.
 * Pointer math is exact by construction and `position: fixed` popups work unpatched; the price is
 * the z-order (the armed editor is above every node and arrow) and the DOM move on arm and disarm.
 *
 * Disarmed, the host goes back into the node (preview: scaled by the board) and the view is
 * applied at zoom 1 again, so the preview shows the area the editor showed.
 */
import { useStoreApi } from "@xyflow/react";
import { useCallback, useLayoutEffect, useRef } from "react";

import { useBoardContext } from "../../notations/board/board-context.tsx";
import { ProductOverlaySurface } from "../../notations/board/overlay-surface.tsx";
import type { SurfaceProps } from "../../notations/board/surface.ts";
import { type EngineRuntime, setArmed, useEngine } from "../engines/use-engine.ts";
import { benchParams } from "../samples.ts";

/** the nearest device pixel: a box on a fractional CSS px is drawn blurred */
function snap(value: number): number {
  const ratio = window.devicePixelRatio || 1;
  return Math.round(value * ratio) / ratio;
}

interface Placed {
  /** the node body's place inside the node, in flow units */
  bodyLeft: number;
  bodyTop: number;
  /** what the host's style and the canvas were last written for */
  rect: string;
  synced: string;
}

/** `&mount=product` puts the product's own editor into the node (overlay-product.tsx); the default is the spike's mount */
export function OverlaySurface(props: SurfaceProps) {
  const { params } = useBoardContext();
  return benchParams(params).mount === "product" ? (
    <ProductOverlaySurface {...props} />
  ) : (
    <SpikeOverlaySurface {...props} />
  );
}

function SpikeOverlaySurface(props: SurfaceProps) {
  const { nodeId, armed, width, height } = props;
  const { overlayLayer } = useBoardContext();
  const flow = useStoreApi();
  /** set while the host is in the layer */
  const placed = useRef<Placed | null>(null);

  const place = useCallback(
    (runtime: EngineRuntime): void => {
      const { host, home } = runtime;
      const layer = overlayLayer();
      if (runtime.armed && layer) {
        if (host.parentElement !== layer) {
          // layout px ignore every transform: read once per arming, before the host leaves the node
          const body = home.closest<HTMLElement>(".board-node__body");
          placed.current = { bodyLeft: body?.offsetLeft ?? 0, bodyTop: body?.offsetTop ?? 0, rect: "", synced: "" };
          layer.appendChild(host);
          host.dataset.layout = "overlay";
          // the move took the focus from whatever had it inside
          runtime.engine?.focus();
        }
        const current = placed.current;
        const state = flow.getState();
        const node = state.nodeLookup.get(nodeId);
        if (!current || !node) return;
        const [x, y, zoom] = state.transform;
        const origin = node.internals.positionAbsolute;
        const left = snap(x + (origin.x + current.bodyLeft) * zoom);
        const top = snap(y + (origin.y + current.bodyTop) * zoom);
        const boxWidth = snap(x + (origin.x + current.bodyLeft + runtime.width) * zoom) - left;
        const boxHeight = snap(y + (origin.y + current.bodyTop + runtime.height) * zoom) - top;
        const rect = `${left},${top},${boxWidth},${boxHeight}`;
        if (rect !== current.rect) {
          current.rect = rect;
          const { style } = host;
          style.left = `${left}px`;
          style.top = `${top}px`;
          style.width = `${boxWidth}px`;
          style.height = `${boxHeight}px`;
        }
        runtime.zoom = zoom;
        // a pan moves the host and changes neither its size nor the scale: no viewbox write then
        const synced = `${boxWidth}x${boxHeight}@${zoom}`;
        if (synced !== current.synced) {
          current.synced = synced;
          runtime.controller?.sync();
        }
        return;
      }
      if (host.parentElement !== home) {
        home.appendChild(host);
        host.dataset.layout = "preview";
        const { style } = host;
        style.left = "";
        style.top = "";
        style.width = "";
        style.height = "";
      }
      placed.current = null;
      runtime.zoom = 1;
      runtime.controller?.sync();
    },
    [flow, nodeId, overlayLayer],
  );
  const onEngine = useCallback(
    (runtime: EngineRuntime): void => {
      // the canvas exists now: whatever was placed before was placed without it
      if (placed.current) placed.current.synced = "";
      place(runtime);
      if (runtime.armed) runtime.engine?.focus();
    },
    [place],
  );
  const { slot, runtime } = useEngine(props, { strategy: "overlay", onEngine });

  useLayoutEffect(() => {
    const current = runtime.current;
    if (!current) return;
    current.width = width;
    current.height = height;
    setArmed(current, armed);
    place(current);
  }, [runtime, place, armed, width, height]);

  useLayoutEffect(() => {
    // Every update of React Flow's store, synchronously: a pan or zoom tick (a new transform) and a
    // move or resize of the node (new internals). No render, and no write when nothing moved
    const off = flow.subscribe(() => {
      const current = runtime.current;
      if (current?.armed) place(current);
    });
    // the layer is attached by the board's first commit, which may come after this surface's
    const late = requestAnimationFrame(() => {
      const current = runtime.current;
      if (current?.armed) place(current);
    });
    return () => {
      off();
      cancelAnimationFrame(late);
    };
  }, [runtime, flow, place]);

  return (
    <div className="board-surface" data-surface="overlay">
      <div ref={slot} className="board-surface__slot" />
      {/* what stays in the node while its editor is in the layer above it */}
      {armed && <div className="board-surface__placeholder">Editing in the layer above the board</div>}
    </div>
  );
}
