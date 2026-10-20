/**
 * templateFor — the generic template dispatch (epic #118 step 3). The
 * builders themselves are pinned by the live-host scaffold suite (which
 * consumes them through the domain shims); here only the dispatch contract.
 * That a Miragon template is its renderer's own serialization (no phantom
 * diff on the first canvas save) is pinned against the renderers apps/web
 * ships, in apps/web/test/miragon-renderers.test.ts. The Team Topology and
 * Context Map templates are also held against their schema model's own
 * serializer here (devDependencies at the versions the renderers apps/web
 * pins depend on), so a format change fails in this package's suite too.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emptyDocument as emptyContextMap,
  serializeDocumentText as serializeContextMap,
} from "@miragon/context-maps-schema-model";
import { emptyDocument, serializeDocument } from "@miragon/team-topologies-schema-model";

import {
  hasTemplate,
  newBpmnXml,
  newCmJson,
  newDmnXml,
  newMarkdownText,
  newOwmText,
  newStormText,
  newTtJson,
  templateFor,
} from "../templates.ts";

test("templateFor: dispatches to the notation's builder, undefined without one", () => {
  assert.equal(templateFor("bpmn", "order", "Order"), newBpmnXml("order", "Order"));
  assert.equal(templateFor("dmn", "rabatt", "Rabatt"), newDmnXml("rabatt", "Rabatt"));
  assert.equal(templateFor("wardley", "map", "Platform Map"), newOwmText("map", "Platform Map"));
  assert.equal(templateFor("team-topology", "teams", "Teams"), newTtJson("teams", "Teams"));
  assert.equal(templateFor("event-storming", "board", "Board"), newStormText("board", "Board"));
  assert.equal(templateFor("context-map", "map", "Map"), newCmJson("map", "Map"));
  assert.equal(templateFor("markdown", "notes", "Notes"), newMarkdownText("notes", "Notes"));
  // value-chain stays git-only until it has a mounted editor (#139 decision)
  assert.equal(templateFor("value-chain", "x", "X"), undefined);
  assert.equal(templateFor("no-such", "x", "X"), undefined);
});

test("hasTemplate mirrors templateFor — it drives the New menu and the create route", () => {
  for (const id of ["bpmn", "dmn", "wardley", "team-topology", "event-storming", "context-map", "markdown"]) {
    assert.equal(hasTemplate(id), true, id);
  }
  // mermaid: withdrawn in 5.5, not in the New menu nor create_model (a
  // diagram is a fence in a Markdown document)
  for (const id of ["value-chain", "mermaid", "no-such"]) assert.equal(hasTemplate(id), false, id);
  // prototype members are NOT templates (the `in`/bare-index bug class):
  // templateFor("toString") used to return "[object Object]" as file content
  for (const id of ["toString", "constructor", "__proto__"]) {
    assert.equal(hasTemplate(id), false, id);
    assert.equal(templateFor(id, "x", "X"), undefined, id);
  }
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
