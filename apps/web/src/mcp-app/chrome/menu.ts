/**
 * The document menu (spec §3): the top-left trigger `[menu | comet | name]`
 * and its dropdown — the identity header and the less frequent moves.
 * core/menu-model.ts decides WHAT is offered in which state (and the key
 * model); this renders it as a WAI-ARIA menu button:
 *
 *   Enter / Space / ↓ open on the first enabled item, ↑ on the last
 *   ↑ ↓ wrap, Home / End jump, a letter jumps to the next item starting with it
 *   Enter / Space activate — a checkbox item (Workshop) toggles and stays open
 *   Escape closes and returns the focus to the trigger (chrome/keys.ts layer),
 *   Tab closes and moves on, a click outside closes
 *
 * "Reload latest version" with unsaved edits first expands an inline
 * destructive confirm IN the menu (CI §9): "Discard your unsaved change?"
 * [Cancel] [Discard and reload]; Escape there cancels the confirm only.
 * A re-render while open (the state moved) keeps the focus on the same item.
 */
import { appIconElement, cometElement } from "@/lib/comet";

import { isTypeAhead, triggerOpen } from "../core/keymap.ts";
import type { DocLabel } from "../core/lifecycle.ts";
import {
  buildMenu,
  docName,
  menuHeader,
  type MenuItem,
  type MenuItemId,
  menuKeyNav,
  triggerLabels,
} from "../core/menu-model.ts";
import { icon } from "../icons.ts";
import type { MountMenu } from "./contracts.ts";
import { h } from "./dom.ts";

/** one focusable row in DOM order — the items and, while it is open, the
 *  inline confirm's two buttons (the roving focus walks them all) */
interface Entry {
  key: string;
  node: HTMLButtonElement;
  label: string;
  disabled?: boolean;
}

export const mountMenu: MountMenu = (deps) => {
  const { trigger, docName: nameEl, menu } = deps.els;
  let doc: DocLabel | undefined;
  let visible = true;
  let confirming: MenuItemId | undefined;
  let entries: Entry[] = [];

  // decorative (aria-hidden); the first thing the measured degrade drops (step 1)
  const comet = cometElement(8);
  comet.classList.add("comet");
  trigger.querySelector(".sep")?.after(comet);

  const isOpen = (): boolean => !menu.hidden;

  function close(returnFocus: boolean): boolean {
    if (!isOpen()) return false;
    menu.hidden = true;
    confirming = undefined;
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus && !trigger.hidden) trigger.focus();
    return true;
  }

  function end(item: MenuItem): HTMLElement | undefined {
    const slot = h("span", { class: "end" });
    if (item.disabled && item.hint) slot.append(h("span", { class: "hint" }, item.hint));
    else if (item.kbd) slot.append(h("span", { class: "kbd" }, item.kbd));
    if (item.count !== undefined) slot.append(h("span", { class: "count" }, String(item.count)));
    if (item.verdict) {
      const chip = h("span", { class: `verdict ${item.verdict.tone}` });
      if (item.verdict.tone !== "muted") chip.append(icon(item.verdict.tone === "ok" ? "check" : "x", 12));
      chip.append(item.verdict.text);
      slot.append(chip);
    }
    if (item.id === "workshop") slot.append(h("span", { class: "switch", "aria-hidden": "true" }));
    if (item.role === "menuitemradio" && item.checked) slot.append(icon("check", 14, "tick"));
    return slot.childElementCount > 0 ? slot : undefined;
  }

  function row(item: MenuItem): HTMLButtonElement {
    const b = h(
      "button",
      { type: "button", class: "mi", role: item.role, tabindex: "-1", "data-key": item.id },
      icon(item.icon, 16),
      h("span", { class: "label" }, item.label),
    );
    const tail = end(item);
    if (tail) b.append(tail);
    if (item.checked !== undefined) b.setAttribute("aria-checked", String(item.checked));
    if (item.disabled) b.setAttribute("aria-disabled", "true");
    if (item.hint) b.title = item.hint;
    b.onclick = () => activate(item);
    return b;
  }

  function confirmRow(item: MenuItem & { confirm: NonNullable<MenuItem["confirm"]> }): HTMLElement {
    const { question, cancel, confirm } = item.confirm;
    const no = h(
      "button",
      { type: "button", class: "pb", role: "menuitem", tabindex: "-1", "data-key": "confirm:no" },
      cancel,
    );
    const yes = h(
      "button",
      { type: "button", class: "pb danger", role: "menuitem", tabindex: "-1", "data-key": "confirm:yes" },
      confirm,
    );
    no.onclick = () => cancelConfirm();
    yes.onclick = () => {
      close(true);
      deps.onSelect(item.id);
    };
    entries.push({ key: "confirm:no", node: no, label: cancel }, { key: "confirm:yes", node: yes, label: confirm });
    // the group's name carries the question (a menu holds no loose text)
    return h(
      "div",
      { class: "mi-confirm", role: "group", "aria-label": question },
      h("span", { class: "q", "aria-hidden": "true" }, question),
      h("span", { class: "row" }, no, yes),
    );
  }

  function activate(item: MenuItem): void {
    if (item.disabled) return;
    if (item.confirm && confirming !== item.id) {
      confirming = item.id;
      render("confirm:no");
      return;
    }
    if (item.keepsOpen) {
      deps.onSelect(item.id);
      render(item.id);
      return;
    }
    close(true);
    deps.onSelect(item.id);
  }

  function cancelConfirm(): void {
    const id = confirming;
    confirming = undefined;
    render(id);
  }

  /** `focusKey`: the entry to focus after the render; default = the one that
   *  had the focus (a re-render must not drop the keyboard user on <body>) */
  function render(focusKey?: string): void {
    const active = document.activeElement;
    const keep = focusKey ?? entries.find((e) => e.node === active)?.key;
    menu.replaceChildren();
    entries = [];
    if (doc) {
      const head = menuHeader(doc, deps.notation, deps.displayName());
      menu.append(
        h(
          "div",
          { class: "menu-head", role: "presentation" },
          appIconElement(32),
          h("span", { class: "t" }, head.name),
          h("span", { class: "sub" }, head.sub),
          h("span", { class: "sub" }, head.repo),
          head.path ? h("span", { class: "path" }, head.path) : undefined,
        ),
      );
    }
    const groups = buildMenu(deps.context());
    // the confirm stays only while its item still asks for it (a save landed meanwhile: gone)
    if (confirming && !groups.some((g) => g.items.some((i) => i.id === confirming && i.confirm))) {
      confirming = undefined;
    }
    for (const group of groups) {
      if (menu.childElementCount > 0) menu.append(h("hr", { role: "separator" }));
      for (const item of group.items) {
        const node = row(item);
        entries.push({ key: item.id, node, label: item.label, ...(item.disabled ? { disabled: true } : {}) });
        menu.append(node);
        if (item.confirm && confirming === item.id) menu.append(confirmRow({ ...item, confirm: item.confirm }));
      }
    }
    if (keep) entries.find((e) => e.key === keep)?.node.focus();
  }

  function open(at: "first" | "last"): void {
    render();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const enabled = entries.filter((e) => !e.disabled);
    (at === "last" ? enabled[enabled.length - 1] : enabled[0])?.node.focus();
  }

  trigger.addEventListener("click", () => (isOpen() ? close(true) : open("first")));
  trigger.addEventListener("keydown", (e) => {
    const at = triggerOpen(e.key);
    if (!at) return;
    e.preventDefault();
    open(at);
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      // close and move on FROM the trigger: the browser's Tab runs after this
      // handler, from wherever the focus is then
      close(true);
      return;
    }
    if (e.key === "Escape" && confirming) {
      // the confirm is the topmost layer: Escape cancels it, the menu stays
      e.preventDefault();
      e.stopPropagation();
      cancelConfirm();
      return;
    }
    const nav = ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || isTypeAhead(e);
    if (!nav) return;
    const current = entries.findIndex((en) => en.node === document.activeElement);
    const next = menuKeyNav(entries, current, e.key);
    e.preventDefault();
    if (next !== current) entries[next]?.node.focus();
  });
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (isOpen() && !menu.contains(t) && !trigger.contains(t)) close(false);
  });

  return {
    setDocument(next) {
      doc = next;
      nameEl.textContent = docName(next);
      const labels = triggerLabels(next);
      trigger.setAttribute("aria-label", labels.ariaLabel);
      trigger.title = labels.title;
      trigger.hidden = !visible;
      if (isOpen()) render();
    },
    setVisible(show) {
      visible = show;
      trigger.hidden = !show || !doc;
      if (!show) close(false);
    },
    isOpen,
    close,
    refresh() {
      if (isOpen()) render();
    },
  };
};
