/**
 * The Mermaid text conventions (../mermaid.ts): the code mermaid 11.17's
 * parser reads after its preprocess, the way back from a line of that code to
 * the source line (parse errors count code lines), and the header that names
 * the diagram type. The validator's check of a ```mermaid fence and the web
 * renderer's error notice both stand on these.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MERMAID_DIAGRAM_TYPES, mermaidCode, mermaidHeader, mermaidSourceLine } from "../mermaid.ts";

const FRONT_MATTER = '---\ntitle: "Order Flow"\nconfig:\n  look: classic\n---\n';
/** a titled flowchart, its title in the front matter */
const FLOW = '---\ntitle: "Flow"\n---\nflowchart LR\n  start([Start]) --> work[Do the work]\n  work --> done([Done])\n';

test("mermaidCode: front matter, directives and comment lines go, like in mermaid's preprocess", () => {
  assert.equal(mermaidCode(`${FRONT_MATTER}flowchart LR\n  A --> B\n`), "flowchart LR\n  A --> B\n");
  // a directive (even over several lines) and the comment lines
  const source =
    '%%{init: {\n  "theme": "forest"\n}}%%\n%% the order flow\nflowchart LR\n  %% the happy path\n  A --> B\n';
  assert.equal(mermaidCode(source), "flowchart LR\n  A --> B\n");
  // CRLF reads as LF, and the leading blank lines go
  assert.equal(mermaidCode("\r\n\r\n  graph TD\r\n  A-->B"), "graph TD\n  A-->B");
  // a bare "%%" is no comment line to the preprocess (mermaid's detector skips it)
  assert.equal(mermaidCode("%%\ngraph TD"), "%%\ngraph TD");
});

test("mermaidSourceLine: a line of the parsed code back in the source", () => {
  // after a front matter: line 3 of the code (work --> done) is line 6 of the text
  assert.equal(mermaidSourceLine(FLOW, 1), 4);
  assert.equal(mermaidSourceLine(FLOW, 3), 6);
  // comment lines anywhere shift the count, and repeated lines stay in order
  const source = "%% header\nflowchart LR\n  A --> B\n  %% one\n  %% two\n  A --> B\n  B -->\n";
  assert.equal(mermaidSourceLine(source, 1), 2);
  assert.equal(mermaidSourceLine(source, 2), 3);
  assert.equal(mermaidSourceLine(source, 3), 6, "the second 'A --> B', not the first");
  assert.equal(mermaidSourceLine(source, 4), 7);
  // a YAML line equal to a diagram line is never taken for it
  const shadowed = "---\ntitle: x\n---\npie\n  title x\n";
  assert.equal(mermaidSourceLine(shadowed, 1), 4);
  // tag attributes are rewritten by the preprocess, the line still maps
  assert.equal(mermaidSourceLine('graph TD\n%% c\n  A["<b class="x">A</b>"] --> B\n', 2), 3);
  // past the end (mermaid reports EOF errors a line or two late): the last line
  assert.equal(mermaidSourceLine("graph TD\n  A -->", 9), 2);
  assert.equal(mermaidSourceLine("", 1), 1);
});

test("mermaidHeader: the first meaningful line names the diagram type", () => {
  assert.deepEqual(mermaidHeader(FLOW), {
    line: 4,
    text: "flowchart LR",
    diagramType: "flowchart",
  });
  assert.deepEqual(mermaidHeader("%% notes\n\n%%\nsequenceDiagram\n  A->>B: hi"), {
    line: 4,
    text: "sequenceDiagram",
    diagramType: "sequenceDiagram",
  });
  // the longer spelling wins where one type is a prefix of another
  assert.equal(mermaidHeader("stateDiagram-v2\n  [*] --> A")?.diagramType, "stateDiagram-v2");
  assert.equal(mermaidHeader("flowchart-elk TD\n  A --> B")?.diagramType, "flowchart-elk");
  assert.equal(mermaidHeader("gitGraph TB:\n  commit")?.diagramType, "gitGraph");
  assert.equal(mermaidHeader("graph TD;\n  A-->B;")?.diagramType, "graph");
  assert.equal(mermaidHeader('pie title Pets\n  "Dogs" : 3')?.diagramType, "pie");
  // a type is a whole word: no typo, no glued direction, no external plugin
  for (const text of ["flowchrt LR", "graphTD", "Flowchart LR", "zenuml", "architecture", "A --> B"]) {
    const header = mermaidHeader(`${text}\n  x`);
    assert.equal(header?.diagramType, undefined, text);
    assert.equal(header?.line, 1, text);
  }
  // nothing to name a type: empty, blank, only front matter and comments
  for (const source of ["", "\n  \n", `${FRONT_MATTER}%% later\n`, "%%{init: {}}%%\n"]) {
    assert.equal(mermaidHeader(source), undefined, JSON.stringify(source));
  }
});

test("MERMAID_DIAGRAM_TYPES: unique header keywords, the common ones present", () => {
  assert.equal(new Set(MERMAID_DIAGRAM_TYPES).size, MERMAID_DIAGRAM_TYPES.length);
  for (const t of ["flowchart", "graph", "sequenceDiagram", "classDiagram", "erDiagram", "gantt", "mindmap"]) {
    assert.ok(MERMAID_DIAGRAM_TYPES.includes(t), t);
  }
  for (const t of MERMAID_DIAGRAM_TYPES) assert.match(t, /^[A-Za-z][\w-]*$/, t);
  for (const t of MERMAID_DIAGRAM_TYPES) assert.equal(mermaidHeader(`${t}\n`)?.diagramType, t, t);
});
