/**
 * The sync pill's vocabulary (src/mcp-app/core/sync-view.ts): labels, tones
 * and icons per state, the ONE precedence, the live regions that speak class
 * changes only, the popover per mode — and the rule that a DMN test verdict
 * never reaches the pill.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SyncKind, SyncState } from "../src/mcp-app/core/lifecycle.ts";
import {
  AUTOSAVE_NOTE,
  avatarRow,
  createAnnouncer,
  initials,
  LIVE_TITLE,
  savedStatus,
  shouldAnnounce,
  speakBeat,
  type SyncFlags,
  syncKindOf,
  syncPopover,
  syncView,
} from "../src/mcp-app/core/sync-view.ts";

const ALL: SyncKind[] = [
  "loading",
  "connecting",
  "live",
  "reconnecting",
  "saved",
  "unsaved",
  "saving",
  "failed",
  "paused",
  "readonly",
  "inactive",
];

test("labels, tones and icons — colour never alone: every state carries an icon or a dot", () => {
  const rows = ALL.map((kind) => {
    const v = syncView({ kind });
    return [kind, v.label, v.tone, v.icon ?? `dot:${v.dot}`, v.spinner];
  });
  assert.deepEqual(rows, [
    ["loading", "Loading…", "neutral", "loader-circle", true],
    ["connecting", "Connecting…", "neutral", "loader-circle", true],
    ["live", "Live", "neutral", "dot:live", false],
    ["reconnecting", "Reconnecting…", "warning", "loader-circle", true],
    ["saved", "Saved", "neutral", "check", false],
    ["unsaved", "Unsaved changes", "neutral", "dot:dirty", false],
    ["saving", "Saving…", "neutral", "loader-circle", true],
    ["failed", "Not saved", "danger", "dot:bad", false],
    ["paused", "Autosave paused", "warning", "dot:warn", false],
    ["readonly", "Read-only", "neutral", "eye", false],
    ["inactive", "Inactive", "muted", "circle-dashed", false],
  ]);
  for (const kind of ALL) {
    const v = syncView({ kind });
    assert.ok(Boolean(v.icon) !== Boolean(v.dot), `${kind}: an icon XOR a dot`);
  }
  assert.equal(syncView({ kind: "loading" }).hidden, true, "a state card owns the loading widget");
  assert.equal(syncView({ kind: "failed" }).retry, true, "[Not saved][Retry]");
  assert.equal(syncView({ kind: "paused" }).reopensDecision, true);
});

test("saved with findings: the count joins the label, the tone and icon follow the worst", () => {
  const warn = syncView({ kind: "saved", findings: { errors: [], warnings: ["w"] } });
  assert.deepEqual([warn.label, warn.tone, warn.icon], ["Saved · 1 warning", "warning", "triangle-alert"]);
  const err = syncView({ kind: "saved", findings: { errors: ["a", "b"], warnings: [] } });
  assert.deepEqual([err.label, err.tone, err.icon], ["Saved · 2 errors", "danger", "circle-alert"]);
  const both = syncView({ kind: "saved", findings: { errors: ["a"], warnings: ["w", "x"] } });
  assert.equal(both.label, "Saved · 1 error · 2 warnings");
  assert.equal(syncView({ kind: "unsaved", findings: { errors: ["a"], warnings: [] } }).label, "Unsaved changes");
});

test("precedence: loading > inactive > readonly > paused > failed > reconnecting > saving > unsaved > connecting > live > saved", () => {
  const none: SyncFlags = {
    loading: false,
    inactive: false,
    readonly: false,
    decision: false,
    failed: false,
    reconnecting: false,
    saving: false,
    dirty: false,
    connecting: false,
    live: false,
  };
  const order: Array<[keyof SyncFlags, SyncKind]> = [
    ["loading", "loading"],
    ["inactive", "inactive"],
    ["readonly", "readonly"],
    ["decision", "paused"],
    ["failed", "failed"],
    ["reconnecting", "reconnecting"],
    ["saving", "saving"],
    ["dirty", "unsaved"],
    ["connecting", "connecting"],
    ["live", "live"],
  ];
  assert.equal(syncKindOf(none), "saved");
  // each flag wins over every flag after it
  for (let i = 0; i < order.length; i++) {
    const flags = { ...none };
    for (const [flag] of order.slice(i)) flags[flag] = true;
    assert.equal(syncKindOf(flags), order[i]![1], `${order[i]![0]} outranks the rest`);
  }
  // the spec's named cases
  assert.equal(syncKindOf({ ...none, connecting: true, dirty: true }), "unsaved", "pending outranks connecting");
  assert.equal(syncKindOf({ ...none, failed: true, saving: true, dirty: true }), "failed");
  assert.equal(syncKindOf({ ...none, decision: true, failed: true }), "paused");
});

// a deliberate departure from spec §4 ("failed and paused go to #alert"): the
// danger toast and the decision card always speak those transitions, so the
// pill stays quiet there — one surface per transition (§8)
test("announce: class changes only — Saving→Saved never chatters; failed, paused and inactive are spoken by their toast or card", () => {
  const announce = createAnnouncer();
  const seq: SyncState[] = [
    { kind: "loading" },
    { kind: "saved" },
    { kind: "unsaved" },
    { kind: "saving" },
    { kind: "saved" },
    { kind: "saved", findings: { errors: [], warnings: ["w"] } },
    { kind: "failed" },
    { kind: "paused" },
    { kind: "saved" },
    { kind: "connecting" },
    { kind: "live" },
    { kind: "reconnecting" },
    { kind: "inactive" },
  ];
  const spoken = seq.map((s) => announce(s));
  assert.deepEqual(spoken, [
    undefined, // loading: the state card speaks
    "Saved",
    undefined,
    undefined,
    undefined, // pending → ok again is no class change
    undefined, // findings: the toast speaks
    undefined, // failed: the danger toast "Autosave failed" speaks
    undefined, // paused: the decision card speaks (by focus, or #alert)
    "Saved", // …and the way back is a class change
    undefined,
    undefined,
    "Reconnecting…",
    undefined, // inactive: the superseded card speaks
  ]);
});

test("speakBeat: one surface per transition — the pill's sentence yields to any event in its beat", () => {
  assert.deepEqual(speakBeat([{ text: "Saved", state: true }]), { polite: "Saved" }, "alone, the pill speaks");
  // a Retry that lands with findings: the toast names the cause, the pill would only repeat it
  assert.deepEqual(
    speakBeat([{ text: "Saved with 1 warning. open discussion" }, { text: "Saved · 1 warning", state: true }]),
    { polite: "Saved with 1 warning. open discussion" },
  );
  // in either order, and an assertive event silences it too
  assert.deepEqual(speakBeat([{ text: "Saved", state: true }, { text: "Saved — your version replaced theirs" }]), {
    polite: "Saved — your version replaced theirs",
  });
  assert.deepEqual(
    speakBeat([
      { text: "Reconnecting…", state: true },
      { text: "Live import failed. bad", assertive: true },
    ]),
    { assertive: "Live import failed. bad" },
  );
  // events never yield: each region joins its own, in arrival order
  assert.deepEqual(speakBeat([{ text: "a" }, { text: "b", assertive: true }, { text: "c" }]), {
    polite: "a c",
    assertive: "b",
  });
  assert.deepEqual(speakBeat([]), {});
});

test("shouldAnnounce(prev, next): the first non-pending state, then class changes only", () => {
  assert.equal(shouldAnnounce(undefined, { kind: "saved" }), true);
  assert.equal(shouldAnnounce(undefined, { kind: "saving" }), false, "pending is never spoken");
  assert.equal(shouldAnnounce({ kind: "saved" }, { kind: "live" }), false, "ok → ok");
  assert.equal(shouldAnnounce({ kind: "live" }, { kind: "reconnecting" }), true, "ok → problem");
  assert.equal(shouldAnnounce({ kind: "failed" }, { kind: "paused" }), false, "problem → problem");
  assert.equal(shouldAnnounce({ kind: "paused" }, { kind: "readonly" }), true);
});

test("DMN test results never map to the pill — no state, label or popover speaks of tests", () => {
  for (const kind of ALL) {
    const v = syncView({ kind, findings: { errors: ["e"], warnings: ["w"] } });
    const p = syncPopover(
      { kind, mode: "autosave-by-design", findings: { errors: ["e"], warnings: ["w"] } },
      { dirty: true, saving: false, editable: true, deepLink: true },
    );
    const words = [v.label, v.ariaLabel, p.title, ...p.lines, p.footnote ?? ""].join(" ");
    assert.doesNotMatch(words, /\b(test|tests|pass|passes|failing|checks?)\b/i, `${kind}: ${words}`);
  }
  // and SyncState has no slot for a verdict
  const state: SyncState = { kind: "saved" };
  assert.deepEqual(Object.keys(syncView(state)).includes("verdict"), false);
});

test("popover note per mode: autosave unavailable (bpmn/Miragon), autosave by design (dmn), live, read-only, inactive", () => {
  const ctx = { dirty: false, saving: false, editable: true, deepLink: true };
  assert.deepEqual(syncPopover({ kind: "saved", mode: "autosave-unavailable" }, ctx).lines, [
    AUTOSAVE_NOTE["autosave-unavailable"],
  ]);
  assert.match(AUTOSAVE_NOTE["autosave-unavailable"], /Live co-editing is not available in this chat client/);
  assert.deepEqual(syncPopover({ kind: "unsaved", mode: "autosave-by-design" }, ctx).lines, [
    AUTOSAVE_NOTE["autosave-by-design"],
  ]);
  assert.match(AUTOSAVE_NOTE["autosave-by-design"], /asks you before anything is overwritten/);
  const live = syncPopover(
    { kind: "live", mode: "live" },
    {
      ...ctx,
      peers: [
        { name: "Anna Berg", color: "#000" },
        { name: "Claude for Anna Berg", color: "#000", kind: "agent" },
      ],
    },
  );
  assert.deepEqual(live.lines, ["Live — every edit syncs to everyone in this document."]);
  assert.equal(live.hereNow, "Here now: Anna Berg, Claude for Anna Berg");
  assert.deepEqual(live.actions, [], "live: nothing to save");
  const ro = syncPopover({ kind: "readonly", mode: "readonly" }, { ...ctx, editable: false });
  assert.deepEqual(ro.lines, ["This chat opened the model read-only. Open it in designIQ to edit."]);
  assert.deepEqual(
    ro.actions.map((a) => a.id),
    ["open"],
  );
  const inactive = syncPopover({ kind: "inactive", mode: "readonly" }, ctx);
  assert.deepEqual(inactive.lines, ["A newer widget in this chat owns this model. This copy no longer saves."]);
  assert.deepEqual(
    inactive.actions.map((a) => a.id),
    ["open"],
  );
});

test("popover: time of the last save, every finding a row, Save now disabled when clean, Retry when failed, the activity line", () => {
  const savedAt = Date.UTC(2026, 9, 10, 14, 2);
  const p = syncPopover(
    { kind: "saved", mode: "autosave-unavailable", savedAt, findings: { errors: [], warnings: ["open discussion"] } },
    {
      dirty: false,
      saving: false,
      editable: true,
      deepLink: true,
      locale: "en-GB",
      timeZone: "UTC",
      activity: "Saved · 1 warning",
    },
  );
  assert.equal(p.title, "Saved · 1 warning");
  assert.equal(p.time, "14:02");
  assert.deepEqual(p.findings, [{ tone: "warning", text: "open discussion" }]);
  assert.equal(p.footnote, "Warnings never block a save. The assistant in this chat sees them too.");
  assert.deepEqual(p.actions, [
    {
      id: "save-now",
      label: "Save now",
      icon: "save",
      kbd: "⌘S",
      disabled: true,
      hint: "All changes saved",
      title: "Nothing to save",
    },
  ]);
  assert.equal(p.lines.length, 1, "the status text 'Saved · 1 warning' adds nothing to the label — no activity line");
  // the lifecycle's resting sentences restate the state: no activity line either
  for (const [kind, activity] of [
    ["saved", "Ready — changes save automatically"],
    ["readonly", "Read-only view"],
    ["live", "Live — co-editing enabled, changes sync instantly"],
    ["saving", "Saving…"],
  ] as const) {
    const idle = syncPopover(
      { kind, mode: kind === "readonly" ? "readonly" : kind === "live" ? "live" : "autosave-unavailable" },
      { dirty: false, saving: kind === "saving", editable: true, deepLink: true, activity },
    );
    assert.ok(!idle.lines.includes(activity), `${kind}: '${activity}' adds nothing`);
  }

  const dirty = syncPopover(
    { kind: "unsaved", mode: "autosave-unavailable" },
    {
      dirty: true,
      saving: false,
      editable: true,
      deepLink: true,
      mac: false,
      activity: "Editing on — autosave will overwrite their version",
    },
  );
  assert.deepEqual(dirty.actions, [{ id: "save-now", label: "Save now", icon: "save", kbd: "Ctrl+S" }]);
  assert.equal(
    dirty.lines.at(-1),
    "Editing on — autosave will overwrite their version",
    "today's lifecycle copy stays the detail",
  );

  const failed = syncPopover(
    { kind: "failed", mode: "autosave-unavailable", retryAt: Date.UTC(2026, 9, 10, 14, 3) },
    {
      dirty: true,
      saving: false,
      editable: true,
      deepLink: true,
      locale: "en-GB",
      timeZone: "UTC",
      activity: "Autosave failed: upstream unavailable — retrying automatically",
    },
  );
  assert.deepEqual(failed.lines, [
    "Autosave failed: upstream unavailable — retrying automatically",
    "Next try at 14:03.",
  ]);
  assert.deepEqual(
    failed.actions.map((a) => a.id),
    ["retry-now"],
  );
  const exhausted = syncPopover(
    { kind: "failed", mode: "autosave-unavailable" },
    { dirty: true, saving: false, editable: true, deepLink: true },
  );
  assert.equal(exhausted.lines.at(-1), "The next edit tries again.");
});

test("avatars: three at most + overflow, the peer's own colour, agents flagged, 'N others here' in fullscreen", () => {
  const peers = [
    { name: "Anna Berg", color: "#111111" },
    { name: "Tom Kraus", color: "#222222" },
    { name: "Claude for Anna Berg", color: "#333333", kind: "agent" as const },
    { name: "petra", color: "#444444" },
  ];
  const row = avatarRow(peers, true);
  assert.deepEqual(
    row.shown.map((a) => [a.initials, a.color, a.agent]),
    [
      ["AB", "#111111", false],
      ["TK", "#222222", false],
      ["CB", "#333333", true],
    ],
  );
  assert.equal(row.overflow, 1);
  assert.equal(row.sub, "· 4 others here");
  assert.equal(avatarRow(peers).sub, undefined, "inline: no sub-line");
  assert.equal(initials("petra"), "PE");
  assert.equal(syncView({ kind: "live" }, peers.slice(0, 2)).ariaLabel, "Live, 2 others editing — show sync details");
});

test("the pill's title: Live carries the SPA's ConnectionState title, no other state has one", () => {
  assert.equal(syncView({ kind: "live" }).title, "Live — every edit syncs to everyone in this document");
  assert.equal(LIVE_TITLE, "Live — every edit syncs to everyone in this document");
  for (const kind of ALL.filter((k) => k !== "live")) assert.equal(syncView({ kind }).title, undefined, kind);
});

test("findings: the lifecycle's status is the pill label exactly — errors included, no duplicate activity line", () => {
  const findings = { errors: ["e1", "e2"], warnings: ["w1"] };
  assert.equal(savedStatus(findings), "Saved · 2 errors · 1 warning");
  assert.equal(savedStatus(undefined), "Saved");
  const p = syncPopover(
    { kind: "saved", mode: "autosave-by-design", findings },
    { dirty: false, saving: false, editable: true, deepLink: true, activity: savedStatus(findings) },
  );
  assert.equal(p.title, "Saved · 2 errors · 1 warning");
  assert.deepEqual(
    p.lines,
    [AUTOSAVE_NOTE["autosave-by-design"]],
    "only the autosave note — never the same fact twice",
  );
});

test("Save now follows the lifecycle's availability (setSaveButton): hidden when not visible, disabled when not enabled", () => {
  const ctx = { dirty: true, saving: false, editable: true, deepLink: true };
  const state = { kind: "unsaved", mode: "autosave-unavailable" } as const;
  assert.deepEqual(
    syncPopover(state, { ...ctx, saveButton: { visible: false, enabled: true } }).actions,
    [],
    "live or a viewer: not offered",
  );
  const off = syncPopover(state, { ...ctx, saveButton: { visible: true, enabled: false } }).actions[0];
  assert.deepEqual([off?.id, off?.disabled, off?.hint], ["save-now", true, "Not available"]);
  const on = syncPopover(state, { ...ctx, saveButton: { visible: true, enabled: true } }).actions[0];
  assert.equal(on?.disabled, undefined);
});
