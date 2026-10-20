/**
 * The layout calculator (core/layout.ts) applied to the DOM (spec §2): it
 * MEASURES the TL and TR clusters at each degrade step, writes the CSS
 * contract (chrome.css header: data attributes + px custom properties on
 * #app), owns the Tools button and the renderer palette's open state, and
 * drives the re-fit.
 *
 * Measuring: clones of #tl / #tr in a hidden host AFTER #app in <body> — the
 * live clusters are display:none under a state card and carry the step-6
 * name cap, the clones carry neither; outside #app no subtree observer on
 * the widget ever sees them. They exist only for the synchronous read (ids
 * included, so id rules still apply; getElementById finds the live #app
 * copy first). Steps are measured until one fits — a wide frame costs one
 * reflow.
 *
 * Re-measured (one rAF later) when the frame, a cluster (a name, a toggle,
 * the chip, a font swap) or the palette (built, two columns, Workshop's
 * sticky tool) changes size, when the host context changes, and when the
 * view gains or loses its viewport (the DMN table). Never per viewbox move.
 *
 * Re-fit (core/layout.ts planRefit): a display-mode change always; a resize
 * or moved insets (a panel card opening) only while the user has not moved
 * the view; animated unless reduced motion.
 *
 * Plus the lane (toasts, decision cards), which never overlaps an open
 * panel (WCAG 2.4.11): its place comes with the layout (--lane-left /
 * --lane-w: centred in the frame, or in the canvas column beside an open
 * card), its bound too (--lane-max: never up to the corner row, nor over a
 * sheet's head; a changed place or room, or the panel turning card / sheet,
 * is an onLane — the toasts re-plan, a sheet under a decision card folds),
 * and what its entries in the flow hold is --lane-h (laneHold: a leaving
 * toast holds nothing) — a sheet ends that much higher. A control in the
 * sheet that had the focus and showed (inView: an intersection, so the
 * sub-pixel a Tab focus leaves past the edge still counts) stays in view:
 * its scroller follows when the sheet ends higher (never the frame). And
 * every focus inside a panel's scroller shows the whole control, never
 * under the lane (visibleView, revealDelta) — a pointer's once its press,
 * and so its click, is over.
 */
import type { Insets, ViewControls } from "../core/engine.ts";
import {
  type Box,
  computeLayout,
  type DisplayMode,
  fits,
  gapAt,
  insetsFor,
  inView,
  isCompact,
  laneHold,
  type Layout,
  MAX_STEP,
  paletteForLayout,
  paletteShouldOpen,
  planRefit,
  revealDelta,
  sameInsets,
  visibleView,
} from "../core/layout.ts";
import type { MountLayout } from "./contracts.ts";

const sameLayout = (a: Layout, b: Layout): boolean => JSON.stringify(a) === JSON.stringify(b);
const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const mountLayout: MountLayout = (deps) => {
  const { els } = deps;
  let applied: Layout | undefined;
  let size = { w: 0, h: 0 };
  let mode: DisplayMode | undefined;
  /** the fit insets the last update() judged — apart from `applied`: a
   *  current() read in between (an import fit, a panel listener) commits the
   *  new layout, and must not swallow the re-fit its change calls for */
  let judged: Insets | undefined;
  /** the palette's last NATURAL size — hidden behind Tools it measures 0×0 */
  let lastPalette = { w: 0, h: 0 };
  let toolsOpen = false;
  let frame = 0;
  let updating = false;

  // ── measuring ──
  const measureHost = document.createElement("div");
  measureHost.className = "measure";
  measureHost.setAttribute("aria-hidden", "true");
  measureHost.inert = true;
  document.body.append(measureHost);

  /** the clone of `src`, and the clone of `inner` in it (same tree position) */
  function cloneWith(src: HTMLElement, ...inner: HTMLElement[]): [HTMLElement, ...Array<HTMLElement | undefined>] {
    const clone = src.cloneNode(true) as HTMLElement;
    const from = [...src.querySelectorAll("*")];
    const to = [...clone.querySelectorAll<HTMLElement>("*")];
    return [clone, ...inner.map((el) => to[from.indexOf(el)])];
  }

  function measure(): Layout {
    const host = deps.host.state();
    const view = deps.view();
    const readonly = deps.readonly();
    const W = els.app.clientWidth;
    const H = els.app.clientHeight;
    const table = deps.kind === "dmn" && view !== undefined && !view.hasViewport();
    const present = view?.palette !== undefined && !readonly && !table;
    const measured = present ? view.palette!.size() : { w: 0, h: 0 };
    if (measured.w > 0) lastPalette = measured;
    const palette = paletteForLayout(present, measured, lastPalette);
    const compact = isCompact(W, H, host.displayMode);

    const [tl, tools, name] = cloneWith(els.tl, els.tools, els.docName);
    const [tr] = cloneWith(els.tr);
    // Tools as compact mode will show it (its live copy follows the applied layout)
    if (tools) tools.hidden = !(compact && present);
    measureHost.replaceChildren(tl, tr);
    const inset = insetsFor(host.displayMode, host.safeArea);
    const avail = W - inset.left - inset.right;
    // the name's natural width — before step 9 drops it from the clone
    tl.dataset.step = "0";
    const nameWidth = name?.scrollWidth ?? 0;
    const steps: { tl: number[]; tr: number[] } = { tl: [], tr: [] };
    for (let step = 0; step <= MAX_STEP; step++) {
      tl.dataset.step = String(step);
      tr.dataset.step = String(step);
      steps.tl.push(tl.offsetWidth);
      steps.tr.push(tr.offsetWidth);
      if (fits(gapAt(step, avail, steps.tl[step]!, steps.tr[step]!, nameWidth))) break;
    }
    measureHost.replaceChildren();

    return computeLayout({
      W,
      H,
      displayMode: host.displayMode,
      safeArea: host.safeArea,
      kind: deps.kind,
      view: table ? "table" : "diagram",
      readonly,
      steps,
      nameWidth,
      palette,
      panelOpen: deps.panelOpen(),
      container: host.container,
    });
  }

  // ── applying ──
  let paletteEl: HTMLElement | null = null;
  const paletteResizes = new ResizeObserver(() => schedule());

  function apply(l: Layout): void {
    const a = els.app;
    a.dataset.display = deps.host.state().displayMode;
    a.toggleAttribute("data-compact", l.compact);
    a.dataset.palette = l.paletteMode;
    a.dataset.panel = l.panel.mode;
    els.tl.dataset.step = String(l.step);
    els.tr.dataset.step = String(l.step);
    els.tools.hidden = l.paletteMode !== "tools";
    els.zoomPct.hidden = !l.showZoomPct;
    const px = (n: number): string => `${n}px`;
    const vars: Array<[string, number]> = [
      ["--inset-t", l.inset.top],
      ["--inset-r", l.inset.right],
      ["--inset-b", l.inset.bottom],
      ["--inset-l", l.inset.left],
      ["--under-row", l.underRow],
      ["--lane-bottom", l.laneBottom],
      ["--panel-w", l.panel.width],
      ["--lane-left", l.lane.left],
      ["--lane-w", l.lane.width],
      ["--lane-max", l.lane.max],
      ["--zoom-right", l.zoomRight],
      ["--table-right", l.tableRight],
    ];
    for (const [k, v] of vars) a.style.setProperty(k, px(v));
    if (l.nameMax === null) a.style.removeProperty("--name-max");
    else a.style.setProperty("--name-max", px(l.nameMax));
    applyTools(l);
  }

  /** Tools pressed or not — no layout change of its own, so applied apart */
  function applyTools(l: Layout): void {
    if (l.paletteMode !== "tools") toolsOpen = false;
    els.app.toggleAttribute("data-palette-open", toolsOpen);
    els.tools.setAttribute("aria-expanded", String(toolsOpen));
    // diagram-js keeps its own open state: open at its slot, closed behind Tools
    const palette = deps.view()?.palette;
    const open = paletteShouldOpen(l.paletteMode, toolsOpen);
    if (palette && open !== undefined && palette.isOpen() !== open) {
      if (open) palette.open();
      else palette.close();
    }
  }

  function commit(next: Layout): void {
    if (applied && sameLayout(applied, next)) return applyTools(next);
    const before = applied;
    apply(next);
    applied = next;
    // the toasts re-plan against the new room (a sheet opened, a resize), and
    // a sheet under a decision card folds (a card turned sheet, or back)
    const laneMoved = before && JSON.stringify(before.lane) !== JSON.stringify(next.lane);
    if (laneMoved || (before && before.panel.mode !== next.panel.mode)) deps.onLane?.();
  }

  // ── re-fit ──
  /** animated (250 ms, --cd-ease) unless reduced motion */
  function fitWith(insets: Insets, force: boolean): void {
    const view = deps.view();
    if (!view?.hasViewport()) return;
    if (!force && view.isTouched()) return;
    view.fit(insets, !reducedMotion());
  }

  // ── what is observed ──
  let boundView: ViewControls | undefined;
  let offView: (() => void) | undefined;
  let hadViewport: boolean | undefined;
  /** follow the mounted view (the superseded remount swaps it) and its palette element */
  function bind(): void {
    const view = deps.view();
    if (view !== boundView) {
      offView?.();
      boundView = view;
      hadViewport = view?.hasViewport();
      // only the viewport appearing / going (the DMN table) re-lays out — a pan does not
      offView = view?.onChange(() => {
        if (view.hasViewport() !== hadViewport) schedule();
      });
    }
    const el = view?.palette ? els.canvas.querySelector<HTMLElement>(".djs-palette") : null;
    if (el !== paletteEl) {
      if (paletteEl) paletteResizes.unobserve(paletteEl);
      paletteEl = el;
      if (el) {
        paletteResizes.observe(el);
        el.id ||= "palette";
        els.tools.setAttribute("aria-controls", el.id);
      } else els.tools.removeAttribute("aria-controls");
    }
  }

  function update(): void {
    if (updating) return schedule();
    updating = true;
    try {
      cancelAnimationFrame(frame);
      frame = 0;
      bind();
      hadViewport = boundView?.hasViewport();
      const next = measure();
      commit(next);
      const W = els.app.clientWidth;
      const H = els.app.clientHeight;
      const resized = W !== size.w || H !== size.h;
      size = { w: W, h: H };
      const displayMode = deps.host.state().displayMode;
      const modeChanged = mode !== undefined && displayMode !== mode;
      mode = displayMode;
      const before = judged;
      judged = next.fitInsets;
      if (!before) return; // the first layout: nothing imported to re-fit yet
      const refit = planRefit({ modeChanged, resized, insetsChanged: !sameInsets(before, next.fitInsets) });
      if (refit !== "none") fitWith(next.fitInsets, refit === "force");
    } finally {
      updating = false;
    }
  }
  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(update);
  }

  const resizes = new ResizeObserver(() => schedule());
  resizes.observe(els.app);
  // a name, a toggle, the chip, a font swap: the clusters' own size
  resizes.observe(els.tl);
  resizes.observe(els.tr);
  void document.fonts?.ready.then(schedule);
  deps.host.onChange(schedule);

  // ── the lane: what it holds (--lane-h) — no layout of its own, so no re-measure ──
  /** the lane's entries in the flow — a leaving toast fades out of it */
  const flowing = (): Element[] => [...els.lane.children].filter((c) => !c.classList.contains("leaving"));
  /** the box of those entries; undefined while the lane holds none */
  function laneBox(): Box | undefined {
    const kids = flowing();
    if (kids.length === 0) return undefined;
    const lane = els.lane.getBoundingClientRect();
    const top = Math.min(...kids.map((k) => k.getBoundingClientRect().top));
    return { top, bottom: lane.bottom, left: lane.left, right: lane.right };
  }
  /** brings the WHOLE control into the part of its scroller the user sees
   *  (core/layout.ts visibleView: never under the lane), 8px to spare */
  function reveal(el: HTMLElement, scroller: HTMLElement): void {
    const delta = revealDelta(el.getBoundingClientRect(), visibleView(scroller.getBoundingClientRect(), laneBox()));
    if (delta !== 0) scroller.scrollTop += delta;
  }
  /** the focused control in an open sheet's scroller, while it shows there */
  function focusInSheet(): { el: HTMLElement; scroller: HTMLElement } | undefined {
    const el = document.activeElement;
    if (applied?.panel.mode !== "sheet" || !(el instanceof HTMLElement)) return undefined;
    const scroller = el.closest<HTMLElement>(".panel .panel-scroll");
    if (!scroller || !inView(el.getBoundingClientRect(), scroller.getBoundingClientRect())) return undefined;
    return { el, scroller };
  }
  /** --lane-h from what the lane holds now; an open sheet's scroller keeps
   *  its focused control in view */
  function holdLane(): void {
    const kept = focusInSheet();
    els.app.style.setProperty("--lane-h", `${laneHold(flowing().length, els.lane.offsetHeight)}px`);
    if (kept) reveal(kept.el, kept.scroller);
  }
  // a ResizeObserver runs after layout and before paint: the sheet ends
  // higher and its scroller follows the focus in the same frame
  new ResizeObserver(holdLane).observe(els.lane);
  // a focus inside a panel's scroller shows the whole control: Chrome reveals
  // a textarea's caret line only, and nothing at all while that line shows.
  // The focus events come before the browser's own reveal, which then finds
  // the control in view (scroll-margin 8px, chrome.css) and leaves it there.
  // A focus the pointer gives waits until the press is over: a control moved
  // from under a pressed pointer would lose its click.
  let pressed = false;
  let afterPress: HTMLElement | undefined;
  function revealFocused(el: HTMLElement): void {
    const scroller = el.closest<HTMLElement>(".panel .panel-scroll");
    if (scroller && el === document.activeElement) reveal(el, scroller);
  }
  els.app.addEventListener("focusin", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    if (pressed) afterPress = el;
    else revealFocused(el);
  });
  els.app.addEventListener("pointerdown", () => (pressed = true), true);
  const released = (): void => {
    pressed = false;
    const el = afterPress;
    afterPress = undefined;
    // the click comes right after the release, in the same task
    if (el) requestAnimationFrame(() => revealFocused(el));
  };
  for (const type of ["pointerup", "pointercancel"]) window.addEventListener(type, released, true);
  // a release outside the frame never reaches it: a key means the press is over
  window.addEventListener("keydown", () => void (pressed = false), true);

  // ── Tools (compact): the palette at its slot, until Tools, Escape or a panel ──
  function setTools(open: boolean): void {
    if (open === toolsOpen) return;
    const returnFocus = !open && paletteEl?.contains(document.activeElement);
    toolsOpen = open;
    update();
    if (returnFocus) els.tools.focus();
  }
  els.tools.onclick = (e) => {
    setTools(!toolsOpen);
    // a click hands the focus back to the canvas (chrome/zoom.ts)
    if (e.detail > 0) deps.view()?.focus?.();
  };

  update();
  return {
    lane: () => applied!.lane,
    panel: () => applied!.panel,
    syncLane: holdLane,
    // fresh, not the last applied: an import fit must never read stale insets
    current() {
      bind();
      const next = measure();
      commit(next);
      return next;
    },
    update,
    refit(force) {
      bind();
      const next = measure();
      commit(next);
      fitWith(next.fitInsets, force);
    },
    closeTools() {
      if (!toolsOpen) return false;
      setTools(false);
      return true;
    },
  };
};
