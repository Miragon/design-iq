/**
 * The semantic BPMN tools of ADR 0009 (get_process_outline, edit_process,
 * layout_process) on @miragon/bpmn-cli, against a REAL Hocuspocus direct
 * connection and the ordinary save gate: what an edit writes into the live
 * document, how a refusal reads, the dry run that asks the save gate, and the
 * #236 findings on #218's editor. Registration, titles and instructions are
 * pinned with every other tool in mcp.test.ts; the use-cases' concurrency,
 * validator and error mapping in bpmn-edit.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { toolText } from "@designiq/mcp-kit/testing";
import { Server as HocuspocusServer } from "@hocuspocus/server";
import { applyToXml } from "@miragon/bpmn-cli";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import type { Session } from "../src/adapters/sqlite/sessions.ts";
import { makeCollabHooks } from "../src/application/collab.ts";
import { baseVersionOf } from "../src/application/content.ts";
import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";
import { createLiveMcpServer, type McpDeps } from "../src/http/mcp.ts";
import type { GitProvider } from "../src/ports/git-provider.ts";
import { loadContentConfig } from "../src/repos/content.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
};
const FIXTURES = join(import.meta.dirname, "fixtures", "bpmn-edit");
const PATH = "processes/order-to-cash.bpmn";
/** a hand-drawn design model: a pool, lanes, a decision link, a call activity, an event sub-process */
const EXAMPLE = readFileSync(join(FIXTURES, "order-to-cash.bpmn"), "utf8");
const ref = { repo: REPO.fullName, id: "order-to-cash" };
const RENAME = [{ op: "set", id: "Task_validate_order", values: { name: "Check order" } }];

const session: Session = {
  id: "sess-petra",
  user: { login: "petra", name: "petra", avatarUrl: null, provider: "github" },
  createdAt: Date.now(),
};

const servers: HocuspocusServer[] = [];
const cleanups: Array<() => unknown> = [];
after(async () => {
  for (const c of cleanups) await c();
  await Promise.all(servers.map((s) => s.destroy()));
  // the watchdog of mcp.test.ts: a passed suite must never hang on a Hocuspocus unload handle
  setTimeout(() => process.exit(), 2000).unref();
});

/** a tmpdir content repo — the process (`bpmn`, default the fixture), its call and decision targets — with a real direct-connection openDoc */
function deps(bpmn = EXAMPLE, over: Partial<McpDeps> = {}): McpDeps {
  const ws = mkdtempSync(join(tmpdir(), "designiq-bpmn-edit-"));
  mkdirSync(join(ws, "processes", "subprocesses"), { recursive: true });
  writeFileSync(join(ws, "designiq.yml"), "models: processes\n");
  writeFileSync(join(ws, PATH), bpmn);
  writeFileSync(
    join(ws, "processes", "subprocesses", "invoice-handling.bpmn"),
    readFileSync(join(FIXTURES, "invoice-handling.bpmn")),
  );
  writeFileSync(
    join(ws, "processes", "credit-limit-check.dmn"),
    readFileSync(join(FIXTURES, "credit-limit-check.dmn")),
  );
  const registry = { get: (n: string) => (n.toLowerCase() === REPO.fullName ? REPO : undefined), list: () => [REPO] };
  const workspaces = {
    ensure: async () => ws,
    dir: () => ws,
    changedPaths: async () => [],
    changedFiles: async () => [],
  };
  const hp = new HocuspocusServer({
    ...makeCollabHooks({
      lineage: new LineageStore(new DatabaseSync(":memory:"), REPO.fullName),
      docGuard: new DocSizeGuard(8_000_000),
      maxDocBytes: 8_000_000,
      sessions: { get: () => undefined },
      access: { canWrite: async () => true },
      registry,
      workspaces,
      contentConfig: loadContentConfig,
      liveDocs: new Set(),
    }),
  });
  servers.push(hp);
  return {
    registry,
    workspaces,
    access: { canWrite: async () => true },
    liveDocs: () => [],
    openDoc: (room) => hp.hocuspocus.openDirectConnection(room),
    maxDocBytes: 8_000_000,
    github: {} as GitProvider,
    webDist: mkdtempSync(join(tmpdir(), "designiq-webdist-")),
    publicUrl: "http://live.test",
    bpmnEdit: true,
    ...over,
  };
}

async function connect(d: McpDeps) {
  const server = createLiveMcpServer(d, session, []);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "bpmn-edit-test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  cleanups.push(() => Promise.all([client.close(), server.close()]));
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    toolText(await client.callTool({ name, arguments: args }));
  const callJson = async (name: string, args: Record<string, unknown> = {}) => {
    const { isError, text } = await call(name, args);
    assert.ok(!isError, `${name} unexpectedly errored: ${text}`);
    return JSON.parse(text) as Record<string, any>;
  };
  /** the live document's text, through the ordinary read tool */
  const xml = async () => (await callJson("get_bpmn_xml", { repo: REPO.fullName, path: PATH })).content as string;
  return { client, call, callJson, xml };
}

test("edit_process: its description carries the engine's op table, kinds and triggers", async () => {
  const { client } = await connect(deps());
  const edit = (await client.listTools()).tools.find((t) => t.name === "edit_process")!;
  assert.match(edit.description!, /^add +kind\* name id as /m);
  assert.match(edit.description!, /^split +after\* /m);
  assert.match(edit.description!, /^diagram only: place \(.*\); compact \(ids\)$/m);
  assert.match(edit.description!, /boundaryEvent, participant/);
  assert.match(edit.description!, /timer \(timer, timerKind\)/);
  // bpmn-cli 0.9: new ids no longer follow the file's style, and a diagram-only op runs where it stands
  assert.match(edit.description!, /New ids follow element-id-naming's defaults \(userTask_checkInvoice, /);
  assert.match(edit.description!, /The ops run in their order, the diagram-only ones too/);
  // clients cut long descriptions (Claude Code: 4096 characters) — the engine-derived table grows with the
  // engine, so a bump that crosses the budget must shorten the prose, not lose the end
  assert.ok(edit.description!.length < 4000, `edit_process description: ${edit.description!.length} characters`);
});

// ── reading ──────────────────────────────────────────────────────────────────

test("get_process_outline: the model as text — whole, around an element, one element in context, a search", async () => {
  const { call, callJson } = await connect(deps());
  const whole = await callJson("get_process_outline", ref);
  assert.equal(whole.path, PATH);
  assert.equal(whole.baseVersion, baseVersionOf(EXAMPLE));
  assert.match(
    whole.outline,
    /businessRuleTask Task_check_credit "Check credit limit" \[lane=Lane_order_management, calledDecision=credit-limit-check\]/,
  );
  assert.ok(!whole.outline.includes("<bpmn:"), "no XML");
  assert.equal(whole.saveGate, undefined, "the save gate has nothing to say about the example");

  const around = await callJson("get_process_outline", { ...ref, around: "Task_check_credit", depth: 1 });
  assert.match(around.outline, /around Task_check_credit \(depth 1\): 3 of 13 nodes/);
  assert.ok(!around.outline.includes("EndEvent_order_fulfilled"));

  const element = await callJson("get_process_outline", { ...ref, element: "Task_check_credit" });
  assert.match(element.outline, /^lane: Lane_order_management "Order Management"$/m);
  assert.match(element.outline, /^from: userTask Task_validate_order/m);

  const found = await callJson("get_process_outline", { ...ref, find: "credit" });
  assert.match(found.outline, /^businessRuleTask Task_check_credit "Check credit limit"/m);
  const byValue = await callJson("get_process_outline", { ...ref, find: "credit-limit" });
  assert.match(byValue.outline, /Task_check_credit .*\[calledDecision=credit-limit-check\]$/m, "says what matched");

  const dmn = await call("get_process_outline", { repo: REPO.fullName, path: "processes/credit-limit-check.dmn" });
  assert.ok(dmn.isError);
  assert.equal(dmn.text, "not a BPMN model: processes/credit-limit-check.dmn");

  const missing = await call("get_process_outline", { ...ref, around: "Task_check_credi" });
  assert.ok(missing.isError);
  assert.match(missing.text, /^E_NOT_FOUND/);
  assert.match(missing.text, /Task_check_credit/, "names the candidate");

  const two = await call("get_process_outline", { ...ref, around: "Task_check_credit", element: "Task_check_credit" });
  assert.ok(two.isError);
  assert.equal(two.text, "E_USAGE: `around` and `element` exclude each other: pick one view");
  assert.match((await call("get_process_outline", { ...ref, depth: 1 })).text, /`depth` goes only with `around`/);
});

// ── editing ──────────────────────────────────────────────────────────────────

test("a new process: create_process gives one unnamed start event to build on, edit_process adds a path to an end (#183)", async () => {
  const { client, call, callJson } = await connect(deps());
  const create = (await client.listTools()).tools.find((t) => t.name === "create_process");
  assert.match(
    create?.description ?? "",
    /With edit_process, add the path from startEvent_start \(`after` startEvent_start\) to an end event in one change: /,
  );
  const created = await callJson("create_process", { repo: REPO.fullName, name: "Order handling" });
  assert.equal(created.process.bpmn, "processes/order-handling.bpmn");
  const fresh = { repo: REPO.fullName, id: "order-handling" };

  const outline = await callJson("get_process_outline", fresh);
  // bpmn-cli's own checks warn about the missing end until there is one; warnings never block a save
  assert.match(
    outline.outline,
    /^process order-handling "Order handling" non-executable\n {2}startEvent startEvent_start\nproblems:\n {2}W_NO_END order-handling: [^\n]*\n {2}W_DEAD_END startEvent_start: [^\n]*$/,
  );
  assert.equal(outline.saveGate, undefined, "a fresh draft passes the save gate");

  // a step on its own would end in a dead end: refused, nothing written
  const alone = await call("edit_process", {
    ...fresh,
    ops: [{ op: "add", kind: "userTask", name: "Check order", after: "startEvent_start" }],
  });
  assert.ok(alone.isError);
  assert.match(alone.text, /userTask_checkOrder is a dead end/);

  const out = await callJson("edit_process", {
    ...fresh,
    ops: [
      { op: "set", id: "startEvent_start", values: { name: "Order received" } },
      { op: "add", kind: "userTask", name: "Check order", after: "startEvent_start", as: "$check" },
      { op: "add", kind: "endEvent", name: "Order checked", after: "$check" },
    ],
  });
  assert.deepEqual([out.ok, out.written, out.save], [true, true, { warnings: [] }]);
  assert.ok(out.change.created.includes('userTask userTask_checkOrder "Check order" - after startEvent_start'));
  const xml = (await callJson("get_bpmn_xml", fresh)).content as string;
  assert.match(xml, /<bpmndi:BPMNShape id="userTask_checkOrder_di" bpmnElement="userTask_checkOrder">/, "one DI style");
  const view = await callJson("get_process", fresh);
  assert.equal(view.name, "Order handling", "the title the process was created with");
  assert.deepEqual(
    view.events.map((e: { id: string; name: string }) => [e.id, e.name]),
    [
      ["startEvent_start", "Order received"],
      ["endEvent_orderChecked", "Order checked"],
    ],
  );
});

test("edit_process: a batch with aliases lands in the live document, drawn, with element-id-naming's ids, nothing else touched", async () => {
  const { callJson, xml } = await connect(deps());
  const out = await callJson("edit_process", {
    ...ref,
    ops: [
      { op: "add", kind: "userTask", name: "Pack goods", after: "Task_fulfill_order", as: "$pack" },
      { op: "add", kind: "boundaryEvent:timer", name: "2 days", on: "$pack", timer: "P2D", as: "$late" },
      { op: "add", kind: "endEvent", name: "Packing escalated", after: "$late" },
      { op: "add", kind: "textAnnotation", text: "packed by the warehouse team", in: "order-to-cash", as: "$note" },
      { op: "connect", source: "$note", target: "$pack" },
    ],
  });
  assert.deepEqual([out.ok, out.written, out.attempts, out.path], [true, true, 1, PATH]);
  const after = await xml();
  assert.equal(out.baseVersion, baseVersionOf(after));
  assert.equal(
    out.change.aliases.$pack,
    "userTask_packGoods",
    "element-id-naming's default, not the file's Task_ style",
  );
  assert.ok(out.change.created.includes('userTask userTask_packGoods "Pack goods" - after Task_fulfill_order'));
  assert.ok(out.change.created.some((c: string) => c.startsWith("boundaryEvent:timer event_timer2Days")));
  assert.ok(out.change.created.some((c: string) => c.startsWith("sequenceFlow flow_packGoodsToInvoiceHandling")));
  assert.ok(
    out.change.changed.includes(
      "sequenceFlow Flow_to_invoice - Task_fulfill_order -> userTask_packGoods (was -> CallActivity_invoice_handling)",
    ),
    "an existing id keeps its form",
  );
  assert.equal(out.change.layout.mode, "incremental", "the hand-drawn diagram is kept");
  assert.ok(!JSON.stringify(out).includes("<bpmn:"), "no XML in the result");

  // the new elements are in the document, in a lane, drawn
  assert.match(after, /<bpmn:userTask id="userTask_packGoods" name="Pack goods"/);
  assert.match(after, /<bpmn:flowNodeRef>userTask_packGoods<\/bpmn:flowNodeRef>/);
  assert.match(after, /<bpmndi:BPMNShape id="[^"]+" bpmnElement="userTask_packGoods"/);
  assert.match(after, /<bpmn:timeDuration[^>]*>P2D<\/bpmn:timeDuration>/);
  assert.match(after, /<bpmn:textAnnotation id="[^"]+">\s*<bpmn:text>packed by the warehouse team<\/bpmn:text>/);
  // the rest keeps its text: the root tag (plus the xsi declaration the timer's xsi:type needs), most lines
  const root = (t: string) => t.match(/<bpmn:definitions[^>]*>/)![0];
  assert.equal(root(after).replace(' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"', ""), root(EXAMPLE));
  assert.ok(after.includes(' calledDecision="credit-limit-check"'));
  const kept = new Set(after.split("\n"));
  const lines = EXAMPLE.split("\n");
  assert.ok(lines.filter((l) => kept.has(l)).length / lines.length > 0.75, "most original lines survive");
});

test("edit_process: the format ops say what they did to the drawing", async () => {
  const { callJson } = await connect(deps());
  const out = await callJson("edit_process", {
    ...ref,
    ops: [
      { op: "color", ids: ["Task_validate_order"], color: "red" },
      { op: "tidy", ids: ["Task_check_credit"] },
    ],
  });
  assert.equal(out.written, true);
  assert.deepEqual(out.change.format, ["color #0: colored Task_validate_order", "tidy #1: nothing to do"]);
});

test("edit_process: a diagram-only op runs where it stands, so it cannot name what a later op adds (bpmn-cli 0.9)", async () => {
  const { call, callJson, xml } = await connect(deps());
  const add = {
    op: "add",
    kind: "userTask",
    name: "Pack goods",
    after: "Task_fulfill_order",
    id: "userTask_packGoods",
  };
  const color = { op: "color", ids: ["userTask_packGoods"], color: "red" };
  const early = await call("edit_process", { ...ref, ops: [color, add] });
  assert.ok(early.isError, early.text);
  assert.match(early.text, /^E_NOT_FOUND in ops\[0\] \(userTask_packGoods\)/);
  assert.match(
    early.text,
    /^hint: color is a diagram-only op and sees only what the ops before it made: if a later op adds userTask_packGoods, put color after that op\./m,
  );
  assert.equal(await xml(), EXAMPLE);

  const late = await callJson("edit_process", { ...ref, ops: [add, color] });
  assert.equal(late.written, true);
  assert.deepEqual(late.change.format, ["color #1: colored userTask_packGoods"]);
});

test("edit_process: a failing op refuses the whole batch — the engine's error, candidates, document untouched", async () => {
  const { call, xml } = await connect(deps());
  const notFound = await call("edit_process", {
    ...ref,
    ops: [...RENAME, { op: "add", kind: "userTask", name: "Ship", after: "Task_fulfil_order" }],
  });
  assert.ok(notFound.isError);
  assert.match(notFound.text, /^E_NOT_FOUND in ops\[1\]/);
  assert.match(notFound.text, /Task_fulfill_order/);
  assert.equal(await xml(), EXAMPLE);

  const badKey = await call("edit_process", { ...ref, ops: [{ op: "add", kind: "userTask", nam: "Ship" }] });
  assert.ok(badKey.isError);
  assert.match(badKey.text, /^E_USAGE/);
  assert.match(badKey.text, /did you mean "name"/, "op keys reach the engine — the loose op schema strips nothing");

  const badOp = await call("edit_process", { ...ref, ops: [{ op: "insert", kind: "userTask" }] });
  assert.ok(badOp.isError);
  assert.match(badOp.text, /add/, "the op schema lists the ops");
  assert.equal(await xml(), EXAMPLE);
});

test("edit_process: a change that adds a save-gate error is refused inside the engine, document untouched", async () => {
  const { call, xml } = await connect(deps());
  // a boundary event without a path is a dead end for designIQ's validator
  const out = await call("edit_process", {
    ...ref,
    ops: [{ op: "add", kind: "boundaryEvent:timer", name: "1 day", on: "Task_validate_order", timer: "P1D" }],
  });
  assert.ok(out.isError, out.text);
  assert.match(out.text, /^E_VALIDATION/);
  assert.match(out.text, /^- \[design-iq\] bpmn\/flow: event_timer1Day is a dead end/m);
  assert.match(out.text, /^hint: complete the change in the same call/m);
  assert.equal(await xml(), EXAMPLE);
});

test("edit_process: removing a node cleans its associations and message flows (#236 finding 2)", async () => {
  const collab = await applyToXml(EXAMPLE, [
    { op: "add", kind: "participant", name: "Customer", blackBox: true, as: "$customer" },
    { op: "connect", source: "Task_reject_order", target: "$customer", name: "rejection" },
    { op: "add", kind: "textAnnotation", text: "sent by mail", in: "order-to-cash", as: "$note" },
    { op: "connect", source: "$note", target: "Task_reject_order" },
  ]);
  const { callJson, xml } = await connect(deps(collab.xml));
  assert.match(await xml(), /<bpmn:messageFlow /);
  const out = await callJson("edit_process", { ...ref, ops: [{ op: "remove", ids: ["Task_reject_order"] }] });
  assert.equal(out.written, true);
  const after = await xml();
  assert.ok(!after.includes("Task_reject_order"), "no reference to the removed node is left");
  assert.ok(!/<bpmn:messageFlow /.test(after) && !/<bpmn:association /.test(after));
});

test("edit_process: retype keeps the extensions and documentation of an activity (#236 finding 7)", async () => {
  const withExtras = await applyToXml(EXAMPLE, [
    { op: "set", id: "Task_validate_order", values: { doc: "Four eyes." } },
    {
      op: "ext",
      id: "Task_validate_order",
      action: "add",
      xml: '<camunda:properties xmlns:camunda="http://camunda.org/schema/1.0/bpmn"><camunda:property name="sla" value="1d"/></camunda:properties>',
    },
  ]);
  const { callJson, xml } = await connect(deps(withExtras.xml));
  await callJson("edit_process", { ...ref, ops: [{ op: "retype", id: "Task_validate_order", kind: "manualTask" }] });
  const task = (await xml()).match(/<bpmn:manualTask id="Task_validate_order"[\s\S]*?<\/bpmn:manualTask>/)?.[0] ?? "";
  assert.match(task, /<bpmn:documentation>Four eyes\.<\/bpmn:documentation>/);
  assert.match(task, /<camunda:property name="sla" value="1d"/);
});

// ── dry runs and the save gate ───────────────────────────────────────────────

test("dry run: computes, asks the save gate, writes nothing (#236 finding 4)", async () => {
  const { callJson, xml } = await connect(deps());
  const out = await callJson("edit_process", { ...ref, dryRun: true, ops: RENAME });
  assert.deepEqual([out.ok, out.written, out.dryRun, out.wouldSave], [true, false, true, true]);
  assert.deepEqual(out.change.changed, ['userTask Task_validate_order "Check order" - name=Check order']);
  assert.equal(out.baseVersion, baseVersionOf(EXAMPLE));
  assert.equal(await xml(), EXAMPLE);

  // a change that changes nothing has nothing to save: no verdict is made up
  const same = await callJson("edit_process", {
    ...ref,
    dryRun: true,
    ops: [{ op: "set", id: "Task_validate_order", values: { name: "Validate order" } }],
  });
  assert.deepEqual([same.unchanged, same.dryRun, same.wouldSave], [true, true, undefined]);
});

test("get_process_outline: a save gate that refuses every save (a document over the size cap) says so", async () => {
  const { callJson } = await connect(deps(EXAMPLE, { maxDocBytes: 1_000 }));
  const out = await callJson("get_process_outline", ref);
  assert.match(out.saveGate.refused, /exceeds the 1000-byte document cap/);
});

test("errors already in the document: the outline shows them, a dry run and the save say why and how to go on", async () => {
  // a second start event — the save gate refuses the WHOLE document (lint 'block'), not only new errors
  const broken = EXAMPLE.replace(
    "</bpmn:process>",
    '<bpmn:startEvent id="StartEvent_extra" name="Second start" /></bpmn:process>',
  );
  const { call, callJson, xml } = await connect(deps(broken));
  const outline = await callJson("get_process_outline", ref);
  assert.ok(outline.saveGate.errors.some((e: string) => /expected exactly one start event/.test(e)));

  const dry = await callJson("edit_process", { ...ref, dryRun: true, ops: RENAME });
  assert.equal(dry.wouldSave, false);
  assert.match(dry.refused, /the document had these before your change \(your operations added none\)/);
  assert.match(dry.refused, /^- \[bpmn\/flow\] expected exactly one start event .*, found 2$/m);
  assert.match(dry.refused, /pass lint 'warn' if the user wants to save the model with its errors/);

  const real = await call("edit_process", { ...ref, ops: RENAME });
  assert.ok(real.isError);
  assert.equal(real.text, dry.refused);
  assert.equal(await xml(), broken);

  const layout = await call("layout_process", { ...ref, mode: "redraw" });
  assert.ok(layout.isError);
  assert.match(layout.text, /\(the layout added none\)/);
  assert.match(layout.text, /Repair them first \(edit_process\), or pass lint 'warn'/);

  // an edit that repairs them in the same call is saved
  const repaired = await callJson("edit_process", {
    ...ref,
    ops: [...RENAME, { op: "remove", ids: ["StartEvent_extra"] }],
  });
  assert.equal(repaired.written, true);

  // lint 'warn' saves anyway and reports the errors, like save_bpmn_xml
  const again = await connect(deps(broken));
  const warned = await again.callJson("edit_process", { ...ref, lint: "warn", ops: RENAME });
  assert.equal(warned.written, true);
  assert.ok(warned.save.errors.some((e: string) => /exactly one start event/.test(e)));
});

// ── layout ───────────────────────────────────────────────────────────────────

/** every edge of a document has at least two waypoints */
function assertEdgesRouted(xml: string): void {
  const edges = xml.match(/<bpmndi:BPMNEdge [\s\S]*?<\/bpmndi:BPMNEdge>/g) ?? [];
  assert.ok(edges.length >= 10);
  for (const e of edges) assert.ok((e.match(/<di:waypoint /g) ?? []).length >= 2, e.slice(0, 80));
}

test("layout_process: tidy removes an overlap, changing only the geometry; a clean drawing is left alone", async () => {
  // a person dropped "Check credit limit" onto "Validate order"
  const messy = EXAMPLE.replace(
    '<dc:Bounds x="470" y="130" width="100" height="80" />',
    '<dc:Bounds x="330" y="270" width="100" height="80" />',
  );
  assert.notEqual(messy, EXAMPLE);
  const { callJson, xml } = await connect(deps(messy));
  const before = (await callJson("get_process_outline", ref)).outline;
  const dry = await callJson("layout_process", { ...ref, mode: "tidy", dryRun: true });
  assert.deepEqual([dry.ok, dry.written, dry.unchanged, dry.wouldSave], [true, false, undefined, true]);
  assert.equal(await xml(), messy);

  const tidy = await callJson("layout_process", { ...ref, mode: "tidy" });
  assert.equal(tidy.written, true);
  const after = await xml();
  const bounds = (t: string) => t.match(/bpmnElement="Task_check_credit">\s*<dc:Bounds [^>]*>/)![0];
  assert.notEqual(bounds(after), bounds(messy), "the dropped shape moved");
  assertEdgesRouted(after);
  assert.equal((await callJson("get_process_outline", ref)).outline, before, "the model itself is untouched");

  const clean = await (await connect(deps())).callJson("layout_process", { ...ref, mode: "tidy", dryRun: true });
  assert.deepEqual([clean.unchanged, clean.wouldSave], [true, undefined], "nothing to do, no verdict made up");
});

test("layout_process: redraw draws anew, changing only the geometry; every edge keeps its waypoints (#236 finding 3)", async () => {
  const { call, callJson, xml } = await connect(deps());
  const before = (await callJson("get_process_outline", ref)).outline;
  const redraw = await callJson("layout_process", { ...ref, mode: "redraw" });
  assert.deepEqual([redraw.ok, redraw.written, redraw.change.layout.mode], [true, true, "full"]);
  assertEdgesRouted(await xml());
  assert.equal((await callJson("get_process_outline", ref)).outline, before, "the model itself is untouched");

  const bad = await call("layout_process", { ...ref, mode: "tidy", expand: ["X"] });
  assert.ok(bad.isError);
  assert.match(bad.text, /mode 'redraw'/);
});
