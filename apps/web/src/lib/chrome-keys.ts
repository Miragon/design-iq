/**
 * The zoom keys and ⇧1 of a canvas, in the MCP-App widget
 * (mcp-app/chrome/keys.ts, the bpmn, dmn and Miragon engines) and in the SPA's
 * editors (notations/miragon/editor.ts, notations/bpmn-io-keys.ts). Wardley,
 * Event Storming, Team Topologies and Context Maps bind no Cmd/Ctrl + `+` /
 * `-` / `0`, so without this they would zoom the page instead of the
 * diagram; bpmn-js, dmn-js and Value Chain bind them to a zoom that turns a
 * step out into a zoom in below 20 % (routeCanvasChromeKeys). What a key means is the modeler shell's keymap
 * (mcp-app/core/keymap.ts chromeKeyAction); this reads what it depends on
 * from the DOM the way the shell's own key listener does, so a renderer's
 * dialog or popover counts as soon as it shows. Every view takes the keys on
 * its whole document (guide §5.8), except in a text field, while a modal
 * dialog is open and while no diagram is on screen.
 */
import { isTextField, matchChromeKey } from "@miragon/modeler-shell/core";

import { type ChromeKey, chromeKeyAction } from "../mcp-app/core/keymap.ts";

// the shell's own rule, not a copy of it: an EditContext editor and all of
// Monaco (the SPA's source beside the canvas) keep their keys, as in the shell
export { isTextField };

// a dialog a renderer closes by hiding it (`hidden`, a class with
// display: none) is closed too
function isShown(element: Element): boolean {
  if (element.localName === "dialog" && !element.hasAttribute("open")) return false;
  if (element.closest("[hidden]")) return false;
  return typeof element.checkVisibility !== "function" || element.checkVisibility({ visibilityProperty: true });
}

function isModal(element: Element): boolean {
  if (element.getAttribute("aria-modal") === "true") return true;
  try {
    return element.matches(":modal");
  } catch {
    // an engine without :modal (jsdom): only aria-modal tells
    return false;
  }
}

/** the popovers and dialogs shown in `scope`, and whether one of them is modal */
export function openDialogs(scope: ParentNode): { open: boolean; modal: boolean } {
  const shown = [...scope.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog')].filter(isShown);
  return { open: shown.length > 0, modal: shown.some(isModal) };
}

export interface ChromeKeyDeps {
  menuOpen(): boolean;
  /** a diagram is on screen to zoom; without one the browser keeps the keys */
  viewport(): boolean;
  run(key: ChromeKey): void;
}

/**
 * Runs the chrome key `event` is, if the shell's keymap acts on it here, and
 * prevents its default then (the browser would zoom the page as well). A key
 * the canvas already handled is left alone, so one press acts once.
 */
export function handleChromeKey(event: KeyboardEvent, scope: ParentNode, deps: ChromeKeyDeps): boolean {
  if (event.defaultPrevented) return false;
  const dialogs = openDialogs(scope);
  const action = chromeKeyAction(event, {
    inTextField: isTextField(event.target),
    menuOpen: deps.menuOpen(),
    dialogOpen: dialogs.open,
    modalOpen: dialogs.modal,
    viewport: deps.viewport(),
  });
  if (!action) return false;
  deps.run(action);
  event.preventDefault();
  return true;
}

/** a diagram-js 15 `keyboard.keydown` listener: true handles the key (the
 *  keyboard prevents its default), false keeps the bindings below from it */
type CanvasKeyListener = (context: { keyEvent: KeyboardEvent }) => boolean | undefined;

/** the `keyboard` service of a diagram-js 15 canvas, as far as this uses it */
interface CanvasKeyboard {
  addListener(priority: number, listener: CanvasKeyListener): void;
  removeListener(listener: CanvasKeyListener): void;
}

/** above every keyboard listener diagram-js, bpmn-js and dmn-js register
 *  (their bindings at 1000, HandTool and KeyboardMoveSelection at 1500), as
 *  the modeler shell's own guard sits */
const BEFORE_CANVAS_BINDINGS = 2000;

/**
 * The chrome keys of a diagram-js canvas (bpmn-js, the DMN DRD, Value Chain) on the canvas
 * itself, where its keyboard listens (the canvas's `<svg>`). diagram-js binds
 * Cmd/Ctrl + `+` / `-` / `0` there to its own `zoomScroll`, which clamps a
 * step to 20 %, so from a fit below 20 % its zoom out zooms in (guide §5.8);
 * this listens before that binding and never lets it act. Each key goes
 * through `handleChromeKey` to `deps.run` and is prevented, so the caller's
 * listener on the document, which takes the keys everywhere else, skips it
 * and each press acts once. A key the keymap leaves alone (a modal dialog, a
 * composition) keeps its default, so the browser zooms the page. A diagram
 * without a keyboard (dmn-js's read-only DRD) binds no zoom of its own: the
 * document listener alone takes its keys. Returns the unbind.
 */
export function routeCanvasChromeKeys(
  diagram: { get(service: string): unknown },
  scope: ParentNode,
  deps: ChromeKeyDeps,
): () => void {
  let keyboard: CanvasKeyboard;
  try {
    // didi's strict lookup throws for a service the diagram does not register
    keyboard = diagram.get("keyboard") as CanvasKeyboard;
  } catch {
    return () => {};
  }
  const listener: CanvasKeyListener = ({ keyEvent }) => {
    if (matchChromeKey(keyEvent) === undefined) return undefined;
    return handleChromeKey(keyEvent, scope, deps);
  };
  keyboard.addListener(BEFORE_CANVAS_BINDINGS, listener);
  return () => keyboard.removeListener(listener);
}
