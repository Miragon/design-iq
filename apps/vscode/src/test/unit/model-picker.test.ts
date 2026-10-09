import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelInfo, RepoInfo } from "@designiq/contracts/live-host";

import { modelItems, modelUri, repoItems } from "../../model-picker.ts";

const repo = (over: Partial<RepoInfo>): RepoInfo => ({
  fullName: "acme/models",
  owner: "acme",
  name: "models",
  defaultBranch: "main",
  avatarUrl: null,
  suspended: false,
  permission: "write",
  processCount: 3,
  decisionCount: 1,
  dirtyCount: 0,
  liveSessions: 0,
  ...over,
});
const model = (over: Partial<ModelInfo>): ModelInfo => ({
  repo: "acme/models",
  id: "order",
  name: "order",
  path: "processes/order.bpmn",
  notation: "bpmn",
  folder: "",
  dirty: false,
  liveSessions: 0,
  ...over,
});

test("repoItems: writable, non-suspended repos by name", () => {
  const items = repoItems([
    repo({ fullName: "zeta/models" }),
    repo({ fullName: "acme/models" }),
    repo({ fullName: "acme/readonly", permission: "none" }),
    repo({ fullName: "acme/suspended", suspended: true }),
    repo({ fullName: "acme/uncloned", processCount: null, decisionCount: null }),
  ]);
  assert.deepEqual(
    items.map((i) => i.value.fullName),
    ["acme/models", "acme/uncloned", "zeta/models"],
  );
  assert.equal(items[0]?.label, "$(repo) acme/models");
});

test("repoItems: the person's favorites first (starred), then the rest — each group by name (#213)", () => {
  const items = repoItems([
    repo({ fullName: "zeta/models", favorite: true }),
    repo({ fullName: "acme/models", favorite: false }),
    repo({ fullName: "beta/models", favorite: true }),
    repo({ fullName: "acme/other", favorite: false }),
  ]);
  assert.deepEqual(
    items.map((i) => i.value.fullName),
    ["beta/models", "zeta/models", "acme/models", "acme/other"],
  );
  assert.equal(items[0]?.label, "$(star-full) beta/models");
  assert.equal(items[2]?.label, "$(repo) acme/models");
  // a host that sends no favorite: today's order, today's icon
  assert.deepEqual(
    repoItems([repo({ fullName: "zeta/models" }), repo({ fullName: "acme/models" })]).map((i) => i.label),
    ["$(repo) acme/models", "$(repo) zeta/models"],
  );
});

test("repoItems: a current host — the models of every notation, the per-notation breakdown as the detail", () => {
  const [models, single, empty, uncloned] = repoItems([
    repo({
      fullName: "a/models",
      liveSessions: 2,
      modelCount: 4,
      modelCounts: { bpmn: 2, dmn: 1, "event-storming": 1 },
    }),
    repo({ fullName: "b/single", processCount: 0, decisionCount: 0, modelCount: 1, modelCounts: { markdown: 1 } }),
    repo({ fullName: "c/empty", processCount: 0, decisionCount: 0, modelCount: 0, modelCounts: {} }),
    repo({ fullName: "d/uncloned", processCount: null, decisionCount: null, modelCount: null, modelCounts: null }),
  ]);
  assert.equal(models?.description, "4 models · 2 live");
  assert.equal(models?.detail, "2 BPMN processes · 1 DMN decision · 1 Event Storming board");
  assert.equal(single?.description, "1 model");
  assert.equal(single?.detail, "1 Markdown document");
  assert.equal(empty?.description, "0 models");
  assert.equal(empty?.detail, undefined, "no breakdown when there is nothing to break down");
  assert.equal(uncloned?.description, "not loaded yet", "no counts before the workspace exists");
  assert.equal(uncloned?.detail, undefined);
});

test("repoItems: an older host without modelCount — the process/decision line, pluralized", () => {
  const [both, oneProcess] = repoItems([
    repo({ fullName: "a/both", liveSessions: 2 }),
    repo({ fullName: "b/one", processCount: 1, decisionCount: 0 }),
  ]);
  assert.equal(both?.description, "3 processes · 1 decision · 2 live");
  assert.equal(both?.detail, undefined);
  assert.equal(oneProcess?.description, "1 process");
  assert.equal(oneProcess?.detail, undefined);
});

test("modelItems: folder then name; description carries notation, folder, live peers, dirty", () => {
  const items = modelItems([
    model({ name: "zeta", path: "processes/zeta.dmn", notation: "dmn" }),
    model({
      name: "sub",
      path: "processes/subprocesses/sub.bpmn",
      folder: "subprocesses",
      liveSessions: 1,
      dirty: true,
    }),
    model({ name: "alpha", path: "processes/alpha.bpmn" }),
  ]);
  assert.deepEqual(
    items.map((i) => i.value.name),
    ["alpha", "zeta", "sub"],
  );
  assert.equal(items[0]?.description, "bpmn");
  assert.equal(items[0]?.detail, "processes/alpha.bpmn");
  assert.equal(items[2]?.description, "bpmn · subprocesses · 1 live · unreleased changes");
});

test("modelUri: the path is the room name", () => {
  assert.equal(modelUri("acme/models", "processes/order.bpmn"), "designiq:/acme/models/processes/order.bpmn");
});
