/**
 * An arrow a person drew: one element of the board document (source, target, the two sides, a
 * label). A solid line with a filled head.
 *
 * - The label is edited in place: a double-click on the label or on the line opens an input.
 * - Selected, the arrow shows a grip near each end. Dragging one onto a node moves that end there,
 *   to the side nearest to where it was dropped; released anywhere else, the arrow stays as it
 *   was. This is the board's own reconnect: React Flow's needs an onReconnect prop on <ReactFlow>
 *   and a drop within reach of a handle.
 * - Deleting is React Flow's: select the arrow, Backspace or Delete (or the toolbar).
 */
import { EdgeLabelRenderer, type EdgeProps, useReactFlow } from "@xyflow/react";
import { type PointerEvent, useRef, useState } from "react";

import { arrowEndAt, reconnectArrow } from "../board-actions.ts";
import { useBoardContext, useBoardZoom } from "../board-context.tsx";
import type { BoardEdge } from "../board-doc.ts";
import type { BoardFlowEdge } from "../board-flow.tsx";
import { InlineEdit } from "../nodes/inline-edit.tsx";
import { type ArrowPoint, arrowShape, HEAD_LENGTH, OPPOSITE, pointAlong } from "./arrow-shape.ts";

type End = "source" | "target";
/** the end that is being dragged, and where the pointer has it (board coordinates) */
interface Moving {
  end: End;
  x: number;
  y: number;
}

export function ArrowEdge(props: EdgeProps<BoardFlowEdge>) {
  const { id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, selected, data } = props;
  const { store } = useBoardContext();
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState<Moving | null>(null);
  const element = data?.element;
  const label = element?.attrs.label ?? "";

  // a dragged end follows the pointer and faces the end that stays
  const source: ArrowPoint =
    moving?.end === "source"
      ? { x: moving.x, y: moving.y, position: OPPOSITE[targetPosition] }
      : { x: sourceX, y: sourceY, position: sourcePosition };
  const target: ArrowPoint =
    moving?.end === "target"
      ? { x: moving.x, y: moving.y, position: OPPOSITE[sourcePosition] }
      : { x: targetX, y: targetY, position: targetPosition };
  const shape = arrowShape(source, target, HEAD_LENGTH - 1);

  return (
    <>
      <g
        className="board-arrow"
        data-moving={moving !== null}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setEditing(true);
        }}
      >
        <path className="react-flow__edge-path board-arrow__line" d={shape.path} fill="none" />
        <polygon
          className="board-arrow__head"
          points={`${shape.head.tip} ${shape.head.left} ${shape.head.right}`}
          style={{ transformOrigin: `${target.x}px ${target.y}px` }}
        />
        {/* what a click or a double-click has to hit: wider than the line */}
        <path className="react-flow__edge-interaction" d={shape.path} fill="none" strokeOpacity={0} strokeWidth={20} />
      </g>
      <EdgeLabelRenderer>
        {label !== "" || editing || selected ? (
          <div
            className="board-arrow-label nodrag nopan"
            data-selected={selected === true}
            data-edge={id}
            style={{ transform: shape.labelTransform }}
          >
            <InlineEdit
              className="board-arrow-label__text"
              value={label}
              placeholder="Add label"
              label="Arrow label"
              editing={editing}
              onEditing={setEditing}
              onCommit={(text) => store.gesture((tx) => tx.update(id, { label: text === "" ? undefined : text }))}
            />
          </div>
        ) : null}
        {selected && element ? <ArrowGrips element={element} path={shape.path} onMove={setMoving} /> : null}
      </EdgeLabelRenderer>
    </>
  );
}

/** a pointer that moved less than this (screen px) clicked the grip and did not drag it */
const DRAG_START_PX = 4;
/** how near (screen px) to a node a dropped end still lands on it */
const REACH_PX = 12;
/**
 * How far (screen px) along the line from the node a grip sits: clear of the node's handle there,
 * which starts a NEW arrow. On a short arrow: at most three tenths of the line.
 */
const GRIP_OFFSET_PX = 22;

interface ArrowGripsProps {
  element: BoardEdge;
  /** the arrow's line as drawn right now */
  path: string;
  onMove: (moving: Moving | null) => void;
}

/**
 * The two grips of a selected arrow, on its line near each end. They live in React Flow's label
 * layer, which the board's sheet puts over the nodes: in the arrow's own SVG they would lie
 * UNDER the nodes and their handles. Mounted only for a selected arrow, so only that one follows
 * the board zoom.
 */
function ArrowGrips({ element, path, onMove }: ArrowGripsProps) {
  const { store } = useBoardContext();
  const flow = useReactFlow();
  const zoom = useBoardZoom();
  const start = useRef<{ end: End; x: number; y: number; dragged: boolean } | null>(null);

  const grip = (end: End) => {
    const at = pointAlong(path, GRIP_OFFSET_PX / zoom, end === "target");
    return (
      <div
        className="board-arrow-grip nodrag nopan"
        data-end={end}
        data-edge={element.id}
        style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}
        onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          start.current = { end, x: event.clientX, y: event.clientY, dragged: false };
        }}
        onPointerMove={(event) => {
          const from = start.current;
          if (!from || from.end !== end) return;
          from.dragged ||= Math.hypot(event.clientX - from.x, event.clientY - from.y) >= DRAG_START_PX;
          if (from.dragged) onMove({ end, ...flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }) });
        }}
        onPointerUp={(event) => {
          const from = start.current;
          start.current = null;
          onMove(null);
          if (!from?.dragged) return;
          const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          // never onto the node at the arrow's other end: an arrow from a node to itself says nothing
          const other = end === "source" ? element.attrs.target : element.attrs.source;
          const to = arrowEndAt(store.getSnapshot(), point, REACH_PX / zoom, other);
          const [node, side] =
            end === "source"
              ? [element.attrs.source, element.attrs.sourceHandle]
              : [element.attrs.target, element.attrs.targetHandle];
          if (to && (to.node !== node || to.side !== side)) reconnectArrow(store, element.id, end, to);
        }}
        onPointerCancel={() => {
          start.current = null;
          onMove(null);
        }}
        // a click on a grip is no click on the arrow's label layer or on the board
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      />
    );
  };

  return (
    <>
      {grip("source")}
      {grip("target")}
    </>
  );
}
