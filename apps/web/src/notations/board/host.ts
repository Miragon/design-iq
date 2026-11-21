/**
 * designIQ's BoardHost (@miragon/board-renderer), built once per board from the shell's
 * EditorContext: its parts stay the same objects for the board's life, as the renderer requires.
 * - models: the repository's models a board shows in place (models.ts), each node's editor the
 *   product editor of its notation on a live session of the model's own (open-model.ts)
 * - images: read-only from the Live Host's image route (images.ts)
 * - references: what the open models say about each other (references.ts)
 * - presence: the people who have this board open (presence.ts)
 */
import { byExtension } from "@designiq/notations";
import type { BoardHost } from "@miragon/board-renderer";

import type { EditorContext } from "../registry.ts";
import { createBoardImages } from "./images.ts";
import { createModelTexts } from "./model-texts.ts";
import { createBoardModels, modelPathsOf } from "./models.ts";
import { openModel } from "./open-model.ts";
import { boardPresence } from "./presence.ts";
import { type PluginLookup, productMount } from "./product-mount.ts";
import { createBoardReferences } from "./references.ts";

export interface DesignIqBoardHost extends BoardHost {
  /** settles once every model node that was opened let go of its editor and its session */
  whenClosed(): Promise<void>;
  /** ends what the host itself listens to; after the board is gone */
  destroy(): void;
}

export function createBoardHost(ctx: EditorContext, lookup: PluginLookup): DesignIqBoardHost {
  // what a board shows in place: a notation whose product editor a node mounts (never a board,
  // nor a Markdown document)
  const shows = (notation: string): boolean => productMount(notation, lookup) !== undefined;
  const paths = modelPathsOf(ctx.models, shows);
  const texts = createModelTexts();
  const { linkedFiles } = ctx;
  /** every node's end, until it came */
  const closing = new Set<Promise<void>>();
  const models = createBoardModels(paths, (context) => {
    const notation = byExtension(context.path)?.id;
    const product = notation === undefined ? undefined : productMount(notation, lookup);
    // undefined: the node reads "<path> cannot be shown here" (a board, a document, a file of no
    // notation, or a board mounted without the shell's linked files)
    if (!product || !linkedFiles) return undefined;
    const editor = openModel(context, { ctx, linkedFiles, product, paths, texts });
    closing.add(editor.closed);
    void editor.closed.then(() => closing.delete(editor.closed));
    return editor;
  });
  const images = createBoardImages(ctx.repo);
  const references = createBoardReferences({
    texts,
    paths: () => paths.list(),
    onPaths: (listener) => paths.onChange(listener),
  });
  return {
    models,
    images,
    references,
    ...(ctx.presence ? { presence: boardPresence(ctx.presence) } : {}),
    whenClosed: () => Promise.all([...closing]).then(() => undefined),
    destroy() {
      references.destroy();
      images.destroy();
      paths.destroy();
    },
  };
}
