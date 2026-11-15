/**
 * What a mounted product editor gives the strategy surface around it (engines.md, section 6): ONE
 * interface over bpmn-js, dmn-js and the five Miragon renderers, with the diagram-js instance in
 * reach, because the spike's question is what each engine does under a board's CSS scale.
 *
 * Spike-local on purpose: the product's `MountedEditor` hides the instance, and its mounts bind
 * page-wide key listeners (bindBpmnIoZoom, mountMiragonEditor), of which the first mounted one
 * would answer for every node of a board.
 */
import type Canvas from "diagram-js/lib/core/Canvas";
import type * as Y from "yjs";

import type { ModelNotation } from "../shared.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** a diagram-js instance, structurally: bpmn-js, the DRD viewer of dmn-js, `modeler.diagram` of a Miragon renderer */
export interface DiagramLike {
  /** NEVER pass a second argument: the Miragon renderers forward the name alone, a missing service throws */
  get(service: string): unknown;
  on(event: string, callback: (event?: unknown) => void): void;
  off(event: string, callback: (event?: unknown) => void): void;
}

/** the file an editor is bound to: a replica of its own from the hub (never two bindings on one Y.Doc) */
export interface ModelSource {
  path: string;
  ytext: Y.Text;
  doc: Y.Doc;
}

export interface EngineCallbacks {
  /** conflict and sync notices of the binding */
  log(line: string): void;
}

/** "diagram": the engine's one canvas. dmn-js names its views: "drd" has a canvas, the others are HTML */
export type EngineView = "diagram" | "drd" | "decisionTable" | "literalExpression" | "none";

export interface EngineHandle {
  readonly notation: ModelNotation;
  /** the element the engine was mounted into; a strategy may move it to another parent */
  readonly host: HTMLElement;
  /** settles once the first import rendered; rejects with the import's error */
  readonly ready: Promise<void>;
  /** the engine's own object: bpmn-js Modeler, dmn-js Modeler, a Miragon modeler (with `.diagram`) */
  readonly modeler: unknown;

  /** the view the engine shows right now */
  view(): EngineView;
  /** the diagram-js instance that owns the canvas shown right now; undefined in an HTML view */
  diagram(): DiagramLike | undefined;
  /** its canvas, resolved on every call (dmn-js re-attaches its DRD viewer on each import and view switch) */
  canvas(): Canvas | undefined;
  /** the content's box in diagram units, for the spike's own fit */
  contentBounds(): Rect | undefined;
  /** a drag, a placement or a draw tool holds the canvas: no viewbox write now */
  gestureActive(): boolean;

  /**
   * "start": an import begins (the engine and the binding move the view on their own until "done").
   * "done": it ended, well or not. "view": another canvas or none is shown now (dmn-js).
   */
  onLifecycle(listener: (phase: "start" | "done" | "view") => void): () => void;
  /** a viewbox change on whichever canvas is shown, whoever made it */
  onViewbox(listener: () => void): () => void;

  /** hands the canvas the focus (after `inert` is gone) */
  focus(): void;
  /** disarm: nothing selected, no open pad, popup or label editor, no focus inside */
  release(): void;
  /**
   * The counter strategy's repair: what diagram-js draws with `position: fixed` and client
   * coordinates (its popup menu, its palette tooltip) is created inside `popupHost` from now on, an
   * element at body level with no transformed ancestor. Returns the names of those two services
   * this engine does not have.
   */
  adoptPopups(popupHost: HTMLElement): string[];
  /**
   * Selectors of what the engine draws with `position: fixed` and client coordinates INSIDE its own
   * container, where no re-routing reaches it. The counter strategy shifts these back by the host's
   * client origin with CSS (board-spike.css).
   */
  readonly fixedInContainer: readonly string[];
  destroy(): void;
}

/**
 * Extra didi modules for a mount, appended AFTER the modules the product constructs its editor
 * with. Without them (no options, or empty lists) a mount constructs its editor exactly as before.
 */
export interface MountOptions {
  /**
   * For every diagram-js instance: the bpmn-js Modeler, the DRD of dmn-js, the diagram of each of
   * the five Miragon renderers.
   */
  diagramModules?: readonly unknown[];
  /** for dmn-js's decision table (table-js); no other engine has a table */
  tableModules?: readonly unknown[];
}

export type MountEngine = (
  host: HTMLElement,
  source: ModelSource,
  callbacks: EngineCallbacks,
  options?: MountOptions,
) => Promise<EngineHandle>;
