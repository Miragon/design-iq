/**
 * The ONE module that touches @emaarco/dmn-js-simulation — the FEEL/hit-policy
 * engine the dmn-js modeler add-on also runs in the browser. Everything else
 * in this package talks to the shapes declared here.
 *
 * Why the shapes are re-declared instead of imported: the package publishes a
 * single bundle whose .d.ts uses EXTENSIONLESS relative imports, which this
 * workspace's NodeNext resolution cannot follow — every exported type silently
 * degrades to `any`, which would leak straight through our own API. The shapes
 * below are DMN-spec shapes (inputs, outputs, rules, hit policy), not vendor
 * inventions, so re-declaring them costs nothing and buys a real type gate.
 * Verified against the package's own d.ts and its runtime behaviour in
 * test/simulate.test.ts.
 *
 * Why the DRD is walked here instead of by the package's
 * DecisionRequirementsDiagramEvaluator: since 0.4.0 that evaluator hands each
 * table the FEEL value its input expression resolved to, no longer coerced to
 * the column's typeRef. An InputData without a declared type (read as a
 * string) in a number column would then compare as a string ("x" passes
 * `>= 500`), and a boolean column would match nothing. The walk below keeps
 * the 0.3 semantics on the package's own DecisionTableEvaluator, whose
 * `evaluate` still coerces by column (the same call the add-on's table
 * simulator makes), so a scenario decides what it decided before.
 *
 * It also keeps the engine swappable at one seam: an upstream `/core`
 * subexport (which would also drop the inferno import the bundle pulls in) or
 * a fork changes this file and nothing else.
 */
import { coerceValue, DecisionTableEvaluator, evaluateExpression } from "@emaarco/dmn-js-simulation";

/** a value before the engine coerces it to its DMN type */
export type RawValue = string | number | boolean | null | undefined;

export type HitPolicy = "UNIQUE" | "FIRST" | "ANY" | "PRIORITY" | "COLLECT" | "RULE ORDER" | "OUTPUT ORDER";
export type Aggregation = "SUM" | "MIN" | "MAX" | "COUNT";

export interface EngineInput {
  id: string;
  label: string;
  /** the FEEL input expression = what the column reads */
  expression: string;
  typeRef: string;
  /** distinct literals the column tests against (drives the widget's dropdown) */
  options: string[];
}

export interface EngineOutput {
  id: string;
  /** result key */
  name: string;
  label: string;
  typeRef: string;
  /** allowed values, highest priority first (PRIORITY / OUTPUT ORDER) */
  priorityValues: string[];
}

export interface EngineRule {
  id: string;
  /** raw FEEL unary tests, aligned to the inputs */
  inputEntries: string[];
  /** raw FEEL expressions, aligned to the outputs */
  outputEntries: string[];
}

export interface EngineDecisionModel {
  decisionId: string;
  decisionName: string;
  hitPolicy: HitPolicy;
  aggregation?: Aggregation;
  inputs: EngineInput[];
  outputs: EngineOutput[];
  rules: EngineRule[];
}

export type EngineLogic =
  | { kind: "decisionTable"; model: EngineDecisionModel }
  | { kind: "literalExpression"; expression: string }
  | { kind: "none" };

export interface EngineDrdDecision {
  id: string;
  name: string;
  /** the name downstream decisions read the result under */
  variableName: string;
  requiredDecisionIds: string[];
  requiredInputIds: string[];
  logic: EngineLogic;
}

export interface EngineDrdModel {
  inputData: Array<{ id: string; name: string; label: string; typeRef: string }>;
  decisions: EngineDrdDecision[];
}

export interface EngineTableResult {
  /** every rule that matched, by ROW INDEX, in table order */
  matchedRuleIndices: number[];
  /** the subset the hit policy reports */
  reportedRuleIndices: number[];
  outputs: Array<Record<string, unknown>>;
  aggregation?: { fn: string; output: string; value: unknown };
  /** e.g. "UNIQUE hit policy violated: 2 rules matched" */
  violation?: string;
}

export interface EngineDecisionEvaluation {
  value: unknown;
  table?: EngineTableResult;
  /** the values the table's columns saw, in column order */
  inputs?: RawValue[];
  skipped?: boolean;
}

export interface EngineDrdResult {
  /** decision ids in evaluation (topological) order */
  order: string[];
  results: Record<string, EngineDecisionEvaluation>;
}

/** Evaluate a whole DRD. `values` is keyed by InputData ID (not name). */
export function evaluateDrd(model: EngineDrdModel, values: Record<string, RawValue>): EngineDrdResult {
  const context: Record<string, unknown> = {};
  for (const input of model.inputData) {
    const value: unknown = coerceValue(values[input.id], input.typeRef);
    if (value !== undefined) context[input.name] = value;
  }
  const byId = new Map(model.decisions.map((decision) => [decision.id, decision]));
  const { order, cyclic } = evaluationOrder(model.decisions);
  const results: Record<string, EngineDecisionEvaluation> = {};
  const skipped = new Set<string>();
  for (const id of order) {
    const decision = byId.get(id) as EngineDrdDecision;
    // a decision whose required decision was skipped would read `null` for it
    // and report a result nothing produced
    const evaluation = decision.requiredDecisionIds.some((required) => skipped.has(required))
      ? skippedEvaluation()
      : evaluateDecision(decision, context);
    results[id] = evaluation;
    if (evaluation.skipped) skipped.add(id);
    else context[decision.variableName] = evaluation.value;
  }
  for (const id of cyclic) results[id] = skippedEvaluation();
  return { order, results };
}

function evaluateDecision(decision: EngineDrdDecision, context: Record<string, unknown>): EngineDecisionEvaluation {
  const { logic } = decision;
  if (logic.kind === "decisionTable") {
    // an unresolved expression stays FEEL `null`: simulateDecision reports
    // the column as seen and empty instead of dropping it
    const inputs = logic.model.inputs.map((input): RawValue =>
      input.expression ? (evaluateExpression(input.expression, context) as RawValue) : undefined,
    );
    const table = new DecisionTableEvaluator(logic.model).evaluate(inputs) as EngineTableResult;
    return { value: tableValue(logic.model, table), table, inputs };
  }
  if (logic.kind === "literalExpression") return { value: evaluateExpression(logic.expression, context) as unknown };
  return skippedEvaluation();
}

/** the one value a table hands to the decisions that require it */
function tableValue(model: EngineDecisionModel, table: EngineTableResult): unknown {
  if (table.aggregation) return table.aggregation.value;
  if (table.outputs.length === 0) return null;
  const [only] = model.outputs;
  if (model.outputs.length === 1 && only) {
    const values = table.outputs.map((output) => output[only.name]);
    return values.length === 1 ? values[0] : values;
  }
  return table.outputs.length === 1 ? table.outputs[0] : table.outputs;
}

function skippedEvaluation(): EngineDecisionEvaluation {
  return { value: null, skipped: true };
}

/** decisions in dependency order (Kahn); whatever is left over sits on a cycle */
function evaluationOrder(decisions: EngineDrdDecision[]): { order: string[]; cyclic: string[] } {
  const ids = new Set(decisions.map((decision) => decision.id));
  const unmet = new Map(decisions.map((decision) => [decision.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const decision of decisions) {
    for (const required of decision.requiredDecisionIds) {
      // a requirement outside this DRD orders nothing
      if (!ids.has(required)) continue;
      unmet.set(decision.id, (unmet.get(decision.id) ?? 0) + 1);
      dependents.set(required, [...(dependents.get(required) ?? []), decision.id]);
    }
  }
  const queue = decisions.filter((decision) => unmet.get(decision.id) === 0).map((decision) => decision.id);
  const order: string[] = [];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const left = (unmet.get(dependent) ?? 0) - 1;
      unmet.set(dependent, left);
      if (left === 0) queue.push(dependent);
    }
  }
  const cyclic = decisions.filter((decision) => !order.includes(decision.id)).map((decision) => decision.id);
  return { order, cyclic };
}
