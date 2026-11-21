/**
 * The board's images (BoardImages), read-only from the Live Host's repository image route
 * (@designiq/contracts/live repoImageRoute: same origin, the session's cookie, only the types of
 * REPO_IMAGE_TYPES). `read()` loads an image the first time a node asks and hands out the SAME
 * Blob until `onChange`. There is no `store` and no `taken`: the Live Host has no route that
 * writes a binary file into the workspace, so the toolbar has no Image button and a pasted or
 * dropped picture gets the board's notice. Node-loadable (the fetch is injected).
 */
import { repoImageRoute, repoImageType } from "@designiq/contracts/live";
import type { BoardImages } from "@miragon/board-renderer";

export function createBoardImages(
  repo: string,
  load: (url: string) => Promise<Response> = (url) => fetch(url),
): BoardImages & { destroy(): void } {
  const known = new Map<string, Blob | "loading" | "missing">();
  const listeners = new Set<() => void>();
  let ended = false;
  const tell = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const fetchImage = async (path: string): Promise<void> => {
    try {
      const response = await load(repoImageRoute(repo, path));
      if (ended) return;
      if (!response.ok) return void known.set(path, "missing");
      const blob = await response.blob();
      if (ended) return;
      known.set(path, blob);
      tell();
    } catch {
      // offline, or the route refused: the node keeps the missing-file figure
      if (!ended) known.set(path, "missing");
    }
  };
  return {
    // asked while an image node renders: the same Blob per path
    read(path) {
      const now = known.get(path);
      if (now instanceof Blob) return now;
      // only the types the Live Host serves; any other path draws the missing-file figure
      if (now === undefined && !ended && path !== "" && repoImageType(path) !== undefined) {
        known.set(path, "loading");
        // not inside the render that asked: the bytes come with onChange
        queueMicrotask(() => void fetchImage(path));
      }
      return undefined;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    destroy() {
      ended = true;
      listeners.clear();
      known.clear();
    },
  };
}
