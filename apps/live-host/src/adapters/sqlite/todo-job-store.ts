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

/** one job per (repo, kind, notation, from) — `from_process` and
 *  `to_process` hold model ids of every notation, under their old names */
const COLUMNS =
  "(repo TEXT NOT NULL, kind TEXT NOT NULL, notation TEXT NOT NULL DEFAULT 'bpmn', from_process TEXT NOT NULL, " +
  "to_process TEXT, to_file TEXT, by_login TEXT NOT NULL, PRIMARY KEY (repo, kind, notation, from_process))";

export class SqliteTodoJobStore implements TodoJobStore {
  private readonly listState: StatementSync;
  private readonly putState: StatementSync;
  private readonly removeState: StatementSync;

  constructor(db: DatabaseSync) {
    migrateToNotations(db);
    db.exec(`CREATE TABLE IF NOT EXISTS todo_jobs ${COLUMNS}`);
    this.listState = db.prepare(
      "SELECT repo, kind, notation, from_process, to_process, to_file, by_login FROM todo_jobs",
    );
    this.putState = db.prepare(
      "INSERT OR REPLACE INTO todo_jobs (repo, kind, notation, from_process, to_process, to_file, by_login) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.removeState = db.prepare(
      "DELETE FROM todo_jobs WHERE repo = ? AND kind = ? AND notation = ? AND from_process = ?",
    );
  }

  list(): TodoJobSpec[] {
    const rows = this.listState.all() as Array<{
      repo: string;
      kind: string;
      notation: string;
      from_process: string;
      to_process: string | null;
      to_file: string | null;
      by_login: string;
    }>;
    return rows
      .filter((r) => r.kind === "move" || r.kind === "close")
      .map((r) => ({
        repo: r.repo,
        kind: r.kind as TodoJobKind,
        notation: r.notation,
        from: r.from_process,
        ...(r.to_process ? { to: { model: r.to_process, file: r.to_file ?? "" } } : {}),
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
 * Jobs before #275 were all process jobs, keyed without a notation: a table
 * of that time is rebuilt with the column in its key, its rows as BPMN jobs
 * (a primary key cannot be altered in place).
 */
function migrateToNotations(db: DatabaseSync): void {
  const cols = (db.prepare("PRAGMA table_info(todo_jobs)").all() as Array<{ name: string }>).map((c) => c.name);
  if (cols.length === 0 || cols.includes("notation")) return;
  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE todo_jobs RENAME TO todo_jobs_before_notations");
    db.exec(`CREATE TABLE todo_jobs ${COLUMNS}`);
    db.exec(
      "INSERT INTO todo_jobs (repo, kind, notation, from_process, to_process, to_file, by_login) " +
        "SELECT repo, kind, 'bpmn', from_process, to_process, to_file, by_login FROM todo_jobs_before_notations",
    );
    db.exec("DROP TABLE todo_jobs_before_notations");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
