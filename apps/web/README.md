# @designiq/web

The collaborative web client of designIQ — the SPA (bpmn-js / dmn-js / the Miragon
renderers + Monaco on a shared Y.Text, the repo overview) **and** the MCP-App
modeler widgets the Live Host serves inline in AI chats (claude.ai, Claude
Desktop, ChatGPT).

## Scripts

| Script                                  | What it does                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @designiq/web dev`       | Vite dev server: the SPA, and every widget at `/mcp-app*.html` (raw boot marker → editable, this origin as the deep-link base).                                                                                                                                                                                                                |
| `pnpm --filter @designiq/web build`     | The SPA plus **one single-file bundle per widget** into `dist/` (`vite build`, then `scripts/build-widgets.ts`, see below).                                                                                                                                                                                                                    |
| `pnpm --filter @designiq/web test`      | `node --test test/*.test.ts`: the DOM-free suites (widget core: lifecycle, live upgrade, engines; the Markdown renderer, the fence parity and Insert diagram) and, under jsdom, the Markdown view, its Mermaid fences, the starter diagrams, the mermaid engine's configuration and the Miragon renderers themselves (`test/renderer-dom.ts`). |
| `pnpm --filter @designiq/web typecheck` | `tsc --noEmit` over `src/` and `test/`.                                                                                                                                                                                                                                                                                                        |

## Theming

The UI follows the Miragon CI in ONE light mode (`CLAUDE.md` → Design system). Every
colour comes from `@designiq/ui-kit`:

| Layer                                                                | Source                                                                 | Consumed by                                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| CI tokens (`--cd-*`)                                                 | `packages/ui-kit/src/cd-tokens.generated.css` — vendored, never edited | the aliases                                                             |
| Semantic aliases (`--primary`, `--link`, `--border`, `--canvas-*` …) | `packages/ui-kit/src/tokens.css`                                       | the SPA (through `theme.css`) and the widget sheets                     |
| Tailwind utilities, radius, shadow, motion, Geist                    | `packages/ui-kit/src/theme.css`                                        | the SPA (`src/index.css`)                                               |
| bpmn-js / dmn-js chrome (`--bio-*`)                                  | `src/lib/bpmn-io-theme.css`                                            | the bpmn/dmn editors, the diff viewer, the bpmn/dmn widgets             |
| Real colour values (`CD`, `ALIASES`, `mix()`)                        | `@designiq/ui-kit/lib/tokens`                                          | Monaco themes, canvas defaults, data-URL icons, exported SVG attributes |

- **No hex in components.** Tailwind utilities on the aliases (`bg-primary hover:bg-primary-hover`,
  `text-link`, `text-muted-foreground`, `border-input`), `var(--alias)` in plain CSS,
  `ALIASES` / `CD` in TS.
- **A new colour** is an alias in `tokens.css` (built from `--cd-*` and `color-mix()` only)
  AND its value in `ALIASES` (`lib/tokens.ts`), plus a `--color-*` line in `theme.css` when
  components need the utility. `pnpm --filter @designiq/ui-kit test` evaluates the CSS
  against the mirror and checks contrast (text ≥ 4.5:1, non-text ≥ 3:1) — so prefer an
  existing alias.
- **Canvas defaults** (bpmn-js / dmn-js shape fill, stroke, label font) take literal values
  from `lib/tokens.ts`, so an exported SVG stays self-contained; `--canvas-*` paints the host.
  The Miragon renderers keep their own CI styling — nothing here restyles them.
- **Icons** are Lucide only: `lucide-react` in the SPA; the React-free widgets inline the
  same icon nodes from `src/mcp-app/icons.ts` (`test/widget-icons.test.ts` holds them to
  the package).

## The Markdown view

A Markdown model (`.md`) opens as the rendered document. The view switch has three sides:
**Preview** (the document), **Split** (the Monaco source on the left, the document on the
right, each edit landing as you type) and **Markdown** (the source alone).
`src/notations/markdown/plugin.ts` is the light manifest; its lazy entry `markdown-view.ts`
loads markdown-it, DOMPurify, the view and its stylesheet as their own chunk when a document
opens (ADR 0006). `pnpm arch` holds every other module to `import()` (rule
`web-markdown-engine-loads-lazily`).

- `render.ts` is pure, node-tested in `test/markdown-render.test.ts`: CommonMark plus the GFM
  tables, strikethrough, task lists and autolinks, and GitHub-style heading anchors (the ids
  carry an `md-` prefix, URL fragments stay bare). Raw HTML never reaches the page: HTML
  comments are hidden, as on GitHub, everything else is escaped and shows as text.
  `javascript:`, `vbscript:`, `file:` and non-image `data:` URLs never become a link or an
  image. GFM footnotes do not render yet; their text stays in the document.
- `sanitize.ts` sanitizes that HTML once more with DOMPurify, against an allowlist of exactly
  the markup the renderer emits (no style, no SVG, no data-\* but `data-model-path`, ids only
  with the `md-` prefix).
- `view.ts` mounts the document in the canvas layer. It re-renders 200 ms after the last
  change of the shared Y.Text (a collaborator's included), at least once a second while the
  changes keep coming, scrolls in-page `#anchors` and hands a link to another model to the
  shell, which opens it on its own route. While the shell shows only the Markdown source
  (`EditorContext.visibility`), it does not render and catches up when it shows again.
  `test/markdown-view.test.ts` covers the sanitizer and the view under jsdom.
- The split view is the shell's, for a plugin that opts in (`WebNotationPlugin.splitView`, so
  far only Markdown). It narrows the same two layers the single views stack, so neither engine
  remounts, and puts the divider between them (`src/components/split-divider.tsx`): drag it,
  or focus it and use the arrow keys, Home and End; a double-click puts it back in the middle.
  Neither pane gets narrower than 20rem. Split needs an editor at least 48rem wide and stays
  on down to 45rem; narrower, the switch drops Split and the preview shows, and a chosen Split
  comes back once there is room. The view and the divider's position are remembered per
  notation in the browser (`src/lib/editor-view.ts`, localStorage): the first visit opens the
  preview, the fallback to the source when the view fails to load is never remembered, and
  neither is a click on the divider that does not move it. Monaco wraps long lines in a
  Markdown document. `test/editor-view.test.ts` and `test/split-ratio.test.ts` cover the rules.
- A relative link to a model of the repository (the shell's model list) is that model's
  in-app route (`/r/<owner>/<repo>/f/<path>#<section>`); a link to any other repository file,
  a document outside the models folder included, is marked, inert text. So is a link with a
  scheme other than `http(s):`, `mailto:` and `tel:`. Images load from `https:` and inline
  `data:image/` URLs, directly from their host; an image of the repository shows a
  placeholder with its alt text, because the Live Host serves no raw files.
- A fenced code block renders as code, unless `fences.ts` registers its language: `render`
  returns its HTML inside the render pass, `hydrate` upgrades it in the DOM afterwards, only
  for a document that has such a fence. `fences.ts` states the contract an extension builds
  on.
- Mermaid diagrams: a `mermaid` fence (`mermaid-fence.ts`) draws through the app's one
  Mermaid renderer, `src/lib/mermaid-render.ts` (strict security level, the CI theme,
  Geist). The look is fixed: a diagram's front matter or `%%{init}%%` cannot pick another
  theme, palette, CSS or font (`MERMAID_SECURE_KEYS`, checked against mermaid itself in
  `test/mermaid-engine.test.ts`); layout options stay the author's. A diagram keeps the look
  and the layout it had before mermaid 12 unless its front matter picks otherwise (`look: neo`,
  `layout: elk`): the classic look, and dagre for flowchart, class, state, ER and requirement
  diagrams. mermaid 12's own sizing still applies: in flowchart and state diagrams a label
  gets at least 120 px (`minNodeWidth`) and wraps at 120 px (`wrappingWidth`, 200 before),
  so their nodes come out wider and long labels wrap sooner. The renderer and
  mermaid load on the first document that has such a fence, never for any other. The drawn SVG is sanitized once more (`createDiagramSanitizer` in
  `sanitize.ts`, the profile mermaid applies itself) and cached by source: a re-render for an
  edit elsewhere puts the same diagrams back before the browser paints, and a changed diagram
  keeps its drawing until the new one is drawn. A diagram mermaid cannot read shows a notice
  with the error and its line (counted within the diagram) under its code, or under its last
  good drawing, dimmed. `test/markdown-mermaid.test.ts` covers it under jsdom with a fake
  renderer. A Mermaid diagram is no model of its own: it lives as such a fence in a document.
- **Insert diagram** starts a diagram from the source. While the source is on screen (Split and
  Markdown), the toolbar's Insert diagram menu, and the F1 palette (`Insert diagram: Flowchart`
  and so on), insert a small, valid starter: a flowchart, a sequence, class, state, entity
  relationship or Gantt diagram, a C4 context or a mindmap (`diagram-starters.ts`). It goes in
  as a `mermaid` fence of its own at the cursor, between the document's blocks and never into
  one: after the block the cursor is in, before it when the cursor is at its start, with blank
  lines around it. A block is one as the view reads it: a paragraph over several lines, a fence
  (the cursor in one puts the diagram after it), a table, a setext heading, raw HTML, indented
  code, a quote. In a list it goes after the cursor's item with everything nested in it (child
  lists, fences, further lines, indented however far), and a numbered list goes on at its
  number. The result is read back: the diagram must read as one, and every other block as it
  did (`insert-diagram.ts`, `test/insert-diagram.test.ts`). Until the source has had the focus,
  it shows no cursor, so the diagram goes to the document's end. The insertion is one edit, so
  one undo step, synced to everyone like typing; then the cursor selects the label to edit
  first (each starter names it). `test/diagram-starters.test.ts` parses every starter with
  the pinned mermaid and runs the validator's check over it. The tooling comes through the
  plugin's source slot, `WebNotationPlugin.attachSource`: a lazy chunk (`source-tools.ts`) the
  shell attaches to its Monaco once the session is live and disposes with it, its menus shown in
  the toolbar while the source is; `pnpm arch` holds it to `import()` like the view.
- In the source and in the history diff, a ` ```mermaid ` fence is highlighted as Mermaid,
  and in the source `%%` toggles a comment in it: `src/lib/monaco-languages.ts` registers the
  language before Monaco makes a model, its grammar (`src/lib/mermaid-monarch.ts`) loads with
  the first fence. Only a fence of three backticks: Monaco's Markdown grammar embeds no other,
  so a `~~~` or a longer fence gets no Mermaid highlighting, though it draws and is checked as
  a diagram. `test/mermaid-monarch.test.ts` runs it through Monaco's own Monarch lexer.
- `@designiq/notations/mermaid` holds the reading of a diagram's text the validator and the
  renderer share (the diagram types, the code mermaid's parser sees, the error lines). It
  mirrors mermaid `MERMAID_VERSION`; `test/mermaid-engine.test.ts` fails on a mermaid bump
  until it is re-read, checks every listed type against mermaid's own detection, and has
  mermaid parse broken diagrams below comment lines to check the line each notice names
  (eventmodeling and agentflow-beta parse their comment lines, every other type drops them).
- `@designiq/notations/markdown` is the validator's reading of a document's fences, a
  zero-dep scanner: the `mermaid/diagram-type` check of every `mermaid` fence stands on it and
  names the document's line. `test/markdown-fences.test.ts` holds it against the markdown-it
  this view renders with, so a markdown-it bump that reads fences differently fails there.

## The MCP-App widgets

Each widget is ONE self-contained HTML file (`dist/mcp-app*.html`: scripts, CSS,
Geist (latin + latin-ext; Geist Mono latin in the decision widget) and, for
bpmn/dmn, the icon font as woff2 — all inlined; `src/mcp-app/font.ts` registers
the fonts through the FontFace API because host CSPs block `data:` fonts) built
by `vite.widget.config.ts`'s factory; `scripts/build-widgets.ts` runs every build. The Live Host
(`apps/live-host/src/http/mcp.ts`) serves it as a `ui://` resource behind an
`open_*` tool — a dist without a bundle simply lacks that tool.

| Bundle                        | Tool                          | Engine                                             |
| ----------------------------- | ----------------------------- | -------------------------------------------------- |
| `mcp-app.html`                | `open_modeler`                | bpmn-js (+ stickies, t.BPM, the Todos card)        |
| `mcp-app-dmn.html`            | `open_decision_modeler`       | dmn-js + the simulation add-on (+ the Checks card) |
| `mcp-app-wardley.html`        | `open_wardley_modeler`        | `@miragon/wardley-renderer`                        |
| `mcp-app-team-topology.html`  | `open_team_topology_modeler`  | `@miragon/team-topologies-renderer`                |
| `mcp-app-event-storming.html` | `open_event_storming_modeler` | `@miragon/event-storming-renderer`                 |
| `mcp-app-context-map.html`    | `open_context_map_modeler`    | `@miragon/context-maps-renderer`                   |

**One lifecycle.** Every widget shares `src/mcp-app/core/`: `lifecycle.ts`
(tool input → load via `get_model_content` → engine → debounced CAS autosave via
`save_model_content` with `lint:"warn"` and a 5 s / 15 s / 60 s retry backoff →
the conflict decision → the newest-widget claim, whose loser saves a pending
edit once and re-mounts as a viewer → the progressive live upgrade → the
post-outage reconcile), `live.ts` (the single-use ws ticket + Yjs session and
the roster of peers) and `widget.ts` (the DOM composition: `bootWidget(spec)`).
A notation contributes an **engine adapter** (`src/mcp-app/engines/*.ts`)
against the contract in `core/engine.ts` — `importText` / `exportText` /
`onDirty` / optional `selectedElementId` / optional `bindLive` / optional
`view` (fit, zoom, the palette) / optional `displayName` — plus a `WidgetSpec`
(`main.ts` for bpmn, `dmn-main.ts` for dmn, `miragon-main.ts` for the
renderers). Its extras (`WidgetExtras`: the Todos and Checks cards) hear
`onRead` (the path is known: discovery runs in parallel with the import),
`onDocument` and `onSaved`. Two engine invariants the core relies on:
`importText` never fires `onDirty` (the Miragon engine has it from the
`@miragon/modeler-api` contract, law L1: a silent import), and `bindLive` is a
capability (absent = CAS autosave only — the dmn engine's deliberate mode).
Full behaviour:
[docs/mcp-integration.md](../../docs/mcp-integration.md).

**One chrome.** The iframe is all canvas; the controls float in corner
clusters (12px from the edge inline, 16px in fullscreen, plus the host's safe
area), each kind of information in one home. The design, its measurements and
the reasons behind them are in
[`docs/mcp-app-widget-chrome.md`](../../docs/mcp-app-widget-chrome.md) —
`spec §n` in the widget sources refers to it.

| Where         | What                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| top-left      | the document menu (name, Save now, Reload, Workshop, the panel, Fit, fullscreen); compact: **Tools**; the Workshop chip (bpmn) or the DRD \| Table switch (dmn) |
| top-right     | the panel toggle (Todos with its count, Checks with its verdict), fullscreen, **Open in designIQ** — the one blue button                                        |
| bottom-left   | the sync pill: Live (+ avatars), Saved, Unsaved changes, Not saved + Retry, Autosave paused, Read-only, Inactive; a click opens the details                     |
| bottom-right  | zoom − / % / + / fit, beside the bpmn.io watermark (never covered)                                                                                              |
| bottom-centre | toasts and the decision cards (CAS conflict, live interrupted, superseded) — beside an open card, never over a panel; a sheet ends above them                   |
| centre        | the state cards: starting, loading, no input, load failed (Try again), import failed (Ask the assistant), renderer failed                                       |
| right         | the Todos / Checks card — a full-width sheet when compact, or when a card would leave the toasts under 300px of canvas                                          |

The split is pure-and-tested vs. DOM: `src/mcp-app/core/` holds what each
surface says and when (`layout.ts` — the measured degrade, compact below 600 ×
440, the fit insets, the inline height; `sync-view.ts`, `menu-model.ts`,
`feedback.ts`, `keymap.ts`, `host-context.ts`, `todos-view.ts`,
`checks-view.ts`), node-tested in `test/widget-*.test.ts`; `src/mcp-app/chrome/`
binds them to the skeleton every entry carries (`mcp-app*.html` — the ids are
the contract) behind the types in `chrome/contracts.ts`, and `shell.ts`
composes them into ONE `WidgetChrome`. `engines/fit.ts` fits the diagram
clear of the clusters, the palette and an open card, and re-fits it on resize,
on a panel toggle and on a live re-import until the user zooms or pans; a
display-mode change always re-fits. The inline height is declared after
connect (480, or 420 below 600 wide), and again only on a width-class flip or
the return to inline; no state change resizes the iframe.
Colours come from the `@designiq/ui-kit` aliases only (`chrome.css` for what
every widget shares; each entry sheet — `styles.css`, `dmn-styles.css`,
`miragon-styles.css` — places its renderer's palette, `styles.css` adds the
Workshop chip and the Todos internals, `dmn-styles.css` the DRD | Table switch,
the verdict chip and the Checks sections), the icons from `icons.ts`, and `prefers-reduced-motion`
turns every slide, spinner and animated re-fit off. The chrome modules' focus
rules (a keyboard user never lands on `<body>`) are tested on a small fake DOM
(`test/fake-dom.ts`, `test/widget-chrome-dom.test.ts`).

**One spec per Miragon renderer.** The four Miragon widgets are not four
entries: `src/notations/miragon/<id>.ts` holds ONE `MiragonRendererSpec` per
renderer (package, canvas class, the renderer's `meta.notation`, a lazy
`load()` yielding its two `@miragon/modeler-api` factories, `create` and
`createViewer`), and everything derives from it — the SPA's editor plugin
(`notations/miragon/plugin.ts`), the widget engine (`engines/miragon.ts`),
both bound to the shared text through ONE contract adapter
(`@designiq/live-client/miragon-sync`), the SPA's vendor-CSS scoping
(`notations/miragon/vendor-css.ts`, a descendant prefix for every rule, its global
selectors and the renderer root's rules pinned in `test/vendor-css.test.ts`),
and the widget bundle: `mcp-app-miragon.html` + `src/mcp-app/miragon-main.ts`
are the ONE template + entry, built once per spec with the spec aliased in
through `@/mcp-app/widget-spec` (`miragonWidgetConfig`) and emitted as
`mcp-app-<id>.html`. The dev server resolves that alias to
`widget-spec.dev.ts`: `/mcp-app-miragon.html?notation=<id>` previews any of them.

**One engine per bundle.** The iframe sandbox allows no external requests, so
nothing is shared between the emitted files — and exactly one engine per file is
also the widgets' whole CSS scoping: the SPA's postcss vendor-CSS scoping is
deliberately absent here. Never bundle two engines (or bpmn-js next to a Miragon
sheet) into one widget.

**Read-only hosts** (`LIVE_MCP_READONLY=1` on the Live Host) mount each engine's
viewer (a Miragon spec's `createViewer`, which takes the Context Maps legend
like the editor). No viewer needs a command stack
(`test/miragon-renderers.test.ts`). The superseded freeze takes the same viewer
path. A Miragon renderer mounts its own root INSIDE the element it is attached
to and removes only that root on `destroy()`, so `miragon-main.ts` gives each
mount a host element of its own inside `#canvas` (carrying the scope class,
sized by `miragon-styles.css`) and removes it with the engine.

### Adding a Miragon notation

1. The descriptor in `@designiq/notations` (extensions, noun, media kind).
2. One spec file `src/notations/miragon/<id>.ts` (copy `event-storming.ts`):
   the package, the canvas class, the renderer's `meta.notation`
   (`contractNotation`) and a `load()` mapping `create`/`createViewer` onto the
   package's `createCollaborativeModeler`/`createCollaborativeViewer` and its
   own spelling of the free area (`freeRectInsets`, or `freeRectCenter` and
   `fitOnImport` like `team-topology.ts`). Then its line in
   `src/notations/miragon/index.ts` — the SPA editor plugin, the widget engine,
   the CSS scoping and the widget bundle derive from it. The scoping is
   reviewed per renderer in `test/vendor-css.test.ts`: the new spec needs its
   rows in `KNOWN_GLOBAL` (the selectors it may leave global), `RENDERER_ROOT`
   (the root its factory mounts) and `ROOT_RULES` (that root's rules).
3. The notation id in `GENERATED_WIDGET_NOTATIONS` (`apps/live-host/src/http/mcp.ts`)
   — the tool, its description and its resource derive from the registry
   descriptor (`@designiq/contracts/mcp-app` names the tool) and the test stubs
   follow `WIDGET_FILES`; the two literal tool-list pins in
   `apps/live-host/test/mcp.test.ts` gain the new name (on purpose — a new tool
   shows up in a reviewed diff).
4. `docs/mcp-integration.md` (tool table + the widgets section).

A renderer without the `@miragon/modeler-api` factories (or a non-Miragon
engine) gets a bespoke engine adapter + entry, the bpmn/dmn way.

### Mixed deployments

The widgets and the Live Host ship in one image. A web dist newer than a
pre-#160 Live Host has no `get_model_content` and fails its first load with
"Tool get_model_content not found" — there is no fallback on purpose.
