/**
 * The widget's Legend panel (src/mcp-app/legend.ts) on the panel shell every
 * widget panel shares (chrome/panel.ts), with the real Context Maps and Team
 * Topologies legend rows, under jsdom: the toggle joins the top-right
 * cluster once the model is on screen, opens a labelled panel whose heading
 * takes the focus, the close button and Escape give it back to the toggle,
 * and the superseded freeze takes the toggle away. The rows' layout
 * (lib/miragon-legend.css, shared with the SPA's Legend side panel) names
 * only classes the renderers draw.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import type { PanelSpec, WidgetChrome } from "../src/mcp-app/chrome/contracts.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

async function legendOf(id: string): Promise<(body: HTMLElement) => () => void> {
  const { MIRAGON_RENDERERS } = await import("../src/notations/miragon/index.ts");
  const renderer = await MIRAGON_RENDERERS.find((s) => s.id === id)!.load();
  return (body) => renderer.legend!(body);
}

/** the widget's chrome around a Legend panel: the top-right cluster, the lane and the panel shell */
async function widgetChrome() {
  const { mountPanels } = await import("../src/mcp-app/chrome/panel.ts");
  const app = host();
  const tr = document.createElement("div");
  const fullscreen = document.createElement("button");
  const open = document.createElement("button");
  tr.append(fullscreen, open);
  const lane = document.createElement("div");
  app.append(tr, lane);
  const panels = mountPanels({
    layout: () => ({ panel: { mode: "card", width: 360 } }) as ReturnType<Parameters<typeof mountPanels>[0]["layout"]>,
    closeTools: () => {},
  });
  const registered: PanelSpec[] = [];
  const chrome = {
    els: { tr, fullscreen, lane },
    registerPanel: (spec: PanelSpec) => {
      registered.push(spec);
      return panels.register(spec);
    },
  } as unknown as WidgetChrome;
  return { tr, fullscreen, lane, panels, registered, chrome };
}

test("the Legend panel: a toggle in the top-right cluster, a labelled panel the keyboard reaches and leaves", async () => {
  const { mountLegend } = await import("../src/mcp-app/legend.ts");
  const { tr, fullscreen, lane, panels, registered, chrome } = await widgetChrome();

  const extras = mountLegend(chrome, await legendOf("context-map"));
  const toggle = tr.firstElementChild as HTMLButtonElement;
  assert.equal(toggle.id, "legend-toggle", "the toggle leads fullscreen and Open: the cluster grows leftwards");
  assert.equal(toggle.nextElementSibling, fullscreen, "a Todos toggle, arriving later, lands left of it");
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

test("the Legend panel of a team topology: the renderer's lists under their headings, gone with the panel", async () => {
  const { mountLegend } = await import("../src/mcp-app/legend.ts");
  const { lane, chrome } = await widgetChrome();
  const extras = mountLegend(chrome, await legendOf("team-topology"));
  const body = lane.previousElementSibling!.querySelector(".panel-scroll > .miragon-legend")!;
  assert.deepEqual(
    [...body.children].map((child) => child.tagName.toLowerCase()),
    ["p", "ul", "div", "p", "ul", "div", "p", "ul"],
    "a heading and a list per group, a rule between the groups",
  );
  assert.equal(body.querySelectorAll(".cd-shell-legend-row").length, 9);
  extras.destroy();
  assert.equal(body.childElementCount, 0, "superseded: the rows go with the toggle");
});

test("the rows' layout names only classes the renderers' legends draw", async () => {
  const sheet = readFileSync(new URL("../src/lib/miragon-legend.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const styled = new Set(
    [...sheet.matchAll(/([^{}]+)\{/g)].flatMap(([, selector]) =>
      [...selector!.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(([, name]) => name!),
    ),
  );
  styled.delete("miragon-legend");
  const drawn = new Set<string>();
  for (const id of ["context-map", "team-topology"]) {
    const body = host();
    const remove = (await legendOf(id))(body);
    for (const node of body.querySelectorAll("[class]")) for (const name of node.classList) drawn.add(name);
    remove();
    body.remove();
  }
  assert.ok(styled.size >= 7, [...styled].join(", "));
  assert.deepEqual(
    [...styled].filter((name) => !drawn.has(name)),
    [],
    "a class a renderer release renamed or dropped",
  );
});
