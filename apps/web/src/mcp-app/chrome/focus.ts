/**
 * The focus hand-back around a state card (spec §5.3): the loading card hides
 * the corner the menu's Reload left the focus on (the trigger), or replaces
 * the failure card whose Try again had it — and a hidden control drops the
 * focus on <body>. When the card goes, the focus comes back: to the same
 * control if it is still there and visible, else to `fallback` (the menu
 * trigger). Only while the user has not moved on: the widget still has the
 * focus and nothing in it holds it.
 */
export interface FocusReturn {
  /** remember the focused control inside `root` (nothing outside it) */
  hold(): void;
  /** put it back — once; a no-op when nothing was held */
  restore(fallback: () => HTMLElement | null): void;
}

export function focusReturn(root: HTMLElement): FocusReturn {
  let held: HTMLElement | undefined;
  return {
    hold() {
      const active = document.activeElement as HTMLElement | null;
      held = active && active !== document.body && root.contains(active) ? active : undefined;
    },
    restore(fallback) {
      const was = held;
      held = undefined;
      if (!was || !document.hasFocus()) return;
      const now = document.activeElement;
      if (now && now !== document.body) return; // the user moved on meanwhile
      const target = was.isConnected && was.getClientRects().length > 0 ? was : fallback();
      target?.focus({ preventScroll: true });
    },
  };
}
