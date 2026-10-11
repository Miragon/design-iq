/**
 * The widget's ONE keydown listener (spec §8): ⌘S / Ctrl+S, ⇧1 and the
 * Escape layers (topmost first: menu → popover → compact palette → panel,
 * the panel's own inline form before the panel; never a decision card). What
 * a key means — and which text fields keep their keys — is
 * core/keymap.ts; this binds it and calls preventDefault only for a key that
 * was handled (read-only ⌘S stays the browser's).
 * The diagram-js keyboard (undo/redo, zoom, select all, delete) binds itself
 * while the canvas has the focus — nothing here competes with it.
 */
import { keyCommand, type KeyTarget, TEXT_FIELD } from "../core/keymap.ts";
import type { MountKeys } from "./contracts.ts";

/** a modeler's own text (a label being edited, a DMN cell, the add-on's
 *  simulation form) vs. a chrome field (the todo form) vs. no text at all */
function targetOf(doc: Document, target: EventTarget | null): KeyTarget {
  const el = target instanceof Element ? target : null;
  if (!el?.closest(TEXT_FIELD)) return "plain";
  return doc.getElementById("canvas")?.contains(el) ? "canvas-text" : "chrome-text";
}

export const mountKeys: MountKeys = (doc, deps) => {
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return;
    const command = keyCommand(e, targetOf(doc, e.target));
    let handled = false;
    if (command === "save") handled = deps.save();
    else if (command === "fit") handled = deps.fit();
    else if (command === "escape") handled = deps.escape.some((layer) => layer());
    if (handled) e.preventDefault();
  };
  doc.addEventListener("keydown", onKey);
  return () => doc.removeEventListener("keydown", onKey);
};
