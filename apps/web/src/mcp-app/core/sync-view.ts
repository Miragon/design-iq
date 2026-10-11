/**
 * The sync pill's vocabulary (spec §4) as pure data: the lifecycle's flags →
 * ONE SyncKind (the precedence lives here and nowhere else), a SyncState → the
 * pill (label, tone, icon or dot, the live-region class), the popover sentences
 * and footer actions, and the announcer that speaks class changes only.
 *
 * The pill is the home of lasting save and sync state — never of test
 * verdicts: a DMN test run has no input here on purpose (the Checks toggle
 * carries it). Labels and titles match the SPA's ConnectionState ("Live",
 * "Connecting…").
 * DOM-free and alias-free (`.ts` relative imports): node --test loads it.
 */
import type { PeerLabel, SyncKind, SyncMode, SyncState } from "./lifecycle.ts";

export type SyncTone = "neutral" | "warning" | "danger" | "muted";
/** speak a change only when this class changes (pending is never spoken) */
export type AnnounceClass = "ok" | "pending" | "problem" | "inactive" | "readonly";
/** the Lucide icons a pill or popover heading draws (icons.ts names) */
export type SyncIcon = "loader-circle" | "check" | "triangle-alert" | "circle-alert" | "eye" | "circle-dashed";
/** a status dot instead of an icon — chrome.css `.dot.<class>` */
export type SyncDot = "live" | "dirty" | "bad" | "warn";

/** what the lifecycle knows at any moment — syncKindOf picks ONE kind */
export interface SyncFlags {
  /** a load is in flight (its import has not landed) */
  loading: boolean;
  /** superseded by a newer widget */
  inactive: boolean;
  /** a viewer (boot flag or engine) — nothing saves */
  readonly: boolean;
  /** a decision card owns the next step (shown or deferred into the pill) */
  decision: boolean;
  /** the last save threw (cleared by the next landed save) */
  failed: boolean;
  /** the live session died; the reconcile is running */
  reconnecting: boolean;
  saving: boolean;
  dirty: boolean;
  /** the live upgrade is connecting */
  connecting: boolean;
  live: boolean;
}

/**
 * The precedence: loading > inactive > readonly > paused > failed >
 * reconnecting > saving > unsaved > connecting > live > saved. Pending outranks
 * connecting (an edit during the upgrade reads "Unsaved changes"); a lost live
 * session outranks the flush saves its reconnect runs.
 */
export function syncKindOf(f: SyncFlags): SyncKind {
  if (f.loading) return "loading";
  if (f.inactive) return "inactive";
  if (f.readonly) return "readonly";
  if (f.decision) return "paused";
  if (f.failed) return "failed";
  if (f.reconnecting) return "reconnecting";
  if (f.saving) return "saving";
  if (f.dirty) return "unsaved";
  if (f.connecting) return "connecting";
  if (f.live) return "live";
  return "saved";
}

const LABEL: Record<SyncKind, string> = {
  loading: "Loading…",
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  saved: "Saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  failed: "Not saved",
  paused: "Autosave paused",
  readonly: "Read-only",
  inactive: "Inactive",
};

const ANNOUNCE: Record<SyncKind, AnnounceClass> = {
  loading: "pending",
  connecting: "ok",
  live: "ok",
  saved: "ok",
  unsaved: "pending",
  saving: "pending",
  failed: "problem",
  paused: "problem",
  reconnecting: "problem",
  readonly: "readonly",
  inactive: "inactive",
};

export interface SyncView {
  kind: SyncKind;
  /** "Saved · 1 warning" */
  label: string;
  /** the pill's tooltip — the SPA's ConnectionState title, Live only */
  title?: string;
  tone: SyncTone;
  /** an icon OR a dot — never both, never neither (colour is never the only signal) */
  icon?: SyncIcon;
  dot?: SyncDot;
  /** the icon is loader-circle and spins (static under reduced motion) */
  spinner: boolean;
  /** the pill's accessible name */
  ariaLabel: string;
  announceClass: AnnounceClass;
  /** failed: render `[● Not saved][Retry]` — two sibling buttons */
  retry: boolean;
  /** paused: a click reopens the decision card instead of the popover */
  reopensDecision: boolean;
  /** loading: the state card owns the widget, the pill hides */
  hidden: boolean;
}

/** the SPA's ConnectionState title for Live, verbatim */
export const LIVE_TITLE = "Live — every edit syncs to everyone in this document";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "2 errors · 1 warning" ("" without findings) */
export function findingsSummary(f: SyncState["findings"], sep = " · "): string {
  const parts: string[] = [];
  if (f?.errors.length) parts.push(plural(f.errors.length, "error"));
  if (f?.warnings.length) parts.push(plural(f.warnings.length, "warning"));
  return parts.join(sep);
}

export function syncView(state: SyncState, peers: readonly PeerLabel[] = []): SyncView {
  const kind = state.kind;
  const findings = kind === "saved" ? findingsSummary(state.findings) : "";
  const label = findings ? `${LABEL.saved} · ${findings}` : LABEL[kind];
  const view: SyncView = {
    kind,
    label,
    tone: "neutral",
    spinner: false,
    ariaLabel: `${label} — show sync details`,
    announceClass: ANNOUNCE[kind],
    retry: kind === "failed",
    reopensDecision: kind === "paused",
    hidden: kind === "loading",
  };
  switch (kind) {
    case "loading":
    case "connecting":
    case "saving":
      return { ...view, icon: "loader-circle", spinner: true };
    case "reconnecting":
      return { ...view, tone: "warning", icon: "loader-circle", spinner: true };
    case "live": {
      const others = peers.length;
      const aria = others > 0 ? `Live, ${plural(others, "other")} editing — show sync details` : view.ariaLabel;
      return { ...view, dot: "live", ariaLabel: aria, title: LIVE_TITLE };
    }
    case "saved":
      if (state.findings?.errors.length) return { ...view, tone: "danger", icon: "circle-alert" };
      if (state.findings?.warnings.length) return { ...view, tone: "warning", icon: "triangle-alert" };
      return { ...view, icon: "check" };
    case "unsaved":
      return { ...view, dot: "dirty" };
    case "failed":
      return { ...view, tone: "danger", dot: "bad", ariaLabel: "Not saved — show sync details" };
    case "paused":
      return { ...view, tone: "warning", dot: "warn", ariaLabel: "Autosave paused — a decision is waiting" };
    case "readonly":
      return { ...view, icon: "eye" };
    case "inactive":
      return { ...view, tone: "muted", icon: "circle-dashed" };
  }
}

// ── avatars ─────────────────────────────────────────────────────────────────

export interface AvatarRow {
  /** at most three, in roster order */
  shown: Array<{ name: string; color: string; initials: string; agent: boolean }>;
  /** "+N" beyond the three */
  overflow: number;
  /** fullscreen: "· 3 others here" beside the label */
  sub?: string;
}

/** "Anna Berg" → "AB", "petra" → "PE" */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/** the pill's roster — colour is the PEER's presence colour (the DOM runs it
 *  through safePresenceColor, like the SPA's PeerAvatar), never a chrome alias */
export function avatarRow(peers: readonly PeerLabel[], fullscreen = false): AvatarRow {
  return {
    shown: peers.slice(0, 3).map((p) => ({
      name: p.name,
      color: p.color,
      initials: initials(p.name),
      agent: p.kind === "agent",
    })),
    overflow: Math.max(0, peers.length - 3),
    ...(fullscreen && peers.length > 0 ? { sub: `· ${plural(peers.length, "other")} here` } : {}),
  };
}

// ── the popover (pill click; paused reopens the decision card instead) ──────

export const AUTOSAVE_NOTE: Record<"autosave-unavailable" | "autosave-by-design", string> = {
  "autosave-unavailable":
    "Changes save automatically 1.5 s after your last edit. Live co-editing is not available in this chat client — each save lands in the shared document.",
  "autosave-by-design":
    "Changes save automatically 1.5 s after your last edit. A collision with someone else's save asks you before anything is overwritten.",
};

export type PopoverActionId = "save-now" | "retry-now" | "open";
export interface PopoverAction {
  id: PopoverActionId;
  label: string;
  icon: "save" | "rotate-ccw" | "external-link";
  disabled?: boolean;
  /** muted text left of the actions while disabled ("All changes saved") */
  hint?: string;
  title?: string;
  kbd?: string;
}

export interface SyncPopover {
  /** the heading — the pill label */
  title: string;
  tone: SyncTone;
  icon?: SyncIcon;
  dot?: SyncDot;
  spinner: boolean;
  /** the last landed save, host-locale short time ("14:02") */
  time?: string;
  /** the sentences, in order */
  lines: string[];
  /** every finding as a row (focusable, touch-friendly) */
  findings: Array<{ tone: "warning" | "danger"; text: string }>;
  /** under the findings */
  footnote?: string;
  /** live: "Here now: Anna Berg, Tom Kraus" */
  hereNow?: string;
  actions: PopoverAction[];
}

export interface PopoverContext {
  /** the lifecycle's latest setStatus text — shown when it says something new */
  activity?: string;
  dirty: boolean;
  saving: boolean;
  /** an editable engine (the viewer offers no Save now) */
  editable: boolean;
  /** the lifecycle's Save now availability (ChromePort.setSaveButton):
   *  `visible` = autosave mode, `enabled` = not saving / superseded / after a
   *  failed import — absent reads as offered */
  saveButton?: { visible: boolean; enabled: boolean };
  /** a deep link can be built (publicUrl + a read document) */
  deepLink: boolean;
  peers?: readonly PeerLabel[];
  /** hostContext.locale / timeZone */
  locale?: string;
  timeZone?: string;
  /** ⌘S vs Ctrl+S */
  mac?: boolean;
}

export function formatTime(epochMs: number, locale?: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(epochMs);
  } catch {
    // an unknown locale or zone from the host must not break the popover
    return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(epochMs);
  }
}

/** the lifecycle's resting status texts (its setStatus copy lives HERE, so a
 *  copy change cannot silently break the match) — each restates what the pill
 *  label and the popover sentence already say: no activity line */
export const RESTING_STATUS = {
  ready: "Ready — changes save automatically",
  readonly: "Read-only view",
  live: "Live — co-editing enabled, changes sync instantly",
  saving: "Saving…",
} as const;
const RESTING = new Set<string>(Object.values(RESTING_STATUS));

/** the status after a landed save — the pill label exactly, so it never
 *  doubles as an activity line ("Saved · 2 errors · 1 warning") */
export function savedStatus(f: SyncState["findings"]): string {
  const summary = findingsSummary(f);
  return summary ? `${LABEL.saved} · ${summary}` : LABEL.saved;
}

const isAutosave = (mode: SyncMode | undefined): mode is "autosave-unavailable" | "autosave-by-design" =>
  mode === "autosave-unavailable" || mode === "autosave-by-design";

export function syncPopover(state: SyncState, ctx: PopoverContext): SyncPopover {
  const view = syncView(state, ctx.peers);
  const time = (at: number | undefined): string | undefined =>
    at === undefined ? undefined : formatTime(at, ctx.locale, ctx.timeZone);
  const note = isAutosave(state.mode) ? AUTOSAVE_NOTE[state.mode] : undefined;
  const lines: string[] = [];
  const findings: SyncPopover["findings"] = [];
  let footnote: string | undefined;
  let hereNow: string | undefined;
  let savedTime: string | undefined;
  switch (state.kind) {
    case "loading":
      break;
    case "connecting":
      lines.push("Opening a live session for this model.");
      break;
    case "live":
      lines.push("Live — every edit syncs to everyone in this document.");
      if (ctx.peers?.length) hereNow = `Here now: ${ctx.peers.map((p) => p.name).join(", ")}`;
      break;
    case "reconnecting":
      lines.push("Live sync lost — reconnecting…");
      break;
    case "saved":
      if (note) lines.push(note);
      savedTime = time(state.savedAt);
      for (const text of state.findings?.errors ?? []) findings.push({ tone: "danger", text });
      for (const text of state.findings?.warnings ?? []) findings.push({ tone: "warning", text });
      if (state.findings?.errors.length) {
        footnote = "The save still landed — findings never block it. The assistant in this chat sees them too.";
      } else if (state.findings?.warnings.length) {
        footnote = "Warnings never block a save. The assistant in this chat sees them too.";
      }
      break;
    case "unsaved":
    case "saving":
    case "paused":
      if (note) lines.push(note);
      break;
    case "failed":
      lines.push(ctx.activity ?? "Autosave failed.");
      lines.push(state.retryAt !== undefined ? `Next try at ${time(state.retryAt)}.` : "The next edit tries again.");
      break;
    case "readonly":
      lines.push("This chat opened the model read-only. Open it in designIQ to edit.");
      break;
    case "inactive":
      lines.push("A newer widget in this chat owns this model. This copy no longer saves.");
      break;
  }
  // the lifecycle's own copy (today's status line) when it adds something —
  // its idle sentences only restate the state the pill and the note already say
  const activity = ctx.activity?.trim();
  if (activity && activity !== view.label && !lines.includes(activity) && !RESTING.has(activity)) {
    lines.push(activity);
  }

  const actions: PopoverAction[] = [];
  const kbd = ctx.mac === false ? "Ctrl+S" : "⌘S";
  const offered = ctx.editable && ctx.saveButton?.visible !== false;
  if (offered && isAutosave(state.mode) && ["saved", "unsaved", "saving", "connecting"].includes(state.kind)) {
    actions.push({
      id: "save-now",
      label: "Save now",
      icon: "save",
      kbd,
      ...(ctx.saving
        ? { disabled: true, hint: "Saving…" }
        : ctx.saveButton?.enabled === false
          ? { disabled: true, hint: "Not available" }
          : !ctx.dirty
            ? { disabled: true, hint: "All changes saved", title: "Nothing to save" }
            : {}),
    });
  }
  if (state.kind === "failed") actions.push({ id: "retry-now", label: "Retry now", icon: "rotate-ccw" });
  if ((state.kind === "readonly" || state.kind === "inactive") && ctx.deepLink) {
    actions.push({ id: "open", label: "Open in designIQ", icon: "external-link", title: "Open in designIQ (new tab)" });
  }
  return {
    title: view.label,
    tone: view.tone,
    ...(view.icon ? { icon: view.icon } : {}),
    ...(view.dot ? { dot: view.dot } : {}),
    spinner: view.spinner,
    ...(savedTime ? { time: savedTime } : {}),
    lines,
    findings,
    ...(footnote ? { footnote } : {}),
    ...(hereNow ? { hereNow } : {}),
    actions,
  };
}

// ── live regions ────────────────────────────────────────────────────────────

/** whether moving from `prev` (the last state SPOKEN — undefined before the
 *  first) to `next` is spoken: class changes only, pending never (so
 *  Saving→Saved never chatters and pending never becomes the baseline) */
export function shouldAnnounce(prev: SyncState | undefined, next: SyncState): boolean {
  const cls = syncView(next).announceClass;
  return cls !== "pending" && (prev === undefined || syncView(prev).announceClass !== cls);
}

/** the states another surface always speaks as they arrive: the danger toast
 *  "Autosave failed", the decision card (by focus, or #alert) — the pill
 *  saying it too would talk over them (and over the dialog a screen reader is
 *  just reading). A deliberate departure from spec §4's "failed and paused go
 *  to #alert": one surface per transition (§8). */
const SPOKEN_ELSEWHERE = new Set<SyncKind>(["failed", "paused", "inactive"]);

/** the stateful announcer chrome/sync.ts feeds every setSync (#announce,
 *  polite). A state spoken elsewhere still becomes the baseline, so the way
 *  back (paused → saved) is a class change and is spoken — unless an event
 *  says it in the same beat (speakBeat). */
export function createAnnouncer(): (state: SyncState) => string | undefined {
  let spoken: SyncState | undefined;
  return (state) => {
    if (!shouldAnnounce(spoken, state)) return undefined;
    spoken = state;
    return SPOKEN_ELSEWHERE.has(state.kind) ? undefined : syncView(state).label;
  };
}

/** one sentence for the live regions: an event (a toast, a decision card, a
 *  panel's outcome) or — `state` — the pill's class change */
export interface Utterance {
  text: string;
  assertive?: boolean;
  state?: boolean;
}

/**
 * What one beat of the two live regions speaks (chrome/sync.ts
 * mountLiveRegions joins what arrives within it). One surface per transition
 * (§8): the pill's sentence yields to any event in the same beat — the event
 * names the cause ("Saved with 1 warning. <finding>" says what "Saved · 1
 * warning" would only repeat), and the pill's own name still carries the
 * state. A region with nothing left is not written.
 */
export function speakBeat(beat: readonly Utterance[]): { polite?: string; assertive?: string } {
  const events = beat.filter((u) => !u.state);
  const kept = events.length > 0 ? events : beat;
  const join = (assertive: boolean): string =>
    kept
      .filter((u) => (u.assertive === true) === assertive)
      .map((u) => u.text)
      .join(" ");
  const polite = join(false);
  const assertive = join(true);
  return { ...(polite ? { polite } : {}), ...(assertive ? { assertive } : {}) };
}
