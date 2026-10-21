/**
 * What the merge safety-net tests (#274) share: real Y.Docs behind a network
 * the test controls, and notations shaped like the real ones where it
 * matters (how far one edit's export reaches, what the parser refuses).
 *
 * Two networks: relay() is the Live Host's fan-out as one mesh, holding every
 * update until flushed, so peers write before either receives; hub() is the
 * Live Host as a server with one link per peer, each of which can lag, drop
 * offline and re-sync the way y-protocols does (one update each way).
 */
import assert from "node:assert/strict";

import { CANVAS_LOSSES_KEY } from "@designiq/contracts/live";
import { type CollaborativeModeler, MODELER_API_VERSION } from "@miragon/modeler-api";
import * as Y from "yjs";

import { bindBpmn } from "../../src/bpmn-sync.ts";
import { bindMiragon } from "../../src/miragon-sync.ts";

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** the local edit's quiet period, the import's debounce, the repair's settle delay and the peers' re-import */
export const SETTLED = 2400;
/** a local edit's quiet period and the import's debounce, with margin: the peers have taken in an edit */
export const QUIET = 1300;

/**
 * Well-formed XML for the fixtures of these files: tags with quoted
 * attributes, no `<` inside them, balanced. The failure of #274 ("< is not
 * allowed in attributes", "Unexpected closing tag") is exactly what it rejects.
 */
export function wellFormed(text: string): boolean {
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
export function relay() {
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

export type Relay = ReturnType<typeof relay>;

/** a doc that starts from the room's state; a fixed client id decides ties the same way on every run */
export function joinRoom(net: Relay, room: Uint8Array, clientId?: number): Y.Doc {
  const doc = new Y.Doc();
  if (clientId !== undefined) doc.clientID = clientId;
  Y.applyUpdate(doc, room, RELAYED);
  net.join(doc);
  return doc;
}

export function roomOf(text: string): Uint8Array {
  const seed = new Y.Doc();
  seed.getText("content").insert(0, text);
  return Y.encodeStateAsUpdate(seed);
}

/**
 * What reaches a doc: its text changes, and the repairs, one entry per
 * repair transaction naming its writer (a repair is the canvas write that
 * leaves loss notices). Counted on the Live Host's copy, two repairs that
 * crossed are two entries even where one's deletions fall inside the other's.
 */
export function watch(doc: Y.Doc) {
  const ytext = doc.getText("content");
  const log = { changes: 0, repairs: [] as number[] };
  ytext.observe(() => log.changes++);
  doc.getMap(CANVAS_LOSSES_KEY).observe((event) => {
    if (![...event.changes.keys.values()].some((change) => change.action !== "delete")) return;
    const { beforeState, afterState } = event.transaction;
    for (const [client, clock] of afterState) if (clock > (beforeState.get(client) ?? 0)) log.repairs.push(client);
  });
  return { doc, ytext, log };
}

/** the Live Host's own copy on the relay */
export const hostCopy = (net: Relay, room: Uint8Array) => watch(joinRoom(net, room));

const FROM_SERVER = Symbol("server");

/**
 * The Live Host as a server: one link per peer, each direction of which can
 * be held (the link lags: updates queue and arrive in order), and a peer can
 * go offline (nothing flows) and reconnect with the y-protocols sync, the
 * server's missing state in one update and the peer's in one.
 */
export function hub(room: Uint8Array) {
  const server = new Y.Doc();
  Y.applyUpdate(server, room);
  interface Link {
    doc: Y.Doc;
    online: boolean;
    up: Uint8Array[];
    down: Uint8Array[];
    holdUp: boolean;
    holdDown: boolean;
  }
  const links: Link[] = [];
  const deliverDown = (link: Link): void => {
    for (const update of link.down.splice(0)) Y.applyUpdate(link.doc, update, FROM_SERVER);
  };
  const deliverUp = (link: Link): void => {
    for (const update of link.up.splice(0)) Y.applyUpdate(server, update, link);
  };
  server.on("update", (update: Uint8Array, origin: unknown) => {
    for (const link of links) {
      if (link === origin || !link.online) continue;
      link.down.push(update);
      if (!link.holdDown) deliverDown(link);
    }
  });
  const linkOf = (doc: Y.Doc): Link => links.find((link) => link.doc === doc)!;
  return {
    host: watch(server),
    join(clientId: number): Y.Doc {
      const doc = new Y.Doc();
      doc.clientID = clientId;
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(server), FROM_SERVER);
      const link: Link = { doc, online: true, up: [], down: [], holdUp: false, holdDown: false };
      links.push(link);
      doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === FROM_SERVER || !link.online) return;
        link.up.push(update);
        if (!link.holdUp) deliverUp(link);
      });
      return doc;
    },
    hold(doc: Y.Doc, direction: "up" | "down" | "both" = "both"): void {
      const link = linkOf(doc);
      if (direction !== "down") link.holdUp = true;
      if (direction !== "up") link.holdDown = true;
    },
    release(doc: Y.Doc): void {
      const link = linkOf(doc);
      link.holdUp = false;
      link.holdDown = false;
      deliverUp(link);
      deliverDown(link);
    },
    offline(doc: Y.Doc): void {
      const link = linkOf(doc);
      link.online = false;
      link.up.length = 0;
      link.down.length = 0;
    },
    reconnect(doc: Y.Doc): void {
      const link = linkOf(doc);
      link.online = true;
      link.holdUp = false;
      link.holdDown = false;
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, Y.encodeStateVector(doc)), FROM_SERVER);
      Y.applyUpdate(server, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(server)), link);
    },
  };
}

export type Hub = ReturnType<typeof hub>;

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

export const TASKS = ["Task_a", "Task_b", "Task_c", "Task_d", "Task_e", "Task_f"];
export const XML = bpmnLike(TASKS, new Map(TASKS.map((id, index) => [id, { x: 100 + index * 150, y: 80 }])));

function parseBpmnLike(xml: string): { order: string[]; bounds: Map<string, Bounds> } {
  const order = [...xml.matchAll(/<flowNodeRef>([^<]+)<\/flowNodeRef>/g)].map((m) => m[1]!);
  const bounds = new Map(
    [...xml.matchAll(/element="(Task_\w+)"><bounds x="(-?\d+)" y="(-?\d+)"/g)].map(
      (m) => [m[1]!, { x: Number(m[2]), y: Number(m[3]) }] as const,
    ),
  );
  return { order, bounds };
}

/** where a text draws a task */
export const boundsOf = (xml: string, id: string): Bounds | undefined => parseBpmnLike(xml).bounds.get(id);

/** what bindBpmn uses of bpmn-js, around the serialization above */
export function bpmnLikeModeler() {
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

/** a canvas of the BPMN-like notation bound to `doc`; `own` is for the test to keep its export */
export function bpmnPeerOn(doc: Y.Doc) {
  const ytext = doc.getText("content");
  const modeler = bpmnLikeModeler();
  const conflicts: string[] = [];
  const unbind = bindBpmn(modeler as never, ytext, doc, (message) => conflicts.push(message));
  return { doc, ytext, modeler, conflicts, unbind, own: "" };
}

export const bpmnPeer = (net: Relay, room: Uint8Array, clientId?: number) => bpmnPeerOn(joinRoom(net, room, clientId));

export type Peer = { ytext: Y.Text; conflicts: string[]; own: string; unbind(): void };

/** after the drops: every peer holds the same text, and it is exactly the repairer's own export */
export function repairedBy<P extends Peer>(peers: readonly P[], canvasOf: (peer: P) => string): P {
  const text = peers[0]!.ytext.toString();
  for (const peer of peers) assert.equal(peer.ytext.toString(), text, "the peers converge");
  for (const peer of peers) assert.equal(canvasOf(peer), text, "each canvas shows the shared text");
  const repairer = peers.find((peer) => peer.own === text);
  assert.ok(repairer, "the shared text is exactly one writer's own export");
  return repairer;
}

/* ── a notation of one line per element: edits of different elements are disjoint ── */

/**
 * `Task_x 100 100` per element, positions three digits wide. Strict, the
 * parser refuses a line it cannot read; lenient, it reads every line it can
 * and keeps a duplicate (the way the Wardley and Event Storming parsers keep a
 * garbled merge, renaming or suffixing what they read twice).
 */
export const LINES = ["a", "b", "c", "d", "e", "f"].map((k) => `Task_${k} 100 100`).join("\n") + "\n";
const LINE = /^(Task_\w+) (\d{3}) (\d{3})$/;

export function linesModeler(lenient = false) {
  let positions = new Map<string, [number, number]>();
  const listeners = new Set<() => void>();
  const exportText = (): string =>
    [...positions]
      .map(([id, [x, y]]) => `${id} ${String(x).padStart(3, "0")} ${String(y).padStart(3, "0")}\n`)
      .join("");
  const modeler: CollaborativeModeler & { set(id: string, x: number): void; canvas(): string } = {
    meta: { notation: "lines", apiVersion: MODELER_API_VERSION, editable: true },
    attachTo: () => {},
    async importText(text) {
      const next = new Map<string, [number, number]>();
      for (const line of text.split("\n").filter(Boolean)) {
        const match = LINE.exec(line);
        if (!match && lenient) continue;
        if (!match || (next.has(match[1]!) && !lenient)) throw new Error(`cannot read "${line}"`);
        let id = match[1]!;
        for (let copy = 2; next.has(id); copy++) id = `${match[1]}_${copy}`;
        next.set(id, [Number(match[2]), Number(match[3])]);
      }
      positions = next;
      return { warnings: [] };
    },
    exportText,
    onContentChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getViewState: () => undefined,
    setViewState: () => {},
    destroy: () => {},
    set(id, x) {
      positions = new Map(positions).set(id, [x, positions.get(id)![1]]);
      for (const listener of [...listeners]) listener();
    },
    canvas: exportText,
  };
  return modeler;
}

export function linesPeerOn(doc: Y.Doc, lenient = false) {
  const ytext = doc.getText("content");
  const modeler = linesModeler(lenient);
  const conflicts: string[] = [];
  const unbind = bindMiragon(modeler, "lines", ytext, doc, (message) => conflicts.push(message));
  return { doc, ytext, modeler, conflicts, unbind, own: "" };
}

/** where a text of the line notation puts an element (undefined: the line is missing or garbled) */
export const xOf = (text: string, id: string): number | undefined => {
  const match = new RegExp(`^${id} (\\d{3}) \\d{3}$`, "m").exec(text);
  return match ? Number(match[1]) : undefined;
};

type BpmnPeer = ReturnType<typeof bpmnPeerOn>;

/**
 * The positive control of a guard: once the canvases have taken in a whole
 * text that `writeWhole` writes through someone else (a typist, an agent),
 * two drops at once are repaired, by one writer, around what that text
 * changed. The guards pass on an engine that never repairs; this part of each
 * does not. `network` holds and releases what passes between the two writers.
 */
export async function thenCrossingDropsAreRepaired(
  where: string,
  network: { hold(): void; release(): void },
  host: { ytext: Y.Text; log: { repairs: number[] } },
  [a, b]: readonly [BpmnPeer, BpmnPeer],
  writeWhole: (whole: string) => void,
): Promise<void> {
  const typed = bpmnLikeModeler();
  typed.move("Task_c", 0, 90);
  writeWhole(typed.canvas());
  await wait(SETTLED);
  assert.deepEqual([a.modeler.canvas(), b.modeler.canvas()], [typed.canvas(), typed.canvas()], `${where}: taken in`);
  const repairsBefore = host.log.repairs.length;
  network.hold();
  a.modeler.move("Task_a", 5, 5);
  b.modeler.move("Task_f", -5, 5);
  await wait(20);
  network.release();
  await wait(SETTLED);
  assert.equal(host.log.repairs.length - repairsBefore, 1, `${where}: the crossing drops are repaired, once`);
  assert.ok(wellFormed(host.ytext.toString()), where);
  assert.deepEqual(
    boundsOf(host.ytext.toString(), "Task_c"),
    { x: 400, y: 170 },
    `${where}: the whole text's edit stays`,
  );
}
