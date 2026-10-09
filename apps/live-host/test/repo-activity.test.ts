/**
 * When a repository last changed (#213, src/application/repo-activity.ts) on
 * the real SQLite store: the newer of the last live edit and the default
 * branch's commit time, the provider's push time only for a repository never
 * cloned, nothing without a signal — and a live edit written at most once a
 * minute per repository.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { SqliteActivityStore } from "../src/adapters/sqlite/activity-store.ts";
import { EDIT_THROTTLE_MS, RepoActivity } from "../src/application/repo-activity.ts";

const T0 = Date.parse("2026-10-09T08:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function setup(start = T0) {
  let now = start;
  const store = new SqliteActivityStore(new DatabaseSync(":memory:"));
  const activity = new RepoActivity({ store, now: () => now });
  return { store, activity, tick: (ms: number) => (now += ms) };
}

test("lastChangeAt: the newer of the last live edit and the default branch's commit", () => {
  const { activity } = setup();
  activity.liveEdit("acme/models");
  activity.defaultBranchAt("acme/models", T0 - 3_600_000);
  activity.defaultBranchAt("acme/claims", T0 - 60_000);
  const view = activity.view();
  assert.equal(view.lastChangeAt({ fullName: "ACME/Models" }, true), iso(T0), "case-insensitive");
  assert.equal(view.lastChangeAt({ fullName: "acme/claims" }, true), iso(T0 - 60_000));
});

test("lastChangeAt: the provider's push time stands in ONLY for a repository never cloned", () => {
  const { activity } = setup();
  const pushedAt = T0 - 86_400_000;
  const view = activity.view();
  assert.equal(view.lastChangeAt({ fullName: "acme/new", pushedAt }, false), iso(pushedAt));
  assert.equal(
    view.lastChangeAt({ fullName: "acme/cloned", pushedAt }, true),
    null,
    "a missing time beats a wrong one",
  );
  assert.equal(view.lastChangeAt({ fullName: "acme/new", pushedAt: null }, false), null, "no signal at all");
  activity.defaultBranchAt("acme/new", T0 - 7_200_000);
  assert.equal(
    activity.view().lastChangeAt({ fullName: "acme/new", pushedAt }, false),
    iso(T0 - 7_200_000),
    "a recorded signal always wins over the fallback",
  );
});

test("liveEdit: at most one write per repository per minute", () => {
  const { activity, store, tick } = setup();
  activity.liveEdit("acme/models");
  tick(30_000);
  activity.liveEdit("acme/models");
  activity.liveEdit("acme/claims"); // another repo has its own window
  assert.deepEqual(
    store
      .all()
      .map((r) => [r.repo, r.lastEditAt])
      .sort(),
    [
      ["acme/claims", T0 + 30_000],
      ["acme/models", T0],
    ],
  );
  tick(EDIT_THROTTLE_MS);
  activity.liveEdit("acme/models");
  assert.equal(store.all().find((r) => r.repo === "acme/models")?.lastEditAt, T0 + 30_000 + EDIT_THROTTLE_MS);
});

test("defaultBranchAt: the ref's current tip counts, even when it moved back in time (force push)", () => {
  const { activity, store } = setup();
  activity.defaultBranchAt("acme/models", T0);
  activity.defaultBranchAt("acme/models", T0 - 1_000);
  assert.equal(store.all()[0]?.defaultCommitAt, T0 - 1_000);
  assert.equal(store.all()[0]?.lastEditAt, null, "the edit column stays untouched");
});

test("a failing store never breaks the edit that triggered it", () => {
  const activity = new RepoActivity({
    store: {
      all: () => [],
      recordEdit: () => {
        throw new Error("disk full");
      },
      recordDefaultCommit: () => {
        throw new Error("disk full");
      },
    },
  });
  assert.doesNotThrow(() => activity.liveEdit("acme/models"));
  assert.doesNotThrow(() => activity.defaultBranchAt("acme/models", T0));
});
