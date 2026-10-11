/**
 * The seams of the frameless widget chrome (spec §10, §11) — types only.
 *
 * shell.ts composes ONE `WidgetChrome` out of the modules below; each module
 * owns its corner of the skeleton (mcp-app*.html) and is mounted by a
 * `mountX(deps)` of the type named here:
 *
 *   chrome/host.ts        MountHost        host context, display mode, inline height, teardown
 *   chrome/layout-dom.ts  MountLayout      measures the clusters, applies core/layout.ts, Tools, re-fit
 *   chrome/menu.ts        MountMenu        the document menu (core/menu-model.ts) + its key model
 *   chrome/sync.ts        MountSync        the pill, its popover, the live regions (core/sync-view.ts)
 *   chrome/toasts.ts      MountToasts      the bottom-centre lane's toasts
 *   chrome/decision.ts    MountDecision    the decision cards (CAS conflict, live interrupted, superseded)
 *   chrome/state-card.ts  MountStateCards  the centred dead ends (§5.3)
 *   chrome/zoom.ts        MountZoom        the zoom group, bound to engine.view
 *   chrome/panel.ts       MountPanels      the Todos / Checks card shell (sheet when compact)
 *   chrome/keys.ts        MountKeys        ⌘S, ⇧1, Escape layering
 *
 * Plus chrome/mode-chip.ts (the Workshop chip-switch), chrome/view-switch.ts
 * (the DMN DRD | Table switch), chrome/focus.ts (the focus hand-back around a
 * state card) and chrome/dom.ts (the element builder). The pure halves — what each surface says and when — live
 * in core/ (layout, sync-view, menu-model, feedback, keymap, host-context) and
 * are node-tested; these modules only bind them to the DOM.
 * Every colour comes from chrome.css on the token aliases; modules write
 * classes and data attributes, never inline colours (the one exception: a
 * peer avatar's presence colour, through safePresenceColor).
 */
import type { App } from "@modelcontextprotocol/ext-apps";

import type { DecisionViews, Insets, ViewControls } from "../core/engine.ts";
import type { PanelBadge, StateCardKind } from "../core/feedback.ts";
import type { HostState } from "../core/host-context.ts";
import type { DisplayMode, Layout, WidgetKind } from "../core/layout.ts";
import type {
  BannerAction,
  BannerOptions,
  ChromePort,
  DocLabel,
  PeerLabel,
  StateCard,
  SyncState,
  ToastSpec,
} from "../core/lifecycle.ts";
import type { MenuContext, MenuItemId } from "../core/menu-model.ts";
import type { PopoverActionId, PopoverContext } from "../core/sync-view.ts";
import type { IconName } from "../icons.ts";

// ── the skeleton ────────────────────────────────────────────────────────────

/** the static elements every entry carries (ids in mcp-app*.html); the panel
 *  asides and their toggles are per entry and come in through PanelSpec */
export interface ChromeElements {
  /** #app — data-kind (static), data-display / data-compact / data-palette /
   *  data-palette-open / data-panel (layout) and data-state (state cards) */
  app: HTMLElement;
  canvas: HTMLElement;
  tl: HTMLElement;
  /** #menu-trigger: [menu icon | sep | (comet) | #doc-name] */
  trigger: HTMLButtonElement;
  docName: HTMLElement;
  /** compact only: the palette behind Tools (#app[data-palette="tools"] shows it) */
  tools: HTMLButtonElement;
  /** bpmn: the Workshop chip-switch; dmn: the DRD | Table switch */
  modeSlot: HTMLElement;
  tr: HTMLElement;
  fullscreen: HTMLButtonElement;
  /** "Open in designIQ": .label.long / .label.short (degrade steps 2 and 5) */
  open: HTMLButtonElement;
  bl: HTMLElement;
  /** the pill's slot — the sync chrome renders a button (or the failed group) into it */
  sync: HTMLElement;
  br: HTMLElement;
  zoom: HTMLElement;
  zoomOut: HTMLButtonElement;
  zoomPct: HTMLButtonElement;
  zoomIn: HTMLButtonElement;
  zoomFit: HTMLButtonElement;
  /** bottom-centre: the decision card first, then up to three toasts */
  lane: HTMLElement;
  state: HTMLElement;
  menu: HTMLElement;
  syncPopover: HTMLElement;
  /** polite (#announce) / assertive (#alert) */
  announce: HTMLElement;
  alert: HTMLElement;
}

/** the two visually hidden live regions (§8): pill class changes and
 *  non-danger toasts speak politely; danger toasts and decision cards that
 *  did not take focus assertively */
export interface LiveRegions {
  polite(text: string): void;
  assertive(text: string): void;
  /** the pill's class change: polite, and silent when an event speaks in the
   *  same beat — one surface per transition (sync-view.ts speakBeat) */
  state(text: string): void;
}

// ── chrome/host.ts ──────────────────────────────────────────────────────────

/** the pure halves own these; the chrome modules name them through here */
export type { HostState, PanelBadge, StateCardKind };

export interface HostChrome {
  state(): HostState;
  /** every merged onhostcontextchanged — and the connect read */
  onChange(cb: (next: HostState, prev: HostState) => void): () => void;
  /** app.connect() resolved: read getHostContext() / getHostCapabilities(),
   *  declare the inline height ONCE (core/layout.ts inlineHeightFor), re-send
   *  only when the width class flips across 600 and on the return to inline */
  connected(): void;
  /** availableDisplayModes includes "fullscreen" */
  fullscreenOffered(): boolean;
  /** requestDisplayMode → resolves with the mode the host actually set (that one counts) */
  requestDisplayMode(mode: "inline" | "fullscreen"): Promise<DisplayMode>;
}

/** sets app.onhostcontextchanged and app.onteardown (→ `teardown`, then `{}`) */
export type MountHost = (app: App, deps: { teardown(): Promise<void> }) => HostChrome;

// ── chrome/layout-dom.ts ────────────────────────────────────────────────────

/**
 * Applies computeLayout to the DOM — the CSS contract (chrome.css):
 *   #app[data-display]       inline | fullscreen | pip
 *   #app[data-compact]       present when compact
 *   #app[data-palette]       column | tier1 | tier2 | tools | none
 *   #app[data-palette-open]  present while the compact palette is out (Tools pressed)
 *   #app[data-panel]         card | sheet
 *   #tl[data-step], #tr[data-step]   0…9
 *   #zoom-pct[hidden]        the readout hides when compact (Layout.showZoomPct)
 *   on #app (px): --inset-t / --inset-r / --inset-b / --inset-l, --under-row,
 *   --lane-bottom, --lane-left / --lane-w (the lane's place: centred, or
 *   beside an open card), --lane-max (its height: never up to the corner
 *   row nor an open sheet's head), --panel-w, --zoom-right, --table-right,
 *   --name-max, and --lane-h (what the lane holds: a sheet ends that much
 *   higher)
 * Measures the TL / TR widths per degrade step (hidden measuring clones —
 * the clusters are display:none while a state card owns the widget) on a
 * ResizeObserver of #app, after fonts load and on `view().onChange` (the
 * renderer palette builds and re-lays itself: palette.changed rides it).
 * Keeps the palette's last NATURAL size (a compact palette behind Tools
 * measures 0×0). Owns the Tools button.
 */
export interface LayoutChrome {
  /** measured now (an import fit reads its insets here — never stale) */
  current(): Layout;
  /** the lane as last applied — its place and room (cheap: no re-measure) */
  lane(): Layout["lane"];
  /** the panel's shape as last applied — card or sheet (cheap: no re-measure) */
  panel(): Layout["panel"];
  /** write --lane-h now: the lane's entries changed and a focus moves right
   *  after (a decision card answered) — the ResizeObserver would only catch
   *  up before the next paint, after the focus scrolled a too-short sheet */
  syncLane(): void;
  /** re-measure and re-apply — a cluster's content changed (the name, a
   *  toggle, the chip, the view switch), a panel opened, the view switched */
  update(): void;
  /** fit the view with the current fit insets: `force` = the Fit button / ⇧1
   *  / a display-mode change (always, resets touched); else only while
   *  untouched (resize, panel toggle). Animated unless reduced motion. */
  refit(force: boolean): void;
  /** Escape layer: closes the compact palette; true when it did */
  closeTools(): boolean;
}

export type MountLayout = (deps: {
  els: ChromeElements;
  kind: WidgetKind;
  host: HostChrome;
  /** the engine's view (palette size, hasViewport) — re-read after the superseded remount */
  view(): ViewControls | undefined;
  /** a viewer: no palette, no Tools */
  readonly(): boolean;
  panelOpen(): boolean;
  /** the lane's place or room changed (a sheet opened, a resize), or the
   *  panel turned card / sheet — the toasts re-plan (ToastsChrome.fit), a
   *  sheet under a decision card folds (PanelsChrome.fold); never called for
   *  the first layout */
  onLane?(): void;
}) => LayoutChrome;

// ── chrome/menu.ts ──────────────────────────────────────────────────────────

export interface MenuChrome {
  /** the trigger's name, title and aria-label (core/menu-model.ts docName /
   *  triggerLabels) and the header; reveals the trigger */
  setDocument(doc: DocLabel): void;
  /** hidden while a state card owns the widget after a failed load */
  setVisible(visible: boolean): void;
  isOpen(): boolean;
  /** Escape layer / outside click; true when it closed */
  close(returnFocus: boolean): boolean;
  /** state the menu shows changed — re-render while open (cheap when closed) */
  refresh(): void;
}

export type MountMenu = (deps: {
  els: Pick<ChromeElements, "trigger" | "docName" | "menu">;
  /** registry id — the header's notation label (menu-model menuHeader) */
  notation: string;
  /** read at every open / refresh */
  context(): MenuContext;
  /** engine.displayName() — the header's "Order to Cash · BPMN 2.0" */
  displayName(): string | undefined;
  /** an item was activated (a Reload with unsaved edits only after its inline confirm) */
  onSelect(id: MenuItemId): void;
}) => MenuChrome;

// ── chrome/sync.ts ──────────────────────────────────────────────────────────

export interface SyncChrome {
  set(state: SyncState): void;
  setPeers(peers: PeerLabel[]): void;
  /** ChromePort.setStatus: the popover's activity line (+ the findings tooltip) */
  setActivity(text: string, tooltip?: string): void;
  /** dirty / saving / display mode moved — re-render an open popover */
  refresh(): void;
  isPopoverOpen(): boolean;
  /** Escape layer / outside click; true when it closed */
  closePopover(): boolean;
}

export type MountSync = (deps: {
  els: Pick<ChromeElements, "sync" | "syncPopover">;
  live: LiveRegions;
  /** read at render (activity and peers are the chrome's own) */
  context(): Omit<PopoverContext, "activity" | "peers">;
  fullscreen(): boolean;
  /** the popover footer and the failed group's [Retry] ("retry-now") */
  onAction(id: PopoverActionId): void;
  /** a pill click while a decision card is deferred: reopens it (true) instead of the popover */
  reopenDecision(): boolean;
}) => SyncChrome;

// ── chrome/toasts.ts ────────────────────────────────────────────────────────

export interface ToastsChrome {
  /** newest at the bottom; a same-`key` toast is replaced; which show is
   *  core/feedback.ts planLane (two, one beside a decision card, what fits) */
  show(t: ToastSpec): void;
  dismiss(key: string): void;
  /** re-plan the lane: a decision card came, went or changed; the room changed */
  fit(): void;
}

export type MountToasts = (deps: {
  lane: HTMLElement;
  live: LiveRegions;
  /** where the focus goes when the toast holding it leaves (the pill) */
  fallbackFocus?: () => HTMLElement | null;
  /** what the lane may hold, a decision card counted (Layout.lane.room); unbounded when absent */
  room?: () => number;
}) => ToastsChrome;

// ── chrome/decision.ts ──────────────────────────────────────────────────────

export interface DecisionChrome {
  /** replaces any card; actions in the lifecycle's order (one `primary`,
   *  `danger` kept); a superseded card arrives with the shell's Open action */
  show(title: string, actions: BannerAction[], opts: BannerOptions): void;
  hide(): void;
  /** "Decide later" collapsed it into the pill */
  isDeferred(): boolean;
  /** the pill click while deferred */
  reopen(): void;
  /** a card is on screen (not deferred into the pill) */
  isShown(): boolean;
  /** bring the shown card back to attention: its primary choice takes the focus */
  focus(): boolean;
}

export type MountDecision = (deps: {
  lane: HTMLElement;
  live: LiveRegions;
  /** where focus returns on resolve when nothing in the widget had it (the pill) */
  fallbackFocus(): HTMLElement | null;
  /** the card came, went, collapsed into the pill or re-rendered — the
   *  toasts beside it re-plan (ToastsChrome.fit) */
  onChange?(): void;
}) => DecisionChrome;

// ── chrome/state-card.ts ────────────────────────────────────────────────────

export interface StateCardSpec extends Omit<StateCard, "kind"> {
  kind: StateCardKind;
}
export interface StateAction {
  label: string;
  primary?: boolean;
  icon?: IconName;
  run(): void;
}

export interface StateChrome {
  /** a card owns the widget: #app[data-state=<kind>], `inert` on #canvas,
   *  the work chrome hidden by CSS; undefined clears all three */
  show(card: StateCardSpec | undefined): void;
  current(): StateCardKind | undefined;
}

export type MountStateCards = (deps: {
  els: Pick<ChromeElements, "app" | "canvas" | "state">;
  /** "Event Storming" — "The Event Storming modeler could not start" */
  notationLabel: string;
  /** a previous import landed: the card floats over the inert canvas instead
   *  of the paper ground (.state.paper — the dot grid) */
  hasCanvas(): boolean;
  /** at most two (§5.3): Try again, Open in designIQ, Ask the assistant */
  actions(card: StateCardSpec): StateAction[];
}) => StateChrome;

// ── chrome/zoom.ts ──────────────────────────────────────────────────────────

export interface ZoomChrome {
  /** shown only while `view.hasViewport()`; re-bound after the superseded remount */
  bind(view: ViewControls | undefined): void;
}

export type MountZoom = (deps: {
  els: Pick<ChromeElements, "zoom" | "zoomOut" | "zoomPct" | "zoomIn" | "zoomFit">;
  /** the Fit button: layout.refit(true) */
  fit(): void;
}) => ZoomChrome;

// ── chrome/panel.ts ─────────────────────────────────────────────────────────

export interface PanelSpec {
  id: "todos" | "checks";
  /** the aside (#todos / #checks) */
  panel: HTMLElement;
  /** the TR toggle (#todo-toggle / #checks-toggle) — starts hidden */
  toggle: HTMLButtonElement;
  /** the h2 (tabindex=-1) focused on open */
  heading: HTMLElement;
  /** the panel's own Escape layer (an open inline form) — true when it closed something */
  escape?(): boolean;
  onOpen?(): void;
  onClose?(): void;
}

export interface PanelHandle {
  /** one panel at a time; focus moves to the heading */
  open(): void;
  /** focus returns to the toggle */
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** a compact sheet steps aside before an element / rule is revealed; the
   *  toggle reopens it at the same scroll position */
  collapse(): void;
  /** discovery answered: the toggle appears (with the canvas); false = absent for good */
  setAvailable(available: boolean): void;
  setBadge(badge: PanelBadge | undefined): void;
}

export interface PanelsChrome {
  register(spec: PanelSpec): PanelHandle;
  /** the open panel, if any */
  active(): PanelSpec["id"] | undefined;
  /** Escape layer: the panel's own escape() first, then closing it */
  escape(): boolean;
  /** a decision card over a sheet (core/layout.ts sheetFolds): `true` folds
   *  the open panel to its head — its body hidden, out of the tab order —,
   *  `false` unfolds it at the scroll position it folded at. Idempotent. */
  fold(folded: boolean): void;
  /** open / close / availability / badge changed (layout, menu, re-fit follow) */
  onChange(cb: () => void): () => void;
}

export type MountPanels = (deps: {
  /** card vs sheet (data-panel) */
  layout(): Layout;
  /** a panel opening closes the compact palette */
  closeTools(): void;
}) => PanelsChrome;

// ── chrome/keys.ts ──────────────────────────────────────────────────────────

/** ONE keydown listener on the widget document; ignored inside input,
 *  textarea, select and [contenteditable]; preventDefault only when handled */
export interface KeyDeps {
  /** ⌘S / Ctrl+S — false = not handled (read-only: the browser default) */
  save(): boolean;
  /** ⇧1 */
  fit(): boolean;
  /** topmost first: menu → popover → compact palette → panel (its form first);
   *  never a decision card */
  escape: Array<() => boolean>;
}

/** returns the unbind */
export type MountKeys = (doc: Document, deps: KeyDeps) => () => void;

// ── the TL slot ─────────────────────────────────────────────────────────────

/** bpmn's Workshop chip-switch (role=switch, aria-label "Workshop mode") and
 *  its menu checkbox — the same tbpmToggleAction behind both */
export interface ModeChip {
  /** the chip's visible label: "Workshop" */
  label: string;
  title: string;
  isOn(): boolean;
  toggle(): void;
  onChanged(cb: () => void): () => void;
}

// ── the composition ─────────────────────────────────────────────────────────

/** what the lifecycle's chrome needs from the composition (core/widget.ts) —
 *  lazy: called only after the lifecycle exists */
export interface ChromeActions {
  /** Save now (menu, ⌘S, popover, Retry) — lc.save() */
  save(): void;
  /** Reload latest version — lc.reload() (the menu confirmed a discard first) */
  reload(): void;
  /** app.onteardown — lc.flushNow() */
  flushNow(): Promise<void>;
  /** openLink first, flushOnLeave in parallel; a no-op without a link */
  openInDesignIQ(): void;
  /** a link can be built (publicUrl + a read document or the repo) */
  deepLink(): boolean;
  /** state cards: Try again — lc.load(lc.lastInput()), or the renderer re-load */
  retry(): void;
  /** import-failed: ui/message with the path and the parser error — only with the message capability */
  askAssistant(error: string): void;
  /** the lifecycle state the menu, the popover and ⌘S read */
  state(): {
    dirty: boolean;
    live: boolean;
    saving: boolean;
    paused: boolean;
    inactive: boolean;
    /** an editable engine is mounted */
    editable: boolean;
  };
  /** engine.displayName() */
  displayName(): string | undefined;
}

export interface ChromeOptions {
  app: App;
  /** registry notation id */
  notation: string;
  /** "model" / "decision" / "event storming board" */
  noun: string;
  /** the boot flag (LIVE_MCP_READONLY) */
  readonly: boolean;
  /** the deep-link base; absent = no Open in designIQ anywhere */
  publicUrl?: string;
  actions: ChromeActions;
}

/**
 * The chrome as core/widget.ts and the notation extras see it: the
 * lifecycle's ChromePort plus the registries the extras fill.
 */
export interface WidgetChrome extends ChromePort {
  readonly els: ChromeElements;
  readonly kind: WidgetKind;
  /** a Todos / Checks panel (main.ts / dmn-main.ts) */
  registerPanel(spec: PanelSpec): PanelHandle;
  /** bpmn editable: the Workshop chip; undefined removes it */
  setModeChip(chip: ModeChip | undefined): void;
  /** dmn: the DRD | Table switch and the menu radios; undefined removes it */
  setViewSwitch(views: DecisionViews | undefined): void;
  /** the zoom group, Tools and the fit — engine.view (lifecycle onMount, both mounts) */
  setZoom(view: ViewControls | undefined): void;
  /** EngineOptions.insets — read at every fit */
  fitInsets(): Insets;
  host(): HostState;
  /** fullscreen ↔ inline (Implement returns inline); resolves with the mode set */
  requestDisplayMode(mode: "inline" | "fullscreen"): Promise<DisplayMode>;
  /** app.connect() resolved (wireApp) */
  connected(): void;
  /** something a cluster, the menu or the popover shows changed */
  refresh(): void;
  /** a status message no toast carries (a Checks run with the card open, a
   *  scenario's outcome) — #announce, or #alert when `assertive` */
  announce(text: string, assertive?: boolean): void;
}
