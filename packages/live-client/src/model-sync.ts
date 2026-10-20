/**
 * Y.Text ↔ visual-modeler sync engine — the four sync rules from
 * docs/platform-concept.md, notation-agnostic:
 *
 *  1. one pinned modeler version across all clients (package.json)
 *  2. minimal diffs into Y.Text, never replace-all (common prefix/suffix trim,
 *     the line breaks that close the text apart)
 *  3. debounced re-import of remote changes with view-state restore and echo
 *     suppression (Yjs transaction origin + last-export equality)
 *  4. gate the merged text before import; keep rendering the last good state on
 *     rare invalid interleavings — the next update usually heals the document.
 *     Canvas exports that cross on the wire never heal: each canvas keeps its
 *     own state, so exactly one of their writers writes its canvas over the
 *     merge they broke (repairs below, #274)
 *
 * What differs per notation (how change events are observed, how the view
 * state survives a re-import, what "renderable" means pre-import) lives in a
 * SyncAdapter; bpmn-sync, dmn-sync and miragon-sync (ONE adapter for every
 * modeler behind the @miragon/modeler-api contract) are the adapters.
 * Consumers import those, never this module.
 */
import { CANVAS_WRITES_KEY } from "@designiq/contracts/live";
import type * as Y from "yjs";

import { applyHunks, closingBreaksAt, diffHunks, diffRegion, type Hunk } from "./text-diff.ts";

/** Shared origin marker: transactions tagged with it are our own canvas edits. */
export const CANVAS_ORIGIN = "bpm-canvas";

const CONFLICT_MESSAGE =
  "Gleichzeitige Änderung am selben Element — deine letzte Aktion wurde durch die Änderung einer Kollegin/eines Kollegen ersetzt.";

/** how long the repairing writer waits for further crossing writes before it writes */
const REPAIR_SETTLE_MS = 500;

/**
 * One entry of the canvas write log (CANVAS_WRITES_KEY: writer's Yjs client
 * id → its latest canvas write, set in the write's own transaction). A write
 * takes out of the log every entry its canvas already holds, so the log keeps
 * the canvas writes no canvas has taken in yet: one after edits that follow
 * each other, two or more after edits that crossed.
 */
interface CanvasWrite {
  /** the writer's own count: a held entry and a newer write of the same writer differ */
  n: number;
  /** one more than the deepest other writer's write the canvas stood on, never less than before */
  depth: number;
  /** on a repair: the writers whose open writes it overwrote */
  superseded?: string[];
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
): () => void {
  let importing = false;
  let lastExport = "";
  let lastLocalEdit = 0;
  let pendingLocalExport = false;
  let importErrorReported = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let repairTimer: ReturnType<typeof setTimeout> | undefined;
  let unbound = false;

  const writes = doc.getMap<CanvasWrite>(CANVAS_WRITES_KEY);
  const writer = (): string => String(doc.clientID);
  // a binding again on the same doc goes on from its earlier entry
  let ownWrites = writes.get(writer())?.n ?? 0;
  let ownDepth = writes.get(writer())?.depth ?? 0;
  /** the log as it stood when the canvas last matched the text: what the canvas holds */
  let held = new Map<string, CanvasWrite>();
  /** text changes that were no canvas write (the source view, an agent, a restore), and their count then */
  let foreignChanges = 0;
  let foreignChangesHeld = 0;
  const matched = (log: Map<string, CanvasWrite>, foreign: number): void => {
    held = log;
    foreignChangesHeld = foreign;
  };

  // a document that never rendered has no fallback view — surface that once
  const reportFirstImportFailure = (message: string): void => {
    if (lastExport !== "" || importErrorReported) return;
    importErrorReported = true;
    onImportError?.(message);
  };

  async function importFromY(): Promise<void> {
    // Local edits win: importText replaces the whole canvas, so an in-flight user
    // edit would be lost. Wait for a short quiet period — the local edit exports
    // into ytext first, and the next observer round imports the merged state.
    if (Date.now() - lastLocalEdit < 600) {
      scheduleImport();
      return;
    }
    const text = ytext.toString();
    if (text === lastExport) {
      // both empty = a 0-byte document, not an echo — there is nothing to render
      if (text === "") reportFirstImportFailure("the document is empty");
      return;
    }
    if (!adapter.looksRenderable(text)) {
      // rule 4: keep last good canvas, wait for next update — but a document
      // that is broken from the START has no last good canvas to keep
      reportFirstImportFailure(adapter.unrenderableReason ?? "the document is not renderable in its current state");
      planRepair(text);
      return;
    }
    // what this text holds, read with it: more may arrive while it imports
    const log = new Map(writes.entries());
    const foreign = foreignChanges;
    importing = true;
    try {
      const isFirstImport = lastExport === "";
      const restoreView = adapter.beforeImport(isFirstImport);
      await adapter.importText(text);
      restoreView();
      lastExport = text;
      matched(log, foreign);
      importErrorReported = false;
    } catch (err) {
      console.warn("[designiq] remote document not importable, keeping last good state", err);
      reportFirstImportFailure(err instanceof Error ? err.message : String(err));
      planRepair(text);
    } finally {
      importing = false;
      if (pendingLocalExport) {
        // a canvas edit landed while we were importing — never swallow it,
        // re-export now (no-ops if the import made it obsolete)
        pendingLocalExport = false;
        void onModelChanged();
      }
    }
  }

  const scheduleImport = (): void => {
    clearTimeout(timer);
    timer = setTimeout(importFromY, 350);
  };

  /**
   * A peer's canvas write carries its log entry in the same transaction, and
   * nothing else advanced a client's clock in it. Anything else is a person's
   * or an agent's text, which a repair must never write over.
   */
  function isPeerCanvasWrite(tx: Y.Transaction): boolean {
    if (tx.local) return false;
    const writers = new Set<number>();
    for (const key of tx.changed.get(writes as never) ?? []) {
      if (key !== null && writes.has(key)) writers.add(Number(key));
    }
    if (writers.size === 0) return false;
    for (const [client, clock] of tx.afterState) {
      if (clock > (tx.beforeState.get(client) ?? 0) && !writers.has(client)) return false;
    }
    return true;
  }

  const observer = (_event: unknown, tx: Y.Transaction): void => {
    if (tx.origin === CANVAS_ORIGIN) return;
    if (!isPeerCanvasWrite(tx)) foreignChanges++;
    scheduleImport();
  };
  ytext.observe(observer as never);

  /** a peer's repair overwrote my open write: my canvas is about to lose it */
  const onWrites = (event: Y.YMapEvent<CanvasWrite>): void => {
    if (event.transaction.local) return;
    for (const key of event.keysChanged) {
      if (writes.get(key)?.superseded?.includes(writer())) return void onConflict?.(CONFLICT_MESSAGE);
    }
  };
  writes.observe(onWrites);

  /** a canvas write: the hunks and the log entry in one transaction */
  function writeCanvas(hunks: readonly Hunk[], repair = false): void {
    doc.transact(() => {
      applyHunks(ytext, hunks);
      const me = writer();
      let deepest = 0;
      for (const [key, write] of held) if (key !== me) deepest = Math.max(deepest, write.depth);
      const superseded: string[] = [];
      for (const [key, write] of [...writes.entries()]) {
        if (key === me) continue;
        if (held.get(key)?.n === write.n) {
          writes.delete(key);
        } else if (repair) {
          superseded.push(key);
          deepest = Math.max(deepest, write.depth);
          writes.delete(key);
        }
      }
      ownDepth = Math.max(ownDepth, deepest + 1);
      writes.set(me, { n: ++ownWrites, depth: ownDepth, ...(superseded.length > 0 ? { superseded } : {}) });
    }, CANVAS_ORIGIN);
  }

  /**
   * The repairing writer: the open write that stands on the deepest chain of
   * other writers' writes (its canvas has taken in the most), on a tie the
   * lowest client id. Every peer ranks the same log, so every peer names the
   * same writer. None unless writes crossed.
   */
  function repairingWriter(): string | undefined {
    const open = [...writes.entries()];
    if (open.length < 2) return undefined;
    open.sort(([a, x], [b, y]) => y.depth - x.depth || Number(a) - Number(b));
    return open[0]![0];
  }
  const logState = (): string => JSON.stringify([...writes.entries()].map(([key, write]) => [key, write.n]).sort());

  /**
   * The safety net of rule 4 (#274): a text that fails the gate or the import
   * while this canvas shows a good state, after nothing but canvas writes since
   * the canvas last matched the text. If this canvas's writer is the repairing
   * one, it writes its export over the text after a settle delay, so a crossing
   * write still on the wire arrives first. It stands down if the text, the log
   * or the count of other writers' text changes moved meanwhile: a newer write
   * makes the next check rank the newer log, and a person who starts typing is
   * never written over. Its write takes every open write out of the log, so
   * the next check finds one open write and a text every peer imports.
   */
  function planRepair(broken: string): void {
    if (lastExport === "" || foreignChanges !== foreignChangesHeld || repairingWriter() !== writer()) return;
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
      foreignChanges === foreignChangesHeld;
    if (!unchanged()) return;
    const text = await adapter.exportText();
    if (!text || !adapter.looksRenderable(text) || !unchanged()) return;
    writeCanvas(diffHunks(broken, text), true);
    lastExport = text;
    matched(new Map(writes.entries()), foreignChanges);
  }

  const onModelChanged = async (): Promise<void> => {
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
    if (!text || text === lastExport) return;
    applyLocalEdit(text);
  };
  const unobserveModel = adapter.observeModel(() => void onModelChanged());

  /**
   * Rule 2, merge-aware: export the canvas edit as a diff against the canvas's
   * LAST serialization (lastExport), never against the live ytext. If remote
   * edits arrived in between, a plain ytext diff would isolate exactly the
   * colleague's change as "the differing middle" and delete it — silent data
   * loss inside the debounce window. Instead the local change region is located
   * in the current text by its surrounding context; disjoint edits merge, a
   * true overlap keeps the remote edit and reports the conflict.
   */
  function applyLocalEdit(next: string): void {
    const base = lastExport;
    const current = ytext.toString();

    if (current === base) {
      // no concurrent remote change — plain minimal diff
      writeCanvas(diffHunks(base, next));
      lastExport = next;
      matched(new Map(writes.entries()), foreignChanges);
      return;
    }

    // remote edits landed since our last sync — merge if regions are disjoint.
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
    // Locate the local change region in the current text by its surrounding
    // context; wide context first (position safety), shrinking so that a nearby
    // -but-disjoint remote edit inside the window doesn't masquerade as overlap.
    const { start, endPrev, endNext } = diffRegion(base.slice(0, baseBody), next.slice(0, nextBody));
    const delText = base.slice(start, endPrev);
    const insText = next.slice(start, endNext);
    const merge = (body: Hunk[]): void => {
      const hunks = [...closing, ...body];
      if (hunks.length > 0) writeCanvas(hunks);
      // canvas still lacks the remote part — bring it in on the next quiet moment
      lastExport = next;
      scheduleImport();
    };
    if (!delText && !insText) return merge([]);
    const currentText = current.slice(0, currentBody);
    for (const ctx of [64, 32, 16, 8]) {
      const ctxL = base.slice(Math.max(0, start - ctx), start);
      const ctxR = base.slice(endPrev, Math.min(baseBody, endPrev + ctx));
      const needle = ctxL + delText + ctxR;
      const at = currentText.indexOf(needle);
      if (at < 0 || currentText.indexOf(needle, at + 1) >= 0) continue; // absent or ambiguous
      return merge([{ at: at + ctxL.length, deleteCount: delText.length, insert: insText }]);
    }

    // overlapping edits: the remote change wins, the local canvas op is undone —
    // explicitly, not silently (rule 4 fallback semantics)
    onConflict?.(CONFLICT_MESSAGE);
    pendingLocalExport = false;
    lastLocalEdit = 0; // bypass the quiet period: re-import now
    void importFromY();
  }

  void importFromY();

  return () => {
    unbound = true;
    ytext.unobserve(observer as never);
    writes.unobserve(onWrites);
    unobserveModel();
    clearTimeout(timer);
    clearTimeout(repairTimer);
  };
}
