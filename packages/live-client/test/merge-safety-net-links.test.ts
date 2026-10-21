/**
 * The merge safety net (#274) over links that lag, drop and re-sync: the
 * Live Host as a server with one link per peer (fixtures hub()). These are
 * the schedules in which a repair could lose an edit without telling its
 * writer, revert a peer's accepted edits, or write over typing that reached
 * the room bundled with a canvas write.
 *
 * Pinned: the repair keeps the canvas that took in the most, and every
 * writer whose edit is gone is told, also when its edit had been taken in by
 * another write, and also when it was offline as the repair landed; typing
 * that arrives in one update with a canvas write is never written over; a
 * first-ranked writer that cannot repair hands the repair on; and a repair
 * that crosses a lagging writer's repair settles in a second round.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { updateText } from "../src/text-diff.ts";
import {
  boundsOf,
  bpmnPeerOn,
  hub,
  LINES,
  linesPeerOn,
  QUIET,
  repairedBy,
  roomOf,
  SETTLED,
  thenCrossingDropsAreRepaired,
  wait,
  wellFormed,
  XML,
  xOf,
} from "./fixtures/safety-net.ts";

test("a write that another writer took in is kept by the repair, or its writer is told", async () => {
  // d moves a task twice; r takes in only the first, then r's link stalls; x
  // takes in the second and moves a task of its own; r moves on the old text,
  // once (x's canvas holds more and repairs) or three times (r's does)
  for (const staleMoves of [1, 3]) {
    const h = hub(roomOf(XML));
    const d = bpmnPeerOn(h.join(400));
    const r = bpmnPeerOn(h.join(50));
    const x = bpmnPeerOn(h.join(200));
    await wait(50);
    d.modeler.move("Task_d", 0, 50);
    await wait(QUIET);
    h.hold(r.doc);
    d.modeler.move("Task_d", 0, 50);
    await wait(QUIET);
    x.modeler.move("Task_e", 0, 50);
    await wait(QUIET);
    for (const id of ["Task_b", "Task_c", "Task_f"].slice(0, staleMoves)) {
      r.modeler.move(id, 0, 50);
      await wait(QUIET);
    }
    x.own = x.ytext.toString();
    r.own = r.ytext.toString();
    h.release(r.doc);
    assert.ok(!wellFormed(h.host.ytext.toString()));
    await wait(SETTLED);

    const text = h.host.ytext.toString();
    const repairer = repairedBy([d, r, x], (peer) => peer.modeler.canvas());
    if (staleMoves === 1) {
      assert.equal(repairer, x, "x's canvas took in the longest chain of writes");
      assert.deepEqual(boundsOf(text, "Task_d"), { x: 550, y: 180 }, "both of d's moves kept");
      assert.deepEqual(boundsOf(text, "Task_e"), { x: 700, y: 130 }, "x's move kept");
      assert.deepEqual(
        [d, r, x].map((peer) => peer.conflicts.length),
        [0, 1, 0],
        "only r's move is gone, and r is told",
      );
    } else {
      assert.equal(repairer, r, "r's three moves outrank x's one");
      assert.deepEqual(boundsOf(text, "Task_d"), { x: 550, y: 130 }, "d's second move is gone");
      assert.deepEqual(
        [d, r, x].map((peer) => peer.conflicts.length),
        [1, 0, 1],
        "x is told, and d too, although x's write had taken d's in",
      );
    }
    for (const peer of [d, r, x]) peer.unbind();
  }
});

test("four writers on a line notation: the repair by the canvas that holds the most loses only the stale move, with a toast", async () => {
  const h = hub(roomOf(LINES));
  const r = linesPeerOn(h.join(50));
  const d = linesPeerOn(h.join(400));
  const c = linesPeerOn(h.join(300));
  const x = linesPeerOn(h.join(200));
  await wait(50);
  h.hold(c.doc, "down");
  d.modeler.set("Task_d", 200);
  await wait(QUIET);
  h.hold(r.doc);
  // c receives d's move only now and drops before it took it in: a merge,
  // whose canvas holds no other write
  h.release(c.doc);
  await wait(30);
  c.modeler.set("Task_e", 300);
  await wait(QUIET);
  x.modeler.set("Task_f", 400);
  await wait(QUIET);
  r.modeler.set("Task_e", 700);
  await wait(QUIET);
  h.release(r.doc);
  await wait(SETTLED);

  const text = h.host.ytext.toString();
  for (const peer of [r, d, c, x]) assert.equal(peer.modeler.canvas(), text, "every canvas shows the shared text");
  assert.deepEqual(
    ["Task_d", "Task_e", "Task_f"].map((id) => xOf(text, id)),
    [200, 300, 400],
    "d's, c's and x's moves kept",
  );
  assert.deepEqual(h.host.log.repairs, [200], "x repairs: its canvas holds d's, c's and its own write");
  assert.deepEqual(
    [r, d, c, x].map((peer) => peer.conflicts.length),
    [1, 0, 0, 0],
  );
  for (const peer of [r, d, c, x]) peer.unbind();
});

test("a peer whose link stalled does not revert the edits the others accepted meanwhile", async () => {
  for (const [idA, idB] of [
    [200, 100],
    [100, 200],
  ] as const) {
    const h = hub(roomOf(XML));
    const a = bpmnPeerOn(h.join(idA));
    const b = bpmnPeerOn(h.join(idB));
    await wait(50);
    b.modeler.move("Task_a", 10, 10);
    await wait(QUIET);
    assert.deepEqual(boundsOf(a.modeler.canvas(), "Task_a"), { x: 110, y: 90 }, "a took in b's first move");
    h.hold(a.doc);
    for (const id of ["Task_c", "Task_e", "Task_f"]) {
      b.modeler.move(id, 0, 50);
      await wait(QUIET);
    }
    a.modeler.move("Task_b", 0, 70);
    await wait(QUIET);
    b.own = b.ytext.toString();
    h.release(a.doc);
    await wait(SETTLED);

    const where = `a ${idA}, b ${idB}`;
    assert.equal(
      repairedBy([a, b], (peer) => peer.modeler.canvas()),
      b,
      where,
    );
    const text = h.host.ytext.toString();
    assert.deepEqual(
      ["Task_c", "Task_e", "Task_f"].map((id) => boundsOf(text, id)?.y),
      [130, 130, 130],
      `${where}: b's three accepted moves stay`,
    );
    assert.deepEqual(
      [a.conflicts.length, b.conflicts.length],
      [1, 0],
      `${where}: a's stale move is lost, and a is told`,
    );
    a.unbind();
    b.unbind();
  }
});

test("a loser offline as the repair lands is told on reconnect, though the repairer edited on and the re-sync is one update", async () => {
  const h = hub(roomOf(XML));
  const a = bpmnPeerOn(h.join(100));
  const b = bpmnPeerOn(h.join(200));
  await wait(50);
  h.hold(a.doc, "down");
  h.hold(b.doc, "down");
  a.modeler.move("Task_b", 40, 30);
  b.modeler.move("Task_d", 35, -20);
  await wait(20);
  assert.ok(!wellFormed(h.host.ytext.toString()));
  // b's drop reached the room; b drops off before anything reaches it
  h.offline(b.doc);
  h.release(a.doc);
  await wait(SETTLED);
  assert.ok(wellFormed(h.host.ytext.toString()), "a repaired");
  a.modeler.move("Task_f", 10, 10);
  await wait(QUIET);
  h.reconnect(b.doc);
  await wait(SETTLED);

  const text = h.host.ytext.toString();
  assert.equal(b.modeler.canvas(), text, "b's canvas shows the room");
  assert.deepEqual(boundsOf(text, "Task_d"), { x: 550, y: 80 }, "b's move is gone");
  assert.deepEqual([a.conflicts.length, b.conflicts.length], [0, 1], "and b is told");
  a.unbind();
  b.unbind();
});

test("typing that reaches the room in one re-sync with its writer's canvas drop is never written over", async () => {
  for (const [idA, idB] of [
    [100, 200],
    [200, 100],
  ] as const) {
    const where = `a ${idA}, b ${idB}`;
    const h = hub(roomOf(XML));
    const a = bpmnPeerOn(h.join(idA));
    const b = bpmnPeerOn(h.join(idB));
    await wait(50);
    // b's link dies unnoticed: b types into the root element, then drops a
    // move (a merge around its own typing), while a drops one
    h.offline(b.doc);
    const root = b.ytext.toString().indexOf(">", b.ytext.toString().indexOf("<definitions"));
    b.doc.transact(() => b.ytext.insert(root, ' xmlns:x="http://'), { binding: "y-monaco" });
    await wait(30);
    b.modeler.move("Task_d", 35, -20);
    await wait(30);
    a.modeler.move("Task_b", 40, 30);
    await wait(QUIET);
    h.reconnect(b.doc);
    const merged = h.host.ytext.toString();
    assert.ok(merged.includes(' xmlns:x="http://') && !wellFormed(merged), where);
    await wait(SETTLED);

    assert.equal(h.host.ytext.toString(), merged, `${where}: the typing stays, nothing writes over it`);
    assert.deepEqual(h.host.log.repairs, [], where);
    assert.deepEqual([a.conflicts, b.conflicts], [[], []], where);

    await thenCrossingDropsAreRepaired(
      `${where}, the typing finished`,
      {
        hold: () => [a, b].forEach((peer) => h.hold(peer.doc, "down")),
        release: () => [a, b].forEach((peer) => h.release(peer.doc)),
      },
      h.host,
      [a, b],
      (whole) => b.doc.transact(() => updateText(b.ytext, whole), { binding: "y-monaco" }),
    );
    a.unbind();
    b.unbind();
  }
});

test("a first-ranked writer that has not taken in an agent's save stands down, and the next writer repairs around the save", async () => {
  const h = hub(roomOf(LINES));
  const a = linesPeerOn(h.join(200));
  const b = linesPeerOn(h.join(100));
  await wait(50);
  // the save reaches a at once and b a moment later, inside b's import debounce
  h.hold(b.doc, "down");
  updateText(h.host.ytext, LINES.replace("Task_a 100", "Task_a 900"));
  await wait(500);
  h.release(b.doc);
  await wait(50);
  h.hold(a.doc, "down");
  h.hold(b.doc, "down");
  a.modeler.set("Task_c", 300);
  b.modeler.set("Task_c", 500);
  await wait(20);
  a.own = a.ytext.toString();
  h.release(a.doc);
  h.release(b.doc);
  await wait(SETTLED);

  assert.equal(
    repairedBy([a, b], (peer) => peer.modeler.canvas()),
    a,
  );
  const text = h.host.ytext.toString();
  assert.deepEqual([xOf(text, "Task_a"), xOf(text, "Task_c")], [900, 300], "the save and a's edit kept");
  assert.deepEqual(h.host.log.repairs, [200]);
  assert.deepEqual([a.conflicts.length, b.conflicts.length], [0, 1]);
  a.unbind();
  b.unbind();
});

test("a writer lagging past the settle delay repairs too: the two repairs settle in a second round, and nobody is told twice", async () => {
  const h = hub(roomOf(XML));
  const a = bpmnPeerOn(h.join(100));
  const b = bpmnPeerOn(h.join(200));
  const c = bpmnPeerOn(h.join(300));
  await wait(50);
  h.hold(a.doc, "up");
  h.hold(b.doc, "up");
  a.modeler.move("Task_b", 40, 30);
  b.modeler.move("Task_d", 35, -20);
  c.modeler.move("Task_a", -30, 10);
  await wait(20);
  // a hears of nothing more; b's drop reaches the room, so b and c see b's and
  // c's drops and b repairs them, while a repairs a's and c's on its own
  h.hold(a.doc, "down");
  h.release(b.doc);
  await wait(2500);
  h.release(a.doc);
  await wait(SETTLED * 2);
  const changes = h.host.log.changes;
  await wait(2000);

  const text = h.host.ytext.toString();
  assert.ok(wellFormed(text));
  for (const peer of [a, b, c]) assert.equal(peer.modeler.canvas(), text, "converged");
  assert.equal(h.host.log.changes, changes, "and quiet: no ping-pong");
  assert.ok(h.host.log.repairs.length >= 2, "the two repairs crossed");
  for (const peer of [a, b, c]) assert.ok(peer.conflicts.length <= 1, "one toast per lost edit at most");
  assert.equal([a, b, c].filter((peer) => peer.conflicts.length === 0).length, 1, "the final repairer keeps its edit");
  for (const peer of [a, b, c]) peer.unbind();
});
