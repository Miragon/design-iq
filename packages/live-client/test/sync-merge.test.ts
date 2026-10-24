/**
 * Headless tests for the merge-aware canvas export (src/bpmn-sync.ts).
 *
 * The scenario that used to lose data: user B's remote edit lands in ytext,
 * user A makes a canvas edit before the debounced import ran — the old code
 * diffed A's full export against the merged ytext and DELETED B's edit as
 * "the differing middle". Disjoint edits must merge; true overlaps must keep
 * the remote edit and surface a conflict.
 *
 * Edits of different lines merge also where one edit's changed region spans
 * the other (#309): bpmn-js writes a moved or new shape's DI last, across the
 * DI a peer just moved. A merge is written whole or not at all, and never
 * breaks a text that renders: a typed change in it bars the repair (#274).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { bindBpmn } from "../src/bpmn-sync.ts";
import { updateText } from "../src/text-diff.ts";

// importFromY's validity gate uses DOMParser; the stub checks the one rule of
// XML these tests break: every namespace prefix in use is declared
(globalThis as Record<string, unknown>).DOMParser = class {
  parseFromString(text: string) {
    const declared = new Set([...text.matchAll(/xmlns:([\w-]+)=/g)].map((match) => match[1]));
    const used = [...text.matchAll(/<\/?([\w-]+):|\s([\w-]+):[\w-]+=/g)].map((match) => match[1] ?? match[2]);
    const bound = used.every((prefix) => prefix === "xmlns" || declared.has(prefix));
    return { getElementsByTagName: () => (bound ? [] : [{}]) };
  }
};

const BASE = `<definitions><task id="A" name="Alpha"/><task id="B" name="Beta"/><task id="C" name="Gamma"/></definitions>`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeFakeModeler(initial: string) {
  let xml = initial;
  const handlers: Record<string, Array<() => void>> = {};
  return {
    xml: () => xml,
    setXml: (x: string) => {
      xml = x;
    },
    fire: (ev: string) => handlers[ev]?.forEach((h) => h()),
    get: () => ({ viewbox: () => ({ x: 0, y: 0, width: 100, height: 100 }), zoom: () => undefined }),
    on: (ev: string, cb: () => void) => {
      (handlers[ev] ??= []).push(cb);
    },
    off: () => undefined,
    importXML: async (x: string) => {
      xml = x;
    },
    saveXML: async () => ({ xml }),
  };
}

function setup(onConflict?: (m: string) => void, base = BASE) {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, base);
  const modeler = makeFakeModeler(base);
  const unbind = bindBpmn(modeler as never, ytext, doc, onConflict);
  return { doc, ytext, modeler, unbind };
}

/** a peer's edit arriving in the text: a canvas write, or a person typing (no canvas origin either way) */
function remoteEdit(doc: Y.Doc, ytext: Y.Text, text: string): void {
  doc.transact(() => updateText(ytext, text), "remote-user");
}

test("disjoint concurrent edits merge — nobody's change is lost", async () => {
  const { doc, ytext, modeler, unbind } = setup();
  await wait(700); // initial import settles

  const remote = BASE.replace('name="Beta"', 'name="Beta-REMOTE"');
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, remote);
  }, "remote-user");

  modeler.setXml(BASE.replace('name="Alpha"', 'name="Alpha-LOCAL"'));
  modeler.fire("commandStack.changed");
  await wait(100);

  const merged = ytext.toString();
  assert.ok(merged.includes("Beta-REMOTE"), "remote edit must survive the local export");
  assert.ok(merged.includes("Alpha-LOCAL"), "local edit must be applied");

  await wait(1100); // canvas convergence (import quiet period)
  assert.ok(modeler.xml().includes("Beta-REMOTE") && modeler.xml().includes("Alpha-LOCAL"));
  unbind();
});

test("overlapping edits: remote wins, conflict is reported — never silent", async () => {
  let conflict = "";
  const { doc, ytext, modeler, unbind } = setup((m) => {
    conflict = m;
  });
  await wait(700);

  const remote = BASE.replace('name="Beta"', 'name="Beta-REMOTE"');
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, remote);
  }, "remote-user");
  modeler.setXml(BASE.replace('name="Beta"', 'name="Beta-LOCAL"'));
  modeler.fire("commandStack.changed");
  await wait(600);

  assert.ok(ytext.toString().includes("Beta-REMOTE"));
  assert.ok(!ytext.toString().includes("Beta-LOCAL"));
  assert.ok(conflict.length > 0, "conflict callback must fire");
  assert.ok(modeler.xml().includes("Beta-REMOTE"), "canvas reverts to the surviving state");
  unbind();
});

test("sequential edit without remote interference uses the plain minimal diff", async () => {
  const { ytext, modeler, unbind } = setup();
  await wait(700);
  modeler.setXml(BASE.replace('name="Gamma"', 'name="Gamma-EDIT"'));
  modeler.fire("commandStack.changed");
  await wait(100);
  assert.ok(ytext.toString().includes("Gamma-EDIT"));
  unbind();
});

/* ── a model of one line per task and per shape, its moved shape written last ── */

/**
 * Shapes in the order the export writes them (bpmn-js: a moved shape's DI
 * goes last), each at its x; `colored` shapes carry a fill in the color
 * namespace, which the root declares while any shape uses it.
 */
function diagram(shapes: Record<string, number>, colored: readonly string[] = []): string {
  const namespace = colored.length > 0 ? ' xmlns:color="http://www.omg.org/spec/BPMN/non-normative/color/1.0"' : "";
  const fill = (id: string): string => (colored.includes(id) ? ' color:fill="#ffd"' : "");
  return [
    `<definitions id="D"${namespace}>`,
    ...Object.keys(shapes)
      .sort()
      .map((id) => `  <task id="${id}" name="Handle ${id}" />`),
    "  <plane>",
    ...Object.entries(shapes).map(([id, x]) => `    <shape element="${id}" x="${x}" y="80"${fill(id)} />`),
    "  </plane>",
    "</definitions>",
    "",
  ].join("\n");
}

test("a move whose DI the export writes last merges with a peer's move of the last DI: both stay, nobody is told", async () => {
  const conflicts: string[] = [];
  const { doc, ytext, modeler, unbind } = setup((m) => conflicts.push(m), diagram({ A: 100, B: 250, C: 400 }));
  await wait(700);

  remoteEdit(doc, ytext, diagram({ A: 100, B: 250, C: 480 }));
  // the local move rewrites the DI from A's shape down through C's, which the peer changed
  modeler.setXml(diagram({ B: 250, C: 400, A: 130 }));
  modeler.fire("commandStack.changed");
  await wait(100);

  const text = ytext.toString();
  assert.equal(text, diagram({ B: 250, C: 480, A: 130 }), "both moves, one shape each, the local move's last");
  assert.deepEqual(conflicts, []);
  await wait(1100);
  assert.equal(modeler.xml(), text, "the canvas takes in the peer's move");
  unbind();
});

test("a new element right after the one a peer moved merges: both stay, nobody is told", async () => {
  const conflicts: string[] = [];
  const { doc, ytext, modeler, unbind } = setup((m) => conflicts.push(m), diagram({ A: 100, B: 250, C: 400 }));
  await wait(700);

  remoteEdit(doc, ytext, diagram({ A: 100, B: 250, C: 480 }));
  modeler.setXml(diagram({ A: 100, B: 250, C: 400, D: 550 }));
  modeler.fire("commandStack.changed");
  await wait(100);

  assert.equal(ytext.toString(), diagram({ A: 100, B: 250, C: 480, D: 550 }));
  assert.deepEqual(conflicts, []);
  unbind();
});

test("a local edit is written whole or not at all: a move of the shape a peer moved too gives way, with the toast", async () => {
  const conflicts: string[] = [];
  const { doc, ytext, modeler, unbind } = setup((m) => conflicts.push(m), diagram({ A: 100, B: 250, C: 400 }));
  await wait(700);

  const remote = diagram({ B: 250, C: 400, A: 160 });
  remoteEdit(doc, ytext, remote);
  // deleting A's shape where it was clashes; appending it last alone would not
  modeler.setXml(diagram({ B: 250, C: 400, A: 130 }));
  modeler.fire("commandStack.changed");
  await wait(600);

  assert.equal(ytext.toString(), remote, "the peer's move stays, and nothing of the local one is written");
  assert.equal(conflicts.length, 1);
  assert.equal(modeler.xml(), remote, "the canvas shows the surviving state");
  unbind();
});

test("a merge that would leave a text that renders unrenderable gives way: a peer's typed change stays whole", async () => {
  // the typist removes the fill and its namespace while the canvas fills another shape: each edit alone
  // is well-formed, their merge uses an undeclared prefix, and the typing bars the repair (#274)
  const conflicts: string[] = [];
  const shapes = { A: 100, B: 250, C: 400 };
  const { doc, ytext, modeler, unbind } = setup((m) => conflicts.push(m), diagram(shapes, ["A"]));
  await wait(700);

  const typed = diagram(shapes);
  remoteEdit(doc, ytext, typed);
  modeler.setXml(diagram(shapes, ["A", "C"]));
  modeler.fire("commandStack.changed");
  await wait(600);

  assert.equal(ytext.toString(), typed, "the typed change stays, the text renders");
  assert.equal(conflicts.length, 1, "the canvas whose edit gave way is told");
  assert.equal(modeler.xml(), typed, "and shows the shared text");
  unbind();
});
