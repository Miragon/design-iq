/**
 * The feedback surfaces (spec §5) as pure data: the toast lane's rules (how
 * long a toast stays, keyed replace, which toasts show and which wait —
 * planLane —, where a leaving one fades, which live region speaks it, a
 * timer that pauses while the user reads), the decision card's
 * fixed copy, and the §5.3 state cards — their copy, their role and the at
 * most two actions each one offers. chrome/toasts.ts, decision.ts and
 * state-card.ts render it.
 * DOM-free (`.ts` relative imports): node --test loads it.
 */
import type { IconName } from "../icons.ts";
import { LANE_GAP } from "./layout.ts";
import type { BannerOptions, StateKind, ToastSpec } from "./lifecycle.ts";

// ── panel badges ────────────────────────────────────────────────────────────

/** a panel toggle's chip (TR) — and what the menu's Todos / Checks item
 *  repeats; core/todos-view.ts and core/checks-view.ts build it */
export interface PanelBadge {
  /** Todos: the open count */
  count?: number;
  /** Checks: "7/7" (ok) / "1 failing" (bad) / a spinner while running */
  verdict?: { text: string; tone: "ok" | "bad" | "muted"; icon?: IconName; spinner?: boolean };
  /** "Todos, 3 open" / "Checks, 7 of 7 pass" — the toggle's name once its label drops (step 4) */
  ariaLabel: string;
}

// ── toasts (§5.1) ───────────────────────────────────────────────────────────

export type ToastTone = ToastSpec["tone"];

/** at most two toasts show in the lane … */
export const TOAST_SHOW = 2;
/** … and one beside a decision card */
export const TOAST_SHOW_CARD = 1;
/** success / info read fast; warning / danger carry a cause worth reading */
export const TOAST_SHORT_MS = 2800;
export const TOAST_LONG_MS = 5000;

/** ms until a toast leaves by itself; null = it stays until answered — a
 *  toast with an action never times out (WCAG 2.2.1) */
export function toastLifetime(t: Pick<ToastSpec, "tone" | "action">): number | null {
  if (t.action) return null;
  return t.tone === "success" || t.tone === "info" ? TOAST_SHORT_MS : TOAST_LONG_MS;
}

/** the status dot beside the words (chrome.css `.dot.<class>`) — colour is
 *  never the only signal: the left rule, the dot and the title say it together */
export const TOAST_DOT: Record<ToastTone, "live" | "info" | "warn" | "bad"> = {
  success: "live",
  info: "info",
  warning: "warn",
  danger: "bad",
};

/** a danger toast speaks through the assertive #alert, the rest politely */
export function toastAnnouncement(t: Pick<ToastSpec, "tone" | "title" | "detail">): {
  text: string;
  assertive: boolean;
} {
  const detail = t.detail?.trim();
  return { text: detail ? `${t.title}. ${detail}` : t.title, assertive: t.tone === "danger" };
}

/** a detail that is a bare URL ("Your client blocked the link") is set in
 *  mono so it can be read and selected exactly */
export const isUrlDetail = (detail: string | undefined): boolean => /^https?:\/\/\S+$/.test(detail?.trim() ?? "");

/**
 * The toasts after `next` arrives (oldest first, newest last): a toast with
 * the same key is replaced. Returns the new order and the entries to take
 * out of the DOM. How many of them show is planLane's.
 */
export function laneAdmit<T extends { key?: string | undefined }>(
  lane: readonly T[],
  next: T,
): { lane: T[]; removed: T[] } {
  const removed: T[] = [];
  const kept = lane.filter((t) => {
    const replaced = next.key !== undefined && t.key === next.key;
    if (replaced) removed.push(t);
    return !replaced;
  });
  kept.push(next);
  return { lane: kept, removed };
}

export interface LaneToast {
  /** it carries an action and never leaves by itself (toastLifetime null) */
  persistent: boolean;
  /** its height at the lane's width, px */
  height: number;
}

export interface LanePlan<T> {
  /** in the lane, oldest first */
  show: T[];
  /** persistent toasts out of the lane until there is room again */
  wait: T[];
  /** auto-dismissing toasts that yielded: they leave for good */
  drop: T[];
}

/**
 * Which toasts the lane shows (spec §5.1). `toasts` oldest first; `card` the
 * decision card's height while one shows; `room` what the lane may hold, the
 * card counted (Layout.lane.room).
 *
 *  - Count: at most TOAST_SHOW, TOAST_SHOW_CARD beside a decision card.
 *  - Room: the card first (it always shows — chrome.css caps it at
 *    Layout.lane.max and lets it scroll itself in a frame too short for it),
 *    then the toasts while they fit, LANE_GAP between entries.
 *  - Who gets a place: the newest toast (the event that just happened), then
 *    the persistent ones, then the auto-dismissing ones — newest first within
 *    each. So the oldest auto-dismissing toast yields first.
 *  - Who yields: an auto-dismissing toast leaves (live regions have spoken it,
 *    its information lives on a persistent surface); a persistent one waits
 *    and comes back once there is room — it leaves only by its ×, its action
 *    or its condition clearing (dismissToast), never for lack of space.
 * The lane shows its toasts in arrival order whatever the priority.
 */
export function planLane<T extends LaneToast>(
  toasts: readonly T[],
  lane: { card?: number | undefined; room: number },
): LanePlan<T> {
  const newest = toasts.at(-1);
  const older = toasts.slice(0, -1).reverse();
  const order = newest ? [newest, ...older.filter((t) => t.persistent), ...older.filter((t) => !t.persistent)] : [];
  const cap = lane.card === undefined ? TOAST_SHOW : TOAST_SHOW_CARD;
  let used = lane.card ?? 0;
  let entries = lane.card === undefined ? 0 : 1;
  const shown = new Set<T>();
  for (const t of order) {
    if (shown.size === cap) break;
    const next = used + (entries > 0 ? LANE_GAP : 0) + t.height;
    if (next > lane.room) continue;
    shown.add(t);
    used = next;
    entries++;
  }
  return {
    show: toasts.filter((t) => shown.has(t)),
    wait: toasts.filter((t) => !shown.has(t) && t.persistent),
    drop: toasts.filter((t) => !shown.has(t) && !t.persistent),
  };
}

/**
 * Where a leaving toast (replaced by its key, dismissed, timed out) fades:
 * OUT of the lane's flow, so it holds no room — a keyed replacement never
 * stacks on top of its predecessor and pushes the lane past Layout.lane.max
 * —, pinned at its distance from the lane's bottom edge (the lane is
 * bottom-anchored, so it fades where it was while the flow closes up).
 * `lane`: the lane's height with it still in the flow; `top` / `height`: its
 * box in the lane.
 */
export function leavingBottom(lane: number, top: number, height: number): number {
  return Math.max(0, lane - top - height);
}

export interface TimerDeps {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const realTimers: TimerDeps = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface PausableTimer {
  /** a reason holds the timer ("hover", "focus") — any one of them pauses it */
  pause(reason: string): void;
  /** releases a reason; the timer runs on with what was left once none holds it */
  resume(reason: string): void;
  cancel(): void;
  /** ms left (frozen while paused) */
  remaining(): number;
}

/** a toast's lifetime that pauses on hover AND on focus-within (§5.1): the
 *  remaining time is kept, so a toast read twice never leaves early */
export function pausableTimer(ms: number, fire: () => void, deps: TimerDeps = realTimers): PausableTimer {
  let left = ms;
  let startedAt = 0;
  let handle: unknown;
  let done = false;
  const holds = new Set<string>();
  const start = (): void => {
    startedAt = deps.now();
    handle = deps.set(() => {
      done = true;
      handle = undefined;
      fire();
    }, left);
  };
  const stop = (): void => {
    if (handle === undefined) return;
    deps.clear(handle);
    handle = undefined;
    left = Math.max(0, left - (deps.now() - startedAt));
  };
  start();
  return {
    pause(reason) {
      if (done) return;
      holds.add(reason);
      stop();
    },
    resume(reason) {
      if (done || !holds.delete(reason) || holds.size > 0 || handle !== undefined) return;
      start();
    },
    cancel() {
      done = true;
      stop();
    },
    remaining: () => (handle === undefined ? left : Math.max(0, left - (deps.now() - startedAt))),
  };
}

// ── decision cards (§5.2) ───────────────────────────────────────────────────

/** the × that collapses the card into the pill — its name says what stays */
export function laterLabel(deferAs: BannerOptions["deferAs"]): string {
  return deferAs === "inactive" ? "Decide later — this copy stays read-only" : "Decide later — autosave stays paused";
}

/** what #alert says when the card could not take focus (the user is typing
 *  in the chat composer — never steal that) */
export function decisionAnnouncement(title: string, detail?: string): string {
  const body = detail?.trim();
  return body ? `${title} ${body}` : title;
}

// ── state cards (§5.3) ──────────────────────────────────────────────────────

/** the lifecycle's dead ends plus the load in progress */
export type StateCardKind = StateKind | "loading";

export interface StateCopy {
  title: string;
  /** the one help line */
  help?: string;
  /** booting / loading: a spinner beside the title */
  spinner: boolean;
  /** loading is a status; every failure an alert */
  role: "status" | "alert";
}

/** the §5.3 copy — `name` is the stem from the tool input (never "Loading…") */
export function stateCopy(card: { kind: StateCardKind; name?: string | undefined }, notationLabel: string): StateCopy {
  const name = card.name?.trim() || "the model";
  const alert = (title: string, help?: string): StateCopy => ({
    title,
    ...(help ? { help } : {}),
    spinner: false,
    role: "alert",
  });
  switch (card.kind) {
    case "booting":
      return { title: "Starting the modeler…", spinner: true, role: "status" };
    case "loading":
      return { title: `Loading ${name}…`, help: "Reading the model from designIQ", spinner: true, role: "status" };
    case "no-input":
      return alert(
        "No model received",
        "Your chat client did not send this widget its input. Open the connector in claude.ai or Claude Desktop.",
      );
    case "no-repo":
      return alert("This widget was opened without a repository", "Ask the assistant to open the model again.");
    case "bridge-failed":
      return alert("Could not connect to your chat client");
    case "read-failed":
      return alert(
        `Could not load ${name}`,
        // no guessed cause: the card shows designIQ's own reason right below
        "designIQ did not return the model. Its reason is below; try again, or open the model in designIQ.",
      );
    case "import-failed":
      return alert(`${name} could not be displayed`);
    case "renderer-failed":
      return alert(`The ${notationLabel} modeler could not start`);
    case "frozen-failed":
      return alert("This copy is inactive", "A newer widget in this chat owns this model.");
  }
}

export type StateActionId = "retry" | "open" | "ask";
export interface StateActionPlan {
  id: StateActionId;
  label: string;
  icon: "rotate-ccw" | "external-link" | "send";
  primary: boolean;
}

const RETRY = { id: "retry", label: "Try again", icon: "rotate-ccw" } as const;
const OPEN = { id: "open", label: "Open in designIQ", icon: "external-link" } as const;
const ASK = { id: "ask", label: "Ask the assistant to fix it", icon: "send" } as const;

/**
 * The actions a state card offers — at most two, exactly one primary when
 * there are any. `deepLink`: a link can be built (path known → the file
 * route, else the repo route); `message`: the host takes ui/message (Ask the
 * assistant).
 */
export function stateActionPlan(kind: StateCardKind, can: { deepLink: boolean; message: boolean }): StateActionPlan[] {
  const open = can.deepLink ? [OPEN] : [];
  let plan: Array<Omit<StateActionPlan, "primary">>;
  switch (kind) {
    case "read-failed":
      plan = [RETRY, ...open];
      break;
    case "import-failed":
      // the parser error is the user's to fix — the assistant can, when the host lets it
      plan = can.message ? [ASK, ...open] : [...open, RETRY];
      break;
    case "renderer-failed":
      plan = [RETRY];
      break;
    case "frozen-failed":
      plan = open;
      break;
    default:
      plan = [];
  }
  return plan.slice(0, 2).map((a, i) => ({ ...a, primary: i === 0 }));
}
