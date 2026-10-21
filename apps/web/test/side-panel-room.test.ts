/**
 * What an open side panel covers of the SPA's canvas (src/lib/side-panel-room.ts),
 * under jsdom with laid-out boxes: the panels dock over the canvas's right
 * edge, so a Miragon editor's fit keeps their width clear; a lazy panel that
 * joins the layers later still reports its change.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

const box = (element: Element, left: number, width: number): void => {
  element.getBoundingClientRect = () =>
    ({ left, right: left + width, width, top: 0, bottom: 640, height: 640, x: left, y: 0 }) as DOMRect;
};

test("sidePanelRoom: the width an open panel covers, 0 without one, a change once a panel joins or leaves", async () => {
  const { sidePanelRoom } = await import("../src/lib/side-panel-room.ts");
  const layers = host();
  const canvas = document.createElement("div");
  layers.append(canvas);
  box(canvas, 0, 1000);
  const room = sidePanelRoom(
    () => layers,
    () => canvas,
  );
  assert.equal(room.covered(), 0, "no panel open");
  let changes = 0;
  const off = room.onChange(() => void changes++);

  const panel = document.createElement("aside");
  box(panel, 680, 320);
  layers.append(panel);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(changes, 1, "a panel joined");
  assert.equal(room.covered(), 320);

  box(canvas, 400, 600); // the split view: the canvas is the right pane
  assert.equal(room.covered(), 320, "the panel covers the pane's right edge as much");
  box(panel, 1000, 320);
  assert.equal(room.covered(), 0, "a panel beside the canvas covers none of it");

  panel.remove();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(changes, 2, "and left");
  assert.equal(room.covered(), 0);
  off();
  layers.append(document.createElement("aside"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(changes, 2, "unsubscribed");
});
