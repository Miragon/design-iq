/**
 * The DMN widget engine: dmn-js Modeler (editable) or Viewer (readonly / the
 * LIVE_MCP_READONLY surface) PLUS the simulation add-on
 * (@emaarco/dmn-js-simulation), mounted into both views through the wiring
 * the live editor uses too (lib/dmn-simulation.ts):
 *
 *   drd            → run the whole decision requirements diagram
 *   decisionTable  → enter values, see which rows light up
 *
 * The add-on is a drop-in dmn-js module; everything below it is the same
 * engine (`feelin`) the Live Host evaluates with server-side, so a scenario a
 * human clicks here and one an agent simulates cannot disagree.
 *
 * Behind the widget-core engine contract — deliberately WITHOUT bindLive: a
 * decision table is edited cell by cell by one person at a time, and the CAS
 * conflict flow covers the rare collision honestly; the core keeps such an
 * engine on autosave (engine invariant 2). The moment two people co-edit
 * tables in practice, live-client's bindDmn is the one line to add.
 *
 * What it adds beyond the contract is the simulator surface (DmnSimulator)
 * the Checks card (dmn-checks.ts) and the scenario replay (dmn-main.ts) need:
 * read the values currently entered in the table simulator (to turn them
 * into a test case), write values into it (to replay a stored case on the
 * canvas), switch to a decision-table view (the simulator only exists there).
 * The frameless chrome adds the view switch (DecisionViews: the TL segmented
 * control and the menu radios), `scenario()` — the add-on's store of the
 * active table wrapped for the widget-owned "Try a scenario" form (the
 * add-on's own form is hidden by CSS, never reparented), `revealMatch()` for
 * a replayed rule — and a `view` that is the DRD's canvas (the table view has
 * no viewport: it scrolls).
 *
 * Both value crossings go through `variableOf` from the shared library rather
 * than a local guess, because the two sides do NOT hold the same thing: the
 * simulator holds a column's value (what the input expression computed), a
 * scenario holds a variable's value (what the model reads). They coincide for
 * a plain read and for nothing else — see the note on variableOf in
 * @designiq/decisions.
 *
 * Edit tracking: dmn-js does NOT re-emit editing events on the manager —
 * every view is its own viewer with its own command stack, and an inactive
 * viewer's stack never fires. So subscribe per viewer, for its lifetime (the
 * same shape live-client/dmn-sync.ts uses for the web editor). Whatever a
 * view switch or an import raises is muted (engine invariant 1).
 */
import { type Scenario, variableOf } from "@designiq/decisions";
import DmnModeler from "dmn-js/lib/Modeler";
import DmnViewer from "dmn-js/lib/Viewer";

import { withDrdCanvasTheme } from "@/lib/canvas-theme";
import { dmnSimulationViews } from "@/lib/dmn-simulation";

import type {
  DecisionView,
  DecisionViews,
  EngineFactory,
  Insets,
  PaletteControls,
  ScenarioInput,
  ScenarioOutcome,
  ScenarioSurface,
  ScenarioValue,
  ViewControls,
  WidgetEngine,
} from "../core/engine.ts";
import { type DiagramView, diagramView } from "./diagram-js.ts";

/** an evaluation as the add-on's store reports it (EvaluationResult) */
interface EvaluationLike {
  matchedRuleIndices: number[];
  reportedRuleIndices: number[];
  outputs: Array<Record<string, unknown>>;
  aggregation?: { fn: string; output: string; value: number | null };
  violation?: string;
}

/** the simulation store of the ACTIVE decision-table view (add-on internals we
 *  depend on deliberately — its published surface, see SimulationStore.d.ts) */
interface SimulationStoreLike {
  getModel(): {
    decisionId: string;
    decisionName: string;
    inputs: Array<{
      id: string;
      expression: string;
      label: string;
      typeRef: string;
      options: string[];
      min?: string;
      max?: string;
    }>;
    rules: Array<{ id: string }>;
  } | null;
  getValues(): ScenarioValue[];
  getResult(): EvaluationLike | null;
  setValue(index: number, value: ScenarioValue): void;
  run(): EvaluationLike | null;
  reset(): void;
  subscribe(listener: () => void): () => void;
}

/** a scenario as the platform speaks it: variable name → value. THE library's
 *  type — the widget and the Live Host mean the same thing by it. */
export type { Scenario };

/** what the table simulator currently holds, in scenario terms */
export interface CapturedScenario {
  scenario: Scenario;
  /** labels of columns whose expression is not a plain variable read, so their
   *  value cannot be stated as a scenario — reported, never silently dropped */
  unmappable: string[];
}

/** the simulator surface the DMN extras (the Checks card, scenario replay) drive */
export interface DmnSimulator {
  /** the values currently entered in the table simulator, keyed by variable */
  currentScenario(): CapturedScenario | undefined;
  /** load a scenario into the table simulator and evaluate it */
  applyScenario(scenario: Scenario): boolean;
  /**
   * Switch to a decision table view — the simulator only exists there, and
   * dmn-js opens the DRD first whenever the model has DMNDI. Without an id:
   * the only table, if the model has exactly one.
   */
  openDecisionTable(decisionId?: string): Promise<boolean>;
}

export interface DmnEngine extends WidgetEngine, DmnSimulator, DecisionViews {
  /** the DRD's canvas; `hasViewport()` is false in a table / literal view */
  view: ViewControls;
  /** the add-on's store of the active table, wrapped (core/engine.ts) */
  scenario(): ScenarioSurface;
  /** scroll the first rule the add-on highlights (`tr.dmn-sim-match`) into
   *  the table's view — a replayed case lands on its row, not off-screen */
  revealMatch(): void;
}

const outcome = (r: EvaluationLike | null | undefined): ScenarioOutcome | undefined =>
  r
    ? {
        matched: [...r.matchedRuleIndices],
        reported: [...r.reportedRuleIndices],
        outputs: r.outputs,
        ...(r.aggregation ? { aggregation: r.aggregation } : {}),
        ...(r.violation ? { violation: r.violation } : {}),
      }
    : undefined;

export const mountDmnEngine: EngineFactory<DmnEngine> = (container, readonly, opts) => {
  // the CI DRD, exactly as the web editor renders it (lib/canvas-theme.ts)
  const options = { container, ...withDrdCanvasTheme(dmnSimulationViews) };
  const instance = readonly ? new DmnViewer(options) : new DmnModeler(options);

  const dirtyCbs = new Set<() => void>();
  // > 0 while an import or a view switch runs — whatever a viewer's stack
  // raises in that window is engine housekeeping, never a user edit
  let quiet = 0;
  const muted = async <T>(run: () => Promise<T>): Promise<T> => {
    quiet++;
    try {
      return await run();
    } finally {
      quiet--;
    }
  };

  /** the active view's simulation store, when the active view is a table.
   *  Read on demand rather than cached — each view is its own injector, so the
   *  store is a different object after every view switch. */
  const store = (): SimulationStoreLike | undefined => {
    try {
      // strict:false — the DRD and literal-expression views have no store
      return instance.getActiveViewer()?.get("simulationStore", false) as SimulationStoreLike | undefined;
    } catch {
      return undefined;
    }
  };

  const subscribed = new Set<{ on(e: string, cb: () => void): void; off(e: string, cb: () => void): void }>();
  const onChanged = (): void => {
    if (quiet > 0) return;
    for (const cb of dirtyCbs) cb();
  };
  if (!readonly) {
    const subscribe = (viewer: unknown): void => {
      const target = viewer as { on(e: string, cb: () => void): void; off(e: string, cb: () => void): void } | null;
      if (!target || subscribed.has(target)) return;
      subscribed.add(target);
      target.on("commandStack.changed", onChanged);
    };
    instance.on("viewer.created", ((event: { viewer?: unknown }) => subscribe(event?.viewer)) as never);
    instance.on("views.changed", () => subscribe(instance.getActiveViewer()));
    subscribe(instance.getActiveViewer());
  }

  // ── the views (DRD | one table per decision) ──
  const definitions = (): { name?: string; id?: string } | undefined =>
    (instance as { getDefinitions?(): { name?: string; id?: string } | undefined }).getDefinitions?.();
  const toView = (v: { type: string; element?: { id?: string; name?: string } }): DecisionView | undefined => {
    if (v.type === "drd")
      return { id: "drd", name: definitions()?.name?.trim() || "Decision requirements", type: "drd" };
    if (v.type !== "decisionTable" && v.type !== "literalExpression") return undefined;
    const id = v.element?.id;
    return id ? { id, name: v.element?.name?.trim() || id, type: v.type } : undefined;
  };
  const views = (): DecisionView[] => instance.getViews().flatMap((v) => toView(v) ?? []);
  const activeView = (): DecisionView | undefined => {
    const v = instance.getActiveView();
    return v ? toView(v) : undefined;
  };

  // ── the DRD canvas: each dmn-js view is its own viewer, so the controls
  // follow the DRD viewer while it is the active one ──
  const viewListeners = new Set<() => void>();
  const notifyView = (): void => {
    for (const cb of viewListeners) cb();
  };
  let drd: { viewer: unknown; view: DiagramView; off: () => void } | undefined;
  const drdView = (): DiagramView | undefined => {
    if (instance.getActiveView()?.type !== "drd") return undefined;
    const viewer = instance.getActiveViewer();
    if (!viewer) return undefined;
    if (drd?.viewer !== viewer) {
      drd?.off();
      drd?.view.destroy();
      const view = diagramView(viewer as never, opts ? { insets: drdInsets } : {});
      drd = { viewer, view, off: view.onChange(notifyView) };
    }
    return drd.view;
  };
  const palette: PaletteControls | undefined = readonly
    ? undefined
    : {
        open: () => drdView()?.palette?.open(),
        close: () => drdView()?.palette?.close(),
        isOpen: () => drdView()?.palette?.isOpen() ?? false,
        size: () => drdView()?.palette?.size() ?? { w: 0, h: 0 },
      };
  const view: ViewControls = {
    hasViewport: () => drdView() !== undefined,
    fit: (insets, animate) => drdView()?.fit(insets, animate),
    stepZoom: (direction) => drdView()?.stepZoom(direction),
    zoomTo: (level) => drdView()?.zoomTo(level),
    level: () => drdView()?.level() ?? 1,
    isTouched: () => drdView()?.isTouched() ?? false,
    onChange(cb) {
      viewListeners.add(cb);
      return () => viewListeners.delete(cb);
    },
    ...(palette ? { palette } : {}),
  };
  /** the chrome's insets plus the DRD's own cards the chrome does not know:
   *  the definitions card under the row (top-left, beside the palette) and
   *  the add-on's "Simulate DRD" card in the right slot — the fitted diagram
   *  keeps clear of both, like it does of the Checks card */
  const drdInsets = (): Insets => {
    const base = opts!.insets();
    const frame = container.getBoundingClientRect();
    const defs = container.querySelector<HTMLElement>(".dmn-definitions");
    const sim = container.querySelector<HTMLElement>(".dmn-sim-decision-requirements-diagram-panel");
    let { top, right } = base;
    if (defs?.offsetParent) top = Math.max(top, defs.getBoundingClientRect().bottom - frame.top + 12);
    // hidden (display:none) while the Checks card holds the slot
    if (sim?.offsetParent) right = Math.max(right, frame.right - sim.getBoundingClientRect().left + 12);
    return { ...base, top, right };
  };
  /** after an import or a switch onto the DRD: fit while untouched — one task
   *  late, like diagramView's own import fit: the DRD's controls are created
   *  lazily AFTER importXML (they never see its import.done), and the cards
   *  drdInsets measures render in the import's own continuation */
  let fitTimer: ReturnType<typeof setTimeout> | undefined;
  const drdFit = (): void => {
    if (!opts) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = undefined;
      drdView()?.importFit();
    }, 0);
  };

  // ── the scenario surface: the ACTIVE table's store, re-bound per switch ──
  const scenarioSubs = new Set<() => void>();
  let unbindStore: (() => void) | undefined;
  const notifyScenario = (): void => {
    for (const cb of scenarioSubs) cb();
  };
  const bindStore = (): void => {
    unbindStore?.();
    unbindStore = scenarioSubs.size > 0 ? store()?.subscribe(notifyScenario) : undefined;
  };
  const onViews = (): void => {
    bindStore();
    notifyView();
    notifyScenario();
  };
  instance.on("views.changed", onViews);
  const scenario: ScenarioSurface = {
    ready: () => store()?.getModel() != null,
    decision: () => {
      const model = store()?.getModel();
      return model ? { id: model.decisionId, name: model.decisionName || model.decisionId } : undefined;
    },
    inputs: () =>
      (store()?.getModel()?.inputs ?? []).map((input): ScenarioInput => {
        const variable = variableOf(input.expression);
        return {
          id: input.id,
          label: input.label || input.expression,
          expression: input.expression,
          ...(variable ? { variable } : {}),
          typeRef: input.typeRef,
          options: input.options ?? [],
          ...(input.min !== undefined ? { min: input.min } : {}),
          ...(input.max !== undefined ? { max: input.max } : {}),
        };
      }),
    values: () => store()?.getValues() ?? [],
    set: (index, value) => store()?.setValue(index, value),
    run: () => outcome(store()?.run()),
    result: () => outcome(store()?.getResult()),
    reset: () => store()?.reset(),
    subscribe(cb) {
      scenarioSubs.add(cb);
      if (scenarioSubs.size === 1) bindStore();
      return () => {
        scenarioSubs.delete(cb);
        if (scenarioSubs.size === 0) bindStore();
      };
    },
  };

  return {
    editable: !readonly,
    view,
    importText: (xml) =>
      muted(async () => {
        await instance.importXML(xml);
        drdFit();
      }),
    async exportText(): Promise<string> {
      if (readonly) throw new Error("read-only view");
      const { xml } = await (instance as DmnModeler).saveXML({ format: true });
      if (!xml) throw new Error("empty model");
      return xml;
    },
    onDirty(cb: () => void): () => void {
      dirtyCbs.add(cb);
      return () => dirtyCbs.delete(cb);
    },
    currentScenario(): CapturedScenario | undefined {
      const active = store();
      const model = active?.getModel();
      if (!active || !model) return undefined;
      const values = active.getValues();
      const scenario: Scenario = {};
      const unmappable: string[] = [];
      model.inputs.forEach((input, n) => {
        const value = values[n];
        // an unset column is left out — a partial scenario is still a scenario
        if (value === undefined || value === "") return;
        const variable = variableOf(input.expression);
        // a computed column (`upper case(kundentyp)`) holds a RESULT, not a
        // variable's value: writing it into a case would key the scenario on
        // something the model never reads, and the case would fail on save
        if (!variable) return void unmappable.push(input.label || input.expression);
        scenario[variable] = value;
      });
      return { scenario, unmappable };
    },
    views,
    activeView,
    openView: (id) =>
      muted(async () => {
        const target = instance.getViews().find((v) => toView(v)?.id === id);
        if (!target) return false;
        await instance.open(target);
        drdFit();
        return true;
      }),
    onViewsChanged(cb) {
      instance.on("views.changed", cb);
      return () => instance.off("views.changed", cb);
    },
    displayName: () => definitions()?.name?.trim() || undefined,
    scenario: () => scenario,
    openDecisionTable: (decisionId) =>
      muted(async () => {
        const tables = instance.getViews().filter((v) => v.type === "decisionTable");
        const target = decisionId ? tables.find((v) => v.element?.id === decisionId) : tables.length === 1 && tables[0];
        if (!target) return false;
        await instance.open(target);
        return true;
      }),
    revealMatch(): void {
      const row = container.querySelector<HTMLElement>(".dmn-decision-table-container tbody tr.dmn-sim-match");
      // table-js scrolls the table in its own container; scrollIntoView would
      // also move the padded, overflow-hidden pane around it (the corner insets)
      const scroller = row?.closest<HTMLElement>(".tjs-table-container");
      if (!row || !scroller) return;
      const r = row.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      // a sticky head covers the first rows; a scrolling one does not
      const thead = scroller.querySelector("thead");
      const sticky = thead && getComputedStyle(thead.querySelector("th") ?? thead).position === "sticky";
      const head = sticky ? thead.getBoundingClientRect().height : 0;
      const margin = 8;
      if (r.top < s.top + head) scroller.scrollTop -= s.top + head - r.top + margin;
      else if (r.bottom > s.bottom) scroller.scrollTop += r.bottom - s.bottom + margin;
    },
    applyScenario(scenario: Scenario): boolean {
      const active = store();
      const model = active?.getModel();
      if (!active || !model) return false;
      active.reset();
      let applied = false;
      model.inputs.forEach((input, n) => {
        const variable = variableOf(input.expression);
        if (!variable || !(variable in scenario)) return;
        active.setValue(n, scenario[variable] ?? null);
        applied = true;
      });
      if (applied) active.run();
      return applied;
    },
    destroy(): void {
      clearTimeout(fitTimer);
      for (const viewer of subscribed) viewer.off("commandStack.changed", onChanged);
      subscribed.clear();
      instance.off("views.changed", onViews);
      unbindStore?.();
      scenarioSubs.clear();
      drd?.off();
      drd?.view.destroy();
      viewListeners.clear();
      instance.destroy();
    },
  };
};
