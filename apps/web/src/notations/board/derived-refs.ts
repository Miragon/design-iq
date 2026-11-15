/**
 * Derived arrows: what the models on a board say about each other, read from their CURRENT texts
 * and never stored. A BPMN callActivity `calledElement="<stem>"` and a businessRuleTask with
 * `calledDecision` / `decisionRef` = `<stem>` point at the file with that stem.
 *
 * The references come from the platform's own reader (@designiq/notations: extractModelGraph +
 * refsOf, the validator's and the repo index's source), so the board follows exactly the links
 * the product follows. Pure and Node-loadable.
 */
import { byExtension, modelStem } from "@designiq/notations";
import { extractModelGraph } from "@designiq/notations/extract";
import { hasRefs, refsOf } from "@designiq/notations/refs";

export interface ModelText {
  path: string;
  text: string;
}

/** one reference between two FILES of the given set */
export interface DerivedRef {
  from: string;
  to: string;
  /** "calls" (callActivity) or "decides" (businessRuleTask) */
  rel: string;
  /** the element in `from` the reference hangs on */
  fromElement?: string;
}

/** an arrow between two NODES of a board, drawn and not stored */
export interface DerivedArrow {
  /** stable for the pair and the relation, so React Flow keeps the edge across recomputations */
  id: string;
  source: string;
  target: string;
  rel: string;
}

/**
 * The outgoing references of one model file to the files at `paths` (a reference names a file stem
 * and a notation, so a target's text is not needed); [] for a text that does not parse.
 */
export function refsOfFile(file: ModelText, paths: readonly string[]): DerivedRef[] {
  const notation = byExtension(file.path)?.id;
  if (notation === undefined || !hasRefs(notation)) return [];
  let refs: ReturnType<typeof refsOf>;
  try {
    const graph = extractModelGraph(notation, file.text);
    refs = graph ? refsOf(graph) : [];
  } catch {
    // a text between two merges may be no XML for a moment: no arrows from it until it is one again
    return [];
  }
  return refs.flatMap((ref) =>
    paths
      .filter(
        (path) =>
          path !== file.path &&
          modelStem(path) === ref.to.id &&
          (ref.to.notation === undefined || byExtension(path)?.id === ref.to.notation),
      )
      .map((path) => ({
        from: file.path,
        to: path,
        rel: ref.rel,
        ...(ref.fromElement !== undefined ? { fromElement: ref.fromElement } : {}),
      })),
  );
}

export function derivedRefs(files: readonly ModelText[]): DerivedRef[] {
  const paths = files.map((file) => file.path);
  return files.flatMap((file) => refsOfFile(file, paths));
}

/** from every node of the calling file to every node of the called file, once per pair and relation */
export function derivedArrows(
  refs: readonly DerivedRef[],
  nodes: ReadonlyArray<{ id: string; file?: string }>,
): DerivedArrow[] {
  const arrows = new Map<string, DerivedArrow>();
  for (const ref of refs) {
    for (const source of nodes) {
      if (source.file !== ref.from) continue;
      for (const target of nodes) {
        if (target.file !== ref.to) continue;
        const id = `derived:${ref.rel}:${source.id}:${target.id}`;
        arrows.set(id, { id, source: source.id, target: target.id, rel: ref.rel });
      }
    }
  }
  return [...arrows.values()];
}
