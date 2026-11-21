/**
 * The board as designIQ mounts it (src/notations/board, through the plugin registry), with the
 * REAL product editors in its model nodes: bpmn-js, dmn-js and two Miragon renderers (Wardley
 * Maps, Team Topologies), each on a live session of its model's own. The shell's linked files
 * are a fake over in-memory Y.Docs: every session is a replica of its room's document, updated
 * both ways, as a sync provider keeps it; no server runs.
 *
 * The sessions come through the shell's own linked files (lib/linked-files.ts) over that fake.
 *
 * What it holds: a preview shows none of its editor's chrome and keeps the bpmn.io mark; a
 * double-click arms a node at board zoom 1 in the board's layer; an edit there writes that
 * model's text and nothing of the board; Done releases (no selection, no focus left inside); two
 * nodes on one file; a node follows its model's moved notice; only the armed editor acts on the
 * chrome keys; a label or a decision-table cell still open in the armed editor when the board
 * goes reaches the model's room; and the end: every editor before its session, every session
 * before `mounted.unmounted`, and the shell's linked socket after it. No case may leave a window
 * error, an unhandled rejection or a console.error behind.
 */
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import "dmn-js/dist/assets/dmn-js-shared.css";
import "dmn-js/dist/assets/dmn-js-drd.css";
import "dmn-js/dist/assets/dmn-js-decision-table.css";
import "dmn-js/dist/assets/dmn-js-decision-table-controls.css";
import "dmn-js/dist/assets/dmn-js-literal-expression.css";
import "dmn-js/dist/assets/dmn-font/css/dmn.css";
import "@emaarco/dmn-js-simulation/assets/dmn-js-simulation.css";
import "../../src/index.css";
// the engines the board loads behind import(), here up front: Vite optimizes their dependencies
// when the file loads and not in the middle of a case, which would reload the page under it
import "../../src/notations/board/editor.ts";
import "../../src/notations/bpmn-editor.ts";
import "../../src/notations/dmn-editor.ts";

import { CONTENT_KEY, movedNotice, parseMovedNotice } from "@designiq/contracts/live";
import type { LiveSession, MovedNotice, PresenceUser } from "@designiq/live-client";
import { readSnapshot, reconcileSnapshot } from "@designiq/live-client/structured";
import { docCodecFor } from "@designiq/notations/codecs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import * as Y from "yjs";

import credit from "../../../../process-documentation/processes/credit-limit-check.dmn?raw";
import order from "../../../../process-documentation/processes/order-to-cash.bpmn?raw";
import { linkedFiles, type ShellLinkedFiles } from "../../src/lib/linked-files.ts";
import { boardPlugin } from "../../src/notations/board/plugin.ts";
import { paletteBottomIn } from "../../src/notations/miragon/editor.ts";
import {
  type EditorContext,
  type LinkedFiles,
  type MountedEditor,
  type WebNotationPlugin,
  webPlugin,
} from "../../src/notations/registry.ts";
import onlineShop from "./fixtures/team-topology/online-shop.tt?raw";
import teaShop from "./fixtures/wardley/tea-shop.wmap?raw";

/** a case mounts up to four real editors, the first one of a run loads their chunks */
const CASE_MS = 60_000;

const ORDER = "processes/order-to-cash.bpmn";
const CREDIT = "processes/credit-limit-check.dmn";
const TEA = "maps/tea-shop.wmap";
const SHOP = "teams/online-shop.tt";
const FILES: Readonly<Record<string, string>> = {
  [ORDER]: order,
  [CREDIT]: credit,
  [TEA]: teaShop,
  [SHOP]: onlineShop,
};

const codec = docCodecFor("board");
if (!codec) throw new Error("the board has no codec");

/** a board text: the header, then one model node per path, two per row */
function boardOf(nodes: ReadonlyArray<{ id: string; file: string }>): string {
  const lines = [`{"format":"structured-model","meta":{"title":"Plan","version":1},"version":1}`];
  nodes.forEach(({ id, file }, i) => {
    const [x, y] = [(i % 2) * 900, Math.floor(i / 2) * 640];
    lines.push(JSON.stringify({ file, height: 540, id, kind: "node", type: "model", width: 800, x, y, z: `a${i}` }));
  });
  return `${lines.join("\n")}\n`;
}

const ME: PresenceUser = { name: "Ada", color: "#335de5" };

/** what happened, in order: the end's order is read from it */
const events: string[] = [];

interface FakeRoom {
  /** the room's own document, as the Live Host holds it */
  server: Y.Doc;
  text(): string;
}

interface FakeSession {
  path: string;
  doc: Y.Doc;
  destroyed: boolean;
  user: PresenceUser | null | undefined;
  moved(to: string): void;
}

/**
 * The shell's linked files (lib/linked-files.ts) over in-memory rooms: each session a replica of
 * its room's document, the socket group a fake whose end is written down
 */
function fakeLinkedFiles(files: Readonly<Record<string, string>>, listed: () => ReadonlySet<string>) {
  const rooms = new Map<string, FakeRoom>();
  const room = (path: string): FakeRoom => {
    let found = rooms.get(path);
    if (!found) {
      const server = new Y.Doc();
      server.getText(CONTENT_KEY).insert(0, files[path] ?? "");
      found = { server, text: () => server.getText(CONTENT_KEY).toString() };
      rooms.set(path, found);
    }
    return found;
  };
  const sessions: FakeSession[] = [];
  const group: Pick<LinkedFiles, "open"> = {
    open(path) {
      events.push(`open ${path}`);
      const { server } = room(path);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(server), server);
      const up = (update: Uint8Array, origin: unknown): void => {
        if (origin !== server) Y.applyUpdate(server, update, doc);
      };
      const down = (update: Uint8Array, origin: unknown): void => {
        if (origin !== doc) Y.applyUpdate(doc, update, server);
      };
      doc.on("update", up);
      server.on("update", down);
      const movedListeners = new Set<(notice: MovedNotice) => void>();
      const fake: FakeSession = {
        path,
        doc,
        destroyed: false,
        user: undefined,
        moved(to) {
          for (const listener of [...movedListeners])
            listener(parseMovedNotice(movedNotice("acme/models", to, "Grace"))!);
        },
      };
      sessions.push(fake);
      const session = {
        doc,
        content: doc.getText(CONTENT_KEY),
        awareness: null,
        onSynced: () => () => undefined,
        onDisconnect: () => () => undefined,
        onDocClose: () => () => undefined,
        onMoved(listener: (notice: MovedNotice) => void) {
          movedListeners.add(listener);
          return () => void movedListeners.delete(listener);
        },
        whenSynced: () => Promise.resolve(),
        setUser: (user: PresenceUser | null) => void (fake.user = user),
        setCanvasPresence: () => undefined,
        onPresence: () => () => undefined,
        onAwarenessStates(listener: (peers: never[]) => void) {
          listener([]);
          return () => undefined;
        },
        destroy() {
          if (fake.destroyed) return;
          fake.destroyed = true;
          events.push(`destroy session ${path}`);
          doc.off("update", up);
          server.off("update", down);
        },
      } as unknown as LiveSession;
      (fake as FakeSession & { session: LiveSession }).session = session;
      return session;
    },
  };
  const shell = linkedFiles({
    listed,
    // a room is named by its path here
    room: (path) => path,
    openGroup: () => ({
      open: (path) => group.open(path),
      destroy: () => void events.push("destroy the linked socket"),
    }),
    user: ME,
  });
  return { shell, sessions, room };
}

interface MountedBoard {
  element: HTMLElement;
  mounted: MountedEditor;
  /** the shell's linked files: closed as live-editor.tsx closes them, after the editor's destroy() */
  shell: ShellLinkedFiles;
  doc: Y.Doc;
  sessions: FakeSession[];
  room(path: string): FakeRoom;
  setModels(paths: readonly string[]): void;
  /** the node's wrapper in the board */
  node(id: string): HTMLElement;
  /** the element the node's editor lives in, in the node or in the layer */
  engine(id: string): HTMLElement;
  boardText(): string;
}

let current: MountedBoard | undefined;

async function mountBoard(
  nodes: ReadonlyArray<{ id: string; file: string }>,
  plugin: WebNotationPlugin | undefined = webPlugin("board"),
  /** the nodes that show their model before the case goes on: all of them unless one is held */
  drawn = nodes.length,
): Promise<MountedBoard> {
  // the shell's canvas host inside the SPA's #root, whose rules reach the editors
  const root = document.createElement("div");
  root.id = "root";
  root.style.cssText = "position: relative; width: 1200px; height: 800px";
  const element = document.createElement("div");
  element.className = "board-canvas absolute inset-0";
  root.append(element);
  document.body.append(root);

  const doc = new Y.Doc();
  reconcileSnapshot(doc, codec!.decode(boardOf(nodes)));
  let models: ReadonlySet<string> = new Set(Object.keys(FILES));
  const fake = fakeLinkedFiles(FILES, () => models);
  const listeners = new Set<() => void>();
  const ctx: EditorContext = {
    ytext: doc.getText(CONTENT_KEY),
    doc,
    repo: "acme/models",
    docPath: "boards/plan.board",
    onSyncError: (message) => console.error(`sync error: ${message}`),
    onImportFailed: (message) => console.error(`import failed: ${message}`),
    onBadgeClick: () => undefined,
    onSelectionChanged: () => undefined,
    models: {
      paths: () => models,
      onChange(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    visibility: { visible: () => true, onChange: () => () => undefined },
    linkedFiles: fake.shell.files,
  };
  if (!plugin?.mountEditor) throw new Error("the board has no editor plugin");
  const mounted = await plugin.mountEditor(element, ctx);
  const board: MountedBoard = {
    element,
    mounted,
    shell: fake.shell,
    doc,
    sessions: fake.sessions,
    room: fake.room,
    setModels(paths) {
      models = new Set(paths);
      for (const listener of [...listeners]) listener();
    },
    node(id) {
      const wrapper = element.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
      if (!wrapper) throw new Error(`the board shows no node ${id}`);
      return wrapper;
    },
    engine(id) {
      const inNode = element.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] .board-engine`);
      if (inNode) return inNode;
      const layered = [...element.querySelectorAll<HTMLElement>(".board-overlay-layer > .board-engine")];
      if (layered.length === 1 && layered[0]) return layered[0];
      throw new Error(`no editor element for ${id}`);
    },
    boardText: () => codec!.encode(readSnapshot(doc)),
  };
  current = board;
  // every model node shows its model
  await expect
    .poll(() => element.querySelectorAll('.board-engine[data-model-state="ready"]').length, { timeout: 20_000 })
    .toBe(drawn);
  await settle();
  return board;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
/** two frames and 50 ms: the editors' and the board's own layout after an input */
async function settle(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** the board's current scale of an element: client px per layout px */
const scaleOf = (element: HTMLElement): number => element.getBoundingClientRect().width / element.offsetWidth;

async function arm(board: MountedBoard, id: string): Promise<HTMLElement> {
  await userEvent.dblClick(board.node(id));
  await expect
    .poll(() => board.element.querySelectorAll('.board-overlay-layer > .board-engine[data-armed="true"]').length)
    .toBe(1);
  await settle();
  return board.engine(id);
}

/** the shell's end of the board (live-editor.tsx): the editor's destroy(), then the linked files' close */
async function unmount(board: MountedBoard): Promise<void> {
  board.mounted.destroy();
  board.shell.close(board.mounted.unmounted);
  await board.mounted.unmounted;
  board.element.parentElement?.remove();
}

async function done(board: MountedBoard): Promise<void> {
  const control = board.element.querySelector<HTMLElement>("[data-board-done]");
  if (!control) throw new Error("the board shows no Done control");
  await userEvent.click(control);
  await expect.poll(() => board.element.querySelectorAll(".board-overlay-layer > .board-engine").length).toBe(0);
  await settle();
}

/** the transform of a diagram-js canvas's viewport: what a zoom changes */
const viewportOf = (engine: HTMLElement): string | null | undefined =>
  engine.querySelector(".djs-container svg .viewport")?.getAttribute("transform");

/** a chrome key as the document hears it, aimed at whatever has the focus */
function chromeKey(key: string): void {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

/** what the page reported that a case must not leave behind */
const complaints: string[] = [];
const onError = (event: ErrorEvent): void => void complaints.push(`window error: ${event.message}`);
const onRejection = (event: PromiseRejectionEvent): void =>
  void complaints.push(`unhandled rejection: ${String(event.reason)}`);

beforeEach(() => {
  complaints.length = 0;
  events.length = 0;
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    complaints.push(`console.error: ${args.map(String).join(" ")}`);
  });
});

afterEach(async () => {
  const board = current;
  current = undefined;
  if (board) await unmount(board);
  await settle();
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onRejection);
  vi.restoreAllMocks();
  expect(complaints).toEqual([]);
});

/** chrome a preview must not show: what floats over an editor's canvas, by the editors' class names */
const CHROME = [
  ".djs-palette",
  ".djs-context-pad",
  ".djs-popup-parent",
  ".djs-hover-tooltip",
  ".djs-direct-editing-parent",
  ".djs-search-container",
  ".dmn-definitions",
  ".dmn-sim-decision-requirements-diagram-panel",
  ".wardley-explore-hint",
].join(", ");

/** what may show in a preview beside the diagram itself: its overlays, the bpmn.io mark, BPMN's breadcrumbs */
const PICTURE = ".djs-overlay-container, .bjs-powered-by, .bjs-breadcrumbs";

const shown = (element: Element): boolean => {
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
};

/** every element of an editor that lies over its canvas, outside the svg and the picture, and shows */
function chromeShownIn(engine: HTMLElement): string[] {
  const editor = engine.querySelector(".board-model-editor");
  if (!editor) return ["no editor host"];
  return [...editor.querySelectorAll<HTMLElement>("*")]
    .filter((one) => !(one instanceof SVGElement) && !one.closest(PICTURE))
    .filter((one) => ["absolute", "fixed"].includes(getComputedStyle(one).position) && shown(one))
    .map((one) => `${one.localName}.${[...one.classList].join(".")}`);
}

test(
  "a preview shows none of its editor's chrome and keeps the bpmn.io mark",
  async () => {
    const board = await mountBoard([
      { id: "n_order", file: ORDER },
      { id: "n_credit", file: CREDIT },
      { id: "n_tea", file: TEA },
      { id: "n_shop", file: SHOP },
    ]);
    for (const id of ["n_order", "n_credit", "n_tea", "n_shop"]) {
      const engine = board.engine(id);
      expect(engine.dataset.armed, id).toBe("false");
      expect(scaleOf(engine), `${id}: a scaled preview`).toBeLessThan(1);
      expect(engine.querySelectorAll(".djs-container svg").length, `${id}: the diagram is drawn`).toBeGreaterThan(0);
      const chrome = [...engine.querySelectorAll(CHROME)];
      expect(chrome.length, `${id}: its palette is mounted, hidden`).toBeGreaterThan(0);
      expect(
        chrome.filter(shown).map((one) => one.className),
        id,
      ).toEqual([]);
      expect(chromeShownIn(engine), id).toEqual([]);
    }
    for (const id of ["n_order", "n_credit"]) {
      const mark = board.engine(id).querySelector(".bjs-powered-by");
      expect(mark && shown(mark), `${id}: the bpmn.io mark`).toBe(true);
    }
    // armed, the chrome is there again
    const armed = await arm(board, "n_order");
    expect(shown(armed.querySelector(".djs-palette")!)).toBe(true);
    await done(board);
  },
  CASE_MS,
);

test(
  "a double-click arms a node at board zoom 1 in the board's layer, and its edit writes the model's text only",
  async () => {
    const board = await mountBoard([
      { id: "n_order", file: ORDER },
      { id: "n_tea", file: TEA },
    ]);
    const before = board.boardText();
    const session = board.sessions.find((one) => one.path === ORDER);
    expect(session?.user, "a preview announces nobody").toBeUndefined();

    const engine = await arm(board, "n_order");
    expect(engine.parentElement?.classList.contains("board-overlay-layer")).toBe(true);
    expect(scaleOf(engine)).toBeCloseTo(1, 3);
    expect(session?.user).toEqual(ME);
    expect(engine.contains(document.activeElement), "the editor has the keys").toBe(true);

    // a real click selects a task, a real Delete removes it, in the model's own text
    const task = engine.querySelector<SVGGElement>('.djs-element[data-element-id="Task_validate_order"]');
    expect(task).not.toBeNull();
    await userEvent.click(task!);
    await expect.poll(() => engine.querySelectorAll(".djs-element.selected").length).toBe(1);
    await userEvent.keyboard("{Delete}");
    await expect
      .poll(() => board.room(ORDER).text().includes('id="Task_validate_order"'), { timeout: 5000 })
      .toBe(false);
    expect(board.boardText(), "nothing of the board changed").toBe(before);

    // Done: no selection, no focus inside, nobody announced any more
    const other = engine.querySelector<SVGGElement>('.djs-element[data-element-id="Task_fulfill_order"]');
    await userEvent.click(other!);
    await expect.poll(() => engine.querySelectorAll(".djs-element.selected").length).toBe(1);
    await done(board);
    const preview = board.engine("n_order");
    expect(preview.dataset.armed).toBe("false");
    expect(preview.querySelectorAll(".djs-element.selected").length).toBe(0);
    expect(preview.contains(document.activeElement)).toBe(false);
    expect(chromeShownIn(preview)).toEqual([]);
    expect(session?.user).toBeNull();
    expect(board.boardText()).toBe(before);
  },
  CASE_MS,
);

test(
  "two nodes on one file are two sessions of its room, and one draws what the other edits",
  async () => {
    const board = await mountBoard([
      { id: "n_one", file: ORDER },
      { id: "n_two", file: ORDER },
    ]);
    const sessions = board.sessions.filter((one) => one.path === ORDER);
    expect(sessions.length).toBe(2);
    expect(sessions[0]?.doc).not.toBe(sessions[1]?.doc);

    const engine = await arm(board, "n_one");
    await userEvent.click(engine.querySelector('.djs-element[data-element-id="Task_validate_order"]')!);
    await userEvent.keyboard("{Delete}");
    const twin = board.engine("n_two");
    await expect
      .poll(() => twin.querySelectorAll('.djs-element[data-element-id="Task_validate_order"]').length, {
        timeout: 5000,
      })
      .toBe(0);
    expect(sessions[1]?.doc.getText(CONTENT_KEY).toString()).toBe(board.room(ORDER).text());
    expect(sessions[1]?.user, "the twin announces nobody").toBeUndefined();
    await done(board);
  },
  CASE_MS,
);

test(
  "a node follows its model's moved notice, and opens it once the shell's list has the new path",
  async () => {
    const board = await mountBoard([
      { id: "n_order", file: ORDER },
      { id: "n_tea", file: TEA },
    ]);
    const moved = "archive/tea-shop.wmap";
    board.room(moved).server.getText(CONTENT_KEY).insert(0, teaShop);
    const old = board.sessions.find((one) => one.path === TEA);
    old?.moved(moved);
    await expect.poll(() => readSnapshot(board.doc).elements.n_tea?.file).toBe(moved);
    await expect.poll(() => old?.destroyed).toBe(true);
    // the shell opens listed models only, and its list does not have the new path yet: the node
    // waits, and never goes back to the path the model left
    await settle();
    expect(board.engine("n_tea").dataset.modelState).toBe("loading");
    expect(readSnapshot(board.doc).elements.n_tea?.file).toBe(moved);
    board.setModels([ORDER, moved, CREDIT, SHOP]);
    await expect
      .poll(() => board.sessions.filter((one) => one.path === moved && !one.destroyed).length, { timeout: 10_000 })
      .toBe(1);
    await expect.poll(() => board.engine("n_tea").dataset.modelState, { timeout: 10_000 }).toBe("ready");
    expect(readSnapshot(board.doc).elements.n_tea?.file).toBe(moved);
  },
  CASE_MS,
);

test(
  "only the armed editor acts on the chrome keys",
  async () => {
    const board = await mountBoard([
      { id: "n_order", file: ORDER },
      { id: "n_tea", file: TEA },
      { id: "n_shop", file: SHOP },
    ]);
    const views = (): Record<string, string | null | undefined> =>
      Object.fromEntries(["n_order", "n_tea", "n_shop"].map((id) => [id, viewportOf(board.engine(id))]));

    const resting = views();
    chromeKey("=");
    await settle();
    expect(views(), "no node armed: no editor zooms").toEqual(resting);

    await arm(board, "n_tea");
    const armedViews = views();
    chromeKey("=");
    await settle();
    const after = views();
    expect(after.n_tea).not.toBe(armedViews.n_tea);
    expect(after.n_order).toBe(armedViews.n_order);
    expect(after.n_shop).toBe(armedViews.n_shop);
    await done(board);

    await arm(board, "n_order");
    const bpmnArmed = views();
    chromeKey("-");
    await settle();
    const bpmnAfter = views();
    expect(bpmnAfter.n_order).not.toBe(bpmnArmed.n_order);
    expect(bpmnAfter.n_tea).toBe(bpmnArmed.n_tea);
    expect(bpmnAfter.n_shop).toBe(bpmnArmed.n_shop);
    await done(board);
  },
  CASE_MS,
);

test(
  "a label still open in the armed BPMN editor when the board goes reaches the model's room",
  async () => {
    const board = await mountBoard([
      { id: "n_order", file: ORDER },
      { id: "n_tea", file: TEA },
    ]);
    const engine = await arm(board, "n_order");
    await userEvent.dblClick(engine.querySelector('.djs-element[data-element-id="Task_validate_order"]')!);
    const box = (): HTMLElement | null => engine.querySelector<HTMLElement>(".djs-direct-editing-content");
    await expect.poll(() => box() !== null && shown(box()!)).toBe(true);
    await userEvent.keyboard("{Control>}a{/Control}Check the order");
    await expect.poll(() => box()?.textContent).toBe("Check the order");
    expect(board.room(ORDER).text(), "the label is still open").not.toContain('name="Check the order"');
    // the board goes while the node is armed: it releases the node (the label commits), then destroys it
    current = undefined;
    await unmount(board);
    expect(board.room(ORDER).text()).toContain('name="Check the order"');
  },
  CASE_MS,
);

test(
  "a decision-table cell edited in the armed DMN editor right before the board goes reaches the model's room",
  async () => {
    const board = await mountBoard([
      { id: "n_credit", file: CREDIT },
      { id: "n_tea", file: TEA },
    ]);
    const engine = await arm(board, "n_credit");
    // the DRD first: its drill-down opens the decision's table
    engine.querySelector(".drill-down-overlay")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const cell = (): HTMLElement | null =>
      engine.querySelector<HTMLElement>('td[data-element-id="LiteralExpression_blocked"] [contenteditable]');
    await expect.poll(() => cell() !== null).toBe(true);
    await userEvent.click(cell()!);
    // the editor closes the quote itself: the caret stays before it
    await userEvent.keyboard('{Control>}a{/Control}"decline');
    await expect.poll(() => board.room(CREDIT).text()).toContain('<text>"decline"</text>');
    // dmn-js's FEEL cell editor reports this in this dependency tree on its own page as well: not the board's
    for (let i = complaints.length - 1; i >= 0; i--) {
      if (complaints[i]?.includes("CodeMirror plugin crashed")) complaints.splice(i, 1);
    }
    // the last keystroke, and in the same task the board goes: dmn-js commits the cell, and its export is on its way
    document.execCommand("insertText", false, "d");
    current = undefined;
    await unmount(board);
    expect(board.room(CREDIT).text()).toContain('<text>"declined"</text>');
  },
  CASE_MS,
);

/**
 * The registry's own plugins, each editor's destroy() written down; the mount of `held` waits
 * for the returned release
 */
function recordingLookup(held?: string): { lookup: (id: string) => WebNotationPlugin | undefined; release(): void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const lookup = (id: string): WebNotationPlugin | undefined => {
    const plugin = webPlugin(id);
    const mountEditor = plugin?.mountEditor;
    if (!plugin || !mountEditor) return plugin;
    return {
      ...plugin,
      mountEditor: async (container, ctx) => {
        if (ctx.docPath === held) {
          events.push(`mount held ${ctx.docPath}`);
          await gate;
        }
        const editor = await mountEditor(container, ctx);
        return {
          ...editor,
          destroy: () => {
            events.push(`destroy editor ${ctx.docPath}`);
            editor.destroy();
          },
        };
      },
    };
  };
  return { lookup, release };
}

test(
  "the end: every editor before its session, every session before mounted.unmounted, the linked socket after it",
  async () => {
    const recording = recordingLookup().lookup;
    const board = await mountBoard(
      [
        { id: "n_order", file: ORDER },
        { id: "n_credit", file: CREDIT },
        { id: "n_tea", file: TEA },
      ],
      boardPlugin(recording),
    );
    await arm(board, "n_credit");
    current = undefined;
    events.length = 0;
    let unmounted = false;
    const settled = board.mounted.unmounted?.then(() => {
      unmounted = true;
      events.push("unmounted");
    });
    // the shell's cleanup (live-editor.tsx): the editor's destroy(), then the linked files' close
    board.mounted.destroy();
    board.shell.close(board.mounted.unmounted);
    expect(events, "destroy() returns before the editors go").toEqual([]);
    await settled;
    expect(unmounted).toBe(true);
    await expect.poll(() => events.includes("destroy the linked socket")).toBe(true);
    for (const path of [ORDER, CREDIT, TEA]) {
      const editor = events.indexOf(`destroy editor ${path}`);
      const session = events.indexOf(`destroy session ${path}`);
      expect(editor, path).toBeGreaterThanOrEqual(0);
      expect(session, `${path}: its session after its editor`).toBeGreaterThan(editor);
      expect(events.indexOf("unmounted"), `${path}: unmounted after its session`).toBeGreaterThan(session);
    }
    expect(events.indexOf("destroy the linked socket"), "the socket goes after the board unmounted").toBeGreaterThan(
      events.indexOf("unmounted"),
    );
    expect(events.filter((one) => one === "destroy the linked socket").length).toBe(1);
    expect(board.sessions.every((one) => one.destroyed)).toBe(true);
    board.element.parentElement?.remove();
  },
  CASE_MS,
);

test(
  "a board that goes while an editor still loads is unmounted only once that editor and its session went",
  async () => {
    const { lookup, release } = recordingLookup(ORDER);
    const board = await mountBoard(
      [
        { id: "n_order", file: ORDER },
        { id: "n_tea", file: TEA },
      ],
      boardPlugin(lookup),
      1,
    );
    expect(events).toContain(`mount held ${ORDER}`);
    current = undefined;
    events.length = 0;
    const settled = board.mounted.unmounted?.then(() => void events.push("unmounted"));
    board.mounted.destroy();
    board.shell.close(board.mounted.unmounted);
    await settle();
    expect(events).toEqual([`destroy editor ${TEA}`, `destroy session ${TEA}`]);
    release();
    await settled;
    await expect.poll(() => events.at(-1)).toBe("destroy the linked socket");
    expect(events).toEqual([
      `destroy editor ${TEA}`,
      `destroy session ${TEA}`,
      `destroy editor ${ORDER}`,
      `destroy session ${ORDER}`,
      "unmounted",
      "destroy the linked socket",
    ]);
    board.element.parentElement?.remove();
  },
  CASE_MS,
);

test("a Miragon editor's first fit measures its palette in layout px under a board's scale", () => {
  const frame = document.createElement("div");
  frame.style.cssText = "position: absolute; left: 0; top: 0; transform: scale(0.5); transform-origin: 0 0";
  const container = document.createElement("div");
  container.style.cssText = "position: relative; width: 800px; height: 500px";
  const palette = document.createElement("div");
  palette.className = "djs-palette";
  palette.style.cssText = "position: absolute; top: 12px; left: 12px; width: 300px; height: 40px";
  container.append(palette);
  frame.append(container);
  document.body.append(frame);
  try {
    expect(paletteBottomIn(container)).toBe(52);
    frame.style.transform = "none";
    expect(paletteBottomIn(container)).toBe(52);
  } finally {
    frame.remove();
  }
});
