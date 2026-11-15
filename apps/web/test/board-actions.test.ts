/**
 * The board features' writes (src/notations/board/board-actions.ts): group membership after a drop,
 * new nodes, where an arrow's loose end lands, the image rules and the line diff of the Files
 * panel. Run by hand:
 *
 *   node --test apps/web/test/board-actions.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fractionalIndexBetween } from "@designiq/notations/codecs";

import {
  absoluteBoxes,
  addArrow,
  addGroupAround,
  addNode,
  arrowEndAt,
  assetPath,
  changedLines,
  checkImage,
  fitImage,
  formatBytes,
  groupAround,
  IMAGE_LIMIT_BYTES,
  nearestSide,
  noteColor,
  reconnectArrow,
  regroup,
  writeDrop,
  writeNoteColor,
  writeRegroup,
  writeRemoval,
} from "../src/notations/board/board-actions.ts";
import {
  type BoardSnapshot,
  type BoardStore,
  createBoardDoc,
  createBoardStore,
  type NodeAttrs,
  writeGeometry,
} from "../src/notations/board/board-doc.ts";

const z1 = fractionalIndexBetween();
const z2 = fractionalIndexBetween(z1);
const z3 = fractionalIndexBetween(z2);
const node = (attrs: Partial<NodeAttrs>): NodeAttrs => ({
  kind: "node",
  type: "text",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  z: z2,
  ...attrs,
});
/** a group at 1000,0 (600 x 400) holding `inside`; `outside` at 0,0; a second group at 2000,0 */
const SEED: BoardSnapshot = {
  meta: { title: "Spike", version: 1 },
  elements: {
    group: node({ type: "group", x: 1000, y: 0, width: 600, height: 400, z: z1, text: "A" }),
    other: node({ type: "group", x: 2000, y: 0, width: 600, height: 400, z: z1, text: "B" }),
    inside: node({ type: "model", file: "processes/a.bpmn", parent: "group", x: 40, y: 60 }),
    outside: node({ x: 0, y: 0, z: z3 }),
    arrow: { kind: "edge", source: "outside", target: "inside", sourceHandle: "right", targetHandle: "left" },
  },
};
const board = (): BoardStore => createBoardStore(createBoardDoc(SEED));
const attrs = (store: BoardStore, id: string): NodeAttrs => {
  const found = store.getSnapshot().nodes.find((one) => one.id === id);
  assert.ok(found, `node ${id}`);
  return found.attrs;
};
/** how many transactions the store's document saw while `run` ran */
function transactions(store: BoardStore, run: () => void): number {
  let count = 0;
  const onUpdate = (): void => void count++;
  store.doc.on("update", onUpdate);
  run();
  store.doc.off("update", onUpdate);
  return count;
}

test("a node dropped with its centre in a group joins it, and stays where it is on the board", () => {
  const store = board();
  // the drop itself: the foundation's write, in board coordinates (the node has no parent yet)
  writeGeometry(store, { outside: { x: 1100, y: 100 } });
  const moves = regroup(store.getSnapshot(), ["outside"]);
  assert.deepEqual(moves, [{ id: "outside", parent: "group", x: 100, y: 100 }]);
  assert.equal(
    transactions(store, () => writeRegroup(store, moves)),
    1,
  );
  assert.equal(store.getSnapshot().nodes.find((one) => one.id === "outside")?.parentId, "group");
  assert.deepEqual(absoluteBoxes(store.getSnapshot()).get("outside"), { x: 1100, y: 100, width: 200, height: 100 });
  // nothing to do a second time
  assert.deepEqual(regroup(store.getSnapshot(), ["outside"]), []);
});

test("a drop is ONE transaction: the new place and the new group together, and one undo takes back both", () => {
  const store = board();
  const before = store.text();
  // React Flow's position of a node without a parent: board coordinates; fractions are rounded
  assert.equal(
    transactions(store, () => writeDrop(store, { outside: { x: 1100.4, y: 99.6 } })),
    1,
  );
  assert.deepEqual(
    { parent: attrs(store, "outside").parent, x: attrs(store, "outside").x, y: attrs(store, "outside").y },
    { parent: "group", x: 100, y: 100 },
  );
  assert.deepEqual(absoluteBoxes(store.getSnapshot()).get("outside"), { x: 1100, y: 100, width: 200, height: 100 });
  store.undo.undo();
  assert.equal(store.text(), before);

  // a member dragged out (its position is relative to its group) leaves it, again in one transaction
  assert.equal(
    transactions(store, () => writeDrop(store, { inside: { x: -300, y: 60 } })),
    1,
  );
  assert.equal(attrs(store, "inside").parent, undefined);
  assert.deepEqual(absoluteBoxes(store.getSnapshot()).get("inside"), { x: 700, y: 60, width: 200, height: 100 });

  // a move that changes no membership writes the place and nothing else; a group never joins a group
  writeDrop(store, { outside: { x: 20, y: 30 }, other: { x: 1100, y: 40 } });
  assert.deepEqual(
    [attrs(store, "outside").x, attrs(store, "outside").y, attrs(store, "outside").parent],
    [20, 30, undefined],
  );
  assert.deepEqual(
    [attrs(store, "other").x, attrs(store, "other").y, attrs(store, "other").parent],
    [1100, 40, undefined],
  );
  // an id that is no node of the board changes nothing
  const text = store.text();
  writeDrop(store, { "no-such-node": { x: 1, y: 2 } });
  assert.equal(store.text(), text);
});

test("a group that is removed leaves a member that stays on the board itself, where it is", () => {
  const store = board();
  // React Flow's answer to "delete the group" while `inside` is armed: the group and the arrow at
  // it, not the node that is not deletable
  assert.equal(
    transactions(store, () => writeRemoval(store, ["group"], [])),
    1,
  );
  const ids = store.getSnapshot().nodes.map((one) => one.id);
  assert.ok(!ids.includes("group") && ids.includes("inside"));
  assert.equal(attrs(store, "inside").parent, undefined);
  // 1000 + 40, 0 + 60: the place it had inside the group
  assert.deepEqual(absoluteBoxes(store.getSnapshot()).get("inside"), { x: 1040, y: 60, width: 200, height: 100 });
  assert.ok(!store.text().includes('"parent"'));

  // a group removed WITH its members, and the arrow that ended at one of them
  const whole = board();
  writeRemoval(whole, ["group", "inside"], ["arrow"]);
  assert.deepEqual(
    whole.getSnapshot().nodes.map((one) => one.id),
    ["other", "outside"],
  );
  assert.equal(whole.getSnapshot().edges.length, 0);
  assert.ok(!whole.text().includes('"arrow"'));
});

test("a member dragged out leaves its group; one dragged into another group changes groups", () => {
  const store = board();
  // relative to its group: the centre ends at 1000 - 300 + 100 = 800, left of the group
  writeGeometry(store, { inside: { x: -300, y: 60 } });
  let moves = regroup(store.getSnapshot(), ["inside"]);
  assert.deepEqual(moves, [{ id: "inside", parent: undefined, x: 700, y: 60 }]);
  writeRegroup(store, moves);
  assert.equal(attrs(store, "inside").parent, undefined);
  assert.equal(store.text().includes('"parent"'), false, "the attribute is gone from the board file");
  assert.deepEqual(absoluteBoxes(store.getSnapshot()).get("inside"), { x: 700, y: 60, width: 200, height: 100 });

  writeGeometry(store, { inside: { x: 2100, y: 100 } });
  moves = regroup(store.getSnapshot(), ["inside"]);
  assert.deepEqual(moves, [{ id: "inside", parent: "other", x: 100, y: 100 }]);
});

test("a member moved inside its group stays, a group joins no group, an unknown id is skipped", () => {
  const store = board();
  writeGeometry(store, { inside: { x: 300, y: 250 } });
  assert.deepEqual(regroup(store.getSnapshot(), ["inside"]), []);
  // the centre decides: half of the node hangs out of the group and it still belongs to it
  writeGeometry(store, { inside: { x: 490, y: 340 } });
  assert.deepEqual(regroup(store.getSnapshot(), ["inside"]), []);
  writeGeometry(store, { other: { x: 1100, y: 50 } });
  assert.deepEqual(regroup(store.getSnapshot(), ["other", "no-such-node"]), []);
});

test("where two groups overlap, a member stays with its own and a newcomer takes the one on top", () => {
  const store = board();
  writeGeometry(store, { other: { x: 1200, y: 0 } });
  const view = store.getSnapshot();
  const point = { x: 1400, y: 200 };
  assert.equal(groupAround(view, point, "group"), "group");
  assert.equal(groupAround(view, point, "other"), "other");
  // same z: the element id breaks the tie, "other" paints after "group"
  assert.equal(groupAround(view, point), "other");
  assert.equal(groupAround(view, { x: 500, y: 500 }), undefined);
});

test("a new node lands with its centre at the point, joins the group there and is ONE transaction", () => {
  const store = board();
  let id = "";
  const count = transactions(store, () => {
    id = addNode(store, { type: "text", width: 280, height: 160, text: "" }, { x: 1300, y: 200 });
  });
  assert.equal(count, 1);
  assert.match(id, /^n_/);
  assert.deepEqual(
    { ...attrs(store, id), z: undefined },
    { kind: "node", type: "text", x: 160, y: 120, width: 280, height: 160, parent: "group", z: undefined, text: "" },
  );
  assert.ok(attrs(store, id).z > z3, "on top of every node");
  const free = addNode(store, { type: "model", width: 800, height: 540, file: "processes/a.bpmn" }, { x: 0, y: 2000 });
  assert.equal(attrs(store, free).parent, undefined);
  assert.deepEqual([attrs(store, free).x, attrs(store, free).y], [-400, 1730]);
});

test("a new group goes behind everything and takes no parent, even inside another group", () => {
  const store = board();
  const id = addNode(store, { type: "group", width: 300, height: 200, text: "Group" }, { x: 1300, y: 200 });
  const view = store.getSnapshot();
  assert.equal(attrs(store, id).parent, undefined);
  assert.ok(attrs(store, id).z < z1);
  assert.equal(view.nodes[0]?.id, id, "first in the view: painted first, and before any node that joins it later");
  // and again: there is always a key below the lowest
  const second = addNode(store, { type: "group", width: 300, height: 200 }, { x: 0, y: 0 });
  assert.ok(attrs(store, second).z < attrs(store, id).z);
});

test("a group drawn around nodes holds them at the same board position, in one transaction", () => {
  const store = board();
  const before = absoluteBoxes(store.getSnapshot());
  let id: string | undefined;
  const count = transactions(store, () => {
    id = addGroupAround(store, ["outside", "inside", "other"], "Group");
  });
  assert.equal(count, 1);
  assert.ok(id);
  const view = store.getSnapshot();
  const after = absoluteBoxes(view);
  // outside is at 0,0 (200 x 100), inside at 1040,60 (200 x 100): 32 around, 64 at the top
  assert.deepEqual(after.get(id), { x: -32, y: -64, width: 1304, height: 256 });
  for (const member of ["outside", "inside"]) {
    assert.equal(view.nodes.find((one) => one.id === member)?.parentId, id);
    assert.deepEqual(after.get(member), before.get(member));
  }
  assert.equal(attrs(store, "other").parent, undefined, "a group is no member");
  assert.equal(addGroupAround(store, ["other", "nothing"], "Group"), undefined);
});

test("an arrow's loose end lands on the topmost node at the point, at the nearest side", () => {
  const store = board();
  const view = store.getSnapshot();
  // inside is at 1040,60 (200 x 100)
  assert.deepEqual(arrowEndAt(view, { x: 1050, y: 110 }, 12), { node: "inside", side: "left" });
  assert.deepEqual(arrowEndAt(view, { x: 1140, y: 70 }, 12), { node: "inside", side: "top" });
  assert.deepEqual(arrowEndAt(view, { x: 1140, y: 168 }, 12), { node: "inside", side: "bottom" }, "8 below: in reach");
  assert.equal(arrowEndAt(view, { x: 1140, y: 180 }, 12)?.node, undefined, "20 below, inside the group: nowhere");
  assert.equal(arrowEndAt(view, { x: 1050, y: 110 }, 12, "inside"), undefined, "never the node the arrow starts at");
  // a group is its frame: the inside is board ground
  assert.equal(arrowEndAt(view, { x: 1300, y: 300 }, 12), undefined);
  assert.deepEqual(arrowEndAt(view, { x: 1005, y: 200 }, 12), { node: "group", side: "left" });
  assert.deepEqual(arrowEndAt(view, { x: 1300, y: 405 }, 12), { node: "group", side: "bottom" });
  // where two nodes overlap, the one painted on top takes the arrow
  const onTop = addNode(store, { type: "text", width: 100, height: 60 }, { x: 100, y: 50 });
  assert.equal(arrowEndAt(store.getSnapshot(), { x: 100, y: 50 }, 12)?.node, onTop);
  assert.equal(arrowEndAt(store.getSnapshot(), { x: 20, y: 50 }, 12)?.node, "outside");
  assert.equal(nearestSide({ x: 0, y: 0, width: 400, height: 100 }, { x: 300, y: 10 }), "top");
  assert.equal(nearestSide({ x: 0, y: 0, width: 400, height: 100 }, { x: 390, y: 40 }), "right");
});

test("an arrow is one element; reconnecting writes one end and keeps the rest", () => {
  const store = board();
  let id = "";
  assert.equal(
    transactions(store, () => {
      id = addArrow(store, { node: "outside", side: "bottom" }, { node: "group", side: "left" });
    }),
    1,
  );
  const lines = store.text().split("\n").filter(Boolean);
  assert.equal(lines.filter((line) => line.includes(`"${id}"`)).length, 1);
  assert.equal(
    transactions(store, () => reconnectArrow(store, "arrow", "target", { node: "other", side: "top" })),
    1,
  );
  assert.deepEqual(store.getSnapshot().edges.find((edge) => edge.id === "arrow")?.attrs, {
    kind: "edge",
    source: "outside",
    target: "other",
    sourceHandle: "right",
    targetHandle: "top",
  });
  reconnectArrow(store, "arrow", "source", { node: "inside", side: "bottom" });
  const moved = store.getSnapshot().edges.find((edge) => edge.id === "arrow")?.attrs;
  assert.deepEqual([moved?.source, moved?.sourceHandle, moved?.target], ["inside", "bottom", "other"]);
});

test("the board takes the image types the product serves, up to its limit, and says why it refuses", () => {
  assert.equal(IMAGE_LIMIT_BYTES, 10 * 1024 * 1024);
  assert.deepEqual(checkImage({ name: "Photo.PNG", type: "image/png", size: 2048 }), {
    ok: true,
    extension: ".png",
    type: "image/png",
  });
  assert.deepEqual(checkImage({ name: "sketch.svg", type: "", size: 10 }), {
    ok: true,
    extension: ".svg",
    type: "image/svg+xml",
  });
  // a pasted bitmap may come without a name
  assert.deepEqual(checkImage({ name: "", type: "image/webp", size: 10 }), {
    ok: true,
    extension: ".webp",
    type: "image/webp",
  });
  assert.equal(checkImage({ name: "at-the-limit.jpg", type: "image/jpeg", size: IMAGE_LIMIT_BYTES }).ok, true);
  const tooLarge = checkImage({ name: "huge.png", type: "image/png", size: IMAGE_LIMIT_BYTES + 1 });
  assert.deepEqual(tooLarge, {
    ok: false,
    reason: "huge.png was not added: it has 10.1 MiB, an image may have up to 10 MiB.",
  });
  const larger = checkImage({ name: "huge.png", type: "image/png", size: 13 * 1024 * 1024 });
  assert.equal(larger.ok === false && larger.reason.includes("13 MiB"), true);
  const pdf = checkImage({ name: "notes.pdf", type: "application/pdf", size: 10 });
  assert.equal(pdf.ok, false);
  assert.match(
    pdf.ok ? "" : pdf.reason,
    /^notes\.pdf was not added: the board takes images only \(AVIF, GIF, JPEG, PNG, SVG, WebP\)\.$/,
  );
  // the extension decides, like on the image route: a renamed text file is no image
  assert.equal(checkImage({ name: "notes.txt", type: "image/png", size: 10 }).ok, false);
  assert.equal(checkImage({ name: "empty.png", type: "image/png", size: 0 }).ok, false);
});

test("a new image gets a path under assets/ that replaces no file", () => {
  const taken = new Set(["assets/photo.png", "assets/photo-2.png"]);
  const has = (path: string): boolean => taken.has(path);
  assert.equal(assetPath("Team Photo (final).PNG", ".png", has), "assets/team-photo-final.png");
  assert.equal(assetPath("photo.png", ".png", has), "assets/photo-3.png");
  assert.equal(assetPath("C:\\pictures\\..\\photo.jpeg", ".jpeg", has), "assets/photo.jpeg");
  assert.equal(assetPath("../../etc/passwd.svg", ".svg", has), "assets/passwd.svg");
  assert.equal(assetPath("", ".webp", has), "assets/image.webp");
  assert.equal(assetPath("....", ".gif", has), "assets/image.gif");
});

test("an image node keeps the picture's proportions and is never larger than the picture", () => {
  assert.deepEqual(fitImage({ width: 1920, height: 1080 }), { width: 480, height: 270 });
  assert.deepEqual(fitImage({ width: 600, height: 1200 }), { width: 180, height: 360 });
  assert.deepEqual(fitImage({ width: 120, height: 80 }), { width: 120, height: 80 });
  assert.deepEqual(fitImage(undefined), { width: 320, height: 240 });
  assert.deepEqual(fitImage({ width: 0, height: 0 }), { width: 320, height: 240 });
  assert.equal(formatBytes(765), "765 B");
  assert.equal(formatBytes(12171), "11.9 KiB");
  assert.equal(formatBytes(3 * 1024 * 1024 + 300_000), "3.3 MiB");
});

test("a note's colour is an attribute of its own line in the board file; plain is not written", () => {
  const store = board();
  assert.equal(noteColor(attrs(store, "outside")), "plain");
  assert.equal(
    transactions(store, () => writeNoteColor(store, "outside", "amber")),
    1,
  );
  assert.equal(noteColor(attrs(store, "outside")), "amber");
  assert.equal(
    store
      .text()
      .split("\n")
      .filter((line) => line.includes('"color":"amber"')).length,
    1,
  );
  writeNoteColor(store, "outside", "plain");
  assert.equal(store.text().includes('"color"'), false);
  // anything else in the file is the card
  assert.equal(noteColor({ ...attrs(store, "outside"), color: "#ff0000" } as NodeAttrs), "plain");
});

test("the changed lines of a file are found by content: a moved node is one line of the board file", () => {
  const store = board();
  const before = store.text();
  writeGeometry(store, { outside: { x: 50, y: 60 } });
  const after = store.text();
  const change = changedLines(before, after);
  assert.equal(change.changed.length, 1);
  assert.equal(change.removed, 1);
  assert.match(after.split("\n")[change.changed[0] ?? -1] ?? "", /"id":"outside"/);
  assert.deepEqual(changedLines(after, after), { changed: [], removed: 0 });
  assert.deepEqual(changedLines("a\nb\nc", "a\nc"), { changed: [], removed: 1 });
  assert.deepEqual(changedLines("a\nc", "a\nb\nc\nb"), { changed: [1, 3], removed: 0 });
});
