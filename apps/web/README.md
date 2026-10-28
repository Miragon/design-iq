# @designiq/web

The collaborative web client of designIQ — the SPA (bpmn-js / dmn-js / the Miragon
renderers + Monaco on a shared Y.Text, the repo overview) **and** the MCP-App
modeler widgets the Live Host serves inline in AI chats (claude.ai, Claude
Desktop, ChatGPT).

## Scripts

| Script                                  | What it does                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @designiq/web dev`       | Vite dev server: the SPA, and every widget at `/mcp-app*.html` (raw boot marker → editable, this origin as the deep-link base).                                                                                                                                                                                                                                                                        |
| `pnpm --filter @designiq/web build`     | The SPA plus **one single-file bundle per widget** into `dist/` (`vite build`, then `scripts/build-widgets.ts`, see below).                                                                                                                                                                                                                                                                            |
| `pnpm --filter @designiq/web test`      | `node --test test/*.test.ts`: the DOM-free suites (widget core: lifecycle, live upgrade, engines; the Markdown renderer, the fence parity and Insert diagram) and, under jsdom, the Markdown view, its Mermaid fences, the starter diagrams, the mermaid engine's configuration and what it makes of hostile sources, the Mermaid frame and the Miragon renderers themselves (`test/renderer-dom.ts`). |
| `pnpm --filter @designiq/web typecheck` | `tsc --noEmit` over `src/` and `test/`.                                                                                                                                                                                                                                                                                                                                                                |

Eight checks run by hand in headless Chromium, as CI has no browser: `test/hostile-mermaid-chromium.ts`,
`test/markdown-view-chromium.ts` and `test/wide-mermaid-chromium.ts` (all three under the Markdown view
below), `test/live-gesture-chromium.ts`, `test/canvas-focus-chromium.ts` and
`test/png-export-font-chromium.ts` (all three under the MCP-App widgets below),
`test/source-layers-chromium.ts` (Monaco beside the side panels, next paragraph) and
`test/live-repair-chromium.ts`, the live merge repair and its notice with real peers (issue 296):
two tabs dropping moves at once, the first-ranked writer closing its tab, a link that drops and
comes back, a half-typed tag seen from the canvas tabs, a reload during it, and the BPMN widget
live in a minimal MCP-Apps host. From the repository root:
`pnpm build`, once `npx -y playwright@1.56.1 install --only-shell chromium`, then
`npx -y -p playwright@1.56.1 -c "node apps/web/test/live-repair-chromium.ts"` (`PORT` sets the
Live Host's port, 8392 unless set; `ONLY` and `SHOTS` are in its header).
`test/canvas-focus-chromium.ts` also runs in WebKit: `npx -y playwright@1.56.1 install webkit` once,
then the same command with `BROWSER=webkit`.

The side panels (History, Todos, Notes, …) dock over the right edge of the editor, the source
included (issue 288). The source's Monaco is laid out beside an open panel, in place of Monaco's
`automaticLayout` (`layoutBesideSidePanels` in `src/lib/side-panel-room.ts`): its scrollbar, its
find widget and the ends of its lines stay left of the panel, so every control of the find widget
can be clicked and reached with Tab. Monaco stacks its scrollbar and its find widget above the
panels, so `src/index.css` also isolates Monaco's frame (its `.overflow-guard`): whatever of it
still lies under a panel stays below it. The source pane itself makes no stacking context, so
Monaco's context menu and suggestions stay over a panel they reach into, and in the split view
over the preview. `test/side-panel-room.test.ts` and `test/source-layers.test.ts` hold the
layout, the stylesheet and the pinned Monaco to this, and `test/source-layers-chromium.ts` checks
it in the built app, run as above (`PORT`, 8393 unless set).

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
loads markdown-it (with markdown-it-footnote), DOMPurify, the view and its stylesheet as their
own chunk when a document opens (ADR 0006). `pnpm arch` holds every other module to `import()`
(rule `web-markdown-engine-loads-lazily`).

- `render.ts` is pure, node-tested in `test/markdown-render.test.ts`: CommonMark plus the GFM
  tables, strikethrough, task lists, autolinks and footnotes, and GitHub-style heading anchors
  (the ids carry an `md-` prefix, URL fragments stay bare). A footnote reference is a superscript
  number, the notes a list at the end of the document, each with a link back to its references (a
  Lucide `corner-up-left`); a note nobody refers to is not shown, and inline footnotes (`^[…]`),
  which GitHub does not have, stay text. Labels match as on GitHub: in any case (`[^Note]` refers
  to `[^note]:`), and a label defined twice keeps its first note. Their ids (`md-Footnote-1`,
  `md-Footnote-ref-1`) never take a heading's, whose slugs are lower-case. The document's own HTML
  never reaches the page: HTML comments are hidden, as on GitHub, and the small subset GitHub
  authors use for layout (`<br>`, `<details>` and `<summary>`, `<sub>`, `<sup>`, `<kbd>`) renders
  as bare tags the renderer writes anew, every attribute dropped but `<details open>`. Everything
  else is escaped and shows as text. A `<kbd>` is the design guide's shortcut chip, a `<summary>`
  shows a Lucide chevron instead of the browser's triangle. `javascript:`, `vbscript:`, `file:`
  and non-image `data:` URLs never become a link or an image.
- `sanitize.ts` sanitizes that HTML once more with DOMPurify, against an allowlist of exactly
  the markup the renderer emits (no style, no SVG, no data-\* but `data-model-path` and
  `data-image-src`, ids only with the `md-` prefix). It holds the images to the rule below as
  well: an image keeps its address only on the page's own origin, as inline data, or when the
  reader chose to load it.
- `view.ts` mounts the document in the canvas layer. It re-renders 200 ms after the last
  change of the shared Y.Text (a collaborator's included), at least once a second while the
  changes keep coming, scrolls in-page `#anchors` and hands a link to another model to the
  shell, which opens it on its own route. While the shell shows only the Markdown source
  (`EditorContext.visibility`), it does not render and catches up when it shows again.
  A render replaces only the top-level blocks whose HTML changed or that moved past others
  (#289) and keeps every other block on the page as it is, so a reader's selection, the
  keyboard focus and a drawn diagram in it survive a co-editor's pause. The blocks of the two
  renders are aligned, so a block that repeats (a heading's text, a rule) never costs an
  unchanged block its place. The focus in a replaced block moves to the view. A `<details>`
  the reader opened or closed keeps that state in a kept block and, found by its summary's
  text, in the block that replaces its own. The view keeps the first block on screen where it
  is, through a render and when a diagram drawn or an image loaded later changes the height
  above it, as Safari only has CSS scroll anchoring from 27 on; a `<summary>` the reader
  clicks stays put while its section opens or closes. When a render replaces every block on
  screen, such as the footnotes, which a new reference anywhere renews, the end of the last
  block above that stays holds the place. `test/markdown-view.test.ts` covers the sanitizer
  and the view under jsdom; `test/markdown-view-chromium.ts` checks the selection, the focus,
  an in-page link, a footnote, collapsible sections and the scroll position in headless
  Chromium while a guest session edits the document, with the browser's scroll anchoring and
  without it (run like the hostile check below, `PORT` 8393 unless set).
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
  scheme other than `http(s):`, `mailto:` and `tel:`. A link to the repository on GitHub
  (`.../<owner>/<repo>/blob/<branch>/<path>`, the host's `GITHUB_BASE_URL` in
  `AppConfig.githubBaseUrl`) counts as a relative one when it names the default branch, the one
  designIQ shows, and a model or this document. Any other GitHub address (another branch or a
  commit, a folder, a file that is no model) stays a link to GitHub. The default branch comes
  from the repository list (`lib/default-branch.ts`), and only for a plugin that asks
  (`WebNotationPlugin.githubLinks`): the editor reads the list at hand, the last visit's
  included, and loads one only when there is none, since `/api/repos` costs the host git calls
  per repository. A click on an in-page `#anchor` scrolls the view and puts the section in the
  address, replacing it (no history entry per click), so the address shares the section. The
  router hears of it and renders the route again, with its own scroll to the bare fragment off.
- Images (#290): a relative image is a file of the repository and loads from the Live Host
  (`GET /api/repos/<owner>/<repo>/image?path=`, the content API's authorization, image types
  only, 10 MiB at most); one that does not load turns into a placeholder with its alt text. An
  image from another site (`https:`) never loads on its own: its host would learn every
  reader's IP address, time and browser. It shows as a placeholder that names the host, and
  **Load image** loads that one image, without a referrer, for as long as the view of the
  document is open (never stored). Inline `data:image/` images show at once; `http:` and other
  schemes stay placeholders.
- A fenced code block renders as code, unless `fences.ts` registers its language: `render`
  returns its HTML inside the render pass, `hydrate` upgrades it in the DOM afterwards, only
  for a document that has such a fence. `fences.ts` states the contract an extension builds
  on.
- Mermaid diagrams: a `mermaid` fence (`mermaid-fence.ts`) draws through the app's one
  Mermaid renderer, `src/lib/mermaid-render.ts` (strict security level, the CI theme,
  Geist). Diagram types that colour by section (mindmap, timeline, kanban, treemap, radar, git
  graph, pie, venn) take two CI greys in turn instead of the rose and off-CI shades mermaid
  derives, and so do an xy chart's bars and lines instead of mermaid's peach palette:
  `--cd-kontur` with black labels, `--cd-text-leise` with white ones; a mindmap's root and a git
  graph's main branch are black with a white label, a highlighted commit is framed in black, a
  user journey's sections take white and the calm grey in turn, a radar's grid takes
  `--cd-linie` and a quadrant chart's points black (#294). Two series of the same parity (pie
  slices 1 and 3, radar curves 0 and 2, git branches 1 and 3, venn sets 1 and 3, xy plots 0
  and 2) share a grey, so a legend cannot tell them apart, and a git graph's ninth branch
  (main counts as the first) takes main's black again (mermaid cycles through eight branch
  colours).
  mermaid lightens a kanban column's grey, fades a treemap's, brightens a timeline's events,
  writes an xy chart's labels in one colour whatever they sit on, draws its plots over each
  other and fills mindmap and timeline nodes white in the neo look, so a kanban column takes
  the grey of every other group, a timeline event its section's grey, a data label inside a
  `--cd-text-leise` bar is white on a halo of that grey (where it runs past a bar too short
  for it, the halo outlines it on white), a data label outside a bar and a point label are
  black on a white halo (a later plot's label can lie on an earlier plot's bar), and a kanban
  column's title, a treemap's labels and the labels of neo nodes stay black
  (`MERMAID_THEME_CSS`). An xy chart draws every bar plot at the same place, over the earlier
  ones, so each bar lies on a rim in the plot's white that reaches 2 px past it, under its
  fill: a bar that ends on an earlier bar of either grey keeps its edge at 3:1, and every bar
  its length. Its bars and lines share the two greys, so the page lays a second path in the
  plot's white under every line, 2 px wider on each side (`src/lib/mermaid-line-casing.ts`):
  the line holds 3:1 across a bar of either grey. A CSS filter cannot draw that casing, as WebKit
  applies none to an element inside an SVG. Rim and casing keep their 2 px in screen pixels
  (`vector-effect: non-scaling-stroke`), also where the chart shrinks to a column narrower than
  its natural size, and a line takes round caps like its casing, so a line of one point shows
  as a dot instead of a white disc. The look is fixed: a diagram's front matter or `%%{init}%%` cannot pick another
  theme, palette, CSS or font (`MERMAID_SECURE_KEYS`, checked against mermaid itself in
  `test/mermaid-engine.test.ts`); layout options stay the author's. What mermaid is known to
  load from an address a diagram names is kept from another site (#290). mermaid's label
  sanitizer (`MERMAID_LABEL_SANITIZER`, a diagram cannot change it) drops images, media and
  styles from a label's HTML. mermaid loads the rest itself while it lays the diagram out, so
  the source is checked before mermaid sees it (`diagramImageRefusal`,
  `diagramConfigRefusal`), and the diagram is refused with a notice for a shape's `img` or a
  sequence actor's `icon` that names an address (inline `data:image/` and `@symbol` icons
  still draw), for any `details` statement (it reads an actor's properties from an element of
  the page), and for CSS that fetches (`url()`, `src()`, `image-set()`, `@import`, escaped or
  not) anywhere in the source or in the diagram's own configuration. The page-side sanitizer
  then drops every address but the diagram's own `#…` references and inline data, and every
  style sheet or attribute whose CSS could name one. It also starts every id of a diagram with
  the SVG's own and keeps each id once, its references following, as mermaid leaves some ids
  unscoped and writes a mindmap node's id twice: no two diagrams, and no diagram and the app,
  share an id (#294). A reference to an id the diagram does not hold takes the prefix too (a
  vertical timeline points its lines at an arrowhead mermaid never draws), so no reference
  reaches an element outside its diagram; a link keeps its `#…`, where a reader goes. These checks follow mermaid's syntax; a way
  to load that a later mermaid adds is held by the Mermaid frame's policy instead (below) until
  it is added here. A diagram keeps the look and the layout it had before mermaid 12 unless its front matter picks otherwise (`look: neo`,
  `layout: elk`): the classic look, and dagre for flowchart, class, state, ER and requirement
  diagrams. mermaid 12's own sizing still applies: in flowchart and state diagrams a label
  gets at least 120 px (`minNodeWidth`; a circle, since 12.2, only the room its label needs)
  and wraps at 120 px (`wrappingWidth`, 200 before), so their nodes come out wider and long
  labels wrap sooner. The renderer and
  mermaid load on the first document that has such a fence, never for any other.
- Hostile diagrams: anyone who may write to a content repo writes the fences every reader's
  browser draws, so mermaid never runs in the page. It lays a diagram out in a document of its
  own, the hidden Mermaid frame (`src/lib/mermaid-frame.ts`, its document `mermaid-frame.html`,
  same origin): mermaid puts a diagram's labels, links and styles into that document as it
  measures them, before its own sanitizer runs, and the frame's policy lets nothing there load
  or run but designIQ's own scripts, styles and fonts (no image, media, frame or form; no inline
  script, handler or `javascript:` link). The page only gets the SVG as a string. That SVG is
  sanitized once more (`createDiagramSanitizer` in `sanitize.ts`: the profile mermaid applies
  itself, no forms, and nothing that loads, as above), so a diagram on the page loads nothing
  until a reader clicks one of its links. Images from an address are not drawn: one in a label
  is dropped, and a shape's image (`img:`) fails its diagram with a notice that says so, from
  the source check or, should that miss one, from the frame; inline `data:image/` images draw. `pnpm arch` keeps it so:
  only the frame's script imports the renderer (`mermaid-renders-in-its-frame`), only the
  renderer imports mermaid, `import()` included (`mermaid-loads-in-the-renderer-only`), and the
  MCP-App widgets draw no Mermaid (`widgets-draw-no-mermaid`).
  `test/mermaid-engine-hostile.test.ts`, next to the version mirror, runs hostile labels in every
  diagram type, links, click callbacks, front matter, `%%{init}%%` directives and foreignObject
  HTML through the pinned mermaid (the sources: `test/mermaid-hostile-sources.ts`);
  `test/mermaid-frame.test.ts` pins the frame's policy. What a browser makes of that policy is
  checked by hand, as CI has no browser: `test/hostile-mermaid-chromium.ts` starts a Live Host
  of its own on the same sources, opens them in the built SPA and in the BPMN and DMN widgets in
  headless Chromium, and fails on anything that ran or loaded. Run it after a mermaid or a
  browser update, from the repository root: `pnpm build`, once
  `npx -y playwright@1.56.1 install --only-shell chromium`, then
  `npx -y -p playwright@1.56.1 -c "node apps/web/test/hostile-mermaid-chromium.ts"` (`PORT`
  sets the Live Host's port, 8391 unless set).
- A diagram in a block the render keeps stays on the page as drawn. The drawn SVG is also
  cached by source: a new block with a diagram drawn before gets it back before the browser
  paints, and a changed diagram keeps its drawing until the new one is drawn; a diagram that
  is still drawing when the next render keeps its block lands there. `fences.ts` states what
  that asks of a fence extension. One drawing is never in two places, so its ids are not on
  the page twice: a source a document shows twice is drawn twice, each block of it keeps its
  own drawing while another is edited, and a block whose last drawing another block now shows
  waits for its new one with its code. A diagram mermaid cannot read shows a notice
  with the error and its line (counted within the diagram) under its code, or under its last
  good drawing, dimmed. `test/markdown-mermaid.test.ts` covers it under jsdom with a fake
  renderer. A Mermaid diagram is no model of its own: it lives as such a fence in a document.
- A wide diagram stays readable (#292). mermaid shrinks a diagram to the reading column, so
  the view holds it to the width at which its smallest text still reads at the guide's `klein`
  size, 13px (`diagram-scale.ts`). That minimum follows the text the drawn SVG shows, not a
  flat factor: a flowchart's 16px labels may shrink to 81 %, and a C4 diagram, whose type lines
  mermaid draws at 10.5px, is drawn at 124 % or more. A diagram wider than its block scrolls
  sideways there, never the page, and while it does, the block is a region in the tab order
  that the arrow keys scroll, with the guide's focus ring; one that fits is no tab stop, except
  while it has the focus, so the focus never drops to the top of the page. Each region is named
  after its place among the document's mermaid fences (one that shows its code counts) and its
  title or type ("Diagram 2 (flowchart), scrolls sideways"), so no two read alike, and renamed
  when a fence above it comes or goes. The Mermaid frame lays a diagram out at its own block's
  width, which a Gantt chart takes as its own; one that does, and whose smallest text would
  then hold it wider, is laid out once more at the block's width over its minimum scale, so it
  fits its block at 13px. It is laid out anew whenever its block changes width (Split to
  Markdown only, the split's divider, the window). `test/markdown-diagram-scale.test.ts` covers
  the scale, the region, its name and those widths under jsdom. `test/wide-mermaid-chromium.ts`
  checks a wide C4 diagram, a wide flowchart, two Gantt charts (one in a quote) and a diagram
  that only overflows a narrow window in headless Chromium: every text at 13px or more, the
  Gantt charts within their blocks at both window widths, the sideways scroll by keyboard, no
  tab stop on a diagram that fits, the focus kept when one fits again and the names after a
  diagram above leaves (run it like the hostile check above, `PORT` 8394 unless set).
- **Insert diagram** starts a diagram from the source. While the source is on screen (Split and
  Markdown), the toolbar's Insert diagram menu, and the F1 palette (`Insert diagram: Flowchart`
  and so on), insert a small, valid starter: a flowchart, a sequence, class, state, entity
  relationship or Gantt diagram, a C4 context or a mindmap (`diagram-starters.ts`). It goes in
  as a `mermaid` fence of its own at the cursor, between the document's blocks and never into
  one: after the block the cursor is in, before it when the cursor is at its start, with blank
  lines around it. A block is one as the view reads it: a paragraph over several lines, a fence
  (the cursor in one puts the diagram after it), a table, a setext heading, raw HTML, indented
  code, a quote, a footnote definition with everything indented under it. In a list it goes
  after the cursor's item with everything nested in it (child lists, fences, further lines,
  indented however far), and a numbered list goes on at its number. The result is read back:
  the diagram must read as one, and every other block as it did (`insert-diagram.ts`,
  `test/insert-diagram.test.ts`). Until the source has had the focus,
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
  a diagram. The grammar reads the header with the validator's pattern (`mermaidKeywordPattern`
  of `@designiq/notations/mermaid`): a casing mermaid draws, such as `Ishikawa`, is a keyword,
  and a word the validator warns on shows as invalid. `test/mermaid-monarch.test.ts` runs it
  through Monaco's own Monarch lexer.
- `@designiq/notations/mermaid` holds the reading of a diagram's text the validator and the
  renderer share (the diagram types, the code mermaid's parser sees, the error lines). It
  mirrors mermaid `MERMAID_VERSION`; `test/mermaid-engine.test.ts` fails on a mermaid bump
  until it is re-read, checks every listed type against mermaid's own detection, and has
  mermaid parse broken diagrams below comment lines to check the line each notice names
  (eventmodeling and agentflow-beta parse their comment lines, every other type drops them).
  It also spells every type in other casings: where mermaid detects one, it parses it, and the
  validator must accept exactly the casings that parse (`Ishikawa` and `stateDiagram-V2` draw,
  `Wardley-beta` does not).
- `@designiq/notations/markdown` is the validator's reading of a document's fences, a
  zero-dep scanner: the `mermaid/diagram-type` check of every `mermaid` fence stands on it and
  names the document's line. `test/markdown-fences.test.ts` holds it against the markdown-it
  this view renders with, footnote definitions included, so a bump of markdown-it or
  markdown-it-footnote that reads fences differently fails there.

## The MCP-App widgets

Each widget is ONE self-contained HTML file (`dist/mcp-app*.html`: scripts, CSS,
Geist (latin + latin-ext; Geist Mono latin in the decision widget) and, for
bpmn/dmn, the icon font as woff2 — all inlined; `src/mcp-app/font.ts` registers
the fonts through the FontFace API because host CSPs block `data:` fonts) built
by `vite.widget.config.ts`'s factory; `scripts/build-widgets.ts` runs every build. The Live Host
(`apps/live-host/src/http/mcp.ts`) serves it as a `ui://` resource behind an
`open_*` tool — a dist without a bundle simply lacks that tool.

| Bundle                        | Tool                          | Engine                                                                          |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| `mcp-app.html`                | `open_modeler`                | bpmn-js (+ stickies, t.BPM, the Todos card)                                     |
| `mcp-app-dmn.html`            | `open_decision_modeler`       | dmn-js + the simulation add-on (+ the Checks card)                              |
| `mcp-app-wardley.html`        | `open_wardley_modeler`        | `@miragon/wardley-renderer`                                                     |
| `mcp-app-team-topology.html`  | `open_team_topology_modeler`  | `@miragon/team-topologies-renderer`                                             |
| `mcp-app-event-storming.html` | `open_event_storming_modeler` | `@miragon/event-storming-renderer`                                              |
| `mcp-app-context-map.html`    | `open_context_map_modeler`    | `@miragon/context-maps-renderer` (+ `@miragon/context-maps-cml`, Export as CML) |

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
`view` (fit, zoom, the palette) / optional `displayName` / optional `menu` (a
Miragon renderer's own Model, Export and Help entries) — plus a `WidgetSpec`
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

| Where         | What                                                                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| top-left      | the document menu (name, Save now, Reload, Workshop, the panel, a Miragon renderer's Model, Export and Help entries, Fit, fullscreen); compact: **Tools**; the Workshop chip (bpmn) or the DRD \| Table switch (dmn) |
| top-right     | the panel toggle (Todos with its count, Checks with its verdict, Legend for a context map), fullscreen, **Open in designIQ** — the one blue button                                                                   |
| bottom-left   | the sync pill: Live (+ avatars), Saved, Unsaved changes, Not saved + Retry, Autosave paused, Read-only, Inactive; a click opens the details                                                                          |
| bottom-right  | zoom − / % / + / fit, beside the bpmn.io watermark (never covered)                                                                                                                                                   |
| bottom-centre | toasts and the decision cards (CAS conflict, live interrupted, superseded) — beside an open card, never over a panel; a sheet ends above them                                                                        |
| centre        | the state cards: starting, loading, no input, load failed (Try again), import failed (Ask the assistant), renderer failed                                                                                            |
| right         | the Todos / Checks / Legend card — a full-width sheet when compact, or when a card would leave the toasts under 300px of canvas                                                                                      |

The split is pure-and-tested vs. DOM: `src/mcp-app/core/` holds what each
surface says and when (`layout.ts` — the measured degrade, compact below 600 ×
440, the fit insets, the inline height; `sync-view.ts`, `menu-model.ts`,
`feedback.ts`, `keymap.ts`, `host-context.ts`, `todos-view.ts`,
`checks-view.ts`), node-tested in `test/widget-*.test.ts`; `src/mcp-app/chrome/`
binds them to the skeleton every entry carries (`mcp-app*.html` — the ids are
the contract) behind the types in `chrome/contracts.ts`, and `shell.ts`
composes them into ONE `WidgetChrome`. `engines/diagram-js.ts` fits the
diagram clear of the clusters, the palette and an open card, and re-fits it on
resize, on a panel toggle and on a live re-import until the user zooms or
pans; a display-mode change always re-fits. The view math and the readout are
`@miragon/modeler-shell/core`'s (`fitViewbox`, `sameView`,
`interpolateViewbox`, `zoomReadout`), and so are the zoom keys and ⇧1
(`decideKey`, through `src/lib/chrome-keys.ts`, which the SPA's editors bind
too): every widget takes them on the whole document (`chrome/keys.ts`), and
on a bpmn-js or DRD canvas the engine routes them from the diagram-js keyboard
first, ahead of bpmn-js's and dmn-js's own zoom (`routeCanvasChromeKeys`,
`EngineOptions.chromeKeys`). The −/+ buttons and the
zoom keys step on the design guide's fixed zoom steps (22, 30, 41, 55, 74, 100,
135, 182, 246 and 331 %, `zoomStepLevel` in `engines/fit.ts`), the raster of
diagram-js's `zoomScroll.stepZoom`. The − button and every zoom-out key stop at
a fit below 20 % instead of zooming in to 20 %, as `zoomScroll.stepZoom`, which
clamps, would; so does the wheel there (`keepWheelZoomDirection`). The widget's geometry (the 36px corners, the 12/16px insets)
stays designIQ's; the full shell is not mounted.
In the SPA a Miragon editor's ⇧1 fits 24px clear of the renderer's palette as
measured, of the canvas's sides and bottom, and of an open side panel (the
panels dock over the canvas's right edge, `src/lib/side-panel-room.ts`);
opening or closing a side panel re-fits a view nobody moved since the import
or the last fit, as the widget does with its cards. The SPA's BPMN and DMN
editors take the same keys on the whole page while their canvas is on screen
(`src/notations/bpmn-io-keys.ts`), and their wheel zoom stays put below 20 %;
there ⇧1 fits 24px clear of the palette column, the DRD's name card, its
simulation card and an open side panel. The first view of a Miragon editor is that
fit too: the editor mounts the renderer with `fitOnImport: false`, because
the renderer's own import fit leaves no room for the palette over the canvas,
and fits the first import itself (`firstFit` in `diagramView`); a peer's
re-import keeps the view the user has. Both hosts fit a Miragon
renderer to the box its `contentBounds()` reports (`@miragon/modeler-api`
contract 1.3, feature-detected in `miragonView`, `engines/miragon.ts`):
Wardley's plot with its axes, an Event Storming board's arrow annotations, a
team or context name wider than its shape. A renderer without the method, or
with nothing to fit, gets diagram-js's box around the elements. The ⋯ menu repeats the
Legend toggle as a checkbox in its Model block. The inline height is declared after
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

**A click on the SPA's chrome hands the canvas the focus.** bpmn-js, the DMN DRD and the Miragon
renderers hear their keys only while their canvas has the focus. A toolbar control that kept the
focus after a click (Chromium), or the page that kept it (Safari, where a clicked button takes
none), took Delete, the arrows and ⌘Z away from the canvas, so the SPA hands the canvas the focus
back after a click, without waiting for the button to hold it, as the widget does
after a zoom click (guide §5.8, `src/lib/canvas-focus.ts`): a click on the view switch's Diagram
side focuses the canvas once it shows, and so does a click on a Model action of the ⋯ menu that
opens no dialog (no renderer ships one yet) or on BPMN's Workshop switch in the toolbar, which
changes the canvas for every participant. Enter and Space keep the focus on the switch; on a
menu entry they, like Escape, give it to the menu's trigger (§5.4). The ⋯ menu is not modal: a
click on the canvas closes it and acts there, so after a toggle that keeps the menu open (Type
captions, Legend) that one click gives the canvas the focus. `test/canvas-focus.test.ts` holds the
rules, `test/canvas-focus-dom.test.ts` runs them on each real canvas, also clicking as Safari does,
and `test/toolbar-focus-dom.test.ts` renders the toolbar with React under jsdom
(`test/component-dom.ts` loads its `.tsx`): the menu stays non-modal, and its entries and the view
switch tell a click from Enter. `test/canvas-focus-chromium.ts` runs the built SPA by hand (its
header says how), in Chromium and with `BROWSER=webkit` in WebKit, clicking as Safari does; the
live editor's few lines that pass the view switch's choice to the canvas run only there. The
other toolbar buttons (the panel toggles, Add todo) hand nothing back, as the guide lists none: after a
click on one the focus is on the button or on the page, and Delete and ⌘Z reach the canvas again once
a click on it has the focus.

**The live editor holds no keys from its canvas.** Every renderer acts only on a key aimed at its
own focused canvas, so a key typed in the source view, a dialog or on the toolbar reaches no
canvas, also while it stays mounted behind them (`test/canvas-keys-dom.test.ts` holds each Miragon
renderer to that). The canvas layer is also `inert` behind the source view and behind a dialog
(`canvasInert` in `lib/editor-view.ts`): the dialogs do not keep the focus inside them, and a Tab out
of one would otherwise land on the canvas behind it, where a renderer acts on Delete and ⌘Z.
`test/canvas-focus-chromium.ts` presses Tab and the canvas keys under the Release and Rename
dialogs in both engines. The zoom keys of the SPA's Miragon editors act on the whole page, so they
check what is on screen themselves: behind the source view (`EditorContext.visibility`), in a text
field and under a modal dialog (the SPA's dialogs are `aria-modal`, `test/dialogs-modal-dom.test.ts`)
the browser zooms the page.

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

**PNG exports in Geist.** Export as PNG draws the renderer's standalone SVG as an image
(`lib/export-image.ts`, the same for every Miragon renderer, in the SPA and in the widget) on
the design guide's light export ground (§10.7): the plot's white under a Wardley map, the canvas
grey under the others. An SVG drawn as an image cannot reach the page's fonts. So before it is
drawn, `lib/export-font.ts` puts the page's own `'Geist Variable'` faces into the SVG's `<style>`,
their files inline: the subsets whose `unicode-range` holds a character of the diagram's text
(the SPA has latin, latin-ext, cyrillic, cyrillic-ext and vietnamese; the widget only latin and
latin-ext, so other scripts stay in the system sans there, as on its canvas). Each face also
gets a hidden text up front, set in a character that only this face draws: without it,
Chromium calls the SVG image loaded while a subset that only a later character of a label
needs is still loading, and that text comes out in the system sans. The image loads as a
data: URL, which an MCP host's CSP allows where it refuses blob: (the reason Wardley no
longer uses its package's own `svgToPng`), and the data: fonts inside it load although the
host's `font-src` blocks the widget's own (checked in Chromium and WebKit). A page without
Geist still exports, in the system sans, with a console warning.
The SVG download embeds no font: it shows Geist where the font is installed (guide §4).
`test/png-export-font-chromium.ts` checks it in the built app, from the SPA's menu and from
each widget under the MCP Apps default CSP: the PNG's label must be as wide as in Geist (the
labels hold figures, where Geist and the system sans differ most) and the whole PNG must be
the check's own drawing in Geist, a latin-ext text included. After a renderer, fontsource or
browser update, from the repository root: `pnpm build`, then
`npx -y -p playwright@1.56.1 -c "node apps/web/test/png-export-font-chromium.ts"` (`PORT` sets
the Live Host's port, 8393 unless set; `BROWSER=webkit` runs it in WebKit, after
`npx -y playwright@1.56.1 install webkit`).

**A gesture holds the live re-imports back.** Every live binding, the SPA's editors and
the widget engines alike, passes live-client the element it mounts the canvas in: while a
pointer is held on it or a diagram-js drag that carries elements runs in it, a peer's
change waits, for 10 s at most (sync rule 3 in `docs/platform-concept.md`, #295). An
armed palette tool (hand, space, lasso) holds nothing back. The drop then merges with the
held change line by line (sync rule 2, #309), also where bpmn-js writes a moved or new
shape's DI last, across the DI a peer moved, and where Wardley and Event Storming list a
new element right after the one a peer moved. A drop that changes the same lines (two
moves of one element), or whose merge would fail the notation's gate (well-formed XML for
BPMN and DMN, a text that is not blank for the Miragon notations), gives way to the peer's
change, with the conflict toast.
`test/live-gesture.test.ts` covers every mount under jsdom, with diagram-js's dragging run
without a pointer. Pointer drags in a browser are checked by hand, as CI has no browser:
`test/live-gesture-chromium.ts` starts a Live Host of its own and drags, creates and arms
palette tools in two SPA pages per notation (bpmn-js, the DMN DRD and every Miragon
renderer) while the other page drops a move, and requires both edits kept also where their
changes in the text run into each other. After a renderer, diagram-js or live-client
change, from the repository root: `pnpm build`, then
`npx -y -p playwright@1.56.1 -c "node apps/web/test/live-gesture-chromium.ts"` (`PORT` sets
the Live Host's port, 8392 unless set).

**One engine per bundle.** The iframe sandbox allows no external requests, so
nothing is shared between the emitted files — and exactly one engine per file is
also the widgets' whole CSS scoping: the SPA's postcss vendor-CSS scoping is
deliberately absent here. Never bundle two engines (or bpmn-js next to a Miragon
sheet) into one widget.

**Read-only hosts** (`LIVE_MCP_READONLY=1` on the Live Host) mount each engine's
viewer (a Miragon spec's `createViewer`; the menu disables the renderer's
entries that write the document, Type captions and the exports stay). No
viewer needs a command stack
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
   package's `createCollaborativeModeler`/`createCollaborativeViewer` with the
   contract's factory options (`contractOptions` in `spec.ts`: the free area
   and `fitOnImport`, plus `undoRedoKeys` for the editor), the names every
   renderer on `@miragon/modeler-api` 1.2 or later takes. The spec names no
   box to fit: both hosts fit to the renderer's own `contentBounds()`
   (contract 1.3) where it has one.
   Optional: `title` (the document's title, the menu header's display name),
   `menu` (the package's own menu content, its dialogs built with the
   helpers in `menu-content.ts` inside the mount's host, its exports with
   `imageExports` and `textExport` there, its PNG drawn by
   `lib/export-image.ts`, not a rasterizer of the package's own) and, with
   `hasLegend`, `legend` (the rows of the Legend panel both hosts show).
   Then its line in
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

The Miragon renderers take `diagram-js`, `didi` and `tiny-svg` (most of them
`zod` too) as peers, so a renderer draws with the copy apps/web brings:
apps/web declares each peer of its Miragon packages as an exact dependency
instead of leaving it to pnpm's `autoInstallPeers`, didi and tiny-svg at the
versions diagram-js itself depends on. A second copy in the bundle only fails
at runtime (a second didi breaks diagram-js's injector).
`test/shared-runtimes.test.ts` reads the lockfile and fails on a peer apps/web
does not pin, and on a second copy of a peer or of `@miragon/modeler-api` in
anything apps/web ships. didi and tiny-svg are checked where the renderers and
the diagram-js they draw with reach them: a library outside that may bring its
own copy, as dmn-js 18 does with an injector of its own on didi 12. So what
shares one of these moves in one PR: diagram-js with the bpmn-js and dmn-js
releases on it, didi and tiny-svg with diagram-js, and a contract move with
every renderer (#300). Dependabot takes the minors of diagram-js, didi and
tiny-svg in its weekly group next to bpmn-js and dmn-js, their majors in one
PR of their own, and holds didi 12 back until the ignore entry is dropped for
a diagram-js release on didi 12.

### Mixed deployments

The widgets and the Live Host ship in one image. A web dist newer than a
pre-#160 Live Host has no `get_model_content` and fails its first load with
"Tool get_model_content not found" — there is no fallback on purpose.
