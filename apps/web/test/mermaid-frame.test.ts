/**
 * The Mermaid frame (src/lib/mermaid-frame.ts, mermaid-frame.html) under
 * jsdom: the policy its document is written with, how the page finds the
 * frame's document and starts the frame, and the one frame a page shares.
 * jsdom runs no srcdoc and enforces no policy, so a fake frame stands in for
 * a started one; what a browser makes of the policy is checked in headless
 * Chromium (hostile-mermaid-chromium.ts, by hand), what mermaid writes into
 * the frame in mermaid-engine-hostile.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";

import {
  createMermaidFrameRenderer,
  fetchFrameHtml,
  MERMAID_FRAME_API,
  MERMAID_FRAME_MARKER,
  MERMAID_FRAME_URL,
  type MermaidFrame,
  type MermaidFrameApi,
  openMermaidFrame,
} from "../src/lib/mermaid-frame.ts";
import { createMermaidFence } from "../src/notations/markdown/mermaid-fence.ts";

const FRAME_HTML = readFileSync(new URL("../mermaid-frame.html", import.meta.url), "utf8");
const APP_HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const newWindow = () =>
  new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://designiq.test/r/acme/models/f/docs/guide.md",
    virtualConsole: new VirtualConsole(),
  }).window;

/** the policy of the frame's document, directive by directive */
function framePolicy(): Map<string, string[]> {
  const doc = new JSDOM(FRAME_HTML).window.document;
  const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  assert.ok(meta, "the frame's document carries its policy");
  const policy = new Map<string, string[]>();
  for (const directive of meta.getAttribute("content")!.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) policy.set(name, sources);
  }
  return policy;
}

test("the frame's policy: designIQ's own scripts, styles and fonts, nothing else", () => {
  const policy = framePolicy();
  assert.deepEqual(policy.get("default-src"), ["'none'"], "whatever is not named loads nothing");
  assert.deepEqual(policy.get("script-src"), ["'self'"], "no inline script, no handler, no javascript: link");
  assert.deepEqual(policy.get("img-src"), ["data:"], "no image from any address, the app's own included");
  assert.deepEqual(policy.get("font-src"), ["'self'"]);
  assert.deepEqual(policy.get("style-src"), ["'self'", "'unsafe-inline'"], "mermaid writes its styles inline");
  assert.deepEqual(policy.get("base-uri"), ["'none'"]);
  assert.deepEqual(policy.get("form-action"), ["'none'"]);
  // nothing else may name a source: media, frames and objects stay on default-src
  for (const [name, sources] of policy) {
    for (const source of sources) {
      assert.match(source, /^(?:'none'|'self'|'unsafe-inline'|data:)$/, `${name} ${source}`);
    }
  }
});

test("the frame's document: its policy before anything loads, its script the renderer's", () => {
  const doc = new JSDOM(FRAME_HTML).window.document;
  const head = [...doc.head.children];
  const policyAt = head.findIndex((el) => el.getAttribute("http-equiv") === "Content-Security-Policy");
  assert.ok(policyAt >= 0);
  assert.ok(
    head.slice(0, policyAt).every((el) => el.localName === "meta" && el.hasAttribute("charset")),
    "only the charset precedes the policy",
  );
  assert.ok(FRAME_HTML.includes(MERMAID_FRAME_MARKER), "the page can tell the frame's document from the app's");
  assert.ok(!APP_HTML.includes(MERMAID_FRAME_MARKER));
  const scripts = [...doc.querySelectorAll("script")];
  assert.deepEqual(
    scripts.map((s) => [s.getAttribute("type"), s.getAttribute("src"), s.textContent]),
    [["module", "/src/lib/mermaid-frame-entry.ts", ""]],
  );
});

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch;
});

/** answer the frame's address with `body` (or a status) */
function serve(body: string, status = 200): string[] {
  const asked: string[] = [];
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
    asked.push(url);
    return new Response(body, { status });
  };
  return asked;
}

test("fetchFrameHtml: the frame's document, never the app's index.html the Live Host answers an unknown path with", async () => {
  const asked = serve(FRAME_HTML);
  assert.equal(await fetchFrameHtml(), FRAME_HTML);
  assert.deepEqual(asked, [MERMAID_FRAME_URL]);
  serve(APP_HTML);
  await assert.rejects(fetchFrameHtml(), /is not the Mermaid frame/);
  serve("", 404);
  await assert.rejects(fetchFrameHtml(), /answered 404/);
});

/** jsdom runs no srcdoc: every frame `win` starts carries `render` as if its script had run */
function startFramesWith(win: ReturnType<typeof newWindow>, render: MermaidFrameApi["render"]): HTMLIFrameElement[] {
  const appended: HTMLIFrameElement[] = [];
  const append = win.document.body.append.bind(win.document.body);
  win.document.body.append = (...nodes: (Node | string)[]) => {
    for (const node of nodes) {
      if (node instanceof win.HTMLIFrameElement) {
        appended.push(node);
        Object.defineProperty(node, "contentWindow", { get: () => ({ [MERMAID_FRAME_API]: { render } }) });
      }
    }
    append(...nodes);
  };
  return appended;
}

test("openMermaidFrame: a hidden srcdoc frame, out of the tab order; one that does not start leaves nothing", async () => {
  const win = newWindow();
  const doc = win.document;
  // jsdom runs no srcdoc: the frame never carries its renderer
  await assert.rejects(openMermaidFrame(doc, FRAME_HTML), /did not start/);
  assert.equal(doc.querySelector("iframe"), null, "the failed frame is gone");

  const appended = startFramesWith(win, async () => ({ svg: "<svg></svg>" }));
  const frame = await openMermaidFrame(doc, FRAME_HTML);
  const element = appended[0]!;
  assert.equal(frame.element, element);
  assert.equal(element.srcdoc, FRAME_HTML);
  assert.equal(element.getAttribute("aria-hidden"), "true");
  assert.equal(element.getAttribute("tabindex"), "-1");
  assert.equal(element.style.visibility, "hidden");
  assert.equal(element.style.pointerEvents, "none");
  assert.equal(element.style.position, "fixed");
  assert.deepEqual(await frame.api.render("flowchart LR", "md"), { svg: "<svg></svg>" });
});

/** a started frame whose renderer answers with the source it got */
function fakeFrame(doc: Document, log: string[]): MermaidFrame {
  const element = doc.createElement("iframe");
  doc.body.append(element);
  return {
    element,
    api: {
      render: async (source, idPrefix) => {
        log.push(`${idPrefix}:${source}`);
        return { svg: `<svg><text>${source}</text></svg>` };
      },
    },
  };
}

test("createMermaidFrameRenderer: ONE frame for concurrent renders, as wide as the page's body", async () => {
  const doc = newWindow().document;
  Object.defineProperty(doc.body, "clientWidth", { value: 1234 });
  const log: string[] = [];
  let opened = 0;
  const render = createMermaidFrameRenderer({
    doc,
    open: async (d) => {
      opened++;
      return fakeFrame(d, log);
    },
  });
  const results = await Promise.all([render("A", "md-Mermaid"), render("B", "md-Mermaid")]);
  assert.equal(opened, 1);
  assert.deepEqual(results, [{ svg: "<svg><text>A</text></svg>" }, { svg: "<svg><text>B</text></svg>" }]);
  assert.deepEqual(log, ["md-Mermaid:A", "md-Mermaid:B"]);
  assert.equal(doc.querySelector("iframe")!.style.width, "1234px");
});

test("createMermaidFrameRenderer: a frame that does not start rejects, the next render starts another", async () => {
  const doc = newWindow().document;
  const log: string[] = [];
  let opened = 0;
  const render = createMermaidFrameRenderer({
    doc,
    open: async (d) => {
      if (++opened === 1) throw new Error("offline");
      return fakeFrame(d, log);
    },
  });
  await assert.rejects(render("A", "md"), /offline/);
  assert.deepEqual(await render("A", "md"), { svg: "<svg><text>A</text></svg>" });
  assert.equal(opened, 2);
});

test("createMermaidFrameRenderer: a frame taken off the page is started anew", async () => {
  const doc = newWindow().document;
  const log: string[] = [];
  let opened = 0;
  const render = createMermaidFrameRenderer({
    doc,
    open: async (d) => {
      opened++;
      return fakeFrame(d, log);
    },
  });
  await render("A", "md");
  doc.querySelector("iframe")!.remove();
  await render("B", "md");
  assert.equal(opened, 2);
  assert.equal(doc.querySelectorAll("iframe").length, 1);
});

test("the Markdown view's fence draws through the page's one Mermaid frame unless it is handed a renderer", async () => {
  const win = newWindow();
  const asked = serve(FRAME_HTML);
  const sources: string[] = [];
  const frames = startFramesWith(win, async (source) => {
    sources.push(source);
    return { svg: `<svg><text>drawn in the frame</text></svg>` };
  });
  // the app's renderer (renderMermaidInFrame) starts its frame in the page's global document
  const global = globalThis as { document?: Document };
  global.document = win.document;
  try {
    const article = win.document.body.appendChild(win.document.createElement("article"));
    const fence = createMermaidFence();
    article.innerHTML = fence.render("flowchart LR\n  A --> B", { lang: "mermaid", info: "mermaid" }) ?? "";
    await fence.hydrate(article, new win.AbortController().signal);
    assert.deepEqual(asked, [MERMAID_FRAME_URL], "the page fetched the frame's document");
    assert.equal(frames.length, 1, "and started its frame");
    assert.deepEqual(sources, ["flowchart LR\n  A --> B"]);
    assert.equal(article.querySelector(".md-mermaid-diagram svg")?.textContent, "drawn in the frame");
  } finally {
    delete global.document;
  }
});
