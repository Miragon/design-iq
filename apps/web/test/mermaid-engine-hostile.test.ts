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
 *    browser makes of it was checked in headless Chromium).
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

// the Markdown view's modules load once jsdom is mermaid's window: DOMPurify,
// which mermaid shares, binds to the window it first meets
const view = async () => ({
  ...(await import("../src/notations/markdown/mermaid-fence.ts")),
  ...(await import("../src/notations/markdown/sanitize.ts")),
});

const EVIL = "https://tracker.example";

/** one source per diagram type, with the label in every text slot it has */
const SOURCES: Record<string, (label: string) => string> = {
  flowchart: (x) =>
    `flowchart LR\n  A["${x}"] -->|"${x}"| B("${x}")\n  subgraph S["${x}"]\n    C{"${x}"}\n  end\n  B --> C\n`,
  "flowchart-elk": (x) => `flowchart-elk LR\n  A["${x}"] -->|"${x}"| B\n`,
  graph: (x) => `graph TD\n  A["${x}"] --> B["${x}"]\n`,
  sequenceDiagram: (x) =>
    `sequenceDiagram\n  participant A as ${x}\n  actor B\n  A->>B: ${x}\n  Note over A,B: ${x}\n  loop ${x}\n    B-->>A: ${x}\n  end\n`,
  classDiagram: (x) =>
    `classDiagram\n  class Animal["${x}"] {\n    +String name\n  }\n  Animal <|-- Duck : ${x}\n  note for Duck "${x}"\n`,
  "classDiagram-v2": (x) => `classDiagram-v2\n  class Animal["${x}"]\n  Animal <|-- Duck : ${x}\n  note "${x}"\n`,
  stateDiagram: (x) => `stateDiagram\n  [*] --> S1 : ${x}\n  S1 : ${x}\n  note right of S1 : ${x}\n`,
  "stateDiagram-v2": (x) =>
    `stateDiagram-v2\n  state "${x}" as S1\n  [*] --> S1 : ${x}\n  S1 --> [*]\n  note left of S1 : ${x}\n`,
  erDiagram: (x) => `erDiagram\n  CUSTOMER ||--o{ ORDER : "${x}"\n  CUSTOMER["${x}"] {\n    string name "${x}"\n  }\n`,
  journey: (x) => `journey\n  title ${x}\n  section ${x}\n    ${x}: 5: ${x}\n`,
  gantt: (x) => `gantt\n  title ${x}\n  dateFormat YYYY-MM-DD\n  section ${x}\n  ${x} :a1, 2024-01-01, 3d\n`,
  pie: (x) => `pie title ${x}\n  "${x}" : 3\n  "B" : 5\n`,
  quadrantChart: (x) =>
    `quadrantChart\n  title ${x}\n  x-axis ${x} --> High\n  y-axis Low --> ${x}\n  quadrant-1 ${x}\n  "${x}": [0.3, 0.6]\n`,
  requirementDiagram: (x) =>
    `requirementDiagram\n  requirement r1 {\n    id: 1\n    text: "${x}"\n    risk: high\n    verifymethod: test\n  }\n  element e1 {\n    type: "${x}"\n  }\n  e1 - satisfies -> r1\n`,
  gitGraph: (x) => `gitGraph\n  commit id: "${x}" tag: "${x}"\n  branch dev\n  commit\n`,
  C4Context: (x) =>
    `C4Context\n  title ${x}\n  Person(p, "${x}", "${x}")\n  System(s, "${x}", "${x}")\n  Rel(p, s, "${x}", "${x}")\n`,
  C4Container: (x) => `C4Container\n  title ${x}\n  Container(c, "${x}", "${x}", "${x}")\n`,
  C4Component: (x) => `C4Component\n  title ${x}\n  Component(c, "${x}", "${x}", "${x}")\n`,
  C4Dynamic: (x) => `C4Dynamic\n  title ${x}\n  Person(p, "${x}")\n  System(s, "${x}")\n  Rel(p, s, "${x}")\n`,
  C4Deployment: (x) =>
    `C4Deployment\n  title ${x}\n  Deployment_Node(n, "${x}", "${x}") {\n    Container(c, "${x}", "${x}")\n  }\n`,
  mindmap: (x) => `mindmap\n  root(("${x}"))\n    A["${x}"]\n      B\n`,
  timeline: (x) => `timeline\n  title ${x}\n  section ${x}\n    2020 : ${x}\n`,
  sankey: (x) => `sankey\n\n"${x}",B,10\nB,C,5\n`,
  "sankey-beta": (x) => `sankey-beta\n\n"${x}",B,10\n`,
  xychart: (x) => `xychart\n  title "${x}"\n  x-axis ["${x}", b]\n  y-axis "${x}" 0 --> 10\n  bar [1, 2]\n`,
  "xychart-beta": (x) => `xychart-beta\n  title "${x}"\n  x-axis ["${x}", b]\n  bar [1, 2]\n`,
  block: (x) => `block\n  columns 2\n  a["${x}"] b["${x}"]\n  a --> b\n`,
  "block-beta": (x) => `block-beta\n  a["${x}"]\n`,
  packet: (x) => `packet\n  0-15: "${x}"\n  16-31: "${x}"\n`,
  "packet-beta": (x) => `packet-beta\n  0-15: "${x}"\n`,
  kanban: (x) => `kanban\n  todo[${x}]\n    t1[${x}]@{ ticket: 'T1', assigned: '${x}' }\n`,
  "architecture-beta": (x) =>
    `architecture-beta\n  group g(cloud)[${x}]\n  service s(server)[${x}] in g\n  service d(database)[${x}] in g\n  s:R -- L:d\n`,
  "radar-beta": (x) => `radar-beta\n  title ${x}\n  axis a["${x}"], b["${x}"], c["${x}"]\n  curve k["${x}"]{1, 2, 3}\n`,
  treemap: (x) => `treemap\n"${x}"\n  "${x}": 10\n`,
  "treemap-beta": (x) => `treemap-beta\n"${x}"\n  "${x}": 10\n`,
  info: () => `info\n`,
  "swimlane-beta": (x) => `swimlane-beta LR\n  subgraph L1["${x}"]\n    a["${x}"] --> b\n  end\n`,
  "treeView-beta": (x) => `treeView-beta\n  "${x}"\n    "${x}"\n`,
  eventmodeling: (x) => `eventmodeling\n\ntf 01 ui CartUI "${x}"\ntf 02 cmd AddItem "${x}"\n`,
  ishikawa: (x) => `ishikawa\n  title ${x}\n  ${x}\n    ${x}\n      ${x}\n`,
  "ishikawa-beta": (x) => `ishikawa-beta\n  ${x}\n    ${x}\n`,
  "venn-beta": (x) => `venn-beta\n  set A["${x}"]\n  set B["${x}"]\n  union A,B["${x}"]\n`,
  "wardley-beta": (x) => `wardley-beta\n  title ${x}\n  component "${x}" [0.2, 0.3]\n  note "${x}" [0.5, 0.5]\n`,
  "cynefin-beta": (x) => `cynefin-beta\n  title ${x}\n  clear\n    "${x}"\n`,
  "railroad-beta": (x) =>
    `railroad-beta\n  title ${x}\n  rule = sequence(terminal("${x}"), nonterminal("${x}"), special("${x}")) ;\n`,
  "railroad-ebnf-beta": (x) => `railroad-ebnf-beta\n  title ${x}\n  rule = "${x}" ;\n`,
  "railroad-abnf-beta": (x) => `railroad-abnf-beta\n  title ${x}\n  rule = "${x}" ;\n`,
  "railroad-peg-beta": (x) => `railroad-peg-beta\n  title ${x}\n  rule <- "${x}" ;\n`,
  "usecase-beta": (x) =>
    `usecase-beta\n  actor A("${x}")\n  systemBoundary S["${x}"]\n    U("${x}")\n  end\n  A --> U\n  note for U "${x}"\n`,
  "agentflow-beta": (x) => `agentflow-beta TB\n  brief["${x}"]@{ shape: input }\n  draft["${x}"]\n  brief --> draft\n`,
};

/** hostile labels: no double quote, so they fit every template's slots */
const LABELS: Record<string, string> = {
  "img onerror": `<img src=${EVIL}/img onerror=__pwn(1)>`,
  "svg onload": "<svg onload=__pwn(2)><circle r=1></circle></svg>",
  "javascript: link": "<a href=javascript:__pwn(3)>x</a>",
  "<style>": `<style>@import url(${EVIL}/import.css);*{background:url(${EVIL}/bg)}</style>`,
  "script and frames":
    "<script>__pwn(4)</script><iframe src=javascript:__pwn(5)></iframe><iframe srcdoc=x onload=__pwn(6)></iframe>",
  "foreignObject HTML": `<svg><foreignObject><img src=${EVIL}/fo onerror=__pwn(7)><div onmouseover=__pwn(8)>d</div></foreignObject></svg>`,
  mXSS: `<math><mtext><table><mglyph><style><img src=${EVIL}/mxss onerror=__pwn(9)>`,
  "media and styles": `<video src=${EVIL}/video poster=${EVIL}/poster></video><div style=background:url(${EVIL}/inline)>s</div><svg><image href=${EVIL}/image /></svg>`,
};

/** links, click callbacks, front matter and directives, foreignObject HTML */
const FEATURES: Record<string, string> = {
  "flowchart click": `flowchart LR\n  A --> B --> C\n  click A callback "tip <img src=${EVIL}/tip onerror=__pwn(10)>"\n  click B "javascript:__pwn(11)" "tip" _self\n  click C call __pwn(12)\n  click A href "javascript:__pwn(13)" _blank\n`,
  "flowchart link": `flowchart LR\n  A --> B\n  click A href "${EVIL}/docs" _blank\n`,
  "flowchart shapes": `flowchart LR\n  A@{ img: "${EVIL}/shape", label: "x", pos: "t", w: 60, h: 60, constraint: "on" }\n  B@{ icon: "fa:user", form: "square", label: "x" }\n  A --> B\n`,
  "flowchart styles": `flowchart LR\n  A --> B\n  style A fill:url(${EVIL}/fill),background-image:url(${EVIL}/bg)\n  classDef evil fill:url(${EVIL}/class)\n  class B evil\n  linkStyle 0 stroke:url(${EVIL}/link)\n`,
  "flowchart markdown": `flowchart LR\n  A["\`**md** <img src=${EVIL}/md onerror=__pwn(14)> [l](javascript:__pwn(15))\`"] --> B["\`![i](${EVIL}/md2)\`"]\n`,
  "flowchart foreignObject": `flowchart LR\n  A["<svg><foreignObject><img src=${EVIL}/fo2 onerror=__pwn(16)><iframe srcdoc=x></iframe></foreignObject></svg>"] --> B\n`,
  "class click": `classDiagram\n  class A\n  class B\n  class C\n  click A call __pwn(17) "tip"\n  click B href "javascript:__pwn(18)" "tip"\n  link C "javascript:__pwn(19)" "tip"\n  callback A "__pwn" "tip"\n  style A fill:url(${EVIL}/c)\n`,
  "class foreignObject": `classDiagram\n  class A["<foreignObject><div onmouseover=__pwn(20)>x</div></foreignObject>"]\n  note for A "<svg><foreignObject><img src=${EVIL}/fo3 onerror=__pwn(21)></foreignObject></svg>"\n`,
  "state click": `stateDiagram-v2\n  [*] --> S1\n  click S1 "javascript:__pwn(22)" "tip"\n`,
  "state styles": `stateDiagram-v2\n  classDef evil fill:url(${EVIL}/s),background:url(${EVIL}/s2)\n  [*] --> S1\n  class S1 evil\n`,
  "gantt click": `gantt\n  dateFormat YYYY-MM-DD\n  section S\n  T1 :t1, 2024-01-01, 3d\n  T2 :t2, after t1, 2d\n  click t1 call __pwn(23)\n  click t2 href "javascript:__pwn(24)"\n`,
  "sequence links": `sequenceDiagram\n  participant A\n  participant B\n  link A: Evil @ javascript:__pwn(25)\n  links B: {"x": "javascript:__pwn(26)", "y": "${EVIL}/l"}\n  A->>B: hi\n`,
  "sequence foreignObject": `sequenceDiagram\n  participant A as <foreignObject><img src=${EVIL}/fo4 onerror=__pwn(27)></foreignObject>\n  A->>A: <svg><foreignObject><iframe srcdoc=x onload=__pwn(28)></iframe></foreignObject></svg>\n`,
  "c4 links": `C4Context\n  Person(p, "P", "d", $link="javascript:__pwn(29)")\n  System(s, "S", $link="${EVIL}/c4")\n  Rel(p, s, "uses", $link="javascript:__pwn(30)")\n`,
  "kanban ticket link": `---\nconfig:\n  kanban:\n    ticketBaseUrl: 'javascript:__pwn(31)//#TICKET#'\n---\nkanban\n  todo[Todo]\n    t1[Task]@{ ticket: T1 }\n`,
  "mindmap icon": `mindmap\n  root\n    A\n    ::icon(fa fa-book)\n    B[<img src=${EVIL}/m>]\n`,
  "front matter: loose, a sanitizer, a title": `---\ntitle: <img src=${EVIL}/title onerror=__pwn(32)>\nconfig:\n  securityLevel: loose\n  htmlLabels: false\n  dompurifyConfig:\n    ADD_ATTR: [onerror]\n    ADD_TAGS: [script, iframe]\n---\nflowchart LR\n  A["<img src=x onerror=__pwn(33)>"] --> B["<a href=javascript:__pwn(34)>b</a>"]\n  click A call __pwn(35)\n`,
  "init: loose, a sanitizer, start on load": `%%{init: {"securityLevel": "loose", "htmlLabels": false, "dompurifyConfig": {"ADD_ATTR": ["onerror"], "ADD_TAGS": ["script"]}, "startOnLoad": true}}%%\nflowchart LR\n  A["<img src=x onerror=__pwn(36)>"] --> B\n  click B call __pwn(37)\n`,
  "init: CSS, fonts, arrowheads": `%%{init: {"themeCSS": "@import url(${EVIL}/t); .node{background:url(${EVIL}/t2)}", "fontFamily": "x;}*{background:url(${EVIL}/f)}", "arrowMarkerAbsolute": true, "sequence": {"actorFontFamily": "x;background:url(${EVIL}/ff)"}}}%%\nflowchart LR\n  A --> B\n`,
  "init: HTML labels off": `%%{init: {"htmlLabels": false, "flowchart": {"htmlLabels": false}}}%%\nflowchart LR\n  A["<img src=${EVIL}/hl onerror=__pwn(38)>"] --> B\n`,
  "accessible title": `flowchart LR\n  accTitle: <img src=${EVIL}/acc onerror=__pwn(39)>\n  accDescr: <svg onload=__pwn(40)>\n  A --> B\n`,
  "style breakout": `flowchart LR\n  A --> B\n  style A fill:#f00</style><img src=${EVIL}/sb onerror=__pwn(41)>\n`,
};

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
    "a new diagram type needs its template in SOURCES",
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
