# designIQ — agent guide

**designIQ** is collaborative modeling and architecture with AI: a Git-native workspace where
teams model processes (BPMN), decisions (DMN), Wardley Maps, Team Topologies, Event Storming
boards, Context Maps, Value Chains and Markdown together, live. Every model is a file in a
content repo, a release is a pull request, and AI clients read, check and edit the same live
models through MCP. It is a **pnpm monorepo**. For any question about a model, the
model files are the source of truth (here: the example content under `process-documentation/`)
— **ground every answer in the models.**

## Notations

Registered in `packages/notations/index.ts` (id = the `notation` argument of the generic tools):

| Notation       | id               | Extensions         |
| -------------- | ---------------- | ------------------ |
| BPMN 2.0       | `bpmn`           | `.bpmn`            |
| DMN            | `dmn`            | `.dmn`             |
| Wardley Map    | `wardley`        | `.owm`, `.wmap`    |
| Team Topology  | `team-topology`  | `.tt`, `.ttm.json` |
| Event Storming | `event-storming` | `.storm`           |
| Context Map    | `context-map`    | `.cm.json`         |
| Value Chain    | `value-chain`    | `.vc.json`         |
| Markdown       | `markdown`       | `.md`              |

Every notation gets live sync, the generic MCP model tools, validation and release-as-PR.
BPMN and DMN have the deepest tooling (derived process and decision views, decision
simulation and tests, todos anchored to BPMN elements) and the BPMN/DMN hard rules below.

## Map (pnpm workspace)

| Path                                    | What it is                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/live-host/`                       | The platform server (`@designiq/live-host`): Hocuspocus sync + REST API + web app on one port, plus `/mcp` (official MCP SDK) + REST content routes for AI clients (OIDC-JWT auth). Multi-repo, per-(user,repo) authz, release-as-PR. Cell mode: env-gated, see ADR 0002/0004; leave unset when self-hosting.                                                |
| `apps/web/`                             | The collaborative web client (`@designiq/web`): visual modelers (bpmn-js, dmn-js, the Miragon renderers) + Monaco on a shared Y.Text, repo overview, the MCP-App widgets. The DMN editor carries the simulation add-on + a Checks panel (`@designiq/decisions`, in-browser).                                                                                 |
| `apps/vscode/`                          | VS Code extension (`design-iq`, id `miragon-gmbh.design-iq`): open `designiq://` model docs synced through the Live Host; editor sign-in via the host's login routes.                                                                                                                                                                                        |
| `packages/mcp/`                         | Read-only MCP server (`@miragon/design-iq-mcp`, bin `designiq-mcp-server`) exposing a content repo's models of every notation (discovered from `designiq.yml`; process views derived from BPMN) to any MCP client — read-only, against a checkout; the live, writable MCP endpoint lives in `apps/live-host`.                                                |
| `packages/notations/`                   | Notation registry (`@designiq/notations`): one descriptor per notation (extensions, media kind, editor language). Adding a notation to the platform starts here — live-host, validator and web derive from it.                                                                                                                                               |
| `packages/decisions/`                   | DMN simulation, analysis and test running (`@designiq/decisions`) — **isomorphic**: the same module answers in Node (live-host `/mcp`, the `cli.ts` gate) and in the browser (the SPA's DMN Checks panel, the MCP-App widget). Owns `<decision>.tests.yaml`. Only `cli.ts` is Node-bound (`pnpm arch` enforces it).                                          |
| `packages/http-kit/`                    | Shared node:http primitives + `AppError`/`errorBody` for backend services (`@designiq/http-kit`, zero-dep). ADR 0003.                                                                                                                                                                                                                                        |
| `packages/github-app/`                  | GitHub App plumbing (`@designiq/github-app`, zero-dep): appJwt/loadPrivateKey + appRest/mint/paginate — User-Agent per app.                                                                                                                                                                                                                                  |
| `packages/contracts/`                   | Backend↔frontend wire types + the live-doc contract (`@designiq/contracts`: `CONTENT_KEY`, `roomName()`). Backends pin responses with `satisfies`; frontends re-export. Drift = tsc error.                                                                                                                                                                   |
| `packages/ui-kit/`                      | Shared shadcn primitives + `cn()` + the Miragon CI theme for the SPAs and widgets (`@designiq/ui-kit`): vendored `cd-tokens.generated.css` (never edit), aliases `tokens.css` + TS mirror `lib/tokens.ts` (drift/contrast test), Geist `fonts.css`, Tailwind mapping `theme.css`. Run the shadcn CLI HERE, not in the apps.                                  |
| `packages/api-client/`                  | `ApiError` + `api<T>()` + TanStack Query defaults for the SPAs (`@designiq/api-client`).                                                                                                                                                                                                                                                                     |
| `packages/live-client/`                 | The ONE live-session implementation (`@designiq/live-client`): `openLiveSession()`, minimal-diff Y.Text writer, the canvas sync bridges (bpmn-sync, dmn-sync, miragon-sync). Consumers: web, vscode, guest-test, live-host (the minimal-diff writer via `@designiq/live-client/text`) — nothing else.                                                        |
| `packages/validator/`                   | Platform validator (`@miragon/design-iq-validator`, bin `designiq-validate`): designiq.yml discovery (legacy bpmiq.yml still read) + BPMN/DMN structure, BPMNDI+DMNDI coverage, cross-model reference integrity (callActivity, decisions), a parse check for every other notation. Runs against any checkout via `--root`; never executes content-repo code. |
| `process-documentation/`                | Example content repo (`designiq.yml` + BPMN/DMN example models and an Event Storming board + the AI skills in `.claude/skills`) — the MCP/validator example AND the content-repo contract mirrored to `Miragon/process-documentation-starter`. The Live Host serves any repo with a root `designiq.yml` (legacy `bpmiq.yml` still read), nothing else.       |
| `docs/`                                 | Platform docs: `platform-concept.md`, `multi-repo-architecture.md`, `mcp-integration.md`, `on-prem/` (self-hosting), `extending/` (connectors, SSO), `adr/`, `upgrading-to-5.md` (the rename release).                                                                                                                                                       |
| `process-documentation/.claude/skills/` | The AI-first toolset (travels with the content repo).                                                                                                                                                                                                                                                                                                        |

### Inside `process-documentation/` (the example content repo)

The slim content contract: a root `designiq.yml` (legacy `bpmiq.yml` still read) names
the models folder (`models:`, legacy alias `processes:`); a model IS a file with a
registered notation extension there (id = file stem) — a process its `.bpmn`, a decision
its `.dmn`. There is NO `process.yaml`, landscape, glossary or portal — the process view
(name, roles from lanes, steps, flow, sub-process calls, decisions) and the decision view
(hit policy, columns, rules, DRD) are DERIVED from the models (`@designiq/notations/derive`).

| Path                     | What it is                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `designiq.yml`           | The contract: `models: processes` — names the model folder (legacy alias `processes:`) |
| `processes/*.bpmn`       | One process per file; `subprocesses/*.bpmn` linked via callActivity                    |
| `processes/*.dmn`        | One decision per file; called from a `businessRuleTask` via `calledDecision`           |
| `processes/*.tests.yaml` | The decision's test cases, next to it (`pnpm validate` runs them)                      |
| `processes/*.storm`      | An Event Storming board (`order-to-cash.storm`)                                        |
| `.claude/skills/`        | The AI toolset (below)                                                                 |

## Skills — prefer them over ad-hoc approaches

The example content repo's skills are BPMN process skills:

- **process-navigator** — any question about existing processes (flow, roles, calls, impact)
- **capture-process** — interview a process owner to elicit a process from tacit knowledge
- **import-process** — turn legacy docs (Visio/Word/Confluence/images) into a draft `.bpmn`
- **new-process** — scaffold a new process `.bpmn` (complete BPMNDI, lanes, callActivity links)
- **process-review** — quality gate: runs the validator, then judgment checks
- **process-feedback** — file and triage discrepancy reports (`feedback/<id>/`)
- **export-process-skill** — package a process (`.bpmn` + derived view) as a portable skill

Skills live in `process-documentation/.claude/skills/` and operate on content there —
they travel with the content repo (mirrored to `Miragon/process-documentation-starter`).

## Backend architecture (ADR 0003)

The backend is hexagonal: `domain/` (pure) · `ports/` (contracts) · `application/`
(use-cases; adapter impls only injected, never imported) · `adapters/<vendor>/` (github, git,
sqlite) · `http/` (router) · `server.ts` (the ONLY place reading env/constructing
adapters). A new connector (GitLab, Jira, …) = a new `adapters/<vendor>/` folder against the
existing ports. Boundaries are CI-enforced: `pnpm arch` (dependency-cruiser) — the PR that
moves a module deletes its grandfather exception in `.dependency-cruiser.mjs`.

## Design system (mandatory)

All UI work follows the Miragon product design system. The source of truth is the skill
`miragon-brand:modeler-tool-design` in Miragon/corporate-identity — it loads for UI work when
the plugin is installed; without it, read the guide:
https://raw.githubusercontent.com/Miragon/corporate-identity/main/plugins/miragon-brand/skills/modeler-tool-design/assets/modeler-design-system.md

- **Tokens are vendored, never forked:** `packages/ui-kit/src/cd-tokens.generated.css` —
  never edit it, re-copy it from the skill to update. App aliases (`--primary`, `--link`,
  `--border`, `--canvas-*` …) live in `packages/ui-kit/src/tokens.css`, mirrored in
  `lib/tokens.ts` for code that needs a real colour value (Monaco, renderer defaults, SVG
  attributes); `pnpm --filter @designiq/ui-kit test` fails on drift and on contrast below
  4.5:1 (text) / 3:1 (non-text). No hex in components — a new colour is an alias in BOTH files.
- **ONE light mode** — no dark theme, no scheme switch. Blue leads (buttons, focus,
  selection; interactive text is `--link`); green (`--brand`) is a fill or indicator, never
  text on white. Radius, shadows and motion come from the tokens (`theme.css`; md 12px).
- **Geist / Geist Mono** everywhere, canvas text included; **Lucide** is the only icon set
  (no emoji or unicode glyphs as icons, no sparkles/wand/robot for AI).
- The Miragon renderers (`@miragon/*-renderer`) bring their own CI styling — don't restyle
  them. The Live Host's own HTML pages (editor sign-in landing, `create-app`) cannot load
  the SPA sheet: they share the inline CI shell in `apps/live-host/src/http/brand-page.ts`.
- **brand-lint** (the miragon-brand PostToolUse hook, active via `.miragon/brand.json`) flags
  colours outside the CI palette in every edit — in CSS also a raw brand hex instead of its
  `--cd-*` token, and gradient text. It does NOT check fonts, icons, emoji or the AI look:
  those are review items (`miragon-brand:brand-review`). Its German copy rules are off: UI
  copy stays English.

## Hard rules

1. A content repo is a root `designiq.yml` (legacy `bpmiq.yml` still read) naming its
   models folder (`models:`, legacy alias `processes:`); a model is a file with a
   registered notation extension there (id = file stem) — a process its `.bpmn`. After
   ANY model edit, run `pnpm validate` (or
   `node packages/validator/src/cli.ts --root <checkout>`) and fix errors first.
2. **BPMN:** files need a complete BPMNDI section (every flow node, lane, pool, edge), or the
   visual editor breaks. Keep semantics (`bpmn:*`) and layout (`bpmndi:*`) in sync.
3. **BPMN:** modeling conventions — tasks verb+object, events object+past participle, gateways as
   questions, lanes = team/role labels.
4. **BPMN:** a sub-process is a separate `.bpmn`; link it via `callActivity calledElement="<sub-id>"`
   (the sub-process's file stem). The validator warns on a dangling call.
5. **DMN:** a decision is a `.dmn` file in the same folder (id = file stem), linked from a
   `businessRuleTask` via `calledDecision`/`decisionRef` = that stem. Its test cases live
   next to it in `<stem>.tests.yaml` — after ANY decision edit, `pnpm validate` runs them.
   Never author an expected VALUE the business has not confirmed; record today's behaviour
   instead (`save_decision_tests` with `record`) so the next change becomes visible.
6. **BPMN:** when the user corrects a process ("that's not how we do it"), don't silently edit — file
   it via the `process-feedback` skill and triage.
7. This is a **pnpm** workspace: `pnpm install`, `pnpm --filter <pkg> …`. Never `npm`/`yarn`.
