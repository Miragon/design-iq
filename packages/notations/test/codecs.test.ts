/**
 * The doc-codec capability (codecs.ts, epic #118 step 8) — the properties
 * everything downstream leans on: deterministic canonical encode (git diffs,
 * the sha256 baseVersion), TOTAL decode (a seed must never fail), the
 * registry agreeing with the descriptors' docShape, and the fractional-index
 * ordering laws. The board's codec itself: board-text.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { docCodecFor, fractionalIndexBetween, jsonLinesCodec, type StructuredSnapshot } from "../codecs.ts";
import { byId, type NotationDescriptor, NOTATIONS } from "../index.ts";

const codec = jsonLinesCodec();

const BOARD: StructuredSnapshot = {
  meta: { level: "big-picture", title: "Order" },
  elements: {
    e2: { type: "event", text: "Order placed", x: 100, y: 80 },
    e1: { type: "command", text: "Place order", x: 20, y: 80 },
  },
};

test("encode is canonical: insertion-order independent, sorted ids/keys, line-per-element", () => {
  const reordered: StructuredSnapshot = {
    meta: { title: "Order", level: "big-picture" },
    elements: {
      e1: { y: 80, x: 20, text: "Place order", type: "command" },
      e2: { text: "Order placed", type: "event", y: 80, x: 100 },
    },
  };
  const text = codec.encode(BOARD);
  assert.equal(text, codec.encode(reordered), "same snapshot, any insertion order → same bytes");
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 3, "one header line + one line per element");
  assert.match(lines[0]!, /^\{"format":"structured-model"/);
  assert.match(lines[1]!, /^\{"id":"e1"/);
  assert.match(lines[2]!, /^\{"id":"e2"/);
  assert.ok(text.endsWith("\n"), "trailing newline (git-friendly)");
});

test("decode ∘ encode is the identity on snapshots", () => {
  assert.deepEqual(codec.decode(codec.encode(BOARD)), BOARD);
  const empty: StructuredSnapshot = { elements: {}, meta: {} };
  assert.deepEqual(codec.decode(codec.encode(empty)), empty);
});

test("decode is TOTAL: garbage, partial lines and junk rows never fail", () => {
  assert.deepEqual(codec.decode(""), { elements: {}, meta: {} });
  assert.deepEqual(codec.decode("not json at all\n{ broken"), { elements: {}, meta: {} });
  // a valid element line survives surrounding garbage (a mid-edit text state)
  const mixed = `garbage\n{"id":"a","type":"event"}\n42\n{"noid":true}\n`;
  assert.deepEqual(codec.decode(mixed), { elements: { a: { type: "event" } }, meta: {} });
});

test("reserved keys: attr 'id' never re-keys, a format-attr element survives, __proto__ stays inert", () => {
  // the map KEY is authoritative — an attr literally named "id" is overridden
  const rekeyed = codec.decode(codec.encode({ meta: {}, elements: { e1: { id: "zzz", type: "note" } } }));
  assert.deepEqual(Object.keys(rekeyed.elements), ["e1"]);

  // an element whose attrs contain the header marker is NOT swallowed as one
  const marked: StructuredSnapshot = {
    meta: { title: "T" },
    elements: { x: { format: "structured-model", type: "note" } },
  };
  assert.deepEqual(codec.decode(codec.encode(marked)), marked);

  // a crafted __proto__ line becomes an OWN key, never a prototype assignment
  const proto = codec.decode('{"id":"__proto__","x":1}\n');
  assert.ok(Object.hasOwn(proto.elements, "__proto__"));
  assert.deepEqual(proto.elements["__proto__"], { x: 1 });
  assert.equal(({} as Record<string, unknown>).x, undefined, "Object.prototype untouched");
});

/**
 * The notations whose descriptor and codec registry disagree: a structured
 * notation without a codec (the Live Host would silently open its files as
 * text rooms and its canvas would draw nothing), a codec without a strict
 * reader (a room or a save could not refuse a text it would write back
 * lossy), or a codec on a text notation (never used, so never tested).
 */
function codecMismatches(notations: readonly NotationDescriptor[]): string[] {
  return notations.flatMap((n) => {
    const codec = docCodecFor(n.id);
    if (n.docShape === "structured" && !codec) return [`${n.id}: structured without a codec`];
    if (n.docShape === "structured" && typeof codec?.check !== "function") return [`${n.id}: a codec without check`];
    if (n.docShape !== "structured" && codec) return [`${n.id}: a codec on a text notation`];
    return [];
  });
}

test("docCodecFor: every structured notation, and only those, has a codec with a strict reader", () => {
  assert.deepEqual(codecMismatches(NOTATIONS), []);
  assert.deepEqual(
    NOTATIONS.filter((n) => n.docShape === "structured").map((n) => n.id),
    ["board"],
  );
  for (const id of ["bpmn", "dmn", "wardley", "team-topology", "event-storming", "context-map", "value-chain"]) {
    assert.equal(docCodecFor(id), undefined, id);
  }
});

test("docCodecFor: the check above catches a structured descriptor that has no codec", () => {
  const board = byId("board");
  assert.ok(board);
  // a second structured notation registered in index.ts alone
  const unregistered: NotationDescriptor = { ...board, id: "canvas", label: "Canvas", extensions: [".canvas"] };
  assert.deepEqual(codecMismatches([...NOTATIONS, unregistered]), ["canvas: structured without a codec"]);
  // and the board turned into a text notation keeps a codec nobody reads
  assert.deepEqual(codecMismatches([{ ...board, docShape: "text" }]), ["board: a codec on a text notation"]);
});

test("docCodecFor: a member of Object.prototype names no codec", () => {
  for (const id of ["toString", "constructor", "__proto__", "hasOwnProperty"])
    assert.equal(docCodecFor(id), undefined, id);
});

test("fractionalIndexBetween: ordering laws", () => {
  // open interval, both bounds, append cases
  const first = fractionalIndexBetween();
  const before = fractionalIndexBetween(undefined, first);
  const after = fractionalIndexBetween(first);
  assert.ok(before < first && first < after);
  const mid = fractionalIndexBetween(before, first);
  assert.ok(before < mid && mid < first);

  // dense sequences stay ordered and never end in the minimum digit
  let lo = "";
  for (let i = 0; i < 50; i++) {
    const next = fractionalIndexBetween(lo, after);
    assert.ok((lo === "" || lo < next) && next < after, `step ${i}: '${lo}' < '${next}' < '${after}'`);
    assert.ok(!next.endsWith("0"), "generated keys never end in the minimum digit");
    lo = next;
  }

  // adjacent digits ("a","b") and max-digit carries ("az…z") stay inside
  assert.ok(fractionalIndexBetween("a", "b") > "a" && fractionalIndexBetween("a", "b") < "b");
  const carried = fractionalIndexBetween("azz", "b");
  assert.ok(carried > "azz" && carried < "b");

  // malformed bounds fail loudly instead of producing out-of-range keys
  assert.throws(() => fractionalIndexBetween("b", "a"));
  assert.throws(() => fractionalIndexBetween("a", "a0"), /no key exists/);
});
