/**
 * Room presence (src/application/room-presence.ts) — peersOfDocument and
 * attendedDocument against a REAL Hocuspocus Document (the awareness +
 * connection bookkeeping the server composes over), roomPresence over raw
 * peers. The move/delete gates over a real server: preview-rooms.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Document } from "@hocuspocus/server";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

import { AgentPresence } from "../src/application/agent-presence.ts";
import { attendedDocument, peersOfDocument, roomPresence } from "../src/application/room-presence.ts";

const ROOM = "acme/models/processes/order.bpmn";

/** a peer's state lands in the document's awareness the way a ws message
 *  would: encoded from the peer's own Awareness (its clientID), applied to
 *  the document's. Returns the peer's clientID. */
function announce(doc: Document, state: Record<string, unknown>): number {
  const peer = new Awareness(new Y.Doc());
  peer.setLocalState(state);
  applyAwarenessUpdate(doc.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), { source: "local" });
  const id = peer.clientID;
  peer.destroy();
  return id;
}

/** the connection bookkeeping Hocuspocus keeps per ws connection */
function connect(doc: Document, login: string, clientIds: number[]): void {
  // context as onAuthenticate admits it; address + send because the document
  // broadcasts its (flushed) awareness updates to every registered connection
  const connection = { context: { user: { login, provider: "github" } }, messageAddress: doc.name, send: () => {} };
  doc.connections.set(connection as never, { clients: new Set(clientIds) });
}

test("peersOfDocument: every peer state, stamped with the login of the connection that announced it", () => {
  const doc = new Document(ROOM);
  const petra = announce(doc, {
    user: { name: "Petra", color: "#fa8100" },
    canvas: { cursor: null, selection: ["A"] },
  });
  const kai = announce(doc, { user: { name: "Kai", color: "#0aa2c0" } });
  connect(doc, "petra", [petra]);
  connect(doc, "kai", [kai]);
  // a server-published agent lease has no connection behind it
  const agents = new AgentPresence({ awarenessOf: (r) => (r === ROOM ? doc.awareness : undefined) });
  agents.touch(ROOM, { login: "kai", name: "Kai" });

  const peers = peersOfDocument(doc).sort((a, b) => a.clientId - b.clientId);
  assert.equal(peers.length, 3);
  const byId = new Map(peers.map((p) => [p.clientId, p]));
  assert.equal(byId.get(petra)?.login, "petra");
  assert.equal(byId.get(kai)?.login, "kai");
  const agent = peers.find((p) => p.clientId !== petra && p.clientId !== kai)!;
  assert.equal(agent.login, undefined, "no ws connection — no server-side identity");
  assert.equal((agent.state as { user: { kind: string } }).user.kind, "agent");

  agents.destroy();
  // Hocuspocus' Document.destroy() leaves the y-protocols check interval
  // running — the suite must end its own awareness or the runner never exits
  doc.awareness.destroy();
  doc.destroy();
});

test("roomPresence: sanitized peers, `you` on the caller's own HUMAN presence only, un-announced skipped", () => {
  const peers = roomPresence(
    {
      peersOf: () => [
        {
          clientId: 1,
          login: "petra",
          state: { user: { name: "Petra", color: "#fa8100" }, canvas: { cursor: { x: 1, y: 2 }, selection: ["A", 7] } },
        },
        { clientId: 2, login: "petra", state: { user: { name: "AI · Petra", color: "#000", kind: "agent" } } },
        { clientId: 3, login: "kai", state: { user: { name: "Kai", color: "#000", kind: "robot" }, canvas: "nope" } },
        { clientId: 4, login: "mia", state: { selection: { anchor: 1 } } },
        { clientId: 5, state: null },
      ],
    },
    ROOM,
    "petra",
  );
  assert.deepEqual(peers, [
    { name: "Petra", kind: "human", you: true, selection: ["A"], cursor: { x: 1, y: 2 } },
    { name: "AI · Petra", kind: "agent", you: false, selection: [], cursor: null },
    { name: "Kai", kind: "human", you: false, selection: [], cursor: null },
  ]);
  assert.deepEqual(roomPresence({}, ROOM, "petra"), [], "no port = nobody");
});

test("attendedDocument: a board's preview and an agent's lease are nobody; an announced person is someone", (t) => {
  const doc = new Document(ROOM);
  t.after(() => {
    doc.awareness.destroy(); // the check interval Document.destroy() leaves running (see above)
    doc.destroy();
  });
  assert.equal(attendedDocument(doc), false, "no connection: nobody");
  // a board showing the model announces nobody (live-client setUser(null))
  const preview = announce(doc, { user: null, canvas: null });
  connect(doc, "petra", [preview]);
  // a client that announced a state without a user field yet is no person either
  const bare = announce(doc, {});
  connect(doc, "petra", [bare]);
  const agents = new AgentPresence({ awarenessOf: (r) => (r === ROOM ? doc.awareness : undefined) });
  agents.touch(ROOM, { login: "petra", name: "Petra" });
  assert.equal(attendedDocument(doc), false, "previews and an agent: nobody is in the room");
  // a malformed user (no colour) is no announcement
  const malformed = announce(doc, { user: { name: "X" } });
  connect(doc, "kai", [malformed]);
  assert.equal(attendedDocument(doc), false);
  // the moment a node is armed, the person announces themselves
  const armed = announce(doc, { user: { name: "Petra", color: "#fa8100" } });
  connect(doc, "petra", [armed]);
  assert.equal(attendedDocument(doc), true);
  agents.destroy();
});

test("attendedDocument fails closed: a connection that has not announced itself, or whose state timed out, is a person", (t) => {
  const doc = new Document(ROOM);
  t.after(() => {
    doc.awareness.destroy(); // the check interval Document.destroy() leaves running (see above)
    doc.destroy();
  });
  const preview = announce(doc, { user: null });
  connect(doc, "petra", [preview]);
  assert.equal(attendedDocument(doc), false);
  // connected, yet no awareness state sent so far: maybe a person whose editor is still starting
  const silent = { context: { user: { login: "kai", provider: "github" } }, messageAddress: doc.name, send: () => {} };
  doc.connections.set(silent as never, { clients: new Set() });
  assert.equal(attendedDocument(doc), true, "a connection without a state");
  doc.connections.delete(silent as never);

  // a person in a background tab: the browser throttles its renewals, so the room's awareness
  // drops the state after 30 s ('timeout') while the connection stays open; Hocuspocus keeps
  // the client tied to it, since the removal did not come over that connection
  const alice = announce(doc, { user: { name: "Alice", color: "#335de5" } });
  connect(doc, "alice", [alice]);
  assert.equal(attendedDocument(doc), true);
  removeAwarenessStates(doc.awareness, [alice], "timeout");
  assert.equal(doc.awareness.getStates().has(alice), false);
  assert.equal(attendedDocument(doc), true, "her editor is still connected");
  // a board's preview whose state timed out the same way refuses as well (the old, safe behaviour)
  doc.connections.clear();
  connect(doc, "petra", [preview]);
  removeAwarenessStates(doc.awareness, [preview], "timeout");
  assert.equal(attendedDocument(doc), true);
});

test("attendedDocument fails closed: a direct connection of the host's own (a REST or MCP save on its way) attends the room", (t) => {
  const doc = new Document(ROOM);
  t.after(() => {
    doc.awareness.destroy();
    doc.destroy();
  });
  // a board's preview alone: nobody
  connect(doc, "petra", [announce(doc, { user: null, canvas: null })]);
  assert.equal(attendedDocument(doc), false);
  // a save through hocuspocus.openDirectConnection is counted, never listed as a connection
  doc.addDirectConnection();
  assert.equal(attendedDocument(doc), true, "a move or delete must not retire the room under the save");
  doc.removeDirectConnection();
  assert.equal(attendedDocument(doc), false, "once it is through, the preview alone is nobody again");
});
