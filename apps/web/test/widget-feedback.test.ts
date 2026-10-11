/**
 * The feedback surfaces as data (src/mcp-app/core/feedback.ts): how long a
 * toast stays and who speaks it, keyed replace and which toasts the lane
 * shows (planLane: the count, the room, who waits and who leaves), where a
 * leaving toast fades (out of the flow), the timer
 * that pauses while a toast is read, the decision card's fixed copy, and the
 * §5.3 state cards — copy, role and their at most two actions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decisionAnnouncement,
  isUrlDetail,
  laneAdmit,
  laterLabel,
  leavingBottom,
  pausableTimer,
  planLane,
  stateActionPlan,
  type StateCardKind,
  stateCopy,
  type TimerDeps,
  TOAST_SHOW,
  TOAST_SHOW_CARD,
  toastAnnouncement,
  toastLifetime,
} from "../src/mcp-app/core/feedback.ts";

test("toast lifetime: success/info 2.8 s, warning/danger 5 s — and never with an action (WCAG 2.2.1)", () => {
  assert.equal(toastLifetime({ tone: "success" }), 2800);
  assert.equal(toastLifetime({ tone: "info" }), 2800);
  assert.equal(toastLifetime({ tone: "warning" }), 5000);
  assert.equal(toastLifetime({ tone: "danger" }), 5000);
  const run = (): void => {};
  for (const tone of ["success", "info", "warning", "danger"] as const) {
    assert.equal(toastLifetime({ tone, action: { label: "Retry now", run } }), null, `${tone} + action stays`);
  }
});

test("toast speech: danger is assertive, the rest polite; the detail joins the title", () => {
  assert.deepEqual(toastAnnouncement({ tone: "success", title: "Saved" }), { text: "Saved", assertive: false });
  assert.deepEqual(
    toastAnnouncement({ tone: "danger", title: "Autosave failed", detail: "upstream unavailable. Your edits stay." }),
    { text: "Autosave failed. upstream unavailable. Your edits stay.", assertive: true },
  );
  assert.equal(
    toastAnnouncement({ tone: "warning", title: "Saved with 1 warning", detail: "  " }).text,
    "Saved with 1 warning",
  );
});

test("a bare URL detail is set in mono (the blocked link), prose never", () => {
  assert.equal(isUrlDetail("https://designiq.example/r/Miragon/design-iq/f/processes/a.bpmn"), true);
  assert.equal(isUrlDetail("Open the model in designIQ and fix it there."), false);
  assert.equal(isUrlDetail("see https://x.example for more"), false);
  assert.equal(isUrlDetail(undefined), false);
});

test("lane: newest last, a same-key toast replaces its predecessor (how many show is planLane's)", () => {
  type T = { id: number; key?: string };
  let lane: T[] = [];
  const admit = (t: T): T[] => {
    const r = laneAdmit(lane, t);
    lane = r.lane;
    return r.removed;
  };
  assert.deepEqual(admit({ id: 1 }), []);
  assert.deepEqual(admit({ id: 2, key: "save-failed" }), []);
  assert.deepEqual(admit({ id: 3 }), []);
  assert.deepEqual(admit({ id: 4 }), [], "nothing is cut here — planLane decides who shows");
  assert.deepEqual(
    lane.map((t) => t.id),
    [1, 2, 3, 4],
  );
  // a keyed repeat replaces its predecessor — the newest goes last
  assert.deepEqual(
    admit({ id: 5, key: "save-failed" }).map((t) => t.id),
    [2],
  );
  assert.deepEqual(
    lane.map((t) => t.id),
    [1, 3, 4, 5],
  );
  // unkeyed toasts never replace each other
  assert.equal(laneAdmit<T>([{ id: 1 }], { id: 2 }).removed.length, 0);
});

/** a persistent toast (it carries an action) and an auto-dismissing one */
const P = (id: number, height = 80): { id: number; persistent: boolean; height: number } => ({
  id,
  persistent: true,
  height,
});
const A = (id: number, height = 80): { id: number; persistent: boolean; height: number } => ({
  id,
  persistent: false,
  height,
});
const ids = (list: Array<{ id: number }>): number[] => list.map((t) => t.id);
const plan = (
  toasts: Array<ReturnType<typeof P>>,
  lane: { card?: number; room: number },
): { show: number[]; wait: number[]; drop: number[] } => {
  const p = planLane(toasts, lane);
  return { show: ids(p.show), wait: ids(p.wait), drop: ids(p.drop) };
};

test("lane plan — count: two toasts show, one beside a decision card; the oldest auto-dismissing one yields first", () => {
  assert.deepEqual([TOAST_SHOW, TOAST_SHOW_CARD], [2, 1]);
  const room = 1000;
  assert.deepEqual(plan([], { room }), { show: [], wait: [], drop: [] });
  assert.deepEqual(plan([A(1), A(2)], { room }), { show: [1, 2], wait: [], drop: [] });
  // a third: the oldest auto-dismissing one leaves
  assert.deepEqual(plan([A(1), A(2), A(3)], { room }), { show: [2, 3], wait: [], drop: [1] });
  // … before any persistent one, however old — shown in arrival order
  assert.deepEqual(plan([P(1), A(2), A(3)], { room }), { show: [1, 3], wait: [], drop: [2] });
  // only persistent ones over the count: the oldest waits (out of the lane, back with room)
  assert.deepEqual(plan([P(1), P(2), P(3)], { room }), { show: [2, 3], wait: [1], drop: [] });
  // the newest — the event that just happened — always takes a place
  assert.deepEqual(plan([P(1), P(2), A(3)], { room }), { show: [2, 3], wait: [1], drop: [] });
  // beside a decision card: one
  assert.deepEqual(plan([P(1), A(2)], { card: 191, room }), { show: [2], wait: [1], drop: [] });
  assert.deepEqual(plan([A(1), P(2)], { card: 191, room }), { show: [2], wait: [], drop: [1] });
  // the card goes ("Decide later", resolved): the waiting toast comes back
  assert.deepEqual(plan([P(1), A(2)], { room }), { show: [1, 2], wait: [], drop: [] });
});

test("lane plan — room: the card first, then toasts while they fit, LANE_GAP between; never forced", () => {
  // 656x440, beside an open card: room 328, the CAS card 294 at 300px — no 98px toast fits beside it
  assert.deepEqual(plan([P(1, 98), A(2, 98)], { card: 294, room: 328 }), { show: [], wait: [1], drop: [2] });
  // 720x440: the card 211 at 364px + 8 + an 80px toast = 299 of 328 — one
  assert.deepEqual(plan([P(1, 62), P(2, 80)], { card: 211, room: 328 }), { show: [2], wait: [1], drop: [] });
  // to the pixel: 211 + 8 + 109 = 328 fits, 110 does not
  assert.deepEqual(plan([P(1, 109)], { card: 211, room: 328 }).show, [1]);
  assert.deepEqual(plan([P(1, 110)], { card: 211, room: 328 }).show, []);
  // a 480x420 sheet leaves its toasts 130: one 80px toast, not two (80 + 8 + 80 = 168)
  assert.deepEqual(plan([P(1), P(2)], { room: 130 }), { show: [2], wait: [1], drop: [] });
  // 480x480: 190 — both (168)
  assert.deepEqual(plan([P(1), A(2)], { room: 190 }), { show: [1, 2], wait: [], drop: [] });
  // the newest does not fit, an older one does: that one shows, the newest yields
  assert.deepEqual(plan([P(1, 80), A(2, 120)], { room: 100 }), { show: [1], wait: [], drop: [2] });
  // no room at all (a sheet in a very short frame): nothing is forced over its body
  assert.deepEqual(plan([P(1), A(2)], { room: 0 }), { show: [], wait: [1], drop: [2] });
  // a card taller than the room still counts whole: nothing beside it
  assert.deepEqual(plan([P(1, 10)], { card: 400, room: 328 }), { show: [], wait: [1], drop: [] });
});

test("a leaving toast fades out of the flow, pinned at its distance from the lane's bottom edge", () => {
  // 720x440 beside a card: the card 211 and a refused toast (80) under it — the
  // bottom entry fades at the bottom, where its keyed successor arrives
  assert.equal(leavingBottom(211 + 8 + 80, 211 + 8, 80), 0);
  // two toasts, 80 over 62: the upper one fades 70px up — where it was
  assert.equal(leavingBottom(80 + 8 + 62, 0, 80), 70);
  // a toast laid out at the lane's top in a lane as tall as itself
  assert.equal(leavingBottom(98, 0, 98), 0);
  // never below the lane (a stale read)
  assert.equal(leavingBottom(60, 0, 80), 0);
});

/** a hand-driven clock for the timer */
function fakeClock(): TimerDeps & { advance(ms: number): void } {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    set(fn, ms) {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clear: (h) => void timers.delete(h as number),
    advance(ms) {
      now += ms;
      for (const [h, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(h);
          t.fn();
        }
      }
    },
  };
}

test("the toast timer pauses on hover and on focus-within, and resumes with what was left", () => {
  const clock = fakeClock();
  let fired = 0;
  const timer = pausableTimer(2800, () => fired++, clock);
  clock.advance(1000);
  timer.pause("hover");
  clock.advance(10_000);
  assert.equal(fired, 0, "held while hovered");
  assert.equal(timer.remaining(), 1800);
  // focus arrives while hovered, the pointer leaves — focus still holds it
  timer.pause("focus");
  timer.resume("hover");
  clock.advance(10_000);
  assert.equal(fired, 0, "held while focused");
  timer.resume("focus");
  clock.advance(1799);
  assert.equal(fired, 0);
  clock.advance(1);
  assert.equal(fired, 1, "fires with the time that was left");
  // a resume without a matching pause, or after firing, never re-arms
  timer.resume("hover");
  clock.advance(10_000);
  assert.equal(fired, 1);
});

test("a cancelled toast timer never fires", () => {
  const clock = fakeClock();
  let fired = 0;
  const timer = pausableTimer(5000, () => fired++, clock);
  timer.cancel();
  timer.resume("hover");
  clock.advance(10_000);
  assert.equal(fired, 0);
});

test("decision card copy: the Decide-later name says what stays, the announcement joins title and body", () => {
  assert.equal(laterLabel("paused"), "Decide later — autosave stays paused");
  assert.equal(laterLabel(undefined), "Decide later — autosave stays paused");
  assert.equal(laterLabel("inactive"), "Decide later — this copy stays read-only");
  assert.equal(
    decisionAnnouncement("Someone saved this model in the meantime.", "Autosave is paused until you choose."),
    "Someone saved this model in the meantime. Autosave is paused until you choose.",
  );
  assert.equal(decisionAnnouncement("Live sync was interrupted"), "Live sync was interrupted");
});

test("state cards: §5.3 copy with the name from the tool input; loading is a status, failures alerts", () => {
  const rows = (
    [
      "booting",
      "loading",
      "no-input",
      "no-repo",
      "bridge-failed",
      "read-failed",
      "import-failed",
      "renderer-failed",
      "frozen-failed",
    ] as StateCardKind[]
  ).map((kind) => {
    const c = stateCopy({ kind, name: "order-to-cash" }, "Event Storming");
    return [kind, c.title, c.role, c.spinner, Boolean(c.help)];
  });
  assert.deepEqual(rows, [
    ["booting", "Starting the modeler…", "status", true, false],
    ["loading", "Loading order-to-cash…", "status", true, true],
    ["no-input", "No model received", "alert", false, true],
    ["no-repo", "This widget was opened without a repository", "alert", false, true],
    ["bridge-failed", "Could not connect to your chat client", "alert", false, false],
    ["read-failed", "Could not load order-to-cash", "alert", false, true],
    ["import-failed", "order-to-cash could not be displayed", "alert", false, false],
    ["renderer-failed", "The Event Storming modeler could not start", "alert", false, false],
    ["frozen-failed", "This copy is inactive", "alert", false, true],
  ]);
  assert.equal(stateCopy({ kind: "loading" }, "BPMN 2.0").title, "Loading the model…", "never an empty name");
  assert.equal(stateCopy({ kind: "loading" }, "BPMN 2.0").help, "Reading the model from designIQ");
});

test("state card actions: at most two, exactly one primary, Open only with a link, Ask only with ui/message", () => {
  const plan = (kind: StateCardKind, deepLink: boolean, message: boolean): string[] =>
    stateActionPlan(kind, { deepLink, message }).map((a) => `${a.primary ? "*" : ""}${a.label}`);
  assert.deepEqual(plan("read-failed", true, true), ["*Try again", "Open in designIQ"]);
  assert.deepEqual(plan("read-failed", false, true), ["*Try again"]);
  assert.deepEqual(plan("import-failed", true, true), ["*Ask the assistant to fix it", "Open in designIQ"]);
  assert.deepEqual(plan("import-failed", true, false), ["*Open in designIQ", "Try again"]);
  assert.deepEqual(plan("import-failed", false, false), ["*Try again"], "the lone action leads");
  assert.deepEqual(plan("import-failed", false, true), ["*Ask the assistant to fix it"]);
  assert.deepEqual(plan("renderer-failed", true, true), ["*Try again"]);
  assert.deepEqual(plan("frozen-failed", true, false), ["*Open in designIQ"]);
  assert.deepEqual(plan("frozen-failed", false, false), []);
  for (const kind of ["booting", "loading", "no-input", "no-repo", "bridge-failed"] as StateCardKind[]) {
    assert.deepEqual(plan(kind, true, true), [], `${kind}: no actions`);
  }
});
