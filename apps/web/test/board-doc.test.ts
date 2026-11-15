/**
 * The board's board store (src/notations/board/board-doc.ts): the structured doc shape with
 * targeted writes, its projection for React Flow and its at-rest text. Run by hand:
 *
 *   node --test apps/web/test/board-doc.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readSnapshot } from "@designiq/live-client/structured";
import { fractionalIndexBetween, jsonLinesCodec } from "@designiq/notations/codecs";
import * as Y from "yjs";

import {
  absoluteBox,
  type BoardSnapshot,
  boardText,
  createBoardDoc,
  createBoardStore,
  newId,
  type NodeAttrs,
  notationOf,
  writeGeometry,
} from "../src/notations/board/board-doc.ts";

const z1 = fractionalIndexBetween();
const z2 = fractionalIndexBetween(z1);
const node = (attrs: Partial<NodeAttrs>): NodeAttrs => ({
  kind: "node",
  type: "text",
  x: 0,
  y: 0,
  width: 200,
  height: 120,
  z: z1,
  ...attrs,
});
const SEED: BoardSnapshot = {
  meta: { title: "Spike", version: 1 },
  elements: {
    n_group: node({ type: "group", width: 900, height: 600, text: "Order to cash" }),
    n_model: node({ type: "model", file: "processes/a.bpmn", parent: "n_group", x: 40, y: 60, z: z2 }),
    e_1: { kind: "edge", source: "n_group", target: "n_model", sourceHandle: "right", label: "holds" },
  },
};

/** two clients of one board: every update of one is applied to the other, unless the link is held */
function peers() {
  const RELAYED = Symbol("relayed");
  const a = createBoardDoc(SEED);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), RELAYED);
  let held: Array<() => void> | undefined;
  const relay = (from: Y.Doc, to: Y.Doc): void => {
    from.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === RELAYED) return;
      const deliver = (): void => Y.applyUpdate(to, update, RELAYED);
      if (held) held.push(deliver);
      else deliver();
    });
  };
  relay(a, b);
  relay(b, a);
  return {
    a: createBoardStore(a),
    b: createBoardStore(b),
    hold: () => void (held = []),
    release: () => {
      const queued = held ?? [];
      held = undefined;
      for (const deliver of queued) deliver();
    },
  };
}

test("the seed, its projection and its text at rest", () => {
  const doc = createBoardDoc(SEED);
  const store = createBoardStore(doc);
  const view = store.getSnapshot();
  assert.deepEqual(
    view.nodes.map((n) => [n.id, n.parentId]),
    [
      ["n_group", undefined],
      ["n_model", "n_group"],
    ],
  );
  assert.deepEqual(
    view.edges.map((e) => e.id),
    ["e_1"],
  );
  assert.equal(store.getSnapshot(), view, "the same view until the document changes");
  assert.deepEqual(absoluteBox(view, "n_model"), { x: 40, y: 60, width: 200, height: 120 });

  const text = store.text();
  assert.equal(text, boardText(doc));
  assert.deepEqual(text.trimEnd().split("\n"), [
    '{"format":"structured-model","meta":{"title":"Spike","version":1},"version":1}',
    '{"id":"e_1","kind":"edge","label":"holds","source":"n_group","sourceHandle":"right","target":"n_model"}',
    `{"height":600,"id":"n_group","kind":"node","text":"Order to cash","type":"group","width":900,"x":0,"y":0,"z":"${z1}"}`,
    `{"file":"processes/a.bpmn","height":120,"id":"n_model","kind":"node","parent":"n_group","type":"model","width":200,"x":40,"y":60,"z":"${z2}"}`,
  ]);
  // the text is the whole board: a document seeded from it writes the same text
  assert.equal(boardText(createBoardDoc(text)), text);
  assert.equal(jsonLinesCodec().encode(jsonLinesCodec().decode(text)), text, "canonical: a fixpoint of the codec");
  store.destroy();
});

test("a finished gesture is one transaction, one notification and one changed line", () => {
  const store = createBoardStore(createBoardDoc(SEED));
  let notified = 0;
  let updates = 0;
  store.subscribe(() => notified++);
  store.doc.on("update", () => updates++);
  const before = store.text().split("\n");
  const first = store.getSnapshot();

  writeGeometry(store, { n_model: { x: 100.4, y: 99.6 } });
  assert.deepEqual([notified, updates], [1, 1]);
  const after = store.text().split("\n");
  assert.deepEqual(
    after.filter((line, index) => line !== before[index]),
    [
      `{"file":"processes/a.bpmn","height":120,"id":"n_model","kind":"node","parent":"n_group","type":"model","width":200,"x":100,"y":100,"z":"${z2}"}`,
    ],
    "the moved node's line, with integer coordinates, and no other",
  );
  assert.equal(store.getSnapshot().nodes[0], first.nodes[0], "an untouched node keeps its object");
  assert.notEqual(store.getSnapshot().nodes[1], first.nodes[1]);
  assert.equal(store.getSnapshot().edges[0], first.edges[0], "and so does an untouched arrow");
  assert.deepEqual(absoluteBox(store.getSnapshot(), "n_model"), { x: 100, y: 100, width: 200, height: 120 });

  // a resize writes all four, a move of two nodes is still one transaction
  writeGeometry(store, { n_group: { x: 10, y: 20, width: 950.2, height: 640 }, n_model: { x: 0, y: 0 } });
  assert.deepEqual([notified, updates], [2, 2]);
  const group = readSnapshot(store.doc).elements.n_group;
  assert.deepEqual([group?.x, group?.y, group?.width, group?.height], [10, 20, 950, 640]);
  assert.deepEqual(absoluteBox(store.getSnapshot(), "n_model"), { x: 10, y: 20, width: 200, height: 120 });

  // a new node goes on top, under an id that no counter made
  const id = newId("n");
  store.gesture((tx) => tx.create(id, node({ text: "# Note", z: store.zOnTop() })));
  assert.match(id, /^n_[0-9a-f-]{13}$/);
  assert.equal(store.getSnapshot().nodes.at(-1)?.id, id);
  assert.ok(store.getSnapshot().nodes.at(-1)!.attrs.z > z2);
  store.destroy();
});

test("two clients: a peer's gesture, both attributes of a drop, a delete against a move, undo", () => {
  const { a, b, hold, release } = peers();
  let notified = 0;
  a.subscribe(() => notified++);
  b.gesture((tx) => tx.update("n_model", { x: 100, y: 100 }));
  assert.deepEqual([a.getSnapshot().nodes[1]?.attrs.x, notified], [100, 1], "a peer's gesture shows, once");

  // concurrent drops of one node: one peer's box, never a mix of both (sync.md 4.2)
  hold();
  writeGeometry(a, { n_model: { x: 111, y: 222 } });
  writeGeometry(b, { n_model: { x: 555, y: 100 } });
  release();
  const dropped = readSnapshot(a.doc).elements.n_model;
  assert.ok(
    [
      [111, 222],
      [555, 100],
    ].some(([x, y]) => dropped?.x === x && dropped?.y === y),
    `one peer's drop, whole: got ${String(dropped?.x)}, ${String(dropped?.y)}`,
  );
  assert.equal(a.text(), b.text());

  // a move and a resize of the same node are different attributes: both survive
  hold();
  writeGeometry(a, { n_group: { x: 50, y: 70 } });
  b.gesture((tx) => tx.update("n_group", { width: 700, height: 500 }));
  release();
  const group = readSnapshot(b.doc).elements.n_group;
  assert.deepEqual([group?.x, group?.y, group?.width, group?.height], [50, 70, 700, 500]);

  // a late drop of a node a peer removed re-creates nothing
  hold();
  b.gesture((tx) => tx.remove("n_model"));
  writeGeometry(a, { n_model: { x: 1, y: 1 } });
  release();
  assert.equal(readSnapshot(a.doc).elements.n_model, undefined, "the delete wins over the concurrent move");
  writeGeometry(a, { n_model: { x: 2, y: 2 } });
  assert.equal(readSnapshot(a.doc).elements.n_model, undefined);
  assert.deepEqual(a.getSnapshot().edges, [], "an arrow whose node is gone is not drawn");
  assert.ok(readSnapshot(a.doc).elements.e_1, "and stays in the document");

  // undo takes back this client's gesture only
  writeGeometry(a, { n_group: { x: 0, y: 0 } });
  b.gesture((tx) => tx.update("n_group", { text: "Renamed" }));
  a.undo.undo();
  const undone = readSnapshot(b.doc).elements.n_group;
  assert.deepEqual([undone?.x, undone?.y, undone?.text], [50, 70, "Renamed"]);
  assert.equal(a.text(), b.text());
  a.destroy();
  b.destroy();
});

test("the projection is total: a parent cycle, a dangling parent and a malformed element", () => {
  const { a, b, hold, release } = peers();
  a.gesture((tx) => tx.create("n_g2", node({ type: "group", z: a.zOnTop() })));
  hold();
  a.gesture((tx) => tx.update("n_group", { parent: "n_g2" }));
  b.gesture((tx) => tx.update("n_g2", { parent: "n_group" }));
  release();
  const view = a.getSnapshot();
  assert.deepEqual(
    view.nodes.map((n) => [n.id, n.parentId ?? null]),
    b.getSnapshot().nodes.map((n) => [n.id, n.parentId ?? null]),
    "both clients open the cycle the same way",
  );
  const ids = view.nodes.map((n) => n.id);
  for (const n of view.nodes) {
    if (n.parentId) assert.ok(ids.indexOf(n.parentId) < ids.indexOf(n.id), "a parent before its child");
  }
  assert.ok(absoluteBox(view, "n_model"), "and the walk up the parents ends");

  b.gesture((tx) => tx.update("n_model", { parent: "n_nowhere" }));
  assert.equal(a.getSnapshot().nodes.find((n) => n.id === "n_model")?.parentId, undefined);

  b.gesture((tx) => tx.create("n_odd", { ...node({}), x: "12" as never }));
  assert.ok(!a.getSnapshot().nodes.some((n) => n.id === "n_odd"), "off the canvas");
  assert.ok(readSnapshot(a.doc).elements.n_odd, "and still in the document");
  assert.ok(a.text().includes('"id":"n_odd"'), "and in the file");
  a.destroy();
  b.destroy();
});

test("a model node's notation comes from its file", () => {
  assert.equal(notationOf("processes/order-to-cash.bpmn"), "bpmn");
  assert.equal(notationOf("processes/credit-limit-check.dmn"), "dmn");
  assert.equal(notationOf("maps/tea-shop.wmap"), "wardley");
  assert.equal(notationOf("maps/tea-shop.owm"), "wardley");
  assert.equal(notationOf("teams/online-shop.tt"), "team-topology");
  assert.equal(notationOf("processes/order-to-cash.storm"), "event-storming");
  assert.equal(notationOf("maps/order-fulfilment.cm.json"), "context-map");
  assert.equal(notationOf("chains/order-to-cash.vc.json"), "value-chain");
  assert.equal(notationOf("docs/readme.md"), undefined, "Markdown is no model of the board");
  assert.equal(notationOf("assets/sketch.svg"), undefined);
  assert.equal(notationOf(undefined), undefined);
});
