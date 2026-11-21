/**
 * Which PRODUCT editor a model node of a board mounts: the plugin the model's own page mounts
 * (WebNotationPlugin.mountEditor, the very call live-editor.tsx makes), found through the
 * registry's own lookup, which the registry hands the board's manifest (plugin.ts). So a model
 * on a board is edited by exactly the editor of its own page, and no board module imports the
 * registry back. For bpmn-js and the DMN DRD it adds the first fit that leaves their own chrome
 * free (SyncOptions.fitInsets), in the host's LAYOUT px: a board scales a preview with a CSS
 * transform, and the editor fits in its canvas's own px.
 *
 * Node-loadable: relative imports, only types from the registry.
 */
import type { FitInsets } from "@designiq/live-client";

import type { EditorContext, MountedEditor, WebNotationPlugin } from "../registry.ts";

/** the registry's lookup (webPlugin): the plugin of a notation id */
export type PluginLookup = (notationId: string) => WebNotationPlugin | undefined;

/** notations a board never shows in place, whatever editor they have */
const NOT_ON_A_BOARD: ReadonlySet<string> = new Set([
  // a board in a node of a board is not supported (the renderer's rule)
  "board",
  // a read-only rendered view whose source is edited in the shell's Monaco: an armed node would
  // offer nothing to edit
  "markdown",
]);

export interface ProductMount {
  /** the class the engine's stylesheets are scoped under: on the element the editor mounts into */
  readonly canvasClassName: string;
  mount(host: HTMLElement, context: EditorContext): Promise<MountedEditor>;
  /**
   * What the editor's own chrome covers of `host`, for its first fit (SyncOptions.fitInsets).
   * bpmn-js and the DRD fit their diagram edge to edge, under their palette and name card, which
   * a canvas of a node's size has no room for. Absent: the editor fits clear of its chrome by
   * itself (the Miragon renderers, notations/miragon/editor.ts spaCanvasInsets)
   */
  fitInsets?(host: HTMLElement): FitInsets;
}

/** room between the diagram and the host's edge or the chrome beside it */
export const FIT_MARGIN = 12;

/**
 * The insets of `host` for a first fit: beside the chrome at its left edge (`left`: a palette)
 * and below the chrome at its top (`top`: a name card), with a margin all around. Read in the
 * host's LAYOUT px whatever scales it on screen; chrome that is hidden and keeps its box (a
 * preview) counts, chrome that is not there or not laid out does not.
 */
export function chromeInsets(host: HTMLElement, chrome: { left?: string; top?: string }): FitInsets {
  const hostBox = host.getBoundingClientRect();
  const scale = host.offsetWidth > 0 && hostBox.width > 0 ? hostBox.width / host.offsetWidth : 1;
  const boxOf = (selector: string | undefined): DOMRect | undefined => {
    const box = selector === undefined ? undefined : host.querySelector(selector)?.getBoundingClientRect();
    return box && box.width > 0 && box.height > 0 ? box : undefined;
  };
  const atLeft = boxOf(chrome.left);
  const atTop = boxOf(chrome.top);
  return {
    top: (atTop ? Math.max(0, (atTop.bottom - hostBox.top) / scale) : 0) + FIT_MARGIN,
    right: FIT_MARGIN,
    bottom: FIT_MARGIN,
    left: (atLeft ? Math.max(0, (atLeft.right - hostBox.left) / scale) : 0) + FIT_MARGIN,
  };
}

/** the chrome of the editors whose first fit the host makes (SyncOptions.fitInsets) */
const CHROME: Readonly<Record<string, { left?: string; top?: string }>> = {
  bpmn: { left: ".djs-palette" },
  // the DRD: its palette at the left, the decision's name card above it
  dmn: { left: ".djs-palette", top: ".dmn-definitions" },
};

/** the product editor a board mounts for `notation`; undefined: the node cannot show it */
export function productMount(notation: string, lookup: PluginLookup): ProductMount | undefined {
  if (NOT_ON_A_BOARD.has(notation)) return undefined;
  const plugin = lookup(notation);
  const mountEditor = plugin?.mountEditor;
  if (!plugin || !mountEditor) return undefined;
  const chrome = Object.hasOwn(CHROME, notation) ? CHROME[notation] : undefined;
  return {
    canvasClassName: plugin.canvasClassName,
    // the shell's own call (live-editor.tsx): the engine's chunk loads here
    mount: (host, context) => mountEditor(host, context),
    ...(chrome ? { fitInsets: (host: HTMLElement) => chromeInsets(host, chrome) } : {}),
  };
}
