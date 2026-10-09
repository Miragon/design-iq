/**
 * A person's favorites and recently opened repositories (application/favorites.ts),
 * SQLite-backed in the same live.db as sessions and lineages. Non-credential
 * per-user preferences — the one kind of user-scoped row ADR 0001 (as amended)
 * allows besides the session.
 *
 *   favorites    (user, repo) — repo is the registry's canonical fullName
 *   repo_visits  (user, repo) → the last time the person opened it
 *
 * `user` is `<provider>:<login>` (lowercased), `repo` compares
 * case-insensitively (NOCASE), and provider_id keeps the provider's
 * rename-stable repository id next to the name, so renames, transfers and
 * cross-org favorites (#214) stay solvable later. Deleting one person's rows:
 * docs/on-prem/README.md (Data & backup).
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { FavoritesStore } from "../../application/favorites.ts";

export class SqliteFavoritesStore implements FavoritesStore {
  private readonly favoritesState: StatementSync;
  private readonly isFavoriteState: StatementSync;
  private readonly addFavoriteState: StatementSync;
  private readonly removeFavoriteState: StatementSync;
  private readonly visitsState: StatementSync;
  private readonly putVisitState: StatementSync;
  private readonly pruneOldState: StatementSync;
  private readonly pruneOverflowState: StatementSync;

  constructor(db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS favorites (user TEXT NOT NULL, repo TEXT NOT NULL COLLATE NOCASE, " +
        "provider_id INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY (user, repo))",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS repo_visits (user TEXT NOT NULL, repo TEXT NOT NULL COLLATE NOCASE, " +
        "provider_id INTEGER, opened_at INTEGER NOT NULL, PRIMARY KEY (user, repo))",
    );
    this.favoritesState = db.prepare("SELECT repo FROM favorites WHERE user = ? ORDER BY repo");
    this.isFavoriteState = db.prepare("SELECT 1 FROM favorites WHERE user = ? AND repo = ?");
    this.addFavoriteState = db.prepare(
      "INSERT INTO favorites (user, repo, provider_id, created_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(user, repo) DO UPDATE SET provider_id = COALESCE(excluded.provider_id, favorites.provider_id)",
    );
    this.removeFavoriteState = db.prepare("DELETE FROM favorites WHERE user = ? AND repo = ?");
    this.visitsState = db.prepare("SELECT repo, opened_at FROM repo_visits WHERE user = ? ORDER BY opened_at DESC");
    this.putVisitState = db.prepare(
      "INSERT INTO repo_visits (user, repo, provider_id, opened_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(user, repo) DO UPDATE SET opened_at = excluded.opened_at, " +
        "provider_id = COALESCE(excluded.provider_id, repo_visits.provider_id)",
    );
    this.pruneOldState = db.prepare("DELETE FROM repo_visits WHERE user = ? AND opened_at < ?");
    this.pruneOverflowState = db.prepare(
      "DELETE FROM repo_visits WHERE user = ? AND repo NOT IN " +
        "(SELECT repo FROM repo_visits WHERE user = ? ORDER BY opened_at DESC LIMIT ?)",
    );
  }

  favorites(user: string): string[] {
    return (this.favoritesState.all(user) as Array<{ repo: string }>).map((r) => r.repo);
  }

  isFavorite(user: string, repo: string): boolean {
    return this.isFavoriteState.get(user, repo) !== undefined;
  }

  addFavorite(user: string, repo: string, providerId: number | null, at: number): void {
    this.addFavoriteState.run(user, repo, providerId, at);
  }

  removeFavorite(user: string, repo: string): void {
    this.removeFavoriteState.run(user, repo);
  }

  visits(user: string): Array<{ repo: string; at: number }> {
    return (this.visitsState.all(user) as Array<{ repo: string; opened_at: number }>).map((r) => ({
      repo: r.repo,
      at: r.opened_at,
    }));
  }

  putVisit(user: string, repo: string, providerId: number | null, at: number): void {
    this.putVisitState.run(user, repo, providerId, at);
  }

  pruneVisits(user: string, keep: number, notBefore: number): void {
    this.pruneOldState.run(user, notBefore);
    this.pruneOverflowState.run(user, user, keep);
  }
}
