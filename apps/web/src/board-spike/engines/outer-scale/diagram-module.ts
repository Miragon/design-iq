/**
 * The outer-scale module for ONE diagram-js instance (bpmn-js, the DRD of dmn-js, the diagram of a
 * Miragon renderer). The table of layers, sites and mechanisms is in index.ts.
 *
 * Nothing here patches a prototype or anything else that is shared between instances: a service is
 * replaced by name in this instance's injector, or a member is set on this instance's own service
 * object. An editor without the module (every other strategy on the same page) runs the engine's
 * code as it is.
 */
import Bendpoints from "diagram-js/lib/features/bendpoints/Bendpoints";
import ConnectionSegmentMove from "diagram-js/lib/features/bendpoints/ConnectionSegmentMove";
import Dragging from "diagram-js/lib/features/dragging/Dragging";
import MoveCanvas from "diagram-js/lib/navigation/movecanvas/MoveCanvas";
import ZoomScroll from "diagram-js/lib/navigation/zoomscroll/ZoomScroll";
import type { ModuleDeclaration } from "didi";

import {
  type CanvasLike,
  clientScrolledCanvas,
  clientToDiagram,
  clientToFixed,
  outerScale,
  type Point,
  type RectLike,
  screenScaledCanvas,
  unscaledPoint,
  unscaledRect,
} from "./geometry.ts";
import type { Layer } from "./layers.ts";

/** before every listener of the engine: snapping, previews and auto-scroll read what this one wrote */
const FIRST = 100_000;
/** two sizes of a label editor's box are the same below this many container px (layout snaps to 1/64 px) */
const SAME_SIZE = 0.05;

interface EventBusLike {
  on(events: string | string[], priority: number, callback: (event: Record<string, unknown>) => void): void;
}
interface InjectorLike {
  get(name: string, strict?: boolean): unknown;
}

/** Dragging.js keeps its state in one object and hands it out "for introspection" (`dragging.context()`) */
interface DragContext {
  globalStart: Point;
  localStart: Point;
  displacement: Point;
  payload: Record<string, unknown>;
}
interface DraggingLike {
  context(): DragContext | null | undefined;
}
interface ContextPadLike {
  _getTargetBounds?(target: unknown): RectLike;
}
interface PopupMenuLike {
  _ensureVisible?(popup: HTMLElement, position: Point): Point;
}
interface HoverTooltipSource {
  getPosition(target: HTMLElement): Point & { placement?: string };
}
interface HoverTooltipLike {
  add?(config: HoverTooltipSource): void;
}
interface DirectEditingLike {
  $textbox?: HTMLElement;
  _active?: { context?: { bounds?: { width: number; height: number } } } | null;
}

/** the argument list of a service's constructor with its `canvas` replaced */
function withCanvas<A extends unknown[]>(inject: readonly string[], args: A, wrap: (canvas: CanvasLike) => unknown): A {
  const index = inject.indexOf("canvas");
  if (index < 0) return args;
  const next = [...args];
  next[index] = wrap(args[index] as CanvasLike);
  return next as A;
}

// ── services replaced by name (didi: a later module's entry wins) ────────────

/**
 * `dragsvc`: Dragging.js as it is, constructed with a canvas whose viewbox scale carries the outer
 * scale. Its private `toLocalPoint` is then exact, and with it localStart, displacement and every
 * payload. The alternative to the `drag` layer's event correction, not its companion.
 */
class ScaledDragging extends Dragging {
  static override $inject = [...Dragging.$inject];
  constructor(...args: ConstructorParameters<typeof Dragging>) {
    super(...withCanvas(Dragging.$inject, args, screenScaledCanvas));
  }
}

/** `pan`: MoveCanvas.js as it is, on a canvas whose `scroll()` takes the pointer's client px */
class ScaledMoveCanvas extends MoveCanvas {
  static override $inject = [...MoveCanvas.$inject];
  constructor(...args: ConstructorParameters<typeof MoveCanvas>) {
    super(...withCanvas(MoveCanvas.$inject, args, clientScrolledCanvas));
  }
}

/** `bend`: both callers of BendpointUtil.js `toCanvasCoordinates(canvas, event)`, as they are, on the scaled canvas */
class ScaledBendpoints extends Bendpoints {
  static override $inject = [...Bendpoints.$inject];
  constructor(...args: ConstructorParameters<typeof Bendpoints>) {
    super(...withCanvas(Bendpoints.$inject, args, screenScaledCanvas));
  }
}
class ScaledConnectionSegmentMove extends ConnectionSegmentMove {
  static override $inject = [...ConnectionSegmentMove.$inject];
  constructor(...args: ConstructorParameters<typeof ConnectionSegmentMove>) {
    super(...withCanvas(ConnectionSegmentMove.$inject, args, screenScaledCanvas));
  }
}

/**
 * `wheel`: ZoomScroll.js `_handleWheel` hands `this.zoom()` the pointer's offset from the
 * container's client corner and `this.scroll()` the wheel's px. `canvas.zoom(scale, center)` and
 * `canvas.scroll(delta)` take container px, so both are divided by the outer scale on the way.
 * `stepZoom()` (keys and buttons) passes no client position and is left alone.
 */
class ScaledZoomScroll extends ZoomScroll {
  static override $inject = [...ZoomScroll.$inject];
  private readonly scaledContainer: HTMLElement;

  constructor(...args: ConstructorParameters<typeof ZoomScroll>) {
    super(...args);
    this.scaledContainer = (args[2] as unknown as CanvasLike).getContainer();
  }

  override zoom(delta: number, position: Point): void {
    const scale = outerScale(this.scaledContainer);
    // no position: the caller wants the middle of the canvas (Canvas.js zoom)
    super.zoom(delta, position ? { x: position.x / scale, y: position.y / scale } : position);
  }

  override scroll(delta: { dx?: number; dy?: number }): void {
    const scale = outerScale(this.scaledContainer);
    super.scroll({ dx: (delta.dx ?? 0) / scale, dy: (delta.dy ?? 0) / scale });
  }
}

// ── repairs on this instance's own service objects ───────────────────────────

const clientPoint = (event: unknown): Point | null => {
  let source = event as { clientX?: number; clientY?: number; touches?: ArrayLike<unknown> } | null | undefined;
  // as diagram-js util/Event.js toPoint: the first touch stands for a touch event
  if (source?.touches && source.touches.length > 0) source = source.touches[0] as typeof source;
  return source && typeof source.clientX === "number" && typeof source.clientY === "number"
    ? { x: source.clientX, y: source.clientY }
    : null;
};

/**
 * `drag`: Dragging.js fires the generic `drag.<type>` on the event bus before the prefixed event
 * (shape.move.move, create.move, connect.move, resize.move, lasso.move, bendpoint.move.move ...),
 * both with ONE event object built from the context's payload. A listener that comes first
 * recomputes the coordinates from the pointer event and writes them into that event and into the
 * payload (hover, out and end are built from the payload again).
 */
function correctDragEvents(eventBus: EventBusLike, canvas: CanvasLike, dragging: DraggingLike): void {
  eventBus.on("drag.init", FIRST, () => {
    const context = dragging.context();
    if (!context?.globalStart || !context.localStart || !context.displacement) return;
    const start = clientToDiagram(canvas, context.globalStart);
    const { localStart: wrong, displacement } = context;
    // localStart + displacement is the point the caller asked the drag to be relative to. Without
    // one, Dragging.js took its own (wrong) localStart for it and the displacement is zero
    const given = displacement.x !== 0 || displacement.y !== 0;
    context.displacement = given
      ? { x: wrong.x + displacement.x - start.x, y: wrong.y + displacement.y - start.y }
      : { x: 0, y: 0 };
    context.localStart = start;
  });
  eventBus.on("drag.move", FIRST, (event) => {
    const context = dragging.context();
    const client = clientPoint(event.originalEvent);
    if (!context?.localStart || !context.displacement || !client) return;
    const current = clientToDiagram(canvas, client);
    const exact = {
      x: Math.round(current.x + context.displacement.x),
      y: Math.round(current.y + context.displacement.y),
      dx: Math.round(current.x - context.localStart.x),
      dy: Math.round(current.y - context.localStart.y),
    };
    Object.assign(event, exact);
    Object.assign(context.payload, exact);
  });
}

/**
 * `pad`: ContextPad.js `_getPosition` writes (target's client rect - container's client rect) as
 * container px. `_getTargetBounds` is where the target's rectangle comes from (Wardley's ContextPad
 * subclass overrides exactly this method, and is kept: its result is converted, not replaced).
 */
function correctContextPad(contextPad: ContextPadLike, container: HTMLElement): void {
  const measure = contextPad._getTargetBounds;
  if (typeof measure !== "function") return;
  contextPad._getTargetBounds = function (this: ContextPadLike, target: unknown): RectLike {
    return unscaledRect(container, measure.call(this, target));
  };
}

/** set on a popup whose width this module pinned: the next placement measures it again */
const PINNED = "data-outer-scale-width";

/**
 * `popup`: PopupMenu.js `_ensureVisible` takes the popup's position in client px, flips it against
 * the document where it would not fit (client px against client px: right as it is), and the
 * result becomes `left` / `top` of the `position: fixed` `.djs-popup`. Converted here into the px
 * of the fixed box's containing block, so the popup stays in the node and scales with the board.
 * That containing block is only as wide as the node: a popup without a width of its own, placed
 * near its right edge, would shrink to what is left of it. Such a popup is pinned to the width it
 * has at the block's left edge.
 */
function correctPopupMenu(popupMenu: PopupMenuLike, container: HTMLElement): void {
  const place = popupMenu._ensureVisible;
  if (typeof place !== "function") return;
  popupMenu._ensureVisible = function (this: PopupMenuLike, popup: HTMLElement, position: Point): Point {
    const placed = place.call(this, popup, position);
    if (getComputedStyle(popup).position !== "fixed") return placed;
    if (popup.hasAttribute(PINNED)) popup.style.width = "";
    if (popup.style.width === "") {
      // PopupMenuComponent.js writes left and top from what this returns, right after
      Object.assign(popup.style, { left: "0px", top: "0px" });
      popup.style.width = `${popup.offsetWidth}px`;
      popup.setAttribute(PINNED, "");
    }
    return clientToFixed(popup.parentElement ?? container, placed);
  };
}

/**
 * `tip`: HoverTooltip.js renders `.djs-hover-tooltip` (`position: fixed`) at what the registered
 * source's `getPosition` returns, which PaletteTooltip.js computes from the entry's client rect.
 * Every source registered from now on answers in the px of the fixed box's containing block.
 */
function correctHoverTooltip(hoverTooltip: HoverTooltipLike, container: HTMLElement): void {
  const add = hoverTooltip.add;
  if (typeof add !== "function") return;
  hoverTooltip.add = function (this: HoverTooltipLike, config: HoverTooltipSource): void {
    add.call(this, {
      ...config,
      getPosition(target: HTMLElement) {
        const position = config.getPosition(target);
        return { ...position, ...clientToFixed(container, position) };
      },
    });
  };
}

/**
 * `edit`: DirectEditing.js `complete` compares the text box's client rect with the bounds it opened
 * with (container px) by `!==` and hands the provider the client rect as the new bounds; TextBox.js
 * `autoResize` reads the same rect. The one element both read (`directEditing.$textbox`, kept for
 * the service's life) answers in container px from its first activation on. A size within
 * SAME_SIZE of the bounds the editor opened with IS those bounds: a client size divided by a
 * measured scale never meets a `!==` otherwise.
 */
function correctDirectEditing(eventBus: EventBusLike, directEditing: DirectEditingLike, container: HTMLElement): void {
  const same = (value: number, opened: number | undefined): number =>
    opened !== undefined && Math.abs(value - opened) < SAME_SIZE ? opened : value;
  eventBus.on("directEditing.activate", FIRST, () => {
    const textbox = directEditing.$textbox;
    if (!textbox || Object.hasOwn(textbox, "getBoundingClientRect")) return;
    textbox.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      const rect = unscaledRect(container, Element.prototype.getBoundingClientRect.call(this));
      const opened = directEditing._active?.context?.bounds;
      return new DOMRect(rect.x, rect.y, same(rect.width, opened?.width), same(rect.height, opened?.height));
    };
  });
}

/** a pointer event as the renderers' own code reads it: `clientX` and `clientY`, nothing else */
interface ClientEvent {
  clientX: number;
  clientY: number;
}
/** the renderers' draw tools and drawing handles: `(clientX - rect.left) / zoom + viewbox.x`, then their own grid */
interface PointServiceLike {
  toCanvasPoint?(event: ClientEvent): Point;
}
interface PaletteTooltipLike {
  placeBelowPalette?(tooltip: HTMLElement, entry: HTMLElement): void;
}
interface TeamBandLike {
  isInTeamBand?(element: unknown, event: Partial<ClientEvent> | null | undefined): boolean;
}

/** services of the Miragon renderers that convert a pointer event with a private `toCanvasPoint(event)` */
const OWN_POINT_SERVICES = [
  "wardleyDrawTool",
  "wardleyDrawingHandles",
  "eventStormingDrawTool",
  "eventStormingDrawingHandles",
] as const;

/**
 * `own`: three sites in the Miragon renderers' OWN code, reached by the private name of a service
 * and of its method. Each is wrapped on the instance and fed client coordinates as they would be
 * without the outer scale, so the renderer's formula (and Wardley's grid behind it) runs unchanged.
 * - the draw tools and drawing handles of Wardley and Event Storming: `toCanvasPoint(event)`;
 * - the palette tooltip of all five (`paletteTooltip.placeBelowPalette`, the same private name in
 *   each bundle): a client rect difference written as container px;
 * - Context Maps `cmLabelEditing.isInTeamBand(element, event)`: a client offset compared with
 *   container px decides whether a double-click edits a context's name or its team.
 */
function correctRendererServices(service: <T>(name: string) => T | null, container: HTMLElement): void {
  for (const name of OWN_POINT_SERVICES) {
    const tool = service<PointServiceLike>(name);
    const convert = tool?.toCanvasPoint;
    if (!tool || typeof convert !== "function") continue;
    tool.toCanvasPoint = function (this: PointServiceLike, event: ClientEvent): Point {
      const point = unscaledPoint(container, { x: event.clientX, y: event.clientY });
      return convert.call(this, { clientX: point.x, clientY: point.y });
    };
  }

  const tooltip = service<PaletteTooltipLike>("paletteTooltip");
  const place = tooltip?.placeBelowPalette;
  if (tooltip && typeof place === "function") {
    tooltip.placeBelowPalette = function (this: PaletteTooltipLike, element: HTMLElement, entry: HTMLElement): void {
      place.call(this, element, entry);
      const scale = outerScale(container);
      const below = (entry.closest(".djs-palette") ?? entry).getBoundingClientRect().bottom;
      const drop = below - container.getBoundingClientRect().top;
      // left: a client offset (its clamp to the container's edges too). top: the palette's client
      // bottom plus the renderer's own gap, which is kept as it is
      element.style.left = `${parseFloat(element.style.left) / scale}px`;
      element.style.top = `${drop / scale + (parseFloat(element.style.top) - drop)}px`;
    };
  }

  const editing = service<TeamBandLike>("cmLabelEditing");
  const inBand = editing?.isInTeamBand;
  if (editing && typeof inBand === "function") {
    editing.isInTeamBand = function (this: TeamBandLike, element, event): boolean {
      if (typeof event?.clientY !== "number") return inBand.call(this, element, event);
      const point = unscaledPoint(container, { x: event.clientX ?? 0, y: event.clientY });
      return inBand.call(this, element, { clientX: point.x, clientY: point.y });
    };
  }
}

/** the module's one eager service: applies the instance repairs of the layers that are on */
class OuterScale {
  static $inject = ["injector", "eventBus", "canvas", "outerScaleLayers"];
  /** for a script: `diagram.get("outerScale").layers` */
  readonly layers: readonly Layer[];
  private readonly container: HTMLElement;

  constructor(injector: InjectorLike, eventBus: EventBusLike, canvas: CanvasLike, layers: readonly Layer[]) {
    this.layers = layers;
    this.container = canvas.getContainer();
    const container = this.container;
    const on = (layer: Layer): boolean => layers.includes(layer);
    // null where this engine registers no such service (`false`: no throw)
    const service = <T>(name: string): T | null => (injector.get(name, false) as T | null | undefined) ?? null;

    const dragging = service<DraggingLike>("dragging");
    if (on("drag") && dragging) correctDragEvents(eventBus, canvas, dragging);
    const contextPad = service<ContextPadLike>("contextPad");
    if (on("pad") && contextPad) correctContextPad(contextPad, container);
    const popupMenu = service<PopupMenuLike>("popupMenu");
    if (on("popup") && popupMenu) correctPopupMenu(popupMenu, container);
    const hoverTooltip = service<HoverTooltipLike>("hoverTooltip");
    if (on("tip") && hoverTooltip) correctHoverTooltip(hoverTooltip, container);
    const directEditing = service<DirectEditingLike>("directEditing");
    if (on("edit") && directEditing) correctDirectEditing(eventBus, directEditing, container);
    if (on("own")) correctRendererServices(service, container);
  }

  /** the outer scale the module works with right now */
  scale(): number {
    return outerScale(this.container);
  }
}

/**
 * The module for a diagram-js instance with the given layers on. A service named here is only
 * constructed where the engine asks for it: an engine without bendpoints never builds one.
 */
export function outerScaleDiagramModule(layers: readonly Layer[]): ModuleDeclaration {
  const on = (layer: Layer): boolean => layers.includes(layer);
  return {
    __init__: ["outerScale"],
    outerScale: ["type", OuterScale],
    outerScaleLayers: ["value", layers],
    ...(on("dragsvc") ? { dragging: ["type", ScaledDragging] } : {}),
    ...(on("pan") ? { moveCanvas: ["type", ScaledMoveCanvas] } : {}),
    ...(on("wheel") ? { zoomScroll: ["type", ScaledZoomScroll] } : {}),
    ...(on("bend")
      ? { bendpoints: ["type", ScaledBendpoints], connectionSegmentMove: ["type", ScaledConnectionSegmentMove] }
      : {}),
  };
}
