/**
 * Todo anchor codec (@designiq/contracts/todo-anchor) — the platform-owned block
 * that ties a tracker item to a model and its elements. Round-trips through
 * encodeAnchor/parseAnchor, tolerant parsing of hand-written blocks, and the
 * name-flattening that keeps the line format unambiguous.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  encodeAnchor,
  parseAnchor,
  replaceAnchor,
  stripAnchor,
  type TodoAnchor,
} from "@designiq/contracts/todo-anchor";

test("roundtrip: encode → parse yields the same anchor", () => {
  const anchor: TodoAnchor = {
    notation: "bpmn",
    model: "order-to-cash",
    file: "processes/order-to-cash/order-to-cash.bpmn",
    elements: [
      { id: "Task_CheckCredit", name: "Bonität prüfen" },
      { id: "Gateway_Approved", name: "Freigabe erteilt?" },
    ],
    processVersion: "1.4.0",
  };
  assert.deepEqual(parseAnchor(encodeAnchor(anchor)), anchor);
});

test("roundtrip survives being embedded in a larger issue body", () => {
  const anchor: TodoAnchor = { notation: "bpmn", model: "p1", file: null, elements: [], processVersion: null };
  const body = `Some intro text.\n\n${encodeAnchor(anchor)}\n\nDiscussion below.\n_Created by @petra_`;
  assert.deepEqual(parseAnchor(body), anchor);
});

test("names with pipes/newlines are flattened at encode time (line format stays unambiguous)", () => {
  const anchor: TodoAnchor = {
    notation: "bpmn",
    model: "order-to-cash",
    file: null,
    elements: [{ id: "Task_A", name: "a|b\nc" }],
    processVersion: null,
  };
  const parsed = parseAnchor(encodeAnchor(anchor));
  assert.deepEqual(parsed?.elements, [{ id: "Task_A", name: "a b c" }]);
  assert.equal(parsed?.model, "order-to-cash");
});

test("element without a name round-trips as name null", () => {
  const anchor: TodoAnchor = {
    notation: "bpmn",
    model: "p",
    file: null,
    elements: [{ id: "Task_X", name: null }],
    processVersion: null,
  };
  assert.deepEqual(parseAnchor(encodeAnchor(anchor))?.elements, [{ id: "Task_X", name: null }]);
});

test("the type round-trips, survives a re-anchoring and an anchor without it has no type key", () => {
  const typed: TodoAnchor = {
    notation: "bpmn",
    model: "order-to-cash",
    file: null,
    elements: [],
    processVersion: null,
    type: { id: "bug_report", name: "Bug report" },
  };
  const body = `${encodeAnchor(typed)}\n\n### Steps\n\nClick`;
  assert.deepEqual(parseAnchor(body), typed);
  const moved = replaceAnchor(body, { ...parseAnchor(body)!, model: "order-intake" });
  assert.deepEqual(parseAnchor(moved)?.type, typed.type);
  const plain = parseAnchor(encodeAnchor({ ...typed, type: undefined }))!;
  assert.ok(!("type" in plain), "a built-in todo parses exactly as before");
});

test("a type id or name with pipes/newlines is flattened at encode time", () => {
  const anchor: TodoAnchor = {
    notation: "bpmn",
    model: "p",
    file: null,
    elements: [],
    processVersion: null,
    type: { id: "odd|id", name: "Bug\nreport" },
  };
  assert.deepEqual(parseAnchor(encodeAnchor(anchor))?.type, { id: "odd id", name: "Bug report" });
  const closing = parseAnchor(`${encodeAnchor({ ...anchor, type: { id: "x", name: "Bug --> triage" } })}\n\ntext`);
  assert.deepEqual(closing?.type, { id: "x", name: "Bug -> triage" }, "a name cannot close the comment early");
});

test("missing/unclosed block yields null", () => {
  assert.equal(parseAnchor("just an ordinary issue body"), null);
  assert.equal(parseAnchor(""), null);
  assert.equal(parseAnchor("<!-- bpmiq:todo v1\nnotation: bpmn\nmodel: x"), null, "opened but never closed"); // legacy-name-ok
});

test("a block without its notation or its model yields null (the two required fields)", () => {
  assert.equal(parseAnchor("<!-- bpmiq:todo v1\nfile: some/file.bpmn\n-->"), null); // legacy-name-ok: frozen marker
  assert.equal(parseAnchor("<!-- bpmiq:todo v1\nnotation: wardley\n-->"), null); // legacy-name-ok: frozen marker
  assert.equal(parseAnchor("<!-- bpmiq:todo v1\nmodel: tea-shop\n-->"), null); // legacy-name-ok: frozen marker
  assert.equal(parseAnchor("<!-- bpmiq:todo v1\nprocess: order-to-cash\n-->"), null, "no process line any more"); // legacy-name-ok
});

test("every todo names its notation and model, a process too, and round-trips", () => {
  const anchor: TodoAnchor = {
    notation: "wardley",
    model: "tea-shop",
    file: "maps/tea-shop.owm",
    elements: [{ id: "component_tea", name: "Tea" }],
    processVersion: null,
  };
  const lines = encodeAnchor(anchor).split("\n");
  assert.deepEqual(lines.slice(1, 3), ["notation: wardley", "model: tea-shop"]);
  assert.deepEqual(parseAnchor(encodeAnchor(anchor)), anchor);
  const processAnchor: TodoAnchor = { ...anchor, notation: "bpmn", model: "order-to-cash", file: null, elements: [] };
  assert.deepEqual(encodeAnchor(processAnchor).split("\n").slice(1, 3), ["notation: bpmn", "model: order-to-cash"]);
  // re-anchoring keeps the notation
  const moved = parseAnchor(replaceAnchor(encodeAnchor(anchor), { ...anchor, model: "tea-house" }));
  assert.deepEqual([moved?.notation, moved?.model], ["wardley", "tea-house"]);
});

test("hand-written sloppy block parses (indentation, blank lines, unknown keys skipped)", () => {
  const body = [
    "Please double-check this.",
    "<!-- bpmiq:todo v1", // legacy-name-ok: frozen marker
    "   notation: bpmn",
    "   model: order-to-cash   ",
    "",
    "priority: high", // unknown key — skipped
    "not a key-value line", // no ': ' separator — skipped
    "  element: Task_1 ", // element without a name snapshot
    "  element: Task_2 | Angebot senden",
    "-->",
    "trailing text",
  ].join("\n");
  const anchor = parseAnchor(body);
  assert.equal(anchor?.model, "order-to-cash");
  assert.equal(anchor?.file, null);
  assert.equal(anchor?.processVersion, null);
  assert.deepEqual(anchor?.elements, [
    { id: "Task_1", name: null },
    { id: "Task_2", name: "Angebot senden" },
  ]);
});

test("the marker is frozen: a todo filed before any product rename keeps its anchor", () => {
  // Spelled in two halves ON PURPOSE: a search/replace of the product name
  // rewrites the constant and every fixture above in the same breath, and the
  // round-trips stay green — this spelling it cannot reach.
  const marker = "<!-- bpm" + "iq:todo v1";
  const anchor: TodoAnchor = {
    notation: "bpmn",
    model: "order-to-cash",
    file: "processes/order-to-cash.bpmn",
    elements: [{ id: "Task_CheckCredit", name: "Bonität prüfen" }],
    processVersion: null,
  };
  // what the platform writes into a tracker today …
  assert.equal(encodeAnchor(anchor).split("\n")[0], marker);
  // … and an issue body a customer's tracker already holds
  const body = [
    "Limit check is missing here.",
    "",
    marker,
    "notation: bpmn",
    "model: order-to-cash",
    "file: processes/order-to-cash.bpmn",
    "element: Task_CheckCredit | Bonität prüfen",
    "-->",
    "",
    "_Created by @petra_",
  ].join("\n");
  assert.deepEqual(parseAnchor(body), anchor);
  // the block is bookkeeping — it never reaches the text shown to people and agents
  assert.equal(stripAnchor(body), "Limit check is missing here.\n\n\n\n_Created by @petra_");
});

test("the marker is frozen in the content repo's issue template too (the second writer)", () => {
  // todos filed BY HAND go through this form, which pre-fills the block — and
  // the template is mirrored into the starter, so customer repos carry it
  const template = readFileSync(
    new URL("../../../process-documentation/.github/ISSUE_TEMPLATE/todo.yml", import.meta.url),
    "utf8",
  );
  assert.ok(template.includes("<!-- bpm" + "iq:todo v1"), "the template pre-fills the frozen marker");
  assert.equal(parseAnchor(template)?.model, "order-to-cash");
});
