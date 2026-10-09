/**
 * The favorites/visits overlay (#213, src/lib/personal.ts): a toggle shows at
 * once, survives an OLDER list landing (the #212 background revalidation),
 * and leaves once a list fetched after the server confirmed it carries it.
 * Writes of one repository run in order; a refused write falls back to what
 * the server has. Driven through a real QueryClient where it matters.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { FavoriteWire, RepoInfo } from "@designiq/contracts/live-host";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { PersonalOverlay } from "../src/lib/personal.ts";

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
    favorite: false,
    lastOpenedAt: null,
    ...over,
  };
};

/** a write the test resolves or rejects by hand */
function deferredWrites() {
  const calls: Array<{ fullName: string; favorite: boolean; resolve: () => void; reject: (e: Error) => void }> = [];
  const write = (fullName: string, favorite: boolean) =>
    new Promise<FavoriteWire>((resolve, reject) => {
      calls.push({ fullName, favorite, resolve: () => resolve({ fullName, favorite }), reject });
    });
  return { calls, write };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("a toggle made while the list revalidates keeps its state when the (older) list lands", async () => {
  let clock = 1_000;
  const overlay = new PersonalOverlay(() => clock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // the snapshot on screen: not a favorite
  qc.setQueryData(["repos"], [repo("acme/claims")]);
  let release: (list: RepoInfo[]) => void = () => undefined;
  let startedAt = 0;
  // like useRepos: a NEW select per overlay version — TanStack re-runs select
  // exactly then (structural sharing keeps an equal list's reference, so a
  // stable select would never see the toggle)
  const options = () => ({
    queryKey: ["repos"],
    queryFn: () => {
      startedAt = clock;
      return new Promise<RepoInfo[]>((resolve) => (release = resolve));
    },
    staleTime: Number.POSITIVE_INFINITY,
    select: (list: RepoInfo[]) => overlay.apply(list),
  });
  const observer = new QueryObserver(qc, options());
  const stopFollowing = overlay.subscribe(() => observer.setOptions(options()));
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    // the background revalidation starts (delayed) …
    const revalidation = observer.refetch();
    clock += 100;
    // … the person toggles meanwhile, the server confirms
    const written = overlay.toggle("acme/claims", true, async (fullName, favorite) => ({ fullName, favorite }));
    assert.equal(overlay.apply(qc.getQueryData<RepoInfo[]>(["repos"]) ?? [])[0]?.favorite, true, "optimistic");
    await written;
    clock += 100;
    // … and only now the revalidation's answer lands — read before the PUT
    release([repo("acme/claims", { favorite: false })]);
    await revalidation;
    overlay.settle(startedAt);
    assert.equal(observer.getCurrentResult().data?.[0]?.favorite, true, "the toggle survived the stale list");

    // a fetch sent AFTER the confirmation carries the favorite — the override goes
    const next = observer.refetch();
    clock += 100;
    release([repo("acme/claims", { favorite: true })]);
    await next;
    overlay.settle(startedAt);
    assert.equal(overlay.apply([repo("acme/claims", { favorite: false })])[0]?.favorite, false, "nothing left over");
    assert.equal(observer.getCurrentResult().data?.[0]?.favorite, true);
  } finally {
    unsubscribe();
    stopFollowing();
    qc.clear();
  }
});

test("writes of one repository run in order — the last toggle is what the server ends with", async () => {
  const overlay = new PersonalOverlay();
  const { calls, write } = deferredWrites();
  const on = overlay.toggle("acme/claims", true, write);
  const off = overlay.toggle("acme/claims", false, write);
  await flush();
  assert.equal(calls.length, 1, "the DELETE waits for the PUT");
  assert.equal(overlay.apply([repo("acme/claims")])[0]?.favorite, false, "the row shows the last click");
  calls[0]?.resolve();
  await on;
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.favorite),
    [true, false],
  );
  assert.equal(
    overlay.apply([repo("acme/claims")])[0]?.favorite,
    false,
    "an earlier answer never overrides a later click",
  );
  calls[1]?.resolve();
  await off;
  // another repository is not held up by this one
  const other = overlay.toggle("acme/orders", true, write);
  await flush();
  assert.equal(calls.length, 3);
  calls[2]?.resolve();
  await other;
});

test("a refused write rolls back to what the server has", async () => {
  const overlay = new PersonalOverlay();
  const { calls, write } = deferredWrites();
  const listed = [repo("acme/claims", { favorite: false })];

  // nothing confirmed before: back to the list's value
  const refused = overlay.toggle("acme/claims", true, write);
  await flush();
  calls[0]?.reject(new Error("you already have 100 favorites"));
  await assert.rejects(refused, /100 favorites/);
  assert.equal(overlay.apply(listed)[0]?.favorite, false);

  // confirmed on, then a refused off: the server still has it on
  const on = overlay.toggle("acme/claims", true, write);
  await flush();
  calls[1]?.resolve();
  await on;
  const off = overlay.toggle("acme/claims", false, write);
  await flush();
  calls[2]?.reject(new Error("network down"));
  await assert.rejects(off);
  assert.equal(overlay.apply(listed)[0]?.favorite, true, "the list is stale — the confirmed write wins");
});

test("visits: lastOpenedAt only moves forward, and the list's newer value wins", () => {
  const overlay = new PersonalOverlay();
  let changes = 0;
  overlay.subscribe(() => changes++);
  overlay.visited("acme/claims", "2026-10-09T10:00:00.000Z");
  overlay.visited("ACME/claims", "2026-10-09T09:00:00.000Z"); // older — ignored
  assert.equal(changes, 1);
  const [stale, fresher] = overlay.apply([
    repo("acme/claims", { lastOpenedAt: "2026-10-01T00:00:00.000Z" }),
    repo("acme/orders", { lastOpenedAt: "2026-10-09T11:00:00.000Z" }),
  ]);
  assert.equal(stale?.lastOpenedAt, "2026-10-09T10:00:00.000Z");
  assert.equal(fresher?.lastOpenedAt, "2026-10-09T11:00:00.000Z");
  const untouched = [repo("acme/x")];
  assert.equal(new PersonalOverlay().apply(untouched), untouched, "an empty overlay returns the list itself");
});
