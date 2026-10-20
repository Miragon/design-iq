/**
 * checkSchemaModel — the Miragon JSON notations (.tt/.ttm.json, .cm.json,
 * .vc.json) checked with the schema model their canvas parses them with
 * (#266). Pinned here: every refusal of the schema model is an ERROR at its
 * JSON path, a Context Map's advisory strategic-DDD rules are WARNs (only a
 * repeated id is refused, as the canvas refuses it), text that is no JSON
 * keeps the baseline finding, and the shipped templates and examples stay
 * clean.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { templateFor } from "@designiq/notations/templates";

import { checkModel, checkModelBaseline, checkSchemaModel, type Finding } from "../src/validate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATE = resolve(HERE, "..", "src", "cli.ts");
const fixture = (path: string): string => readFileSync(resolve(HERE, path), "utf8");

/** [severity, ruleId, message] — the wire-visible part of a finding */
const brief = (findings: Finding[] | undefined): Array<[string, string, string]> =>
  (findings ?? []).map((f) => [f.severity, f.ruleId, f.message]);

const box = { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } };

const teamTopology = (parts: { nodes?: unknown[]; interactions?: unknown[]; annotations?: unknown[] }): string =>
  JSON.stringify({ version: 3, title: "Teams", nodes: [], interactions: [], flows: [], annotations: [], ...parts });
const team = (id: string): object => ({ id, type: "stream-aligned", label: id, ...box });

const contextMap = (parts: { contexts?: unknown[]; relationships?: unknown[]; version?: number }): string =>
  JSON.stringify({ version: 1, title: "Map", contexts: [], relationships: [], ...parts });
const context = (id: string, extra: object = {}): object => ({ id, label: id, ...box, ...extra });

const valueChain = (parts: { elements?: unknown[]; connections?: unknown[] }): string =>
  JSON.stringify({ schemaVersion: 1, meta: { name: "Chain" }, elements: [], connections: [], ...parts });
const step = (id: string, bounds: object = { x: 0, y: 0, width: 160, height: 60 }): object => ({
  id,
  elementType: "step",
  name: id,
  bounds,
});
const sequence = (id: string, waypoints: unknown[]): object => ({
  id,
  connectionType: "sequence",
  source: "a",
  target: "b",
  waypoints,
});

test("team topology: duplicate and reserved ids are refused at their path", () => {
  const findings = checkSchemaModel(
    teamTopology({
      nodes: [team("a"), team("a"), team("tt-root"), team("__implicitroot_1"), team("assoc_note")],
      annotations: [{ id: "note", text: "n", ...box }],
    }),
    { file: "models/teams.tt", notation: "team-topology" },
  );
  assert.deepEqual(brief(findings), [
    [
      "ERROR",
      "team-topology/schema",
      'nodes.1.id: duplicate id "a"; ids must be unique across nodes, interactions, flows and annotations',
    ],
    ["ERROR", "team-topology/schema", 'nodes.2.id: "tt-root" is reserved for the diagram itself'],
    ["ERROR", "team-topology/schema", 'nodes.3.id: ids starting with "__implicitroot" are reserved'],
    ["ERROR", "team-topology/schema", 'nodes.4.id: "assoc_note" is reserved for the connector of annotation "note"'],
  ]);
  assert.ok(findings.every((f) => f.file === "models/teams.tt"));
});

test("team topology: a shape the schema rejects is an ERROR, the lenient migration still applies", () => {
  assert.deepEqual(
    brief(checkSchemaModel(teamTopology({ nodes: [{ id: "a", type: "squad" }] }), { notation: "team-topology" })),
    [
      [
        "ERROR",
        "team-topology/schema",
        'nodes.0.type: Invalid option: expected one of "stream-aligned"|"enabling"|"complicated-subsystem"|"platform"',
      ],
      ["ERROR", "team-topology/schema", "nodes.0.label: Invalid input: expected string, received undefined"],
      ["ERROR", "team-topology/schema", "nodes.0.position: Invalid input: expected object, received undefined"],
      ["ERROR", "team-topology/schema", "nodes.0.size: Invalid input: expected object, received undefined"],
    ],
  );
  assert.deepEqual(brief(checkSchemaModel("null", { notation: "team-topology" })), [
    ["ERROR", "team-topology/schema", "(root): Invalid input: expected object, received null"],
  ]);
  // parseDocument migrates any object to a document, so "{}" is an empty topology
  assert.deepEqual(checkSchemaModel("{}", { notation: "team-topology" }), []);
});

test("context map: a list, a newer version, a coordinate or size out of range and reserved ids are refused", () => {
  const check = (raw: string) => brief(checkSchemaModel(raw, { file: "models/m.cm.json", notation: "context-map" }));
  assert.deepEqual(check("[]"), [["ERROR", "context-map/schema", "(root): expected an object, got a list"]]);
  assert.deepEqual(check(contextMap({ version: 2 })), [
    [
      "ERROR",
      "context-map/schema",
      "version: 2 is newer than this modeler reads (1); update the modeler to open this file",
    ],
  ]);
  assert.deepEqual(
    check(
      contextMap({ contexts: [context("a", { position: { x: 1_000_001, y: 0 }, size: { width: 2e6, height: 50 } })] }),
    ),
    [
      ["ERROR", "context-map/schema", "contexts.0.position.x: Too big: expected number to be <=1000000"],
      ["ERROR", "context-map/schema", "contexts.0.size.width: Too big: expected number to be <=1000000"],
    ],
  );
  assert.deepEqual(check(contextMap({ contexts: [context("cm-root"), context("__implicitroot_2")] })), [
    ["ERROR", "context-map/schema", 'contexts.0.id: the id "cm-root" is reserved for the diagram itself'],
    ["ERROR", "context-map/schema", 'contexts.1.id: the id "__implicitroot_2" is reserved for the diagram itself'],
  ]);
});

test("context map: a repeated id is refused like the canvas refuses it, the advisory rules only warn", () => {
  const duplicate = contextMap({
    contexts: [context("a"), context("a")],
    relationships: [{ id: "a", from: "a", to: "a", pattern: "partnership" }],
  });
  const findings = checkSchemaModel(duplicate, { notation: "context-map" });
  assert.deepEqual(
    brief(findings).filter(([severity]) => severity === "ERROR"),
    [
      ["ERROR", "context-map/schema", 'Duplicate id "a". (unique-ids)'],
      ["ERROR", "context-map/schema", 'relationship "a": Duplicate id "a". (unique-ids)'],
    ],
  );
  // the self-relationship is one of validateDocument's errors, but the
  // canvas opens such a map and marks it: no refusal
  assert.deepEqual(
    brief(findings).filter(([severity]) => severity === "WARN"),
    [["WARN", "context-map/semantics", 'relationship "a": Connects a context to itself. (no-self-relationship)']],
  );

  const advisory = contextMap({
    contexts: [context("billing"), context("orders", { subdomainType: "core" })],
    relationships: [
      { id: "r1", from: "billing", to: "orders", pattern: "upstream-downstream", downstreamRoles: ["ACL", "CF"] },
      { id: "r2", from: "billing", to: "shipping", pattern: "partnership" },
    ],
  });
  assert.deepEqual(brief(checkSchemaModel(advisory, { notation: "context-map" })), [
    ["WARN", "context-map/semantics", 'relationship "r1": ACL and CF are combined; choose one. (protect-or-conform)'],
    ["WARN", "context-map/semantics", 'relationship "r2": References unknown context "shipping". (endpoints-on-map)'],
    [
      "WARN",
      "context-map/semantics",
      'relationship "r1": Core domain "orders" conforms (CF) to "billing"; protect the core with an ACL instead. (protect-the-core)',
    ],
  ]);
});

test("value chain: reserved ids, extra keys in bounds and waypoints, far coordinates and __proto__ are refused", () => {
  const check = (raw: string) => brief(checkSchemaModel(raw, { file: "models/c.vc.json", notation: "value-chain" }));
  assert.deepEqual(check(valueChain({ elements: [step("vc-root"), step("__implicitroot_1"), step("constructor")] })), [
    ["ERROR", "value-chain/schema", 'elements.0.id: Id "vc-root" is reserved for the diagram itself.'],
    ["ERROR", "value-chain/schema", 'elements.1.id: Id "__implicitroot_1" is reserved for the diagram itself.'],
    [
      "ERROR",
      "value-chain/schema",
      'elements.2.id: Id "constructor" is reserved: it names a built-in property of JavaScript objects.',
    ],
  ]);
  assert.deepEqual(
    check(
      valueChain({
        elements: [
          step("a", { x: 0, y: 0, width: 160, height: 60, depth: 1 }),
          step("b", { x: 2e9, y: 0, width: 160, height: 60 }),
        ],
        connections: [
          sequence("c", [
            { x: 0, y: 0, z: 1 },
            { x: 1, y: 1 },
          ]),
        ],
      }),
    ),
    [
      ["ERROR", "value-chain/schema", 'elements.0.bounds: Unrecognized key: "depth"'],
      ["ERROR", "value-chain/schema", "elements.1.bounds.x: Too big: expected number to be <=1000000000"],
      ["ERROR", "value-chain/schema", 'connections.0.waypoints.0: Unrecognized key: "z"'],
    ],
  );
  assert.deepEqual(
    check('{"schemaVersion": 1, "meta": {"name": "x", "__proto__": {}}, "elements": [], "connections": []}'),
    [["ERROR", "value-chain/schema", 'meta.__proto__: The key "__proto__" is not allowed.']],
  );
  assert.deepEqual(check(valueChain({ elements: [step("a"), step("a")] })), [
    ["ERROR", "value-chain/schema", 'elements.1.id: Duplicate id "a" in document.'],
  ]);
});

test("text that is no JSON keeps the baseline finding, whatever the notation", () => {
  for (const [notation, file] of [
    ["team-topology", "t.tt"],
    ["context-map", "m.cm.json"],
    ["value-chain", "c.vc.json"],
  ] as const) {
    assert.deepEqual(
      checkSchemaModel("{ broken", { file, notation }),
      checkModelBaseline("{ broken", { file, notation }),
    );
    assert.equal(checkSchemaModel("", { file, notation })[0]?.ruleId, "baseline/parse", notation);
  }
  // a notation without a schema model is the baseline alone
  assert.deepEqual(checkSchemaModel("component Tea [0.5, 0.5]", { notation: "wardley" }), []);
  // validate_model passes an agent's `notation` through: an id that names an
  // object built-in is an unknown notation, not a schema check
  for (const notation of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.deepEqual(checkSchemaModel("{}", { notation }), [], notation);
    assert.deepEqual(checkModel("{}", { path: "<model>", notation }), [], notation);
  }
  assert.deepEqual(checkSchemaModel("<a", { notation: "bpmn" }), checkModelBaseline("<a", { notation: "bpmn" }));
});

test("the blank templates and the shipped examples are clean", () => {
  assert.deepEqual(checkModel(templateFor("team-topology", "t", "Teams") ?? "", { path: "t.tt" }), []);
  assert.deepEqual(checkModel(templateFor("context-map", "m", "Map") ?? "", { path: "m.cm.json" }), []);
  assert.deepEqual(checkModel(fixture("../../notations/test/fixtures/sample.tt"), { path: "t.tt" }), []);
  assert.deepEqual(checkModel(fixture("../../notations/test/fixtures/conference.cm.json"), { path: "m.cm.json" }), []);
  assert.deepEqual(checkModel(fixture("../../notations/test/fixtures/porter.vc.json"), { path: "c.vc.json" }), []);
  assert.deepEqual(checkModel(fixture("fixtures/content-repo/landscape/team-topology.tt"), { path: "t.ttm.json" }), []);
  assert.deepEqual(
    checkModel(fixture("fixtures/content-repo/landscape/value-chain.vc.json"), { path: "c.vc.json" }),
    [],
  );
});

test("the CLI fails on what a canvas refuses and passes an advisory context-map finding", () => {
  const dir = mkdtempSync(join(tmpdir(), "validator-schema-"));
  writeFileSync(join(dir, "designiq.yml"), "models: models\n");
  mkdirSync(join(dir, "models"));
  const write = (name: string, content: string): void => writeFileSync(join(dir, "models", name), content);
  write("teams.tt", teamTopology({ nodes: [team("a"), team("a")] }));
  write("map.cm.json", contextMap({ contexts: [context("cm-root")] }));
  write("chain.vc.json", valueChain({ elements: [step("vc-root")] }));
  write("advisory.cm.json", contextMap({ relationships: [{ id: "r", from: "x", to: "y", pattern: "partnership" }] }));

  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [VALIDATE, "--root", dir, ...args], { encoding: "utf8" });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const all = run();
  assert.equal(all.status, 1, all.out);
  assert.match(all.out, /\[ERROR\] models\/teams\.tt: nodes\.1\.id: duplicate id "a"/);
  assert.match(all.out, /\[ERROR\] models\/map\.cm\.json: contexts\.0\.id: the id "cm-root" is reserved/);
  assert.match(all.out, /\[ERROR\] models\/chain\.vc\.json: elements\.0\.id: Id "vc-root" is reserved/);
  assert.match(all.out, /\[WARN\] models\/advisory\.cm\.json: relationship "r": References unknown context "x"/);
  assert.match(all.out, /3 error\(s\), 2 warning\(s\) — FAIL \(0 process\(es\), 4 other model\(s\) checked\)/);

  const advisory = run("advisory");
  assert.equal(advisory.status, 0, advisory.out);
  assert.match(advisory.out, /0 error\(s\), 2 warning\(s\) — OK/);
});
