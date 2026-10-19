/**
 * Where "Insert diagram" puts a ```mermaid fence in a Markdown document, and
 * the exact text it writes: given the document and the cursor, pure, so the
 * rules are tested without Monaco (test/insert-diagram.test.ts).
 *
 * The diagram is a block of its own, at the document's left margin, so it
 * goes between the document's blocks, never into one:
 *
 *   - after the block the cursor's line is in; before it when the cursor is
 *     at the block's start (nothing but blanks before it on its first line).
 *     On a blank line between blocks it goes at that line;
 *   - a block is one as the view reads it: a paragraph over several lines, a
 *     fence (the cursor in it puts the diagram after it), a table, a setext
 *     heading, raw HTML, indented code, a quote. In a list, the cursor's item
 *     with everything nested in it (its further paragraphs, child lists and
 *     fences): the diagram ends the list after that item, and a numbered list
 *     goes on after it at the number of its next item;
 *   - a blank line parts it from the text before and after it, unless one is
 *     there already, and a document that ends with it ends with a line break.
 *
 * The blocks are the view's own reading (render.ts' markdown-it). The result
 * is read back twice: with the validator's fence scanner
 * (@designiq/notations/markdown), and with the view's reading of every other
 * block, which must not change. Where either fails (after an unclosed fence
 * or HTML comment, which run to the end of the document, nothing is outside
 * them), the diagram goes before that block instead, or else to the start of
 * the document, which no block can hold.
 *
 * Line breaks are "\n" (the caller reads Monaco's model with
 * EndOfLinePreference.LF), positions 1-based lines and columns as Monaco
 * counts them; a "\r" is read as a line break too.
 */
import { markdownFences } from "@designiq/notations/markdown";
import type { Token } from "markdown-it";

import { parseMarkdown } from "./render.ts";

/** a position in the document: 1-based, as Monaco counts lines and columns */
export interface DocPosition {
  line: number;
  column: number;
}

/** a range of the document: 1-based lines and columns, the end column exclusive */
export interface DocRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** what to insert: the fence's content, and what of it the cursor selects */
export interface InsertedDiagram {
  /** the Mermaid text, every line ending with a line break */
  body: string;
  /** a text on one line of the body: the cursor selects its first occurrence.
   *  Absent or not in the body: the cursor goes to the end of its first line */
  select?: string;
}

export interface DiagramInsertion {
  /** where the text goes; it replaces nothing */
  at: DocPosition;
  /** exactly the text inserted */
  text: string;
  /** the line the new fence opens on, once inserted */
  fenceLine: number;
  /** what the cursor selects once inserted, in the document as it is then */
  selection: DocRange;
}

const BLANK = /^[ \t]*$/;

/** a list's own tokens: the diagram may end a list, so they are no block of their own */
const LIST_EDGES = new Set(["bullet_list_open", "bullet_list_close", "ordered_list_open", "ordered_list_close"]);

/**
 * The 0-based line ranges [start, end) of the blocks a diagram goes between:
 * the document's top-level blocks, and a top-level list item by item, each
 * with everything nested in it.
 */
function blocksOf(tokens: readonly Token[]): Array<readonly [start: number, end: number]> {
  const blocks: Array<readonly [number, number]> = [];
  for (const token of tokens) {
    if (!token.map || token.nesting === -1) continue;
    const topLevel = token.level === 0 && !LIST_EDGES.has(token.type);
    if (topLevel || (token.level === 1 && token.type === "list_item_open")) blocks.push([token.map[0], token.map[1]]);
  }
  return blocks;
}

/**
 * The gaps to try for the cursor, best first: a gap is the number of the
 * document's lines before the diagram. After the cursor's block, or before
 * it when the cursor is at its start, and the other one second. A line no
 * block holds (a blank line, a link reference definition) is one of its own.
 */
function gapsFor(tokens: readonly Token[], lines: readonly string[], cursor: DocPosition): number[] {
  const at = Math.min(Math.max(cursor.line, 1), lines.length) - 1;
  const leading = BLANK.test(lines[at]!.slice(0, Math.max(cursor.column - 1, 0)));
  const [start, end] = blocksOf(tokens).find(([start, end]) => at >= start && at < end) ?? [at, at + 1];
  return at === start && leading ? [start, end] : [end, start];
}

/**
 * The view's reading of a document's blocks, what the diagram must leave as
 * it was: every token but a list's edges (a list the diagram ends reads as
 * two) and the new fence opening on `fenceLine`, if one is given. A block's
 * last line break is no part of it: a document that ended without one gets
 * one before the diagram.
 */
function readingOf(tokens: readonly Token[], fenceLine?: number): string[] {
  const isNew = (t: Token) => t.type === "fence" && fenceLine !== undefined && t.map?.[0] === fenceLine - 1;
  return tokens
    .filter((t) => !LIST_EDGES.has(t.type) && !isNew(t))
    .map((t) => [t.type, t.tag, t.level, t.markup, t.info, t.content.replace(/\n$/, "")].join("\u0000"));
}

/** the selection the diagram's `select` makes once its fence opens on `fenceLine` */
function selectionIn(diagram: InsertedDiagram, fenceLine: number): DocRange {
  const { body, select = "" } = diagram;
  const found = select === "" || select.includes("\n") ? -1 : body.indexOf(select);
  if (found < 0) {
    // an empty selection at the end of the diagram's first line
    const column = body.split("\n", 1)[0]!.length + 1;
    return { startLine: fenceLine + 1, startColumn: column, endLine: fenceLine + 1, endColumn: column };
  }
  const lineStart = body.lastIndexOf("\n", found - 1) + 1;
  // the fence's line, then the body's lines up to the one `select` is on
  const line = fenceLine + 1 + (body.slice(0, lineStart).match(/\n/g)?.length ?? 0);
  const column = found - lineStart + 1;
  return { startLine: line, startColumn: column, endLine: line, endColumn: column + select.length };
}

/** the insertion that puts the diagram at `gap` */
function insertionAt(lines: readonly string[], gap: number, diagram: InsertedDiagram): DiagramInsertion {
  const fence = "```mermaid\n" + diagram.body + "```\n";
  // a blank line parts the diagram from the text right before it
  const before = gap > 0 && !BLANK.test(lines[gap - 1]!);
  const fenceLine = gap + 1 + (before ? 1 : 0);
  if (gap < lines.length) {
    // ... and from the text right after it
    const after = !BLANK.test(lines[gap]!);
    const text = (before ? "\n" : "") + fence + (after ? "\n" : "");
    return { at: { line: gap + 1, column: 1 }, text, fenceLine, selection: selectionIn(diagram, fenceLine) };
  }
  // after the last line, which has no line break of its own to end it yet
  const last = lines[gap - 1]!;
  const text = "\n" + (before ? "\n" : "") + fence;
  return { at: { line: gap, column: last.length + 1 }, text, fenceLine, selection: selectionIn(diagram, fenceLine) };
}

/** the document with `insertion` made */
function applied(lines: readonly string[], insertion: DiagramInsertion): string {
  const { line, column } = insertion.at;
  const head = lines.slice(0, line - 1).join("\n") + (line > 1 ? "\n" : "");
  const rest = lines.slice(line - 1).join("\n");
  return head + rest.slice(0, column - 1) + insertion.text + rest.slice(column - 1);
}

/** whether `result` reads the new fence as the diagram and every other block as before */
function readsAsDiagram(
  result: string,
  insertion: DiagramInsertion,
  diagram: InsertedDiagram,
  before: readonly string[],
): boolean {
  const diagramRead = markdownFences(result).some(
    (f) => f.line === insertion.fenceLine && f.closed && f.lang === "mermaid" && f.content === diagram.body,
  );
  if (!diagramRead) return false;
  const after = readingOf(parseMarkdown(result), insertion.fenceLine);
  return after.length === before.length && after.every((block, i) => block === before[i]);
}

/** where the diagram goes for the cursor at `cursor`, and the text that puts it there */
export function planDiagramInsertion(text: string, cursor: DocPosition, diagram: InsertedDiagram): DiagramInsertion {
  const source = text.replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const tokens = parseMarkdown(source);
  const before = readingOf(tokens);
  for (const gap of gapsFor(tokens, lines, cursor)) {
    const insertion = insertionAt(lines, gap, diagram);
    if (readsAsDiagram(applied(lines, insertion), insertion, diagram, before)) return insertion;
  }
  // the start of the document: nothing comes before the fence there to hold it
  return insertionAt(lines, 0, diagram);
}

/** the end of the document, where the diagram goes while the source has shown no cursor yet */
export function documentEnd(text: string): DocPosition {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
}
