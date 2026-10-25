/**
 * What an open side panel covers of the SPA's canvas or source
 * (src/lib/side-panel-room.ts), under jsdom with laid-out boxes: the panels
 * dock over the editor's right edge, so a Miragon editor's fit keeps their
 * width clear and the source's Monaco is laid out beside them (#288); a lazy
 * panel that joins the layers later still reports its change. Monaco never
 * reaches past a host laid out to a fraction of a pixel: the page would scroll
 * by that pixel, and with classic scrollbars shake (#326).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

const box = (element: Element, left: number, width: number): void => {
  element.getBoundingClientRect = () =>
    ({ left, right: left + width, width, top: 0, bottom: 640, height: 640, x: left, y: 0 }) as DOMRect;
};

interface FakeResizeObserver {
  resized: () => void;
  observed: Element[];
  disconnected: boolean;
}

/** jsdom has no ResizeObserver: one whose callback the test calls; returns the restore */
function fakeResizeObservers(observers: FakeResizeObserver[]): () => void {
  const globals = globalThis as { ResizeObserver?: unknown };
  const jsdomHasNone = globals.ResizeObserver;
  globals.ResizeObserver = class {
    private readonly record: FakeResizeObserver;
    constructor(resized: () => void) {
      this.record = { resized, observed: [], disconnected: false };
      observers.push(this.record);
    }
    observe(target: Element): void {
      this.record.observed.push(target);
    }
    disconnect(): void {
      this.record.disconnected = true;
    }
  };
  return () => {
    globals.ResizeObserver = jsdomHasNone;
  };
}

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

test("layoutBesideSidePanels: Monaco over its host minus what an open panel covers, again on a resize and as a panel opens or closes", async () => {
  const { layoutBesideSidePanels, sidePanelRoom } = await import("../src/lib/side-panel-room.ts");
  const observers: FakeResizeObserver[] = [];
  const restore = fakeResizeObservers(observers);
  try {
    const layers = host();
    const source = document.createElement("div");
    layers.append(source);
    box(source, 0, 1000); // jsdom's client size here: 1000×640
    const layouts: Array<{ width: number; height: number }> = [];
    const off = layoutBesideSidePanels(
      { layout: (dimension) => void layouts.push(dimension) },
      source,
      sidePanelRoom(
        () => layers,
        () => source,
      ),
    );
    assert.deepEqual(layouts, [{ width: 1000, height: 640 }], "no panel open: the whole host");
    assert.deepEqual(observers.at(0)?.observed, [source], "the host's resizes");

    const panel = document.createElement("aside");
    box(panel, 680, 320);
    layers.append(panel);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(layouts.at(-1), { width: 680, height: 640 }, "a panel opened: left of it");

    Object.defineProperty(source, "clientWidth", { configurable: true, value: 1200 });
    box(source, 0, 1200);
    box(panel, 880, 320);
    observers.at(0)?.resized();
    assert.deepEqual(layouts.at(-1), { width: 880, height: 640 }, "the window grew: still left of the panel");

    panel.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(layouts.at(-1), { width: 1200, height: 640 }, "the panel closed: the whole host again");

    off();
    assert.equal(observers.at(0)?.disconnected, true);
    const laidOut = layouts.length;
    layers.append(document.createElement("aside"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(layouts.length, laidOut, "stopped: no layout after");
  } finally {
    restore();
  }
});

test("layoutBesideSidePanels: a host laid out to a fraction of a pixel gets Monaco rounded down, never the half pixel clientWidth and clientHeight round up", async () => {
  const { layoutBesideSidePanels, sidePanelRoom } = await import("../src/lib/side-panel-room.ts");
  const observers: FakeResizeObserver[] = [];
  const restore = fakeResizeObservers(observers);
  try {
    const layers = host();
    const source = document.createElement("div");
    layers.append(source);
    // a 1280×800 window at 110 %: the browser lays the host out to 1163.64×617.5 and rounds its client size up
    const laidOut = (width: number, height: number): void => {
      source.style.width = `${width}px`;
      source.style.height = `${height}px`;
      Object.defineProperty(source, "clientWidth", { configurable: true, value: Math.round(width) });
      Object.defineProperty(source, "clientHeight", { configurable: true, value: Math.round(height) });
      box(source, 0, width);
    };
    laidOut(1163.64, 617.5);
    const layouts: Array<{ width: number; height: number }> = [];
    layoutBesideSidePanels(
      { layout: (dimension) => void layouts.push(dimension) },
      source,
      sidePanelRoom(
        () => layers,
        () => source,
      ),
    );
    assert.deepEqual(layouts, [{ width: 1163, height: 617 }], "inside the host, not 1164×618");

    const panel = document.createElement("aside");
    box(panel, 843.64, 320);
    layers.append(panel);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(layouts.at(-1), { width: 843, height: 617 }, "a panel opened: left of it, not under its edge");

    laidOut(1163.64, 609.75);
    observers.at(0)?.resized();
    assert.deepEqual(layouts.at(-1), { width: 843, height: 609 }, "resized: rounded down again");
  } finally {
    restore();
  }
});
