/**
 * Todos on a canvas behind @miragon/modeler-api — the twin of
 * lib/todo-canvas.ts (bpmn-js) for every Miragon renderer (Wardley Maps,
 * Event Storming, Context Maps, Team Topologies), with the same contract
 * (TodoCanvas) and the same lifecycle: one controller per mounted modeler,
 * torn down with it. Framework-free, like its twin: the SPA's Miragon editor
 * (notations/miragon/editor.ts) and the Miragon widgets (mcp-app/todos.ts
 * through miragon-main.ts) both mount it.
 *
 * Everything element-shaped comes from the contract's element surface
 * (`elements`): the DOCUMENT's ids, which every peer, the Live Host and a
 * deep link read from the same text, never the canvas's own. Responsibilities:
 *
 *  - count badges on every element with ≥1 open anchored todo, drawn in an
 *    HTML layer of our own that moves with the canvas (diagram-js overlays
 *    key their elements by canvas id, the surface speaks document ids): the
 *    element's box is the surface's `bounds` (contract 1.2), read live, so a
 *    badge follows an element that is dragged or resized. A badge stands on the
 *    element's top-right corner, just above it (a Wardley component is a
 *    circle smaller than the badge, its label beside it), and never shrinks
 *    below its screen size: these boards are read zoomed out. A renderer without `bounds` gets no badges — the panel
 *    still lists every todo
 *  - an anchor id this canvas does not know is looked up as an element NAME:
 *    the Live Host names a Wardley map's components (get_view), the canvas
 *    ids them `component_<name>` — a todo an agent anchored by name lands on
 *    its component (the presence-canvas rule)
 *  - selection → TodoElementWire[] (`onSelection`), so a new todo anchors to it
 *  - reveal / revealOnce, as on BPMN; the one-shot waits for the first import
 */
import type { TodoWire } from "@designiq/contracts/live-host";

import type { TodoCanvas, TodoCanvasHooks } from "./todo-canvas.ts";

/** an element's box in diagram coordinates */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** the slice of the contract's ElementsSurface the todos read */
export interface TodoElementSurface {
  list(): Array<{ id: string; name?: string }>;
  reveal(id: string): boolean;
  onSelection(cb: (ids: string[]) => void): () => void;
  bounds?(id: string): Box | undefined;
}

/** the diagram-js instance the renderer wraps — STRUCTURALLY (each renderer
 *  pins its own diagram-js copy) */
interface DiagramLike {
  get(service: string): unknown;
  on(event: string, callback: (event?: unknown) => void): void;
  off(event: string, callback: (event?: unknown) => void): void;
}

interface CanvasLike {
  getContainer(): HTMLElement;
  viewbox(): { x: number; y: number; scale: number };
}

export function attachSurfaceTodoCanvas(
  diagram: DiagramLike,
  surface: TodoElementSurface,
  hooks: TodoCanvasHooks,
): TodoCanvas {
  const canvas = diagram.get("canvas") as CanvasLike;
  const container = canvas.getContainer();
  const doc = container.ownerDocument;
  // diagram-js's overlay root: first in the container, zero-sized, moved with
  // the viewbox — so the palette and the context pad stay on top of it
  const layer = doc.createElement("div");
  layer.className = "designiq-todo-layer";
  Object.assign(layer.style, { position: "absolute", width: "0", height: "0", transformOrigin: "top left" });
  container.insertBefore(layer, container.firstChild);

  let todos: TodoWire[] = [];
  let imported = false;
  let pendingReveal: string | null = null;

  /** the surface ids an anchor id lands on: the id itself, else (unknown to
   *  the canvas) every element carrying it as its name */
  const resolver = (): ((anchorId: string) => string[]) => {
    const elements = surface.list();
    const ids = new Set(elements.map((e) => e.id));
    const byName = new Map<string, string[]>();
    for (const { id, name } of elements) if (name) byName.set(name, [...(byName.get(name) ?? []), id]);
    return (anchorId) => (ids.has(anchorId) ? [anchorId] : (byName.get(anchorId) ?? []));
  };

  const reveal = (elementId: string): boolean => {
    if (surface.reveal(elementId)) return true;
    const [named] = resolver()(elementId);
    return named !== undefined && surface.reveal(named);
  };

  const place = (): void => {
    let vb;
    try {
      vb = canvas.viewbox();
    } catch {
      return; // nothing imported yet — no coordinate system to place in
    }
    const scale = vb.scale || 1;
    layer.style.transform = `matrix(${scale}, 0, 0, ${scale}, ${-vb.x * scale}, ${-vb.y * scale})`;
    // zoomed out, a badge keeps its screen size (diagram-js overlays' scale.min 1)
    const keep = scale < 1 ? 1 / scale : 1;
    for (const pin of layer.children) (pin as HTMLElement).style.transform = `translate(-50%, -100%) scale(${keep})`;
  };

  const render = (): void => {
    layer.replaceChildren();
    if (!surface.bounds || todos.length === 0) return;
    const resolve = resolver();
    const counts = new Map<string, number>();
    for (const todo of todos) {
      // one todo counts once per element, even anchored by its id AND its name
      const at = new Set((todo.anchor?.elements ?? []).flatMap((el) => resolve(el.id)));
      for (const id of at) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [elementId, count] of counts) {
      const box = surface.bounds(elementId);
      if (!box) continue; // an anchor gone from the canvas — the panel still lists the todo
      const pin = doc.createElement("div");
      Object.assign(pin.style, {
        position: "absolute",
        left: `${box.x + box.width}px`,
        top: `${box.y}px`,
        // scaled around its foot, which stays on the corner
        transformOrigin: "50% 100%",
      });
      const badge = doc.createElement("button");
      badge.type = "button";
      badge.className = "designiq-todo-badge";
      badge.textContent = String(count);
      badge.title = count === 1 ? "1 open todo" : `${count} open todos`;
      // the canvas must not take the press for a drag, a lasso or a deselect
      badge.addEventListener("pointerdown", (e) => e.stopPropagation());
      badge.addEventListener("mousedown", (e) => e.stopPropagation());
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        hooks.onBadgeClick(elementId);
      });
      pin.append(badge);
      layer.append(pin);
    }
    place();
  };

  // a drag fires elements.changed on every move: one render per frame
  const win = doc.defaultView;
  let frame = 0;
  const scheduleRender = (): void => {
    if (!win?.requestAnimationFrame) return render();
    if (frame === 0) {
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        render();
      });
    }
  };

  const onImportDone = (): void => {
    imported = true;
    render();
    if (pendingReveal !== null) {
      const id = pendingReveal;
      pendingReveal = null; // consume BEFORE revealing — a miss must not re-arm
      reveal(id);
    }
  };

  const offSelection = surface.onSelection((ids) => {
    const names = new Map(surface.list().map((e) => [e.id, e.name]));
    hooks.onSelectionChanged(ids.map((id) => ({ id, name: names.get(id) || null })));
  });
  diagram.on("import.done", onImportDone);
  diagram.on("elements.changed", scheduleRender);
  diagram.on("canvas.viewbox.changed", place);

  return {
    setTodos(next) {
      todos = next;
      render();
    },
    reveal,
    revealOnce(elementId) {
      if (imported) reveal(elementId);
      else pendingReveal = elementId;
    },
    anchorIds(elementId) {
      const name = surface.list().find((e) => e.id === elementId)?.name;
      return name && name !== elementId ? [elementId, name] : [elementId];
    },
    destroy() {
      if (frame !== 0) win?.cancelAnimationFrame(frame);
      offSelection();
      diagram.off("import.done", onImportDone);
      diagram.off("elements.changed", scheduleRender);
      diagram.off("canvas.viewbox.changed", place);
      layer.remove();
    },
  };
}
