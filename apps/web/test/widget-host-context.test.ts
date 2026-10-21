/**
 * The host context and what follows from it (spec §2.5, §2.6): the merge of
 * partial `hostcontextchanged` updates (src/mcp-app/core/host-context.ts),
 * the once-only inline height, when the view re-fits and where the renderer
 * palette is open (src/mcp-app/core/layout.ts). The zoom readout is the
 * modeler shell's (test/widget-engines.test.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  initialHostState,
  mergeHostContext,
  planInlineHeight,
  sameHostState,
} from "../src/mcp-app/core/host-context.ts";
import { paletteForLayout, paletteShouldOpen, planRefit } from "../src/mcp-app/core/layout.ts";

const base = initialHostState({ touch: false, hover: true });

test("host context: the connect read is applied whole; theme and unknown values are ignored", () => {
  const s = mergeHostContext(base, {
    displayMode: "inline",
    availableDisplayModes: ["inline", "fullscreen", "sideways"],
    containerDimensions: { width: 720, maxHeight: 600 },
    safeAreaInsets: { top: 20, right: 0, bottom: 34, left: -4 },
    deviceCapabilities: { touch: true, hover: false },
    platform: "mobile",
    locale: "de-DE",
    timeZone: "Europe/Berlin",
    theme: "dark",
  } as Parameters<typeof mergeHostContext>[1]);
  assert.equal(s.displayMode, "inline");
  assert.deepEqual(s.availableDisplayModes, ["inline", "fullscreen"], "a mode the protocol does not define is dropped");
  assert.deepEqual(s.container, { width: 720, maxHeight: 600 });
  assert.deepEqual(s.safeArea, { top: 20, right: 0, bottom: 34, left: 0 }, "a negative inset is no inset");
  assert.equal(s.touch, true);
  assert.equal(s.hover, false);
  assert.equal(s.platform, "mobile");
  assert.equal(s.locale, "de-DE");
  assert.equal(s.timeZone, "Europe/Berlin");
  assert.equal("theme" in s, false, "one light mode — the host theme never lands");
  assert.equal(mergeHostContext(base, { displayMode: "maximised" }).displayMode, "inline");
});

test("host context: a partial update changes only what it carries — a resize never reverts the display mode", () => {
  const connected = mergeHostContext(base, { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] });
  // requestDisplayMode resolved "fullscreen" — the host did not echo it as a context change
  const fullscreen = mergeHostContext(connected, { displayMode: "fullscreen" });
  const resized = mergeHostContext(fullscreen, { containerDimensions: { width: 1280, height: 760 } });
  assert.equal(resized.displayMode, "fullscreen");
  assert.deepEqual(resized.availableDisplayModes, ["inline", "fullscreen"]);
  assert.deepEqual(resized.container, { width: 1280, height: 760 }, "the dimensions arrive whole and replace");
  // device capabilities merge per flag
  const touch = mergeHostContext(resized, { deviceCapabilities: { touch: true } });
  assert.equal(touch.touch, true);
  assert.equal(touch.hover, true);
  assert.equal(mergeHostContext(touch, undefined), touch);
});

test("host context: the dimensions belong to a display mode — a mode change without new ones forgets them", () => {
  const fullscreen = mergeHostContext(base, {
    displayMode: "fullscreen",
    containerDimensions: { width: 1280, height: 760 },
  });
  const back = mergeHostContext(fullscreen, { displayMode: "inline" });
  assert.deepEqual(back.container, {}, "fullscreen's height is no host-fixed inline height");
  assert.deepEqual(planInlineHeight(undefined, 720, back), { send: 480, declared: "wide" });
  // a mode change that brings its own dimensions keeps them; a same-mode update keeps the old ones
  assert.deepEqual(
    mergeHostContext(fullscreen, { displayMode: "inline", containerDimensions: { maxHeight: 600 } }).container,
    {
      maxHeight: 600,
    },
  );
  assert.deepEqual(mergeHostContext(fullscreen, { displayMode: "fullscreen" }).container, { width: 1280, height: 760 });
});

test("host context: an update that changes nothing is the same state (nobody re-lays out)", () => {
  const a = mergeHostContext(base, {
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions: { maxHeight: 900 },
  });
  const b = mergeHostContext(a, {
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions: { maxHeight: 900 },
  });
  assert.notEqual(a, b);
  assert.equal(sameHostState(a, b), true);
  assert.equal(
    sameHostState(a, mergeHostContext(a, { safeAreaInsets: { top: 1, right: 0, bottom: 0, left: 0 } })),
    false,
  );
  assert.equal(sameHostState(a, { ...a, message: true }), false);
});

test("inline height: 480 from 600 wide, 420 below, capped by maxHeight — declared once", () => {
  const inline = { displayMode: "inline" as const, container: {} };
  const first = planInlineHeight(undefined, 720, inline);
  assert.deepEqual(first, { send: 480, declared: "wide" });
  assert.deepEqual(
    planInlineHeight(first.declared, 900, inline),
    { send: null, declared: "wide" },
    "same class: silent",
  );
  assert.deepEqual(planInlineHeight(undefined, 480, inline), { send: 420, declared: "narrow" });
  assert.deepEqual(planInlineHeight(undefined, 720, { displayMode: "inline", container: { maxHeight: 400 } }), {
    send: 400,
    declared: "wide",
  });
});

test("inline height: re-sent on a width-class flip and on the return to inline; never fixed, never fullscreen", () => {
  const inline = { displayMode: "inline" as const, container: {} };
  const wide = planInlineHeight(undefined, 720, inline);
  assert.deepEqual(
    planInlineHeight(wide.declared, 560, inline),
    { send: 420, declared: "narrow" },
    "a host resize across 600",
  );
  // fullscreen forgets the declaration — the return re-declares
  const fs = planInlineHeight(wide.declared, 1280, { displayMode: "fullscreen", container: {} });
  assert.deepEqual(fs, { send: null, declared: undefined });
  assert.deepEqual(planInlineHeight(fs.declared, 720, inline), { send: 480, declared: "wide" });
  // the host fixes the height: nothing sent, nothing kept — un-fixing declares
  const fixed = planInlineHeight(undefined, 720, { displayMode: "inline", container: { height: 500 } });
  assert.deepEqual(fixed, { send: null, declared: undefined });
  assert.deepEqual(planInlineHeight(fixed.declared, 720, inline), { send: 480, declared: "wide" });
  // a frame not laid out yet decides nothing
  assert.deepEqual(planInlineHeight(undefined, 0, inline), { send: null, declared: undefined });
});

test("re-fit: a display-mode change always; a resize or moved insets only while untouched", () => {
  const quiet = { modeChanged: false, resized: false, insetsChanged: false };
  assert.equal(planRefit(quiet), "none");
  assert.equal(planRefit({ ...quiet, modeChanged: true }), "force");
  assert.equal(planRefit({ ...quiet, modeChanged: true, resized: true }), "force", "the host resized with the mode");
  assert.equal(planRefit({ ...quiet, resized: true }), "untouched", "a settling resize never overrides a move");
  assert.equal(planRefit({ ...quiet, insetsChanged: true }), "untouched", "a panel card opening");
});

test("palette: open at its slot, behind Tools only while pressed; nothing to drive without one", () => {
  assert.equal(paletteShouldOpen("column", false), true);
  assert.equal(paletteShouldOpen("tier1", false), true);
  assert.equal(paletteShouldOpen("tier2", false), true);
  assert.equal(paletteShouldOpen("tools", false), false);
  assert.equal(paletteShouldOpen("tools", true), true);
  assert.equal(paletteShouldOpen("none", true), undefined);
});

test("palette size: measured while visible, the last natural size while hidden, present-but-unseen counts", () => {
  const seen = { w: 94, h: 300 };
  assert.deepEqual(paletteForLayout(true, seen, { w: 0, h: 0 }), seen);
  assert.deepEqual(paletteForLayout(true, { w: 0, h: 0 }, seen), seen, "behind Tools: the last natural size");
  assert.deepEqual(paletteForLayout(true, { w: 0, h: 0 }, { w: 0, h: 0 }), { w: 1, h: 1 }, "booted compact");
  assert.deepEqual(paletteForLayout(false, seen, seen), { w: 0, h: 0 }, "a viewer has none");
});
