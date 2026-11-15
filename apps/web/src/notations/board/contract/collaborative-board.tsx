/**
 * The board as a MODULE a host mounts. `createCollaborativeBoard()` gives the React Flow board
 * under the contract every Miragon modeler implements (@miragon/modeler-api: text in, text out, a
 * change event, view state), so a host that holds the board file as text drives it like any other
 * modeler: a VS Code custom editor, the suite's web app, designIQ's text lane. The laws are the
 * contract's (L1 to L7); module/kit-main.ts runs the contract's own conformance kit against this.
 *
 * What the host brings: the files a board links, with their live text (`hub`). What the board
 * owns: its document, its history and its view.
 *
 * Not a package of its own yet. The boundary is this file's exports; it loads nothing of the
 * measuring bench and nothing of the SPA's shell.
 */
import { reconcileSnapshot } from "@designiq/live-client/structured";
import { parseBoardText } from "@designiq/notations/board";
import {
  type CollaborativeModeler,
  type CollaborativeModelerOptions,
  type ElementBounds,
  type ElementInfo,
  type ElementsSurface,
  type ImportResult,
  MODELER_API_VERSION,
} from "@miragon/modeler-api";
import { getViewportForBounds, type ReactFlowInstance } from "@xyflow/react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";

import { Board } from "../board.tsx";
import { absoluteBoxes } from "../board-actions.ts";
import { type BoardRuntime, createBoardRuntime, FIT_PADDING } from "../board-context.tsx";
import { BOARD_LOCAL, type BoardStore, boardText, createBoardStore, type Side } from "../board-doc.ts";
import type { BoardFlowEdge, BoardFlowNode } from "../board-flow.tsx";
import type { BoardFiles } from "../files.ts";
import { ProductOverlaySurface } from "../overlay-surface.tsx";
import type { BoardOptions } from "../types.ts";
import type { Box, Viewport } from "../types.ts";

/** the notation id of a board file */
export const BOARD_NOTATION = "board";
/** the board's zoom range (board.tsx) */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** an import waits this long for a canvas that was attached and never appeared, then resolves all the same */
const MOUNT_TIMEOUT_MS = 10_000;
/** the origin of an import's write: no change event, no history */
const IMPORT = Symbol("board-import");

/** an embedded board: overlay with the product's editors, the final arm rules, the view the module sets */
const PARAMS: BoardOptions = {
  strategy: "overlay",
  viewport: { x: 0, y: 0, zoom: 1 },
  arm: null,
  armzoom: null,
  armedzoom: null,
  armreturn: null,
  armmotion: null,
};

export interface BoardModelerOptions extends CollaborativeModelerOptions {
  /** the files the board links (models, images) and their live text: the host's */
  hub: BoardFiles;
  /**
   * Whose a key, a paste and a dropped file are (BoardParts.inputScope). Default "board": only
   * what is aimed at the board, the contract's "keys stay on the canvas". "page" for a host whose
   * page is the board and nothing else.
   */
  inputScope?: "board" | "page";
}

/** beyond the contract: what a host's own chrome or a test drives */
export interface BoardCommands {
  readonly store: BoardStore;
  readonly runtime: BoardRuntime;
  /** the board's history: every gesture made here since the last import */
  undo(): void;
  redo(): void;
  /** resolves once the canvas exists in the host it was attached to */
  readonly mounted: Promise<void>;
}

export interface CollaborativeBoard extends CollaborativeModeler {
  /** nodes and arrows by the id they have in the board file, with their boxes */
  readonly elements: ElementsSurface & { bounds(id: string): ElementBounds | undefined };
  contentBounds(): ElementBounds | undefined;
  readonly board: BoardCommands;
}

/** the first line of a note's Markdown without its marks: what a host lists the element under */
function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split("\n")
    .map((one) => one.replace(/^[#>*\-\s]+/, "").trim())
    .find((one) => one !== "");
  return line === undefined || line === "" ? undefined : line;
}

/** where an arrow leaves or reaches a node: the middle of the named side, the node's middle without one */
function endPoint(box: Box, side: Side | undefined): { x: number; y: number } {
  const [midX, midY] = [box.x + box.width / 2, box.y + box.height / 2];
  if (side === "top") return { x: midX, y: box.y };
  if (side === "bottom") return { x: midX, y: box.y + box.height };
  if (side === "left") return { x: box.x, y: midY };
  if (side === "right") return { x: box.x + box.width, y: midY };
  return { x: midX, y: midY };
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** a view a host hands in: three finite numbers, the zoom inside the board's range; anything else is ignored */
function asViewport(state: unknown): Viewport | undefined {
  if (state === null || typeof state !== "object") return undefined;
  const { x, y, zoom } = state as Record<string, unknown>;
  if (!isNumber(x) || !isNumber(y) || !isNumber(zoom) || zoom <= 0) return undefined;
  return { x, y, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) };
}

export function createCollaborativeBoard(options: BoardModelerOptions): CollaborativeBoard {
  const doc = new Y.Doc();
  const store = createBoardStore(doc);
  let flow: ReactFlowInstance<BoardFlowNode, BoardFlowEdge> | null = null;
  /** the view asked for last, while React Flow has none to ask (before the canvas exists, after it went) */
  let view: Viewport = { x: 0, y: 0, zoom: 1 };
  let host: Element | null = null;
  let element: HTMLDivElement | null = null;
  let root: Root | null = null;
  let destroyed = false;
  let settleMounted!: () => void;
  const mounted = new Promise<void>((resolve) => {
    settleMounted = resolve;
  });

  // ── the selection: React Flow's, mirrored here so that a host reads it at once ──
  let selected: string[] = [];
  const selectionListeners = new Set<(ids: string[]) => void>();
  const onCanvas = (): Set<string> => {
    const snapshot = store.getSnapshot();
    return new Set([...snapshot.nodes.map((node) => node.id), ...snapshot.edges.map((edge) => edge.id)]);
  };
  const setSelection = (ids: readonly string[]): void => {
    const known = onCanvas();
    const next = ids.filter((id) => known.has(id));
    if (next.length === selected.length && next.every((id, index) => id === selected[index])) return;
    selected = next;
    for (const listener of [...selectionListeners]) {
      // a listener may destroy the board
      if (destroyed) return;
      listener([...next]);
    }
  };

  const runtime = createBoardRuntime(PARAMS, {
    store,
    hub: options.hub,
    surfaces: { overlay: ProductOverlaySurface },
    // a host that owns the document's history (VS Code) passes false, and the keys reach it
    undoRedoKeys: options.undoRedoKeys !== false,
    ...(options.inputScope ? { inputScope: options.inputScope } : {}),
    onFlow(instance) {
      if (!instance) {
        if (flow) view = flow.getViewport();
        flow = null;
        return;
      }
      flow = instance;
      // what an import's fit or the host asked for before the canvas existed
      void instance.setViewport(view);
      settleMounted();
    },
    onSelection: (ids) => void (destroyed || setSelection(ids)),
  });

  // ── the document's change event (L3): this board's own gestures and its history, nothing else ──
  const listeners = new Set<() => void>();
  let lastText = boardText(doc);
  const onTransaction = (transaction: Y.Transaction): void => {
    if (destroyed || (transaction.origin !== BOARD_LOCAL && transaction.origin !== store.undo)) return;
    // a gesture writes its attributes changed or not (board-doc.ts): one that left the text as it was is no change
    const text = boardText(doc);
    if (text === lastText) return;
    lastText = text;
    for (const listener of [...listeners]) {
      // a listener may destroy the board
      if (destroyed) return;
      listener();
    }
  };
  doc.on("afterTransaction", onTransaction);

  // ── the view (L5): React Flow's viewport, never part of the document ──
  const contentBounds = (): ElementBounds | undefined => {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const box of absoluteBoxes(store.getSnapshot()).values()) {
      left = Math.min(left, box.x);
      top = Math.min(top, box.y);
      right = Math.max(right, box.x + box.width);
      bottom = Math.max(bottom, box.y + box.height);
    }
    return left <= right && top <= bottom ? { x: left, y: top, width: right - left, height: bottom - top } : undefined;
  };
  /** the content in the host's box, from the document alone: the same text in the same box gives the same view */
  const fitted = (): Viewport => {
    const bounds = contentBounds();
    const width = host?.clientWidth ?? 0;
    const height = host?.clientHeight ?? 0;
    if (!bounds || width === 0 || height === 0) return { x: 0, y: 0, zoom: 1 };
    const insets = options.freeArea?.insets?.() ?? { top: 0, right: 0, bottom: 0, left: 0 };
    const free = { width: width - insets.left - insets.right, height: height - insets.top - insets.bottom };
    if (free.width <= 0 || free.height <= 0) return { x: 0, y: 0, zoom: 1 };
    const inFree = getViewportForBounds(bounds, free.width, free.height, MIN_ZOOM, MAX_ZOOM, FIT_PADDING);
    return { x: inFree.x + insets.left, y: inFree.y + insets.top, zoom: inFree.zoom };
  };
  const setView = (next: Viewport): void => {
    view = next;
    // without a duration React Flow applies it before this call returns
    if (flow) void flow.setViewport(next);
  };
  /** React committed what the document holds now */
  const rendered = async (): Promise<void> => {
    if (host && !flow) {
      await Promise.race([mounted, new Promise<void>((resolve) => setTimeout(resolve, MOUNT_TIMEOUT_MS))]);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  // ── imports: one after another in call order, and never inside a running user action ──
  // An import starts in a microtask of its own: one called from a change or selection listener
  // (the host echoing a peer's text while this board's own command still runs) waits until that
  // command returned, and one called behind it waits for it (contract 1.6, recommended)
  let imports: Promise<unknown> = Promise.resolve();
  const importNow = (text: string): Promise<ImportResult> => {
    if (destroyed) return Promise.reject(new Error("the board was destroyed"));
    const parsed = parseBoardText(text);
    // L7: refused before anything is touched
    if (!parsed.ok) return Promise.reject(new Error(`not a board: ${parsed.reason}`));
    // L1: silent. Only what differs is written, so a node that stays keeps its DOM and its editor
    reconcileSnapshot(doc, parsed.snapshot, IMPORT);
    // L4: the history belonged to the document the import replaced
    store.undo.clear();
    lastText = boardText(doc);
    if (options.fitOnImport !== false) setView(fitted());
    return rendered().then(() => {
      if (destroyed) throw new Error("the board was destroyed during the import");
      return { warnings: [] };
    });
  };

  // ── the elements (optional surface): nodes and arrows under the ids of the board file ──
  const boundsOf = (id: string): ElementBounds | undefined => {
    const snapshot = store.getSnapshot();
    const boxes = absoluteBoxes(snapshot);
    const node = boxes.get(id);
    if (node) return { x: node.x, y: node.y, width: node.width, height: node.height };
    const arrow = snapshot.edges.find((edge) => edge.id === id);
    const [from, to] = [boxes.get(arrow?.attrs.source ?? ""), boxes.get(arrow?.attrs.target ?? "")];
    if (!arrow || !from || !to) return undefined;
    // the box around its two ends: both lie on their nodes, so the content box holds it
    const [a, b] = [endPoint(from, arrow.attrs.sourceHandle), endPoint(to, arrow.attrs.targetHandle)];
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  };
  /** the element in the host's box: left alone when it is in view, centred when it fits, else fitted */
  const bringIntoView = (box: ElementBounds): void => {
    const width = host?.clientWidth ?? 0;
    const height = host?.clientHeight ?? 0;
    if (width === 0 || height === 0) return;
    const now = flow ? flow.getViewport() : view;
    const shown = { x: -now.x / now.zoom, y: -now.y / now.zoom, width: width / now.zoom, height: height / now.zoom };
    const inside =
      box.x >= shown.x &&
      box.y >= shown.y &&
      box.x + box.width <= shown.x + shown.width &&
      box.y + box.height <= shown.y + shown.height;
    if (inside) return;
    if (box.width <= shown.width && box.height <= shown.height) {
      setView({
        x: width / 2 - (box.x + box.width / 2) * now.zoom,
        y: height / 2 - (box.y + box.height / 2) * now.zoom,
        zoom: now.zoom,
      });
    } else setView(getViewportForBounds(box, width, height, MIN_ZOOM, MAX_ZOOM, FIT_PADDING));
  };
  const elements: CollaborativeBoard["elements"] = {
    list(): ElementInfo[] {
      const snapshot = store.getSnapshot();
      const named = (id: string, name: string | undefined): ElementInfo => (name === undefined ? { id } : { id, name });
      return [
        ...snapshot.nodes.map((node) =>
          named(
            node.id,
            node.attrs.type === "text" || node.attrs.type === "group" ? firstLine(node.attrs.text) : node.attrs.file,
          ),
        ),
        ...snapshot.edges.map((edge) => named(edge.id, firstLine(edge.attrs.label))),
      ];
    },
    reveal(id) {
      if (destroyed || !onCanvas().has(id)) return false;
      const select = <T extends { id: string; selected?: boolean }>(items: T[]): T[] =>
        items.map((item) =>
          Boolean(item.selected) === (item.id === id) ? item : { ...item, selected: item.id === id },
        );
      if (flow) {
        // through React Flow's own change path: the board's state follows as after a click
        void flow.setNodes(select);
        void flow.setEdges(select);
        const box = boundsOf(id);
        if (box) bringIntoView(box);
      }
      // at once, not when React Flow reports it: a host reads selection() right after
      setSelection([id]);
      return true;
    },
    selection() {
      const known = onCanvas();
      return selected.filter((id) => known.has(id));
    },
    onSelection(listener) {
      selectionListeners.add(listener);
      return () => void selectionListeners.delete(listener);
    },
    bounds: boundsOf,
  };

  return {
    meta: { notation: BOARD_NOTATION, apiVersion: MODELER_API_VERSION, editable: true },

    attachTo(target) {
      if (destroyed || root) return;
      host = target;
      element = document.createElement("div");
      element.className = "board-module";
      element.style.cssText = "width:100%;height:100%";
      target.appendChild(element);
      root = createRoot(element);
      root.render(<Board runtime={runtime} />);
    },

    importText(text): Promise<ImportResult> {
      const result = imports.then(() => importNow(text));
      imports = result.catch(() => undefined);
      return result;
    },

    exportText: () => boardText(doc),

    onContentChanged(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    getViewState: () => (flow ? flow.getViewport() : { ...view }),
    setViewState(state) {
      const next = asViewport(state);
      if (next && !destroyed) setView(next);
    },

    contentBounds,
    elements,

    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      selectionListeners.clear();
      doc.off("afterTransaction", onTransaction);
      if (flow) view = flow.getViewport();
      const [mountedRoot, mountedElement] = [root, element];
      root = null;
      // not inside React's own work: a host may call this from a change listener that a React
      // event handler is still running
      queueMicrotask(() => {
        mountedRoot?.unmount();
        mountedElement?.remove();
        store.destroy();
        doc.destroy();
      });
    },

    board: {
      store,
      runtime,
      undo: () => void store.undo.undo(),
      redo: () => void store.undo.redo(),
      mounted,
    },
  };
}
