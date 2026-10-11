/**
 * The engine contract the widget core drives — the @miragon/modeler-api
 * profile as designIQ consumes it (this core is its first consumer): import and
 * export the document TEXT, report user edits, optionally hand the canvas to
 * a Y.Text. Two invariants the lifecycle relies on:
 *
 *  1. importText never fires onDirty. The Miragon DSL renderers run
 *     commandStack.clear() inside importDSL, which EMITS 'commandStack.changed'
 *     (bpmn-js clears silently) — an adapter suppresses that echo exactly like
 *     live-client's miragon-sync does, or every load and every conflict reload
 *     would autosave a canonicalised file over the hand-authored one.
 *  2. bindLive is a CAPABILITY. Absent = the widget stays on CAS autosave —
 *     the DMN widget's deliberate mode (engines/dmn.ts); any renderer without
 *     a live-client binding mounts the same way.
 *
 * The frameless chrome (spec §2.5) adds two optional capabilities: `view`
 * (fit with insets, zoom, the renderer palette — what the zoom group, the
 * Tools button and the layout drive) and `displayName` (the menu header).
 * Anything a notation's extras need beyond this (bpmn: the raw bpmn-js
 * instance for todos / t.BPM; dmn: the simulator surface and the views) rides
 * on the concrete engine type, never here.
 * Pure types: this module is imported by the node --test suites, so it must
 * never pull DOM-bound code.
 */
import type * as Y from "yjs";

import type { PresenceSurface } from "../../lib/presence-canvas.ts";

/** px from each frame edge the fitted content keeps clear (core/layout.ts fitInsets) */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** what a live binding may report back while the Y.Text owns the canvas */
export interface LiveBindHooks {
  /** overlapping concurrent edit — the remote change won (model-sync rule 4) */
  onConflict(message: string): void;
  /** a remote snapshot did not import — reported by the binds that support it
   *  (bindBpmn reports nothing; the core tolerates silence) */
  onImportError(message: string): void;
  /** live presence (#115): publish this canvas's pointer/selection, render
   *  the peers' — the diagram-js engines attach lib/presence-canvas to it.
   *  Absent = the session has no awareness (tests, older cores). */
  presence?: PresenceSurface;
}

/** the renderer palette as the chrome moves it (bpmn/DRD: the left column;
 *  Miragon: top-centre tier 1/2; compact: closed behind Tools) */
export interface PaletteControls {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** its natural size while open (0×0 when not rendered) — layout + fit insets */
  size(): { w: number; h: number };
}

/**
 * The view as the chrome drives it (zoom group, ⇧1, the auto-fit). Auto-fit
 * until touched: the controls remember the last fitted viewbox; any viewbox
 * change a fit did not cause marks the view touched, and only `fit()` resets
 * it. The chrome re-fits on resize / panel toggle / live re-import ONLY while
 * `!isTouched()`, and always on a display-mode change and the Fit button.
 */
export interface ViewControls {
  /** false where there is nothing to zoom (the DMN table view) */
  hasViewport(): boolean;
  /** fit the content into the frame minus `insets`, ≤ 100 %; `animate` = the
   *  250 ms --cd-ease re-fit (the caller passes false under reduced motion) */
  fit(insets: Insets, animate: boolean): void;
  /** multiplicative step around the viewport centre (−0.2 / +0.2) */
  zoomBy(step: number): void;
  /** 1 = 100 %, around the viewport centre */
  zoomTo(level: number): void;
  /** the current zoom level (1 = 100 %) */
  level(): number;
  /** the user moved the view since the last fit */
  isTouched(): boolean;
  /** viewbox changes, view switches, (re-)imports — the readout re-reads level() */
  onChange(cb: () => void): () => void;
  palette?: PaletteControls;
  /** touch-only devices (phase 2) */
  undo?: { canUndo(): boolean; canRedo(): boolean; undo(): void; redo(): void };
}

export interface WidgetEngine {
  /** false on the viewer (the LIVE_MCP_READONLY boot flag, or the superseded
   *  freeze): no save, onDirty never fires, no live upgrade */
  readonly editable: boolean;
  /** parse + render the document text in the notation's own format. Rejects
   *  on an unrenderable document — the caller keeps its previous canvas AND
   *  its previous baseVersion. Must not fire onDirty (invariant 1). Fits with
   *  `opts.insets()` while the view is untouched (plain fit-viewport without
   *  the option). */
  importText(text: string): Promise<void>;
  /** the current canvas as the exact text a CAS save sends — the same
   *  serialization the SPA's live binding exports (formatted XML, canonical
   *  DSL, pretty JSON), so the byte lineage stays shared. Rejects on a viewer. */
  exportText(): Promise<string>;
  /** a USER edit changed the document (command stack, config). Never during
   *  importText, never on a viewer. Returns the unsubscribe. */
  onDirty(cb: () => void): () => void;
  /** the single selected element's id (labels resolve to their target), or
   *  undefined — a capability: today only the bpmn deep link reads it */
  selectedElementId?(): string | undefined;
  /** hand the canvas to the SPA's Y.Text binding; returns the unbind. Called
   *  at most once per live session, on an editable engine, AFTER the core
   *  flushed unsaved state. Absent = no live binding for this notation. */
  bindLive?(ytext: Y.Text, doc: Y.Doc, hooks: LiveBindHooks): () => void;
  /** fit / zoom / palette — absent = no zoom group, no Tools */
  view?: ViewControls;
  /** the model's own name for the menu header ("Order to Cash"): bpmn the
   *  participant or process name, dmn the definitions name; undefined = the
   *  header shows the notation label alone */
  displayName?(): string | undefined;
  destroy(): void;
}

/** an engine the core may upgrade to live — bindLive present */
export type LiveEngine = WidgetEngine & Required<Pick<WidgetEngine, "bindLive">>;

export interface EngineOptions {
  /** the layout's current fit insets (core/layout.ts fitInsets), read at every fit */
  insets(): Insets;
}

/** mounts the engine into the widget's #canvas — editor or viewer */
export type EngineFactory<E extends WidgetEngine = WidgetEngine> = (
  container: HTMLElement,
  readonly: boolean,
  opts?: EngineOptions,
) => E;

// ── the decision engine's extra surface (engines/dmn.ts implements it) ──────
// Pure types here so the Checks panel, the menu and the node suites share them.

export type DecisionViewType = "drd" | "decisionTable" | "literalExpression";

/** one dmn-js view: the DRD, or one decision's table / literal expression */
export interface DecisionView {
  /** stable across re-imports: "drd", else the decision element's id */
  id: string;
  /** the decision's name (falls back to its id); the DRD's is the definitions name */
  name: string;
  type: DecisionViewType;
}

/** the view switch (TL segmented control, menu radios, the auto-switch on replay) */
export interface DecisionViews {
  views(): DecisionView[];
  activeView(): DecisionView | undefined;
  /** false when no such view exists (a stale id after a re-import) */
  openView(id: string): Promise<boolean>;
  /** dmn-js `views.changed` — a switch, an import; returns the unsubscribe */
  onViewsChanged(cb: () => void): () => void;
}

/** a simulator value as the add-on's store holds it (its RawValue) */
export type ScenarioValue = string | number | boolean | null | undefined;

/** one input column of the active decision table — what the "Try a scenario"
 *  form builds a field from (a select when `options` is non-empty) */
export interface ScenarioInput {
  id: string;
  /** the column label (falls back to the expression) */
  label: string;
  /** the FEEL input expression */
  expression: string;
  /** the variable a plain read names — undefined for a computed column, whose
   *  value a test case cannot state (`variableOf`, @designiq/decisions) */
  variable?: string;
  /** DMN typeRef: string, integer, boolean, date, … */
  typeRef: string;
  /** the distinct string literals the column tests — drives a select */
  options: string[];
  /** native min / max, only when the rules bound the column on that side */
  min?: string;
  max?: string;
}

/** the last evaluation — rule indices are 0-based in table order (the copy
 *  prints `index + 1`: "Rule 3") */
export interface ScenarioOutcome {
  matched: number[];
  /** the rules the hit policy reports (what the decision returns) */
  reported: number[];
  /** one output object per reported rule, keyed by output name */
  outputs: Array<Record<string, unknown>>;
  /** COLLECT with SUM / MIN / MAX / COUNT */
  aggregation?: { fn: string; output: string; value: number | null };
  /** the hit policy's constraint broke (UNIQUE matched twice) */
  violation?: string;
}

/**
 * The simulation add-on's store of the ACTIVE decision table, wrapped: every
 * call reads the current store (each dmn-js view is its own injector, so the
 * store is a different object after a view switch), and `subscribe` re-binds
 * on `views.changed`. The add-on paints the rule highlight itself; the widget
 * never reparents its DOM. A stable object for the engine's lifetime —
 * `ready()` says whether a table (and with it a store) is on screen.
 */
export interface ScenarioSurface {
  ready(): boolean;
  /** the active table's decision */
  decision(): { id: string; name: string } | undefined;
  inputs(): ScenarioInput[];
  values(): ScenarioValue[];
  /** set one input (index into inputs()); invalidates the last result */
  set(index: number, value: ScenarioValue): void;
  run(): ScenarioOutcome | undefined;
  result(): ScenarioOutcome | undefined;
  reset(): void;
  /** store changes (values, result, model refresh) and view switches */
  subscribe(cb: () => void): () => void;
}
