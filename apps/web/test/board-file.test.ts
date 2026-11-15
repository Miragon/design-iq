/**
 * The board's board FILE as an artifact of a Git repository (src/notations/board/board-doc.ts,
 * board-actions.ts): what it looks like at rest, what a 3-way merge of two branches does with it
 * (`git merge-file` on the serialised text), and what two peers on one live document leave in it.
 * No browser. Run by hand:
 *
 *   node --test apps/web/test/board-file.test.ts
 *
 * Several cases RECORD TODAY'S BEHAVIOUR, a defect included (marked "today:"): a dangling
 * reference in the file, a node that jumps, an edit that is lost without a notice. They are pinned
 * so that a fix shows up here as a failing line that has to be turned around, not so that they stay.
 *
 * With OUT_DIR set the measured rows are also written to <OUT_DIR>/board-file.json.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { fractionalIndexBetween, jsonLinesCodec } from "@designiq/notations/codecs";
import * as Y from "yjs";

import {
  absoluteBoxes,
  addArrow,
  addGroupAround,
  addNode,
  writeDrop,
  writeNoteColor,
  writeRemoval,
} from "../src/notations/board/board-actions.ts";
import {
  type BoardSnapshot,
  type BoardStore,
  boardText,
  createBoardDoc,
  createBoardStore,
  newId,
  type NodeAttrs,
  writeGeometry,
} from "../src/notations/board/board-doc.ts";

// ── the board the cases run on ───────────────────────────────────────────────

let z: string | undefined;
const node = (attrs: Partial<NodeAttrs>): NodeAttrs => ({
  kind: "node",
  type: "text",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  z: (z = fractionalIndexBetween(z)),
  ...attrs,
});
/**
 * A group at 1000,0 holding a model node and a note; two notes and an image outside; one arrow.
 * At rest its lines are, in this order: arrow, group, image, inside, model, note, other.
 */
const SEED: BoardSnapshot = {
  meta: { title: "Board file", version: 1 },
  elements: {
    group: node({ type: "group", x: 1000, y: 0, width: 800, height: 600, text: "Group" }),
    model: node({ type: "model", file: "processes/a.bpmn", parent: "group", x: 40, y: 60, width: 400, height: 300 }),
    inside: node({ parent: "group", x: 500, y: 60, text: "inside" }),
    note: node({ x: 0, y: 0, text: "first line\nsecond line" }),
    other: node({ x: 0, y: 300, text: "other" }),
    image: node({ type: "image", file: "assets/a.png", x: 300, y: 300 }),
    arrow: { kind: "edge", source: "note", target: "model", sourceHandle: "right", targetHandle: "left" },
  },
};
const board = (seed: BoardSnapshot | string = SEED): BoardStore => createBoardStore(createBoardDoc(seed));
const BASE = board().text();

type Row = Record<string, unknown>;
const rowsOf = (text: string): Row[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(1)
    .map((line) => JSON.parse(line) as Row);
const rowOf = (text: string, id: string): Row | undefined => rowsOf(text).find((row) => row.id === id);

/** references of the FILE that point at nothing: an arrow's end, a node's group */
function dangling(text: string): string[] {
  const rows = rowsOf(text);
  const nodes = new Map(rows.filter((row) => row.kind === "node").map((row) => [String(row.id), row]));
  const found: string[] = [];
  for (const row of rows) {
    if (row.kind === "edge") {
      for (const end of ["source", "target"]) {
        if (!nodes.has(String(row[end]))) found.push(`${String(row.id)}.${end}`);
      }
    } else if (row.parent !== undefined && nodes.get(String(row.parent))?.type !== "group") {
      found.push(`${String(row.id)}.parent`);
    }
  }
  return found;
}

/**
 * "Delete" as the board's UI does it: React Flow removes the nodes, their members and every arrow
 * at one of them (getElementsToRemove), and board-flow.tsx hands that list to writeRemoval.
 */
function uiDelete(store: BoardStore, ids: readonly string[]): void {
  const view = store.getSnapshot();
  const gone = new Set(ids);
  for (let grew = true; grew;) {
    grew = false;
    for (const one of view.nodes) {
      if (one.parentId !== undefined && gone.has(one.parentId) && !gone.has(one.id)) {
        gone.add(one.id);
        grew = true;
      }
    }
  }
  const arrows = view.edges.filter((edge) => gone.has(edge.attrs.source) || gone.has(edge.attrs.target));
  writeRemoval(
    store,
    [...gone],
    arrows.map((edge) => edge.id),
  );
}

// ── what the cases measured, for a script that wants the numbers ─────────────

const measured: Array<Record<string, unknown>> = [];
after(() => {
  if (!process.env.OUT_DIR) return;
  mkdirSync(process.env.OUT_DIR, { recursive: true });
  writeFileSync(join(process.env.OUT_DIR, "board-file.json"), `${JSON.stringify(measured, null, 2)}\n`);
});

// ── the file at rest ─────────────────────────────────────────────────────────

test("at rest: a header and one line per element, and load then serialise gives the same bytes", () => {
  const lines = BASE.split("\n");
  assert.equal(lines.length, 1 + 7 + 1, "a header, seven elements, and the empty string after the last newline");
  assert.ok(BASE.endsWith("}\n") && !BASE.includes("\r"));
  assert.deepEqual(
    rowsOf(BASE).map((row) => row.id),
    ["arrow", "group", "image", "inside", "model", "note", "other"],
    "sorted by id, arrows among the nodes",
  );
  // load and serialise, in the document and in the codec alone
  assert.equal(boardText(createBoardDoc(BASE)), BASE);
  assert.equal(jsonLinesCodec().encode(jsonLinesCodec().decode(BASE)), BASE);
  // and the same through a peer's replica: the bytes do not depend on which client wrote them
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(createBoardDoc(BASE)));
  assert.equal(boardText(replica), BASE);

  // a text with everything a line could break on stays ONE line and comes back as it was
  const store = board();
  const text = 'tab\there, "quotes", back\\slash, CR\r\nLF, U+2028  and U+2029 , emoji \u{1F600}, umlaut ü';
  store.gesture((tx) => tx.update("note", { text }));
  const written = store.text();
  assert.equal(written.split("\n").length, BASE.split("\n").length, "still one line per element");
  assert.equal(rowOf(written, "note")?.text, text);
  assert.equal(boardText(createBoardDoc(written)), written);
  // every coordinate the actions write is an integer
  writeDrop(store, { other: { x: 10.49, y: -0.4 } });
  writeGeometry(store, { image: { x: 1.5, y: 2.5, width: 99.6, height: 50.2 } });
  const [other, image] = [rowOf(store.text(), "other"), rowOf(store.text(), "image")];
  assert.deepEqual([other?.x, other?.y, image?.x, image?.y, image?.width, image?.height], [10, 0, 2, 3, 100, 50]);
  assert.ok(!/-0[,}]/.test(store.text()), "no negative zero in the file");
  measured.push({
    part: "file",
    case: "load and serialise",
    bytes: Buffer.byteLength(BASE),
    lines: lines.length - 1,
    identical: true,
  });
  store.destroy();
});

test("a file that is not in the canonical form is read, and rewritten whole by the next save", () => {
  const codec = jsonLinesCodec();
  const canonical = BASE.split("\n").filter((line) => line !== "");
  // Windows line ends: read (a trailing CR is white space to JSON.parse), written back with LF
  const crlf = `${canonical.join("\r\n")}\r\n`;
  assert.equal(codec.encode(codec.decode(crlf)), BASE);
  const crlfDiffer = crlf.split("\n").filter((line, index) => line !== BASE.split("\n")[index]).length;
  // a blank line between the elements: read, and gone after a save
  const spaced = `${canonical.join("\n\n")}\n`;
  assert.equal(codec.encode(codec.decode(spaced)), BASE);
  // pretty key order of a hand edit ("id" first): read, and that line changes on the next save
  const hand = BASE.replace(/^\{"height":100,"id":"other",/m, '{"id":"other","height":100,');
  assert.notEqual(hand, BASE);
  assert.equal(codec.encode(codec.decode(hand)), BASE);
  // a line that is no JSON is DROPPED without a word: the element is gone after the next save
  const broken = BASE.replace(/^\{"height":100,"id":"other",.*$/m, '{"height":100,"id":"other",');
  const saved = codec.encode(codec.decode(broken));
  assert.equal(rowOf(saved, "other"), undefined, "today: the broken line's element is lost silently");
  assert.equal(rowsOf(saved).length, 6);
  // two lines with one id (a bad merge): the later one wins, without a word
  const twice = `${BASE}${JSON.stringify({ ...rowOf(BASE, "other"), x: 999 })}\n`;
  assert.equal(rowOf(codec.encode(codec.decode(twice)), "other")?.x, 999);
  measured.push({
    part: "file",
    case: "not canonical",
    crlfLinesThatDiffer: crlfDiffer,
    ofLines: canonical.length,
    blankSeparatedIsRead: true,
    brokenLineDropsItsElement: true,
    duplicateIdLaterLineWins: true,
  });
});

test("adding and removing leaves every other line as it is and where it is; undo restores the bytes", () => {
  const store = board();
  const kept = (text: string): string[] => text.split("\n").filter((line) => BASE.split("\n").includes(line));
  // twenty new elements under random ids land between the old lines, which keep their order
  const added: string[] = [];
  for (let index = 0; index < 20; index++) {
    added.push(addNode(store, { type: "text", width: 200, height: 100, text: `n${index}` }, { x: index, y: 2000 }));
  }
  assert.deepEqual(kept(store.text()), BASE.split("\n"), "the old lines, byte for byte and in their order");
  for (const id of added) store.gesture((tx) => tx.remove(id));
  assert.equal(store.text(), BASE, "added and removed again: the same bytes");

  // delete a node with its arrow, as the UI does; one undo brings both lines back where they were
  uiDelete(store, ["note"]);
  assert.deepEqual(
    rowsOf(store.text()).map((row) => row.id),
    ["group", "image", "inside", "model", "other"],
  );
  store.undo.undo();
  assert.equal(store.text(), BASE);
  // a group with its members and the arrow at one of them: four lines go, one undo restores them
  uiDelete(store, ["group"]);
  assert.deepEqual(
    rowsOf(store.text()).map((row) => row.id),
    ["image", "note", "other"],
  );
  store.undo.undo();
  assert.equal(store.text(), BASE);
  // a drop at the place the node has already is an update on the wire and an undo step, and no
  // change of the file; an attribute removed that was not there is not even an update
  let updates = 0;
  store.doc.on("update", () => updates++);
  writeDrop(store, { note: { x: 0, y: 0 } });
  assert.equal(updates, 1, "today: x and y are written, changed or not");
  writeNoteColor(store, "note", "plain");
  assert.equal(updates, 1);
  assert.equal(store.text(), BASE);
  measured.push({ part: "file", case: "order and undo", undoRestoresBytes: true, updatesOfADropAtTheSamePlace: 1 });
  store.destroy();
});

// ── a 3-way merge of two branches, as Git does it ────────────────────────────

const hasGit = ((): boolean => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

interface Merged {
  conflicts: number;
  text: string;
}

/** `git merge-file` of two branches' texts over their common base; `union` is the gitattributes driver of that name */
function mergeFile(dir: string, ours: string, base: string, theirs: string, union = false): Merged {
  const paths = ["ours", "base", "theirs"].map((name) => join(dir, name));
  [ours, base, theirs].forEach((text, index) => writeFileSync(paths[index]!, text));
  try {
    const text = execFileSync("git", ["merge-file", "-p", ...(union ? ["--union"] : []), ...paths], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { conflicts: 0, text };
  } catch (error) {
    // the exit status is the number of conflicts; anything else is no merge at all
    const failed = error as { status?: number; stdout?: string };
    if (typeof failed.status !== "number" || failed.status < 1 || failed.status > 126) throw error;
    return { conflicts: failed.status, text: failed.stdout ?? "" };
  }
}

/** a branch: the base board with `edit` applied through the action layer */
function branch(edit: (store: BoardStore) => void, base = BASE): string {
  const store = board(base);
  edit(store);
  const text = store.text();
  store.destroy();
  return text;
}
const lineIndex = (text: string, id: string): number => rowsOf(text).findIndex((row) => row.id === id);
/** the gap a new id's line falls into: 0 is before the first element line */
const gapOf = (base: string, id: string): number => rowsOf(base).filter((row) => String(row.id) < id).length;
/** the same file with an empty line between the elements, which today's reader already takes */
const spaced = (text: string): string =>
  `${text
    .split("\n")
    .filter((line) => line !== "")
    .join("\n\n")}\n`;

test("git merge-file: two branches that each change the board", { skip: !hasGit && "git is not installed" }, () => {
  const dir = mkdtempSync(join(process.env.OUT_DIR ?? tmpdir(), "board-merge-"));
  try {
    const nodes = ["group", "image", "inside", "model", "note", "other"];
    const move = (id: string, by: number) => (store: BoardStore) => {
      const row = rowOf(store.text(), id);
      writeDrop(store, { [id]: { x: Number(row?.x) + by, y: Number(row?.y) + by } });
    };

    // 1. each branch moves a DIFFERENT node: a conflict exactly when their lines are neighbours
    let [clean, conflicted, cleanSpaced] = [0, 0, 0];
    for (const [index, first] of nodes.entries()) {
      for (const second of nodes.slice(index + 1)) {
        const [ours, theirs] = [branch(move(first, 10)), branch(move(second, 20))];
        const merged = mergeFile(dir, ours, BASE, theirs);
        const neighbours = Math.abs(lineIndex(BASE, first) - lineIndex(BASE, second)) === 1;
        assert.equal(merged.conflicts > 0, neighbours, `${first} and ${second}: conflict iff neighbouring lines`);
        if (merged.conflicts > 0) conflicted++;
        else {
          clean++;
          const [a, b] = [rowOf(merged.text, first), rowOf(merged.text, second)];
          assert.deepEqual([a?.x, b?.x], [rowOf(ours, first)?.x, rowOf(theirs, second)?.x], "both moves are in");
          assert.equal(boardText(createBoardDoc(merged.text)), merged.text, "and the merge result is canonical");
        }
        // with an empty line between the elements Git merges neighbours too
        const wide = mergeFile(dir, spaced(ours), spaced(BASE), spaced(theirs));
        assert.equal(wide.conflicts, 0);
        assert.equal(boardText(createBoardDoc(wide.text)), branch(move(second, 20), ours));
        cleanSpaced++;
      }
    }
    assert.deepEqual([clean, conflicted], [10, 5], "of the 15 pairs of this board, the 5 neighbours conflict");
    measured.push({ part: "merge", case: "each moves a different node", pairs: 15, clean, conflicted, cleanSpaced });

    // 2. each branch ADDS a node (random ids): a conflict exactly when both lines fall into one gap
    const TRIALS = 120;
    let [addClean, addConflict, addConflictSpaced] = [0, 0, 0];
    for (let trial = 0; trial < TRIALS; trial++) {
      const add = (label: string) => (store: BoardStore) =>
        void addNode(store, { type: "text", width: 200, height: 100, text: label }, { x: 500, y: 900 });
      const [ours, theirs] = [branch(add("A")), branch(add("B"))];
      const idOf = (text: string): string =>
        String(rowsOf(text).find((row) => rowOf(BASE, String(row.id)) === undefined)?.id);
      const sameGap = gapOf(BASE, idOf(ours)) === gapOf(BASE, idOf(theirs));
      const merged = mergeFile(dir, ours, BASE, theirs);
      assert.equal(merged.conflicts > 0, sameGap, "two new lines: conflict iff they fall into the same gap");
      if (merged.conflicts > 0) addConflict++;
      else {
        addClean++;
        assert.equal(rowsOf(merged.text).length, 9);
        assert.equal(boardText(createBoardDoc(merged.text)), merged.text);
      }
      // the empty line does not help here: both branches insert at the same place
      if (mergeFile(dir, spaced(ours), spaced(BASE), spaced(theirs)).conflicts > 0) addConflictSpaced++;
    }
    assert.equal(addConflictSpaced, addConflict);
    // every new node id starts with "n_" and so falls between "model" and "note": ONE gap of this board
    assert.equal(addConflict, TRIALS, "today: on this board every pair of new nodes conflicts");
    measured.push({
      part: "merge",
      case: "each adds a node",
      trials: TRIALS,
      clean: addClean,
      conflicted: addConflict,
      conflictedSpaced: addConflictSpaced,
      why: 'all node ids begin with "n_": the new lines of both branches sort into the same gap of a board whose other ids do not',
    });

    // 2b. the same on a board whose ids are all random, as a board built by hand in the UI has them
    const randomSeed: BoardSnapshot = { meta: SEED.meta, elements: {} };
    for (let index = 0; index < 12; index++) randomSeed.elements[newId("n")] = node({ x: index * 240, y: 1200 });
    const randomBase = board(randomSeed).text();
    let [randomClean, randomConflict] = [0, 0];
    for (let trial = 0; trial < TRIALS; trial++) {
      const add = (label: string) => (store: BoardStore) =>
        void addNode(store, { type: "text", width: 200, height: 100, text: label }, { x: 500, y: 900 });
      const [ours, theirs] = [branch(add("A"), randomBase), branch(add("B"), randomBase)];
      const idOf = (text: string): string =>
        String(rowsOf(text).find((row) => rowOf(randomBase, String(row.id)) === undefined)?.id);
      const sameGap = gapOf(randomBase, idOf(ours)) === gapOf(randomBase, idOf(theirs));
      const merged = mergeFile(dir, ours, randomBase, theirs);
      assert.equal(merged.conflicts > 0, sameGap);
      if (merged.conflicts > 0) randomConflict++;
      else randomClean++;
    }
    measured.push({
      part: "merge",
      case: "each adds a node, board of 12 random ids",
      trials: TRIALS,
      clean: randomClean,
      conflicted: randomConflict,
      // two random points fall into the same of the n + 1 gaps between n random points with probability 2 / (n + 2)
      expectedShare: "2 of 14 on average over boards of 12 random ids",
    });

    // 3. ONE node, two attributes: a move in one branch, a colour in the other. The live document
    //    merges them (board-doc.test.ts); Git sees one line changed twice
    const sameLine = mergeFile(
      dir,
      branch(move("note", 10)),
      BASE,
      branch((store) => writeNoteColor(store, "note", "amber")),
    );
    assert.equal(sameLine.conflicts, 1);

    // 4. a node deleted in one branch and moved in the other: a conflict, as it should be
    const deleted = branch((store) => uiDelete(store, ["other"]));
    assert.equal(mergeFile(dir, deleted, BASE, branch(move("other", 10))).conflicts, 1);

    // 5. a node deleted in one branch, an arrow drawn to it in the other: Git merges it cleanly and
    //    the merged file holds an arrow to nothing
    const arrowTo = branch(
      (store) => void addArrow(store, { node: "image", side: "left" }, { node: "other", side: "right" }),
    );
    const danglingArrow = mergeFile(dir, deleted, BASE, arrowTo);
    assert.equal(danglingArrow.conflicts, 0);
    assert.equal(dangling(danglingArrow.text).length, 1, "today: a clean merge with a dangling arrow in the file");
    const loaded = board(danglingArrow.text);
    assert.equal(loaded.getSnapshot().edges.length, 1, "the board draws the one arrow that has both ends");
    assert.equal(
      rowsOf(loaded.text()).filter((row) => row.kind === "edge").length,
      2,
      "and keeps the other in the file",
    );
    loaded.destroy();

    // 6. a group deleted with its members in one branch, a node dropped into it in the other: clean,
    //    and the node names a group that is gone and stands at its group-relative place
    const groupGone = branch((store) => uiDelete(store, ["group"]));
    const joined = branch((store) => writeDrop(store, { other: { x: 1300, y: 400 } }));
    assert.deepEqual(absoluteBoxes(board(joined).getSnapshot()).get("other"), {
      x: 1300,
      y: 400,
      width: 200,
      height: 100,
    });
    const orphan = mergeFile(dir, groupGone, BASE, joined);
    assert.equal(orphan.conflicts, 0);
    assert.deepEqual(dangling(orphan.text), ["other.parent"], "today: a clean merge with a dangling group in the file");
    assert.deepEqual(
      absoluteBoxes(board(orphan.text).getSnapshot()).get("other"),
      { x: 300, y: 400, width: 200, height: 100 },
      "today: the node jumps by the group's origin (1000, 0)",
    );

    // 7. the `union` driver would merge every case above without a conflict, and loses a change:
    //    two neighbouring lines changed, both versions of both lines kept, the later line of an id wins
    const [ours, theirs] = [branch(move("inside", 10)), branch(move("model", 20))];
    const union = mergeFile(dir, ours, BASE, theirs, true);
    assert.equal(union.conflicts, 0);
    assert.equal(rowsOf(union.text).length, 9, "two ids are in the file twice");
    const afterUnion = rowsOf(boardText(createBoardDoc(union.text)));
    const kept = [afterUnion.find((row) => row.id === "inside")?.x, afterUnion.find((row) => row.id === "model")?.x];
    assert.notDeepEqual(kept, [510, 60], "not both moves");
    measured.push({
      part: "merge",
      case: "semantics",
      sameNodeTwoAttributes: "conflict",
      deleteAgainstMove: "conflict",
      deleteAgainstArrowToIt: `clean, dangling ${dangling(danglingArrow.text).join(",")}`,
      groupDeleteAgainstNewMember: `clean, dangling ${dangling(orphan.text).join(",")}, node jumps by the group's origin`,
      unionDriver: `no conflict, and after loading inside.x / model.x are ${kept.join(" / ")} of 510 / 60: a move is lost`,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── two peers on one live document ───────────────────────────────────────────

/**
 * Two clients of one board with the link held: what each writes meanwhile is concurrent. Yjs lets
 * the HIGHER client id win a key both wrote, so every case runs once with each peer as the higher.
 */
function peers(aIsHigher: boolean) {
  const RELAYED = Symbol("relayed");
  const state = Y.encodeStateAsUpdate(createBoardDoc(SEED));
  const client = (clientID: number): Y.Doc => {
    const doc = new Y.Doc();
    doc.clientID = clientID;
    Y.applyUpdate(doc, state, RELAYED);
    return doc;
  };
  const [a, b] = [client(aIsHigher ? 2 : 1), client(aIsHigher ? 1 : 2)];
  let held: Array<() => void> | undefined;
  const relay = (from: Y.Doc, to: Y.Doc): void => {
    from.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === RELAYED) return;
      const deliver = (): void => Y.applyUpdate(to, update, RELAYED);
      if (held) held.push(deliver);
      else deliver();
    });
  };
  relay(a, b);
  relay(b, a);
  return {
    a: createBoardStore(a),
    b: createBoardStore(b),
    hold: () => void (held = []),
    release: () => {
      const queued = held ?? [];
      held = undefined;
      for (const deliver of queued) deliver();
    },
  };
}

interface PeerCase {
  name: string;
  a(store: BoardStore): void;
  b(store: BoardStore): void;
  /** what the synced board has to look like; `winner` is the peer with the higher client id */
  check(store: BoardStore, winner: "a" | "b"): { outcome: string; lost: string; verdict: string };
}

const placeOf = (store: BoardStore, id: string): [number, number] | undefined => {
  const box = absoluteBoxes(store.getSnapshot()).get(id);
  return box && [box.x, box.y];
};

const PEER_CASES: PeerCase[] = [
  {
    name: "both move different nodes",
    a: (store) => writeDrop(store, { note: { x: 10, y: 20 } }),
    b: (store) => writeDrop(store, { other: { x: 30, y: 340 } }),
    check(store) {
      assert.deepEqual(
        [placeOf(store, "note"), placeOf(store, "other")],
        [
          [10, 20],
          [30, 340],
        ],
      );
      return { outcome: "both moves are in", lost: "nothing", verdict: "ok" };
    },
  },
  {
    name: "both move the same node",
    a: (store) => writeDrop(store, { note: { x: 111, y: 222 } }),
    b: (store) => writeDrop(store, { note: { x: 555, y: 100 } }),
    check(store, winner) {
      assert.deepEqual(placeOf(store, "note"), winner === "a" ? [111, 222] : [555, 100], "one peer's place, whole");
      return {
        outcome: `${winner}'s place, x and y of one peer`,
        lost: "the other peer's move, without a notice",
        verdict: "ok",
      };
    },
  },
  {
    name: "one deletes a node the other moves",
    a: (store) => uiDelete(store, ["note"]),
    b: (store) => writeDrop(store, { note: { x: 40, y: 40 } }),
    check(store) {
      assert.equal(rowOf(store.text(), "note"), undefined, "the delete wins, whoever is higher");
      assert.equal(rowOf(store.text(), "arrow"), undefined);
      return { outcome: "the node and its arrow are gone", lost: "the move, without a notice", verdict: "ok" };
    },
  },
  {
    name: "one deletes a group the other adds a member to",
    a: (store) => uiDelete(store, ["group"]),
    // dropped at 1300,400 of the board: inside the group, so it joins with 300,400 relative to it
    b: (store) => writeDrop(store, { other: { x: 1300, y: 400 } }),
    check(store) {
      assert.equal(rowOf(store.text(), "group"), undefined);
      assert.equal(rowOf(store.text(), "other")?.parent, "group", "today: the file names a group that is gone");
      assert.deepEqual(placeOf(store, "other"), [300, 400], "today: drawn at its group-relative place");
      return {
        outcome: "the group is gone, the new member stays with parent 'group' in the file and is drawn at 300,400",
        lost: "the node's place: it was dropped at 1300,400 and jumps by the group's origin",
        verdict: "wrong-data",
      };
    },
  },
  {
    name: "both edit the same note's text",
    a: (store) => store.gesture((tx) => tx.update("note", { text: "A's line\nfirst line\nsecond line" })),
    b: (store) => store.gesture((tx) => tx.update("note", { text: "first line\nsecond line\nB's line" })),
    check(store, winner) {
      const text = String(rowOf(store.text(), "note")?.text);
      assert.equal(text.includes("A's line"), winner === "a");
      assert.equal(text.includes("B's line"), winner === "b", "today: one peer's text whole, never both lines");
      return {
        outcome: `${winner}'s text, whole`,
        lost: "the other peer's line, without a notice",
        verdict: "degraded",
      };
    },
  },
  {
    name: "one deletes a node the other draws an arrow to",
    a: (store) => uiDelete(store, ["other"]),
    b: (store) => void addArrow(store, { node: "image", side: "left" }, { node: "other", side: "right" }),
    check(store) {
      const arrows = rowsOf(store.text()).filter((row) => row.kind === "edge");
      assert.equal(arrows.length, 2, "today: the new arrow is in the file");
      assert.equal(store.getSnapshot().edges.length, 1, "and not on the board: its target is gone");
      return {
        outcome: "the node is gone, the arrow to it is in the file and is not drawn",
        lost: "nothing a person sees; the file keeps a line no gesture can reach",
        verdict: "wrong-data",
      };
    },
  },
  {
    name: "one drops a node into a group, the other moves it on the board",
    a: (store) => writeDrop(store, { other: { x: 1300, y: 400 } }),
    b: (store) => writeDrop(store, { other: { x: 50, y: 500 } }),
    check(store, winner) {
      assert.equal(rowOf(store.text(), "other")?.parent, "group", "the membership is in, whoever is higher");
      if (winner === "a") {
        assert.deepEqual(placeOf(store, "other"), [1300, 400]);
        return { outcome: "a's drop, whole", lost: "b's move, without a notice", verdict: "ok" };
      }
      // b wrote x and y only: they are read relative to the group a put the node into
      assert.deepEqual(placeOf(store, "other"), [1050, 500], "today: neither 1300,400 nor 50,500");
      return {
        outcome: "a's group with b's coordinates: the node stands at 1050,500, where nobody put it",
        lost: "both places",
        verdict: "wrong-data",
      };
    },
  },
  {
    name: "one resizes a group from its top left corner, the other moves a member",
    // what nodes/group-node.tsx writes: the frame, and every member shifted back by the corner's move
    a: (store) =>
      store.gesture((tx) => {
        tx.update("group", { x: 900, y: -100, width: 900, height: 700 });
        tx.update("model", { x: 140, y: 160 });
        tx.update("inside", { x: 600, y: 160 });
      }),
    // to 1600,300 of the board
    b: (store) => writeDrop(store, { inside: { x: 600, y: 300 } }),
    check(store, winner) {
      assert.deepEqual(placeOf(store, "model"), [1040, 60], "the member nobody moved stays where it was");
      if (winner === "a") {
        assert.deepEqual(placeOf(store, "inside"), [1500, 60]);
        return {
          outcome: "the member is back where it was before b moved it",
          lost: "b's move, without a notice",
          verdict: "ok",
        };
      }
      assert.deepEqual(placeOf(store, "inside"), [1500, 200], "today: b put it at 1600,300");
      return {
        outcome: "b's coordinates relative to a's new corner: the member stands 100,100 off where b put it",
        lost: "the member's place",
        verdict: "wrong-data",
      };
    },
  },
  {
    name: "both add a node",
    a: (store) => void addNode(store, { type: "text", width: 200, height: 100, text: "A" }, { x: 600, y: 900 }),
    b: (store) => void addNode(store, { type: "text", width: 200, height: 100, text: "B" }, { x: 900, y: 900 }),
    check(store) {
      const fresh = rowsOf(store.text()).filter((row) => rowOf(BASE, String(row.id)) === undefined);
      assert.equal(fresh.length, 2);
      assert.equal(fresh[0]?.z, fresh[1]?.z, "the same z key: which lies on top is decided by the element id");
      return { outcome: "both nodes, with one z key", lost: "nothing", verdict: "ok" };
    },
  },
  {
    name: "both draw a group around the same two nodes",
    a: (store) => void addGroupAround(store, ["note", "other"], "A"),
    b: (store) => void addGroupAround(store, ["note", "other"], "B"),
    check(store, winner) {
      const groups = rowsOf(store.text()).filter((row) => row.type === "group" && row.id !== "group");
      assert.equal(groups.length, 2);
      const parent = rowOf(store.text(), "note")?.parent;
      assert.equal(parent, rowOf(store.text(), "other")?.parent, "both members in one of the two groups");
      assert.equal(groups.find((row) => row.id === parent)?.text, winner === "a" ? "A" : "B");
      assert.deepEqual(
        [placeOf(store, "note"), placeOf(store, "other")],
        [
          [0, 0],
          [0, 300],
        ],
      );
      return { outcome: "two frames at one place, one of them empty", lost: "nothing", verdict: "degraded" };
    },
  },
];

test("two peers: every case converges; what is in the file afterwards", () => {
  for (const one of PEER_CASES) {
    for (const winner of ["a", "b"] as const) {
      const { a, b, hold, release } = peers(winner === "a");
      hold();
      one.a(a);
      one.b(b);
      release();
      assert.equal(a.text(), b.text(), `${one.name}: both replicas serialise to the same bytes`);
      assert.deepEqual(
        a.getSnapshot().nodes.map((item) => [item.id, item.parentId]),
        b.getSnapshot().nodes.map((item) => [item.id, item.parentId]),
        `${one.name}: and draw the same board`,
      );
      assert.equal(boardText(createBoardDoc(a.text())), a.text(), `${one.name}: the result is canonical`);
      const result = one.check(a, winner);
      measured.push({
        part: "peers",
        case: one.name,
        higherClient: winner,
        converged: true,
        dangling: dangling(a.text()),
        ...result,
      });
      a.destroy();
      b.destroy();
    }
  }
});

test("a dangling reference stays in the file through the gestures that follow", () => {
  // the arrow to a deleted node: no gesture reaches it (it is not on the canvas), a delete of its
  // other end does not take it along either
  const { a, b, hold, release } = peers(true);
  hold();
  uiDelete(a, ["other"]);
  const arrow = addArrow(b, { node: "image", side: "left" }, { node: "other", side: "right" });
  release();
  uiDelete(a, ["image"]);
  assert.ok(rowOf(a.text(), arrow), "today: the arrow outlives both of its ends");
  assert.deepEqual(dangling(a.text()), [`${arrow}.source`, `${arrow}.target`]);

  // the member of a deleted group: its next move writes x and y and leaves the dead `parent` in the file
  const second = peers(true);
  second.hold();
  uiDelete(second.a, ["group"]);
  writeDrop(second.b, { other: { x: 1300, y: 400 } });
  second.release();
  writeDrop(second.a, { other: { x: 20, y: 30 } });
  assert.equal(rowOf(second.a.text(), "other")?.parent, "group", "today: still there after the next move");
  assert.deepEqual(placeOf(second.a, "other"), [20, 30]);
  assert.equal(second.a.text(), second.b.text());
  measured.push({
    part: "peers",
    case: "a dangling reference afterwards",
    arrowOutlivesBothEnds: true,
    deadParentSurvivesTheNextMove: true,
  });
  for (const store of [a, b, second.a, second.b]) store.destroy();
});
