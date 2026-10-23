/**
 * Background todo work (src/application/todo-jobs.ts, #208/#210) against an
 * in-memory tracker: serial writes with the pause between them, progress,
 * rate limits waited out, failures kept for a retry, persistence + resume,
 * chains that collapse, a rename back that cancels, and the listing that
 * shows todos still on their way in. The SQLite store runs on :memory:.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { TodoModelRef } from "@designiq/contracts/todo-anchor";

import { SqliteTodoJobStore } from "../src/adapters/sqlite/todo-job-store.ts";
import { TodoJobs, type TodoJobSpec, type TodoJobStore } from "../src/application/todo-jobs.ts";
import { listOpenTodos } from "../src/application/todos.ts";
import { type IssueTracker, type Todo, TrackerRateLimited } from "../src/ports/issue-tracker.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO = "acme/models";

/** a tracker holding todos per model (`<id>` = a process, `<notation>:<id>`
 *  any other model); every write is recorded */
function tracker(todos: Record<string, number>) {
  const items: Array<{ id: string; notation: string; process: string; open: boolean }> = [];
  for (const [key, n] of Object.entries(todos)) {
    const [notation, process] = key.includes(":") ? (key.split(":") as [string, string]) : ["bpmn", key];
    for (let i = 0; i < n; i++) items.push({ id: String(items.length + 1), notation, process, open: true });
  }
  const of = (t: (typeof items)[number], model: TodoModelRef): boolean =>
    t.notation === model.notation && t.process === model.id;
  const writes: string[] = [];
  const failOn = new Set<string>();
  let rateLimits = 0;
  const asTodo = (t: (typeof items)[number]): Todo => ({
    id: t.id,
    url: `https://tracker.test/${t.id}`,
    title: `todo ${t.id}`,
    body: "",
    state: "open",
    anchor: { notation: t.notation, model: t.process, file: null, elements: [], processVersion: null },
    author: null,
    assignees: [],
    createdAt: "2026-09-29T00:00:00Z",
  });
  const issues: IssueTracker = {
    id: "fake",
    async listTodoTypes() {
      return { types: [], blankAllowed: true };
    },
    async createTodo() {
      throw new Error("unused");
    },
    async listTodos(_repo, model) {
      return items.filter((t) => t.open && (!model || of(t, model))).map(asTodo);
    },
    async closeTodo(_repo, id) {
      if (failOn.has(id)) throw new Error("refused");
      writes.push(`close ${id}`);
      const hit = items.find((t) => t.id === id);
      if (hit) hit.open = false;
    },
    async retargetTodo(_repo, id, from, to) {
      if (rateLimits > 0) {
        rateLimits--;
        throw new TrackerRateLimited(30_000);
      }
      if (failOn.has(id)) throw new Error("refused");
      const hit = items.find((t) => t.id === id);
      if (!hit || !of(hit, from)) return "unchanged";
      hit.process = to.model;
      writes.push(`move ${id} ${from.id}→${to.model}`);
      return "moved";
    },
  };
  return {
    issues,
    writes,
    items,
    failOn,
    rateLimit: (n: number) => void (rateLimits = n),
    under: (process: string, notation = "bpmn") =>
      items.filter((t) => t.open && of(t, { notation, id: process })).map((t) => t.id),
  };
}

function memoryStore(): TodoJobStore & { rows: Map<string, TodoJobSpec> } {
  const rows = new Map<string, TodoJobSpec>();
  const key = (repo: string, kind: string, from: TodoModelRef) => `${repo}|${kind}|${from.notation}|${from.id}`;
  return {
    rows,
    list: () => [...rows.values()],
    put: (spec) => void rows.set(key(spec.repo, spec.kind, { notation: spec.notation, id: spec.from }), { ...spec }),
    remove: (repo, kind, from) => void rows.delete(key(repo, kind, from)),
  };
}

/** a TodoJobs whose sleeps are recorded, not waited */
function jobs(t: ReturnType<typeof tracker>, store: TodoJobStore = memoryStore()) {
  const sleeps: number[] = [];
  const j = new TodoJobs({ issues: t.issues, store, sleep: async (ms) => void sleeps.push(ms) });
  return { j, sleeps, store: store as ReturnType<typeof memoryStore> };
}

/** until the runner has nothing left */
async function settled(j: TodoJobs): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (j.status(REPO).every((s) => s.state !== "queued" && s.state !== "running")) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("jobs never settled");
}

const target = (process: string) => ({ model: process, file: `processes/${process}.bpmn` });
const bpmn = (id: string): TodoModelRef => ({ notation: "bpmn", id });

test("move: every open todo follows, one write at a time with a second between, then the job is done and forgotten", async () => {
  const t = tracker({ "invoice-handling": 3, other: 1 });
  const { j, sleeps, store } = jobs(t);
  const started = j.move(REPO, bpmn("invoice-handling"), target("billing"), "petra");
  assert.equal(started.id, "move:invoice-handling");
  assert.equal(started.to, "billing");
  await settled(j);
  assert.deepEqual(t.under("billing"), ["1", "2", "3"]);
  assert.deepEqual(t.under("other"), ["4"], "other processes' todos stay");
  assert.deepEqual(sleeps, [1000, 1000], "a second between writes, none before the first");
  assert.deepEqual(j.status(REPO), [
    {
      id: "move:invoice-handling",
      kind: "move",
      notation: "bpmn",
      from: "invoice-handling",
      to: "billing",
      total: 3,
      done: 3,
      failed: 0,
      state: "done",
    },
  ]);
  assert.equal(store.rows.size, 0, "a clean finish leaves nothing to resume");
});

test("move: a rate limit is waited out and the same todo retried — no todo counts as failed", async () => {
  const t = tracker({ a: 2 });
  const { j, sleeps } = jobs(t);
  t.rateLimit(1);
  j.move(REPO, bpmn("a"), target("b"), "petra");
  await settled(j);
  assert.deepEqual(t.under("b"), ["1", "2"]);
  assert.deepEqual(sleeps, [30_000, 1000], "the asked-for wait, then the regular pause");
  assert.equal(j.status(REPO)[0]?.failed, 0);
});

test("move: a refused todo fails the job, stays where it is and persists; retry moves what is left", async () => {
  const t = tracker({ a: 3 });
  const { j, store } = jobs(t);
  t.failOn.add("2");
  j.move(REPO, bpmn("a"), target("b"), "petra");
  await settled(j);
  assert.deepEqual(t.under("a"), ["2"]);
  assert.equal(j.status(REPO)[0]?.state, "failed");
  assert.equal(j.status(REPO)[0]?.failed, 1);
  assert.equal(store.rows.size, 1, "kept for the retry / a restart");
  // while it is failed, b's listing still shows the todo left behind
  assert.deepEqual(j.sourcesOf(REPO, bpmn("b")), ["a"]);
  const repo = { fullName: REPO } as ConnectedRepo;
  assert.deepEqual(
    (await listOpenTodos(t.issues, j, repo, bpmn("b"))).map((x) => x.id),
    ["1", "3", "2"],
  );

  t.failOn.clear();
  assert.equal(j.retry(REPO, "move:a")?.state, "running", "the idle runner picks it up at once");
  await settled(j);
  assert.deepEqual(t.under("b"), ["1", "2", "3"]);
  assert.deepEqual(j.status(REPO)[0], {
    id: "move:a",
    kind: "move",
    notation: "bpmn",
    from: "a",
    to: "b",
    total: 1,
    done: 1,
    failed: 0,
    state: "done",
  });
  assert.equal(store.rows.size, 0);
  assert.deepEqual(j.sourcesOf(REPO, bpmn("b")), []);
  assert.equal(j.retry(REPO, "move:nope"), undefined);
});

test("resume: a job a previous host left unfinished runs again (SQLite store)", async () => {
  const db = new DatabaseSync(":memory:");
  const before = new SqliteTodoJobStore(db);
  before.put({ repo: REPO, kind: "move", notation: "bpmn", from: "a", to: target("b"), by: "petra" });
  before.put({ repo: REPO, kind: "close", notation: "bpmn", from: "gone", by: "petra" });
  const t = tracker({ a: 1, gone: 2 });
  const { j } = jobs(t, new SqliteTodoJobStore(db));
  j.resume();
  await settled(j);
  assert.deepEqual(t.under("b"), ["1"]);
  assert.deepEqual(t.under("gone"), [], "the deleted process's todos are closed");
  assert.deepEqual(
    t.writes.filter((w) => w.startsWith("close")),
    ["close 2", "close 3"],
  );
  assert.deepEqual(new SqliteTodoJobStore(db).list(), [], "both finished cleanly");
});

test("chains: a → b still on its way when b → c comes: the rest of a goes straight to c", async () => {
  const t = tracker({ a: 2 });
  // hold the runner in its pause after the first write, so the chain happens mid-job
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = new TodoJobs({
    issues: t.issues,
    store: memoryStore(),
    sleep: () => gate,
  });
  slow.move(REPO, bpmn("a"), target("b"), "petra"); // moves #1, then waits
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(t.under("b"), ["1"]);
  slow.move(REPO, bpmn("b"), target("c"), "petra"); // a's job now heads for c; b → c is queued
  release();
  await settled(slow);
  assert.deepEqual(t.under("c"), ["1", "2"], "#2 went a → c directly, #1 b → c");

  // renamed back while nothing is left to move: the reverse job simply runs
  slow.move(REPO, bpmn("c"), target("a"), "petra");
  await settled(slow);
  assert.deepEqual(t.under("a"), ["1", "2"]);
});

test("close: a deleted process's open todos are closed (two writes each — twice the pause)", async () => {
  const t = tracker({ gone: 2 });
  const { j, sleeps } = jobs(t);
  j.close(REPO, bpmn("gone"), "petra");
  await settled(j);
  assert.deepEqual(t.under("gone"), []);
  assert.deepEqual(sleeps, [2000]);
});

test("a tracker that cannot even list fails the job without touching anything", async () => {
  const t = tracker({ a: 1 });
  t.issues.listTodos = async () => {
    throw new Error("tracker down");
  };
  const { j, store } = jobs(t);
  j.move(REPO, bpmn("a"), target("b"), "petra");
  await settled(j);
  assert.equal(j.status(REPO)[0]?.state, "failed");
  assert.equal(store.rows.size, 1);
});

test("renamed BACK mid-move: the a → b job stops, what it moved comes back — everything ends under a", async () => {
  const t = tracker({ a: 3 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = memoryStore();
  const j = new TodoJobs({ issues: t.issues, store, sleep: () => gate });
  j.move(REPO, bpmn("a"), target("b"), "petra"); // moves #1, then waits
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(t.under("b"), ["1"]);
  j.move(REPO, bpmn("b"), target("a"), "petra"); // the rename is undone
  release();
  await settled(j);
  assert.deepEqual(t.under("a"), ["1", "2", "3"]);
  assert.deepEqual(t.under("b"), []);
  assert.equal(store.rows.size, 0);
  assert.ok(j.status(REPO).every((s) => s.state === "done"));
  assert.deepEqual(j.sourcesOf(REPO, bpmn("b")), [], "b's listing no longer pulls in a");
});

test("a process and a Wardley Map of the same id are two models: two jobs, each moving its own todos", async () => {
  const t = tracker({ a: 1, "wardley:a": 2 });
  const { j, store } = jobs(t);
  const started = j.move(REPO, { notation: "wardley", id: "a" }, { model: "b", file: "maps/b.owm" }, "petra");
  assert.deepEqual([started.id, started.notation, started.from, started.to], ["move:wardley:a", "wardley", "a", "b"]);
  assert.deepEqual(j.sourcesOf(REPO, { notation: "wardley", id: "b" }), ["a"]);
  assert.deepEqual(j.sourcesOf(REPO, bpmn("b")), [], "the process b pulls in nothing");
  await settled(j);
  assert.deepEqual(t.under("b", "wardley"), ["2", "3"]);
  assert.deepEqual(t.under("a"), ["1"], "the process a keeps its todo");
  assert.equal(store.rows.size, 0);
  // a delete of both: two close jobs side by side in the store
  const db = new DatabaseSync(":memory:");
  const sqlite = new SqliteTodoJobStore(db);
  sqlite.put({ repo: REPO, kind: "close", notation: "bpmn", from: "x", by: "petra" });
  sqlite.put({ repo: REPO, kind: "close", notation: "markdown", from: "x", by: "petra" });
  assert.deepEqual(
    sqlite
      .list()
      .map((r) => r.notation)
      .sort(),
    ["bpmn", "markdown"],
  );
  sqlite.remove(REPO, "close", { notation: "markdown", id: "x" });
  assert.deepEqual(
    sqlite.list().map((r) => r.notation),
    ["bpmn"],
  );
});

test("SQLite store: a table from before the notations is rebuilt, its jobs kept as process jobs", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE todo_jobs (repo TEXT NOT NULL, kind TEXT NOT NULL, from_process TEXT NOT NULL, " +
      "to_process TEXT, to_file TEXT, by_login TEXT NOT NULL, PRIMARY KEY (repo, kind, from_process))",
  );
  db.prepare("INSERT INTO todo_jobs VALUES (?, ?, ?, ?, ?, ?)").run(
    REPO,
    "move",
    "a",
    "b",
    "processes/b.bpmn",
    "petra",
  );
  const store = new SqliteTodoJobStore(db);
  assert.deepEqual(store.list(), [
    {
      repo: REPO,
      kind: "move",
      notation: "bpmn",
      from: "a",
      to: { model: "b", file: "processes/b.bpmn" },
      by: "petra",
    },
  ]);
  // the key now holds the notation: the same id of another notation is a row of its own
  store.put({ repo: REPO, kind: "move", notation: "wardley", from: "a", to: { model: "c", file: "c.owm" }, by: "kai" });
  assert.equal(store.list().length, 2);
  assert.deepEqual(new SqliteTodoJobStore(db).list().length, 2, "a second open finds the new table as it is");
});
