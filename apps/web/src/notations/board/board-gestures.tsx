/**
 * The board's gestures that belong to no single node, and what the toolbar's add actions share
 * with them:
 *
 * - while a node is dragged, the group that would take it shows so (the drop itself, with the
 *   membership, is one write of board-flow.tsx: board-actions.ts writeDrop);
 * - an arrow drawn from a handle and released on a node, not on one of its handles, ends at that
 *   node's nearest side (React Flow itself connects only within reach of a handle);
 * - an image file pasted or dropped onto the board becomes a repository file and an image node;
 * - the board zoom reaches the stylesheet, so that arrow heads, labels and handles keep a size on
 *   screen one can read and grab when the board is zoomed out.
 *
 * Everything listens: nothing here is in the way of a node's or an editor's own events. Each
 * write is one gesture of the board store at the END of the user's gesture.
 */
import { useReactFlow, useStore, useStoreApi } from "@xyflow/react";
import { ImagePlus } from "lucide-react";
import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import {
  addArrow,
  addNode,
  arrowEndAt,
  assetPath,
  checkImage,
  fitImage,
  formatBytes,
  groupAround,
  IMAGE_LIMIT_BYTES,
  IMAGE_TYPE_NAMES,
  type Point,
  sideOf,
  type Size,
} from "./board-actions.ts";
import { type BoardContextValue, useBoardContext } from "./board-context.tsx";
import type { BoardFlowEdge, BoardFlowNode } from "./board-flow.tsx";

// ── notices: what the board tells the person about a file it took or refused ──

export interface Notice {
  id: number;
  kind: "refused" | "added";
  text: string;
}

/** a refusal stays long enough to be read, and can be closed; a confirmation goes sooner */
const NOTICE_MS = { refused: 15_000, added: 6_000 } as const;

function createNotices() {
  let list: readonly Notice[] = [];
  let next = 1;
  const listeners = new Set<() => void>();
  const set = (to: readonly Notice[]): void => {
    list = to;
    for (const listener of [...listeners]) listener();
  };
  const dismiss = (id: number): void => set(list.filter((notice) => notice.id !== id));
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSnapshot: (): readonly Notice[] => list,
    push(kind: Notice["kind"], text: string): void {
      const id = next++;
      // the last three: a folder of files dropped at once must not bury the board
      set([...list, { id, kind, text }].slice(-3));
      setTimeout(() => dismiss(id), NOTICE_MS[kind]);
    },
    dismiss,
  };
}

/** one board per page: the toolbar shows them */
export const notices = createNotices();

// ── which groups would take the node that is being dragged ───────────────────

let receiving: ReadonlySet<string> = new Set();
const receivingListeners = new Set<() => void>();
const subscribeReceiving = (listener: () => void): (() => void) => {
  receivingListeners.add(listener);
  return () => void receivingListeners.delete(listener);
};
function setReceiving(next: ReadonlySet<string>): void {
  if (next.size === receiving.size && [...next].every((id) => receiving.has(id))) return;
  receiving = next;
  for (const listener of [...receivingListeners]) listener();
}

/** true while a node is dragged that would join the group `id` if it were dropped now */
export function useReceiving(id: string): boolean {
  return useSyncExternalStore(subscribeReceiving, () => receiving.has(id));
}

// ── a text note that opens in its editor the moment it is added ──────────────

let editOnMount: string | null = null;
/** the toolbar's "Text": the new note is to be typed into at once */
export const requestEdit = (nodeId: string): void => void (editOnMount = nodeId);
/** a text node asks once, when it mounts */
export function takeEditRequest(nodeId: string): boolean {
  if (editOnMount !== nodeId) return false;
  editOnMount = null;
  return true;
}

// ── images ───────────────────────────────────────────────────────────────────

/** the picture's own size; undefined when it has none (an SVG without one), "unreadable" when it is no picture */
async function naturalSize(blob: Blob): Promise<Size | undefined | "unreadable"> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image.naturalWidth > 0 && image.naturalHeight > 0
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : undefined;
  } catch {
    return "unreadable";
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Image files become files of the repository (the hub's assets, `assets/<name>`) and one image
 * node each, which holds the path and nothing else. A file the board does not take is named in a
 * notice with the reason. Returns the ids of the new nodes.
 */
export async function importImages(
  board: Pick<BoardContextValue, "hub" | "store">,
  files: readonly File[],
  centre: Point,
): Promise<string[]> {
  const added: string[] = [];
  if (!board.hub.uploads) {
    if (files.length > 0)
      notices.push("refused", "This board cannot store a new image yet. Add it to the repository first.");
    return added;
  }
  for (const file of files) {
    const name = file.name === "" ? "The pasted file" : file.name;
    const check = checkImage(file);
    if (!check.ok) {
      notices.push("refused", check.reason);
      continue;
    }
    // the same bytes under the type its extension stands for: what the image route would answer with
    const blob = file.slice(0, file.size, check.type);
    const size = await naturalSize(blob);
    if (size === "unreadable") {
      notices.push("refused", `${name} was not added: it could not be read as an image.`);
      continue;
    }
    const path = assetPath(file.name, check.extension, (taken) => board.hub.asset(taken) !== undefined);
    board.hub.addAsset(path, blob);
    const offset = added.length * 28;
    added.push(
      addNode(
        board.store,
        { type: "image", file: path, ...fitImage(size) },
        { x: centre.x + offset, y: centre.y + offset },
      ),
    );
    notices.push("added", `${path} is a file of the repository now (${formatBytes(blob.size)}).`);
  }
  return added;
}

// ── the board's centre, and selecting what was just added ────────────────────

let lastPlace: { x: number; y: number; count: number } | null = null;

/**
 * The middle of what the board shows, in board coordinates: where a new node goes that has no
 * place of its own (the toolbar, a paste). A second one added from the same view lands a step
 * down and to the right, so it does not hide the first.
 */
function nextPlace(flow: { screenToFlowPosition(point: Point): Point }, host: HTMLElement | null | undefined): Point {
  const rect = host?.getBoundingClientRect();
  const middle = flow.screenToFlowPosition(
    rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 },
  );
  const again = lastPlace !== null && Math.abs(lastPlace.x - middle.x) < 1 && Math.abs(lastPlace.y - middle.y) < 1;
  lastPlace = { ...middle, count: again && lastPlace ? lastPlace.count + 1 : 0 };
  const step = (lastPlace.count % 8) * 28;
  return { x: middle.x + step, y: middle.y + step };
}

/** what the add actions need of React Flow: where a new node goes, and a way to select it */
export function useBoardPlacement(): { centre(): Point; select(nodeId: string): void } {
  const flow = useReactFlow<BoardFlowNode, BoardFlowEdge>();
  const flowStore = useStoreApi<BoardFlowNode, BoardFlowEdge>();
  return {
    centre: () => nextPlace(flow, flowStore.getState().domNode),
    select(nodeId) {
      // the node reaches React Flow's store a commit or two after the board document has it
      const now = (): boolean => {
        const state = flowStore.getState();
        if (!state.nodeLookup.has(nodeId)) return false;
        // like a click on it: this node selected, every other node and arrow not
        state.addSelectedNodes([nodeId]);
        return true;
      };
      if (now()) return;
      const stop = flowStore.subscribe(() => {
        if (now()) stop();
      });
      setTimeout(stop, 2000);
    },
  };
}

// ── the board zoom for CSS ───────────────────────────────────────────────────

/**
 * The board zoom as `--board-zoom` on ONE element (the returned ref), written inside the pan /
 * zoom tick and with no React render: what is styled against it keeps a least size on screen.
 * On a small subtree only: a custom property restyles everything below the element it is set on.
 */
export function useZoomVar<T extends HTMLElement>(): RefObject<T | null> {
  const element = useRef<T>(null);
  const { subscribeViewport } = useBoardContext();
  const flowStore = useStoreApi();
  useEffect(() => {
    let applied = Number.NaN;
    const apply = (zoom: number): void => {
      if (zoom === applied || !element.current) return;
      applied = zoom;
      element.current.style.setProperty("--board-zoom", String(zoom));
    };
    apply(flowStore.getState().transform[2]);
    return subscribeViewport((viewport) => apply(viewport.zoom));
  }, [flowStore, subscribeViewport]);
  return element;
}

/** how far out the board is, in three steps: what a handle's size on screen is styled against */
const viewOf = (zoom: number): string => (zoom >= 0.75 ? "near" : zoom >= 0.4 ? "mid" : "far");

// ── the component ────────────────────────────────────────────────────────────

/** an input, a text field or an armed editor under the event: a paste there is theirs */
const takesText = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest("input, textarea, [contenteditable], .nokey") !== null;
const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") === true;

/** how near (in screen px) to a node an arrow's loose end still lands on it */
const ARROW_REACH_PX = 12;
/** the edge layers that scale their chrome against the board zoom (board.css, --board-zoom) */
const ZOOM_AWARE = ".react-flow__edges, .react-flow__edgelabel-renderer";

/** Renders nothing but the hint while a file is dragged over the page. Mounted once, inside <ReactFlow>. */
export function BoardGestures() {
  const board = useBoardContext();
  const { hub, store, subscribeViewport, inputScope } = board;
  const flow = useReactFlow<BoardFlowNode, BoardFlowEdge>();
  const flowStore = useStoreApi<BoardFlowNode, BoardFlowEdge>();
  const host = useStore((state) => state.domNode);
  const [dropping, setDropping] = useState(false);

  // groups: who would take the dragged node. Who took it is written with the drop itself, in one
  // gesture (board-flow.tsx: onNodeDragStop, board-actions.ts: writeDrop)
  useEffect(() => {
    let dragged = false;
    const stop = flowStore.subscribe((state, previous) => {
      if (state.nodes === previous.nodes) return;
      const now = new Set<string>();
      for (const node of state.nodes) if (node.dragging) now.add(node.id);
      if (now.size === 0 && !dragged) return;
      dragged = now.size > 0;
      if (!dragged) {
        setReceiving(new Set());
        return;
      }
      const view = store.getSnapshot();
      const takers = new Set<string>();
      for (const id of now) {
        const node = state.nodeLookup.get(id);
        if (!node || node.type === "group") continue;
        const { x, y } = node.internals.positionAbsolute;
        const centre = { x: x + (node.measured.width ?? 0) / 2, y: y + (node.measured.height ?? 0) / 2 };
        const group = groupAround(view, centre, node.parentId);
        if (group !== undefined && group !== node.parentId) takers.add(group);
      }
      setReceiving(takers);
    });
    return () => {
      stop();
      setReceiving(new Set());
    };
  }, [flowStore, store]);

  // arrows: a connection released on a node, away from its handles
  useEffect(
    () =>
      flowStore.subscribe((state, previous) => {
        const was = previous.connection;
        if (state.connection === was || !was.inProgress || state.connection.inProgress) return;
        // within reach of a handle React Flow decided itself: it connected (onConnect) or refused
        if (was.toHandle) return;
        const [x, y, zoom] = state.transform;
        // the pointer is kept in the board element's px
        const point = { x: (was.pointer.x - x) / zoom, y: (was.pointer.y - y) / zoom };
        const from = sideOf(was.fromHandle.id);
        const to = arrowEndAt(store.getSnapshot(), point, ARROW_REACH_PX / zoom, was.fromNode.id);
        if (from && to) addArrow(store, { node: was.fromNode.id, side: from }, to);
      }),
    [flowStore, store],
  );

  // The board zoom for the stylesheet, with no React render per zoom tick:
  // - as --board-zoom on the two edge layers, so arrow heads and labels keep a least size on
  //   screen. Not on the board's root: a custom property restyles everything below its element,
  //   and that would be every node and every editor on each tick.
  // - as data-board-view on the root, in three steps, for the handles: an attribute restyles only
  //   what a selector names, and it changes only when a step is crossed.
  useEffect(() => {
    if (!host) return;
    let applied = Number.NaN;
    const apply = (zoom: number): void => {
      if (zoom === applied) return;
      applied = zoom;
      for (const layer of host.querySelectorAll<HTMLElement>(ZOOM_AWARE)) {
        layer.style.setProperty("--board-zoom", String(zoom));
      }
      if (host.dataset.boardView !== viewOf(zoom)) host.dataset.boardView = viewOf(zoom);
    };
    apply(flowStore.getState().transform[2]);
    const stop = subscribeViewport((viewport) => apply(viewport.zoom));
    return () => {
      stop();
      delete host.dataset.boardView;
    };
  }, [host, flowStore, subscribeViewport]);

  // images: paste and drop
  useEffect(() => {
    const centre = (): Point => nextPlace(flow, host);
    // scope "board": what is aimed at a control beside the board is the page's
    const ours = (event: Event): boolean =>
      inputScope === "page" || (event.target instanceof Node && host?.contains(event.target) === true);
    const onPaste = (event: ClipboardEvent): void => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0 || takesText(event.target) || !ours(event)) return;
      event.preventDefault();
      void importImages({ hub, store }, files, centre());
    };
    let idle: ReturnType<typeof setTimeout> | undefined;
    const onDragOver = (event: DragEvent): void => {
      if (!carriesFiles(event) || !ours(event)) return;
      // without this the browser would leave the page for the dropped file
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDropping(true);
      // dragleave fires for every element the pointer crosses: the hint goes when dragover stops coming
      clearTimeout(idle);
      idle = setTimeout(() => setDropping(false), 200);
    };
    const onDrop = (event: DragEvent): void => {
      if (!carriesFiles(event) || !ours(event)) return;
      event.preventDefault();
      clearTimeout(idle);
      setDropping(false);
      const files = [...(event.dataTransfer?.files ?? [])];
      const onBoard = event.target instanceof Node && host?.contains(event.target) === true;
      const at = onBoard ? flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }) : centre();
      void importImages({ hub, store }, files, at);
    };
    document.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      clearTimeout(idle);
      document.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [flow, host, hub, store, inputScope]);

  if (!host || !dropping) return null;
  return createPortal(
    <div className="board-drop-hint" role="status">
      <div className="board-drop-hint__card">
        <ImagePlus aria-hidden />
        <strong>Drop to add an image</strong>
        <span>
          {IMAGE_TYPE_NAMES}, up to {formatBytes(IMAGE_LIMIT_BYTES)}. It becomes a file of the repository.
        </span>
      </div>
    </div>,
    host,
  );
}
