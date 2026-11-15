/**
 * The board's toolbar: the Done control of the model that is being edited, the zoom buttons and
 * the add actions. The bench puts its own controls in front (bench/toolbar-lead.tsx).
 * Own buttons with Lucide icons instead of <Controls />, whose lock button would switch every
 * node's pointer events off (react-flow.md 8.4).
 */
import { byExtension, modelStem } from "@designiq/notations";
import { Panel, type ReactFlowState, useReactFlow, useStore, useStoreApi } from "@xyflow/react";
import {
  Check,
  CircleAlert,
  CircleCheck,
  Group,
  ImagePlus,
  Maximize,
  Trash2,
  Type,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { memo, useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from "react";

import {
  addGroupAround,
  addNode,
  formatBytes,
  IMAGE_ACCEPT,
  IMAGE_LIMIT_BYTES,
  IMAGE_TYPE_NAMES,
  NEW_NODE,
} from "./board-actions.ts";
import { useBoardContext, useBoardZoom } from "./board-context.tsx";
import type { BoardFlowEdge, BoardFlowNode } from "./board-flow.tsx";
import { importImages, notices, requestEdit, useBoardPlacement } from "./board-gestures.tsx";

/** the zoom buttons' title while armedzoom=lock holds them */
const ZOOM_LOCKED = "The zoom is locked while a model is edited. Choose Done first.";

/**
 * Done, in the board's own chrome: ends the editing of the armed model node exactly as the Done
 * button of its header does (through the arm rules: `armreturn=back` brings the board back, an
 * open label editor is committed by the press and by the disarm). The header's button lies
 * wherever the node lies: outside the board when the node is wider than it, under the toolbar
 * after a pan, anywhere when a pointer armed a node larger than the board (measured in rounds 5
 * and 6, README sections 12 and 13). This one is part of the toolbar, so it is in reach whatever the
 * board shows, inside the band the arm rules keep free of the armed node, and above the overlay
 * layer and its popups (the panel's z-index).
 *
 * ALWAYS there, switched off while no model node is armed, and of ONE size whatever it says
 * (board.css): the toolbar wraps the same way armed and unarmed, so the band a placement
 * is computed with is the band the armed node finds, and nothing moves under the pointer when a
 * node is armed or disarmed (a control that came and went would hand the second click of a
 * double-click to whatever took its place). While the arm rules move the board no node is armed
 * yet and it is off; a text note that is being edited is no armed model node, it is off then too.
 *
 * For a script: `[data-board-done]`, whose value is the armed node's id, "" while it is off.
 * By the keyboard: a plain button, Enter or Space; one Shift + Tab from an armed overlaid editor.
 */
function DoneControl({ armed }: { armed: string | null }) {
  const { arm, store } = useBoardContext();
  const file = armed === null ? undefined : store.getSnapshot().nodes.find((node) => node.id === armed)?.attrs.file;
  const model = file === undefined ? null : modelStem(file);
  // the visible word "Done" leads the accessible name in both states
  const label =
    armed === null ? "Done editing: no model is being edited" : `Done editing${model === null ? "" : ` ${model}`}`;
  return (
    <button
      type="button"
      className="board-toolbar__done"
      data-board-done={armed ?? ""}
      title={armed === null ? "No model is being edited. Double-click a model to edit it." : label}
      aria-label={label}
      disabled={armed === null}
      onClick={() => void arm(null, { source: "done" })}
    >
      <Check aria-hidden />
      <span>Done</span>
      {model === null ? null : <span className="board-toolbar__done-model">{model}</span>}
    </button>
  );
}

export function Toolbar() {
  const { arming, armedId, subscribeArmed, bench, fitPadding } = useBoardContext();
  const ToolbarLead = bench?.ToolbarLead;
  const flow = useReactFlow();
  const flowStore = useStoreApi();
  const zoom = useBoardZoom();
  // The four zoom buttons ask the arm rules first (board-arming.ts): under armedzoom=disarm the
  // armed node is a preview before the zoom begins, under lock the buttons are disabled and say why
  const armed = useSyncExternalStore(subscribeArmed, armedId);
  const locked = armed !== null && arming.policy(armed).armedzoom === "lock";
  const title = (plain: string): string => (locked ? ZOOM_LOCKED : plain);
  const zoomOut = (): void => {
    if (arming.beforeZoom(zoom > flowStore.getState().minZoom)) void flow.zoomOut();
  };
  const zoomReset = (): void => {
    if (arming.beforeZoom(zoom !== 1)) void flow.zoomTo(1);
  };
  const zoomIn = (): void => {
    if (arming.beforeZoom(zoom < flowStore.getState().maxZoom)) void flow.zoomIn();
  };
  // a fit is taken for a zoom without looking: whether it only pans is known after it ran
  const fit = (): void => {
    // a host's board fits clear of this toolbar; the bench keeps React Flow's own fit, as measured
    if (arming.beforeZoom(true)) void flow.fitView(bench ? undefined : { padding: fitPadding });
  };
  return (
    <Panel position="top-left" className="board-toolbar">
      {/* the bench's own controls (which sample board, which strategy); a host has none */}
      {ToolbarLead ? <ToolbarLead /> : null}
      <div className="board-toolbar__group" role="group" aria-label="Zoom">
        <button type="button" title={title("Zoom out")} aria-label="Zoom out" disabled={locked} onClick={zoomOut}>
          <ZoomOut aria-hidden />
        </button>
        <button
          type="button"
          title={title("Zoom to 100%")}
          data-board-zoom={zoom}
          disabled={locked}
          onClick={zoomReset}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" title={title("Zoom in")} aria-label="Zoom in" disabled={locked} onClick={zoomIn}>
          <ZoomIn aria-hidden />
        </button>
        <button type="button" title={title("Fit the board")} aria-label="Fit the board" disabled={locked} onClick={fit}>
          <Maximize aria-hidden />
        </button>
      </div>
      <AddActions />
      {/* The LAST child and drawn FIRST (board.css): the overlay layer follows the toolbar in
          the document, so from an armed overlaid editor it is one Shift + Tab away (measured: 12
          as the first child). On screen it leads the toolbar, the one place every window shows */}
      <DoneControl armed={armed} />
    </Panel>
  );
}

// ── board features: the add actions ──────────────────────────────────────────

const selectsSomething = (state: ReactFlowState): boolean =>
  state.nodes.some((node) => node.selected) || state.edges.some((edge) => edge.selected);

/**
 * Text, image, group, model, and delete. Every action is one gesture of the board store: a new
 * element (an image also a new repository file), never a change of a model file. A new node lands
 * in the middle of what the board shows and is selected, ready to be dragged where it belongs.
 *
 * Its own component and memoized: the toolbar around it renders on every zoom tick.
 */
const AddActions = memo(function AddActions() {
  const board = useBoardContext();
  const { hub, store } = board;
  const flow = useReactFlow<BoardFlowNode, BoardFlowEdge>();
  const { centre, select } = useBoardPlacement();
  const picker = useRef<HTMLInputElement>(null);
  const hasSelection = useStore(selectsSomething);
  const shown = useSyncExternalStore(notices.subscribe, notices.getSnapshot);
  // the repository's model files. The bench's hub never gains or loses one; a host's list arrives
  // after the board and changes when a model is created, renamed or deleted
  const [listed, relist] = useReducer((count: number) => count + 1, 0);
  const { embedded } = board;
  useEffect(() => (embedded ? hub.onFiles(relist) : undefined), [hub, embedded]);
  const models = useMemo(
    () => hub.files().flatMap((file) => (file.kind === "model" ? [file.path] : [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `listed` counts the list's changes
    [hub, listed],
  );
  const limit = `${IMAGE_TYPE_NAMES}, up to ${formatBytes(IMAGE_LIMIT_BYTES)}`;

  const addText = (): void => {
    // the new note opens in its textarea: an armed editor hands the keys back first
    void board.arm(null);
    const id = addNode(store, { type: "text", ...NEW_NODE.text, text: "" }, centre());
    requestEdit(id);
    select(id);
  };
  const addGroup = (): void => {
    // around what is selected, or an empty frame to drag nodes into
    const selected = flow.getNodes().flatMap((node) => (node.selected ? [node.id] : []));
    const id =
      addGroupAround(store, selected, "Group") ??
      addNode(store, { type: "group", ...NEW_NODE.group, text: "Group" }, centre());
    select(id);
  };
  const addModel = (file: string): void => select(addNode(store, { type: "model", ...NEW_NODE.model, file }, centre()));
  const addImages = async (files: readonly File[]): Promise<void> => {
    const [last] = (await importImages(board, files, centre())).slice(-1);
    if (last !== undefined) select(last);
  };
  const removeSelection = (): void =>
    void flow.deleteElements({
      nodes: flow.getNodes().filter((node) => node.selected),
      edges: flow.getEdges().filter((edge) => edge.selected),
    });

  return (
    <>
      <div className="board-toolbar__group" role="group" aria-label="Add to the board">
        <button type="button" title="Add a text note" onClick={addText}>
          <Type aria-hidden />
          Text
        </button>
        {/* where the host stores no new file, an image comes into the repository another way first */}
        {hub.uploads ? (
          <button type="button" title={`Add an image (${limit})`} onClick={() => picker.current?.click()}>
            <ImagePlus aria-hidden />
            Image
          </button>
        ) : null}
        <input
          ref={picker}
          hidden
          type="file"
          accept={IMAGE_ACCEPT}
          multiple
          tabIndex={-1}
          aria-label={`Image files (${limit})`}
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            // the same file can be picked again
            event.currentTarget.value = "";
            void addImages(files);
          }}
        />
        <button
          type="button"
          title={hasSelection ? "Draw a group around the selected nodes" : "Add an empty group"}
          onClick={addGroup}
        >
          <Group aria-hidden />
          Group
        </button>
        <select
          className="board-toolbar__models"
          value=""
          title="Add a model of the repository"
          aria-label="Add a model of the repository"
          onChange={(event) => addModel(event.currentTarget.value)}
        >
          <option value="" disabled>
            Model…
          </option>
          {models.map((path) => (
            <option key={path} value={path}>
              {modelStem(path)} ({byExtension(path)?.label ?? "model"})
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="board-toolbar__delete"
        title="Delete the selection from the board"
        aria-label="Delete the selection from the board"
        disabled={!hasSelection}
        onClick={removeSelection}
      >
        <Trash2 aria-hidden />
      </button>
      {shown.length > 0 ? (
        <div className="board-notices">
          {shown.map((notice) => (
            <div
              key={notice.id}
              className="board-notice"
              data-kind={notice.kind}
              role={notice.kind === "refused" ? "alert" : "status"}
            >
              {notice.kind === "refused" ? <CircleAlert aria-hidden /> : <CircleCheck aria-hidden />}
              <span>{notice.text}</span>
              <button type="button" title="Dismiss" aria-label="Dismiss" onClick={() => notices.dismiss(notice.id)}>
                <X aria-hidden />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
});
