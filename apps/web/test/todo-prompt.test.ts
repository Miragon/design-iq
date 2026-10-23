/**
 * The Implement work order (src/mcp-app/todo-prompt.ts) names the type a todo
 * was filed with (#313); a plain todo's order reads as before.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { TodoWire } from "@designiq/contracts/live-host";

import { implementPrompt } from "../src/mcp-app/todo-prompt.ts";

const TARGET = { repo: "acme/models", path: "processes/order.bpmn" };
const todo = (type?: { id: string; name: string }): TodoWire => ({
  id: "7",
  url: "https://tracker.test/7",
  title: "[Bug]: Saving fails",
  body: "### Steps to reproduce\n\nClick save",
  state: "open",
  anchor: {
    notation: "bpmn",
    model: "order",
    file: null,
    elements: [],
    processVersion: null,
    ...(type ? { type } : {}),
  },
  author: "petra",
  assignees: [],
  createdAt: "2026-10-23T00:00:00Z",
});

test("a typed todo's work order names its type, right under the title", () => {
  const lines = implementPrompt(todo({ id: "bug_report", name: "Bug report" }), TARGET).split("\n");
  const title = lines.indexOf("Todo #7 — [Bug]: Saving fails");
  assert.equal(lines[title + 1], 'Type: Bug report (filed with the "bug_report" issue template)');
});

test("a plain todo's work order has no type line", () => {
  assert.ok(!implementPrompt(todo(), TARGET).includes("Type:"));
});

test("a process's work order names the BPMN tools, any other model's the generic ones", () => {
  const process = implementPrompt(todo(), TARGET);
  assert.match(process, /get_bpmn_xml\(\{repo: "acme\/models", path: "processes\/order.bpmn"\}\)/);
  assert.match(process, /Model: processes\/order.bpmn \(process "order"\)/);
  const map: TodoWire = {
    ...todo(),
    anchor: {
      notation: "wardley",
      model: "tea",
      file: "maps/tea.owm",
      elements: [{ id: "cmp_kettle", name: "Kettle" }],
      processVersion: null,
    },
  };
  const order = implementPrompt(map, { repo: "acme/models", path: "maps/tea.owm" });
  assert.match(order, /Model: maps\/tea.owm \(Wardley Map "tea"\)/);
  assert.match(order, /Anchored elements: cmp_kettle \("Kettle"\)/);
  assert.match(order, /get_model_content\(\{repo: "acme\/models", path: "maps\/tea.owm"\}\)/);
  assert.match(order, /validate_model\(\{content, /);
  assert.match(order, /save_model_content\(\{repo: "acme\/models", path: "maps\/tea.owm", content, baseVersion\}\)/);
  assert.ok(!/bpmn/i.test(order), "no BPMN tool in a map's order");
  assert.match(order, /don't guess at the model's semantics/);
});
