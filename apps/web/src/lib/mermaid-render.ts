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
 * The keys a diagram's own front matter (`config:`) or %%{init}%% directive
 * may NOT set: mermaid's own secure list, plus everything that makes up the
 * look. A diagram copied from a repo that draws it dark would otherwise get
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
  fontFamily: FONT_SANS,
  htmlLabels: true,
  look: "classic",
  flowchart: { layout: "dagre" },
  class: { layout: "dagre" },
  state: { layout: "dagre" },
  er: { layout: "dagre" },
  requirement: { layout: "dagre" },
  suppressErrorRendering: true,
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
  const mermaid = await loadMermaid();
  try {
    const { svg } = await mermaid.render(mermaidRenderId(idPrefix), source);
    return { svg };
  } catch (error) {
    return { error: describeMermaidError(error, source) };
  }
}
