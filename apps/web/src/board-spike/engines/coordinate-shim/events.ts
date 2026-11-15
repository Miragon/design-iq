/**
 * Part `events`: a pointer event that belongs to the armed editor carries virtual coordinates.
 *
 * WHICH events: the target is inside the armed host, or a press began inside it and is not released
 * yet (the engines listen on the document during a drag, the pointer may be anywhere). A press that
 * began OUTSIDE the host belongs to the board until it is released, also while it moves over the
 * editor (a node drag, a resize, an arrow being drawn must keep true coordinates).
 *
 * HOW: own data properties on the event instance (clientX, clientY, x, y, pageX, pageY), set in a
 * capture listener on window, the first stop of every dispatch. Not prototype getters: a getter
 * would run for every coordinate read of every mouse event on the page, and it would have to
 * recompute the space at read time, when the board may have moved since the event. An own property
 * is written once, with the space of that moment, and costs events outside the scope nothing.
 * Every listener on the page gets the same event object, React Flow's too.
 *
 * A mouse, wheel or drag event carries whole virtual px (modifier `whole`), as the browser gives
 * any document: a frame's mouse events are whole px of the frame. An engine that writes a pointer
 * delta into its file unrounded (table-js's column width) would write fractions otherwise.
 *
 * Only trusted events are converted. An event an engine dispatches itself (Wardley's keyboard
 * placement builds a MouseEvent from a client rectangle) is made of virtual numbers already.
 *
 * NOT virtualised: offsetX / offsetY (Chromium reports them in the target's own untransformed box
 * already), movementX / movementY and screenX / screenY (no engine here reads them for geometry),
 * the events of getCoalescedEvents() and Touch objects.
 */
import { natives } from "./natives.ts";
import type { Space } from "./space.ts";
import { eventSpaces, options, setLateScope, spaceOf, spaces, stats } from "./state.ts";

/** bubbling pointer input: seen at the window whatever the target */
const WINDOW_TYPES = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "pointerover",
  "pointerout",
  "gotpointercapture",
  "lostpointercapture",
  "mousedown",
  "mousemove",
  "mouseup",
  "mouseover",
  "mouseout",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "wheel",
  "dragstart",
  "drag",
  "dragenter",
  "dragleave",
  "dragover",
  "drop",
  "dragend",
] as const;
/**
 * Not bubbling, and costly to listen for at the window (the browser then dispatches one per entered
 * ancestor, page-wide). On the host their capture phase passes for every target inside it.
 */
const HOST_TYPES = ["pointerenter", "pointerleave", "mouseenter", "mouseleave"] as const;
/** with no button down, one of these proves that a press we lost the release of is over */
const HOVER_TYPES = new Set(["pointermove", "mousemove", "pointerover", "mouseover", "wheel"]);

/** who has the press that is down: an armed space, the board (null), or nobody (undefined) */
let owner: Space | null | undefined;

const targetSpace = (event: Event): Space | null => (event.target instanceof Node ? spaceOf(event.target) : null);

/** bit of `buttons` for the button a mousedown reports */
const BUTTON_BIT = [1, 4, 2, 8, 16];
const firstButton = (event: MouseEvent): boolean => event.buttons === (BUTTON_BIT[event.button] ?? 0);

const fixed = (value: number): PropertyDescriptor => ({ value, configurable: true, enumerable: true });

function onInput(event: Event): void {
  if (spaces.length === 0) return;
  const input = event as MouseEvent;
  stats.events.seen++;
  const { type } = event;
  // a pointerdown is always a first button; a mousedown may be a second one of a press that is owned
  if (type === "pointerdown" || (type === "mousedown" && firstButton(input))) owner = targetSpace(event);
  else if (owner !== undefined && input.buttons === 0 && HOVER_TYPES.has(type)) owner = undefined;
  const space = owner !== undefined ? owner : targetSpace(event);
  eventSpaces.set(event, space);
  if (!space) return;
  stats.events.inScope++;
  if (!options.parts.events || !event.isTrusted) return;
  const frame = space.frame();
  if (!frame) return;
  let x = (natives.clientX.call(input) - frame.ox) / frame.sx;
  let y = (natives.clientY.call(input) - frame.oy) / frame.sy;
  // Chromium floors a MouseEvent's position to whole px of its document and leaves a PointerEvent's fractional
  if (options.whole && !(event instanceof PointerEvent)) {
    x = Math.floor(x);
    y = Math.floor(y);
  }
  Object.defineProperties(event, {
    clientX: fixed(x),
    clientY: fixed(y),
    x: fixed(x),
    y: fixed(y),
    // the virtual document is as scrolled as the true one (the board page does not scroll)
    pageX: fixed(x + window.scrollX),
    pageY: fixed(y + window.scrollY),
  });
  stats.events.converted++;
}

// an event the listeners did not see (a key, a focus, a type not listened for): by its target, or by the press
setLateScope((event) => (owner !== undefined && event instanceof MouseEvent ? owner : targetSpace(event)));

const CAPTURE = { capture: true, passive: true } as const;

export function listenWindow(): () => void {
  for (const type of WINDOW_TYPES) window.addEventListener(type, onInput, CAPTURE);
  return () => {
    for (const type of WINDOW_TYPES) window.removeEventListener(type, onInput, CAPTURE);
    owner = undefined;
  };
}

export function listenHost(host: HTMLElement): () => void {
  for (const type of HOST_TYPES) host.addEventListener(type, onInput, CAPTURE);
  return () => {
    for (const type of HOST_TYPES) host.removeEventListener(type, onInput, CAPTURE);
  };
}

/** a space is gone: a press it owned is nobody's */
export function forget(space: Space): void {
  if (owner === space) owner = undefined;
}
