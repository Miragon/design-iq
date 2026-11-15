/**
 * The spike's stand-in for the product's one live room per file: per model file ONE server Y.Doc,
 * seeded once, and one replica Y.Doc per bound editor, relayed in the page. An embed frame keeps
 * its replica in its own document and relays the same updates over postMessage.
 *
 * Follows hub() in packages/live-client/test/fixtures/safety-net.ts (brief sync.md, section 2).
 * Node-loadable: the suites under test/spike run it without a browser.
 */
import { CONTENT_KEY } from "@designiq/contracts/live";
import * as Y from "yjs";

import type { BoardFiles, FileKind, LinkedFile, ListedFile } from "../notations/board/files.ts";
import {
  FRAME_CHANNEL,
  FRAME_PROTOCOL,
  type FrameToHubBody,
  type FrameToHubMessage,
  type HubToFrameBody,
  type HubToFrameMessage,
  isFrameMessage,
} from "./shared.ts";

/**
 * Origin of every update that comes FROM the hub into a replica: the replica's own "update" listener
 * skips it. A Symbol, never the string "bpm-canvas": the bindings ignore that one (sync.md 6.2).
 */
const FROM_HUB = Symbol("from-hub");

export type { FileKind, ListedFile as HubFile, LinkedFile as ModelReplica };

/** a text file that lives outside the hub (the board) and shows in the file list */
export interface TextSource {
  text(): string;
  subscribe(listener: () => void): () => void;
}

/** the board page's end of one embed frame */
export interface FrameLink {
  /** the frame's editor finished its first import; rejects with the frame's error text */
  readonly ready: Promise<void>;
  /** resolves once the frame answered that it takes input (or stopped taking it) */
  arm(armed: boolean): Promise<void>;
  detach(): void;
}

/** the slice of a Window the bridge uses, so a test can pass a fake */
export interface FrameTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}
export interface FrameEvent {
  data: unknown;
  source: unknown;
}
export interface FrameReceiver {
  addEventListener(type: "message", listener: (event: FrameEvent) => void): void;
  removeEventListener(type: "message", listener: (event: FrameEvent) => void): void;
}

export interface ModelHubOptions {
  /** repo-relative path -> text: each gets its server doc, seeded here and nowhere else */
  files: Readonly<Record<string, string>>;
  /** "repository files" that are no text: an image node stores only the path */
  assets?: Readonly<Record<string, Blob>>;
  /** sync errors and what the frames report */
  log?: (line: string) => void;
  /** where the frames' messages arrive; the window unless a test passes a fake */
  receiver?: FrameReceiver;
  targetOrigin?: string;
}

/** the board's files (notations/board/files.ts) and what only the bench asks of its stand-in */
export interface ModelHub extends BoardFiles {
  /** the server copy's text, "the file" (also of a text source); undefined for an unknown path */
  text(path: string): string | undefined;
  /** after every change of any file and of the file list */
  onFiles(listener: () => void): () => void;
  addSource(path: string, kind: FileKind, source: TextSource): () => void;
  /**
   * Links the frame `target` (an iframe's contentWindow, named `frameName`) to the file like a replica.
   * Nothing is sent before the frame said hello; then the whole state, then one update per transaction.
   */
  attachFrame(path: string, target: FrameTarget, frameName: string): FrameLink;
  destroy(): void;
}

interface Link {
  deliver(update: Uint8Array): void;
}
interface Entry {
  kind: FileKind;
  text(): string;
  version: number;
  listeners: Set<() => void>;
}
interface Room extends Entry {
  server: Y.Doc;
  links: Set<Link>;
}

const defaultOrigin = (): string => (typeof location === "undefined" ? "*" : location.origin);
const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

export function createModelHub(options: ModelHubOptions): ModelHub {
  const rooms = new Map<string, Room>();
  const sources = new Map<string, Entry>();
  const assets = new Map<string, Blob>(Object.entries(options.assets ?? {}));
  const fileListeners = new Set<() => void>();
  const teardowns = new Set<() => void>();
  const targetOrigin = options.targetOrigin ?? defaultOrigin();

  const changed = (entry: Entry): void => {
    entry.version++;
    for (const listener of [...entry.listeners, ...fileListeners]) listener();
  };

  for (const [path, text] of Object.entries(options.files)) {
    const server = new Y.Doc();
    const ytext = server.getText(CONTENT_KEY);
    // seeded ONCE, here: a replica that seeded itself would add the text a second time (sync.md 6.5)
    ytext.insert(0, text);
    const room: Room = {
      kind: "model",
      text: () => ytext.toString(),
      version: 0,
      listeners: new Set(),
      server,
      links: new Set(),
    };
    // a transaction can change the write log alone (canvasWrites): only a text change is a new version
    let textChanged = false;
    ytext.observe(() => void (textChanged = true));
    // One applyUpdate per source transaction, in order, uncoalesced, and delivered inside the sender's
    // "update" event: the bindings tell a peer's canvas write by exactly that (sync.md 3, rules 1, 2, 5).
    server.on("update", (update: Uint8Array, origin: unknown) => {
      for (const link of room.links) if (link !== origin) link.deliver(update);
      if (!textChanged) return;
      textChanged = false;
      changed(room);
    });
    rooms.set(path, room);
  }

  const roomOf = (path: string): Room => {
    const room = rooms.get(path);
    if (!room) throw new Error(`no such model file: ${path}`);
    return room;
  };
  const entryOf = (path: string): Entry | undefined => rooms.get(path) ?? sources.get(path);

  return {
    uploads: true,
    replica(path) {
      const room = roomOf(path);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.server), FROM_HUB);
      const link: Link = { deliver: (update) => Y.applyUpdate(doc, update, FROM_HUB) };
      const onUpdate = (update: Uint8Array, origin: unknown): void => {
        // the link as origin: the server relays to every OTHER link, never back to the sender
        if (origin !== FROM_HUB) Y.applyUpdate(room.server, update, link);
      };
      doc.on("update", onUpdate);
      room.links.add(link);
      const destroy = (): void => {
        if (!teardowns.delete(destroy)) return;
        doc.off("update", onUpdate);
        room.links.delete(link);
        doc.destroy();
      };
      teardowns.add(destroy);
      return { path, doc, ytext: doc.getText(CONTENT_KEY), destroy };
    },

    text: (path) => entryOf(path)?.text(),
    version: (path) => entryOf(path)?.version ?? 0,
    onChange(path, listener) {
      const entry = entryOf(path);
      if (!entry) throw new Error(`no such file: ${path}`);
      entry.listeners.add(listener);
      return () => void entry.listeners.delete(listener);
    },
    onFiles(listener) {
      fileListeners.add(listener);
      return () => void fileListeners.delete(listener);
    },
    files: () => [
      ...[...rooms, ...sources].map(([path, entry]) => ({
        path,
        kind: entry.kind,
        bytes: bytesOf(entry.text()),
        version: entry.version,
      })),
      ...[...assets].map(([path, blob]) => ({ path, kind: "asset" as const, bytes: blob.size, version: 0 })),
    ],
    addSource(path, kind, source) {
      const entry: Entry = { kind, text: source.text, version: 0, listeners: new Set() };
      sources.set(path, entry);
      const unsubscribe = source.subscribe(() => changed(entry));
      const remove = (): void => {
        if (!teardowns.delete(remove)) return;
        unsubscribe();
        sources.delete(path);
      };
      teardowns.add(remove);
      for (const listener of [...fileListeners]) listener();
      return remove;
    },
    asset: (path) => assets.get(path),
    addAsset(path, blob) {
      assets.set(path, blob);
      for (const listener of [...fileListeners]) listener();
    },

    attachFrame(path, target, frameName) {
      const room = roomOf(path);
      const receiver = options.receiver ?? (window as FrameReceiver);
      const post = (body: HubToFrameBody): void =>
        target.postMessage(
          { channel: FRAME_CHANNEL, v: FRAME_PROTOCOL, frame: frameName, ...body } satisfies HubToFrameMessage,
          targetOrigin,
        );
      // the frame listens only once it said hello; until then the state it will get covers every update
      let live = false;
      let wanted = false;
      let waiting: Array<{ armed: boolean; resolve: () => void }> = [];
      let settle: { resolve: () => void; reject: (error: Error) => void } | undefined;
      const ready = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
      // whoever awaits `ready` sees the rejection; nobody awaiting it must not raise an unhandledrejection
      ready.catch(() => undefined);
      const link: Link = {
        deliver: (update) => {
          if (live) post({ type: "update", update });
        },
      };
      const onMessage = (event: FrameEvent): void => {
        if (event.source !== target || !isFrameMessage(event.data, frameName)) return;
        const message = event.data as FrameToHubMessage;
        switch (message.type) {
          case "hello":
            live = true;
            post({ type: "state", file: path, update: Y.encodeStateAsUpdate(room.server), armed: wanted });
            break;
          case "update":
            Y.applyUpdate(room.server, message.update, link);
            break;
          case "ready":
            if (message.error === undefined) settle?.resolve();
            else settle?.reject(new Error(message.error));
            break;
          case "armed":
            for (const waiter of waiting) if (waiter.armed === message.armed) waiter.resolve();
            waiting = waiting.filter((waiter) => waiter.armed !== message.armed);
            break;
          case "log":
            options.log?.(`[${frameName}] ${message.line}`);
            break;
        }
      };
      receiver.addEventListener("message", onMessage);
      room.links.add(link);
      const detach = (): void => {
        if (!teardowns.delete(detach)) return;
        receiver.removeEventListener("message", onMessage);
        room.links.delete(link);
      };
      teardowns.add(detach);
      return {
        ready,
        arm(armed) {
          wanted = armed;
          return new Promise<void>((resolve) => {
            waiting.push({ armed, resolve });
            // before the hello the flag travels with the state
            if (live) post({ type: "arm", armed });
          });
        },
        detach,
      };
    },

    destroy() {
      for (const teardown of [...teardowns]) teardown();
      for (const room of rooms.values()) room.server.destroy();
      rooms.clear();
      fileListeners.clear();
    },
  };
}

// ── the frame's end ──────────────────────────────────────────────────────────

export interface HubConnectionOptions {
  /** this frame's name: the string the board page passed to attachFrame (EmbedParams.frame) */
  frame: string;
  /** the board page's window; `window.parent` unless a test passes a fake */
  hub?: FrameTarget;
  receiver?: FrameReceiver;
  targetOrigin?: string;
  /** ms between two hellos until the state came */
  helloEveryMs?: number;
}

export interface HubConnection {
  /** this frame's replica: empty until `ready`, never seeded here */
  readonly doc: Y.Doc;
  readonly ytext: Y.Text;
  /** the hub's state is applied: bind the editor now */
  readonly ready: Promise<{ file: string }>;
  /** tells the board page that the editor finished its first import, or why it did not */
  reportReady(error?: string): void;
  /**
   * `listener` runs with the flag the state carried and on every later request; the board page gets
   * its answer once the listener (and the promise it returned) is through. One listener.
   */
  onArm(listener: (armed: boolean) => void | Promise<void>): void;
  /** a line for the board page's log */
  log(line: string): void;
  disconnect(): void;
}

export function connectToHub(options: HubConnectionOptions): HubConnection {
  const hub = options.hub ?? (window.parent as FrameTarget);
  const receiver = options.receiver ?? (window as FrameReceiver);
  const targetOrigin = options.targetOrigin ?? defaultOrigin();
  const post = (body: FrameToHubBody): void =>
    hub.postMessage(
      { channel: FRAME_CHANNEL, v: FRAME_PROTOCOL, frame: options.frame, ...body } satisfies FrameToHubMessage,
      targetOrigin,
    );

  const doc = new Y.Doc();
  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== FROM_HUB) post({ type: "update", update });
  };
  doc.on("update", onUpdate);

  let armListener: ((armed: boolean) => void | Promise<void>) | undefined;
  /** what the board page asked for last and no listener has taken yet */
  let pending: boolean | undefined;
  const applyArm = async (armed: boolean): Promise<void> => {
    if (!armListener) {
      pending = armed;
      return;
    }
    pending = undefined;
    await armListener(armed);
    post({ type: "armed", armed });
  };

  let resolveReady: ((state: { file: string }) => void) | undefined;
  const ready = new Promise<{ file: string }>((resolve) => (resolveReady = resolve));
  const hello = setInterval(() => post({ type: "hello" }), options.helloEveryMs ?? 200);
  const onMessage = (event: FrameEvent): void => {
    if (event.source !== hub || !isFrameMessage(event.data, options.frame)) return;
    const message = event.data as HubToFrameMessage;
    switch (message.type) {
      case "state":
        // a second state (two hellos crossed it) is the same update again: Yjs applies it as a no-op
        clearInterval(hello);
        Y.applyUpdate(doc, message.update, FROM_HUB);
        resolveReady?.({ file: message.file });
        void applyArm(message.armed);
        break;
      case "update":
        Y.applyUpdate(doc, message.update, FROM_HUB);
        break;
      case "arm":
        void applyArm(message.armed);
        break;
    }
  };
  receiver.addEventListener("message", onMessage);
  post({ type: "hello" });

  return {
    doc,
    ytext: doc.getText(CONTENT_KEY),
    ready,
    reportReady: (error) => post(error === undefined ? { type: "ready" } : { type: "ready", error }),
    onArm(listener) {
      armListener = listener;
      if (pending !== undefined) void applyArm(pending);
    },
    log: (line) => post({ type: "log", line }),
    disconnect() {
      clearInterval(hello);
      receiver.removeEventListener("message", onMessage);
      doc.off("update", onUpdate);
      doc.destroy();
    },
  };
}
