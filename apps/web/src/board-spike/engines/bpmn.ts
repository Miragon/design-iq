/**
 * BPMN: ONE bpmn-js Modeler, constructed as the product constructs it (notations/bpmn-editor.ts:
 * the CI canvas options, the sticky and the colour module, the sticky moddle extension) and bound
 * to the file with the product's own binding. Left out on purpose: bindBpmnIoZoom (a keydown
 * listener on the DOCUMENT, of which the first mounted editor would answer for every node), the
 * todo and the presence canvas.
 */
import { bindBpmn } from "@designiq/live-client/bpmn-sync";
import BpmnModeler from "bpmn-js/lib/Modeler";
import type Canvas from "diagram-js/lib/core/Canvas";
import type { ModuleDeclaration } from "didi";

import { BPMN_CANVAS_OPTIONS, canvasFontReady } from "@/lib/canvas-theme";
import { keepWheelZoomDirection } from "@/mcp-app/engines/diagram-js";
import { bpmnColorModule } from "@/notations/bpmn-color";
import { bpmnStickyModule, stickyModdle } from "@/notations/bpmn-sticky";

import { adoptDiagramPopups, dragRunning, drawnBounds, listen, mirrorAncestors, releaseDiagram } from "./diagram.ts";
import type { DiagramLike, EngineCallbacks, EngineHandle, ModelSource, MountOptions } from "./types.ts";

export async function mountBpmn(
  host: HTMLElement,
  source: ModelSource,
  callbacks: EngineCallbacks,
  options?: MountOptions,
): Promise<EngineHandle> {
  // the bpmn.io theme and the host's size rule are scoped under this class
  host.classList.add("bpmn-canvas");
  // the binding imports at once, and labels wrapped in a fallback font stay wrapped that way
  await canvasFontReady();
  const modeler = new BpmnModeler({
    container: host,
    ...BPMN_CANVAS_OPTIONS,
    // a strategy's modules (MountOptions) after the product's own
    additionalModules: [
      bpmnStickyModule,
      bpmnColorModule,
      ...((options?.diagramModules ?? []) as readonly ModuleDeclaration[]),
    ],
    moddleExtensions: { sticky: stickyModdle },
  });
  const diagram = modeler as unknown as DiagramLike;
  const canvas = (): Canvas => modeler.get<Canvas>("canvas");

  let settle!: () => void;
  let fail!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // bpmn-js emits import.done with { error, warnings } (BaseViewer.js); a text that fails the
  // binding's gate never reaches importXML, and onImportError tells
  const onDone = (event?: unknown): void => {
    const error = (event as { error?: Error | null } | undefined)?.error;
    if (error) fail(error);
    else settle();
  };
  diagram.on("import.done", onDone);
  const unguardWheel = keepWheelZoomDirection(modeler as never);
  const unbind = bindBpmn(
    modeler as never,
    source.ytext,
    source.doc,
    (message) => callbacks.log(`${source.path}: ${message}`),
    (message) => fail(new Error(message)),
    // holds a remote re-import back while a pointer is down on the host or a drag preview exists
    { canvasHost: host },
  );

  return {
    notation: "bpmn",
    host,
    ready,
    modeler,
    view: () => "diagram",
    diagram: () => diagram,
    canvas,
    contentBounds: () => drawnBounds(canvas()),
    gestureActive: () => dragRunning(diagram) || host.getElementsByClassName("djs-drag-active").length > 0,
    onLifecycle(listener) {
      const offStart = listen(diagram, ["import.parse.start"], () => listener("start"));
      const offDone = listen(diagram, ["import.done"], () => listener("done"));
      return () => {
        offStart();
        offDone();
      };
    },
    onViewbox: (listener) => listen(diagram, ["canvas.viewbox.changed"], listener),
    focus: () => canvas().focus(),
    release() {
      releaseDiagram(diagram);
      const focused = document.activeElement;
      if (focused instanceof HTMLElement || focused instanceof SVGElement) {
        if (host.contains(focused)) focused.blur();
      }
    },
    adoptPopups: (popupHost) => adoptDiagramPopups(diagram, mirrorAncestors(popupHost, host, canvas().getContainer())),
    fixedInContainer: [],
    destroy() {
      // the product's order: the binding first, then the modeler (sync.md 1.8)
      unbind();
      unguardWheel();
      modeler.destroy();
    },
  };
}
