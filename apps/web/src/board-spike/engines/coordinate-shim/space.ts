/**
 * The virtual coordinate space of ONE armed engine host.
 *
 * A probe element inside the host, `position: fixed; left: 0; top: 0` and 512 layout px wide and
 * high, is laid out by the browser against the containing block that every fixed descendant of the
 * host uses. Its TRUE client rectangle therefore is the measurement the space is defined by:
 *
 *   O = (rect.x, rect.y)          the containing block's client origin
 *   s = rect.width / 512          the net scale between the host's layout px and the screen
 *   v = (p - O) / s               a true client point p in the virtual space
 *
 * Nothing about the board is assumed: no class name, no transform string, no zoom from a store. A
 * fixed box with `left: v.x; top: v.y` inside the host lands under p because the probe is such a box.
 *
 * O and s change with a board pan, a board zoom and a move of the node. How long a reading is
 * trusted is the `read` mode: "job" (default) reads once per synchronous job that asks, so a value
 * is never older than the code that uses it; "tick" and "arm" are for measuring what a stale
 * reading costs.
 */
import { natives } from "./natives.ts";

export interface Frame {
  /** true client origin of the containing block of the host's fixed descendants */
  ox: number;
  oy: number;
  /** screen px per layout px of the host, per axis */
  sx: number;
  sy: number;
}

/** "job": fresh in every synchronous job. "tick": until invalidate(). "arm": the first reading for good */
export type ReadMode = "job" | "tick" | "arm";

/**
 * Layout px of the probe: wide enough that the float rectangle gives the scale to seven digits, and
 * no wider than a node, so that it adds no scrollable overflow to anything around it.
 */
const PROBE_SIZE = 512;

/** true client coordinates beyond which a fixed descendant of the host is not visible */
export interface Limits {
  right: number;
  bottom: number;
}

export interface SpaceInfo {
  nodeId: string;
  frame: Frame | null;
  /** the ancestors found to clip a fixed descendant of the host */
  clippedBy: string[];
  /** how often the probe was read */
  reads: number;
  /** the ancestor found to establish the containing block, and why: null when it is the viewport */
  containingBlock: { element: string; because: string; originError: number } | null;
}

export interface Space {
  readonly host: HTMLElement;
  readonly nodeId: string;
  /** the host's ancestors up to the document element: what an editor measures around itself */
  readonly ancestors: ReadonlySet<Element>;
  /** null while the host has no layout box (detached, display: none) */
  frame(): Frame | null;
  /**
   * Where a fixed descendant of the host stops being visible, at the right and at the bottom: the
   * window's edges, or sooner an ancestor of the containing block that clips (the board's own box).
   * A frame's window ends where the frame is clipped; this is the same for the virtual window.
   */
  limits(windowWidth: number, windowHeight: number): Limits;
  /** "tick" mode: the board moved, read again at the next use */
  invalidate(): void;
  info(): SpaceInfo;
  destroy(): void;
}

const describe = (element: Element): string => {
  const classes = (element.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
  return [element.tagName.toLowerCase(), ...classes].join(".");
};

/** why `element` is the containing block of its fixed descendants, or null when it is not (CSS Positioned Layout 3, section 2.1) */
function establishesFixedContainingBlock(element: Element): string | null {
  const style = getComputedStyle(element);
  if (style.transform !== "none") return `transform: ${style.transform}`;
  if (style.translate !== "none") return `translate: ${style.translate}`;
  if (style.scale !== "none") return `scale: ${style.scale}`;
  if (style.rotate !== "none") return `rotate: ${style.rotate}`;
  if (style.perspective !== "none") return `perspective: ${style.perspective}`;
  if (style.filter !== "none") return `filter: ${style.filter}`;
  if (style.backdropFilter !== "none" && style.backdropFilter !== "") return `backdropFilter: ${style.backdropFilter}`;
  if (/\b(?:layout|paint|strict|content)\b/.test(style.contain)) return `contain: ${style.contain}`;
  if (/\b(?:transform|perspective|filter|translate|scale|rotate)\b/.test(style.willChange)) {
    return `will-change: ${style.willChange}`;
  }
  if (style.contentVisibility === "auto") return "content-visibility: auto";
  return null;
}

export function createSpace(host: HTMLElement, nodeId: string, mode: ReadMode): Space {
  const probe = document.createElement("div");
  probe.dataset.boardShimProbe = nodeId;
  probe.setAttribute("aria-hidden", "true");
  // inline on purpose: no sheet rule may ever change what this box measures
  probe.style.cssText = [
    "position: fixed",
    "left: 0",
    "top: 0",
    `width: ${PROBE_SIZE}px`,
    `height: ${PROBE_SIZE}px`,
    "margin: 0",
    "padding: 0",
    "border: 0",
    "visibility: hidden",
    "pointer-events: none",
    "transform: none",
    "z-index: -1",
  ].join("; ");
  host.appendChild(probe);

  const ancestors = new Set<Element>();
  for (let element = host.parentElement; element; element = element.parentElement) ancestors.add(element);

  // Which ancestors clip a fixed descendant: those of its containing block that do not show their
  // overflow. Found once, when the node is armed: a sheet that changes an ancestor's overflow or
  // transform while the node is armed goes unseen.
  let block: Element | null = null;
  for (let element = host as Element | null; element && !block; element = element.parentElement) {
    if (establishesFixedContainingBlock(element)) block = element;
  }
  const clippers: Array<{ element: Element; x: boolean; y: boolean }> = [];
  for (let element = block?.parentElement ?? null; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    const [x, y] = [style.overflowX !== "visible", style.overflowY !== "visible"];
    // the document element's overflow is the window's own scrolling, no clip inside it
    if ((x || y) && element !== document.documentElement) clippers.push({ element, x, y });
  }

  let cached: Frame | null = null;
  let valid = false;
  let reads = 0;
  const expire = (): void => void (valid = false);

  function limits(windowWidth: number, windowHeight: number): Limits {
    let [right, bottom] = [windowWidth, windowHeight];
    for (const { element, x, y } of clippers) {
      const rect = natives.elementRect.call(element);
      if (x) right = Math.min(right, rect.right);
      if (y) bottom = Math.min(bottom, rect.bottom);
    }
    return { right, bottom };
  }

  function frame(): Frame | null {
    if (valid) return cached;
    // an engine that empties its container takes the probe with it: without it the shim would be off, silently
    if (probe.parentNode !== host) host.appendChild(probe);
    const rect = natives.elementRect.call(probe);
    reads++;
    cached =
      rect.width > 0 && rect.height > 0
        ? { ox: rect.x, oy: rect.y, sx: rect.width / PROBE_SIZE, sy: rect.height / PROBE_SIZE }
        : null;
    valid = true;
    // the job that asked may ask again; the next job reads for itself
    if (mode === "job") queueMicrotask(expire);
    return cached;
  }

  function containingBlock(): SpaceInfo["containingBlock"] {
    const now = frame();
    if (!now) return null;
    for (let element = host as Element | null; element; element = element.parentElement) {
      const because = establishesFixedContainingBlock(element);
      if (!because) continue;
      // a fixed box is placed against the padding box: the border lies outside it
      const rect = natives.elementRect.call(element);
      const expected = { x: rect.x + element.clientLeft * now.sx, y: rect.y + element.clientTop * now.sy };
      return {
        element: describe(element),
        because,
        originError: Math.max(Math.abs(expected.x - now.ox), Math.abs(expected.y - now.oy)),
      };
    }
    return null;
  }

  return {
    host,
    nodeId,
    ancestors,
    frame,
    limits,
    invalidate() {
      if (mode !== "arm") valid = false;
    },
    info: () => ({
      nodeId,
      frame: frame(),
      clippedBy: clippers.map(({ element }) => describe(element)),
      reads,
      containingBlock: containingBlock(),
    }),
    destroy() {
      probe.remove();
      valid = true;
      cached = null;
    },
  };
}
