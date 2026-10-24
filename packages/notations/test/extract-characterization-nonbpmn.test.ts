/**
 * CHARACTERIZATION of the wardley / team-topology / event-storming /
 * context-map / value-chain extractors —
 * pinned BEFORE registry-driven discovery makes them reachable (they are dead
 * code until then: no discovery path hands them a file, and nothing else
 * exercised them). The fixtures are the de-facto format spec: tea.owm,
 * sample.tt, order-checkout.storm and conference.cm.json are the shipped
 * examples of the Miragon modelers in Miragon/modeler-suite
 * (modelers/wardley-maps, modelers/team-topologies, modelers/event-storming,
 * modelers/context-maps, modelers/value-chain: porter.vc.json), whose
 * deterministic serializers define what real files look like.
 *
 * Deliberately pinned quirks (documenting gaps, not endorsing them):
 *
 *  - wardley: only `component` lines become nodes — `anchor`/`pipeline`/
 *    `evolve`/`title` are ignored, so edges may reference ids with NO node
 *    (Business/Public below), and the `(outsource)` suffix is dropped;
 *  - team-topology: relations are spatial, so a .tt yields ZERO edges: an
 *    interaction is a placed shape between its teams and becomes a node of
 *    type "interaction" (its `mode` in extra), and so do a flow of change
 *    ("flow") and an annotation ("annotation", its text as name, the element
 *    it is attached to in extra, never an edge); position and size are
 *    dropped;
 *  - value-chain: elementType/connectionType default to "element"/
 *    "connection" and missing connection ids become `conn-<index>`
 *    (lenient like the other extractors; the schema requires all three).
 *
 * Compared through a JSON round-trip: the WIRE representation is what is
 * pinned (in memory, absent fields ride as `undefined` properties).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { extractModelGraph } from "../extract.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("extractWardley: the shipped tea.owm example is pinned", () => {
  const graph = extractModelGraph("maps/tea.owm", fixture("tea.owm"));
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "wardley",
    nodes: [
      {
        id: "Cup of Tea",
        type: "component",
        name: "Cup of Tea",
        extra: { visibility: 0.79, evolution: 0.61, stage: "product" },
      },
      { id: "Cup", type: "component", name: "Cup", extra: { visibility: 0.73, evolution: 0.78, stage: "commodity" } },
      { id: "Tea", type: "component", name: "Tea", extra: { visibility: 0.63, evolution: 0.81, stage: "commodity" } },
      {
        id: "Hot Water",
        type: "component",
        name: "Hot Water",
        extra: { visibility: 0.52, evolution: 0.8, stage: "commodity" },
      },
      {
        id: "Water",
        type: "component",
        name: "Water",
        extra: { visibility: 0.38, evolution: 0.82, stage: "commodity" },
      },
      {
        id: "Kettle",
        type: "component",
        name: "Kettle",
        extra: { visibility: 0.43, evolution: 0.35, stage: "custom-built" },
      },
      { id: "Power", type: "component", name: "Power", extra: { visibility: 0.1, evolution: 0.71, stage: "product" } },
    ],
    edges: [
      { id: "dep-0", from: "Business", to: "Cup of Tea", kind: "dependency" },
      { id: "dep-1", from: "Public", to: "Cup of Tea", kind: "dependency" },
      { id: "dep-2", from: "Cup of Tea", to: "Cup", kind: "dependency" },
      { id: "dep-3", from: "Cup of Tea", to: "Tea", kind: "dependency" },
      { id: "dep-4", from: "Cup of Tea", to: "Hot Water", kind: "dependency" },
      { id: "dep-5", from: "Hot Water", to: "Water", kind: "dependency" },
      { id: "dep-6", from: "Hot Water", to: "Kettle", kind: "dependency" },
      { id: "dep-7", from: "Kettle", to: "Power", kind: "dependency" },
    ],
  });
});

test("extractTeamTopology: the shipped sample.tt example is pinned — interactions, flows and annotations are nodes, real .tt files yield NO edges", () => {
  const graph = extractModelGraph("teams/sample.tt", fixture("sample.tt"));
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "team-topology",
    nodes: [
      {
        id: "team_checkout",
        type: "stream-aligned",
        name: "Checkout & Payments",
        extra: { description: "Owns the checkout and payment journey end-to-end." },
      },
      {
        id: "team_discovery",
        type: "stream-aligned",
        name: "Product Discovery",
        extra: { description: "Owns search, browsing and product pages end-to-end." },
      },
      {
        id: "team_fraud",
        type: "complicated-subsystem",
        name: "Fraud Detection",
        extra: { description: "Specialists for the real-time fraud scoring model." },
      },
      {
        id: "team_platform",
        type: "platform",
        name: "Cloud Platform",
        extra: { description: "Self-service CI/CD, runtime and observability for all teams." },
      },
      {
        id: "team_test_automation",
        type: "enabling",
        name: "Test Automation",
        extra: { description: "Coaches stream-aligned teams in test automation, then steps back." },
      },
      { id: "int_checkout_fraud", type: "interaction", name: "fraud rules", extra: { mode: "collaboration" } },
      { id: "int_platform_checkout", type: "interaction", extra: { mode: "x-as-a-service" } },
      { id: "int_platform_discovery", type: "interaction", extra: { mode: "x-as-a-service" } },
      { id: "int_testing_discovery", type: "interaction", extra: { mode: "facilitating" } },
      { id: "flow_main", type: "flow", name: "Flow of change" },
      {
        id: "ann_fraud_handover",
        type: "annotation",
        name: "Collaboration until the fraud rules are stable (Q3), then X-as-a-Service",
        extra: { attachedTo: "int_checkout_fraud" },
      },
    ],
    edges: [],
    meta: { title: "Online shop — team topology" },
  });
});

test("extractTeamTopology: an annotation keeps only a connector the canvas draws, to a team, interaction or flow", () => {
  const box = { position: { x: 0, y: 0 }, size: { width: 9, height: 9 } };
  const annotation = (id: string, attachedTo?: string) => ({ id, text: `note ${id}`, ...box, attachedTo });
  const graph = extractModelGraph(
    "teams/notes.tt",
    JSON.stringify({
      version: 3,
      title: "Notes",
      nodes: [{ id: "team", type: "platform", label: "Team", ...box }],
      interactions: [{ id: "talk", mode: "collaboration", ...box }],
      flows: [{ id: "flow", ...box }, null, "flow"],
      annotations: [
        annotation("free"),
        annotation("on_team", "team"),
        annotation("on_talk", "talk"),
        annotation("on_flow", "flow"),
        annotation("on_note", "free"),
        annotation("on_ghost", "ghost"),
        null,
      ],
    }),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "team-topology",
    nodes: [
      { id: "team", type: "platform", name: "Team" },
      { id: "talk", type: "interaction", extra: { mode: "collaboration" } },
      { id: "flow", type: "flow" },
      { id: "free", type: "annotation", name: "note free" },
      { id: "on_team", type: "annotation", name: "note on_team", extra: { attachedTo: "team" } },
      { id: "on_talk", type: "annotation", name: "note on_talk", extra: { attachedTo: "talk" } },
      { id: "on_flow", type: "annotation", name: "note on_flow", extra: { attachedTo: "flow" } },
      // the importer draws no connector to another annotation or an unknown id
      { id: "on_note", type: "annotation", name: "note on_note" },
      { id: "on_ghost", type: "annotation", name: "note on_ghost" },
    ],
    edges: [],
    meta: { title: "Notes" },
  });
});

test("extractTeamTopology: a version 1 file without flows or a title; a note on its dropped edge stays unattached", () => {
  const graph = extractModelGraph(
    "teams/old.tt",
    JSON.stringify({
      version: 1,
      nodes: [{ id: "a", type: "platform", label: "A" }],
      interactions: [{ id: "edge", mode: "collaboration", source: "a", target: "a" }],
      annotations: [{ id: "note", text: "dropped edge", attachedTo: "edge" }],
    }),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "team-topology",
    nodes: [
      { id: "a", type: "platform", name: "A" },
      { id: "note", type: "annotation", name: "dropped edge" },
    ],
    edges: [],
    meta: { title: null },
  });
  for (const title of ["", 42, null]) {
    assert.deepEqual(
      extractModelGraph("teams/blank.tt", JSON.stringify({ version: 3, title }))?.meta,
      { title: null },
      `title ${JSON.stringify(title)}`,
    );
  }
});

test("extractTeamTopology: a flow label or annotation text that is no string, or an empty one, leaves the node unnamed", () => {
  const box = { position: { x: 0, y: 0 }, size: { width: 9, height: 9 } };
  const graph = extractModelGraph(
    "teams/malformed.tt",
    JSON.stringify({
      version: 3,
      title: "Malformed",
      nodes: [],
      interactions: [],
      flows: [
        { id: "numbered", label: 42, ...box },
        { id: "blank", label: "", ...box },
      ],
      annotations: [
        { id: "listed", text: ["a"], ...box },
        { id: "empty", text: "", ...box },
      ],
    }),
  );
  assert.deepEqual(graph?.nodes, [
    { id: "numbered", type: "flow", name: undefined },
    { id: "blank", type: "flow", name: undefined },
    { id: "listed", type: "annotation", name: undefined, extra: undefined },
    { id: "empty", type: "annotation", name: undefined, extra: undefined },
  ]);
});

test("extractTeamTopology: a version 1 edge is dropped like the schema model drops it, a later interaction without geometry stays", () => {
  const interactions = [
    { id: "edge", mode: "collaboration", source: "a", target: "b" },
    { id: "placed", mode: "facilitating", position: { x: 0, y: 0 }, size: { width: 9, height: 9 } },
    null,
  ];
  const nodesOf = (version: number | undefined) =>
    extractModelGraph(
      "teams/old.tt",
      JSON.stringify({ version, nodes: [{ id: "a", type: "platform", label: "A" }], interactions }),
    )?.nodes.map((n) => [n.id, n.type]);
  assert.deepEqual(nodesOf(1), [
    ["a", "platform"],
    ["placed", "interaction"],
  ]);
  // the schema model refuses these files at interactions.0.size: the view
  // keeps what the file says rather than hiding the element the finding names
  for (const version of [2, 3, undefined]) {
    assert.deepEqual(
      nodesOf(version),
      [
        ["a", "platform"],
        ["edge", "interaction"],
        ["placed", "interaction"],
      ],
      `version ${version}`,
    );
  }
  assert.deepEqual(extractModelGraph("teams/blank.tt", '{"nodes": {}}')?.nodes, []);
});

test("extractEventStorming: the shipped order-checkout.storm example is pinned — ids equal the renderer's", () => {
  // every id below is what @miragon/event-storming-dsl parseDSL allocates for
  // the same file (`<prefix>_<slug>`, explicit `(id …)` kept) — the graph's
  // ids ARE the canvas element ids; `#agg_order` arrows resolve by id, the
  // rest by name; the note is a node but never an arrow endpoint
  const graph = extractModelGraph("boards/order-checkout.storm", fixture("order-checkout.storm"));
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "event-storming",
    nodes: [
      { id: "actor_customer", type: "actor", name: "Customer", extra: { x: 80, y: 300 } },
      { id: "cmd_place_order", type: "command", name: "Place Order", extra: { x: 240, y: 300 } },
      { id: "agg_order", type: "aggregate", name: "Order", extra: { x: 420, y: 290 } },
      { id: "event_order_placed", type: "event", name: "Order Placed", extra: { x: 620, y: 300 } },
      {
        id: "policy_when_order_placed_ship_it",
        type: "policy",
        name: "When order placed, ship it",
        extra: { x: 800, y: 300 },
      },
      { id: "cmd_ship_order", type: "command", name: "Ship Order", extra: { x: 980, y: 300 } },
      { id: "agg_order_2", type: "aggregate", name: "Order", extra: { x: 1160, y: 290 } },
      { id: "event_order_shipped", type: "event", name: "Order Shipped", extra: { x: 1340, y: 300 } },
      { id: "read_order_status", type: "readmodel", name: "Order Status", extra: { x: 620, y: 120 } },
      { id: "ext_payment_provider", type: "external", name: "Payment Provider", extra: { x: 420, y: 520 } },
      {
        id: "hot_double_payment_on_retry",
        type: "hotspot",
        name: "Double payment on retry?",
        extra: { x: 620, y: 520 },
      },
      {
        id: "note_design_level_session_checkout_flow",
        type: "note",
        name: "Design-level session: checkout flow",
        extra: { x: 80, y: 80 },
      },
    ],
    edges: [
      { id: "arrow_1", from: "actor_customer", to: "cmd_place_order", kind: "arrow" },
      { id: "arrow_2", from: "cmd_place_order", to: "agg_order", kind: "arrow" },
      { id: "arrow_3", from: "cmd_place_order", to: "ext_payment_provider", kind: "arrow" },
      { id: "arrow_4", from: "agg_order", to: "event_order_placed", kind: "arrow" },
      { id: "arrow_5", from: "event_order_placed", to: "read_order_status", kind: "arrow" },
      { id: "arrow_6", from: "event_order_placed", to: "policy_when_order_placed_ship_it", kind: "arrow" },
      { id: "arrow_7", from: "policy_when_order_placed_ship_it", to: "cmd_ship_order", kind: "arrow" },
      { id: "arrow_8", from: "cmd_ship_order", to: "agg_order_2", kind: "arrow" },
      { id: "arrow_9", from: "agg_order_2", to: "event_order_shipped", kind: "arrow" },
    ],
    meta: { title: "Order Checkout", level: null },
  });
});

test("extractEventStorming: suffixes, pinning, drawings, comments and arrow labels follow the DSL", () => {
  // expected values cross-checked against parseDSL of the same text
  const storm = [
    "title As-Is -> To-Be", // an arrow-looking title is a title (no sticky named "As-Is" yet)
    "level process",
    "style dark", // config the graph does not carry",
    "/* block",
    "comment */ event Order Placed [620, 300]",
    "external Payment Provider [420, 520] (color #ff00aa) // trailing comment",
    "hotspot Double payment? [620, 520] (on Order Placed)",
    "actor Customer (on Nobody)", // no coordinates → [0, 0]; unresolved host → no pin
    "note Session [80, 80] (size 200x120) (align center middle) (on Order Placed)",
    "line [[100, 100], [200, 150], [180, 240]] (dashed)",
    "line [[1, 1]]", // a single point is no drawing
    "event Broken [x, y]", // malformed coordinates are skipped
    "Order Placed -> Payment Provider; async",
    "Customer -> #ext_payment_provider",
    "Session -> Order Placed", // a note is never an arrow endpoint
    "Ghost -> Order Placed", // unresolved → dropped, like the canvas
  ].join("\n");
  const graph = extractModelGraph("boards/x.storm", storm);
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "event-storming",
    nodes: [
      { id: "event_order_placed", type: "event", name: "Order Placed", extra: { x: 620, y: 300 } },
      {
        id: "ext_payment_provider",
        type: "external",
        name: "Payment Provider",
        extra: { x: 420, y: 520, color: "#ff00aa" },
      },
      {
        id: "hot_double_payment",
        type: "hotspot",
        name: "Double payment?",
        extra: { x: 620, y: 520, attachedTo: "event_order_placed" },
      },
      { id: "actor_customer", type: "actor", name: "Customer", extra: { x: 0, y: 0 } },
      { id: "note_session", type: "note", name: "Session", extra: { x: 80, y: 80, attachedTo: "event_order_placed" } },
      { id: "draw_line", type: "drawing", extra: { x: 100, y: 100, points: 3 } },
    ],
    edges: [
      { id: "arrow_1", from: "event_order_placed", to: "ext_payment_provider", kind: "arrow", name: "async" },
      { id: "arrow_2", from: "actor_customer", to: "ext_payment_provider", kind: "arrow" },
    ],
    meta: { title: "As-Is -> To-Be", level: "process" },
  });
});

test("extractContextMap: the schema-model's SAMPLE_DOCUMENT is pinned — ids equal the renderer's", () => {
  // conference.cm.json is serializeDocument(SAMPLE_DOCUMENT) of
  // @miragon/context-maps-schema-model 0.1.0 (canonical: sorted by id) —
  // every id below is what the renderer's importer registers as element id;
  // the subdomain type is the node type, the pattern the edge kind, the
  // integration roles ride in edge.extra
  const graph = extractModelGraph("maps/conference.cm.json", fixture("conference.cm.json"));
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "context-map",
    nodes: [
      {
        id: "ctx_auth",
        type: "generic",
        name: "User Access",
        extra: {
          team: "Platform Team",
          description: "Registration and authentication for speakers and attendees.",
          x: 40,
          y: 300,
          width: 200,
          height: 110,
        },
      },
      {
        id: "ctx_cfp",
        type: "supporting",
        name: "CfP Management",
        extra: {
          team: "Program Team",
          description: "Runs the call for papers and exposes the public submission API.",
          x: 340,
          y: 120,
          width: 200,
          height: 110,
        },
      },
      {
        id: "ctx_evaluation",
        type: "core",
        name: "Session Evaluation",
        extra: {
          team: "Review Team",
          description: "Scoring and selection of submitted sessions.",
          x: 960,
          y: 140,
          width: 200,
          height: 110,
        },
      },
      {
        id: "ctx_notification",
        type: "generic",
        name: "Notification Handling",
        extra: {
          team: "Platform Team",
          description: "Sends emails to speakers and attendees, conforming to the schedule events.",
          x: 1280,
          y: 580,
          width: 200,
          height: 110,
        },
      },
      {
        id: "ctx_schedule",
        type: "core",
        name: "Schedule Management",
        extra: {
          team: "Program Team",
          description: "Builds and publishes the conference schedule.",
          x: 960,
          y: 440,
          width: 200,
          height: 110,
        },
      },
      {
        id: "ctx_submission",
        type: "supporting",
        name: "Submission Handling",
        extra: {
          team: "Program Team",
          description: "Owns proposals once submitted; the hub other contexts integrate with.",
          x: 640,
          y: 300,
          width: 200,
          height: 110,
        },
      },
    ],
    edges: [
      {
        id: "rel_auth_cfp",
        from: "ctx_auth",
        to: "ctx_cfp",
        kind: "upstream-downstream",
        name: "identity",
        extra: { upstreamRoles: ["OHS"], downstreamRoles: ["ACL"] },
      },
      {
        id: "rel_cfp_submission",
        from: "ctx_cfp",
        to: "ctx_submission",
        kind: "shared-kernel",
        name: "proposal model",
      },
      {
        id: "rel_evaluation_schedule",
        from: "ctx_evaluation",
        to: "ctx_schedule",
        kind: "customer-supplier",
        name: "accepted sessions",
        extra: { upstreamRoles: ["PL"] },
      },
      {
        id: "rel_schedule_notification",
        from: "ctx_schedule",
        to: "ctx_notification",
        kind: "upstream-downstream",
        name: "schedule events",
        extra: { upstreamRoles: ["OHS", "PL"], downstreamRoles: ["CF"] },
      },
      {
        id: "rel_submission_evaluation",
        from: "ctx_submission",
        to: "ctx_evaluation",
        kind: "upstream-downstream",
        name: "submissions API",
        extra: { upstreamRoles: ["OHS"], downstreamRoles: ["ACL"], implementationTechnology: "RESTful HTTP" },
      },
      {
        id: "rel_submission_schedule",
        from: "ctx_submission",
        to: "ctx_schedule",
        kind: "upstream-downstream",
        extra: { upstreamRoles: ["OHS"], downstreamRoles: ["ACL"] },
      },
    ],
    meta: { title: "Conference event planner — context map" },
  });
});

test("extractContextMap: lenient like the schema-model's migrate — missing containers, id-less contexts, rel-<i> ids", () => {
  const raw = JSON.stringify({
    title: 7, // not a string → no title
    contexts: [
      { id: "a", label: "A" }, // no geometry, no classification → plain "context" at 0/0
      { label: "no id" }, // skipped: a context IS its id
      null,
      { id: "b", label: "B", subdomainType: "weird", team: "", position: { x: "1" } },
    ],
    relationships: [
      { from: "a", to: "b", pattern: "partnership", upstreamRoles: ["OHS", 3] }, // id-less → rel-0; non-string roles dropped
      { id: "r2", from: "a", to: "ghost", pattern: "separate-ways", implementationTechnology: "gRPC" }, // dangling endpoint kept — the canvas has it too
      "junk",
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(extractModelGraph("maps/x.cm.json", raw))), {
    notation: "context-map",
    nodes: [
      { id: "a", type: "context", name: "A", extra: { x: 0, y: 0, width: 0, height: 0 } },
      { id: "b", type: "context", name: "B", extra: { x: 0, y: 0, width: 0, height: 0 } },
    ],
    edges: [
      { id: "rel-0", from: "a", to: "b", kind: "partnership", extra: { upstreamRoles: ["OHS"] } },
      { id: "r2", from: "a", to: "ghost", kind: "separate-ways", extra: { implementationTechnology: "gRPC" } },
    ],
    meta: { title: null },
  });
  // a non-object document (parseable JSON, wrong shape) is an empty map, not a crash
  for (const raw of ["[]", '"text"', "null", "42"]) {
    assert.deepEqual(JSON.parse(JSON.stringify(extractModelGraph("maps/x.cm.json", raw))), {
      notation: "context-map",
      nodes: [],
      edges: [],
      meta: { title: null },
    });
  }
});

test("extractValueChain: the shipped porter.vc.json example is pinned — ids and names are the document's own", () => {
  const graph = extractModelGraph("chains/porter.vc.json", fixture("porter.vc.json"));
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "value-chain",
    nodes: [
      { id: "org-development", type: "orgUnit", name: "Entwicklung" },
      { id: "step-assembly", type: "step", name: "Assembly" },
      { id: "step-inbound", type: "step", name: "Inbound Logistics" },
      { id: "step-marketing", type: "step", name: "Marketing & Sales" },
      { id: "step-operations", type: "step", name: "Operations" },
      { id: "step-outbound", type: "step", name: "Outbound Logistics" },
      { id: "step-service", type: "step", name: "Service" },
      { id: "step-testing", type: "step", name: "Testing" },
    ],
    edges: [
      { id: "assign-1", from: "step-testing", to: "org-development", kind: "assignment" },
      { id: "hier-1", from: "step-operations", to: "step-assembly", kind: "hierarchy" },
      { id: "hier-2", from: "step-operations", to: "step-testing", kind: "hierarchy" },
      { id: "seq-1", from: "step-inbound", to: "step-operations", kind: "sequence" },
      { id: "seq-2", from: "step-operations", to: "step-outbound", kind: "sequence" },
      { id: "seq-3", from: "step-outbound", to: "step-marketing", kind: "sequence" },
      { id: "seq-4", from: "step-marketing", to: "step-service", kind: "sequence" },
    ],
  });
});

test("extractValueChain: lenient on what the schema requires — type and id defaults", () => {
  const graph = extractModelGraph(
    "chains/loose.vc.json",
    JSON.stringify({
      elements: [{ id: "a", name: "A", label: "not the name" }],
      connections: [{ source: "a", target: "a" }],
    }),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "value-chain",
    nodes: [{ id: "a", type: "element", name: "A" }],
    edges: [{ id: "conn-0", from: "a", to: "a", kind: "connection" }],
  });
});

test("extractWardley: DIRECTIVE lines containing '->' are never dependency edges (#139 review)", () => {
  // `evolution` is OWM syntax; a title with an arrow is platform-authorable
  // via the create dialog ("As-Is -> To-Be") — neither is a dependency
  const owm = [
    "title As-Is -> To-Be",
    "evolution Genesis->Custom->Product->Commodity",
    "component A [0.5, 0.5]",
    "component B [0.4, 0.6]",
    "A -> B",
  ].join("\n");
  const graph = extractModelGraph("maps/x.owm", owm);
  assert.ok(graph, "wardley extractor resolved");
  assert.deepEqual(
    JSON.parse(JSON.stringify(graph.edges)),
    [{ id: "dep-0", from: "A", to: "B", kind: "dependency" }],
    "only the real dependency line survives",
  );
});
