/**
 * The Miragon widget engine without a browser (src/mcp-app/engines/miragon.ts)
 * against a fake collaborative modeler that keeps the @miragon/modeler-api
 * laws: which factory a mount takes and with what, the contract check, the
 * change event as the widget's dirty signal, the selection from the element
 * surface, and the live binding through the real live-client adapter. Plus
 * the fit and zoom math every diagram engine shares (the modeler shell's
 * view math, designIQ's zoom step in src/mcp-app/engines/fit.ts) and the
 * import fit with the chrome's insets (engines/diagram-js.ts diagramView).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MODELER_API_VERSION } from "@miragon/modeler-api";
import {
  defaultMessages,
  easeStandard,
  FIT_ANIMATION_MS,
  fitViewbox,
  formatPercent,
  interpolateViewbox,
  sameView,
  VIEW_TOLERANCE,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomReadout,
} from "@miragon/modeler-shell/core";
import * as Y from "yjs";

import type { Insets } from "../src/mcp-app/core/engine.ts";
import { diagramView } from "../src/mcp-app/engines/diagram-js.ts";
import { type Box, scaleOf, steppedLevel, zoomAround } from "../src/mcp-app/engines/fit.ts";
import { mountMiragonEngine } from "../src/mcp-app/engines/miragon.ts";
import type {
  LoadedMiragonRenderer,
  MiragonDiagram,
  MiragonModeler,
  MiragonMountOptions,
} from "../src/notations/miragon/spec.ts";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const container = {} as HTMLElement;
const SPEC = { contractNotation: "wardley" };

/** a canvas that keeps a real viewbox: the setter emits canvas.viewbox.changed
 *  synchronously, like diagram-js 15 */
function fakeCanvas(inner: Box, outer: { width: number; height: number }, emit: (event: string) => void) {
  let current: Box = { x: 0, y: 0, width: outer.width, height: outer.height };
  const writes: Box[] = [];
  return {
    writes,
    viewbox(box?: Box | false) {
      if (!box) return { ...current, scale: outer.width / current.width, inner, outer };
      current = { ...box };
      writes.push(current);
      emit("canvas.viewbox.changed");
      return undefined;
    },
    zoom: () => {},
  };
}

/**
 * A renderer whose factories build lawful collaborative modelers over one
 * fake diagram: a silent import that fires the diagram's import events and
 * leaves the view at the renderer's own fit (`fitted`), a canonical export
 * that is not a byte copy of the import, a change event per user edit, and
 * no change event ever from the viewer. `importFails` rejects every import.
 */
function fakeRenderer(
  o: {
    notation?: string;
    selection?: string[];
    importFails?: boolean;
    inner?: Box;
    outer?: { width: number; height: number };
    fitted?: Box;
  } = {},
) {
  const handlers = new Map<string, Set<(event?: unknown) => void>>();
  const emit = (event: string): void => handlers.get(event)?.forEach((cb) => cb());
  const outer = o.outer ?? { width: 720, height: 520 };
  const canvas = fakeCanvas(o.inner ?? { x: 0, y: 0, width: 100, height: 100 }, outer, emit);
  const state = {
    mounts: [] as Array<{ factory: "create" | "createViewer"; options: MiragonMountOptions | undefined }>,
    attached: [] as HTMLElement[],
    imported: [] as string[],
    destroyed: 0,
    text: "",
  };
  const contentListeners = new Set<() => void>();
  const diagram: MiragonDiagram = {
    get: (service) => {
      if (service === "canvas") return canvas;
      throw new Error(`No provider for "${service}"`);
    },
    on: (event, cb) => void (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(cb),
    off: (event, cb) => void handlers.get(event)?.delete(cb),
  };
  const modeler = (editable: boolean): MiragonModeler => ({
    meta: { notation: o.notation ?? "wardley", apiVersion: MODELER_API_VERSION, editable },
    elements: {
      list: () => [],
      reveal: () => false,
      selection: () => o.selection ?? [],
      onSelection: () => () => {},
    },
    diagram,
    attachTo: (host) => void state.attached.push(host as HTMLElement),
    async importText(text) {
      if (o.importFails) throw new Error("parse");
      emit("import.parse.start");
      state.imported.push(text);
      state.text = text;
      if (o.fitted) canvas.viewbox(o.fitted);
      emit("import.done");
      return { warnings: [] };
    },
    exportText: () => `canonical(${state.text})`,
    onContentChanged(cb) {
      if (!editable) return () => {};
      contentListeners.add(cb);
      return () => contentListeners.delete(cb);
    },
    getViewState: () => {
      const { x, y, width, height } = canvas.viewbox() as Box;
      return { x, y, width, height };
    },
    setViewState: (view) => void canvas.viewbox(view as Box),
    destroy: () => void state.destroyed++,
  });
  const renderer: LoadedMiragonRenderer = {
    create(options) {
      state.mounts.push({ factory: "create", options });
      return modeler(true);
    },
    createViewer(options) {
      state.mounts.push({ factory: "createViewer", options });
      return modeler(false);
    },
  };
  /** a user's edit on the canvas */
  const edit = (text: string): void => {
    state.text = text;
    for (const cb of [...contentListeners]) cb();
  };
  return { state, renderer, edit, emit, canvas, outer };
}

test("editable mount: create() with the chrome's insets, attached to the host; the change event is the dirty signal", async () => {
  const insets: Insets = { top: 60, right: 16, bottom: 56, left: 16 };
  const { state, renderer, edit } = fakeRenderer();
  const host = {} as HTMLElement;
  const engine = mountMiragonEngine(SPEC, renderer, host, false, { insets: () => insets });
  assert.equal(state.mounts.length, 1);
  assert.equal(state.mounts[0]!.factory, "create");
  assert.deepEqual(state.mounts[0]!.options?.insets?.(), insets, "the renderer's free area is the chrome's");
  assert.deepEqual(state.attached, [host]);
  assert.equal(engine.editable, true);
  let dirty = 0;
  const off = engine.onDirty(() => dirty++);
  await engine.importText("component A [0.1, 0.2]");
  assert.equal(dirty, 0, "L1: an import is no edit — the engine needs no latch for it");
  edit("component A [0.1, 0.2]\ncomponent B [0.5, 0.5]");
  assert.equal(dirty, 1, "a user's edit is");
  off();
  edit("x");
  assert.equal(dirty, 1, "unsubscribed");
  assert.equal(await engine.exportText(), "canonical(x)", "the modeler's canonical text, not the imported one");
  engine.destroy();
  assert.equal(state.destroyed, 1);
});

test("read-only mount: createViewer(), no change events, no export; without the chrome no insets", async () => {
  const { state, renderer, edit } = fakeRenderer();
  const engine = mountMiragonEngine(SPEC, renderer, container, true);
  assert.deepEqual(
    state.mounts.map((m) => [m.factory, m.options?.insets]),
    [["createViewer", undefined]],
  );
  assert.equal(engine.editable, false);
  let dirty = 0;
  engine.onDirty(() => dirty++);
  await engine.importText("x");
  edit("y");
  assert.equal(dirty, 0, "a viewer reports no change");
  await assert.rejects(() => engine.exportText(), /read-only/);
});

test("the contract check: a renderer of another notation never mounts, and its instance is torn down", () => {
  const { state, renderer } = fakeRenderer({ notation: "context-maps" });
  assert.throws(
    () => mountMiragonEngine({ contractNotation: "team-topologies" }, renderer, container, false),
    /expected a 'team-topologies' modeler, got 'context-maps'/,
  );
  assert.equal(state.destroyed, 1);
  assert.deepEqual(state.attached, [], "never attached");
});

test("selectedElementId: the element surface's selection when it is one element, else undefined", () => {
  const one = mountMiragonEngine(SPEC, fakeRenderer({ selection: ["cmp_tea"] }).renderer, container, false);
  assert.equal(one.selectedElementId?.(), "cmp_tea");
  const two = mountMiragonEngine(SPEC, fakeRenderer({ selection: ["a", "b"] }).renderer, container, false);
  assert.equal(two.selectedElementId?.(), undefined);
  const none = mountMiragonEngine(SPEC, fakeRenderer().renderer, container, false);
  assert.equal(none.selectedElementId?.(), undefined);
});

test("a rejected import rejects the engine's importText, and later edits still count", async () => {
  const { renderer, edit } = fakeRenderer({ importFails: true });
  const engine = mountMiragonEngine(SPEC, renderer, container, false);
  let dirty = 0;
  engine.onDirty(() => dirty++);
  await assert.rejects(() => engine.importText("x"), /parse/);
  edit("y");
  assert.equal(dirty, 1);
});

test("bindLive hands the modeler to live-client's miragon-sync: the Y.Text imports, canvas edits export, hooks are threaded", async () => {
  const { state, renderer, edit } = fakeRenderer();
  const engine = mountMiragonEngine(SPEC, renderer, container, false);
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, "component A [0.1, 0.2]\n");
  const errors: string[] = [];
  const unbind = engine.bindLive!(ytext, doc, { onConflict: () => {}, onImportError: (m) => errors.push(m) });
  await tick(50);
  assert.deepEqual(state.imported, ["component A [0.1, 0.2]\n"], "the Y.Text landed on the canvas");
  assert.equal(ytext.toString(), "component A [0.1, 0.2]\n", "and was not rewritten");
  edit("component A [0.1, 0.2]\ncomponent B [0.5, 0.5]\n");
  await tick(20);
  assert.equal(ytext.toString(), "canonical(component A [0.1, 0.2]\ncomponent B [0.5, 0.5]\n)");
  unbind();
  edit("gone");
  await tick(20);
  assert.doesNotMatch(ytext.toString(), /gone/, "unbound: canvas edits no longer export");

  // the import-error hook: a document that never rendered reports once
  const empty = new Y.Doc();
  const unbindEmpty = engine.bindLive!(empty.getText("content"), empty, {
    onConflict: () => {},
    onImportError: (m) => errors.push(m),
  });
  await tick(50);
  assert.deepEqual(errors, ["the document is empty"]);
  unbindEmpty();

  // a rejection's own reason, unchanged
  const failing = mountMiragonEngine(SPEC, fakeRenderer({ importFails: true }).renderer, container, false);
  const refused = new Y.Doc();
  refused.getText("content").insert(0, "component");
  const unbindRefused = failing.bindLive!(refused.getText("content"), refused, {
    onConflict: () => {},
    onImportError: (m) => errors.push(m),
  });
  await tick(50);
  assert.deepEqual(errors, ["the document is empty", "parse"]);
  unbindRefused();
});

// ── fit and zoom: the shell's view math (@miragon/modeler-shell/core) and
// designIQ's own step (engines/fit.ts). The cases are the ones engines/fit.ts
// held its own fitViewbox, isUntouched, easing and readout to; each now holds
// the shell's function to the same numbers ───────────────────────────────────

/** where a diagram box lands on screen under a viewbox (px, frame-relative) */
function onScreen(box: Box, viewbox: Box, outer: { width: number; height: number }) {
  const scale = scaleOf(viewbox, outer);
  return {
    left: (box.x - viewbox.x) * scale,
    top: (box.y - viewbox.y) * scale,
    right: (box.x + box.width - viewbox.x) * scale,
    bottom: (box.y + box.height - viewbox.y) * scale,
    scale,
  };
}
const close = (a: number, b: number, eps = 1e-6): void => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
/** the shell's fit as the box diagramView writes to the canvas */
function fitted(bbox: Box, outer: { width: number; height: number }, insets: Insets): Box {
  const target = fitViewbox(bbox, outer, insets);
  assert.ok(target, "a fit");
  const { x, y, width, height } = target;
  return { x, y, width, height };
}

test("fitViewbox: the content lands inside the insets, centred in the inner rect, width-limited at 720x520", () => {
  const outer = { width: 720, height: 520 };
  // the 720 bpmn inline frame: corner row, left palette column, bottom row
  const insets: Insets = { top: 60, right: 16, bottom: 56, left: 122 };
  const bbox = { x: 150, y: 80, width: 1000, height: 500 };
  const vb = fitted(bbox, outer, insets);
  const s = onScreen(bbox, vb, outer);
  close(s.scale, 0.582); // (720 − 138) / 1000 — narrower than (520 − 116) / 500
  close(s.left, 122);
  close(s.right, 704); // 720 − 16
  // height-centred in the 404px inner rect
  close(s.top - 60, 520 - 56 - s.bottom);
  assert.equal(vb.width, outer.width / s.scale, "the viewbox spans the WHOLE frame");
  // the numbers designIQ's own fitViewbox gave for this frame
  close(vb.x, 150 - 122 / 0.582, 1e-9);
  close(vb.y, 80 - (60 + (404 - 500 * 0.582) / 2) / 0.582, 1e-9);
});

test("fitViewbox: never above 100 % — small content is centred at scale 1", () => {
  const outer = { width: 1280, height: 760 };
  const insets: Insets = { top: 64, right: 388, bottom: 60, left: 16 }; // a 360 card open
  const bbox = { x: -40, y: 10, width: 200, height: 100 };
  const vb = fitted(bbox, outer, insets);
  const s = onScreen(bbox, vb, outer);
  close(s.scale, 1);
  close(s.left - 16, 1280 - 388 - s.right);
  close(s.top - 64, 760 - 60 - s.bottom);
});

test("fitViewbox: identical to designIQ's own fit for every frame whose insets leave room", () => {
  // designIQ's former math: the inner rect, the smaller ratio, capped at 1, centred
  const own = (bbox: Box, outer: { width: number; height: number }, insets: Insets): Box => {
    const innerW = outer.width - insets.left - insets.right;
    const innerH = outer.height - insets.top - insets.bottom;
    const scale = Math.min(
      bbox.width > 0 ? innerW / bbox.width : Infinity,
      bbox.height > 0 ? innerH / bbox.height : Infinity,
      1,
    );
    return {
      x: bbox.x - (insets.left + (innerW - bbox.width * scale) / 2) / scale,
      y: bbox.y - (insets.top + (innerH - bbox.height * scale) / 2) / scale,
      width: outer.width / scale,
      height: outer.height / scale,
    };
  };
  let seed = 7;
  const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 2000; i++) {
    const outer = { width: 300 + random() * 1500, height: 200 + random() * 1000 };
    const insets: Insets = { top: random() * 150, right: random() * 400, bottom: random() * 100, left: random() * 150 };
    if (outer.width - insets.left - insets.right < 1 || outer.height - insets.top - insets.bottom < 1) continue;
    const bbox = {
      x: random() * 2000 - 1000,
      y: random() * 2000 - 1000,
      width: i % 40 === 0 ? 0 : 1 + random() * 4000,
      height: i % 40 === 20 ? 0 : 1 + random() * 3000,
    };
    const shell = fitted(bbox, outer, insets);
    const mine = own(bbox, outer, insets);
    for (const key of ["x", "y", "width", "height"] as const) {
      close(shell[key], mine[key], 1e-9 * Math.max(1, Math.abs(mine[key])));
    }
  }
});

test("fitViewbox: nothing to fit is no fit, and a frame lower or narrower than its chrome centres in the whole frame", () => {
  const insets: Insets = { top: 60, right: 16, bottom: 56, left: 16 };
  // designIQ's fit centred an empty diagram's origin at 100 %; diagramView
  // never asked it to (an empty canvas has nothing to fit), and the shell says so
  assert.equal(fitViewbox({ x: 0, y: 0, width: 0, height: 0 }, { width: 480, height: 480 }, insets), undefined);
  assert.equal(fitViewbox({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 0 }, insets), undefined);
  // 50×40 under 32px of sides and 116px of rows: designIQ's fit squeezed the
  // content into 1px of it (0.01); the shell fits it into the whole frame
  const tiny = fitted({ x: 0, y: 0, width: 100, height: 100 }, { width: 50, height: 40 }, insets);
  for (const v of Object.values(tiny)) assert.ok(Number.isFinite(v), "finite");
  close(scaleOf(tiny, { width: 50, height: 40 }), 0.18);
});

test("sameView: the last fit as diagram-js reads it back is untouched; a scroll or a zoom is a touch", () => {
  const outer = { width: 720, height: 520 };
  const fit = fitViewbox({ x: 40, y: 20, width: 1400, height: 600 }, outer, {
    top: 104,
    right: 16,
    bottom: 56,
    left: 16,
  });
  assert.ok(fit);
  assert.equal(sameView(fit, fit), true);
  // diagram-js keeps the scale and the translation (px) to three decimals
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const scale = round(fit.scale);
  const readBack = { x: round(fit.x * fit.scale) / scale, y: round(fit.y * fit.scale) / scale, scale };
  assert.notEqual(readBack.x, fit.x, "the read-back differs from what was written");
  assert.equal(sameView(readBack, fit), true, "never a touch");
  assert.equal(sameView({ ...fit, x: fit.x + 30 / fit.scale }, fit), false, "a 30px scroll");
  assert.equal(sameView({ ...fit, scale: fit.scale * 0.8 }, fit), false, "a zoom");
  assert.equal(VIEW_TOLERANCE, 1e-3);
});

test("zoomAround: the diagram point under the screen point stays put, the level is exact", () => {
  const outer = { width: 720, height: 520 };
  const vb = { x: 100, y: 50, width: 1200, height: 866.67 };
  const centre = { x: 360, y: 260 };
  const before = { x: vb.x + centre.x / scaleOf(vb, outer), y: vb.y + centre.y / scaleOf(vb, outer) };
  const next = zoomAround(vb, outer, 1, centre);
  close(scaleOf(next, outer), 1);
  close(next.x + centre.x / 1, before.x);
  close(next.y + centre.y / 1, before.y);
});

test("steppedLevel: in and out are symmetric and clamped to the shell's 20 … 400 %", () => {
  close(steppedLevel(steppedLevel(0.56, 0.2, ZOOM_MIN, ZOOM_MAX), -0.2, ZOOM_MIN, ZOOM_MAX), 0.56);
  assert.ok(steppedLevel(0.56, 0.2, ZOOM_MIN, ZOOM_MAX) > 0.56);
  assert.equal(steppedLevel(0.21, -1, ZOOM_MIN, ZOOM_MAX), 0.2, "clamped at the minimum");
  assert.equal(steppedLevel(3.9, 1, ZOOM_MIN, ZOOM_MAX), 4, "clamped at the maximum");
  assert.deepEqual([ZOOM_MIN, ZOOM_MAX, FIT_ANIMATION_MS], [0.2, 4, 250], "designIQ's own limits and re-fit time");
});

test("the re-fit easing: --cd-ease, cubic-bezier(0.4, 0, 0.2, 1), endpoints exact, as designIQ's own curve gave it", () => {
  assert.equal(easeStandard(0), 0);
  assert.equal(easeStandard(1), 1);
  assert.ok(easeStandard(0.5) > 0.5, "ease-out heavy in the middle");
  // the values designIQ's parsed --cd-ease produced
  const own: Array<[number, number]> = [
    [0.1, 0.025863014434934748],
    [0.25, 0.23658736043451856],
    [0.5, 0.7755613130222939],
    [0.75, 0.9593677367412116],
    [0.9, 0.9943539289465293],
  ];
  for (const [t, value] of own) close(easeStandard(t), value, 1e-5);
});

test("the re-fit frames: the ends are the two views, the scale moves in log space", () => {
  const from = { x: 0, y: 0, width: 720, height: 520, scale: 1 };
  const to = { x: 100, y: 50, width: 1800, height: 1300, scale: 0.4 };
  assert.deepEqual(interpolateViewbox(from, to, 0), from);
  assert.deepEqual(interpolateViewbox(from, to, 1), to);
  // designIQ's frames moved the box linearly (scale 0.571 halfway); the
  // shell's zoom at a constant pace on screen
  close(interpolateViewbox(from, to, 0.5).scale, Math.sqrt(0.4));
});

test("the zoom readout: the percentage, its accessible name in the shell's words, dead buttons at the limits", () => {
  assert.deepEqual(zoomReadout(0.564, "en", defaultMessages), {
    text: "56%",
    ariaLabel: "Zoom to 100% (now 56%)",
    canZoomOut: true,
    canZoomIn: true,
  });
  assert.equal(zoomReadout(0.2, "en", defaultMessages).canZoomOut, false);
  assert.equal(zoomReadout(4, "en", defaultMessages).canZoomIn, false);
  assert.equal(zoomReadout(3.99, "en", defaultMessages).canZoomIn, true);
  assert.equal(formatPercent(0.5649, "en"), "56%");
});

// ── the import fit with insets (engines/diagram-js.ts diagramView) ──────────

test("importText fits with the chrome's insets until the user moves the view; fit() resets touched", async () => {
  const inner = { x: 40, y: 20, width: 1400, height: 600 };
  const insets: Insets = { top: 104, right: 16, bottom: 56, left: 16 }; // a tier-2 palette
  const r = fakeRenderer({ inner });
  const engine = mountMiragonEngine(SPEC, r.renderer, container, false, { insets: () => insets });
  await engine.importText("board");
  assert.deepEqual(r.canvas.writes.at(-1), fitted(inner, r.outer, insets), "the fit leaves room for the chrome");
  assert.equal(engine.view.isTouched(), false);

  // a scroll the fit did not cause marks the view touched — the next import keeps it
  const vb = r.canvas.viewbox() as Box;
  r.canvas.viewbox({ x: vb.x + 50, y: vb.y, width: vb.width, height: vb.height });
  assert.equal(engine.view.isTouched(), true);
  const writes = r.canvas.writes.length;
  await engine.importText("board, edited");
  await tick(5);
  assert.equal(r.canvas.writes.length, writes, "a touched view is never re-fitted by an import");

  // the Fit button: always, and untouched again
  engine.view.fit(insets, false);
  assert.equal(engine.view.isTouched(), false);
  assert.deepEqual(r.canvas.writes.at(-1), fitted(inner, r.outer, insets));

  // the zoom group: around the centre, a touch
  engine.view.zoomTo(1);
  assert.equal(engine.view.level(), 1);
  assert.equal(engine.view.isTouched(), true);
});

test("a live re-import's own viewbox writes are never a touch: the renderer's fit and the binding's view restore yield to the chrome's fit", async () => {
  const inner = { x: 40, y: 20, width: 1400, height: 600 };
  const insets: Insets = { top: 104, right: 16, bottom: 56, left: 16 };
  // the renderer leaves every import at its own fit, not the chrome's
  const r = fakeRenderer({ inner, fitted: { ...inner } });
  const engine = mountMiragonEngine(SPEC, r.renderer, container, false, { insets: () => insets });
  await engine.importText("board");
  const fit = fitted(inner, r.outer, insets);
  assert.deepEqual(r.canvas.writes.at(-1), fit);

  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, "board");
  const unbind = engine.bindLive!(ytext, doc, { onConflict: assert.fail, onImportError: assert.fail });
  await tick(50);
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, "board, remote");
  });
  // the re-import: the renderer writes its fit, the binding restores the view right after
  await tick(400);
  assert.deepEqual(r.state.imported.at(-1), "board, remote");
  assert.equal(engine.view.isTouched(), false, "nothing the import wrote counts as the user's move");
  assert.deepEqual(r.canvas.writes.at(-1), fit, "the chrome's fit comes last");

  // after the import window a move is the user's again, and a peer's next edit keeps it
  r.canvas.viewbox({ ...fit, x: fit.x + 50 });
  assert.equal(engine.view.isTouched(), true);
  const moved = r.canvas.viewbox() as Box;
  doc.transact(() => ytext.insert(ytext.length, ", again"));
  await tick(400);
  assert.equal(r.state.imported.at(-1), "board, remote, again");
  const after = r.canvas.viewbox() as Box;
  assert.deepEqual([after.x, after.y, after.width, after.height], [moved.x, moved.y, moved.width, moved.height]);
  unbind();
  engine.destroy();
});

test("fit() on an empty canvas (mounted, not yet imported) does nothing — no fit to compare a later move against", () => {
  const r = fakeRenderer({ inner: { x: 0, y: 0, width: 0, height: 0 } });
  const engine = mountMiragonEngine(SPEC, r.renderer, container, false, {
    insets: () => ({ top: 60, right: 16, bottom: 56, left: 16 }),
  });
  engine.view.fit({ top: 60, right: 16, bottom: 56, left: 16 }, false);
  assert.equal(r.canvas.writes.length, 0);
  assert.equal(engine.view.isTouched(), false);
  engine.destroy();
});

test("fit and zoom read the viewbox FRESH: a frame resize leaves diagram-js' cached outer size stale", () => {
  const inner = { x: 0, y: 0, width: 1000, height: 400 };
  let outer = { width: 720, height: 520 };
  let current: Box = { x: 0, y: 0, width: 720, height: 520 };
  let cached: (Box & { scale: number; inner: Box; outer: typeof outer }) | undefined;
  const handlers = new Map<string, Set<() => void>>();
  const read = () => ({ ...current, scale: outer.width / current.width, inner, outer: { ...outer } });
  const canvas = {
    // diagram-js 15: the getter caches until a write; `false` recomputes
    viewbox(box?: Box | false) {
      if (box === undefined) return (cached ??= read());
      if (box === false) return (cached = read());
      current = { ...box };
      cached = undefined;
      handlers.get("canvas.viewbox.changed")?.forEach((cb) => cb());
      return undefined;
    },
  };
  const view = diagramView(
    {
      get: () => canvas,
      on: (e, cb) => void (handlers.get(e) ?? handlers.set(e, new Set()).get(e)!).add(cb),
      off: (e, cb) => void handlers.get(e)?.delete(cb),
    },
    { insets: () => insets },
  );
  const insets: Insets = { top: 60, right: 16, bottom: 56, left: 122 };
  view.fit(insets, false);
  assert.deepEqual(current, fitted(inner, outer, insets));
  canvas.viewbox(); // the cache holds the inline frame
  outer = { width: 1280, height: 760 }; // the host went fullscreen — nobody wrote the viewbox
  view.fit(insets, false);
  assert.deepEqual(current, fitted(inner, outer, insets), "fitted into the new frame, not the cached one");
  assert.equal(view.isTouched(), false);
  view.zoomTo(1);
  assert.deepEqual(current, { x: current.x, y: current.y, width: 1280, height: 760 }, "100 % of the new frame");
  view.destroy();
});
