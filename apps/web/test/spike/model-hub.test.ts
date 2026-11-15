/**
 * The board spike's ModelHub (src/board-spike/model-hub.ts): one server doc per file, one replica
 * per bound editor, and an embed frame as one more replica behind a message channel. Run by hand:
 *
 *   node --test apps/web/test/spike/*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CONTENT_KEY } from "@designiq/contracts/live";
import * as Y from "yjs";

import {
  connectToHub,
  createModelHub,
  type FrameEvent,
  type FrameReceiver,
  type FrameTarget,
} from "../../src/board-spike/model-hub.ts";
import { FRAME_CHANNEL, FRAME_PROTOCOL } from "../../src/board-spike/shared.ts";

const PATH = "processes/a.bpmn";
const XML = '<definitions>\n  <task id="Task_a" x="100" />\n</definitions>\n';

/** the message queue between two windows has drained */
const delivered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Two windows that post to each other like a page and its iframe: a message is a structured clone,
 * arrives in a later task, and names the OTHER window as its source.
 */
function windows() {
  const sent: Array<{ to: "page" | "frame"; type: string }> = [];
  const make = (name: "page" | "frame") => {
    const listeners = new Set<(event: FrameEvent) => void>();
    const self: FrameTarget & FrameReceiver & { other?: unknown } = {
      postMessage(message) {
        sent.push({ to: name, type: (message as { type: string }).type });
        const data: unknown = structuredClone(message);
        const source = self.other;
        setTimeout(() => {
          for (const listener of [...listeners]) listener({ data, source });
        }, 0);
      },
      addEventListener: (_type, listener) => void listeners.add(listener),
      removeEventListener: (_type, listener) => void listeners.delete(listener),
    };
    return self;
  };
  const page = make("page");
  const frame = make("frame");
  page.other = frame;
  frame.other = page;
  return { page, frame, sent };
}

test("two replicas of one file converge, and the server copy is the file", () => {
  const hub = createModelHub({ files: { [PATH]: XML } });
  const a = hub.replica(PATH);
  const b = hub.replica(PATH);
  assert.equal(a.ytext.toString(), XML);
  assert.equal(b.ytext.toString(), XML);
  assert.notEqual(a.doc, b.doc, "a doc of its own per bound editor");
  assert.equal(hub.version(PATH), 0);

  const changes: number[] = [];
  const off = hub.onChange(PATH, () => {
    // every replica has caught up by the time a listener hears of the change
    assert.equal(b.ytext.toString(), hub.text(PATH));
    changes.push(hub.version(PATH));
  });
  a.ytext.insert(XML.indexOf("100"), "9");
  assert.equal(hub.text(PATH), XML.replace("100", "9100"));
  assert.equal(b.ytext.toString(), hub.text(PATH));
  b.ytext.delete(XML.indexOf("100"), 1);
  assert.equal(a.ytext.toString(), XML);
  assert.equal(hub.text(PATH), XML);
  assert.deepEqual(changes, [1, 2], "one version per text change");

  // a transaction that leaves the text alone (the bindings' write log) is no new version of the file
  a.doc.getMap("canvasWrites").set("x", 1);
  assert.equal(b.doc.getMap("canvasWrites").get("x"), 1, "and still reaches the other replica");
  assert.deepEqual(changes, [1, 2]);

  // a replica that left hears nothing more, and what it holds stays out of the file
  off();
  b.destroy();
  a.ytext.insert(0, "<!-- late -->");
  assert.equal(hub.text(PATH), `<!-- late -->${XML}`);
  assert.deepEqual(changes, [1, 2]);
  hub.destroy();
});

test("the file is seeded once: a late replica starts from the current text and adds none of its own", () => {
  const hub = createModelHub({ files: { [PATH]: XML } });
  const first = hub.replica(PATH);
  first.ytext.insert(0, "<!-- edited -->");
  const late = hub.replica(PATH);
  assert.equal(late.ytext.toString(), `<!-- edited -->${XML}`);
  const third = hub.replica(PATH);
  assert.equal(hub.text(PATH), `<!-- edited -->${XML}`, "no replica's join changed the file");
  assert.equal(hub.text(PATH)?.split("<definitions>").length, 2, "the seed is in the file once");
  assert.equal(hub.version(PATH), 1);
  assert.equal(third.ytext.toString(), hub.text(PATH));
  assert.throws(() => hub.replica("processes/none.bpmn"), /no such model file/);
  assert.equal(hub.text("processes/none.bpmn"), undefined);
  hub.destroy();
});

test("the file list: models, a text source of its own (the board) and assets", () => {
  const hub = createModelHub({
    files: { [PATH]: XML },
    assets: { "assets/sketch.svg": new Blob(["<svg/>"]) },
  });
  let board = "{}\n";
  const boardListeners = new Set<() => void>();
  let listed = 0;
  hub.onFiles(() => listed++);
  hub.addSource("boards/workshop.board", "board", {
    text: () => board,
    subscribe: (listener) => {
      boardListeners.add(listener);
      return () => boardListeners.delete(listener);
    },
  });
  assert.deepEqual(hub.files(), [
    { path: PATH, kind: "model", bytes: XML.length, version: 0 },
    { path: "boards/workshop.board", kind: "board", bytes: 3, version: 0 },
    { path: "assets/sketch.svg", kind: "asset", bytes: 6, version: 0 },
  ]);
  board = '{"ä":1}\n';
  for (const listener of boardListeners) listener();
  assert.equal(hub.text("boards/workshop.board"), board);
  assert.deepEqual(
    hub.files().find((file) => file.kind === "board"),
    { path: "boards/workshop.board", kind: "board", bytes: 9, version: 1 },
    "bytes, not characters",
  );
  hub.replica(PATH).ytext.insert(0, " ");
  assert.equal(listed, 3, "the new source, its change and the model's");
  assert.equal(hub.asset("assets/sketch.svg")?.size, 6);
  assert.equal(hub.asset("assets/none.png"), undefined);
  hub.destroy();
});

test("an embed frame behind a message channel converges with the page's replicas, with no echo", async () => {
  const { page, frame, sent } = windows();
  const log: string[] = [];
  const hub = createModelHub({ files: { [PATH]: XML }, receiver: page, targetOrigin: "*", log: (l) => log.push(l) });
  const inPage = hub.replica(PATH);
  inPage.ytext.insert(0, "<!-- before the frame -->");

  // the page attaches first and sends nothing: the frame is not listening yet
  const link = hub.attachFrame(PATH, frame, "frame-1");
  inPage.ytext.insert(0, "<!-- unheard -->");
  await delivered();
  assert.deepEqual(sent, [], "nothing goes to a frame that has not said hello");

  const connection = connectToHub({ frame: "frame-1", hub: page, receiver: frame, targetOrigin: "*" });
  assert.equal(connection.ytext.toString(), "", "the frame's replica starts empty: it never seeds itself");
  const state = await connection.ready;
  assert.equal(state.file, PATH);
  assert.equal(connection.ytext.toString(), hub.text(PATH), "the state covers what happened before the hello");
  assert.deepEqual(sent, [
    { to: "page", type: "hello" },
    { to: "frame", type: "state" },
  ]);

  // frame -> page: one update up, none back
  sent.length = 0;
  connection.ytext.insert(0, "<!-- from the frame -->");
  await delivered();
  assert.equal(hub.text(PATH), connection.ytext.toString());
  assert.equal(inPage.ytext.toString(), connection.ytext.toString());
  assert.deepEqual(sent, [{ to: "page", type: "update" }], "the frame's update is not sent back to it");

  // page -> frame: one update down, none back
  sent.length = 0;
  inPage.ytext.insert(0, "<!-- from the page -->");
  await delivered();
  assert.equal(connection.ytext.toString(), hub.text(PATH));
  assert.deepEqual(sent, [{ to: "frame", type: "update" }], "the frame does not send back what it was sent");

  // both at once: the two documents hold the same text afterwards, each insert once
  connection.ytext.insert(connection.ytext.length, "<!-- frame tail -->");
  inPage.ytext.insert(inPage.ytext.length, "<!-- page tail -->");
  await delivered();
  const text = hub.text(PATH) ?? "";
  assert.equal(connection.ytext.toString(), text);
  assert.equal(inPage.ytext.toString(), text);
  for (const part of ["<!-- frame tail -->", "<!-- page tail -->", "<definitions>"]) {
    assert.equal(text.split(part).length, 2, `${part} is in the file once`);
  }
  const fresh = hub.replica(PATH);
  assert.deepEqual(
    Y.encodeStateVector(connection.doc),
    Y.encodeStateVector(fresh.doc),
    "the frame holds what the file holds",
  );
  fresh.destroy();

  // ready, arm and log
  let frameArmed = false;
  connection.onArm((armed) => void (frameArmed = armed));
  await delivered();
  connection.reportReady();
  await link.ready;
  await link.arm(true);
  assert.equal(frameArmed, true);
  await link.arm(false);
  assert.equal(frameArmed, false);
  connection.log("conflict: your last action crossed a colleague's change");
  await delivered();
  assert.deepEqual(log, ["[frame-1] conflict: your last action crossed a colleague's change"]);

  // a message of another frame, of another version or from another window changes nothing
  const before = hub.text(PATH);
  const stray = Y.encodeStateAsUpdate(strayDoc());
  page.other = { name: "another window" };
  page.postMessage({ channel: FRAME_CHANNEL, v: FRAME_PROTOCOL, frame: "frame-1", type: "update", update: stray }, "*");
  page.other = frame;
  for (const message of [
    { channel: FRAME_CHANNEL, v: FRAME_PROTOCOL, frame: "frame-2", type: "update", update: stray },
    { channel: FRAME_CHANNEL, v: FRAME_PROTOCOL + 1, frame: "frame-1", type: "update", update: stray },
    { channel: "something-else", v: FRAME_PROTOCOL, frame: "frame-1", type: "update", update: stray },
  ]) {
    page.postMessage(message, "*");
  }
  await delivered();
  assert.equal(hub.text(PATH), before);

  // detached: the frame's edits stay in the frame
  link.detach();
  connection.ytext.insert(0, "<!-- detached -->");
  await delivered();
  assert.equal(hub.text(PATH), before);
  connection.disconnect();
  hub.destroy();
});

test("a frame that is armed before it loaded gets the flag with the state, and a failed import rejects ready", async () => {
  const { page, frame } = windows();
  const hub = createModelHub({ files: { [PATH]: XML }, receiver: page, targetOrigin: "*" });
  const link = hub.attachFrame(PATH, frame, "frame-1");
  let armedAnswered = false;
  const armed = link.arm(true).then(() => (armedAnswered = true));
  await delivered();
  assert.equal(armedAnswered, false, "no answer from a frame that is not there yet");

  const connection = connectToHub({ frame: "frame-1", hub: page, receiver: frame, targetOrigin: "*", helloEveryMs: 5 });
  await connection.ready;
  await delivered();
  assert.equal(armedAnswered, false, "nor before the frame's editor took the request");
  const seen: boolean[] = [];
  connection.onArm((value) => void seen.push(value));
  await armed;
  assert.deepEqual(seen, [true]);

  connection.reportReady("unparsable content");
  await assert.rejects(link.ready, /unparsable content/);
  connection.disconnect();
  hub.destroy();
});

/** a document that shares nothing with the hub's: applying its update would add a foreign text */
function strayDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.getText(CONTENT_KEY).insert(0, "<stray/>");
  return doc;
}
