/**
 * templateFor — the generic template dispatch (epic #118 step 3). The
 * builders themselves are pinned by the live-host scaffold suite (which
 * consumes them through the domain shims); here only the dispatch contract.
 * That a Miragon template is its renderer's own serialization (no phantom
 * diff on the first canvas save) is pinned against the renderers apps/web
 * ships, in apps/web/test/miragon-renderers.test.ts. The Team Topology,
 * Context Map and Value Chain templates are also held against their schema
 * model's own serializer here (devDependencies at the versions the renderers
 * apps/web pins depend on), so a format change fails in this package's suite
 * too.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emptyDocument as emptyContextMap,
  serializeDocumentText as serializeContextMap,
} from "@miragon/context-maps-schema-model";
import { emptyDocument, serializeDocument } from "@miragon/team-topologies-schema-model";
import {
  createEmptyDocument as emptyValueChain,
  serializeDocument as serializeValueChain,
} from "@miragon/value-chain-schema-model";

import { modelElements } from "../elements.ts";
import { extractModelGraph } from "../extract.ts";
import {
  hasTemplate,
  newBpmnXml,
  newCmJson,
  newDmnXml,
  newMarkdownText,
  newOwmText,
  newStormText,
  newTtJson,
  newVcJson,
  templateFor,
} from "../templates.ts";

test("templateFor: dispatches to the notation's builder, undefined without one", () => {
  assert.equal(templateFor("bpmn", "order", "Order"), newBpmnXml("order", "Order"));
  assert.equal(templateFor("dmn", "rabatt", "Rabatt"), newDmnXml("rabatt", "Rabatt"));
  assert.equal(templateFor("wardley", "map", "Platform Map"), newOwmText("map", "Platform Map"));
  assert.equal(templateFor("team-topology", "teams", "Teams"), newTtJson("teams", "Teams"));
  assert.equal(templateFor("event-storming", "board", "Board"), newStormText("board", "Board"));
  assert.equal(templateFor("context-map", "map", "Map"), newCmJson("map", "Map"));
  assert.equal(templateFor("value-chain", "chain", "Chain"), newVcJson("chain", "Chain"));
  assert.equal(templateFor("markdown", "notes", "Notes"), newMarkdownText("notes", "Notes"));
  assert.equal(templateFor("no-such", "x", "X"), undefined);
});

test("hasTemplate mirrors templateFor — it drives the New menu and the create route", () => {
  for (const id of [
    "bpmn",
    "dmn",
    "wardley",
    "team-topology",
    "event-storming",
    "context-map",
    "value-chain",
    "markdown",
  ]) {
    assert.equal(hasTemplate(id), true, id);
  }
  // mermaid: withdrawn in 5.5, not in the New menu nor create_model (a
  // diagram is a fence in a Markdown document)
  for (const id of ["mermaid", "no-such"]) assert.equal(hasTemplate(id), false, id);
  // prototype members are NOT templates (the `in`/bare-index bug class):
  // templateFor("toString") used to return "[object Object]" as file content
  for (const id of ["toString", "constructor", "__proto__"]) {
    assert.equal(hasTemplate(id), false, id);
    assert.equal(templateFor(id, "x", "X"), undefined, id);
  }
});

test("the bpmn template is one unnamed none start event in a plain process, with its BPMNDI (#183)", () => {
  const xml = newBpmnXml("order-to-cash", "Order to Cash");
  const graph = extractModelGraph("bpmn", xml);
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    notation: "bpmn",
    nodes: [{ id: "startEvent_start", type: "startEvent", extra: {} }],
    edges: [],
    meta: { lanes: [], pools: [], processes: [{ id: "order-to-cash", name: "Order to Cash" }] },
  });
  assert.match(xml, /<bpmn:process id="order-to-cash" name="Order to Cash" isExecutable="false">/);
  // no pool, no trigger, no end event, no flow, no placeholder name
  assert.doesNotMatch(
    xml,
    /collaboration|participant|EventDefinition|endEvent|sequenceFlow|BPMNEdge|BPMNLabel|name="(?!Order to Cash")/,
  );
  // the diagram draws the process and its start event, where the editor's first view shows it
  assert.deepEqual(modelElements("bpmn", xml), [
    { id: "order-to-cash", name: "Order to Cash" },
    { id: "startEvent_start" },
  ]);
  assert.match(xml, /<bpmndi:BPMNPlane id="BPMNPlane_order-to-cash" bpmnElement="order-to-cash">/);
  assert.match(
    xml,
    /<bpmndi:BPMNShape id="startEvent_start_di" bpmnElement="startEvent_start">\s*<dc:Bounds x="232" y="162" width="36" height="36" \/>\s*<\/bpmndi:BPMNShape>/,
  );
});

test("the wardley template is a title-only OWM map", () => {
  assert.equal(newOwmText("map", "Platform Map"), "title Platform Map\n");
});

test("the event-storming template is a title-only .storm board — the serializer's own output for it", () => {
  // pinned against @miragon/event-storming-dsl serializeDSL(parseDSL("title X\n")):
  // the title line, nothing else, trailing newline — a byte-stable first save
  assert.equal(newStormText("board", "Order Checkout"), "title Order Checkout\n");
  assert.equal(newStormText("x", "A\nB\u2028command Evil [1, 2]"), "title A B command Evil [1, 2]\n");
});

test("the team-topology template is the schema-model's CANONICAL empty document (byte-stable first save)", () => {
  // the renderer's exportText (createCollaborativeModeler) calls serializeDocument(…, true)
  for (const name of ["Team Landscape", "Platform & Streams", 'Quote " and \\ backslash']) {
    assert.equal(newTtJson("teams", name), serializeDocument(emptyDocument(name), true), name);
  }
});

test("the context-map template is the schema-model's CANONICAL empty document (byte-stable first save)", () => {
  // the renderer's exportText (createCollaborativeModeler) is serializeDocumentText: the
  // pretty document and its line break
  for (const name of ["Conference Planner", "Orders & Billing", 'Quote " and \\ backslash']) {
    assert.equal(newCmJson("map", name), serializeContextMap(emptyContextMap(name)), name);
  }
  assert.ok(newCmJson("map", "Conference Planner").endsWith("}\n"));
  assert.equal((JSON.parse(newCmJson("x", "A\nB")) as { title: string }).title, "A B");
});

test("the value-chain template is the schema-model's CANONICAL empty document (byte-stable first save)", () => {
  // the renderer's exportText (createCollaborativeModeler) is serializeDocument: every key
  // sorted, 2-space indent, a closing line break
  for (const name of ["Porter Value Chain", "Orders & Billing", 'Quote " and \\ backslash']) {
    assert.equal(newVcJson("chain", name), serializeValueChain(emptyValueChain(name)), name);
  }
  assert.ok(newVcJson("chain", "Porter Value Chain").endsWith("}\n"));
  assert.equal((JSON.parse(newVcJson("x", "A\nB")) as { meta: { name: string } }).meta.name, "A B");
});

test("template names are forced onto one line — control chars would break OWM and JSON alike", () => {
  assert.equal(newOwmText("x", "A\nB\tC"), "title A B C\n");
  // U+2028/U+2029 are LineTerminators for /m regexes — an embedded separator
  // would smuggle a second logical line into the "blank" map (#139 review)
  assert.equal(newOwmText("x", "A\u2028component Evil [0.9, 0.9]"), "title A component Evil [0.9, 0.9]\n");
  assert.equal(newOwmText("x", "A\u2029B"), "title A B\n");
  assert.equal((JSON.parse(newTtJson("x", "A\nB")) as { title: string }).title, "A B");
  assert.equal(newMarkdownText("x", "A\rB"), "# A B\n");
});

test("newDmnXml keeps the frozen DMN namespace base", () => {
  // spelled in two halves ON PURPOSE: a search/replace of the product name must
  // not be able to rewrite the template and this pin together
  assert.ok(newDmnXml("x", "X").includes('namespace="http://' + "bpm" + 'iq.dev/dmn/x"'));
});
