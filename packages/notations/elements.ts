/**
 * The elements of a model a todo can anchor to, under the ids its canvas
 * selects and reveals, and the ones closest to an id the model does not have.
 *
 * A process: every BPMN element outside the diagram interchange. bpmn-js
 * draws lanes, pools, artifacts and associations under their own ids too,
 * which the ModelGraph leaves out, and an id the XML has is no unknown id
 * even where nothing draws it. Every other notation: its ModelGraph's nodes
 * and edges, whose ids extract.ts derives the way the canvas does.
 */
import { extractModelGraph, parseXml, XMLValidator } from "./extract.ts";
import { byExtension, byId } from "./index.ts";

export interface ModelElement {
  id: string;
  name?: string;
}

/** ids the diagram interchange gives its shapes and edges: no element of the model */
const BPMN_DIAGRAM_KEY = "BPMNDiagram";

function bpmnElements(raw: string): ModelElement[] {
  const wellFormed = XMLValidator.validate(raw);
  if (wellFormed !== true) throw new Error(`not well-formed XML: ${wellFormed.err.msg}`);
  const elements: ModelElement[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const id = record["@_id"];
    const name = record["@_name"];
    if (typeof id === "string" && id !== "") {
      elements.push(typeof name === "string" && name !== "" ? { id, name } : { id });
    }
    for (const [key, child] of Object.entries(record)) {
      if (!key.startsWith("@_") && key !== BPMN_DIAGRAM_KEY) visit(child);
    }
  };
  visit(parseXml(raw).definitions);
  return elements;
}

/**
 * The elements of a model, first occurrence of an id wins; undefined for a
 * notation without element ids (a Markdown document). Throws when the text
 * does not parse.
 */
export function modelElements(notationOrPath: string, raw: string): ModelElement[] | undefined {
  const notation = byId(notationOrPath) ?? byExtension(notationOrPath);
  if (!notation) return undefined;
  let elements: ModelElement[];
  if (notation.id === "bpmn") {
    elements = bpmnElements(raw);
  } else {
    const graph = extractModelGraph(notation.id, raw);
    if (!graph) return undefined;
    elements = [...graph.nodes, ...graph.edges].map(({ id, name }) => (name ? { id, name } : { id }));
  }
  const seen = new Set<string>();
  return elements.filter(({ id }) => !seen.has(id) && seen.add(id));
}

/** long ids and names are compared by their start: a ranking needs no more */
const COMPARED_LENGTH = 64;

function editDistance(left: string, right: string): number {
  const a = left.slice(0, COMPARED_LENGTH).toLowerCase();
  const b = right.slice(0, COMPARED_LENGTH).toLowerCase();
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The `limit` elements whose id or name is closest to `wanted` (edit
 * distance, case ignored), closest first, model order on a tie: a name
 * counts as much as an id, so a component asked for by its name ranks its
 * id first.
 */
export function closestElements(elements: readonly ModelElement[], wanted: string, limit = 3): ModelElement[] {
  return elements
    .map((element, order) => ({
      element,
      order,
      distance: Math.min(
        editDistance(wanted, element.id),
        element.name === undefined ? Infinity : editDistance(wanted, element.name),
      ),
    }))
    .sort((x, y) => x.distance - y.distance || x.order - y.order)
    .slice(0, limit)
    .map(({ element }) => element);
}
