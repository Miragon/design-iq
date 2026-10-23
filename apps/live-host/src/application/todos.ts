/**
 * Todo use-cases shared by REST and MCP. Assembly, validation and the audit
 * line lived once per transport, with the trust gaps pointing in opposite
 * directions: REST stored the client's anchor (process AND file) verbatim and
 * never checked the process exists, while MCP resolved ids server-side but
 * anchored client paths unchecked and accepted empty element ids.
 *
 * One resolution now, for both: the anchor's process id (given, or the file
 * stem) MUST resolve through discovery — an unknown process is a typed 404,
 * never a stored anchor pointing at nothing. A client file is kept only when
 * it names that process (the platform contract: a path names its own process);
 * anything else normalizes to the discovered path. Elements drop empty ids.
 *
 * Every todo is filed with a type (#313): one of the repo's own (its issue
 * templates) or the built-in `Todo`, which a repo without templates — or one
 * allowing blank issues — gets. Its required fields are checked here, with the
 * same module the web dialog and the widget check them with.
 */
import type { TodoWire } from "@designiq/contracts/live-host";
import {
  BUILT_IN_TODO_TYPE,
  fieldProblemsMessage,
  isBuiltInTodoType,
  type TodoFieldValues,
  type TodoType,
  validateTodoFields,
} from "@designiq/contracts/todo-types";
import { AppError } from "@designiq/http-kit";
import { byExtension, modelStem } from "@designiq/notations";

import type { Session } from "../adapters/sqlite/sessions.ts";
import type { IssueTracker, Todo } from "../ports/issue-tracker.ts";
import type { ConnectedRepo } from "../repos/registry.ts";
import { type FindModelDeps, findProcessPath } from "./find-model.ts";

/** the process a model path belongs to — id IS the file stem (the content
 *  contract). Only a .bpmn path names a process; anything else keeps its
 *  basename, so it can never pass the "names that process" gate below (it
 *  fails typed in findProcessPath instead of anchoring a non-process file). */
const processIdOf = (path: string): string =>
  byExtension(path)?.id === "bpmn" ? modelStem(path) : (path.split("/").pop() ?? path);

export interface FileTodoInput {
  title: unknown;
  body?: unknown;
  /** process id (the .bpmn file stem) — this or `file` is required */
  process?: string;
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
  const process = input.process?.trim() || (input.file ? processIdOf(input.file) : undefined);
  if (!process) {
    throw new AppError("todos/anchor-required", "anchor.process must be a non-empty string", {
      status: 400,
      expose: true,
    });
  }
  // the existence gate BOTH transports lacked in one direction or the other
  const resolvedPath = await findProcessPath(opts, repo, process);
  const file = input.file && processIdOf(input.file) === process ? input.file : resolvedPath;

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
      process,
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
 * The OPEN todos of a repo, optionally of one process — including those still
 * on their way in from a renamed process's old id (#208: the move runs in the
 * background, one tracker write at a time, and nothing may disappear from the
 * process's Todos panel meanwhile).
 */
export async function listOpenTodos(
  issues: IssueTracker,
  moving: { sourcesOf(repo: string, process: string): string[] } | undefined,
  repo: ConnectedRepo,
  process?: string,
): Promise<Todo[]> {
  const own = await issues.listTodos(repo.fullName, process);
  const sources = process ? (moving?.sourcesOf(repo.fullName, process) ?? []) : [];
  if (sources.length === 0) return own;
  const seen = new Set(own.map((t) => t.id));
  const incoming = (await Promise.all(sources.map((from) => issues.listTodos(repo.fullName, from)))).flat();
  return [...own, ...incoming.filter((t) => !seen.has(t.id) && seen.add(t.id))];
}
