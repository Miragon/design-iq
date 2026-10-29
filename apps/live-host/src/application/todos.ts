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
 * empty ids, and an id the model's live text does not have is refused, with
 * the closest ids it has: a todo anchored to nothing shows no badge anywhere.
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
import { closestElements, type ModelElement, modelElements } from "@designiq/notations/elements";

import type { Session } from "../adapters/sqlite/sessions.ts";
import type { IssueTracker, Todo } from "../ports/issue-tracker.ts";
import type { ConnectedRepo } from "../repos/registry.ts";
import { type ContentDeps, getContent } from "./content.ts";
import { type FindModelDeps, findModelNotation, findModelPath, findModelPaths } from "./find-model.ts";

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

/** an agent corrects a few ids at a time: the rest are counted, not ranked */
const RANKED_UNKNOWN_IDS = 5;

/** an id or a name on one short line of the message */
function shown(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function unknownElementsMessage(noun: string, modelId: string, unknown: string[], known: ModelElement[]): string {
  const label = ({ id, name }: ModelElement): string => (name ? `${shown(id)} (${shown(name)})` : shown(id));
  const lines = unknown.slice(0, RANKED_UNKNOWN_IDS).map((id) => {
    const closest = closestElements(known, id);
    return closest.length > 0 ? `- ${shown(id)}: closest ${closest.map(label).join(", ")}` : `- ${shown(id)}`;
  });
  if (unknown.length > RANKED_UNKNOWN_IDS) lines.push(`- and ${unknown.length - RANKED_UNKNOWN_IDS} more`);
  // REST (the SPA's dialog) and MCP (agents, the widget's form) share this text: one line for each reader
  const next =
    known.length > 0
      ? `Select the elements again, or file the todo on the whole ${noun}. An agent anchors it to ids get_view reports, or omits \`elements\`.`
      : `It has no elements yet: file the todo on the whole ${noun}. An agent omits \`elements\`.`;
  return `The ${noun} '${modelId}' has no element with ${unknown.length === 1 ? "this id" : "these ids"}:\n${lines.join("\n")}\n${next}`;
}

/** the anchored ids must be elements of the model's LIVE text, the one its canvas shows */
async function requireModelElements(
  opts: ContentDeps,
  repo: ConnectedRepo,
  path: string,
  model: TodoModelRef,
  ids: string[],
): Promise<void> {
  const noun = byId(model.notation)?.noun.singular ?? model.notation;
  const { content } = await getContent(opts, repo, path);
  let known: ModelElement[] | undefined;
  try {
    known = modelElements(path, content);
  } catch {
    // a text that does not parse (a peer mid-edit in the source) has no ids
    // to hold the anchor against; its canvas still shows the last good state
    return;
  }
  if (known === undefined) {
    throw badRequest(
      "todos/elements-unsupported",
      `a ${noun} takes todos on the whole ${noun} only: omit \`elements\``,
    );
  }
  const knownIds = new Set(known.map((element) => element.id));
  const unknown = [...new Set(ids)].filter((id) => !knownIds.has(id));
  if (unknown.length > 0) {
    throw badRequest("todos/unknown-element", unknownElementsMessage(noun, model.id, unknown, known));
  }
}

/** validate, resolve the anchor, file the todo, write the audit line */
export async function fileTodo(
  opts: FindModelDeps & ContentDeps,
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
  // the existence gate BOTH transports lacked in one direction or the other
  const resolvedPath = await findModelPath(opts, repo, id, asked);
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
  const elements = (input.elements ?? [])
    .filter((el) => typeof el?.id === "string" && el.id.length > 0)
    .map((el) => ({ id: el.id as string, name: typeof el.name === "string" ? el.name : null }));
  if (elements.length > 0) {
    await requireModelElements(
      opts,
      repo,
      resolvedPath,
      model,
      elements.map((el) => el.id),
    );
  }

  const todo = await issues.createTodo(repo.fullName, {
    title: type.titlePrefix && !title.startsWith(type.titlePrefix) ? `${type.titlePrefix}${title}` : title,
    body: builtIn && typeof description === "string" ? description : body,
    ...(builtIn ? {} : { fields }),
    anchor: {
      notation: model.notation,
      model: model.id,
      file,
      elements,
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
