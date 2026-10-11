/**
 * The toasts of the bottom-centre lane (spec §5.1) — events, never state:
 * whatever a toast says also lives on a persistent surface (the pill and its
 * popover, a panel, a toggle verdict), so a toast is allowed to leave.
 *
 * In arrival order, newest at the bottom, under the decision card (which
 * decision.ts prepends to the same lane). A toast with a `key` replaces its
 * predecessor, and dismiss(key) clears it when its condition does (a landed
 * save clears "Autosave failed"). success / info stay 2.8 s, warning / danger
 * 5 s, paused while hovered or focused; a toast with an action never times
 * out (WCAG 2.2.1). The card carries no live role of its own: the shared
 * regions speak it (danger assertively), so nothing is announced twice.
 *
 * Which toasts show is core/feedback.ts planLane, re-planned on every
 * arrival and departure and on fit() (a decision card came or went, the
 * lane's room changed): at most two, one beside a decision card, and only
 * what fits the room (Layout.lane.room). A persistent toast that yields waits
 * OUT of the DOM (no hidden control, nothing to Tab to) and comes back once
 * there is room; an auto-dismissing one leaves. Rules live in core/feedback.ts.
 */
import {
  isUrlDetail,
  laneAdmit,
  leavingBottom,
  type PausableTimer,
  pausableTimer,
  planLane,
  TOAST_DOT,
  toastAnnouncement,
  toastLifetime,
} from "../core/feedback.ts";
import type { ToastSpec } from "../core/lifecycle.ts";
import { icon } from "../icons.ts";
import type { MountToasts } from "./contracts.ts";
import { dot, h } from "./dom.ts";

interface Entry {
  node: HTMLElement;
  key?: string;
  timer?: PausableTimer;
  /** carries an action: it waits for room instead of leaving */
  persistent: boolean;
}

/** the exit is a short fade; this removes the node even when no animation
 *  runs (a hidden lane, reduced motion's near-zero duration) */
const LEAVE_MS = 200;

export const mountToasts: MountToasts = (deps) => {
  const { lane, live } = deps;
  /** oldest first: in the lane, or waiting for room */
  let entries: Entry[] = [];

  /** the focus never stays on a node that leaves the lane */
  function letGoFocus(node: HTMLElement): void {
    if (node.contains(document.activeElement)) deps.fallbackFocus?.()?.focus();
  }

  /** for good: × , its action, its time, its key — fades out of the lane's
   *  flow (core/feedback.ts leavingBottom: it holds no room, so its keyed
   *  successor never stacks on it), then the lane re-plans (a waiting toast
   *  may come back into the freed room) */
  function remove(entry: Entry): void {
    entries = entries.filter((e) => e !== entry);
    entry.timer?.cancel();
    const node = entry.node;
    letGoFocus(node);
    if (node.parentElement === lane) {
      node.style.bottom = `${leavingBottom(lane.offsetHeight, node.offsetTop, node.offsetHeight)}px`;
    }
    node.classList.add("leaving");
    node.inert = true;
    let done = false;
    const gone = (): void => {
      if (done) return;
      done = true;
      node.remove();
      fit();
    };
    node.addEventListener("animationend", gone, { once: true });
    setTimeout(gone, LEAVE_MS);
  }

  /** what yielded to the plan goes at once — the lane never holds more than it planned */
  function yieldNow(entry: Entry, forGood: boolean): void {
    if (forGood) {
      entries = entries.filter((e) => e !== entry);
      entry.timer?.cancel();
    }
    if (!entry.node.isConnected) return;
    letGoFocus(entry.node);
    entry.node.remove();
  }

  /** a toast's height at the lane's width — a waiting one is laid out for
   *  the read (synchronously, never painted) */
  function heightOf(node: HTMLElement): number {
    if (node.isConnected) return node.offsetHeight;
    node.classList.add("measuring");
    lane.append(node);
    const height = node.offsetHeight;
    node.remove();
    node.classList.remove("measuring");
    return height;
  }

  /** core/feedback.ts planLane, applied: who shows, who waits, who leaves */
  function fit(): void {
    const card = lane.querySelector<HTMLElement>(".decide");
    const sized = entries.map((entry) => ({
      entry,
      persistent: entry.persistent,
      height: heightOf(entry.node) || 0,
    }));
    const plan = planLane(sized, { card: card ? card.offsetHeight || 0 : undefined, room: deps.room?.() ?? Infinity });
    for (const { entry } of plan.drop) yieldNow(entry, true);
    for (const { entry } of plan.wait) yieldNow(entry, false);
    // in arrival order, under the card: a node in place stays (no new entrance)
    let prev: HTMLElement | null = card;
    for (const { entry } of plan.show) {
      if (!entry.node.isConnected) {
        if (prev) prev.after(entry.node);
        else lane.prepend(entry.node);
      }
      prev = entry.node;
    }
  }

  function show(t: ToastSpec): void {
    const msg = h("span", { class: "msg" }, h("b", {}, t.title));
    if (t.detail) msg.append(h("span", { class: isUrlDetail(t.detail) ? "detail mono" : "detail" }, t.detail));
    const node = h("div", { class: `toast ${t.tone}` }, dot(TOAST_DOT[t.tone]), msg);
    const entry: Entry = { node, persistent: false, ...(t.key !== undefined ? { key: t.key } : {}) };
    const acts = h("span", { class: "actions" });
    if (t.action) {
      const { label, run } = t.action;
      const b = h("button", { type: "button", class: "pb" }, label);
      b.onclick = () => {
        remove(entry);
        run();
      };
      acts.append(b);
    }
    const x = h(
      "button",
      { type: "button", class: "pb icon ghost", "aria-label": "Dismiss", title: "Dismiss" },
      icon("x", 14),
    );
    x.onclick = () => remove(entry);
    acts.append(x);
    node.append(acts);

    const ms = toastLifetime(t);
    entry.persistent = ms === null;
    if (ms !== null) {
      const timer = pausableTimer(ms, () => remove(entry));
      entry.timer = timer;
      node.addEventListener("pointerenter", () => timer.pause("hover"));
      node.addEventListener("pointerleave", () => timer.resume("hover"));
      node.addEventListener("focusin", () => timer.pause("focus"));
      node.addEventListener("focusout", (e) => {
        if (!node.contains(e.relatedTarget as Node | null)) timer.resume("focus");
      });
    }

    const admitted = laneAdmit(entries, entry);
    for (const old of admitted.removed) remove(old);
    entries = admitted.lane;
    fit();
    // spoken on arrival, whether it shows now, waits or yields at once
    const said = toastAnnouncement(t);
    (said.assertive ? live.assertive : live.polite)(said.text);
  }

  return {
    show,
    dismiss(key) {
      for (const entry of entries.filter((e) => e.key === key)) remove(entry);
    },
    fit,
  };
};
