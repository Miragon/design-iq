/**
 * Todo use-cases shared by REST and MCP. Assembly, validation and the audit
 * line lived once per transport, with the trust gaps pointing in opposite
 * directions: REST stored the client's anchor (process AND file) verbatim and
 * never checked the process exists, while MCP resolved ids server-side but
 * anchored client paths unchecked and accepted empty element ids.
 *
 * One resolution now, for both: the anchor's model (an id with or without its
 * notation, or a file path) MUST resolve through discovery — an unknown model
 * is a typed 404, never a stored anchor pointing at nothing — and its notation
 * must take todos (@designiq/notations `todos`). A client file is kept only
 * when it names that model (the platform contract: a path names its own
 * model); anything else normalizes to the discovered path. Elements drop
 * empty ids.
 *
 * Every todo is filed with a type (#313): one of the repo's own (its issue
 * templates) or the built-in `Todo`, which a repo without templates — or one
 * allowing blank issues — gets. Its required fields are checked here, with the
 * same module the web dialog and the widget check them with.
 */
import type { TodoWire } from "@designiq/contracts/live-host";
import type { TodoModelRef } from "@designiq/contracts/todo-anchor";
import {
  BUILT_IN_TODO_TYPE,
  fieldProblemsMessage,
  isBuiltInTodoType,
  type TodoFieldValues,
  type TodoType,
  validateTodoFields,
} from "@designiq/contracts/todo-types";
import { AppError } from "@designiq/http-kit";
import { byExtension, byId, hasTodos, modelStem, NOTATIONS } from "@designiq/notations";

import type { Session } from "../adapters/sqlite/sessions.ts";
import type { IssueTracker, Todo } from "../ports/issue-tracker.ts";
import type { ConnectedRepo } from "../repos/registry.ts";
import { type FindModelDeps, findModelNotation, findModelPath, findModelPaths, findProcessPath } from "./find-model.ts";

/** the model a repo-relative path names — id IS the file stem (the content
 *  contract); undefined for a path of no registered notation */
export function modelOfPath(path: string): TodoModelRef | undefined {
  const notation = byExtension(path)?.id;
  return notation ? { notation, id: modelStem(path) } : undefined;
}

/** the notations todos are filed on, for the messages that name them */
const TODO_NOTATIONS = NOTATIONS.filter((n) => hasTodos(n.id))
  .map((n) => n.id)
  .join(", ");

function requireTodoNotation(notation: string): void {
  if (hasTodos(notation)) return;
  const known = byId(notation);
  throw new AppError(
    "todos/notation-unsupported",
    known
      ? `todos are not filed on ${known.noun.plural} (yet) — only on models of: ${TODO_NOTATIONS}`
      : `unknown notation '${notation}' — todos are filed on models of: ${TODO_NOTATIONS}`,
    { status: 400, expose: true },
  );
}

/**
 * The model a todo LISTING is narrowed to — no existence check: an unknown
 * model is simply an empty list (the tracker-side label filter decides). A
 * path names its model; an id without a notation is the one discovery finds,
 * a process first (the rule every id lookup follows), else a process id.
 */
export async function todoListModel(
  opts: FindModelDeps,
  repo: ConnectedRepo,
  ref: { id?: string; path?: string; notation?: string },
): Promise<TodoModelRef | undefined> {
  if (ref.path) return modelOfPath(ref.path) ?? { notation: ref.notation ?? "bpmn", id: modelStem(ref.path) };
  const id = ref.id?.trim();
  if (!id) return undefined;
  return { notation: ref.notation || ((await findModelNotation(opts, repo, id)) ?? "bpmn"), id };
}

export interface FileTodoInput {
  title: unknown;
  body?: unknown;
  /** model id (the file stem) — this or `file` is required */
  model?: string;
  /** the model's notation — narrows `model` when a stem is shared across
   *  notations (without it a process wins, then any model of that id) */
  notation?: string;
  /** repo-relative model path (the id alternative; sub-process todos) */
  file?: string;
  elements?: Array<{ id?: unknown; name?: unknown }>;
  processVersion?: unknown;
  /** a type id from listTodoTypesFor — omitted: the built-in `Todo` */
  type?: unknown;
  fields?: unknown;
}

/** the types a todo can be filed with in this repo, the built-in `Todo` first
 *  when it is offered */
export async function listTodoTypesFor(issues: IssueTracker, repo: ConnectedRepo): Promise<TodoType[]> {
  const { types, blankAllowed } = await issues.listTodoTypes(repo.fullName);
  return types.length === 0 || blankAllowed ? [BUILT_IN_TODO_TYPE, ...types] : types;
}

const badRequest = (code: string, message: string): AppError =>
  new AppError(code, message, { status: 400, expose: true });

const typeList = (types: TodoType[]): string => types.map((t) => `${t.name} (${t.id})`).join(", ");

function resolveType(types: TodoType[], requested: unknown, repo: ConnectedRepo): TodoType {
  if (requested === undefined || requested === null || requested === "") {
    const builtIn = types.find(isBuiltInTodoType);
    if (builtIn) return builtIn;
    throw badRequest(
      "todos/type-required",
      `${repo.fullName} files todos with its issue templates, choose one: ${typeList(types)}`,
    );
  }
  const type = types.find((t) => t.id === requested);
  if (type) return type;
  throw badRequest(
    "todos/unknown-type",
    `${repo.fullName} has no todo type '${String(requested)}': ${typeList(types)}`,
  );
}

function fieldValuesOf(fields: unknown): TodoFieldValues {
  if (fields === undefined || fields === null) return {};
  const isValue = (v: unknown) => typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));
  if (typeof fields !== "object" || Array.isArray(fields) || !Object.values(fields).every(isValue)) {
    throw badRequest("todos/fields-invalid", "fields must map field ids to a string or a list of strings");
  }
  return fields as TodoFieldValues;
}

/** validate, resolve the anchor, file the todo, write the audit line */
export async function fileTodo(
  opts: FindModelDeps,
  issues: IssueTracker,
  session: Session,
  repo: ConnectedRepo,
  input: FileTodoInput,
  via: "rest" | "mcp",
): Promise<TodoWire> {
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new AppError("todos/title-required", "title must be a non-empty string", { status: 400, expose: true });
  }
  const fromFile = input.file ? modelOfPath(input.file) : undefined;
  const id = input.model?.trim() || fromFile?.id;
  if (!id) {
    throw new AppError("todos/anchor-required", "anchor.model must be a non-empty string", {
      status: 400,
      expose: true,
    });
  }
  // the file's notation, unless the id names another model than the file
  const asked = input.notation?.trim() || (fromFile && fromFile.id === id ? fromFile.notation : undefined);
  if (asked) requireTodoNotation(asked);
  // the existence gate BOTH transports lacked in one direction or the other —
  // a process answers in the words it always did ("… (use list_processes)")
  const resolvedPath =
    asked === "bpmn" ? await findProcessPath(opts, repo, id) : await findModelPath(opts, repo, id, asked);
  const model = modelOfPath(resolvedPath) ?? { notation: asked ?? "bpmn", id };
  requireTodoNotation(model.notation);
  const named = fromFile && fromFile.notation === model.notation && fromFile.id === model.id;
  const file = named && input.file ? input.file : resolvedPath;

  const type = resolveType(await listTodoTypesFor(issues, repo), input.type, repo);
  const fields = fieldValuesOf(input.fields);
  const builtIn = isBuiltInTodoType(type);
  const body = typeof input.body === "string" ? input.body : "";
  if (!builtIn && body.trim()) {
    throw badRequest("todos/body-not-allowed", `the ${type.name} form takes its text in \`fields\`, not in \`body\``);
  }
  const problems = validateTodoFields(type, fields);
  if (problems.length > 0) {
    const onlyMissing = problems.every((p) => p.reason === "missing");
    throw badRequest(
      onlyMissing ? "todos/fields-required" : "todos/fields-invalid",
      fieldProblemsMessage(type, problems),
    );
  }
  const title = input.title.trim();
  const description = fields.description;

  const todo = await issues.createTodo(repo.fullName, {
    title: type.titlePrefix && !title.startsWith(type.titlePrefix) ? `${type.titlePrefix}${title}` : title,
    body: builtIn && typeof description === "string" ? description : body,
    ...(builtIn ? {} : { fields }),
    anchor: {
      notation: model.notation,
      model: model.id,
      file,
      elements: (input.elements ?? [])
        .filter((el) => typeof el?.id === "string" && el.id.length > 0)
        .map((el) => ({ id: el.id as string, name: typeof el.name === "string" ? el.name : null })),
      processVersion: typeof input.processVersion === "string" ? input.processVersion : null,
      ...(builtIn ? {} : { type: { id: type.id, name: type.name } }),
    },
    // attribution: the platform login of the SESSION is authoritative,
    // never a client-supplied author field
    author: session.user.login,
  });
  console.log(
    `todo created in ${repo.fullName} by @${session.user.login}${via === "mcp" ? " via mcp" : ""}: #${todo.id} "${todo.title}"`,
  );
  return todo;
}

/** close in the tracker (bot-authored, the session user attributed) + audit line */
export async function closeTodoFor(
  issues: IssueTracker,
  session: Session,
  repo: ConnectedRepo,
  todoId: string,
  via: "rest" | "mcp",
): Promise<void> {
  await issues.closeTodo(repo.fullName, todoId, session.user.login);
  console.log(
    `todo closed in ${repo.fullName} by @${session.user.login}${via === "mcp" ? " via mcp" : ""}: #${todoId}`,
  );
}

/**
 * The OPEN todos of a repo, optionally of one model — including those still
 * on their way in from a renamed model's old id (#208: the move runs in the
 * background, one tracker write at a time, and nothing may disappear from the
 * model's Todos panel meanwhile).
 *
 * With `find`, each anchor's `file` is where its model is NOW: a move to
 * another folder keeps the model's id (the label still finds its todos) but
 * not its path, and the anchor in the tracker keeps the path of the day it
 * was filed. Corrected on every read, never written back — that would cost a
 * tracker write per todo and move.
 */
export async function listOpenTodos(
  issues: IssueTracker,
  moving: { sourcesOf(repo: string, model: TodoModelRef): string[] } | undefined,
  repo: ConnectedRepo,
  model?: TodoModelRef,
  find?: FindModelDeps,
): Promise<Todo[]> {
  const todos = await openTodosOf(issues, moving, repo, model);
  if (!find || !todos.some((t) => t.anchor)) return todos;
  const paths = await findModelPaths(find, repo);
  return todos.map((todo) => {
    const file = todo.anchor && paths.get(`${todo.anchor.notation}:${todo.anchor.model}`);
    return todo.anchor && file && file !== todo.anchor.file ? { ...todo, anchor: { ...todo.anchor, file } } : todo;
  });
}

async function openTodosOf(
  issues: IssueTracker,
  moving: { sourcesOf(repo: string, model: TodoModelRef): string[] } | undefined,
  repo: ConnectedRepo,
  model?: TodoModelRef,
): Promise<Todo[]> {
  const own = await issues.listTodos(repo.fullName, model);
  const sources = model ? (moving?.sourcesOf(repo.fullName, model) ?? []) : [];
  if (!model || sources.length === 0) return own;
  const seen = new Set(own.map((t) => t.id));
  const incoming = (
    await Promise.all(sources.map((from) => issues.listTodos(repo.fullName, { notation: model.notation, id: from })))
  ).flat();
  return [...own, ...incoming.filter((t) => !seen.has(t.id) && seen.add(t.id))];
}
