/**
 * A group: a labelled frame that holds nodes. Its members are React Flow children of it, with
 * positions relative to the frame, so moving the group writes the group's own line of the board
 * file and nothing else. Who is a member is decided when a node's drag ends (board-actions.ts
 * writeDrop, called by board-flow.tsx): the node whose centre lies in the frame.
 *
 * Only the frame's border and its label take the pointer. The inside is board ground: a drag
 * there pans the board and a click clears the selection, even on a group that covers half of it.
 */
import { type NodeProps, NodeResizer } from "@xyflow/react";

import { regroup, writeRegroup } from "../board-actions.ts";
import { useBoardContext } from "../board-context.tsx";
import { type BoardStore, SIDES } from "../board-doc.ts";
import type { BoardFlowNode } from "../board-flow.tsx";
import { useReceiving, useZoomVar } from "../board-gestures.tsx";
import type { Box } from "../types.ts";
import { InlineEdit } from "./inline-edit.tsx";

/**
 * The end of a resize. A member's position is relative to the frame's top-left corner: when that
 * corner moved, every member gets the opposite move in the same gesture and stays where it is on
 * the board. Then whoever the frame no longer holds leaves, and whoever it now holds joins.
 */
function writeGroupResize(store: BoardStore, id: string, box: Box): void {
  const before = store.getSnapshot();
  const group = before.nodes.find((node) => node.id === id);
  if (!group) return;
  const [x, y] = [Math.round(box.x), Math.round(box.y)];
  const [dx, dy] = [x - group.attrs.x, y - group.attrs.y];
  store.gesture((tx) => {
    tx.update(id, { x, y, width: Math.round(box.width), height: Math.round(box.height) });
    if (dx === 0 && dy === 0) return;
    for (const node of before.nodes) {
      if (node.parentId === id) tx.update(node.id, { x: node.attrs.x - dx, y: node.attrs.y - dy });
    }
  });
  const after = store.getSnapshot();
  const others = after.nodes.filter((node) => node.attrs.type !== "group").map((node) => node.id);
  // only what concerns THIS frame: a node lying in another group it never joined stays as it is
  writeRegroup(
    store,
    regroup(after, others).filter(
      (move) => move.parent === id || after.nodes.find((node) => node.id === move.id)?.parentId === id,
    ),
  );
}

export function GroupNode({ id, data, selected }: NodeProps<BoardFlowNode>) {
  const { store } = useBoardContext();
  const receiving = useReceiving(id);
  // the label keeps a readable size when the board is zoomed out: a group's name is what an overview is read by
  const frame = useZoomVar<HTMLDivElement>();
  return (
    <>
      <div ref={frame} className="board-group" data-receiving={receiving}>
        {SIDES.map((side) => (
          <span key={side} className="board-group__edge" data-side={side} />
        ))}
        <InlineEdit
          className="board-group__label"
          value={data.element.attrs.text ?? ""}
          placeholder="Group"
          label="Group name"
          onCommit={(text) => store.gesture((tx) => tx.update(id, { text }))}
        />
      </div>
      {/* after the frame: its controls lie over the frame's border, which is what moves the group */}
      <NodeResizer
        isVisible={selected}
        minWidth={160}
        minHeight={120}
        onResizeEnd={(_event, box) => writeGroupResize(store, id, box)}
      />
    </>
  );
}
