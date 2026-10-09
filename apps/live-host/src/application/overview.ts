/**
 * The overview read-models, extracted from http/api.ts:
 *
 *   listProcesses — one row per .bpmn file under the repo's designiq.yml
 *                   processes folder (repos/content.ts), with dirty-vs-origin
 *                   flag and live session count
 *   listDecisions — the .dmn sibling of listProcesses
 *   listChanges   — every file differing from origin/<default>, the pool a
 *                   file-selection release picks from
 *   listRepos     — registry ∩ the session user's per-repo permission, with
 *                   model (per notation), process, decision and dirty counts
 *                   for locally-present workspaces, the caller's favorite flag
 *                   and last visit, and the repo's last change (#213)
 *
 * Pure orchestration over injected surfaces: the dirty check goes through
 * WorkspaceManager.changedPaths (the git subprocess lives behind that seam,
 * never here). The returned object shapes ARE the wire format
 * (@designiq/contracts/live-host — shape drift is a tsc error).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { roomName, roomPrefix } from "@designiq/contracts/live";
import type { ChangedFileWire, DecisionInfo, ModelInfo, ProcessInfo, RepoInfo } from "@designiq/contracts/live-host";
import { byExtension, NOTATIONS } from "@designiq/notations";
import { deriveProcess } from "@designiq/notations/derive";
import { extractModelGraph } from "@designiq/notations/extract";

import type { Session } from "../adapters/sqlite/sessions.ts";
import { discoverDecisions, discoverModels, discoverProcesses, loadContentConfig } from "../repos/content.ts";
import type { ConnectedRepo } from "../repos/registry.ts";
import { type FavoritesStore, personalView } from "./favorites.ts";
import type { RepoActivity } from "./repo-activity.ts";

export interface OverviewDeps {
  registry: { list(): ConnectedRepo[] };
  workspaces: {
    /** checkout root (no provisioning) — the overview must never trigger clones */
    dir(repo: ConnectedRepo): string;
    /** files under `pathspec` differing from origin/<defaultBranch>; [] on error */
    changedPaths(repo: ConnectedRepo, pathspec: string): Promise<string[]>;
    /** changed files under `pathspec` with status (+ where a platform rename
     *  came from); [] on error */
    changedFiles(
      repo: ConnectedRepo,
      pathspec: string,
    ): Promise<Array<{ path: string; status: "modified" | "added" | "deleted"; renamedFrom?: string }>>;
    /** files the catch-up kept although upstream changed them too (#185) —
     *  optional: fakes without it report no conflicts */
    conflicts?(repo: ConnectedRepo): Promise<string[]>;
  };
  access: { canWrite(session: Session, repo: ConnectedRepo): Promise<boolean> };
  /** repo-qualified document names of live rooms */
  liveDocs: () => string[];
  /** the caller's favorites and visits (application/favorites.ts) — absent:
   *  the rows carry neither `favorite` nor `lastOpenedAt` */
  favorites?: Pick<FavoritesStore, "favorites" | "visits">;
  /** when each repo last changed (application/repo-activity.ts) — absent:
   *  the rows carry no `lastChangeAt` */
  activity?: Pick<RepoActivity, "view">;
}

/** the row shape both model kinds share — wire mapping stays per wrapper */
interface ModelRow {
  id: string;
  path: string;
  folder: string;
  dirty: boolean;
  liveSessions: number;
}

/**
 * The shared list core: discovery + folder math + dirty + live sessions.
 * Dirty comes from ONE changedPaths call over the processes root for the
 * whole list (it used to be one git subprocess pair PER ROW — the read-model
 * half of the cost #86 item 10 removed from the MCP path).
 */
async function listModels(
  opts: OverviewDeps,
  repo: ConnectedRepo,
  workspace: string,
  discover: (
    root: string,
    cfg: NonNullable<ReturnType<typeof loadContentConfig>>,
  ) => Promise<Array<{ id: string; path: string }>>,
): Promise<ModelRow[]> {
  const cfg = loadContentConfig(workspace);
  if (!cfg) return [];
  const live = opts.liveDocs();
  // m.path is repo-root-relative; the folder the UI groups by is relative
  // to the processes root ("" = directly inside it)
  const rootPrefix = cfg.processes === "." ? "" : `${cfg.processes}/`;
  const discovered = await discover(workspace, cfg);
  const changed = new Set(await opts.workspaces.changedPaths(repo, cfg.processes));
  return discovered.map((m) => {
    const rel = m.path.startsWith(rootPrefix) ? m.path.slice(rootPrefix.length) : m.path;
    return {
      id: m.id,
      path: m.path,
      folder: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
      dirty: changed.has(m.path),
      // a model is exactly one file — its room is the exact match
      liveSessions: live.filter((d) => d === roomName(repo.fullName, m.path)).length,
    };
  });
}

/**
 * One row per process (.bpmn) of a CONNECTED repo's workspace — the overview
 * read-model. Dirty means the file differs from origin/<default>.
 */
export async function listProcesses(
  opts: OverviewDeps,
  repo: ConnectedRepo,
  workspace: string,
): Promise<ProcessInfo[]> {
  const rows = await listModels(opts, repo, workspace, discoverProcesses);
  return rows.map((m) => ({
    repo: repo.fullName,
    id: m.id,
    name: m.id,
    bpmn: m.path,
    models: [{ notation: byExtension(m.path)?.id ?? "text", path: m.path }],
    folder: m.folder,
    dirty: m.dirty,
    liveSessions: m.liveSessions,
  }));
}

/** The .dmn sibling of listProcesses — one row per decision file. */
export async function listDecisions(
  opts: OverviewDeps,
  repo: ConnectedRepo,
  workspace: string,
): Promise<DecisionInfo[]> {
  const rows = await listModels(opts, repo, workspace, discoverDecisions);
  return rows.map((m) => ({
    repo: repo.fullName,
    id: m.id,
    name: m.id,
    path: m.path,
    folder: m.folder,
    dirty: m.dirty,
    liveSessions: m.liveSessions,
  }));
}

/**
 * One row per model file of ANY registered notation — the registry-wide
 * superset of listProcesses/listDecisions (which stay the typed views).
 */
export async function listAllModels(opts: OverviewDeps, repo: ConnectedRepo, workspace: string): Promise<ModelInfo[]> {
  const rows = await listModels(opts, repo, workspace, discoverModels);
  return rows.map((m) => ({
    repo: repo.fullName,
    id: m.id,
    name: m.id,
    path: m.path,
    notation: byExtension(m.path)?.id ?? "text",
    folder: m.folder,
    dirty: m.dirty,
    liveSessions: m.liveSessions,
  }));
}

/** one businessRuleTask that delegates to a decision */
export interface DecisionUsage {
  /** the process id (= .bpmn file stem) */
  process: string;
  path: string;
  /** the businessRuleTask's element id and name */
  element: string;
  elementName: string | null;
}

/**
 * Which processes delegate to a decision — the impact question ("what breaks
 * if I change this table?"). Reads the workspace tree rather than the live
 * documents on purpose: opening a live room per process would be a Hocuspocus
 * connection per file, and the released truth is what the link check and the
 * release PR reason about anyway.
 *
 * Deliberately NOT riding buildRepoIndex yet: the wire carries elementName
 * (the businessRuleTask's label), which ModelRef does not represent —
 * consolidate once refs carry a source-element label (epic #118).
 */
export async function decisionUsers(workspace: string, decisionId: string): Promise<DecisionUsage[]> {
  const cfg = loadContentConfig(workspace);
  if (!cfg) return [];
  const out: DecisionUsage[] = [];
  for (const proc of await discoverProcesses(workspace, cfg)) {
    const xml = await readFile(join(workspace, proc.path), "utf8").catch(() => undefined);
    if (xml === undefined) continue;
    const graph = extractModelGraph(proc.path, xml);
    if (!graph) continue;
    for (const decision of deriveProcess(graph).decisions) {
      if (decision.decisionRef !== decisionId) continue;
      out.push({ process: proc.id, path: proc.path, element: decision.id, elementName: decision.name });
    }
  }
  return out;
}

/**
 * Every CONTENT file in which the shared workspace differs from
 * origin/<default> — the pool a file-selection release picks from, confined
 * to the designiq.yml processes scope (like live rooms; checkout files outside
 * it are not part of the platform's surface). liveSessions marks files a
 * colleague currently has open, so the release dialog can warn before
 * shipping somebody's work in progress; conflict marks files the default
 * branch changed meanwhile, which the release refuses until resolved.
 */
export async function listChanges(
  opts: OverviewDeps,
  repo: ConnectedRepo,
  workspace: string,
): Promise<ChangedFileWire[]> {
  const cfg = loadContentConfig(workspace);
  if (!cfg) return [];
  const live = opts.liveDocs();
  const conflicts = new Set((await opts.workspaces.conflicts?.(repo)) ?? []);
  return (await opts.workspaces.changedFiles(repo, cfg.processes)).map((c) => ({
    ...c,
    liveSessions: live.filter((d) => d === roomName(repo.fullName, c.path)).length,
    conflict: conflicts.has(c.path),
  }));
}

/**
 * How many repos listRepos works on at once. On a cold access cache each repo
 * costs a provider round trip (the permission check) plus two git
 * subprocesses — walked one after another, the overview's latency grew
 * linearly with the registry (#212). Bounded, so a large installation does
 * not fire a burst of permission checks at the provider (GitHub's secondary
 * rate limits) or fork dozens of git processes at once.
 */
const REPO_CONCURRENCY = 8;

/** Promise.all over `items` with at most `limit` in flight — results keep the input order. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** models per notation id, in registry order — a notation without a model is omitted */
function countByNotation(models: ReadonlyArray<{ notation: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of NOTATIONS) {
    const count = models.filter((m) => m.notation === n.id).length;
    if (count > 0) counts[n.id] = count;
  }
  return counts;
}

/**
 * Repo overview: registry ∩ the session user's per-repo permission, in
 * registry order. Per repo it pays exactly the permission check and one
 * changedPaths — the personal fields and the last change come from SQLite
 * reads made ONCE per listing, never from another git process or provider
 * call (#212, #213). The access filter here is the only one: a favorite or a
 * visit of a repository the caller can no longer access simply has no row.
 */
export async function listRepos(opts: OverviewDeps, session: Session): Promise<RepoInfo[]> {
  const live = opts.liveDocs();
  const mine = opts.favorites ? personalView(opts.favorites, session) : undefined;
  const activity = opts.activity?.view();
  const rows = await mapBounded(opts.registry.list(), REPO_CONCURRENCY, async (repo): Promise<RepoInfo | null> => {
    // per-repo permission (a LIVE_AUTH=none host injects an allow-all access)
    if (!(await opts.access.canWrite(session, repo))) {
      // no access → the repo does not exist for this user (private by default)
      return null;
    }
    // counts only when the workspace already exists locally AND declares itself
    // a content repo (designiq.yml) — the overview must never trigger clones;
    // opening the repo does that. One repo's broken tree must not 500 the whole
    // overview (adversarial review).
    const ws = opts.workspaces.dir(repo);
    let processCount: number | null = null;
    let decisionCount: number | null = null;
    let modelCount: number | null = null;
    let modelCounts: Record<string, number> | null = null;
    let dirtyCount: number | null = null;
    const cfg = loadContentConfig(ws);
    if (cfg) {
      try {
        // counts come from ONE discovery walk (readdir only) over every
        // notation — processes and decisions are filtered out of it — and
        // dirty from ONE changedPaths call per repo: the per-row git
        // subprocesses the list endpoints used to pay never belonged on the
        // overview. dirtyCount counts dirty models of EVERY notation: a repo
        // whose only change was a decision (#95), and later a board or a map,
        // showed no "live changes" badge at all. And it counts MODELS only —
        // the dirty rows list_models shows, a subset of modelCount — so a
        // changed sidecar (<stem>.tests.yaml) or other non-model file in the
        // folder never inflates it; the release dialog (listChanges) is where
        // every changed file appears.
        const [models, changedList] = await Promise.all([
          discoverModels(ws, cfg),
          opts.workspaces.changedPaths(repo, cfg.processes),
        ]);
        const changed = new Set(changedList);
        const procs = models.filter((m) => m.notation === "bpmn");
        const decs = models.filter((m) => m.notation === "dmn");
        processCount = procs.length;
        decisionCount = decs.length;
        modelCount = models.length;
        modelCounts = countByNotation(models);
        dirtyCount = models.filter((m) => changed.has(m.path)).length;
      } catch (e) {
        console.log(`overview: listing ${repo.fullName} failed (${(e as Error).message.split("\n")[0]})`);
      }
    }
    // fullName is always "<owner>/<name>" (registry contract; GitLab subgroups
    // keep a slash too) — split() yields ≥1 element, so the fallbacks never fire
    // at runtime; they exist for noUncheckedIndexedAccess.
    const [ownerSegment = repo.fullName, nameSegment = repo.fullName] = repo.fullName.split("/");
    return {
      fullName: repo.fullName,
      owner: ownerSegment,
      name: nameSegment,
      defaultBranch: repo.defaultBranch,
      avatarUrl: repo.avatarUrl,
      suspended: repo.suspended,
      permission: "write", // repos without write access were skipped above
      processCount,
      decisionCount,
      modelCount,
      modelCounts,
      dirtyCount,
      liveSessions: live.filter((d) => d.startsWith(roomPrefix(repo.fullName))).length,
      private: repo.private,
      ...(mine ? { favorite: mine.favorite(repo.fullName), lastOpenedAt: mine.lastOpenedAt(repo.fullName) } : {}),
      // "never cloned" is the one place the provider's push time may stand in
      ...(activity ? { lastChangeAt: activity.lastChangeAt(repo, existsSync(ws)) } : {}),
    };
  });
  return rows.filter((r): r is RepoInfo => r !== null);
}
