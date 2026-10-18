/** processIdFromName — the shared title→file-stem slug rule (backend create +
 *  web preview must agree, so the cases here pin the behavior) — and
 *  modelStem, the one path→model-id rule (deep links, todos, discovery). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { byExtension, byId, EDITABLE_EXTENSIONS, modelStem, processIdFromName } from "../index.ts";

test("modelStem: the file stem is the model id", () => {
  assert.equal(modelStem("processes/order.bpmn"), "order");
  assert.equal(modelStem("processes/subprocesses/check-stock.bpmn"), "check-stock");
  assert.equal(modelStem("processes/rabatt.dmn"), "rabatt");
});

test("modelStem: strips the FULL registered compound extension", () => {
  assert.equal(modelStem("processes/supply.vc.json"), "supply");
  assert.equal(modelStem("processes/platform.ttm.json"), "platform");
  assert.equal(modelStem("maps/tea-shop.owm"), "tea-shop");
  assert.equal(modelStem("boards/order-checkout.storm"), "order-checkout");
  assert.equal(modelStem("maps/conference.cm.json"), "conference");
});

test("a diagram is no notation of its own: .mmd and .mermaid are plain repository files", () => {
  // withdrawn in 5.5: a diagram lives as a ```mermaid fence in a document
  assert.equal(byId("mermaid"), undefined);
  assert.equal(byExtension("diagrams/flow.mmd"), undefined);
  assert.equal(byExtension("diagrams/flow.mermaid"), undefined);
  // no live document either: the Live Host opens no room for them
  for (const ext of [".mmd", ".mermaid"]) assert.ok(!EDITABLE_EXTENSIONS.includes(ext), ext);
  // the file that holds diagrams now: a compound name ends in ".md" or it is none
  assert.equal(byExtension("diagrams/flow.md")?.id, "markdown");
  assert.equal(byExtension("notes.mmd.md")?.id, "markdown");
  assert.equal(byExtension("flow.md.mmd"), undefined);
  assert.equal(modelStem("diagrams/flow.mmd"), "flow", "an unregistered suffix: the final dot-suffix goes");
});

test("modelStem: unknown extensions fall back to the final dot-suffix", () => {
  // .md is a REGISTERED extension since markdown became a notation — listed
  // here only because the registered strip and the fallback agree on it
  assert.equal(modelStem("docs/readme.md"), "readme");
  assert.equal(modelStem("processes/rabatt.tests.yaml"), "rabatt.tests");
  assert.equal(modelStem("no-extension"), "no-extension");
});

test("processIdFromName: kebab-cases titles", () => {
  assert.equal(processIdFromName("Order to Cash"), "order-to-cash");
  assert.equal(processIdFromName("  Order   to   Cash  "), "order-to-cash");
  assert.equal(processIdFromName("order-to-cash"), "order-to-cash");
});

test("processIdFromName: transliterates accents and ß", () => {
  assert.equal(processIdFromName("Auftragsprüfung"), "auftragsprufung");
  assert.equal(processIdFromName("Straßen-Ablauf"), "strassen-ablauf");
  assert.equal(processIdFromName("Café Réservation"), "cafe-reservation");
});

test("processIdFromName: collapses punctuation, keeps digits, trims dashes", () => {
  assert.equal(processIdFromName("2nd Level (Support)!"), "2nd-level-support");
  assert.equal(processIdFromName("a__b..c"), "a-b-c");
  assert.equal(processIdFromName("---"), "");
  assert.equal(processIdFromName("!!!"), "");
  assert.equal(processIdFromName(""), "");
});
