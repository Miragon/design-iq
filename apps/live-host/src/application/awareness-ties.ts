/**
 * Awareness ties — which ws connection announced which awareness client.
 *
 * Hocuspocus keeps that tie per document (`getClients(connection)`): it is
 * where get_presence reads a peer's login from (room-presence.ts), and closing
 * a connection removes the states of exactly the clients tied to it, so a
 * dropped link leaves the room at once instead of after the 30 s awareness
 * timeout. But Hocuspocus 4.7.1 ties a client only when the room's awareness
 * reports it ADDED, and y-protocols reports a client it has seen before as
 * UPDATED (it keeps a removed client's clock). A peer that reconnected was
 * therefore never tied again (#310): its next drop took the timeout, and
 * get_presence could not name its login.
 *
 * So every client a connection announces is tied to it, unless another open
 * connection holds it. That tie moves only between connections of the same
 * login: after a half-open link (the client reconnected before the host
 * noticed the old socket died) the client must not stay on the dead
 * connection, whose eventual close would remove the live client until its
 * next renewal (15 s). A connection of another login never takes a client
 * over, so nobody wears another person's login by replaying their client id.
 */
import { connectionLogin, type RoomDocLike } from "./room-presence.ts";

/** the connection bookkeeping of a Hocuspocus Document this writes:
 *  `getClients` hands out the document's own Set, the one a close empties */
export interface TiedDocLike extends RoomDocLike {
  hasConnection(connection: { context?: unknown }): boolean;
}

/** the part of Hocuspocus' onAwarenessUpdate payload this reads */
export interface AwarenessAnnouncement {
  document: TiedDocLike;
  /** absent when the update did not come over a ws connection (an agent
   *  lease, a timeout, a close) */
  connection?: { context?: unknown };
  added: number[];
  updated: number[];
}

export function tieAnnouncedClients({ document, connection, added, updated }: AwarenessAnnouncement): void {
  // a connection that closed meanwhile hands out a fresh Set nobody reads
  if (!connection || !document.hasConnection(connection)) return;
  const tied = document.getClients(connection);
  const login = connectionLogin(connection);
  for (const clientId of [...added, ...updated]) {
    if (tied.has(clientId) || !document.awareness.getStates().has(clientId)) continue;
    const holder = document
      .getConnections()
      .find((other) => other !== connection && document.getClients(other).has(clientId));
    if (holder) {
      if (login === undefined || connectionLogin(holder) !== login) continue;
      document.getClients(holder).delete(clientId);
    }
    tied.add(clientId);
  }
}
