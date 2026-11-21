/**
 * The board's plugin MANIFEST: light, eager data. The canvas (@miragon/board-renderer, React
 * Flow, the board's sheet) and designIQ's host for it load behind the dynamic import below, when
 * a `.board` file is opened, as their own chunk (ADR 0006; .dependency-cruiser.mjs
 * web-board-engine-loads-lazily). A factory: the registry hands in its own lookup, so a model on
 * a board is mounted by exactly the plugin its own page mounts it with, and no board module
 * imports the registry back.
 *
 * No panels, no assist handoff (there is no board widget), no visual diff: History compares the
 * board's text.
 */
import { LayoutDashboard } from "lucide-react";

import type { WebNotationPlugin } from "../registry";
import type { PluginLookup } from "./product-mount.ts";

export function boardPlugin(lookup: PluginLookup): WebNotationPlugin {
  return {
    id: "board",
    canvasClassName: "board-canvas",
    // the view switch names the canvas "Board" beside its read-only source
    canvasView: { label: "Board", buttonTitle: "Show the board", icon: LayoutDashboard },
    mountEditor: async (container, ctx) => {
      const { mountBoardEditor } = await import("./editor");
      return mountBoardEditor(container, ctx, lookup);
    },
  };
}
