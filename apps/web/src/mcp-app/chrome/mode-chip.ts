/**
 * The Workshop chip-switch in #mode-slot (spec §2.3, §6.3, §8) — the widget
 * twin of the SPA's ModeAction (components/editor-toolbar.tsx): the whole chip
 * IS the switch (role=switch + aria-checked) with its OWN accessible name
 * "Workshop mode", not a wrapping label; track first, label after. ON wears
 * the CI selection look (chrome.css `.fb[aria-checked]`). The measured degrade
 * (chrome.css, step ≥ 3) swaps the label for the sticky-note while ON and
 * leaves the switch to the menu while OFF — the menu's "Workshop mode"
 * checkbox runs the same ModeChip.toggle (one tbpmToggleAction behind both).
 * Switched OFF from the keyboard there, the focused chip vanishes: the focus
 * moves to the menu trigger (where the switch lives now) and #announce says
 * the new state the vanished switch can no longer say itself. A click hands
 * the canvas the focus, since the switch changes what the canvas offers
 * (guide §5.8, as the zoom group's `thenCanvas`); Enter or Space keep it.
 */
import { icon } from "../icons.ts";
import type { ModeChip } from "./contracts.ts";
import { h } from "./dom.ts";

/** renders the chip into `slot`; `changed` fires when it flips (the menu
 *  mirrors it, the TL cluster re-measures synchronously) — returns the unmount */
export function mountModeChip(
  slot: HTMLElement,
  chip: ModeChip,
  changed: () => void,
  opts: {
    /** where the focus goes when the focused chip leaves the row (the menu trigger) */
    fallbackFocus?: () => HTMLElement | null;
    announce?: (text: string) => void;
    /** after a click: the canvas takes the focus (view.focus) */
    focusCanvas?: () => void;
  } = {},
): () => void {
  const button = h("button", {
    type: "button",
    class: "fb mode",
    role: "switch",
    "aria-label": "Workshop mode",
    title: chip.title,
  });
  button.append(
    icon("sticky-note", 16, "mode-icon"),
    h("span", { class: "track", "aria-hidden": "true" }),
    h("span", { class: "label" }, chip.label),
  );
  button.onclick = (event) => {
    chip.toggle();
    if (event.detail > 0) opts.focusCanvas?.();
  };
  // onChanged fires on EVERY command (the action listens to the command
  // stack) — only a flip may re-lay the clusters
  let on: boolean | undefined;
  const reflect = (): void => {
    const next = chip.isOn();
    if (next === on) return;
    on = next;
    const had = document.activeElement === button;
    button.setAttribute("aria-checked", String(next));
    changed();
    // getClientRects forces the style the flip just changed — empty = display:none
    if (had && button.getClientRects().length === 0) {
      opts.fallbackFocus?.()?.focus({ preventScroll: true });
      opts.announce?.(next ? "Workshop mode on" : "Workshop mode off");
    }
  };
  slot.append(button);
  const off = chip.onChanged(reflect);
  reflect();
  return () => {
    off();
    button.remove();
  };
}
