/**
 * Which PRODUCT mount function an embed frame calls for a notation, and the canvas class its host
 * needs. Two routes to the same three functions (mountBpmnEditor, mountDmnEditor,
 * mountMiragonEditor), both unmodified product code:
 *
 * - "modules" (default): the editor modules themselves, as the plugin manifests import them. The
 *   frame then loads no React and no icon set.
 * - "registry": `webPlugin(id).mountEditor`, the very call the SPA's shell makes
 *   (components/live-editor.tsx). The manifests bring React (lazy panels) and lucide-react along.
 */
import type { FitInsets } from "@designiq/live-client";

import { MIRAGON_RENDERERS } from "@/notations/miragon";
import type { EditorContext, MountedEditor } from "@/notations/registry";

import type { ModelNotation } from "./types.ts";

export const VIAS = ["modules", "registry"] as const;
export type Via = (typeof VIAS)[number];

/** the `via` parameter of the embed page's URL */
export function viaOf(search: string): Via {
  const value = new URLSearchParams(search).get("via");
  return VIAS.find((via) => via === value) ?? "modules";
}

export interface ProductMount {
  /** the class the engine's stylesheets are scoped under: it goes on the element the editor mounts into */
  canvasClassName: string;
  mount(host: HTMLElement, context: EditorContext): Promise<MountedEditor>;
  /**
   * What the editor's own chrome covers of `host` along its edges, for the first fit
   * (SyncOptions.fitInsets): bpmn-js and the DRD of dmn-js fit their diagram edge to edge, under
   * their palette and name card, which a canvas of a node's size has no room for. Absent: the
   * editor fits clear of its chrome by itself (the Miragon renderers).
   */
  fitInsets?(host: HTMLElement): FitInsets;
}

/** room between the diagram and the host's edge or the chrome beside it */
const FIT_MARGIN = 12;

/**
 * The insets of `host` for a first fit: beside the chrome at its left edge (`left`: a palette) and
 * below the chrome at its top (`top`: a name card), with a margin all around. Read from the
 * layout, in the host's own px whatever scales it on screen; chrome that is hidden but keeps its
 * room (a preview) counts, chrome that is not there does not.
 */
function chromeInsets(host: HTMLElement, chrome: { left?: string; top?: string }): FitInsets {
  const hostBox = host.getBoundingClientRect();
  const scale = host.offsetWidth > 0 && hostBox.width > 0 ? hostBox.width / host.offsetWidth : 1;
  const boxOf = (selector: string | undefined): DOMRect | undefined => {
    const element = selector === undefined ? null : host.querySelector(selector);
    const box = element?.getBoundingClientRect();
    return box && box.width > 0 && box.height > 0 ? box : undefined;
  };
  const [atLeft, atTop] = [boxOf(chrome.left), boxOf(chrome.top)];
  return {
    top: (atTop ? (atTop.bottom - hostBox.top) / scale : 0) + FIT_MARGIN,
    right: FIT_MARGIN,
    bottom: FIT_MARGIN,
    left: (atLeft ? (atLeft.right - hostBox.left) / scale : 0) + FIT_MARGIN,
  };
}

function throughModules(notation: ModelNotation): ProductMount {
  if (notation === "bpmn") {
    return {
      canvasClassName: "bpmn-canvas",
      mount: async (host, context) => (await import("@/notations/bpmn-editor")).mountBpmnEditor(host, context),
      fitInsets: (host) => chromeInsets(host, { left: ".djs-palette" }),
    };
  }
  if (notation === "dmn") {
    return {
      canvasClassName: "dmn-canvas",
      mount: async (host, context) => (await import("@/notations/dmn-editor")).mountDmnEditor(host, context),
      // the DRD: its palette at the left, the decision's name card above it
      fitInsets: (host) => chromeInsets(host, { left: ".djs-palette", top: ".dmn-definitions" }),
    };
  }
  const spec = MIRAGON_RENDERERS.find((one) => one.id === notation);
  if (!spec) throw new Error(`no Miragon renderer '${notation}'`);
  return {
    canvasClassName: spec.canvasClassName,
    // what miragonPlugin(spec).mountEditor does (notations/miragon/plugin.ts)
    mount: async (host, context) => {
      const [{ mountMiragonEditor }, renderer] = await Promise.all([import("@/notations/miragon/editor"), spec.load()]);
      return mountMiragonEditor(spec, renderer, host, context);
    },
  };
}

function throughRegistry(notation: ModelNotation): ProductMount {
  const modules = throughModules(notation);
  return {
    // known before the registry loads, and checked against it below
    canvasClassName: modules.canvasClassName,
    ...(modules.fitInsets ? { fitInsets: modules.fitInsets } : {}),
    mount: async (host, context) => {
      const { webPlugin } = await import("@/notations/registry");
      const plugin = webPlugin(notation);
      if (!plugin?.mountEditor) throw new Error(`no editor plugin for '${notation}'`);
      if (!host.classList.contains(plugin.canvasClassName)) host.classList.add(plugin.canvasClassName);
      return plugin.mountEditor(host, context);
    },
  };
}

export function productMount(notation: ModelNotation, via: Via): ProductMount {
  return via === "registry" ? throughRegistry(notation) : throughModules(notation);
}
