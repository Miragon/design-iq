/**
 * The merge safety net (#274). Two canvases that write at the same moment,
 * each one large changed region of the same text, leave Yjs keeping both
 * insertions: a text no peer can import, two canvases that stay apart. Every
 * case runs real Y.Docs behind a relay that holds each update until it is
 * flushed, so the peers write before either receives, as two drops do that
 * cross on the Live Host.
 *
 * Pinned: exactly one of the writers (the same one on every peer) writes its
 * canvas over the broken text after a settle delay, and every peer converges
 * on exactly that export; the writer whose edit is lost gets the conflict
 * toast, the one who repairs keeps its edit; a write that arrives during the
 * delay hands the repair over instead of racing it; typing in the source view
 * and an agent's save are never written over.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type CollaborativeModeler, MODELER_API_VERSION } from "@miragon/modeler-api";
import * as Y from "yjs";

import { bindBpmn } from "../src/bpmn-sync.ts";
import { bindDmn } from "../src/dmn-sync.ts";
import { bindMiragon } from "../src/miragon-sync.ts";
import { updateText } from "../src/text-diff.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** the local edit's quiet period, the import's debounce, the repair's settle delay and the peers' re-import */
const SETTLED = 2400;

/**
 * Well-formed XML for the fixtures of this file: tags with quoted attributes,
 * no `<` inside them, balanced. The failure of #274 ("< is not allowed in
 * attributes", "Unexpected closing tag") is exactly what it rejects.
 */
function wellFormed(text: string): boolean {
  const open: string[] = [];
  const tag = /<(\/?)([A-Za-z_?][\w:.-]*)((?:\s+[\w:.-]+="[^"<>]*")*)\s*([/?]?)>/y;
  let at = 0;
  while (at < text.length) {
    const lt = text.indexOf("<", at);
    if (text.slice(at, lt < 0 ? text.length : lt).includes(">")) return false;
    if (lt < 0) break;
    tag.lastIndex = lt;
    const match = tag.exec(text);
    if (!match) return false;
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      if (open.pop() !== name) return false;
    } else if (!selfClosing && !name!.startsWith("?")) open.push(name!);
    at = tag.lastIndex;
  }
  return open.length === 0 && text.trim().length > 0;
}

// the XML notations' gate (looksWellFormedXml) asks DOMParser
(globalThis as Record<string, unknown>).DOMParser = class {
  parseFromString(text: string) {
    return { getElementsByTagName: () => (wellFormed(text) ? [] : [{}]) };
  }
};

const RELAYED = Symbol("relayed");

/**
 * The Live Host's fan-out between Y.Docs: every update a doc makes reaches
 * every other doc, unless the relay holds it. Held updates go out on flush,
 * optionally only those from some senders to some receivers, so a test
 * decides who receives what when.
 */
function relay() {
  const docs: Y.Doc[] = [];
  const held: Array<{ from: Y.Doc; to: Y.Doc; update: Uint8Array }> = [];
  let holding = false;
  const flush = (from?: readonly Y.Doc[], to?: readonly Y.Doc[]): void => {
    for (const item of [...held]) {
      if ((from && !from.includes(item.from)) || (to && !to.includes(item.to))) continue;
      held.splice(held.indexOf(item), 1);
      Y.applyUpdate(item.to, item.update, RELAYED);
    }
  };
  return {
    join(doc: Y.Doc): void {
      docs.push(doc);
      doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === RELAYED) return;
        for (const to of docs) if (to !== doc) held.push({ from: doc, to, update });
        if (!holding) flush();
      });
    },
    hold(): void {
      holding = true;
    },
    flush,
    release(): void {
      holding = false;
      flush();
    },
  };
}

type Relay = ReturnType<typeof relay>;

/** a doc that starts from the room's state; a fixed client id decides ties the same way on every run */
function joinRoom(net: Relay, room: Uint8Array, clientId?: number): Y.Doc {
  const doc = new Y.Doc();
  if (clientId !== undefined) doc.clientID = clientId;
  Y.applyUpdate(doc, room, RELAYED);
  net.join(doc);
  return doc;
}

function roomOf(text: string): Uint8Array {
  const seed = new Y.Doc();
  seed.getText("content").insert(0, text);
  return Y.encodeStateAsUpdate(seed);
}

/** the Live Host's own copy: it counts the text changes that reach it */
function hostCopy(net: Relay, room: Uint8Array) {
  const doc = joinRoom(net, room);
  const ytext = doc.getText("content");
  const log = { changes: 0 };
  ytext.observe(() => log.changes++);
  return { doc, ytext, log };
}

/* ── a BPMN-like XML notation ─────────────────────────────────────────────── */

interface Bounds {
  x: number;
  y: number;
}

/**
 * Serialized the way bpmn-js does it on export: a moved task's lane
 * reference and its DI shape go last, so one move rewrites the text from the
 * moved task's reference down to the end of the DI, and two moves of
 * different tasks always overlap.
 */
function bpmnLike(order: readonly string[], bounds: ReadonlyMap<string, Bounds>): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<definitions id="Definitions_1">',
    '  <process id="Process_1">',
    '    <laneSet id="LaneSet_1">',
    '      <lane id="Lane_1" name="Sales">',
    ...order.map((id) => `        <flowNodeRef>${id}</flowNodeRef>`),
    "      </lane>",
    "    </laneSet>",
    ...[...order].sort().map((id) => `    <task id="${id}" name="Handle ${id.slice(5)}" />`),
    "  </process>",
    '  <diagram id="Diagram_1">',
    '    <plane id="Plane_1" element="Process_1">',
    ...order.map((id) => {
      const { x, y } = bounds.get(id)!;
      return `      <shape id="${id}_di" element="${id}"><bounds x="${x}" y="${y}" width="100" height="80" /></shape>`;
    }),
    "    </plane>",
    "  </diagram>",
    "</definitions>",
    "",
  ].join("\n");
}

const TASKS = ["Task_a", "Task_b", "Task_c", "Task_d", "Task_e", "Task_f"];
const XML = bpmnLike(TASKS, new Map(TASKS.map((id, index) => [id, { x: 100 + index * 150, y: 80 }])));

function parseBpmnLike(xml: string): { order: string[]; bounds: Map<string, Bounds> } {
  const order = [...xml.matchAll(/<flowNodeRef>([^<]+)<\/flowNodeRef>/g)].map((m) => m[1]!);
  const bounds = new Map(
    [...xml.matchAll(/element="(Task_\w+)"><bounds x="(-?\d+)" y="(-?\d+)"/g)].map(
      (m) => [m[1]!, { x: Number(m[2]), y: Number(m[3]) }] as const,
    ),
  );
  return { order, bounds };
}

/** what bindBpmn uses of bpmn-js, around the serialization above */
function bpmnLikeModeler() {
  let { order, bounds } = parseBpmnLike(XML);
  const listeners = new Set<() => void>();
  const log = { imports: 0 };
  return {
    log,
    get: () => ({ viewbox: () => ({ x: 0, y: 0, width: 100, height: 100 }), zoom: () => undefined }),
    on: (_event: string, cb: () => void) => void listeners.add(cb),
    off: (_event: string, cb: () => void) => void listeners.delete(cb),
    async importXML(xml: string) {
      if (!wellFormed(xml)) throw new Error("unparsable XML");
      log.imports++;
      ({ order, bounds } = parseBpmnLike(xml));
    },
    async saveXML() {
      return { xml: bpmnLike(order, bounds) };
    },
    move(id: string, dx: number, dy: number): void {
      const { x, y } = bounds.get(id)!;
      bounds = new Map(bounds).set(id, { x: x + dx, y: y + dy });
      order = [...order.filter((other) => other !== id), id];
      for (const listener of [...listeners]) listener();
    },
    canvas: () => bpmnLike(order, bounds),
  };
}

function bpmnPeer(net: Relay, room: Uint8Array, clientId?: number) {
  const doc = joinRoom(net, room, clientId);
  const ytext = doc.getText("content");
  const modeler = bpmnLikeModeler();
  const conflicts: string[] = [];
  const unbind = bindBpmn(modeler as never, ytext, doc, (message) => conflicts.push(message));
  return { doc, ytext, modeler, conflicts, unbind, own: "" };
}

type Peer = { ytext: Y.Text; conflicts: string[]; own: string; unbind(): void };

/** after the drops: every peer holds the same text, and it is exactly the repairer's own export */
function repairedBy<P extends Peer>(peers: readonly P[], canvasOf: (peer: P) => string): P {
  const text = peers[0]!.ytext.toString();
  for (const peer of peers) assert.equal(peer.ytext.toString(), text, "the peers converge");
  for (const peer of peers) assert.equal(canvasOf(peer), text, "each canvas shows the shared text");
  const repairer = peers.find((peer) => peer.own === text);
  assert.ok(repairer, "the shared text is exactly one writer's own export");
  return repairer;
}

test("BPMN-like XML: two drops at once break the merge; one writer writes its canvas over it, the other gets the conflict toast", async () => {
  const net = relay();
  const room = roomOf(XML);
  const host = hostCopy(net, room);
  const a = bpmnPeer(net, room, 200);
  const b = bpmnPeer(net, room, 100);
  await wait(50);

  net.hold();
  a.modeler.move("Task_b", 40, 30);
  b.modeler.move("Task_d", 35, -20);
  await wait(20);
  a.own = a.ytext.toString();
  b.own = b.ytext.toString();
  net.flush();
  const merged = a.ytext.toString();
  assert.equal(b.ytext.toString(), merged);
  assert.ok(!wellFormed(merged), "the precondition of #274: both regions kept, malformed");
  const changesAfterMerge = host.log.changes;
  net.release();
  await wait(SETTLED);

  const repairer = repairedBy([a, b], (peer) => peer.modeler.canvas());
  assert.equal(repairer, b, "equal footing: the lower Yjs client id repairs");
  assert.ok(wellFormed(host.ytext.toString()), "a fresh session can render the room");
  assert.equal(host.ytext.toString(), b.own);
  assert.equal(host.log.changes - changesAfterMerge, 1, "one repair write, nothing else");
  assert.deepEqual(b.conflicts, [], "the repairer keeps its edit");
  assert.equal(a.conflicts.length, 1, "the writer whose move is lost is told so, once");
  a.unbind();
  b.unbind();
});

/**
 * What bindDmn uses of dmn-js around the same XML: a manager whose edits fire
 * on the active viewer's command stack, and whose import clears the stage
 * before it parses.
 */
function dmnLikePeer(net: Relay, room: Uint8Array, clientId: number) {
  const doc = joinRoom(net, room, clientId);
  const ytext = doc.getText("content");
  const model = bpmnLikeModeler();
  const drd = {
    get: (service: string) => (service === "canvas" ? model.get() : undefined),
    on: model.on,
    off: model.off,
  };
  const modeler = {
    getActiveView: () => ({ type: "drd" }),
    getActiveViewer: () => drd,
    getViews: () => [{ type: "drd" }],
    open: async () => {},
    on: () => {},
    off: () => {},
    importXML: (xml: string) => model.importXML(xml),
    saveXML: () => model.saveXML(),
  };
  const conflicts: string[] = [];
  const imports: string[] = [];
  const unbind = bindDmn(
    modeler as never,
    ytext,
    doc,
    (message) => conflicts.push(message),
    (message) => imports.push(message),
  );
  return { doc, ytext, modeler: model, conflicts, imports, unbind, own: "" };
}

test("DMN: the dmn-js adapter repairs two drops at once the same way", async () => {
  const net = relay();
  const room = roomOf(XML);
  const peers = [dmnLikePeer(net, room, 100), dmnLikePeer(net, room, 200)];
  await wait(50);

  net.hold();
  peers[0]!.modeler.move("Task_c", 30, 0);
  peers[1]!.modeler.move("Task_e", 0, 30);
  await wait(20);
  for (const peer of peers) peer.own = peer.ytext.toString();
  net.flush();
  assert.ok(!wellFormed(peers[0]!.ytext.toString()));
  net.release();
  await wait(SETTLED);

  assert.equal(
    repairedBy(peers, (peer) => peer.modeler.canvas()),
    peers[0],
  );
  assert.deepEqual(
    peers.map((peer) => peer.conflicts.length),
    [0, 1],
  );
  assert.deepEqual(
    peers.map((peer) => peer.imports),
    [[], []],
  );
  for (const peer of peers) peer.unbind();
});

test("three peers: two drop at once, the third watches; one repair, the watcher converges without a toast", async () => {
  const net = relay();
  const room = roomOf(XML);
  const host = hostCopy(net, room);
  const peers = [bpmnPeer(net, room, 300), bpmnPeer(net, room, 100), bpmnPeer(net, room, 200)];
  const [a, b, watcher] = peers as [(typeof peers)[0], (typeof peers)[0], (typeof peers)[0]];
  await wait(50);

  net.hold();
  a.modeler.move("Task_a", 10, 70);
  b.modeler.move("Task_e", -20, 40);
  await wait(20);
  a.own = a.ytext.toString();
  b.own = b.ytext.toString();
  net.flush();
  assert.ok(!wellFormed(host.ytext.toString()));
  const changesAfterMerge = host.log.changes;
  net.release();
  await wait(SETTLED);

  const repairer = repairedBy([a, b], (peer) => peer.modeler.canvas());
  assert.equal(repairer, b);
  assert.equal(watcher.ytext.toString(), b.own);
  assert.equal(watcher.modeler.canvas(), b.own, "the watcher re-imports the repaired text");
  assert.equal(host.log.changes - changesAfterMerge, 1, "never two repairs of one broken state");
  assert.deepEqual(watcher.conflicts, [], "nothing of the watcher's was lost");
  assert.deepEqual(b.conflicts, []);
  assert.equal(a.conflicts.length, 1);
  for (const peer of peers) peer.unbind();
});

test("three peers drop at once: one repair, both other writers get the toast", async () => {
  const net = relay();
  const room = roomOf(XML);
  const host = hostCopy(net, room);
  const peers = [bpmnPeer(net, room, 300), bpmnPeer(net, room, 200), bpmnPeer(net, room, 100)];
  await wait(50);

  net.hold();
  peers.forEach((peer, index) => peer.modeler.move(TASKS[index + 1]!, 20 + index * 5, 30));
  await wait(20);
  for (const peer of peers) peer.own = peer.ytext.toString();
  net.flush();
  assert.ok(!wellFormed(host.ytext.toString()));
  const changesAfterMerge = host.log.changes;
  net.release();
  await wait(SETTLED);

  const repairer = repairedBy(peers, (peer) => peer.modeler.canvas());
  assert.equal(repairer, peers[2]);
  assert.equal(host.log.changes - changesAfterMerge, 1, "one repair write");
  assert.deepEqual(
    peers.map((peer) => peer.conflicts.length),
    [1, 1, 0],
  );
  for (const peer of peers) peer.unbind();
});

test("a concurrent write that arrives during the settle delay hands the repair to its writer: still one repair", async () => {
  const net = relay();
  const room = roomOf(XML);
  const host = hostCopy(net, room);
  const late = bpmnPeer(net, room, 100);
  const a = bpmnPeer(net, room, 200);
  const b = bpmnPeer(net, room, 300);
  await wait(50);

  net.hold();
  a.modeler.move("Task_b", 40, 30);
  b.modeler.move("Task_c", 0, 60);
  late.modeler.move("Task_f", -30, 10);
  await wait(20);
  for (const peer of [late, a, b]) peer.own = peer.ytext.toString();
  // a and b see each other's drop at once; the third writer's network lags
  // behind until a has decided to repair (after its local edit's quiet
  // period and the import's debounce) but before its settle delay ends
  net.flush([a.doc, b.doc], [a.doc, b.doc, host.doc]);
  assert.ok(!wellFormed(a.ytext.toString()));
  await wait(1100);
  const changesBeforeLate = host.log.changes;
  net.release();
  await wait(SETTLED);

  const repairer = repairedBy([late, a, b], (peer) => peer.modeler.canvas());
  assert.equal(repairer, late, "the lowest client id among all three writers");
  assert.equal(host.log.changes - changesBeforeLate, 2, "the late drop and one repair, no second one");
  assert.deepEqual(
    [late, a, b].map((peer) => peer.conflicts.length),
    [0, 1, 1],
  );
  for (const peer of [late, a, b]) peer.unbind();
});

test("the writer whose canvas has taken in a peer's write repairs before a lower client id: nobody's edit goes silently", async () => {
  const net = relay();
  const room = roomOf(XML);
  const host = hostCopy(net, room);
  const a = bpmnPeer(net, room, 300);
  const b = bpmnPeer(net, room, 100);
  const c = bpmnPeer(net, room, 200);
  await wait(50);

  // b is cut off: a's drop reaches c, c takes it in and drops a move of its
  // own on top, and only then does b's drop (made on the old text) cross both
  net.hold();
  a.modeler.move("Task_a", 10, 70);
  await wait(20);
  net.flush([a.doc], [c.doc, host.doc]);
  await wait(1100);
  assert.match(c.modeler.canvas(), /element="Task_a"><bounds x="110" y="150"/, "c's canvas holds a's move");
  c.modeler.move("Task_c", 0, 60);
  await wait(20);
  c.own = c.ytext.toString();
  net.flush([c.doc], [a.doc, host.doc]);
  b.modeler.move("Task_e", -20, 40);
  await wait(20);
  b.own = b.ytext.toString();
  net.release();
  assert.ok(!wellFormed(host.ytext.toString()));
  await wait(SETTLED);

  const repairer = repairedBy([a, b, c], (peer) => peer.modeler.canvas());
  assert.equal(repairer, c, "c's write stands on a's, b's on nobody's");
  assert.match(host.ytext.toString(), /element="Task_a"><bounds x="110" y="150"/, "a's move kept");
  assert.deepEqual(
    [a, b, c].map((peer) => peer.conflicts.length),
    [0, 1, 0],
    "only b's move is lost, and b is told",
  );
  for (const peer of [a, b, c]) peer.unbind();
});

test("typing in the source view is never written over: a half-typed tag while two canvases drop leaves no repair", async () => {
  for (const where of ["a peer's source view", "the repairer's own source view"] as const) {
    const net = relay();
    const room = roomOf(XML);
    const host = hostCopy(net, room);
    const a = bpmnPeer(net, room, 200);
    const b = bpmnPeer(net, room, 100);
    const typist = where === "a peer's source view" ? joinRoom(net, room) : b.doc;
    const source = typist.getText("content");
    await wait(50);

    net.hold();
    a.modeler.move("Task_b", 40, 30);
    b.modeler.move("Task_d", 35, -20);
    await wait(20);
    const own = [a.ytext.toString(), b.ytext.toString()];
    const end = source.toString().indexOf("  </process>");
    typist.transact(() => source.insert(end, '    <task id="Task_g" name="Ship'), { binding: "y-monaco" });
    net.flush();
    const merged = host.ytext.toString();
    assert.ok(merged.includes('<task id="Task_g" name="Ship'));
    const changesAfterMerge = host.log.changes;
    net.release();
    await wait(SETTLED);

    assert.equal(host.log.changes, changesAfterMerge, `${where}: no canvas writes over the typing`);
    assert.equal(host.ytext.toString(), merged, `${where}: the half-typed tag stays`);
    assert.deepEqual([a.modeler.canvas(), b.modeler.canvas()], own, `${where}: each canvas keeps its last good state`);
    assert.deepEqual([a.conflicts, b.conflicts], [[], []], where);
    a.unbind();
    b.unbind();
  }
});

test("someone who starts fixing the broken text by hand during the settle delay is not written over", async () => {
  const net = relay();
  const room = roomOf(XML);
  const host = hostCopy(net, room);
  const a = bpmnPeer(net, room, 200);
  const b = bpmnPeer(net, room, 100);
  const typist = joinRoom(net, room);
  const source = typist.getText("content");
  await wait(50);

  net.hold();
  a.modeler.move("Task_b", 40, 30);
  b.modeler.move("Task_d", 35, -20);
  await wait(20);
  net.release();
  // past the repairer's decision, inside its settle delay
  await wait(1050);
  const broken = source.toString();
  assert.ok(!wellFormed(broken));
  typist.transact(() => source.delete(broken.indexOf("<?xml"), 1), { binding: "y-monaco" });
  const typed = host.ytext.toString();
  const changesAfterTyping = host.log.changes;
  await wait(SETTLED);

  assert.equal(host.log.changes, changesAfterTyping, "the repair stands down");
  assert.equal(host.ytext.toString(), typed);
  a.unbind();
  b.unbind();
});

test("an agent's save that crosses two canvas drops is never written over", async () => {
  const net = relay();
  const room = roomOf(XML);
  const host = hostCopy(net, room);
  const a = bpmnPeer(net, room, 100);
  const b = bpmnPeer(net, room, 200);
  await wait(50);

  // the agent's save reaches the room through the Live Host (putContent →
  // updateText: a whole-document write, no canvas write) while a and b drop
  const agent = bpmnLikeModeler();
  agent.move("Task_c", 0, 90);
  net.hold();
  updateText(host.ytext, agent.canvas());
  a.modeler.move("Task_b", 40, 30);
  b.modeler.move("Task_d", 35, -20);
  await wait(20);
  const own = [a.ytext.toString(), b.ytext.toString()];
  net.flush();
  const merged = host.ytext.toString();
  assert.ok(!wellFormed(merged), "the save and the drops overlap");
  const changesAfterMerge = host.log.changes;
  net.release();
  await wait(SETTLED);

  assert.equal(host.log.changes, changesAfterMerge, "no canvas writes over the agent's save");
  assert.equal(a.ytext.toString(), merged);
  assert.deepEqual([a.modeler.canvas(), b.modeler.canvas()], own, "rule 4: each canvas keeps its last good state");
  assert.deepEqual([a.conflicts, b.conflicts], [[], []]);
  a.unbind();
  b.unbind();
});

test("one canvas drop into a half-typed text is no concurrent canvas break: no repair", async () => {
  const net = relay();
  const room = roomOf(XML);
  const host = hostCopy(net, room);
  const a = bpmnPeer(net, room, 100);
  const typist = joinRoom(net, room);
  const source = typist.getText("content");
  await wait(50);

  // a namespace being typed into the root element, outside the drop's region
  const root = source.toString().indexOf(">", source.toString().indexOf("<definitions"));
  typist.transact(() => source.insert(root, ' xmlns:x="http://'), { binding: "y-monaco" });
  await wait(20);
  a.modeler.move("Task_e", 25, 25);
  await wait(SETTLED);
  assert.match(host.ytext.toString(), /<definitions id="Definitions_1" xmlns:x="http:\/\/>/, "the typing stays");
  assert.match(host.ytext.toString(), /element="Task_e"><bounds x="725" y="105"/, "the drop merged next to it");
  a.unbind();
});

/* ── a JSON notation (Context Maps, Team Topologies) ──────────────────────── */

/** a hand-written file: one line, keys in the writer's order; the canonical export rewrites all of it */
const HAND_WRITTEN_JSON = JSON.stringify({
  title: "Conference",
  contexts: [
    { label: "CfP", id: "ctx_cfp", position: { x: 40, y: 40 } },
    { label: "Agenda", id: "ctx_agenda", position: { x: 400, y: 40 } },
    { label: "Venue", id: "ctx_venue", position: { x: 800, y: 40 } },
  ],
});

interface Context {
  id: string;
  label: string;
  position: { x: number; y: number };
}

/** a collaborative modeler of a JSON notation: canonical pretty text, refuses what is no JSON (L7) */
function jsonModeler(notation: string) {
  let document: { title: string; contexts: Context[] } = { title: "", contexts: [] };
  const listeners = new Set<() => void>();
  const canonical = (): string =>
    `${JSON.stringify(
      {
        contexts: [...document.contexts]
          .sort((x, y) => x.id.localeCompare(y.id))
          .map(({ id, label, position }) => ({ id, label, position })),
        title: document.title,
      },
      null,
      2,
    )}\n`;
  const modeler: CollaborativeModeler & { move(id: string, dx: number): void } = {
    meta: { notation, apiVersion: MODELER_API_VERSION, editable: true },
    attachTo: () => {},
    async importText(text) {
      document = JSON.parse(text) as typeof document;
      return { warnings: [] };
    },
    exportText: canonical,
    onContentChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getViewState: () => undefined,
    setViewState: () => {},
    destroy: () => {},
    move(id, dx) {
      document = {
        ...document,
        contexts: document.contexts.map((c) =>
          c.id === id ? { ...c, position: { ...c.position, x: c.position.x + dx } } : c,
        ),
      };
      for (const listener of [...listeners]) listener();
    },
  };
  return modeler;
}

/* ── a text DSL whose parser refuses what it cannot read ──────────────────── */

/** hand-written: no space after the comma, one decimal; the canonical export rewrites every line */
const HAND_WRITTEN_DSL = "component Tea [0.5,0.5]\ncomponent Cup [0.7,0.8]\ncomponent Kettle [0.2,0.4]\n";

function dslModeler() {
  let components = new Map<string, [number, number]>();
  const listeners = new Set<() => void>();
  const line = /^component ([A-Za-z]+) \[(\d(?:\.\d+)?), ?(\d(?:\.\d+)?)\]$/;
  const modeler: CollaborativeModeler & { move(name: string, dx: number): void } = {
    meta: { notation: "wardley", apiVersion: MODELER_API_VERSION, editable: true },
    attachTo: () => {},
    async importText(text) {
      const next = new Map<string, [number, number]>();
      text
        .split("\n")
        .filter(Boolean)
        .forEach((source, index) => {
          const match = line.exec(source);
          if (!match || next.has(match[1]!)) throw new Error(`Line ${index + 1}: cannot read "${source}"`);
          next.set(match[1]!, [Number(match[2]), Number(match[3])]);
        });
      components = next;
      return { warnings: [] };
    },
    exportText: () =>
      [...components].map(([name, [x, y]]) => `component ${name} [${x.toFixed(2)}, ${y.toFixed(2)}]\n`).join(""),
    onContentChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getViewState: () => undefined,
    setViewState: () => {},
    destroy: () => {},
    move(name, dx) {
      const [x, y] = components.get(name)!;
      components = new Map(components).set(name, [Math.round((x + dx) * 100) / 100, y]);
      for (const listener of [...listeners]) listener();
    },
  };
  return modeler;
}

test("a JSON notation and a text DSL: both peers' first edits of a hand-written file at once are repaired into one export", async () => {
  const cases = [
    {
      name: "JSON",
      text: HAND_WRITTEN_JSON,
      create: () => jsonModeler("context-maps"),
      moves: ["ctx_cfp", "ctx_venue"],
    },
    { name: "text DSL", text: HAND_WRITTEN_DSL, create: dslModeler, moves: ["Tea", "Kettle"] },
  ];
  for (const { name, text, create, moves } of cases) {
    const net = relay();
    const room = roomOf(text);
    const host = hostCopy(net, room);
    const peers = [100, 200].map((clientId) => {
      const doc = joinRoom(net, room, clientId);
      const ytext = doc.getText("content");
      const modeler = create();
      const conflicts: string[] = [];
      const imports: string[] = [];
      const unbind = bindMiragon(
        modeler,
        modeler.meta.notation,
        ytext,
        doc,
        (message) => conflicts.push(message),
        (message) => imports.push(message),
      );
      return { ytext, modeler, conflicts, imports, unbind, own: "" };
    });
    await wait(50);

    net.hold();
    peers.forEach((peer, index) => peer.modeler.move(moves[index]!, 0.1));
    await wait(20);
    for (const peer of peers) peer.own = peer.ytext.toString();
    net.flush();
    await assert.rejects(create().importText(host.ytext.toString()), `${name}: the merge does not import`);
    net.release();
    await wait(SETTLED);

    const repairer = repairedBy(peers, (peer) => peer.modeler.exportText());
    assert.equal(repairer, peers[0], name);
    await assert.doesNotReject(create().importText(host.ytext.toString()), `${name}: a fresh session imports it`);
    assert.deepEqual(
      peers.map((peer) => peer.conflicts.length),
      [0, 1],
      name,
    );
    assert.deepEqual(
      peers.map((peer) => peer.imports),
      [[], []],
      `${name}: a later rejection is no first-import failure`,
    );
    for (const peer of peers) peer.unbind();
  }
});
