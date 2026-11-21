/**
 * The board as one more model of the repository: its graph (./extract), the
 * models it shows as references (./refs) and what a rename or a move of such
 * a model rewrites in it (./retarget).
 *
 *   node --test packages/notations/test/board-refs.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { docCodecFor } from "../codecs.ts";
import { extractModelGraph } from "../extract.ts";
import { hasRefs, refsOf, shownNotation } from "../refs.ts";
import { retargetMovedPaths, retargetRefs } from "../retarget.ts";

const HEADER = `{"format":"structured-model","meta":{"title":"Workshop","version":1},"version":1}`;
const LINES = [
  HEADER,
  `{"id":"e_1","kind":"edge","label":"became","source":"n_storm","target":"n_order"}`,
  `{"file":"assets/sketch.svg","height":240,"id":"n_image","kind":"node","type":"image","width":320,"x":0,"y":0,"z":"d"}`,
  `{"height":160,"id":"n_note","kind":"node","text":"## Open questions\\n\\n- one","type":"text","width":280,"x":0,"y":0,"z":"c"}`,
  `{"file":"processes/order-to-cash.bpmn","height":540,"id":"n_order","kind":"node","parent":"n_zone","type":"model","width":940,"x":0,"y":0,"z":"a"}`,
  `{"file":"processes/sub/order-to-cash.storm","height":540,"id":"n_storm","kind":"node","type":"model","width":860,"x":0,"y":0,"z":"b"}`,
  `{"height":900,"id":"n_zone","kind":"node","text":"Sales","type":"group","width":1200,"x":0,"y":0,"z":"0"}`,
  `{"id":"x_lane","kind":"swimlane"}`,
];
const BOARD = `${LINES.join("\n")}\n`;

/** the lines of `after` that differ from `before`'s line at the same place */
const changedLines = (before: string, after: string): string[] =>
  after.split("\n").filter((line, index) => line !== before.split("\n")[index]);

test("extractModelGraph(board): nodes by type, a file node named by its path, a note by its first line, arrows as edges", () => {
  const graph = extractModelGraph("board", BOARD);
  assert.ok(graph);
  assert.equal(graph.notation, "board");
  assert.deepEqual(graph.meta, { title: "Workshop" });
  assert.deepEqual(
    graph.nodes.map((n) => [n.id, n.type, n.name]),
    [
      ["n_image", "image", "assets/sketch.svg"],
      ["n_note", "text", "## Open questions"],
      ["n_order", "model", "processes/order-to-cash.bpmn"],
      ["n_storm", "model", "processes/sub/order-to-cash.storm"],
      ["n_zone", "group", "Sales"],
    ],
  );
  assert.deepEqual(graph.edges, [{ id: "e_1", from: "n_storm", to: "n_order", kind: "arrow", name: "became" }]);
  // by file name too, and whatever the file holds: the decode is total
  assert.equal(extractModelGraph("boards/workshop.board", "not a board")?.nodes.length, 0);
});

test("extractModelGraph(board): a model node carries the notation and id its file names, a member its group, a note its text", () => {
  const graph = extractModelGraph("board", BOARD);
  const extra = (id: string) => graph?.nodes.find((n) => n.id === id)?.extra;
  assert.deepEqual(extra("n_order"), {
    file: "processes/order-to-cash.bpmn",
    notation: "bpmn",
    model: "order-to-cash",
    parent: "n_zone",
  });
  assert.deepEqual(extra("n_storm"), {
    file: "processes/sub/order-to-cash.storm",
    notation: "event-storming",
    model: "order-to-cash",
  });
  // an image names a file, not a model; a note keeps its whole Markdown
  assert.deepEqual(extra("n_image"), { file: "assets/sketch.svg" });
  assert.deepEqual(extra("n_note"), { text: "## Open questions\n\n- one" });
  assert.equal(extra("n_zone"), undefined);
  // a model node whose file is no model of a registered notation has none
  const odd = `${HEADER}\n{"file":"docs/readme.txt","id":"n_1","kind":"node","type":"model"}\n`;
  assert.deepEqual(extractModelGraph("board", odd)?.nodes[0]?.extra, { file: "docs/readme.txt" });
});

test("refsOf(board): one required reference per model node, by notation and file stem, with its path; an image is none", () => {
  assert.equal(hasRefs("board"), true);
  const graph = extractModelGraph("board", BOARD);
  assert.ok(graph);
  assert.deepEqual(refsOf(graph), [
    {
      fromElement: "n_order",
      rel: "shows",
      to: { id: "order-to-cash", notation: "bpmn", path: "processes/order-to-cash.bpmn" },
      strength: "required",
    },
    {
      fromElement: "n_storm",
      rel: "shows",
      to: { id: "order-to-cash", notation: "event-storming", path: "processes/sub/order-to-cash.storm" },
      strength: "required",
    },
  ]);
});

test("refsOf(board): another board, a file of no notation and a model node without a file show no model", () => {
  const board = [
    HEADER,
    `{"file":"boards/other.board","id":"n_board","kind":"node","type":"model"}`,
    `{"file":"docs/readme.txt","id":"n_text","kind":"node","type":"model"}`,
    `{"id":"n_empty","kind":"node","type":"model"}`,
    `{"file":"","id":"n_blank","kind":"node","type":"model"}`,
    `{"file":"processes/a.bpmn","id":"n_image","kind":"node","type":"image"}`,
  ].join("\n");
  const graph = extractModelGraph("board", board);
  assert.ok(graph);
  assert.deepEqual(refsOf(graph), []);
  assert.equal(shownNotation("boards/other.board"), undefined);
  assert.equal(shownNotation("processes/a.bpmn"), "bpmn");
  assert.equal(shownNotation(7), undefined);
});

test("retargetRefs(board): a renamed model's path gets the new stem, its folder and extension stay, nothing else changes", () => {
  const renamed = retargetRefs("board", BOARD, { notation: "bpmn", from: "order-to-cash", to: "o2c" });
  assert.deepEqual(changedLines(BOARD, renamed), [
    `{"file":"processes/o2c.bpmn","height":540,"id":"n_order","kind":"node","parent":"n_zone","type":"model","width":940,"x":0,"y":0,"z":"a"}`,
  ]);
  // the same stem under another notation is another model
  const storm = retargetRefs("board", BOARD, { notation: "event-storming", from: "order-to-cash", to: "big-picture" });
  assert.ok(storm.includes(`"file":"processes/sub/big-picture.storm"`));
  assert.ok(storm.includes(`"file":"processes/order-to-cash.bpmn"`));
});

test("retargetRefs(board): a compound extension, a path with characters JSON escapes, and a rename to itself", () => {
  const chain = `${HEADER}\n{"file":"models/value \\"chain\\".vc.json","id":"n_1","kind":"node","type":"model"}\n`;
  assert.ok(
    retargetRefs("board", chain, { notation: "value-chain", from: 'value "chain"', to: "chain" }).includes(
      `"file":"models/chain.vc.json"`,
    ),
  );
  assert.equal(retargetRefs("board", BOARD, { notation: "bpmn", from: "order-to-cash", to: "order-to-cash" }), BOARD);
  assert.equal(retargetRefs("board", BOARD, { notation: "dmn", from: "order-to-cash", to: "x" }), BOARD);
  // a file of no notation, and a line whose file is no string, are left alone
  const odd = `${HEADER}\n{"file":"assets/order-to-cash.png","id":"n_1","kind":"node"}\n{"file":7,"id":"n_2","kind":"node"}\n`;
  assert.equal(retargetRefs("board", odd, { notation: "bpmn", from: "order-to-cash", to: "x" }), odd);
});

test("retargetRefs(board): with `paths`, only the nodes naming one of them follow; another file with the same stem keeps its path", () => {
  // two files with one stem (a duplicate git brought in): renaming the 2023 one must not touch the 2024 node
  const board = [
    HEADER,
    `{"file":"processes/2023/order.bpmn","id":"n_1","kind":"node","type":"model"}`,
    `{"file":"processes/2024/order.bpmn","id":"n_2","kind":"node","type":"model"}`,
    `{"file":"processes/archive/order.bpmn","id":"n_3","kind":"node","type":"model"}`,
    "",
  ].join("\n");
  const spec = { notation: "bpmn", from: "order", to: "billing" };
  const paths = new Set(["processes/2023/order.bpmn", "processes/archive/order.bpmn"]);
  assert.deepEqual(changedLines(board, retargetRefs("board", board, { ...spec, paths })), [
    `{"file":"processes/2023/billing.bpmn","id":"n_1","kind":"node","type":"model"}`,
    `{"file":"processes/archive/billing.bpmn","id":"n_3","kind":"node","type":"model"}`,
  ]);
  assert.equal(retargetRefs("board", board, { ...spec, paths: new Set() }), board, "no path follows: nothing changes");
  // without `paths` every path of the notation and stem follows (the caller cannot tell)
  assert.equal(changedLines(board, retargetRefs("board", board, spec)).length, 3);
});

test("retargetRefs(board): only a model node's file is a reference; the title, an image and foreign content keep theirs", () => {
  const board = [
    `{"format":"structured-model","meta":{"file":"processes/order-to-cash.bpmn","title":"Workshop","version":1},"version":1}`,
    `{"file":"processes/order-to-cash.bpmn","id":"n_image","kind":"node","type":"image"}`,
    `{"file":"processes/order-to-cash.bpmn","id":"n_order","kind":"node","type":"model"}`,
    `{"data":{"file":"processes/order-to-cash.bpmn"},"id":"x_lane","kind":"swimlane"}`,
    `{"file":"processes/order-to-cash.bpmn","id":"x_ref","kind":"reference"}`,
    "",
  ].join("\n");
  const renamed = retargetRefs("board", board, { notation: "bpmn", from: "order-to-cash", to: "o2c" });
  assert.deepEqual(changedLines(board, renamed), [
    `{"file":"processes/o2c.bpmn","id":"n_order","kind":"node","type":"model"}`,
  ]);
  // what the rename writes is the board's canonical text, the codec's own
  const codec = docCodecFor("board");
  assert.ok(codec);
  assert.equal(codec.encode(codec.decode(renamed)), renamed);
});

test("retargetRefs(board): a board shown on a board is no reference, so a rename of it rewrites nothing", () => {
  const board = `${HEADER}\n{"file":"boards/workshop.board","id":"n_b","kind":"node","type":"model"}\n`;
  assert.equal(retargetRefs("board", board, { notation: "board", from: "workshop", to: "retro" }), board);
});

test("retargetRefs(board): a text the board's reader refuses comes back untouched, never with lines dropped", () => {
  // the second line is no JSON: a decode would skip it and the encode drop it
  const broken = `${HEADER}\n{"file":"processes/order-to-cash.bpmn","id":"n_cut"\n{"file":"processes/order-to-cash.bpmn","id":"n_order","kind":"node","type":"model"}\n`;
  assert.equal(retargetRefs("board", broken, { notation: "bpmn", from: "order-to-cash", to: "o2c" }), broken);
  // a repeated id the same
  const twice = `${HEADER}\n${LINES[4]}\n${LINES[4]}\n`;
  assert.equal(retargetRefs("board", twice, { notation: "bpmn", from: "order-to-cash", to: "o2c" }), twice);
});

test("retargetRefs(board): a board in another form than the canonical one keeps its bytes when nothing changes", () => {
  // another key order, another line order, no last newline: read fine, nothing to rename
  const loose = `{"z":"a","type":"model","kind":"node","id":"n_1","file":"processes/a.bpmn"}\n${HEADER}`;
  assert.equal(retargetRefs("board", loose, { notation: "bpmn", from: "other", to: "x" }), loose);
  // with a rename it comes back canonical
  const renamed = retargetRefs("board", loose, { notation: "bpmn", from: "a", to: "b" });
  assert.equal(renamed, `${HEADER}\n{"file":"processes/b.bpmn","id":"n_1","kind":"node","type":"model","z":"a"}\n`);
});

test("retargetMovedPaths(board): a moved model's node gets the new path, every other line stays", () => {
  const moves = new Map([
    ["processes/order-to-cash.bpmn", "processes/sales/order-to-cash.bpmn"],
    ["assets/sketch.svg", "assets/old/sketch.svg"],
  ]);
  const moved = retargetMovedPaths("board", BOARD, moves);
  // the image is no model the board shows: its file is not the move's business
  assert.deepEqual(changedLines(BOARD, moved), [
    `{"file":"processes/sales/order-to-cash.bpmn","height":540,"id":"n_order","kind":"node","parent":"n_zone","type":"model","width":940,"x":0,"y":0,"z":"a"}`,
  ]);
  // two nodes of one model both follow it
  const twice = `${HEADER}\n{"file":"m/a.bpmn","id":"n_1","kind":"node","type":"model"}\n{"file":"m/a.bpmn","id":"n_2","kind":"node","type":"model"}\n`;
  assert.equal(
    retargetMovedPaths("board", twice, new Map([["m/a.bpmn", "m/x/a.bpmn"]])),
    twice.replaceAll("m/a.bpmn", "m/x/a.bpmn"),
  );
});

test("retargetMovedPaths: nothing to move, another notation and a refused board come back unchanged", () => {
  const moves = new Map([["processes/order-to-cash.bpmn", "processes/sales/order-to-cash.bpmn"]]);
  assert.equal(retargetMovedPaths("board", BOARD, new Map()), BOARD);
  assert.equal(retargetMovedPaths("board", BOARD, new Map([["processes/other.bpmn", "x/other.bpmn"]])), BOARD);
  // a BPMN caller names its sub-process by id, which a move keeps
  const bpmn = `<definitions><process id="p"><callActivity id="c" calledElement="order-to-cash"/></process></definitions>`;
  assert.equal(retargetMovedPaths("bpmn", bpmn, moves), bpmn);
  const broken = `${HEADER}\n${LINES[4]}\nnot json\n`;
  assert.equal(retargetMovedPaths("board", broken, moves), broken);
  // a board shown on a board is not followed either
  const nested = `${HEADER}\n{"file":"boards/a.board","id":"n_b","kind":"node","type":"model"}\n`;
  assert.equal(retargetMovedPaths("board", nested, new Map([["boards/a.board", "boards/x/a.board"]])), nested);
});
