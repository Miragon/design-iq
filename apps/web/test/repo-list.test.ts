/**
 * The start page's list logic (#213, src/lib/repo-list.ts) and its relative
 * times (src/lib/time-ago.ts): filter by owner/name, Show, the rows kept in
 * view after un-favoriting, Sort by name or last change, and the sidebar's
 * Favorites and Recently opened.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { RepoInfo } from "@designiq/contracts/live-host";

import {
  favoriteRepos,
  filterRepos,
  matchesQuery,
  recentRepos,
  sortRepos,
  supportsFavorites,
} from "../src/lib/repo-list.ts";
import { timeAgo } from "../src/lib/time-ago.ts";

const repo = (fullName: string, over: Partial<RepoInfo> = {}): RepoInfo => {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    fullName,
    owner,
    name,
    defaultBranch: "main",
    avatarUrl: null,
    suspended: false,
    permission: "write",
    processCount: 1,
    decisionCount: 0,
    dirtyCount: 0,
    liveSessions: 0,
    ...over,
  };
};
const names = (list: RepoInfo[]): string[] => list.map((r) => r.fullName);

test("matchesQuery: case-insensitive on owner/name, spaces around the slash tolerated", () => {
  const r = repo("Acme/Order-to-Cash");
  for (const q of ["", "  ", "order", "ACME/ORDER", "acme / order", "to-cash", "me/or"]) {
    assert.ok(matchesQuery(r, q), q);
  }
  for (const q of ["claims", "acme/claims", "order/acme"]) assert.ok(!matchesQuery(r, q), q);
});

test("filterRepos: Show filters All / Favorites / With live changes, combined with the query", () => {
  const list = [
    repo("acme/claims", { favorite: true }),
    repo("acme/orders", { dirtyCount: 2 }),
    repo("globex/ops", { favorite: true, dirtyCount: 1 }),
    repo("globex/hr", { dirtyCount: null }),
  ];
  assert.deepEqual(names(filterRepos(list, { query: "", show: "all" })), names(list));
  assert.deepEqual(names(filterRepos(list, { query: "", show: "favorites" })), ["acme/claims", "globex/ops"]);
  assert.deepEqual(names(filterRepos(list, { query: "", show: "live" })), ["acme/orders", "globex/ops"]);
  assert.deepEqual(names(filterRepos(list, { query: "globex", show: "live" })), ["globex/ops"]);
  assert.deepEqual(names(filterRepos(list, { query: "nothing", show: "all" })), []);
});

test("filterRepos: a row un-favorited under Show → Favorites stays while it is kept", () => {
  const list = [repo("acme/claims", { favorite: false }), repo("acme/orders", { favorite: true })];
  assert.deepEqual(names(filterRepos(list, { query: "", show: "favorites" })), ["acme/orders"]);
  assert.deepEqual(names(filterRepos(list, { query: "", show: "favorites", kept: new Set(["acme/claims"]) })), [
    "acme/claims",
    "acme/orders",
  ]);
});

test("sortRepos: Name is case-insensitive; Last updated is newest first, rows without a time last by name", () => {
  const list = [
    repo("zeta/a", { lastChangeAt: null }),
    repo("Beta/x", { lastChangeAt: "2026-10-01T00:00:00Z" }),
    repo("alpha/x"),
    repo("gamma/x", { lastChangeAt: "2026-10-09T00:00:00Z" }),
    repo("delta/x", { lastChangeAt: "2026-10-01T00:00:00Z" }),
  ];
  assert.deepEqual(names(sortRepos(list, "name")), ["alpha/x", "Beta/x", "delta/x", "gamma/x", "zeta/a"]);
  assert.deepEqual(names(sortRepos(list, "updated")), ["gamma/x", "Beta/x", "delta/x", "alpha/x", "zeta/a"]);
  // a host that sends no lastChangeAt at all: Last updated reads like Name
  const older = list.map(({ lastChangeAt: _, ...r }) => r);
  assert.deepEqual(names(sortRepos(older, "updated")), names(sortRepos(older, "name")));
  assert.deepEqual(names(list)[0], "zeta/a", "sorting copies, never reorders the input");
});

test("favoriteRepos / recentRepos: the sidebar — favorites by name; recent newest first, no favorites, at most 5", () => {
  const list = [
    repo("acme/zeta", { favorite: true }),
    repo("acme/Alpha", { favorite: true, lastOpenedAt: "2026-10-09T09:00:00Z" }),
    ...Array.from({ length: 7 }, (_, i) =>
      repo(`acme/r${i}`, { favorite: false, lastOpenedAt: `2026-10-0${i + 1}T00:00:00Z` }),
    ),
    repo("acme/never", { favorite: false, lastOpenedAt: null }),
  ];
  assert.deepEqual(names(favoriteRepos(list)), ["acme/Alpha", "acme/zeta"]);
  assert.deepEqual(names(recentRepos(list)), ["acme/r6", "acme/r5", "acme/r4", "acme/r3", "acme/r2"]);
});

test("supportsFavorites: only a host that sends the flag gets toggles and the sidebar", () => {
  assert.equal(supportsFavorites([repo("acme/x")]), false);
  assert.equal(supportsFavorites([repo("acme/x", { favorite: false })]), true);
});

test("timeAgo: relative to an injected now; an unparsable time is returned as is", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  assert.equal(timeAgo("2026-10-09T11:56:00Z", now), "4 minutes ago");
  assert.equal(timeAgo("2026-10-09T10:00:00Z", now), "2 hours ago");
  assert.equal(timeAgo("2026-10-08T12:00:00Z", now), "yesterday");
  assert.equal(timeAgo("2026-09-18T12:00:00Z", now), "3 weeks ago");
  assert.equal(timeAgo("2026-10-09T12:00:10Z", now), "this minute");
  assert.equal(timeAgo("not a date", now), "not a date");
});
