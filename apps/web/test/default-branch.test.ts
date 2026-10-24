/**
 * The default-branch lookup of a document's GitHub links
 * (src/lib/default-branch.ts): an editor reads the branch from the
 * repository list at hand and never refreshes the list merely by opening, as
 * the overview does; it loads a list only when there is none. Driven through
 * a real QueryClient with the app's 30 s staleTime.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { RepoInfo } from "@designiq/contracts/live-host";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { defaultBranchLookup } from "../src/lib/default-branch.ts";

const repo = (fullName: string, defaultBranch: string): RepoInfo => {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    fullName,
    owner,
    name,
    defaultBranch,
    avatarUrl: null,
    suspended: false,
    permission: "write",
    processCount: 1,
    decisionCount: 0,
    dirtyCount: 0,
    liveSessions: 0,
    favorite: false,
    lastOpenedAt: null,
  };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

/** an editor's lookup against the ["repos"] query, counting the list's loads */
function editorLookup(qc: QueryClient, fullName: string) {
  const loads = { count: 0 };
  const observer = new QueryObserver(qc, {
    queryKey: ["repos"],
    queryFn: async () => {
      loads.count++;
      return [repo("acme/models", "main")];
    },
    ...defaultBranchLookup(fullName),
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return { loads, observer, unsubscribe };
}

test("an editor reads the default branch from the list at hand, an old one included, and loads none", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  // the last visit's snapshot, dated 0 as useRepos seeds it: stale for the overview
  qc.setQueryData(["repos"], [repo("Acme/Models", "trunk"), repo("acme/other", "main")], { updatedAt: 0 });
  const first = editorLookup(qc, "acme/models");
  const second = editorLookup(qc, "acme/models");
  try {
    await flush();
    assert.equal(first.observer.getCurrentResult().data, "trunk", "the name matches in any case");
    assert.equal(first.loads.count + second.loads.count, 0, "no editor that opens loads the list");
  } finally {
    first.unsubscribe();
    second.unsubscribe();
    qc.clear();
  }
});

test("without a list at hand an editor loads one, once; a repository the list lacks has no branch", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  const first = editorLookup(qc, "acme/models");
  try {
    await flush();
    assert.equal(first.loads.count, 1);
    assert.equal(first.observer.getCurrentResult().data, "main");
    const other = editorLookup(qc, "acme/unknown");
    await flush();
    assert.equal(other.loads.count, 0);
    assert.equal(other.observer.getCurrentResult().data, undefined);
    other.unsubscribe();
  } finally {
    first.unsubscribe();
    qc.clear();
  }
});
