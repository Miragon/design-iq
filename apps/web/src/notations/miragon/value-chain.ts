/** @miragon/value-chain-renderer: one JSON document, the factory's text is
 *  the schema model's canonical serialization (keys sorted, elements and
 *  connections by id, a closing line break); a document the schema model
 *  refuses is refused with its reason. The document's name is its title,
 *  which the menu header shows. Its menu content (`diagramMenu`) has
 *  no Model entries: the package ships no title dialog and no legend, so the
 *  menu brings the PNG and SVG exports and Keyboard shortcuts… alone, which
 *  opens the modeler shell's dialog with the package's `diagramShortcuts`;
 *  the JSON is no export, it is the model's own file. Its PNG goes through
 *  the modeler shell's `svgToPng` (Geist inside) on the canvas ground (guide
 *  §10.7): the package's own loads a blob: URL, which the widget's content
 *  security policy refuses, where the shell's loads a data: URL. The palette's
 *  layout and keyboard side are designIQ's own (lib/value-chain-palette.css
 *  and .ts): the package gives them only inside the modeler shell's chrome. */
import type { VcBaseViewer } from "@miragon/value-chain-renderer";

import { contractOptions, type LoadedMiragonRenderer, type MiragonRendererSpec } from "./spec.ts";

/** the name the renderer exports for a diagram it has not imported yet
 *  (value-chain-schema-model's createEmptyDocument default) */
const UNTITLED = "Untitled value chain";

export const spec: MiragonRendererSpec = {
  id: "value-chain",
  pkg: "@miragon/value-chain-renderer",
  canvasClassName: "vc-canvas",
  contractNotation: "value-chain",
  async load(): Promise<LoadedMiragonRenderer> {
    const [
      { createCollaborativeModeler, createCollaborativeViewer, diagramMenu, diagramShortcuts },
      ,
      ,
      { imageExports, ownTitle, PNG_BACKGROUND, shortcutsDialog },
      { svgToPng },
      { enhanceValueChainPalette },
    ] = await Promise.all([
      import("@miragon/value-chain-renderer"),
      import("@miragon/value-chain-renderer/assets/value-chain.css"),
      import("@miragon/modeler-shell/shell.css"),
      import("./menu-content.ts"),
      import("@miragon/modeler-shell/export"),
      import("../../lib/value-chain-palette.ts"),
    ]);
    // the Modeler and the viewer share this surface
    const chainOf = (modeler: { diagram: unknown }): VcBaseViewer => modeler.diagram as VcBaseViewer;
    return {
      create: (mount) => createCollaborativeModeler({ ...contractOptions(mount), undoRedoKeys: true }),
      createViewer: (mount) => createCollaborativeViewer(contractOptions(mount)),
      attached: (modeler, host) => enhanceValueChainPalette(host, modeler.diagram),
      title: (modeler) => ownTitle(chainOf(modeler).exportDocument().meta.name, UNTITLED),
      menu(modeler, host) {
        const chain = chainOf(modeler);
        const shortcuts = shortcutsDialog(host, diagramShortcuts);
        const groups = diagramMenu({
          exports: imageExports(
            host,
            async () => chain.saveSVG().svg,
            (svg) => svgToPng(svg, { background: PNG_BACKGROUND.ground }),
          ),
          showKeyboardShortcuts: () => shortcuts.open(),
        });
        return { groups: { model: [], ...groups }, destroy: () => shortcuts.destroy() };
      },
    };
  },
};
