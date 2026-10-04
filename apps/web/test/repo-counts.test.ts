/**
 * The overview card's count line (src/lib/repo-counts.ts): the models of
 * every notation with a per-notation breakdown for the hover title, named
 * with the registry nouns — and the process/decision line of an older host
 * that does not send modelCount yet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { NOTATIONS } from "@designiq/notations";

import { modelBreakdown, notationCount, repoCountsLine } from "../src/lib/repo-counts.ts";

test("notationCount: the registry noun, counted and qualified by its notation", () => {
  assert.equal(notationCount("bpmn", 2), "2 BPMN processes", "the label's version is dropped");
  assert.equal(notationCount("bpmn", 1), "1 BPMN process");
  assert.equal(notationCount("dmn", 1), "1 DMN decision");
  assert.equal(
    notationCount("event-storming", 1),
    "1 Event Storming board",
    "a noun naming its notation is not doubled",
  );
  assert.equal(notationCount("event-storming", 3), "3 Event Storming boards");
  assert.equal(notationCount("wardley", 2), "2 Wardley Maps");
  assert.equal(notationCount("team-topology", 1), "1 Team Topology");
  assert.equal(notationCount("markdown", 3), "3 Markdown documents");
  assert.equal(notationCount("archimate", 2), "2 archimate models", "an id from a newer host still counts");
});

test("notationCount: every registered notation reads as count + words, never a doubled name", () => {
  for (const n of NOTATIONS) {
    for (const count of [1, 2]) {
      const label = notationCount(n.id, count);
      assert.match(label, new RegExp(`^${count} \\S`), label);
      const words = label.toLowerCase().split(" ");
      assert.equal(new Set(words).size, words.length, `no repeated word in '${label}'`);
    }
  }
});

test("modelBreakdown: registry order whatever the wire order, empty and unknown entries handled", () => {
  assert.equal(
    modelBreakdown({ "event-storming": 1, dmn: 1, bpmn: 2 }),
    "2 BPMN processes · 1 DMN decision · 1 Event Storming board",
  );
  assert.equal(modelBreakdown({ archimate: 1, bpmn: 1, wardley: 0 }), "1 BPMN process · 1 archimate model");
  assert.equal(modelBreakdown({}), "");
});

test("repoCountsLine: a current host — the models of every notation, the breakdown on hover", () => {
  assert.deepEqual(
    repoCountsLine({
      processCount: 2,
      decisionCount: 1,
      modelCount: 4,
      modelCounts: { bpmn: 2, dmn: 1, "event-storming": 1 },
    }),
    { summary: "4 models", breakdown: "2 BPMN processes · 1 DMN decision · 1 Event Storming board" },
  );
  assert.deepEqual(repoCountsLine({ processCount: 0, decisionCount: 0, modelCount: 1, modelCounts: { markdown: 1 } }), {
    summary: "1 model",
    breakdown: "1 Markdown document",
  });
  assert.deepEqual(
    repoCountsLine({ processCount: 0, decisionCount: 0, modelCount: 0, modelCounts: {} }),
    { summary: "0 models" },
    "no breakdown to hover when there is nothing to break down",
  );
});

test("repoCountsLine: not opened on the host yet — no counts at all", () => {
  assert.deepEqual(repoCountsLine({ processCount: null, decisionCount: null, modelCount: null, modelCounts: null }), {
    summary: "not loaded yet",
  });
  assert.deepEqual(repoCountsLine({ processCount: null, decisionCount: null }), { summary: "not loaded yet" });
});

test("repoCountsLine: an older host without modelCount falls back to the process/decision line", () => {
  assert.deepEqual(repoCountsLine({ processCount: 2, decisionCount: 1 }), { summary: "2 processes · 1 decision" });
  assert.deepEqual(repoCountsLine({ processCount: 1, decisionCount: 0 }), { summary: "1 process" });
  // a pre-3.4 host does not send decisionCount either
  assert.deepEqual(repoCountsLine({ processCount: 3 } as Parameters<typeof repoCountsLine>[0]), {
    summary: "3 processes",
  });
});
