/**
 * Headless tests for the collaborative-modeler adapter (src/miragon-sync.ts)
 * against a fake that keeps the @miragon/modeler-api laws the way the Miragon
 * renderers do: a silent import (L1) whose export is CANONICAL, not a byte
 * copy of what was imported (L2), one change event per user edit (L3), an
 * undo that does nothing right after an import (L4), a view state the import
 * resets to its own fit (L5) and rejections that leave no trace (L7). The
 * cases pin what the adapter adds on top: nothing written on open, the edit
 * exported as a minimal diff, the view kept across a peer's re-import, the
 * rejection's own reason reported, and the bind-time contract check.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type CollaborativeModeler, MODELER_API_VERSION } from "@miragon/modeler-api";
import * as Y from "yjs";

import { assertContract, bindMiragon } from "../src/miragon-sync.ts";

// the XML notations' gate calls DOMParser; this adapter must never touch it —
// a throwing stub proves it doesn't
(globalThis as Record<string, unknown>).DOMParser = class {
  parseFromString(): never {
    throw new Error("DOMParser must not be used by the collaborative-modeler adapter");
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface View {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** where every import leaves the view: the renderer's own fit */
const FITTED: View = { x: 0, y: 0, width: 1000, height: 640 };

/**
 * A modeler that keeps the laws. Its document is a list of lines; the
 * canonical text sorts them (a hand-authored file is not a byte fixpoint).
 * A text starting with "BROKEN" is rejected with that line as the reason.
 */
function fakeModeler(o: { notation?: string; apiVersion?: string } = {}) {
  let lines: string[] = [];
  let view: View | undefined;
  let history: string[][] = [];
  const listeners = new Set<() => void>();
  const log = { imports: [] as string[], setViews: [] as View[], changes: 0 };
  const canonical = (of: string[]): string => (of.length ? `${[...of].sort().join("\n")}\n` : "");
  const changed = (): void => {
    log.changes++;
    for (const listener of [...listeners]) listener();
  };
  const modeler: CollaborativeModeler & {
    edit(line: string): void;
    undo(): void;
    pan(dx: number): void;
    view(): View | undefined;
    log: typeof log;
  } = {
    meta: { notation: o.notation ?? "wardley", apiVersion: o.apiVersion ?? MODELER_API_VERSION, editable: true },
    attachTo: () => {},
    async importText(text) {
      const reason = text.startsWith("BROKEN") ? text.split("\n")[0] : undefined;
      if (reason) throw new Error(reason);
      log.imports.push(text);
      lines = text.split("\n").filter(Boolean);
      history = [];
      view = { ...FITTED };
      return { warnings: [] };
    },
    exportText: () => canonical(lines),
    onContentChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getViewState: () => (view ? { ...view } : undefined),
    setViewState(state) {
      log.setViews.push(state as View);
      view = { ...(state as View) };
    },
    destroy: () => {},
    edit(line) {
      history.push(lines);
      lines = [...lines, line];
      changed();
    },
    undo() {
      const previous = history.pop();
      if (!previous) return;
      lines = previous;
      changed();
    },
    pan(dx) {
      if (view) view = { ...view, x: view.x + dx };
    },
    view: () => view,
    log,
  };
  return modeler;
}

function session(initial: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, initial);
  /** a peer's edit: the whole text replaced, as a remote transaction */
  const remote = (text: string): void =>
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, text);
    });
  return { doc, ytext, remote };
}

const HAND_AUTHORED = "component Tea [0.5, 0.5]\ncomponent Cup [0.7, 0.8]\n";

test("L1: opening a hand-authored document writes nothing, though the canonical text differs", async () => {
  const { doc, ytext } = session(HAND_AUTHORED);
  const modeler = fakeModeler();
  const unbind = bindMiragon(modeler, "wardley", ytext, doc);
  await wait(50);
  assert.deepEqual(modeler.log.imports, [HAND_AUTHORED], "imported (non-XML, no DOMParser)");
  assert.notEqual(modeler.exportText(), HAND_AUTHORED, "the fixture is not canonical");
  assert.equal(ytext.toString(), HAND_AUTHORED, "opening a file never rewrites it");
  unbind();
});

test("L3: a canvas edit exports through onContentChanged, and nothing after unbind", async () => {
  const { doc, ytext } = session(HAND_AUTHORED);
  const modeler = fakeModeler();
  const unbind = bindMiragon(modeler, "wardley", ytext, doc);
  await wait(50);
  modeler.edit("component Water [0.3, 0.9]");
  await wait(20);
  assert.equal(ytext.toString(), modeler.exportText(), "the canonical text, edit included");
  unbind();
  modeler.edit("component Gone [0.1, 0.1]");
  await wait(20);
  assert.doesNotMatch(ytext.toString(), /Gone/);
});

test("the empty-text gate: a blank document reports itself, a wiped one keeps the last good canvas", async () => {
  for (const blank of ["", "  \n"]) {
    const { doc, ytext } = session(blank);
    const modeler = fakeModeler();
    const reported: string[] = [];
    const unbind = bindMiragon(modeler, "wardley", ytext, doc, undefined, (m) => reported.push(m));
    await wait(50);
    assert.deepEqual(reported, ["the document is empty"], JSON.stringify(blank));
    assert.deepEqual(modeler.log.imports, [], "a blank text never renders as an empty diagram");
    unbind();
  }

  const { doc, ytext } = session(HAND_AUTHORED);
  const modeler = fakeModeler();
  const unbind = bindMiragon(modeler, "wardley", ytext, doc);
  await wait(50);
  ytext.delete(0, ytext.length);
  await wait(450);
  assert.equal(modeler.log.imports.length, 1, "no import of the wiped text");
  assert.equal(modeler.exportText(), "component Cup [0.7, 0.8]\ncomponent Tea [0.5, 0.5]\n");
  unbind();
});

test("L7: a rejected import leaves no trace, and the first one reports the modeler's own reason", async () => {
  const refused = 'BROKEN nodes.1.id: duplicate id "team_platform"; ids must be unique';
  {
    const { doc, ytext } = session(`${refused}\n`);
    const modeler = fakeModeler({ notation: "team-topologies" });
    const reported: string[] = [];
    const unbind = bindMiragon(modeler, "team-topologies", ytext, doc, undefined, (m) => reported.push(m));
    await wait(50);
    assert.deepEqual(reported, [refused], "the reason, word for word");
    assert.equal(ytext.toString(), `${refused}\n`);
    unbind();
  }

  const { doc, ytext, remote } = session(HAND_AUTHORED);
  const modeler = fakeModeler();
  const reported: string[] = [];
  const unbind = bindMiragon(modeler, "wardley", ytext, doc, undefined, (m) => reported.push(m));
  await wait(50);
  const good = modeler.exportText();
  remote(`${refused}\n`);
  await wait(450);
  assert.equal(modeler.exportText(), good, "the last good canvas stays");
  assert.deepEqual(reported, [], "a later rejection is a transient interleaving");
  assert.equal(ytext.toString(), `${refused}\n`, "and the peer's text is not overwritten");
  remote("component Healed [0.2, 0.2]\n");
  await wait(450);
  assert.equal(modeler.exportText(), "component Healed [0.2, 0.2]\n", "the next valid text imports");
  unbind();
});

test("L5: the first import keeps the renderer's fit, a peer's re-import keeps the user's view", async () => {
  const { doc, ytext, remote } = session(HAND_AUTHORED);
  const modeler = fakeModeler();
  const unbind = bindMiragon(modeler, "wardley", ytext, doc);
  await wait(50);
  assert.deepEqual(modeler.log.setViews, [], "no view of the host's own over the first import");
  assert.deepEqual(modeler.view(), FITTED);

  modeler.pan(240);
  const panned = modeler.view();
  remote(`${HAND_AUTHORED}component Water [0.3, 0.9]\n`);
  await wait(450);
  assert.equal(modeler.log.imports.length, 2, "re-imported");
  assert.deepEqual(modeler.view(), panned, "the view does not jump on a peer's edit");
  unbind();
});

test("L4: an undo right after a peer's re-import changes nothing, so nothing reaches the shared text", async () => {
  const { doc, ytext, remote } = session(HAND_AUTHORED);
  const modeler = fakeModeler();
  const unbind = bindMiragon(modeler, "wardley", ytext, doc);
  await wait(50);
  modeler.edit("component Mine [0.4, 0.4]");
  await wait(650); // past the local edit's quiet period
  const theirs = `${ytext.toString()}component Theirs [0.6, 0.6]\n`;
  remote(theirs);
  await wait(450);
  const changes = modeler.log.changes;
  modeler.undo();
  await wait(20);
  assert.equal(modeler.log.changes, changes, "no change event");
  assert.equal(ytext.toString(), theirs, "the peer's state stays, my edit is not undone into it");
  unbind();
});

test("the contract check: another notation or another major fails at bind time, a newer minor binds", () => {
  const { doc, ytext } = session(HAND_AUTHORED);
  assert.throws(
    () => bindMiragon(fakeModeler({ notation: "context-maps" }), "team-topologies", ytext, doc),
    /expected a 'team-topologies' modeler, got 'context-maps'/,
  );
  assert.throws(
    () => assertContract(fakeModeler({ apiVersion: "2.0.0" }), "wardley"),
    /implements @miragon\/modeler-api 2\.0\.0, designIQ speaks 1\./,
  );
  assert.throws(() => assertContract(fakeModeler({ apiVersion: "0.1.0" }), "wardley"), /0\.1\.0/);
  for (const apiVersion of ["1.0.0", "1.9.3"]) {
    assert.doesNotThrow(() => assertContract(fakeModeler({ apiVersion }), "wardley"), apiVersion);
  }
});
