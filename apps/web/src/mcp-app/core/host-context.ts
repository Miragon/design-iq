/**
 * The host context as the widget reads it (spec §2.6) — pure, so node --test
 * pins the rules chrome/host.ts applies:
 *
 *  - The connect read is the whole getHostContext(); every later
 *    `hostcontextchanged` is a PARTIAL update — only the keys it carries
 *    change. Reading the merged getHostContext() instead would let a later
 *    unrelated update (a resize) revert a display mode that only the
 *    requestDisplayMode RESULT reported (a host need not echo it as a
 *    context change).
 *  - `theme` and `styles` are ignored: one light mode.
 *  - The inline height is declared ONCE after connect (480 from 600px wide,
 *    420 below, capped by maxHeight; never when the host fixes the height,
 *    never outside inline) and again only when the width class flips or the
 *    widget returns to inline — never on a state change.
 */
import type { Insets } from "./engine.ts";
import { COMPACT_W, type DisplayMode, inlineHeightFor } from "./layout.ts";

/** the host context as merged so far (theme and styles are ignored: one light mode) */
export interface HostState {
  displayMode: DisplayMode;
  availableDisplayModes: DisplayMode[];
  /** hostContext.containerDimensions, flattened (height = fixed by the host) */
  container: { width?: number; height?: number; maxWidth?: number; maxHeight?: number };
  safeArea: Insets;
  touch: boolean;
  hover: boolean;
  platform?: "web" | "desktop" | "mobile";
  locale?: string;
  timeZone?: string;
  /** getHostCapabilities().message — "Ask the assistant", Implement */
  message: boolean;
}

/** the McpUiHostContext fields the widget reads — structural, so the pure
 *  module never imports the SDK */
export interface HostContextLike {
  displayMode?: string;
  availableDisplayModes?: string[];
  containerDimensions?: { width?: number; height?: number; maxWidth?: number; maxHeight?: number };
  safeAreaInsets?: Partial<Insets>;
  deviceCapabilities?: { touch?: boolean; hover?: boolean };
  platform?: string;
  locale?: string;
  timeZone?: string;
}

const MODES: readonly DisplayMode[] = ["inline", "fullscreen", "pip"];
const isMode = (m: unknown): m is DisplayMode => MODES.includes(m as DisplayMode);
const PLATFORMS = ["web", "desktop", "mobile"] as const;
const finite = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) ? n : undefined);

/** before connect: inline, nothing offered beyond it, no safe area */
export function initialHostState(device: { touch: boolean; hover: boolean }): HostState {
  return {
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    container: {},
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    touch: device.touch,
    hover: device.hover,
    message: false,
  };
}

/**
 * `prev` with the keys `ctx` carries applied. containerDimensions and
 * safeAreaInsets arrive whole (the protocol sends the changed field, not a
 * deep diff), the dimensions reset with a display-mode change that brings
 * none; deviceCapabilities per flag. Values the protocol does not
 * define (an unknown display mode, a negative inset) are dropped, never
 * guessed.
 */
export function mergeHostContext(prev: HostState, ctx: HostContextLike | undefined): HostState {
  if (!ctx) return prev;
  const next: HostState = { ...prev };
  if (isMode(ctx.displayMode)) next.displayMode = ctx.displayMode;
  if (Array.isArray(ctx.availableDisplayModes)) next.availableDisplayModes = ctx.availableDisplayModes.filter(isMode);
  // the dimensions describe ONE display mode: a mode change that brings none
  // leaves them unknown — fullscreen's fixed height must never read as a
  // host-fixed inline height (no declaration on the return to inline)
  if (isMode(ctx.displayMode) && ctx.displayMode !== prev.displayMode && !ctx.containerDimensions) next.container = {};
  if (ctx.containerDimensions) {
    const d = ctx.containerDimensions;
    const container: HostState["container"] = {};
    for (const key of ["width", "height", "maxWidth", "maxHeight"] as const) {
      const v = finite(d[key]);
      if (v !== undefined && v > 0) container[key] = v;
    }
    next.container = container;
  }
  if (ctx.safeAreaInsets) {
    const s = ctx.safeAreaInsets;
    const side = (v: unknown): number => Math.max(0, finite(v) ?? 0);
    next.safeArea = { top: side(s.top), right: side(s.right), bottom: side(s.bottom), left: side(s.left) };
  }
  if (typeof ctx.deviceCapabilities?.touch === "boolean") next.touch = ctx.deviceCapabilities.touch;
  if (typeof ctx.deviceCapabilities?.hover === "boolean") next.hover = ctx.deviceCapabilities.hover;
  const platform = PLATFORMS.find((p) => p === ctx.platform);
  if (platform) next.platform = platform;
  if (typeof ctx.locale === "string" && ctx.locale) next.locale = ctx.locale;
  if (typeof ctx.timeZone === "string" && ctx.timeZone) next.timeZone = ctx.timeZone;
  return next;
}

/** structural equality — a no-op update (the host re-sending what it sent) notifies nobody */
export function sameHostState(a: HostState, b: HostState): boolean {
  const c1 = a.container;
  const c2 = b.container;
  return (
    a.displayMode === b.displayMode &&
    a.availableDisplayModes.join() === b.availableDisplayModes.join() &&
    c1.width === c2.width &&
    c1.height === c2.height &&
    c1.maxWidth === c2.maxWidth &&
    c1.maxHeight === c2.maxHeight &&
    a.safeArea.top === b.safeArea.top &&
    a.safeArea.right === b.safeArea.right &&
    a.safeArea.bottom === b.safeArea.bottom &&
    a.safeArea.left === b.safeArea.left &&
    a.touch === b.touch &&
    a.hover === b.hover &&
    a.platform === b.platform &&
    a.locale === b.locale &&
    a.timeZone === b.timeZone &&
    a.message === b.message
  );
}

/** which side of 600px the frame is on — the only change that re-declares the height */
export type WidthClass = "wide" | "narrow";

export interface HeightPlan {
  /** the height to send now (sendSizeChanged), or null */
  send: number | null;
  /** the class now declared; undefined = the next inline frame declares again */
  declared: WidthClass | undefined;
}

/**
 * The inline-height state machine. `declared` is the class the last SENT
 * height was for. A frame that has no width yet (not laid out) decides
 * nothing; leaving inline forgets the declaration (the return re-declares);
 * a host-fixed height sends nothing and keeps nothing declared, so a later
 * un-fixing still declares.
 */
export function planInlineHeight(
  declared: WidthClass | undefined,
  W: number,
  state: Pick<HostState, "displayMode" | "container">,
): HeightPlan {
  if (state.displayMode !== "inline") return { send: null, declared: undefined };
  if (!(W > 0)) return { send: null, declared };
  const cls: WidthClass = W >= COMPACT_W ? "wide" : "narrow";
  if (cls === declared) return { send: null, declared };
  const height = inlineHeightFor(W, "inline", state.container);
  return height === null ? { send: null, declared: undefined } : { send: height, declared: cls };
}
