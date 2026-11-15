/**
 * The files of a board in designIQ: what the board asks its host for (BoardFiles), answered from
 * the shell. A model a board shows is a live session of its own on that model's room, opened
 * through `ctx.linkedFiles`, so an edit made on the board is saved in the model's own file and
 * reaches everyone who has that model open. An image is read from the repository's image route.
 *
 * One session per model node, never one shared by two nodes: every editor binds a document of its
 * own, as the product's editors expect. The sessions share one socket (the shell's), and the
 * person counts as present in a model's room only while its node is armed.
 */
import { repoImageRoute } from "@designiq/contracts/live";
import type { LiveSession } from "@designiq/live-client";
import { byExtension, modelStem, movedModelPath } from "@designiq/notations";

import type { EditorContext } from "../registry";
import { notationOf } from "./board-doc.ts";
import type { BoardFiles, ListedFile } from "./files.ts";

/** a linked model that does not sync within this time counts as failed: its node says so */
const LINK_TIMEOUT_MS = 20_000;

/** the board's files in designIQ, and the end of every session they opened */
export type LiveHub = BoardFiles & { destroy(): void };

export function createLiveHub(ctx: EditorContext, log: (line: string) => void): LiveHub {
  /** the open sessions per file, in the order they were opened */
  const sessions = new Map<string, Set<LiveSession>>();
  const versions = new Map<string, number>();
  const changeListeners = new Map<string, Set<() => void>>();
  const fileListeners = new Set<() => void>();
  const images = new Map<string, Blob | "loading" | "missing">();
  let destroyed = false;

  const tellFiles = (): void => {
    for (const listener of [...fileListeners]) listener();
  };
  /** the open files' checks whether their path still names a model (below) */
  const moveChecks = new Set<() => void>();
  const offModels = ctx.models?.onChange(() => {
    tellFiles();
    for (const check of [...moveChecks]) check();
  });
  /**
   * Where the model went that `path` named: undefined while the path is listed or the list is not
   * there yet, and when no single model of that notation and file stem is elsewhere (deleted, or
   * renamed while this board was closed and not rewritten). A move keeps the stem.
   */
  const movedTo = (path: string): string | undefined => {
    const paths = ctx.models?.paths();
    if (!paths || paths.has(path)) return undefined;
    return movedModelPath(
      path,
      [...paths].map((one) => ({ path: one, notation: byExtension(one)?.id ?? "", id: modelStem(one) })),
    );
  };

  /** the model list as the board's file list, kept until the shell's list changes */
  let listed: { paths: ReadonlySet<string> | undefined; files: ListedFile[] } | undefined;
  const files = (): ListedFile[] => {
    const paths = ctx.models?.paths();
    if (listed?.paths !== paths || !listed) {
      listed = {
        paths,
        // what a board can show in place: the notations with a visual editor; never another board
        files: [...(paths ?? [])]
          .filter((path) => notationOf(path) !== undefined)
          .sort()
          .map((path) => ({ path, kind: "model", bytes: 0, version: versions.get(path) ?? 0 })),
      };
    }
    return listed.files;
  };

  return {
    uploads: false,

    replica(path) {
      const { linkedFiles } = ctx;
      if (!linkedFiles) throw new Error("this editor was mounted without linked files");
      const session = linkedFiles.open(path);
      const open = sessions.get(path) ?? new Set<LiveSession>();
      open.add(session);
      sessions.set(path, open);
      const onText = (): void => {
        versions.set(path, (versions.get(path) ?? 0) + 1);
        for (const listener of [...(changeListeners.get(path) ?? [])]) listener();
      };
      session.content.observe(onText);
      let closed = false;
      const movedListeners = new Set<(to: string) => void>();
      const tellMoved = (to: string): void => {
        if (closed || to === path) return;
        for (const listener of [...movedListeners]) listener(to);
      };
      // renamed or moved while the board has it open: the host says where it went
      const offMoved = session.onMoved((notice) => tellMoved(notice.to));
      // a path that is gone while the model is elsewhere (moved while the board was closed)
      const checkMoved = (): void => {
        const to = movedTo(path);
        if (to !== undefined) tellMoved(to);
      };
      moveChecks.add(checkMoved);
      return {
        path,
        doc: session.doc,
        ytext: session.content,
        ready: session.whenSynced(LINK_TIMEOUT_MS),
        sync: { awareness: session.awareness },
        present: (present) => linkedFiles.present(session, present),
        presence: {
          setLocal: (canvas) => session.setCanvasPresence(canvas),
          // a peer that has not announced itself is nobody to draw: a board that only shows the model
          onRemote: (listener) =>
            session.onAwarenessStates((peers) =>
              listener(peers.flatMap((peer) => (peer.user ? [{ ...peer, user: peer.user }] : []))),
            ),
        },
        onMoved(listener) {
          movedListeners.add(listener);
          // the list may have been there before this file was opened
          queueMicrotask(checkMoved);
          return () => void movedListeners.delete(listener);
        },
        destroy() {
          if (closed) return;
          closed = true;
          offMoved();
          moveChecks.delete(checkMoved);
          movedListeners.clear();
          session.content.unobserve(onText);
          open.delete(session);
          session.destroy();
        },
      };
    },

    // the text of a file the board shows right now; undefined for one it does not show
    text(path) {
      const [first] = sessions.get(path) ?? [];
      return first?.content.toString();
    },
    version: (path) => versions.get(path) ?? 0,
    onChange(path, listener) {
      const listeners = changeListeners.get(path) ?? new Set<() => void>();
      listeners.add(listener);
      changeListeners.set(path, listeners);
      return () => void listeners.delete(listener);
    },
    // the file LIST and the images: a text change of a model is `onChange`'s
    onFiles(listener) {
      fileListeners.add(listener);
      return () => void fileListeners.delete(listener);
    },
    files,

    asset(path) {
      const known = images.get(path);
      if (known instanceof Blob) return known;
      if (known === undefined && path !== "") {
        images.set(path, "loading");
        fetch(repoImageRoute(ctx.repo, path)).then(
          async (response) => {
            if (destroyed) return;
            if (!response.ok) {
              images.set(path, "missing");
              return;
            }
            images.set(path, await response.blob());
            tellFiles();
          },
          (error: unknown) => {
            images.set(path, "missing");
            log(`${path}: ${error instanceof Error ? error.message : String(error)}`);
          },
        );
      }
      return undefined;
    },
    addAsset() {
      throw new Error("this board cannot store a new image yet");
    },

    destroy() {
      destroyed = true;
      offModels?.();
      moveChecks.clear();
      fileListeners.clear();
      changeListeners.clear();
      for (const open of sessions.values()) for (const session of [...open]) session.destroy();
      sessions.clear();
    },
  };
}
