/**
 * What an open side panel of the editor (Legend, History, Todos, Notes)
 * covers of the canvas or the source. The panels dock over the editor's right
 * edge (components/side-panel.tsx) instead of narrowing it, so a Miragon
 * editor's fit keeps clear of them (guide §5.9: every fit counts what is open
 * now), and the source's Monaco is laid out beside them.
 */
export interface SidePanelRoom {
  /** px of the pane's right edge an open panel covers; 0 while none is open */
  covered(): number;
  /** a panel opened or closed; returns the unsubscribe */
  onChange(listener: () => void): () => void;
}

/** `layers` holds the pane (the canvas host or the source) and the open panel (an `<aside>`) side by side */
export function sidePanelRoom(layers: () => HTMLElement | null, pane: () => HTMLElement | null): SidePanelRoom {
  return {
    covered() {
      const panel = layers()?.querySelector(":scope > aside");
      const host = pane();
      if (!panel || !host) return 0;
      const paneBox = host.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      return Math.round(Math.min(paneBox.width, Math.max(0, paneBox.right - panelBox.left)));
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

/** the part of Monaco's editor its layout beside the panels drives */
export interface LaidOutEditor {
  layout(dimension: { width: number; height: number }): void;
}

/**
 * The host's laid-out size to a fraction of a pixel, in the CSS pixels Monaco
 * lays out in (getBoundingClientRect scales by a CSS zoom). clientWidth and
 * clientHeight round it to whole pixels, up to half a pixel up.
 */
function laidOutSize(host: HTMLElement): { width: number; height: number } {
  const style = getComputedStyle(host);
  const width = Number.parseFloat(style.width);
  const height = Number.parseFloat(style.height);
  return {
    width: Number.isFinite(width) ? width : host.clientWidth,
    height: Number.isFinite(height) ? height : host.clientHeight,
  };
}

/**
 * Lays Monaco out over its host minus the width an open panel covers, again
 * whenever the host resizes or a panel opens or closes. Monaco's own
 * automaticLayout would size it to the whole host: its scrollbar, its find
 * widget and the ends of its lines would lie under the panel (#288).
 * Like automaticLayout it rounds the host's size down: a Monaco half a pixel
 * past its host gives the page a pixel to scroll by, and with classic
 * scrollbars the page's scrollbar then shows and hides every frame, the
 * toolbar and the canvas shaking with it.
 */
export function layoutBesideSidePanels(editor: LaidOutEditor, host: HTMLElement, room: SidePanelRoom): () => void {
  const layout = (): void => {
    const size = laidOutSize(host);
    editor.layout({ width: Math.max(0, Math.floor(size.width - room.covered())), height: Math.floor(size.height) });
  };
  layout();
  const resizes = typeof ResizeObserver === "function" ? new ResizeObserver(layout) : undefined;
  resizes?.observe(host);
  const offPanels = room.onChange(layout);
  return () => {
    resizes?.disconnect();
    offPanels();
  };
}
