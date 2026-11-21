/**
 * @miragon/modeler-api's conformance kit against the board as designIQ mounts it
 * (src/notations/board/editor.ts createDesignIqBoard): the renderer's factory on a live document
 * of the host's, which a second document mirrors as the sync provider would, with designIQ's
 * free area, its undo keys and its host (the product editors through the plugin registry). The
 * kit's context has no linked files, so a model node of its texts says that it cannot be shown
 * here: what is measured is the board's contract, which designIQ's options must not break.
 *
 * The harness and the texts follow the board's own conformance test (Miragon/modeler-suite,
 * modelers/board/packages/renderer/test/browser/conformance.browser.test.ts and
 * test/support/board-texts.ts, the texts byte for byte). The suite's rule is zero skips; the
 * board deviates with the seven skips pinned in EXPECTED_SKIPS, each with the kit's reason word
 * for word, for the reasons the suite gives: the harness hook `startGesture` (the L1, drop, drag
 * start and destroy-from-a-listener cases), and the `interaction` and `appearance` surfaces and a
 * viewer mount the board does not have yet. The list is checked in both directions and may only
 * shrink. An advisory fails, as there.
 */
import { CONTENT_KEY } from "@designiq/contracts/live";
import { addNode, boardText, type CollaborativeBoard, NEW_NODE, writeDrop } from "@miragon/board-renderer";
import type { CollaborativeModeler } from "@miragon/modeler-api";
import { attachedHost, type ConformanceHarness, registerConformance } from "@miragon/modeler-api/conformance";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { createDesignIqBoard } from "../../src/notations/board/editor.ts";
import type { DesignIqBoardHost } from "../../src/notations/board/host.ts";
import { type EditorContext, webPlugin } from "../../src/notations/registry.ts";

// ── the texts: the board's own conformance texts, byte for byte ──────────────

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;

/** a group with a note in it, a note beside it and an arrow between the notes */
const BOARD_A = lines(
  String.raw`{"format":"structured-model","meta":{"title":"Kit board A","version":1},"version":1}`,
  String.raw`{"id":"e_note_to_note","kind":"edge","label":"leads to","source":"n_note_a","sourceHandle":"right","target":"n_note_b","targetHandle":"left"}`,
  String.raw`{"height":420,"id":"n_group","kind":"node","text":"Inbox","type":"group","width":640,"x":0,"y":0,"z":"a"}`,
  String.raw`{"height":160,"id":"n_note_a","kind":"node","parent":"n_group","text":"First note","type":"text","width":240,"x":40,"y":80,"z":"b"}`,
  String.raw`{"height":160,"id":"n_note_b","kind":"node","text":"## Second note\n\nWith a list:\n\n- one\n- two","type":"text","width":240,"x":760,"y":80,"z":"c"}`,
);
/** a model of the repository, an image and a note with an arrow */
const BOARD_B = lines(
  String.raw`{"format":"structured-model","meta":{"title":"Kit board B","version":1},"version":1}`,
  String.raw`{"id":"e_remark_to_order","kind":"edge","source":"n_remark","sourceHandle":"left","target":"n_order","targetHandle":"right"}`,
  String.raw`{"file":"assets/sketch.svg","height":240,"id":"n_image","kind":"node","type":"image","width":320,"x":0,"y":620,"z":"c"}`,
  String.raw`{"file":"processes/order-to-cash.bpmn","height":540,"id":"n_order","kind":"node","type":"model","width":800,"x":0,"y":0,"z":"a"}`,
  String.raw`{"height":180,"id":"n_remark","kind":"node","text":"Check the credit limit first.","type":"text","width":320,"x":880,"y":0,"z":"b"}`,
);
/** a board without elements */
const BOARD_EMPTY = lines(String.raw`{"format":"structured-model","meta":{},"version":1}`);
/** board A's shape with the value `__proto__` as a name, a note's text and a label */
const BOARD_PROTO = lines(
  String.raw`{"format":"structured-model","meta":{"title":"Kit board proto","version":1},"version":1}`,
  String.raw`{"id":"e_note_to_note","kind":"edge","label":"__proto__","source":"n_note_a","sourceHandle":"right","target":"n_note_b","targetHandle":"left"}`,
  String.raw`{"height":420,"id":"n_group","kind":"node","text":"__proto__","type":"group","width":640,"x":0,"y":0,"z":"a"}`,
  String.raw`{"height":160,"id":"n_note_a","kind":"node","parent":"n_group","text":"__proto__","type":"text","width":240,"x":40,"y":80,"z":"b"}`,
  String.raw`{"height":160,"id":"n_note_b","kind":"node","text":"Second note","type":"text","width":240,"x":760,"y":80,"z":"c"}`,
);
/** board A as a person or another tool may leave it */
const LOOSE_A = [
  String.raw`{"kind":"node","type":"text","id":"n_note_b","x":760,"y":80,"width":240,"height":160,"z":"c","text":"## Second note\n\nWith a list:\n\n- one\n- two"}`,
  "",
  String.raw`{ "id": "n_group", "kind": "node", "type": "group", "text": "Inbox", "x": 0, "y": 0, "width": 640, "height": 420, "z": "a" }`,
  String.raw`{"version":1,"meta":{"version":1,"title":"Kit board A"},"format":"structured-model"}`,
  String.raw`{"kind":"edge","id":"e_note_to_note","source":"n_note_a","target":"n_note_b","sourceHandle":"right","targetHandle":"left","label":"leads to"}`,
  "   ",
  String.raw`{"parent":"n_group","kind":"node","type":"text","id":"n_note_a","text":"First note","x":40,"y":80,"width":240,"height":160,"z":"b"}`,
].join("\n");
/** content the board does not know: it stays in the document, off the canvas, and is written back */
const FOREIGN = lines(
  String.raw`{"format":"structured-model","meta":{"owner":"team-a","title":"Foreign","version":1},"version":1}`,
  String.raw`{"height":100,"id":"n_locked","kind":"node","locked":true,"text":"Locked","type":"text","width":200,"x":0,"y":0,"z":"a"}`,
  String.raw`{"id":"n_shapeless","kind":"node","type":"text"}`,
  String.raw`{"colour":"amber","id":"x_lane","kind":"swimlane","rows":[1,2,3]}`,
);
const FOREIGN_MUST_SURVIVE = [
  `"owner":"team-a"`,
  `"locked":true`,
  `"id":"n_shapeless"`,
  `"kind":"swimlane"`,
  `"rows":[1,2,3]`,
];
const HEADER = String.raw`{"format":"structured-model","meta":{},"version":1}`;
const INVALID = [
  "not a board at all",
  `<?xml version="1.0" encoding="UTF-8"?>\n<definitions/>\n`,
  `${HEADER}\n{"height":160,"id":"n_a","kind":"no`,
  `{"format":"structured-model","meta":{},"version":2}\n`,
  `${HEADER}\n{"id":"n_a","kind":"node"}\n{"id":"n_a","kind":"edge"}\n`,
  `{"id":"n_a","kind":"node"}\n`,
  `${HEADER}\n${HEADER}\n`,
  `{"format":"structured-model","generator":"other","meta":{},"version":1}\n`,
  `${HEADER}\n[1,2,3]\n`,
];

// ── the harness ──────────────────────────────────────────────────────────────

/** the cases the board may skip, by their name up to its first colon, each with the kit's own reason */
const EXPECTED_SKIPS: Readonly<Record<string, string>> = {
  "L1 (recommended, 1.5)":
    "startGesture is undefined — that an import cancels a running gesture (L1, RECOMMENDED since 1.5) was not checked",
  "drop (recommended, 1.6)":
    "startGesture is undefined — that an import from the change listener of a drop waits until the drop has ended (RECOMMENDED since 1.6) was not checked",
  "drag start (recommended, 1.6)":
    "startGesture is undefined — that an import from the selection listener at a drag's start runs once the drag has started and then ends it (RECOMMENDED since 1.6) was not checked",
  "interaction (when present, 1.5)": "the modeler exposes no interaction surface (optional, 1.5) — nothing to verify",
  "destroy from a listener (recommended, 1.6)":
    "startGesture is undefined — that a host may destroy the modeler from a listener while the user's input runs or inside an import that ends a held gesture, and that a listener unsubscribed during a delivery is not called (RECOMMENDED since 1.6), was not checked",
  "viewer (when shipped)": "createReadonly is undefined — the package ships no viewer mount",
  "appearance (when present, 1.5)": "the modeler exposes no appearance surface (optional, 1.5) — nothing to verify",
};

const boardOf = (modeler: CollaborativeModeler): CollaborativeBoard["board"] => (modeler as CollaborativeBoard).board;

const hosts = new WeakMap<CollaborativeModeler, HTMLElement>();
const attached: HTMLElement[] = [];
/** every live document a case handed a board, with the document that mirrors it, and designIQ's host */
const shared: Array<{ doc: Y.Doc; mirror: Y.Doc; modeler: CollaborativeBoard; host: DesignIqBoardHost }> = [];

afterEach(async () => {
  for (const host of attached.splice(0)) host.parentElement?.remove();
  for (const { doc, mirror, modeler, host } of shared.splice(0)) {
    // whatever the case did to the host's document reached whoever shares it
    expect(boardText(mirror)).toBe(boardText(doc));
    modeler.destroy();
    await modeler.board.unmounted;
    await host.whenClosed();
    host.destroy();
  }
});

let notes = 0;
const EDITED_NOTE = "n_note_b";
const TYPED = "Typed by the kit";
const noteEditor = (modeler: CollaborativeModeler): HTMLTextAreaElement | null =>
  hosts.get(modeler)?.querySelector<HTMLTextAreaElement>("textarea.board-text__editor") ?? null;

const waitFor = async <T>(read: () => T | null | undefined, what: string): Promise<T> => {
  const started = performance.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (performance.now() - started > 10_000) throw new Error(`${what} did not appear within 10 s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const PAN_STEP = 40;
const barePoint = (pane: Element): { x: number; y: number } => {
  const box = pane.getBoundingClientRect();
  for (let y = box.bottom - 12; y > box.top; y -= 24) {
    for (let x = box.left + 12; x < box.right; x += 24) {
      if (document.elementFromPoint(x, y) === pane) return { x, y };
    }
  }
  throw new Error("the pane has no bare point to press on");
};
const mouse = (target: EventTarget, type: string, x: number, y: number): void => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
};

/** the board designIQ mounts, on a live document a second one mirrors, attached to a kit host */
async function create(): Promise<CollaborativeModeler> {
  const doc = new Y.Doc();
  const mirror = new Y.Doc();
  doc.on("update", (update: Uint8Array) => Y.applyUpdate(mirror, update, "sync"));
  const ctx: EditorContext = {
    ytext: doc.getText(CONTENT_KEY),
    doc,
    repo: "acme/models",
    docPath: "boards/kit.board",
    onSyncError: () => undefined,
    onImportFailed: () => undefined,
    onBadgeClick: () => undefined,
    onSelectionChanged: () => undefined,
  };
  const { modeler, host } = createDesignIqBoard(ctx, webPlugin);
  shared.push({ doc, mirror, modeler, host });
  const element = attachedHost();
  hosts.set(modeler, element);
  attached.push(element);
  modeler.attachTo(element);
  await modeler.board.mounted;
  return modeler;
}

const harness: ConformanceHarness = {
  create,
  canvasElement: (modeler) => hosts.get(modeler)?.querySelector(".react-flow__pane"),
  canonicalTexts: [BOARD_A, BOARD_B, BOARD_EMPTY, BOARD_PROTO],
  looseTexts: [LOOSE_A, ""],
  invalidTexts: [...INVALID],
  foreignTexts: [{ text: FOREIGN, mustSurvive: [...FOREIGN_MUST_SURVIVE] }],
  viewState: { x: -150, y: 60, zoom: 0.5 },
  mutate(modeler) {
    notes++;
    addNode(
      boardOf(modeler).store,
      { type: "text", text: `Kit note ${notes}`, ...NEW_NODE.text },
      { x: 1200 + notes * 24, y: 700 + notes * 16 },
    );
  },
  configMutations: [],
  undo: (modeler) => boardOf(modeler).undo(),
  redo: (modeler) => boardOf(modeler).redo(),
  moveElement(modeler) {
    const { store } = boardOf(modeler);
    const note = store.getSnapshot().nodes.find((node) => node.id === EDITED_NOTE);
    if (!note) throw new Error(`board A has no ${EDITED_NOTE}`);
    writeDrop(store, { [note.id]: { x: note.attrs.x + 120, y: note.attrs.y + 240 } });
    return note.id;
  },
  async openInteraction(modeler) {
    const selector = `.react-flow__node[data-id="${EDITED_NOTE}"] .board-text`;
    const note = await waitFor(() => hosts.get(modeler)?.querySelector(selector), "the note of board A");
    note.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
    const area = await waitFor(() => noteEditor(modeler), "the note's editor");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, TYPED);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  },
  interactionState(modeler) {
    const area = noteEditor(modeler);
    const elementId = area?.closest(".react-flow__node")?.getAttribute("data-id");
    return area && elementId ? { elementId, text: area.value } : undefined;
  },
  commitInteraction(modeler) {
    const area = noteEditor(modeler);
    if (!area) throw new Error("no note editor is open");
    if (document.activeElement === area) area.blur();
    else area.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  },
  startPan(modeler) {
    const pane = hosts.get(modeler)?.querySelector(".react-flow__pane");
    if (!pane) throw new Error("the board has no pane");
    const start = barePoint(pane);
    let steps = 0;
    const move = (): void => {
      steps++;
      mouse(window, "mousemove", start.x + steps * PAN_STEP, start.y);
    };
    mouse(pane, "mousedown", start.x, start.y);
    move();
    return { move, drop: () => mouse(window, "mouseup", start.x + steps * PAN_STEP, start.y) };
  },
};

/** the Live Host's image route, which the image node of board B reads: a small picture, no server */
const SKETCH = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24"/></svg>';
beforeAll(() => {
  const network = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("/api/repos/acme/models/image?")) return network(input, init);
    return Promise.resolve(new Response(SKETCH, { status: 200, headers: { "content-type": "image/svg+xml" } }));
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("the board as designIQ mounts it implements the collaborative-modeler contract", () => {
  const skipped: Record<string, string> = {};
  registerConformance(harness, test, {
    onSkip(caseName, reason) {
      const colon = caseName.indexOf(":");
      const key = colon === -1 ? caseName : caseName.slice(0, colon);
      if (EXPECTED_SKIPS[key] !== reason) {
        throw new Error(
          `conformance case skipped: "${caseName}": ${reason}` +
            (key in EXPECTED_SKIPS ? `\nthe reason pinned for it: ${EXPECTED_SKIPS[key]}` : ""),
        );
      }
      skipped[key] = reason;
    },
    onAdvisory(caseName, advice) {
      throw new Error(`conformance advisory: "${caseName}": ${advice}`);
    },
  });
  // a listed case that no longer skips fails here until its name is taken off the list
  afterAll(() => {
    expect(skipped).toEqual(EXPECTED_SKIPS);
  });
});
