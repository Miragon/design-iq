/**
 * The ONE Mermaid renderer of the web app: Mermaid source in, an SVG string
 * or a readable error out. A mermaid fence in the Markdown view draws through
 * it (notations/markdown/mermaid-fence.ts), and so can any other surface that
 * shows a diagram.
 *
 * ADR 0006: mermaid is large, so it loads behind the dynamic import in
 * loadMermaid() and nowhere else (`pnpm arch`, rule mermaid-loads-lazily).
 * Importing this file costs a few kB, not the engine; even so the fence
 * reaches it through import() too, so the eager bundle, the repo overview
 * and every document without a diagram never carry it.
 *
 * The rest is pure (config, ids, error wording) and runs under node --test:
 * mermaid itself needs a DOM to measure text.
 */
import { mermaidFrontMatterLines, mermaidHeader, mermaidSourceLine } from "@designiq/notations/mermaid";
import { ALIASES, FONT_SANS } from "@designiq/ui-kit/lib/tokens";
import type { Mermaid, MermaidConfig } from "mermaid";

import { canvasFontReady } from "./canvas-theme.ts";

/**
 * The Miragon CI as Mermaid's "base" theme. Literal colours from the tokens
 * mirror, never var(--…): mermaid derives shades from them (it parses the
 * values) and writes them into the SVG's own style block. The nodes take the
 * canvas set every diagram engine of the app draws with (white shapes, dark
 * strokes and labels, as in bpmn-js); groups, notes and activations sit on
 * the calm grey with a border that holds 3:1. Diagram types with a palette of
 * their own (pie, mindmap, git graph) derive it from these, in greys, as in
 * the docs site's Mermaid.
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
} as const;

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
 * the author's.
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

/**
 * What a failed mermaid parse or render means for the person typing: the
 * source line (mermaid counts lines AFTER dropping the front matter and, for
 * most diagram types, the comments; @designiq/notations/mermaid maps them
 * back) and the message. A missing or unknown diagram type reads like the
 * validator's header check.
 */
export function describeMermaidError(error: unknown, source: string): MermaidRenderError {
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

/** a shape's img that names inline data (quoted key or not) */
const INLINE_IMG = /^img["']?\s*:\s*["']?data:image\//i;
/** an actor's icon that names inline data or a symbol of the diagram (`@clock`) */
const INLINE_ICON = /^icon"\s*:\s*"(?:@|data:image\/)/;

/** every mention of `word` in `text` is one `inline` accepts, and no escape could hide another */
const onlyInline = (text: string, word: RegExp, inline: RegExp, opening = ""): boolean =>
  !text.includes("\\") &&
  [...text.matchAll(word)].every(
    (m) => text.slice(m.index - opening.length, m.index) === opening && inline.test(text.slice(m.index)),
  );

/**
 * Where a diagram would draw an image from an address it names: a shape's
 * `img` (`A@{ img: … }`) or a sequence actor's `icon` (`properties A:
 * {"icon": …}`). mermaid loads both itself while it lays the diagram out,
 * past every sanitizer, so the source is checked before mermaid sees it, and
 * strictly: within a shape's data or a properties line, every `img` or
 * `icon` must name inline data (an icon may also name a symbol); any other
 * mention of one, and any escape, refuses the diagram (#290).
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
    if (!onlyInline(source.slice(at, end), /\bimg\b/gi, INLINE_IMG)) {
      return {
        line: lineAt(source, at),
        message:
          "A shape's image (img) is not drawn: it would load from its address for every reader. Use a data:image/ URL or remove it.",
      };
    }
  }
  for (const m of source.matchAll(/\bproperties\b[^\n]*/gi)) {
    if (!onlyInline(m[0], /icon/gi, INLINE_ICON, '"')) {
      return {
        line: lineAt(source, m.index),
        message:
          "An actor's icon is not drawn: it would load from its address for every reader. Use a symbol (@name), a data:image/ URL, or remove it.",
      };
    }
  }
  return undefined;
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
  try {
    const { svg } = await mermaid.render(mermaidRenderId(idPrefix), source);
    return { svg };
  } catch (error) {
    return { error: describeMermaidError(error, source) };
  }
}
