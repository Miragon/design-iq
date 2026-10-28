/**
 * The widget's ONE keydown listener (spec §8): ⌘S / Ctrl+S, the zoom keys
 * and ⇧1, and the Escape layers (topmost first: menu → popover → compact
 * palette → panel, the panel's own inline form before the panel; never a
 * decision card). What a key means — and which text fields keep their keys —
 * is core/keymap.ts; this binds it and calls preventDefault only for a key
 * that was handled (read-only ⌘S stays the browser's).
 * The zoom keys and ⇧1 act on the whole widget document (guide §5.8), by the
 * modeler shell's keymap (lib/chrome-keys.ts, as in the SPA). bpmn-js,
 * dmn-js and Value Chain bind their own keyboard (undo/redo, select all,
 * delete, and a zoom of their own) to the focused canvas: their engines run the same
 * `chromeKeyDeps` there first (EngineOptions.chromeKeys, lib/chrome-keys.ts
 * routeCanvasChromeKeys) and prevent the key, so this listener skips it and
 * each press acts once.
 */
import { type ChromeKeyDeps, handleChromeKey, isTextField, openDialogs } from "../../lib/chrome-keys.ts";
import { type ChromeKey, keyCommand, type KeyTarget } from "../core/keymap.ts";
import type { MountKeys } from "./contracts.ts";

/**
 * The zoom keys and ⇧1 of a widget: KeyDeps.chromeKeys on the document, and
 * EngineOptions.chromeKeys on the canvas of bpmn, the DMN DRD and the Miragon
 * renderers; a state
 * card hides the diagram, so the browser keeps them.
 */
export function chromeKeyDeps(state: {
  menuOpen(): boolean;
  hasViewport(): boolean;
  stateCardShown(): boolean;
  run(key: ChromeKey): void;
}): ChromeKeyDeps {
  return {
    menuOpen: () => state.menuOpen(),
    viewport: () => state.hasViewport() && !state.stateCardShown(),
    run: (key) => state.run(key),
  };
}

/** a modeler's own text (a label being edited, a DMN cell, the add-on's
 *  simulation form, a renderer dialog's field) vs. a chrome field (the todo
 *  form) vs. no text at all */
function targetOf(doc: Document, target: EventTarget | null): KeyTarget {
  if (!isTextField(target)) return "plain";
  return doc.getElementById("canvas")?.contains(target as Node) ? "canvas-text" : "chrome-text";
}

export const mountKeys: MountKeys = (doc, deps) => {
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return;
    if (handleChromeKey(e, doc, deps.chromeKeys)) return;
    const command = keyCommand(e, targetOf(doc, e.target));
    let handled = false;
    if (command === "save") handled = deps.save();
    // a renderer's modal dialog takes Escape itself (the native cancel): the
    // chrome's layers under it stay as they are
    else if (command === "escape" && !openDialogs(doc).modal) handled = deps.escape.some((layer) => layer());
    if (handled) e.preventDefault();
  };
  doc.addEventListener("keydown", onKey);
  return () => doc.removeEventListener("keydown", onKey);
};
