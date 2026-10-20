/**
 * A canvas engine hears keys only while it is in front. The Miragon renderers
 * (Wardley, Event Storming, Team Topology, Context Map) take their shortcuts
 * from a keydown listener on `document`. Team Topology 0.10 acts wherever the
 * focus is, unless the target is an INPUT, a TEXTAREA or contenteditable.
 * Wardley since 0.7.0, Event Storming and Context Map since 0.3.0 act only on
 * a key aimed at their own canvas or at the page itself (<body>, nothing
 * focused); Wardley also on ⌘Z/⌘Y and its single-key tools from a focused
 * button. The live editor keeps the canvas mounted behind the Monaco source
 * layer and behind its dialogs, and `inert` does not reach a listener on
 * `document`, so keys meant for something else would edit a diagram nobody
 * can see:
 *
 * - With nothing focused (a click on the page outside every control, a
 *   control that went away): Backspace deletes the hidden selection, the
 *   arrows move it, ⌘Z undoes the last canvas edit, in every renderer.
 * - Typed in Monaco (Team Topology): Monaco 0.55 in Chrome and Edge types
 *   through a `div.native-edit-context` (EditContext API), none of the three
 *   text targets. "l" starts a lasso and never reaches the text, ⌘V goes to
 *   the canvas instead of into the source.
 * - Pressed with the focus on a toolbar button: ⌘Z undoes the last canvas
 *   edit and "c" starts a component (Wardley, Team Topology). In Team
 *   Topology on any button, a dialog's included: Backspace deletes the
 *   selection, ⌘A selects every element for the next one.
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
 * In the split view the canvas is in front, beside the Monaco source: the
 * shell holds only the keys typed in the source (`within`), and the canvas
 * hears every other key as in its own view.
 *
 * Not held: the draw tools of Wardley and Event Storming listen in the
 * capture phase while drawing, and take Enter and Escape before anything
 * else.
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

/** hold the keydowns of `doc` from its document and window listeners, only those from inside `within` when given; returns the release */
export function keepKeysFromCanvas(doc: Document, within?: Node): () => void {
  const root = doc.documentElement;
  const onKeyDown = (e: KeyboardEvent) => {
    if (passes(e) || (within && !within.contains(e.target as Node | null))) return;
    e.stopPropagation();
  };
  root.addEventListener("keydown", onKeyDown);
  return () => root.removeEventListener("keydown", onKeyDown);
}
