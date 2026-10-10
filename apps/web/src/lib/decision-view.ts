/**
 * Shared decision-test wording of the SPA Checks panel (components/
 * decision-checks-panel.tsx) and the DMN widget (mcp-app/dmn-tests.ts) —
 * the derivations and status names both frontends must phrase identically.
 * Only the drawing stays per frontend (Tailwind classes + lucide-react vs
 * widget CSS classes + inline Lucide SVG), on the same CI tokens.
 * Framework-free, like lib/todo-view.ts.
 */

/** a test case's state as a screen reader announces it — the status icon's
 *  label in both frontends; `unrun` = stored but never run */
export const CASE_STATUS_LABEL = {
  pass: "Passes",
  fail: "Fails",
  pending: "No expectation yet",
  unrun: "Not run yet",
} as const;
export type CaseStatus = keyof typeof CASE_STATUS_LABEL;

/** the golden-master hint under a case without an expectation */
export const pendingActualLine = (actualValue: unknown): string =>
  `no expectation — currently produces ${JSON.stringify(actualValue)}`;

/** the rules no test case decides (rule ids are "<decision>/<rule>") */
export const uncoveredRulesLine = (rules: string[]): string =>
  `No case decides: ${rules.map((r) => r.split("/").pop()).join(", ")}`;
