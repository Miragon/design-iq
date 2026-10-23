/**
 * The todo form as data (src/lib/todo-form.ts, #313), shared by the SPA dialog
 * and the widget: the type a form opens with, the first values, what the
 * create call sends and the inline flags of the shared check.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { TodoWire } from "@designiq/contracts/live-host";
import { BUILT_IN_TODO_TYPE, type TodoField, type TodoType } from "@designiq/contracts/todo-types";

import {
  defaultTodoType,
  fieldFlags,
  formFields,
  initialFieldValues,
  todoTypeRequest,
  toggleOption,
} from "../src/lib/todo-form.ts";
import { todoTypeLabel } from "../src/lib/todo-view.ts";

const field = (over: Partial<TodoField> & Pick<TodoField, "id" | "kind">): TodoField => ({
  label: over.id,
  description: null,
  placeholder: null,
  value: null,
  options: [],
  multiple: false,
  required: false,
  ...over,
});

const BUG: TodoType = {
  id: "bug",
  name: "Bug report",
  description: "",
  titlePrefix: "[Bug]: ",
  fields: [
    field({ id: "hint", kind: "markdown", value: "**Thanks**" }),
    field({ id: "repro", kind: "textarea", label: "Steps", required: true, value: "1. " }),
    field({
      id: "mode",
      kind: "dropdown",
      required: true,
      multiple: true,
      value: "SaaS",
      options: [
        { label: "Docker", required: false },
        { label: "SaaS", required: false },
      ],
    }),
    field({ id: "terms", kind: "checkboxes", options: [{ label: "I searched", required: true }] }),
  ],
};

test("the built-in Todo opens first when offered, else the first template", () => {
  assert.equal(defaultTodoType([BUG, BUILT_IN_TODO_TYPE]), BUILT_IN_TODO_TYPE);
  assert.equal(defaultTodoType([BUG]), BUG);
  assert.equal(defaultTodoType([]), undefined);
});

test("markdown hints are not fields to fill; first values come from the template", () => {
  assert.deepEqual(
    formFields(BUG).map((f) => f.id),
    ["repro", "mode", "terms"],
  );
  assert.deepEqual(initialFieldValues(BUG), { repro: "1. ", mode: ["SaaS"], terms: [] });
  assert.deepEqual(initialFieldValues(BUILT_IN_TODO_TYPE), { description: "" });
});

test("the built-in sends today's request (body, no type); a template sends its type and fields", () => {
  assert.deepEqual(todoTypeRequest(BUILT_IN_TODO_TYPE, { description: "  Free text " }), { body: "Free text" });
  assert.deepEqual(todoTypeRequest(BUILT_IN_TODO_TYPE, { description: " " }), {});
  assert.deepEqual(todoTypeRequest(BUG, { repro: "x" }), { type: "bug", fields: { repro: "x" } });
});

test("the shared check flags each field inline, and a filled field loses its flag", () => {
  const values = { ...initialFieldValues(BUG), repro: " " };
  assert.deepEqual(fieldFlags(BUG, values), { repro: "Required", terms: "Required" });
  assert.deepEqual(fieldFlags(BUG, { ...values, repro: "Click", terms: ["I searched"] }), {});
});

test("toggling an option adds it once and removes it", () => {
  assert.deepEqual(toggleOption(undefined, "a", true), ["a"]);
  assert.deepEqual(toggleOption(["a"], "a", true), ["a"]);
  assert.deepEqual(toggleOption(["a", "b"], "a", false), ["b"]);
});

test("a todo shows the type it was filed with; a plain one shows none", () => {
  const todo = (anchor: TodoWire["anchor"]): TodoWire => ({
    id: "1",
    url: "",
    title: "t",
    body: "",
    state: "open",
    anchor,
    author: null,
    assignees: [],
    createdAt: "",
  });
  const anchor = { process: "p", file: null, elements: [], processVersion: null };
  assert.equal(todoTypeLabel(todo({ ...anchor, type: { id: "bug", name: "Bug report" } })), "Bug report");
  assert.equal(todoTypeLabel(todo(anchor)), null);
  assert.equal(todoTypeLabel(todo(null)), null);
});
