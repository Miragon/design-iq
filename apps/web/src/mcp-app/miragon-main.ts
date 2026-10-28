/**
 * The Miragon-renderer widget — ONE entry for every notation whose editor is
 * a Miragon modeler (wardley, team topology, event storming, context map,
 * value chain).
 * The renderer spec rides in through the build-time alias
 * `@/mcp-app/widget-spec` (vite.widget.config.ts miragonWidgetConfig: one
 * single-file bundle per spec — exactly one engine per emitted file is the
 * widgets' whole CSS scoping; the dev server resolves it to widget-spec.dev.ts
 * for `/mcp-app-miragon.html?notation=<id>`). The engine is engines/miragon.ts
 * on the shared widget core: no icon font (the renderers draw inline SVG)
 * but Geist Mono for the key chips, the file-route deep link carrying the
 * canvas selection (?element=). The extras: the Todos card with its canvas
 * badges (todos.ts on lib/todo-surface-canvas.ts, the controller the SPA's
 * Miragon editor mounts too) and the legend panel of a notation that has one
 * (legend.ts).
 */
import "./miragon-styles.css";

import { fileDeepLink } from "@designiq/contracts/deep-link";
import { byId } from "@designiq/notations";

import { attachSurfaceTodoCanvas } from "@/lib/todo-surface-canvas";
import { spec } from "@/mcp-app/widget-spec";
import type { LoadedMiragonRenderer } from "@/notations/miragon/spec";

import { h } from "./chrome/dom";
import { bootWidget } from "./core/widget";
import { type MiragonEngine, mountMiragonEngine } from "./engines/miragon";
import { WIDGET_FONT_MONO } from "./font";
import { mountLegend } from "./legend";
import { mountTodos } from "./todos";

const notation = byId(spec.id);
if (!notation) throw new Error(`widget: no notation descriptor for renderer spec '${spec.id}'`);
document.title = `designIQ ${notation.label} modeler`;

let renderer: LoadedMiragonRenderer | undefined;
bootWidget<MiragonEngine>({
  notation: spec.id,
  noun: notation.noun.singular,
  // the file route, carrying the canvas selection (?element=)
  deepLink: (publicUrl, doc, engine) => fileDeepLink(publicUrl, doc.repo, doc.path, engine.selectedElementId?.()),
  // the shortcuts dialog sets its key chips in Geist Mono (guide §5.6)
  fonts: [WIDGET_FONT_MONO],
  // the engine module is inlined into the bundle, so this resolves in a
  // microtask; a rejection is the "modeler could not start" card (Try again)
  prepare: async () => {
    renderer = await spec.load();
  },
  // each mount gets a host of its own inside #canvas, sized by
  // miragon-styles.css (the renderer's root fills it), and removed with the
  // engine: a renderer's destroy removes only that root, and the superseded
  // freeze destroys the editor before it mounts a viewer into the same
  // #canvas. The host carries the scope class like the SPA's editor host, for
  // the dev server's vendor-CSS prefix
  engine: (container, readonly, opts) => {
    if (!renderer) throw new Error(`the ${notation.label} renderer is not loaded`);
    const host = h("div", { class: spec.canvasClassName });
    container.append(host);
    try {
      const engine = mountMiragonEngine(spec, renderer, host, readonly, opts);
      return {
        ...engine,
        destroy: () => {
          engine.destroy();
          host.remove();
        },
      };
    } catch (error) {
      host.remove();
      throw error;
    }
  },
  extras: ({ app, engine, readonly, chrome }) => {
    const legend = spec.hasLegend ? mountLegend(chrome, (body) => renderer?.legend?.(body) ?? (() => {})) : undefined;
    // bound BEFORE the first import: the canvas controller re-renders its
    // badges on every `import.done` (incl. the live re-imports)
    const todos = mountTodos(
      app,
      (hooks) => attachSurfaceTodoCanvas(engine.modeler.diagram, engine.modeler.elements, hooks),
      { readonly, chrome, noun: notation.noun.singular },
    );
    return {
      // discovery at the read, in parallel with the import; the toggle
      // arrives with the canvas
      onRead: (doc) => todos.load(doc),
      onDocument: (doc, input) => {
        legend?.onDocument(doc, input);
        todos.landed(doc);
      },
      destroy: () => {
        todos.destroy();
        legend?.destroy();
      },
    };
  },
});
