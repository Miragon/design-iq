/**
 * The pure part of the Mermaid renderer (src/lib/mermaid-render.ts): the
 * configuration mermaid is initialised with (safe, the CI look), the element
 * ids of concurrent renders, and how a mermaid error reads for the person
 * typing. mermaid itself needs a DOM and never runs here; the error fixtures
 * are mermaid 11.17.2's own messages.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALIASES, FONT_SANS } from "@designiq/ui-kit/lib/tokens";

import {
  describeMermaidError,
  MERMAID_CONFIG,
  MERMAID_THEME_VARIABLES,
  mermaidRenderId,
} from "../src/lib/mermaid-render.ts";

const HEX = /^#[0-9a-f]{6}$/i;
const ALIAS_VALUES = new Set<string>(Object.values(ALIASES));

test("the mermaid config: strict, never auto-started, its own errors drawn by the caller", () => {
  assert.equal(MERMAID_CONFIG.securityLevel, "strict");
  assert.equal(MERMAID_CONFIG.startOnLoad, false);
  assert.equal(MERMAID_CONFIG.suppressErrorRendering, true);
  assert.equal(MERMAID_CONFIG.theme, "base");
  assert.equal(MERMAID_CONFIG.themeVariables, MERMAID_THEME_VARIABLES);
  // a diagram's front matter or %%{init}%% sets none of these (mermaid-engine.test.ts
  // checks it against mermaid itself): its own secure list, then the look
  for (const key of ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges"]) {
    assert.ok(MERMAID_CONFIG.secure.includes(key), key);
  }
  for (const key of ["theme", "themeVariables", "themeCSS", "darkMode", "fontFamily", "altFontFamily"]) {
    assert.ok(MERMAID_CONFIG.secure.includes(key), key);
  }
});

test("the mermaid theme: Geist and literal colours from the CI tokens, nothing else", () => {
  assert.equal(MERMAID_CONFIG.fontFamily, FONT_SANS);
  assert.equal(MERMAID_THEME_VARIABLES.fontFamily, FONT_SANS);
  assert.equal(MERMAID_THEME_VARIABLES.darkMode, false);
  const colours = Object.entries(MERMAID_THEME_VARIABLES).filter(([key]) => key !== "fontFamily" && key !== "darkMode");
  assert.ok(colours.length > 10);
  for (const [key, value] of colours) {
    // mermaid parses these to derive its shades: a var(--…) would not parse
    assert.match(String(value), HEX, key);
    assert.ok(ALIAS_VALUES.has(String(value)), `${key} is not a token alias`);
  }
  // the nodes are the canvas set every diagram engine of the app draws with
  assert.equal(MERMAID_THEME_VARIABLES.primaryColor, ALIASES["canvas-shape"]);
  assert.equal(MERMAID_THEME_VARIABLES.primaryBorderColor, ALIASES["canvas-stroke"]);
  assert.equal(MERMAID_THEME_VARIABLES.primaryTextColor, ALIASES["canvas-label"]);
});

test("mermaidRenderId: a fresh CSS id per render, named after its surface", () => {
  // two surfaces may render the same text at once: ONE sequence across
  // them, so not even equal prefixes collide
  const ids = Array.from({ length: 50 }, (_, i) => mermaidRenderId(i % 2 ? "mermaid-a" : "mermaid-b"));
  assert.equal(new Set(ids).size, ids.length, "two renders never share an id");
  for (const id of ids) assert.match(id, /^mermaid-(a|b)-\d+$/);
  assert.notEqual(mermaidRenderId("mermaid-a"), mermaidRenderId("mermaid-a"));
  // anything that is no CSS identifier becomes "-", and it starts with a letter
  assert.match(mermaidRenderId("md fence #2"), /^md-fence--2-\d+$/);
  assert.match(mermaidRenderId("1st"), /^st-\d+$/);
  assert.match(mermaidRenderId(""), /^mermaid-\d+$/);
});

/** a jison parse error as mermaid throws it: the message plus the parser's hash */
const jisonError = (message: string, firstLine: number): Error =>
  Object.assign(new Error(message), { hash: { loc: { first_line: firstLine } } });

test("describeMermaidError: a jison parse error, at its SOURCE line, without the lead", () => {
  // mermaid counts the lines after the front matter: line 4 of the code is
  // line 7 of the file
  const source =
    '---\ntitle: "Flow"\n---\nflowchart LR\n  start([Start]) --> work[Do the work]\n  work --> done([Done])\n  done -->\n';
  const error = jisonError(
    "Parse error on line 4:\n...work --> done([Done])  done -->\n--------------------------^\nExpecting 'AMP', 'ALPHA', got 'EOF'",
    4,
  );
  assert.deepEqual(describeMermaidError(error, source), {
    line: 7,
    message: "...work --> done([Done])  done -->\n--------------------------^\nExpecting 'AMP', 'ALPHA', got 'EOF'",
  });
  // the parser's loc wins over the message's own (late at the end of the text)
  const sequence = "sequenceDiagram\n  A->>B: hi\n  B-->>\n";
  const late = jisonError(
    "Parse error on line 4:\n...  A->>B: hi  B-->>\n---------------------^\nExpecting '+', '-', '()', 'ACTOR', got 'NEWLINE'",
    3,
  );
  assert.equal(describeMermaidError(late, sequence).line, 3);
});

test("describeMermaidError: a langium error names its line in the message", () => {
  const source = '%% c\npie title Pets\n  "Dogs" : 3\n  "Cats" x\n';
  const error = new Error(
    "Parsing failed: Lexer error on line 3, column 10: unexpected character: ->x<- at offset: 37, skipped 1 characters.",
  );
  assert.deepEqual(describeMermaidError(error, source), {
    line: 4,
    message: "unexpected character: ->x<- at offset: 37, skipped 1 characters.",
  });
});

test("describeMermaidError: no diagram type names the line that should have named one", () => {
  const unknown = new Error("No diagram type detected matching given configuration for text: flowchrt LR\n A --> B");
  assert.deepEqual(describeMermaidError(unknown, "%% notes\nflowchrt LR\n A --> B"), {
    line: 2,
    message: '"flowchrt" is not a Mermaid diagram type. Start with one, for example flowchart LR.',
  });
  const empty = new Error("No diagram type detected matching given configuration for text: ");
  assert.deepEqual(describeMermaidError(empty, ""), {
    message: "The diagram is empty. Start it with a diagram type, for example flowchart LR.",
  });
});

test("describeMermaidError: anything else keeps its message, without a line", () => {
  assert.deepEqual(describeMermaidError(new Error("Cannot read properties of undefined"), "graph TD"), {
    message: "Cannot read properties of undefined",
  });
  assert.deepEqual(describeMermaidError("boom", "graph TD"), { message: "boom" });
  assert.deepEqual(describeMermaidError(new Error(""), "graph TD"), { message: "The diagram could not be drawn." });
});
