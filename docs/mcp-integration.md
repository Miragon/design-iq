# Integrations

AI assistants join designIQ through MCP: they read the same models the team works on, explain
them, check them and propose changes. This page covers the ways tools _outside_ the content
repo's skill layer consume the models.

The MCP tools start with the models of **any** notation (`@designiq/notations`: BPMN, DMN,
Wardley Map, Team Topology, Event Storming, Context Map, Value Chain, Markdown). On both
surfaces below, `list_models` covers every notation and `get_view` every one but Markdown; the
read-only server adds graph analysis across notations (`get_model`, `enumerate_paths`,
`find_cycles`, `which_models_use`); the Live Host reads, validates and saves any model's source
text (`get_model_content`, `validate_model`, `save_model_content`, `create_model`) and renders
six of the notations as modelers inline in the chat. Todos are filed on the models of every
notation but decisions and Value Chains, optionally anchored to their elements. BPMN and DMN
have extra tools on top: the derived process and decision views, the XML round-trip, roles from
lanes, decision simulation, analysis and tests.

Diagrams as code are no notation of their own: a diagram is a `mermaid` code fence in a
Markdown document, next to the prose that explains it, and a document links the models it talks
about instead of redrawing them. `validate_model`, the save gate and `pnpm validate` check the
diagram type of every such fence (a WARN, `mermaid/diagram-type`, naming the document's line),
and a WARN never refuses a save. A standalone `.mmd` or `.mermaid` file is a plain repository
file again (5.4.0 listed it as a model; from 5.5 the app no longer lists, opens, renames or
deletes it). Move it in Git, `git mv flow.mmd flow.md`, then wrap its text in a `mermaid` code
fence. On a Live Host, release any unreleased edits of such a file before the upgrade: from 5.5
nobody can open them in the app.

The platform has **two MCP surfaces**:

- **`packages/mcp`**: read-only, runs against any checkout, zero infrastructure.
- **the Live Host's `POST /mcp`**: read-write against the **live**, collaboratively-edited
  state, with per-repo auth, served by the running platform.

Rule of thumb: talk _about_ released models → `packages/mcp`; read or **edit**
work-in-progress → the Live Host endpoint.

Both servers send MCP server instructions at initialize: the registered notations, where a
Mermaid diagram goes (a `mermaid` fence in a document; a model of any notation is linked or
created, never redrawn in Mermaid), the tools that work for every notation (start with
`list_models`; on the Live Host, `list_repos` first), and where BPMN and DMN go deeper.

## MCP server (`packages/mcp/`)

A minimal, read-only [MCP](https://modelcontextprotocol.io) server that exposes a content
repo's models: every registered notation, with the richest views for BPMN processes. Any MCP
client (Claude Code, other IDEs, agent frameworks) can query the models **live from HEAD**: a
content repo is a root `designiq.yml` naming its models folder (`models:`, legacy alias
`processes:`; the legacy file name `bpmiq.yml` is still read), a model IS a file with a
registered notation extension there (a process its `.bpmn`, a decision its `.dmn`, a Wardley
Map its `.owm`, …), and its view is **derived from the model** at call time
(`@designiq/notations/derive`; the process view from the BPMN). No build step; the tool
definitions live in `packages/mcp/tools.ts`, shared by two entry points:

- `packages/mcp/server.ts`: **stdio**, for local use (Claude Code auto-connects via `.mcp.json`)
- `packages/mcp/http.ts`: **Streamable HTTP** (`POST /mcp`), for remote use; the root
  `Dockerfile` packages exactly this

| Tool                         | Question it answers                 | Reads / derives                                                                                                                                                     |
| ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_models`                | What models exist, of ANY notation? | every registered-notation file under the `designiq.yml` folder, grouped by notation: id (file stem), path, plus name/summary/stats where the notation has a deriver |
| `list_processes`             | What processes exist?               | every `.bpmn` under the `designiq.yml` folder: id (file stem), derived name, path, stats                                                                            |
| `get_process(id)`            | Everything about one process        | the derived view: name, roles (BPMN lanes), steps (with role), gateways, events, flow, sub-process calls                                                            |
| `get_view(id)`               | The view of ANY model               | name, summary, stats + the rich notation payload in `detail` (every notation with extract+derive)                                                                   |
| `get_model(id)`              | What does the MODEL say?            | ANY model parsed into a generic graph (nodes/edges/meta) via `@designiq/notations/extract`                                                                          |
| `enumerate_paths(id, max?)`  | Which ways can a case take?         | start→end path enumeration over the notation's flow edges (graphHints; cycle-safe, capped)                                                                          |
| `find_cycles(id)`            | Where does the flow loop?           | the notation's flow edges per graphHints (BPMN sequence flows, Wardley dependencies, DMN requirements)                                                              |
| `who_owns(id)`               | Who does what?                      | the BPMN lanes (roles) and the steps each contains; the pools                                                                                                       |
| `which_processes_use(query)` | Impact: what references this?       | each process's id, derived name, role names, step names, and `callActivity` `calledElement`                                                                         |
| `which_models_use(id)`       | Impact, across EVERY notation       | the repo-wide reference index (typed cross-model refs: calls, decides, …), incl. dangling references                                                                |
| `list_todos(id?, notation?)` | What work is open (opt-in)?         | the content repo's issue tracker (label `todo` + `<notation>:<id>`), anchors parsed from issue bodies                                                               |

A Team Topology's graph has no edges: its teams, interactions, flows of change and annotations
are all placed shapes, so each is a node (a team keeps its team type, the others are of type
`interaction`, `flow` and `annotation`). A flow is named by its label and an annotation by its
text; an annotation attached to a team, interaction or flow names it in `extra.attachedTo`.
`meta.title` is the document title. `get_view`, here and on the Live Host, reports that title
as the model's `name` and counts `teams`, `interactions`, `flows` and `annotations` in `stats`;
the summary names flows and annotations only when the topology has any. Its `detail` lists each
element under the `.tt` file's own field names: `teams` (`id`, `label`, `type`, `description`),
`interactions` (`id`, `label`, `mode`), `flows` (`id`, `label`) and `annotations` (`id`, `text`,
`attachedTo`). The Live Host has no `get_model`, so there `detail` is where an agent reads the
flow labels and the annotation texts.

A Wardley Map is read with `@miragon/wardley-dsl`, the parser its canvas reads it with (pinned
to the release `@miragon/wardley-renderer` depends on), so a node's id is the canvas's element
id: `cmp_` and the name's slug for a component (lowercase, every other run of characters one
`_`, `_2` on a clash: `cmp_cup_of_tea`), `anchor_`, `pipeline_`, `submap_` and `accel_` for the
other named elements, with the name in `name`. Read an id from `get_view`, never build it by hand
(`Größe` is `cmp_gr_e`, `茶` is `cmp_x`). Notes, annotations, regions and
drawings are no nodes: the parser takes their ids from the line order, so an edit above them
moves the id to another element. A link is an edge of kind `dependency` (`A -> B`) or `flow`
(`A +> B`) between those ids, numbered `dep_1`, `flow_1` by line order in `get_model`. `get_view`
counts `components` and `dependencies` in `stats` and lists the nodes in `detail.elements` (`id`,
`type`, `name`, the position) and the links in `detail.links` (`from`, `to`, `kind`, `label`,
with no id: no canvas addresses a link, so a todo cannot anchor to one).

All tools carry `readOnlyHint` annotations, so clients may auto-approve them, and a short display
`title` ("List models", "Get BPMN process view") that clients show people instead of the tool
name (`test/tools.test.ts` pins that every tool has one and no two share it). The content repo
is configurable: `node server.ts --root /path/to/repo` or the `DESIGNIQ_CONTENT_ROOT` env var.
The bundled `process-documentation/` is only the default. Outside this monorepo the published
package runs the same server: `npx @miragon/design-iq-mcp --root /path/to/repo` (bin
`designiq-mcp-server`).

`list_todos` is the one tool that leaves the checkout (a read-only query against the repo's
issue tracker) and is **strictly opt-in**: it only registers when both `DESIGNIQ_TODOS_REPO`
(`owner/name`) and `DESIGNIQ_TODOS_TOKEN` (a token with issues:read) are set. Without them the
server stays zero-auth and the tool does not exist. `GITHUB_API_URL` overrides the REST base
(default `https://api.github.com`). The pre-rename names `BPM_CONTENT_ROOT`, `BPM_TODOS_REPO`
and `BPM_TODOS_TOKEN` are still read; when both names of a variable are set, `DESIGNIQ_*` wins.

### Live from HEAD vs. exported snapshots

`export-process-skill` remains the right tool for **external** consumers (a claude.ai
project, another repository's `.claude/skills/`) because its output under `dist/skills/<id>/`
is self-contained and needs no repo access. But a snapshot starts rotting the moment the model
changes. **Internal** consumers that can reach this repository should not accept that
staleness: the MCP server has no snapshot to rot, so a model edit is visible on the very next
tool call.

Rule of thumb: repo access → MCP server. No repo access → `export-process-skill`.

### Setup

```sh
pnpm install        # monorepo root — installs all workspace packages
```

Requires Node >= 23.6 (runs the TypeScript server directly via built-in type stripping). That is all:

- **Claude Code** reads the repo-root [`.mcp.json`](https://github.com/Miragon/design-iq/blob/main/.mcp.json) and connects automatically
  when you open the repository (you approve the server once).
- In **any other MCP client**, register a stdio server:

  ```json
  {
    "mcpServers": {
      "designiq-content": {
        "command": "node",
        "args": ["/absolute/path/to/design-iq/packages/mcp/server.ts"]
      }
    }
  }
  ```

### Remote: the read-only server over HTTP

A deployed instance of the read-only server serves its tools at `POST /mcp` over
Streamable HTTP. It is stateless, so no session management is needed:

```sh
# Claude Code
claude mcp add --transport http designiq-content https://<app>/mcp

# any HTTP MCP client: point it at https://<app>/mcp
```

The MCP endpoint is public by default; to require auth, set `MCP_TOKEN=<token>`, and clients must
then send `Authorization: Bearer <token>`. Local development: `PORT=8080 node packages/mcp/http.ts`.

## Live Host MCP endpoint (`apps/live-host`)

The Live Host serves its own MCP endpoint at `POST /mcp` (official MCP
TypeScript SDK v2, stateless Streamable HTTP): same container, same port as
sync, REST API and web app. Where `packages/mcp` reads a checkout, this endpoint reads and
**writes the live collaborative state**: the same Y.Text the browser tabs and VS Code edit,
accessed server-side via a Hocuspocus direct connection. `repo` is a **tool argument**
(`owner/name`), not a URL segment: one endpoint serves every connected repo, and every
call is gated by the caller's per-repo permission.

| Tool                          | Kind  | What it does                                                                             |
| ----------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| `list_repos`                  | read  | The connected repos the caller may work on, with the caller's own favorites + visits.    |
| `list_models`                 | read  | EVERY model file of one repo, grouped by notation (the superset of the two lists below). |
| `get_view`                    | read  | The derived view of ANY live model (name, summary, stats, rich `detail`).                |
| `get_model_content`           | read  | The live text of ANY model (`content`, own format) plus the `baseVersion` for a save.    |
| `get_presence`                | read  | Who is in a model's live room right now: name, selection, pointer; `you` = the caller.   |
| `validate_model`              | read  | Dry-run the platform check on ANY notation's text: the same gate the save runs.          |
| `list_processes`              | read  | The processes of one repo (id, `bpmn` path, folder, dirty flag, live sessions).          |
| `get_process`                 | read  | The derived view (name, roles, steps, flow, calls) from the **live** BPMN.               |
| `get_bpmn_xml`                | read  | The live BPMN XML plus the `baseVersion` for a later save.                               |
| `validate_bpmn`               | read  | Dry-run the platform validator on submitted XML: check before saving.                    |
| `get_process_outline`         | read  | Opt-in (`LIVE_MCP_BPMN_EDIT=1`): a live process as compact text, no XML. See below.      |
| `list_decisions`              | read  | The DMN decisions of one repo (id = `.dmn` file stem, path, dirty, live sessions).       |
| `get_decision`                | read  | The derived decision view (hit policy, columns, rules, DRD wiring). See below.           |
| `get_dmn_xml`                 | read  | The live DMN XML plus the `baseVersion` for a later save.                                |
| `simulate_decision`           | read  | Run one scenario and see which rules fired, on the live model or unsaved `xml`.          |
| `analyze_decision`            | read  | Static checks (broken FEEL, dead rules, dead wiring) + test-value candidates.            |
| `run_decision_tests`          | read  | Run the stored test suite (or cases passed inline) with rule coverage.                   |
| `get_decision_tests`          | read  | The stored suite + the `baseVersion` a save needs.                                       |
| `list_changes`                | read  | A repo's unreleased live changes.                                                        |
| `list_todos`                  | read  | Open model-anchored todos, for the whole repo or narrowed to one model.                  |
| `open_modeler`                | read  | Open the embedded BPMN modeler widget (MCP App). See below.                              |
| `open_decision_modeler`       | read  | Open the embedded DMN modeler + simulator, optionally with a scenario applied.           |
| `open_wardley_modeler`        | read  | Open the embedded Wardley Map modeler widget (MCP App, the widget core).                 |
| `open_team_topology_modeler`  | read  | Open the embedded Team Topology modeler widget.                                          |
| `open_event_storming_modeler` | read  | Open the embedded Event Storming board widget.                                           |
| `open_context_map_modeler`    | read  | Open the embedded Context Map modeler widget.                                            |
| `create_model`                | write | Scaffold a model of ANY template-capable notation from its blank template.               |
| `save_model_content`          | write | Validated, conflict-guarded save of ANY model's text into the live document.             |
| `create_process`              | write | Scaffold a new process `.bpmn` in the live workspace.                                    |
| `save_bpmn_xml`               | write | Validated, conflict-guarded save into the live document (requires `baseVersion`).        |
| `edit_process`                | write | Opt-in: change a live process with operations on element ids; the diagram is computed.   |
| `layout_process`              | write | Opt-in: tidy or redraw a live process's diagram.                                         |
| `create_decision`             | write | Scaffold a new decision `.dmn` from the blank template.                                  |
| `save_dmn_xml`                | write | Conflict-guarded save of DMN XML into the live document (requires `baseVersion`).        |
| `save_decision_tests`         | write | Write `<decision>.tests.yaml` next to the model (`record` freezes today's behaviour).    |
| `list_todo_types`             | read  | Forms a todo is filed with (registered with `create_todo`, not in read-only mode).       |
| `create_todo`                 | write | File a todo of a type on a model and (optionally) concrete elements of it.               |
| `close_todo`                  | write | Complete a todo in the tracker (`todoId` from `list_todos`).                             |
| `release_process`             | write | Open the release PR. Merge rights stay at the git provider.                              |

Every tool also carries a short display `title` in sentence case, verb first, naming the notation
where the tool is notation-specific (`get_bpmn_xml` "Get BPMN XML", `open_decision_modeler` "Open DMN
modeler", `release_process` "Release changes as pull request"). Clients show it to people instead of
the tool name. `test/mcp.test.ts` pins that every registered tool has one and no two share it.

### Any notation: the generic model tools

`get_model_content`, `save_model_content`, `create_model` and `validate_model` are ONE tool
set for the whole notation registry (`@designiq/notations`: bpmn, dmn, wardley, team-topology,
event-storming, context-map, value-chain, markdown) beside the wire-pinned BPMN/DMN twins. They address a
model as `{repo, id | path, notation?}`: `id` is the file stem `list_models` shows; a stem
shared across notations resolves bpmn-first unless `notation` picks another. The text travels
as `content` in the notation's own format (XML, the OWM/`.storm` DSL, JSON, Markdown). The save
runs the same `checkModel` gate as `pnpm validate` and the REST PUT (ERROR findings refuse the
save under the default `lint:"block"` and are reported under `"warn"`) and is compare-and-set
like `save_bpmn_xml`: a stale `baseVersion` answers `{conflict: true, currentContent, baseVersion}`.
For a Team Topology (`.tt`, `.ttm.json`), a Context Map (`.cm.json`) or a Value Chain (`.vc.json`)
the gate is the notation's schema model, the one its canvas opens the file with. Whatever the
model rejects is an ERROR at its JSON path (`nodes.1.id: duplicate id "a"`; rule ids
`team-topology/schema`, `context-map/schema`, `value-chain/schema`), so the save refuses a file
the canvas could not open. Rejected are a duplicate id and the ids a diagram keeps for itself:
`tt-root`, `cm-root`, `vc-root`, every id starting with `__implicitroot`, `assoc_<annotation id>`
in a Team Topology, and in all three notations the names of built-in object properties such as
`constructor` or `toString`. In all three notations a file nested deeper than 100 levels is
rejected too.
A Team Topology whose `version` is not 1 (a file without `version` included) is also rejected with
an interaction that has no `position` or `size` (a version 1 file still opens without its edge
interactions); a Context Map as a list, with
a `version` above 1 or with coordinates or sizes beyond 1,000,000; a Value Chain with extra keys in
`bounds` or in a waypoint, with coordinates beyond ±1e9 or with a `__proto__` key. A Context Map's
strategic-DDD rules (`protect-or-conform`, `endpoints-on-map`, …)
are WARNs, `context-map/semantics`: the canvas opens such a map and marks the finding. Some rules
only run once the file's shape is valid, so `validate_model` can report further errors after a
fix: check again until it answers `ok`.
`create_model` scaffolds every notation with a template (bpmn, dmn, wardley, team-topology,
event-storming, context-map, markdown); a notation without one (value-chain) arrives via git only.
`LIVE_MCP_READONLY=1` keeps the two read tools and drops the writes. The embedded modelers'
`mint_ws_ticket` takes the same ref, so the Wardley, Team Topology, Event Storming and Context Map widgets
(below) upgrade to live co-editing exactly like the BPMN one. (`mint_ws_ticket` itself is
app-visible, hidden from agents, and registered when at least one live-capable widget is
served AND the host is not read-only, bound to the first such widget's resource; absent under
`LIVE_MCP_READONLY=1`, absent for a DMN-only dist.)

### Agent presence: the AI shows up like a co-editor

Every tool call that touches a model announces the caller's agent in that model's live room
for a while (60 s after the last call, renewed by every call). People who have the model open
see an **"AI · &lt;name&gt;"** avatar in the roster (named after the person the agent acts for), and
after a save the elements the agent changed are outlined on the canvas in the agent's color,
with its name pill on the first one: the agent's cursor. Nothing is written into the document:
the presence is an awareness state the Live Host publishes into a LOADED room
(`application/agent-presence.ts`); an unloaded room has nobody to show it to and is never pinned
for it. `kind: "agent"` is server-asserted: a browser peer claiming it is downgraded on the way
in (`collab.ts`, `beforeHandleAwareness`). The modeler widgets announce the HUMAN behind them
the same way once live (`mint_ws_ticket` carries their name and color), and the diagram-js widgets
(BPMN and the Miragon renderers) publish that person's pointer and selection and render the peers'
cursors on their own canvas (the web shell's presence controller, unchanged). On the Miragon
renderers the selection travels as the document's element ids (`@miragon/modeler-api`'s element
surface), the ids the Live Host derives from the same text for the elements an agent changed
(`cmp_<name>` for a Wardley component). An id the canvas does not know is looked up as an element
name and outlines every element of that name (a component and its pipeline). A selection of
something the element surface does not address (a Wardley note, annotation, region or drawing,
an Event Storming note or drawing) is not shared.

The other direction is `get_presence`: who is in a model's room right now, with every person's name,
selected element ids and pointer (model coordinates), the AI clients acting in it (`kind: "agent"`),
and `you` on the caller's own human presence. The identity behind `you` is server-side (the ws
connection's login, never the payload), so "analyse the element I have selected" resolves to a real
selection. It holds across reconnects: the Live Host ties a client to the connection it last came on
(`application/awareness-ties.ts`), and a connection of another login never takes a client over. It
reads a loaded room only and announces nothing itself.

### Decisions: DMN as a first-class model

A decision **is** a `.dmn` file under the same `designiq.yml` folder (id = file stem), so the
decision tools mirror the process tools one-to-one: `list_decisions` → `get_decision` →
`save_dmn_xml`, all addressed by `id` or `path`, all conflict-guarded the same way.

`get_decision` returns the **derived view**, not the XML: every decision with its hit
policy, aggregation, input/output columns and rule rows (`when`/`then` hold the raw FEEL
source text, aligned to the columns), plus the DRD wiring: which InputData and which
upstream decisions each one requires. That is the shape to reason about the logic in; read
the XML only when you intend to write it back.

### Simulating and analysing a decision

`simulate_decision` runs one scenario through the decision and reports **which rules
fired**, by rule id. `given` is keyed by variable name (the columns' input expressions,
not their labels); a table written without modelled InputData works exactly the same
(`analyze_decision` lists the variables it needs). The whole DRD is evaluated in
dependency order, so a chain comes back decision by decision, each with its matched and
reported rules, outputs, aggregation and any hit-policy violation. Keys that match no
variable, and variables the scenario left unset, are reported rather than quietly
behaving like a rule that did not match.

`analyze_decision` is the pass that needs **no** test data. It exists because every FEEL
engine treats a broken expression as "did not match": a typo in a rule is otherwise
indistinguishable from a rule that legitimately did not apply. It reports FEEL that does
not parse, rules that can never fire (or that guarantee a UNIQUE violation), requirements
whose result variable nothing reads, and cycles. It also returns, per variable, the literals and
numeric boundaries the rules use: the raw material for writing test cases.

Both take either a stored decision (`repo` + `id`/`path`) or an explicit `xml`, the
same dry-run shape as `validate_bpmn`, so an edit can be checked before it is saved.

Evaluation runs on `@designiq/decisions`, and MCP is only one of its callers: the package is
**isomorphic**, so the very same module also runs in the browser: in the web client's
live DMN editor (the **Checks** panel: findings and "try a scenario" without a
round-trip) and in the MCP-App widget. Together with the engine it drives
(`@emaarco/dmn-js-simulation`, FEEL via `feelin`, the add-on dmn-js mounts), that means a
scenario an agent simulates, one a human clicks and one CI runs are the same computation
rather than three implementations that agree until they don't.

### Decision tests: the sidecar

A decision's test cases live in **`<decision>.tests.yaml` next to the model**, an
ordinary repo file that diffs, reviews and ships in the same release PR:

```yaml
decision: credit-limit-check
cases:
  - name: A blocked customer is rejected even for a tiny, clean order
    given: { customerSegment: blocked, orderValue: 50, overdueInvoices: 0 }
    expect:
      value: reject
      rules: [Rule_blocked_customer] # WHICH rule produced it
```

`expect.rules` is what makes a case more than an output check: a right answer produced by
the wrong rule still fails. A case with **no** `expect` is legal: it comes back as
`pending` together with the value it currently produces, and `save_decision_tests` with
`record: true` freezes exactly that (golden master). That is the one honest way for a
machine to author expectations: it states what the model does today, which makes the next
change visible. Expectations about what the model _should_ do belong to the business.

`run_decision_tests` also reports **rule coverage**: `uncoveredRules` lists every rule
whose result no case ever observed. Note the distinction it draws: under `FIRST` a
shadowed rule can match in every case without ever deciding anything, so "matched" would
overstate coverage; the metric counts rules the hit policy actually _reported_.

The same suites run headless in CI: `pnpm validate` invokes the platform validator
(structure, DMNDI, requirement integrity) and then `packages/decisions/cli.ts`, which
analyses every `.dmn` in the checkout and runs its cases. Exit code 1 on an error or a
failing case.

### Which process uses which decision

A `businessRuleTask` names the decision it delegates to: the platform reads
`decisionRef` (Camunda 7), `<zeebe:calledDecision decisionId>` (Camunda 8) and a plain
`calledDecision` or `calledElement` (hand-written models), and in every spelling the
value is the **`.dmn` file stem**, exactly like `callActivity`'s `calledElement` is a
`.bpmn` file stem. From that one link:

- `get_process` lists the decisions a process delegates to (and each step carries its
  `decides`),
- `get_decision` returns `usedBy`: the processes and the concrete task ids that call it,
  which is the impact answer before changing a table,
- the validator warns when a `businessRuleTask` points at a decision the repo does not
  contain (a warning, not an error: the decision may live in another system).

### The release PR explains what the decision now decides

When a release ships a `.dmn` (or only its `.tests.yaml`), the PR body gains a **Decision
impact** section: the suite is run against both the workspace version and
`origin/<default>`, and every case whose answer moved is listed with before and after.
A DMN diff is unreadable (reordered rules, renamed ids, a `>=` that became a `>`); a
table of changed answers is a review a business reader can actually do. The section also
carries the static findings and, when a decision has no cases at all, says so plainly.
It degrades quietly (new decision, no suite, no git access): a release never fails
because its commentary could not be produced.

### Todos: work items in your own tracker

`list_todos` / `create_todo` / `close_todo` speak to the **IssueTracker port**
(`ports/issue-tracker.ts`): model-anchored work items live as first-class items in the
customer's own tracker (GitHub: repo issues labelled `todo` plus one label for the model),
never in a platform database. Items are bot-authored via the installation token and the human
stays attributed textually, the same model as releases. The anchor (notation, model id, model
file, element ids with a name snapshot) rides invisibly in the item body, so an agent can file
"this gateway needs a decision table" against an element id and the modeler shows a badge
on exactly that shape.

Todos are filed on processes, Wardley Maps, Event Storming boards, Context Maps, Team
Topologies and Markdown documents (the notation descriptor's `todos` flag in
`@designiq/notations`); a decision or a Value Chain takes none yet (a typed 400). Model ids are
file stems, unique per notation but not across them, so the label names the notation:
`<notation>:<id>` (`bpmn:order-to-cash`, `wardley:tea-shop`).
`create_todo` and `list_todos` take a model as the generic tools do (`id` or `path`, `notation`
for a stem shared across notations; without it a process wins). Element ids are the ones the
canvas reports: a process's from `get_process` (any element of the BPMN counts, a lane or a pool
too), a canvas model's the ids `get_view` lists in `detail` (a Wardley component's is `cmp_` and
its name's slug, `detail.elements` has it, its name is in `name`). Only what the canvas addresses
is an anchor: a Wardley link, an Event Storming note, drawing or arrow takes its id from the line
order and is refused like an unknown id. `create_todo` and `POST …/todos` hold every id against
the model's live text and refuse one it does not have (`todos/unknown-element`, a 400) with the
closest ids it has, ranked by edit distance over the model's ids and names, so a component asked
for by its name answers with its id. A text that does not parse at that moment (a peer mid-edit
in the source) is not checked. A todo anchored to a Wardley component's name before that check
still lands on its component: the canvas looks an anchor it does not know up by name. A Markdown
document takes todos on the whole document, without elements (`todos/elements-unsupported`).
A rename moves a model's todos along and a delete closes them on request, in
the background, as for a process. The links in an item body open a process on its process
route and any other model on the file route (`/f/<path>?element=<id>`), where the element is
revealed once the canvas has imported. A move to another folder keeps the model's id, so
nothing is rewritten in the tracker: the label still finds its todos, `list_todos` names the
model's current file in `anchor.file`, and a link to the old path follows the model to its
new folder (the file route finds it by notation and id).

The todo tools register **only when the platform has tracker credentials**: no tracker,
no tools in `tools/list` (agents plan against reality instead of discovering it by failing).
Listing is a read and survives `LIVE_MCP_READONLY=1`; filing and closing do not, and
`list_todo_types` goes with them. Every call runs the same per-(user, repo) authorization as
the model tools.

**Todo types follow the repo's issue templates.** `list_todo_types` returns the forms a todo
can be filed with: every issue form in `.github/ISSUE_TEMPLATE/` on the default branch (its
fields, options, required flags and the form's hint text), a Markdown template as one
prefilled description, and the built-in `todo` (a title and a description, the todo as it
always was). The built-in is offered when the repo has no templates, when
`blank_issues_enabled` is not `false`, and when the repo's manual `todo` form (the one
labelled `todo`, hidden as a type: the platform fills its anchor itself) was the way to file
plain todos. `create_todo` takes the `type` and its `fields` by id; a missing required field
fails with the list of what is missing, the same check the web dialog and the widget run
inline (`@designiq/contracts/todo-types`). The issue gets the form's body as GitHub renders a
submitted form, the template's title prefix, and the labels `todo` + the model's label plus the
template's labels that exist in the repo. The type rides in the anchor block, so the lists
show it after a label was edited by hand and after a rename. Templates are read at most every
five minutes per repo.

### MCP Apps: the embedded modelers

Every `open_*` tool is an [MCP App](https://modelcontextprotocol.io/specification/2026-01-26)
(`io.modelcontextprotocol/ui`): in apps-capable clients (claude.ai, Claude Desktop) it
renders the notation's modeler inline in the conversation. There are six single-file
bundles (`apps/web/dist/mcp-app*.html`, built by `apps/web/scripts/build-widgets.ts`),
one per modeler, and ONE widget core behind all of them (`apps/web/src/mcp-app/core/`):
every widget shares the load → autosave → conflict → live-upgrade lifecycle and the
same chrome, and differs only in its engine adapter (the DMN engine, multi-view +
simulator, has no live binding and stays on autosave). The four Miragon-renderer
widgets are one template + one entry built once per renderer spec
(`apps/web/src/notations/miragon/`). A widget = engine adapter (or a renderer spec) +
one registry row in the Live Host; a web dist that lacks a bundle simply lacks its tool.

**The chrome: a frameless canvas.** There is no toolbar, banner row or status line.
The whole iframe is canvas, and the controls float in its corners, each kind of
information in one home:

| Where         | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| top-left      | the document menu: the model's name, its notation, repository and path, then Open in designIQ, Save now `⌘S`, Reload latest version, Workshop mode (bpmn), the panel, a Miragon renderer's Model and Export entries (Map title…, Diagram title…, Map size…, Level, Type captions, Legend, Export as PNG / SVG), Fit to view `⇧1`, fullscreen, and last the renderer's Keyboard shortcuts…. Beside it the Workshop switch (bpmn) or the DRD \| Table switch (dmn) |
| top-right     | the panel toggle (Todos with its open count, Checks with its test verdict, the Legend of a context map or a team topology), Open fullscreen / Exit fullscreen, and **Open in designIQ**                                                                                                                                                                                                                                                                          |
| bottom-left   | the sync pill, the one place that says whether your work is safe (below)                                                                                                                                                                                                                                                                                                                                                                                         |
| bottom-right  | zoom out, the zoom level (a click resets to 100%), zoom in, fit. In every widget ⌘ / Ctrl + `+`, `-` and `0` and ⇧1 do the same, anywhere but in a text field, and the buttons name them                                                                                                                                                                                                                                                                         |
| bottom-centre | toasts for events, and decision cards for choices the user owes                                                                                                                                                                                                                                                                                                                                                                                                  |
| centre        | state cards for dead ends, with the work chrome hidden                                                                                                                                                                                                                                                                                                                                                                                                           |

Labels give way as the frame narrows (the comet, then "Open in designIQ" → "Open", the
switches and toggles to icons, the name truncating; on a phone-width chat column the
Workshop and view switches, fullscreen and finally the name move into the menu), and below 600 × 440 the
widget turns compact: the palette folds behind a **Tools** button and the panels become
full-width sheets (so they do below 656px wide, where a card would leave the toasts too
little room beside it). Toasts and decision cards never cover an open panel: they pass
beside a card, and a sheet ends above them. They never reach the corner row either: at most
two toasts show (one beside a decision card, which always shows whole), and only what fits.
Over a sheet they leave it room to work in. A toast with an action waits for room and comes
back; the others leave, since what they say also lives on the pill, a panel or a toggle. The diagram fits clear of every cluster, the
palette and an open card, and re-fits on resize, on a panel toggle and on a live
re-import until the user zooms or pans; switching to fullscreen and back always re-fits. The widget declares its
inline height after connect (480px, 420px below 600px wide, capped by the host's
`maxHeight`). It sends it again only when the frame crosses 600px wide or returns to
inline from fullscreen. No state change ever resizes the iframe: cards, toasts and panels float.
Fullscreen is offered when the host lists it in `availableDisplayModes`. When the host
tears the widget down, a pending autosave is flushed first.

The **sync pill** speaks the SPA's vocabulary: _Live_ (with the avatars of everyone in
the document, the assistant included), _Connecting…_, _Saved_ (or _Saved · 1 warning_ /
_Saved · 2 errors_ with the validator's findings), _Unsaved changes_, _Saving…_,
_Not saved_ with a _Retry_ beside it, _Autosave paused_, _Reconnecting…_, _Read-only_
and _Inactive_. A click opens its details: why the widget saves the way it does, the time
of the last save, every finding, and Save now. Test verdicts never reach it. They live
on the Checks toggle. State changes are announced once per kind in a polite region,
never as Saving → Saved chatter; a failed save, a paused autosave and the superseded
copy are spoken by their own toast or decision card, so nothing is said twice.

**State cards** own the widget when there is nothing to work on: "Starting the
modeler…", "Loading order-to-cash…", "No model received" (the host sent no tool input),
"Could not load order-to-cash" (the read failed: **Try again**, Open in designIQ),
"order-to-cash could not be displayed" (the file does not parse: **Ask the assistant to
fix it** sends the path and the parser error into the chat through `ui/message`), and
"The Event Storming modeler could not start" (Try again).

`open_modeler` renders an interactive bpmn-js modeler: pan/zoom, edit, and save
through the same validated, `baseVersion`-guarded path as `save_model_content`
(`lint:"warn"`; a save tells the model to re-read instead of trusting stale text). A
concurrent save raises a **decision card** ("Someone saved this model in the
meantime.") with one row per choice and what it does: **Load their version** (your
last change is discarded), **Overwrite anyway** (their change is replaced right away),
**Keep editing** (your next autosave replaces their change). Autosave stays paused
until the user chooses; the card never steals focus from the chat composer, Escape
never dismisses it, and its × defers the choice into the pill ("Autosave paused"),
whose click brings it back. The widget is the single-file bundle
`apps/web/dist/mcp-app.html` (built by `scripts/build-widgets.ts`), served as a `ui://`
resource; its tool calls ride the host's authenticated connection, so per-repo
authorization applies per call exactly like agent calls.

The widget edits **live**: it first tries the same Hocuspocus/Yjs session the web
editor uses (a single-use, room-bound ws ticket from `mint_ws_ticket`, 60s TTL; see
ADR 0005's 2026-08-04 amendment). With that session, edits sync instantly in both directions,
co-editors included. If the host sandbox blocks the socket (claude.ai's
`connectDomains` enforcement is partially buggy), it degrades to **autosave over the
bridge**: a debounced `save_model_content` with `lint:"warn"`, where validator findings
inform in the pill instead of blocking (the ws rooms' trust level, which never
gated live edits). The pill shows which mode is active ("Live" vs "Saved"), and its
details say why. The hand-over is lossless in both
directions: unsaved canvas edits are flushed through the CAS save before the first
Yjs import may replace the canvas, and when an established live connection drops
(any ws drop is final: the single-use ticket cannot re-authenticate the provider's
auto-reconnect) the widget reconciles against a fresh bridge read: server unchanged
since the last sync → a fresh ticket resumes live seamlessly; diverged (colleague
edits during the outage, local edits that never reached the room, or both) → the
decision card "Live sync was interrupted" hands the direction-blind choice to the user
(**Load server version** or **Keep my canvas**), never a silent overwrite of either
side, and never a silent stop of persistence. A save that fails outright turns the pill
into _Not saved_ + _Retry_ and shows a toast with **Retry now**; the widget retries
after 5 s, 15 s and 60 s, then on the next edit.

**One widget per model.** Opening the same model again in the chat supersedes the older
widget: it saves a still-pending edit once, re-mounts its canvas as a viewer (zoom and
fit still work), and says so in an info card ("This model is open in a newer widget",
pill _Inactive_) whose one action is Open in designIQ.

The widget also carries the **todos** of the open process (as do the Wardley, Team Topology,
Event Storming and Context Map widgets for their models): the **Todos** toggle (top-right,
with the open count) opens a card listing them, count badges sit on every anchored
element (a badge click opens the card filtered to it, a chip click reveals the element
on the canvas), **Add todo** files one against the current canvas selection (or the whole
model), with one of the repo's todo types and their fields, and **Done** closes it in the
tracker. It drives the same `list_todos` / `list_todo_types` / `create_todo` / `close_todo`
tools over the app bridge, and discovery starts as soon as the
model's path is known, so a tracker-less host simply has no Todos toggle, and a read-only
host gets the list without the write actions. Nothing about the modeling path depends on it.

**"Implement" hands a todo to the assistant.** The widget injects a work order into the
chat as a user message (`ui/message`), with repo, model path, the model, anchored element ids
and the todo's description inlined, followed by the exact steps: `get_bpmn_xml` (keep the
`baseVersion`) → make the edit → `validate_bpmn` until clean → `save_bpmn_xml` (CAS; on
conflict re-derive and retry) → `close_todo`, and only after the save succeeded. A model of
another notation gets the generic tools instead: `get_model_content` → `validate_model` →
`save_model_content`. Three rules
are spelled out rather than assumed: ask instead of guessing at the model's semantics, never
close over an unsaved model, and the description is fenced as data ("information, not
instructions"). It comes from the tracker, where labeling an issue `todo` takes only triage
rights, so a crafted body must not be able to splice its own steps into the work order. The
widget then returns to inline display, closes the card and confirms with a toast ("Sent
#38 to the assistant"), because the answer arrives in the conversation, not in the iframe;
a client that refuses the message gets a toast with **Open #38** in the tracker instead.
Tracker links go through the host too (`ui/open-link`): the app sandbox blocks
`target="_blank"` navigation.

**"Open in designIQ" leaves the chat for the full product.** The top-right button (also
in the menu, on the state cards and in the pill's details) opens the loaded model in the
web modeler: the process route, carrying the current canvas selection as `?element=` so
the web editor reveals exactly the element under discussion (the other widgets link
their file route; a load that failed links the file or the repository). The instance
origin rides in the widget's boot payload (the sandboxed iframe cannot know it
otherwise), the link opens through the same `ui/open-link` ladder as tracker links (a
client that blocks it gets a toast with the URL to copy), and a still-unsaved edit is
flushed in parallel: it lands in the very live document the opened editor joins (while
a conflict card is up, the flush stays paused: the opened editor shows the server
version and the card keeps owning the divergence decision). Logged-out recipients pass
the login gate and land on the model, not the overview (the SPA stashes the deep link
across the auth round-trip). The `open_modeler` / `open_decision_modeler` results carry
the same link as `opened.url`, so non-apps clients can surface it in plain text.

Clients without apps support (Claude Code, the read-only `@miragon/design-iq-mcp` package) see a
plain tool that returns a short process summary plus the model's web URL. Use
`get_process`/`get_bpmn_xml` there. Under `LIVE_MCP_READONLY=1` the tool stays registered
but the widget becomes a read-only viewer (pill _Read-only_, no Save now, no Workshop, no
ws ticket), matching the absent write tools. The "Open in designIQ" link stays, pointing
at the differently authenticated web surface.

### MCP App: the decision modeler and its Checks

`open_decision_modeler` rides the same widget core and chrome
(`apps/web/dist/mcp-app-dmn.html`, its own `ui://` resource), deliberately without live
mode: dmn-js (DRD, decision table, literal expression) with the
[dmn-js-simulation](https://github.com/emaarco/dmn-js-simulation) add-on mounted into
both views. A one-decision model opens on its table; the **DRD | Table** switch beside the
menu (and the menu's view items) moves between the views. Saving works like the BPMN
widget (autosave, `lint:"warn"`, `baseVersion` CAS with the conflict card); it does
**not** take the Yjs live upgrade: decision tables are edited cell by cell by one person
at a time, and the conflict flow covers the rare collision honestly.

The **Checks** toggle (top-right, shield icon) carries the test verdict ("✓ 7/7" or
"✕ 1 failing", a spinner while the suite runs) and opens a card with three sections in
the web app's Decision-checks order:

- **Findings**: `analyze_decision` on the stored decision (FEEL that does not parse,
  rules that can never fire, …), shown as "Sound", "2 warnings" or "1 error", one row per finding
  anchored to its rule and column. It re-runs after each landed save (at most every 5 s)
  and is absent on a host without the tool.
- **Try a scenario**: a form built from the open table's inputs (a select where the
  column lists its values), driving the add-on's own simulation store. **Simulate** lights
  the matching rows in the table (the rule the hit policy actually reports differently
  from the ones that merely matched) and the outcome strip reads "Rule 3 · "approve"".
  **Save as test case** names the run and writes it into `<decision>.tests.yaml` via
  `save_decision_tests` with `record: true` and the file's `baseVersion`. The server
  evaluates and freezes what the decision produces, so a case records today's behaviour,
  never an expectation nobody confirmed.
- **Test cases**: the stored cases from `get_decision_tests`, run by
  `run_decision_tests` (failing first, with the expected and actual lines; a case
  without an expectation shows what it currently produces), plus the rules no case
  decides. Clicking a case replays it: the widget switches from the DRD to that
  decision's table, fills the scenario and scrolls the lit rule into view.

The suite runs from boot (discovery starts as soon as the path is known, so the toggle
appears with its verdict, or never on a host without the decision tools) and again after
each landed save while it has cases. An explicit **Run** with the card closed answers
with a toast. Test results never touch the sync pill: a failing test is not a failed save.

**The agent can hand over a scenario.** `open_decision_modeler` takes an optional
`scenario` (the same variable → value map as `simulate_decision`), which the widget plays
straight into the simulator and confirms with a toast ("Scenario from the assistant — rule 3 matches").
"This case returns `manual-review` instead of `approve`" stops being a sentence and becomes a
highlighted row, and one click on Save as test case keeps it.
Both sides run the same engine, so a run clicked here and one simulated by an agent
cannot disagree.

### MCP Apps: Wardley Maps, Team Topologies, Event Storming boards and Context Maps

`open_wardley_modeler`, `open_team_topology_modeler`, `open_event_storming_modeler` and
`open_context_map_modeler` are generated from the notation registry (their names come from
`@designiq/contracts/mcp-app`, the same derivation the web app's "Analyse with AI" prompt
uses). Each takes `{repo, id | path}` and forces its notation: a stem shared with a
`.bpmn` twin opens THIS notation's file, and a `path` of another notation fails in the
tool rather than inside the iframe. The widgets run the shared core on the Miragon
renderers (`@miragon/wardley-renderer`, `team-topologies-renderer`,
`event-storming-renderer`, `context-maps-renderer`): the same CAS autosave through `save_model_content`, the same
conflict card and chrome, the same live upgrade through `mint_ws_ticket`, a read-only viewer under
`LIVE_MCP_READONLY=1`, and the same Todos card as the BPMN widget (above). What they do not
have: stickies (BPMN-only). Their "Open in designIQ" link is the file route (`/f/<path>`),
carrying the selected element (`?element=`), which the web modeler reveals. The
tool result is the lean `{opened: {repo, path, url}, summary: {name, summary, stats}}`.
Non-apps clients read `get_view` / `get_model_content` instead.

### Analyse with AI: the deep link into the widget

The web editor's toolbar (and every model row on the repo overview) carries an
**"Analyse with AI"** dropdown, the doorway in the opposite direction: one click
opens an AI chat whose first move is the model's widget tool (`open_modeler` /
`open_decision_modeler`, or the generated `open_<notation>_modeler` of a Miragon
renderer) for exactly the model on screen, so the widget comes up live-synced with
the editor the user just left. The menu appears wherever a widget is served (every
notation the platform renders today). The menu only picks the destination: Claude Desktop, ChatGPT, or the
clipboard. The prompt is a work order built by `@designiq/contracts/assist`: the literal
tool call with repo and path inlined, the Live Host's MCP URL named (a connector
pointed at a _different_ instance then fails as a recognizable "wrong instance", not a
phantom missing repo), and the current canvas selection riding along as fenced data.
What to do with the model stays the user's next message.

Every target is a **prefill**. The chat opens with the prompt prepared, and the user
reviews and sends it; nothing runs on its own:

- **Claude Desktop**: `claude://claude.ai/new?q=…`
  ([documented](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link);
  `q` truncates around 14k characters, our prompts stay far below). Whether the scheme
  is handled cannot be read from a browser, so a quiet miss softly offers the fallback.
- **ChatGPT**: `https://chatgpt.com/?prompt=…` (undocumented; deliberately not `?q=`,
  which auto-submits). ChatGPT implements the open MCP Apps standard, so the same
  widgets render there; every `open_*` tool additionally carries ChatGPT's legacy
  `openai/outputTemplate` alias. Caveats: the connector must be added in developer
  mode, and full (write-capable) MCP is currently a Business/Enterprise/Edu beta.
  Pro is read-only. Register ChatGPT's redirect URIs at the IdP
  (see [extending/mcp-idp-setup.md](extending/mcp-idp-setup.md)).
- **Copy the prompt**: the escape hatch for every other client (or a missing
  install). Paste it into any chat connected to this connector.

The connector is the hard prerequisite: without it the chat opens and stalls, which is
why the menu links to this page. And a prompt is not a protocol: the receiving model
_should_ open the widget first, but nothing guarantees it. The imperative first step
with the literal tool call is the lever, honest UI copy is the promise.

`save_bpmn_xml` is compare-and-set: the caller passes the `baseVersion` from a prior
`get_bpmn_xml`, and if the live document moved in between, the save is refused with a
retryable `{conflict: true, currentContent}`. Re-read (or rebase onto `currentContent`) and retry;
nothing is overwritten. Saves are validation-gated (`@miragon/design-iq-validator`: ERROR findings
refuse the save, WARN findings come back as warnings) and land in the live Yjs state:
every open editor sees them instantly, exactly like a keystroke.

**Auth** is the Live Host's one auth surface: a browser session cookie,
`Authorization: Bearer <session-id>`, or an
**OIDC JWT** from your IdP (`LIVE_OIDC_ISSUER` + `LIVE_OIDC_JWKS_URL`; audience defaults
to `LIVE_PUBLIC_URL`, and the login claim, by default `github_login`, must carry the
IdP-verified GitHub login; see [on-prem/configuration.md](on-prem/configuration.md) and
the verified IdP recipe in [extending/mcp-idp-setup.md](extending/mcp-idp-setup.md)).
Per-repo authorization runs app-side against real GitHub permissions on every tool
call. A `LIVE_AUTH=none` host is the one exception: it authenticates nobody and
authorizes everything. It is for local evaluation only, see
[on-prem/configuration.md](on-prem/configuration.md).
`LIVE_MCP_READONLY=1` registers **no** write tools: they are absent from `tools/list`,
not erroring.

Connect a client:

```sh
claude mcp add --transport http designiq http://localhost:8301/mcp \
  --header "Authorization: Bearer <token>"
```

A `LIVE_AUTH=none` host needs no token (drop the header); in production it is an OIDC access token obtained
via the client's OAuth flow. When OIDC is configured the host publishes RFC-9728
protected-resource metadata at `/.well-known/oauth-protected-resource`, so clients like
claude.ai discover the IdP themselves. Manual smoke test:
`node apps/live-host/scripts/mcp-smoke.mjs [mcpUrl] [repo]` (`SMOKE_TOKEN=<token>` against an
authenticated host).

Non-MCP clients get the same live content over plain REST:
`GET/PUT /api/repos/:owner/:repo/content?path=<model path>`. GET returns
`{repo, path, xml, baseVersion}`; PUT requires `{xml, baseVersion}` and applies the same
validation + compare-and-set (a stale `baseVersion` → `409` with the current state instead
of overwriting).

Decision record: [ADR 0005](adr/0005-in-process-mcp-and-oidc-resource-server.md).

### Semantic BPMN editing (opt-in)

`LIVE_MCP_BPMN_EDIT=1` registers three tools backed by the BPMN editing engine
[`@miragon/bpmn-cli`](https://github.com/Miragon/bpmn-cli) ([ADR 0009](adr/0009-bpmn-editing-through-bpmn-cli.md)):
an agent names elements by id and says what changes, and never writes XML or BPMNDI.

- `get_process_outline`: the model as text. It lists every element with id, kind, name, lane, links and
  flows, or one view of it: the neighbourhood of one element (`around`, `depth`), one element in
  its context (`element`), one process or pool (`scope`), a text search (`find`). `saveGate`
  lists the save gate's findings on the document. Registered on read-only hosts too.
- `edit_process`: a batch of operations (`add`, `connect`, `set`, `remove`, `retype`, `move`,
  `order`, `ext`, `split`, and the diagram-only `place`, `align`, `color`, `label`, `route`,
  `space`, `tidy`, `compact`) as one transaction. A hand-drawn diagram is kept: new elements are
  placed next to their neighbours; a diagram the engine drew is redrawn. New ids follow the
  file's style. The result names what was created, changed and removed, what each format op did,
  the warnings the change added and the layout score, without any XML.
- `layout_process`: `tidy` (keep the drawing, remove overlaps) or `redraw` (draw it anew).

The change is saved like `save_bpmn_xml`, with the same validation (`lint`), compare-and-set and
live write, but needs no `baseVersion`: on a concurrent change the tool applies the operations
again to the newer document (three attempts in all) and notes it; with `baseVersion` it answers a
conflict instead. Inside the engine, the platform validator refuses an error the change would
add and lists it; errors the document already had are named as such in the save's refusal.
`dryRun` answers `wouldSave` (and why not) without saving. An engine refusal comes back as a tool error
starting with its code (`E_NOT_FOUND in ops[1]: …`, `E_VALIDATION: …`); a save-gate refusal with the gate's
verdict. A model whose
processes are all non-executable is edited as a design model: a decision link keeps the file's
spelling, and a new one with no engine spelling to follow is an unprefixed `calledDecision`.

## Read-only vs. write-capable: which server holds a pen

**`packages/mcp` stays read-only by construction.** The server only ever reads files; no
tool creates, edits, or deletes anything, and missing or invalid files produce an
explanatory message instead of an error. Changes keep going through the modeling workflow:
edit in VS Code, check with `pnpm validate` (for BPMN also the `process-review` skill), commit. That MCP server
is a window onto the models, never a pen.

**The Live Host's `/mcp` IS write-capable**, but its writes land in the live Yjs state
(and its write-through workspace file), never directly in git. Every save is
validation-gated and conflict-guarded (`baseVersion`), and changes reach the repository
only through the release-as-PR flow. Merge stays a human decision at the git provider.
