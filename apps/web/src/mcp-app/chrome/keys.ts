/**
 * The widget's ONE keydown listener (spec §8): ⌘S / Ctrl+S, ⇧1, the zoom
 * keys of the Miragon widgets and the Escape layers (topmost first: menu →
 * popover → compact palette → panel, the panel's own inline form before the
 * panel; never a decision card). What a key means — and which text fields
 * keep their keys — is core/keymap.ts; this binds it and calls
 * preventDefault only for a key that was handled (read-only ⌘S stays the
 * browser's).
 * bpmn-js and dmn-js bind their own keyboard (undo/redo, select all,
 * delete) to the focused canvas, and their zoom keys and ⇧1 act there too:
 * their engines route them to the same `chromeKeyDeps`
 * (EngineOptions.chromeKeys, lib/chrome-keys.ts routeCanvasChromeKeys), so
 * they step as the −/+ buttons do. The Miragon renderers bind no zoom keys:
 * `chromeKeys` gives their widgets the modeler shell's on the whole widget
 * document (lib/chrome-keys.ts, as in the SPA).
 */
import { type ChromeKeyDeps, handleChromeKey, isTextField, openDialogs } from "../../lib/chrome-keys.ts";
import { type ChromeKey, keyCommand, type KeyTarget } from "../core/keymap.ts";
import type { MountKeys } from "./contracts.ts";

/**
 * The zoom keys and ⇧1 of a widget: KeyDeps.chromeKeys in a Miragon widget,
 * EngineOptions.chromeKeys for the focused canvas of bpmn and the DMN DRD; a
 * state card hides the diagram, so the browser keeps them.
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
    if (deps.chromeKeys && handleChromeKey(e, doc, deps.chromeKeys)) return;
    const command = keyCommand(e, targetOf(doc, e.target));
    let handled = false;
    if (command === "save") handled = deps.save();
    else if (command === "fit" && !deps.chromeKeys) handled = deps.fit();
    // a renderer's modal dialog takes Escape itself (the native cancel): the
    // chrome's layers under it stay as they are
    else if (command === "escape" && !openDialogs(doc).modal) handled = deps.escape.some((layer) => layer());
    if (handled) e.preventDefault();
  };
  doc.addEventListener("keydown", onKey);
  return () => doc.removeEventListener("keydown", onKey);
};
