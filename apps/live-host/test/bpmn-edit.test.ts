/**
 * The semantic BPMN edit use-cases (application/bpmn-edit.ts) against an
 * in-memory BpmnEditIo: the re-application of a change on a concurrent edit
 * and its limits (baseVersion, ops that no longer apply), the design-iq
 * validator inside the engine (counted messages, lint "warn"), the platform a
 * design model is edited as, and the engine's errors in tool words. The tools
 * over a real live document: bpmn-edit-tools.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { AppError } from "@designiq/http-kit";
import { applyToXml, CliError } from "@miragon/bpmn-cli";
import { checkModel } from "@miragon/design-iq-validator";

import {
  type BpmnEditIo,
  designIqValidator,
  editProcess,
  engineError,
  MAX_ATTEMPTS,
  toolWords,
} from "../src/application/bpmn-edit.ts";
import { baseVersionOf, type PutOutcome } from "../src/application/content.ts";

const PATH = "processes/order-to-cash.bpmn";
/** a hand-drawn design model: a pool, lanes, a decision link, a call activity — it declares Camunda 7 but executes nowhere */
const EXAMPLE = readFileSync(join(import.meta.dirname, "fixtures", "bpmn-edit", "order-to-cash.bpmn"), "utf8");
const RENAME = [{ op: "set", id: "Task_fulfill_order", values: { name: "Ship order" } }];

/** an in-memory document; `coEdit` runs before each of the first `conflicts` writes, like a co-editor's keystroke */
function memoryIo(
  text: string,
  {
    conflicts = 0,
    coEdit = (t: string) => t,
    gate = false,
  }: { conflicts?: number; coEdit?: (t: string) => string; gate?: boolean } = {},
): BpmnEditIo & { doc: () => string; writes: number } {
  let doc = text;
  let left = conflicts;
  const io = {
    writes: 0,
    doc: () => doc,
    read: async (path: string) => ({ path, content: doc, baseVersion: baseVersionOf(doc) }),
    write: async (path: string, body: { content: string; baseVersion: string; lint?: string }): Promise<PutOutcome> => {
      io.writes++;
      // the save gate of putContent: ERROR findings refuse the save under lint "block"
      const errors = (gate ? (checkModel(body.content, { path, notation: "bpmn" }) ?? []) : []).filter(
        (f) => f.severity === "ERROR",
      );
      if (errors.length > 0 && body.lint !== "warn") {
        throw new AppError(
          "content/invalid-model",
          `validation failed:\n- ${errors.map((f) => f.message).join("\n- ")}`,
          {
            status: 422,
            expose: true,
          },
        );
      }
      if (left > 0) {
        left--;
        doc = coEdit(doc);
      }
      if (body.baseVersion !== baseVersionOf(doc)) {
        return {
          ok: false,
          conflict: {
            error: "changed",
            code: "content/conflict",
            path,
            currentContent: doc,
            currentXml: doc,
            baseVersion: baseVersionOf(doc),
          },
        };
      }
      const previous = doc;
      doc = body.content;
      return { ok: true, result: { path, baseVersion: baseVersionOf(doc), warnings: [] }, previous, next: doc };
    },
    check: async () => ({ ok: true as const, warnings: [] }),
    modelIds: async () => undefined,
  };
  return io;
}

let renames = 0;
/** a co-editor renames "Validate order" — a different element than the agent's op touches */
const renameValidate = (t: string) =>
  t.replace(/(<bpmn:userTask id="Task_validate_order" name=")[^"]*"/, `$1Validate order ${++renames}"`);

// ── concurrency ──────────────────────────────────────────────────────────────

test("a concurrent change is answered by applying the ops again to the current text — and says so", async () => {
  const io = memoryIo(EXAMPLE, { conflicts: 1, coEdit: renameValidate });
  const out = await editProcess(io, PATH, RENAME);
  assert.ok(out.ok);
  assert.equal(out.attempts, 2);
  assert.match(io.doc(), /id="Task_validate_order" name="Validate order \d+"/, "the co-editor's change survives");
  assert.match(io.doc(), /name="Ship order"/, "and so does the agent's");
  assert.ok(out.change.notes.some((n) => /applied to a newer version of the document \(attempt 2\)/.test(n)));
});

test("a document that keeps changing gives up after MAX_ATTEMPTS with a conflict, not an error", async () => {
  const io = memoryIo(EXAMPLE, { conflicts: MAX_ATTEMPTS, coEdit: renameValidate });
  assert.deepEqual(await editProcess(io, PATH, RENAME), {
    ok: false,
    conflict: true,
    attempts: MAX_ATTEMPTS,
    message: `the document kept changing during ${MAX_ATTEMPTS} attempts; send the same request again`,
  });
  assert.equal(io.writes, MAX_ATTEMPTS);
});

test("baseVersion: a stale one is a conflict before anything runs; a concurrent change is never re-applied", async () => {
  // ops that would not even apply to the current text: the stale version is reported, not their failure
  const stale = memoryIo(EXAMPLE);
  const missing = [{ op: "set", id: "Task_gone", values: { name: "x" } }];
  const before = await editProcess(stale, PATH, missing, { baseVersion: "not-the-current-one" });
  assert.deepEqual(before, {
    ok: false,
    conflict: true,
    attempts: 1,
    message: "the document changed since your baseVersion; read it again and send operations for it",
  });
  assert.equal(stale.writes, 0);

  const racing = memoryIo(EXAMPLE, { conflicts: 1, coEdit: renameValidate });
  const out = await editProcess(racing, PATH, RENAME, { baseVersion: baseVersionOf(EXAMPLE) });
  assert.ok(!out.ok && out.attempts === 1 && /since your baseVersion/.test(out.message));
  assert.equal(racing.writes, 1, "applied once, not again on the newer version");
  assert.doesNotMatch(racing.doc(), /name="Ship order"/);
});

test("ops a co-editor's change made inapplicable come back as a conflict that says why, not as the agent's error", async () => {
  // the co-editor removes the task the agent wants to rename
  const io = memoryIo(EXAMPLE, {
    conflicts: 1,
    coEdit: (t) =>
      t.replace('name="Fulfill order"', 'name="Fulfill order (moved)"').replace(/Task_fulfill_order/g, "Task_fulfil"),
  });
  const out = await editProcess(io, PATH, RENAME);
  assert.equal(out.ok, false);
  assert.ok(!out.ok && /changed while this call ran and your operations no longer apply/.test(out.message));
  assert.ok(!out.ok && /E_NOT_FOUND/.test(out.message));
});

test("a co-editor's unfinished work the save gate refuses is a conflict on the retry, never the agent's to repair", async () => {
  // a person drops a task that is not connected yet while the agent's call runs
  const io = memoryIo(EXAMPLE, {
    gate: true,
    conflicts: 1,
    coEdit: (t) => t.replace("</bpmn:process>", '<bpmn:task id="Activity_wip" /></bpmn:process>'),
  });
  const out = await editProcess(io, PATH, RENAME);
  assert.equal(out.ok, false);
  assert.ok(!out.ok && out.attempts === 2);
  assert.ok(!out.ok && /changed while this call ran, and the save gate refuses the newer version/.test(out.message));
  assert.ok(!out.ok && /Activity_wip/.test(out.message), "names what the gate found");
  assert.doesNotMatch(io.doc(), /name="Ship order"/);
});

// ── the validator inside the engine ──────────────────────────────────────────

/** a model with `n` extra start events (design-iq: "expected exactly one start event …, found n+1") */
const withStarts = (n: number) =>
  EXAMPLE.replace(
    "</bpmn:process>",
    `${Array.from({ length: n }, (_, i) => `<bpmn:startEvent id="StartEvent_extra_${i}" />`).join("")}</bpmn:process>`,
  );

test("validator: a counted error that improves is the same error; one that grows is a new one", async () => {
  const run = (xml: string, ops: unknown[]) =>
    applyToXml(xml, ops, { validators: [designIqValidator(PATH, undefined)], profile: "none", layout: false });
  // 3 → 2 start events: no new error, the old one is reported as already there
  const better = await run(withStarts(2), [{ op: "remove", ids: ["StartEvent_extra_1"] }]);
  const report = better.result.validation.validators![0]!;
  assert.deepEqual(report.errors, []);
  assert.ok(report.preexisting.some((f) => /found 2$/.test(f.message)));
  // 2 → 0: no start event at all is a new problem, not the old one improved
  await assert.rejects(
    run(withStarts(1), [{ op: "remove", ids: ["StartEvent_extra_0", "StartEvent_order_received"] }]),
    (e: unknown) => e instanceof CliError && e.code === "E_VALIDATION" && /found 0/.test(JSON.stringify(e.details)),
  );
  // 3 → 4: refused, the grown count is a new error
  await assert.rejects(
    run(withStarts(2), [{ op: "add", kind: "startEvent", name: "Fax received", in: "order-to-cash" }]),
    (e: unknown) => e instanceof CliError && e.code === "E_VALIDATION" && /found 4/.test(JSON.stringify(e.details)),
  );
});

test("validator: a large process's complexity warning shrinking with the change is not reported as added", async () => {
  const big = await applyToXml(
    EXAMPLE,
    Array.from({ length: 6 }, (_, i) => ({
      op: "add",
      kind: "userTask",
      name: `Step ${i}`,
      after: "Task_fulfill_order",
    })),
  );
  const io = memoryIo(big.xml);
  const out = await editProcess(io, PATH, [{ op: "remove", ids: ["Task_step_0"] }]);
  assert.ok(out.ok && out.written);
  assert.ok(!out.change.warnings.some((w) => /bpmn\/complexity/.test(w)), out.change.warnings.join("\n"));
  const grown = await editProcess(memoryIo(big.xml), PATH, [
    { op: "add", kind: "userTask", name: "One more", after: "Task_fulfill_order" },
  ]);
  assert.ok(grown.ok && grown.change.warnings.some((w) => /bpmn\/complexity: \d+ activities/.test(w)));
});

test("validator: lint 'warn' reports the errors a change adds instead of refusing it — and keeps every other guard", async () => {
  const deadEnd = [{ op: "add", kind: "boundaryEvent:timer", name: "1 day", on: "Task_validate_order", timer: "P1D" }];
  const warned = await editProcess(memoryIo(EXAMPLE), PATH, deadEnd, { lint: "warn" });
  assert.ok(warned.ok && warned.written);
  assert.ok(warned.change.warnings.some((w) => /^\[design-iq\] bpmn\/flow: .*dead end/.test(w)));
  // what the engine refuses to lose stays refused: a retype that would delete the event sub-process's content
  const io = memoryIo(EXAMPLE);
  await assert.rejects(
    editProcess(io, PATH, [{ op: "retype", id: "EventSubProcess_customer_support", kind: "userTask" }], {
      lint: "warn",
    }),
    (e: unknown) => e instanceof AppError && e.code === "bpmn-edit/would-drop-content",
  );
  // and so does a document the engine cannot read without losing content
  const lossy = EXAMPLE.replace("</bpmn:process>", "<bpmn:fancyThing /></bpmn:process>");
  await assert.rejects(
    editProcess(memoryIo(lossy), PATH, RENAME, { lint: "warn" }),
    (e: unknown) =>
      e instanceof AppError &&
      e.code === "bpmn-edit/import-lossy" &&
      /^- unparsable content <bpmn:fancyThing> detected$/m.test(e.message) &&
      /save_bpmn_xml/.test(e.message),
  );
  assert.equal(io.writes, 0);
});

// ── the platform a model is edited as ────────────────────────────────────────

test("a model no process of which is executable is edited as a design model: links unprefixed", async () => {
  const link = [
    { op: "add", kind: "businessRuleTask", name: "Rate risk", after: "Task_validate_order", as: "$r" },
    { op: "set", id: "$r", values: { calledDecision: "credit-limit-check" } },
  ];
  const design = memoryIo(EXAMPLE);
  assert.ok((await editProcess(design, PATH, link)).ok);
  assert.match(
    design.doc(),
    /<bpmn:businessRuleTask id="Task_rate_risk" name="Rate risk" calledDecision="credit-limit-check"/,
  );

  const executable = memoryIo(EXAMPLE.replace('isExecutable="false"', 'isExecutable="true"'));
  await editProcess(executable, PATH, link, { lint: "warn" });
  assert.match(
    executable.doc(),
    /<bpmn:businessRuleTask id="Task_rate_risk" name="Rate risk" camunda:decisionRef="credit-limit-check"/,
  );
});

// ── errors in tool words ─────────────────────────────────────────────────────

test("engine errors: code, op, element, candidates and a hint in tool words; house AppError codes", () => {
  const notFound = engineError(
    new CliError("E_NOT_FOUND", 'No element with id "Task_Aa"', "model", {
      element: "Task_Aa",
      candidates: ["Task_A"],
      op: 1,
      hint: "Run `bpmn show <file>` or `bpmn find <file> <text>` to list the ids.",
    }),
  );
  assert.equal(notFound.code, "bpmn-edit/not-found");
  assert.equal(notFound.status, 422);
  assert.equal(
    notFound.message,
    'E_NOT_FOUND in ops[1] (Task_Aa): No element with id "Task_Aa"\ncandidates: Task_A\n' +
      "hint: Run get_process_outline (or its `find`) to list the ids.",
  );
  const usage = engineError(new CliError("E_USAGE", "ops[0] (add): unknown key", "usage"));
  assert.equal(usage.status, 400);

  const refused = engineError(
    new CliError("E_VALIDATION", "The change would introduce 1 error(s)", "model", {
      errors: [{ code: "bpmn/flow", message: "Timer_1 is a dead end", validator: "design-iq", severity: "error" }],
      hint: "… (`bpmn apply <file> ops.json`) …, or pass --force to write anyway.",
    }),
  );
  assert.match(refused.message, /^- \[design-iq\] bpmn\/flow: Timer_1 is a dead end$/m);
  assert.match(refused.message, /hint: complete the change in the same call .* lint 'warn'/);
  assert.doesNotMatch(refused.message, /--force|bpmn apply/);
});

test("toolWords: the CLI's reading and checking commands become tools; op commands stay for the flag mapping", () => {
  assert.equal(toolWords("See `bpmn kinds --json`."), "See the kinds in edit_process's description.");
  assert.equal(toolWords("`bpmn validate <file>` lists them"), "validate_bpmn lists them");
  assert.equal(toolWords("run `bpmn layout <file> --tidy`"), "run layout_process with mode 'tidy'");
  assert.equal(toolWords("Fix the XML, or pass --force to write anyway."), "Fix the XML.");
  const move = "If Lane_billing does it: `bpmn move <file> Task_x --lane Lane_billing`.";
  assert.equal(toolWords(move), move);
});

// ── #236's findings 1 and 9 on #218's editor ─────────────────────────────────

test("a new flow never takes a message flow's id; a boundary on a gateway or a node after an end event is refused", async () => {
  const collab = await applyToXml(EXAMPLE, [
    { op: "add", kind: "participant", name: "Customer", blackBox: true, as: "$customer" },
    // a message flow holding the id the engine would give the next flow
    { op: "connect", source: "Task_reject_order", target: "$customer", id: "Flow_pack_goods_to_invoice_handling" },
  ]);
  const io = memoryIo(collab.xml);
  const out = await editProcess(io, PATH, [
    { op: "add", kind: "userTask", name: "Pack goods", after: "Task_fulfill_order" },
  ]);
  assert.ok(out.ok && out.written);
  const ids = [...io.doc().matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    ids.filter((id, i) => ids.indexOf(id) !== i),
    [],
    "no id twice",
  );
  assert.match(io.doc(), /<bpmn:messageFlow id="Flow_pack_goods_to_invoice_handling"/, "the message flow survives");

  const refused = async (ops: unknown[], code: string) =>
    assert.rejects(editProcess(memoryIo(EXAMPLE), PATH, ops), (e: unknown) => e instanceof AppError && e.code === code);
  await refused(
    [{ op: "add", kind: "boundaryEvent:error", name: "Failed", on: "Gateway_credit_approved" }],
    "bpmn-edit/wrong-kind",
  );
  await refused(
    [{ op: "add", kind: "userTask", name: "After the end", after: "EndEvent_order_rejected" }],
    "bpmn-edit/invalid-source",
  );
});
