/**
 * The Markdown view's pure renderer (src/notations/markdown/render.ts):
 * CommonMark plus the GFM extensions, heading anchors, the escaping of
 * untrusted content, links between the models of a repository and the fence
 * hook a diagram renderer plugs into. The DOM half (DOMPurify, clicks,
 * scrolling) has its own suite, markdown-view.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  anchorId,
  classifyHref,
  classifyImage,
  type FenceInfo,
  modelRoute,
  renderMarkdown,
  resolveRepoPath,
  slugify,
} from "../src/notations/markdown/render.ts";

const REPO = "acme/models";
const DOC = "docs/use-cases/bike-leasing/feature-map/feature-map.md";
const render = (source: string, fences = {}) => renderMarkdown(source, { repo: REPO, docPath: DOC, fences });

test("headings get GitHub-style slugs as prefixed anchor ids, numbered when repeated", () => {
  const html = render("# Bike Leasing: the Process\n\n## Open `items`?\n\n## Intro\n\n## Intro\n\n## Über uns");
  assert.match(html, /<h1 id="md-bike-leasing-the-process">Bike Leasing: the Process<\/h1>/);
  assert.match(html, /<h2 id="md-open-items">Open <code>items<\/code>\?<\/h2>/);
  assert.match(html, /<h2 id="md-intro">Intro<\/h2>/);
  assert.match(html, /<h2 id="md-intro-1">Intro<\/h2>/);
  assert.match(html, /<h2 id="md-über-uns">/);
  assert.equal(slugify("  Rules & Gateways (v2)  "), "rules--gateways-v2");
  assert.equal(anchorId("intro"), "md-intro");
});

test("GFM tables render with a header row and alignment as a class, never a style", () => {
  const html = render("| Step | Owner | Days |\n|:--|:-:|--:|\n| Check | Sales | 2 |");
  assert.match(html, /<table>\s*<thead>\s*<tr>\s*<th class="align-left">Step<\/th>/);
  assert.match(html, /<th class="align-center">Owner<\/th>/);
  assert.match(html, /<tbody>\s*<tr>\s*<td class="align-left">Check<\/td>/);
  assert.match(html, /<td class="align-right">2<\/td>/);
  assert.doesNotMatch(html, /style=/);
});

test("task lists, strikethrough and autolinks follow GFM", () => {
  const html = render(
    "- [ ] open\n- [x] done\n- plain\n\n~~gone~~ https://example.com www.miragon.io mail@example.com",
  );
  assert.match(html, /<ul class="contains-task-list">/);
  assert.match(
    html,
    /<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> open<\/li>/,
  );
  assert.match(html, /<input type="checkbox" class="task-list-item-checkbox" disabled checked> done/);
  assert.match(html, /<li>plain<\/li>/);
  assert.match(html, /<s>gone<\/s>/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, /<a href="http:\/\/www.miragon.io" target="_blank" rel="noopener noreferrer">www.miragon.io<\/a>/);
  assert.match(html, /<a href="mailto:mail@example.com">mail@example.com<\/a>/);
});

test("an escaped task marker is text, not a checkbox", () => {
  const html = render("- \\[ ] not a task\n- [x] a task");
  assert.match(html, /<li>\[ \] not a task<\/li>/);
  assert.match(html, /<li class="task-list-item"><input [^>]+ checked> a task<\/li>/);
  assert.equal(html.match(/<input /g)?.length, 1);
});

test("GFM footnotes render as on GitHub: numbered references, the notes at the end with links back", () => {
  const html = render(
    "Text[^b] and again[^b], then[^a].\n\n[^a]: The **first** defined,\n    on [a model](../a.bpmn).\n\n" +
      "    Its second paragraph.\n[^b]: The first referenced.\n\n[^unused]: Never referred to.\n\n" +
      "[ref]: https://example.com\n\nSee [ref], [^missing], [^a b]: and ^[an inline note].",
  );
  // a reference is its note's number, superscript, numbered in the order of the first references
  assert.match(
    html,
    /^<p>Text<sup class="md-footnote-ref"><a href="#Footnote-1" id="md-Footnote-ref-1" aria-label="Footnote 1">1<\/a><\/sup>/,
  );
  assert.match(html, /again<sup class="md-footnote-ref"><a href="#Footnote-1" id="md-Footnote-ref-1-2" [^>]+>1<\/a>/);
  assert.match(html, /then<sup class="md-footnote-ref"><a href="#Footnote-2" id="md-Footnote-ref-2" [^>]+>2<\/a>/);
  // the notes: a list at the end, each with a link back to every reference to it
  assert.match(html, /<\/p>\n<section class="md-footnotes" aria-label="Footnotes">\n<ol>\n<li id="md-Footnote-1">/);
  assert.match(
    html,
    /<li id="md-Footnote-1"><p>The first referenced. <a href="#Footnote-ref-1" class="md-footnote-backref" aria-label="Back to reference 1"><\/a> <a href="#Footnote-ref-1-2" class="md-footnote-backref" aria-label="Back to reference 1-2"><sup>2<\/sup><\/a><\/p>\n<\/li>/,
  );
  assert.match(
    html,
    /<li id="md-Footnote-2"><p>The <strong>first<\/strong> defined,\non <a href="[^"]+\/a.bpmn" data-model-path=/,
  );
  assert.match(
    html,
    /<p>Its second paragraph. <a href="#Footnote-ref-2" [^>]+><\/a><\/p>\n<\/li>\n<\/ol>\n<\/section>\n$/,
  );
  // a definition nothing refers to is not shown; the rest stays text, as on GitHub
  assert.doesNotMatch(html, /Never referred to|Footnote-3/);
  assert.match(html, /\[\^missing\], \[\^a b\]: and \^\[an inline note\]\./);
  // an ordinary reference definition still works
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">ref<\/a>/);
  // a note's ids never take a heading's: a heading slug is lower-case
  assert.match(
    render("## Footnote 1\n\nText[^1].\n\n[^1]: Note."),
    /<h2 id="md-footnote-1">[\s\S]+<li id="md-Footnote-1">/,
  );
});

test("footnote labels match as on GitHub: in any case, and a label defined twice keeps its first note", () => {
  assert.match(
    render("Text[^Note].\n\n[^note]: The note."),
    /^<p>Text<sup class="md-footnote-ref"><a href="#Footnote-1" [^>]+>1<\/a><\/sup>\.<\/p>\n<section [^>]+>\n<ol>\n<li id="md-Footnote-1"><p>The note\. /,
  );
  const twice = render("A[^x] and B[^X].\n\n[^x]: first.\n\n[^X]: second.");
  assert.match(twice, /B<sup class="md-footnote-ref"><a href="#Footnote-1" id="md-Footnote-ref-1-2" /);
  assert.match(
    twice,
    /<li id="md-Footnote-1"><p>first\. <a href="#Footnote-ref-1" [^>]+><\/a> <a href="#Footnote-ref-1-2"/,
  );
  assert.doesNotMatch(twice, /second|Footnote-2/);
});

test("file names are not autolinked although their extension reads as a top-level domain", () => {
  const html = render("Edit README.md and feature-map.md, then run setup.sh.");
  assert.doesNotMatch(html, /<a /);
});

test("raw HTML outside GitHub's subset is escaped, never passed through", () => {
  const html = render(
    '<script>alert(1)</script>\n\nText <img src=x onerror="alert(1)"> and <a href="javascript:alert(1)">x</a>\n\n' +
      '<div align="center">\n<b>logo</b>\n</div>\n\n| a | b |\n|---|---|\n| one<b>two</b> | x |\n\n' +
      '<details>\n<div onclick="alert(1)">inside</div>\n',
  );
  assert.doesNotMatch(html, /<script|<img|<a |<div|<b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /<p>&lt;div align=&quot;center&quot;&gt;\n&lt;b&gt;logo&lt;\/b&gt;\n&lt;\/div&gt;<\/p>/);
  assert.match(html, /<td>one&lt;b&gt;two&lt;\/b&gt;<\/td>/);
  // next to a passed tag, any other one is text all the same
  assert.match(html, /<details>\n&lt;div onclick=&quot;alert\(1\)&quot;&gt;inside&lt;\/div&gt;\n/);
});

test("GitHub's raw HTML subset renders as bare tags: br, details, summary, sub, sup, kbd", () => {
  const table = render("| a | b |\n|---|---|\n| one<br>two | a<br/>b<br />c<BR>d</br>e |");
  assert.match(table, /<td>one<br>two<\/td>/);
  assert.match(table, /<td>a<br>b<br>c<br>d<br>e<\/td>/);

  // a collapsible section: Markdown after a blank line renders inside it
  const details = render(
    '<details open ontoggle=alert(1) class="x">\n<summary onclick="x()">More <b>info</b> &amp; Q&A</summary>\n\n' +
      "- an **item**\n\n</details>",
  );
  assert.equal(
    details,
    "<details open>\n<summary>More &lt;b&gt;info&lt;/b&gt; &amp; Q&amp;A</summary>\n" +
      "<ul>\n<li>an <strong>item</strong></li>\n</ul>\n</details>\n",
  );
  assert.match(render('<details class="open"><summary>s</summary></details>'), /^<details><summary>s<\/summary>/);

  const inline = render('H<sub>2</sub>O, x<sup title="t">2</sup>, <kbd onclick="alert(1)">Ctrl</kbd>+<kbd/>C</KBD>');
  assert.equal(inline, "<p>H<sub>2</sub>O, x<sup>2</sup>, <kbd>Ctrl</kbd>+<kbd>C</kbd></p>\n");
  // no attribute of the document's reaches the page
  assert.doesNotMatch(details + inline, /ontoggle|onclick|class=|title=/);
});

test("an HTML block keeps its paragraph unless it opens or closes a collapsible section", () => {
  // a README header: its line break passes, the rest is escaped text in one paragraph
  assert.equal(
    render('<p align="center">\n<img src="logo.png"><br>\n<b>Name</b>\n</p>\n\nNext paragraph.'),
    "<p>&lt;p align=&quot;center&quot;&gt;\n&lt;img src=&quot;logo.png&quot;&gt;<br>\n&lt;b&gt;Name&lt;/b&gt;\n" +
      "&lt;/p&gt;</p>\n<p>Next paragraph.</p>\n",
  );
  assert.equal(render("<pre>\na<br>b\n</pre>"), "<p>&lt;pre&gt;\na<br>b\n&lt;/pre&gt;</p>\n");
  assert.equal(render("<sub>\nnote\n</sub>"), "<p><sub>\nnote\n</sub></p>\n");
  assert.equal(render("<details>\n<summary>More</summary>"), "<details>\n<summary>More</summary>\n");
  assert.equal(render("</details>"), "</details>\n");
});

test("HTML comments stay hidden, as on GitHub, and their lines are not Markdown", () => {
  const html = render(
    "# ADR <!-- number -->\n\nIntro\n\n<!--\nHow to use this template:\n- delete this note\n-->\n\n" +
      "Text <!-- inline --> after\n\n<!-- markdownlint-disable MD013 -->\n\nTail\n\n<!-- never closed\n\n- gone",
  );
  assert.match(html, /<h1 id="md-adr">ADR <\/h1>/);
  assert.match(html, /<p>Text {2}after<\/p>/);
  assert.match(html, /<p>Tail<\/p>/);
  assert.doesNotMatch(html, /&lt;!--|--&gt;|How to use|delete this note|markdownlint|never closed|gone/);
  assert.doesNotMatch(html, /<ul>/);
});

test("a link with a scheme but http(s), mailto: and tel: is marked text, not a dead link", () => {
  const html = render(
    "[d](data:image/png;base64,AAAA) [open](vscode://file/x) [doc](ms-word:ofe|u|x) [m](mailto:a@b.c) [t](tel:+4989)",
  );
  assert.match(html, /<span class="md-link-unavailable" title="A data: link does not open from designIQ">d<\/span>/);
  assert.match(html, /title="A vscode: link does not open from designIQ">open<\/span>/);
  assert.match(html, /title="A ms-word: link does not open from designIQ">doc<\/span>/);
  assert.match(html, /<a href="mailto:a@b.c">m<\/a> <a href="tel:\+4989">t<\/a>/);
});

test("javascript:, vbscript: and data: links are neutralised", () => {
  const html = render(
    "[a](javascript:alert(1)) [b](JAVASCRIPT:alert(1)) [c](vbscript:msgbox) [d](data:text/html;base64,PHNjcmlwdD4=)\n\n" +
      "![e](javascript:alert(1)) <javascript:alert(1)>",
  );
  assert.doesNotMatch(html, /href=|src=/);
  assert.match(html, /\[a\]\(javascript:alert\(1\)\)/);
});

test("a relative link to another model becomes its in-app route, #section included", () => {
  const html = render(
    "[process](../process/executable-process.md#Gateway-rules) [map](./bike-leasing-feature-map.bpmn) " +
      "[root](/docs/glossary.md) [spaced](../process/my%20notes.md)",
  );
  assert.match(
    html,
    /<a href="\/r\/acme\/models\/f\/docs\/use-cases\/bike-leasing\/process\/executable-process.md#Gateway-rules" data-model-path="docs\/use-cases\/bike-leasing\/process\/executable-process.md">process<\/a>/,
  );
  assert.match(
    html,
    /href="\/r\/acme\/models\/f\/docs\/use-cases\/bike-leasing\/feature-map\/bike-leasing-feature-map.bpmn" data-model-path="[^"]+">map</,
  );
  assert.match(html, /href="\/r\/acme\/models\/f\/docs\/glossary.md"/);
  assert.match(html, /href="\/r\/acme\/models\/f\/docs\/use-cases\/bike-leasing\/process\/my%20notes.md"/);
  assert.match(html, /data-model-path="docs\/use-cases\/bike-leasing\/process\/my notes.md"/);
  assert.doesNotMatch(html, /target=/);
});

test("in-page anchors stay anchors, a link to the document itself too", () => {
  const html = render("[up](#scope) [self](./feature-map.md#open-points) [top](feature-map.md)");
  assert.match(html, /<a href="#scope">up<\/a>/);
  assert.match(html, /<a href="#open-points">self<\/a>/);
  assert.match(html, /<a href="#">top<\/a>/);
});

test("a link to a file designIQ does not open is marked text, not a dead link", () => {
  const html = render("[source](../../../../service/App.kt) [adrs](../../../adr/) [escape](../../../../../../x.md)");
  assert.doesNotMatch(html, /<a /);
  assert.match(
    html,
    /<span class="md-link-unavailable" title="service\/App.kt is not a model of this repository, so it does not open in designIQ">source<\/span>/,
  );
  assert.match(html, /title="docs\/adr\/ is not a model of this repository, so it does not open in designIQ">adrs</);
  assert.match(html, /title="This link points outside the repository">escape</);
});

test("a GitHub link to a model of this repository on its default branch opens in designIQ; any other stays a web link", () => {
  const repoWeb = { base: "https://github.com", defaultBranch: "main" };
  const models = new Set(["docs/use-cases/bike-leasing/process/executable-process.md", "processes/order.bpmn"]);
  const at = "https://github.com/acme/models/blob";
  const html = renderMarkdown(
    `[process](${at}/main/docs/use-cases/bike-leasing/process/executable-process.md#Gateway-rules) ` +
      `[cased](https://github.com/Acme/Models/blob/main/processes/order.bpmn) ` +
      `[self](${at}/main/${DOC}#scope) ${at}/main/processes/order.bpmn ` +
      `[branch](${at}/feature/x/processes/order.bpmn) [commit](${at}/4f2c1e9/processes/order.bpmn) ` +
      `[other repo](https://github.com/acme/other/blob/main/processes/order.bpmn) ` +
      `[folder](https://github.com/acme/models/tree/main/processes) [source](${at}/main/src/app.ts) ` +
      `[unlisted](${at}/main/processes/old.bpmn) [enterprise](https://ghe.example.com/acme/models/blob/main/processes/order.bpmn)`,
    { repo: REPO, docPath: DOC, models, repoWeb },
  );
  assert.match(
    html,
    /<a href="\/r\/acme\/models\/f\/docs\/use-cases\/bike-leasing\/process\/executable-process.md#Gateway-rules" data-model-path="docs\/use-cases\/bike-leasing\/process\/executable-process.md">process<\/a>/,
  );
  assert.match(
    html,
    /<a href="\/r\/acme\/models\/f\/processes\/order.bpmn" data-model-path="processes\/order.bpmn">cased<\/a>/,
  );
  assert.match(html, /<a href="#scope">self<\/a>/);
  // a bare address too: autolinked, it is a link like any other
  assert.match(
    html,
    /<a href="\/r\/acme\/models\/f\/processes\/order.bpmn" data-model-path="processes\/order.bpmn">https:/,
  );
  // another branch or a commit is another version than designIQ shows; a
  // folder, a file that is no model and another host are not designIQ's to
  // open: GitHub shows them, never inert text
  for (const name of ["branch", "commit", "other repo", "folder", "source", "unlisted", "enterprise"]) {
    assert.match(
      html,
      new RegExp(`<a href="https://[^"]+" target="_blank" rel="noopener noreferrer">${name}</a>`),
      name,
    );
  }
  assert.doesNotMatch(html, /md-link-unavailable/);

  // GitHub Enterprise: its own address, a branch with a "/" in its name
  const enterprise = { base: "https://ghe.example.com/", defaultBranch: "release/2026" };
  const web = { repo: REPO, ...enterprise };
  assert.deepEqual(
    classifyHref("https://ghe.example.com/acme/models/blob/release/2026/processes/order.bpmn#Ship", DOC, models, web),
    {
      kind: "model",
      path: "processes/order.bpmn",
      fragment: "Ship",
    },
  );
  assert.deepEqual(
    classifyHref("https://ghe.example.com/acme/models/blob/release/processes/order.bpmn", DOC, models, web),
    {
      kind: "external",
    },
  );
  // without the repository's GitHub address (still loading), GitHub is a web link
  assert.match(
    render(`[process](${at}/main/processes/order.bpmn)`),
    /<a href="https:\/\/github.com\/acme\/models\/blob\/main\/processes\/order.bpmn" target="_blank"/,
  );
});

test("with the model list, only a model of the repository is a link", () => {
  const models = new Set(["docs/use-cases/bike-leasing/process/executable-process.md"]);
  const html = renderMarkdown(
    "[process](../process/executable-process.md) [contributing](../../../../CONTRIBUTING.md) [gone](../process/old.bpmn)",
    { repo: REPO, docPath: DOC, models },
  );
  assert.match(html, /<a href="[^"]+executable-process.md" data-model-path="[^"]+">process<\/a>/);
  assert.match(
    html,
    /<span class="md-link-unavailable" title="CONTRIBUTING.md is not a model of this repository, so it does not open in designIQ">contributing<\/span>/,
  );
  assert.match(html, /title="docs\/use-cases\/bike-leasing\/process\/old.bpmn is not a model[^"]*">gone<\/span>/);
  assert.deepEqual(classifyHref("../../../../CONTRIBUTING.md", DOC, models), { kind: "file", path: "CONTRIBUTING.md" });
  // without the list (still loading) the extension decides
  assert.equal(classifyHref("../../../../CONTRIBUTING.md", DOC).kind, "model");
});

test("link targets classify and resolve against the document's folder", () => {
  assert.deepEqual(classifyHref("../process/x.md#a", DOC), {
    kind: "model",
    path: "docs/use-cases/bike-leasing/process/x.md",
    fragment: "a",
  });
  assert.deepEqual(classifyHref("#%C3%BCber", DOC), { kind: "anchor", fragment: "über" });
  assert.deepEqual(classifyHref("//cdn.example.com/x", DOC), { kind: "external" });
  assert.deepEqual(classifyHref("mailto:a@b.c", DOC), { kind: "contact" });
  assert.deepEqual(classifyHref("VSCode://file/x", DOC), { kind: "scheme", scheme: "vscode:" });
  assert.equal(resolveRepoPath("./a/../b.md", "docs/x.md"), "docs/b.md");
  assert.equal(resolveRepoPath("/top.md", "docs/deep/x.md"), "top.md");
  assert.equal(resolveRepoPath("../../x.md", "docs/x.md"), undefined);
  assert.equal(modelRoute("acme/models", "a b/c.md", "Sec 1"), "/r/acme/models/f/a%20b/c.md#Sec%201");
});

test("an image from another site is a placeholder naming its host, until the reader loads it (#290)", () => {
  const html = render("![CI badge](https://img.example.com/ci.svg) ![](//cdn.example.org/a/logo.png)");
  // nothing a browser would fetch from the other site
  assert.doesNotMatch(html, /<img/);
  assert.match(
    html,
    new RegExp(
      '<span class="md-image-external" title="https://img.example.com/ci.svg">' +
        '<span class="md-image-external-text">Image from <strong>img.example.com</strong>: CI badge</span>' +
        '<button type="button" class="md-image-load" data-image-src="https://img.example.com/ci.svg"' +
        ' aria-label="Load image CI badge from img.example.com"' +
        ' title="Loading it sends your IP address to img.example.com">Load image</button></span>',
    ),
  );
  // protocol-relative is https, as on the page; without alt text the file names it
  assert.match(html, /data-image-src="https:\/\/cdn.example.org\/a\/logo.png"/);
  assert.match(html, /Image from <strong>cdn.example.org<\/strong>: logo.png/);

  // the one the reader loaded is an image, without a referrer; the others stay offered
  const loaded = renderMarkdown("![CI badge](https://img.example.com/ci.svg) ![x](https://other.example/x.png)", {
    repo: REPO,
    docPath: DOC,
    externalImages: new Set(["https://img.example.com/ci.svg"]),
  });
  assert.match(
    loaded,
    /<img src="https:\/\/img.example.com\/ci.svg" alt="CI badge" loading="lazy" referrerpolicy="no-referrer">/,
  );
  assert.match(loaded, /data-image-src="https:\/\/other.example\/x.png"/);
  assert.equal(loaded.match(/<img /g)?.length, 1);

  // the alt text and the address stay text and attribute values
  const hostile = render('![<b onclick="x">](https://img.example.com/a.png?q="><script>)');
  assert.doesNotMatch(hostile, /<b |<script|<img/);
});

test("a repository image loads from the Live Host; the rest shows as a placeholder naming it", () => {
  const html = render("![Process map](../assets/map.png) ![](./plain.PNG) ![Logo](/brand/logo.svg?raw=true#top)");
  assert.match(
    html,
    /<img src="\/api\/repos\/acme\/models\/image\?path=docs%2Fuse-cases%2Fbike-leasing%2Fassets%2Fmap.png" alt="Process map" loading="lazy" class="md-repo-image">/,
  );
  assert.match(html, /image\?path=docs%2Fuse-cases%2Fbike-leasing%2Ffeature-map%2Fplain.PNG" alt=""/);
  assert.match(html, /image\?path=brand%2Flogo.svg" alt="Logo"/);

  // not shown: an http: address, another scheme, a path above the repository, a file that is no image
  assert.match(render("![x](http://example.com/a.png)"), /title="http:\/\/example.com\/a.png">Image not shown: x</);
  assert.match(render("![v](vscode://file/a.png)"), /title="vscode:\/\/file\/a.png">Image not shown: v</);
  assert.match(render("![up](../../../../../x.png)"), />Image not shown: up</);
  assert.match(
    render("![](./spec.pdf)"),
    /title="docs\/use-cases\/bike-leasing\/feature-map\/spec.pdf">Image not shown: spec.pdf</,
  );
  // a repository image that did not load stays a placeholder
  assert.match(
    renderMarkdown("![Process map](../assets/map.png)", {
      repo: REPO,
      docPath: DOC,
      brokenImages: new Set(["/api/repos/acme/models/image?path=docs%2Fuse-cases%2Fbike-leasing%2Fassets%2Fmap.png"]),
    }),
    /<span class="md-image-placeholder" title="docs\/use-cases\/bike-leasing\/assets\/map.png">Image not shown: Process map<\/span>/,
  );
  // inline data needs no request
  assert.match(
    render("![dot](data:image/png;base64,iVBORw0KGgo=)"),
    /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="dot" loading="lazy">/,
  );
});

test("classifyImage: where an image comes from", () => {
  assert.deepEqual(classifyImage("data:image/png;base64,AAAA", DOC), { kind: "inline" });
  assert.deepEqual(classifyImage("https://img.example.com:8443/a.png", DOC), {
    kind: "external",
    url: "https://img.example.com:8443/a.png",
    host: "img.example.com:8443",
  });
  assert.deepEqual(classifyImage("//cdn.example.org/a.png", DOC), {
    kind: "external",
    url: "https://cdn.example.org/a.png",
    host: "cdn.example.org",
  });
  assert.deepEqual(classifyImage("./a%20b.png", "docs/x.md"), { kind: "repository", path: "docs/a b.png" });
  assert.deepEqual(classifyImage("/img/a.webp", "docs/x.md"), { kind: "repository", path: "img/a.webp" });
  assert.deepEqual(classifyImage("../../a.png", "docs/x.md"), { kind: "unavailable", where: "../../a.png" });
  assert.deepEqual(classifyImage("./notes.txt", "docs/x.md"), { kind: "unavailable", where: "docs/notes.txt" });
  assert.deepEqual(classifyImage("http://example.com/a.png", DOC), {
    kind: "unavailable",
    where: "http://example.com/a.png",
  });
  assert.deepEqual(classifyImage("#top", DOC), { kind: "unavailable", where: "#top" });
});

test("fences render through the hook keyed by language, every other fence as code", () => {
  const calls: Array<[string, FenceInfo]> = [];
  const fences = {
    mermaid: (content: string, info: FenceInfo) => {
      calls.push([content, info]);
      return '<div class="diagram">rendered</div>';
    },
  };
  const html = render(
    "```Mermaid theme=dark\ngraph TD\n  A-->B\n```\n\n```ts\nconst a = 1 < 2;\n```\n\n```\nplain\n```",
    fences,
  );
  assert.deepEqual(calls, [["graph TD\n  A-->B\n", { lang: "mermaid", info: "Mermaid theme=dark" }]]);
  assert.match(html, /<div class="diagram">rendered<\/div>/);
  assert.match(html, /<pre class="md-code"><code class="language-ts">const a = 1 &lt; 2;\n<\/code><\/pre>/);
  assert.match(html, /<pre class="md-code"><code>plain\n<\/code><\/pre>/);
});

test("without a hook a mermaid fence stays code, and prototype keys never act as one", () => {
  const html = render("```mermaid\ngraph TD\n```\n\n```constructor\n<b>x</b>\n```", {});
  assert.match(html, /<code class="language-mermaid">graph TD\n<\/code>/);
  assert.match(html, /<code class="language-constructor">&lt;b&gt;x&lt;\/b&gt;\n<\/code>/);
});
