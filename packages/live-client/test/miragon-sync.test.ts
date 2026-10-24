/**
 * Headless tests for the collaborative-modeler adapter (src/miragon-sync.ts)
 * against a fake that keeps the @miragon/modeler-api laws the way the Miragon
 * renderers do: a silent import (L1) whose export is CANONICAL, not a byte
 * copy of what was imported (L2), one change event per user edit (L3), an
 * undo that does nothing right after an import (L4), a view state the import
 * resets to its own fit (L5) and rejections that leave no trace (L7). The
 * cases pin what the adapter adds on top: nothing written on open, the edit
 * exported as a minimal diff, the view kept across a peer's re-import, the
 * rejection's own reason reported, and the bind-time contract check. A
 * canvas edit at an end of a line notation's text merges with a peer's
 * change there, or gives way, but never joins two lines (#309).
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

/**
 * A JSON modeler: its canonical text is the pretty-printed document with a
 * closing line break, which a file written before that change lacks. Text
 * that is no valid JSON is refused (L7).
 */
function jsonModeler() {
  let document: Record<string, number> = {};
  const listeners = new Set<() => void>();
  const modeler: CollaborativeModeler & { move(key: string, value: number): void } = {
    meta: { notation: "context-maps", apiVersion: MODELER_API_VERSION, editable: true },
    attachTo: () => {},
    async importText(text) {
      document = JSON.parse(text) as Record<string, number>;
      return { warnings: [] };
    },
    exportText: () => `${JSON.stringify(document, null, 2)}\n`,
    onContentChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getViewState: () => undefined,
    setViewState: () => {},
    destroy: () => {},
    move(key, value) {
      document = { ...document, [key]: value };
      for (const listener of [...listeners]) listener();
    },
  };
  return modeler;
}

/** a file as written before the closing line break: canonical apart from it */
const OLDER_FILE = JSON.stringify({ cfp: 40, agenda: 400, venue: 800 }, null, 2);

/** two peers on the same file, each with its own Y.Doc, as the Live Host syncs them */
function twoPeers(text: string) {
  const seed = new Y.Doc();
  seed.getText("content").insert(0, text);
  const state = Y.encodeStateAsUpdate(seed);
  return [0, 1].map(() => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const ytext = doc.getText("content");
    const modeler = jsonModeler();
    const conflicts: string[] = [];
    const unbind = bindMiragon(modeler, "context-maps", ytext, doc, (m) => conflicts.push(m), assert.fail);
    return { doc, ytext, modeler, conflicts, unbind };
  });
}

test("concurrent first edits of a file without its closing line break merge into valid JSON, both kept", async () => {
  const [a, b] = twoPeers(OLDER_FILE);
  await wait(50);
  a!.modeler.move("cfp", 50);
  b!.modeler.move("venue", 820);
  await wait(20);
  const fromA = Y.encodeStateAsUpdate(a!.doc);
  const fromB = Y.encodeStateAsUpdate(b!.doc);
  Y.applyUpdate(a!.doc, fromB);
  Y.applyUpdate(b!.doc, fromA);
  await wait(1100); // past the quiet period after a local edit, then the import's debounce

  const merged = a!.ytext.toString();
  assert.equal(b!.ytext.toString(), merged, "the peers converge");
  assert.deepEqual(JSON.parse(merged), { cfp: 50, agenda: 400, venue: 820 }, "valid JSON with both moves");
  assert.match(merged, /\}\n+$/, "closed by the line break");
  for (const peer of [a!, b!]) {
    assert.deepEqual(JSON.parse(peer.modeler.exportText()), JSON.parse(merged), "each canvas shows the shared text");
    assert.deepEqual(peer.conflicts, []);
    peer.unbind();
  }
});

test("a peer's edit after mine, inside the import debounce, merges with my first edit of such a file", async () => {
  const [peer] = twoPeers(OLDER_FILE);
  await wait(50);
  const venue = peer!.ytext.toString().indexOf("800");
  peer!.doc.transact(() => {
    peer!.ytext.delete(venue, 3);
    peer!.ytext.insert(venue, "877");
  }, "remote");
  await wait(20);
  peer!.modeler.move("cfp", 50);
  await wait(450);
  assert.deepEqual(JSON.parse(peer!.ytext.toString()), { cfp: 50, agenda: 400, venue: 877 });
  assert.deepEqual(peer!.conflicts, [], "no overlap: the local edit is not dropped");
  peer!.unbind();
});

test("the next edit after such a merge drops the doubled closing line break again", async () => {
  const [peer] = twoPeers(`${OLDER_FILE}\n\n`);
  await wait(50);
  peer!.modeler.move("agenda", 410);
  await wait(20);
  assert.equal(peer!.ytext.toString(), `${OLDER_FILE.replace("400", "410")}\n`);
  peer!.unbind();
});

/** an OWM board in the fake's canonical (sorted) order */
const BOARD = "component Cup [0.79, 0.61]\ncomponent Kettle [0.43, 0.35]\n";

function bindBoard(text: string) {
  const { doc, ytext, remote } = session(text);
  const modeler = fakeModeler();
  const conflicts: string[] = [];
  const reported: string[] = [];
  const unbind = bindMiragon(
    modeler,
    "wardley",
    ytext,
    doc,
    (m) => conflicts.push(m),
    (m) => reported.push(m),
  );
  return { ytext, remote, modeler, conflicts, reported, unbind };
}

test("a create after the last line merges with a peer's suffix to that line, which stays on its own line", async () => {
  const { ytext, remote, modeler, conflicts, unbind } = bindBoard(BOARD);
  await wait(50);
  const labelled = BOARD.replace("[0.43, 0.35]", "[0.43, 0.35] label [-20, 10]");
  remote(labelled);
  modeler.edit("component Water [0.82, 0.78]");
  await wait(20);
  assert.equal(ytext.toString(), `${labelled}component Water [0.82, 0.78]\n`, "not on Water's line");
  assert.deepEqual(conflicts, []);
  unbind();
});

test("a create before the first line gives way to a peer's comment on that line, rather than comment out the create", async () => {
  const { ytext, remote, modeler, conflicts, unbind } = bindBoard(BOARD);
  await wait(50);
  const commented = `// ${BOARD}`;
  remote(commented);
  modeler.edit("anchor Tea [0.95, 0.63]");
  await wait(20);
  assert.equal(ytext.toString(), commented);
  assert.equal(conflicts.length, 1);
  unbind();
});

test("a canvas edit on a blank document gives way to a peer's first text, rather than join their lines", async () => {
  const { ytext, remote, modeler, conflicts, reported, unbind } = bindBoard("");
  await wait(50);
  assert.deepEqual(reported, ["the document is empty"], "the canvas is open on a blank text, as the SPA mounts it");
  const theirs = "title Peer\ncomponent Tea [0.5, 0.5]\n";
  remote(theirs);
  modeler.edit("component Cup [0.7, 0.8]");
  await wait(20);
  assert.equal(ytext.toString(), theirs);
  assert.equal(conflicts.length, 1);
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
