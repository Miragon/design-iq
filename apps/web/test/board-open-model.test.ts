/**
 * The editor of one model node (src/notations/board/open-model.ts) and the host that opens it
 * (host.ts), on fakes of the shell's linked files, of a live session and of a product editor:
 * a node opens its model's room only once the shell lists the path, mounts the product editor
 * once the room synced, is ready once the editor drew its first import, follows a moved model
 * (never on a model list from before the move: two clients whose lists disagree never move a
 * node back and forth) and says what became of a file that is gone, invalid or could not be
 * opened, also when its room closed while its editor mounted; it takes the keys and announces
 * the person only while armed and its board on screen; and at its end it destroys the editor
 * first, then the session, a task later where an editor was there (what release() committed is
 * still on its way), also when either was still on its way, and says when it let go of both.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { movedNotice, parseMovedNotice } from "@designiq/contracts/live";
import type { LiveSession, MovedNotice } from "@designiq/live-client";
import type { EmbeddedEditorContext } from "@miragon/board-renderer";
import { JSDOM } from "jsdom";
import * as Y from "yjs";

import { createBoardHost } from "../src/notations/board/host.ts";
import { MODEL_STATE_TEXT } from "../src/notations/board/model-state.ts";
import { createModelTexts } from "../src/notations/board/model-texts.ts";
import { modelPathsOf } from "../src/notations/board/models.ts";
import { openModel, type OpenModelDeps } from "../src/notations/board/open-model.ts";
import type { ProductMount } from "../src/notations/board/product-mount.ts";
import type {
  EditorContext,
  LayerVisibility,
  LinkedFiles,
  ModelDirectory,
  MountedEditor,
  WebNotationPlugin,
} from "../src/notations/registry.ts";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
after(() => window.close());
const { document } = window;

/** what the fakes did, in order */
type Log = string[];

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeSession {
  session: LiveSession;
  path: string;
  synced: ReturnType<typeof deferred<void>>;
  destroyed: boolean;
  user: unknown;
  canvas: unknown;
  moved(to: string): void;
  docClosed(): void;
}

/** the shell's linked files over fake sessions: one Y.Doc each, a sync the test settles */
function linkedFiles(log: Log) {
  const sessions: FakeSession[] = [];
  const files: LinkedFiles = {
    open(path) {
      log.push(`open ${path}`);
      const doc = new Y.Doc();
      const moved = new Set<(notice: MovedNotice) => void>();
      const closed = new Set<() => void>();
      const fake: FakeSession = {
        path,
        synced: deferred(),
        destroyed: false,
        user: undefined,
        canvas: undefined,
        moved: (to) => {
          for (const listener of [...moved]) listener(parseMovedNotice(movedNotice("acme/models", to, "Grace"))!);
        },
        docClosed: () => {
          for (const listener of [...closed]) listener();
        },
        session: {
          doc,
          content: doc.getText("content"),
          awareness: null,
          onMoved(listener: (notice: MovedNotice) => void) {
            moved.add(listener);
            return () => void moved.delete(listener);
          },
          onDocClose(listener: () => void) {
            closed.add(listener);
            return () => void closed.delete(listener);
          },
          whenSynced: () => fake.synced.promise,
          setCanvasPresence(canvas: unknown) {
            fake.canvas = canvas;
            log.push(`canvas ${path} ${JSON.stringify(canvas)}`);
          },
          onAwarenessStates(listener: (peers: unknown[]) => void) {
            listener([]);
            return () => undefined;
          },
          destroy() {
            fake.destroyed = true;
            log.push(`destroy session ${path}`);
          },
        } as unknown as LiveSession,
      };
      sessions.push(fake);
      return fake.session;
    },
    present(session, present) {
      const fake = sessions.find((one) => one.session === session);
      if (fake) fake.user = present ? "me" : null;
      log.push(`present ${fake?.path} ${present}`);
    },
  };
  return { files, sessions };
}

interface FakeEditor {
  ctx: EditorContext;
  host: HTMLElement;
  destroyed: boolean;
  focused: number;
}

/** a product editor whose mount the test settles (or that mounts at once) */
function product(log: Log, opts: { hold?: boolean; fitInsets?: boolean } = {}) {
  const editors: FakeEditor[] = [];
  const pending: Array<ReturnType<typeof deferred<void>>> = [];
  const mount: ProductMount = {
    canvasClassName: "bpmn-canvas",
    async mount(host, ctx) {
      log.push(`mount ${ctx.docPath}`);
      const editor: FakeEditor = { ctx, host, destroyed: false, focused: 0 };
      editors.push(editor);
      if (opts.hold) {
        const held = deferred();
        pending.push(held);
        await held.promise;
      }
      return {
        focus: () => void editor.focused++,
        destroy() {
          editor.destroyed = true;
          log.push(`destroy editor ${ctx.docPath}`);
        },
      } satisfies MountedEditor;
    },
    ...(opts.fitInsets ? { fitInsets: () => ({ top: 1, right: 2, bottom: 3, left: 4 }) } : {}),
  };
  return { mount, editors, pending };
}

/**
 * The shell's model list. With `server`, refresh() loads it anew from there, as live-editor.tsx
 * does: a new Set, and its listeners told, only where the list changed
 */
function modelDirectory(initial?: readonly string[], server?: () => readonly string[]) {
  let paths: ReadonlySet<string> | undefined = initial ? new Set(initial) : undefined;
  const listeners = new Set<() => void>();
  const set = (next: readonly string[] | undefined): void => {
    paths = next ? new Set(next) : undefined;
    for (const listener of [...listeners]) listener();
  };
  let refreshes = 0;
  const dir: ModelDirectory = {
    paths: () => paths,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    ...(server
      ? {
          async refresh() {
            refreshes++;
            await flush();
            const next = server();
            const same = paths?.size === next.length && next.every((one) => paths?.has(one));
            if (!same) set(next);
          },
        }
      : {}),
  };
  return { dir, set, refreshes: () => refreshes };
}

/** what the board tells a node */
function nodeContext(path: string, nodeId = "n_model") {
  const element = document.createElement("div");
  element.className = "board-engine";
  document.body.append(element);
  let armed = false;
  const armedListeners = new Set<(now: boolean) => void>();
  const relocated: string[] = [];
  const context: EmbeddedEditorContext = {
    nodeId,
    path,
    element,
    armed: () => armed,
    onArmedChange(listener) {
      armedListeners.add(listener);
      return () => void armedListeners.delete(listener);
    },
    relocate: (to) => void relocated.push(to),
  };
  return {
    context,
    element,
    relocated,
    arm(now: boolean) {
      armed = now;
      for (const listener of [...armedListeners]) listener(now);
    },
  };
}

function boardVisibility() {
  let visible = true;
  const listeners = new Set<() => void>();
  const visibility: LayerVisibility = {
    visible: () => visible,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    visibility,
    set(now: boolean) {
      visible = now;
      for (const listener of [...listeners]) listener();
    },
  };
}

const SHOWN = (notation: string): boolean => notation !== "board" && notation !== "markdown";

function setup(
  path: string,
  listed: readonly string[] | undefined,
  productOpts: Parameters<typeof product>[1] = {},
  server?: () => readonly string[],
) {
  const log: Log = [];
  const linked = linkedFiles(log);
  const editors = product(log, productOpts);
  const models = modelDirectory(listed, server);
  const layer = boardVisibility();
  const syncErrors: string[] = [];
  const deps: OpenModelDeps = {
    ctx: {
      repo: "acme/models",
      onSyncError: (message) => void syncErrors.push(message),
      models: models.dir,
      visibility: layer.visibility,
    },
    linkedFiles: linked.files,
    product: editors.mount,
    paths: modelPathsOf(models.dir, SHOWN),
    texts: createModelTexts(),
    log: (line) => void log.push(`log ${line}`),
  };
  const node = nodeContext(path);
  const editor = openModel(node.context, deps);
  return { log, linked, editors, models, layer, node, editor, deps, syncErrors };
}

const stateOf = (element: HTMLElement): { state: string | undefined; text: string | null | undefined } => ({
  state: element.dataset.modelState,
  text: element.querySelector(".board-model-state")?.textContent,
});

test("a node opens its model's room once the shell lists the path, and mounts the product editor once it synced", async () => {
  const path = "processes/order.bpmn";
  const { log, linked, editors, models, node, editor, syncErrors } = setup(path, undefined, { fitInsets: true });
  await flush();
  assert.deepEqual(log, [], "no room while the list loads: a room of no model would be a new file");
  assert.deepEqual(stateOf(node.element), { state: "loading", text: MODEL_STATE_TEXT.loading });
  assert.equal(node.element.dataset.embed, "designiq");
  const host = node.element.querySelector<HTMLElement>(".board-model-editor");
  assert.ok(host?.classList.contains("bpmn-canvas"), "the host carries the product's canvas class");

  models.set([path]);
  assert.deepEqual(log, [`open ${path}`]);
  linked.sessions[0]?.synced.resolve();
  await flush();
  assert.deepEqual(log, [`open ${path}`, `mount ${path}`]);
  const [mounted] = editors.editors;
  assert.ok(mounted);
  assert.equal(mounted.host, host);
  const { ctx } = mounted;
  const session = linked.sessions[0]?.session;
  assert.equal(ctx.ytext, session?.content);
  assert.equal(ctx.doc, session?.doc);
  assert.equal(ctx.docPath, path);
  assert.equal(ctx.repo, "acme/models");
  assert.equal(ctx.sync?.awareness, null);
  assert.deepEqual(ctx.sync?.fitInsets?.(), { top: 1, right: 2, bottom: 3, left: 4 });
  ctx.onSyncError("the write was refused");
  assert.deepEqual(syncErrors, [`${path}: the write was refused`]);

  let ready = false;
  void editor.ready.then(() => (ready = true));
  ctx.sync?.onImported?.();
  assert.deepEqual(stateOf(node.element), { state: "ready", text: "" });
  assert.equal(node.element.dataset.modelDrawn, "true");
  await Promise.resolve();
  assert.equal(ready, false, "ready waits one task for a Miragon editor's first fit");
  await flush();
  assert.equal(ready, true);
});

test("a node whose file is gone says so and keeps its place, and opens once the list has it again", async () => {
  const path = "processes/order.bpmn";
  const { log, linked, models, node } = setup(path, ["processes/other.bpmn"]);
  await flush();
  assert.deepEqual(log, []);
  assert.deepEqual(stateOf(node.element), { state: "gone", text: MODEL_STATE_TEXT.gone });
  models.set([path]);
  assert.deepEqual(log, [`open ${path}`]);
  assert.equal(stateOf(node.element).state, "loading");
  linked.sessions[0]?.synced.resolve();
  await flush();

  // deleted while open: the last canvas stays, under the line, and takes no input
  models.set([]);
  assert.equal(stateOf(node.element).state, "gone");
  assert.equal(node.element.querySelector<HTMLElement>(".board-model-editor")?.inert, true);
  models.set([path]);
  assert.equal(node.element.querySelector<HTMLElement>(".board-model-editor")?.inert, false);
  assert.equal(stateOf(node.element).state, "loading", "back, and not drawn yet");
  assert.deepEqual(log, [`open ${path}`, `mount ${path}`], "the open session stays: no second room");
});

test("a node follows a model that moved while the board was closed, and one the Live Host says moved", async () => {
  const closedBoard = setup("processes/order.bpmn", ["archive/order.bpmn"]);
  await flush();
  assert.deepEqual(closedBoard.node.relocated, ["archive/order.bpmn"]);
  assert.deepEqual(closedBoard.log, [], "no room for a path that is no model");
  // where the shell can load its list anew, a list loaded after the node asked confirms the move
  const confirmed = setup("processes/order.bpmn", ["archive/order.bpmn"], {}, () => ["archive/order.bpmn"]);
  await flush();
  assert.deepEqual(stateOf(confirmed.node.element).state, "loading", "while the list loads anew");
  assert.deepEqual(confirmed.node.relocated, []);
  await flush();
  await flush();
  assert.deepEqual(confirmed.node.relocated, ["archive/order.bpmn"]);
  assert.equal(confirmed.models.refreshes(), 1);

  const path = "processes/order.bpmn";
  const { log, linked, models, node, editor, deps } = setup(path, [path], {}, () => [path]);
  await flush();
  linked.sessions[0]?.synced.resolve();
  await flush();
  linked.sessions[0]?.moved("archive/order.bpmn");
  assert.deepEqual(node.relocated, ["archive/order.bpmn"]);
  // the room is closed right after the notice: no failure
  linked.sessions[0]?.docClosed();
  assert.equal(stateOf(node.element).state, "loading");
  // the board destroys this editor and opens one at the new path, which the stale list lacks
  editor.destroy();
  await editor.closed;
  const next = nodeContext("archive/order.bpmn");
  openModel(next.context, deps);
  await flush();
  assert.deepEqual(log.slice(-1), ["open archive/order.bpmn"]);
  assert.deepEqual(next.relocated, [], "never back to the path the move left");
  assert.equal(models.refreshes(), 0, "a move the Live Host told needs no list");
});

/**
 * One client of a shared board with one model node: its own model list (`list`, loaded anew from
 * `server`), a node opened at the node's current path as the board opens it on every change of
 * the path, and a relocation written into the shared board, for every client
 */
function boardClient(
  name: string,
  list: readonly string[],
  server: () => readonly string[],
  board: { file: string; writes: string[] },
) {
  const log: Log = [];
  const linked = linkedFiles(log);
  const models = modelDirectory(list, server);
  const deps: OpenModelDeps = {
    ctx: { repo: "acme/models", onSyncError: () => undefined, models: models.dir },
    linkedFiles: linked.files,
    product: product(log).mount,
    paths: modelPathsOf(models.dir, SHOWN),
    texts: createModelTexts(),
    log: (line) => void log.push(`log ${line}`),
  };
  /** what the last node said before it went */
  let said: string | undefined;
  return {
    log,
    models,
    state: () => said,
    /** the board shows the node: it opens its editor, and destroys it once the node's path changed */
    async show(): Promise<void> {
      const from = board.file;
      const node = nodeContext(from);
      const editor = openModel(node.context, deps);
      for (let i = 0; i < 4; i++) await flush();
      said = stateOf(node.element).state;
      const [to] = node.relocated;
      if (to !== undefined) {
        board.writes.push(`${name}: ${from} -> ${to}`);
        board.file = to;
      }
      editor.destroy();
      await editor.closed;
    },
  };
}

test("a model list from before a move never sends a node back to the path the move left", async () => {
  // processes/order.bpmn was moved to archive/order.bpmn, and the Live Host rewrote the board
  const server = (): readonly string[] => ["archive/order.bpmn"];
  const board = { file: "archive/order.bpmn", writes: [] as string[] };
  // a client whose list was loaded before the move, and one whose list is fresh
  const stale = boardClient("stale", ["processes/order.bpmn"], server, board);
  const fresh = boardClient("fresh", ["archive/order.bpmn"], server, board);
  for (let round = 0; round < 3; round++) {
    await stale.show();
    await fresh.show();
  }
  assert.deepEqual(board.writes, [], "nobody writes the board");
  assert.equal(board.file, "archive/order.bpmn");
  assert.equal(stale.models.refreshes(), 1, "the stale client loaded its list anew, once");
  assert.ok(!stale.log.includes("open processes/order.bpmn"), "never a room of the path the move left");
  assert.deepEqual(
    stale.log.filter((line) => line.startsWith("open ")),
    ["open archive/order.bpmn", "open archive/order.bpmn", "open archive/order.bpmn"],
  );
});

test("two clients whose lists stay apart move a node once each, never back and forth", async () => {
  // a list that loads anew as it was: the server it comes from has not caught up
  const board = { file: "archive/order.bpmn", writes: [] as string[] };
  const behind = boardClient("behind", ["processes/order.bpmn"], () => ["processes/order.bpmn"], board);
  const ahead = boardClient("ahead", ["archive/order.bpmn"], () => ["archive/order.bpmn"], board);
  for (let round = 0; round < 4; round++) {
    await behind.show();
    await ahead.show();
  }
  assert.deepEqual(board.writes, [
    "behind: archive/order.bpmn -> processes/order.bpmn",
    "ahead: processes/order.bpmn -> archive/order.bpmn",
  ]);
  assert.equal(behind.state(), "gone", "the second time, the node keeps its place and says its file is not there");
});

test("the nodes of a board that ask at once share one load of the list", async () => {
  const log: Log = [];
  const models = modelDirectory(["archive/order.bpmn", "archive/route.bpmn"], () => [
    "archive/order.bpmn",
    "archive/route.bpmn",
  ]);
  const deps: OpenModelDeps = {
    ctx: { repo: "acme/models", onSyncError: () => undefined, models: models.dir },
    linkedFiles: linkedFiles(log).files,
    product: product(log).mount,
    paths: modelPathsOf(models.dir, SHOWN),
    texts: createModelTexts(),
  };
  const order = nodeContext("processes/order.bpmn", "n_order");
  const route = nodeContext("processes/route.bpmn", "n_route");
  openModel(order.context, deps);
  openModel(route.context, deps);
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(models.refreshes(), 1);
  assert.deepEqual([...order.relocated, ...route.relocated], ["archive/order.bpmn", "archive/route.bpmn"]);
});

test("a node at a moved model's new path waits for the shell's list where the shell opens listed models only", async () => {
  const path = "processes/order.bpmn";
  const { log, linked, models, deps } = setup(path, [path]);
  await flush();
  linked.sessions[0]?.synced.resolve();
  await flush();
  linked.sessions[0]?.moved("archive/order.bpmn");
  // the shell's own rule (lib/linked-files.ts): a path its list lacks is refused
  const refusing: OpenModelDeps = {
    ...deps,
    linkedFiles: {
      ...deps.linkedFiles,
      open(open) {
        if (!models.dir.paths()?.has(open)) throw new Error(`${open} is not a model of this repository`);
        return deps.linkedFiles.open(open);
      },
    },
  };
  const next = nodeContext("archive/order.bpmn");
  const editor = openModel(next.context, refusing);
  await flush();
  assert.deepEqual(stateOf(next.element), { state: "loading", text: MODEL_STATE_TEXT.loading }, "no failure");
  assert.deepEqual(next.relocated, []);
  let failed = false;
  editor.ready.catch(() => (failed = true));
  // the list catches up: the node opens
  models.set(["archive/order.bpmn"]);
  assert.deepEqual(log.slice(-1), ["open archive/order.bpmn"]);
  await flush();
  assert.equal(failed, false);
});

test("a node takes the keys and announces the person only while it is armed and its board is on screen", async () => {
  const path = "processes/order.bpmn";
  const { log, linked, editors, layer, node } = setup(path, [path]);
  await flush();
  linked.sessions[0]?.synced.resolve();
  await flush();
  const ctx = editors.editors[0]?.ctx;
  const fake = linked.sessions[0];
  assert.ok(ctx && fake);
  // a preview is told nothing when the board hides and shows again: nobody is announced
  layer.set(false);
  layer.set(true);
  assert.equal(fake.user, undefined);
  let told = 0;
  ctx.visibility?.onChange(() => told++);
  assert.equal(ctx.visibility?.visible(), false, "a preview takes no keys");
  ctx.presence?.setLocal({ cursor: { x: 1, y: 2 }, selection: ["a"] });
  assert.equal(fake.canvas, null, "a preview publishes no cursor");
  assert.equal(fake.user, undefined, "nobody is announced in the model's room");

  node.arm(true);
  assert.equal(ctx.visibility?.visible(), true);
  assert.equal(told, 1);
  assert.equal(fake.user, "me");
  ctx.presence?.setLocal({ cursor: { x: 1, y: 2 }, selection: ["a"] });
  assert.deepEqual(fake.canvas, { cursor: { x: 1, y: 2 }, selection: ["a"] });

  layer.set(false);
  assert.equal(ctx.visibility?.visible(), false, "the source view hides the board: its editors leave the keys");
  assert.equal(told, 2);
  assert.equal(fake.user, null, "and the person is no longer announced in the model's room");
  assert.equal(fake.canvas, null, "nor their cursor");
  layer.set(true);
  assert.equal(told, 3);
  assert.equal(fake.user, "me", "the board shows again: announced again");

  log.length = 0;
  node.arm(false);
  assert.deepEqual(log, [`canvas ${path} null`, `present ${path} false`], "the cursor goes before the announcement");
  assert.equal(ctx.visibility?.visible(), false);
});

test("a node armed before its room synced is announced once it did, and its editor takes the focus it asked for", async () => {
  const path = "processes/order.bpmn";
  const { linked, editors, node, editor } = setup(path, [path]);
  await flush();
  node.arm(true);
  editor.focus?.();
  const host = node.element.querySelector(".board-model-editor");
  assert.equal(document.activeElement, host, "the host takes the keys while the editor loads");
  linked.sessions[0]?.synced.resolve();
  await flush();
  assert.equal(linked.sessions[0]?.user, "me");
  assert.equal(editors.editors[0]?.focused, 1);
});

test("the end: the editor first, then its session; a session or an editor still on its way goes when it arrives", async () => {
  const path = "processes/order.bpmn";
  // mounted
  const done = setup(path, [path]);
  await flush();
  done.linked.sessions[0]?.synced.resolve();
  await flush();
  let doneClosed = false;
  void done.editor.closed.then(() => (doneClosed = true));
  done.editor.destroy();
  done.editor.destroy();
  // the board called release() right before: what it committed is exported a few microtasks later
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(doneClosed, false);
  assert.ok(!done.log.includes(`destroy editor ${path}`), "the editor stays bound until the next task");
  assert.equal(done.linked.sessions[0]?.destroyed, false, "and its session open");
  await done.editor.closed;
  assert.deepEqual(done.log.slice(-2), [`destroy editor ${path}`, `destroy session ${path}`]);
  assert.equal(done.node.element.children.length, 0, "the node's element is as the board gave it");
  assert.equal(done.node.element.dataset.embed, undefined);

  // still syncing: the session goes at once, and no editor is mounted
  const syncing = setup(path, [path]);
  await flush();
  syncing.editor.destroy();
  await syncing.editor.closed;
  assert.deepEqual(syncing.log, [`open ${path}`, `destroy session ${path}`]);
  syncing.linked.sessions[0]?.synced.resolve();
  await flush();
  assert.deepEqual(syncing.log, [`open ${path}`, `destroy session ${path}`]);

  // still mounting: nothing goes until the editor is there, then the editor and then its session
  const mounting = setup(path, [path], { hold: true });
  await flush();
  mounting.linked.sessions[0]?.synced.resolve();
  await flush();
  let closed = false;
  void mounting.editor.closed.then(() => (closed = true));
  mounting.editor.destroy();
  await flush();
  assert.equal(closed, false);
  assert.deepEqual(mounting.log, [`open ${path}`, `mount ${path}`]);
  mounting.editors.pending[0]?.resolve();
  await mounting.editor.closed;
  assert.deepEqual(mounting.log, [
    `open ${path}`,
    `mount ${path}`,
    `destroy editor ${path}`,
    `destroy session ${path}`,
  ]);
});

test("a node says when its file could not be opened or shown, and asks again when the list changes", async () => {
  const path = "processes/order.bpmn";
  const { log, linked, editors, models, node, editor } = setup(path, [path]);
  await flush();
  linked.sessions[0]?.synced.reject(new Error("auth failed: permission-denied"));
  await flush();
  await assert.rejects(editor.ready, /permission-denied/);
  assert.deepEqual(stateOf(node.element), {
    state: "failed",
    text: `${MODEL_STATE_TEXT.failed} auth failed: permission-denied`,
  });
  assert.deepEqual(log, [`open ${path}`, `destroy session ${path}`]);

  // the list changes and has the path: one more try
  models.set([path, "processes/new.bpmn"]);
  assert.deepEqual(log.slice(-1), [`open ${path}`]);
  linked.sessions[1]?.synced.resolve();
  await flush();
  const ctx = editors.editors[0]?.ctx;
  assert.ok(ctx);

  // the text cannot be drawn: the line says so, with the editor's reason for whoever repairs it
  ctx.onImportFailed("not well-formed");
  assert.equal(stateOf(node.element).state, "invalid");
  assert.equal(node.element.querySelector(".board-model-state")?.getAttribute("title"), "not well-formed");
  ctx.sync?.onImported?.();
  assert.equal(stateOf(node.element).state, "ready");
  ctx.sync?.onUnrenderable?.("a merge is not renderable");
  assert.equal(stateOf(node.element).state, "invalid");
  assert.equal(node.element.dataset.modelDrawn, "true", "the last canvas stays in sight below the line");
  ctx.sync?.onUnrenderable?.(null);
  assert.equal(stateOf(node.element).state, "ready");

  // the Live Host closes the room: said, and the editor and the session go
  linked.sessions[1]?.docClosed();
  assert.equal(stateOf(node.element).state, "failed");
  assert.deepEqual(log.slice(-2), [`destroy editor ${path}`, `destroy session ${path}`]);
  assert.equal(node.element.dataset.modelDrawn, undefined);
});

test("a room closed while its editor mounts: the node says it failed, whatever the editor draws meanwhile", async () => {
  const path = "processes/order.bpmn";
  const { log, linked, editors, node, editor } = setup(path, [path], { hold: true });
  await flush();
  linked.sessions[0]?.synced.resolve();
  await flush();
  assert.deepEqual(log, [`open ${path}`, `mount ${path}`]);
  linked.sessions[0]?.docClosed();
  const failed = {
    state: "failed",
    text: `${MODEL_STATE_TEXT.failed} the Live Host closed this model's live document`,
  };
  assert.deepEqual(stateOf(node.element), failed);
  await assert.rejects(editor.ready, /closed this model's live document/);
  // the editor's first import finishes inside its mount (a Miragon editor's import awaits nothing)
  const ctx = editors.editors[0]?.ctx;
  assert.ok(ctx);
  ctx.sync?.onImported?.();
  ctx.onImportFailed("not well-formed");
  ctx.sync?.onUnrenderable?.("a merge is not renderable");
  ctx.sync?.onUnrenderable?.(null);
  assert.deepEqual(stateOf(node.element), failed);
  editors.pending[0]?.resolve();
  await flush();
  assert.deepEqual(log.slice(-2), [`destroy editor ${path}`, `destroy session ${path}`]);
  assert.deepEqual(stateOf(node.element), failed, "the node still says why it shows nothing");
  assert.equal(node.element.querySelector<HTMLElement>(".board-model-state")?.hidden, false);
  assert.equal(node.element.dataset.modelDrawn, undefined);
});

test("the release touches the editor only once it is there", async () => {
  const path = "processes/order.bpmn";
  const { linked, node, editor } = setup(path, [path]);
  let escapes = 0;
  const onKeyup = (): void => void escapes++;
  document.addEventListener("keyup", onKeyup);
  editor.release();
  assert.equal(escapes, 0);
  await flush();
  linked.sessions[0]?.synced.resolve();
  await flush();
  const host = node.element.querySelector<HTMLElement>(".board-model-editor");
  host?.focus();
  editor.release();
  assert.equal(escapes, 1);
  assert.notEqual(document.activeElement, host);
  document.removeEventListener("keyup", onKeyup);
});

// ── the host ─────────────────────────────────────────────────────────────────

test("the host opens an editor for a shown notation and none for a board, a document or without linked files", async () => {
  const log: Log = [];
  const linked = linkedFiles(log);
  const held = product(log, { hold: true });
  const plugins: Record<string, WebNotationPlugin> = {
    bpmn: { id: "bpmn", canvasClassName: "bpmn-canvas", mountEditor: (host, ctx) => held.mount.mount(host, ctx) },
    markdown: { id: "markdown", canvasClassName: "markdown-canvas", mountEditor: () => Promise.reject(new Error("x")) },
    board: { id: "board", canvasClassName: "board-canvas", mountEditor: () => Promise.reject(new Error("x")) },
  };
  const models = modelDirectory(["processes/order.bpmn", "docs/a.md", "plan.board"]);
  const ctx = {
    repo: "acme/models",
    onSyncError: () => undefined,
    models: models.dir,
    linkedFiles: linked.files,
  } as unknown as EditorContext;
  const host = createBoardHost(ctx, (id) => plugins[id]);
  assert.deepEqual(host.models?.list(), ["processes/order.bpmn"], "the picker offers what a node can show");
  assert.equal(host.models?.open(nodeContext("docs/a.md").context), undefined);
  assert.equal(host.models?.open(nodeContext("plan.board").context), undefined);
  assert.equal(host.presence, undefined, "no presence without the shell's");
  const bpmn = host.models?.open(nodeContext("processes/order.bpmn").context);
  assert.ok(bpmn && !(bpmn instanceof Promise));
  await flush();
  linked.sessions[0]?.synced.resolve();
  await flush();
  // the board destroyed its editors while one was still mounting: the host's end waits for it
  bpmn.destroy();
  let closed = false;
  void host.whenClosed().then(() => (closed = true));
  await flush();
  assert.equal(closed, false);
  held.pending[0]?.resolve();
  await host.whenClosed();
  assert.deepEqual(log.slice(-2), ["destroy editor processes/order.bpmn", "destroy session processes/order.bpmn"]);
  host.destroy();

  const without = createBoardHost({ ...ctx, linkedFiles: undefined }, (id) => plugins[id]);
  assert.equal(without.models?.open(nodeContext("processes/order.bpmn").context), undefined);
  without.destroy();
});
