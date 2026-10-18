/**
 * The split view's divider (components/split-divider.tsx) as numbers: where
 * it may sit, and where a pointer or a key moves it. The ratio is the source
 * pane's share of the editor width. Neither pane gets narrower than
 * MIN_PANE_REM: a ratio chosen on a wide screen is clamped on a narrower one,
 * and the remembered value stays as it was chosen until the divider really
 * moves (a click on it, or a key at its end, stores nothing).
 *
 * Pure: test/split-ratio.test.ts.
 */

/** the first visit, and a double-click on the divider */
export const DEFAULT_RATIO = 0.5;
/** the narrowest a pane gets */
export const MIN_PANE_REM = 20;
/** an arrow key moves the divider by this share of the width */
export const KEY_STEP = 0.05;

export interface RatioBounds {
  min: number;
  max: number;
}

/** where the divider may sit in an editor `width` px wide (`rem` px to the rem) */
export function ratioBounds(width: number, rem: number): RatioBounds {
  const min = (MIN_PANE_REM * rem) / width;
  // no room for two panes of the minimum, or not measured yet: the middle
  if (!(min < DEFAULT_RATIO)) return { min: DEFAULT_RATIO, max: DEFAULT_RATIO };
  return { min, max: 1 - min };
}

export function clampRatio(ratio: number, bounds: RatioBounds): number {
  if (!Number.isFinite(ratio)) return clampRatio(DEFAULT_RATIO, bounds);
  return Math.min(bounds.max, Math.max(bounds.min, ratio));
}

/** the ratio under a pointer at `x`, in an editor from `left` that is `width` px wide (not clamped) */
export function ratioAt(x: number, left: number, width: number): number {
  return width > 0 ? (x - left) / width : DEFAULT_RATIO;
}

/**
 * A pointer drag of the divider. The press grabs the divider where it is
 * shown, wherever in its width the pointer hit it. Until the pointer leaves
 * the press position the drag has not moved, and gives no ratio: a plain
 * click changes nothing and stores nothing (it would store the clamped ratio
 * of a narrow window over the one chosen on a wide one).
 */
export interface DividerDrag {
  /** the editor's left edge, moved by where in the divider the press grabbed it */
  readonly left: number;
  readonly width: number;
  readonly pressX: number;
  /** the pointer has left the press position */
  readonly moved: boolean;
}

/** a press at `x` on the divider showing `ratio`, in an editor `width` px wide */
export function pressDivider(x: number, width: number, ratio: number): DividerDrag {
  return { left: x - ratio * width, width, pressX: x, moved: false };
}

/** the drag with the pointer at `x`, and where that puts the divider (clamped); no ratio while it has not moved */
export function dragDivider(drag: DividerDrag, x: number, bounds: RatioBounds): [DividerDrag, number | undefined] {
  if (!drag.moved && x === drag.pressX) return [drag, undefined];
  return [drag.moved ? drag : { ...drag, moved: true }, clampRatio(ratioAt(x, drag.left, drag.width), bounds)];
}

/** the ratio a key moves the divider to (the window splitter keys of the WAI-ARIA APG), undefined for any other key */
export function ratioForKey(key: string, ratio: number, bounds: RatioBounds): number | undefined {
  switch (key) {
    case "ArrowLeft":
      return clampRatio(ratio - KEY_STEP, bounds);
    case "ArrowRight":
      return clampRatio(ratio + KEY_STEP, bounds);
    case "Home":
      return bounds.min;
    case "End":
      return bounds.max;
    default:
      return undefined;
  }
}

/** a ratio as the divider announces it: whole percent */
export const percent = (ratio: number): number => Math.round(ratio * 100);
