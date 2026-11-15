/**
 * The board: <ReactFlow> in controlled mode on the board store, and every part an owner fills in
 * as a slot of its own. A slot is a lazily loaded module behind an error boundary (Slot), so a
 * module that fails to load or to render shows its error where it would be and nothing else stops.
 *
 * Shared file: later edits are additive only (a new node type, a new panel).
 */
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  type EdgeProps,
  type EdgeTypes,
  type IsValidConnection,
  type NodeProps,
  type NodeTypes,
  type OnEdgesChange,
  type OnNodesChange,
  type OnSelectionChangeFunc,
  ReactFlow,
  ReactFlowProvider,
  type ReactFlowState,
  useReactFlow,
  useStore,
  useStoreApi,
} from "@xyflow/react";
import {
  type ComponentType,
  lazy,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";

import { inArmedEditor } from "./board-arming.ts";
import { BoardProvider, type BoardRuntime, Slot, useBoardContext } from "./board-context.tsx";
import { type BoardFlowEdge, type BoardFlowNode, NodeHandles, useBoard, useDerivedEdges } from "./board-flow.tsx";
import { clientPoint } from "./geometry.ts";

type NodeComponent = ComponentType<NodeProps<BoardFlowNode>>;
type EdgeComponent = ComponentType<EdgeProps<BoardFlowEdge>>;
// what nodeTypes / edgeTypes take: a FUNCTION component (their props type fits no class component of ours)
type NodeFunction = (props: NodeProps<BoardFlowNode>) => ReactNode;
type EdgeFunction = (props: EdgeProps<BoardFlowEdge>) => ReactNode;

const ModelNode = lazy(() => import("./nodes/model-node.tsx").then((module) => ({ default: module.ModelNode })));
const TextNode = lazy(() => import("./nodes/text-node.tsx").then((module) => ({ default: module.TextNode })));
const ImageNode = lazy(() => import("./nodes/image-node.tsx").then((module) => ({ default: module.ImageNode })));
const GroupNode = lazy(() => import("./nodes/group-node.tsx").then((module) => ({ default: module.GroupNode })));
const ArrowEdge = lazy(() => import("./edges/arrow-edge.tsx").then((module) => ({ default: module.ArrowEdge })));
const DerivedEdge = lazy(() => import("./edges/derived-edge.tsx").then((module) => ({ default: module.DerivedEdge })));
const Toolbar = lazy(() => import("./toolbar.tsx").then((module) => ({ default: module.Toolbar })));
const BoardGestures = lazy(() => import("./board-gestures.tsx").then((module) => ({ default: module.BoardGestures })));
const BoardPresenceLayer = lazy(() =>
  import("./board-presence.tsx").then((module) => ({ default: module.BoardPresenceLayer })),
);

function nodeSlot(name: string, Content: NodeComponent, model = false): NodeFunction {
  return function NodeSlot(props) {
    const { surfaceFailed } = useBoardContext();
    return (
      <>
        {/* Here and not in the lazily loaded content: React Flow measures a node's handles when its
            wrapper mounts, and handles that came later would not be found by any arrow (error008) */}
        <NodeHandles />
        {/* a model node whose frame failed will never register a surface: it counts as failed, not as pending */}
        <Slot name={`${name} ${props.id}`} onError={model ? () => surfaceFailed(props.id) : undefined}>
          <Content {...props} />
        </Slot>
      </>
    );
  };
}

function edgeSlot(name: string, Content: EdgeComponent): EdgeFunction {
  return function EdgeSlot(props) {
    return (
      <Slot name={`${name} ${props.id}`} silent>
        <Content {...props} />
      </Slot>
    );
  };
}

// module level: a new nodeTypes object or component identity per render would remount every node
const nodeTypes: NodeTypes = {
  model: nodeSlot("model node", ModelNode, true),
  text: nodeSlot("text node", TextNode),
  image: nodeSlot("image node", ImageNode),
  group: nodeSlot("group node", GroupNode),
};
const edgeTypes: EdgeTypes = {
  arrow: edgeSlot("arrow", ArrowEdge),
  derived: edgeSlot("derived arrow", DerivedEdge),
};

/** React Flow's own connect would draw an arrow from a node to itself, between two of its handles */
const joinsTwoNodes: IsValidConnection<BoardFlowEdge> = (connection) => connection.source !== connection.target;

/** as soon as React Flow's instance is there: the bench installs its hooks, a host gets the instance */
function HooksBridge() {
  const board = useBoardContext();
  const flow = useReactFlow<BoardFlowNode, BoardFlowEdge>();
  const install = board.bench?.install;
  useEffect(() => install?.(board, flow), [install, board, flow]);
  useEffect(() => {
    // the instance changes its identity once the viewport exists: a host can set a view from then on
    if (!flow.viewportInitialized) return undefined;
    board.onFlow?.(flow);
    return () => board.onFlow?.(null);
  }, [board, flow]);
  return null;
}

const selectBoardElement = (state: ReactFlowState): HTMLDivElement | null => state.domNode;

/** the arm rules' listeners on the board's own element (board-arming.ts), as soon as React Flow has it */
function ArmGuards() {
  const { arming } = useBoardContext();
  const element = useStore(selectBoardElement);
  useEffect(() => (element ? arming.attach(element) : undefined), [arming, element]);
  return null;
}

function Canvas() {
  const board = useBoardContext();
  const { arm, counters, hub, params, store, subscribeViewport } = board;
  const armedId = useSyncExternalStore(board.subscribeArmed, board.armedId);
  const flow = useBoard(store, armedId);
  const derived = useDerivedEdges(hub, flow.view);
  const edges = useMemo(() => [...flow.edges, ...derived], [flow.edges, derived]);

  // Whose click is it? Nothing stops a click inside the armed editor on its way up (model-node.tsx
  // says why), so the board's own handlers ask where it began. Not the board's are
  // - a click or double-click inside the armed editor, and a click whose press began there;
  // - a click on the pane whose press began anywhere else: the tail of a drag. The browser sends a
  //   click to the nearest common ancestor of press and release, which is the pane for a drag out
  //   of an editor that lives in a node, and a pane click disarms (measured: every such drag did).
  // React Flow selects and unselects in click handlers of its own (node wrapper, pane) that the
  // board cannot guard: the select changes it raises WHILE such a click is dispatched are dropped,
  // and the rectangle of a box selection, which those handlers hide first, is shown again.
  const flowStore = useStoreApi<BoardFlowNode, BoardFlowEdge>();
  const press = useRef<{ target: EventTarget; inEditor: boolean } | null>(null);
  /** the last press on the board began inside the armed editor (kept after its click) */
  const lastPressInEditor = useRef(false);
  const notOurs = useRef<Event | null>(null);
  /** React Flow showed the rectangle of a box selection when that click began */
  const rectangleShown = useRef(false);
  /** scope "board": a press that holds Control or Command adds to the selection; React Flow's own key for it is off */
  const multiSelects = board.inputScope === "board";
  const onPress = useCallback(
    (event: ReactMouseEvent) => {
      // read off the press itself: no key listener on the page for it
      if (multiSelects) flowStore.setState({ multiSelectionActive: event.metaKey || event.ctrlKey });
      // the primary button only: no other press ends in a click
      if (event.button !== 0) return;
      press.current = { target: event.target, inEditor: inArmedEditor(event.target) };
      lastPressInEditor.current = press.current.inEditor;
    },
    [flowStore, multiSelects],
  );
  const onClickFirst = useCallback(
    (event: ReactMouseEvent) => {
      const pressed = press.current;
      // one press, one click: a click made by a key or by a script has no press of its own
      press.current = null;
      if (multiSelects) flowStore.setState({ multiSelectionActive: event.metaKey || event.ctrlKey });
      const { target } = event;
      const onPane = target instanceof Element && target.classList.contains("react-flow__pane");
      const editors = inArmedEditor(target) || pressed?.inEditor === true;
      const dragTail = onPane && pressed !== null && pressed.target !== target;
      notOurs.current = editors || dragTail ? event.nativeEvent : null;
      rectangleShown.current = flowStore.getState().nodesSelectionActive;
    },
    [flowStore, multiSelects],
  );
  const onClickLast = useCallback(
    (event: ReactMouseEvent) => {
      if (notOurs.current === event.nativeEvent && rectangleShown.current) {
        flowStore.setState({ nodesSelectionActive: true });
      }
    },
    [flowStore],
  );
  /** an event's phase is NONE again as soon as its dispatch is through: no flag to forget */
  const duringForeignClick = useCallback(
    (): boolean => notOurs.current !== null && notOurs.current.eventPhase !== Event.NONE,
    [],
  );
  // Whose Backspace is it? After a press inside the armed editor the keys are the editor's, also
  // when that press left the focus on <body>: a palette entry or a list entry has nothing focusable
  // under it, and the armed node's wrapper no longer catches the focus (board-flow.tsx,
  // ARMED_FIELDS). React Flow's delete key acts on <body>. The armed node is not deletable, but
  // another node or arrow that is selected would go (measured). "Inside the armed editor" is the
  // armed node's body AND the overlay layer (ARMED_EDITOR in board-arming.ts): an overlaid editor
  // lies outside its node, and counted by the node's body alone its presses were nobody's (measured:
  // Backspace after a press on its palette deleted the other selected node). The toolbar's delete
  // button is a press of its own, outside the editor, and passes
  const { armedId: armedNow } = board;
  const onBeforeDelete = useCallback(
    (): Promise<boolean> =>
      Promise.resolve(!(armedNow() !== null && lastPressInEditor.current && document.activeElement === document.body)),
    [armedNow],
  );

  // Keys stay on the canvas (scope "board"). React Flow listens on the document: Delete and
  // Backspace delete the selection wherever the focus is, Space is taken from every element that
  // is no button. So its own key codes are switched off below and the board answers the keys
  // itself, on the element that holds the nodes (the pane), which takes the focus with a click on
  // the board or a Tab into it. The pane and not the board's root: the layer of an armed editor is
  // a child of the root, and a press on a part of that editor that cannot take the focus has to
  // leave the focus on <body> (board-flow.tsx, ARMED_FIELDS), not on a focusable ancestor.
  const ownKeys = board.inputScope === "board";
  const reactFlow = useReactFlow<BoardFlowNode, BoardFlowEdge>();
  const boardElement = useStore(selectBoardElement);
  const { arming, undoRedoKeys } = board;
  useEffect(() => {
    const pane = ownKeys ? boardElement?.querySelector<HTMLElement>(".react-flow__pane") : null;
    if (!pane) return undefined;
    pane.tabIndex = 0;
    pane.setAttribute("aria-label", "Board");
    const onKeyDown = (event: KeyboardEvent): void => {
      // a keydown without a key (browser autofill dispatches one) is nobody's
      if (event.defaultPrevented || typeof event.key !== "string") return;
      const { target } = event;
      // a field of the board (a note's editor, a label's input) and an armed node keep their keys
      if (!(target instanceof Element) || target.closest("input, textarea, select, [contenteditable], .nokey")) return;
      // a board that moves takes no key: not the delete key for the node the double-click selected, either
      if (arming.state().moving) return;
      const command = event.ctrlKey || event.metaKey;
      if (!command && !event.altKey && (event.key === "Delete" || event.key === "Backspace")) {
        const state = flowStore.getState();
        const nodes = state.nodes.filter((node) => node.selected);
        const selectedEdges = state.edges.filter((edge) => edge.selected);
        if (nodes.length === 0 && selectedEdges.length === 0) return;
        event.preventDefault();
        void reactFlow.deleteElements({ nodes, edges: selectedEdges });
        flowStore.setState({ nodesSelectionActive: false });
        // the node that had the focus may be the one that goes: the next key is the board's again
        pane.focus({ preventScroll: true });
        return;
      }
      if (command && !event.altKey && undoRedoKeys) {
        const key = event.key.toLowerCase();
        const undo = key === "z" && !event.shiftKey;
        const redo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
        if (!undo && !redo) return;
        event.preventDefault();
        if (undo) store.undo.undo();
        else store.undo.redo();
      }
    };
    pane.addEventListener("keydown", onKeyDown);
    return () => {
      pane.removeEventListener("keydown", onKeyDown);
      pane.removeAttribute("tabindex");
      pane.removeAttribute("aria-label");
    };
  }, [ownKeys, boardElement, arming, undoRedoKeys, flowStore, reactFlow, store]);

  const { onNodesChange: applyNodes, onEdgesChange: applyEdges } = flow;
  const onNodesChange = useCallback<OnNodesChange<BoardFlowNode>>(
    (raised) => {
      const changes = duringForeignClick() ? raised.filter((change) => change.type !== "select") : raised;
      if (changes.length === 0) return;
      counters.nodeChanges += changes.length;
      // A resize tick is committed at once. Measured in Chromium: left to React's batching, a
      // NodeResizer drag raises "ResizeObserver loop completed with undelivered notifications" as
      // window error events (3 to 5 for 6 pointer moves, on every node type), which land in
      // hooks.log(); committed synchronously, none. Presumably the size of one tick reached the DOM
      // while React Flow's ResizeObserver was delivering the tick before (not looked into further).
      // The resizer's drag handler is a native listener, so no React lifecycle is running here.
      if (changes.some((change) => change.type === "dimensions" && change.resizing === true)) {
        flushSync(() => applyNodes(changes));
      } else applyNodes(changes);
    },
    [counters, applyNodes, duringForeignClick],
  );
  const onEdgesChange = useCallback<OnEdgesChange<BoardFlowEdge>>(
    (raised) => {
      const changes = duringForeignClick() ? raised.filter((change) => change.type !== "select") : raised;
      if (changes.length === 0) return;
      counters.edgeChanges += changes.length;
      applyEdges(changes);
    },
    [counters, applyEdges, duringForeignClick],
  );
  useEffect(() => subscribeViewport(() => void counters.viewportChanges++), [subscribeViewport, counters]);
  // an embedded board tells its host what is selected: nodes and stored arrows (a derived arrow is no element)
  const { onSelection } = board;
  const onSelectionChange = useCallback<OnSelectionChangeFunc<BoardFlowNode, BoardFlowEdge>>(
    ({ nodes: selectedNodes, edges: selectedEdges }) =>
      onSelection?.([
        ...selectedNodes.map((node) => node.id),
        ...selectedEdges.flatMap((edge) => (edge.data?.element ? [edge.id] : [])),
      ]),
    [onSelection],
  );

  return (
    <ReactFlow
      nodes={flow.nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={flow.onNodeDragStop}
      onConnect={flow.onConnect}
      isValidConnection={joinsTwoNodes}
      onDelete={flow.onDelete}
      onBeforeDelete={onBeforeDelete}
      {...(onSelection ? { onSelectionChange } : {})}
      // before any handler of React Flow: whose press, whose click (see above). Both press events,
      // since a pointerdown that is prevented has no mousedown and a second button has no pointerdown
      onPointerDownCapture={onPress}
      onMouseDownCapture={onPress}
      onClickCapture={onClickFirst}
      // and after all of them
      onClick={onClickLast}
      // a preview body is inert, so the double-click lands on the node's wrapper; inside the armed
      // editor a double-click is the editor's (a label, a cell) and arms nothing
      onNodeDoubleClick={(event, node) => {
        // the pointer is the anchor of the arm rule's zoom, in true screen px (native-geometry.ts)
        if (!inArmedEditor(event.target)) {
          void arm(node.id, { source: "pointer", point: clientPoint(event.nativeEvent) });
        }
      }}
      onPaneClick={(event) => {
        if (notOurs.current !== event.nativeEvent) void arm(null, { source: "pane" });
      }}
      connectionMode={ConnectionMode.Loose}
      minZoom={0.1}
      maxZoom={4}
      // the armed editor owns the double-click (label editing); it would zoom the board by 2
      zoomOnDoubleClick={false}
      // scope "board": the board answers its keys itself (above). React Flow keeps Shift for a box
      // selection: a key that alone does nothing
      {...(ownKeys
        ? { deleteKeyCode: null, multiSelectionKeyCode: null, panActivationKeyCode: null, zoomActivationKeyCode: null }
        : { deleteKeyCode: ["Backspace", "Delete"] })}
      // the arrow head takes the edge's stroke from the stylesheet
      defaultMarkerColor={null}
      // true would unmount a node that leaves the viewport, and its engine with it
      onlyRenderVisibleElements={false}
      {...(params.viewport
        ? { defaultViewport: params.viewport }
        : { fitView: true, fitViewOptions: { padding: board.fitPadding } })}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} />
      <Slot name="Toolbar">
        <Toolbar />
      </Slot>
      {/* paste and drop of images, arrows dropped on a node's body, which group takes a dragged node:
          a slot of its own, so they do not go when the toolbar fails */}
      <Slot name="Board gestures" silent>
        <BoardGestures />
      </Slot>
      {/* the classes: a key or a wheel inside an overlaid editor is the editor's, as in an armed body */}
      {/* the other people on this board; nothing where the host has no presence */}
      <Slot name="Board presence" silent>
        <BoardPresenceLayer />
      </Slot>
      <div ref={board.setOverlayLayer} className="board-overlay-layer nodrag nopan nowheel nokey" />
      <ArmGuards />
      <HooksBridge />
    </ReactFlow>
  );
}

export function Board({ runtime }: { runtime: BoardRuntime }) {
  const SidePanel = runtime.bench?.SidePanel;
  return (
    <ReactFlowProvider>
      <BoardProvider runtime={runtime}>
        <div className="board-root" data-embedded={runtime.embedded}>
          <div className="board-root__canvas">
            <Canvas />
          </div>
          {/* the bench's view of the repository (its Files panel); a host has its own */}
          {SidePanel ? (
            <aside className="board-root__files">
              <Slot name="Files panel">
                <SidePanel />
              </Slot>
            </aside>
          ) : null}
        </div>
      </BoardProvider>
    </ReactFlowProvider>
  );
}
