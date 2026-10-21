/**
 * The widget's ONE keydown listener (spec §8): ⌘S / Ctrl+S, ⇧1, the zoom
 * keys of the Miragon widgets and the Escape layers (topmost first: menu →
 * popover → compact palette → panel, the panel's own inline form before the
 * panel; never a decision card). What a key means — and which text fields
 * keep their keys — is core/keymap.ts; this binds it and calls
 * preventDefault only for a key that was handled (read-only ⌘S stays the
 * browser's).
 * bpmn-js and dmn-js bind their own keyboard (undo/redo, zoom, select all,
 * delete) to the focused canvas, so in their widgets the zoom keys stay
 * theirs. The Miragon renderers bind no zoom keys: `chromeKeys` gives their
 * widgets the modeler shell's (lib/chrome-keys.ts, as in the SPA).
 */
import { handleChromeKey, isTextField, openDialogs } from "../../lib/chrome-keys.ts";
import { keyCommand, type KeyTarget } from "../core/keymap.ts";
import type { MountKeys } from "./contracts.ts";

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
