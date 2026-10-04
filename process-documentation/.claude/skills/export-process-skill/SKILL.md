---
name: export-process-skill
description: Exports a business process — its BPMN model, any sub-processes it calls, and the derived process view — as a self-contained, portable agent skill under dist/skills/. Use when the user wants a process "as a skill", wants processes to be usable by other agents or projects, or wants a process to answer questions outside this repository. One of the BPMN process skills (`.bpmn` models only).
---

# Export Process as Skill

Package one process into a skill any agent can load — in another repo's
`.claude/skills/`, in Claude Code, or on claude.ai. The exported skill lets the
consuming agent answer questions about the process and guide people through it
**without access to this repository**. That is the point: the process itself becomes
the interface.

## Input

A process id (a `.bpmn` file stem). If ambiguous, list the available processes
(`list_processes`).

## Step 1 — Resolve the closure

A process is its `.bpmn`. Follow every `callActivity` `calledElement` to the
sub-process `.bpmn` it names, transitively — those must be copied into the export so
the consumer can descend into them. A `calledElement` that resolves to no process in
the repo is a dangling call: report it (suggest `process-review`) instead of
exporting a broken skill.

## Step 2 — Generate the skill package

Create `dist/skills/<id>/` (overwrite an existing export of the same process):

```
dist/skills/<id>/
├── SKILL.md                    # generated from resources/skill-template.md (in this skill's folder)
└── resources/
    ├── process.bpmn            # copy of <id>.bpmn
    ├── subprocesses/           # copies of every called .bpmn, if any
    ├── context.yaml            # the derived view + export provenance (self-contained)
    └── walkthrough.md          # generated narrative
```

**SKILL.md**: instantiate `resources/skill-template.md` (next to this file); its
placeholder text is normative. The frontmatter `name` is the process id; the
`description` must be written for discovery by the consuming agent: name the trigger,
the outcome, and the domain vocabulary (the step and role names) so the skill
activates on real user questions. Drop any claim the model does not back. Keep it
under 1024 characters, third person.

**context.yaml**: the **derived view** of the process (`deriveProcess` / the MCP
`get_process` output) — name, roles (from lanes), steps with their role, gateways,
events, and the sub-processes it calls — serialized as YAML so a consumer needs no
BPMN parser for the summary. Add an `exported` block: `from` = the git remote URL (or
the repo directory name if there is no remote), `date` = today, and the short git
commit hash if available.

**walkthrough.md**: generate from the BPMN, not from imagination:
1. numbered happy path — each step: performing lane/role, task type
   (human/automated/message), what happens;
2. decision points — the gateway question and where each answer leads;
3. exceptions & loops — from boundary events and exception flows;
4. handoffs — every lane transition.

## Step 3 — Validate before reporting

- frontmatter `name` matches the folder name, kebab-case; `description` < 1024 chars;
- every file referenced in the generated SKILL.md exists inside the package;
- no path in the package points outside `dist/skills/<id>/`;
- `context.yaml` parses and matches the model (its steps/roles are the derived view,
  not invented);
- re-read the generated SKILL.md once as a cold reader: could an agent with only this
  folder answer "walk me through this process" and "who does what"? If not, fix it.

## Step 4 — Report

State what was exported, where, and how to use it:
- copy `dist/skills/<id>/` into any project's `.claude/skills/` directory, or
- zip the folder and upload it as a skill on claude.ai.

Exports are snapshots. After changing the process, **re-export** — never hand-edit
`dist/skills/`.
