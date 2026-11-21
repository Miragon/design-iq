/**
 * openLiveSessionGroup (@designiq/live-client) against the Live Host's REAL
 * room hooks in a real Hocuspocus server, over ws: a board holds one live
 * session per model it shows, all on one socket (LIVE_MAX_WS_PER_IP counts
 * sockets). Each session is a client of its room of its own, with a session
 * id on the wire (documentName\0sessionId), which the hooks must read as the
 * plain room name.
 *
 * Pinned: several rooms over one socket, each authenticated and synced on
 * its own, a refused room failing alone; a session's destroy closes its
 * document and leaves the socket to the others; two sessions of ONE room
 * (two nodes on one model) both sync and converge, and either survives the
 * other's destroy; setUser(null) takes the person out of the room's roster
 * and out of get_presence; a rename's moved notice reaches a session of the
 * group, whose document then closes while the others keep syncing; the
 * group's destroy ends every session and the socket.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import {
  type LiveSession,
  type LiveSessionGroup,
  type MovedNotice,
  openLiveSession,
  openLiveSessionGroup,
  type PresenceUser,
} from "@designiq/live-client";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";
import * as Y from "yjs";

import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import type { Session } from "../src/adapters/sqlite/sessions.ts";
import { makeCollabHooks } from "../src/application/collab.ts";
import { RoomMigrations } from "../src/application/room-migrations.ts";
import { peersOfDocument, roomPresence } from "../src/application/room-presence.ts";
import { renameModel } from "../src/application/scaffold.ts";
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
const CREDIT = room("processes/credit.dmn");
const SHIP = room("processes/ship.bpmn");
const FILES: Record<string, string> = {
  "processes/order.bpmn": '<definitions id="order" />\n',
  "processes/credit.dmn": '<definitions id="credit" />\n',
  "processes/ship.bpmn": '<definitions id="ship" />\n',
};
const SESSIONS = new Map<string, Session>(
  ["alice", "bob"].map((login) => [
    `sess-${login}`,
    { id: `sess-${login}`, user: { login, name: login, avatarUrl: null, provider: "github" }, createdAt: Date.now() },
  ]),
);
const ALICE: PresenceUser = { name: "Alice", color: "#335de5" };

const servers: Server[] = [];
const groups: LiveSessionGroup[] = [];
const sessions: LiveSession[] = [];
after(async () => {
  for (const group of groups) group.destroy();
  for (const session of sessions) session.destroy();
  await Promise.all(servers.map((server) => server.destroy()));
});

/** a Live Host on a tmpdir content repo, its ws rooms behind the real hooks, renames wired as server.ts wires them */
async function liveHost() {
  const workspace = mkdtempSync(join(tmpdir(), "designiq-group-"));
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
  let upgrades = 0;
  server.httpServer.on("upgrade", () => upgrades++);
  await server.listen();
  return {
    server,
    url: `ws://127.0.0.1:${server.address.port}`,
    workspace,
    liveDocs,
    upgrades: () => upgrades,
    /** ws connections the room's document holds, one per session */
    connectionsOf: (name: string): number => server.hocuspocus.documents.get(name)?.getConnectionsCount() ?? 0,
    /** rename a model as the REST route does: an open room is retired (server.ts rooms.retire) */
    rename: (path: string, name: string) =>
      renameModel(REPO, workspace, { path, name }, "Petra", {
        liveDocs: () => [...liveDocs],
        rooms: {
          retire: (name, notice) => {
            const doc = server.hocuspocus.documents.get(name);
            if (!doc) return undefined;
            migrations.retire(name);
            doc.broadcastStateless(notice);
            server.hocuspocus.closeConnections(name);
            return Y.encodeStateAsUpdate(doc);
          },
          hold: (rooms) => migrations.hold(rooms),
        },
        lineage,
        editContent: async () => {
          throw new Error("no model calls the renamed one");
        },
      }),
  };
}

/** a WebSocket implementation that counts the sockets a client opens */
function countingSockets() {
  const sockets: WebSocket[] = [];
  class CountedWebSocket extends WebSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      sockets.push(this);
    }
  }
  return { WebSocketPolyfill: CountedWebSocket, sockets };
}

function group(url: string, token = "sess-alice") {
  const counted = countingSockets();
  const handle = openLiveSessionGroup({ url, token, WebSocketPolyfill: counted.WebSocketPolyfill });
  groups.push(handle);
  return { group: handle, sockets: counted.sockets };
}

/** a client that holds the room on a socket of its own, as the web editor does */
function peer(url: string, name: string, token = "sess-bob"): LiveSession {
  const session = openLiveSession({ url, room: name, token, WebSocketPolyfill: WebSocket });
  sessions.push(session);
  return session;
}

const textOf = (session: LiveSession): string => session.content.toString();
/** an edit at the end of the room's text */
const append = (session: LiveSession, what: string): void => session.content.insert(session.content.length, what);

async function until(what: string, condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`not within ${timeoutMs} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("several rooms on one socket, each synced on its own; a refused room fails alone; a session's destroy closes its document only", async () => {
  const host = await liveHost();
  const { group: models, sockets } = group(host.url);
  const order = models.open(ORDER);
  const credit = models.open(CREDIT);
  const ship = models.open(SHIP);
  const refused: string[] = [];
  const stranger = models.open("stranger/repo/processes/x.bpmn", { onAuthenticationFailed: (r) => refused.push(r) });
  await Promise.all([order, credit, ship].map((session) => session.whenSynced()));
  await assert.rejects(stranger.whenSynced(), /auth failed/);
  assert.equal(refused.length, 1, "the refused session is told");

  assert.equal(sockets.length, 1, "one socket on the client");
  assert.equal(host.upgrades(), 1, "and one on the host");
  assert.deepEqual(
    [order, credit, ship].map(textOf),
    [FILES["processes/order.bpmn"], FILES["processes/credit.dmn"], FILES["processes/ship.bpmn"]],
    "each room seeded from its own file",
  );
  // the hooks saw the plain room names, never the session ids on the wire
  assert.deepEqual([...host.liveDocs].sort(), [CREDIT, ORDER, SHIP]);
  assert.deepEqual([...host.server.hocuspocus.documents.keys()].sort(), [CREDIT, ORDER, SHIP]);

  // an edit reaches its room's other clients, and no other room on the socket
  const bob = peer(host.url, ORDER);
  await bob.whenSynced();
  append(bob, "<!-- bob -->");
  await until("order takes bob's edit in", () => textOf(order).endsWith("<!-- bob -->"));
  append(order, "<!-- alice -->");
  await until("bob takes alice's edit in", () => textOf(bob).endsWith("<!-- alice -->"));
  assert.deepEqual([credit, ship].map(textOf), [FILES["processes/credit.dmn"], FILES["processes/ship.bpmn"]]);

  credit.destroy();
  credit.destroy();
  await until("the host closes credit's document", () => host.connectionsOf(CREDIT) === 0);
  assert.equal(sockets[0]?.readyState, WebSocket.OPEN, "the socket stays for the others");
  append(bob, "<!-- after -->");
  await until("order keeps syncing", () => textOf(order).endsWith("<!-- after -->"));
  assert.equal(host.connectionsOf(SHIP), 1);
  assert.equal(sockets.length, 1);
  bob.destroy();
});

test("two sessions of ONE room in a group both sync and converge; either keeps syncing once the other is gone", async () => {
  const host = await liveHost();
  const { group: models, sockets } = group(host.url);
  const first = models.open(ORDER);
  const second = models.open(ORDER);
  const bob = peer(host.url, ORDER);
  await Promise.all([first, second, bob].map((session) => session.whenSynced()));
  assert.equal(sockets.length, 1);
  assert.equal(host.connectionsOf(ORDER), 3, "each session is a client of the room of its own");
  assert.notEqual(first.doc.clientID, second.doc.clientID);

  append(first, "<!-- first -->");
  append(second, "<!-- second -->");
  append(bob, "<!-- bob -->");
  const converged = () => {
    const texts = [first, second, bob].map(textOf);
    return texts.every((text) => text === texts[0]) && ["first", "second", "bob"].every((w) => texts[0]!.includes(w));
  };
  await until("the three converge on all three edits", converged);

  // a node added once the others synced (Hocuspocus refuses a second provider of an authenticated name)
  const late = models.open(ORDER);
  await late.whenSynced();
  assert.equal(textOf(late), textOf(second));
  assert.equal(host.connectionsOf(ORDER), 4);

  first.destroy();
  await until("the host lets the first session go", () => host.connectionsOf(ORDER) === 3);
  append(bob, "<!-- later -->");
  await until("the twins keep syncing", () => [second, late].every((s) => textOf(s).endsWith("<!-- later -->")));
  append(second, "<!-- reply -->");
  await until("and their edits reach the room", () => textOf(bob).endsWith("<!-- reply -->"));
  assert.ok(!textOf(first).includes("later"), "the session that was destroyed takes nothing in");
  assert.equal(sockets.length, 1);
  bob.destroy();
});

test("setUser(null) takes the person out of a peer's roster and out of get_presence; setUser brings them back", async () => {
  const host = await liveHost();
  const { group: models } = group(host.url);
  const shown = models.open(ORDER);
  const bob = peer(host.url, ORDER);
  bob.setUser({ name: "Bob", color: "#335de5" });
  let roster: string[] = [];
  bob.onPresence((users) => (roster = users.map((user) => user.name).sort()));
  await Promise.all([shown, bob].map((session) => session.whenSynced()));
  const presence = (login: string) =>
    roomPresence({ peersOf: (name) => peersOfDocument(host.server.hocuspocus.documents.get(name)!) }, ORDER, login).map(
      (p) => `${p.name}${p.you ? " (you)" : ""}`,
    );

  shown.setUser(ALICE);
  await until("bob sees alice", () => roster.includes("Alice"));
  await until("get_presence names alice", () => presence("alice").includes("Alice (you)"));

  shown.setUser(null);
  await until("alice leaves bob's roster", () => roster.join() === "Bob");
  await until("and get_presence", () => !presence("alice").some((p) => p.startsWith("Alice")));
  assert.equal(host.connectionsOf(ORDER), 2, "the session still holds the room");

  shown.setUser(ALICE);
  await until("alice is back", () => roster.join() === "Alice,Bob");
  bob.destroy();
});

test("a rename's moved notice reaches a session of the group; its document closes, the group's others keep syncing", async () => {
  const host = await liveHost();
  const { group: models, sockets } = group(host.url);
  const order = models.open(ORDER);
  const credit = models.open(CREDIT);
  const bob = peer(host.url, CREDIT);
  const notices: MovedNotice[] = [];
  let closed = 0;
  order.onMoved((notice) => notices.push(notice));
  order.onDocClose(() => closed++);
  await Promise.all([order, credit, bob].map((session) => session.whenSynced()));
  append(order, "<!-- live, not yet written -->");
  await until("the host holds the edit", () =>
    host.server.hocuspocus.documents.get(ORDER)!.getText("content").toString().includes("not yet written"),
  );

  const out = await host.rename("processes/order.bpmn", "order to cash");
  assert.equal(out.path, "processes/order-to-cash.bpmn");
  await until("the notice arrives", () => notices.length === 1);
  const [notice] = notices;
  assert.deepEqual(notice && { to: notice.to, room: notice.room, by: notice.by }, {
    to: "processes/order-to-cash.bpmn",
    room: room("processes/order-to-cash.bpmn"),
    by: "Petra",
  });
  await until("the moved room's document closes", () => closed === 1);
  assert.equal(sockets[0]?.readyState, WebSocket.OPEN, "the socket stays");

  append(bob, "<!-- credit goes on -->");
  await until("credit keeps syncing", () => textOf(credit).endsWith("<!-- credit goes on -->"));
  // the node follows the model: its new room opens over the same socket, with the live state
  const moved = models.open(room("processes/order-to-cash.bpmn"));
  await moved.whenSynced();
  assert.ok(textOf(moved).includes("not yet written"));
  assert.match(readFileSync(join(host.workspace, "processes", "order-to-cash.bpmn"), "utf8"), /not yet written/);
  assert.equal(sockets.length, 1);
  bob.destroy();
});

test("the group's destroy ends every session and the socket; it is safe twice, and the group opens nothing after it", async () => {
  const host = await liveHost();
  const { group: models, sockets } = group(host.url);
  const order = models.open(ORDER);
  const twin = models.open(ORDER);
  const ship = models.open(SHIP);
  await Promise.all([order, twin, ship].map((session) => session.whenSynced()));
  assert.equal(host.connectionsOf(ORDER) + host.connectionsOf(SHIP), 3);

  ship.destroy();
  models.destroy();
  models.destroy();
  order.destroy();
  await until("the host has no connection left", () => host.server.hocuspocus.getConnectionsCount() === 0);
  await until("the socket is closed", () => sockets[0]?.readyState === WebSocket.CLOSED);
  assert.throws(() => models.open(ORDER), /destroyed/);
  assert.equal(sockets.length, 1, "no socket opened again");
});
