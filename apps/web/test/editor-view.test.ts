/**
 * The editor's view choice (src/lib/editor-view.ts): what a notation with the
 * split view remembers across documents and page loads, how a damaged or
 * blocked storage degrades, when Split has room (with hysteresis), what
 * shows while it has none, which layers are on screen, how a hidden layer
 * leaves the screen, and that only a choice is ever written.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  editorLayers,
  type EditorView,
  editorViews,
  HIDDEN_LAYER_CLASS,
  parseViewChoices,
  readViewChoice,
  rememberViewChoice,
  serializeViewChoices,
  shownView,
  SPLIT_OFF_REM,
  SPLIT_ON_REM,
  splitFits,
} from "../src/lib/editor-view.ts";

const KEY = "designiq.editor-view.v1";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
}

test("a choice is remembered per notation and read back", () => {
  const storage = memoryStorage();
  assert.deepEqual(readViewChoice("markdown", storage), {}, "the first visit remembers nothing");
  rememberViewChoice("markdown", { view: "split" }, storage);
  rememberViewChoice("wardley", { view: "source" }, storage);
  assert.deepEqual(readViewChoice("markdown", storage), { view: "split" });
  assert.deepEqual(readViewChoice("wardley", storage), { view: "source" });
  assert.deepEqual(JSON.parse(storage.items.get(KEY)!), { markdown: { view: "split" }, wardley: { view: "source" } });
});

test("the view and the divider's position are remembered apart: one never resets the other", () => {
  const storage = memoryStorage();
  rememberViewChoice("markdown", { view: "split" }, storage);
  rememberViewChoice("markdown", { ratio: 0.4 }, storage);
  assert.deepEqual(readViewChoice("markdown", storage), { view: "split", ratio: 0.4 });
  rememberViewChoice("markdown", { view: "canvas" }, storage);
  assert.deepEqual(readViewChoice("markdown", storage), { view: "canvas", ratio: 0.4 });
});

test("a damaged entry is ignored, never thrown, and leaves the other notations' entries alone", () => {
  for (const raw of ["{not json", "[]", "null", '"split"', "42"]) {
    assert.deepEqual(parseViewChoices(raw).size, 0, raw);
  }
  const choices = parseViewChoices(
    JSON.stringify({
      markdown: { view: "split", ratio: 0.3 },
      a: { view: "sideways", ratio: 0.3 },
      b: { view: "source", ratio: 1.5 },
      c: { view: "canvas", ratio: "0.5" },
      d: { ratio: -0.1 },
      e: "split",
      f: null,
    }),
  );
  assert.deepEqual(Object.fromEntries(choices), {
    markdown: { view: "split", ratio: 0.3 },
    a: { ratio: 0.3 },
    b: { view: "source" },
    c: { view: "canvas" },
  });
});

test("an entry stored over a damaged one replaces it", () => {
  const storage = memoryStorage();
  storage.setItem(KEY, "{not json");
  rememberViewChoice("markdown", { view: "source" }, storage);
  assert.deepEqual(readViewChoice("markdown", storage), { view: "source" });
});

test("the entries survive a write and read round trip", () => {
  const choices = new Map([
    ["markdown", { view: "split" as const, ratio: 0.55 }],
    ["wardley", { view: "canvas" as const }],
  ]);
  assert.deepEqual(parseViewChoices(serializeViewChoices(choices)), choices);
});

test("blocked storage or a full quota degrades to nothing remembered", () => {
  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.doesNotThrow(() => rememberViewChoice("markdown", { view: "split" }, blocked));
  assert.deepEqual(readViewChoice("markdown", blocked), {});
  // no storage at all (null: an explicit undefined would be the browser's)
  assert.doesNotThrow(() => rememberViewChoice("markdown", { view: "split" }, null));
  assert.deepEqual(readViewChoice("markdown", null), {});
});

test("Split comes on at 48rem of editor width and goes off only below 45rem", () => {
  const rem = 16;
  assert.equal(SPLIT_ON_REM, 48);
  assert.equal(SPLIT_OFF_REM, 45);
  // coming on
  assert.equal(splitFits(48 * rem - 1, rem, false), false);
  assert.equal(splitFits(48 * rem, rem, false), true);
  // between the two, it keeps what it was: no flipping at the threshold
  assert.equal(splitFits(46 * rem, rem, true), true);
  assert.equal(splitFits(46 * rem, rem, false), false);
  // going off
  assert.equal(splitFits(45 * rem, rem, true), true);
  assert.equal(splitFits(45 * rem - 1, rem, true), false);
  // the thresholds are in rem: a larger root font needs more pixels
  assert.equal(splitFits(48 * 16, 20, false), false);
  assert.equal(splitFits(48 * 20, 20, false), true);
  assert.equal(splitFits(0, rem, false), false, "not measured yet");
});

test("a chosen Split without room shows the canvas; every other view shows as chosen", () => {
  assert.equal(shownView("split", true), "split");
  assert.equal(shownView("split", false), "canvas");
  for (const view of ["canvas", "source"] as const) {
    assert.equal(shownView(view, true), view);
    assert.equal(shownView(view, false), view);
  }
});

const MARKDOWN = { visual: true, structured: false, splitAvailable: true };

test("the layers on screen: one alone, or both side by side while Split has room", () => {
  assert.deepEqual(editorLayers("canvas", MARKDOWN), {
    shown: "canvas",
    sourceShown: false,
    canvasShown: true,
    split: false,
  });
  assert.deepEqual(editorLayers("split", MARKDOWN), {
    shown: "split",
    sourceShown: true,
    canvasShown: true,
    split: true,
  });
  assert.deepEqual(editorLayers("source", MARKDOWN), {
    shown: "source",
    sourceShown: true,
    canvasShown: false,
    split: false,
  });
  // no room (or no split view): the canvas, not the source the switch also offers
  assert.deepEqual(editorLayers("split", { ...MARKDOWN, splitAvailable: false }), editorLayers("canvas", MARKDOWN));
});

test("a document without a visual editor shows its source, a structured one its canvas, whatever was chosen", () => {
  for (const view of ["canvas", "split", "source"] as const) {
    const text = editorLayers(view, { visual: false, structured: false, splitAvailable: false });
    assert.equal(text.shown, "source", view);
    assert.equal(text.canvasShown, false, view);
    const structured = editorLayers(view, { visual: true, structured: true, splitAvailable: true });
    assert.equal(structured.shown, "canvas", view);
    assert.equal(structured.sourceShown, false, view);
  }
});

test("a hidden layer only turns invisible, inert keeps it out of reach: no pointer-events: none, which a modal dialog in it inherits", () => {
  assert.deepEqual(HIDDEN_LAYER_CLASS.split(/\s+/), ["opacity-0"]);
});

test("only a choice is remembered: the fallback to the source and a reveal change the view, never the storage", () => {
  const storage = memoryStorage();
  let view: EditorView = "split";
  const views = editorViews(
    (update) => {
      view = typeof update === "function" ? update(view) : update;
    },
    "markdown",
    storage,
  );

  views.fallBack();
  assert.equal(view, "source", "the engine or the first import failed");
  views.reveal();
  assert.equal(view, "canvas", "a revealed element must be visible");
  assert.equal(storage.items.size, 0, "neither is written");

  views.choose("split");
  views.reveal();
  assert.equal(view, "split", "Split already shows the canvas");
  assert.deepEqual(readViewChoice("markdown", storage), { view: "split" });
  views.fallBack();
  assert.deepEqual(readViewChoice("markdown", storage), { view: "split" }, "the next document opens as chosen");
});

test("a notation without the split view remembers no choice", () => {
  const storage = memoryStorage();
  let view: EditorView = "canvas";
  const views = editorViews(
    (update) => {
      view = typeof update === "function" ? update(view) : update;
    },
    undefined,
    storage,
  );
  views.choose("source");
  assert.equal(view, "source");
  assert.equal(storage.items.size, 0);
});
