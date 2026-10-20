/**
 * The Miragon renderer spec — the ONE object per notation whose editor is a
 * Miragon modeler (the diagram-js renderers built from the modeler template:
 * Wardley Maps, Team Topologies, Event Storming, Context Maps). Everything
 * the platform needs to host such a renderer derives from it:
 *
 *   ./plugin.ts               → the web editor plugin (WebNotationPlugin)
 *   ../../mcp-app/engines/miragon.ts → the MCP-App widget engine
 *   ./vendor-css.ts           → the SPA's vendor-CSS scoping (pkg + canvas class), in vite.config.ts
 *   ../../../scripts/build-widgets.ts → one single-file widget bundle per spec
 *
 * The eager part is DATA (id, package, css class, contract notation); the
 * renderer and its stylesheet ride behind `load()` — the engine chunk loads
 * on mount in the SPA, and is inlined whole into the widget bundle. Every
 * renderer implements @miragon/modeler-api, so `load()` yields its two
 * contract factories and both hosts bind them the same way
 * (@designiq/live-client/miragon-sync); the only per-renderer knowledge left
 * is how its factory options spell what a host's chrome covers.
 */
import type { CollaborativeModeler, ElementsSurface } from "@miragon/modeler-api";

import type { Insets } from "../../mcp-app/core/engine.ts";

/** the diagram-js instance a renderer's factory wraps — STRUCTURALLY: the
 *  platform wires presence outlines and the widget's view controls to it */
export interface MiragonDiagram {
  /** didi's strict lookup: a service the mount does not register THROWS */
  get(service: string): unknown;
  on(event: string, callback: (event?: unknown) => void): void;
  off(event: string, callback: (event?: unknown) => void): void;
}

/** a mounted Miragon renderer: the contract, its element surface and the
 *  diagram it wraps (each renderer's `createCollaborative*` return type) */
export interface MiragonModeler extends CollaborativeModeler {
  readonly elements: ElementsSurface;
  readonly diagram: MiragonDiagram;
}

/** what designIQ hands every mount — each spec maps it onto its renderer's
 *  own factory options */
export interface MiragonMountOptions {
  /** what the host's chrome covers along the canvas edges (px), read
   *  whenever the renderer needs it — the widget's layout insets. The host
   *  then also fits the view after every import itself. Absent: nothing of
   *  the host covers the canvas (the SPA), the renderer's defaults apply */
  insets?: () => Insets;
}

/** what `load()` yields: the renderer package's two contract factories */
export interface LoadedMiragonRenderer {
  /** the editing mount (`meta.editable: true`) */
  create(options?: MiragonMountOptions): MiragonModeler;
  /** the read-only mount (`meta.editable: false`): no command stack, never
   *  a change event */
  createViewer(options?: MiragonMountOptions): MiragonModeler;
}

export interface MiragonRendererSpec {
  /** must match a NotationDescriptor.id (@designiq/notations) — AND the spec
   *  file name `<id>.ts` (the widget build resolves the spec by id) */
  id: string;
  /** the renderer's npm package — the vendor-CSS scoping keys on it */
  pkg: string;
  /** css class of the canvas host (the SPA scopes the vendor sheet under it) */
  canvasClassName: string;
  /** the renderer's `meta.notation` — its own name for the notation, which
   *  may differ from designIQ's id ("team-topologies" for "team-topology");
   *  checked when a mount binds, together with the contract version */
  contractNotation: string;
  /** the engine: the factories + the stylesheet — lazy, so the SPA's eager
   *  bundle carries no engine */
  load(): Promise<LoadedMiragonRenderer>;
}
