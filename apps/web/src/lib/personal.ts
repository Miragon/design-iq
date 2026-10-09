/**
 * What this tab knows about the person's favorites and visits AHEAD of the
 * repository list (#213). GET /api/repos carries `favorite` and
 * `lastOpenedAt`, but a list can be on its way while the person toggles a
 * favorite — the #212 background revalidation that starts with every page
 * load. A plain cache write would be undone when that older answer lands,
 * and cancelling the fetch would leave the page on the stale snapshot. So
 * the toggles live HERE, on top of whatever list lands (useRepos' select),
 * until a list fetched after the server confirmed them makes them
 * redundant. No invalidation after a toggle: nothing about the list but the
 * flag changed.
 *
 * Writes of one repository run one after another — PUT and DELETE are
 * idempotent, so the last toggle is what the server ends with. A failed
 * write falls back to what the server has: the last confirmed write of this
 * tab, else the list's value.
 *
 * Pure (no React, no fetch): the hooks in queries.ts wire it to the API.
 */
import type { FavoriteWire, RepoInfo } from "@designiq/contracts/live-host";

interface FavoriteOverride {
  /** what the row shows */
  favorite: boolean;
  /** the latest toggle — only its outcome may change `favorite` */
  ticket: number;
  /** writes still in flight */
  pending: number;
  /** the last write the server confirmed: its value and when the answer arrived */
  confirmed?: { favorite: boolean; at: number };
}

const key = (fullName: string): string => fullName.toLowerCase();

export class PersonalOverlay {
  private readonly favorites = new Map<string, FavoriteOverride>();
  /** visits made in this tab — lastOpenedAt never goes back */
  private readonly visits = new Map<string, string>();
  /** per repo, the tail of its write chain */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private tickets = 0;
  private readonly now: () => number;
  /** bumps on every change — the select dependency of useRepos */
  version = 0;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /**
   * Show `favorite` at once and write it — after any earlier write of the
   * same repository. Resolves with the server's answer, rejects with the
   * write's error (the row is back on what the server has by then).
   */
  toggle(
    fullName: string,
    favorite: boolean,
    write: (fullName: string, favorite: boolean) => Promise<FavoriteWire>,
  ): Promise<FavoriteWire> {
    const k = key(fullName);
    const ticket = ++this.tickets;
    const entry = this.favorites.get(k) ?? { favorite, ticket, pending: 0 };
    entry.favorite = favorite;
    entry.ticket = ticket;
    entry.pending++;
    this.favorites.set(k, entry);
    this.changed();
    const run = (this.chains.get(k) ?? Promise.resolve()).catch(() => undefined).then(() => write(fullName, favorite));
    this.chains.set(k, run);
    return run.then(
      (answer) => {
        entry.pending--;
        entry.confirmed = { favorite: answer.favorite, at: this.now() };
        if (entry.ticket === ticket) entry.favorite = answer.favorite;
        this.changed();
        return answer;
      },
      (error: unknown) => {
        entry.pending--;
        if (entry.ticket === ticket) {
          // the server still has what it had before this write
          if (entry.confirmed) entry.favorite = entry.confirmed.favorite;
          else if (entry.pending === 0) this.favorites.delete(k);
        }
        this.changed();
        throw error;
      },
    );
  }

  /**
   * A GET /api/repos that was SENT at `startedAt` landed: every toggle the
   * server confirmed before that is part of the answer — drop it. A fetch
   * that started earlier (the stale revalidation) settles nothing.
   */
  settle(startedAt: number): void {
    let dropped = false;
    for (const [k, entry] of this.favorites) {
      if (entry.pending === 0 && entry.confirmed && entry.confirmed.at < startedAt) {
        this.favorites.delete(k);
        dropped = true;
      }
    }
    if (dropped) this.changed();
  }

  /** a visit this tab recorded (PUT /api/me/recent answered with `lastOpenedAt`) */
  visited(fullName: string, lastOpenedAt: string): void {
    const k = key(fullName);
    const known = this.visits.get(k);
    if (known !== undefined && Date.parse(known) >= Date.parse(lastOpenedAt)) return;
    this.visits.set(k, lastOpenedAt);
    this.changed();
  }

  /** the list as the person should see it */
  apply = (list: RepoInfo[]): RepoInfo[] => {
    if (this.favorites.size === 0 && this.visits.size === 0) return list;
    return list.map((r) => {
      const k = key(r.fullName);
      const fav = this.favorites.get(k);
      const visit = this.visits.get(k);
      const newer = visit !== undefined && (!r.lastOpenedAt || Date.parse(visit) > Date.parse(r.lastOpenedAt));
      if (!fav && !newer) return r;
      return { ...r, ...(fav ? { favorite: fav.favorite } : {}), ...(newer ? { lastOpenedAt: visit } : {}) };
    });
  };
}
