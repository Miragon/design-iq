/**
 * ONE engine per node for the node's whole life, for every in-page strategy: the hook
 * creates the host element, mounts the engine into it on a replica of the file, gives the node its
 * view controller and registers the surface with the board. Where the host sits, how large it is
 * and which zoom the view is applied with is the strategy's part (`place`).
 *
 * The host is created by hand and not by React: the overlay strategy moves it to another parent,
 * and arming, resizing and zooming must never remount what is inside. The mount effect depends on
 * the node and its file only.
 */
import { type RefObject, useLayoutEffect, useRef } from "react";

import { useBoardContext } from "../../notations/board/board-context.tsx";
import { createProbe } from "../../notations/board/probe.ts";
import type { SurfaceProps } from "../../notations/board/surface.ts";
import type { Strategy } from "../shared.ts";
import { type EngineHandle, mountEngine, type MountOptions } from "./index.ts";
import { createViewController, type ViewController } from "./view-controller.ts";

/** what `hooks.engine(nodeId)` hands a script: the engine handle and everything the surface keeps around it */
export interface EngineRuntime {
  readonly nodeId: string;
  readonly strategy: Strategy;
  /** the engine's host element; in the node (preview) or, armed in the overlay strategy, in the board's layer */
  readonly host: HTMLDivElement;
  /** the element in the node body the host was created in, and its place whenever it is in the node */
  readonly home: HTMLDivElement;
  /** null until the engine's module is loaded and the editor constructed */
  engine: EngineHandle | null;
  controller: ViewController | null;
  /** counter strategy: the body-level element the engine's `position: fixed` popups are created in */
  popupHost: HTMLElement | null;
  /** of diagram-js's two `position: fixed` services (popupMenu, hoverTooltip): those this engine has not */
  unadopted: string[];
  /** the strategy's state of now; the view controller reads `zoom`, `width` and `height` */
  armed: boolean;
  /** container px per flow unit the view is applied with: 1 in preview and in the naive strategy */
  zoom: number;
  /** the node body in flow units */
  width: number;
  height: number;
  /** a pointer is down on the host */
  pressed: boolean;
}

export interface UseEngineOptions {
  strategy: Strategy;
  /** counter: create the body-level popup host and re-route the engine's fixed popups into it */
  popupHost?: boolean;
  /** extra didi modules for the engine (engines/types.ts). Read ONCE, when the engine is mounted */
  mount?: MountOptions;
  /** the engine is constructed (its first import still runs): place the host for the state of now */
  onEngine?(runtime: EngineRuntime): void;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

export function useEngine(
  { nodeId, notation, file, armed, width, height }: SurfaceProps,
  options: UseEngineOptions,
): { slot: RefObject<HTMLDivElement | null>; runtime: RefObject<EngineRuntime | null> } {
  const { hub, registerSurface, reportMount, log } = useBoardContext();
  const slot = useRef<HTMLDivElement>(null);
  const runtime = useRef<EngineRuntime | null>(null);
  const latest = useRef({ armed, width, height, options });
  useLayoutEffect(() => {
    latest.current = { armed, width, height, options };
  });

  useLayoutEffect(() => {
    const parent = slot.current;
    if (!parent) return;
    const host = document.createElement("div");
    host.className = "board-engine";
    host.dataset.strategy = latest.current.options.strategy;
    host.dataset.armed = String(latest.current.armed);
    parent.appendChild(host);
    const state: EngineRuntime = {
      nodeId,
      strategy: latest.current.options.strategy,
      host,
      home: parent,
      engine: null,
      controller: null,
      popupHost: null,
      unadopted: [],
      armed: latest.current.armed,
      zoom: 1,
      width: latest.current.width,
      height: latest.current.height,
      pressed: false,
    };
    runtime.current = state;

    // a replica of its own: never two bindings on one Y.Doc (sync.md 1.7)
    const replica = hub.replica(file);
    let cancelled = false;
    /** the mount's promise is through, well or not: until then the replica is its to clean up */
    let mounted = false;
    let settleReady!: () => void;
    let failReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      settleReady = resolve;
      failReady = reject;
    });
    reportMount(nodeId);
    const unregister = registerSurface(nodeId, {
      ready,
      probe: createProbe({
        host,
        popupHosts: () => (state.popupHost ? [state.popupHost] : []),
        text: () => replica.ytext.toString(),
      }),
      // read when asked: the handle exists once the engine's module is loaded
      get engine() {
        return state;
      },
      // a surface whose import failed never takes input: the board's log has the reason
      whenInteractive: () => ready.then(nextFrame, () => undefined),
    });

    // a pointer held on the editor: the view controller writes no viewbox under it. The capture
    // phase, as the binding's own gesture watch: diagram-js stops the mousedown on a shape
    const onDown = (): void => void (state.pressed = true);
    const onUp = (): void => {
      if (!state.pressed) return;
      state.pressed = false;
      // after the engine's own handlers of this release
      setTimeout(() => state.controller?.sync(), 0);
    };
    host.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);

    mountEngine(
      notation,
      host,
      { path: file, ytext: replica.ytext, doc: replica.doc },
      { log },
      latest.current.options.mount,
    ).then(
      (engine) => {
        if (cancelled) {
          engine.destroy();
          replica.destroy();
          return;
        }
        mounted = true;
        state.engine = engine;
        if (latest.current.options.popupHost) {
          const popupHost = document.createElement("div");
          // the engine sheets scope their rules under the canvas host's class; the four classes keep
          // React Flow's document-level handlers off a key or a wheel inside a popup
          const canvasClasses = [...host.classList].filter((name) => name.endsWith("-canvas"));
          popupHost.className = ["board-popup-host", "nodrag", "nopan", "nowheel", "nokey", ...canvasClasses].join(" ");
          popupHost.dataset.node = nodeId;
          document.body.appendChild(popupHost);
          state.popupHost = popupHost;
          state.unadopted = engine.adoptPopups(popupHost);
        }
        state.controller = createViewController({
          engine,
          nodeSize: () => ({ width: state.width, height: state.height }),
          zoom: () => state.zoom,
          editing: () => state.armed,
          pressed: () => state.pressed,
          scopes: () => (state.popupHost ? [state.popupHost] : []),
          // the first import is through AND the node's own first view is on the canvas
          onSettled: settleReady,
        });
        engine.ready.catch(failReady);
        latest.current.options.onEngine?.(state);
      },
      (error: unknown) => {
        if (cancelled) {
          replica.destroy();
          return;
        }
        mounted = true;
        host.classList.add("board-engine--failed");
        host.textContent = error instanceof Error ? error.message : String(error);
        failReady(error);
      },
    );

    return () => {
      cancelled = true;
      unregister();
      host.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      state.controller?.destroy();
      state.popupHost?.remove();
      // the binding first, then the modeler (both inside destroy), then the replica it was bound to
      state.engine?.destroy();
      if (mounted) replica.destroy();
      host.remove();
      runtime.current = null;
    };
  }, [hub, nodeId, notation, file, registerSurface, reportMount, log]);

  return { slot, runtime };
}

/** arming and disarming as far as it is the same in every strategy: the flag the sheet reads, focus, release */
export function setArmed(runtime: EngineRuntime, armed: boolean): void {
  const before = runtime.armed;
  runtime.armed = armed;
  runtime.host.dataset.armed = String(armed);
  if (armed === before) return;
  if (armed) runtime.engine?.focus();
  else runtime.engine?.release();
}
