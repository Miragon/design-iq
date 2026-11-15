/**
 * The measuring bench's contract: what a page hands a script that drives it, and what the board
 * page and an embed frame say to each other. Node-loadable (type stripping): no DOM at module
 * level and one import, the board's own types, so a script under test/spike imports it as it is.
 */
import {
  type ArmPolicy,
  type ArmState,
  type ArmTransition,
  type BoardCounters,
  type Box,
  type EditorProbe,
  MODEL_NOTATIONS,
  type ModelNotation,
  type Strategy,
  type Viewport,
} from "../notations/board/types.ts";

// what the board itself is made of lives with the board; a script imports it from here as before
export * from "../notations/board/types.ts";

/** the bench's name of the probe */
export type SpikeProbe = EditorProbe;

/**
 * What an `overlay` node mounts (`&mount=`): "spike" is the spike's own reduced mount (engines/),
 * "product" the SPA's mount functions as they are (strategies/overlay-product.tsx). Every other
 * strategy ignores it.
 */
export const MOUNTS = ["spike", "product"] as const;
export type Mount = (typeof MOUNTS)[number];

/** one animation frame of the board page, as `startFrames` records it */
export interface FrameSample {
  /** performance.now() of the page */
  t: number;
  x: number;
  y: number;
  zoom: number;
  /** the armed node as the runtime has it */
  armed: string | null;
  /** the node whose frame shows as armed in the DOM */
  shown: string | null;
  /** a transition of the arm rules runs */
  moving: boolean;
  /** in-page strategies: the zoom the armed editor's view is applied with (overlay, counter: the board zoom it was placed at) */
  editorZoom: number | null;
  /** in-page strategies: `data-layout` of the armed editor's host (overlay, counter, preview) */
  layout: string | null;
}

/** `<meta name="designiq-spike" content="board">` / `content="embed"`: a 200 alone proves nothing */
export const PAGE_MARK = "designiq-spike";
export const HOOKS_KEY = "__boardSpike";
export const EMBED_KEY = "__boardSpikeEmbed";
export const NATIVE_KEY = "__boardSpikeNative";

/**
 * window[NATIVE_KEY] of the board page and of every embed frame: the browser's own geometry
 * functions, captured before any strategy code ran (native-geometry.ts). A strategy may patch these
 * functions on their prototypes (`shim` does, while a node is armed). Whatever MEASURES reads
 * through this object and so stays in true screen geometry.
 */
export interface NativeGeometry {
  /** getBoundingClientRect of an element or of a range */
  rect(target: Element | Range): DOMRect;
  /** getClientRects of an element or of a range */
  clientRects(target: Element | Range): DOMRectList;
  elementFromPoint(root: Document, x: number, y: number): Element | null;
  /** topmost first */
  elementsFromPoint(root: Document, x: number, y: number): Element[];
  /** getScreenCTM of an SVG graphics element */
  screenCTM(element: SVGGraphicsElement): DOMMatrix | null;
  /** the text position at a client point (caretPositionFromPoint, else caretRangeFromPoint) */
  caretFromPoint(root: Document, x: number, y: number): { node: Node; offset: number } | null;
  /** clientX / clientY of a mouse event, from the getters of MouseEvent.prototype */
  clientPoint(event: MouseEvent): { x: number; y: number };
}

export interface SpikeNodeInfo {
  id: string;
  type: "model" | "text" | "image" | "group";
  notation?: ModelNotation;
  file?: string;
  strategy?: Strategy;
  armed: boolean;
  /** the model node's editor finished its first import */
  mounted: boolean;
  /** iframe strategy: the `name` of its frame (Playwright: page.frame({ name })) */
  frameName?: string;
}

export interface BoardSpikeHooks {
  /** every model node of the board finished its first import (or failed: see log()), and `&arm=` is through the arm rule */
  ready: boolean;
  nodes(): SpikeNodeInfo[];
  viewport(): Viewport;
  /**
   * Set at once, no animation; resolves after the surfaces caught up (two animation frames). The
   * board does not see it coming: under armedzoom=disarm a change of the zoom disarms the armed
   * node inside the first tick, under lock it is undone there. A pan changes nothing.
   */
  setViewport(viewport: Viewport): Promise<void>;
  /**
   * Arm one node or none, through the arm rules of that node: the board may move first (armzoom;
   * an `overlay` node goes to board zoom exactly 1 by default, from below and from above), and
   * disarming may bring it back (armreturn; the hook counts as the Done button). The hook has no
   * pointer: its anchor is the node's centre, and a node longer than the board's box starts at
   * the margin. Resolves once the transition is over and the surface takes input. After an
   * interrupted transition no node is armed: read `armState()`.
   */
  arm(nodeId: string | null): Promise<void>;
  /** the arm rules in effect for a model node, null for any other id */
  armPolicy(nodeId: string): ArmPolicy | null;
  armState(): ArmState;
  /** the last move of the board the arm rules made (running or over), null before the first */
  lastTransition(): ArmTransition | null;
  /** all of them, oldest first (the last 200) */
  transitions(): ArmTransition[];
  /** resolves once no transition runs and `&arm=` is through, one animation frame later */
  whenRest(): Promise<void>;
  /** records the board zoom together with what is armed, once per animation frame, until stopFrames (at most 20 000 frames) */
  startFrames(): void;
  /** ends the recording and returns it, oldest first */
  stopFrames(): FrameSample[];
  /** client rect of the node's React Flow wrapper */
  nodeBox(nodeId: string): Box | null;
  /** in-page strategies; null for `iframe` (use window[EMBED_KEY] of the frame) */
  probe(nodeId: string): SpikeProbe | null;
  /** in-page strategies: the spike's engine handle, raw (diagram-js access for deeper checks) */
  engine(nodeId: string): unknown;
  /** the hub's server copy: "the file" */
  fileText(path: string): string | undefined;
  files(): Array<{ path: string; kind: "model" | "board" | "asset"; bytes: number; version: number }>;
  boardText(): string;
  counters(): BoardCounters;
  /** page errors, sync errors and conflict notices, oldest first */
  log(): string[];
}

/** window[EMBED_KEY] inside an embed frame */
export interface EmbedHooks {
  ready: boolean;
  armed: boolean;
  notation: ModelNotation;
  file: string;
  probe: SpikeProbe;
  /** what the product's mount function returned */
  editor: unknown;
  log(): string[];
}

// ── board page <-> embed frame (postMessage, same origin) ────────────────────
// The frame keeps a replica of ONE file in its own document. model-hub.ts implements both ends:
// ModelHub.attachFrame() in the board page, connectToHub() in the frame.
//
//   frame                         board page
//   hello            ──────────▶                      repeated until "state" came: either side may load first
//                    ◀──────────  state               the file's whole Yjs state, and whether the frame is armed
//   update           ◀─────────▶  update              one Yjs update per transaction, never back to its sender
//   ready            ──────────▶                      the editor finished its first import (or failed: `error`)
//                    ◀──────────  arm
//   armed            ──────────▶                      the frame takes input (or stopped): the answer to state and arm
//   log              ──────────▶                      a line for BoardSpikeHooks.log()

/** both ends drop a message of another version */
export const FRAME_PROTOCOL = 1;
/** tells the spike's messages from whatever else is posted to a window */
export const FRAME_CHANNEL = "designiq-spike-frame";

export interface FrameEnvelope {
  channel: typeof FRAME_CHANNEL;
  v: typeof FRAME_PROTOCOL;
  /** the frame's `name` (SpikeNodeInfo.frameName): one board page talks to many frames */
  frame: string;
}

/** what the embed frame posts to the board page (`window.parent`) */
export type FrameToHubBody =
  | { type: "hello" }
  | { type: "update"; update: Uint8Array }
  | { type: "ready"; error?: string }
  | { type: "armed"; armed: boolean }
  | { type: "log"; line: string };
/** what the board page posts to an embed frame (`iframe.contentWindow`) */
export type HubToFrameBody =
  | { type: "state"; file: string; update: Uint8Array; armed: boolean }
  | { type: "update"; update: Uint8Array }
  | { type: "arm"; armed: boolean };

export type FrameToHubMessage = FrameEnvelope & FrameToHubBody;
export type HubToFrameMessage = FrameEnvelope & HubToFrameBody;

/** a message of this protocol and version for the frame `frame`; the direction is the caller's to know */
export function isFrameMessage(data: unknown, frame: string): data is FrameToHubMessage | HubToFrameMessage {
  if (typeof data !== "object" || data === null) return false;
  const envelope = data as Partial<FrameEnvelope>;
  return envelope.channel === FRAME_CHANNEL && envelope.v === FRAME_PROTOCOL && envelope.frame === frame;
}

/** the embed page's URL parameters: which frame it is and which file it shows */
export interface EmbedParams {
  frame: string;
  file: string;
  notation: ModelNotation;
}
export const EMBED_PAGE = "board-spike-embed.html";

export function embedUrl({ frame, file, notation }: EmbedParams): string {
  return `/${EMBED_PAGE}?${new URLSearchParams({ frame, file, notation }).toString()}`;
}

/** null unless all three are there and the notation is one of MODEL_NOTATIONS */
export function readEmbedParams(search: string): EmbedParams | null {
  const params = new URLSearchParams(search);
  const frame = params.get("frame");
  const file = params.get("file");
  const notation = MODEL_NOTATIONS.find((id) => id === params.get("notation"));
  return frame && file && notation ? { frame, file, notation } : null;
}
