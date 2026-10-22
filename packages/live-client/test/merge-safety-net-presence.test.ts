/**
 * The merge safety net (#274) where the repair does not come (#296). Real
 * Y.Docs behind the relay and the hub of the other safety-net suites, the
 * room's awareness faked per peer (presence()), and the clock mocked: the
 * cases step through settle delays and notice delays without waiting them.
 *
 * Pinned: when the first-ranked writer leaves (its tab closed, its
 * connection lost) before its settle delay ends, the next-ranked writer
 * repairs in its place; when the text stays unrenderable for longer than a
 * repair takes (typing that a repair never writes over), every canvas peer
 * is told once, and the notice is withdrawn when a text renders; a merge a
 * repair heals tells nobody.
 */
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import { CANVAS_LOSSES_KEY } from "@designiq/contracts/live";

import { bindMiragon } from "../src/miragon-sync.ts";
import { updateText } from "../src/text-diff.ts";
import {
  boundsOf,
  bpmnLikeModeler,
  bpmnPeer,
  bpmnPeerOn,
  hostCopy,
  hub,
  joinRoom,
  linesModeler,
  presence,
  relay,
  repairedBy,
  roomOf,
  wellFormed,
  XML,
} from "./fixtures/safety-net.ts";

const NOTICE = "The shared text cannot be rendered. Your canvas shows the last good state.";

/** the clock and the timers the engine reads, from a time past its quiet periods */
function mockClock(): void {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
}

/** move the mocked clock on, letting each import's promises settle between steps */
async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 10) {
    mock.timers.tick(10);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

afterEach(() => mock.timers.reset());

test("the first-ranked writer closes its tab before its settle delay ends: the next-ranked writer repairs", async () => {
  // past the drop, before the leaver has decided; then inside its settle delay
  for (const leavesAfter of [100, 1100]) {
    mockClock();
    const net = relay();
    const room = roomOf(XML);
    const host = hostCopy(net, room);
    const people = presence();
    const a = bpmnPeer(net, room, 200, people.of(200));
    const b = bpmnPeer(net, room, 100, people.of(100));
    await advance(50);

    net.hold();
    a.modeler.move("Task_b", 40, 30);
    b.modeler.move("Task_d", 35, -20);
    await advance(20);
    a.own = a.ytext.toString();
    b.own = b.ytext.toString();
    net.release();
    assert.ok(!wellFormed(host.ytext.toString()), "the precondition of #274");
    await advance(leavesAfter);
    // b ranks first (equal footing, the lower client id) and is gone
    b.unbind();
    people.leave(100);
    await advance(3000);

    const where = `left after ${leavesAfter} ms`;
    assert.ok(wellFormed(host.ytext.toString()), `${where}: a fresh session can render the room`);
    assert.equal(host.ytext.toString(), a.own, `${where}: the next-ranked writer's export`);
    assert.equal(a.modeler.canvas(), a.own, where);
    assert.deepEqual(host.log.repairs, [200], `${where}: one repair, by the next-ranked writer`);
    assert.deepEqual(a.conflicts, [], `${where}: the repairer keeps its edit`);
    assert.equal(
      host.doc.getMap(CANVAS_LOSSES_KEY).get("100"),
      1,
      `${where}: the loss notice waits for the writer who left`,
    );
    a.unbind();
    mock.timers.reset();
  }
});

test("the first-ranked writer loses its connection before its settle delay ends: the next-ranked writer repairs, and all converge once it is back", async () => {
  mockClock();
  const room = roomOf(XML);
  const net = hub(room);
  const people = presence();
  const a = bpmnPeerOn(net.join(200), people.of(200));
  const b = bpmnPeerOn(net.join(100), people.of(100));
  const watcher = bpmnPeerOn(net.join(300), people.of(300));
  await advance(50);

  net.hold(a.doc);
  net.hold(b.doc);
  a.modeler.move("Task_b", 40, 30);
  b.modeler.move("Task_d", 35, -20);
  await advance(20);
  a.own = a.ytext.toString();
  b.own = b.ytext.toString();
  net.release(a.doc);
  net.release(b.doc);
  assert.ok(!wellFormed(net.host.ytext.toString()));
  await advance(1100);
  // b's link drops inside its settle delay: its repair stays on its side
  net.offline(b.doc);
  people.leave(100);
  await advance(3000);

  assert.equal(net.host.ytext.toString(), a.own, "the room holds the next-ranked writer's repair");
  assert.deepEqual(net.host.log.repairs, [200]);
  assert.equal(watcher.modeler.canvas(), a.own, "the watcher shows it");

  net.reconnect(b.doc);
  people.rejoin(100);
  await advance(6000);
  // its own repair, made offline, reaches the room only now: the two settle like a lagging writer's
  repairedBy([a, b, watcher], (peer) => peer.modeler.canvas());
  assert.ok(wellFormed(net.host.ytext.toString()), "a text every session renders");
  assert.deepEqual(watcher.conflicts, [], "nothing of the watcher's was lost");
  for (const peer of [a, b, watcher]) peer.unbind();
});

test("a writer that leaves without ranking first changes nothing: the first-ranked one repairs", async () => {
  mockClock();
  const net = relay();
  const room = roomOf(XML);
  const host = hostCopy(net, room);
  const people = presence();
  const a = bpmnPeer(net, room, 200, people.of(200));
  const b = bpmnPeer(net, room, 100, people.of(100));
  await advance(50);

  net.hold();
  a.modeler.move("Task_b", 40, 30);
  b.modeler.move("Task_d", 35, -20);
  await advance(20);
  b.own = b.ytext.toString();
  net.release();
  await advance(1100);
  a.unbind();
  people.leave(200);
  await advance(3000);

  assert.equal(host.ytext.toString(), b.own);
  assert.deepEqual(host.log.repairs, [100]);
  b.unbind();
});

test("typing in the source view crosses two drops: no repair, and after the notice delay every canvas is told until a text renders", async () => {
  mockClock();
  const net = relay();
  const room = roomOf(XML);
  const host = hostCopy(net, room);
  const people = presence();
  const a = bpmnPeer(net, room, 200, people.of(200));
  const b = bpmnPeer(net, room, 100, people.of(100));
  const typist = joinRoom(net, room);
  const source = typist.getText("content");
  await advance(50);

  net.hold();
  a.modeler.move("Task_b", 40, 30);
  b.modeler.move("Task_d", 35, -20);
  await advance(20);
  const own = [a.ytext.toString(), b.ytext.toString()];
  const end = source.toString().indexOf("  </process>");
  typist.transact(() => source.insert(end, '    <task id="Task_g" name="Ship'), { binding: "y-monaco" });
  net.release();
  const merged = host.ytext.toString();

  await advance(4000);
  assert.deepEqual([a.notices, b.notices], [[], []], "a repair could still come");
  await advance(2500);
  assert.equal(host.ytext.toString(), merged, "the typing is never written over");
  assert.deepEqual(host.log.repairs, []);
  assert.deepEqual([a.modeler.canvas(), b.modeler.canvas()], own, "each canvas keeps its last good state");
  assert.deepEqual([a.notices, b.notices], [[NOTICE], [NOTICE]], "each canvas peer is told, once");

  // more typing, still unrenderable: no second notice
  typist.transact(() => source.insert(source.toString().indexOf("Ship") + 4, " goods"), { binding: "y-monaco" });
  await advance(2000);
  assert.deepEqual([a.notices, b.notices], [[NOTICE], [NOTICE]]);

  const fixed = bpmnLikeModeler();
  fixed.move("Task_c", 0, 90);
  typist.transact(() => updateText(source, fixed.canvas()), { binding: "y-monaco" });
  await advance(1500);
  assert.deepEqual(
    [a.notices, b.notices],
    [
      [NOTICE, null],
      [NOTICE, null],
    ],
    "the notice goes once the text renders",
  );
  assert.deepEqual(boundsOf(a.modeler.canvas(), "Task_c"), { x: 400, y: 170 });
  a.unbind();
  b.unbind();
});

test("the notice waits for a text that changed meanwhile: a repair that lands at the end of the delay shows none", async () => {
  mockClock();
  const net = relay();
  const room = roomOf(XML);
  const people = presence();
  const a = bpmnPeer(net, room, 200, people.of(200));
  const typist = joinRoom(net, room);
  const source = typist.getText("content");
  await advance(50);

  const broken = source.toString().replace("<definitions", "<definitions <");
  typist.transact(() => updateText(source, broken), { binding: "y-monaco" });
  // the canvas finds it unrenderable after the import's debounce
  await advance(400);
  assert.deepEqual(a.notices, []);
  // a fix lands just before the notice is due; its import is still debounced then
  await advance(4900);
  typist.transact(() => updateText(source, XML), { binding: "y-monaco" });
  await advance(100);
  assert.deepEqual(a.notices, [], "not told about a text that is already gone");
  await advance(1000);
  assert.deepEqual(a.notices, []);
  assert.equal(a.modeler.canvas(), XML);
  a.unbind();
});

test("a merge the repair heals tells nobody", async () => {
  mockClock();
  const net = relay();
  const room = roomOf(XML);
  const host = hostCopy(net, room);
  const people = presence();
  const peers = [300, 200, 100].map((clientId) => bpmnPeer(net, room, clientId, people.of(clientId)));
  await advance(50);

  net.hold();
  peers.forEach((peer, index) => peer.modeler.move(`Task_${"bcd"[index]}`, 20, 30));
  await advance(20);
  net.release();
  await advance(10_000);

  assert.ok(wellFormed(host.ytext.toString()));
  assert.deepEqual(host.log.repairs, [100]);
  assert.deepEqual(
    peers.map((peer) => peer.notices),
    [[], [], []],
  );
  for (const peer of peers) peer.unbind();
});

test("a document that never rendered gets the first import's report, not this notice", async () => {
  mockClock();
  const net = relay();
  const doc = joinRoom(net, roomOf("Task_a 1x0 100\n"), 100);
  const imports: string[] = [];
  const notices: Array<string | null> = [];
  const unbind = bindMiragon(
    linesModeler(),
    "lines",
    doc.getText("content"),
    doc,
    undefined,
    (message) => imports.push(message),
    {
      awareness: presence().of(100),
      onUnrenderable: (message) => notices.push(message),
    },
  );
  await advance(10_000);
  assert.equal(imports.length, 1, "the shell falls back to the source on this report");
  assert.deepEqual(notices, [], "there is no last good state the canvas could be showing");
  unbind();
});
