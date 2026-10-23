/**
 * A repo's issue templates as todo types (src/adapters/github/issue-templates.ts,
 * #313): forms field by field, Markdown templates as one prefilled description,
 * the manual todo form hidden, `blank_issues_enabled` honoured, and the body of
 * a filed form as GitHub renders a submitted one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { isBuiltInTodoType } from "@designiq/contracts/todo-types";

import {
  type IssueTemplate,
  issueTemplateSet,
  parseIssueForm,
  renderTemplateBody,
} from "../src/adapters/github/issue-templates.ts";

const repoFile = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const BUG_FORM = `
name: Bug report
description: Something is broken
title: "[Bug]: "
labels: bug, triage
body:
  - type: markdown
    attributes:
      value: Thanks for taking the time!
  - type: dropdown
    id: mode
    attributes:
      label: Deploy mode
      options: [Docker, SaaS]
      default: 1
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: Logs
      render: shell
  - type: textarea
    attributes:
      label: Steps
    validations:
      required: true
  - type: checkboxes
    id: terms
    attributes:
      label: Checklist
      options:
        - label: I searched
          required: true
        - label: Optional
    validations:
      required: true
  - type: input
    id: mode
    attributes:
      label: A duplicate id is dropped
`;

const bug = (): IssueTemplate => parseIssueForm({ name: "bug_report.yml", text: BUG_FORM })!;

test("a form becomes a type: stem id, title prefix, comma labels, fallback ids, defaults, GitHub's checkbox semantics", () => {
  const template = bug();
  assert.equal(template.type.id, "bug_report.yml", "the file name: unique, and never the built-in `todo`");
  assert.equal(template.type.name, "Bug report");
  assert.equal(template.type.titlePrefix, "[Bug]: ");
  assert.deepEqual(template.labels, ["bug", "triage"]);
  assert.deepEqual([...template.render], [["logs", "shell"]]);
  assert.deepEqual(
    template.type.fields.map((f) => [f.id, f.kind, f.required]),
    [
      ["field-1", "markdown", false],
      ["mode", "dropdown", true],
      ["logs", "textarea", false],
      ["field-4", "textarea", true],
      ["terms", "checkboxes", false],
    ],
  );
  assert.equal(template.type.fields[1]!.value, "SaaS", "the dropdown's default option prefills it");
  assert.deepEqual(template.type.fields[4]!.options, [
    { label: "I searched", required: true },
    { label: "Optional", required: false },
  ]);
});

test("the repo's own templates parse, and the content repo's manual todo form is hidden", () => {
  const platformBug = parseIssueForm({
    name: "bug_report.yml",
    text: repoFile(".github/ISSUE_TEMPLATE/bug_report.yml"),
  });
  assert.equal(platformBug?.type.name, "Bug report");
  assert.ok(platformBug?.type.fields.some((f) => f.id === "repro" && f.required));

  const set = issueTemplateSet([
    { name: "todo.yml", text: repoFile("process-documentation/.github/ISSUE_TEMPLATE/todo.yml") },
    { name: "config.yml", text: "blank_issues_enabled: false\n" },
  ]);
  assert.deepEqual(set.templates, [], "the platform fills the anchor itself, its manual form is no type");
  assert.equal(set.blankAllowed, true, "hiding the todo form keeps plain todos, whatever the config says");
});

test("blank_issues_enabled decides whether a plain todo is offered beside the templates", () => {
  const form = { name: "bug_report.yml", text: BUG_FORM };
  assert.equal(issueTemplateSet([form]).blankAllowed, true, "GitHub's default");
  assert.equal(
    issueTemplateSet([form, { name: "config.yml", text: "blank_issues_enabled: false" }]).blankAllowed,
    false,
  );
  assert.equal(
    issueTemplateSet([form, { name: "config.yaml", text: "blank_issues_enabled: true" }]).blankAllowed,
    true,
  );
});

test("a Markdown template is one description prefilled with its body; broken files are skipped", () => {
  const set = issueTemplateSet([
    {
      name: "feature.md",
      text: "---\nname: Feature\nabout: Ask for more\nlabels: [enhancement]\n---\n## Why\n\n",
    },
    { name: "broken.yml", text: "name: [unclosed" },
    { name: "no-body.yml", text: "name: Nothing to fill" },
    { name: "notes.txt", text: "ignored" },
  ]);
  assert.equal(set.templates.length, 1);
  const feature = set.templates[0]!;
  assert.equal(feature.type.description, "Ask for more");
  assert.equal(feature.type.fields[0]?.value, "## Why");
  assert.equal(renderTemplateBody(feature, { description: "## Why\n\nBecause" }), "## Why\n\nBecause");
});

test("the body reads like a form GitHub filed: headings, _No response_, task lists, render fences", () => {
  const body = renderTemplateBody(bug(), {
    mode: "Docker",
    logs: "boom",
    "field-4": "Click save",
    terms: ["I searched"],
  });
  assert.equal(
    body,
    [
      "### Deploy mode",
      "",
      "Docker",
      "",
      "### Logs",
      "",
      "```shell",
      "boom",
      "```",
      "",
      "### Steps",
      "",
      "Click save",
      "",
      "### Checklist",
      "",
      "- [X] I searched",
      "- [ ] Optional",
    ].join("\n"),
  );
  const empty = renderTemplateBody(bug(), { mode: "SaaS", "field-4": "x", terms: ["I searched"] });
  assert.ok(empty.includes("### Logs\n\n_No response_"), "an empty rendered textarea gets no fence");
});

test("a repo form in todo.yml without the todo label is a template of its own, never the built-in", () => {
  const { templates } = issueTemplateSet([
    { name: "todo.yml", text: "name: Task\nlabels: [task]\nbody:\n  - type: input\n    attributes:\n      label: Due" },
  ]);
  assert.equal(templates[0]?.type.id, "todo.yml");
  assert.equal(isBuiltInTodoType(templates[0]!.type), false);
});

test("a field id named like an Object.prototype key renders its own value, nothing inherited", () => {
  const template = parseIssueForm({
    name: "odd.yml",
    text: "name: Odd\nbody:\n  - type: textarea\n    id: constructor\n    attributes:\n      label: Text",
  })!;
  assert.equal(renderTemplateBody(template, {}), "### Text\n\n_No response_");
});
