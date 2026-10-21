/**
 * The widget chrome as shell.ts composes it (mountChrome), under jsdom on the
 * real skeletons (mcp-app-miragon.html, mcp-app.html): what only the
 * composition decides. A Miragon widget binds the zoom keys and ⇧1 to the
 * view and keeps them off behind a state card; the bpmn widget leaves them
 * to its canvas. The menu's Legend toggles the registered panel.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import { JSDOM } from "jsdom";

import type { WidgetChrome } from "../src/mcp-app/chrome/contracts.ts";
import type { ViewControls } from "../src/mcp-app/core/engine.ts";
// the "@/" alias the chrome's modules import through
import { closeDom } from "./renderer-dom.ts";

after(closeDom);

const ENTRIES = { miragon: "mcp-app-miragon.html", bpmn: "mcp-app.html" } as const;

/** one widget page: the skeleton's body, the globals the chrome reads, a host that records */
function page(kind: keyof typeof ENTRIES) {
  const html = readFileSync(new URL(`../${ENTRIES[kind]}`, import.meta.url), "utf8").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  const { window } = dom;
  const globals = globalThis as Record<string, unknown>;
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "KeyboardEvent",
    "MouseEvent",
    "Event",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ]) {
    Object.defineProperty(globals, key, {
      value: (window as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  globals.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  const links: string[] = [];
  const app = {
    addEventListener() {},
    getHostContext: () => ({ displayMode: "inline", availableDisplayModes: ["inline"] }),
    getHostCapabilities: () => ({ openLinks: {} }),
    requestDisplayMode: async () => ({ mode: "inline" }),
    sendSizeChanged: async () => ({}),
    openLink: async ({ url }: { url: string }) => {
      links.push(url);
      return { isError: false };
    },
  };
  return { window, document: window.document, app, links, close: () => window.close() };
}

async function chromeOf(kind: keyof typeof ENTRIES) {
  const p = page(kind);
  const { mountChrome } = await import("../src/mcp-app/shell.ts");
  const chrome: WidgetChrome = mountChrome({
    app: p.app as never,
    notation: kind === "miragon" ? "context-map" : "bpmn",
    noun: "model",
    readonly: false,
    actions: {
      save() {},
      reload() {},
      flushNow: async () => {},
      openInDesignIQ() {},
      deepLink: () => false,
      retry() {},
      askAssistant() {},
      state: () => ({ dirty: false, live: true, saving: false, paused: false, inactive: false, editable: true }),
      displayName: () => undefined,
      modelerMenu: () => undefined,
    },
  });
  const zoomed: string[] = [];
  const view: ViewControls = {
    hasViewport: () => true,
    fit: () => void zoomed.push("fit"),
    zoomBy: (step) => void zoomed.push(step > 0 ? "in" : "out"),
    zoomTo: (level) => void zoomed.push(`to ${level}`),
    level: () => 1,
    isTouched: () => false,
    onChange: () => () => {},
  };
  chrome.setDocument({ repo: "r", path: "processes/conference.cm.json" });
  chrome.setZoom(view);
  chrome.setSync({ kind: "live" } as never);
  const press = (key: string, code: string, mods: Partial<KeyboardEventInit>): boolean => {
    const event = new p.window.KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods });
    p.document.body.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { ...p, chrome, zoomed, press };
}

test("a Miragon widget: the zoom keys run the view, a state card leaves them to the browser", async () => {
  const w = await chromeOf("miragon");
  assert.equal(w.press("=", "Equal", { ctrlKey: true }), true, "the page does not zoom");
  assert.equal(w.press("-", "Minus", { ctrlKey: true }), true);
  assert.equal(w.press("0", "Digit0", { ctrlKey: true }), true);
  assert.deepEqual(w.zoomed, ["in", "out", "to 1"]);

  w.chrome.showState({ kind: "read-failed", error: "gone" });
  assert.equal(w.press("=", "Equal", { ctrlKey: true }), false, "a state card hides the diagram");
  assert.deepEqual(w.zoomed, ["in", "out", "to 1"]);

  w.close();
});

test("the bpmn widget: its canvas keeps the zoom keys", async () => {
  const w = await chromeOf("bpmn");
  assert.equal(w.press("=", "Equal", { ctrlKey: true }), false);
  assert.equal(w.press("0", "Digit0", { ctrlKey: true }), false);
  assert.deepEqual(w.zoomed, [], "bpmn-js binds them on the focused canvas");
  w.close();
});

test("the menu's Legend toggles the registered panel", async () => {
  const w = await chromeOf("miragon");
  const { mountLegend } = await import("../src/mcp-app/legend.ts");
  const legend = mountLegend(w.chrome, (body) => {
    body.textContent = "Core domain";
    return () => {};
  });
  legend.onDocument?.({ repo: "r", path: "processes/conference.cm.json" }, { repo: "r" });
  const panel = w.document.getElementById("legend")!;
  const legendItem = () => w.document.querySelector<HTMLElement>('#menu [data-key="legend"]');
  w.document.getElementById("menu-trigger")!.click();
  assert.ok(legendItem(), "the Model group lists the Legend");
  assert.equal(legendItem()!.getAttribute("aria-checked"), "false");
  legendItem()!.click();
  assert.equal(panel.hidden, false, "selecting it opens the panel");
  w.document.getElementById("menu-trigger")!.click();
  assert.equal(legendItem()!.getAttribute("aria-checked"), "true");
  legendItem()!.click();
  assert.equal(panel.hidden, true, "and again closes it");

  legend.destroy();
  w.close();
});
