/**
 * The Miragon widget engine without a browser (src/mcp-app/engines/miragon.ts):
 * the DSL lane's dirty suppression and viewer mount, the document lane's
 * silent history erase and codec gate, the live binding through the real
 * live-client adapter, and the ONE schema-model codec both the SPA and the
 * widget serialize through (src/notations/miragon/codec.ts). Plus the fit and
 * zoom math every diagram engine shares (src/mcp-app/engines/fit.ts) and the
 * import fit with the chrome's insets (engines/diagram-js.ts diagramView).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import type { Insets } from "../src/mcp-app/core/engine.ts";
import { diagramView } from "../src/mcp-app/engines/diagram-js.ts";
import {
  type Box,
  cubicBezier,
  fitViewbox,
  isUntouched,
  parseCubicBezier,
  scaleOf,
  steppedLevel,
  zoomAround,
  zoomPercent,
} from "../src/mcp-app/engines/fit.ts";
import { mountMiragonEngine } from "../src/mcp-app/engines/miragon.ts";
import { schemaModelCodec } from "../src/notations/miragon/codec.ts";
import type { LoadedMiragonRenderer, MiragonRendererCtor, MiragonRendererLike } from "../src/notations/miragon/spec.ts";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const container = {} as HTMLElement;

/** a DSL renderer whose importDSL EMITS commandStack.changed (the Miragon
 *  trait) and whose exportDSL is NOT a byte fixpoint (it wraps) */
function fakeDsl(
  o: {
    selection?: Array<{ id: string; labelTarget?: { id: string } }>;
    changeEvents?: readonly string[];
    importFails?: boolean;
  } = {},
) {
  const handlers = new Map<string, Set<() => void>>();
  const state = {
    imported: [] as string[],
    fitted: 0,
    destroyed: 0,
    /** what the read-only mount handed the viewer */
    viewerModules: undefined as unknown[] | undefined,
    modelerMounts: 0,
    dsl: "",
  };
  const emit = (event: string): void => handlers.get(event)?.forEach((cb) => cb());
  const instance: MiragonRendererLike = {
    get: (service: string) => {
      if (service === "canvas") {
        return {
          zoom: () => {
            state.fitted++;
          },
          viewbox: () => ({ x: 0, y: 0, width: 100, height: 100 }),
        };
      }
      if (service === "selection" && o.selection) return { get: () => o.selection };
      throw new Error(`No provider for "${service}"`);
    },
    on: (event: string, cb: () => void) =>
      void (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(cb),
    off: (event: string, cb: () => void) => void handlers.get(event)?.delete(cb),
    destroy: () => {
      state.destroyed++;
    },
    async importDSL(text: string) {
      if (o.importFails) throw new Error("parse");
      state.imported.push(text);
      state.dsl = text;
      emit("commandStack.changed"); // the clear() echo
    },
    exportDSL: (): string => `export(${state.dsl})`,
  };
  const ctor = (onNew: (opts: { additionalModules?: unknown[] }) => void): MiragonRendererCtor =>
    function (this: unknown, opts: { additionalModules?: unknown[] }) {
      onNew(opts);
      return instance;
    } as unknown as MiragonRendererCtor;
  const renderer: LoadedMiragonRenderer = {
    Modeler: ctor(() => state.modelerMounts++),
    NavigatedViewer: ctor((opts) => {
      state.viewerModules = opts.additionalModules;
    }),
    lane: { kind: "dsl", changeEvents: o.changeEvents ?? ["commandStack.changed"] },
  };
  return { state, renderer, emit };
}

test("dsl lane: the import echo never fires onDirty, a later edit does; exportText is the renderer's DSL", async () => {
  const { state, renderer, emit } = fakeDsl();
  const engine = mountMiragonEngine(renderer, container, false);
  assert.equal(state.modelerMounts, 1);
  assert.equal(state.viewerModules, undefined, "the editable mount never touches the viewer");
  assert.equal(engine.editable, true);
  let dirty = 0;
  const off = engine.onDirty(() => dirty++);
  await engine.importText("component A [0.1, 0.2]");
  assert.equal(dirty, 0, "the importDSL clear() echo is suppressed");
  assert.equal(state.fitted, 1);
  emit("wardley.config.changed");
  assert.equal(dirty, 0, "a resize preview is no edit — autosave must never store a preview size");
  emit("commandStack.changed");
  assert.equal(dirty, 1, "the committed edit is");
  off();
  emit("commandStack.changed");
  assert.equal(dirty, 1, "unsubscribed");
  assert.equal(await engine.exportText(), "export(component A [0.1, 0.2])");
  engine.destroy();
  assert.equal(state.destroyed, 1);
});

test("dsl lane read-only: the viewer gets the spec's modules and nothing else, no change events, no export", async () => {
  const { state, renderer, emit } = fakeDsl({ changeEvents: ["commandStack.changed"] });
  const engine = mountMiragonEngine(renderer, container, true);
  assert.equal(state.modelerMounts, 0);
  assert.deepEqual(state.viewerModules, [], "no command-stack shim: the renderers no longer need one");
  assert.equal(engine.editable, false);
  let dirty = 0;
  engine.onDirty(() => dirty++);
  await engine.importText("x");
  emit("commandStack.changed");
  assert.equal(dirty, 0, "a viewer never subscribes");
  await assert.rejects(() => engine.exportText(), /read-only/);
});

test("dsl lane: bindLive hands the canvas to live-client's miragon-sync — the Y.Text imports, canvas edits export, hooks are threaded", async () => {
  const { state, renderer, emit } = fakeDsl({ selection: [{ id: "label_1", labelTarget: { id: "node_1" } }] });
  const engine = mountMiragonEngine(renderer, container, false);
  assert.equal(engine.selectedElementId?.(), "node_1", "a label resolves to its target");

  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, "component A [0.1, 0.2]\n");
  const errors: string[] = [];
  const unbind = engine.bindLive!(ytext, doc, { onConflict: () => {}, onImportError: (m) => errors.push(m) });
  await tick(50);
  assert.deepEqual(state.imported, ["component A [0.1, 0.2]\n"], "the Y.Text landed on the canvas");
  assert.equal(errors.length, 0);
  // a canvas edit exports into the Y.Text (through the lane's change events)
  state.dsl = "component A [0.1, 0.2]\ncomponent B [0.5, 0.5]\n";
  emit("commandStack.changed");
  await tick(50);
  assert.match(ytext.toString(), /component B/);
  unbind();
  state.dsl = "gone";
  emit("commandStack.changed");
  await tick(50);
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

  const bare = mountMiragonEngine(fakeDsl().renderer, container, false);
  assert.equal(bare.selectedElementId?.(), undefined, "no selection service → undefined, never a throw");
});

test("dsl lane: a rejected importDSL releases the latch — later edits still count", async () => {
  const { renderer, emit } = fakeDsl({ importFails: true, changeEvents: ["commandStack.changed"] });
  const engine = mountMiragonEngine(renderer, container, false);
  let dirty = 0;
  engine.onDirty(() => dirty++);
  await assert.rejects(() => engine.importText("x"), /parse/);
  emit("commandStack.changed");
  assert.equal(dirty, 1, "edits after a failed import still count");
});

// ── the document lane ───────────────────────────────────────────────────────

/** a JSON renderer: `services` names what its injector registers (the viewer
 *  has no command stack); clear(emit) fires 'changed' unless emit === false */
function fakeDocument(services: string[]) {
  const handlers = new Map<string, Array<() => void>>();
  const log: unknown[] = [];
  const instance: MiragonRendererLike = {
    get: (service: string): any => {
      if (service === "canvas") return { zoom: () => {}, viewbox: () => ({ x: 0, y: 0, width: 1, height: 1 }) };
      if (services.includes(service)) {
        return {
          clear: (emit?: boolean) => {
            log.push(`clear:${service}:${emit}`);
            if (emit !== false) handlers.get("commandStack.changed")?.forEach((cb) => cb());
          },
        };
      }
      throw new Error(`No provider for "${service}"!`);
    },
    on: (event: string, cb: () => void) => void (handlers.get(event) ?? handlers.set(event, []).get(event)!).push(cb),
    off: () => {},
    destroy: () => {},
    importDocument: (doc: unknown) => void log.push(doc),
    exportDocument: () => ({ nodes: [] }),
  };
  const ctor = () =>
    function (this: unknown) {
      return instance;
    } as unknown as MiragonRendererCtor;
  const codec = {
    parse: (text: string) => (text === "bad" ? { ok: false as const } : { ok: true as const, document: { text } }),
    serialize: (document: unknown) => JSON.stringify(document),
  };
  const renderer: LoadedMiragonRenderer = {
    Modeler: ctor(),
    NavigatedViewer: ctor(),
    lane: { kind: "document", notation: "team-topology", codec },
  };
  return { renderer, log, emit: (event: string) => handlers.get(event)?.forEach((cb) => cb()) };
}

test("document lane read-only: no command-stack lookup on the viewer (the renderer's get() forwards no strict flag)", async () => {
  const viewer = fakeDocument([]); // no commandStack on a viewer
  const engine = mountMiragonEngine(viewer.renderer, container, true);
  await engine.importText("x");
  assert.deepEqual(viewer.log, [{ text: "x" }], "imported without touching the stack");
  await assert.rejects(() => engine.importText("bad"), /not a team-topology document/);
});

test("document lane editable: the post-import clear is SILENT, a rejected parse never reaches importDocument, a real edit dirties", async () => {
  const r = fakeDocument(["commandStack"]);
  const engine = mountMiragonEngine(r.renderer, container, false);
  let dirty = 0;
  engine.onDirty(() => dirty++);
  await engine.importText("ok");
  assert.deepEqual(r.log, [{ text: "ok" }, "clear:commandStack:false"], "history erased with clear(false)");
  assert.equal(dirty, 0, "engine invariant 1: the import (and its history erase) never dirties");
  await assert.rejects(() => engine.importText("bad"));
  assert.equal(r.log.length, 2, "a rejected parse never reached importDocument");
  r.emit("commandStack.changed");
  assert.equal(dirty, 1, "a real edit does");
  assert.equal(await engine.exportText(), '{"nodes":[]}');
});

// ── the codec ───────────────────────────────────────────────────────────────

for (const pkg of ["@miragon/team-topologies-schema-model", "@miragon/context-maps-schema-model"] as const) {
  test(`schemaModelCodec(${pkg}): lenient parse, rejected garbage, deterministic round-trip`, async () => {
    const codec = schemaModelCodec(await import(pkg));
    const empty = codec.parse("{}");
    assert.ok(empty.ok, "an empty object migrates to a valid document");
    assert.equal(codec.parse("not json").ok, false);
    const once = codec.serialize(empty.ok ? empty.document : undefined);
    const again = codec.parse(once);
    assert.ok(again.ok);
    assert.equal(codec.serialize(again.document), once);
  });
}

// ── fit and zoom (engines/fit.ts) ───────────────────────────────────────────

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

test("fitViewbox: the content lands inside the insets, centred in the inner rect, width-limited at 720x520", () => {
  const outer = { width: 720, height: 520 };
  // the 720 bpmn inline frame: corner row, left palette column, bottom row
  const insets: Insets = { top: 60, right: 16, bottom: 56, left: 122 };
  const bbox = { x: 150, y: 80, width: 1000, height: 500 };
  const vb = fitViewbox(bbox, outer, insets);
  const s = onScreen(bbox, vb, outer);
  close(s.scale, 0.582); // (720 − 138) / 1000 — narrower than (520 − 116) / 500
  close(s.left, 122);
  close(s.right, 704); // 720 − 16
  // height-centred in the 404px inner rect
  close(s.top - 60, 520 - 56 - s.bottom);
  assert.equal(vb.width, outer.width / s.scale, "the viewbox spans the WHOLE frame");
});

test("fitViewbox: never above 100 % — small content is centred at scale 1", () => {
  const outer = { width: 1280, height: 760 };
  const insets: Insets = { top: 64, right: 388, bottom: 60, left: 16 }; // a 360 card open
  const bbox = { x: -40, y: 10, width: 200, height: 100 };
  const vb = fitViewbox(bbox, outer, insets, 1);
  const s = onScreen(bbox, vb, outer);
  close(s.scale, 1);
  close(s.left - 16, 1280 - 388 - s.right);
  close(s.top - 64, 760 - 60 - s.bottom);
});

test("fitViewbox: an empty diagram centres its origin at maxScale; a degenerate frame never yields NaN", () => {
  const outer = { width: 480, height: 480 };
  const insets: Insets = { top: 60, right: 16, bottom: 56, left: 16 };
  const vb = fitViewbox({ x: 0, y: 0, width: 0, height: 0 }, outer, insets);
  const s = onScreen({ x: 0, y: 0, width: 0, height: 0 }, vb, outer);
  close(s.scale, 1);
  close(s.left, 16 + (480 - 32) / 2);
  const tiny = fitViewbox({ x: 0, y: 0, width: 100, height: 100 }, { width: 50, height: 40 }, insets);
  for (const v of Object.values(tiny)) assert.ok(Number.isFinite(v), "finite");
});

test("isUntouched: the last fit within rounding is untouched; a scroll or zoom is a touch; no fit yet = touched", () => {
  const fit = { x: -210.5, y: -103.2, width: 1237.1, height: 893.5 };
  assert.equal(isUntouched(fit, fit), true);
  // diagram-js rounds the transform to 1/1000 — never a touch
  assert.equal(isUntouched({ ...fit, x: fit.x + 0.4, width: fit.width * (1 + 5e-4) }, fit), true);
  assert.equal(isUntouched({ ...fit, x: fit.x + 30 }, fit), false, "a scroll");
  assert.equal(isUntouched({ ...fit, width: fit.width * 0.8, height: fit.height * 0.8 }, fit), false, "a zoom");
  assert.equal(isUntouched(fit, undefined), false);
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

test("steppedLevel: in and out are symmetric and clamped; the readout rounds", () => {
  close(steppedLevel(steppedLevel(0.56, 0.2), -0.2), 0.56);
  assert.ok(steppedLevel(0.56, 0.2) > 0.56);
  assert.equal(steppedLevel(0.21, -1), 0.2, "clamped at the minimum");
  assert.equal(steppedLevel(3.9, 1), 4, "clamped at the maximum");
  assert.equal(zoomPercent(0.5649), "56%");
});

test("the re-fit easing: --cd-ease parsed, endpoints exact, a linear curve is the identity, garbage falls back", () => {
  const ease = parseCubicBezier("cubic-bezier(0.4, 0, 0.2, 1)");
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(ease(0.5) > 0.5, "ease-out heavy in the middle");
  const linear = cubicBezier(0, 0, 1, 1);
  for (const t of [0.1, 0.33, 0.5, 0.9]) close(linear(t), t, 1e-4);
  close(parseCubicBezier(undefined)(0.5), ease(0.5), 1e-9);
});

// ── the import fit with insets (engines/diagram-js.ts diagramView) ──────────

/** a DSL renderer whose canvas keeps a real viewbox: the setter emits
 *  canvas.viewbox.changed synchronously, like diagram-js 15 */
function fakeCanvasDsl(inner: Box, outer = { width: 720, height: 520 }) {
  const handlers = new Map<string, Set<() => void>>();
  const emit = (event: string): void => handlers.get(event)?.forEach((cb) => cb());
  let current: Box = { x: 0, y: 0, width: outer.width, height: outer.height };
  const writes: Box[] = [];
  let zooms = 0;
  const canvas = {
    viewbox(box?: Box) {
      if (!box) return { ...current, scale: outer.width / current.width, inner, outer };
      current = { ...box };
      writes.push(current);
      emit("canvas.viewbox.changed");
      return undefined;
    },
    zoom: () => void zooms++,
  };
  const instance: MiragonRendererLike = {
    get: (service: string) => {
      if (service === "canvas") return canvas;
      throw new Error(`No provider for "${service}"`);
    },
    on: (event: string, cb: () => void) =>
      void (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(cb),
    off: (event: string, cb: () => void) => void handlers.get(event)?.delete(cb),
    destroy: () => {},
    importDSL: async () => {},
    exportDSL: () => "",
  };
  const ctor = function (this: unknown) {
    return instance;
  } as unknown as MiragonRendererCtor;
  const renderer: LoadedMiragonRenderer = {
    Modeler: ctor,
    NavigatedViewer: ctor,
    lane: { kind: "dsl", changeEvents: ["commandStack.changed"] },
  };
  return { renderer, canvas, writes, zooms: () => zooms, outer, instance, emit };
}

test("importText fits with the chrome's insets until the user moves the view; fit() resets touched", async () => {
  const inner = { x: 40, y: 20, width: 1400, height: 600 };
  const insets: Insets = { top: 104, right: 16, bottom: 56, left: 16 }; // a tier-2 palette
  const r = fakeCanvasDsl(inner);
  const engine = mountMiragonEngine(r.renderer, container, false, { insets: () => insets });
  await engine.importText("board");
  assert.equal(r.zooms(), 0, "no fit-viewport — the fit leaves room for the chrome");
  assert.deepEqual(r.writes.at(-1), fitViewbox(inner, r.outer, insets));
  assert.equal(engine.view.isTouched(), false);

  // a scroll the fit did not cause marks the view touched — the next import keeps it
  const vb = r.canvas.viewbox() as Box;
  r.canvas.viewbox({ x: vb.x + 50, y: vb.y, width: vb.width, height: vb.height });
  assert.equal(engine.view.isTouched(), true);
  const writes = r.writes.length;
  await engine.importText("board, edited");
  assert.equal(r.writes.length, writes, "a touched view is never re-fitted by an import");

  // the Fit button: always, and untouched again
  engine.view.fit(insets, false);
  assert.equal(engine.view.isTouched(), false);
  assert.deepEqual(r.writes.at(-1), fitViewbox(inner, r.outer, insets));

  // the zoom group: around the centre, a touch
  engine.view.zoomTo(1);
  assert.equal(engine.view.level(), 1);
  assert.equal(engine.view.isTouched(), true);
});

test("an import's own viewbox writes are never a touch: the renderer's zoom and the live binding's fit-viewport yield to the chrome's fit", async () => {
  const inner = { x: 40, y: 20, width: 1400, height: 600 };
  const insets: Insets = { top: 104, right: 16, bottom: 56, left: 16 };
  const r = fakeCanvasDsl(inner);
  const engine = mountMiragonEngine(r.renderer, container, false, { insets: () => insets });
  await engine.importText("board");
  const fitted = fitViewbox(inner, r.outer, insets);
  // a re-import as the live binding runs it (live-client keepDiagramViewbox):
  // the renderer zooms to its board while it renders, import.done fires, and
  // the binding's continuation zooms to fit-viewport right after
  r.instance.importDSL = async () => {
    r.emit("import.parse.start");
    r.canvas.viewbox({ ...inner });
    r.emit("import.done");
  };
  await r.instance.importDSL("board, remote");
  r.canvas.viewbox({ x: 0, y: 0, width: inner.width, height: inner.width * (r.outer.height / r.outer.width) });
  assert.equal(engine.view.isTouched(), false, "nothing the import wrote counts as the user's move");
  await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(r.writes.at(-1), fitted, "the chrome's fit comes last");
  assert.equal(engine.view.isTouched(), false);

  // after the import window a move is the user's again
  r.canvas.viewbox({ ...fitted, x: fitted.x + 50 });
  assert.equal(engine.view.isTouched(), true);
  engine.destroy();
});

test("fit() on an empty canvas (mounted, not yet imported) does nothing — no fit to compare a later move against", () => {
  const r = fakeCanvasDsl({ x: 0, y: 0, width: 0, height: 0 });
  const engine = mountMiragonEngine(r.renderer, container, false, {
    insets: () => ({ top: 60, right: 16, bottom: 56, left: 16 }),
  });
  engine.view.fit({ top: 60, right: 16, bottom: 56, left: 16 }, false);
  assert.equal(r.writes.length, 0);
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
  assert.deepEqual(current, fitViewbox(inner, outer, insets));
  canvas.viewbox(); // the cache holds the inline frame
  outer = { width: 1280, height: 760 }; // the host went fullscreen — nobody wrote the viewbox
  view.fit(insets, false);
  assert.deepEqual(current, fitViewbox(inner, outer, insets), "fitted into the new frame, not the cached one");
  assert.equal(view.isTouched(), false);
  view.zoomTo(1);
  assert.deepEqual(current, { x: current.x, y: current.y, width: 1280, height: 760 }, "100 % of the new frame");
  view.destroy();
});
