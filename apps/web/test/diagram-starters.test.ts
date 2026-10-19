/**
 * The starter diagrams of "Insert diagram" (src/notations/markdown/
 * diagram-starters.ts) against the real mermaid apps/web pins, under jsdom,
 * and against the validator: every starter parses, inserted into a document
 * it passes the validator's check of the document's diagrams without a
 * finding, and the validator's fence scanner reads it as the mermaid fence
 * it is. A mermaid bump that breaks a starter fails here. Its own process
 * (node --test runs one per file) keeps the DOM globals mermaid expects away
 * from the other suites, as in mermaid-engine.test.ts.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";

import { markdownFences } from "@designiq/notations/markdown";
import { MERMAID_DIAGRAM_TYPES, mermaidHeader } from "@designiq/notations/mermaid";
import { checkModel } from "@miragon/design-iq-validator";
import { JSDOM } from "jsdom";
import type { Mermaid } from "mermaid";

import { DIAGRAM_STARTERS } from "../src/notations/markdown/diagram-starters.ts";
import { planDiagramInsertion } from "../src/notations/markdown/insert-diagram.ts";

let mermaid: Mermaid;

before(async () => {
  const { window } = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "Element", "HTMLElement", "SVGElement", "DOMParser"]) {
    if (!(key in globalThis)) {
      Object.defineProperty(globalThis, key, {
        value: (window as unknown as Record<string, unknown>)[key],
        configurable: true,
        writable: true,
      });
    }
  }
  const { loadMermaid } = await import("../src/lib/mermaid-render.ts");
  mermaid = await loadMermaid();
});

/** a document to insert into: the cursor in the middle of its paragraph */
const DOCUMENT = "# Order to cash\n\nHow an order becomes cash.\n\n## Steps\n";
const CURSOR = { line: 3, column: 8 };

/** the document with `body` inserted as "Insert diagram" does it */
function inserted(body: string, select?: string): { source: string; fenceLine: number } {
  const insertion = planDiagramInsertion(DOCUMENT, CURSOR, { body, select });
  const lines = DOCUMENT.split("\n");
  const offset = lines.slice(0, insertion.at.line - 1).reduce((n, line) => n + line.length + 1, 0);
  const at = offset + insertion.at.column - 1;
  return { source: DOCUMENT.slice(0, at) + insertion.text + DOCUMENT.slice(at), fenceLine: insertion.fenceLine };
}

test("the starters have their own ids, a label, a description and a label to select on one line", () => {
  assert.ok(DIAGRAM_STARTERS.length >= 7);
  assert.equal(new Set(DIAGRAM_STARTERS.map((s) => s.id)).size, DIAGRAM_STARTERS.length);
  for (const starter of DIAGRAM_STARTERS) {
    assert.match(starter.id, /^[a-z0-9-]+$/, starter.id);
    assert.ok(starter.label && starter.description, starter.id);
    assert.ok(starter.body.endsWith("\n"), `${starter.id}: every line ends with a line break`);
    assert.ok(!starter.body.includes("```"), `${starter.id}: nothing in it closes the fence`);
    assert.ok(starter.select && !starter.select.includes("\n"), starter.id);
    assert.ok(starter.body.includes(starter.select), `${starter.id}: '${starter.select}' is in the diagram`);
  }
});

test("every starter parses with the mermaid apps/web pins", async () => {
  for (const starter of DIAGRAM_STARTERS) {
    await assert.doesNotReject(mermaid.parse(starter.body), starter.id);
  }
  // and the check bites: a broken diagram does not parse
  await assert.rejects(mermaid.parse("flowchart LR\n  a[Start] -->\n"));
});

test("a Gantt starter's tasks start after tasks it has (mermaid starts one after a missing task today)", () => {
  for (const starter of DIAGRAM_STARTERS.filter((s) => mermaidHeader(s.body)?.diagramType === "gantt")) {
    const ids = new Set([...starter.body.matchAll(/:\s*(?:milestone,\s*)?([A-Za-z][\w-]*),/g)].map((m) => m[1]));
    for (const [, id] of starter.body.matchAll(/after ([\w-]+)/g)) assert.ok(ids.has(id), `${starter.id}: after ${id}`);
  }
});

test("inserted into a document, every starter passes the validator's check of its diagrams", () => {
  for (const starter of DIAGRAM_STARTERS) {
    const header = mermaidHeader(starter.body);
    assert.ok(header?.diagramType && MERMAID_DIAGRAM_TYPES.includes(header.diagramType), starter.id);
    const { source } = inserted(starter.body, starter.select);
    assert.deepEqual(checkModel(source, { path: "docs/order-to-cash.md" }), [], starter.id);
  }
  // and the check bites: a diagram whose first line names no type is warned about
  const findings = checkModel(inserted("flowchrt LR\n  a --> b\n").source, { path: "docs/order-to-cash.md" });
  assert.deepEqual(
    findings?.map((f) => [f.severity, f.ruleId]),
    [["WARN", "mermaid/diagram-type"]],
  );
});

test("the validator's fence scanner finds every inserted starter as a mermaid fence", () => {
  for (const starter of DIAGRAM_STARTERS) {
    const { source, fenceLine } = inserted(starter.body, starter.select);
    const fences = markdownFences(source);
    assert.equal(fences.length, 1, starter.id);
    assert.deepEqual(
      { line: fences[0]!.line, lang: fences[0]!.lang, content: fences[0]!.content, closed: fences[0]!.closed },
      { line: fenceLine, lang: "mermaid", content: starter.body, closed: true },
      starter.id,
    );
  }
});
