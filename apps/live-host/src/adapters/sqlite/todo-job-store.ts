/**
 * Unfinished todo jobs (application/todo-jobs.ts), SQLite-backed in the same
 * live.db as sessions and lineages — so a host restart resumes a rename's
 * todo move instead of leaving half the todos behind. The todos themselves
 * never live here (they are the tracker's); a row is the job, and it is gone
 * once the job finished cleanly.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { TodoModelRef } from "@designiq/contracts/todo-anchor";

import type { TodoJobKind, TodoJobSpec, TodoJobStore } from "../../application/todo-jobs.ts";

export class SqliteTodoJobStore implements TodoJobStore {
  private readonly listState: StatementSync;
  private readonly putState: StatementSync;
  private readonly removeState: StatementSync;

  constructor(db: DatabaseSync) {
    dropPreNotationTable(db);
    // one job per (repo, kind, notation, from)
    db.exec(
      "CREATE TABLE IF NOT EXISTS todo_jobs (repo TEXT NOT NULL, kind TEXT NOT NULL, notation TEXT NOT NULL, " +
        "from_model TEXT NOT NULL, to_model TEXT, to_file TEXT, by_login TEXT NOT NULL, " +
        "PRIMARY KEY (repo, kind, notation, from_model))",
    );
    this.listState = db.prepare("SELECT repo, kind, notation, from_model, to_model, to_file, by_login FROM todo_jobs");
    this.putState = db.prepare(
      "INSERT OR REPLACE INTO todo_jobs (repo, kind, notation, from_model, to_model, to_file, by_login) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.removeState = db.prepare(
      "DELETE FROM todo_jobs WHERE repo = ? AND kind = ? AND notation = ? AND from_model = ?",
    );
  }

  list(): TodoJobSpec[] {
    const rows = this.listState.all() as Array<{
      repo: string;
      kind: string;
      notation: string;
      from_model: string;
      to_model: string | null;
      to_file: string | null;
      by_login: string;
    }>;
    return rows
      .filter((r) => r.kind === "move" || r.kind === "close")
      .map((r) => ({
        repo: r.repo,
        kind: r.kind as TodoJobKind,
        notation: r.notation,
        from: r.from_model,
        ...(r.to_model ? { to: { model: r.to_model, file: r.to_file ?? "" } } : {}),
        by: r.by_login,
      }));
  }

  put(spec: TodoJobSpec): void {
    this.putState.run(
      spec.repo,
      spec.kind,
      spec.notation,
      spec.from,
      spec.to?.model ?? null,
      spec.to?.file ?? null,
      spec.by,
    );
  }

  remove(repo: string, kind: TodoJobKind, from: TodoModelRef): void {
    this.removeState.run(repo, kind, from.notation, from.id);
  }
}

/**
 * A table from before the notations keyed its jobs without one; its jobs
 * look for todos under labels no todo carries any more, so it is dropped,
 * not migrated.
 */
function dropPreNotationTable(db: DatabaseSync): void {
  const cols = (db.prepare("PRAGMA table_info(todo_jobs)").all() as Array<{ name: string }>).map((c) => c.name);
  if (cols.length > 0 && !cols.includes("notation")) db.exec("DROP TABLE todo_jobs");
}
