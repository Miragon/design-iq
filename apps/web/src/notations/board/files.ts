/**
 * The files of a board, as the board asks its host for them. A board stores where a file sits,
 * never what is in it: a model it shows is a live document of that model's own, an image is a file
 * of the repository. In designIQ the answer comes from the shell (live-hub.ts), on the measuring
 * bench from an in-page stand-in (src/board-spike/model-hub.ts).
 *
 * Node-loadable: types only.
 */
import type { SyncOptions } from "@designiq/live-client";
import type * as Y from "yjs";

import type { BoardPresence } from "./presence.ts";

export type FileKind = "model" | "board" | "asset";

/** a file as the board lists it (the models it can show, the images it can link) */
export interface ListedFile {
  path: string;
  kind: FileKind;
  bytes: number;
  /** how often the file's text changed since the page loaded */
  version: number;
}

/** a live document of ONE model for ONE editor: never two bindings on one document */
export interface LinkedFile {
  readonly path: string;
  readonly doc: Y.Doc;
  /** the model's text, under CONTENT_KEY like in a room */
  readonly ytext: Y.Text;
  /**
   * Resolves once the text is there, rejects when it will not come (a live session that was
   * refused or timed out). Absent: the text is there already.
   */
  readonly ready?: Promise<void>;
  /** the live session's part of the canvas sync (its awareness), where the file is a live session */
  readonly sync?: SyncOptions;
  /**
   * The person edits the file here (true) or only looks at it (false): a host with a roster shows
   * them in the file's room only while they edit. Absent: the host has no roster.
   */
  present?(present: boolean): void;
  /**
   * Live presence in the FILE's own room, in the model's coordinates: the cursors and selections
   * of the people who edit that model, here or anywhere else. Absent: the host has none.
   */
  readonly presence?: BoardPresence;
  /**
   * The model lives at another path now: it was renamed or moved while the board had it open, or
   * the board names a path that is gone and exactly one model of that notation and name is
   * elsewhere. Whoever shows the file writes the new path into the board and opens it there.
   * Absent: the host's files never move.
   */
  onMoved?(listener: (to: string) => void): () => void;
  /** unlinks and destroys the document; call it after the editor's unbind */
  destroy(): void;
}

export interface BoardFiles {
  /** a new image can be stored (`addAsset`): false where images reach the repository another way */
  readonly uploads: boolean;
  /** a live document of the model at `path`, for one editor */
  replica(path: string): LinkedFile;
  /** the file's current text; undefined for a path the host does not know or does not hold right now */
  text(path: string): string | undefined;
  version(path: string): number;
  /** after every change of that file's text, whatever its origin */
  onChange(path: string, listener: () => void): () => void;
  /** after a change of the file list or of an image */
  onFiles(listener: () => void): () => void;
  files(): ListedFile[];
  /** the bytes of an image of the repository; undefined while it is not there (yet) */
  asset(path: string): Blob | undefined;
  addAsset(path: string, blob: Blob): void;
}
