/**
 * The host side of the widget (spec §2.6): the merged host context, the
 * display mode, the one inline height and the teardown flush.
 *
 * The rules live in core/host-context.ts (pure, tested); this module wires
 * them to the App: the connect read, every `hostcontextchanged` (a PARTIAL
 * update — merged key by key), requestDisplayMode (its RESULT is the mode
 * that counts, whether or not the host echoes it as a context change), the
 * frame width that decides the inline height, and `onteardown`.
 *
 * No state change resizes the iframe: cards, toasts and panels float
 * (bridge.ts makeApp: autoResize off) — only declare() sends a height.
 */
import type { App } from "@modelcontextprotocol/ext-apps";

import {
  type HostContextLike,
  initialHostState,
  mergeHostContext,
  planInlineHeight,
  sameHostState,
  type WidthClass,
} from "../core/host-context.ts";
import type { HostState, MountHost } from "./contracts.ts";

/** what the device says before (or without) the host's deviceCapabilities */
function deviceFallback(): { touch: boolean; hover: boolean } {
  const mq = (q: string): boolean => typeof matchMedia === "function" && matchMedia(q).matches;
  return { touch: mq("(pointer: coarse)"), hover: !mq("(hover: none)") };
}

export const mountHost: MountHost = (app: App, deps) => {
  let state: HostState = initialHostState(deviceFallback());
  let ready = false;
  let declared: WidthClass | undefined;
  const listeners = new Set<(next: HostState, prev: HostState) => void>();

  /** the inline height, once — again only on a width-class flip or the
   *  return to inline (core/host-context.ts planInlineHeight) */
  const declare = (): void => {
    if (!ready) return;
    const plan = planInlineHeight(declared, window.innerWidth, state);
    declared = plan.declared;
    if (plan.send !== null) void app.sendSizeChanged({ height: plan.send }).catch(() => {});
  };

  const publish = (next: HostState): void => {
    if (sameHostState(state, next)) return;
    const prev = state;
    state = next;
    for (const cb of listeners) cb(next, prev);
    declare();
  };

  // a partial update: only what it carries changes (the App has merged it
  // into getHostContext() already — that copy may hold a stale displayMode)
  app.addEventListener("hostcontextchanged", (ctx) => publish(mergeHostContext(state, ctx as HostContextLike)));
  app.onteardown = async () => {
    // the host waits for this: flush a pending autosave, never reject
    try {
      await deps.teardown();
    } catch {
      /* the save's own failure surfaces are gone with the iframe */
    }
    return {};
  };
  // the frame width decides the height class — a resize within a class is silent
  window.addEventListener("resize", declare);

  return {
    state: () => state,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    connected() {
      ready = true;
      const caps = app.getHostCapabilities();
      const next = mergeHostContext(state, app.getHostContext() as HostContextLike | undefined);
      next.message = Boolean(caps?.message);
      publish(next);
      declare(); // publish() declares only when something changed
    },
    fullscreenOffered: () => state.availableDisplayModes.includes("fullscreen"),
    async requestDisplayMode(mode) {
      try {
        const { mode: set } = await app.requestDisplayMode({ mode });
        publish(mergeHostContext(state, { displayMode: set }));
      } catch {
        /* refused or unsupported: the mode stays what it is */
      }
      return state.displayMode;
    },
  };
};
