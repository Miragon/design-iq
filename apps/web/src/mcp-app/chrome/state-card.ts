/**
 * The state cards (spec §5.3, CI §8 empty state): the centred dead ends and
 * the load in progress — booting, loading, no input, no repository, the
 * bridge, read, import and renderer failures, the frozen copy that would not
 * import. While one shows it owns the widget: `#app[data-state=<kind>]`
 * hides the work chrome (chrome.css) and `#canvas` goes inert. With no
 * canvas behind it the card sits on the paper with its dot grid; on a
 * re-delivery the previous canvas stays visible behind it, inert.
 *
 * Official app icon, title, one help line, the error in mono, at most two
 * actions (core/feedback.ts stateCopy / stateActionPlan). A failure card
 * puts the focus on its primary action when the widget has the focus — the
 * control that had it is hidden now; a loading card never moves it.
 */
import { appIconElement } from "@/lib/comet";

import { stateCopy } from "../core/feedback.ts";
import { icon } from "../icons.ts";
import type { MountStateCards, StateCardKind } from "./contracts.ts";
import { h } from "./dom.ts";

export const mountStateCards: MountStateCards = (deps) => {
  const { app, canvas, state: root } = deps.els;
  let current: StateCardKind | undefined;

  return {
    show(card) {
      const was = current;
      current = card?.kind;
      if (!card) {
        root.hidden = true;
        root.replaceChildren();
        delete app.dataset.state;
        canvas.inert = false;
        return;
      }
      const copy = stateCopy(card, deps.notationLabel);
      const title = h("h2", { id: "state-title" });
      if (copy.spinner) title.append(icon("loader-circle", 18, "spin"));
      title.append(copy.title);
      const box = h(
        "div",
        {
          class: "state-card",
          role: copy.role,
          "aria-labelledby": "state-title",
          ...(copy.help ? { "aria-describedby": "state-help" } : {}),
        },
        appIconElement(40),
        title,
        copy.help ? h("p", { id: "state-help" }, copy.help) : undefined,
        card.error ? h("div", { class: "err" }, card.error) : undefined,
      );
      const actions = deps.actions(card).slice(0, 2);
      let primary: HTMLButtonElement | undefined;
      if (actions.length > 0) {
        const row = h("div", { class: "actions" });
        for (const a of actions) {
          const b = h("button", { type: "button", class: a.primary ? "pb primary" : "pb" });
          if (a.icon) b.append(icon(a.icon, 14));
          b.append(a.label);
          b.onclick = () => a.run();
          if (a.primary && !primary) primary = b;
          row.append(b);
        }
        box.append(row);
      }
      root.className = deps.hasCanvas() ? "state" : "state paper";
      root.replaceChildren(box);
      root.hidden = false;
      app.dataset.state = card.kind;
      canvas.inert = true;
      // the focused control is hidden under the card now — hand the focus to
      // the way out, but never pull it out of the chat composer
      if (primary && card.kind !== was && document.hasFocus()) primary.focus();
    },
    current: () => current,
  };
};
