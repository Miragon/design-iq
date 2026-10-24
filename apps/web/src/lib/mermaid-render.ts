/**
 * The ONE Mermaid renderer of the web app: Mermaid source in, an SVG string
 * or a readable error out. It runs in the Mermaid frame, never in the page
 * (./mermaid-frame.ts says why; `pnpm arch`, rule
 * mermaid-renders-in-its-frame): a mermaid fence in the Markdown view
 * (notations/markdown/mermaid-fence.ts), and any other surface that shows a
 * diagram, draws through the frame.
 *
 * ADR 0006: mermaid is large, so it loads behind the dynamic import in
 * loadMermaid() and nowhere else (`pnpm arch`, rules mermaid-loads-lazily
 * and mermaid-loads-in-the-renderer-only).
 * The page reaches the frame through import() too, so the eager bundle, the
 * repo overview and every document without a diagram never carry it.
 *
 * The rest is pure (config, ids, error wording) and runs under node --test:
 * mermaid itself needs a DOM to measure text.
 */
import { mermaidCode, mermaidFrontMatterLines, mermaidHeader, mermaidSourceLine } from "@designiq/notations/mermaid";
import { ALIASES, CD, FONT_SANS } from "@designiq/ui-kit/lib/tokens";
import type { Mermaid, MermaidConfig } from "mermaid";

import { canvasFontReady } from "./canvas-theme.ts";
import { CSS_RESOURCE } from "./css-resource.ts";

/**
 * The two CI greys mermaid's section palettes alternate between, each with
 * the label colour that holds 4.5:1 on it. Both hold 3:1 as a line on white
 * (a mindmap's branches, a git graph's). mermaid numbers a mindmap's first
 * branch (its section 0 takes cScale1), a pie's first slice, a git graph's
 * first branch after main and a venn diagram's first set 1: odd numbers take
 * kontur, even ones text-leise.
 */
const SECTION_GREYS = [
  { fill: CD.textLeise, label: CD.weiss },
  { fill: CD.kontur, label: CD.schwarz },
] as const;
const sectionGrey = (n: number) => SECTION_GREYS[n % 2]!;

/** the theme variables `<name><from>` to `<name><to>`, each set to what its number gives */
const numbered = (name: string, from: number, to: number, value: (n: number) => string): Record<string, string> =>
  Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [`${name}${from + i}`, value(from + i)]));

/**
 * The palettes mermaid would otherwise derive from the theme's base colours
 * by shifting their hue and darkening them: the white and the warm grey turn
 * rose (sections of mindmaps, timelines, kanban boards, treemaps and radar
 * charts, a git graph's branches, pie slices, venn sets), the rest into greys
 * off the CI. mermaid derives a section's label, border (peer) and the line
 * under a node (inv) from the darkened colour too, so they are set as well.
 * A mindmap's root and a git graph's main branch take git0: black with a
 * white label. A highlighted commit is framed in black, a CI neutral: blue on
 * the canvas means selected. A user journey's sections take white and the
 * calm grey in turn, as its first two would, under black labels. An xy
 * chart's bars and lines would take mermaid's own peach palette, its first
 * bar #FFF4DD on white (1.1:1): they take the two greys too, the first one
 * (mermaid counts it 0) kontur.
 */
const SECTION_PALETTES = {
  ...numbered("cScale", 0, 11, (n) => sectionGrey(n).fill),
  ...numbered("cScaleLabel", 0, 11, (n) => sectionGrey(n).label),
  ...numbered("cScalePeer", 0, 11, (n) => sectionGrey(n).fill),
  ...numbered("cScaleInv", 0, 11, (n) => sectionGrey(n).fill),
  git0: ALIASES["canvas-stroke"],
  gitBranchLabel0: ALIASES["canvas-shape"],
  ...numbered("git", 1, 7, (n) => sectionGrey(n).fill),
  ...numbered("gitBranchLabel", 1, 7, (n) => sectionGrey(n).label),
  ...numbered("gitInv", 0, 7, () => ALIASES["canvas-stroke"]),
  ...numbered("pie", 1, 12, (n) => sectionGrey(n).fill),
  ...numbered("venn", 1, 8, (n) => sectionGrey(n).fill),
  ...numbered("fillType", 0, 7, (n) => (n % 2 ? ALIASES.secondary : ALIASES["canvas-shape"])),
  xyChart: { plotColorPalette: [1, 2].map((n) => sectionGrey(n).fill).join(",") },
};

/**
 * The Miragon CI as Mermaid's "base" theme. Literal colours from the tokens
 * mirror, never var(--…): mermaid derives shades from them (it parses the
 * values) and writes them into the SVG's own style block. The nodes take the
 * canvas set every diagram engine of the app draws with (white shapes, dark
 * strokes and labels, as in bpmn-js); groups, notes and activations sit on
 * the calm grey with a border that holds 3:1. Diagram types that colour by
 * section take two CI greys instead of what mermaid derives (SECTION_PALETTES).
 */
export const MERMAID_THEME_VARIABLES = {
  darkMode: false,
  background: ALIASES["canvas-background"],
  fontFamily: FONT_SANS,
  primaryColor: ALIASES["canvas-shape"],
  primaryBorderColor: ALIASES["canvas-stroke"],
  primaryTextColor: ALIASES["canvas-label"],
  lineColor: ALIASES["canvas-stroke"],
  textColor: ALIASES.foreground,
  titleColor: ALIASES.foreground,
  edgeLabelBackground: ALIASES["canvas-background"],
  secondaryColor: ALIASES.secondary,
  secondaryBorderColor: ALIASES.input,
  secondaryTextColor: ALIASES["secondary-foreground"],
  tertiaryColor: ALIASES.secondary,
  tertiaryBorderColor: ALIASES.input,
  tertiaryTextColor: ALIASES["secondary-foreground"],
  clusterBkg: ALIASES.secondary,
  clusterBorder: ALIASES.input,
  noteBkgColor: ALIASES.secondary,
  noteBorderColor: ALIASES.input,
  noteTextColor: ALIASES["secondary-foreground"],
  // mermaid darkens the first quadrant's white without an amount: hsl(0, 0%, NaN%)
  quadrantPointFill: ALIASES["canvas-stroke"],
  // a radar chart's grid, in mermaid's own light grey otherwise
  radar: { graticuleColor: ALIASES.border },
  ...SECTION_PALETTES,
} as const;

/** an xy chart's bar groups of an odd number, drawn in text-leise */
const XY_TEXT_LEISE_BARS = ["1", "3", "5", "7", "9"].map((digit) => `[class^="bar-plot-"][class$="${digit}"]`);
/** a data label inside its bar: an upright bar's hangs from the bar's top, a horizontal one's ends at its end */
const XY_LABELS_INSIDE = XY_TEXT_LEISE_BARS.flatMap((bar) => [
  `${bar} > text[dominant-baseline="hanging"]`,
  `${bar} > text[text-anchor="end"]`,
]);

/**
 * Where mermaid draws a section's label on something other than the grey it
 * was paired with, the label loses its contrast:
 * - A kanban board lightens a column's grey by 10 % (its HTML titles stay
 *   black, 4.3:1 on the darker grey; its SVG titles turn white, 3.9:1). A
 *   column takes the calm grey and the border of every other group instead,
 *   its title black.
 * - A treemap lays its sections over each other at 60 % opacity and colours
 *   a label by the label's own number, not by the section under it: its
 *   sections are drawn lighter and every label in black.
 * - The neo look (a diagram may pick it) fills mindmap and timeline nodes
 *   white and keeps the section's label colour: their labels stay black.
 * - A timeline brightens its events by 20 % (a white label then reads 4.2:1,
 *   and both greys leave the CI): an event keeps its section's grey.
 * - An xy chart writes the data labels of every bar in one colour, black
 *   (3.0:1 on text-leise), and a line's point labels in the line's grey
 *   (kontur reads 3.4:1 on white): inside a text-leise bar, one with an odd
 *   number (the last digit of its group's class), they turn white; point
 *   labels are black. mermaid starts a label inside the bar's end however
 *   short the bar is, so a white one lies on a halo in its bar's grey,
 *   which reads where the label runs past the bar onto white.
 * mermaid's own selectors for treemap and neo labels name every section,
 * hence !important.
 */
export const MERMAID_THEME_CSS = [
  `.cluster[class*="section-"] rect { fill: ${ALIASES.secondary}; stroke: ${ALIASES.input}; }`,
  `.cluster[class*="section-"] text { fill: ${ALIASES["canvas-label"]}; }`,
  "rect.treemapSection { fill-opacity: 0.3; }",
  `.treemapSectionLabel, .treemapSectionValue, .treemapLabel, .treemapValue { fill: ${ALIASES["canvas-label"]} !important; }`,
  `[data-look="neo"].mindmap-node text, [data-look="neo"].mindmap-node tspan, .timeline-node[data-look="neo"] text { fill: ${ALIASES["canvas-label"]} !important; }`,
  `[data-look="neo"].mindmap-node span { color: ${ALIASES["canvas-label"]} !important; }`,
  ".eventWrapper { filter: none; }",
  `${XY_LABELS_INSIDE.join(", ")} { fill: ${ALIASES["canvas-shape"]}; stroke: ${ALIASES["muted-foreground"]}; stroke-width: 3px; stroke-linejoin: round; paint-order: stroke; }`,
  `[class^="line-plot-"] > .labels > text { fill: ${ALIASES["canvas-label"]}; }`,
].join("\n");

/**
 * What mermaid's sanitizer keeps out of a label's HTML (`dompurifyConfig`):
 * its own default (no `style` element), and everything that loads a
 * resource. Under `strict` an <img>, a picture or video, an SVG image or a
 * style attribute's url() in a label would otherwise load from its host,
 * with every reader's IP address, as mermaid lays the diagram out (#290).
 * Links stay: they load nothing until clicked.
 */
export const MERMAID_LABEL_SANITIZER = {
  FORBID_TAGS: [
    "style",
    "img",
    "picture",
    "source",
    "video",
    "audio",
    "track",
    "input",
    "object",
    "embed",
    "iframe",
    "link",
    "image",
    "feimage",
    "use",
  ],
  FORBID_ATTR: ["style", "src", "srcset", "poster", "background"],
};

/**
 * The keys a diagram's own front matter (`config:`) or %%{init}%% directive
 * may NOT set: mermaid's own secure list, plus everything that makes up the
 * look, and the label sanitizer: a diagram could hand mermaid's default back
 * and with it the images in labels. A diagram copied from a repo that draws it dark would otherwise get
 * a hybrid (mermaid merges the CI variables into the other theme's palette:
 * near-black boxes with near-black labels), and `themeCSS` would let any
 * collaborator inject CSS (a `url()` in it is a request from every reader's
 * browser). mermaid checks the list at every level of a config, so a theme
 * scoped to one diagram type (`flowchart: { theme: dark }`, new in mermaid 12)
 * is refused too. Layout options (direction, curve, wrap, look, layout) stay
 * the author's; `arrowMarkerAbsolute` does not (#293): it points every
 * arrowhead at the address of the document mermaid draws in, which is the
 * frame's (./mermaid-frame.ts), an address the page drops.
 */
export const MERMAID_SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "theme",
  "themeVariables",
  "themeCSS",
  "darkMode",
  "fontFamily",
  "altFontFamily",
  "dompurifyConfig",
  "arrowMarkerAbsolute",
];

/**
 * mermaid.initialize's options. `strict` sanitises every label and the whole
 * SVG (DOMPurify) and turns click handlers off: the source is whatever any
 * collaborator typed. HTML labels (mermaid's default, set here on purpose)
 * wrap long labels and stay inert under `strict`. `suppressErrorRendering`
 * keeps mermaid from drawing its own error picture; the caller shows the
 * error and keeps the last good diagram instead. The CI look is not a
 * default but fixed: see MERMAID_SECURE_KEYS. The classic look and the dagre
 * layout are defaults a diagram may change: without them mermaid 12 draws
 * most diagram types in its `neo` look (gradient strokes and drop shadows on
 * the canvas set) and lays the graphs out with ELK, which moves the boxes of
 * every diagram already written. dagre is set per diagram type that had it:
 * a top-level layout would also take mindmaps off cose-bilkent and swimlanes
 * off their lanes. mermaid 12's sizing is left as it is (in flowchart and
 * state diagrams every label but a circle's gets at least 120 px and wraps
 * at 120, not 200): it is not part of mermaid's migration advice, and an
 * author can set it.
 */
export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  themeVariables: MERMAID_THEME_VARIABLES,
  themeCSS: MERMAID_THEME_CSS,
  fontFamily: FONT_SANS,
  htmlLabels: true,
  look: "classic",
  flowchart: { layout: "dagre" },
  class: { layout: "dagre" },
  state: { layout: "dagre" },
  er: { layout: "dagre" },
  requirement: { layout: "dagre" },
  suppressErrorRendering: true,
  dompurifyConfig: MERMAID_LABEL_SANITIZER,
  secure: MERMAID_SECURE_KEYS,
} as const satisfies MermaidConfig;

let renderSeq = 0;

/**
 * A fresh element id for one render. mermaid scopes the diagram's styles to
 * `#<id>` and measures inside a temporary `#d<id>`, so two renders (or two
 * diagrams on one page) must never share one: the prefix names the surface,
 * the counter makes every render unique. Ids are CSS identifiers: anything
 * else in the prefix becomes "-", and it starts with a letter.
 */
export function mermaidRenderId(prefix: string): string {
  const safe = prefix.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z]+/, "");
  return `${safe || "mermaid"}-${++renderSeq}`;
}

export interface MermaidRenderError {
  /** 1-based line in the SOURCE, when mermaid names one */
  line?: number;
  /** what is wrong, without mermaid's "Parse error on line N" lead (the
   *  notice says the line itself) */
  message: string;
}

export type MermaidRenderResult = { svg: string } | { error: MermaidRenderError };

/** the SOURCE line an error names. The jison parsers' hash.loc (exact even
 *  at the end of the text, where the message's own line number runs late)
 *  and the "line N" of the langium parsers' messages count lines of the
 *  parsed code. agentflow's own errors (a shape or YAML problem in an `@{…}`
 *  block) carry a hash.loc without a token that adds the front matter's
 *  lines to it. */
function sourceLineOf(error: unknown, message: string, source: string): number | undefined {
  const hash = (error as { hash?: { token?: unknown; loc?: { first_line?: unknown } } } | null)?.hash;
  const loc = hash?.loc?.first_line;
  if (typeof loc === "number" && loc > 0) {
    return mermaidSourceLine(source, hash?.token === null ? loc - mermaidFrontMatterLines(source) : loc);
  }
  const named = /\bline (\d+)/i.exec(message)?.[1];
  return named ? mermaidSourceLine(source, Number(named)) : undefined;
}

/** what a shape's image from an address reads as, refused in the source
 *  (diagramImageRefusal) or, where that check misses it, by the frame's policy */
export const SHAPE_IMAGE_FROM_ADDRESS =
  "A shape's image (img) is not drawn: it would load from its address for every reader. Use a data:image/ URL or remove it.";

/** a shape's `img` key (quoted or not) and its value, up to where the value ends */
const SHAPE_IMAGE = /@\{[^}]*?\bimg["']?\s*:\s*["']?\s*([^"'\s,}]*)/gi;

/** the 1-based line of the first shape image that is not inline image data */
function shapeImageFromAddressLine(source: string): number | undefined {
  for (const m of source.matchAll(SHAPE_IMAGE)) {
    if (!/^data:image\//i.test(m[1]!)) return source.slice(0, m.index + m[0].length).split("\n").length;
  }
  return undefined;
}

/**
 * mermaid's image shape decodes its `img` before it lays the shape out, and
 * the frame's policy (#293) loads no image from an address, the app's own
 * included: an img diagramImageRefusal did not read as one fails to decode
 * with a DOMException (Chromium's message "The source image cannot be
 * decoded" blames the image, not the policy), and with it the whole diagram.
 */
function imageDecodeFailed(error: unknown): boolean {
  const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
  return name === "EncodingError" || (typeof message === "string" && /source image cannot be decoded/i.test(message));
}

/**
 * What a failed mermaid parse or render means for the person typing: the
 * source line (mermaid counts lines AFTER dropping the front matter and, for
 * most diagram types, the comments; @designiq/notations/mermaid maps them
 * back) and the message. A missing or unknown diagram type reads like the
 * validator's header check, a shape image the frame refused like
 * diagramImageRefusal's refusal of it.
 */
export function describeMermaidError(error: unknown, source: string): MermaidRenderError {
  if (imageDecodeFailed(error)) {
    const line = shapeImageFromAddressLine(source);
    return line === undefined
      ? { message: "A shape's image (img) cannot be decoded. Check its data:image/ URL or remove it." }
      : { line, message: SHAPE_IMAGE_FROM_ADDRESS };
  }
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  if (raw.startsWith("No diagram type detected")) {
    const header = mermaidHeader(source);
    if (!header) return { message: "The diagram is empty. Start it with a diagram type, for example flowchart LR." };
    const word = header.text.split(/[\s:;]/, 1)[0];
    return {
      line: header.line,
      message: `"${word}" is not a Mermaid diagram type. Start with one, for example flowchart LR.`,
    };
  }
  const line = sourceLineOf(error, raw, source);
  const message = raw
    .replace(/^Parsing failed:\s*/, "")
    .replace(/^(?:Parse|Lexer|Lexical) error on line \d+(?:, column \d+)?[:.]?\s*/, "")
    .trim();
  return {
    message: message || raw || "The diagram could not be drawn.",
    ...(line !== undefined ? { line } : {}),
  };
}

/** the 1-based line of a character of the source */
const lineAt = (source: string, index: number): number => source.slice(0, index).split("\n").length;

/** a CSS escape: up to six hex digits (and the one whitespace that ends them), or any other character */
const CSS_ESCAPE = String.raw`\\(?:[0-9A-Fa-f]{1,6}[ \t\n\r\f]?|[^\n\r\f0-9A-Fa-f])`;
/** a name as CSS reads it, escapes included: an at-rule's after "@", a function's before "(" */
const CSS_NAME = new RegExp(String.raw`(@?)((?:[\w\u0080-\uffff-]|${CSS_ESCAPE})+)(\(\s*["']?\s*#?)?`, "g");
/** the CSS functions that fetch what they name */
const CSS_FETCHES = /^(?:url|src|(?:-[a-z]+-)?image-set)$/;

const cssUnescape = (name: string): string =>
  name.replace(new RegExp(CSS_ESCAPE, "g"), (escape) => {
    const hex = /^\\([0-9A-Fa-f]+)/.exec(escape)?.[1];
    if (!hex) return escape.slice(1);
    const code = parseInt(hex, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
  });

/** where `text` names something CSS would fetch: a url() or src() not to the diagram itself, an image-set() or an @import */
function cssFetchAt(text: string): number | undefined {
  for (const m of text.matchAll(CSS_NAME)) {
    const name = cssUnescape(m[2]!).replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (m[1] ? name === "import" : m[3] !== undefined && CSS_FETCHES.test(name) && !m[3].endsWith("#")) {
      return m.index;
    }
  }
  return undefined;
}

/**
 * The entities that spell what CSS needs to fetch: a label's HTML passes
 * through DOMPurify while mermaid lays the diagram out (`&lpar;` is a "("
 * by then), and the drawn SVG turns numeric ones and mermaid's own `#…;`
 * into characters once it is parsed.
 */
const SPELLED = /&?#(\d+);|&#x([0-9a-f]+);|[&#](lpar|bsol|commat);/gi;
const NAMED: Record<string, string> = { lpar: "(", bsol: "\\", commat: "@" };
const unspell = (text: string): string =>
  text.replace(SPELLED, (entity, decimal?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name.toLowerCase()]!;
    const code = decimal ? Number(decimal) : parseInt(hex!, 16);
    return code > 0x10ffff ? entity : String.fromCodePoint(code);
  });

/**
 * The 1-based line where the source names something CSS would fetch,
 * escaped, spelled with entities or not. Statements of many diagram types
 * hand their text to the diagram's style sheet or to a style (a classDef of
 * a state or block diagram, a C4 relation's colour, an attribute in a
 * label's SVG), and mermaid applies it while it lays the diagram out in the
 * page, before any sanitizer sees the result. So the whole source is read
 * the way CSS reads it, whichever diagram type it is: a label that merely
 * mentions url( is refused too, which costs less than a type that slips
 * through.
 */
function cssResourceLine(source: string): number | undefined {
  const at = cssFetchAt(source);
  if (at !== undefined) return lineAt(source, at);
  const spelled = source.split("\n").findIndex((line) => cssFetchAt(unspell(line)) !== undefined);
  return spelled < 0 ? undefined : spelled + 1;
}

/** a shape's img that names inline data (quoted key or not) */
const INLINE_IMG = /^img["']?\s*:\s*["']?data:image\//i;
const INLINE_DATA = /^["']?data:image\//i;

/** every mention of `word` in `text` is one `inline` accepts, and no escape could hide another */
const onlyInline = (text: string, word: RegExp, inline: RegExp): boolean =>
  !text.includes("\\") && [...text.matchAll(word)].every((m) => inline.test(text.slice(m.index)));

/**
 * One `key: value` pair of a shape's data in its plain form, where mermaid's
 * lexer and YAML agree on every key: the key a word or quoted without an
 * escape; the value quoted without a line break or an escaped quote, or plain
 * without anything YAML could read as an anchor, alias, tag, comment,
 * collection or another key. An img in such a value, or an escape, can never
 * become a key, so a label may name one.
 */
const SHAPE_KEY = String.raw`([A-Za-z_][\w-]*)[ \t]*:[ \t]+|("[^"\\\n]*"|'[^'"\n]*')[ \t]*:[ \t]*`;
const SHAPE_VALUE = [
  String.raw`"(?:[^"\\\n]|\\[^"\n])*"`,
  String.raw`'(?:[^'"\n]|'')*'`,
  "(?![&*!|>%@`#,\\[\\]{}\"']|[-?:]\\s)(?:[^\"'\\n,{}\\[\\]#:]|:(?![\\s,{}\\[\\]]|$))*?",
].join("|");
const SHAPE_PAIR = new RegExp(`(?:${SHAPE_KEY})(${SHAPE_VALUE})[ \\t]*(?:,|(?=\\n)|$)`, "y");

/** the pairs of a shape's data, undefined unless all of it is in the plain form */
function plainShapePairs(data: string): [key: string, value: string][] | undefined {
  const pairs: [string, string][] = [];
  const blank = /\s*/y;
  for (let at = 0; ;) {
    blank.lastIndex = at;
    blank.exec(data);
    at = blank.lastIndex;
    if (at >= data.length) return pairs;
    SHAPE_PAIR.lastIndex = at;
    const pair = SHAPE_PAIR.exec(data);
    if (!pair || SHAPE_PAIR.lastIndex === at) return undefined;
    pairs.push([(pair[1] ?? pair[2]!.slice(1, -1)).toLowerCase(), pair[3]!]);
    at = SHAPE_PAIR.lastIndex;
  }
}

/**
 * A shape's data names an image that is not inline data. In the plain form
 * only an `img` key counts; in any other (anchors, nested collections,
 * escaped keys), every mention of img must be an inline-data key.
 */
function shapeImageFromAddress(data: string): boolean {
  const pairs = plainShapePairs(data);
  if (!pairs) return !onlyInline(data, /\bimg\b/gi, INLINE_IMG);
  return pairs.some(([key, value]) => key === "img" && !INLINE_DATA.test(value));
}

/** the sequence statements that set an actor's properties, its icon among them */
const ACTOR_METADATA = /\b(properties|details)(?=[ \t]+[^/\\+()<>:\n,;\s-])/gi;
/** statements whose rest of the line is a name or text, never another statement */
const TEXT_STATEMENT =
  /^(?:participant|actor|create|destroy|loop|alt|opt|par|par_over|and|else|critical|option|break|rect|box|title|note|links?|properties|details|activate|deactivate|autonumber)\b/i;

/**
 * A properties statement's JSON gives its actor an icon that is not a symbol
 * of the diagram (`@clock`) or inline data. mermaid runs the text through
 * DOMPurify before it parses it, so markup or an entity could still spell a
 * key, and a JSON escape could too: such a text is refused. `__proto__` would
 * hand the actor an icon through its prototype.
 */
function iconFromAddress(json: string): boolean {
  if (/[\\<&]/.test(json)) return true;
  for (const key of json.matchAll(/"([^"]*)"\s*:/g)) {
    const name = key[1]!.toLowerCase();
    if (name === "__proto__") return true;
    const value = json.slice(key.index + key[0].length);
    if (name === "icon" && !/^\s*"(?:@|data:image\/)/i.test(value)) return true;
  }
  return false;
}

/**
 * Where a sequence diagram gives an actor an icon from an address: a
 * `properties` statement, or any `details` statement, which reads the
 * properties as JSON from an element of the page (a heading of the
 * document, say) that the source cannot show. Read on the code mermaid
 * parses, statement by statement: a keyword after a message's colon or in a
 * text statement is text.
 */
function actorIconAt(source: string): { line: number; details: boolean } | undefined {
  if (!/^sequencediagram/i.test(mermaidHeader(source)?.text ?? "")) return undefined;
  const code = mermaidCode(source);
  for (const m of code.matchAll(ACTOR_METADATA)) {
    const start = Math.max(code.lastIndexOf("\n", m.index - 1), code.lastIndexOf(";", m.index - 1)) + 1;
    const prefix = code.slice(start, m.index);
    if (prefix.includes(":") || TEXT_STATEMENT.test(prefix.trim())) continue;
    const line = mermaidSourceLine(source, lineAt(code, m.index));
    if (m[1]!.toLowerCase() === "details") return { line, details: true };
    const text = /^[^:\n;]*:([^#\n;]*)/.exec(code.slice(m.index))?.[1];
    if (text !== undefined && iconFromAddress(text)) return { line, details: false };
  }
  return undefined;
}

/**
 * Where a diagram would load from an address it names: a shape's `img`
 * (`A@{ img: … }`), a sequence actor's `icon` (`properties A: {"icon": …}`
 * or `details A: <element id>`), or CSS that fetches (cssResourceLine).
 * mermaid loads all of them itself while it lays the diagram out, past every
 * sanitizer, so the source is checked before mermaid sees it. Inline
 * `data:image/` images and `@symbol` icons still draw (#290).
 */
export function diagramImageRefusal(source: string): MermaidRenderError | undefined {
  // a shape's data runs from `@{` to the first `}` outside double quotes, as
  // in mermaid's lexer
  for (let at = source.indexOf("@{"); at >= 0; at = source.indexOf("@{", at + 2)) {
    let end = at + 2;
    for (let quoted = false; end < source.length; end++) {
      if (source[end] === '"') quoted = !quoted;
      else if (source[end] === "}" && !quoted) break;
    }
    if (shapeImageFromAddress(source.slice(at + 2, end))) {
      return { line: lineAt(source, at), message: SHAPE_IMAGE_FROM_ADDRESS };
    }
  }
  const icon = actorIconAt(source);
  if (icon?.details) {
    return {
      line: icon.line,
      message:
        "An actor's details are not drawn: they read the actor's properties from the page, and an icon among them would load from its address for every reader. Set them with properties instead.",
    };
  }
  if (icon) {
    return {
      line: icon.line,
      message:
        "An actor's icon is not drawn: it would load from its address for every reader. Use a symbol (@name), a data:image/ URL, or remove it.",
    };
  }
  const css = cssResourceLine(source);
  if (css !== undefined) {
    return {
      line: css,
      message:
        "CSS that loads from an address (url(), image-set() or @import) is not drawn: it would load for every reader. Remove it.",
    };
  }
  return undefined;
}

const namesResource = (value: unknown): boolean =>
  typeof value === "string"
    ? CSS_RESOURCE.test(value)
    : typeof value === "object" && value !== null && Object.values(value).some(namesResource);

/**
 * Where a diagram's own configuration (its front matter's `config:` or a
 * %%{init}%% directive) names CSS that fetches. Some of it reaches a style
 * as it is (a sankey's linkColor, a C4 element's colours), and YAML and JSON
 * have escapes of their own that cssResourceLine does not read, so the
 * configuration is read as mermaid parsed it.
 */
export async function diagramConfigRefusal(mermaid: Mermaid, source: string): Promise<MermaidRenderError | undefined> {
  let config: unknown;
  try {
    const parsed = await mermaid.parse(source);
    config = parsed ? parsed.config : undefined;
  } catch {
    // the render reports what mermaid cannot read
    return undefined;
  }
  if (!namesResource(config)) return undefined;
  const at = source.search(/^[^\S\n\r]*---|%%\{/m);
  return {
    ...(at >= 0 ? { line: lineAt(source, at) } : {}),
    message:
      "The diagram's configuration loads from an address (url(), image-set(), @import or an escape): it would load for every reader. Remove it.",
  };
}

let engine: Promise<Mermaid> | undefined;

/**
 * The mermaid engine: its chunk loaded and initialised ONCE for the whole
 * app, after Geist is usable (mermaid measures every label as it lays the
 * diagram out; a fallback font measured then stays baked into the boxes).
 * A failed chunk load (offline, a stale deploy) rejects, and the next call
 * tries again.
 */
export function loadMermaid(): Promise<Mermaid> {
  if (!engine) {
    engine = Promise.all([import("mermaid"), canvasFontReady()]).then(([{ default: mermaid }]) => {
      mermaid.initialize(MERMAID_CONFIG);
      return mermaid;
    });
    engine.catch(() => {
      engine = undefined;
    });
  }
  return engine;
}

/**
 * Render Mermaid source to SVG. A source mermaid cannot read resolves to
 * `{ error }`, never a rejection; only a failed engine load rejects. mermaid
 * queues its renders, and each one gets its own id (mermaidRenderId), so
 * concurrent calls neither interleave nor collide.
 */
export async function renderMermaid(source: string, idPrefix: string): Promise<MermaidRenderResult> {
  const refused = diagramImageRefusal(source);
  if (refused) return { error: refused };
  const mermaid = await loadMermaid();
  const configured = await diagramConfigRefusal(mermaid, source);
  if (configured) return { error: configured };
  try {
    const { svg } = await mermaid.render(mermaidRenderId(idPrefix), source);
    return { svg };
  } catch (error) {
    return { error: describeMermaidError(error, source) };
  }
}
