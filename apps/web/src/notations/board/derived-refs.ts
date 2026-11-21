/**
 * What the models on a board say about each other, read from their CURRENT texts through the
 * platform's own reader (@designiq/notations: extractModelGraph + refsOf, the validator's and the
 * repo index's source), so a board draws exactly the links the product follows: today a BPMN
 * call activity ("calls") and a business rule task ("decides"); an emitter added to
 * packages/notations/refs.ts shows up here with no change. The board draws them as arrows
 * between the nodes of the two files and never stores them (BoardReference). Node-loadable.
 */
import { byExtension, modelStem } from "@designiq/notations";
import { extractModelGraph } from "@designiq/notations/extract";
import { hasRefs, type ModelRef, refsOf } from "@designiq/notations/refs";
import type { BoardReference } from "@miragon/board-renderer";

import type { ModelText } from "./model-texts.ts";

/** the outgoing references of one model to the files at `paths`; none for a text that does not parse */
export function referencesOfFile(file: ModelText, paths: readonly string[]): BoardReference[] {
  const notation = byExtension(file.path)?.id;
  // a board refers to the models it shows: that is the board itself, not an arrow on it
  if (notation === undefined || notation === "board" || !hasRefs(notation)) return [];
  let refs: ModelRef[];
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
      .map((to) => ({ from: file.path, to, relation: ref.rel })),
  );
}

/** every reference between the files, once per pair and relation (two calls of one sub-process are one arrow), sorted */
export function boardReferences(files: readonly ModelText[], paths: readonly string[]): BoardReference[] {
  const byKey = new Map<string, BoardReference>();
  for (const file of files) {
    for (const ref of referencesOfFile(file, paths)) byKey.set(`${ref.relation}\u0000${ref.from}\u0000${ref.to}`, ref);
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, ref]) => ref);
}

export function sameReferences(a: readonly BoardReference[], b: readonly BoardReference[]): boolean {
  return (
    a.length === b.length &&
    a.every((ref, i) => ref.from === b[i]?.from && ref.to === b[i]?.to && ref.relation === b[i]?.relation)
  );
}
