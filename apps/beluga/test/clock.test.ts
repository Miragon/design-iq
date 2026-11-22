import assert from "node:assert/strict";
import { test } from "node:test";

import { SampleClock } from "../src/engine/clock.ts";

const RATE = 16000;
const PIECE = 1600; // 100 ms
const start = new Date(2026, 10, 21, 14, 30, 0).getTime();

/** feeds `count` pieces that arrive on time from `from` on, answers the time after the last */
function feed(clock: SampleClock, from: number, count: number, jitter = (_i: number) => 0): number {
  let at = from;
  for (let i = 0; i < count; i++) {
    at += 100;
    clock.piece(PIECE, at + jitter(i));
  }
  return at;
}

test("a sample's time counts from the first piece", () => {
  const clock = new SampleClock(RATE);
  feed(clock, start, 50);
  assert.equal(clock.timeOf(0), start);
  assert.equal(clock.timeOf(RATE * 3), start + 3000);
});

test("late delivery does not move the clock", () => {
  const clock = new SampleClock(RATE);
  // pieces held up by a busy page or engine arrive up to a second late, then in a burst
  feed(clock, start, 100, (i) => (i % 20 < 10 ? (i % 20) * 100 : 0));
  assert.equal(clock.timeOf(RATE * 9), start + 9000);
});

test("a pause in the capture starts a new anchor", () => {
  const clock = new SampleClock(RATE);
  const before = feed(clock, start, 50); // 5 s
  // the machine sleeps for half an hour, then capture goes on
  const after = before + 30 * 60 * 1000;
  feed(clock, after, 50);
  assert.equal(clock.timeOf(RATE * 2), start + 2000, "before the pause");
  assert.equal(clock.timeOf(RATE * 5), after, "the first sample after the pause");
  assert.equal(clock.timeOf(RATE * 7), after + 2000, "after the pause");
});

test("without any piece there is no time", () => {
  assert.ok(Number.isNaN(new SampleClock(RATE).timeOf(0)));
});
