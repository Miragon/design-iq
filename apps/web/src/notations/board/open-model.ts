/**
 * The editor of ONE model node (EmbeddedEditor), handed to the board at once. The board has no
 * loading look and no retry, so the node does both itself:
 * - Its file: it opens the model's own live room (EditorContext.linkedFiles, the shell's one
 *   linked socket) once the shell lists the path, since a room of a path that is no model would
 *   start a new, empty file. A node whose file is not there says so and is asked for again when
 *   the list changes; one whose model moved follows it (a moved notice of its room, or a list the
 *   shell loaded anew for it: ModelPaths.relocation).
 * - Its editor: the PRODUCT editor of the notation (product-mount.ts), unmodified, into a child of
 *   the node's element, once the room has synced: a live session's text arrives after it opened,
 *   and an editor mounted before would import nothing.
 * - ready: the first import the editor drew (SyncOptions.onImported), and one task more for the
 *   first fit the Miragon editors schedule then.
 * - Keys and presence: only while the node is armed and its board on screen. Every product editor
 *   binds its chrome keys on the document and asks EditorContext.visibility whether its canvas is
 *   on screen: here that is "armed", so of all the editors on a board only the armed one acts. The
 *   person is announced in the model's room (LinkedFiles.present) only while they edit it there,
 *   and not while the shell shows the board's source instead.
 * - The end: the editor first, then the session it was bound to, one task after destroy(): what
 *   the editor committed last is still on its way to the room then. What is still on its way
 *   when the node goes (a session that syncs, an editor that loads) is closed when it arrives,
 *   and `closed` says when nothing of the node is bound any more.
 * Node-loadable: the shell's parts and the product editor are injected.
 */
import type { LiveSession } from "@designiq/live-client";
import type { EmbeddedEditor, EmbeddedEditorContext } from "@miragon/board-renderer";

import type { EditorContext, LayerVisibility, LinkedFiles, MountedEditor } from "../registry.ts";
import { modelStateLine } from "./model-state.ts";
import type { ModelTexts } from "./model-texts.ts";
import type { ModelPaths } from "./models.ts";
import { modelPresence } from "./presence.ts";
import type { ProductMount } from "./product-mount.ts";
import { releaseDiagramJs } from "./release.ts";

/** a linked model that does not sync within this time counts as failed: its node says so */
export const LINK_TIMEOUT_MS = 20_000;

export interface OpenModelDeps {
  /** the BOARD's context: its repository, the shell's notices, its layer's visibility, the model list */
  readonly ctx: Pick<EditorContext, "repo" | "onSyncError" | "onActionFailed" | "models" | "visibility">;
  readonly linkedFiles: LinkedFiles;
  readonly product: ProductMount;
  readonly paths: ModelPaths;
  readonly texts: ModelTexts;
  /** the board's log for what no person needs to read (an editor call that threw) */
  readonly log?: (line: string) => void;
}

export interface OpenedModel extends EmbeddedEditor {
  /** settles once the node let go of everything after destroy(): its editor and its session */
  readonly closed: Promise<void>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function openModel(context: EmbeddedEditorContext, deps: OpenModelDeps): OpenedModel {
  const { element, path } = context;
  const { ctx, linkedFiles, product, paths, texts } = deps;
  const log = deps.log ?? ((line: string) => console.debug("[board]", line));
  const doc = element.ownerDocument;
  // board.css's rules are opt-in by this attribute
  element.dataset.embed = "designiq";
  const host = doc.createElement("div");
  // the product's stylesheets are scoped under its canvas class (bpmn-io-theme.css, vendor-css.ts)
  host.className = `board-model-editor ${product.canvasClassName}`;
  // a view without a focusable canvas of its own (a decision table) still takes the keys when armed
  host.tabIndex = -1;
  element.append(host);
  const state = modelStateLine(element);
  state.show("loading");

  /** destroy() was called */
  let ended = false;
  let session: LiveSession | undefined;
  /** what ends with the session: its listeners and its text in the reference parsing */
  const sessionOffs: Array<() => void> = [];
  let editor: MountedEditor | undefined;
  /** the product editor is on its way: what goes, goes once it is there */
  let mounting = false;
  let closeAfterMount = false;
  /** wakes a start that waits for its session to sync, when that session goes */
  let wake: (() => void) | undefined;
  /** a first import was drawn: an invalid or gone line then stands over the last canvas */
  let drawn = false;
  /** the Live Host said the model moved: the room's close that follows is no failure */
  let moved = false;
  /** where the model went is being looked up (ModelPaths.relocation), once at a time */
  let following = false;
  /** the person is announced in the session's room */
  let announced = false;
  let wantsFocus = false;
  const shown = new Set<() => void>();

  let settle!: () => void;
  let fail!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // only the board's own registry reads it: a failure that nobody waits for is said in the element
  ready.catch(() => undefined);
  let closedNow!: () => void;
  const closed = new Promise<void>((resolve) => (closedNow = resolve));

  const contained = (what: string, call: () => void): void => {
    try {
      call();
    } catch (error) {
      log(`${path}: ${what} failed: ${messageOf(error)}`);
    }
  };

  // KEYS: what the product editor asks before it takes a key on the document
  const armed = (): boolean => !ended && context.armed() && (ctx.visibility?.visible() ?? true);
  const tellShown = (): void => {
    for (const listener of [...shown]) contained("a visibility listener", listener);
  };
  const visibility: LayerVisibility = {
    visible: armed,
    onChange(listener) {
      shown.add(listener);
      return () => void shown.delete(listener);
    },
  };
  // PRESENCE: announced in the model's room only while the node is armed and its board on screen;
  // a preview is nowhere in it, and is told nothing when the board hides or shows
  const present = (now: boolean): void => {
    const linked = session;
    if (!linked || now === announced) return;
    announced = now;
    contained("the presence", () => {
      if (!now) linked.setCanvasPresence(null);
      linkedFiles.present(linked, now);
    });
  };
  const relocate = (to: string): void => {
    if (!ended && to !== path) context.relocate(to);
  };

  /** the editor first (it unbinds), then the session it was bound to; deferred while one mounts */
  const close = (): void => {
    if (mounting) {
      closeAfterMount = true;
      return;
    }
    closeAfterMount = false;
    wake?.();
    const gone = editor;
    editor = undefined;
    if (gone) {
      // its canvas goes with it: a node opened again draws anew
      drawn = false;
      delete element.dataset.modelDrawn;
    }
    const offs = sessionOffs.splice(0);
    const linked = session;
    session = undefined;
    announced = false;
    const end = (): void => {
      if (gone) contained("the editor's destroy()", () => gone.destroy());
      for (const off of offs) contained("a session listener's removal", off);
      if (linked) contained("the session's destroy()", () => linked.destroy());
      if (!ended) return;
      state.remove();
      host.remove();
      delete element.dataset.embed;
      closedNow();
    };
    // the node goes: bpmn-js and dmn-js export a commit a few microtasks after it (what release()
    // committed right before, an open label; a decision-table cell, which commits as it is
    // typed). The export reaches the room only while the editor is bound and its session open,
    // so both go one task later, and the shell ends the linked socket only after `closed`. A
    // relocate calls no release(): an open label there is not committed, and the Live Host
    // closes the room the model left anyway
    if (ended && gone) setTimeout(end, 0);
    else end();
  };
  const failed = (error: unknown): void => {
    if (ended) return;
    state.show("failed", messageOf(error));
    fail(error instanceof Error ? error : new Error(messageOf(error)));
    close();
  };

  const childContext = (linked: LiveSession): EditorContext => {
    const { fitInsets } = product;
    return {
      ytext: linked.content,
      doc: linked.doc,
      repo: ctx.repo,
      docPath: path,
      onSyncError: (message) => ctx.onSyncError(`${path}: ${message}`),
      // the first import failed: the node keeps its place and says so (the shell would show the text)
      onImportFailed: (message) => {
        // a node that goes, or failed while its editor mounted, keeps what it says
        if (ended || closeAfterMount) return;
        state.show("invalid", message);
        fail(new Error(message));
      },
      sync: {
        awareness: linked.awareness,
        onUnrenderable: (message) => {
          if (ended || closeAfterMount) return;
          if (message !== null) state.show("invalid", message);
          else if (state.current() === "invalid") state.show(drawn ? "ready" : "loading");
        },
        onImported: () => {
          // an editor that draws inside its mount, after its room was closed, is destroyed once
          // it is there: the node says it failed, not that it is ready
          if (ended || closeAfterMount) return;
          if (state.current() !== "gone") state.show("ready");
          if (drawn) return;
          drawn = true;
          element.dataset.modelDrawn = "true";
          // the first fit a Miragon editor schedules after its import (setTimeout 0, diagramView) is part of it
          setTimeout(settle, 0);
        },
        // bpmn-js and the DRD fit edge to edge without it, under their own palette
        ...(fitInsets ? { fitInsets: () => fitInsets(host) } : {}),
      },
      onBadgeClick: () => undefined,
      onSelectionChanged: () => undefined,
      visibility,
      presence: modelPresence(linked, armed),
      ...(ctx.onActionFailed ? { onActionFailed: ctx.onActionFailed } : {}),
      ...(ctx.models ? { models: ctx.models } : {}),
    };
  };

  /** the shell's list (again): opens a node whose file it lists, follows or marks one it lacks */
  const onList = (): void => {
    if (ended) return;
    const listed = paths.listed(path);
    if (listed === false) {
      // a change of a canvas whose file is gone could not be written
      host.inert = true;
      void follow();
      return;
    }
    if (listed !== true) return;
    host.inert = false;
    // a node whose file could not be opened is asked for again when the list has its path
    if (!session && !mounting) void start();
    else if (state.current() === "gone") state.show(drawn ? "ready" : "loading");
  };

  /** the node's file is not listed: moved (a notice, or a list loaded anew confirms it), the node
   *  follows; deleted, or not confirmed, it keeps its place and says so */
  const follow = async (): Promise<void> => {
    if (ended || following) return;
    if (paths.movedTo(path) === undefined) return void state.show("gone");
    following = true;
    state.show("loading");
    const to = await paths.relocation(path, context.nodeId).catch(() => undefined);
    following = false;
    if (ended) return;
    if (to !== undefined) return relocate(to);
    if (paths.listed(path) === false) state.show("gone");
    else onList();
  };

  const start = async (): Promise<void> => {
    if (ended || session || mounting) return;
    const listed = paths.listed(path);
    if (listed !== true) {
      // a room of a path that is no model would be a new, empty file: opened only once listed
      if (listed === false) void follow();
      return;
    }
    let linked: LiveSession;
    try {
      linked = linkedFiles.open(path);
    } catch (error) {
      // where the Live Host said the model moved, and the shell's list does not have it yet (the
      // shell opens listed models only): the node waits for the list, which asks again
      if (ctx.models?.paths()?.has(path) === false) state.show("loading");
      else failed(error);
      return;
    }
    session = linked;
    sessionOffs.push(
      // renamed or moved while the board has it open: the Live Host says where it went, then closes the room
      linked.onMoved((notice) => {
        if (ended || session !== linked) return;
        moved = true;
        paths.moved(path, notice.to);
        relocate(notice.to);
      }),
      linked.onDocClose(() => {
        if (!moved && session === linked) failed(new Error("the Live Host closed this model's live document"));
      }),
    );
    state.show(drawn ? "ready" : "loading");
    try {
      await Promise.race([linked.whenSynced(LINK_TIMEOUT_MS), new Promise<void>((resolve) => (wake = resolve))]);
    } catch (error) {
      if (session === linked) failed(error);
      return;
    } finally {
      wake = undefined;
    }
    if (ended || session !== linked) return;
    present(armed());
    sessionOffs.push(texts.add(path, linked.content));
    mounting = true;
    let mounted: MountedEditor | undefined;
    let failure: unknown;
    try {
      mounted = await product.mount(host, childContext(linked));
    } catch (error) {
      failure = error ?? new Error("the editor could not be mounted");
    } finally {
      mounting = false;
    }
    editor = mounted;
    if (ended || closeAfterMount) return close();
    if (failure !== undefined) return failed(failure);
    if (wantsFocus && context.armed()) contained("the editor's focus()", () => editor?.focus?.());
  };

  // moved while this board did not have it open, or not rewritten: followed; deleted: kept in place
  const offModels = paths.onChange(onList);
  const offArmed = context.onArmedChange(() => {
    present(armed());
    tellShown();
  });
  // the shell shows the board's source instead, or the board again
  const offShown = ctx.visibility?.onChange(() => {
    present(armed());
    tellShown();
  });
  // not inside the board's open(): a node whose model moved relocates, which the board takes as a
  // write of its own
  queueMicrotask(() => void start());

  return {
    ready,
    closed,
    // before a disarm (still armed, in the layer), and before destroy() of a node that goes armed
    release() {
      if (editor) releaseDiagramJs(element);
    },
    // after the move into the layer, and for a node that is armed from its first moment
    focus() {
      wantsFocus = true;
      if (editor) contained("the editor's focus()", () => editor?.focus?.());
      if (!element.contains(doc.activeElement)) host.focus({ preventScroll: true });
    },
    destroy() {
      if (ended) return;
      ended = true;
      offModels();
      offArmed();
      offShown?.();
      shown.clear();
      close();
    },
  };
}
