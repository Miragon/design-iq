/**
 * A derived arrow: a relation the MODELS state (a call activity, a business rule task), read from
 * their current texts (derived-refs.ts) and stored nowhere. It looks unlike a drawn arrow on
 * purpose: dashed, quiet, an open head, its relation as a small tag. It takes no pointer: there
 * is nothing to select, move or delete, the arrow goes when the model's text says so.
 */
import { EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { Link2 } from "lucide-react";

import type { BoardFlowEdge } from "../board-flow.tsx";
import { arrowShape } from "./arrow-shape.ts";

export function DerivedEdge(props: EdgeProps<BoardFlowEdge>) {
  const { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, data } = props;
  const shape = arrowShape(
    { x: sourceX, y: sourceY, position: sourcePosition },
    { x: targetX, y: targetY, position: targetPosition },
    // an open head: the line runs to its tip
    0,
  );
  return (
    <>
      <path className="react-flow__edge-path board-derived__line" d={shape.path} fill="none" />
      <polyline
        className="board-derived__head"
        points={`${shape.head.left} ${shape.head.tip} ${shape.head.right}`}
        style={{ transformOrigin: `${targetX}px ${targetY}px` }}
      />
      <EdgeLabelRenderer>
        <div className="board-derived-label" data-rel={data?.rel} style={{ transform: shape.labelTransform }}>
          <Link2 aria-hidden />
          {data?.rel}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
