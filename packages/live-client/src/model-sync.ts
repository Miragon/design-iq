/**
 * Y.Text ↔ visual-modeler sync engine — the four sync rules from
 * docs/platform-concept.md, notation-agnostic:
 *
 *  1. one pinned modeler version across all clients (package.json)
 *  2. minimal diffs into Y.Text, never replace-all (common prefix/suffix trim,
 *     the line breaks that close the text apart); a canvas edit made while a
 *     peer's change arrived merges with it where the two edited different
 *     places of the text (placed by context, else by lines, #309), and gives
 *     way where they edited the same place or the merge fails the gate (rule 4)
 *  3. debounced re-import of remote changes with view-state restore and echo
 *     suppression (Yjs transaction origin + last-export equality), one import
 *     at a time, held back while a local gesture runs on the canvas, for 10 s
 *     at most (#295)
 *  4. gate the merged text before import; keep rendering the last good state on
 *     rare invalid interleavings — the next update usually heals the document.
 *     Canvas exports that cross on the wire and replace the same text never
 *     heal: each canvas keeps its own state. The writer every peer ranks first
 *     writes its canvas over the merge (repairs below, #274); a writer whose
 *     updates lag behind the settle delay can repair the same merge too, and
 *     the next round settles the two repairs. A writer whose presence is
 *     gone is passed over, and a canvas whose text stays unrenderable says
 *     so (#296): nothing else heals such a text
 *
 * What differs per notation (how change events are observed, how the view
 * state survives a re-import, what "renderable" means pre-import) lives in a
 * SyncAdapter; bpmn-sync, dmn-sync and miragon-sync (ONE adapter for every
 * modeler behind the @miragon/modeler-api contract) are the adapters.
 * Consumers import those, never this module.
 */
import { CANVAS_LOSSES_KEY, CANVAS_WRITES_KEY } from "@designiq/contracts/live";
import * as Y from "yjs";

import { applyHunks, closingBreaksAt, diffHunks, diffRegion, type Hunk, mergeLines, patchText } from "./text-diff.ts";

/** Shared origin marker: transactions tagged with it are our own canvas edits. */
export const CANVAS_ORIGIN = "bpm-canvas";

/** the two changed the same place in the text, or their merge fails the notation's gate (looksRenderable): a text a peer typed or saved into gets no repair */
const CONFLICT_MESSAGE =
  "Your last action crossed a colleague's change and could not be merged with it. The model now shows their change.";
/** a repair can undo more than the last action: every canvas edit the repairer's canvas had not taken in */
const REPAIRED_MESSAGE =
  "Your recent canvas edits crossed a colleague's at the same moment and could not be merged. The model now shows their version.";
const UNRENDERABLE_MESSAGE = "The shared text cannot be rendered. Your canvas shows the last good state.";

/** how long the repairing writer waits for further crossing writes before it writes */
const REPAIR_SETTLE_MS = 500;
/** how long a canvas keeps its own state over a merge of crossing replacements, waiting for the repair */
const OVERLAP_GRACE_MS = 3000;
/** the most other writers a log entry names, the latest ones: it keeps the entry small */
const HELD_WRITERS = 64;
/** longer than a repair takes (about 2 s from the break): a text on its way to a repair shows no notice */
const UNRENDERABLE_NOTICE_MS = 5000;

/** how long a remote re-import waits for a gesture on the canvas to end: a stuck gesture must not hide peers' edits for good */
const GESTURE_HOLD_MS = 10_000;
/** how often a re-import held back for a gesture read from the DOM looks again */
const GESTURE_RECHECK_MS = 100;
/** diagram-js puts it on the root element while a drag runs, also a palette create that follows the pointer with no button held */
const DRAG_ACTIVE_MARKER = "djs-drag-active";
/**
 * what diagram-js draws for the elements a drag carries (a create, a move, a
 * connection). The marker alone is no gesture: a palette tool (hand, space,
 * lasso, global connect) keeps it set from its selection until the next
 * press, and re-arms after each pan or make-space, with nothing to lose to an
 * import
 */
const DRAG_PREVIEW = "djs-dragger";
/** diagram-js's cursor on the page while a create or a move carries elements: a create's preview is gone while the pointer is off the canvas */
const CARRYING_CURSOR = "djs-cursor-grabbing";

/** a canvas write as a log entry names it: its writer's count and its Lamport time */
type Mark = [n: number, time: number];

/**
 * One entry of the canvas write log (CANVAS_WRITES_KEY: writer's Yjs client
 * id → its latest canvas write, set in the write's own transaction). A write
 * takes out of the log every entry its canvas holds, so the log keeps the
 * writes no canvas has built on yet: one after edits that follow each other,
 * two or more after edits that crossed. A write that left the log stays named
 * in the `held` of the writes built on it, so a repair still knows whose edits
 * the text holds.
 */
interface CanvasWrite {
  /** the writer's own count: a held entry and a newer write of the same writer differ */
  n: number;
  /** one more than the writer's previous write and than every write its canvas held */
  time: number;
  /** the other writers' writes the canvas held when it wrote */
  held: Record<string, Mark>;
  /** the writer's Yjs clock before and after the write's transaction: a peer takes exactly that change for this write */
  clock: [number, number];
  /** characters of the text the write deleted */
  deleted: number;
  /** this canvas cannot repair the merge in the text (it has not taken in someone's typing or save): the next writer may */
  standsDown?: true;
}

const isMark = (value: unknown): value is Mark =>
  Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "number");

/** an entry of another shape (another client version, a faulty peer) is no entry: it must not stop this sync */
function isCanvasWrite(value: unknown): value is CanvasWrite {
  const entry = value as Partial<CanvasWrite> | null;
  return (
    typeof entry?.n === "number" &&
    typeof entry.time === "number" &&
    typeof entry.deleted === "number" &&
    isMark(entry.clock) &&
    typeof entry.held === "object" &&
    entry.held !== null &&
    Object.values(entry.held).every(isMark)
  );
}

export interface SyncAdapter {
  /** parse + render the document text (the notation's own format: XML, a
   *  line DSL, JSON); a rejection keeps the last good state (rule 4) */
  importText(text: string): Promise<unknown>;
  /** serialize the current model in that format, deterministically */
  exportText(): Promise<string | undefined>;
  /**
   * rule-4 pre-gate: is this text worth an import attempt at all? The XML
   * notations pass well-formedness (looksWellFormedXml), text-DSL/JSON
   * notations their own cheap check — the parser (importText) stays the real
   * judge, rejections keep the last good state either way. Explicit per
   * adapter: the engine assumes NO file format.
   */
  looksRenderable(text: string): boolean;
  /** what to report when a document that never rendered fails the gate —
   *  defaults to a format-agnostic message */
  unrenderableReason?: string;
  /**
   * snapshot the view state right before an import; returns the restore to
   * run after the import succeeded
   */
  beforeImport(isFirstImport: boolean): () => void;
  /** subscribe to local model-change events; returns the unsubscribe */
  observeModel(onChanged: () => void): () => void;
  /**
   * set by an adapter whose modeler keeps the collaborative-modeler contract
   * (@miragon/modeler-api, miragon-sync): the binding then reads a gesture
   * from the modeler, never from the DOM, and writes each canvas edit into
   * the text before the modeler's change listener returns
   */
  contract?: ContractModeler;
}

/** contract 1.5's interaction surface: whether the user holds a gesture on the canvas */
export interface GestureSurface {
  active(): boolean;
  /** the new value, once each way; it may run inside importText (the cancel of L1) or a pointer handler */
  onChange(listener: (active: boolean) => void): () => void;
}

/** what the binding reads of a modeler behind the collaborative-modeler contract */
export interface ContractModeler {
  /** synchronous: inside a change listener it already returns the changed document (L3) */
  exportText(): string;
  /** absent before contract 1.5: such a modeler holds no re-import back */
  interaction?: GestureSurface | undefined;
}

interface CanvasGesture {
  active(): boolean;
  /** ends the gesture the way the user's Escape does */
  cancel(): void;
  dispose(): void;
}

/**
 * A gesture on the canvas of an editor without the contract's interaction
 * surface (bpmn-js, dmn-js), read from the DOM alone, whatever services the
 * editor registers: a pointer held on the canvas host, or diagram-js's drag
 * marker inside it while the drag carries elements (a palette create follows
 * the pointer with no button held).
 */
function watchCanvasGesture(host: Element): CanvasGesture {
  const page = host.ownerDocument;
  const view = page.defaultView;
  const pressed = new Set<number>();
  const press = (event: Event): void => void pressed.add((event as PointerEvent).pointerId);
  const release = (event: Event): void => void pressed.delete((event as PointerEvent).pointerId);
  // a button released while another window has the focus never reports here
  const releaseAll = (): void => pressed.clear();
  const releases = ["pointerup", "pointercancel", "lostpointercapture"] as const;
  const drags = host.getElementsByClassName(DRAG_ACTIVE_MARKER);
  const previews = host.getElementsByClassName(DRAG_PREVIEW);
  const carrying = (): boolean => previews.length > 0 || page.body?.classList.contains(CARRYING_CURSOR) === true;
  // capture: a renderer that stops a pointer event on its way must not hide it
  host.addEventListener("pointerdown", press, true);
  for (const type of releases) view?.addEventListener(type, release, true);
  view?.addEventListener("blur", releaseAll);
  return {
    active: () => pressed.size > 0 || (drags.length > 0 && carrying()),
    cancel() {
      if (!view) return;
      // diagram-js's dragging cancels on an Escape keyup at the document
      page.dispatchEvent(new view.KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true }));
    },
    dispose() {
      host.removeEventListener("pointerdown", press, true);
      for (const type of releases) view?.removeEventListener(type, release, true);
      view?.removeEventListener("blur", releaseAll);
    },
  };
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

/**
 * The room's presence, as y-protocols' Awareness reports it (a session's
 * `awareness`): a client id leaves in `removed` when its tab closes or its
 * connection is lost, and comes back in `added` or `updated` once its link
 * re-syncs (openLiveSession renews the presence on both sides then).
 */
export interface PeerAwareness {
  on(event: "change", listener: (change: AwarenessChange) => void): void;
  off(event: "change", listener: (change: AwarenessChange) => void): void;
}

/** what a live session and the editor around the canvas add to the binding; without it the binding syncs as before */
export interface SyncOptions {
  /** a writer that left cannot repair a broken merge: with the room's
   *  presence, the next-ranked writer repairs in its place */
  awareness?: PeerAwareness | null;
  /**
   * the shared text failed the gate or the import for longer than a repair
   * takes, while this canvas keeps showing its last good state: the message
   * to show until the callback fires again with null, once a text renders
   */
  onUnrenderable?: (message: string | null) => void;
  /**
   * the element the canvas is mounted in, for an editor without the
   * contract's interaction surface (bpmn-js, dmn-js). While a gesture runs on
   * it (a drag, a resize, a connection, a lasso, a palette create), remote
   * re-imports wait: an import replaces the shapes the gesture works on, and
   * its drop would throw on them and lose the edit. Absent = never held back.
   * A modeler behind the contract reports its gestures itself
   * (SyncAdapter.contract): its binding never reads this element.
   */
  canvasHost?: Element;
}

/** XML well-formedness — the looksRenderable gate of the XML notations (bpmn, dmn) */
export const looksWellFormedXml = (s: string): boolean =>
  s.trim().length > 0 &&
  new DOMParser().parseFromString(s, "application/xml").getElementsByTagName("parsererror").length === 0;
export const NOT_WELL_FORMED_XML = "the document is not well-formed XML";

/**
 * The diagram-js view-state recipe of a single-canvas modeler without a view
 * state of its own (bpmn-js): snapshot the canvas viewbox before an import,
 * restore it after a RE-import, fit the viewport on the first one.
 */
export function keepDiagramViewbox(modeler: { get(service: string): any }): SyncAdapter["beforeImport"] {
  return (isFirstImport) => {
    const canvas = modeler.get("canvas");
    let viewbox: { x: number; y: number; width: number; height: number } | undefined;
    try {
      viewbox = canvas.viewbox();
    } catch {
      /* first import: no viewbox yet */
    }
    return () => {
      if (viewbox && viewbox.width > 0 && !isFirstImport) canvas.viewbox(viewbox);
      else canvas.zoom("fit-viewport");
    };
  };
}

/**
 * A local edit `base` → `next` placed into `current`, which changed since
 * `base` (three texts without their closing line breaks), as hunks against
 * `current`; undefined where the two touch the same lines. The one changed
 * region is located by its context first, wide context first (position
 * safety), shrinking so that a nearby but disjoint remote edit inside the
 * window does not masquerade as overlap; it merges different parts of one
 * line, as in a text that is one line long. A region whose context a remote
 * edit changed merges line by line (#309): bpmn-js writes a moved or new
 * shape's DI last, across the DI a peer just moved, and the Miragon text
 * notations list a new element right after the one a peer may have moved.
 */
function locateLocalEdit(base: string, current: string, next: string): Hunk[] | undefined {
  const { start, endPrev, endNext } = diffRegion(base, next);
  const deleted = base.slice(start, endPrev);
  const inserted = next.slice(start, endNext);
  if (!deleted && !inserted) return [];
  for (const width of [64, 32, 16, 8]) {
    const before = base.slice(Math.max(0, start - width), start);
    const after = base.slice(endPrev, endPrev + width);
    const at = placeOf(before + deleted + after, current, start === 0, endPrev === base.length);
    if (at < 0) continue;
    return [{ at: at + before.length, deleteCount: deleted.length, insert: inserted }];
  }
  return mergeLines(base, current, next);
}

/**
 * Where `needle` stands in `text`, -1 where it is absent or ambiguous. A
 * needle that runs to the start or the end of its own text has no context on
 * that side, so it must stand at that end of `text` too: a peer's suffix to
 * the last line matches it as well, and would end up behind the local edit,
 * on the line a create appends.
 */
function placeOf(needle: string, text: string, atStart: boolean, atEnd: boolean): number {
  if (atStart || atEnd) {
    const at = atStart ? 0 : text.length - needle.length;
    const fits = at >= 0 && text.startsWith(needle, at) && (!atStart || !atEnd || text.length === needle.length);
    return fits ? at : -1;
  }
  const at = text.indexOf(needle);
  return at >= 0 && text.indexOf(needle, at + 1) < 0 ? at : -1;
}

export function bindModelSync(
  adapter: SyncAdapter,
  ytext: Y.Text,
  doc: Y.Doc,
  /** a canvas edit of this peer's is lost: an overlapping remote edit won, or
   *  a peer's repair wrote over it (rule 4) */
  onConflict?: (message: string) => void,
  /**
   * fires when the FIRST import fails or never happens (the document is
   * malformed or empty from the start — there is no last good state to keep
   * rendering), at most once until an import succeeds; later rejections are
   * transient interleavings that the next update usually heals, those stay
   * on the console
   */
  onImportError?: (message: string) => void,
  sync: SyncOptions = {},
): () => void {
  let importing = false;
  /** an import was asked for while one ran: it follows that one, reading the text as it is then */
  let importQueued = false;
  let lastExport = "";
  let lastLocalEdit = 0;
  let pendingLocalExport = false;
  let importErrorReported = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let repairTimer: ReturnType<typeof setTimeout> | undefined;
  let unbound = false;
  const { contract } = adapter;
  const interaction = contract?.interaction;
  const domGesture = !contract && sync.canvasHost ? watchCanvasGesture(sync.canvasHost) : undefined;
  const gestureActive = (): boolean => interaction?.active() ?? domGesture?.active() ?? false;
  /** when the remote state now held back for a gesture began to wait */
  let heldForGestureSince: number | undefined;

  const writes = doc.getMap<unknown>(CANVAS_WRITES_KEY);
  const entry = (key: string): CanvasWrite | undefined => {
    const value = writes.get(key);
    return isCanvasWrite(value) ? value : undefined;
  };
  const entries = (): Array<[string, CanvasWrite]> =>
    [...writes.entries()].filter((pair): pair is [string, CanvasWrite] => isCanvasWrite(pair[1]));
  /** writer → the count of its latest write a repair wrote over; the writer clears its own notice once told */
  const losses = doc.getMap<unknown>(CANVAS_LOSSES_KEY);
  const writer = (): string => String(doc.clientID);
  // a binding again on the same doc goes on from the writes the log knows of it
  const known = logClosure().get(writer());
  const notice = losses.get(writer());
  let ownWrites = Math.max(known?.[0] ?? 0, typeof notice === "number" ? notice : 0);
  let ownTime = known?.[1] ?? 0;
  let lossToldUpTo = 0;
  /** the canvas writes the canvas holds, its own included */
  let held = new Map<string, Mark>();
  /** text changes that were no canvas write (the source view, an agent, a restore), and their count then */
  let foreignChanges = 0;
  let foreignChangesHeld = 0;
  const matched = (closure: Map<string, Mark>, foreign: number): void => {
    held = closure;
    foreignChangesHeld = foreign;
  };
  /** received writes that deleted text a concurrent canvas write had deleted: the merge keeps both replacements */
  const overlapping = new Map<string, number>();
  let overlapSeenAt = 0;
  /** writers whose presence left the room: their repair timer went with them */
  const departed = new Set<string>();
  /** when the text first failed the gate or the import since a text last rendered */
  let unrenderableSince: number | undefined;
  let unrenderableTimer: ReturnType<typeof setTimeout> | undefined;
  let unrenderableTold = false;

  // a document that never rendered has no fallback view — surface that once
  const reportFirstImportFailure = (message: string): void => {
    if (lastExport !== "" || importErrorReported) return;
    importErrorReported = true;
    onImportError?.(message);
  };

  /**
   * The text failed the gate or the import while the canvas shows a good
   * state. A repair heals that within the notice delay; a break the repair
   * must not write over (typing, a save, a restore) or a repairer that never
   * comes does not, and the canvas would drift from the file unnoticed.
   */
  function notRendered(text: string): void {
    if (lastExport === "" || unrenderableTold) return;
    const now = Date.now();
    unrenderableSince ??= now;
    const remaining = unrenderableSince + UNRENDERABLE_NOTICE_MS - now;
    if (remaining <= 0) return tellUnrenderable();
    clearTimeout(unrenderableTimer);
    // a text that changed meanwhile has an import on its way, which decides
    unrenderableTimer = setTimeout(() => {
      if (!unbound && ytext.toString() === text) tellUnrenderable();
    }, remaining);
  }

  function tellUnrenderable(): void {
    unrenderableTold = true;
    sync.onUnrenderable?.(UNRENDERABLE_MESSAGE);
  }

  /** the text rendered, or is this canvas's own export */
  function rendered(): void {
    clearTimeout(unrenderableTimer);
    unrenderableSince = undefined;
    if (!unrenderableTold) return;
    unrenderableTold = false;
    sync.onUnrenderable?.(null);
  }

  async function importFromY(): Promise<void> {
    if (unbound) return;
    if (importing) {
      // imports never overlap (the contract defines none that do), and the
      // follower reads the text when it starts, so one follower is enough
      importQueued = true;
      return;
    }
    // a wait for a gesture spans only the rechecks that follow each other: any
    // other outcome starts the next wait afresh
    const waitingSince = heldForGestureSince;
    heldForGestureSince = undefined;
    // Local edits win: importText replaces the whole canvas, so an in-flight user
    // edit would be lost. Wait for a short quiet period — the local edit exports
    // into ytext first, and the next observer round imports the merged state.
    if (Date.now() - lastLocalEdit < 600) {
      scheduleImport();
      return;
    }
    const text = ytext.toString();
    if (text === lastExport) {
      rendered();
      // both empty = a 0-byte document, not an echo — there is nothing to render
      if (text === "") reportFirstImportFailure("the document is empty");
      return;
    }
    if (!adapter.looksRenderable(text)) {
      // rule 4: keep last good canvas, wait for next update — but a document
      // that is broken from the START has no last good canvas to keep
      reportFirstImportFailure(adapter.unrenderableReason ?? "the document is not renderable in its current state");
      notRendered(text);
      planRepair(text);
      return;
    }
    const sinceOverlap = Date.now() - overlapSeenAt;
    if (sinceOverlap < OVERLAP_GRACE_MS && overlapOpen()) {
      // a parser that reads a merge of two replacements of the same text reads
      // a garbled model (duplicates, half lines): the repair is due, the merge
      // is taken in only if none comes
      planRepair(text);
      scheduleImport(OVERLAP_GRACE_MS - sinceOverlap);
      return;
    }
    if (gestureActive()) {
      // a gesture has committed nothing yet, so no quiet period covers it; its
      // drop merges into ytext like any local edit, and the import after it
      // takes in both edits. A drop that changes the held change's lines is a
      // conflict there (applyLocalEdit): the peer's edit stays
      const since = waitingSince ?? Date.now();
      const left = since + GESTURE_HOLD_MS - Date.now();
      if (left > 0) {
        heldForGestureSince = since;
        // the modeler tells the end (onChange below); the DOM is read again
        scheduleImport(interaction ? left : GESTURE_RECHECK_MS);
        return;
      }
      // past the hold the peers' edits win, and the gesture ends before the
      // import replaces the shapes it works on: a modeler behind the contract
      // ends it in its own import (L1), the others the way Escape does
      domGesture?.cancel();
    }
    // what this text holds, read with it: more may arrive while it imports
    const closure = logClosure();
    const foreign = foreignChanges;
    importing = true;
    try {
      const isFirstImport = lastExport === "";
      const restoreView = adapter.beforeImport(isFirstImport);
      await adapter.importText(text);
      // an import that settles after the unbind may meet a destroyed modeler
      if (unbound) return;
      restoreView();
      lastExport = text;
      matched(closure, foreign);
      importErrorReported = false;
      rendered();
    } catch (err) {
      if (unbound) return;
      console.warn("[designiq] remote document not importable, keeping last good state", err);
      reportFirstImportFailure(err instanceof Error ? err.message : String(err));
      notRendered(text);
      planRepair(text);
    } finally {
      importing = false;
      if (!unbound && pendingLocalExport) {
        // a canvas edit landed while we were importing — never swallow it,
        // re-export now (no-ops if the import made it obsolete)
        pendingLocalExport = false;
        void onModelChanged();
      }
      if (!unbound && importQueued) {
        importQueued = false;
        scheduleImport(0);
      }
    }
  }

  const scheduleImport = (delay = 350): void => {
    if (unbound) return;
    clearTimeout(timer);
    timer = setTimeout(importFromY, delay);
  };

  /** every canvas write the text holds: the entries, and what they name as held */
  function logClosure(): Map<string, Mark> {
    const closure = new Map<string, Mark>();
    const join = (key: string, mark: Mark): void => {
      if ((closure.get(key)?.[0] ?? 0) < mark[0]) closure.set(key, mark);
    };
    for (const [key, write] of entries()) {
      for (const [other, mark] of Object.entries(write.held)) join(other, mark);
      join(key, [write.n, write.time]);
    }
    return closure;
  }

  /** the entries no other entry holds: the writes nobody has built on */
  function openWrites(): Array<[string, CanvasWrite]> {
    const log = entries();
    return log.filter(([key, write]) =>
      log.every(([other, { held }]) => other === key || (held[key]?.[0] ?? 0) < write.n),
    );
  }

  /**
   * The canvas writes a remote transaction is exactly made of: each client
   * that advanced its clock in it did so by one canvas write, the one its
   * entry declares, and the text lost no more characters than those writes
   * deleted. Anything else in it (a person's typing, an agent's save, a
   * re-sync bundling several writes) makes it no canvas write: a repair must
   * never write over it.
   */
  function canvasWritesIn(tx: Y.Transaction, deletedChars: number): Array<[string, CanvasWrite]> | undefined {
    if (tx.local) return undefined;
    const found: Array<[string, CanvasWrite]> = [];
    for (const [client, after] of tx.afterState) {
      const before = tx.beforeState.get(client) ?? 0;
      if (after === before) continue;
      const write = entry(String(client));
      if (write?.clock[0] !== before || write.clock[1] !== after) return undefined;
      found.push([String(client), write]);
    }
    const declared = found.reduce((sum, [, write]) => sum + write.deleted, 0);
    return found.length > 0 && deletedChars <= declared ? found : undefined;
  }

  const observer = (event: Y.YTextEvent, tx: Y.Transaction): void => {
    if (tx.origin === CANVAS_ORIGIN) return;
    const deletedChars = event.delta.reduce((sum, op) => sum + (op.delete ?? 0), 0);
    const canvasWrites = canvasWritesIn(tx, deletedChars);
    if (!canvasWrites) {
      foreignChanges++;
    } else if (deletedChars < canvasWrites.reduce((sum, [, write]) => sum + write.deleted, 0)) {
      // a concurrent canvas write deleted some of the same characters first:
      // Yjs keeps both writes' insertions, whether or not the parser objects
      overlapSeenAt = Date.now();
      for (const [key, write] of canvasWrites) overlapping.set(key, write.n);
    }
    scheduleImport();
  };
  ytext.observe(observer);

  // never an import inside the listener, which may run inside importText (the
  // cancel of L1) or a pointer handler. The import reads the text when it
  // starts: by then the drop is in it (onModelChanged writes it before the
  // change listener returns), also from a modeler that reports the end first
  const offInteraction = interaction?.onChange((active) => {
    if (!active && heldForGestureSince !== undefined) scheduleImport(0);
  });

  // a peer standing down changes who repairs, without touching the text. A
  // write shows its writer is in the room, whatever the presence last said:
  // a client whose re-sync does not renew its presence (an older one) would
  // otherwise stay passed over here while it ranks itself, and the two
  // repairs would cross again and again
  const onWrites = (event: Y.YMapEvent<unknown>): void => {
    if (event.transaction.local) return;
    for (const key of event.keysChanged) if (entry(key)) departed.delete(key);
    scheduleImport();
  };
  writes.observe(onWrites);

  // a writer that left changes who repairs, as one standing down does
  const onPresence = ({ added, updated, removed }: AwarenessChange): void => {
    for (const id of [...added, ...updated]) departed.delete(String(id));
    const left = removed.filter((id) => id !== doc.clientID).map(String);
    for (const key of left) departed.add(key);
    if (left.some((key) => entry(key))) scheduleImport();
  };
  sync.awareness?.on("change", onPresence);

  /** a repair wrote over this canvas's writes: say so once per lost write, then clear the notice */
  const onLosses = (): void => {
    const lost = losses.get(writer());
    if (typeof lost !== "number") return;
    doc.transact(() => losses.delete(writer()), CANVAS_ORIGIN);
    if (lost <= lossToldUpTo) return;
    lossToldUpTo = lost;
    onConflict?.(REPAIRED_MESSAGE);
  };
  losses.observe(onLosses);
  // a notice that arrived while no canvas of this doc was bound
  onLosses();

  /**
   * A canvas write: the hunks and the log entry in one transaction. A repair
   * also names the writes it overwrote (`lost`: writer → count) and stands on
   * every write of the text it replaced (`replaced`).
   */
  function writeCanvas(
    hunks: readonly Hunk[],
    repairOf?: { replaced: Map<string, Mark>; lost: Map<string, number> },
  ): void {
    const me = writer();
    doc.transact(() => {
      const from = Y.getState(doc.store, doc.clientID);
      applyHunks(ytext, hunks);
      for (const [key, write] of entries()) {
        if (key !== me && ((held.get(key)?.[0] ?? 0) >= write.n || repairOf?.lost.has(key))) writes.delete(key);
      }
      let time = ownTime;
      for (const [, [, at]] of repairOf?.replaced ?? held) time = Math.max(time, at);
      ownTime = time + 1;
      for (const [key, n] of repairOf?.lost ?? []) losses.set(key, n);
      const named = [...held]
        .filter(([key]) => key !== me)
        .sort(([a, [, x]], [b, [, y]]) => y - x || a.localeCompare(b))
        .slice(0, HELD_WRITERS);
      const write: CanvasWrite = {
        n: ++ownWrites,
        time: ownTime,
        held: Object.fromEntries(named),
        // the entry is the transaction's last item, one clock tick long
        clock: [from, Y.getState(doc.store, doc.clientID) + 1],
        deleted: hunks.reduce((sum, hunk) => sum + hunk.deleteCount, 0),
      };
      writes.set(me, write);
      held.set(me, [write.n, write.time]);
    }, CANVAS_ORIGIN);
  }

  const holds = (write: CanvasWrite): number => Object.values(write.held).reduce((sum, [n]) => sum + n, write.n);

  /**
   * The repairing writer: of the open writes not standing down and whose
   * writer is still in the room, the latest (Lamport time: the canvas that
   * took in the longest chain of writes, its own included), then the one
   * whose canvas holds the most writes, then the lowest client id. Every peer
   * ranks the same log and sees the same writers leave (a re-sync or a write
   * brings one back), so every peer names the same writer. None unless
   * writes crossed.
   */
  function repairingWriter(): string | undefined {
    const open = openWrites();
    if (open.length < 2) return undefined;
    const ready = open.filter(([key, write]) => !write.standsDown && !departed.has(key));
    ready.sort(([a, x], [b, y]) => y.time - x.time || holds(y) - holds(x) || Number(a) - Number(b));
    return ready[0]?.[0];
  }
  const logState = (): string =>
    JSON.stringify(
      entries()
        .map(([key, write]) => [key, write.n])
        .sort(),
    );

  function overlapOpen(): boolean {
    const open = openWrites();
    return open.length >= 2 && open.some(([key, write]) => (overlapping.get(key) ?? Infinity) <= write.n);
  }

  /** this canvas cannot repair: tell the peers, so the next-ranked writer can */
  function standDown(): void {
    const own = entry(writer());
    if (own && !own.standsDown) doc.transact(() => writes.set(writer(), { ...own, standsDown: true }), CANVAS_ORIGIN);
  }

  /**
   * The safety net of rule 4 (#274): a text that fails the gate or the import,
   * or that merged two replacements of the same text, while this canvas shows
   * a good state, after nothing but canvas writes since the canvas last
   * matched the text. If this canvas's writer is the repairing one, it writes
   * its export over the text after a settle delay, so a crossing write still
   * on the wire arrives first. It stands down if the text, the log, the rank
   * or the count of other writers' text changes moved meanwhile: a newer write
   * makes the next check rank the newer log, and a person who starts typing is
   * never written over. Its write takes every other write out of the log, so
   * the next check finds one open write and a text every peer imports.
   */
  function planRepair(broken: string): void {
    if (repairingWriter() !== writer()) return;
    if (lastExport === "" || foreignChanges !== foreignChangesHeld) return standDown();
    const log = logState();
    clearTimeout(repairTimer);
    repairTimer = setTimeout(() => void repair(broken, log), REPAIR_SETTLE_MS);
  }

  async function repair(broken: string, log: string): Promise<void> {
    const unchanged = (): boolean =>
      !unbound &&
      !importing &&
      ytext.toString() === broken &&
      logState() === log &&
      foreignChanges === foreignChangesHeld &&
      repairingWriter() === writer();
    if (!unchanged()) return;
    const text = await adapter.exportText();
    if (!text || !adapter.looksRenderable(text) || !unchanged()) return;
    if (text !== broken) {
      // every write the text holds that this canvas does not is overwritten
      const replaced = logClosure();
      const lost = new Map<string, number>();
      for (const [key, [n]] of replaced) if (key !== writer() && (held.get(key)?.[0] ?? 0) < n) lost.set(key, n);
      writeCanvas(diffHunks(broken, text), { replaced, lost });
    }
    lastExport = text;
    matched(logClosure(), foreignChanges);
    rendered();
  }

  const onModelChanged = async (): Promise<void> => {
    if (unbound) return;
    if (contract) {
      // in the text before the change listener returns, also while an import
      // waits for this action to finish (L1, 1.6): the canvas still holds the
      // text before that import, so the edit merges against lastExport. That
      // import draws the peer's text without the edit, so the one that shows
      // both follows it at once: the edit is in the text already, and the
      // import's fresh undo history holds nothing a quiet period would keep
      if (importing) {
        importQueued = true;
        lastLocalEdit = 0;
      } else lastLocalEdit = Date.now();
      const text = contract.exportText();
      if (text && text !== lastExport) applyLocalEdit(text);
      return;
    }
    if (importing) {
      // fires for the commandStack 'clear' of our own importText (harmless no-op
      // on re-run) AND for real user edits racing the import. Known limit of
      // text-level sync: an edit landing inside the ~10ms import window is
      // replaced along with the model (v2 operation-level sync removes this).
      pendingLocalExport = true;
      lastLocalEdit = Date.now();
      return;
    }
    lastLocalEdit = Date.now();
    const text = await adapter.exportText();
    if (unbound || !text || text === lastExport) return;
    applyLocalEdit(text);
  };
  const unobserveModel = adapter.observeModel(() => void onModelChanged());

  /**
   * Rule 2, merge-aware: export the canvas edit as a diff against the canvas's
   * LAST serialization (lastExport), never against the live ytext. If remote
   * edits arrived in between, a plain ytext diff would isolate exactly the
   * colleague's change as "the differing middle" and delete it — silent data
   * loss inside the debounce window. Instead the local change region is located
   * in the current text by its surrounding context, and where that fails the
   * edit merges line by line (mergeLines, #309): edits of different lines
   * merge, an edit of the same lines keeps the remote edit and reports the
   * conflict. So does a merge that fails the gate (looksRenderable) where the
   * current text passes it: a remote edit typed or saved into the text bars
   * the repair that heals a break (planRepair), and the text would stay
   * broken for everyone.
   */
  function applyLocalEdit(next: string): void {
    const base = lastExport;
    const current = ytext.toString();

    if (current === base) {
      // no concurrent remote change — plain minimal diff
      writeCanvas(diffHunks(base, next));
      lastExport = next;
      foreignChangesHeld = foreignChanges;
      return;
    }

    // remote edits landed since our last sync — merge if the edits are apart.
    // The line breaks that close the text are no part of the change region
    // (diffHunks): the export adds the one an older file lacks, and peers
    // making their first edit at once would otherwise each replace the whole
    // tail. They change only where the remote edits left them as they were.
    const baseBody = closingBreaksAt(base);
    const nextBody = closingBreaksAt(next);
    const currentBody = closingBreaksAt(current);
    const closing: Hunk[] = [];
    if (base.slice(baseBody) === current.slice(currentBody)) {
      for (const hunk of diffHunks(base.slice(baseBody), next.slice(nextBody))) {
        closing.push({ ...hunk, at: currentBody + hunk.at });
      }
    }
    const body = locateLocalEdit(base.slice(0, baseBody), current.slice(0, currentBody), next.slice(0, nextBody));
    const hunks = body && [...closing, ...body];
    const breaksText = (merge: readonly Hunk[]): boolean =>
      merge.length > 0 && !adapter.looksRenderable(patchText(current, merge)) && adapter.looksRenderable(current);
    if (hunks && !breaksText(hunks)) {
      if (hunks.length > 0) writeCanvas(hunks);
      // canvas still lacks the remote part — bring it in on the next quiet moment
      lastExport = next;
      scheduleImport();
      return;
    }

    // edits of the same lines, or a merge that fails the gate: the remote
    // change wins, the local canvas op is undone — explicitly, not silently
    // (rule 4 fallback semantics)
    onConflict?.(CONFLICT_MESSAGE);
    pendingLocalExport = false;
    lastLocalEdit = 0; // bypass the quiet period: re-import now
    // a modeler behind the contract is inside its change listener here, in
    // the middle of the user's action: the import starts once that has returned
    if (contract) scheduleImport(0);
    else void importFromY();
  }

  void importFromY();

  return () => {
    unbound = true;
    ytext.unobserve(observer);
    writes.unobserve(onWrites);
    sync.awareness?.off("change", onPresence);
    losses.unobserve(onLosses);
    unobserveModel();
    offInteraction?.();
    domGesture?.dispose();
    clearTimeout(timer);
    clearTimeout(repairTimer);
    clearTimeout(unrenderableTimer);
  };
}
