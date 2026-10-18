/**
 * The fenced code blocks of a Markdown document, read the way CommonMark
 * reads them (and so markdown-it, apps/web's renderer): the validator checks
 * every ```mermaid fence on this reading and reports the document's lines.
 *
 *   - a fence opens with three or more backticks or tildes, indented by at
 *     most three spaces (a backtick fence's info string holds no backtick),
 *     and closes with a run of the same character, at least as long, with
 *     nothing but blanks after it. Its content loses as much indentation as
 *     the opening run had. An unclosed fence runs to the end of its
 *     container, or of the document.
 *   - fences inside block quotes and list items count. Their content comes
 *     without the container's markers (a quote's ">", a list item's content
 *     indent), and a line that does not continue the container (no ">", or
 *     indented less than the item's content) ends the fence there, closed
 *     or not.
 *   - to place a fence the scanner follows just enough block structure: the
 *     open quotes and list items, paragraphs (their lazy continuation lines,
 *     what may interrupt one), indented code (four spaces of indent are
 *     never a fence), raw HTML blocks (a fence inside an HTML comment is
 *     no fence: markdown-it recognises raw HTML, render.ts' `html: true`)
 *     and link reference definitions that fit on one line (no paragraph, so
 *     the next line may start an HTML block or a list). A definition that
 *     spans lines (its label, destination or title going on to the next)
 *     reads as paragraph text: raw HTML or a list item right after it can
 *     move a fence. Tables read as paragraph text too, and the info string
 *     is taken as written (no backslash escapes or entities). Two
 *     markdown-it quirks are not followed: inside nested quotes it ends both
 *     quotes at a lazy line of four spaces of indent before a run, and in a
 *     list item it lets a lazy line indented four columns or more, but less
 *     than the item's content, start a block (a quote, a fence, raw HTML).
 *   - content nested deeper than markdown-it parses (maxNesting: 50 list
 *     items or 100 quotes) holds no fence: the view drops the rest of the
 *     innermost quote around it, or of the document, and so does the scan.
 *     With that limit a line costs its length plus the containers it
 *     continues: the scan stays linear on any document the save gate gets.
 *
 * Pure string logic, zero-dep and browser-safe like the package index.
 * apps/web's test/markdown-fences.test.ts holds it against markdown-it on a
 * corpus, the cases above included: a markdown-it bump that reads fences
 * differently fails there first.
 */

/** one fenced code block of a Markdown document */
export interface MarkdownFence {
  /** 1-based line of the opening run */
  line: number;
  /** 1-based last line: the closing run, or the last content line of an unclosed fence */
  endLine: number;
  /** the info string after the opening run, trimmed ("" for a bare fence) */
  info: string;
  /** its first word, lower-case: the fence's language ("" for a bare fence) */
  lang: string;
  /** the lines between the runs, each with its line break (markdown-it's token content) */
  content: string;
  /** whether a closing run ends it */
  closed: boolean;
}

/** the rest of a line once the containers it continues are consumed, and
 *  the column it starts at (a tab stops at the next multiple of four) */
interface Rest {
  text: string;
  col: number;
}

/** the leading blanks of a rest: their columns, and whether nothing follows them */
interface Lead {
  indent: number;
  blank: boolean;
}

/** an open block quote or list item; `level` is the nesting inside it as
 *  markdown-it counts it (a quote one level, a list item two: its list and itself) */
type Container = { kind: "quote"; level: number } | { kind: "item"; level: number; indent: number; fresh: boolean };

type Leaf =
  | { kind: "none" | "paragraph" | "code" }
  | { kind: "fence"; char: string; size: number; indent: number; info: string; line: number; content: string[] }
  | { kind: "html"; end: RegExp };

const NONE: Leaf = { kind: "none" };
const PARAGRAPH: Leaf = { kind: "paragraph" };
const CODE: Leaf = { kind: "code" };

const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;
const BULLET = /^[-+*](?=[ \t]|$)/;
const ORDERED = /^(\d{1,9})[.)](?=[ \t]|$)/;
const BLANK = /^[ \t]*$/;
/** a link reference definition on one line: [label]: destination "title" (a
 *  "[^" label is a footnote, which render.ts keeps as paragraph text; a bare
 *  destination ends at a space or a control character, as in markdown-it) */
const LINK_DEFINITION =
  // eslint-disable-next-line no-control-regex
  /^\[(?!\^)((?:[^[\]\\]|\\.)*)\]:[ \t]*(<(?:[^<>\\]|\\.)*>|[^ <\x00-\x1f\x7f][^ \x00-\x1f\x7f]*)(?:[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*$/;
/** the destinations markdown-it's validateLink refuses: no definition then */
const BAD_LINK = /^(?:vbscript|javascript|file|data):/i;
const GOOD_DATA_LINK = /^data:image\/(?:gif|png|jpeg|webp);/i;
/** markdown-it's maxNesting: content nested this deep (a Container's `level`)
 *  it does not parse, and drops the rest of the innermost quote around it,
 *  or of the document */
const MAX_NESTING = 100;

// the HTML block starts and ends of CommonMark §4.6, as markdown-it spells them
const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|" +
  "fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|" +
  "link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|" +
  "thead|title|tr|track|ul";
const OPEN_TAG =
  "<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^\"'=<>`\\x00-\\x20]+|'[^']*'|\"[^\"]*\"))?)*\\s*\\/?>";
const CLOSE_TAG = "<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>";
/** start, end and whether it may interrupt a paragraph; an end of /^$/ is the next blank line */
const HTML_BLOCKS: ReadonlyArray<readonly [start: RegExp, end: RegExp, interrupts: boolean]> = [
  [/^<(?:script|pre|style|textarea)(?=\s|>|$)/i, /<\/(?:script|pre|style|textarea)>/i, true],
  [/^<!--/, /-->/, true],
  [/^<\?/, /\?>/, true],
  [/^<![A-Za-z]/, />/, true],
  [/^<!\[CDATA\[/, /\]\]>/, true],
  [new RegExp(`^</?(?:${BLOCK_TAGS})(?=\\s|/?>|$)`, "i"), /^$/, true],
  [new RegExp(`^(?:${OPEN_TAG}|${CLOSE_TAG})\\s*$`), /^$/, false],
];

/** the leading blanks of a rest */
function leading(rest: Rest): Lead {
  let col = rest.col;
  let i = 0;
  for (; i < rest.text.length; i++) {
    const ch = rest.text[i];
    if (ch === " ") col++;
    else if (ch === "\t") col += 4 - (col % 4);
    else break;
  }
  return { indent: col - rest.col, blank: i === rest.text.length };
}

/** the columns of leading blanks */
const indentOf = (rest: Rest): number => leading(rest).indent;

/** drop up to `n` columns of leading blanks; a tab cut in two leaves its other columns as spaces */
function dropIndent(rest: Rest, n: number): Rest {
  const target = rest.col + n;
  let col = rest.col;
  let i = 0;
  while (i < rest.text.length && col < target) {
    const ch = rest.text[i];
    if (ch === " ") col++;
    else if (ch === "\t") {
      const next = col + 4 - (col % 4);
      if (next > target) return { text: " ".repeat(next - target) + rest.text.slice(i + 1), col: target };
      col = next;
    } else break;
    i++;
  }
  return { text: rest.text.slice(i), col };
}

/** the line after its indent, when that is at most three columns (more is indented code) */
function blockStart(rest: Rest): Rest | undefined {
  const indent = indentOf(rest);
  return indent < 4 ? dropIndent(rest, indent) : undefined;
}

/** a quote's ">" and the one column of blank after it: a space, or the first
 *  column of a tab (which stays, a column narrower, as in markdown-it) */
function afterQuoteMarker(at: Rest): Rest {
  const rest = { text: at.text.slice(1), col: at.col + 1 };
  if (rest.text.startsWith(" ") || (rest.text.startsWith("\t") && rest.col % 4 === 3)) {
    return { text: rest.text.slice(1), col: rest.col + 1 };
  }
  return rest.text.startsWith("\t") ? { text: rest.text, col: rest.col + 1 } : rest;
}

/** the rest of the line when it continues the container, undefined when the
 *  container ends. `lead` is the rest's leading blanks, kept up to date across
 *  the columns a list item drops, so a line is not measured once per container */
function continues(container: Container, rest: Rest, lead: Lead): Rest | undefined {
  if (container.kind === "quote") {
    // markdown-it continues a quote on a ">" behind any indent (CommonMark
    // allows three spaces): the scanner reads what the view renders
    const at = dropIndent(rest, lead.indent);
    return at.text.startsWith(">") ? afterQuoteMarker(at) : undefined;
  }
  // a list item that opened empty holds at most one blank line: the next
  // blank line ends it
  const fresh = container.fresh;
  container.fresh = false;
  if (lead.blank ? fresh : lead.indent < container.indent) return undefined;
  lead.indent = Math.max(0, lead.indent - container.indent);
  return dropIndent(rest, container.indent);
}

/** a list item opening at `at` (the line after its indent of `indent` columns),
 *  inside containers nested `level` deep */
function listItem(
  at: Rest,
  indent: number,
  level: number,
  interruptsParagraph: boolean,
): { item: Container; rest: Rest } | undefined {
  const ordered = ORDERED.exec(at.text);
  const marker = ordered ?? BULLET.exec(at.text);
  if (!marker) return undefined;
  const after: Rest = { text: at.text.slice(marker[0].length), col: at.col + marker[0].length };
  const empty = BLANK.test(after.text);
  // a list interrupts a paragraph only with an item that has content, and
  // an ordered one only when it starts at 1
  if (interruptsParagraph && (empty || (ordered && Number(ordered[1]) !== 1))) return undefined;
  // the content starts after one to four columns of blank; with more, or
  // none at all, it is one column past the marker (and indented code)
  const blanks = indentOf(after);
  const gap = empty || blanks > 4 ? 1 : blanks;
  return {
    item: { kind: "item", level: level + 2, indent: indent + marker[0].length + gap, fresh: empty },
    rest: dropIndent(after, gap),
  };
}

/** the HTML block starting at `text` (a line after its indent), if any */
function htmlBlock(text: string): readonly [start: RegExp, end: RegExp, interrupts: boolean] | undefined {
  return text.startsWith("<") ? HTML_BLOCKS.find(([start]) => start.test(text)) : undefined;
}

/** whether a line that does not continue a paragraph's containers starts a
 *  block of its own (else it is a lazy continuation line of the paragraph) */
function startsBlock(rest: Rest): boolean {
  const at = blockStart(rest);
  if (!at) return false;
  const text = at.text;
  return (
    text.startsWith(">") ||
    fenceOpen(text) !== undefined ||
    THEMATIC_BREAK.test(text) ||
    BULLET.test(text) ||
    ORDERED.test(text) ||
    ATX_HEADING.test(text) ||
    htmlBlock(text)?.[2] === true
  );
}

/** whether `text` (a line after its indent) is a link reference definition that
 *  fits on it and that markdown-it takes: a label with more than blanks, a
 *  destination with balanced parentheses and a scheme its validateLink allows */
function linkDefinition(text: string): boolean {
  const definition = LINK_DEFINITION.exec(text);
  if (!definition || definition[1]!.trim() === "") return false;
  let destination = definition[2]!;
  if (destination.startsWith("<")) destination = destination.slice(1, -1);
  else {
    let depth = 0;
    for (let i = 0; i < destination.length && depth >= 0; i++) {
      const ch = destination[i];
      if (ch === "\\") i++;
      else if (ch === "(") depth = depth < 32 ? depth + 1 : -1;
      else if (ch === ")") depth--;
    }
    if (depth !== 0) return false;
  }
  destination = destination.trim();
  return !BAD_LINK.test(destination) || GOOD_DATA_LINK.test(destination);
}

/** the opening run of a fence at `text` (a line after its indent), if any */
function fenceOpen(text: string): { char: string; size: number; info: string } | undefined {
  const open = FENCE_OPEN.exec(text);
  if (!open) return undefined;
  const run = open[1]!;
  const info = open[2]!;
  if (run.startsWith("`") && info.includes("`")) return undefined;
  return { char: run[0]!, size: run.length, info: info.trim() };
}

/** whether the line is the closing run of `fence` */
function closes(rest: Rest, fence: { char: string; size: number }): boolean {
  const at = blockStart(rest);
  if (!at) return false;
  let n = 0;
  while (at.text[n] === fence.char) n++;
  return n >= fence.size && BLANK.test(at.text.slice(n));
}

/** every fenced code block of a Markdown document, in document order */
export function markdownFences(source: string): MarkdownFence[] {
  const lines = source.split(/\r\n|\r|\n/);
  // a line break after the last line opens no new one, and to markdown-it a
  // last line of nothing but blanks is no line at all
  const brokenLast = BLANK.test(lines[lines.length - 1]!);
  if (brokenLast) lines.pop();
  const fences: MarkdownFence[] = [];
  const stack: Container[] = [];
  const level = (): number => (stack.length > 0 ? stack[stack.length - 1]!.level : 0);
  let leaf: Leaf = NONE;
  // set while the view drops the rest of the innermost quote (content nested
  // too deep, MAX_NESTING): the scan follows the quote's lines to its end
  let dropping: { lastBlank: boolean } | undefined;

  const finish = (fence: Extract<Leaf, { kind: "fence" }>, closed: boolean): void => {
    fences.push({
      line: fence.line,
      endLine: fence.line + fence.content.length + (closed ? 1 : 0),
      info: fence.info,
      lang: (fence.info.split(/\s+/)[0] ?? "").toLowerCase(),
      content: fence.content.join(""),
      closed,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    let rest: Rest = { text: lines[i]!, col: 0 };
    const lineBreak = i < lines.length - 1 || brokenLast ? "\n" : "";

    // 1. the open containers the line continues (its blanks measured once,
    //    and once more past each quote's ">")
    let matched = 0;
    let lead: Lead | undefined;
    for (const container of stack) {
      const next = continues(container, rest, (lead ??= leading(rest)));
      if (!next) break;
      rest = next;
      if (container.kind === "quote") lead = undefined;
      matched++;
    }
    const all = matched === stack.length;

    // 2. a dropped quote goes on with every line that has its ">", and with
    //    a lazy one (text that starts no block, after a line with more than
    //    the ">"); the line that ends it is read as usual
    if (dropping) {
      if (all) {
        dropping.lastBlank = BLANK.test(rest.text);
        continue;
      }
      if (!dropping.lastBlank && !BLANK.test(rest.text) && !startsBlock(rest)) continue;
      dropping = undefined;
    }

    // 3. inside an open fence or HTML block, the line is theirs
    if (leaf.kind === "fence" && all) {
      if (closes(rest, leaf)) {
        finish(leaf, true);
        leaf = NONE;
      } else leaf.content.push(dropIndent(rest, leaf.indent).text + lineBreak);
      continue;
    }
    if (leaf.kind === "html" && all) {
      if (leaf.end.test(dropIndent(rest, indentOf(rest)).text)) leaf = NONE;
      continue;
    }

    // 4. a lazy continuation line keeps a paragraph and its containers open;
    //    any other line closes the containers it does not continue
    if (!all) {
      if (leaf.kind === "paragraph" && !BLANK.test(rest.text) && !startsBlock(rest)) continue;
      if (leaf.kind === "fence") finish(leaf, false);
      stack.length = matched;
      leaf = NONE;
    }

    // 5. the containers the line opens (a paragraph still open here is the
    //    one a list item would interrupt), as deep as the view parses
    while (level() < MAX_NESTING && !BLANK.test(rest.text)) {
      const at = blockStart(rest);
      if (!at) break;
      if (at.text.startsWith(">")) {
        stack.push({ kind: "quote", level: level() + 1 });
        rest = afterQuoteMarker(at);
      } else {
        if (THEMATIC_BREAK.test(at.text)) break;
        const opening = listItem(at, indentOf(rest), level(), leaf.kind === "paragraph");
        if (!opening) break;
        stack.push(opening.item);
        rest = opening.rest;
      }
      leaf = NONE;
    }

    // 6. the leaf block the line starts or continues
    if (BLANK.test(rest.text)) {
      if (leaf.kind === "paragraph") leaf = NONE;
      continue;
    }
    if (level() >= MAX_NESTING) {
      // content nested too deep: the view drops the rest of the innermost
      // quote, or of the document when no quote holds it
      const quote = stack.findLastIndex((container) => container.kind === "quote");
      if (quote < 0) break;
      stack.length = quote + 1;
      leaf = NONE;
      dropping = { lastBlank: false };
      continue;
    }
    const at = blockStart(rest);
    if (!at) {
      // four columns of indent: indented code, or a paragraph's next line
      if (leaf.kind !== "paragraph") leaf = CODE;
      continue;
    }
    const open = fenceOpen(at.text);
    if (open) {
      leaf = { kind: "fence", ...open, indent: indentOf(rest), line: i + 1, content: [] };
      continue;
    }
    const html = htmlBlock(at.text);
    if (html && (html[2] || leaf.kind !== "paragraph")) {
      leaf = html[1].test(at.text) ? NONE : { kind: "html", end: html[1] };
      continue;
    }
    // a definition is no paragraph: the next line starts a block of its own
    if (leaf.kind !== "paragraph" && linkDefinition(at.text)) leaf = NONE;
    else if (ATX_HEADING.test(at.text) || THEMATIC_BREAK.test(at.text)) leaf = NONE;
    else if (leaf.kind === "paragraph" && SETEXT_UNDERLINE.test(at.text)) leaf = NONE;
    else leaf = PARAGRAPH;
  }
  if (leaf.kind === "fence") finish(leaf, false);
  return fences;
}
