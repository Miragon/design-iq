/**
 * The sync pill (bottom-left), its popover and the two live regions (spec §4,
 * §8) — the DOM side of core/sync-view.ts, which owns every word, tone and
 * the precedence.
 *
 * The pill is ALWAYS a button (never role=status): a click opens the popover
 * with the detail (the autosave note, the last save's time, every finding,
 * Save now), or — while a decision card is deferred into it — reopens that
 * card. `failed` renders two sibling buttons in one group, `[● Not saved]
 * [Retry]`, never a button inside a button. What changes is spoken by the
 * separate visually hidden regions: class changes only (createAnnouncer), so
 * Saving → Saved never chatters, and never over a toast that says it.
 *
 * The pill and its children are kept, not rebuilt: a state change while the
 * pill, the failed group's Retry or a popover button has focus must not drop
 * the focus on <body>. The popover is non-modal but sits last in #app: Tab off
 * its last stop moves on FROM the pill (like the menu from its trigger),
 * Shift+Tab off its first lands on the pill.
 * Relative imports, no "@/": node --test loads it (test/widget-chrome-dom.test.ts).
 */
import { safePresenceColor, safePresenceLabel } from "../../lib/presence-format.ts";
import type { PeerLabel, SyncState } from "../core/lifecycle.ts";
import { avatarRow, createAnnouncer, speakBeat, syncPopover, syncView, type Utterance } from "../core/sync-view.ts";
import { icon } from "../icons.ts";
import type { ChromeElements, LiveRegions, MountSync } from "./contracts.ts";
import { dot, h } from "./dom.ts";

/**
 * #announce (polite) and #alert (assertive). A region is cleared and written
 * a beat later, so the same sentence twice is spoken twice; what arrives
 * within that beat is joined (sync-view.ts speakBeat) — every event, and the
 * pill's sentence only when no event speaks for the same transition. A
 * timeout, not a frame: a chat scrolled past the widget still hears it.
 */
export function mountLiveRegions(els: Pick<ChromeElements, "announce" | "alert">): LiveRegions {
  let beat: Utterance[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const say = (u: Utterance): void => {
    const text = u.text.trim();
    if (!text) return;
    const node = u.assertive ? els.alert : els.announce;
    // the first sentence of the beat for its region clears it
    if (!beat.some((b) => (b.assertive === true) === (u.assertive === true))) node.textContent = "";
    beat.push({ ...u, text });
    timer ??= setTimeout(() => {
      const spoken = speakBeat(beat);
      if (spoken.polite) els.announce.textContent = spoken.polite;
      if (spoken.assertive) els.alert.textContent = spoken.assertive;
      beat = [];
      timer = undefined;
    }, 60);
  };
  return {
    polite: (text) => say({ text }),
    assertive: (text) => say({ text, assertive: true }),
    state: (text) => say({ text, state: true }),
  };
}

/** a peer's avatar: their presence colour (sanitised, like the SPA's
 *  PeerAvatar and the canvas cursors), initials or — for an agent — the
 *  message mark; the name in the title and in the popover */
function avatar(p: { name: string; color: string; initials: string; agent: boolean }): HTMLElement {
  const node = h("span", { class: "avatar", title: safePresenceLabel(p.name) });
  node.style.background = safePresenceColor(p.color);
  node.append(p.agent ? icon("message-square-text", 12) : p.initials);
  return node;
}

export const mountSync: MountSync = (deps) => {
  const { sync: slot, syncPopover: pop } = deps.els;
  let state: SyncState = { kind: "loading" };
  let peers: PeerLabel[] = [];
  let activity: string | undefined;
  let tooltip = "";
  const announce = createAnnouncer();

  const pill = h("button", {
    type: "button",
    class: "pill",
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
    "aria-controls": pop.id,
  });
  // the failed group's second button: the one-click way back to a landed save
  const retry = h(
    "button",
    { type: "button", class: "pill act", "aria-label": "Retry saving now", title: "Retry saving now" },
    "Retry",
  );
  const group = h("span", { class: "pill-group", role: "group", "aria-label": "Save state" });
  retry.onclick = () => deps.onAction("retry-now");
  slot.append(pill);

  const titleId = `${pop.id}-title`;
  pop.setAttribute("aria-labelledby", titleId);
  const isOpen = (): boolean => !pop.hidden;

  function closePopover(returnFocus = true): boolean {
    if (!isOpen()) return false;
    pop.hidden = true;
    pill.setAttribute("aria-expanded", "false");
    if (returnFocus && pill.isConnected) pill.focus();
    return true;
  }

  function renderPill(): void {
    const view = syncView(state, peers);
    slot.hidden = view.hidden;
    if (view.hidden) closePopover(false);
    pill.className = view.tone === "neutral" ? "pill" : `pill ${view.tone}`;
    pill.setAttribute("aria-label", view.ariaLabel);
    // the findings list rides the title (the popover lists them as rows); Live
    // carries the SPA's ConnectionState title
    const findings = state.kind === "saved" && (state.findings?.errors.length || state.findings?.warnings.length);
    if (findings && tooltip) pill.title = tooltip;
    else if (view.title) pill.title = view.title;
    else pill.removeAttribute("title");
    const lead = view.icon
      ? icon(view.icon, 14, view.spinner ? "spin" : view.icon === "check" ? "ok" : undefined)
      : dot(view.dot ?? "");
    const parts: Node[] = [lead, h("span", { class: "label" }, view.label)];
    if (state.kind === "live" && peers.length > 0) {
      const row = avatarRow(peers, deps.fullscreen());
      if (row.sub) parts.push(h("span", { class: "sub" }, row.sub));
      const avatars = h("span", { class: "avatars", "aria-hidden": "true" });
      for (const p of row.shown) avatars.append(avatar(p));
      if (row.overflow > 0) avatars.append(h("span", { class: "avatar more" }, `+${row.overflow}`));
      parts.push(avatars);
    }
    pill.replaceChildren(...parts);
    // re-parenting blurs: only move the pill when the group comes or goes,
    // and give the focus back if the pill OR the group's Retry had it (a
    // keyboard Retry leaves on the pill, whose label now says the outcome)
    const grouped = pill.parentElement === group;
    if (grouped !== view.retry) {
      const focused = slot.contains(document.activeElement);
      if (view.retry) {
        group.replaceChildren(pill, retry);
        slot.replaceChildren(group);
      } else {
        slot.replaceChildren(pill);
      }
      if (focused) pill.focus();
    }
  }

  function renderPopover(): void {
    // the focus survives the re-render (a state change while a button is focused)
    const active = document.activeElement as HTMLElement | null;
    const focusKey =
      active && pop.contains(active) ? active.closest<HTMLElement>("[data-key]")?.dataset.key : undefined;
    const p = syncPopover(state, { ...deps.context(), ...(activity ? { activity } : {}), peers });
    const heading = h("h3", { id: titleId, tabindex: "-1", "data-key": "title", "data-tone": p.tone });
    heading.append(
      p.icon ? icon(p.icon, 14, p.spinner ? "spin" : p.icon === "check" ? "ok" : undefined) : dot(p.dot ?? ""),
      h("span", {}, p.title),
    );
    if (p.time) heading.append(h("span", { class: "time", title: `Last saved at ${p.time}` }, p.time));
    const body: Node[] = [heading, ...p.lines.map((line) => h("p", {}, line))];
    if (p.findings.length > 0) {
      const list = h("ul", { class: "findings", "aria-label": "Findings of the last save" });
      p.findings.forEach((f, i) =>
        list.append(
          h(
            "li",
            { class: f.tone === "danger" ? "finding danger" : "finding", tabindex: "0", "data-key": `finding:${i}` },
            icon(f.tone === "danger" ? "circle-alert" : "triangle-alert", 14),
            h("span", {}, f.text),
          ),
        ),
      );
      body.push(list);
    }
    if (p.footnote) body.push(h("p", {}, p.footnote));
    if (p.hereNow) body.push(h("p", {}, p.hereNow));
    if (p.actions.length > 0) {
      const row = h("div", { class: "actions" });
      for (const a of p.actions) {
        if (a.hint) row.append(h("span", { class: "hint" }, a.hint));
        const b = h("button", { type: "button", class: "pb", "data-key": `act:${a.id}` }, icon(a.icon, 14), a.label);
        if (a.kbd) b.append(h("span", { class: "kbd" }, a.kbd));
        if (a.title) b.title = a.title;
        b.disabled = a.disabled === true;
        b.onclick = () => {
          closePopover(true);
          deps.onAction(a.id);
        };
        row.append(b);
      }
      body.push(row);
    }
    pop.replaceChildren(...body);
    if (focusKey) {
      // a button that went disabled meanwhile (Save now, once saved) hands the focus to the heading
      const again = pop.querySelector<HTMLElement>(`[data-key="${focusKey}"]:not(:disabled)`);
      (again ?? heading).focus();
    }
  }

  pill.onclick = () => {
    // paused: the card the pill stands for, never a popover about it
    if (deps.reopenDecision()) {
      closePopover(false);
      return;
    }
    if (isOpen()) {
      closePopover(true);
      return;
    }
    renderPopover();
    pop.hidden = false;
    pill.setAttribute("aria-expanded", "true");
    pop.querySelector<HTMLElement>(`#${titleId}`)?.focus();
  };

  // outside click closes; so does the focus moving on to something else in
  // the widget (non-modal: Tab is never trapped)
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (isOpen() && !pop.contains(t) && !slot.contains(t)) closePopover(true);
  });
  pop.addEventListener("focusout", (e) => {
    const next = e.relatedTarget as Node | null;
    if (next && !pop.contains(next) && !slot.contains(next)) closePopover(false);
  });
  // Tab only where it would leave the popover: the inner stops stay reachable
  pop.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const stops = [...pop.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')];
    const at = document.activeElement;
    if (e.shiftKey) {
      // back out onto the pill the dialog belongs to
      if (at === pop.querySelector(`#${titleId}`) || at === stops[0]) {
        e.preventDefault();
        closePopover(true);
      }
    } else if (stops.length === 0 || at === stops[stops.length - 1]) {
      // close and move on FROM the pill: the browser's Tab runs after this
      closePopover(true);
    }
  });

  renderPill();
  return {
    set(next) {
      state = next;
      const said = announce(next);
      if (said) deps.live.state(said);
      renderPill();
      if (isOpen()) renderPopover();
    },
    setPeers(next) {
      peers = next;
      renderPill();
      if (isOpen()) renderPopover();
    },
    setActivity(text, findingsTooltip) {
      activity = text;
      if (findingsTooltip !== undefined) tooltip = findingsTooltip;
      renderPill();
      if (isOpen()) renderPopover();
    },
    refresh() {
      renderPill();
      if (isOpen()) renderPopover();
    },
    isPopoverOpen: isOpen,
    closePopover: () => closePopover(true),
  };
};
