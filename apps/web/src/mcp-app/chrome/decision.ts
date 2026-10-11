/**
 * The decision cards (spec §5.2): a CAS conflict, an interrupted live
 * session, the superseded copy — choices the user owes. One card at a time,
 * first in the bottom-centre lane (the toasts stack under it).
 *
 * role=alertdialog, labelled by its title and described by its body, but
 * NON-modal: Tab is not trapped and the canvas stays usable (autosave stays
 * paused meanwhile). One row per choice — the button, in the lifecycle's
 * order, and the one line saying what choosing it does (the button's
 * aria-describedby, so a screen reader hears it on focus); exactly one primary
 * (the superseded card has none). The × is "Decide later": the card
 * collapses into the pill (paused / inactive) and a pill click reopens it.
 * Escape never dismisses a card — inside it, Escape does nothing at all.
 *
 * In the lane it comes first and always shows whole — beside it at most one
 * toast, and only one that fits (core/feedback.ts planLane: every change
 * here is an onChange, the toasts re-plan). Only a frame too short for the
 * card itself lets it scroll inside (chrome.css, --lane-max).
 *
 * Focus: a new card takes the focus onto its primary choice only when this
 * widget already has it (document.hasFocus()) — it never pulls the focus out
 * of the chat composer; otherwise #alert announces it. On resolve the focus
 * returns to where it was in the widget, else to the pill. An open sheet
 * folds to its head while the card shows (spec §7, the shell on onChange)
 * and unfolds before that return, so a control in its body takes it back.
 */
import { decisionAnnouncement, laterLabel } from "../core/feedback.ts";
import type { BannerAction, BannerOptions } from "../core/lifecycle.ts";
import { icon } from "../icons.ts";
import type { MountDecision } from "./contracts.ts";
import { h } from "./dom.ts";

interface Shown {
  title: string;
  actions: BannerAction[];
  opts: BannerOptions;
}

let seq = 0;

export const mountDecision: MountDecision = (deps) => {
  const { lane, live } = deps;
  let shown: Shown | undefined;
  let card: HTMLElement | undefined;
  let deferred = false;
  let returnTo: HTMLElement | null = null;

  const visible = (el: HTMLElement | null): el is HTMLElement =>
    el !== null && el.isConnected && el.getClientRects().length > 0 && !el.closest("[inert]");

  /** the card's first focus target, by priority (querySelector alone would
   *  answer in document order — the × comes first there) */
  const target = (): HTMLElement | null =>
    card?.querySelector<HTMLElement>(".choices .pb.primary") ??
    card?.querySelector<HTMLElement>(".choices .pb") ??
    card?.querySelector<HTMLElement>(".later") ??
    null;

  /** `update`: the same card re-rendered in place — no entrance motion again */
  function render(update = false): HTMLButtonElement | undefined {
    const had = card?.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const hadLater = had?.classList.contains("later") ?? false;
    const hadLabel = had && !hadLater ? had.textContent : undefined;
    card?.remove();
    card = undefined;
    if (!shown || deferred) {
      deps.onChange?.();
      return undefined;
    }
    const { title, actions, opts } = shown;
    const tone = opts.tone ?? "warning";
    const id = `decide-${++seq}`;
    const later = h(
      "button",
      {
        type: "button",
        class: "pb icon ghost later",
        "aria-label": laterLabel(opts.deferAs),
        title: laterLabel(opts.deferAs),
      },
      icon("x", 16),
    );
    later.onclick = defer;
    const text = h("div", { class: "text" }, h("h3", { id: `${id}-t` }, title));
    if (opts.detail) text.append(h("p", { id: `${id}-d` }, opts.detail));
    const node = h(
      "section",
      {
        class: `decide ${tone}`,
        role: "alertdialog",
        "aria-labelledby": `${id}-t`,
        ...(opts.detail ? { "aria-describedby": `${id}-d` } : {}),
      },
      h("div", { class: "head" }, icon(tone === "info" ? "info" : "triangle-alert", 18), text, later),
    );
    let primary: HTMLButtonElement | undefined;
    let again: HTMLElement | undefined;
    if (actions.length > 0) {
      const choices = h("div", { class: "choices" });
      actions.forEach((a, i) => {
        // the consequence describes its button — none (Open in designIQ on the
        // superseded card) points at nothing
        const why = a.consequence ? `${id}-c${i}` : undefined;
        const b = h(
          "button",
          {
            type: "button",
            class: a.primary ? "pb primary" : a.danger ? "pb danger" : "pb",
            ...(why ? { "aria-describedby": why } : {}),
          },
          a.label,
        );
        b.onclick = () => a.run();
        if (a.primary) primary = b;
        if (hadLabel === a.label) again = b;
        choices.append(b, h("span", { class: "why", ...(why ? { id: why } : {}) }, a.consequence ?? ""));
      });
      node.append(choices);
    }
    if (hadLater) again = later;
    // Escape never dismisses a decision — nor walks the other layers from in here
    node.addEventListener("keydown", (e) => {
      if (e.key === "Escape") e.stopPropagation();
    });
    if (update) node.style.animation = "none";
    lane.prepend(node);
    card = node;
    deps.onChange?.();
    // an update in place keeps the focus on the same choice
    if (had) (again ?? primary ?? later).focus();
    return primary;
  }

  function settleFocus(): void {
    const target = visible(returnTo) ? returnTo : deps.fallbackFocus();
    returnTo = null;
    target?.focus();
  }

  /** "Decide later": the card collapses into the pill, the focus goes there */
  function defer(): void {
    if (!shown) return;
    const had = card?.contains(document.activeElement) ?? false;
    deferred = true;
    render();
    if (had) deps.fallbackFocus()?.focus();
  }

  /** `active`: the focus before the card came — the card's onChange may have
   *  folded a sheet with it (spec §7), so it is read before the render */
  function attend(primary: HTMLElement | undefined, active: HTMLElement | null): void {
    // never steal the focus from the chat composer: only a focused widget moves it
    if (primary && document.hasFocus()) {
      returnTo = active && active !== document.body && !card?.contains(active) ? active : null;
      primary.focus();
    } else if (shown) {
      live.assertive(decisionAnnouncement(shown.title, shown.opts.detail));
    }
  }

  return {
    show(title, actions, opts) {
      // the same decision again (the superseded card learning how its last
      // save went): update in place — no re-announcement, no focus jump, and
      // a deferred card stays deferred
      const same = shown?.title === title;
      shown = { title, actions, opts };
      if (same) {
        render(true);
        return;
      }
      deferred = false;
      const active = document.activeElement as HTMLElement | null;
      attend(render(), active);
    },
    hide() {
      const had = card?.contains(document.activeElement) ?? false;
      card?.remove();
      card = undefined;
      shown = undefined;
      deferred = false;
      deps.onChange?.();
      if (had) settleFocus();
      else returnTo = null;
    },
    isDeferred: () => deferred && shown !== undefined,
    isShown: () => card !== undefined,
    reopen() {
      if (!shown) return;
      if (deferred) {
        deferred = false;
        render();
        returnTo = null; // the user asked for it (a pill click): the card takes the focus
      }
      target()?.focus();
    },
    focus() {
      const t = target();
      t?.focus();
      return t !== null;
    },
  };
};
