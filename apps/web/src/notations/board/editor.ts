/**
 * The board's editor ENGINE, loaded on demand by the manifest (plugin.ts) as its own chunk with
 * the canvas (@miragon/board-renderer: React Flow on React, its sheet): the published board on
 * the room's own document, element by element (ctx.doc's ELEMENTS_KEY and META_KEY maps, which
 * the Live Host writes through to the `.board` file), with designIQ's host (host.ts). The board
 * renders its React root itself: no JSX and no React Flow call here.
 *
 * The end: the board's destroy() returns before its model nodes' editors are destroyed (the
 * canvas unmounts a microtask later, an editor that is still loading later still). `unmounted`
 * settles once the board is gone and every node let go of its editor and its live session; only
 * then may the shell end the linked socket the sessions run on (EditorContext.linkedFiles).
 */
import "@miragon/board-renderer/assets/board.css";
import "./board.css";

import { type CollaborativeBoard, createCollaborativeModeler } from "@miragon/board-renderer";

import type { EditorContext, MountedEditor } from "../registry.ts";
import { createBoardHost, type DesignIqBoardHost } from "./host.ts";
import type { PluginLookup } from "./product-mount.ts";

/** the board designIQ mounts, not attached yet: its factory, its options and its host */
export function createDesignIqBoard(
  ctx: EditorContext,
  lookup: PluginLookup,
): { modeler: CollaborativeBoard; host: DesignIqBoardHost } {
  const host = createBoardHost(ctx, lookup);
  const modeler = createCollaborativeModeler({
    host,
    // the board never destroys it: the shell's session does
    liveDocument: ctx.doc,
    // the shell's side panels (History) dock over the right edge: the first fit leaves them free
    freeArea: { insets: () => ({ top: 0, right: ctx.sidePanels?.covered() ?? 0, bottom: 0, left: 0 }) },
    // designIQ keeps no history of a board's own: Ctrl/Cmd+Z on the focused board is the board's
    undoRedoKeys: true,
  });
  return { modeler, host };
}

export function mountBoardEditor(container: HTMLElement, ctx: EditorContext, lookup: PluginLookup): MountedEditor {
  const { modeler, host } = createDesignIqBoard(ctx, lookup);
  try {
    modeler.attachTo(container);
  } catch (error) {
    modeler.destroy();
    void modeler.board.unmounted.then(() => host.destroy());
    throw error;
  }
  // the board calls no editor after board.unmounted; a node's own end may still wait for an
  // editor that was loading when the board went
  const unmounted = modeler.board.unmounted
    .then(() => host.whenClosed())
    .then(() => host.destroy())
    .catch((error: unknown) => console.error("[board]", error));
  return {
    // the pane takes the board's keys (tabindex 0, aria-label "Board")
    focus: () => container.querySelector<HTMLElement>(".react-flow__pane")?.focus({ preventScroll: true }),
    destroy: () => modeler.destroy(),
    unmounted,
  };
}
