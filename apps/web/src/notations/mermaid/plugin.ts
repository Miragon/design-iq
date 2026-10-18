/**
 * The Mermaid web plugin MANIFEST, light and eager. The viewer and the
 * Preview panel load behind the dynamic imports below, and mermaid itself
 * only behind lib/mermaid-render.ts (ADR 0006): the repo overview and every
 * other notation never fetch it.
 *
 *   Diagram  the viewer on the canvas layer (mountEditor), read-only
 *   Text     the shell's Monaco on the same Y.Text: the editor
 *   Preview  the diagram beside the text, redrawn as you type (a panel)
 *
 * No assist handoff: Mermaid has no MCP-App widget (no open_mermaid_modeler).
 */
import { Eye } from "lucide-react";
import { lazy } from "react";

import type { WebNotationPlugin } from "../registry";

const PreviewPanel = lazy(() => import("./preview-panel").then((m) => ({ default: m.MermaidPreviewPanel })));

export const mermaidPlugin: WebNotationPlugin = {
  id: "mermaid",
  canvasClassName: "mermaid-canvas",
  mountEditor: async (container, ctx) => {
    const { mountMermaidViewer } = await import("./mermaid-viewer");
    return mountMermaidViewer(container, ctx);
  },
  panels: [
    {
      id: "preview",
      label: "Preview",
      buttonTitle: "The diagram next to the text, redrawn as you type",
      icon: Eye,
      placement: "toolbar",
      component: PreviewPanel,
    },
  ],
};
