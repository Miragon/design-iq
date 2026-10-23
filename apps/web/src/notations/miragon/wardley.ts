/** @miragon/wardley-renderer — the OWM DSL. Its factory reports content
 *  changes from the command stack only, and its export is the committed
 *  document: during a plot-resize drag or a size preview it is the map as
 *  it was before, the dropped size is the edit. The plot with its axes is
 *  content too, though it is no element: the box its `contentBounds()`
 *  reports (contract 1.3) holds it, and its pan constraint keeps a host's
 *  fit to that box in place. Its menu content (`mapMenu`) brings Map
 *  title…, Map size… and X-axis labels… (one undoable step each), the PNG
 *  and SVG exports and the shortcuts dialog; the map file itself is no
 *  export, it is the model. */
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
        createShortcutsDialog,
        createTitleDialog,
        mapMenu,
        svgToPng,
      },
      ,
      { dialogChrome, imageExports, lazily, ownTitle },
    ] = await Promise.all([
      import("@miragon/wardley-renderer"),
      import("@miragon/wardley-renderer/assets/wardley.css"),
      import("./menu-content.ts"),
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
        const size = lazily(() => createMapSizePopover(chrome, map));
        const axis = lazily(() => createAxisLabelsPopover(chrome, map));
        const shortcuts = lazily(() => createShortcutsDialog(chrome));
        const groups = mapMenu({
          mapTitle: () => title.get().open(),
          mapSize: () => size.get().open(),
          axisLabels: () => axis.get().open(),
          exports: imageExports(
            host,
            async () => (await map.saveSVG()).svg,
            (svg) => svgToPng(svg),
          ),
          showKeyboardShortcuts: () => shortcuts.get().open(),
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
