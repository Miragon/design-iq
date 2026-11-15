/**
 * How the board reads the screen: an element's client rectangle and a mouse event's client point.
 * Plain DOM calls. The measuring bench swaps in the functions it captured before one of its
 * strategies patched the prototypes (src/board-spike/native-geometry.ts), so the board measures
 * true screen geometry there too.
 */
export interface ScreenGeometry {
  rect(target: Element): DOMRect;
  clientPoint(event: MouseEvent): { x: number; y: number };
}

let geometry: ScreenGeometry = {
  rect: (target) => target.getBoundingClientRect(),
  clientPoint: (event) => ({ x: event.clientX, y: event.clientY }),
};

export const screenRect = (target: Element): DOMRect => geometry.rect(target);
export const clientPoint = (event: MouseEvent): { x: number; y: number } => geometry.clientPoint(event);

export function setScreenGeometry(next: ScreenGeometry): void {
  geometry = next;
}
