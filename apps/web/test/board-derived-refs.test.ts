/**
 * The board's derived arrows (src/notations/board/derived-refs.ts), on the example content
 * repo's own models. Run by hand:
 *
 *   node --test apps/web/test/board-derived-refs.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { derivedArrows, derivedRefs, type ModelText, refsOfFile } from "../src/notations/board/derived-refs.ts";

const content = (path: string): string =>
  readFileSync(new URL(`../../../process-documentation/${path}`, import.meta.url), "utf8");

const ORDER: ModelText = { path: "processes/order-to-cash.bpmn", text: content("processes/order-to-cash.bpmn") };
const INVOICE: ModelText = {
  path: "processes/subprocesses/invoice-handling.bpmn",
  text: content("processes/subprocesses/invoice-handling.bpmn"),
};
const CREDIT: ModelText = {
  path: "processes/credit-limit-check.dmn",
  text: content("processes/credit-limit-check.dmn"),
};
const STORM: ModelText = { path: "processes/order-to-cash.storm", text: content("processes/order-to-cash.storm") };
const FILES = [ORDER, INVOICE, CREDIT, STORM];
const PATHS = FILES.map((file) => file.path);

test("order-to-cash calls invoice-handling and decides with credit-limit-check", () => {
  assert.deepEqual(derivedRefs(FILES), [
    { from: ORDER.path, to: INVOICE.path, rel: "calls", fromElement: "CallActivity_invoice_handling" },
    { from: ORDER.path, to: CREDIT.path, rel: "decides", fromElement: "Task_check_credit" },
  ]);
});

test("a reference names a stem AND a notation: a file of another notation with that stem is no target", () => {
  // order-to-cash.storm shares the stem of order-to-cash.bpmn
  const caller: ModelText = {
    path: "processes/caller.bpmn",
    text: ORDER.text.replace('calledElement="invoice-handling"', 'calledElement="order-to-cash"'),
  };
  assert.deepEqual(
    refsOfFile(caller, [caller.path, ORDER.path, STORM.path]).map((ref) => [ref.rel, ref.to]),
    [["calls", ORDER.path]],
  );
  assert.deepEqual(
    refsOfFile(ORDER, [ORDER.path, STORM.path]),
    [],
    "a target that is not among the files gives no arrow",
  );
});

test("every spelling of a decision link the platform follows, and the current text decides", () => {
  for (const spelling of ['decisionRef="credit-limit-check"', 'calledElement="credit-limit-check"']) {
    const text = ORDER.text.replace('calledDecision="credit-limit-check"', spelling);
    assert.notEqual(text, ORDER.text);
    assert.ok(
      refsOfFile({ path: ORDER.path, text }, PATHS).some((ref) => ref.rel === "decides" && ref.to === CREDIT.path),
      spelling,
    );
  }
  const unlinked = ORDER.text.replace(' calledElement="invoice-handling"', "");
  assert.deepEqual(
    refsOfFile({ path: ORDER.path, text: unlinked }, PATHS).map((ref) => ref.rel),
    ["decides"],
    "an edit that removes the link removes the arrow",
  );
});

test("a text that is no model gives no arrows and no error", () => {
  for (const text of ["", "<<<", ORDER.text.slice(0, 2000), "title Tea Shop\ncomponent Cup [0.7, 0.7]"]) {
    assert.doesNotThrow(() => refsOfFile({ path: ORDER.path, text }, PATHS));
  }
  assert.deepEqual(refsOfFile({ path: ORDER.path, text: "" }, PATHS), []);
  assert.deepEqual(refsOfFile(STORM, PATHS), [], "a notation without references is not parsed for them");
  assert.deepEqual(refsOfFile({ path: "notes/readme.md", text: "# x" }, PATHS), []);
});

test("an arrow runs from every node of the calling file to every node of the called file", () => {
  const refs = derivedRefs(FILES);
  const nodes = [
    { id: "d-order", file: ORDER.path },
    { id: "d-order-2", file: ORDER.path },
    { id: "d-invoice", file: INVOICE.path },
    { id: "d-credit", file: CREDIT.path },
    { id: "d-credit-2", file: CREDIT.path },
    { id: "d-note" },
    { id: "d-image", file: "assets/sketch.svg" },
  ];
  assert.deepEqual(
    derivedArrows(refs, nodes).map((arrow) => arrow.id),
    [
      "derived:calls:d-order:d-invoice",
      "derived:calls:d-order-2:d-invoice",
      "derived:decides:d-order:d-credit",
      "derived:decides:d-order:d-credit-2",
      "derived:decides:d-order-2:d-credit",
      "derived:decides:d-order-2:d-credit-2",
    ],
  );
  assert.deepEqual(derivedArrows(refs, [{ id: "d-order", file: ORDER.path }]), [], "no node of the called file");
  assert.deepEqual(derivedArrows(refs, [...nodes, ...nodes]).length, 6, "once per pair and relation");
});
