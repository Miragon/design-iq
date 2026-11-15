/**
 * The board as a structured live document (@designiq/contracts/live ELEMENTS_KEY / META_KEY):
 * one element per node and per arrow, plain JSON attributes, written with targeted per-attribute
 * writes in one transaction per finished gesture (brief sync.md, section 4).
 * Node-loadable: test/spike/board-doc.test.ts runs it without a browser.
 */
import { ELEMENTS_KEY, META_KEY } from "@designiq/contracts/live";
import { readSnapshot, reconcileSnapshot } from "@designiq/live-client/structured";
import { byExtension } from "@designiq/notations";
import { fractionalIndexBetween, jsonLinesCodec } from "@designiq/notations/codecs";
import * as Y from "yjs";

import { type Box, MODEL_NOTATIONS, type ModelNotation } from "./types.ts";

/** origin of this client's board gestures: what the undo manager tracks */
export const BOARD_LOCAL = "board-local";

export type NodeType = "model" | "text" | "image" | "group";
/** the handle ids every node type renders, one per side */
export const SIDES = ["top", "right", "bottom", "left"] as const;
export type Side = (typeof SIDES)[number];

// type aliases, not interfaces: an alias fits the snapshot's Record<string, unknown> as it is
export type NodeAttrs = {
  kind: "node";
  type: NodeType;
  /** relative to `parent` where set (React Flow's own convention), else board coordinates; integers */
  x: number;
  y: number;
  width: number;
  height: number;
  /** element id of a group node */
  parent?: string;
  /** fractional index (fractionalIndexBetween): plain string order, ties broken by element id */
  z: string;
  /** model, image: repo-relative path of the file. The board stores the reference, never the content */
  file?: string;
  /** text: Markdown; group: its label */
  text?: string;
};

export type EdgeAttrs = {
  kind: "edge";
  source: string;
  target: string;
  sourceHandle?: Side;
  targetHandle?: Side;
  label?: string;
};

export type ElementAttrs = NodeAttrs | EdgeAttrs;

/** a whole board as plain data: what a board builder returns and the codec writes */
export interface BoardSnapshot {
  elements: Record<string, ElementAttrs>;
  meta: { title: string; version: 1 };
}

export interface BoardNode {
  id: string;
  attrs: NodeAttrs;
  /** `attrs.parent` where that element exists, is a node and closes no cycle */
  parentId: string | undefined;
}
export interface BoardEdge {
  id: string;
  attrs: EdgeAttrs;
}
export interface BoardView {
  /** in z order, every parent before its children (React Flow needs both) */
  nodes: readonly BoardNode[];
  edges: readonly BoardEdge[];
  meta: Readonly<Record<string, unknown>>;
}

export interface BoardTx {
  /** a new element under a collision-safe id (newId) */
  create(id: string, attrs: ElementAttrs): void;
  /** writes every attribute named, changed or not; `undefined` removes one. A no-op on an element that is gone */
  update(id: string, attrs: Partial<NodeAttrs> | Partial<EdgeAttrs>): void;
  remove(id: string): void;
}

export interface BoardStore {
  readonly doc: Y.Doc;
  /** useSyncExternalStore's pair: the view keeps its identity until the document changes */
  subscribe(listener: () => void): () => void;
  getSnapshot(): BoardView;
  /** one gesture, one transaction, origin BOARD_LOCAL */
  gesture(run: (tx: BoardTx) => void): void;
  /** a key above every node's (bring to front, a new node) */
  zOnTop(): string;
  /** the board file as it is at rest */
  text(): string;
  readonly undo: Y.UndoManager;
  destroy(): void;
}

export const newId = (prefix: "n" | "e"): string => `${prefix}_${crypto.randomUUID().slice(0, 13)}`;

/** the notation of a model node's file, by its extension; undefined for anything that is no model */
export function notationOf(file: string | undefined): ModelNotation | undefined {
  const id = file === undefined ? undefined : byExtension(file)?.id;
  return MODEL_NOTATIONS.find((notation) => notation === id);
}

const NODE_TYPES: ReadonlySet<unknown> = new Set<NodeType>(["model", "text", "image", "group"]);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** an element of another shape (a newer client, a hand-edited file) is no node: it stays in the document, off the canvas */
const isNode = (attrs: Record<string, unknown>): attrs is Record<string, unknown> & NodeAttrs =>
  attrs.kind === "node" &&
  NODE_TYPES.has(attrs.type) &&
  [attrs.x, attrs.y, attrs.width, attrs.height].every(isNumber) &&
  typeof attrs.z === "string";
const isEdge = (attrs: Record<string, unknown>): attrs is Record<string, unknown> & EdgeAttrs =>
  attrs.kind === "edge" && typeof attrs.source === "string" && typeof attrs.target === "string";
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** the document as React Flow can draw it: total, whatever a peer or a merge left in it */
export function projectBoard(doc: Y.Doc, previous?: BoardView): BoardView {
  const elements = doc.getMap<Y.Map<unknown>>(ELEMENTS_KEY);
  const attrsOf = new Map<string, Record<string, unknown>>();
  elements.forEach((value, id) => {
    if (value instanceof Y.Map) attrsOf.set(id, value.toJSON() as Record<string, unknown>);
  });
  const nodeIds = [...attrsOf].filter(([, attrs]) => isNode(attrs)).map(([id]) => id);
  const nodeSet = new Set(nodeIds);
  const parentOf = (id: string): string | undefined => {
    const parent = attrsOf.get(id)?.parent;
    if (typeof parent !== "string" || !nodeSet.has(parent)) return undefined;
    // two peers that moved two groups into each other: every node ON the cycle loses its parent, on every
    // peer alike; a node whose ancestors merely lead into a cycle keeps its own
    const seen = new Set<string>();
    for (
      let at: unknown = parent;
      typeof at === "string" && nodeSet.has(at) && !seen.has(at);
      at = attrsOf.get(at)?.parent
    ) {
      if (at === id) return undefined;
      seen.add(at);
    }
    return parent;
  };
  const kept = new Map(previous?.nodes.map((node) => [node.id, node]));
  const sorted = nodeIds.sort(
    (a, b) => order(String(attrsOf.get(a)?.z ?? ""), String(attrsOf.get(b)?.z ?? "")) || order(a, b),
  );
  const nodes: BoardNode[] = [];
  const placed = new Set<string>();
  const place = (id: string): void => {
    if (placed.has(id)) return;
    placed.add(id);
    const parentId = parentOf(id);
    if (parentId !== undefined) place(parentId);
    const attrs = attrsOf.get(id) as Record<string, unknown> & NodeAttrs;
    const before = kept.get(id);
    // an unchanged node keeps its object: React Flow and a memoized node component skip it
    nodes.push(before && before.parentId === parentId && same(before.attrs, attrs) ? before : { id, attrs, parentId });
  };
  for (const id of sorted) place(id);
  const keptEdges = new Map(previous?.edges.map((edge) => [edge.id, edge]));
  const edges: BoardEdge[] = [...attrsOf]
    .filter((entry): entry is [string, Record<string, unknown> & EdgeAttrs] => isEdge(entry[1]))
    // an arrow whose node a peer deleted meanwhile stays in the document and off the canvas
    .filter(([, attrs]) => nodeSet.has(attrs.source) && nodeSet.has(attrs.target))
    .sort(([a], [b]) => order(a, b))
    .map(([id, attrs]) => {
      const before = keptEdges.get(id);
      return before && same(before.attrs, attrs) ? before : { id, attrs };
    });
  const meta = doc.getMap(META_KEY).toJSON() as Record<string, unknown>;
  return { nodes, edges, meta: previous && same(previous.meta, meta) ? previous.meta : meta };
}

/** a node's box in board coordinates: `x`/`y` of a child are relative to its parent */
export function absoluteBox(view: BoardView, id: string): Box | undefined {
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  const node = byId.get(id);
  if (!node) return undefined;
  const box = { x: node.attrs.x, y: node.attrs.y, width: node.attrs.width, height: node.attrs.height };
  // projectBoard opened every parent cycle, so the walk ends
  for (let parent = byId.get(node.parentId ?? ""); parent; parent = byId.get(parent.parentId ?? "")) {
    box.x += parent.attrs.x;
    box.y += parent.attrs.y;
  }
  return box;
}

const codec = jsonLinesCodec();

/** the board's at-rest text: one JSON line per element, sorted by id (the house codec of the structured lane) */
export const boardText = (doc: Y.Doc): string => codec.encode(readSnapshot(doc));

/** a fresh board document holding `seed`: the one whole-document write a board ever gets */
export function createBoardDoc(seed: BoardSnapshot | string): Y.Doc {
  const doc = new Y.Doc();
  reconcileSnapshot(
    doc,
    typeof seed === "string" ? codec.decode(seed) : { elements: { ...seed.elements }, meta: { ...seed.meta } },
  );
  return doc;
}

export function createBoardStore(doc: Y.Doc): BoardStore {
  const elements = doc.getMap<Y.Map<unknown>>(ELEMENTS_KEY);
  const meta = doc.getMap(META_KEY);
  let view = projectBoard(doc);
  const listeners = new Set<() => void>();
  // every origin: this client's gestures, a peer's, an undo. It reads, and never writes
  const onChange = (): void => {
    view = projectBoard(doc, view);
    for (const listener of [...listeners]) listener();
  };
  elements.observeDeep(onChange);
  meta.observe(onChange);
  const undo = new Y.UndoManager([elements, meta], { trackedOrigins: new Set([BOARD_LOCAL]), captureTimeout: 0 });
  const tx: BoardTx = {
    create(id, attrs) {
      const element = new Y.Map<unknown>();
      // filled before it is attached: no observer sees a half-written element
      for (const [key, value] of Object.entries(attrs)) if (value !== undefined) element.set(key, value);
      elements.set(id, element);
    },
    update(id, attrs) {
      // read at write time, never kept: a peer's create of the same id orphans a kept Y.Map (live.ts:17-21)
      const element = elements.get(id);
      if (!(element instanceof Y.Map)) return;
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined) element.delete(key);
        else element.set(key, value);
      }
    },
    remove: (id) => elements.delete(id),
  };
  return {
    doc,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => view,
    gesture: (run) => doc.transact(() => run(tx), BOARD_LOCAL),
    zOnTop: () =>
      fractionalIndexBetween(view.nodes.reduce((top, node) => (node.attrs.z > top ? node.attrs.z : top), "")),
    text: () => boardText(doc),
    undo,
    destroy() {
      elements.unobserveDeep(onChange);
      meta.unobserve(onChange);
      undo.destroy();
      listeners.clear();
    },
  };
}

/** where a node ended up: a move names its position, a resize its size too */
export interface Geometry {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/**
 * The end of a move or a resize, as one gesture. x AND y (and both sizes), changed or not: two
 * peers' concurrent drops then resolve to ONE peer's box, never to a mix of both (sync.md 4.2).
 */
export function writeGeometry(store: BoardStore, boxes: Readonly<Record<string, Geometry>>): void {
  store.gesture((tx) => {
    for (const [id, { x, y, width, height }] of Object.entries(boxes)) {
      tx.update(id, {
        x: Math.round(x),
        y: Math.round(y),
        ...(width !== undefined && height !== undefined
          ? { width: Math.round(width), height: Math.round(height) }
          : {}),
      });
    }
  });
}
