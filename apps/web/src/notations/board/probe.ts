/**
 * The DOM-only view of one mounted editor (EditorProbe). It reads what every diagram-js based engine
 * renders (`data-element-id`, `.djs-visual`, `g.viewport`) and asks no engine anything, so the
 * board page and an embed frame use it unchanged, whatever mounted the editor.
 *
 * Client rectangles are read through native-geometry.ts: the probe measures, so it must answer in
 * true screen geometry while a strategy has the prototypes' functions patched.
 */
import { screenRect } from "./geometry.ts";
import type { Box, EditorProbe } from "./types.ts";

export interface ProbeOptions {
  /** the element the engine was mounted into; it may move to another parent (overlay strategy) */
  host: HTMLElement;
  /** the body-level popup hosts this editor owns right now (counter strategy), read on every query */
  popupHosts?: () => readonly Element[];
  /** the text of this editor's replica */
  text: () => string;
}

const boxOf = (element: Element): Box => {
  const { x, y, width, height } = screenRect(element);
  return { x, y, width, height };
};

export function createProbe({ host, popupHosts, text }: ProbeOptions): EditorProbe {
  return {
    hostBox: () => boxOf(host),
    hostSize: () => ({ width: host.clientWidth, height: host.clientHeight }),
    // a client rect includes every ancestor transform, offsetWidth none: their ratio is the net scale
    netScale: () => screenRect(host).width / host.offsetWidth,
    elementIds: () => {
      // the root's graphics hold other elements' visuals as descendants: only a visual of its own counts
      const ids = [...host.querySelectorAll("[data-element-id] > .djs-visual")].map(
        (visual) => visual.parentElement?.getAttribute("data-element-id") ?? "",
      );
      return [...new Set(ids)];
    },
    elementBox: (id) => {
      const visual = host.querySelector(`[data-element-id="${CSS.escape(id)}"] > .djs-visual`);
      return visual ? boxOf(visual) : null;
    },
    viewportMatrix: () => {
      const matrix = host.querySelector<SVGGElement>("svg g.viewport")?.getCTM();
      return matrix ? { a: matrix.a, d: matrix.d, e: matrix.e, f: matrix.f } : null;
    },
    query: (selector) =>
      [host, ...(popupHosts?.() ?? [])].flatMap((root) => [...root.querySelectorAll(selector)].map(boxOf)),
    text,
  };
}
