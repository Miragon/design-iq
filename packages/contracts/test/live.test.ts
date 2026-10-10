/**
 * The live contract's ONE runtime helper besides the room names: the presence
 * color every client (web, VS Code, the Live Host's agent presence) derives
 * from the same principal must agree — one person, one color everywhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MOVED_NOTICE, movedNotice, parseMovedNotice, PRESENCE_COLORS, presenceColor } from "../src/live.ts";

test("presenceColor: deterministic per principal, always a hex color", () => {
  assert.equal(presenceColor("petra"), presenceColor("petra"));
  assert.match(presenceColor("petra"), /^#[0-9a-f]{6}$/);
  assert.match(presenceColor(""), /^#[0-9a-f]{6}$/);
  // the agent acting for a person is a different participant
  assert.notEqual(presenceColor("agent:petra"), presenceColor("petra"));
});

// `#rrggbb` → linear-light sRGB channels (all this palette holds)
const linear = (hex: string): [number, number, number] => {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return [r, g, b];
};
// WCAG 2.x relative luminance / contrast
const luminance = (hex: string): number => {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
// OKLab distance — how far apart two colours LOOK (≈ 0.02 is a just-noticeable step)
const oklab = (hex: string): [number, number, number] => {
  const [r, g, b] = linear(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};
const distance = (a: string, b: string): number => {
  const [p, q] = [oklab(a), oklab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};

const WHITE = "#ffffff";

test("presence palette: white name labels ≥ 4.5:1, cursors/outlines ≥ 3:1 on the white canvas (#238)", () => {
  for (const color of PRESENCE_COLORS) {
    assert.ok(contrast(WHITE, color) >= 4.5, `white text on ${color}: ${contrast(WHITE, color).toFixed(2)}:1`);
    assert.ok(contrast(color, WHITE) >= 3, `${color} on the white canvas: ${contrast(color, WHITE).toFixed(2)}:1`);
  }
});

test("presence palette: seven distinct people, none in the local selection blue (#238)", () => {
  // the hash takes `% length` — a different length reshuffles every person's color
  assert.equal(PRESENCE_COLORS.length, 7);
  for (const [i, a] of PRESENCE_COLORS.entries()) {
    assert.match(a, /^#[0-9a-f]{6}$/);
    for (const b of PRESENCE_COLORS.slice(i + 1)) {
      assert.ok(distance(a, b) >= 0.1, `${a} vs ${b} too alike: ${distance(a, b).toFixed(3)}`);
    }
    // CI blau (#335DE5) marks the LOCAL selection — a peer must not look like it
    assert.ok(distance(a, "#335de5") >= 0.15, `${a} reads as the local selection blue`);
  }
  // every slot is reachable
  const seen = new Set(Array.from({ length: 500 }, (_, i) => presenceColor(`user-${i}`)));
  assert.equal(seen.size, PRESENCE_COLORS.length);
});

test("movedNotice: round-trips through parseMovedNotice; anything else is no notice (#208)", () => {
  assert.deepEqual(parseMovedNotice(movedNotice("acme/models", "processes/o2c.bpmn", "Petra")), {
    type: "bpmiq/moved", // legacy-name-ok: frozen wire value
    to: "processes/o2c.bpmn",
    room: "acme/models/processes/o2c.bpmn",
    by: "Petra",
  });
  for (const payload of [
    "not json",
    "null",
    JSON.stringify({ type: "other", to: "x.bpmn" }),
    JSON.stringify({ type: "bpmiq/moved" }), // legacy-name-ok
    JSON.stringify({ type: "bpmiq/moved", to: "" }), // legacy-name-ok
    JSON.stringify({ type: "bpmiq/moved", to: "../../etc/passwd", room: "a/b/../../etc/passwd" }), // legacy-name-ok
    JSON.stringify({ type: "bpmiq/moved", to: "p/x.bpmn" }), // legacy-name-ok
    JSON.stringify({ type: "bpmiq/moved", to: "p/x.bpmn", room: "a/b/p/other.bpmn" }), // legacy-name-ok
  ]) {
    assert.equal(parseMovedNotice(payload), undefined, payload);
  }
});

test("MOVED_NOTICE is frozen: a client built before any product rename still follows a move", () => {
  // Spelled in two halves ON PURPOSE: a search/replace of the product name
  // rewrites the constant and every fixture above in the same breath, and the
  // round-trip stays green — this spelling it cannot reach.
  const frozen = "bpm" + "iq/moved";
  assert.equal(MOVED_NOTICE, frozen);
  // what the Live Host sends is what an old client compares against …
  const sent = JSON.parse(movedNotice("acme/models", "processes/o2c.bpmn", "Petra")) as { type: string };
  assert.equal(sent.type, frozen);
  // … and a notice in the old spelling is still a notice
  const legacy = JSON.stringify({ type: frozen, to: "p/x.bpmn", room: "acme/models/p/x.bpmn", by: "Petra" });
  assert.equal(parseMovedNotice(legacy)?.to, "p/x.bpmn");
});
