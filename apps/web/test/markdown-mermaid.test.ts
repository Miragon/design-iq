/**
 * ```mermaid fences in the Markdown view (src/notations/markdown/
 * mermaid-fence.ts) under jsdom: the fence's code block, the hook wiring
 * (the renderer loads only for a document with a mermaid fence), the drawing
 * cache that keeps live edits from flashing diagrams back to code, stale
 * results, the error notice and the diagram sanitizer. mermaid needs a real
 * layout engine, so a fake renderer stands in for lib/mermaid-render.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALIASES } from "@designiq/ui-kit/lib/tokens";
import { JSDOM, VirtualConsole } from "jsdom";
import * as Y from "yjs";

import { LINE_CASING_CLASS } from "../src/lib/mermaid-line-casing.ts";
import { diagramImageRefusal, type MermaidRenderResult } from "../src/lib/mermaid-render.ts";
import { FENCE_EXTENSIONS } from "../src/notations/markdown/fences.ts";
import { createMermaidFence, type RenderMermaid } from "../src/notations/markdown/mermaid-fence.ts";
import { renderMarkdown } from "../src/notations/markdown/render.ts";
import { createSanitizer } from "../src/notations/markdown/sanitize.ts";
import { mountMarkdownView, RENDER_DEBOUNCE_MS } from "../src/notations/markdown/view.ts";
import type { EditorContext } from "../src/notations/registry.ts";

const newWindow = () =>
  new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://designiq.test/r/acme/models/f/docs/guide.md",
    virtualConsole: new VirtualConsole(),
  }).window;

/** let the hydration (microtasks and the fake renderer) run */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const fence = (body: string): string => "```mermaid\n" + body + "\n```\n";

/**
 * A stand-in for renderMermaid: a source with "broken" in it fails on its
 * second line, any other draws as an SVG naming its first line. While `hold`
 * is set, results wait for release(source).
 */
function fakeRenderer(
  svgOf = (source: string, id: string) => `<svg id="${id}"><text>${source.split("\n")[0]}</text></svg>`,
) {
  const calls: string[] = [];
  const held = new Map<string, () => void>();
  let loads = 0;
  let failLoad = false;
  let seq = 0;
  const state = { hold: false };
  const render: RenderMermaid = (source, idPrefix) => {
    calls.push(source);
    const result: MermaidRenderResult = source.includes("broken")
      ? { error: { line: 2, message: "Expecting 'SEMI', got 'EOF'" } }
      : { svg: svgOf(source, `${idPrefix}-${++seq}`) };
    if (!state.hold) return Promise.resolve(result);
    return new Promise((resolve) => held.set(source, () => resolve(result)));
  };
  const load = (): Promise<RenderMermaid> => {
    loads++;
    return failLoad ? Promise.reject(new Error("chunk failed")) : Promise.resolve(render);
  };
  return {
    load,
    calls,
    state,
    loads: () => loads,
    failNextLoads: (fail: boolean) => void (failLoad = fail),
    release: (source: string) => held.get(source)!(),
  };
}

function mount(source: string, fake: ReturnType<typeof fakeRenderer>) {
  const win = newWindow();
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, source);
  const errors: string[] = [];
  const ctx: EditorContext = {
    ytext,
    doc: ydoc,
    repo: "acme/models",
    docPath: "docs/guide.md",
    onSyncError: (message) => errors.push(message),
    onImportFailed: (message) => errors.push(message),
    onBadgeClick: () => undefined,
    onSelectionChanged: () => undefined,
  };
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const view = mountMarkdownView(container, ctx, { mermaid: createMermaidFence(fake.load) });
  const article = container.querySelector("article")!;
  /** replace the whole text, as a collaborator's edit arrives */
  const setText = (text: string): void => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, text);
  };
  const drawn = (): string[] =>
    [...article.querySelectorAll(".md-mermaid-diagram svg text")].map((t) => t.textContent!);
  return { win, view, article, setText, drawn, errors };
}

test("a mermaid fence is a code block with its source as text, until it is drawn", () => {
  assert.ok(FENCE_EXTENSIONS.mermaid, "the view registers the mermaid fence");
  const source = 'flowchart LR\n  A["<b>a & b</b>"] --> B\n';
  const html = renderMarkdown("```Mermaid\n" + source + "```\n\n```js\nx\n```", {
    repo: "acme/models",
    docPath: "docs/guide.md",
    fences: { mermaid: createMermaidFence().render },
  });
  const box = newWindow().document.createElement("div");
  box.append(createSanitizer(box.ownerDocument.defaultView!)(html));
  const block = box.querySelector("pre.md-code.md-mermaid > code.language-mermaid");
  assert.equal(block?.textContent, source, "the source survives the render and the sanitizer as it was typed");
  assert.equal(box.querySelectorAll(".md-mermaid").length, 1, "another language stays a plain code block");
});

test("the renderer loads only for a document with a mermaid fence, and draws it in place", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = fakeRenderer();
  const v = mount("# Notes\n\n```js\nconst a = 1;\n```\n", fake);
  await settle();
  assert.equal(fake.loads(), 0, "no mermaid fence: neither the renderer nor mermaid loads");

  v.setText("# Notes\n\n" + fence("flowchart LR\n  A --> B") + "\nAfter.");
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  assert.deepEqual(fake.calls, ["flowchart LR\n  A --> B\n"]);
  assert.deepEqual(v.drawn(), ["flowchart LR"]);
  assert.equal(v.article.querySelector("pre.md-mermaid"), null, "the drawing replaces the code block");
  assert.match(v.article.querySelector(".md-mermaid-diagram svg")!.id, /^md-Mermaid-\d+$/);
  assert.match(v.article.textContent, /After\./);
  assert.deepEqual(v.errors, []);
  v.view.destroy();
});

test("an edit elsewhere puts the cached drawings back before the browser paints", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = fakeRenderer();
  const v = mount(fence("flowchart LR\n  A --> B") + "\n" + fence("sequenceDiagram\n  A->>B: hi"), fake);
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart LR", "sequenceDiagram"]);

  fake.state.hold = true; // a render now would not resolve in this test
  v.setText(fence("flowchart LR\n  A --> B") + "\nA new paragraph.\n\n" + fence("sequenceDiagram\n  A->>B: hi"));
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await Promise.resolve(); // the hydration's own microtask, no task in between
  assert.deepEqual(v.drawn(), ["flowchart LR", "sequenceDiagram"]);
  assert.equal(v.article.querySelector("pre.md-mermaid"), null, "no diagram flashes back to code");
  assert.equal(fake.calls.length, 2, "nothing is drawn twice");
  v.view.destroy();
});

test("a changed diagram keeps its drawing until the new one lands, and a stale result never lands", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = fakeRenderer();
  const v = mount(fence("flowchart A"), fake);
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart A"]);

  fake.state.hold = true;
  v.setText(fence("flowchart B"));
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart A"], "the last drawing stays while B draws");
  assert.equal(v.article.querySelector(".md-mermaid-block")?.getAttribute("aria-busy"), "true");

  v.setText(fence("flowchart C"));
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  fake.release("flowchart C\n");
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart C"]);
  assert.equal(v.article.querySelector(".md-mermaid-block")?.hasAttribute("aria-busy"), false);

  fake.release("flowchart B\n"); // B finishes last: its render was aborted by C's
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart C"], "the late result of B never overwrites C");

  // ... but it was cached: going back to B draws it at once
  v.setText(fence("flowchart B"));
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await Promise.resolve();
  assert.deepEqual(v.drawn(), ["flowchart B"]);
  assert.deepEqual(fake.calls, ["flowchart A\n", "flowchart B\n", "flowchart C\n"]);
  v.view.destroy();
});

test("a diagram added or removed is never shown with another diagram's drawing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = fakeRenderer();
  const v = mount(fence("flowchart A"), fake);
  await settle();

  fake.state.hold = true;
  v.setText(fence("flowchart New") + "\n" + fence("flowchart A"));
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  const [first, second] = v.article.querySelectorAll(".md-mermaid-block");
  assert.equal(first?.querySelector("pre.md-mermaid")?.textContent, "flowchart New\n", "the new one shows its code");
  assert.equal(second?.querySelector(".md-mermaid-diagram svg text")?.textContent, "flowchart A");
  v.view.destroy();
});

test("a deleted diagram is never taken for the next new one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = fakeRenderer();
  const v = mount("# Notes\n\n" + fence("flowchart OLD"), fake);
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart OLD"]);

  v.setText("# Notes\n\nNo diagram now.\n");
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  assert.deepEqual(v.drawn(), []);

  // another diagram, still drawing: its code shows, not the deleted drawing
  fake.state.hold = true;
  v.setText("# Notes\n\n" + fence("sequenceDiagram\n  A->>B: hi"));
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  assert.deepEqual(v.drawn(), []);
  assert.equal(v.article.querySelector("pre.md-mermaid")?.textContent, "sequenceDiagram\n  A->>B: hi\n");

  // and one that cannot be drawn has no last version to keep
  fake.state.hold = false;
  v.setText("");
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  v.setText(fence("flowchart broken\n  A -->"));
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  assert.deepEqual(v.drawn(), []);
  assert.equal(v.article.querySelector(".md-mermaid-notice-hint"), null);
  assert.ok(v.article.querySelector(".md-mermaid-notice"));
  v.view.destroy();
});

test("a render id is never a heading anchor: mermaid removes the element it names first", async () => {
  const page: { doc?: Document } = {};
  const fake = fakeRenderer((source, id) => {
    // what mermaid.render does before it draws (removeExistingElements)
    page.doc?.getElementById(id)?.remove();
    return `<svg id="${id}"><text>${source.split("\n")[0]}</text></svg>`;
  });
  const v = mount("## Mermaid 1\n\n## Mermaid\n\n## Mermaid\n\n" + fence("flowchart A") + fence("flowchart B"), fake);
  page.doc = v.win.document;
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart A", "flowchart B"]);
  const headings = [...v.article.querySelectorAll("h2")].map((h) => [h.id, h.textContent]);
  assert.deepEqual(headings, [
    ["md-mermaid-1", "Mermaid 1"],
    ["md-mermaid", "Mermaid"],
    ["md-mermaid-2", "Mermaid"],
  ]);
  const ids = [...v.article.querySelectorAll("[id]")].map((el) => el.id);
  assert.equal(new Set(ids).size, ids.length, "every id on the page once");
  v.view.destroy();
});

test("two fences of one source draw apart, so every id is on the page once (#294)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  // as mermaid draws a mindmap: ids scoped to the render, a node's id on its
  // shape twice, and an id of a sequence actor's that mermaid does not scope
  const fake = fakeRenderer(
    (source, id) =>
      `<svg id="${id}"><defs><marker id="${id}-arrow"></marker></defs>` +
      `<g id="${id}-node_0"><path id="${id}-node_0"></path></g><g id="actor0"></g>` +
      `<line marker-end="url(#${id}-arrow)"></line><rect fill="url(#actor0)"></rect><text>${source.split("\n")[0]}</text></svg>`,
  );
  const v = mount(fence("mindmap A") + "\n" + fence("mindmap A") + "\n" + fence("mindmap B"), fake);
  await settle();
  assert.deepEqual(v.drawn(), ["mindmap A", "mindmap A", "mindmap B"]);
  assert.deepEqual(fake.calls, ["mindmap A\n", "mindmap A\n", "mindmap B\n"], "each fence draws its own");
  const onPage = (): void => {
    const ids = [...v.article.querySelectorAll("[id]")].map((element) => element.id);
    assert.equal(new Set(ids).size, ids.length, `every id on the page once: ${ids.join(" ")}`);
    for (const svg of v.article.querySelectorAll(".md-mermaid-diagram svg")) {
      const marker = /^url\(#(.+)\)$/.exec(svg.querySelector("line")!.getAttribute("marker-end")!)![1]!;
      assert.equal(svg.querySelector(`marker[id="${marker}"]`)?.closest("svg"), svg, "its arrow is its own");
      assert.equal(svg.querySelector("rect")!.getAttribute("fill"), `url(#${svg.id}-actor0)`);
      assert.ok(svg.querySelector(`[id="${svg.id}-actor0"]`));
    }
  };
  onPage();

  // an edit elsewhere puts both drawings back from the cache, still apart
  v.setText(fence("mindmap A") + "\n" + fence("mindmap A") + "\n" + fence("mindmap B") + "\nMore.");
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await Promise.resolve();
  assert.deepEqual(v.drawn(), ["mindmap A", "mindmap A", "mindmap B"]);
  assert.equal(fake.calls.length, 3, "nothing is drawn again");
  onPage();
  v.view.destroy();
});

test("a block that waits for its new drawing never keeps one another block shows now (#294)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = fakeRenderer(
    (source, id) => `<svg id="${id}"><g id="${id}-node_0"></g><text>${source.split("\n")[0]}</text></svg>`,
  );
  const v = mount(fence("mindmap A") + "\n" + fence("mindmap A"), fake);
  await settle();
  /** each block's drawing by its id, or its code */
  const shown = (): string[] =>
    [...v.article.querySelectorAll(".md-mermaid-block")].map(
      (block) =>
        block.querySelector(".md-mermaid-diagram svg")?.id ?? `code ${block.querySelector("pre")?.textContent}`,
    );
  const onceEach = (): void => {
    const ids = [...v.article.querySelectorAll("[id]")].map((element) => element.id);
    assert.equal(new Set(ids).size, ids.length, `every id on the page once: ${ids.join(" ")}`);
  };
  /** an edit as it is shown before the browser paints, while what it draws anew still draws */
  const edit = async (...sources: string[]): Promise<void> => {
    fake.state.hold = true;
    v.setText(sources.map(fence).join("\n"));
    t.mock.timers.tick(RENDER_DEBOUNCE_MS);
    await settle();
    onceEach();
  };
  const release = async (source: string): Promise<void> => {
    fake.release(`${source}\n`);
    await settle();
    onceEach();
  };
  assert.deepEqual(shown(), ["md-Mermaid-1", "md-Mermaid-2"]);

  // the first of two fences of one source, edited: each keeps its own drawing
  await edit("mindmap A broken", "mindmap A");
  assert.deepEqual(shown(), ["md-Mermaid-1", "md-Mermaid-2"]);
  await release("mindmap A broken");
  assert.deepEqual(shown(), ["md-Mermaid-1", "md-Mermaid-2"]);
  assert.ok(v.article.querySelectorAll(".md-mermaid-block")[0]!.querySelector(".md-mermaid-diagram.is-stale"));
  await edit("mindmap A", "mindmap A");
  assert.deepEqual(shown(), ["md-Mermaid-1", "md-Mermaid-2"], "both from the cache, each its own");

  // a source taken over from the other fence: the other keeps its drawing,
  // this one its last drawing while its own draws
  await edit("mindmap A", "mindmap B");
  await release("mindmap B");
  assert.deepEqual(shown(), ["md-Mermaid-1", "md-Mermaid-3"]);
  await edit("mindmap B", "mindmap B");
  assert.deepEqual(shown(), ["md-Mermaid-1", "md-Mermaid-3"]);
  await release("mindmap B");
  assert.deepEqual(shown(), ["md-Mermaid-4", "md-Mermaid-3"]);

  // a block whose last drawing the other block now shows waits with its code
  await edit("mindmap C", "mindmap B");
  await release("mindmap C");
  assert.deepEqual(shown(), ["md-Mermaid-5", "md-Mermaid-3"]);
  await edit("mindmap D", "mindmap C");
  assert.deepEqual(shown(), ["code mindmap D\n", "md-Mermaid-5"]);
  assert.equal(v.article.querySelectorAll(".md-mermaid-block")[0]!.getAttribute("aria-busy"), "true");
  await release("mindmap D");
  assert.deepEqual(shown(), ["md-Mermaid-6", "md-Mermaid-5"]);
  v.view.destroy();
});

test("a source mermaid cannot read: its code, or its last drawing dimmed, under a notice", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = fakeRenderer();
  const v = mount(fence("flowchart broken\n  A -->"), fake);
  await settle();
  const notice = (): Element | null => v.article.querySelector(".md-mermaid-notice");
  assert.equal(v.article.querySelector("pre.md-mermaid")?.textContent, "flowchart broken\n  A -->\n");
  assert.equal(notice()?.getAttribute("role"), "status");
  assert.equal(notice()?.querySelector(".md-mermaid-notice-title")?.textContent, "Error on line 2 of the diagram");
  assert.equal(notice()?.querySelector(".md-mermaid-notice-message")?.textContent, "Expecting 'SEMI', got 'EOF'");
  assert.equal(notice()?.querySelector(".md-mermaid-notice-hint"), null, "nothing drew before: no last version");
  assert.ok(notice()?.querySelector("svg.md-mermaid-notice-icon[aria-hidden='true']"), "the Lucide alert icon");

  v.setText(fence("flowchart fixed"));
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart fixed"]);
  assert.equal(notice(), null);

  v.setText(fence("flowchart broken again"));
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart fixed"], "the last good drawing stays ...");
  assert.ok(v.article.querySelector(".md-mermaid-diagram.is-stale"), "... dimmed");
  assert.equal(
    notice()?.querySelector(".md-mermaid-notice-hint")?.textContent,
    "The last version that rendered stays in view.",
  );
  assert.deepEqual(v.errors, [], "an error in a diagram is the diagram's notice, not the shell's");
  v.view.destroy();
});

test("a renderer that does not load shows on the block, and the next render tries again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = fakeRenderer();
  fake.failNextLoads(true);
  const v = mount(fence("flowchart A"), fake);
  await settle();
  assert.ok(v.article.querySelector("pre.md-mermaid"));
  assert.equal(
    v.article.querySelector(".md-mermaid-notice-message")?.textContent,
    "The Mermaid renderer did not load: chunk failed",
  );

  fake.failNextLoads(false);
  v.setText(fence("flowchart A") + "\nMore.");
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  assert.equal(fake.loads(), 2);
  assert.deepEqual(v.drawn(), ["flowchart A"]);
  v.view.destroy();
});

test("the drawn SVG is sanitized again: no script, no handler, links leave in a new tab", async () => {
  const hostile = (_source: string, id: string) =>
    `<svg id="${id}" onload="alert(1)"><script>alert(1)</script><style>#${id} .node{fill:red}</style>` +
    `<a href="javascript:alert(1)"><text>js</text></a><a href="https://example.com"><text>web</text></a>` +
    `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml" onmouseover="alert(1)"><span class="nodeLabel"><p>label</p></span></div></foreignObject>` +
    `<text>flowchart</text></svg>`;
  const fake = fakeRenderer(hostile);
  const v = mount(fence("flowchart LR"), fake);
  await settle();
  const svg = v.article.querySelector(".md-mermaid-diagram svg")!;
  const markup = svg.outerHTML;
  assert.doesNotMatch(markup, /<script|onload|onmouseover|javascript:/);
  assert.match(markup, /<style>#md-Mermaid-1 \.node\{fill:red\}<\/style>/, "the diagram keeps its scoped styles");
  assert.equal(svg.querySelector("foreignObject span.nodeLabel p")?.textContent, "label", "HTML labels stay");
  const web = svg.querySelector('a[href="https://example.com"]');
  assert.equal(web?.getAttribute("target"), "_blank");
  assert.equal(web?.getAttribute("rel"), "noopener noreferrer");
  v.view.destroy();
});

test("an xy chart's lines lie on a white casing on the page, once, also when its cached drawing is put back (#294)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  // as mermaid draws an xy chart: every plot in a group of its own, a line's point labels beside its path
  const fake = fakeRenderer(
    (source, id) =>
      `<svg id="${id}"><g class="main"><g class="plot">` +
      `<g class="bar-plot-0"><rect x="0" y="0" width="10" height="10" fill="#8F8A8A"></rect></g>` +
      `<g class="line-plot-1"><path d="M5,2L15,8" fill="none" stroke="#6B6666" stroke-width="2"></path>` +
      `<g class="labels"><text>low</text></g></g></g></g><text>${source.split("\n")[0]}</text></svg>`,
  );
  const v = mount(fence("xychart"), fake);
  await settle();
  const assertCased = (): void => {
    const paths = [...v.article.querySelectorAll(".md-mermaid-diagram svg .line-plot-1 > path")];
    assert.equal(paths.length, 2, "the line and one casing");
    const [casing, line] = paths as [Element, Element];
    assert.equal(casing.getAttribute("class"), LINE_CASING_CLASS, "the casing lies under the line");
    assert.equal(casing.getAttribute("d"), "M5,2L15,8");
    assert.equal(casing.getAttribute("stroke"), ALIASES["canvas-background"]);
    assert.equal(casing.getAttribute("stroke-width"), "6");
    assert.equal(line.getAttribute("stroke"), "#6B6666", "the line keeps its grey");
  };
  assertCased();

  v.setText(fence("xychart") + "\nMore.");
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await Promise.resolve();
  assert.equal(fake.calls.length, 1, "the cached drawing is put back");
  assertCased();
  v.view.destroy();
});

test("a drawn diagram loads nothing on the page: no media, no form, only links, its own references and inline images keep an address (#293)", async () => {
  const EVIL = "https://tracker.example";
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  const hostile = (_source: string, id: string) =>
    `<svg id="${id}" xmlns:xlink="http://www.w3.org/1999/xlink">` +
    `<style>#${id} .node rect{fill:#fff;stroke:url(#${id}-gradient)}#${id} .evil>*{fill:url("${EVIL}/class.svg#p")!important;background:url(${EVIL}/bg.png)}</style>` +
    `<defs><linearGradient id="${id}-gradient"></linearGradient><marker id="${id}-arrow"></marker></defs>` +
    `<g class="node"><rect style="fill:url(${EVIL}/style.svg#p);stroke:#333" marker-end="url(#${id}-arrow)"></rect></g>` +
    `<rect fill="url(${EVIL}/fill.svg#p)" filter="url(${EVIL}/filter.svg#f)"></rect>` +
    `<image href="${EVIL}/image.png"></image><image xlink:href="${PNG}"></image>` +
    `<feImage href="${EVIL}/fe.png"></feImage>` +
    `<a href="${EVIL}/docs"><text>docs</text></a>` +
    `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">` +
    `<img src="${EVIL}/img.png" srcset="${EVIL}/2x.png 2x"><img src="${PNG}">` +
    `<video src="${EVIL}/v.mp4" poster="${EVIL}/poster.png"><source src="${EVIL}/s.mp4"></video>` +
    `<div style="background-image:url(${EVIL}/inline.png)">bg</div>` +
    `<span style="background:u\\72 l(${EVIL}/escaped.png)">escaped</span>` +
    `<span style="color:red">kept</span>` +
    `<form action="${EVIL}/post"><input type="image" src="${EVIL}/input.png"><button>go</button></form>` +
    `</div></foreignObject><text>flowchart</text></svg>`;
  const fake = fakeRenderer(hostile);
  const v = mount(fence("flowchart LR"), fake);
  await settle();
  const svg = v.article.querySelector(".md-mermaid-diagram svg")!;
  const markup = svg.outerHTML;
  assert.doesNotMatch(markup, /tracker\.example(?!\/docs)/, "no address but the link's");
  assert.equal(svg.querySelector("style"), null, "a style sheet that names a resource goes whole");
  assert.equal(
    svg.querySelector("[style*=url], [fill], [filter]"),
    null,
    "so does a style or a presentation attribute",
  );
  assert.equal(svg.querySelector("rect[marker-end]")?.getAttribute("marker-end"), "url(#md-Mermaid-1-arrow)");
  assert.equal(
    svg.querySelectorAll('img[src^="data:image/"], image[*|href^="data:image/"]').length,
    2,
    "inline images stay",
  );
  assert.equal(svg.querySelector("span[style]:not([style*=color])"), null, "a style that hides an address is gone");
  assert.equal(svg.querySelector('span[style="color:red"]')?.textContent, "kept");
  assert.equal(svg.querySelector("form, input, button"), null, "no form acts on a click");
  const link = svg.querySelector("a")!;
  assert.equal(link.getAttribute("href"), `${EVIL}/docs`, "a link stays: it loads nothing until it is clicked");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  v.view.destroy();
});

test("a drawn diagram loads nothing from another site on the page (#290)", async () => {
  const tracking = (_source: string, id: string) =>
    `<svg id="${id}" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="g"/></defs>` +
    `<image href="https://tracker.example/a.png"/><image xlink:href="//tracker.example/b.png"/>` +
    `<image href="data:image/png;base64,AAAA"/><image href="#g"/><use href="https://tracker.example/s.svg#x"/>` +
    `<rect style="fill:url(#g)"/><rect style="fill:url(https://tracker.example/c.svg#p)"/>` +
    `<rect style="background-image:image-set('https://tracker.example/d.png' 1x)"/><rect style="background:\\75rl(x)"/>` +
    `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://tracker.example/e.png"/>` +
    `<span style="background-image:url('https://tracker.example/f.png')">label</span></div></foreignObject>` +
    `<a href="https://example.com"><text>web</text></a><text>flowchart</text></svg>`;
  const v = mount(fence("flowchart LR"), fakeRenderer(tracking));
  await settle();
  const markup = v.article.querySelector(".md-mermaid-diagram svg")!.outerHTML;
  assert.doesNotMatch(markup, /tracker\.example|image-set|\\75rl/);
  assert.match(markup, /<image href="data:image\/png;base64,AAAA"/, "inline data stays");
  // a reference within the diagram stays, scoped to it with the element it names (#294)
  assert.match(markup, /<image href="#md-Mermaid-1-g"/);
  assert.match(markup, /<rect style="fill:url\(#md-Mermaid-1-g\)"/);
  assert.match(markup, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">/, "links stay");
  v.view.destroy();
});

test("a drawn diagram's style sheets and presentation attributes fetch nothing either (#290)", async () => {
  const tracking = (_source: string, id: string) =>
    `<svg id="${id}"><style>#${id} .node{fill:red}</style>` +
    `<g><style>#${id} .bad span{background-image:url("https://tracker.example/state.png")!important;}</style></g>` +
    `<g><style>#${id} .x{background:&#117;rl(https://tracker.example/entity.png)}</style></g>` +
    `<g><style>#${id} .y{background:u\\72l(https://tracker.example/escape.png)}</style></g>` +
    `<defs><marker id="arrow"/><linearGradient id="g"/></defs>` +
    `<line stroke="url(https://tracker.example/rel.png)" marker-end="url(#arrow)"/>` +
    `<rect fill="url(#g)" mask="url(https://tracker.example/m.svg#m)" filter="u\\72l(https://tracker.example/f.svg#f)"/>` +
    `<text>flowchart</text></svg>`;
  const v = mount(fence("flowchart LR"), fakeRenderer(tracking));
  await settle();
  const svg = v.article.querySelector(".md-mermaid-diagram svg")!;
  assert.doesNotMatch(svg.outerHTML, /tracker\.example/);
  // the entity only turns into url( once the SVG is parsed: the page checks what it would apply
  assert.deepEqual(
    [...svg.querySelectorAll("style")].map((style) => style.textContent),
    ["#md-Mermaid-1 .node{fill:red}"],
    "the diagram's own style sheet stays",
  );
  assert.equal(svg.querySelector("line")?.getAttribute("marker-end"), "url(#md-Mermaid-1-arrow)");
  assert.equal(svg.querySelector("rect")?.getAttribute("fill"), "url(#md-Mermaid-1-g)");
  v.view.destroy();
});

test("an actor's details that read a heading of the document are refused before mermaid sees them (#290)", async () => {
  const fake = fakeRenderer();
  const drawn: string[] = [];
  const render: RenderMermaid = (source, idPrefix) => {
    const refused = diagramImageRefusal(source);
    if (refused) return Promise.resolve({ error: refused });
    drawn.push(source);
    return Promise.resolve({ svg: `<svg id="${idPrefix}-1"><text>drawn</text></svg>` });
  };
  const v = mount(
    '## {"properties":{"icon":"//tracker.example/details-icon.png"}}\n\n' +
      fence(
        "sequenceDiagram\n  participant A\n  details A: md-propertiesicontrackerexampledetails-iconpng\n  A->>A: hi",
      ),
    { ...fake, load: () => Promise.resolve(render) },
  );
  await settle();
  // the heading is the element mermaid would read the actor's properties from
  assert.equal(
    v.article.querySelector("#md-propertiesicontrackerexampledetails-iconpng")?.innerHTML,
    '{"properties":{"icon":"//tracker.example/details-icon.png"}}',
  );
  assert.deepEqual(drawn, []);
  assert.equal(v.article.querySelector(".md-mermaid-notice-title")?.textContent, "Error on line 3 of the diagram");
  assert.match(
    v.article.querySelector(".md-mermaid-notice-message")?.textContent ?? "",
    /^An actor's details are not drawn/,
  );
  v.view.destroy();
});
