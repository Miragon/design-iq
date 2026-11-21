/**
 * What a board draws beside its nodes and who it shows (src/notations/board): the references
 * between the open models, read from their live texts by the platform's own reader (on the
 * example content: order-to-cash decides with credit-limit-check and calls invoice-handling),
 * once per pair and relation, parsed after a rest and handed out as the same array until one
 * changed; the repository's images, loaded once per path from the Live Host's route and handed
 * out as the same Blob; and the presence of the board's own room and of a model's room, where
 * whoever only looks at a board is nobody.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { LiveSession } from "@designiq/live-client";
import * as Y from "yjs";

import type { PresenceSurface, RemotePresence } from "../src/lib/presence-canvas.ts";
import { boardReferences, referencesOfFile, sameReferences } from "../src/notations/board/derived-refs.ts";
import { createBoardImages } from "../src/notations/board/images.ts";
import { createModelTexts } from "../src/notations/board/model-texts.ts";
import { boardPresence, modelPresence } from "../src/notations/board/presence.ts";
import { createBoardReferences, REFERENCES_REST_MS } from "../src/notations/board/references.ts";

const example = (file: string): string =>
  readFileSync(new URL(`../../../process-documentation/processes/${file}`, import.meta.url), "utf8");
const ORDER = "processes/order-to-cash.bpmn";
const CREDIT = "processes/credit-limit-check.dmn";
const INVOICE = "processes/subprocesses/invoice-handling.bpmn";

test("a process refers to the decision it takes and the process it calls, by the platform's own reader", () => {
  const order = { path: ORDER, text: example("order-to-cash.bpmn") };
  const paths = [ORDER, CREDIT, INVOICE, "maps/credit-limit-check.wmap"];
  assert.deepEqual(referencesOfFile(order, paths), [
    { from: ORDER, to: INVOICE, relation: "calls" },
    { from: ORDER, to: CREDIT, relation: "decides" },
  ]);
  // a decision says nothing about others, a text between two merges says nothing at all
  assert.deepEqual(referencesOfFile({ path: CREDIT, text: example("credit-limit-check.dmn") }, paths), []);
  assert.deepEqual(referencesOfFile({ path: ORDER, text: "<bpmn:definitions" }, paths), []);
  // a board refers to what it shows: that is the board, not an arrow on it
  const board =
    '{"format":"structured-model","meta":{},"version":1}\n{"file":"processes/order-to-cash.bpmn","id":"n_a","kind":"node","type":"model"}\n';
  assert.deepEqual(referencesOfFile({ path: "plan.board", text: board }, paths), []);
});

test("two calls of one process are one arrow, and the list is sorted", () => {
  const twice = example("order-to-cash.bpmn").replace(
    'calledDecision="credit-limit-check"',
    'calledDecision="credit-limit-check"/><bpmn:businessRuleTask id="Again" calledDecision="credit-limit-check"',
  );
  const refs = boardReferences([{ path: ORDER, text: twice }], [ORDER, CREDIT, INVOICE]);
  assert.deepEqual(refs, [
    { from: ORDER, to: INVOICE, relation: "calls" },
    { from: ORDER, to: CREDIT, relation: "decides" },
  ]);
  assert.equal(sameReferences(refs, [...refs]), true);
  assert.equal(sameReferences(refs, refs.slice(1)), false);
  assert.equal(sameReferences(refs, [refs[1]!, refs[0]!]), false);
});

test("the references are parsed after a rest and stay the same array until one changed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const texts = createModelTexts();
  let paths: readonly string[] = [ORDER, CREDIT];
  const pathListeners = new Set<() => void>();
  const references = createBoardReferences({
    texts,
    paths: () => paths,
    onPaths(listener) {
      pathListeners.add(listener);
      return () => void pathListeners.delete(listener);
    },
  });
  let told = 0;
  references.onChange(() => told++);
  const empty = references.list();
  assert.deepEqual(empty, []);

  const doc = new Y.Doc();
  const order = doc.getText("content");
  order.insert(0, example("order-to-cash.bpmn"));
  const removeOrder = texts.add(ORDER, order);
  t.mock.timers.tick(REFERENCES_REST_MS - 1);
  assert.equal(references.list(), empty, "not before the rest");
  t.mock.timers.tick(1);
  const first = references.list();
  assert.deepEqual(first, [{ from: ORDER, to: CREDIT, relation: "decides" }]);
  assert.equal(told, 1);

  // an edit that changes no reference: no new array, nobody told
  order.insert(order.length, "\n");
  t.mock.timers.tick(REFERENCES_REST_MS);
  assert.equal(references.list(), first);
  assert.equal(told, 1);

  // the list gains the called process: an arrow to it
  paths = [ORDER, CREDIT, INVOICE];
  for (const listener of [...pathListeners]) listener();
  t.mock.timers.tick(REFERENCES_REST_MS);
  assert.equal(references.list().length, 2);
  assert.equal(told, 2);

  // the text goes with its node: so do its arrows
  removeOrder();
  t.mock.timers.tick(REFERENCES_REST_MS);
  assert.deepEqual(references.list(), []);
  assert.equal(told, 3);

  references.destroy();
  assert.equal(pathListeners.size, 0);
  texts.add(ORDER, order);
  t.mock.timers.tick(REFERENCES_REST_MS);
  assert.deepEqual(references.list(), [], "nothing is parsed after the end");
});

test("the texts of the open models: one per path, the first session's, until the last one goes", () => {
  const texts = createModelTexts();
  const [a, b] = [new Y.Doc().getText("content"), new Y.Doc().getText("content")];
  a.insert(0, "first");
  b.insert(0, "second");
  let told = 0;
  texts.onChange(() => told++);
  const removeA = texts.add(ORDER, a);
  const removeB = texts.add(ORDER, b);
  assert.deepEqual(texts.current(), [{ path: ORDER, text: "first" }]);
  removeA();
  removeA();
  assert.deepEqual(texts.current(), [{ path: ORDER, text: "second" }]);
  b.insert(0, "the ");
  assert.equal(told, 4, "two adds, one remove, one edit");
  removeB();
  assert.deepEqual(texts.current(), []);
  a.insert(0, "x");
  assert.equal(told, 5, "a text that was removed is not observed any more");
});

test("an image is loaded once from the Live Host's route and handed out as the same Blob", async () => {
  const asked: string[] = [];
  const blob = new Blob(["<svg/>"], { type: "image/svg+xml" });
  const images = createBoardImages("acme/models", (url) => {
    asked.push(url);
    return Promise.resolve(
      url.includes("missing") ? new Response(null, { status: 404 }) : new Response(blob, { status: 200 }),
    );
  });
  let told = 0;
  images.onChange(() => told++);
  assert.equal(images.store, undefined, "no Image button: the Live Host stores no picture");
  assert.equal(images.taken, undefined);
  assert.equal(images.read("assets/sketch.svg"), undefined, "not inside the render that asked");
  assert.equal(images.read("assets/sketch.svg"), undefined);
  assert.equal(images.read("assets/notes.txt"), undefined, "not an image the route serves: never asked");
  assert.equal(images.read(""), undefined);
  assert.equal(images.read("assets/missing.png"), undefined);
  // the bytes come in a later task
  for (let tries = 0; told === 0 && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(asked, [
    "/api/repos/acme/models/image?path=assets%2Fsketch.svg",
    "/api/repos/acme/models/image?path=assets%2Fmissing.png",
  ]);
  assert.equal(told, 1, "told once the bytes are there, not for a file that is missing");
  const read = images.read("assets/sketch.svg");
  assert.ok(read instanceof Blob);
  assert.equal(images.read("assets/sketch.svg"), read, "the same Blob until onChange");
  assert.equal(await read.text(), "<svg/>");
  assert.equal(images.read("assets/missing.png"), undefined);
  images.destroy();
  assert.equal(images.read("assets/other.png"), undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(asked.length, 2, "nothing is loaded after the end");
});

test("the board's presence is its room's: name, colour and an agent's kind, no avatar", () => {
  const sent: unknown[] = [];
  const peers: RemotePresence[] = [
    { clientId: 7, user: { name: "Ada", color: "#335de5", avatarUrl: "https://example.test/ada.png" } },
    {
      clientId: 9,
      user: { name: "Claude for Ada", color: "#00e676", kind: "agent" },
      canvas: { cursor: null, selection: ["n_a"] },
    },
  ];
  const surface: PresenceSurface = {
    setLocal: (presence) => void sent.push(presence),
    onRemote(listener) {
      listener(peers);
      return () => undefined;
    },
  };
  const presence = boardPresence(surface);
  presence.setLocal({ cursor: { x: 1, y: 2 }, selection: [] });
  assert.deepEqual(sent, [{ cursor: { x: 1, y: 2 }, selection: [] }]);
  let drawn: unknown;
  presence.onRemote((now) => (drawn = now));
  assert.deepEqual(drawn, [
    { clientId: 7, user: { name: "Ada", color: "#335de5" } },
    {
      clientId: 9,
      user: { name: "Claude for Ada", color: "#00e676", kind: "agent" },
      canvas: { cursor: null, selection: ["n_a"] },
    },
  ]);
});

test("in a model's room the cursor goes out only while armed, and only announced peers are drawn", () => {
  const published: unknown[] = [];
  let armed = false;
  const session = {
    setCanvasPresence: (presence: unknown) => void published.push(presence),
    onAwarenessStates(listener: (peers: Array<{ clientId: number; user?: unknown; canvas?: unknown }>) => void) {
      listener([
        { clientId: 1 },
        { clientId: 2, user: { name: "Ada", color: "#335de5" }, canvas: { cursor: { x: 0, y: 0 }, selection: [] } },
      ]);
      return () => undefined;
    },
  } as unknown as Pick<LiveSession, "setCanvasPresence" | "onAwarenessStates">;
  const surface = modelPresence(session, () => armed);
  const cursor = { cursor: { x: 3, y: 4 }, selection: ["Task_1"] };
  surface.setLocal(cursor);
  armed = true;
  surface.setLocal(cursor);
  assert.deepEqual(published, [null, cursor]);
  let drawn: unknown;
  surface.onRemote((peers) => (drawn = peers));
  assert.deepEqual(drawn, [
    { clientId: 2, user: { name: "Ada", color: "#335de5" }, canvas: { cursor: { x: 0, y: 0 }, selection: [] } },
  ]);
});
