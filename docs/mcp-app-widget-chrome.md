# MCP-App widget chrome

The design of the chrome around the MCP-App widgets — the modelers Claude and ChatGPT embed
(`mcp-app.html` = bpmn, `mcp-app-dmn.html` = dmn, `mcp-app-miragon.html` = wardley, team
topology, event storming and context map). The widget sources cite it as `spec §n`.

Status: phase 1 implemented (`apps/web/src/mcp-app/`); the phase-2 items are listed in §14.
It applies the Miragon modeler design system (§5 corners, §6 shape, §7 motion, §8 components,
§9 feedback, §11 Lucide, §12 a11y) and its anti-slop list: UI copy is English, there is one
light mode, and colours come from the token aliases only (`packages/ui-kit/src/tokens.css`).
The design was chosen from three independent proposals by three reviewers and refined with the
runners-up's ideas; the measurements quoted below come from the built widgets in Chrome.
---

## 1. Principles

1. **Frameless canvas.** The 39px toolbar row, the full-width banner row and the 25px status line are gone. The whole iframe is canvas. Chrome floats in corner clusters, 12px from the edge inline and 16px in fullscreen, plus `hostContext.safeAreaInsets`.
2. **One home per kind of information.**
   - Identity and less frequent moves: the **menu** (top-left).
   - The work and the hand-off: **top-right**, with "Open in designIQ" as the only blue fill at rest.
   - Lasting save and sync state: the **sync pill** (bottom-left; a button, its popover holds the detail).
   - Events: **toasts** (bottom-centre).
   - Choices the user owes: **decision cards** (bottom-centre, until answered or deferred).
   - Dead ends: **state cards** (centred, work chrome hidden).
   - Test verdicts: the **Checks toggle**, never the save state. Last-writer-wins is gone.
3. **Nothing resizes the iframe after connect.** Cards, toasts and panels float. The inline height is declared once (§2.6).
4. **SPA parity where it matters.**
   - Names: Checks with ShieldCheck, Add todo with ListPlus, Try a scenario, Test cases, Live and Connecting….
   - The ModeAction chip-switch for Workshop.
   - The left-column bpmn-js palette.
   - The CountChip turns primary while its panel is open.
   - Undo/redo by keyboard.
5. **Never silent.** Every failure has a surface, a cause and a next step (§9). Colour is never the only signal: dot, icon and words always come together.

---

## 2. Layout

### 2.1 Metrics and layers

| Token (layout calculator) | Inline              | Fullscreen              | Notes                                                                                               |
| ------------------------- | ------------------- | ----------------------- | --------------------------------------------------------------------------------------------------- |
| `I` inset                 | 12 + safe area      | 16 + safe area          | per side                                                                                            |
| corner control height     | 36                  | 36                      | radius md 12, weight 600, shadow-1                                                                  |
| under-row top `U`         | I + 44 → 56         | 60                      | left palette, panels, Miragon tier-2 palette                                                        |
| bottom row height         | 32                  | 32                      | pill, zoom group                                                                                    |
| lane bottom `L`           | I + 44 → 56         | 60                      | toasts, decision cards, panel bottom edge                                                           |
| lane max height           | H − L − U → H − 112 | H − 120                 | never up to the corner row; over an open sheet, less its head + 8 (§5.1, §7)                        |
| min gap TL ↔ TR           | 16                  | 16                      | the degrade trigger (§2.3)                                                                          |
| panel width               | 320                 | 360 (also inline ≥ 960) | card; full-width sheet when compact, or when a card would leave the lane under 300px of canvas (§7) |

Z-layers (CI §5):

| Layer                          | z   |
| ------------------------------ | --- |
| canvas                         | 0   |
| renderer palette / context pad | 20  |
| corner clusters, panels        | 30  |
| menus, popovers                | 40  |
| state cards                    | 50  |
| decision cards, toasts         | 60  |

The bpmn.io watermark keeps its native spot (bottom 15, right 15, 53×22). It is never covered, moved or dimmed. Licence rule: the render script asserts it.

### 2.2 Corners per widget kind

| Slot                  | bpmn                                                                                          | dmn                                                                                                               | Miragon (wardley / team topology / event storming / context map)                              |
| --------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| TL                    | menu trigger `[menu \| comet \| name]`, compact: + **Tools**, Workshop chip-switch (editable) | menu trigger, segmented view switch `[DRD \| Table]` (labels; replaces dmn-js "View DRD")                         | menu trigger; compact: + **Tools**                                                            |
| TC                    | — (palette is the left column)                                                                | —                                                                                                                 | renderer palette: tier 1 (in the top row) if it fits between TL and TR, else tier 2 (top `U`) |
| TR (right-anchored)   | `[Todos (count)]` `[fullscreen]` `[Open in designIQ]`                                         | `[Checks (verdict)]` `[fullscreen]` `[Open in designIQ]`                                                          | `[Todos (count)]`, context map: `[Legend]`; then `[fullscreen]` `[Open in designIQ]`          |
| Left column (top `U`) | bpmn-js palette, its own one- or two-column switch (SPA parity); compact: closed behind Tools | DRD view: DRD palette; definitions card offset to `left: I+48+8, top: U`                                          | —                                                                                             |
| R (top `U`)           | Todos card                                                                                    | Checks card. DRD view: the add-on's "Simulate DRD" card sits at `top: U, right: I` and hides while Checks is open | Todos card; context map: Legend card (§7.3)                                                   |
| BL                    | sync pill                                                                                     | sync pill                                                                                                         | sync pill                                                                                     |
| BR                    | zoom group `[− \| 56% \| + \| fit]` at `right: 80` (beside the watermark)                     | DRD view: zoom group beside the watermark; table view: none (the HTML table scrolls)                              | zoom group at `right: I` (no watermark)                                                       |
| BC lane               | toasts, decision cards                                                                        | same                                                                                                              | same                                                                                          |

Right-anchoring the TR cluster means a late Todos or Checks toggle grows leftwards and moves nothing. Discovery now runs in parallel with the load (§6.3), so this is rare.

The §5 bottom-left "legal/operator links" do not apply inside a chat iframe. That corner holds the pill.

**Deliberate SPA difference.** The SPA shows connection state beside the title. The widget shows it bottom-left: at 480px the top row has no room, and the pill doubles as the save-state and findings surface. Pill vocabulary and titles match the SPA's `ConnectionState`:

- "Live", with title "Live — every edit syncs to everyone in this document".
- "Connecting…".

### 2.3 Measured degrade (no fixed breakpoints for labels)

`core/layout.ts` measures the TL and TR cluster widths at each degrade step. A ResizeObserver on `#app` re-measures on resize and when fonts load. The calculator applies the **first step at which `TL + TR + 16 ≤ W − 2I`**. Steps are cumulative:

| Step | Change                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | everything labelled                                                                                                                       |
| 1    | the comet in the trigger hides (decorative; the app icon stays in the menu header)                                                        |
| 2    | "Open in designIQ" → **"Open"** (icon + short label; the full name stays in `aria-label`/`title`)                                         |
| 3    | Workshop chip → compact chip (sticky-note + track) **while ON**; menu-only while OFF. The DMN switch → icons, with `aria-label` + tooltip |
| 4    | panel toggle drops its label (icon + count/verdict; `aria-label` "Todos, 3 open" / "Checks, 7 of 7 pass")                                 |
| 5    | "Open" → icon-only blue button (`aria-label` "Open in designIQ (new tab)", tooltip)                                                       |
| 6    | the name truncates against the **actual** remaining width (minimum 72px; full name in `title`, `aria-label` and menu header)              |
| 7    | (phone widths, review fix) the Workshop chip — even ON — and the DMN view switch leave the row: menu-only                                 |
| 8    | the fullscreen button leaves the row: menu-only                                                                                           |
| 9    | the trigger is the menu icon alone (the name stays in `aria-label`, `title` and the menu header)                                          |

Measured on the built widgets (cluster widths in px):

| Frame    | Result                                               |
| -------- | ---------------------------------------------------- |
| 720 bpmn | step 0 (TL 304, TR 315, gap 77)                      |
| 720 dmn  | step 2 (TL 318, TR 281, gap 97)                      |
| 650 bpmn | step 1                                               |
| 600 bpmn | step 2                                               |
| 480 bpmn | compact + step 5 (TL 257 with Tools, TR 148, gap 51) |

### 2.4 Compact mode

**Compact = `width < 600` OR `height < 440` OR `displayMode === "pip"`.** In compact mode:

| Element                | Compact behaviour                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer palette       | Closed behind a **Tools** icon button (Lucide `shapes`) right after the menu trigger, via diagram-js `palette.open()`/`close()`. `aria-expanded`, `aria-controls`. Opens at its slot (bpmn/DRD: left column; Miragon: centred under the row, `max-width: calc(100% − 2I)`). Stays open while modelling; closes on Tools, Escape or a panel opening. A click on Tools hands the keyboard focus to the canvas (§2.5). |
| Panels                 | Full-width **sheets** (`left/right: I`, `top: U`, `bottom: L` + what the lane holds — §7). Anchor-chip clicks and case replays collapse the sheet first, then reveal the element or rule. The toggle reopens at the same scroll position.                                                                                                                                                                           |
| Zoom group             | Hides the % readout.                                                                                                                                                                                                                                                                                                                                                                                                |
| Toasts, decision cards | `calc(100% − 2I)` wide.                                                                                                                                                                                                                                                                                                                                                                                             |

Not compact: the palette is always visible at its slot and is included in the fit insets.

### 2.5 Fit and zoom

**`fitInto(instance, insets)`** replaces the import-time `fit-viewport`. It is pure math from `@miragon/modeler-shell/core`, the view math the Miragon modelers' own shell runs: `fitViewbox` (content bbox → viewbox, never above 100 %), `sameView` with `VIEW_TOLERANCE` for "untouched", `interpolateViewbox` and `easeStandard` for the animated re-fit, `zoomReadout` for the readout, `ZOOM_MIN` / `ZOOM_MAX` (20 % / 400 %) and `FIT_ANIMATION_MS` (250). The widget keeps its own geometry (the insets below, not the shell's `fitInsets`). The −/+ buttons and the zoom keys step on the guide's fixed zoom steps (§5.8), the raster of diagram-js's `zoomScroll.stepZoom` that the shell's zoom panel walks too; the shell keeps that function private, so `zoomStepLevel` in `engines/fit.ts` computes it. For a Miragon renderer the content bbox is the box its `contentBounds()` reports (`@miragon/modeler-api` contract 1.3, feature-detected in `engines/miragon.ts` `miragonView`, which the SPA's editors use too, for ⇧1 and for the first view, with the renderer's own import fit turned off): Wardley's plot with its axes and everything drawn on or beyond it, the box its pan constraint keeps in the free area; an Event Storming board's arrow annotations and a hotspot's tilt; a team or context name wider than its shape. For a renderer without the method, one with nothing to fit, and bpmn-js and dmn-js it is diagram-js's box around the elements.

Insets:

| Side   | Value                                                                                    |
| ------ | ---------------------------------------------------------------------------------------- |
| top    | `I + 36 + 12` (60 / 64), + the tier-2 Miragon palette height + 8 when shown              |
| left   | `I + paletteWidth + 16` when the left-column palette is visible (bpmn 720: 122), else 16 |
| right  | 16, or `panelWidth + I + 12` while a card (Todos, Checks, Legend) is open                |
| bottom | `I + 32 + 12` (56 / 60)                                                                  |

Measured on the built widgets: order-to-cash fits at 0.56 at 720x520 (left palette open, width-limited), 0.43 at 480x480 (compact), 0.77 at 1280x760 with the Todos card open, and the storm board at 0.40 under the tier-2 palette. Nothing sits under the palette, the clusters or the card.

**Auto-fit until touched.** The widget remembers the last fitted viewbox. Any `canvas.viewbox.changed` not caused by a fit marks the view "touched".

| Trigger                            | Re-fit?                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| import (including live re-imports) | only when untouched                                                                 |
| resize                             | only when untouched                                                                 |
| panel open/close                   | only when untouched                                                                 |
| display-mode change                | **always**, and resets touched (fixes "inline zoom in the corner after fullscreen") |
| Fit button / ⇧1                    | always, and resets touched                                                          |

The re-fit animates the viewbox over 250ms with `--cd-ease` (rAF interpolation: the scale moves in log space, the centre in a line). Under `prefers-reduced-motion` it jumps.

No re-fit runs while someone types a label on the canvas (a text field in it has the focus). bpmn-js and dmn-js save an open label editor when the viewbox changes, so a re-fit after a peer's re-import or a resize would save the name typed so far. The Miragon renderers keep the editor open with what was typed across a view change (modeler-api contract 1.2, law L5); in their widgets the rule only keeps the field from moving while someone types.

Zoom group (BR), 28px targets:

| Control | Accessible name                        | Action                                                          |
| ------- | -------------------------------------- | --------------------------------------------------------------- |
| −       | "Zoom out"                             | `stepZoom(−1)`: one fixed step down around the viewport centre  |
| %       | "Zoom to 100% (now 56%)"               | `zoom(1)` around the centre; the readout tracks `canvas.zoom()` |
| +       | "Zoom in"                              | `stepZoom(+1)`: one fixed step up                               |
| fit     | Lucide `scan`, "Fit diagram (Shift+1)" | fit, resets touched                                             |

The steps are 22, 30, 41, 55, 74, 100, 135, 182, 246 and 331 %, within 20 and 400 %, and a step starts from the nearest one: from 95 % after a fit + goes to 135 % and − to 74 %, from the wheel's half step 86 % + goes to 135 %. The limits are no steps: from 20 % + goes to 30 %, from 400 % − to 331 %. A step goes only the way it points: a large diagram fits below 20 %, and from there the − button, and in the Miragon widgets the zoom-out key, does nothing, where clamping to 20 % would zoom in (guide §5.8, the shell's `canZoomOut` / `canZoomIn`); + goes to the next step, at least to 20 % (from 8 % to 20 %, from 18 % to 22 %), and at 400 % + does nothing. The zoom-out key of the bpmn and dmn widgets is bpmn-js's and dmn-js's own and does not hold to this (below).

In the Miragon widgets, which bind the zoom keys (below), each button names its key in the tooltip and as `aria-keyshortcuts`, in the modeler shell's words for the keyboard at hand (`shortcutLabel`, `ariaKeyShortcuts`, guide §5.6): "Zoom out (⌘−)" `Meta+-`, "Zoom to 100% (⌘0)" `Meta+0`, "Zoom in (⌘+)" `Meta+= Meta+Plus`, and the fit button is "Fit to view (⇧1)" `Shift+1`; elsewhere "Ctrl+Minus", "Ctrl+0", "Ctrl+Plus", "Shift+1" and `Control`. The bpmn and dmn widgets keep the names in the table.

**Focus after a click.** A pointer click on a zoom control or on Tools hands the keyboard focus back to the canvas (`view.focus()`, diagram-js `canvas.focus()`), in every diagram-js widget (bpmn and the DMN DRD view too). The Miragon renderers act on keys only while their canvas or the page has the focus, so Delete or ⌘Z right after a zoom click would otherwise do nothing. Enter or Space on the button keeps the focus there. The menu trigger, fullscreen and the pill keep the focus: what they open takes it.

Keyboard zoom differs by renderer. bpmn-js and dmn-js bind Ctrl/⌘ + `+`, `-` and `0` to their own canvas (the diagram-js 15 keyboard, while the canvas has the focus, through `zoomScroll.stepZoom`), and their widgets leave those keys to it; their −/+ buttons take the same steps, with one difference: `zoomScroll.stepZoom` clamps, so from a fit below 20 % their ⌘− / Ctrl+− zooms in to 20 % against guide §5.8, while the − button keeps the fit. Routing their `stepZoom` editor action through `view.stepZoom` would close that gap; it is an open follow-up. The Miragon renderers bind no zoom keys, so the Miragon widgets take them, and ⇧1, from the modeler shell's keymap (`matchChromeKey` and `decideKey` for an embedded modeler, `chrome/keys.ts`): ⌘ or Ctrl + `+` / `=` (also with ⇧ and on the numpad) zooms in one step, `-` / `_` out, `0` sets 100 %, ⇧1 fits. They act on the whole widget document, and they leave the key alone (the browser zooms the page, ⇧1 types "!") during an IME composition, in a text field (a label editor, a dialog's field), while a modal dialog is open and while no diagram is on screen (a state card). A popover such as Map size… and the open menu keep them working. Each press acts once and is prevented. The SPA's Miragon editors take the same keys (§3, `lib/chrome-keys.ts`).

Undo/redo:

- Keyboard only (⌘Z / ⇧⌘Z: the diagram-js keyboard in bpmn and the DMN DRD view, the renderer's own listener in the Miragon widgets), like the SPA.
- On touch-only devices (`deviceCapabilities.touch && !hover`) the BR group prepends `[undo-2][redo-2]`, disabled per `commandStack.canUndo/canRedo`.
- Never in the menu.

### 2.6 Host context, display modes, size

- `new App(info, { availableDisplayModes: ["inline", "fullscreen"] }, { autoResize: false })`.
- Read `getHostContext()` after connect. Merge `onhostcontextchanged` updates: `displayMode`, `availableDisplayModes`, `containerDimensions`, `safeAreaInsets`, `deviceCapabilities`, `platform`, `locale`, `timeZone`.
- Ignore `theme` and `styles` (one light mode).
- **Fullscreen control:**
  - Shown only when `availableDisplayModes` includes `"fullscreen"`, a model is loaded and the instance is not superseded.
  - Label and icon follow `displayMode`: "Open fullscreen" (`maximize-2`) or "Exit fullscreen" (`minimize-2`).
  - `requestDisplayMode` resolves with the mode actually set, and that mode is what counts.
  - A mode change re-runs the layout (inset 12↔16, panel 320↔360, Miragon tier 2↔1) and forces a fit.
- **Inline height:** sent **once** after connect with `sendSizeChanged({ height })`.
  - 480 when `W ≥ 600`, 420 below, capped by `containerDimensions.maxHeight`.
  - Not sent when the host fixes `containerDimensions.height`, nor in fullscreen.
  - Re-sent only when the width class flips (a host resize across 600) and on the return to inline.
  - Never on state changes. This replaces today's content-driven 384px and the banner layout jump.
  - Content-adaptive height is an open question.
- **Teardown:** `app.onteardown = () => lc.flushNow()`. It flushes a pending autosave when `dirty && !live && !paused`, then returns `{}`.

---

## 3. The document menu (top-left)

**Trigger.** A 36px floating button containing:

- Lucide `menu`.
- A 1px separator, then the comet (8px tall, `aria-hidden`, hidden from degrade step 1).
- The model name: the file stem (process or decision id), Geist 600 13px, truncating last.

Attributes: `aria-haspopup="menu"`, `aria-expanded`, `aria-controls="menu"`, `aria-label="Menu — <name>"`, `title="<owner/repo> · <path>"`.

The name is known from the **tool input** (`id`, or the stem of `path`) at load start, so no title ever reads "Loading…".

**Dropdown.**

- Box: `top: U`, `left: I`, 288 wide, popover surface, radius md, shadow-3, 6px inset. Items 32px, radius sm, hover and focus `--accent`, active text `--link`.
- Pop-in: 150ms `--cd-ease-out`, 4px rise.
- Empty groups and their separators collapse.

Header (`role="presentation"`, selectable text; the one place the full identity is shown):

- Official app icon, 32px.
- Name (600 14px).
- `<display name> · <notation label>`, for example "Order to Cash · BPMN 2.0". The display name comes from the engine capability `displayName()` (bpmn: process or participant name; dmn: definitions name; Miragon: the document's title, through the spec's `title`). Without one the line shows only the label.
- `owner/repo` (muted).
- Path (Geist Mono 11, wraps).

| #   | Item                                               | Icon                         | Shown when                                                                                    | Behaviour                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Open in designIQ                                   | external-link                | deep link known (`linkTarget() && publicUrl`)                                                 | today's handler: `openLink` first, `flushOnLeave` in parallel                                                                                                                                                                                                                                     |
| 2   | Save now `⌘S`                                      | save                         | editable, autosave mode, not superseded                                                       | `lc.save()` + a success toast "Saved". Disabled with hint "All changes saved" when clean, and while saving or paused                                                                                                                                                                              |
| 3   | Reload latest version                              | refresh-cw                   | not live (autosave, read-only, after a failure); disabled "Saving…" while a save is in flight | `lc.reload()` (waits for a save in flight). With unsaved edits it first expands **inline in the menu**: "Discard your unsaved change?" `[Cancel]` `[Discard and reload]` (danger) — CI §9 destructive confirm                                                                                     |
| —   |                                                    |                              |                                                                                               |                                                                                                                                                                                                                                                                                                   |
| 4   | Workshop mode                                      | sticky-note                  | bpmn editable                                                                                 | `menuitemcheckbox` + trailing switch; Space/Enter toggles without closing; same `tbpmToggleAction` as the chip                                                                                                                                                                                    |
| 5   | Todos (count)                                      | list-todo                    | bpmn and Miragon, tracker answered                                                            | `menuitemcheckbox`, checked while open                                                                                                                                                                                                                                                            |
| 5′  | Checks (verdict)                                   | shield-check                 | dmn, tests tool present                                                                       | same                                                                                                                                                                                                                                                                                              |
| 6   | View: Decision table / Decision requirements (DRD) | table-2 / network            | dmn                                                                                           | `menuitemradio`. Multi-decision models list each table by **decision name**                                                                                                                                                                                                                       |
| —   |                                                    |                              |                                                                                               |                                                                                                                                                                                                                                                                                                   |
| 6′  | The renderer's Model entries                       | none                         | Miragon, the renderer ships menu content                                                      | see "A renderer's own entries" below                                                                                                                                                                                                                                                              |
| 6″  | Legend                                             | —                            | context map                                                                                   | `menuitemcheckbox` with its check, checked while the Legend card is open; no icon, as the guide's Model entries (§5.14). It closes the menu and opens the card (§7.3), like Todos and Checks: the card's heading takes the focus as it opens, where the guide keeps a checkbox's menu open (§5.4) |
| —   |                                                    |                              |                                                                                               |                                                                                                                                                                                                                                                                                                   |
| 6‴  | The renderer's Export entries                      | file-image, file-code-corner | Miragon, the renderer ships menu content                                                      | Export as PNG, Export as SVG                                                                                                                                                                                                                                                                      |
| —   |                                                    |                              |                                                                                               |                                                                                                                                                                                                                                                                                                   |
| 7   | Fit diagram `⇧1` (Miragon: Fit to view `⇧1`)       | scan                         | diagram views (not the DMN table)                                                             |                                                                                                                                                                                                                                                                                                   |
| 8   | Open fullscreen / Exit fullscreen                  | maximize-2 / minimize-2      | host offers fullscreen                                                                        |                                                                                                                                                                                                                                                                                                   |
| —   |                                                    |                              |                                                                                               |                                                                                                                                                                                                                                                                                                   |
| 8′  | Keyboard shortcuts…                                | keyboard                     | Miragon, the renderer ships menu content                                                      | the renderer's dialog: a table per group, the keys as chips (Geist Mono, the widget carries it)                                                                                                                                                                                                   |
| —   | _(phase 2)_                                        |                              |                                                                                               |                                                                                                                                                                                                                                                                                                   |
| 9   | Release → PR…                                      | git-pull-request             | editable and `getHostCapabilities().message`                                                  | sends `ui/message` "Open the release pull request for `<path>` in `<repo>`" (same mechanism as Implement); sub-line "Asks the assistant in this chat"                                                                                                                                             |

**A renderer's own entries.** The Miragon renderers ship their menu content typed for the modeler shell's menu, and the widget takes it as it is (`core/menu-model.ts`, `modeler:` items run back by `runModelerItem`): its Model group, its Export group and its Help group join designIQ's groups in the guide's order (§5.4: Model, Export, then designIQ's view moves, Help last).

| Renderer                        | Model                                                                       | Export                       | Help                |
| ------------------------------- | --------------------------------------------------------------------------- | ---------------------------- | ------------------- |
| Wardley (`mapMenu`)             | Map title…, Map size… and X-axis labels… (popovers at the dropdown's place) | Export as PNG, Export as SVG | Keyboard shortcuts… |
| Event Storming (`boardMenu`)    | the radio group "Level" under its heading, the checkbox "Type captions"     | Export as PNG, Export as SVG | Keyboard shortcuts… |
| Context Maps (`contextMapMenu`) | Map title… (`createTitleDialog`, one undoable `cmModeling.setTitle`)        | Export as PNG, Export as SVG | Keyboard shortcuts… |
| Team Topologies 0.12            | none: the package ships no menu content                                     |                              |                     |

- Every entry that writes the document is one undoable step, and a read-only viewer shows it disabled with the hint "Read-only" (guide §13.5). Type captions is a view preference: usable read-only, and the next board on the page keeps the choice.
- A radio or checkbox entry toggles and keeps the menu open. A dialog entry (`aria-haspopup="dialog"`) closes the menu, leaves the focus on the trigger, then opens; its dialog or popover gives the focus back to the trigger when it closes.
- The dialogs and popovers live inside the mount's host in `#canvas`, so they go with the mount, and the scoped dev server styles them like the SPA does. A Wardley popover opens at the dropdown's place (`top: U`, `left: I`) and ends where the toast lane does, above the bottom row (`--lane-bottom`): the canvas lies under the corner clusters, so the pill and the zoom group would otherwise paint over its last fields. An open modal dialog keeps the zoom keys and Escape; a popover keeps neither.
- A web link inside the canvas (X-axis labels…' "Learn Wardley Mapping") opens a new window the sandbox blocks, and one without a target would replace the widget: every web link clicked in a Miragon widget's canvas goes through `openExternal` instead (`chrome/links.ts`), and a host that refuses it gets the "Your client blocked the link" toast, as Open in designIQ does.
- Exports hand the file to the host (`ui/download-file`, the capability `downloadFile`): the SVG as text, the PNG (2×, on the plot's white) as base64, named after the model's file. Without the capability, when the host declines, or when the image cannot be built, a toast says so. The map file itself (`.owm`, `.storm`, the Context Map JSON) is no export, it is the model, and no package writes Context Mapper's CML: designIQ leaves those entries out.
- Entries without an icon in the guide keep the icon column, so the labels line up; an unchecked check keeps its room.

Variants:

- **Read-only:** 1, 3, 5/5′ (read-only panels), 6, 6′ (disabled but Type captions), 6″, 6‴, 7, 8, 8′.
- **Superseded:** 1 only. Everything else is removed, not disabled, because the instance is a viewer now.
- **Load failed:** the trigger is hidden (the state card owns the screen).

Not in the menu, on purpose:

- Undo/Redo (keyboard, like the SPA).
- Rename…, Duplicate…, History, Notes, Diagram|Source. These are web-app moves one click away through Open in designIQ. Monaco would bloat a bundle that every chat re-downloads.

Keyboard (WAI-ARIA menu button):

- Enter, Space or ↓ opens the menu with focus on the first enabled item. ↑ opens it on the last.
- ↑/↓ wrap, Home/End jump, first-letter type-ahead.
- Enter/Space activates. A checkbox item toggles and stays open.
- Escape closes and returns focus to the trigger. Tab closes and moves on. A click outside closes.

---

## 4. Sync pill and popover (bottom-left)

The pill is **always a button** (`aria-haspopup="dialog"`, `aria-expanded`; `aria-label` = label + " — show sync details"). It is **not** `role=status`. A separate visually hidden polite region `#announce` speaks **class changes only**:

| Class    | States                       | Announced                                                                                                                           |
| -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ok       | saved, live, connecting      | yes                                                                                                                                 |
| pending  | unsaved, saving              | never (no Saving→Saved chatter)                                                                                                     |
| problem  | failed, paused, reconnecting | reconnecting yes; `failed` and `paused` no — their danger toast / decision card speaks (one surface per transition, §8; review fix) |
| inactive | inactive                     | no — the superseded card speaks (review fix)                                                                                        |
| readonly | readonly                     | yes                                                                                                                                 |

The pill is hidden while a state card owns the widget.

| `SyncState.kind`   | Pill                                                                               | Tone    | Popover sentence (from `core/sync-view.ts`)                                                                            |
| ------------------ | ---------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `connecting`       | spinner "Connecting…"                                                              | neutral | "Opening a live session for this model."                                                                               |
| `live`             | `--success` dot "Live" + avatars (max 3 + "+N"; fullscreen adds "· N others here") | neutral | "Live — every edit syncs to everyone in this document." Then "Here now: Anna Berg, Tom Kraus, Claude for Dominik Horn" |
| `reconnecting`     | spinner "Reconnecting…"                                                            | warning | "Live sync lost — reconnecting…" (lifecycle copy)                                                                      |
| `saved`            | check (`--success`) "Saved"                                                        | neutral | Autosave note (below) + "Saved 14:02"                                                                                  |
| `saved` + warnings | triangle-alert "Saved · 1 warning"                                                 | warning | Note + time + **every finding as a row** + "Warnings never block a save. The assistant in this chat sees them too."    |
| `saved` + errors   | circle-alert "Saved · 2 errors"                                                    | danger  | Note + time + findings. The save still landed (`lint:"warn"`)                                                          |
| `unsaved`          | `--primary` dot "Unsaved changes"                                                  | neutral | Note                                                                                                                   |
| `saving`           | spinner "Saving…"                                                                  | neutral | Note                                                                                                                   |
| `failed`           | group of two buttons `[● Not saved][Retry]`                                        | danger  | Lifecycle sentence ("Autosave failed: <msg> — retrying automatically") + the next retry time                           |
| `paused`           | `--warning` dot "Autosave paused"                                                  | warning | Click **reopens the decision card** instead of a popover                                                               |
| `readonly`         | eye "Read-only"                                                                    | neutral | "This chat opened the model read-only. Open it in designIQ to edit."                                                   |
| `inactive`         | circle-dashed "Inactive"                                                           | muted   | "A newer widget in this chat owns this model. This copy no longer saves."                                              |

Popover content:

- **Autosave note**, picked by why the widget is not live:
  - bpmn/Miragon with the upgrade failed: "Changes save automatically 1.5 s after your last edit. Live co-editing is not available in this chat client — each save lands in the shared document."
  - dmn: "Changes save automatically 1.5 s after your last edit. A collision with someone else's save asks you before anything is overwritten."
- **Activity line:** the latest `setStatus` text, shown only when it differs from the pill label. Example: "Editing on — autosave will overwrite their version". This keeps today's lifecycle copy (and its ~30 test asserts) as the detail text.
- **Footer actions:**
  - `[Save now ⌘S]` in editable autosave mode. Disabled when clean, with hint "All changes saved" and title "Nothing to save".
  - `[Retry now]` when failed.
  - `[Open in designIQ]` for read-only and inactive.
- The time uses `Intl.DateTimeFormat(hostContext.locale, { timeStyle: "short", timeZone })`.
- Geometry: popover 320 wide, `left: I`, `bottom: I + 40`, radius md, shadow-3, `role="dialog"`, `aria-labelledby`. Focus moves to its heading; Escape and outside-click close it and return focus to the pill.

Avatars:

- Each avatar paints the **peer's presence colour** via `safePresenceColor(user.color)`, exactly like the SPA `PeerAvatar` and the canvas cursors. No chrome colour, no new alias.
- Agents (`kind === "agent"`) show Lucide `message-square-text` on their colour.
- Names live in `title` and in the popover.

---

## 5. Feedback surfaces

### 5.1 Toasts (bottom-centre lane)

- Lane: `bottom: L`, width `min(460, W − 2I)`, centred between the insets; in arrival order, newest at the bottom.
- **Never over an open panel** (§7): beside an open card the lane is centred in the canvas column the card leaves (`min(460, W − 2I − panel − 12)`), and a sheet ends above it.
- **Bounded** (`core/layout.ts` `Layout.lane.max` / `.room`, `--lane-max`): the lane never reaches the corner row (`max = H − L − U`: 328 at 656x440 and 720x440), and over an open sheet never its head (`max − 58`); nothing in it covers a corner cluster. Its toasts fill at most `room` — `max`, less the sheet's 120px body while a sheet is open (§7).
- **What shows** (`core/feedback.ts` `planLane`, re-planned on every arrival and departure, when a decision card comes, goes or collapses, and when the room changes): at most **two** toasts, **one beside a decision card**, and only what fits the room (8px between entries).
- **A leaving toast holds no room.** Replaced by its key, dismissed or timed out, a toast fades OUT of the lane's flow (`.leaving`: `position: absolute`, pinned at its distance from the lane's bottom edge — `core/feedback.ts` `leavingBottom` —, under the entries that stay, `pointer-events: none`, inert), so its keyed successor never stacks on it: the lane holds what `planLane` planned and never passes `max` (720x440 beside a card: card 211 + 8 + the new 80px toast = 299 of 328, where the fading predecessor in the flow made it 387). A sheet ends above the entries in the flow only (`--lane-h`, `core/layout.ts` `laneHold`). The places go to the newest toast first (the event that just happened), then to toasts with an action, then to the rest — newest first within each, so the oldest auto-dismissing toast yields first.
- **Who yields:** an auto-dismissing toast leaves for good — its words were spoken by the live region and live on a persistent surface. A toast with an action **waits**: out of the DOM (nothing hidden to Tab to; its focus, if it had it, goes to the pill) and back in its arrival place as soon as there is room. It leaves only by ×, its action or its condition — never for lack of space. Decided against dropping it: the save-failed toast's Retry now and a refused Implement's Open #38 are the user's pending moves, and §5.1's "never auto-dismiss" would no longer hold.
- Card: surface, radius md, shadow-3. Status colour = **3px left rule + dot + words**.
- Detail line: 12px muted. Optional one action (`.pb`). × dismiss (28px, "Dismiss").
- `role="status"` for success/info/warning in one polite region, `role="alert"` for danger.

Lifetime:

- success/info: 2.8s; warning/danger: 5s.
- Timers pause on hover **and** on focus-within.
- **Toasts with an action never auto-dismiss** (WCAG 2.2.1). They close by ×, by their action, or when their condition clears (`dismissToast(key)`, for example a successful save clears "Autosave failed").
- Every toast's information also lives on a persistent surface: the pill popover, the panel, or the toggle verdict.

Motion: slide up 8px + fade, `--cd-motion-base`, `--cd-ease-out`.

### 5.2 Decision cards (CAS conflict, live interrupted, superseded)

Placement and role:

- In the lane, above the toasts, the lane's width, warning or info left rule. Same place rule as the toasts: never over an open panel — over a sheet it folds the sheet to its head until it is answered or deferred (§7).
- **Always whole and operable** (title, body, every choice, Decide later): it takes the lane's room first and never shrinks; at most **one** toast shows beside it, and only one that fits (656x440: the CAS card is 294px of a 328px lane — a 98px toast does not fit beside it; 720x440: card 211 + 8 + an 80px toast = 299 — one). The others wait or leave (§5.1) and come back when the card resolves or collapses into the pill. Only a frame too short for the card itself (its height over `Layout.lane.max`; none of 340x480 … 1280x760) lets it scroll inside (`max-height: --lane-max`; the card scrolls, never the lane, so no shadow is clipped).
- `role="alertdialog"` with `aria-labelledby` (title) and `aria-describedby` (body).
- **Non-modal:** Tab is not trapped and the canvas stays usable (autosave stays paused).

Focus:

- On show, focus moves to the primary action **only if `document.hasFocus()`**. Never steal focus from the chat composer.
- Otherwise the card is announced through `#alert`.
- On resolve, focus returns to the previously focused element in the widget, else the pill.
- **Escape never dismisses a decision card.**

Content and actions:

- **Action layout:** one row per choice — button (equal width, in the lifecycle's array order) + **consequence line**. Exactly one primary.
- **Decide later:** a 28px × (`aria-label` "Decide later — autosave stays paused"). It collapses the card into the pill (`paused`, or `inactive` for superseded). Clicking the pill reopens it.

| Card              | Title                                       | Body                                                                                                    | Choices → consequence                                                                                                                                                                                         |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CAS conflict      | "Someone saved this model in the meantime." | "Autosave is paused until you choose."                                                                  | **Load their version** (primary) → "Your last change is discarded." · **Overwrite anyway** (danger) → "Their change is replaced right away." · **Keep editing** → "Your next autosave replaces their change." |
| Live interrupted  | "Live sync was interrupted"                 | "The server copy differs from this canvas. Autosave is paused until you choose."                        | **Load server version** (primary) → "This canvas switches to the server copy and goes live again." · **Keep my canvas** (danger) → "Autosave writes this canvas over the server copy."                        |
| Superseded (info) | "This model is open in a newer widget"      | "This copy is read-only now. Keep working in the newest widget in this chat." + the flush result (§6.6) | **Open in designIQ** (secondary; no primary) · _(phase 2)_ **Continue here** → "Takes the model back into this widget and reloads it."                                                                        |

The labels, their order and `danger` are unchanged, so `bannerLabels()`/`click()` in the tests keep passing.

Measured: the conflict card fits a 480x420 frame with the top row and part of the diagram still visible.

### 5.3 State cards (centred; the work chrome is hidden — CI §8 empty state)

- Card: radius lg, shadow-3, max-width 440. Official app icon 40px, title 600 18px, one help line, an optional mono error box (`--destructive-soft`), and **at most two actions**.
- The ground is the canvas paper with a quiet `--border` dot grid (20px).
- If a previous canvas exists (re-delivery), it stays visible behind the card, inert (`inert` on `#canvas`).
- `role="alert"` for failures, `role="status"` for loading.

| State                                    | Title                                         | Help                                                                                                             | Actions                                                                                                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Booting (bridge connecting), after 400ms | "Starting the modeler…" + spinner             | —                                                                                                                | —                                                                                                                                                                                                                                  |
| Loading the model                        | "Loading order-to-cash…" + spinner            | "Reading the model from designIQ"                                                                                | —                                                                                                                                                                                                                                  |
| No tool input (8s)                       | "No model received"                           | "Your chat client did not send this widget its input. Open the connector in claude.ai or Claude Desktop."        | —                                                                                                                                                                                                                                  |
| Tool input without repo                  | "This widget was opened without a repository" | "Ask the assistant to open the model again."                                                                     | —                                                                                                                                                                                                                                  |
| Bridge connect failed                    | "Could not connect to your chat client"       | error in mono                                                                                                    | —                                                                                                                                                                                                                                  |
| Load failed: read rejected               | "Could not load order-to-cash"                | "designIQ did not return the model. Its reason is below; try again, or open the model in designIQ." + mono error | **Try again** (primary, `lc.load(lastInput)`) · **Open in designIQ** (when a link can be built: path known → file route, else the repo route)                                                                                      |
| Load failed: import rejected             | "order-to-cash could not be displayed"        | parser error in mono                                                                                             | **Ask the assistant to fix it** (primary; `ui/message` with path + parser error; only with `getHostCapabilities().message`) · **Open in designIQ**. Without the message capability: **Open in designIQ** (primary) · **Try again** |
| Miragon renderer failed to load          | "The Event Storming modeler could not start"  | error in mono                                                                                                    | **Try again** (re-runs `spec.load()`)                                                                                                                                                                                              |

A Miragon model whose text is blank lands on the import card too, with "the document is empty": the SPA's live binding refuses it the same way, and an empty canvas would write a whole new document over the file with its first edit.

### 5.4 Event → surface rules

| Event                                 | Surface                                                                                                                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autosave (success)                    | pill only (quiet)                                                                                                                                                                                                          |
| Explicit Save now (menu, ⌘S, popover) | pill + success toast "Saved" — unless the findings toast or the pill's way back from "Not saved" already says it (review fix). A clean canvas: info toast "All changes saved", no PUT                                      |
| Findings count rises                  | pill (warning/danger) + one warning toast "Saved with 1 warning" (detail: first finding)                                                                                                                                   |
| Autosave threw                        | pill `failed` + danger toast "Autosave failed" (detail `<msg>. Your edits stay on this canvas — trying again in 15 s.`, action **Retry now**, key `save-failed`). Auto-retry backoff 5s / 15s / 60s, then on the next edit |
| DMN test run, capture, replay         | Checks toggle verdict + panel + toast. **Never the pill** (asserted in `sync-view` tests)                                                                                                                                  |

---

## 6. State mapping (every inventory state → its home)

### 6.1 Boot and load

| Inventory state              | Final                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Booting / bridge connecting  | blank paper for 400ms, then the state card "Starting the modeler…". No chrome flash                           |
| Loading the model            | state card "Loading `<name from tool input>`…". Lifecycle `setSync({kind:"loading"})`                         |
| No tool input                | state card "No model received"                                                                                |
| Missing repo / bridge failed | state cards (§5.3)                                                                                            |
| Load failed (read)           | state card with Try again                                                                                     |
| Load failed (import)         | state card over the inert previous canvas. Save unreachable. The menu trigger is hidden until a load succeeds |
| Renderer failed              | state card with Try again                                                                                     |

### 6.2 Save and sync

| Inventory state            | Final                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ready, autosave mode       | pill "Saved". **No blue Save button anywhere** (DMN included): Save now is in the menu, ⌘S and the popover. The popover explains why there is no live sync                                                       |
| Read-only                  | pill "Read-only". Viewer canvas (no palette, no Tools, no undo; zoom and fit stay). No Workshop. Menu without Save and Workshop. Panels read-only with a foot line (§7)                                          |
| Live                       | pill "Live" + avatars (new roster)                                                                                                                                                                               |
| Live upgrade attempt       | pill "Connecting…" while clean. If an edit lands first: "Unsaved changes" (pending outranks connecting)                                                                                                          |
| Dirty                      | pill "Unsaved changes" (replaces the 8px dot), immediately                                                                                                                                                       |
| Saving                     | pill "Saving…"; menu and popover Save now disabled                                                                                                                                                               |
| Saved with findings        | pill "Saved · 1 warning" / "Saved · 2 errors". Popover lists every finding (focusable, touch-friendly). One toast when the count rises. `updateModelContext` unchanged                                           |
| Autosave failed            | pill `[Not saved][Retry]` + danger toast with Retry now. Backoff retry                                                                                                                                           |
| CAS conflict               | decision card + pill "Autosave paused"                                                                                                                                                                           |
| Conflict resolved          | info toast "Loaded their version" / success toast "Saved — your version replaced theirs" / info toast "Editing on — your next autosave replaces their version"; the pill follows                                 |
| Live: remote edit won      | warning toast "A remote edit won an overlapping change" + `<msg>`, also when a peer's repair of a merge broken by crossing canvas writes replaced this canvas's edit (#274). Pill stays Live                     |
| Live: remote import failed | danger toast "Live import failed" + `<msg>`. Pill stays Live                                                                                                                                                     |
| Live: text unrenderable    | warning toast "The shared text cannot be rendered. Your canvas shows the last good state." + **Open in designIQ** (#296), also the activity line. Gone once a text renders or live ends. Pill stays Live         |
| Live lost, reconnecting    | pill "Reconnecting…" (warning). Palette and context pad stay usable; edits are gated by `autosavePaused` as today                                                                                                |
| Live lost → autosave       | info toast "Live sync lost — changes now save automatically". Pill back to Saved/Unsaved, avatars removed. Save now reappears in the menu only, so nothing shifts                                                |
| Live interrupted           | decision card; resolution toasts "Loaded the server version" / "Keeping this canvas — autosave will overwrite the server version"                                                                                |
| Superseded                 | info decision card + pill "Inactive". **flush-then-freeze** (§6.6). Todos/Checks toggles, panels, Tools, Workshop, Save and fullscreen removed. Zoom/fit stay (viewer navigation). Watermark untouched (no veil) |

### 6.3 Navigation, modes and the bpmn extras

| Inventory state                                                | Final                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deep link blocked                                              | danger toast "Your client blocked the link" + the URL as selectable mono detail                                                                                                                                   |
| Fullscreen requested / mode changed                            | §2.6: the control reflects the real mode, forced re-fit, layout re-run                                                                                                                                            |
| Workshop on/off                                                | chip-switch tint (blue frame + `--accent` fill when on) + menu checkbox mirror; palette gains or loses the sticky tool; no toast                                                                                  |
| Todos: tracker not yet answered / absent                       | no toggle; it arrives with the canvas (§7.1) and is permanently absent without a tracker                                                                                                                          |
| Todos loading                                                  | two skeleton rows + "Loading todos…" (only while the list is empty)                                                                                                                                               |
| Todos listed                                                   | toggle count (`--primary` while open), head count, rows, canvas badges                                                                                                                                            |
| Todos empty                                                    | empty state: list-todo 24px, "No open todos for this <noun>" ("process", "Wardley Map", …), hint "Select an element, then add a todo to anchor it there.", **[Add todo]**                                         |
| Todos filtered                                                 | chip row "On `[Check credit limit ×]`" + head "1 of 3"; filtered empty "No open todos on this element." + [Show all]                                                                                              |
| Todos tracker error                                            | ONE danger callout "Could not load todos: <msg>" + **[Try again]**. The empty text is suppressed                                                                                                                  |
| New / creating / create or close failed / read-only discovered | inline form (§7.1). "Creating…" spinner. Create errors under the form. Close failure: the row restores + danger callout. Read-only discovered: info foot line, write actions removed                              |
| Implement                                                      | `requestDisplayMode("inline")`, panel closes, info toast "Sent #38 to the assistant". Refused → danger toast "Your client refused the prompt" / "Open #38 in the tracker and ask there." with action **Open #38** |

### 6.4 Checks (dmn)

| Inventory state               | Final                                                                                                                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests running                 | Run shows a spinner, "Running…", disabled. Toggle verdict chip shows a spinner                                                                                                                                                                                             |
| All pass                      | toggle chip `✓ 7/7` (success-soft), section chip "7/7 pass". Success toast "All 7 test cases pass" **only after an explicit Run while the card is closed**                                                                                                                 |
| Failing / pending / uncovered | toggle chip `✕ 1 failing` (danger-soft). Failing cases first and expanded with red failure lines. Pending: circle-question-mark + "no expectation — currently produces …". Info line "No case decides rule 4." Danger toast with [Show] after an explicit Run while closed |
| No cases                      | section chip "No cases yet" (not "0/0 pass"). Empty state "No test cases yet" + hint + **[Try a scenario]** (opens the section)                                                                                                                                            |
| Capture errors                | danger text under the scenario form. Multi-decision DRD: a decision picker, not an error                                                                                                                                                                                   |
| Captured                      | success toast "Saved “<name>” to credit-limit-check.tests.yaml", then reload + run. Test-file conflict: warning callout "The test file changed meanwhile — reloaded it, try again" (auto-reload)                                                                           |
| Replay / agent scenario       | if the DRD is shown, **switch to that decision's table automatically**. The case row gets the selected state, the scenario fields fill, the rule highlights and scrolls into view. Agent scenario: info toast "Scenario from the assistant — rule 3 matches"               |
| DMN multi-decision            | opens on the DRD; the view switch "Table" segment becomes a decision picker (names); DRD palette in the left column; the Checks card no longer covers the DRD diagram (fit insets)                                                                                         |

### 6.5 Controls inventory → final home

| Today                                                                  | Final                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| comet 9px                                                              | trigger (8px, `aria-hidden`, degrade step 1). Official app icon in the menu header and on state cards |
| `#title` "owner/repo · path"                                           | trigger name (stem) + menu header (display name, notation, repo, path) + trigger `title`              |
| `#dirty`                                                               | pill "Unsaved changes"                                                                                |
| `#open`                                                                | TR primary (degrades Open → icon) + menu item + state-card action + popover (read-only/inactive)      |
| `#fullscreen`                                                          | TR, gated, toggles Exit, plus a menu item                                                             |
| `#save`                                                                | menu + ⌘S + popover footer + Retry (pill and toast). No visible button                                |
| `#todo-toggle`                                                         | TR "Todos" + CountChip                                                                                |
| `#tbpm`                                                                | TL chip-switch (`role=switch`, `aria-label` "Workshop mode") + menu checkbox                          |
| `#tests-toggle`                                                        | TR "Checks" (shield-check) + verdict chip                                                             |
| the three banners                                                      | decision cards                                                                                        |
| todos head / filter / form / rows / badges                             | Todos card (§7.1); "New" → **Add todo** (list-plus); icon buttons 22 → 28px                           |
| tests head / rows / capture / coverage                                 | Checks card (§7.2); Capture → "Save as test case" in the scenario outcome strip                       |
| dmn-js "View DRD"                                                      | hidden; TL view switch + menu radios                                                                  |
| add-on table simulator form                                            | hidden (CSS); replaced by the widget-owned "Try a scenario" form on the same `simulationStore` (§7.2) |
| add-on "Simulate DRD" card                                             | offset to `top: U`, hidden while Checks is open                                                       |
| DRD definitions card                                                   | offset beside the DRD palette                                                                         |
| bpmn-js palette                                                        | left column at `top: U` (compact: behind Tools)                                                       |
| bpmn-js context pad, popups, brush, cursors                            | unchanged                                                                                             |
| Miragon palette                                                        | top-centre, tier 1/2, `width:auto` (lifts the leaked diagram-js two-column clamp; position only)      |
| `#status`                                                              | removed: pill + popover activity line + toasts + panel heads                                          |
| absent: menu, zoom/fit, roster, Escape, exit fullscreen, retry, toasts | all added. Undo/redo by keyboard (touch buttons only on touch devices)                                |
| dropped on purpose                                                     | Diagram\|Source, Rename, Duplicate, History, Notes. Release → PR comes in phase 2 as `ui/message`     |

### 6.6 Superseded: flush-then-freeze

When the claim callback fires:

1. `inactive = true`. Clear the timer. Destroy the live session and the extras.
2. If `dirty && !live && !paused`, run ONE last save (CAS). The card body then says "Your last change was saved before this copy stopped." or "Your last change could not be saved: <msg>."
3. `text = await engine.exportText()`, `engine.destroy()`, `engine = deps.mountEngine(true)`, `await engine.importText(text)`.
   - Review fixes: the chrome makes `#canvas` inert from the "inactive" report until the viewer is mounted; when a flush ran, the viewer imports exactly the text it sent (no second export); an edit that still slipped in during the round trip stays unsaved and the card says so; a paused (decision or reconnect) edit is not flushed but named on the card ("Your unsaved change was not saved — …"). A failed-save toast is dismissed on the stop.

This uses the read-only boot path (NavigatedViewer / Viewer), not a veil: no touch, context-pad or keyboard edits can reach a dead instance. An import failure of the frozen copy leaves the state card "This copy is inactive" with Open in designIQ.

The final save may surface as a CAS conflict card in the **newer** widget. That is honest and preferable to silent loss.

---

## 7. Panels (right inspector cards; sheets when compact or too narrow for the lane beside a card)

General:

- Floating card: `top: U` (under a tier-2 Miragon palette: `U` + its height + 8, so a card never covers the palette's end), `right: I`, height = content up to `bottom: L`. Radius lg, 1px `--border`, shadow-2, z 30, 48px head with `h2` (`tabindex=-1`), 28px icon buttons.
- One panel at a time.
- The toggle uses the CI selection look (blue frame + `--accent`; CountChip primary) and carries `aria-expanded` + `aria-controls`.
- **Focus:** opening moves focus to the heading; closing returns it to the toggle.
- **Escape layering** (topmost first): menu → popover → open compact palette → inline form → panel. Never a decision card.
- **The lane never overlaps an open panel (WCAG 2.4.11).** No focused control in a panel sits under a toast or a decision card, and none is pushed out of view by one. The rule is in `core/layout.ts` (`Layout.lane`, the panel mode), applied by `chrome/layout-dom.ts` (`--lane-left` / `--lane-w`, `--lane-h`):
  - **Beside a card.** While a card is open, the lane is centred in the canvas column the card leaves (inset to the card's 12px gap), `min(460, column)` wide. The card is never shrunk or moved for it. Beside a card a tall lane may cover the lowest entries of the left-column bpmn-js palette (720x480: its last row while a toast shows); those entries are pointer-only (not focusable) and sit under the lane by the z-order (§2.1), and leaving them clear at 720 would take the lane under `LANE_MIN`.
  - **A card needs 300px of canvas beside it** (`LANE_MIN`), or the panel opens as a sheet (inline below 656 wide, fullscreen below 704). Measured with the widest decision card (the CAS conflict: three choices, a consequence line each) and the "Autosave failed" toast with Retry now: at 240 the choice grid overflows its card and the toast's title wraps; at 260–280 the consequences wrap word by word (up to 5 lines, the card 327–343px tall); at 300 a consequence takes at most 4 lines and the toast's title one (card 294px, toast 132px; 243 / 114 at 320, 191 / 80 at 460). Rejected: docking the lane inside the card above its body (each toast — a row's own Implement toast too — pushes the rows down and back; the top-anchored lane reaches the bottom row in a 440px frame) and the top of the canvas column (just as narrow).
  - **Above a sheet.** A full-width sheet ends above what the lane holds (`bottom: L + --lane-h`; the lane keeps its place). Its head never moves and its rows never shift, the visual order (head, rows, lane) is the DOM order. The lane gives way, never the sheet: it never reaches the sheet's head (`Layout.lane.max`, min-height 50), and its toasts always leave the sheet head + **120px of body** (`SHEET_BODY`, about two Todos rows or Checks sections — a sheet with less content keeps all of it): over a sheet `room = max − 120`, so 190 at 340x480, 375x480 and 480x480, 130 at 480x420, 230 at 600x520 and 650x520. What does not fit waits or leaves (§5.1). Rejected: docking the lane above the sheet's top edge (the head and its Close would move under the pointer with every toast).
  - **A decision card folds a sheet to its head.** While a decision card shows and the open panel is a sheet, the sheet folds to its head (`core/layout.ts` `sheetFolds`, `chrome/panel.ts` `fold`: `data-folded`, the body `display: none` — hidden and out of the tab order, not squeezed); the head keeps its place and its controls. Answered or deferred ("Decide later"), the card goes and the sheet unfolds at the scroll position it folded at, before the focus returns (§5.2: to where it was — a control in the body takes it back —, else the pill; "Decide later" to the pill). A sheet opened while a card shows opens folded; a card that turns into a sheet on a resize folds, and back. A card beside a CARD-mode panel changes nothing. Why: the card is what the user owes (autosave paused) and both cannot fit on a phone-width frame — the CAS card (compact) is 211px tall at 316 wide, 210 at 351, 191 at 456, against the 190 / 190 / 130 / 190 a 120px body leaves (340x480, 375x480, 480x420, 480x480) —, and a body squeezed under it clipped what sits outside the scroller (the Todos filter row, the read-only foot) and a form's textarea or an expanded Checks row inside it. The toasts' `room` is unchanged (a folded sheet still counts its 120px body). Rejected: the card taking the body down to the head (the clipping above); the card scrolling inside a 130–190px lane (its third choice under the fold — a decision with a hidden option).
  - **The focus stays in view.** Every focus inside a panel's scroller reveals the WHOLE control — its border box, 8px to spare (`revealDelta`) — within what the user sees of the scroller (`visibleView`: its viewport, ending `LANE_GAP` above the lane wherever the lane spans it; beside a card it spans none), the scroller only, never the frame (`chrome/layout-dom.ts`, on `focusin` — before the browser's own reveal, which then finds the control in view). Chrome reveals a textarea's caret line only, and nothing at all while that line shows (375x480 under two toasts: the Add todo description, 65px, was left 19px under the lane's edge). A focus the pointer gives is revealed once the press is over, after its click: a half-shown button moved from under the pressed pointer (22px) lost its click. When a sheet ends higher, a focused control that showed in its scroller stays in view: the scroller follows (`inView`, then `revealDelta`). `inView` is an intersection with a 1px tolerance, not containment: Chrome leaves a Tab-focused control 0.39px past the scroller's edge in a 600–655 wide sheet (and a chip, `overflow: hidden`, its border's width more), and that control is in view all the same. A control the user scrolled away from stays where it is until it takes the focus again. Tab itself lands 8px clear (`.panel-scroll :focus { scroll-margin-block: 8px }`).
  - **The head never scrolls away.** `.panel` is `overflow: clip` (it cannot be scrolled, not even by a focus), and everything under the head — the Todos filter row aside — scrolls in ONE `.panel-scroll`: Todos error callout, Add todo form and list; Checks sections. A short card or sheet reaches every control by scrolling.
- Overlay, never squeeze. Diagrams re-fit with the card's right inset (§2.5). The DMN table container takes `padding-right: panelWidth + I + 12` and scrolls horizontally, so every column stays reachable.
- Motion: slide in 12px from the right + fade, 250ms `--cd-ease-out`. A sheet slides up 8px.

### 7.1 Todos card (bpmn and the Miragon renderers)

The card is the same in both widget kinds; only the canvas controller differs: bpmn-js overlays (`lib/todo-canvas.ts`) in the bpmn widget, the contract's element surface (`lib/todo-surface-canvas.ts`, the SPA's Miragon editors mount the same one) in the Miragon widgets. The copy names the model with the notation's noun ("process", "Wardley Map", "Event Storming board", …).

- **Head:** list-todo "Todos" + count ("3" / "1 of 3"), then:
  - **[Add todo]** (list-plus, SPA name and titles: "Anchor a todo to the N selected elements" / "Create a todo on the whole <noun> (no element selected)"); pressed while the form is open.
  - [refresh-cw] "Reload from the tracker".
  - [×] "Close todos (Esc)".
- **Filter row:** "On `[<element> ×]`" (blue chip) + [Show all].
- **Error callout** (exclusive with the empty text).
- **Inline form** at the top:
  - Anchor preview tracking the live selection ("Anchored to: [chips]" or a dashed "Whole <noun>" chip).
  - Type picker ("Todo type") only when the repo offers more than one type; a single template says "Filed as <name>".
  - Title (focused, required, max 200, "What needs to be done?"), then the built-in Todo's description, or the template's fields (label, "(optional)", hint, input / textarea / select / checkbox list; markdown hints are not shown). `novalidate`: after a submit, a missing required field gets "Required" under it (`aria-invalid` + `aria-describedby`), filling it clears the flag (lib/todo-form.ts, the server's check). An empty title says "A title is required."; until `list_todo_types` answered, a submit says the types are loading (or why they could not load) and files nothing. A host without the tool files plain todos.
  - [Cancel] [Create todo] (primary; it is the form the user opened).
- **Rows are cards:**
  - Title 600; tracker link icon top-right ("Open #38 in the tracker").
  - **Body visible** with a 2-line clamp (no tooltip); a todo filed with a template shows its type as the first chip instead.
  - Anchor chips are buttons that reveal and select the element (retitled "… — no longer in this diagram" when gone). Unanchored rows show a dashed "Whole <noun>" chip.
  - "#id · @author" (age in `title`); [send Implement] in `--link`; [check Done] ghost (spinner while closing, row at 50%).
- **Canvas badges** unchanged; a badge click opens the card (or sheet) filtered. On a Miragon canvas the badge stands on the element's top-right corner and keeps its screen size when zoomed out; a todo anchored by a Wardley component's name (the Live Host's `get_view` id) badges that component.
- **Implement** names the notation's tools: a process `get_bpmn_xml` / `validate_bpmn` / `save_bpmn_xml`, any other model `get_model_content` / `validate_model` / `save_model_content`.
- **Read-only:** foot line "Read-only here: filing and closing todos is disabled." Add, Implement and Done are absent.
- **Discovery:**
  - `list_todos` fires via the new `WidgetExtras.onRead(doc)` — right after the bridge read resolves the path, in parallel with the engine import and font wait — or at load start when the tool input already carries a `path`.
  - The toggle appears with the canvas. Missing tool → never shown.

### 7.2 Checks card (dmn) — SPA "Decision checks" order, stacked collapsible sections (not tabs)

- **Head:** shield-check "Checks", [play **Run**] (secondary outline), [×].
- **Section "Findings"** (collapsed by default):
  - Summary chip: "Sound" (success) / "2 warnings" / "1 error".
  - Expanded: one row per finding (SPA `Finding` copy).
  - Source: the existing `analyze_decision` server tool, called at load and after each landed save (debounced 5s). No bundle growth. The section is hidden if the tool is missing.
- **Section "Try a scenario"** (collapsed by default unless a simulation is active):
  - Collapsed summary: the last outcome ("Rule 3 → "approve"").
  - Expanded: the widget-owned form, built from the active table view's add-on `simulationStore` (`getModel().inputs`: label, typeRef, options → select, min/max), in a 2-column grid.
  - [Simulate] (**secondary outline** — one blue fill per view) and [Reset] (ghost).
  - Outcome strip (success-soft): "Rule 3 · "approve"" + **[Save as test case]**, which opens an inline name field (`record: true` + baseVersion, as Capture today).
  - Drives `setValue` / `run` / `reset` and `subscribe`s for changes. The add-on itself paints the rule highlight. It rebinds on `views.changed`.
  - **Never reparents add-on DOM.** The add-on's own form is hidden by CSS.
  - In the DRD view, the section shows "Pick a decision table" with one button per decision (names).
  - _Fallback if the store surface proves insufficient:_ keep the add-on form visible inside the table container under the 56px top inset. At 480x420 it then occupies the table view, so Checks opens as a sheet over it.
- **Section "Test cases"** (expanded):
  - Verdict chip.
  - Rows are buttons with pass, fail or pending icons, **failing first**.
  - The selected or replayed row is expanded with the given values in Geist Mono and "Rule 3 → "approve" as expected" (or the red expected/actual lines). Others are one line.
  - Coverage info line "No case decides rule 4."
  - Empty: see §6.4.
- **Discovery:** `get_decision_tests` + `run_decision_tests` fire from `onRead`, so the toggle is capability-gated up front and carries its verdict from boot. The suite re-runs after each landed save while it has cases (at most every 5s).
- At 720 the visible table shows the rule numbers and the first columns, and the replayed rule is scrolled into view. The selected case row carries rule and output, so the hidden output column is not needed to read the verdict.
- As a sheet (compact, or under 656 wide — §7), replay collapses it so the highlighted rule is visible.

### 7.3 Legend card (context map)

The Context Maps legend (subdomain types, integration roles, relationship patterns) is a card of the widget's own, `mcp-app/legend.ts`, instead of the renderer's card on the canvas: that card covered the diagram's lower left, and the fit could not leave room for it.

- **Toggle:** `[book-open Legend]` leads the TR cluster (step 4 drops its label, like Todos), shown once the model is on screen. The menu repeats it as the Model group's last entry, the checkbox "Legend" without an icon (guide §5.4, §5.14).
- **Head:** book-open "Legend", [×] "Close legend". **Body:** the renderer's `renderLegend` rows, laid out as guide §5.10 does (`lib/miragon-legend.css`, shared with the SPA's Legend side panel): a 24px preview, the label, groups named for a screen reader, a rule between them. Each row's meaning is its tooltip and, visually hidden, part of its text.
- **Room:** a card like Todos and Checks, so an untouched diagram re-fits beside it with the card's right inset (§2.5). Measured: at 1000x640 (a 360 card) and at 720x520 (a 320 card) the fitted context map ends 12px left of the card; compact frames get the sheet.
- **Keyboard and screen reader:** the toggle and the menu entry reach it, the heading takes the focus on open, the scroller is focusable (`role="region"`, named by the heading) so the arrow keys scroll it, the close button and Escape give the focus back to the toggle.
- It starts closed: the inline frame is never taller than the guide's 820px for an open legend (`legendStartsOpen`), and an open on load would pull the focus into the widget.

---

## 8. Keyboard and accessibility

| Topic           | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope           | One `keydown` listener on the widget document. Shortcuts are ignored when the target is `input`, `textarea`, `select` or `[contenteditable]` (⌘Z stays native there). `preventDefault` only when handled                                                                                                                                                                                                                                  |
| ⌘S / Ctrl+S     | editable model loaded: Save now in autosave mode. In live mode, info toast "Live sync already saves every edit". Not handled (browser default) in read-only                                                                                                                                                                                                                                                                               |
| ⇧1              | Fit. In the Miragon widgets with the zoom keys below (the shell's keymap); in bpmn and dmn the chrome's own (keymap.ts `keyCommand`). Not in a text field (it types "!")                                                                                                                                                                                                                                                                  |
| Zoom keys       | Miragon widgets: ⌘ or Ctrl + `+` / `=` / numpad +, `-` / `_` / numpad −, `0` / numpad 0 (100 %), by `matchChromeKey` and `decideKey` (host "embedded") from `@miragon/modeler-shell/core`. Kept from IME composition, text fields, an open modal dialog and a widget without a diagram, where the browser zooms the page. bpmn and the DMN DRD view: the diagram-js keyboard on the focused canvas                                        |
| Escape          | the topmost layer (§7). Never a decision card. A renderer's modal dialog (Keyboard shortcuts…, Map title…) takes it itself, its popover (Map size…) too                                                                                                                                                                                                                                                                                   |
| Canvas keyboard | bpmn and the DMN DRD view: undo/redo, zoom, select all, delete, bound implicitly by the diagram-js 15 keyboard while the canvas has focus. The Miragon renderers bind no zoom keys (the widget does, above): undo/redo, select all and delete come from each renderer's own `keydown` listener on the document while its canvas or the page has the focus                                                                                 |
| Names           | trigger "Menu — `<name>`"; Tools "Tools" + `aria-expanded`; Workshop `role=switch` `aria-label="Workshop mode"` `aria-checked` (its own name, not a wrapping label); "Todos, 3 open"; "Checks, 7 of 7 pass"; "Open fullscreen"/"Exit fullscreen"; "Open in designIQ (new tab)"; zoom buttons as in §2.5; DMN view switch: a `group` "Decision view" of `aria-pressed` buttons with text labels (icons + `aria-label` + tooltip at step 3) |
| Targets         | corner 36px, zoom/panel/toast/card buttons ≥ 28px (fixes the 22px buttons)                                                                                                                                                                                                                                                                                                                                                                |
| Focus ring      | `:focus-visible` 2px `--ring`, offset 2, on every control                                                                                                                                                                                                                                                                                                                                                                                 |
| Live regions    | `#announce` (polite: pill class changes, non-danger toasts), `#alert` (assertive: danger toasts, decision cards that did not take focus). One surface per transition: what arrives within one 60 ms beat is joined, and the pill's sentence yields to any toast or card in it (Retry with findings speaks "Saved with 1 warning. …" once, never "… Saved · 1 warning" on top)                                                             |
| Motion          | tokens only (`--cd-motion-fast/base`, `--cd-ease(-out)`). Under `prefers-reduced-motion`, the CI block disables pop-ins, slides, spinner rotation (static icon + text) and the animated re-fit                                                                                                                                                                                                                                            |
| Contrast        | text ≥ 4.5:1 (`--muted-foreground`, `--link`, status colours on white and on their `-soft`); non-text ≥ 3:1 (`--input` borders, pill rules). No new alias: all colours exist in `tokens.css`                                                                                                                                                                                                                                              |

---

## 9. Motion

| Surface                   | Motion                                      |
| ------------------------- | ------------------------------------------- |
| Menu, popover             | pop-in 150ms `--cd-ease-out`, 4px rise      |
| Toasts, decision cards    | 8px slide + fade, 250ms                     |
| Panel card                | 12px from the right + fade, 250ms           |
| Sheet                     | 8px up, 250ms                               |
| State card                | fade 250ms                                  |
| Re-fit                    | 250ms `--cd-ease`                           |
| Primary button hover      | lift `translateY(-1px)` + shadow-2 (exists) |
| Spinner (`loader-circle`) | 1s linear                                   |

All of these are disabled under reduced motion.

---

## 10. Contracts (code)

### 10.1 `core/lifecycle.ts` — ChromePort

```ts
export interface DocLabel {
  repo: string;
  path?: string;
  id?: string;
}
export type SyncKind =
  | "loading"
  | "connecting"
  | "live"
  | "reconnecting"
  | "saved"
  | "unsaved"
  | "saving"
  | "failed"
  | "paused"
  | "readonly"
  | "inactive";
export interface SyncState {
  kind: SyncKind;
  /** why not live — picks the popover note */
  mode?: "live" | "autosave-unavailable" | "autosave-by-design" | "readonly";
  findings?: { errors: string[]; warnings: string[] };
  savedAt?: number; // epoch ms of the last landed save
  retryAt?: number; // next automatic retry (failed)
}
export interface ToastSpec {
  tone: "success" | "info" | "warning" | "danger";
  title: string;
  detail?: string;
  action?: { label: string; run(): void };
  /** replaces a toast with the same key; dismissToast(key) clears it */
  key?: string;
}
export interface BannerAction {
  label: string;
  danger?: boolean;
  primary?: boolean;
  consequence?: string;
  run(): void;
}
export interface BannerOptions {
  detail?: string;
  tone?: "warning" | "info";
  /** pill state while deferred */ deferAs?: "paused" | "inactive";
}
export interface PeerLabel {
  name: string;
  color: string;
  kind?: "human" | "agent";
}

export interface ChromePort {
  setDocument(doc: DocLabel): void; // was setTitle(text)
  setStatus(text: string, tooltip?: string): void; // unchanged copy → popover activity line + findings
  setSync(state: SyncState): void; // NEW
  setPeers(peers: PeerLabel[]): void; // NEW
  toast(t: ToastSpec): void; // NEW
  dismissToast(key: string): void; // NEW
  setDirty(dirty: boolean): void; // unchanged (menu/popover Save now)
  setSaveButton(state: { visible?: boolean; enabled?: boolean }): void; // unchanged semantics: Save now availability
  setOpenVisible(visible: boolean): void; // unchanged
  showBanner(title: string, actions: BannerAction[], opts?: BannerOptions): void; // decision card
  hideBanner(): void;
}
```

Lifecycle changes:

- `setDocument` is called at load start (provisional, from the input) and after the read (the resolved path).
- `LifecycleDeps.mountEngine(readonly: boolean)`.
- `LifecycleDeps.timing.retryMs` (default `[5000, 15000, 60000]`).
- `WidgetLifecycle` gains:
  - `flushNow(): Promise<void>` (teardown).
  - `reload(): Promise<void>` (menu; the same epoch fencing as `load`).
  - `lastInput(): ModelInput | undefined` (Try again).
- `WidgetExtras` gains `onRead?(doc: DocRef, input: ModelInput): void`.
- `LiveHooks` gains `onPeers?(peers: PeerLabel[])`. `core/live.ts` maps the awareness states it already receives into peer labels.
- Load failures throw `LoadError { stage: "read" | "import" }`. `wireApp` picks the state card. `setStatus("Load failed: …")` is kept.
- The autosave-failed copy becomes "Autosave failed: <msg> — retrying automatically".
- `setSync` is called at every transition in the §4 table. The precedence `paused > failed > saving > unsaved > connecting > saved` is enforced in `sync-view.ts`.

### 10.2 Engine contract (`core/engine.ts`)

```ts
export interface ViewControls {
  hasViewport(): boolean; // dmn table view: false
  fit(insets: Insets, animate: boolean): void;
  stepZoom(direction: 1 | -1): void; // one of the guide's fixed steps (§5.8)
  zoomTo(level: number): void; // 1 = 100%
  level(): number;
  onChange(cb: () => void): () => void; // viewbox / view switch
  palette?: { open(): void; close(): void; isOpen(): boolean; size(): { w: number; h: number } };
  undo?: { canUndo(): boolean; canRedo(): boolean; undo(): void; redo(): void };
}
export interface WidgetEngine {
  /* … */ view?: ViewControls;
  displayName?(): string | undefined;
}
export type EngineFactory<E> = (container: HTMLElement, readonly: boolean, opts?: { insets(): Insets }) => E;
```

`importText` fits with `opts.insets()` (or `fitViewport` when absent, as in tests).

`DmnEngine` adds:

- `views(): Array<{ id: string; name: string; type: "drd" | "decisionTable" | "literalExpression" }>`, `activeView()`, `openView(id)`.
- `scenario(): ScenarioSurface | undefined`: a wrapper over the active `simulationStore` with `inputs()`, `set(i, v)`, `run()`, `result()`, `reset()`, `subscribe(cb)`, rebound on `views.changed`.

---

## 11. File-by-file plan

### `apps/web` — HTML entries (bundle-only)

All three entries: `mcp-app.html`, `mcp-app-dmn.html`, `mcp-app-miragon.html`.

- Replace `#toolbar`, `#banner` and `#status` with the skeleton below.
- **Keep** the `window.DESIGNIQ_BOOT = "__DESIGNIQ_BOOT__"` marker.
- Panel asides keep their inner ids where todos.ts/dmn-tests.ts bind (renames listed below).

```html
<div id="app">
  <div id="canvas"></div>
  <div id="tl" class="corner tl">
    <button id="menu-trigger" …>
      <span data-icon="menu"></span><span class="sep"></span><span id="doc-name"></span></button
    ><button id="tools" hidden data-icon="shapes"></button><span id="mode-slot"></span>
  </div>
  <div id="tr" class="corner tr">
    <!-- panel toggle (bpmn/dmn) --><button id="fullscreen" hidden></button
    ><button id="open" class="fb primary" hidden></button>
  </div>
  <div id="bl" class="corner bl"><span id="sync" hidden></span></div>
  <div id="br" class="corner br"><div id="zoom" role="group" aria-label="Zoom" hidden>…</div></div>
  <aside id="todos|checks" class="panel" hidden>…</aside>
  <div id="lane" class="lane"></div>
  <div id="state" class="state" hidden></div>
  <div id="menu" role="menu" hidden></div>
  <div id="sync-popover" role="dialog" hidden></div>
  <div id="announce" class="sr-only" aria-live="polite"></div>
  <div id="alert" class="sr-only" role="alert"></div>
</div>
```

Per entry:

- `mcp-app-dmn.html`: tests panel → `#checks` (sections), toggle `#checks-toggle` (shield-check).
- `mcp-app-miragon.html`: no static panel (a context map's Legend panel is built by `legend.ts`); each mount gets a host inside `#canvas` that carries `spec.canvasClassName` (miragon-main.ts), so the dev preview's vendor-CSS scoping matches the renderer's root and its dialogs inside it.

### `apps/web/src/mcp-app` — pure, tested modules (`.ts` imports, no DOM, no `@/`)

| File (new)           | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/layout.ts`     | `computeLayout({ W, H, displayMode, safeArea, kind, view, steps: { tl: number[], tr: number[] }, palette: {w,h}, panelOpen, touch })` → `{ inset, compact, step, paletteMode: "column" \| "tier1" \| "tier2" \| "tools", panel: { mode: "card" \| "sheet", width }, lane: { left, width, max, room }, fitInsets, laneBottom, showZoomPct, nameMax, inlineHeight }`; `inView` + `revealDelta` + `visibleView` (the whole focused control shows; a sheet's scroller follows the focus); `laneHold` (`--lane-h`); `sheetFolds` (a decision card over a sheet) |
| `core/sync-view.ts`  | `SyncState` → `{ label, tone, icon, dot, announceClass }`; the popover sentence (mode notes); precedence; `shouldAnnounce(prev, next)`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `core/menu-model.ts` | `buildMenu({ kind, editable, live, dirty, saving, paused, inactive, todos, checks, views, fullscreenOffered, displayMode, messageCap, deepLink })` → groups of `{ id, label, icon?, kbd?, role, checked?, disabled?, hint? }`; a renderer's own entries (`ModelerMenu`: Model, Export, Help) as `modeler:` items, `runModelerItem` to run them                                                                                                                                                                                                             |
| `engines/fit.ts`     | the −/+ step: `zoomStepLevel(level, direction)`, the guide's fixed zoom steps (§5.8) as `zoomScroll.stepZoom` computes them, and `zoomAround(viewbox, outer, level, point)`. The fit, "untouched", the eased re-fit and the readout are `@miragon/modeler-shell/core`                                                                                                                                                                                                                                                                                      |
| `core/keymap.ts`     | `keyCommand` (⌘S, ⇧1, Escape, the text-field guard) and `chromeKeyAction`: the Miragon zoom keys and ⇧1 by the shell's `decideKey` for an embedded modeler                                                                                                                                                                                                                                                                                                                                                                                                 |

### `apps/web/src/mcp-app` — DOM modules (bundle-only)

| File                                             | Change                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell.ts`                                       | rewrite: `mountChrome()` returns `WidgetChrome` (ChromePort adapter + registries: `registerPanel`, `setModeChip`, `setViewSwitch`, `setZoom`). `openExternal` and `wireApp` stay (wireApp → state cards)                                                         |
| `chrome/menu.ts`                                 | menu button + keyboard model, renders `menu-model` groups, inline discard confirm                                                                                                                                                                                |
| `chrome/sync.ts`                                 | pill (+ failed group) and popover; live regions                                                                                                                                                                                                                  |
| `chrome/toasts.ts`                               | lane, timers, pause on hover/focus, keyed replace/dismiss; applies `planLane` (`fit()`: who shows, who waits out of the DOM, who leaves); a leaving toast fades out of the flow (`leavingBottom`)                                                                |
| `chrome/decision.ts`                             | decision card, choice rows, defer to pill, focus rules                                                                                                                                                                                                           |
| `chrome/state-card.ts`                           | the §5.3 cards; `inert` on `#canvas`                                                                                                                                                                                                                             |
| `chrome/zoom.ts`                                 | zoom group + touch undo/redo, bound to `engine.view` (re-bound after the superseded remount)                                                                                                                                                                     |
| `chrome/panel.ts`                                | card/sheet shell shared by Todos and Checks: open/close, one-at-a-time, focus, Escape, re-fit trigger; collapse and the fold under a decision card, each with its scroll memory                                                                                  |
| `chrome/keys.ts`                                 | ⌘S, ⇧1, the Miragon zoom keys (`lib/chrome-keys.ts`, shared with the SPA), Escape layering (none under a renderer's modal dialog), text-field guard                                                                                                              |
| `chrome/host.ts`                                 | host context merge, display mode, fullscreen toggle, `sendSizeChanged`, `onteardown`, capabilities                                                                                                                                                               |
| `chrome/layout-dom.ts`                           | ResizeObserver, measures cluster widths per degrade step (hidden measuring clones), applies `computeLayout` via data attributes and CSS custom properties, drives re-fit; `--lane-h`, the whole focused control in a panel's scroller (`focusin`) and the follow |
| `core/widget.ts`                                 | composition: App options, host wiring, menu actions, Try again / Reload / Ask the assistant, the lifecycle, the panel toggles, superseded remount wiring                                                                                                         |
| `core/lifecycle.ts`                              | §10.1                                                                                                                                                                                                                                                            |
| `core/live.ts`                                   | `onPeers` from awareness                                                                                                                                                                                                                                         |
| `core/engine.ts`                                 | §10.2 types                                                                                                                                                                                                                                                      |
| `engines/diagram-js.ts`                          | `fitInto`, `stepZoom`, `zoomTo`, palette open/close/size, `viewControls(instance)`; keep `fitViewport`                                                                                                                                                           |
| `engines/bpmn.ts`                                | `view`, `displayName` (participant or process name), insets option                                                                                                                                                                                               |
| `engines/miragon.ts`                             | `view` (palette = renderer palette), `displayName` (the document's title), `menu` (the renderer's own entries, their dialogs in the mount's host)                                                                                                                |
| `engines/dmn.ts`                                 | `views()`, `openView()`, `scenario()`, `view` (DRD only), `displayName`                                                                                                                                                                                          |
| `main.ts`                                        | Workshop chip into `#mode-slot` (`role=switch` + own `aria-label`) + menu checkbox; todos via `chrome/panel`                                                                                                                                                     |
| `todos.ts`                                       | §7.1: Add todo naming, skeleton, error exclusivity, toasts instead of status, `onRead` discovery, 28px targets, chips, dashed Whole process, read-only foot line                                                                                                 |
| `dmn-main.ts` + `dmn-tests.ts` → `dmn-checks.ts` | §7.2: sections, verdict on the toggle, the scenario form on the store, Save as test case, auto-switch to the table on replay, `analyze_decision` findings, probe from `onRead`, toasts                                                                           |
| `miragon-main.ts`                                | canvas class; renderer-failed state card; Geist Mono for the key chips; the Legend panel (`legend.ts`) where the spec has a legend                                                                                                                               |
| `bridge.ts`                                      | `makeApp()` with `appCapabilities.availableDisplayModes` and `autoResize: false`; `analyzeDecision(app, doc)` helper                                                                                                                                             |
| `icons.ts`                                       | see §12; remove `maximize` and `flask-conical`; fix the stale "SPA's Checks icon" comment                                                                                                                                                                        |
| `lib/comet.ts`                                   | `appIconElement(size)` (official icon: blue rounded square + green comet; fills via CSS classes on `--primary`/`--brand`, no hex)                                                                                                                                |

### `apps/web/src/mcp-app` — CSS

| File                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chrome.css`               | corners, `.fb`, pill, zoom, menu, popover, panel, lane, toast, decision, state, paper, `sr-only`, the reduced-motion block; `--accent` for every tint (no `color-mix` with raw `--cd-blau`). Target = the measured size after the dead-rule trim: **25.6 KB unminified (comments included), 15.8 KB minified** (was 27.4 / 17.9 before the dead-rule trim). The 8 KB first estimate could not hold, because this one sheet carries the menu, popover, toasts, decision and state cards and the panel shell that origin/main's toolbar (6.6 KB) never had; notation-only rules (the palette slot, the Todos rows and form) live in the entry sheets below |
| `styles.css`               | the Workshop chip-switch and its menu switch, the todo element chips; Todos card internals (the filter row `.panel-row`, the Add todo form `.panel-form`); `#canvas .djs-palette { top: var(--under-row); left: var(--inset) }`; compact hides it until Tools                                                                                                                                                                                                                                                                                                                                                                                            |
| `dmn-styles.css`           | the DRD \| Table switch, the verdict chip; Checks internals (sections); `.view-drd`, `.dmn-sim` hidden; table container insets (`padding: var(--under-row) var(--table-right) var(--lane-bottom) var(--inset)`); DRD palette, definitions card and "Simulate DRD" offsets                                                                                                                                                                                                                                                                                                                                                                                |
| `miragon-styles.css` (new) | the Miragon widgets' entry sheet (`miragon-main.ts` imports it instead of `chrome.css`): the renderer palette's slot — top-centre, tier 1 / tier 2, the wrapped two-column clamp; the legend rows (`lib/miragon-legend.css`); a Wardley popover at the dropdown's place                                                                                                                                                                                                                                                                                                                                                                                  |

### `apps/web` — other files

- `README.md` (apps/web): rewrite the widget section (chrome, states, Checks).
- `vite.config.ts`: no change needed once `#canvas` carries the class.

### `apps/live-host`

- `src/http/mcp.ts`: unchanged except the optional `_meta.ui.prefersBorder: true` (open question). The marker replacement is untouched.
- `test/mcp.test.ts`: unaffected (add one assert if `prefersBorder` lands).

### `docs`

- `docs/mcp-integration.md:333-420`: rewrite "MCP Apps: the embedded modelers" (corners, pill vocabulary, decision cards, Open in designIQ, Implement returns inline) and the stale DMN paragraph (the decision widget rides the shared core; Checks naming; the scenario section).

---

## 12. Lucide inventory (verbatim lucide-react 1.51.0 nodes in `icons.ts`; `widget-icons.test.ts` pins them)

Kept: `check`, `circle-check`, `circle-x`, `circle-question-mark`, `circle-dashed`, `external-link`, `list-todo`, `play`, `plus`, `refresh-cw`, `send`, `triangle-alert`, `x`.

New (all are rendered in the final design):

| Icon                  | Used for                    |
| --------------------- | --------------------------- |
| `menu`                | trigger                     |
| `shapes`              | Tools                       |
| `sticky-note`         | Workshop compact chip, menu |
| `list-plus`           | Add todo                    |
| `shield-check`        | Checks                      |
| `maximize-2`          | Open fullscreen             |
| `minimize-2`          | Exit fullscreen             |
| `minus`               | zoom out                    |
| `scan`                | fit                         |
| `loader-circle`       | spinners                    |
| `eye`                 | Read-only                   |
| `circle-alert`        | errors                      |
| `info`                | info cards and lines        |
| `rotate-ccw`          | Try again, Reset            |
| `save`                | Save now                    |
| `chevron-down`        | sections, selects           |
| `chevron-right`       | sections                    |
| `network`             | DRD                         |
| `table-2`             | Table                       |
| `message-square-text` | agent avatar                |
| `book-open`           | Legend (context map)        |
| `file-image`          | Export as PNG               |
| `file-code-corner`    | Export as SVG               |
| `keyboard`            | Keyboard shortcuts…         |

Phase 2: `git-pull-request` (Release → PR…), `undo-2`, `redo-2` (touch).

Removed: `maximize`, `flask-conical`.

Not used: no sparkles, wand or robot (anti-slop U4); no emoji or unicode glyphs as icons. The ⌘/⇧ glyphs are keyboard hints in text, not icons.

---

## 13. Tests

| Suite                                    | Impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/widget-lifecycle.test.ts`          | `chrome.titles` → `chrome.docs` (provisional + resolved). The autosave-failed copy (1 assert). All other status, banner-label, danger, saveButton and dirty asserts stay. **New:** `setSync` sequences (load → saved → connecting → live; dirty → saving → saved with findings; conflict → paused → saved; live dead → reconnecting → saved/live/paused; supersede → inactive), the toasts per event (§5.4), retry backoff (`timing.retryMs`), `flushNow`, `reload`, supersede flush-then-freeze (`mountEngine(true)` called, last save attempted), `onRead` before import, `LoadError.stage` |
| `test/fakes.ts`                          | `fakeChrome` gains `docs`, `sync`, `peers`, `toasts`, `dismissed`, `bannerOpts`; `fakeEngine` gains `view` and the `mountEngine(readonly)` record                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `test/widget-live.test.ts`               | `onPeers` from awareness (agents flagged)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/widget-engines.test.ts`            | the shell's `fitViewbox` held to designIQ's own fit (insets, maxScale 1, centring, a 2000-frame sweep), `sameView` against diagram-js's rounding, the eased and log-space re-fit, the readout, `zoomAround`, `zoomStepLevel` on the guide's steps; `importText` fits with insets, to a renderer's `contentBounds()` where it reports one; the SPA's view fits the first import only                                                                                                                                                                                                           |
| **new** `test/widget-layout.test.ts`     | degrade steps at 480/600/650/720/960/1280 per kind with measured widths from the built widgets; compact rule (W < 600, H < 440, pip); palette mode (column/tier1/tier2/tools); panel card vs sheet; inline height (480/420, `maxHeight` cap, none when fixed or fullscreen); no TL/TR overlap (gap ≥ 16); the lane's place and bound (`max`, `room`: a sheet keeps head + 120); `inView` (the 0.39px Tab case); `revealDelta` (the whole focused control), `visibleView`, `laneHold`, `sheetFolds`                                                                                            |
| `test/widget-feedback.test.ts`           | `planLane`: two / one beside a card, the oldest auto-dismissing toast yields first, persistent ones wait, only what fits the room (656x440, 720x440, 480x420 numbers); `leavingBottom`                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/widget-chrome-dom.test.ts`         | the lane in the DOM: a waiting toast leaves nothing to Tab to, hands its focus to the pill, and comes back in arrival order when the card collapses or a toast leaves                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **new** `test/widget-sync-view.test.ts`  | labels, tones and precedence; announce only on class change; **DMN test results never map to the pill**; the popover note per mode                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **new** `test/widget-menu-model.test.ts` | read-only drops Save/Workshop; live drops Save now; superseded = Open only; dmn view radios with decision names; empty groups collapse; Fullscreen only when offered                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `test/widget-icons.test.ts`              | automatic for the new entries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **new** `test/widget-keys-dom.test.ts`   | the one keydown listener under jsdom: each Miragon zoom key and ⇧1 runs and is prevented; a text field, an open modal, a composition, a handled key and a widget without a diagram keep it; bpmn and dmn keep theirs                                                                                                                                                                                                                                                                                                                                                                          |
| **new** `test/widget-menu-dom.test.ts`   | a renderer's entries in the open menu: the radio heading in a named group, the check that keeps its room, the icon column, `aria-haspopup="dialog"`, what activating does                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **new** `test/miragon-menus.test.ts`     | the real renderers' menu content in both hosts, their dialogs inside the canvas host, Map title… and Level as one undoable step, Type captions as a view preference, the SVG export, the document title as display name (none for an untitled map or board), the SPA's zoom keys and ⇧1 on a real canvas, its fit beside an open side panel                                                                                                                                                                                                                                                   |
| **new** `test/widget-legend.test.ts`     | the Legend panel: toggle, labelled panel, the heading's focus, close and Escape back to the toggle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **new** `test/widget-shell-dom.test.ts`  | the composed chrome (`mountChrome`) on the real skeletons: a Miragon widget's zoom keys run the view and stop behind a state card, its zoom buttons name their keys, the bpmn widget leaves the keys to its canvas, the menu's Legend toggles the panel, a web link in the canvas opens through the host                                                                                                                                                                                                                                                                                      |
| **new** `test/side-panel-room.test.ts`   | what an open side panel covers of the SPA's canvas, and its change when a panel joins or leaves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **new** `test/widget-download.test.ts`   | exports through `ui/download-file`, and a toast for every way it fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **new** `test/zoom-steps.test.ts`        | the −/+ step on real canvases: the widget engines of every Miragon renderer, bpmn-js and the DMN DRD step as diagram-js's `zoomScroll.stepZoom` does                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/ui-kit/test/tokens.test.ts`    | unchanged (no new alias)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/live-host/test/mcp.test.ts`        | unchanged (marker kept)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Harness                                  | a browser smoke against the built widgets (a local MCP host harness) at 480x420, 480x480, 600x520, 650x520, 720x520 and 1280x760 (no overlap, nothing covers the watermark, no horizontal scroll: `scrollWidth ≤ innerWidth`)                                                                                                                                                                                                                                                                                                                                                                 |

---

## 14. Phasing

**Phase 1 (≈ 8 dev days)**

| Work item                                                                                                                                       | Days |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Skeleton, corners, layout calculator + DOM, measured degrade, compact/Tools                                                                     | 2    |
| Menu + keyboard, pill + popover, toasts, decision cards, state cards, live regions                                                              | 2    |
| Fit/zoom with insets, auto-fit-until-touched, host context, fullscreen toggle, fixed inline height, teardown                                    | 1    |
| Lifecycle port changes (setSync, toast, peers, retry backoff, flush-then-freeze remount, reload, onRead, LoadError) + tests                     | 1.5  |
| Todos card/sheet; Checks card (sections, scenario on the store, Save as test case, findings via tool, verdict, probe, auto-switch to the table) | 1.5  |
| Icons, CSS, docs, harness smoke                                                                                                                 | —    |

**Phase 2 (≈ 2–3 days)**

- Multi-decision picker polish.
- "Continue here" (superseded re-claim and reload).
- Release → PR… via `ui/message`.
- Touch undo/redo.
- Miragon compact palette wrap verified per renderer, plus an upstream palette-offset option in the Miragon renderers ([Miragon/modeler-suite](https://github.com/Miragon/modeler-suite)).
- Content-adaptive inline height, if wanted.

**Verify in real hosts before release (the harness cannot):**

- The inline height honoured or capped (Claude web, Claude Desktop, ChatGPT).
- `requestDisplayMode` and the `hostcontextchanged` round-trip.
- `safeAreaInsets` on mobile.
- Focus behaviour when a decision card arrives while the user types in the composer.
