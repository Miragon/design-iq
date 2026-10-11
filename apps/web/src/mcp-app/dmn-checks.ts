/**
 * The decision widget's Checks card (spec §6.4, §7.2): the SPA's "Decision
 * checks" order as stacked, collapsible sections, on the chrome's panel shell
 * (chrome.registerPanel — a card, a sheet when compact):
 *
 *   Findings        analyze_decision on the STORED decision (broken FEEL, dead
 *                   rules …) — the SPA's Finding rows; hidden without the tool
 *   Try a scenario  a widget-owned form on the add-on's own simulationStore of
 *                   the active table (engine.scenario()): the add-on still
 *                   paints the rule highlight, its form is hidden by CSS and
 *                   never reparented. An outcome becomes a test case through
 *                   "Save as test case" — the server records what the decision
 *                   produces today (golden master), so tacit knowledge someone
 *                   just clicked becomes a reviewable file in the release PR
 *   Test cases      run_decision_tests: failing first; a click replays the case
 *                   ON the table (switching off the DRD first), which is the
 *                   better error message
 *
 * The verdict lives on the TR toggle (PanelBadge), never in the sync pill —
 * test results are not the save state (§5.4). The card never evaluates
 * anything itself: expectations are compared server-side, so a case that
 * passes here passes in CI. Discovery runs from onRead, in parallel with the
 * import, so the toggle is capability-gated up front and carries its verdict
 * from boot; after a landed save both checks run again (at most every 5 s).
 * The wording is core/checks-view.ts (tested); this file only draws.
 */
import type { Scenario } from "@designiq/decisions";
import type { TestCase } from "@designiq/decisions/tests";
import type { App } from "@modelcontextprotocol/ext-apps";

import { CASE_STATUS_LABEL, type CaseStatus } from "@/lib/decision-view";

import {
  analyzeDecision,
  type DecisionAnalysisWire,
  getDecisionTests,
  isMissingTool,
  type ProcessRef,
  runDecisionTests,
  saveDecisionTests,
  type SuiteRunWire,
} from "./bridge";
import type { PanelHandle, WidgetChrome } from "./chrome/contracts";
import { h } from "./chrome/dom";
import {
  capturedTitle,
  caseLines,
  type CaseRow,
  caseRows,
  type Chip,
  coverageLine,
  coverageRules,
  fieldKind,
  findingRows,
  findingsChip,
  givenLine,
  matchesCase,
  NO_FINDINGS,
  ruleIdNumbers,
  ruleNumbering,
  runToast,
  scenarioSummary,
  selectOptions,
  suiteChip,
  toggleBadge,
  typedScenario,
} from "./core/checks-view";
import type { ScenarioInput } from "./core/engine";
import type { DmnEngine } from "./engines/dmn";
import { icon, type IconName } from "./icons";
import { el } from "./shell";

/** a case's state as a Lucide icon — its SHAPE tells the states apart, the
 *  colour (dmn-styles.css) only repeats it; the spoken name is the SPA's */
const CASE_ICON: Record<CaseStatus, IconName> = {
  pass: "circle-check",
  fail: "circle-x",
  pending: "circle-question-mark",
  unrun: "circle-dashed",
};

/** both re-checks after a landed save: at most one per this */
const RECHECK_MS = 5000;

export interface ChecksHandle {
  /** onRead: the document is known — discovery (tests + findings) */
  read(ref: ProcessRef): void;
  /** a save landed — the stored decision changed: re-run what depends on it */
  saved(ref: ProcessRef): void;
  /** superseded: the toggle and the card go for good */
  destroy(): void;
}

type SectionId = "findings" | "scenario" | "cases";

interface Section {
  root: HTMLElement;
  row: HTMLButtonElement;
  sum: HTMLElement;
  body: HTMLElement;
}

/** quoted values in mono, like the table writes them: `Rule 3 → "approve"` */
function withCode(text: string): Array<Node | string> {
  return text.split(/("[^"]*")/).map((part, i) => (i % 2 === 1 ? h("code", {}, part) : part));
}

/** the outcome strip's words (a hit-policy violation rides beside them) */
function stripLine(summary: ReturnType<typeof scenarioSummary>): string {
  if (summary.miss) return "No rule matches";
  return summary.rules ? `${summary.rules} · ${summary.value ?? "null"}` : summary.line;
}

function chipNode(chip: Chip): HTMLElement {
  const node = h("span", { class: `verdict ${chip.tone}` });
  if (chip.spinner) node.append(icon("loader-circle", 12, "spin"));
  else if (chip.icon) node.append(icon(chip.icon, 12));
  node.append(chip.text);
  return node;
}

export function mountChecks(deps: {
  app: App;
  engine: DmnEngine;
  readonly: boolean;
  chrome: WidgetChrome;
}): ChecksHandle {
  const { app, engine, readonly, chrome } = deps;
  const panel = el<HTMLElement>("checks");
  const toggle = el<HTMLButtonElement>("checks-toggle");
  const heading = el<HTMLElement>("checks-h");
  const runBtn = el<HTMLButtonElement>("test-run");
  const hideBtn = el<HTMLButtonElement>("test-hide");
  const scenario = engine.scenario();

  // ── state ──
  let ref: ProcessRef | undefined;
  /** bumps per document and on destroy — a stale answer bails out */
  let generation = 0;
  let destroyed = false;
  // the suite (get_decision_tests / run_decision_tests)
  let cases: TestCase[] | undefined; // undefined = not loaded
  let testsVersion: string | undefined;
  let outcome: SuiteRunWire | undefined;
  let loading = false;
  let running = false;
  let suiteError: string | undefined;
  let fileConflict = false;
  let lastVerdict: { text: string; tone: "ok" | "bad" | "muted" } | undefined;
  // the findings (analyze_decision)
  let analysis: DecisionAnalysisWire | undefined;
  let findingsError: string | undefined;
  let findingsAbsent = false;
  let analyzeSeq = 0; // overlapping answers: the latest request wins
  // the card
  const expanded: Record<SectionId, boolean> = { findings: false, scenario: false, cases: true };
  let selected: number | undefined; // a suite position
  let naming: Scenario | undefined; // the scenario the open name field records
  let captureError: string | undefined;
  let saving = false;
  const timers: Partial<Record<"tests" | "findings", ReturnType<typeof setTimeout>>> = {};
  const lastCheck: Record<"tests" | "findings", number> = { tests: 0, findings: 0 };

  // ── the sections: a disclosure row (a real button) + its body ──
  function section(id: SectionId, label: string): Section {
    const root = el<HTMLElement>(`checks-${id}`);
    const body = h("div", { id: `checks-${id}-body`, class: "sect-body" });
    const sum = h("span", { class: "sum" });
    const row = h(
      "button",
      { type: "button", class: "sect-row", "aria-controls": body.id },
      icon("chevron-right", 14, "chev"),
      h("span", { class: "lbl" }, label),
      sum,
    );
    row.onclick = () => setExpanded(id, !expanded[id]);
    root.replaceChildren(row, body); // the skeleton's static rows go
    return { root, row, sum, body };
  }
  const sections: Record<SectionId, Section> = {
    findings: section("findings", "Findings"),
    scenario: section("scenario", "Try a scenario"),
    cases: section("cases", "Test cases"),
  };

  function setExpanded(id: SectionId, open: boolean): void {
    expanded[id] = open;
    const s = sections[id];
    s.row.setAttribute("aria-expanded", String(open));
    s.body.hidden = !open;
  }
  for (const id of Object.keys(sections) as SectionId[]) setExpanded(id, expanded[id]);
  sections.scenario.root.hidden = false;

  // read-only: no Save as test case — say so once, at the foot (§7)
  if (readonly) {
    panel.append(
      h(
        "div",
        { class: "panel-foot" },
        icon("eye", 14),
        h("span", {}, "Read-only here: saving test cases is disabled."),
      ),
    );
  }

  // ── the panel shell ──
  const handle: PanelHandle = chrome.registerPanel({
    id: "checks",
    panel,
    toggle,
    heading,
    // the open name field is the card's own Escape layer
    escape: () => {
      if (!naming) return false;
      closeNaming();
      return true;
    },
    onOpen: () => {
      // collapsed by default — unless a simulation is active that no
      // replayed case explains (the assistant's scenario)
      if (scenario.result() && selectedRow() === undefined && !expanded.scenario) {
        setExpanded("scenario", true);
      }
      if (cases === undefined && !loading) void loadSuite();
    },
  });
  hideBtn.onclick = () => handle.close();
  runBtn.onclick = () => void run(true);

  // ── Findings ──
  function renderFindings(): void {
    const s = sections.findings;
    s.root.hidden = findingsAbsent || !ref;
    if (s.root.hidden) return;
    const chip: Chip = analysis
      ? findingsChip(analysis)
      : findingsError
        ? { text: "Not checked", tone: "muted", icon: "circle-alert" }
        : { text: "Checking…", tone: "muted", spinner: true };
    s.sum.replaceChildren(chipNode(chip));
    if (findingsError && !analysis) {
      s.body.replaceChildren(h("div", { class: "callout danger" }, `Could not analyse the decision: ${findingsError}`));
      return;
    }
    if (!analysis) {
      s.body.replaceChildren(h("p", { class: "sect-note" }, "Analysing the saved decision…"));
      return;
    }
    const rows = findingRows(analysis);
    s.body.replaceChildren(
      rows.length === 0
        ? h("p", { class: "sect-note" }, NO_FINDINGS)
        : h(
            "ul",
            { class: "check-findings" },
            ...rows.map((r) =>
              h(
                "li",
                { class: r.severity.toLowerCase() },
                icon(r.icon, 14),
                h(
                  "div",
                  { class: "txt" },
                  h("p", {}, r.message),
                  r.where ? h("p", { class: "where" }, r.where) : undefined,
                ),
              ),
            ),
          ),
    );
  }

  async function analyze(): Promise<void> {
    if (!ref || findingsAbsent) return;
    const mine = ++analyzeSeq;
    const gen = generation;
    lastCheck.findings = Date.now();
    try {
      const next = await analyzeDecision(app, ref);
      if (gen !== generation || mine !== analyzeSeq) return;
      analysis = next;
      findingsError = undefined;
    } catch (err) {
      if (gen !== generation || mine !== analyzeSeq) return;
      // an older Live Host without the tool — the section simply is not there
      if (isMissingTool(err, "analyze_decision")) findingsAbsent = true;
      else findingsError = (err as Error).message;
    }
    renderFindings();
  }

  // ── Try a scenario (the add-on's store of the active table) ──
  let formKey = "";
  let form:
    | {
        root: HTMLElement;
        fields: Array<{ input: ScenarioInput; control: HTMLInputElement | HTMLSelectElement }>;
        strip: HTMLElement;
        stripIcon: HTMLElement;
        stripText: HTMLElement;
        known: HTMLElement;
        saveCase: HTMLButtonElement;
        name: HTMLFormElement;
        nameInput: HTMLInputElement;
        nameGiven: HTMLElement;
        nameSubmit: HTMLButtonElement;
        error: HTMLElement;
      }
    | undefined;

  function buildForm(inputs: ScenarioInput[]): NonNullable<typeof form> {
    const tables = engine.views().filter((v) => v.type === "decisionTable");
    const decision = scenario.decision();
    const fields = inputs.map((input, i) => {
      const kind = fieldKind(input);
      let control: HTMLInputElement | HTMLSelectElement;
      if (kind === "select") {
        control = h("select", { class: "input" });
        control.onchange = () => scenario.set(i, control.value);
      } else {
        const attrs: Record<string, string> = { class: "input", type: kind, placeholder: input.typeRef || "value" };
        if (input.min !== undefined) attrs.min = input.min;
        if (input.max !== undefined) attrs.max = input.max;
        control = h("input", attrs);
        control.oninput = () => scenario.set(i, control.value);
      }
      return { input, control };
    });
    const grid = h(
      "form",
      { class: "scn-grid" },
      ...fields.map(({ input, control }) =>
        h("label", { class: "scn-field", title: input.expression }, h("span", {}, input.label), control),
      ),
    );
    // Enter in a field simulates; a form post would navigate the sandboxed iframe
    grid.onsubmit = (event) => {
      event.preventDefault();
      simulate();
    };
    const simulateBtn = h("button", { type: "button", class: "pb" }, icon("play", 14), "Simulate");
    simulateBtn.onclick = () => simulate();
    const reset = h("button", { type: "button", class: "pb ghost" }, icon("rotate-ccw", 14), "Reset");
    reset.onclick = () => {
      selected = undefined;
      closeNaming();
      scenario.reset();
    };
    const stripIcon = h("span", { class: "si" });
    const stripText = h("span", { class: "txt" });
    const saveCase = h(
      "button",
      { type: "button", class: "pb", title: "Record what these values produce as a new test case" },
      "Save as test case",
    );
    saveCase.hidden = readonly;
    saveCase.onclick = () => startNaming();
    // static: re-rendering the strip must never drop the focus on its button.
    // No role=status: a region shown with its content already in it is not
    // reliably spoken — a user's Simulate announces the outcome (simulate())
    const known = h("span", { class: "known" }, "Already a test case");
    const strip = h("div", { class: "scn-strip" }, stripIcon, stripText, known, saveCase);

    // naming a case: an inline field, NEVER window.prompt() — MCP-App hosts
    // sandbox the iframe without allow-modals, where prompt() is ignored
    const nameInput = h("input", {
      class: "input",
      placeholder: "What does this case show?",
      maxlength: "200",
      required: "",
      "aria-label": "Test case name",
    });
    const nameGiven = h("p", { class: "muted given" });
    const cancel = h("button", { type: "button", class: "pb" }, "Cancel");
    cancel.onclick = () => closeNaming();
    const nameSubmit = h("button", { type: "submit", class: "pb primary" }, "Save test case");
    const name = h(
      "form",
      { class: "scn-name" },
      nameInput,
      nameGiven,
      h("div", { class: "form-actions" }, cancel, nameSubmit),
    );
    name.onsubmit = (event) => {
      event.preventDefault();
      const text = nameInput.value.trim();
      if (text && naming) void capture(text, naming);
    };
    const error = h("p", { class: "scn-error", role: "alert" });
    const root = h(
      "div",
      { class: "scn" },
      tables.length > 1 && decision ? h("p", { class: "sect-note" }, `Decision: ${decision.name}`) : undefined,
      grid,
      h("div", { class: "scn-actions" }, simulateBtn, reset),
      strip,
      name,
      error,
    );
    return {
      root,
      fields,
      strip,
      stripIcon,
      stripText,
      known,
      saveCase,
      name,
      nameInput,
      nameGiven,
      nameSubmit,
      error,
    };
  }

  /** the DRD (or a literal expression) has no store: one button per table */
  function picker(): HTMLElement {
    const tables = engine.views().filter((v) => v.type === "decisionTable");
    if (tables.length === 0) return h("p", { class: "sect-note" }, "This decision has no table to try a scenario on.");
    return h(
      "div",
      { class: "scn-pick" },
      h("p", { class: "sect-note" }, "Pick a decision table"),
      h(
        "div",
        { class: "scn-pick-list" },
        ...tables.map((t) => {
          const b = h(
            "button",
            { type: "button", class: "pb", title: `Open the table of ${t.name}` },
            icon("table-2", 14),
            t.name,
          );
          b.onclick = () => void engine.openView(t.id);
          return b;
        }),
      ),
    );
  }

  function renderScenario(): void {
    const s = sections.scenario;
    const result = scenario.result();
    const summary = result ? scenarioSummary(result) : undefined;
    s.sum.replaceChildren(...(summary ? withCode(summary.line) : []));
    if (!scenario.ready()) {
      formKey = "";
      form = undefined;
      s.body.replaceChildren(picker());
      return;
    }
    const inputs = scenario.inputs();
    const key = `${scenario.decision()?.id}|${inputs.map((i) => i.id).join(",")}`;
    if (key !== formKey || !form) {
      formKey = key;
      form = buildForm(inputs);
      s.body.replaceChildren(form.root);
    }
    // values: the store is the truth (a replay or the assistant fills it) —
    // never under the user's caret
    const values = scenario.values();
    for (const [i, { input, control }] of form.fields.entries()) {
      const value = values[i];
      const text = value === null || value === undefined ? "" : String(value);
      if (control instanceof HTMLSelectElement) {
        const options = selectOptions(input.options, value);
        const current = [...control.options].map((o) => o.value).slice(1);
        if (current.join("\n") !== options.join("\n")) {
          control.replaceChildren(
            h("option", { value: "" }, "Not set"),
            ...options.map((o) => h("option", { value: o }, o)),
          );
        }
      }
      if (control !== document.activeElement && control.value !== text) control.value = text;
    }
    form.strip.hidden = !summary;
    if (summary) {
      form.strip.classList.toggle("miss", summary.miss || summary.violation !== undefined);
      const line = stripLine(summary);
      form.stripIcon.replaceChildren(icon(summary.miss || summary.violation ? "triangle-alert" : "circle-check", 14));
      form.stripText.replaceChildren(
        ...withCode(line),
        ...(summary.violation ? [h("span", { class: "why" }, summary.violation)] : []),
      );
      // these exact values are a stored case already — saving them again would duplicate it
      const stored = cases?.some((c) => matchesCase(inputs, values, c.given)) ?? false;
      form.saveCase.hidden = readonly || naming !== undefined || stored;
      form.known.hidden = !stored;
    }
    form.name.hidden = naming === undefined;
    // aria-disabled, not disabled: the focused submit keeps the focus while
    // the save runs (capture() guards on `saving`)
    if (saving) form.nameSubmit.setAttribute("aria-disabled", "true");
    else form.nameSubmit.removeAttribute("aria-disabled");
    // the test file moved under the capture: reloaded, one more Save (§6.4)
    const message = captureError ?? (fileConflict ? "The test file changed meanwhile — reloaded it, try again." : "");
    form.error.hidden = !message;
    form.error.classList.toggle("warning", !captureError && fileConflict);
    form.error.textContent = message;
  }

  function startNaming(): void {
    captureError = undefined;
    const captured = engine.currentScenario();
    if (!captured || Object.keys(captured.scenario).length === 0) {
      captureError =
        captured && captured.unmappable.length > 0
          ? `Only computed columns are filled in (${captured.unmappable.join(", ")}). A test case states VARIABLE values, so enter a value in a column that reads one directly.`
          : "Enter values first — the case records what they produce.";
      renderScenario();
      return;
    }
    // the store holds what the inputs emit ("50000") — the case states the column's type
    naming = typedScenario(scenario.inputs(), captured.scenario);
    renderScenario();
    if (!form) return;
    form.nameGiven.textContent =
      givenLine(naming) +
      // a silently dropped column would make the case look complete when it is not
      (captured.unmappable.length > 0 ? ` — without the computed column(s) ${captured.unmappable.join(", ")}` : "");
    form.nameInput.value = "";
    form.nameInput.focus();
    reveal(form.name);
  }

  /** bring a node of the card into its scroller's view — the card's own
   *  scroller only (scrollIntoView would also move the overflow-hidden frame) */
  function reveal(node: HTMLElement): void {
    const scroller = node.closest<HTMLElement>(".panel-scroll");
    if (!scroller) return;
    const n = node.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    if (n.bottom > s.bottom) scroller.scrollTop += Math.min(n.bottom - s.bottom + 8, n.top - s.top);
    else if (n.top < s.top) scroller.scrollTop -= s.top - n.top + 8;
  }

  /** the selected case row takes the focus (revealed in the card's scroller);
   *  a collapsed list or a failed reload hands it to the scenario's row */
  function focusSelectedCase(): void {
    const row = expanded.cases
      ? sections.cases.body.querySelector<HTMLElement>(`.case[data-index="${selected}"]`)
      : null;
    if (row) {
      row.focus({ preventScroll: true });
      reveal(row);
    } else sections.scenario.row.focus({ preventScroll: true });
  }

  /** the user's Simulate: run, and say the outcome (edits and replays stay quiet) */
  function simulate(): void {
    const outcome = scenario.run();
    if (!outcome) return;
    const summary = scenarioSummary(outcome);
    chrome.announce(summary.violation ? `${stripLine(summary)}. ${summary.violation}` : stripLine(summary));
  }

  function closeNaming(): void {
    if (naming === undefined && !captureError) return;
    const hadFocus = form?.name.contains(document.activeElement) ?? false;
    naming = undefined;
    captureError = undefined;
    fileConflict = false;
    renderScenario();
    renderCases();
    if (hadFocus) form?.saveCase.focus();
  }

  /** the named case goes to the server, which records its result — no
   *  `expect`: the case states what the decision produces today, never a guess */
  async function capture(name: string, given: Scenario): Promise<void> {
    if (!ref || saving) return;
    const mine = generation;
    saving = true;
    captureError = undefined;
    renderScenario();
    try {
      if (cases === undefined) await loadSuite(false);
      const next = [...(cases ?? []), { name, given }];
      const saved = await saveDecisionTests(app, ref, next, {
        ...(testsVersion ? { baseVersion: testsVersion } : {}),
        record: true,
      });
      if (mine !== generation) return;
      if (saved.conflict) {
        // someone else wrote the file: take theirs, keep the name field — one more Save
        fileConflict = true;
        saving = false;
        await loadSuite();
        return;
      }
      testsVersion = saved.baseVersion;
      fileConflict = false;
      // the name field goes with the success — the focus it holds moves on to the new case
      const hadFocus = form?.name.contains(document.activeElement) ?? false;
      naming = undefined;
      chrome.toast({ tone: "success", title: capturedTitle(name, saved.path) });
      void app.updateModelContext({
        content: [{ type: "text", text: `User saved a test case in ${saved.path}: "${name}".` }],
      });
      selected = next.length - 1; // the store still holds its values
      saving = false;
      await loadSuite(false);
      if (mine !== generation) return;
      if (hadFocus) focusSelectedCase();
      if (cases && cases.length > 0) await run(false);
    } catch (err) {
      if (mine !== generation) return;
      captureError = isMissingTool(err, "save_decision_tests")
        ? "This connection cannot save test cases."
        : (err as Error).message;
    } finally {
      if (mine === generation) {
        saving = false;
        renderScenario();
        renderCases();
      }
    }
  }

  // ── Test cases ──
  // the freshest rule order first: the run's coverage, then the analysis
  const ruleLists = () => [outcome ? coverageRules(outcome.coverage) : undefined, analysis?.rules];
  const numbers = () => ruleNumbering(...ruleLists());
  const suiteDecision = (): string | undefined => outcome?.decision ?? analysis?.rules[0]?.decision;

  /** the selected row while the store still holds its values (a user edit deselects) */
  function selectedRow(): number | undefined {
    const testCase = selected === undefined ? undefined : cases?.[selected];
    if (!testCase || !scenario.ready()) return undefined;
    return matchesCase(scenario.inputs(), scenario.values(), testCase.given) ? selected : undefined;
  }

  /** the add-on fills a freshly opened table's store a moment after the
   *  switch — wait briefly rather than report a replay that would have worked */
  async function tableReady(): Promise<boolean> {
    for (let attempt = 0; attempt < 20 && !scenario.ready(); attempt++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return scenario.ready();
  }

  let shownSelection: number | undefined;
  function renderCases(): void {
    const s = sections.cases;
    const state = { ...(cases ? { cases: cases.length } : {}), ...(outcome ? { outcome } : {}), running };
    const chip = suiteChip(state);
    s.sum.replaceChildren(...(chip ? [chipNode(chip)] : []));
    const focusedRow = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".case")?.dataset.index;
    const sel = selectedRow();
    shownSelection = sel;
    const decision = suiteDecision() ?? "";
    const n = numbers();
    const body: Array<Node | undefined> = [];
    if (suiteError) body.push(h("div", { class: "callout danger" }, suiteError));
    if (cases === undefined) {
      if (!suiteError) body.push(h("p", { class: "sect-note" }, "Loading the test cases…"));
    } else if (cases.length === 0) {
      const tryIt = h("button", { type: "button", class: "pb" }, icon("play", 14), "Try a scenario");
      tryIt.onclick = () => {
        setExpanded("scenario", true);
        sections.scenario.body.querySelector<HTMLElement>("input, select, button")?.focus();
        reveal(sections.scenario.root);
      };
      body.push(
        h(
          "div",
          { class: "checks-empty" },
          h("p", { class: "title" }, "No test cases yet"),
          h(
            "p",
            { class: "sect-note" },
            readonly
              ? "Nothing pins this decision's behaviour yet."
              : "Try a scenario, then save its outcome as a test case.",
          ),
          tryIt,
        ),
      );
    } else {
      const list = h("div", { class: "cases" });
      const ids = ruleIdNumbers(...ruleLists());
      for (const row of caseRows(cases, outcome)) list.append(caseRow(row, row.index === sel, { n, ids, decision }));
      body.push(list);
      const coverage = outcome ? coverageLine(outcome.uncoveredRules, n, outcome.decision) : undefined;
      if (coverage) body.push(h("p", { class: "info-line" }, icon("info", 14), h("span", {}, coverage)));
    }
    s.body.replaceChildren(...body.filter((b): b is Node => b !== undefined));
    // a re-render must not drop the focus a keyboard user had on a row
    if (focusedRow !== undefined) s.body.querySelector<HTMLElement>(`.case[data-index="${focusedRow}"]`)?.focus();
  }

  function caseRow(
    row: CaseRow,
    isSelected: boolean,
    rules: { n: ReturnType<typeof numbers>; ids: Map<string, number>; decision: string },
  ): HTMLElement {
    const { testCase, result, status } = row;
    // failing rows are always open (their red lines ARE the point); the selected
    // one too. A pending row always says what it produces today — one line.
    const open = isSelected || status === "fail";
    const label = CASE_STATUS_LABEL[status];
    const item = h("button", {
      type: "button",
      class: "case",
      "aria-pressed": String(isSelected),
      "data-index": String(row.index),
      title: "Replay these values on the decision table",
    });
    const state = h(
      "span",
      { class: `st ${status}`, role: "img", "aria-label": label, title: label },
      icon(CASE_ICON[status], 16),
    );
    const text = h("span", { class: "txt" }, h("span", { class: open ? "name" : "name one" }, testCase.name));
    if (open) text.append(h("span", { class: "given" }, givenLine(testCase.given)));
    if (result && (open || status === "pending")) {
      for (const line of caseLines(result, rules.n, rules.decision, rules.ids)) {
        text.append(
          h(
            "span",
            { class: `outcome ${status}` },
            // the pass line repeats its check (mock); fail / pending speak through the row icon
            status === "pass" ? icon("circle-check", 14) : undefined,
            h("span", {}, ...withCode(line)),
          ),
        );
      }
    }
    item.append(state, text);
    item.onclick = () => void replay(row);
    return item;
  }

  /** replay ON the canvas: the decision table is the better error message */
  async function replay(row: CaseRow): Promise<void> {
    selected = row.index;
    closeNaming();
    const decision = suiteDecision();
    // the DRD (or another table) is on screen: switch to the suite's table first
    if (!scenario.ready() || (decision && scenario.decision()?.id !== decision)) {
      const opened =
        (decision ? await engine.openDecisionTable(decision).catch(() => false) : false) ||
        (await engine.openDecisionTable().catch(() => false));
      if (!opened || !(await tableReady())) {
        chrome.toast({ tone: "info", title: "Open the decision table to replay a case", key: "checks" });
        renderCases();
        return;
      }
    }
    if (!engine.applyScenario(row.testCase.given)) {
      chrome.toast({
        tone: "info",
        title: `Could not replay “${row.testCase.name}”`,
        detail: "None of its values is a column of this table.",
        key: "checks",
      });
      renderCases();
      return;
    }
    renderCases();
    // a sheet steps aside so the highlighted rule is visible — the rule IS the
    // feedback (a toast would cover it in a short frame)
    handle.collapse();
    requestAnimationFrame(() => engine.revealMatch());
  }

  function renderHead(): void {
    runBtn.disabled = !ref;
    // aria-disabled, not disabled: the focused Run keeps the focus through the
    // run (a disabled button drops it on <body>; run() guards on `running`)
    if (running) runBtn.setAttribute("aria-disabled", "true");
    else runBtn.removeAttribute("aria-disabled");
    runBtn.replaceChildren(
      running ? icon("loader-circle", 14, "spin") : icon("play", 14),
      running ? "Running…" : "Run",
    );
  }

  function renderToggle(): void {
    const state = { ...(cases ? { cases: cases.length } : {}), ...(outcome ? { outcome } : {}), running };
    const badge = toggleBadge(state, lastVerdict);
    if (badge?.verdict && !badge.verdict.spinner) lastVerdict = { text: badge.verdict.text, tone: badge.verdict.tone };
    handle.setBadge(badge);
  }

  function render(): void {
    renderHead();
    renderToggle();
    renderFindings();
    renderScenario();
    renderCases();
  }

  /** the stored suite and its concurrency token, then (with cases) a run */
  async function loadSuite(thenRun = true): Promise<void> {
    if (!ref) return;
    const mine = generation;
    loading = true;
    try {
      const stored = await getDecisionTests(app, ref);
      if (mine !== generation) return;
      cases = stored.suite?.cases ?? [];
      testsVersion = stored.baseVersion;
      suiteError = undefined;
      handle.setAvailable(true);
    } catch (err) {
      if (mine !== generation) return;
      // a host without the decision tools (older Live Host) — absent, not an error
      if (isMissingTool(err, "get_decision_tests")) {
        handle.setAvailable(false);
        return;
      }
      suiteError = `Could not load the test cases: ${(err as Error).message}`;
      handle.setAvailable(true); // the card says what went wrong
    } finally {
      if (mine === generation) loading = false;
    }
    render();
    if (thenRun && cases && cases.length > 0) await run(false);
  }

  /** runs against the SAVED decision on the server — the same engine CI uses */
  async function run(explicit: boolean): Promise<void> {
    if (!ref || running) return;
    const mine = generation;
    running = true;
    lastCheck.tests = Date.now();
    render();
    try {
      const next = await runDecisionTests(app, ref);
      if (mine !== generation) return;
      outcome = next;
      suiteError = undefined;
      // the card shows it all; a toast only when nobody is looking (§6.4) —
      // with the card open the verdict is spoken instead (its chips are no live region)
      const t = runToast(next);
      if (explicit && !handle.isOpen()) {
        chrome.toast({
          ...t,
          key: "checks",
          ...(t.tone === "danger" ? { action: { label: "Show", run: () => handle.open() } } : {}),
        });
      } else if (explicit) chrome.announce(t.title, t.tone === "danger");
    } catch (err) {
      if (mine !== generation) return;
      suiteError = `Could not run the test cases: ${(err as Error).message}`;
    } finally {
      if (mine === generation) {
        running = false;
        render();
      }
    }
  }

  /** a trailing throttle: right away when the last check is older than
   *  RECHECK_MS, else once at its end — a burst of autosaves is one re-check.
   *  A run still out when it is due waits for the next slot (never dropped). */
  function recheck(kind: "tests" | "findings", go: () => void, busy: () => boolean = () => false): void {
    if (timers[kind]) return;
    const wait = Math.max(0, lastCheck[kind] + RECHECK_MS - Date.now());
    timers[kind] = setTimeout(() => {
      delete timers[kind];
      if (destroyed) return;
      if (busy()) {
        lastCheck[kind] = Date.now();
        recheck(kind, go, busy);
      } else go();
    }, wait);
  }

  // the store — values, result, and every view switch (the surface re-binds
  // to the new table's store and notifies): the form or the picker, the
  // summary, the selection
  const offStore = scenario.subscribe(() => {
    renderScenario();
    if (selectedRow() !== shownSelection) renderCases();
  });

  render();

  return {
    read(next) {
      const same = ref?.repo === next.repo && ref.path === next.path;
      ref = next;
      generation++;
      for (const t of Object.values(timers)) clearTimeout(t);
      delete timers.tests;
      delete timers.findings;
      if (!same) {
        cases = undefined;
        outcome = undefined;
        testsVersion = undefined;
        analysis = undefined;
        findingsError = undefined;
        selected = undefined;
        naming = undefined;
        captureError = undefined;
        lastVerdict = undefined;
      }
      suiteError = undefined;
      fileConflict = false;
      saving = false;
      running = false;
      loading = false;
      render();
      void loadSuite();
      void analyze();
    },
    saved(doc) {
      // the superseded freeze lands its last save after destroy — nothing left to re-check
      if (destroyed || !ref || doc.repo !== ref.repo || doc.path !== ref.path) return;
      recheck("findings", () => void analyze());
      if (cases && cases.length > 0) {
        recheck(
          "tests",
          () => void run(false),
          () => running,
        );
      }
    },
    destroy() {
      destroyed = true;
      generation++;
      for (const t of Object.values(timers)) clearTimeout(t);
      offStore();
      handle.setAvailable(false);
    },
  };
}
