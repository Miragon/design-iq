/**
 * The browser's own geometry functions, captured when this module is evaluated. Both entries import
 * it FIRST (main.tsx, embed-main.ts), so that is before any strategy code runs.
 *
 * Why: the `shim` strategy patches these functions on their prototypes while a node is armed, to
 * give the armed editor an unscaled coordinate space. Everything that MEASURES reads through this
 * module instead (probe.ts, test-hooks.ts, and the harness's evaluate snippets through
 * `window.__boardSpikeNative`), so a measurement is in true screen geometry whatever a strategy
 * patched. Engines and strategies do not import it: they see what a strategy gives them. The board
 * itself reads the screen through notations/board/geometry.ts, which gets these functions below.
 *
 * Every caller takes its receiver as the first argument and calls the captured function on it, so
 * an element or a document of another same-origin realm works too.
 */
import { setScreenGeometry } from "../notations/board/geometry.ts";
import { NATIVE_KEY, type NativeGeometry } from "./shared.ts";

interface CaretDocument {
  caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?(x: number, y: number): Range | null;
}

function capture(): NativeGeometry {
  const element = Element.prototype;
  const range = Range.prototype;
  const page = Document.prototype;
  const caret = Document.prototype as unknown as CaretDocument;
  const natives = {
    elementRect: element.getBoundingClientRect,
    elementRects: element.getClientRects,
    rangeRect: range.getBoundingClientRect,
    rangeRects: range.getClientRects,
    fromPoint: page.elementFromPoint,
    allFromPoint: page.elementsFromPoint,
    screenCTM: SVGGraphicsElement.prototype.getScreenCTM,
    caretPosition: caret.caretPositionFromPoint,
    caretRange: caret.caretRangeFromPoint,
    clientX: Object.getOwnPropertyDescriptor(MouseEvent.prototype, "clientX")?.get as (this: MouseEvent) => number,
    clientY: Object.getOwnPropertyDescriptor(MouseEvent.prototype, "clientY")?.get as (this: MouseEvent) => number,
  };
  // not `instanceof`: a range of a frame's document is no Range of this realm
  const isElement = (target: Element | Range): target is Element => "nodeType" in target;
  return Object.freeze<NativeGeometry>({
    rect: (target) => (isElement(target) ? natives.elementRect.call(target) : natives.rangeRect.call(target)),
    clientRects: (target) => (isElement(target) ? natives.elementRects.call(target) : natives.rangeRects.call(target)),
    elementFromPoint: (root, x, y) => natives.fromPoint.call(root, x, y),
    elementsFromPoint: (root, x, y) => natives.allFromPoint.call(root, x, y),
    screenCTM: (target) => natives.screenCTM.call(target),
    caretFromPoint: (root, x, y) => {
      if (natives.caretPosition) {
        const position = natives.caretPosition.call(root, x, y);
        return position && { node: position.offsetNode, offset: position.offset };
      }
      const found = natives.caretRange?.call(root, x, y);
      return found ? { node: found.startContainer, offset: found.startOffset } : null;
    },
    clientPoint: (event) => ({ x: natives.clientX.call(event), y: natives.clientY.call(event) }),
  });
}

/**
 * The first evaluation in a window wins: a second one (a hot update while a person has the page
 * open) would capture whatever a strategy has patched in by then.
 */
const published = (window as unknown as Record<string, NativeGeometry | undefined>)[NATIVE_KEY];
export const nativeGeometry: NativeGeometry = published ?? capture();
if (!published) Object.assign(window, { [NATIVE_KEY]: nativeGeometry });

// the board measures through the captured functions too, whatever a strategy patches later
setScreenGeometry({ rect: nativeGeometry.rect, clientPoint: nativeGeometry.clientPoint });

export const nativeRect = nativeGeometry.rect;
export const nativeClientRects = nativeGeometry.clientRects;
export const nativeElementFromPoint = nativeGeometry.elementFromPoint;
export const nativeElementsFromPoint = nativeGeometry.elementsFromPoint;
export const nativeScreenCTM = nativeGeometry.screenCTM;
export const nativeCaretFromPoint = nativeGeometry.caretFromPoint;
export const nativeClientPoint = nativeGeometry.clientPoint;
