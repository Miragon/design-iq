/**
 * The board as one more model of the repository: its graph (./extract), the
 * models it shows as references (./refs) and what a rename of such a model
 * rewrites in it (./retarget).
 *
 *   node --test packages/notations/test/board-refs.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractModelGraph } from "../extract.ts";
import { hasRefs, refsOf } from "../refs.ts";
import { retargetRefs } from "../retarget.ts";

const HEADER = `{"format":"structured-model","meta":{"title":"Workshop","version":1},"version":1}`;
const LINES = [
  HEADER,
  `{"id":"e_1","kind":"edge","label":"became","source":"n_storm","target":"n_order"}`,
  `{"file":"assets/sketch.svg","height":240,"id":"n_image","kind":"node","type":"image","width":320,"x":0,"y":0,"z":"d"}`,
  `{"height":160,"id":"n_note","kind":"node","text":"## Open questions\\n\\n- one","type":"text","width":280,"x":0,"y":0,"z":"c"}`,
  `{"file":"processes/order-to-cash.bpmn","height":540,"id":"n_order","kind":"node","type":"model","width":940,"x":0,"y":0,"z":"a"}`,
  `{"file":"processes/sub/order-to-cash.storm","height":540,"id":"n_storm","kind":"node","type":"model","width":860,"x":0,"y":0,"z":"b"}`,
  `{"id":"x_lane","kind":"swimlane"}`,
];
const BOARD = `${LINES.join("\n")}\n`;

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
    ],
  );
  assert.deepEqual(graph.edges, [{ id: "e_1", from: "n_storm", to: "n_order", kind: "arrow", name: "became" }]);
  // by file name too, and whatever the file holds: the decode is total
  assert.equal(extractModelGraph("boards/workshop.board", "not a board")?.nodes.length, 0);
});

test("refsOf(board): one required reference per model node, by notation and file stem; an image is none", () => {
  assert.equal(hasRefs("board"), true);
  const graph = extractModelGraph("board", BOARD);
  assert.ok(graph);
  assert.deepEqual(refsOf(graph), [
    { fromElement: "n_order", rel: "shows", to: { id: "order-to-cash", notation: "bpmn" }, strength: "required" },
    {
      fromElement: "n_storm",
      rel: "shows",
      to: { id: "order-to-cash", notation: "event-storming" },
      strength: "required",
    },
  ]);
});

test("retargetRefs(board): a renamed model's path gets the new stem, its folder and extension stay, nothing else changes", () => {
  const renamed = retargetRefs("board", BOARD, { notation: "bpmn", from: "order-to-cash", to: "o2c" });
  const changed = renamed.split("\n").filter((line, index) => line !== BOARD.split("\n")[index]);
  assert.deepEqual(changed, [
    `{"file":"processes/o2c.bpmn","height":540,"id":"n_order","kind":"node","type":"model","width":940,"x":0,"y":0,"z":"a"}`,
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
