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
  anchor: { process: "order", file: null, elements: [], processVersion: null, ...(type ? { type } : {}) },
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
