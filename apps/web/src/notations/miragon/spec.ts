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
 * (@designiq/live-client/miragon-sync). Since contract 1.2 every factory
 * also takes the contract's option names (`contractOptions`), so a spec only
 * adds what its renderer needs beyond them.
 */
import type { CollaborativeModeler, CollaborativeModelerOptions, ElementsSurface } from "@miragon/modeler-api";

import type { Insets, MenuHost } from "../../mcp-app/core/engine.ts";
import type { ModelerMenu } from "../../mcp-app/core/menu-model.ts";

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

/** what designIQ hands every mount — `contractOptions` maps it onto the
 *  factory options every renderer takes */
export interface MiragonMountOptions {
  /** what the host's chrome covers along the canvas edges (px), read
   *  whenever the renderer needs it — the widget's layout insets. The host
   *  then also fits the view after every import itself. Absent (the SPA,
   *  whose chrome sits outside the canvas): the renderer's defaults apply */
  insets?: () => Insets;
}

/**
 * The contract's factory options for a mount: the chrome's insets are the
 * free area (keyboard creation lands in it, and a renderer that constrains
 * panning keeps the host's fit where the host put it), and a host that fits
 * the view itself after every import gets no fit of the renderer's own
 * before it, so the view changes once per import.
 */
export function contractOptions({ insets }: MiragonMountOptions = {}): CollaborativeModelerOptions {
  return insets ? { freeArea: { insets }, fitOnImport: false } : {};
}

/** what a mount's menu content gets from its host */
export interface MiragonMenuHost extends MenuHost {
  /** where the renderer's dialogs and popovers live: inside the canvas
   *  host, whose class scopes the renderer's stylesheet in the SPA */
  readonly root: HTMLElement;
  /** a viewer: the entries that change the document stay disabled */
  readonly readOnly: boolean;
}

/** a mount's menu content and the dialogs it built, which go with the mount */
export interface MiragonMenu {
  readonly groups: ModelerMenu;
  destroy(): void;
}

/** what `load()` yields: the renderer package's two contract factories */
export interface LoadedMiragonRenderer {
  /** the editing mount (`meta.editable: true`) */
  create(options?: MiragonMountOptions): MiragonModeler;
  /** the read-only mount (`meta.editable: false`): no command stack, never
   *  a change event */
  createViewer(options?: MiragonMountOptions): MiragonModeler;
  /** the document's own title, for the menu header; undefined = none set */
  title?(modeler: MiragonModeler): string | undefined;
  /** the renderer's own menu content (Model, Export, Help), where its
   *  package ships it */
  menu?(modeler: MiragonModeler, host: MiragonMenuHost): MiragonMenu;
  /** draws the notation's legend into `body` (MiragonRendererSpec.hasLegend);
   *  returns what takes its tooltips off again */
  legend?(body: HTMLElement): () => void;
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
  /** the notation has a legend the host shows as a panel (LoadedMiragonRenderer.legend):
   *  known before the engine loads, so both hosts can offer its toggle */
  hasLegend?: boolean;
  /** the engine: the factories + the stylesheet — lazy, so the SPA's eager
   *  bundle carries no engine */
  load(): Promise<LoadedMiragonRenderer>;
}
