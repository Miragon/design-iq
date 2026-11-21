/**
 * The move and delete gates (application/scaffold.ts PreviewRooms) against
 * the Live Host's REAL room hooks in a real Hocuspocus server, over ws, with
 * `attended` and `retire` wired as server.ts wires them: a room a board holds
 * only as a preview of a model (a group session announcing nobody) moves
 * along with the model or closes with it, and a room a person has open
 * refuses (409), also once the room's awareness dropped their state while
 * their editor stayed connected (a background tab renewing late).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { AppError } from "@designiq/http-kit";
import {
  type LiveSession,
  type LiveSessionGroup,
  type MovedNotice,
  openLiveSession,
  openLiveSessionGroup,
} from "@designiq/live-client";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";
import { removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import type { Session } from "../src/adapters/sqlite/sessions.ts";
import { makeCollabHooks } from "../src/application/collab.ts";
import { RoomMigrations } from "../src/application/room-migrations.ts";
import { attendedDocument } from "../src/application/room-presence.ts";
import { deleteModels, moveModels, type PreviewRooms } from "../src/application/scaffold.ts";
import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";
import { CONTENT_CONFIG_FILE } from "../src/repos/content.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
};
const room = (path: string): string => `${REPO.fullName}/${path}`;
const ORDER = room("processes/order.bpmn");
const SHIP = room("processes/ship.bpmn");
const FILES: Record<string, string> = {
  "processes/order.bpmn": '<definitions id="order" />\n',
  "processes/ship.bpmn": '<definitions id="ship" />\n',
};
const SESSIONS = new Map<string, Session>([
  [
    "sess-alice",
    { id: "sess-alice", user: { login: "alice", name: "alice", avatarUrl: null, provider: "github" }, createdAt: 0 },
  ],
]);

const servers: Server[] = [];
const groups: LiveSessionGroup[] = [];
const sessions: LiveSession[] = [];
after(async () => {
  for (const group of groups) group.destroy();
  for (const session of sessions) session.destroy();
  await Promise.all(servers.map((server) => server.destroy()));
});

/** a Live Host on a tmpdir content repo, its ws rooms behind the real hooks,
 *  a move and a delete wired as server.ts and http/api.ts wire them */
async function liveHost() {
  const workspace = mkdtempSync(join(tmpdir(), "designiq-previews-"));
  mkdirSync(join(workspace, "processes"));
  writeFileSync(join(workspace, CONTENT_CONFIG_FILE), "models: processes\n");
  for (const [path, text] of Object.entries(FILES)) writeFileSync(join(workspace, path), text);
  const lineage = new LineageStore(new DatabaseSync(":memory:"), REPO.fullName);
  const migrations = new RoomMigrations();
  const liveDocs = new Set<string>();
  const server = new Server({
    port: 0,
    quiet: true,
    ...makeCollabHooks({
      lineage,
      docGuard: new DocSizeGuard(8_000_000),
      maxDocBytes: 8_000_000,
      sessions: { get: (id) => (id === undefined ? undefined : SESSIONS.get(id)) },
      access: { canWrite: async () => true },
      registry: { get: (name) => (name.toLowerCase() === REPO.fullName ? REPO : undefined) },
      workspaces: { ensure: async () => workspace },
      contentConfig: () => ({ processes: "processes" }),
      liveDocs,
      migrations,
    }),
  });
  servers.push(server);
  await server.listen();
  const previews: PreviewRooms = {
    // server.ts attended: a room still loading counts as attended
    attended: (name) => {
      const doc = server.hocuspocus.documents.get(name);
      return doc ? attendedDocument(doc) : true;
    },
    // server.ts rooms.retire
    retire: (name, notice) => {
      const doc = server.hocuspocus.documents.get(name);
      if (!doc) return undefined;
      migrations.retire(name);
      if (notice !== undefined) doc.broadcastStateless(notice);
      server.hocuspocus.closeConnections(name);
      return Y.encodeStateAsUpdate(doc);
    },
    hold: (rooms) => migrations.hold(rooms),
    saveLineage: (name, state) => lineage.save(name, state),
    by: "Bob",
  };
  return {
    server,
    url: `ws://127.0.0.1:${server.address.port}`,
    workspace,
    move: (path: string, folder: string) =>
      moveModels(
        REPO,
        workspace,
        { paths: [path], folder },
        { liveDocs: () => [...liveDocs], renameLineage: (from, to) => lineage.rename(from, to), previews },
      ),
    remove: (path: string) =>
      deleteModels(
        REPO,
        workspace,
        { paths: [path] },
        { liveDocs: () => [...liveDocs], dropLineage: (name) => lineage.drop(name), previews },
      ),
  };
}

async function until(what: string, condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`not within ${timeoutMs} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const rejectsWith = (code: string) => (e: unknown) => {
  assert.ok(e instanceof AppError, `expected AppError, got ${String(e)}`);
  assert.equal(e.code, code);
  assert.equal(e.status, 409);
  return true;
};

test("a person whose state the room's awareness dropped while connected keeps the model: delete and move refuse (409)", async () => {
  const host = await liveHost();
  const alice = openLiveSession({ url: host.url, room: ORDER, token: "sess-alice", WebSocketPolyfill: WebSocket });
  sessions.push(alice);
  let closed = 0;
  alice.onDocClose(() => closed++);
  alice.setUser({ name: "Alice", color: "#335de5" });
  await alice.whenSynced();
  const doc = host.server.hocuspocus.documents.get(ORDER)!;
  const id = alice.doc.clientID;
  // her latest state, not just her first: an update still in flight would bring the state back
  await until(
    "the room holds alice's announcement",
    () =>
      (doc.awareness.getStates().get(id) as { user?: unknown } | undefined)?.user != null &&
      doc.awareness.meta.get(id)?.clock === alice.awareness?.meta.get(id)?.clock,
  );

  // what y-protocols' check interval does to a state not renewed for 30 s (a background tab whose
  // timers the browser throttles); the provider does not re-announce it until its next renewal
  removeAwarenessStates(doc.awareness, [id], "timeout");
  assert.equal(doc.awareness.getStates().has(id), false);
  assert.equal(doc.getConnectionsCount(), 1, "her editor is still connected");

  await assert.rejects(host.remove("processes/order.bpmn"), rejectsWith("delete/live-session"));
  await assert.rejects(host.move("processes/order.bpmn", "archive"), rejectsWith("move/live-session"));
  assert.ok(existsSync(join(host.workspace, "processes", "order.bpmn")), "nothing was deleted or moved");
  assert.equal(host.server.hocuspocus.documents.get(ORDER), doc, "the room stays loaded");
  assert.equal(closed, 0, "and her editor open");
});

test("a board's preview of a model (a group session announcing nobody) moves along with it, and closes with a deleted one", async () => {
  const host = await liveHost();
  const models = openLiveSessionGroup({ url: host.url, token: "sess-alice", WebSocketPolyfill: WebSocket });
  groups.push(models);
  const order = models.open(ORDER);
  const ship = models.open(SHIP);
  const notices: MovedNotice[] = [];
  let shipClosed = 0;
  order.onMoved((notice) => notices.push(notice));
  ship.onDocClose(() => shipClosed++);
  for (const session of [order, ship]) session.setUser(null);
  await Promise.all([order, ship].map((session) => session.whenSynced()));
  const states = (name: string) => host.server.hocuspocus.documents.get(name)!.awareness.getStates();
  await until(
    "the previews' states are in",
    () => states(ORDER).has(order.doc.clientID) && states(SHIP).has(ship.doc.clientID),
  );

  const moved = await host.move("processes/order.bpmn", "archive");
  assert.deepEqual(moved.moved, [{ from: "processes/order.bpmn", to: "processes/archive/order.bpmn" }]);
  await until("the board's session hears where the model went", () => notices.length === 1);
  assert.equal(notices[0]?.to, "processes/archive/order.bpmn");
  assert.equal(
    readFileSync(join(host.workspace, "processes", "archive", "order.bpmn"), "utf8"),
    FILES["processes/order.bpmn"],
  );

  const removed = await host.remove("processes/ship.bpmn");
  assert.deepEqual(removed.deleted, ["processes/ship.bpmn"]);
  await until("the deleted model's preview is closed", () => shipClosed === 1);
  assert.ok(!existsSync(join(host.workspace, "processes", "ship.bpmn")));
});
