/**
 * The engine's imports on the path bpmn-js and dmn-js take (bindBpmn,
 * bindDmn: no contract surface). The queue and the stop after an unbind live
 * in the shared engine, so they hold here as they do for a Miragon modeler
 * (interaction.test.ts): a re-import asked for while a slow one runs starts
 * none beside it but one follower, which reads the text when it starts; and
 * an import that settles after the unbind touches the modeler no more, which
 * may be destroyed by then.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { bindBpmn } from "../src/bpmn-sync.ts";
import {
  boundsOf,
  bpmnLikeModeler,
  bpmnPeerOn,
  joinRoom,
  QUIET,
  relay,
  roomOf,
  SETTLED,
  wait,
  XML,
} from "./fixtures/safety-net.ts";

/** bpmn-js as bindBpmn uses it, with an import the test holds open and a count of the views it is given */
function slowBpmn() {
  const modeler = bpmnLikeModeler();
  const { importXML } = modeler;
  const log = { imported: [] as string[], running: 0, mostRunning: 0, viewsSet: 0 };
  let gate: Promise<void> | undefined;
  return Object.assign(modeler, {
    slow: log,
    get: () => ({
      viewbox(box?: unknown) {
        if (box) log.viewsSet++;
        return { x: 0, y: 0, width: 100, height: 100 };
      },
      zoom: () => void log.viewsSet++,
    }),
    async importXML(xml: string) {
      log.running++;
      log.mostRunning = Math.max(log.mostRunning, log.running);
      try {
        while (gate) await gate;
        await importXML(xml);
        log.imported.push(xml);
      } finally {
        log.running--;
      }
    },
    /** holds every import until the returned release */
    hold(): () => void {
      let open!: () => void;
      gate = new Promise<void>((resolve) => (open = resolve));
      return () => {
        gate = undefined;
        open();
      };
    },
  });
}

function room() {
  const net = relay();
  const state = roomOf(XML);
  const doc = joinRoom(net, state, 200);
  const ytext = doc.getText("content");
  const modeler = slowBpmn();
  const conflicts: string[] = [];
  const unbindLocal = bindBpmn(modeler as never, ytext, doc, (message) => conflicts.push(message));
  const peer = bpmnPeerOn(joinRoom(net, state, 100));
  return { ytext, modeler, peer, conflicts, unbindLocal };
}

const xOfTask = (text: string, id: string): number | undefined => boundsOf(text, id)?.x;

test("bpmn-js: a peer's change that arrives while a slow import runs starts no import beside it, one follower of the latest text", async () => {
  const r = room();
  await wait(50);
  r.modeler.slow.imported.length = 0;
  const release = r.modeler.hold();

  r.peer.modeler.move("Task_f", 10, 0);
  await wait(QUIET);
  assert.equal(r.modeler.slow.running, 1, "the import of the peer's change runs");
  for (const id of ["Task_e", "Task_d"]) {
    r.peer.modeler.move(id, 10, 0);
    await wait(500);
  }
  await wait(QUIET);
  assert.equal(r.modeler.slow.running, 1, "the changes after it start none beside it");

  release();
  await wait(QUIET);
  assert.equal(r.modeler.slow.mostRunning, 1, "never two at once");
  assert.deepEqual(
    r.modeler.slow.imported.map((text) => ["Task_d", "Task_e", "Task_f"].map((id) => xOfTask(text, id))),
    [
      [550, 700, 860],
      [560, 710, 860],
    ],
    "the slow import, then one of the text as it is when the next one starts",
  );
  assert.equal(r.modeler.canvas(), r.ytext.toString(), "the canvas shows the shared text");
  assert.deepEqual([r.conflicts, r.peer.conflicts], [[], []]);
  r.unbindLocal();
  r.peer.unbind();
});

test("bpmn-js: an import that settles after the unbind touches nothing: no view restored, no import after it", async () => {
  const r = room();
  await wait(50);
  r.modeler.slow.imported.length = 0;
  const release = r.modeler.hold();

  r.peer.modeler.move("Task_f", 10, 0);
  await wait(QUIET);
  r.peer.modeler.move("Task_e", 10, 0);
  await wait(QUIET);
  assert.equal(r.modeler.slow.running, 1, "an import runs, a change waits behind it");
  const viewsSet = r.modeler.slow.viewsSet;
  const text = r.ytext.toString();

  r.unbindLocal();
  release();
  await wait(SETTLED);
  assert.equal(r.modeler.slow.viewsSet, viewsSet, "no view restored on the modeler");
  assert.equal(r.modeler.slow.imported.length, 1, "no import after the one that ran");
  assert.equal(r.ytext.toString(), text, "nothing written");
  assert.deepEqual(r.conflicts, []);
  r.peer.unbind();
});
