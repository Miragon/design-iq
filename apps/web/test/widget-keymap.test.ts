/**
 * The widget keyboard as data (src/mcp-app/core/keymap.ts): ⌘S / Ctrl+S, ⇧1
 * and Escape, the text-field guard (a modeler's own text keeps its keys, a
 * chrome field keeps ⇧1 but answers Escape), IME composition, the menu
 * trigger's open keys and type-ahead filter, and the zoom keys and ⇧1 a
 * Miragon canvas takes from the modeler shell's keymap, each key and guard.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { chromeKeyAction, isTypeAhead, keyCommand, type KeyLike, triggerOpen } from "../src/mcp-app/core/keymap.ts";

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

test("⇧1 is no keyCommand: the shell's keymap fits in every widget (chromeKeyAction)", () => {
  for (const target of ["plain", "chrome-text", "canvas-text"] as const) {
    assert.equal(keyCommand(key("!", "Digit1", { shiftKey: true }), target), undefined, target);
  }
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

// ── the zoom keys and ⇧1 of a Miragon canvas (chromeKeyAction): the shell's
// keymap for an embedded modeler ──────────────────────────────────────────

const free = { inTextField: false, menuOpen: false, dialogOpen: false, modalOpen: false, viewport: true };

test("each zoom key and ⇧1, as the guide names them: Cmd or Ctrl, the main row and the numpad", () => {
  const cases: Array<[KeyLike, string]> = [
    [key("+", "Equal", { metaKey: true, shiftKey: true }), "zoomIn"],
    [key("=", "Equal", { metaKey: true }), "zoomIn"],
    [key("=", "Equal", { ctrlKey: true }), "zoomIn"],
    [key("+", "NumpadAdd", { ctrlKey: true }), "zoomIn"],
    [key("+", "BracketRight", { ctrlKey: true }), "zoomIn"], // QWERTZ: + has a key of its own
    [key("-", "Minus", { metaKey: true }), "zoomOut"],
    [key("_", "Minus", { ctrlKey: true, shiftKey: true }), "zoomOut"],
    [key("-", "NumpadSubtract", { metaKey: true }), "zoomOut"],
    [key("0", "Digit0", { metaKey: true }), "zoomToActual"],
    [key("0", "Digit0", { ctrlKey: true }), "zoomToActual"],
    [key("Insert", "Numpad0", { ctrlKey: true }), "zoomToActual"], // NumLock off
    [key("!", "Digit1", { shiftKey: true }), "fit"],
    [key("1", "Digit1", { shiftKey: true }), "fit"], // AZERTY types 1 with Shift
  ];
  for (const [event, action] of cases) {
    assert.equal(chromeKeyAction(event, free), action, `${event.key} ${event.code}`);
  }
});

test("what is not a chrome key passes: a bare + or 0, ⌘1, ⌘⇧1, the numpad's 1, AltGr", () => {
  for (const event of [
    key("+", "Equal", { shiftKey: true }),
    key("0", "Digit0"),
    key("1", "Digit1", { metaKey: true }),
    key("!", "Digit1", { metaKey: true, shiftKey: true }),
    key("1", "Numpad1", { shiftKey: true }),
    key("+", "Equal", { ctrlKey: true, altKey: true }),
    key("s", "KeyS", { metaKey: true }),
    key("Escape", "Escape"),
  ]) {
    assert.equal(chromeKeyAction(event, free), undefined, `${event.key} ${event.code}`);
  }
});

test("each guard: an IME composition, a text field and an open modal keep the key; a popover or the menu do not", () => {
  const zoomIn = key("=", "Equal", { metaKey: true });
  const fit = key("!", "Digit1", { shiftKey: true });
  for (const event of [zoomIn, fit]) {
    assert.equal(chromeKeyAction({ ...event, isComposing: true }, free), undefined, "composing");
    assert.equal(
      chromeKeyAction(event, { ...free, inTextField: true }),
      undefined,
      "a text field: the browser zooms, ⇧1 types",
    );
    assert.equal(chromeKeyAction(event, { ...free, dialogOpen: true, modalOpen: true }), undefined, "a modal dialog");
    assert.ok(chromeKeyAction(event, { ...free, dialogOpen: true }), "a popover (Map size…) keeps the zoom");
    assert.ok(chromeKeyAction(event, { ...free, menuOpen: true }), "the open menu too");
  }
});

test("without a diagram on screen (a state card) the browser keeps the zoom keys and ⇧1", () => {
  assert.equal(chromeKeyAction(key("=", "Equal", { metaKey: true }), { ...free, viewport: false }), undefined);
  assert.equal(chromeKeyAction(key("0", "Digit0", { ctrlKey: true }), { ...free, viewport: false }), undefined);
  assert.equal(chromeKeyAction(key("!", "Digit1", { shiftKey: true }), { ...free, viewport: false }), undefined);
});
