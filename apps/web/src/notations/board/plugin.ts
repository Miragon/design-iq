/**
 * The board's plugin manifest: light, eager data. The board itself (React Flow, the node types,
 * the arm rules) loads with the dynamic import below, when a `.board` file is opened.
 */
import type { WebNotationPlugin } from "../registry";

export const boardPlugin: WebNotationPlugin = {
  id: "board",
  canvasClassName: "board-canvas",
  mountEditor: async (container, ctx) => (await import("./editor")).mountBoardEditor(container, ctx),
};
