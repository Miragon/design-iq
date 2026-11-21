/**
 * A live document as its file's text (src/lib/live-doc-text.ts), what the
 * History panel compares with and restores into: a text room's shared
 * Y.Text, or a structured room's element maps through the board's codec.
 * A structured restore goes in element by element and never touches
 * CONTENT_KEY, a co-editor's edit of another element survives it, a text
 * the strict reader refuses writes nothing, and a restore that changes
 * nothing writes nothing and says so. The source view follows the document
 * after a rest, by its changed parts alone, through Monaco's own text buffer.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { CONTENT_KEY, ELEMENTS_KEY } from "@designiq/contracts/live";
import { readSnapshot, reconcileSnapshot } from "@designiq/live-client/structured";
import { docCodecFor } from "@designiq/notations/codecs";
import * as Y from "yjs";

import { liveDocText, type TextEdit, textEdits } from "../src/lib/live-doc-text.ts";

const board = docCodecFor("board")!;

/** a live room's slice as a session hands it over */
function room(doc = new Y.Doc()) {
  return { doc, content: doc.getText(CONTENT_KEY) };
}

/** the updates `doc` emits while `run` runs */
function updatesDuring(doc: Y.Doc, run: () => void): number {
  let updates = 0;
  const count = (): void => void updates++;
  doc.on("update", count);
  try {
    run();
  } finally {
    doc.off("update", count);
  }
  return updates;
}

const NOTE = { kind: "node", type: "note", x: 0, y: 0, w: 200, h: 100, text: "Kick-off" };
const MODEL = { kind: "node", type: "model", x: 300, y: 0, w: 400, h: 300, file: "processes/order.bpmn" };
const BOARD_V1 = board.encode({ meta: { title: "Workshop", version: 1 }, elements: { n_a: NOTE, n_b: MODEL } });
const BOARD_V2 = board.encode({
  meta: { title: "Workshop", version: 1 },
  elements: { n_a: { ...NOTE, text: "Kick-off, moved", x: 40 }, n_c: { ...NOTE, text: "New" } },
});

/** a structured room holding `text` as the Live Host seeds it */
function boardRoom(text: string) {
  const live = room();
  reconcileSnapshot(live.doc, board.decode(text));
  return live;
}

test("a text room: the file's text is the shared Y.Text, and a restore writes it as a minimal diff", () => {
  const live = room();
  live.content.insert(0, "a\nb\nc\n");
  const text = liveDocText(live);
  assert.equal(text.read(), "a\nb\nc\n");
  const deltas: unknown[] = [];
  live.content.observe((event) => void deltas.push(event.delta));
  assert.deepEqual(text.restore("a\nB\nc\n"), { kind: "restored" });
  assert.equal(live.content.toString(), "a\nB\nc\n");
  // the one changed character, not the whole text: concurrent edits elsewhere merge
  assert.deepEqual(deltas, [[{ retain: 2 }, { delete: 1 }, { insert: "B" }]]);
  assert.equal(text.read(), "a\nB\nc\n");
});

test("a structured room: the file's text is the codec's canonical encode of the element maps", () => {
  const live = boardRoom(BOARD_V1);
  const text = liveDocText(live, board);
  assert.equal(text.read(), BOARD_V1);
  assert.equal(text.read(), board.encode(readSnapshot(live.doc)));
  // CONTENT_KEY is no part of it: a stale client's text there changes nothing
  live.content.insert(0, "junk");
  assert.equal(text.read(), BOARD_V1);
});

test("a structured restore brings the element maps to the version and leaves CONTENT_KEY alone", () => {
  const live = boardRoom(BOARD_V1);
  const text = liveDocText(live, board);
  assert.deepEqual(text.restore(BOARD_V2), { kind: "restored" });
  assert.equal(text.read(), BOARD_V2);
  assert.equal(live.content.length, 0, "nothing went into the text lane");
  const elements = live.doc.getMap<Y.Map<unknown>>(ELEMENTS_KEY);
  assert.deepEqual([...elements.keys()].sort(), ["n_a", "n_c"]);
  assert.equal(elements.get("n_a")?.get("text"), "Kick-off, moved");
});

test("a structured restore goes in element by element: a co-editor's concurrent edit of another element survives", () => {
  const ours = boardRoom(BOARD_V1);
  const theirs = room();
  Y.applyUpdate(theirs.doc, Y.encodeStateAsUpdate(ours.doc));
  // at the same time: we restore a version that moves n_a, they rename the model node's file
  const restoredAt = liveDocText(ours, board).restore(
    board.encode({ meta: { title: "Workshop", version: 1 }, elements: { n_a: { ...NOTE, x: 40 }, n_b: MODEL } }),
  );
  assert.deepEqual(restoredAt, { kind: "restored" });
  theirs.doc.getMap<Y.Map<unknown>>(ELEMENTS_KEY).get("n_b")?.set("file", "processes/billing.bpmn");
  Y.applyUpdate(ours.doc, Y.encodeStateAsUpdate(theirs.doc));
  Y.applyUpdate(theirs.doc, Y.encodeStateAsUpdate(ours.doc));
  const merged = readSnapshot(ours.doc);
  assert.equal(merged.elements.n_a?.x, 40, "the restore");
  assert.equal(merged.elements.n_b?.file, "processes/billing.bpmn", "their edit");
  assert.deepEqual(readSnapshot(theirs.doc), merged);
});

test("a structured restore of a text the strict reader refuses writes nothing and says why", () => {
  const live = boardRoom(BOARD_V1);
  const text = liveDocText(live, board);
  const repeated = `${BOARD_V2}${JSON.stringify({ id: "n_a", kind: "node", type: "note", text: "twice" })}\n`;
  for (const broken of [repeated, "this is no board\n"]) {
    let outcome;
    const updates = updatesDuring(live.doc, () => {
      outcome = text.restore(broken);
    });
    assert.deepEqual(outcome, { kind: "refused", reason: board.check!(broken) });
    assert.equal(updates, 0, broken);
    assert.equal(text.read(), BOARD_V1);
  }
  assert.match(board.check!(repeated)!, /repeats the element id n_a/);
});

test("a restore to the version the document already is writes nothing and says so", () => {
  const structured = boardRoom(BOARD_V1);
  const boardText = liveDocText(structured, board);
  let outcome;
  // the same board, written by hand in another key order: the same content
  const reordered = BOARD_V1.split("\n")
    .map((line) => (line ? JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(line)).reverse())) : line))
    .join("\n");
  assert.notEqual(reordered, BOARD_V1);
  for (const version of [BOARD_V1, reordered]) {
    assert.equal(
      updatesDuring(structured.doc, () => {
        outcome = boardText.restore(version);
      }),
      0,
    );
    assert.deepEqual(outcome, { kind: "unchanged" });
  }

  const plain = room();
  plain.content.insert(0, "same\n");
  const plainText = liveDocText(plain);
  assert.equal(
    updatesDuring(plain.doc, () => {
      outcome = plainText.restore("same\n");
    }),
    0,
  );
  assert.deepEqual(outcome, { kind: "unchanged" });
});

test("follow: the text once the document rested, one call for a burst of changes, none after the unsubscribe", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const live = boardRoom(BOARD_V1);
    const text = liveDocText(live, board);
    const seen: string[] = [];
    const stop = text.follow((t) => seen.push(t), 300);
    const elements = live.doc.getMap<Y.Map<unknown>>(ELEMENTS_KEY);
    elements.get("n_a")?.set("x", 10);
    mock.timers.tick(200);
    elements.get("n_a")?.set("x", 20);
    mock.timers.tick(299);
    assert.deepEqual(seen, [], "still moving");
    mock.timers.tick(1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], text.read());
    assert.equal(readSnapshot(live.doc).elements.n_a?.x, 20);

    // a change still waiting when the source goes is dropped with it
    elements.get("n_a")?.set("x", 30);
    stop();
    mock.timers.tick(1_000);
    elements.get("n_a")?.set("x", 40);
    mock.timers.tick(1_000);
    assert.equal(seen.length, 1);
  } finally {
    mock.timers.reset();
  }
});

/** a module of Monaco's own: plain ES modules without typings (a computed
 *  specifier, so tsc looks for none), typed by the slice used here */
const monacoModule = async <T>(path: string): Promise<T> => (await import(`monaco-editor/esm/vs/${path}`)) as T;

interface Position {
  lineNumber: number;
  column: number;
}
interface TextBuffer {
  getPositionAt(offset: number): Position;
  applyEdits(operations: unknown[], recordTrimAutoWhitespace: boolean, computeUndoEdits: boolean): unknown;
  getLinesContent(): string[];
}

/** `edits` applied the way the source's Monaco applies them: all at once, by
 *  the text buffer behind ITextModel.applyEdits (the pinned monaco-editor's) */
async function monacoApplies(): Promise<(shown: string, edits: TextEdit[]) => string> {
  const [{ createTextBuffer }, { ValidAnnotatedEditOperation }, { Range }] = await Promise.all([
    monacoModule<{
      createTextBuffer(value: string, defaultEOL: number): { textBuffer: TextBuffer; disposable: { dispose(): void } };
    }>("editor/common/model/textModel.js"),
    monacoModule<{
      ValidAnnotatedEditOperation: new (
        identifier: null,
        range: unknown,
        text: string,
        forceMoveMarkers: boolean,
        isAutoWhitespaceEdit: boolean,
        isTracked: boolean,
      ) => unknown;
    }>("editor/common/model.js"),
    monacoModule<{ Range: { fromPositions(start: Position, end: Position): unknown } }>("editor/common/core/range.js"),
  ]);
  return (shown, edits) => {
    const { textBuffer, disposable } = createTextBuffer(shown, 1 /* DefaultEndOfLine.LF */);
    textBuffer.applyEdits(
      edits.map(
        ({ start, end, text }) =>
          new ValidAnnotatedEditOperation(
            null,
            Range.fromPositions(textBuffer.getPositionAt(start), textBuffer.getPositionAt(end)),
            text,
            false,
            false,
            false,
          ),
      ),
      false,
      false,
    );
    const applied = textBuffer.getLinesContent().join("\n");
    disposable.dispose();
    return applied;
  };
}

test("textEdits bring the shown text to the next one as Monaco applies them, all at once, touching only what changed", async () => {
  const apply = await monacoApplies();
  const moved = board.encode({
    meta: { title: "Workshop", version: 1 },
    elements: { n_a: NOTE, n_b: { ...MODEL, x: 340 } },
  });
  const pairs: [string, string][] = [
    [BOARD_V1, BOARD_V2],
    [BOARD_V2, BOARD_V1],
    [BOARD_V1, moved],
    // the source opened on a room that had no elements yet, and the other way
    ["", BOARD_V1],
    [BOARD_V1, ""],
    // the closing line break apart from the changed middle: two edits
    [BOARD_V1.slice(0, -1), BOARD_V2],
    [BOARD_V1, `${BOARD_V1}\n\n`],
    ["", "\n"],
    ["a\nb", "a\nc\n\n"],
  ];
  for (const [shown, next] of pairs) {
    assert.equal(apply(shown, textEdits(shown, next)), next, JSON.stringify([shown, next]));
  }
  assert.deepEqual(textEdits(BOARD_V1, BOARD_V1), [], "nothing changed, nothing to apply");
  // a moved element changes its own line, and within it only the digit of x that changed (300 to 340)
  const [edit, ...more] = textEdits(BOARD_V1, moved);
  assert.deepEqual(more, []);
  assert.equal(BOARD_V1.slice(0, edit!.start).split("\n").length, 3, "the third line, n_b's");
  assert.equal(BOARD_V1.slice(edit!.start, edit!.end), "0");
  assert.equal(edit!.text, "4");
});
