/**
 * The room's presence across a reconnect, as openLiveSession reports it:
 * a real Hocuspocus server and real sessions over ws (#296). A writer the
 * canvas sync counts as gone does not repair, so after one side's link
 * blips both sides must see each other again as soon as it re-syncs, not
 * only after each one's next awareness renewal (15 s). A peer that left
 * meanwhile stays gone.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { type LiveSession, openLiveSession } from "@designiq/live-client";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";

const ROOM = "acme/models/processes/order.bpmn";
const servers: Server[] = [];
const sessions: LiveSession[] = [];
after(async () => {
  for (const session of sessions) session.destroy();
  await Promise.all(servers.map((server) => server.destroy()));
});

/** a session whose current socket the test can close, as a dropped link does */
function peer(port: number, name: string) {
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
    token: "any",
    WebSocketPolyfill: TrackedWebSocket,
  });
  sessions.push(session);
  session.setUser({ name, color: "#335de5" });
  let syncs = 0;
  session.onSynced(() => syncs++);
  return { session, id: session.doc.clientID, syncs: () => syncs, drop: () => sockets.at(-1)?.close() };
}

type Peer = ReturnType<typeof peer>;
const sees = (viewer: Peer, other: Peer): boolean => viewer.session.awareness?.getStates().has(other.id) ?? false;

async function until(what: string, condition: () => boolean, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`not within ${timeoutMs} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return Date.now() - start;
}

test("a link that blips: both sides see each other again once it re-syncs; a peer that left meanwhile stays gone", async () => {
  const server = new Server({ port: 0, quiet: true });
  servers.push(server);
  await server.listen();
  const { port } = server.address;
  const a = peer(port, "a");
  const b = peer(port, "b");
  const c = peer(port, "c");
  await Promise.all([a, b, c].map((p) => p.session.whenSynced()));
  await until("everyone sees everyone", () => sees(a, b) && sees(b, a) && sees(b, c), 5000);

  const synced = b.syncs();
  b.drop();
  await until("b's provider drops the others", () => !sees(b, a) && !sees(b, c), 2000);
  await until("the server drops b for a", () => !sees(a, b), 2000);
  // c's tab closes while b is offline
  c.session.destroy();
  await until("b re-syncs", () => b.syncs() > synced, 10_000);

  const took = await until("a and b see each other again", () => sees(a, b) && sees(b, a), 3000);
  assert.ok(took < 3000, `${took} ms after b's re-sync`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sees(b, c), false, "c, which left while b was offline, does not come back");
});
