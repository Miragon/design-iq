import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cleanLabel,
  DEFAULT_LABELS,
  fileName,
  formatLine,
  headerLine,
  transcriptPage,
} from "../src/core/transcript.ts";

// local time, so the expectations hold in every time zone
const at = new Date(2026, 10, 21, 14, 32, 7).getTime();

test("a line is time, speaker, text", () => {
  assert.equal(
    formatLine({ channel: "mic", startedAt: at, text: "we start with the order process" }, DEFAULT_LABELS),
    "14:32:07 Me: we start with the order process",
  );
  assert.equal(
    formatLine({ channel: "system", startedAt: at, text: "fine" }, { mic: "Anna", system: "Room" }),
    "14:32:07 Room: fine",
  );
});

test("an utterance is always one line", () => {
  assert.equal(
    formatLine({ channel: "mic", startedAt: at, text: "  first\nsecond \t third " }, DEFAULT_LABELS),
    "14:32:07 Me: first second third",
  );
});

test("an utterance without text is no line", () => {
  assert.equal(formatLine({ channel: "mic", startedAt: at, text: " \n " }, DEFAULT_LABELS), null);
});

test("a label never holds the colon a reader splits at", () => {
  assert.equal(cleanLabel("Anna: Sales\n", "Me"), "Anna Sales");
  assert.equal(cleanLabel("  ", "Me"), "Me");
  assert.equal(
    formatLine({ channel: "mic", startedAt: at, text: "hello" }, { mic: " : ", system: "Others" }),
    "14:32:07 Me: hello",
  );
});

test("header and file name carry the start to the minute", () => {
  assert.equal(headerLine(at), "# Beluga transcript, started 2026-11-21 14:32");
  assert.equal(fileName(at), "beluga-2026-11-21-1432.txt");
});

test("a second session in the same minute gets a file of its own", () => {
  assert.equal(fileName(at, 2), "beluga-2026-11-21-1432-2.txt");
});

const file = "# Beluga transcript, started 2026-11-21 14:30\n14:30:05 Me: eins\n14:30:09 Me: zwei\n14:30:12 Oth";

test("a page of the transcript: complete lines after the one asked for", () => {
  assert.deepEqual(transcriptPage(file, 0, 200), {
    lines: [
      { line: 1, text: "# Beluga transcript, started 2026-11-21 14:30" },
      { line: 2, text: "14:30:05 Me: eins" },
      { line: 3, text: "14:30:09 Me: zwei" },
    ],
    through: 3,
    more: false,
  });
  assert.deepEqual(transcriptPage(file, 1, 1), {
    lines: [{ line: 2, text: "14:30:05 Me: eins" }],
    through: 2,
    more: true,
  });
});

test("nothing new is an empty page that keeps the place", () => {
  assert.deepEqual(transcriptPage(file, 3, 200), { lines: [], through: 3, more: false });
  assert.deepEqual(transcriptPage("", 0, 200), { lines: [], through: 0, more: false });
});
