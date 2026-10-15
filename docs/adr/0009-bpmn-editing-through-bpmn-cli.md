# ADR 0009 — Semantic BPMN editing through bpmn-cli

- **Status:** accepted (2026-10-12), amended (2026-10-13, #248: the engine has no copy of
  the save gate — see Consequences; 2026-10-14, #248: on bpmn-cli 0.7.0 a design model's
  decision links keep the file's spelling — see decision 4); the tools stay opt-in
  (`LIVE_MCP_BPMN_EDIT=1`) until the A/B gate below has run with this engine
- **Context:** issue [#236](https://github.com/Miragon/design-iq/issues/236), the follow-up
  to PR [#218](https://github.com/Miragon/design-iq/pull/218) (`@bpmiq/bpmn-edit`, an editor
  of its own on bpmn-moddle, unmerged; its ADR was numbered 0008, a number main has since
  given the rename — #236 calls the A/B gate below "the ADR 0008 gate")
- **Related:** [0003](0003-module-architecture-and-shared-packages.md) (the use-case sits in
  `application/` with its I/O injected; the engine needs none — it is a function of the text),
  [0005](0005-in-process-mcp-and-oidc-resource-server.md) (the in-process `/mcp` the tools
  extend), [0006](0006-notation-plugins-and-structured-doc-shape.md) (BPMN stays a text room)

## Context

An agent that changes a process through `save_bpmn_xml` rewrites the whole XML, BPMNDI
included: it must compute coordinates, keep lanes, shapes and edges in sync, and send the
file back in full. That costs tokens, fails often on the save gate (missing DI, dead ends)
and moves shapes a person drew by hand. PR #218 proposed semantic tools instead — an
outline without XML, operations on element ids, geometry computed by the platform — and an
editor of its own to back them.

Miragon's [bpmn-cli](https://github.com/Miragon/bpmn-cli) (`@miragon/bpmn-cli`, MIT) started
from the same idea and was extended along the lines of #218. Issue #236 benchmarked both
on 60 real, modeler-drawn models plus 111 synthetic scenarios:

| On 60 hand-drawn models, edits pooled                      | PR #218  | bpmn-cli (incremental) |
| ---------------------------------------------------------- | -------- | ---------------------- |
| existing nodes moved > 5 px (median share)                 | 0 %      | 16 %                   |
| runs adding a hard layout defect                           | 31 / 263 | 0 / 263                |
| blind visual judging of edits, ranked first (52 judgments) | 8        | 43                     |

The issue also listed roundtrip fidelity as open: 16 % of bpmn-cli's no-op writes were
byte-identical then, against 64 % for #218. bpmn-cli's own audit measures 262 of 265 real
files (98.9 %) since its text-preserving write (0.3.0; #218: 169).

The issue also lists ten defects of #218's editor (sequence flow ids colliding with message
flow ids, `remove` leaving dangling associations and message flows, edges without
waypoints, a dry run that skips the validator, `changeType` dropping extensions, missing
expressiveness for start events, sub-processes, boundary events, annotations, pools and
message flows). One shared engine is cheaper than two parallel BPMN editors.

## Decision

1. **The engine is `@miragon/bpmn-cli`, an exactly pinned npm dependency of the live host**
   — not a copy in this monorepo. Its core (`applyToXml`, `layoutXml`, `showXml`) is a
   browser-safe function of the text; a version bump is how fixes arrive (Dependabot opens
   each bump as its own PR: a 0.x minor can change what agents see). Only the core is used —
   `pnpm arch` (`bpmn-cli-core-only`) keeps out its `./node` entry, which writes files past
   the save gate. No `@designiq/bpmn-edit` package: the glue is live-host specific (content
   I/O, the save gate, error mapping), and a browser consumer would import the engine
   directly.
2. **Three opt-in tools on `/mcp`** (`apps/live-host/src/application/bpmn-edit.ts`, wired in
   `http/mcp.ts`, registered with `LIVE_MCP_BPMN_EDIT=1`):
   - `get_process_outline` (read; also on read-only hosts): the model as compact text — ids,
     kinds, names, lanes, links, flows, problems — or one view of it (the neighbourhood of an
     element, an element in its context, one scope, a text search), plus the save gate's
     findings. No XML, no geometry.
   - `edit_process` (write): bpmn-cli's batch of operations (`add`, `connect`, `set`,
     `remove`, `retype`, `move`, `order`, `ext`, `split` and the diagram-only format ops) as
     one transaction. The tool description carries the op table, kinds and triggers derived
     from the pinned engine's own schema, so it follows the version.
   - `layout_process` (write): `tidy` keeps the drawing and removes overlaps; `redraw` draws
     it anew (only when asked: it replaces the drawing people see).

   Results never contain XML: what was created, changed and removed (with where), aliases,
   the warnings the change added, the layout score.

   The tools are registered inline in `createLiveMcpServer`, not through its
   `LiveToolContribution` hook: a contribution runs after the server instructions are fixed
   and gets none of the presence-aware read and write, the path resolution or the shared
   argument shapes the save tools use — the hook would have to grow all of them first.

3. **A hand-made diagram is kept.** bpmn-cli places new elements next to their neighbours
   and makes room like the modeler's space tool; a drawing the engine made itself, or none,
   is drawn in full. New ids follow the file's style and speak. Text the change did not
   touch keeps its bytes, so the live document's minimal-diff write stays small.
4. **A model executes nowhere until a process says so.** A document none of whose processes
   is executable is edited as a design model (`platform: none`), whatever platform the
   modeler declared, without the engine's Camunda 7 / 8 warnings. An executable one gets
   its platform's link spelling and those warnings.
   _Amended 2026-10-14 (#248):_ in a design model a decision link keeps the file's spelling
   (bpmn-cli 0.7.0, [Miragon/bpmn-cli#42](https://github.com/Miragon/bpmn-cli/issues/42)). A
   task's own `camunda:decisionRef` or `zeebe:calledDecision` is updated in place, the latter
   with its `resultVariable`. A new link takes the engine spelling all the file's other links
   share, else it is the unprefixed `calledDecision`. 0.6 wrote the unprefixed one on every
   `set` and dropped the others. design-iq reads every spelling.
5. **The save gate decides, twice.** Inside the engine's transaction design-iq's own
   validator (`checkModel`) runs before and after the change and refuses an error the change
   adds (with `lint: "warn"` it reports it instead). A design-iq finding names no element, so
   a counted message keeps its identity while its count does not grow. The engine's other
   guards hold in every mode: it never drops content it cannot read or a retype would
   delete. The result is then saved through `putContent` like `save_bpmn_xml`: the whole
   document is gated (`lint`), the write is a compare-and-set, co-editors see it at once. A
   refusal for errors the document already had says so and how to go on (repair them in the
   same call, or `lint: "warn"`). A dry run asks the same gate (`checkContent`), so it never
   says ok to a save the gate refuses.
6. **A concurrent change is re-applied, not returned** — the operations are semantic. The
   tool takes the newer text, applies the operations again (three attempts in all) and notes
   it in the result; operations the co-editor's change made inapplicable come back as a
   conflict that says so. A call that must not apply twice (a retry after a timeout) pins
   `baseVersion` and gets a conflict instead.
7. **Errors stay the engine's.** An engine refusal is a tool error that starts with its
   code (`E_NOT_FOUND in ops[1]: …`), with candidates, the errors a change would add (or the
   content a lossy import would drop) and a hint; the AppError code is `bpmn-edit/<code>`. A
   save the gate refuses starts with the gate's verdict instead. The engine's reading and checking commands
   in its texts become tool names (`bpmn show` → `get_process_outline`); an op command
   stays, and the tool description maps a flag onto its op key.

**Gate:** the tools stay opt-in until #218's A/B run (30 tasks, 5 repetitions: no loss in
success, +20 pp success on large models, −50 % tokens on medium and large ones, no extra
collateral, 0 hard defects) has run with this engine as its arm — arm A on a host without
the flag, since the server instructions name the tools. #218's harness
(`packages/bpmn-edit/bench/agent`) is not taken over; it moves next to the tools when the run
is due. Until the gate passes the content repo's skills and the web app's "Implement" todo
prompt keep using `save_bpmn_xml`, which stays.

## Consequences

- One BPMN editor across the CLI, its Claude Code plugin and designIQ; a fix in the engine
  reaches the platform with a version bump, reviewed as a dependency change.
- The live host image carries the engine's dependencies: `bpmn-moddle` (the version bpmn-js
  brings already), `bpmn-auto-layout` (loaded only on request) and `@resvg/resvg-wasm`
  (MPL-2.0, used only by the engine's PNG rendering, which the host does not call).
  _Amended 2026-10-14 (#248):_ since bpmn-cli 0.7.0 also `bpmnlint` and
  `@miragon/bpmnlint-plugin-rules` (with `bpmnlint-plugin-camunda-compat` and the Camunda
  moddles; MIT and ISC). The engine's core never imports them. It runs bpmnlint only when
  a host passes in a bpmnlint validator (`bpmnlintValidator` with bpmnlint's `Linter` and
  a resolver). The CLI and the engine's `./node` entry load them (the `.bpmnlintrc`
  lookup, `bpmnlintEngine()`). The live host passes none, so the tools run no bpmnlint.
- _Amended 2026-10-13 (#248):_ the engine has no copy of the save gate. bpmn-cli 0.7
  removed its design profile, which the live host had switched off (`profile: "none"`),
  and its lookup of the legacy `bpmiq.yml` ([Miragon/bpmn-cli#35](https://github.com/Miragon/bpmn-cli/issues/35)).
  It never read `designiq.yml`.
  design-iq's validator is the only check of design-iq's rules: inside the engine here,
  and `npx @miragon/design-iq-validator` on a checkout of a content repository. An engine
  lint warning and a design-iq finding about the same element can both appear in a result.
- Open: the A/B run; then the "Implement" prompt and the authoring skills (`new-process`,
  `import-process`, `capture-process`, `process-feedback`) on the tools. Upstream in
  bpmn-cli: warn when `ext` adds another platform's extension.
