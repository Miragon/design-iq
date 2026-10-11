/**
 * The inspector-panel shell the Todos card (todos.ts) and the Checks card
 * (dmn-checks.ts) share (spec §7): a floating card at the right, a full-width
 * sheet when compact (chrome.css `#app[data-panel]`). This module owns the
 * behaviour, never the content:
 *
 *  - one panel at a time; opening one closes the compact palette (Tools)
 *  - the TR toggle carries aria-expanded — chrome.css paints the CI selection
 *    look and turns its count chip primary from it — plus its badge: the open
 *    count or the test verdict, and the accessible name once the label drops
 *  - focus: opening moves it to the panel's h2, closing returns it to the
 *    toggle, but only when it was inside the panel — a close from the canvas
 *    or the chat composer never pulls focus into the widget
 *  - Escape: the panel's own layer first (an open inline form), then the
 *    panel. keys.ts ignores keys typed into fields, so the Escape of a field
 *    inside a panel is taken here and stops here
 *  - collapse: a compact sheet steps aside before an element or a rule is
 *    revealed underneath; the toggle reopens it at the same scroll position
 *  - fold: under a decision card a sheet folds to its head (data-folded:
 *    chrome.css hides the body — out of the tab order, not just shrunk) and
 *    unfolds at the same scroll position once the card is answered or
 *    deferred; the shell decides when (core/layout.ts sheetFolds)
 *  - every change is an onChange: the shell re-measures the layout (an open
 *    card's right inset re-fits an untouched diagram) and refreshes the menu
 */
import { TEXT_FIELD } from "../core/keymap.ts";
import { icon } from "../icons.ts";
import type { MountPanels, PanelBadge, PanelHandle, PanelSpec } from "./contracts.ts";
/** the scroll container(s) a collapse remembers — one per panel (chrome.css) */
const SCROLLERS = ".panel-scroll";

interface Entry {
  spec: PanelSpec;
  handle: PanelHandle;
  /** close without the focus hand-back (another panel takes it) */
  hide(returnFocus: boolean): void;
}

/** a stable key for a badge — setBadge on every list render must not re-lay the clusters */
const badgeKey = (b: PanelBadge | undefined): string => (b ? JSON.stringify(b) : "");

/** a panel's scroll offsets — a hidden scroller (display: none) loses its own */
const offsetsOf = (panel: HTMLElement): number[] =>
  Array.from(panel.querySelectorAll<HTMLElement>(SCROLLERS), (node) => node.scrollTop);
const scrollBack = (panel: HTMLElement, offsets: number[]): void => {
  panel.querySelectorAll<HTMLElement>(SCROLLERS).forEach((node, i) => {
    node.scrollTop = offsets[i] ?? 0;
  });
};

export const mountPanels: MountPanels = (deps) => {
  const entries = new Map<PanelSpec["id"], Entry>();
  let active: PanelSpec["id"] | undefined;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const cb of listeners) cb();
  };
  /** the sheet folded under a decision card, and where its scrollers were */
  let folded: { panel: HTMLElement; offsets: number[] } | undefined;
  /** `restore`: back where it folded (a hidden panel has nothing to restore) */
  function unfold(restore: boolean): void {
    if (!folded) return;
    const { panel, offsets } = folded;
    folded = undefined;
    panel.removeAttribute("data-folded");
    if (restore) scrollBack(panel, offsets);
  }

  function register(spec: PanelSpec): PanelHandle {
    const { panel, toggle, heading } = spec;
    let badge = "";
    // the scroll offsets a collapse left behind — the toggle reopens there
    let memory: number[] | undefined;
    const isOpen = (): boolean => !panel.hidden;
    toggle.setAttribute("aria-controls", panel.id);
    toggle.setAttribute("aria-expanded", "false");
    heading.setAttribute("tabindex", "-1");

    const hide = (returnFocus: boolean): void => {
      if (!isOpen()) return;
      const hadFocus = panel.contains(document.activeElement);
      if (folded?.panel === panel) unfold(false);
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      if (active === spec.id) active = undefined;
      if (hadFocus && returnFocus && !toggle.hidden) toggle.focus({ preventScroll: true });
      spec.onClose?.();
      emit();
    };

    const show = (restore: boolean): void => {
      if (isOpen()) return;
      if (active && active !== spec.id) entries.get(active)?.hide(false);
      deps.closeTools();
      panel.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      active = spec.id;
      spec.onOpen?.();
      const offsets = restore ? memory : undefined;
      memory = undefined;
      if (offsets) scrollBack(panel, offsets);
      heading.focus({ preventScroll: true });
      emit();
    };

    const handle: PanelHandle = {
      open: () => show(false),
      close: () => hide(true),
      // the toggle (and the menu item that clicks it) reopens a collapsed
      // sheet where it was left; a programmatic open (a badge filtering the
      // list) starts fresh
      toggle: () => (isOpen() ? hide(true) : show(true)),
      isOpen,
      collapse() {
        if (!isOpen() || deps.layout().panel.mode !== "sheet") return;
        // folded, its scrollers are hidden: the offsets it folded at
        memory = folded?.panel === panel ? folded.offsets : offsetsOf(panel);
        hide(true);
      },
      setAvailable(available) {
        // closing is unconditional: the shell's superseded retire may have
        // hidden the toggle already, the panel must still let go of `active`
        if (!available) hide(false);
        if (toggle.hidden === !available) return;
        toggle.hidden = !available;
        emit();
      },
      setBadge(next) {
        const key = badgeKey(next);
        if (key === badge) return;
        badge = key;
        const count = toggle.querySelector<HTMLElement>(".count");
        if (count) {
          // 0 shows no chip (the SPA CountChip) — the label and the name still say it
          count.hidden = !next?.count;
          count.textContent = next?.count ? String(next.count) : "";
        }
        const verdict = toggle.querySelector<HTMLElement>(".verdict");
        if (verdict) {
          const v = next?.verdict;
          verdict.hidden = !v;
          verdict.className = v ? `verdict ${v.tone}` : "verdict";
          verdict.textContent = "";
          if (v?.spinner) verdict.append(icon("loader-circle", 12, "spin"));
          else if (v?.icon) verdict.append(icon(v.icon, 12));
          if (v) verdict.append(v.text);
        }
        if (next) toggle.setAttribute("aria-label", next.ariaLabel);
        else toggle.removeAttribute("aria-label");
        emit();
      },
    };

    toggle.onclick = () => handle.toggle();
    panel.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (!(e.target as Element | null)?.closest?.(TEXT_FIELD)) return; // the document's Escape layering
      if (!spec.escape?.()) hide(true);
      e.preventDefault();
      e.stopPropagation();
    });

    entries.get(spec.id)?.hide(false);
    entries.set(spec.id, { spec, handle, hide });
    return handle;
  }

  /** the open entry — a panel hidden behind this module's back (the shell's
   *  superseded retire) is not open */
  const open = (): Entry | undefined => {
    const entry = active ? entries.get(active) : undefined;
    if (entry?.handle.isOpen()) return entry;
    active = undefined;
    return undefined;
  };

  return {
    register,
    active: () => open()?.spec.id,
    escape() {
      const entry = open();
      if (!entry) return false;
      // folded under a decision card, its own layer (an inline form) is out of
      // sight: Escape closes what the user sees, the draft stays for later
      const ownLayer = folded?.panel !== entry.spec.panel && entry.spec.escape?.();
      if (!ownLayer) entry.hide(true);
      return true;
    },
    fold(on) {
      const panel = on ? open()?.spec.panel : undefined;
      if (folded && folded.panel !== panel) unfold(true);
      if (!panel || folded) return;
      folded = { panel, offsets: offsetsOf(panel) };
      panel.setAttribute("data-folded", "");
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
};
