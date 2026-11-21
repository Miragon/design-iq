import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkTuning,
  DEFAULT_MIC,
  DEFAULT_SETTINGS,
  DEFAULT_TUNING,
  readSettings,
  TUNING_CHOICES,
} from "../src/core/settings.ts";

test("every default is one of the values the window offers", () => {
  for (const [key, values] of Object.entries(TUNING_CHOICES)) {
    assert.ok((values as readonly number[]).includes(DEFAULT_TUNING[key as keyof typeof TUNING_CHOICES]), key);
  }
});

test("every value the window offers passes the check of a start request", () => {
  for (const [key, values] of Object.entries(TUNING_CHOICES)) {
    for (const value of values) assert.equal(checkTuning({ [key]: value })[key as keyof typeof TUNING_CHOICES], value);
  }
});

test("a start request without tuning, or with part of it, gets the defaults for the rest", () => {
  assert.deepEqual(checkTuning(undefined), DEFAULT_TUNING);
  assert.deepEqual(checkTuning({ pause: 0.8 }), { ...DEFAULT_TUNING, pause: 0.8 });
});

test("a value outside its limits, or of the wrong kind, is refused", () => {
  assert.throws(() => checkTuning({ longestLine: 40 }), /longestLine is out of range/);
  assert.throws(() => checkTuning({ threads: 2.5 }), /threads is out of range/);
  assert.throws(() => checkTuning({ glossaryWeight: "3" }), /glossaryWeight is out of range/);
  assert.throws(() => checkTuning({ speechThreshold: Number.NaN }), /speechThreshold is out of range/);
  assert.throws(() => checkTuning("fast"), /not readable/);
});

test("stored settings come back, and what is missing or broken is the default again", () => {
  const settings = { tuning: { ...DEFAULT_TUNING, pause: 1 }, mic: { ...DEFAULT_MIC, echoCancellation: true } };
  assert.deepEqual(readSettings(JSON.parse(JSON.stringify(settings))), settings);
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings({ tuning: { pause: 99, threads: 2 }, mic: { noiseSuppression: "yes" } }), {
    tuning: { ...DEFAULT_TUNING, threads: 2 },
    mic: DEFAULT_MIC,
  });
});
