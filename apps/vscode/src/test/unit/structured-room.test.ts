import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { CONTENT_KEY, ELEMENTS_KEY, META_KEY } from "@designiq/contracts/live";
import { reconcileSnapshot } from "@designiq/live-client/structured";
import { byExtension, NOTATIONS } from "@designiq/notations";
import { docCodecFor, jsonLinesCodec } from "@designiq/notations/codecs";
import * as Y from "yjs";

import {
  FOLLOW_REST_MS,
  followStructured,
  structuredCodec,
  structuredNoun,
  structuredText,
  webEditorLink,
} from "../../structured-room.ts";

// the house codec stands in for a notation's own: the lane reads any codec the same way
const codec = jsonLinesCodec();
const FILE = [
  '{"format":"structured-model","meta":{"title":"Overview"},"version":1}',
  '{"file":"processes/order.bpmn","id":"n_a","kind":"node","type":"model"}',
  '{"id":"n_b","kind":"node","text":"A note","type":"text"}',
  "",
].join("\n");

const roomOf = (text: string): Y.Doc => {
  const doc = new Y.Doc();
  reconcileSnapshot(doc, codec.decode(text));
  return doc;
};

test("structuredCodec: a path's notation decides, as the Live Host resolves it (docShape + codec)", () => {
  for (const n of NOTATIONS) {
    for (const ext of n.extensions) {
      const expected = n.docShape === "structured" ? docCodecFor(n.id) : undefined;
      assert.equal(structuredCodec(`processes/model${ext}`), expected, `${n.id} (${ext})`);
    }
  }
  assert.equal(structuredCodec("processes/order.bpmn"), undefined, "a text room keeps its Y.Text binding");
  assert.equal(structuredCodec("README"), undefined, "no notation, no codec");
});

test("structuredCodec: a board is a structured room, read as its own canonical text", () => {
  assert.equal(byExtension("processes/overview.board")?.docShape, "structured");
  const board = structuredCodec("acme/models/processes/overview.board");
  assert.ok(board, "a room name resolves like a path");
  assert.equal(structuredNoun("acme/models/processes/overview.board"), "board");
  const text = board.encode({
    elements: {
      n_model: {
        kind: "node",
        type: "model",
        file: "processes/order.bpmn",
        x: 0,
        y: 0,
        width: 480,
        height: 320,
        z: "a",
      },
      n_note: { kind: "node", type: "text", text: "Why", x: 520, y: 0, width: 240, height: 160, z: "b" },
      e_1: { kind: "edge", source: "n_note", target: "n_model" },
    },
    meta: { title: "Overview" },
  });
  assert.equal(board.check?.(text), undefined, "a text the board writes back as it is");
  const doc = new Y.Doc();
  reconcileSnapshot(doc, board.decode(text));
  assert.equal(structuredText(doc, board), text);
});

test("structuredText: the canonical encoding of the room, whatever its CONTENT_KEY holds", () => {
  const doc = roomOf(FILE);
  assert.equal(structuredText(doc, codec), FILE);
  // what an older client typed into the room's Y.Text is not the file
  doc.getText(CONTENT_KEY).insert(0, "typed into the wrong lane");
  assert.equal(structuredText(doc, codec), FILE);
  // the elements are: one changed attribute changes its line
  doc.transact(() => (doc.getMap(ELEMENTS_KEY).get("n_b") as Y.Map<unknown>).set("text", "B note"));
  assert.equal(structuredText(doc, codec), FILE.replace("A note", "B note"));
});

test("followStructured: one call once the elements and meta rest, none for CONTENT_KEY or after the stop", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const doc = roomOf(FILE);
    let calls = 0;
    const stop = followStructured(doc, () => calls++);
    const note = doc.getMap(ELEMENTS_KEY).get("n_b") as Y.Map<unknown>;

    // a drag: many changes, each before the rest is over
    for (let x = 0; x < 5; x++) {
      note.set("x", x);
      mock.timers.tick(FOLLOW_REST_MS - 1);
    }
    assert.equal(calls, 0, "still moving");
    mock.timers.tick(1);
    assert.equal(calls, 1, "one re-read after the rest");

    doc.getMap(META_KEY).set("title", "Renamed");
    mock.timers.tick(FOLLOW_REST_MS);
    assert.equal(calls, 2, "meta counts");

    const added = new Y.Map<unknown>();
    doc.getMap(ELEMENTS_KEY).set("n_c", added);
    mock.timers.tick(FOLLOW_REST_MS);
    assert.equal(calls, 3, "a new element counts");

    doc.getText(CONTENT_KEY).insert(0, "not the file");
    mock.timers.tick(FOLLOW_REST_MS);
    assert.equal(calls, 3, "CONTENT_KEY is not followed");

    note.set("x", 99);
    stop();
    mock.timers.tick(FOLLOW_REST_MS);
    note.set("x", 100);
    mock.timers.tick(FOLLOW_REST_MS);
    assert.equal(calls, 3, "a pending re-read and later changes end with the stop");
  } finally {
    mock.timers.reset();
  }
});

test("webEditorLink: the web app's file route, the repo the picker listed or <owner>/<name>", () => {
  const room = "acme/models/processes/overview.board";
  assert.equal(
    webEditorLink("https://design.example/", room),
    "https://design.example/r/acme/models/f/processes/overview.board",
  );
  // a listed repo wins over the two-segment guess, the longest one first
  assert.equal(
    webEditorLink("https://design.example", "group/sub/name/boards/a b.board", ["group/sub", "group/sub/name"]),
    "https://design.example/r/group/sub%2Fname/f/boards/a%20b.board",
  );
  // "acme/models-2" never claims a room of "acme/models"
  assert.equal(
    webEditorLink("https://design.example", room, ["acme/models-2"]),
    "https://design.example/r/acme/models/f/processes/overview.board",
  );
});
