/**
 * The start page's list logic (#213) — filter, sort and the sidebar sections,
 * all in the browser over the one GET /api/repos list (no pagination). Pure,
 * so the rules are unit-tested; the overview route only renders them.
 */
import type { RepoInfo } from "@designiq/contracts/live-host";

/** the Show menu — "Type" already means the notation on the repo page */
export type ShowFilter = "all" | "favorites" | "live";
/** the Sort menu — "updated" is the default */
export type SortOrder = "updated" | "name";

/** below this many repositories the sidebar would only repeat the list */
export const SIDEBAR_MIN_REPOS = 6;
/** favorites listed before "Show N more" */
export const SIDEBAR_FAVORITES = 10;
/** recently opened repositories in the sidebar */
export const RECENT_LIMIT = 5;

/** case-insensitive, like the VS Code picker — the server orders by binary collation */
export const byName = (a: RepoInfo, b: RepoInfo): number =>
  a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" });

/** "Find a repository…": a case-insensitive match on owner/name ("acme / claims" works too) */
export function matchesQuery(repo: RepoInfo, query: string): boolean {
  const q = query
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, "/");
  return q === "" || repo.fullName.toLowerCase().includes(q);
}

export function filterRepos(
  list: RepoInfo[],
  opts: {
    query: string;
    show: ShowFilter;
    /** rows un-favorited while Show → Favorites is on: they stay until the
     *  filter changes or the list reloads — a toggle never removes a row */
    kept?: ReadonlySet<string>;
  },
): RepoInfo[] {
  return list.filter((r) => {
    if (!matchesQuery(r, opts.query)) return false;
    if (opts.show === "favorites") return r.favorite === true || (opts.kept?.has(r.fullName) ?? false);
    if (opts.show === "live") return (r.dirtyCount ?? 0) > 0;
    return true;
  });
}

const changedAt = (r: RepoInfo): number => (r.lastChangeAt ? Date.parse(r.lastChangeAt) : Number.NaN);

/** Name: owner/name, case-insensitive. Last updated: newest first, rows
 *  without a timestamp last (by name) — so a host that sends none sorts by name */
export function sortRepos(list: RepoInfo[], sort: SortOrder): RepoInfo[] {
  if (sort === "name") return [...list].sort(byName);
  return [...list].sort((a, b) => {
    const [ta, tb] = [changedAt(a), changedAt(b)];
    if (Number.isNaN(ta) || Number.isNaN(tb)) {
      if (Number.isNaN(ta) !== Number.isNaN(tb)) return Number.isNaN(ta) ? 1 : -1;
      return byName(a, b);
    }
    return tb - ta || byName(a, b);
  });
}

/** the sidebar's Favorites: by name */
export function favoriteRepos(list: RepoInfo[]): RepoInfo[] {
  return list.filter((r) => r.favorite === true).sort(byName);
}

/** the sidebar's Recently opened: newest first, favorites excluded (they have their own section) */
export function recentRepos(list: RepoInfo[], limit = RECENT_LIMIT): RepoInfo[] {
  return list
    .filter((r) => r.favorite !== true && typeof r.lastOpenedAt === "string")
    .sort((a, b) => Date.parse(b.lastOpenedAt as string) - Date.parse(a.lastOpenedAt as string))
    .slice(0, limit);
}

/** does this host know favorites at all? (a 5.1 or older host sends no `favorite`) */
export const supportsFavorites = (list: RepoInfo[]): boolean => list.some((r) => typeof r.favorite === "boolean");
