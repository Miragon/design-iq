/**
 * The open repository's default branch, for a document's links to it on
 * GitHub (EditorContext.repoWeb): a link names a branch, and designIQ shows
 * only the default branch's workspace.
 *
 * It comes from the repository list (GET /api/repos), the overview's read
 * model: for every repository the person can see, the host checks the
 * permission, walks the models and asks git for the changed files. The
 * overview keeps that list fresh. An editor reads the branch from whatever
 * list is at hand, the last visit's snapshot included, and loads one only
 * when there is none, never merely because it opened: a default branch
 * rarely changes. Node-tested through a QueryClient
 * (test/default-branch.test.ts).
 */
import type { RepoInfo } from "@designiq/contracts/live-host";

/** an editor's options on top of the ["repos"] query: the list at hand
 *  never counts as stale, and only the repository's default branch is read */
export function defaultBranchLookup(repo: string): {
  staleTime: number;
  select: (repos: RepoInfo[]) => string | undefined;
} {
  const fullName = repo.toLowerCase();
  return {
    staleTime: Number.POSITIVE_INFINITY,
    select: (repos) => repos.find((r) => r.fullName.toLowerCase() === fullName)?.defaultBranch,
  };
}
