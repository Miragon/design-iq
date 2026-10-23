/**
 * The Todos card as data (src/mcp-app/core/todos-view.ts): which ONE thing
 * the list area shows (the error callout is exclusive with the empty text,
 * the skeleton only while nothing is listed), the counts and names, and the
 * copy of every outcome todos.ts surfaces.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { TodoWire } from "@designiq/contracts/live-host";

import {
  addTodoTitle,
  anchorLabel,
  anchorTitle,
  closeError,
  EMPTY_HINT,
  filedAgo,
  headCount,
  implementRefused,
  implementSent,
  loadError,
  LOADING_TODOS,
  type TodoListState,
  todoListView,
  todoMeta,
  todosBadge,
} from "../src/mcp-app/core/todos-view.ts";

const todo = (id: string, elements: string[] = [], extra: Partial<TodoWire> = {}): TodoWire => ({
  id,
  url: `https://example.test/issues/${id}`,
  title: `Todo ${id}`,
  body: "",
  state: "open",
  anchor: elements.length
    ? {
        notation: "bpmn",
        model: "order-to-cash",
        file: "processes/order-to-cash.bpmn",
        elements: elements.map((e) => ({ id: e, name: null })),
        processVersion: null,
      }
    : null,
  author: "anna",
  assignees: [],
  createdAt: "2026-10-01T09:00:00Z",
  ...extra,
});

const three = [todo("38", ["Task_a", "Gateway_b"]), todo("41", ["Task_c"]), todo("42")];
const base: TodoListState = { todos: three, filter: null, loading: false, failed: false, canWrite: true };

test("the list area: rows, filtered rows, and the two empty states", () => {
  assert.deepEqual(todoListView(base), { kind: "rows", rows: three }, "everything listed, newest order kept");
  const filtered = todoListView({ ...base, filter: "Task_c" });
  assert.equal(filtered.kind, "rows");
  assert.deepEqual(filtered.kind === "rows" && filtered.rows.map((t) => t.id), ["41"]);
  assert.deepEqual(todoListView({ ...base, filter: "Task_gone" }), {
    kind: "filtered-empty",
    title: "No open todos on this element.",
  });
  assert.deepEqual(todoListView({ ...base, todos: [] }), {
    kind: "empty",
    title: "No open todos for this process.",
    hint: EMPTY_HINT,
    add: true,
  });
});

test("read-only: the empty state offers no Add todo and no hint about adding", () => {
  assert.deepEqual(todoListView({ ...base, todos: [], canWrite: false }), {
    kind: "empty",
    title: "No open todos for this process.",
    add: false,
  });
});

test("the skeleton shows only while nothing is listed yet", () => {
  assert.deepEqual(todoListView({ ...base, todos: [], loading: true }), { kind: "loading", text: LOADING_TODOS });
  // a refresh of a filled list keeps the rows (no flash back to the skeleton)
  assert.equal(todoListView({ ...base, loading: true }).kind, "rows");
});

test("a tracker error is exclusive with the empty text — the callout speaks alone", () => {
  assert.deepEqual(todoListView({ ...base, todos: [], failed: true }), { kind: "error" });
  assert.deepEqual(todoListView({ ...base, filter: "Task_gone", failed: true }), { kind: "error" });
  // a failed refresh over a known list keeps the (stale) rows under the callout
  assert.equal(todoListView({ ...base, failed: true }).kind, "rows");
  // the skeleton wins while the retry runs
  assert.equal(todoListView({ ...base, todos: [], failed: true, loading: true }).kind, "loading");
});

test("the head count: the total, or 'n of total' while a badge filters", () => {
  assert.equal(headCount(three, null), "3");
  assert.equal(headCount(three, "Task_a"), "1 of 3");
  assert.equal(headCount(three, "Task_gone"), "0 of 3");
});

test("the toggle badge: the count and the name once the label drops", () => {
  assert.deepEqual(todosBadge(3), { count: 3, ariaLabel: "Todos, 3 open" });
  assert.deepEqual(todosBadge(0), { count: 0, ariaLabel: "Todos, none open" });
  assert.deepEqual(todosBadge(0, true), { count: 0, ariaLabel: "Todos, could not load" });
  assert.equal(todosBadge(2, true).ariaLabel, "Todos, 2 open", "a stale list still has a count");
});

test("Add todo carries the SPA's titles", () => {
  assert.equal(addTodoTitle(0), "Create a todo on the whole process (no element selected)");
  assert.equal(addTodoTitle(0, "Wardley Map"), "Create a todo on the whole Wardley Map (no element selected)");
  assert.equal(addTodoTitle(1), "Anchor a todo to the 1 selected element");
  assert.equal(addTodoTitle(3), "Anchor a todo to the 3 selected elements");
});

test("the meta line and its age title", () => {
  assert.equal(todoMeta(todo("38")), "#38 · @anna");
  assert.equal(todoMeta(todo("38", [], { author: null })), "#38");
  const now = Date.parse("2026-10-10T09:00:00Z");
  assert.equal(filedAgo("2026-10-01T09:00:00Z", now), "Filed last week");
  assert.equal(filedAgo("2026-10-09T09:00:00Z", now), "Filed yesterday");
  assert.equal(filedAgo("2026-10-10T06:00:00Z", now), "Filed 3 hours ago");
  assert.equal(filedAgo("2026-10-10T08:59:30Z", now), "Filed just now");
  assert.equal(filedAgo("2025-08-01T09:00:00Z", now), "Filed last year");
  assert.equal(filedAgo("not a date", now), undefined);
});

test("anchor chips: the name snapshot, else the id; retitled once the element is gone", () => {
  assert.equal(anchorLabel({ id: "Task_a", name: "Check credit limit" }), "Check credit limit");
  assert.equal(anchorLabel({ id: "Task_a", name: null }), "Task_a");
  assert.equal(anchorTitle({ id: "Task_a", name: "Check credit limit" }), "Show Check credit limit on the canvas");
  assert.equal(
    anchorTitle({ id: "Task_a", name: "Check credit limit" }, true),
    "Check credit limit — no longer in this diagram",
  );
});

test("outcome copy: the callout and the Implement toasts", () => {
  assert.equal(loadError("401: Bad credentials"), "Could not load todos: 401: Bad credentials");
  assert.equal(closeError("38", "502"), "Could not close #38: 502");
  assert.deepEqual(implementSent("38"), { tone: "info", title: "Sent #38 to the assistant", key: "implement-38" });

  let opened = 0;
  const refused = implementRefused("38", () => opened++);
  assert.equal(refused.tone, "danger");
  assert.equal(refused.title, "Your client refused the prompt");
  assert.equal(refused.detail, "Open #38 in the tracker and ask there.");
  assert.equal(refused.action?.label, "Open #38");
  refused.action?.run();
  assert.equal(opened, 1, "the action opens the tracker item");

  const threw = implementRefused("38", () => undefined, "bridge closed");
  assert.equal(threw.title, "Could not hand #38 to the assistant");
  assert.equal(threw.detail, "bridge closed");
  assert.equal(threw.key, refused.key, "a second attempt replaces the first toast");
});
