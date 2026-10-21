/**
 * The context map widget's Legend panel (src/mcp-app/legend.ts) on the
 * panel shell every widget panel shares (chrome/panel.ts), with the real
 * Context Maps legend rows, under jsdom: the toggle joins the top-right
 * cluster once the model is on screen, opens a labelled panel whose heading
 * takes the focus, the close button and Escape give it back to the toggle,
 * and the superseded freeze takes the toggle away.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { PanelSpec, WidgetChrome } from "../src/mcp-app/chrome/contracts.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

test("the Legend panel: a toggle in the top-right cluster, a labelled panel the keyboard reaches and leaves", async () => {
  const { mountPanels } = await import("../src/mcp-app/chrome/panel.ts");
  const { mountLegend } = await import("../src/mcp-app/legend.ts");
  const { MIRAGON_RENDERERS } = await import("../src/notations/miragon/index.ts");
  const renderer = await MIRAGON_RENDERERS.find((s) => s.id === "context-map")!.load();

  const app = host();
  const tr = document.createElement("div");
  const open = document.createElement("button");
  tr.append(open);
  const lane = document.createElement("div");
  app.append(tr, lane);
  const panels = mountPanels({
    layout: () => ({ panel: { mode: "card", width: 360 } }) as ReturnType<Parameters<typeof mountPanels>[0]["layout"]>,
    closeTools: () => {},
  });
  const registered: PanelSpec[] = [];
  const chrome = {
    els: { tr, lane },
    registerPanel: (spec: PanelSpec) => {
      registered.push(spec);
      return panels.register(spec);
    },
  } as unknown as WidgetChrome;

  const extras = mountLegend(chrome, (body) => renderer.legend!(body));
  const toggle = tr.firstElementChild as HTMLButtonElement;
  assert.equal(toggle.id, "legend-toggle", "the toggle leads the cluster: it grows leftwards");
  assert.equal(toggle.hidden, true, "hidden until the model is on screen");
  assert.equal(registered[0]?.id, "legend");
  const panel = document.getElementById("legend")!;
  assert.equal(panel.nextElementSibling, lane, "after the corners, before the lane: the DOM order is the tab order");
  assert.equal(panel.getAttribute("aria-labelledby"), "legend-h");
  assert.equal(document.getElementById("legend-h")!.textContent, "Legend");
  const scroller = panel.querySelector<HTMLElement>(".panel-scroll")!;
  assert.deepEqual(
    [scroller.tabIndex, scroller.getAttribute("role"), scroller.getAttribute("aria-labelledby")],
    [0, "region", "legend-h"],
    "a scroller without controls takes the focus, so the keyboard scrolls it",
  );
  assert.equal(scroller.querySelectorAll('[role="group"]').length, 3, "the renderer's three groups");

  extras.onDocument({ repo: "r", path: "conference.cm.json" }, { repo: "r" });
  assert.equal(toggle.hidden, false);
  assert.deepEqual([toggle.getAttribute("aria-controls"), toggle.getAttribute("aria-expanded")], ["legend", "false"]);

  toggle.click();
  assert.equal(panel.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement, document.getElementById("legend-h"), "the heading takes the focus");
  panel.querySelector<HTMLButtonElement>('[aria-label="Close legend"]')!.click();
  assert.equal(panel.hidden, true);
  assert.equal(document.activeElement, toggle, "closing gives the focus back to the toggle");

  toggle.click();
  assert.equal(panels.escape(), true, "Escape closes it (the document's layering)");
  assert.equal(document.activeElement, toggle);

  extras.destroy();
  assert.equal(toggle.hidden, true, "superseded: the toggle goes");
  assert.equal(scroller.querySelector(".sr-only"), null, "and the rows' tooltips with it");
});
