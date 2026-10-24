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

/** `text` with hunks (as diffHunks orders them) applied, as applyHunks writes them */
export function patchText(text: string, hunks: readonly Hunk[]): string {
  let patched = text;
  for (const { at, deleteCount, insert } of hunks) {
    patched = patched.slice(0, at) + insert + patched.slice(at + deleteCount);
  }
  return patched;
}

/** the most lines a merge's diffs may change: a larger edit gives way rather than stall the canvas that drops it */
const MAX_LINE_EDITS = 1000;

/**
 * The text cut into lines, each led by the line break before it (CRLF or
 * LF). Without its closing line breaks (closingBreaksAt), the text then ends
 * on a line boundary: a line appended after the last one is an insertion,
 * not a change of that line.
 */
function linesOf(text: string): string[] {
  const lines: string[] = [];
  let from = 0;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
    const lineBreak = text[at - 1] === "\r" ? at - 1 : at;
    if (lineBreak === 0) continue;
    lines.push(text.slice(from, lineBreak));
    from = lineBreak;
  }
  if (from < text.length) lines.push(text.slice(from));
  return lines;
}

/** a changed run of a base text's lines, `start` up to `end` (equal: an insertion), and the lines in its place */
interface LineHunk {
  start: number;
  end: number;
  lines: readonly string[];
}

/**
 * Myers' O(ND) diff of two texts' lines (as ids), the common lines at both
 * ends trimmed first: the changed runs of `from`, in order, each with the
 * lines of `to` in its place. Undefined past MAX_LINE_EDITS changed lines.
 */
function lineHunks(from: readonly number[], to: readonly number[], toLines: readonly string[]): LineHunk[] | undefined {
  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) head++;
  let tail = 0;
  while (
    tail < from.length - head &&
    tail < to.length - head &&
    from[from.length - 1 - tail] === to[to.length - 1 - tail]
  ) {
    tail++;
  }
  const a = from.slice(head, from.length - tail);
  const b = to.slice(head, to.length - tail);
  const limit = Math.min(a.length + b.length, MAX_LINE_EDITS);
  const furthestXOnDiagonal = new Int32Array(2 * limit + 3).fill(-1);
  const center = limit + 1;
  furthestXOnDiagonal[center + 1] = 0;
  // a round overwrites the diagonals it reads, and the backtrack needs them as that round found them
  const diagonalsBeforeRound: Int32Array[] = [];
  const predecessorOffset = (furthestX: (k: number) => number, k: number): 1 | -1 | 0 => {
    const insertingFrom = furthestX(k + 1);
    const deletingFrom = furthestX(k - 1);
    const insertionFits = insertingFrom >= 0 && insertingFrom - k <= b.length;
    const deletionFits = deletingFrom >= 0 && deletingFrom + 1 <= a.length;
    if (insertionFits && (!deletionFits || insertingFrom >= deletingFrom + 1)) return 1;
    return deletionFits ? -1 : 0;
  };
  let edits = -1;
  for (let d = 0; d <= limit && edits < 0; d++) {
    diagonalsBeforeRound.push(furthestXOnDiagonal.slice(center - d - 1, center + d + 2));
    const furthestX = (k: number): number => furthestXOnDiagonal[center + k]!;
    for (let k = -d; k <= d; k += 2) {
      const offset = predecessorOffset(furthestX, k);
      if (offset === 0) {
        furthestXOnDiagonal[center + k] = -1;
        continue;
      }
      let x = offset === 1 ? furthestX(k + 1) : furthestX(k - 1) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++;
        y++;
      }
      furthestXOnDiagonal[center + k] = x;
      if (x === a.length && y === b.length) {
        edits = d;
        break;
      }
    }
  }
  if (edits < 0) return undefined;

  const sharedLines: Array<[number, number]> = [];
  let x = a.length;
  let y = b.length;
  for (let d = edits; d > 0; d--) {
    const round = diagonalsBeforeRound[d]!;
    const furthestX = (k: number): number => round[k + d + 1]!;
    const k = x - y;
    const offset = predecessorOffset(furthestX, k);
    const fromX = furthestX(k + offset);
    const fromY = fromX - (k + offset);
    const snakeStartX = offset === 1 ? fromX : fromX + 1;
    for (; x > snakeStartX; x--, y--) sharedLines.push([x - 1, y - 1]);
    x = fromX;
    y = fromY;
  }
  for (; x > 0; x--, y--) sharedLines.push([x - 1, y - 1]);
  sharedLines.reverse().push([a.length, b.length]);

  const hunks: LineHunk[] = [];
  let lastA = -1;
  let lastB = -1;
  for (const [atA, atB] of sharedLines) {
    if (atA > lastA + 1 || atB > lastB + 1) {
      hunks.push({ start: head + lastA + 1, end: head + atA, lines: toLines.slice(head + lastB + 1, head + atB) });
    }
    lastA = atA;
    lastB = atB;
  }
  return hunks;
}

/**
 * A three-way merge by lines: the changes `base` → `next` (a local edit)
 * placed into `current` (`base` with the changes that arrived meanwhile), as
 * hunks against `current`, last first (applyHunks). A change of the same
 * lines as one that arrived, or an insertion strictly inside one, is a
 * conflict (undefined); an insertion at its edge merges, and insertions at
 * the same point both go in, the arrived one first. A change both made alike
 * conflicts too: two moves of one shape delete the same line, and each
 * inserts its own. So do two changes that both start at the first line, an
 * empty text's included: no line break leads that line, so the change placed
 * second would run into the last line of the first. The local edit merges
 * whole or not at all: half of a canvas operation (a moved shape deleted
 * where it was, not inserted where it goes) is a model nobody made. Lines are
 * compared with the break before them, so `base`, `current` and `next` are
 * texts without their closing line breaks.
 */
export function mergeLines(base: string, current: string, next: string): Hunk[] | undefined {
  const ids = new Map<string, number>();
  const idsOf = (lines: readonly string[]): number[] =>
    lines.map((line) => {
      let id = ids.get(line);
      if (id === undefined) ids.set(line, (id = ids.size));
      return id;
    });
  const currentLines = linesOf(current);
  const nextLines = linesOf(next);
  const baseIds = idsOf(linesOf(base));
  const arrived = lineHunks(baseIds, idsOf(currentLines), currentLines);
  const local = lineHunks(baseIds, idsOf(nextLines), nextLines);
  if (!arrived || !local) return undefined;

  const lineAt = [0];
  for (const line of currentLines) lineAt.push(lineAt.at(-1)! + line.length);
  const hunks: Hunk[] = [];
  let before = 0;
  let shift = 0;
  const clash = (hunk: LineHunk, other: LineHunk): boolean =>
    (hunk.start < other.end && other.start < hunk.end) || (hunk.start === 0 && other.start === 0);
  for (const hunk of local) {
    if (arrived.some((other) => clash(hunk, other))) return undefined;
    for (; before < arrived.length && arrived[before]!.end <= hunk.start; before++) {
      const other = arrived[before]!;
      shift += other.lines.length - (other.end - other.start);
    }
    const from = hunk.start + shift;
    const at = lineAt[from]!;
    hunks.push({ at, deleteCount: lineAt[from + hunk.end - hunk.start]! - at, insert: hunk.lines.join("") });
  }
  return hunks.reverse();
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
