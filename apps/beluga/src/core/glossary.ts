/**
 * The glossary of a session: the names and terms the recognizer should listen
 * for. The facilitator types it, one entry per line, or takes it from the
 * glossary of a workshop brief (the `collaborative-modeling` skill's template).
 * It stays on this machine.
 */

/** more entries than this are not taken: 1000 cost no more time than 10, a list that long is a mistake */
export const MAX_ENTRIES = 1000;
/** a longer line is no name or term but a pasted sentence */
export const MAX_LENGTH = 60;

/** one entry as written: inner spaces collapsed, nothing around it */
const tidy = (entry: string): string => entry.replace(/\s+/gu, " ").trim();

/** the entries of a text, one per line: no empty lines, no repeats, at most MAX_ENTRIES */
export function parseGlossary(text: string): string[] {
  return unique(text.split(/\r?\n/u));
}

function unique(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of entries) {
    const entry = tidy(raw);
    if (!entry || entry.length > MAX_LENGTH || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/** a table cell as text: no code marks, no emphasis, no link target */
function cellText(cell: string): string {
  return tidy(
    cell
      .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replace(/[`*_]/gu, "")
      .replace(/\\\|/gu, "|"),
  );
}

/**
 * The terms of a workshop brief: the first column of the table under its
 * `## Glossary` heading. The template's placeholders (`<...>`) are skipped.
 * A text without that heading is taken as a plain list, one entry per line.
 */
export function glossaryFromFile(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  const heading = lines.findIndex((line) => /^##\s+Glossary\s*$/iu.test(line));
  if (heading < 0) return parseGlossary(text);
  const terms: string[] = [];
  let row = 0;
  for (const line of lines.slice(heading + 1)) {
    if (/^#{1,2}\s/u.test(line)) break;
    if (!line.trim().startsWith("|")) continue;
    row++;
    // the header row and the row of dashes under it
    if (row <= 2) continue;
    const first =
      line
        .trim()
        .slice(1)
        .split(/(?<!\\)\|/u)[0] ?? "";
    const term = cellText(first);
    if (term && !/^<.*>$/u.test(term)) terms.push(term);
  }
  return unique(terms);
}
