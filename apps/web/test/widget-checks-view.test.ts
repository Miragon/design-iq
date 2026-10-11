/**
 * The Checks card's vocabulary (src/mcp-app/core/checks-view.ts): rule numbers
 * instead of ids, the findings chip, the scenario outcome line, failing cases
 * first, the verdicts on the section and on the toggle, the run toast.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CaseOutcome, SuiteOutcome } from "@designiq/decisions/tests";

import {
  annotateRuleIds,
  capturedTitle,
  caseLines,
  caseRows,
  coverageLine,
  coverageRules,
  fieldKind,
  findingRows,
  findingsChip,
  givenLine,
  matchesCase,
  NO_FINDINGS,
  outputText,
  ruleIdNumbers,
  ruleNumbering,
  rulesLabel,
  runToast,
  scenarioSummary,
  selectOptions,
  suiteChip,
  toggleBadge,
  typedScenario,
  typedValue,
} from "../src/mcp-app/core/checks-view.ts";
import type { ScenarioInput } from "../src/mcp-app/core/engine.ts";

const RULES = ["Rule_blocked", "Rule_overdue", "Rule_key_account", "Rule_small", "Rule_review"];
const coverage: SuiteOutcome["coverage"] = RULES.map((rule) => ({
  decision: "credit",
  rule,
  matchedBy: [],
  decidedBy: [],
}));

const outcomeOf = (name: string, status: CaseOutcome["status"], extra: Partial<CaseOutcome> = {}): CaseOutcome => ({
  name,
  status,
  given: {},
  actual: { value: "approve", rules: ["Rule_key_account"], decisions: {} },
  failures: [],
  unknownInputs: [],
  missingInputs: [],
  ...extra,
});

test("rule numbers come from the coverage order — the table order", () => {
  const n = ruleNumbering(coverageRules(coverage));
  assert.equal(n("credit", "Rule_key_account"), 3);
  assert.equal(n("credit", "Rule_review"), 5);
  assert.equal(n("credit", "Rule_unknown"), undefined);
  assert.equal(n("other", "Rule_key_account"), undefined);
  // the first source wins per decision (the freshest is passed first)
  const stale = [{ decision: "credit", ruleIds: ["Rule_review"] }];
  assert.equal(ruleNumbering(coverageRules(coverage), stale)("credit", "Rule_review"), 5);
  assert.equal(rulesLabel([3]), "Rule 3");
  assert.equal(rulesLabel([1, 3]), "Rules 1, 3");
});

test("the coverage line speaks rule numbers, groups per decision", () => {
  const n = ruleNumbering(coverageRules(coverage), [{ decision: "risk", ruleIds: ["R1", "R2"] }]);
  assert.equal(coverageLine([], n, "credit"), undefined);
  assert.equal(coverageLine(["credit/Rule_small"], n, "credit"), "No case decides rule 4.");
  assert.equal(
    coverageLine(["credit/Rule_overdue", "credit/Rule_small"], n, "credit"),
    "No case decides rules 2 and 4.",
  );
  assert.equal(
    coverageLine(["credit/Rule_blocked", "credit/Rule_overdue", "credit/Rule_small"], n, "credit"),
    "No case decides rules 1, 2 and 4.",
  );
  assert.equal(coverageLine(["credit/Rule_small", "risk/R2"], n, "credit"), "No case decides rule 4; rule 2 of risk.");
  // a rule the numbering misses keeps its id rather than vanishing
  assert.equal(coverageLine(["credit/Rule_new"], n, "credit"), "No case decides rule Rule_new.");
});

test("the findings chip: Sound / N warnings / N errors (SPA parity)", () => {
  assert.deepEqual(findingsChip({ findings: [] }), { text: "Sound", tone: "ok", icon: "check" });
  const warn = { severity: "WARN" as const, code: "dead-rule", message: "never fires" };
  const info = { severity: "INFO" as const, code: "x", message: "note" };
  const error = { severity: "ERROR" as const, code: "feel-syntax", message: "broken" };
  assert.deepEqual(findingsChip({ findings: [warn, info] }), {
    text: "2 warnings",
    tone: "warn",
    icon: "triangle-alert",
  });
  assert.deepEqual(findingsChip({ findings: [warn, error] }), { text: "1 error", tone: "bad", icon: "circle-x" });
  assert.match(NO_FINDINGS, /^No findings: /);
});

test("finding rows: errors first, anchored by decision · rule number · column", () => {
  const rows = findingRows({
    findings: [
      { severity: "WARN", code: "dead-rule", message: "Rule never fires", decision: "credit", rule: "Rule_small" },
      { severity: "ERROR", code: "feel-syntax", message: "Broken FEEL", decision: "credit", column: "Order value" },
      { severity: "INFO", code: "unused", message: "Unused input" },
    ],
    rules: [{ decision: "credit", ruleIds: RULES }],
  });
  assert.deepEqual(
    rows.map((r) => [r.severity, r.icon, r.where]),
    [
      ["ERROR", "circle-x", "credit · Order value"],
      ["WARN", "triangle-alert", "credit · rule 4"],
      ["INFO", "info", ""],
    ],
  );
});

test("the scenario outcome: rule number and value, a miss, several outputs, an aggregation", () => {
  const hit = scenarioSummary({ matched: [2, 4], reported: [2], outputs: [{ creditDecision: "approve" }] });
  assert.equal(hit.line, 'Rule 3 → "approve"');
  assert.equal(hit.rules, "Rule 3");
  assert.equal(hit.value, '"approve"');
  assert.equal(hit.miss, false);
  const miss = scenarioSummary({ matched: [], reported: [], outputs: [] });
  assert.equal(miss.line, "No rule matches");
  assert.equal(miss.miss, true);
  assert.equal(outputText({ outputs: [{ a: 1, b: "x" }] }), 'a: 1, b: "x"');
  assert.equal(outputText({ outputs: [{ a: 1 }, { a: 2 }] }), "1, 2");
  assert.equal(
    outputText({ outputs: [{ score: 2 }], aggregation: { fn: "SUM", output: "score", value: 12 } }),
    "SUM(score) = 12",
  );
  const broken = scenarioSummary({
    matched: [0, 1],
    reported: [0, 1],
    outputs: [{ v: 1 }, { v: 2 }],
    violation: "UNIQUE",
  });
  assert.equal(broken.line, "Rules 1, 2 → 1, 2");
  assert.equal(broken.violation, "UNIQUE");
});

test("form controls follow the add-on's mapping; a reflected value is never dropped", () => {
  assert.equal(fieldKind({ typeRef: "string", options: ["a"] }), "select");
  assert.equal(fieldKind({ typeRef: "integer", options: [] }), "number");
  assert.equal(fieldKind({ typeRef: "date and time", options: [] }), "datetime-local");
  assert.equal(fieldKind({ typeRef: "string", options: [] }), "text");
  assert.deepEqual(selectOptions(["blocked", "key-account"], "standard"), ["standard", "blocked", "key-account"]);
  assert.deepEqual(selectOptions(["blocked"], "blocked"), ["blocked"]);
  assert.deepEqual(selectOptions(["blocked"], null), ["blocked"]);
});

test("a captured scenario states each column's type, not the form's strings", () => {
  const inputs: ScenarioInput[] = [
    { id: "a", label: "Segment", expression: "segment", variable: "segment", typeRef: "string", options: [] },
    { id: "b", label: "Value", expression: "value", variable: "value", typeRef: "number", options: [] },
    { id: "c", label: "Flag", expression: "flag", variable: "flag", typeRef: "boolean", options: [] },
  ];
  assert.deepEqual(typedScenario(inputs, { segment: "42", value: "50000", flag: "true", other: "1" }), {
    segment: "42",
    value: 50000,
    flag: true,
    other: "1",
  });
  assert.equal(typedValue("12.5", "double"), 12.5);
  assert.equal(typedValue("n/a", "integer"), "n/a");
  assert.equal(typedValue(" ", "number"), " ");
  assert.equal(typedValue("yes", "boolean"), "yes");
  assert.equal(typedValue(7, "string"), 7);
});

test("a case stays selected only while the store holds exactly its values", () => {
  const inputs: ScenarioInput[] = [
    { id: "a", label: "Segment", expression: "segment", variable: "segment", typeRef: "string", options: [] },
    { id: "b", label: "Value", expression: "value", variable: "value", typeRef: "number", options: [] },
    { id: "c", label: "Upper", expression: "upper case(segment)", typeRef: "string", options: [] },
  ];
  const given = { segment: "key-account", value: 50000 };
  assert.equal(matchesCase(inputs, ["key-account", "50000", "IGNORED"], given), true);
  assert.equal(matchesCase(inputs, ["key-account", 50000, undefined], given), true);
  assert.equal(matchesCase(inputs, ["key-account", "5000", undefined], given), false);
  // an unset variable matches an empty column, nothing else
  assert.equal(matchesCase(inputs, ["key-account", "", undefined], { segment: "key-account" }), true);
  assert.equal(matchesCase(inputs, ["key-account", "1", undefined], { segment: "key-account" }), false);
  // nothing comparable → never "selected"
  assert.equal(matchesCase([inputs[2]!], ["x"], given), false);
});

test("case rows: failing first, then pending, then the rest in file order", () => {
  const cases = ["a", "b", "c", "d"].map((name) => ({ name, given: {} }));
  const outcome = {
    cases: [outcomeOf("a", "pass"), outcomeOf("b", "pending"), outcomeOf("c", "pass"), outcomeOf("d", "fail")],
  };
  assert.deepEqual(
    caseRows(cases, outcome).map((r) => `${r.testCase.name}:${r.status}`),
    ["d:fail", "b:pending", "a:pass", "c:pass"],
  );
  // not run yet: file order, every row "unrun"
  assert.deepEqual(
    caseRows(cases).map((r) => `${r.index}:${r.status}`),
    ["0:unrun", "1:unrun", "2:unrun", "3:unrun"],
  );
  // two cases with one name pair up by position, not by name
  const twins = [
    { name: "same", given: {} },
    { name: "same", given: {} },
  ];
  const rows = caseRows(twins, { cases: [outcomeOf("same", "pass"), outcomeOf("same", "fail")] });
  assert.deepEqual(
    rows.map((r) => `${r.index}:${r.status}`),
    ["1:fail", "0:pass"],
  );
});

test("the expanded row: given in table notation, the verdict line per status", () => {
  assert.equal(
    givenLine({ segment: "key-account", value: 50000, flag: null }),
    'segment: "key-account" · value: 50000 · flag: null',
  );
  const n = ruleNumbering(coverageRules(coverage));
  assert.deepEqual(caseLines(outcomeOf("x", "pass"), n, "credit"), ['Rule 3 → "approve" as expected']);
  assert.deepEqual(caseLines(outcomeOf("x", "fail", { failures: ["expected a, got b"] }), n, "credit"), [
    "expected a, got b",
  ]);
  assert.deepEqual(caseLines(outcomeOf("x", "pending"), n, "credit"), [
    'no expectation — currently produces "approve"',
  ]);
  const noRule = outcomeOf("x", "pass", { actual: { value: null, rules: [], decisions: {} } });
  assert.deepEqual(caseLines(noRule, n, "credit"), ["null as expected"]);
});

test("failure lines get the rule number the table shows next to the server's id", () => {
  const ids = ruleIdNumbers(coverageRules(coverage));
  assert.equal(
    annotateRuleIds("decision 'credit': expected rule(s) Rule_small, got Rule_review", ids),
    "decision 'credit': expected rule(s) Rule_small (rule 4), got Rule_review (rule 5)",
  );
  assert.equal(
    annotateRuleIds('expected "approve", got "manual-review"', ids),
    'expected "approve", got "manual-review"',
  );
  const failing = outcomeOf("x", "fail", { failures: ["expected rule(s) Rule_key_account, got Rule_review"] });
  assert.deepEqual(caseLines(failing, ruleNumbering(coverageRules(coverage)), "credit", ids), [
    "expected rule(s) Rule_key_account (rule 3), got Rule_review (rule 5)",
  ]);
});

test("the section chip and the toggle badge: running, no cases, all pass, failing, pending", () => {
  const all = { passed: 7, failed: 0, pending: 0, cases: Array.from({ length: 7 }, () => outcomeOf("x", "pass")) };
  const failing = { ...all, passed: 6, failed: 1 };
  const pending = { ...all, passed: 5, pending: 2 };
  assert.equal(suiteChip({ running: false }), undefined);
  assert.deepEqual(suiteChip({ running: false, cases: 0 }), { text: "No cases yet", tone: "muted" });
  assert.deepEqual(suiteChip({ running: false, cases: 7, outcome: all }), {
    text: "7/7 pass",
    tone: "ok",
    icon: "check",
  });
  assert.deepEqual(suiteChip({ running: false, cases: 7, outcome: failing }), {
    text: "1 failing",
    tone: "bad",
    icon: "x",
  });
  assert.equal(suiteChip({ running: false, cases: 7, outcome: pending })?.text, "5/7 pass");
  assert.equal(suiteChip({ running: false, cases: 7 })?.text, "7 cases");
  assert.equal(suiteChip({ running: true, cases: 7, outcome: all })?.spinner, true);

  assert.deepEqual(toggleBadge({ running: false, cases: 7, outcome: all }), {
    verdict: { text: "7/7", tone: "ok", icon: "check" },
    ariaLabel: "Checks, 7 of 7 pass",
  });
  assert.equal(toggleBadge({ running: false, cases: 7, outcome: failing })?.ariaLabel, "Checks, 1 of 7 failing");
  assert.equal(toggleBadge({ running: false, cases: 0 })?.verdict, undefined);
  assert.equal(toggleBadge({ running: false })?.verdict, undefined);
  // a run keeps the last verdict, with a spinner
  assert.deepEqual(toggleBadge({ running: true, cases: 7 }, { text: "7/7", tone: "ok" })?.verdict, {
    text: "7/7",
    tone: "ok",
    spinner: true,
  });
});

test("the run toast and the capture toast", () => {
  const pass = (n: number) => ({
    passed: n,
    failed: 0,
    pending: 0,
    cases: Array.from({ length: n }, () => outcomeOf("x", "pass")),
  });
  assert.deepEqual(runToast(pass(7)), { tone: "success", title: "All 7 test cases pass" });
  assert.equal(runToast(pass(1)).title, "The test case passes");
  const failing = { passed: 1, failed: 1, pending: 0, cases: [outcomeOf("ok", "pass"), outcomeOf("broken", "fail")] };
  assert.deepEqual(runToast(failing), { tone: "danger", title: "1 test case failing", detail: "broken" });
  assert.equal(runToast({ passed: 0, failed: 0, pending: 0, cases: [] }).title, "No test cases yet");
  assert.equal(
    capturedTitle("Key account at the ceiling", "processes/credit-limit-check.tests.yaml"),
    "Saved “Key account at the ceiling” to credit-limit-check.tests.yaml",
  );
});
