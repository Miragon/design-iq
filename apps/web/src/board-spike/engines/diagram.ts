/**
 * What the three mounts share: reading a diagram-js instance structurally (bpmn-js, the DRD viewer,
 * a Miragon renderer's `modeler.diagram` all sit on the one diagram-js copy of the workspace), and
 * the re-routing of its `position: fixed` chrome for the counter strategy.
 */
import type Canvas from "diagram-js/lib/core/Canvas";

import type { DiagramLike, Rect } from "./types.ts";

/** a service of the instance, or undefined where this build registers none (the lookup is strict) */
export function serviceOf<T>(diagram: DiagramLike | undefined, name: string): T | undefined {
  try {
    return diagram?.get(name) as T | undefined;
  } catch {
    return undefined;
  }
}

export const canvasOf = (diagram: DiagramLike | undefined): Canvas | undefined => serviceOf<Canvas>(diagram, "canvas");

const usable = (box: Rect | undefined): box is Rect =>
  !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;

/** the box of everything on the active layer, read fresh (never diagram-js's cached viewbox) */
export function drawnBounds(canvas: Canvas | undefined): Rect | undefined {
  try {
    // `viewbox(false)` recomputes (Canvas.js: `box === false`); the package's types know the cached getter only
    const fresh = canvas as unknown as { viewbox(cached: false): { inner?: Rect } } | undefined;
    const inner = fresh?.viewbox(false).inner;
    return usable(inner) ? { x: inner.x, y: inner.y, width: inner.width, height: inner.height } : undefined;
  } catch {
    return undefined;
  }
}

interface DraggingLike {
  context(): unknown;
  cancel(): void;
}
interface ClosableLike {
  close(): void;
}
interface DirectEditingLike {
  isActive(): boolean;
  complete(): void;
}
interface SelectionLike {
  select(elements: null): void;
}

/** diagram-js's own "a drag exists" read: set from the press on, before the 5 px threshold (Dragging.js) */
export const dragRunning = (diagram: DiagramLike | undefined): boolean =>
  !!serviceOf<DraggingLike>(diagram, "dragging")?.context();

/**
 * What disarming means for any diagram-js instance: no drag, no label editor, no popup, no pad, no
 * selection. A label still being typed is kept (completed), as a click outside the editor keeps it.
 */
export function releaseDiagram(diagram: DiagramLike | undefined): void {
  const attempt = (run: () => void): void => {
    try {
      run();
    } catch {
      /* a build without that service, or one that has nothing open */
    }
  };
  attempt(() => serviceOf<DraggingLike>(diagram, "dragging")?.cancel());
  attempt(() => {
    const editing = serviceOf<DirectEditingLike>(diagram, "directEditing");
    if (editing?.isActive()) editing.complete();
  });
  attempt(() => serviceOf<ClosableLike>(diagram, "popupMenu")?.close());
  attempt(() => serviceOf<ClosableLike>(diagram, "contextPad")?.close());
  attempt(() => serviceOf<SelectionLike>(diagram, "selection")?.select(null));
}

/** subscribes `listener` to `events` of one diagram; returns the unsubscribe */
export function listen(diagram: DiagramLike, events: readonly string[], listener: () => void): () => void {
  // a wrapper of its own per subscription: the same listener may be on several events and diagrams
  const callback = (): void => listener();
  for (const event of events) diagram.on(event, callback);
  return () => {
    for (const event of events) {
      try {
        diagram.off(event, callback);
      } catch {
        /* the instance is destroyed already */
      }
    }
  };
}

interface PopupMenuLike {
  _createContainer(config: { provider: string }): HTMLElement;
}
interface HoverTooltipLike {
  _mount?: HTMLElement | null;
}

/**
 * diagram-js mounts its popup menu (`.djs-popup`) and its palette tooltip (`.djs-hover-tooltip`)
 * inside the canvas container and places them with `position: fixed` and CLIENT coordinates. Under
 * a transformed ancestor a fixed box is laid out against that ancestor, so both land off target by
 * the ancestor's client origin (pointer-math-core.md O2, O3). The repair measured there: mount
 * both in an element outside every transform. Returns the names of what this instance has not.
 */
export function adoptDiagramPopups(diagram: DiagramLike | undefined, popupHost: HTMLElement): string[] {
  const missing: string[] = [];
  const popupMenu = serviceOf<PopupMenuLike>(diagram, "popupMenu");
  if (popupMenu) {
    // replaces PopupMenu.prototype._createContainer (appends to canvas.getContainer()) on the instance
    popupMenu._createContainer = (config) => {
      const container = document.createElement("div");
      container.className = "djs-popup-parent djs-scrollable";
      // selectors such as [data-popup="align-elements"] rely on it
      container.setAttribute("data-popup", String(config.provider));
      popupHost.appendChild(container);
      return container;
    };
  } else missing.push("popupMenu");
  const hoverTooltip = serviceOf<HoverTooltipLike>(diagram, "hoverTooltip");
  if (hoverTooltip) {
    hoverTooltip._mount?.remove();
    const mount = document.createElement("div");
    mount.className = "djs-hover-tooltip-container";
    popupHost.appendChild(mount);
    // HoverTooltip.prototype._getMount creates one in the canvas container only while this is unset
    hoverTooltip._mount = mount;
  } else missing.push("hoverTooltip");
  return missing;
}

/**
 * The classes a popup needs above it to look as in its editor: the engine sheets scope their rules
 * under the canvas host's class, and diagram-js keeps the popup's CSS variables on `.djs-parent`
 * and the bpmn.io theme's on `.bio-theme-parent`. The chain host > ... > canvas container is
 * rebuilt as empty boxes inside `popupHost`; the innermost one is where popups go.
 */
export function mirrorAncestors(
  popupHost: HTMLElement,
  host: HTMLElement,
  container: Element | undefined,
): HTMLElement {
  const chain: Element[] = [];
  for (let element = container; element && element !== host; element = element.parentElement ?? undefined) {
    chain.unshift(element);
  }
  let parent = popupHost;
  for (const element of chain) {
    const box = document.createElement("div");
    box.className = `${element.getAttribute("class") ?? ""} board-popup-host__box`;
    parent.appendChild(box);
    parent = box;
  }
  return parent;
}
