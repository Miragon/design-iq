/**
 * DMN: ONE dmn-js Modeler with the product's options (notations/dmn-editor.ts: the simulation
 * add-on and the CI's DRD theme), bound with the product's binding, without bindBpmnIoZoom's
 * document-level key listener.
 *
 * dmn-js is multi-view. Only the DRD is a diagram-js canvas; a decision table and a literal
 * expression are HTML with no viewbox at all. The manager keeps one viewer per view TYPE and
 * detaches and re-attaches it on every view switch and on every import, so the canvas is resolved
 * on each call and never kept.
 */
import { bindDmn } from "@designiq/live-client/dmn-sync";
import type Canvas from "diagram-js/lib/core/Canvas";
import DmnModeler, { type DmnViewer } from "dmn-js/lib/Modeler";

import { canvasFontReady, withDrdCanvasTheme } from "@/lib/canvas-theme";
import { dmnSimulationViews } from "@/lib/dmn-simulation";
import { keepWheelZoomDirection } from "@/mcp-app/engines/diagram-js";

import {
  adoptDiagramPopups,
  canvasOf,
  dragRunning,
  drawnBounds,
  listen,
  mirrorAncestors,
  releaseDiagram,
} from "./diagram.ts";
import type { DiagramLike, EngineCallbacks, EngineHandle, EngineView, ModelSource, MountOptions } from "./types.ts";

const VIEWS: readonly EngineView[] = ["drd", "decisionTable", "literalExpression"];

/**
 * A view's options with a strategy's modules after its own. dmn-js hands each viewer its own key
 * only (dmn-js-shared Manager._createViewer: `...this._options[id]`, its `additionalModules`
 * followed by the manager's own). Without extra modules the view's options are passed as they are.
 */
const withModules = <V extends { additionalModules?: unknown[] }>(view: V, extra: readonly unknown[] | undefined): V =>
  extra && extra.length > 0 ? { ...view, additionalModules: [...(view.additionalModules ?? []), ...extra] } : view;

export async function mountDmn(
  host: HTMLElement,
  source: ModelSource,
  callbacks: EngineCallbacks,
  options?: MountOptions,
): Promise<EngineHandle> {
  host.classList.add("dmn-canvas");
  await canvasFontReady();
  const views = withDrdCanvasTheme(dmnSimulationViews);
  const modeler = new DmnModeler({
    container: host,
    ...views,
    // MountOptions: diagramModules for the DRD (diagram-js), tableModules for the decision table (table-js)
    drd: withModules(views.drd, options?.diagramModules),
    decisionTable: withModules(views.decisionTable, options?.tableModules),
  });
  // the manager's own events (import.*, views.changed); its `on` is typed for one payload shape
  const manager = modeler as unknown as DiagramLike;

  const view = (): EngineView => {
    const type = modeler.getActiveView()?.type;
    return VIEWS.find((known) => known === type) ?? "none";
  };
  const drd = (): DiagramLike | undefined =>
    view() === "drd" ? ((modeler.getActiveViewer() as DiagramLike | null) ?? undefined) : undefined;

  const viewboxListeners = new Set<() => void>();
  /** per DRD viewer (dmn-js keeps one for the modeler's life): what was bound to it, to undo */
  const bound = new Map<DmnViewer, Array<() => void>>();
  let popupHost: HTMLElement | undefined;
  const adopted = new Set<DmnViewer>();
  let unadopted: string[] = [];

  const adopt = (viewer: DmnViewer): void => {
    if (!popupHost || adopted.has(viewer)) return;
    const container = canvasOf(viewer as DiagramLike)?.getContainer();
    // the mirror needs the viewer's container inside the host: it is there only while the DRD shows
    if (!container || !host.contains(container)) return;
    adopted.add(viewer);
    unadopted = adoptDiagramPopups(viewer as DiagramLike, mirrorAncestors(popupHost, host, container));
  };
  const onViews = (): void => {
    if (view() !== "drd") return;
    const viewer = modeler.getActiveViewer();
    if (!viewer) return;
    if (!bound.has(viewer)) {
      bound.set(viewer, [
        listen(viewer as DiagramLike, ["canvas.viewbox.changed"], () => {
          for (const listener of [...viewboxListeners]) listener();
        }),
        // from a view below 20 % a wheel zoom out would zoom in (the product guards it the same way)
        keepWheelZoomDirection(viewer as never),
      ]);
    }
    adopt(viewer);
  };
  manager.on("views.changed", onViews);

  let settle!: () => void;
  let fail!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const onDone = (event?: unknown): void => {
    const error = (event as { error?: Error | null } | undefined)?.error;
    if (error) fail(error);
    else settle();
  };
  manager.on("import.done", onDone);
  const unbind = bindDmn(
    modeler as never,
    source.ytext,
    source.doc,
    (message) => callbacks.log(`${source.path}: ${message}`),
    (message) => fail(new Error(message)),
    { canvasHost: host },
  );

  const canvas = (): Canvas | undefined => canvasOf(drd());
  return {
    notation: "dmn",
    host,
    ready,
    modeler,
    view,
    diagram: drd,
    canvas,
    contentBounds: () => drawnBounds(canvas()),
    gestureActive: () => dragRunning(drd()) || host.getElementsByClassName("djs-drag-active").length > 0,
    onLifecycle(listener) {
      const offStart = listen(manager, ["import.parse.start"], () => listener("start"));
      const offDone = listen(manager, ["import.done"], () => listener("done"));
      const offView = listen(manager, ["views.changed"], () => listener("view"));
      return () => {
        offStart();
        offDone();
        offView();
      };
    },
    onViewbox(listener) {
      viewboxListeners.add(listener);
      return () => void viewboxListeners.delete(listener);
    },
    focus: () => canvas()?.focus(),
    release() {
      releaseDiagram(drd());
      // a table cell commits on blur
      const focused = document.activeElement;
      if (focused instanceof HTMLElement || focused instanceof SVGElement) {
        if (host.contains(focused)) focused.blur();
      }
    },
    adoptPopups(target) {
      popupHost = target;
      onViews();
      // The DRD's replace menu and palette tooltip. The table's own menus (context menu, hit policy
      // and type dropdowns) are not `position: fixed`: they are placed in the host with a client
      // delta, which is right at a net scale of 1 (pointer-math-other.md, idiom I2)
      return unadopted;
    },
    fixedInContainer: [],
    destroy() {
      unbind();
      manager.off("views.changed", onViews);
      manager.off("import.done", onDone);
      for (const undo of [...bound.values()].flat()) undo();
      bound.clear();
      modeler.destroy();
    },
  };
}
