/**
 * The widget chrome as shell.ts composes it (mountChrome), under jsdom on the
 * real skeletons (mcp-app-miragon.html, mcp-app.html): what only the
 * composition decides. A Miragon widget binds the zoom keys and ⇧1 to the
 * view, keeps them off behind a state card and names them on the zoom
 * buttons, the tooltip's chip and aria-keyshortcuts alike, for the US and the
 * German layout; the bpmn widget leaves them to its canvas. The menu's Legend
 * toggles the registered panel, and a renderer's web link in the canvas
 * goes through the host instead of the sandbox's blocked new window.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import { ariaKeyShortcutsFromLabel } from "@miragon/modeler-shell/core";
import { JSDOM } from "jsdom";

import type { WidgetChrome } from "../src/mcp-app/chrome/contracts.ts";
import type { ViewControls } from "../src/mcp-app/core/engine.ts";
// the "@/" alias the chrome's modules import through
import { closeDom } from "./renderer-dom.ts";

after(closeDom);

const ENTRIES = { miragon: "mcp-app-miragon.html", bpmn: "mcp-app.html" } as const;

/** one widget page: the skeleton's body, the globals the chrome reads, a host that records */
function page(kind: keyof typeof ENTRIES, platform?: string) {
  const html = readFileSync(new URL(`../${ENTRIES[kind]}`, import.meta.url), "utf8").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  const { window } = dom;
  if (platform) Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
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

async function chromeOf(kind: keyof typeof ENTRIES, platform?: string) {
  const p = page(kind, platform);
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
    stepZoom: (direction) => void zoomed.push(direction > 0 ? "in" : "out"),
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
  const zoomNames = (): Array<[string, string | null]> =>
    ["zoom-out", "zoom-pct", "zoom-in", "zoom-fit"].map((id) => {
      const button = p.document.getElementById(id)!;
      return [button.title, button.getAttribute("aria-keyshortcuts")];
    });
  return { ...p, chrome, zoomed, press, zoomNames };
}

const chipOf = (title: string): string => /\(([^()]+)\)$/.exec(title)?.[1] ?? "";

/** guide §5.6: aria-keyshortcuts names the keys that type the chip's character
 *  on the US and the German layout, so the tooltip's chip, read the shell's
 *  way, and the button's aria-keyshortcuts must agree */
function assertChipsNameTheirKeys(names: Array<[string, string | null]>): void {
  for (const [title, keys] of names) assert.equal(ariaKeyShortcutsFromLabel(chipOf(title)), keys, title);
}

test("a Miragon widget: the zoom keys run the view, a state card leaves them to the browser, the buttons name them", async () => {
  const w = await chromeOf("miragon");
  assert.equal(w.press("=", "Equal", { ctrlKey: true }), true, "the page does not zoom");
  assert.equal(w.press("-", "Minus", { ctrlKey: true }), true);
  assert.equal(w.press("0", "Digit0", { ctrlKey: true }), true);
  assert.deepEqual(w.zoomed, ["in", "out", "to 1"]);

  w.chrome.showState({ kind: "read-failed", error: "gone" });
  assert.equal(w.press("=", "Equal", { ctrlKey: true }), false, "a state card hides the diagram");
  assert.deepEqual(w.zoomed, ["in", "out", "to 1"]);

  assert.deepEqual(
    w.zoomNames(),
    [
      ["Zoom out (Ctrl+Minus)", "Control+-"],
      ["Zoom to 100% (Ctrl+0)", "Control+0"],
      ["Zoom in (Ctrl+Plus)", "Control+= Control+Plus"],
      ["Fit to view (Shift+1)", "Shift+1"],
    ],
    "jsdom's navigator is no Mac: the Ctrl names",
  );
  assertChipsNameTheirKeys(w.zoomNames());
  assert.equal(w.document.getElementById("zoom-fit")!.getAttribute("aria-label"), "Fit to view");
  w.close();
});

test("a Miragon widget on a Mac: the zoom buttons name ⌘ and Meta, each chip the keys of the US and the German layout", async () => {
  const w = await chromeOf("miragon", "MacIntel");
  assert.deepEqual(w.zoomNames(), [
    ["Zoom out (⌘−)", "Meta+-"],
    ["Zoom to 100% (⌘0)", "Meta+0"],
    ["Zoom in (⌘+)", "Meta+= Meta+Plus"],
    ["Fit to view (⇧1)", "Shift+1"],
  ]);
  assertChipsNameTheirKeys(w.zoomNames());
  w.close();
});

test("the bpmn widget: its canvas keeps the zoom keys, and its buttons stay as they were", async () => {
  const w = await chromeOf("bpmn");
  assert.equal(w.press("=", "Equal", { ctrlKey: true }), false);
  assert.equal(w.press("0", "Digit0", { ctrlKey: true }), false);
  assert.deepEqual(w.zoomed, [], "bpmn-js binds them on the focused canvas");
  assert.equal(w.document.getElementById("zoom-in")!.hasAttribute("aria-keyshortcuts"), false);
  assert.equal(w.document.getElementById("zoom-fit")!.title, "Fit diagram (Shift+1)");
  w.close();
});

test("the menu's Legend toggles the registered panel; a renderer's web link in the canvas opens through the host", async () => {
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
  assert.ok(
    legendItem()!.firstElementChild!.classList.contains("icon-gap"),
    "no icon, as the guide's Model entries go",
  );
  legendItem()!.click();
  assert.equal(panel.hidden, false, "selecting it opens the panel");
  w.document.getElementById("menu-trigger")!.click();
  assert.equal(legendItem()!.getAttribute("aria-checked"), "true");
  legendItem()!.click();
  assert.equal(panel.hidden, true, "and again closes it");

  const link = w.document.createElement("a");
  link.href = "https://learnwardleymapping.com/landscape/";
  link.target = "_blank";
  link.textContent = "Learn Wardley Mapping";
  w.document.getElementById("canvas")!.append(link);
  const click = new w.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true, "no new window the sandbox would block");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(w.links, ["https://learnwardleymapping.com/landscape/"], "the host opens it");
  legend.destroy();
  w.close();
});

test("externalLinkOf: a primary click on a web link, nothing else", async () => {
  const { externalLinkOf } = await import("../src/mcp-app/chrome/links.ts");
  const p = page("miragon");
  const { document } = p;
  const MouseEvent = p.window.MouseEvent;
  const scope = document.getElementById("canvas")!;
  const link = document.createElement("a");
  link.href = "https://learnwardleymapping.com/landscape/";
  const label = document.createElement("span");
  link.append(label);
  const mail = document.createElement("a");
  mail.href = "mailto:someone@example.com";
  scope.append(link, mail);
  const click = (target: Element, init: MouseEventInit = {}): string | undefined => {
    let seen: string | undefined;
    scope.addEventListener("click", (event) => void (seen = externalLinkOf(event)), { once: true });
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
    return seen;
  };
  assert.equal(click(label), "https://learnwardleymapping.com/landscape/", "the link around the clicked text");
  assert.equal(click(link, { button: 1 }), undefined, "not a primary click");
  assert.equal(click(mail), undefined, "not a web address");
  assert.equal(click(scope), undefined, "no link");
  p.close();
});
