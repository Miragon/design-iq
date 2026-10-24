/**
 * Where the focus goes after the editor's chrome acted on the canvas (guide
 * §5.4, §5.8 "Focus after a click"). A canvas acts on keys only while it has
 * the focus: diagram-js 15 binds its keyboard to the canvas, and the Miragon
 * renderers hear only keys aimed at their canvas or at the page itself
 * (lib/canvas-keys.ts). After a click on a toolbar control, Delete, the
 * arrows and ⌘Z went to that control until a second click into the canvas.
 *
 * - The view switch: a click with a mouse, pen or finger on the canvas view
 *   hands the canvas the focus once its layer shows. Enter or Space leave it
 *   on the switch, and Split and the source view never move it.
 * - The ⋯ menu: a click on an action entry of the Model group that opens no
 *   dialog hands the canvas the focus as the menu closes; the trigger takes
 *   it where the canvas cannot (behind the source). Everything else keeps
 *   radix's close: Enter or Space, Escape, Export and Help give the focus to
 *   the trigger, a dialog entry leaves it to its dialog, and a click outside
 *   leaves it where the click put it. The menu is not modal, so a click on
 *   the canvas closes it and acts there too, as a click outside should; a
 *   checkbox or radio entry keeps the menu open (§5.4), and that click is
 *   how the canvas gets the focus back after one.
 *
 * Pure, the canvas a parameter (test/canvas-focus.test.ts); the editors'
 * MountedEditor.focus() and these rules on the real canvases under jsdom in
 * test/canvas-focus-dom.test.ts.
 */
import type { EditorView } from "./editor-view.ts";

/** a click with a mouse, pen or finger: `detail` ≥ 1. Enter and Space on a
 *  button, radix's activation of a menu entry by key and a screen reader's
 *  click have 0 */
export function isPointerClick(event: Pick<MouseEvent, "detail">): boolean {
  return event.detail > 0;
}

/** the editor's canvas, as the shell has it */
export interface FocusableCanvas {
  /** its layer is on screen, alone or beside the source */
  shown(): boolean;
  /** hand it the keyboard focus; true when it took it */
  focus(): boolean;
}

/**
 * Hands the focus to the canvas mounted in `host` through the editor's
 * `focus` (MountedEditor.focus); true when it landed in the host. An editor
 * without one (the Markdown view), one not mounted yet and a hidden host
 * (inert) take none.
 */
export function focusCanvasIn(host: Element | null, focus: (() => void) | undefined): boolean {
  if (!host || !focus) return false;
  focus();
  return host.contains(host.ownerDocument.activeElement);
}

/** the view switch's hand-back */
export interface ViewSwitchFocus {
  /** a view was chosen, by a click (`pointer`) or by key */
  chose(view: EditorView, pointer: boolean): void;
  /** the canvas layer came on screen or went off it, after the commit (its host is no longer inert) */
  shown(): void;
}

export function viewSwitchFocus(canvas: FocusableCanvas): ViewSwitchFocus {
  // a click on the canvas view while only the source shows waits for the
  // commit that shows the canvas: an inert host takes no focus
  let pending = false;
  return {
    chose(view, pointer) {
      pending = false;
      if (view !== "canvas" || !pointer) return;
      if (canvas.shown()) canvas.focus();
      else pending = true;
    },
    shown() {
      if (!pending) return;
      pending = false;
      if (canvas.shown()) canvas.focus();
    },
  };
}

/** the ⋯ menu's focus as it closes */
export interface MenuCloseFocus {
  /** an entry that opens a dialog was chosen: the dialog takes the focus */
  openingDialog(): void;
  /** an action entry of the Model group that opens no dialog was chosen, by a click (`pointer`) or by key */
  actedOnCanvas(pointer: boolean): void;
  /** the menu closes: true when the focus is settled here, so radix must
   *  leave it alone (preventDefault); false leaves it to radix */
  closing(canvas: FocusableCanvas | undefined): boolean;
}

export function menuCloseFocus(): MenuCloseFocus {
  let chosen: "dialog" | "canvas" | undefined;
  return {
    openingDialog() {
      chosen = "dialog";
    },
    actedOnCanvas(pointer) {
      chosen = pointer ? "canvas" : undefined;
    },
    closing(canvas) {
      const last = chosen;
      chosen = undefined;
      if (last === "dialog") return true;
      return last === "canvas" && canvas !== undefined && canvas.shown() && canvas.focus();
    },
  };
}
