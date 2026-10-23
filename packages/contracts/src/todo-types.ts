/**
 * Todo types: the forms a todo can be filed with (a repo's issue templates, or
 * the built-in `Todo`) and the ONE check of their required fields, shared by
 * the Live Host, the web dialog and the widget. Zero imports.
 */

export type TodoFieldKind = "markdown" | "input" | "textarea" | "dropdown" | "checkboxes";

export interface TodoFieldOption {
  label: string;
  required: boolean;
}

export interface TodoField {
  id: string;
  kind: TodoFieldKind;
  /** "" for markdown: its text is `value`, a hint that is never submitted */
  label: string;
  description: string | null;
  placeholder: string | null;
  /** the prefilled value (input, textarea) or the hint text (markdown) */
  value: string | null;
  options: TodoFieldOption[];
  multiple: boolean;
  required: boolean;
}

export interface TodoType {
  id: string;
  name: string;
  description: string;
  /** prepended to the title unless it already starts with it */
  titlePrefix: string | null;
  fields: TodoField[];
}

/** input/textarea: a string; dropdown: an option label (an array when multiple);
 *  checkboxes: the checked option labels */
export type TodoFieldValues = Record<string, string | string[]>;

export const BUILT_IN_TODO_TYPE: TodoType = {
  id: "todo",
  name: "Todo",
  description: "A title and a free-text description",
  titlePrefix: null,
  fields: [
    {
      id: "description",
      kind: "textarea",
      label: "Description",
      description: null,
      placeholder: null,
      value: null,
      options: [],
      multiple: false,
      required: false,
    },
  ],
};

export const isBuiltInTodoType = (type: Pick<TodoType, "id">): boolean => type.id === BUILT_IN_TODO_TYPE.id;

export interface TodoFieldProblem {
  id: string;
  label: string;
  reason: "missing" | "invalid" | "unknown";
}

/** a field's value as its non-blank entries */
export const valueList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean);

/** a field's value, never one inherited from Object.prototype (a field id may be `constructor`) */
export const fieldValue = (values: TodoFieldValues, id: string): string | string[] | undefined =>
  Object.hasOwn(values, id) ? values[id] : undefined;

function problemOf(field: TodoField, value: string | string[] | undefined): TodoFieldProblem["reason"] | null {
  const chosen = valueList(value);
  const known = new Set(field.options.map((o) => o.label));
  switch (field.kind) {
    case "markdown":
      return null;
    case "input":
    case "textarea":
      if (Array.isArray(value)) return "invalid";
      return field.required && chosen.length === 0 ? "missing" : null;
    case "dropdown":
      if (chosen.some((c) => !known.has(c)) || (!field.multiple && chosen.length > 1)) return "invalid";
      return field.required && chosen.length === 0 ? "missing" : null;
    case "checkboxes":
      if (chosen.some((c) => !known.has(c))) return "invalid";
      return field.options.some((o) => o.required && !chosen.includes(o.label)) ? "missing" : null;
  }
}

/** what keeps `values` from filing a `type` todo: missing required fields,
 *  values the field does not offer, and ids the type has no field for */
export function validateTodoFields(type: TodoType, values: TodoFieldValues): TodoFieldProblem[] {
  const problems: TodoFieldProblem[] = [];
  for (const field of type.fields) {
    const reason = problemOf(field, fieldValue(values, field.id));
    if (reason) problems.push({ id: field.id, label: field.label, reason });
  }
  const ids = new Set(type.fields.filter((f) => f.kind !== "markdown").map((f) => f.id));
  for (const id of Object.keys(values)) {
    if (!ids.has(id)) problems.push({ id, label: id, reason: "unknown" });
  }
  return problems;
}

const REASON_TEXT: Record<TodoFieldProblem["reason"], string> = {
  missing: "is required",
  invalid: "has a value it does not take",
  unknown: "is not a field of this type",
};

/** one line per problem, naming the label a person sees and the id an agent passes */
export function fieldProblemsMessage(type: TodoType, problems: TodoFieldProblem[]): string {
  const lines = problems.map((p) => `- ${p.label === p.id ? p.id : `${p.label} (${p.id})`} ${REASON_TEXT[p.reason]}`);
  return [`The ${type.name} form is not complete:`, ...lines].join("\n");
}
