# @designiq/web

The collaborative web client of designIQ — the SPA (bpmn-js / dmn-js / the Miragon
renderers + Monaco on a shared Y.Text, the repo overview) **and** the MCP-App
modeler widgets the Live Host serves inline in AI chats (claude.ai, Claude
Desktop, ChatGPT).

## Scripts

| Script                                  | What it does                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @designiq/web dev`       | Vite dev server: the SPA, and every widget at `/mcp-app*.html` (raw boot marker → editable, this origin as the deep-link base).                             |
| `pnpm --filter @designiq/web build`     | The SPA plus **one single-file bundle per widget** into `dist/` (`vite build`, then `scripts/build-widgets.ts`, see below).                                 |
| `pnpm --filter @designiq/web test`      | `node --test test/*.test.ts`: the DOM-free suites (widget core: lifecycle, live upgrade, engines; the Markdown renderer) and the Markdown view under jsdom. |
| `pnpm --filter @designiq/web typecheck` | `tsc --noEmit` over `src/` and `test/`.                                                                                                                     |

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

A Markdown model (`.md`) opens as the rendered document; the view switch's **Markdown** side
is the Monaco source to edit it in. `src/notations/markdown/plugin.ts` is the light manifest;
its lazy entry `markdown-view.ts` loads markdown-it, DOMPurify, the view and its stylesheet
as their own chunk when a document opens (ADR 0006). `pnpm arch` holds every other module to
`import()` (rule `web-markdown-engine-loads-lazily`).

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
  shell, which opens it on its own route. `test/markdown-view.test.ts` covers the sanitizer
  and the view under jsdom.
- A relative link to a model of the repository (the shell's model list) is that model's
  in-app route (`/r/<owner>/<repo>/f/<path>#<section>`); a link to any other repository file,
  a document outside the models folder included, is marked, inert text. So is a link with a
  scheme other than `http(s):`, `mailto:` and `tel:`. Images load from `https:` and inline
  `data:image/` URLs, directly from their host; an image of the repository shows a
  placeholder with its alt text, because the Live Host serves no raw files.
- A fenced code block renders as code, unless `fences.ts` registers its language: `render`
  returns its HTML inside the render pass, `hydrate` upgrades it in the DOM afterwards, only
  for a document that has such a fence. That is the slot a Mermaid renderer (#254) plugs
  into, without a change to the view; `fences.ts` states the contract it builds on.

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
`importText` never fires `onDirty` (the Miragon DSL renderers emit
`commandStack.changed` from their own `clear()` — `engines/miragon.ts`
suppresses the echo), and `bindLive` is a capability (absent = CAS autosave
only — the dmn engine's deliberate mode). Full behaviour:
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
renderer (package, css classes, a lazy `load()` yielding Modeler + viewer +
the text lane), and everything derives from it — the SPA's editor plugin
(`notations/miragon/plugin.ts`), the widget engine (`engines/miragon.ts` over
`@designiq/live-client/miragon-sync`), the vendor-CSS scoping in `vite.config.ts`,
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
`NavigatedViewer`; for the DSL-lane renderers (Wardley Map, Event Storming) with an
inert `commandStack` value module (`engines/diagram-js.ts` — their import clears
a stack only the Modeler registers). The superseded freeze takes the same viewer
path. Every Miragon renderer adopts the element it is handed as its root and
removes it on `destroy()`, so `miragon-main.ts` gives each mount a host element
of its own inside `#canvas` (carrying the scope class).

### Adding a Miragon notation

1. The descriptor in `@designiq/notations` (extensions, noun, media kind).
2. One spec file `src/notations/miragon/<id>.ts` (copy `wardley.ts` for a DSL
   renderer, `team-topology.ts` for a JSON one) and its line in
   `src/notations/miragon/index.ts` — the SPA editor plugin, the widget engine,
   the CSS scoping and the widget bundle derive from it.
3. The notation id in `GENERATED_WIDGET_NOTATIONS` (`apps/live-host/src/http/mcp.ts`)
   — the tool, its description and its resource derive from the registry
   descriptor (`@designiq/contracts/mcp-app` names the tool) and the test stubs
   follow `WIDGET_FILES`; the two literal tool-list pins in
   `apps/live-host/test/mcp.test.ts` gain the new name (on purpose — a new tool
   shows up in a reviewed diff).
4. `docs/mcp-integration.md` (tool table + the widgets section).

A renderer with a different API than the two lanes (or a non-Miragon engine)
gets a bespoke engine adapter + entry, the bpmn/dmn way — until
[#136](https://github.com/Miragon/design-iq/issues/136) (`@miragon/modeler-api`)
makes the lane split disappear.

### Mixed deployments

The widgets and the Live Host ship in one image. A web dist newer than a
pre-#160 Live Host has no `get_model_content` and fails its first load with
"Tool get_model_content not found" — there is no fallback on purpose.
