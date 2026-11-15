/**
 * The board in the validator: a text its canvas would not write back is an
 * ERROR, a model it shows that is not in the repository a WARN.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkModel, checkModelBaseline } from "../src/validate.ts";

const HEADER = `{"format":"structured-model","meta":{"title":"Workshop","version":1},"version":1}`;
const ORDER = `{"file":"processes/order-to-cash.bpmn","height":540,"id":"n_order","kind":"node","type":"model","width":940,"x":0,"y":0,"z":"a"}`;
const CREDIT = `{"file":"processes/credit-limit-check.dmn","height":440,"id":"n_credit","kind":"node","type":"model","width":560,"x":0,"y":0,"z":"b"}`;
const NOTE = `{"height":160,"id":"n_note","kind":"node","text":"A note","type":"text","width":280,"x":0,"y":0,"z":"c"}`;

test("a board the canvas reads back is clean; so is an empty file, a new board", () => {
  assert.deepEqual(checkModelBaseline(`${HEADER}\n${NOTE}\n`, { file: "boards/a.board", notation: "board" }), []);
  assert.deepEqual(checkModelBaseline("", { file: "boards/a.board", notation: "board" }), []);
});

test("a line that is no JSON, a repeated id and a missing header are ERRORs with the line they are in", () => {
  const cut = checkModelBaseline(`${HEADER}\n${NOTE.slice(0, 30)}\n`, { file: "boards/a.board", notation: "board" });
  assert.deepEqual(cut, [
    { severity: "ERROR", ruleId: "board/parse", file: "boards/a.board", message: "line 2 is no JSON" },
  ]);
  const twice = checkModelBaseline(`${HEADER}\n${NOTE}\n${NOTE}\n`, { file: "boards/a.board", notation: "board" });
  assert.equal(twice[0]?.message, "line 3 repeats the element id n_note");
  const headless = checkModelBaseline(`${NOTE}\n`, { file: "boards/a.board", notation: "board" });
  assert.equal(headless[0]?.message, "the text has no header line: not a board file");
});

test("a model the board shows that is not in the repository is a WARN; one that moved to another folder resolves", () => {
  const board = `${HEADER}\n${CREDIT}\n${NOTE}\n${ORDER}\n`;
  // the process exists (in whatever folder), the decision does not
  const modelIds = new Map([["bpmn", new Set(["order-to-cash"])]]);
  assert.deepEqual(checkModel(board, { path: "boards/a.board", modelIds }), [
    {
      severity: "WARN",
      ruleId: "refs/dangling",
      file: "boards/a.board",
      message:
        "board node n_credit shows dmn 'credit-limit-check', which is not a model in this repo (deleted or renamed?)",
    },
  ]);
  const all = new Map([
    ["bpmn", new Set(["order-to-cash"])],
    ["dmn", new Set(["credit-limit-check"])],
  ]);
  assert.deepEqual(checkModel(board, { path: "boards/a.board", modelIds: all }), []);
  // without a view of the repository (one file alone) there is no verdict on references
  assert.deepEqual(checkModel(board, { path: "boards/a.board" }), []);
});
