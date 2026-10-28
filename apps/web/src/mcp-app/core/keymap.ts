/**
 * The widget's keyboard (spec §8) as pure data: ONE keydown listener on the
 * widget document (chrome/keys.ts) asks keyCommand what a key means. The
 * text-field guard lives here too: a modeler's own text (a label being
 * edited, a DMN cell, the add-on form) keeps every key; a chrome field (the
 * todo form) keeps ⇧1 (it types "!") but still answers Escape, which closes
 * the inline form — the topmost layer while one is open. ⌘S is honoured
 * everywhere: it has no meaning inside text, and the browser's own "save
 * page" is never what someone in a modeler wants.
 * The zoom keys and ⇧1 (chromeKeyAction) follow the modeler shell's keymap
 * (`decideKey`, host "embedded"), so they act exactly as in the Miragon
 * modelers' own chrome: on the whole document of a Miragon widget, on the
 * focused canvas of bpmn and the DMN DRD, where ⇧1 elsewhere in the widget
 * stays keyCommand's.
 * Plus the WAI-ARIA menu-button keys of the trigger (§3).
 * DOM-free (`.ts` relative imports): node --test loads it.
 */
import { type ChromeKey, decideKey, type KeyLike, matchChromeKey } from "@miragon/modeler-shell/core";

export type { ChromeKey, KeyLike };

export type KeyCommand = "save" | "fit" | "escape";

/** where the key landed: not in text / in a chrome text field / in the canvas's own text */
export type KeyTarget = "plain" | "chrome-text" | "canvas-text";

export function keyCommand(e: KeyLike, target: KeyTarget): KeyCommand | undefined {
  if (e.isComposing) return undefined;
  const mod = e.metaKey || e.ctrlKey;
  // ⌘S / Ctrl+S — by code too, so a non-Latin layout still saves
  if (mod && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === "s" || e.code === "KeyS")) return "save";
  if (target === "canvas-text") return undefined;
  if (e.key === "Escape" && !mod && !e.altKey) return "escape";
  if (target === "plain" && matchChromeKey(e) === "fit") return "fit";
  return undefined;
}

/** what the zoom keys and ⇧1 depend on besides the key itself */
export interface ChromeKeyState {
  /** the key landed in a text field (TEXT_FIELD_SELECTOR, or contenteditable) */
  inTextField: boolean;
  menuOpen: boolean;
  /** a popover or dialog (`[role="dialog"]`, `<dialog open>`) shows */
  dialogOpen: boolean;
  /** one of them is modal */
  modalOpen: boolean;
  /** a diagram to zoom is on screen; without one the browser keeps the keys */
  viewport: boolean;
}

/**
 * Cmd/Ctrl + `+` / `-` / `0` and ⇧1 for a Miragon canvas: the shell's
 * decision for an embedded modeler, so an IME composition, a text field and
 * an open modal keep the key, and a widget without a diagram (a state card)
 * leaves it to the browser. undefined = not acted on, nothing prevented.
 */
export function chromeKeyAction(e: KeyLike, state: ChromeKeyState): ChromeKey | undefined {
  if (matchChromeKey(e) === undefined) return undefined;
  const decision = decideKey(e, {
    host: "embedded",
    inTextField: state.inTextField,
    menuOpen: state.menuOpen,
    dialogOpen: state.dialogOpen,
    modalOpen: state.modalOpen,
    // the listener returns before this on a prevented key: one press acts once
    defaultPrevented: false,
    startScreen: !state.viewport,
  });
  return decision.action === "closeMenu" ? undefined : decision.action;
}

/** the menu trigger: ↓ opens on the first enabled item, ↑ on the last
 *  (Enter and Space click the button — the first item too) */
export function triggerOpen(key: string): "first" | "last" | undefined {
  if (key === "ArrowDown") return "first";
  if (key === "ArrowUp") return "last";
  return undefined;
}

/** first-letter type-ahead only for a bare printable key — ⌘S inside the
 *  open menu saves instead of jumping to "Save now" */
export const isTypeAhead = (e: Pick<KeyLike, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean =>
  !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && /\S/.test(e.key);
