import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPreferences, defaultPreferences, readPreferences } from "../src/core/preferences.ts";
import { DEFAULT_SETTINGS, DEFAULT_TUNING } from "../src/core/settings.ts";

test("without a file the preferences are the defaults, with the folder given", () => {
  assert.deepEqual(readPreferences(null, "/home/x/Documents/Beluga"), defaultPreferences("/home/x/Documents/Beluga"));
});

test("what the file holds comes back, and what does not fit is the default again", () => {
  const prefs = readPreferences(
    {
      model: "whisper-turbo",
      language: "klingon",
      labels: { mic: "Room", system: "Remote" },
      withSystem: false,
      folder: "",
      glossary: "Camunda\nRabattstaffel",
      settings: { tuning: { pause: 0.8, threads: "four" } },
      agent: "yes",
    },
    "/f",
  );
  assert.deepEqual(prefs, {
    model: "whisper-turbo",
    language: "de",
    labels: { mic: "Room", system: "Remote" },
    withSystem: false,
    folder: "/f",
    glossary: "Camunda\nRabattstaffel",
    settings: { ...DEFAULT_SETTINGS, tuning: { ...DEFAULT_TUNING, pause: 0.8 } },
    agent: false,
  });
});

test("a change from the window is taken only as far as it fits", () => {
  assert.deepEqual(checkPreferences({ model: "gpt", labels: { mic: "x".repeat(41), system: "S" }, agent: true }), {
    agent: true,
  });
  assert.deepEqual(checkPreferences("model"), {});
  assert.deepEqual(checkPreferences({ glossary: "x".repeat(100_001) }), {});
});
