/**
 * The widget's one keydown listener (src/mcp-app/chrome/keys.ts) and the
 * shared chrome-key binding it and the SPA's Miragon editors use
 * (src/lib/chrome-keys.ts), under jsdom with real keyboard events: in a
 * Miragon widget Cmd/Ctrl + `+` / `-` / `0` and ⇧1 run the view and keep
 * the page from zooming, a text field, an open modal dialog, a composition
 * and a widget without a diagram keep the key, and Escape leaves a modal
 * dialog's layers alone. In the bpmn and dmn widgets ⇧1 is the chrome's fit
 * on the whole document, and the zoom keys pass to the focused canvas, where
 * the engine routes them (test/canvas-zoom-keys-dom.test.ts). Monaco and an
 * EditContext editor are text fields, as for the shell.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import { isTextField } from "../src/lib/chrome-keys.ts";
import { mountKeys } from "../src/mcp-app/chrome/keys.ts";
import type { ChromeKey } from "../src/mcp-app/core/keymap.ts";

function widget(opts: { miragon: boolean; viewport?: boolean }) {
  const { window } = new JSDOM(
    `<!doctype html><html><body><div id="app">
      <div id="canvas"><div class="wardley-canvas"><svg tabindex="0"></svg><input id="label"></div></div>
      <input id="chrome-field">
      <div class="monaco-editor"><div id="monaco" class="native-edit-context" tabindex="0"></div></div>
      <div id="popover" role="dialog" hidden></div>
      <div id="modal" role="dialog" aria-modal="true" hidden></div>
    </div></body></html>`,
  );
  const { document } = window;
  const ran: string[] = [];
  let viewport = opts.viewport ?? true;
  const unbind = mountKeys(document, {
    save: () => {
      ran.push("save");
      return true;
    },
    fit: () => {
      ran.push("fit (bpmn)");
      return true;
    },
    escape: [
      () => {
        ran.push("escape");
        return true;
      },
    ],
    ...(opts.miragon
      ? {
          chromeKeys: {
            menuOpen: () => false,
            viewport: () => viewport,
            run: (key: ChromeKey) => void ran.push(key),
          },
        }
      : {}),
  });
  const press = (
    target: string | undefined,
    key: string,
    code: string,
    mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean } = {},
  ): KeyboardEvent => {
    const event = new window.KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods });
    (target ? document.getElementById(target)! : document.body).dispatchEvent(event);
    return event;
  };
  return {
    document,
    ran,
    press,
    unbind,
    setViewport: (next: boolean) => {
      viewport = next;
    },
    show: (id: string) => document.getElementById(id)!.removeAttribute("hidden"),
  };
}

test("a Miragon widget: each zoom key and ⇧1 runs once and keeps the page from zooming", () => {
  const w = widget({ miragon: true });
  const keys: Array<[string, string, Record<string, boolean>, string]> = [
    ["=", "Equal", { metaKey: true }, "zoomIn"],
    ["+", "NumpadAdd", { ctrlKey: true }, "zoomIn"],
    ["-", "Minus", { metaKey: true }, "zoomOut"],
    ["0", "Digit0", { ctrlKey: true }, "zoomToActual"],
    ["!", "Digit1", { shiftKey: true }, "fit"],
  ];
  for (const [key, code, mods, action] of keys) {
    w.ran.length = 0;
    const event = w.press(undefined, key, code, mods);
    assert.deepEqual(w.ran, [action], `${key} on the page`);
    assert.equal(event.defaultPrevented, true, `${key}: the browser does not zoom the page`);
  }
  w.ran.length = 0;
  assert.equal(w.press(undefined, "!", "Digit1", { shiftKey: true }).defaultPrevented, true);
  assert.deepEqual(w.ran, ["fit"], "⇧1 is the shell's fit, never also the bpmn path");
});

test("a Miragon widget: a text field, an open modal, a composition, a handled key and a missing diagram keep the key", () => {
  const w = widget({ miragon: true });
  for (const field of ["label", "chrome-field", "monaco"]) {
    const event = w.press(field, "=", "Equal", { metaKey: true });
    assert.equal(event.defaultPrevented, false, `${field}: the browser zooms the page`);
    w.press(field, "!", "Digit1", { shiftKey: true });
  }
  assert.deepEqual(w.ran, [], "nothing ran from a text field");

  w.show("popover");
  w.press(undefined, "=", "Equal", { metaKey: true });
  assert.deepEqual(w.ran, ["zoomIn"], "a popover (Map size…) is no modal: the zoom keys act");
  w.ran.length = 0;
  w.show("modal");
  assert.equal(w.press(undefined, "=", "Equal", { metaKey: true }).defaultPrevented, false);
  w.press(undefined, "!", "Digit1", { shiftKey: true });
  assert.deepEqual(w.ran, [], "an open modal dialog keeps every chrome key");
  w.press(undefined, "Escape", "Escape");
  assert.deepEqual(w.ran, [], "and its Escape: the chrome's layers under it stay");
  w.document.getElementById("modal")!.setAttribute("hidden", "");

  w.press(undefined, "=", "Equal", { metaKey: true, isComposing: true });
  const handled = new w.document.defaultView!.KeyboardEvent("keydown", {
    key: "=",
    code: "Equal",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  handled.preventDefault();
  w.document.body.dispatchEvent(handled);
  assert.deepEqual(w.ran, [], "a composition and a key the canvas handled");

  w.setViewport(false);
  assert.equal(w.press(undefined, "0", "Digit0", { metaKey: true }).defaultPrevented, false);
  assert.deepEqual(w.ran, [], "a state card: the browser keeps ⌘0");
  w.setViewport(true);
  w.press(undefined, "Escape", "Escape");
  w.press(undefined, "s", "KeyS", { metaKey: true });
  assert.deepEqual(w.ran, ["escape", "save"], "Escape and ⌘S stay designIQ's");
});

test("the bpmn and dmn widgets: the document leaves the zoom keys to the focused canvas; ⇧1 is the chrome's fit there", () => {
  const w = widget({ miragon: false });
  assert.equal(w.press(undefined, "=", "Equal", { metaKey: true }).defaultPrevented, false);
  assert.equal(w.press(undefined, "0", "Digit0", { ctrlKey: true }).defaultPrevented, false);
  assert.deepEqual(w.ran, [], "the engine routes them on the focused canvas (EngineOptions.chromeKeys)");
  assert.equal(w.press(undefined, "!", "Digit1", { shiftKey: true }).defaultPrevented, true);
  assert.deepEqual(w.ran, ["fit (bpmn)"]);
  w.unbind();
  w.press(undefined, "!", "Digit1", { shiftKey: true });
  assert.deepEqual(w.ran, ["fit (bpmn)"], "unbound");
});

test("isTextField: every input, select list and editable text, an EditContext editor and all of Monaco; never a button or the page", () => {
  const { window } = new JSDOM(
    `<!doctype html><body>
      <input id="input"><textarea id="textarea"></textarea><select id="select"></select>
      <div contenteditable="true"><span id="label">Check order</span></div>
      <div contenteditable="false" id="locked"></div>
      <div class="monaco-editor"><div class="find-widget"><button id="find-next"></button></div></div>
      <div id="edit-context"></div>
      <button id="button"></button>
    </body>`,
  );
  const { document } = window;
  const byId = (id: string) => document.getElementById(id)!;
  // Chromium's EditContext (Monaco types into one); jsdom has none
  Object.defineProperty(byId("edit-context"), "editContext", { value: {} });
  // jsdom computes no isContentEditable: the label inherits it from its editor
  Object.defineProperty(byId("label"), "isContentEditable", { value: true });
  for (const id of ["input", "textarea", "select", "label", "find-next", "edit-context"]) {
    assert.equal(isTextField(byId(id)), true, id);
  }
  for (const target of [byId("button"), byId("locked"), document.body, document, window, null]) {
    assert.equal(isTextField(target as EventTarget | null), false, String((target as Element | null)?.id ?? target));
  }
});
