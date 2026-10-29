/**
 * The sticky ids extract.ts derives from a .storm board are the canvas's:
 * the renderer parses the board with @miragon/event-storming-dsl (the
 * release wardley-dsl-pin.test.ts pins), a todo on a sticky anchors to the
 * id the canvas reports, and create_todo refuses an id the model's text does
 * not have. Hand-written lines the canvas never writes (a comment marker in
 * a label after an apostrophe, an explicit id the board reserves) included.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseDSL } from "@miragon/event-storming-dsl";

import { STORM_STICKY_KINDS } from "../derive.ts";
import { extractModelGraph } from "../extract.ts";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

const stickyIds = (board: string): string[] =>
  (extractModelGraph("board.storm", board)?.nodes ?? [])
    .filter((node) => STORM_STICKY_KINDS.has(node.type))
    .map((node) => node.id);

const canvasIds = (board: string): string[] =>
  parseDSL(board)
    .elements.filter((element) => STORM_STICKY_KINDS.has(element.elementType))
    .map((element) => element.id);

const HAND_WRITTEN: Array<[line: string, id: string]> = [
  ["event Don't // stop [10, 20]", "event_don_t_stop"],
  ["event Customer's order /* draft */ placed [10, 20]", "event_customer_s_order_draft_placed"],
  ["event B [10, 0] (id event-storming-root)", "event_b"],
  ["event C [10, 0] (id __implicitroot_1)", "event_c"],
  ["event Shipped [10, 20] // a comment after the coordinates", "event_shipped"],
  ["event Link https://example.com/a [10, 20]", "event_link_https_example_com_a"],
];

for (const [line, id] of HAND_WRITTEN) {
  test(`a sticky has the canvas's id: ${line}`, () => {
    assert.deepEqual(stickyIds(line), [id]);
    assert.deepEqual(canvasIds(line), [id]);
  });
}

test("comments around and between stickies cut the way the canvas cuts them", () => {
  const board = [
    "/* a block comment",
    "   event Hidden [0, 0]",
    "*/ event Shown [10, 20]",
    "// event Commented [0, 0]",
    "command Place Order [10, 40] /* note */ (id cmd_place)",
    "aggregate Order /* open",
    "   still a comment */ [10, 60]",
  ].join("\n");
  assert.deepEqual(stickyIds(board), canvasIds(board));
});

for (const [name, board] of [
  ["order-checkout.storm", read("./fixtures/order-checkout.storm")],
  ["order-to-cash.storm", read("../../../process-documentation/processes/order-to-cash.storm")],
] as const) {
  test(`every sticky of ${name} has the canvas's id`, () => {
    assert.deepEqual(stickyIds(board), canvasIds(board));
  });
}
