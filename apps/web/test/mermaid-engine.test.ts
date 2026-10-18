/**
 * The real mermaid engine (apps/web's pin) behind lib/mermaid-render.ts, under
 * jsdom: what the app's configuration means once mermaid applies it, and
 * whether @designiq/notations/mermaid (the validator's reading of a diagram)
 * still mirrors the mermaid the app draws with.
 * mermaid parses and configures without a layout engine; drawing needs one,
 * so the drawn output is covered with a fake renderer elsewhere
 * (markdown-mermaid.test.ts). Its own process (node --test runs one per file)
 * keeps the DOM globals mermaid expects away from the other suites.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

import { MERMAID_DIAGRAM_TYPES, MERMAID_VERSION, mermaidHeader } from "@designiq/notations/mermaid";
import { ALIASES, FONT_SANS } from "@designiq/ui-kit/lib/tokens";
import { JSDOM } from "jsdom";
import type { Mermaid } from "mermaid";

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
  // the first parse registers mermaid's diagram detectors (detectType needs them)
  await mermaid.parse("flowchart LR\n  A --> B\n");
});

/** the configuration mermaid draws a source with: parse applies its front
 *  matter and directives on top of the app's */
async function configFor(source: string) {
  await mermaid.parse(source);
  return mermaid.mermaidAPI.getConfig();
}

test("a diagram cannot leave the CI look: no other theme, palette, CSS or font", async () => {
  const sources = [
    '%%{init: {"theme": "dark", "themeCSS": ".node rect { fill: url(https://example.invalid/t.png) }", ' +
      '"fontFamily": "Comic Sans MS", "darkMode": true, "themeVariables": {"primaryColor": "#1f2020"}}}%%\n' +
      "flowchart LR\n  A --> B\n",
    "---\nconfig:\n  theme: forest\n  themeCSS: '.node rect { fill: red }'\n  fontFamily: Papyrus\n" +
      "  themeVariables:\n    primaryColor: '#ff0000'\n    darkMode: true\n---\nflowchart LR\n  A --> B\n",
  ];
  for (const source of sources) {
    const config = await configFor(source);
    assert.equal(config.theme, "base", source);
    assert.equal(config.themeCSS, undefined, source);
    assert.equal(config.fontFamily, FONT_SANS, source);
    assert.equal(config.securityLevel, "strict", source);
    assert.equal(config.themeVariables?.primaryColor, ALIASES["canvas-shape"], source);
    assert.equal(config.themeVariables?.darkMode, false, source);
  }
});

test("layout stays the author's: a directive may still set the look and the wrapping", async () => {
  const config = await configFor(
    '---\nconfig:\n  look: handDrawn\n---\n%%{init: {"wrap": true}}%%\nflowchart LR\n A --> B\n',
  );
  assert.equal(config.look, "handDrawn");
  assert.equal(config.wrap, true);
  assert.equal(config.theme, "base");
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
