# process-documentation — the example content repo

The example **content repository** for [designIQ](https://github.com/Miragon/design-iq):
BPMN processes and a DMN decision, plus the AI skills that work on them. It is the
content counterpart to the platform code in this monorepo, and the working example
the MCP server and validator run against.

designIQ is collaborative modeling and architecture with AI — live, Git-native, with
every model a file in your repo. This example concentrates on BPMN and DMN, the
notations with the deepest tooling (derived process views, decision simulation and
tests, todos). The same repo can hold every other notation next to them — see the
table below.

## The contract

A content repo is a root **`designiq.yml`** naming the folder its models live in:

```yaml
models: processes
```

`designiq.yml` needs designIQ / Live Host **4.3.1 or later** — older versions read
only the legacy name `bpmiq.yml`. That name stays readable for good (the validator
suggests `git mv bpmiq.yml designiq.yml`), and so does the legacy key `processes:`.

- Every file with a registered notation extension under that folder (subfolders
  included) is a **model**:

  | Notation       | Extensions         | One model is            |
  | -------------- | ------------------ | ----------------------- |
  | BPMN 2.0       | `.bpmn`            | a process               |
  | DMN            | `.dmn`             | a decision              |
  | Wardley Map    | `.owm`, `.wmap`    | a Wardley map           |
  | Team Topology  | `.tt`, `.ttm.json` | a team topology         |
  | Event Storming | `.storm`           | an event-storming board |
  | Context Map    | `.cm.json`         | a context map           |
  | Value Chain    | `.vc.json`         | a value chain           |
  | Markdown       | `.md`              | a document              |

- A model's **id** is its file name without the extension
  (`processes/order-to-cash.bpmn` → `order-to-cash`).
- There is no hand-written metadata: views are **derived from the models on the
  fly** (`@designiq/notations/derive`) — for a process its name, roles from lanes,
  steps, flow and sub-process calls; for a decision its hit policy, columns and rules.

```
designiq.yml
processes/
  order-to-cash.bpmn              ← the process
  order-to-cash.storm             ← same id, other notation: the event-storming session behind it
  credit-limit-check.dmn          ← called by order-to-cash (businessRuleTask calledDecision)
  credit-limit-check.tests.yaml   ← its test cases, run by `pnpm validate`
  subprocesses/
    invoice-handling.bpmn         ← called by order-to-cash (callActivity calledElement)
```

## File naming

The file name is not decoration — it IS the model id, and the id is what other
models link to. So:

- **kebab-case, English, descriptive**: `credit-limit-check.dmn`, not
  `Kreditpruefung v2 final.dmn`.
- **The stem is the link target**: `calledElement="invoice-handling"` and
  `calledDecision="credit-limit-check"` are file stems. Renaming a file renames
  the id — fix every reference in the same commit (`pnpm validate` catches the
  dangling ones).
- **Same stem, other extension = the same model in another notation**
  (`order-to-cash.bpmn` + `order-to-cash.storm` are one model, two views).
- **Test cases sit next to their decision** as `<decision>.tests.yaml`.
- No scratch files in the models folder — `test1.bpmn`, `copy of ….dmn` and
  friends become models the whole organization sees.

## Working with it

- **Model live**: open the repo in the designIQ web app or in VS Code; every model
  is co-edited live — in a visual modeler where the notation has one, as text
  otherwise. A release opens a pull request with the live state.
- **Ask the models**: the MCP server (`packages/mcp`) answers questions over this
  content (`list_models`, `get_view`, `list_processes`, `get_process`, `who_owns`,
  `enumerate_paths`, …).
- **Validate**: `npx @miragon/design-iq-validator --root .` (from the repo root) checks
  BPMN and DMN structure, diagram coverage and the links between models, and that
  every other model file parses.
- **Skills**: `.claude/skills/` carries the AI toolset that operates on this repo —
  today the BPMN process skills (navigate, capture, import, scaffold, review,
  feedback, export).

This repo is mirrored to [`Miragon/process-documentation-starter`](https://github.com/Miragon/process-documentation-starter)
as the "Use this template" starter.
