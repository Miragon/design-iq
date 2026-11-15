/**
 * The board's editor in the SPA: the React Flow board on the session's STRUCTURED document (the
 * element maps of @designiq/contracts/live), so two people who move two nodes at the same time
 * both keep their move. The models it shows are live sessions of their own (live-hub.ts) and are
 * edited in place by the product's own editors, mounted through the plugin registry.
 *
 * This module and live-hub.ts are what designIQ adds to the board: the session's document, the
 * repository's files and the product's editors. The measuring bench the board was built on
 * (src/board-spike) mounts the same board with its own parts.
 */
import "@xyflow/react/dist/style.css";
import "./board.css";

import { createRoot } from "react-dom/client";

import type { EditorContext, MountedEditor } from "../registry";
import { Board } from "./board.tsx";
import { createBoardRuntime } from "./board-context.tsx";
import { createBoardStore } from "./board-doc.ts";
import { createLiveHub } from "./live-hub";
import { ProductOverlaySurface } from "./overlay-surface.tsx";
import type { BoardOptions } from "./types.ts";

/** overlay with the product's editors, the final arm rules, the board fitted into the window at first */
const PARAMS: BoardOptions = {
  strategy: "overlay",
  viewport: null,
  arm: null,
  armzoom: null,
  armedzoom: null,
  armreturn: null,
  armmotion: null,
};

export function mountBoardEditor(container: HTMLElement, ctx: EditorContext): MountedEditor {
  const store = createBoardStore(ctx.doc);
  const hub = createLiveHub(ctx, (line) => console.debug("[board]", line));
  const runtime = createBoardRuntime(PARAMS, {
    store,
    hub,
    surfaces: { overlay: ProductOverlaySurface },
    repo: ctx.repo,
    via: "registry",
    ...(ctx.presence ? { presence: ctx.presence } : {}),
  });
  const element = document.createElement("div");
  element.className = "board-module";
  element.style.cssText = "width:100%;height:100%";
  container.appendChild(element);
  const root = createRoot(element);
  root.render(<Board runtime={runtime} />);
  return {
    destroy() {
      root.unmount();
      element.remove();
      store.destroy();
      // after the editors on them are gone
      hub.destroy();
    },
  };
}
