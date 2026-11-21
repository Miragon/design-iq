/**
 * The board in the validator: a text its canvas would not write back is an
 * ERROR (board/parse, the board codec's strict reader), a model it shows
 * that is not in the repository a WARN, and so are a path that names where a
 * model was before it moved and a board shown on a board.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { templateFor } from "@designiq/notations/templates";

import { checkModel, checkModelBaseline, checkSchemaModel } from "../src/validate.ts";

const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const runCliIn = (root: string) => spawnSync(process.execPath, [CLI, "--root", root], { encoding: "utf8" });

const HEADER = `{"format":"structured-model","meta":{"title":"Workshop","version":1},"version":1}`;
const ORDER = `{"file":"processes/order-to-cash.bpmn","height":540,"id":"n_order","kind":"node","type":"model","width":940,"x":0,"y":0,"z":"a"}`;
const CREDIT = `{"file":"processes/credit-limit-check.dmn","height":440,"id":"n_credit","kind":"node","type":"model","width":560,"x":0,"y":0,"z":"b"}`;
const NOTE = `{"height":160,"id":"n_note","kind":"node","text":"A note","type":"text","width":280,"x":0,"y":0,"z":"c"}`;
const NESTED = `{"file":"processes/retro.board","height":400,"id":"n_retro","kind":"node","type":"model","width":600,"x":0,"y":0,"z":"d"}`;

const board = (...lines: string[]): string => `${[HEADER, ...lines].join("\n")}\n`;

test("a board the canvas reads back is clean; so is an empty file, a new board", () => {
  assert.deepEqual(checkModelBaseline(board(NOTE), { file: "boards/a.board", notation: "board" }), []);
  assert.deepEqual(checkModelBaseline("", { file: "boards/a.board", notation: "board" }), []);
  const template = templateFor("board", "a", "A") ?? "";
  assert.deepEqual(checkModel(template, { path: "processes/a.board" }), []);
});

test("a line that is no JSON, a repeated id and a missing header are ERRORs with the line they are in", () => {
  const cut = checkModelBaseline(`${HEADER}\n${NOTE.slice(0, 30)}\n`, { file: "boards/a.board", notation: "board" });
  assert.deepEqual(cut, [
    { severity: "ERROR", ruleId: "board/parse", file: "boards/a.board", message: "line 2 is no JSON" },
  ]);
  const twice = checkModelBaseline(board(NOTE, NOTE), { file: "boards/a.board", notation: "board" });
  assert.equal(twice[0]?.message, "line 3 repeats the element id n_note");
  const headless = checkModelBaseline(`${NOTE}\n`, { file: "boards/a.board", notation: "board" });
  assert.equal(headless[0]?.message, "the text has no header line: not a board file");
});

test("a board is read as JSON lines, never as one JSON document: the schema check and the JSON gate stay off it", () => {
  // two lines are no single JSON value; the board's own reader takes them
  assert.deepEqual(checkSchemaModel(board(NOTE), { file: "boards/a.board", notation: "board" }), []);
  assert.deepEqual(checkModel(board(NOTE), { path: "processes/a.board" }), []);
  // and its refusal is the one finding of a broken board, whatever the context
  const broken = `${HEADER}\n{"id":"n_note"\n${ORDER}\n`;
  assert.deepEqual(checkModel(broken, { path: "processes/a.board", modelIds: new Map() }), [
    { severity: "ERROR", ruleId: "board/parse", file: "processes/a.board", message: "line 2 is no JSON" },
  ]);
});

test("a model the board shows that is not in the repository is a WARN; one that moved to another folder resolves", () => {
  const text = board(CREDIT, NOTE, ORDER);
  // the process exists (in whatever folder), the decision does not
  const modelIds = new Map([["bpmn", new Set(["order-to-cash"])]]);
  assert.deepEqual(checkModel(text, { path: "boards/a.board", modelIds }), [
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
  assert.deepEqual(checkModel(text, { path: "boards/a.board", modelIds: all }), []);
  // without a view of the repository (one file alone) there is no verdict on references
  assert.deepEqual(checkModel(text, { path: "boards/a.board" }), []);
});

test("a path that names where a model was before it moved is a WARN that says where it is now", () => {
  const models = [
    { path: "processes/sales/order-to-cash.bpmn", notation: "bpmn", id: "order-to-cash" },
    { path: "processes/credit-limit-check.dmn", notation: "dmn", id: "credit-limit-check" },
  ];
  // the models alone are the repo view: their ids resolve, their paths tell a move
  assert.deepEqual(checkModel(board(CREDIT, ORDER), { path: "processes/a.board", models }), [
    {
      severity: "WARN",
      ruleId: "refs/stale-path",
      file: "processes/a.board",
      message:
        "board node n_order shows 'processes/order-to-cash.bpmn', which moved to 'processes/sales/order-to-cash.bpmn'",
    },
  ]);
  // where it is listed, nothing to say
  const here = [{ path: "processes/order-to-cash.bpmn", notation: "bpmn", id: "order-to-cash" }, models[1]!];
  assert.deepEqual(checkModel(board(CREDIT, ORDER), { path: "processes/a.board", models: here }), []);
  // with ids alone (an older caller) a moved model still resolves, silently
  const modelIds = new Map([
    ["bpmn", new Set(["order-to-cash"])],
    ["dmn", new Set(["credit-limit-check"])],
  ]);
  assert.deepEqual(checkModel(board(CREDIT, ORDER), { path: "processes/a.board", modelIds }), []);
});

test("a shown file outside the models folder is named as such, not as deleted", () => {
  const outside = `{"file":"elsewhere/notes.md","id":"n_doc","kind":"node","type":"model"}`;
  const ctx = { path: "processes/a.board", models: [], modelsFolder: "processes" };
  assert.deepEqual(checkModel(board(outside, CREDIT), ctx), [
    {
      severity: "WARN",
      ruleId: "refs/dangling",
      file: "processes/a.board",
      message:
        "board node n_credit shows dmn 'credit-limit-check', which is not a model in this repo (deleted or renamed?)",
    },
    {
      severity: "WARN",
      ruleId: "refs/dangling",
      file: "processes/a.board",
      message:
        "board node n_doc shows 'elsewhere/notes.md', which is outside the models folder 'processes' (only the files there are models of this repo)",
    },
  ]);
  // with the models at the root, nothing is outside
  const root = checkModel(board(outside), { path: "a.board", models: [], modelsFolder: "." });
  assert.match(
    root?.[0]?.message ?? "",
    /markdown 'notes', which is not a model in this repo \(deleted or renamed\?\)/,
  );
  // a folder that only starts like the models folder is outside it
  const lookalike = `{"file":"processes-old/x.bpmn","id":"n_x","kind":"node","type":"model"}`;
  assert.match(checkModel(board(lookalike), ctx)?.[0]?.message ?? "", /'processes-old\/x\.bpmn', which is outside/);
});

test("a shown file outside the models folder is named as such even where a model of its stem is in the folder", () => {
  // processes/order-to-cash.bpmn exists: docs/order-to-cash.bpmn resolves by id, yet it is not that file, and nothing moved
  const models = [{ path: "processes/order-to-cash.bpmn", notation: "bpmn", id: "order-to-cash" }];
  const ctx = { path: "processes/a.board", models, modelsFolder: "processes" };
  const outside = (file: string) => `{"file":"${file}","id":"n_doc","kind":"node","type":"model"}`;
  assert.deepEqual(checkModel(board(outside("docs/order-to-cash.bpmn")), ctx), [
    {
      severity: "WARN",
      ruleId: "refs/dangling",
      file: "processes/a.board",
      message:
        "board node n_doc shows 'docs/order-to-cash.bpmn', which is outside the models folder 'processes' (only the files there are models of this repo)",
    },
  ]);
  // a path that climbs out of the folder is outside it too; one that only spells the folder oddly is in it
  assert.match(
    checkModel(board(outside("processes/../docs/order-to-cash.bpmn")), ctx)?.[0]?.message ?? "",
    /which is outside the models folder/,
  );
  assert.match(
    checkModel(board(outside("./processes/old/order-to-cash.bpmn")), ctx)?.[0]?.message ?? "",
    /which moved to 'processes\/order-to-cash\.bpmn'/,
  );
  // with the models at the root, the same path is in the folder: a stale path
  const root = checkModel(board(outside("docs/order-to-cash.bpmn")), { ...ctx, modelsFolder: "." });
  assert.equal(root?.[0]?.ruleId, "refs/stale-path");
});

test("a board shown on a board is a WARN of its own, with or without a view of the repository", () => {
  const nested = (ctx: Partial<Parameters<typeof checkModel>[1]>) =>
    checkModel(board(NESTED, NOTE), { path: "processes/a.board", ...ctx });
  const expected = [
    {
      severity: "WARN",
      ruleId: "board/nested-board",
      file: "processes/a.board",
      message: "board node n_retro shows the board 'processes/retro.board', and a board cannot be shown on a board",
    },
  ];
  assert.deepEqual(nested({}), expected);
  // it is no reference, so it never dangles as one, even when that board is gone
  assert.deepEqual(nested({ models: [], modelsFolder: "processes" }), expected);
  // a broken board has its ERROR and nothing else
  assert.deepEqual(
    checkModel(`${HEADER}\n${NESTED}\n${NESTED}\n`, { path: "processes/a.board" })?.map((f) => f.ruleId),
    ["board/parse"],
  );
});

test("the CLI: a board's ERROR fails the run, its WARNs are reported with the repo's view (moved, gone, outside, nested)", () => {
  const root = mkdtempSync(join(tmpdir(), "designiq-board-cli-"));
  writeFileSync(join(root, "designiq.yml"), "models: processes\n");
  mkdirSync(join(root, "processes", "sales"), { recursive: true });
  writeFileSync(
    join(root, "processes", "sales", "order-to-cash.bpmn"),
    templateFor("bpmn", "order-to-cash", "O") ?? "",
  );
  writeFileSync(join(root, "processes", "retro.board"), templateFor("board", "retro", "Retro") ?? "");
  const outside = `{"file":"elsewhere/notes.md","id":"n_doc","kind":"node","type":"model"}`;
  writeFileSync(join(root, "processes", "workshop.board"), board(CREDIT, outside, ORDER, NESTED));
  const clean = runCliIn(root);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  for (const line of [
    "[WARN] processes/workshop.board: board node n_retro shows the board 'processes/retro.board', and a board cannot be shown on a board",
    "[WARN] processes/workshop.board: board node n_credit shows dmn 'credit-limit-check', which is not a model in this repo (deleted or renamed?)",
    "[WARN] processes/workshop.board: board node n_doc shows 'elsewhere/notes.md', which is outside the models folder 'processes' (only the files there are models of this repo)",
    "[WARN] processes/workshop.board: board node n_order shows 'processes/order-to-cash.bpmn', which moved to 'processes/sales/order-to-cash.bpmn'",
  ]) {
    assert.ok(clean.stdout.includes(line), `missing: ${line}\n${clean.stdout}`);
  }
  assert.match(clean.stdout, /1 process\(es\), 2 other model\(s\) checked/);

  writeFileSync(join(root, "processes", "retro.board"), `${HEADER}\n${NOTE}\n${NOTE}\n`);
  const failed = runCliIn(root);
  assert.equal(failed.status, 1, failed.stdout);
  assert.ok(
    failed.stdout.includes("[ERROR] processes/retro.board: line 3 repeats the element id n_note"),
    failed.stdout,
  );
});
