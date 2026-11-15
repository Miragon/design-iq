/**
 * What the board's own features write into the board document, apart from React: a new node and
 * where it goes, which group a node belongs to after a drop, which node an arrow's loose end lands
 * on, and which image files the board takes. Every write is ONE gesture of the board store.
 *
 * A node belongs to the group its centre lies in when the gesture that placed it ends. Groups do
 * not nest: a group never joins a group.
 *
 * Node-loadable (test/spike/board-actions.test.ts): no DOM, no React.
 */
import { REPO_IMAGE_MAX_BYTES, REPO_IMAGE_TYPES, repoImageType } from "@designiq/contracts/live";
import { fractionalIndexBetween } from "@designiq/notations/codecs";

import {
  type BoardStore,
  type BoardView,
  type EdgeAttrs,
  newId,
  type NodeAttrs,
  type NodeType,
  type Side,
  SIDES,
} from "./board-doc.ts";
import type { Box } from "./types.ts";

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}

// ── geometry ─────────────────────────────────────────────────────────────────

const centreOf = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const contains = (box: Box, point: Point): boolean =>
  point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
/** `by` < 0 shrinks; a box shrunk past its middle contains nothing */
const grown = (box: Box, by: number): Box => ({
  x: box.x - by,
  y: box.y - by,
  width: box.width + 2 * by,
  height: box.height + 2 * by,
});

/** every node's box in board coordinates (a child's `x` / `y` are relative to its parent) */
export function absoluteBoxes(view: BoardView): Map<string, Box> {
  const boxes = new Map<string, Box>();
  // parents come before their children in the view (projectBoard)
  for (const { id, attrs, parentId } of view.nodes) {
    const parent = parentId === undefined ? undefined : boxes.get(parentId);
    boxes.set(id, {
      x: attrs.x + (parent?.x ?? 0),
      y: attrs.y + (parent?.y ?? 0),
      width: attrs.width,
      height: attrs.height,
    });
  }
  return boxes;
}

/** the side of `box` that `point` is nearest to, measured against the box's own proportions */
export function nearestSide(box: Box, point: Point): Side {
  const centre = centreOf(box);
  const dx = (point.x - centre.x) / Math.max(1, box.width / 2);
  const dy = (point.y - centre.y) / Math.max(1, box.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "top" : "bottom";
}

export const sideOf = (handle: string | null | undefined): Side | undefined => SIDES.find((side) => side === handle);

// ── groups ───────────────────────────────────────────────────────────────────

/**
 * The group a node with its centre at `centre` belongs to: the one it is in (`current`) for as
 * long as the centre stays inside it, else the topmost group around the centre, else none.
 */
export function groupAround(
  view: BoardView,
  centre: Point,
  current?: string,
  boxes: ReadonlyMap<string, Box> = absoluteBoxes(view),
): string | undefined {
  let found: string | undefined;
  for (const node of view.nodes) {
    if (node.attrs.type !== "group") continue;
    const box = boxes.get(node.id);
    if (!box || !contains(box, centre)) continue;
    if (node.id === current) return current;
    // the view is in paint order: a later group lies on top of an earlier one
    found = node.id;
  }
  return found;
}

/** a node that changes its group: the new parent (none: it leaves) and its place relative to it */
export interface Regroup {
  id: string;
  parent: string | undefined;
  x: number;
  y: number;
}

/**
 * Which of the nodes `ids` (just moved, their new place already in the document) now belong to
 * another group or to none. The node stays where it is on the board: only what its coordinates
 * are relative to changes.
 */
export function regroup(view: BoardView, ids: readonly string[]): Regroup[] {
  const boxes = absoluteBoxes(view);
  const moves: Regroup[] = [];
  for (const id of ids) {
    const node = view.nodes.find((one) => one.id === id);
    const box = boxes.get(id);
    if (!node || !box || node.attrs.type === "group") continue;
    const parent = groupAround(view, centreOf(box), node.parentId, boxes);
    if (parent === node.parentId) continue;
    const origin = parent === undefined ? undefined : boxes.get(parent);
    moves.push({ id, parent, x: box.x - (origin?.x ?? 0), y: box.y - (origin?.y ?? 0) });
  }
  return moves;
}

/** one gesture: `parent`, `x` and `y` of every node together, so no peer ever sees a half-moved node */
export function writeRegroup(store: BoardStore, moves: readonly Regroup[]): void {
  if (moves.length === 0) return;
  store.gesture((tx) => {
    for (const { id, parent, x, y } of moves) tx.update(id, { parent, x: Math.round(x), y: Math.round(y) });
  });
}

/**
 * The end of a node drag (or of a run of arrow-key moves) as ONE gesture: where each moved node is
 * now (`positions`, relative to its parent as React Flow keeps them) and, for a node whose centre
 * left its group or entered one, whose it is. No peer sees the move without the membership, and
 * one undo takes back both.
 */
export function writeDrop(store: BoardStore, positions: Readonly<Record<string, Point>>): void {
  const view = store.getSnapshot();
  const placed = (id: string): Point | undefined => {
    const to = positions[id];
    return to && { x: Math.round(to.x), y: Math.round(to.y) };
  };
  // the board as it will be once the positions are written: what regroup() decides on
  const moved: BoardView = {
    ...view,
    nodes: view.nodes.map((node) => {
      const to = placed(node.id);
      return to ? { ...node, attrs: { ...node.attrs, ...to } } : node;
    }),
  };
  const joins = new Map(regroup(moved, Object.keys(positions)).map((move) => [move.id, move]));
  store.gesture((tx) => {
    for (const id of Object.keys(positions)) {
      const join = joins.get(id);
      // x AND y, changed or not (writeGeometry): two peers' drops resolve to one peer's place
      if (join) tx.update(id, { parent: join.parent, x: Math.round(join.x), y: Math.round(join.y) });
      else tx.update(id, { ...placed(id) });
    }
  });
}

/**
 * Elements leave the board, as one gesture. A node that stays although its group goes (React Flow
 * keeps a node that is not deletable, and an armed model node is not) is a node of the board
 * itself from then on, at the place it has: without this its coordinates, relative to a group that
 * is gone, would be read as board coordinates and the node would jump by the group's origin.
 */
export function writeRemoval(store: BoardStore, nodes: readonly string[], arrows: readonly string[]): void {
  const view = store.getSnapshot();
  const gone = new Set(nodes);
  const boxes = absoluteBoxes(view);
  store.gesture((tx) => {
    for (const id of arrows) tx.remove(id);
    for (const id of nodes) tx.remove(id);
    for (const node of view.nodes) {
      if (gone.has(node.id) || node.parentId === undefined || !gone.has(node.parentId)) continue;
      const box = boxes.get(node.id);
      if (box) tx.update(node.id, { parent: undefined, x: Math.round(box.x), y: Math.round(box.y) });
    }
  });
}

// ── new nodes ────────────────────────────────────────────────────────────────

/** a key under every node's: a group is a frame BEHIND what it holds, so it also precedes its members in the view */
function zAtBottom(view: BoardView): string {
  const lowest = view.nodes.reduce<string | undefined>(
    (low, node) => (low === undefined || node.attrs.z < low ? node.attrs.z : low),
    undefined,
  );
  if (lowest === undefined) return fractionalIndexBetween();
  try {
    return fractionalIndexBetween(undefined, lowest);
  } catch {
    // a key nothing fits under (a hand-written "0"): the same key, the element id breaks the tie
    return lowest;
  }
}

export interface NewNode extends Size {
  type: NodeType;
  file?: string;
  text?: string;
}

/** the sizes the toolbar's add actions give a new node */
export const NEW_NODE: Readonly<Record<Exclude<NodeType, "image">, Size>> = {
  // wider than 760: below that four renderers switch to their narrow chrome
  model: { width: 800, height: 540 },
  text: { width: 280, height: 160 },
  group: { width: 640, height: 420 },
};

/**
 * A new node with its centre at `centre` (board coordinates), as one gesture. It joins the group
 * it lands in; a new group goes behind everything. Returns the new element's id.
 */
export function addNode(store: BoardStore, node: NewNode, centre: Point): string {
  const view = store.getSnapshot();
  const boxes = absoluteBoxes(view);
  const group = node.type === "group" ? undefined : groupAround(view, centre, undefined, boxes);
  const origin = group === undefined ? undefined : boxes.get(group);
  const id = newId("n");
  const attrs: NodeAttrs = {
    kind: "node",
    type: node.type,
    x: Math.round(centre.x - node.width / 2 - (origin?.x ?? 0)),
    y: Math.round(centre.y - node.height / 2 - (origin?.y ?? 0)),
    width: Math.round(node.width),
    height: Math.round(node.height),
    ...(group !== undefined ? { parent: group } : {}),
    z: node.type === "group" ? zAtBottom(view) : store.zOnTop(),
    ...(node.file !== undefined ? { file: node.file } : {}),
    ...(node.text !== undefined ? { text: node.text } : {}),
  };
  store.gesture((tx) => tx.create(id, attrs));
  return id;
}

/** room between a new group's frame and the nodes it is drawn around; more at the top, for the label */
const GROUP_PADDING = { side: 32, top: 64 };

/**
 * A new group around the nodes `ids` (groups among them are left out), which become its members,
 * all in one gesture. Undefined when none of the ids is a node that can be a member.
 */
export function addGroupAround(store: BoardStore, ids: readonly string[], label: string): string | undefined {
  const view = store.getSnapshot();
  const boxes = absoluteBoxes(view);
  const members = view.nodes.filter((node) => ids.includes(node.id) && node.attrs.type !== "group");
  const memberBoxes = members.flatMap((node) => boxes.get(node.id) ?? []);
  if (memberBoxes.length === 0) return undefined;
  const left = Math.min(...memberBoxes.map((box) => box.x)) - GROUP_PADDING.side;
  const top = Math.min(...memberBoxes.map((box) => box.y)) - GROUP_PADDING.top;
  const right = Math.max(...memberBoxes.map((box) => box.x + box.width)) + GROUP_PADDING.side;
  const bottom = Math.max(...memberBoxes.map((box) => box.y + box.height)) + GROUP_PADDING.side;
  const id = newId("n");
  store.gesture((tx) => {
    tx.create(id, {
      kind: "node",
      type: "group",
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(right - left),
      height: Math.round(bottom - top),
      z: zAtBottom(view),
      text: label,
    });
    for (const node of members) {
      const box = boxes.get(node.id);
      if (box) tx.update(node.id, { parent: id, x: Math.round(box.x - left), y: Math.round(box.y - top) });
    }
  });
  return id;
}

// ── arrows ───────────────────────────────────────────────────────────────────

export interface ArrowEnd {
  node: string;
  side: Side;
}

/**
 * The node an arrow's loose end lands on at `point`: the topmost node there, at the side nearest
 * to the point. `reach` widens every node by that much, so its border counts. A group is its
 * frame only: its inside is board ground, and an arrow dropped there ends nowhere.
 */
export function arrowEndAt(view: BoardView, point: Point, reach: number, exclude?: string): ArrowEnd | undefined {
  const boxes = absoluteBoxes(view);
  // paint order: the last node is on top
  for (let index = view.nodes.length - 1; index >= 0; index--) {
    const node = view.nodes[index];
    const box = node === undefined ? undefined : boxes.get(node.id);
    if (!node || !box || node.id === exclude || !contains(grown(box, reach), point)) continue;
    if (node.attrs.type === "group" && contains(grown(box, -reach), point)) continue;
    return { node: node.id, side: nearestSide(box, point) };
  }
  return undefined;
}

/** a new arrow as one element; returns its id */
export function addArrow(store: BoardStore, from: ArrowEnd, to: ArrowEnd): string {
  const id = newId("e");
  store.gesture((tx) =>
    tx.create(id, {
      kind: "edge",
      source: from.node,
      target: to.node,
      sourceHandle: from.side,
      targetHandle: to.side,
    }),
  );
  return id;
}

/** one end of an arrow moves to another node or side: node and handle together, in one gesture */
export function reconnectArrow(store: BoardStore, id: string, end: "source" | "target", to: ArrowEnd): void {
  const patch: Partial<EdgeAttrs> =
    end === "source" ? { source: to.node, sourceHandle: to.side } : { target: to.node, targetHandle: to.side };
  store.gesture((tx) => tx.update(id, patch));
}

// ── images ───────────────────────────────────────────────────────────────────

/** the board takes the image files the product serves from a repository, up to the size it serves */
export const IMAGE_LIMIT_BYTES = REPO_IMAGE_MAX_BYTES;
/** "AVIF, GIF, JPEG, …": the served types by name, for the UI */
export const IMAGE_TYPE_NAMES = [
  ...new Set(Object.values(REPO_IMAGE_TYPES).map((type) => type.replace(/^image\//, "").replace(/\+xml$/, ""))),
]
  .map((name) => (name === "webp" ? "WebP" : name.toUpperCase()))
  .sort((a, b) => a.localeCompare(b))
  .join(", ");
/** the `accept` of a file input */
export const IMAGE_ACCEPT = Object.keys(REPO_IMAGE_TYPES).join(",");
export const ASSET_FOLDER = "assets";

/** 765 B, 11.9 KiB, 10 MiB: binary units, like the limit */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, "KiB"] : [bytes / 1024 / 1024, "MiB"];
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}

export type ImageCheck = { ok: true; extension: string; type: string } | { ok: false; reason: string };

/** what of a File the check reads */
export interface ImageFile {
  name: string;
  type: string;
  size: number;
}

/**
 * Whether the board takes the file as an image. The file's extension decides, like on the Live
 * Host's image route; a file without one (a pasted bitmap) goes by its MIME type.
 */
export function checkImage(file: ImageFile): ImageCheck {
  const name = file.name === "" ? "The pasted file" : file.name;
  const dot = file.name.lastIndexOf(".");
  const written = dot > 0 ? file.name.slice(dot).toLowerCase() : "";
  const extension =
    repoImageType(written) !== undefined
      ? written
      : written === ""
        ? Object.keys(REPO_IMAGE_TYPES).find((one) => REPO_IMAGE_TYPES[one] === file.type.toLowerCase())
        : undefined;
  if (extension === undefined) {
    return { ok: false, reason: `${name} was not added: the board takes images only (${IMAGE_TYPE_NAMES}).` };
  }
  if (file.size === 0) return { ok: false, reason: `${name} was not added: the file is empty.` };
  if (file.size > IMAGE_LIMIT_BYTES) {
    // rounded up: a file just over the limit must not read "10 MiB, up to 10 MiB"
    const size = `${Math.ceil((file.size / 1024 / 1024) * 10) / 10} MiB`;
    return {
      ok: false,
      reason: `${name} was not added: it has ${size}, an image may have up to ${formatBytes(IMAGE_LIMIT_BYTES)}.`,
    };
  }
  return { ok: true, extension, type: REPO_IMAGE_TYPES[extension] ?? file.type };
}

/**
 * The repository path a new image gets: `assets/<name>`, the name reduced to letters, digits,
 * dot, dash and underscore, and numbered when the path is taken (an image never replaces a file).
 */
export function assetPath(name: string, extension: string, taken: (path: string) => boolean): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  const stem =
    (dot > 0 ? base.slice(0, dot) : base)
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .toLowerCase() || "image";
  for (let count = 1; ; count++) {
    const path = `${ASSET_FOLDER}/${stem}${count === 1 ? "" : `-${count}`}${extension}`;
    if (!taken(path)) return path;
  }
}

/** the largest box a new image node gets; a larger picture is scaled down into it */
export const IMAGE_BOX: Size = { width: 480, height: 360 };

/** the size of a new image node: the picture's own proportions, never larger than IMAGE_BOX nor than the picture */
export function fitImage(natural: Size | undefined, box: Size = IMAGE_BOX): Size {
  // a picture without a size of its own (an SVG with a viewBox only)
  if (!natural || !(natural.width > 0) || !(natural.height > 0)) return { width: 320, height: 240 };
  const scale = Math.min(1, box.width / natural.width, box.height / natural.height);
  return {
    width: Math.max(24, Math.round(natural.width * scale)),
    height: Math.max(24, Math.round(natural.height * scale)),
  };
}

// ── notes ────────────────────────────────────────────────────────────────────

/** a note's ground, by the name the board file holds; "plain" is the card and is not written */
export const NOTE_COLORS = ["plain", "amber", "green", "blue", "red"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

/**
 * `color` is an attribute of a text node that board-doc.ts does not name: the projection and the
 * codec pass every attribute through, so it travels in the board file like the others.
 */
type NoteAttrs = NodeAttrs & { color?: unknown };

export const noteColor = (attrs: NodeAttrs): NoteColor =>
  NOTE_COLORS.find((color) => color === (attrs as NoteAttrs).color) ?? "plain";

export function writeNoteColor(store: BoardStore, id: string, color: NoteColor): void {
  const patch: Partial<NoteAttrs> = { color: color === "plain" ? undefined : color };
  store.gesture((tx) => tx.update(id, patch));
}

// ── what changed in a text ───────────────────────────────────────────────────

export interface LineChange {
  /** indices of the lines of `after` that `before` did not have */
  changed: number[];
  /** how many lines of `before` are gone */
  removed: number;
}

/**
 * Which lines of a file are new after a change, by content and not by position: one line per
 * element in the board file, so a moved node is exactly one line here.
 */
export function changedLines(before: string, after: string): LineChange {
  const left = new Map<string, number>();
  const beforeLines = before.split("\n");
  for (const line of beforeLines) left.set(line, (left.get(line) ?? 0) + 1);
  const changed: number[] = [];
  let kept = 0;
  after.split("\n").forEach((line, index) => {
    const count = left.get(line) ?? 0;
    if (count > 0) {
      left.set(line, count - 1);
      kept++;
    } else changed.push(index);
  });
  return { changed, removed: beforeLines.length - kept };
}
