/**
 * The start page (#213): the connected repositories as a GitHub-style list —
 * one row per repository, filtered and sorted in the browser — with the
 * person's favorites and recently opened repositories one click away.
 *
 * Every entry (row, Favorites, Recently opened) is a plain link to the
 * repository, so cmd/middle-click opens a tab; the favorite toggle sits next
 * to a row's link, never inside it. Toggling never moves or removes a row.
 * Filter, Show and Sort live in the URL (?q, ?show, ?sort), so Back from a
 * repository returns to the same list.
 */
import { Avatar, AvatarFallback, AvatarImage } from "@designiq/ui-kit/components/avatar";
import { Badge } from "@designiq/ui-kit/components/badge";
import { Button, focusRing } from "@designiq/ui-kit/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@designiq/ui-kit/components/dropdown-menu";
import { Input } from "@designiq/ui-kit/components/input";
import { Skeleton } from "@designiq/ui-kit/components/skeleton";
import { cn } from "@designiq/ui-kit/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ChevronDown, Copy, GitBranch, Loader2, Plus, RefreshCw, Search, Star, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { FavoriteToggle } from "@/components/favorite-toggle";
import { ModelCounts } from "@/components/model-counts";
import { ApiError, type RepoInfo } from "@/lib/api";
import { openInstallPicker } from "@/lib/install-picker";
import { loadRepos, useConfig, useRepos } from "@/lib/queries";
import {
  favoriteRepos,
  filterRepos,
  recentRepos,
  type ShowFilter,
  SIDEBAR_FAVORITES,
  SIDEBAR_MIN_REPOS,
  type SortOrder,
  sortRepos,
  supportsFavorites,
} from "@/lib/repo-list";
import { absoluteTime, timeAgo } from "@/lib/time-ago";

const route = getRouteApi("/");

const SHOW_LABELS: Record<ShowFilter, string> = {
  all: "All",
  favorites: "Favorites",
  live: "With live changes",
};
const SORT_LABELS: Record<SortOrder, string> = { updated: "Last updated", name: "Name" };

export function Overview() {
  const qc = useQueryClient();
  const repos = useRepos();
  const cfg = useConfig();
  const installUrl = cfg.data?.installUrl ?? null;
  const mcpUrl = cfg.data?.mcpUrl ?? null;
  const [refreshing, setRefreshing] = useState(false);
  const { q = "", show = "all", sort = "updated" } = route.useSearch();
  const navigate = route.useNavigate();
  const setSearch = (next: { q?: string; show?: ShowFilter; sort?: SortOrder }) =>
    void navigate({
      search: (prev) => {
        const merged = { ...prev, ...next };
        // defaults stay out of the URL
        return {
          ...(merged.q ? { q: merged.q } : {}),
          ...(merged.show && merged.show !== "all" ? { show: merged.show } : {}),
          ...(merged.sort && merged.sort !== "updated" ? { sort: merged.sort } : {}),
        };
      },
      replace: true,
    });

  const copyMcpUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("MCP server URL copied", { description: url });
    } catch {
      // clipboard needs a secure context (https/localhost) — show the URL to copy by hand
      toast.info("MCP server URL", { description: url, duration: 15_000 });
    }
  };

  // force a registry re-sync from the provider, then update the cache
  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await loadRepos(true);
      // a background revalidation still in flight must not land AFTER this
      // forced result and overwrite it with the pre-sync list
      await qc.cancelQueries({ queryKey: ["repos"] });
      qc.setQueryData<RepoInfo[]>(["repos"], fresh);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        void qc.invalidateQueries({ queryKey: ["me"] }); // session gone → flip to login
        return;
      }
      toast.error(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  // returned from the provider's install picker via the same-tab fallback (popup
  // blocked): the server redirects to /?connected=1 → force a fresh sync so the
  // just-added repo shows even if the anonymous webhook-driven sync was coalesced away.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("connected")) return;
    url.searchParams.delete("connected");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // a failed load or background revalidation is never silent; an expired
  // session flips to the login instead. One toast per failure — an error the
  // cache still holds from before this visit is not announced again.
  const reportedErrorAt = useRef(repos.errorUpdatedAt);
  useEffect(() => {
    const e = repos.error;
    if (!e || repos.errorUpdatedAt <= reportedErrorAt.current) return;
    reportedErrorAt.current = repos.errorUpdatedAt;
    if (e instanceof ApiError && e.status === 401) {
      void qc.invalidateQueries({ queryKey: ["me"] });
      return;
    }
    toast.error("Could not update the repository list", { description: e.message });
  }, [repos.error, repos.errorUpdatedAt, qc]);

  const list = useMemo(() => repos.data ?? [], [repos.data]);
  // the list on screen is the last known one while the background refresh runs (#212)
  const updating = repos.isFetching && !repos.isPending;
  const favorites = supportsFavorites(list);
  const sidebar = list.length >= SIDEBAR_MIN_REPOS && favorites;

  // a row un-favorited under Show → Favorites stays in view until the filter
  // changes or the list reloads — toggling never removes a row
  const keptKey = `${show}\n${q}\n${repos.dataUpdatedAt}`;
  const [kept, setKept] = useState<{ key: string; names: ReadonlySet<string> }>({ key: "", names: new Set() });
  const keptNames = kept.key === keptKey ? kept.names : undefined;
  const keepInView = (fullName: string) =>
    setKept((prev) => ({ key: keptKey, names: new Set([...(prev.key === keptKey ? prev.names : []), fullName]) }));

  const visible = useMemo(
    () => sortRepos(filterRepos(list, { query: q, show, kept: keptNames }), sort),
    [list, q, show, keptNames, sort],
  );

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {installUrl && (
        <Button size="sm" onClick={() => openInstallPicker(installUrl, refresh)}>
          <Plus /> Add repository
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={refreshing}
        onClick={refresh}
        title="Reload the connected repositories"
      >
        <RefreshCw className={refreshing ? "animate-spin motion-reduce:animate-none" : ""} /> Refresh
      </Button>
      {mcpUrl && (
        <Button
          variant="outline"
          size="sm"
          title="Copy the MCP server URL — connect Claude or another AI client"
          onClick={() => copyMcpUrl(mcpUrl)}
        >
          <Copy /> MCP
        </Button>
      )}
    </div>
  );

  const body = repos.isLoading ? (
    <RepoRowSkeletons />
  ) : repos.isError && !repos.data ? (
    <p className="text-muted-foreground max-w-prose text-sm">
      The repository list could not be loaded — try <strong>Refresh</strong>.
    </p>
  ) : list.length === 0 ? (
    <p className="text-muted-foreground max-w-prose text-sm">
      No repositories for your account yet. Use <strong>Add repository</strong> to install the app on one or more
      repositories that hold your models
      {installUrl ? "" : " (install URL not configured)"} — then <strong>Refresh</strong>.
    </p>
  ) : (
    <>
      <RepoToolbar
        query={q}
        show={show}
        sort={sort}
        favorites={favorites}
        onQuery={(next) => setSearch({ q: next })}
        onShow={(next) => setSearch({ show: next })}
        onSort={(next) => setSearch({ sort: next })}
      />
      {visible.length === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-10 text-center">
          <p className="font-medium">No repositories match</p>
          <p className="text-muted-foreground mt-1 text-sm">
            {q ? <>Nothing named like “{q}”</> : "Nothing"}
            {show !== "all" ? <> under {SHOW_LABELS[show]}</> : null}.
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => setSearch({ q: "", show: "all" })}>
            Clear filters
          </Button>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Repositories">
          {visible.map((r) => (
            <RepoRow
              key={r.fullName}
              repo={r}
              onToggled={(favorite) => {
                if (!favorite && show === "favorites") keepInView(r.fullName);
              }}
            />
          ))}
        </ul>
      )}
    </>
  );

  return (
    <div
      className={cn(
        "mx-auto w-full px-4 py-8 sm:px-6",
        sidebar ? "max-w-6xl lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10" : "max-w-5xl",
      )}
    >
      {sidebar && <RepoSidebar list={list} />}
      <section className="min-w-0" aria-labelledby="repositories-title">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
          <h1 id="repositories-title" className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            Repositories
            {list.length > 0 && (
              <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-sm font-medium tabular-nums">
                {list.length}
              </span>
            )}
            {updating && (
              <Loader2
                role="status"
                aria-label="Updating the repository list"
                className="text-muted-foreground size-4 animate-spin motion-reduce:animate-none"
              />
            )}
          </h1>
          {actions}
        </div>
        <p className="text-muted-foreground mb-5 text-sm">
          Connected repositories — access follows your permissions at the Git provider.
        </p>
        {body}
      </section>
    </div>
  );
}

/** "Find a repository…" + Show + Sort. `/` focuses the box, Esc clears it. */
function RepoToolbar({
  query,
  show,
  sort,
  favorites,
  onQuery,
  onShow,
  onSort,
}: {
  query: string;
  show: ShowFilter;
  sort: SortOrder;
  /** the host knows favorites (a 5.1 or older host does not) */
  favorites: boolean;
  onQuery: (q: string) => void;
  onShow: (show: ShowFilter) => void;
  onSort: (sort: SortOrder) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  // the box keeps its own text: ?q commits a moment AFTER each keystroke, and
  // an input controlled by it directly is reset in between (the caret jumps
  // to the end, IME composition can break). ?q follows the box; the box follows
  // ?q only when it changed elsewhere — Clear filters, the header's link to
  // the start page — never while someone types in it
  const [text, setText] = useState(query);
  useEffect(() => {
    if (document.activeElement !== input.current) setText(query);
  }, [query]);
  const type = (next: string) => {
    setText(next);
    onQuery(next);
  };
  const shows: ShowFilter[] = favorites ? ["all", "favorites", "live"] : ["all", "live"];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-auto sm:min-w-0 sm:flex-1">
        <Search
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        />
        <Input
          ref={input}
          value={text}
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && text) {
              e.preventDefault();
              type("");
            }
          }}
          placeholder="Find a repository…"
          aria-label="Find a repository"
          aria-keyshortcuts="/"
          autoComplete="off"
          spellCheck={false}
          className="pr-9 pl-8"
        />
        {text ? (
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-1/2 right-1 size-7 -translate-y-1/2"
            aria-label="Clear the search"
            title="Clear (Esc)"
            onClick={() => {
              type("");
              input.current?.focus();
            }}
          >
            <X />
          </Button>
        ) : (
          <kbd
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded-sm border px-1.5 font-mono text-[11px] leading-4"
          >
            /
          </kbd>
        )}
      </div>
      <MenuButton label="Show" value={SHOW_LABELS[show]} active={show !== "all"}>
        <DropdownMenuRadioGroup value={show} onValueChange={(v) => onShow(v as ShowFilter)}>
          {shows.map((s) => (
            <DropdownMenuRadioItem key={s} value={s}>
              {SHOW_LABELS[s]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </MenuButton>
      <MenuButton label="Sort" value={SORT_LABELS[sort]}>
        <DropdownMenuRadioGroup value={sort} onValueChange={(v) => onSort(v as SortOrder)}>
          {(["updated", "name"] as const).map((s) => (
            <DropdownMenuRadioItem key={s} value={s}>
              {SORT_LABELS[s]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </MenuButton>
    </div>
  );
}

/** a toolbar menu showing its current choice: "Show: Favorites ▾" — a filter
 *  that is on reads as selected (blue frame, blue-soft fill) */
function MenuButton({
  label,
  value,
  active = false,
  children,
}: {
  label: string;
  value: string;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-9", active && "border-primary bg-accent")}>
          <span className="text-muted-foreground">{label}:</span> {value}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">{label}</DropdownMenuLabel>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** the owner's avatar (or its initial) */
function OwnerAvatar({ repo, className }: { repo: RepoInfo; className?: string }) {
  return (
    <Avatar className={cn("size-8 rounded-md", className)}>
      {repo.avatarUrl && <AvatarImage src={repo.avatarUrl} alt="" />}
      <AvatarFallback className="rounded-md text-xs">{repo.owner.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

/**
 * One repository. The name is the row's only link, stretched over the whole
 * row (::after); the favorite toggle and the tooltip-carrying details sit
 * above it (z-10), so they keep their own click and hover.
 */
function RepoRow({ repo: r, onToggled }: { repo: RepoInfo; onToggled: (favorite: boolean) => void }) {
  return (
    <li className="hover:bg-muted/40 focus-within:bg-muted/40 relative flex items-start gap-3 px-4 py-3 transition-colors">
      <OwnerAvatar repo={r} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            to="/r/$owner/$repo"
            params={{ owner: r.owner, repo: r.name }}
            className="min-w-0 truncate font-semibold after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:underline focus-visible:outline-none"
          >
            <span className="text-muted-foreground font-normal">{r.owner} / </span>
            {r.name}
          </Link>
          {r.private === false && <Badge variant="outline">Public</Badge>}
          {r.suspended && <Badge variant="warning">Suspended</Badge>}
          {r.dirtyCount ? (
            <Badge variant="warning">
              {r.dirtyCount} live {r.dirtyCount === 1 ? "change" : "changes"}
            </Badge>
          ) : null}
          {r.liveSessions > 0 ? <Badge variant="secondary">{r.liveSessions} open now</Badge> : null}
        </div>
        <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="relative z-10">
            <ModelCounts repo={r} />
          </span>
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{r.defaultBranch}</span>
          </span>
          {r.lastChangeAt && (
            <time dateTime={r.lastChangeAt} title={absoluteTime(r.lastChangeAt)} className="relative z-10">
              Updated {timeAgo(r.lastChangeAt)}
            </time>
          )}
        </div>
      </div>
      {typeof r.favorite === "boolean" && (
        <FavoriteToggle
          fullName={r.fullName}
          favorite={r.favorite}
          onToggled={onToggled}
          className="relative z-10 -my-1 -mr-2"
        />
      )}
    </li>
  );
}

/** Favorites + Recently opened — a left column from 1024 px, above the list
 *  (each collapsed to its title and count) below that */
function RepoSidebar({ list }: { list: RepoInfo[] }) {
  const favorites = favoriteRepos(list);
  const recent = recentRepos(list);
  const [allFavorites, setAllFavorites] = useState(false);
  const shown = allFavorites ? favorites : favorites.slice(0, SIDEBAR_FAVORITES);
  return (
    <nav aria-label="Your repositories" className="mb-6 flex flex-col gap-2 lg:mb-0 lg:gap-6 lg:pt-1">
      <SidebarSection id="favorites" title="Favorites" count={favorites.length}>
        {favorites.length === 0 ? (
          <p className="text-muted-foreground text-xs leading-relaxed">
            Click <Star aria-hidden="true" className="inline size-3.5 align-[-2px]" />
            <span className="sr-only">the star</span> on a repository to keep it here. Only you see your favorites.
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5">
              {shown.map((r) => (
                <li key={r.fullName}>
                  <SidebarLink repo={r} />
                </li>
              ))}
            </ul>
            {favorites.length > SIDEBAR_FAVORITES && (
              <Button
                variant="link"
                size="sm"
                className="text-muted-foreground h-auto px-2 py-1 text-xs"
                onClick={() => setAllFavorites((v) => !v)}
              >
                {allFavorites ? "Show fewer" : `Show ${favorites.length - SIDEBAR_FAVORITES} more`}
              </Button>
            )}
          </>
        )}
      </SidebarSection>
      <SidebarSection id="recent" title="Recently opened" count={recent.length}>
        {recent.length === 0 ? (
          <p className="text-muted-foreground text-xs leading-relaxed">The repositories you open show up here.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {recent.map((r) => (
              <li key={r.fullName}>
                <SidebarLink repo={r} detail={r.lastOpenedAt ? `opened ${timeAgo(r.lastOpenedAt)}` : undefined} />
              </li>
            ))}
          </ul>
        )}
      </SidebarSection>
    </nav>
  );
}

function SidebarSection({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby={`${id}-title`} className="rounded-lg border px-3 py-2 lg:rounded-none lg:border-0 lg:p-0">
      <h2 id={`${id}-title`} className="mb-2 hidden text-sm font-semibold lg:block">
        {title}
      </h2>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 py-1 text-sm font-semibold lg:hidden"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => setOpen((v) => !v)}
      >
        <span>
          {title} <span className="text-muted-foreground font-normal">· {count}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("text-muted-foreground size-4 transition-transform", open && "rotate-180")}
        />
      </button>
      <div id={`${id}-body`} className={cn(open ? "block pt-1 pb-1" : "hidden", "lg:block lg:p-0")}>
        {children}
      </div>
    </section>
  );
}

function SidebarLink({ repo: r, detail }: { repo: RepoInfo; detail?: string }) {
  return (
    <Link
      to="/r/$owner/$repo"
      params={{ owner: r.owner, repo: r.name }}
      className={cn(
        "hover:bg-accent hover:text-accent-foreground flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
        focusRing,
      )}
    >
      <OwnerAvatar repo={r} className="size-5 rounded-sm" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{r.fullName}</span>
        {detail && <span className="text-muted-foreground text-xs">{detail}</span>}
      </span>
    </Link>
  );
}

/** the first load without a cached list: placeholders in the rows' shape */
function RepoRowSkeletons() {
  return (
    <ul className="divide-y rounded-lg border" aria-busy="true" aria-label="Loading repositories">
      {Array.from({ length: 5 }, (_, i) => (
        <li key={i} className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="size-8 rounded-md" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-56 max-w-full" />
            <Skeleton className="h-3 w-40 max-w-full" />
          </div>
        </li>
      ))}
    </ul>
  );
}
