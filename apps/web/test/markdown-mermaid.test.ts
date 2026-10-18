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

import { JSDOM, VirtualConsole } from "jsdom";
import * as Y from "yjs";

import type { MermaidRenderResult } from "../src/lib/mermaid-render.ts";
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
