/**
 * The layout calculator (src/mcp-app/core/layout.ts): measured degrade, the
 * compact rule, where the renderer palette lives, card vs sheet, the fit
 * insets and the one inline height. The cluster widths are MEASURED in the
 * widget itself (clones of #tl / #tr as chrome/layout-dom.ts takes them, the
 * Workshop chip ON, Geist) at every degrade step — not invented breakpoints.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CARD_GAP,
  computeLayout,
  degradeStep,
  inlineHeightFor,
  inView,
  isCompact,
  LANE_GAP,
  LANE_MIN,
  laneHold,
  type LayoutInput,
  MIN_GAP,
  revealDelta,
  SHEET_BODY,
  SHEET_HEAD,
  sheetFolds,
  visibleView,
} from "../src/mcp-app/core/layout.ts";

/** TL / TR widths per step 0…9 (comet → Open short → compact chip / icon
 *  switch → toggle icon → Open icon → name truncation → Workshop / view switch
 *  menu-only → fullscreen menu-only → the trigger icon-only) and the name's
 *  width — measured in Chrome on the built widgets (Geist loaded); re-measure
 *  when the chrome's labels, paddings or font change */
const MEASURED = {
  bpmn: {
    tl: [304, 257, 257, 213, 213, 213, 213, 147, 147, 44],
    tr: [315, 315, 242, 242, 193, 148, 148, 148, 104, 104],
    name: 87,
  },
  bpmnCompact: {
    tl: [348, 301, 301, 257, 257, 257, 257, 191, 191, 88],
    tr: [315, 315, 242, 242, 193, 148, 148, 148, 104, 104],
    name: 87,
  },
  dmn: {
    tl: [365, 318, 318, 250, 250, 250, 250, 172, 172, 44],
    tr: [377, 377, 304, 304, 246, 201, 201, 201, 157, 157],
    name: 112,
  },
  /** the DRD view when compact: + Tools (36 + the 8px gap) */
  dmnDrdCompact: {
    tl: [409, 362, 362, 294, 294, 294, 294, 216, 216, 88],
    tr: [377, 377, 304, 304, 246, 201, 201, 201, 157, 157],
    name: 112,
  },
  miragon: {
    tl: [186, 139, 139, 139, 139, 139, 139, 139, 139, 36],
    tr: [198, 198, 125, 125, 125, 80, 80, 80, 36, 36],
    name: 87,
  },
  miragonCompact: {
    tl: [230, 183, 183, 183, 183, 183, 183, 183, 183, 80],
    tr: [198, 198, 125, 125, 125, 80, 80, 80, 36, 36],
    name: 87,
  },
};
/** the bpmn-js palette in its left column (two columns), the storm palette (one row) */
const BPMN_PALETTE = { w: 94, h: 300 };
const STORM_PALETTE = { w: 509, h: 51 };

function bpmn(W: number, H: number, over: Partial<LayoutInput> = {}): ReturnType<typeof computeLayout> {
  const m = isCompact(W, H, over.displayMode ?? "inline") ? MEASURED.bpmnCompact : MEASURED.bpmn;
  return computeLayout({
    W,
    H,
    displayMode: "inline",
    kind: "bpmn",
    steps: { tl: m.tl, tr: m.tr },
    nameWidth: m.name,
    palette: BPMN_PALETTE,
    panelOpen: false,
    ...over,
  });
}

test("degrade steps (bpmn): 720 → 0, 650 → 1, 600 → 2, 480 → compact + 5, 960/1280 → 0", () => {
  const at720 = bpmn(720, 520);
  assert.equal(at720.step, 0);
  assert.equal(at720.gap, 696 - 304 - 315, "the spec's 77px");
  assert.equal(bpmn(650, 520).step, 1);
  const at600 = bpmn(600, 520);
  assert.equal(at600.compact, false, "600 wide is not compact");
  assert.equal(at600.step, 2);
  const at480 = bpmn(480, 480);
  assert.equal(at480.compact, true);
  assert.equal(at480.step, 5, "TL 257 with Tools + TR 148 (Open as icon)");
  assert.equal(at480.gap, 456 - 257 - 148, "the spec's 51px");
  assert.equal(bpmn(960, 600).step, 0);
  assert.equal(bpmn(1280, 760, { displayMode: "fullscreen" }).step, 0);
});

test("degrade steps (dmn, Miragon): the first step that keeps 16px, measured — not a breakpoint", () => {
  const dmn = (W: number) =>
    computeLayout({
      W,
      H: 520,
      displayMode: "inline",
      kind: "dmn",
      view: "table",
      steps: MEASURED.dmn,
      palette: { w: 0, h: 0 },
      panelOpen: false,
    });
  assert.equal(dmn(720).step, 2, "the spec table's step 2");
  assert.equal(dmn(740).step, 1);
  assert.equal(dmn(1280).step, 0);
  const storm = (W: number) =>
    computeLayout({
      W,
      H: 520,
      displayMode: "inline",
      kind: "miragon",
      steps: MEASURED.miragon,
      palette: STORM_PALETTE,
      panelOpen: false,
    });
  assert.equal(storm(720).step, 0);
  assert.equal(storm(400).step, 1);
  assert.equal(storm(360).step, 2);
});

test("no TL/TR overlap at any width from a 320px phone column up — every kind keeps the 16px gap", () => {
  for (let W = 320; W <= 1400; W += 5) {
    for (const [kind, m, mc] of [
      ["bpmn", MEASURED.bpmn, MEASURED.bpmnCompact],
      ["dmn", MEASURED.dmn, MEASURED.dmn],
      ["dmn", MEASURED.dmn, MEASURED.dmnDrdCompact],
      ["miragon", MEASURED.miragon, MEASURED.miragonCompact],
    ] as const) {
      const steps = isCompact(W, 520, "inline") ? mc : m;
      const l = computeLayout({
        W,
        H: 520,
        displayMode: "inline",
        kind,
        steps,
        nameWidth: steps.name,
        palette: { w: 0, h: 0 },
        panelOpen: false,
      });
      assert.ok(l.gap >= MIN_GAP, `${kind} @${W}: gap ${l.gap} at step ${l.step}`);
      if (W >= 600) assert.equal(l.nameMax, null, `${kind} @${W}: the name never truncates from 600 up`);
    }
  }
});

test("phone widths: the menu takes over Workshop / the view switch (7), fullscreen (8), then the name (9)", () => {
  const at = (W: number, m: (typeof MEASURED)[keyof typeof MEASURED], kind: "bpmn" | "dmn") =>
    computeLayout({
      W,
      H: 480,
      displayMode: "inline",
      kind,
      steps: m,
      nameWidth: m.name,
      palette: { w: 0, h: 0 },
      panelOpen: false,
    });
  // the review's frames: 375 bpmn overlapped the Workshop chip, 400 dmn the "Table" segment
  assert.deepEqual(
    [at(375, MEASURED.bpmnCompact, "bpmn").step, at(375, MEASURED.bpmnCompact, "bpmn").nameMax],
    [7, 83],
  );
  assert.equal(at(400, MEASURED.dmn, "dmn").step, 7);
  assert.equal(at(340, MEASURED.dmn, "dmn").step, 8);
  const icon = at(300, MEASURED.bpmnCompact, "bpmn");
  assert.deepEqual([icon.step, icon.nameMax], [9, null], "the trigger is the menu icon alone");
});

test("steps 6–8 truncate the name against the actual overflow, never below 72; step 9 drops it", () => {
  // never fits untruncated below 532; step 9 (the menu icon alone) frees 140
  const steps = { tl: [300, 300, 300, 300, 300, 300, 300, 300, 300, 160], tr: [200] };
  const l = (W: number) =>
    computeLayout({
      W,
      H: 520,
      displayMode: "inline",
      kind: "bpmn",
      steps,
      nameWidth: 140,
      palette: { w: 0, h: 0 },
      panelOpen: false,
    });
  const a = l(500); // avail 476 → gap −24 → 40 over: the name gives exactly that
  assert.equal(a.step, 6);
  assert.equal(a.nameMax, 140 - 40);
  assert.equal(a.gap, MIN_GAP);
  const floor = l(472); // avail 448 → 68 over = everything above 72
  assert.deepEqual([floor.step, floor.nameMax], [6, 72], "the floor");
  const icon = l(400); // 124 over: more than the name can give — the trigger goes icon-only
  assert.deepEqual([icon.step, icon.nameMax], [9, null]);
  assert.ok(icon.gap >= MIN_GAP);
  assert.deepEqual(degradeStep(1000, steps), { step: 0, gap: 500 });
});

test("compact = width < 600 OR height < 440 OR pip", () => {
  assert.equal(isCompact(599, 600, "inline"), true);
  assert.equal(isCompact(600, 440, "inline"), false);
  assert.equal(isCompact(900, 439, "inline"), true);
  assert.equal(isCompact(1280, 760, "pip"), true);
  assert.equal(isCompact(1280, 760, "fullscreen"), false);
  const c = bpmn(480, 480);
  assert.equal(c.showZoomPct, false, "compact hides the % readout");
  assert.equal(bpmn(720, 520).showZoomPct, true);
});

test("palette mode: column (bpmn, DRD), tools when compact, none for viewers and the DMN table, Miragon tier 1/2", () => {
  assert.equal(bpmn(720, 520).paletteMode, "column");
  assert.equal(bpmn(480, 480).paletteMode, "tools");
  assert.equal(bpmn(720, 520, { readonly: true }).paletteMode, "none");
  const dmn = (view: "diagram" | "table", W = 720) =>
    computeLayout({
      W,
      H: 520,
      displayMode: "inline",
      kind: "dmn",
      view,
      steps: MEASURED.dmn,
      palette: { w: 48, h: 200 },
      panelOpen: false,
    });
  assert.equal(dmn("diagram").paletteMode, "column");
  assert.equal(dmn("table").paletteMode, "none");
  const storm = (W: number, H: number, displayMode: LayoutInput["displayMode"] = "inline") =>
    computeLayout({
      W,
      H,
      displayMode,
      kind: "miragon",
      steps: isCompact(W, H, displayMode) ? MEASURED.miragonCompact : MEASURED.miragon,
      palette: STORM_PALETTE,
      panelOpen: false,
    });
  const tier2 = storm(720, 520);
  assert.equal(tier2.paletteMode, "tier2", "720: the palette does not fit between the clusters");
  assert.equal(tier2.fitInsets.top, 12 + 36 + 12 + STORM_PALETTE.h + 8, "the fit leaves room under the tier-2 palette");
  const tier1 = storm(1280, 760, "fullscreen");
  assert.equal(tier1.paletteMode, "tier1");
  assert.equal(tier1.fitInsets.top, 16 + STORM_PALETTE.h + 12, "a palette taller than the row pushes the fit down");
  assert.equal(storm(480, 480).paletteMode, "tools");
});

test("panel: a 320 card inline, 360 from 960 wide and in fullscreen, a full-width sheet when compact", () => {
  assert.deepEqual(bpmn(720, 520).panel, { mode: "card", width: 320 });
  assert.deepEqual(bpmn(960, 600).panel, { mode: "card", width: 360 });
  assert.deepEqual(bpmn(1280, 760, { displayMode: "fullscreen" }).panel, { mode: "card", width: 360 });
  assert.deepEqual(bpmn(480, 480).panel, { mode: "sheet", width: 456 });
});

// a card is never shrunk for the lane: it needs LANE_MIN of canvas beside it
// for the lane, or the panel opens as a sheet (which ends above the lane)
test("panel: a card that would leave the lane under 300px of canvas opens as a sheet", () => {
  assert.equal(LANE_MIN, 300);
  // inline: 12 + 300 + 12 + 320 + 12 = 656
  assert.deepEqual(bpmn(656, 480).panel, { mode: "card", width: 320 });
  assert.deepEqual(bpmn(655, 480).panel, { mode: "sheet", width: 631 });
  assert.equal(bpmn(650, 520).panel.mode, "sheet");
  assert.deepEqual(bpmn(600, 520).panel, { mode: "sheet", width: 576 });
  assert.equal(bpmn(600, 520).compact, false, "only the panel turns — not the rest of the chrome");
  // fullscreen: 16 + 300 + 12 + 360 + 16 = 704
  assert.equal(bpmn(704, 760, { displayMode: "fullscreen" }).panel.mode, "card");
  assert.equal(bpmn(703, 760, { displayMode: "fullscreen" }).panel.mode, "sheet");
  // the safe area narrows the canvas too
  assert.equal(bpmn(660, 480, { safeArea: { left: 8 } }).panel.mode, "sheet");
  // a sheet re-fits nothing, the DMN table keeps its own inset
  const sheet = bpmn(620, 520, { panelOpen: true });
  assert.equal(sheet.fitInsets.right, 16);
  assert.equal(sheet.tableRight, 12);
});

// WCAG 2.4.11: the lane (toasts, decision cards) never overlaps an open panel
test("lane: centred in the frame, min(460, W − 2I) wide; in the canvas column beside an open card", () => {
  const span = (l: { left: number; width: number }): [number, number] => [l.left, l.left + l.width];
  /** the lane's place (its bound is the next test's) */
  const place = (l: ReturnType<typeof bpmn>): { left: number; width: number } => ({
    left: l.lane.left,
    width: l.lane.width,
  });
  // no panel: the frame's centre
  assert.deepEqual(place(bpmn(720, 520)), { left: 130, width: 460 });
  assert.deepEqual(place(bpmn(480, 480)), { left: 12, width: 456 });
  assert.deepEqual(place(bpmn(340, 480)), { left: 12, width: 316 });
  // centred between the insets: an asymmetric safe area moves it
  assert.deepEqual(place(bpmn(480, 480, { safeArea: { left: 44 } })), { left: 56, width: 412 });
  // 720 + the card: the column 12…376 (the card starts at 388) holds 364
  const at720 = bpmn(720, 520, { panelOpen: true });
  assert.deepEqual(place(at720), { left: 12, width: 364 });
  for (const [W, H, over] of [
    [656, 480, {}],
    [720, 440, {}],
    [960, 600, {}],
    [1100, 640, {}],
    [1280, 760, {}],
    [1280, 760, { displayMode: "fullscreen" }],
    [704, 760, { displayMode: "fullscreen" }],
  ] as Array<[number, number, Partial<LayoutInput>]>) {
    const l = bpmn(W, H, { panelOpen: true, ...over });
    assert.equal(l.panel.mode, "card", `${W}x${H}`);
    const [left, right] = span(l.lane);
    const card = W - l.inset.right - l.panel.width;
    assert.ok(right + CARD_GAP <= card, `${W}x${H}: the lane ends ${CARD_GAP}px before the card (${right} / ${card})`);
    assert.ok(left >= l.inset.left, `${W}x${H}: inside the left inset`);
    assert.ok(l.lane.width >= LANE_MIN && l.lane.width <= 460, `${W}x${H}: ${l.lane.width}px`);
    assert.equal(left - l.inset.left, card - CARD_GAP - right, `${W}x${H}: centred in its column`);
  }
  // wide: 460 centred in the column — 1280 inline: 12…896 → 224…684
  assert.deepEqual(place(bpmn(1280, 760, { panelOpen: true })), { left: 224, width: 460 });
  // a sheet spans the frame: the lane keeps its place, the sheet ends above it (chrome.css)
  assert.deepEqual(place(bpmn(480, 480, { panelOpen: true })), place(bpmn(480, 480)));
  assert.deepEqual(place(bpmn(600, 520, { panelOpen: true })), { left: 70, width: 460 });
});

// the lane is bounded: a decision card plus toasts never runs up to the corner
// row (656x440, 720x440), and over a sheet never squeezes it to its head
// (340x480 … 480x480) — feedback.ts planLane fits the toasts into `room`
test("lane bound: never up to the corner row; over a sheet never its head, and toasts leave it SHEET_BODY", () => {
  assert.equal(LANE_GAP, 8);
  assert.equal(SHEET_HEAD, 50);
  assert.equal(SHEET_BODY, 120);
  // no panel, or beside a card: from the bottom row (L 56) up to the corner row (U 56)
  for (const [W, H, panelOpen] of [
    [720, 520, false],
    [656, 440, true],
    [720, 440, true],
    [340, 480, false],
  ] as Array<[number, number, boolean]>) {
    const l = bpmn(W, H, { panelOpen });
    if (panelOpen) assert.equal(l.panel.mode, "card", `${W}x${H}: the lane beside a card`);
    assert.equal(l.lane.max, H - l.laneBottom - l.underRow, `${W}x${H}`);
    assert.equal(l.lane.room, l.lane.max, `${W}x${H}: toasts may fill it`);
  }
  assert.deepEqual(
    [bpmn(656, 440, { panelOpen: true }).lane.max, bpmn(720, 440, { panelOpen: true }).lane.max],
    [328, 328],
  );
  // fullscreen: 16px insets — U and L are 60
  assert.equal(bpmn(1280, 760, { displayMode: "fullscreen" }).lane.max, 760 - 60 - 60);
  // a sheet: the lane stops LANE_GAP under its head; its toasts leave the body
  const sheet = bpmn(480, 420, { panelOpen: true });
  assert.equal(sheet.panel.mode, "sheet");
  assert.deepEqual([sheet.lane.max, sheet.lane.room], [420 - 56 - 56 - 50 - 8, 420 - 56 - 56 - 50 - 8 - 120]);
  for (const [W, H] of [
    [340, 480],
    [375, 480],
    [480, 420],
    [480, 480],
    [600, 520],
    [650, 520],
  ] as Array<[number, number]>) {
    const l = bpmn(W, H, { panelOpen: true });
    assert.equal(l.panel.mode, "sheet", `${W}x${H}`);
    // the sheet ends LANE_GAP above the lane (chrome.css: bottom L + --lane-h)
    const sheetBottom = (laneH: number): number => H - l.laneBottom - laneH - LANE_GAP;
    assert.equal(sheetBottom(l.lane.max) - l.underRow, SHEET_HEAD, `${W}x${H}: a full lane leaves the head`);
    assert.equal(sheetBottom(l.lane.room) - l.underRow, SHEET_HEAD + SHEET_BODY, `${W}x${H}: toasts leave head + body`);
  }
  // a frame too short for any of it: nothing negative
  assert.deepEqual(
    [bpmn(340, 200, { panelOpen: true }).lane.max, bpmn(340, 200, { panelOpen: true }).lane.room],
    [30, 0],
  );
});

test("inView: the focused control shows in its scroller — an intersection, the sub-pixel past the edge counted", () => {
  const view = { top: 105, bottom: 463 };
  // Chrome's Tab focus in a 600–655 wide sheet: 0.390625px past the edge
  const tabbed = { top: 435.390625, bottom: 463.390625 };
  assert.equal(revealDelta(tabbed, view, 0), 0.390625, "containment would call it out of view");
  assert.equal(inView(tabbed, view), true);
  // … so the follow runs, and brings it 8px clear
  assert.equal(revealDelta(tabbed, view), 8.390625);
  assert.equal(inView({ top: 120, bottom: 148 }, view), true);
  assert.equal(inView({ top: 450, bottom: 478 }, view), true, "half of it shows");
  assert.equal(inView({ top: 80, bottom: 108 }, view), true, "its bottom shows under the top edge");
  // under a pixel of it shows, or none: the user scrolled away — no follow
  assert.equal(inView({ top: 462.5, bottom: 490 }, view), false);
  assert.equal(inView({ top: 500, bottom: 528 }, view), false);
  assert.equal(inView({ top: 60, bottom: 105.5 }, view), false);
});

test("revealDelta: how far a scroller follows the focused control — 0 while it is in view", () => {
  const view = { top: 100, bottom: 300 };
  assert.equal(revealDelta({ top: 120, bottom: 148 }, view), 0);
  assert.equal(revealDelta({ top: 272, bottom: 300 }, view), 0, "flush with the edge is in view");
  assert.equal(revealDelta({ top: 272, bottom: 300 }, view, 0), 0);
  // the sheet ended higher: the control below the fold comes up, 8px to spare
  assert.equal(revealDelta({ top: 290, bottom: 318 }, view), 26);
  assert.equal(revealDelta({ top: 400, bottom: 428 }, view), 136);
  // above the viewport: down to it
  assert.equal(revealDelta({ top: 80, bottom: 108 }, view), -28);
  // taller than the viewport: its top aligns, never past it
  assert.equal(revealDelta({ top: 150, bottom: 450 }, view), 50);
  assert.equal(revealDelta({ top: 150, bottom: 450 }, view, 0), 50);
});

test("revealDelta on focus: the WHOLE control — a textarea whose caret line shows comes up whole, 8px clear", () => {
  // 375x480, the Add todo form under two toasts: the scroller shows 105…230;
  // Chrome's Tab into the description (184…249) reveals its caret line only —
  // already in view, so it scrolls nothing
  const view = { top: 105, bottom: 230 };
  const description = { top: 184, bottom: 249 };
  assert.equal(inView(description, view), true, "its caret line shows");
  assert.equal(revealDelta(description, view), 249 - 230 + 8);
  // a whole control in view stays where it is
  assert.equal(revealDelta({ top: 145, bottom: 176 }, view), 0);
});

test("sheetFolds: a decision card folds an open sheet to its head — a card beside it, never", () => {
  assert.equal(sheetFolds("sheet", true), true);
  assert.equal(sheetFolds("sheet", false), false, "answered or deferred: the sheet unfolds");
  assert.equal(sheetFolds("card", true), false, "the lane passes beside a card");
  assert.equal(sheetFolds("card", false), false);
  // the frames the lane is checked at: a sheet up to 650 wide, a card from 656
  for (const [W, H] of [
    [340, 480],
    [375, 480],
    [480, 420],
    [480, 480],
    [600, 520],
    [650, 520],
  ] as Array<[number, number]>) {
    assert.equal(sheetFolds(bpmn(W, H, { panelOpen: true }).panel.mode, true), true, `${W}x${H}`);
  }
  for (const [W, H] of [
    [656, 440],
    [720, 440],
    [720, 520],
    [1280, 760],
  ] as Array<[number, number]>) {
    assert.equal(sheetFolds(bpmn(W, H, { panelOpen: true }).panel.mode, true), false, `${W}x${H}`);
  }
});

test("laneHold: what the lane's entries in the flow hold, LANE_GAP to the sheet — nothing while none is", () => {
  assert.equal(laneHold(0, 0), 0, "empty, or only a leaving toast (out of the flow)");
  assert.equal(laneHold(1, 211), 211 + LANE_GAP);
  // 720x440 beside a card: a keyed replacement holds the card and ONE toast —
  // its predecessor fades out of the flow — so the lane stays inside its max
  const l = bpmn(720, 440, { panelOpen: true });
  const held = 211 + LANE_GAP + 80;
  assert.equal(laneHold(2, held), held + LANE_GAP);
  assert.ok(held <= l.lane.max, `${held} of ${l.lane.max}`);
  assert.ok(held + LANE_GAP + 80 > l.lane.max, "the fading predecessor in the flow would overrun it");
});

test("visibleView: a panel scroller's viewport, ending LANE_GAP above the lane where the lane spans it", () => {
  const scroller = { top: 105, bottom: 400, left: 12, right: 468 };
  assert.deepEqual(visibleView(scroller), { top: 105, bottom: 400 }, "an empty lane");
  // the sheet already ends above the lane (--lane-h): the scroller's own viewport
  assert.deepEqual(visibleView(scroller, { top: 409, bottom: 424, left: 12, right: 468 }), { top: 105, bottom: 400 });
  // the lane grew this frame and the sheet has not followed yet
  assert.deepEqual(visibleView(scroller, { top: 300, bottom: 424, left: 12, right: 468 }), {
    top: 105,
    bottom: 300 - LANE_GAP,
  });
  // beside a card: the lane spans no scroller (720x520: lane 12…376, card 388…708)
  const card = { top: 56, bottom: 464, left: 388, right: 708 };
  assert.deepEqual(visibleView(card, { top: 200, bottom: 464, left: 12, right: 376 }), { top: 56, bottom: 464 });
  // a lane up over the whole scroller: nothing shows, never a negative view
  assert.deepEqual(visibleView(scroller, { top: 60, bottom: 424, left: 12, right: 468 }), { top: 105, bottom: 105 });
});

test("fit insets: the corner row, the left palette, an open card and the bottom row stay clear", () => {
  const l = bpmn(720, 520);
  assert.deepEqual(l.fitInsets, { top: 60, left: 12 + 94 + 16, right: 16, bottom: 56 });
  assert.equal(l.underRow, 56);
  assert.equal(l.laneBottom, 56);
  assert.equal(bpmn(720, 520, { panelOpen: true }).fitInsets.right, 320 + 12 + 12);
  const fs = bpmn(1280, 760, { displayMode: "fullscreen", panelOpen: true });
  assert.deepEqual(fs.fitInsets, { top: 64, left: 16 + 94 + 16, right: 360 + 16 + 12, bottom: 60 });
  assert.equal(fs.underRow, 60);
  // compact: the palette hides behind Tools and a sheet covers the canvas — neither shapes the fit
  assert.deepEqual(bpmn(480, 480, { panelOpen: true }).fitInsets, { top: 60, left: 16, right: 16, bottom: 56 });
  // the DMN table scrolls under a card instead of fitting
  const table = computeLayout({
    W: 720,
    H: 520,
    displayMode: "inline",
    kind: "dmn",
    view: "table",
    steps: MEASURED.dmn,
    palette: { w: 0, h: 0 },
    panelOpen: true,
  });
  assert.equal(table.tableRight, 320 + 12 + 12);
});

test("insets: 12 inline / 16 fullscreen, plus the host's safe area per side; the zoom group docks beside the watermark", () => {
  const l = bpmn(720, 520, { safeArea: { top: 20, bottom: 34 } });
  assert.deepEqual(l.inset, { top: 32, right: 12, bottom: 46, left: 12 });
  assert.equal(l.underRow, 32 + 44);
  assert.equal(l.laneBottom, 46 + 44);
  assert.equal(l.zoomRight, 80, "bpmn.io watermark: bottom 15, right 15, 53 wide — never covered");
  const storm = computeLayout({
    W: 720,
    H: 520,
    displayMode: "fullscreen",
    kind: "miragon",
    steps: MEASURED.miragon,
    palette: STORM_PALETTE,
    panelOpen: false,
  });
  assert.equal(storm.base, 16);
  assert.equal(storm.zoomRight, 16, "no watermark on the Miragon renderers");
});

test("inline height: declared once — 480 from 600 wide, else 420, capped by maxHeight, never when fixed or fullscreen", () => {
  assert.equal(inlineHeightFor(720, "inline"), 480);
  assert.equal(inlineHeightFor(600, "inline"), 480);
  assert.equal(inlineHeightFor(599, "inline"), 420);
  assert.equal(inlineHeightFor(720, "inline", { maxHeight: 400 }), 400);
  assert.equal(inlineHeightFor(720, "inline", { maxHeight: 900 }), 480);
  assert.equal(inlineHeightFor(720, "inline", { height: 500 }), null, "the host fixes it");
  assert.equal(inlineHeightFor(1280, "fullscreen"), null);
  assert.equal(bpmn(480, 480).inlineHeight, 420);
});
