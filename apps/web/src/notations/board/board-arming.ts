/**
 * The arm rules at work (arm-rules.ts decides, this module moves the board and guards the zoom).
 * Board behaviour, the same for every strategy: nothing here knows how an editor is embedded.
 *
 * ARMING (armzoom). `arm(nodeId)` computes the viewport the node is armed at. When the board
 * stands there already, the node is armed at once, as before the rules. Otherwise the board moves
 * FIRST, while the node is still a preview (scaled by the board's CSS transform, exact and cheap),
 * and the node is armed in the same task as the last viewport write: an armed editor never exists
 * at a board zoom other than the one it ends at. A node that is armed when another one is asked
 * for becomes a preview before the first write.
 *
 * THE MOVE is this module's own loop: one `panZoom.setViewport()` per animation frame, eased by
 * the design tokens. Not React Flow's animated setViewport: measured on 12.12.1, its promise
 * resolves at the end of an undisturbed transition and NEVER settles once a wheel, a pan drag or
 * another viewport call interrupts it, and onMoveEnd comes once for two overlapping moves. The
 * loop knows what it wrote last, so anything else that moves the board shows in the next frame.
 *
 * WHILE THE BOARD MOVES no node is armed. What ends the move early, leaving the board where it
 * stands and nothing armed: a wheel over the board (it zooms from there), a press anywhere on the
 * board (it goes on as the pan, drag or click it is), Escape, arming another node (which starts
 * its own move from there), a disarm, and anything else that moves the viewport. Any other key
 * does nothing: it reaches neither the board nor an editor. A second request for the same node
 * joins the running move. After the last write the target is computed again (the window may have
 * been resized): when the node is not in place, one more move follows, three at most.
 *
 * THE ANCHOR'S KIND TRAVELS WITH THE ARMING. A request with a pointer (`ArmBy.point`, the
 * double-click) is anchored at the pointer, any other (Edit, the keyboard, the hook, the URL) at
 * the node's centre. The kind decides where a node that is longer than the board's box ends up
 * (arm-rules.ts: the pointer keeps the double-clicked point, the centre puts the node's start at
 * the margin), and it is fixed when the arming begins: the look after the last write has no
 * pointer to anchor at and needs none (the zoom is the rule's by then), but it is taken with the
 * kind of the request, so it starts no second move for a node the pointer placed and still
 * repairs a resize. A request that joins a running move takes that move's kind. Every move of
 * an arming carries the kind in its record (`anchor`).
 *
 * AN ARMED NODE AND THE BOARD ZOOM (armedzoom). A pan never matters. A zoom the board can see
 * coming is asked about BEFORE its first tick: a wheel or pinch on the board (a capture listener
 * on the board's element, ahead of d3-zoom's own on `.react-flow__renderer`) and the toolbar's
 * four buttons (`beforeZoom`). React Flow binds no key that zooms. A zoom it cannot see coming (a
 * script's setViewport) is met inside its first tick, in a listener on React Flow's store that
 * was subscribed before any surface's.
 *   free    nothing is done (the board as it was before the rules).
 *   disarm  the node is disarmed first, synchronously (flushSync), so the surface's own disarm has
 *           run when the zoom goes on: an open label editor is completed by `engine.release()`,
 *           which calls the same `directEditing.complete()` its focusout handler calls on a pane
 *           click, a popup closes, the host is a preview. While a press that began in the armed
 *           editor is held, the zoom is refused instead and the node stays armed.
 *   lock    the zoom is refused: the wheel event is stopped, a zoom not seen coming is undone
 *           inside its tick.
 * A wheel inside the armed editor, its popups or the overlay layer never comes by here: d3-zoom
 * does not get it either (`nowheel`, or outside the renderer).
 *
 * GOING BACK (armreturn=back). Done, a pane click and the hook's arm(null) bring the board back to
 * where it stood before the arming moved it: the node is a preview first, then the board moves.
 */
import type { ReactFlowState } from "@xyflow/react";
import { flushSync } from "react-dom";

import {
  ARM_MARGIN,
  ARM_ZOOM_TOLERANCE,
  armViewport,
  parseDuration,
  parseEase,
  type Point,
  resolveRules,
  sameViewport,
  viewportBetween,
  wheelChangesZoom,
} from "./arm-rules.ts";
import { screenRect } from "./geometry.ts";
import type { BoardOptions } from "./types.ts";
import type { ArmAnchor, ArmCounters, ArmPolicy, ArmState, ArmTransition, Strategy, Viewport } from "./types.ts";

/** how long a move takes and how it eases: the design system's tokens, read off the page */
const MOTION_TOKEN = "--cd-motion-base";
const EASE_TOKEN = "--cd-ease";
/** transitions kept for hooks.transitions() */
const KEPT = 200;
/** moves in a row for one arming: the first, and two more looks at a box that changed under it */
const MOVES_AT_MOST = 3;

/**
 * Where the armed editor takes input, whatever the strategy: the armed node's body, the overlay
 * layer (it holds armed hosts only) and the body-level popup host of `counter`. A press inside an
 * embed frame never reaches this document, so `iframe` has no held press here.
 */
export const ARMED_EDITOR =
  '.board-node[data-armed="true"] > .board-node__body, .board-overlay-layer, .board-popup-host';
export const inArmedEditor = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(ARMED_EDITOR) !== null;

/** what asked: an arming (pointer, button, hook, url) or a disarm (done, pane, hook, other) */
export interface ArmBy {
  source: "pointer" | "button" | "hook" | "url" | "done" | "pane" | "other";
  /**
   * A pointer gesture armed the node: where, in client px. The zoom changes about that point, and
   * a node longer than the board's box keeps it under the pointer. Without it the anchor is the
   * node's centre, and such a node starts at the margin
   */
  point?: Point;
}

/** what the arm rules need of React Flow's store */
export interface FlowStore {
  getState(): ReactFlowState;
  subscribe(listener: (state: ReactFlowState, previous: ReactFlowState) => void): () => void;
}

/** what the arm rules need of the board's runtime */
export interface ArmingHost {
  readonly params: BoardOptions;
  strategyOf(nodeId: string): Strategy;
  isModel(nodeId: string): boolean;
  armedId(): string | null;
  /** the armed node as such, no rule: listeners run, React follows */
  setArmedId(nodeId: string | null): void;
  /** the surface's first import is through (true or false), undefined before */
  mounted(nodeId: string): boolean | undefined;
  readonly counters: { arm: ArmCounters };
  /** whose a key is while the board moves (BoardParts.inputScope) */
  readonly inputScope: "board" | "page";
}

export interface BoardArming {
  policy(nodeId: string): ArmPolicy;
  /** arms a model node, or none, through its rules; resolves when the board rests again (armed, or interrupted) */
  arm(nodeId: string | null, by?: ArmBy): Promise<void>;
  /**
   * The board's own controls are about to zoom (`changes`: the zoom will differ). True: go on, and
   * under `disarm` the armed node is a preview by now. False: refused (`lock`, a held press).
   */
  beforeZoom(changes: boolean): boolean;
  state(): ArmState;
  lastTransition(): ArmTransition | null;
  transitions(): ArmTransition[];
  whenRest(): Promise<void>;
  /** the viewport watch and the URL's arm; once, from the provider. Returns the undo */
  watch(): () => void;
  /** wheel, press and key listeners for the board's own element. Returns the undo */
  attach(container: HTMLElement): () => void;
}

interface Move {
  record: ArmTransition;
  started: number;
  /** what this move wrote last: the board standing anywhere else is someone else's doing */
  last: Viewport;
  frame: number;
  end(interrupted: boolean, record: ArmTransition): void;
}

export function createBoardArming(host: ArmingHost, flowStore: FlowStore): BoardArming {
  const { params } = host;
  const counters = host.counters.arm;
  const given = { armzoom: params.armzoom, armedzoom: params.armedzoom, armreturn: params.armreturn };
  const rulesOf = (nodeId: string) => resolveRules(host.strategyOf(nodeId), given);

  const token = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name);
  const motion = (): Pick<ArmPolicy, "motion" | "motionFrom"> => {
    if (params.armmotion !== null) return { motion: params.armmotion, motionFrom: "url" };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return { motion: 0, motionFrom: "reduced-motion" };
    // a page without the token moves at once: no duration of this module's own
    return { motion: parseDuration(token(MOTION_TOKEN)) ?? 0, motionFrom: "token" };
  };

  const viewport = (): Viewport => {
    const [x, y, zoom] = flowStore.getState().transform;
    return { x, y, zoom };
  };
  /** this module is writing the viewport: not a zoom to guard against */
  let writing = false;
  /** at once: React Flow applies a viewport without a duration inside the call */
  const write = (to: Viewport): void => {
    writing = true;
    try {
      void flowStore.getState().panZoom?.setViewport(to);
    } finally {
      writing = false;
    }
  };

  /**
   * The viewport `nodeId` is armed at, null while the board or the node is not measured. True
   * screen geometry (native-geometry.ts): the board's viewport is in real px, also while the
   * `shim` strategy gives another node's editor a virtual space. `anchorKind` is the arming's,
   * also in a look that has no pointer any more (`point` undefined).
   */
  const placement = (nodeId: string, point: Point | undefined, anchorKind: ArmAnchor): Viewport | null => {
    const state = flowStore.getState();
    const node = state.nodeLookup.get(nodeId);
    const width = node?.measured.width ?? node?.width ?? 0;
    const height = node?.measured.height ?? node?.height ?? 0;
    if (!node || !state.panZoom || !state.domNode || !(width > 0) || !(height > 0) || !(state.width > 0)) return null;
    const now = viewport();
    const frame = screenRect(state.domNode);
    // clear of the toolbar: the box a node may use begins under the toolbar's band. The band is the
    // same before and after the arming: the toolbar's Done control keeps one box in both states
    const toolbar = state.domNode.querySelector(".board-toolbar");
    const band = toolbar ? Math.max(0, screenRect(toolbar).bottom - frame.top) : 0;
    const { x, y } = node.internals.positionAbsolute;
    return armViewport({
      viewport: now,
      node: { x, y, width, height },
      box: { x: 0, y: band, width: state.width, height: state.height - band },
      anchor: point
        ? { x: point.x - frame.left, y: point.y - frame.top }
        : { x: now.x + (x + width / 2) * now.zoom, y: now.y + (y + height / 2) * now.zoom },
      anchorKind,
      rule: rulesOf(nodeId).armzoom,
    });
  };

  // ── the move ──

  let move: Move | null = null;
  let serial = 0;
  const records: ArmTransition[] = [];

  /** ends the running move where the board stands; `interruptedBy` when it did not reach its target */
  const finish = (interruptedBy?: string): void => {
    const current = move;
    if (!current) return;
    move = null;
    cancelAnimationFrame(current.frame);
    const { record } = current;
    record.running = false;
    record.interrupted = interruptedBy !== undefined;
    if (interruptedBy !== undefined) record.interruptedBy = interruptedBy;
    record.end = viewport();
    record.measuredMs = performance.now() - current.started;
    current.end(record.interrupted, record);
  };

  const run = (
    purpose: ArmTransition["purpose"],
    nodeId: string,
    by: string,
    to: Viewport,
    end: Move["end"],
    anchor?: ArmAnchor,
  ): void => {
    const from = viewport();
    const askedMs = motion().motion;
    const record: ArmTransition = {
      id: ++serial,
      purpose,
      nodeId,
      by,
      ...(anchor ? { anchor } : {}),
      from,
      to,
      end: from,
      askedMs,
      measuredMs: 0,
      writes: 0,
      running: true,
      interrupted: false,
      armed: false,
    };
    records.push(record);
    if (records.length > KEPT) records.shift();
    counters.transitions++;
    const ease = parseEase(token(EASE_TOKEN));
    const current: Move = { record, started: performance.now(), last: from, frame: 0, end };
    move = current;
    const step = (): void => {
      if (move !== current) return;
      if (!sameViewport(viewport(), current.last)) {
        finish("foreign");
        return;
      }
      const t = askedMs > 0 ? (performance.now() - current.started) / askedMs : 1;
      write(t >= 1 ? to : viewportBetween(from, to, ease(t)));
      record.writes++;
      current.last = viewport();
      if (t >= 1) finish();
      else current.frame = requestAnimationFrame(step);
    };
    // 0 ms: one write, inside this call
    if (askedMs > 0) current.frame = requestAnimationFrame(step);
    else step();
  };

  // ── arming and disarming ──

  /** armreturn=back: where the board stood before the arming of `nodeId` moved it */
  let home: { nodeId: string; viewport: Viewport } | null = null;
  /** the arming a running move belongs to: a second request for the same node joins it */
  let arming: { nodeId: string; settled: Promise<void> } | null = null;
  /** `&arm=<nodeId>` under a rule that may move the board: armed once the board and the node are measured */
  let urlPending = params.arm !== null && host.isModel(params.arm) && host.armedId() !== params.arm;

  /** what the page shows of an armed node: its frame's flag, or a host that is still in the overlay layer */
  const STILL_ARMED = '.board-node[data-armed="true"], .board-overlay-layer > .board-engine';
  /** a preview when this returns: React commits inside the call, and with it the surface's own disarm */
  const disarmNow = (): void => {
    flushSync(() => host.setArmedId(null));
    // the check behind counters().arm.lateDisarms: it stays 0 while the commit is synchronous
    if (document.querySelector(STILL_ARMED) !== null) counters.lateDisarms++;
  };

  const armNode = (nodeId: string, by: ArmBy): Promise<void> => {
    if (move?.record.purpose === "arm" && arming?.nodeId === nodeId) return arming.settled;
    if (move) finish("arm");
    if (host.armedId() === nodeId) return Promise.resolve();
    // fixed here for the whole arming: every look at the target is taken with it
    const anchorKind: ArmAnchor = by.point ? "pointer" : "centre";
    const target = rulesOf(nodeId).armzoom === "off" ? null : placement(nodeId, by.point, anchorKind);
    if (target === null || sameViewport(target, viewport())) {
      // nothing to move: armed at once, as before the rules
      home = null;
      host.setArmedId(nodeId);
      return Promise.resolve();
    }
    // the node that is armed becomes a preview before the first write, as a pane click makes it one
    if (host.armedId() !== null) disarmNow();
    home = { nodeId, viewport: viewport() };
    const settled = new Promise<void>((resolve) => {
      const go = (to: Viewport, moves: number): void => {
        const arrived = (interrupted: boolean, record: ArmTransition): void => {
          if (interrupted) {
            home = null;
            resolve();
            return;
          }
          // The box may have changed under the move (a window resize), or the node may be gone.
          // No pointer in this look: the zoom is the rule's already, so no anchor is needed, and
          // the arming's own kind keeps a node the pointer placed where the pointer put it
          const again = host.isModel(nodeId) ? placement(nodeId, undefined, anchorKind) : null;
          if (again === null) {
            record.interrupted = true;
            record.interruptedBy = "gone";
            home = null;
            resolve();
            return;
          }
          if (!sameViewport(again, viewport()) && moves < MOVES_AT_MOST) {
            go(again, moves + 1);
            return;
          }
          // in the same task as the last write: the editor mounts its armed layout at this viewport
          flushSync(() => host.setArmedId(nodeId));
          record.armed = true;
          resolve();
        };
        run("arm", nodeId, by.source, to, arrived, anchorKind);
      };
      go(target, 1);
    });
    arming = { nodeId, settled };
    return settled;
  };

  const disarm = (by: ArmBy): Promise<void> => {
    if (move) finish("disarm");
    const armedId = host.armedId();
    if (armedId === null) return Promise.resolve();
    const back =
      rulesOf(armedId).armreturn === "back" &&
      (by.source === "done" || by.source === "pane" || by.source === "hook") &&
      home?.nodeId === armedId
        ? home.viewport
        : null;
    home = null;
    if (back === null || sameViewport(back, viewport())) {
      host.setArmedId(null);
      return Promise.resolve();
    }
    // a preview first, then the board moves: no editor sees a zoom step
    disarmNow();
    return new Promise((resolve) => run("return", armedId, by.source, back, () => resolve()));
  };

  // ── the zoom under an armed node ──

  /** a button is down on a press that began in the armed editor */
  let pressHeld = false;

  /** the zoom is about to change by a gesture the board sees coming: true when it may */
  const zoomComes = (): boolean => {
    const armedId = host.armedId();
    if (armedId === null) return true;
    const { armedzoom } = rulesOf(armedId);
    if (armedzoom === "free") return true;
    if (armedzoom === "lock" || pressHeld) {
      counters.zoomsRefused++;
      return false;
    }
    disarmNow();
    // a disarm by a zoom never goes back
    home = null;
    counters.disarmsBeforeZoom++;
    return true;
  };

  const onWheel = (event: WheelEvent): void => {
    const { target } = event;
    // d3-zoom listens on the renderer and passes over what lies in a `nowheel` element: no other wheel is the board's
    if (!(target instanceof Element) || !target.closest(".react-flow__renderer") || target.closest(".nowheel")) return;
    if (move) {
      // the person's: the board zooms from where it stands, nothing is armed
      finish("wheel");
      return;
    }
    const { transform, minZoom, maxZoom } = flowStore.getState();
    if (!wheelChangesZoom(transform[2], event.deltaY, minZoom, maxZoom)) return;
    if (zoomComes()) return;
    // refused: not to d3-zoom, and no page zoom for a pinch
    event.preventDefault();
    event.stopPropagation();
  };

  const onBoardPress = (): void => {
    // a press on the board while it moves: the person takes over, the press goes on as what it is
    if (move) finish("pointer");
  };

  const onPress = (event: PointerEvent): void => {
    pressHeld = host.armedId() !== null && inArmedEditor(event.target);
  };
  const onRelease = (): void => {
    pressHeld = false;
  };

  const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);
  /** the board's own element, while the guards are attached */
  let boardElement: HTMLElement | null = null;
  const onKey = (event: KeyboardEvent): void => {
    if (!move || MODIFIERS.has(event.key)) return;
    const { target } = event;
    // scope "board": a key aimed at a control beside the board is the page's, also while the board moves
    if (host.inputScope === "board" && !(target instanceof Node && boardElement?.contains(target))) return;
    // a text field elsewhere on the page keeps its keys
    if (target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select")))
      return;
    if (event.key === "Escape") finish("key");
    // a board that moves takes no key: not the delete key for the node the double-click selected, either
    event.stopPropagation();
  };

  return {
    policy(nodeId) {
      const rules = rulesOf(nodeId);
      const fromUrl = (["armzoom", "armedzoom", "armreturn"] as const).filter((name) => given[name] !== null);
      return { ...rules, fromUrl, ...motion(), margin: ARM_MARGIN, tolerance: ARM_ZOOM_TOLERANCE };
    },

    arm(nodeId, by = { source: "other" }) {
      if (nodeId === null) return disarm(by);
      return host.isModel(nodeId) ? armNode(nodeId, by) : Promise.resolve();
    },

    beforeZoom(changes) {
      if (move) finish("zoom");
      return changes ? zoomComes() : true;
    },

    state: () => ({
      armed: host.armedId(),
      moving: move !== null,
      target: move?.record.purpose === "arm" ? move.record.nodeId : null,
      urlPending,
    }),
    lastTransition: () => {
      const last = records[records.length - 1];
      return last ? { ...last } : null;
    },
    transitions: () => records.map((record) => ({ ...record })),
    whenRest: () =>
      new Promise((resolve) => {
        const look = (): void => void requestAnimationFrame(move || urlPending ? look : () => resolve());
        look();
      }),

    watch() {
      let undoing = false;
      /** the board has its first viewport: the one of the URL, or the first fit */
      let stands = false;
      const off = flowStore.subscribe((state, previous) => {
        if (!stands) {
          // finding that first viewport is the board loading, not a zoom under an armed node (`&arm=` with armzoom=off)
          stands = previous.panZoom !== null && !previous.fitViewQueued;
          if (!stands) return;
        }
        if (state.transform === previous.transform || writing || undoing) return;
        const before = previous.transform[2];
        // a pan never disarms
        if (state.transform[2] === before) return;
        const armedId = host.armedId();
        if (armedId === null) return;
        const { armedzoom } = rulesOf(armedId);
        if (armedzoom === "free") {
          counters.armedZoomTicks++;
          return;
        }
        if (state.fitViewQueued) {
          // React Flow runs a fit inside a layout effect, where React cannot flush: disarmed, but
          // only with React's next commit. The board's own Fit button never comes by here: it asks
          // first (beforeZoom). Counted as late, so a fit by any other caller shows
          host.setArmedId(null);
          home = null;
          counters.disarmsAtTick++;
          counters.lateDisarms++;
          return;
        }
        if (armedzoom === "lock" || pressHeld) {
          // not seen coming, so undone: inside this tick, before a surface hears of it
          undoing = true;
          try {
            void state.panZoom?.setViewport({ x: previous.transform[0], y: previous.transform[1], zoom: before });
          } finally {
            undoing = false;
          }
          counters.zoomsRefused++;
          counters.zoomsUndone++;
          return;
        }
        disarmNow();
        home = null;
        counters.disarmsAtTick++;
      });

      // `&arm=`: through the rule, once the first fit is through and the node's editor is up
      let frame = 0;
      const tryUrl = (): void => {
        const nodeId = params.arm;
        if (!urlPending || nodeId === null) return;
        const state = flowStore.getState();
        const measured = state.nodeLookup.get(nodeId)?.measured.width !== undefined;
        if (!state.panZoom || state.fitViewQueued || !measured || host.mounted(nodeId) === undefined) {
          frame = requestAnimationFrame(tryUrl);
          return;
        }
        void armNode(nodeId, { source: "url" }).finally(() => void (urlPending = false));
      };
      if (urlPending) frame = requestAnimationFrame(tryUrl);

      return () => {
        off();
        cancelAnimationFrame(frame);
      };
    },

    attach(container) {
      const capture = { capture: true } as const;
      boardElement = container;
      // not passive: a refused wheel is prevented. Capture on the board's element: before d3-zoom's listener on the renderer
      container.addEventListener("wheel", onWheel, { capture: true, passive: false });
      container.addEventListener("pointerdown", onBoardPress, capture);
      window.addEventListener("pointerdown", onPress, capture);
      window.addEventListener("pointerup", onRelease, capture);
      window.addEventListener("pointercancel", onRelease, capture);
      // a press whose release went to another window
      window.addEventListener("blur", onRelease);
      window.addEventListener("keydown", onKey, capture);
      return () => {
        container.removeEventListener("wheel", onWheel, capture);
        container.removeEventListener("pointerdown", onBoardPress, capture);
        window.removeEventListener("pointerdown", onPress, capture);
        window.removeEventListener("pointerup", onRelease, capture);
        window.removeEventListener("pointercancel", onRelease, capture);
        window.removeEventListener("blur", onRelease);
        window.removeEventListener("keydown", onKey, capture);
        boardElement = null;
      };
    },
  };
}
