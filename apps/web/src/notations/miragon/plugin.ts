/**
 * The web plugin MANIFEST of a Miragon renderer — light, eager data derived
 * from its spec; the engine (renderer + stylesheet + the live binding) loads
 * behind the dynamic imports on mount, as its own chunk, and so does the
 * Legend panel of a notation that has a legend.
 */
import { BookOpen } from "lucide-react";
import { createElement, lazy } from "react";

import type { PanelSpec, WebNotationPlugin } from "../registry";
import type { MiragonRendererSpec } from "./spec";

function legendPanel(spec: MiragonRendererSpec): PanelSpec {
  return {
    id: "legend",
    label: "Legend",
    buttonTitle: "What the shapes and marks mean",
    icon: BookOpen,
    modelMenu: true,
    component: lazy(async () => {
      const { MiragonLegendPanel } = await import("./legend-panel");
      return { default: (props) => createElement(MiragonLegendPanel, { ...props, spec }) };
    }),
  };
}

export function miragonPlugin(spec: MiragonRendererSpec): WebNotationPlugin {
  return {
    id: spec.id,
    canvasClassName: spec.canvasClassName,
    ...(spec.hasLegend ? { panels: [legendPanel(spec)] } : {}),
    mountEditor: async (container, ctx) => {
      const [{ mountMiragonEditor }, renderer] = await Promise.all([import("./editor"), spec.load()]);
      return mountMiragonEditor(spec, renderer, container, ctx);
    },
    // every Miragon renderer is a served MCP-App widget by construction (the
    // registration contract in ./index.ts pairs each spec with the Live Host's
    // widget list), so its `open_<id>_modeler` tool exists for the handoff
    assistNotation: spec.id,
  };
}
