/**
 * Background work on a repo's todos (#208, #210) — the tracker side of a
 * rename or delete:
 *
 *   move   a renamed model's open todos follow its new id (the tracker's
 *          model filter + the anchor in each item)
 *   close  a deleted model's open todos are closed, on request
 *
 * The tracker takes ONE write at a time: GitHub asks for serial writes at
 * least a second apart (REST best practices), so a batch of N todos takes
 * about N seconds. Nobody waits for that — the rename/delete answers at once
 * and the job runs here, one item after the other, reporting progress
 * (GET …/todo-jobs). A "slow down" from the tracker (TrackerRateLimited) is
 * waited out and the same item retried; any other refusal counts as failed
 * and the job ends FAILED — its todos stay where they are until a retry.
 *
 * Jobs are persisted (TodoJobStore) until they finish cleanly, so a host
 * restart resumes them. Chains collapse: renaming a → b and then b → c moves
 * the todos still under a straight to c; renaming back cancels the move.
 * While a move runs, the todo listing of the TARGET model also shows the
 * todos still filed under the source (sourcesOf) — nothing disappears midway.
 * A job belongs to ONE notation (a rename keeps it): model ids are unique per
 * notation, so a process and a Wardley Map of the same id are two jobs.
 *
 * Every job re-lists the source's open todos when it starts, so items filed
 * meanwhile are included and a retry picks up exactly what is still left.
 */
import type { TodoJobWire } from "@designiq/contracts/live-host";
import type { TodoModelRef } from "@designiq/contracts/todo-anchor";

import { type IssueTracker, type TodoTarget, TrackerRateLimited } from "../ports/issue-tracker.ts";

export type TodoJobKind = TodoJobWire["kind"];

/** what a job is — the persisted part */
export interface TodoJobSpec {
  repo: string;
  kind: TodoJobKind;
  /** the notation of the model the todos are filed under */
  notation: string;
  /** the model id the todos are filed under */
  from: string;
  /** move: where they go */
  to?: TodoTarget;
  /** platform login the tracker writes are attributed to (close) */
  by: string;
}

/** persistence of unfinished jobs (adapters/sqlite/todo-job-store.ts) */
export interface TodoJobStore {
  list(): TodoJobSpec[];
  /** insert or replace — one job per (repo, kind, notation, from) */
  put(spec: TodoJobSpec): void;
  remove(repo: string, kind: TodoJobKind, from: TodoModelRef): void;
}

interface Job {
  spec: TodoJobSpec;
  total: number;
  done: number;
  failed: number;
  state: TodoJobWire["state"];
  /** a later rename made this job pointless (renamed back) — stop after the current item */
  cancelled: boolean;
  /** when it finished — finished jobs are shown for a while, then forgotten */
  finishedAt?: number;
}

export interface TodoJobsDeps {
  issues: IssueTracker;
  store: TodoJobStore;
  /** pause between two tracker writes — GitHub: at least a second */
  pauseMs?: number;
  /** cap on one rate-limit wait (the tracker may ask for up to an hour) */
  maxWaitMs?: number;
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** how long a finished job stays visible (the UI's last poll must see "done") */
const KEEP_FINISHED_MS = 10 * 60_000;
/** a rate-limited item is retried this often before it counts as failed */
const MAX_RATE_LIMIT_RETRIES = 3;

const keyOf = (spec: Pick<TodoJobSpec, "repo" | "kind" | "notation" | "from">): string =>
  `${spec.repo}\n${spec.kind}:${spec.notation}:${spec.from}`;

/** the model a job's todos are filed under */
const fromOf = (spec: TodoJobSpec): TodoModelRef => ({ notation: spec.notation, id: spec.from });

/** the wire id, stable per repo */
const wireIdOf = (spec: TodoJobSpec): string => `${spec.kind}:${spec.notation}:${spec.from}`;

export class TodoJobs {
  private readonly jobs = new Map<string, Job>();
  /** job keys waiting to run, FIFO — ONE runner, so tracker writes never overlap */
  private readonly queue: string[] = [];
  private running = false;
  private readonly deps: Required<Omit<TodoJobsDeps, "issues" | "store">> & Pick<TodoJobsDeps, "issues" | "store">;

  constructor(deps: TodoJobsDeps) {
    this.deps = {
      pauseMs: 1_000,
      maxWaitMs: 5 * 60_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      ...deps,
    };
  }

  /** re-run whatever a previous host left unfinished */
  resume(): void {
    for (const spec of this.deps.store.list()) this.enqueue(spec);
  }

  /** a renamed model's todos follow it (from.id → to.model) */
  move(repo: string, from: TodoModelRef, to: TodoTarget, by: string): TodoJobWire {
    // a chain collapses: whatever was still on its way INTO `from` goes on to `to`
    for (const job of this.jobs.values()) {
      const s = job.spec;
      if (s.repo !== repo || s.kind !== "move" || s.notation !== from.notation) continue;
      if (s.to?.model !== from.id || this.finished(job)) continue;
      if (s.from === to.model) {
        // renamed back where the todos came from: nothing left to move (a
        // running job stops after its current item; what it already moved
        // comes back with the reverse move registered below)
        job.cancelled = true;
        this.deps.store.remove(repo, "move", fromOf(s));
        if (job.state !== "running") this.finish(job, "done");
      } else {
        s.to = to;
        this.deps.store.put(s);
      }
    }
    return this.wire(this.enqueue({ repo, kind: "move", notation: from.notation, from: from.id, to, by }));
  }

  /** a deleted model's open todos are closed */
  close(repo: string, from: TodoModelRef, by: string): TodoJobWire {
    return this.wire(this.enqueue({ repo, kind: "close", notation: from.notation, from: from.id, by }));
  }

  /** the repo's jobs that are queued, running, failed or recently finished */
  status(repo: string): TodoJobWire[] {
    const now = this.deps.now();
    const out: TodoJobWire[] = [];
    for (const [key, job] of this.jobs) {
      if (job.finishedAt !== undefined && job.state === "done" && now - job.finishedAt > KEEP_FINISHED_MS) {
        this.jobs.delete(key);
        continue;
      }
      if (job.spec.repo === repo) out.push(this.wire(job));
    }
    return out;
  }

  /** run a failed job again; undefined when there is no such job */
  retry(repo: string, id: string): TodoJobWire | undefined {
    const job = [...this.jobs.values()].find((j) => j.spec.repo === repo && this.wire(j).id === id);
    if (!job) return undefined;
    if (job.state !== "failed") return this.wire(job);
    return this.wire(this.enqueue(job.spec));
  }

  /** the ids (of the same notation) whose todos are still on their way INTO
   *  `model` — its todo listing shows theirs too, so nothing disappears while
   *  they move */
  sourcesOf(repo: string, model: TodoModelRef): string[] {
    return [...this.jobs.values()]
      .filter((j) => j.spec.repo === repo && j.spec.kind === "move" && j.spec.notation === model.notation)
      .filter((j) => j.spec.to?.model === model.id && !j.cancelled && !(j.state === "done"))
      .map((j) => j.spec.from);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private finished(job: Job): boolean {
    return job.state === "done" || job.cancelled;
  }

  private enqueue(spec: TodoJobSpec): Job {
    const key = keyOf(spec);
    const existing = this.jobs.get(key);
    if (existing && (existing.state === "queued" || existing.state === "running") && !existing.cancelled) {
      // the running/queued job re-reads its spec per item — a new target is enough
      existing.spec.to = spec.to;
      existing.spec.by = spec.by;
      this.deps.store.put(existing.spec);
      return existing;
    }
    const job: Job = { spec: { ...spec }, total: -1, done: 0, failed: 0, state: "queued", cancelled: false };
    this.jobs.set(key, job);
    this.deps.store.put(job.spec);
    this.queue.push(key);
    void this.drain();
    return job;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let key = this.queue.shift(); key !== undefined; key = this.queue.shift()) {
        const job = this.jobs.get(key);
        if (!job || job.cancelled || job.state !== "queued") continue;
        await this.run(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(job: Job): Promise<void> {
    const { issues, pauseMs, sleep } = this.deps;
    const { repo, from } = job.spec;
    job.state = "running";
    job.done = 0;
    job.failed = 0;
    let ids: string[];
    try {
      ids = (await issues.listTodos(repo, fromOf(job.spec))).map((t) => t.id);
    } catch (e) {
      console.log(`todo ${job.spec.kind} ${repo} ${from}: listing failed — ${(e as Error).message}`);
      job.total = Math.max(job.total, 0);
      job.failed = 1;
      return this.finish(job, "failed");
    }
    job.total = ids.length;
    for (const [i, id] of ids.entries()) {
      if (job.cancelled) return this.finish(job, "done");
      if (i > 0) await sleep(job.spec.kind === "close" ? pauseMs * 2 : pauseMs); // close = two writes
      if (await this.apply(job, id)) job.done++;
      else job.failed++;
    }
    this.finish(job, job.failed > 0 ? "failed" : "done");
  }

  /** one item, rate limits waited out; true = handled */
  private async apply(job: Job, id: string): Promise<boolean> {
    const { issues, sleep, maxWaitMs } = this.deps;
    const { repo, kind, to, by } = job.spec;
    for (let attempt = 0; ; attempt++) {
      try {
        if (kind === "move" && to) await issues.retargetTodo(repo, id, fromOf(job.spec), to);
        else if (kind === "close") await issues.closeTodo(repo, id, by);
        return true;
      } catch (e) {
        if (e instanceof TrackerRateLimited && attempt < MAX_RATE_LIMIT_RETRIES) {
          console.log(`todo ${kind} ${repo} #${id}: rate limited — waiting ${Math.round(e.retryAfterMs / 1000)}s`);
          await sleep(Math.min(e.retryAfterMs, maxWaitMs));
          continue;
        }
        console.log(`todo ${kind} ${repo} #${id} failed: ${(e as Error).message}`);
        return false;
      }
    }
  }

  private finish(job: Job, state: "done" | "failed"): void {
    job.state = state;
    job.finishedAt = this.deps.now();
    // a clean finish is the end of it; a failed job stays persisted for the
    // retry — unless a newer job of the same key took its place meanwhile
    const current = this.jobs.get(keyOf(job.spec)) === job;
    if (state === "done" && current) this.deps.store.remove(job.spec.repo, job.spec.kind, fromOf(job.spec));
    console.log(
      `todo ${job.spec.kind} ${job.spec.repo} ${job.spec.notation}:${job.spec.from}${job.spec.to ? ` → ${job.spec.to.model}` : ""}: ${state} (${job.done}/${job.total}${job.failed ? `, ${job.failed} failed` : ""})`,
    );
  }

  private wire(job: Job): TodoJobWire {
    const { kind, notation, from, to } = job.spec;
    return {
      id: wireIdOf(job.spec),
      kind,
      notation,
      from,
      ...(to ? { to: to.model } : {}),
      total: job.total,
      done: job.done,
      failed: job.failed,
      state: job.cancelled && job.state !== "failed" ? "done" : job.state,
    };
  }
}
