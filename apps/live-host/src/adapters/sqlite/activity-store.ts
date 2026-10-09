/**
 * When each repository last changed (application/repo-activity.ts), in the
 * same live.db: the last live edit and the committer time of
 * origin/<default branch>, epoch ms. One row per repository, the same for
 * every user — no personal data.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { ActivityStore } from "../../application/repo-activity.ts";

export class SqliteActivityStore implements ActivityStore {
  private readonly allState: StatementSync;
  private readonly editState: StatementSync;
  private readonly commitState: StatementSync;

  constructor(db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS repo_activity (repo TEXT PRIMARY KEY COLLATE NOCASE, " +
        "last_edit_at INTEGER, default_commit_at INTEGER)",
    );
    this.allState = db.prepare("SELECT repo, last_edit_at, default_commit_at FROM repo_activity");
    this.editState = db.prepare(
      "INSERT INTO repo_activity (repo, last_edit_at) VALUES (?, ?) " +
        "ON CONFLICT(repo) DO UPDATE SET last_edit_at = excluded.last_edit_at",
    );
    this.commitState = db.prepare(
      "INSERT INTO repo_activity (repo, default_commit_at) VALUES (?, ?) " +
        "ON CONFLICT(repo) DO UPDATE SET default_commit_at = excluded.default_commit_at",
    );
  }

  all(): Array<{ repo: string; lastEditAt: number | null; defaultCommitAt: number | null }> {
    const rows = this.allState.all() as Array<{
      repo: string;
      last_edit_at: number | null;
      default_commit_at: number | null;
    }>;
    return rows.map((r) => ({ repo: r.repo, lastEditAt: r.last_edit_at, defaultCommitAt: r.default_commit_at }));
  }

  recordEdit(repo: string, at: number): void {
    this.editState.run(repo, at);
  }

  recordDefaultCommit(repo: string, at: number): void {
    this.commitState.run(repo, at);
  }
}
