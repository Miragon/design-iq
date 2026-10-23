/**
 * IssueTracker — the third provider seam: model-anchored work items ("todos")
 * live as first-class items in the customer's OWN tracker, never in a
 * platform database.
 *
 * GitHub implements it with repo Issues + labels (adapters/github/issues.ts).
 * GitLab maps 1:1 onto project issues. Jira maps a repo to a project via
 * adapter config and issue ids look like "PROJ-123" — which is why `Todo.id`
 * is an opaque string and why nothing in this contract assumes numbers,
 * labels, or markdown. Anchor semantics (which model, which of its elements)
 * are platform domain — the codec lives in @designiq/contracts/todo-anchor (mcp needs it too); adapters only
 * decide WHERE the encoded block lives (GitHub: issue body).
 */
import type { TodoAnchor, TodoModelRef } from "@designiq/contracts/todo-anchor";
import type { TodoFieldValues, TodoType } from "@designiq/contracts/todo-types";

export interface TodoInput {
  title: string;
  /** free text from the author — tracker-agnostic; adapters add their own markup */
  body: string;
  anchor: TodoAnchor;
  /** platform login of the human author (items are bot-authored, attribution is textual) */
  author: string;
  /** the values of the tracker's own todo type `anchor.type` names
   *  (listTodoTypes), already checked — absent: a plain todo, `body` is the whole text */
  fields?: TodoFieldValues;
}

/** the forms the tracker files todos with (GitHub: the issue templates) */
export interface TrackerTodoTypes {
  types: TodoType[];
  /** a plain todo (title + text) may be filed besides them */
  blankAllowed: boolean;
}

export interface Todo {
  /** tracker-native id as a string (GitHub/GitLab: issue number; Jira: "PROJ-123") */
  id: string;
  /** canonical human URL of the item in the tracker */
  url: string;
  title: string;
  /** the AUTHOR's description, adapter markup stripped ("" when there is none) —
   *  what a human reads, and what an agent needs to act on the item */
  body: string;
  state: "open" | "done";
  /** null = item carries no parseable anchor (e.g. created by hand) — still a
   *  model-level todo when the tracker-side filter matched */
  anchor: TodoAnchor | null;
  /** attributed platform login when known */
  author: string | null;
  assignees: string[];
  /** ISO timestamp */
  createdAt: string;
}

/** where a todo is re-anchored to — a renamed model (#208); a rename keeps
 *  the notation */
export interface TodoTarget {
  /** the new model id (the file stem) */
  model: string;
  /** its repo-relative model file */
  file: string;
}

/**
 * The tracker asked us to slow down (GitHub: a secondary rate limit, 403/429
 * with retry-after). Not a failure of the item — the caller waits
 * `retryAfterMs` and tries the same item again.
 */
export class TrackerRateLimited extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message = "the tracker asked to slow down") {
    super(message);
    this.name = "TrackerRateLimited";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface IssueTracker {
  /** id used in logs ("github-issues") */
  readonly id: string;
  /** the repo's own todo types — empty when it has none */
  listTodoTypes(repoFullName: string): Promise<TrackerTodoTypes>;
  /** create a todo in the tracker backing this repo; returns the created item */
  createTodo(repoFullName: string, input: TodoInput): Promise<Todo>;
  /** OPEN todos for one repo, optionally narrowed to one model */
  listTodos(repoFullName: string, model?: TodoModelRef): Promise<Todo[]>;
  /** close one todo; closedBy = platform login (attribution is textual, items stay bot-authored) */
  closeTodo(repoFullName: string, id: string, closedBy: string): Promise<void>;
  /** re-anchor ONE todo from model `from` to `to` (a rename, #208): the
   *  tracker-side model filter and the anchor both name `to` afterwards.
   *  Idempotent — an item already on `to` comes back "unchanged". Throws
   *  TrackerRateLimited when the tracker asks to slow down; the pacing of a
   *  batch is the caller's (application/todo-jobs.ts). */
  retargetTodo(repoFullName: string, id: string, from: TodoModelRef, to: TodoTarget): Promise<"moved" | "unchanged">;
}
