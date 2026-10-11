/**
 * The DMN view switch in #mode-slot (spec §2.2, §8): a `group` "Decision
 * view" of two aria-pressed buttons, [DRD | Table], in place of dmn-js' own
 * "View DRD". The menu's view radios mirror it; the degrade (step 3) shows
 * icons with their aria-label + tooltip, step 7 leaves it to the menu.
 *
 * The two buttons are built ONCE and updated in place on every
 * views.changed — pressing a segment switches the view, and a rebuild would
 * drop the keyboard user's focus on <body>. Hidden for a model without
 * DMNDI: that model IS its table, there is nothing to switch between.
 */
import type { DecisionViews } from "../core/engine.ts";
import { icon } from "../icons.ts";
import { h } from "./dom.ts";

/** renders the switch into `slot`; `changed` fires on every view change (the
 *  menu re-renders, the TL cluster re-measures) — returns the unmount */
export function mountViewSwitch(slot: HTMLElement, views: DecisionViews, changed: () => void): () => void {
  const group = h("div", { class: "seg", role: "group", "aria-label": "Decision view" });
  // the targets move with the views (an import, a multi-decision table pick)
  let drdId: string | undefined;
  let tableId: string | undefined;
  const segment = (label: string, name: string, glyph: "network" | "table-2", target: () => string | undefined) => {
    const b = h(
      "button",
      { type: "button", "aria-pressed": "false", "aria-label": name, title: name },
      icon(glyph, 14),
      h("span", { class: "label" }, label),
    );
    b.onclick = () => {
      const id = target();
      if (id) void views.openView(id);
    };
    return b;
  };
  const drd = segment("DRD", "Decision requirements (DRD)", "network", () => drdId);
  const table = segment("Table", "Decision table", "table-2", () => tableId);
  group.append(drd, table);

  const render = (): void => {
    const all = views.views();
    const active = views.activeView();
    const tables = all.filter((v) => v.type !== "drd");
    drdId = all.find((v) => v.type === "drd")?.id;
    tableId = (tables.find((v) => v.id === active?.id) ?? tables[0])?.id;
    group.hidden = drdId === undefined || tables.length === 0;
    drd.setAttribute("aria-pressed", String(active?.type === "drd"));
    table.setAttribute("aria-pressed", String(active?.type !== "drd"));
    changed();
  };
  const off = views.onViewsChanged(render);
  render();
  slot.append(group);
  return () => {
    off();
    group.remove();
  };
}
