/**
 * Hostile Mermaid sources (issue 293), shared by the suite that runs them
 * through the pinned mermaid under jsdom (mermaid-engine-hostile.test.ts) and
 * the check that opens them in the built app in headless Chromium
 * (hostile-mermaid-chromium.ts). Every address they name is on TRACKER,
 * every handler calls `__pwn`: whatever loads or runs of them is told from
 * the app's own by that alone. With a plain label, SOURCES also gives
 * mermaid-engine.test.ts a valid diagram of every type to recase.
 */

/** the host every hostile address names */
export const TRACKER = "tracker.example";
const EVIL = `https://${TRACKER}`;

/** one source per diagram type, with the label in every text slot it has */
export const SOURCES: Record<string, (label: string) => string> = {
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
export const LABELS: Record<string, string> = {
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
export const FEATURES: Record<string, string> = {
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
  "front matter: loose, a sanitizer, a title": `---\ntitle: <img src=${EVIL}/title onerror=__pwn(32)>\nconfig:\n  securityLevel: loose\n  htmlLabels: false\n  dompurifyConfig:\n    ADD_ATTR: [onerror]\n    ADD_TAGS: [script, iframe]\n---\nflowchart LR\n  A["<img src=${EVIL}/x onerror=__pwn(33)>"] --> B["<a href=javascript:__pwn(34)>b</a>"]\n  click A call __pwn(35)\n`,
  "init: loose, a sanitizer, start on load": `%%{init: {"securityLevel": "loose", "htmlLabels": false, "dompurifyConfig": {"ADD_ATTR": ["onerror"], "ADD_TAGS": ["script"]}, "startOnLoad": true}}%%\nflowchart LR\n  A["<img src=${EVIL}/x onerror=__pwn(36)>"] --> B\n  click B call __pwn(37)\n`,
  "init: CSS, fonts, arrowheads": `%%{init: {"themeCSS": "@import url(${EVIL}/t); .node{background:url(${EVIL}/t2)}", "fontFamily": "x;}*{background:url(${EVIL}/f)}", "arrowMarkerAbsolute": true, "sequence": {"actorFontFamily": "x;background:url(${EVIL}/ff)"}}}%%\nflowchart LR\n  A --> B\n`,
  "init: HTML labels off": `%%{init: {"htmlLabels": false, "flowchart": {"htmlLabels": false}}}%%\nflowchart LR\n  A["<img src=${EVIL}/hl onerror=__pwn(38)>"] --> B\n`,
  "accessible title": `flowchart LR\n  accTitle: <img src=${EVIL}/acc onerror=__pwn(39)>\n  accDescr: <svg onload=__pwn(40)>\n  A --> B\n`,
  "style breakout": `flowchart LR\n  A --> B\n  style A fill:#f00</style><img src=${EVIL}/sb onerror=__pwn(41)>\n`,
};
