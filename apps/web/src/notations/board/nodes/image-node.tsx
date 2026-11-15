/**
 * An image: the node holds the PATH of a repository file and nothing else. The bytes come from
 * the hub's assets (the stand-in for the repository), the way a Markdown document's image comes
 * from the image route. Resizable in the picture's proportions.
 *
 * The picture is drawn through <img>: an SVG file runs no script there.
 */
import { type NodeProps, NodeResizer } from "@xyflow/react";
import { ImageOff } from "lucide-react";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { formatBytes } from "../board-actions.ts";
import { useBoardContext } from "../board-context.tsx";
import { writeGeometry } from "../board-doc.ts";
import type { BoardFlowNode } from "../board-flow.tsx";

export function ImageNode({ id, data, selected }: NodeProps<BoardFlowNode>) {
  const { hub, store } = useBoardContext();
  const file = data.element.attrs.file ?? "";
  // the file may arrive after the node (a peer's upload): the hub tells when its file list changes
  const blob = useSyncExternalStore(hub.onFiles, () => hub.asset(file));
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : undefined), [blob]);
  useEffect(() => () => void (url !== undefined && URL.revokeObjectURL(url)), [url]);
  const name = file.slice(file.lastIndexOf("/") + 1);

  return (
    <>
      <NodeResizer
        isVisible={selected}
        keepAspectRatio
        minWidth={48}
        minHeight={36}
        onResizeEnd={(_event, box) => writeGeometry(store, { [id]: box })}
      />
      <figure className="board-image" data-missing={!blob}>
        {url !== undefined ? (
          <img className="board-image__picture" src={url} alt={name} draggable={false} />
        ) : (
          <div className="board-image__missing" role="img" aria-label={`${file} is missing`}>
            <ImageOff aria-hidden />
            <span>No such file in the repository</span>
          </div>
        )}
        <figcaption className="board-image__caption">
          <span className="board-image__path">{file}</span>
          {blob ? <span>{formatBytes(blob.size)}</span> : null}
        </figcaption>
      </figure>
    </>
  );
}
