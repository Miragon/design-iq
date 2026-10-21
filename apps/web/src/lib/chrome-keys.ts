/**
 * The zoom keys and ⇧1 of a Miragon canvas, in the MCP-App widget
 * (mcp-app/chrome/keys.ts) and in the SPA's Miragon editors
 * (notations/miragon/editor.ts). No Miragon renderer binds Cmd/Ctrl + `+` /
 * `-` / `0`, so without this they would zoom the page instead of the diagram.
 * What a key means is the modeler shell's keymap (mcp-app/core/keymap.ts
 * chromeKeyAction); this reads what it depends on from the DOM the way the
 * shell's own key listener does, so a renderer's dialog or popover counts
 * as soon as it shows.
 */
import { TEXT_FIELD_SELECTOR } from "@miragon/modeler-shell/core";

import { type ChromeKey, chromeKeyAction } from "../mcp-app/core/keymap.ts";

/** an inherited contenteditable counts, as for the shell */
export function isTextField(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const element = target as HTMLElement;
  return element.isContentEditable === true || element.closest(TEXT_FIELD_SELECTOR) !== null;
}

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
