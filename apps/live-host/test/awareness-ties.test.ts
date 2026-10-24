/**
 * Awareness ties (src/application/awareness-ties.ts, #310): which ws
 * connection announced which awareness client. The room cases run the REAL
 * hooks (makeCollabHooks in a real Hocuspocus server, as server.ts wires
 * them) with real sessions over ws: a peer that reconnected is tied to its
 * new connection, so get_presence names its login and a drop without a close
 * removes it at once instead of after the 30 s awareness timeout. Who may
 * take a client over runs on a real Hocuspocus Document.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { type AddressInfo, connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { type LiveSession, openLiveSession } from "@designiq/live-client";
import { Document, Server } from "@hocuspocus/server";
import WebSocket from "ws";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import type { Session } from "../src/adapters/sqlite/sessions.ts";
import { tieAnnouncedClients } from "../src/application/awareness-ties.ts";
import { makeCollabHooks } from "../src/application/collab.ts";
import { peersOfDocument } from "../src/application/room-presence.ts";
import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
};
const ROOM = `${REPO.fullName}/processes/order.bpmn`;
const SESSIONS = new Map<string, Session>(
  ["alice", "bob"].map((login) => [
    `sess-${login}`,
    { id: `sess-${login}`, user: { login, name: login, avatarUrl: null, provider: "github" }, createdAt: Date.now() },
  ]),
);

const servers: Server[] = [];
const sessions: LiveSession[] = [];
const relays: Array<{ close(): void }> = [];
after(async () => {
  for (const session of sessions) session.destroy();
  for (const relay of relays) relay.close();
  await Promise.all(servers.map((server) => server.destroy()));
});

/** a Live Host on a tmpdir content repo, its ws rooms behind the real hooks */
async function liveHost() {
  const workspace = mkdtempSync(join(tmpdir(), "designiq-ties-"));
  mkdirSync(join(workspace, "processes"));
  writeFileSync(join(workspace, "processes", "order.bpmn"), "<definitions />\n");
  const server = new Server({
    port: 0,
    quiet: true,
    ...makeCollabHooks({
      lineage: new LineageStore(new DatabaseSync(":memory:"), REPO.fullName),
      docGuard: new DocSizeGuard(8_000_000),
      maxDocBytes: 8_000_000,
      sessions: { get: (id) => (id === undefined ? undefined : SESSIONS.get(id)) },
      access: { canWrite: async () => true },
      registry: { get: (name) => (name.toLowerCase() === REPO.fullName ? REPO : undefined) },
      workspaces: { ensure: async () => workspace },
      contentConfig: () => ({ processes: "processes" }),
      liveDocs: new Set<string>(),
    }),
  });
  servers.push(server);
  await server.listen();
  return { server, port: server.address.port };
}

/**
 * A TCP relay in front of the host. `abandon` cuts the current link on the
 * peer's side only and hands back the host's side, still open and silent:
 * the host keeps a connection the peer already gave up, as after a half-open
 * link. While `down`, new links are refused.
 */
async function relay(hostPort: number) {
  const links: Array<{ peer: Socket; host: Socket; abandoned: boolean }> = [];
  const state = { down: false };
  const proxy = createServer((peerSocket) => {
    peerSocket.on("error", () => {});
    if (state.down) return void peerSocket.destroy();
    const hostSocket = connect(hostPort, "127.0.0.1");
    hostSocket.on("error", () => {});
    const link = { peer: peerSocket, host: hostSocket, abandoned: false };
    links.push(link);
    peerSocket.pipe(hostSocket);
    hostSocket.pipe(peerSocket);
    peerSocket.on("close", () => {
      if (!link.abandoned) hostSocket.destroy();
    });
    hostSocket.on("close", () => peerSocket.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const handle = {
    port: (proxy.address() as AddressInfo).port,
    goDown: () => {
      state.down = true;
    },
    abandon(): Socket {
      const link = links.at(-1)!;
      link.abandoned = true;
      link.peer.unpipe(link.host);
      link.host.unpipe(link.peer);
      link.peer.destroy();
      return link.host;
    },
    close() {
      for (const link of links) {
        link.peer.destroy();
        link.host.destroy();
      }
      proxy.close();
    },
  };
  relays.push(handle);
  return handle;
}

/** a live session whose current socket the test can terminate (no close frame) */
function peer(port: number, token: string, name: string) {
  const sockets: WebSocket[] = [];
  class TrackedWebSocket extends WebSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      sockets.push(this);
    }
  }
  const session = openLiveSession({
    url: `ws://127.0.0.1:${port}`,
    room: ROOM,
    token,
    WebSocketPolyfill: TrackedWebSocket,
  });
  sessions.push(session);
  session.setUser({ name, color: "#335de5" });
  let syncs = 0;
  session.onSynced(() => syncs++);
  return { session, id: session.doc.clientID, syncs: () => syncs, drop: () => sockets.at(-1)?.terminate() };
}

type Peer = ReturnType<typeof peer>;
const sees = (viewer: Peer, other: Peer): boolean => viewer.session.awareness?.getStates().has(other.id) ?? false;
const clockOf = (viewer: Peer, other: Peer): number => viewer.session.awareness?.meta.get(other.id)?.clock ?? -1;

/** the room's peers as get_presence reads them (server.ts: peersOf) */
const roomPeers = (server: Server) => {
  const doc = server.hocuspocus.documents.get(ROOM);
  return doc ? peersOfDocument(doc) : [];
};
const loginOf = (server: Server, p: Peer): string | undefined =>
  roomPeers(server).find((roomPeer) => roomPeer.clientId === p.id)?.login;
const connectionsOf = (server: Server): number => server.hocuspocus.documents.get(ROOM)?.getConnections().length ?? 0;

async function until(what: string, condition: () => boolean, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`not within ${timeoutMs} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return Date.now() - start;
}

test("a peer that reconnected: get_presence names its login, and its next drop removes it at once", async () => {
  const { server, port } = await liveHost();
  const link = await relay(port);
  const a = peer(port, "sess-alice", "Alice");
  const b = peer(link.port, "sess-bob", "Bob");
  await Promise.all([a, b].map((p) => p.session.whenSynced()));
  await until("a sees b", () => sees(a, b), 5000);
  assert.equal(loginOf(server, b), "bob");

  const synced = b.syncs();
  b.drop();
  await until("the host removes b after the first drop", () => !sees(a, b), 1500);
  await until("b re-syncs", () => b.syncs() > synced, 10_000);
  await until("a sees b again", () => sees(a, b), 3000);
  assert.equal(loginOf(server, b), "bob", "get_presence names the reconnected peer's login");

  // b's link stays down this time: whatever removes b is the host, not a renewal
  link.goDown();
  b.drop();
  await until("the host removes b after the drop that followed the reconnect", () => !sees(a, b), 1500);
  assert.equal(
    roomPeers(server).some((roomPeer) => roomPeer.clientId === b.id),
    false,
    "the room no longer holds b",
  );
});

test("a half-open reconnect: closing the connection the peer left behind keeps the peer in the room", async () => {
  const { server, port } = await liveHost();
  const link = await relay(port);
  const a = peer(port, "sess-alice", "Alice");
  const b = peer(link.port, "sess-bob", "Bob");
  await Promise.all([a, b].map((p) => p.session.whenSynced()));
  await until("a sees b", () => sees(a, b), 5000);

  const synced = b.syncs();
  const clock = clockOf(a, b);
  const leftBehind = link.abandon();
  await until("b re-syncs over a new connection", () => b.syncs() > synced, 10_000);
  await until("the host relays b's renewed state", () => clockOf(a, b) > clock, 3000);
  assert.equal(connectionsOf(server), 3, "the host still holds the connection b left behind");

  // the host notices at last (in production: Hocuspocus' 60 s idle check)
  leftBehind.destroy();
  await until("the host closes the connection b left behind", () => connectionsOf(server) === 2, 2000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sees(a, b), true, "b, live on its new connection, is still in the room");
  assert.equal(loginOf(server, b), "bob");
});

test("a client tied to an open connection: a connection of another login never takes it over, one of the same login does", () => {
  const doc = new Document(ROOM);
  // context as onAuthenticate admits it; address + send because the document
  // broadcasts its awareness updates to every registered connection
  const connection = (login: string) => {
    const it = { context: { user: { login, provider: "github" } }, messageAddress: ROOM, send: () => {} };
    doc.addConnection(it as never);
    return it;
  };
  const petra = connection("petra");
  const mallory = connection("mallory");
  const petraAgain = connection("petra");
  const tab = new Awareness(new Y.Doc());
  try {
    tab.setLocalState({ user: { name: "Petra", color: "#fa8100" } });
    applyAwarenessUpdate(doc.awareness, encodeAwarenessUpdate(tab, [tab.clientID]), {
      source: "connection",
      connection: petra,
    });
    assert.equal(doc.getClients(petra as never).has(tab.clientID), true, "Hocuspocus ties a client it has not seen");

    tieAnnouncedClients({ document: doc, connection: mallory, added: [], updated: [tab.clientID] });
    assert.equal(doc.getClients(petra as never).has(tab.clientID), true);
    assert.equal(doc.getClients(mallory as never).has(tab.clientID), false, "nobody wears Petra's login");

    tieAnnouncedClients({ document: doc, connection: petraAgain, added: [], updated: [tab.clientID] });
    assert.equal(doc.getClients(petra as never).has(tab.clientID), false);
    assert.equal(doc.getClients(petraAgain as never).has(tab.clientID), true, "Petra's newer connection holds it");
  } finally {
    tab.destroy();
    // Hocuspocus' Document.destroy() leaves the y-protocols check interval
    // running: the suite must end its own awareness or the runner never exits
    doc.awareness.destroy();
    doc.destroy();
  }
});
