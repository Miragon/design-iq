/**
 * The legend of a notation that has one (context map), as a panel of the
 * widget's own (spec §7) instead of the renderer's card: the card covered
 * the diagram's lower left, the panel is a card at the right whose width the
 * fit leaves free (core/layout.ts fitInsets), or a sheet in a compact frame.
 * The toggle sits in the top-right cluster like Todos and Checks and the
 * menu repeats it as the Model group's Legend checkbox (guide §5.4), so the
 * keyboard reaches it both ways; the heading takes the focus on open, and
 * every row's meaning is part of its text for a screen reader.
 * It starts closed, as the guide's legend does in every container (§5.10),
 * and an open on load would pull the focus into the widget.
 */
import type { WidgetChrome } from "./chrome/contracts.ts";
import { h } from "./chrome/dom.ts";
import type { WidgetExtras } from "./core/lifecycle.ts";
import { icon } from "./icons.ts";

export function mountLegend(chrome: WidgetChrome, render: (body: HTMLElement) => () => void): WidgetExtras {
  const toggle = h(
    "button",
    {
      id: "legend-toggle",
      class: "fb toggle",
      type: "button",
      hidden: "",
      title: "What the shapes and marks mean",
    },
    icon("book-open"),
    h("span", { class: "label" }, "Legend"),
  );
  const heading = h("h2", { id: "legend-h" }, icon("book-open"), "Legend");
  const close = h(
    "button",
    { class: "pb icon ghost", type: "button", title: "Close legend (Esc)", "aria-label": "Close legend" },
    icon("x"),
  );
  const body = h("div", { class: "miragon-legend" });
  // a scroller without a control in it: focusable, so the keyboard scrolls it
  const scroller = h(
    "div",
    { class: "panel-scroll", tabindex: "0", role: "region", "aria-labelledby": "legend-h" },
    body,
  );
  const panel = h(
    "aside",
    { id: "legend", class: "panel", hidden: "", "aria-labelledby": "legend-h" },
    h("div", { class: "panel-head" }, heading, h("span", { class: "spacer" }), close),
    scroller,
  );
  // beside fullscreen: the Todos toggle, which arrives late (tracker
  // discovery), stays left of it and grows the cluster leftwards
  chrome.els.fullscreen.before(toggle);
  // in the panels' place in the DOM order: after the corners, before the lane
  chrome.els.lane.before(panel);
  const untip = render(body);
  const handle = chrome.registerPanel({ id: "legend", panel, toggle, heading });
  close.onclick = () => handle.close();
  return {
    onDocument: () => handle.setAvailable(true),
    destroy() {
      handle.setAvailable(false);
      untip();
    },
  };
}
