/**
 * The Checks card's vocabulary (spec §6.4, §7.2) — what the decision widget's
 * three sections and its toggle SAY, derived from the server's answers
 * (analyze_decision, run_decision_tests) and the simulation store:
 *
 *   Findings        the summary chip ("Sound" / "2 warnings" / "1 error") and one row per finding
 *   Try a scenario  the outcome line ("Rule 3 → "approve"") and the form's controls
 *   Test cases      failing first, the expanded row's lines, the coverage line, the verdicts
 *
 * Rule NUMBERS, never ids: a table shows "3", the suite reports
 * `Rule_key_account` — the coverage list (and the analysis) carry every rule
 * of the model in table order, which is the mapping. The SPA-shared phrases
 * (case status names, the golden-master hint) stay in lib/decision-view.
 * Pure: dmn-checks.ts draws, node --test drives this.
 */
import type { DecisionAnalysis, DecisionFinding, Scenario } from "@designiq/decisions";
import type { CaseOutcome, SuiteOutcome, TestCase } from "@designiq/decisions/tests";

import { type CaseStatus, pendingActualLine } from "../../lib/decision-view.ts";
import type { IconName } from "../icons.ts";
import type { ScenarioInput, ScenarioOutcome, ScenarioValue } from "./engine.ts";
import type { PanelBadge } from "./feedback.ts";

/** a chip's look: chrome.css `.verdict.<tone>` (warn: dmn-styles.css) — icon + words, never colour alone */
export type ChipTone = "ok" | "bad" | "warn" | "muted";
export interface Chip {
  text: string;
  tone: ChipTone;
  icon?: IconName;
  spinner?: boolean;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** a value as the table writes it: strings quoted, the rest as JSON */
export const show = (value: unknown): string =>
  typeof value === "string" ? `"${value}"` : (JSON.stringify(value) ?? "null");

/** the last path segment — "credit-limit-check.tests.yaml" */
export const fileName = (path: string): string => path.split("/").pop() ?? path;

// ── rule numbers ────────────────────────────────────────────────────────────

/** every rule of the model in table order, per decision */
export type RuleLists = Array<{ decision: string; ruleIds: string[] }>;
/** 1-based table position of a rule — undefined when the model has no such rule */
export type RuleNumbers = (decision: string, rule: string) => number | undefined;

/** the coverage list IS the rule order (runDecisionTests maps view.decisions → rules) */
export function coverageRules(coverage: SuiteOutcome["coverage"]): RuleLists {
  const lists: RuleLists = [];
  for (const { decision, rule } of coverage) {
    const list = lists.find((l) => l.decision === decision);
    if (list) list.ruleIds.push(rule);
    else lists.push({ decision, ruleIds: [rule] });
  }
  return lists;
}

/** first list wins per decision — pass the freshest source first */
export function ruleNumbering(...sources: Array<RuleLists | undefined>): RuleNumbers {
  const index = new Map<string, number>();
  const seen = new Set<string>();
  for (const lists of sources) {
    for (const { decision, ruleIds } of lists ?? []) {
      if (seen.has(decision)) continue;
      seen.add(decision);
      ruleIds.forEach((rule, i) => index.set(`${decision}/${rule}`, i + 1));
    }
  }
  return (decision, rule) => index.get(`${decision}/${rule}`);
}

/** rule id → its 1-based position, across the model's decisions (XML ids
 *  are unique per document) — for annotating the server's failure lines */
export function ruleIdNumbers(...sources: Array<RuleLists | undefined>): Map<string, number> {
  const ids = new Map<string, number>();
  for (const lists of sources) {
    for (const { ruleIds } of lists ?? []) ruleIds.forEach((rule, i) => ids.has(rule) || ids.set(rule, i + 1));
  }
  return ids;
}

/** "expected rule(s) Rule_small_order, got Rule_review" → "… Rule_small_order
 *  (rule 4), got Rule_review (rule 5)" — the table shows numbers, the server ids */
export function annotateRuleIds(line: string, ids: Map<string, number>): string {
  if (ids.size === 0) return line;
  return line.replace(/[A-Za-z_][\w.-]*/g, (token) => {
    const n = ids.get(token);
    return n === undefined ? token : `${token} (rule ${n})`;
  });
}

/** "Rule 3" / "Rules 1, 3" / "No rule" */
export function rulesLabel(numbers: number[]): string {
  if (numbers.length === 0) return "No rule";
  return `${numbers.length === 1 ? "Rule" : "Rules"} ${numbers.join(", ")}`;
}

/** "No case decides rule 4." / "… rules 2 and 4." — a rule of another
 *  decision of the DRD names its decision; one the numbering misses keeps its id */
export function coverageLine(uncovered: string[], numbers: RuleNumbers, mainDecision?: string): string | undefined {
  if (uncovered.length === 0) return undefined;
  const parts = uncovered.map((key) => {
    const cut = key.lastIndexOf("/");
    const decision = cut < 0 ? "" : key.slice(0, cut);
    const rule = key.slice(cut + 1);
    const n = numbers(decision, rule);
    return { decision, label: n === undefined ? rule : String(n) };
  });
  const groups: Array<{ decision: string; labels: string[] }> = [];
  for (const p of parts) {
    const group = groups.find((g) => g.decision === p.decision);
    if (group) group.labels.push(p.label);
    else groups.push({ decision: p.decision, labels: [p.label] });
  }
  const list = (labels: string[]): string =>
    labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  const phrase = groups
    .map(
      (g) =>
        `${g.labels.length === 1 ? "rule" : "rules"} ${list(g.labels)}` +
        (mainDecision !== undefined && g.decision !== mainDecision && g.decision ? ` of ${g.decision}` : ""),
    )
    .join("; ");
  return `No case decides ${phrase}.`;
}

// ── Findings (analyze_decision) ─────────────────────────────────────────────

const SEVERITY_ORDER: Record<DecisionFinding["severity"], number> = { ERROR: 0, WARN: 1, INFO: 2 };
const SEVERITY_ICON: Record<DecisionFinding["severity"], IconName> = {
  ERROR: "circle-x",
  WARN: "triangle-alert",
  INFO: "info",
};

/** the SPA's badge: errors first, every other finding counts as a warning */
export function findingsChip(analysis: Pick<DecisionAnalysis, "findings">): Chip {
  const errors = analysis.findings.filter((f) => f.severity === "ERROR").length;
  if (errors > 0) return { text: plural(errors, "error"), tone: "bad", icon: "circle-x" };
  const others = analysis.findings.length;
  if (others > 0) return { text: plural(others, "warning"), tone: "warn", icon: "triangle-alert" };
  return { text: "Sound", tone: "ok", icon: "check" };
}

/** the SPA's empty line, word for word */
export const NO_FINDINGS = "No findings: the FEEL parses, no rule is dead, every requirement is read.";

export interface FindingRow {
  severity: DecisionFinding["severity"];
  icon: IconName;
  message: string;
  /** "credit-limit-check · rule 3 · Customer segment" (SPA Finding) — empty when unanchored */
  where: string;
}

export function findingRows(analysis: Pick<DecisionAnalysis, "findings" | "rules">): FindingRow[] {
  const numbers = ruleNumbering(analysis.rules);
  return analysis.findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] || a.i - b.i)
    .map(({ f }) => {
      const n = f.decision && f.rule ? numbers(f.decision, f.rule) : undefined;
      const rule = f.rule ? (n === undefined ? f.rule : `rule ${n}`) : undefined;
      return {
        severity: f.severity,
        icon: SEVERITY_ICON[f.severity],
        message: f.message,
        where: [f.decision, rule, f.column].filter(Boolean).join(" · "),
      };
    });
}

// ── Try a scenario (the add-on's store) ─────────────────────────────────────

/** the decision's answer: one output → its value; several columns → `name: value`;
 *  COLLECT with an aggregator → `SUM(score) = 12`; undefined = nothing reported */
export function outputText(outcome: Pick<ScenarioOutcome, "outputs" | "aggregation">): string | undefined {
  if (outcome.aggregation) {
    const { fn, output, value } = outcome.aggregation;
    return `${fn}(${output}) = ${show(value)}`;
  }
  if (outcome.outputs.length === 0) return undefined;
  return outcome.outputs
    .map((o) => {
      const entries = Object.entries(o);
      return entries.length === 1 ? show(entries[0]![1]) : entries.map(([k, v]) => `${k}: ${show(v)}`).join(", ");
    })
    .join(", ");
}

export interface ScenarioSummary {
  /** "Rule 3" / "Rules 1, 2" — empty when nothing matched */
  rules: string;
  /** the answer, formatted (`"approve"`) */
  value?: string;
  /** the collapsed section's summary: `Rule 3 → "approve"` / "No rule matches" */
  line: string;
  /** no rule matched — the strip reads as a miss, not a result */
  miss: boolean;
  /** the hit policy broke (UNIQUE matched twice) */
  violation?: string;
}

export function scenarioSummary(outcome: ScenarioOutcome): ScenarioSummary {
  const value = outputText(outcome);
  const reported = outcome.reported.map((i) => i + 1);
  const miss = outcome.matched.length === 0;
  const rules = reported.length > 0 ? rulesLabel(reported) : "";
  const line = miss ? "No rule matches" : rules ? `${rules} → ${value ?? "null"}` : (value ?? "No rule reported");
  return {
    rules,
    ...(value !== undefined ? { value } : {}),
    line,
    miss,
    ...(outcome.violation ? { violation: outcome.violation } : {}),
  };
}

/** the native control a column gets — the add-on's own mapping (htmlInputType):
 *  rule literals → a select, numbers → number, temporals → their picker */
export type FieldKind = "select" | "number" | "date" | "datetime-local" | "time" | "text";
const NUMERIC = new Set(["integer", "long", "int", "number", "double", "decimal", "float"]);
const TEMPORAL: Record<string, FieldKind> = {
  date: "date",
  datetime: "datetime-local",
  "date and time": "datetime-local",
  time: "time",
};

export function fieldKind(input: Pick<ScenarioInput, "typeRef" | "options">): FieldKind {
  if (input.options.length > 0) return "select";
  const type = (input.typeRef || "").toLowerCase();
  if (NUMERIC.has(type)) return "number";
  return TEMPORAL[type] ?? "text";
}

/** the select's options: the rule literals, plus a value that is not among
 *  them (a replayed case's "standard" when no rule names it) — never dropped */
export function selectOptions(options: string[], value: ScenarioValue): string[] {
  const v = value === null || value === undefined ? "" : String(value);
  return v !== "" && !options.includes(v) ? [v, ...options] : options;
}

/** a form value as a test case states it — the column's type, like the
 *  SPA's coerce: the store holds what the inputs emit ("50000"), the YAML
 *  should read 50000. Anything that does not parse stays as typed. */
export function typedValue(value: ScenarioValue, typeRef: string): ScenarioValue {
  if (typeof value !== "string") return value;
  const type = (typeRef || "").toLowerCase();
  if (NUMERIC.has(type)) {
    const n = Number(value);
    return value.trim() !== "" && Number.isFinite(n) ? n : value;
  }
  if (type === "boolean" && (value === "true" || value === "false")) return value === "true";
  return value;
}

/** a captured scenario, typed per column (computed columns are not in it) */
export function typedScenario(inputs: ScenarioInput[], scenario: Scenario): Scenario {
  const types = new Map(inputs.flatMap((i) => (i.variable ? [[i.variable, i.typeRef] as const] : [])));
  return Object.fromEntries(
    Object.entries(scenario).map(([k, v]) => {
      const type = types.get(k);
      return [k, type === undefined ? v : typedValue(v, type)];
    }),
  );
}

const blank = (v: unknown): boolean => v === undefined || v === null || v === "";

/** does the store hold exactly this case's values? (the selected row stays
 *  selected until someone edits the scenario). Only the columns a case can
 *  state (plain variable reads) are compared; a computed one is ignored. */
export function matchesCase(inputs: ScenarioInput[], values: ScenarioValue[], given: Scenario): boolean {
  let compared = 0;
  for (const [i, input] of inputs.entries()) {
    if (!input.variable) continue;
    compared++;
    const want = given[input.variable];
    const have = values[i];
    if (blank(want) && blank(have)) continue;
    if (blank(want) || blank(have) || String(want) !== String(have)) return false;
  }
  return compared > 0;
}

// ── Test cases (run_decision_tests) ─────────────────────────────────────────

export interface CaseRow {
  /** position in the stored suite — the key (names are free text and may repeat) */
  index: number;
  testCase: TestCase;
  result?: CaseOutcome;
  status: CaseStatus;
}

const STATUS_ORDER: Record<CaseStatus, number> = { fail: 0, pending: 1, pass: 2, unrun: 3 };

/** failing first, then the cases without an expectation, then the rest — in
 *  file order inside each group, so a click never makes the list jump.
 *  Results pair up BY POSITION (outcome.cases maps suite.cases), by name only
 *  when the counts disagree (a run of an older suite). */
export function caseRows(cases: TestCase[], outcome?: Pick<SuiteOutcome, "cases">): CaseRow[] {
  const byPosition = outcome && outcome.cases.length === cases.length;
  const byName = new Map((outcome?.cases ?? []).map((c) => [c.name, c]));
  return cases
    .map((testCase, index): CaseRow => {
      const result = outcome ? (byPosition ? outcome.cases[index] : byName.get(testCase.name)) : undefined;
      return { index, testCase, ...(result ? { result } : {}), status: result?.status ?? "unrun" };
    })
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.index - b.index);
}

/** `customerSegment: "key-account" · orderValue: 50000` */
export const givenLine = (given: Scenario): string =>
  Object.entries(given)
    .map(([k, v]) => `${k}: ${show(v ?? null)}`)
    .join(" · ");

/** the expanded row's verdict line(s): a pass names rule and value, a failure
 *  its expected/actual lines (the server's own words), a pending case what it
 *  produces today (the SPA-shared golden-master hint) */
export function caseLines(
  result: CaseOutcome,
  numbers: RuleNumbers,
  decision: string,
  ids: Map<string, number> = new Map(),
): string[] {
  if (result.status === "fail") return result.failures.map((line) => annotateRuleIds(line, ids));
  if (result.status === "pending") return [pendingActualLine(result.actual.value)];
  const rules = result.actual.rules.map((r) => numbers(decision, r)).filter((n): n is number => n !== undefined);
  const value = show(result.actual.value);
  return [rules.length > 0 ? `${rulesLabel(rules)} → ${value} as expected` : `${value} as expected`];
}

export interface SuiteState {
  /** cases in the stored suite; undefined = not loaded yet */
  cases?: number;
  outcome?: Pick<SuiteOutcome, "passed" | "failed" | "pending" | "cases">;
  running: boolean;
}

/** the Test cases section's chip */
export function suiteChip(s: SuiteState): Chip | undefined {
  if (s.running) return { text: "Running…", tone: "muted", spinner: true };
  if (s.cases === undefined) return undefined;
  if (s.cases === 0) return { text: "No cases yet", tone: "muted" };
  const o = s.outcome;
  if (!o) return { text: plural(s.cases, "case"), tone: "muted" };
  if (o.failed > 0) return { text: `${o.failed} failing`, tone: "bad", icon: "x" };
  if (o.pending > 0) return { text: `${o.passed}/${o.cases.length} pass`, tone: "muted", icon: "circle-question-mark" };
  return { text: `${o.passed}/${o.cases.length} pass`, tone: "ok", icon: "check" };
}

/** the TR toggle's chip and name — the verdict lives HERE, never in the sync
 *  pill (§5.4). While a run is out the last verdict stays, with a spinner, so
 *  the corner does not re-measure twice per run. */
export function toggleBadge(
  s: SuiteState,
  previous?: { text: string; tone: "ok" | "bad" | "muted" },
): PanelBadge | undefined {
  if (s.running) {
    return {
      verdict: { text: previous?.text ?? "", tone: previous?.tone ?? "muted", spinner: true },
      ariaLabel: "Checks, running the test cases",
    };
  }
  if (s.cases === undefined) return undefined;
  if (s.cases === 0) return { ariaLabel: "Checks, no test cases yet" };
  const o = s.outcome;
  if (!o) return { ariaLabel: `Checks, ${plural(s.cases, "test case")}` };
  const n = o.cases.length;
  if (o.failed > 0) {
    return {
      verdict: { text: `${o.failed} failing`, tone: "bad", icon: "x" },
      ariaLabel: `Checks, ${o.failed} of ${n} failing`,
    };
  }
  if (o.pending > 0) {
    return {
      verdict: { text: `${o.passed}/${n}`, tone: "muted", icon: "circle-question-mark" },
      ariaLabel: `Checks, ${o.passed} of ${n} pass, ${o.pending} without expectation`,
    };
  }
  return {
    verdict: { text: `${o.passed}/${n}`, tone: "ok", icon: "check" },
    ariaLabel: `Checks, ${o.passed} of ${n} pass`,
  };
}

/** the toast after an explicit Run whose card is closed by the time it answers */
export function runToast(o: Pick<SuiteOutcome, "passed" | "failed" | "pending" | "cases">): {
  tone: "success" | "info" | "danger";
  title: string;
  detail?: string;
} {
  const n = o.cases.length;
  if (n === 0) return { tone: "info", title: "No test cases yet" };
  if (o.failed > 0) {
    const first = o.cases.find((c) => c.status === "fail");
    return {
      tone: "danger",
      title: `${plural(o.failed, "test case")} failing`,
      ...(first ? { detail: first.name } : {}),
    };
  }
  if (o.pending > 0) {
    return { tone: "info", title: `${o.passed} of ${n} pass — ${o.pending} without expectation` };
  }
  return { tone: "success", title: n === 1 ? "The test case passes" : `All ${n} test cases pass` };
}

/** the success toast after Save as test case */
export const capturedTitle = (name: string, path: string): string => `Saved “${name}” to ${fileName(path)}`;
