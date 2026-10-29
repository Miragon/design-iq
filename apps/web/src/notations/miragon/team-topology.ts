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
 *  PNG and SVG exports and Keyboard shortcuts…, which opens the modeler
 *  shell's dialog with the package's `diagramShortcuts`; the JSON is no
 *  export, it is the model's own file in the repository. Its PNG goes
 *  through the modeler shell's `svgToPng` (Geist inside) on the canvas
 *  ground (guide §10.7). */
import type { TtBaseViewer, TtModeling } from "@miragon/team-topologies-renderer";

import { contractOptions, type LoadedMiragonRenderer, type MiragonRendererSpec } from "./spec.ts";

const EXPORT_SHEET_CLASS = "tt-export-paper";

/** The renderer's SVG starts with a white sheet the size of the drawing, which
 *  would hide the canvas ground of guide §10.7 that the PNG fills under the
 *  drawing. Miragon/modeler-suite#234 drops the sheet from the renderer, in a
 *  release after 0.15.1; an SVG without it passes through untouched, so that
 *  release needs no change here, and this goes once designIQ pins it. The SVG
 *  download stays the renderer's own. */
export function withoutExportSheet(svg: string): string {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const sheet = Array.from(parsed.documentElement.children).find(
    (child) => child.localName === "rect" && child.getAttribute("class") === EXPORT_SHEET_CLASS,
  );
  if (!sheet) return svg;
  sheet.remove();
  return new XMLSerializer().serializeToString(parsed);
}

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
        createTitleDialog,
        diagramMenu,
        diagramShortcuts,
        renderLegend,
      },
      ,
      ,
      { dialogChrome, imageExports, lazily, PNG_BACKGROUND, shortcutsDialog },
      { svgToPng },
    ] = await Promise.all([
      import("@miragon/team-topologies-renderer"),
      import("@miragon/team-topologies-renderer/assets/team-topologies.css"),
      import("@miragon/modeler-shell/shell.css"),
      import("./menu-content.ts"),
      import("@miragon/modeler-shell/export"),
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
        const shortcuts = shortcutsDialog(host, diagramShortcuts);
        const groups = diagramMenu({
          editTitle: () => title.get().open(),
          exports: imageExports(
            host,
            async () => diagram.saveSVG().svg,
            (svg) => svgToPng(withoutExportSheet(svg), { background: PNG_BACKGROUND.ground }),
          ),
          showKeyboardShortcuts: () => shortcuts.open(),
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
