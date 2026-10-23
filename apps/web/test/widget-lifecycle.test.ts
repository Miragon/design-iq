/**
 * The widget core's state machine (src/mcp-app/core/lifecycle.ts) driven
 * DOM-free through its ports — the CAS autosave, the conflict banner, the
 * live upgrade and the post-outage reconcile, each branch the BPMN widget
 * fixed once and every canvas widget now shares.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { toastAnnouncement } from "../src/mcp-app/core/feedback.ts";
import {
  createWidgetLifecycle,
  type LifecycleDeps,
  type LifecycleTiming,
  LoadError,
  type SyncState,
  UNRENDERABLE_TOAST,
} from "../src/mcp-app/core/lifecycle.ts";
import { createAnnouncer, RESTING_STATUS, speakBeat, type Utterance } from "../src/mcp-app/core/sync-view.ts";
import {
  fakeBridge,
  type FakeChrome,
  fakeChrome,
  fakeClaim,
  type FakeEngine,
  fakeEngine,
  fakeLive,
  fakeMounts,
  tick,
  TIMING,
} from "./fakes.ts";

const REPO = "acme/models";

function setup(
  o: {
    engine?: FakeEngine;
    live?: ReturnType<typeof fakeLive> | null;
    readonly?: boolean;
    timing?: Partial<LifecycleTiming>;
    openInDesignIQ?: LifecycleDeps<FakeEngine>["openInDesignIQ"];
  } = {},
) {
  const engine = o.engine ?? fakeEngine({ editable: !(o.readonly ?? false) });
  const mounts = fakeMounts(engine);
  const bridge = fakeBridge();
  const chrome = fakeChrome();
  const claim = fakeClaim();
  const live = o.live === null ? undefined : (o.live ?? fakeLive({ handle: false }));
  const extras = {
    docs: [] as string[],
    /** onRead calls: the path, how many bridge reads had started and how many imports had run */
    reads: [] as Array<{ path: string; loads: number; imports: number }>,
    /** onSaved calls (the landed saves the extras heard of) */
    saved: [] as string[],
    destroyed: 0,
    mountedAt: -1,
  };
  const mounted: Array<{ engine: FakeEngine; frozen: boolean }> = [];
  const deps: LifecycleDeps<FakeEngine> = {
    readonly: o.readonly ?? false,
    noun: "model",
    mountEngine: mounts.mount,
    bridge: bridge.bridge,
    live: live?.live,
    claim: claim.claim,
    chrome: chrome.port,
    extras: (e) => {
      extras.mountedAt = e.log.length;
      e.log.push("extras");
      return {
        onRead: (doc) =>
          void extras.reads.push({
            path: doc.path,
            loads: bridge.loads.length,
            imports: e.log.filter((l) => l === "importText").length,
          }),
        onDocument: (doc) => void extras.docs.push(doc.path),
        onSaved: (doc) => void extras.saved.push(doc.path),
        destroy: () => {
          extras.destroyed++;
        },
      };
    },
    onMount: (e, frozen) => void mounted.push({ engine: e, frozen }),
    openInDesignIQ: o.openInDesignIQ,
    timing: { ...TIMING, ...o.timing },
  };
  const lc = createWidgetLifecycle(deps);
  return { lc, engine, bridge, chrome, claim, live, extras, mounts, mounted };
}

test("load: bridge read → engine mounted once → extras before the first import → claim → ready → live attempted", async () => {
  const { lc, engine, bridge, chrome, claim, live, extras } = setup();
  assert.equal(lc.hasLoaded(), false);
  await lc.load({ repo: REPO, id: "a" });
  assert.deepEqual(bridge.loads, [{ repo: REPO, id: "a" }]);
  assert.deepEqual(engine.log, ["mountEngine", "extras", "importText"]);
  assert.deepEqual(engine.imported, ["v1"]);
  assert.deepEqual(extras.docs, ["processes/a.owm"]);
  assert.deepEqual(claim.keys, [`${REPO}/processes/a.owm`]);
  // provisional from the tool input, then the path the read resolved
  assert.deepEqual(chrome.docs, [
    { repo: REPO, id: "a" },
    { repo: REPO, path: "processes/a.owm", id: "a" },
  ]);
  assert.deepEqual(chrome.openVisible, [false, true]);
  assert.deepEqual(chrome.status, ["Loading model…", "Ready — changes save automatically"]);
  assert.deepEqual(chrome.saveButton, [{ visible: true }, { visible: true, enabled: true }]);
  assert.deepEqual(lc.document(), { repo: REPO, path: "processes/a.owm" });
  assert.equal(lc.hasLoaded(), true);
  assert.deepEqual(live?.calls, [{ repo: REPO, path: "processes/a.owm" }]);
  // a second load re-imports without re-mounting
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(engine.log.filter((l) => l === "mountEngine").length, 1);
  assert.equal(engine.imported.length, 2);
});

test("read-only: no save button, no live attempt, a second load re-imports without re-mounting", async () => {
  const { lc, engine, chrome, live } = setup({ readonly: true });
  await lc.load({ repo: REPO, id: "a" });
  assert.deepEqual(chrome.saveButton, [{ visible: false }, { visible: false, enabled: true }]);
  assert.equal(chrome.last(), "Read-only view");
  assert.equal(live?.calls.length, 0);
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(engine.log.filter((l) => l === "mountEngine").length, 1);
  assert.equal(engine.imported.length, 2);
});

test("an engine without bindLive (or no live port) never attempts the upgrade", async () => {
  const a = setup({ engine: fakeEngine({ live: false }) });
  await a.lc.load({ repo: REPO, id: "a" });
  assert.equal(a.live?.calls.length, 0);
  assert.equal(a.chrome.last(), "Ready — changes save automatically");
  const b = setup({ live: null });
  await b.lc.load({ repo: REPO, id: "a" });
  assert.equal(b.chrome.last(), "Ready — changes save automatically");
});

test("autosave: an edit saves after the debounce, findings inform, the token advances", async () => {
  const { lc, engine, bridge, chrome } = setup();
  bridge.onSave(async () => ({ ok: true, path: "processes/a.owm", baseVersion: "v2", warnings: ["w1"] }));
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  assert.equal(lc.state().dirty, true);
  assert.equal(bridge.saves.length, 0, "nothing saved before the debounce");
  await tick(TIMING.autosaveMs * 4);
  assert.deepEqual(bridge.saves, [
    { doc: { repo: REPO, path: "processes/a.owm" }, content: "canvas#1", baseVersion: "b1" },
  ]);
  assert.equal(lc.state().dirty, false);
  assert.equal(chrome.last(), "Saved · 1 warning");
  assert.deepEqual(chrome.tooltips, ["w1"]);
  assert.equal(bridge.saved.length, 1);
  // the next save carries the advanced token
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 4);
  assert.equal(bridge.saves[1]?.baseVersion, "v2");
});

test("a mid-flight edit stays dirty and a second save follows with the new export", async () => {
  const { lc, engine, bridge } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  bridge.onSave(async (n) => {
    if (n === 1) await gate;
    return { ok: true, path: "processes/a.owm", baseVersion: `v${n + 1}`, warnings: [] };
  });
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(bridge.saves.length, 1);
  engine.fire.dirty(); // while the first save is pending
  release();
  await tick(TIMING.autosaveMs * 4);
  assert.equal(bridge.saves.length, 2, "the finally re-arm persisted the mid-flight edit");
  assert.equal(bridge.saves[1]?.content, "canvas#2");
  assert.equal(lc.state().dirty, false);
});

test("exportText rejects → autosave reports and retries (the backoff, or the next edit)", async () => {
  const engine = fakeEngine();
  let fail = true;
  engine.exportText = async () => {
    if (fail) throw new Error("empty model");
    return "canvas#ok";
  };
  const { lc, bridge, chrome } = setup({ engine });
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 0);
  assert.equal(chrome.last(), "Autosave failed: empty model — retrying automatically");
  fail = false;
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves[0]?.content, "canvas#ok");
});

test("conflict: the banner owns the next step — load theirs / overwrite / keep editing", async () => {
  const { lc, engine, bridge, chrome } = setup();
  let conflict = true;
  bridge.onSave(async (n) =>
    conflict
      ? {
          ok: false,
          conflict: true,
          path: "processes/a.owm",
          currentContent: "<theirs>",
          baseVersion: "v9",
          message: "moved",
        }
      : { ok: true, path: "processes/a.owm", baseVersion: `v${n + 10}`, warnings: [] },
  );
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(lc.state().paused, true);
  assert.equal(chrome.last(), "Conflict — autosave paused");
  assert.deepEqual(chrome.bannerLabels(), ["Load their version", "Overwrite anyway", "Keep editing"]);
  assert.equal(chrome.banners[0]?.actions[1]?.danger, true);
  // an edit while the banner is up saves NOTHING
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 1);

  // load theirs: import, adopt their token, clean
  conflict = false;
  chrome.click("Load their version");
  await tick(TIMING.autosaveMs);
  assert.equal(engine.imported.at(-1), "<theirs>");
  assert.equal(lc.state().dirty, false);
  assert.equal(chrome.last(), "Reloaded");
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.at(-1)?.baseVersion, "v9", "the next save uses their token");

  // an unimportable snapshot re-shows the SAME banner and touches nothing
  conflict = true;
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  const before = lc.state().baseVersion;
  engine.importText = async () => {
    throw new Error("bad");
  };
  chrome.click("Load their version");
  await tick(TIMING.autosaveMs);
  assert.deepEqual(chrome.bannerLabels(), ["Load their version", "Overwrite anyway", "Keep editing"]);
  assert.equal(lc.state().baseVersion, before);

  // overwrite anyway: resend MY text against the fresh token, immediately
  conflict = false;
  const myText = bridge.saves.at(-1)!.content;
  chrome.click("Overwrite anyway");
  await tick(TIMING.autosaveMs);
  assert.deepEqual(bridge.saves.at(-1), {
    doc: { repo: REPO, path: "processes/a.owm" },
    content: myText,
    baseVersion: "v9",
  });
  assert.equal(lc.state().paused, false);

  // keep editing: adopt their token, a save follows WITHOUT a new edit
  conflict = true;
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  conflict = false;
  const n = bridge.saves.length;
  chrome.click("Keep editing");
  assert.equal(chrome.last(), "Editing on — autosave will overwrite their version");
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, n + 1);
  assert.equal(bridge.saves.at(-1)?.baseVersion, "v9");
});

test("live upgrade: the flush lands before the bind, autosave retires, edits stop saving", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, engine, bridge, chrome } = setup({ live });
  // an edit is pending when the upgrade's beforeBind runs: it must be flushed first
  engine.fire.dirty(); // before load — ignored (no engine yet), just noise
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(lc.state().live, true);
  assert.ok(chrome.saveButton.some((s) => s.visible === false));
  assert.equal(chrome.last(), "Live — co-editing enabled, changes sync instantly");
  assert.ok(engine.bound, "the engine was bound to the live session");
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 0, "live mode: Yjs persists, no CAS save");
  engine.bound?.onImportError("x");
  assert.equal(chrome.last(), "Live import failed: x");
});

test("live upgrade: an edit made while the socket connects is flushed BEFORE the bind", async () => {
  const live = fakeLive({ handle: true, delayMs: TIMING.autosaveMs * 3 });
  const { lc, engine, bridge } = setup({ live });
  const loading = lc.load({ repo: REPO, id: "a" });
  await tick(TIMING.autosaveMs); // imported, the upgrade is waiting for the sync
  engine.fire.dirty();
  await loading;
  assert.equal(lc.state().live, true);
  assert.equal(bridge.saves.length, 1, "the pending edit reached the server before Yjs replaced the canvas");
  assert.equal(lc.state().dirty, false);
});

test("live upgrade: when the flush cannot land, the upgrade gives up after the deadline and autosave stays", async () => {
  const live = fakeLive({ handle: true, delayMs: TIMING.autosaveMs * 3 });
  const { lc, engine, bridge, chrome } = setup({ live });
  bridge.onSave(async () => {
    throw new Error("net");
  });
  const loading = lc.load({ repo: REPO, id: "a" });
  await tick(TIMING.autosaveMs);
  const t0 = Date.now();
  engine.fire.dirty();
  await loading;
  assert.equal(lc.state().live, false, "the flush never cleared — no bind on top of unsaved state");
  assert.ok(Date.now() - t0 >= TIMING.flushDeadlineMs, "gave up only at the deadline, not on the first failure");
  assert.ok(bridge.saves.length >= 5, "kept retrying until the deadline");
  assert.equal(lc.state().dirty, true);
  assert.match(chrome.last() ?? "", /Autosave failed/);
});

test("onDead, byte-equal: resume live; if that fails, re-import the fresh state and go back to autosave", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, engine, bridge, chrome } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(lc.state().live, true);
  // the server holds exactly the replica; the next upgrade fails → re-import + autosave
  bridge.onLoad(async () => ({ path: "processes/a.owm", content: "v1", baseVersion: "b7" }));
  live.next = { handle: false };
  live.hooks?.onDead();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(bridge.loads.length, 2, "reconciled against a fresh read");
  assert.equal(lc.state().baseVersion, "b7");
  assert.equal(lc.state().live, false);
  assert.equal(engine.imported.at(-1), "v1", "the clean canvas was reconciled to the fresh state");
  assert.equal(chrome.last(), "Live sync lost — changes save automatically");
  assert.ok(chrome.saveButton.at(-1)?.visible);
});

test("onDead, diverged: the interrupted banner decides — load server version or keep my canvas", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, engine, bridge, chrome } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  bridge.onLoad(async () => ({ path: "processes/a.owm", content: "v2-by-a-colleague", baseVersion: "b8" }));
  live.next = { handle: false };
  live.hooks?.onDead();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(chrome.last(), "Live sync interrupted");
  assert.deepEqual(chrome.bannerLabels(), ["Load server version", "Keep my canvas"]);
  assert.equal(lc.state().paused, true);
  chrome.click("Load server version");
  await tick(TIMING.autosaveMs);
  assert.equal(engine.imported.at(-1), "v2-by-a-colleague");
  assert.equal(lc.state().baseVersion, "b8");
  assert.equal(lc.state().paused, false);
  // the other branch: re-establish live (a re-load upgrades again), die
  // diverged once more, keep MY canvas
  live.next = { handle: true, snapshot: "v2-by-a-colleague" };
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(lc.state().live, true);
  bridge.onLoad(async () => ({ path: "processes/a.owm", content: "v3", baseVersion: "b9" }));
  live.next = { handle: false };
  live.hooks?.onDead();
  await tick(TIMING.autosaveMs * 2);
  assert.deepEqual(chrome.bannerLabels(), ["Load server version", "Keep my canvas"]);
  chrome.click("Keep my canvas");
  assert.equal(chrome.last(), "Keeping this canvas — autosave will overwrite the server version");
  assert.equal(lc.state().dirty, true);
  assert.equal(lc.state().paused, false);
  assert.equal(lc.state().baseVersion, "b9");
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.at(-1)?.baseVersion, "b9", "the canvas overwrote the server version");
});

test("onDead with the bridge down: keep the stale token, autosave, let CAS decide", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, engine, bridge, chrome } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  bridge.onLoad(async () => {
    throw new Error("bridge down");
  });
  live.hooks?.onDead();
  await tick(TIMING.autosaveMs);
  assert.equal(lc.state().paused, false);
  assert.equal(lc.state().dirty, true);
  assert.equal(chrome.last(), "Live sync lost — changes save automatically");
  bridge.onSave(async () => ({ ok: true, path: "processes/a.owm", baseVersion: "b2", warnings: [] }));
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.at(-1)?.baseVersion, "b1", "the PRE-death token — the CAS conflict decides");
  void engine;
});

test("superseded by a newer widget: inactive for good", async () => {
  const live = fakeLive({ handle: true });
  const { lc, engine, bridge, chrome, claim, extras } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  claim.supersede();
  assert.equal(lc.state().inactive, true);
  assert.equal(live.handles[0]?.destroyed, 1);
  assert.equal(extras.destroyed, 1);
  assert.deepEqual(chrome.bannerLabels(), []);
  assert.deepEqual(chrome.saveButton.at(-1), { enabled: false });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 0);
  await lc.load({ repo: REPO, id: "b" });
  assert.equal(engine.imported.length, 1, "a later load bails before its read");
});

test("re-load races: the newer load owns the widget, the old claim is released first", async () => {
  const { lc, engine, bridge, claim } = setup();
  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => (releaseA = r));
  let n = 0;
  bridge.onLoad(async () => {
    n++;
    if (n === 1) {
      await gateA;
      return { path: "processes/a.owm", content: "A", baseVersion: "bA" };
    }
    return { path: "processes/b.owm", content: "B", baseVersion: "bB" };
  });
  const a = lc.load({ repo: REPO, id: "a" });
  assert.equal(lc.document(), undefined, "no document while a load is in flight");
  const b = lc.load({ repo: REPO, id: "b" });
  releaseA();
  await Promise.all([a, b]);
  assert.deepEqual(engine.imported, ["B"]);
  assert.deepEqual(lc.document(), { repo: REPO, path: "processes/b.owm" });
  assert.deepEqual(claim.keys, [`${REPO}/processes/b.owm`]);
  assert.equal(claim.releases, 0, "nothing to release before the first claim landed");
  await lc.load({ repo: REPO, id: "b" });
  assert.equal(claim.releases, 1, "the previous claim is released before the next");
});

test("flushOnLeave saves a dirty canvas — never while paused or live", async () => {
  const { lc, engine, bridge, chrome } = setup();
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  lc.flushOnLeave();
  await tick(TIMING.autosaveMs);
  assert.equal(bridge.saves.length, 1);
  // paused under a conflict banner
  bridge.onSave(async () => ({
    ok: false,
    conflict: true,
    path: "p",
    currentContent: "t",
    baseVersion: "v",
    message: "m",
  }));
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(lc.state().paused, true);
  lc.flushOnLeave();
  await tick(TIMING.autosaveMs);
  assert.equal(bridge.saves.length, 2);
  void chrome;
});

test("mountEngine throws → the load fails loudly, no claim, a second load retries the mount", async () => {
  const engine = fakeEngine();
  let fail = true;
  const { lc, claim } = setup({ engine });
  const deps = { mount: 0 };
  // wrap the mount: fail once
  const original = engine.log;
  void original;
  const lcFailing = createWidgetLifecycle<FakeEngine>({
    readonly: false,
    noun: "model",
    mountEngine: () => {
      deps.mount++;
      if (fail) throw new Error("engine broke");
      return engine;
    },
    bridge: fakeBridge().bridge,
    claim: claim.claim,
    chrome: fakeChrome().port,
    timing: TIMING,
  });
  await assert.rejects(() => lcFailing.load({ repo: REPO, id: "a" }), /engine broke/);
  assert.equal(claim.keys.length, 0);
  fail = false;
  await lcFailing.load({ repo: REPO, id: "a" });
  assert.equal(deps.mount, 2);
  assert.equal(engine.imported.length, 1);
  void lc;
});

test("an edit racing a re-load's import never saves against the incoming document", async () => {
  const { lc, engine, bridge } = setup();
  await lc.load({ repo: REPO, id: "a" });
  let releaseImport!: () => void;
  const gate = new Promise<void>((r) => (releaseImport = r));
  const realImport = engine.importText.bind(engine);
  engine.importText = async (text) => {
    await gate; // the incoming document is still parsing…
    return realImport(text);
  };
  bridge.onLoad(async () => ({ path: "processes/b.owm", content: "B", baseVersion: "bB" }));
  const reload = lc.load({ repo: REPO, id: "b" });
  await tick(TIMING.autosaveMs);
  assert.equal(lc.document(), undefined, "no document while the import is in flight");
  engine.fire.dirty(); // …while the user still edits the OLD canvas
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 0, "nothing PUT against processes/b.owm");
  releaseImport();
  await reload;
  assert.deepEqual(lc.document(), { repo: REPO, path: "processes/b.owm" });
  assert.equal(lc.state().dirty, false, "the landed load owns a clean canvas");
});

// ── mutation-driven pins: each case fails when one guard of the state machine
// is dropped (the second review's mutation analysis named them) ───────────────

test("a save in flight across a re-load never PUTs the old document nor adopts its token", async () => {
  const { lc, engine, bridge } = setup();
  await lc.load({ repo: REPO, id: "a" });
  let releaseExport!: () => void;
  const gate = new Promise<void>((r) => (releaseExport = r));
  engine.exportText = async () => {
    await gate;
    return "canvas#old";
  };
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(lc.state().saving, true, "the export is in flight");
  bridge.onLoad(async () => ({ path: "processes/b.owm", content: "B", baseVersion: "bB" }));
  await lc.load({ repo: REPO, id: "b" });
  releaseExport();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(bridge.saves.length, 0, "the stale save bailed after its export");
  assert.equal(lc.state().baseVersion, "bB");
  assert.equal(lc.state().dirty, false);
});

test("a save whose RESULT arrives after a re-load touches neither the token nor the dot", async () => {
  const { lc, engine, bridge } = setup();
  await lc.load({ repo: REPO, id: "a" });
  let releaseSave!: () => void;
  const gate = new Promise<void>((r) => (releaseSave = r));
  bridge.onSave(async () => {
    await gate;
    return { ok: true, path: "processes/a.owm", baseVersion: "stale-token", warnings: [] };
  });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(bridge.saves.length, 1, "the PUT is in flight");
  bridge.onLoad(async () => ({ path: "processes/b.owm", content: "B", baseVersion: "bB" }));
  await lc.load({ repo: REPO, id: "b" });
  releaseSave();
  await tick(TIMING.autosaveMs);
  assert.equal(lc.state().baseVersion, "bB", "the stale result did not overwrite the new token");
  assert.equal(bridge.saved.length, 0, "no 'saved' notice for the orphaned save");
});

test("a re-load while live tears the old session down and re-upgrades the new document", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, engine } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(live.handles.length, 1);
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(live.handles[0]?.destroyed, 1, "the old session is torn down by the re-load");
  assert.equal(live.handles.length, 2, "and the new document goes live again");
  assert.equal(engine.unbound, 1);
});

test("a re-load under a conflict banner clears the banner and the pause — autosave works for the new document", async () => {
  const { lc, engine, bridge, chrome } = setup();
  bridge.onSave(async () => ({
    ok: false,
    conflict: true,
    path: "p",
    currentContent: "t",
    baseVersion: "v",
    message: "m",
  }));
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(lc.state().paused, true);
  bridge.onSave(async () => ({ ok: true, path: "processes/a.owm", baseVersion: "b2", warnings: [] }));
  await lc.load({ repo: REPO, id: "a" });
  assert.deepEqual(chrome.bannerLabels(), []);
  assert.equal(lc.state().paused, false);
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 2, "the new document autosaves again");
});

test("a live handle arriving after a supersede or a re-load is destroyed, never adopted", async () => {
  // superseded while connecting
  const liveA = fakeLive({ handle: true, delayMs: TIMING.autosaveMs * 3 });
  const a = setup({ live: liveA });
  const loadingA = a.lc.load({ repo: REPO, id: "a" });
  await tick(TIMING.autosaveMs);
  a.claim.supersede();
  await loadingA;
  assert.equal(a.lc.state().live, false);
  assert.equal(liveA.handles.length, 0, "the epoch-fenced flush vetoed the bind");
  // re-loaded while connecting: the stale attempt never binds, the new document upgrades
  const liveB = fakeLive({ handle: true, delayMs: TIMING.autosaveMs * 3 });
  const b = setup({ live: liveB });
  const first = b.lc.load({ repo: REPO, id: "a" });
  await tick(TIMING.autosaveMs);
  b.bridge.onLoad(async () => ({ path: "processes/b.owm", content: "B", baseVersion: "bB" }));
  liveB.next = { handle: true, snapshot: "B" };
  await b.lc.load({ repo: REPO, id: "b" });
  await first;
  await tick(TIMING.autosaveMs * 5);
  assert.deepEqual(liveB.calls, [
    { repo: REPO, path: "processes/a.owm" },
    { repo: REPO, path: "processes/b.owm" },
  ]);
  assert.equal(liveB.handles.length, 1, "exactly one bind — for the document that owns the widget");
  assert.equal(b.lc.state().live, true);
  assert.deepEqual(b.lc.document(), { repo: REPO, path: "processes/b.owm" });
});

test("overlapping loads: the newer one owns the widget even when the older import lands last", async () => {
  const { lc, engine, bridge, claim } = setup();
  const gates = new Map<string, () => void>();
  engine.importText = async (text) => {
    await new Promise<void>((r) => gates.set(text, r));
    engine.imported.push(text);
  };
  let n = 0;
  bridge.onLoad(async () =>
    ++n === 1
      ? { path: "processes/a.owm", content: "A", baseVersion: "bA" }
      : { path: "processes/b.owm", content: "B", baseVersion: "bB" },
  );
  const a = lc.load({ repo: REPO, id: "a" });
  await tick(1);
  const b = lc.load({ repo: REPO, id: "b" });
  await tick(1);
  gates.get("B")!();
  await tick(1);
  gates.get("A")!();
  await Promise.all([a, b]);
  assert.deepEqual(lc.document(), { repo: REPO, path: "processes/b.owm" });
  assert.deepEqual(claim.keys, [`${REPO}/processes/b.owm`], "the stale load took no claim");
  assert.equal(lc.state().baseVersion, "bB");
});

test("a mid-flight edit keeps the dot on between the first result and the re-armed save", async () => {
  const { lc, engine, bridge } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  bridge.onSave(async (n) => {
    if (n === 1) await gate;
    return { ok: true, path: "processes/a.owm", baseVersion: `v${n + 1}`, warnings: [] };
  });
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  engine.fire.dirty();
  release();
  await tick(1);
  assert.equal(bridge.saves.length, 1);
  assert.equal(lc.state().dirty, true, "the unsent edit keeps the dot on");
});

test("'Overwrite anyway' replays the serialization it conflicted with — an edit made under the banner still saves afterwards", async () => {
  const { lc, engine, bridge, chrome } = setup();
  let conflict = true;
  bridge.onSave(async (n) =>
    conflict
      ? {
          ok: false,
          conflict: true,
          path: "processes/a.owm",
          currentContent: "<theirs>",
          baseVersion: "v9",
          message: "m",
        }
      : { ok: true, path: "processes/a.owm", baseVersion: `v${n + 10}`, warnings: [] },
  );
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  const myText = bridge.saves[0]!.content;
  engine.fire.dirty(); // under the banner
  conflict = false;
  chrome.click("Overwrite anyway");
  await tick(1);
  assert.equal(bridge.saves.at(-1)?.content, myText, "the ORIGINAL serialization was replayed");
  assert.equal(lc.state().dirty, true, "the later edit is not marked saved");
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 3, "and it follows in its own save");
  assert.equal(bridge.saves.at(-1)?.content, "canvas#2");
});

test("a CAS conflict during the pre-bind flush leaves the widget on the banner, never bound", async () => {
  const live = fakeLive({ handle: true, delayMs: TIMING.autosaveMs * 3 });
  const { lc, engine, bridge, chrome } = setup({ live });
  bridge.onSave(async () => ({
    ok: false,
    conflict: true,
    path: "p",
    currentContent: "t",
    baseVersion: "v",
    message: "m",
  }));
  const loading = lc.load({ repo: REPO, id: "a" });
  await tick(TIMING.autosaveMs);
  engine.fire.dirty();
  await loading;
  assert.equal(lc.state().live, false);
  assert.equal(live.handles.length, 0, "the refused flush vetoed the bind");
  assert.deepEqual(chrome.bannerLabels(), ["Load their version", "Overwrite anyway", "Keep editing"]);
});

test("onDead: an edit made during the reconcile read is neither overwritten nor left unsaved", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, engine, bridge } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  bridge.onLoad(async () => {
    await gate;
    return { path: "processes/a.owm", content: "v1", baseVersion: "b1" };
  });
  live.next = { handle: false };
  live.hooks?.onDead();
  await tick(1);
  engine.fire.dirty(); // while the reconcile read is in flight (paused — no save yet)
  release();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(engine.imported.length, 1, "the dirty canvas was NOT reconciled over");
  assert.equal(bridge.saves.length, 1, "the edit was flushed (by the re-upgrade's pre-bind flush) — never lost");
  assert.equal(lc.state().dirty, false);
  assert.equal(lc.state().live, false);
});

test("onDead: a re-load during the reconcile read orphans the reconcile — no banner, the new document's token", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, bridge, chrome } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  bridge.onLoad(async () => {
    if (++n === 1) {
      await gate;
      return { path: "processes/a.owm", content: "diverged", baseVersion: "b7" };
    }
    return { path: "processes/b.owm", content: "B", baseVersion: "bB" };
  });
  live.next = { handle: false };
  live.hooks?.onDead();
  await tick(1);
  await lc.load({ repo: REPO, id: "b" });
  release();
  await tick(TIMING.autosaveMs);
  assert.deepEqual(chrome.bannerLabels(), [], "the stale reconcile raised no banner");
  assert.equal(lc.state().baseVersion, "bB");
  assert.equal(lc.state().paused, false);
});

test("live mode: an edit never dirties and 'Save now' never PUTs", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, engine, bridge, chrome } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  assert.equal(lc.state().dirty, false);
  assert.equal(chrome.dirty.at(-1), false);
  await lc.save();
  assert.equal(bridge.saves.length, 0);
});

test("a tool-input re-delivery after a supersede is ignored — banner and status stay", async () => {
  const { lc, bridge, chrome, claim } = setup();
  await lc.load({ repo: REPO, id: "a" });
  claim.supersede();
  const banners = chrome.banners.length;
  const status = chrome.last();
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(
    chrome.hidden,
    1,
    "the inactive banner was not hidden (load() hid one banner: its own, on the first load)",
  );
  assert.equal(chrome.banners.length, banners);
  assert.equal(chrome.last(), status);
  assert.equal(bridge.loads.length, 1, "no second read");
});

test("a failed import keeps the deep link, disables Save, and a later load recovers the button", async () => {
  let fail = true;
  const engine = fakeEngine({ importFails: () => fail });
  const { lc, chrome, claim } = setup({ engine });
  await assert.rejects(() => lc.load({ repo: REPO, id: "a" }), /bad import/);
  assert.deepEqual(lc.linkTarget(), { repo: REPO, path: "processes/a.owm" }, "the read landed — the link stays");
  assert.equal(lc.document(), undefined, "but nothing may be saved");
  assert.equal(chrome.openVisible.at(-1), true);
  assert.deepEqual(chrome.saveButton.at(-1), { enabled: false });
  assert.equal(claim.keys.length, 0);
  fail = false;
  await lc.load({ repo: REPO, id: "a" });
  assert.deepEqual(chrome.saveButton.at(-1), { visible: true, enabled: true });
  assert.deepEqual(lc.document(), { repo: REPO, path: "processes/a.owm" });
});

test("a re-load after a live session whose new upgrade fails shows the Save button again", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, chrome } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  assert.ok(
    chrome.saveButton.some((s) => s.visible === false),
    "hidden while live",
  );
  live.next = { handle: false };
  await lc.load({ repo: REPO, id: "a" });
  assert.equal(lc.state().live, false);
  assert.deepEqual(chrome.saveButton.at(-1), { visible: true, enabled: true });
});

// ── the frameless chrome port (spec §10.1): setSync, toasts, decisions, the
// backoff, flushNow, reload, flush-then-freeze, onRead, LoadError ─────────────

const conflictOnce = (bridge: ReturnType<typeof fakeBridge>) => {
  let conflict = true;
  bridge.onSave(async (n) => {
    if (conflict) {
      conflict = false;
      return {
        ok: false,
        conflict: true,
        path: "processes/a.owm",
        currentContent: "<theirs>",
        baseVersion: "v9",
        message: "moved",
      };
    }
    return { ok: true, path: "processes/a.owm", baseVersion: `v${n + 10}`, warnings: [] };
  });
};

test("setSync: load → saved → connecting → live; a host without live stays saved, a viewer reads readonly", async () => {
  const a = setup({ live: fakeLive({ handle: true }) });
  await a.lc.load({ repo: REPO, id: "a" });
  assert.deepEqual(a.chrome.kinds(), ["loading", "saved", "connecting", "live"]);
  assert.equal(a.chrome.sync.at(-1)?.mode, "live");
  assert.equal(a.chrome.sync[1]?.mode, "autosave-unavailable", "not live yet: the upgrade may fail");
  assert.deepEqual(a.lc.sync(), a.chrome.sync.at(-1));

  const b = setup({ live: fakeLive({ handle: false }) });
  await b.lc.load({ repo: REPO, id: "a" });
  assert.deepEqual(b.chrome.kinds(), ["loading", "saved", "connecting", "saved"]);

  const dmn = setup({ engine: fakeEngine({ live: false }) });
  await dmn.lc.load({ repo: REPO, id: "a" });
  assert.deepEqual(dmn.chrome.kinds(), ["loading", "saved"], "no binding: no connecting flash");
  assert.equal(dmn.chrome.sync.at(-1)?.mode, "autosave-by-design");

  const viewer = setup({ readonly: true });
  await viewer.lc.load({ repo: REPO, id: "a" });
  assert.deepEqual(viewer.chrome.kinds(), ["loading", "readonly"]);
  assert.equal(viewer.chrome.sync.at(-1)?.mode, "readonly");
});

test("setSync: dirty → saving → saved with findings; one warning toast per rise, an autosave stays quiet", async () => {
  const { lc, engine, bridge, chrome } = setup({ live: null });
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 4);
  assert.deepEqual(chrome.kinds(), ["loading", "saved", "unsaved", "saving", "saved"]);
  assert.equal(chrome.sync.at(-1)?.findings, undefined, "a clean save carries no findings");
  assert.equal(typeof chrome.sync.at(-1)?.savedAt, "number");
  assert.equal(chrome.toasts.length, 0, "an autosave that landed is the pill's business only");

  bridge.onSave(async () => ({ ok: true, path: "processes/a.owm", baseVersion: "v3", warnings: ["open sticky"] }));
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 4);
  assert.deepEqual(chrome.sync.at(-1)?.findings, { errors: [], warnings: ["open sticky"] });
  assert.equal(chrome.toasts.length, 1);
  assert.deepEqual(chrome.toasts[0], {
    tone: "warning",
    title: "Saved with 1 warning",
    detail: "open sticky",
    key: "findings",
  });
  // the same count again: no second toast
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 4);
  assert.equal(chrome.toasts.length, 1);
  // a rise (an error joins): one more
  bridge.onSave(async () => ({
    ok: true,
    path: "processes/a.owm",
    baseVersion: "v4",
    warnings: ["open sticky"],
    errors: ["no start event"],
  }));
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 4);
  assert.equal(chrome.toasts.at(-1)?.title, "Saved with 1 error and 1 warning");
  assert.equal(chrome.toasts.at(-1)?.detail, "no start event", "errors lead");
});

test("an explicit Save now toasts 'Saved'; in live mode it only says live already saves; a viewer ignores it", async () => {
  const a = setup({ live: null });
  await a.lc.load({ repo: REPO, id: "a" });
  a.engine.fire.dirty();
  await a.lc.save();
  assert.equal(a.bridge.saves.length, 1);
  assert.deepEqual(a.chrome.toasts, [{ tone: "success", title: "Saved" }]);

  const b = setup({ live: fakeLive({ handle: true }) });
  await b.lc.load({ repo: REPO, id: "a" });
  await b.lc.save();
  assert.equal(b.bridge.saves.length, 0);
  assert.deepEqual(b.chrome.toasts, [{ tone: "info", title: "Live sync already saves every edit" }]);

  const c = setup({ readonly: true });
  await c.lc.load({ repo: REPO, id: "a" });
  await c.lc.save();
  assert.equal(c.bridge.saves.length, 0);
  assert.deepEqual(c.chrome.toasts, [], "a viewer has nothing to save — and no failure to report");
});

test("conflict: a decision card (primary + consequences, defer → paused), then saved; each choice toasts its outcome", async () => {
  const { lc, engine, bridge, chrome } = setup({ live: null });
  conflictOnce(bridge);
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.deepEqual(chrome.kinds(), ["loading", "saved", "unsaved", "saving", "paused"]);
  const card = chrome.banners.at(-1)!;
  assert.equal(card.text, "Someone saved this model in the meantime.");
  assert.deepEqual(card.opts, { detail: "Autosave is paused until you choose.", tone: "warning", deferAs: "paused" });
  assert.deepEqual(
    card.actions.map((a) => [a.label, a.primary ?? false, a.danger ?? false, a.consequence]),
    [
      ["Load their version", true, false, "Your last change is discarded."],
      ["Overwrite anyway", false, true, "Their change is replaced right away."],
      ["Keep editing", false, false, "Your next autosave replaces their change."],
    ],
  );
  chrome.click("Load their version");
  await tick(TIMING.autosaveMs);
  assert.equal(chrome.kinds().at(-1), "saved");
  assert.deepEqual(chrome.toasts.at(-1), { tone: "info", title: "Loaded their version" });

  // overwrite: the success toast names what happened
  conflictOnce(bridge);
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  chrome.click("Overwrite anyway");
  await tick(TIMING.autosaveMs);
  assert.deepEqual(chrome.toasts.at(-1), { tone: "success", title: "Saved — your version replaced theirs" });
  assert.equal(chrome.kinds().at(-1), "saved");

  // keep editing
  conflictOnce(bridge);
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  chrome.click("Keep editing");
  assert.deepEqual(chrome.toasts.at(-1), {
    tone: "info",
    title: "Editing on — your next autosave replaces their version",
  });
  await tick(TIMING.autosaveMs * 3);
  assert.equal(chrome.kinds().at(-1), "saved");
});

test("live: peers ride setPeers; remote-won and import-failed toast; the roster empties when live ends", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, bridge, chrome } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  const anna = { name: "Anna Berg", color: "#335de5", kind: "human" as const };
  const agent = { name: "Claude for Anna Berg", color: "#0b7a55", kind: "agent" as const };
  live.hooks?.onPeers?.([anna, agent]);
  assert.deepEqual(chrome.peers, [[anna, agent]]);
  live.hooks?.onConflict("overlap");
  live.hooks?.onImportError("bad snapshot");
  assert.deepEqual(chrome.toasts, [
    { tone: "warning", title: "A remote edit won an overlapping change", detail: "overlap" },
    { tone: "danger", title: "Live import failed", detail: "bad snapshot" },
  ]);
  assert.equal(chrome.kinds().at(-1), "live", "neither touches the pill");
  // live dies and cannot resume: reconnecting → saved, the roster empties, one info toast
  bridge.onLoad(async () => ({ path: "processes/a.owm", content: "v1", baseVersion: "b7" }));
  live.next = { handle: false };
  live.hooks?.onDead();
  await tick(TIMING.autosaveMs * 2);
  assert.deepEqual(chrome.kinds().slice(-2), ["reconnecting", "saved"]);
  assert.deepEqual(chrome.peers.at(-1), []);
  assert.deepEqual(chrome.toasts.at(-1), { tone: "info", title: "Live sync lost — changes now save automatically" });
});

test("live: a room text that stays unrenderable is a keyed warning toast that opens designIQ, gone once it renders or live ends", async () => {
  const NOTICE = "The shared text cannot be rendered. Your canvas shows the last good state.";
  let linkable = true;
  let opened = 0;
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, bridge, chrome } = setup({
    live,
    openInDesignIQ: { available: () => linkable, run: () => void opened++ },
  });
  await lc.load({ repo: REPO, id: "a" });
  live.hooks?.onUnrenderable?.(NOTICE);
  const toast = chrome.toasts.at(-1);
  assert.deepEqual(
    { ...toast, action: toast?.action?.label },
    { tone: "warning", title: NOTICE, key: UNRENDERABLE_TOAST, action: "Open in designIQ" },
    "an action: it never times out",
  );
  toast?.action?.run();
  assert.equal(opened, 1, "the full editor shows the text as it is");
  assert.equal(chrome.status.at(-1), NOTICE, "the popover's activity line keeps it");
  assert.equal(chrome.kinds().at(-1), "live", "the pill stays Live");
  live.hooks?.onUnrenderable?.(null);
  assert.deepEqual(chrome.dismissed, [UNRENDERABLE_TOAST]);
  assert.equal(chrome.status.at(-1), RESTING_STATUS.live);

  // no deep link (no public URL): no action, the activity line still says it
  linkable = false;
  live.hooks?.onUnrenderable?.(NOTICE);
  assert.equal(chrome.toasts.at(-1)?.action, undefined);
  // live ends while the notice is up: it goes with the session that reported it
  bridge.onLoad(async () => ({ path: "processes/a.owm", content: "v1", baseVersion: "b7" }));
  live.next = { handle: false };
  live.hooks?.onDead();
  await tick(TIMING.autosaveMs * 2);
  assert.deepEqual(chrome.dismissed, [UNRENDERABLE_TOAST, UNRENDERABLE_TOAST]);
});

test("live dead: reconnecting → live again (byte-equal), → paused (diverged, then the resolution toasts)", async () => {
  const live = fakeLive({ handle: true, snapshot: "v1" });
  const { lc, bridge, chrome } = setup({ live });
  await lc.load({ repo: REPO, id: "a" });
  bridge.onLoad(async () => ({ path: "processes/a.owm", content: "v1", baseVersion: "b7" }));
  live.next = { handle: true, snapshot: "v1" };
  live.hooks?.onDead();
  await tick(TIMING.autosaveMs * 2);
  assert.deepEqual(
    chrome.kinds().slice(-2),
    ["reconnecting", "live"],
    "the reconnect's own upgrade reads as reconnecting",
  );

  bridge.onLoad(async () => ({ path: "processes/a.owm", content: "v2-by-a-colleague", baseVersion: "b8" }));
  live.next = { handle: false };
  live.hooks?.onDead();
  await tick(TIMING.autosaveMs * 2);
  assert.deepEqual(chrome.kinds().slice(-2), ["reconnecting", "paused"]);
  const card = chrome.banners.at(-1)!;
  assert.equal(card.text, "Live sync was interrupted");
  assert.equal(card.opts?.deferAs, "paused");
  assert.deepEqual(
    card.actions.map((a) => [a.label, a.primary ?? false, a.danger ?? false]),
    [
      ["Load server version", true, false],
      ["Keep my canvas", false, true],
    ],
  );
  chrome.click("Keep my canvas");
  assert.deepEqual(chrome.toasts.at(-1), {
    tone: "info",
    title: "Keeping this canvas — autosave will overwrite the server version",
  });
  assert.equal(chrome.kinds().at(-1), "unsaved");
});

test("autosave failure: failed + Retry toast, backoff retries (timing.retryMs), then the next edit; a landed save clears it", async () => {
  const { lc, engine, bridge, chrome } = setup({ live: null });
  let fail = true;
  bridge.onSave(async (n) => {
    if (fail) throw new Error("upstream unavailable");
    return { ok: true, path: "processes/a.owm", baseVersion: `v${n}`, warnings: [] };
  });
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(bridge.saves.length, 1);
  assert.equal(chrome.last(), "Autosave failed: upstream unavailable — retrying automatically");
  assert.equal(chrome.kinds().at(-1), "failed");
  assert.equal(typeof chrome.sync.at(-1)?.retryAt, "number", "the next automatic retry is known");
  const toast = chrome.toasts.at(-1)!;
  assert.equal(toast.tone, "danger");
  assert.equal(toast.title, "Autosave failed");
  assert.equal(toast.key, "save-failed");
  assert.equal(toast.action?.label, "Retry now");
  assert.match(toast.detail ?? "", /^upstream unavailable\. Your edits stay on this canvas — trying again in/);
  assert.equal(lc.state().failed, true);
  // 20 → 40 → 80 ms, then nothing more by itself
  await tick(20 + 40 + 80 + 60);
  assert.equal(bridge.saves.length, 4, "three automatic retries");
  assert.equal(chrome.last(), "Autosave failed: upstream unavailable — retrying on the next change");
  assert.equal(chrome.sync.at(-1)?.retryAt, undefined);
  await tick(100);
  assert.equal(bridge.saves.length, 4, "the backoff is exhausted");
  // the next edit tries again (on the plain debounce)
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(bridge.saves.length, 5);
  // a manual Retry (the toast action) lands: everything clears. No "Saved"
  // toast on top (a deliberate departure from §5.4): the pill's way back from
  // "Not saved" says it — one surface per transition (§8)
  fail = false;
  const toasts = chrome.toasts.length;
  chrome.toasts.at(-1)!.action!.run();
  await tick(TIMING.autosaveMs);
  assert.equal(bridge.saves.length, 6);
  assert.deepEqual(chrome.dismissed, ["save-failed"]);
  assert.equal(chrome.toasts.length, toasts, "the recovering pill speaks, no toast");
  assert.equal(chrome.kinds().at(-1), "saved");
  assert.equal(lc.state().failed, false);
});

test("flushNow (teardown): flushes a dirty canvas, waits for a save in flight, never while paused or live", async () => {
  const a = setup({ live: null });
  await a.lc.load({ repo: REPO, id: "a" });
  a.engine.fire.dirty();
  await a.lc.flushNow();
  assert.equal(a.bridge.saves.length, 1, "flushed without waiting for the debounce");
  assert.equal(a.lc.state().dirty, false);

  // a save in flight: flushNow resolves only once it landed
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  a.bridge.onSave(async () => {
    await gate;
    return { ok: true, path: "processes/a.owm", baseVersion: "v9", warnings: [] };
  });
  a.engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  let done = false;
  const flushing = a.lc.flushNow().then(() => (done = true));
  await tick(5);
  assert.equal(done, false);
  release();
  await flushing;
  assert.equal(a.lc.state().baseVersion, "v9");

  const b = setup({ live: null });
  conflictOnce(b.bridge);
  await b.lc.load({ repo: REPO, id: "a" });
  b.engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  b.engine.fire.dirty();
  await b.lc.flushNow();
  assert.equal(b.bridge.saves.length, 1, "paused under the decision: nothing leaves");

  const c = setup({ live: fakeLive({ handle: true }) });
  await c.lc.load({ repo: REPO, id: "a" });
  c.engine.fire.dirty();
  await c.lc.flushNow();
  assert.equal(c.bridge.saves.length, 0, "live: Yjs already persisted it");
});

test("reload: the tool input again through load() — re-read, re-import, the unsaved edit discarded, an orphaned timer never fires", async () => {
  const { lc, engine, bridge, chrome } = setup({ live: null });
  const input = { repo: REPO, id: "a" };
  await lc.load(input);
  assert.deepEqual(lc.lastInput(), input);
  engine.fire.dirty();
  bridge.onLoad(async () => ({ path: "processes/a.owm", content: "v2", baseVersion: "b2" }));
  await lc.reload();
  assert.equal(bridge.loads.length, 2);
  assert.deepEqual(engine.imported, ["v1", "v2"]);
  assert.equal(lc.state().dirty, false);
  assert.equal(lc.state().baseVersion, "b2");
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 0, "the discarded edit's timer was cleared");
  assert.equal(chrome.kinds().at(-1), "saved");
});

test("supersede: flush-then-freeze — the last edit is saved, the canvas re-mounts as a viewer, the pill reads inactive", async () => {
  const { lc, engine, bridge, chrome, claim, extras, mounts, mounted } = setup({ live: null });
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty(); // pending — the autosave debounce has not fired yet
  claim.supersede();
  await tick(5);
  assert.equal(lc.state().inactive, true);
  assert.equal(extras.destroyed, 1);
  assert.equal(bridge.saves.length, 1, "ONE last CAS save of the pending edit");
  assert.equal(bridge.saves[0]?.baseVersion, "b1");
  const card = chrome.banners.at(-1)!;
  assert.equal(card.text, "This model is open in a newer widget");
  assert.deepEqual(card.actions, [], "the adapter adds Open in designIQ — the lifecycle offers no choice");
  assert.equal(card.opts?.tone, "info");
  assert.equal(card.opts?.deferAs, "inactive");
  assert.match(card.opts?.detail ?? "", /Your last change was saved before this copy stopped\.$/);
  assert.deepEqual(mounts.calls, [false, true], "the freeze mounts a viewer");
  assert.equal(engine.destroyed, 1, "the editor is gone");
  const viewer = mounts.viewers[0]!;
  assert.equal(viewer.editable, false);
  assert.deepEqual(viewer.imported, [bridge.saves[0]?.content], "the viewer shows what the flush saved");
  assert.equal(engine.exports, 1, "no second export: the saved text IS the frozen canvas");
  assert.deepEqual(
    mounted.map((m) => m.frozen),
    [false, true],
    "the chrome re-binds the view after the remount",
  );
  assert.equal(lc.engine(), viewer);
  assert.equal(chrome.kinds().at(-1), "inactive");
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.length, 1, "nothing more leaves a dead instance");
});

test("supersede: a failing final save is named on the card; a paused decision or live session never flushes; a failed freeze shows the state card", async () => {
  const a = setup({ live: null });
  await a.lc.load({ repo: REPO, id: "a" });
  a.bridge.onSave(async () => {
    throw new Error("network down");
  });
  a.engine.fire.dirty();
  a.claim.supersede();
  await tick(5);
  assert.match(a.chrome.banners.at(-1)?.opts?.detail ?? "", /Your last change could not be saved: network down$/);

  const b = setup({ live: null });
  conflictOnce(b.bridge);
  await b.lc.load({ repo: REPO, id: "a" });
  b.engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(b.lc.state().paused, true);
  b.claim.supersede();
  await tick(5);
  assert.equal(b.bridge.saves.length, 1, "the decision owned the divergence — no final save");
  assert.deepEqual(b.chrome.bannerLabels(), [], "the superseded card replaced the conflict card");
  assert.match(
    b.chrome.banners.at(-1)?.opts?.detail ?? "",
    /Your unsaved change was not saved — it was waiting for your decision\. Redo it in the newest widget\.$/,
    "never flushed — but never silently lost either",
  );

  const c = setup({ live: fakeLive({ handle: true }) });
  await c.lc.load({ repo: REPO, id: "a" });
  c.claim.supersede();
  await tick(5);
  assert.equal(c.bridge.saves.length, 0, "live: Yjs persisted everything");
  assert.deepEqual(c.chrome.peers.at(-1), []);
  assert.deepEqual(c.mounts.calls, [false, true]);

  const d = setup({ live: null });
  await d.lc.load({ repo: REPO, id: "a" });
  d.engine.exportText = async () => {
    throw new Error("empty model");
  };
  d.claim.supersede();
  await tick(5);
  assert.deepEqual(d.chrome.states, [{ kind: "frozen-failed", error: "empty model" }]);
  assert.equal(d.engine.destroyed, 1, "never left editable");

  const viewer = setup({ readonly: true });
  await viewer.lc.load({ repo: REPO, id: "a" });
  viewer.claim.supersede();
  await tick(5);
  assert.deepEqual(viewer.mounts.calls, [true], "a viewer is frozen already — no remount");
});

test("onRead: after the read and before the import; at load START when the input carries the path", async () => {
  const a = setup({ live: null });
  await a.lc.load({ repo: REPO, id: "a" });
  assert.deepEqual(a.extras.reads, [{ path: "processes/a.owm", loads: 1, imports: 0 }]);

  const b = setup({ live: null });
  await b.lc.load({ repo: REPO, path: "processes/a.owm" });
  assert.deepEqual(
    b.extras.reads,
    [{ path: "processes/a.owm", loads: 0, imports: 0 }],
    "before the bridge read even started — and not again for the same path",
  );
});

test("onSaved: every landed save reaches the extras; a conflict, a failure and the superseded flush never do", async () => {
  const a = setup({ live: null });
  await a.lc.load({ repo: REPO, id: "a" });
  a.engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.deepEqual(a.extras.saved, ["processes/a.owm"], "the autosave landed");
  conflictOnce(a.bridge);
  a.engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(a.lc.state().paused, true);
  assert.equal(a.extras.saved.length, 1, "a CAS conflict is not a landed save");

  const b = setup({ live: null });
  await b.lc.load({ repo: REPO, id: "a" });
  b.bridge.onSave(async () => {
    throw new Error("network down");
  });
  b.engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(b.bridge.saves.length, 1);
  assert.deepEqual(b.extras.saved, [], "a failed save is not a landed one");

  const c = setup({ live: null });
  await c.lc.load({ repo: REPO, id: "a" });
  c.engine.fire.dirty(); // pending — the superseded flush saves it
  c.claim.supersede();
  await tick(5);
  assert.equal(c.bridge.saved.length, 1, "the flush landed (the model hears of it)");
  assert.deepEqual(c.extras.saved, [], "…the destroyed extras do not");
});

test("LoadError: the read rejects → stage read; the import rejects → stage import; a stale failure stays silent", async () => {
  const a = setup({ live: null });
  a.bridge.onLoad(async () => {
    throw new Error("upstream unavailable (502)");
  });
  const read = await a.lc.load({ repo: REPO, id: "a" }).catch((e: unknown) => e);
  assert.ok(read instanceof LoadError);
  assert.equal(read.stage, "read");
  assert.equal(read.message, "upstream unavailable (502)");
  assert.equal(a.chrome.kinds().at(-1), "loading", "the state card owns the screen");
  // Try again: the retry's load START reports loading again (the chrome swaps
  // its failure card back), then the landed load reports saved
  a.bridge.onLoad(async () => ({ path: "processes/a.owm", content: "v1", baseVersion: "b1" }));
  const before = a.chrome.sync.length;
  await a.lc.load(a.lc.lastInput()!);
  assert.deepEqual(a.chrome.kinds().slice(before, before + 1), ["loading"]);
  assert.equal(a.lc.sync().kind, "saved");

  const b = setup({ engine: fakeEngine({ importFails: () => true }), live: null });
  const imp = await b.lc.load({ repo: REPO, id: "a" }).catch((e: unknown) => e);
  assert.ok(imp instanceof LoadError);
  assert.equal(imp.stage, "import");

  // an older load whose read fails after a newer load took over: no rejection
  const c = setup({ live: null });
  let n = 0;
  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => (releaseA = r));
  c.bridge.onLoad(async () => {
    if (++n === 1) {
      await gateA;
      throw new Error("late");
    }
    return { path: "processes/b.owm", content: "B", baseVersion: "bB" };
  });
  const older = c.lc.load({ repo: REPO, id: "a" });
  await c.lc.load({ repo: REPO, id: "b" });
  releaseA();
  await older; // resolves — the newer load owns the widget
  assert.deepEqual(c.lc.document(), { repo: REPO, path: "processes/b.owm" });
});

// ── review fixes: the save state across conflicts, reloads and the stop ─────

test("supersede: an edit made during the final save stays unsaved, the card says so, the viewer shows what was saved", async () => {
  const { lc, engine, bridge, chrome, claim, mounts } = setup({ live: null });
  await lc.load({ repo: REPO, id: "a" });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  bridge.onSave(async (n) => {
    await gate;
    return { ok: true, path: "processes/a.owm", baseVersion: `b${n + 1}`, warnings: [] };
  });
  engine.fire.dirty();
  claim.supersede();
  await tick(5); // the flush exported its canvas and waits on the round trip
  engine.fire.dirty(); // a drag still in progress lands on the old editor
  release();
  await tick(5);
  assert.deepEqual(
    bridge.saves.map((x) => x.content),
    ["canvas#1"],
  );
  assert.equal(lc.state().dirty, true, "the late edit was never sent — it is not marked saved");
  const detail = chrome.banners.at(-1)?.opts?.detail ?? "";
  assert.doesNotMatch(detail, /Your last change was saved/);
  assert.match(detail, /your latest one came in while this copy stopped and was not\. Redo it in the newest widget\.$/);
  assert.deepEqual(mounts.viewers[0]?.imported, ["canvas#1"], "the frozen copy matches the server");
});

test("a failed save ends with its round trip: the conflict clears it, Load their version reads saved, the next failure backs off from the start", async () => {
  const { lc, engine, bridge, chrome } = setup({ live: null, timing: { retryMs: [20, 3000, 60_000] } });
  await lc.load({ repo: REPO, id: "a" });
  let n = 0;
  bridge.onSave(async () => {
    n++;
    if (n === 2) {
      return {
        ok: false,
        conflict: true,
        path: "processes/a.owm",
        currentContent: "<theirs>",
        baseVersion: "v9",
        message: "moved",
      };
    }
    throw new Error("upstream unavailable");
  });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(lc.state().failed, true);
  await tick(20 + 15); // the first retry comes back with a conflict
  assert.equal(chrome.kinds().at(-1), "paused");
  assert.equal(lc.state().failed, false, "the card owns the next step — no retry is coming");
  assert.deepEqual(chrome.dismissed, ["save-failed"], "the 'trying again' toast goes with it");
  chrome.click("Load their version");
  await tick(5);
  assert.equal(lc.state().dirty, false);
  assert.equal(chrome.kinds().at(-1), "saved", "not 'Not saved [Retry]' over a clean canvas");
  assert.equal(lc.sync().retryAt, undefined);
  // a fresh failure starts the backoff over (retryMs[0], not retryMs[1])
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(chrome.kinds().at(-1), "failed");
  assert.match(chrome.toasts.at(-1)?.detail ?? "", /trying again in 0 s\.$/);
});

test("supersede after a failed save: no 'trying again' toast stays under the superseded card", async () => {
  const { lc, engine, bridge, chrome, claim } = setup({ live: null });
  await lc.load({ repo: REPO, id: "a" });
  let fail = true;
  bridge.onSave(async (n) => {
    if (fail) throw new Error("upstream unavailable");
    return { ok: true, path: "processes/a.owm", baseVersion: `b${n}`, warnings: [] };
  });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(lc.state().failed, true);
  fail = false;
  claim.supersede();
  await tick(5);
  assert.deepEqual(chrome.dismissed, ["save-failed"]);
  assert.match(chrome.banners.at(-1)?.opts?.detail ?? "", /Your last change was saved before this copy stopped\.$/);
});

test("Save now on a clean canvas PUTs nothing — it says all changes are saved", async () => {
  const { lc, bridge, chrome } = setup({ live: null });
  conflictOnce(bridge);
  await lc.load({ repo: REPO, id: "a" });
  await lc.save(); // a habitual ⌘S on an idle canvas
  assert.equal(bridge.saves.length, 0, "no stale canvas over a colleague's newer save");
  assert.deepEqual(chrome.toasts, [{ tone: "info", title: "All changes saved" }]);
  assert.deepEqual(chrome.bannerLabels(), [], "no conflict card over changes never made");
});

test("an explicit save with findings toasts the findings only — never a second 'Saved' on top", async () => {
  const { lc, engine, bridge, chrome } = setup({ live: null });
  await lc.load({ repo: REPO, id: "a" });
  bridge.onSave(async () => ({ ok: true, path: "processes/a.owm", baseVersion: "b2", warnings: ["open discussion"] }));
  engine.fire.dirty();
  await lc.save();
  assert.deepEqual(
    chrome.toasts.map((t) => t.title),
    ["Saved with 1 warning"],
  );
  assert.equal(chrome.last(), "Saved · 1 warning", "the status IS the pill label — no duplicate activity line");
});

test("reload waits for the save in flight: the re-read sees it, the next edit carries its token", async () => {
  const { lc, engine, bridge } = setup({ live: null });
  let server = { content: "v1", version: "b1" };
  bridge.onLoad(async () => ({ path: "processes/a.owm", content: server.content, baseVersion: server.version }));
  await lc.load({ repo: REPO, id: "a" });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  bridge.onSave(async (n) => {
    if (n === 1) await gate;
    const sent = bridge.saves.at(-1)!;
    if (sent.baseVersion !== server.version) {
      return {
        ok: false,
        conflict: true,
        path: "processes/a.owm",
        currentContent: server.content,
        baseVersion: server.version,
        message: "moved",
      };
    }
    server = { content: sent.content, version: `b${n + 1}` };
    return { ok: true, path: "processes/a.owm", baseVersion: server.version, warnings: [] };
  });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2); // the autosave is in flight
  const reloading = lc.reload();
  await tick(5);
  assert.equal(bridge.loads.length, 1, "the re-read waits for the save in flight");
  release();
  await reloading;
  assert.equal(lc.state().baseVersion, "b2", "the landed save's version, not the pre-save one");
  assert.equal(engine.imported.at(-1), "canvas#1");
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(bridge.saves.at(-1)?.baseVersion, "b2");
  assert.equal(lc.state().paused, false, "no conflict against the user's own save");
});

test("live regions: a conflict and a Retry speak once each — the card and the toast, the pill only on the way back", async () => {
  const say = (sync: SyncState[]): Array<string | undefined> => {
    const announce = createAnnouncer();
    return sync.map((s) => announce(s));
  };
  const a = setup({ live: null });
  conflictOnce(a.bridge);
  await a.lc.load({ repo: REPO, id: "a" });
  a.engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(a.chrome.kinds().at(-1), "paused");
  assert.deepEqual(say(a.chrome.sync).filter(Boolean), ["Saved"], "the decision card speaks 'paused', not the pill");
  a.chrome.click("Keep editing");
  await tick(TIMING.autosaveMs * 3);
  assert.deepEqual(say(a.chrome.sync).filter(Boolean), ["Saved", "Saved"], "paused → saved is spoken");

  const b = setup({ live: null });
  let fail = true;
  b.bridge.onSave(async (n) => {
    if (fail) throw new Error("upstream unavailable");
    return { ok: true, path: "processes/a.owm", baseVersion: `b${n}`, warnings: [] };
  });
  await b.lc.load({ repo: REPO, id: "a" });
  b.engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  assert.deepEqual(say(b.chrome.sync).filter(Boolean), ["Saved"], "the danger toast speaks 'failed', not the pill");
  fail = false;
  b.chrome.toasts.at(-1)!.action!.run();
  await tick(TIMING.autosaveMs);
  assert.deepEqual(say(b.chrome.sync).filter(Boolean), ["Saved", "Saved"]);
  assert.equal(b.chrome.toasts.filter((t) => t.title === "Saved").length, 0, "the pill's 'Saved' is the only word");
});

/** what the live regions would say, beat by beat: the port's setSync through
 *  the pill's announcer and every toast through its speech, grouped by the
 *  synchronous run they arrive in (stricter than the regions' 60 ms beat) and
 *  joined by the regions' own rule */
function speech(chrome: FakeChrome): Array<{ polite?: string; assertive?: string }> {
  const beats: Array<{ polite?: string; assertive?: string }> = [];
  const announce = createAnnouncer();
  let beat: Utterance[] = [];
  const say = (u: Utterance): void => {
    if (beat.length === 0) {
      setTimeout(() => {
        beats.push(speakBeat(beat));
        beat = [];
      }, 0);
    }
    beat.push(u);
  };
  const { setSync, toast } = chrome.port;
  chrome.port.setSync = (s) => {
    setSync(s);
    const said = announce(s);
    if (said) say({ text: said, state: true });
  };
  chrome.port.toast = (t) => {
    toast(t);
    say(toastAnnouncement(t));
  };
  return beats;
}

test("live regions: a Retry that lands with findings speaks once — the findings toast, never the pill's label on top", async () => {
  const { lc, engine, bridge, chrome } = setup({ live: null });
  const beats = speech(chrome);
  let fail = true;
  bridge.onSave(async (n) => {
    if (fail) throw new Error("upstream unavailable");
    return { ok: true, path: "processes/a.owm", baseVersion: `b${n}`, warnings: ["open discussion"] };
  });
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  assert.equal(chrome.kinds().at(-1), "failed");
  assert.match(beats.at(-1)?.assertive ?? "", /^Autosave failed\. upstream unavailable/);
  assert.equal(beats.at(-1)?.polite, undefined, "the danger toast speaks 'Not saved', not the pill");

  // the pill's [Retry] and the toast's Retry now are the same explicit save
  fail = false;
  const before = beats.length;
  chrome.toasts.at(-1)!.action!.run();
  await tick(TIMING.autosaveMs);
  assert.deepEqual(chrome.sync.at(-1), {
    kind: "saved",
    mode: "autosave-by-design",
    findings: { errors: [], warnings: ["open discussion"] },
    savedAt: chrome.sync.at(-1)?.savedAt,
  });
  assert.deepEqual(
    beats.slice(before),
    [{ polite: "Saved with 1 warning. open discussion" }],
    "one sentence: 'Saved · 1 warning' (failed → saved, a class change) yields to the toast",
  );

  // the way back without findings: no toast, so the pill is the one surface
  bridge.onSave(async () => {
    throw new Error("upstream unavailable");
  });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 2);
  bridge.onSave(async (n) => ({ ok: true, path: "processes/a.owm", baseVersion: `b${n}`, warnings: [] }));
  const again = beats.length;
  chrome.toasts.at(-1)!.action!.run();
  await tick(TIMING.autosaveMs);
  assert.deepEqual(beats.slice(again), [{ polite: "Saved" }]);
});

test("live regions: 'Overwrite anyway' speaks its toast — the pill's way back from paused stays quiet under it", async () => {
  const { lc, engine, bridge, chrome } = setup({ live: null });
  const beats = speech(chrome);
  conflictOnce(bridge);
  await lc.load({ repo: REPO, id: "a" });
  engine.fire.dirty();
  await tick(TIMING.autosaveMs * 3);
  assert.equal(chrome.kinds().at(-1), "paused");
  const before = beats.length;
  chrome.click("Overwrite anyway");
  await tick(TIMING.autosaveMs);
  assert.equal(chrome.kinds().at(-1), "saved");
  assert.deepEqual(beats.slice(before), [{ polite: "Saved — your version replaced theirs" }]);
});
