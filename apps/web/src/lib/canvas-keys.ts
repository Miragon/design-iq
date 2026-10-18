/**
 * A canvas engine hears keys only while it is in front. The Miragon renderers
 * (Wardley, Event Storming, Team Topology, Context Map) take their shortcuts
 * from a keydown listener on `document`, wherever the focus is, and skip it
 * only for a target that is an INPUT, a TEXTAREA or contenteditable. The live
 * editor keeps the canvas mounted behind the Monaco source layer and behind
 * its dialogs, and `inert` does not reach a listener on `document`, so keys
 * meant for something else edited a diagram nobody could see:
 *
 * - Typed in Monaco: Monaco 0.55 in Chrome and Edge types through a
 *   `div.native-edit-context` (EditContext API), none of the three. "l"
 *   started a lasso and never reached the text, the element keys ("c" and
 *   "u" in Wardley, "e" and "c" in Event Storming) started a new element, ⌘V
 *   went to the canvas instead of into the source (Team Topology every time).
 * - Pressed with the focus on the toolbar or a dialog button: Backspace
 *   deleted the selected elements, the arrows moved them, ⌘Z undid the last
 *   canvas edit, ⌘A (Team Topology) selected every element for the next one.
 *
 * While the canvas is not in front the shell holds the keydowns at the root
 * element, in the bubble phase: the target, its React handlers (delegated at
 * #root, a portal's at its container) and the capture-phase listeners have
 * run, so typing, Monaco's keybindings and widgets, the dialogs and the menus
 * keep working, and a key keeps its default action. Only the bubble-phase
 * keydown listeners on `document` and `window` miss it then: the engines',
 * and any other with them. A shortcut the app needs in the source view or a
 * dialog listens in the capture phase, or passes here.
 *
 * Not held: the draw tools of Wardley and Event Storming listen in the
 * capture phase while drawing, and take Enter and Escape before anything
 * else. That needs the renderers' fix (keys scoped to their own canvas).
 */

/** a lone modifier: Monaco's sticky scroll and modifier tracking listen for one on window */
const MODIFIERS: ReadonlySet<string> = new Set(["Shift", "Alt", "Control", "Meta"]);

/** the keys the app needs from document and window; no engine acts on them there */
function passes(e: KeyboardEvent): boolean {
  return (
    // the dialogs close on it from window (the engines only cancel their own drag or popup)
    e.key === "Escape" ||
    MODIFIERS.has(e.key) ||
    // the toasts' hotkey (sonner's Toaster, routes/root.tsx)
    (e.altKey && e.code === "KeyT")
  );
}

/** hold the keydowns of `doc` from its document and window listeners; returns the release */
export function keepKeysFromCanvas(doc: Document): () => void {
  const root = doc.documentElement;
  const onKeyDown = (e: KeyboardEvent) => {
    if (!passes(e)) e.stopPropagation();
  };
  root.addEventListener("keydown", onKeyDown);
  return () => root.removeEventListener("keydown", onKeyDown);
}
