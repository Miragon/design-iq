/**
 * The Live Host's /mcp surface (src/http/mcp.ts), two layers:
 *
 *  (a) TOOL behaviour — createLiveMcpServer driven over an in-memory
 *      Client↔Server pair (packages/mcp house pattern), with openDoc backed by
 *      a REAL Hocuspocus direct connection: get→save round-trip, the conflict
 *      retry loop, validate_bpmn, the todo tools against a fake IssueTracker,
 *      per-call authz, the read-only registration.
 *  (b) TRANSPORT behaviour — the /mcp branch of startApi over real HTTP:
 *      JSON responses (stateless), 405 on GET, 401 + RFC-9728 challenge
 *      without credentials, -32700 on garbage.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { presenceColor } from "@designiq/contracts/live";
import type { TodoWire } from "@designiq/contracts/live-host";
import type { TodoType } from "@designiq/contracts/todo-types";
import { DIAGRAMS_IN_DOCUMENTS } from "@designiq/mcp-kit";
import { toolNamesIn, toolText } from "@designiq/mcp-kit/testing";
import { NOTATIONS } from "@designiq/notations";
import { Server as HocuspocusServer } from "@hocuspocus/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { SqliteFavoritesStore } from "../src/adapters/sqlite/favorites-store.ts";
import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import { type Session, SessionStore } from "../src/adapters/sqlite/sessions.ts";
import { makeCollabHooks } from "../src/application/collab.ts";
import { addFavorite, recordVisit } from "../src/application/favorites.ts";
import { WsTicketStore } from "../src/application/ws-tickets.ts";
import { newBpmnXml } from "../src/domain/bpmn-template.ts";
import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";
import { type ApiOptions, startApi } from "../src/http/api.ts";
import { createLiveMcpServer, type LiveToolContribution, type McpDeps, WIDGET_FILES } from "../src/http/mcp.ts";
import type { GitProvider } from "../src/ports/git-provider.ts";
import type { IssueTracker, Todo, TodoInput, TrackerTodoTypes } from "../src/ports/issue-tracker.ts";
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
const PATH = "processes/order.bpmn";
const VALID = newBpmnXml("order", "Order");
const VALID_V2 = newBpmnXml("order", "Order v2");

/** the decision fixture — a real table (rules, hit policy, DMNDI), because the
 *  blank template has no rules to derive anything interesting from */
const DMN_PATH = "processes/rabatt.dmn";
const DMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/" xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/" id="Definitions_rabatt" name="Rabatt" namespace="http://bpmiq.dev/dmn/rabatt">
  <decision id="rabatt" name="Rabatt">
    <decisionTable id="DT_rabatt" hitPolicy="FIRST">
      <input id="Input_1" label="Kundentyp">
        <inputExpression id="IE_1" typeRef="string"><text>kundentyp</text></inputExpression>
      </input>
      <output id="Output_1" name="rabatt" typeRef="number" />
      <rule id="Rule_stamm">
        <inputEntry id="e1"><text>"stamm"</text></inputEntry>
        <outputEntry id="e2"><text>10</text></outputEntry>
      </rule>
      <rule id="Rule_neu">
        <inputEntry id="e3"><text>"neu"</text></inputEntry>
        <outputEntry id="e4"><text>0</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
  <dmndi:DMNDI>
    <dmndi:DMNDiagram id="DMNDiagram_rabatt">
      <dmndi:DMNShape id="DMNShape_rabatt" dmnElementRef="rabatt">
        <dc:Bounds height="80" width="180" x="160" y="100" />
      </dmndi:DMNShape>
    </dmndi:DMNDiagram>
  </dmndi:DMNDI>
</definitions>
`;

/** a wardley map — the non-BPMN/DMN notation of the fixture (get_view, list_models) */
const OWM_PATH = "processes/strategy.owm";
const OWM = "component Platform [0.3, 0.4]\ncomponent Checkout [0.8, 0.6]\nCheckout -> Platform\n";

/** a process that delegates to the decision above — the impact link */
const USER_PATH = "processes/uses-rabatt.bpmn";
const USER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="uses-rabatt" name="Uses rabatt">
    <bpmn:businessRuleTask id="Task_rabatt" name="Rabatt ermitteln" calledDecision="rabatt" />
  </bpmn:process>
</bpmn:definitions>
`;

const session = (login = "petra"): Session => ({
  id: `sess-${login}`,
  user: { login, name: login, avatarUrl: null, provider: "github" },
  createdAt: Date.now(),
});

const servers: HocuspocusServer[] = [];
const cleanups: Array<() => unknown> = [];
after(async () => {
  for (const c of cleanups) await c();
  await Promise.all(servers.map((s) => s.destroy()));
  // WATCHDOG: Hocuspocus can leave a poisoned debounce/save-mutex handle behind
  // after its async-unload race (docs: content.ts roomQueues) — a PASSED suite
  // must never hang the runner on it. unref'd: a clean exit ignores it.
  setTimeout(() => process.exit(), 2000).unref();
});

/** tmpdir content repo + real direct-connection openDoc + inline fakes for
 *  every other injected surface (the house style) */
/** one stub per widget bundle — the body carries the file name so a resource
 *  test can tell the bundles apart. loadWidget memoises per (dist, file,
 *  boot): every deps() gets its own tmp dist, so a test may omit files freely. */
const widgetStub = (file: string): string =>
  `<html><head><script>window.DESIGNIQ_BOOT = "__DESIGNIQ_BOOT__";</script></head><body>${file}</body></html>`;

function deps(over: Partial<McpDeps> = {}, widgets: readonly string[] = WIDGET_FILES): McpDeps {
  const ws = mkdtempSync(join(tmpdir(), "designiq-mcp-"));
  mkdirSync(join(ws, "processes"), { recursive: true });
  writeFileSync(join(ws, "designiq.yml"), "processes: processes\n");
  writeFileSync(join(ws, PATH), VALID);
  writeFileSync(join(ws, DMN_PATH), DMN);
  writeFileSync(join(ws, USER_PATH), USER_BPMN);
  writeFileSync(join(ws, OWM_PATH), OWM);
  const webDist = mkdtempSync(join(tmpdir(), "designiq-webdist-"));
  for (const file of widgets) writeFileSync(join(webDist, file), widgetStub(file));
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
    webDist,
    publicUrl: "http://live.test",
    wsTickets: new WsTicketStore(),
    ...over,
  };
}

/** in-memory IssueTracker — the port is the seam, so the tools are testable
 *  without GitHub (the REAL adapter has its own suite: todo-issues.test.ts) */
function fakeIssues(
  todoTypes: TrackerTodoTypes = { types: [], blankAllowed: true },
): IssueTracker & { created: Array<{ repo: string; input: TodoInput }>; closed: string[] } {
  const items: Todo[] = [];
  const created: Array<{ repo: string; input: TodoInput }> = [];
  const closed: string[] = [];
  return {
    id: "fake-tracker",
    created,
    closed,
    async listTodoTypes() {
      return todoTypes;
    },
    async createTodo(repo, input) {
      created.push({ repo, input });
      const todo: Todo = {
        id: String(items.length + 1),
        url: `https://tracker.test/${repo}/issues/${items.length + 1}`,
        title: input.title,
        body: input.body,
        state: "open",
        anchor: input.anchor,
        author: input.author,
        assignees: [],
        createdAt: new Date().toISOString(),
      };
      items.push(todo);
      return todo;
    },
    async listTodos(_repo, model) {
      return items.filter(
        (t) => t.state === "open" && (!model || (t.anchor?.notation === model.notation && t.anchor.model === model.id)),
      );
    },
    async closeTodo(_repo, id) {
      closed.push(id);
      const hit = items.find((t) => t.id === id);
      if (!hit) throw new Error(`no such todo: ${id}`);
      hit.state = "done";
    },
    async retargetTodo(_repo, id, _from, to) {
      const hit = items.find((t) => t.id === id);
      if (!hit?.anchor || hit.anchor.model === to.model) return "unchanged";
      hit.anchor = { ...hit.anchor, model: to.model, file: to.file };
      return "moved";
    },
  };
}

async function connect(d: McpDeps, s: Session = session(), contributions: LiveToolContribution[] = []) {
  const server = createLiveMcpServer(d, s, contributions);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  cleanups.push(() => Promise.all([client.close(), server.close()]));
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    toolText(await client.callTool({ name, arguments: args }));
  const callJson = async (name: string, args: Record<string, unknown> = {}) => {
    const { isError, text } = await call(name, args);
    assert.ok(!isError, `${name} unexpectedly errored: ${text}`);
    return JSON.parse(text) as Record<string, any>;
  };
  return { client, call, callJson };
}

// ── (a) tool behaviour ──────────────────────────────────────────────────────

test("registration: every tool; read-only mode drops the write tools AND the ws ticket", async () => {
  const full = await connect(deps());
  assert.deepEqual((await full.client.listTools()).tools.map((t) => t.name).sort(), [
    "analyze_decision",
    "create_decision",
    "create_model",
    "create_process",
    "get_bpmn_xml",
    "get_decision",
    "get_decision_tests",
    "get_dmn_xml",
    "get_model_content",
    "get_presence",
    "get_process",
    "get_view",
    "list_changes",
    "list_decisions",
    "list_models",
    "list_processes",
    "list_repos",
    "mint_ws_ticket",
    "open_context_map_modeler",
    "open_decision_modeler",
    "open_event_storming_modeler",
    "open_modeler",
    "open_team_topology_modeler",
    "open_wardley_modeler",
    "release_process",
    "run_decision_tests",
    "save_bpmn_xml",
    "save_decision_tests",
    "save_dmn_xml",
    "save_model_content",
    "simulate_decision",
    "validate_bpmn",
    "validate_model",
  ]);
  // open_modeler stays in read-only mode (opening is a read; the widget's
  // readonly marker turns it into a viewer)
  const ro = await connect(deps({ mcpReadOnly: true }));
  assert.deepEqual((await ro.client.listTools()).tools.map((t) => t.name).sort(), [
    "analyze_decision",
    "get_bpmn_xml",
    "get_decision",
    "get_decision_tests",
    "get_dmn_xml",
    "get_model_content",
    "get_presence",
    "get_process",
    "get_view",
    "list_changes",
    "list_decisions",
    "list_models",
    "list_processes",
    "list_repos",
    "open_context_map_modeler",
    "open_decision_modeler",
    "open_event_storming_modeler",
    "open_modeler",
    "open_team_topology_modeler",
    "open_wardley_modeler",
    "run_decision_tests",
    "simulate_decision",
    "validate_bpmn",
    "validate_model",
  ]);
});

test("registration: LIVE_MCP_BPMN_EDIT adds the semantic BPMN tools; read-only keeps the outline", async () => {
  const bpmnTools = async (d: McpDeps) =>
    (await (await connect(d)).client.listTools()).tools
      .map((t) => t.name)
      .filter((n) => ["edit_process", "get_process_outline", "layout_process"].includes(n))
      .sort();
  assert.deepEqual(await bpmnTools(deps({ bpmnEdit: true })), [
    "edit_process",
    "get_process_outline",
    "layout_process",
  ]);
  assert.deepEqual(await bpmnTools(deps({ bpmnEdit: true, mcpReadOnly: true })), ["get_process_outline"]);
  assert.deepEqual(await bpmnTools(deps()), []);
});

test("registration: the todo tools appear only WITH a tracker; read-only keeps the listing one", async () => {
  const withTracker = await connect(deps({ issues: fakeIssues() }));
  const names = (await withTracker.client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names.filter((n) => n.includes("todo")).sort(), [
    "close_todo",
    "create_todo",
    "list_todo_types",
    "list_todos",
  ]);

  // no tracker configured → absent from tools/list, never a call that fails
  const none = await connect(deps());
  assert.deepEqual(
    (await none.client.listTools()).tools.map((t) => t.name).filter((n) => n.includes("todo")),
    [],
  );

  // read-only: listing is a read and stays; filing/closing are writes and go
  const ro = await connect(deps({ issues: fakeIssues(), mcpReadOnly: true }));
  assert.deepEqual(
    (await ro.client.listTools()).tools.map((t) => t.name).filter((n) => n.includes("todo")),
    ["list_todos"],
  );
});

test("titles: every tool carries a short, unique display title — in every mode", async () => {
  // the tracker + bpmnEdit modes register the superset (todo and semantic BPMN tools on top of the core)
  const modes: Array<[string, McpDeps]> = [
    ["full, tracker, bpmnEdit", deps({ issues: fakeIssues(), bpmnEdit: true })],
    ["read-only, tracker, bpmnEdit", deps({ issues: fakeIssues(), mcpReadOnly: true, bpmnEdit: true })],
  ];
  for (const [mode, d] of modes) {
    const { client } = await connect(d);
    const tools = (await client.listTools()).tools;
    // hosts show the title to people instead of the snake_case name — a tool
    // without one falls back to the name, so a forgotten title is drift
    assert.deepEqual(
      tools.filter((t) => !t.title?.trim()).map((t) => t.name),
      [],
      `${mode}: tools without a title`,
    );
    const byTitle = new Map<string, string>();
    for (const t of tools) {
      const title = t.title ?? "";
      assert.equal(byTitle.get(title), undefined, `${mode}: ${t.name} reuses the title of ${byTitle.get(title)}`);
      byTitle.set(title, t.name);
      // sentence case, verb first, no trailing period, short
      assert.match(title, /^[A-Z][a-z]+ /, `${mode}: ${t.name} title "${title}" starts with a capitalised verb`);
      assert.ok(!title.endsWith("."), `${mode}: ${t.name} title "${title}" ends without a period`);
      assert.ok(title.length <= 40, `${mode}: ${t.name} title "${title}" is short`);
    }
  }
  // the owner-chosen wording of the anchors, and the label-derived widget rows
  const { client } = await connect(deps());
  const titleOf = new Map((await client.listTools()).tools.map((t) => [t.name, t.title]));
  assert.equal(titleOf.get("list_models"), "List models");
  assert.equal(titleOf.get("get_bpmn_xml"), "Get BPMN XML");
  assert.equal(titleOf.get("validate_model"), "Validate a model");
  assert.equal(titleOf.get("release_process"), "Release changes as pull request");
  assert.equal(titleOf.get("open_modeler"), "Open BPMN modeler");
  assert.equal(titleOf.get("open_decision_modeler"), "Open DMN modeler");
  assert.equal(titleOf.get("open_wardley_modeler"), "Open Wardley Map modeler");
  assert.equal(titleOf.get("open_event_storming_modeler"), "Open Event Storming modeler");
});

test("instructions: present with a title, and every tool they name is registered — in every mode", async () => {
  const modes: Array<[string, McpDeps]> = [
    ["full", deps()],
    ["read-only", deps({ mcpReadOnly: true })],
    ["tracker", deps({ issues: fakeIssues() })],
    ["tracker, read-only", deps({ issues: fakeIssues(), mcpReadOnly: true })],
    ["no widgets", deps({}, [])],
    ["wardley widget only", deps({}, ["mcp-app-wardley.html"])],
    ["bpmnEdit", deps({ bpmnEdit: true })],
    ["bpmnEdit, read-only", deps({ bpmnEdit: true, mcpReadOnly: true })],
  ];
  for (const [mode, d] of modes) {
    const { client } = await connect(d);
    assert.equal(client.getServerVersion()?.title, "designIQ Live Host", mode);
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /^designIQ is /, `${mode}: the instructions open with the product`);
    const registered = new Set((await client.listTools()).tools.map((t) => t.name));
    const mentioned = toolNamesIn(instructions);
    // the drift guard: prose may never name a tool this server lacks
    assert.deepEqual(
      mentioned.filter((name) => !registered.has(name)),
      [],
      `${mode}: instructions name unregistered tools`,
    );
    // the start order and the notation-neutral core are always named
    for (const name of ["list_repos", "list_models", "get_view", "get_model_content", "validate_model"]) {
      assert.ok(mentioned.includes(name), `${mode}: instructions name ${name}`);
    }
    // every registered notation is listed with its extensions
    for (const n of NOTATIONS) assert.ok(instructions.includes(n.label), `${mode}: names ${n.label}`);
    // where a diagram goes: the ONE sentence both servers send, never a file of its own
    assert.ok(instructions.includes(DIAGRAMS_IN_DOCUMENTS), `${mode}: says where a diagram goes`);
    assert.doesNotMatch(instructions, /\.mmd|\.mermaid/, `${mode}: no standalone diagram files`);
    // …and every served modeler widget is offered for showing models to people
    for (const name of registered) {
      if (/^open_.*modeler$/.test(name)) assert.ok(mentioned.includes(name), `${mode}: instructions name ${name}`);
    }
    // the semantic BPMN tools are named whenever they are registered
    for (const name of ["edit_process", "get_process_outline", "layout_process"]) {
      if (registered.has(name)) assert.ok(mentioned.includes(name), `${mode}: instructions name ${name}`);
    }
  }
});

test("todos: create anchors to the open process, list filters by it, close completes it", async () => {
  const issues = fakeIssues();
  const { call, callJson } = await connect(deps({ issues }));

  const created = await callJson("create_todo", {
    repo: REPO.fullName,
    id: "order",
    title: "  Check the credit limit  ",
    body: "The threshold looks stale.",
    elements: [{ id: "StartEvent_1", name: "Process started" }],
  });
  assert.equal(created.todo.title, "Check the credit limit", "title is trimmed");
  assert.equal(created.todo.author, "petra", "attribution is the CALLER's login, not an argument");
  assert.deepEqual(created.todo.anchor, {
    notation: "bpmn",
    model: "order",
    file: PATH,
    elements: [{ id: "StartEvent_1", name: "Process started" }],
    processVersion: null,
  });

  // a `path`-addressed todo derives the process id from the file stem
  await callJson("create_todo", { repo: REPO.fullName, path: PATH, title: "Process-level note" });
  const viaPath = issues.created[1]?.input.anchor;
  assert.equal(viaPath?.model, "order");
  assert.deepEqual(viaPath?.elements, [], "no elements ⇒ a process-level todo");

  // listing: whole repo vs. narrowed to one process
  const all = await callJson("list_todos", { repo: REPO.fullName });
  assert.equal(all.model, null);
  assert.equal(all.todos.length, 2);
  const narrowed = await callJson("list_todos", { repo: REPO.fullName, id: "order" });
  assert.deepEqual(narrowed.model, { notation: "bpmn", id: "order" });
  assert.equal(narrowed.todos.length, 2);
  const other = await callJson("list_todos", { repo: REPO.fullName, id: "not-a-process" });
  assert.deepEqual(other.todos, [], "an unknown process filter is an empty list, not an error");

  // close takes the TRACKER id (never a process id) and drops it from the list
  const closed = await callJson("close_todo", { repo: REPO.fullName, todoId: created.todo.id });
  assert.equal(closed.ok, true);
  assert.deepEqual(issues.closed, [created.todo.id]);
  assert.equal((await callJson("list_todos", { repo: REPO.fullName })).todos.length, 1);

  // an empty title is refused before the tracker is touched (the shared
  // use-case speaks the REST wording on both transports)
  const blank = await call("create_todo", { repo: REPO.fullName, id: "order", title: "   " });
  assert.ok(blank.isError);
  assert.match(blank.text, /title must be a non-empty string/);
  assert.equal(issues.created.length, 2);

  // an unknown model is a typed 404, never a stored anchor pointing at nothing
  const dangling = await call("create_todo", { repo: REPO.fullName, id: "no-such-process", title: "x" });
  assert.ok(dangling.isError);
  assert.match(dangling.text, /unknown model 'no-such-process'/);
  const noProcess = await call("create_todo", { repo: REPO.fullName, id: "strategy", notation: "bpmn", title: "x" });
  assert.match(noProcess.text, /unknown model 'strategy' \(bpmn\)/, "asked for a process, which does not exist");
  assert.equal(issues.created.length, 2);
});

test("todos: an element id the process does not have is refused with its closest ids, any element of the XML is one", async () => {
  const issues = fakeIssues();
  const { call, callJson } = await connect(deps({ issues }));

  const unknown = await call("create_todo", {
    repo: REPO.fullName,
    id: "order",
    title: "x",
    elements: [{ id: "StartEvent_1" }, { id: "StartEvent_2" }, { id: "StartEvent_1_di" }],
  });
  assert.ok(unknown.isError);
  assert.equal(
    unknown.text,
    "The process 'order' has no element with these ids:\n" +
      "- StartEvent_2: closest StartEvent_1 (Process started), EndEvent_1 (Process completed), Participant_order (Order)\n" +
      "- StartEvent_1_di: closest StartEvent_1 (Process started), EndEvent_1 (Process completed), Participant_order (Order)\n" +
      "Anchor the todo to ids get_view reports, or omit `elements` for a todo on the whole process.",
    "the diagram interchange's ids are no elements",
  );
  assert.equal(issues.created.length, 0);

  // the pool is no node of the process graph, yet the canvas selects it
  await callJson("create_todo", {
    repo: REPO.fullName,
    id: "order",
    title: "x",
    elements: [{ id: "Participant_order" }],
  });
  assert.deepEqual(issues.created[0]?.input.anchor.elements, [{ id: "Participant_order", name: null }]);
});

test("todos on other notations: a Wardley Map takes them, the same id of a process stays apart, a decision has none", async () => {
  const issues = fakeIssues();
  const d = deps({ issues });
  const { call, callJson } = await connect(d);

  // the id alone finds the map (no process of that id); a component is
  // anchored by the id its canvas gives it, the one get_view reports
  const view = await callJson("get_view", { repo: REPO.fullName, id: "strategy" });
  assert.deepEqual(
    view.detail.elements.map((e: { id: string; name: string }) => [e.id, e.name]),
    [
      ["cmp_platform", "Platform"],
      ["cmp_checkout", "Checkout"],
    ],
  );
  const created = await callJson("create_todo", {
    repo: REPO.fullName,
    id: "strategy",
    title: "Platform is a commodity now",
    elements: [{ id: "cmp_platform", name: "Platform" }],
  });
  assert.deepEqual(created.todo.anchor, {
    notation: "wardley",
    model: "strategy",
    file: OWM_PATH,
    elements: [{ id: "cmp_platform", name: "Platform" }],
    processVersion: null,
  });
  // a name is no id: the error leads with the component's id
  const byName = await call("create_todo", {
    repo: REPO.fullName,
    id: "strategy",
    title: "x",
    elements: [{ id: "Platform" }],
  });
  assert.ok(byName.isError);
  assert.match(
    byName.text,
    /^The Wardley Map 'strategy' has no element with this id:\n- Platform: closest cmp_platform \(Platform\), /,
  );
  assert.equal(issues.created.length, 1);
  // a path names its model, notation included
  await callJson("create_todo", { repo: REPO.fullName, path: OWM_PATH, title: "Map-level note" });
  assert.equal(issues.created[1]?.input.anchor.notation, "wardley");

  // processes/order.tt beside processes/order.bpmn: `notation` picks one, the id alone the process
  await callJson("create_model", { repo: REPO.fullName, notation: "team-topology", name: "Order" });
  await callJson("create_todo", { repo: REPO.fullName, id: "order", notation: "team-topology", title: "Teams" });
  await callJson("create_todo", { repo: REPO.fullName, id: "order", title: "Process" });
  assert.deepEqual(
    issues.created.slice(2).map((c) => [c.input.anchor.notation, c.input.anchor.file]),
    [
      ["team-topology", "processes/order.tt"],
      ["bpmn", PATH],
    ],
  );
  const teams = await callJson("list_todos", { repo: REPO.fullName, id: "order", notation: "team-topology" });
  assert.deepEqual(
    teams.todos.map((t: TodoWire) => t.title),
    ["Teams"],
  );
  const map = await callJson("list_todos", { repo: REPO.fullName, path: OWM_PATH });
  assert.deepEqual(map.model, { notation: "wardley", id: "strategy" });
  assert.equal(map.todos.length, 2);

  // moved to another folder: the label still finds the todos, and the list
  // names where the map is now (the anchor in the tracker keeps the old path)
  const ws = await d.workspaces.ensure(REPO);
  mkdirSync(join(ws, "processes", "maps"));
  renameSync(join(ws, OWM_PATH), join(ws, "processes", "maps", "strategy.owm"));
  const afterMove = await callJson("list_todos", { repo: REPO.fullName, id: "strategy", notation: "wardley" });
  assert.deepEqual(
    afterMove.todos.map((t: TodoWire) => t.anchor?.file),
    ["processes/maps/strategy.owm", "processes/maps/strategy.owm"],
  );
  assert.equal(issues.created[0]?.input.anchor.file, OWM_PATH, "nothing was written back to the tracker");

  // decisions take no todos (yet): a typed 400 naming the notations that do
  const decision = await call("create_todo", { repo: REPO.fullName, path: DMN_PATH, title: "x" });
  assert.ok(decision.isError);
  assert.match(decision.text, /not filed on decisions/);
  assert.match(decision.text, /bpmn, wardley/);
  assert.equal(issues.created.length, 4);

  // a document has no element ids to anchor to
  writeFileSync(join(ws, "processes", "notes.md"), "# Notes\n");
  const onDocument = await call("create_todo", {
    repo: REPO.fullName,
    path: "processes/notes.md",
    title: "x",
    elements: [{ id: "notes" }],
  });
  assert.ok(onDocument.isError);
  assert.equal(onDocument.text, "a document takes todos on the whole document only: omit `elements`");

  // a text that does not parse right now has no ids to check: the anchor is kept
  writeFileSync(join(ws, "processes", "draft.tt"), "{");
  await callJson("create_todo", {
    repo: REPO.fullName,
    path: "processes/draft.tt",
    title: "x",
    elements: [{ id: "team-1" }],
  });
  assert.deepEqual(issues.created.at(-1)?.input.anchor.elements, [{ id: "team-1", name: null }]);
});

const STORM_PATH = "processes/board.storm";
const STORM = [
  "title Checkout",
  "actor Customer [80, 300]",
  "command Place Order [240, 300]",
  "event Order Placed [620, 300]",
  "note Remember this [80, 80]",
  "line [[0, 0], [40, 40]]",
  "Customer -> Place Order",
  "",
].join("\n");

const CM_PATH = "processes/landscape.cm.json";
const CM = JSON.stringify({
  version: 1,
  title: "Landscape",
  contexts: [
    { id: "ctx_auth", label: "User Access", position: { x: 0, y: 0 }, size: { width: 200, height: 110 } },
    { id: "ctx_cfp", label: "CfP Management", position: { x: 300, y: 0 }, size: { width: 200, height: 110 } },
  ],
  relationships: [{ id: "rel_auth_cfp", from: "ctx_auth", to: "ctx_cfp", pattern: "partnership" }],
});

const TT_PATH = "processes/shop.tt";
const TT = JSON.stringify({
  version: 3,
  title: "Shop",
  nodes: [
    {
      id: "team_checkout",
      type: "stream-aligned",
      label: "Checkout",
      position: { x: 0, y: 0 },
      size: { width: 240, height: 96 },
    },
  ],
});

test("todos: an anchor must be an element its canvas addresses, on every notation with element ids", async () => {
  const issues = fakeIssues();
  const d = deps({ issues });
  const { call, callJson } = await connect(d);
  const ws = await d.workspaces.ensure(REPO);
  writeFileSync(join(ws, STORM_PATH), STORM);
  writeFileSync(join(ws, CM_PATH), CM);
  writeFileSync(join(ws, TT_PATH), TT);
  const anchored = (path: string, ids: string[]) =>
    call("create_todo", { repo: REPO.fullName, path, title: "x", elements: ids.map((id) => ({ id })) });

  // a sticky of the board is an element, a note, a drawing and an arrow are not: their ids come from the
  // line order, no canvas selects them, and an edit above one hands its id to another element
  for (const id of ["cmd_place_order", "event_order_placed", "actor_customer"]) {
    assert.ok(!(await anchored(STORM_PATH, [id])).isError, `${id} is a sticky`);
  }
  for (const id of ["note_remember_this", "draw_line", "arrow_1"]) {
    const refused = await anchored(STORM_PATH, [id]);
    assert.ok(refused.isError, `${id} is no element the board's canvas addresses`);
    assert.match(refused.text, /^The Event Storming board 'board' has no element with this id:\n/);
  }
  const closest = await anchored(STORM_PATH, ["cmd_place_orders"]);
  assert.match(closest.text, /- cmd_place_orders: closest cmd_place_order \(Place Order\), /);

  // a context and a relationship are elements of a Context Map
  assert.ok(!(await anchored(CM_PATH, ["ctx_auth", "rel_auth_cfp"])).isError);
  const context = await anchored(CM_PATH, ["ctx_auht"]);
  assert.ok(context.isError);
  assert.match(
    context.text,
    /^The Context Map 'landscape' has no element with this id:\n- ctx_auht: closest ctx_auth \(User Access\), /,
  );

  // a team of a Team Topology is an element
  assert.ok(!(await anchored(TT_PATH, ["team_checkout"])).isError);
  const team = await anchored(TT_PATH, ["Checkout"]);
  assert.ok(team.isError);
  assert.match(team.text, /- Checkout: closest team_checkout \(Checkout\)/);

  // a Wardley link is numbered by its line: no canvas addresses it
  for (const id of ["dep_1", "flow_1"]) {
    const refused = await anchored(OWM_PATH, [id]);
    assert.ok(refused.isError, `${id} is a link`);
    assert.match(
      refused.text,
      new RegExp(`^The Wardley Map 'strategy' has no element with this id:\\n- ${id}: closest cmp_`),
    );
  }
  const view = await callJson("get_view", { repo: REPO.fullName, id: "strategy" });
  assert.deepEqual(view.detail.links, [{ from: "cmp_checkout", to: "cmp_platform", kind: "dependency", label: null }]);

  // a document that misses its schema (a team without a string id or label) neither throws nor hides the error
  writeFileSync(
    join(ws, "processes", "draft.tt"),
    '{"version":3,"nodes":[{"id":"team_a","label":42},{"id":7,"label":"B"}]}',
  );
  const malformed = await anchored("processes/draft.tt", ["team_b"]);
  assert.ok(malformed.isError);
  assert.match(malformed.text, /^The Team Topology 'draft' has no element with this id:\n- team_b: closest team_a\n/);
  assert.equal(issues.created.length, 5, "only the anchors the canvas addresses were filed");
});

const BUG_TYPE: TodoType = {
  id: "bug",
  name: "Bug report",
  description: "Something is broken",
  titlePrefix: "[Bug]: ",
  fields: [
    {
      id: "hint",
      kind: "markdown",
      label: "",
      description: null,
      placeholder: null,
      value: "Thanks for reporting!",
      options: [],
      multiple: false,
      required: false,
    },
    {
      id: "repro",
      kind: "textarea",
      label: "Steps to reproduce",
      description: null,
      placeholder: null,
      value: null,
      options: [],
      multiple: false,
      required: true,
    },
  ],
};

test("todo types: a repo without templates offers the built-in Todo alone, filed exactly as before", async () => {
  const issues = fakeIssues();
  const { callJson } = await connect(deps({ issues }));
  const listed = await callJson("list_todo_types", { repo: REPO.fullName });
  assert.deepEqual(
    listed.types.map((t: TodoType) => t.id),
    ["todo"],
  );
  await callJson("create_todo", { repo: REPO.fullName, id: "order", title: "Plain", body: "Free text" });
  const input = issues.created[0]!.input;
  assert.equal(input.body, "Free text");
  assert.ok(!("fields" in input) && !("type" in input.anchor), "a built-in todo carries no type");
  await callJson("create_todo", {
    repo: REPO.fullName,
    id: "order",
    title: "Typed built-in",
    type: "todo",
    fields: { description: "Via fields" },
  });
  assert.equal(issues.created[1]!.input.body, "Via fields");
});

test("todo types: templates without blank issues — the type is required, its fields are checked, the anchor keeps it", async () => {
  const issues = fakeIssues({ types: [BUG_TYPE], blankAllowed: false });
  const { call, callJson } = await connect(deps({ issues }));
  assert.deepEqual(
    (await callJson("list_todo_types", { repo: REPO.fullName })).types.map((t: TodoType) => t.id),
    ["bug"],
  );

  const untyped = await call("create_todo", { repo: REPO.fullName, id: "order", title: "x", body: "y" });
  assert.ok(untyped.isError);
  assert.match(untyped.text, /choose one: Bug report \(bug\)/);

  const incomplete = await call("create_todo", { repo: REPO.fullName, id: "order", title: "x", type: "bug" });
  assert.ok(incomplete.isError);
  assert.equal(incomplete.text, "The Bug report form is not complete:\n- Steps to reproduce (repro) is required");

  const withBody = await call("create_todo", {
    repo: REPO.fullName,
    id: "order",
    title: "x",
    type: "bug",
    body: "free",
    fields: { repro: "Click" },
  });
  assert.ok(withBody.isError);
  assert.match(withBody.text, /takes its text in `fields`/);
  assert.equal(issues.created.length, 0, "nothing incomplete reaches the tracker");

  const created = await callJson("create_todo", {
    repo: REPO.fullName,
    id: "order",
    title: "Saving fails",
    type: "bug",
    fields: { repro: "Click save" },
  });
  assert.equal(created.todo.title, "[Bug]: Saving fails", "the template's title prefix is applied once");
  assert.deepEqual(created.todo.anchor.type, { id: "bug", name: "Bug report" });
  const input = issues.created[0]!.input;
  assert.equal(input.anchor.type?.id, "bug");
  assert.deepEqual(input.fields, { repro: "Click save" });

  const prefixed = await callJson("create_todo", {
    repo: REPO.fullName,
    id: "order",
    title: "[Bug]: Already prefixed",
    type: "bug",
    fields: { repro: "x" },
  });
  assert.equal(prefixed.todo.title, "[Bug]: Already prefixed");
});

test("todo types: blank issues allowed — the built-in Todo comes first, beside the templates", async () => {
  const { callJson } = await connect(deps({ issues: fakeIssues({ types: [BUG_TYPE], blankAllowed: true }) }));
  assert.deepEqual(
    (await callJson("list_todo_types", { repo: REPO.fullName })).types.map((t: TodoType) => t.id),
    ["todo", "bug"],
  );
});

test("todos: per-call authz gates the tracker too — no write access, no todo access", async () => {
  const issues = fakeIssues();
  const { call } = await connect(deps({ issues, access: { canWrite: async () => false } }));
  for (const [tool, args] of [
    ["list_todos", { repo: REPO.fullName }],
    ["create_todo", { repo: REPO.fullName, id: "order", title: "x" }],
    ["list_todo_types", { repo: REPO.fullName }],
    ["close_todo", { repo: REPO.fullName, todoId: "1" }],
  ] as const) {
    const denied = await call(tool, args);
    assert.ok(denied.isError, `${tool} must be denied`);
    assert.match(denied.text, /no write access to acme\/models/);
  }
  assert.equal(issues.created.length, 0, "the tracker was never reached");
});

test("MCP App: open_modeler carries the ui resource link; the resource serves the widget with the boot marker injected", async () => {
  const { client, callJson } = await connect(deps());

  // the tool advertises its UI template (nested + legacy flat key, per ext-apps)
  const tool = (await client.listTools()).tools.find((t) => t.name === "open_modeler");
  assert.ok(tool, "open_modeler registered");
  const meta = tool._meta as {
    ui?: { resourceUri?: string };
    "ui/resourceUri"?: string;
    "openai/outputTemplate"?: string;
  };
  const uri = meta?.ui?.resourceUri;
  assert.ok(uri?.startsWith("ui://designiq/modeler-"), `ui resourceUri: ${uri}`);
  assert.equal(meta?.["ui/resourceUri"], uri);
  // ChatGPT's compatibility alias — older builds read only this key
  assert.equal(meta?.["openai/outputTemplate"], uri);

  // the resource serves the single-file widget with the boot marker replaced
  const res = await client.readResource({ uri: uri! });
  const doc = res.contents[0] as { mimeType?: string; text?: string };
  assert.equal(doc.mimeType, "text/html;profile=mcp-app");
  assert.ok(!doc.text!.includes("__DESIGNIQ_BOOT__"), "marker replaced");
  assert.ok(doc.text!.includes('\\"readonly\\":false'), "boot config injected");
  // the deep-link base rides in the boot payload — the sandboxed iframe has
  // no other way to learn the instance origin
  assert.ok(doc.text!.includes('\\"publicUrl\\":\\"http://live.test\\"'), "publicUrl injected");

  // the tool result stays lean: a summary + the web deep link, never the XML
  const opened = await callJson("open_modeler", { repo: REPO.fullName, id: "order" });
  assert.equal(opened.opened.path, PATH);
  assert.equal(opened.opened.url, "http://live.test/r/acme/models/p/order");
  assert.ok(!JSON.stringify(opened).includes("<bpmn"), "no XML in the tool result");

  // read-only mode flips the widget's boot flag — under a NEW resource uri:
  // the boot payload salts the hash, so hosts caching by uri re-fetch on a
  // config change instead of serving a stale boot
  const ro = await connect(deps({ mcpReadOnly: true }));
  const roTool = (await ro.client.listTools()).tools.find((t) => t.name === "open_modeler");
  const roUri = (roTool?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri;
  assert.ok(roUri, "read-only server advertises its widget");
  assert.notEqual(roUri, uri, "a changed boot payload mints a new resource uri");
  const roRes = await ro.client.readResource({ uri: roUri! });
  assert.ok((roRes.contents[0] as { text?: string }).text!.includes('\\"readonly\\":true'));
});

test("MCP App: open_decision_modeler serves the DMN widget and takes a scenario", async () => {
  const { client, callJson } = await connect(deps());

  const tool = (await client.listTools()).tools.find((t) => t.name === "open_decision_modeler");
  assert.ok(tool, "open_decision_modeler registered");
  const uri = (tool._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri;
  assert.ok(uri?.startsWith("ui://designiq/decision-modeler-"), `ui resourceUri: ${uri}`);
  assert.equal((tool._meta as { "openai/outputTemplate"?: string })?.["openai/outputTemplate"], uri);
  // its own resource — never the BPMN widget's
  const other = (await client.listTools()).tools.find((t) => t.name === "open_modeler");
  assert.notEqual(uri, (other?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri);

  const doc = (await client.readResource({ uri: uri! })).contents[0] as { text?: string };
  assert.match(doc.text ?? "", /<body>mcp-app-dmn\.html<\/body>/);
  assert.ok(doc.text!.includes('\\"readonly\\":false'), "boot config injected");
  assert.ok(doc.text!.includes('\\"publicUrl\\":\\"http://live.test\\"'), "publicUrl injected");

  // the scenario rides in the tool ARGUMENTS (the widget reads ontoolinput);
  // the result stays a lean summary, never the XML
  const opened = await callJson("open_decision_modeler", {
    repo: REPO.fullName,
    id: "rabatt",
    scenario: { kundentyp: "stamm" },
  });
  assert.equal(opened.opened.path, DMN_PATH);
  // decisions deep-link to the file-editor splat route
  assert.equal(opened.opened.url, "http://live.test/r/acme/models/f/processes/rabatt.dmn");
  assert.deepEqual(opened.summary.decisions, [{ id: "rabatt", hitPolicy: "FIRST", rules: 2 }]);
  assert.ok(!JSON.stringify(opened).includes("<decision"), "no XML in the tool result");
});

test("list_models: every notation of the repo in one grouped listing", async () => {
  const { callJson } = await connect(deps());
  const res = await callJson("list_models", { repo: REPO.fullName });
  assert.deepEqual(Object.keys(res.models).sort(), ["bpmn", "dmn", "wardley"]);
  assert.ok(res.models.bpmn.some((m: { id: string }) => m.id === "order"));
  assert.equal(res.models.dmn[0].notation, "dmn");
});

test("list_repos: favorite and lastOpenedAt are the caller's own data (#213)", async () => {
  const favorites = new SqliteFavoritesStore(new DatabaseSync(":memory:"));
  const d = deps({ favorites });
  await addFavorite({ ...d, favorites }, session("petra"), REPO.fullName);
  await recordVisit({ ...d, favorites }, session("petra"), REPO.fullName);
  const petra = (await (await connect(d, session("petra"))).callJson("list_repos", {})).repos[0];
  assert.equal(petra.favorite, true);
  assert.equal(typeof petra.lastOpenedAt, "string");
  const omar = (await (await connect(d, session("omar"))).callJson("list_repos", {})).repos[0];
  assert.equal(omar.favorite, false, "another login never sees petra's favorite");
  assert.equal(omar.lastOpenedAt, null);
  // an agent listing the repos is not a visit
  const before = petra.lastOpenedAt;
  await (await connect(d, session("petra"))).callJson("list_models", { repo: REPO.fullName });
  const again = (await (await connect(d, session("petra"))).callJson("list_repos", {})).repos[0];
  assert.equal(again.lastOpenedAt, before, "MCP calls leave lastOpenedAt unchanged");
});

test("list_repos: the per-notation model counts ride along with the process/decision counts", async () => {
  const { callJson } = await connect(deps());
  const { repos } = await callJson("list_repos", {});
  assert.equal(repos[0].fullName, REPO.fullName);
  assert.equal(repos[0].processCount, 2, "the existing counts stay for older clients");
  assert.equal(repos[0].decisionCount, 1);
  assert.equal(repos[0].modelCount, 4);
  assert.deepEqual(repos[0].modelCounts, { bpmn: 2, dmn: 1, wardley: 1 });
});

test("get_view: the derived view of ANY live model — wardley incl. baseVersion", async () => {
  const { callJson } = await connect(deps());
  const wardley = await callJson("get_view", { repo: REPO.fullName, id: "strategy" });
  assert.equal(wardley.path, OWM_PATH);
  assert.equal(wardley.notation, "wardley");
  assert.deepEqual(wardley.stats, { components: 2, dependencies: 1 });
  assert.ok(wardley.baseVersion.length > 20, "live content token rides along");

  const process = await callJson("get_view", { repo: REPO.fullName, id: "order" });
  assert.equal(process.notation, "bpmn");
  assert.match(process.summary, /^Process with /);
  assert.ok(process.detail, "the rich DerivedProcess rides in detail");

  // a direct path resolves too, and the payload id comes from the RESOLVED
  // path — a conflicting caller-supplied id must not ride along verbatim
  const byPath = await callJson("get_view", { repo: REPO.fullName, id: "order", path: OWM_PATH });
  assert.equal(byPath.id, "strategy");
  assert.equal(byPath.notation, "wardley");

  const { call } = await connect(deps());
  const unknown = await call("get_view", { repo: REPO.fullName, id: "nope" });
  assert.ok(unknown.isError && /unknown model 'nope'/.test(unknown.text));
});

test("get_view: a Team Topology's detail carries its flow labels and annotation texts — the Live Host has no get_model", async () => {
  const d = deps();
  const box = { position: { x: 0, y: 0 }, size: { width: 9, height: 9 } };
  writeFileSync(
    join(await d.workspaces.ensure(REPO), "processes", "shop.tt"),
    JSON.stringify({
      version: 3,
      title: "Online shop",
      nodes: [{ id: "checkout", type: "stream-aligned", label: "Checkout", ...box }],
      interactions: [],
      flows: [{ id: "flow", label: "Flow of change", ...box }],
      annotations: [{ id: "note", text: "Splits in Q3", attachedTo: "checkout", ...box }],
    }),
  );
  const { callJson } = await connect(d);
  const view = await callJson("get_view", { repo: REPO.fullName, id: "shop" });
  assert.equal(view.name, "Online shop");
  assert.equal(view.summary, "Team Topology with 1 team, 0 interactions, 1 flow, 1 annotation");
  assert.deepEqual(view.detail.flows, [{ id: "flow", label: "Flow of change" }]);
  assert.deepEqual(view.detail.annotations, [{ id: "note", text: "Splits in Q3", attachedTo: "checkout" }]);
});

test("contributions: a capability module's tools register after the core, with deps + session", async () => {
  const d = deps();
  const me = session("carla");
  let received: { deps: unknown; login: string } | undefined;
  const contribute: LiveToolContribution = (server, contribDeps, contribSession) => {
    received = { deps: contribDeps, login: contribSession.user.login };
    server.registerTool(
      "my_capability_tool",
      { description: "contributed", annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text" as const, text: "hi" }] }),
    );
  };
  const { client } = await connect(d, me, [contribute]);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("my_capability_tool"));
  assert.ok(names.includes("list_models"), "core registration untouched");
  // the hook forwards the SAME deps object and the CALLER's session — the
  // contract the decisions quartet will build on
  assert.equal(received?.deps, d);
  assert.equal(received?.login, "carla");
});

test("get→save round-trip incl. the conflict retry loop (stale token never overwrites)", async () => {
  const { callJson } = await connect(deps());
  const procs = await callJson("list_processes", { repo: REPO.fullName });
  assert.equal(procs.processes[0].id, "order");

  const got = await callJson("get_bpmn_xml", { repo: REPO.fullName, id: "order" });
  assert.equal(got.content, VALID);
  assert.equal(got.xml, VALID, "deprecated alias (#154) still on the tool result");

  // stale token → retryable conflict RESULT (not a protocol error)
  const stale = await callJson("save_bpmn_xml", {
    repo: REPO.fullName,
    id: "order",
    xml: VALID_V2,
    baseVersion: "bogus.token",
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(stale.currentContent, VALID);
  assert.equal(stale.currentXml, VALID, "deprecated alias (#154) still on the conflict result");

  // the agent retry: re-derive against currentContent, use the fresh token
  const saved = await callJson("save_bpmn_xml", {
    repo: REPO.fullName,
    id: "order",
    xml: VALID_V2,
    baseVersion: stale.baseVersion,
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.warnings, []);

  const derived = await callJson("get_process", { repo: REPO.fullName, id: "order" });
  assert.equal(derived.name, "Order v2");
  assert.equal(derived.baseVersion, saved.baseVersion);
});

test("decisions: list → get_decision (derived table) → save_dmn_xml round-trip", async () => {
  const { call, callJson } = await connect(deps());

  const list = await callJson("list_decisions", { repo: REPO.fullName });
  assert.deepEqual(
    list.decisions.map((d: { id: string; path: string }) => [d.id, d.path]),
    [["rabatt", DMN_PATH]],
  );

  // the derived view carries the table, not just the node list
  const view = await callJson("get_decision", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(view.path, DMN_PATH);
  // …and the impact side: which processes delegate to this decision
  assert.deepEqual(view.usedBy, [
    { process: "uses-rabatt", path: USER_PATH, element: "Task_rabatt", elementName: "Rabatt ermitteln" },
  ]);
  assert.equal(view.name, "Rabatt");
  assert.equal(view.decisions[0].hitPolicy, "FIRST");
  assert.deepEqual(view.decisions[0].inputs[0], {
    id: "Input_1",
    label: "Kundentyp",
    expression: "kundentyp",
    typeRef: "string",
    inputValues: [],
  });
  assert.deepEqual(
    view.decisions[0].rules.map((r: { id: string; when: string[]; then: string[] }) => [r.id, r.when, r.then]),
    [
      ["Rule_stamm", ['"stamm"'], ["10"]],
      ["Rule_neu", ['"neu"'], ["0"]],
    ],
  );

  // save with the token from the XML read; a stale one conflicts instead of overwriting
  const got = await callJson("get_dmn_xml", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(got.content, DMN);
  const stale = await callJson("save_dmn_xml", {
    repo: REPO.fullName,
    id: "rabatt",
    xml: DMN.replace('name="Rabatt"', 'name="Rabatt v2"'),
    baseVersion: "bogus.token",
  });
  assert.equal(stale.conflict, true);
  const saved = await callJson("save_dmn_xml", {
    repo: REPO.fullName,
    id: "rabatt",
    xml: DMN.replace('name="Rabatt"', 'name="Rabatt v2"'),
    baseVersion: stale.baseVersion,
  });
  assert.equal(saved.ok, true);
  assert.equal((await callJson("get_decision", { repo: REPO.fullName, id: "rabatt" })).name, "Rabatt v2");

  // an unknown id names the tool that lists the real ones
  const unknown = await call("get_decision", { repo: REPO.fullName, id: "nope" });
  assert.ok(unknown.isError);
  assert.match(unknown.text, /decision 'nope' not found .*use list_decisions/);

  // a BPMN path through the decision tools is a clear error, not a crash
  const wrong = await call("get_decision", { repo: REPO.fullName, path: PATH });
  assert.ok(wrong.isError);
  assert.match(wrong.text, /not a DMN model/);
});

test("simulate_decision + analyze_decision: live model, and a dry run on unsaved XML", async () => {
  const { call, callJson } = await connect(deps());

  const hit = await callJson("simulate_decision", {
    repo: REPO.fullName,
    id: "rabatt",
    given: { kundentyp: "stamm" },
  });
  assert.equal(hit.path, DMN_PATH);
  assert.deepEqual(hit.decisions[0].reportedRules, ["Rule_stamm"]);
  assert.equal(hit.decisions[0].value, 10);

  // a typo comes back as a named problem, not as "nothing matched"
  const typo = await callJson("simulate_decision", {
    repo: REPO.fullName,
    id: "rabatt",
    given: { Kundentyp: "stamm" },
  });
  assert.deepEqual(typo.unknownInputs, ["Kundentyp"]);
  assert.deepEqual(typo.missingInputs, ["kundentyp"]);

  // the live model is sound; its variable profile carries the test material
  const analysis = await callJson("analyze_decision", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(analysis.ok, true);
  assert.deepEqual(analysis.findings, []);
  assert.deepEqual(analysis.variables[0], {
    name: "kundentyp",
    typeRef: "string",
    source: "free",
    literals: ["stamm", "neu"],
    boundaries: [],
  });

  // dry run: broken FEEL in an UNSAVED edit, without touching the repo at all
  const dry = await callJson("analyze_decision", { xml: DMN.replace("<text>10</text>", "<text>10 +</text>") });
  assert.equal(dry.ok, false);
  assert.equal(dry.findings[0].code, "feel-syntax");
  assert.equal(dry.findings[0].rule, "Rule_stamm");

  // …and the stored model is untouched by it
  assert.equal((await callJson("get_dmn_xml", { repo: REPO.fullName, id: "rabatt" })).xml, DMN);

  // neither repo nor xml → an actionable message
  const nothing = await call("analyze_decision", {});
  assert.ok(nothing.isError);
  assert.match(nothing.text, /provide `repo`.*or an explicit `xml`/);
});

test("decision tests: none → first save creates the sidecar → run → golden master → conflict guard", async () => {
  const { call, callJson } = await connect(deps());

  // a decision without a suite: empty, passing, and every rule uncovered
  const before = await callJson("get_decision_tests", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(before.exists, false);
  assert.equal(before.path, "processes/rabatt.tests.yaml");
  const empty = await callJson("run_decision_tests", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.cases, []);
  assert.deepEqual(empty.uncoveredRules, ["rabatt/Rule_stamm", "rabatt/Rule_neu"]);

  // trial run: cases passed inline are never stored
  const trial = await callJson("run_decision_tests", {
    repo: REPO.fullName,
    id: "rabatt",
    cases: [{ name: "Stammkunde", given: { kundentyp: "stamm" }, expect: { value: 10 } }],
  });
  assert.equal(trial.passed, 1);
  assert.equal(trial.testsPath, null);
  assert.equal((await callJson("get_decision_tests", { repo: REPO.fullName, id: "rabatt" })).exists, false);

  // first save: no baseVersion needed, the file is created next to the model
  const created = await callJson("save_decision_tests", {
    repo: REPO.fullName,
    id: "rabatt",
    cases: [
      { name: "Stammkunde", given: { kundentyp: "stamm" }, expect: { value: 10, rules: ["Rule_stamm"] } },
      { name: "Neukunde", given: { kundentyp: "neu" } }, // no expect → golden master
    ],
    record: true,
  });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.path, "processes/rabatt.tests.yaml");
  assert.equal(created.outcome.passed, 2, "record:true froze the pending case, so both pass");

  // the stored suite is real YAML with the recorded expectation in it
  const stored = await callJson("get_decision_tests", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(stored.exists, true);
  assert.match(stored.raw, /name: Neukunde/);
  assert.deepEqual(stored.suite.cases[1].expect, { value: 0, rules: ["Rule_neu"] });

  // running the stored suite now reports full coverage
  const run = await callJson("run_decision_tests", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(run.passed, 2);
  assert.deepEqual(run.uncoveredRules, []);
  assert.equal(run.testsPath, "processes/rabatt.tests.yaml");

  // a second save without baseVersion is refused, a stale one conflicts
  const noToken = await call("save_decision_tests", { repo: REPO.fullName, id: "rabatt", cases: [] });
  assert.ok(noToken.isError);
  assert.match(noToken.text, /already exists — read it first/);
  const stale = await callJson("save_decision_tests", {
    repo: REPO.fullName,
    id: "rabatt",
    cases: [],
    baseVersion: "bogus.token",
  });
  assert.equal(stale.conflict, true);

  // …and the model itself is now covered by a failing case if we break it
  const broken = await callJson("run_decision_tests", {
    repo: REPO.fullName,
    id: "rabatt",
    xml: DMN.replace("<text>10</text>", "<text>20</text>"),
  });
  assert.equal(broken.failed, 1);
  assert.match(broken.cases[0].failures[0], /expected 10, got 20/);
});

test("save_decision_tests keeps the suite's own `decision:` key — callers only send cases", async () => {
  const d = deps();
  const { callJson } = await connect(d);
  const ws = await d.workspaces.ensure(REPO);
  // a hand-authored sidecar that PINS which decision the top-level
  // expectations are about — in a chained DRD that is not the leaf
  // mainDecisionOf() would fall back to
  writeFileSync(
    join(ws, "processes/rabatt.tests.yaml"),
    "decision: rabatt\ncases:\n  - name: Stammkunde\n    given: { kundentyp: stamm }\n    expect: { value: 10 }\n",
  );
  const before = await callJson("get_decision_tests", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(before.suite.decision, "rabatt");

  // the tool has no field for it, so the write must carry it over itself
  const saved = await callJson("save_decision_tests", {
    repo: REPO.fullName,
    id: "rabatt",
    cases: [...before.suite.cases, { name: "Neukunde", given: { kundentyp: "neu" } }],
    baseVersion: before.baseVersion,
    record: true,
  });
  assert.equal(saved.ok, true);

  const after = await callJson("get_decision_tests", { repo: REPO.fullName, id: "rabatt" });
  assert.equal(after.suite.decision, "rabatt");
  assert.match(after.raw, /^decision: rabatt$/m);
  assert.equal(after.suite.cases.length, 2);
});

test("agent presence: reads announce the caller's agent in the room, a save adds the elements it changed", async () => {
  const touches: Array<{ room: string; login: string; name: string; selection?: string[] }> = [];
  const d = deps({
    presence: {
      touch: (room, principal, canvas) => {
        const c = canvas?.();
        touches.push({ room, ...principal, ...(c ? { selection: c.selection } : {}) });
      },
    },
  });
  const { callJson } = await connect(d, session("petra"));
  const room = `${REPO.fullName}/${PATH}`;

  const got = await callJson("get_bpmn_xml", { repo: REPO.fullName, id: "order" });
  assert.deepEqual(touches, [{ room, login: "petra", name: "petra" }], "a read: presence, no selection");

  // rename the start event only — the diff must single it out
  const edited = VALID.replace('name="Process started"', 'name="Order received"');
  const saved = await callJson("save_bpmn_xml", {
    repo: REPO.fullName,
    id: "order",
    xml: edited,
    baseVersion: got.baseVersion,
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(touches.at(-1), { room, login: "petra", name: "petra", selection: ["StartEvent_1"] });

  // the non-BPMN notations ride the same seam (the wardley extractor)
  const owm = await callJson("get_model_content", { repo: REPO.fullName, path: OWM_PATH });
  await callJson("save_model_content", {
    repo: REPO.fullName,
    path: OWM_PATH,
    content: OWM.replace("Checkout [0.8, 0.6]", "Checkout [0.9, 0.6]"),
    baseVersion: owm.baseVersion,
  });
  assert.equal(touches.at(-1)!.room, `${REPO.fullName}/${OWM_PATH}`);
  assert.deepEqual(touches.at(-1)!.selection, ["cmp_checkout"], "the id the canvas outlines");

  // list/validate tools touch no room
  const before = touches.length;
  await callJson("list_processes", { repo: REPO.fullName });
  await callJson("validate_bpmn", { xml: VALID });
  assert.equal(touches.length, before);
});

test("get_presence: who is in the room — `you` is the caller's own human presence, agents ride along", async () => {
  const room = `${REPO.fullName}/${PATH}`;
  const d = deps({
    peersOf: (r) =>
      r !== room
        ? []
        : [
            {
              clientId: 1,
              login: "petra",
              state: {
                user: { name: "Petra", color: "#fa8100" },
                canvas: { cursor: { x: 240, y: 180 }, selection: ["StartEvent_1"] },
              },
            },
            {
              clientId: 2,
              login: "kai",
              state: { user: { name: "Kai", color: "#0aa2c0", kind: "human" }, canvas: null },
            },
            {
              clientId: 3,
              state: {
                user: { name: "AI · Kai", color: "#7c4dff", kind: "agent" },
                canvas: { cursor: null, selection: ["EndEvent_1"] },
              },
            },
            { clientId: 4, login: "mia", state: { selection: { anchor: 3 } } }, // y-monaco only — not announced yet
          ],
  });
  const { callJson } = await connect(d, session("petra"));
  const out = await callJson("get_presence", { repo: REPO.fullName, id: "order" });
  assert.equal(out.path, PATH);
  assert.deepEqual(out.peers, [
    { name: "Petra", kind: "human", you: true, selection: ["StartEvent_1"], cursor: { x: 240, y: 180 } },
    { name: "Kai", kind: "human", you: false, selection: [], cursor: null },
    { name: "AI · Kai", kind: "agent", you: false, selection: ["EndEvent_1"], cursor: null },
  ]);
  // a room nobody has open — and a deps without the port at all — answer empty
  const other = await callJson("get_presence", { repo: REPO.fullName, path: OWM_PATH });
  assert.deepEqual(other.peers, []);
  const dark = await connect(deps());
  assert.deepEqual((await dark.callJson("get_presence", { repo: REPO.fullName, id: "order" })).peers, []);
});

test("mint_ws_ticket → ws onAuthenticate: the full live-connection handshake, room-bound", async () => {
  const wsTickets = new WsTicketStore();
  const d = deps({ wsTickets });
  const { callJson } = await connect(d);

  const minted = await callJson("mint_ws_ticket", { repo: REPO.fullName, id: "order" });
  assert.equal(minted.url, "ws://live.test");
  assert.equal(minted.room, `${REPO.fullName}/${PATH}`);
  assert.equal(minted.expiresInSeconds, 60);
  // the presence the widget announces: the human, as the web app shows them
  assert.deepEqual(minted.user, { name: "petra", color: presenceColor("petra") });

  // the ticket passes the REAL ws gate — makeCollabHooks with the same store
  const hooks = makeCollabHooks({
    lineage: { load: () => undefined, save: () => {}, drop: () => {} } as never,
    docGuard: new DocSizeGuard(8_000_000),
    maxDocBytes: 8_000_000,
    sessions: { get: () => undefined },
    access: { canWrite: async () => true },
    registry: d.registry,
    workspaces: d.workspaces,
    contentConfig: loadContentConfig,
    liveDocs: new Set(),
    wsTickets,
  });
  const auth = await hooks.onAuthenticate({ token: minted.ticket, documentName: minted.room });
  assert.equal(auth.user.login, "petra");
  // single-use: replaying the same ticket is refused
  await assert.rejects(() => hooks.onAuthenticate({ token: minted.ticket, documentName: minted.room }), /invalid/);

  // a ticket never opens a DIFFERENT room
  const second = await callJson("mint_ws_ticket", { repo: REPO.fullName, id: "order" });
  await assert.rejects(
    () => hooks.onAuthenticate({ token: second.ticket, documentName: `${REPO.fullName}/processes/other.bpmn` }),
    /invalid|no such|unknown/,
  );

  // read-only mode: the ticket tool is absent — the viewer stays on bridge reads
  const ro = await connect(deps({ mcpReadOnly: true }));
  const roTools = (await ro.client.listTools()).tools.map((t) => t.name);
  assert.ok(!roTools.includes("mint_ws_ticket"));
});

test("save_bpmn_xml lint:'warn' (widget autosave) saves despite validation errors and reports them", async () => {
  const { callJson } = await connect(deps());
  const got = await callJson("get_bpmn_xml", { repo: REPO.fullName, id: "order" });

  // strict default still refuses (the agent contract is untouched) …
  const { call } = await connect(deps());
  const strict = await call("save_bpmn_xml", {
    repo: REPO.fullName,
    id: "order",
    xml: "<not-bpmn/>",
    baseVersion: got.baseVersion,
  });
  assert.ok(strict.isError && /validation failed/.test(strict.text));

  // … while lint:"warn" saves and reports
  const warned = await callJson("save_bpmn_xml", {
    repo: REPO.fullName,
    id: "order",
    xml: "<not-bpmn/>",
    baseVersion: got.baseVersion,
    lint: "warn",
  });
  assert.equal(warned.ok, true);
  assert.ok(warned.errors.length > 0);
});

test("validate_bpmn dry-runs the platform validator without writing", async () => {
  const { callJson } = await connect(deps());
  const bad = await callJson("validate_bpmn", { xml: "<not-bpmn/>" });
  assert.equal(bad.ok, false);
  assert.ok(bad.findings.some((f: { severity: string }) => f.severity === "ERROR"));
  const good = await callJson("validate_bpmn", { xml: VALID, repo: REPO.fullName, path: PATH });
  assert.equal(good.ok, true);
  // dry-run: the live content is untouched
  const got = await callJson("get_bpmn_xml", { repo: REPO.fullName, id: "order" });
  assert.equal(got.content, VALID);
  assert.equal(got.xml, VALID, "deprecated alias (#154) still on the tool result");
});

test("per-call authz: a session without write access is denied on every repo tool", async () => {
  const { call } = await connect(deps({ access: { canWrite: async () => false } }));
  const denied = await call("list_processes", { repo: REPO.fullName });
  assert.ok(denied.isError);
  assert.match(denied.text, /no write access to acme\/models/);
  const unknown = await call("get_bpmn_xml", { repo: "stranger/repo", id: "x" });
  assert.ok(unknown.isError);
  assert.match(unknown.text, /not a connected repository/);
});

test("release_process demands a target; save demands baseVersion by schema", async () => {
  const { call, client } = await connect(deps());
  const none = await call("release_process", { repo: REPO.fullName });
  assert.ok(none.isError);
  assert.match(none.text, /provide either/);
  // baseVersion is REQUIRED in the schema — the SDK rejects the call before the handler
  const r = await client.callTool({
    name: "save_bpmn_xml",
    arguments: { repo: REPO.fullName, id: "order", xml: VALID },
  });
  assert.ok(r.isError);
});

// ── (b) transport behaviour over real HTTP ──────────────────────────────────

function apiOpts(d: McpDeps, sessions = new SessionStore(new DatabaseSync(":memory:"))): ApiOptions {
  return {
    webDist: mkdtempSync(join(tmpdir(), "designiq-webdist-")),
    publicUrl: "http://live.test",
    github: d.github,
    sessions,
    registry: d.registry as ApiOptions["registry"],
    workspaces: d.workspaces as ApiOptions["workspaces"],
    access: d.access as ApiOptions["access"],
    liveDocs: () => [],
    dropLineage: () => {},
    renameLineage: () => {},
    saveLineage: () => {},
    rooms: { retire: () => undefined, hold: () => () => {} },
    openDoc: d.openDoc,
    maxDocBytes: d.maxDocBytes,
    oidc: {
      issuer: "https://idp.example",
      verify: async () => ({ login: "petra", name: "Petra", sub: "sub-1" }),
    },
  };
}

test("/mcp over HTTP: stateless JSON, 405 on GET, 401 + RFC-9728 challenge, -32700 on garbage", async () => {
  const sessions = new SessionStore(new DatabaseSync(":memory:"));
  const bot = sessions.create({ login: "petra", name: "Petra", avatarUrl: null, provider: "github" });
  const httpServer = startApi(0, apiOpts(deps(), sessions));
  cleanups.push(() => new Promise((r) => httpServer.close(r)));
  await new Promise<void>((r) => httpServer.once("listening", r));
  const addr = httpServer.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${bot.id}`,
  };

  // initialize → immediate JSON response (enableJsonResponse, no SSE session)
  const init = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
  assert.equal(init.status, 200);
  assert.match(init.headers.get("content-type") ?? "", /application\/json/);
  const body = (await init.json()) as {
    result: { serverInfo: { name: string; title?: string }; instructions?: string };
  };
  assert.equal(body.result.serverInfo.name, "designiq-live");
  // the title and the instructions travel in the initialize result over HTTP too
  assert.equal(body.result.serverInfo.title, "designIQ Live Host");
  assert.match(body.result.instructions ?? "", /^designIQ is /);

  const get = await fetch(`${base}/mcp`, { headers });
  assert.equal(get.status, 405);

  const anon = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" } });
  assert.equal(anon.status, 401);
  // RFC 9728 §3.3: the /mcp 401 points at the /mcp-specific PRM (path included),
  // not the root document — a resource-exact client (claude.ai) needs that.
  assert.match(
    anon.headers.get("www-authenticate") ?? "",
    /resource_metadata="http:\/\/live\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  // …and a browser client may actually READ that challenge: www-authenticate is
  // not CORS-safelisted, so without this header the pointer is invisible to it
  assert.match(anon.headers.get("access-control-expose-headers") ?? "", /www-authenticate/i);

  // that PRM exists and echoes the /mcp resource identifier verbatim
  const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(prm.status, 200);
  assert.equal(prm.headers.get("access-control-allow-origin"), "*");
  const prmDoc = (await prm.json()) as { resource: string; authorization_servers: string[] };
  assert.equal(prmDoc.resource, "http://live.test/mcp");
  assert.deepEqual(prmDoc.authorization_servers, ["https://idp.example"]);

  // browser MCP clients preflight /mcp (custom mcp-protocol-version header) — a
  // 204 with permissive origin but no credentials keeps cookies same-origin only
  const preflight = await fetch(`${base}/mcp`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /mcp-protocol-version/);

  const garbage = await fetch(`${base}/mcp`, { method: "POST", headers, body: "{not json" });
  assert.equal(garbage.status, 400);
  const err = (await garbage.json()) as { error: { code: number } };
  assert.equal(err.error.code, -32700);
});

// ── #155: the generic model tools — ONE set for every notation in the registry ─

test("generic model tools: get/save ANY notation with CAS, validate_model, create_model, registry-wide ids", async () => {
  const { call, callJson } = await connect(deps());

  // read: the live text of a wardley map — `content`, born without the `xml` alias
  const got = await callJson("get_model_content", { repo: REPO.fullName, id: "strategy" });
  assert.equal(got.path, OWM_PATH);
  assert.equal(got.content, OWM);
  assert.ok(!("xml" in got), "the generic tool never carried the deprecated alias");

  // save: a stale token conflicts with currentContent (and only that key) — the retry lands
  const OWM_V2 = `${OWM}component Billing [0.5, 0.2]\n`;
  const stale = await callJson("save_model_content", {
    repo: REPO.fullName,
    id: "strategy",
    content: OWM_V2,
    baseVersion: "bogus.token",
  });
  assert.equal(stale.conflict, true);
  assert.equal(stale.currentContent, OWM);
  assert.ok(!("currentXml" in stale), "no legacy alias on the generic conflict");
  const saved = await callJson("save_model_content", {
    repo: REPO.fullName,
    id: "strategy",
    content: OWM_V2,
    baseVersion: stale.baseVersion,
  });
  assert.equal(saved.ok, true);
  assert.equal((await callJson("get_model_content", { repo: REPO.fullName, path: OWM_PATH })).content, OWM_V2);

  // create: a template-capable notation becomes a live model; git-only and unknown notations answer errors
  const created = await callJson("create_model", {
    repo: REPO.fullName,
    notation: "event-storming",
    name: "Order Storm",
  });
  assert.equal(created.model.path, "processes/order-storm.storm");
  assert.equal(created.model.notation, "event-storming");
  const storm = await callJson("get_model_content", { repo: REPO.fullName, id: "order-storm" });
  assert.equal(storm.content, "title Order Storm\n");
  const stormSaved = await callJson("save_model_content", {
    repo: REPO.fullName,
    path: created.model.path,
    content: "title Order Storm v2\n",
    baseVersion: storm.baseVersion,
  });
  assert.equal(stormSaved.ok, true);
  const gitOnly = await call("create_model", { repo: REPO.fullName, notation: "value-chain", name: "Chain" });
  assert.ok(gitOnly.isError && /arrive via git/.test(gitOnly.text), gitOnly.text);
  const bogus = await call("create_model", { repo: REPO.fullName, notation: "nope", name: "X" });
  assert.ok(bogus.isError && /unknown notation/.test(bogus.text), bogus.text);

  // a stem shared across notations: bpmn wins, `notation` picks the other; an unknown id names list_models
  const tt = await callJson("create_model", { repo: REPO.fullName, notation: "team-topology", name: "Order" });
  assert.equal(tt.model.path, "processes/order.tt");
  assert.equal((await callJson("get_model_content", { repo: REPO.fullName, id: "order" })).path, PATH);
  assert.equal(
    (await callJson("get_model_content", { repo: REPO.fullName, id: "order", notation: "team-topology" })).path,
    tt.model.path,
  );
  const missing = await call("get_model_content", { repo: REPO.fullName, id: "nope" });
  assert.ok(missing.isError && /unknown model 'nope'.*list_models/.test(missing.text), missing.text);

  // the save gate IS checkModel: a broken .tt is refused like `pnpm validate` errors it; lint:"warn" reports
  const ttGot = await callJson("get_model_content", { repo: REPO.fullName, path: tt.model.path });
  const refused = await call("save_model_content", {
    repo: REPO.fullName,
    path: tt.model.path,
    content: "{ broken",
    baseVersion: ttGot.baseVersion,
  });
  assert.ok(refused.isError && /validation failed/.test(refused.text), refused.text);
  const warned = await callJson("save_model_content", {
    repo: REPO.fullName,
    path: tt.model.path,
    content: "{ broken",
    baseVersion: ttGot.baseVersion,
    lint: "warn",
  });
  assert.equal(warned.ok, true);
  assert.ok(warned.errors.length > 0);
  // …and so is a .tt the canvas cannot open: the schema model's refusal, at the offending value's path
  const team = (id: string) => ({
    id,
    type: "platform",
    label: id,
    position: { x: 0, y: 0 },
    size: { width: 9, height: 9 },
  });
  const duplicate = JSON.stringify({
    version: 3,
    title: "Order",
    nodes: [team("a"), team("a")],
    interactions: [],
    flows: [],
  });
  const ttNow = await callJson("get_model_content", { repo: REPO.fullName, path: tt.model.path });
  const schemaRefused = await call("save_model_content", {
    repo: REPO.fullName,
    path: tt.model.path,
    content: duplicate,
    baseVersion: ttNow.baseVersion,
  });
  assert.ok(
    schemaRefused.isError && /validation failed:\n- nodes\.1\.id: duplicate id "a"/.test(schemaRefused.text),
    schemaRefused.text,
  );

  // validate_model: notation by extension, by explicit id, the repo link check, and the no-notation error
  const bad = await callJson("validate_model", { content: "{ broken", path: "processes/teams.tt" });
  assert.equal(bad.ok, false);
  assert.ok(bad.findings.some((f: { severity: string }) => f.severity === "ERROR"));
  const good = await callJson("validate_model", { content: OWM, notation: "wardley" });
  assert.equal(good.ok, true);
  const schema = await callJson("validate_model", { content: duplicate, path: "processes/teams.tt" });
  assert.equal(schema.ok, false);
  assert.deepEqual(
    schema.findings.map((f: { severity: string; ruleId: string }) => [f.severity, f.ruleId]),
    [["ERROR", "team-topology/schema"]],
  );
  // a context map's strategic-DDD rules are advice: the map opens, so the check stays ok
  const advisory = await callJson("validate_model", {
    content: JSON.stringify({ relationships: [{ id: "r", from: "a", to: "b", pattern: "partnership" }] }),
    notation: "context-map",
  });
  assert.equal(advisory.ok, true);
  assert.ok(
    advisory.findings.every(
      (f: { severity: string; ruleId: string }) => f.severity === "WARN" && f.ruleId === "context-map/semantics",
    ),
    JSON.stringify(advisory.findings),
  );
  const dangling = await callJson("validate_model", {
    repo: REPO.fullName,
    content: USER_BPMN.replace('calledDecision="rabatt"', 'calledDecision="nope"'),
    path: USER_PATH,
  });
  assert.ok(
    dangling.findings.some((f: { message: string }) => /'nope'/.test(f.message)),
    JSON.stringify(dangling.findings),
  );
  const unknown = await call("validate_model", { content: "x", path: "notes.txt" });
  assert.ok(unknown.isError && /pass `notation`/.test(unknown.text), unknown.text);
  // a mistyped notation id is an error too, not an ok that skips the check the save would run
  const mistyped = await call("validate_model", {
    content: duplicate,
    path: "processes/teams.tt",
    notation: "team-topologies",
  });
  assert.ok(mistyped.isError && /'team-topologies' is no registered notation/.test(mistyped.text), mistyped.text);

  // the widget's live ticket mints for any notation's room
  const ticket = await callJson("mint_ws_ticket", { repo: REPO.fullName, path: OWM_PATH });
  assert.match(ticket.room, /strategy\.owm$/);
});

test("generic model tools: a diagram is a mermaid fence in a document, its WARN never refuses a save", async () => {
  const { call, callJson } = await connect(deps());
  // no notation of its own (withdrawn in 5.5): the generic unknown-notation error
  const mermaid = await call("create_model", { repo: REPO.fullName, notation: "mermaid", name: "Order Flow" });
  assert.ok(mermaid.isError && /unknown notation 'mermaid'/.test(mermaid.text), mermaid.text);

  const created = await callJson("create_model", { repo: REPO.fullName, notation: "markdown", name: "Order Flow" });
  assert.equal(created.model.path, "processes/order-flow.md");
  const got = await callJson("get_model_content", { repo: REPO.fullName, id: "order-flow" });

  // validate_model: every fence names its type first, the line is the document's
  const DOC = "# Order Flow\n\n```mermaid\nflowchart LR\n  A --> B\n```\n";
  const valid = await callJson("validate_model", { content: DOC, path: created.model.path });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.findings, []);
  const TYPO = DOC.replace("flowchart", "flowchrt");
  const typo = await callJson("validate_model", { content: TYPO, notation: "markdown" });
  assert.equal(typo.ok, true, "a WARN, never a failed check");
  assert.equal(typo.findings[0]?.severity, "WARN");
  assert.equal(typo.findings[0]?.ruleId, "mermaid/diagram-type");
  assert.match(typo.findings[0]?.message ?? "", /^line 4: 'flowchrt' is not a Mermaid diagram type/);

  // the save gate warns on it, it does not refuse the document
  const saved = await callJson("save_model_content", {
    repo: REPO.fullName,
    path: created.model.path,
    content: TYPO,
    baseVersion: got.baseVersion,
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.warnings, [typo.findings[0]?.message]);
  assert.equal((await callJson("get_model_content", { repo: REPO.fullName, path: created.model.path })).content, TYPO);
});

// ── #156: the widget registry — one row per single-file bundle ───────────────

const uiMeta = (tool: { _meta?: unknown } | undefined) =>
  (tool?._meta as { ui?: { resourceUri?: string; visibility?: string[] } } | undefined)?.ui;

test("widgets: a bundle missing from the web dist drops exactly its tool; the ticket follows the served set", async () => {
  const names = async (d: McpDeps) => (await (await connect(d)).client.listTools()).tools.map((t) => t.name);
  // every bundle present: one open tool per registry row (a drift guard)
  const all = await names(deps());
  assert.equal(all.filter((n) => n.startsWith("open_")).length, WIDGET_FILES.length);

  // one bundle missing → exactly its tool is gone
  const noWardley = await names(
    deps(
      {},
      WIDGET_FILES.filter((f) => f !== "mcp-app-wardley.html"),
    ),
  );
  assert.ok(!noWardley.includes("open_wardley_modeler"));
  for (const t of [
    "open_modeler",
    "open_decision_modeler",
    "open_team_topology_modeler",
    "open_event_storming_modeler",
    "open_context_map_modeler",
    "mint_ws_ticket",
  ]) {
    assert.ok(noWardley.includes(t), `${t} still registered`);
  }

  // no bundle at all → no open tool and no ticket; everything else is there
  const none = await names(deps({}, []));
  assert.equal(none.filter((n) => n.startsWith("open_")).length, 0);
  assert.ok(!none.includes("mint_ws_ticket"));
  assert.ok(none.includes("get_model_content"));

  // only the DMN bundle → its tool but NO ticket (the decision widget never mints)
  const dmnOnly = await names(deps({}, ["mcp-app-dmn.html"]));
  assert.ok(dmnOnly.includes("open_decision_modeler"));
  assert.ok(!dmnOnly.includes("mint_ws_ticket"));

  // only a non-bpmn bundle → its tool AND the ticket, bound to THAT widget
  const only = (await (await connect(deps({}, ["mcp-app-wardley.html"]))).client.listTools()).tools;
  const wardley = only.find((t) => t.name === "open_wardley_modeler");
  const ticket = only.find((t) => t.name === "mint_ws_ticket");
  assert.ok(wardley && ticket, "wardley widget + ticket");
  assert.ok(!only.some((t) => t.name === "open_modeler"));
  assert.deepEqual(uiMeta(ticket), { resourceUri: uiMeta(wardley)?.resourceUri, visibility: ["app"] });

  // with every bundle the ticket binds to the bpmn widget — today's binding
  const full = (await (await connect(deps())).client.listTools()).tools;
  assert.equal(
    uiMeta(full.find((t) => t.name === "mint_ws_ticket"))?.resourceUri,
    uiMeta(full.find((t) => t.name === "open_modeler"))?.resourceUri,
  );
});

test("widgets: the generated open_<notation>_modeler tools serve their own bundle and open the file route", async () => {
  const { client, callJson } = await connect(deps());
  // fixtures for the two notations the workspace lacks — the create scaffolds
  await callJson("create_model", { repo: REPO.fullName, notation: "team-topology", name: "Teams" });
  await callJson("create_model", { repo: REPO.fullName, notation: "event-storming", name: "Order Storm" });
  await callJson("create_model", { repo: REPO.fullName, notation: "context-map", name: "Conference" });
  const cases = [
    { tool: "open_wardley_modeler", notation: "wardley", id: "strategy", path: OWM_PATH, text: "component Platform" },
    {
      tool: "open_team_topology_modeler",
      notation: "team-topology",
      id: "teams",
      path: "processes/teams.tt",
      text: "version", // quote-free, and never a key of the derived stats (flows is one)
    },
    {
      tool: "open_event_storming_modeler",
      notation: "event-storming",
      id: "order-storm",
      path: "processes/order-storm.storm",
      text: "title Order Storm",
    },
    {
      tool: "open_context_map_modeler",
      notation: "context-map",
      id: "conference",
      path: "processes/conference.cm.json",
      text: "version", // quote-free, and never a key of the derived stats
    },
  ];
  const tools = (await client.listTools()).tools;
  const uris = new Set<string>();
  for (const c of cases) {
    const tool = tools.find((t) => t.name === c.tool);
    assert.ok(tool, `${c.tool} registered`);
    const meta = tool._meta as { "ui/resourceUri"?: string; "openai/outputTemplate"?: string };
    const uri = uiMeta(tool)?.resourceUri;
    assert.ok(uri?.startsWith(`ui://designiq/${c.notation}-modeler-`), `${c.tool} uri: ${uri}`);
    assert.equal(meta["ui/resourceUri"], uri);
    assert.equal(meta["openai/outputTemplate"], uri);
    uris.add(uri!);
    // its own bundle, boot marker replaced, viewer flag + deep-link base injected
    const doc = (await client.readResource({ uri: uri! })).contents[0] as { mimeType?: string; text?: string };
    assert.equal(doc.mimeType, "text/html;profile=mcp-app");
    assert.ok(!doc.text!.includes("__DESIGNIQ_BOOT__"), "marker replaced");
    assert.ok(doc.text!.includes('\\"readonly\\":false'), "boot config injected");
    assert.ok(doc.text!.includes('\\"publicUrl\\":\\"http://live.test\\"'), "publicUrl injected");
    assert.match(doc.text!, new RegExp(`<body>mcp-app-${c.notation}\\.html</body>`));
    // the lean result: the file route + the derived summary, never the text
    const opened = await callJson(c.tool, { repo: REPO.fullName, id: c.id });
    assert.equal(opened.opened.path, c.path);
    assert.equal(opened.opened.url, `http://live.test/r/acme/models/f/${c.path}`);
    assert.equal(typeof opened.summary.summary, "string");
    assert.equal(typeof opened.summary.stats, "object");
    assert.ok(!JSON.stringify(opened).includes(c.text), "no model text in the tool result");
  }
  // one widget per registry row, one distinct resource each
  for (const t of ["open_modeler", "open_decision_modeler"])
    uris.add(uiMeta(tools.find((x) => x.name === t))!.resourceUri!);
  assert.equal(uris.size, WIDGET_FILES.length);

  // read-only mints a different uri whose bundle flags the viewer
  const ro = await connect(deps({ mcpReadOnly: true }));
  const roUri = uiMeta((await ro.client.listTools()).tools.find((t) => t.name === "open_wardley_modeler"))?.resourceUri;
  assert.ok(roUri && !uris.has(roUri), "a changed boot payload mints a new resource uri");
  const roDoc = (await ro.client.readResource({ uri: roUri })).contents[0] as { text?: string };
  assert.ok(roDoc.text!.includes('\\"readonly\\":true'));
});

test("widgets: a generated open tool forces its notation — shared stems, foreign paths, unknown ids", async () => {
  const { call, callJson } = await connect(deps());
  // processes/order.tt beside processes/order.bpmn — the same stem twice
  await callJson("create_model", { repo: REPO.fullName, notation: "team-topology", name: "Order" });
  const tt = await callJson("open_team_topology_modeler", { repo: REPO.fullName, id: "order" });
  assert.equal(tt.opened.path, "processes/order.tt", "the tool's notation wins over bpmn-first");
  const bpmn = await callJson("open_modeler", { repo: REPO.fullName, id: "order" });
  assert.equal(bpmn.opened.path, PATH);
  // a path of another notation fails in the tool, never inside the iframe
  const foreign = await call("open_wardley_modeler", { repo: REPO.fullName, path: PATH });
  assert.ok(foreign.isError && /not a Wardley Map/.test(foreign.text), foreign.text);
  const unknown = await call("open_wardley_modeler", { repo: REPO.fullName, id: "nope" });
  assert.ok(unknown.isError && /list_models/.test(unknown.text), unknown.text);
});

test("todo types over REST: the same types, the same typed 400, the same filed todo as create_todo", async () => {
  const issues = fakeIssues({ types: [BUG_TYPE], blankAllowed: false });
  const d = deps({ issues });
  const sessions = new SessionStore(new DatabaseSync(":memory:"));
  const bot = sessions.create({ login: "petra", name: "Petra", avatarUrl: null, provider: "github" });
  const httpServer = startApi(0, { ...apiOpts(d, sessions), issues });
  cleanups.push(() => new Promise((r) => httpServer.close(r)));
  await new Promise<void>((r) => httpServer.once("listening", r));
  const base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}/api/repos/${REPO.fullName}`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${bot.id}` };

  const types = await fetch(`${base}/todo-types`, { headers });
  assert.equal(types.status, 200);
  assert.deepEqual(await types.json(), [BUG_TYPE]);

  const post = (body: unknown) => fetch(`${base}/todos`, { method: "POST", headers, body: JSON.stringify(body) });
  const anchor = { notation: "bpmn", model: "order", file: PATH };
  const incomplete = await post({ title: "Saving fails", type: "bug", fields: {}, anchor });
  assert.equal(incomplete.status, 400);
  assert.deepEqual(await incomplete.json(), {
    error: "The Bug report form is not complete:\n- Steps to reproduce (repro) is required",
    code: "todos/fields-required",
  });

  const created = await post({ title: "Saving fails", type: "bug", fields: { repro: "Click save" }, anchor });
  assert.equal(created.status, 201);
  const { callJson } = await connect(d);
  await callJson("create_todo", {
    repo: REPO.fullName,
    path: PATH,
    title: "Saving fails",
    type: "bug",
    fields: { repro: "Click save" },
  });
  assert.equal(issues.created.length, 2);
  assert.deepEqual(issues.created[0], issues.created[1], "the web dialog and the agent file the same todo");
});
