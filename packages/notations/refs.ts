/**
 * The refs capability: typed cross-model references, keyed by descriptor id —
 * the substrate that turns separate models into ONE architecture (epic #118
 * step 4). refsOf(graph) is the generic dispatch; per-notation emitters turn
 * a ModelGraph into the outgoing references its notation defines. Consumers:
 * the validator's generic dangling-ref rule, the repo index (./content
 * buildRepoIndex), which_models_use, and the release PR's reference section.
 *
 * Pure + browser-safe: operates on the already-parsed ModelGraph, no fs, no
 * XML — same discipline as ./derive.
 */
import type { ModelGraph } from "./extract.ts";
import { byExtension, modelStem } from "./index.ts";

/**
 * One outgoing cross-model reference, as emitted from a single model's graph.
 * The source PATH is attached by the indexer (the graph does not know it).
 */
export interface ModelRef {
  /** element id in the source model the reference hangs on */
  fromElement?: string;
  /** the relation: "calls" (callActivity), "decides" (businessRuleTask),
   *  "shows" (a board's model node), and notation-defined kinds to come
   *  ("realized-by", "owned-by", "mentions", …) */
  rel: string;
  to: {
    /** target model id (= file stem) */
    id: string;
    /** target notation — absent means "any notation with that stem" */
    notation?: string;
    /** optional element inside the target (reserved; not resolved yet) */
    element?: string;
    /** the repo-relative path the source names its target by, where it does
     *  (a board's model node). The reference still resolves by notation and
     *  id; the path tells a moved model (./retarget retargetMovedPaths, the
     *  validator's stale-path warning) and one outside the models folder */
    path?: string;
  };
  /** "required" refs WARN when unresolved (the callActivity behavior);
   *  "informative" refs never fail validation (e.g. markdown mentions) */
  strength: "required" | "informative";
}

const REF_EMITTERS: Record<string, (graph: ModelGraph) => ModelRef[]> = {
  bpmn: (graph) => {
    // two passes — all calls, then all decides — preserving the historical
    // grouping of the validator's link warnings (wire-visible order)
    const refs: ModelRef[] = [];
    for (const n of graph.nodes) {
      const calls = n.extra?.calledElement;
      if (n.type === "callActivity" && typeof calls === "string" && calls) {
        refs.push({ fromElement: n.id, rel: "calls", to: { id: calls, notation: "bpmn" }, strength: "required" });
      }
    }
    for (const n of graph.nodes) {
      const decides = n.extra?.decisionRef;
      if (n.type === "businessRuleTask" && typeof decides === "string" && decides) {
        refs.push({ fromElement: n.id, rel: "decides", to: { id: decides, notation: "dmn" }, strength: "required" });
      }
    }
    return refs;
  },
  // a board shows models of the repository in place: one reference per model
  // node (./extract). A node names its model by PATH; like every reference it
  // resolves by notation and id (the file stem), so a model that moved to
  // another folder still resolves, and the path rides along for whoever has
  // to tell. An image, a file of no notation and another board are no model
  // it shows
  board: (graph) => {
    const refs: ModelRef[] = [];
    for (const n of graph.nodes) {
      const file = n.extra?.file;
      const notation = n.type === "model" ? shownNotation(file) : undefined;
      if (notation === undefined || typeof file !== "string") continue;
      refs.push({
        fromElement: n.id,
        rel: "shows",
        to: { id: modelStem(file), notation, path: file },
        strength: "required",
      });
    }
    return refs;
  },
};

/**
 * The notation of the model a board's model node shows by its `file`: a
 * registered notation other than the board itself, since a board is not
 * shown on a board (its canvas refuses it, the validator warns). Undefined
 * for anything else: no reference, and nothing a rename or a move rewrites.
 */
export function shownNotation(file: unknown): string | undefined {
  if (typeof file !== "string" || file === "") return undefined;
  const notation = byExtension(file)?.id;
  return notation === "board" ? undefined : notation;
}

/**
 * THE generic refs dispatch: every outgoing cross-model reference of the
 * graph; [] when the notation emits none. Registering a notation's emitter
 * here is the whole integration — resolver, index, validation and the
 * release PR section pick it up with zero consumer changes.
 */
export function refsOf(graph: ModelGraph): ModelRef[] {
  return REF_EMITTERS[graph.notation]?.(graph) ?? [];
}

/** whether a notation emits refs at all — lets save paths skip the repo-wide
 *  id scan for notations whose checkRefs would be a no-op anyway */
export function hasRefs(notation: string): boolean {
  return notation in REF_EMITTERS;
}
