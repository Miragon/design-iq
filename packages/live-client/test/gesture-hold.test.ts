/**
 * A gesture on the canvas holds back remote re-imports (#295). importText
 * replaces every shape, so a peer's change imported while a drag runs leaves
 * the drag working on shapes that are gone: its drop throws and the move is
 * lost. The engine reads the gesture from the DOM of the canvas host alone (a
 * pointer held on it, diagram-js's `djs-drag-active` marker inside it while a
 * drag preview is drawn or diagram-js's grabbing cursor is set), so it holds
 * for every diagram-js editor, Miragon renderer, bpmn-js or dmn-js.
 *
 * Pinned: a peer's change waits while a pointer is held on the canvas or a
 * drag that carries elements runs (a create also while its preview is off
 * the canvas), and is imported once the gesture ends, together with the edit
 * its drop committed; a pointer elsewhere holds nothing, and neither does an
 * armed palette tool (the marker with no preview) or a preview with no drag;
 * pointercancel, lostpointercapture and a lost window focus end a gesture;
 * after 10 s the import goes ahead, the gesture cancelled first the way
 * Escape cancels a diagram-js drag; a drop that touches the held change in
 * the text is a conflict, which keeps the peer's edit; and the merge safety
 * net (#274) repairs as before while a gesture runs. The real renderers in a
 * browser: apps/web/test/live-gesture-chromium.ts.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type * as Y from "yjs";

import { bindBpmn } from "../src/bpmn-sync.ts";
import { bindMiragon } from "../src/miragon-sync.ts";
import {
  boundsOf,
  bpmnLikeModeler,
  bpmnPeerOn,
  hostCopy,
  joinRoom,
  LINES,
  linesModeler,
  linesPeerOn,
  QUIET,
  relay,
  roomOf,
  SETTLED,
  wait,
  wellFormed,
  XML,
  xOf,
} from "./fixtures/safety-net.ts";

/** the canvas host's DOM as the engine reads it: its pointer events, its window's, the drag marker inside it */
function canvasHost(events: string[] = []) {
  class KeyboardEvent extends Event {
    readonly key: string;
    readonly code: string;
    constructor(type: string, init: KeyboardEventInit = {}) {
      super(type, init);
      this.key = init.key ?? "";
      this.code = init.code ?? "";
    }
  }
  const view = Object.assign(new EventTarget(), { KeyboardEvent });
  const cursors = new Set<string>();
  const page = Object.assign(new EventTarget(), {
    defaultView: view,
    body: { classList: { contains: (name: string) => cursors.has(name) } },
  });
  const dragMarkers: object[] = [];
  const dragPreviews: object[] = [];
  const element = Object.assign(new EventTarget(), {
    ownerDocument: page,
    getElementsByClassName: (name: string) =>
      name === "djs-drag-active" ? dragMarkers : name === "djs-dragger" ? dragPreviews : [],
  });
  page.addEventListener("keyup", (event) => {
    if ((event as KeyboardEvent).key === "Escape") events.push("escape");
  });
  const pointer = (type: string, pointerId: number): Event => Object.assign(new Event(type), { pointerId });
  return {
    element: element as unknown as Element,
    press: (pointerId = 1) => element.dispatchEvent(pointer("pointerdown", pointerId)),
    release: (type = "pointerup", pointerId = 1) => view.dispatchEvent(pointer(type, pointerId)),
    pressElsewhere: () => page.dispatchEvent(pointer("pointerdown", 1)),
    blur: () => view.dispatchEvent(new Event("blur")),
    startDrag: () => {
      dragMarkers.push({});
      dragPreviews.push({});
    },
    /** a palette tool waits for its press: diagram-js sets the marker, and draws nothing */
    armTool: () => void dragMarkers.push({}),
    /** a palette create with the pointer still off the canvas: the marker and the grabbing cursor, its preview not drawn */
    createOffCanvas: () => {
      dragMarkers.push({});
      cursors.add("djs-cursor-grabbing");
    },
    /** bpmn-js previews an append while its context pad entry is hovered: a preview, and no drag */
    previewAppend: () => void dragPreviews.push({}),
    endDrag: () => {
      dragMarkers.splice(0);
      dragPreviews.splice(0);
      cursors.clear();
    },
  };
}

/** a canvas of the line notation with a gesture host, and a peer's canvas that writes into the same room */
function room() {
  const net = relay();
  const state = roomOf(LINES);
  const doc: Y.Doc = joinRoom(net, state, 200);
  const ytext = doc.getText("content");
  const events: string[] = [];
  const host = canvasHost(events);
  const modeler = linesModeler();
  const importText = modeler.importText.bind(modeler);
  modeler.importText = (text) => {
    events.push("import");
    return importText(text);
  };
  const conflicts: string[] = [];
  const unbind = bindMiragon(modeler, "lines", ytext, doc, (message) => conflicts.push(message), undefined, {
    canvasHost: host.element,
  });
  const peer = linesPeerOn(joinRoom(net, state, 100));
  return {
    ytext,
    host,
    modeler,
    peer,
    events,
    conflicts,
    unbind: () => {
      unbind();
      peer.unbind();
    },
  };
}

/** both edits in the shared text, on both canvases, nobody told of a conflict */
function bothKept(r: ReturnType<typeof room>, local: number, remote: number): void {
  const text = r.ytext.toString();
  assert.equal(xOf(text, "Task_a"), local, "the local drop is in the shared text");
  assert.equal(xOf(text, "Task_f"), remote, "and the peer's change");
  assert.equal(r.modeler.canvas(), text, "the canvas shows the shared text");
  assert.equal(r.peer.modeler.canvas(), text, "and so does the peer's");
  assert.deepEqual([r.conflicts, r.peer.conflicts], [[], []], "nobody lost an edit");
}

test("a pointer held on the canvas holds a peer's change back; it is imported after the drop, with the dropped edit", async () => {
  const r = room();
  await wait(50);
  r.events.length = 0;

  r.host.press();
  r.peer.modeler.set("Task_f", 600);
  await wait(QUIET);
  assert.deepEqual(r.events, [], "no import while the pointer is down");
  assert.equal(xOf(r.modeler.canvas(), "Task_f"), 100, "the canvas the gesture works on is the one it started on");

  r.host.release();
  r.modeler.set("Task_a", 300);
  await wait(SETTLED);
  bothKept(r, 300, 600);
  assert.deepEqual(r.events, ["import"], "one import, after the drop");
  r.unbind();
});

test("a diagram-js drag holds it back with no button held (a palette create follows the pointer)", async () => {
  const r = room();
  await wait(50);
  r.events.length = 0;

  r.host.startDrag();
  r.peer.modeler.set("Task_f", 600);
  await wait(QUIET);
  assert.deepEqual(r.events, [], "no import while the marker is set and the preview drawn");

  r.host.endDrag();
  r.modeler.set("Task_a", 300);
  await wait(SETTLED);
  bothKept(r, 300, 600);
  r.unbind();
});

test("a palette create whose preview is off the canvas holds it back too: diagram-js's cursor says it carries elements", async () => {
  const r = room();
  await wait(50);
  r.events.length = 0;

  r.host.createOffCanvas();
  r.peer.modeler.set("Task_f", 600);
  await wait(QUIET);
  assert.deepEqual(r.events, [], "no import while the create carries its elements");

  r.host.endDrag();
  r.modeler.set("Task_a", 300);
  await wait(SETTLED);
  bothKept(r, 300, 600);
  r.unbind();
});

test("an armed palette tool holds nothing back, and no Escape disarms it, also past 10 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const r = room();
  await advance(t, 50);
  r.events.length = 0;

  r.host.armTool();
  r.peer.modeler.set("Task_f", 600);
  await advance(t, 600);
  assert.deepEqual(r.events, ["import"], "imported after the debounce");
  assert.equal(xOf(r.modeler.canvas(), "Task_f"), 600);

  r.peer.modeler.set("Task_f", 700);
  await advance(t, 11_000);
  assert.deepEqual(r.events, ["import", "import"], "every change is imported, none cancels the tool");
  assert.equal(xOf(r.modeler.canvas(), "Task_f"), 700);
  r.unbind();
});

test("a preview with no drag holds nothing back", async () => {
  const r = room();
  await wait(50);
  r.events.length = 0;

  r.host.previewAppend();
  r.peer.modeler.set("Task_f", 600);
  await wait(QUIET);
  assert.deepEqual(r.events, ["import"]);
  assert.equal(xOf(r.modeler.canvas(), "Task_f"), 600);
  r.unbind();
});

test("a pointer pressed outside the canvas holds nothing back", async () => {
  const r = room();
  await wait(50);
  r.events.length = 0;

  r.host.pressElsewhere();
  r.peer.modeler.set("Task_f", 600);
  await wait(QUIET);
  assert.deepEqual(r.events, ["import"]);
  assert.equal(xOf(r.modeler.canvas(), "Task_f"), 600);
  r.unbind();
});

test("pointercancel, lostpointercapture and a lost window focus end a gesture; a second pointer keeps it going", async () => {
  for (const end of ["pointercancel", "lostpointercapture", "blur"]) {
    const r = room();
    await wait(50);
    r.events.length = 0;

    r.host.press(1);
    r.host.press(2);
    r.peer.modeler.set("Task_f", 600);
    await wait(QUIET);
    if (end !== "blur") {
      r.host.release(end, 1);
      await wait(QUIET);
      assert.deepEqual(r.events, [], `${end}: the other pointer is still down`);
      r.host.release(end, 2);
    } else {
      r.host.blur();
    }
    await wait(QUIET);
    assert.deepEqual(r.events, ["import"], `${end}: ends the gesture`);
    assert.equal(xOf(r.modeler.canvas(), "Task_f"), 600, end);
    r.unbind();
  }
});

/** advances the mocked clock in steps, letting the imports' promises settle between them */
async function advance(t: TestContext, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 50) {
    t.mock.timers.tick(Math.min(50, left));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a gesture that outlasts 10 s gives way: it is cancelled the way Escape does, then the peer's change is imported", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const r = room();
  await advance(t, 50);
  r.events.length = 0;

  r.host.press();
  r.peer.modeler.set("Task_f", 600);
  await advance(t, 350 + 9_500);
  assert.deepEqual(r.events, [], "held for nearly 10 s");
  await advance(t, 600);
  assert.deepEqual(r.events, ["escape", "import"], "the gesture is cancelled before the import replaces its shapes");
  assert.equal(xOf(r.modeler.canvas(), "Task_f"), 600, "the canvas shows the peer's change");

  r.host.release();
  await advance(t, 2_000);
  assert.deepEqual(r.events, ["escape", "import"], "the release changes nothing more");
  assert.equal(r.ytext.toString(), r.modeler.canvas());
  assert.deepEqual([r.conflicts, r.peer.conflicts], [[], []]);
  r.unbind();
});

test("the 10 s are counted per wait: a change a peer took back during one gesture does not shorten the next", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const r = room();
  await advance(t, 50);
  r.events.length = 0;

  r.host.press();
  r.peer.modeler.set("Task_f", 600);
  await advance(t, 6_000);
  r.peer.modeler.set("Task_f", 100);
  await advance(t, 1_000);
  r.host.release();
  await advance(t, 5_000);
  assert.deepEqual(r.events, [], "the text is back where the canvas is: nothing to import");

  r.host.press();
  r.peer.modeler.set("Task_f", 700);
  await advance(t, 350 + 8_000);
  assert.deepEqual(r.events, [], "the second gesture is held for its own 10 s");
  r.host.release();
  await advance(t, 500);
  assert.deepEqual(r.events, ["import"]);
  assert.equal(xOf(r.modeler.canvas(), "Task_f"), 700);
  r.unbind();
});

test("a drop that touches the held change in the text is a conflict: the peer's edit stays, the canvas is told once and shows it", async () => {
  const net = relay();
  const state = roomOf(XML);
  const shared = hostCopy(net, state);
  const doc = joinRoom(net, state, 200);
  const host = canvasHost();
  const modeler = bpmnLikeModeler();
  const conflicts: string[] = [];
  const unbind = bindBpmn(
    modeler as never,
    doc.getText("content"),
    doc,
    (message) => conflicts.push(message),
    undefined,
    { canvasHost: host.element },
  );
  const peer = bpmnPeerOn(joinRoom(net, state, 100));
  await wait(50);
  const start = boundsOf(XML, "Task_f")!;

  host.press();
  peer.modeler.move("Task_f", 40, 0);
  await wait(QUIET);
  assert.deepEqual(boundsOf(modeler.canvas(), "Task_f"), start, "held while the pointer is down");
  host.release();
  // the BPMN-like export writes a moved task's DI last: the drop rewrites the text down to the peer's line
  modeler.move("Task_a", 30, 0);
  await wait(SETTLED);

  const text = shared.ytext.toString();
  assert.deepEqual(boundsOf(text, "Task_f"), { x: start.x + 40, y: start.y }, "the peer's edit stays");
  assert.deepEqual(boundsOf(text, "Task_a"), boundsOf(XML, "Task_a"), "the drop gave way to it");
  assert.equal(modeler.canvas(), text, "the canvas shows the shared text");
  assert.equal(peer.modeler.canvas(), text, "and so does the peer's");
  assert.equal(conflicts.length, 1, "the canvas whose drop gave way is told, once");
  assert.match(conflicts[0]!, /crossed a colleague's change and could not be merged/);
  assert.deepEqual(peer.conflicts, []);
  assert.deepEqual(shared.log.repairs, [], "the text never broke: nothing to repair");
  unbind();
  peer.unbind();
});

test("the merge safety net (#274) repairs as before while a gesture runs, on the repairing canvas and on the one it overwrites", async () => {
  for (const gestureOn of ["repairer", "loser"] as const) {
    const net = relay();
    const state = roomOf(XML);
    const shared = hostCopy(net, state);
    const peers = [100, 200].map((clientId) => {
      const doc = joinRoom(net, state, clientId);
      const modeler = bpmnLikeModeler();
      const host = canvasHost();
      const conflicts: string[] = [];
      const unbind = bindBpmn(
        modeler as never,
        doc.getText("content"),
        doc,
        (message) => conflicts.push(message),
        undefined,
        { canvasHost: host.element },
      );
      return { modeler, host, conflicts, unbind, own: "" };
    });
    const [repairer, loser] = peers as [(typeof peers)[0], (typeof peers)[0]];
    const holding = gestureOn === "repairer" ? repairer : loser;
    await wait(50);

    net.hold();
    repairer.modeler.move("Task_b", 40, 30);
    loser.modeler.move("Task_d", 35, -20);
    await wait(20);
    repairer.own = repairer.modeler.canvas();
    holding.host.press();
    net.release();
    assert.ok(!wellFormed(shared.ytext.toString()), `${gestureOn}: the crossing drops broke the merge`);
    await wait(SETTLED);

    assert.deepEqual(shared.log.repairs, [100], `${gestureOn}: one repair, by the first-ranked writer`);
    assert.equal(shared.ytext.toString(), repairer.own, `${gestureOn}: its export`);
    assert.equal(loser.conflicts.length, 1, `${gestureOn}: the overwritten writer is told`);
    assert.deepEqual(repairer.conflicts, [], gestureOn);
    if (gestureOn === "loser") {
      assert.notEqual(loser.modeler.canvas(), repairer.own, "the loser's canvas waits for its gesture to end");
      loser.host.release();
      await wait(QUIET);
    }
    for (const peer of peers) assert.equal(peer.modeler.canvas(), repairer.own, `${gestureOn}: both canvases show it`);
    assert.deepEqual(boundsOf(shared.ytext.toString(), "Task_b"), { x: 290, y: 110 }, gestureOn);
    holding.host.release();
    for (const peer of peers) peer.unbind();
  }
});
