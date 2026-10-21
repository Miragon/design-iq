/**
 * The layout calculator (spec §2): the frame size, display mode and the
 * MEASURED corner-cluster widths in → the insets, compact mode, the degrade
 * step, where the renderer palette lives, the panel shape, the fit insets and
 * the one inline height the widget declares. No fixed label breakpoints: the
 * first step at which `TL + TR + 16 ≤ W − insetLeft − insetRight` wins (steps
 * are cumulative, chrome/layout-dom.ts measures each one).
 *
 *   step 0  everything labelled
 *   step 1  the comet in the trigger hides
 *   step 2  "Open in designIQ" → "Open"
 *   step 3  Workshop → compact chip (menu-only while OFF); DMN switch → icons
 *   step 4  the panel toggle drops its label (icon + count/verdict)
 *   step 5  "Open" → icon-only
 *   step 6  the name truncates against the actual remaining width (min 72)
 *   step 7  the Workshop chip (even ON) and the DMN switch go — menu-only
 *   step 8  the fullscreen button goes — menu-only
 *   step 9  the trigger is the menu icon alone (the name stays in its
 *           aria-label, title and the menu header)
 * Steps 7–9 drop only what the menu offers too: a phone-width chat column
 * (360–430px) keeps every control reachable and the clusters apart.
 *
 * The lane (toasts, decision cards) never overlaps an open panel (WCAG
 * 2.4.11: no focused control in a panel sits under a toast). Beside an open
 * card it is centred in the canvas column the card leaves; a card is never
 * shrunk for it. Where that column would be narrower than LANE_MIN the panel
 * opens as a sheet instead, and a sheet ends above the lane (chrome.css:
 * its bottom rides --lane-h, laneHold) — the lane keeps its place, the
 * sheet's head never moves, and the control that kept the focus scrolls back
 * into view (inView, revealDelta, visibleView). A decision card over a sheet
 * folds it to its head until the card is answered or deferred (sheetFolds).
 *
 * The lane is bounded (spec §5.1): it never reaches the corner row nor an
 * open sheet's head (Layout.lane.max), and its toasts never take a sheet's
 * usable body (Layout.lane.room) — core/feedback.ts planLane decides which
 * toasts fit.
 *
 * Pure: chrome/layout-dom.ts measures and applies, node --test drives this.
 */
import type { Insets } from "./engine.ts";

export type WidgetKind = "bpmn" | "dmn" | "miragon";
export type DisplayMode = "inline" | "fullscreen" | "pip";
export type PaletteMode = "column" | "tier1" | "tier2" | "tools" | "none";

export const INSET_INLINE = 12;
export const INSET_FULLSCREEN = 16;
/** corner control height */
export const CORNER_H = 36;
/** bottom-row control height (pill, zoom group) */
export const BOTTOM_H = 32;
/** the minimum gap between the TL and TR clusters — the degrade trigger */
export const MIN_GAP = 16;
export const MAX_STEP = 9;
/** from this step the name truncates against the actual remaining width … */
export const NAME_STEP = 6;
/** … until this one drops it (the trigger is the menu icon alone) */
export const ICON_STEP = 9;
/** the truncation never squeezes the name below this */
export const NAME_MIN = 72;
export const PANEL_W = 320;
export const PANEL_W_WIDE = 360;
/** the inline frame from this width on gets 360px panels */
export const PANEL_WIDE_FROM = 960;
/** the toast lane: bottom-centre, min(460, W − 2I) wide (§5.1) */
export const LANE_W = 460;
/**
 * The narrowest lane a toast and a decision card stay readable in — measured
 * in the widget (Geist 13px) with the widest decision card, the CAS conflict
 * (three choices, a consequence line each), and the "Autosave failed" toast
 * with Retry now: at 240 the choice grid overflows its card and the toast's
 * title wraps; at 260–280 the consequence lines wrap word by word (up to 5
 * lines, the card 327–343px tall); at 300 a consequence takes at most 4
 * lines and the toast's title one (the card 294px, the toast 132px; 243 /
 * 114 at 320, 191 / 80 at 460). A card leaving the lane less canvas than
 * this opens as a sheet.
 */
export const LANE_MIN = 300;
/** between an open card and what sits beside it: the fit, the DMN table, the lane */
export const CARD_GAP = 12;
/** between the lane's entries, and between the lane and a sheet ending above it (chrome.css) */
export const LANE_GAP = 8;
/** a sheet's head (48 + its borders) — the lane never covers it */
export const SHEET_HEAD = 50;
/**
 * The body a sheet keeps under its head against toasts — about two Todos
 * rows or Checks sections, enough to read and Tab through; a sheet with less
 * content keeps all of it. A decision card folds the sheet instead
 * (sheetFolds, spec §7).
 */
export const SHEET_BODY = 120;
/** compact below either */
export const COMPACT_W = 600;
export const COMPACT_H = 440;
export const INLINE_H = 480;
export const INLINE_H_NARROW = 420;
/** the bpmn.io watermark: bottom 15, right 15, 53 wide — the zoom group docks
 *  beside it at right 80, never on it (licence) */
export const WATERMARK_RIGHT = 80;

export interface LayoutInput {
  /** the iframe's inner size */
  W: number;
  H: number;
  displayMode: DisplayMode;
  /** hostContext.safeAreaInsets */
  safeArea?: Partial<Insets>;
  kind: WidgetKind;
  /** dmn: the table view has no viewport and no palette; else "diagram" */
  view?: "diagram" | "table";
  /** a viewer (read-only boot, or the superseded freeze): no palette, no Tools */
  readonly?: boolean;
  /**
   * The TL and TR cluster widths at every degrade step, index = step (0…9),
   * measured with compact mode already applied and the name untruncated. A
   * shorter array repeats its last entry.
   */
  steps: { tl: number[]; tr: number[] };
  /** the name's natural width inside the trigger (steps 6–8 truncate it) */
  nameWidth?: number;
  /** the renderer palette at its natural size; 0×0 when there is none */
  palette: { w: number; h: number };
  /** a Todos / Checks panel is open */
  panelOpen: boolean;
  /** hostContext.containerDimensions — decides the inline height */
  container?: { height?: number; maxHeight?: number };
}

export interface Layout {
  /** the base inset: 12 inline, 16 fullscreen */
  base: number;
  /** per side: base + the safe area */
  inset: Insets;
  compact: boolean;
  /** the degrade step applied (0…9) */
  step: number;
  /** the gap left between TL and TR at that step, the name truncation counted
   *  (below MIN_GAP only when even step 9 overflows: a frame under ~300px) */
  gap: number;
  paletteMode: PaletteMode;
  /** a card at the right; a full-width sheet when compact, or when a card
   *  would leave the lane less than LANE_MIN of canvas beside it */
  panel: { mode: "card" | "sheet"; width: number };
  /**
   * The lane (px). `left` / `width`: centred in the frame, or in the canvas
   * column beside an open card — never over it; a sheet ends above the lane
   * instead (chrome.css, --lane-h). `max`: its height never reaches the
   * corner row, nor over an open sheet its head (the lane's max-height, and
   * a decision card's). `room`: what its toasts may fill, a decision card
   * counted — `max`, less the sheet's usable body (SHEET_BODY) while a sheet
   * is open (feedback.ts planLane).
   */
  lane: { left: number; width: number; max: number; room: number };
  /** top of everything under the corner row: the left palette, panels, the Miragon tier-2 palette */
  underRow: number;
  /** a panel's top: under the row, or under a tier-2 palette it would cover */
  panelTop: number;
  /** bottom of the lane (toasts, decision cards) and of the panels */
  laneBottom: number;
  /** the zoom group's right offset (beside the bpmn.io watermark, or the inset) */
  zoomRight: number;
  /** the fit target inside the frame (engines/fit.ts) */
  fitInsets: Insets;
  /** dmn table view: the container's right padding (keeps every column reachable under a card) */
  tableRight: number;
  showZoomPct: boolean;
  /** steps 6–8: the name's max width in px; null = no truncation needed */
  nameMax: number | null;
  /** the ONE inline height to declare (sendSizeChanged); null = never (fixed by the host, or not inline) */
  inlineHeight: number | null;
}

/** compact = width < 600 OR height < 440 OR picture-in-picture */
export function isCompact(W: number, H: number, displayMode: DisplayMode): boolean {
  return W < COMPACT_W || H < COMPACT_H || displayMode === "pip";
}

/** declared once after connect: 480 from 600px wide, else 420 — capped by
 *  the host's maxHeight; never when the host fixes the height, never fullscreen */
export function inlineHeightFor(
  W: number,
  displayMode: DisplayMode,
  container?: { height?: number; maxHeight?: number },
): number | null {
  if (displayMode !== "inline" || container?.height !== undefined) return null;
  const wanted = W >= COMPACT_W ? INLINE_H : INLINE_H_NARROW;
  return container?.maxHeight !== undefined ? Math.min(wanted, container.maxHeight) : wanted;
}

const at = (list: number[], i: number): number => list[Math.min(i, list.length - 1)] ?? 0;

/** per side: 12 inline / 16 fullscreen, plus the host's safe area */
export function insetsFor(displayMode: DisplayMode, safe: Partial<Insets> = {}): Insets {
  const base = displayMode === "fullscreen" ? INSET_FULLSCREEN : INSET_INLINE;
  return {
    top: base + (safe.top ?? 0),
    right: base + (safe.right ?? 0),
    bottom: base + (safe.bottom ?? 0),
    left: base + (safe.left ?? 0),
  };
}

/** the gap the clusters keep at `step`, from widths measured with the name
 *  untruncated: steps 6–8 win back up to everything above NAME_MIN */
export function gapAt(step: number, avail: number, tl: number, tr: number, nameWidth = 0): number {
  const raw = avail - tl - tr;
  if (step < NAME_STEP || step >= ICON_STEP || raw >= MIN_GAP) return raw;
  return raw + Math.min(MIN_GAP - raw, Math.max(0, nameWidth - NAME_MIN));
}

/** the clusters keep MIN_GAP between them — the degrade's one test (the
 *  measuring loop of chrome/layout-dom.ts stops on it too) */
export const fits = (gap: number): boolean => gap >= MIN_GAP;

/** the first degrade step at which the clusters keep MIN_GAP between them */
export function degradeStep(
  avail: number,
  steps: { tl: number[]; tr: number[] },
  nameWidth = 0,
): { step: number; gap: number } {
  let gap = 0;
  for (let step = 0; step <= MAX_STEP; step++) {
    gap = gapAt(step, avail, at(steps.tl, step), at(steps.tr, step), nameWidth);
    if (fits(gap)) return { step, gap };
  }
  return { step: MAX_STEP, gap };
}

export function computeLayout(input: LayoutInput): Layout {
  const { W, H, displayMode, kind } = input;
  const base = displayMode === "fullscreen" ? INSET_FULLSCREEN : INSET_INLINE;
  const safe = input.safeArea ?? {};
  const inset = insetsFor(displayMode, safe);
  const compact = isCompact(W, H, displayMode);
  const avail = W - inset.left - inset.right;
  const { step, gap } = degradeStep(avail, input.steps, input.nameWidth);

  // steps 6–8: the name gives up exactly what still overflows, never below 72
  let nameMax: number | null = null;
  if (step >= NAME_STEP && step < ICON_STEP && input.nameWidth !== undefined) {
    const raw = avail - at(input.steps.tl, step) - at(input.steps.tr, step);
    if (!fits(raw)) nameMax = Math.max(NAME_MIN, Math.floor(input.nameWidth - (MIN_GAP - raw)));
  }

  const tableView = kind === "dmn" && input.view === "table";
  const hasPalette = !input.readonly && !tableView && input.palette.w > 0;
  const tlAtStep = at(input.steps.tl, step);
  const trAtStep = at(input.steps.tr, step);
  let paletteMode: PaletteMode = "none";
  if (hasPalette) {
    if (compact) paletteMode = "tools";
    else if (kind !== "miragon") paletteMode = "column";
    else {
      // centred in the top row, clear of both clusters by MIN_GAP
      const left = W / 2 - input.palette.w / 2;
      const right = W / 2 + input.palette.w / 2;
      const fits = left >= inset.left + tlAtStep + MIN_GAP && right <= W - inset.right - trAtStep - MIN_GAP;
      paletteMode = fits ? "tier1" : "tier2";
    }
  }

  const panelWidth = displayMode === "fullscreen" || W >= PANEL_WIDE_FROM ? PANEL_W_WIDE : PANEL_W;
  // the canvas column a card leaves the lane: from the left inset to the card's gap
  const besideCard = avail - panelWidth - CARD_GAP;
  const panel =
    compact || besideCard < LANE_MIN
      ? { mode: "sheet" as const, width: avail }
      : { mode: "card" as const, width: panelWidth };
  const cardOpen = input.panelOpen && panel.mode === "card";
  const sheetOpen = input.panelOpen && panel.mode === "sheet";
  const underRow = inset.top + CORNER_H + 8;
  // a panel at the right would cover the end of a palette centred in the
  // second row (the context map's Legend at 720): it starts under it instead
  const panelTop = paletteMode === "tier2" ? underRow + input.palette.h + 8 : underRow;
  const laneBottom = inset.bottom + BOTTOM_H + 12;
  const laneColumn = cardOpen ? besideCard : avail;
  const laneWidth = Math.min(LANE_W, laneColumn);
  // from the bottom row up to the corner row — over a sheet, up to its head
  const laneMax = Math.max(0, H - laneBottom - (sheetOpen ? panelTop + SHEET_HEAD + LANE_GAP : underRow));
  const lane = {
    left: inset.left + (laneColumn - laneWidth) / 2,
    width: laneWidth,
    max: laneMax,
    room: Math.max(0, laneMax - (sheetOpen ? SHEET_BODY : 0)),
  };

  let top = inset.top + CORNER_H + 12;
  if (paletteMode === "tier2") top += input.palette.h + 8;
  // a tier-1 palette taller than the row pushes the fit down by its own height
  if (paletteMode === "tier1") top = Math.max(top, inset.top + input.palette.h + 12);
  const fitInsets: Insets = {
    top,
    left: paletteMode === "column" ? inset.left + input.palette.w + 16 : 16,
    right: cardOpen ? panel.width + inset.right + CARD_GAP : 16,
    bottom: inset.bottom + BOTTOM_H + 12,
  };

  return {
    base,
    inset,
    compact,
    step,
    gap,
    paletteMode,
    panel,
    lane,
    underRow,
    panelTop,
    laneBottom,
    zoomRight: kind === "miragon" ? inset.right : WATERMARK_RIGHT + (safe.right ?? 0),
    fitInsets,
    tableRight: cardOpen ? panel.width + inset.right + CARD_GAP : inset.right,
    showZoomPct: !compact,
    nameMax,
    inlineHeight: inlineHeightFor(W, displayMode, input.container),
  };
}

// ── what chrome/layout-dom.ts does with a new layout ────────────────────────

export type Refit = "force" | "untouched" | "none";

export interface RefitInput {
  /** host displayMode differs from the last judged layout's */
  modeChanged: boolean;
  /** the frame's size differs from the last judged layout's */
  resized: boolean;
  /** the fit insets moved (a panel, the palette, the corner row) */
  insetsChanged: boolean;
}

/**
 * When the view re-fits (spec §2.5): a display-mode change ALWAYS (and resets
 * touched — "inline zoom in the corner after fullscreen"); a resize or moved
 * insets only while the user has not moved the view. The host's resizes that
 * settle a mode change need no force of their own: the forced fit left the
 * view untouched, and what diagram-js scrolls on a resize is never counted as
 * a touch (engines/diagram-js.ts) — so a move the user makes meanwhile wins.
 */
export function planRefit(i: RefitInput): Refit {
  if (i.modeChanged) return "force";
  if (i.resized || i.insetsChanged) return "untouched";
  return "none";
}

/** the renderer palette's open state per slot: always open at its slot,
 *  behind Tools only while Tools is pressed; undefined = nothing to drive */
export function paletteShouldOpen(mode: PaletteMode, toolsOpen: boolean): boolean | undefined {
  if (mode === "none") return undefined;
  return mode === "tools" ? toolsOpen : true;
}

/**
 * The palette size the calculator gets. Measured while it is visible; hidden
 * (behind Tools, or a state card) it keeps its last natural size; a palette
 * that exists but was never seen — the widget booted compact — counts as
 * present (1×1): compact mode needs no size, and the first visible frame
 * measures the real one.
 */
export function paletteForLayout(
  present: boolean,
  measured: { w: number; h: number },
  last: { w: number; h: number },
): { w: number; h: number } {
  if (!present) return { w: 0, h: 0 };
  if (measured.w > 0) return measured;
  if (last.w > 0) return last;
  return { w: 1, h: 1 };
}

/**
 * A decision card over a sheet (spec §7): while the card shows, the sheet
 * folds to its head — its body hidden, out of the tab order — and unfolds at
 * its scroll position once the card is answered or deferred (chrome/panel.ts
 * fold). The card is what the user owes, and a body squeezed under it would
 * clip its filter row, its form, its foot. A card beside a CARD-mode panel
 * changes nothing: the lane passes beside it.
 */
export function sheetFolds(panel: Layout["panel"]["mode"], deciding: boolean): boolean {
  return panel === "sheet" && deciding;
}

/**
 * What the lane holds, as a sheet ends above it (chrome.css: bottom L +
 * --lane-h): the height of its entries in the flow, plus the LANE_GAP to the
 * sheet — 0 when none is. A leaving toast is out of the flow (it fades where
 * it was, feedback.ts leavingBottom) and holds nothing.
 */
export function laneHold(entries: number, height: number): number {
  return entries > 0 ? height + LANE_GAP : 0;
}

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * The part of a panel's scroller the user can see (spec §7): its viewport,
 * ending LANE_GAP above the lane wherever the lane spans it. A sheet already
 * ends there (--lane-h); this also holds in the frame where the lane grew and
 * the sheet has not followed yet. `lane`: the box of its entries in the flow,
 * absent while it holds none. Beside a card the lane spans no scroller.
 */
export function visibleView(scroller: Box, lane?: Box): { top: number; bottom: number } {
  const spans =
    lane !== undefined && lane.left < scroller.right && lane.right > scroller.left && lane.top < scroller.bottom;
  const bottom = spans ? Math.max(scroller.top, Math.min(scroller.bottom, lane.top - LANE_GAP)) : scroller.bottom;
  return { top: scroller.top, bottom };
}

/**
 * The focused control shows in its scroller — more than `tolerance` px of it
 * inside the viewport. An intersection, not containment: Chrome leaves a
 * Tab-focused control a fraction of a pixel past the scroller's edge (0.39px
 * in a 600–655 wide sheet), and that control is in view all the same. The
 * sheet follows such a control when it ends higher (chrome/layout-dom.ts); a
 * control the user scrolled away from stays where it is.
 */
export function inView(
  target: { top: number; bottom: number },
  view: { top: number; bottom: number },
  tolerance = 1,
): boolean {
  return target.bottom > view.top + tolerance && target.top < view.bottom - tolerance;
}

/**
 * How far a scroller must scroll so `target` — the focused control's WHOLE
 * border box — lies in its viewport, `margin` to spare; 0 when it already
 * does; a target taller than the viewport aligns its top. chrome/layout-dom.ts
 * runs it on every focus inside a panel's scroller (Chrome reveals only a
 * textarea's caret line, and nothing of a control whose caret shows) and when
 * a sheet ends above an arriving toast, moving the scroller only — never the
 * frame.
 */
export function revealDelta(
  target: { top: number; bottom: number },
  view: { top: number; bottom: number },
  margin = 8,
): number {
  if (target.top < view.top) return target.top - view.top - margin;
  if (target.bottom > view.bottom) return Math.min(target.bottom - view.bottom + margin, target.top - view.top);
  return 0;
}

export const sameInsets = (a: Insets, b: Insets): boolean =>
  a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
