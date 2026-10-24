/**
 * The Mermaid text conventions (../mermaid.ts): the code mermaid 12.2's
 * parser reads after its preprocess, the way back from a line of that code to
 * the source line (parse errors count code lines), and the header that names
 * the diagram type. The validator's check of a ```mermaid fence and the web
 * renderer's error notice both stand on these.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MERMAID_DIAGRAM_TYPES,
  mermaidCode,
  mermaidFrontMatterLines,
  mermaidHeader,
  mermaidSourceLine,
} from "../mermaid.ts";

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

test("eventmodeling and agentflow-beta keep their comment lines: mermaid 12 parses them with the code", () => {
  const COMMENTS = "%% one\n%% two\n%% three\n";
  // the line numbers mermaid 12.2 reports for the bad line of each (mermaid-engine.test.ts)
  const EVENTS = "eventmodeling\n\ntf 01 ui CartUI\ntf 02 cmd AddItem\ntf 03 evt ItemAdded\ntf 01 ??? !!!\n";
  const AGENTS = 'agentflow-beta TB\n  brief["Brief"]@{ shape: input }\n\n  brief --> --> ]]\n';
  for (const [diagram, codeLine] of [
    [EVENTS, 6],
    [AGENTS, 4],
  ] as const) {
    assert.equal(mermaidCode(COMMENTS + diagram), COMMENTS + diagram);
    assert.equal(mermaidSourceLine(diagram, codeLine), codeLine);
    assert.equal(mermaidSourceLine(COMMENTS + diagram, codeLine + 3), codeLine + 3);
    // the front matter goes: mermaid counts from the line after it
    assert.equal(mermaidSourceLine(FRONT_MATTER + COMMENTS + diagram, codeLine + 3), codeLine + 8);
    // a directive spanning three lines takes two of them
    const directive = '%%{init: {\n  "wrap": true\n}}%%\n';
    assert.equal(mermaidSourceLine(directive + COMMENTS + diagram, codeLine + 4), codeLine + 6);
    // leading blank lines stay too, and a line a directive emptied is no blank line further down
    assert.equal(mermaidSourceLine(`\n\n%% a\n\n${diagram}`, codeLine + 4), codeLine + 4);
    assert.equal(mermaidSourceLine(`%%{init: {}}%%\n${diagram}`, codeLine + 1), codeLine + 1);
  }
  assert.deepEqual(mermaidHeader(FRONT_MATTER + COMMENTS + EVENTS), {
    line: 9,
    text: "eventmodeling",
    diagramType: "eventmodeling",
  });
  // every other type still parses without them
  const flow = `${COMMENTS}flowchart LR\n  %% the happy path\n  A --> B\n  B -->\n`;
  assert.equal(mermaidCode(flow), "flowchart LR\n  A --> B\n  B -->\n");
  assert.equal(mermaidSourceLine(flow, 3), 7);
  // past mermaid's maxTextSize the comment lines go after all
  const long = `%% ${"x".repeat(50_000)}\n${EVENTS}`;
  assert.equal(mermaidCode(long), EVENTS);
  assert.equal(mermaidSourceLine(long, 6), 7);
});

test("mermaidFrontMatterLines: the lines before the code, as mermaid counts them", () => {
  assert.equal(mermaidFrontMatterLines(FRONT_MATTER), 5);
  assert.equal(mermaidFrontMatterLines(`${FRONT_MATTER}\n\nflowchart LR\n`), 7, "the blank lines after it too");
  assert.equal(mermaidFrontMatterLines("flowchart LR\n---\n"), 0);
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

test("mermaidHeader: another casing names the type only where mermaid draws it, as listed (#283)", () => {
  for (const [text, diagramType] of [
    // the detector and the grammar ignore case
    ["Ishikawa", "ishikawa"],
    ["ISHIKAWA-BETA", "ishikawa-beta"],
    ["iShIkAwA-Beta", "ishikawa-beta"],
    // the detector matches a shorter spelling as written, the grammar ignores case
    ["requirementdiagram", "requirementDiagram"],
    ["stateDiagram-V2", "stateDiagram-v2"],
    ["xychart-BETA", "xychart-beta"],
    ["sankey-Beta", "sankey-beta"],
  ] as const) {
    assert.deepEqual(mermaidHeader(`${text}\n  x`), { line: 1, text, diagramType }, text);
  }
  // the detector reads it, the grammar refuses it; or the detector does not read it at all
  for (const text of [
    "Wardley-beta",
    "RAILROAD-BETA",
    "railroad-EBNF-beta",
    "classDiagram-V2",
    "flowchart-ELK",
    "block-BETA",
    "Requirementdiagram",
    "STATEDIAGRAM-V2",
    "xyChart-beta",
    "SEQUENCEDIAGRAM",
  ]) {
    assert.equal(mermaidHeader(`${text}\n  x`)?.diagramType, undefined, text);
  }
});

test("MERMAID_DIAGRAM_TYPES: unique header keywords, the common ones present", () => {
  assert.equal(new Set(MERMAID_DIAGRAM_TYPES).size, MERMAID_DIAGRAM_TYPES.length);
  // in any casing: a header in another casing names the one it spells
  assert.equal(new Set(MERMAID_DIAGRAM_TYPES.map((t) => t.toLowerCase())).size, MERMAID_DIAGRAM_TYPES.length);
  for (const t of ["flowchart", "graph", "sequenceDiagram", "classDiagram", "erDiagram", "gantt", "mindmap"]) {
    assert.ok(MERMAID_DIAGRAM_TYPES.includes(t), t);
  }
  for (const t of MERMAID_DIAGRAM_TYPES) assert.match(t, /^[A-Za-z][\w-]*$/, t);
  for (const t of MERMAID_DIAGRAM_TYPES) assert.equal(mermaidHeader(`${t}\n`)?.diagramType, t, t);
});
