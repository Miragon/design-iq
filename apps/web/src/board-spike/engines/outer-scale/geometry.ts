/**
 * What every repair of the outer-scale module shares: the outer scale itself, MEASURED on the
 * element (nothing is passed in), and the three conversions built on it.
 *
 * Vocabulary (pointer-math-core.md, section 2): client px are what `event.clientX` and
 * `getBoundingClientRect()` speak, container px what `style.left`, `clientWidth` and
 * `canvas.scroll()` speak, diagram units what the model speaks. With an outer scale `s`:
 * client = container origin + container px x s. diagram-js hard-wires s = 1.
 */

export interface Point {
  x: number;
  y: number;
}

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** what the module needs of diagram-js's Canvas, structurally */
export interface CanvasLike {
  getContainer(): HTMLElement;
  viewbox(): { x: number; y: number; scale: number };
  scroll(delta?: { dx: number; dy: number }): Point;
}

/**
 * Client px per layout px of `element`: 1 without a scaling ancestor. The client rect's width over
 * `offsetWidth`, read at the moment of the call, so a board zoom under a running gesture is seen
 * by the very next event. `offsetWidth` is a whole number: at a fractional layout width the result
 * is off by up to 0.5 / width.
 */
export function outerScale(element: HTMLElement): number {
  const layout = element.offsetWidth;
  if (layout === 0) return 1;
  const scale = element.getBoundingClientRect().width / layout;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** a client point in diagram units: Dragging.js `toLocalPoint` with the outer scale in the divisor */
export function clientToDiagram(canvas: CanvasLike, client: Point): Point {
  const container = canvas.getContainer();
  const rect = container.getBoundingClientRect();
  const viewbox = canvas.viewbox();
  const layout = container.offsetWidth;
  const scale = viewbox.scale * (layout > 0 && rect.width > 0 ? rect.width / layout : 1);
  return { x: viewbox.x + (client.x - rect.left) / scale, y: viewbox.y + (client.y - rect.top) / scale };
}

/**
 * A client rectangle as the engine expects it: where it would lie if the container kept its
 * client origin and had no outer scale. Code that subtracts the container's client origin from it
 * and writes the difference as container px (`style.left`) is right with this rectangle.
 */
export function unscaledRect(container: HTMLElement, rect: RectLike): DOMRect {
  const origin = container.getBoundingClientRect();
  const layout = container.offsetWidth;
  const scale = layout > 0 && origin.width > 0 ? origin.width / layout : 1;
  return new DOMRect(
    origin.left + (rect.left - origin.left) / scale,
    origin.top + (rect.top - origin.top) / scale,
    (rect.right - rect.left) / scale,
    (rect.bottom - rect.top) / scale,
  );
}

/** a client point where it would lie if the container kept its client origin and had no outer scale */
export function unscaledPoint(container: HTMLElement, client: Point): Point {
  const origin = container.getBoundingClientRect();
  const scale = outerScale(container);
  return { x: origin.left + (client.x - origin.left) / scale, y: origin.top + (client.y - origin.top) / scale };
}

/**
 * A client point as `left` / `top` of a `position: fixed` box inside `parent`. Under a transformed
 * ancestor a fixed box is laid out against that ancestor (here the React Flow node wrapper, which
 * carries a translate), in that ancestor's own px. Origin and scale of that containing block are
 * measured with a fixed probe, so nothing is assumed about which ancestor it is. Without a
 * transformed ancestor the probe reads (0, 0) and 1, and the point comes back as it is.
 */
export function clientToFixed(parent: Element, client: Point): Point {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:0;top:0;width:100px;height:0;margin:0;padding:0;border:0;visibility:hidden;pointer-events:none";
  parent.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  const scale = rect.width > 0 ? rect.width / 100 : 1;
  return { x: (client.x - rect.left) / scale, y: (client.y - rect.top) / scale };
}

/**
 * The canvas as a service sees it that was written for s = 1: every member reads through to the
 * real canvas, bound to it, except the ones in `overrides`. For services whose pointer math lives
 * in a closure of their constructor (Dragging, MoveCanvas, Bendpoints, ConnectionSegmentMove): the
 * unchanged constructor runs with this facade instead of a copy of its code.
 */
export function canvasFacade<C extends object>(canvas: C, overrides: Record<string, unknown>): C {
  return new Proxy(canvas, {
    get(target, key) {
      if (typeof key === "string" && Object.hasOwn(overrides, key)) return overrides[key];
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value.bind(target) as unknown) : value;
    },
  });
}

/**
 * A facade whose `viewbox()` getter reports the scale times the outer scale. `origin + (client -
 * rect) / viewbox.scale`, the conversion Dragging.js and BendpointUtil.js make with the canvas
 * they were given, is exact with it. A call that sets a viewbox passes through unchanged.
 */
export function screenScaledCanvas<C extends CanvasLike>(canvas: C): C {
  return canvasFacade(canvas, {
    viewbox(...args: unknown[]) {
      const viewbox = (canvas.viewbox as (...given: unknown[]) => { scale: number }).apply(canvas, args);
      const reads = args.length === 0 || args[0] === undefined || args[0] === false;
      return reads ? { ...viewbox, scale: viewbox.scale * outerScale(canvas.getContainer()) } : viewbox;
    },
  });
}

/** a facade whose `scroll()` takes client px: MoveCanvas.js hands it pointer deltas */
export function clientScrolledCanvas<C extends CanvasLike>(canvas: C): C {
  return canvasFacade(canvas, {
    scroll(delta?: { dx?: number; dy?: number }) {
      if (!delta) return canvas.scroll();
      const scale = outerScale(canvas.getContainer());
      return canvas.scroll({ dx: (delta.dx ?? 0) / scale, dy: (delta.dy ?? 0) / scale });
    },
  });
}
