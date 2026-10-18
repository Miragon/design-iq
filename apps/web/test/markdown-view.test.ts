/**
 * The DOM half of the Markdown view under jsdom: the sanitizer
 * (src/notations/markdown/sanitize.ts), the second line of defence against
 * untrusted content, and the mounted view (src/notations/markdown/view.ts):
 * live re-rendering with its debounce, link clicks, the model list, the fence
 * hydration slot and a clean destroy. The pure renderer has its own suite,
 * markdown-render.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";
import * as Y from "yjs";

import type { FenceExtension } from "../src/notations/markdown/fences.ts";
import { createSanitizer } from "../src/notations/markdown/sanitize.ts";
import { mountMarkdownView, RENDER_DEBOUNCE_MS, RENDER_MAX_WAIT_MS } from "../src/notations/markdown/view.ts";
import type { EditorContext, ModelDirectory } from "../src/notations/registry.ts";

const DOC_URL = "https://designiq.test/r/acme/models/f/docs/guide.md";

/** a jsdom window; navigation the view leaves to the browser is not implemented there, so keep its console quiet */
const newWindow = (url = DOC_URL) =>
  new JSDOM("<!doctype html><html><body></body></html>", { url, virtualConsole: new VirtualConsole() }).window;

/** a model list the test controls, as the shell hands it over */
function modelList(initial?: string[]) {
  let paths: ReadonlySet<string> | undefined = initial && new Set(initial);
  const listeners = new Set<() => void>();
  const directory: ModelDirectory = {
    paths: () => paths,
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const set = (next: string[]): void => {
    paths = new Set(next);
    for (const cb of listeners) cb();
  };
  return { directory, listeners, set };
}

function mount(
  source: string,
  opts: { url?: string; models?: ModelDirectory; fences?: Record<string, FenceExtension> } = {},
) {
  const win = newWindow(opts.url);
  // no layout in jsdom: record what the view scrolls to
  const scrolled: string[] = [];
  win.Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, source);
  const opened: Array<[string, string]> = [];
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
    onOpenModel: (path, fragment) => opened.push([path, fragment]),
    models: opts.models,
  };
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const view = mountMarkdownView(container, ctx, opts.fences ?? {});
  const article = container.querySelector("article")!;
  const append = (text: string): void => ytext.insert(ytext.length, text);
  const click = (el: Element | null, init: MouseEventInit = {}): boolean =>
    el!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
  return { win, ytext, view, container, article, append, click, opened, errors, scrolled };
}

/** let the hydration microtasks run */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("the sanitizer keeps the renderer's markup and strips everything else", () => {
  const win = newWindow();
  const sanitize = createSanitizer(win);
  const clean = (html: string): string => {
    const box = win.document.createElement("div");
    box.append(sanitize(html));
    return box.innerHTML;
  };

  const hostile = clean(
    '<script>alert(1)</script><style>p{color:red}</style><p style="color:red" onclick="alert(1)">text</p>' +
      '<svg><circle onload="alert(1)"></circle></svg><math><mi>x</mi></math><iframe src="https://evil.example"></iframe>' +
      '<form action="https://evil.example"><input type="text" name="q"></form>' +
      '<img src="https://img.example/a.png" onerror="alert(1)" style="width:1px" data-track="1">',
  );
  assert.doesNotMatch(hostile, /<script|<style|<svg|<math|<iframe|<form|onclick|onerror|onload|style=|data-track/);
  assert.match(hostile, /<p>text<\/p>/);
  assert.match(hostile, /<img src="https:\/\/img.example\/a.png">/);
  // the only input there is: a disabled checkbox, whatever the markup asked for
  assert.match(hostile, /<input type="checkbox" disabled="">/);

  const links = clean(
    '<a href="javascript:alert(1)">js</a><a href="https://example.com" target="_blank" rel="opener">web</a>' +
      '<a href="#x" target="_top">top</a><a href="/r/acme/models/f/x.md" data-model-path="x.md" data-x="1">model</a>',
  );
  assert.match(links, /<a>js<\/a>/);
  assert.match(links, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">web<\/a>/);
  assert.match(links, /<a href="#x">top<\/a>/);
  assert.match(links, /<a href="\/r\/acme\/models\/f\/x.md" data-model-path="x.md">model<\/a>/);

  const ids = clean('<h2 id="md-intro">a</h2><h2 id="location">b</h2><input type="checkbox" checked>');
  assert.match(ids, /<h2 id="md-intro">a<\/h2><h2>b<\/h2>/);
  assert.match(ids, /<input type="checkbox" checked="" disabled="">/);
});

test("the view renders the live text, after a pause and at least once a second", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const v = mount("# One");
  assert.equal(v.article.querySelector("h1")?.id, "md-one");

  v.append("\n\nTwo");
  t.mock.timers.tick(RENDER_DEBOUNCE_MS - 1);
  assert.doesNotMatch(v.article.textContent, /Two/);
  t.mock.timers.tick(1);
  assert.match(v.article.textContent, /Two/);

  // a change every 100 ms never pauses long enough: the maximum wait shows it
  for (let i = 0; i < RENDER_MAX_WAIT_MS / 100; i++) {
    assert.doesNotMatch(v.article.textContent, /step/);
    v.append(` step${i}`);
    t.mock.timers.tick(100);
  }
  assert.match(v.article.textContent, /step9/);

  v.ytext.delete(0, v.ytext.length);
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  assert.equal(v.article.textContent, "This document is empty. Switch to Markdown to write it.");
  assert.deepEqual(v.errors, []);
  v.view.destroy();
});

test("a model link opens through the shell, an anchor scrolls, any other click is the browser's", () => {
  const v = mount("# Intro\n\n[next](./other.md#Scope) [up](#intro) [web](https://example.com)");
  const model = v.article.querySelector("a[data-model-path]");
  assert.equal(v.click(model), false, "a plain click is handled");
  assert.deepEqual(v.opened, [["docs/other.md", "Scope"]]);
  assert.equal(v.click(model, { metaKey: true }), true, "cmd-click opens a new tab");
  assert.equal(v.click(model, { ctrlKey: true }), true);
  assert.equal(v.click(model, { button: 1 }), true, "a middle click opens a new tab");
  assert.equal(v.opened.length, 1);

  assert.equal(v.click(v.article.querySelector('a[href="#intro"]')), false);
  assert.deepEqual(v.scrolled, ["md-intro"]);
  assert.equal(v.click(v.article.querySelector('a[target="_blank"]')), true);
  v.view.destroy();
});

test("opened with a #section, the view lands on that heading", () => {
  const v = mount("# Guide\n\n## Scope", { url: `${DOC_URL}#Scope` });
  assert.deepEqual(v.scrolled, ["md-scope"]);
  v.view.destroy();
});

test("links follow the model list: a path without a model is marked text once the list is there", () => {
  const models = modelList();
  const v = mount("[a](./a.md) [b](./b.md)", { models: models.directory });
  // still loading: the extension decides, the shell checks on click
  assert.equal(v.article.querySelectorAll("a[data-model-path]").length, 2);

  models.set(["docs/a.md"]);
  assert.deepEqual(
    [...v.article.querySelectorAll("a[data-model-path]")].map((a) => a.getAttribute("data-model-path")),
    ["docs/a.md"],
  );
  assert.equal(v.article.querySelector(".md-link-unavailable")?.textContent, "b");

  models.set(["docs/a.md", "docs/b.md"]);
  assert.equal(v.article.querySelectorAll("a[data-model-path]").length, 2);
  v.view.destroy();
  assert.equal(models.listeners.size, 0);
});

test("a fence extension hydrates only a document with its language, and a new render aborts the last", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const hydrated: string[] = [];
  const signals: AbortSignal[] = [];
  const fences: Record<string, FenceExtension> = {
    demo: {
      render: (content) => `<pre class="md-demo">${content.trim()}</pre>`,
      hydrate: (root, signal) => {
        hydrated.push(root.querySelector(".md-demo")?.textContent ?? "");
        signals.push(signal);
      },
    },
  };
  const v = mount("No diagram here.", { fences });
  await settle();
  assert.deepEqual(hydrated, [], "no fence of its language: the engine never loads");

  v.append("\n\n```demo\nA\n```\n");
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  assert.deepEqual(hydrated, ["A"]);

  v.append("\nMore text.");
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  assert.deepEqual(hydrated, ["A", "A"]);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[1]?.aborted, false);

  v.view.destroy();
  assert.equal(signals[1]?.aborted, true);
});

test("destroy leaves nothing behind: no pending render, no observer, no listener", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const models = modelList(["docs/a.md"]);
  const v = mount("# One", { models: models.directory });
  v.append("\n\nPending");
  v.view.destroy();
  assert.equal(v.container.childElementCount, 0);

  t.mock.timers.tick(RENDER_MAX_WAIT_MS);
  v.append("\n\nLater");
  t.mock.timers.tick(RENDER_MAX_WAIT_MS);
  models.set(["docs/a.md", "docs/b.md"]);
  assert.doesNotMatch(v.article.textContent, /Pending|Later/);
  assert.equal(models.listeners.size, 0);
});
