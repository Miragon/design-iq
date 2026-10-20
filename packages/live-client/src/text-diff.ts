/**
 * Minimal-diff text writing — sync rule 2 from docs/platform-concept.md:
 * clients write minimal diffs into the shared Y.Text, never replace-all.
 * A full replace turns every concurrent remote edit into a conflict and
 * destroys remote cursor/selection positions; a minimal diff merges cleanly.
 */
import type * as Y from "yjs";

/** trim common prefix/suffix between two strings → the changed middle */
export function diffRegion(prev: string, next: string): { start: number; endPrev: number; endNext: number } {
  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  return { start, endPrev, endNext };
}

/** where the line breaks that close the text begin (its length when none do) */
export function closingBreaksAt(text: string): number {
  let end = text.length;
  while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  return end;
}

/** one replacement in a text: `deleteCount` characters at `at`, `insert` in their place */
export interface Hunk {
  at: number;
  deleteCount: number;
  insert: string;
}

/**
 * The minimal edit from `prev` to `next` as hunks, last first, so each one
 * applies at its own `at`: the changed middle, and apart from it a change
 * to the line breaks that close the text. A writer that adds the closing
 * line break a file lacks (or drops one) leaves the two texts no common
 * suffix, and one changed middle would run from the edit to the end of the
 * text. Two peers' concurrent edits would each replace that whole tail, and
 * the merge keeps both tails.
 */
export function diffHunks(prev: string, next: string): Hunk[] {
  const prevBody = closingBreaksAt(prev);
  const nextBody = closingBreaksAt(next);
  const prevClosing = prev.slice(prevBody);
  const nextClosing = next.slice(nextBody);
  const hunks: Hunk[] = [];
  const push = (at: number, deleteCount: number, insert: string): void => {
    if (deleteCount > 0 || insert !== "") hunks.push({ at, deleteCount, insert });
  };
  if (prevClosing === nextClosing) {
    const { start, endPrev, endNext } = diffRegion(prev, next);
    push(start, endPrev - start, next.slice(start, endNext));
    return hunks;
  }
  const closing = diffRegion(prevClosing, nextClosing);
  push(prevBody + closing.start, closing.endPrev - closing.start, nextClosing.slice(closing.start, closing.endNext));
  const { start, endPrev, endNext } = diffRegion(prev.slice(0, prevBody), next.slice(0, nextBody));
  push(start, endPrev - start, next.slice(start, endNext));
  return hunks;
}

/** writes hunks (as diffHunks orders them) into `ytext` — inside the caller's transaction */
export function applyHunks(ytext: Y.Text, hunks: readonly Hunk[]): void {
  for (const { at, deleteCount, insert } of hunks) {
    if (deleteCount > 0) ytext.delete(at, deleteCount);
    if (insert !== "") ytext.insert(at, insert);
  }
}

/**
 * Write `next` into `ytext` as a minimal diff (one transaction deleting and
 * inserting only the changed middle, and the closing line breaks apart from
 * it). No-op when the content already matches.
 */
export function updateText(ytext: Y.Text, next: string, origin?: unknown): void {
  const doc = ytext.doc;
  if (!doc) throw new Error("updateText requires a Y.Text attached to a Y.Doc");
  const prev = ytext.toString();
  if (prev === next) return;
  doc.transact(() => applyHunks(ytext, diffHunks(prev, next)), origin);
}
