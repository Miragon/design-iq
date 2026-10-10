/**
 * Remote Monaco carets (#115) — y-monaco already decorates every remote
 * peer's cursor and selection with `.yRemoteSelection-<clientId>` /
 * `.yRemoteSelectionHead-<clientId>` classes, but ships NO styling for them:
 * without this sheet remote carets are invisible. One injected <style>
 * element carries a rule set per peer, colored from the peer's presence and
 * labeled with their name; peers come pre-sanitized (presence-format) because
 * awareness payloads are remote input landing in CSS text.
 */
import type { PresenceUser } from "@designiq/contracts/live";

// relative: test/monaco-theme.test.ts imports this module under node --test
import { safePresenceColor, safePresenceLabel, withAlpha } from "./presence-format.ts";

/** a peer's selection wash — as faint as the theme's own unfocused selection
 *  (8 %): the source keeps its syntax colours ≥ 4.5:1 under a peer's
 *  selection too (lib/monaco-theme); the caret and its label say who it is */
export const REMOTE_SELECTION_ALPHA = 0.08;

export interface RemoteCaretStyles {
  update(peers: ReadonlyArray<{ clientId: number; user: PresenceUser }>): void;
  destroy(): void;
}

// shared shape of every caret head; per-peer rules add only color and label.
// The label is a chip on the CI tokens (Geist, radius sm, white on the peer's
// color — presenceColor keeps that ≥ 4.5:1), flagged off the caret: the corner
// at the caret stays square
const BASE_RULES = `
[class*="yRemoteSelectionHead-"] {
  position: absolute;
  box-sizing: border-box;
  height: 100%;
}
[class*="yRemoteSelectionHead-"]::after {
  position: absolute;
  top: -14px;
  left: -2px;
  padding: 0 5px;
  border-radius: var(--cd-radius-sm) var(--cd-radius-sm) var(--cd-radius-sm) 0;
  font-family: var(--designiq-font-sans);
  font-size: 11px;
  font-weight: 500;
  line-height: 14px;
  white-space: nowrap;
  color: var(--cd-weiss);
  pointer-events: none;
  z-index: 10;
}
`;

export function createRemoteCaretStyles(): RemoteCaretStyles {
  const sheet = document.createElement("style");
  sheet.dataset.designiqRemoteCarets = "";
  document.head.appendChild(sheet);
  let lastCss = "";

  return {
    update(peers) {
      const rules = [BASE_RULES];
      for (const peer of peers) {
        // clientId is numeric by the awareness protocol — coerce defensively,
        // a non-finite value must never break out of the selector
        const id = Number(peer.clientId);
        if (!Number.isFinite(id)) continue;
        const color = safePresenceColor(peer.user.color);
        const label = safePresenceLabel(peer.user.name);
        rules.push(
          `.yRemoteSelection-${id} { background-color: ${withAlpha(color, REMOTE_SELECTION_ALPHA)}; }`,
          `.yRemoteSelectionHead-${id} { border-left: 2px solid ${color}; }`,
          `.yRemoteSelectionHead-${id}::after { content: "${label}"; background: ${color}; }`,
        );
      }
      // reassigning textContent re-parses the whole sheet even for identical
      // text — and update() runs on every awareness tick (cursor moves): only
      // touch the DOM when a caret-relevant value (clientId/color/name) changed
      const css = rules.join("\n");
      if (css === lastCss) return;
      lastCss = css;
      sheet.textContent = css;
    },
    destroy() {
      sheet.remove();
    },
  };
}
