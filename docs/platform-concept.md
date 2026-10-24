# Platform Concept: Live Collaboration for the BPM Landscape

> **Note (2026-10):** written when the product was a BPM platform; the architecture still
> applies — see the [README](../README.md) for the current positioning.

> Status: concept (2026-07-07), **revision 2 — Hocuspocus pivot**. Scope of v1: BPMN diagrams
>
> - `process.yaml` + Markdown docs. Everything TypeScript. Builds on what exists: the repo as
>   system of record, `validate.ts`, the portal, and the MCP server.
>
> **Revision 3 (2026-07-15):** the implemented client stack is React 19 + Vite + TanStack
> Router/Query + Tailwind v4 + shadcn (shared via `@designiq/ui-kit`/`@designiq/api-client`);
> the live-session wiring and the BPMN sync rules below live in `@designiq/live-client`;
> backend/module structure is hexagonal per
> [ADR 0003](adr/0003-module-architecture-and-shared-packages.md). The 4 sync rules in this
> document remain the authoritative design; code references to `apps/web/src/sync.ts` now
> mean `packages/live-client/src/bpmn-sync.ts`.

## Revision 2 (2026-07-07): Hocuspocus instead of OCT

An external tool evaluation recommended [Hocuspocus](https://tiptap.dev/docs/hocuspocus) over
OCT, and the M0 spike confirmed it empirically (`apps/live-host/README.md`): with OCT, the always-on
Live Host must be built as a headless _session host_ against OCT's ephemeral, E2E-encrypted
session semantics (session dies with the host, unstable room ids, seed races — all observed
in the spike); with Hocuspocus **the server is the host**: persistent room-per-document,
`onAuthenticate` (WorkOS/GitHub JWT) and `onStoreDocument` (persistence/git) are native hooks,
and the web app uses the standard Yjs provider. Round trip measured 12 ms vs. 27 ms, first-guest
sync 0 ms vs. 10 s. E2E encryption lost nothing — our own server read everything by design.

What changes against the text below: components **1 (relay) and 2 (Live Host) merge into one
Hocuspocus-based service**; rooms are per model file (matching per-process releases), not one
workspace session; the VS Code side is a **thin own extension** (`designiq://`
FileSystemProvider bound to Y.Text, ~150 lines — skeleton in `apps/vscode/`) instead of the
OCT plugin. Everything else — release flow, GitHub-based authorization, BPMN text-sync rules,
deployment shape, milestones — carries over unchanged. OCT stays the right choice if
developers should live-share _arbitrary_ files in VS Code; that need can be revisited without
touching this architecture. The OCT-specific sections below are kept as evaluated context.

## Vision

Today the repo is the workspace. The platform inverts that for modelers:

- **The Live Host holds the current working state.** Everyone who models — from VS Code via
  the OCT plugin or from the web app — connects to the same live session and always sees the
  latest state. Nothing is "checked out"; there is exactly one live version.
- **Git holds the released state.** A release turns the live state of _one process_ into a
  GitHub PR. Review + merge = approval (CODEOWNERS, as governed today). The pipeline
  validates, deploys portal + MCP, and tells the Live Host to rebase onto the new `main`.
- **The portal stays the read surface** for everyone else: always the last _released_ state.

```
                 ┌─────────────────────── modelers ───────────────────────┐
                 │                                                        │
        VS Code + OCT plugin                                     Web app (browser)
        (Miragon BPMN Modeler)                            bpmn-js canvas + Monaco (yaml/md)
                 │  E2E-encrypted Yjs sync (Socket.IO)             │
                 └────────────────┬───────────────────────────────┘
                                  ▼
                        ┌──────────────────┐        creates rooms, owns workspace,
                        │    OCT relay     │◄──────  serves files, persists Y.Docs
                        │  (self-hosted,   │        ┌────────────────────┐
                        │   stateless)     │───────►│     LIVE HOST      │
                        └──────────────────┘        │  headless OCT host │
                                                    │  git checkout+live │
                                                    └───┬──────────▲─────┘
                                     "release process X"│          │ rebase on merge
                                                        ▼          │ (webhook)
                                                 ┌─────────────────┴──┐
                                                 │       GitHub       │
                                                 │  PR → review → CI  │
                                                 │  (validate.ts)     │
                                                 └─────────┬──────────┘
                                                           │ deploy on merge
                                                           ▼
                                            ┌────────────────────────────┐
                                            │  Portal + MCP (fly.io)     │
                                            │  released state, read-only │
                                            └────────────────────────────┘
```

## What OCT gives us — and what it deliberately doesn't

Findings verified against the OCT source (`eclipse-oct/open-collaboration-tools`, all MIT,
all packages 0.3.x):

| OCT provides                                                                                                                                            | OCT does _not_ provide                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Relay server (self-hostable Docker image, port 8100, Socket.IO): auth (GitHub OAuth, API key, simple login), room registry, message routing             | **Any persistence** — rooms live in memory, content is E2E-encrypted (server cannot read it)          |
| Protocol + Yjs packages, isomorphic (Node + browser): `ConnectionProvider`, `createRoom/joinRoom`, `fs.*` file protocol, `OpenCollaborationYjsProvider` | **Sessions that survive the host** — host disconnect closes the room (30 s reconnect grace)           |
| VS Code extension (`typefox.open-collaboration-tools`): share/join, guests see the host workspace as a virtual `oct://` filesystem                      | **Sync for webview/custom editors** — only text documents are CRDT-synced                             |
| Monaco binding (`open-collaboration-monaco`) for web text editing                                                                                       | A multi-file web workspace client (binding is one editor/doc; the raw connection is the escape hatch) |

Two consequences shape the whole architecture:

1. **The Live Host must be ours.** Because OCT persists nothing and sessions die with their
   host, the "always-on latest state" requires a headless host service that creates the room,
   owns the workspace, answers file requests, holds the Y.Docs, and writes them durably. This
   is a supported pattern: `open-collaboration-service-process` hosts rooms programmatically
   (it powers the IntelliJ integration), `open-collaboration-agent` shows headless Node
   bootstrapping. The bot authenticates via OCT API-key auth.
2. **Text is the sync substrate.** All shipped OCT clients sync text documents (Y.Text per
   file path). Our models are text (BPMN XML, YAML, Markdown, OWM) — which is exactly why the
   repo-as-text decision pays off again here.

## Components (all TypeScript)

### 1. OCT relay (`open-collaboration-server`, self-hosted)

Unmodified upstream, deployed from the official image. Config: GitHub OAuth
(`OCT_OAUTH_GITHUB_*`) for humans, API key for the Live Host bot, JWT key, CORS for the web
app origin. Stateless — loses nothing on restart except transient connections.

### 2. Live Host (today: `apps/live-host/`)

A Node service, the heart of the platform:

- **Workspace = git checkout of `main` + live overlay.** On boot: clone/fetch the content
  repo, then replay persisted Yjs updates on top. The OCT room's workspace is this directory.
- **OCT bot host**: `ConnectionProvider.createRoom()` → `connect(roomToken)` →
  `peer.onJoinRequest` (admission policy, see AuthZ) → answers `fs.onReadFile/onStat/...`
  from the workspace → `OpenCollaborationYjsProvider` binds one `Y.Doc` (Y.Text per open
  file). Every applied update is appended to a per-file update log
  (`.live/<path>.yupdates`) and periodically compacted into snapshots — restart-safe, and
  the session can be re-created at any time because _we_ are the host.
- **Room lifecycle**: one long-lived room for the workspace. If the process restarts, it
  re-creates the room and publishes the new invite via its API (`GET /session`) — clients
  re-join automatically. (OCT rooms cannot be pinned to a stable id; the indirection through
  our API hides that.)
- **Release API** (`POST /release/:processId`, called from web app or VS Code command):
  1. materialize the live state of `processes/<id>/**` (+ any changed `landscape/` files the
     release explicitly includes) into a branch `release/<id>-<date>`,
  2. run the platform validator (`packages/validator`) locally — a failing release never reaches GitHub,
  3. open a PR via the GitHub App, authored on behalf of the releasing user
     (user-to-server token), so review rights and CODEOWNERS apply to a real person,
  4. report PR URL back into the session (chat message + web app toast).
- **Rebase on merge** (`POST /webhook/github`, push events on `main`): fetch, rebase the live
  overlay onto the new `main`. Files without live changes: fast-forward. Files with live
  changes: three-way text merge; on conflict, mark the file in-session (conflict banner in
  web app; the file's Y.Text gets conflict markers like git) — modelers resolve live.
  _As built (#185): a per-file catch-up after every fetch instead — no text merge of model
  XML; a file changed on both sides keeps its live version and is flagged, the release
  refuses it until resolved (see `multi-repo-architecture.md`, C)._
- **Also serves**: presence/awareness relay is OCT's job, but the Live Host adds a tiny
  status API (who is connected, which files are dirty vs. `main`, open releases) that the web
  app renders.

### 3. Web app (today: `apps/web/`)

Vite + TypeScript SPA:

- **Join flow**: GitHub login on the OCT relay → join the room published by the Live Host.
- **Explorer**: file tree from the session (`fs.readDir`), grouped the way the portal groups
  content (processes, landscape), with dirty-vs-released markers from the Live Host API.
- **BPMN editing**: bpmn-js Modeler bound to the file's Y.Text — see sync design below.
- **YAML/Markdown editing**: Monaco bound per file (the `open-collaboration-monaco` package
  covers exactly this; multi-file needs the raw-connection escape hatch it exposes).
  _As built (#253): a Markdown model opens as the rendered document, live with every edit,
  with links between models opening inside the app and `mermaid` fences drawn as diagrams
  (#254); its Monaco source is one click away. Its repository images load from the Live
  Host; an image from another site loads only when the reader asks for it (#290)._
- **Presence**: OCT awareness → avatars per file, remote cursors in Monaco, remote-change
  highlighting on the BPMN canvas (color-flash per changed element via `bpmn-js-differ`).
- **Release button** per process → Live Host release API → shows PR link.
- **Read-only mode is the portal** (already live) — the web app links "released version"
  through to it rather than re-implementing a viewer.

### 4. VS Code

Two pieces, one of which exists:

- **OCT plugin** (`typefox.open-collaboration-tools`): join the Live Host's room; the
  workspace appears as `oct://` virtual filesystem; plain text files (yaml, md, owm) co-edit
  out of the box.
- **Miragon BPMN Modeler**: verified from its source — it is a `CustomTextEditorProvider`
  whose ground truth is the `TextDocument`; external document changes re-render the webview,
  and viewport/selection restore across re-imports is already implemented. That is the best
  possible starting position, with one caveat to validate in the spike (M0): OCT's sync
  binds _text documents_, so document edits made by the modeler propagate — but the modeler
  currently writes full-range `WorkspaceEdit`s, which would degrade Y.Text merges to
  replace-all. **Upstream fix in bpmn-modeler: write minimal diffs instead of full-range
  edits** (also improves plain undo/diff behavior, independent of this platform).

### 5. Portal, MCP, pipeline (existing — unchanged roles)

The deploy pipeline gains one step: after deploying portal + MCP, notify the Live Host
webhook. Optionally later: the MCP server gains `get_live_process` tools backed by the Live
Host, so agents can also talk about work-in-progress (clearly labeled as unreleased).

## Sync design for BPMN (v1)

Prior-art research is unambiguous: nobody has shipped operation-level CRDT-correct BPMN
co-editing in the open, and Camunda's Web Modeler retreated to canvas _locking_ in 8.9.
Text-level sync over Yjs is the pragmatic v1 — it is the only strategy that composes with
the VS Code custom text editor for free, and it is already ahead of public prior art. Four
rules make it sound (all grounded in verified bpmn-js/moddle behavior):

1. **Canonicalize at session start** (import→export through the session's pinned bpmn-js
   version) — moddle-xml serialization is deterministic per version, so after
   canonicalization, exports of unchanged elements are byte-stable and text diffs stay local
   to the actual edit. Pin one bpmn-js/moddle version across web app and VS Code webview.
2. **Minimal diffs into Y.Text, never replace-all** (diff-match-patch in one transaction) —
   replace-all destroys merge granularity and clobbers concurrent edits.
3. **Debounce remote re-imports** (~300–500 ms) with an import-suppression flag and
   string-equality guard (echo prevention via Yjs transaction origins). **Hold them back
   while a local gesture runs** (#295). A drag, resize, connection, lasso or palette create
   has committed nothing yet, so the quiet period after a local edit does not cover it, and
   an import replaces the shapes it works on: its drop would throw and lose the move. The
   binding reads the gesture from the DOM of the element the canvas is mounted in, the same
   way for every diagram-js editor: a pointer held on it, or diagram-js's `djs-drag-active`
   marker inside it while the drag carries elements, which a drag preview (`djs-dragger`)
   or diagram-js's grabbing cursor shows (a palette create follows the pointer with no
   button held, its preview gone while the pointer is off the canvas). The marker alone is
   no gesture: a palette tool that waits for its next press (hand, space, lasso, global
   connect) keeps it set, and is neither waited for nor cancelled. The import runs once the
   gesture ends, after the drop's own edit, which merges like any local edit (rule 2):
   where the drop and the held change are apart in the text, the canvas takes in both;
   where they touch, the drop gives way to the peer's change, with the conflict toast.
   Edits of different elements touch where bpmn-js writes a moved or new shape's DI last,
   and where a new element goes right after the one a peer moved (Wardley and Event
   Storming list it last). A gesture that outlasts 10 s gives way: it is cancelled the way
   Escape cancels it, then the import runs. Gates and repairs (rule 4) do not wait for a
   gesture. The notice of a text that stays unrenderable goes only once a text renders: a
   fix that arrives during a gesture lifts it when the held import runs.
4. **Validate merged XML before import** (cheap parse); on the rare interleaved-merge
   corruption, fall back to the last-good snapshot the Live Host keeps anyway.
   **Repair a merge that canvas writes alone broke** (#274). Two canvas exports that cross
   on the wire, each one large region (bpmn-js reorders lane refs and DI on export, so one
   move rewrites lines 11 to 176 of order-to-cash), merge into a text that keeps both
   replacements: one no peer can import (BPMN, DMN, the JSON notations), or one the Wardley
   and Event Storming parsers read garbled, every element twice. Every canvas keeps its own
   last good state, and no later update heals that. Each canvas write therefore records
   itself in a shared Y.Map next to the text (`CANVAS_WRITES_KEY`, same transaction): its
   count, a Lamport time, the writes its canvas held, its Yjs clock range and how many
   characters it deleted. A write takes out the entries its canvas holds, so the map keeps
   the writes nobody has built on (the open writes), and what it held stays named in its
   entry.
   - A peer counts a remote transaction as canvas writes only if each client that advanced
     its clock in it did so by exactly the range its entry declares, and the text lost no
     more characters than those writes deleted. Typing in the source view, an agent's or the
     Live Host's save (`updateText`) and a restore write no entry; a re-sync that bundles one
     of them with a canvas write counts as theirs.
   - A received canvas write that deleted characters a concurrent canvas write had already
     deleted marks the merge as two replacements of the same text, whether or not the
     parser reads it.
   - When the text fails the gate or the import, or merged two replacements, nothing but
     canvas writes changed it since the canvas last matched it, and two or more writes are
     open, all peers rank the open writes the same way: the latest first (Lamport time: the
     canvas that took in the longest chain of writes, its own included), then the one whose
     canvas held more writes, then the lowest Yjs client id. Only the first one's writer
     acts: after a 500 ms settle delay, and only if the text, the map, the rank and the
     count of other changes are as they were, it writes its canvas export over the text. A
     first-ranked writer that cannot (its canvas has not taken in someone's typing or save)
     marks its entry as standing down, and the next one acts. So does the next one when the
     first-ranked writer's awareness disappears (its tab closed, its connection lost, #296):
     every peer passes over a writer that left, as if it had stood down. A writer counts as
     back once its link re-syncs (the session takes in the room's presence and renews its
     own, so both sides see each other again at once, not at the next 15 s renewal) or once
     a canvas write of it arrives.
   - The repair names every writer whose write the text holds and its canvas does not, in
     a second map (`CANVAS_LOSSES_KEY`). Each of them shows the conflict toast once per lost
     write, also when the notice reaches it only on reconnect, and clears the notice; the
     repairer keeps its edit. A canvas that could import a merge of two replacements keeps
     its own state for up to 3 s, waiting for the repair, before it takes the merge in.
   - Typing, saves and restores are never written over: half-typed text is a legitimate
     state, and a save was confirmed to its author, who has no toast to learn of its loss.
   - A text that fails the gate or the import for 5 s while a canvas shows its last good
     state (a repair lands about 2 s after the break) is reported to that canvas. The SPA
     shows a persistent warning, "The shared text cannot be rendered. Your canvas shows the
     last good state.", with a Show source action, while the canvas is on screen without
     the source. The MCP-App widget, which has no text view, shows it as a warning toast
     with Open in designIQ and in the sync popover's activity line. Both go once a text
     renders. A document that never rendered (a newcomer, a reload during the break) gets
     the first import's report instead, BPMN included: the SPA's import-failed toast and
     the switch to the source, the widget's "Live import failed".

   What it does not guarantee:
   - One repair per state of the map, not per broken text: a writer whose updates reach the
     others more than about 1.5 s late (the 600 ms quiet period, the 350 ms import debounce
     and the settle delay) can repair the merge as it sees it while another writer repairs
     the merge they see. The two repairs cross, a second round settles them, and a writer
     whose edit both overwrote is told once.
   - A break that coincides with typing or a save stays as it is, as before this rule, and
     so does a merge of crossing writes that replaced nothing in common, whatever the
     parser makes of it. While such a text does not render, the canvas peers see the
     notice above.
   - A writer whose own connection drops sees every other writer leave (the provider
     clears the remote awareness states). It repairs on its side if it ranks first then,
     and its repair reaches the room on reconnect, where it settles with the one the
     others made like a lagging writer's: both writers can be told.
   - A connection lost without a close reaches the others only when the Live Host or the
     awareness timeout (about 30 s) removes the writer; until then the notice shows. The Live
     Host removes a writer as soon as the writer's connection closes, also after the link has
     dropped and come back: it ties a client's presence to the connection it last came on
     (#310).
   - A peer whose own link dropped takes a writer who left meanwhile as present again when
     that writer's last canvas write reaches it only on its own reconnect; for that break
     it waits for the writer that left, as before this rule, and shows the notice.
   - A re-sync that bundles canvas writes with a deletion typed in the source view counts
     as canvas writes when the deletion only removes characters those writes inserted (a
     deletion has no clock range of its own). One that bundles a canvas write with a later
     merge that edited what the first one inserted reads as two replacements, and one of
     the two edits is replaced, with the toast.
   - An entry names the 64 most recent other writers: after more than 64 writers wrote
     since the repairer's canvas last matched the text, an older writer's lost edit can go
     without a toast.

Accepted v1 costs (the honest trade-offs): local undo history resets when remote changes
arrive (diagram-js clears the command stack on re-import), and remote keystrokes on
properties cost a full export/re-import round trip on peers. Both are fine at 2–5 concurrent
modelers per file. UX mitigations: per-element remote-change highlighting, and an optional
**soft element-lock** via awareness ("Dominik is editing this task") — advisory, not
enforced. v2 option if scale demands it: operation-level sync via `commandStack` events into
a Y.Map model — the building blocks exist, the engineering is substantial, and it can be
added behind the same Y.Doc without changing the platform architecture.

## AuthN / AuthZ

> **Status update (2026-07-08): implemented.** GitHub login with a repo-permission gate
> (write access = entry ticket), server-side sessions, releases pushed and PR'd as the
> logged-in user. Onboarding via the **GitHub App manifest flow**: `/setup` creates the app
> through GitHub's UI in one click, credentials return automatically, provider hot-registers —
> no secret copying (env credentials remain the ops/SaaS path). GitLab: deferred by decision;
> the `GitProvider` interface carries it, a full draft lives in git history (`08b6c20`).
> **Next (decided 2026-07-08): multi-repo + public app.** One instance, many
> repositories, a repo overview derived from the GitHub App's installations; gap
> analysis with milestones: `docs/multi-repo-architecture.md`.
> WorkOS remains the optional identity layer in front — the git-provider grant stays the
> authorization primitive. Details: `apps/live-host/README.md` → Authentication.

- **Identity**: GitHub OAuth everywhere (OCT relay handles login for plugin and web app).
- **Session admission**: the Live Host approves join requests against the GitHub org/team
  (allowlist policy; OCT's host-approval hook is exactly this extension point).
- **Write vs. read in the session**: v1 keeps one collaborative room (everyone who is
  admitted can edit; read-only users use the portal). OCT's room `permissions.readonly`
  exists if a read-only _live_ view becomes a requirement.
- **Release rights**: enforced by GitHub, not by us — the PR is opened as the releasing user
  via a GitHub App user-to-server token; CODEOWNERS + branch protection decide who can merge.
  The platform never needs its own permission model for the part that matters.

## Deployment

Self-hosting is documented in [docs/on-prem/](on-prem/); the images are
`ghcr.io/miragon/designiq-live-host` (server + web app) and the portal image (root
`Dockerfile`). Miragon's hosted operation runs the same artifacts (ADR 0004).

> **Status update (2026-07-09): implemented as TWO apps** — the Hocuspocus pivot merged
> relay + host, and the Live Host serves the web app itself:
>
> | App        | Notes                                                                                                                                                       |
> | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | live-host  | HTTP + WebSocket on one port, **1 machine, no auto-stop, persistent volume** for the data dir (Yjs lineage + workspaces), GitHub App credentials as secrets |
> | portal+MCP | root `Dockerfile`                                                                                                                                           |

The OCT-era plan (kept as evaluated context) foresaw four apps: `bpm-oct-relay`,
`bpm-live-host`, `bpm-architecture`, `bpm-collab-web`. <!-- legacy-name-ok: the plan's own names -->

The Live Host is deliberately a single writer (one workspace, one room) — no clustering
needed or wanted in v1; OCT's server doesn't cluster either. One landscape = one Live Host.

## Risks & mitigations

| Risk                                                       | Mitigation                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCT is pre-1.0 (0.3.x)                                     | Pin versions; MIT license keeps the fork option; the protocol surface we use is small (room, fs, sync)                                                  |
| Session dies if Live Host restarts                         | We own the host: persisted Y-updates + auto room re-creation + client auto-rejoin via the session API; 30 s socket grace covers blips                   |
| Miragon modeler ↔ OCT text sync unproven                   | M0 spike task #1; known fix path (minimal-diff writes) is upstream work in our own plugin                                                               |
| Y.Text merge can produce invalid XML in rare interleavings | Rule 4: validate + last-good fallback; a merge that canvas writes alone broke is repaired by one writer; soft element-locks reduce the collision window |
| OCT encrypts with AES-CBC (not AEAD)                       | Acceptable for v1 (transport is TLS anyway); track upstream                                                                                             |
| Live state exists only on one volume                       | Fly volume snapshots + the update log doubles as journal; releases drain risk continuously — encourage small, frequent releases                         |

## Milestones

- **M0 — Spike (1–2 weeks)**: self-host OCT relay; headless bot host that creates a room and
  serves a real checkout; join from VS Code plugin and from a minimal web page (Monaco);
  verify Miragon modeler behavior in an OCT session; measure BPMN text-sync round trip.
  _Exit criterion: two people co-edit order-to-cash.bpmn — one in VS Code, one in Monaco._
- **M1 — Live workspace**: persistence (update logs + snapshots), session API, web app with
  explorer + bpmn-js canvas (4-rule sync) + Monaco, presence/awareness.
- **M2 — Release flow**: GitHub App, per-process release (validate gate → PR → merge webhook
  → rebase), conflict UX, pipeline notification.
- **M3 — Polish**: soft element-locks, remote-change highlighting, dirty-vs-released markers
  in portal ("a newer live version exists"), MCP live tools.
- **M4 — v2 options**: operation-level BPMN sync, DMN/Value Chain/Team Topology canvases in
  the web app, multiple landscapes (one Live Host each).

## Assumptions & open questions

- **Write path** (question was left open): assumed _Live Host primary, direct git pushes
  allowed_ — the rebase-on-merge webhook handles both merged releases and direct pushes the
  same way. If direct pushes should be forbidden instead, branch protection makes `main`
  pipeline-only and the rebase path only ever sees released PRs; the architecture is
  identical.
- Sub-question for M2: may a release _also_ touch `landscape/` (shared files, CoE-owned)?
  Concept assumes yes, but flagged in the PR and routed to CoE via CODEOWNERS.
- Naming: "Live Host" here; product name open.
