/**
 * The pure part of the Mermaid renderer (src/lib/mermaid-render.ts): the
 * configuration mermaid is initialised with (safe, the CI look), the element
 * ids of concurrent renders, and how a mermaid error reads for the person
 * typing. mermaid itself needs a DOM and never runs here; the error fixtures
 * have the shapes of mermaid 12.2.0's own messages.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALIASES, FONT_SANS } from "@designiq/ui-kit/lib/tokens";

import {
  describeMermaidError,
  diagramImageRefusal,
  MERMAID_CONFIG,
  MERMAID_LABEL_SANITIZER,
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
  // the look and the layout diagrams had before mermaid 12, as defaults a diagram may change
  assert.equal(MERMAID_CONFIG.look, "classic");
  for (const type of ["flowchart", "class", "state", "er", "requirement"] as const) {
    assert.equal(MERMAID_CONFIG[type].layout, "dagre", type);
  }
  // a top-level layout counts as the user's for every type: a mindmap would leave cose-bilkent
  assert.ok(!("layout" in MERMAID_CONFIG));
  for (const key of ["look", "layout"]) assert.ok(!MERMAID_CONFIG.secure.includes(key), key);
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

test("the mermaid config: a label's HTML loads nothing, and no diagram may hand that back (#290)", () => {
  assert.equal(MERMAID_CONFIG.dompurifyConfig, MERMAID_LABEL_SANITIZER);
  // mermaid's own default stays in
  assert.ok(MERMAID_LABEL_SANITIZER.FORBID_TAGS.includes("style"));
  for (const tag of ["img", "picture", "source", "video", "image", "feimage", "input", "iframe", "object", "embed"]) {
    assert.ok(MERMAID_LABEL_SANITIZER.FORBID_TAGS.includes(tag), tag);
  }
  for (const attribute of ["style", "src", "srcset", "poster", "background"]) {
    assert.ok(MERMAID_LABEL_SANITIZER.FORBID_ATTR.includes(attribute), attribute);
  }
  assert.ok(MERMAID_CONFIG.secure.includes("dompurifyConfig"));
});

/** the kind of refusal a source gets: the first words of its message, undefined when it draws */
const refusal = (source: string): string | undefined =>
  /^(A shape's image|An actor's icon|An actor's details|CSS that loads)/.exec(
    diagramImageRefusal(source)?.message ?? "",
  )?.[1];

test("diagramImageRefusal: a shape's img or an actor's icon draws only from inline data (#290)", () => {
  const shape = diagramImageRefusal(
    'flowchart LR\n  A --> B\n  B@{ img: "https://tracker.example/a.png", label: "x" }',
  );
  assert.equal(shape?.line, 3);
  assert.match(shape?.message ?? "", /^A shape's image \(img\) is not drawn/);
  for (const source of [
    "flowchart LR\n  A@{ shape: image, img: //tracker.example/a.png }",
    'flowchart LR\n  A@{ "img": "https://tracker.example/a.png" }',
    'flowchart LR\n  A@{"img":"https://tracker.example/a.png"}',
    "flowchart LR\n  A@{\n    label: x\n    IMG: https://tracker.example/a.png\n  }",
    'flowchart LR\n  A@{ label: "}", img: "https://tracker.example/a.png" }',
    'flowchart LR\n  A@{ "\\x69mg": "https://tracker.example/a.png" }',
    "flowchart LR\n  A@{ label: &k img, *k : https://tracker.example/a.png }",
    "flowchart LR\n  A@{\n    ? img\n    : https://tracker.example/a.png\n  }",
    'flowchart LR\n  A@{ label: "a\\" , img: \\"x", img: "https://tracker.example/a.png" }',
    'flowchart LR\n  A@{ img: "data:image/png;base64,AAAA", img: "https://tracker.example/a.png" }',
  ]) {
    assert.equal(refusal(source), "A shape's image", source);
  }
  const icon = diagramImageRefusal(
    'sequenceDiagram\n  participant A\n  properties A: {"class": "x", "icon": "https://tracker.example/i.png"}',
  );
  assert.equal(icon?.line, 3);
  assert.match(icon?.message ?? "", /^An actor's icon is not drawn/);
  for (const source of [
    'sequenceDiagram\n  participant A; properties A: {"icon": "//tracker.example/i.png"}',
    'sequenceDiagram\n  properties A: {"\\u0069con": "https://tracker.example/i.png"}',
    'sequenceDiagram\n  properties A: {"icon": "@clock", "icon": "https://tracker.example/i.png"}',
  ]) {
    assert.equal(refusal(source), "An actor's icon", source);
  }
  // inline data and the diagram's own symbols load nothing: they draw
  for (const source of [
    "flowchart LR\n  A --> B",
    'flowchart LR\n  A@{ shape: rounded, label: "Order" }\n  e1@{ animate: true }',
    'flowchart LR\n  A@{ img: "data:image/png;base64,AAAA", label: "x" }',
    'sequenceDiagram\n  participant A\n  properties A: {"class": "internal-service-actor", "icon": "@clock"}',
    'sequenceDiagram\n  properties A: {"icon": "data:image/png;base64,AAAA"}',
  ]) {
    assert.equal(diagramImageRefusal(source), undefined, source);
  }
});

test("diagramImageRefusal: an actor's details, and an icon that markup, an entity or a prototype spells (#290)", () => {
  // details reads the actor's properties as JSON from an element of the page:
  // a heading of the document is one (its id md-<slug>, its HTML the text)
  const details = diagramImageRefusal(
    "sequenceDiagram\n  participant A\n  details A: md-propertiesicontrackerexampledetails-iconpng\n  A->>A: hi",
  );
  assert.equal(details?.line, 3);
  assert.match(details?.message ?? "", /^An actor's details are not drawn/);
  for (const source of [
    "sequenceDiagram\n  participant A; details A: md-x",
    "sequenceDiagram\n  DETAILS A: md-x",
    "sequenceDiagram\n  loop x\n    A->>A: hi\n  end details A: md-x",
    '---\ntitle: T\n---\n%%{init: {"wrap": true}}%%\nsequenceDiagram\n  A->>A: hi;%%{init: {}}%%details A: md-x',
  ]) {
    assert.equal(refusal(source), "An actor's details", source);
  }
  // mermaid hands the JSON to DOMPurify first: a comment, a dropped tag or an
  // entity in a key ends up as "icon"; a second statement copies __proto__
  for (const source of [
    'sequenceDiagram\n  properties A: {"ic<!---->on": "https://tracker.example/i.png"}',
    'sequenceDiagram\n  properties A: {"ic<style></style>on": "https://tracker.example/i.png"}',
    'sequenceDiagram\n  properties A: {"&#105;con": "https://tracker.example/i.png"}',
    'sequenceDiagram\n  properties A: {"class": "x"}\n  properties A: {"__proto__": {"icon": "https://tracker.example/i.png"}}',
    'sequenceDiagram\n  loop x\n    A->>A: hi\n  end properties A: {"icon": "https://tracker.example/i.png"}',
  ]) {
    assert.equal(refusal(source), "An actor's icon", source);
  }
});

test("diagramImageRefusal: CSS that fetches, in any diagram type, escaped or not (#290)", () => {
  const state =
    "stateDiagram-v2\n  classDef bad background-image:url(https://tracker.example/state.png)\n  [*] --> S1\n  class S1 bad";
  const css = diagramImageRefusal(state);
  assert.equal(css?.line, 2);
  assert.match(
    css?.message ?? "",
    /^CSS that loads from an address \(url\(\), image-set\(\) or @import\) is not drawn/,
  );
  for (const source of [
    "block-beta\n  a b\n  classDef blue background-image:url(https://tracker.example/block.png)\n  class a blue",
    state.replace("url(", "u\\72l("),
    state.replace("url(", "\\75 rl("),
    state.replace("url(", "U\\RL("),
    state.replace("url(https://tracker.example/state.png)", 'image-set("https://tracker.example/state.png" 1x)'),
    state.replace("url(https://tracker.example/state.png)", '-webkit-image-set("https://tracker.example/s.png" 1x)'),
    state.replace("url(", "src("),
    state.replace("background-image:url", "border-image:url"),
    state.replace("background-image:url", "mask-image:url"),
    state.replace("background-image:url", "list-style-image:url"),
    state.replace("background-image:url(https://tracker.example/state.png)", '@import "https://tracker.example/s.css"'),
    state.replace(
      "background-image:url(https://tracker.example/state.png)",
      '@\\69mport "https://tracker.example/s.css"',
    ),
    'C4Context\n  Person(a, "A")\n  Person(b, "B")\n  Rel(a, b, "uses")\n  UpdateRelStyle(a, b, $lineColor="url(https://tracker.example/c4.png)")',
    // a label's HTML is decoded while mermaid lays it out; the drawn SVG decodes the rest
    "flowchart LR\n  A[\"<svg><rect mask='url&lpar;https://tracker.example/m.svg#m)'/></svg> x\"] --> B",
    state.replace("url(", "u&bsol;72l("),
    state.replace("url(", "url&#40;"),
    state.replace("url(", "url#40;"),
    '---\nconfig:\n  sankey:\n    linkColor: "url(https://tracker.example/s.png)"\n---\nsankey-beta\na,b,1',
  ]) {
    assert.equal(refusal(source), "CSS that loads", source);
  }
  // a reference within the diagram, a TeX parenthesis or a path is no fetch
  for (const source of [
    "stateDiagram-v2\n  classDef g fill:url(#grad)\n  [*] --> S1\n  class S1 g",
    "flowchart LR\n  A --> B\n  classDef hot fill:#f96,stroke:#333\n  class A hot",
    'flowchart LR\n  A["$$\\left( \\frac{a}{b} \\right)$$"] --> B',
    'flowchart LR\n  A["C:\\Program Files (x86)\\app"] --> B',
    "flowchart LR\n  A[Pick a curl(1) flag] --> B",
  ]) {
    assert.equal(diagramImageRefusal(source), undefined, source);
  }
});

test("diagramImageRefusal: a word in a label or a message is no statement (#290)", () => {
  for (const source of [
    "flowchart LR\n  A[Edit the properties of an icon] --> B[Save]",
    "sequenceDiagram\n  A->>B: load properties from Silicon Valley office\n  B-->>A: ok",
    'flowchart LR\n  A@{ shape: rect, label: "Resize img" } --> B',
    "flowchart LR\n  A@{ shape: rect, label: 'Crop img' } --> B",
    "flowchart LR\n  A@{ shape: rect, label: Resize img } --> B",
    'flowchart LR\n  A@{\n    shape: rect\n    label: "Resize img"\n  }',
    'flowchart LR\n  A@{ label: "C:\\\\temp\\\\file", shape: rect }',
    "classDiagram\n  class Icon {\n    +properties Map\n    +lexicon String\n  }",
    "sequenceDiagram\n  A->>B: Fetch details for customer: 42",
    'sequenceDiagram\n  A->>B: hi\n  Note over A: properties A: {"icon": "x"}',
    "sequenceDiagram\n  loop details for each item: x\n    A->>B: hi\n  end",
    "sequenceDiagram\n  participant A as Order details: x\n  A->>A: hi",
    'sequenceDiagram\n  participant A\n  properties A: {"class": "icon"}\n  A->>A: hi',
    "flowchart LR\n  A[Show details X: y] --> B",
  ]) {
    assert.equal(diagramImageRefusal(source), undefined, source);
  }
});
