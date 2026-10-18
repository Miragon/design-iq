/**
 * The Markdown web plugin MANIFEST: light, eager data. The view (markdown-it,
 * DOMPurify, the renderer and its stylesheet) loads behind the dynamic
 * import on mount, as its own chunk, so the repo overview and every other
 * editor never load it (ADR 0006).
 *
 * A Markdown document opens RENDERED: the canvas layer shows the formatted,
 * read-only document, live with every edit, and the shell's view switch
 * flips to the Monaco source to write. No assist handoff: there is no
 * Markdown MCP-App widget to hand over to.
 */
import { Eye } from "lucide-react";

import type { WebNotationPlugin } from "../registry";

export const markdownPlugin: WebNotationPlugin = {
  id: "markdown",
  canvasClassName: "markdown-canvas",
  canvasView: { label: "Preview", buttonTitle: "Show the formatted document", icon: Eye },
  mountEditor: async (container, ctx) => {
    const { mountMarkdownView } = await import("./markdown-view");
    return mountMarkdownView(container, ctx);
  },
};
