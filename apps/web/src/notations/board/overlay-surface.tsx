/**
 * A model in a node, edited in place by the product's own editor: the node mounts what the SPA
 * mounts for that notation (product-mount.ts), unmodified, on a live document of the model's own,
 * and moves that editor's host into the board's screen-space layer while the node is armed. The
 * layer is a child of the board outside its scaled viewport, so no ancestor of the armed editor
 * carries a transform: pointer math is exact and `position: fixed` popups work unpatched.
 *
 * - No view controller. The arm rules arm a node at board zoom exactly 1 and disarm it before a
 *   board zoom, so the armed host has the size of its preview and the editor's own view (its
 *   first fit, then whatever the person did) is never rescaled. With the rules off (`armzoom` off)
 *   this surface is not defined away from zoom 1: the host follows the node's rectangle and the
 *   picture in it is not brought in scale.
 * - Keys. Every product mount binds its chrome keys on the document and asks `ctx.visibility`
 *   whether its canvas is on screen: here that answer is "this node is armed", so of N mounted
 *   editors only the armed one takes them.
 * - Ready and release are read off and done through the DOM (inpage-contract.ts): the product's
 *   MountedEditor has neither.
 */
import { useStoreApi } from "@xyflow/react";
import { useCallback, useLayoutEffect, useRef } from "react";

import type { EditorContext, LayerVisibility, MountedEditor } from "@/notations/registry";

import { useBoardContext } from "./board-context.tsx";
import { firstImport, releaseByDom } from "./inpage-contract.ts";
import { createProbe } from "./probe.ts";
import { productMount } from "./product-mount.ts";
import type { SurfaceProps } from "./surface.ts";

/** the nearest device pixel: a box on a fractional CSS px is drawn blurred */
function snap(value: number): number {
  const ratio = window.devicePixelRatio || 1;
  return Math.round(value * ratio) / ratio;
}

/** what `hooks.engine(nodeId)` hands a script for such a node */
export interface ProductRuntime {
  readonly nodeId: string;
  readonly strategy: "overlay";
  readonly mount: "product";
  /** the editor's host element: in the node (preview) or, armed, in the board's layer */
  readonly host: HTMLDivElement;
  /** the element in the node body the host was created in */
  readonly home: HTMLDivElement;
  /** the product's handle; null until its mount function returned */
  editor: MountedEditor | null;
  armed: boolean;
  /** container px per flow unit of the editor's view: always 1, the view is never rescaled */
  readonly zoom: 1;
  /** the node body in flow units */
  width: number;
  height: number;
  /** set while the host is in the layer: the node body's place inside the node, and the last rectangle written */
  placed: { bodyLeft: number; bodyTop: number; rect: string } | null;
  /** tells the product mount that "on screen" changed */
  visibilityChanged(): void;
  /** tells the host whether the person edits the file here (armed) or only looks at it */
  present(present: boolean): void;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

export function ProductOverlaySurface({ nodeId, notation, file, armed, width, height }: SurfaceProps) {
  const { hub, store, registerSurface, reportMount, log, overlayLayer, repo, via } = useBoardContext();
  const flow = useStoreApi();
  const slot = useRef<HTMLDivElement>(null);
  const runtime = useRef<ProductRuntime | null>(null);
  const latest = useRef({ armed, width, height });
  useLayoutEffect(() => {
    latest.current = { armed, width, height };
  });

  /** the host where the state of now wants it: in the layer over the node body, or back in the node */
  const place = useCallback(
    (current: ProductRuntime): void => {
      const { host, home } = current;
      const layer = overlayLayer();
      if (current.armed && layer) {
        if (host.parentElement !== layer) {
          // layout px ignore every transform: read once per arming, before the host leaves the node
          const body = home.closest<HTMLElement>(".board-node__body");
          current.placed = { bodyLeft: body?.offsetLeft ?? 0, bodyTop: body?.offsetTop ?? 0, rect: "" };
          layer.appendChild(host);
          host.dataset.layout = "overlay";
          // the move took the focus from whatever had it inside
          current.editor?.focus?.();
        }
        const { placed } = current;
        const state = flow.getState();
        const node = state.nodeLookup.get(nodeId);
        if (!placed || !node) return;
        const [x, y, zoom] = state.transform;
        const origin = node.internals.positionAbsolute;
        const left = snap(x + (origin.x + placed.bodyLeft) * zoom);
        const top = snap(y + (origin.y + placed.bodyTop) * zoom);
        const boxWidth = snap(x + (origin.x + placed.bodyLeft + current.width) * zoom) - left;
        const boxHeight = snap(y + (origin.y + placed.bodyTop + current.height) * zoom) - top;
        const rect = `${left},${top},${boxWidth},${boxHeight}`;
        if (rect === placed.rect) return;
        placed.rect = rect;
        const { style } = host;
        style.left = `${left}px`;
        style.top = `${top}px`;
        style.width = `${boxWidth}px`;
        style.height = `${boxHeight}px`;
        return;
      }
      if (host.parentElement !== home) {
        home.appendChild(host);
        host.dataset.layout = "preview";
        const { style } = host;
        style.left = "";
        style.top = "";
        style.width = "";
        style.height = "";
      }
      current.placed = null;
    },
    [flow, nodeId, overlayLayer],
  );

  useLayoutEffect(() => {
    const parent = slot.current;
    if (!parent) return;
    const product = productMount(notation, via);
    const { fitInsets } = product;
    const host = document.createElement("div");
    // the product's stylesheets are scoped under the canvas class
    host.className = `board-engine ${product.canvasClassName}`;
    host.dataset.strategy = "overlay";
    host.dataset.mount = "product";
    host.dataset.armed = String(latest.current.armed);
    host.dataset.layout = "preview";
    parent.appendChild(host);

    // a live document of its own: never two bindings on one Y.Doc
    const replica = hub.replica(file);
    // a node that is armed from the start (`arm` on load) is edited from the start
    if (latest.current.armed) replica.present?.(true);
    // The model was renamed or moved: the board names it by its path, so the node follows. The new
    // `file` comes back as this component's prop, and the editor is mounted anew on it. Every
    // client that has the board open writes the same value
    const offMoved = replica.onMoved?.((to) => store.gesture((tx) => tx.update(nodeId, { file: to })));
    const shown = new Set<() => void>();
    const current: ProductRuntime = {
      nodeId,
      strategy: "overlay",
      mount: "product",
      host,
      home: parent,
      editor: null,
      armed: latest.current.armed,
      zoom: 1,
      width: latest.current.width,
      height: latest.current.height,
      placed: null,
      visibilityChanged: () => {
        for (const listener of [...shown]) listener();
      },
      present: (present) => {
        replica.present?.(present);
        // a preview is nowhere in the model: the cursor this person had there goes with the arming
        if (!present) replica.presence?.setLocal(null);
      },
    };
    runtime.current = current;
    const visibility: LayerVisibility = {
      visible: () => current.armed,
      onChange: (listener) => {
        shown.add(listener);
        return () => void shown.delete(listener);
      },
    };

    let cancelled = false;
    let importFailure: string | undefined;
    let settleReady!: () => void;
    let failReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      settleReady = resolve;
      failReady = reject;
    });
    reportMount(nodeId);
    const unregister = registerSurface(nodeId, {
      ready,
      probe: createProbe({ host, text: () => replica.ytext.toString() }),
      get engine() {
        return current;
      },
      whenInteractive: () => ready.then(nextFrame, () => undefined),
    });

    const context: EditorContext = {
      ytext: replica.ytext,
      doc: replica.doc,
      repo,
      docPath: file,
      onSyncError: (message) => log(`${file}: ${message}`),
      onImportFailed: (message) => void (importFailure = message),
      // the first fit leaves the editor's own chrome free: a node is small beside a palette
      sync: { ...replica.sync, ...(fitInsets ? { fitInsets: () => fitInsets(host) } : {}) },
      // The model's room: the editor draws the people who edit this model, here or anywhere else,
      // also in the preview. This person's own cursor and selection go out only while the node
      // is armed: a preview takes no pointer, and whoever only looks is not in that room's roster
      ...(replica.presence
        ? {
            presence: {
              setLocal: (canvas) => replica.presence?.setLocal(current.armed ? canvas : null),
              onRemote: replica.presence.onRemote,
            },
          }
        : {}),
      onBadgeClick: () => undefined,
      onSelectionChanged: () => undefined,
      visibility,
    };
    // a live session's text arrives after the session opened: an editor mounted before would import nothing
    (replica.ready ?? Promise.resolve())
      .then(() => product.mount(host, context))
      .then(
        (editor) => {
          if (cancelled) {
            // the product's order: the editor (it unbinds first), then the document it was bound to
            editor.destroy();
            replica.destroy();
            return;
          }
          current.editor = editor;
          place(current);
          if (current.armed) editor.focus?.();
          firstImport(host, () => importFailure).then(settleReady, failReady);
        },
        (error: unknown) => {
          if (cancelled) {
            replica.destroy();
            return;
          }
          host.classList.add("board-engine--failed");
          host.textContent = error instanceof Error ? error.message : String(error);
          failReady(error);
          // nothing is bound to it any more
          replica.destroy();
        },
      );

    return () => {
      cancelled = true;
      offMoved?.();
      unregister();
      if (current.editor) {
        current.editor.destroy();
        replica.destroy();
      }
      host.remove();
      runtime.current = null;
    };
  }, [hub, store, nodeId, notation, file, registerSurface, reportMount, log, place, repo, via]);

  useLayoutEffect(() => {
    const current = runtime.current;
    if (!current) return;
    current.width = width;
    current.height = height;
    if (armed !== current.armed) {
      // while the editor still shows its chrome and has the focus: the sheet hides both with the flag
      if (!armed) releaseByDom(current.host);
      current.armed = armed;
      current.host.dataset.armed = String(armed);
      current.visibilityChanged();
      current.present(armed);
    }
    place(current);
  }, [place, armed, width, height]);

  useLayoutEffect(() => {
    // Every update of React Flow's store, synchronously: a pan (a new transform) and a move or
    // resize of the node (new internals). No render, and no write when nothing moved
    const off = flow.subscribe(() => {
      const current = runtime.current;
      if (current?.armed) place(current);
    });
    // the layer is attached by the board's first commit, which may come after this surface's
    const late = requestAnimationFrame(() => {
      const current = runtime.current;
      if (current?.armed) place(current);
    });
    return () => {
      off();
      cancelAnimationFrame(late);
    };
  }, [flow, place]);

  return (
    <div className="board-surface" data-surface="overlay" data-mount="product">
      <div ref={slot} className="board-surface__slot" />
      {/* what stays in the node while its editor is in the layer above it */}
      {armed && <div className="board-surface__placeholder">Editing in the layer above the board</div>}
    </div>
  );
}
