/** @miragon/context-maps-renderer — one JSON document, the factory's text
 *  is its canonical serialization with a closing line break. The legend
 *  (subdomain types, integration roles, relationship patterns) is the
 *  host's since 0.3.0: designIQ draws `renderLegend` into a panel of its
 *  own in both hosts, which the widget's fit leaves room for, instead of the
 *  renderer's card over the diagram. Its menu content (`contextMapMenu`)
 *  brings Map title… (one undoable step), the PNG and SVG exports and the
 *  shortcuts dialog. */
import type { CmBaseViewer, CmModeling, MapExport } from "@miragon/context-maps-renderer";

import { contractOptions, type LoadedMiragonRenderer, type MiragonRendererSpec } from "./spec.ts";

/** the export entries designIQ leaves out: the JSON is the model's own file
 *  in the repository, and no package ships a CML serializer */
const NOT_OFFERED = new Set(["export-json", "export-cml"]);
const NO_EXPORT: MapExport = { onSelect: () => {} };

/** a legend row's meaning: a tooltip on hover, and part of the row's text
 *  for a screen reader, in designIQ's visually hidden class (the renderer's
 *  own is scoped to its canvas in the SPA, and the panel lives outside it) */
function describeRow(row: HTMLElement, meaning: string): () => void {
  row.title = meaning;
  const text = row.ownerDocument.createElement("span");
  text.className = "sr-only";
  text.textContent = `: ${meaning}`;
  row.append(text);
  return () => {
    row.removeAttribute("title");
    text.remove();
  };
}

export const spec: MiragonRendererSpec = {
  id: "context-map",
  pkg: "@miragon/context-maps-renderer",
  canvasClassName: "cm-canvas",
  contractNotation: "context-maps",
  hasLegend: true,
  async load(): Promise<LoadedMiragonRenderer> {
    const [
      {
        contextMapMenu,
        createCollaborativeModeler,
        createCollaborativeViewer,
        createShortcutsDialog,
        createTitleDialog,
        renderLegend,
      },
      ,
      { dialogChrome, imageExports, lazily },
      { svgToPng },
    ] = await Promise.all([
      import("@miragon/context-maps-renderer"),
      import("@miragon/context-maps-renderer/assets/context-maps.css"),
      import("./menu-content.ts"),
      import("../../lib/export-image.ts"),
    ]);
    const mapOf = (modeler: { diagram: unknown }): CmBaseViewer => modeler.diagram as CmBaseViewer;
    return {
      create: (mount) => createCollaborativeModeler({ ...contractOptions(mount), undoRedoKeys: true }),
      createViewer: (mount) => createCollaborativeViewer(contractOptions(mount)),
      title: (modeler) => mapOf(modeler).getMeta()?.title.trim() || undefined,
      legend: (body) => renderLegend(body, { tooltip: { attach: (row, { label }) => describeRow(row, label) } }),
      menu(modeler, host) {
        const map = mapOf(modeler);
        const chrome = dialogChrome(host);
        const title = lazily(() =>
          createTitleDialog(chrome, {
            title: () => map.getMeta()?.title ?? "",
            setTitle: (next) => map.get<CmModeling>("cmModeling").setTitle(next),
          }),
        );
        const shortcuts = lazily(() => createShortcutsDialog(chrome));
        const menu = contextMapMenu({
          editTitle: () => title.get().open(),
          exports: {
            ...imageExports(host, async () => map.saveSVG().svg, svgToPng),
            json: NO_EXPORT,
            cml: NO_EXPORT,
          },
          showKeyboardShortcuts: () => shortcuts.get().open(),
        });
        return {
          groups: { ...menu, export: menu.export.filter((entry) => !NOT_OFFERED.has(entry.id)) },
          destroy() {
            title.destroy();
            shortcuts.destroy();
          },
        };
      },
    };
  },
};
