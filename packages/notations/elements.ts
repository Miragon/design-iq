/**
 * The elements of a model a todo can anchor to, under the ids its canvas
 * selects and reveals, and the ones closest to an id the model does not have.
 *
 * A process: every BPMN element outside the diagram interchange. bpmn-js
 * draws lanes, pools, artifacts and associations under their own ids too,
 * which the ModelGraph leaves out, and an id the XML has is no unknown id
 * even where nothing draws it. Every other notation: the elements of its
 * ModelGraph that its canvas addresses, under the ids extract.ts derives the
 * way the canvas does. A Wardley link and an Event Storming note, drawing or
 * arrow take their id from the line order, so an edit above one hands its id
 * to another element, and no canvas selects, reveals or badges them: a todo
 * anchored to one would show no badge or point at the wrong element.
 */
import { STORM_STICKY_KINDS } from "./derive.ts";
import {
  extractModelGraph,
  type ModelEdge,
  type ModelGraph,
  type ModelNode,
  parseXml,
  XMLValidator,
} from "./extract.ts";
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

const ADDRESSED_BY_CANVAS: Record<string, (graph: ModelGraph) => Array<ModelNode | ModelEdge>> = {
  wardley: (graph) => graph.nodes,
  "event-storming": (graph) => graph.nodes.filter((node) => STORM_STICKY_KINDS.has(node.type)),
};

const addressedByCanvas = (graph: ModelGraph): Array<ModelNode | ModelEdge> =>
  ADDRESSED_BY_CANVAS[graph.notation]?.(graph) ?? [...graph.nodes, ...graph.edges];

/** a document that misses its schema can carry any JSON where an id or a name belongs */
function asModelElement({ id, name }: { id: unknown; name?: unknown }): ModelElement[] {
  if (typeof id !== "string" || id === "") return [];
  return [typeof name === "string" && name !== "" ? { id, name } : { id }];
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
    elements = addressedByCanvas(graph).flatMap(asModelElement);
  }
  const seen = new Set<string>();
  return elements.filter(({ id }) => !seen.has(id) && seen.add(id));
}

/** long ids and names are compared by their start: a ranking needs no more */
const COMPARED_LENGTH = 64;

/**
 * The edit distance, or Infinity once it cannot come out below `cutoff`: a
 * refusal ranks every element of a model on the one thread that also syncs
 * the room, and most elements are far from the id asked for.
 */
function editDistance(left: string, right: string, cutoff: number): number {
  const a = left.slice(0, COMPARED_LENGTH).toLowerCase();
  const b = right.slice(0, COMPARED_LENGTH).toLowerCase();
  if (Math.abs(a.length - b.length) >= cutoff) return Infinity;
  let previous = Uint16Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1);
      const distance = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
      current[j] = distance;
      if (distance < rowMinimum) rowMinimum = distance;
    }
    if (rowMinimum >= cutoff) return Infinity;
    [previous, current] = [current, previous];
  }
  return previous[b.length]! < cutoff ? previous[b.length]! : Infinity;
}

/**
 * The `limit` elements whose id or name is closest to `wanted` (edit
 * distance, case ignored), closest first, model order on a tie: a name
 * counts as much as an id, so a component asked for by its name ranks its
 * id first.
 */
export function closestElements(elements: readonly ModelElement[], wanted: string, limit = 3): ModelElement[] {
  const closest: Array<{ element: ModelElement; distance: number }> = [];
  for (const element of elements) {
    // a later element ties with the last one kept and loses to it
    const cutoff = closest.length < limit ? Infinity : closest[closest.length - 1]!.distance;
    const distance = Math.min(
      editDistance(wanted, element.id, cutoff),
      element.name === undefined ? Infinity : editDistance(wanted, element.name, cutoff),
    );
    if (distance === Infinity) continue;
    const position = closest.findIndex((kept) => kept.distance > distance);
    closest.splice(position === -1 ? closest.length : position, 0, { element, distance });
    if (closest.length > limit) closest.pop();
  }
  return closest.map(({ element }) => element);
}
