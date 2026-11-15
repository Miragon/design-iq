/**
 * Live presence on the board itself: the cursors of the other people who have this board open
 * and outlines around the nodes they selected, and this person's own cursor and selection for
 * them. The look is the product's (lib/presence-canvas.ts: the arrow, the name chip on the
 * peer's colour, a 1.5 px outline 3 px off the box); the coordinates are the board's.
 *
 * Drawn inside React Flow's viewport, so a cursor lies on the same spot of the board for peers
 * at another pan and zoom; the glyphs are scaled back to keep their size on screen.
 *
 * Inside an ARMED editor this person's board cursor is taken back: there the model's own editor
 * publishes it in the model's room, in model coordinates, and every board that shows that model
 * draws it in its preview (overlay-surface.tsx). Two cursors for one pointer otherwise.
 */
import type { CanvasPresence } from "@designiq/contracts/live";
import { useOnSelectionChange, useReactFlow, useStore, ViewportPortal } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { safePresenceColor, safePresenceLabel } from "../../lib/presence-format.ts";
import { absoluteBoxes } from "./board-actions.ts";
import { inArmedEditor } from "./board-arming.ts";
import { useBoardContext, useBoardZoom } from "./board-context.tsx";
import type { BoardFlowEdge, BoardFlowNode } from "./board-flow.tsx";
import { clientPoint } from "./geometry.ts";
import type { BoardPeer, BoardPresence } from "./presence.ts";

/** publish cadence for pointer moves: awareness is a broadcast, not a stream (as on every canvas) */
const PUBLISH_MS = 33;
/** outlines per peer, published and drawn: awareness repeats the whole state with every cursor tick */
const MAX_OUTLINES = 50;
/** the product's cursor glyph (lib/presence-canvas.ts) */
const ARROW = "M0,0 L0,14 L4,10.5 L6.5,16 L9,15 L6.5,9.5 L11,9.5 Z";

export function BoardPresenceLayer() {
  const { presence } = useBoardContext();
  return presence ? <Presence presence={presence} /> : null;
}

function Presence({ presence }: { presence: BoardPresence }) {
  const { store } = useBoardContext();
  const flow = useReactFlow<BoardFlowNode, BoardFlowEdge>();
  const host = useStore((state) => state.domNode);
  const zoom = useBoardZoom();
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [peers, setPeers] = useState<BoardPeer[]>([]);
  useEffect(() => presence.onRemote(setPeers), [presence]);

  // ── this person: pointer and selection, throttled ──
  const local = useRef<CanvasPresence>({ cursor: null, selection: [] });
  const timing = useRef<{ last: number; trailing?: ReturnType<typeof setTimeout> }>({ last: 0 });
  const publishNow = useCallback((): void => {
    const state = timing.current;
    clearTimeout(state.trailing);
    state.trailing = undefined;
    state.last = Date.now();
    presence.setLocal({ cursor: local.current.cursor, selection: [...local.current.selection] });
  }, [presence]);
  useEffect(() => {
    if (!host) return undefined;
    const state = timing.current;
    const publishThrottled = (): void => {
      const due = state.last + PUBLISH_MS - Date.now();
      if (due <= 0) publishNow();
      else state.trailing ??= setTimeout(publishNow, due);
    };
    const leave = (): void => {
      if (local.current.cursor === null) return;
      local.current.cursor = null;
      publishNow();
    };
    const onMove = (event: PointerEvent): void => {
      // in the armed editor the model's own editor publishes the cursor, in the model's room
      if (inArmedEditor(event.target)) return leave();
      const at = flow.screenToFlowPosition(clientPoint(event));
      if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
      local.current.cursor = { x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10 };
      publishThrottled();
    };
    host.addEventListener("pointermove", onMove, { passive: true });
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", leave);
      clearTimeout(state.trailing);
      state.trailing = undefined;
      // drop this person's cursor for the peers right away
      presence.setLocal(null);
    };
  }, [host, flow, presence, publishNow]);
  useOnSelectionChange<BoardFlowNode, BoardFlowEdge>({
    onChange: useCallback(
      ({ nodes, edges }) => {
        local.current.selection = [
          ...nodes.map((node) => node.id),
          // a derived arrow is no element of the board
          ...edges.flatMap((edge) => (edge.data?.element ? [edge.id] : [])),
        ].slice(0, MAX_OUTLINES);
        // a selection is discrete: no reason to throttle
        publishNow();
      },
      [publishNow],
    ),
  });

  // ── the others ──
  const boxes = useMemo(() => absoluteBoxes(view), [view]);
  const scale = 1 / (zoom || 1);
  return (
    <ViewportPortal>
      <div className="board-presence" aria-hidden>
        {peers.map((peer) => {
          if (!peer.canvas) return null;
          const color = safePresenceColor(peer.user.color);
          const selection = Array.isArray(peer.canvas.selection) ? peer.canvas.selection.slice(0, MAX_OUTLINES) : [];
          const { cursor } = peer.canvas;
          const shown = cursor !== null && Number.isFinite(cursor?.x) && Number.isFinite(cursor?.y);
          return (
            <div key={peer.clientId} className="board-presence__peer" data-peer={peer.clientId}>
              {selection.map((id) => {
                const box = typeof id === "string" ? boxes.get(id) : undefined;
                // an arrow has no box of its own: only nodes are outlined
                if (!box) return null;
                return (
                  <div
                    key={id}
                    className="board-presence__outline"
                    data-agent={peer.user.kind === "agent"}
                    style={{
                      left: box.x,
                      top: box.y,
                      width: box.width,
                      height: box.height,
                      outlineColor: color,
                      // the same width and distance on screen at every zoom
                      outlineWidth: 1.5 * scale,
                      outlineOffset: 3 * scale,
                    }}
                  />
                );
              })}
              {shown && cursor ? (
                <div
                  className="board-presence__cursor"
                  style={{ transform: `translate(${cursor.x}px, ${cursor.y}px) scale(${scale})`, color }}
                >
                  <svg className="board-presence__arrow" width="12" height="17" viewBox="0 0 12 17">
                    <path d={ARROW} />
                  </svg>
                  <span className="board-presence__name" style={{ backgroundColor: color }}>
                    {safePresenceLabel(peer.user.name)}
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </ViewportPortal>
  );
}
