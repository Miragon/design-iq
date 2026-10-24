/**
 * diffRegion edge cases + updateText's minimal-diff guarantee: the write must
 * touch ONLY the changed middle (delete/insert on the diff region), never
 * replace the whole text — asserted by inspecting the Y.Text event delta.
 * mergeLines: a local edit merged line by line into a text a peer changed
 * meanwhile (#309), conflicting only where both changed the same lines.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { diffHunks, diffRegion, mergeLines, patchText, updateText } from "../src/text-diff.ts";

/* ── diffRegion ─────────────────────────────────────────────────────────── */

test("diffRegion: equal strings → empty region at the end", () => {
  assert.deepEqual(diffRegion("abc", "abc"), { start: 3, endPrev: 3, endNext: 3 });
});

test("diffRegion: both empty → empty region at 0", () => {
  assert.deepEqual(diffRegion("", ""), { start: 0, endPrev: 0, endNext: 0 });
});

test("diffRegion: empty prev → whole next is the insert", () => {
  assert.deepEqual(diffRegion("", "abc"), { start: 0, endPrev: 0, endNext: 3 });
});

test("diffRegion: empty next → whole prev is the delete", () => {
  assert.deepEqual(diffRegion("abc", ""), { start: 0, endPrev: 3, endNext: 0 });
});

test("diffRegion: pure insertion after common prefix", () => {
  // "ab" → "abc": common prefix "ab", nothing to delete, insert "c"
  assert.deepEqual(diffRegion("ab", "abc"), { start: 2, endPrev: 2, endNext: 3 });
});

test("diffRegion: change at the start keeps the common suffix", () => {
  // "Xbc" → "Ybc": suffix "bc" is trimmed, only index 0 differs
  assert.deepEqual(diffRegion("Xbc", "Ybc"), { start: 0, endPrev: 1, endNext: 1 });
});

test("diffRegion: middle change trims prefix and suffix", () => {
  const r = diffRegion("hello world", "hello brave world");
  assert.deepEqual(r, { start: 6, endPrev: 6, endNext: 12 });
  assert.equal("hello brave world".slice(r.start, r.endNext), "brave ");
});

/* ── diffHunks ──────────────────────────────────────────────────────────── */

test("diffHunks: the same closing line breaks → the one changed middle of diffRegion", () => {
  assert.deepEqual(diffHunks("a 1\nb 2\n", "a 1\nb 3\n"), [{ at: 6, deleteCount: 1, insert: "3" }]);
  assert.deepEqual(diffHunks("same", "same"), []);
});

test("diffHunks: a closing line break added or dropped is a hunk of its own at the end, last first", () => {
  assert.deepEqual(diffHunks('{"x": 1, "y": 2}', '{"x": 5, "y": 2}\n'), [
    { at: 16, deleteCount: 0, insert: "\n" },
    { at: 6, deleteCount: 1, insert: "5" },
  ]);
  assert.deepEqual(diffHunks("a\nb\n\n", "a\nc\n"), [
    { at: 4, deleteCount: 1, insert: "" },
    { at: 2, deleteCount: 1, insert: "c" },
  ]);
  assert.deepEqual(diffHunks("abc", "abc\r\n"), [{ at: 3, deleteCount: 0, insert: "\r\n" }]);
  assert.deepEqual(diffHunks("", "\n"), [{ at: 0, deleteCount: 0, insert: "\n" }]);
});

/* ── mergeLines ─────────────────────────────────────────────────────────── */

/** `current` with the local edit `base` → `next` merged in, or undefined for a conflict */
function merged(base: string, current: string, next: string): string | undefined {
  const hunks = mergeLines(base, current, next);
  return hunks && patchText(current, hunks);
}

/** a DI in the order bpmn-js writes it: a moved shape goes last */
const shape = (id: string, x: number): string => `  <shape id="${id}" x="${x}" />`;
const plane = (...shapes: string[]): string => ["<plane>", ...shapes, "</plane>"].join("\n");
const BASE_DI = plane(shape("a", 100), shape("b", 250), shape("c", 400));

test("mergeLines: a move whose shape is written last merges with a peer's move of the shape that was last", () => {
  const peerMovedC = plane(shape("a", 100), shape("b", 250), shape("c", 480));
  const localMovedA = plane(shape("b", 250), shape("c", 400), shape("a", 130));
  assert.equal(merged(BASE_DI, peerMovedC, localMovedA), plane(shape("b", 250), shape("c", 480), shape("a", 130)));
});

test("mergeLines: two moves that both write their shape last keep both, the peer's first", () => {
  const peerMovedB = plane(shape("a", 100), shape("c", 400), shape("b", 270));
  const localMovedA = plane(shape("b", 250), shape("c", 400), shape("a", 130));
  assert.equal(merged(BASE_DI, peerMovedB, localMovedA), plane(shape("c", 400), shape("b", 270), shape("a", 130)));
});

test("mergeLines: a new element after the one a peer moved merges, also after the text's last line", () => {
  const board = "title Tea\ncomponent Cup [0.79, 0.61]\ncomponent Kettle [0.43, 0.35]\nCup->Kettle";
  assert.equal(
    merged(
      board,
      board.replace("Kettle [0.43, 0.35]", "Kettle [0.50, 0.35]"),
      board.replace("Kettle [0.43, 0.35]", "Kettle [0.43, 0.35]\ncomponent Water [0.82, 0.78]"),
    ),
    "title Tea\ncomponent Cup [0.79, 0.61]\ncomponent Kettle [0.50, 0.35]\ncomponent Water [0.82, 0.78]\nCup->Kettle",
  );
  // a text without its closing line break ends on a line boundary: the append is no change of the last line
  assert.equal(merged("A 1\nB 1", "A 1\nB 2", "A 1\nB 1\nC 1"), "A 1\nB 2\nC 1");
});

test("mergeLines: edits of the same line conflict, and so does an insertion strictly inside the peer's changed lines", () => {
  assert.equal(merged("A 1\nB 1\nC 1", "A 1\nB 2\nC 1", "A 1\nB 3\nC 1"), undefined);
  assert.equal(merged("A\nB\nC\nD", "A\nX\nD", "A\nB\nnew\nC\nD"), undefined, "inside the peer's B, C → X");
  assert.equal(merged("A\nB\nC\nD", "A\nX\nD", "A\nnew\nB\nC\nD"), "A\nnew\nX\nD", "at its start: before it");
  assert.equal(merged("A\nB\nC\nD", "A\nX\nD", "A\nB\nC\nnew\nD"), "A\nX\nnew\nD", "at its end: after it");
});

test("mergeLines: a local edit merges whole or not at all", () => {
  // the move deletes A's line where it was and inserts it last; the peer changed the line it deletes
  assert.equal(merged("A 1\nB 1\nC 1", "A 2\nB 1\nC 1", "B 1\nC 1\nA 5"), undefined);
});

test("mergeLines: two moves of one shape conflict, also when both made it alike; no change merges as no hunk", () => {
  const movedA = (x: number): string => plane(shape("b", 250), shape("c", 400), shape("a", x));
  assert.equal(merged(BASE_DI, movedA(160), movedA(130)), undefined, "not two shapes for a, one from each");
  assert.equal(merged(BASE_DI, movedA(130), movedA(130)), undefined);
  assert.deepEqual(mergeLines("A 1\nB 1", "A 2\nB 1", "A 1\nB 1"), []);
});

test("mergeLines: CRLF lines merge like LF lines; the hunks touch only the local edit's lines", () => {
  const base = "A 1\r\nB 1\r\nC 1";
  assert.equal(merged(base, "A 1\r\nB 1\r\nC 2", "A 9\r\nB 1\r\nC 1\r\nD 1"), "A 9\r\nB 1\r\nC 2\r\nD 1");
  assert.deepEqual(mergeLines(base, "A 1\r\nB 1\r\nC 2", "A 9\r\nB 1\r\nC 1\r\nD 1"), [
    { at: 13, deleteCount: 0, insert: "\r\nD 1" },
    { at: 0, deleteCount: 3, insert: "A 9" },
  ]);
});

test("mergeLines: a diff of more than 1000 changed lines gives way rather than stall the drop", () => {
  const base = Array.from({ length: 1200 }, (_, index) => `line ${index}`).join("\n");
  // apart from the peer's appended line, so only the size makes it give way
  assert.equal(merged(base, `${base}\nappended`, base.replaceAll("line", "row")), undefined);
  assert.equal(
    merged(base, base.replace("line 0\n", "line zero\n"), base.replace("line 600\n", "line 600 moved\n")),
    base.replace("line 0\n", "line zero\n").replace("line 600\n", "line 600 moved\n"),
  );
});

/* ── updateText ─────────────────────────────────────────────────────────── */

interface DeltaOp {
  retain?: number;
  insert?: string;
  delete?: number;
}

function makeYText(initial: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, initial);
  const deltas: DeltaOp[][] = [];
  const origins: unknown[] = [];
  ytext.observe((event, tx) => {
    deltas.push(event.delta as DeltaOp[]);
    origins.push(tx.origin);
  });
  return { doc, ytext, deltas, origins };
}

const sum = (ops: DeltaOp[], pick: (op: DeltaOp) => number) => ops.reduce((n, op) => n + pick(op), 0);
const deleted = (ops: DeltaOp[]) => sum(ops, (op) => op.delete ?? 0);
const inserted = (ops: DeltaOp[]) => sum(ops, (op) => op.insert?.length ?? 0);

test("updateText: insertion in the middle retains the prefix — no full replace", () => {
  const { ytext, deltas } = makeYText("hello world");
  updateText(ytext, "hello brave world");

  assert.equal(ytext.toString(), "hello brave world");
  assert.equal(deltas.length, 1);
  const ops = deltas[0]!;
  // minimal diff: keep "hello " (retain 6), insert "brave ", delete nothing
  assert.equal(ops[0]?.retain, 6, `expected a leading retain, got ${JSON.stringify(ops)}`);
  assert.equal(deleted(ops), 0, "pure insertion must not delete anything");
  assert.equal(inserted(ops), "brave ".length);
});

test("updateText: replacement touches only the changed middle", () => {
  const { ytext, deltas } = makeYText("aaaBBBccc");
  updateText(ytext, "aaaXXccc");

  assert.equal(ytext.toString(), "aaaXXccc");
  const ops = deltas[0]!;
  // full replace would be delete 9 / insert 8 with no retain
  assert.equal(ops[0]?.retain, 3, `expected a leading retain, got ${JSON.stringify(ops)}`);
  assert.equal(deleted(ops), 3, "only the changed middle may be deleted");
  assert.equal(inserted(ops), 2, "only the changed middle may be inserted");
});

test("updateText: pure deletion keeps prefix and suffix", () => {
  const { ytext, deltas } = makeYText("hello brave world");
  updateText(ytext, "hello world");

  assert.equal(ytext.toString(), "hello world");
  const ops = deltas[0]!;
  assert.equal(ops[0]?.retain, 6, `expected a leading retain, got ${JSON.stringify(ops)}`);
  assert.equal(deleted(ops), "brave ".length);
  assert.equal(inserted(ops), 0, "pure deletion must not insert anything");
});

test("updateText: adding the closing line break keeps the edit's region local, not a replace to the end", () => {
  const prev = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}';
  const { ytext, deltas } = makeYText(prev);
  updateText(ytext, prev.replace('"a": 1', '"a": 7') + "\n");

  assert.equal(ytext.toString(), '{\n  "a": 7,\n  "b": 2,\n  "c": 3\n}\n');
  assert.equal(deltas.length, 1, "one transaction");
  const ops = deltas[0]!;
  assert.equal(deleted(ops), 1, `only the changed digit is deleted, got ${JSON.stringify(ops)}`);
  assert.equal(inserted(ops), 2, "the new digit and the line break");
});

test("updateText: equal content is a no-op — no transaction fired", () => {
  const { ytext, deltas } = makeYText("same");
  updateText(ytext, "same");
  assert.equal(ytext.toString(), "same");
  assert.equal(deltas.length, 0, "no observer round for a no-op write");
});

test("updateText: empty → content and content → empty", () => {
  const a = makeYText("");
  updateText(a.ytext, "fresh");
  assert.equal(a.ytext.toString(), "fresh");

  const b = makeYText("gone");
  updateText(b.ytext, "");
  assert.equal(b.ytext.toString(), "");
  assert.equal(deleted(b.deltas[0]!), 4);
});

test("updateText: tags the transaction with the given origin", () => {
  const { ytext, origins } = makeYText("hello world");
  updateText(ytext, "hello there world", "my-origin");
  assert.deepEqual(origins, ["my-origin"]);
});

test("updateText: a Y.Text without a doc is rejected", () => {
  const detached = new Y.Text("x");
  assert.throws(() => updateText(detached, "y"), /attached to a Y.Doc/);
});
