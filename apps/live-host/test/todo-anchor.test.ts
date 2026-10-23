/**
 * Todo anchor codec (src/domain/todo-anchor.ts) — the platform-owned block that
 * ties a tracker item to a process/model elements. Round-trips through
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
    process: "order-to-cash",
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
  const anchor: TodoAnchor = { process: "p1", file: null, elements: [], processVersion: null };
  const body = `Some intro text.\n\n${encodeAnchor(anchor)}\n\nDiscussion below.\n_Created by @petra_`;
  assert.deepEqual(parseAnchor(body), anchor);
});

test("names with pipes/newlines are flattened at encode time (line format stays unambiguous)", () => {
  const anchor: TodoAnchor = {
    process: "order-to-cash",
    file: null,
    elements: [{ id: "Task_A", name: "a|b\nc" }],
    processVersion: null,
  };
  const parsed = parseAnchor(encodeAnchor(anchor));
  assert.deepEqual(parsed?.elements, [{ id: "Task_A", name: "a b c" }]);
  assert.equal(parsed?.process, "order-to-cash");
});

test("element without a name round-trips as name null", () => {
  const anchor: TodoAnchor = {
    process: "p",
    file: null,
    elements: [{ id: "Task_X", name: null }],
    processVersion: null,
  };
  assert.deepEqual(parseAnchor(encodeAnchor(anchor))?.elements, [{ id: "Task_X", name: null }]);
});

test("the type round-trips, survives a re-anchoring and an anchor without it has no type key", () => {
  const typed: TodoAnchor = {
    process: "order-to-cash",
    file: null,
    elements: [],
    processVersion: null,
    type: { id: "bug_report", name: "Bug report" },
  };
  const body = `${encodeAnchor(typed)}\n\n### Steps\n\nClick`;
  assert.deepEqual(parseAnchor(body), typed);
  const moved = replaceAnchor(body, { ...parseAnchor(body)!, process: "order-intake" });
  assert.deepEqual(parseAnchor(moved)?.type, typed.type);
  const plain = parseAnchor(encodeAnchor({ ...typed, type: undefined }))!;
  assert.ok(!("type" in plain), "a built-in todo parses exactly as before");
});

test("a type id or name with pipes/newlines is flattened at encode time", () => {
  const anchor: TodoAnchor = {
    process: "p",
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
  assert.equal(parseAnchor("<!-- bpmiq:todo v1\nprocess: x"), null, "opened but never closed"); // legacy-name-ok
});

test("a block without a process line yields null (process is the one required field)", () => {
  assert.equal(parseAnchor("<!-- bpmiq:todo v1\nfile: some/file.bpmn\n-->"), null); // legacy-name-ok: frozen marker
});

test("hand-written sloppy block parses (indentation, blank lines, unknown keys skipped)", () => {
  const body = [
    "Please double-check this.",
    "<!-- bpmiq:todo v1", // legacy-name-ok: frozen marker
    "   process: order-to-cash   ",
    "",
    "priority: high", // unknown key — skipped
    "not a key-value line", // no ': ' separator — skipped
    "  element: Task_1 ", // element without a name snapshot
    "  element: Task_2 | Angebot senden",
    "-->",
    "trailing text",
  ].join("\n");
  const anchor = parseAnchor(body);
  assert.equal(anchor?.process, "order-to-cash");
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
    process: "order-to-cash",
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
    "process: order-to-cash",
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
  assert.equal(parseAnchor(template)?.process, "order-to-cash");
});
