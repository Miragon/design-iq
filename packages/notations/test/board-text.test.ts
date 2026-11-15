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

  for (const [where, line] of [
    [
      "a note's text",
      `{"height":160,"id":"n_a","kind":"node","text":"__proto__","type":"text","width":240,"x":0,"y":0,"z":"a"}`,
    ],
    ["an arrow's label", `{"id":"e_a","kind":"edge","label":"__proto__","source":"n_a","target":"n_b"}`],
    [
      "a group's name",
      `{"height":420,"id":"n_g","kind":"node","text":"__proto__","type":"group","width":640,"x":0,"y":0,"z":"a"}`,
    ],
    [
      "a model's file",
      `{"file":"__proto__","height":540,"id":"n_m","kind":"node","type":"model","width":800,"x":0,"y":0,"z":"a"}`,
    ],
    ["a value inside a value", `{"id":"x_lane","kind":"swimlane","rows":["__proto__",{"deep":"__proto__"}]}`],
  ] as const) {
    it(`the value __proto__ as ${where}, and writes it back`, () => {
      const text = `${HEADER}\n${line}\n`;
      const snapshot = accepted(text);
      assert.ok(JSON.stringify(Object.values(snapshot.elements)).includes(`"__proto__"`));
      assert.equal(encodeBoard(snapshot), text);
      assert.deepEqual(accepted(encodeBoard(snapshot)), snapshot);
    });
  }

  it("the value __proto__ as the board's title, and writes it back", () => {
    const text = `{"format":"structured-model","meta":{"title":"__proto__","version":1},"version":1}\n`;
    const snapshot = accepted(text);
    assert.equal(snapshot.meta.title, "__proto__");
    assert.equal(encodeBoard(snapshot), text);
    assert.deepEqual(accepted(encodeBoard(snapshot)), snapshot);
  });

  it("an arrow whose ends name __proto__: a value like any other, and written back", () => {
    const text = `${HEADER}\n{"id":"e_a","kind":"edge","source":"__proto__","target":"__proto__"}\n`;
    const snapshot = accepted(text);
    assert.deepEqual(Object.keys(snapshot.elements), ["e_a"]);
    assert.equal(encodeBoard(snapshot), text);
  });
});

describe("parseBoardText refuses", () => {
  it("an element whose id is __proto__: an id is a key wherever a board keeps its elements", () => {
    assert.match(refused(`${HEADER}\n{"id":"__proto__","kind":"node"}`), /line 2 has the element id __proto__/);
  });

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

  it("a key named __proto__, at the top of a line and at every depth below", () => {
    const named = (line: number): string => `line ${line} has a key named __proto__`;
    assert.equal(refused(`${HEADER}\n{"id":"n_a","__proto__":{"x":1}}`), named(2));
    assert.equal(refused(`${HEADER}\n{"id":"n_a","__proto__":"text"}`), named(2));
    assert.equal(refused(`${HEADER}\n{"data":{"__proto__":1},"id":"n_a"}`), named(2));
    assert.equal(refused(`${HEADER}\n{"id":"n_a","rows":[1,{"deep":{"__proto__":null}}]}`), named(2));
    assert.equal(refused(`{"format":"structured-model","meta":{"__proto__":{}},"version":1}`), named(1));
    assert.equal(refused(`{"__proto__":1,"format":"structured-model","meta":{},"version":1}`), named(1));
    // deeper than the call stack is: JSON.parse reads such a line
    const deep = 20_000;
    assert.equal(
      refused(`${HEADER}\n{"id":"n_a","rows":${"[".repeat(deep)}{"__proto__":1}${"]".repeat(deep)}}`),
      named(2),
    );
  });

  it("a key named __proto__ that the line spells with a JSON escape", () => {
    assert.equal(refused(`${HEADER}\n{"id":"n_a","\\u005f_proto__":1}`), "line 2 has a key named __proto__");
    assert.equal(refused(`${HEADER}\n{"data":{"__pr\\u006fto__":1},"id":"n_a"}`), "line 2 has a key named __proto__");
  });
});
