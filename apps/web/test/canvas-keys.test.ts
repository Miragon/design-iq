/**
 * A canvas engine hears keys only while it is in front (src/lib/canvas-keys.ts),
 * under jsdom. The page is built the way the live editor has it: a canvas
 * engine with the Miragon renderers' document keydown listener and the
 * guards they have today (Team Topology's text-target guard, the canvas-or-page
 * guard of the others, Wardley's keys from a button), the Monaco host with
 * an EditContext div (none of the three) and the container's keybinding
 * listener, a toolbar button, React's delegated listener on #root, a menu's
 * capture-phase listener on document and a dialog's Escape listener on window.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import { keepKeysFromCanvas } from "../src/lib/canvas-keys.ts";

function page() {
  const { window } = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const { document } = window;
  const root = document.getElementById("root")!;
  const canvas = document.createElement("div");
  canvas.tabIndex = 0;
  const button = document.createElement("button");
  // Monaco: host > .monaco-editor > .overflow-guard > div.native-edit-context
  const host = document.createElement("div");
  const editorNode = document.createElement("div");
  editorNode.className = "monaco-editor";
  const editContext = document.createElement("div");
  editContext.className = "native-edit-context";
  editContext.tabIndex = 0;
  editorNode.append(editContext);
  host.append(editorNode);
  root.append(button, canvas, host);

  const heard = {
    monaco: [] as string[],
    react: [] as string[],
    menu: [] as string[],
    engine: [] as string[],
    /** per key that reached the engines' listener, the renderers that act on it */
    byRenderer: [] as string[][],
    dialog: [] as string[],
  };
  // the keybinding listener on the editor container: a bound key stops here
  editorNode.addEventListener("keydown", (e) => {
    heard.monaco.push(e.key);
    if (e.key === "Backspace") e.stopPropagation();
  });
  root.addEventListener("keydown", (e) => heard.react.push(e.key));
  document.addEventListener("keydown", (e) => heard.menu.push(e.key), true);
  // the renderers' guards: team-topologies-renderer 0.10 skips text targets
  // only; wardley-renderer 0.8.0 (shouldIgnoreKeyEvent), event-storming and
  // context-maps-renderer 0.3.0 act on their canvas and the page itself, and
  // Wardley on undo/redo and its single-key tools from a button as well
  const textTarget = (t: HTMLElement): boolean =>
    t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
  const canvasOrPage = (t: HTMLElement): boolean =>
    canvas.contains(t) || t === document.body || t === document.documentElement;
  const wardleyButtonKey = (e: KeyboardEvent): boolean =>
    (e.target as HTMLElement).tagName === "BUTTON" &&
    (e.metaKey || e.ctrlKey ? /^[zy]$/.test(e.key) : /^[cunpla]$/.test(e.key));
  const heardBy = (e: KeyboardEvent): string[] => {
    const t = e.target as HTMLElement;
    const by: string[] = [];
    if (!textTarget(t)) by.push("team-topology");
    if (canvasOrPage(t)) by.push("event-storming", "context-map");
    if (canvasOrPage(t) || wardleyButtonKey(e)) by.push("wardley");
    return by;
  };
  document.addEventListener("keydown", (e) => {
    const by = heardBy(e);
    if (by.length > 0) heard.engine.push(e.key);
    heard.byRenderer.push(by);
  });
  window.addEventListener("keydown", (e) => heard.dialog.push(e.key));

  const press = (target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  return { document, canvas, button, host, editContext, heard, press };
}

test("unheld, keys meant for something else reach the engines: on the page itself, from a button, typed in Monaco", () => {
  const p = page();
  p.press(p.document.body, "Backspace");
  p.press(p.button, "z", { metaKey: true });
  p.press(p.button, "Backspace");
  p.press(p.editContext, "l");
  assert.deepEqual(p.heard.engine, ["Backspace", "z", "Backspace", "l"]);
  assert.deepEqual(p.heard.byRenderer, [
    ["team-topology", "event-storming", "context-map", "wardley"],
    ["team-topology", "wardley"],
    ["team-topology"],
    ["team-topology"],
  ]);
});

test("held, a key typed in Monaco reaches Monaco, React and the capture listeners, never the engine", () => {
  const p = page();
  keepKeysFromCanvas(p.document);
  for (const key of ["l", "c", "u", "Enter", " "]) p.press(p.editContext, key);
  p.press(p.editContext, "v", { metaKey: true });
  assert.deepEqual(p.heard.monaco, ["l", "c", "u", "Enter", " ", "v"]);
  assert.deepEqual(p.heard.react, ["l", "c", "u", "Enter", " ", "v"]);
  assert.deepEqual(p.heard.menu, ["l", "c", "u", "Enter", " ", "v"]);
  assert.deepEqual(p.heard.engine, []);
  assert.deepEqual(p.heard.dialog, []);
});

test("held, a key pressed on the toolbar or the page body never reaches the engine", () => {
  const p = page();
  keepKeysFromCanvas(p.document);
  p.press(p.button, "Backspace");
  p.press(p.button, "ArrowLeft");
  p.press(p.button, "z", { metaKey: true });
  p.press(p.button, "a", { metaKey: true });
  p.press(p.document.body, "Delete");
  assert.deepEqual(p.heard.engine, []);
  assert.deepEqual(p.heard.react, ["Backspace", "ArrowLeft", "z", "a"]);
});

test("held, a key keeps its default action: typing is the browser's", () => {
  const p = page();
  keepKeysFromCanvas(p.document);
  assert.equal(p.press(p.editContext, "l").defaultPrevented, false);
});

test("held, Escape passes: a dialog closes on it from window", () => {
  const p = page();
  keepKeysFromCanvas(p.document);
  p.press(p.editContext, "Escape");
  p.press(p.button, "Escape");
  assert.deepEqual(p.heard.dialog, ["Escape", "Escape"]);
});

test("held, a lone modifier and the toasts' Alt+T pass; Alt with an arrow, which moves Wardley elements, does not", () => {
  const p = page();
  keepKeysFromCanvas(p.document);
  p.press(p.editContext, "Shift", { shiftKey: true });
  p.press(p.editContext, "Alt", { altKey: true });
  p.press(p.editContext, "†", { altKey: true, code: "KeyT" });
  p.press(p.button, "ArrowLeft", { altKey: true });
  p.press(p.button, "c", { altKey: true, code: "KeyC" });
  assert.deepEqual(p.heard.dialog, ["Shift", "Alt", "†"]);
});

test("held, a key Monaco binds still stops at its container, as before", () => {
  const p = page();
  keepKeysFromCanvas(p.document);
  p.press(p.editContext, "Backspace");
  assert.deepEqual(p.heard.monaco, ["Backspace"]);
  assert.deepEqual(p.heard.react, []);
});

test("held from the source alone (the split view), a key typed in Monaco never reaches the engine, any other key does", () => {
  const p = page();
  keepKeysFromCanvas(p.document, p.host);
  for (const key of ["l", "c"]) p.press(p.editContext, key);
  p.press(p.editContext, "v", { metaKey: true });
  assert.deepEqual(p.heard.monaco, ["l", "c", "v"]);
  assert.deepEqual(p.heard.engine, []);
  // the canvas is in front beside the source: its own keys and the page's are its
  p.press(p.canvas, "l");
  p.press(p.document.body, "Backspace");
  assert.deepEqual(p.heard.engine, ["l", "Backspace"]);
});

test("the release puts the canvas back in front", () => {
  const p = page();
  const release = keepKeysFromCanvas(p.document);
  release();
  p.press(p.canvas, "l");
  p.press(p.document.body, "Backspace");
  assert.deepEqual(p.heard.engine, ["l", "Backspace"]);
});
