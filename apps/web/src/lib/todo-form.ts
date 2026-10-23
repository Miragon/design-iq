/**
 * The todo form as data, shared by the SPA dialog (components/todo-create-
 * dialog.tsx) and the widget (mcp-app/todos.ts): which type opens first, the
 * fields a person fills, their first values, what the create call sends and
 * the line under a field the shared check flags. Framework-free, like
 * lib/todo-view.ts.
 */
import {
  isBuiltInTodoType,
  type TodoField,
  type TodoFieldProblem,
  type TodoFieldValues,
  type TodoType,
  validateTodoFields,
} from "@designiq/contracts/todo-types";

/** the built-in `Todo` when the repo offers it, else its first template */
export const defaultTodoType = (types: TodoType[]): TodoType | undefined => types.find(isBuiltInTodoType) ?? types[0];

/** a form's hints stay on GitHub; the fields to fill */
export const formFields = (type: TodoType): TodoField[] => type.fields.filter((f) => f.kind !== "markdown");

function initialValue(field: TodoField): string | string[] {
  if (field.kind === "checkboxes") return [];
  if (field.kind === "dropdown" && field.multiple) return field.value ? [field.value] : [];
  return field.value ?? "";
}

export const initialFieldValues = (type: TodoType): TodoFieldValues =>
  Object.fromEntries(formFields(type).map((f) => [f.id, initialValue(f)]));

/** the type part of the create call: the built-in sends today's `body` and no type */
export function todoTypeRequest(
  type: TodoType,
  values: TodoFieldValues,
): { body?: string; type?: string; fields?: TodoFieldValues } {
  if (!isBuiltInTodoType(type)) return { type: type.id, fields: values };
  const description = values.description;
  const text = typeof description === "string" ? description.trim() : "";
  return text ? { body: text } : {};
}

const FLAG: Record<TodoFieldProblem["reason"], string> = {
  missing: "Required",
  invalid: "Choose one of the options",
  unknown: "Not a field of this form",
};

/** field id → the line under it; empty when the form can be filed */
export const fieldFlags = (type: TodoType, values: TodoFieldValues): Record<string, string> =>
  Object.fromEntries(validateTodoFields(type, values).map((p) => [p.id, FLAG[p.reason]]));

/** a checkbox or a multi-select option toggled in a list value */
export function toggleOption(value: string | string[] | undefined, option: string, on: boolean): string[] {
  const list = Array.isArray(value) ? value : [];
  return on ? [...new Set([...list, option])] : list.filter((v) => v !== option);
}
