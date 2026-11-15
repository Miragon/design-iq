/**
 * What the board's modules share: the notations a board shows in place, boxes and viewports, the
 * arm rules' vocabulary and what a script reads of a mounted editor. Node-loadable (type
 * stripping): no import, no DOM at module level.
 */
export const STRATEGIES = ["naive", "counter", "overlay", "iframe", "plugin", "shim"] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** ids as in @designiq/notations */
export const MODEL_NOTATIONS = [
  "bpmn",
  "dmn",
  "wardley",
  "team-topology",
  "event-storming",
  "context-map",
  "value-chain",
] as const;
export type ModelNotation = (typeof MODEL_NOTATIONS)[number];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

// ── the arm rules (arm-rules.ts decides, board-arming.ts moves the board) ────

/**
 * `&armzoom=`: the board zoom a node is armed at. off: wherever the board stands; min1: at 1 or
 * above; exact1: at exactly 1, from below and from above (the default of an `overlay` node)
 */
export const ARM_ZOOMS = ["off", "min1", "exact1"] as const;
export type ArmZoom = (typeof ARM_ZOOMS)[number];
/** `&armedzoom=`: a zoom of the board while a node is armed. free: goes on under the armed editor; disarm: disarms first; lock: is refused */
export const ARMED_ZOOMS = ["free", "disarm", "lock"] as const;
export type ArmedZoom = (typeof ARMED_ZOOMS)[number];
/** `&armreturn=`: after Done or a pane click. stay: the board stays; back: it returns to where it stood before the arming moved it */
export const ARM_RETURNS = ["stay", "back"] as const;
export type ArmReturn = (typeof ARM_RETURNS)[number];
/**
 * What the anchor of an arming is. pointer: a pointer gesture armed the node (the double-click)
 * and the anchor is the pointer. centre: no pointer (Edit, the keyboard, the hook, the URL) and
 * the anchor is the node's centre. The zoom changes about the anchor, and the kind decides where
 * a node that is longer than the board's box ends up (arm-rules.ts, armViewport).
 */
export type ArmAnchor = "pointer" | "centre";

/** the rules in effect for ONE node: each from the URL when given there, else the default of the node's strategy */
export interface ArmPolicy {
  armzoom: ArmZoom;
  armedzoom: ArmedZoom;
  armreturn: ArmReturn;
  /** which of the three the URL gave; the others are the strategy's default */
  fromUrl: Array<"armzoom" | "armedzoom" | "armreturn">;
  /** ms a transition takes right now */
  motion: number;
  /** where `motion` comes from: `&armmotion=`, else prefers-reduced-motion (0), else the design token */
  motionFrom: "url" | "reduced-motion" | "token";
  /** px between the armed node and the edge of the box it is brought into */
  margin: number;
  /** a board zoom this close to 1 is taken for 1 */
  tolerance: number;
}

/** one move of the board made by the arm rules */
export interface ArmTransition {
  /** counts from 1 */
  id: number;
  /** arm: the board moves, then the node is armed. return: the board goes back after a disarm (armreturn=back) */
  purpose: "arm" | "return";
  /** the node the move belongs to */
  nodeId: string;
  /** what asked for it: pointer, button, hook or url for an arming; done, pane or hook for a return */
  by: string;
  /** purpose arm: the kind of anchor the node was placed by, for every move of that arming (the first and a second look) */
  anchor?: ArmAnchor;
  from: Viewport;
  to: Viewport;
  /** where the board stood when the move ended: `to`, unless it was interrupted */
  end: Viewport;
  /** the duration asked for, ms (0: one write, at once) */
  askedMs: number;
  /** from the start to the last write or to the interruption, ms */
  measuredMs: number;
  /** viewport writes made */
  writes: number;
  running: boolean;
  interrupted: boolean;
  /** wheel, pointer, key, arm (another arming), disarm, foreign (something else moved the board) or gone (the node is no more) */
  interruptedBy?: string;
  /** purpose arm, not interrupted: the node was armed right after the last write */
  armed: boolean;
}

export interface ArmCounters {
  /** moves of the board the arm rules started */
  transitions: number;
  /** armedzoom=disarm, a zoom seen coming (wheel, pinch, the toolbar): the node was a preview BEFORE the first zoom tick */
  disarmsBeforeZoom: number;
  /** armedzoom=disarm, a zoom not seen coming (a script's setViewport): the node was disarmed inside the first tick */
  disarmsAtTick: number;
  /** zooms the board refused: armedzoom=lock, or a press held in the armed editor under disarm */
  zoomsRefused: number;
  /** of zoomsRefused: zooms that were not seen coming and were undone inside their first tick */
  zoomsUndone: number;
  /** zoom ticks that passed while a node stayed armed: every tick under free, none under disarm and lock */
  armedZoomTicks: number;
  /** a disarm that had to be synchronous and was not through in the DOM when the zoom went on: 0 */
  lateDisarms: number;
}

export interface ArmState {
  /** the node that is armed, as the board's runtime has it */
  armed: string | null;
  /** a transition of the arm rules runs */
  moving: boolean;
  /** the node the running transition will arm */
  target: string | null;
  /** `&arm=<nodeId>` has not been through the rule yet */
  urlPending: boolean;
}

/** DOM-only view of ONE mounted editor, in the coordinates of the document it lives in */
export interface EditorProbe {
  /** client rect of the engine host */
  hostBox(): Box;
  /** clientWidth / clientHeight of the engine host (layout px) */
  hostSize(): { width: number; height: number };
  /** hostBox().width / offsetWidth: 1 means diagram-js's pointer math is exact */
  netScale(): number;
  /** every `data-element-id` that has a `.djs-visual` */
  elementIds(): string[];
  /** client rect of the element's `.djs-visual`, null when absent */
  elementBox(id: string): Box | null;
  /** the CTM of `g.viewport` (a = scale, e/f = translation), null without a diagram-js canvas */
  viewportMatrix(): { a: number; d: number; e: number; f: number } | null;
  /** client rects of what matches inside the host and inside the body-level popup host it owns */
  query(selector: string): Box[];
  /** the text of THIS editor's replica */
  text(): string;
}

/** what a board counts about itself, for a script that measures it */
export interface BoardCounters {
  nodeChanges: number;
  edgeChanges: number;
  viewportChanges: number;
  /** engine mounts per node id: 1 unless something remounted it */
  mounts: Record<string, number>;
  /** what the arm rules did */
  arm: ArmCounters;
}

/**
 * How whoever mounts a board sets it up. A rule that is null takes the default of each node's
 * strategy (arm-rules.ts: overlay is exact1, disarm, stay).
 */
export interface BoardOptions {
  /** of every model node that has none of its own */
  strategy: Strategy;
  /** the first view; null: the board is fitted into its box */
  viewport: Viewport | null;
  /** the node armed on load, through the arm rule of its strategy */
  arm: string | null;
  armzoom: ArmZoom | null;
  armedzoom: ArmedZoom | null;
  armreturn: ArmReturn | null;
  /** how long the board takes to move, in ms; null: the design token, and 0 under prefers-reduced-motion */
  armmotion: number | null;
}
