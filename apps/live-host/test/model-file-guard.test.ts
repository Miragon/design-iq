/**
 * The model file guard (src/application/workspace-paths.ts modelFileRefusal)
 * on every lane that reads or writes a model file: the room's load and
 * write-through (collab.ts resolveRoom), the REST/MCP content routes and the
 * repair of a board the room refuses (content.ts). A symlink a pull request
 * brings into the models folder must lead none of them anywhere, .git/config
 * least of all: its core.fsmonitor is a command git runs on the host's next
 * fetch or reset. Layouts that are no such way out keep working.
 *
 * Also the repair's write (content.ts replaceFile): one rename, so a room
 * load beside it reads the refused text or the whole repaired board, never a
 * truncated file it would take for an empty board.
 *
 * Against a REAL Hocuspocus server (no listen(), no websocket), wired like
 * content.test.ts, so a direct connection runs the actual load/store hooks.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { CONTENT_KEY, ELEMENTS_KEY } from "@designiq/contracts/live";
import { AppError } from "@designiq/http-kit";
import { reconcileSnapshot } from "@designiq/live-client/structured";
import { docCodecFor } from "@designiq/notations/codecs";
import { Server } from "@hocuspocus/server";
import * as Y from "yjs";

import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import { makeCollabHooks } from "../src/application/collab.ts";
import {
  baseVersionOf,
  checkContent,
  type ContentDeps,
  editContent,
  getContent,
  putContent,
} from "../src/application/content.ts";
import { modelFileRefusal } from "../src/application/workspace-paths.ts";
import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";
import { CONTENT_CONFIG_FILE, loadContentConfig } from "../src/repos/content.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
};

const GIT_CONFIG =
  '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/acme/models.git\n';

const board = docCodecFor("board")!;
const node = (attrs: Record<string, unknown>) => ({
  kind: "node",
  x: 0,
  y: 0,
  width: 240,
  height: 160,
  z: "a",
  ...attrs,
});
const BOARD = board.encode({
  meta: { title: "Workshop", version: 1 },
  elements: { n_note: node({ type: "text", text: "Ask finance" }) },
});
/** what the board's reader refuses (line 3 is no JSON) */
const UNREADABLE = `${BOARD}not json\n`;

/** a valid text per guarded notation: the structured lane and the text lane */
const LANES = [
  { path: "processes/evil.board", text: BOARD },
  { path: "processes/evil.md", text: "# Notes\n" },
];

// Hocuspocus keeps event-loop handles until destroyed (see content.test.ts)
const servers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.destroy()));
  setTimeout(() => process.exit(), 2000).unref();
});

/** a content repo with a .git/config beside its models folder */
function contentRepo(): string {
  const ws = mkdtempSync(join(tmpdir(), "designiq-guard-"));
  mkdirSync(join(ws, "processes"), { recursive: true });
  mkdirSync(join(ws, ".git"), { recursive: true });
  writeFileSync(join(ws, ".git", "config"), GIT_CONFIG);
  writeFileSync(join(ws, CONTENT_CONFIG_FILE), "processes: processes\n");
  return ws;
}

/** real Hocuspocus over `root` (hooks wired like server.ts) + the content deps */
function setup(root = contentRepo()) {
  const liveDocs = new Set<string>();
  const registry = { get: (n: string) => (n.toLowerCase() === REPO.fullName ? REPO : undefined) };
  const workspaces = { ensure: async () => root };
  const hooks = makeCollabHooks({
    lineage: new LineageStore(new DatabaseSync(":memory:"), REPO.fullName),
    docGuard: new DocSizeGuard(8_000_000),
    maxDocBytes: 8_000_000,
    sessions: { get: () => undefined },
    access: { canWrite: async () => true },
    registry,
    workspaces,
    contentConfig: loadContentConfig,
    liveDocs,
  });
  const hp = new Server({ ...hooks });
  servers.push(hp);
  const deps: ContentDeps = {
    registry,
    workspaces,
    openDoc: (room) => hp.hocuspocus.openDirectConnection(room),
    maxDocBytes: 8_000_000,
  };
  return { ws: root, deps, hp, hooks, liveDocs };
}

/** the REST refusal of a guarded path: typed, exposed, naming why */
const invalidPath = (path: string, why: RegExp) => (e: unknown) =>
  e instanceof AppError &&
  e.code === "content/invalid-path" &&
  e.status === 400 &&
  e.expose &&
  e.message.startsWith(`${path} `) &&
  why.test(e.message);

/** the ws refusal: a plain Error (Hocuspocus refuses the load or the store with it) */
const wsRefusal = (room: string, why: RegExp) => (e: unknown) =>
  e instanceof Error && !(e instanceof AppError) && e.message.startsWith(`${room} `) && why.test(e.message);

// ── the guard itself ────────────────────────────────────────────────────────

test("modelFileRefusal: a regular model file passes; a symlink, a folder, a way out of the models folder or into .git does not", () => {
  const ws = contentRepo();
  const at = (path: string, models = "processes") => modelFileRefusal(join(ws, path), ws, models);
  writeFileSync(join(ws, "processes", "order.bpmn"), "<bpmn/>");
  assert.equal(at("processes/order.bpmn"), undefined);
  // a file not there (a write-through recreating it) is judged by the folder it would land in
  assert.equal(at("processes/gone.bpmn"), undefined);
  assert.equal(at("processes/new/gone.bpmn"), undefined);
  // the model file itself is no symlink: not even to a model beside it, nor a dangling one
  symlinkSync("order.bpmn", join(ws, "processes", "alias.bpmn"));
  assert.equal(at("processes/alias.bpmn"), "is a symlink");
  symlinkSync("../.git/hooks/pre-commit", join(ws, "processes", "hook.md"));
  assert.equal(at("processes/hook.md"), "is a symlink");
  mkdirSync(join(ws, "processes", "folder.bpmn"));
  assert.equal(at("processes/folder.bpmn"), "is not a regular file");
  // a folder link out of the models folder, still inside the workspace
  mkdirSync(join(ws, "docs"));
  writeFileSync(join(ws, "docs", "readme.md"), "# Readme\n");
  symlinkSync("../docs", join(ws, "processes", "docs"));
  assert.equal(at("processes/docs/readme.md"), "leaves the models folder through a symlink");
  assert.equal(at("processes/docs/new.md"), "leaves the models folder through a symlink", "nor a file created there");
  // a folder link out of the workspace
  const outside = mkdtempSync(join(tmpdir(), "designiq-guard-out-"));
  writeFileSync(join(outside, "host.md"), "# Host\n");
  symlinkSync(outside, join(ws, "processes", "out"));
  assert.equal(at("processes/out/host.md"), "leaves the workspace through a symlink");
  // models at the root ("."): the models folder is the workspace, .git still is no part of it
  writeFileSync(join(ws, ".git", "notes.md"), "# Notes\n");
  symlinkSync(".git", join(ws, "meta"));
  assert.equal(at("meta/notes.md", "."), "leads into .git through a symlink");
  assert.equal(at("processes/order.bpmn", "."), undefined);
  // a file where a folder should be, and a link loop on the way: no such model (the callers' 404), never a raw errno
  writeFileSync(join(ws, "processes", "plain.md"), "# Plain\n");
  assert.equal(at("processes/plain.md/inner.md"), undefined);
  symlinkSync("loop", join(ws, "processes", "loop"));
  assert.equal(at("processes/loop/inner.md"), undefined);
  assert.equal(at("processes/loop"), "is a symlink");
});

// ── REST: read, save, repair ────────────────────────────────────────────────

for (const { path, text } of LANES) {
  test(`REST: ${path} symlinked to ../.git/config is refused on read, save, repair, dry run and edit; .git/config unchanged`, async () => {
    const { ws, deps, liveDocs } = setup();
    symlinkSync("../.git/config", join(ws, path));
    const refused = invalidPath(
      path,
      /is a symlink: a model is read and saved only as a regular file inside the models folder \(processes\)$/,
    );
    await assert.rejects(() => getContent(deps, REPO, path), refused);
    // a save with a stale token: no conflict that hands the file's text back ...
    await assert.rejects(() => putContent(deps, REPO, path, { content: text, baseVersion: "bogus" }), refused);
    // ... and none with the file's own token (the board's repair, the text lane's compare-and-set)
    for (const lint of ["block", "warn"] as const) {
      await assert.rejects(
        () => putContent(deps, REPO, path, { content: text, baseVersion: baseVersionOf(GIT_CONFIG), lint }),
        refused,
        `lint: ${lint}`,
      );
    }
    const dry = await checkContent(deps, REPO, path, { content: text });
    assert.deepEqual(dry.ok ? [] : [dry.code, dry.status], ["content/invalid-path", 400]);
    await assert.rejects(() => editContent(deps, REPO, path, (c) => `${c}x`), refused);
    assert.equal(readFileSync(join(ws, ".git", "config"), "utf8"), GIT_CONFIG);
    assert.equal(liveDocs.size, 0, "no room went live on it");
  });
}

test("REST and ws: a models folder that is a link into .git serves nothing from it", async () => {
  const ws = contentRepo();
  mkdirSync(join(ws, ".git", "models"));
  writeFileSync(join(ws, ".git", "models", "notes.md"), "# Notes\n");
  rmSync(join(ws, "processes"), { recursive: true });
  symlinkSync(".git/models", join(ws, "processes"));
  const { deps, hooks } = setup(ws);
  await assert.rejects(
    () => getContent(deps, REPO, "processes/notes.md"),
    invalidPath("processes/notes.md", /leads into \.git through a symlink/),
  );
  const room = `${REPO.fullName}/processes/notes.md`;
  await assert.rejects(
    () => hooks.onLoadDocument({ document: new Y.Doc(), documentName: room }),
    wsRefusal(room, /leads into \.git through a symlink/),
  );
});

// ── ws: load and write-through ──────────────────────────────────────────────

for (const { path, text } of LANES) {
  test(`ws: ${path} symlinked to ../.git/config is neither loaded nor written through`, async () => {
    const { ws, hooks } = setup();
    const room = `${REPO.fullName}/${path}`;
    // the room was open on a regular file when a pull brought the link in
    writeFileSync(join(ws, path), text);
    const doc = new Y.Doc();
    await hooks.onLoadDocument({ document: doc, documentName: room });
    if (path.endsWith(".board")) {
      reconcileSnapshot(doc, board.decode(BOARD.replace("Ask finance", "Ask legal")));
    } else {
      doc.getText(CONTENT_KEY).insert(0, "[core]\n\tfsmonitor = touch /tmp/pwned\n");
    }
    rmSync(join(ws, path));
    symlinkSync("../.git/config", join(ws, path));
    const refused = wsRefusal(room, /is a symlink: it is never read or written$/);
    await assert.rejects(() => hooks.onStoreDocument({ document: doc, documentName: room }), refused);
    assert.equal(readFileSync(join(ws, ".git", "config"), "utf8"), GIT_CONFIG, "the write-through went nowhere");
    // a load of it now is refused the same way
    await assert.rejects(() => hooks.onLoadDocument({ document: new Y.Doc(), documentName: room }), refused);
    assert.equal(readFileSync(join(ws, ".git", "config"), "utf8"), GIT_CONFIG);
  });
}

// ── what still works ────────────────────────────────────────────────────────

test("a models folder linked inside the workspace, reached through a linked workspace, still reads, saves and repairs", async () => {
  // the real checkout holds its models under content/processes; `processes`
  // links there, and the workspace itself is reached through a link (a host
  // serving a checkout from a linked path)
  const real = contentRepo();
  rmSync(join(real, "processes"), { recursive: true });
  mkdirSync(join(real, "content", "processes"), { recursive: true });
  symlinkSync("content/processes", join(real, "processes"));
  const linked = join(mkdtempSync(join(tmpdir(), "designiq-guard-link-")), "checkout");
  symlinkSync(real, linked);
  const { deps } = setup(linked);

  writeFileSync(join(real, "content", "processes", "notes.md"), "# Notes\n");
  const got = await getContent(deps, REPO, "processes/notes.md");
  assert.equal(got.content, "# Notes\n");
  const saved = await putContent(deps, REPO, "processes/notes.md", {
    content: "# Notes, saved\n",
    baseVersion: got.baseVersion,
  });
  assert.ok(saved.ok);
  assert.equal(readFileSync(join(real, "content", "processes", "notes.md"), "utf8"), "# Notes, saved\n");

  // the repair of a board in it: the conflict, then the save with the file's token
  writeFileSync(join(real, "content", "processes", "workshop.board"), UNREADABLE);
  const stale = await putContent(deps, REPO, "processes/workshop.board", { content: BOARD, baseVersion: "bogus" });
  assert.ok(!stale.ok);
  assert.equal(stale.conflict.currentContent, UNREADABLE);
  const repaired = await putContent(deps, REPO, "processes/workshop.board", {
    content: BOARD,
    baseVersion: stale.conflict.baseVersion,
  });
  assert.ok(repaired.ok);
  assert.equal(readFileSync(join(real, "content", "processes", "workshop.board"), "utf8"), BOARD);
  assert.deepEqual(
    readdirSync(join(real, "content", "processes")).sort(),
    ["notes.md", "workshop.board"],
    "the repair's temp file is gone",
  );
  assert.equal((await getContent(deps, REPO, "processes/workshop.board")).content, BOARD);
});

// ── the repair beside a room load ───────────────────────────────────────────

test("a room load beside the repair is refused or opens the whole repaired board, never an empty one", async (t) => {
  // big enough that writing the file takes more than one turn of the event loop
  const PATH = "processes/wall.board";
  const ROOM = `${REPO.fullName}/${PATH}`;
  const elements = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [
      `n${String(i).padStart(4, "0")}`,
      node({ type: "text", text: `note ${i}` }),
    ]),
  );
  const REPAIRED = board.encode({ meta: { title: "Wall", version: 1 }, elements });
  // every refused load logs its error: hundreds per run
  t.mock.method(console, "error", () => undefined);
  t.mock.method(console, "log", () => undefined);
  for (let run = 0; run < 20; run++) {
    const { ws, deps, hp } = setup();
    writeFileSync(join(ws, PATH), UNREADABLE);
    // the repair: a save with the file's token ...
    let settled = false;
    const repair = putContent(deps, REPO, PATH, { content: REPAIRED, baseVersion: baseVersionOf(UNREADABLE) });
    void repair.finally(() => (settled = true)).catch(() => undefined);
    // ... while a colleague's client opens the board: a ws load, outside content.ts's room queue
    let peer: Awaited<ReturnType<typeof hp.hocuspocus.openDirectConnection>> | undefined;
    while (!peer && !settled) {
      try {
        peer = await hp.hocuspocus.openDirectConnection(ROOM);
      } catch {
        // refused: the file still holds the text the reader refuses
      }
    }
    try {
      const saved = await repair;
      assert.ok(saved.ok, `run ${run}: the repair saved`);
      // no load fell inside the repair this run: the board opens now
      peer ??= await hp.hocuspocus.openDirectConnection(ROOM);
      let size = -1;
      await peer.transact((doc) => {
        size = doc.getMap(ELEMENTS_KEY).size;
      });
      assert.equal(size, 300, `run ${run}: the room holds the repaired board, not an empty one`);
      // an agent's read-back stores on disconnect, as the peer does: the repaired file stays
      assert.equal((await getContent(deps, REPO, PATH)).content, REPAIRED);
    } finally {
      // a peer left open would keep the room loaded and the server from shutting down
      await peer?.disconnect();
    }
    assert.equal(readFileSync(join(ws, PATH), "utf8"), REPAIRED, `run ${run}: the repaired file stays`);
  }
});
