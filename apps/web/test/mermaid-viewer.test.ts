/**
 * The Mermaid notation's viewer and Preview body (src/notations/mermaid/
 * viewer.ts) under jsdom, with a fake renderer behind the Markdown view's
 * mermaid fence: the live text drawn at once and after every pause, the last
 * good diagram kept under the notice, a late result never landing, the
 * page-side sanitizer and link policy, the hidden layer, a failed engine
 * load and a clean destroy. The fence's own cache rules are covered in
 * markdown-mermaid.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";
import * as Y from "yjs";

import type { MermaidRenderResult } from "../src/lib/mermaid-render.ts";
import { createMermaidFence, type RenderMermaid } from "../src/notations/markdown/mermaid-fence.ts";
import { mountMermaidDiagram, mountMermaidViewer, REDRAW_DEBOUNCE_MS } from "../src/notations/mermaid/viewer.ts";
import type { EditorContext, LayerVisibility } from "../src/notations/registry.ts";

const newWindow = () =>
  new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://designiq.test/r/acme/models/f/diagrams/flow.mmd",
    virtualConsole: new VirtualConsole(),
  }).window;

/** let the fence's hydration (microtasks and the fake renderer) run */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
  const state = { hold: false };
  let seq = 0;
  const render: RenderMermaid = (source, idPrefix) => {
    calls.push(source);
    const result: MermaidRenderResult = source.includes("broken")
      ? { error: { line: 2, message: "Expecting 'SEMI', got 'EOF'" } }
      : { svg: svgOf(source, `${idPrefix}-${++seq}`) };
    if (!state.hold) return Promise.resolve(result);
    return new Promise((resolve) => held.set(source, () => resolve(result)));
  };
  return {
    fence: createMermaidFence(() => Promise.resolve(render)),
    calls,
    state,
    release: (source: string) => held.get(source)!(),
  };
}

/** the shell's view switch, as the test drives it */
function layer() {
  let shown = true;
  const listeners = new Set<() => void>();
  const visibility: LayerVisibility = {
    visible: () => shown,
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return {
    visibility,
    listeners,
    show(next: boolean) {
      shown = next;
      for (const cb of listeners) cb();
    },
  };
}

async function mountViewer(source: string, fake = fakeRenderer(), ready = () => Promise.resolve()) {
  const win = newWindow();
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, source);
  const errors: string[] = [];
  const view = layer();
  const ctx: EditorContext = {
    ytext,
    doc: ydoc,
    repo: "acme/models",
    docPath: "diagrams/flow.mmd",
    onSyncError: (message) => errors.push(message),
    onImportFailed: (message) => errors.push(message),
    onBadgeClick: () => undefined,
    onSelectionChanged: () => undefined,
    visibility: view.visibility,
  };
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const viewer = await mountMermaidViewer(container, ctx, { ready, fence: fake.fence });
  const setText = (text: string): void => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, text);
  };
  const drawn = (): string[] =>
    [...container.querySelectorAll(".md-mermaid-diagram svg text")].map((t) => t.textContent!);
  const notice = (): Element | null => container.querySelector(".md-mermaid-notice");
  return { win, ytext, container, viewer, view, fake, setText, drawn, notice, errors };
}

test("the viewer draws the live text at once, then after every pause", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const v = await mountViewer("flowchart A");
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart A"]);
  const region = v.container.querySelector(".markdown-view");
  assert.equal(region?.getAttribute("role"), "region");
  assert.equal(region?.getAttribute("aria-label"), "Diagram");

  v.setText("flowchart B");
  t.mock.timers.tick(REDRAW_DEBOUNCE_MS - 1);
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart A"], "not before the pause");
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart B"]);
  assert.deepEqual(v.fake.calls, ["flowchart A", "flowchart B"]);
  assert.deepEqual(v.errors, []);
  v.viewer.destroy();
});

test("a syntax error keeps the last good diagram, dimmed, under the notice", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const v = await mountViewer("flowchart A");
  await settle();

  v.setText("flowchart broken\n  A -->");
  t.mock.timers.tick(REDRAW_DEBOUNCE_MS);
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart A"]);
  assert.ok(v.container.querySelector(".md-mermaid-diagram.is-stale"));
  assert.equal(v.notice()?.querySelector(".md-mermaid-notice-title")?.textContent, "Error on line 2 of the diagram");
  assert.equal(
    v.notice()?.querySelector(".md-mermaid-notice-hint")?.textContent,
    "The last version that rendered stays in view.",
  );

  v.setText("flowchart C");
  t.mock.timers.tick(REDRAW_DEBOUNCE_MS);
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart C"]);
  assert.equal(v.notice(), null);
  v.viewer.destroy();
});

test("a slow render never lands over a newer one", async () => {
  const fake = fakeRenderer();
  const win = newWindow();
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const diagram = mountMermaidDiagram(host, { label: "Diagram preview", fence: fake.fence });
  diagram.show("flowchart A");
  await settle();

  fake.state.hold = true;
  diagram.show("flowchart B");
  await settle(); // B is drawing ...
  diagram.show("flowchart C");
  await settle(); // ... when C comes, and C finishes first
  fake.release("flowchart C");
  await settle();
  fake.release("flowchart B");
  await settle();
  const drawn = [...host.querySelectorAll(".md-mermaid-diagram svg text")].map((t) => t.textContent);
  assert.deepEqual(drawn, ["flowchart C"]);
  diagram.show("flowchart C"); // the same source again: nothing to do
  assert.deepEqual(fake.calls, ["flowchart A", "flowchart B", "flowchart C"]);
  diagram.destroy();
  assert.equal(host.childElementCount, 0);
});

test("the drawing is sanitized on the page side: no script, no handler, links leave in a new tab", async () => {
  const hostile = (_source: string, id: string) =>
    `<svg id="${id}" onload="alert(1)"><script>alert(1)</script>` +
    `<a href="javascript:alert(1)"><text>js</text></a><a href="https://example.com"><text>web</text></a></svg>`;
  const v = await mountViewer('flowchart LR\n  click A href "https://example.com"', fakeRenderer(hostile));
  await settle();
  const svg = v.container.querySelector(".md-mermaid-diagram svg")!;
  assert.doesNotMatch(svg.outerHTML, /<script|onload|javascript:/);
  const link = svg.querySelector('a[href="https://example.com"]');
  assert.equal(link?.getAttribute("target"), "_blank");
  assert.equal(link?.getAttribute("rel"), "noopener noreferrer");
  v.viewer.destroy();
});

test("behind the text view the viewer draws nothing, and catches up when it shows", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const v = await mountViewer("flowchart A");
  await settle();

  v.view.show(false); // the author switched to the Text view
  v.setText("flowchart B");
  t.mock.timers.tick(REDRAW_DEBOUNCE_MS * 3);
  await settle();
  v.setText("flowchart C");
  t.mock.timers.tick(REDRAW_DEBOUNCE_MS * 3);
  await settle();
  assert.deepEqual(v.fake.calls, ["flowchart A"], "no render while hidden");

  v.view.show(true);
  await settle();
  assert.deepEqual(v.drawn(), ["flowchart C"], "the latest text, once");
  assert.deepEqual(v.fake.calls, ["flowchart A", "flowchart C"]);
  v.viewer.destroy();
});

test("an engine that does not load rejects the mount: the shell falls back to the text", async () => {
  await assert.rejects(
    mountViewer("flowchart A", fakeRenderer(), () => Promise.reject(new Error("chunk failed"))),
    /chunk failed/,
  );
});

test("destroy leaves nothing behind: no pending redraw, no observer, no listener", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const v = await mountViewer("flowchart A");
  await settle();
  v.setText("flowchart B");
  v.viewer.destroy();
  assert.equal(v.container.childElementCount, 0);
  assert.equal(v.view.listeners.size, 0);
  t.mock.timers.tick(REDRAW_DEBOUNCE_MS);
  v.setText("flowchart C");
  t.mock.timers.tick(REDRAW_DEBOUNCE_MS);
  await settle();
  assert.deepEqual(v.fake.calls, ["flowchart A"]);
});
