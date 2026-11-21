/**
 * The board file through its codec (./codecs docCodecFor("board")): the
 * format, total decode and strict reader of @miragon/board-schema-model, the
 * ones the board's canvas reads and writes with. What a text host may hand
 * the board, what it must refuse because the next export would drop it, and
 * that the house codec (jsonLinesCodec) writes the same bytes as the board's.
 *
 *   node --test packages/notations/test/board-text.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeBoard, encodeBoard, parseBoardText } from "@miragon/board-schema-model";

import { docCodecFor, jsonLinesCodec, type StructuredSnapshot } from "../codecs.ts";

const codec = docCodecFor("board");
assert.ok(codec?.check, "the board registers a codec with a strict reader");
const check = codec.check.bind(codec);

const HEADER = `{"format":"structured-model","meta":{"title":"T","version":1},"version":1}`;
const NOTE = `{"height":160,"id":"n_a","kind":"node","text":"A","type":"text","width":240,"x":0,"y":0,"z":"a"}`;
const ARROW = `{"id":"e_a","kind":"edge","source":"n_a","target":"n_b"}`;

const accepted = (text: string): StructuredSnapshot => {
  const reason = check(text);
  assert.equal(reason, undefined, `refused: ${reason}`);
  return codec.decode(text);
};
const refused = (text: string): string => {
  const reason = check(text);
  assert.ok(reason !== undefined, "the text was accepted");
  return reason;
};

describe("the board's codec", () => {
  it("is the board schema model's: its writer, its total reader and its strict reader", () => {
    assert.equal(codec.encode, encodeBoard);
    assert.equal(codec.decode, decodeBoard);
    for (const text of ["", `${HEADER}\n${NOTE}\n`, `${HEADER}\n${NOTE}\n${NOTE}`, "hello"]) {
      const parsed = parseBoardText(text);
      assert.equal(check(text), parsed.ok ? undefined : parsed.reason, text);
    }
  });
});

describe("check accepts", () => {
  it("an empty text as a new board", () => {
    assert.deepEqual(accepted(""), { elements: {}, meta: {} });
    assert.deepEqual(accepted("\n  \n"), { elements: {}, meta: {} });
  });

  it("the canonical text, and gives it back byte for byte", () => {
    const text = `${HEADER}\n${ARROW}\n${NOTE}\n`;
    assert.equal(codec.encode(accepted(text)), text);
  });

  it("another line order, another key order, blank lines and no last newline, with one canonical form", () => {
    const loose = `${NOTE}\n\n{"target":"n_b","source":"n_a","kind":"edge","id":"e_a"}\n${HEADER}`;
    const canonical = codec.encode(accepted(loose));
    assert.equal(canonical, `${HEADER}\n${ARROW}\n${NOTE}\n`);
    assert.equal(codec.encode(accepted(canonical)), canonical);
  });

  it("content the board does not know, and writes it back", () => {
    const foreign = [
      `{"format":"structured-model","meta":{"owner":"team-a"},"version":1}`,
      `{"colour":"amber","id":"x_lane","kind":"swimlane","rows":[1,{"deep":null}]}`,
      `{"id":"n_shapeless","kind":"node"}`,
    ].join("\n");
    const text = codec.encode(accepted(foreign));
    for (const part of [`"owner":"team-a"`, `"kind":"swimlane"`, `"rows":[1,{"deep":null}]`, `"id":"n_shapeless"`]) {
      assert.ok(text.includes(part), `${part} is gone`);
    }
  });

  // what DocCodec.check and the validator README promise: the reader takes a
  // line as JSON.parse reads it, and the canonical form normalizes the JSON
  // itself. Should the reader start refusing these, both texts change
  it("a key a line repeats and an integer beyond 2^53: the canonical form keeps the last value and the double", () => {
    const repeated = `{"height":160,"id":"n_a","kind":"node","text":"keep me","text":"other","type":"text","width":240,"x":0,"y":0,"z":"a"}`;
    const big = `{"big":12345678901234567890,"id":"n_b","kind":"node"}`;
    const text = codec.encode(accepted(`${HEADER}\n${repeated}\n${big}\n`));
    assert.equal(text.split("\n")[1], NOTE.replace(`"text":"A"`, `"text":"other"`));
    assert.equal(text.split("\n")[2], `{"big":12345678901234567000,"id":"n_b","kind":"node"}`);
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
      assert.equal(codec.encode(snapshot), text);
      assert.deepEqual(accepted(codec.encode(snapshot)), snapshot);
    });
  }

  it("the value __proto__ as the board's title, and writes it back", () => {
    const text = `{"format":"structured-model","meta":{"title":"__proto__","version":1},"version":1}\n`;
    const snapshot = accepted(text);
    assert.equal(snapshot.meta.title, "__proto__");
    assert.equal(codec.encode(snapshot), text);
    assert.deepEqual(accepted(codec.encode(snapshot)), snapshot);
  });

  it("an arrow whose ends name __proto__: a value like any other, and written back", () => {
    const text = `${HEADER}\n{"id":"e_a","kind":"edge","source":"__proto__","target":"__proto__"}\n`;
    const snapshot = accepted(text);
    assert.deepEqual(Object.keys(snapshot.elements), ["e_a"]);
    assert.equal(codec.encode(snapshot), text);
  });
});

describe("check refuses", () => {
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
    // a header whose meta is a list: the decode reads no title from it, so the next save would lose it
    assert.match(refused(`{"format":"structured-model","meta":["T"],"version":1}`), /without a meta object/);
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

// ── the house codec and the board's: one format ─────────────────────────────

/** a small seeded generator (mulberry32): the same cases on every run */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STRINGS = [
  "",
  "a",
  "n_a",
  "Order to Cash",
  'quote " and \\ backslash',
  "line\nbreak",
  "tab\tand\r",
  "  ",
  "Ünïcödé 漢字 🙂",
  "constructor",
  "toString",
  "id",
  "format",
  "structured-model",
  "processes/order-to-cash.bpmn",
];

function generator(seed: number) {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const value = (depth: number): unknown => {
    const roll = next();
    if (roll < 0.25) return pick(STRINGS);
    if (roll < 0.45) return Math.floor(next() * 2000) - 1000;
    if (roll < 0.5) return next() * 10;
    if (roll < 0.55) return next() < 0.5;
    if (roll < 0.6) return null;
    if (depth > 2) return pick(STRINGS);
    if (roll < 0.8) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1));
    return record(depth + 1);
  };
  const record = (depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (let i = Math.floor(next() * 6); i > 0; i--)
      out[pick([...STRINGS.filter((s) => s !== ""), "z", "x", "kind", "type"])] = value(depth);
    return out;
  };
  const id = (): string =>
    pick([...STRINGS.filter((s) => s !== ""), `n_${Math.floor(next() * 50)}`, `e_${Math.floor(next() * 50)}`]);
  const snapshot = (): StructuredSnapshot => {
    const elements: StructuredSnapshot["elements"] = {};
    for (let i = Math.floor(next() * 8); i > 0; i--) elements[id()] = record(0);
    return { elements, meta: next() < 0.2 ? {} : { ...record(0), title: pick(STRINGS), version: 1 } };
  };
  /** a text a peer, a merge or a hand edit may leave: elements, headers and what is neither */
  const text = (): string => {
    const lines: string[] = [];
    for (let i = Math.floor(next() * 10); i > 0; i--) {
      const roll = next();
      if (roll < 0.4) lines.push(JSON.stringify({ ...record(0), id: id() }));
      else if (roll < 0.55) lines.push(JSON.stringify({ format: "structured-model", meta: record(0), version: 1 }));
      else if (roll < 0.6) lines.push(JSON.stringify({ format: "structured-model", id: id(), kind: "node" }));
      else if (roll < 0.65) lines.push(JSON.stringify({ id: pick(["", 7, null]), kind: "node" }));
      else if (roll < 0.7) lines.push(JSON.stringify(pick([[1, 2], "text", 42, null])));
      else if (roll < 0.75) lines.push(pick(["", "  ", "not json", '{"id":"n_cut"', "\u0000"]));
      else lines.push(codecLine(snapshot()));
    }
    return lines.join(pick(["\n", "\n", "\n\n"])) + pick(["", "\n"]);
  };
  /** one line of an encoded snapshot */
  const codecLine = (s: StructuredSnapshot): string =>
    pick(
      encodeBoard(s)
        .split("\n")
        .filter((l) => l !== ""),
    ) ?? "";
  return { snapshot, text };
}

describe("the house codec writes the board's bytes", () => {
  const house = jsonLinesCodec();

  it("for a fixed board: nodes, arrows, groups, foreign content, an empty one", () => {
    const boards: StructuredSnapshot[] = [
      { elements: {}, meta: {} },
      { elements: {}, meta: { title: "Workshop", version: 1 } },
      {
        meta: { title: "Workshop", version: 1 },
        elements: {
          n_b: { kind: "node", type: "model", file: "processes/a.bpmn", x: 10, y: 20, width: 800, height: 500, z: "b" },
          n_a: { z: "a", type: "text", text: "## A note\n\n- one", kind: "node", height: 160, width: 240, x: 0, y: 0 },
          e_1: { target: "n_b", source: "n_a", kind: "edge", label: "becomes", sourceHandle: "right" },
          g: { kind: "node", type: "group", text: "Sales", x: -40, y: -40, width: 1200, height: 900, z: "0" },
          x_lane: { kind: "swimlane", rows: [1, { deep: null, b: [true, "x"] }] },
          n_c: {
            id: "zzz",
            kind: "node",
            type: "image",
            file: "assets/a.svg",
            parent: "g",
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            z: "c",
          },
        },
      },
    ];
    for (const board of boards) assert.equal(house.encode(board), encodeBoard(board));
  });

  it("for 2000 generated boards, in any insertion order", () => {
    const { snapshot } = generator(20261120);
    for (let i = 0; i < 2000; i++) {
      const board = snapshot();
      assert.equal(house.encode(board), encodeBoard(board), JSON.stringify(board));
    }
  });

  it("and reads every text alike, but a header whose meta is a list", () => {
    const { text } = generator(118);
    for (let i = 0; i < 2000; i++) {
      const t = text();
      assert.deepEqual(house.decode(t), decodeBoard(t), JSON.stringify(t));
    }
    // the one difference: a list as meta stays meta in the house codec and is no meta to the
    // board's, whose strict reader refuses such a header (check refuses, above)
    const listed = `{"format":"structured-model","meta":["T"],"version":1}\n`;
    assert.deepEqual(house.decode(listed).meta, ["T"]);
    assert.deepEqual(decodeBoard(listed).meta, {});
  });
});
