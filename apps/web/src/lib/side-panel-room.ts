/**
 * What an open side panel of the editor (Legend, History, Todos, Notes)
 * covers of the canvas. The panels dock over the canvas's right edge
 * (components/side-panel.tsx) instead of narrowing it, so a Miragon editor's
 * fit keeps clear of them (guide §5.9: every fit counts what is open now).
 */
export interface SidePanelRoom {
  /** px of the canvas's right edge an open panel covers; 0 while none is open */
  covered(): number;
  /** a panel opened or closed; returns the unsubscribe */
  onChange(listener: () => void): () => void;
}

/** `layers` holds the canvas host and the open panel (an `<aside>`) side by side */
export function sidePanelRoom(layers: () => HTMLElement | null, canvas: () => HTMLElement | null): SidePanelRoom {
  return {
    covered() {
      const panel = layers()?.querySelector(":scope > aside");
      const host = canvas();
      if (!panel || !host) return 0;
      const canvasBox = host.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      return Math.round(Math.min(canvasBox.width, Math.max(0, canvasBox.right - panelBox.left)));
    },
    onChange(listener) {
      const node = layers();
      if (!node || typeof MutationObserver !== "function") return () => {};
      // a lazy panel (Legend) joins the layers only once its chunk has loaded
      const observer = new MutationObserver(listener);
      observer.observe(node, { childList: true });
      return () => observer.disconnect();
    },
  };
}
