/**
 * The live texts of the models a board has open: one per path (the first node's session, since
 * every session of a file converges on one text), and one signal after any change of any of
 * them. The reference parsing reads them (references.ts). Node-loadable.
 */
import type * as Y from "yjs";

export interface ModelText {
  /** repo-relative path of the model */
  path: string;
  text: string;
}

export interface ModelTexts {
  /** a session's text of the model at `path`, observed until the returned remove */
  add(path: string, text: Y.Text): () => void;
  /** one text per open path, the first session's */
  current(): ModelText[];
  /** after a text was added, changed or removed; returns the unsubscribe */
  onChange(listener: () => void): () => void;
}

export function createModelTexts(): ModelTexts {
  const byPath = new Map<string, Y.Text[]>();
  const listeners = new Set<() => void>();
  const tell = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    add(path, text) {
      byPath.set(path, [...(byPath.get(path) ?? []), text]);
      text.observe(tell);
      tell();
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        text.unobserve(tell);
        const left = (byPath.get(path) ?? []).filter((one) => one !== text);
        if (left.length > 0) byPath.set(path, left);
        else byPath.delete(path);
        tell();
      };
    },
    current: () => [...byPath].flatMap(([path, open]) => (open[0] ? [{ path, text: open[0].toString() }] : [])),
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
