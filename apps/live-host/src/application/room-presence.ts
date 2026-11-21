/**
 * Room presence read-model — who is in a model's live room right now, for the
 * MCP get_presence tool: every person with the model open (name, selection,
 * pointer) and the AI clients acting in it (application/agent-presence.ts).
 *
 * The identity behind a peer comes from the SERVER, never from the payload:
 * Hocuspocus records which ws connection announced which awareness clientId,
 * and the connection carries the user onAuthenticate admitted. That is what
 * makes `you` trustworthy — the caller's own human presence, the person the
 * agent acts for — so "the element I selected" resolves to a real selection.
 *
 * Also whether a person may be in a room at all (attendedDocument), for the
 * move/delete gates and the overview counts: a board's preview of a model
 * holds the room without being in it.
 *
 * Reads a LOADED document only (server.ts composes peersOf and attended over
 * hocuspocus.documents): an unloaded room has nobody in it by definition, and
 * answering must never load one.
 */
import type { PresencePeerWire } from "@designiq/contracts/live-host";
import { sanitizeCanvas, sanitizeUser } from "@designiq/live-client/presence";

/** one raw awareness state of a room + the login of the ws connection that
 *  announced it (absent for server-published states — the agent leases) */
export interface RoomPeer {
  clientId: number;
  login?: string;
  state: unknown;
}

export interface RoomPresenceDeps {
  /** the raw peers of a LOADED room; [] (or absent) = nobody has it open */
  peersOf?: (room: string) => RoomPeer[];
}

/** the minimal structural surface of a Hocuspocus Document this reads */
export interface RoomDocLike {
  awareness: { clientID: number; getStates(): Map<number, unknown> };
  getConnections(): Array<{ context?: unknown }>;
  getClients(connection: { context?: unknown }): Set<number>;
  /** the ws connections AND the server's own direct ones (Hocuspocus
   *  Document.getConnectionsCount); absent = no direct connections known */
  getConnectionsCount?(): number;
}

/** the login onAuthenticate admitted on a ws connection */
export function connectionLogin(connection: { context?: unknown }): string | undefined {
  const login = (connection.context as { user?: { login?: unknown } } | undefined)?.user?.login;
  return typeof login === "string" ? login : undefined;
}

/** every awareness state of a loaded document except the document's own,
 *  stamped with the announcing connection's login */
export function peersOfDocument(doc: RoomDocLike): RoomPeer[] {
  const loginOf = new Map<number, string>();
  for (const connection of doc.getConnections()) {
    const login = connectionLogin(connection);
    if (login === undefined) continue;
    for (const clientId of doc.getClients(connection)) loginOf.set(clientId, login);
  }
  const peers: RoomPeer[] = [];
  for (const [clientId, state] of doc.awareness.getStates()) {
    if (clientId === doc.awareness.clientID) continue;
    const login = loginOf.get(clientId);
    peers.push({ clientId, ...(login !== undefined ? { login } : {}), state });
  }
  return peers;
}

/** whether an awareness state announces a human user (an agent's is none) */
function announcesPerson(state: unknown): boolean {
  const user = sanitizeUser((state as { user?: unknown } | null | undefined)?.user);
  return user !== undefined && user.kind !== "agent";
}

/**
 * Whether a PERSON may be in a loaded room; the move/delete gates and the
 * overview counts ask this. It fails closed, per ws connection: only a
 * connection whose awareness clients all still have a state, none of them
 * announcing a human user, is no person. That is a board showing the model
 * as a preview (@designiq/live-client setUser(null)). A room holding only
 * such connections, or none (an agent's lease, application/agent-presence.ts,
 * holds no connection), is nobody's.
 *
 * Every other connection counts as a person: one that has not announced
 * itself yet, and one whose state the room's awareness dropped while it
 * stayed connected. The latter is an editor in a background tab whose timers
 * the browser throttles: it renews its state late, y-protocols drops it after
 * 30 s ('timeout'), and the provider does not re-announce it until its next
 * renewal. Hocuspocus keeps such a client tied to its connection (it unties
 * only on a removal that came over that connection), so the gap shows here.
 */
export function attendedDocument(doc: RoomDocLike): boolean {
  const connections = doc.getConnections();
  // a direct connection is the host's own: a REST or MCP read or save on its
  // way through this room. It announces nobody, and a move or delete that
  // retired the room under it would lose that save, so it attends the room
  if ((doc.getConnectionsCount?.() ?? connections.length) > connections.length) return true;
  const states = doc.awareness.getStates();
  return connections.some((connection) => {
    const clients = [...doc.getClients(connection)];
    return clients.length === 0 || clients.some((id) => !states.has(id) || announcesPerson(states.get(id)));
  });
}

/** the room's peers as the tool answers them — un-announced peers (no user
 *  field yet) are not there to speak of */
export function roomPresence(deps: RoomPresenceDeps, room: string, callerLogin: string): PresencePeerWire[] {
  const out: PresencePeerWire[] = [];
  for (const peer of deps.peersOf?.(room) ?? []) {
    const s = peer.state as { user?: unknown; canvas?: unknown } | null | undefined;
    const user = sanitizeUser(s?.user);
    if (!user) continue;
    const canvas = sanitizeCanvas(s?.canvas) ?? { cursor: null, selection: [] };
    const kind = user.kind === "agent" ? "agent" : "human";
    out.push({
      name: user.name,
      kind,
      you: kind === "human" && peer.login === callerLogin,
      selection: canvas.selection,
      cursor: canvas.cursor,
    });
  }
  return out;
}
