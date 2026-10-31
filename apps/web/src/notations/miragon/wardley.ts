/** @miragon/wardley-renderer — the OWM DSL. Its factory reports content
 *  changes from the command stack only, and its export is the committed
 *  document: during a plot-resize drag or a size preview it is the map as
 *  it was before, the dropped size is the edit. The plot with its axes is
 *  content too, though it is no element: the box its `contentBounds()`
 *  reports (contract 1.3) holds it, and its pan constraint keeps a host's
 *  fit to that box in place. Its menu content (`mapMenu`) brings Map
 *  title…, Map size… and X-axis labels… (one undoable step each; the two
 *  popovers preview on the canvas, so they bring it forward), the PNG
 *  and SVG exports and Keyboard shortcuts…, which opens the modeler shell's
 *  dialog with the package's `mapShortcuts`; the map file itself is no
 *  export, it is the model. Its PNG goes through the modeler shell's
 *  `svgToPng` (Geist inside) on the plot's white (guide §10.7). */
import type { Modeler } from "@miragon/wardley-renderer";

import { contractOptions, type LoadedMiragonRenderer, type MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "wardley",
  pkg: "@miragon/wardley-renderer",
  canvasClassName: "wardley-canvas",
  contractNotation: "wardley",
  async load(): Promise<LoadedMiragonRenderer> {
    const [
      {
        createAxisLabelsPopover,
        createCollaborativeModeler,
        createCollaborativeViewer,
        createMapSizePopover,
        createTitleDialog,
        mapMenu,
        mapShortcuts,
      },
      ,
      ,
      { canvasPopover, dialogChrome, imageExports, lazily, ownTitle, PNG_BACKGROUND, shortcutsDialog },
      { svgToPng },
    ] = await Promise.all([
      import("@miragon/wardley-renderer"),
      import("@miragon/wardley-renderer/assets/wardley.css"),
      import("@miragon/modeler-shell/shell.css"),
      import("./menu-content.ts"),
      import("@miragon/modeler-shell/export"),
    ]);
    // the viewer is a NavigatedViewer: it reads the map like the Modeler, and
    // the entries that would write it stay disabled on a read-only canvas
    const mapOf = (modeler: { diagram: unknown }): Modeler => modeler.diagram as Modeler;
    return {
      create: (mount) => createCollaborativeModeler({ ...contractOptions(mount), undoRedoKeys: true }),
      createViewer: (mount) => createCollaborativeViewer(contractOptions(mount)),
      // wardley-schema-model's DEFAULT_MAP_TITLE: a map without a title line
      title: (modeler) => ownTitle(mapOf(modeler).exportMap().config.title, "Untitled Map"),
      menu(modeler, host) {
        const map = mapOf(modeler);
        const chrome = dialogChrome(host);
        const title = lazily(() => createTitleDialog(chrome, map));
        const size = canvasPopover(host, () => createMapSizePopover(chrome, map));
        const axis = canvasPopover(host, () => createAxisLabelsPopover(chrome, map));
        const shortcuts = shortcutsDialog(host, mapShortcuts);
        const groups = mapMenu({
          mapTitle: () => title.get().open(),
          mapSize: () => size.open(),
          axisLabels: () => axis.open(),
          exports: imageExports(
            host,
            async () => (await map.saveSVG()).svg,
            (svg) => svgToPng(svg, { background: PNG_BACKGROUND.plot }),
          ),
          showKeyboardShortcuts: () => shortcuts.open(),
        });
        return {
          groups,
          destroy() {
            for (const made of [title, size, axis, shortcuts]) made.destroy();
          },
        };
      },
    };
  },
};
