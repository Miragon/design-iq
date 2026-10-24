/**
 * Where the focus goes after the editor's chrome acted on the canvas
 * (src/lib/canvas-focus.ts, guide §5.4 and §5.8): a click on the view
 * switch's canvas side or on a Model action of the ⋯ menu hands the canvas
 * the focus, Enter and Space leave it where the guide keeps it, and every
 * other close of the menu stays radix's. The real canvases: test/canvas-focus-dom.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type FocusableCanvas,
  focusCanvasIn,
  isPointerClick,
  menuCloseFocus,
  viewSwitchFocus,
} from "../src/lib/canvas-focus.ts";

/** a canvas that records each hand-back; `takes` = whether it takes the focus */
function fakeCanvas(shown: boolean, takes = true) {
  const state = { shown, focused: 0 };
  const canvas: FocusableCanvas = {
    shown: () => state.shown,
    focus: () => {
      state.focused++;
      return takes;
    },
  };
  return { canvas, state };
}

test("a click with a mouse, pen or finger has a detail; Enter and Space on a button click with none", () => {
  assert.equal(isPointerClick({ detail: 1 }), true);
  assert.equal(isPointerClick({ detail: 2 }), true, "a double click");
  assert.equal(isPointerClick({ detail: 0 }), false);
});

test("view switch: a click on the canvas view hands the canvas the focus once its layer shows, once", () => {
  const { canvas, state } = fakeCanvas(false);
  const views = viewSwitchFocus(canvas);
  views.chose("canvas", true);
  assert.equal(state.focused, 0, "the source still shows: an inert host takes no focus");
  state.shown = true;
  views.shown();
  assert.equal(state.focused, 1, "the commit showed the canvas");
  views.shown();
  assert.equal(state.focused, 1, "a later show is no hand-back");
});

test("view switch: a click on the canvas view while it shows (from Split, or again) hands it the focus at once", () => {
  const { canvas, state } = fakeCanvas(true);
  const views = viewSwitchFocus(canvas);
  views.chose("canvas", true);
  assert.equal(state.focused, 1);
  views.shown();
  assert.equal(state.focused, 1, "nothing left to hand back");
});

test("view switch: Enter or Space keep the focus on the switch; Split and the source never take it", () => {
  const { canvas, state } = fakeCanvas(false);
  const views = viewSwitchFocus(canvas);
  views.chose("canvas", false);
  state.shown = true;
  views.shown();
  assert.equal(state.focused, 0, "Enter or Space on the canvas view");
  views.chose("split", true);
  views.shown();
  views.chose("source", true);
  state.shown = false;
  views.shown();
  assert.equal(state.focused, 0, "a click on Split or the source");
});

test("view switch: a choice before the commit replaces the pending hand-back; a canvas that stays hidden gets none later", () => {
  const { canvas, state } = fakeCanvas(false);
  const views = viewSwitchFocus(canvas);
  views.chose("canvas", true);
  views.chose("source", false);
  state.shown = true;
  views.shown();
  assert.equal(state.focused, 0, "the later choice by key wins");

  state.shown = false;
  views.chose("canvas", true);
  views.shown(); // the engine failed and the shell fell back to the source
  state.shown = true;
  views.shown(); // a reveal brings the canvas forward later
  assert.equal(state.focused, 0, "the hand-back belonged to the first commit");
});

const CLICK = { detail: 1 };
/** Enter and Space: radix clicks the entry itself, with no detail */
const KEY = { detail: 0 };

test("⋯ menu: a click on a Model action hands the canvas the focus as the menu closes, and radix leaves it there", () => {
  const { canvas, state } = fakeCanvas(true);
  const menu = menuCloseFocus();
  menu.pointerReleased();
  menu.actedOnCanvas(CLICK);
  assert.equal(menu.closing(canvas), true, "settled here: radix must not move it to the trigger");
  assert.equal(state.focused, 1);
  assert.equal(menu.closing(canvas), false, "the next close is radix's again");
  assert.equal(state.focused, 1);
});

test("⋯ menu: a press on the trigger dragged onto a Model action and released there counts as a click", () => {
  const { canvas, state } = fakeCanvas(true);
  const menu = menuCloseFocus();
  menu.pointerReleased();
  menu.actedOnCanvas(KEY); // radix clicks the entry itself
  assert.equal(menu.closing(canvas), true);
  assert.equal(state.focused, 1);
});

test("⋯ menu: a released pointer counts for the click that follows it only", () => {
  const { canvas, state } = fakeCanvas(true);
  const menu = menuCloseFocus();
  menu.pointerReleased();
  menu.actedOnCanvas(CLICK);
  assert.equal(menu.closing(canvas), true);
  menu.actedOnCanvas(KEY);
  assert.equal(menu.closing(canvas), false, "Enter on an entry the next time the menu opens");
  menu.pointerReleased();
  assert.equal(menu.closing(canvas), false, "the menu closed without the entry's click");
  menu.actedOnCanvas(KEY);
  assert.equal(menu.closing(canvas), false, "Enter the time after");
  assert.equal(state.focused, 1);
});

test("⋯ menu: Enter or Space on a Model action, Escape and a click outside leave the focus to radix", () => {
  const { canvas, state } = fakeCanvas(true);
  const menu = menuCloseFocus();
  menu.actedOnCanvas(KEY);
  assert.equal(menu.closing(canvas), false, "Enter or Space: radix gives the trigger the focus");
  assert.equal(menu.closing(canvas), false, "Escape, a click outside, a checkbox toggled before");
  assert.equal(state.focused, 0);
});

test("⋯ menu: a dialog entry leaves the focus to its dialog, whatever chose it", () => {
  const { canvas, state } = fakeCanvas(true);
  const menu = menuCloseFocus();
  menu.openingDialog();
  assert.equal(menu.closing(canvas), true, "radix must not steal the dialog field's focus");
  assert.equal(state.focused, 0);
  menu.actedOnCanvas(CLICK);
  menu.openingDialog();
  assert.equal(menu.closing(canvas), true, "the last choice counts");
  assert.equal(state.focused, 0);
});

test("⋯ menu: the trigger takes the focus where the canvas cannot: behind the source, no editor, none at all", () => {
  const hidden = fakeCanvas(false);
  const menu = menuCloseFocus();
  menu.actedOnCanvas(CLICK);
  assert.equal(menu.closing(hidden.canvas), false);
  assert.equal(hidden.state.focused, 0, "a hidden canvas is not asked");

  const refusing = fakeCanvas(true, false);
  menu.actedOnCanvas(CLICK);
  assert.equal(menu.closing(refusing.canvas), false, "the editor took no focus");
  assert.equal(refusing.state.focused, 1);

  menu.actedOnCanvas(CLICK);
  assert.equal(menu.closing(undefined), false);
});

test("focusCanvasIn: true only when the editor's focus landed in the canvas host", () => {
  const inside = {};
  const outside = {};
  const document = { activeElement: outside as unknown };
  const host = {
    ownerDocument: document,
    contains: (node: unknown) => node === inside,
  } as unknown as Element;
  /** an editor whose focus() uses its own object, as a class's method would */
  const editor = {
    target: inside,
    focus(this: { target: unknown }) {
      document.activeElement = this.target;
    },
  };
  assert.equal(focusCanvasIn(host, editor), true, "called on the editor");
  document.activeElement = outside;
  assert.equal(focusCanvasIn(host, { focus() {} }), false, "an inert host keeps the focus where it was");
  assert.equal(focusCanvasIn(host, {}), false, "an editor without canvas keys (the Markdown view)");
  assert.equal(focusCanvasIn(host, undefined), false, "no editor mounted yet");
  assert.equal(focusCanvasIn(null, { focus: () => assert.fail("no host: nothing to focus") }), false);
});
