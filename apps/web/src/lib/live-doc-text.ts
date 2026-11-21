/**
 * A live document as the text of its file, whatever the shape of its room
 * (@designiq/notations DocShape). The History panel compares a commit with
 * it and restores one into it; the read-only source of a structured
 * document shows it.
 *
 *   text        the shared Y.Text (CONTENT_KEY) is the file's text. A
 *               restore writes the commit's text as a minimal diff
 *               (updateText), which the canvas binding imports.
 *   structured  the element and meta maps are the document (a board);
 *               CONTENT_KEY stays empty and is never saved. The file's text
 *               is the codec's canonical encode of the maps, and a restore
 *               goes in element- and attribute-wise (reconcileSnapshot), so
 *               a co-editor's edit of another element survives it. A text
 *               the codec's strict reader refuses is not written at all:
 *               what its decode skips, the next save would drop from the file.
 *
 * A restore that would change nothing writes nothing and says so: the shell
 * must never report a write that did not happen. A view that shows the text
 * follows it by its changed parts alone (textEdits).
 *
 * Pure over Yjs and the codec, timers aside (test/live-doc-text.test.ts).
 */
import { readSnapshot, reconcileSnapshot } from "@designiq/live-client/structured";
import { diffHunks, updateText } from "@designiq/live-client/text";
import type { DocCodec } from "@designiq/notations/codecs";
import type * as Y from "yjs";

/** what a restore did */
export type RestoreOutcome =
  | { kind: "restored" }
  /** the document already is that version: nothing was written */
  | { kind: "unchanged" }
  /** the text cannot be written back without losing content (the codec's
   *  strict reader says why): nothing was written */
  | { kind: "refused"; reason: string };

export interface LiveDocText {
  /** the document as its file has it */
  read(): string;
  /** write `text` (a version of the file) into the live document, for everyone in it */
  restore(text: string): RestoreOutcome;
  /** `cb` with the text once the document changed and then rested `restMs`;
   *  returns the unsubscribe, which drops a call still waiting */
  follow(cb: (text: string) => void, restMs: number): () => void;
}

/** the slice of a live session this reads and writes */
export interface LiveDoc {
  readonly doc: Y.Doc;
  /** CONTENT_KEY of the doc */
  readonly content: Y.Text;
}

const RESTORED: RestoreOutcome = { kind: "restored" };
const UNCHANGED: RestoreOutcome = { kind: "unchanged" };

/** the text of `live`: its shared text, or with `codec` (a structured document's) its element maps' */
export function liveDocText(live: LiveDoc, codec?: DocCodec): LiveDocText {
  const { doc, content } = live;
  const read = codec ? (): string => codec.encode(readSnapshot(doc)) : (): string => content.toString();
  return {
    read,
    restore(text) {
      if (!codec) {
        if (content.toString() === text) return UNCHANGED;
        updateText(content, text);
        return RESTORED;
      }
      const reason = codec.check?.(text);
      if (reason !== undefined) return { kind: "refused", reason };
      const next = codec.decode(text);
      if (codec.encode(next) === read()) return UNCHANGED;
      // no origin of its own: the canvas draws it as a peer's change, off its undo history
      reconcileSnapshot(doc, next);
      return RESTORED;
    },
    follow(cb, restMs) {
      let rest: ReturnType<typeof setTimeout> | undefined;
      const changed = (): void => {
        clearTimeout(rest);
        rest = setTimeout(() => cb(read()), restMs);
      };
      doc.on("update", changed);
      return () => {
        clearTimeout(rest);
        doc.off("update", changed);
      };
    },
  };
}

/** one replacement in a shown text: `start` up to `end` (offsets in the text before the edit) becomes `text` */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * The edits that bring a shown text to `next` by its changed parts alone, so
 * whoever reads a read-only source keeps their place while a co-editor moves
 * an element. In the order an editor applies simultaneous edits (Monaco's
 * applyEdits): every range in the text before the edit, ascending, and two
 * inserts at one offset in the order given. diffHunks lists the same hunks
 * last first, for applying one after the other, and taken as they are, a
 * text written into an empty one would land after its own closing line break.
 */
export function textEdits(shown: string, next: string): TextEdit[] {
  return diffHunks(shown, next)
    .reverse()
    .map(({ at, deleteCount, insert }) => ({ start: at, end: at + deleteCount, text: insert }));
}
