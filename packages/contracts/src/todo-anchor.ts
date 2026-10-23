/**
 * Todo anchor codec — the platform-owned block that ties a tracker item to a
 * model and (optionally) concrete elements of it. Trackers store it verbatim
 * (GitHub/GitLab: inside the issue body, invisible as an HTML comment; Jira:
 * in the description) and the platform parses it back out — the tracker never
 * needs to understand it.
 *
 * Format v1 (line-based on purpose — this module is domain code and may not
 * depend on a YAML library). The block names the model's notation and id —
 * ids are file stems, unique per notation but not across them (a process and
 * a Wardley Map may share one):
 *
 *   <!-- bpmiq:todo v1
 *   notation: bpmn
 *   model: order-to-cash
 *   file: processes/order-to-cash/order-to-cash.bpmn
 *   version: 1.4.0
 *   element: Task_CheckCredit | Bonität prüfen
 *   type: bug_report | Bug report
 *   -->
 *
 * `element:` repeats per anchored element; the part after `|` is the name
 * SNAPSHOT at creation time (elements get renamed — the id stays the anchor,
 * the name keeps the item readable when the id no longer resolves).
 * `type:` names the issue template the todo was filed with, the same way; a
 * todo without it is a built-in `Todo` (#313). Labels can be edited by hand,
 * the block cannot drift with them.
 * Parsing is tolerant: unknown lines are skipped; a missing block, or one
 * without its notation or model, yields null.
 */

/** the model a todo belongs to — ids are file stems, unique per notation */
export interface TodoModelRef {
  /** registry notation id (@designiq/notations) */
  notation: string;
  /** model id, the file stem */
  id: string;
}

export interface TodoElement {
  id: string;
  /** display-name snapshot at creation time */
  name: string | null;
}

export interface TodoAnchor {
  /** the model's notation (registry id) */
  notation: string;
  /** model id (the file stem; a process's process id) */
  model: string;
  /** repo-relative model file the elements live in */
  file: string | null;
  elements: TodoElement[];
  /** process version at creation time, if known (optional — no metadata on the slim contract) */
  processVersion: string | null;
  /** the issue template it was filed with; absent = the built-in `Todo` */
  type?: TodoTypeRef;
}

export interface TodoTypeRef {
  id: string;
  /** display-name snapshot at creation time */
  name: string;
}

/** the model the anchor names */
export const anchorModel = (anchor: Pick<TodoAnchor, "notation" | "model">): TodoModelRef => ({
  notation: anchor.notation,
  id: anchor.model,
});

/** whether the anchor names that model */
export const anchorsModel = (anchor: Pick<TodoAnchor, "notation" | "model">, model: TodoModelRef): boolean =>
  anchor.notation === model.notation && anchor.model === model.id;

// FROZEN — the marker never follows a product rename (the rename decision,
// ADR 0008): it opens the block in the issues todos are filed as, and the
// repo's manual todo form pre-fills it. Pinned by
// apps/live-host/test/todo-anchor.test.ts.
const OPEN = "<!-- bpmiq:todo v1"; // legacy-name-ok: stored in customer issue bodies
const CLOSE = "-->";

/** newlines/pipe would break the line format and `--` could end the HTML
 *  comment early — flatten them out of names */
const cleanName = (name: string | null): string =>
  (name ?? "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/-{2,}/g, "-")
    .trim();

export function encodeAnchor(anchor: TodoAnchor): string {
  const lines = [OPEN, `notation: ${anchor.notation}`, `model: ${anchor.model}`];
  if (anchor.file) lines.push(`file: ${anchor.file}`);
  if (anchor.processVersion) lines.push(`version: ${anchor.processVersion}`);
  for (const el of anchor.elements) lines.push(`element: ${el.id} | ${cleanName(el.name)}`);
  if (anchor.type) lines.push(`type: ${cleanName(anchor.type.id)} | ${cleanName(anchor.type.name)}`);
  lines.push(CLOSE);
  return lines.join("\n");
}

/** the text WITHOUT the anchor block — the block is platform bookkeeping stored
 *  inline in the tracker, so anything that shows a body to a human or an agent
 *  drops it first. Text without a block comes back unchanged. */
export function stripAnchor(text: string): string {
  const start = text.indexOf(OPEN);
  if (start === -1) return text;
  const end = text.indexOf(CLOSE, start);
  if (end === -1) return text;
  return text.slice(0, start) + text.slice(end + CLOSE.length);
}

/** the text with its anchor block replaced by `anchor`'s — everything around
 *  the block stays byte for byte (a re-anchored todo, #208); text without a
 *  block comes back unchanged */
export function replaceAnchor(text: string, anchor: TodoAnchor): string {
  const start = text.indexOf(OPEN);
  if (start === -1) return text;
  const end = text.indexOf(CLOSE, start);
  if (end === -1) return text;
  return text.slice(0, start) + encodeAnchor(anchor) + text.slice(end + CLOSE.length);
}

export function parseAnchor(text: string): TodoAnchor | null {
  const start = text.indexOf(OPEN);
  if (start === -1) return null;
  const end = text.indexOf(CLOSE, start);
  if (end === -1) return null;
  const anchor: TodoAnchor = { notation: "", model: "", file: null, elements: [], processVersion: null };
  for (const raw of text.slice(start + OPEN.length, end).split("\n")) {
    const line = raw.trim();
    const sep = line.indexOf(": ");
    if (sep === -1) continue;
    const key = line.slice(0, sep);
    const value = line.slice(sep + 2).trim();
    if (key === "model") anchor.model = value;
    else if (key === "notation") anchor.notation = value;
    else if (key === "file") anchor.file = value;
    else if (key === "version") anchor.processVersion = value;
    else if (key === "type") {
      const pipe = value.indexOf(" |");
      const id = (pipe === -1 ? value : value.slice(0, pipe)).trim();
      const name = pipe === -1 ? "" : value.slice(pipe + 2).trim();
      if (id) anchor.type = { id, name: name || id };
    } else if (key === "element") {
      const pipe = value.indexOf(" | ");
      if (pipe === -1) anchor.elements.push({ id: value.replace(/ \|$/, "").trim(), name: null });
      else anchor.elements.push({ id: value.slice(0, pipe).trim(), name: value.slice(pipe + 3).trim() || null });
    }
  }
  return anchor.notation && anchor.model ? anchor : null;
}
