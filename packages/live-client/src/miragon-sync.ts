/**
 * Y.Text ↔ collaborative-modeler binding — the ONE adapter for every modeler
 * that implements @miragon/modeler-api (the Miragon renderers: Wardley maps,
 * Event Storming boards, Context Maps, Team Topologies), on the shared sync
 * engine (model-sync.ts; the four rules live there). The contract's laws are
 * what used to be per-renderer knowledge in this module:
 *
 *  - L1 silent import: importText fires no change event and erases the undo
 *    history itself, so there is no echo to suppress and no history to clear.
 *  - L2/L3 one canonical text, one change event: onContentChanged covers
 *    every user-visible change (config, title and undo included, transient
 *    previews such as a Wardley resize drag never), and exportText already
 *    returns the changed document inside the listener.
 *  - L5 view state: snapshot before a RE-import, restore after it. The first
 *    import keeps the view it leaves: the renderer's own fit (at most 100 %,
 *    clear of the chrome the host told it about), which diagram-js's
 *    fit-viewport is not, or none for a host that mounts the renderer with
 *    `fitOnImport: false` and fits the view itself.
 *  - L7 a rejected import leaves the last good canvas, and its reason reaches
 *    onImportError unchanged. That canvas's export is what a repair of a
 *    broken merge writes (rule 4). So the rule-4 pre-gate is only "not empty":
 *    every factory imports blank text as an empty diagram, and a blank Y.Text
 *    rendered as one would have the next canvas edit write a whole document
 *    over it.
 *
 * The one thing left to check is that the modeler is the one the host meant:
 * its notation and the contract version it implements, at bind time.
 */
import { apiVersionsCompatible, type CollaborativeModeler, MODELER_API_VERSION } from "@miragon/modeler-api";
import type * as Y from "yjs";

import { bindModelSync, type SyncOptions } from "./model-sync.ts";

export type { SyncOptions } from "./model-sync.ts";

/** the one pre-gate (L7 above), which the widget's own import applies too */
export const isBlank = (text: string): boolean => text.trim() === "";
export const EMPTY_DOCUMENT = "the document is empty";

/** a modeler of another notation, or of an incompatible contract version,
 *  fails here with a readable message instead of mis-rendering a document */
export function assertContract(modeler: Pick<CollaborativeModeler, "meta">, notation: string): void {
  const { meta } = modeler;
  if (meta.notation !== notation) {
    throw new Error(`expected a '${notation}' modeler, got '${meta.notation}'`);
  }
  if (!apiVersionsCompatible(meta.apiVersion, MODELER_API_VERSION)) {
    throw new Error(
      `the '${notation}' modeler implements @miragon/modeler-api ${meta.apiVersion}, designIQ speaks ${MODELER_API_VERSION}`,
    );
  }
}

export function bindMiragon(
  modeler: CollaborativeModeler,
  notation: string,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  onImportError?: (message: string) => void,
  sync?: SyncOptions,
): () => void {
  assertContract(modeler, notation);
  return bindModelSync(
    {
      importText: (text) => modeler.importText(text),
      exportText: async () => modeler.exportText(),
      looksRenderable: (text) => !isBlank(text),
      unrenderableReason: EMPTY_DOCUMENT,
      beforeImport(isFirstImport) {
        if (isFirstImport) return () => {};
        const view = modeler.getViewState();
        return () => {
          if (view !== undefined) modeler.setViewState(view);
        };
      },
      observeModel: (onChanged) => modeler.onContentChanged(onChanged),
    },
    ytext,
    doc,
    onConflict,
    onImportError,
    sync,
  );
}
