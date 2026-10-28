/** @miragon/team-topologies-renderer — one JSON document, the factory's text
 *  is its canonical serialization with a closing line break; a document with
 *  duplicate or reserved ids, nested more than 100 levels deep, or with an
 *  interaction without a position or size in a file that is not version 1,
 *  is refused with the path named. Every committed edit, the label editor's
 *  included, runs through the command stack; drags and an open label editor
 *  stay previews until they commit. The legend (team types, interaction
 *  modes, the other elements) is the host's: designIQ draws `renderLegend`
 *  into a panel of its own in both hosts, as for a context map. Its menu
 *  content (`diagramMenu`) brings Diagram title… (one undoable step), the
 *  PNG and SVG exports and the shortcuts dialog; the JSON is no export, it
 *  is the model's own file in the repository. */
import type { TtBaseViewer, TtModeling } from "@miragon/team-topologies-renderer";

import { contractOptions, type LoadedMiragonRenderer, type MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "team-topology",
  pkg: "@miragon/team-topologies-renderer",
  canvasClassName: "tt-canvas",
  contractNotation: "team-topologies",
  hasLegend: true,
  async load(): Promise<LoadedMiragonRenderer> {
    const [
      {
        createCollaborativeModeler,
        createCollaborativeViewer,
        createShortcutsDialog,
        createTitleDialog,
        diagramMenu,
        renderLegend,
      },
      ,
      { dialogChrome, imageExports, lazily },
      { svgToPng },
    ] = await Promise.all([
      import("@miragon/team-topologies-renderer"),
      import("@miragon/team-topologies-renderer/assets/team-topologies.css"),
      import("./menu-content.ts"),
      import("../../lib/export-image.ts"),
    ]);
    const diagramOf = (modeler: { diagram: unknown }): TtBaseViewer => modeler.diagram as TtBaseViewer;
    return {
      create: (mount) => createCollaborativeModeler({ ...contractOptions(mount), undoRedoKeys: true }),
      createViewer: (mount) => createCollaborativeViewer(contractOptions(mount)),
      title: (modeler) => diagramOf(modeler).getMeta()?.title.trim() || undefined,
      legend: renderLegend,
      menu(modeler, host) {
        const diagram = diagramOf(modeler);
        const chrome = dialogChrome(host);
        const title = lazily(() =>
          createTitleDialog(chrome, {
            title: () => diagram.getMeta()?.title ?? "",
            setTitle: (next) => diagram.get<TtModeling>("ttModeling").setTitle(next),
          }),
        );
        const shortcuts = lazily(() => createShortcutsDialog(chrome));
        const groups = diagramMenu({
          editTitle: () => title.get().open(),
          // the canvas ground of guide §10.7 lies under the drawing, but the
          // renderer's SVG covers it with a white sheet of its own until
          // Miragon/modeler-suite#234 is settled upstream
          exports: imageExports(host, async () => diagram.saveSVG().svg, svgToPng),
          showKeyboardShortcuts: () => shortcuts.get().open(),
        });
        return {
          groups,
          destroy() {
            title.destroy();
            shortcuts.destroy();
          },
        };
      },
    };
  },
};
