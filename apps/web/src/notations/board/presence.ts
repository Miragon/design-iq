/**
 * Live presence as the board asks its host for it: publish where this person is, hear where the
 * others are. The shape of the shell's surface (lib/presence-canvas PresenceSurface), written
 * out here so that the board depends on the wire contract alone. Coordinates are the canvas's
 * own: board coordinates for the board, model coordinates for a model shown on it.
 *
 * Node-loadable: types only.
 */
import type { CanvasPresence, PresenceUser } from "@designiq/contracts/live";

/** a remote peer who announced themselves; `canvas` is absent until they move or select */
export interface BoardPeer {
  clientId: number;
  user: PresenceUser;
  canvas?: CanvasPresence;
}

export interface BoardPresence {
  /** this person's cursor and selection; null takes both back */
  setLocal(presence: CanvasPresence | null): void;
  /** calls back at once with the current peers, then on every change; returns the unsubscribe */
  onRemote(listener: (peers: BoardPeer[]) => void): () => void;
}
