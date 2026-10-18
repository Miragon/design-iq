/**
 * How Mermaid reads a diagram's text: the conventions of the pinned renderer
 * (MERMAID_VERSION, apps/web's exact version), so the validator and the web
 * app agree on ONE reading without either loading mermaid:
 *
 *   - mermaidCode        the text mermaid's diagram parsers see: its
 *                        preprocess drops the front matter, the %%{…}%%
 *                        directives and the %% comment lines first
 *   - mermaidSourceLine  a line of that text back in the source: mermaid's
 *                        parse errors count lines of mermaidCode, so a title
 *                        in the front matter would shift every error line
 *   - mermaidHeader      the first line, the one that names the diagram type
 *
 * Syntax knowledge, not a checker: the validator turns an unknown header
 * into a finding, the web renderer (apps/web/src/lib/mermaid-render.ts) words
 * its errors with it. Pure string logic, zero-dep and browser-safe like the
 * package index (the SPA imports it). A mermaid bump fails apps/web's
 * test/mermaid-engine.test.ts until MERMAID_VERSION follows it: re-read
 * mermaid's src/preprocess.ts and its detectors against this file first.
 */

/** the mermaid release this file mirrors: apps/web's exact pin */
export const MERMAID_VERSION = "11.17.2";

/**
 * Every diagram type MERMAID_VERSION renders, spelled as its header keyword
 * (its diagram detectors, minus the spellings the detector matches but the
 * grammar then refuses: a bare `architecture` or `requirement`). zenuml is
 * an external plugin mermaid does not bundle, so it is not here.
 */
export const MERMAID_DIAGRAM_TYPES: readonly string[] = [
  "flowchart",
  "flowchart-elk",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "classDiagram-v2",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "quadrantChart",
  "requirementDiagram",
  "gitGraph",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
  "mindmap",
  "timeline",
  "sankey",
  "sankey-beta",
  "xychart",
  "xychart-beta",
  "block",
  "block-beta",
  "packet",
  "packet-beta",
  "kanban",
  "architecture-beta",
  "radar-beta",
  "treemap",
  "treemap-beta",
  "info",
  "swimlane-beta",
  "treeView-beta",
  "eventmodeling",
  "ishikawa",
  "ishikawa-beta",
  "venn-beta",
  "wardley-beta",
  "cynefin-beta",
  "railroad-beta",
  "railroad-ebnf-beta",
  "railroad-abnf-beta",
  "railroad-peg-beta",
];

// mermaid's own patterns (src/diagram-api/regexes.ts, src/diagram-api/comments.ts)
const FRONT_MATTER = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s;
const DIRECTIVE = /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi;
const COMMENT_LINE = /^\s*%%(?!{)[^\n]+\n?/gm;

/** a header keyword, followed by the end of the line, a space, ":" or ";" */
const HEADER = new RegExp(
  `^(?:${MERMAID_DIAGRAM_TYPES.map((t) => t.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|")})(?=$|[\\s:;])`,
);

/** mermaid's cleanupText: line breaks to \n, tag attributes single-quoted;
 *  the line structure stays, so the source lines can be matched against it */
function cleanup(source: string): string {
  return source
    .replace(/\r\n?/g, "\n")
    .replace(
      /<(\w+)([^>]*)>/g,
      (_tag, name: string, attrs: string) => `<${name}${attrs.replace(/="([^"]*)"/g, "='$1'")}>`,
    );
}

/** The text mermaid's diagram parser reads: the source after mermaid's
 *  preprocess (front matter, directives and comment lines removed, leading
 *  whitespace trimmed). */
export function mermaidCode(source: string): string {
  return cleanup(source).replace(FRONT_MATTER, "").replace(DIRECTIVE, "").replace(COMMENT_LINE, "").trimStart();
}

/**
 * The 1-based source line of the 1-based line `codeLine` of mermaidCode(source).
 * The preprocess only removes lines (and joins the two ends of a directive
 * that spans lines), so the code is the source's lines in order: each code
 * line is matched to the next source line with the same text. A line the
 * preprocess rewrote matches nothing and takes the next line; a line past the
 * end clamps to the last one.
 */
export function mermaidSourceLine(source: string, codeLine: number): number {
  const cleaned = cleanup(source);
  const sourceLines = cleaned.split("\n").map((l) => l.trim());
  const codeLines = mermaidCode(source).split("\n");
  // the code starts after the front matter (the match ends on its last line
  // break): a YAML line must never be taken for a line of the diagram
  let next = (cleaned.match(FRONT_MATTER)?.[0] ?? "").split("\n").length - 1;
  let at = next;
  for (let i = 0; i < Math.min(codeLine, codeLines.length); i++) {
    const text = codeLines[i]!.trim();
    let k = next;
    while (k < sourceLines.length && sourceLines[k] !== text) k++;
    at = k < sourceLines.length ? k : next;
    next = at + 1;
  }
  return Math.min(at, sourceLines.length - 1) + 1;
}

export interface MermaidHeader {
  /** 1-based source line */
  line: number;
  /** the header line's text, trimmed */
  text: string;
  /** the MERMAID_DIAGRAM_TYPES keyword it starts with, undefined when none */
  diagramType: string | undefined;
}

/**
 * The line that names the diagram type: the first line of mermaidCode that
 * is neither blank nor a bare `%%` comment (mermaid's type detection skips
 * those too). undefined when there is none: the source is empty, or nothing
 * but front matter, directives and comments.
 */
export function mermaidHeader(source: string): MermaidHeader | undefined {
  const lines = mermaidCode(source).split("\n");
  const index = lines.findIndex((l) => l.trim() !== "" && !l.trim().startsWith("%%"));
  if (index < 0) return undefined;
  const text = lines[index]!.trim();
  return { line: mermaidSourceLine(source, index + 1), text, diagramType: HEADER.exec(text)?.[0] };
}
