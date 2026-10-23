/**
 * The one required-field check (#313) the Live Host, the web dialog and the
 * widget share: missing values, values outside a field's options, and field
 * ids the type does not have.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUILT_IN_TODO_TYPE,
  fieldProblemsMessage,
  isBuiltInTodoType,
  type TodoField,
  type TodoType,
  validateTodoFields,
} from "../src/todo-types.ts";

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
  id: "bug_report",
  name: "Bug report",
  description: "",
  titlePrefix: "[Bug]: ",
  fields: [
    field({ id: "intro", kind: "markdown", value: "Thanks!" }),
    field({ id: "repro", kind: "textarea", label: "Steps to reproduce", required: true }),
    field({
      id: "mode",
      kind: "dropdown",
      label: "Deploy mode",
      required: true,
      options: [
        { label: "Docker", required: false },
        { label: "SaaS", required: false },
      ],
    }),
    field({
      id: "terms",
      kind: "checkboxes",
      label: "Checklist",
      options: [
        { label: "I searched", required: true },
        { label: "Optional", required: false },
      ],
    }),
    field({ id: "logs", kind: "textarea", label: "Logs" }),
  ],
};

test("a complete form has no problems; optional fields and markdown hints may stay empty", () => {
  assert.deepEqual(validateTodoFields(BUG, { repro: "Click", mode: "SaaS", terms: ["I searched"] }), []);
});

test("missing required fields are listed by id and label, blank text counts as missing", () => {
  assert.deepEqual(validateTodoFields(BUG, { repro: "   " }), [
    { id: "repro", label: "Steps to reproduce", reason: "missing" },
    { id: "mode", label: "Deploy mode", reason: "missing" },
    { id: "terms", label: "Checklist", reason: "missing" },
  ]);
});

test("values outside the options, a second value of a single dropdown and unknown ids are problems", () => {
  assert.deepEqual(
    validateTodoFields(BUG, { repro: "x", mode: ["Docker", "SaaS"], terms: ["I searched", "Nope"], steps: "x" }),
    [
      { id: "mode", label: "Deploy mode", reason: "invalid" },
      { id: "terms", label: "Checklist", reason: "invalid" },
      { id: "steps", label: "steps", reason: "unknown" },
    ],
  );
  assert.deepEqual(validateTodoFields(BUG, { repro: ["a"], mode: "SaaS", terms: ["I searched"] }), [
    { id: "repro", label: "Steps to reproduce", reason: "invalid" },
  ]);
});

test("the message names the form and every field a person sees and an agent passes", () => {
  const message = fieldProblemsMessage(BUG, validateTodoFields(BUG, { steps: "x" }));
  assert.equal(
    message,
    [
      "The Bug report form is not complete:",
      "- Steps to reproduce (repro) is required",
      "- Deploy mode (mode) is required",
      "- Checklist (terms) is required",
      "- steps is not a field of this type",
    ].join("\n"),
  );
});

test("the built-in Todo needs nothing but a title", () => {
  assert.deepEqual(validateTodoFields(BUILT_IN_TODO_TYPE, {}), []);
  assert.ok(isBuiltInTodoType(BUILT_IN_TODO_TYPE));
  assert.ok(!isBuiltInTodoType(BUG));
});

test("a field id named like an Object.prototype key reads only its own value", () => {
  const odd: TodoType = { ...BUG, fields: [field({ id: "constructor", kind: "input", required: true })] };
  assert.deepEqual(validateTodoFields(odd, {}), [{ id: "constructor", label: "constructor", reason: "missing" }]);
});
