/**
 * Hostile Mermaid sources through the mermaid apps/web pins (issue 293), next
 * to the version mirror (mermaid-engine.test.ts) so that every mermaid bump
 * runs them again. Anyone who may write to a content repo, a person or an
 * agent, writes the fences every reader's browser draws in designIQ's origin.
 *
 * For every diagram type the validator knows (MERMAID_DIAGRAM_TYPES), with
 * hostile labels, and for links, click callbacks, front matter, %%{init}%%
 * directives and foreignObject HTML:
 *
 * 1. mermaid sanitizes a label before it puts it into the document it lays
 *    the diagram out in: no handler, script, frame or javascript: URL of a
 *    label ever reaches that document, and nothing of a render stays there.
 * 2. Some of mermaid's own links do carry a javascript: URL into it, as
 *    written (STRAY_SCRIPT_LINKS), and labels and styles still name images,
 *    media and style sheets there. So that document is the Mermaid frame's,
 *    whose policy runs and loads none of it (mermaid-frame.test.ts; what a
 *    browser makes of it: hostile-mermaid-chromium.ts, by hand).
 * 3. The SVG mermaid returns, through the page's diagram sanitizer, holds
 *    nothing that runs or loads but a link, and drawn through the frame, the
 *    page's own document never holds anything else of a diagram.
 *
 * jsdom runs a handler that does reach its document (runScripts), so a
 * `__pwn` call would also show; it loads nothing, so loading is read off the
 * markup.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { MERMAID_DIAGRAM_TYPES } from "@designiq/notations/mermaid";
import { JSDOM, VirtualConsole } from "jsdom";

import { createMermaidFrameRenderer } from "../src/lib/mermaid-frame.ts";
import { renderMermaid } from "../src/lib/mermaid-render.ts";
import { loadMermaidUnderJsdom } from "./mermaid-dom.ts";
import { FEATURES, LABELS, SOURCES } from "./mermaid-hostile-sources.ts";

// the Markdown view's modules load once jsdom is mermaid's window: DOMPurify,
// which mermaid shares, binds to the window it first meets
const view = async () => ({
  ...(await import("../src/notations/markdown/mermaid-fence.ts")),
  ...(await import("../src/notations/markdown/sanitize.ts")),
});

/** the links mermaid 12.2 writes into its layout document with a javascript:
 *  URL as the source gave it, before its own sanitizer drops them from the
 *  SVG: the frame's policy is what keeps a click on one from running it. A
 *  bump that changes this list fails here until it is read again. */
const STRAY_SCRIPT_LINKS = ["kanban ticket link", "state click"];

const SCRIPT_URL = /^\s*(?:javascript|vbscript|data:text\/html)/i;
/** what can run a script or replace the page's addresses */
const SCRIPT_ELEMENTS = new Set(["script", "iframe", "frame", "object", "embed", "base", "meta"]);
/** the attributes a browser loads from */
const ADDRESS_ATTRIBUTES = [
  "src",
  "href",
  "xlink:href",
  "srcset",
  "poster",
  "background",
  "data",
  "action",
  "formaction",
];
const INERT_ADDRESS = /^\s*(?:#|data:image\/)/i;
/** the attributes a browser reads as CSS */
const CSS_ATTRIBUTES = [
  "style",
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
];
const CSS_LOADS = /url\((?!\s*["']?\s*#)|@import|image-set/i;

/** what in `root` (and below) could run a script of the source's */
function scripts(root: Element): string[] {
  const found: string[] = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const tag = el.localName.toLowerCase();
    if (SCRIPT_ELEMENTS.has(tag)) found.push(`<${tag}>`);
    for (const { name, value } of el.attributes) {
      if (/^on/i.test(name) && value.includes("__pwn")) found.push(`${name}=${value}`);
      if (SCRIPT_URL.test(value)) found.push(`${name}=${value} on <${tag}>`);
    }
  }
  return found;
}

/** what in `root` (and below) would load: an address but a link's, CSS naming one */
function loads(root: Element): string[] {
  const found: string[] = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const tag = el.localName.toLowerCase();
    for (const name of ADDRESS_ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (value === null || (tag === "a" && name.endsWith("href"))) continue;
      if (name === "srcset" || !INERT_ADDRESS.test(value)) found.push(`${name}=${value} on <${tag}>`);
    }
    for (const name of CSS_ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (value !== null && CSS_LOADS.test(value)) found.push(`${name}=${value.slice(0, 80)} on <${tag}>`);
    }
    if (tag === "style" && CSS_LOADS.test(el.textContent ?? "")) found.push(`<style> naming a resource`);
  }
  return found;
}

let window: JSDOM["window"];
const pwned: unknown[] = [];

interface Render {
  name: string;
  svg?: string;
  /** what mermaid put into its layout document, at any moment of the render */
  inserted: Element[];
  /** script URLs mermaid set on an element already in that document */
  setLater: string[];
  /** what stayed in the document's body after the render */
  left: number;
}

/** render `source` as the frame does, watching mermaid's layout document */
async function render(name: string, source: string): Promise<Render> {
  const inserted: Element[] = [];
  const setLater: string[] = [];
  const observer = new window.MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "childList") for (const n of r.addedNodes) if (n.nodeType === 1) inserted.push(n as Element);
      if (r.type === "attributes") {
        const value = (r.target as Element).getAttribute(r.attributeName!) ?? "";
        if (SCRIPT_URL.test(value)) setLater.push(`${r.attributeName}=${value}`);
      }
    }
  });
  observer.observe(window.document, { childList: true, subtree: true, attributes: true });
  const result = await renderMermaid(source, "md-Mermaid");
  await new Promise((resolve) => setImmediate(resolve));
  observer.takeRecords();
  observer.disconnect();
  const left = window.document.body.children.length;
  window.document.body.replaceChildren();
  return { name, svg: "svg" in result ? result.svg : undefined, inserted, setLater, left };
}

const labelRenders = new Map<string, Render[]>();
const featureRenders: Render[] = [];

before(async () => {
  ({ window } = await loadMermaidUnderJsdom({
    url: "https://designiq.test/mermaid-frame.html",
    runScripts: "dangerously",
    virtualConsole: new VirtualConsole(),
  }));
  Object.assign(window, { __pwn: (marker: unknown) => pwned.push(marker) });
  for (const [payload, label] of Object.entries(LABELS)) {
    const renders: Render[] = [];
    for (const type of MERMAID_DIAGRAM_TYPES) renders.push(await render(type, SOURCES[type]!(label)));
    labelRenders.set(payload, renders);
  }
  for (const [name, source] of Object.entries(FEATURES)) featureRenders.push(await render(name, source));
});

// jsdom's windows keep timers (and the frames of hostile labels) alive
const windows: { close(): void }[] = [];
after(() => {
  for (const w of [...windows, window]) w.close();
});

test("every diagram type the validator knows has a hostile source here", () => {
  assert.deepEqual(
    MERMAID_DIAGRAM_TYPES.filter((type) => !SOURCES[type]),
    [],
    "a new diagram type needs its template in SOURCES (mermaid-hostile-sources.ts)",
  );
});

test("hostile labels draw: the checks below read real diagrams, not parse errors", () => {
  for (const [payload, renders] of labelRenders) {
    const drawn = renders.filter((r) => r.svg).length;
    assert.ok(drawn >= 30, `${payload}: only ${drawn} of ${renders.length} diagram types drew`);
  }
  assert.ok(featureRenders.filter((r) => r.svg).length >= Object.keys(FEATURES).length - 5);
});

test("mermaid sanitizes every label before it lays it out: nothing of a label can run in its document", () => {
  for (const [payload, renders] of labelRenders) {
    for (const r of renders) {
      const found = [...r.inserted.flatMap(scripts), ...r.setLater];
      assert.deepEqual(found, [], `${payload} in ${r.name}`);
      assert.equal(r.left, 0, `${payload} in ${r.name} left a node in the body`);
    }
  }
  assert.deepEqual(pwned, []);
});

test("links, clicks, front matter, directives: only the known links carry a javascript: URL into mermaid's document", () => {
  const stray = featureRenders
    .filter((r) => [...r.inserted.flatMap(scripts), ...r.setLater].length > 0)
    .map((r) => r.name);
  assert.deepEqual(stray.sort(), [...STRAY_SCRIPT_LINKS].sort());
  for (const r of featureRenders) {
    const found = [...r.inserted.flatMap(scripts), ...r.setLater];
    assert.ok(
      found.every((f) => /^(?:href|xlink:href)=javascript:__pwn\(\d+\)/.test(f)),
      `${r.name}: ${found.join(", ")}`,
    );
    assert.equal(r.left, 0, `${r.name} left a node in the body`);
  }
  assert.deepEqual(pwned, []);
});

test("the SVG mermaid returns, sanitized for the page, holds nothing that runs or loads but a link", async () => {
  const page = new JSDOM("<!doctype html><html><body></body></html>", { virtualConsole: new VirtualConsole() }).window;
  windows.push(page);
  const { createDiagramSanitizer } = await view();
  const sanitize = createDiagramSanitizer(page);
  const renders = [...[...labelRenders.values()].flat(), ...featureRenders].filter((r) => r.svg);
  let unsanitized = 0;
  for (const r of renders) {
    const raw = page.document.createElement("div");
    raw.innerHTML = r.svg!;
    if (loads(raw).length > 0) unsanitized++;
    const svg = sanitize(r.svg!).firstElementChild!;
    assert.deepEqual([...scripts(svg), ...loads(svg)], [], r.name);
    for (const a of svg.querySelectorAll("a")) {
      assert.equal(a.getAttribute("target"), "_blank", r.name);
      assert.equal(a.getAttribute("rel"), "noopener noreferrer", r.name);
    }
  }
  // without the page's sanitizer, those SVGs would load what they name
  assert.ok(unsanitized >= 20, `only ${unsanitized} SVGs name a resource before the page's sanitizer`);
});

test("drawn through the frame, the page's own document holds nothing of a diagram but its sanitized SVG", async () => {
  const page = new JSDOM("<!doctype html><html><body><article></article></body></html>", {
    url: "https://designiq.test/r/acme/models/f/docs/guide.md",
    virtualConsole: new VirtualConsole(),
  }).window;
  windows.push(page);
  const article = page.document.querySelector("article")!;
  const { createMermaidFence } = await view();
  let frame: HTMLIFrameElement | undefined;
  const fence = createMermaidFence(async () =>
    createMermaidFrameRenderer({
      doc: page.document,
      // the frame: this suite's own window, where the renderer lays diagrams out
      open: async (doc) => {
        frame = doc.body.appendChild(doc.createElement("iframe"));
        return { element: frame, api: { render: renderMermaid } };
      },
    }),
  );
  const seen: Element[] = [];
  const observer = new page.MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "childList") for (const n of r.addedNodes) if (n.nodeType === 1) seen.push(n as Element);
      if (r.type === "attributes") seen.push(r.target as Element);
    }
  });
  observer.observe(page.document, { childList: true, subtree: true, attributes: true });
  const sources = [
    ...Object.values(FEATURES),
    ...Object.values(LABELS).map((label) => SOURCES.flowchart!(label)),
    ...Object.values(LABELS).map((label) => SOURCES.sequenceDiagram!(label)),
  ];
  article.innerHTML = sources.map((source) => fence.render(source, { lang: "mermaid", info: "mermaid" })).join("");
  await fence.hydrate(article, new page.AbortController().signal);
  observer.takeRecords();
  observer.disconnect();
  const drawn = article.querySelectorAll(".md-mermaid-diagram > svg").length;
  assert.ok(drawn >= sources.length - 5, `only ${drawn} of ${sources.length} drew`);
  const diagram = seen.filter((el) => el !== frame);
  assert.ok(frame, "the page started its frame");
  assert.deepEqual([...diagram.flatMap(scripts), ...diagram.flatMap(loads)], []);
  assert.equal(window.document.body.children.length, 0, "the frame's document is left empty");
});
