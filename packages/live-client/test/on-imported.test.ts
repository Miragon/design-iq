/**
 * SyncOptions.onImported: the host's signal that the canvas drew the shared
 * text (a model shown on a board is ready once it did). Pinned for both
 * paths the engine imports on, bpmn-js's (bindBpmn, the view put back or
 * fitted by the binding) and the contract's (bindMiragon): it comes after
 * every import that drew, once the view is in place, and never for what the
 * canvas shows already: its own edit, a text equal to its last export, the
 * repair it writes. A text the import refuses draws nothing, and a host
 * whose callback throws does not turn a drawn import into a failed one.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";

import * as Y from "yjs";

import { bindBpmn } from "../src/bpmn-sync.ts";
import { bindMiragon } from "../src/miragon-sync.ts";
import {
  bpmnLikeModeler,
  hostCopy,
  joinRoom,
  LINES,
  linesModeler,
  QUIET,
  relay,
  roomOf,
  SETTLED,
  wait,
  wellFormed,
  XML,
} from "./fixtures/safety-net.ts";

/** bpmn-js as bindBpmn uses it, its canvas and the host's callback writing into one log */
function recordingBpmn(log: string[]) {
  const modeler = bpmnLikeModeler();
  const { importXML } = modeler;
  return Object.assign(modeler, {
    get: () => ({
      viewbox(box?: unknown) {
        if (box) log.push("view put back");
        return { x: 0, y: 0, width: 100, height: 100 };
      },
      zoom: () => void log.push("fit"),
    }),
    async importXML(xml: string) {
      await importXML(xml);
      log.push("import");
    },
  });
}

/** a text change made by someone else: an agent's save, a peer's typing */
function remoteWrite(doc: Y.Doc, text: string): void {
  const ytext = doc.getText("content");
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, text);
  }, "remote");
}

test("bpmn: after the first import once it is fitted, after a peer's change once the view is back; never for the canvas's own edit or a text it shows", async () => {
  const log: string[] = [];
  const doc = joinRoom(relay(), roomOf(XML));
  const modeler = recordingBpmn(log);
  const unbind = bindBpmn(modeler as never, doc.getText("content"), doc, undefined, undefined, {
    onImported: () => log.push("imported"),
  });
  await wait(50);
  assert.deepEqual(log, ["import", "fit", "imported"], "the first import, fitted, then the signal");

  // the canvas's own edit goes into the text: nothing to draw
  log.length = 0;
  modeler.move("Task_b", 40, 30);
  await wait(QUIET);
  assert.deepEqual(log, []);

  // a remote write of exactly what the canvas shows is an echo
  remoteWrite(doc, modeler.canvas());
  await wait(QUIET);
  assert.deepEqual(log, []);

  // a peer's change: drawn, the view put back, then the signal
  const peer = bpmnLikeModeler();
  peer.move("Task_d", 10, 10);
  remoteWrite(doc, peer.canvas());
  await wait(QUIET);
  assert.deepEqual(log, ["import", "view put back", "imported"]);
  unbind();
});

test("bpmn: a text the import refuses draws nothing; the text that heals it does", async () => {
  const log: string[] = [];
  const doc = joinRoom(relay(), roomOf(XML));
  const unbind = bindBpmn(recordingBpmn(log) as never, doc.getText("content"), doc, undefined, undefined, {
    onImported: () => log.push("imported"),
  });
  await wait(50);
  log.length = 0;

  remoteWrite(doc, XML.replace("</definitions>", "</definitions"));
  await wait(QUIET);
  assert.deepEqual(log, [], "not well-formed: no import, no signal");

  const healed = bpmnLikeModeler();
  healed.move("Task_a", 5, 5);
  remoteWrite(doc, healed.canvas());
  await wait(QUIET);
  assert.deepEqual(log, ["import", "view put back", "imported"]);
  unbind();
});

test("bpmn: a host whose callback throws keeps a drawn import drawn", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const quiet = { error: console.error, warn: console.warn };
  const said: string[] = [];
  console.error = () => {};
  console.warn = (...args: unknown[]) => void said.push(String(args[0]));
  try {
    const errors: string[] = [];
    const notices: Array<string | null> = [];
    const doc = joinRoom(relay(), roomOf(XML));
    const modeler = recordingBpmn([]);
    let calls = 0;
    const unbind = bindBpmn(
      modeler as never,
      doc.getText("content"),
      doc,
      undefined,
      (message) => errors.push(message),
      {
        onImported: () => {
          calls++;
          throw new Error("the host failed");
        },
        onUnrenderable: (message) => notices.push(message),
      },
    );
    // past the notice delay of a text that does not render
    for (let elapsed = 0; elapsed < 6000; elapsed += 10) {
      mock.timers.tick(10);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(calls, 1);
    assert.deepEqual(errors, [], "no import error for the host's failure");
    assert.deepEqual(notices, [], "nor a text that does not render");
    assert.deepEqual(said, [], "nor a document that is not importable");
    unbind();
  } finally {
    console.error = quiet.error;
    console.warn = quiet.warn;
    mock.timers.reset();
  }
});

test("a modeler behind the contract: after every import it drew, never for its own edit", async () => {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, LINES);
  const modeler = linesModeler();
  let imported = 0;
  const unbind = bindMiragon(modeler, "lines", doc.getText("content"), doc, undefined, undefined, {
    onImported: () => void imported++,
  });
  await wait(50);
  assert.equal(imported, 1, "the first import");

  modeler.set("Task_c", 300);
  await wait(QUIET);
  assert.equal(imported, 1, "its own edit is in the text, nothing to draw");

  remoteWrite(doc, doc.getText("content").toString().replace("Task_e 100", "Task_e 200"));
  await wait(QUIET);
  assert.equal(imported, 2, "a peer's change");
  assert.match(modeler.canvas(), /^Task_e 200 100$/m);
  unbind();
});

test("a repair is no import: the repairer is not told again, the peer that takes the repair in is", async () => {
  const net = relay();
  const room = roomOf(XML);
  const host = hostCopy(net, room);
  const peer = (clientId: number) => {
    const doc = joinRoom(net, room, clientId);
    const modeler = bpmnLikeModeler();
    const counted = { imported: 0 };
    const unbind = bindBpmn(modeler as never, doc.getText("content"), doc, undefined, undefined, {
      onImported: () => void counted.imported++,
    });
    return { doc, modeler, counted, unbind };
  };
  const a = peer(200);
  const b = peer(100);
  await wait(50);
  assert.deepEqual([a.counted.imported, b.counted.imported], [1, 1]);

  // two moves cross on the wire: their merge is no well-formed text
  net.hold();
  a.modeler.move("Task_b", 40, 30);
  b.modeler.move("Task_d", 35, -20);
  await wait(20);
  net.release();
  assert.ok(!wellFormed(host.ytext.toString()), "the precondition of #274");
  await wait(SETTLED + QUIET);

  // b ranks first (equal footing, the lower client id) and writes its canvas over the merge
  assert.deepEqual(host.log.repairs, [100]);
  assert.equal(host.ytext.toString(), b.modeler.canvas());
  assert.equal(b.counted.imported, 1, "the repairer draws nothing: its canvas is the text");
  assert.equal(a.counted.imported, 2, "the other canvas draws the repair");
  a.unbind();
  b.unbind();
});
