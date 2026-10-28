/** @miragon/event-storming-renderer — the .storm DSL. Keyboard creation
 *  lands in the free area the mount names. Its menu content (`boardMenu`)
 *  brings the Level radio group (an undoable edit of the board), the Type
 *  captions checkbox (a view preference: usable read-only, kept for the
 *  page's later boards), the PNG and SVG exports and Keyboard shortcuts…,
 *  which opens the modeler shell's dialog with the package's
 *  `boardShortcuts`; the .storm file itself is no export, it is the model.
 *  Its PNG goes through the modeler shell's `svgToPng` (Geist inside) on the
 *  canvas ground (guide §10.7). */
import type { BoardLevels, EventStormingViewOptions, NavigatedViewer } from "@miragon/event-storming-renderer";

import { contractOptions, type LoadedMiragonRenderer, type MiragonRendererSpec } from "./spec.ts";

/** the type captions as last toggled on this page, for the next mount */
let typeCaptions: boolean | undefined;

export const spec: MiragonRendererSpec = {
  id: "event-storming",
  pkg: "@miragon/event-storming-renderer",
  canvasClassName: "es-canvas",
  contractNotation: "event-storming",
  async load(): Promise<LoadedMiragonRenderer> {
    const [
      { boardMenu, boardShortcuts, createCollaborativeModeler, createCollaborativeViewer },
      ,
      ,
      { imageExports, ownTitle, PNG_BACKGROUND, shortcutsDialog },
      { svgToPng },
    ] = await Promise.all([
      import("@miragon/event-storming-renderer"),
      import("@miragon/event-storming-renderer/assets/event-storming.css"),
      import("@miragon/modeler-shell/shell.css"),
      import("./menu-content.ts"),
      import("@miragon/modeler-shell/export"),
    ]);
    // the Modeler and the viewer share this surface (EventStormingBaseViewer)
    const boardOf = (modeler: { diagram: unknown }): NavigatedViewer => modeler.diagram as NavigatedViewer;
    return {
      create: (mount) => createCollaborativeModeler({ ...contractOptions(mount), undoRedoKeys: true }),
      createViewer: (mount) => createCollaborativeViewer(contractOptions(mount)),
      // the board a parser reads without a title line
      title: (modeler) => ownTitle(boardOf(modeler).exportMap().config.title, "Untitled Board"),
      menu(modeler, host) {
        const board = boardOf(modeler);
        const viewOptions = board.get<EventStormingViewOptions>("eventStormingViewOptions");
        if (typeCaptions !== undefined) viewOptions.setTypeCaptionsVisible(typeCaptions);
        const levels: BoardLevels = {
          // the viewer has no modeling service: it reads the level off the board
          getLevel: () => board.exportMap().config.level ?? "design",
          setLevel: (level) => board.get<BoardLevels>("eventStormingModeling").setLevel(level),
        };
        const shortcuts = shortcutsDialog(host, boardShortcuts);
        const groups = boardMenu({
          levels,
          typeCaptions: viewOptions,
          onTypeCaptionsToggled: (visible) => {
            typeCaptions = visible;
          },
          exports: imageExports(
            host,
            async () => (await board.saveSVG()).svg,
            (svg) => svgToPng(svg, { background: PNG_BACKGROUND.ground }),
          ),
          showKeyboardShortcuts: () => shortcuts.open(),
        });
        return { groups, destroy: () => shortcuts.destroy() };
      },
    };
  },
};
