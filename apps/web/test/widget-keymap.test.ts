/**
 * The widget keyboard as data (src/mcp-app/core/keymap.ts): ⌘S / Ctrl+S, ⇧1
 * and Escape, the text-field guard (a modeler's own text keeps its keys, a
 * chrome field keeps ⇧1 but answers Escape), IME composition, and the menu
 * trigger's open keys and type-ahead filter.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isTypeAhead, keyCommand, type KeyLike, triggerOpen } from "../src/mcp-app/core/keymap.ts";

const key = (k: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

test("⌘S and Ctrl+S save — everywhere, a modeler's own text included (no browser 'save page')", () => {
  for (const target of ["plain", "chrome-text", "canvas-text"] as const) {
    assert.equal(keyCommand(key("s", "KeyS", { metaKey: true }), target), "save", target);
    assert.equal(keyCommand(key("s", "KeyS", { ctrlKey: true }), target), "save", target);
  }
  assert.equal(keyCommand(key("S", "KeyS", { metaKey: true }), "plain"), "save", "caps lock");
  assert.equal(keyCommand(key("ы", "KeyS", { metaKey: true }), "plain"), "save", "a non-Latin layout");
  assert.equal(keyCommand(key("s", "KeyS", { metaKey: true, shiftKey: true }), "plain"), undefined, "⇧⌘S is not ours");
  assert.equal(keyCommand(key("s", "KeyS", { metaKey: true, altKey: true }), "plain"), undefined);
  assert.equal(keyCommand(key("s", "KeyS"), "plain"), undefined, "a bare s");
});

test("⇧1 fits — never inside text, where it types '!'", () => {
  assert.equal(keyCommand(key("!", "Digit1", { shiftKey: true }), "plain"), "fit");
  assert.equal(keyCommand(key("!", "Digit1", { shiftKey: true }), "chrome-text"), undefined);
  assert.equal(keyCommand(key("!", "Digit1", { shiftKey: true }), "canvas-text"), undefined);
  assert.equal(keyCommand(key("1", "Digit1"), "plain"), undefined);
  assert.equal(keyCommand(key("!", "Digit1", { shiftKey: true, metaKey: true }), "plain"), undefined);
  assert.equal(keyCommand(key("1", "Numpad1", { shiftKey: true }), "plain"), undefined, "the numpad is not ⇧1");
});

test("Escape walks the layers — from a chrome field too (the inline form), never from the canvas's own text", () => {
  assert.equal(keyCommand(key("Escape", "Escape"), "plain"), "escape");
  assert.equal(keyCommand(key("Escape", "Escape"), "chrome-text"), "escape");
  assert.equal(keyCommand(key("Escape", "Escape"), "canvas-text"), undefined, "label editing cancels natively");
  assert.equal(keyCommand(key("Escape", "Escape", { metaKey: true }), "plain"), undefined);
});

test("an IME composition owns every key", () => {
  assert.equal(keyCommand(key("Escape", "Escape", { isComposing: true }), "plain"), undefined);
  assert.equal(keyCommand(key("s", "KeyS", { metaKey: true, isComposing: true }), "plain"), undefined);
});

test("the menu trigger: ↓ opens on the first item, ↑ on the last; type-ahead only for bare printable keys", () => {
  assert.equal(triggerOpen("ArrowDown"), "first");
  assert.equal(triggerOpen("ArrowUp"), "last");
  assert.equal(triggerOpen("Enter"), undefined, "Enter and Space click the button");
  assert.equal(triggerOpen(" "), undefined);
  const k = (k: string, mods: Partial<KeyLike> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  });
  assert.equal(isTypeAhead(k("r")), true);
  assert.equal(isTypeAhead(k("R")), true);
  assert.equal(isTypeAhead(k(" ")), false, "Space activates");
  assert.equal(isTypeAhead(k("Enter")), false);
  assert.equal(isTypeAhead(k("s", { metaKey: true })), false, "⌘S saves, never jumps to Save now");
  assert.equal(isTypeAhead(k("s", { ctrlKey: true })), false);
});
