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
import type { EditorContext, LayerVisibility, ModelDirectory } from "../src/notations/registry.ts";

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

type RepoWebSource = NonNullable<EditorContext["repoWeb"]>;
type RepoWeb = NonNullable<ReturnType<RepoWebSource["get"]>>;

/** the repository's GitHub address the test hands over, maybe later */
function repoWebOf(initial?: RepoWeb) {
  let web = initial;
  const listeners = new Set<() => void>();
  const source: RepoWebSource = {
    get: () => web,
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const set = (next: RepoWeb): void => {
    web = next;
    for (const cb of listeners) cb();
  };
  return { source, listeners, set };
}

/** the shell's view switch, as the test drives it */
function layer(shown = true) {
  const listeners = new Set<() => void>();
  const visibility: LayerVisibility = {
    visible: () => shown,
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const show = (next: boolean): void => {
    shown = next;
    for (const cb of listeners) cb();
  };
  return { visibility, listeners, show };
}

function mount(
  source: string,
  opts: {
    url?: string;
    models?: ModelDirectory;
    repoWeb?: RepoWebSource;
    visibility?: LayerVisibility;
    fences?: Record<string, FenceExtension>;
  } = {},
) {
  const win = newWindow(opts.url);
  // no layout in jsdom: record what the view scrolls to
  const scrolled: string[] = [];
  win.Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
  win.Element.prototype.scrollTo = function (this: Element) {
    scrolled.push("top");
  } as Element["scrollTo"];
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
    repoWeb: opts.repoWeb,
    visibility: opts.visibility,
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
  // an image from another site the reader did not load keeps no address (#290)
  assert.match(hostile, /<img>/);
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

  const button = clean(
    '<button type="submit" formaction="https://evil.example" onclick="x()" data-image-src="https://a.example/x.png">Load image</button>',
  );
  assert.equal(button, '<button type="button" data-image-src="https://a.example/x.png">Load image</button>');

  // GitHub's HTML subset passes, without a handler: <details ontoggle> fires with no click at all
  const subset = clean(
    '<details open ontoggle="alert(1)"><summary onclick="alert(1)">s</summary>a<br onmouseover="alert(1)">b</details>' +
      '<p>H<sub>2</sub>O x<sup style="color:red">2</sup> <kbd onfocus="alert(1)" tabindex="0">K</kbd></p>',
  );
  assert.equal(
    subset,
    '<details open=""><summary>s</summary>a<br>b</details><p>H<sub>2</sub>O x<sup>2</sup> <kbd>K</kbd></p>',
  );

  // footnotes: the section of the notes, and the labels of the links between them and their references
  const footnotes =
    '<p>x<sup class="md-footnote-ref"><a href="#Footnote-1" id="md-Footnote-ref-1" aria-label="Footnote 1">1</a></sup></p>' +
    '<section class="md-footnotes" aria-label="Footnotes"><ol><li id="md-Footnote-1"><p>n ' +
    '<a href="#Footnote-ref-1" class="md-footnote-backref" aria-label="Back to reference 1"></a></p></li></ol></section>';
  assert.equal(clean(footnotes.replace("<section ", '<section onclick="alert(1)" ')), footnotes);
});

test("the sanitizer lets an image load from this origin or inline data, from another site only once the reader chose it", () => {
  const win = newWindow();
  const chosen = new Set<string>();
  const sanitize = createSanitizer(win, { externalImages: chosen });
  const sources = (html: string): Array<string | null> => {
    const box = win.document.createElement("div");
    box.append(sanitize(html));
    return [...box.querySelectorAll("img")].map((img) => img.getAttribute("src"));
  };
  const html =
    '<img src="/api/repos/acme/models/image?path=docs%2Fa.png"><img src="data:image/png;base64,AAAA">' +
    '<img src="https://designiq.test/api/repos/acme/models/image?path=b.png"><img src="https://img.example/a.png">' +
    '<img src="//img.example/b.png"><img src="/\\img.example/c.png"><img src="http://designiq.test/x.png">';
  assert.deepEqual(sources(html), [
    "/api/repos/acme/models/image?path=docs%2Fa.png",
    "data:image/png;base64,AAAA",
    "https://designiq.test/api/repos/acme/models/image?path=b.png",
    null,
    null,
    null,
    null,
  ]);

  chosen.add("https://img.example/a.png");
  const box = win.document.createElement("div");
  box.append(sanitize('<img src="https://img.example/a.png" referrerpolicy="unsafe-url">'));
  assert.equal(box.innerHTML, '<img src="https://img.example/a.png" referrerpolicy="no-referrer">');
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
  assert.equal(v.article.textContent, "This document is empty. Write it in the Markdown source.");
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

test("an anchor click puts its section in the address, replacing it, the router's state kept and its hash scroll off", () => {
  const v = mount("# Intro\n\n## Scope\n\n[scope](#scope) [self](./guide.md#intro) [top](./guide.md)", {
    url: `${DOC_URL}?view=split`,
  });
  v.win.history.replaceState({ __TSR_key: "k1", __TSR_index: 3 }, "");
  const entries = v.win.history.length;
  assert.equal(v.click(v.article.querySelector('a[href="#scope"]')), false);
  assert.equal(v.win.location.hash, "#scope");
  assert.equal(v.click(v.article.querySelector('a[href="#intro"]')), false);
  assert.equal(v.win.location.href, `${DOC_URL}?view=split#intro`);
  // the document itself, no section: the top, and an address without one
  assert.equal(v.click(v.article.querySelector('a[href="#"]')), false);
  assert.equal(v.win.location.href, `${DOC_URL}?view=split`);
  // the router scrolls to the bare fragment, which names no anchor of the view
  assert.deepEqual(v.win.history.state, { __TSR_key: "k1", __TSR_index: 3, __hashScrollIntoViewOptions: false });
  assert.equal(v.win.history.length, entries, "no history entry per click");
  assert.deepEqual(v.scrolled, ["md-scope", "md-intro", "top"]);
  v.view.destroy();
});

test("a GitHub link to a model of the repository opens through the shell once its address is known", () => {
  const web = repoWebOf();
  const v = mount("[order](https://github.com/acme/models/blob/main/processes/order.bpmn#Ship)", {
    repoWeb: web.source,
  });
  // the host's configuration or the repository list still loading: GitHub's link
  assert.equal(v.article.querySelector("a")?.getAttribute("target"), "_blank");
  web.set({ base: "https://github.com", defaultBranch: "main" });
  const link = v.article.querySelector("a")!;
  assert.equal(link.getAttribute("href"), "/r/acme/models/f/processes/order.bpmn#Ship");
  assert.equal(v.click(link), false);
  assert.deepEqual(v.opened, [["processes/order.bpmn", "Ship"]]);
  v.view.destroy();
  assert.equal(web.listeners.size, 0, "destroy unsubscribes");
});

test("an image from another site loads only once the reader asks, for as long as the view lives (#290)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const source = "# Status\n\n![CI badge](https://img.example.com/ci.svg) ![Coverage](https://img.example.com/cov.svg)";
  const v = mount(source);
  assert.equal(v.article.querySelectorAll("img").length, 0, "nothing is fetched from the other site unasked");
  const buttons = v.article.querySelectorAll<HTMLButtonElement>("button.md-image-load");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0]!.getAttribute("aria-label"), "Load image CI badge from img.example.com");

  buttons[0]!.focus();
  assert.equal(v.click(buttons[0]!), false, "the view handles the click");
  const loaded = v.article.querySelector("img");
  assert.equal(loaded?.getAttribute("src"), "https://img.example.com/ci.svg");
  assert.equal(loaded?.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(v.article.querySelectorAll("button.md-image-load").length, 1, "the other image is still only offered");
  assert.equal(v.win.document.activeElement, v.container.querySelector(".markdown-view"), "focus stays in the view");

  // a co-editor's change re-renders: the choice holds
  v.append("\n\nmore");
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  assert.match(v.article.textContent, /more/);
  assert.equal(v.article.querySelector("img")?.getAttribute("src"), "https://img.example.com/ci.svg");
  v.view.destroy();

  // and is never stored: the next view of the document asks again
  const again = mount(source);
  assert.equal(again.article.querySelectorAll("img").length, 0);
  again.view.destroy();
});

test("a repository image loads from the Live Host; one that does not load becomes a placeholder and stays one", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const v = mount("![Process map](./assets/map.png) ![](../logo.svg)");
  const [map, logo] = [...v.article.querySelectorAll("img")];
  assert.equal(map?.getAttribute("src"), "/api/repos/acme/models/image?path=docs%2Fassets%2Fmap.png");
  assert.equal(logo?.getAttribute("src"), "/api/repos/acme/models/image?path=logo.svg");

  map!.dispatchEvent(new v.win.Event("error"));
  const placeholder = v.article.querySelector(".md-image-placeholder");
  assert.equal(placeholder?.textContent, "Image not shown: Process map");
  assert.equal(placeholder?.getAttribute("title"), "docs/assets/map.png");
  assert.equal(v.article.querySelectorAll("img").length, 1);

  v.append(" ![](../logo.svg)");
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  assert.equal(v.article.querySelector(".md-image-placeholder")?.textContent, "Image not shown: Process map");
  assert.deepEqual(
    [...v.article.querySelectorAll("img")].map((img) => img.getAttribute("src")),
    ["/api/repos/acme/models/image?path=logo.svg", "/api/repos/acme/models/image?path=logo.svg"],
  );
  assert.deepEqual(v.errors, []);
  v.view.destroy();
});

test("a <details> section opens on its summary, which shows a Lucide chevron, not the browser's triangle", () => {
  const v = mount("<details>\n<summary>More</summary>\n\nHidden **text**\n\n</details>\n\n<summary>stray</summary>");
  const details = v.article.querySelector("details")!;
  assert.equal(details.open, false);
  assert.match(details.querySelector("p")!.innerHTML, /Hidden <strong>text<\/strong>/);
  const summary = details.querySelector("summary")!;
  const chevron = summary.firstElementChild!;
  assert.equal(chevron.tagName.toLowerCase(), "svg");
  assert.equal(chevron.getAttribute("class"), "icon md-summary-icon");
  assert.equal(chevron.getAttribute("aria-hidden"), "true");
  assert.equal(summary.textContent, "More");
  assert.equal(v.article.querySelectorAll("svg").length, 1, "a summary outside a <details> discloses nothing");
  assert.equal(v.click(summary), true, "the view leaves the click to the browser");
  assert.equal(details.open, true);
  v.view.destroy();
});

test("a footnote reference scrolls to its note, and the note's Lucide arrow back to the reference", () => {
  const v = mount("## Footnote 1\n\nText[^1] and again[^1].\n\n[^1]: The note.");
  const reference = v.article.querySelector("sup.md-footnote-ref > a")!;
  assert.equal(reference.textContent, "1");
  assert.equal(reference.getAttribute("aria-label"), "Footnote 1");
  assert.equal(v.click(reference), false, "the view scrolls");
  assert.deepEqual(v.scrolled, ["md-Footnote-1"], "to the note, not to the heading of the same words");

  const notes = v.article.querySelector("section.md-footnotes")!;
  assert.equal(notes.getAttribute("aria-label"), "Footnotes");
  const back = notes.querySelectorAll("a.md-footnote-backref");
  assert.equal(back.length, 2, "one link back per reference");
  assert.equal(back[1]!.getAttribute("aria-label"), "Back to reference 1-2");
  assert.equal(back[1]!.textContent, "2");
  const arrow = back[1]!.firstElementChild!;
  assert.equal(arrow.tagName.toLowerCase(), "svg");
  assert.equal(arrow.getAttribute("class"), "icon md-footnote-backref-icon");
  assert.equal(arrow.getAttribute("aria-hidden"), "true");
  assert.equal(v.click(arrow), false, "a click on the arrow is one on its link");
  assert.deepEqual(v.scrolled, ["md-Footnote-1", "md-Footnote-ref-1-2"]);
  v.view.destroy();

  // an address with a note's fragment lands on the note
  const linked = mount("Text[^1].\n\n[^1]: The note.", { url: `${DOC_URL}#Footnote-1` });
  assert.deepEqual(linked.scrolled, ["md-Footnote-1"]);
  linked.view.destroy();
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

test("a fence extension hydrates once more after its last fence is gone, with no block", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const hydrated: number[] = [];
  const fences: Record<string, FenceExtension> = {
    demo: {
      render: (content) => `<pre class="md-demo">${content.trim()}</pre>`,
      hydrate: (root) => void hydrated.push(root.querySelectorAll(".md-demo").length),
    },
  };
  const v = mount("```demo\nA\n```\n", { fences });
  await settle();
  v.ytext.delete(0, v.ytext.length);
  v.append("No fence now.");
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  v.append(" Still none.");
  t.mock.timers.tick(RENDER_DEBOUNCE_MS);
  await settle();
  assert.deepEqual(hydrated, [1, 0], "once with no block, to forget the document; then not at all");
  v.view.destroy();
});

test("behind the source layer the view does not render; it catches up when it shows", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const hydrated: string[] = [];
  const fences: Record<string, FenceExtension> = {
    demo: {
      render: (content) => `<pre class="md-demo">${content.trim()}</pre>`,
      hydrate: (root) => void hydrated.push(root.querySelector(".md-demo")?.textContent ?? ""),
    },
  };
  const view = layer();
  const v = mount("# One\n\n```demo\nA\n```\n", { fences, visibility: view.visibility });
  await settle();
  assert.deepEqual(hydrated, ["A"]);

  view.show(false); // the author switched to the Markdown source
  v.append("\n```demo\nB\n```\n");
  t.mock.timers.tick(RENDER_MAX_WAIT_MS);
  await settle();
  assert.doesNotMatch(v.article.textContent, /B/, "nothing rendered while hidden");
  assert.deepEqual(hydrated, ["A"], "and no fence hydrated");

  view.show(true);
  assert.match(v.article.textContent, /B/, "shown again: the latest text at once");
  await settle();
  assert.deepEqual(hydrated, ["A", "A"]);

  view.show(false);
  view.show(true); // nothing changed meanwhile: nothing to render
  await settle();
  assert.equal(hydrated.length, 2);
  v.view.destroy();
  assert.equal(view.listeners.size, 0);
});

test("opened behind the source layer, the view renders nothing until it shows: no fence hydrates, no section is landed on", async () => {
  const hydrated: string[] = [];
  const fences: Record<string, FenceExtension> = {
    demo: {
      render: (content) => `<pre class="md-demo">${content.trim()}</pre>`,
      hydrate: (root) => void hydrated.push(root.querySelector(".md-demo")?.textContent ?? ""),
    },
  };
  const view = layer(false); // the view switch remembered the Markdown source
  const v = mount("# Guide\n\n## Scope\n\n```demo\nA\n```\n", {
    url: `${DOC_URL}#Scope`,
    fences,
    visibility: view.visibility,
  });
  await settle();
  assert.equal(v.article.childElementCount, 0, "nothing rendered");
  assert.deepEqual(hydrated, [], "the diagram engine never loads for a hidden document");
  assert.deepEqual(v.scrolled, []);

  view.show(true);
  assert.equal(v.article.querySelector("h2")?.id, "md-scope");
  assert.deepEqual(v.scrolled, ["md-scope"], "the link's section, once the document is on screen");
  await settle();
  assert.deepEqual(hydrated, ["A"]);

  view.show(false);
  view.show(true);
  assert.deepEqual(v.scrolled, ["md-scope"], "landed once");
  v.view.destroy();
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
