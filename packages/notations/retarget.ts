/**
 * Retarget cross-model references — the write-side twin of the refs
 * capability (./refs). Renaming a model changes its id (= file stem), and
 * every reference resolves by that stem (#208), so the models pointing at it
 * are rewritten to the new id instead of being left dangling.
 *
 * A TARGETED text rewrite, never a parse → serialize round trip: only the
 * attribute values that name the old id change, every other byte of the file
 * (formatting, comments, vendor extensions) stays exactly as it was — the
 * release diff of a caller is the one attribute. The spellings are exactly the
 * ones the refs emitter follows (extract.ts decisionRefOf), so a link the
 * platform reads is a link this rewrites:
 *
 *   callActivity      calledElement="x"                          → a process
 *   businessRuleTask  decisionRef / calledDecision / calledElement="x"
 *                     <calledDecision decisionId="x"/>            → a decision
 *
 * A board is the exception: it names the models it shows by PATH, in the
 * `file` of its model nodes, so a rename AND a move (retargetMovedPaths)
 * rewrite it. It is rewritten as the structured document it is, not by a
 * pattern over its text: read strictly, the `file` of each model node
 * changed, written back canonically. Nothing else changes, not the title, an
 * image's file or an element of a kind the board does not know, and a text
 * the board's reader refuses comes back untouched (rewriting it would drop
 * what the reader skips).
 *
 * Pure + browser-safe: string in, string out. Notations without refs return
 * their content untouched.
 */
import { encodeBoard, parseBoardText } from "@miragon/board-schema-model";

import { byExtension, modelStem } from "./index.ts";
import { shownNotation } from "./refs.ts";
import { escapeXml } from "./templates.ts";

/** the model a set of references is moved from one id to another */
export interface RetargetSpec {
  /** notation of the renamed model ("bpmn" for calls, "dmn" for decides) */
  notation: string;
  /** its old id (file stem) */
  from: string;
  /** its new id (file stem) */
  to: string;
  /** the paths a board's model nodes name the renamed model by that follow
   *  the rename. Absent: every path of the model's notation with the old
   *  stem. Which of them is the model only the caller can tell: another file
   *  with the same stem, a duplicate the repo should not hold, keeps its
   *  path (the Live Host passes the model's own path and the stale ones no
   *  file is at, application/scaffold.ts renameModel) */
  paths?: ReadonlySet<string>;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** start tags of the elements that carry references, any namespace prefix */
const REF_TAGS = /<(?:[\w.-]+:)?(callActivity|businessRuleTask|calledDecision)\b[^>]*>/g;

/** the attributes of a start tag that name the target, per tag */
function attributesFor(tag: string, notation: string): string[] {
  if (notation === "bpmn" && tag === "callActivity") return ["calledElement"];
  if (notation === "dmn" && tag === "businessRuleTask") return ["decisionRef", "calledDecision", "calledElement"];
  if (notation === "dmn" && tag === "calledDecision") return ["decisionId"];
  return [];
}

/**
 * `content` with every reference to `spec.from` (of `spec.notation`) pointing
 * at `spec.to` instead. `notation` is the notation of the CONTENT — BPMN and
 * the board emit references; anything else comes back unchanged.
 */
export function retargetRefs(notation: string, content: string, spec: RetargetSpec): string {
  if (spec.from === spec.to) return content;
  if (notation === "board") return retargetBoard(content, (path) => renamedPath(path, spec));
  if (notation !== "bpmn") return content;
  const from = escapeRegExp(escapeXml(spec.from));
  const to = escapeXml(spec.to);
  return content.replace(REF_TAGS, (startTag, tag: string) => {
    let out = startTag;
    for (const attr of attributesFor(tag, spec.notation)) {
      // the value may carry surrounding blanks (decisionRefOf trims them) —
      // the rewritten value is the clean id
      const value = new RegExp(`(\\s(?:[\\w.-]+:)?${attr}\\s*=\\s*)(["'])\\s*${from}\\s*\\2`, "g");
      out = out.replace(value, (_m, lead: string, quote: string) => `${lead}${quote}${to}${quote}`);
    }
    return out;
  });
}

/**
 * `content` with every model path in `moves` (old repo-relative path -> new)
 * rewritten where the content names it by PATH (a board's model nodes); every
 * other notation comes back unchanged. A move keeps the model's id, so the
 * references by id (calls, decides) need nothing.
 */
export function retargetMovedPaths(notation: string, content: string, moves: ReadonlyMap<string, string>): string {
  if (notation !== "board" || moves.size === 0) return content;
  return retargetBoard(content, (path) => moves.get(path));
}

/** a path of the renamed model with its new stem: its folder and its extension stay, as the rename leaves them */
function renamedPath(path: string, spec: RetargetSpec): string | undefined {
  if (byExtension(path)?.id !== spec.notation || modelStem(path) !== spec.from) return undefined;
  if (spec.paths && !spec.paths.has(path)) return undefined;
  const slash = path.lastIndexOf("/");
  const base = path.slice(slash + 1);
  return `${path.slice(0, slash + 1)}${spec.to}${base.slice(spec.from.length)}`;
}

/**
 * A board with the `file` of each model node that shows a model (./refs
 * shownNotation) set to `rewrite(file)`, where that is another path. The
 * content itself when nothing changes, so an unchanged board keeps its bytes
 * whatever their form, and when the board's strict reader refuses the text.
 */
function retargetBoard(content: string, rewrite: (path: string) => string | undefined): string {
  const parsed = parseBoardText(content);
  if (!parsed.ok) return content;
  const elements = { ...parsed.snapshot.elements };
  let changed = false;
  for (const [id, attrs] of Object.entries(elements)) {
    const file = attrs.file;
    if (attrs.kind !== "node" || attrs.type !== "model" || typeof file !== "string" || !shownNotation(file)) continue;
    const next = rewrite(file);
    if (next === undefined || next === file) continue;
    elements[id] = { ...attrs, file: next };
    changed = true;
  }
  return changed ? encodeBoard({ elements, meta: parsed.snapshot.meta }) : content;
}
