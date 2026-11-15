/**
 * The frame of a model node: header, body, resizer and the arming recipe (react-flow.md 3.6). What
 * shows in the body is the strategy's surface (strategies/index.ts), which gets SurfaceProps and
 * nothing else from here.
 *
 * Preview: the body is `inert`, so every pointer event lands on the node (a drag anywhere moves
 * it, a double-click arms it) and the editor inside gets nothing: a node drag swallows mousemove
 * and mouseup at the window, an editor that saw the mousedown would start a drag it never ends.
 * Armed: the four classes keep React Flow out of the body, and only the header moves the node.
 * A click inside the armed body is NOT stopped on its way up: React's stopPropagation stops the
 * native event at React's root, and whatever an editor delegates to the document never runs
 * (dmn-js's table and literal expression views: every list, menu entry and button was dead). The
 * board's own handlers ask where a click began instead (board.tsx, `inArmedEditor`).
 */
import { byId, modelStem } from "@designiq/notations";
import { type NodeProps, NodeResizer } from "@xyflow/react";
import { Check, GripVertical, Pencil } from "lucide-react";
import { memo, type MouseEvent, useEffect } from "react";

import { Slot, useBoardContext } from "../board-context.tsx";
import { notationOf, writeGeometry } from "../board-doc.ts";
import type { BoardFlowNode } from "../board-flow.tsx";

/** the header's height in flow units, as board.css sets it: the body is the node minus this */
const HEADER_HEIGHT = 32;
/** on the armed body: no node drag, no board pan, no board zoom, no board keys from inside */
const ARMED_CLASSES = "nodrag nopan nowheel nokey";

/** for the header's own button only, never for the body (see above) */
const stop = (event: MouseEvent): void => event.stopPropagation();

function ModelNodeFrame({ id, data, selected, width, height }: NodeProps<BoardFlowNode>) {
  const board = useBoardContext();
  const { element, armed } = data;
  const file = element.attrs.file ?? "";
  const notation = notationOf(file);
  const strategy = board.strategyOf(id);
  const Surface = board.surfaceOf(strategy);
  const { surfaceFailed } = board;
  useEffect(() => {
    if (!notation || !Surface) surfaceFailed(id);
  }, [notation, Surface, id, surfaceFailed]);

  return (
    <>
      {/* outside .board-node, which clips; the node's four handles come from board.tsx */}
      <NodeResizer
        isVisible={selected}
        minWidth={240}
        minHeight={160}
        onResizeEnd={(_event, box) => writeGeometry(board.store, { [id]: box })}
      />
      <div className="board-node" data-armed={armed} data-strategy={strategy} data-notation={notation}>
        <header className="board-node__header">
          <GripVertical className="board-node__grip" aria-hidden />
          <span className="board-node__title">{modelStem(file)}</span>
          <span className="board-node__notation">{notation ? byId(notation)?.label : "no model"}</span>
          {/* which strategy embeds the editor: the bench's label, a host has one strategy */}
          {board.embedded ? null : <span className="board-node__strategy">{strategy}</span>}
          <button
            type="button"
            className="board-node__arm nodrag"
            // through the arm rule of this node: Edit may move the board first, Done may bring it back
            onClick={() => void board.arm(armed ? null : id, { source: armed ? "done" : "button" })}
            // the second click of a double-click on Done must not arm the node again
            onDoubleClick={stop}
          >
            {armed ? <Check aria-hidden /> : <Pencil aria-hidden />}
            {armed ? "Done" : "Edit"}
          </button>
        </header>
        <div className={armed ? `board-node__body ${ARMED_CLASSES}` : "board-node__body"} inert={!armed}>
          {notation && Surface ? (
            <Slot name={`${strategy} surface of ${id}`} onError={() => surfaceFailed(id)}>
              <Surface
                nodeId={id}
                notation={notation}
                file={file}
                armed={armed}
                width={width ?? element.attrs.width}
                height={Math.max(0, (height ?? element.attrs.height) - HEADER_HEIGHT)}
              />
            </Slot>
          ) : (
            <div className="board-slot board-slot--error" role="alert">
              <strong>{file}</strong>
              <span>{notation ? `cannot be shown here (no ${strategy} surface)` : "is no model file"}</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * A drag changes positionAbsoluteX/Y on every tick: none of that concerns the frame or the editor
 * in it. `width` / `height` do change during a resize, and the surface has to follow them.
 */
export const ModelNode = memo(
  ModelNodeFrame,
  (a, b) =>
    a.id === b.id && a.data === b.data && a.selected === b.selected && a.width === b.width && a.height === b.height,
);
