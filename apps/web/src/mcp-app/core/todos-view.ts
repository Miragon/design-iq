/**
 * The Todos card as data (spec §7.1, §6.3): which ONE thing the list area
 * shows, the head count, the toggle's badge, the Add todo title and the copy
 * of every outcome — todos.ts renders it. The tracker error is exclusive with
 * the empty text, the skeleton shows only while nothing is listed yet.
 * Shares the SPA's vocabulary through lib/todo-view.ts.
 * DOM-free (`.ts` relative imports): node --test loads it.
 */
import type { TodoWire } from "@designiq/contracts/live-host";

import { emptyTodoMessage, todosForElement } from "../../lib/todo-view.ts";

export { addTodoTitle } from "../../lib/todo-view.ts";
import type { PanelBadge } from "./feedback.ts";
import type { ToastSpec } from "./lifecycle.ts";

export const LOADING_TODOS = "Loading todos…";
export const EMPTY_HINT = "Select an element, then add a todo to anchor it there.";
export const READONLY_FOOT = "Read-only here: filing and closing todos is disabled.";
/** the chip of a todo on the whole model ("Whole process", "Whole Wardley Map", …) */
export const wholeModel = (noun: string): string => `Whole ${noun}`;
export const wholeModelTitle = (noun: string): string => `Not anchored to an element — about the ${noun} as a whole`;
export const IMPLEMENT_TITLE = "Hand this todo to the assistant in this chat";

export interface TodoListState {
  todos: TodoWire[];
  /** the element a canvas badge narrowed the list to */
  filter: string | null;
  /** the anchor ids that land on it (TodoCanvas.anchorIds); absent = its id alone */
  filterIds?: readonly string[];
  /** how the model is called ("process", "Wardley Map", …); absent = "process" */
  noun?: string;
  loading: boolean;
  /** the last list call failed (the callout says why) */
  failed: boolean;
  /** create_todo is there — the empty state offers Add todo */
  canWrite: boolean;
}

export type TodoListView =
  | { kind: "loading"; text: string }
  /** the callout speaks alone — no empty text under it */
  | { kind: "error" }
  | { kind: "rows"; rows: TodoWire[] }
  | { kind: "filtered-empty"; title: string }
  | { kind: "empty"; title: string; hint?: string; add: boolean };

export function todoListView(s: TodoListState): TodoListView {
  if (s.loading && s.todos.length === 0) return { kind: "loading", text: LOADING_TODOS };
  const rows = s.filter ? todosForElement(s.todos, s.filterIds ?? s.filter) : s.todos;
  if (rows.length > 0) return { kind: "rows", rows };
  if (s.failed) return { kind: "error" };
  if (s.filter) return { kind: "filtered-empty", title: emptyTodoMessage(true) };
  return {
    kind: "empty",
    title: emptyTodoMessage(false, s.noun),
    ...(s.canWrite ? { hint: EMPTY_HINT } : {}),
    add: s.canWrite,
  };
}

/** the head's count: "3", or "1 of 3" while a badge filters the list (by
 *  the anchor ids that land on its element, `filterIds`) */
export function headCount(todos: TodoWire[], filter: string | null, filterIds?: readonly string[]): string {
  return filter ? `${todosForElement(todos, filterIds ?? filter).length} of ${todos.length}` : String(todos.length);
}

/** the TR toggle's chip and its name once the label drops (degrade step 4);
 *  a tracker that refused has no count to speak of */
export function todosBadge(count: number, failed = false): PanelBadge {
  if (failed && count === 0) return { count, ariaLabel: "Todos, could not load" };
  return { count, ariaLabel: count === 0 ? "Todos, none open" : `Todos, ${count} open` };
}

/** "#38 · @octocat" */
export function todoMeta(todo: Pick<TodoWire, "id" | "author">): string {
  return `#${todo.id}${todo.author ? ` · @${todo.author}` : ""}`;
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** the meta line's title: "Filed 3 days ago" (English UI copy); undefined for an unreadable date */
export function filedAgo(createdAt: string, now: number = Date.now()): string | undefined {
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return `Filed ${rtf.format(-Math.floor(seconds / size), unit)}`;
  }
  return "Filed just now";
}

/** an anchor chip: its label, and the title it gets once the element is gone */
export const anchorLabel = (el: { id: string; name?: string | null }): string => el.name || el.id;
export const anchorTitle = (el: { id: string; name?: string | null }, gone = false): string =>
  gone ? `${anchorLabel(el)} — no longer in this diagram` : `Show ${anchorLabel(el)} on the canvas`;

// ── outcomes: the callout, the form, the toasts ─────────────────────────────

export const loadError = (message: string): string => `Could not load todos: ${message}`;
export const closeError = (id: string, message: string): string => `Could not close #${id}: ${message}`;
export const createError = (message: string): string => `Could not create the todo: ${message}`;
export const TITLE_REQUIRED = "A title is required.";
export const LOADING_TYPES = "Loading the todo types, try again in a moment.";
export const typesNotLoaded = (message: string): string => `Could not load the todo types: ${message}`;

/** Implement went through — the answer lands in the chat (the widget steps back inline) */
export const implementSent = (id: string): ToastSpec => ({
  tone: "info",
  title: `Sent #${id} to the assistant`,
  key: `implement-${id}`,
});

/** the host refused the prompt (or threw) — the tracker is the way out */
export function implementRefused(id: string, openTracker: () => void, message?: string): ToastSpec {
  return {
    tone: "danger",
    title: message === undefined ? "Your client refused the prompt" : `Could not hand #${id} to the assistant`,
    detail: message === undefined ? `Open #${id} in the tracker and ask there.` : message,
    action: { label: `Open #${id}`, run: openTracker },
    key: `implement-${id}`,
  };
}

/** a tracker link the host and the browser both refused — the URL stays selectable */
export const linkBlocked = (url: string): ToastSpec => ({
  tone: "danger",
  title: "Your client blocked the link",
  detail: url,
});
