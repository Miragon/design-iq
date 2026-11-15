/**
 * What every part of the board shares: the hub with the model files, the board store, which node
 * is armed, the registry of the strategy surfaces, the counters and the log. The runtime is
 * created ONCE, outside React (a store made in a component is dead after an unmount, sync.md 4.4);
 * the provider adds what needs React Flow's store.
 */
import { type FitViewOptions, type ReactFlowInstance, type ReactFlowState, useStore, useStoreApi } from "@xyflow/react";
import {
  Component,
  type ComponentType,
  createContext,
  type LazyExoticComponent,
  type ReactNode,
  Suspense,
  useContext,
  useLayoutEffect,
  useMemo,
} from "react";

import { resolveRules } from "./arm-rules.ts";
import { type ArmBy, type BoardArming, createBoardArming } from "./board-arming.ts";
import type { BoardStore } from "./board-doc.ts";
import type { BoardFlowEdge, BoardFlowNode } from "./board-flow.tsx";
import type { BoardFiles } from "./files.ts";
import type { BoardPresence } from "./presence.ts";
import type { Via } from "./product-mount.ts";
import type { SurfaceApi, SurfaceProps } from "./surface.ts";
import type { BoardOptions } from "./types.ts";
import type { BoardCounters, Strategy, Viewport } from "./types.ts";

/**
 * The room a fit leaves around the board where nobody says otherwise: the toolbar's band at the
 * top (one row of it; board.css), a margin on the other sides.
 */
/** React Flow's padding of a fit: a share of the box, or a length per side */
export type Padding = NonNullable<FitViewOptions["padding"]>;

export const FIT_PADDING: Padding = { top: "88px", right: "24px", bottom: "24px", left: "24px" };

/** a strategy's surface: what embeds a model's editor in a node (surface.ts) */
export type SurfaceComponent = ComponentType<SurfaceProps> | LazyExoticComponent<ComponentType<SurfaceProps>>;

/** the lines of a board's log and the function that adds one */
export interface BoardLog {
  readonly lines: string[];
  log(line: string): void;
}
export function createBoardLog(): BoardLog {
  const lines: string[] = [];
  return {
    lines,
    log(line) {
      lines.push(line);
      console.debug("[board]", line);
    },
  };
}

/**
 * What the measuring bench adds to a board and a host does not have: the spike page's choice of a
 * sample board and a strategy, its Files panel, and `window.__boardSpike` for the scripts.
 */
export interface BoardBench {
  /** in front of the toolbar's own controls */
  ToolbarLead?: ComponentType;
  /** beside the canvas */
  SidePanel?: ComponentType;
  /** once React Flow's instance is there; returns the teardown */
  install?(board: BoardContextValue, flow: ReactFlowInstance<BoardFlowNode, BoardFlowEdge>): () => void;
}

/** everything a board is made of comes from whoever mounts it: a host, the contract module, the spike page */
export interface BoardParts {
  /** the board document */
  store: BoardStore;
  /** the files the board links and their live text */
  hub: BoardFiles;
  /** strategy id to the surface that embeds a model's editor: a host has the one it ships, the bench all six */
  surfaces: Partial<Record<Strategy, SurfaceComponent>>;
  /** node id to its strategy, where the board fixes it (the bench's compare board); else `params.strategy` */
  strategies?: Readonly<Record<string, Strategy>>;
  /** the log, where it has to exist before the runtime (a hub that logs) */
  log?: BoardLog;
  /** the spike page's extras; absent: the board is embedded in a host */
  bench?: BoardBench;
  /**
   * Whose a key, a paste and a dropped file are. "board" (the default): the board's only when they
   * are aimed at it (the focus inside its canvas, the pointer over it), so a host's own controls
   * beside it keep theirs: the contract's "keys stay on the canvas". "page": the board is the
   * whole page and takes them wherever they go, as React Flow does by itself. The bench uses it
   * for the strategies whose armed editor stays inside its node: there a press on a part of the
   * editor that cannot take the focus must leave the focus on <body>, which a focusable canvas
   * around it would catch.
   */
  inputScope?: "board" | "page";
  /** Control or Command + Z, Shift + Z and Y on the focused canvas undo and redo; false where the host owns the history */
  undoRedoKeys?: boolean;
  /** the room a fit leaves around the board (React Flow's padding); default: FIT_PADDING, clear of the toolbar */
  fitPadding?: Padding;
  /** live presence of the people who have this board open (presence.ts); absent: the host has none */
  presence?: BoardPresence;
  /** React Flow's instance once its viewport exists, null when the board unmounts */
  onFlow?(flow: ReactFlowInstance<BoardFlowNode, BoardFlowEdge> | null): void;
  /** the selected nodes and stored arrows, by element id, after every change of the selection */
  onSelection?(ids: string[]): void;
  /** the repository the board and its files belong to, "owner/name": an embedded editor's context names it */
  repo?: string;
  /** how a model node gets the product's editor (embed/product-mount.ts); default: the editor modules */
  via?: Via;
}

export interface BoardRuntime {
  readonly params: BoardOptions;
  readonly hub: BoardFiles;
  readonly store: BoardStore;
  /**
   * The board is a part of a host's page: no Files panel, no board and strategy choice in the
   * toolbar, and no `window.__boardSpike` (a page may hold several boards). False on the bench.
   */
  readonly embedded: boolean;
  /** see BoardParts.bench */
  readonly bench?: BoardBench;
  /** see BoardParts.inputScope */
  readonly inputScope: "board" | "page";
  /** see BoardParts.undoRedoKeys */
  readonly undoRedoKeys: boolean;
  /** see BoardParts.fitPadding */
  readonly fitPadding: Padding;
  /** see BoardParts.presence */
  readonly presence?: BoardPresence;
  /** the surface of a strategy; undefined where whoever mounted the board ships none for it */
  surfaceOf(strategy: Strategy): SurfaceComponent | undefined;
  /** see BoardParts.onFlow */
  onFlow?(flow: ReactFlowInstance<BoardFlowNode, BoardFlowEdge> | null): void;
  /** see BoardParts.onSelection */
  onSelection?(ids: string[]): void;
  /** see BoardParts.repo; a board without a repository (the bench) gets a placeholder */
  readonly repo: string;
  /** see BoardParts.via */
  readonly via: Via;
  /** the strategy of a model node: the board's choice for it, else the URL's */
  strategyOf(nodeId: string): Strategy;

  /** a model node of the board */
  isModel(nodeId: string): boolean;
  /** exactly one node is armed, or none */
  armedId(): string | null;
  /**
   * The armed node as such: a model node (any other id is ignored) or, with null, none. No rule is
   * applied here. Whoever arms or disarms calls `arm()` of the board context, which goes through
   * the arm rules of the node (board-arming.ts) and ends here.
   */
  setArmedId(nodeId: string | null): void;
  subscribeArmed(listener: () => void): () => void;

  /** a surface tells the board what the hooks need of it; returns the unregister */
  registerSurface(nodeId: string, api: SurfaceApi): () => void;
  surface(nodeId: string): SurfaceApi | undefined;
  /** the surface's `ready`: true once it resolved, false once it failed, undefined before */
  mounted(nodeId: string): boolean | undefined;
  /** a surface that threw while loading or rendering never registers: its node counts as failed, not as pending */
  surfaceFailed(nodeId: string): void;
  /** a surface calls it once per engine it mounts: more than 1 for a node means something remounted it */
  reportMount(nodeId: string): void;
  readonly counters: BoardCounters;

  /** page errors, sync errors and conflict notices */
  log(line: string): void;
  readonly lines: readonly string[];

  /**
   * The overlay strategy's screen-space layer: a child of `.react-flow` outside the scaled viewport,
   * as large as the board, with no transform on any ancestor. It takes no pointer itself; what is
   * put into it sets `pointer-events: auto`. Null before the board's first commit is through.
   */
  overlayLayer(): HTMLElement | null;
  setOverlayLayer(layer: HTMLElement | null): void;
}

export function createBoardRuntime(params: BoardOptions, parts: BoardParts): BoardRuntime {
  const { lines, log } = parts.log ?? createBoardLog();
  const { hub, store } = parts;

  const isModel = (nodeId: string): boolean =>
    store.getSnapshot().nodes.some((node) => node.id === nodeId && node.attrs.type === "model");
  const strategies: Readonly<Record<string, Strategy>> = parts.strategies ?? {};
  const strategyOf = (nodeId: string): Strategy => strategies[nodeId] ?? params.strategy;
  // `&arm=`: armed from the first render where arming moves nothing (armzoom=off), as before the
  // rules. Under any other rule the board may have to move first: board-arming.ts arms it once
  // the board is measured
  const armedOnLoad = (nodeId: string | null): nodeId is string =>
    nodeId !== null && isModel(nodeId) && resolveRules(strategyOf(nodeId), params).armzoom === "off";
  let armed: string | null = armedOnLoad(params.arm) ? params.arm : null;
  const armedListeners = new Set<() => void>();

  const surfaces = new Map<string, SurfaceApi>();
  const status = new Map<string, boolean>();
  const counters: BoardRuntime["counters"] = {
    nodeChanges: 0,
    edgeChanges: 0,
    viewportChanges: 0,
    mounts: {},
    arm: {
      transitions: 0,
      disarmsBeforeZoom: 0,
      disarmsAtTick: 0,
      zoomsRefused: 0,
      zoomsUndone: 0,
      armedZoomTicks: 0,
      lateDisarms: 0,
    },
  };
  let layer: HTMLElement | null = null;

  return {
    params,
    hub,
    store,
    embedded: parts.bench === undefined,
    ...(parts.bench ? { bench: parts.bench } : {}),
    inputScope: parts.inputScope ?? "board",
    undoRedoKeys: parts.undoRedoKeys ?? true,
    fitPadding: parts.fitPadding ?? FIT_PADDING,
    ...(parts.presence ? { presence: parts.presence } : {}),
    surfaceOf: (strategy) => parts.surfaces[strategy],
    ...(parts.onFlow ? { onFlow: parts.onFlow } : {}),
    ...(parts.onSelection ? { onSelection: parts.onSelection } : {}),
    repo: parts.repo ?? "local/board",
    via: parts.via ?? "modules",
    strategyOf,

    isModel,
    armedId: () => armed,
    setArmedId(nodeId) {
      if (nodeId === armed || (nodeId !== null && !isModel(nodeId))) return;
      armed = nodeId;
      for (const listener of [...armedListeners]) listener();
    },
    subscribeArmed(listener) {
      armedListeners.add(listener);
      return () => void armedListeners.delete(listener);
    },

    registerSurface(nodeId, api) {
      surfaces.set(nodeId, api);
      status.delete(nodeId);
      const current = (): boolean => surfaces.get(nodeId) === api;
      api.ready.then(
        () => void (current() && status.set(nodeId, true)),
        (error: unknown) => {
          if (!current()) return;
          status.set(nodeId, false);
          log(`${nodeId}: ${error instanceof Error ? error.message : String(error)}`);
        },
      );
      return () => {
        if (!current()) return;
        surfaces.delete(nodeId);
        status.delete(nodeId);
      };
    },
    surface: (nodeId) => surfaces.get(nodeId),
    mounted: (nodeId) => status.get(nodeId),
    surfaceFailed: (nodeId) => void status.set(nodeId, false),
    reportMount: (nodeId) => void (counters.mounts[nodeId] = (counters.mounts[nodeId] ?? 0) + 1),
    counters,

    log,
    lines,

    overlayLayer: () => layer,
    setOverlayLayer: (next) => void (layer = next),
  };
}

export interface BoardContextValue extends BoardRuntime {
  /**
   * Arms a model node (any other id is ignored) or, with null, none, through the arm rules of the
   * node: the board may move first, and a disarm may bring it back. `by` says what asked (the
   * anchor of the zoom, and whether a disarm goes back). Resolves when the board rests again.
   */
  arm(nodeId: string | null, by?: ArmBy): Promise<void>;
  /** the arm rules at work: the policy of a node, the zoom guard for the board's own controls, the transitions */
  readonly arming: BoardArming;
  /**
   * `listener` runs synchronously inside every pan and zoom tick, after React Flow wrote the new
   * transform to the viewport and without a React render (react-flow.md, section 5).
   */
  subscribeViewport(listener: (viewport: Viewport) => void): () => void;
}

const BoardContext = createContext<BoardContextValue | null>(null);

/** inside <ReactFlowProvider>: the viewport subscription reads React Flow's store */
export function BoardProvider({ runtime, children }: { runtime: BoardRuntime; children: ReactNode }) {
  const flowStore = useStoreApi();
  const arming = useMemo(() => createBoardArming(runtime, flowStore), [runtime, flowStore]);
  // In this provider's first commit, so before any surface subscribes to the same store (a surface
  // is loaded lazily): a zoom tick reaches the arm rules first, and an armed editor that is
  // disarmed there never hears of the tick
  useLayoutEffect(() => arming.watch(), [arming]);
  const value = useMemo<BoardContextValue>(
    () => ({
      ...runtime,
      arm: arming.arm,
      arming,
      subscribeViewport: (listener) =>
        // every pan or zoom tick stores a NEW transform array, nothing else does
        flowStore.subscribe((state, previous) => {
          if (state.transform === previous.transform) return;
          const [x, y, zoom] = state.transform;
          listener({ x, y, zoom });
        }),
    }),
    [runtime, flowStore, arming],
  );
  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoardContext(): BoardContextValue {
  const value = useContext(BoardContext);
  if (!value) throw new Error("useBoardContext outside <BoardProvider>");
  return value;
}

const selectZoom = (state: ReactFlowState): number => state.transform[2];

/** the board zoom as React state: re-renders the caller per zoom tick, never on a pan */
export function useBoardZoom(): number {
  return useStore(selectZoom);
}

interface SlotProps {
  /** what failed, for the reader of the error text */
  name: string;
  /**
   * Nothing is drawn while loading or after an error, the log has it: for a part inside an <svg>
   * (an edge), where a <div> cannot stand, and for one that draws nothing itself (the gestures).
   */
  silent?: boolean;
  onError?: (error: Error) => void;
  children: ReactNode;
}

class SlotBoundary extends Component<SlotProps & { log: (line: string) => void }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error): void {
    this.props.log(`${this.props.name}: ${error.message}`);
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.silent) return null;
    return (
      <div className="board-slot board-slot--error" role="alert">
        <strong>{this.props.name}</strong>
        <span>{error.message}</span>
      </div>
    );
  }
}

/**
 * One owner's part of the page (a node type, a strategy surface, the Files panel), behind
 * React.lazy: while it loads the slot says so, and when it fails to load or to render the error
 * text stands in its place and everything around it keeps working.
 */
export function Slot({ name, silent, onError, children }: SlotProps) {
  const { log } = useBoardContext();
  return (
    <SlotBoundary name={name} silent={silent} onError={onError} log={log}>
      <Suspense fallback={silent ? null : <div className="board-slot">{name}</div>}>{children}</Suspense>
    </SlotBoundary>
  );
}
