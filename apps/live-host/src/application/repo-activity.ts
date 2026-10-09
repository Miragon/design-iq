/**
 * When a repository last changed — the start page's "Updated X ago" and its
 * "Last updated" sort (#213). The same for everyone; the newer of two
 * signals, both recorded where they happen and only READ by listRepos:
 *
 *   last live edit       a real edit in one of the repo's rooms (collab.ts
 *                        onChange — never seeding, awareness, a read, or a
 *                        write of identical text: none of those changes the
 *                        Yjs document). Throttled: at most one write per repo
 *                        per minute, so the stored time may lag by that much.
 *   default-branch time  the committer time of origin/<default branch>,
 *                        recorded wherever that ref moves (clone, fetch, hard
 *                        reset, the host checkout's refresh, the release
 *                        fetch — repos/workspaces.ts, release.ts). A release
 *                        PR therefore counts once it is merged AND fetched.
 *
 * A repository never cloned on the host has neither; it falls back to the
 * provider's last push (repos.pushed_at, stored at registry sync) — which
 * counts pushes to ANY branch, the platform's own release branches included,
 * hence only as a fallback. No signal at all → no timestamp: a missing time
 * beats a wrong one. Both signals are only as fresh as the host's last look:
 * a push from outside the platform shows once the host fetched.
 */
import type { ConnectedRepo } from "../repos/registry.ts";

/** persistence (adapters/sqlite/activity-store.ts) — epoch ms, repo names case-insensitive */
export interface ActivityStore {
  all(): Array<{ repo: string; lastEditAt: number | null; defaultCommitAt: number | null }>;
  recordEdit(repo: string, at: number): void;
  recordDefaultCommit(repo: string, at: number): void;
}

/** a live edit is written at most this often per repository */
export const EDIT_THROTTLE_MS = 60_000;

/** what listRepos reads once per listing */
export interface ActivityView {
  /** ISO 8601, or null without any signal */
  lastChangeAt(repo: Pick<ConnectedRepo, "fullName" | "pushedAt">, cloned: boolean): string | null;
}

export class RepoActivity {
  private readonly store: ActivityStore;
  private readonly now: () => number;
  /** lowercased repo → when its last edit was WRITTEN (the throttle) */
  private readonly written = new Map<string, number>();

  constructor(deps: { store: ActivityStore; now?: () => number }) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
  }

  /** a real edit landed in one of the repo's live rooms */
  liveEdit(repo: string): void {
    const key = repo.toLowerCase();
    const now = this.now();
    if (now - (this.written.get(key) ?? Number.NEGATIVE_INFINITY) < EDIT_THROTTLE_MS) return;
    this.written.set(key, now);
    try {
      this.store.recordEdit(repo, now);
    } catch (e) {
      // a full or read-only disk must not break the edit itself
      console.log(`activity: recording an edit of ${repo} failed (${(e as Error).message.split("\n")[0]})`);
    }
  }

  /** origin/<default branch> now points at a commit made at `committedAt` (epoch ms) */
  defaultBranchAt(repo: string, committedAt: number): void {
    try {
      this.store.recordDefaultCommit(repo, committedAt);
    } catch (e) {
      console.log(`activity: recording ${repo}'s default branch failed (${(e as Error).message.split("\n")[0]})`);
    }
  }

  /** one SQLite read for the whole listing */
  view(): ActivityView {
    const rows = new Map(this.store.all().map((r) => [r.repo.toLowerCase(), r]));
    return {
      lastChangeAt: (repo, cloned) => {
        const row = rows.get(repo.fullName.toLowerCase());
        const known = [row?.lastEditAt, row?.defaultCommitAt].filter((t): t is number => typeof t === "number");
        if (known.length > 0) return new Date(Math.max(...known)).toISOString();
        // the provider's push time stands in only where the host has never looked
        if (!cloned && typeof repo.pushedAt === "number") return new Date(repo.pushedAt).toISOString();
        return null;
      },
    };
  }
}
