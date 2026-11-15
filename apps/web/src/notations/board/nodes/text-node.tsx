/**
 * A text note: Markdown, rendered sanitized (note-markdown.ts), resizable, on one of a few
 * grounds. A double-click (or the note's Edit button) opens the source in a textarea in place;
 * Escape, Ctrl+Enter or leaving the textarea commits it as ONE write of the board document.
 *
 * While the textarea is open the note carries React Flow's four opt-out classes
 * (react-flow.md 3.6): a drag inside it selects text and does not move the note, a wheel scrolls
 * the text and does not zoom the board, and no key reaches the board. A textarea is an input to
 * React Flow, so Backspace deletes a character and never the node.
 */
import { type NodeProps, NodeResizer, NodeToolbar, Position } from "@xyflow/react";
import { Pencil } from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";

import { NOTE_COLORS, type NoteColor, noteColor, writeNoteColor } from "../board-actions.ts";
import { useBoardContext } from "../board-context.tsx";
import { writeGeometry } from "../board-doc.ts";
import type { BoardFlowNode } from "../board-flow.tsx";
import { takeEditRequest } from "../board-gestures.tsx";
import { loadNoteRenderer, noteRenderer } from "./note-markdown.ts";

const COLOR_NAMES: Readonly<Record<NoteColor, string>> = {
  plain: "White",
  amber: "Amber",
  green: "Green",
  blue: "Blue",
  red: "Red",
};

/** keeps a click out of the node wrapper's select / unselect handler and out of onNodeDoubleClick */
const stop = (event: MouseEvent): void => event.stopPropagation();

export function TextNode({ id, data, selected, dragging }: NodeProps<BoardFlowNode>) {
  const board = useBoardContext();
  const { store, log } = board;
  const { attrs } = data.element;
  const text = attrs.text ?? "";
  const color = noteColor(attrs);
  const [editing, setEditing] = useState(() => takeEditRequest(id));
  const body = useRef<HTMLDivElement>(null);

  // the rendered note: plain text until the Markdown engine is there, then its sanitized fragment
  useEffect(() => {
    if (editing) return;
    const show = (render = noteRenderer()): void => {
      if (!body.current) return;
      if (render) body.current.replaceChildren(render(text));
      else body.current.textContent = text;
    };
    show();
    if (noteRenderer()) return;
    let current = true;
    loadNoteRenderer().then(
      (render) => void (current && show(render)),
      (error: unknown) => log(`text node ${id}: ${error instanceof Error ? error.message : String(error)}`),
    );
    return () => void (current = false);
  }, [text, editing, id, log]);

  const edit = (): void => {
    // one thing takes the keys: an armed editor hands them back
    void board.arm(null);
    opened.current = text;
    setEditing(true);
  };
  /** the text the editor opened with: a peer may change the note while it is open */
  const opened = useRef(text);
  const commit = (next: string): void => {
    setEditing(false);
    // Against what the editor OPENED with, never against the text of now: an editor nobody typed
    // in would otherwise write its old text over a peer's change (measured: the peer's sentence
    // was gone after Escape)
    if (next !== opened.current) store.gesture((tx) => tx.update(id, { text: next }));
  };

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={60}
        onResizeEnd={(_event, box) => writeGeometry(store, { [id]: box })}
      />
      {/* mounted only for the selected note: a toolbar reads the viewport on every pan and zoom tick */}
      {selected && !editing && !dragging ? (
        <NodeToolbar
          position={Position.Top}
          offset={10}
          className="board-node-toolbar nodrag nopan"
          role="toolbar"
          aria-label="Note"
          onClick={stop}
          onDoubleClick={stop}
        >
          {NOTE_COLORS.map((one) => (
            <button
              key={one}
              type="button"
              className="board-swatch"
              data-color={one}
              title={`${COLOR_NAMES[one]} note`}
              aria-label={`${COLOR_NAMES[one]} note`}
              aria-pressed={one === color}
              onClick={() => writeNoteColor(store, id, one)}
            />
          ))}
          <span className="board-node-toolbar__rule" aria-hidden />
          <button type="button" className="board-node-toolbar__button" onClick={edit}>
            <Pencil aria-hidden />
            Edit
          </button>
        </NodeToolbar>
      ) : null}
      <div
        className={editing ? "board-text nodrag nopan nowheel nokey" : "board-text"}
        data-color={color}
        data-editing={editing}
        onClick={editing ? stop : undefined}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (!editing) edit();
        }}
      >
        {editing ? (
          <NoteEditor text={text} onCommit={commit} />
        ) : (
          <div ref={body} className="board-text__body" data-empty={text.trim() === ""} />
        )}
      </div>
    </>
  );
}

function NoteEditor({ text, onCommit }: { text: string; onCommit: (text: string) => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    // preventScroll: a focus inside the scaled viewport would otherwise scroll the board's container
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  // not controlled: typing renders nothing, and the text is read once, at the end
  return (
    <textarea
      ref={area}
      className="board-text__editor"
      defaultValue={text}
      aria-label="Note text, Markdown"
      placeholder="Write a note. Markdown works."
      spellCheck={false}
      onBlur={(event) => {
        // Escape blurs, and the blur is the commit: one path, one write
        if (done.current) return;
        done.current = true;
        onCommit(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
