/**
 * A person's own view of the repository list (#213): the repositories they
 * marked as favorites and the ones they opened last — per user, across
 * sessions and devices, never shared with anyone else.
 *
 *   addFavorite     PUT    /api/me/favorites/:fullName  (session + repo access)
 *   removeFavorite  DELETE /api/me/favorites/:fullName  (session only — a
 *                   favorite can always be removed, connected or not)
 *   recordVisit     PUT    /api/me/recent/:fullName     (session + repo access)
 *   personalView    the favorite flag and lastOpenedAt of every row of
 *                   GET /api/repos — SQLite reads only, never a provider call
 *
 * The rows themselves are NOT filtered here: listRepos (application/overview.ts)
 * stays the one access filter, so a repository the person can no longer
 * access never shows, while its favorite stays stored and returns with the
 * access.
 *
 * The user key is `<provider>:<login>` (lowercased): the session carries no
 * provider user id, and the access check is keyed on the login too — so a
 * favorite and its access check always mean the same person. The provider
 * prefix keeps a LIVE_AUTH=none host's shared principal apart from an IdP
 * login of the same name. Known gaps (accepted): a renamed login loses its
 * favorites and visits; a login later reused by someone else inherits them
 * (still filtered by that person's access).
 */
import type { FavoriteWire, RepoVisitWire } from "@designiq/contracts/live-host";
import { AppError } from "@designiq/http-kit";

import type { Session } from "../adapters/sqlite/sessions.ts";
import type { ConnectedRepo } from "../repos/registry.ts";
import { authorizeRepo, type AuthzDeps } from "./authz.ts";

/** favorites per user, counted over CONNECTED repositories */
export const MAX_FAVORITES = 100;
/** visits kept per user */
export const MAX_VISITS = 20;
/** a visit older than this is forgotten */
export const VISIT_TTL_MS = 90 * 24 * 60 * 60_000;
/** at most one stored visit per user and repository in this window */
export const VISIT_THROTTLE_MS = 60_000;

/** persistence (adapters/sqlite/favorites-store.ts) — repos are the
 *  registry's canonical fullName, compared case-insensitively */
export interface FavoritesStore {
  /** the user's favorite repos */
  favorites(user: string): string[];
  isFavorite(user: string, repo: string): boolean;
  /** idempotent — re-adding keeps the first time */
  addFavorite(user: string, repo: string, providerId: number | null, at: number): void;
  /** idempotent */
  removeFavorite(user: string, repo: string): void;
  /** the user's visits, newest first */
  visits(user: string): Array<{ repo: string; at: number }>;
  /** insert or move the user's visit of `repo` to `at` */
  putVisit(user: string, repo: string, providerId: number | null, at: number): void;
  /** forget the user's visits older than `notBefore`, then all but the newest `keep` */
  pruneVisits(user: string, keep: number, notBefore: number): void;
}

export interface FavoritesDeps extends AuthzDeps {
  registry: AuthzDeps["registry"] & { list(): ConnectedRepo[] };
  favorites: FavoritesStore;
  /** injectable for tests */
  now?: () => number;
}

/** the person behind a session — `<provider>:<login>`, lowercased */
export const userKey = (user: Session["user"]): string => `${user.provider}:${user.login}`.toLowerCase();

/** favorite a repository the session may access — 404/403 like every repo route, 409 past the cap */
export async function addFavorite(deps: FavoritesDeps, session: Session, fullName: string): Promise<FavoriteWire> {
  const repo = await authorizeRepo(deps, session, fullName);
  const user = userKey(session.user);
  if (!deps.favorites.isFavorite(user, repo.fullName)) {
    // the cap counts CONNECTED repositories: a favorite whose repository was
    // disconnected stays stored (it returns with the connection) but must not
    // block new ones
    const connected = new Set(deps.registry.list().map((r) => r.fullName.toLowerCase()));
    const count = deps.favorites.favorites(user).filter((r) => connected.has(r.toLowerCase())).length;
    if (count >= MAX_FAVORITES) {
      throw new AppError(
        "favorites/limit",
        `you already have ${MAX_FAVORITES} favorites — remove one before adding ${repo.fullName}`,
        { status: 409, expose: true },
      );
    }
  }
  deps.favorites.addFavorite(user, repo.fullName, repo.providerId ?? null, (deps.now ?? Date.now)());
  return { fullName: repo.fullName, favorite: true };
}

/** un-favorite — the session is enough: removing never needs access, and a
 *  repository that is gone or no longer accessible must stay removable */
export function removeFavorite(
  deps: Pick<FavoritesDeps, "registry" | "favorites">,
  session: Session,
  fullName: string,
) {
  deps.favorites.removeFavorite(userKey(session.user), fullName);
  return { fullName: deps.registry.get(fullName)?.fullName ?? fullName, favorite: false } satisfies FavoriteWire;
}

/**
 * Record that the person opened a repository (its page or an editor in the
 * web app) — an explicit write per visit, never inferred from reads: the web
 * client refetches its lists after every create or rename, and an agent's
 * MCP calls are not the person opening anything. Repeated visits within a
 * minute keep the stored time; the list stays bounded (MAX_VISITS, VISIT_TTL_MS).
 */
export async function recordVisit(deps: FavoritesDeps, session: Session, fullName: string): Promise<RepoVisitWire> {
  const repo = await authorizeRepo(deps, session, fullName);
  const user = userKey(session.user);
  const now = (deps.now ?? Date.now)();
  const last = deps.favorites.visits(user).find((v) => v.repo.toLowerCase() === repo.fullName.toLowerCase());
  if (last && now - last.at < VISIT_THROTTLE_MS) {
    return { fullName: repo.fullName, lastOpenedAt: new Date(last.at).toISOString() };
  }
  deps.favorites.putVisit(user, repo.fullName, repo.providerId ?? null, now);
  deps.favorites.pruneVisits(user, MAX_VISITS, now - VISIT_TTL_MS);
  return { fullName: repo.fullName, lastOpenedAt: new Date(now).toISOString() };
}

/** the caller's favorites and last visits, keyed by lowercased fullName —
 *  what listRepos stamps on its rows */
export interface PersonalView {
  favorite(fullName: string): boolean;
  /** ISO 8601, or null when not opened within VISIT_TTL_MS */
  lastOpenedAt(fullName: string): string | null;
}

/** two SQLite reads per listing — no git process, no provider call */
export function personalView(
  store: Pick<FavoritesStore, "favorites" | "visits">,
  session: Session,
  now = Date.now(),
): PersonalView {
  const user = userKey(session.user);
  const favorites = new Set(store.favorites(user).map((r) => r.toLowerCase()));
  const visits = new Map<string, number>();
  for (const v of store.visits(user)) {
    // a visit past its TTL is gone even before the next write prunes it
    if (now - v.at <= VISIT_TTL_MS) visits.set(v.repo.toLowerCase(), v.at);
  }
  return {
    favorite: (fullName) => favorites.has(fullName.toLowerCase()),
    lastOpenedAt: (fullName) => {
      const at = visits.get(fullName.toLowerCase());
      return at === undefined ? null : new Date(at).toISOString();
    },
  };
}
