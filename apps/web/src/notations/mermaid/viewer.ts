/**
 * The Mermaid notation's VIEWER (the canvas layer) and the body of its
 * Preview panel: a .mmd file is a document with ONE diagram, drawn exactly
 * as a ```mermaid fence of the Markdown view draws it. Both surfaces build on
 * that fence (../markdown/mermaid-fence.ts), so there is one drawing path in
 * the app: the same renderer and CI theme, the same page-side sanitizer and
 * link policy (a link leaves in a new tab without an opener), the drawing
 * cache, the last good diagram kept, dimmed, under the error notice, and a
 * late result never landing over a newer one.
 *
 * Read-only on purpose: the text is the model, edited in the shell's Text
 * view with the Preview panel beside it. While the shell shows the text
 * instead of the viewer (ctx.visibility), the viewer draws nothing and
 * catches up when it shows again.
 *
 * Node-loadable like the Markdown view (test/mermaid-viewer.test.ts runs it
 * under jsdom with a fake renderer): relative `.ts` imports, every DOM access
 * through the host's own document. The stylesheet comes with the lazy entry,
 * ./mermaid-viewer.ts, and with the Preview panel.
 */
import { createMermaidFence, MERMAID_BLOCK_CLASS, type MermaidFence } from "../markdown/mermaid-fence.ts";
import type { EditorContext, MountedEditor } from "../registry.ts";

/** the shell feeds its panels at this rhythm too (live-editor.tsx) */
export const REDRAW_DEBOUNCE_MS = 300;

/** one diagram, drawn into a host */
export interface MermaidDiagramView {
  /** draw this source; the same source again is a no-op */
  show(source: string): void;
  destroy(): void;
}

/** the Markdown view's scroller and article, holding one mermaid block */
export function mountMermaidDiagram(
  host: HTMLElement,
  opts: {
    /** the region's accessible name */
    label: string;
    /** a draw that failed outside the diagram's own notice (a bug, not a
     *  syntax error: those are the notice) */
    onError?(message: string): void;
    fence?: MermaidFence;
  },
): MermaidDiagramView {
  const doc = host.ownerDocument;
  const fence = opts.fence ?? createMermaidFence();
  const scroller = doc.createElement("div");
  scroller.className = "markdown-view";
  // a scrollable region is reachable by keyboard (arrow keys, Page Down)
  scroller.tabIndex = 0;
  scroller.setAttribute("role", "region");
  scroller.setAttribute("aria-label", opts.label);
  const article = doc.createElement("article");
  article.className = "markdown-body mermaid-body";
  scroller.append(article);
  host.append(scroller);

  let shown: string | undefined;
  let hydration: AbortController | undefined;
  return {
    show(source) {
      if (source === shown) return;
      shown = source;
      hydration?.abort();
      hydration = new AbortController();
      // the fence's placeholder: the source as text, drawn over by hydrate
      const code = doc.createElement("code");
      code.className = "language-mermaid";
      code.textContent = source;
      const block = doc.createElement("pre");
      block.className = `md-code ${MERMAID_BLOCK_CLASS}`;
      block.append(code);
      article.replaceChildren(block);
      // hydrate's synchronous part puts a known drawing back, or keeps the
      // last one, before the browser paints; a syntax error is the block's notice
      const signal = hydration.signal;
      fence.hydrate(article, signal).catch((e: unknown) => {
        if (!signal.aborted)
          opts.onError?.(`The diagram could not be drawn: ${e instanceof Error ? e.message : String(e)}`);
      });
    },
    destroy() {
      hydration?.abort();
      scroller.remove();
    },
  };
}

/** the engine, loaded and initialised: lib/mermaid-render.ts behind import() */
const loadEngine = async (): Promise<void> => {
  await (await import("../../lib/mermaid-render.ts")).loadMermaid();
};

/**
 * The viewer on the canvas layer: the live Y.Text, drawn at once and then
 * again after every pause in its changes, whoever typed them. `deps` is for
 * tests: the engine load and the fence (with its renderer).
 */
export async function mountMermaidViewer(
  container: HTMLElement,
  ctx: EditorContext,
  deps: { ready?: () => Promise<void>; fence?: MermaidFence } = {},
): Promise<MountedEditor> {
  // the engine first: a chunk that does not load rejects here, and the shell
  // falls back to the text view instead of showing a viewer that never draws
  await (deps.ready ?? loadEngine)();
  const diagram = mountMermaidDiagram(container, { label: "Diagram", onError: ctx.onSyncError, fence: deps.fence });

  const hidden = (): boolean => ctx.visibility?.visible() === false;
  let behind = false;
  const update = (): void => {
    if (hidden()) {
      behind = true;
      return;
    }
    behind = false;
    diagram.show(ctx.ytext.toString());
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onChange = (): void => {
    clearTimeout(timer);
    if (hidden()) {
      behind = true;
      return;
    }
    timer = setTimeout(update, REDRAW_DEBOUNCE_MS);
  };
  ctx.ytext.observe(onChange);
  const offVisibility = ctx.visibility?.onChange(() => {
    if (behind && !hidden()) update();
  });
  diagram.show(ctx.ytext.toString());

  return {
    destroy: () => {
      clearTimeout(timer);
      ctx.ytext.unobserve(onChange);
      offVisibility?.();
      diagram.destroy();
    },
  };
}
