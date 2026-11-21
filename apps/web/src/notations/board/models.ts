/**
 * The board's model list (BoardModels) from the shell's ModelDirectory: the paths the model
 * picker offers (the listed models of every notation a board shows in place), a title and a kind
 * per file, and what a model node asks before it opens a room: whether the shell lists its path,
 * and where a model went whose path is gone.
 *
 * A node writes where its model went into the shared board (EmbeddedEditorContext.relocate), for
 * everyone and for good, so it follows only what is known: a moved notice of the Live Host, or a
 * list the shell loaded anew after the node asked (ModelDirectory.refresh). A list loaded before
 * a move still has the path the move left, and following it there would undo the Live Host's own
 * rewrite of the board; a client with a fresh list would then move the node back, and so on.
 * Node-loadable.
 */
import { byExtension, modelStem, movedModelPath } from "@designiq/notations";
import type { BoardModels, EmbeddedEditor, EmbeddedEditorContext, ModelDescription } from "@miragon/board-renderer";

import type { ModelDirectory } from "../registry.ts";

export interface ModelPaths {
  /** what the model picker offers, sorted; the same array until the shell's list changes */
  list(): readonly string[];
  /**
   * Whether `path` names a model of the repository: listed by the shell, or where the Live Host
   * said a model moved to (the list may not have it yet). Undefined while the list loads; true
   * for every path where the shell hands in no list
   */
  listed(path: string): boolean | undefined;
  /**
   * Where the model went that `path` named: where the Live Host said it moved, else the ONE
   * listed model of that notation and file stem (a move keeps the stem; moved while the board
   * was closed), never a path a move left. Undefined while the path is listed
   */
  movedTo(path: string): string | undefined;
  /**
   * Where the node `nodeId` goes, whose `path` the list lacks: where the Live Host said the model
   * moved, at once; else movedTo's model, once a list loaded after this call (one load at a time
   * per board) still lacks `path` and names the same model there, and only once per version of
   * the list and node: two clients whose lists disagree never send a node back and forth.
   * Undefined: the node stays (deleted, not confirmed, or the list could not be loaded). Never
   * rejects
   */
  relocation(path: string, nodeId: string): Promise<string | undefined>;
  /** the Live Host said the model at `from` lives at `to` now (a node's moved notice) */
  moved(from: string, to: string): void;
  /** after the shell's list changed; returns the unsubscribe */
  onChange(listener: () => void): () => void;
  /** stops following the shell's list */
  destroy(): void;
}

export function modelPathsOf(directory: ModelDirectory | undefined, shows: (notation: string) => boolean): ModelPaths {
  let from: ReadonlySet<string> | undefined;
  let listed: readonly string[] = [];
  /** the moves the Live Host told, old path to new one, until the shell's list has caught up */
  const moves = new Map<string, string>();
  /** the version of the shell's list: how often it changed */
  let version = 0;
  /** the version of the list each node last followed a model on, by node id */
  const followedOn = new Map<string, number>();
  /** the list's load under way, and whether it has asked the server yet: who asks before joins it */
  let load: { done: Promise<void>; asked: boolean } | undefined;
  /** the load that starts once the one under way, which asked too early, is done */
  let next: Promise<void> | undefined;
  const reload = (refresh: () => Promise<void>): Promise<void> => {
    if (load?.asked === false) return load.done;
    if (load) {
      next ??= load.done
        .catch(() => undefined)
        .then(() => {
          next = undefined;
          return reload(refresh);
        });
      return next;
    }
    const started = { done: Promise.resolve(), asked: false };
    started.done = Promise.resolve()
      .then(() => {
        started.asked = true;
        return refresh();
      })
      .finally(() => {
        if (load === started) load = undefined;
      });
    load = started;
    return started.done;
  };
  const onBoard = (path: string): boolean => {
    const notation = byExtension(path)?.id;
    return notation !== undefined && shows(notation);
  };
  // a move the list shows (the new path listed, the old one gone) is the list's from then on
  const offPrune = directory?.onChange(() => {
    version++;
    const paths = directory.paths();
    if (!paths) return;
    for (const [old, to] of moves) if (paths.has(to) && !paths.has(old)) moves.delete(old);
  });
  const listedIn = (path: string): boolean | undefined => {
    if (!directory) return true;
    const paths = directory.paths();
    if (paths?.has(path)) return true;
    if ([...moves.values()].includes(path)) return true;
    return paths === undefined ? undefined : false;
  };
  const movedTo = (path: string): string | undefined => {
    const told = moves.get(path);
    if (told !== undefined) return told;
    const paths = directory?.paths();
    if (!paths || paths.has(path)) return undefined;
    const to = movedModelPath(
      path,
      [...paths].map((one) => ({ path: one, notation: byExtension(one)?.id ?? "", id: modelStem(one) })),
    );
    // a list that does not show a told move yet still has the old path: never back there
    return to !== undefined && moves.has(to) ? undefined : to;
  };
  /** the model `path` names moved to `guess`, by the list as it is now, and this node did not follow
   *  a model on this version of the list yet */
  const stillGuess = (path: string, nodeId: string, guess: string): boolean =>
    listedIn(path) === false && movedTo(path) === guess && followedOn.get(nodeId) !== version;
  return {
    list() {
      const paths = directory?.paths();
      // the shell makes a new Set per change (live-editor.tsx, modelPathsRef): its identity is the version
      if (paths !== from) {
        from = paths;
        listed = [...(paths ?? [])].filter(onBoard).sort();
      }
      return listed;
    },
    listed: listedIn,
    movedTo,
    async relocation(path, nodeId) {
      const told = moves.get(path);
      if (told !== undefined) return told;
      const guess = movedTo(path);
      if (guess === undefined || !stillGuess(path, nodeId, guess)) return undefined;
      if (directory?.refresh) {
        try {
          await reload(() => directory.refresh?.() ?? Promise.resolve());
        } catch {
          return undefined;
        }
        // the Live Host may have told it meanwhile
        const toldNow = moves.get(path);
        if (toldNow !== undefined) return toldNow;
        if (!stillGuess(path, nodeId, guess)) return undefined;
      }
      followedOn.set(nodeId, version);
      return guess;
    },
    moved(old, to) {
      if (old !== to) moves.set(old, to);
    },
    onChange(listener) {
      if (!directory) return () => undefined;
      return directory.onChange(listener);
    },
    destroy() {
      offPrune?.();
      moves.clear();
      followedOn.clear();
    },
  };
}

/** title and kind of a file of a registered notation: its stem (unique per notation) and the notation's label */
export function describeModel(path: string): ModelDescription | undefined {
  const notation = byExtension(path);
  if (!notation) return undefined;
  return { title: modelStem(path), kind: notation.label };
}

export function createBoardModels(
  paths: ModelPaths,
  open: (context: EmbeddedEditorContext) => EmbeddedEditor | undefined,
): BoardModels {
  return { list: () => paths.list(), onChange: (listener) => paths.onChange(listener), describe: describeModel, open };
}
