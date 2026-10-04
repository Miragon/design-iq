## What changed & why

<!-- One or two sentences. Link the issue, or the feedback entry (feedback/<id>/) if this PR resolves one. -->

## Checklist

<!-- Delete lines and sections that don't apply. -->

- [ ] The local gates pass (lint, arch, format, typecheck, validate, test, build — see `CONTRIBUTING.md`)
- [ ] Docs follow the change (`docs/`, `CLAUDE.md`, the README of a touched package)

### Models (any notation)

- [ ] `pnpm validate` passes with 0 errors

### BPMN

- [ ] BPMN edits keep semantics (`bpmn:*`) and layout (`bpmndi:*`) in sync — every flow node,
      lane, pool and edge has a `bpmndi:` shape (or the visual editor breaks)
- [ ] Modeling conventions followed (tasks verb+object, events object+past participle,
      gateways as questions, lanes = team/role labels)
- [ ] Any `callActivity` `calledElement` resolves to a process in the repo (its `.bpmn` stem)
- [ ] Affected exports re-run via `export-process-skill` (`dist/skills/<id>`), if any exist

### DMN

- [ ] Expected test values in `<decision>.tests.yaml` are confirmed by the business, or recorded
      from today's behaviour (`save_decision_tests` with `record`)
