/**
 * The real mermaid engine (11.17.2, apps/web's pin) behind lib/mermaid-render.ts,
 * under jsdom: what the app's configuration means once mermaid applies it.
 * mermaid parses and configures without a layout engine; drawing needs one,
 * so the drawn output is covered with a fake renderer elsewhere
 * (markdown-mermaid.test.ts). Its own process (node --test runs one per file)
 * keeps the DOM globals mermaid expects away from the other suites.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";

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
