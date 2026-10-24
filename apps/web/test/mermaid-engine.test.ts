/**
 * The real mermaid engine (apps/web's pin) behind lib/mermaid-render.ts, under
 * jsdom (./mermaid-dom.ts): what the app's configuration means once mermaid
 * applies it, and whether @designiq/notations/mermaid (the validator's
 * reading of a diagram) still mirrors the mermaid the app draws with. Every
 * label measures one fixed box, enough to compare two drawings of the same
 * diagram (drawing()), and the colours a drawing gets as the page shows it
 * (onPage(), drawnStyle()). What hostile sources do to it:
 * mermaid-engine-hostile.test.ts, next to this.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { MERMAID_DIAGRAM_TYPES, MERMAID_VERSION, mermaidHeader } from "@designiq/notations/mermaid";
import { ALIASES, CD, FONT_SANS, formatColor, mix, parseColor } from "@designiq/ui-kit/lib/tokens";
import type { Mermaid } from "mermaid";

import {
  describeMermaidError,
  MERMAID_LABEL_SANITIZER,
  MERMAID_THEME_CSS,
  renderMermaid,
} from "../src/lib/mermaid-render.ts";
import type { Sanitize } from "../src/notations/markdown/sanitize.ts";
import { otherCasings } from "./mermaid-casings.ts";
import { drawnStyle, loadMermaidUnderJsdom } from "./mermaid-dom.ts";
import { SOURCES } from "./mermaid-hostile-sources.ts";

let mermaid: Mermaid;
let window: Awaited<ReturnType<typeof loadMermaidUnderJsdom>>["window"];
let sanitize: Sanitize;

before(async () => {
  ({ mermaid, window } = await loadMermaidUnderJsdom());
  // the page's sanitizer loads once jsdom is mermaid's window: DOMPurify, which
  // mermaid shares, binds to the window it first meets
  const { createDiagramSanitizer } = await import("../src/notations/markdown/sanitize.ts");
  sanitize = createDiagramSanitizer(window);
});

// jsdom's window keeps the timers of what mermaid drew alive
after(() => window.close());

/** the configuration mermaid draws a source with: parse applies its front
 *  matter and directives on top of the app's (the global part: mermaid 12
 *  resolves the look, theme and layout of a diagram type only while it
 *  parses or draws one, see drawing()) */
async function configFor(source: string) {
  await mermaid.parse(source);
  return mermaid.mermaidAPI.getConfig();
}

let drawings = 0;

/** what a drawing of a source shows: the looks its shapes are drawn in,
 *  where its nodes sit, and its style sheet (the render's own id taken out) */
async function drawing(source: string) {
  const id = `drawing-${++drawings}`;
  const { svg } = await mermaid.render(id, source);
  return {
    looks: [...new Set([...svg.matchAll(/<g [^>]*\bdata-look="([^"]*)"/g)].map((m) => m[1]))],
    layout: [...svg.matchAll(/<g class="node [^>]*\btransform="([^"]*)"/g)].map((m) => m[1]),
    style: (/<style>(.*?)<\/style>/s.exec(svg)?.[1] ?? "").replaceAll(id, "ID"),
  };
}

/** what drawing a source fails with, as the app draws it */
async function drawingError(source: string): Promise<unknown> {
  try {
    await mermaid.render(`drawing-${++drawings}`, source);
  } catch (error) {
    return error;
  }
  return assert.fail(`${JSON.stringify(source)} draws`);
}

test("an error names the line it is on, whatever comment lines stand above it", async () => {
  // mermaid 12 parses eventmodeling and agentflow-beta with their comment
  // lines, every other type without them
  const diagrams: [diagram: string, onTheBadLine: string][] = [
    ["eventmodeling\n\ntf 01 ui CartUI\ntf 02 cmd AddItem\ntf 01 ??? !!!\ntf 03 evt Done\n", "tf 01 ???"],
    ['agentflow-beta TB\n  brief["Brief"]@{ shape: input }\n\n  brief --> --> ]]\n', "brief --> -->"],
    // agentflow's own error in an @{…} block
    ['agentflow-beta TB\n  brief["Brief"]@{ shape: input }\n  draft["Draft"]@{ shape: nosuchshape }\n', "nosuchshape"],
    ['pie title Pets\n  "Dogs" : 3\n  "Cats" x\n', '"Cats" x'],
    ["flowchart LR\n  A --> B\n  B --> -->\n  B --> C\n", "B --> -->"],
  ];
  const heads = [
    "",
    "%% one\n%% two\n%% three\n",
    "---\ntitle: Orders\n---\n%% one\n%% two\n",
    '%%{init: {\n  "wrap": true\n}}%%\n%% one\n',
  ];
  for (const [diagram, bad] of diagrams) {
    for (const head of heads) {
      const source = head + diagram;
      const { line } = describeMermaidError(await drawingError(source), source);
      assert.equal(line, source.split("\n").findIndex((l) => l.includes(bad)) + 1, JSON.stringify(source));
    }
  }
});

test("a diagram cannot leave the CI look: no other theme, palette, CSS or font", async () => {
  const sources = [
    '%%{init: {"theme": "dark", "themeCSS": ".node rect { fill: url(https://example.invalid/t.png) }", ' +
      '"fontFamily": "Comic Sans MS", "darkMode": true, "themeVariables": {"primaryColor": "#1f2020"}}}%%\n' +
      "flowchart LR\n  A --> B\n",
    "---\nconfig:\n  theme: forest\n  themeCSS: '.node rect { fill: red }'\n  fontFamily: Papyrus\n" +
      "  themeVariables:\n    primaryColor: '#ff0000'\n    darkMode: true\n---\nflowchart LR\n  A --> B\n",
    // mermaid 12 lets a config scope its theme to one diagram type
    '%%{init: {"flowchart": {"theme": "dark", "themeCSS": ".node rect { fill: red }"}}}%%\nflowchart LR\n  A --> B\n',
    "---\nconfig:\n  flowchart:\n    theme: dark\n  sequence:\n    theme: forest\n---\nflowchart LR\n  A --> B\n",
  ];
  for (const source of sources) {
    const config = await configFor(source);
    assert.equal(config.theme, "base", source);
    assert.equal(config.themeCSS, MERMAID_THEME_CSS, source);
    assert.equal(config.fontFamily, FONT_SANS, source);
    assert.equal(config.securityLevel, "strict", source);
    assert.equal(config.themeVariables?.primaryColor, ALIASES["canvas-shape"], source);
    assert.equal(config.themeVariables?.darkMode, false, source);
    assert.ok(!["dark", "forest"].includes(config.flowchart?.theme ?? ""), source);
    assert.ok(!["dark", "forest"].includes(config.sequence?.theme ?? ""), source);
  }
  // and drawn, a diagram type's own theme changes nothing
  const flow = "flowchart LR\n  A --> B\n";
  assert.equal(
    (await drawing(`---\nconfig:\n  flowchart:\n    theme: dark\n---\n${flow}`)).style,
    (await drawing(flow)).style,
  );
});

// in the frame, an absolute arrowhead would point at its about:srcdoc address
test("a diagram cannot point its arrowheads at an address (#293)", async () => {
  const flow = "flowchart LR\n  A --> B\n";
  for (const source of [
    `---\nconfig:\n  arrowMarkerAbsolute: true\n---\n${flow}`,
    `%%{init: {"arrowMarkerAbsolute": true}}%%\n${flow}`,
  ]) {
    assert.equal((await configFor(source)).arrowMarkerAbsolute, false, source);
  }
  assert.doesNotMatch(
    (await mermaid.render("arrows", `%%{init: {"arrowMarkerAbsolute": true}}%%\n${flow}`)).svg,
    /url\(\w+:/,
  );
});

test("a label's HTML loads nothing from another site, whatever the diagram's own config says (#290)", async () => {
  const labels =
    "flowchart LR\n  A[\"<img src='https://tracker.example/a.png'/> logo\"] --> B[\"<span style='background-image:url(https://tracker.example/b.png)'>b</span>\"]\n" +
    "  B --> C[\"<picture><source srcset='https://tracker.example/c.png'></picture><video poster='https://tracker.example/d.png'></video>c\"]\n";
  const unlock =
    "---\nconfig:\n  dompurifyConfig:\n    ADD_TAGS: [img]\n    FORBID_TAGS: []\n    FORBID_ATTR: []\n---\n";
  for (const source of [labels, unlock + labels, `%%{init: {"dompurifyConfig": {"FORBID_TAGS": []}}}%%\n${labels}`]) {
    assert.deepEqual((await configFor(source)).dompurifyConfig, MERMAID_LABEL_SANITIZER, source);
    const { svg } = await mermaid.render(`labels-${++drawings}`, source);
    assert.doesNotMatch(svg, /tracker\.example|<img|<picture|<video/, source);
    assert.match(svg, /logo/, "the label's text stays");
  }
});

test("a shape's image or an actor's icon from an address is refused before mermaid loads it (#290)", async () => {
  const shape = await renderMermaid('flowchart LR\n  A@{ img: "https://tracker.example/a.png", label: "x" }', "test");
  assert.ok("error" in shape);
  assert.equal(shape.error.line, 2);
  assert.match(shape.error.message, /^A shape's image \(img\) is not drawn/);
  const icon = await renderMermaid(
    'sequenceDiagram\n  participant A\n  properties A: {"icon": "https://tracker.example/i.png"}\n  A->>A: hi',
    "test",
  );
  assert.ok("error" in icon);
  assert.match(icon.error.message, /^An actor's icon is not drawn/);
});

test("a classDef with url() would load as the diagram is laid out: it is refused before mermaid applies it (#290)", async () => {
  const state =
    "stateDiagram-v2\n  classDef bad background-image:url(https://tracker.example/state.png)\n  [*] --> S1\n  class S1 bad\n";
  const block =
    "block-beta\n  a b\n  classDef blue background-image:url(https://tracker.example/block.png)\n  class a blue\n";
  // the vector is real: mermaid writes it into the style sheet it lays the diagram out with
  for (const source of [state, block]) assert.match((await drawing(source)).style, /tracker\.example/, source);
  for (const [source, line] of [
    [state, 2],
    [block, 3],
    [state.replace("url(", "u\\72l("), 2],
    [state.replace("url(https://tracker.example/state.png)", 'image-set("https://tracker.example/state.png" 1x)'), 2],
    [state.replace("background-image:url", "mask-image:url"), 2],
  ] as const) {
    const refused = await renderMermaid(source, "test");
    assert.ok("error" in refused, source);
    assert.equal(refused.error.line, line, source);
    assert.match(refused.error.message, /^CSS that loads from an address/, source);
  }
});

test("an actor's details read its icon from an element of the page: the statement is refused (#290)", async () => {
  const heading = document.createElement("h2");
  heading.id = "md-propertiesicontrackerexampledetails-iconpng";
  heading.textContent = '{"properties":{"icon":"//tracker.example/details-icon.png"}}';
  document.body.append(heading);
  try {
    const source = `sequenceDiagram\n  participant A\n  details A: ${heading.id}\n  A->>A: hi\n`;
    const { svg } = await mermaid.render(`details-${++drawings}`, source);
    assert.match(svg, /<image[^>]*tracker\.example\/details-icon\.png/, "mermaid draws the icon the heading names");
    const refused = await renderMermaid(source, "test");
    assert.ok("error" in refused);
    assert.equal(refused.error.line, 3);
    assert.match(refused.error.message, /^An actor's details are not drawn/);
  } finally {
    heading.remove();
  }
});

test("a diagram's configuration that names CSS to fetch is refused, its YAML and JSON escapes read (#290)", async () => {
  const sankey = "sankey-beta\na,b,1\nb,c,1\n";
  const escaped = `---\nconfig:\n  sankey:\n    linkColor: "u\\x72l(https://tracker.example/s.png)"\n---\n${sankey}`;
  // the vector is real: YAML turns the escape into a url() that mermaid draws every link with
  const { svg } = await mermaid.render(`config-${++drawings}`, escaped);
  assert.match(svg, /url\(https:\/\/tracker\.example\/s\.png\)/);
  for (const source of [
    escaped,
    `%%{init: {"sankey": {"linkColor": "u\\u0072l(https://tracker.example/s.png)"}}}%%\n${sankey}`,
    `%%{init: {"sankey": {"linkColor": "\\\\75rl(https://tracker.example/s.png)"}}}%%\n${sankey}`,
  ]) {
    const refused = await renderMermaid(source, "test");
    assert.ok("error" in refused, source);
    assert.equal(refused.error.line, 1, source);
    assert.match(refused.error.message, /^The diagram's configuration loads from an address/, source);
  }
  for (const source of [`---\nconfig:\n  sankey:\n    linkColor: gradient\n---\n${sankey}`, sankey]) {
    assert.ok("svg" in (await renderMermaid(source, "test")), source);
  }
});

test("layout stays the author's: a directive may still set the look and the wrapping", async () => {
  const config = await configFor(
    '---\nconfig:\n  look: handDrawn\n---\n%%{init: {"wrap": true}}%%\nflowchart LR\n A --> B\n',
  );
  assert.equal(config.look, "handDrawn");
  assert.equal(config.wrap, true);
  assert.equal(config.theme, "base");
  // mermaid 12.2's mindmap colorBy only picks which of the theme's section colours a node takes
  const mindmap = "mindmap\n  root\n    A\n      A1\n    B\n";
  for (const source of [
    `---\nconfig:\n  mindmap:\n    colorBy: depth\n---\n${mindmap}`,
    `%%{init: {"mindmap": {"colorBy": "depth"}}}%%\n${mindmap}`,
  ]) {
    assert.equal((await configFor(source)).mindmap?.colorBy, "depth", source);
  }
});

test("a diagram keeps the look and layout of mermaid 11 until it asks otherwise: classic, laid out by dagre", async () => {
  const flow = "flowchart LR\n  A[Order received] --> B{In stock?}\n  B --> C[Ship]\n  B --> D[Reorder]\n  D --> C\n";
  const plain = await drawing(flow);
  assert.deepEqual(plain.looks, ["classic"]);
  assert.deepEqual(plain.layout, (await drawing(`---\nconfig:\n  layout: dagre\n---\n${flow}`)).layout);
  for (const source of [
    "classDiagram\n  Customer --> Order\n",
    "stateDiagram-v2\n  [*] --> Placed\n  Placed --> [*]\n",
    "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n",
  ]) {
    assert.deepEqual((await drawing(source)).looks, ["classic"], source);
  }
  // mermaid 12's own defaults stay the author's to pick
  assert.deepEqual((await drawing(`---\nconfig:\n  look: neo\n---\n${flow}`)).looks, ["neo"]);
  assert.notDeepEqual((await drawing(`---\nconfig:\n  layout: elk\n---\n${flow}`)).layout, plain.layout);
  // and a diagram type with a layout of its own keeps it
  const lanes = "swimlane-beta LR\n  subgraph L1\n    a --> b\n  end\n  subgraph L2\n    c\n  end\n  b --> c\n";
  assert.deepEqual(
    (await drawing(lanes)).layout,
    (await drawing(`---\nconfig:\n  layout: swimlane\n---\n${lanes}`)).layout,
  );
});

/** a source drawn as the page shows it: mermaid's SVG, sanitized and taken into the page's document */
async function onPage(source: string): Promise<Element> {
  const { svg } = await mermaid.render(`page-${++drawings}`, source);
  return window.document.importNode(sanitize(svg).firstElementChild!, true);
}

/** a colour as #rrggbb, however the style sheet wrote it */
const hex = (colour: string | undefined): string => formatColor(parseColor(colour ?? "transparent"));
/** a filter that leaves an element's colours as painted: none, or a shadow cast next to it */
const KEEPS_COLOURS = /^(?:none|drop-shadow\(.*\)|url\(["']?#[^"')]*drop-shadow["']?\))$/;
/**
 * What an element of a drawing is painted with, as it shows: drawnStyle()
 * does not apply a filter, so one that would change the colour (a timeline
 * brightens its events, say) on the element or above it fails here.
 */
function paint(element: Element | null, property: "fill" | "stroke" | "color"): string {
  for (let at = element; at; at = at.parentElement) {
    const filter = drawnStyle(at, "filter")?.trim();
    assert.ok(
      filter === undefined || KEEPS_COLOURS.test(filter),
      `${at.localName}.${at.getAttribute("class")} is drawn through filter: ${filter}`,
    );
  }
  return hex(drawnStyle(element!, property));
}
/** WCAG 2 contrast of two opaque colours */
function contrast(a: string, b: string): number {
  const luminance = (colour: string): number => {
    const [r, g, bl] = parseColor(colour).map((v) => v / 255);
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(bl!);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** a fill at an opacity over what lies under it */
const over = (fill: string, opacity: number, ground: string): string => mix(fill, opacity * 100, ground);

const WHITE = hex(ALIASES["canvas-background"]);
const KONTUR = { fill: hex(CD.kontur), label: hex(CD.schwarz) };
const LEISE = { fill: hex(CD.textLeise), label: hex(CD.weiss) };
const ROOT = { fill: hex(CD.schwarz), label: hex(CD.weiss) };

/** a label that holds 4.5:1 on its fill, and a fill that holds 3:1 on white as a line */
function assertReads({ fill, label }: { fill: string; label: string }, what: string): void {
  assert.ok(contrast(label, fill) >= 4.5, `${what}: ${label} on ${fill}, ${contrast(label, fill).toFixed(2)}:1`);
  assert.ok(contrast(fill, WHITE) >= 3, `${what}: ${fill} on white, ${contrast(fill, WHITE).toFixed(2)}:1`);
}

test("a mindmap's branches take two CI greys in turn, each label reads on its branch, the root is black (#294)", async () => {
  const svg = await onPage("mindmap\n  root((Order))\n    Placed\n      Paid\n    Packed\n    Shipped\n    Billed\n");
  const branches = [0, 1, 2, 3].map((n) => {
    const node = svg.querySelector(`.mindmap-node.section-${n}`);
    return {
      fill: paint(node!.querySelector("path"), "fill"),
      label: paint(node!.querySelector("span"), "color"),
      // the line mermaid draws under a node, and the branch to it
      line: paint(node!.querySelector("line"), "stroke"),
      edge: paint(svg.querySelector(`.section-edge-${n}`), "stroke"),
    };
  });
  assert.deepEqual(
    branches,
    [KONTUR, LEISE, KONTUR, LEISE].map((grey) => ({ ...grey, line: grey.fill, edge: grey.fill })),
  );
  // a child takes its branch's grey
  const paid = [...svg.querySelectorAll(".mindmap-node")].find((node) => node.textContent === "Paid");
  assert.match(paid!.getAttribute("class")!, /\bsection-0\b/);
  const root = svg.querySelector(".mindmap-node.section-root");
  const rootColours = {
    fill: paint(root!.querySelector("circle"), "fill"),
    label: paint(root!.querySelector("span"), "color"),
  };
  assert.deepEqual(rootColours, ROOT);
  for (const [n, branch] of branches.entries()) assertReads(branch, `section ${n}`);
  assertReads(rootColours, "root");
});

test("a timeline's sections, tasks and events take the same greys, and its connectors stay black (#294)", async () => {
  // mermaid numbers a timeline's first section -1, so it takes cScale0
  const expected = { "section--1": LEISE, "section-0": KONTUR, "section-1": LEISE };
  // TD draws with a renderer of its own
  for (const header of ["timeline", "timeline TD"]) {
    const svg = await onPage(
      `${header}\n  section 2024\n    Q1 : Placed\n  section 2025\n    Q1 : Shipped\n  section 2026\n    Q1 : Billed\n`,
    );
    const nodes = [...svg.querySelectorAll(".timeline-node")];
    assert.equal(nodes.length, 9, header);
    assert.equal(nodes.filter((node) => node.closest(".eventWrapper")).length, 3, header);
    for (const node of nodes) {
      const section = /\bsection--?\d+\b/.exec(node.getAttribute("class")!)![0] as keyof typeof expected;
      const what = `${header}, ${section}: ${node.textContent}`;
      const colours = {
        fill: paint(node.querySelector("path"), "fill"),
        label: paint(node.querySelector("text"), "fill"),
      };
      assert.deepEqual(colours, expected[section], what);
      assertReads(colours, what);
    }
    const connectors = [...svg.querySelectorAll(".lineWrapper line")];
    assert.ok(connectors.length > 0, header);
    for (const line of connectors) assert.equal(paint(line, "stroke"), hex(CD.schwarz), header);
  }
});

test("a git graph's branches take the same greys after its black main branch, a highlighted commit is framed in black (#294)", async () => {
  const svg = await onPage(
    "gitGraph\n  commit\n  branch develop\n  commit\n  branch feature\n  commit\n  commit type: HIGHLIGHT\n  checkout main\n  merge develop\n",
  );
  for (const [n, grey] of [ROOT, KONTUR, LEISE].entries()) {
    const label = {
      fill: paint(svg.querySelector(`.branchLabelBkg.label${n}`), "fill"),
      label: paint(svg.querySelector(`.branch-label${n} text`), "fill"),
    };
    assert.deepEqual(label, grey, `branch ${n}`);
    assertReads(label, `branch ${n}`);
    assert.equal(paint(svg.querySelector(`.arrow${n}`), "stroke"), grey.fill, `branch ${n}'s line`);
    assert.equal(paint(svg.querySelector(`circle.commit${n}`), "fill"), grey.fill, `branch ${n}'s commit`);
  }
  // a CI neutral: the blue accent on the canvas means selected
  const highlight = paint(svg.querySelector(".commit-highlight-outer"), "fill");
  assert.equal(highlight, hex(ALIASES["canvas-stroke"]));
  assert.ok(contrast(highlight, WHITE) >= 3);
  assert.equal(paint(svg.querySelector(".commit-highlight-inner"), "fill"), hex(ALIASES["canvas-shape"]));
});

test("pie slices and venn sets take the same greys, and a slice's label reads on it as mermaid fades it (#294)", async () => {
  const pie = await onPage('pie title Orders\n  "Placed" : 5\n  "Packed" : 4\n  "Shipped" : 3\n  "Billed" : 2\n');
  const slices = [...pie.querySelectorAll("path.pieCircle")];
  assert.deepEqual(
    slices.map((slice) => paint(slice, "fill")),
    [KONTUR.fill, LEISE.fill, KONTUR.fill, LEISE.fill],
  );
  const label = paint(pie.querySelector("text.slice"), "fill");
  for (const slice of slices) {
    const shown = over(paint(slice, "fill"), Number(drawnStyle(slice, "opacity") ?? 1), WHITE);
    assert.ok(contrast(label, shown) >= 4.5, `${label} on ${shown}: ${contrast(label, shown).toFixed(2)}:1`);
  }
  const venn = await onPage("venn-beta\n  set A\n  set B\n  union A,B\n");
  const sets = [...venn.querySelectorAll(".venn-circle path")];
  assert.deepEqual(
    sets.map((set) => paint(set, "stroke")),
    [KONTUR.fill, LEISE.fill],
  );
  for (const set of sets) assert.ok(contrast(paint(set, "stroke"), WHITE) >= 3);
});

test("an xy chart's bars and lines take the same greys, its labels read on what they sit on (#294)", async () => {
  const plots =
    '  x-axis [a, b, c]\n  bar [1, 5, 3]\n  bar [2, 3, 4]\n  line [2 "low", 4, 6 "high"]\n  line [3, 1, 2]\n';
  const black = hex(ALIASES["canvas-label"]);
  for (const orientation of ["", " horizontal"]) {
    for (const outside of [false, true]) {
      const what = `xychart${orientation}${outside ? ", labels outside" : ""}`;
      const chart = await onPage(
        `---\nconfig:\n  xyChart:\n    showDataLabel: true\n    showDataLabelOutsideBar: ${outside}\n---\n` +
          `xychart${orientation}\n${plots}`,
      );
      // mermaid counts an xy chart's bars and lines together from 0: the first one takes kontur
      const bars = [0, 1].map((n) => [...chart.querySelectorAll(`.bar-plot-${n} > rect`)]);
      assert.deepEqual(
        bars.map((rects) => [...new Set(rects.map((rect) => paint(rect, "fill")))]),
        [[KONTUR.fill], [LEISE.fill]],
        what,
      );
      assert.deepEqual(
        [2, 3].map((n) => paint(chart.querySelector(`.line-plot-${n} > path`), "stroke")),
        [KONTUR.fill, LEISE.fill],
        what,
      );
      for (const [n, rects] of bars.entries()) {
        const fill = paint(rects[0]!, "fill");
        assert.ok(contrast(fill, WHITE) >= 3, `${what}: bar ${n}, ${fill} on white`);
        const labels = [...chart.querySelectorAll(`.bar-plot-${n} > text`)];
        assert.ok(labels.length > 0, what);
        for (const label of labels) {
          const [text, ground] = [paint(label, "fill"), outside ? WHITE : fill];
          assert.ok(contrast(text, ground) >= 4.5, `${what}: bar ${n}'s ${label.textContent}, ${text} on ${ground}`);
        }
      }
      // a line's point labels sit on white next to it
      const points = [...chart.querySelectorAll(".line-plot-2 .labels text")];
      assert.equal(points.length, 2, what);
      for (const point of points) assert.equal(paint(point, "fill"), black, `${what}: ${point.textContent}`);
    }
  }
});

test("a white data label that runs past a bar too short for it still reads, on a halo in its bar's grey (#294)", async () => {
  const plots = "  x-axis [a, b, c]\n  y-axis 0 --> 10\n  bar [3, 6, 8]\n  bar [0.2, 4, 7]\n";
  for (const orientation of ["", " horizontal"]) {
    const what = `xychart${orientation}`;
    const chart = await onPage(
      `---\nconfig:\n  xyChart:\n    showDataLabel: true\n---\nxychart${orientation}\n${plots}`,
    );
    const short = chart.querySelector(".bar-plot-1 > rect")!;
    const [x, y, width, height] = ["x", "y", "width", "height"].map((name) => Number(short.getAttribute(name))) as [
      number,
      number,
      number,
      number,
    ];
    assert.ok(width > 0 && height > 0, `${what}: the short bar is drawn`);
    // mermaid starts a label 10 px inside the bar's end, whatever the bar's length
    const label = chart.querySelector(".bar-plot-1 > text")!;
    if (orientation)
      assert.ok(Number(label.getAttribute("x")) - x < 10, `${what}: the label ends before the bar starts`);
    else assert.ok(Number(label.getAttribute("y")) >= y + height, `${what}: the label hangs below the bar`);
    for (const text of chart.querySelectorAll(".bar-plot-1 > text")) {
      const [fill, halo] = [paint(text, "fill"), paint(text, "stroke")];
      assert.equal(halo, LEISE.fill, `${what}: ${text.textContent}'s halo`);
      assert.equal(drawnStyle(text, "paint-order"), "stroke", `${what}: ${text.textContent}'s halo lies under it`);
      assert.ok(parseFloat(drawnStyle(text, "stroke-width") ?? "0") >= 2, `${what}: ${text.textContent}'s halo`);
      assert.ok(contrast(fill, halo) >= 4.5, `${what}: ${text.textContent}, ${fill} on ${halo}`);
    }
    // a kontur bar's black label reads on white too
    for (const text of chart.querySelectorAll(".bar-plot-0 > text")) {
      assert.equal(drawnStyle(text, "stroke"), undefined, `${what}: ${text.textContent}`);
    }
  }
});

test("a radar chart's grid and a quadrant chart's points take CI colours (#294)", async () => {
  const radar = await onPage("radar-beta\n  axis a, b, c\n  curve k{1, 2, 3}\n  curve l{3, 2, 1}\n");
  const grid = [...radar.querySelectorAll(".radarGraticule")];
  assert.ok(grid.length > 0);
  for (const ring of grid) {
    assert.equal(paint(ring, "stroke"), hex(ALIASES.border));
    assert.equal(paint(ring, "fill"), hex(ALIASES.border));
  }
  // mermaid derives the point colour by darkening the first quadrant's white without an amount: hsl(0, 0%, NaN%)
  const quadrant = await onPage("quadrantChart\n  x-axis Low --> High\n  y-axis Low --> High\n  Order: [0.3, 0.6]\n");
  const point = quadrant.querySelector(".data-point circle");
  assert.equal(paint(point, "fill"), hex(ALIASES["canvas-stroke"]));
  assert.equal(paint(point, "stroke"), hex(ALIASES["canvas-stroke"]));
});

test("a kanban board's columns are groups, a treemap's labels black: both hold their contrast (#294)", async () => {
  // mermaid lightens a kanban column's grey by 10 %: its titles would sit at 4.3:1
  const kanban = await onPage(
    "kanban\n  todo[To do]\n    t1[Write]\n  doing[Doing]\n    t2[Test]\n  done[Done]\n    t3[Ship]\n",
  );
  const columns = [...kanban.querySelectorAll(".cluster")];
  assert.equal(columns.length, 3);
  for (const column of columns) {
    const fill = paint(column.querySelector(":scope > rect"), "fill");
    assert.equal(fill, hex(ALIASES.secondary));
    assert.equal(paint(column.querySelector(":scope > rect"), "stroke"), hex(ALIASES.input));
    const title = paint(column.querySelector(".cluster-label span"), "color");
    assert.ok(contrast(title, fill) >= 4.5, `${title} on ${fill}`);
  }
  // as SVG text, a title sits on a box of its own that mermaid fills with the lightened grey
  const svgTitles = await onPage(
    "---\nconfig:\n  htmlLabels: false\n---\nkanban\n  todo[To do]\n    t1[Write]\n  doing[Doing]\n    t2[Test]\n",
  );
  const svgColumns = [...svgTitles.querySelectorAll(".cluster")];
  assert.equal(svgColumns.length, 2);
  for (const column of svgColumns) {
    const title = column.querySelector(".text-inner-tspan");
    for (const ground of [column.querySelector(":scope > rect"), column.querySelector("rect.background")]) {
      assert.equal(paint(ground, "fill"), hex(ALIASES.secondary));
      const [label, fill] = [paint(title, "fill"), paint(ground, "fill")];
      assert.ok(contrast(label, fill) >= 4.5, `${title!.textContent}: ${label} on ${fill}`);
    }
  }

  // a treemap lays a leaf over its section over the parent section, each faded
  const treemap = await onPage(
    'treemap-beta\n"Orders"\n  "Open"\n    "Placed": 10\n    "Packed": 20\n  "Done": 15\n"Invoices"\n  "Paid": 5\n',
  );
  const labels = [
    ...treemap.querySelectorAll(".treemapSectionLabel, .treemapSectionValue, .treemapLabel, .treemapValue"),
  ];
  assert.ok(labels.length >= 10);
  for (const label of labels) assert.equal(paint(label, "fill"), hex(ALIASES["canvas-label"]), label.textContent!);
  const section = Number(drawnStyle(treemap.querySelector("rect.treemapSection.section1")!, "fill-opacity"));
  const leaf = Number(drawnStyle(treemap.querySelector("rect.treemapLeaf")!, "fill-opacity"));
  // the darkest a label can sit on: two sections and a leaf, all in the darker grey
  const darkest = over(LEISE.fill, leaf, over(LEISE.fill, section, over(LEISE.fill, section, WHITE)));
  const black = hex(ALIASES["canvas-label"]);
  assert.ok(contrast(black, darkest) >= 4.5, `${black} on ${darkest}: ${contrast(black, darkest).toFixed(2)}:1`);
  for (const rect of treemap.querySelectorAll("rect.treemapSection, rect.treemapLeaf")) {
    const fill = drawnStyle(rect, "fill");
    if (fill !== "transparent") assert.ok([KONTUR.fill, LEISE.fill].includes(hex(fill)), `a section in ${fill}`);
  }
});

test("the neo look fills mindmap and timeline nodes white: their labels stay black (#294)", async () => {
  const neo = (options = "") => `---\nconfig:\n  look: neo\n${options}---\n`;
  const black = hex(ALIASES["canvas-label"]);
  /** every label of a node against the node's own shape */
  const assertLabels = (node: Element, shape: Element | null, labels: Element[], colour: "fill" | "color"): void => {
    assert.ok(labels.length > 0, node.textContent!);
    const fill = paint(shape, "fill");
    for (const label of labels) {
      const text = paint(label, colour);
      assert.equal(text, black, `${node.textContent}: ${text} on ${fill}`);
      assert.ok(contrast(text, fill) >= 4.5, `${node.textContent}: ${text} on ${fill}`);
    }
  };
  for (const options of ["", "  htmlLabels: false\n"]) {
    const mindmap = await onPage(neo(options) + "mindmap\n  root((Order))\n    Placed\n    Packed\n    Shipped\n");
    const nodes = [...mindmap.querySelectorAll(".mindmap-node")];
    assert.equal(nodes.length, 4);
    for (const node of nodes) {
      const shape = node.querySelector(":scope > circle, :scope > path");
      if (options) assertLabels(node, shape, [...node.querySelectorAll("text, tspan")], "fill");
      else assertLabels(node, shape, [...node.querySelectorAll("span")], "color");
    }
  }
  const timeline = await onPage(
    neo() +
      "timeline\n  section 2024\n    Q1 : Placed\n  section 2025\n    Q1 : Shipped\n  section 2026\n    Q1 : Billed\n",
  );
  const nodes = [...timeline.querySelectorAll(".timeline-node")];
  assert.equal(nodes.length, 9);
  for (const node of nodes) assertLabels(node, node.querySelector("path"), [...node.querySelectorAll("text")], "fill");
});

test("a user journey's sections take white and the calm grey in turn, under black labels (#294)", async () => {
  const svg = await onPage(
    "journey\n  title Order\n  section Place\n    Pick: 5: me\n  section Pack\n    Box: 3: me\n  section Ship\n    Send: 3: me\n  section Bill\n    Pay: 1: me\n",
  );
  const sections = [...svg.querySelectorAll("rect.journey-section")];
  const white = hex(ALIASES["canvas-shape"]);
  const grey = hex(ALIASES.secondary);
  assert.deepEqual(
    sections.map((section) => paint(section, "fill")),
    [white, grey, white, grey],
  );
  assert.deepEqual(
    [...svg.querySelectorAll("rect.task")].map((task) => paint(task, "fill")),
    [white, grey, white, grey],
  );
  for (const section of sections) {
    const label = section.parentElement!.querySelector("div.label");
    const [text, fill] = [paint(label, "color"), paint(section, "fill")];
    assert.ok(contrast(text, fill) >= 4.5, `${label!.textContent}: ${text} on ${fill}`);
  }
});

test("every id of a drawn diagram starts with its own, is there once, and its references stay inside it (#294)", async () => {
  const article = window.document.createElement("article");
  // a vertical timeline draws with a renderer of its own
  const verticalTimeline = (x: string) => `timeline TD\n  title ${x}\n  section ${x}\n    2020 : ${x}\n`;
  // each source twice, as two fences of it draw
  for (const make of [...Object.values(SOURCES), verticalTimeline]) {
    for (const _fence of [1, 2]) {
      try {
        article.append(await onPage(make("Order")));
      } catch {
        // a type jsdom cannot draw (C4 reads the screen) has nothing to check
      }
    }
  }
  const diagrams = [...article.children];
  assert.ok(diagrams.length >= 70, `only ${diagrams.length / 2} diagram types drew`);
  const ids = [...article.querySelectorAll("[id]")].map((element) => element.id);
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(repeated)], [], "an id on the page twice");
  const urls = (text: string): string[] => [...text.matchAll(/url\(\s*["']?#([^"')\s]+)/g)].map((m) => m[1]!);
  /** what a reference names that is not in its diagram, the diagram's own id taken out */
  const dangling = new Set<string>();
  for (const svg of diagrams) {
    const own = svg.id;
    const isScoped = (id: string): boolean => id.startsWith(own) && /^[^A-Za-z0-9]/.test(id.slice(own.length));
    const inside = new Set([own, ...[...svg.querySelectorAll("[id]")].map((element) => element.id)]);
    for (const id of inside) if (id !== own) assert.ok(isScoped(id), `${own}: ${id}`);
    for (const element of [svg, ...svg.querySelectorAll("*")]) {
      for (const { name, value } of element.attributes) {
        const named = [
          ...urls(value),
          // a link's #… is where a reader goes (below)
          ...((name === "href" || name === "xlink:href") && value.startsWith("#") && element.localName !== "a"
            ? [value.slice(1)]
            : []),
          ...(name === "aria-labelledby" || name === "aria-describedby" ? value.split(/\s+/) : []),
        ];
        for (const id of named) {
          // where mermaid names nothing of its own drawing, the reference still cannot leave it
          assert.ok(inside.has(id) || isScoped(id), `${own}: ${element.localName}[${name}] names #${id}`);
          if (!inside.has(id)) dangling.add(id.slice(own.length));
        }
      }
    }
    for (const style of svg.querySelectorAll("style")) {
      for (const id of urls(style.textContent ?? "")) assert.ok(isScoped(id), `${own}: its style sheet names #${id}`);
    }
  }
  // mermaid's vertical timeline draws its arrowhead as "undefined-arrowhead" and points every line at "#arrowhead"
  assert.deepEqual([...dangling], ["-arrowhead"], "a reference the sanitizer broke");
  // a link in a label keeps its #…: where a reader goes, a heading of the document say
  const linked = await onPage("flowchart LR\n  A[\"<a href='#md-orders'>Orders</a>\"] --> B\n");
  assert.equal(linked.querySelector("a")?.getAttribute("href"), "#md-orders");
});

test("@designiq/notations/mermaid mirrors the mermaid apps/web pins", () => {
  // a bump (Dependabot groups every minor) fails here until the list and the
  // preprocess patterns are re-read against the new release
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies.mermaid, MERMAID_VERSION);
  const installed = JSON.parse(
    readFileSync(new URL("../node_modules/mermaid/package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(installed.version, MERMAID_VERSION);
});

test("every diagram type the validator knows is one mermaid detects", () => {
  for (const type of MERMAID_DIAGRAM_TYPES) {
    const source = `${type}\n  x\n`;
    assert.equal(mermaidHeader(source)?.diagramType, type, type);
    assert.doesNotThrow(() => mermaid.detectType(source), type);
  }
  // and a type the list leaves out is one mermaid does not draw either
  for (const text of ["zenuml", "flowchrt LR", "Flowchart LR"]) {
    assert.throws(() => mermaid.detectType(`${text}\n  x\n`), /No diagram type detected/, text);
  }
});

function detects(source: string): boolean {
  try {
    mermaid.detectType(source);
    return true;
  } catch {
    return false;
  }
}

const parses = (source: string): Promise<boolean> =>
  mermaid.parse(source).then(
    () => true,
    () => false,
  );

test("the validator reads a type in another casing exactly where mermaid parses it (#283)", async () => {
  // a few detectors ignore case or match a shorter spelling, and many
  // grammars ignore case: a casing parses only where both read it
  const parsed: string[] = [];
  for (const type of MERMAID_DIAGRAM_TYPES) {
    const listed = SOURCES[type]!("Orders");
    assert.ok(listed.startsWith(type), type);
    const body = listed.slice(type.length);
    const casings = otherCasings(type);
    const detected = casings.filter((spelling) => detects(spelling + body));
    if (detected.length > 0) assert.ok(await parses(listed), `${type} parses as listed: a refusal is the casing's`);
    for (const spelling of casings) {
      const reads = detected.includes(spelling) && (await parses(spelling + body));
      if (reads) parsed.push(spelling);
      assert.equal(mermaidHeader(spelling + body)?.diagramType, reads ? type : undefined, spelling);
    }
  }
  // what mermaid MERMAID_VERSION does, so the loop is known to meet both outcomes
  for (const spelling of ["Ishikawa", "ISHIKAWA-BETA", "requirementdiagram", "stateDiagram-V2", "xychart-BETA"]) {
    assert.ok(parsed.includes(spelling), `${spelling} parses`);
  }
  for (const spelling of ["Wardley-beta", "RAILROAD-BETA", "classDiagram-V2", "flowchart-ELK"]) {
    assert.ok(
      detects(`${spelling}\n`) && !parsed.includes(spelling),
      `${spelling} is detected, its grammar refuses it`,
    );
  }
});
