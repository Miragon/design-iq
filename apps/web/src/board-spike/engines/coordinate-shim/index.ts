/**
 * The coordinate shim: while an engine host is armed, the page presents the editor inside it a
 * VIRTUAL coordinate space in which nothing is scaled, which is what a frame gives for free. The
 * host itself stays where it is, scaled by the board's CSS transform (the naive placement).
 *
 * The space (space.ts) is defined by the containing block of the host's `position: fixed`
 * descendants: its true client origin O and the host's net scale s. A true client point p is the
 * virtual point v = (p - O) / s. Then
 *   - a pointer event the editor reads carries v                                    (events.ts)
 *   - a client rectangle of a node inside the host is reported in v                 (patches.ts, rects)
 *   - a point the editor hands the browser is taken for v and converted back        (patches.ts, points)
 *   - the screen matrix of an SVG node inside the host ends in v                    (patches.ts, ctm)
 *   - the window ends, for the editor, where its fixed boxes stop being visible     (patches.ts, viewport)
 *   - a box with `position: fixed; left: v.x; top: v.y` inside the host lands under p, with no
 *     patch at all: that is why the origin is the fixed containing block's.
 *
 * Parts are switched with `&shim=<comma list>`: events, rects, points, ctm, viewport, plus the
 * modifiers `snap` (virtual rectangles on the 1/64 px layout grid), `whole` (mouse events carry
 * whole virtual px), `css` (the strategy's own sheet), `clip` (the editor's window ends where the
 * board clips the node's fixed boxes) and `docrect` (the document element's rectangle is the armed
 * editor's window also for a caller nobody can identify). Absent or `all`: all of these. `none`:
 * nothing. Outside of `all`: `guess` (as `docrect`, for innerWidth, innerHeight and visualViewport)
 * and `keep` (the patches stay installed after disarming).
 * `&shimread=job|tick|arm` chooses how long a reading of O and s is trusted (default `job`).
 *
 * Nothing is patched before a host is first armed, and everything is taken back when the last one
 * is disarmed (unless `keep`): the prototypes carry the functions they carried before.
 */
import { forget, listenHost, listenWindow } from "./events.ts";
import { install, installedPatches, uninstall } from "./patches.ts";
import { createSpace, type SpaceInfo } from "./space.ts";
import { options, resetStats, type ShimOptions, type ShimStats, spaces, stats } from "./state.ts";

export type { ShimOptions, ShimStats, SpaceInfo };
export { type Part, PARTS } from "./state.ts";

/** what `window.__boardSpikeShim` hands a script */
export interface ShimHooks {
  readonly options: ShimOptions;
  /** the patches installed right now, as `Interface.member` */
  installed(): string[];
  /** patches that could not be taken back at the last disarm (someone wrapped them): they stay, inert */
  stuck(): string[];
  /** one entry per armed host: nodeId, O and s, the containing block found */
  spaces(): SpaceInfo[];
  stats(): ShimStats;
  resetStats(): void;
}
export const SHIM_KEY = "__boardSpikeShim";

const unlisten = new Map<HTMLElement, () => void>();
let unlistenWindow: (() => void) | null = null;
let stuck: string[] = [];

/** `host` is armed from now on: its editor lives in the virtual space. Idempotent */
export function armShim(host: HTMLElement, nodeId: string): void {
  if (spaces.some((space) => space.host === host)) return;
  spaces.push(createSpace(host, nodeId, options.read));
  install();
  if (options.parts.events) {
    unlistenWindow ??= listenWindow();
    unlisten.set(host, listenHost(host));
  }
}

/** `host` is a preview again: true behaviour, completely, once the last armed host is gone */
export function disarmShim(host: HTMLElement): void {
  const index = spaces.findIndex((space) => space.host === host);
  if (index < 0) return;
  const [space] = spaces.splice(index, 1);
  forget(space!);
  space!.destroy();
  unlisten.get(host)?.();
  unlisten.delete(host);
  if (spaces.length > 0) return;
  unlistenWindow?.();
  unlistenWindow = null;
  if (!options.keep) stuck = uninstall();
}

/** what `&shim=` asked for: the surface reads `css` from it */
export const shimOptions: ShimOptions = options;

/** `tick` read mode: the board's viewport changed */
export function invalidateShim(): void {
  for (const space of spaces) space.invalidate();
}

const hooks: ShimHooks = {
  options,
  installed: installedPatches,
  stuck: () => [...stuck],
  spaces: () => spaces.map((space) => space.info()),
  // a copy: the counters go on counting
  stats: () => JSON.parse(JSON.stringify(stats)) as ShimStats,
  resetStats,
};
Object.assign(window, { [SHIM_KEY]: hooks });
