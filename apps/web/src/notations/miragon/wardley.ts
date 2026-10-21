/** @miragon/wardley-renderer — the OWM DSL. Its factory reports content
 *  changes from the command stack only, and its export is the committed
 *  document: during a plot-resize drag or a size preview it is the map as
 *  it was before, the dropped size is the edit. It gets no `freeRectInsets` yet: with them its pan constraint pulls
 *  the widget's fit towards its own content bounds, which are not the bounds
 *  the chrome fits (#265 aligns the fit). The viewer takes no options.
 *
 *  Its name and link editors commit on every viewbox change, the host's own
 *  included, and its import reopens an open editor before it returns: the
 *  view a peer's re-import restores would write what the user has typed so
 *  far into the shared text. So the editing mount's `setViewState` sets an
 *  open editor aside around the change, with the set-aside the renderer's
 *  import uses (the other renderers reopen theirs one task after an import,
 *  past the host's restore). */
import type { Modeler, WardleyLabelEditing, WardleyLinkEditing } from "@miragon/wardley-renderer";

import type { LoadedMiragonRenderer, MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "wardley",
  pkg: "@miragon/wardley-renderer",
  canvasClassName: "wardley-canvas",
  contractNotation: "wardley",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ createCollaborativeModeler, createCollaborativeViewer, restoreEditorState, setAsideEditorState }] =
      await Promise.all([import("@miragon/wardley-renderer"), import("@miragon/wardley-renderer/assets/wardley.css")]);
    return {
      create: () => {
        const modeler = createCollaborativeModeler({ keyboard: { undoRedo: true } });
        const diagram = modeler.diagram as Modeler;
        const editing = (): boolean =>
          diagram.get<WardleyLabelEditing>("wardleyLabelEditing").getActiveEdit() !== null ||
          diagram.get<WardleyLinkEditing>("wardleyLinkEditing").getActiveEdit() !== null;
        return {
          ...modeler,
          setViewState(state) {
            if (!editing()) return modeler.setViewState(state);
            const aside = setAsideEditorState(diagram);
            modeler.setViewState(state);
            // a view change keeps the canvas's own element ids, as a refused import does
            restoreEditorState(diagram, aside, { importRejected: true });
          },
        };
      },
      createViewer: () => createCollaborativeViewer(),
    };
  },
};
