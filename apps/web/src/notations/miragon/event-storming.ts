/** @miragon/event-storming-renderer — the .storm DSL. Keyboard creation
 *  lands in the free area the mount names. Its menu content (`boardMenu`)
 *  brings the Level radio group (an undoable edit of the board), the Type
 *  captions checkbox (a view preference: usable read-only, kept for the
 *  page's later boards), the PNG and SVG exports and the shortcuts dialog;
 *  the .storm file itself is no export, it is the model. */
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
      { boardMenu, createCollaborativeModeler, createCollaborativeViewer, createShortcutsDialog },
      ,
      { dialogChrome, imageExports, lazily, ownTitle },
      { svgToPng },
    ] = await Promise.all([
      import("@miragon/event-storming-renderer"),
      import("@miragon/event-storming-renderer/assets/event-storming.css"),
      import("./menu-content.ts"),
      import("../../lib/export-image.ts"),
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
        const shortcuts = lazily(() => createShortcutsDialog(dialogChrome(host)));
        const groups = boardMenu({
          levels,
          typeCaptions: viewOptions,
          onTypeCaptionsToggled: (visible) => {
            typeCaptions = visible;
          },
          exports: imageExports(host, async () => (await board.saveSVG()).svg, svgToPng),
          showKeyboardShortcuts: () => shortcuts.get().open(),
        });
        return { groups, destroy: () => shortcuts.destroy() };
      },
    };
  },
};
