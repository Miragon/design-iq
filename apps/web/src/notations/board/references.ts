/**
 * The board's references (BoardReferences): what the open models say about each other, parsed
 * after a rest of REFERENCES_REST_MS since the last change of a text or of the model list, and
 * the same array until a reference really changed (the board reads it as an external store). A
 * reference may point at any model of the list, so an arrow also reaches a node whose own
 * session failed. Node-loadable.
 */
import type { BoardReference, BoardReferences } from "@miragon/board-renderer";

import { boardReferences, sameReferences } from "./derived-refs.ts";
import type { ModelTexts } from "./model-texts.ts";

/** the parsing rests this long after the last change */
export const REFERENCES_REST_MS = 300;

export interface BoardReferencesDeps {
  readonly texts: ModelTexts;
  /** the model paths a reference may point at, read when the parsing runs */
  paths(): readonly string[];
  onPaths(listener: () => void): () => void;
}

export function createBoardReferences(deps: BoardReferencesDeps): BoardReferences & { destroy(): void } {
  let refs: readonly BoardReference[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const listeners = new Set<() => void>();
  const parse = (): void => {
    timer = undefined;
    if (ended) return;
    const files = deps.texts.current();
    const paths = [...new Set([...deps.paths(), ...files.map((file) => file.path)])];
    const next = boardReferences(files, paths);
    if (sameReferences(refs, next)) return;
    refs = next;
    for (const listener of [...listeners]) listener();
  };
  const schedule = (): void => {
    if (ended) return;
    clearTimeout(timer);
    timer = setTimeout(parse, REFERENCES_REST_MS);
  };
  const offTexts = deps.texts.onChange(schedule);
  const offPaths = deps.onPaths(schedule);
  return {
    list: () => refs,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    destroy() {
      ended = true;
      clearTimeout(timer);
      offTexts();
      offPaths();
      listeners.clear();
    },
  };
}
