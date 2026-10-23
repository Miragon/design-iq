/**
 * A repo's issue templates (`.github/ISSUE_TEMPLATE/`) as todo types (#313):
 * issue FORMS (`*.yml`) field by field, Markdown templates (`*.md`) as one
 * prefilled description, `config.yml` for `blank_issues_enabled`. Pure — the
 * adapter (issues.ts) fetches the files. Labels and the textarea `render`
 * language are GitHub markup and stay here, off the tracker-neutral port.
 *
 * The body of a filed form reads like one GitHub filed: `### <label>` per
 * field, `_No response_` for an empty one, checkboxes as a task list.
 */
import {
  fieldValue,
  type TodoField,
  type TodoFieldValues,
  type TodoType,
  valueList,
} from "@designiq/contracts/todo-types";
import { TODO_LABEL } from "@designiq/github-app/todos";
import { parse as parseYaml } from "yaml";

export interface IssueTemplate {
  type: TodoType;
  labels: string[];
  /** textarea field id → the code fence language GitHub wraps it in */
  render: Map<string, string>;
  /** a Markdown template: the description IS the body */
  verbatim: boolean;
}

export interface IssueTemplateSet {
  templates: IssueTemplate[];
  /** a blank todo may be filed too: blank issues are enabled, or the repo's
   *  own manual todo form was hidden (plain todos never vanish) */
  blankAllowed: boolean;
}

export interface TemplateFile {
  name: string;
  text: string;
}

const NO_RESPONSE = "_No response_";
const FIELD_KINDS = new Set(["markdown", "input", "textarea", "dropdown", "checkboxes"]);
const CONFIG_FILES = new Set(["config.yml", "config.yaml"]);

type Yaml = Record<string, unknown>;

const isRecord = (value: unknown): value is Yaml => typeof value === "object" && value !== null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
/** the files a template set is read from (config.yml among them) */
export const TEMPLATE_FILE = /\.(ya?ml|md)$/i;

const isTemplateFile = (name: string): boolean => TEMPLATE_FILE.test(name) && !CONFIG_FILES.has(name.toLowerCase());

function labelsOf(value: unknown): string[] {
  const list = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  return list.filter((l): l is string => typeof l === "string" && l.trim().length > 0).map((l) => l.trim());
}

function fieldOf(element: Yaml, index: number): { field: TodoField; render: string | null } | null {
  const kind = element.type;
  if (typeof kind !== "string" || !FIELD_KINDS.has(kind)) return null;
  const attributes = isRecord(element.attributes) ? element.attributes : {};
  const validations = isRecord(element.validations) ? element.validations : {};
  const rawOptions = Array.isArray(attributes.options) ? attributes.options : [];
  const options = rawOptions
    .map((o) =>
      isRecord(o) ? { label: text(o.label), required: o.required === true } : { label: text(o), required: false },
    )
    .filter((o): o is { label: string; required: boolean } => o.label !== null);
  const defaultOption = typeof attributes.default === "number" ? options[attributes.default]?.label : undefined;
  const field: TodoField = {
    id: text(element.id) ?? `field-${index + 1}`,
    kind: kind as TodoField["kind"],
    label: kind === "markdown" ? "" : (text(attributes.label) ?? `Field ${index + 1}`),
    description: text(attributes.description),
    placeholder: text(attributes.placeholder),
    value: text(attributes.value) ?? defaultOption ?? null,
    options: kind === "dropdown" || kind === "checkboxes" ? options : [],
    multiple: kind === "dropdown" && attributes.multiple === true,
    // GitHub reads `required` per option on checkboxes, never on the element
    required: kind !== "markdown" && kind !== "checkboxes" && validations.required === true,
  };
  return { field, render: kind === "textarea" ? text(attributes.render) : null };
}

/** an issue form; null when it is not one (no name, no body list) */
export function parseIssueForm(file: TemplateFile): IssueTemplate | null {
  const doc: unknown = parseYaml(file.text);
  if (!isRecord(doc) || !text(doc.name) || !Array.isArray(doc.body)) return null;
  const fields: TodoField[] = [];
  const render = new Map<string, string>();
  doc.body.forEach((element: unknown, index) => {
    const parsed = isRecord(element) ? fieldOf(element, index) : null;
    if (!parsed || fields.some((f) => f.id === parsed.field.id)) return;
    fields.push(parsed.field);
    if (parsed.render) render.set(parsed.field.id, parsed.render);
  });
  return {
    type: {
      id: file.name,
      name: text(doc.name)!.trim(),
      description: text(doc.description)?.trim() ?? "",
      titlePrefix: text(doc.title),
      fields,
    },
    labels: labelsOf(doc.labels),
    render,
    verbatim: false,
  };
}

/** a Markdown template: front matter + the body that prefills the description */
export function parseMarkdownTemplate(file: TemplateFile): IssueTemplate | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(file.text);
  if (!match) return null;
  const front: unknown = parseYaml(match[1]!);
  if (!isRecord(front) || !text(front.name)) return null;
  const body = match[2]!.trim();
  return {
    type: {
      id: file.name,
      name: text(front.name)!.trim(),
      description: text(front.about)?.trim() ?? "",
      titlePrefix: text(front.title),
      fields: [
        {
          id: "description",
          kind: "textarea",
          label: "Description",
          description: null,
          placeholder: null,
          value: body || null,
          options: [],
          multiple: false,
          required: false,
        },
      ],
    },
    labels: labelsOf(front.labels),
    render: new Map(),
    verbatim: true,
  };
}

function parseTemplate(file: TemplateFile): IssueTemplate | null {
  try {
    return /\.md$/i.test(file.name) ? parseMarkdownTemplate(file) : parseIssueForm(file);
  } catch {
    return null;
  }
}

function blankIssuesEnabled(config: TemplateFile | undefined): boolean {
  if (!config) return true;
  try {
    const doc: unknown = parseYaml(config.text);
    return !(isRecord(doc) && doc.blank_issues_enabled === false);
  } catch {
    return true;
  }
}

const filesTodo = (template: IssueTemplate): boolean =>
  template.labels.some((l) => l.toLowerCase() === TODO_LABEL.toLowerCase());

/** the templates a todo can be filed with: unparseable files skipped, the
 *  manual `todo` form hidden (the platform fills its anchor itself) */
export function issueTemplateSet(files: TemplateFile[]): IssueTemplateSet {
  const parsed = files
    .filter((f) => isTemplateFile(f.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(parseTemplate)
    .filter((t): t is IssueTemplate => t !== null);
  const hidesTodoForm = parsed.some(filesTodo);
  const config = files.find((f) => CONFIG_FILES.has(f.name.toLowerCase()));
  return {
    templates: parsed.filter((t) => !filesTodo(t)),
    blankAllowed: hidesTodoForm || blankIssuesEnabled(config),
  };
}

function sectionValue(template: IssueTemplate, field: TodoField, value: string | string[] | undefined): string {
  if (field.kind === "checkboxes") {
    const checked = valueList(value);
    return field.options.map((o) => `- [${checked.includes(o.label) ? "X" : " "}] ${o.label}`).join("\n");
  }
  const chosen = valueList(value);
  if (chosen.length === 0) return NO_RESPONSE;
  if (field.kind === "dropdown") return chosen.join(", ");
  const answer = typeof value === "string" ? value.trim() : chosen.join("\n");
  const fence = template.render.get(field.id);
  return fence ? `\`\`\`${fence}\n${answer}\n\`\`\`` : answer;
}

/** the issue body of a filed form, as GitHub renders a submitted one */
export function renderTemplateBody(template: IssueTemplate, values: TodoFieldValues): string {
  if (template.verbatim) {
    const description = values.description;
    return (typeof description === "string" ? description : "").trim();
  }
  return template.type.fields
    .filter((f) => f.kind !== "markdown")
    .map((f) => `### ${f.label}\n\n${sectionValue(template, f, fieldValue(values, f.id))}`)
    .join("\n\n");
}
