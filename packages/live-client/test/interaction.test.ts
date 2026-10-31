/**
 * A Miragon modeler reports a gesture itself (contract 1.5's interaction
 * surface), and since 1.6 an import called during the user's running action
 * waits until the action has finished (L1). The Miragon binding follows the
 * host snippet of @miragon/modeler-api's README (Miragon/modeler-suite#352)
 * on the shared engine, against a fake of the line notation that keeps those
 * rules. Pinned:
 *
 *  1. a peer's change waits while `interaction.active()` is true and comes in
 *     once `onChange(false)` does, together with the drop, also where the
 *     modeler reports the end before the drop's change event, and at once
 *     after a gesture that ends with no change; the binding listens for the
 *     end instead of asking again and again, and the canvas host's DOM is
 *     never read, so a pointer held on it holds nothing back;
 *  2. a gesture held past 10 s ends in the modeler's own import: no Escape
 *     is sent, and the cancel inside that import starts no second one;
 *  3. a canvas edit is in the shared text before the change listener returns,
 *     and no import starts inside that listener, also not the one after a
 *     canvas edit that gives way to a peer's change of the same line;
 *  4. a canvas edit made while an import waits for the user's action merges
 *     with the peer's change that import brings, and the next import shows
 *     both;
 *  5. imports run one at a time in call order, and the changes that arrive
 *     meanwhile make one more import, of the text as it is when it starts;
 *  6. after the unbind nothing runs: no import, no listener, no timer.
 *
 * The DOM path bpmn-js and dmn-js keep: gesture-hold.test.ts.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { CollaborativeModeler } from "@miragon/modeler-api";
import type * as Y from "yjs";

import { bindMiragon, type SyncOptions } from "../src/miragon-sync.ts";
import {
  joinRoom,
  LINES,
  linesModeler,
  linesPeerOn,
  QUIET,
  relay,
  roomOf,
  SETTLED,
  wait,
  xOf,
} from "./fixtures/safety-net.ts";

/**
 * The line notation with the rules of contract 1.6 a host relies on: the
 * interaction surface, an import that waits for the user's running action
 * and cancels a running gesture before it replaces the document (L1).
 */
function contractModeler() {
  const lines = linesModeler();
  const gestureListeners = new Set<(active: boolean) => void>();
  const log = {
    imports: [] as string[],
    running: 0,
    mostRunning: 0,
    viewsSet: 0,
    contentListeners: 0,
    importsInChangeListener: 0,
    gestureReads: 0,
  };
  let gesture = false;
  let inChangeListener = 0;
  let action: Promise<void> | undefined;
  const report = (active: boolean): void => {
    gesture = active;
    for (const listener of [...gestureListeners]) listener(active);
  };
  const modeler: CollaborativeModeler & {
    set(id: string, x: number): void;
    canvas(): string;
    log: typeof log;
    gestureListeners: typeof gestureListeners;
    startGesture(): void;
    drop(id: string, x: number, endFirst?: boolean): void;
    cancelGesture(): void;
    startAction(): (edit?: [id: string, x: number]) => void;
  } = {
    meta: lines.meta,
    attachTo: () => {},
    async importText(text) {
      if (inChangeListener > 0) log.importsInChangeListener++;
      log.running++;
      log.mostRunning = Math.max(log.mostRunning, log.running);
      try {
        while (action) await action;
        if (gesture) report(false);
        const result = await lines.importText(text);
        log.imports.push(text);
        return result;
      } finally {
        log.running--;
      }
    },
    exportText: () => lines.exportText(),
    onContentChanged(cb) {
      log.contentListeners++;
      const off = lines.onContentChanged(() => {
        inChangeListener++;
        try {
          cb();
        } finally {
          inChangeListener--;
        }
      });
      return () => {
        log.contentListeners--;
        off();
      };
    },
    getViewState: () => ({ zoom: 1 }),
    setViewState: () => void log.viewsSet++,
    destroy: () => {},
    interaction: {
      active() {
        log.gestureReads++;
        return gesture;
      },
      onChange(listener) {
        gestureListeners.add(listener);
        return () => void gestureListeners.delete(listener);
      },
    },
    set: (id, x) => lines.set(id, x),
    canvas: () => lines.canvas(),
    log,
    gestureListeners,
    startGesture: () => report(true),
    /** the release that ends a gesture and runs its drop's command, in one handler */
    drop(id, x, endFirst = false) {
      if (endFirst) report(false);
      lines.set(id, x);
      if (!endFirst) report(false);
    },
    /** the user's Escape, or a drop where the gesture began: the gesture ends with no change */
    cancelGesture: () => report(false),
    /** a running user action (a drop with the steps it schedules): an import called meanwhile waits for its end */
    startAction() {
      let finish!: () => void;
      action = new Promise<void>((resolve) => (finish = resolve));
      return (edit) => {
        if (edit) lines.set(...edit);
        action = undefined;
        finish();
      };
    },
  };
  return modeler;
}

/** a canvas of the line notation behind the contract, and a peer's canvas that writes into the same room */
function room(sync?: SyncOptions) {
  const net = relay();
  const state = roomOf(LINES);
  const doc: Y.Doc = joinRoom(net, state, 200);
  const ytext = doc.getText("content");
  const modeler = contractModeler();
  const conflicts: string[] = [];
  const reported: string[] = [];
  const unbindLocal = bindMiragon(
    modeler,
    "lines",
    ytext,
    doc,
    (message) => conflicts.push(message),
    (message) => reported.push(message),
    sync,
  );
  const peer = linesPeerOn(joinRoom(net, state, 100));
  return {
    ytext,
    modeler,
    peer,
    conflicts,
    reported,
    unbindLocal,
    unbind: () => {
      unbindLocal();
      peer.unbind();
    },
  };
}

/** both edits in the shared text, on both canvases, nobody told of a conflict */
function bothKept(r: ReturnType<typeof room>, local: number, remote: number): void {
  const text = r.ytext.toString();
  assert.equal(xOf(text, "Task_a"), local, "the local edit is in the shared text");
  assert.equal(xOf(text, "Task_f"), remote, "and the peer's change");
  assert.equal(r.modeler.canvas(), text, "the canvas shows the shared text");
  assert.equal(r.peer.modeler.canvas(), text, "and so does the peer's");
  assert.deepEqual([r.conflicts, r.peer.conflicts], [[], []], "nobody lost an edit");
}

/**
 * A canvas host's DOM as the DOM path reads it, with a pointer to press on
 * it: it counts every listener added to it or its window and every Escape
 * sent to its page.
 */
function canvasHost() {
  const seen = { listeners: 0, escapes: 0 };
  class KeyboardEvent extends Event {
    readonly key: string;
    constructor(type: string, init: KeyboardEventInit = {}) {
      super(type, init);
      this.key = init.key ?? "";
    }
  }
  const counted = <T extends EventTarget>(target: T): T => {
    const add = target.addEventListener.bind(target);
    target.addEventListener = (...args: Parameters<EventTarget["addEventListener"]>) => {
      seen.listeners++;
      add(...args);
    };
    return target;
  };
  const view = counted(Object.assign(new EventTarget(), { KeyboardEvent }));
  const page = Object.assign(new EventTarget(), {
    defaultView: view,
    body: { classList: { contains: () => false } },
  });
  page.addEventListener("keyup", (event) => {
    if ((event as KeyboardEvent).key === "Escape") seen.escapes++;
  });
  const element = counted(
    Object.assign(new EventTarget(), { ownerDocument: page, getElementsByClassName: (): unknown[] => [] }),
  );
  return {
    element: element as unknown as Element,
    press: () => element.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerId: 1 })),
    seen,
  };
}

/** advances the mocked clock in steps, letting the imports' promises settle between them */
async function advance(t: TestContext, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 50) {
    t.mock.timers.tick(Math.min(50, left));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a peer's change waits while the modeler reports a gesture, and comes in with the drop once the gesture ends", async () => {
  for (const endFirst of [false, true]) {
    const what = endFirst ? "the end reported before the drop's change event" : "the end reported after the drop";
    const r = room();
    await wait(50);
    r.modeler.log.imports.length = 0;

    r.modeler.startGesture();
    const readsBefore = r.modeler.log.gestureReads;
    r.peer.modeler.set("Task_f", 600);
    await wait(QUIET);
    assert.deepEqual(r.modeler.log.imports, [], `${what}: no import while the gesture runs`);
    assert.equal(xOf(r.modeler.canvas(), "Task_f"), 100, `${what}: the canvas the gesture works on stays`);
    assert.ok(
      r.modeler.log.gestureReads - readsBefore <= 2,
      `${what}: the binding waits for the end the modeler reports, it does not ask again and again (${r.modeler.log.gestureReads - readsBefore} reads)`,
    );

    r.modeler.drop("Task_a", 300, endFirst);
    await wait(SETTLED);
    bothKept(r, 300, 600);
    assert.equal(r.modeler.log.imports.length, 1, `${what}: one import, after the drop`);
    r.unbind();
  }
});

test("a gesture that ends with no change, cancelled or dropped where it began, lets the waiting change in at once", async () => {
  const r = room();
  await wait(50);
  r.modeler.log.imports.length = 0;

  r.modeler.startGesture();
  r.peer.modeler.set("Task_f", 600);
  await wait(QUIET);
  assert.deepEqual(r.modeler.log.imports, [], "no import while the gesture runs");

  r.modeler.cancelGesture();
  await wait(QUIET);
  assert.equal(r.modeler.log.imports.length, 1, "imported once the modeler reports the end, not 10 s after the change");
  assert.equal(xOf(r.modeler.canvas(), "Task_f"), 600);
  assert.equal(r.modeler.canvas(), r.ytext.toString());
  assert.deepEqual([r.conflicts, r.peer.conflicts], [[], []]);
  r.unbind();
});

test("a pointer held on the canvas is no gesture to the binding: it never reads the canvas's DOM", async () => {
  const host = canvasHost();
  // a caller that still hands one in (SyncOptions has it for bpmn-js and dmn-js)
  const sync: SyncOptions = { canvasHost: host.element };
  const r = room(sync);
  await wait(50);

  host.press();
  r.peer.modeler.set("Task_f", 600);
  await wait(QUIET);
  assert.equal(xOf(r.modeler.canvas(), "Task_f"), 600, "the peer's change is in");
  assert.equal(host.seen.listeners, 0, "no pointer or focus listener on the canvas or its window");
  r.unbind();
});

test("a gesture held past 10 s ends in the modeler's own import: no Escape is sent, and its cancel imports nothing more", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const host = canvasHost();
  const sync: SyncOptions = { canvasHost: host.element };
  const r = room(sync);
  await advance(t, 50);
  r.modeler.log.imports.length = 0;

  host.press();
  r.modeler.startGesture();
  r.peer.modeler.set("Task_f", 600);
  await advance(t, 350 + 9_500);
  assert.deepEqual(r.modeler.log.imports, [], "held for nearly 10 s");
  await advance(t, 600);
  assert.equal(r.modeler.log.imports.length, 1, "past 10 s the peer's change is imported");
  assert.equal(r.modeler.interaction?.active(), false, "the import ended the gesture");
  assert.equal(xOf(r.modeler.canvas(), "Task_f"), 600);
  assert.equal(host.seen.escapes, 0, "no Escape sent");

  await advance(t, 2_000);
  assert.equal(r.modeler.log.imports.length, 1, "the end the import reported starts no second one");
  assert.equal(r.ytext.toString(), r.modeler.canvas());
  assert.deepEqual([r.conflicts, r.peer.conflicts], [[], []]);
  r.unbind();
});

test("a canvas edit is in the shared text before the modeler's change listener returns", async () => {
  const r = room();
  await wait(50);

  r.modeler.set("Task_a", 300);
  assert.equal(xOf(r.ytext.toString(), "Task_a"), 300, "written inside the listener");

  r.modeler.startGesture();
  r.peer.modeler.set("Task_f", 600);
  await wait(QUIET);
  r.modeler.drop("Task_b", 400, true);
  const text = r.ytext.toString();
  assert.equal(
    xOf(text, "Task_b"),
    400,
    "a drop the modeler reports after the gesture's end, also inside the listener",
  );
  assert.equal(xOf(text, "Task_f"), 600, "merged with the peer's change that waits");
  await wait(SETTLED);
  assert.equal(r.modeler.canvas(), r.ytext.toString());
  assert.deepEqual([r.conflicts, r.peer.conflicts], [[], []]);
  r.unbind();
});

test("a canvas edit that gives way to a peer's change of the same line re-imports once the change listener has returned", async () => {
  const r = room();
  await wait(50);
  r.modeler.log.imports.length = 0;

  r.peer.modeler.set("Task_a", 600);
  r.modeler.set("Task_a", 300);
  assert.equal(r.conflicts.length, 1, "the edit gives way, with the toast");
  await wait(QUIET);
  assert.equal(r.modeler.log.importsInChangeListener, 0, "no import inside the change listener");
  assert.equal(r.modeler.log.imports.length, 1, "the peer's change is imported");
  assert.equal(xOf(r.modeler.canvas(), "Task_a"), 600);
  assert.equal(r.ytext.toString(), r.modeler.canvas());
  r.unbind();
});

test("a canvas edit made while an import waits for the user's action merges with the peer's change it brings", async () => {
  const r = room();
  await wait(50);
  r.modeler.log.imports.length = 0;

  const finish = r.modeler.startAction();
  r.peer.modeler.set("Task_f", 600);
  await wait(QUIET);
  assert.equal(r.modeler.log.running, 1, "the peer's import waits for the action");
  finish(["Task_a", 300]);
  assert.equal(xOf(r.ytext.toString(), "Task_a"), 300, "the action's edit is in the shared text");
  assert.equal(xOf(r.ytext.toString(), "Task_f"), 600, "next to the peer's change");

  await wait(SETTLED);
  bothKept(r, 300, 600);
  assert.deepEqual(
    r.modeler.log.imports.map((text) => [xOf(text, "Task_a"), xOf(text, "Task_f")]),
    [
      [100, 600],
      [300, 600],
    ],
    "the waiting import, then one that shows both",
  );
  r.unbind();
});

test("imports run one at a time in call order: changes that arrive while one waits make one more, of the latest text", async () => {
  const r = room();
  await wait(50);
  r.modeler.log.imports.length = 0;

  const finish = r.modeler.startAction();
  for (const x of [600, 700, 800]) {
    r.peer.modeler.set("Task_f", x);
    await wait(500);
  }
  assert.equal(r.modeler.log.running, 1, "one import waits, none beside it");
  finish();
  await wait(QUIET);
  assert.deepEqual(
    r.modeler.log.imports.map((text) => xOf(text, "Task_f")),
    [600, 800],
    "the waiting import, then the text as it is when the next one starts",
  );
  assert.equal(r.modeler.log.mostRunning, 1, "never two at once");
  assert.equal(r.modeler.canvas(), r.ytext.toString());
  r.unbind();
});

/** the timers model-sync.ts starts, and those it has running: a binding that stopped starts none and leaves none */
function engineTimers(t: TestContext) {
  const timers = { live: new Set<ReturnType<typeof setTimeout>>(), started: 0 };
  const { setTimeout: set, clearTimeout: clear } = globalThis;
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    const fromEngine = new Error().stack?.includes("model-sync.ts") ?? false;
    const id = set(() => {
      timers.live.delete(id);
      handler();
    }, ms);
    if (fromEngine) {
      timers.live.add(id);
      timers.started++;
    }
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    if (id !== undefined) timers.live.delete(id);
    clear(id);
  }) as typeof clearTimeout;
  t.after(() => {
    globalThis.setTimeout = set;
    globalThis.clearTimeout = clear;
  });
  return timers;
}

test("after the unbind nothing runs: an import that settles later, the end of a gesture, a peer's change", async (t) => {
  const timers = engineTimers(t);

  // an import that waits for the user's action, accepted or rejected after the
  // unbind, with a peer's later change queued behind it
  for (const peerText of ["Task_f 600 100", "Task_f six hundred"]) {
    const r = room({ onUnrenderable: (message) => r.reported.push(`unrenderable: ${message}`) });
    await wait(50);
    r.modeler.log.imports.length = 0;
    const peerWrites = (line: string, replacement: string): void =>
      r.peer.doc.transact(() => {
        const at = r.peer.ytext.toString().indexOf(line);
        r.peer.ytext.delete(at, line.length);
        r.peer.ytext.insert(at, replacement);
      });
    const finish = r.modeler.startAction();
    peerWrites("Task_f 100 100", peerText);
    await wait(QUIET);
    assert.equal(r.modeler.log.running, 1, `${peerText}: the import waits`);
    peerWrites("Task_e 100 100", "Task_e 500 100");
    await wait(QUIET);
    assert.equal(r.modeler.log.running, 1, `${peerText}: the next change waits behind it`);
    const viewsSet = r.modeler.log.viewsSet;
    const text = r.ytext.toString();
    r.unbind();
    const startedAtUnbind = timers.started;
    finish(["Task_a", 300]);
    await wait(SETTLED);
    assert.equal(r.modeler.log.viewsSet, viewsSet, `${peerText}: no view restored on the modeler`);
    assert.equal(r.ytext.toString(), text, `${peerText}: nothing written`);
    assert.deepEqual([r.reported, r.conflicts], [[], []], `${peerText}: nobody told`);
    assert.equal(r.modeler.log.imports.length, peerText.includes("six") ? 0 : 1, `${peerText}: no import after it`);
    assert.equal(timers.started, startedAtUnbind, `${peerText}: no timer started`);
    assert.equal(timers.live.size, 0, `${peerText}: none left running`);
  }

  // a peer's change that waits for a gesture
  const r = room();
  await wait(50);
  r.modeler.log.imports.length = 0;
  r.modeler.startGesture();
  r.peer.modeler.set("Task_f", 600);
  await wait(QUIET);
  r.unbindLocal();
  assert.equal(r.modeler.gestureListeners.size, 0, "no gesture listener");
  assert.equal(r.modeler.log.contentListeners, 0, "no change listener");
  const text = r.ytext.toString();
  r.modeler.drop("Task_a", 300);
  r.peer.modeler.set("Task_e", 500);
  await wait(SETTLED);
  assert.deepEqual(r.modeler.log.imports, [], "the gesture's end and a later change import nothing");
  assert.equal(xOf(r.ytext.toString(), "Task_a"), xOf(text, "Task_a"), "the drop is not written");
  r.peer.unbind();
  assert.equal(timers.live.size, 0, "no timer");
});
