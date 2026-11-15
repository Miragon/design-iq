/**
 * The board file read strictly (board.ts): what a text host may hand
 * the board, and what it must refuse because the next export would drop it.
 *
 *   node --test packages/notations/test/board-text.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeBoard, parseBoardText } from "../board.ts";

const HEADER = `{"format":"structured-model","meta":{"title":"T","version":1},"version":1}`;
const NOTE = `{"height":160,"id":"n_a","kind":"node","text":"A","type":"text","width":240,"x":0,"y":0,"z":"a"}`;
const ARROW = `{"id":"e_a","kind":"edge","source":"n_a","target":"n_b"}`;

const accepted = (text: string) => {
  const parsed = parseBoardText(text);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  return parsed.snapshot;
};
const refused = (text: string): string => {
  const parsed = parseBoardText(text);
  assert.ok(!parsed.ok, "the text was accepted");
  return parsed.reason;
};

describe("parseBoardText accepts", () => {
  it("an empty text as a new board", () => {
    assert.deepEqual(accepted(""), { elements: {}, meta: {} });
    assert.deepEqual(accepted("\n  \n"), { elements: {}, meta: {} });
  });

  it("the canonical text, and gives it back byte for byte", () => {
    const text = `${HEADER}\n${ARROW}\n${NOTE}\n`;
    assert.equal(encodeBoard(accepted(text)), text);
  });

  it("another line order, another key order, blank lines and no last newline, with one canonical form", () => {
    const loose = `${NOTE}\n\n{"target":"n_b","source":"n_a","kind":"edge","id":"e_a"}\n${HEADER}`;
    const canonical = encodeBoard(accepted(loose));
    assert.equal(canonical, `${HEADER}\n${ARROW}\n${NOTE}\n`);
    assert.equal(encodeBoard(accepted(canonical)), canonical);
  });

  it("content the board does not know, and writes it back", () => {
    const foreign = [
      `{"format":"structured-model","meta":{"owner":"team-a"},"version":1}`,
      `{"colour":"amber","id":"x_lane","kind":"swimlane","rows":[1,{"deep":null}]}`,
      `{"id":"n_shapeless","kind":"node"}`,
    ].join("\n");
    const text = encodeBoard(accepted(foreign));
    for (const part of [`"owner":"team-a"`, `"kind":"swimlane"`, `"rows":[1,{"deep":null}]`, `"id":"n_shapeless"`]) {
      assert.ok(text.includes(part), `${part} is gone`);
    }
  });

  it("an element id that names a member of Object.prototype", () => {
    const snapshot = accepted(`${HEADER}\n{"id":"constructor","kind":"node"}\n{"id":"toString","kind":"node"}`);
    assert.deepEqual(Object.keys(snapshot.elements).sort(), ["constructor", "toString"]);
  });
});

describe("parseBoardText refuses", () => {
  it("what is no board at all", () => {
    assert.match(refused("hello"), /line 1 is no JSON/);
    assert.match(refused(`<?xml version="1.0"?>\n<definitions/>`), /line 1 is no JSON/);
    assert.match(refused(`${HEADER}\n[1,2]`), /line 2 is no JSON object/);
    assert.match(refused(`${HEADER}\n"text"`), /line 2 is no JSON object/);
  });

  it("a line a peer has not finished typing", () => {
    assert.match(refused(`${HEADER}\n${NOTE.slice(0, 40)}`), /line 2 is no JSON/);
    assert.match(refused(`${HEADER}\n${NOTE}\u0000`), /line 2 is no JSON/);
  });

  it("elements without a header, a second header and a header of another version", () => {
    assert.match(refused(NOTE), /no header line/);
    assert.match(refused(`${HEADER}\n${HEADER}`), /line 2 is a second header/);
    assert.match(refused(`{"format":"structured-model","meta":{},"version":2}`), /format version 2/);
    assert.match(refused(`{"format":"structured-model","version":1}`), /without a meta object/);
  });

  it("what the next export would drop", () => {
    assert.match(refused(`${HEADER}\n${NOTE}\n${NOTE}`), /line 3 repeats the element id n_a/);
    assert.match(refused(`{"format":"structured-model","generator":"x","meta":{},"version":1}`), /generator/);
    assert.match(refused(`${HEADER}\n{"kind":"node"}`), /neither the header nor an element/);
    assert.match(refused(`${HEADER}\n{"id":"","kind":"node"}`), /neither the header nor an element/);
    assert.match(refused(`${HEADER}\n{"id":7,"kind":"node"}`), /neither the header nor an element/);
    assert.match(refused(`${HEADER}\n{"id":"n_a","__proto__":{"x":1}}`), /__proto__/);
  });
});
