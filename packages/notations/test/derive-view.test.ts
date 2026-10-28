/**
 * deriveView — the generic derive dispatch (epic #118 step 3). The common
 * core (name/summary/stats) is pinned per notation; the rich views ride in
 * `detail` UNCHANGED (deriveProcess/deriveDecision equality), so consumers of
 * the typed fields lose nothing by going through the dispatch.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { deriveDecision, deriveProcess, deriveView } from "../derive.ts";
import { extractModelGraph, type ModelGraph } from "../extract.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <collaboration id="C"><participant id="Pool" name="Sales" processRef="P"/></collaboration>
  <process id="P">
    <startEvent id="S"/><task id="A" name="Check"/><endEvent id="E"/>
    <sequenceFlow id="f1" sourceRef="S" targetRef="A"/>
    <sequenceFlow id="f2" sourceRef="A" targetRef="E"/>
  </process>
</definitions>`;

test("deriveView(bpmn): common core + the untouched DerivedProcess in detail", () => {
  const graph = extractModelGraph("bpmn", BPMN) as ModelGraph;
  const view = deriveView(graph);
  assert.equal(view?.notation, "bpmn");
  assert.equal(view?.name, "Sales");
  assert.equal(view?.summary, "Process with 1 step, 2 events, 0 gateways, 2 flows, 0 roles");
  assert.deepEqual(view?.stats, { steps: 1, events: 2, gateways: 0, flows: 2, roles: 0 });
  assert.deepEqual(view?.detail, deriveProcess(graph));
});

test("deriveView(dmn): name from definitions, rules counted, detail = deriveDecision", () => {
  const DMN = `<?xml version="1.0"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" name="Rabatt">
  <decision id="rabatt" name="Rabatt">
    <decisionTable id="T" hitPolicy="FIRST">
      <input id="I1"><inputExpression id="IE" typeRef="string"><text>kundentyp</text></inputExpression></input>
      <output id="O1" name="rabatt" typeRef="number"/>
      <rule id="R1"><inputEntry id="e1"><text>"stamm"</text></inputEntry><outputEntry id="e2"><text>10</text></outputEntry></rule>
    </decisionTable>
  </decision>
</definitions>`;
  const graph = extractModelGraph("dmn", DMN) as ModelGraph;
  const view = deriveView(graph);
  assert.equal(view?.name, "Rabatt");
  assert.equal(view?.summary, "Decision model with 1 decision, 0 inputData, 1 rule");
  assert.deepEqual(view?.detail, deriveDecision(graph));
});

test("deriveView(team-topology): detail lists every element by the .tt file's own field names", () => {
  const tt = deriveView(extractModelGraph("teams/sample.tt", fixture("sample.tt")) as ModelGraph);
  assert.deepEqual(tt?.detail, {
    teams: [
      {
        id: "team_checkout",
        label: "Checkout & Payments",
        type: "stream-aligned",
        description: "Owns the checkout and payment journey end-to-end.",
      },
      {
        id: "team_discovery",
        label: "Product Discovery",
        type: "stream-aligned",
        description: "Owns search, browsing and product pages end-to-end.",
      },
      {
        id: "team_fraud",
        label: "Fraud Detection",
        type: "complicated-subsystem",
        description: "Specialists for the real-time fraud scoring model.",
      },
      {
        id: "team_platform",
        label: "Cloud Platform",
        type: "platform",
        description: "Self-service CI/CD, runtime and observability for all teams.",
      },
      {
        id: "team_test_automation",
        label: "Test Automation",
        type: "enabling",
        description: "Coaches stream-aligned teams in test automation, then steps back.",
      },
    ],
    interactions: [
      { id: "int_checkout_fraud", label: "fraud rules", mode: "collaboration" },
      { id: "int_platform_checkout", label: null, mode: "x-as-a-service" },
      { id: "int_platform_discovery", label: null, mode: "x-as-a-service" },
      { id: "int_testing_discovery", label: null, mode: "facilitating" },
    ],
    flows: [{ id: "flow_main", label: "Flow of change" }],
    annotations: [
      {
        id: "ann_fraud_handover",
        text: "Collaboration until the fraud rules are stable (Q3), then X-as-a-Service",
        attachedTo: "int_checkout_fraud",
      },
    ],
  });

  const notesOnly = deriveView(
    extractModelGraph(
      "teams/notes.tt",
      JSON.stringify({
        version: 3,
        title: "Notes",
        nodes: [{ id: "a", type: "platform", label: "A" }],
        interactions: [],
        flows: [],
        annotations: [{ id: "n", text: "free", position: { x: 0, y: 0 }, size: { width: 9, height: 9 } }],
      }),
    ) as ModelGraph,
  );
  assert.equal(notesOnly?.summary, "Team Topology with 1 team, 0 interactions, 1 annotation");
  assert.deepEqual((notesOnly?.detail as { annotations: unknown }).annotations, [
    { id: "n", text: "free", attachedTo: null },
  ]);
});

test("deriveView(wardley/tt/vc): node/edge stats from the shipped fixtures", () => {
  const wardley = deriveView(extractModelGraph("maps/tea.owm", fixture("tea.owm")) as ModelGraph);
  assert.deepEqual(wardley?.stats, { components: 7, dependencies: 8 });
  assert.equal(wardley?.summary, "Wardley Map with 7 components, 8 dependencies");
  const { elements, links } = wardley?.detail as {
    elements: Array<{ id: string; type: string; name: string | null }>;
    links: Array<{ from: string; to: string; kind: string; label: string | null }>;
  };
  assert.deepEqual(elements[0], {
    id: "cmp_cup_of_tea",
    type: "component",
    name: "Cup of Tea",
    visibility: 0.79,
    evolution: 0.61,
    stage: "product",
  });
  assert.deepEqual(
    elements.slice(-3).map((e) => [e.id, e.type, e.name]),
    [
      ["anchor_business", "anchor", "Business"],
      ["anchor_public", "anchor", "Public"],
      ["pipeline_kettle", "pipeline", "Kettle"],
    ],
    "the canvas's ids, the names beside them",
  );
  assert.deepEqual(
    links[0],
    { from: "anchor_business", to: "cmp_cup_of_tea", kind: "dependency", label: null },
    "a link has no id: no canvas addresses it, so no todo anchors to it",
  );

  const tt = deriveView(extractModelGraph("teams/sample.tt", fixture("sample.tt")) as ModelGraph);
  assert.equal(tt?.name, "Online shop — team topology", "the document title is the model's own name");
  assert.deepEqual(tt?.stats, { teams: 5, interactions: 4, flows: 1, annotations: 1 });
  assert.equal(tt?.summary, "Team Topology with 5 teams, 4 interactions, 1 flow, 1 annotation");
  const untitled = deriveView(
    extractModelGraph(
      "teams/old.tt",
      JSON.stringify({ version: 1, nodes: [{ id: "a", type: "platform" }] }),
    ) as ModelGraph,
  );
  assert.equal(untitled?.name, null);
  assert.deepEqual(untitled?.stats, { teams: 1, interactions: 0, flows: 0, annotations: 0 });
  assert.equal(untitled?.summary, "Team Topology with 1 team, 0 interactions", "no flows or notes, no noise");

  const es = deriveView(
    extractModelGraph("boards/order-checkout.storm", fixture("order-checkout.storm")) as ModelGraph,
  );
  assert.equal(es?.name, "Order Checkout", "the board title is the model's own name");
  assert.deepEqual(es?.stats, {
    events: 2,
    commands: 2,
    actors: 1,
    aggregates: 2,
    policies: 1,
    readmodels: 1,
    externals: 1,
    hotspots: 1,
    notes: 1,
    drawings: 0,
    arrows: 9,
  });
  assert.equal(
    es?.summary,
    "Event Storming board with 2 events, 2 commands, 1 actor, 2 aggregates, 1 policy, 1 readmodel, 1 external, 1 hotspot, 1 note, 9 arrows",
  );
  // the timeline reads the board left to right — the facilitator's story
  assert.deepEqual(
    (es?.detail as { level: string | null; timeline: Array<{ name: string | null }> }).timeline.map((n) => n.name),
    [
      "Customer",
      "Place Order",
      "Order",
      "Payment Provider",
      "Order Status",
      "Order Placed",
      "Double payment on retry?",
      "When order placed, ship it",
      "Ship Order",
      "Order",
      "Order Shipped",
    ],
  );
  assert.equal((es?.detail as { level: string | null }).level, null);
  assert.equal(
    deriveView({ notation: "event-storming", nodes: [], edges: [], meta: { title: "Blank", level: "process" } })
      ?.summary,
    "Event Storming board with no elements",
  );

  const vc = deriveView(extractModelGraph("chains/porter.vc.json", fixture("porter.vc.json")) as ModelGraph);
  assert.deepEqual(vc?.stats, { elements: 8, connections: 7 });
  assert.equal(vc?.summary, "Value Chain with 8 elements, 7 connections");
  assert.equal(vc?.name, "Porter Value Chain", "the document's name is the model's own name");
  const detail = vc?.detail as {
    elements: Array<{ id: string; type: string; name: string | null }>;
    connections: Array<{ id: string; from: string; to: string; type: string }>;
  };
  assert.deepEqual(detail.elements[1], { id: "step-assembly", type: "step", name: "Assembly" });
  assert.deepEqual(detail.connections[0], {
    id: "assign-1",
    from: "step-testing",
    to: "org-development",
    type: "assignment",
  });
  assert.equal(detail.elements.length, 8);
  assert.equal(detail.connections.length, 7);
  const unnamed = extractModelGraph(
    "chains/blank.vc.json",
    JSON.stringify({ schemaVersion: 1, meta: { name: " " }, elements: [], connections: [] }),
  ) as ModelGraph;
  assert.equal(deriveView(unnamed)?.name, null, "a blank name is no name");
});

test("deriveView(context-map): title as name, per-subdomain + per-pattern stats, contexts + relationships in detail", () => {
  const cm = deriveView(extractModelGraph("maps/conference.cm.json", fixture("conference.cm.json")) as ModelGraph);
  assert.equal(cm?.name, "Conference event planner — context map", "the document title is the model's own name");
  assert.deepEqual(cm?.stats, {
    contexts: 6,
    relationships: 6,
    core: 2,
    supporting: 2,
    generic: 2,
    partnership: 0,
    "shared-kernel": 1,
    "customer-supplier": 1,
    "upstream-downstream": 4,
    "separate-ways": 0,
  });
  assert.equal(
    cm?.summary,
    "Context Map with 6 contexts (2 core, 2 supporting, 2 generic), " +
      "6 relationships (1 shared-kernel, 1 customer-supplier, 4 upstream-downstream)",
  );
  const detail = cm?.detail as {
    contexts: Array<{ id: string; name: string | null; subdomainType: string | null; team: string | null }>;
    relationships: Array<{
      id: string;
      from: string;
      to: string;
      pattern: string;
      upstreamRoles: string[];
      downstreamRoles: string[];
      label: string | null;
      implementationTechnology: string | null;
    }>;
  };
  assert.deepEqual(
    detail.contexts.map((c) => [c.id, c.subdomainType, c.team]),
    [
      ["ctx_auth", "generic", "Platform Team"],
      ["ctx_cfp", "supporting", "Program Team"],
      ["ctx_evaluation", "core", "Review Team"],
      ["ctx_notification", "generic", "Platform Team"],
      ["ctx_schedule", "core", "Program Team"],
      ["ctx_submission", "supporting", "Program Team"],
    ],
  );
  assert.deepEqual(detail.relationships[4], {
    id: "rel_submission_evaluation",
    from: "ctx_submission",
    to: "ctx_evaluation",
    pattern: "upstream-downstream",
    upstreamRoles: ["OHS"],
    downstreamRoles: ["ACL"],
    label: "submissions API",
    implementationTechnology: "RESTful HTTP",
  });
  // a symmetric relationship carries no roles; absent optionals read as null/[]
  assert.deepEqual(detail.relationships[1], {
    id: "rel_cfp_submission",
    from: "ctx_cfp",
    to: "ctx_submission",
    pattern: "shared-kernel",
    upstreamRoles: [],
    downstreamRoles: [],
    label: "proposal model",
    implementationTechnology: null,
  });
  // an empty map reads without a breakdown
  const blank = deriveView({ notation: "context-map", nodes: [], edges: [], meta: { title: "Blank" } });
  assert.equal(blank?.summary, "Context Map with 0 contexts, 0 relationships");
  assert.equal(blank?.name, "Blank");
});

test("deriveView: a notation without a deriver yields undefined (the caller keeps the bare row)", () => {
  assert.equal(deriveView({ notation: "markdown", nodes: [], edges: [] }), undefined);
  assert.equal(deriveView({ notation: "no-such", nodes: [], edges: [] }), undefined);
});
