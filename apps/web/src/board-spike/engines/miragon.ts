/**
 * The five Miragon renderers (Wardley Map, Team Topology, Event Storming, Context Map, Value
 * Chain): ONE function over the product's renderer specs (notations/miragon). The spec loads the
 * renderer and its stylesheet and builds the editing modeler; the product's binding ties it to the
 * file. Every modeler exposes its diagram-js instance as `modeler.diagram`.
 *
 * Left out on purpose, against the product's mountMiragonEditor: its keydown listener on the
 * DOCUMENT, the menu with its dialogs, the todo and the presence layer. `fitOnImport: false`: the
 * board sets the view itself, and a renderer's own fit depends on the host's CSS size at import
 * time, which in the counter strategy depends on the board zoom.
 */
import { bindMiragon } from "@designiq/live-client/miragon-sync";
import type { CollaborativeModelerOptions } from "@miragon/modeler-api";
import type Canvas from "diagram-js/lib/core/Canvas";
import type { ModuleDeclaration } from "didi";

import { keepWheelZoomDirection } from "@/mcp-app/engines/diagram-js";
import { MIRAGON_RENDERERS, type MiragonModeler } from "@/notations/miragon";
import { contractOptions } from "@/notations/miragon/spec";

import type { ModelNotation } from "../shared.ts";
import { adoptDiagramPopups, canvasOf, drawnBounds, listen, mirrorAncestors, releaseDiagram } from "./diagram.ts";
import type {
  DiagramLike,
  EngineCallbacks,
  EngineHandle,
  ModelSource,
  MountEngine,
  MountOptions,
  Rect,
} from "./types.ts";

type MiragonNotation = Exclude<ModelNotation, "bpmn" | "dmn">;

/**
 * The renderer packages' own editing factories, for a mount WITH extra modules (MountOptions). The
 * product's `create()` (LoadedMiragonRenderer in notations/miragon/spec.ts) takes its own two
 * options and drops everything else, so `additionalModules` cannot go through it. All five
 * packages' `createCollaborativeModeler` take it (Collaborative*Options in their typings:
 * "appended to the renderer's own modules"). The package is loaded already when one of these is
 * called (the spec's `load()`, which brings the stylesheet too).
 */
const FACTORIES: Readonly<
  Record<
    MiragonNotation,
    () => Promise<{
      createCollaborativeModeler(
        options: CollaborativeModelerOptions & { additionalModules?: ModuleDeclaration[] },
      ): MiragonModeler;
    }>
  >
> = {
  wardley: () => import("@miragon/wardley-renderer"),
  "team-topology": () => import("@miragon/team-topologies-renderer"),
  "event-storming": () => import("@miragon/event-storming-renderer"),
  "context-map": () => import("@miragon/context-maps-renderer"),
  "value-chain": () => import("@miragon/value-chain-renderer"),
};

/**
 * What a renderer draws with `position: fixed` and client coordinates beside diagram-js's popup
 * menu and palette tooltip, and appends to its own canvas container (EngineHandle.fixedInContainer).
 * Context Maps: the context pad's text prompt.
 */
const FIXED_IN_CONTAINER: Partial<Record<ModelNotation, readonly string[]>> = {
  "context-map": [".cm-pad-prompt"],
};

export function mountMiragon(notation: ModelNotation): MountEngine {
  return async (
    host: HTMLElement,
    source: ModelSource,
    callbacks: EngineCallbacks,
    options?: MountOptions,
  ): Promise<EngineHandle> => {
    const spec = MIRAGON_RENDERERS.find((one) => one.id === notation);
    if (!spec) throw new Error(`no Miragon renderer for '${notation}'`);
    // the renderer's stylesheet is scoped under this class (vendor-css.ts)
    host.classList.add(spec.canvasClassName);
    const renderer = await spec.load();
    const extra = options?.diagramModules ?? [];
    const modeler =
      extra.length === 0
        ? renderer.create({ fitOnImport: false })
        : // what every spec's create() passes its factory, plus the modules
          (await FACTORIES[notation as MiragonNotation]()).createCollaborativeModeler({
            ...contractOptions({ fitOnImport: false }),
            undoRedoKeys: true,
            additionalModules: [...extra] as ModuleDeclaration[],
          });
    // the host is in the document with a size: a detached or 0 x 0 host gives NaN viewboxes
    modeler.attachTo(host);
    const diagram: DiagramLike = modeler.diagram;
    const canvas = (): Canvas | undefined => canvasOf(diagram);

    let settle!: () => void;
    let fail!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const onDone = (): void => settle();
    diagram.on("import.done", onDone);
    const unguardWheel = keepWheelZoomDirection(diagram as never);
    let unbind: () => void;
    try {
      // throws when the renderer is of another notation or contract version
      unbind = bindMiragon(
        modeler,
        spec.contractNotation,
        source.ytext,
        source.doc,
        (message) => callbacks.log(`${source.path}: ${message}`),
        (message) => fail(new Error(message)),
      );
    } catch (error) {
      unguardWheel();
      modeler.destroy();
      throw error;
    }

    return {
      notation,
      host,
      ready,
      modeler,
      view: () => "diagram",
      diagram: () => diagram,
      canvas,
      contentBounds(): Rect | undefined {
        // contract 1.3: the box of everything the notation draws (Wardley's plot and axes too)
        const bounds = modeler.contentBounds?.();
        return bounds && bounds.width > 0 && bounds.height > 0 ? bounds : drawnBounds(canvas());
      },
      // contract 1.5: the renderers have gestures of their own (draw tools, label drags)
      gestureActive: () => modeler.interaction?.active() ?? false,
      onLifecycle(listener) {
        // not import.parse.start: two renderers do not fire it, and a failed parse fires no import.done
        const offStart = listen(diagram, ["import.render.start"], () => listener("start"));
        const offDone = listen(diagram, ["import.done"], () => listener("done"));
        return () => {
          offStart();
          offDone();
        };
      },
      onViewbox: (listener) => listen(diagram, ["canvas.viewbox.changed"], listener),
      focus: () => canvas()?.focus(),
      release() {
        // a label editor of a renderer is a text field in the host: it ends when it loses the focus
        const focused = document.activeElement;
        if (focused instanceof HTMLElement || focused instanceof SVGElement) {
          if (host.contains(focused)) focused.blur();
        }
        releaseDiagram(diagram);
      },
      adoptPopups: (popupHost) =>
        adoptDiagramPopups(diagram, mirrorAncestors(popupHost, host, canvas()?.getContainer())),
      fixedInContainer: FIXED_IN_CONTAINER[notation] ?? [],
      destroy() {
        try {
          diagram.off("import.done", onDone);
        } catch {
          /* destroyed already */
        }
        unbind();
        unguardWheel();
        modeler.destroy();
      },
    };
  };
}
