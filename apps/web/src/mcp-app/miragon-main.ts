/**
 * The Miragon-renderer widget — ONE entry for every notation whose editor is
 * a Miragon modeler (wardley, team topology, event storming, context map).
 * The renderer spec rides in through the build-time alias
 * `@/mcp-app/widget-spec` (vite.widget.config.ts miragonWidgetConfig: one
 * single-file bundle per spec — exactly one engine per emitted file is the
 * widgets' whole CSS scoping; the dev server resolves it to widget-spec.dev.ts
 * for `/mcp-app-miragon.html?notation=<id>`). The engine is engines/miragon.ts
 * on the shared widget core: no extras, no icon font (the renderers draw
 * inline SVG), the file-route deep link (core/widget.ts defaults).
 */
import "./miragon-styles.css";

import { byId } from "@designiq/notations";

import { spec } from "@/mcp-app/widget-spec";
import type { LoadedMiragonRenderer } from "@/notations/miragon/spec";

import { h } from "./chrome/dom";
import { bootWidget } from "./core/widget";
import { mountMiragonEngine } from "./engines/miragon";

const notation = byId(spec.id);
if (!notation) throw new Error(`widget: no notation descriptor for renderer spec '${spec.id}'`);
document.title = `designIQ ${notation.label} modeler`;

let renderer: LoadedMiragonRenderer | undefined;
bootWidget({
  notation: spec.id,
  noun: notation.noun.singular,
  // the engine module is inlined into the bundle, so this resolves in a
  // microtask; a rejection is the "modeler could not start" card (Try again)
  prepare: async () => {
    renderer = await spec.load();
  },
  // every Miragon renderer adopts the element it is handed as its root and
  // REMOVES it on destroy — so each mount gets a host of its own inside
  // #canvas (the superseded freeze destroys the editor, then mounts a viewer
  // into the same #canvas). The host carries the scope class like the SPA's
  // editor host: the dev server's vendor-CSS prefix is a compound with the
  // renderer's root class, so both must sit on the same element
  engine: (container, readonly, opts) => {
    if (!renderer) throw new Error(`the ${notation.label} renderer is not loaded`);
    const host = h("div", { class: spec.canvasClassName });
    container.append(host);
    return mountMiragonEngine(renderer, host, readonly, opts);
  },
});
