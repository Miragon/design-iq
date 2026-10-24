/**
 * Mermaid as a Monaco language: the Monarch grammar a ```mermaid fence of a
 * Markdown source is highlighted with, and the editing rules inside it (`%%`
 * toggles a comment, brackets pair). Monaco's own Markdown grammar
 * hands a fence to the language its info word names, once that language is
 * registered (basic-languages/markdown/markdown.js, backtick fences only:
 * `/^\s*```\s*((?:\w|[\/\-#])+).*$/` with `nextEmbedded: "$1"`); a ~~~ fence
 * stays a plain code block. lib/monaco-languages.ts registers `mermaid` and
 * loads this module the first time a fence needs it (ADR 0006).
 *
 * Pure data. The first word names the diagram, read as the validator reads it
 * (mermaidKeywordPattern: a MERMAID_DIAGRAM_TYPES keyword in every casing
 * mermaid draws, so `Ishikawa` and `stateDiagram-V2` name one). A word that
 * names none shows as invalid, since mermaid draws no such diagram and the
 * preview's error notice says so in the same danger colour; the validator
 * only warns, so that a save goes through. The keyword picks the family the
 * rest is read in, as its listed spelling would; a family Mermaid's own lexer
 * reads without case (sequence, state, ER, gantt …) matches its words
 * without case.
 * The tokens land on the theme's roles only (lib/monaco-theme.ts has a rule
 * for every one):
 *
 *   keyword          the header and the statements          structure
 *   operator         arrows, links, relations, cardinalities structure
 *   constant         directions, [*], link targets          number
 *   variable         node, participant, class and state ids name
 *   type             keys: front matter, %%{…}%%, @{…}      name
 *   attribute.name   C4's $parameters, style properties     name
 *   string           quoted text, labels, a shape's text    literal
 *   number           numbers, dates, durations, colours     number
 *   comment, annotation, metatag, delimiter                 quiet
 *                    %% lines, directives and stereotypes,
 *                    the front matter's ---, punctuation
 *   invalid          a first word that names no diagram     danger
 *
 * Robust on any text: every rule consumes some (the one exception pops a
 * style line's state at the next line's start), no pattern backtracks out
 * of hand on a long line, and only quoted strings, a node's shape, the front
 * matter, a directive, @{…} and a state's note go on over a line break, each
 * closed by its own end: the stack never grows past three.
 * test/mermaid-monarch.test.ts runs it all through Monaco's own lexer.
 */
import { MERMAID_DIAGRAM_TYPES, mermaidKeywordPattern } from "@designiq/notations/mermaid";
import type { languages } from "monaco-editor";

type Rule = languages.IMonarchLanguageRule;

/** a letter of an id: ASCII, the underscore and everything past Latin-1's
 *  symbols (Prüfung, 注文) */
const LETTER = "A-Za-z_\\u00C0-\\uFFFF";
const ID = `[${LETTER}][${LETTER}0-9]*`;
/** an id that may hold hyphens (my-node, LINE-ITEM, x-axis), never an
 *  arrow's: A-->B stays A, -->, B */
const HYPHENATED_ID = `${ID}(?:-[${LETTER}0-9]+)*`;
/** the end of a word: no letter or digit follows; where ids hold hyphens,
 *  no hyphen joining one either */
const END = `(?![${LETTER}0-9])`;
const HYPHENATED_END = `(?![${LETTER}0-9]|-[${LETTER}0-9])`;

/**
 * Words as one alternation, the longest first (a regex takes the first
 * alternative that fits); a space stands for any run of blanks, and
 * `caseless` matches every letter in either case (Monarch's ignoreCase would
 * hold for the whole language).
 */
function words(entries: readonly string[], caseless = false): string {
  return [...entries]
    .sort((a, b) => b.length - a.length)
    .map((word) =>
      [...word]
        .map((c) => {
          if (c === " ") return "\\s+";
          if (caseless && /[a-z]/i.test(c)) return `[${c.toUpperCase()}${c.toLowerCase()}]`;
          return /\w/.test(c) ? c : `\\${c}`;
        })
        .join(""),
    )
    .join("|");
}

/**
 * A link with its text between the two halves: A -- text --> B. The text
 * holds no pipe and never a pair either half starts with (`pairs`, each a
 * character and the one that may not follow it; the closing half's first),
 * so the search for a closing half ends at the next link's opening one: a
 * line of many links still reads in linear time.
 */
function linkText(open: string, close: string, pairs: readonly (readonly [string, string])[]): Rule {
  const char = `(?:[^|${pairs.map(([c]) => c).join("")}]|${pairs.map(([c, after]) => `${c}(?!${after})`).join("|")})`;
  const edge = `[^\\s|${pairs[0]![0]}]`;
  return [
    new RegExp(`([xo<]?${open})(\\s+)(${edge}(?:${char}*?${edge})?)(\\s+)(${close})`),
    ["operator", "", "string", "", "operator"],
  ];
}

/** a label to the end of the line: A->>B: Hello, s1 --> s2 : starts */
const LABEL: Rule = [/(:)(\s*)(.*)$/, ["delimiter", "", "string"]];

/** a word list written as text: words and phrases between commas */
const list = (...lines: string[]): string[] => lines.flatMap((line) => line.split(/,\s*/));

const DIRECTIONS = list("TB, TD, BT, RL, LR");
const LINK_TARGETS = list("_self, _blank, _parent, _top");
const TITLES = list("title, accTitle, accDescr, accDescription");
const STYLES = list("style, classDef, linkStyle");

interface Family {
  /** the header keywords that open it */
  headers: readonly string[];
  /** Mermaid's own lexer for it ignores case */
  caseless?: boolean;
  /** its ids may hold hyphens */
  hyphens?: boolean;
  /** statements whose line goes on as a label: title My diagram */
  labelled: readonly string[];
  /** it styles with `style id fill:…` lines (and classDef, linkStyle) */
  styles?: boolean;
  keywords: readonly string[];
  constants?: readonly string[];
  /** its own rules, before the words: arrows, labels, line forms */
  rules?: Rule[];
}

const FAMILIES: Record<string, Family> = {
  flowchart: {
    headers: list("flowchart, flowchart-elk, graph"),
    hyphens: true,
    labelled: list("accTitle, accDescr"),
    styles: true,
    keywords: [...list("subgraph, end, direction, class, click, call, href, default, interpolate"), ...STYLES],
    constants: [...DIRECTIONS, ...LINK_TARGETS],
    rules: [
      linkText("--", "--+[-xo>]", [["\\-", "-"]]),
      linkText("==", "==+[=xo>]", [["=", "="]]),
      // a dotted link's halves start apart: .- closes, -. opens
      linkText("-\\.", "\\.{1,12}-[xo>]?", [
        ["\\.", "-"],
        ["\\-", "\\."],
      ]),
      [/[xo<]?(?:--+[-xo>]|==+[=xo>]|-?\.{1,12}-[xo>]?)|~~~+|--|==|-\./, "operator"],
      // an edge label: A -->|text| B
      [/(\|)([^|]*)(\|)/, ["delimiter", "string", "delimiter"]],
      [/:::/, "operator"],
      // a node's shape around its text: A[…] A(…) A((…)) A{…} A{{…}}
      // A[(…)] A([…]) A[[…]] A[/…/] A[\…\] A(((…))) A>…]
      [new RegExp(`(${HYPHENATED_ID})(>)`), ["variable", { token: "delimiter.bracket", next: "@shape" }]],
      [/\(\(\(|\(\[|\[\(|\(\(|\[\[|\{\{|\[\/|\[\\|[[({]/, { token: "delimiter.bracket", next: "@shape" }],
    ],
  },
  sequence: {
    headers: list("sequenceDiagram"),
    caseless: true,
    labelled: [...TITLES, ...list("loop, alt, else, opt, par, par_over, and, critical, option, break, box")],
    keywords: list(
      "participant, actor, end, note, over, left of, right of, activate, deactivate, autonumber, off",
      "create, destroy, link, links, properties, details, rect",
    ),
    rules: [
      // messages: ->> -->> -> --> -x --x -) --) <<->> <<-->>, with an activation + or -
      [/<<-{1,2}>>|-{1,2}(?:>>|[>x)])[+-]?/, "operator"],
      // an alias: participant A as Alice Smith
      [new RegExp(`(${words(["as"], true)})(\\s+)(.*)$`), ["keyword", "", "string"]],
      // a message's or a note's text: A->>B: Hello
      LABEL,
    ],
  },
  class: {
    headers: list("classDiagram, classDiagram-v2"),
    labelled: TITLES,
    styles: true,
    keywords: [
      ...list("class, namespace, note for, note, cssClass, callback, link, click, call, href, direction"),
      ...STYLES,
    ],
    constants: [...DIRECTIONS, ...LINK_TARGETS],
    rules: [
      // a member's visibility, at the start of its line: +name -name #name ~name
      [/^(\s*)([-+#~])/, ["", "operator"]],
      [/<<[^<>]*>>/, "annotation"],
      // relations, either end: <|-- *-- o-- --> -- ..> ..|> .. ()--
      [/(?:<\||[*o<]|\(\))?(?:--|\.\.)(?:\|>|[*o>]|\(\))?/, "operator"],
      [/:::/, "operator"],
      LABEL,
    ],
  },
  state: {
    headers: list("stateDiagram, stateDiagram-v2"),
    caseless: true,
    labelled: TITLES,
    styles: true,
    keywords: [
      ...list("state, note, as, direction, class, left of, right of, click, href, default"),
      ...list("hide empty description, scale, width"),
      ...STYLES,
    ],
    constants: DIRECTIONS,
    rules: [
      // a note on lines of its own, up to `end note`
      [
        new RegExp(
          `^(\\s*)(${words(["note"], true)})(\\s+)(${words(["left of", "right of"], true)})(\\s+)(${ID})(\\s*)$`,
        ),
        ["", "keyword", "", "keyword", "", { token: "variable", next: "@stateNote" }, ""],
      ],
      [/\[\*\]/, "constant"],
      [/<<[^<>]*>>|\[\[(?:fork|join|choice)\]\]/, "annotation"],
      [/-->|--/, "operator"],
      [/:::/, "operator"],
      LABEL,
    ],
  },
  er: {
    headers: list("erDiagram"),
    caseless: true,
    hyphens: true,
    labelled: TITLES,
    styles: true,
    keywords: [...list("PK, FK, UK, direction, class"), ...STYLES],
    constants: DIRECTIONS,
    rules: [
      // a relationship's cardinalities: ||--o{  }|..|{  |o--o|, or in words
      [/(?:\|o|\|\||\}o|\}\|)(?:--|\.\.)(?:o\||\|\||o\{|\|\{)/, "operator"],
      [
        new RegExp(
          `(?:${words(
            list(
              "only one, zero or one, one or zero, one or more, one or many, zero or more, zero or many",
              "many(0), many(1), optionally to, to",
            ),
            true,
          )})${HYPHENATED_END}`,
        ),
        "operator",
      ],
      LABEL,
    ],
  },
  gantt: {
    headers: list("gantt"),
    caseless: true,
    hyphens: true,
    labelled: [
      ...TITLES,
      ...list("section, dateFormat, axisFormat, tickInterval, includes, excludes, todayMarker, weekday, weekend"),
    ],
    keywords: list("after, until, done, active, crit, milestone, vert, click, call, href, inclusiveEndDates, topAxis"),
    rules: [
      // a click line, before a task would take its URL's colon
      [new RegExp(`^(\\s*)(${words(["click"], true)})${HYPHENATED_END}`), ["", "keyword"]],
      // a task: its name, then its data (an id, after …, a date, a duration)
      [/^(\s*)([^:%\s](?:[^:]*[^:\s])?)(\s*)(:)/, ["", "string", "", "delimiter"]],
    ],
  },
  c4: {
    headers: list("C4Context, C4Container, C4Component, C4Dynamic, C4Deployment"),
    labelled: TITLES,
    keywords: list(
      "Person, Person_Ext, System, System_Ext, SystemDb, SystemDb_Ext, SystemQueue, SystemQueue_Ext",
      "Container, Container_Ext, ContainerDb, ContainerDb_Ext, ContainerQueue, ContainerQueue_Ext",
      "Component, Component_Ext, ComponentDb, ComponentDb_Ext, ComponentQueue, ComponentQueue_Ext",
      "Boundary, Enterprise_Boundary, System_Boundary, Container_Boundary, Deployment_Node, Node, Node_L, Node_R",
      "Rel, BiRel, Rel_U, Rel_Up, Rel_D, Rel_Down, Rel_L, Rel_Left, Rel_R, Rel_Right, Rel_Back, RelIndex",
      "UpdateElementStyle, UpdateRelStyle, UpdateLayoutConfig",
    ),
    rules: [[/\$\w+/, "attribute.name"]],
  },
  git: {
    headers: list("gitGraph"),
    hyphens: true,
    labelled: TITLES,
    keywords: list("commit, branch, checkout, switch, merge, cherry-pick, id, tag, type, order, parent"),
    constants: [...DIRECTIONS, ...list("NORMAL, REVERSE, HIGHLIGHT")],
  },
  chart: {
    headers: list("xychart, xychart-beta, quadrantChart, radar-beta"),
    caseless: true,
    hyphens: true,
    labelled: [...TITLES, ...list("quadrant-1, quadrant-2, quadrant-3, quadrant-4")],
    keywords: list(
      "x-axis, y-axis, bar, line, horizontal, vertical, axis, curve, max, min, ticks, graticule, showLegend",
    ),
  },
  requirement: {
    headers: list("requirementDiagram"),
    caseless: true,
    hyphens: true,
    labelled: TITLES,
    styles: true,
    keywords: [
      ...list("requirement, functionalRequirement, interfaceRequirement, performanceRequirement"),
      ...list("physicalRequirement, designConstraint, element, direction, class"),
      ...list("contains, copies, derives, satisfies, verifies, refines, traces"),
      ...STYLES,
    ],
    constants: DIRECTIONS,
    rules: [
      // a field: id: 1, text: the text, risk: high
      [
        new RegExp(`^(\\s*)(${words(list("id, text, risk, verifymethod, type, docref"), true)})(\\s*)(:)(\\s*)(.*)$`),
        ["", "keyword", "", "delimiter", "", "string"],
      ],
    ],
  },
  // every other diagram: pie, journey, mindmap, timeline, kanban, block,
  // architecture, sankey, packet, treemap …
  generic: {
    headers: [],
    hyphens: true,
    labelled: [...TITLES, "section"],
    styles: true,
    keywords: [...list("direction, end, class, showData"), ...STYLES],
    constants: DIRECTIONS,
  },
};

/** a family's state: the meta lines, its line forms and own rules, then its
 *  words and what every diagram shares */
function familyState(family: Family): Rule[] {
  const end = family.hyphens ? HYPHENATED_END : END;
  const rules: Rule[] = [
    { include: "@meta" },
    [new RegExp(`^(\\s*)(${words(family.labelled, family.caseless)})${end}(\\s*)(.*)$`), ["", "keyword", "", "string"]],
  ];
  if (family.styles) {
    // style A fill:…, linkStyle 0,1 stroke:…: the rest of the line reads as
    // style properties
    rules.push([
      new RegExp(`^(\\s*)(${words(STYLES, family.caseless)})(\\s+)(\\S+)`),
      [
        "",
        "keyword",
        "",
        {
          cases: {
            "~[0-9,]+": { token: "number", next: "@style" },
            default: { token: "keyword", next: "@style" },
            "@default": { token: "variable", next: "@style" },
          },
        },
      ],
    ]);
  }
  rules.push(...(family.rules ?? []));
  rules.push([new RegExp(`(?:${words(family.keywords, family.caseless)})${end}`), "keyword"]);
  if (family.constants) rules.push([new RegExp(`(?:${words(family.constants)})${end}`), "constant"]);
  rules.push([new RegExp(family.hyphens ? HYPHENATED_ID : ID), "variable"], { include: "@common" });
  return rules;
}

/** header keywords as one alternation, each in every casing the validator
 *  reads it in */
const headerKeywords = (types: readonly string[]): string => types.map(mermaidKeywordPattern).join("|");

export const language: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".mermaid",
  start: "root",
  tokenizer: {
    // before the header: front matter, directives, comments
    root: [
      [/^\s*---\s*$/, { token: "metatag", next: "@frontMatter" }],
      { include: "@meta" },
      [/\s+/, ""],
      [
        new RegExp(`(?:${headerKeywords(MERMAID_DIAGRAM_TYPES)})(?=$|[\\s:;])`),
        {
          // a `~` case matches the header against a pattern, so a family
          // takes its keywords in every casing the validator reads
          cases: {
            ...Object.fromEntries(
              Object.entries(FAMILIES)
                .filter(([name]) => name !== "generic")
                .map(([name, family]) => [
                  `~(?:${headerKeywords(family.headers)})`,
                  { token: "keyword", switchTo: `@${name}` },
                ]),
            ),
            "@default": { token: "keyword", switchTo: "@generic" },
          },
        },
      ],
      [/[^\s%]+/, { token: "invalid", switchTo: "@generic" }],
    ],
    ...Object.fromEntries(Object.entries(FAMILIES).map(([name, family]) => [name, familyState(family)])),

    // a %% comment is a line of its own (inline, Mermaid reads it as text);
    // a %%{…}%% directive may stand anywhere
    meta: [
      [/^\s*%%(?!\{).*$/, "comment"],
      [/%%\{/, { token: "annotation", next: "@directive" }],
    ],
    common: [
      [/\s+/, ""],
      [/"/, { token: "string", next: "@string" }],
      [/@\{/, { token: "delimiter.bracket", next: "@attrs" }],
      [/#[0-9A-Fa-f]{3,8}(?!\w)/, "number"],
      [/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?/, "number"],
      [/\d+(?:\.\d+)?(?:%|[A-Za-z]+)?/, "number"],
      [/[{}()[\]]/, "delimiter.bracket"],
      [/[;,:|]/, "delimiter"],
      [/[-=<>~*+&^]+/, "operator"],
    ],
    string: [
      [/[^"]+/, "string"],
      [/"/, { token: "string", next: "@pop" }],
    ],
    // a flowchart node's text, up to the bracket that closes its shape
    shape: [
      [/\)\)\)|\)\]|\]\)|\)\)|\]\]|\}\}|\/\]|\\\]|[\])}]/, { token: "delimiter.bracket", next: "@pop" }],
      [/"/, { token: "string", next: "@string" }],
      [/[^\])}"/\\]+/, "string"],
      [/[/\\]/, "string"],
    ],
    // a style line's properties: fill:…,stroke-width:2px; the state ends with its line
    style: [
      [/^/, { token: "", next: "@pop" }],
      [/\s+/, ""],
      [/[A-Za-z-]+(?=\s*:)/, "attribute.name"],
      [/#[0-9A-Fa-f]{3,8}(?!\w)/, "number"],
      [/-?\d+(?:\.\d+)?(?:%|[A-Za-z]+)?/, "number"],
      [/[:,;]/, "delimiter"],
      [/[^\s:,;]+/, "string"],
    ],
    stateNote: [
      [new RegExp(`^(\\s*)(${words(["end note"], true)})${END}`), ["", { token: "keyword", next: "@pop" }]],
      [/.+/, "string"],
    ],
    // a diagram's own front matter: YAML between two --- lines
    frontMatter: [
      [/^\s*---\s*$/, { token: "metatag", next: "@pop" }],
      [/#.*$/, "comment"],
      [/-(?=\s|$)/, "delimiter"],
      { include: "@data" },
    ],
    directive: [
      [/\}%%/, { token: "annotation", next: "@pop" }],
      [/(?:init|initialize|wrap|config)(?![\w-])/, "keyword"],
      { include: "@data" },
    ],
    // a node's or an edge's metadata: A@{ shape: rect, label: "Start" }
    attrs: [[/\}/, { token: "delimiter.bracket", next: "@pop" }], { include: "@data" }],
    // the values of front matter, directives and @{…}: YAML and JSON alike
    data: [
      [/\s+/, ""],
      [/(?:"[^"]*"|'[^']*')(?=\s*:)|[A-Za-z_][\w-]*(?=\s*:(?:\s|$))/, "type"],
      [/"[^"]*"|'[^']*'/, "string"],
      [/-?\d+(?:\.\d+)?(?![\w-])/, "number"],
      [/(?:true|false|null)(?![\w-])/, "keyword"],
      [/[{}[\]]/, "delimiter.bracket"],
      [/[:,]/, "delimiter"],
      [/[^\s{}[\]:,"'%]+/, "string"],
    ],
  },
};

/**
 * The editing rules of a fence. Monaco reads the comment and the bracket
 * pairs in the language at the cursor, so in a fence Toggle Line Comment
 * writes `%%` and the brackets pair. Auto-closing and surrounding pairs it
 * reads in the MODEL's language (cursorCommon.js), and no model is Mermaid:
 * in a fence they stay Markdown's.
 */
export const conf: languages.LanguageConfiguration = {
  comments: { lineComment: "%%" },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
};
