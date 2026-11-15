/**
 * openLiveSession — the ONE place a designIQ client opens a collaborative session
 * against the Live Host. Previously this Hocuspocus wiring existed three times
 * (web editor, VS Code extension, headless guest test) with drift between them.
 *
 * Socket policy: one HocuspocusProviderWebsocket PER session, owned by the
 * session — exactly what every pre-extraction call site did (none shared a
 * socket across providers; the VS Code extension opens one socket per document).
 * destroy() therefore always tears down provider AND socket; the extension's
 * old dispose path destroyed only providers and leaked the sockets.
 */
import {
  AWARENESS_CANVAS_KEY,
  AWARENESS_USER_KEY,
  type CanvasPresence,
  CONTENT_KEY,
  type MovedNotice,
  parseMovedNotice,
  type PresenceUser,
  roomName,
} from "@designiq/contracts/live";
import { HocuspocusProvider, HocuspocusProviderWebsocket, WebSocketStatus } from "@hocuspocus/provider";
import type * as Y from "yjs";

import { sanitizeCanvas, sanitizeUser } from "./presence.ts";

// what a consumer hands the canvas sync bridges from this session (its awareness)
export type { FitInsets, PeerAwareness, SyncOptions } from "./model-sync.ts";

// re-exported so session consumers don't need a second import for the contract
export { type CanvasPresence, CONTENT_KEY, type MovedNotice, type PresenceUser, roomName };

export interface LiveSessionOptions {
  /** WebSocket URL of the Live Host */
  url: string;
  /** room name — build it with roomName(repoFullName, repoRelativePath) */
  room: string;
  token: string;
  /** Node consumers pass the `ws` implementation; browsers omit it */
  WebSocketPolyfill?: unknown;
  onAuthenticationFailed?: (reason: string) => void;
}

/** the provider's awareness handle (y-protocols Awareness | null) */
export type LiveAwareness = HocuspocusProvider["awareness"];

/** one REMOTE client's awareness state */
export interface AwarenessPeer {
  clientId: number;
  user?: PresenceUser;
  canvas?: CanvasPresence;
}

// awareness payloads are PEER INPUT — the sanitizers live in ./presence.ts
// (dependency-free: the Live Host reads room presence through them too) and
// are re-exported here for the session consumers and the tests
export { sanitizeCanvas, sanitizeUser } from "./presence.ts";

export interface LiveSession {
  readonly doc: Y.Doc;
  /** the ONE Y.Text carrying the document content (CONTENT_KEY) */
  readonly content: Y.Text;
  readonly awareness: LiveAwareness;
  /** event form — fires on every (re)sync; returns the unsubscribe */
  onSynced(cb: () => void): () => void;
  /** fires whenever the ws connection closes (the provider auto-reconnects
   *  and re-authenticates on its own); returns the unsubscribe */
  onDisconnect(cb: () => void): () => void;
  /** fires when the server closes THIS document over a still-open socket
   *  (doc-level CLOSE message, e.g. after rejecting an oversized update) —
   *  the provider does NOT re-sync after it; returns the unsubscribe.
   *  Plain ws drops never reach this callback (they auto-reconnect and
   *  re-sync — that's onDisconnect's lane), even though the provider
   *  re-emits them on the same underlying "close" event. */
  onDocClose(cb: () => void): () => void;
  /** fires when the document's file was renamed (#208): the Live Host closes
   *  this room right after — reopen the document at `notice.to` (its history
   *  moved along). Returns the unsubscribe. */
  onMoved(cb: (notice: MovedNotice) => void): () => void;
  /** promise form — resolves on first sync, rejects on auth failure or timeout */
  whenSynced(timeoutMs?: number): Promise<void>;
  /** announce who this client is in the room's roster; null takes the
   *  announcement back (a client that holds the room without being in it: a
   *  board that shows a model nobody edits there right now) */
  setUser(user: PresenceUser | null): void;
  /** publish the local canvas presence (cursor + selection, model coords) —
   *  its own awareness field, never colliding with y-monaco's "selection" */
  setCanvasPresence(presence: CanvasPresence | null): void;
  /** presence roster (awareness "user" fields); calls back immediately, returns the unsubscribe */
  onPresence(cb: (users: PresenceUser[]) => void): () => void;
  /** REMOTE awareness states (self excluded), clientId-keyed — the surface
   *  cursors/selections render from; calls back immediately, returns the
   *  unsubscribe */
  onAwarenessStates(cb: (peers: AwarenessPeer[]) => void): () => void;
  /** tears down the provider, and the socket with it where the session owns
   *  it (openLiveSession); a session of a group leaves the socket to the
   *  others. Safe to call twice */
  destroy(): void;
}

/**
 * y-protocols takes a client in only on a newer awareness clock. When a link
 * drops, the provider removes every peer and the server removes this client,
 * and both keep the clocks; on reconnect each side repeats the same clocks
 * and is ignored, so the two count each other as gone until each renews its
 * state (every 15 s). A writer counted as gone does not repair a broken merge
 * (model-sync rule 4, #296), and the roster shows the peers gone meanwhile.
 * Forgetting the dropped peers' clocks takes in the room's snapshot on
 * reconnect; a newer own clock on every (re)sync makes the room take this
 * client in again. A peer that left meanwhile is not in the snapshot and
 * stays gone.
 */
function keepPresenceAcrossReconnects(provider: HocuspocusProvider): void {
  provider.on("close", () => {
    const awareness = provider.awareness;
    if (!awareness) return;
    for (const clientId of [...awareness.meta.keys()]) {
      if (clientId !== awareness.clientID && !awareness.getStates().has(clientId)) awareness.meta.delete(clientId);
    }
  });
  provider.on("synced", () => {
    const awareness = provider.awareness;
    const own = awareness?.getLocalState();
    if (awareness && own) awareness.setLocalState(own);
  });
}

const openSocket = (opts: Pick<LiveSessionOptions, "url" | "WebSocketPolyfill">): HocuspocusProviderWebsocket =>
  new HocuspocusProviderWebsocket({
    url: opts.url,
    // only forward the polyfill when given — an explicit `undefined` would
    // override the provider's own browser-WebSocket default
    ...(opts.WebSocketPolyfill !== undefined ? { WebSocketPolyfill: opts.WebSocketPolyfill } : {}),
  });

export function openLiveSession(opts: LiveSessionOptions): LiveSession {
  const socket = openSocket(opts);
  // the session owns its socket: destroy() tears down both
  return sessionOn(socket, opts, () => socket.destroy());
}

/** what every session of a group shares */
export type LiveSessionGroupOptions = Pick<LiveSessionOptions, "url" | "token" | "WebSocketPolyfill">;

/**
 * Several sessions of ONE client over ONE socket: Hocuspocus carries any
 * number of documents on a connection, each authenticated on its own. For a
 * client that holds many rooms at once (a board shows the repository's
 * models in place, one live document each): the Live Host counts sockets per
 * address (LIVE_MAX_WS_PER_IP), and one per room would run into that cap.
 */
export interface LiveSessionGroup {
  /** a session on `room` over the group's socket; its destroy() closes that
   *  document alone and leaves the socket to the others */
  open(room: string, options?: Pick<LiveSessionOptions, "onAuthenticationFailed">): LiveSession;
  /** tears down every session still open AND the socket */
  destroy(): void;
}

export function openLiveSessionGroup(opts: LiveSessionGroupOptions): LiveSessionGroup {
  const socket = openSocket(opts);
  const open = new Set<LiveSession>();
  let destroyed = false;
  return {
    open(room, options = {}) {
      if (destroyed) throw new Error("the session group was destroyed");
      const session: LiveSession = sessionOn(socket, { ...opts, room, ...options }, () => open.delete(session));
      open.add(session);
      return session;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const session of [...open]) session.destroy();
      socket.destroy();
    },
  };
}

/** one document on `socket`; `release` runs after the provider is gone (the
 *  socket's teardown for a session that owns it, a group's bookkeeping else) */
function sessionOn(socket: HocuspocusProviderWebsocket, opts: LiveSessionOptions, release: () => void): LiveSession {
  let authFailure: string | null = null;
  let closed = false;
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: opts.room,
    token: opts.token,
    onAuthenticationFailed: ({ reason }) => {
      authFailure = reason;
      opts.onAuthenticationFailed?.(reason);
    },
  });
  provider.attach();
  keepPresenceAcrossReconnects(provider);

  return {
    doc: provider.document,
    content: provider.document.getText(CONTENT_KEY),
    awareness: provider.awareness,

    onSynced(cb: () => void): () => void {
      provider.on("synced", cb);
      return () => provider.off("synced", cb);
    },

    onDisconnect(cb: () => void): () => void {
      provider.on("disconnect", cb);
      return () => provider.off("disconnect", cb);
    },

    onDocClose(cb: () => void): () => void {
      // the provider re-emits EVERY ws-level close on "close" too (forwardClose
      // in @hocuspocus/provider 4.x) — after those the socket auto-reconnects
      // and re-syncs, so surfacing them as a dead document is wrong. Gate on
      // the socket status AT the event: a doc-level CLOSE is a received message
      // (socket still Connected), a forwarded ws close runs after the socket's
      // own handler already flipped it to Disconnected.
      const docClosed = () => {
        if (socket.status === WebSocketStatus.Connected) cb();
      };
      provider.on("close", docClosed);
      return () => provider.off("close", docClosed);
    },

    onMoved(cb: (notice: MovedNotice) => void): () => void {
      const onStateless = ({ payload }: { payload: string }) => {
        const notice = parseMovedNotice(payload);
        if (notice) cb(notice);
      };
      provider.on("stateless", onStateless);
      return () => provider.off("stateless", onStateless);
    },

    whenSynced(timeoutMs = 10_000): Promise<void> {
      if (authFailure !== null) return Promise.reject(new Error(`auth failed: ${authFailure}`));
      if (provider.synced) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const settle = (finish: () => void) => {
          clearTimeout(timer);
          provider.off("synced", onSync);
          provider.off("authenticationFailed", onAuthFailed);
          finish();
        };
        const onSync = () => settle(resolve);
        const onAuthFailed = ({ reason }: { reason: string }) =>
          settle(() => reject(new Error(`auth failed: ${reason}`)));
        const timer = setTimeout(() => settle(() => reject(new Error("Live Host sync timeout"))), timeoutMs);
        provider.on("synced", onSync);
        provider.on("authenticationFailed", onAuthFailed);
      });
    },

    setUser(user: PresenceUser | null): void {
      provider.setAwarenessField(AWARENESS_USER_KEY, user);
    },

    setCanvasPresence(presence: CanvasPresence | null): void {
      provider.setAwarenessField(AWARENESS_CANVAS_KEY, presence);
    },

    onPresence(cb: (users: PresenceUser[]) => void): () => void {
      // diff-gated: awareness "change" fires for EVERY field write — with live
      // cursors that is ~30/s per moving pointer, and an un-gated callback
      // would re-render a React consumer at that cadence for an unchanged
      // roster. Only a genuine roster change reaches the callback.
      let lastKey: string | undefined;
      const render = () => {
        const states = [...(provider.awareness?.getStates().values() ?? [])];
        const users = states
          .map((s) => sanitizeUser((s as { user?: unknown }).user))
          .filter((u): u is PresenceUser => u !== undefined);
        const key = JSON.stringify(users);
        if (key === lastKey) return;
        lastKey = key;
        cb(users);
      };
      provider.awareness?.on("change", render);
      render();
      return () => provider.awareness?.off("change", render);
    },

    onAwarenessStates(cb: (peers: AwarenessPeer[]) => void): () => void {
      // diff-gated like onPresence: our OWN cursor publishes fire "change"
      // too, but self is excluded from the output — without the gate every
      // local pointer move would re-run every consumer for identical data
      let lastKey: string | undefined;
      const render = () => {
        const awareness = provider.awareness;
        if (!awareness) return; // no awareness handle — nothing will ever fire
        const peers: AwarenessPeer[] = [];
        awareness.getStates().forEach((state, clientId) => {
          if (clientId === awareness.clientID) return; // self renders live, not via echo
          const s = state as { user?: unknown; canvas?: unknown };
          const user = sanitizeUser(s.user);
          const canvas = sanitizeCanvas(s.canvas);
          peers.push({ clientId, ...(user ? { user } : {}), ...(canvas ? { canvas } : {}) });
        });
        const key = JSON.stringify(peers);
        if (key === lastKey) return;
        lastKey = key;
        cb(peers);
      };
      provider.awareness?.on("change", render);
      render();
      return () => provider.awareness?.off("change", render);
    },

    destroy(): void {
      if (closed) return;
      closed = true;
      provider.destroy();
      release();
    },
  };
}
