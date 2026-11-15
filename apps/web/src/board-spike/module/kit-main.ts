/**
 * Entry of board-spike-kit.html: the conformance kit of @miragon/modeler-api, the contract every
 * Miragon modeler implements, run against the board module (collaborative-board.tsx). Every case
 * runs in this page, one after another; the outcome of each is kept on `window.__boardKit` for
 * test/spike/contract-kit-chromium.ts, which prints it.
 *
 * The harness says how a board is made, which texts are canonical and how a user's command is
 * scripted. What it leaves out the kit reports as skipped, never as passed.
 */
import "../native-geometry.ts";
import "../page-styles.ts";
import "@xyflow/react/dist/style.css";

import type { CollaborativeModeler } from "@miragon/modeler-api";
import { attachedHost, conformanceCases, type ConformanceHarness } from "@miragon/modeler-api/conformance";

import { addNode, NEW_NODE, writeDrop } from "../../notations/board/board-actions.ts";
import {
  type CollaborativeBoard,
  createCollaborativeBoard,
} from "../../notations/board/contract/collaborative-board.tsx";
import { createModelHub } from "../model-hub.ts";
import { SAMPLE_FILES, sampleAssets } from "../samples.ts";

export interface KitResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  /** why it failed or was skipped */
  reason?: string;
  /** recommended behaviour the board does not show; the case passed */
  advisories: string[];
  ms: number;
  /** a check of this page's own, not a case of the kit */
  extra?: true;
}
export interface KitReport {
  done: boolean;
  results: KitResult[];
  /** page errors and what the board logged while the cases ran */
  problems: string[];
}

const problems: string[] = [];
const report: KitReport = { done: false, results: [], problems };
(window as unknown as { __boardKit: KitReport }).__boardKit = report;
window.addEventListener("error", (event) => problems.push(`error: ${event.message}`));
window.addEventListener("unhandledrejection", (event) => {
  const reason: unknown = event.reason;
  problems.push(`unhandledrejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

// ── the texts: hand-written in the canonical form (header, then one line per element sorted by id, keys sorted) ──

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;

/** a group with a note in it, a note beside it and an arrow between the notes */
const BOARD_A = lines(
  String.raw`{"format":"structured-model","meta":{"title":"Kit board A","version":1},"version":1}`,
  String.raw`{"id":"e_note_to_note","kind":"edge","label":"leads to","source":"n_note_a","sourceHandle":"right","target":"n_note_b","targetHandle":"left"}`,
  String.raw`{"height":420,"id":"n_group","kind":"node","text":"Inbox","type":"group","width":640,"x":0,"y":0,"z":"a"}`,
  String.raw`{"height":160,"id":"n_note_a","kind":"node","parent":"n_group","text":"First note","type":"text","width":240,"x":40,"y":80,"z":"b"}`,
  String.raw`{"height":160,"id":"n_note_b","kind":"node","text":"## Second note\n\nWith a list:\n\n- one\n- two","type":"text","width":240,"x":760,"y":80,"z":"c"}`,
);
/** a model of the repository (edited in place by the product's editor), an image and a note with an arrow */
const BOARD_B = lines(
  String.raw`{"format":"structured-model","meta":{"title":"Kit board B","version":1},"version":1}`,
  String.raw`{"id":"e_remark_to_order","kind":"edge","source":"n_remark","sourceHandle":"left","target":"n_order","targetHandle":"right"}`,
  String.raw`{"file":"assets/sketch.svg","height":240,"id":"n_image","kind":"node","type":"image","width":320,"x":0,"y":620,"z":"c"}`,
  String.raw`{"file":"processes/order-to-cash.bpmn","height":540,"id":"n_order","kind":"node","type":"model","width":800,"x":0,"y":0,"z":"a"}`,
  String.raw`{"height":180,"id":"n_remark","kind":"node","text":"Check the credit limit first.","type":"text","width":320,"x":880,"y":0,"z":"b"}`,
);
/** a board without elements */
const BOARD_EMPTY = lines(String.raw`{"format":"structured-model","meta":{},"version":1}`);

/** board A as a person or another tool may leave it: other key order, other line order, blank lines, no last newline */
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

const HEADER = String.raw`{"format":"structured-model","meta":{},"version":1}`;
const INVALID = [
  "not a board at all",
  `<?xml version="1.0" encoding="UTF-8"?>\n<definitions/>\n`,
  // an element line cut off while a peer types
  `${HEADER}\n{"height":160,"id":"n_a","kind":"no`,
  // a newer format
  `{"format":"structured-model","meta":{},"version":2}\n`,
  // one id twice
  `${HEADER}\n{"id":"n_a","kind":"node"}\n{"id":"n_a","kind":"edge"}\n`,
  // elements without a header: some other tool's JSON lines
  `{"id":"n_a","kind":"node"}\n`,
  `${HEADER}\n${HEADER}\n`,
  // a header key the board would not write back
  `{"format":"structured-model","generator":"other","meta":{},"version":1}\n`,
  // a line that is JSON and no object
  `${HEADER}\n[1,2,3]\n`,
];

// ── the harness ──

const hub = createModelHub({
  files: SAMPLE_FILES,
  assets: sampleAssets(),
  log: (line) => problems.push(`hub: ${line}`),
});
const boardOf = (modeler: CollaborativeModeler): CollaborativeBoard["board"] => (modeler as CollaborativeBoard).board;
/** `?scope=page`: the control run of the keys case, with React Flow's own listeners on the document */
const pageScope = new URLSearchParams(location.search).get("scope") === "page";
/** every mutate adds a note with a text of its own, across instances */
let notes = 0;

/** the host each board was attached to: the interactions below are found in its DOM */
const hosts = new WeakMap<CollaborativeModeler, HTMLElement>();
const EDITED_NOTE = "n_note_b";
const TYPED = "Typed by the kit";
const noteEditor = (modeler: CollaborativeModeler): HTMLTextAreaElement | null =>
  hosts.get(modeler)?.querySelector<HTMLTextAreaElement>("textarea.board-text__editor") ?? null;
const waitFor = async <T>(read: () => T | null | undefined, what: string): Promise<T> => {
  const started = performance.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (performance.now() - started > 3000) throw new Error(`${what} did not appear within 3 s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const harness: ConformanceHarness = {
  async create() {
    const modeler = createCollaborativeBoard({ hub, ...(pageScope ? { inputScope: "page" } : {}) });
    const host = attachedHost();
    hosts.set(modeler, host);
    modeler.attachTo(host);
    await modeler.board.mounted;
    return modeler;
  },
  // the element that takes the board's keys: the pane that holds the nodes (board.tsx)
  canvasElement: (modeler) => hosts.get(modeler)?.querySelector(".react-flow__pane"),
  canonicalTexts: [BOARD_A, BOARD_B, BOARD_EMPTY],
  looseTexts: [LOOSE_A, ""],
  invalidTexts: INVALID,
  foreignTexts: [
    {
      text: FOREIGN,
      mustSurvive: [`"owner":"team-a"`, `"locked":true`, `"id":"n_shapeless"`, `"kind":"swimlane"`, `"rows":[1,2,3]`],
    },
  ],
  viewState: { x: -150, y: 60, zoom: 0.5 },
  // the toolbar's own add action: one gesture, one entry of the history
  mutate(modeler) {
    notes++;
    addNode(
      boardOf(modeler).store,
      { type: "text", text: `Kit note ${notes}`, ...NEW_NODE.text },
      { x: 1200 + notes * 24, y: 700 + notes * 16 },
    );
  },
  // the board has no setting outside its elements yet: the title of the header has no control
  configMutations: [],
  undo: (modeler) => boardOf(modeler).undo(),
  redo: (modeler) => boardOf(modeler).redo(),
  // what the end of a node drag writes: the note beside the group of board A, to a free place
  moveElement(modeler) {
    const { store } = boardOf(modeler);
    const note = store.getSnapshot().nodes.find((node) => node.id === "n_note_b");
    if (!note) throw new Error("board A has no n_note_b");
    writeDrop(store, { [note.id]: { x: note.attrs.x + 120, y: note.attrs.y + 240 } });
    return note.id;
  },
  // the board's own interaction: a note's editor, opened by a double-click, with input that is not committed
  async openInteraction(modeler) {
    const selector = `.react-flow__node[data-id="${EDITED_NOTE}"] .board-text`;
    const note = await waitFor(() => hosts.get(modeler)?.querySelector(selector), "the note of board A");
    note.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
    const area = await waitFor(() => noteEditor(modeler), "the note's editor");
    // as typing does: the element's own value, then the input event
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, TYPED);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  },
  interactionState(modeler) {
    const area = noteEditor(modeler);
    const elementId = area?.closest(".react-flow__node")?.getAttribute("data-id");
    return area && elementId ? { elementId, text: area.value } : undefined;
  },
  // leaving the editor commits (text-node.tsx): a blur where it has the focus, the event itself where it has not
  commitInteraction(modeler) {
    const area = noteEditor(modeler);
    if (!area) throw new Error("no note editor is open");
    if (document.activeElement === area) area.blur();
    else area.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  },
};

// ── the run ──

const only = new URLSearchParams(location.search).get("only");
for (const kitCase of conformanceCases()) {
  if (only !== null && !kitCase.name.toLowerCase().includes(only.toLowerCase())) continue;
  const started = performance.now();
  const result: KitResult = { name: kitCase.name, status: "passed", advisories: [], ms: 0 };
  try {
    const outcome = await kitCase.run(harness);
    result.advisories = outcome?.advisories ?? [];
    if (outcome?.skipped) {
      result.status = "skipped";
      result.reason = outcome.skipped;
    }
  } catch (error) {
    result.status = "failed";
    result.reason = error instanceof Error ? error.message : String(error);
  }
  result.ms = Math.round(performance.now() - started);
  report.results.push(result);
  console.debug("[board-kit]", result.status, result.name, result.reason ?? "");
}

// ── beyond the kit: a model node of an embedded board gets the product's editor, and arming it follows the rules ──

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined | null | false, timeout: number): Promise<T | undefined> {
  const started = performance.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (performance.now() - started > timeout) return undefined;
    await sleep(50);
  }
}
async function extra(name: string, check: () => Promise<string | undefined>): Promise<void> {
  const started = performance.now();
  const result: KitResult = { name, status: "passed", advisories: [], ms: 0, extra: true };
  try {
    const failure = await check();
    if (failure !== undefined) {
      result.status = "failed";
      result.reason = failure;
    }
  } catch (error) {
    result.status = "failed";
    result.reason = error instanceof Error ? error.message : String(error);
  }
  result.ms = Math.round(performance.now() - started);
  report.results.push(result);
  console.debug("[board-kit]", result.status, result.name, result.reason ?? "");
}

if (only === null) {
  const host = attachedHost();
  const modeler = createCollaborativeBoard({ hub });
  modeler.attachTo(host);
  await modeler.board.mounted;
  await modeler.importText(BOARD_B);
  const { runtime } = modeler.board;
  await extra("beyond the kit: the model node of an embedded board mounts the product's editor", async () => {
    const state = await until(
      () => (runtime.mounted("n_order") === undefined ? undefined : { ok: runtime.mounted("n_order") }),
      20_000,
    );
    if (!state) return "the editor of n_order neither mounted nor failed within 20 s";
    if (!state.ok) return `the editor of n_order failed: ${runtime.lines.join("; ")}`;
    const engine = host.querySelector('.board-engine[data-mount="product"]');
    return engine?.querySelector("[data-element-id] > .djs-visual")
      ? undefined
      : "no product editor with a drawn element in the node";
  });
  await extra(
    "beyond the kit: a double-click arms it at board zoom exactly 1, in the layer above the board",
    async () => {
      const before = modeler.getViewState() as { zoom: number };
      if (before.zoom === 1) return "the fitted view is at zoom 1 already: the rule would not show";
      const wrapper = host.querySelector<HTMLElement>('.react-flow__node[data-id="n_order"]');
      if (!wrapper) return "no node wrapper for n_order";
      const box = wrapper.getBoundingClientRect();
      wrapper.dispatchEvent(
        new MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: box.x + box.width / 2,
          clientY: box.y + box.height / 2,
        }),
      );
      if (!(await until(() => runtime.armedId() === "n_order", 5000))) return "n_order was not armed within 5 s";
      await sleep(600);
      const after = modeler.getViewState() as { zoom: number };
      if (after.zoom !== 1) return `armed at board zoom ${after.zoom}, not at 1`;
      const layered = host.querySelector(
        '.board-overlay-layer > .board-engine[data-armed="true"][data-layout="overlay"]',
      );
      if (!layered) return "the armed editor is not in the overlay layer";
      // a zoom of the board makes it a preview again (the rule `disarm`), through the host's own view call
      modeler.setViewState({ ...after, zoom: 0.5 });
      await sleep(300);
      if (runtime.armedId() !== null) return "a view change to zoom 0.5 left the node armed";
      return host.querySelector(".board-overlay-layer > .board-engine")
        ? "the editor stayed in the layer after the disarm"
        : undefined;
    },
  );
  modeler.destroy();
}
report.done = true;
