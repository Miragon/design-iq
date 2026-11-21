/**
 * The board's two presence adapters:
 * - boardPresence: the people who have THIS board open, from the board room's own awareness
 *   (the shell's PresenceSurface, EditorContext.presence), as the board draws them.
 * - modelPresence: a MODEL room's surface for the product editor of a node. It publishes this
 *   person's cursor and selection there only while the node is armed, and draws only the peers
 *   who announced themselves: whoever merely has a board open that shows the model is nobody in
 *   that room.
 * Node-loadable.
 */
import type { LiveSession } from "@designiq/live-client";
import type { BoardPresence } from "@miragon/board-renderer";

import type { PresenceSurface } from "../../lib/presence-canvas.ts";

export function boardPresence(surface: PresenceSurface): BoardPresence {
  return {
    setLocal: (presence) => surface.setLocal(presence),
    onRemote: (listener) =>
      surface.onRemote((peers) =>
        listener(
          peers.map(({ clientId, user, canvas }) => ({
            clientId,
            // the name and the colour (the board sanitises both), and an agent's server-asserted kind
            user: { name: user.name, color: user.color, ...(user.kind ? { kind: user.kind } : {}) },
            ...(canvas ? { canvas } : {}),
          })),
        ),
      ),
  };
}

export function modelPresence(
  session: Pick<LiveSession, "setCanvasPresence" | "onAwarenessStates">,
  armed: () => boolean,
): PresenceSurface {
  return {
    // a preview takes no pointer, and whoever only looks is in nobody's way
    setLocal: (canvas) => session.setCanvasPresence(armed() ? canvas : null),
    onRemote: (listener) =>
      session.onAwarenessStates((peers) =>
        listener(
          peers.flatMap(({ clientId, user, canvas }) =>
            user ? [{ clientId, user, ...(canvas ? { canvas } : {}) }] : [],
          ),
        ),
      ),
  };
}
