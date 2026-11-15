/**
 * The arm rules as pure functions (src/notations/board/arm-rules.ts): the zoom a node is armed at,
 * the viewport that brings it into the window, the defaults per strategy, the motion tokens.
 *
 *   node --test apps/web/test/board-arm-rules.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARM_MARGIN,
  ARM_ZOOM_TOLERANCE,
  type ArmPlacement,
  armViewport,
  cubicBezier,
  defaultRules,
  parseArmParams,
  parseDuration,
  parseEase,
  parseMotion,
  resolveRules,
  sameViewport,
  targetZoom,
  viewportBetween,
  wheelChangesZoom,
} from "../src/notations/board/arm-rules.ts";
import { type Box, STRATEGIES, type Viewport } from "../src/notations/board/types.ts";

/** the board's box of the harness's window, under a toolbar band of 55 px */
const BOX: Box = { x: 0, y: 55, width: 1960, height: 1245 };
/** the matrix board's node */
const NODE: Box = { x: 0, y: 0, width: 800, height: 540 };

const place = (over: Partial<ArmPlacement> & { viewport: Viewport }): Viewport =>
  armViewport({ node: NODE, box: BOX, anchor: { x: 0, y: 0 }, rule: "min1", ...over });

/** the node's wrapper on screen at a viewport */
const onScreen = (viewport: Viewport, node: Box = NODE): Box => ({
  x: viewport.x + node.x * viewport.zoom,
  y: viewport.y + node.y * viewport.zoom,
  width: node.width * viewport.zoom,
  height: node.height * viewport.zoom,
});
/** inside the box minus the margin, with the half px a rounded target may be off */
const inside = (rect: Box, box: Box = BOX, margin = ARM_MARGIN): boolean =>
  rect.x >= box.x + margin - 0.5 &&
  rect.y >= box.y + margin - 0.5 &&
  rect.x + rect.width <= box.x + box.width - margin + 0.5 &&
  rect.y + rect.height <= box.y + box.height - margin + 0.5;

describe("defaults per strategy", () => {
  it("overlay arms at zoom exactly 1 and disarms on a board zoom; every other strategy is the board as it was", () => {
    assert.deepEqual(defaultRules("overlay"), { armzoom: "exact1", armedzoom: "disarm", armreturn: "stay" });
    for (const strategy of STRATEGIES.filter((one) => one !== "overlay")) {
      assert.deepEqual(defaultRules(strategy), { armzoom: "off", armedzoom: "free", armreturn: "stay" }, strategy);
    }
  });

  it("a rule given in the URL applies to every strategy, the others keep their default", () => {
    const given = { armzoom: "exact1", armedzoom: null, armreturn: null } as const;
    assert.deepEqual(resolveRules("naive", given), { armzoom: "exact1", armedzoom: "free", armreturn: "stay" });
    assert.deepEqual(resolveRules("overlay", given), { armzoom: "exact1", armedzoom: "disarm", armreturn: "stay" });
    const round4 = { armzoom: "off", armedzoom: "free", armreturn: null } as const;
    assert.deepEqual(resolveRules("overlay", round4), defaultRules("naive"));
  });

  it("armzoom=min1 in the URL is the default of round 5 again, for overlay too", () => {
    const round5 = { armzoom: "min1", armedzoom: null, armreturn: null } as const;
    assert.deepEqual(resolveRules("overlay", round5), { armzoom: "min1", armedzoom: "disarm", armreturn: "stay" });
    // what the two defaults differ in: a zoom above 1.01
    assert.equal(targetZoom(1.5, resolveRules("overlay", round5).armzoom), 1.5);
    assert.equal(targetZoom(1.5, defaultRules("overlay").armzoom), 1);
    assert.equal(
      targetZoom(0.5, resolveRules("overlay", round5).armzoom),
      targetZoom(0.5, defaultRules("overlay").armzoom),
    );
  });
});

describe("the URL's parameters", () => {
  it("are null when absent or unknown, so each node takes the default of its strategy", () => {
    const none = parseArmParams(new URLSearchParams("?board=matrix&strategy=overlay"));
    assert.deepEqual([none.armzoom, none.armedzoom, none.armreturn, none.armmotion], [null, null, null, null]);
    const wrong = parseArmParams(new URLSearchParams("?armzoom=half&armedzoom=1&armreturn=&armmotion=fast"));
    assert.deepEqual([wrong.armzoom, wrong.armedzoom, wrong.armreturn, wrong.armmotion], [null, null, null, null]);
  });

  it("are read by name: two of them joined by an ampersand, as EXTRA_PARAMS passes them", () => {
    const params = parseArmParams(new URLSearchParams("?board=matrix&armzoom=off&armedzoom=free"));
    assert.deepEqual([params.armzoom, params.armedzoom, params.armreturn], ["off", "free", null]);
    const all = parseArmParams(new URLSearchParams("?armzoom=exact1&armedzoom=lock&armreturn=back&armmotion=0"));
    assert.deepEqual([all.armzoom, all.armedzoom, all.armreturn, all.armmotion], ["exact1", "lock", "back", 0]);
  });

  it("armmotion is a duration of 0 or more", () => {
    assert.equal(parseMotion("120"), 120);
    assert.equal(parseMotion("0"), 0);
    assert.equal(parseMotion("-5"), null);
    assert.equal(parseMotion(""), null);
    assert.equal(parseMotion(null), null);
  });
});

describe("the zoom a node is armed at", () => {
  it("off leaves the zoom", () => {
    for (const zoom of [0.1, 0.5, 0.9973, 1, 1.0004, 2.5]) assert.equal(targetZoom(zoom, "off"), zoom);
  });

  it("min1 raises a zoom below 1 to exactly 1 and keeps a zoom above", () => {
    assert.equal(targetZoom(0.1, "min1"), 1);
    assert.equal(targetZoom(0.5, "min1"), 1);
    assert.equal(targetZoom(0.73, "min1"), 1);
    assert.equal(targetZoom(1, "min1"), 1);
    assert.equal(targetZoom(1.5, "min1"), 1.5);
    assert.equal(targetZoom(4, "min1"), 4);
  });

  it("min1 takes a zoom that is nearly 1 for exactly 1, from both sides", () => {
    assert.equal(targetZoom(0.9973, "min1"), 1);
    assert.equal(targetZoom(1.0004, "min1"), 1);
    assert.equal(targetZoom(1 + ARM_ZOOM_TOLERANCE, "min1"), 1);
    // the first zoom that stays: beyond the tolerance, and far below one wheel notch (1.149)
    assert.equal(targetZoom(1.011, "min1"), 1.011);
    assert.equal(targetZoom(1.149, "min1"), 1.149);
  });

  it("exact1 goes to exactly 1 from any zoom", () => {
    for (const zoom of [0.1, 0.5, 0.9973, 1, 1.0004, 1.5, 4]) assert.equal(targetZoom(zoom, "exact1"), 1);
  });

  it("never gives a zoom below the rule's", () => {
    for (let zoom = 0.1; zoom <= 4; zoom += 0.013) {
      assert.ok(targetZoom(zoom, "min1") >= 1, `min1 from ${zoom}`);
      assert.equal(targetZoom(zoom, "exact1"), 1);
    }
  });
});

describe("the viewport a node is armed at", () => {
  it("off returns the viewport as it is, wherever the node lies", () => {
    const viewport = { x: -5000, y: 9000, zoom: 0.31 };
    assert.equal(place({ viewport, rule: "off" }), viewport);
  });

  it("changes nothing for a node that is in the box at an allowed zoom", () => {
    const viewport = { x: 60.4, y: 80.2, zoom: 1 };
    assert.equal(place({ viewport }), viewport);
    const above = { x: 100, y: 120, zoom: 1.5 };
    assert.equal(place({ viewport: above }), above);
  });

  it("zooms about the anchor: the flow point under it stays under it when no shift is needed", () => {
    // a node in the middle of the board at zoom 0.5, the pointer on it
    const viewport = { x: 700, y: 500, zoom: 0.5 };
    const anchor = { x: 900, y: 640 };
    const flow = { x: (anchor.x - viewport.x) / viewport.zoom, y: (anchor.y - viewport.y) / viewport.zoom };
    const target = place({ viewport, anchor });
    assert.equal(target.zoom, 1);
    assert.ok(Math.abs(target.x + flow.x * target.zoom - anchor.x) <= 0.5);
    assert.ok(Math.abs(target.y + flow.y * target.zoom - anchor.y) <= 0.5);
    assert.ok(inside(onScreen(target)));
  });

  it("then shifts by the least amount that puts the whole wrapper inside the box minus the margin", () => {
    // the harness's start: the node at (60, 80) px at zoom 0.5, armed by a double-click on its middle
    const viewport = { x: 60, y: 80, zoom: 0.5 };
    const target = place({ viewport, anchor: { x: 260, y: 215 } });
    // about the anchor alone the node would start at (-140, -55): it is brought to the margin on both axes
    assert.deepEqual(target, { x: ARM_MARGIN, y: BOX.y + ARM_MARGIN, zoom: 1 });
    assert.ok(inside(onScreen(target)));
  });

  it("shifts back from the right and the bottom edge by exactly what sticks out", () => {
    const viewport = { x: 1400, y: 900, zoom: 1 };
    const target = place({ viewport });
    assert.equal(target.zoom, 1);
    assert.equal(target.x + NODE.width, BOX.x + BOX.width - ARM_MARGIN);
    assert.equal(target.y + NODE.height, BOX.y + BOX.height - ARM_MARGIN);
  });

  it("moves along one axis only when the other is in place", () => {
    const viewport = { x: 300, y: -200, zoom: 1.5 };
    const target = place({ viewport });
    assert.equal(target.zoom, 1.5);
    assert.equal(target.x, 300);
    assert.equal(target.y, BOX.y + ARM_MARGIN);
  });

  it("brings the node in at a zoom above 1 without touching the zoom (min1)", () => {
    const viewport = { x: 5000, y: -3000, zoom: 2 };
    const target = place({ viewport });
    assert.equal(target.zoom, 2);
    assert.ok(inside(onScreen(target)));
  });

  it("a node larger than the box, armed without a pointer: its top left corner goes to the margin, the zoom is not lowered", () => {
    const small: Box = { x: 0, y: 55, width: 700, height: 400 };
    const target = place({ viewport: { x: 60, y: 80, zoom: 0.5 }, box: small, anchor: { x: 260, y: 215 } });
    assert.deepEqual(target, { x: ARM_MARGIN, y: small.y + ARM_MARGIN, zoom: 1 });
    // larger on one axis only: that axis starts at the margin, the other moves the least
    const wide: Box = { x: 0, y: 55, width: 700, height: 1245 };
    const mixed = place({ viewport: { x: -300, y: 400, zoom: 1 }, box: wide });
    assert.deepEqual(mixed, { x: ARM_MARGIN, y: 400, zoom: 1 });
  });

  it("exact1 comes down to 1 about the anchor", () => {
    const viewport = { x: -400, y: -300, zoom: 2 };
    const anchor = { x: 600, y: 500 };
    const target = place({ viewport, anchor, rule: "exact1" });
    assert.equal(target.zoom, 1);
    assert.ok(inside(onScreen(target)));
  });

  it("a node inside a group, far from the origin, and a toolbar band", () => {
    const node: Box = { x: 2000, y: 740, width: 940, height: 520 };
    const target = place({ viewport: { x: 15, y: 60, zoom: 0.42 }, node, anchor: { x: 1000, y: 500 } });
    assert.equal(target.zoom, 1);
    assert.ok(inside(onScreen(target, node)));
    assert.ok(onScreen(target, node).y >= BOX.y + ARM_MARGIN - 0.5, "clear of the toolbar");
  });

  it("is whole px when it changes, and a second look changes nothing", () => {
    for (const viewport of [
      { x: 60.3, y: 80.7, zoom: 0.5 },
      { x: -777.7, y: 333.3, zoom: 0.73 },
      { x: 1500.5, y: 20.5, zoom: 1 },
      { x: 12.25, y: -4000.75, zoom: 1.37 },
      { x: 60, y: 80, zoom: 0.9973 },
      { x: 60, y: 80, zoom: 1.0004 },
    ]) {
      for (const rule of ["min1", "exact1"] as const) {
        const anchor = { x: 311.5, y: 207.25 };
        const target = place({ viewport, rule, anchor });
        if (target !== viewport) {
          assert.ok(Number.isInteger(target.x) && Number.isInteger(target.y), JSON.stringify(target));
        }
        assert.ok(inside(onScreen(target)), `${rule} from ${JSON.stringify(viewport)}`);
        const again = place({ viewport: target, rule, anchor: { x: 5, y: 5 } });
        assert.ok(sameViewport(again, target), `stable: ${JSON.stringify(target)} then ${JSON.stringify(again)}`);
      }
    }
  });

  it("holds for a node at a fractional place", () => {
    const node: Box = { x: 13.37, y: -7.77, width: 801.5, height: 539.25 };
    const target = place({ viewport: { x: -90.9, y: 1200.1, zoom: 0.61 }, node });
    assert.ok(inside(onScreen(target, node)));
    assert.ok(sameViewport(place({ viewport: target, node }), target));
  });
});

describe("a node longer than the box, by the kind of anchor", () => {
  /** round 5's window: a board of 1860 x 1300 below a toolbar band of 55 px */
  const BOARD: Box = { x: 0, y: 55, width: 1860, height: 1245 };
  /** the margins of that box: a node may use x 24 to 1836 and y 79 to 1276 */
  const [LEFT, TOP, RIGHT, BOTTOM] = [24, 79, 1836, 1276];
  const by = (anchorKind: "pointer" | "centre", over: Partial<ArmPlacement> & { viewport: Viewport }): Viewport =>
    armViewport({ node: NODE, box: BOARD, anchor: { x: 0, y: 0 }, rule: "min1", anchorKind, ...over });
  /** per axis: a stretch longer than the box minus the margin covers it, a stretch that fits lies inside */
  const placedWell = (rect: Box, box: Box): boolean => {
    const axis = (start: number, size: number, low: number, high: number): boolean =>
      size > high - low
        ? start <= low + 0.5 && start + size >= high - 0.5
        : start >= low - 0.5 && start + size <= high + 0.5;
    return (
      axis(rect.x, rect.width, box.x + ARM_MARGIN, box.x + box.width - ARM_MARGIN) &&
      axis(rect.y, rect.height, box.y + ARM_MARGIN, box.y + box.height - ARM_MARGIN)
    );
  };
  /** the screen point a point of the board's box shows at another viewport */
  const follow = (point: { x: number; y: number }, from: Viewport, to: Viewport) => ({
    x: to.x + ((point.x - from.x) / from.zoom) * to.zoom,
    y: to.y + ((point.y - from.y) / from.zoom) * to.zoom,
  });

  it("the pointer does not move a node that covers the box: zoom 3, the 2400 x 1620 node over the whole board", () => {
    // x from -400 to 2000, y from -200 to 1420: no gap on either axis
    const viewport = { x: -400, y: -200, zoom: 3 };
    assert.equal(by("pointer", { viewport, anchor: { x: 1350, y: 800 } }), viewport);
    // the same by the hook: the start goes to the margin, the double-clicked point would move 506 px
    assert.deepEqual(by("centre", { viewport }), { x: LEFT, y: TOP, zoom: 3 });
  });

  it("round 5's measured start (zoom 3, viewport -1500, -900, pointer at 500, 400) leaves a gap, and the pointer closes it by the least shift", () => {
    // The node ends at x 900 and y 720 there, short of 1836 and 1276: it does NOT cover the box,
    // so the rule moves it (the round 6 handover expected no change for this start; that holds
    // for a start that covers, see the test above). Its end goes to the far margins
    const viewport = { x: -1500, y: -900, zoom: 3 };
    const pointer = { x: 500, y: 400 };
    const target = by("pointer", { viewport, anchor: pointer });
    assert.deepEqual(target, { x: RIGHT - 2400, y: BOTTOM - 1620, zoom: 3 });
    assert.deepEqual(target, { x: -564, y: -344, zoom: 3 });
    // the double-clicked point: 1089 px, and still in the board (round 5: 1811 px, out of it)
    const now = follow(pointer, viewport, target);
    assert.deepEqual(now, { x: 1436, y: 956 });
    assert.ok(now.x <= 1860 && now.y <= 1300);
    // the second start round 5 measured: -1200, -700, pointer at 600, 500 (round 5: 1451 px)
    const second = by("pointer", { viewport: { x: -1200, y: -700, zoom: 3 }, anchor: { x: 600, y: 500 } });
    assert.deepEqual(second, { x: -564, y: -344, zoom: 3 });
  });

  it("the same start by the hook: the node's start at the margin, as built", () => {
    assert.deepEqual(by("centre", { viewport: { x: -1500, y: -900, zoom: 3 } }), { x: LEFT, y: TOP, zoom: 3 });
    // and no kind given is the centre
    const plain = armViewport({
      viewport: { x: -1500, y: -900, zoom: 3 },
      node: NODE,
      box: BOARD,
      anchor: { x: 500, y: 400 },
      rule: "min1",
    });
    assert.deepEqual(plain, { x: LEFT, y: TOP, zoom: 3 });
  });

  it("exact1 from zoom 3 by the pointer: the node fits at zoom 1 and is handled as a node that fits", () => {
    // about the pointer alone the node would start at -167, -33: brought in by the least shift
    const corner = by("pointer", {
      viewport: { x: -1500, y: -900, zoom: 3 },
      anchor: { x: 500, y: 400 },
      rule: "exact1",
    });
    assert.deepEqual(corner, { x: LEFT, y: TOP, zoom: 1 });
    // with room on all sides nothing is shifted: the double-clicked point stays within the half px of rounding
    const viewport = { x: -400, y: -200, zoom: 3 };
    const pointer = { x: 1350, y: 800 };
    const target = by("pointer", { viewport, anchor: pointer, rule: "exact1" });
    assert.deepEqual(target, { x: 767, y: 467, zoom: 1 });
    const now = follow(pointer, viewport, target);
    assert.ok(Math.abs(now.x - pointer.x) <= 0.5 && Math.abs(now.y - pointer.y) <= 0.5);
  });

  describe("a 940 wide node in a 760 wide board at zoom 1", () => {
    const narrow: Box = { x: 0, y: 55, width: 760, height: 1245 };
    const node: Box = { x: 0, y: 0, width: 940, height: 540 };
    const wide = (anchorKind: "pointer" | "centre", x: number): Viewport =>
      armViewport({
        viewport: { x, y: 300, zoom: 1 },
        node,
        box: narrow,
        anchor: { x: 380, y: 500 },
        rule: "min1",
        anchorKind,
      });

    it("double-clicked at its left: the start beyond the margin goes to the margin", () => {
      // the node from 200 to 1140: 176 px of board to its left
      assert.deepEqual(wide("pointer", 200), { x: 24, y: 300, zoom: 1 });
    });

    it("double-clicked at its middle: it covers the board and stays", () => {
      // the node from -100 to 840 over the box from 24 to 736
      const viewport = { x: -100, y: 300, zoom: 1 };
      assert.equal(
        armViewport({ viewport, node, box: narrow, anchor: { x: 380, y: 500 }, rule: "min1", anchorKind: "pointer" }),
        viewport,
      );
    });

    it("double-clicked at its right: the end short of the margin goes to the margin", () => {
      // the node from -500 to 440: 296 px of board to its right
      const target = wide("pointer", -500);
      assert.deepEqual(target, { x: -204, y: 300, zoom: 1 });
      assert.equal(target.x + node.width, narrow.width - ARM_MARGIN);
    });

    it("without a pointer all three start at the margin", () => {
      for (const x of [200, -100, -500]) assert.deepEqual(wide("centre", x), { x: 24, y: 300, zoom: 1 });
    });

    it("the axis on which it fits is handled as built: the least shift into the box", () => {
      const low = armViewport({
        viewport: { x: -100, y: 1000, zoom: 1 },
        node,
        box: narrow,
        anchor: { x: 380, y: 1100 },
        rule: "min1",
        anchorKind: "pointer",
      });
      assert.deepEqual(low, { x: -100, y: 55 + 1245 - ARM_MARGIN - 540, zoom: 1 });
      const high = armViewport({
        viewport: { x: -500, y: -40, zoom: 1 },
        node,
        box: narrow,
        anchor: { x: 380, y: 100 },
        rule: "min1",
        anchorKind: "pointer",
      });
      assert.deepEqual(high, { x: -204, y: 55 + ARM_MARGIN, zoom: 1 });
    });

    it("from the fitted zoom of the demo board (0.2708): zoom 1 about the pointer, then no gap on either long axis", () => {
      // the window of 1100 x 650: the toolbar wraps (band 95 px) and the node is longer than the box on both axes
      const box: Box = { x: 0, y: 95, width: 760, height: 555 };
      const order: Box = { x: 1000, y: 60, width: 940, height: 540 };
      const viewport = { x: 28, y: 113.8, zoom: 0.2708 };
      for (const pointer of [
        { x: 337, y: 167 },
        { x: 426, y: 203 },
        { x: 515, y: 247 },
      ]) {
        const target = armViewport({
          viewport,
          node: order,
          box,
          anchor: pointer,
          rule: "exact1",
          anchorKind: "pointer",
        });
        const rect = onScreen(target, order);
        assert.equal(target.zoom, 1);
        assert.ok(rect.x <= 24 + 0.5 && rect.x + rect.width >= 736 - 0.5, `x covered from ${JSON.stringify(pointer)}`);
        assert.ok(
          rect.y <= 119 + 0.5 && rect.y + rect.height >= 626 - 0.5,
          `y covered from ${JSON.stringify(pointer)}`,
        );
        // never further than a start or an end at its margin
        assert.ok(rect.x >= 736 - 940 - 0.5 && rect.y >= 626 - 540 - 0.5);
      }
      // the upper left: the start to the left margin (as built), the end to the lower margin (built: the start to the upper)
      const upperLeft = armViewport({
        viewport,
        node: order,
        box,
        anchor: { x: 337, y: 167 },
        rule: "exact1",
        anchorKind: "pointer",
      });
      assert.deepEqual(upperLeft, { x: -976, y: 26, zoom: 1 });
      const asBuilt = armViewport({ viewport, node: order, box, anchor: { x: 337, y: 167 }, rule: "exact1" });
      assert.deepEqual(asBuilt, { x: -976, y: 59, zoom: 1 });
    });
  });

  it("a second look with the arming's own kind starts no move, and still repairs a resize", () => {
    const starts = [
      { viewport: { x: -1500, y: -900, zoom: 3 }, anchor: { x: 500, y: 400 } },
      { viewport: { x: -400, y: -200, zoom: 3 }, anchor: { x: 1350, y: 800 } },
      { viewport: { x: 60, y: 80, zoom: 2.5 }, anchor: { x: 900, y: 600 } },
      { viewport: { x: -777.7, y: 333.3, zoom: 3.37 }, anchor: { x: 311.5, y: 207.25 } },
    ];
    for (const start of starts) {
      const target = by("pointer", start);
      // after the last write the board has no pointer: the anchor is the node's centre, the kind is the arming's
      const centreOfNode = { x: target.x + 400 * target.zoom, y: target.y + 270 * target.zoom };
      const again = by("pointer", { viewport: target, anchor: centreOfNode });
      assert.ok(sameViewport(again, target), `stable: ${JSON.stringify(target)} then ${JSON.stringify(again)}`);
      // a larger window opens a gap at the far end: closed by the least shift (an axis that is
      // long still: covered again; an axis on which the node fits now: inside)
      const larger: Box = { x: 0, y: 55, width: 2300, height: 1545 };
      const repaired = by("pointer", { viewport: target, anchor: centreOfNode, box: larger });
      assert.ok(placedWell(onScreen(repaired), larger), JSON.stringify(repaired));
      // and by no more than that gap: the far end at its margin, or nothing moved on that axis
      const [was, now] = [onScreen(target), onScreen(repaired)];
      assert.ok(now.x === was.x || Math.abs(now.x + now.width - (2300 - ARM_MARGIN)) <= 0.5, JSON.stringify(repaired));
      assert.ok(now.y === was.y || Math.abs(now.y + now.height - (55 + 1545 - ARM_MARGIN)) <= 0.5);
      // a smaller window leaves the node covering: nothing to repair
      const smaller: Box = { x: 0, y: 55, width: 1200, height: 745 };
      assert.ok(sameViewport(by("pointer", { viewport: target, anchor: centreOfNode, box: smaller }), target));
    }
    // the trap this guards: looked at again as a hook would, the pointer's place is thrown to the margin
    const kept = by("pointer", { viewport: { x: -400, y: -200, zoom: 3 }, anchor: { x: 1350, y: 800 } });
    assert.deepEqual(by("centre", { viewport: kept }), { x: LEFT, y: TOP, zoom: 3 });
  });

  it("a node within half a px of covering counts as covering, and a target is whole px", () => {
    // start 0.4 px beyond the margin, end far beyond: in
    const near = { x: 24.4, y: 79.4, zoom: 3 };
    assert.equal(by("pointer", { viewport: near }), near);
    // end 0.4 px short: in
    const short = { x: 1836 - 2400 - 0.4, y: 1276 - 1620 - 0.4, zoom: 3 };
    assert.equal(by("pointer", { viewport: short }), short);
    for (const viewport of [
      { x: 60.3, y: 80.7, zoom: 2.5 },
      { x: -2777.7, y: -1333.3, zoom: 3.5 },
      { x: 1500.5, y: 20.5, zoom: 4 },
      { x: -1200, y: 900, zoom: 2.61 },
    ]) {
      const target = by("pointer", { viewport, anchor: { x: 500, y: 400 } });
      if (target !== viewport)
        assert.ok(Number.isInteger(target.x) && Number.isInteger(target.y), JSON.stringify(target));
      const rect = onScreen(target);
      assert.ok(rect.x <= LEFT + 0.5 && rect.x + rect.width >= RIGHT - 0.5, `x covered: ${JSON.stringify(target)}`);
      assert.ok(rect.y <= TOP + 0.5 && rect.y + rect.height >= BOTTOM - 0.5, `y covered: ${JSON.stringify(target)}`);
    }
  });

  it("a node that fits is placed the same by both kinds", () => {
    for (const viewport of [
      { x: 60, y: 80, zoom: 0.5 },
      { x: 1400, y: 900, zoom: 1 },
      { x: 300, y: -200, zoom: 1.5 },
      { x: 5000, y: -3000, zoom: 2 },
    ]) {
      const anchor = { x: 260, y: 215 };
      assert.deepEqual(by("pointer", { viewport, anchor }), by("centre", { viewport, anchor }));
    }
  });
});

describe("the move between two viewports", () => {
  const from = { x: 60, y: 80, zoom: 0.5 };
  const to = { x: 24, y: 79, zoom: 1 };

  it("starts at the one, ends at the other, exactly", () => {
    assert.equal(viewportBetween(from, to, 0), from);
    assert.equal(viewportBetween(from, to, 1), to);
    assert.equal(viewportBetween(from, to, 1.2), to);
    assert.deepEqual(viewportBetween(from, to, 0.5), { x: 42, y: 79.5, zoom: 0.75 });
  });

  it("keeps a point in place that ends where it began", () => {
    // zoom about an anchor with no shift: the anchor's flow point
    const anchor = { x: 400, y: 300 };
    const start = { x: 100, y: 50, zoom: 0.5 };
    const flow = { x: (anchor.x - start.x) / start.zoom, y: (anchor.y - start.y) / start.zoom };
    const end = { x: anchor.x - flow.x, y: anchor.y - flow.y, zoom: 1 };
    for (const t of [0.1, 0.33, 0.5, 0.9]) {
      const now = viewportBetween(start, end, t);
      assert.ok(Math.abs(now.x + flow.x * now.zoom - anchor.x) < 1e-9);
      assert.ok(Math.abs(now.y + flow.y * now.zoom - anchor.y) < 1e-9);
    }
  });

  it("never leaves the range between the two zooms", () => {
    for (let t = 0; t <= 1; t += 0.05) {
      const { zoom } = viewportBetween(from, to, t);
      assert.ok(zoom >= 0.5 && zoom <= 1);
    }
  });
});

describe("motion from the design tokens", () => {
  it("reads a CSS time", () => {
    assert.equal(parseDuration("250ms"), 250);
    assert.equal(parseDuration(" 250ms "), 250);
    assert.equal(parseDuration("0.4s"), 400);
    assert.equal(parseDuration(".15s"), 150);
    assert.equal(parseDuration("0"), 0);
    assert.equal(parseDuration(""), null);
    assert.equal(parseDuration("fast"), null);
  });

  it("reads the token's cubic-bezier and eases from 0 to 1", () => {
    const ease = parseEase(" cubic-bezier(0.4, 0, 0.2, 1)");
    assert.equal(ease(0), 0);
    assert.equal(ease(1), 1);
    // the standard curve: slow start, 0.5 of the time is past half of the way
    assert.ok(ease(0.1) < 0.1);
    assert.ok(Math.abs(ease(0.5) - 0.7756) < 0.001, String(ease(0.5)));
    let last = 0;
    for (let t = 0; t <= 1; t += 0.01) {
      const value = ease(t);
      assert.ok(value >= last - 1e-9 && value >= 0 && value <= 1, `monotonic at ${t}`);
      last = value;
    }
  });

  it("a curve whose control points lie on the diagonal is the identity", () => {
    const identity = cubicBezier(0.25, 0.25, 0.75, 0.75);
    for (const t of [0.1, 0.5, 0.9]) assert.ok(Math.abs(identity(t) - t) < 1e-6);
  });

  it("falls back to an even pace for anything that is no usable cubic-bezier", () => {
    for (const token of ["", "ease", "cubic-bezier(1, 2)", "cubic-bezier(2, 0, 0.2, 1)", "steps(4)"]) {
      const ease = parseEase(token);
      assert.equal(ease(0.25), 0.25, token);
      assert.equal(ease(-1), 0, token);
      assert.equal(ease(3), 1, token);
    }
  });
});

describe("a wheel event and the board zoom", () => {
  it("changes the zoom unless it has no vertical part or pushes against the range", () => {
    assert.equal(wheelChangesZoom(1, 40, 0.1, 4), true);
    assert.equal(wheelChangesZoom(1, -40, 0.1, 4), true);
    assert.equal(wheelChangesZoom(1, 0, 0.1, 4), false);
    assert.equal(wheelChangesZoom(4, -40, 0.1, 4), false);
    assert.equal(wheelChangesZoom(4, 40, 0.1, 4), true);
    assert.equal(wheelChangesZoom(0.1, 40, 0.1, 4), false);
    assert.equal(wheelChangesZoom(0.1, -40, 0.1, 4), true);
  });
});
