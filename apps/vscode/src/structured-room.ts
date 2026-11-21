/**
 * The read-only lane for STRUCTURED rooms (a board): pure, no vscode API, so
 * the unit tests (src/test/unit/structured-room.test.ts) hold the file
 * system's rule.
 *
 * A structured room has no Y.Text: its content is the element maps
 * (@designiq/contracts/live ELEMENTS_KEY, META_KEY), and its file is the
 * notation's canonical codec text, the bytes git, the history and the
 * validator see. Binding a TextDocument to the room's CONTENT_KEY would show
 * an empty document and keep whatever is typed in a Y.Text the Live Host
 * never writes to the file. So VS Code shows such a room read-only, as its
 * canonical text, following the room, and points to the web app for edits.
 */
import { fileDeepLink } from "@designiq/contracts/deep-link";
import { ELEMENTS_KEY, META_KEY, roomName } from "@designiq/contracts/live";
import { readSnapshot } from "@designiq/live-client/structured";
import { byExtension } from "@designiq/notations";
import { type DocCodec, docCodecFor } from "@designiq/notations/codecs";
import type * as Y from "yjs";

/** how long a structured room rests before an open document re-reads it: a
 *  drag on the canvas changes the room many times a second */
export const FOLLOW_REST_MS = 200;

/** the codec of a structured room's file, resolved as the Live Host resolves
 *  it (apps/live-host domain/rooms.ts docCodecForPath); undefined for a text
 *  room, which keeps the two-way Y.Text binding */
export function structuredCodec(path: string): DocCodec | undefined {
  const notation = byExtension(path);
  return notation?.docShape === "structured" ? docCodecFor(notation.id) : undefined;
}

/** what a structured model is called in a message ("board"); "model" for a
 *  notation this build does not name */
export function structuredNoun(path: string): string {
  return byExtension(path)?.noun.singular ?? "model";
}

/** a structured room as text: the canonical encoding of its elements and
 *  meta. Whatever a client left in its CONTENT_KEY is not part of it. */
export function structuredText(doc: Y.Doc, codec: DocCodec): string {
  return codec.encode(readSnapshot(doc));
}

/** calls `onChange` once the room's elements and meta have rested `restMs`
 *  after a change; returns the stop */
export function followStructured(doc: Y.Doc, onChange: () => void, restMs = FOLLOW_REST_MS): () => void {
  const elements = doc.getMap(ELEMENTS_KEY);
  const meta = doc.getMap(META_KEY);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, restMs);
  };
  elements.observeDeep(changed);
  meta.observeDeep(changed);
  return () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    elements.unobserveDeep(changed);
    meta.unobserveDeep(changed);
  };
}

/**
 * The web app's editor of a room's file (`/r/<owner>/<repo>/f/<path>`), where
 * a read-only document is edited. A room name does not say where the repo
 * ends and the path begins (`<repo-full-name>/<path>`): the longest repo the
 * picker listed wins, otherwise the repo is `<owner>/<name>`, as on GitHub.
 */
export function webEditorLink(httpUrl: string, room: string, knownRepos: Iterable<string> = []): string {
  const known = [...knownRepos]
    .filter((repo) => room.startsWith(roomName(repo, "")))
    .sort((a, b) => b.length - a.length)[0];
  const segments = room.split("/");
  const repo = known ?? segments.slice(0, 2).join("/");
  const path = room.slice(repo.length + 1);
  return fileDeepLink(httpUrl, repo, path);
}
