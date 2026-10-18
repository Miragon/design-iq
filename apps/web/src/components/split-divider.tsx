/**
 * The split view's divider between the Monaco source (left) and the canvas
 * layer (right), and the measure of the room it has. Built by hand, not
 * shadcn's Resizable: a panel group owns its panes and collapses a hidden one
 * to zero width, while the editor's two layers stay mounted at full size in
 * the single views (the engines measure their host). The divider only sets
 * where the two existing layers meet (SPLIT_PANES); it never moves them.
 *
 * A window splitter as the WAI-ARIA APG has it: role=separator named after
 * the pane it sizes (the source, the primary pane) and valued with its
 * share, the arrow keys move it, Home and End to either end, a double-click
 * puts it back in the middle. A drag follows the pointer once per frame and
 * is committed (remembered) when it ends; a press that never moved it, like
 * a key at its end, commits nothing. The pointer press keeps the focus where
 * it was, so typing in Monaco goes on after a drag. The numbers live in
 * lib/split-ratio.
 *
 * The look: a line on --border with a grip on --input, the token that holds
 * the 3:1 non-text contrast (--border does not, and is only the decoration);
 * hover, focus and a drag turn both --primary, and the focus ring is the
 * toolbar's (ui-kit focusRing), drawn around the grip.
 */
import { cn } from "@designiq/ui-kit/lib/utils";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { splitFits } from "@/lib/editor-view";
import {
  clampRatio,
  DEFAULT_RATIO,
  type DividerDrag,
  dragDivider,
  percent,
  pressDivider,
  type RatioBounds,
  ratioForKey,
} from "@/lib/split-ratio";

/**
 * Where the two layers sit in the split view, around the divider's centre at
 * `--split` (set on their container). The divider is w-2: each pane ends half
 * of it, 0.25rem, short of the centre, so neither runs under the divider and
 * Monaco's scrollbar stays whole. Width as well as left: the engine hosts
 * carry width: 100% of their own (index.css).
 */
export const SPLIT_PANES: { readonly source: CSSProperties; readonly canvas: CSSProperties } = {
  source: { width: "calc(var(--split) - 0.25rem)" },
  canvas: { left: "calc(var(--split) + 0.25rem)", width: "calc(100% - var(--split) - 0.25rem)" },
};

/** the editor area's width and whether the split view fits it, measured before the first paint and on every resize */
export function useSplitRoom(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): { width: number; rem: number; fits: boolean } {
  const [room, setRoom] = useState({ width: 0, rem: 16, fits: false });
  // a layout effect: a remembered Split is on screen in the first paint,
  // instead of the canvas alone for a frame
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const doc = el.ownerDocument;
    const rem = Number.parseFloat(doc.defaultView?.getComputedStyle(doc.documentElement).fontSize ?? "") || 16;
    const measure = (): void => {
      const width = el.getBoundingClientRect().width;
      setRoom((was) => {
        const fits = splitFits(width, rem, was.fits);
        return was.width === width && was.rem === rem && was.fits === fits ? was : { width, rem, fits };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return room;
}

export function SplitDivider({
  ratio,
  bounds,
  labels,
  controls,
  onChange,
  onCommit,
}: {
  /** the source pane's share of the width, as shown (clamped to `bounds`) */
  ratio: number;
  bounds: RatioBounds;
  /** the two panes' names, left and right (Markdown, Preview), for assistive
   *  tech: the divider is named after the left one ("Markdown source"), its
   *  value's text gives both shares */
  labels: readonly [string, string];
  /** id of the source pane, the one the value sizes */
  controls: string;
  /** the divider moved: show it there */
  onChange(ratio: number): void;
  /** a move ended (drag, key, double-click): remember it */
  onCommit(ratio: number): void;
}) {
  const [dragging, setDragging] = useState(false);
  /** the pointer drag under way (lib/split-ratio) */
  const drag = useRef<DividerDrag | null>(null);
  /** the pointer's latest x, and the frame that shows it */
  const pointerX = useRef(0);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const commit = (next: number): void => {
    onChange(next);
    onCommit(next);
  };
  /** a key or the double-click: a move that leaves the divider where it is stores nothing */
  const moveTo = (next: number): void => {
    if (next !== ratio) commit(next);
  };
  /** the drag is over: what it was, for the caller to commit if it moved */
  const release = (): DividerDrag | null => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const ended = drag.current;
    drag.current = null;
    setDragging(false);
    return ended;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    const container = e.currentTarget.parentElement;
    if (e.button !== 0 || !container) return;
    // no text selection under the drag, and the focus stays in its pane
    e.preventDefault();
    drag.current = pressDivider(e.clientX, container.getBoundingClientRect().width, ratio);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return;
    pointerX.current = e.clientX;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (!drag.current) return;
      const [next, at] = dragDivider(drag.current, pointerX.current, bounds);
      drag.current = next;
      if (at !== undefined) onChange(at);
    });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return;
    const [, at] = dragDivider(drag.current, e.clientX, bounds);
    release();
    if (at !== undefined) commit(at);
  };
  // the capture ended without a pointerup (pointercancel, the window lost
  // it): keep the divider where it was last drawn
  const onLostPointerCapture = (): void => {
    if (!drag.current) return;
    if (release()?.moved) commit(ratio);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const next = ratioForKey(e.key, ratio, bounds);
    if (next === undefined) return;
    e.preventDefault();
    moveTo(next);
  };

  const [left, right] = labels;
  const share = percent(ratio);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`${left} source`}
      aria-controls={controls}
      aria-valuenow={share}
      aria-valuemin={percent(bounds.min)}
      aria-valuemax={percent(bounds.max)}
      aria-valuetext={`${left} ${share}%, ${right} ${100 - share}%`}
      tabIndex={0}
      title="Drag to resize. Double-click to split evenly."
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={onLostPointerCapture}
      onKeyDown={onKeyDown}
      onDoubleClick={() => moveTo(clampRatio(DEFAULT_RATIO, bounds))}
      // above both layers (the focus ring around the grip reaches past the
      // gutter), under the docked side panels (z-10)
      className="group absolute inset-y-0 z-1 flex w-2 cursor-col-resize touch-none items-center justify-center outline-none select-none"
      style={{ left: "calc(var(--split) - 0.25rem)" }}
    >
      <span
        aria-hidden="true"
        className={cn(
          "bg-border absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
          "group-hover:bg-primary group-focus-visible:bg-primary group-data-dragging:bg-primary",
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "bg-input relative h-8 w-1 rounded-full transition-colors",
          "group-hover:bg-primary group-focus-visible:bg-primary group-data-dragging:bg-primary",
          "group-focus-visible:ring-ring group-focus-visible:ring-offset-background group-focus-visible:ring-2 group-focus-visible:ring-offset-2",
        )}
      />
    </div>
  );
}
