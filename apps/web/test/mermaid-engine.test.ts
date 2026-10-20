/**
 * The real mermaid engine (apps/web's pin) behind lib/mermaid-render.ts, under
 * jsdom: what the app's configuration means once mermaid applies it, and
 * whether @designiq/notations/mermaid (the validator's reading of a diagram)
 * still mirrors the mermaid the app draws with.
 * mermaid parses and configures without a layout engine; drawing needs one,
 * so the drawn output is covered with a fake renderer elsewhere
 * (markdown-mermaid.test.ts). Here every label measures one fixed box, enough
 * to compare two drawings of the same diagram (drawing()). Its own process
 * (node --test runs one per file) keeps the DOM globals mermaid expects away
 * from the other suites.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

import { MERMAID_DIAGRAM_TYPES, MERMAID_VERSION, mermaidHeader } from "@designiq/notations/mermaid";
import { ALIASES, FONT_SANS } from "@designiq/ui-kit/lib/tokens";
import { JSDOM } from "jsdom";
import type { Mermaid } from "mermaid";

import { describeMermaidError } from "../src/lib/mermaid-render.ts";

let mermaid: Mermaid;

/** jsdom has no CSSStyleSheet; mermaid builds a diagram's classDef rules in one */
class StyleSheetStub {
  cssRules: { cssText: string }[] = [];
  insertRule(rule: string, index: number): number {
    this.cssRules.splice(index, 0, { cssText: rule });
    return index;
  }
  replaceSync(text: string): void {
    this.cssRules = [{ cssText: text }];
  }
}

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
  if (!("CSSStyleSheet" in globalThis)) Object.assign(globalThis, { CSSStyleSheet: StyleSheetStub });
  Object.assign(window.SVGElement.prototype, {
    getBBox: () => ({ x: 0, y: 0, width: 40, height: 16 }),
    getComputedTextLength: () => 40,
  });
  const { loadMermaid } = await import("../src/lib/mermaid-render.ts");
  mermaid = await loadMermaid();
  // the first parse registers mermaid's diagram detectors (detectType needs them)
  await mermaid.parse("flowchart LR\n  A --> B\n");
});

/** the configuration mermaid draws a source with: parse applies its front
 *  matter and directives on top of the app's (the global part: mermaid 12
 *  resolves the look, theme and layout of a diagram type only while it
 *  parses or draws one, see drawing()) */
async function configFor(source: string) {
  await mermaid.parse(source);
  return mermaid.mermaidAPI.getConfig();
}

let drawings = 0;

/** what a drawing of a source shows: the looks its shapes are drawn in,
 *  where its nodes sit, and its style sheet (the render's own id taken out) */
async function drawing(source: string) {
  const id = `drawing-${++drawings}`;
  const { svg } = await mermaid.render(id, source);
  return {
    looks: [...new Set([...svg.matchAll(/<g [^>]*\bdata-look="([^"]*)"/g)].map((m) => m[1]))],
    layout: [...svg.matchAll(/<g class="node [^>]*\btransform="([^"]*)"/g)].map((m) => m[1]),
    style: (/<style>(.*?)<\/style>/s.exec(svg)?.[1] ?? "").replaceAll(id, "ID"),
  };
}

/** what drawing a source fails with, as the app draws it */
async function drawingError(source: string): Promise<unknown> {
  try {
    await mermaid.render(`drawing-${++drawings}`, source);
  } catch (error) {
    return error;
  }
  return assert.fail(`${JSON.stringify(source)} draws`);
}

test("an error names the line it is on, whatever comment lines stand above it", async () => {
  // mermaid 12 parses eventmodeling and agentflow-beta with their comment
  // lines, every other type without them
  const diagrams: [diagram: string, onTheBadLine: string][] = [
    ["eventmodeling\n\ntf 01 ui CartUI\ntf 02 cmd AddItem\ntf 01 ??? !!!\ntf 03 evt Done\n", "tf 01 ???"],
    ['agentflow-beta TB\n  brief["Brief"]@{ shape: input }\n\n  brief --> --> ]]\n', "brief --> -->"],
    // agentflow's own error in an @{…} block
    ['agentflow-beta TB\n  brief["Brief"]@{ shape: input }\n  draft["Draft"]@{ shape: nosuchshape }\n', "nosuchshape"],
    ['pie title Pets\n  "Dogs" : 3\n  "Cats" x\n', '"Cats" x'],
    ["flowchart LR\n  A --> B\n  B --> -->\n  B --> C\n", "B --> -->"],
  ];
  const heads = [
    "",
    "%% one\n%% two\n%% three\n",
    "---\ntitle: Orders\n---\n%% one\n%% two\n",
    '%%{init: {\n  "wrap": true\n}}%%\n%% one\n',
  ];
  for (const [diagram, bad] of diagrams) {
    for (const head of heads) {
      const source = head + diagram;
      const { line } = describeMermaidError(await drawingError(source), source);
      assert.equal(line, source.split("\n").findIndex((l) => l.includes(bad)) + 1, JSON.stringify(source));
    }
  }
});

test("a diagram cannot leave the CI look: no other theme, palette, CSS or font", async () => {
  const sources = [
    '%%{init: {"theme": "dark", "themeCSS": ".node rect { fill: url(https://example.invalid/t.png) }", ' +
      '"fontFamily": "Comic Sans MS", "darkMode": true, "themeVariables": {"primaryColor": "#1f2020"}}}%%\n' +
      "flowchart LR\n  A --> B\n",
    "---\nconfig:\n  theme: forest\n  themeCSS: '.node rect { fill: red }'\n  fontFamily: Papyrus\n" +
      "  themeVariables:\n    primaryColor: '#ff0000'\n    darkMode: true\n---\nflowchart LR\n  A --> B\n",
    // mermaid 12 lets a config scope its theme to one diagram type
    '%%{init: {"flowchart": {"theme": "dark", "themeCSS": ".node rect { fill: red }"}}}%%\nflowchart LR\n  A --> B\n',
    "---\nconfig:\n  flowchart:\n    theme: dark\n  sequence:\n    theme: forest\n---\nflowchart LR\n  A --> B\n",
  ];
  for (const source of sources) {
    const config = await configFor(source);
    assert.equal(config.theme, "base", source);
    assert.equal(config.themeCSS, undefined, source);
    assert.equal(config.fontFamily, FONT_SANS, source);
    assert.equal(config.securityLevel, "strict", source);
    assert.equal(config.themeVariables?.primaryColor, ALIASES["canvas-shape"], source);
    assert.equal(config.themeVariables?.darkMode, false, source);
    assert.ok(!["dark", "forest"].includes(config.flowchart?.theme ?? ""), source);
    assert.ok(!["dark", "forest"].includes(config.sequence?.theme ?? ""), source);
  }
  // and drawn, a diagram type's own theme changes nothing
  const flow = "flowchart LR\n  A --> B\n";
  assert.equal(
    (await drawing(`---\nconfig:\n  flowchart:\n    theme: dark\n---\n${flow}`)).style,
    (await drawing(flow)).style,
  );
});

test("layout stays the author's: a directive may still set the look and the wrapping", async () => {
  const config = await configFor(
    '---\nconfig:\n  look: handDrawn\n---\n%%{init: {"wrap": true}}%%\nflowchart LR\n A --> B\n',
  );
  assert.equal(config.look, "handDrawn");
  assert.equal(config.wrap, true);
  assert.equal(config.theme, "base");
});

test("a diagram draws as before mermaid 12 until it asks otherwise: the classic look, laid out by dagre", async () => {
  const flow = "flowchart LR\n  A[Order received] --> B{In stock?}\n  B --> C[Ship]\n  B --> D[Reorder]\n  D --> C\n";
  const plain = await drawing(flow);
  assert.deepEqual(plain.looks, ["classic"]);
  assert.deepEqual(plain.layout, (await drawing(`---\nconfig:\n  layout: dagre\n---\n${flow}`)).layout);
  for (const source of [
    "classDiagram\n  Customer --> Order\n",
    "stateDiagram-v2\n  [*] --> Placed\n  Placed --> [*]\n",
    "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n",
  ]) {
    assert.deepEqual((await drawing(source)).looks, ["classic"], source);
  }
  // mermaid 12's own defaults stay the author's to pick
  assert.deepEqual((await drawing(`---\nconfig:\n  look: neo\n---\n${flow}`)).looks, ["neo"]);
  assert.notDeepEqual((await drawing(`---\nconfig:\n  layout: elk\n---\n${flow}`)).layout, plain.layout);
  // and a diagram type with a layout of its own keeps it
  const lanes = "swimlane-beta LR\n  subgraph L1\n    a --> b\n  end\n  subgraph L2\n    c\n  end\n  b --> c\n";
  assert.deepEqual(
    (await drawing(lanes)).layout,
    (await drawing(`---\nconfig:\n  layout: swimlane\n---\n${lanes}`)).layout,
  );
});

test("@designiq/notations/mermaid mirrors the mermaid apps/web pins", () => {
  // a bump (Dependabot groups every minor) fails here until the list and the
  // preprocess patterns are re-read against the new release
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies.mermaid, MERMAID_VERSION);
  const installed = JSON.parse(
    readFileSync(new URL("../node_modules/mermaid/package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(installed.version, MERMAID_VERSION);
});

test("every diagram type the validator knows is one mermaid detects", () => {
  for (const type of MERMAID_DIAGRAM_TYPES) {
    const source = `${type}\n  x\n`;
    assert.equal(mermaidHeader(source)?.diagramType, type, type);
    assert.doesNotThrow(() => mermaid.detectType(source), type);
  }
  // and a type the list leaves out is one mermaid does not draw either
  for (const text of ["zenuml", "flowchrt LR", "Flowchart LR"]) {
    assert.throws(() => mermaid.detectType(`${text}\n  x\n`), /No diagram type detected/, text);
  }
});
